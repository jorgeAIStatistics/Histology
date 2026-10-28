"""Supervised heads over bags of patch embeddings, and their checkpoints.

* ``meanpool_logreg``: mean-pooled bag embedding (streamed, float64) → standardisation fitted
  on the training bags → scikit-learn ``LogisticRegression`` (lbfgs, seeded). The baseline a
  more complex head must beat.
* ``abmil``: gated attention-based multiple-instance learning (Ilse et al., 2018) in
  PyTorch on CPU, seeded, deterministic algorithms, one thread during training. Two phases
  (:data:`ABMIL_FIT_SEMANTICS`): the epoch count is selected by early stopping on an INNER
  patient-grouped stratified hold-out of the fitting bags
  (:func:`dermpath.ml.cv.inner_holdout_split`, ``inner_val_fraction``), then a freshly
  initialised model is fitted on EVERY fitting bag for exactly that many epochs; validation,
  outer held-out folds and test are never seen by the fitter. Large bags can be subsampled
  per epoch (``max_instances_per_bag``, seeded, recorded).

Both heads honour ``class_weight`` (``balanced`` | ``none``); class weights, the scaler and
the input normalisation are computed on the bags the head is fitted on, never on validation
or test data. Embeddings are read through an :class:`EmbeddingAccess` (lazily, from a
feature set's memory-mapped artifacts in training), never all at once.

Checkpoints are deterministic ``.npz`` files (see :mod:`dermpath.ml.artifacts`): the same
data, parameters and seed give byte-identical checkpoints. Scores at train time and at test
time come from the same :class:`LoadedModel` code path built from the checkpoint arrays.
"""

from __future__ import annotations

import copy
import warnings
from collections.abc import Callable, Sequence
from contextlib import contextmanager
from dataclasses import dataclass, field

import numpy as np

from .artifacts import load_npz, npz_bytes
from .devices import TORCH_STATE_LOCK

CHECKPOINT_SCHEMA = "dermpath.checkpoint/2"
LEGACY_CHECKPOINT_SCHEMAS = ("dermpath.checkpoint/1",)
LR_MAX_ITER = 5000
#: Rows summed per step when a bag mean is streamed; fixed so every path gives the same bits.
MEAN_CHUNK_ROWS = 4096
SUBSAMPLING_RULE = ("per epoch, a bag with more than max_instances_per_bag instances is replaced by a uniform "
                    "subset of that size drawn without replacement with numpy default_rng((seed, epoch, bag "
                    "position in the content-stable order)); scoring always uses every instance")
# Shared with devices.inference_context: both mutate process-global torch state (thread
# count, deterministic algorithms), so they must serialise on one lock or they can
# interleave and restore each other's values.
_TORCH_LOCK = TORCH_STATE_LOCK


@dataclass
class Bag:
    bag_id: str
    kind: str  # slide | case
    slide_ids: list[str]
    case_id: str | None
    patient_id: str
    patient_code: str | None
    label_value: str
    label: int
    label_version_ids: list[str]
    attributes: dict
    artifact_ids: list[str] = field(default_factory=list)
    embeddings: np.ndarray | None = None  # (N, D) float32, only when attached in memory
    coords: np.ndarray | None = None  # (N, 2) level-0
    slide_index: np.ndarray | None = None  # (N,) index into slide_ids
    extents: list[list[int]] = field(default_factory=list)  # per slide [w, h] level-0
    # Content-stable identity (never uuids): ordering key and per-slide content hashes.
    accession_code: str | None = None
    slide_sha256s: list[str] = field(default_factory=list)
    split: str | None = None  # manifest split of the bag (train | val | test)
    patch_counts: list[int] | None = None  # per slide, once features are known

    @property
    def n_patches(self) -> int:
        if self.patch_counts is not None:
            return int(sum(self.patch_counts))
        return 0 if self.embeddings is None else int(self.embeddings.shape[0])

    @property
    def sort_key(self) -> tuple:
        """Content-stable order: patient code, accession code, slide content hashes (ids last,
        only to break exact duplicates)."""
        return (self.patient_code or "", self.accession_code or "", tuple(self.slide_sha256s), self.bag_id)

    @property
    def patient_key(self) -> str:
        return self.patient_code or self.patient_id


