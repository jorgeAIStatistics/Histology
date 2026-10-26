"""Procedural synthetic tiled images: clearly NON-histological, deterministic patterns.

A :class:`SyntheticSlide` implements OpenSlide's ``AbstractSlide`` interface, so the
same ``DeepZoomGenerator`` and the same token-checked DZI routes serve it exactly like a
real slide. Every tile carries the burned-in text ``SYNTHETIC — NO HISTOLOGY``.

Content (all in level-0 coordinates): a near-white background; a few coloured ellipses
filled with concentric rings and diagonal stripes in teal / amber / slate; a coordinate
grid every 2048 px; a fine hash-noise texture (so a focus heuristic has something to
measure). Nothing resembles tissue, cells or stain.

Determinism: the image is a pure function of the spec (seed, size, variant). The slide's
``sha256`` is the SHA-256 of the canonical spec JSON (there is no file).

Variants: ``standard``; ``low_tissue`` (one small shape); ``blurred`` (Gaussian blur, to
exercise the focus heuristic); ``near_duplicate`` (``base_seed`` content with a tiny
colour shift, to exercise near-duplicate candidate detection).
"""

from __future__ import annotations

import hashlib
import json
import math
import random
from collections.abc import Mapping
from functools import lru_cache

import numpy as np
from openslide import AbstractSlide
from PIL import Image, ImageDraw, ImageFilter, ImageFont

GENERATOR_ID = "dermpath.synthetic/1"
NOTICE = "SYNTHETIC — NO HISTOLOGY"
VARIANTS = ("standard", "low_tissue", "blurred", "near_duplicate")

_BG = np.array([246, 245, 241], dtype=np.float32)
# No dark colours: burned-in text is the only near-black content (tests rely on this).
_PALETTES = [
    [(42, 142, 140), (232, 172, 64), (112, 122, 172)],
    [(60, 160, 150), (220, 150, 70), (130, 110, 160)],
    [(80, 150, 170), (236, 190, 90), (100, 140, 120)],
]
_GRID_RGB = np.array([175, 178, 184], dtype=np.float32)
_TEXT_SPACING = (820, 380)  # in output (level) pixels
_FONT_SIZE = 30


def make_spec(seed: int, *, width: int = 16384, height: int = 12288, variant: str = "standard",
              base_seed: int | None = None, downsamples: tuple[int, ...] = (1, 4, 16, 64)) -> dict:
    if variant not in VARIANTS:
        raise ValueError(f"unknown synthetic variant {variant}")
    spec = {
        "generator": GENERATOR_ID,
        "seed": int(seed),
        "width": int(width),
        "height": int(height),
        "downsamples": [int(d) for d in downsamples],
        "variant": variant,
        "notice": NOTICE,
    }
    if variant == "near_duplicate":
        spec["base_seed"] = int(base_seed if base_seed is not None else seed)
    return spec


