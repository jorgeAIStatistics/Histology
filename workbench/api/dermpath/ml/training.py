"""The ``train`` job: frozen dataset + pinned feature set → bags → development protocol →
frozen operating point (threshold, calibration, abstention) → content-addressed checkpoint →
records (design ``docs/ml-engine-design.md`` §1, §6).

Run identity
------------
A run's identity (:func:`compute_run_identity`: code tree and revision, training-relevant
dependency versions, encoder spec and weights sha, feature-set spec sha, dataset manifest sha,
split fingerprint, params sha, seed, mode, protocol, classes) is frozen at creation
(``identity_json`` / ``identity_sha256``). EVERY attempt appends a :class:`RunAttempt` with the
identity recomputed in the worker (plus :func:`dermpath.ml.artifacts.code_tree_drift`) and
fails permanently with ``run_identity_changed`` (listing the differing fields) on any
difference; ``code_revision`` and ``deps_json`` of the run are never overwritten. The worker
also re-derives the execution mode and ``synthetic`` and fails permanently on disagreement.

Roles of data (no label reaches feature generation: features come from the run's pinned
feature set, built label-free; only ``synthetic_pipeline_test`` derives a fixture signal, inside
``feature_sets``/``fixture.py``):

* ``holdout``: the head is fitted on TRAIN; ABMIL early stopping uses an inner
  patient-grouped stratified hold-out of train (never val); threshold, calibration and
  abstention are selected on VAL; threshold-dependent val metrics are flagged
  ``tuning_set: true``.
* ``dev_cv``: patient-grouped stratified K-fold over the development pool (train ∪ val),
  out-of-fold predictions stored as split ``oof`` (each development patient scored exactly
  once, by a model that never saw it); threshold, calibration and abstention selected on OOF;
  the final model is refitted on the whole development pool. Test is untouched.

The TEST split is never read here: test metrics come only from a recorded test release.

Idempotency / restart safety
----------------------------
Outputs (predictions, the development evaluation, operating point, checkpoint reference,
status) are committed in ONE final transaction fenced by the job lease
(``ctx.assert_lease``). The checkpoint is written content-addressed and write-once
(``put_content_addressed``): identical inputs give the identical object, never an overwrite.
A rerun after success returns the stored result.
"""

from __future__ import annotations

import hashlib
import importlib
import logging
import os
import time
import warnings
from collections import OrderedDict
from dataclasses import dataclass, field

import numpy as np
from sqlalchemy import func, select

from .. import audit
from ..datasets import TestSetLockViolation, training_eligible_items
from ..db import session_scope, utcnow
from ..errors import ApiError
from ..jobs.registry import JobCanceled, LeaseLost, PermanentJobError
from ..models import DatasetVersion, LabelVersion, QCIssue, Slide
from ..storage import get_store
from .artifacts import code_identity, code_revision, code_tree_drift, dependency_versions, sha256_hex
from .calibration import CalibrationError, apply_calibration, fit_calibration, identity_calibration
from .devices import DeviceUnavailable
from .encoders import EncoderUnavailable, get_encoder
from .engine_models import EXECUTION_MODES, FeatureSet, RunAttempt
from .features import FeatureError
from .fixture import SyntheticSignalForbidden
from .heads import (
    HEAD_FITTERS,
    IN_MEMORY,
    OPTIMISATION_BUDGETS,
    Bag,
    EmbeddingAccess,
    LoadedModel,
    checkpoint_bytes,
    class_weights,
    load_checkpoint,
    streaming_mean,
)
from .metrics import (
    TUNING_SET_NOTE,
    apply_abstention,
    canonical_sha256,
    evaluate_binary,
    no_abstention_policy,
    select_abstention_policy,
    select_operating_threshold,
)
from .models import Evaluation, Prediction, TrainingRun

log = logging.getLogger("dermpath.ml.training")

ATTR_KEYS = ("scanner_id", "site_id", "stain")
RUN_IDENTITY_SCHEMA = "dermpath.run_identity/1"
#: Libraries whose versions change training and scoring outputs (feature extraction libraries
#: are pinned by the feature set's extraction environment instead).
IDENTITY_DEPENDENCIES = ("numpy", "scipy", "scikit-learn", "torch", "python", "python_implementation", "machine")
SYNTHETIC_ENCODER_MODE = "synthetic_pipeline_test"
SUPERVISED_MODE = "supervised_experiment"
TECHNICAL_MODE = "real_image_technical"
ORDERING_NOTE = ("bags are ordered by content-stable keys (patient_code, accession_code, slide sha256s); database "
                 "ids never influence training")
IN_SAMPLE_NOTE = "train-split predictions are in-sample and are never reported as performance"
DECISION_NOTE = ("decisions use the raw score (positive if score >= threshold); calibration maps scores to "
                 "probabilities for reporting and is monotone, so it never changes the ordering")
BAG_CACHE_ENV = "WB_ML_BAG_CACHE_MB"
VERIFY_BAGS = 32  # bags re-scored from the stored checkpoint before anything is recorded


class RunIdentityChanged(PermanentJobError):
    """The identity recomputed at an attempt differs from the one frozen at creation."""

    def __init__(self, diff: list[dict]):
        self.diff = diff
        fields = ", ".join(d["field"] for d in diff)
        super().__init__(f"run_identity_changed: {fields}")


def _fsets():
    """The feature-set module (looked up at call time so tests can patch its functions)."""
    return importlib.import_module("dermpath.ml.feature_sets")


class _Progress:
    def __init__(self, ctx, base: float, span: float) -> None:
        self.ctx, self.base, self.span = ctx, base, span

    def __call__(self, frac: float, message: str) -> None:
        if self.ctx is not None:
            self.ctx.progress(self.base + self.span * max(0.0, min(1.0, frac)), message)

    def sub(self, start: float, stop: float) -> "_Progress":
        return _Progress(self.ctx, self.base + self.span * start, self.span * (stop - start))


# --------------------------------------------------------------------------- modes and identity


def manifest_data_mode(manifest: dict) -> str | None:
    """``synthetic`` | ``real`` | ``mixed`` | None, from the manifest (computed from its items for
    manifests older than ``dataset_manifest/2``)."""
    mode = manifest.get("data_mode")
    if mode:
        return mode
    from ..datasets import data_mode

    return data_mode(list(manifest.get("items") or []))["mode"]


def infer_execution_mode(spec) -> str:
    return SYNTHETIC_ENCODER_MODE if getattr(spec, "synthetic", False) else SUPERVISED_MODE


def mode_problems(spec, data_mode: str | None, execution_mode: str) -> list[str]:
    """Design §1 invariants 2 and 5 for TRAINING (empty list: compatible)."""
    synthetic_encoder = bool(getattr(spec, "synthetic", False))
    enc = getattr(spec, "id", "encoder")
    out = []
    if execution_mode not in EXECUTION_MODES:
        return [f"unknown execution_mode {execution_mode!r}; use one of {', '.join(EXECUTION_MODES)}"]
    if data_mode not in ("synthetic", "real"):
        out.append(f"the dataset's data_mode is {data_mode!r}; experiments need a dataset that is entirely "
                   "synthetic or entirely real")
    if execution_mode == TECHNICAL_MODE:
        out.append("real_image_technical reads no labels anywhere, so no head can be trained in it; build a "
                   "feature set (technical validation) instead")
    if synthetic_encoder and (execution_mode != SYNTHETIC_ENCODER_MODE or data_mode != "synthetic"):
        out.append(f"{enc} is a synthetic encoder: allowed only in synthetic_pipeline_test on a synthetic dataset "
                   f"(mode {execution_mode}, data_mode {data_mode})")
    if execution_mode == SYNTHETIC_ENCODER_MODE and not synthetic_encoder:
        out.append(f"synthetic_pipeline_test uses the synthetic encoder only ({enc} is not synthetic)")
    if execution_mode == SUPERVISED_MODE and data_mode != "real":
        out.append(f"supervised_experiment needs a real dataset (data_mode real); this one is {data_mode!r}")
    return out


