"""Supervised heads over bags of patch embeddings, and their checkpoints.

* ``meanpool_logreg``: mean-pooled bag embedding → standardisation → scikit-learn
  ``LogisticRegression`` (lbfgs, seeded). The baseline a more complex head must beat.
* ``abmil``: gated attention-based multiple-instance learning (Ilse et al., 2018) in
  PyTorch on CPU, seeded, deterministic algorithms, one thread during training, early
  stopping on validation loss (best epoch restored).

Checkpoints are deterministic ``.npz`` files (see :mod:`dermpath.ml.artifacts`): the same
data, parameters and seed give byte-identical checkpoints. Scores at train time and at test
time come from the same :class:`LoadedModel` code path built from the checkpoint arrays.
"""

from __future__ import annotations

import copy
import threading
from collections.abc import Callable
from contextlib import contextmanager
from dataclasses import dataclass, field

import numpy as np

from .artifacts import load_npz, npz_bytes

CHECKPOINT_SCHEMA = "dermpath.checkpoint/1"
_TORCH_LOCK = threading.RLock()


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
    embeddings: np.ndarray | None = None  # (N, D) float32
    coords: np.ndarray | None = None  # (N, 2) level-0
    slide_index: np.ndarray | None = None  # (N,) index into slide_ids
    extents: list[list[int]] = field(default_factory=list)  # per slide [w, h] level-0

    @property
    def n_patches(self) -> int:
        return 0 if self.embeddings is None else int(self.embeddings.shape[0])


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

    def score(self, emb: np.ndarray) -> tuple[float, np.ndarray | None]:
        """Score one bag; returns ``(score, attention or None)``."""
        if self.head == "meanpool_logreg":
            x = emb.astype(np.float64).mean(axis=0)
            z = ((x - self.arrays["scaler_mean"]) / self.arrays["scaler_scale"]) @ self.arrays["coef"] \
                + float(self.arrays["intercept"][0])
            return float(_sigmoid(np.asarray(z))), None
        x = (emb.astype(np.float32) - self.arrays["input_mean"]) / self.arrays["input_std"]
        with torch_single_thread() as torch, torch.no_grad():
            logit, att = self._torch_model(torch.from_numpy(np.ascontiguousarray(x, dtype=np.float32)))
            return float(torch.sigmoid(logit).item()), att.numpy().astype(np.float64)


def checkpoint_bytes(arrays: dict[str, np.ndarray], meta: dict) -> bytes:
    return npz_bytes(arrays, {**meta, "schema": CHECKPOINT_SCHEMA})


def load_checkpoint(data: bytes) -> LoadedModel:
    arrays, meta = load_npz(data)
    if not meta or meta.get("schema") != CHECKPOINT_SCHEMA:
        raise ValueError("not a dermpath checkpoint")
    return LoadedModel(arrays, meta)


# --------------------------------------------------------------------------- training


ProgressFn = Callable[[float, str], None]


def fit_meanpool_logreg(train: list[Bag], val: list[Bag], params: dict, seed: int,
                        progress: ProgressFn) -> tuple[dict[str, np.ndarray], dict, dict]:
    from sklearn.linear_model import LogisticRegression
    from sklearn.preprocessing import StandardScaler

    X = np.stack([b.embeddings.astype(np.float64).mean(axis=0) for b in train])
    y = np.array([b.label for b in train], dtype=np.int64)
    progress(0.1, "meanpool_logreg: fitting logistic regression")
    scaler = StandardScaler().fit(X)
    clf = LogisticRegression(C=params["C"], max_iter=5000, solver="lbfgs", random_state=seed,
                             class_weight=None if params["class_weight"] == "none" else "balanced")
    clf.fit(scaler.transform(X), y)
    scale = np.where(scaler.scale_ > 0, scaler.scale_, 1.0)
    arrays = {"scaler_mean": scaler.mean_.astype(np.float64), "scaler_scale": scale.astype(np.float64),
              "coef": clf.coef_[0].astype(np.float64), "intercept": clf.intercept_.astype(np.float64)}
    meta = {"head": "meanpool_logreg", "in_dim": int(X.shape[1]), "C": params["C"],
            "class_weight": params["class_weight"], "solver": "lbfgs"}
    summary = {"head": "meanpool_logreg", "n_iter": int(np.max(clf.n_iter_)), "converged": bool(
        np.max(clf.n_iter_) < clf.max_iter), "train_bags": len(train),
               "early_stopping": "not applicable (convex fit)"}
    progress(1.0, "meanpool_logreg: fitted")
    return arrays, meta, summary