def spec_sha256(spec: Mapping) -> str:
    canon = json.dumps(spec, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    return hashlib.sha256(canon.encode()).hexdigest()


@lru_cache(maxsize=4)
def _font(size: int) -> ImageFont.ImageFont:
    try:
        return ImageFont.load_default(size=size)
    except Exception:  # pragma: no cover - Pillow without FreeType
        return ImageFont.load_default()


class SyntheticSlide(AbstractSlide):
    def __init__(self, spec: Mapping) -> None:
        super().__init__()
        if spec.get("generator") != GENERATOR_ID:
            raise ValueError("not a synthetic slide spec")
        self.spec = dict(spec)
        self._w = int(spec["width"])
        self._h = int(spec["height"])
        self._ds = tuple(float(d) for d in spec["downsamples"])
        self._dims = tuple((max(1, self._w // int(d)), max(1, self._h // int(d))) for d in self._ds)
        self.variant = spec.get("variant", "standard")
        content_seed = int(spec.get("base_seed", spec["seed"])) if self.variant == "near_duplicate" else int(spec["seed"])
        rng = random.Random(content_seed)
        self._palette = [np.array(c, dtype=np.float32) for c in _PALETTES[rng.randrange(len(_PALETTES))]]
        if self.variant == "near_duplicate":
            shift = 6.0 + (int(spec["seed"]) % 5)
            self._palette = [np.clip(c + shift, 0, 255) for c in self._palette]
        n = 1 if self.variant == "low_tissue" else rng.randint(3, 5)
        self._blobs = []
        for i in range(n):
            if self.variant == "low_tissue":
                rx, ry = self._w * 0.06, self._h * 0.05
            else:
                rx = self._w * rng.uniform(0.12, 0.22)
                ry = self._h * rng.uniform(0.12, 0.24)
            cx = rng.uniform(rx + self._w * 0.05, self._w - rx - self._w * 0.05)
            cy = rng.uniform(ry + self._h * 0.05, self._h - ry - self._h * 0.05)
            self._blobs.append((cx, cy, rx, ry))
        self._ring_period = rng.uniform(380.0, 720.0)
        self._stripe_period = rng.uniform(900.0, 1500.0)
        self._noise_seed = content_seed * 2654435761 % (2**31)
        self._text_offset = (rng.randrange(0, 200), rng.randrange(0, 120))
        self._props = {
            "openslide.vendor": "dermpath-synthetic",
            "openslide.level-count": str(len(self._ds)),
            "openslide.background-color": "F6F5F1",
            "dermpath.synthetic": "true",
            "dermpath.synthetic.notice": NOTICE,
            "dermpath.synthetic.variant": self.variant,
        }
        for i, (d, (w, h)) in enumerate(zip(self._ds, self._dims, strict=True)):
            self._props[f"openslide.level[{i}].downsample"] = repr(d)
            self._props[f"openslide.level[{i}].width"] = str(w)
            self._props[f"openslide.level[{i}].height"] = str(h)

    # ---- AbstractSlide API ------------------------------------------------
    @classmethod
    def detect_format(cls, filename) -> str | None:  # noqa: D401 - not file-backed
        return None

    def close(self) -> None:
        pass

    @property
    def level_count(self) -> int:
        return len(self._ds)

    @property
    def level_dimensions(self) -> tuple[tuple[int, int], ...]:
        return self._dims

    @property
    def level_downsamples(self) -> tuple[float, ...]:
        return self._ds

    @property
    def properties(self) -> Mapping[str, str]:
        return self._props

    @property
    def associated_images(self) -> Mapping[str, Image.Image]:
        return {}  # no label or macro images exist

    def get_best_level_for_downsample(self, downsample: float) -> int:
        best = 0
        for i, d in enumerate(self._ds):
            if d <= downsample:
                best = i
        return best

    def read_region(self, location: tuple[int, int], level: int, size: tuple[int, int]) -> Image.Image:
        x0, y0 = location
        w, h = size
        if w <= 0 or h <= 0:
            raise ValueError("region size must be positive")
        d = self._ds[level]
        pad = 12 if self.variant == "blurred" else 0
        rgb, inside = self._render(x0 - pad * d, y0 - pad * d, w + 2 * pad, h + 2 * pad, d)
        img = Image.fromarray(rgb, "RGB")
        self._burn_text(img, (x0 / d) - pad, (y0 / d) - pad)
        if pad:
            img = img.filter(ImageFilter.GaussianBlur(radius=4)).crop((pad, pad, pad + w, pad + h))
            inside = inside[pad:pad + h, pad:pad + w]
        alpha = Image.fromarray((inside * 255).astype(np.uint8), "L")
        out = img.convert("RGBA")
        out.putalpha(alpha)
        return out

    # ---- rendering ----------------------------------------------------------
    def _render(self, x0: float, y0: float, w: int, h: int, d: float) -> tuple[np.ndarray, np.ndarray]:
        xs = x0 + (np.arange(w, dtype=np.float64) + 0.5) * d
        ys = y0 + (np.arange(h, dtype=np.float64) + 0.5) * d
        X, Y = np.meshgrid(xs, ys)
        inside = (X >= 0) & (Y >= 0) & (X < self._w) & (Y < self._h)
        fg = np.zeros(X.shape, dtype=bool)
        for cx, cy, rx, ry in self._blobs:
            fg |= ((X - cx) / rx) ** 2 + ((Y - cy) / ry) ** 2 <= 1.0
        cx, cy = self._blobs[0][0], self._blobs[0][1]
        ring = np.sin(np.hypot(X - cx, Y - cy) / self._ring_period * 2 * math.pi) > 0
        stripe = np.sin((X + Y) / self._stripe_period * 2 * math.pi) > 0.55
        rgb = np.broadcast_to(_BG, X.shape + (3,)).copy()
        a, b, c = self._palette
        rgb[fg & ring] = a
        rgb[fg & ~ring] = b
        rgb[fg & stripe] = c
        line = max(6.0, 2.0 * d)
        grid = ((X % 2048.0) < line) | ((Y % 2048.0) < line)
        rgb[grid] = _GRID_RGB
        # Fine deterministic texture (integer hash of level-0 coordinates).
        xi = np.floor(X).astype(np.int64)
        yi = np.floor(Y).astype(np.int64)
        hsh = (xi * 374761393 + yi * 668265263 + self._noise_seed) & 0xFFFFFFFF
        hsh = ((hsh ^ (hsh >> 13)) * 1274126177) & 0xFFFFFFFF
        noise = ((hsh & 0xFF).astype(np.float32) - 127.5) / 127.5 * 22.0
        rgb[fg] += noise[fg][:, None]
        rgb[~inside] = 255.0
        return np.clip(rgb, 0, 255).astype(np.uint8), inside

    def _burn_text(self, img: Image.Image, lx0: float, ly0: float) -> None:
        """Draw ``SYNTHETIC — NO HISTOLOGY`` on a lattice in level coordinates."""
        font = _font(_FONT_SIZE)
        draw = ImageDraw.Draw(img)
        left, right = "SYNTHETIC", "NO HISTOLOGY"
        lw = draw.textlength(left, font=font)
        rw = draw.textlength(right, font=font)
        dash = _FONT_SIZE * 1.1
        gap = _FONT_SIZE * 0.35
        total_w = lw + gap + dash + gap + rw
        sx, sy = _TEXT_SPACING
        ox, oy = self._text_offset
        w, h = img.size
        row_min = math.floor((ly0 - _FONT_SIZE * 2 - oy) / sy)
        row_max = math.floor((ly0 + h - oy) / sy) + 1
        for row in range(row_min, row_max + 1):
            ty = row * sy + oy
            shift = (sx / 2) if row % 2 else 0
            col_min = math.floor((lx0 - total_w - ox - shift) / sx)
            col_max = math.floor((lx0 + w - ox - shift) / sx) + 1
            for col in range(col_min, col_max + 1):
                tx = col * sx + ox + shift
                px, py = tx - lx0, ty - ly0
                if px > w or py > h or px + total_w < 0 or py + _FONT_SIZE * 2 < 0:
                    continue
                kw = {"font": font, "stroke_width": 3, "stroke_fill": (255, 255, 255)}
                draw.text((px, py), left, fill=(18, 18, 22), **kw)
                dx = px + lw + gap
                mid = py + _FONT_SIZE * 0.62
                draw.rectangle((dx - 2, mid - 4, dx + dash + 2, mid + 4), fill=(255, 255, 255))
                draw.rectangle((dx, mid - 2, dx + dash, mid + 2), fill=(18, 18, 22))
                draw.text((dx + dash + gap, py), right, fill=(18, 18, 22), **kw)
