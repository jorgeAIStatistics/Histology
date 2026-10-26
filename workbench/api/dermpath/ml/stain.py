"""Versioned stain normalisation (research use only; pure numpy, deterministic).

Methods
-------
``none``
    Identity. The default.
``macenko-v1``
    Macenko et al. (2009, ISBI) H&E normalisation, implemented here from the published
    method: optical density ``OD = -ln((I + 1) / 256)``; pixels with OD below ``beta`` in any
    channel are dropped as background; the plane of the two largest principal axes of the
    remaining OD is searched for the extreme angles (``alpha`` and ``100 - alpha``
    percentiles), which give the two stain vectors (haematoxylin = the one with the larger red
    OD); concentrations are solved by least squares, and their ``max_percentile`` is mapped to
    the reference's. The reconstruction ``I = 256·exp(-OD) - 1`` maps white to white.

Where the estimates come from
-----------------------------
* The REFERENCE (:func:`fit_reference`) is fitted ONLY on train-split patches; pass
  ``splits`` and anything that is not ``"train"`` is refused
  (``StainError("fit_on_non_train_split")``). It uses exactly the patches it is given; the
  patch and pixel counts are recorded. It is never fitted on validation or test images.
* The SOURCE estimate of the slide being normalised (:func:`fit_source`) uses only that
  slide's own patches (label-free; nothing crosses slides or splits). With
  ``source_estimate="per_slide"`` (the policy default) the caller estimates it once per slide,
  for example on a seeded subset of the slide's candidates, and passes it to
  :func:`normalise`. ``"per_patch"`` re-estimates the stain vectors in every patch (classic
  per-image Macenko); on 112 µm patches that is unstable. Measured on CMU-1-Small-Region
  (58 patches at 0.5 µm/px) normalised to a reference and source fitted on the same 58
  patches, where an ideal method would change nothing: per-patch mode changed pixels by 16.6
  grey levels on average, per-slide mode by 6.6 (the residual is the projection onto the
  two-stain plane, which makes the method lossy even for self-normalisation; mean blue rose by
  about 13).

Versioning
----------
Estimates are rounded to 6 decimals before use and hashing, so JSON and ``sha256`` are
stable. Any change of method, parameters, reference or source mode changes
:attr:`StainPolicy.policy_sha256`, so stain ablations are separate feature sets. A patch (in
per-patch mode) with fewer than ``min_tissue_pixels`` usable pixels, or with a degenerate
estimate, is returned unchanged and counted (:func:`apply_with_stats`).
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Iterable, Sequence
from dataclasses import asdict, dataclass, field

import numpy as np

STAIN_VERSION = "dermpath.stain/1"
MACENKO_VERSION = "macenko-v1"
METHODS = ("none", MACENKO_VERSION)
SOURCE_ESTIMATES = ("per_slide", "per_patch")
ROLES = ("reference", "source")


def _canonical(obj) -> bytes:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode()


class StainError(ValueError):
    """Stain normalisation refused. ``reason`` is machine readable."""

    def __init__(self, reason: str, detail: str = ""):
        super().__init__(f"{reason}: {detail}" if detail else reason)
        self.reason = reason
        self.detail = detail


@dataclass(frozen=True)
class MacenkoParams:
    beta: float = 0.15  # OD below this in any channel = background
    alpha: float = 1.0  # robust extreme-angle percentile
    max_percentile: float = 99.0  # concentration "maximum" percentile
    min_tissue_pixels: int = 100  # below this, a patch (or a fit) has too little tissue
    max_pixels_per_patch: int = 4096  # deterministic stride subsample per patch when fitting

    def to_json(self) -> dict:
        return {k: (float(v) if isinstance(v, float) else int(v)) for k, v in asdict(self).items()}


@dataclass(frozen=True)
class MacenkoReference:
    """A Macenko estimate: unit OD vectors of haematoxylin and eosin and their max concentrations.

    ``role="reference"`` is the train-only target; ``role="source"`` is one slide's own estimate.
    """

    stain_matrix: tuple[tuple[float, float, float], tuple[float, float, float]]  # rows: H, E
    max_concentrations: tuple[float, float]
    n_patches: int
    n_pixels: int
    params: MacenkoParams = field(default_factory=MacenkoParams)
    role: str = "reference"
    method: str = MACENKO_VERSION

    def __post_init__(self):
        if self.role not in ROLES:
            raise StainError("bad_role", f"{self.role!r}")

    def to_json(self) -> dict:
        return {"method": self.method, "version": STAIN_VERSION, "role": self.role,
                "stain_matrix": [list(r) for r in self.stain_matrix],
                "max_concentrations": list(self.max_concentrations), "n_patches": self.n_patches,
                "n_pixels": self.n_pixels, "params": self.params.to_json(),
                "fitted_on": ("train-split patches only" if self.role == "reference"
                              else "the normalised slide's own patches (label-free)")}

    @property
    def sha256(self) -> str:
        return hashlib.sha256(_canonical(self.to_json())).hexdigest()

    @classmethod
    def from_json(cls, data: dict) -> "MacenkoReference":
        if data.get("method") != MACENKO_VERSION or data.get("version") != STAIN_VERSION:
            raise StainError("version_mismatch", f"{data.get('method')!r}/{data.get('version')!r}")
        return cls(stain_matrix=tuple(tuple(float(v) for v in r) for r in data["stain_matrix"]),
                   max_concentrations=tuple(float(v) for v in data["max_concentrations"]),
                   n_patches=int(data["n_patches"]), n_pixels=int(data["n_pixels"]),
                   params=MacenkoParams(**data["params"]), role=data.get("role", "reference"))

    def matrix(self) -> np.ndarray:
        """(3, 2) float64: columns H, E."""
        return np.asarray(self.stain_matrix, dtype=np.float64).T


@dataclass(frozen=True)
class StainPolicy:
    method: str = "none"
    reference: MacenkoReference | None = None
    source_estimate: str = "per_slide"

    def __post_init__(self):
        if self.method not in METHODS:
            raise StainError("unknown_method", f"{self.method!r} (expected one of {', '.join(METHODS)})")
        if self.source_estimate not in SOURCE_ESTIMATES:
            raise StainError("bad_source_estimate", f"{self.source_estimate!r} (expected {SOURCE_ESTIMATES})")
        if self.method == "none" and self.reference is not None:
            raise StainError("reference_unused", "method 'none' takes no reference")
        if self.method == MACENKO_VERSION:
            if self.reference is None:
                raise StainError("reference_required", "macenko-v1 needs a reference fitted on train patches")
            if self.reference.role != "reference":
                raise StainError("not_a_reference", "a slide's source estimate cannot be the reference")

    @classmethod
    def none(cls) -> "StainPolicy":
        return cls()

    @classmethod
    def macenko(cls, reference: MacenkoReference, *, source_estimate: str = "per_slide") -> "StainPolicy":
        return cls(method=MACENKO_VERSION, reference=reference, source_estimate=source_estimate)

    def to_json(self) -> dict:
        body = {"version": STAIN_VERSION, "method": self.method,
                "reference": self.reference.to_json() if self.reference else None,
                "reference_sha256": self.reference.sha256 if self.reference else None}
        if self.method != "none":
            body["source_estimate"] = self.source_estimate
        return body

    @classmethod
    def from_json(cls, data: dict) -> "StainPolicy":
        if data.get("version") != STAIN_VERSION:
            raise StainError("version_mismatch", f"{data.get('version')!r} != {STAIN_VERSION!r}")
        ref = MacenkoReference.from_json(data["reference"]) if data.get("reference") else None
        if ref is not None and data.get("reference_sha256") not in (None, ref.sha256):
            raise StainError("reference_sha_mismatch", "stored reference_sha256 does not match the reference")
        return cls(method=data["method"], reference=ref, source_estimate=data.get("source_estimate", "per_slide"))

    @property
    def policy_sha256(self) -> str:
        return hashlib.sha256(_canonical(self.to_json())).hexdigest()


# --------------------------------------------------------------------------- Macenko core


def _od(rgb: np.ndarray) -> np.ndarray:
    return -np.log((rgb.astype(np.float64) + 1.0) / 256.0)


def _tissue_od(patch: np.ndarray, beta: float) -> tuple[np.ndarray, np.ndarray]:
    od = _od(patch.reshape(-1, 3))
    return od, od[~np.any(od < beta, axis=1)]


def _stain_vectors(od_hat: np.ndarray, alpha: float) -> np.ndarray | None:
    """(3, 2) unit stain vectors (columns H, E) from tissue OD pixels, or None if degenerate."""
    if od_hat.shape[0] < 3:
        return None
    cov = np.cov(od_hat, rowvar=False)
    if not np.all(np.isfinite(cov)):
        return None
    _, vecs = np.linalg.eigh(cov)
    v = vecs[:, [2, 1]].copy()  # largest, then second-largest principal axis
    if v[:, 0].sum() < 0:  # fix eigenvector signs deterministically
        v[:, 0] *= -1
    nz = np.flatnonzero(np.abs(v[:, 1]) > 1e-12)
    if nz.size and v[nz[0], 1] < 0:
        v[:, 1] *= -1
    proj = od_hat @ v
    phi = np.arctan2(proj[:, 1], proj[:, 0])
    lo, hi = np.percentile(phi, alpha), np.percentile(phi, 100.0 - alpha)
    v_lo = v @ np.array([np.cos(lo), np.sin(lo)])
    v_hi = v @ np.array([np.cos(hi), np.sin(hi)])
    he = np.stack([v_lo, v_hi], axis=1) if v_lo[0] > v_hi[0] else np.stack([v_hi, v_lo], axis=1)
    norms = np.linalg.norm(he, axis=0)
    if np.any(norms < 1e-12) or not np.all(np.isfinite(he)):
        return None
    he = he / norms
    if np.linalg.matrix_rank(he, tol=1e-6) < 2:
        return None
    return he


def _max_concentrations(od_hat: np.ndarray, he: np.ndarray, pct: float) -> np.ndarray | None:
    m = np.percentile(od_hat @ np.linalg.pinv(he).T, pct, axis=0)
    return m if np.all(np.isfinite(m)) and np.all(m > 1e-9) else None


def _iter_patches(patches) -> Iterable[np.ndarray]:
    if isinstance(patches, np.ndarray):
        arr = patches[None] if patches.ndim == 3 else patches
        if arr.ndim != 4 or arr.shape[-1] != 3:
            raise StainError("bad_input", f"expected uint8[N, H, W, 3] patches, got shape {list(patches.shape)}")
        yield from arr
        return
    for batch in patches:
        yield from _iter_patches(np.asarray(batch))


def _estimate(patches, params: MacenkoParams, role: str) -> MacenkoReference:
    pooled: list[np.ndarray] = []
    n_patches = 0
    for patch in _iter_patches(patches):
        if patch.dtype != np.uint8:
            raise StainError("bad_input", f"patches must be uint8, got {patch.dtype}")
        n_patches += 1
        _, od_hat = _tissue_od(patch, params.beta)
        if od_hat.shape[0] > params.max_pixels_per_patch:  # deterministic stride subsample
            idx = np.linspace(0, od_hat.shape[0] - 1, params.max_pixels_per_patch).round().astype(np.int64)
            od_hat = od_hat[idx]
        pooled.append(od_hat)
    od_hat = np.concatenate(pooled) if pooled else np.zeros((0, 3))
    if od_hat.shape[0] < params.min_tissue_pixels:
        raise StainError("no_tissue_pixels", f"{od_hat.shape[0]} usable pixels in {n_patches} patches "
                                             f"(need {params.min_tissue_pixels})")
    he = _stain_vectors(od_hat, params.alpha)
    max_c = None if he is None else _max_concentrations(od_hat, he, params.max_percentile)
    if he is None or max_c is None:
        raise StainError("degenerate_fit", "stain vectors could not be estimated from these patches")
    he_r = np.round(he, 6)
    return MacenkoReference(stain_matrix=(tuple(float(v) for v in he_r[:, 0]), tuple(float(v) for v in he_r[:, 1])),
                            max_concentrations=(round(float(max_c[0]), 6), round(float(max_c[1]), 6)),
                            n_patches=n_patches, n_pixels=int(od_hat.shape[0]), params=params, role=role)


def fit_reference(train_patches, *, splits: str | Sequence[str] | None = None,
                  params: MacenkoParams | None = None) -> MacenkoReference:
    """Fit the Macenko reference on TRAIN-split patches only (uint8[N, H, W, 3] or an iterable of batches).

    ``splits`` declares the split of the patches (one string, or one per patch of an array).
    Any split other than ``"train"`` is refused. The fit reads only the patches passed in.
    """
    params = params or MacenkoParams()
    if splits is not None:
        declared = [splits] if isinstance(splits, str) else list(splits)
        bad = sorted({s for s in declared if s != "train"})
        if bad:
            raise StainError("fit_on_non_train_split",
                             f"a stain reference is fitted on train-split patches only; got {bad}")
        if not isinstance(splits, str) and isinstance(train_patches, np.ndarray):
            n = 1 if train_patches.ndim == 3 else int(train_patches.shape[0])
            if n != len(declared):
                raise StainError("splits_length_mismatch", f"{len(declared)} split labels for {n} patches")
    return _estimate(train_patches, params, "reference")


def fit_source(slide_patches, *, params: MacenkoParams | None = None) -> MacenkoReference:
    """Estimate one slide's own stain vectors from that slide's patches (label-free)."""
    return _estimate(slide_patches, params or MacenkoParams(), "source")


def _reconstruct(od: np.ndarray, pinv_src: np.ndarray, scale: np.ndarray, ref_he: np.ndarray, shape) -> np.ndarray:
    conc = (od @ pinv_src.T) * scale
    rgb = 256.0 * np.exp(-(conc @ ref_he.T)) - 1.0
    return np.clip(np.rint(rgb), 0, 255).astype(np.uint8).reshape(shape)


def apply_with_stats(batch: np.ndarray, reference: MacenkoReference, *,
                     source: MacenkoReference | None = None) -> tuple[np.ndarray, dict]:
    """Normalise ``uint8[B, H, W, 3]`` to ``reference``.

    With ``source`` (the slide's :func:`fit_source` estimate) every patch uses the slide-level
    stain vectors and maxima; without it each patch is estimated on its own (per-patch mode).
    """
    batch = np.asarray(batch)
    if batch.ndim != 4 or batch.shape[-1] != 3 or batch.dtype != np.uint8:
        raise StainError("bad_input", f"expected uint8[B, H, W, 3], got {batch.dtype}{list(batch.shape)}")
    if reference.role != "reference":
        raise StainError("not_a_reference", "normalise to a train-fitted reference, not a slide's source estimate")
    if source is not None and source.role != "source":
        raise StainError("not_a_source", "source must come from fit_source on the slide being normalised")
    params = reference.params
    ref_he = reference.matrix()
    ref_max = np.asarray(reference.max_concentrations, dtype=np.float64)
    out = np.empty_like(batch)
    unchanged = 0
    if source is not None:
        pinv_src = np.linalg.pinv(source.matrix())
        scale = ref_max / np.asarray(source.max_concentrations, dtype=np.float64)
    for i in range(batch.shape[0]):
        od, od_hat = _tissue_od(batch[i], params.beta)
        if source is None:
            he = _stain_vectors(od_hat, params.alpha) if od_hat.shape[0] >= params.min_tissue_pixels else None
            m = None if he is None else _max_concentrations(od_hat, he, params.max_percentile)
            if m is None:
                out[i] = batch[i]
                unchanged += 1
                continue
            out[i] = _reconstruct(od, np.linalg.pinv(he), ref_max / m, ref_he, batch[i].shape)
        else:
            out[i] = _reconstruct(od, pinv_src, scale, ref_he, batch[i].shape)
    return out, {"method": MACENKO_VERSION, "reference_sha256": reference.sha256,
                 "source": "per_slide" if source is not None else "per_patch",
                 "source_sha256": source.sha256 if source is not None else None, "n": int(batch.shape[0]),
                 "unchanged_insufficient_tissue_or_degenerate": unchanged}


def apply(batch: np.ndarray, reference: MacenkoReference, *, source: MacenkoReference | None = None) -> np.ndarray:
    """Normalise a ``uint8[B, H, W, 3]`` batch to ``reference`` (deterministic)."""
    return apply_with_stats(batch, reference, source=source)[0]


def normalise(batch: np.ndarray, policy: StainPolicy, *, source: MacenkoReference | None = None) -> np.ndarray:
    """Apply a :class:`StainPolicy`. ``none`` returns the batch itself; ``per_slide`` needs ``source``."""
    if policy.method == "none":
        return batch
    if policy.source_estimate == "per_slide":
        if source is None:
            raise StainError("source_required", "per_slide normalisation needs the slide's fit_source estimate")
        return apply(batch, policy.reference, source=source)
    return apply(batch, policy.reference)