def derive_synthetic(spec, data_mode: str | None) -> tuple[bool, list[str]]:
    """Design §1 invariant 5: ``run.synthetic`` = synthetic encoder or synthetic data."""
    reasons = []
    if getattr(spec, "synthetic", False):
        reasons.append("synthetic_encoder: embeddings carry no pathology information")
    if data_mode == "synthetic":
        reasons.append("synthetic_images: procedural tiles with no histology")
    return bool(reasons), reasons


def encoder_spec_sha256(encoder) -> str:
    spec = getattr(encoder, "spec", None)
    if spec is not None:
        return spec.spec_sha256()
    return sha256_hex(f"legacy-adapter:{encoder.id}:{getattr(encoder, 'preprocessing_version', '')}".encode())


def training_dependencies() -> dict:
    deps = dependency_versions()
    return {k: deps.get(k, "not installed") for k in IDENTITY_DEPENDENCIES}


def manifest_digest(manifest: dict) -> str:
    from ..datasets import canonical_json as manifest_canonical_json

    return hashlib.sha256(manifest_canonical_json(manifest)).hexdigest()


def manifest_split_fingerprint(manifest: dict) -> str:
    from ..splits import split_fingerprint

    return split_fingerprint((s.get("patient_code") or s["coded_patient_id"], s["split"])
                             for s in manifest.get("splits") or [])


def params_sha256(params: dict) -> str:
    return canonical_sha256(params)


def compute_run_identity(*, encoder, feature_set, manifest: dict, dataset_version_id: str, params: dict, seed: int,
                         head: str, execution_mode: str, evaluation_protocol: str, label_scope: str,
                         positive_class: str, negative_class: str, synthetic: bool, code: dict | None = None,
                         deps: dict | None = None) -> dict:
    """Everything that defines what a run computes. ``code``/``deps`` default to this process's
    (the code identity captured at process start, :func:`dermpath.ml.artifacts.code_identity`)."""
    if code is None:
        code, revision = code_identity(), code_revision()
    else:
        revision = code.get("code_revision")
    return {
        "schema": RUN_IDENTITY_SCHEMA,
        "code_tree_sha256": code["code_tree_sha256"],
        "code_revision": revision,
        "deps": dict(sorted((deps if deps is not None else training_dependencies()).items())),
        "encoder_id": encoder.id,
        "encoder_spec_sha256": encoder_spec_sha256(encoder),
        "weights_sha256": feature_set.weights_sha256,
        "feature_set_id": feature_set.id,
        "feature_set_spec_sha256": feature_set.spec_sha256,
        "dataset_version_id": dataset_version_id,
        "dataset_manifest_sha256": manifest_digest(manifest),
        "split_fingerprint": manifest_split_fingerprint(manifest),
        "split_family_id": manifest.get("split_family_id"),
        "data_mode": manifest_data_mode(manifest),
        "reference_standard": (manifest.get("config") or {}).get("reference_standard", "expert"),
        "params_sha256": params_sha256(params),
        "seed": int(seed),
        "head": head,
        "execution_mode": execution_mode,
        "evaluation_protocol": evaluation_protocol,
        "label_scope": label_scope,
        "positive_class": positive_class,
        "negative_class": negative_class,
        "synthetic": bool(synthetic),
    }


def identity_sha256(identity: dict) -> str:
    return canonical_sha256(identity)


def identity_diff(frozen: dict, now: dict) -> list[dict]:
    """Differing identity fields (``deps.<name>`` per dependency)."""
    out = []
    for k in sorted(set(frozen) | set(now)):
        a, b = frozen.get(k), now.get(k)
        if isinstance(a, dict) and isinstance(b, dict):
            for d in sorted(set(a) | set(b)):
                if a.get(d) != b.get(d):
                    out.append({"field": f"{k}.{d}", "frozen": a.get(d), "now": b.get(d)})
        elif a != b:
            out.append({"field": k, "frozen": a, "now": b})
    return out


# --------------------------------------------------------------------------- bags


def assert_no_test(bags: list[Bag], manifest: dict, where: str) -> None:
    """Defence in depth: no slide or patient assigned to test may reach training/threshold/AL."""
    test_slides = {it["slide_id"] for it in manifest["items"] if it.get("split") == "test"}
    test_patients = {s["coded_patient_id"] for s in manifest.get("splits", []) if s.get("split") == "test"}
    for b in bags:
        if set(b.slide_ids) & test_slides or b.patient_id in test_patients:
            raise TestSetLockViolation(f"test item reached {where} (bag {b.bag_id})")


def _attr(values: list) -> str | None:
    vals = {v for v in values}
    if len(vals) == 1:
        return next(iter(vals))
    return "mixed"


def qc_context(db, slide_ids: list[str]) -> dict:
    """Snapshot of QC/calibration facts at prediction time (used as possible failure reasons)."""
    issues = db.scalars(select(QCIssue).where(QCIssue.slide_id.in_(slide_ids))).all()
    open_or_confirmed = sorted({f"{i.category} ({i.status})" for i in issues if not i.overridden})
    uncalibrated = []
    for s in db.scalars(select(Slide).where(Slide.id.in_(slide_ids))).all():
        if s.image_kind == "wsi" and (s.mpp_x is None or s.mpp_y is None):
            uncalibrated.append(s.id)
    return {"qc_issues": open_or_confirmed, "uncalibrated_slides": uncalibrated}


def build_bags(items: list[dict], label_scope: str, positive_class: str) -> list[Bag]:
    """Slide bags (``label_scope`` slide) or case bags (``case``: all slides of a case form ONE
    bag carrying the case label; it is never copied to slides or patches). Bags and the slides
    inside a bag are ordered by content-stable keys, never by database ids."""
    groups: dict[str, list[dict]] = {}
    for it in items:
        key = it["slide_id"] if label_scope == "slide" else it["case_id"]
        groups.setdefault(key, []).append(it)
    bags = []
    for key, rows in groups.items():
        rows = sorted(rows, key=lambda r: (r.get("slide_sha256") or "", r["slide_id"]))
        values = {r["label_value"] for r in rows}
        if len(values) != 1:
            raise PermanentJobError(f"bag {key} has conflicting labels {sorted(values)}")
        value = next(iter(values))
        bags.append(Bag(
            bag_id=key, kind=label_scope, slide_ids=[r["slide_id"] for r in rows], case_id=rows[0]["case_id"],
            patient_id=rows[0]["coded_patient_id"], patient_code=rows[0].get("patient_code"), label_value=value,
            label=1 if value == positive_class else 0,
            label_version_ids=sorted({r["label_version_id"] for r in rows}),
            attributes={k: _attr([r.get(k) for r in rows]) for k in ATTR_KEYS},
            accession_code=rows[0].get("accession_code"), slide_sha256s=[r.get("slide_sha256") or "" for r in rows],
            split=rows[0].get("split")))
    return sorted(bags, key=lambda b: b.sort_key)


def patient_keys(bags: list[Bag]) -> dict[str, str]:
    out: dict[str, str] = {}
    for b in bags:
        out.setdefault(b.patient_id, b.patient_key)
    return out


def duplicate_patient_pairs(manifest: dict) -> list[tuple[str, str]]:
    """Patient pairs joined by near-duplicate slide pairs a person marked ``duplicate``."""
    patient_of = {it["slide_id"]: it["coded_patient_id"] for it in manifest.get("items") or []}
    out = set()
    for d in manifest.get("near_duplicate_decisions") or []:
        if d.get("decision") != "duplicate":
            continue
        a, b = patient_of.get(d.get("slide_a")), patient_of.get(d.get("slide_b"))
        if a and b and a != b:
            out.add(tuple(sorted((a, b))))
    return sorted(out)


def split_context(manifest: dict, project_id: str) -> dict:
    """Content-stable salts and grouping rules shared by inner splits, folds and subsets."""
    salt = manifest.get("split_family_salt") or hashlib.sha256(
        f"dermpath.split_family|{project_id}".encode()).hexdigest()[:32]
    return {"split_salt": salt, "patient_label_rule": manifest.get("patient_label_rule") or "any_positive",
            "duplicate_pairs": duplicate_patient_pairs(manifest)}


# --------------------------------------------------------------------------- lazy embeddings