# --------------------------------------------------------------------------- embedding access


def streaming_mean(parts: Sequence[np.ndarray]) -> np.ndarray:
    """Mean over the rows of every part, summed in float64 in fixed chunks (bounded memory;
    identical bits whether the parts are memory-mapped or in RAM)."""
    total, n, dim = None, 0, None
    for arr in parts:
        if arr.ndim != 2:
            raise ValueError("embeddings must be 2-D (N, D)")
        dim = arr.shape[1] if dim is None else dim
        if total is None:
            total = np.zeros(arr.shape[1], dtype=np.float64)
        for start in range(0, arr.shape[0], MEAN_CHUNK_ROWS):
            total += np.asarray(arr[start:start + MEAN_CHUNK_ROWS], dtype=np.float64).sum(axis=0)
        n += int(arr.shape[0])
    if total is None or n == 0:
        raise ValueError("cannot pool an empty bag")
    return total / n


class EmbeddingAccess:
    """How heads read a bag's embeddings. The default reads ``bag.embeddings`` (in memory);
    training uses a feature-set backed subclass that loads lazily."""

    def parts(self, bag: Bag) -> list[np.ndarray]:
        """Per-slide arrays (a case bag with ``slide_index`` is split by slide, so pooling gives the
        same bits as reading the slides one by one)."""
        if bag.embeddings is None:
            return []
        idx = bag.slide_index
        if len(bag.slide_ids) > 1 and idx is not None and len(idx) == bag.embeddings.shape[0]:
            return [bag.embeddings[idx == j] for j in range(len(bag.slide_ids)) if bool((idx == j).any())]
        return [bag.embeddings]

    def embeddings(self, bag: Bag) -> np.ndarray:
        parts = self.parts(bag)
        if not parts:
            raise ValueError(f"bag {bag.bag_id} has no embeddings")
        arr = parts[0] if len(parts) == 1 else np.concatenate([np.asarray(p) for p in parts])
        return np.asarray(arr, dtype=np.float32)

    def mean(self, bag: Bag) -> np.ndarray:
        return streaming_mean(self.parts(bag))


IN_MEMORY = EmbeddingAccess()


class _Moments:
    """Chan et al. parallel mean/variance over chunks (float64), for input normalisation."""

    def __init__(self) -> None:
        self.n, self.mean, self.m2 = 0, None, None

    def add(self, x: np.ndarray) -> None:
        x = np.asarray(x, dtype=np.float64)
        if x.shape[0] == 0:
            return
        nb, mb = x.shape[0], x.mean(axis=0)
        m2b = ((x - mb) ** 2).sum(axis=0)
        if self.n == 0:
            self.n, self.mean, self.m2 = nb, mb, m2b
            return
        n = self.n + nb
        delta = mb - self.mean
        self.mean = self.mean + delta * nb / n
        self.m2 = self.m2 + m2b + delta ** 2 * self.n * nb / n
        self.n = n

    def std(self) -> np.ndarray:
        return np.sqrt(self.m2 / self.n)


def input_moments(bags: Sequence[Bag], access: EmbeddingAccess) -> tuple[np.ndarray, np.ndarray, int]:
    """Per-dimension mean and std over every instance of ``bags`` (streamed)."""
    mom = _Moments()
    for b in bags:
        for part in access.parts(b):
            for start in range(0, part.shape[0], MEAN_CHUNK_ROWS):
                mom.add(part[start:start + MEAN_CHUNK_ROWS])
    if mom.n == 0:
        raise ValueError("no training instances")
    std = mom.std()
    std = np.where(std > 1e-6, std, 1.0)
    return mom.mean.astype(np.float32), std.astype(np.float32), int(mom.n)


# --------------------------------------------------------------------------- class weights


