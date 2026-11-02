"""Heuristic focus indicator: variance of the Laplacian on tissue tiles at level 0.

EXPERIMENTAL HEURISTIC. A low variance suggests blur, but the value also depends on
stain intensity, tissue type, JPEG compression and magnification. The threshold is a
configurable, UNCALIBRATED default (``WB_QC_BLUR_THRESHOLD``); the result only creates a
suggestion for human review.
"""

from __future__ import annotations

import numpy as np
from openslide import AbstractSlide

METHOD_VERSION = "laplacian-variance-1"
TILE = 256


def laplacian_variance(gray: np.ndarray) -> float:
    g = gray.astype(np.float64)
    lap = (g[1:-1, :-2] + g[1:-1, 2:] + g[:-2, 1:-1] + g[2:, 1:-1] - 4.0 * g[1:-1, 1:-1])
    return float(lap.var())


def sample_tiles(mask: np.ndarray, level0_size: tuple[int, int], max_tiles: int = 12,
                 min_coverage: float = 0.5) -> list[tuple[int, int]]:
    """Deterministically pick level-0 tile origins whose area is mostly tissue."""
    W, H = level0_size
    mh, mw = mask.shape
    sx, sy = W / mw, H / mh
    candidates = []
    for ty in range(0, max(1, H - TILE + 1), TILE):
        for tx in range(0, max(1, W - TILE + 1), TILE):
            x0, x1 = int(tx / sx), max(int(tx / sx) + 1, int((tx + TILE) / sx))
            y0, y1 = int(ty / sy), max(int(ty / sy) + 1, int((ty + TILE) / sy))
            cov = float(mask[y0:y1, x0:x1].mean()) if mask[y0:y1, x0:x1].size else 0.0
            if cov >= min_coverage:
                candidates.append((tx, ty))
    if len(candidates) <= max_tiles:
        return candidates
    step = len(candidates) / max_tiles
    return [candidates[int(i * step)] for i in range(max_tiles)]


def measure(slide: AbstractSlide, mask: np.ndarray, threshold: float, max_tiles: int = 12) -> dict:
    W, H = slide.dimensions
    origins = sample_tiles(mask, (W, H), max_tiles=max_tiles)
    values = []
    for tx, ty in origins:
        w, h = min(TILE, W - tx), min(TILE, H - ty)
        region = slide.read_region((tx, ty), 0, (w, h)).convert("L")
        values.append(round(laplacian_variance(np.asarray(region)), 3))
    if not values:
        return {
            "method": METHOD_VERSION, "tiles_measured": 0, "median_variance": None,
            "threshold": threshold, "threshold_calibrated": False,
            "low_focus_fraction": None, "suspected_blur": None,
            "note": "no tissue tiles available for a focus measurement",
        }
    arr = np.array(values)
    median = float(np.median(arr))
    return {
        "method": METHOD_VERSION,
        "level": 0,
        "tile_size": TILE,
        "tiles_measured": len(values),
        "tile_origins_level0": [list(o) for o in origins],
        "variances": values,
        "median_variance": round(median, 3),
        "threshold": threshold,
        "threshold_calibrated": False,
        "low_focus_fraction": round(float((arr < threshold).mean()), 4),
        "suspected_blur": median < threshold,
    }