class FeatureSetAccess(EmbeddingAccess):
    """Embeddings of a pinned feature set, loaded lazily per slide through
    ``feature_sets.load_slide_features`` (memory-mapped where possible). Concatenated bag
    arrays are kept in a bounded LRU cache (``WB_ML_BAG_CACHE_MB``, default 256)."""

    def __init__(self, fs, *, expected_weights_sha256: str | None = None, cache_mb: float | None = None) -> None:
        self.fs = fs
        self.expected_weights = expected_weights_sha256 or fs.weights_sha256
        if cache_mb is None:
            raw = os.environ.get(BAG_CACHE_ENV, "")
            cache_mb = float(raw) if raw.strip() else 256.0
        self.cache_bytes = int(cache_mb * 1024 * 1024)
        self._slides: dict[str, object] = {}
        self._cache: OrderedDict[str, np.ndarray] = OrderedDict()
        self._cached = 0
        self._means: dict[str, np.ndarray] = {}
        self.loads = 0

    def slide(self, slide_id: str):
        sf = self._slides.get(slide_id)
        if sf is None:
            sf = _fsets().load_slide_features(self.fs, slide_id)
            self.loads += 1
            if getattr(sf, "weights_sha256", None) != self.expected_weights:
                raise RunIdentityChanged([{"field": "weights_sha256", "frozen": self.expected_weights,
                                           "now": getattr(sf, "weights_sha256", None)}])
            if getattr(sf, "encoder_spec_sha256", None) != self.fs.encoder_spec_sha256:
                raise RunIdentityChanged([{"field": "encoder_spec_sha256", "frozen": self.fs.encoder_spec_sha256,
                                           "now": getattr(sf, "encoder_spec_sha256", None)}])
            self._slides[slide_id] = sf
        return sf

    def parts(self, bag: Bag) -> list[np.ndarray]:
        return [self.slide(s).embeddings for s in bag.slide_ids if int(self.slide(s).n_patches) > 0]

    def embeddings(self, bag: Bag) -> np.ndarray:
        hit = self._cache.get(bag.bag_id)
        if hit is not None:
            self._cache.move_to_end(bag.bag_id)
            return hit
        arr = super().embeddings(bag)
        if arr.nbytes <= self.cache_bytes:
            self._cache[bag.bag_id] = arr
            self._cached += arr.nbytes
            while self._cached > self.cache_bytes and self._cache:
                _, old = self._cache.popitem(last=False)
                self._cached -= old.nbytes
        return arr

    def mean(self, bag: Bag) -> np.ndarray:
        m = self._means.get(bag.bag_id)
        if m is None:
            m = streaming_mean(self.parts(bag))
            self._means[bag.bag_id] = m
        return m

    def describe(self, bag: Bag) -> None:
        """Patch counts and artifact ids (cheap: no embedding is read)."""
        sfs = [self.slide(s) for s in bag.slide_ids]
        bag.patch_counts = [int(sf.n_patches) for sf in sfs]
        bag.artifact_ids = [getattr(sf, "artifact_id", None) for sf in sfs]

    def attach_coords(self, bag: Bag) -> None:
        coords, idx, extents = [], [], []
        for j, sid in enumerate(bag.slide_ids):
            sf = self.slide(sid)
            n = int(sf.n_patches)
            if n:
                coords.append(np.asarray(sf.coords, dtype=np.int64))
                idx.append(np.full(n, j, dtype=np.int64))
            extents.append(slide_extent(self.fs, sid, sf))
        bag.coords = np.concatenate(coords) if coords else np.zeros((0, 2), dtype=np.int64)
        bag.slide_index = np.concatenate(idx) if idx else np.zeros(0, dtype=np.int64)
        bag.extents = extents


def _snapshot_for(fs, slide_id: str) -> dict | None:
    snap = getattr(fs, "input_snapshot_json", None) or {}
    for container in (snap.get("slides") if isinstance(snap, dict) else None, snap):
        if isinstance(container, dict) and isinstance(container.get(slide_id), dict):
            return container[slide_id]
        if isinstance(container, list):
            for row in container:
                if isinstance(row, dict) and row.get("slide_id") == slide_id:
                    return row
    return None


def slide_extent(fs, slide_id: str, sf=None) -> list[int]:
    """Level-0 width/height of one patch of ``slide_id`` (for attention overlays only)."""
    ext = getattr(sf, "extent", None) if sf is not None else None
    if ext is not None and len(ext) == 2:
        return [int(ext[0]), int(ext[1])]
    policy_json = getattr(fs, "patch_policy_json", None) or {}
    size = int(policy_json.get("patch_size") or 224)
    try:
        from .patching import PatchPolicy, plan_scale

        snap = _snapshot_for(fs, slide_id) or {}
        plan = plan_scale(mpp_x=snap.get("mpp_x"), mpp_y=snap.get("mpp_y"),
                          level_downsamples=snap.get("level_downsamples") or [1.0],
                          policy=PatchPolicy.from_json(policy_json))
        return [int(v) for v in plan.extent]
    except Exception:  # display only: fall back to the output patch size
        return [size, size]


# --------------------------------------------------------------------------- protocols


@dataclass
class ScoredBag:
    bag: Bag
    score: float
    attention: np.ndarray | None = None
    fold: int | None = None


@dataclass
class ProtocolOutcome:
    arrays: dict
    meta: dict
    summary: dict
    dev_split: str  # val | oof
    dev: list[ScoredBag]
    in_sample: list[ScoredBag]
    fit_bags: list[Bag]
    unscored: list[dict] = field(default_factory=list)
    cv: dict | None = None
    learning_curve: dict | None = None


def fit_head(head: str, bags: list[Bag], params: dict, seed: int, progress, *, access: EmbeddingAccess,
             context: dict) -> tuple[dict, dict, dict]:
    classes = {b.label for b in bags}
    if classes != {0, 1}:
        raise PermanentJobError(f"the fitting set has {len(bags)} scorable bag(s) with class(es) {sorted(classes)}; "
                                "a binary head needs both classes")
    return HEAD_FITTERS[head](bags, params, seed, progress, access=access, **context)


def score_bags(model: LoadedModel, bags: list[Bag], access: EmbeddingAccess, *, fold: int | None = None
               ) -> list[ScoredBag]:
    out = []
    for b in bags:
        s, att = model.score_bag(b, access)
        if not np.isfinite(s):
            raise PermanentJobError(f"non-finite score for bag {b.bag_id}")
        out.append(ScoredBag(b, float(s), att, fold))
    return out


def learning_curve_subset(train: list[Bag], params: dict, context: dict) -> tuple[list[Bag], dict | None]:
    """Nested, stratified, deterministic subset of the TRAINING patients
    (``train_patient_fraction``, ``subset_repeat``); identity when the fraction is 1."""
    f = float(params.get("train_patient_fraction", 1.0))
    if f >= 1.0:
        return list(train), None
    from .cv import nested_learning_curve_subsets

    r = int(params.get("subset_repeat", 0))
    with warnings.catch_warnings(record=True):
        warnings.simplefilter("always")
        res = nested_learning_curve_subsets([b.label for b in train], [b.patient_id for b in train],
                                            patient_keys=patient_keys(train), salt=f"{context['split_salt']}|lc",
                                            fractions=[f], repeats=r + 1,
                                            duplicate_pairs=context.get("duplicate_pairs", ()),
                                            patient_label_rule=context.get("patient_label_rule", "any_positive"))
    sub = next(s for s in res["subsets"] if s["repeat"] == r and s["fraction"] == f)
    keep = set(sub["patients"])
    info = {"schema": res["schema"], "method": res["method"], "fraction": f, "repeat": r, "salt": res["salt"],
            "n_patients": sub["n_patients"], "n_bags": sub["n_bags"], "patients_by_class": sub["patients_by_class"],
            "pool_patients": res["n_patients"], "fingerprint": sub["fingerprint"], "class_absent": sub["class_absent"],
            "note": res["note"]}
    return [b for b in train if b.patient_id in keep], info


