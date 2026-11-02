"""``handcrafted-stain-texture-v1``: a weights-free, label-free technical baseline on real pixels.

It is NOT a pathology foundation model and has no learned pathology knowledge. It exists so
the real-image pipeline has a deterministic baseline that reads pixels, needs no weights and
no licence, and that a foundation encoder must beat on the same frozen data.

Features (64, float32, deterministic numpy; per patch, independent of batch composition)
--------------------------------------------------------------------------------------
Patches arrive as ``uint8`` RGB ``(N, 224, 224, 3)`` at the target mpp; nothing is resized.
With ``I = (pixel + 1) / 256`` and optical density ``OD = -log10(I)`` per channel:

* RGB (15): per channel mean, std and the 10th, 50th and 90th percentiles of ``pixel / 255``.
* OD (9): per channel mean, std and 90th percentile.
* Ruifrok–Johnston colour deconvolution (14): concentrations ``C = OD @ inv(M)`` with the
  unit-normalised H, E and DAB optical-density vectors of Ruifrok & Johnston (2001) as the rows
  of ``M``. For H and E: mean, std, p10, p50, p90; for the third (residual/DAB) channel: mean
  and std; and the mean H and E concentration (clipped at 0) over tissue pixels.
* Tissue and intensity (10): pixel tissue fraction (``sum(OD) > 0.15``), grey (Rec. 601 luma)
  mean and std, HSV saturation mean and std, dark fraction (grey < 0.2), bright fraction
  (grey > 0.9), fraction of pixels that are tissue with H > E, grey-level entropy (32 bins,
  bits), and ``log((H_tissue + 1e-3) / (E_tissue + 1e-3))``.
* Sharpness and gradients (6): ``log(var(Laplacian) + 1e-10)`` (4-neighbour Laplacian on
  grey), gradient magnitude (central differences) mean, std, p50, p90, and structure-tensor
  coherence ``sqrt((Jxx - Jyy)^2 + 4 Jxy^2) / (Jxx + Jyy + 1e-12)``.
* Texture (10): rotation-invariant uniform LBP (``riu2``, 8 neighbours at radius 1, ``>=``
  comparison on grey) histogram, normalised, bins 0..8 plus one non-uniform bin.

Identity: there are no weights, so the identity is a code hash,
``handcrafted:<ADAPTER_VERSION>:<sha256 of this file>`` (:func:`code_identity`). Any edit to
this file therefore produces a new identity (and a new feature set).
"""

from __future__ import annotations

import functools
import hashlib
from pathlib import Path

import numpy as np

HANDCRAFTED_ID = "handcrafted-stain-texture-v1"
ADAPTER_VERSION = "1"
INPUT_SIZE = 224
TISSUE_OD_THRESHOLD = 0.15
_CHUNK = 8  # patches per vectorised step; bounds memory, never changes values (features are per patch)

# Ruifrok & Johnston (2001), Anal Quant Cytol Histol 23:291-299: optical-density vectors of
# haematoxylin, eosin and DAB (rows), normalised to unit length before inversion.
_STAIN_OD = np.array([[0.65, 0.70, 0.29], [0.07, 0.99, 0.11], [0.27, 0.57, 0.78]], dtype=np.float64)
STAIN_MATRIX = _STAIN_OD / np.linalg.norm(_STAIN_OD, axis=1, keepdims=True)
_DECONV = np.linalg.inv(STAIN_MATRIX)

_RGB = ("r", "g", "b")
FEATURE_NAMES: tuple[str, ...] = (
    *(f"rgb_{stat}_{c}" for stat in ("mean", "std", "p10", "p50", "p90") for c in _RGB),
    *(f"od_{stat}_{c}" for stat in ("mean", "std", "p90") for c in _RGB),
    *(f"{s}_{stat}" for s in ("h", "e") for stat in ("mean", "std", "p10", "p50", "p90")),
    "residual_mean", "residual_std", "h_mean_tissue", "e_mean_tissue",
    "tissue_fraction", "grey_mean", "grey_std", "saturation_mean", "saturation_std", "dark_fraction",
    "bright_fraction", "h_dominant_tissue_fraction", "grey_entropy_bits", "h_e_log_ratio_tissue",
    "log_laplacian_var", "grad_mean", "grad_std", "grad_p50", "grad_p90", "grad_coherence",
    *(f"lbp_riu2_{k}" for k in range(9)), "lbp_riu2_nonuniform",
)
EMBEDDING_DIM = len(FEATURE_NAMES)
assert EMBEDDING_DIM == 64, EMBEDDING_DIM

