"""Tissue coordinates and patches at a calibrated (or explicitly uncalibrated) scale.

Two pipelines live here. The policy-driven pipeline (``PATCHING_VERSION_V2``) is the one new
code uses; the legacy functions (``PATCHING_VERSION``) are kept, unchanged in behaviour, for
callers that have not migrated yet.

Policy-driven pipeline (``dermpath.patching/2``, research use only)
-------------------------------------------------------------------
* :class:`PatchPolicy` (frozen; canonical JSON; ``policy_sha256``) holds every parameter that
  changes which pixels reach an encoder.
* :func:`plan_scale` with ``policy=`` plans a PHYSICAL scale: patches cover
  ``patch_size × target_mpp`` microns. It records the effective microns-per-pixel, the read
  level and size and the upsample ratio, and it refuses (:class:`ScaleError`) slides scanned
  coarser than the target beyond ``max_upsample_ratio`` (``would_upsample``), anisotropic
  pixels beyond ``anisotropy_tolerance`` (``anisotropic``), implausible mpp
  (``implausible_mpp``), reads larger than ``max_read_ratio × patch_size`` (``read_size_cap``)
  and, unless ``allow_uncalibrated``, slides without mpp (``uncalibrated``). Uncalibrated
  plans read exactly ``uncalibrated_downsample`` level-0 px per output px, whatever the
  pyramid layout, and are labelled uncalibrated.
* :func:`candidate_grid` lays a grid of stride ``stride_fraction × extent``. With
  ``edge_mode="shift_inward"`` the last column and row are shifted inside the image, so tissue
  touching the right or bottom edge is reachable. Per-cell tissue fractions are exact area
  integrals over the mask. Cells below ``min_tissue_fraction`` or intersecting an excluded
  polygon (exact geometry, level-0 units) are rejected and counted by reason. Mask fragments
  (8-connected components) of at least ``fragment_rescue_min_area_um2`` that no candidate
  overlaps get one tissue-centred patch (``fragment_rescue``).
* :func:`iter_patch_batches` streams ``uint8[B, H, W, 3]`` batches with bounded memory: one
  read per patch, one resize (BILINEAR, recorded) to ``patch_size``, a recorded background
  fill, and the read-time filters (``pen_marks``, ``background_at_read``, optional blur).
* :func:`patch_quality` measures pixel tissue fraction, pen-ink fraction, Laplacian variance
  and mean RGB per patch.

Coverage of a selection is measured in :mod:`dermpath.ml.coverage`; sampling lives in
:mod:`dermpath.ml.sampling`; stain normalisation in :mod:`dermpath.ml.stain`.

Legacy pipeline (``dermpath.patching/1``, deprecated)
------------------------------------------------------
* mpp known: patches cover ``patch_size × target_mpp`` microns. The level-0 extent is
  ``patch_size × target_mpp / mpp``; the pyramid level closest to (not above) that
  downsample is read and resized to ``patch_size``. Recorded as ``calibrated``.
* mpp unknown: a FIXED pyramid level (closest to ``fallback_downsample``) is used and the
  scale is recorded as ``uncalibrated scale`` (patch content in microns is unknown).

The latest automated QC screen's tissue mask (Otsu on saturation, experimental) is used when
it exists; otherwise the same Otsu segmentation is run on a bounded thumbnail and recorded as
``otsu_fallback``. A grid cell is kept when its tissue fraction reaches
``min_tissue_fraction`` and it does not touch any region a human excluded in QC
(``exclude_region``). More than ``max_patches_per_slide`` cells → seeded sampling.
Known limits (fixed in the policy pipeline): the grid never covers the right and bottom
strips, slides coarser than the target are upsampled silently, and the sampling seed is the
caller's.

``pixel_mode="none"`` (synthetic encoder only) skips pixels entirely: a regular grid over
the slide's declared dimensions, still minus excluded regions, recorded as
``synthetic_grid_no_pixels``.
"""

from __future__ import annotations

import hashlib
import io
import math
import threading
import time
from collections import OrderedDict
from collections.abc import Iterator
from dataclasses import asdict, dataclass, field, replace

import numpy as np
from PIL import Image, ImageDraw

from ..qc import tissue as qc_tissue
from ..slides.imaging import bounded_thumbnail
from .artifacts import canonical_json
from .sampling import SamplingPolicy

PATCHING_VERSION = "dermpath.patching/1"  # legacy pipeline; unchanged
PATCHING_VERSION_V2 = "dermpath.patching/2"  # policy-driven pipeline (PatchPolicy)
QUALITY_VERSION = "dermpath.patch-quality/1"  # pixel tissue / pen-ink / blur rules below
FALLBACK_MASK_SIZE = 1024
UNCALIBRATED_NOTE = "uncalibrated scale: microns-per-pixel unknown, a fixed pyramid level was used"
UNCALIBRATED_NOTE_V2 = ("uncalibrated scale: microns-per-pixel unknown; each output pixel covers a fixed number of "
                        "level-0 pixels, so patch content in microns is unknown")

EDGE_MODES = ("shift_inward", "pad", "floor")
RESIZE_FILTERS = {"bilinear": Image.Resampling.BILINEAR}
BACKGROUND_FILLS = ("slide", "white")
#: Microns-per-pixel outside this range is treated as a metadata error, not a scan.
MPP_PLAUSIBLE = (0.05, 20.0)
#: Candidate origins (``Candidates.origin`` holds indices into this tuple).
ORIGINS = ("grid", "edge", "fragment_rescue")
ORIGIN_GRID, ORIGIN_EDGE, ORIGIN_RESCUE = 0, 1, 2
FRAGMENT_CONNECTIVITY = 8

# Pixel rules of the read-time quality measures (QUALITY_VERSION). Thresholds were checked on
# the CC0 CMU-1-Small-Region fixture (H&E, no ink): over its 69 candidate patches (mask tissue
# fraction >= 0.1, 112 µm at 0.5 µm/px) the largest per-patch false-positive ink fractions were
# 3.7 % (blue), 0.9 % (green) and 0.2 % (black), 4.7 % for any ink, far below the default
# ``pen_max_fraction`` of 0.25. Basaloid tumour with dense haematoxylin was NOT available for
# this check. The blue rule keeps hue < 238° (red below green), which excludes the purple
# haematoxylin hue range (5th percentile about 249° on the fixture); purple ink is therefore
# NOT detected. Black ink is dark AND unsaturated, so dense nuclei (saturated) are not ink.
READ_TISSUE_SATURATION = qc_tissue.THRESHOLD_FLOOR  # a pixel is tissue when HSV saturation (0–255) exceeds this
PEN_RULES = {
    "blue": {"hue_deg": [185.0, 238.0], "min_saturation": 0.45, "min_value": 0.20},
    "green": {"hue_deg": [70.0, 170.0], "min_saturation": 0.25, "min_value": 0.15},
    "black": {"max_value": 0.16, "max_saturation": 0.50},
}


class ScaleError(ValueError):
    """The slide cannot be read at the policy's physical scale. ``reason`` is machine readable:
    ``would_upsample``, ``anisotropic``, ``implausible_mpp``, ``read_size_cap``, ``uncalibrated``."""

    def __init__(self, reason: str, detail: str = ""):
        super().__init__(f"{reason}: {detail}" if detail else reason)
        self.reason = reason
        self.detail = detail


# --------------------------------------------------------------------------- policy


def _normalise_numbers(obj, *, floats: tuple[str, ...], ints: tuple[str, ...]) -> None:
    """Store numbers as float/int so equal policies serialise (and hash) identically."""
    for name in floats:
        v = getattr(obj, name)
        if v is not None and not isinstance(v, bool) and isinstance(v, (int, float)):
            object.__setattr__(obj, name, float(v))
    for name in ints:
        v = getattr(obj, name)
        if isinstance(v, float) and v.is_integer():
            object.__setattr__(obj, name, int(v))


