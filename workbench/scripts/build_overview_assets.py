#!/usr/bin/env python3
"""Build the Overview page's slide images from the public CC0 fixture, with the prototype's own code.

Usage (from workbench/api):
    .venv/bin/python ../scripts/build_overview_assets.py

Nothing here is drawn by hand. The tissue mask comes from the QC screen (``dermpath.qc.tissue.segment``) and the
patch grid from feature extraction (``dermpath.ml.patching``), with the same defaults the worker uses. The slide is
CMU-1-Small-Region.svs (OpenSlide test data, CC0). It is not a patient of any lab, and it carries no diagnosis.

Writes:
    web/public/overview/cmu-{720,1200}.webp   the slide (label and macro images are never read)
    web/public/overview/background-mask.png   alpha = pixels the screen did NOT count as tissue (for a CSS mask)
    web/lib/overview-data.json                dimensions, scale, hash, tissue fraction, patch coordinates
"""

from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

import numpy as np
import openslide
from PIL import Image

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(ROOT / "api"))

from dermpath.ml.config import MLSettings  # noqa: E402
from dermpath.ml.patching import PATCHING_VERSION, otsu_mask, plan_scale, tissue_coordinates  # noqa: E402
from dermpath.qc.tissue import METHOD_VERSION  # noqa: E402

SLIDE = ROOT / "fixtures" / "CMU-1-Small-Region.svs"
EXPECTED_SHA256 = "ed92d5a9f2e86df67640d6f92ce3e231419ce127131697fbbce42ad5e002c8a7"
PUBLIC = ROOT / "web" / "public" / "overview"
DATA = ROOT / "web" / "lib" / "overview-data.json"


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def alpha_png(alpha: np.ndarray, path: Path) -> None:
    """White RGBA image whose alpha channel is the given boolean mask (CSS masks read alpha everywhere)."""
    h, w = alpha.shape
    rgba = np.full((h, w, 4), 255, dtype=np.uint8)
    rgba[..., 3] = alpha.astype(np.uint8) * 255
    Image.fromarray(rgba, "RGBA").save(path, optimize=True)


def main() -> None:
    digest = sha256(SLIDE)
    if digest != EXPECTED_SHA256:
        raise SystemExit(f"unexpected fixture hash {digest}")
    PUBLIC.mkdir(parents=True, exist_ok=True)
    osr = openslide.OpenSlide(str(SLIDE))
    W, H = osr.dimensions
    mpp_x = float(osr.properties.get(openslide.PROPERTY_NAME_MPP_X) or 0) or None
    mpp_y = float(osr.properties.get(openslide.PROPERTY_NAME_MPP_Y) or 0) or None

    full = osr.read_region((0, 0), 0, (W, H)).convert("RGB")
    for width in (720, 1200):
        img = full.resize((width, round(H * width / W)), Image.Resampling.LANCZOS)
        img.save(PUBLIC / f"cmu-{width}.webp", "WEBP", quality=82, method=6)

    mask, mstats = otsu_mask(osr, digest)
    alpha_png(~mask, PUBLIC / "background-mask.png")

    s = MLSettings.from_env()
    plan = plan_scale(mpp_x=mpp_x, mpp_y=mpp_y, level_downsamples=list(osr.level_downsamples),
                      patch_size=s.patch_size, target_mpp=s.target_mpp, fallback_downsample=s.fallback_downsample)
    coords = tissue_coordinates(dims=(W, H), plan=plan, mask=mask,
                                mask_ds=(mstats["mask_downsample_x"], mstats["mask_downsample_y"]), excluded=[],
                                min_tissue_fraction=s.min_tissue_fraction, max_patches=s.max_patches_per_slide,
                                sample_seed=0, coordinate_source="otsu_fallback")

    data = {
        "source": "CMU-1-Small-Region.svs, OpenSlide test data, CC0 1.0. Not a patient of any lab; no diagnosis.",
        "generated_by": "workbench/scripts/build_overview_assets.py",
        "sha256": digest,
        "format": "Aperio SVS",
        "width": W,
        "height": H,
        "levels": osr.level_count,
        "mpp": [mpp_x, mpp_y],
        "tissue": {"method": METHOD_VERSION, "fraction": mstats["tissue_fraction"],
                   "mask_size": [mstats["mask_width"], mstats["mask_height"]]},
        "patches": {"method": PATCHING_VERSION, "patch_size": plan.patch_size, "target_mpp": s.target_mpp,
                    "extent": list(plan.extent), "min_tissue_fraction": s.min_tissue_fraction,
                    "grid_cells": coords.stats["grid_cells"], "candidates": coords.stats["candidates"],
                    "coords": coords.coords.tolist()},
    }
    DATA.write_text(json.dumps(data, indent=1) + "\n")
    print(json.dumps({k: v for k, v in data.items() if k != "patches"} | {"patches": len(data["patches"]["coords"])},
                     indent=1))


if __name__ == "__main__":
    main()