# 8 neighbours at radius 1, in circular order (needed for the uniformity count).
_NEIGHBOURS = ((-1, -1), (-1, 0), (-1, 1), (0, 1), (1, 1), (1, 0), (1, -1), (0, -1))


def _riu2_table() -> np.ndarray:
    table = np.empty(256, dtype=np.int64)
    for code in range(256):
        bits = [(code >> k) & 1 for k in range(8)]
        transitions = sum(bits[k] != bits[(k + 1) % 8] for k in range(8))
        table[code] = sum(bits) if transitions <= 2 else 9
    return table


_RIU2 = _riu2_table()


@functools.lru_cache(maxsize=1)
def code_identity() -> str:
    """``handcrafted:<adapter_version>:<sha256 of this module's source bytes>``."""
    return f"handcrafted:{ADAPTER_VERSION}:{hashlib.sha256(Path(__file__).read_bytes()).hexdigest()}"


def check_patches(patches_uint8: np.ndarray, input_size: int = INPUT_SIZE) -> np.ndarray:
    """Validate ``uint8 (N, input_size, input_size, 3)``; nothing is ever resized."""
    if not isinstance(patches_uint8, np.ndarray):
        raise TypeError(f"patches must be a numpy array, not {type(patches_uint8).__name__}")
    if patches_uint8.dtype != np.uint8:
        raise ValueError(f"patches must be uint8 RGB, got dtype {patches_uint8.dtype}")
    if patches_uint8.ndim != 4 or patches_uint8.shape[3] != 3:
        raise ValueError(f"patches must have shape (N, H, W, 3), got {patches_uint8.shape}")
    h, w = int(patches_uint8.shape[1]), int(patches_uint8.shape[2])
    if h != input_size or w != input_size:
        raise ValueError(f"patches must be exactly {input_size}x{input_size} px (got {h}x{w}); the encoder never "
                         "resizes, so read them at that size at the target mpp")
    return patches_uint8


def _pct(a: np.ndarray, q) -> np.ndarray:
    return np.percentile(a, q, axis=1)


def _lbp_hist(grey: np.ndarray) -> np.ndarray:
    n, h, w = grey.shape
    centre = grey[:, 1:h - 1, 1:w - 1]
    code = np.zeros(centre.shape, dtype=np.int64)
    for bit, (dy, dx) in enumerate(_NEIGHBOURS):
        neighbour = grey[:, 1 + dy:h - 1 + dy, 1 + dx:w - 1 + dx]
        code |= (neighbour >= centre).astype(np.int64) << bit
    labels = _RIU2[code].reshape(n, -1)
    offsets = (np.arange(n, dtype=np.int64) * 10)[:, None]
    counts = np.bincount((labels + offsets).ravel(), minlength=10 * n).reshape(n, 10).astype(np.float64)
    return counts / labels.shape[1]