def class_weights(labels: Sequence[int], class_weight: str) -> dict:
    """Weights applied to the loss of each class, from the FITTING bags only.

    ``balanced``: ``w_c = n / (2 n_c)`` (scikit-learn's convention), so both classes carry
    equal total weight; ``none``: 1 each. Returns the counts, the weights and the effective
    positive fraction ``w1 n1 / (w1 n1 + w0 n0)``."""
    y = np.asarray(list(labels), dtype=np.int64)
    n1 = int(y.sum())
    n0 = int(y.size - n1)
    if class_weight not in ("balanced", "none"):
        raise ValueError("class_weight must be 'balanced' or 'none'")
    if class_weight == "balanced" and n0 and n1:
        w1, w0 = y.size / (2.0 * n1), y.size / (2.0 * n0)
    else:
        w1 = w0 = 1.0
    total = w1 * n1 + w0 * n0
    return {"class_weight": class_weight, "counts": {"positive": n1, "negative": n0},
            "weights": {"positive": float(w1), "negative": float(w0)},
            "raw_positive_fraction": n1 / y.size if y.size else None,
            "effective_positive_fraction": (w1 * n1 / total) if total else None}


@contextmanager
def torch_single_thread():
    """One intra-op thread and deterministic algorithms, so float reductions are reproducible."""
    import torch

    with _TORCH_LOCK:
        prev_threads = torch.get_num_threads()
        prev_det = torch.are_deterministic_algorithms_enabled()
        torch.set_num_threads(1)
        torch.use_deterministic_algorithms(True)
        try:
            yield torch
        finally:
            torch.use_deterministic_algorithms(prev_det)
            torch.set_num_threads(prev_threads)


@contextmanager
def deterministic_torch(seed: int):
    with torch_single_thread() as torch:
        torch.manual_seed(seed)
        yield torch


def _sigmoid(z: np.ndarray) -> np.ndarray:
    return 1.0 / (1.0 + np.exp(-z))


# --------------------------------------------------------------------------- ABMIL module


def build_abmil(in_dim: int, hidden_dim: int, attn_dim: int, dropout: float):
    import torch
    from torch import nn

    class GatedABMIL(nn.Module):
        def __init__(self) -> None:
            super().__init__()
            self.embed = nn.Sequential(nn.Linear(in_dim, hidden_dim), nn.ReLU(), nn.Dropout(dropout))
            self.attn_v = nn.Linear(hidden_dim, attn_dim)
            self.attn_u = nn.Linear(hidden_dim, attn_dim)
            self.attn_w = nn.Linear(attn_dim, 1)
            self.classifier = nn.Linear(hidden_dim, 1)

        def forward(self, x):  # x: (N, D) one bag
            h = self.embed(x)
            a = self.attn_w(torch.tanh(self.attn_v(h)) * torch.sigmoid(self.attn_u(h))).squeeze(-1)
            a = torch.softmax(a, dim=0)
            z = (a.unsqueeze(-1) * h).sum(dim=0)
            return self.classifier(z).squeeze(-1), a

    return GatedABMIL()


# --------------------------------------------------------------------------- loaded model


