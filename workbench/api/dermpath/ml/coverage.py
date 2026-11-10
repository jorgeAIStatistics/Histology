"""Per-slide coverage diagnostics of a patch selection (research use only; pure, no DB).

All areas are measured on the tissue mask grid: a mask pixel counts as covered by a patch
when its CENTRE lies inside the patch rectangle (the same rule fragment rescue uses), so
coverage is as precise as the mask (``mask_um_per_px`` is reported; masks coarser than
``mask_floor_um_per_px`` are flagged ``mask_coarse``). Areas are given in µm² when the slide
is calibrated and always in level-0 px² under ``areas_level0_px2``.

Fields (design §4): ``tissue_area_um2``, ``candidate_tissue_area_um2``,
``sampled_tissue_area_um2``, ``excluded_area_um2``, ``edge_uncovered_tissue_area_um2``,
``fragments_total``, ``fragments_without_candidate``, ``fragments_rescued``,
``tissue_within_radius_of_sample_fraction`` (with ``radius_um``), ``rejected_at_read``,
``mask_um_per_px``; plus ``excluded_tissue_area_um2``, candidate and sampled tissue fractions
and counts.

* Tissue inside an excluded region is not eligible: fractions are relative to the eligible
  (non-excluded) tissue, and fragments are counted on it.
* ``edge_uncovered_tissue_area_um2`` is tissue outside every grid cell (the strips a
  floor-anchored grid never reaches); 0 by construction with ``shift_inward``.
* ``fragments_total`` counts 8-connected eligible-tissue components of at least
  ``fragment_min_area_um2``; ``components_total`` counts all of them (speckle included).
"""

from __future__ import annotations

import numpy as np

from .patching import (
    Candidates,
    PatchPlan,
    PatchPolicy,
    fragment_components,
    mask_pixel_area_um2,
    paint_rects,
    region_area_raster,
    region_polygons,
)

COVERAGE_VERSION = "dermpath.coverage/1"
#: Masks coarser than this (µm per mask pixel, either axis) are flagged; thin structures such
#: as a 60 µm epidermal strip span only a few pixels above it.
MASK_FLOOR_UM_PER_PX = 8.0
DEFAULT_FRAGMENT_MIN_AREA_UM2 = 2000.0


def _coords_of(x) -> np.ndarray:
    if x is None:
        return np.zeros((0, 2), dtype=np.int64)
    if isinstance(x, Candidates):
        return x.coords
    return np.asarray(x, dtype=np.int64).reshape(-1, 2)


def _r(v: float | None, nd: int = 3) -> float | None:
    return None if v is None else round(float(v), nd)