def _chunk_features(x8: np.ndarray) -> np.ndarray:
    n = x8.shape[0]
    rgb = x8.reshape(n, -1, 3).astype(np.float64) / 255.0
    od = -np.log10((x8.reshape(n, -1, 3).astype(np.float64) + 1.0) / 256.0)
    conc = od @ _DECONV  # (n, P, 3): H, E, residual (DAB)
    grey_flat = rgb @ np.array([0.299, 0.587, 0.114])
    grey = grey_flat.reshape(n, x8.shape[1], x8.shape[2])
    tissue = od.sum(axis=2) > TISSUE_OD_THRESHOLD
    n_tissue = tissue.sum(axis=1)
    feats: list[np.ndarray] = []

    # RGB (15)
    feats += [rgb.mean(axis=1), rgb.std(axis=1)]
    p = _pct(rgb, [10, 50, 90])  # (3, n, 3)
    feats += [p[0], p[1], p[2]]
    # OD (9)
    feats += [od.mean(axis=1), od.std(axis=1), _pct(od, 90)]
    # stain deconvolution (14)
    for s in (0, 1):
        c = conc[:, :, s]
        ps = _pct(c, [10, 50, 90])
        feats += [c.mean(axis=1)[:, None], c.std(axis=1)[:, None], ps[0][:, None], ps[1][:, None], ps[2][:, None]]
    feats += [conc[:, :, 2].mean(axis=1)[:, None], conc[:, :, 2].std(axis=1)[:, None]]
    clipped = np.clip(conc[:, :, :2], 0.0, None)
    denom = np.maximum(n_tissue, 1)
    h_t = np.where(n_tissue > 0, (clipped[:, :, 0] * tissue).sum(axis=1) / denom, 0.0)
    e_t = np.where(n_tissue > 0, (clipped[:, :, 1] * tissue).sum(axis=1) / denom, 0.0)
    feats += [h_t[:, None], e_t[:, None]]
    # tissue and intensity (10)
    cmax, cmin = rgb.max(axis=2), rgb.min(axis=2)
    sat = np.where(cmax > 0, (cmax - cmin) / np.where(cmax > 0, cmax, 1.0), 0.0)
    bins = np.minimum((grey_flat * 32).astype(np.int64), 31) + (np.arange(n, dtype=np.int64) * 32)[:, None]
    hist = np.bincount(bins.ravel(), minlength=32 * n).reshape(n, 32) / grey_flat.shape[1]
    with np.errstate(divide="ignore", invalid="ignore"):
        entropy = -np.where(hist > 0, hist * np.log2(np.where(hist > 0, hist, 1.0)), 0.0).sum(axis=1)
    h_dom = ((conc[:, :, 0] > conc[:, :, 1]) & tissue).mean(axis=1)
    feats += [np.stack([tissue.mean(axis=1), grey_flat.mean(axis=1), grey_flat.std(axis=1), sat.mean(axis=1),
                        sat.std(axis=1), (grey_flat < 0.2).mean(axis=1), (grey_flat > 0.9).mean(axis=1), h_dom,
                        entropy, np.log((h_t + 1e-3) / (e_t + 1e-3))], axis=1)]
    # sharpness and gradients (6)
    lap = (grey[:, :-2, 1:-1] + grey[:, 2:, 1:-1] + grey[:, 1:-1, :-2] + grey[:, 1:-1, 2:]
           - 4.0 * grey[:, 1:-1, 1:-1]).reshape(n, -1)
    gx = ((grey[:, 1:-1, 2:] - grey[:, 1:-1, :-2]) / 2.0).reshape(n, -1)
    gy = ((grey[:, 2:, 1:-1] - grey[:, :-2, 1:-1]) / 2.0).reshape(n, -1)
    mag = np.sqrt(gx * gx + gy * gy)
    pg = _pct(mag, [50, 90])
    jxx, jyy, jxy = (gx * gx).mean(axis=1), (gy * gy).mean(axis=1), (gx * gy).mean(axis=1)
    coherence = np.sqrt((jxx - jyy) ** 2 + 4.0 * jxy ** 2) / (jxx + jyy + 1e-12)
    feats += [np.stack([np.log(lap.var(axis=1) + 1e-10), mag.mean(axis=1), mag.std(axis=1), pg[0], pg[1],
                        coherence], axis=1)]
    # texture (10)
    feats.append(_lbp_hist(grey))
    out = np.concatenate(feats, axis=1)
    if out.shape[1] != EMBEDDING_DIM:  # pragma: no cover - guarded by the module-level assert and tests
        raise AssertionError(f"handcrafted feature count {out.shape[1]} != {EMBEDDING_DIM}")
    return out


def features(patches_uint8: np.ndarray, *, input_size: int = INPUT_SIZE) -> np.ndarray:
    """Float32 ``(N, 64)`` features for ``uint8 (N, input_size, input_size, 3)`` patches.

    Deterministic: the same pixels always give the same bytes, independent of batch size or
    position. Reads pixels only; there is no label input.
    """
    x = check_patches(patches_uint8, input_size)
    if x.shape[0] == 0:
        return np.zeros((0, EMBEDDING_DIM), dtype=np.float32)
    parts = [_chunk_features(x[i:i + _CHUNK]) for i in range(0, x.shape[0], _CHUNK)]
    out = np.concatenate(parts, axis=0)
    if not np.all(np.isfinite(out)):  # pragma: no cover - every term is bounded or epsilon-guarded
        raise FloatingPointError("handcrafted features produced a non-finite value")
    return out.astype(np.float32)
