"""Tissue/background segmentation by Otsu thresholding on a downsampled image.

EXPERIMENTAL HEURISTIC. The channel is HSV saturation (white/grey background has low
saturation; stained tissue and coloured synthetic shapes have high saturation). A floor
on the threshold stops faint noise on an empty slide being called tissue.
"""

from __future__ import annotations

import io

import numpy as np
from PIL import Image

METHOD_VERSION = "otsu-saturation-1"
THRESHOLD_FLOOR = 20  # on a 0–255 saturation scale


def otsu_threshold(values: np.ndarray) -> tuple[int, bool]:
    """Return ``(threshold, degenerate)`` for uint8 data. Pixels > threshold are foreground."""
    hist = np.bincount(values.ravel(), minlength=256).astype(np.float64)
    total = hist.sum()
    if total == 0 or np.count_nonzero(hist) < 2:
        return 0, True
    bins = np.arange(256, dtype=np.float64)
    w0 = np.cumsum(hist)
    w1 = total - w0
    s0 = np.cumsum(hist * bins)
    mu_t = s0[-1]
    with np.errstate(divide="ignore", invalid="ignore"):
        mu0 = s0 / w0
        mu1 = (mu_t - s0) / w1
        between = w0 * w1 * (mu0 - mu1) ** 2
    between[~np.isfinite(between)] = -1
    return int(np.argmax(between)), False


def saturation(rgb: np.ndarray) -> np.ndarray:
    rgb = rgb.astype(np.float32)
    mx = rgb.max(axis=2)
    mn = rgb.min(axis=2)
    with np.errstate(divide="ignore", invalid="ignore"):
        s = np.where(mx > 0, (mx - mn) / mx, 0.0)
    return np.clip(s * 255.0, 0, 255).astype(np.uint8)


def segment(img: Image.Image, level0_size: tuple[int, int]) -> tuple[np.ndarray, dict]:
    """Segment a downsampled RGB image. Returns ``(mask, stats)``; mask is bool HxW."""
    rgb = np.asarray(img.convert("RGB"))
    sat = saturation(rgb)
    t, degenerate = otsu_threshold(sat)
    floor_applied = t < THRESHOLD_FLOOR
    t_eff = max(t, THRESHOLD_FLOOR)
    mask = sat > t_eff
    h, w = mask.shape
    tissue = int(mask.sum())
    total = int(mask.size)
    sx = level0_size[0] / w
    sy = level0_size[1] / h
    bbox = None
    if tissue:
        ys, xs = np.nonzero(mask)
        bbox = [round(float(xs.min() * sx), 1), round(float(ys.min() * sy), 1),
                round(float((xs.max() + 1) * sx), 1), round(float((ys.max() + 1) * sy), 1)]
    stats = {
        "method": METHOD_VERSION,
        "channel": "hsv_saturation",
        "otsu_threshold": t,
        "threshold_used": t_eff,
        "threshold_floor": THRESHOLD_FLOOR,
        "threshold_floor_applied": floor_applied,
        "otsu_degenerate": degenerate,
        "mask_width": w,
        "mask_height": h,
        "mask_downsample_x": round(sx, 4),
        "mask_downsample_y": round(sy, 4),
        "tissue_pixels": tissue,
        "total_pixels": total,
        "tissue_fraction": round(tissue / total, 6) if total else 0.0,
        "tissue_bbox_level0": bbox,
    }
    return mask, stats


def mask_png(mask: np.ndarray) -> bytes:
    buf = io.BytesIO()
    Image.fromarray((mask * 255).astype(np.uint8), "L").save(buf, "PNG", optimize=True)
    return buf.getvalue()
