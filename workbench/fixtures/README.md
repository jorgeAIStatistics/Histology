# Fixtures

| File | Source | License | SHA-256 | What it is | What it is **not** |
|---|---|---|---|---|---|
| `CMU-1-Small-Region.svs` (1,938,955 bytes) | OpenSlide test data, Carnegie Mellon University: https://openslide.cs.cmu.edu/download/openslide-testdata/Aperio/ (downloaded 2026-10-26) | CC0 (as listed on the source page) | `ed92d5a9f2e86df67640d6f92ce3e231419ce127131697fbbce42ad5e002c8a7` | A real Aperio SVS whole-slide image region: 2220 × 2967 px, one pyramid level, JPEG, 0.499 µm/px (from the file's metadata), 20× objective power | **Unlabeled.** It has no diagnostic label, and none may be inferred from its name or appearance. It contains label and macro associated images, which the workbench never serves (identifier-risk policy). |
| `large/CMU-1.svs` (not committed) | Same source | CC0 | Recorded by the fetch script on download | A multi-level Aperio SVS (about 169 MB), for multi-level tiling and latency tests | Unlabeled, as above |

**Derived from the CC0 slide:** the Overview page's images (`web/public/overview/`: WebP renderings at 720 and 1200 px wide and the QC screen's background mask) and `web/lib/overview-data.json` (dimensions, scale, hash, tissue fraction, the 41 patch coordinates). They are regenerated with `api/.venv/bin/python scripts/build_overview_assets.py` (run from `workbench/api`), which checks the fixture's SHA-256 first and never reads the label or macro images. The page shows only the region image; the outline drawn in its third step is marked as illustrative.

Synthetic tiled images used in the demo are generated procedurally by `dermpath/slides/synthetic.py`. They are labelled `DEMO SYNTHETIC` everywhere and contain **no histology**.
