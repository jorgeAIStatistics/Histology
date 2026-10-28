"""Feature sets: frozen, immutable specifications of how embeddings are produced (design §5).

Research use only. A feature set pins, for a list of slides, everything that decides the
embeddings: the encoder (spec sha, weights sha, and for ``hf_dir`` encoders the config
sha), the patch / sampling / stain policies, the extraction environment (library versions,
device class, precision), the extraction parameters (pixel mode, batch size, CPU threads)
and a per-slide **input snapshot**. Experiments, test releases and inference read only its
pinned artifacts (:func:`load_slide_features`).

Creation (:func:`create_feature_set`)
-------------------------------------
* Execution modes (design §1) are checked first and raise :class:`ModeMismatch`
  (409 ``mode_mismatch``): the synthetic encoder only in ``synthetic_pipeline_test`` on
  synthetic data (every slide ``demo_synthetic`` + ``synthetic_tiles``) and that mode only
  with the synthetic encoder; ``real_image_technical`` needs a pixel-reading encoder and
  real slides; ``supervised_experiment`` needs a frozen dataset whose ``data_mode`` is
  ``real`` and calibrated slides (``allow_uncalibrated`` is refused there). The same checks
  run again in the worker before anything is extracted.
* The encoder must be ``available`` (:class:`~dermpath.ml.encoders.EncoderUnavailable`).
  Its weights identity is resolved once: the synthetic marker, the handcrafted code
  identity, or a streaming sha256 of the weights file (no model is loaded in the API).
* :func:`policies_from_params` maps experiment params onto ``PatchPolicy`` /
  ``SamplingPolicy`` / ``StainPolicy``. Every slide's scale is planned at creation, so a
  slide that cannot be read at the policy's physical scale is refused before any build
  (422 ``scale_refused``).
* Input snapshot per slide: slide sha256 and object key, mpp, dimensions, level
  downsamples, image kind and provenance, the QC review id, mask object key / sha256 /
  downsample, and the excluded regions (issue ids, geometry and their sha256, defined as in
  :func:`dermpath.datasets.qc_snapshot`). For a dataset version the QC state is the one the
  frozen manifest recorded (verified against the stored objects; a changed mask or region
  refuses with 409 ``input_changed``); for explicit slides it is the live QC state at
  creation. Labels are never part of a snapshot.
* ``spec_sha256`` covers every specification column; creation is idempotent per
  ``(project, spec_sha256)``: the same request returns the existing set.

Build (:func:`build_feature_set`, job ``build_feature_set``)
------------------------------------------------------------
Resumable (done slides are skipped), cancellable (between batches), fenced
(``ctx.assert_lease`` in every domain commit) and idempotent per (feature set, slide). It
extracts **every** slide of the set, test slides included, WITHOUT reading any label. The
only exception is ``synthetic_pipeline_test``, where :func:`_fixture_labels` derives the
fixture labels from the frozen manifest and they reach embeddings only through
:func:`dermpath.ml.fixture.fixture_context`. For ``macenko-v1`` the stain reference is fitted
first, on train-split slides of the dataset only, and stored with the set
(``stain_reference_key`` / ``stain_reference_sha256``). It is ONE reference per set, shared by
every model trained on it, so it is learned preprocessing that is not fold-specific
(:func:`learned_preprocessing`): ``dev_cv`` and learning-curve runs on such a set are refused
(``fold_unsafe_preprocessing``, :func:`dermpath.ml.training.preprocessing_fold_safety`), while
``holdout`` runs verify that its slides are training material. The set becomes ``ready`` in a
transaction after its items. On a ready set the build is a repair pass: an artifact whose
objects are missing or corrupt is re-extracted into a new generation row.

Extraction (:func:`extract_slide`, bounded memory)
--------------------------------------------------
Inputs come only from the snapshot and are verified first: the slide file's sha256 is
streamed once per process per slide (memo keyed by object key, size, mtime_ns, inode and
ctime_ns), the mask object's sha256 is checked, and a mismatch raises
``FeatureError("input_changed: ...")``. Then ``plan_scale(policy=)`` → ``candidate_grid``
→ ``sampling.select_indices`` → ``iter_patch_batches`` (one batch in memory) →
``stain.normalise`` → ``LoadedEncoder.embed_batch`` (patches at exactly ``input_size``; the
loaded weights sha must equal the set's before anything is written) → rows streamed into a
memory-mapped ``.npy``. Embeddings (``.npy`` float32, memory-mappable) and coords + patch
quality + deterministic metadata (``.npz``) are stored content-addressed and write-once.
The :class:`~dermpath.ml.models.FeatureArtifact` cache key covers slide sha, encoder spec,
weights (and config) sha, policy sha, effective stain policy sha (reference included),
mask sha, excluded-regions sha, sampled-coordinates sha, extraction environment sha and the
extraction parameters (plus the fixture label and seed in the synthetic pipeline test). A
row whose objects are missing or corrupt is never served; a new generation is written.

Per-slide stats: read / preprocess / embed / write seconds, patches per second, peak RSS
and its delta (``resource.getrusage``), cache hit, patches rejected at read by reason, and
coverage (:func:`dermpath.ml.coverage.coverage` on the patches actually embedded).
"""

from __future__ import annotations

import hashlib
import json
import logging
import math
import os
import sys
import tempfile
import threading
import time
from collections import OrderedDict
from collections.abc import Iterable
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
from sqlalchemy import inspect as sa_inspect
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from .. import audit
from ..config import get_settings
from ..db import session_scope, utcnow
from ..errors import ApiError, conflict, not_found, unprocessable
from ..jobs import queue
from ..jobs.registry import JobContext, PermanentJobError, refuse_label_payload, register, register_settle_hook
from ..models import DatasetVersion, ImmutableRecordError, Job, Project, QCIssue, QCReview, Slide
from ..qc import tissue as qc_tissue
from ..slides import reader as slide_reader
from ..slides.synthetic import spec_sha256 as synthetic_spec_sha256
from ..storage import StoreError, get_store
from . import PIPELINE_TEST_BANNER, devices, fixture
from . import stain as stainlib
from .artifacts import canonical_json, extraction_env, load_npz, npz_bytes, sha256_hex
from .coverage import COVERAGE_VERSION
from .coverage import coverage as coverage_of
from .encoders import (
    SYNTHETIC_WEIGHTS_MARKER,
    EncoderIdentityMismatch,
    EncoderSpec,
    EncoderUnavailable,
    LoadedEncoder,
    get_encoder,
)
from .engine_models import EXECUTION_MODES, FeatureSet, FeatureSetItem, FeatureSetValidation
from .features import FeatureError
from .fixture import SyntheticSignalForbidden
from .models import FeatureArtifact
from .patching import (
    FALLBACK_MASK_SIZE,
    PATCHING_VERSION_V2,
    QUALITY_VERSION,
    Candidates,
    PatchPlan,
    PatchPolicy,
    ReadTally,
    ScaleError,
    candidate_grid,
    iter_patch_batches,
    mask_from_png,
    otsu_mask,
    plan_scale,
)
from .sampling import SAMPLING_VERSION, SamplingError, SamplingPolicy, seeded_ranks, select_indices

log = logging.getLogger("dermpath.ml.feature_sets")

BUILD_JOB = "build_feature_set"
VALIDATE_JOB = "validate_feature_set"
FEATURE_SET_SCHEMA = "dermpath.feature_set/1"
SNAPSHOT_SCHEMA = "dermpath.feature_input_snapshot/1"
ARTIFACT_SCHEMA = "dermpath.features/2"
VALIDATION_SCHEMA = "dermpath.feature_set_validation/1"
#: Bump on any change in this module that alters embeddings, coordinates or stored bytes.
#: /2 (engine verification round): the read footprint is the plan extent, exclusions use the nonzero winding rule and
#: the pixel-centre raster, rescued fragments are kept by sampling and may shift away from an exclusion, and the
#: embedding sink trims exactly after read-time rejections. Sets and bundles pinned to /1 refuse to extract with /2.
EXTRACTOR_VERSION = "dermpath.feature_sets/2"

SYNTHETIC_MODE, TECHNICAL_MODE, SUPERVISED_MODE = EXECUTION_MODES
BATCH_SIZE_ENV = "WB_ML_BATCH_SIZE"
DEFAULT_BATCH_SIZE = 32
#: Grid extent for encoders that read no pixels (the synthetic fixture); the legacy default.
PIXEL_FREE_PATCH_SIZE = 224
DEFAULT_TARGET_MPP = 0.5
DEFAULT_MIN_TISSUE = 0.25
DEFAULT_MAX_PATCHES = 64
DEFAULT_FRAGMENT_RESCUE_UM2 = 2000.0
#: A slide is "below the coverage floor" when less than this fraction of its eligible tissue
#: lies within one patch side of an embedded patch. Research default, not tuned.
COVERAGE_FLOOR = 0.5
COVERAGE_FLOOR_METRIC = "tissue_within_radius_of_sample_fraction"
# macenko-v1 reference fit (train-split slides only) and per-slide source estimate.
STAIN_REFERENCE_PATCHES_PER_SLIDE = 8
STAIN_REFERENCE_MAX_SLIDES = 32
STAIN_SOURCE_PATCHES = 16
PROGRESS_INTERVAL_SECONDS = 2.0
#: Determinism tolerance of the technical validation: numpy encoders must be bit-identical.
EXACT_KINDS = ("synthetic", "handcrafted")
TORCH_MAX_ABS_TOL = 1e-4
TORCH_COSINE_MIN = 0.9999
QUALITY_KEYS = ("tissue_fraction", "pen_fraction", "pen_blue_fraction", "pen_green_fraction", "pen_black_fraction",
                "laplacian_variance", "mean_rgb")
PARAM_KEYS = ("patch_size", "target_mpp", "min_tissue_fraction", "max_patches_per_slide", "sampling_strategy",
              "sampling_seed", "stain_normalization", "stain_source_estimate", "edge_mode",
              "fragment_rescue_min_area_um2", "allow_uncalibrated", "fallback_downsample", "pixel_mode", "device",
              "precision")
NOT_A_LABEL_NOTE = ("Feature sets never read labels (synthetic_pipeline_test fixture labels excepted, through "
                    "dermpath.ml.fixture). Test-split slides are extracted like every other slide.")


# --------------------------------------------------------------------------- errors


class ModeMismatch(ApiError):
    """Encoder, data and execution mode are incompatible (design §1). HTTP 409 ``mode_mismatch``."""

    def __init__(self, message: str, **details) -> None:
        super().__init__(409, "mode_mismatch", message, **details)


class FeatureSetNotReady(ApiError):
    """Slides of a feature set are not built yet. HTTP 409 ``feature_set_not_ready``; ``missing`` lists them."""

    def __init__(self, missing, *, feature_set_id: str | None = None, status: str | None = None) -> None:
        self.missing = list(missing)
        self.feature_set_id = feature_set_id
        self.feature_set_status = status
        super().__init__(409, "feature_set_not_ready",
                         f"Feature set {feature_set_id} is {status}; {len(self.missing)} slide(s) not built",
                         feature_set_id=feature_set_id, status=status, missing=self.missing[:100],
                         n_missing=len(self.missing))


class FeatureSetIntegrityError(FeatureError):
    """A stored artifact does not match the feature set's identity or its own sha256s."""


class InvalidFeatureParams(ApiError):
    def __init__(self, errors: list[dict]) -> None:
        self.errors = errors
        super().__init__(422, "invalid_params", "Invalid feature-generation parameters", errors=errors)


def _input_changed(detail: str) -> FeatureError:
    return FeatureError(f"input_changed: {detail}")


#: Prefix of the extraction error raised when the slide's ingest state moved after the snapshot (a re-ingest in
#: flight). That state is not part of any input snapshot, so it is TRANSIENT: a build records it as an item failure
#: (retried by the next build), inference never records it as the outcome of a snapshot (it retries the job).
NOT_INGESTED = "slide_not_ingested"


def _not_ingested(slide_id: str, status: str | None) -> FeatureError:
    return FeatureError(f"{NOT_INGESTED}: slide {slide_id} is not ingested ({status}); its ingest state moved after "
                        "the input snapshot (a re-ingest in progress?)")


# --------------------------------------------------------------------------- small helpers