def run_holdout(train: list[Bag], val: list[Bag], *, head: str, params: dict, seed: int, access: EmbeddingAccess,
                context: dict, progress=None) -> ProtocolOutcome:
    """Fit on train (or its learning-curve subset); score val. Val is never passed to the fitter."""
    progress = progress or _Progress(None, 0, 1)
    fit_bags, lc = learning_curve_subset(train, params, context)
    arrays, meta, summary = fit_head(head, fit_bags, params, seed, progress.sub(0.0, 0.85), access=access,
                                     context=context)
    model = LoadedModel(arrays, meta)
    progress(0.9, "scoring validation bags")
    dev = score_bags(model, val, access)
    in_sample = score_bags(model, fit_bags, access)
    return ProtocolOutcome(arrays, meta, summary, "val", dev, in_sample, fit_bags, learning_curve=lc)


def cv_salt(context: dict, k: int) -> str:
    """Folds depend on the development pool and k only (not on the head seed), so every run on a
    manifest shares them and their out-of-fold sets are paired."""
    return f"{context['split_salt']}|cv|k={int(k)}"


def run_dev_cv(dev_pool: list[Bag], *, head: str, params: dict, seed: int, access: EmbeddingAccess, context: dict,
               progress=None) -> ProtocolOutcome:
    """Patient-grouped stratified K-fold over the development pool; out-of-fold scores; final
    refit on the whole pool (or its learning-curve subset)."""
    from .cv import grouped_stratified_kfold

    progress = progress or _Progress(None, 0, 1)
    k = int(params["cv_folds"])
    with warnings.catch_warnings(record=True):
        warnings.simplefilter("always")
        try:
            folds = grouped_stratified_kfold([b.label for b in dev_pool], [b.patient_id for b in dev_pool], k=k,
                                             patient_keys=patient_keys(dev_pool), salt=cv_salt(context, k),
                                             duplicate_pairs=context.get("duplicate_pairs", ()),
                                             patient_label_rule=context.get("patient_label_rule", "any_positive"))
        except ValueError as exc:
            raise PermanentJobError(f"dev_cv is not possible: {exc}") from exc
    allowed_bags, lc = learning_curve_subset(dev_pool, params, context)
    allowed = {b.bag_id for b in allowed_bags}
    oof: list[ScoredBag] = []
    unscored: list[dict] = []
    fold_summaries = []
    splits = folds.splits([b.patient_id for b in dev_pool])
    span = 0.75 / (k + 1)
    for f, (fit_idx, held_idx) in enumerate(splits):
        fit_bags = [dev_pool[i] for i in fit_idx if dev_pool[i].bag_id in allowed]
        held = [dev_pool[i] for i in held_idx]
        classes = {b.label for b in fit_bags}
        entry = {"fold": f, "fit_bags": len(fit_bags), "held_out_bags": len(held),
                 "fit_patients": len({b.patient_id for b in fit_bags}),
                 "held_out_patients": len({b.patient_id for b in held})}
        if classes != {0, 1}:
            reason = (f"fold {f}: the fitting part has class(es) {sorted(classes)} only; its held-out bags are not "
                      "scored (counted as unscorable)")
            unscored.extend({"bag_id": b.bag_id, "split": "oof", "reason": reason, "label": b.label,
                             "patient_id": b.patient_id, "patient_code": b.patient_code} for b in held)
            fold_summaries.append({**entry, "status": "not_fitted", "reason": reason})
            continue
        arrays, meta, summary = fit_head(head, fit_bags, params, seed, progress.sub(f * span, (f + 1) * span),
                                         access=access, context=context)
        model = LoadedModel(arrays, meta)
        oof.extend(score_bags(model, held, access, fold=f))
        fold_summaries.append({**entry, "status": "fitted", "summary": _compact_summary(summary)})
    progress.sub(k * span, 0.8)(0.0, "refitting the final model on the whole development pool")
    arrays, meta, summary = fit_head(head, allowed_bags, params, seed, progress.sub(k * span, 0.85), access=access,
                                     context=context)
    model = LoadedModel(arrays, meta)
    in_sample = score_bags(model, allowed_bags, access)
    oof.sort(key=lambda sb: sb.bag.sort_key)
    cv = folds.to_dict()
    codes = patient_keys(dev_pool)
    cv["fold_of_patient_code"] = dict(sorted((codes[p], f) for p, f in folds.fold_of.items()))
    cv["folds_summary"] = fold_summaries
    cv["salt_rule"] = "folds depend on the development pool and k only, not on the head seed"
    summary = {**summary, "folds": fold_summaries, "final_model": "refitted on the whole development pool"}
    return ProtocolOutcome(arrays, meta, summary, "oof", oof, in_sample, allowed_bags, unscored=unscored, cv=cv,
                           learning_curve=lc)


def _compact_summary(summary: dict) -> dict:
    keep = ("head", "epochs_run", "best_epoch", "best_inner_holdout_loss", "n_iter", "converged", "train_bags",
            "fit_bags")
    return {k: summary[k] for k in keep if k in summary}


# --------------------------------------------------------------------------- operating point


def select_operating_point(dev: list[ScoredBag], params: dict, *, selected_on: str) -> dict:
    """Threshold, calibration and abstention, all chosen on the same DEVELOPMENT predictions
    (val for holdout, out-of-fold for dev_cv) and frozen."""
    y = np.array([sb.bag.label for sb in dev], dtype=np.int64)
    s = np.array([sb.score for sb in dev], dtype=np.float64)
    patients = [sb.bag.patient_id for sb in dev]
    n_ev = int(params.get("min_threshold_evidence", 10))
    thr = select_operating_threshold(
        y, s, rule=params["threshold_rule"], patients=patients, target_sensitivity=params["target_sensitivity"],
        fixed_value=params.get("threshold_value") if params.get("threshold_value") is not None else 0.5,
        min_positives=n_ev, min_negatives=n_ev, fallback_value=0.5, selected_on=selected_on)
    t = float(thr["value"])
    method = params.get("calibration", "none")
    if method == "none":
        cal, cal_status, cal_reason = identity_calibration(), "not_requested", None
    else:
        try:
            cal = fit_calibration(s, y, method=method, item_splits=[selected_on] * int(y.size))
            cal_status, cal_reason = "fitted", None
        except CalibrationError as exc:
            cal, cal_status, cal_reason = identity_calibration(), "insufficient_evidence", str(exc)
    tc = params.get("abstention_target_coverage")
    if tc is None:
        policy = no_abstention_policy(t, reason="abstention not requested")
    else:
        policy = select_abstention_policy(y, s, t, target_coverage=float(tc), selected_on=selected_on)
    return {"threshold": thr, "calibration": cal,
            "calibration_selection": {"requested": method, "status": cal_status, "reason": cal_reason,
                                      "selected_on": selected_on, "params_sha256": cal.get("params_sha256")},
            "abstention": policy, "decision_note": DECISION_NOTE}


def apply_operating_point(scores, op: dict) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """``(calibrated, predicted, abstained)`` for raw ``scores`` under a frozen operating point."""
    s = np.asarray(scores, dtype=np.float64)
    cal = apply_calibration(op["calibration"], s) if s.size else s.copy()
    pred = (s >= float(op["threshold"]["value"])).astype(np.int64)
    abst = apply_abstention(s, op["abstention"]) if s.size else np.zeros(0, dtype=bool)
    return cal, pred, abst