def coverage(*, dims: tuple[int, int], plan: PatchPlan, mask: np.ndarray, mask_ds: tuple[float, float],
             candidates, sampled=None, excluded: list | None = None, policy: PatchPolicy | None = None,
             rejected_at_read: dict | None = None, radius_um: float | None = None,
             radius_level0_px: float | None = None, grid_span: tuple[int, int] | None = None,
             fragment_min_area_um2: float | None = None,
             mask_floor_um_per_px: float = MASK_FLOOR_UM_PER_PX) -> dict:
    """Coverage of ``candidates`` and of the ``sampled`` subset (all candidates when None).

    ``candidates``/``sampled`` are :class:`~dermpath.ml.patching.Candidates` or (N, 2) level-0
    top-left arrays with the plan's extent. ``grid_span`` (the level-0 width and height the
    grid can reach) comes from a ``Candidates``; for a bare array pass it explicitly, or
    ``edge_uncovered_tissue_area_um2`` is reported as None. ``radius_um`` defaults to one patch
    side. ``rejected_at_read`` is the read-time tally (``ReadTally.as_dict()["rejected"]``).
    """
    W, H = int(dims[0]), int(dims[1])
    mask = np.asarray(mask, dtype=bool)
    mh, mw = mask.shape
    dsx, dsy = float(mask_ds[0]), float(mask_ds[1])
    ew, eh = (int(v) for v in plan.extent)
    cand = _coords_of(candidates)
    samp = cand if sampled is None else _coords_of(sampled)
    if grid_span is None and isinstance(candidates, Candidates):
        grid_span = candidates.grid_span
    px_um2 = mask_pixel_area_um2(plan, mask_ds)
    calibrated = px_um2 is not None
    px_l0 = dsx * dsy
    notes: list[str] = []

    polys = region_polygons(excluded)
    excl = region_area_raster(polys, mask.shape, mask_ds) if polys else np.zeros(mask.shape, dtype=bool)
    eligible = mask & ~excl
    cand_cover = paint_rects(mask.shape, mask_ds, cand, (ew, eh))
    samp_cover = cand_cover if sampled is None else paint_rects(mask.shape, mask_ds, samp, (ew, eh))

    if grid_span is not None:
        cx = (np.arange(mw) + 0.5) * dsx
        cy = (np.arange(mh) + 0.5) * dsy
        outside = (cx[None, :] >= grid_span[0]) | (cy[:, None] >= grid_span[1])
        edge_px = int((mask & outside).sum())
    else:
        edge_px = None
        notes.append("grid_span unknown: edge_uncovered_tissue_area_um2 not computed")

    counts = {"tissue": int(mask.sum()), "candidate": int((mask & cand_cover).sum()),
              "sampled": int((mask & samp_cover).sum()), "excluded": int(excl.sum()),
              "excluded_tissue": int((mask & excl).sum()), "edge_uncovered": edge_px}
    n_eligible = int(eligible.sum())

    def um2(px):
        return None if (px is None or not calibrated) else round(px * px_um2, 1)

    out: dict = {
        "version": COVERAGE_VERSION,
        "calibrated": calibrated,
        "slide_dims": [W, H],
        "extent_level0": [ew, eh],
        "patch_side_um": ([_r(ew * plan.slide_mpp[0]), _r(eh * plan.slide_mpp[1])] if calibrated else None),
        "mask_shape": [mw, mh],
        "mask_level0_px_per_px": [_r(dsx, 4), _r(dsy, 4)],
        "mask_um_per_px": ([_r(dsx * plan.slide_mpp[0], 4), _r(dsy * plan.slide_mpp[1], 4)] if calibrated else None),
        "mask_floor_um_per_px": mask_floor_um_per_px,
        "n_candidates": int(cand.shape[0]),
        "n_sampled": int(samp.shape[0]),
        "tissue_area_um2": um2(counts["tissue"]),
        "candidate_tissue_area_um2": um2(counts["candidate"]),
        "sampled_tissue_area_um2": um2(counts["sampled"]),
        "excluded_area_um2": um2(counts["excluded"]),
        "excluded_tissue_area_um2": um2(counts["excluded_tissue"]),
        "edge_uncovered_tissue_area_um2": um2(edge_px),
        "candidate_tissue_fraction": _r((mask & cand_cover & ~excl).sum() / n_eligible, 6) if n_eligible else None,
        "sampled_tissue_fraction": _r((mask & samp_cover & ~excl).sum() / n_eligible, 6) if n_eligible else None,
        "areas_level0_px2": {k: (None if v is None else round(v * px_l0, 1)) for k, v in counts.items()},
        "rejected_at_read": dict(rejected_at_read) if rejected_at_read is not None else None,
    }
    if calibrated:
        um = out["mask_um_per_px"]
        out["mask_coarse"] = bool(max(um) > mask_floor_um_per_px)
        if out["mask_coarse"]:
            notes.append(f"tissue mask is coarser than {mask_floor_um_per_px:g} µm/px; thin structures and small "
                         "fragments may be missed or mis-measured")
    else:
        out["mask_coarse"] = None
        notes.append("uncalibrated slide: µm areas, fragment sizes and µm radii are unknown")

    # Fragments of eligible tissue.
    min_area = fragment_min_area_um2
    if min_area is None:
        min_area = (policy.fragment_rescue_min_area_um2 if policy is not None else None) or DEFAULT_FRAGMENT_MIN_AREA_UM2
    out["fragment_min_area_um2"] = float(min_area)
    labels, n, sizes = fragment_components(eligible)
    out["components_total"] = n
    if calibrated:
        big = np.zeros(n + 1, dtype=bool)
        big[1:] = sizes[1:] * px_um2 >= float(min_area)
        has = np.bincount(labels[cand_cover & (labels > 0)], minlength=n + 1) > 0
        has_sampled = np.bincount(labels[samp_cover & (labels > 0)], minlength=n + 1) > 0
        out["fragments_total"] = int(big.sum())
        out["fragments_without_candidate"] = int((big & ~has).sum())
        # A fragment can have a candidate yet no embedded patch (sampling dropped it): reported separately.
        out["fragments_without_sampled_patch"] = int((big & ~has_sampled).sum())
        out["fragment_tissue_without_candidate_um2"] = um2(int(sizes[big & ~has].sum()))
    else:
        out["fragments_total"] = out["fragments_without_candidate"] = None
        out["fragments_without_sampled_patch"] = None
        out["fragment_tissue_without_candidate_um2"] = None
    if isinstance(candidates, Candidates):
        out["fragments_rescued"] = candidates.origin_counts()["fragment_rescue"]
        out["candidate_origins"] = candidates.origin_counts()
    else:
        out["fragments_rescued"] = 0
        out["candidate_origins"] = {"unspecified": int(cand.shape[0])}  # a bare coordinate array
    if isinstance(sampled, Candidates):
        out["sampled_origins"] = sampled.origin_counts()

    # Tissue within a radius of a sampled patch (distance to the nearest covered mask pixel).
    from scipy import ndimage

    if calibrated:
        r = float(radius_um) if radius_um is not None else float(min(ew * plan.slide_mpp[0], eh * plan.slide_mpp[1]))
        spacing = (dsy * plan.slide_mpp[1], dsx * plan.slide_mpp[0])
        out["radius_um"], out["radius_level0_px"] = round(r, 3), None
    else:
        r = float(radius_level0_px) if radius_level0_px is not None else float(min(ew, eh))
        spacing = (dsy, dsx)
        out["radius_um"], out["radius_level0_px"] = None, round(r, 3)
    if not n_eligible:
        out["tissue_within_radius_of_sample_fraction"] = None
    elif not samp_cover.any():
        out["tissue_within_radius_of_sample_fraction"] = 0.0
    else:
        dist = ndimage.distance_transform_edt(~samp_cover, sampling=spacing)
        out["tissue_within_radius_of_sample_fraction"] = _r(float((dist[eligible] <= r).mean()), 6)
    out["notes"] = notes
    return out