@dataclass(frozen=True)
class ReadFilters:
    """Patch filters applied when pixels are read (after the mask-based candidate grid).

    ``background_at_read`` rejects a patch whose PIXEL tissue fraction is below the policy's
    ``min_tissue_fraction`` (fragment-rescue patches use ``rescue_min_tissue_fraction``,
    because by construction they hold less tissue than the grid threshold). ``pen_marks``
    rejects a patch whose ink fraction exceeds ``pen_max_fraction``. ``blur_flag`` only
    records the Laplacian variance; ``blur_reject_below`` (off by default) rejects below it.
    """

    background_at_read: bool = True
    pen_marks: bool = True
    pen_max_fraction: float = 0.25
    blur_flag: bool = True
    blur_reject_below: float | None = None
    rescue_min_tissue_fraction: float = 0.02

    def __post_init__(self):
        _normalise_numbers(self, floats=("pen_max_fraction", "blur_reject_below", "rescue_min_tissue_fraction"), ints=())
        if not 0.0 < float(self.pen_max_fraction) <= 1.0:
            raise ValueError(f"pen_max_fraction must be in (0, 1], got {self.pen_max_fraction}")
        if not 0.0 <= float(self.rescue_min_tissue_fraction) <= 1.0:
            raise ValueError(f"rescue_min_tissue_fraction must be in [0, 1], got {self.rescue_min_tissue_fraction}")
        if self.blur_reject_below is not None and float(self.blur_reject_below) < 0:
            raise ValueError("blur_reject_below must be >= 0 or None")

    def to_json(self) -> dict:
        return asdict(self)


@dataclass(frozen=True)
class PatchPolicy:
    """Everything that decides which pixels reach the encoder. Frozen; hash with ``policy_sha256``.

    ``patch_size`` must equal the encoder's ``input_size`` (see :meth:`validate_for_encoder`);
    patches are never resized again inside an encoder.
    """

    target_mpp: float = 0.5
    patch_size: int = 224
    min_tissue_fraction: float = 0.25
    stride_fraction: float = 1.0
    edge_mode: str = "shift_inward"
    fragment_rescue_min_area_um2: float | None = 2000.0
    max_upsample_ratio: float = 1.05
    anisotropy_tolerance: float = 0.10
    allow_uncalibrated: bool = False
    uncalibrated_downsample: float = 4.0
    max_read_ratio: float = 4.0
    resize_filter: str = "bilinear"
    background_fill: str = "slide"
    read_filters: ReadFilters = field(default_factory=ReadFilters)
    sampling: SamplingPolicy = field(default_factory=SamplingPolicy)

    def __post_init__(self):
        _normalise_numbers(self, floats=("target_mpp", "min_tissue_fraction", "stride_fraction",
                                         "fragment_rescue_min_area_um2", "max_upsample_ratio", "anisotropy_tolerance",
                                         "uncalibrated_downsample", "max_read_ratio"), ints=("patch_size",))
        if isinstance(self.read_filters, dict):
            object.__setattr__(self, "read_filters", ReadFilters(**self.read_filters))
        if isinstance(self.sampling, dict):
            object.__setattr__(self, "sampling", SamplingPolicy.from_json(self.sampling))
        if not (isinstance(self.target_mpp, (int, float)) and math.isfinite(self.target_mpp) and self.target_mpp > 0):
            raise ValueError(f"target_mpp must be a positive number, got {self.target_mpp!r}")
        if int(self.patch_size) != self.patch_size or self.patch_size < 8:
            raise ValueError(f"patch_size must be an integer >= 8, got {self.patch_size!r}")
        if not 0.0 < float(self.min_tissue_fraction) <= 1.0:
            raise ValueError(f"min_tissue_fraction must be in (0, 1], got {self.min_tissue_fraction}")
        if not 0.0 < float(self.stride_fraction) <= 1.0:
            raise ValueError(f"stride_fraction must be in (0, 1], got {self.stride_fraction}")
        if self.edge_mode not in EDGE_MODES:
            raise ValueError(f"edge_mode must be one of {EDGE_MODES}, got {self.edge_mode!r}")
        if self.fragment_rescue_min_area_um2 is not None and float(self.fragment_rescue_min_area_um2) <= 0:
            raise ValueError("fragment_rescue_min_area_um2 must be > 0 or None (rescue off)")
        if float(self.max_upsample_ratio) < 1.0:
            raise ValueError("max_upsample_ratio must be >= 1")
        if float(self.anisotropy_tolerance) < 0:
            raise ValueError("anisotropy_tolerance must be >= 0")
        if float(self.uncalibrated_downsample) < 1.0:
            raise ValueError("uncalibrated_downsample must be >= 1")
        if float(self.max_read_ratio) < 1.0:
            raise ValueError("max_read_ratio must be >= 1")
        if self.resize_filter not in RESIZE_FILTERS:
            raise ValueError(f"resize_filter must be one of {sorted(RESIZE_FILTERS)}, got {self.resize_filter!r}")
        if self.background_fill not in BACKGROUND_FILLS:
            raise ValueError(f"background_fill must be one of {BACKGROUND_FILLS}, got {self.background_fill!r}")
        if not isinstance(self.read_filters, ReadFilters) or not isinstance(self.sampling, SamplingPolicy):
            raise ValueError("read_filters and sampling must be ReadFilters and SamplingPolicy instances")

    def to_json(self) -> dict:
        body = {k: getattr(self, k) for k in self.__dataclass_fields__ if k not in ("read_filters", "sampling")}
        body.update(version=PATCHING_VERSION_V2, quality_version=QUALITY_VERSION,
                    read_filters=self.read_filters.to_json(), sampling=self.sampling.to_json())
        return body

    def canonical_json(self) -> bytes:
        return canonical_json(self.to_json())

    @property
    def policy_sha256(self) -> str:
        return hashlib.sha256(self.canonical_json()).hexdigest()

    @classmethod
    def from_json(cls, data: dict) -> "PatchPolicy":
        body = dict(data)
        version = body.pop("version", PATCHING_VERSION_V2)
        quality = body.pop("quality_version", QUALITY_VERSION)
        if version != PATCHING_VERSION_V2 or quality != QUALITY_VERSION:
            raise ValueError(f"policy version {version!r}/{quality!r} is not {PATCHING_VERSION_V2!r}/{QUALITY_VERSION!r}")
        return cls(**body)

    def replace(self, **changes) -> "PatchPolicy":
        return replace(self, **changes)

    def validate_for_encoder(self, input_size: int) -> None:
        """Patches arrive at exactly the encoder's input size (no resizing inside encoders)."""
        if int(input_size) != int(self.patch_size):
            raise ValueError(f"patch_size_mismatch: policy patch_size {self.patch_size} != encoder input_size {input_size}")


# --------------------------------------------------------------------------- scale


@dataclass
class PatchPlan:
    level: int
    level_downsample: float
    read_size: tuple[int, int]  # pixels read at `level`
    extent: tuple[int, int]  # level-0 pixels covered by one patch
    patch_size: int
    calibrated: bool
    scale: dict
    scale_key: str
    # Added for the policy pipeline; the legacy planner fills them too (its ``scale`` is unchanged).
    version: str = PATCHING_VERSION
    slide_mpp: tuple[float, float] | None = None
    effective_mpp: tuple[float, float] | None = None  # microns per OUTPUT pixel, per axis
    upsample_ratio: float = 1.0  # > 1: the single resize interpolates (upsamples) pixels
    resize_filter: str = "bilinear"

    @property
    def read_level(self) -> int:
        return self.level

    @property
    def effective_mpp_x(self) -> float | None:
        return self.effective_mpp[0] if self.effective_mpp else None

    @property
    def effective_mpp_y(self) -> float | None:
        return self.effective_mpp[1] if self.effective_mpp else None