def development_summary(dev: list[ScoredBag], unscored: list[dict], op: dict, params: dict, seed: int, *,
                        split: str, protocol: str) -> dict:
    """Development metrics (val or OOF). When the threshold was selected on these data,
    threshold-dependent metrics are flagged as a tuning set (optimistic); a prespecified or
    fallback threshold was not tuned here. Threshold-free metrics are reported separately."""
    tuning = op["threshold"].get("selection_status") == "selected"
    y = np.array([sb.bag.label for sb in dev], dtype=np.int64)
    s = np.array([sb.score for sb in dev], dtype=np.float64)
    # Bootstrap clusters by content-stable patient keys (patient code), never database uuids: the same cohort
    # re-imported under new ids gives the same CIs.
    patients = [sb.bag.patient_key for sb in dev]
    cal_s = apply_calibration(op["calibration"], s) if (s.size and op["calibration"].get("method") != "none") \
        else None
    ev = evaluate_binary(y, s, patients, threshold=float(op["threshold"]["value"]),
                         unscorable_y=[u["label"] for u in unscored if "label" in u],
                         unscorable_patients=[u.get("patient_code") or u["patient_id"] for u in unscored
                                              if "label" in u],
                         target_prevalence=params.get("target_prevalence"), calibrated_scores=cal_s,
                         n_boot=int(params.get("n_boot", 1000)), seed=int(seed),
                         min_patients=int(params.get("boot_min_patients", 10)), tuning_set=tuning)
    m = ev["metrics"]
    return {
        "split": split, "protocol": protocol, "tuning_set": tuning, "tuning_set_note": TUNING_SET_NOTE if tuning
        else None,
        "threshold_free": {k: m[k] for k in ("auroc", "auprc", "brier")},
        "at_operating_point": {k: m[k] for k in ("sensitivity", "specificity", "ppv", "npv")},
        "threshold": float(op["threshold"]["value"]),
        "threshold_selection_status": op["threshold"].get("selection_status"),
        "n_items": ev["n_items"], "n_patients": ev["n_patients"], "positives": ev["positives"],
        "negatives": ev["negatives"], "n_unscorable": ev["n_unscorable"],
        "intention_to_evaluate": ev["intention_to_evaluate"], "bootstrap": ev["bootstrap"],
        "calibration": ev["calibration"], "evaluation_prevalence": ev["evaluation_prevalence"],
        # compact view (values only)
        "sensitivity": m["sensitivity"]["value"], "specificity": m["specificity"]["value"],
        "auroc": m["auroc"]["value"], "auprc": m["auprc"]["value"],
    }


def effective_sampling(fit_bags: list[Bag], params: dict, head_summary: dict | None = None) -> dict:
    """What the final head actually saw: class counts, the class weights applied, and the
    effective positive fraction ``w1 n1 / (w1 n1 + w0 n0)``. For ABMIL the weights come from
    the inner fit part (the inner hold-out only stops training)."""
    head_summary = head_summary or {}
    cw = head_summary.get("class_weights") or class_weights([b.label for b in fit_bags], params["class_weight"])
    inner = head_summary.get("inner_holdout") or {}
    if inner and head_summary.get("fit_bags") != len(fit_bags):
        computed_on = ("the inner fit part of the training bags (ABMIL; the inner hold-out is used only for early "
                       "stopping)")
        patients = (inner.get("fit") or {}).get("patients_by_class")
    else:
        computed_on = "the bags the final head was fitted on (training data only)"
        patients = None
    if patients is None:
        patients = {"positive": len({b.patient_id for b in fit_bags if b.label == 1}),
                    "negative": len({b.patient_id for b in fit_bags if b.label == 0})}
    return {"class_counts": {"bags": cw["counts"], "patients_with_bags_of_class": patients},
            "class_weight": cw["class_weight"], "weights": cw["weights"],
            "raw_positive_fraction": cw["raw_positive_fraction"],
            "effective_positive_fraction": cw["effective_positive_fraction"],
            "computed_on": computed_on,
            "instance_subsampling": {"max_instances_per_bag": params.get("max_instances_per_bag"),
                                     **({"bag_epochs_subsampled": head_summary["instance_subsampling"][
                                         "bag_epochs_subsampled"]} if "instance_subsampling" in head_summary else {})}}


# --------------------------------------------------------------------------- records


def attention_rows(bag: Bag, att: np.ndarray | None) -> list | None:
    if att is None or bag.coords is None:
        return None
    rows = []
    for k in range(int(att.shape[0])):
        j = int(bag.slide_index[k])
        w, h = bag.extents[j]
        rows.append([j, int(bag.coords[k, 0]), int(bag.coords[k, 1]), w, h, round(float(att[k]), 8)])
    return rows


def prediction_records(run: TrainingRun, split: str, scored: list[ScoredBag], op: dict, qc: dict[str, dict],
                       access: EmbeddingAccess | None = None) -> list[Prediction]:
    """Prediction rows (append-only) for scored bags under the frozen operating point."""
    cal, pred, abst = apply_operating_point([sb.score for sb in scored], op)
    thr = float(op["threshold"]["value"])
    out = []
    for i, sb in enumerate(scored):
        b = sb.bag
        if sb.attention is not None and b.coords is None and isinstance(access, FeatureSetAccess):
            access.attach_coords(b)
        attrs = {**b.attributes, "n_patches": b.n_patches, "qc_context": qc.get(b.bag_id),
                 "calibrated_score": float(cal[i]), "manifest_split": b.split}
        if sb.fold is not None:
            attrs["fold"] = int(sb.fold)
        out.append(Prediction(
            run_id=run.id, project_id=run.project_id, split=split, bag_kind=b.kind, bag_id=b.bag_id,
            slide_ids_json=b.slide_ids, case_id=b.case_id, coded_patient_id=b.patient_id,
            patient_code=b.patient_code, label_value=b.label_value, label_version_ids_json=b.label_version_ids,
            label=b.label, score=sb.score, threshold=thr, predicted=int(pred[i]), abstained=bool(abst[i]),
            attributes_json=attrs, attention_json=attention_rows(b, sb.attention),
            feature_artifact_ids_json=[a for a in b.artifact_ids if a]))
    return out


def run_operating_point(run: TrainingRun, *, threshold: float | None = None) -> dict:
    t = float(run.threshold_value if threshold is None else threshold)
    thr = dict(run.threshold_json or {})
    thr["value"] = t
    return {"threshold": thr, "calibration": run.calibration_json or identity_calibration(),
            "abstention": run.abstention_json or no_abstention_policy(t, reason="no frozen abstention policy")}


def split_counts(manifest: dict, label_scope: str) -> dict:
    out = {}
    for sp in ("train", "val", "test"):
        rows = [r for r in manifest["items"] if r.get("split") == sp]
        out[sp] = {"patients": len({r["coded_patient_id"] for r in rows}), "items": len(rows),
                   "bags": len({r["slide_id"] if label_scope == "slide" else r["case_id"] for r in rows})}
    return out


# --------------------------------------------------------------------------- attempt bookkeeping


def _fail(run_id: str, status: str, message: str) -> None:
    with session_scope() as db:
        run = db.get(TrainingRun, run_id)
        if run is not None and run.status not in ("succeeded", "failed", "canceled"):
            run.status = status
            run.error = message[:4000]
            run.finished_at = utcnow()


def _settle_attempt(attempt_id: str | None, outcome: str, error: str | None = None,
                    result: dict | None = None) -> None:
    if not attempt_id:
        return
    try:
        with session_scope() as db:
            a = db.get(RunAttempt, attempt_id)
            if a is not None and a.outcome is None:
                a.outcome = outcome
                a.error = (error or None) and error[:4000]
                a.result_json = result
                a.finished_at = utcnow()
    except Exception:  # bookkeeping must never mask the attempt's own outcome
        log.exception("could not settle run attempt %s as %s", attempt_id, outcome)


def run_training(run_id: str, ctx=None) -> dict:
    state: dict = {"attempt_id": None}
    try:
        return _run_training(run_id, ctx, state)
    except RunIdentityChanged as exc:
        _settle_attempt(state["attempt_id"], "run_identity_changed", str(exc), {"diff": exc.diff})
        _fail(run_id, "failed", str(exc))
        raise
    except TestSetLockViolation as exc:
        msg = f"test-set lock violation: {exc}"
        _settle_attempt(state["attempt_id"], "failed", msg)
        _fail(run_id, "failed", msg)
        raise PermanentJobError(msg) from exc
    except PermanentJobError as exc:
        _settle_attempt(state["attempt_id"], "failed", str(exc))
        _fail(run_id, "failed", str(exc))
        raise
    except JobCanceled:
        _settle_attempt(state["attempt_id"], "canceled", "canceled on request")
        _fail(run_id, "canceled", "canceled on request")
        raise
    except LeaseLost as exc:
        _settle_attempt(state["attempt_id"], "lease_lost", str(exc))
        raise
    except Exception as exc:
        _settle_attempt(state["attempt_id"], "retryable_error", f"{type(exc).__name__}: {exc}")
        raise