class LoadedModel:
    def __init__(self, arrays: dict[str, np.ndarray], meta: dict) -> None:
        self.arrays = arrays
        self.meta = meta
        self.head = meta["head"]
        self._torch_model = None
        if self.head == "abmil":
            import torch

            m = build_abmil(meta["in_dim"], meta["hidden_dim"], meta["attn_dim"], meta["dropout"])
            state = {k[len("state."):]: torch.from_numpy(np.array(v)) for k, v in arrays.items()
                     if k.startswith("state.")}
            m.load_state_dict(state, strict=True)
            m.eval()
            self._torch_model = m

    def score_parts(self, parts: Sequence[np.ndarray]) -> tuple[float, np.ndarray | None]:
        """Score one bag given its per-slide embedding arrays; ``(score, attention or None)``."""
        if self.head == "meanpool_logreg":
            return self.score_mean(streaming_mean(parts)), None
        emb = parts[0] if len(parts) == 1 else np.concatenate([np.asarray(p) for p in parts])
        # ABMIL needs the whole bag (attention spans every patch), but normalise it with ONE bag-sized float32
        # temporary, in place, instead of two ((x - mean) / std); the values are identical.
        x = np.subtract(np.asarray(emb, dtype=np.float32), self.arrays["input_mean"], dtype=np.float32)
        np.divide(x, self.arrays["input_std"], out=x)
        with torch_single_thread() as torch, torch.no_grad():
            logit, att = self._torch_model(torch.from_numpy(np.ascontiguousarray(x, dtype=np.float32)))
            return float(torch.sigmoid(logit).item()), att.numpy().astype(np.float64)

    def score_mean(self, x: np.ndarray) -> float:
        """meanpool_logreg on an already pooled (float64) bag embedding."""
        z = ((np.asarray(x, dtype=np.float64) - self.arrays["scaler_mean"]) / self.arrays["scaler_scale"]) \
            @ self.arrays["coef"] + float(self.arrays["intercept"][0])
        return float(_sigmoid(np.asarray(z)))

    def score(self, emb: np.ndarray) -> tuple[float, np.ndarray | None]:
        """Score one bag from a single (N, D) array; ``(score, attention or None)``."""
        return self.score_parts([emb])

    def score_bag(self, bag: Bag, access: EmbeddingAccess = IN_MEMORY) -> tuple[float, np.ndarray | None]:
        if self.head == "meanpool_logreg":
            return self.score_mean(access.mean(bag)), None
        return self.score_parts(access.parts(bag))


def checkpoint_bytes(arrays: dict[str, np.ndarray], meta: dict) -> bytes:
    return npz_bytes(arrays, {**meta, "schema": CHECKPOINT_SCHEMA})


def load_checkpoint(data: bytes) -> LoadedModel:
    arrays, meta = load_npz(data)
    if not meta or meta.get("schema") not in (CHECKPOINT_SCHEMA,) + LEGACY_CHECKPOINT_SCHEMAS:
        raise ValueError("not a dermpath checkpoint")
    return LoadedModel(arrays, meta)


# --------------------------------------------------------------------------- training


ProgressFn = Callable[[float, str], None]


def _no_progress(frac: float, message: str) -> None:
    return None


def fit_meanpool_logreg(train: list[Bag], params: dict, seed: int, progress: ProgressFn = _no_progress, *,
                        access: EmbeddingAccess = IN_MEMORY, **_context) -> tuple[dict[str, np.ndarray], dict, dict]:
    """Mean-pooled logistic regression. Bag means are streamed; the scaler and the class
    weights come from ``train`` only. There is no early stopping (convex fit)."""
    from sklearn.linear_model import LogisticRegression
    from sklearn.preprocessing import StandardScaler

    X = np.stack([access.mean(b) for b in train])
    y = np.array([b.label for b in train], dtype=np.int64)
    cw = class_weights(y.tolist(), params["class_weight"])
    progress(0.1, "meanpool_logreg: fitting logistic regression")
    scaler = StandardScaler().fit(X)
    clf = LogisticRegression(C=params["C"], max_iter=LR_MAX_ITER, solver="lbfgs", random_state=seed,
                             class_weight=None if params["class_weight"] == "none" else "balanced")
    clf.fit(scaler.transform(X), y)
    scale = np.where(scaler.scale_ > 0, scaler.scale_, 1.0)
    arrays = {"scaler_mean": scaler.mean_.astype(np.float64), "scaler_scale": scale.astype(np.float64),
              "coef": clf.coef_[0].astype(np.float64), "intercept": clf.intercept_.astype(np.float64)}
    meta = {"head": "meanpool_logreg", "in_dim": int(X.shape[1]), "C": params["C"],
            "class_weight": params["class_weight"], "solver": "lbfgs", "max_iter": LR_MAX_ITER, "tol": 1e-4}
    n_iter = int(np.max(clf.n_iter_))
    summary = {"head": "meanpool_logreg", "n_iter": n_iter, "converged": bool(n_iter < clf.max_iter),
               "train_bags": len(train), "class_weights": cw, "pooling": "streamed float64 mean over every instance",
               "early_stopping": "not applicable (convex fit)",
               "optimisation_budget": {"solver": "lbfgs", "max_iter": LR_MAX_ITER, "tol": 1e-4, "C": params["C"],
                                       "hyperparameter_search": "none (prespecified)"}}
    if not summary["converged"]:
        summary["warning"] = f"lbfgs did not converge in {LR_MAX_ITER} iterations"
    progress(1.0, "meanpool_logreg: fitted")
    return arrays, meta, summary