@dataclass
class Coordinates:
    coords: np.ndarray  # (N, 2) int64 level-0 top-left x, y
    plan: PatchPlan
    stats: dict = field(default_factory=dict)

    @property
    def sha256(self) -> str:
        body = {"coords": self.coords.astype(np.int64).tolist(), "extent": list(self.plan.extent),
                "level": self.plan.level, "patch_size": self.plan.patch_size}
        return hashlib.sha256(canonical_json(body)).hexdigest()


def _best_level(downsamples: list[float], target: float) -> int:
    best = 0
    for i, d in enumerate(downsamples):
        if d <= target + 1e-9:
            best = i
    return best


def _valid_mpp(v) -> bool:
    try:
        return v is not None and math.isfinite(float(v)) and float(v) > 0
    except (TypeError, ValueError):
        return False


def _level_for_extent(downsamples: list[float], ext: tuple[int, int], patch_size: int) -> int:
    """The coarsest level whose read of ``ext`` level-0 px still has >= patch_size px per axis."""
    best = 0
    for i, d in enumerate(downsamples):
        if d > 0 and round(ext[0] / d) >= patch_size and round(ext[1] / d) >= patch_size and d >= downsamples[best]:
            best = i
    return best


def plan_scale(*, mpp_x: float | None, mpp_y: float | None, level_downsamples: list[float],
               patch_size: int | None = None, target_mpp: float | None = None,
               fallback_downsample: float | None = None, policy: PatchPolicy | None = None) -> PatchPlan:
    """Plan the read level, read size and level-0 extent of one patch.

    With ``policy`` (the policy pipeline) the physical scale is checked and refused with
    :class:`ScaleError` when it cannot be honoured; ``patch_size``/``target_mpp``/
    ``fallback_downsample`` must then be omitted. Without ``policy`` this is the legacy
    planner (deprecated): no refusal, silent upsampling of coarse scans, pyramid-dependent
    uncalibrated scale.
    """
    if policy is not None:
        if patch_size is not None or target_mpp is not None or fallback_downsample is not None:
            raise ValueError("plan_scale: pass either policy= or the legacy patch_size/target_mpp/fallback_downsample")
        return _plan_scale_policy(mpp_x=mpp_x, mpp_y=mpp_y, level_downsamples=level_downsamples, policy=policy)
    if patch_size is None or target_mpp is None or fallback_downsample is None:
        raise TypeError("plan_scale (legacy) needs patch_size, target_mpp and fallback_downsample")
    downsamples = [float(d) for d in (level_downsamples or [1.0])]
    if mpp_x and mpp_y:
        fx, fy = target_mpp / mpp_x, target_mpp / mpp_y  # level-0 px per output px
        ext = (max(1, int(round(patch_size * fx))), max(1, int(round(patch_size * fy))))
        level = _best_level(downsamples, min(fx, fy))
        ds = downsamples[level]
        read = (max(1, int(round(ext[0] / ds))), max(1, int(round(ext[1] / ds))))
        return PatchPlan(level=level, level_downsample=ds, read_size=read, extent=ext, patch_size=patch_size,
                         calibrated=True,
                         scale={"mode": "calibrated", "target_mpp": target_mpp, "slide_mpp": [mpp_x, mpp_y],
                                "read_level": level, "read_level_downsample": ds},
                         scale_key=f"mpp={target_mpp:g}",
                         slide_mpp=(float(mpp_x), float(mpp_y)),
                         effective_mpp=(ext[0] * mpp_x / patch_size, ext[1] * mpp_y / patch_size),
                         upsample_ratio=max(1.0, patch_size / read[0], patch_size / read[1]))
    level = _best_level(downsamples, fallback_downsample)
    ds = downsamples[level]
    ext = (int(round(patch_size * ds)), int(round(patch_size * ds)))
    return PatchPlan(level=level, level_downsample=ds, read_size=(patch_size, patch_size), extent=ext,
                     patch_size=patch_size, calibrated=False,
                     scale={"mode": "uncalibrated", "level": level, "level_downsample": ds, "note": UNCALIBRATED_NOTE},
                     scale_key=f"level={level}(ds={ds:g})")


def _plan_scale_policy(*, mpp_x, mpp_y, level_downsamples, policy: PatchPolicy) -> PatchPlan:
    downsamples = [float(d) for d in (level_downsamples or [1.0])]
    if not downsamples or any(not (math.isfinite(d) and d > 0) for d in downsamples):
        raise ValueError(f"invalid level_downsamples {level_downsamples!r}")
    ps, target = int(policy.patch_size), float(policy.target_mpp)
    if _valid_mpp(mpp_x) and _valid_mpp(mpp_y):
        mx, my = float(mpp_x), float(mpp_y)
        lo, hi = MPP_PLAUSIBLE
        if not (lo <= mx <= hi and lo <= my <= hi):
            raise ScaleError("implausible_mpp", f"slide mpp ({mx:g}, {my:g}) outside the plausible range {lo:g}–{hi:g} µm/px")
        anisotropy = abs(mx - my) / min(mx, my)
        if anisotropy > policy.anisotropy_tolerance + 1e-12:
            raise ScaleError("anisotropic", f"mpp_x {mx:g} vs mpp_y {my:g} differ by {anisotropy:.1%} "
                                            f"(tolerance {policy.anisotropy_tolerance:.0%})")
        fx, fy = target / mx, target / my  # level-0 px per output px
        ext = (max(1, int(round(ps * fx))), max(1, int(round(ps * fy))))
        level = _level_for_extent(downsamples, ext, ps)
        ds = downsamples[level]
        read = (max(1, int(round(ext[0] / ds))), max(1, int(round(ext[1] / ds))))
        upsample = max(1.0, ps / read[0], ps / read[1])
        if upsample > policy.max_upsample_ratio + 1e-12:
            raise ScaleError("would_upsample", f"slide scanned at ({mx:g}, {my:g}) µm/px is coarser than the target "
                                               f"{target:g} µm/px; reading would upsample by {upsample:.3f} "
                                               f"(max {policy.max_upsample_ratio:g})")
        if max(read) > policy.max_read_ratio * ps:
            raise ScaleError("read_size_cap", f"read size {read} at level {level} exceeds "
                                              f"{policy.max_read_ratio:g} × patch_size {ps}")
        eff = (ext[0] * mx / ps, ext[1] * my / ps)
        scale = {"mode": "calibrated", "version": PATCHING_VERSION_V2, "target_mpp": target, "slide_mpp": [mx, my],
                 "effective_mpp": [round(eff[0], 6), round(eff[1], 6)], "read_level": level,
                 "read_level_downsample": ds, "read_size": list(read), "extent": list(ext),
                 "upsample_ratio": round(upsample, 6), "anisotropy": round(anisotropy, 6),
                 "resize_filter": policy.resize_filter}
        return PatchPlan(level=level, level_downsample=ds, read_size=read, extent=ext, patch_size=ps, calibrated=True,
                         scale=scale, scale_key=f"mpp={target:g}", version=PATCHING_VERSION_V2, slide_mpp=(mx, my),
                         effective_mpp=eff, upsample_ratio=upsample, resize_filter=policy.resize_filter)
    partial = _valid_mpp(mpp_x) or _valid_mpp(mpp_y)
    if not policy.allow_uncalibrated:
        raise ScaleError("uncalibrated", "the slide has no usable microns-per-pixel "
                                         f"({'only one axis' if partial else 'none'} recorded); uncalibrated slides "
                                         "are refused unless the policy allows them (synthetic and technical modes)")
    d = float(policy.uncalibrated_downsample)
    ext = (int(round(ps * d)), int(round(ps * d)))
    level = _level_for_extent(downsamples, ext, ps)
    ds = downsamples[level]
    read = (max(1, int(round(ext[0] / ds))), max(1, int(round(ext[1] / ds))))
    if max(read) > policy.max_read_ratio * ps:
        raise ScaleError("read_size_cap", f"read size {read} at level {level} exceeds "
                                          f"{policy.max_read_ratio:g} × patch_size {ps}")
    upsample = max(1.0, ps / read[0], ps / read[1])
    scale = {"mode": "uncalibrated", "version": PATCHING_VERSION_V2, "level0_px_per_output_px": d,
             "read_level": level, "read_level_downsample": ds, "read_size": list(read), "extent": list(ext),
             "upsample_ratio": round(upsample, 6), "partial_mpp": partial, "note": UNCALIBRATED_NOTE_V2,
             "resize_filter": policy.resize_filter}
    return PatchPlan(level=level, level_downsample=ds, read_size=read, extent=ext, patch_size=ps, calibrated=False,
                     scale=scale, scale_key=f"uncalibrated(ds={d:g})", version=PATCHING_VERSION_V2,
                     upsample_ratio=upsample, resize_filter=policy.resize_filter)


