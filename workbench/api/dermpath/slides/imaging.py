"""Small image helpers: thumbnails and perceptual hashes (for near-duplicate CANDIDATES)."""

from __future__ import annotations

import io

import numpy as np
from PIL import Image

THUMBNAIL_MAX = 512


#: Above this many pixels in the chosen pyramid level, thumbnails are built strip by strip.
DIRECT_THUMBNAIL_MAX_PIXELS = 16_000_000
STRIP_ROWS = 1024


def bounded_thumbnail(slide, size: tuple[int, int]) -> Image.Image:
    """Like ``AbstractSlide.get_thumbnail`` but with bounded memory.

    ``get_thumbnail`` decodes the whole best-matching level at once; for a large single-level
    file that is the entire image. Here, levels above :data:`DIRECT_THUMBNAIL_MAX_PIXELS` are
    read in horizontal strips that are downscaled as they arrive.
    """
    W, H = slide.dimensions
    downsample = max(W / size[0], H / size[1], 1.0)
    level = slide.get_best_level_for_downsample(downsample)
    lw, lh = slide.level_dimensions[level]
    if lw * lh <= DIRECT_THUMBNAIL_MAX_PIXELS:
        return slide.get_thumbnail(size).convert("RGB")
    ds = slide.level_downsamples[level]
    scale = min(size[0] / lw, size[1] / lh)
    tw, th = max(1, int(lw * scale)), max(1, int(lh * scale))
    bg = "#" + slide.properties.get("openslide.background-color", "ffffff")
    out = Image.new("RGB", (tw, th), bg)
    y = 0
    while y < lh:
        rows = min(STRIP_ROWS, lh - y)
        strip = slide.read_region((0, int(y * ds)), level, (lw, rows))
        flat = Image.new("RGB", strip.size, bg)
        flat.paste(strip, mask=strip.split()[3])
        y0, y1 = int(round(y * scale)), int(round((y + rows) * scale))
        if y1 > y0:
            out.paste(flat.resize((tw, y1 - y0), Image.Resampling.BILINEAR), (0, y0))
        y += rows
    return out


def to_jpeg(img: Image.Image, quality: int = 85) -> bytes:
    buf = io.BytesIO()
    img.convert("RGB").save(buf, "JPEG", quality=quality)
    return buf.getvalue()


def dhash(img: Image.Image, size: int = 8) -> str:
    """64-bit difference hash as 16 hex chars. Robust to scale/JPEG noise, not to crops."""
    g = img.convert("L").resize((size + 1, size), Image.Resampling.LANCZOS)
    a = np.asarray(g, dtype=np.int16)
    bits = (a[:, 1:] > a[:, :-1]).flatten()
    value = 0
    for b in bits:
        value = (value << 1) | int(b)
    return f"{value:0{size * size // 4}x}"


def hamming_hex(a: str, b: str) -> int:
    return bin(int(a, 16) ^ int(b, 16)).count("1")