def _subsample(n: int, k: int | None, seed: int, epoch: int, position: int) -> np.ndarray | None:
    if k is None or n <= k:
        return None
    rng = np.random.default_rng((int(seed), int(epoch), int(position)))
    return np.sort(rng.choice(n, size=int(k), replace=False))


def inner_split(train: list[Bag], params: dict, *, split_salt: str, seed: int = 0,
                patient_label_rule: str = "any_positive", duplicate_pairs=()) -> tuple[list[Bag], list[Bag], dict]:
    """Patient-grouped stratified inner hold-out of the TRAINING bags for early stopping,
    seeded by the training seed (content-hash order of patient codes; never database ids)."""
    from .cv import inner_holdout_split

    keys = {}
    for b in train:
        keys.setdefault(b.patient_id, b.patient_key)
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        res = inner_holdout_split([b.label for b in train], [b.patient_id for b in train],
                                  fraction=params["inner_val_fraction"], patient_keys=keys,
                                  salt=f"{split_salt}|inner|{int(seed)}", duplicate_pairs=duplicate_pairs,
                                  patient_label_rule=patient_label_rule)
    held = set(res["holdout_patients"])
    fit = [b for b in train if b.patient_id not in held]
    stop = [b for b in train if b.patient_id in held]
    diag = res["diagnostics"]
    info = {"method": diag["method"], "fraction": diag["fraction"], "salt": diag["salt"],
            "fit_bags": len(fit), "holdout_bags": len(stop),
            "fit_patients": len({b.patient_id for b in fit}), "holdout_patients": len(held),
            "held_out": diag["held_out"], "fit": diag["fit"],
            "warnings": list(diag.get("warnings", [])) + [str(w.message) for w in caught
                                                          if str(w.message) not in diag.get("warnings", [])],
            "holdout_bag_ids": sorted(b.bag_id for b in stop)}
    return fit, stop, info


#: What an ABMIL fit means (recorded in every ABMIL checkpoint's meta and summary).
ABMIL_FIT_SEMANTICS = ("epoch count selected by early stopping on an inner patient-grouped stratified hold-out of the "
                       "permitted fitting patients (never validation, an outer held-out fold or test); the model is "
                       "then reinitialised with the same seed and fitted on EVERY permitted fitting bag for exactly "
                       "that many epochs, with no early stopping; input normalisation and class weights come from "
                       "every fitting bag")


def _phase_counts(bags: Sequence[Bag]) -> dict:
    """Bags and distinct patients (per class) used by one fitting phase."""
    pos = {b.patient_id for b in bags if b.label == 1}
    neg = {b.patient_id for b in bags if b.label == 0}
    n1 = sum(1 for b in bags if b.label == 1)
    return {"bags": len(bags), "patients": len({b.patient_id for b in bags}),
            "bags_by_class": {"positive": n1, "negative": len(bags) - n1},
            "patients_by_class": {"positive": len(pos), "negative": len(neg)}}


def _sub_progress(progress: ProgressFn, start: float, stop: float) -> ProgressFn:
    return lambda frac, message: progress(start + (stop - start) * max(0.0, min(1.0, frac)), message)