# --------------------------------------------------------------------------- masks


def mask_from_png(data: bytes) -> np.ndarray:
    return np.asarray(Image.open(io.BytesIO(data)).convert("L")) > 127


_OTSU_CACHE: "OrderedDict[str, tuple[np.ndarray, dict]]" = OrderedDict()
_OTSU_LOCK = threading.Lock()


def otsu_mask(osr, slide_sha256: str | None = None) -> tuple[np.ndarray, dict]:
    """Otsu fallback mask on a bounded thumbnail; memoised in-process per slide content hash."""
    if slide_sha256:
        with _OTSU_LOCK:
            if slide_sha256 in _OTSU_CACHE:
                _OTSU_CACHE.move_to_end(slide_sha256)
                return _OTSU_CACHE[slide_sha256]
    thumb = bounded_thumbnail(osr, (FALLBACK_MASK_SIZE, FALLBACK_MASK_SIZE))
    mask, stats = qc_tissue.segment(thumb, osr.dimensions)
    if slide_sha256:
        with _OTSU_LOCK:
            _OTSU_CACHE[slide_sha256] = (mask, stats)
            while len(_OTSU_CACHE) > 16:  # ~0.8 MB per 1024-px mask
                _OTSU_CACHE.popitem(last=False)
    return mask, stats


def _polygon_points(region: dict) -> list[tuple[float, float]]:
    """Level-0 polygon vertices from the stored region formats."""
    if not isinstance(region, dict):
        raise ValueError("excluded region is not an object")
    t = str(region.get("type", "")).lower()
    if t == "polygon" and "coordinates" in region:
        ring = region["coordinates"][0]
        return [(float(p[0]), float(p[1])) for p in ring]
    if "points" in region:
        return [(float(p[0]), float(p[1])) for p in region["points"]]
    if t == "rectangle" or {"x", "y", "width", "height"} <= set(region):
        x, y, w, h = (float(region[k]) for k in ("x", "y", "width", "height"))
        return [(x, y), (x + w, y), (x + w, y + h), (x, y + h)]
    raise ValueError(f"cannot parse excluded region geometry (type={region.get('type')!r})")


def exclusion_raster(regions: list[dict], size: tuple[int, int], ds: tuple[float, float]) -> np.ndarray:
    """Rasterise excluded polygons onto a grid of ``size`` (w, h) cells of ``ds`` level-0 px.
    The outline is drawn too, so slivers thinner than a cell are not lost."""
    img = Image.new("L", size, 0)
    draw = ImageDraw.Draw(img)
    for r in regions:
        pts = [(x / ds[0], y / ds[1]) for x, y in _polygon_points(r["region"] if "region" in r else r)]
        if len(pts) >= 3:
            draw.polygon(pts, fill=255, outline=255)
            draw.line(pts + [pts[0]], fill=255, width=2)
    return np.asarray(img) > 0


def region_polygons(regions: list | None) -> list[np.ndarray]:
    """Level-0 polygons (k, 2) float64 with at least 3 vertices; raises ValueError on bad geometry.

    Accepts region dicts (polygon, points or rectangle, optionally wrapped as ``{"region": …}``)
    or polygons already parsed by this function.
    """
    out = []
    for r in regions or []:
        if isinstance(r, np.ndarray):
            pts = r
        else:
            pts = _polygon_points(r["region"] if isinstance(r, dict) and "region" in r else r)
        if len(pts) >= 3:
            out.append(np.asarray(pts, dtype=np.float64).reshape(-1, 2))
    return out


def region_area_raster(regions: list | None, shape: tuple[int, int], ds: tuple[float, float]) -> np.ndarray:
    """Filled polygons (no widened outline) on a mask grid of ``shape`` (h, w); for area accounting."""
    h, w = shape
    img = Image.new("L", (w, h), 0)
    draw = ImageDraw.Draw(img)
    for poly in region_polygons(regions):
        draw.polygon([(x / ds[0], y / ds[1]) for x, y in poly.tolist()], fill=255)
    return np.asarray(img) > 0


def _segments_hit_open_rects(x0, y0, x1, y1, ax, ay, dx, dy) -> np.ndarray:
    """(n, k) bool: segment k (a + t·d, t in [0, 1]) meets the OPEN rectangle n (Liang–Barsky)."""
    def interval(a, d, lo, hi):
        with np.errstate(divide="ignore", invalid="ignore"):
            t1, t2 = (lo - a) / d, (hi - a) / d
        tlo, thi = np.minimum(t1, t2), np.maximum(t1, t2)
        flat = d == 0
        inside = (a > lo) & (a < hi)
        tlo = np.where(flat, np.where(inside, -np.inf, np.inf), tlo)
        thi = np.where(flat, np.where(inside, np.inf, -np.inf), thi)
        return tlo, thi

    txl, txh = interval(ax, dx, x0, x1)
    tyl, tyh = interval(ay, dy, y0, y1)
    lo = np.maximum(0.0, np.maximum(txl, tyl))
    hi = np.minimum(1.0, np.minimum(txh, tyh))
    return lo < hi


def _points_in_polygon(px: np.ndarray, py: np.ndarray, poly: np.ndarray) -> np.ndarray:
    """Even-odd rule for many points against one polygon."""
    ax, ay = poly[:, 0][None, :], poly[:, 1][None, :]
    bx, by = np.roll(poly[:, 0], -1)[None, :], np.roll(poly[:, 1], -1)[None, :]
    pxc, pyc = px[:, None], py[:, None]
    crosses = (ay > pyc) != (by > pyc)
    with np.errstate(divide="ignore", invalid="ignore"):
        xint = (bx - ax) * (pyc - ay) / (by - ay) + ax
    return (np.count_nonzero(crosses & (pxc < xint), axis=1) % 2) == 1


def cells_hit_regions(coords: np.ndarray, extent: tuple[int, int], regions: list[dict] | list[np.ndarray] | None,
                      *, chunk: int = 4096) -> np.ndarray:
    """(N,) bool: the patch rectangle ``[x, x+w) × [y, y+h)`` overlaps a region with positive area.

    Exact geometry in level-0 units (no rasterisation, so no widened outline): an edge of
    the polygon enters the open rectangle, or the rectangle's centre lies inside the polygon.
    """
    coords = np.asarray(coords, dtype=np.float64).reshape(-1, 2)
    n = coords.shape[0]
    hit = np.zeros(n, dtype=bool)
    polys = region_polygons(regions)
    if not n or not polys:
        return hit
    ew, eh = float(extent[0]), float(extent[1])
    for poly in polys:
        bx0, by0 = poly.min(axis=0)
        bx1, by1 = poly.max(axis=0)
        near = np.flatnonzero((coords[:, 0] < bx1) & (coords[:, 0] + ew > bx0) &
                              (coords[:, 1] < by1) & (coords[:, 1] + eh > by0) & ~hit)
        if not near.size:
            continue
        a = poly
        d = np.roll(poly, -1, axis=0) - poly
        for s in range(0, near.size, chunk):
            idx = near[s:s + chunk]
            x0, y0 = coords[idx, 0][:, None], coords[idx, 1][:, None]
            seg = _segments_hit_open_rects(x0, y0, x0 + ew, y0 + eh, a[:, 0][None, :], a[:, 1][None, :],
                                           d[:, 0][None, :], d[:, 1][None, :]).any(axis=1)
            centre = _points_in_polygon(coords[idx, 0] + ew / 2, coords[idx, 1] + eh / 2, poly)
            hit[idx] |= seg | centre
    return hit


