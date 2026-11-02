"""Tissue coordinates and patches at a calibrated (or explicitly uncalibrated) scale.

Scale
-----
* mpp known: patches cover ``patch_size × target_mpp`` microns. The level-0 extent is
  ``patch_size × target_mpp / mpp``; the pyramid level closest to (not above) that
  downsample is read and resized to ``patch_size``. Recorded as ``calibrated``.
* mpp unknown: a FIXED pyramid level (closest to ``fallback_downsample``) is used and the
  scale is recorded as ``uncalibrated scale`` (patch content in microns is unknown).

Tissue
------
The latest automated QC screen's tissue mask (Otsu on saturation, experimental) is used when
it exists; otherwise the same Otsu segmentation is run on a bounded thumbnail and recorded as
``otsu_fallback``. A grid cell is kept when its tissue fraction reaches
``min_tissue_fraction`` and it does not touch any region a human excluded in QC
(``exclude_region``). More than ``max_patches_per_slide`` cells → seeded sampling.

``pixel_mode="none"`` (synthetic encoder only) skips pixels entirely: a regular grid over
the slide's declared dimensions, still minus excluded regions, recorded as
``synthetic_grid_no_pixels``.
"""

from __future__ import annotations

import hashlib
import io
import math
import threading
from collections import OrderedDict
from dataclasses import dataclass, field

import numpy as np
from PIL import Image, ImageDraw

from ..qc import tissue as qc_tissue
from ..slides.imaging import bounded_thumbnail
from .artifacts import canonical_json

PATCHING_VERSION = "dermpath.patching/1"
FALLBACK_MASK_SIZE = 1024
UNCALIBRATED_NOTE = "uncalibrated scale: microns-per-pixel unknown, a fixed pyramid level was used"


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


def plan_scale(*, mpp_x: float | None, mpp_y: float | None, level_downsamples: list[float], patch_size: int,
               target_mpp: float, fallback_downsample: float) -> PatchPlan:
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
                         scale_key=f"mpp={target_mpp:g}")
    level = _best_level(downsamples, fallback_downsample)
    ds = downsamples[level]
    ext = (int(round(patch_size * ds)), int(round(patch_size * ds)))
    return PatchPlan(level=level, level_downsample=ds, read_size=(patch_size, patch_size), extent=ext,
                     patch_size=patch_size, calibrated=False,
                     scale={"mode": "uncalibrated", "level": level, "level_downsample": ds, "note": UNCALIBRATED_NOTE},
                     scale_key=f"level={level}(ds={ds:g})")


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


def _integral(a: np.ndarray) -> np.ndarray:
    ii = np.zeros((a.shape[0] + 1, a.shape[1] + 1), dtype=np.int64)
    ii[1:, 1:] = np.cumsum(np.cumsum(a.astype(np.int64), axis=0), axis=1)
    return ii


def _box_sums(ii: np.ndarray, x0: np.ndarray, y0: np.ndarray, x1: np.ndarray, y1: np.ndarray) -> np.ndarray:
    return ii[y1, x1] - ii[y0, x1] - ii[y1, x0] + ii[y0, x0]


def tissue_coordinates(*, dims: tuple[int, int], plan: PatchPlan, mask: np.ndarray | None,
                       mask_ds: tuple[float, float] | None, excluded: list[dict], min_tissue_fraction: float,
                       max_patches: int, sample_seed: int, coordinate_source: str) -> Coordinates:
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
    """Read RGB patches (background composited to white) and their mean RGB values."""
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