def _abmil_epochs(fit_bags: list[Bag], stop_bags: list[Bag], params: dict, seed: int, *, epochs: int,
                  access: EmbeddingAccess, early_stopping: bool, progress: ProgressFn, phase: str) -> dict:
    """One freshly initialised ABMIL (``torch.manual_seed(seed)``) trained on ``fit_bags`` for at most ``epochs``
    epochs. Normalisation and class weights come from ``fit_bags``. With ``early_stopping`` the weighted BCE on
    ``stop_bags`` is monitored every epoch (``patience``) and the best epoch is reported; the returned state is the
    best-epoch state then, else the state after the last epoch."""
    mean, std, n_inst = input_moments(fit_bags, access)
    cw = class_weights([b.label for b in fit_bags], params["class_weight"])
    k = params.get("max_instances_per_bag")
    use_stop = bool(early_stopping and stop_bags)
    with deterministic_torch(seed) as torch:
        def tensor(b: Bag, idx: np.ndarray | None = None):
            e = access.embeddings(b)
            if idx is not None:
                e = e[idx]
            return torch.from_numpy(np.ascontiguousarray((e - mean) / std, dtype=np.float32))

        y_fit = [float(b.label) for b in fit_bags]
        y_stop = [float(b.label) for b in stop_bags]
        model = build_abmil(int(mean.shape[0]), params["hidden_dim"], params["attn_dim"], params["dropout"])
        opt = torch.optim.Adam(model.parameters(), lr=params["lr"], weight_decay=params["weight_decay"])
        w = cw["weights"]
        pos_weight = torch.tensor([w["positive"] / w["negative"]], dtype=torch.float32)

        def weighted_loss(logit, y: float):
            # BCE with the class weights of the fitting bags (same criterion for early stopping).
            return torch.nn.functional.binary_cross_entropy_with_logits(
                logit.view(1), torch.tensor([y], dtype=torch.float32), pos_weight=pos_weight) * w["negative"]

        rng = np.random.default_rng(seed)
        best_state, best_loss, best_epoch, bad = None, float("inf"), None, 0
        history, subsampled, epochs_run = [], 0, 0
        for epoch in range(int(epochs)):
            model.train()
            total = 0.0
            for pos in rng.permutation(len(fit_bags)).tolist():
                b = fit_bags[pos]
                idx = _subsample(b.n_patches or access.embeddings(b).shape[0], k, seed, epoch, pos)
                subsampled += idx is not None
                opt.zero_grad()
                logit, _ = model(tensor(b, idx))
                loss = weighted_loss(logit, y_fit[pos])
                loss.backward()
                opt.step()
                total += float(loss.item())
            epochs_run = epoch + 1
            train_loss = total / len(fit_bags)
            stop_loss = None
            if use_stop:
                model.eval()
                with torch.no_grad():  # bags read lazily: bounded memory
                    stop_loss = float(np.mean([float(weighted_loss(model(tensor(b))[0], y_stop[j]).item())
                                               for j, b in enumerate(stop_bags)]))
                if not np.isfinite(stop_loss):
                    raise FloatingPointError("abmil: non-finite early-stopping loss")
                if stop_loss < best_loss - 1e-6:
                    best_loss, best_epoch, bad = stop_loss, epoch + 1, 0
                    best_state = copy.deepcopy(model.state_dict())
                else:
                    bad += 1
            if not np.isfinite(train_loss):
                raise FloatingPointError("abmil: non-finite training loss")
            row = {"epoch": epoch + 1, "train_loss": round(train_loss, 6)}
            if early_stopping:
                row["inner_holdout_loss"] = None if stop_loss is None else round(stop_loss, 6)
            history.append(row)
            progress((epoch + 1) / max(int(epochs), 1),
                     f"abmil {phase} epoch {epoch + 1}/{int(epochs)}: train loss {train_loss:.4f}"
                     + (f", inner hold-out loss {stop_loss:.4f}" if stop_loss is not None else ""))
            if use_stop and bad >= params["patience"]:
                break
        if best_state is not None:
            model.load_state_dict(best_state)
        model.eval()
        arrays = {f"state.{k_}": v.detach().cpu().numpy().astype(np.float32) for k_, v in model.state_dict().items()}
    arrays["input_mean"] = mean.astype(np.float32)
    arrays["input_std"] = std.astype(np.float32)
    return {"arrays": arrays, "in_dim": int(mean.shape[0]), "history": history, "epochs_run": epochs_run,
            "best_epoch": best_epoch, "best_loss": None if best_epoch is None else round(best_loss, 6),
            "subsampled": int(subsampled), "class_weights": cw, "input_instances": int(n_inst)}