def _integral(a: np.ndarray) -> np.ndarray:
    ii = np.zeros((a.shape[0] + 1, a.shape[1] + 1), dtype=np.int64)
    ii[1:, 1:] = np.cumsum(np.cumsum(a.astype(np.int64), axis=0), axis=1)
    return ii


def _box_sums(ii: np.ndarray, x0: np.ndarray, y0: np.ndarray, x1: np.ndarray, y1: np.ndarray) -> np.ndarray:
    return ii[y1, x1] - ii[y0, x1] - ii[y1, x0] + ii[y0, x0]


def _sat_at(ii: np.ndarray, x: np.ndarray, y: np.ndarray) -> np.ndarray:
    """Summed-area table at REAL mask coordinates (exact for a piecewise-constant mask)."""
    h1, w1 = ii.shape
    xi = np.clip(np.floor(x).astype(np.int64), 0, w1 - 2)
    yi = np.clip(np.floor(y).astype(np.int64), 0, h1 - 2)
    fx, fy = x - xi, y - yi
    return (ii[yi, xi] * (1 - fx) * (1 - fy) + ii[yi, xi + 1] * fx * (1 - fy)
            + ii[yi + 1, xi] * (1 - fx) * fy + ii[yi + 1, xi + 1] * fx * fy)


def cell_tissue_fractions(mask: np.ndarray, mask_ds: tuple[float, float], coords: np.ndarray,
                          extent: tuple[int, int], *, ii: np.ndarray | None = None) -> np.ndarray:
    """Exact area-weighted tissue fraction of each patch rectangle (outside the image counts as background)."""
    coords = np.asarray(coords, dtype=np.float64).reshape(-1, 2)
    if not coords.shape[0]:
        return np.zeros(0, dtype=np.float64)
    mh, mw = mask.shape
    dsx, dsy = float(mask_ds[0]), float(mask_ds[1])
    ii = _integral(mask) if ii is None else ii
    x0, y0 = coords[:, 0] / dsx, coords[:, 1] / dsy
    x1, y1 = (coords[:, 0] + extent[0]) / dsx, (coords[:, 1] + extent[1]) / dsy
    full = (x1 - x0) * (y1 - y0)
    cx0, cx1 = np.clip(x0, 0, mw), np.clip(x1, 0, mw)
    cy0, cy1 = np.clip(y0, 0, mh), np.clip(y1, 0, mh)
    s = _sat_at(ii, cx1, cy1) - _sat_at(ii, cx0, cy1) - _sat_at(ii, cx1, cy0) + _sat_at(ii, cx0, cy0)
    return np.clip(s / np.maximum(full, 1e-12), 0.0, 1.0)


def paint_rects(shape: tuple[int, int], mask_ds: tuple[float, float], coords: np.ndarray,
                extent: tuple[int, int]) -> np.ndarray:
    """(h, w) bool on the mask grid: pixels whose CENTRE lies in any ``[x, x+w) × [y, y+h)`` rectangle."""
    mh, mw = shape
    out = np.zeros((mh + 1, mw + 1), dtype=np.int32)
    coords = np.asarray(coords, dtype=np.float64).reshape(-1, 2)
    if coords.shape[0]:
        dsx, dsy = float(mask_ds[0]), float(mask_ds[1])
        i0 = np.clip(np.ceil(coords[:, 0] / dsx - 0.5), 0, mw).astype(np.int64)
        i1 = np.clip(np.ceil((coords[:, 0] + extent[0]) / dsx - 0.5), 0, mw).astype(np.int64)
        j0 = np.clip(np.ceil(coords[:, 1] / dsy - 0.5), 0, mh).astype(np.int64)
        j1 = np.clip(np.ceil((coords[:, 1] + extent[1]) / dsy - 0.5), 0, mh).astype(np.int64)
        ok = (i1 > i0) & (j1 > j0)
        i0, i1, j0, j1 = i0[ok], i1[ok], j0[ok], j1[ok]
        np.add.at(out, (j0, i0), 1)
        np.add.at(out, (j0, i1), -1)
        np.add.at(out, (j1, i0), -1)
        np.add.at(out, (j1, i1), 1)
    return np.cumsum(np.cumsum(out, axis=0), axis=1)[:mh, :mw] > 0


def fragment_components(mask: np.ndarray) -> tuple[np.ndarray, int, np.ndarray]:
    """8-connected components of the mask: ``(labels, n, sizes_px)`` with ``sizes_px[0]`` = background."""
    from scipy import ndimage

    labels, n = ndimage.label(mask, structure=np.ones((3, 3), dtype=bool))
    sizes = np.bincount(labels.ravel(), minlength=n + 1)
    return labels, int(n), sizes


def mask_pixel_area_um2(plan: PatchPlan, mask_ds: tuple[float, float]) -> float | None:
    if not plan.calibrated or not plan.slide_mpp:
        return None
    return float(mask_ds[0]) * plan.slide_mpp[0] * float(mask_ds[1]) * plan.slide_mpp[1]


# --------------------------------------------------------------------------- candidates


@dataclass
class Candidates:
    """Patch candidates of one slide: level-0 top-left ``coords`` plus per-cell facts.

    ``tissue_fraction`` is the exact mask-area fraction (NaN without a mask); ``origin``
    indexes :data:`ORIGINS`; ``grid_span`` is the level-0 (width, height) reachable by the
    grid (the whole slide with ``shift_inward`` or ``pad``).
    """

    coords: np.ndarray
    tissue_fraction: np.ndarray
    origin: np.ndarray
    plan: PatchPlan
    grid_span: tuple[int, int]
    stats: dict = field(default_factory=dict)

    @property
    def extent(self) -> tuple[int, int]:
        return self.plan.extent

    def __len__(self) -> int:
        return int(self.coords.shape[0])

    @property
    def sha256(self) -> str:
        body = {"version": PATCHING_VERSION_V2, "coords": self.coords.astype(np.int64).tolist(),
                "origin": [ORIGINS[i] for i in self.origin.tolist()], "extent": list(self.plan.extent),
                "level": self.plan.level, "read_size": list(self.plan.read_size), "patch_size": self.plan.patch_size}
        return hashlib.sha256(canonical_json(body)).hexdigest()

    def subset(self, idx: np.ndarray) -> "Candidates":
        idx = np.asarray(idx, dtype=np.int64)
        return Candidates(coords=self.coords[idx], tissue_fraction=self.tissue_fraction[idx],
                          origin=self.origin[idx], plan=self.plan, grid_span=self.grid_span, stats=dict(self.stats))

    def origin_counts(self) -> dict:
        counts = np.bincount(self.origin.astype(np.int64), minlength=len(ORIGINS))
        return {name: int(counts[i]) for i, name in enumerate(ORIGINS)}

    def read_floors(self, policy: PatchPolicy) -> np.ndarray:
        """Per-candidate minimum PIXEL tissue fraction for ``background_at_read``."""
        floors = np.full(len(self), float(policy.min_tissue_fraction))
        floors[self.origin == ORIGIN_RESCUE] = float(policy.read_filters.rescue_min_tissue_fraction)
        return floors