def _open_attempt(run_id: str, project_id: str, ctx, identity_now: dict, diff: list[dict]) -> str:
    code = code_identity()
    with session_scope() as db:
        n = db.scalar(select(func.max(RunAttempt.attempt_number)).where(RunAttempt.run_id == run_id)) or 0
        a = RunAttempt(run_id=run_id, project_id=project_id, attempt_number=n + 1,
                       job_id=getattr(ctx, "job_id", None), job_attempt=getattr(ctx, "attempt", None),
                       job_retry_count=getattr(ctx, "retry_count", None), worker_id=getattr(ctx, "worker_id", None),
                       code_revision=code_revision(), code_tree_sha256=code["code_tree_sha256"],
                       code_dirty=code.get("dirty"), deps_json=dependency_versions(),
                       identity_sha256=identity_sha256(identity_now), identity_matches=not diff,
                       identity_diff_json=diff or None)
        db.add(a)
        db.flush()
        return a.id


def label_source_permitted(source: str, reference_standard: str) -> bool:
    """Contract D (``dermpath.labels.label_source_permitted``). If that function is absent the
    check fails closed to the phase-2 rule: expert labels only."""
    from .. import labels

    fn = getattr(labels, "label_source_permitted", None)
    if fn is None:
        return source == "expert"
    return bool(fn(source, reference_standard))


def _label_sources_ok(db, items: list[dict], reference_standard: str) -> None:
    lv_ids = sorted({r["label_version_id"] for r in items})
    if not lv_ids:
        return
    sources = dict(db.execute(select(LabelVersion.id, LabelVersion.source).where(LabelVersion.id.in_(lv_ids))).all())
    bad = [i for i in lv_ids if not label_source_permitted(sources.get(i) or "", reference_standard)]
    if bad:
        raise PermanentJobError(f"{len(bad)} training/validation label(s) have a source not permitted by the "
                                f"reference standard {reference_standard!r}; model suggestions never become "
                                "training truth")


def _ensure_feature_set(fs_id: str, slide_ids: list[str], ctx, progress) -> tuple[FeatureSet, dict]:
    """Return the run's pinned feature set, building it inline (resumable, label-free) when it
    is not ready, and require every development slide to be built."""
    fsets = _fsets()
    t0 = time.perf_counter()
    with session_scope() as db:
        fs = db.get(FeatureSet, fs_id)
        ready = fs is not None and fs.status == "ready"
    built = False
    if fs is None:
        raise PermanentJobError(f"feature set {fs_id} does not exist")
    if not ready:
        progress(0.0, "building the run's feature set (label-free)")
        try:
            fsets.build_feature_set(fs_id, ctx)
        except (JobCanceled, LeaseLost, PermanentJobError):
            raise
        except EncoderUnavailable as exc:
            raise PermanentJobError(f"encoder_unavailable: {exc}") from exc
        except SyntheticSignalForbidden as exc:
            raise PermanentJobError(f"synthetic_signal_forbidden: {exc}") from exc
        except ApiError as exc:  # ModeMismatch (design §1, re-checked at build), invalid params: deterministic
            raise PermanentJobError(f"{exc.code}: {exc.message}") from exc
        except FeatureError as exc:
            # Deterministic build failures (input_changed, extraction_env_changed, integrity, per-slide failures):
            # a retry would fail the same way. build_feature_set has already marked the set failed.
            raise PermanentJobError(f"feature_set_build_failed: {exc}") from exc
        except DeviceUnavailable as exc:
            raise PermanentJobError(f"device_unavailable: {exc}") from exc
        built = True
    with session_scope() as db:
        fs = db.get(FeatureSet, fs_id)
        try:
            fsets.require_ready(db, fs, slide_ids)
        except getattr(fsets, "FeatureSetNotReady", LookupError) as exc:
            missing = list(getattr(exc, "missing", []) or [])
            raise PermanentJobError(f"feature_set_not_ready: {len(missing)} slide(s) not built, e.g. "
                                    f"{missing[:5]} ({exc})") from exc
        db.expunge(fs)
    return fs, {"built_inline": built, "seconds": round(time.perf_counter() - t0, 3)}