def select_abmil_epochs(fit_bags: list[Bag], stop_bags: list[Bag], params: dict, seed: int,
                        progress: ProgressFn = _no_progress, *, access: EmbeddingAccess = IN_MEMORY) -> dict:
    """Phase 1: choose the epoch count. Train on the inner fit part, early-stop on the inner hold-out (both drawn
    from the permitted fitting patients only); the model itself is discarded. Returns ``best_epoch`` (and the
    history, losses and counts)."""
    res = _abmil_epochs(fit_bags, stop_bags, params, seed, epochs=int(params["max_epochs"]), access=access,
                        early_stopping=True, progress=progress, phase="epoch selection")
    return {k: res[k] for k in ("best_epoch", "best_loss", "epochs_run", "history", "subsampled", "class_weights",
                                "input_instances")}


def fit_abmil_fixed_epochs(bags: list[Bag], params: dict, seed: int, progress: ProgressFn = _no_progress, *,
                           epochs: int, access: EmbeddingAccess = IN_MEMORY, **_context
                           ) -> tuple[dict[str, np.ndarray], dict, dict]:
    """Phase 2: a freshly initialised ABMIL fitted on EVERY bag in ``bags`` for exactly ``epochs`` epochs (no early
    stopping). Normalisation and class weights come from ``bags``."""
    if int(epochs) < 1:
        raise ValueError("abmil: the fixed epoch count must be at least 1")
    res = _abmil_epochs(list(bags), [], params, seed, epochs=int(epochs), access=access, early_stopping=False,
                        progress=progress, phase="final fit")
    k = params.get("max_instances_per_bag")
    meta = {"head": "abmil", "in_dim": res["in_dim"], "hidden_dim": params["hidden_dim"],
            "attn_dim": params["attn_dim"], "dropout": params["dropout"], "architecture": "gated attention MIL",
            "class_weight": params["class_weight"], "max_instances_per_bag": k, "fit_semantics": ABMIL_FIT_SEMANTICS,
            "final_fit_epochs": int(epochs)}
    final = {**_phase_counts(bags), "epochs": int(epochs), "early_stopping": "none (fixed epoch count)",
             "input_normalisation_instances": res["input_instances"], "history": res["history"],
             "bag_epochs_subsampled": res["subsampled"]}
    summary = {"head": "abmil", "fit_semantics": ABMIL_FIT_SEMANTICS, "final_fit": final,
               "class_weights": res["class_weights"], "train_bags": len(bags), "fit_bags": len(bags)}
    return res["arrays"], meta, summary