def fit_abmil(train: list[Bag], val: list[Bag], params: dict, seed: int,
              progress: ProgressFn) -> tuple[dict[str, np.ndarray], dict, dict]:
    all_train = np.concatenate([b.embeddings for b in train]).astype(np.float32)
    mean = all_train.mean(axis=0)
    std = all_train.std(axis=0)
    std = np.where(std > 1e-6, std, 1.0).astype(np.float32)
    norm = lambda e: ((e.astype(np.float32) - mean) / std).astype(np.float32)  # noqa: E731
    with deterministic_torch(seed) as torch:
        Xtr = [torch.from_numpy(norm(b.embeddings)) for b in train]
        ytr = torch.tensor([float(b.label) for b in train], dtype=torch.float32)
        Xva = [torch.from_numpy(norm(b.embeddings)) for b in val]
        yva = torch.tensor([float(b.label) for b in val], dtype=torch.float32)
        model = build_abmil(int(all_train.shape[1]), params["hidden_dim"], params["attn_dim"], params["dropout"])
        opt = torch.optim.Adam(model.parameters(), lr=params["lr"], weight_decay=params["weight_decay"])
        n_pos = float(ytr.sum().item())
        n_neg = float(len(train) - n_pos)
        pos_weight = torch.tensor([n_neg / n_pos]) if n_pos > 0 else torch.tensor([1.0])
        train_loss_fn = torch.nn.BCEWithLogitsLoss(pos_weight=pos_weight)
        val_loss_fn = torch.nn.BCEWithLogitsLoss()
        rng = np.random.default_rng(seed)
        best_state, best_loss, best_epoch, bad = None, float("inf"), None, 0
        history = []
        use_val = len(val) > 0
        epochs_run = 0
        for epoch in range(params["max_epochs"]):
            model.train()
            total = 0.0
            for i in rng.permutation(len(train)).tolist():
                opt.zero_grad()
                logit, _ = model(Xtr[i])
                loss = train_loss_fn(logit.view(1), ytr[i].view(1))
                loss.backward()
                opt.step()
                total += float(loss.item())
            epochs_run = epoch + 1
            train_loss = total / len(train)
            val_loss = None
            if use_val:
                model.eval()
                with torch.no_grad():
                    vl = [float(val_loss_fn(model(x)[0].view(1), yva[j].view(1)).item()) for j, x in enumerate(Xva)]
                val_loss = float(np.mean(vl))
                if val_loss < best_loss - 1e-6:
                    best_loss, best_epoch, bad = val_loss, epoch + 1, 0
                    best_state = copy.deepcopy(model.state_dict())
                else:
                    bad += 1
            history.append({"epoch": epoch + 1, "train_loss": round(train_loss, 6),
                            "val_loss": None if val_loss is None else round(val_loss, 6)})
            progress((epoch + 1) / params["max_epochs"],
                     f"abmil epoch {epoch + 1}/{params['max_epochs']}: train loss {train_loss:.4f}"
                     + (f", val loss {val_loss:.4f}" if val_loss is not None else ""))
            if use_val and bad >= params["patience"]:
                break
        if best_state is not None:
            model.load_state_dict(best_state)
        model.eval()
        arrays = {f"state.{k}": v.detach().cpu().numpy().astype(np.float32) for k, v in model.state_dict().items()}
    arrays["input_mean"] = mean.astype(np.float32)
    arrays["input_std"] = std
    meta = {"head": "abmil", "in_dim": int(all_train.shape[1]), "hidden_dim": params["hidden_dim"],
            "attn_dim": params["attn_dim"], "dropout": params["dropout"], "architecture": "gated attention MIL"}
    summary = {"head": "abmil", "epochs_run": epochs_run, "max_epochs": params["max_epochs"],
               "best_epoch": best_epoch, "best_val_loss": None if best_epoch is None else round(best_loss, 6),
               "patience": params["patience"], "pos_weight": round(float(pos_weight.item()), 6),
               "early_stopping": ("on validation loss; best epoch restored" if use_val else
                                  "not applied: empty validation split (all epochs used)"),
               "history": history, "train_bags": len(train)}
    return arrays, meta, summary


HEAD_FITTERS = {"meanpool_logreg": fit_meanpool_logreg, "abmil": fit_abmil}