def _run_training(run_id: str, ctx, state: dict) -> dict:
    t_start = time.perf_counter()
    progress = _Progress(ctx, 0.0, 1.0)
    with session_scope() as db:
        run = db.get(TrainingRun, run_id)
        if run is None:
            raise PermanentJobError(f"training run {run_id} does not exist")
        if run.status == "succeeded":
            return {"run_id": run.id, "status": "succeeded", "checkpoint_sha256": run.checkpoint_sha256,
                    "idempotent_replay": True}
        dv = db.get(DatasetVersion, run.dataset_version_id)
        if dv is None or dv.status != "frozen" or not dv.manifest_json:
            raise PermanentJobError("the dataset version is not frozen")
        if dv.manifest_sha256 != run.dataset_manifest_sha256:
            raise PermanentJobError("dataset manifest sha256 differs from the one recorded at experiment creation")
        encoder = get_encoder(run.encoder_id)
        try:
            if encoder is None:
                raise EncoderUnavailable(run.encoder_id, "unknown", "no such encoder")
            encoder.require_available()
        except EncoderUnavailable as exc:
            raise PermanentJobError(f"encoder_unavailable: {exc}") from exc
        if run.identity_json is None or run.execution_mode is None or run.feature_set_id is None:
            raise PermanentJobError("legacy_run: created before the engine upgrade (no frozen identity, execution "
                                    "mode or feature set); create the experiment again")
        fs = db.get(FeatureSet, run.feature_set_id)
        if fs is None:
            raise PermanentJobError(f"feature set {run.feature_set_id} does not exist")
        manifest = dv.manifest_json
        spec = getattr(encoder, "spec", None) or encoder
        data_mode = manifest_data_mode(manifest)
        # Design §1 invariants 2 and 5, re-derived in the worker.
        problems = mode_problems(spec, data_mode, run.execution_mode)
        synthetic_now, _ = derive_synthetic(spec, data_mode)
        if synthetic_now != bool(run.synthetic):
            problems.append(f"synthetic re-derived as {synthetic_now} but the run says {bool(run.synthetic)}")
        if fs.execution_mode != run.execution_mode or fs.encoder_id != run.encoder_id:
            problems.append(f"the pinned feature set is {fs.encoder_id} in {fs.execution_mode}, the run is "
                            f"{run.encoder_id} in {run.execution_mode}")
        now = compute_run_identity(encoder=encoder, feature_set=fs, manifest=manifest, dataset_version_id=dv.id,
                                   params=run.params_json, seed=run.seed, head=run.head,
                                   execution_mode=run.execution_mode, evaluation_protocol=run.evaluation_protocol,
                                   label_scope=run.label_scope, positive_class=run.positive_class,
                                   negative_class=run.negative_class, synthetic=bool(run.synthetic))
        diff = identity_diff(run.identity_json, now)
        drift = code_tree_drift()
        if not drift["matches"]:
            diff.append({"field": "code_tree_drift", "frozen": drift["code_tree_sha256_at_start"],
                         "now": drift["code_tree_sha256_now"],
                         "changed": (drift["changed"] + drift["added"] + drift["removed"])[:20]})
        project_id = run.project_id
        run.status = "running"
        run.error = None
        run.started_at = run.started_at or utcnow()
    state["attempt_id"] = _open_attempt(run_id, project_id, ctx, now, diff)
    if problems:  # the more specific refusal first (a mode change usually also changes the identity)
        raise PermanentJobError("mode_mismatch: " + "; ".join(problems))
    if diff:
        raise RunIdentityChanged(diff)

    with session_scope() as db:
        run = db.get(TrainingRun, run_id)
        dv = db.get(DatasetVersion, run.dataset_version_id)
        manifest = dv.manifest_json
        protocol = run.evaluation_protocol
        train_items = training_eligible_items(db, dv, "train")
        val_items = training_eligible_items(db, dv, "validation")
        reference_standard = (manifest.get("config") or {}).get("reference_standard", "expert")
        _label_sources_ok(db, train_items + val_items, reference_standard)
        params, seed, head = dict(run.params_json), int(run.seed), run.head
        encoder_id, positive, label_scope = run.encoder_id, run.positive_class, run.label_scope
        manifest_sha, synthetic, fs_id = run.dataset_manifest_sha256, bool(run.synthetic), run.feature_set_id
        execution_mode, pinned_weights = run.execution_mode, run.weights_sha256
        identity = dict(run.identity_json)
    context = split_context(manifest, project_id)
    train_bags = build_bags(train_items, label_scope, positive)
    val_bags = build_bags(val_items, label_scope, positive)
    assert_no_test(train_bags, manifest, "training")
    assert_no_test(val_bags, manifest, "threshold selection")
    progress(0.02, f"{len(train_bags)} train bags, {len(val_bags)} validation bags ({protocol})")

    dev_slides = sorted({s for b in train_bags + val_bags for s in b.slide_ids})
    fs, fs_info = _ensure_feature_set(fs_id, dev_slides, ctx, progress.sub(0.02, 0.4))
    access = FeatureSetAccess(fs, expected_weights_sha256=pinned_weights or fs.weights_sha256)
    unscored: list[dict] = []
    t1 = time.perf_counter()
    fit_progress = progress.sub(0.4, 0.88)
    try:
        for sp, bags in (("train", train_bags), ("val", val_bags)):
            for b in bags:
                access.describe(b)
                if b.n_patches == 0:
                    unscored.append({"bag_id": b.bag_id, "split": sp, "reason": "no tissue patches in the feature set",
                                     "label": b.label, "patient_id": b.patient_id, "patient_code": b.patient_code})
        train_bags = [b for b in train_bags if b.n_patches > 0]
        val_bags = [b for b in val_bags if b.n_patches > 0]
        if protocol == "dev_cv":
            outcome = run_dev_cv(train_bags + val_bags, head=head, params=params, seed=seed, access=access,
                                 context=context, progress=fit_progress)
            dev_unscored = [u for u in unscored] + outcome.unscored
            for u in dev_unscored:
                u.setdefault("manifest_split", u.get("split"))
        else:
            outcome = run_holdout(train_bags, val_bags, head=head, params=params, seed=seed, access=access,
                                  context=context, progress=fit_progress)
            dev_unscored = [u for u in unscored if u["split"] == "val"]
    except (FloatingPointError, np.linalg.LinAlgError, ValueError) as exc:
        # Deterministic: the same data, params and seed would fail the same way on a retry.
        raise PermanentJobError(f"training failed: {type(exc).__name__}: {exc}") from exc
    except (FeatureError, ApiError) as exc:
        # A pinned artifact that is missing, corrupt or not built: never re-extracted here, never retried.
        raise PermanentJobError(f"feature_set_integrity: {type(exc).__name__}: {exc}") from exc
    training_seconds = time.perf_counter() - t1

    op = select_operating_point(outcome.dev, params, selected_on=outcome.dev_split)
    frozen_at = utcnow()
    dev_bag_ids = [sb.bag.bag_id for sb in outcome.dev]
    op["threshold"] = {**op["threshold"], "selected_on": outcome.dev_split, "frozen_at": frozen_at.isoformat(),
                       "protocol": protocol, "selected_on_bag_ids": dev_bag_ids,
                       **({"val_bag_ids": dev_bag_ids} if outcome.dev_split == "val" else {"oof_bag_ids": dev_bag_ids})}
    summary = development_summary(outcome.dev, dev_unscored, op, params, seed, split=outcome.dev_split,
                                   protocol=protocol)
    progress(0.9, f"threshold {op['threshold']['value']:.4f} frozen ({op['threshold']['rule']}, on "
                  f"{outcome.dev_split})")

    code = code_identity()
    meta = {**outcome.meta, "params": params, "seed": seed, "encoder_id": encoder_id,
            "encoder_spec_sha256": fs.encoder_spec_sha256, "weights_sha256": fs.weights_sha256,
            "feature_set_spec_sha256": fs.spec_sha256, "policy_sha256": fs.policy_sha256,
            "stain_policy_sha256": getattr(fs, "stain_policy_sha256", None),
            "extraction_env_sha256": getattr(fs, "extraction_env_sha256", None),
            "code": {"code_tree_sha256": code["code_tree_sha256"], "code_revision": identity.get("code_revision")},
            "deps": identity.get("deps"), "positive_class": positive, "negative_class": identity["negative_class"],
            "class_mapping": {"1": positive, "0": identity["negative_class"],
                              "note": "the negative class is BCC not identified, never 'benign'"},
            "label_scope": label_scope, "dataset_manifest_sha256": manifest_sha,
            "split_fingerprint": identity.get("split_fingerprint"), "execution_mode": execution_mode,
            "evaluation_protocol": protocol,
            "threshold": {"value": float(op["threshold"]["value"]), "rule": op["threshold"]["rule"],
                          "selected_on": outcome.dev_split,
                          "selection_status": op["threshold"].get("selection_status")},
            "calibration": op["calibration"], "calibration_selection": op["calibration_selection"],
            "abstention": op["abstention"], "decision_note": DECISION_NOTE,
            "synthetic": synthetic, "research_use_only": True}
    data = checkpoint_bytes(outcome.arrays, meta)
    store = get_store()
    ck_key, ck_sha = store.put_content_addressed(f"projects/{project_id}/checkpoints", data, ".npz")
    model = load_checkpoint(store.get_bytes(ck_key))  # scores below come from the stored object
    for sb in outcome.in_sample[:VERIFY_BAGS] + ([] if outcome.dev_split == "oof" else outcome.dev[:VERIFY_BAGS]):
        if model.score_bag(sb.bag, access)[0] != sb.score:
            raise RuntimeError("checkpoint round trip changed a score")
    progress(0.93, "checkpoint written (content-addressed) and verified; recording predictions")

    with session_scope() as db:
        qc = {sb.bag.bag_id: qc_context(db, sb.bag.slide_ids) for sb in outcome.dev + outcome.in_sample}

    with session_scope() as db:
        if ctx is not None:
            # Fence the domain commit: an attempt that lost its job lease must not record success.
            ctx.assert_lease(db)
        run = db.get(TrainingRun, run_id)
        if run.status == "succeeded":  # another attempt finished first
            return {"run_id": run_id, "status": "succeeded", "idempotent_replay": True}
        if run.weights_sha256 is not None and run.weights_sha256 != fs.weights_sha256:
            raise RunIdentityChanged([{"field": "weights_sha256", "frozen": run.weights_sha256,
                                       "now": fs.weights_sha256}])
        preds = (prediction_records(run, "train", outcome.in_sample, op, qc, access)
                 + prediction_records(run, outcome.dev_split, outcome.dev, op, qc, access))
        for p in preds:
            db.add(p)
        db.flush()
        run.threshold_value = float(op["threshold"]["value"])
        run.threshold_rule = op["threshold"]["rule"]
        run.threshold_frozen_at = frozen_at
        run.threshold_json = op["threshold"]
        run.calibration_json = op["calibration"]
        run.abstention_json = op["abstention"]
        run.checkpoint_key, run.checkpoint_sha256, run.checkpoint_bytes = ck_key, ck_sha, len(data)
        if run.weights_sha256 is None:
            run.weights_sha256 = fs.weights_sha256
        run.split_counts_json = split_counts(manifest, label_scope)
        dev_rows = [p for p in preds if p.split == outcome.dev_split]
        store_development_evaluation(db, run, outcome.dev_split, dev_rows, dev_unscored, summary)
        run.metrics_json = {
            "training": outcome.summary,
            "features": {"feature_set_id": fs.id, "feature_set_spec_sha256": fs.spec_sha256,
                         "encoder_id": encoder_id, "weights_sha256": fs.weights_sha256,
                         "slides": len(dev_slides), "patches": int(sum(b.n_patches for b in train_bags + val_bags)),
                         "reused_feature_set": not fs_info["built_inline"], "built_inline": fs_info["built_inline"],
                         "slide_loads": access.loads, "notice": encoder.notice if encoder.synthetic else None},
            "timings_seconds": {"feature_set": fs_info["seconds"], "training": round(training_seconds, 3),
                                "total": round(time.perf_counter() - t_start, 3)},
            "unscored_bags": unscored + [u for u in outcome.unscored if u not in unscored],
            f"{outcome.dev_split}_summary": summary,
            "effective_sampling": effective_sampling(outcome.fit_bags, params, outcome.summary),
            "protocol": {"evaluation_protocol": protocol, "development_split": outcome.dev_split,
                         "selected_on": outcome.dev_split, "cv": outcome.cv, "learning_curve": outcome.learning_curve,
                         "ordering": ORDERING_NOTE, "optimisation_budget": OPTIMISATION_BUDGETS.get(head),
                         "roles": _roles(protocol, head)},
            "operating_point": {"threshold": {k: v for k, v in op["threshold"].items()
                                              if not k.endswith("bag_ids")},
                                "calibration": op["calibration_selection"],
                                "abstention": {k: op["abstention"].get(k) for k in
                                               ("kind", "selection_status", "lower", "upper", "margin", "reason",
                                                "development", "policy_sha256")},
                                "decision_note": DECISION_NOTE},
            "in_sample_note": IN_SAMPLE_NOTE,
        }
        run.provenance_json = {"train_bag_ids": [b.bag_id for b in outcome.fit_bags],
                               "val_bag_ids": [b.bag_id for b in val_bags],
                               "development_bag_ids": dev_bag_ids, "feature_set_id": fs.id,
                               "feature_artifact_ids": sorted({a for b in train_bags + val_bags for a in b.artifact_ids
                                                               if a}),
                               "test_items_used": 0, "attempt_id": state["attempt_id"]}
        run.status = "succeeded"
        run.finished_at = utcnow()
        a = db.get(RunAttempt, state["attempt_id"])
        if a is not None and a.outcome is None:
            a.outcome, a.finished_at, a.weights_sha256 = "succeeded", utcnow(), fs.weights_sha256
            a.result_json = {"checkpoint_sha256": ck_sha, "threshold": run.threshold_value}
        audit.record(db, action="experiment.succeeded", entity_type="training_run", entity_id=run_id,
                     actor_id=audit.SYSTEM_WORKER, actor_role="system", project_id=project_id,
                     after={"head": head, "encoder_id": encoder_id, "checkpoint_sha256": ck_sha,
                            "threshold": run.threshold_value, "threshold_rule": run.threshold_rule,
                            "selected_on": outcome.dev_split, "protocol": protocol, "synthetic": synthetic,
                            "feature_set_id": fs.id, "identity_sha256": run.identity_sha256})
    return {"run_id": run_id, "status": "succeeded", "checkpoint_sha256": ck_sha, "threshold": run_threshold(op),
            "train_bags": len(outcome.fit_bags), f"{outcome.dev_split}_bags": len(outcome.dev)}