def fit_abmil(train: list[Bag], params: dict, seed: int, progress: ProgressFn = _no_progress, *,
              access: EmbeddingAccess = IN_MEMORY, split_salt: str = "", patient_label_rule: str = "any_positive",
              duplicate_pairs=(), **_context) -> tuple[dict[str, np.ndarray], dict, dict]:
    """Gated ABMIL (:data:`ABMIL_FIT_SEMANTICS`): the epoch count is selected on an INNER patient-grouped stratified
    hold-out of ``train`` (never validation, never an outer held-out fold), then a fresh model is fitted on every
    bag of ``train`` for that many epochs. Without a usable inner hold-out (each class has a single grouping unit)
    no epoch selection is possible: the fresh model is fitted on every bag for ``max_epochs`` (recorded)."""
    fit_bags, stop_bags, inner = inner_split(train, params, split_salt=split_salt, seed=seed,
                                             patient_label_rule=patient_label_rule, duplicate_pairs=duplicate_pairs)
    selection: dict = {"method": "inner patient-grouped stratified hold-out of the permitted fitting patients",
                       "inner_val_fraction": params["inner_val_fraction"], "max_epochs": params["max_epochs"],
                       "patience": params["patience"]}
    if {b.label for b in fit_bags} != {0, 1} or not stop_bags:
        reason = ("no inner hold-out: " + ("the inner fit part lacks a class" if {b.label for b in fit_bags} != {0, 1}
                                           else "every class has a single grouping unit")
                  + "; no epoch count could be selected, so every fitting bag is fitted for max_epochs")
        inner["warnings"].append(reason)
        selection.update({"status": "not_possible", "reason": reason, "fit": None, "holdout": None,
                          "holdout_patient_keys": [], "best_epoch": None, "epochs_run": None,
                          "best_inner_holdout_loss": None})
        final_epochs, sel = int(params["max_epochs"]), None
        fixed_progress = progress
    else:
        sel = select_abmil_epochs(fit_bags, stop_bags, params, seed, _sub_progress(progress, 0.0, 0.6),
                                  access=access)
        if sel["best_epoch"] is None:  # pragma: no cover - the first finite inner loss always improves on inf
            raise FloatingPointError("abmil: no epoch improved the inner hold-out loss")
        final_epochs = int(sel["best_epoch"])
        selection.update({"status": "selected", "reason": None, "fit": _phase_counts(fit_bags),
                          "holdout": _phase_counts(stop_bags),
                          "holdout_patient_keys": sorted({b.patient_key for b in stop_bags}),
                          "best_epoch": final_epochs, "epochs_run": sel["epochs_run"],
                          "best_inner_holdout_loss": sel["best_loss"], "class_weights": sel["class_weights"],
                          "input_normalisation_instances": sel["input_instances"],
                          "bag_epochs_subsampled": sel["subsampled"]})
        fixed_progress = _sub_progress(progress, 0.6, 1.0)
    arrays, meta, fixed = fit_abmil_fixed_epochs(train, params, seed, fixed_progress, epochs=final_epochs,
                                                 access=access)
    final = fixed["final_fit"]
    if sel is None:
        final["early_stopping"] = "none (no inner hold-out was possible: max_epochs, recorded)"
    else:
        final["early_stopping"] = "none (fixed epoch count selected on the inner hold-out)"
    k = params.get("max_instances_per_bag")
    summary = {"head": "abmil", "fit_semantics": ABMIL_FIT_SEMANTICS,
               "epochs_run": selection["epochs_run"], "max_epochs": params["max_epochs"],
               "best_epoch": selection["best_epoch"], "best_inner_holdout_loss": selection["best_inner_holdout_loss"],
               "patience": params["patience"], "class_weights": fixed["class_weights"],
               "early_stopping": ("epoch count selected on an inner patient-grouped stratified hold-out of the "
                                  "training bags (weighted BCE; validation never seen); the final model was "
                                  "reinitialised and fitted on every training bag for that many epochs"
                                  if sel is not None else
                                  "not applied: no inner hold-out (every training bag fitted for max_epochs; "
                                  "validation never seen)"),
               "epoch_selection": selection, "final_fit": final, "final_fit_epochs": final_epochs,
               "inner_holdout": inner, "history": sel["history"] if sel else [], "train_bags": len(train),
               "fit_bags": len(train),
               "input_normalisation": {"fitted_on": "every training bag of this fit (final refit)",
                                       "instances": final["input_normalisation_instances"]},
               "instance_subsampling": {"max_instances_per_bag": k,
                                        "bag_epochs_subsampled": int(final["bag_epochs_subsampled"]
                                                                     + (sel["subsampled"] if sel else 0)),
                                        "rule": SUBSAMPLING_RULE},
               "optimisation_budget": {"optimizer": "Adam", "lr": params["lr"], "weight_decay": params["weight_decay"],
                                       "max_epochs": params["max_epochs"], "patience": params["patience"],
                                       "batch": "one bag per step", "hyperparameter_search": "none (prespecified)",
                                       "refit": "a second, fixed-length fit on every fitting bag (at most "
                                                "max_epochs more epochs)"}}
    return arrays, meta, summary


HEAD_FITTERS = {"meanpool_logreg": fit_meanpool_logreg, "abmil": fit_abmil}
OPTIMISATION_BUDGETS = {
    "meanpool_logreg": "lbfgs to convergence (max_iter 5000, tol 1e-4) at a prespecified C; no hyperparameter search",
    "abmil": ("Adam, one bag per step: the epoch count is selected (at most max_epochs, early stopping with patience) "
              "on an inner hold-out of the training patients, then a fresh model is fitted on every training patient "
              "for that count; prespecified hyperparameters; no hyperparameter search"),
}