def _axis_origins(length: int, ext: int, stride: int, mode: str) -> tuple[np.ndarray, np.ndarray]:
    """Cell origins along one axis and whether each was shifted inward."""
    if length <= ext:
        if mode == "floor" and length < ext:
            return np.zeros(0, dtype=np.int64), np.zeros(0, dtype=bool)
        return np.zeros(1, dtype=np.int64), np.zeros(1, dtype=bool)
    if mode == "floor":
        n = (length - ext) // stride + 1
        return np.arange(n, dtype=np.int64) * stride, np.zeros(n, dtype=bool)
    if mode == "pad":
        n = -(-(length - ext) // stride) + 1
        return np.arange(n, dtype=np.int64) * stride, np.zeros(n, dtype=bool)
    base = np.arange(0, length - ext + 1, stride, dtype=np.int64)
    shifted = np.zeros(base.size, dtype=bool)
    if base[-1] + ext < length:
        base = np.append(base, length - ext)
        shifted = np.append(shifted, True)
    return base, shifted


def candidate_grid(dims: tuple[int, int], plan: PatchPlan, mask: np.ndarray | None,
                   mask_ds: tuple[float, float] | None, excluded: list[dict] | None,
                   policy: PatchPolicy) -> Candidates:
    """Grid candidates, rejection counts by reason, and fragment rescue (see the module docstring).

    ``mask`` is a boolean tissue mask whose pixels cover ``mask_ds`` level-0 px; ``None``
    (synthetic, no pixels) makes every cell a candidate. ``excluded`` holds region dicts in
    level-0 px (polygon, points or rectangle; optionally wrapped as ``{"region": …}``).
    """
    W, H = int(dims[0]), int(dims[1])
    ew, eh = (int(v) for v in plan.extent)
    sx = max(1, int(round(ew * policy.stride_fraction)))
    sy = max(1, int(round(eh * policy.stride_fraction)))
    xs, xshift = _axis_origins(W, ew, sx, policy.edge_mode)
    ys, yshift = _axis_origins(H, eh, sy, policy.edge_mode)
    gx, gy = np.meshgrid(xs, ys)
    ex, ey = np.meshgrid(xshift, yshift)
    cx, cy = gx.ravel(), gy.ravel()
    origin = np.where((ex | ey).ravel(), ORIGIN_EDGE, ORIGIN_GRID).astype(np.int8)
    span = (int(min(W, xs[-1] + ew)) if xs.size else 0, int(min(H, ys[-1] + eh)) if ys.size else 0)
    stats: dict = {"version": PATCHING_VERSION_V2, "policy_sha256": policy.policy_sha256,
                   "grid": {"edge_mode": policy.edge_mode, "stride": [sx, sy], "nx": int(xs.size), "ny": int(ys.size),
                            "cells": int(cx.size), "span": list(span), "slide_smaller_than_patch": W < ew or H < eh},
                   "min_tissue_fraction": policy.min_tissue_fraction}
    cells = np.stack([cx, cy], axis=1).astype(np.int64) if cx.size else np.zeros((0, 2), dtype=np.int64)
    ii = None
    if mask is not None:
        if mask_ds is None:
            raise ValueError("mask_ds is required with a mask")
        mask = np.asarray(mask, dtype=bool)
        ii = _integral(mask)
        frac = cell_tissue_fractions(mask, mask_ds, cells, (ew, eh), ii=ii)
        tissue_ok = (frac >= policy.min_tissue_fraction) & (frac > 0)
        stats["tissue_source"] = "mask"
    else:
        frac = np.full(cells.shape[0], np.nan)
        tissue_ok = np.ones(cells.shape[0], dtype=bool)
        stats["tissue_source"] = "none (every cell is a candidate)"
    polys = region_polygons(excluded)
    hit = cells_hit_regions(cells, (ew, eh), polys) if polys else np.zeros(cells.shape[0], dtype=bool)
    keep = tissue_ok & ~hit
    stats["rejected"] = {"background": int((~tissue_ok).sum()), "excluded_region": int((tissue_ok & hit).sum())}
    stats["excluded_regions"] = len(polys)
    coords, fr, org = cells[keep], frac[keep], origin[keep]

    frag_stats: dict = {"connectivity": FRAGMENT_CONNECTIVITY, "min_area_um2": policy.fragment_rescue_min_area_um2}
    if mask is None:
        frag_stats["skipped"] = "no mask"
    elif policy.fragment_rescue_min_area_um2 is None:
        frag_stats["skipped"] = "rescue disabled by policy"
    elif mask_pixel_area_um2(plan, mask_ds) is None:
        frag_stats["skipped"] = "uncalibrated: fragment areas in µm² are unknown"
    else:
        rescue, frag_stats = _rescue_fragments(mask, mask_ds, plan, (W, H), coords, polys,
                                               float(policy.fragment_rescue_min_area_um2), frag_stats)
        if rescue.shape[0]:
            coords = np.concatenate([coords, rescue])
            fr = np.concatenate([fr, cell_tissue_fractions(mask, mask_ds, rescue, (ew, eh), ii=ii)])
            org = np.concatenate([org, np.full(rescue.shape[0], ORIGIN_RESCUE, dtype=np.int8)])
    stats["fragments"] = frag_stats
    order = np.lexsort((coords[:, 0], coords[:, 1])) if coords.shape[0] else np.zeros(0, dtype=np.int64)
    out = Candidates(coords=coords[order].astype(np.int64), tissue_fraction=fr[order].astype(np.float64),
                     origin=org[order].astype(np.int8), plan=plan, grid_span=span, stats=stats)
    stats["candidates"] = len(out)
    stats["origins"] = out.origin_counts()
    return out


def _rescue_fragments(mask, mask_ds, plan, dims, coords, polys, min_area_um2, stats):
    """One tissue-centred patch per sizeable fragment that no candidate overlaps."""
    W, H = dims
    ew, eh = plan.extent
    dsx, dsy = float(mask_ds[0]), float(mask_ds[1])
    px_um2 = mask_pixel_area_um2(plan, mask_ds)
    tissue = mask & ~region_area_raster(polys, mask.shape, mask_ds) if polys else mask
    labels, n, sizes = fragment_components(tissue)
    eligible = np.zeros(n + 1, dtype=bool)
    eligible[1:] = sizes[1:] * px_um2 >= min_area_um2
    covered = paint_rects(mask.shape, mask_ds, coords, (ew, eh))
    has = np.bincount(labels[covered & (labels > 0)], minlength=n + 1) > 0
    need = np.flatnonzero(eligible & ~has)
    stats.update(components=n, eligible=int(eligible.sum()), without_candidate=int(need.size), rescued=0,
                 covered_by_other_rescue=0, blocked_by_exclusion=0, unresolved=0)
    if not need.size:
        return np.zeros((0, 2), dtype=np.int64), stats
    from scipy import ndimage

    slices = ndimage.find_objects(labels)
    rescue_cover = np.zeros(mask.shape, dtype=bool)
    out = []
    for k in need.tolist():
        sl = slices[k - 1]
        sub = labels[sl] == k
        if rescue_cover[sl][sub].any():
            stats["covered_by_other_rescue"] += 1
            continue
        yy, xx = np.nonzero(sub)
        cyc, cxc = yy.mean(), xx.mean()
        j = int(np.argmin((yy - cyc) ** 2 + (xx - cxc) ** 2))  # tissue pixel nearest the centroid
        px = (xx[j] + sl[1].start + 0.5) * dsx
        py = (yy[j] + sl[0].start + 0.5) * dsy
        x = int(min(max(0, int(round(px - ew / 2))), max(0, W - ew)))
        y = int(min(max(0, int(round(py - eh / 2))), max(0, H - eh)))
        if polys and cells_hit_regions(np.array([[x, y]]), (ew, eh), polys)[0]:
            stats["blocked_by_exclusion"] += 1
            continue
        rescue_cover |= paint_rects(mask.shape, mask_ds, np.array([[x, y]]), (ew, eh))
        out.append((x, y))
    stats["rescued"] = len(out)
    stats["unresolved"] = int(need.size - len(out) - stats["covered_by_other_rescue"])
    return (np.asarray(out, dtype=np.int64).reshape(-1, 2)), stats


# --------------------------------------------------------------------------- legacy coordinates


def tissue_coordinates(*, dims: tuple[int, int], plan: PatchPlan, mask: np.ndarray | None,
                       mask_ds: tuple[float, float] | None, excluded: list[dict], min_tissue_fraction: float,
                       max_patches: int, sample_seed: int, coordinate_source: str) -> Coordinates:
    """Legacy (``PATCHING_VERSION``) grid and sampling. Deprecated: use :func:`candidate_grid`
    and :func:`dermpath.ml.sampling.sample` with a :class:`PatchPolicy`."""
    W, H = dims
    ew, eh = plan.extent
    nx, ny = W // ew, H // eh
    xs = np.arange(nx, dtype=np.int64) * ew
    ys = np.arange(ny, dtype=np.int64) * eh
    gx, gy = np.meshgrid(xs, ys)
    cx, cy = gx.ravel(), gy.ravel()
    stats: dict = {"coordinate_source": coordinate_source, "grid_cells": int(cx.size),
                   "min_tissue_fraction": min_tissue_fraction}
    keep = np.ones(cx.size, dtype=bool)
    if mask is not None and cx.size:
        mh, mw = mask.shape
        dsx, dsy = mask_ds
        x0 = np.clip(np.floor(cx / dsx).astype(np.int64), 0, mw)
        y0 = np.clip(np.floor(cy / dsy).astype(np.int64), 0, mh)
        x1 = np.clip(np.ceil((cx + ew) / dsx).astype(np.int64), 0, mw)
        y1 = np.clip(np.ceil((cy + eh) / dsy).astype(np.int64), 0, mh)
        x1 = np.maximum(x1, np.minimum(x0 + 1, mw))
        y1 = np.maximum(y1, np.minimum(y0 + 1, mh))
        area = np.maximum((x1 - x0) * (y1 - y0), 1)
        frac = _box_sums(_integral(mask), x0, y0, x1, y1) / area
        keep &= frac >= min_tissue_fraction
        stats["cells_with_tissue"] = int(keep.sum())
    n_region_dropped = 0
    if excluded and cx.size:
        if mask is not None:
            rds, rsize = mask_ds, (mask.shape[1], mask.shape[0])
        else:
            rds = (max(1.0, ew / 4.0), max(1.0, eh / 4.0))
            rsize = (int(math.ceil(W / rds[0])), int(math.ceil(H / rds[1])))
        raster = exclusion_raster(excluded, rsize, rds)
        rh, rw = raster.shape
        x0 = np.clip(np.floor(cx / rds[0]).astype(np.int64), 0, rw)
        y0 = np.clip(np.floor(cy / rds[1]).astype(np.int64), 0, rh)
        x1 = np.clip(np.ceil((cx + ew) / rds[0]).astype(np.int64), 0, rw)
        y1 = np.clip(np.ceil((cy + eh) / rds[1]).astype(np.int64), 0, rh)
        hit = _box_sums(_integral(raster), x0, y0, x1, y1) > 0
        n_region_dropped = int((keep & hit).sum())
        keep &= ~hit
    stats["excluded_regions"] = len(excluded or [])
    stats["cells_dropped_by_excluded_regions"] = n_region_dropped
    cand = np.stack([cx[keep], cy[keep]], axis=1) if keep.any() else np.zeros((0, 2), dtype=np.int64)
    stats["candidates"] = int(cand.shape[0])
    if cand.shape[0] > max_patches:
        rng = np.random.default_rng(sample_seed)
        idx = np.sort(rng.choice(cand.shape[0], size=max_patches, replace=False))
        cand = cand[idx]
        stats["sampling"] = {"method": "seeded_uniform_without_replacement", "seed": int(sample_seed),
                             "bound": max_patches}
    else:
        stats["sampling"] = {"method": "all_candidates", "bound": max_patches}
    stats["patches"] = int(cand.shape[0])
    order = np.lexsort((cand[:, 0], cand[:, 1])) if cand.shape[0] else np.zeros(0, dtype=np.int64)
    return Coordinates(coords=cand[order].astype(np.int64), plan=plan, stats=stats)


def read_patches(osr, coords: np.ndarray, plan: PatchPlan) -> tuple[list[Image.Image], np.ndarray]:
    """Read RGB patches (background composited to white) and their mean RGB values.
    Legacy; holds every patch of ``coords`` in memory. Use :func:`iter_patch_batches`."""
    out, means = [], np.zeros((coords.shape[0], 3), dtype=np.float32)
    for i, (x, y) in enumerate(coords.tolist()):
        region = osr.read_region((int(x), int(y)), plan.level, plan.read_size)
        flat = Image.new("RGB", region.size, (255, 255, 255))
        flat.paste(region, mask=region.split()[3])
        if flat.size != (plan.patch_size, plan.patch_size):
            flat = flat.resize((plan.patch_size, plan.patch_size), Image.Resampling.BILINEAR)
        means[i] = np.asarray(flat, dtype=np.float32).reshape(-1, 3).mean(axis=0)
        out.append(flat)
    return out, means


# --------------------------------------------------------------------------- quality and reading


def _hsv(rgb_u8: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Hue in degrees [0, 360), saturation and value in [0, 1], from an (..., 3) uint8 array."""
    f = rgb_u8.astype(np.float32) / 255.0
    r, g, b = f[..., 0], f[..., 1], f[..., 2]
    v = f.max(axis=-1)
    c = v - f.min(axis=-1)
    s = np.where(v > 0, c / np.maximum(v, 1e-12), 0.0)
    h = np.zeros_like(v)
    nz = c > 1e-12
    cs = np.maximum(c, 1e-12)
    rm = nz & (v == r)
    gm = nz & (v == g) & ~rm
    bm = nz & ~rm & ~gm
    h = np.where(rm, np.mod(60.0 * (g - b) / cs, 360.0), h)
    h = np.where(gm, 60.0 * (b - r) / cs + 120.0, h)
    h = np.where(bm, 60.0 * (r - g) / cs + 240.0, h)
    return h, s, v


def pen_masks(rgb_u8: np.ndarray) -> dict[str, np.ndarray]:
    """Per-pixel ink masks (blue, green, black) by the :data:`PEN_RULES` hue rules."""
    h, s, v = _hsv(rgb_u8)
    out = {}
    for name in ("blue", "green"):
        r = PEN_RULES[name]
        out[name] = ((h >= r["hue_deg"][0]) & (h < r["hue_deg"][1]) & (s >= r["min_saturation"])
                     & (v >= r["min_value"]))
    k = PEN_RULES["black"]
    out["black"] = (v <= k["max_value"]) & (s <= k["max_saturation"])
    return out


def _laplacian_variance(gray: np.ndarray) -> float:
    lap = gray[1:-1, :-2] + gray[1:-1, 2:] + gray[:-2, 1:-1] + gray[2:, 1:-1] - 4.0 * gray[1:-1, 1:-1]
    return float(lap.var()) if lap.size else 0.0


def patch_quality(batch: np.ndarray) -> dict[str, np.ndarray]:
    """Per-patch quality of a ``uint8[B, H, W, 3]`` batch (QUALITY_VERSION).

    * ``tissue_fraction``: pixels with HSV saturation above :data:`READ_TISSUE_SATURATION`
      that are not ink;
    * ``pen_fraction`` (and ``pen_blue/green/black_fraction``): pixels matched by an ink rule;
    * ``laplacian_variance``: variance of the 4-neighbour Laplacian of the luma (float);
    * ``mean_rgb``: (B, 3).

    Computed one patch at a time, so temporaries stay at one patch's size.
    """
    batch = np.asarray(batch)
    if batch.ndim != 4 or batch.shape[-1] != 3 or batch.dtype != np.uint8:
        raise ValueError(f"patch_quality expects uint8[B, H, W, 3], got {batch.dtype}{list(batch.shape)}")
    b = batch.shape[0]
    q = {k: np.zeros(b, dtype=np.float32) for k in ("tissue_fraction", "pen_fraction", "pen_blue_fraction",
                                                   "pen_green_fraction", "pen_black_fraction",
                                                   "laplacian_variance")}
    q["mean_rgb"] = np.zeros((b, 3), dtype=np.float32)
    luma = np.array([0.299, 0.587, 0.114], dtype=np.float64)
    for i in range(b):
        p = batch[i]
        pens = pen_masks(p)
        ink = pens["blue"] | pens["green"] | pens["black"]
        sat = qc_tissue.saturation(p)
        q["tissue_fraction"][i] = float(((sat > READ_TISSUE_SATURATION) & ~ink).mean())
        q["pen_fraction"][i] = float(ink.mean())
        for name in ("blue", "green", "black"):
            q[f"pen_{name}_fraction"][i] = float(pens[name].mean())
        q["laplacian_variance"][i] = _laplacian_variance(p.astype(np.float64) @ luma)
        q["mean_rgb"][i] = p.reshape(-1, 3).mean(axis=0)
    return q


def background_fill_rgb(osr, mode: str = "slide") -> tuple[int, int, int]:
    """The RGB that transparent (unscanned) pixels are composited onto."""
    if mode == "white":
        return (255, 255, 255)
    raw = ""
    try:
        raw = str(osr.properties.get("openslide.background-color", "") or "")
    except Exception:  # noqa: BLE001 - a reader without properties falls back to white
        raw = ""
    raw = raw.strip().lstrip("#")
    if len(raw) == 6:
        try:
            return (int(raw[0:2], 16), int(raw[2:4], 16), int(raw[4:6], 16))
        except ValueError:
            pass
    return (255, 255, 255)


READ_REASONS = ("pen_marks", "background_at_read", "blur")


class ReadTally:
    """Accumulates the per-batch ``read_stats`` of :func:`iter_patch_batches` into slide totals."""

    def __init__(self):
        self.n_read = 0
        self.n_kept = 0
        self.rejected = {r: 0 for r in READ_REASONS}
        self.read_seconds = 0.0
        self.fill_rgb = None
        self.resize_filter = None

    def add(self, read_stats: dict) -> None:
        self.n_read += int(read_stats["n_read"])
        self.n_kept += int(read_stats["n_kept"])
        for r, n in read_stats["rejected"].items():
            self.rejected[r] = self.rejected.get(r, 0) + int(n)
        self.read_seconds += float(read_stats.get("read_seconds", 0.0))
        self.fill_rgb = read_stats.get("fill_rgb", self.fill_rgb)
        self.resize_filter = read_stats.get("resize_filter", self.resize_filter)

    def as_dict(self) -> dict:
        return {"n_read": self.n_read, "n_kept": self.n_kept, "rejected": dict(self.rejected),
                "read_seconds": round(self.read_seconds, 4), "fill_rgb": self.fill_rgb,
                "resize_filter": self.resize_filter}


def iter_patch_batches(osr, coords, plan: PatchPlan, *, batch_size: int = 32, policy: PatchPolicy | None = None,
                       min_read_tissue_fraction: float | np.ndarray | None = None
                       ) -> Iterator[tuple[np.ndarray, np.ndarray, dict]]:
    """Yield ``(coords_kept, uint8[B, H, W, 3], read_stats)`` one batch at a time.

    ``coords`` is a (N, 2) array or a :class:`Candidates` (whose fragment-rescue patches then
    use the policy's rescue floor). Memory is bounded: the generator holds at most one batch of
    patches (it drops its own references before reading the next batch) and never the full
    list. Each patch is read once at ``plan.level``/``plan.read_size``, composited onto the
    recorded background fill and resized once (BILINEAR) to ``plan.patch_size``.

    With a ``policy`` its ``read_filters`` apply: ``pen_marks`` first, then
    ``background_at_read`` (pixel tissue fraction below the floor), then the optional blur
    rejection. Rejected patches are not yielded; ``read_stats`` lists them by reason, and
    ``read_stats["quality"]`` holds :func:`patch_quality` for every patch READ (``kept`` marks
    the yielded ones). A batch whose patches are all rejected is still yielded, with B = 0.
    """
    if batch_size < 1:
        raise ValueError("batch_size must be >= 1")
    if policy is not None and int(policy.patch_size) != int(plan.patch_size):
        raise ValueError(f"plan patch_size {plan.patch_size} != policy patch_size {policy.patch_size}")
    floors = None
    if isinstance(coords, Candidates):
        if policy is not None and min_read_tissue_fraction is None:
            floors = coords.read_floors(policy)
        coords = coords.coords
    coords = np.asarray(coords, dtype=np.int64).reshape(-1, 2)
    n = coords.shape[0]
    if floors is None:
        if min_read_tissue_fraction is not None:
            floors = np.broadcast_to(np.asarray(min_read_tissue_fraction, dtype=np.float64), (n,))
        elif policy is not None:
            floors = np.full(n, float(policy.min_tissue_fraction))
    filters = policy.read_filters if policy is not None else None
    fill = background_fill_rgb(osr, policy.background_fill if policy is not None else "white")
    filt_name = policy.resize_filter if policy is not None else plan.resize_filter
    resample = RESIZE_FILTERS[filt_name]
    ps = int(plan.patch_size)
    for start in range(0, n, batch_size):
        chunk = coords[start:start + batch_size]
        b = chunk.shape[0]
        out = np.empty((b, ps, ps, 3), dtype=np.uint8)
        t0 = time.perf_counter()
        resized = 0
        for i, (x, y) in enumerate(chunk.tolist()):
            region = osr.read_region((int(x), int(y)), plan.level, plan.read_size)
            flat = Image.new("RGB", region.size, fill)
            flat.paste(region, mask=region.split()[3])
            if flat.size != (ps, ps):
                flat = flat.resize((ps, ps), resample)
                resized += 1
            out[i] = np.asarray(flat)
            del region, flat
        t_read = time.perf_counter() - t0
        quality = patch_quality(out)
        kept = np.ones(b, dtype=bool)
        reason = np.full(b, "", dtype=object)
        if filters is not None:
            if filters.pen_marks:
                r = kept & (quality["pen_fraction"] > filters.pen_max_fraction)
                reason[r], kept[r] = "pen_marks", False
            if filters.background_at_read and floors is not None:
                r = kept & (quality["tissue_fraction"] < floors[start:start + b])
                reason[r], kept[r] = "background_at_read", False
            if filters.blur_reject_below is not None:
                r = kept & (quality["laplacian_variance"] < float(filters.blur_reject_below))
                reason[r], kept[r] = "blur", False
        rejected = {k: int((reason == k).sum()) for k in READ_REASONS}
        stats = {"version": PATCHING_VERSION_V2, "quality_version": QUALITY_VERSION, "start": start, "n_read": b,
                 "n_kept": int(kept.sum()), "rejected": rejected,
                 "rejected_coords": [[int(chunk[i, 0]), int(chunk[i, 1]), str(reason[i])] for i in np.flatnonzero(~kept)],
                 "kept": kept, "coords_read": chunk, "quality": quality, "fill_rgb": list(fill),
                 "resize_filter": filt_name, "resized": resized, "read_seconds": round(t_read, 6)}
        patches = out if kept.all() else out[kept]
        kept_coords = chunk.copy() if kept.all() else chunk[kept]
        del out
        yield kept_coords, patches, stats
        # Drop this generator's references before the next batch is allocated.
        del patches, kept_coords, stats, quality, chunk