def run_threshold(op: dict) -> float:
    return float(op["threshold"]["value"])


def _roles(protocol: str, head: str) -> dict:
    stop = ("inner patient-grouped stratified hold-out of the training patients" if head == "abmil"
            else "not applicable (convex fit)")
    if protocol == "dev_cv":
        return {"fitting": "each fold's fitting part; final model on the whole development pool (train ∪ val)",
                "early_stopping": stop + " (inside each fitting part)",
                "threshold": "out-of-fold predictions", "calibration": "out-of-fold predictions",
                "abstention": "out-of-fold predictions", "test": "untouched (test release only)"}
    return {"fitting": "train", "early_stopping": stop + "; never validation", "threshold": "validation",
            "calibration": "validation", "abstention": "validation", "test": "untouched (test release only)"}


def store_development_evaluation(db, run: TrainingRun, split: str, rows: list[Prediction], unscored: list[dict],
                                 summary: dict) -> Evaluation:
    """The stored development evaluation (``val`` for holdout, ``oof`` for dev_cv). The body
    comes from :func:`dermpath.ml.evaluation.build_evaluation` (same shape as other splits),
    flagged as a tuning set, with the development summary attached."""
    from .evaluation import build_evaluation  # local: evaluation imports this module

    rows_unscored = [{"bag_id": u["bag_id"], "split": split, "manifest_split": u.get("manifest_split", u.get("split")),
                      "reason": u.get("reason"), "coded_patient_id": u.get("patient_id"),
                      **({"label_value": run.positive_class if u["label"] == 1 else run.negative_class}
                         if "label" in u else {})} for u in unscored]
    body = build_evaluation(run, split, rows, rows_unscored)
    body.update({"protocol": run.evaluation_protocol, "threshold_selected_on": split,
                 "development_summary": summary})
    ev = Evaluation(run_id=run.id, project_id=run.project_id, split=split, metrics_json=body,
                    threshold=float(run.threshold_value), threshold_frozen_from=split,
                    threshold_frozen_at=run.threshold_frozen_at, computed_by=audit.SYSTEM_WORKER)
    db.add(ev)
    db.flush()
    return ev


# --------------------------------------------------------------------------- scoring with a frozen run


def load_run_model(run: TrainingRun) -> LoadedModel:
    """The run's checkpoint, verified against the recorded sha256 and the frozen operating point."""
    data = get_store().get_bytes(run.checkpoint_key)
    if sha256_hex(data) != run.checkpoint_sha256:
        raise PermanentJobError("checkpoint sha256 mismatch: refusing to score with a modified checkpoint")
    model = load_checkpoint(data)
    thr = (model.meta.get("threshold") or {}).get("value")
    if thr is not None and run.threshold_value is not None and float(thr) != float(run.threshold_value):
        raise PermanentJobError("the checkpoint's frozen threshold differs from the run's")
    return model


def checkpoint_operating_point(run: TrainingRun, model: LoadedModel) -> dict:
    meta = model.meta
    if meta.get("calibration") is not None and meta.get("abstention") is not None:
        return {"threshold": {**(run.threshold_json or {}), "value": float(meta["threshold"]["value"])},
                "calibration": meta["calibration"], "abstention": meta["abstention"]}
    return run_operating_point(run)  # legacy checkpoint


def run_feature_access(run: TrainingRun) -> FeatureSetAccess:
    with session_scope() as db:
        fs = db.get(FeatureSet, run.feature_set_id) if run.feature_set_id else None
        if fs is None:
            raise PermanentJobError("the run has no pinned feature set")
        db.expunge(fs)
    return FeatureSetAccess(fs, expected_weights_sha256=run.weights_sha256 or fs.weights_sha256)


def score_bags_with_checkpoint(run: TrainingRun, bags: list[Bag], *, access: EmbeddingAccess | None = None,
                               with_attention: bool = False) -> list[tuple]:
    """Score ``bags`` with the run's verified checkpoint and frozen operating point.

    Returns ``[(bag, score, calibrated_score, predicted, abstained)]`` in the given order
    (plus ``attention`` when ``with_attention``). Embeddings come from the run's PINNED feature
    set unless ``access`` is given (inference bundles pass their own). An unscorable bag (no
    patches) is kept with ``score``, ``calibrated_score`` and ``predicted`` set to ``None`` and
    ``abstained`` False, so callers count it. Decisions use the raw score
    (:data:`DECISION_NOTE`)."""
    model = load_run_model(run)
    op = checkpoint_operating_point(run, model)
    if access is None:
        # Bags whose embeddings the caller attached (from the pinned artifacts) are scored in
        # memory; otherwise they are read lazily from the run's pinned feature set.
        access = IN_MEMORY if bags and all(b.embeddings is not None for b in bags) else run_feature_access(run)
    out = []
    for b in bags:
        if isinstance(access, FeatureSetAccess):
            access.describe(b)
        if b.n_patches == 0:
            row = (b, None, None, None, False)
            out.append(row + (None,) if with_attention else row)
            continue
        s, att = model.score_bag(b, access)
        cal, pred, abst = apply_operating_point([s], op)
        row = (b, float(s), float(cal[0]), int(pred[0]), bool(abst[0]))
        if with_attention:
            if att is not None and isinstance(access, FeatureSetAccess):
                access.attach_coords(b)
            row = row + (att,)
        out.append(row)
    return out