def _jsonable(obj):
    """Plain JSON types (numpy scalars/arrays and tuples converted) for canonical hashing."""
    if isinstance(obj, dict):
        return {str(k): _jsonable(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_jsonable(v) for v in obj]
    if isinstance(obj, np.ndarray):
        return _jsonable(obj.tolist())
    if isinstance(obj, np.bool_):
        return bool(obj)
    if isinstance(obj, np.integer):
        return int(obj)
    if isinstance(obj, np.floating):
        v = float(obj)
        return v if math.isfinite(v) else None
    if isinstance(obj, float) and not math.isfinite(obj):
        return None
    return obj


def _sha_json(obj) -> str:
    return sha256_hex(canonical_json(_jsonable(obj)))


def _fs_id(fs) -> str:
    if isinstance(fs, str):
        return fs
    ident = sa_inspect(fs).identity
    return ident[0] if ident else fs.id


def _peak_rss_bytes() -> int | None:
    """Peak resident set size of this process (``ru_maxrss``: bytes on macOS, KiB on Linux)."""
    try:
        import resource
    except ImportError:  # pragma: no cover - Windows
        return None
    peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return int(peak if sys.platform == "darwin" else peak * 1024)


def _batch_size() -> int:
    raw = os.environ.get(BATCH_SIZE_ENV, "").strip()
    try:
        value = int(raw) if raw else DEFAULT_BATCH_SIZE
    except ValueError as exc:
        raise InvalidFeatureParams([{"loc": [BATCH_SIZE_ENV], "msg": f"not an integer: {raw!r}"}]) from exc
    if not 1 <= value <= 4096:
        raise InvalidFeatureParams([{"loc": [BATCH_SIZE_ENV], "msg": "must be in [1, 4096]"}])
    return value


def _valid_mpp(v) -> bool:
    try:
        return v is not None and math.isfinite(float(v)) and float(v) > 0
    except (TypeError, ValueError):
        return False


def _tmp_root() -> Path:
    root = get_settings().cache_dir / "feature-tmp"
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    return root


# --------------------------------------------------------------------------- object sha memo

_SHA_MEMO: OrderedDict[tuple, str] = OrderedDict()
_SHA_MEMO_MAX = 50_000
_SHA_LOCK = threading.Lock()


def _stat_key(key: str) -> tuple[Path, tuple]:
    path = get_store().local_path(key)
    st = path.stat()
    return path, (key, st.st_size, st.st_mtime_ns, st.st_ino, st.st_ctime_ns)


def _memo_put(mk: tuple, digest: str) -> None:
    with _SHA_LOCK:
        _SHA_MEMO[mk] = digest
        _SHA_MEMO.move_to_end(mk)
        while len(_SHA_MEMO) > _SHA_MEMO_MAX:
            _SHA_MEMO.popitem(last=False)


def object_sha256(key: str) -> str:
    """sha256 of a stored object, streamed once per process per (key, size, mtime_ns, inode, ctime_ns).

    Raises ``FileNotFoundError`` / :class:`~dermpath.storage.StoreError` when the object is missing."""
    path, mk = _stat_key(key)
    with _SHA_LOCK:
        hit = _SHA_MEMO.get(mk)
    if hit is not None:
        return hit
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for block in iter(lambda: fh.read(4 * 1024 * 1024), b""):
            h.update(block)
    digest = h.hexdigest()
    try:
        if _stat_key(key)[1] == mk:  # unchanged while hashing
            _memo_put(mk, digest)
    except (OSError, StoreError):
        pass
    return digest


def _remember_sha(key: str, digest: str) -> None:
    """Record the sha of an object this process just wrote content-addressed (its name is its sha)."""
    try:
        _memo_put(_stat_key(key)[1], digest)
    except (OSError, StoreError):  # pragma: no cover - the object was just written
        pass


def clear_sha_memo() -> None:
    """Forget every memoised object sha (tests)."""
    with _SHA_LOCK:
        _SHA_MEMO.clear()


def _object_ok(key: str | None, sha: str | None) -> bool:
    if not key or not sha:
        return False
    try:
        return object_sha256(key) == sha
    except (OSError, StoreError):
        return False


# --------------------------------------------------------------------------- policies


@dataclass(frozen=True)
class DeferredMacenkoPolicy(stainlib.StainPolicy):
    """``macenko-v1`` whose reference is fitted during the build, on train-split slides only.

    A :class:`~dermpath.ml.stain.StainPolicy` (so it hashes and serialises like one), but it
    cannot normalise anything until :meth:`resolve` gives it the fitted reference. ``fit``
    records how the reference is fitted (train slide ids, patches per slide, seed, params).
    """

    fit: dict = field(default_factory=dict)

    def __post_init__(self):
        if self.method != stainlib.MACENKO_VERSION:
            raise stainlib.StainError("unknown_method", f"deferred policy is macenko-v1 only, not {self.method!r}")
        if self.source_estimate not in stainlib.SOURCE_ESTIMATES:
            raise stainlib.StainError("bad_source_estimate", f"{self.source_estimate!r}")
        if self.reference is not None:
            raise stainlib.StainError("reference_unused", "a deferred policy has no reference yet")

    def to_json(self) -> dict:
        return {"version": stainlib.STAIN_VERSION, "method": self.method, "reference": None, "reference_sha256": None,
                "source_estimate": self.source_estimate, "deferred": True, "reference_fit": _jsonable(dict(self.fit))}

    def resolve(self, reference: stainlib.MacenkoReference) -> stainlib.StainPolicy:
        return stainlib.StainPolicy.macenko(reference, source_estimate=self.source_estimate)


def _param(params: dict, key: str, default):
    value = params.get(key)
    return default if value is None else value


def policies_from_params(params: dict | None, encoder_spec: EncoderSpec, execution_mode: str, *,
                         stain_reference: stainlib.MacenkoReference | None = None,
                         stain_fit: dict | None = None) -> tuple[PatchPolicy, SamplingPolicy, stainlib.StainPolicy]:
    """Map experiment params (``ExperimentParams`` names) onto the three extraction policies.

    * ``patch_size``: None → the encoder's ``input_size``; any other value must equal it
      (encoders never resize). Encoders that read no pixels use :data:`PIXEL_FREE_PATCH_SIZE`.
    * ``target_mpp`` (0.5), ``min_tissue_fraction`` (0.25), ``edge_mode`` (shift_inward),
      ``fragment_rescue_min_area_um2`` (2000; 0 or None switches rescue off),
      ``fallback_downsample`` → ``uncalibrated_downsample`` (4).
    * ``max_patches_per_slide`` (64), ``sampling_strategy`` (``spatial`` | ``uniform`` |
      ``all``; ``lesion_aware`` is refused: feature sets never receive permitted regions),
      ``sampling_seed`` (0, independent of any training seed).
    * ``allow_uncalibrated``: forced True in ``synthetic_pipeline_test``; refused in
      ``supervised_experiment``.
    * ``stain_normalization``: ``none`` | ``macenko-v1`` (``stain_source_estimate``
      ``per_slide`` default). Without ``stain_reference`` macenko returns a
      :class:`DeferredMacenkoPolicy` (reference fitted at build on train slides only).

    Unknown keys (head and protocol params) are ignored. Raises :class:`InvalidFeatureParams`.
    """
    p = dict(params or {})
    errors: list[dict] = []
    reads = bool(encoder_spec.reads_pixels)
    raw_ps = p.get("patch_size")
    if reads:
        patch_size = int(encoder_spec.input_size)
        if raw_ps is not None and int(raw_ps) != patch_size:
            errors.append({"loc": ["patch_size"], "msg": f"patch_size {raw_ps} must equal the encoder input_size "
                                                         f"{patch_size} (encoders never resize)"})
    else:
        patch_size = int(raw_ps) if raw_ps is not None else PIXEL_FREE_PATCH_SIZE
    pixel_mode = _param(p, "pixel_mode", "read")
    if pixel_mode not in ("read", "none"):
        errors.append({"loc": ["pixel_mode"], "msg": "pixel_mode must be 'read' or 'none'"})
    elif pixel_mode == "none" and reads:
        errors.append({"loc": ["pixel_mode"], "msg": f"{encoder_spec.id} reads pixels; pixel_mode 'none' is only for "
                                                     "the synthetic encoder"})
    allow_uncal = bool(_param(p, "allow_uncalibrated", False))
    if execution_mode == SYNTHETIC_MODE:
        allow_uncal = True
    elif execution_mode == SUPERVISED_MODE and allow_uncal:
        errors.append({"loc": ["allow_uncalibrated"], "msg": "supervised_experiment needs calibrated slides; "
                                                             "allow_uncalibrated is refused"})
        allow_uncal = False
    strategy = _param(p, "sampling_strategy", "spatial")
    if strategy == "lesion_aware":
        errors.append({"loc": ["sampling_strategy"], "msg": "lesion_aware sampling needs permitted expert regions on "
                                                            "train-split slides; feature sets never receive them"})
        strategy = "spatial"
    frag = p.get("fragment_rescue_min_area_um2", DEFAULT_FRAGMENT_RESCUE_UM2)
    if frag is not None and float(frag) <= 0:
        frag = None  # 0 switches fragment rescue off
    sampling = None
    try:
        sampling = SamplingPolicy(strategy=strategy,
                                  max_patches=None if strategy == "all" else int(_param(p, "max_patches_per_slide",
                                                                                        DEFAULT_MAX_PATCHES)),
                                  seed=int(_param(p, "sampling_seed", 0)))
    except (SamplingError, TypeError, ValueError) as exc:
        errors.append({"loc": ["sampling_strategy"], "msg": str(exc)})
    patch = None
    if sampling is not None:
        try:
            patch = PatchPolicy(target_mpp=float(_param(p, "target_mpp", DEFAULT_TARGET_MPP)), patch_size=patch_size,
                                min_tissue_fraction=float(_param(p, "min_tissue_fraction", DEFAULT_MIN_TISSUE)),
                                edge_mode=str(_param(p, "edge_mode", "shift_inward")),
                                fragment_rescue_min_area_um2=None if frag is None else float(frag),
                                allow_uncalibrated=allow_uncal,
                                uncalibrated_downsample=float(_param(p, "fallback_downsample", 4.0)),
                                sampling=sampling)
        except (TypeError, ValueError) as exc:
            errors.append({"loc": ["patch_policy"], "msg": str(exc)})
    method = _param(p, "stain_normalization", "none")
    source_estimate = _param(p, "stain_source_estimate", "per_slide")
    stain_policy = None
    try:
        if method == "none":
            stain_policy = stainlib.StainPolicy.none()
        elif method == stainlib.MACENKO_VERSION:
            if not reads:
                errors.append({"loc": ["stain_normalization"], "msg": f"{encoder_spec.id} reads no pixels; stain "
                                                                      "normalisation does not apply"})
            elif stain_reference is not None:
                stain_policy = stainlib.StainPolicy.macenko(stain_reference, source_estimate=source_estimate)
            else:
                stain_policy = DeferredMacenkoPolicy(method=stainlib.MACENKO_VERSION, source_estimate=source_estimate,
                                                     fit=dict(stain_fit or {}))
        else:
            errors.append({"loc": ["stain_normalization"], "msg": f"unknown stain normalisation {method!r} "
                                                                  f"(none | {stainlib.MACENKO_VERSION})"})
    except stainlib.StainError as exc:
        errors.append({"loc": ["stain_normalization"], "msg": str(exc)})
    if errors:
        raise InvalidFeatureParams(errors)
    return patch, sampling, stain_policy


def _stain_from_json(data: dict) -> stainlib.StainPolicy:
    if data.get("deferred"):
        return DeferredMacenkoPolicy(method=data["method"], source_estimate=data.get("source_estimate", "per_slide"),
                                     fit=dict(data.get("reference_fit") or {}))
    return stainlib.StainPolicy.from_json(data)


#: Provenance categories of LEARNED (data-fitted) preprocessing. ``dataset_fitted_train_split``: the macenko-v1
#: reference fitted at build time on train-split slides of the set's dataset version (the only one implemented; one
#: reference per feature set, shared by every model trained on it). An independently fixed external reference would
#: be a separate category; it is not implemented. Anything else that is learned has unknown provenance and is treated
#: as dataset-fitted (fail closed).
LEARNED_PREPROCESSING_PROVENANCES = ("dataset_fitted_train_split", "unknown_treated_as_dataset_fitted")


def learned_preprocessing(stain_policy_json: dict | None) -> dict:
    """What a feature set's stain policy (its ``stain_policy_json``, the declared plan) fits on data.

    ``none`` fits nothing. Fixed-encoder extraction is never learned preprocessing: it is label-free and fitted on
    nothing, so extracting every slide (evaluation slides included) is allowed. ``macenko-v1`` fits ONE reference per
    set on train-split slides (``reference_fit.train_slide_ids``), which is not fold-specific: see
    :func:`dermpath.ml.training.preprocessing_fold_safety`."""
    sp = dict(stain_policy_json or {})
    method = sp.get("method") or "none"
    if method == "none":
        return {"learned": False, "kind": "none", "method": "none", "provenance": "none", "fitted_on_slide_ids": []}
    fit = dict(sp.get("reference_fit") or {})
    if sp.get("deferred") or fit:
        return {"learned": True, "kind": "stain_reference", "method": method,
                "provenance": LEARNED_PREPROCESSING_PROVENANCES[0],
                "fitted_on": fit.get("fitted_on") or "train-split slides of the dataset version",
                "dataset_version_id": fit.get("dataset_version_id"),
                "fitted_on_slide_ids": sorted(fit.get("train_slide_ids") or []),
                "selection_key": fit.get("selection_key"), "shared_by_every_model_on_the_set": True}
    return {"learned": True, "kind": "stain_reference", "method": method,
            "provenance": LEARNED_PREPROCESSING_PROVENANCES[1], "fitted_on_slide_ids": [],
            "shared_by_every_model_on_the_set": True}


# --------------------------------------------------------------------------- input snapshot


def _mask_downsample(review: QCReview | None) -> list[float] | None:
    if review is None:
        return None
    t = (review.metrics_json or {}).get("tissue") or {}
    try:
        ds = (float(t.get("mask_downsample_x") or 0), float(t.get("mask_downsample_y") or 0))
    except (TypeError, ValueError):
        return None
    return [ds[0], ds[1]] if ds[0] > 0 and ds[1] > 0 else None


def _regions_for(db: Session, issue_ids: list[str]) -> tuple[list[dict], list[str]]:
    rows = {r.id: r for r in db.scalars(select(QCIssue).where(QCIssue.id.in_(list(issue_ids)))).all()} \
        if issue_ids else {}
    regions = [{"issue_id": i, "category": rows[i].category, "region": rows[i].region_json}
               for i in sorted(issue_ids) if i in rows]
    return regions, sorted(i for i in issue_ids if i not in rows)


def live_qc(db: Session, slide_id: str) -> dict:
    """The QC inputs of a slide as of now, with the same definitions as
    :func:`dermpath.datasets.qc_snapshot` (latest automated screen with a mask; resolved
    exclude_region issues sorted by id, sha256 over their canonical JSON), plus the mask
    downsample and the region geometry."""
    review = db.scalars(select(QCReview).where(QCReview.slide_id == slide_id, QCReview.kind == "automated_screen",
                                               QCReview.mask_object_key.is_not(None))
                        .order_by(QCReview.created_at.desc(), QCReview.id.desc())).first()
    mask_sha = None
    if review is not None:
        try:
            mask_sha = get_store().sha256(review.mask_object_key)
        except (FileNotFoundError, OSError, StoreError):
            mask_sha = None
    ds = _mask_downsample(review)
    issues = db.scalars(select(QCIssue).where(QCIssue.slide_id == slide_id, QCIssue.status == "resolved",
                                              QCIssue.dataset_eligibility_effect == "exclude_region")
                        .order_by(QCIssue.id)).all()
    regions = [{"issue_id": i.id, "category": i.category, "region": i.region_json} for i in issues]
    usable = review is not None and mask_sha is not None and ds is not None
    return {"qc_review_id": review.id if review else None,
            "mask_object_key": review.mask_object_key if usable else None,
            "mask_sha256": mask_sha if usable else None, "mask_downsample": ds if usable else None,
            "excluded_issue_ids": [r["issue_id"] for r in regions], "excluded_regions": regions,
            "excluded_regions_sha256": _sha_json(regions), "qc_source": "live_qc_at_creation"}


def _manifest_qc(db: Session, item: dict) -> tuple[dict | None, list[str]]:
    """The QC state the frozen manifest recorded for one item (None for a legacy manifest)."""
    if "mask_sha256" not in item and "excluded_regions_sha256" not in item:
        return None, []
    problems: list[str] = []
    review_id, mask_key, mask_sha = item.get("qc_review_id"), item.get("mask_object_key"), item.get("mask_sha256")
    ds = None
    if mask_key and mask_sha:
        review = db.get(QCReview, review_id) if review_id else None
        ds = _mask_downsample(review)
        if review is None or review.mask_object_key != mask_key or ds is None:
            problems.append(f"QC review {review_id} of the manifest's mask is missing or has no mask downsample")
        else:
            try:
                now = get_store().sha256(mask_key)
            except (FileNotFoundError, OSError, StoreError):
                now = None
            if now != mask_sha:
                problems.append(f"mask object {mask_key} no longer has the manifest's sha256")
    else:
        mask_key = mask_sha = None  # no usable mask at freeze: the Otsu fallback applies
    ids = list(item.get("excluded_region_issue_ids") or [])
    regions, missing = _regions_for(db, ids)
    sha = _sha_json(regions)
    if missing:
        problems.append(f"excluded-region issues {missing} no longer exist")
    elif sha != item.get("excluded_regions_sha256"):
        problems.append("excluded-region geometry changed since the dataset was frozen")
    return {"qc_review_id": review_id, "mask_object_key": mask_key, "mask_sha256": mask_sha,
            "mask_downsample": ds if mask_key else None, "excluded_issue_ids": [r["issue_id"] for r in regions],
            "excluded_regions": regions, "excluded_regions_sha256": sha, "qc_source": "dataset_manifest"}, problems


def slide_snapshot(slide: Slide, qc: dict) -> dict:
    """The frozen per-slide inputs of extraction (design §5). Never holds a label."""
    return _jsonable({
        "slide_id": slide.id, "slide_sha256": slide.sha256, "object_key": slide.object_key,
        "image_kind": slide.image_kind, "provenance": slide.provenance, "format": slide.format,
        "mpp_x": slide.mpp_x, "mpp_y": slide.mpp_y, "width": slide.width, "height": slide.height,
        "level_downsamples": list(slide.level_downsamples_json or [1.0]),
        "calibrated": _valid_mpp(slide.mpp_x) and _valid_mpp(slide.mpp_y),
        "qc_review_id": qc["qc_review_id"], "mask_object_key": qc["mask_object_key"],
        "mask_sha256": qc["mask_sha256"], "mask_downsample": qc["mask_downsample"],
        "excluded_issue_ids": qc["excluded_issue_ids"], "excluded_regions": qc["excluded_regions"],
        "excluded_regions_sha256": qc["excluded_regions_sha256"], "qc_source": qc["qc_source"],
    })


def live_snapshot(slide_id: str) -> dict:
    """A snapshot of a slide from its live row and QC state (inference on new slides)."""
    with session_scope() as db:
        slide = db.get(Slide, slide_id)
        if slide is None:
            raise FeatureError(f"slide {slide_id} does not exist")
        return slide_snapshot(slide, live_qc(db, slide_id))


# --------------------------------------------------------------------------- mode checks


def _data_mode_of(snaps: Iterable[dict]) -> str | None:
    from ..datasets import item_data_mode

    kinds = {item_data_mode(s.get("provenance"), s.get("image_kind")) for s in snaps}
    if not kinds:
        return None
    if kinds == {"synthetic"}:
        return "synthetic"
    if kinds == {"real"}:
        return "real"
    return "mixed"


def check_modes(*, execution_mode: str, encoder_spec: EncoderSpec, snaps: list[dict], dataset: bool,
                manifest_data_mode: str | None = None, allow_uncalibrated: bool = False) -> str:
    """Design §1 invariants; raises :class:`ModeMismatch`. Returns the data mode of the slides."""
    data_mode = _data_mode_of(snaps)
    problems: list[str] = []
    if manifest_data_mode is not None and data_mode is not None and manifest_data_mode != data_mode:
        problems.append(f"the manifest says data_mode {manifest_data_mode!r} but its items are {data_mode!r}")
    if encoder_spec.synthetic and execution_mode != SYNTHETIC_MODE:
        problems.append(f"{encoder_spec.id} is the synthetic fixture encoder; it runs only in {SYNTHETIC_MODE}")
    if execution_mode == SYNTHETIC_MODE:
        if not encoder_spec.synthetic:
            problems.append(f"{SYNTHETIC_MODE} uses the synthetic encoder only, not {encoder_spec.id}")
        if data_mode != "synthetic":
            problems.append(f"{SYNTHETIC_MODE} needs synthetic data (every slide demo_synthetic + synthetic_tiles); "
                            f"these slides are {data_mode}")
    elif execution_mode == TECHNICAL_MODE:
        if not encoder_spec.reads_pixels:
            problems.append(f"{TECHNICAL_MODE} needs an encoder that reads pixels")
        if data_mode != "real":
            problems.append(f"{TECHNICAL_MODE} runs on real slides (public or authorised images only); these slides "
                            f"are {data_mode} (demo_synthetic slides are refused for real encoders)")
    elif execution_mode == SUPERVISED_MODE:
        if not dataset:
            problems.append(f"{SUPERVISED_MODE} needs a frozen dataset version")
        if data_mode != "real":
            problems.append(f"{SUPERVISED_MODE} needs data_mode real; these slides are {data_mode}")
        uncal = sorted(s["slide_id"] for s in snaps if not (_valid_mpp(s.get("mpp_x")) and _valid_mpp(s.get("mpp_y"))))
        if uncal:
            problems.append(f"{SUPERVISED_MODE} needs calibrated WSIs; {len(uncal)} slide(s) have no "
                            f"microns-per-pixel: {uncal[:20]}")
        if allow_uncalibrated:
            problems.append(f"allow_uncalibrated is refused in {SUPERVISED_MODE}")
    else:
        problems.append(f"unknown execution mode {execution_mode!r}")
    if problems:
        raise ModeMismatch("; ".join(problems), execution_mode=execution_mode, encoder_id=encoder_spec.id,
                           data_mode=data_mode, problems=problems)
    return data_mode


# --------------------------------------------------------------------------- encoder identity


def _config_sha256(adapter) -> str | None:
    if adapter.spec.weights_format != "hf_dir":
        return None
    path = adapter._config_file() if hasattr(adapter, "_config_file") else None
    if path is None or not Path(path).is_file():
        return None
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def resolve_weights_identity(adapter) -> tuple[str, str | None]:
    """``(weights_sha256, config_sha256)`` without loading a model (streaming file hash)."""
    if adapter.spec.synthetic:
        return SYNTHETIC_WEIGHTS_MARKER, None
    sha = adapter.weights_sha256()
    if not sha:
        raise EncoderUnavailable(adapter.id, "missing_weights", "no weights identity could be resolved")
    return sha, _config_sha256(adapter)


def _resolve_runtime(spec: EncoderSpec, params: dict) -> tuple[str, str, int | None]:
    """``(device, precision, cpu_threads)`` pinned by the feature set."""
    try:
        precision = devices.resolve_precision(params.get("precision"))
    except ValueError as exc:
        raise InvalidFeatureParams([{"loc": ["precision"], "msg": str(exc)}]) from exc
    req = params.get("device")
    if spec.kind in EXACT_KINDS:  # numpy encoders compute on the CPU in float64 → float32
        if req not in (None, "", "auto", "cpu"):
            try:
                devices.resolve_device(req)
            except devices.DeviceUnavailable as exc:
                raise InvalidFeatureParams([{"loc": ["device"], "msg": str(exc)}]) from exc
        if precision != "fp32":
            raise InvalidFeatureParams([{"loc": ["precision"], "msg": f"{spec.id} has no low-precision mode"}])
        return "cpu", "fp32", None
    try:
        device = devices.resolve_device(req)
    except (devices.DeviceUnavailable, ValueError) as exc:
        raise InvalidFeatureParams([{"loc": ["device"], "msg": str(exc)}]) from exc
    threads = devices.cpu_threads() if device == "cpu" else None
    return device, precision, threads


def load_encoder(encoder_id: str, *, weights_sha256: str, encoder_spec_sha256: str, device: str, precision: str,
                 weights_config_sha256: str | None = None) -> LoadedEncoder:
    """Load the encoder bound to exactly these weights; raises
    :class:`~dermpath.ml.encoders.EncoderIdentityMismatch` when the file now hashes differently."""
    adapter = get_encoder(encoder_id)
    if adapter is None:
        raise EncoderUnavailable(encoder_id, "missing_weights", f"unknown encoder {encoder_id}")
    if adapter.spec.spec_sha256() != encoder_spec_sha256:
        raise FeatureSetIntegrityError(f"encoder_spec_changed: {encoder_id} spec sha256 is now "
                                       f"{adapter.spec.spec_sha256()[:16]}…, the feature set pins "
                                       f"{encoder_spec_sha256[:16]}…")
    if adapter.spec.synthetic:
        loaded = adapter.load(expected_weights_sha256=weights_sha256)
    else:
        loaded = adapter.load(expected_weights_sha256=weights_sha256, device=device, precision=precision)
    if loaded.weights_sha256 != weights_sha256:  # defence in depth: load() already checked
        raise EncoderIdentityMismatch(encoder_id, expected=weights_sha256, actual=loaded.weights_sha256,
                                      source="feature_set")
    if weights_config_sha256 is not None and loaded.config_sha256 != weights_config_sha256:
        raise EncoderIdentityMismatch(encoder_id, expected=weights_config_sha256,
                                      actual=str(loaded.config_sha256), source="config.json")
    return loaded


# --------------------------------------------------------------------------- creation


#: What seeds the macenko-v1 reference's choice of train slides (above ``max_slides``) and of their patches: the
#: slide's sha256, never its database id, so a cohort re-imported under new ids fits the same reference. Recorded in
#: the fit plan; plans without it (created before this rule) keep their id-keyed selection when built.
STAIN_REFERENCE_SELECTION_KEY = "slide_sha256"


def _choose_train_slides(train_ids: list[str], seed: int, limit: int,
                         sha_of: dict[str, str] | None = None) -> list[str]:
    """Train slides for the stain reference: all of them up to ``limit``, else a seeded subset ranked by content
    (``sha_of``: slide id -> sha256), so the choice does not depend on database ids."""
    if len(train_ids) <= limit:
        return sorted(train_ids)
    sha_of = sha_of or {}
    ranked = sorted(train_ids, key=lambda s: (hashlib.sha256(f"stain-reference|{seed}|{sha_of.get(s) or s}".encode())
                                              .hexdigest(), sha_of.get(s) or "", s))
    return sorted(ranked[:limit])


def create_feature_set(db: Session, actor, project: Project, *, encoder_id: str, execution_mode: str,
                       dataset_version_id: str | None = None, slide_ids: list[str] | None = None,
                       params: dict | None = None, name: str | None = None) -> FeatureSet:
    """Create (or return the existing) frozen feature set. See the module docstring.

    Raises :class:`ModeMismatch` (409), :class:`~dermpath.ml.encoders.EncoderUnavailable`,
    :class:`InvalidFeatureParams` (422) and ``ApiError`` (404 / 409 ``dataset_not_frozen``,
    ``slide_not_extractable``, ``input_changed``; 422 ``scale_refused``, ...). Does not
    enqueue the build (:func:`enqueue_build`)."""
    params = dict(params or {})
    if execution_mode not in EXECUTION_MODES:
        raise unprocessable("invalid_execution_mode", f"execution_mode must be one of {list(EXECUTION_MODES)}",
                            allowed=list(EXECUTION_MODES))
    adapter = get_encoder(encoder_id)
    if adapter is None or adapter.spec is None:
        raise unprocessable("unknown_encoder", f"Unknown encoder {encoder_id}")
    status, detail = adapter.status()
    if status != "available":
        raise EncoderUnavailable(encoder_id, status, detail or status)
    spec = adapter.spec
    if (dataset_version_id is None) == (slide_ids is None):
        raise unprocessable("invalid_slides", "Give exactly one of dataset_version_id or slide_ids")

    dv = None
    items_by_slide: dict[str, dict] = {}
    if dataset_version_id is not None:
        dv = db.get(DatasetVersion, dataset_version_id)
        if dv is None or dv.project_id != project.id:
            raise not_found("dataset_version", dataset_version_id)
        if dv.status != "frozen" or not dv.manifest_json:
            raise conflict("dataset_not_frozen", "Feature sets use frozen dataset versions only; freeze it first",
                           dataset_version_id=dv.id)
        # Only lineage / QC / split fields of the items are read here; never their labels.
        for it in dv.manifest_json.get("items") or []:
            items_by_slide.setdefault(it["slide_id"], it)
        ids = sorted(items_by_slide)
    else:
        ids = sorted({str(s) for s in slide_ids or []})
    if not ids:
        raise unprocessable("invalid_slides", "A feature set needs at least one slide")
    slides = {s.id: s for s in db.scalars(select(Slide).where(Slide.id.in_(ids))).all()}
    unknown = [i for i in ids if i not in slides or slides[i].project_id != project.id]
    if unknown:
        raise unprocessable("unknown_slides", "Slides not found in this project", slide_ids=unknown[:50])
    bad = [{"slide_id": i, "ingest_status": slides[i].ingest_status, "image_kind": slides[i].image_kind}
           for i in ids if slides[i].ingest_status != "succeeded" or slides[i].image_kind == "field_image"]
    if bad:
        raise conflict("slide_not_extractable", "Only ingested whole-slide or synthetic tiled images are patched",
                       slides=bad[:50])

    snaps: list[dict] = []
    problems: list[dict] = []
    manifest_qc_used = False
    for sid in ids:
        qc = None
        if dv is not None:
            qc, why = _manifest_qc(db, items_by_slide[sid])
            if why:
                problems.append({"slide_id": sid, "problems": why})
            manifest_qc_used = manifest_qc_used or qc is not None
            if items_by_slide[sid].get("slide_sha256") not in (None, slides[sid].sha256):
                problems.append({"slide_id": sid, "problems": ["slide sha256 differs from the manifest"]})
        snaps.append(slide_snapshot(slides[sid], qc or live_qc(db, sid)))
    if problems:
        raise conflict("input_changed", "QC inputs recorded at freeze can no longer be reproduced; create a new "
                       "dataset version", slides=problems[:50])

    manifest_mode = None
    if dv is not None:
        manifest_mode = dv.manifest_json.get("data_mode") or (
            "synthetic" if dv.manifest_json.get("synthetic_only") else None)
    check_modes(execution_mode=execution_mode, encoder_spec=spec, snaps=snaps, dataset=dv is not None,
                manifest_data_mode=manifest_mode, allow_uncalibrated=bool(params.get("allow_uncalibrated"))
                and execution_mode == SUPERVISED_MODE)
    patch, sampling, stain_plan = policies_from_params(params, spec, execution_mode)
    pixel_mode = _param(params, "pixel_mode", "read")
    if stain_plan.method == stainlib.MACENKO_VERSION:
        if dv is None:
            raise unprocessable("stain_reference_needs_dataset", "macenko-v1 fits its reference on the TRAIN split of "
                                "a frozen dataset version; pass dataset_version_id")
        train = sorted(s for s, it in items_by_slide.items() if it.get("split") == "train")
        if not train:
            raise conflict("no_train_slides", "macenko-v1 needs train-split slides to fit its reference")
        fit = {"fitted_on": "train-split slides of the dataset version only (never validation or test)",
               "dataset_version_id": dv.id,
               "train_slide_ids": _choose_train_slides(train, sampling.seed, STAIN_REFERENCE_MAX_SLIDES,
                                                       {s: items_by_slide[s].get("slide_sha256") for s in train}),
               "selection_key": STAIN_REFERENCE_SELECTION_KEY,
               "n_train_slides": len(train), "patches_per_slide": STAIN_REFERENCE_PATCHES_PER_SLIDE,
               "max_slides": STAIN_REFERENCE_MAX_SLIDES, "seed": sampling.seed,
               "source_patches_per_slide": STAIN_SOURCE_PATCHES, "params": stainlib.MacenkoParams().to_json()}
        stain_plan = DeferredMacenkoPolicy(method=stain_plan.method, source_estimate=stain_plan.source_estimate,
                                           fit=fit)
    refused = []
    for snap in snaps:
        try:
            plan_scale(mpp_x=snap["mpp_x"], mpp_y=snap["mpp_y"], level_downsamples=snap["level_downsamples"],
                       policy=patch)
        except ScaleError as exc:
            refused.append({"slide_id": snap["slide_id"], "reason": exc.reason, "detail": exc.detail})
    if refused:
        raise unprocessable("scale_refused", "Slides cannot be read at the policy's physical scale",
                            slides=refused[:50])

    weights_sha, cfg_sha = resolve_weights_identity(adapter)
    device, precision, threads = _resolve_runtime(spec, params)
    env, env_sha = extraction_env(device, precision)
    extraction = {"pixel_mode": pixel_mode, "batch_size": _batch_size(), "device": device, "cpu_threads": threads,
                  "extractor_version": EXTRACTOR_VERSION}
    encoder_config = fixture.synthetic_config(params) if spec.synthetic else {}
    enc_json = _jsonable({**spec.output_fields(), "spec_sha256": spec.spec_sha256(), "weights_config_sha256": cfg_sha,
                          "encoder_config": encoder_config, "extraction": extraction})
    snapshot = {"schema": SNAPSHOT_SCHEMA,
                "qc_source": "dataset_manifest" if manifest_qc_used else "live_qc_at_creation", "slides": snaps}
    snapshot_sha = _sha_json(snapshot)
    patch_json, stain_json = _jsonable(patch.to_json()), _jsonable(stain_plan.to_json())
    body = {"schema": FEATURE_SET_SCHEMA, "execution_mode": execution_mode,
            "dataset_version_id": dv.id if dv else None,
            "dataset_manifest_sha256": dv.manifest_sha256 if dv else None, "encoder_id": encoder_id,
            "encoder_spec_json": enc_json, "encoder_spec_sha256": spec.spec_sha256(), "weights_sha256": weights_sha,
            "patch_policy_json": patch_json, "policy_sha256": patch.policy_sha256, "stain_policy_json": stain_json,
            "stain_policy_sha256": stain_plan.policy_sha256, "extraction_env_json": env,
            "extraction_env_sha256": env_sha, "input_snapshot_sha256": snapshot_sha}
    spec_sha = _sha_json(body)
    existing = db.scalars(select(FeatureSet).where(FeatureSet.project_id == project.id,
                                                   FeatureSet.spec_sha256 == spec_sha)).first()
    if existing is not None:
        return existing
    default_name = f"{encoder_id} · {execution_mode} · {dv.name if dv else f'{len(ids)} slides'} · {spec_sha[:8]}"
    fs = FeatureSet(project_id=project.id, name=(name or default_name)[:200], execution_mode=execution_mode,
                    dataset_version_id=dv.id if dv else None, encoder_id=encoder_id, encoder_spec_json=enc_json,
                    encoder_spec_sha256=spec.spec_sha256(), weights_sha256=weights_sha, patch_policy_json=patch_json,
                    policy_sha256=patch.policy_sha256, stain_policy_json=stain_json,
                    stain_policy_sha256=stain_plan.policy_sha256, extraction_env_json=env,
                    extraction_env_sha256=env_sha, input_snapshot_json=snapshot, input_snapshot_sha256=snapshot_sha,
                    spec_sha256=spec_sha, status="building", created_by=getattr(actor, "id", None) or str(actor))
    try:
        with db.begin_nested():
            db.add(fs)
            db.flush()
            db.add_all([FeatureSetItem(feature_set_id=fs.id, project_id=project.id, slide_id=s["slide_id"],
                                       slide_sha256=s["slide_sha256"]) for s in snaps])
            db.flush()
    except IntegrityError:  # a concurrent request created the same spec first
        existing = db.scalars(select(FeatureSet).where(FeatureSet.project_id == project.id,
                                                       FeatureSet.spec_sha256 == spec_sha)).first()
        if existing is None:
            raise
        return existing
    audit.record_for(db, actor, project_id=project.id, action="feature_set.created", entity_type="feature_set",
                     entity_id=fs.id, after={"spec_sha256": spec_sha, "execution_mode": execution_mode,
                                             "encoder_id": encoder_id, "weights_sha256": weights_sha,
                                             "dataset_version_id": fs.dataset_version_id, "slides": len(ids),
                                             "policy_sha256": patch.policy_sha256})
    return fs


def enqueue_build(db: Session, fs: FeatureSet, actor, *, repair: bool = False) -> Job:
    """Enqueue (or re-queue) the ``build_feature_set`` job; idempotent per feature set.

    A failed or canceled build is retried in place (done slides are kept). ``repair=True`` on
    a ready set enqueues a verification pass that re-extracts artifacts whose objects are
    missing or corrupt (new generation rows)."""
    key = f"{BUILD_JOB}:{fs.id}"
    if repair:
        key = f"{key}:repair:{utcnow().strftime('%Y%m%dT%H%M%S%f')}"
    job, created = queue.enqueue(db, BUILD_JOB, {"feature_set_id": fs.id, "repair": bool(repair)},
                                 idempotency_key=key, project_id=fs.project_id,
                                 created_by=getattr(actor, "id", None))
    if not created and job.status in ("failed", "canceled") and fs.status != "ready":
        queue.retry(db, job)
        if fs.status == "failed":
            fs.status = "building"
            fs.error = None
    if fs.status != "ready" and fs.job_id is None:
        fs.job_id = job.id
    audit.record_for(db, actor, project_id=fs.project_id, action="feature_set.build_requested",
                     entity_type="feature_set", entity_id=fs.id,
                     after={"job_id": job.id, "job_status": job.status, "repair": bool(repair)})
    return job


# --------------------------------------------------------------------------- slide features


@dataclass
class SlideFeatures:
    """Embeddings of one slide under one feature set (or one extraction request).

    ``embeddings`` is float32 ``[N, D]`` (memory-mapped from the store where possible),
    ``coords`` int64 ``[N, 2]`` level-0 top-left, ``quality`` per-patch arrays (empty for the
    pixel-free synthetic fixture)."""

    slide_id: str
    embeddings: np.ndarray
    coords: np.ndarray
    quality: dict
    artifact_id: str | None
    weights_sha256: str
    encoder_spec_sha256: str
    policy_sha256: str
    n_patches: int
    stain_policy_sha256: str | None = None
    cache_key: str | None = None
    cache_hit: bool = False
    extraction_env_sha256: str | None = None
    coverage: dict | None = None
    stats: dict = field(default_factory=dict)
    meta: dict = field(default_factory=dict)


def _materialise(art: FeatureArtifact, *, mmap: bool = True) -> SlideFeatures:
    """Load a verified engine artifact (embeddings memory-mapped)."""
    if not art.embeddings_key or not art.quality_key:
        raise FeatureSetIntegrityError(f"feature artifact {art.id} is a legacy artifact (no embeddings object)")
    if not _object_ok(art.embeddings_key, art.embeddings_sha256):
        raise FeatureSetIntegrityError(f"feature artifact {art.id}: embeddings object missing or failed its sha256")
    store = get_store()
    qdata = store.get_bytes(art.quality_key)
    if sha256_hex(qdata) != art.quality_sha256:
        raise FeatureSetIntegrityError(f"feature artifact {art.id}: coords/quality object failed its sha256")
    arrays, meta = load_npz(qdata)
    path = store.local_path(art.embeddings_key)
    emb = np.load(path, mmap_mode="r" if mmap else None, allow_pickle=False)
    coords = arrays["coords"].astype(np.int64)
    if emb.dtype != np.float32 or emb.ndim != 2 or emb.shape[0] != coords.shape[0] or emb.shape[0] != art.n_patches:
        raise FeatureSetIntegrityError(f"feature artifact {art.id}: embeddings {emb.dtype}{list(emb.shape)} do not "
                                       f"match {art.n_patches} coordinates")
    quality = {k[2:]: v for k, v in arrays.items() if k.startswith("q_")}
    return SlideFeatures(slide_id=art.slide_id, embeddings=emb, coords=coords, quality=quality, artifact_id=art.id,
                         weights_sha256=art.weights_sha256, encoder_spec_sha256=art.encoder_spec_sha256 or "",
                         policy_sha256=art.policy_sha256 or "", n_patches=int(art.n_patches),
                         stain_policy_sha256=art.stain_policy_sha256, cache_key=art.cache_key,
                         coverage=art.coverage_json, stats=dict(art.stats_json or {}), meta=meta or {},
                         extraction_env_sha256=art.extraction_env_sha256)


def _artifact_ok(art: FeatureArtifact) -> bool:
    return _object_ok(art.embeddings_key, art.embeddings_sha256) and _object_ok(art.quality_key, art.quality_sha256)


def _cache_lookup(project_id: str, cache_key: str) -> tuple[FeatureArtifact | None, int]:
    """``(valid newest row, generation to write next)``. A row whose objects are missing or
    corrupt is never served."""
    with session_scope() as db:
        rows = db.scalars(select(FeatureArtifact).where(FeatureArtifact.project_id == project_id,
                                                        FeatureArtifact.cache_key == cache_key)
                          .order_by(FeatureArtifact.generation.desc())).all()
    if not rows:
        return None, 0
    if _artifact_ok(rows[0]):
        return rows[0], rows[0].generation
    return None, rows[0].generation + 1


# --------------------------------------------------------------------------- extraction internals


def open_slide(slide: Slide):
    """Open a slide row with its reader (tests patch this to serve ``openslide.ImageSlide``)."""
    return slide_reader.open_slide_record(slide)


@dataclass
class _Prepared:
    slide: Slide
    snap: dict
    osr: object | None
    plan: PatchPlan
    dims: tuple[int, int]
    mask: np.ndarray | None
    mask_ds: tuple[float, float] | None
    mask_info: dict
    regions: list[dict]
    candidates: Candidates
    sampled: Candidates
    sampling_stats: dict

    def close(self) -> None:
        if self.osr is not None:
            try:
                self.osr.close()
            finally:
                self.osr = None


def _verify_slide_bytes(slide: Slide, snap: dict) -> None:
    if snap["image_kind"] == "synthetic_tiles":
        actual = synthetic_spec_sha256(slide.synthetic_spec_json or {})
    else:
        try:
            actual = object_sha256(snap["object_key"])
        except (OSError, StoreError) as exc:
            raise _input_changed(f"slide {slide.id} object {snap['object_key']} is missing ({exc})") from exc
    if actual != snap["slide_sha256"]:
        raise _input_changed(f"slide {slide.id} bytes hash to {actual[:16]}…, the snapshot pins "
                             f"{snap['slide_sha256'][:16]}…")


def verify_snapshot_objects(slide: Slide, snap: dict) -> None:
    """Raise ``FeatureError("input_changed: …")`` unless the stored objects still are the snapshot's: the slide's
    bytes hash to ``snap["slide_sha256"]`` (:func:`object_sha256`, memoised per key/size/mtime/inode/ctime, so an
    unchanged object costs a ``stat``) and the QC mask object to ``snap["mask_sha256"]``. Extraction makes the same
    checks; inference also runs this before it serves a STORED prediction for the snapshot (the reuse path), so a
    prediction is never presented as the answer for bytes it was not computed from."""
    if snap.get("slide_id") != slide.id:
        raise _input_changed(f"the snapshot is for slide {snap.get('slide_id')}, not {slide.id}")
    _verify_slide_bytes(slide, snap)
    key, sha = snap.get("mask_object_key"), snap.get("mask_sha256")
    if key and sha:
        try:
            data = get_store().get_bytes(key)
        except (OSError, StoreError) as exc:
            raise _input_changed(f"mask object {key} of slide {slide.id} is missing ({exc})") from exc
        if sha256_hex(data) != sha:
            raise _input_changed(f"mask object {key} of slide {slide.id} no longer matches its sha256")


def _snapshot_mask(snap: dict) -> tuple[np.ndarray | None, tuple[float, float] | None, dict]:
    key, sha = snap.get("mask_object_key"), snap.get("mask_sha256")
    if not key or not sha:
        return None, None, {"source": None}
    try:
        data = get_store().get_bytes(key)
    except (OSError, StoreError) as exc:
        raise _input_changed(f"mask object {key} of slide {snap['slide_id']} is missing ({exc})") from exc
    if sha256_hex(data) != sha:
        raise _input_changed(f"mask object {key} of slide {snap['slide_id']} no longer matches its sha256")
    ds = snap.get("mask_downsample")
    if not ds:
        raise _input_changed(f"the snapshot of slide {snap['slide_id']} has a mask without a downsample")
    return mask_from_png(data), (float(ds[0]), float(ds[1])), {"source": "qc_screen", "qc_review_id":
                                                                snap.get("qc_review_id"), "sha256": sha}


def _snapshot_regions(snap: dict) -> list[dict]:
    regions = list(snap.get("excluded_regions") or [])
    if _sha_json(regions) != snap.get("excluded_regions_sha256"):
        raise _input_changed(f"the excluded regions of slide {snap['slide_id']} do not match their snapshot sha256")
    for r in regions:
        if not isinstance(r.get("region"), dict):
            raise FeatureError(f"excluded region of issue {r.get('issue_id')} has no geometry")
    return regions


def _prepare(snap: dict, *, patch_policy: PatchPolicy, sampling: SamplingPolicy, pixel_mode: str,
             reads_pixels: bool) -> _Prepared:
    """Verify the snapshot's inputs, plan the scale, build candidates and sample (no embedding yet)."""
    with session_scope() as db:
        slide = db.get(Slide, snap["slide_id"])
        if slide is None:
            raise _input_changed(f"slide {snap['slide_id']} no longer exists")
        db.expunge(slide)
    for name, live, frozen in (("object_key", slide.object_key, snap["object_key"]),
                               ("image_kind", slide.image_kind, snap["image_kind"]),
                               ("sha256", slide.sha256, snap["slide_sha256"]),
                               ("provenance", slide.provenance, snap["provenance"])):
        if live != frozen:
            raise _input_changed(f"slide {slide.id} {name} changed since the snapshot ({frozen!r} -> {live!r})")
    if slide.ingest_status != "succeeded":
        raise _not_ingested(slide.id, slide.ingest_status)
    _verify_slide_bytes(slide, snap)
    mask, mask_ds, mask_info = _snapshot_mask(snap)
    regions = _snapshot_regions(snap)
    try:
        plan = plan_scale(mpp_x=snap["mpp_x"], mpp_y=snap["mpp_y"], level_downsamples=snap["level_downsamples"],
                          policy=patch_policy)
    except ScaleError as exc:
        raise FeatureError(f"scale_refused: {exc}") from exc
    dims = (int(snap["width"]), int(snap["height"]))
    osr = None
    if pixel_mode == "read" and (reads_pixels or mask is None):
        osr = open_slide(slide)
    try:
        if mask is None and pixel_mode == "read":
            mask, mstats = otsu_mask(osr, snap["slide_sha256"])
            mask_ds = (float(mstats["mask_downsample_x"]), float(mstats["mask_downsample_y"]))
            mask_info = {"source": "otsu_fallback", "method": qc_tissue.METHOD_VERSION,
                         "max_side": FALLBACK_MASK_SIZE,
                         "sha256": hashlib.sha256(np.packbits(mask).tobytes() + repr(mask.shape).encode()).hexdigest()}
        elif mask is None:
            mask_info = {"source": "none (pixel_mode none: every grid cell is a candidate)"}
        cands = candidate_grid(dims, plan, mask, mask_ds, regions, patch_policy)
        idx, sstats = select_indices(cands, sampling, salt=snap["slide_sha256"])
        sampled = cands.subset(idx)
    except BaseException:
        if osr is not None:
            osr.close()
        raise
    return _Prepared(slide=slide, snap=snap, osr=osr, plan=plan, dims=dims, mask=mask, mask_ds=mask_ds,
                     mask_info=mask_info, regions=regions, candidates=cands, sampled=sampled, sampling_stats=sstats)


def _mask_key_field(prep: _Prepared) -> str:
    info = prep.mask_info
    if info.get("source") == "qc_screen":
        return info["sha256"]
    if info.get("source") == "otsu_fallback":
        return f"otsu_fallback:{info['method']}:{info['max_side']}"
    return "none"


class _Progress:
    """Throttled progress (and cancel checks) for a job context."""

    def __init__(self, ctx: JobContext | None, base: float = 0.0, span: float = 0.0, label: str = ""):
        self.ctx, self.base, self.span, self.label = ctx, base, span, label
        self._last = 0.0

    def tick(self, frac: float, msg: str, *, force: bool = False) -> None:
        if self.ctx is None:
            return
        now = time.monotonic()
        if force or now - self._last >= PROGRESS_INTERVAL_SECONDS:
            self._last = now
            self.ctx.progress(self.base + self.span * max(0.0, min(1.0, frac)) if self.span else None,
                              f"{self.label}{msg}")


class _EmbeddingSink:
    """Streams embedding rows into a memory-mapped ``.npy`` (bounded memory) and trims it at the end."""

    def __init__(self, directory: Path, capacity: int, dim: int):
        self.directory, self.capacity, self.dim, self.n = directory, int(capacity), int(dim), 0
        self.path = directory / "embeddings.capacity.npy"
        self._mm = np.lib.format.open_memmap(self.path, mode="w+", dtype=np.float32, shape=(self.capacity, self.dim))

    def write(self, emb: np.ndarray) -> None:
        emb = np.asarray(emb, dtype=np.float32)
        if emb.ndim != 2 or emb.shape[1] != self.dim:
            raise FeatureError(f"encoder produced {list(emb.shape)}, expected [*, {self.dim}]")
        if self.n + emb.shape[0] > self.capacity:
            raise FeatureError("more embeddings than sampled patches")
        self._mm[self.n:self.n + emb.shape[0]] = emb
        self.n += emb.shape[0]

    def finalise(self) -> Path:
        self._mm.flush()
        if self.n == self.capacity:
            del self._mm
            return self.path
        out = self.directory / "embeddings.npy"
        dst = np.lib.format.open_memmap(out, mode="w+", dtype=np.float32, shape=(self.n, self.dim))
        for s in range(0, self.n, 8192):
            e = min(s + 8192, self.n)  # bound by n: the source memmap has `capacity` rows, the trimmed one n
            dst[s:e] = self._mm[s:e]
        dst.flush()
        del dst
        del self._mm
        self.path.unlink(missing_ok=True)
        return out


def _stain_source(prep: _Prepared, policy: stainlib.StainPolicy, patch_policy: PatchPolicy, batch_size: int,
                  seed: int) -> stainlib.MacenkoReference:
    """Per-slide Macenko source estimate on a seeded subset of this slide's own sampled patches (label-free)."""
    ranks = seeded_ranks(prep.sampled.coords, seed, f"stain-source|{prep.snap['slide_sha256']}")
    idx = np.sort(np.argsort(ranks, kind="stable")[:STAIN_SOURCE_PATCHES])
    sub = prep.sampled.subset(idx)

    def batches():
        for _, patches, _ in iter_patch_batches(prep.osr, sub, prep.plan, batch_size=batch_size, policy=patch_policy):
            if len(patches):
                yield patches

    try:
        return stainlib.fit_source(batches(), params=policy.reference.params)
    except stainlib.StainError as exc:
        raise FeatureError(f"stain_source_unestimable: slide {prep.snap['slide_id']}: {exc}") from exc


@dataclass
class _Run:
    """What one compute pass produced (before storing)."""

    path: Path
    n: int
    dim: int
    coords: np.ndarray
    quality: dict
    tally: dict
    timings: dict
    stain: dict
    kept_candidates: Candidates


def _compute(prep: _Prepared, *, encoder_spec: EncoderSpec, loaded: LoadedEncoder | None,
             fixture_ctx, encoder_config: dict, sampling_seed: int, stain_policy: stainlib.StainPolicy,
             patch_policy: PatchPolicy, batch_size: int, directory: Path, progress: _Progress,
             only_rows: np.ndarray | None = None) -> _Run:
    """Embed the sampled patches of one slide, one batch at a time, into a memmap sink."""
    sampled = prep.sampled if only_rows is None else prep.sampled.subset(only_rows)
    n = len(sampled)
    dim = int(encoder_config.get("dim", encoder_spec.embedding_dim)) if encoder_spec.synthetic \
        else int(encoder_spec.embedding_dim)
    sink = _EmbeddingSink(directory, n, dim)
    coords_out: list[np.ndarray] = []
    quality_out: dict[str, list[np.ndarray]] = {k: [] for k in QUALITY_KEYS}
    tally = ReadTally()
    t_read = t_pre = t_embed = 0.0
    stain_info: dict = {"policy_sha256": stain_policy.policy_sha256, "method": stain_policy.method}
    sid = prep.snap["slide_id"]
    if not encoder_spec.reads_pixels:
        for start in range(0, n, batch_size):
            cb = sampled.coords[start:start + batch_size]
            te = time.perf_counter()
            emb = fixture.synthetic_embeddings(fixture_ctx, cb, slide_sha256=prep.snap["slide_sha256"],
                                               seed=sampling_seed, config=encoder_config)
            t_embed += time.perf_counter() - te
            sink.write(emb)
            coords_out.append(np.asarray(cb, dtype=np.int64))
            progress.tick((start + cb.shape[0]) / max(n, 1), f"slide {sid[:8]}: {start + cb.shape[0]}/{n} patches")
        quality_out = {}
    else:
        if loaded is None:
            raise FeatureError(f"{encoder_spec.id} reads pixels but no loaded encoder was given")
        source = None
        if stain_policy.method != "none" and n and stain_policy.source_estimate == "per_slide":
            tp = time.perf_counter()
            source = _stain_source(prep, stain_policy, patch_policy, batch_size, sampling_seed)
            t_pre += time.perf_counter() - tp
            stain_info.update(source_sha256=source.sha256, source=source.to_json())
        it = iter_patch_batches(prep.osr, sampled, prep.plan, batch_size=batch_size, policy=patch_policy)
        read = 0
        while True:
            tr = time.perf_counter()
            try:
                cb, pb, rs = next(it)
            except StopIteration:
                break
            t_read += time.perf_counter() - tr
            tally.add(rs)
            read += int(rs["n_read"])
            if len(pb):
                kept = rs["kept"]
                for k in QUALITY_KEYS:
                    quality_out[k].append(np.asarray(rs["quality"][k])[kept])
                if stain_policy.method != "none":
                    tp = time.perf_counter()
                    pb = stainlib.normalise(pb, stain_policy, source=source)
                    t_pre += time.perf_counter() - tp
                te = time.perf_counter()
                emb = loaded.embed_batch(pb)
                t_embed += time.perf_counter() - te
                sink.write(emb)
                coords_out.append(np.asarray(cb, dtype=np.int64))
            del pb, rs
            progress.tick(read / max(n, 1), f"slide {sid[:8]}: {read}/{n} patches read")
    tw = time.perf_counter()
    path = sink.finalise()
    t_write = time.perf_counter() - tw
    coords = np.concatenate(coords_out).astype(np.int64) if coords_out else np.zeros((0, 2), dtype=np.int64)
    quality = {}
    for k, parts in quality_out.items():
        if parts:
            quality[k] = np.concatenate(parts).astype(np.float32)
        else:
            quality[k] = np.zeros((0, 3) if k == "mean_rgb" else (0,), dtype=np.float32)
    if coords.shape[0]:
        lookup = {(int(x), int(y)): i for i, (x, y) in enumerate(sampled.coords.tolist())}
        kept_idx = np.array([lookup[(int(x), int(y))] for x, y in coords.tolist()], dtype=np.int64)
    else:
        kept_idx = np.zeros(0, dtype=np.int64)
    td = tally.as_dict()
    return _Run(path=path, n=sink.n, dim=dim, coords=coords, quality=quality,
                tally={k: td[k] for k in ("n_read", "n_kept", "rejected", "fill_rgb", "resize_filter")}
                if encoder_spec.reads_pixels else {"n_read": 0, "n_kept": sink.n, "rejected": {},
                                                   "pixels_read": False},
                timings={"read_seconds": t_read, "pixel_read_seconds": td["read_seconds"],
                         "preprocess_seconds": t_pre, "embed_seconds": t_embed, "write_seconds": t_write},
                stain=stain_info, kept_candidates=sampled.subset(kept_idx))


def _coverage(prep: _Prepared, run: _Run, patch_policy: PatchPolicy) -> dict | None:
    if prep.mask is None:
        return None
    cov = coverage_of(dims=prep.dims, plan=prep.plan, mask=prep.mask, mask_ds=prep.mask_ds,
                      candidates=prep.candidates, sampled=run.kept_candidates, excluded=prep.regions,
                      policy=patch_policy, rejected_at_read=run.tally.get("rejected"))
    cov["n_sampled_before_read_filters"] = len(prep.sampled)
    return _jsonable(cov)


def _key_fields(prep: _Prepared, *, encoder_id: str, encoder_spec_sha256: str, weights_sha256: str,
                weights_config_sha256: str | None, encoder_config: dict, patch_policy: PatchPolicy,
                stain_policy: stainlib.StainPolicy, env_sha256: str, extraction: dict,
                fixture_label: int | None, synthetic: bool) -> dict:
    return _jsonable({
        "schema": ARTIFACT_SCHEMA, "extractor_version": EXTRACTOR_VERSION,
        "slide_sha256": prep.snap["slide_sha256"], "encoder_id": encoder_id,
        "encoder_spec_sha256": encoder_spec_sha256, "weights_sha256": weights_sha256,
        "weights_config_sha256": weights_config_sha256, "encoder_config": encoder_config,
        "policy_sha256": patch_policy.policy_sha256, "stain_policy_sha256": stain_policy.policy_sha256,
        "mask_sha256": _mask_key_field(prep), "excluded_regions_sha256": prep.snap["excluded_regions_sha256"],
        "coords_sha256": prep.sampled.sha256, "extraction_env_sha256": env_sha256,
        "extraction": {k: extraction.get(k) for k in ("pixel_mode", "batch_size", "cpu_threads")},
        "fixture": {"label": fixture_label, "seed": patch_policy.sampling.seed} if synthetic else None,
    })


def _store_run(prep: _Prepared, run: _Run, *, fields: dict, cache_key: str, generation: int, project_id: str,
               encoder_spec: EncoderSpec, patch_policy: PatchPolicy, stain_policy: stainlib.StainPolicy,
               device: str, precision: str, env_sha256: str, coverage: dict | None, stats: dict,
               job_id: str | None) -> FeatureArtifact:
    store = get_store()
    suffix = "" if generation == 0 else f"/gen{generation}"
    emb_key, emb_sha = store.put_content_addressed(f"projects/{project_id}/features/embeddings{suffix}", run.path,
                                                   ".npy")
    _remember_sha(emb_key, emb_sha)
    arrays = {"coords": run.coords, "extent": np.asarray(prep.plan.extent, dtype=np.int64)}
    arrays.update({f"q_{k}": v for k, v in run.quality.items()})
    meta = _jsonable({
        "schema": ARTIFACT_SCHEMA, "cache_key": cache_key, "fields": fields, "embeddings_sha256": emb_sha,
        "n_patches": run.n, "n_sampled": len(prep.sampled), "embedding_dim": run.dim,
        "scale": prep.plan.scale, "candidates": prep.candidates.stats, "sampling": prep.sampling_stats,
        "read": run.tally, "stain": run.stain, "mask": prep.mask_info, "coverage": coverage,
        "quality_version": QUALITY_VERSION if encoder_spec.reads_pixels else None,
        "synthetic": encoder_spec.synthetic, "research_use_only": True, "note": NOT_A_LABEL_NOTE,
    })
    qdata = npz_bytes(arrays, meta)
    q_key, q_sha = store.put_content_addressed(f"projects/{project_id}/features/quality{suffix}", qdata, ".npz")
    _remember_sha(q_key, q_sha)
    emb_bytes = store.size(emb_key)
    art = FeatureArtifact(
        project_id=project_id, slide_id=prep.snap["slide_id"], slide_sha256=prep.snap["slide_sha256"],
        encoder_id=fields["encoder_id"], weights_sha256=fields["weights_sha256"],
        preprocessing_version=(f"{PATCHING_VERSION_V2};{QUALITY_VERSION};{SAMPLING_VERSION};{EXTRACTOR_VERSION};"
                               f"{encoder_spec.id}/a{encoder_spec.adapter_version}")[:200],
        patch_size=int(prep.plan.patch_size), scale_key=prep.plan.scale_key[:80], coords_sha256=prep.sampled.sha256,
        key_extra_json=fields, cache_key=cache_key, generation=generation,
        encoder_spec_sha256=fields["encoder_spec_sha256"], policy_sha256=patch_policy.policy_sha256,
        stain_policy_sha256=stain_policy.policy_sha256, mask_sha256=prep.snap.get("mask_sha256"),
        excluded_regions_sha256=prep.snap["excluded_regions_sha256"], extraction_env_sha256=env_sha256,
        device=device, precision=precision, object_key=q_key, sha256=q_sha, bytes=int(emb_bytes) + len(qdata),
        embeddings_key=emb_key, embeddings_sha256=emb_sha, quality_key=q_key, quality_sha256=q_sha,
        n_patches=int(run.n), embedding_dim=int(meta["embedding_dim"]), calibrated=bool(prep.plan.calibrated),
        synthetic=bool(encoder_spec.synthetic), stats_json=_jsonable(stats), coverage_json=coverage, job_id=job_id)
    try:
        with session_scope() as db:
            db.add(art)
            db.flush()
            db.expunge(art)
        return art
    except IntegrityError:  # a concurrent extraction wrote this generation first
        hit, _ = _cache_lookup(project_id, cache_key)
        if hit is None:
            raise
        return hit


def _extract(snap: dict, *, project_id: str, encoder_id: str, encoder_spec: EncoderSpec, encoder_spec_sha256: str,
             weights_sha256: str, weights_config_sha256: str | None, encoder_config: dict, loaded: LoadedEncoder | None,
             patch_policy: PatchPolicy, stain_policy: stainlib.StainPolicy, device: str, precision: str,
             env_sha256: str, extraction: dict, fixture_label: int | None = None, use_cache: bool = True,
             store: bool = True, only_rows: np.ndarray | None = None, ctx: JobContext | None = None,
             progress: _Progress | None = None, job_id: str | None = None) -> SlideFeatures:
    """Verify, plan, sample, look up the cache, and (on a miss) embed and store one slide."""
    t0 = time.perf_counter()
    rss0 = _peak_rss_bytes()
    progress = progress or _Progress(ctx)
    if isinstance(stain_policy, DeferredMacenkoPolicy) or (stain_policy.method != "none"
                                                           and stain_policy.reference is None):
        raise FeatureError("stain_reference_missing: macenko-v1 needs the reference fitted on train slides")
    fixture_ctx = None
    if encoder_spec.synthetic:
        # The only way a fixture signal reaches an embedding (design §1 invariant 3).
        fixture_ctx = fixture.fixture_context(snap["provenance"], snap["image_kind"], SYNTHETIC_MODE, fixture_label)
    elif fixture_label is not None:
        raise SyntheticSignalForbidden(f"{encoder_id} is a real encoder; it never receives a label")
    if encoder_spec.reads_pixels:
        try:
            patch_policy.validate_for_encoder(encoder_spec.input_size)  # no resizing inside encoders
        except ValueError as exc:
            raise FeatureError(str(exc)) from exc
    prep = _prepare(snap, patch_policy=patch_policy, sampling=patch_policy.sampling,
                    pixel_mode=extraction["pixel_mode"], reads_pixels=encoder_spec.reads_pixels)
    try:
        fields = _key_fields(prep, encoder_id=encoder_id, encoder_spec_sha256=encoder_spec_sha256,
                             weights_sha256=weights_sha256, weights_config_sha256=weights_config_sha256,
                             encoder_config=encoder_config, patch_policy=patch_policy, stain_policy=stain_policy,
                             env_sha256=env_sha256, extraction=extraction, fixture_label=fixture_label,
                             synthetic=encoder_spec.synthetic)
        cache_key = _sha_json(fields)
        generation = 0
        if use_cache and store:
            hit, generation = _cache_lookup(project_id, cache_key)
            if hit is not None:
                out = _materialise(hit)
                out.cache_hit = True
                out.stats = {**out.stats, "cache_hit": True, "total_seconds": round(time.perf_counter() - t0, 4)}
                return out
        if loaded is not None and loaded.weights_sha256 != weights_sha256:
            raise EncoderIdentityMismatch(encoder_id, expected=weights_sha256, actual=loaded.weights_sha256,
                                          source="loaded encoder")
        with tempfile.TemporaryDirectory(prefix="extract-", dir=_tmp_root()) as tmp:
            run = _compute(prep, encoder_spec=encoder_spec, loaded=loaded, fixture_ctx=fixture_ctx,
                           encoder_config=encoder_config, sampling_seed=patch_policy.sampling.seed,
                           stain_policy=stain_policy, patch_policy=patch_policy,
                           batch_size=int(extraction["batch_size"]), directory=Path(tmp), progress=progress,
                           only_rows=only_rows)
            cov = _coverage(prep, run, patch_policy) if only_rows is None else None
            total = time.perf_counter() - t0
            rss1 = _peak_rss_bytes()
            stats = {**{k: round(v, 4) for k, v in run.timings.items()}, "total_seconds": round(total, 4),
                     "patches_per_second": round(run.n / max(total, 1e-9), 2), "n_patches": run.n,
                     "n_sampled": len(prep.sampled), "n_candidates": len(prep.candidates), "cache_hit": False,
                     "peak_rss_bytes": rss1,
                     "peak_rss_delta_bytes": (rss1 - rss0) if rss0 is not None and rss1 is not None else None,
                     "rejected_at_read": run.tally.get("rejected"), "pixels_read": bool(encoder_spec.reads_pixels),
                     "device": device, "precision": precision, "batch_size": extraction["batch_size"],
                     "mask_source": prep.mask_info.get("source"), "calibrated": bool(prep.plan.calibrated),
                     "stain_source_sha256": run.stain.get("source_sha256")}
            if not store:
                emb = np.array(np.load(run.path, allow_pickle=False))
                return SlideFeatures(slide_id=snap["slide_id"], embeddings=emb, coords=run.coords,
                                     quality=run.quality, artifact_id=None, weights_sha256=weights_sha256,
                                     encoder_spec_sha256=encoder_spec_sha256, policy_sha256=patch_policy.policy_sha256,
                                     n_patches=run.n, stain_policy_sha256=stain_policy.policy_sha256,
                                     cache_key=cache_key, coverage=cov, stats=stats, meta={"fields": fields},
                                     extraction_env_sha256=env_sha256)
            art = _store_run(prep, run, fields=fields, cache_key=cache_key, generation=generation,
                             project_id=project_id, encoder_spec=encoder_spec, patch_policy=patch_policy,
                             stain_policy=stain_policy, device=device, precision=precision, env_sha256=env_sha256,
                             coverage=cov, stats=stats, job_id=job_id)
        out = _materialise(art)
        out.stats = {**out.stats, **stats}
        return out
    finally:
        prep.close()


def extract_slide(slide_id: str, *, encoder_id: str, weights_sha256: str, encoder_spec_sha256: str,
                  patch_policy: PatchPolicy, sampling_policy: SamplingPolicy, stain_policy: stainlib.StainPolicy,
                  device: str, precision: str, input_snapshot: dict | None = None, ctx: JobContext | None = None,
                  pixel_mode: str = "read", encoder_config: dict | None = None, batch_size: int | None = None,
                  weights_config_sha256: str | None = None, job_id: str | None = None,
                  loaded: LoadedEncoder | None = None) -> SlideFeatures:
    """Label-free extraction of one slide (used by feature-set builds and inference bundles).

    ``input_snapshot`` None takes a live snapshot now (:func:`live_snapshot`). The loaded
    encoder must hash to ``weights_sha256`` before anything is written. Never receives or
    reads a label (for the synthetic encoder the fixture label is ``None``: no signal)."""
    adapter = get_encoder(encoder_id)
    if adapter is None or adapter.spec is None:
        raise FeatureError(f"unknown encoder {encoder_id}")
    snap = input_snapshot if input_snapshot is not None else live_snapshot(slide_id)
    if snap.get("slide_id") != slide_id:
        raise FeatureError(f"the input snapshot is for slide {snap.get('slide_id')}, not {slide_id}")
    if patch_policy.sampling != sampling_policy:
        patch_policy = patch_policy.replace(sampling=sampling_policy)
    if loaded is None:
        loaded = load_encoder(encoder_id, weights_sha256=weights_sha256, encoder_spec_sha256=encoder_spec_sha256,
                              device=device, precision=precision, weights_config_sha256=weights_config_sha256)
    with session_scope() as db:
        row = db.get(Slide, slide_id)
        project_id = row.project_id if row is not None else None
    if project_id is None:
        raise FeatureError(f"slide {slide_id} does not exist")
    env, env_sha = extraction_env(device, precision)
    cfg = (fixture.synthetic_config(encoder_config) if adapter.spec.synthetic else {})
    threads = devices.cpu_threads() if (adapter.spec.kind not in EXACT_KINDS and device == "cpu") else None
    extraction = {"pixel_mode": pixel_mode, "batch_size": int(batch_size or _batch_size()), "cpu_threads": threads}
    return _extract(snap, project_id=project_id, encoder_id=encoder_id, encoder_spec=adapter.spec,
                    encoder_spec_sha256=encoder_spec_sha256, weights_sha256=weights_sha256,
                    weights_config_sha256=weights_config_sha256, encoder_config=cfg,
                    loaded=None if adapter.spec.synthetic else loaded, patch_policy=patch_policy,
                    stain_policy=stain_policy, device=device, precision=precision, env_sha256=env_sha,
                    extraction=extraction, ctx=ctx, job_id=job_id or (ctx.job_id if ctx else None))


# --------------------------------------------------------------------------- a feature set's plan


@dataclass
class _Plan:
    """Detached, verified view of a feature-set row (what the worker extracts)."""

    id: str
    project_id: str
    status: str
    execution_mode: str
    dataset_version_id: str | None
    encoder_id: str
    encoder_spec: EncoderSpec
    encoder_spec_sha256: str
    weights_sha256: str
    weights_config_sha256: str | None
    encoder_config: dict
    extraction: dict
    patch_policy: PatchPolicy
    stain_declared: stainlib.StainPolicy
    stain_reference_key: str | None
    stain_reference_sha256: str | None
    env_json: dict
    env_sha256: str
    snapshots: dict[str, dict]
    items: list[tuple[str, str, str, str | None]]  # (item id, slide id, status, artifact id)


def _plan_of(db: Session, fs: FeatureSet) -> _Plan:
    adapter = get_encoder(fs.encoder_id)
    if adapter is None or adapter.spec is None:
        raise FeatureError(f"unknown encoder {fs.encoder_id}")
    if _sha_json(fs.input_snapshot_json) != fs.input_snapshot_sha256:
        raise FeatureSetIntegrityError(f"feature set {fs.id}: input snapshot does not match its sha256")
    enc = fs.encoder_spec_json or {}
    items = [(i.id, i.slide_id, i.status, i.artifact_id) for i in db.scalars(
        select(FeatureSetItem).where(FeatureSetItem.feature_set_id == fs.id).order_by(FeatureSetItem.slide_id)).all()]
    return _Plan(id=fs.id, project_id=fs.project_id, status=fs.status, execution_mode=fs.execution_mode,
                 dataset_version_id=fs.dataset_version_id, encoder_id=fs.encoder_id, encoder_spec=adapter.spec,
                 encoder_spec_sha256=fs.encoder_spec_sha256, weights_sha256=fs.weights_sha256,
                 weights_config_sha256=enc.get("weights_config_sha256"), encoder_config=dict(enc.get("encoder_config")
                                                                                              or {}),
                 extraction=dict(enc.get("extraction") or {}), patch_policy=PatchPolicy.from_json(fs.patch_policy_json),
                 stain_declared=_stain_from_json(fs.stain_policy_json), stain_reference_key=fs.stain_reference_key,
                 stain_reference_sha256=fs.stain_reference_sha256, env_json=dict(fs.extraction_env_json),
                 env_sha256=fs.extraction_env_sha256,
                 snapshots={s["slide_id"]: s for s in fs.input_snapshot_json["slides"]}, items=items)


def _effective_stain(plan: _Plan) -> stainlib.StainPolicy:
    declared = plan.stain_declared
    if declared.method == "none":
        return declared
    if not isinstance(declared, DeferredMacenkoPolicy):
        return declared
    if not plan.stain_reference_key:
        raise FeatureError("stain_reference_missing: the reference has not been fitted yet")
    data = get_store().get_bytes(plan.stain_reference_key)
    if sha256_hex(data) != plan.stain_reference_sha256:
        raise FeatureSetIntegrityError(f"feature set {plan.id}: stain reference object failed its sha256")
    ref = stainlib.MacenkoReference.from_json(json.loads(data))
    if ref.sha256 != plan.stain_reference_sha256:
        raise FeatureSetIntegrityError(f"feature set {plan.id}: stain reference content does not match its sha256")
    return declared.resolve(ref)


def effective_stain_policy(fs: FeatureSet | str) -> stainlib.StainPolicy:
    """The stain policy the set's artifacts were produced with (macenko: with its fitted reference)."""
    with session_scope() as db:
        row = db.get(FeatureSet, _fs_id(fs))
        plan = _plan_of(db, row)
    return _effective_stain(plan)


def extraction_kwargs(fs: FeatureSet | str) -> dict:
    """Keyword arguments for :func:`extract_slide` that reproduce this set's extraction on any slide
    (inference bundles). Needs the stain reference to be fitted (macenko)."""
    with session_scope() as db:
        plan = _plan_of(db, db.get(FeatureSet, _fs_id(fs)))
    return {"encoder_id": plan.encoder_id, "weights_sha256": plan.weights_sha256,
            "encoder_spec_sha256": plan.encoder_spec_sha256, "patch_policy": plan.patch_policy,
            "sampling_policy": plan.patch_policy.sampling, "stain_policy": _effective_stain(plan),
            "device": plan.extraction.get("device", "cpu"), "precision": plan.env_json.get("precision", "fp32"),
            "pixel_mode": plan.extraction.get("pixel_mode", "read"), "encoder_config": plan.encoder_config or None,
            "batch_size": plan.extraction.get("batch_size"), "weights_config_sha256": plan.weights_config_sha256}


def feature_set_identity(fs: FeatureSet | str) -> dict:
    """JSON identity of a ready set's extraction (for inference bundle content and run identity)."""
    with session_scope() as db:
        row = db.get(FeatureSet, _fs_id(fs))
        plan = _plan_of(db, row)
        spec_sha = row.spec_sha256
    stain = _effective_stain(plan)
    return _jsonable({"feature_set_id": plan.id, "spec_sha256": spec_sha, "execution_mode": plan.execution_mode,
                      "encoder_id": plan.encoder_id, "encoder_spec_sha256": plan.encoder_spec_sha256,
                      "weights_sha256": plan.weights_sha256, "weights_config_sha256": plan.weights_config_sha256,
                      "encoder_config": plan.encoder_config, "patch_policy": plan.patch_policy.to_json(),
                      "policy_sha256": plan.patch_policy.policy_sha256, "stain_policy": stain.to_json(),
                      "stain_policy_sha256": stain.policy_sha256, "extraction": plan.extraction,
                      "extraction_env": plan.env_json, "extraction_env_sha256": plan.env_sha256})


# --------------------------------------------------------------------------- build


def _fixture_labels(db: Session, plan: _Plan) -> dict[str, int]:
    """THE ONLY label access of a feature-set build: ``synthetic_pipeline_test`` only.

    Fixture labels (1 = positive class) from the frozen manifest; they reach embeddings only
    through :func:`dermpath.ml.fixture.fixture_context`, which refuses any slide that is not
    demo_synthetic synthetic tiles."""
    if plan.execution_mode != SYNTHETIC_MODE or plan.dataset_version_id is None:
        return {}
    from ..datasets import positive_class

    dv = db.get(DatasetVersion, plan.dataset_version_id)
    manifest = dv.manifest_json or {}
    pos = manifest.get("positive_class") or positive_class(manifest.get("config") or {})
    return {it["slide_id"]: int(it.get("label_value") == pos) for it in manifest.get("items") or []}


def check_extraction_env(env_json: dict, env_sha256: str, extraction: dict, *, what: str = "feature set",
                         remedy: str = "create a new feature set in this environment") -> None:
    """Raise ``FeatureError("extraction_env_changed: …")`` unless this worker's extraction environment (library
    versions, device class, precision, machine, torch CPU threads) is the pinned one."""
    env_json = env_json or {}
    device = extraction.get("device") or env_json.get("device_class") or "cpu"
    env, env_sha = extraction_env(device, env_json.get("precision", "fp32"))
    if env_sha != env_sha256:
        diff = {k: [env_json.get("libraries", {}).get(k), v] for k, v in env.get("libraries", {}).items()
                if env_json.get("libraries", {}).get(k) != v}
        for k in ("device_class", "precision", "machine", "cuda"):
            if env_json.get(k) != env.get(k):
                diff[k] = [env_json.get(k), env.get(k)]
        raise FeatureError(f"extraction_env_changed: this worker's extraction environment differs from the {what}'s "
                           f"({diff}); {remedy}")
    threads = extraction.get("cpu_threads")
    if threads is not None and devices.cpu_threads() != threads:
        raise FeatureError(f"extraction_env_changed: WB_ML_CPU_THREADS is {devices.cpu_threads()}, the {what} "
                           f"pins {threads}; {remedy}")


def check_extractor_version(extraction: dict, *, what: str = "feature set",
                            remedy: str = "create a new feature set") -> None:
    """Raise ``FeatureError("extraction_code_changed: …")`` when the pinned ``extractor_version`` is not the one this
    worker runs (:data:`EXTRACTOR_VERSION`): artifacts of two extractor versions never mix in one set or bundle."""
    pinned = (extraction or {}).get("extractor_version")
    if pinned is not None and pinned != EXTRACTOR_VERSION:
        raise FeatureError(f"extraction_code_changed: the {what} pins {pinned}, this worker runs {EXTRACTOR_VERSION}; "
                           f"{remedy}")


def _check_env(plan: _Plan) -> None:
    check_extractor_version(plan.extraction)
    check_extraction_env(plan.env_json, plan.env_sha256, {**plan.extraction,
                                                          "device": plan.extraction.get("device", "cpu")})


def _fenced(ctx: JobContext | None, db: Session) -> None:
    if ctx is not None:
        ctx.assert_lease(db)


def _fit_stain_reference(plan: _Plan, ctx: JobContext | None) -> None:
    """Fit the macenko-v1 reference on train-split slides only and pin it on the set."""
    declared = plan.stain_declared
    fit = declared.fit
    batch = int(plan.extraction.get("batch_size") or DEFAULT_BATCH_SIZE)
    progress = _Progress(ctx, 0.0, 0.05, "stain reference: ")
    ids = list(fit.get("train_slide_ids") or [])

    def batches():
        for n, sid in enumerate(ids):
            snap = plan.snapshots.get(sid)
            if snap is None:
                raise FeatureError(f"stain reference slide {sid} is not part of the feature set")
            prep = _prepare(snap, patch_policy=plan.patch_policy, sampling=plan.patch_policy.sampling,
                            pixel_mode="read", reads_pixels=True)
            try:
                if not len(prep.sampled):
                    continue
                # Content-keyed (the slide sha256) unless the plan predates the rule (then its declared id key).
                key = snap["slide_sha256"] if fit.get("selection_key") == STAIN_REFERENCE_SELECTION_KEY else sid
                ranks = seeded_ranks(prep.sampled.coords, int(fit.get("seed", 0)), f"stain-reference|{key}")
                idx = np.sort(np.argsort(ranks, kind="stable")[:int(fit.get("patches_per_slide",
                                                                            STAIN_REFERENCE_PATCHES_PER_SLIDE))])
                for _, patches, _ in iter_patch_batches(prep.osr, prep.sampled.subset(idx), prep.plan,
                                                        batch_size=batch, policy=plan.patch_policy):
                    if len(patches):
                        yield patches
            finally:
                prep.close()
            progress.tick((n + 1) / max(len(ids), 1), f"{n + 1}/{len(ids)} train slides")

    try:
        ref = stainlib.fit_reference(batches(), splits="train", params=stainlib.MacenkoParams(**fit.get("params", {})))
    except stainlib.StainError as exc:
        raise FeatureError(f"stain_reference_unfittable: {exc}") from exc
    key, sha = get_store().put_content_addressed(f"projects/{plan.project_id}/stain-references",
                                                 canonical_json(ref.to_json()), ".json")
    if sha != ref.sha256:  # pragma: no cover - canonical JSON of the reference is its identity
        raise FeatureSetIntegrityError("stain reference bytes do not hash to the reference sha256")
    with session_scope() as db:
        row = db.get(FeatureSet, plan.id)
        if row.stain_reference_key is None:
            row.stain_reference_key, row.stain_reference_sha256 = key, sha
        _fenced(ctx, db)
    plan.stain_reference_key, plan.stain_reference_sha256 = key, sha


def _extract_item(plan: _Plan, slide_id: str, *, loaded, stain_policy, fixture_label, ctx, progress,
                  use_cache: bool = True) -> SlideFeatures:
    return _extract(plan.snapshots[slide_id], project_id=plan.project_id, encoder_id=plan.encoder_id,
                    encoder_spec=plan.encoder_spec, encoder_spec_sha256=plan.encoder_spec_sha256,
                    weights_sha256=plan.weights_sha256, weights_config_sha256=plan.weights_config_sha256,
                    encoder_config=plan.encoder_config, loaded=loaded, patch_policy=plan.patch_policy,
                    stain_policy=stain_policy, device=plan.extraction.get("device", "cpu"),
                    precision=plan.env_json.get("precision", "fp32"), env_sha256=plan.env_sha256,
                    extraction=plan.extraction, fixture_label=fixture_label, use_cache=use_cache, ctx=ctx,
                    progress=progress, job_id=ctx.job_id if ctx else None)


def _coverage_summary(cov: dict | None) -> dict | None:
    if cov is None:
        return None
    keys = ("calibrated", "n_candidates", "n_sampled", "n_sampled_before_read_filters", "tissue_area_um2",
            "candidate_tissue_fraction", "sampled_tissue_fraction", "tissue_within_radius_of_sample_fraction",
            "radius_um", "edge_uncovered_tissue_area_um2", "fragments_total", "fragments_without_candidate",
            "fragments_without_sampled_patch", "fragments_rescued", "sampled_origins", "rejected_at_read",
            "mask_um_per_px", "mask_coarse", "excluded_area_um2")
    return {"version": COVERAGE_VERSION, **{k: cov.get(k) for k in keys}}


def build_feature_set(fs_id: str, ctx: JobContext | None = None) -> dict:
    """Build every pending slide of a feature set (resumable, cancellable, label-free).

    Returns a summary. Per-slide deterministic failures leave the item ``failed`` and the set
    ``failed`` (raises :class:`FeatureError` at the end); identity failures (weights,
    environment, mode) fail the whole set at once."""
    t0 = time.perf_counter()
    try:
        return _build(fs_id, ctx, t0)
    except Exception as exc:
        from ..jobs.registry import JobCanceled, LeaseLost

        if isinstance(exc, (JobCanceled, LeaseLost)):
            raise  # the queue settles the set (settle hook); a lost lease must not write
        if ctx is None or isinstance(exc, (FeatureError, ModeMismatch, EncoderUnavailable, SyntheticSignalForbidden,
                                           devices.DeviceUnavailable)):
            try:
                with session_scope() as db:
                    row = db.get(FeatureSet, fs_id)
                    if row is not None and row.status == "building":
                        row.status, row.error = "failed", f"{type(exc).__name__}: {exc}"[:4000]
                        _fenced(ctx, db)
            except Exception:  # noqa: BLE001 - never mask the original error
                log.exception("could not mark feature set %s failed", fs_id)
        raise


def _build(fs_id: str, ctx: JobContext | None, t0: float) -> dict:
    with session_scope() as db:
        row = db.get(FeatureSet, fs_id)
        if row is None:
            raise FeatureError(f"feature set {fs_id} does not exist")
        if row.status == "failed":
            row.status, row.error = "building", None
            _fenced(ctx, db)
        plan = _plan_of(db, row)
        labels = _fixture_labels(db, plan) if plan.execution_mode == SYNTHETIC_MODE else {}
    snaps = list(plan.snapshots.values())
    check_modes(execution_mode=plan.execution_mode, encoder_spec=plan.encoder_spec, snaps=snaps,
                dataset=plan.dataset_version_id is not None,
                allow_uncalibrated=plan.patch_policy.allow_uncalibrated and plan.execution_mode == SUPERVISED_MODE)
    _check_env(plan)
    loaded = None
    if not plan.encoder_spec.synthetic:
        loaded = load_encoder(plan.encoder_id, weights_sha256=plan.weights_sha256,
                              encoder_spec_sha256=plan.encoder_spec_sha256,
                              device=plan.extraction.get("device", "cpu"),
                              precision=plan.env_json.get("precision", "fp32"),
                              weights_config_sha256=plan.weights_config_sha256)
    if isinstance(plan.stain_declared, DeferredMacenkoPolicy) and plan.stain_reference_key is None:
        if plan.status == "ready":  # pragma: no cover - a ready macenko set always has its reference
            raise FeatureSetIntegrityError("ready feature set without a stain reference")
        _fit_stain_reference(plan, ctx)
    stain_policy = _effective_stain(plan)
    if plan.status == "ready":
        return _repair(plan, loaded=loaded, stain_policy=stain_policy, labels=labels, ctx=ctx, t0=t0)

    todo = [it for it in plan.items if it[2] != "done"]
    n_items = len(plan.items)
    failures: list[dict] = []
    built = hits = 0
    for k, (item_id, slide_id, _status, _art) in enumerate(todo):
        base = 0.05 + 0.9 * (n_items - len(todo) + k) / max(n_items, 1)
        progress = _Progress(ctx, base, 0.9 / max(n_items, 1), f"slide {n_items - len(todo) + k + 1}/{n_items}: ")
        progress.tick(0.0, "starting", force=True)
        try:
            feats = _extract_item(plan, slide_id, loaded=loaded, stain_policy=stain_policy,
                                  fixture_label=labels.get(slide_id) if plan.execution_mode == SYNTHETIC_MODE else None,
                                  ctx=ctx, progress=progress)
        except (FeatureError, SamplingError, stainlib.StainError) as exc:
            if isinstance(exc, FeatureSetIntegrityError) or str(exc).startswith(("input_changed", "extraction_env",
                                                                                 "extraction_code_changed")):
                raise
            failures.append({"slide_id": slide_id, "error": str(exc)})
            with session_scope() as db:
                item = db.get(FeatureSetItem, item_id)
                if item.status != "done":  # a concurrent build may have finished it
                    item.status, item.error = "failed", str(exc)[:4000]
                _fenced(ctx, db)
            continue
        built += 1
        hits += int(feats.cache_hit)
        try:
            with session_scope() as db:
                item = db.get(FeatureSetItem, item_id)
                if item.status == "done":  # built concurrently (e.g. two runs building one set inline): keep it
                    _fenced(ctx, db)
                    continue
                item.status, item.artifact_id, item.error = "done", feats.artifact_id, None
                item.coverage_json = _coverage_summary(feats.coverage)
                item.stats_json = _jsonable({k: feats.stats.get(k) for k in (
                    "read_seconds", "pixel_read_seconds", "preprocess_seconds", "embed_seconds", "write_seconds",
                    "total_seconds", "patches_per_second", "n_patches", "n_sampled", "n_candidates",
                    "peak_rss_bytes", "peak_rss_delta_bytes", "rejected_at_read", "pixels_read", "mask_source",
                    "calibrated", "stain_source_sha256")} | {"cache_hit": bool(feats.cache_hit)})
                item.done_at = utcnow()
                _fenced(ctx, db)
        except (IntegrityError, ImmutableRecordError):
            # A concurrent builder marked the item done between our read and our commit (the done item is
            # immutable): it was built concurrently, which is not a failure of this build.
            with session_scope() as db:
                if db.get(FeatureSetItem, item_id).status != "done":
                    raise
    summary = {"feature_set_id": plan.id, "slides": n_items, "built_now": built, "cache_hits": hits,
               "skipped_done": n_items - len(todo), "failed": failures, "seconds": round(time.perf_counter() - t0, 3)}
    if failures:
        with session_scope() as db:
            row = db.get(FeatureSet, plan.id)
            if row.status == "building":
                row.status = "failed"
                row.error = f"{len(failures)} slide(s) failed: " + "; ".join(
                    f"{f['slide_id']}: {f['error']}" for f in failures[:5])[:3900]
            _fenced(ctx, db)
        raise FeatureError(f"feature set {plan.id}: {len(failures)} slide(s) failed "
                           f"({failures[0]['slide_id']}: {failures[0]['error']})")
    with session_scope() as db:  # items are committed above; the set is marked ready afterwards
        pending = db.scalars(select(FeatureSetItem.slide_id).where(FeatureSetItem.feature_set_id == plan.id,
                                                                  FeatureSetItem.status != "done")).all()
        if pending:
            raise FeatureError(f"feature set {plan.id}: slides still pending: {sorted(pending)[:10]}")
        row = db.get(FeatureSet, plan.id)
        if row.status == "failed":
            # Every item is done: a concurrent builder that failed (and marked the set failed) did not leave the set
            # incomplete. Resume it (failed -> building) and finish it, so no builder reports a status the row lacks.
            row.status = "building"
            db.flush()
        if row.status == "building":
            row.status, row.ready_at, row.error = "ready", utcnow(), None
        _fenced(ctx, db)
        final = row.status
    if ctx is not None:
        ctx.progress(1.0, f"feature set {final}: {n_items} slides")
    summary["status"] = final
    return summary


def _repair(plan: _Plan, *, loaded, stain_policy, labels, ctx, t0) -> dict:
    """On a ready set: verify every pinned artifact; re-extract those whose objects are missing or
    corrupt (a new generation row under the same cache key; items stay pinned)."""
    repaired, ok = [], 0
    with session_scope() as db:
        arts = {a.id: a for a in db.scalars(select(FeatureArtifact).where(
            FeatureArtifact.id.in_([it[3] for it in plan.items if it[3]]))).all()}
    for k, (_iid, slide_id, _st, art_id) in enumerate(plan.items):
        art = arts.get(art_id)
        if art is not None and _resolve_valid_artifact(art) is not None:
            ok += 1
            continue
        progress = _Progress(ctx, k / max(len(plan.items), 1), 1.0 / max(len(plan.items), 1), "repair: ")
        feats = _extract_item(plan, slide_id, loaded=loaded, stain_policy=stain_policy,
                              fixture_label=labels.get(slide_id) if plan.execution_mode == SYNTHETIC_MODE else None,
                              ctx=ctx, progress=progress)
        new = None
        if feats.artifact_id:
            with session_scope() as db:
                new = db.get(FeatureArtifact, feats.artifact_id)
        reproducible = art is not None and new is not None and _reproduces(new, art)
        entry = {"slide_id": slide_id, "pinned_artifact_id": art_id, "new_artifact_id": feats.artifact_id,
                 "reproducible": reproducible}
        if not reproducible:
            # Never served in place of the pinned numbers (load_slide_features refuses): the set needs a rebuild.
            entry["error"] = ("repair_not_reproducible: the re-extracted embeddings or coordinates differ from the "
                              "pinned artifact's sha256; reads of this slide are refused; create a new feature set")
            log.warning("feature set %s slide %s: %s", plan.id, slide_id, entry["error"])
        repaired.append(entry)
    return {"feature_set_id": plan.id, "status": "ready", "verified": ok, "repaired": repaired,
            "not_reproducible": [r["slide_id"] for r in repaired if not r["reproducible"]],
            "seconds": round(time.perf_counter() - t0, 3)}


def _reproduces(candidate: FeatureArtifact, pinned: FeatureArtifact) -> bool:
    """A replacement generation stands in for a pinned artifact only when it holds the identical bytes."""
    return (candidate.cache_key == pinned.cache_key and candidate.embeddings_sha256 == pinned.embeddings_sha256
            and candidate.quality_sha256 == pinned.quality_sha256)


@register(BUILD_JOB, description="Build a frozen feature set: label-free, resumable per slide, bounded memory")
def build_job(ctx: JobContext, payload: dict) -> dict:
    refuse_label_payload(payload)  # design §1 invariant 4
    fs_id = payload.get("feature_set_id")
    if not fs_id:
        raise PermanentJobError("payload.feature_set_id is required")
    try:
        return build_feature_set(fs_id, ctx)
    except ModeMismatch as exc:
        raise PermanentJobError(f"mode_mismatch: {exc.message}") from exc
    except EncoderUnavailable as exc:
        raise PermanentJobError(f"encoder_unavailable: {exc}") from exc
    except SyntheticSignalForbidden as exc:
        raise PermanentJobError(f"synthetic_signal_forbidden: {exc}") from exc
    except devices.DeviceUnavailable as exc:
        raise PermanentJobError(f"device_unavailable: {exc}") from exc
    except (FeatureError, ValueError) as exc:
        raise PermanentJobError(str(exc)) from exc


@register_settle_hook(BUILD_JOB)
def settle_feature_set(db: Session, job, status: str, error: str | None) -> None:
    """A build the queue ended failed or canceled leaves the set ``failed`` (never ``building``).
    Idempotent; a ready set is never touched."""
    fs = db.get(FeatureSet, (job.payload_json or {}).get("feature_set_id") or "")
    if fs is None or fs.status != "building":
        return
    fs.status = "failed"
    fs.error = f"{status}: {error or status}"[:4000]


# --------------------------------------------------------------------------- reading


def _resolve_valid_artifact(art: FeatureArtifact) -> FeatureArtifact | None:
    """``art`` if its objects verify, else the newest valid generation under the same cache key that REPRODUCES the
    pinned bytes (same embeddings and coords/quality sha256). A generation with other numbers (a non-bit-identical
    re-extraction, or a row appended to the append-only table) is never served in place of the pinned artifact."""
    if _artifact_ok(art):
        return art
    with session_scope() as db:
        rows = db.scalars(select(FeatureArtifact).where(FeatureArtifact.project_id == art.project_id,
                                                        FeatureArtifact.cache_key == art.cache_key,
                                                        FeatureArtifact.generation > art.generation)
                          .order_by(FeatureArtifact.generation.desc())).all()
    return next((r for r in rows if _reproduces(r, art) and _artifact_ok(r)), None)


def _newer_generations(art: FeatureArtifact) -> list[str]:
    with session_scope() as db:
        return list(db.scalars(select(FeatureArtifact.id).where(FeatureArtifact.project_id == art.project_id,
                                                                FeatureArtifact.cache_key == art.cache_key,
                                                                FeatureArtifact.generation > art.generation)).all())


def require_ready(db: Session, fs: FeatureSet, slide_ids) -> None:
    """Raise :class:`FeatureSetNotReady` unless the set is ready and every slide in ``slide_ids`` is built."""
    statuses = dict(db.execute(select(FeatureSetItem.slide_id, FeatureSetItem.status)
                               .where(FeatureSetItem.feature_set_id == fs.id)).all())
    missing = sorted(s for s in set(slide_ids) if statuses.get(s) != "done")
    if fs.status != "ready":  # report every slide still to build (and requested slides outside the set)
        missing = sorted(set(missing) | {s for s, st in statuses.items() if st != "done"})
    if fs.status != "ready" or missing:
        raise FeatureSetNotReady(missing, feature_set_id=fs.id, status=fs.status)


_IDENTITY_CACHE: OrderedDict[tuple, dict] = OrderedDict()
_IDENTITY_LOCK = threading.Lock()


def _expected_identity(db: Session, row: FeatureSet) -> dict:
    """What every artifact of the set must carry (cached: a set's specification never changes)."""
    ck = (row.id, row.spec_sha256, row.stain_reference_sha256)
    with _IDENTITY_LOCK:
        hit = _IDENTITY_CACHE.get(ck)
    if hit is not None:
        return hit
    plan = _plan_of(db, row)
    ident = {"encoder_id": plan.encoder_id, "encoder_spec_sha256": plan.encoder_spec_sha256,
             "weights_sha256": plan.weights_sha256, "policy_sha256": plan.patch_policy.policy_sha256,
             "stain_policy_sha256": _effective_stain(plan).policy_sha256, "extraction_env_sha256": plan.env_sha256,
             "extractor_version": plan.extraction.get("extractor_version"),
             "slides": {sid: {"mask_sha256": s.get("mask_sha256"),
                              "excluded_regions_sha256": s.get("excluded_regions_sha256")}
                        for sid, s in plan.snapshots.items()}}
    with _IDENTITY_LOCK:
        _IDENTITY_CACHE[ck] = ident
        while len(_IDENTITY_CACHE) > 64:
            _IDENTITY_CACHE.popitem(last=False)
    return ident


def load_slide_features(fs: FeatureSet | str, slide_id: str) -> SlideFeatures:
    """The pinned embeddings of one slide (memory-mapped), verified against the set's identity.

    Raises :class:`FeatureSetNotReady` if the slide is not built and
    :class:`FeatureSetIntegrityError` if the artifact's identity differs from the set's or
    its objects fail their sha256 (a newer valid generation under the same cache key, written
    by a repair build, is served instead)."""
    fs_id = _fs_id(fs)
    with session_scope() as db:
        row = db.get(FeatureSet, fs_id)
        if row is None:
            raise FeatureError(f"feature set {fs_id} does not exist")
        item = db.scalars(select(FeatureSetItem).where(FeatureSetItem.feature_set_id == fs_id,
                                                       FeatureSetItem.slide_id == slide_id)).first()
        if item is None or item.status != "done" or not item.artifact_id:
            raise FeatureSetNotReady([slide_id], feature_set_id=fs_id, status=row.status)
        art = db.get(FeatureArtifact, item.artifact_id)
        ident = _expected_identity(db, row)
        item_sha = item.slide_sha256
    if art is None:
        raise FeatureSetIntegrityError(f"feature set {fs_id}: artifact {item.artifact_id} of slide {slide_id} is gone")
    snap = ident["slides"].get(slide_id) or {}
    expected = {"slide_sha256": item_sha, **{k: ident[k] for k in (
        "encoder_id", "encoder_spec_sha256", "weights_sha256", "policy_sha256", "stain_policy_sha256",
        "extraction_env_sha256")}, "mask_sha256": snap.get("mask_sha256"),
        "excluded_regions_sha256": snap.get("excluded_regions_sha256")}
    diff = {k: [v, getattr(art, k)] for k, v in expected.items() if getattr(art, k) != v}
    pinned_version = ident.get("extractor_version")
    if pinned_version is not None and (art.key_extra_json or {}).get("extractor_version") != pinned_version:
        diff["extractor_version"] = [pinned_version, (art.key_extra_json or {}).get("extractor_version")]
    if diff:
        raise FeatureSetIntegrityError(f"feature set {fs_id}: artifact {art.id} of slide {slide_id} does not match "
                                       f"the set's identity: {sorted(diff)}")
    valid = _resolve_valid_artifact(art)
    if valid is None:
        if _newer_generations(art):
            raise FeatureSetIntegrityError(
                f"repair_not_reproducible: feature set {fs_id}: the pinned artifact {art.id} of slide {slide_id} is "
                f"missing or corrupt and no newer generation reproduces its embeddings sha256 "
                f"{(art.embeddings_sha256 or '')[:12]}; its numbers are never replaced silently; create a new "
                "feature set")
        raise FeatureSetIntegrityError(f"feature set {fs_id}: artifact objects of slide {slide_id} are missing or "
                                       "corrupt; POST /feature-sets/{id}/build re-extracts them (repair)")
    out = _materialise(valid)
    if valid.id != art.id:
        out.meta = {**out.meta, "repaired_from_artifact_id": art.id}
    return out


# --------------------------------------------------------------------------- serialisation


def _stats(values: list[float]) -> dict | None:
    vals = [float(v) for v in values if v is not None]
    if not vals:
        return None
    return {"min": round(min(vals), 6), "median": round(float(np.median(vals)), 6), "max": round(max(vals), 6),
            "n": len(vals)}


def coverage_diagnostics(items: list[FeatureSetItem], snapshots: dict[str, dict]) -> dict:
    """Aggregated coverage of a set: per-slide table, min/median/max, zero-patch slides, slides below
    the coverage floor, uncalibrated and coarse-mask counts, rejections at read."""
    rows = []
    rejected: dict[str, int] = {}
    for it in items:
        cov, st = it.coverage_json or {}, it.stats_json or {}
        snap = snapshots.get(it.slide_id) or {}
        for k, v in (cov.get("rejected_at_read") or {}).items():
            rejected[k] = rejected.get(k, 0) + int(v or 0)
        rows.append({"slide_id": it.slide_id, "status": it.status, "n_patches": st.get("n_patches"),
                     "n_candidates": st.get("n_candidates"), "n_sampled": st.get("n_sampled"),
                     "sampled_tissue_fraction": cov.get("sampled_tissue_fraction"),
                     "tissue_within_radius_of_sample_fraction": cov.get("tissue_within_radius_of_sample_fraction"),
                     "fragments_without_candidate": cov.get("fragments_without_candidate"),
                     "fragments_without_sampled_patch": cov.get("fragments_without_sampled_patch"),
                     "rejected_at_read": cov.get("rejected_at_read"), "mask_coarse": cov.get("mask_coarse"),
                     "calibrated": snap.get("calibrated"), "mask_source": st.get("mask_source"),
                     "cache_hit": st.get("cache_hit"), "patches_per_second": st.get("patches_per_second"),
                     "error": it.error})
    done = [r for r in rows if r["status"] == "done"]
    radius = [r["tissue_within_radius_of_sample_fraction"] for r in done]
    return {
        "per_slide": rows,
        "n_patches": _stats([r["n_patches"] for r in done]),
        "sampled_tissue_fraction": _stats([r["sampled_tissue_fraction"] for r in done]),
        "tissue_within_radius_of_sample_fraction": _stats(radius),
        "slides_with_zero_patches": sorted(r["slide_id"] for r in done if not r["n_patches"]),
        "coverage_floor": {"metric": COVERAGE_FLOOR_METRIC, "value": COVERAGE_FLOOR,
                           "note": "research default, not tuned"},
        "slides_below_coverage_floor": sorted(r["slide_id"] for r in done
                                              if r["tissue_within_radius_of_sample_fraction"] is not None
                                              and r["tissue_within_radius_of_sample_fraction"] < COVERAGE_FLOOR),
        "slides_without_coverage": sorted(r["slide_id"] for r in done if r["tissue_within_radius_of_sample_fraction"]
                                          is None),
        "uncalibrated_count": sum(1 for s in snapshots.values() if not s.get("calibrated")),
        "mask_coarse_count": sum(1 for r in done if r["mask_coarse"]),
        "rejected_at_read": rejected,
        "total_patches": int(sum(r["n_patches"] or 0 for r in done)),
    }


def staleness(db: Session, fs: FeatureSet) -> dict:
    """QC changes since the snapshot. They never change the set; a new set picks them up."""
    changed = []
    for snap in fs.input_snapshot_json.get("slides") or []:
        now = live_qc(db, snap["slide_id"])
        diffs = [k for k in ("qc_review_id", "mask_sha256", "excluded_regions_sha256") if now[k] != snap.get(k)]
        if diffs:
            changed.append({"slide_id": snap["slide_id"], "changed": diffs,
                            "snapshot_qc_review_id": snap.get("qc_review_id"),
                            "live_qc_review_id": now["qc_review_id"]})
    return {"stale": bool(changed), "qc_changed_since_snapshot": changed,
            "note": "QC changes after the snapshot never change this feature set; create a new one to use them"}


def feature_set_dict(db: Session, fs: FeatureSet, *, detail: bool = True) -> dict:
    items = db.scalars(select(FeatureSetItem).where(FeatureSetItem.feature_set_id == fs.id)
                       .order_by(FeatureSetItem.slide_id)).all()
    counts = {s: 0 for s in ("pending", "done", "failed")}
    for it in items:
        counts[it.status] = counts.get(it.status, 0) + 1
    job = db.get(Job, fs.job_id) if fs.job_id else None
    synthetic = fs.execution_mode == SYNTHETIC_MODE or bool((fs.encoder_spec_json or {}).get("synthetic"))
    snapshots = {s["slide_id"]: s for s in (fs.input_snapshot_json or {}).get("slides") or []}
    out = {
        "id": fs.id, "project_id": fs.project_id, "name": fs.name, "execution_mode": fs.execution_mode,
        "dataset_version_id": fs.dataset_version_id, "encoder_id": fs.encoder_id,
        "encoder_spec_sha256": fs.encoder_spec_sha256, "weights_sha256": fs.weights_sha256,
        "weights_config_sha256": (fs.encoder_spec_json or {}).get("weights_config_sha256"),
        "policy_sha256": fs.policy_sha256, "stain_policy_sha256": fs.stain_policy_sha256,
        "stain_reference_sha256": fs.stain_reference_sha256, "extraction_env_sha256": fs.extraction_env_sha256,
        "input_snapshot_sha256": fs.input_snapshot_sha256, "spec_sha256": fs.spec_sha256, "status": fs.status,
        "error": fs.error, "job_id": fs.job_id,
        "job": {"status": job.status, "progress": job.progress, "message": job.progress_message} if job else None,
        "created_by": fs.created_by, "created_at": fs.created_at.isoformat() if fs.created_at else None,
        "ready_at": fs.ready_at.isoformat() if fs.ready_at else None, "counts": {"slides": len(items), **counts},
        "synthetic": synthetic, "banner": PIPELINE_TEST_BANNER if synthetic else None,
        "label_free": fs.execution_mode != SYNTHETIC_MODE, "note": NOT_A_LABEL_NOTE,
    }
    if detail:
        validations = db.scalars(select(FeatureSetValidation).where(FeatureSetValidation.feature_set_id == fs.id)
                                 .order_by(FeatureSetValidation.created_at.desc())).all()
        out.update({
            "patch_policy": fs.patch_policy_json, "stain_policy": fs.stain_policy_json,
            "encoder_spec": fs.encoder_spec_json, "extraction_env": fs.extraction_env_json,
            "qc_source": (fs.input_snapshot_json or {}).get("qc_source"),
            "coverage": coverage_diagnostics(items, snapshots),
            "validations": [{"id": v.id, "job_id": v.job_id, "seed": v.seed, "slide_ids": v.slide_ids_json,
                             "passed": v.passed, "summary": (v.result_json or {}).get("summary"),
                             "created_at": v.created_at.isoformat()} for v in validations],
        })
    return out


# --------------------------------------------------------------------------- technical validation


def _cosines(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    a, b = np.asarray(a, dtype=np.float64), np.asarray(b, dtype=np.float64)
    na, nb = np.linalg.norm(a, axis=1), np.linalg.norm(b, axis=1)
    denom = np.maximum(na * nb, 1e-300)
    cos = np.sum(a * b, axis=1) / denom
    both_zero = (na == 0) & (nb == 0)
    cos[both_zero] = 1.0
    return cos


def validate_feature_set(fs_id: str, ctx: JobContext | None = None, *, seed: int = 0, n_slides: int = 2,
                         max_patches: int | None = None, created_by: str = "system:worker") -> dict:
    """Re-extract a seeded subset of a ready set and compare with the stored artifacts.

    ``max_patches`` None re-runs the full pipeline (read filters included) on each chosen
    slide; otherwise the sampled coordinates are re-derived (their sha must match) and a
    seeded subset of ``max_patches`` stored patches is re-read and re-embedded. Records max
    absolute difference, cosine, identical coords, throughput, peak RSS and cache reuse, and
    appends a :class:`~dermpath.ml.engine_models.FeatureSetValidation` row."""
    t_start = time.perf_counter()
    with session_scope() as db:
        row = db.get(FeatureSet, fs_id)
        if row is None:
            raise FeatureError(f"feature set {fs_id} does not exist")
        if row.status != "ready":
            raise FeatureSetNotReady([], feature_set_id=fs_id, status=row.status)
        plan = _plan_of(db, row)
        project_id = row.project_id
    _check_env(plan)
    done = [it[1] for it in plan.items if it[2] == "done"]
    ranked = sorted(done, key=lambda s: hashlib.sha256(f"validate|{seed}|{s}".encode()).hexdigest())
    chosen = sorted(ranked[:max(1, int(n_slides))])
    loaded = None if plan.encoder_spec.synthetic else load_encoder(
        plan.encoder_id, weights_sha256=plan.weights_sha256, encoder_spec_sha256=plan.encoder_spec_sha256,
        device=plan.extraction.get("device", "cpu"), precision=plan.env_json.get("precision", "fp32"),
        weights_config_sha256=plan.weights_config_sha256)
    stain_policy = _effective_stain(plan)
    labels = {}
    if plan.execution_mode == SYNTHETIC_MODE:
        with session_scope() as db:
            labels = _fixture_labels(db, plan)
    exact = plan.encoder_spec.kind in EXACT_KINDS
    tol = {"max_abs_diff": 0.0 if exact else TORCH_MAX_ABS_TOL, "cosine_min": 1.0 if exact else TORCH_COSINE_MIN,
           "rule": "bit-identical (numpy encoder)" if exact else "torch: max_abs_diff and cosine tolerances"}
    per_slide = []
    for k, sid in enumerate(chosen):
        progress = _Progress(ctx, k / len(chosen), 1.0 / len(chosen), f"validate {k + 1}/{len(chosen)}: ")
        stored = load_slide_features(fs_id, sid)
        rss0, t0 = _peak_rss_bytes(), time.perf_counter()
        label = labels.get(sid) if plan.execution_mode == SYNTHETIC_MODE else None
        only = None
        prep_sha_match = None
        if max_patches is not None and stored.n_patches > int(max_patches):
            ranks = seeded_ranks(stored.coords, seed, f"validate|{sid}")
            pick = np.sort(np.argsort(ranks, kind="stable")[:int(max_patches)])
            prep = _prepare(plan.snapshots[sid], patch_policy=plan.patch_policy, sampling=plan.patch_policy.sampling,
                            pixel_mode=plan.extraction.get("pixel_mode", "read"),
                            reads_pixels=plan.encoder_spec.reads_pixels)
            try:
                prep_sha_match = prep.sampled.sha256 == stored.meta.get("fields", {}).get("coords_sha256")
                lookup = {(int(x), int(y)): i for i, (x, y) in enumerate(prep.sampled.coords.tolist())}
                missing = [tuple(c) for c in stored.coords[pick].tolist() if tuple(c) not in lookup]
                only = np.array([lookup[tuple(c)] for c in stored.coords[pick].tolist() if tuple(c) in lookup],
                                dtype=np.int64)
            finally:
                prep.close()
            recomputed = _extract(plan.snapshots[sid], project_id=project_id, encoder_id=plan.encoder_id,
                                  encoder_spec=plan.encoder_spec, encoder_spec_sha256=plan.encoder_spec_sha256,
                                  weights_sha256=plan.weights_sha256, weights_config_sha256=plan.weights_config_sha256,
                                  encoder_config=plan.encoder_config, loaded=loaded, patch_policy=plan.patch_policy,
                                  stain_policy=stain_policy, device=plan.extraction.get("device", "cpu"),
                                  precision=plan.env_json.get("precision", "fp32"), env_sha256=plan.env_sha256,
                                  extraction=plan.extraction, fixture_label=label, use_cache=False, store=False,
                                  only_rows=np.sort(only), ctx=ctx, progress=progress)
            ref_coords, ref_emb = stored.coords[pick], np.asarray(stored.embeddings[pick])
            coords_identical = (not missing and recomputed.coords.shape == ref_coords.shape
                                and bool(np.array_equal(recomputed.coords, ref_coords)))
            mode = "subset"
        else:
            recomputed = _extract(plan.snapshots[sid], project_id=project_id, encoder_id=plan.encoder_id,
                                  encoder_spec=plan.encoder_spec, encoder_spec_sha256=plan.encoder_spec_sha256,
                                  weights_sha256=plan.weights_sha256, weights_config_sha256=plan.weights_config_sha256,
                                  encoder_config=plan.encoder_config, loaded=loaded, patch_policy=plan.patch_policy,
                                  stain_policy=stain_policy, device=plan.extraction.get("device", "cpu"),
                                  precision=plan.env_json.get("precision", "fp32"), env_sha256=plan.env_sha256,
                                  extraction=plan.extraction, fixture_label=label, use_cache=False, store=False,
                                  ctx=ctx, progress=progress)
            ref_coords, ref_emb = stored.coords, np.asarray(stored.embeddings)
            coords_identical = (recomputed.coords.shape == ref_coords.shape
                                and bool(np.array_equal(recomputed.coords, ref_coords)))
            prep_sha_match = (recomputed.meta.get("fields", {}).get("coords_sha256")
                              == stored.meta.get("fields", {}).get("coords_sha256"))
            mode = "full"
        secs = time.perf_counter() - t0
        rss1 = _peak_rss_bytes()
        n_cmp = int(min(recomputed.embeddings.shape[0], ref_emb.shape[0])) if coords_identical else 0
        if coords_identical and n_cmp:
            diff = np.abs(recomputed.embeddings.astype(np.float64) - ref_emb.astype(np.float64))
            max_abs = float(diff.max())
            cos = _cosines(recomputed.embeddings, ref_emb)
            cos_min, cos_mean = float(cos.min()), float(cos.mean())
        else:
            max_abs = 0.0 if coords_identical else None
            cos_min = cos_mean = 1.0 if coords_identical else None
        passed = bool(coords_identical and (max_abs is not None and max_abs <= tol["max_abs_diff"])
                      and (cos_min is not None and cos_min >= tol["cosine_min"] - 1e-12))
        per_slide.append(_jsonable({
            "slide_id": sid, "mode": mode, "coords_identical": coords_identical,
            "sampled_coords_sha256_match": prep_sha_match, "cache_key_match": recomputed.cache_key == stored.cache_key,
            "cache_reuse": "a rebuild reuses the stored artifact" if recomputed.cache_key == stored.cache_key
            else "a rebuild would NOT reuse the stored artifact (its cache key differs)",
            "n_compared": n_cmp, "n_stored": stored.n_patches, "max_abs_diff": max_abs, "cosine_min": cos_min,
            "cosine_mean": cos_mean, "seconds": round(secs, 4),
            "patches_per_second": round(recomputed.n_patches / max(secs, 1e-9), 2),
            "peak_rss_bytes": rss1, "peak_rss_delta_bytes": (rss1 - rss0) if rss0 and rss1 else None,
            "passed": passed}))
    summary = {"passed": all(r["passed"] for r in per_slide), "slides": len(per_slide),
               "max_abs_diff": max((r["max_abs_diff"] or 0.0) for r in per_slide) if per_slide else None,
               "cosine_min": min((r["cosine_min"] if r["cosine_min"] is not None else 0.0) for r in per_slide)
               if per_slide else None,
               "coords_identical": all(r["coords_identical"] for r in per_slide),
               "patches_per_second": _stats([r["patches_per_second"] for r in per_slide]),
               "peak_rss_bytes": max((r["peak_rss_bytes"] or 0) for r in per_slide) if per_slide else None,
               "seconds": round(time.perf_counter() - t_start, 3)}
    result = {"schema": VALIDATION_SCHEMA, "feature_set_id": fs_id, "spec_sha256": None, "seed": int(seed),
              "n_slides": len(chosen), "max_patches": max_patches, "tolerance": tol, "per_slide": per_slide,
              "summary": summary, "encoder_id": plan.encoder_id, "weights_sha256": plan.weights_sha256,
              "extraction_env_sha256": plan.env_sha256,
              "note": "Determinism and throughput of THIS environment only; not evidence of model performance."}
    with session_scope() as db:
        row = db.get(FeatureSet, fs_id)
        result["spec_sha256"] = row.spec_sha256
        v = FeatureSetValidation(feature_set_id=fs_id, project_id=project_id, job_id=ctx.job_id if ctx else None,
                                 seed=int(seed), slide_ids_json=chosen, result_json=_jsonable(result),
                                 passed=summary["passed"], created_by=created_by)
        db.add(v)
        db.flush()
        result["validation_id"] = v.id
        _fenced(ctx, db)
    return result


@register(VALIDATE_JOB, description="Technical validation of a feature set: seeded re-extraction, determinism, "
                                    "throughput, memory")
def validate_job(ctx: JobContext, payload: dict) -> dict:
    refuse_label_payload(payload)  # design §1 invariant 4
    fs_id = payload.get("feature_set_id")
    if not fs_id:
        raise PermanentJobError("payload.feature_set_id is required")
    try:
        res = validate_feature_set(fs_id, ctx, seed=int(payload.get("seed", 0)),
                                   n_slides=int(payload.get("n_slides", 2)), max_patches=payload.get("max_patches"),
                                   created_by=ctx.created_by or "system:worker")
    except FeatureSetNotReady as exc:
        raise PermanentJobError(f"feature_set_not_ready: {exc.message}") from exc
    except EncoderUnavailable as exc:
        raise PermanentJobError(f"encoder_unavailable: {exc}") from exc
    except (FeatureError, ValueError) as exc:
        raise PermanentJobError(str(exc)) from exc
    return {"validation_id": res["validation_id"], "passed": res["summary"]["passed"], "summary": res["summary"]}


def enqueue_validation(db: Session, fs: FeatureSet, actor, *, seed: int = 0, n_slides: int = 2,
                       max_patches: int | None = None) -> Job:
    """Enqueue a technical validation (one per request; a duplicate while queued returns the same job)."""
    if fs.status != "ready":
        raise FeatureSetNotReady([], feature_set_id=fs.id, status=fs.status)
    n_prev = len(db.scalars(select(FeatureSetValidation.id).where(FeatureSetValidation.feature_set_id == fs.id)).all())
    key = f"{VALIDATE_JOB}:{fs.id}:{seed}:{n_slides}:{max_patches}:{n_prev}"
    job, created = queue.enqueue(db, VALIDATE_JOB, {"feature_set_id": fs.id, "seed": int(seed),
                                                    "n_slides": int(n_slides), "max_patches": max_patches},
                                 idempotency_key=key, project_id=fs.project_id, created_by=getattr(actor, "id", None))
    if not created and job.status in ("failed", "canceled"):  # a failed validation wrote nothing: run it again
        queue.retry(db, job)
    audit.record_for(db, actor, project_id=fs.project_id, action="feature_set.validation_requested",
                     entity_type="feature_set", entity_id=fs.id,
                     after={"job_id": job.id, "seed": seed, "n_slides": n_slides, "max_patches": max_patches})
    return job
