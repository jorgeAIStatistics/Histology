"""Coverage diagnostics (dermpath.coverage/1): every field of design §4, mask resolution and the
coarse-mask flag, exclusion accounting, uncalibrated reporting, read-time rejections, and the
measured fragment facts on the CMU fixture (legacy grid vs the policy grid with rescue)."""

from __future__ import annotations

import numpy as np
import openslide
import pytest

from dermpath.config import FIXTURES_DIR
from dermpath.ml import patching as P
from dermpath.ml import sampling as S
from dermpath.ml.coverage import coverage

CMU = FIXTURES_DIR / "CMU-1-Small-Region.svs"
DESIGN_FIELDS = {"tissue_area_um2", "candidate_tissue_area_um2", "sampled_tissue_area_um2", "excluded_area_um2",
                 "edge_uncovered_tissue_area_um2", "fragments_total", "fragments_without_candidate",
                 "fragments_rescued", "tissue_within_radius_of_sample_fraction", "radius_um", "rejected_at_read",
                 "mask_um_per_px", "mask_coarse"}


@pytest.fixture(scope="module")
def cmu():
    osr = openslide.OpenSlide(str(CMU))
    mask, ms = P.otsu_mask(osr, None)
    yield osr.dimensions, mask, (ms["mask_downsample_x"], ms["mask_downsample_y"])
    osr.close()


def test_cmu_coverage_fields_and_values(cmu):
    dims, mask, ds = cmu
    pol = P.PatchPolicy()
    plan = P.plan_scale(mpp_x=0.499, mpp_y=0.499, level_downsamples=[1.0], policy=pol)
    c = P.candidate_grid(dims, plan, mask, ds, [], pol)
    idx, _ = S.select_indices(c, S.SamplingPolicy(strategy="spatial", max_patches=16, seed=0))
    sampled = c.subset(idx)
    tally = P.ReadTally()
    tally.add({"n_read": 16, "n_kept": 15, "rejected": {"pen_marks": 1}})
    cv = coverage(dims=dims, plan=plan, mask=mask, mask_ds=ds, candidates=c, sampled=sampled, policy=pol,
                  rejected_at_read=tally.as_dict()["rejected"])
    assert DESIGN_FIELDS <= set(cv)
    assert cv["mask_um_per_px"] == pytest.approx([1.446, 1.446], abs=1e-3) and cv["mask_coarse"] is False
    assert cv["tissue_area_um2"] == pytest.approx(463_256, rel=1e-3)  # 28 % of the 1.1 x 1.5 mm region
    assert cv["edge_uncovered_tissue_area_um2"] == 0 and cv["excluded_area_um2"] == 0
    assert cv["tissue_area_um2"] >= cv["candidate_tissue_area_um2"] >= cv["sampled_tissue_area_um2"] > 0
    assert cv["candidate_tissue_fraction"] == pytest.approx(0.9385, abs=1e-3)
    assert cv["n_candidates"] == len(c) == 58 and cv["n_sampled"] == 16
    assert cv["radius_um"] == pytest.approx(111.776) and 0.8 < cv["tissue_within_radius_of_sample_fraction"] <= 1
    assert cv["rejected_at_read"] == {"pen_marks": 1, "background_at_read": 0, "blur": 0}
    assert sum(cv["sampled_origins"].values()) == 16 and cv["candidate_origins"]["edge"] == 6
    none = coverage(dims=dims, plan=plan, mask=mask, mask_ds=ds, candidates=c, sampled=np.zeros((0, 2)), policy=pol)
    assert none["tissue_within_radius_of_sample_fraction"] == 0.0 and none["sampled_tissue_area_um2"] == 0


def test_cmu_fragments_legacy_vs_rescue(cmu):
    """Measured: fragments (8-connected, >= 250 µm²) with no candidate: legacy grid 6 of 10, policy grid 1,
    policy grid with rescue 0 (1 rescued). At >= 2000 µm² (the default): legacy 1 of 2, policy 0."""
    dims, mask, ds = cmu
    W, H = dims
    legacy_plan = P.plan_scale(mpp_x=0.499, mpp_y=0.499, level_downsamples=[1.0], patch_size=224, target_mpp=0.5,
                               fallback_downsample=4.0)
    legacy = P.tissue_coordinates(dims=dims, plan=legacy_plan, mask=mask, mask_ds=ds, excluded=[],
                                  min_tissue_fraction=0.5, max_patches=10**6, sample_seed=0, coordinate_source="t")
    span = ((W // 224) * 224, (H // 224) * 224)
    for amin, legacy_missing, total in ((250.0, 6, 10), (2000.0, 1, 2)):
        cl = coverage(dims=dims, plan=legacy_plan, mask=mask, mask_ds=ds, candidates=legacy.coords, grid_span=span,
                      fragment_min_area_um2=amin)
        assert (cl["fragments_total"], cl["fragments_without_candidate"]) == (total, legacy_missing)
        assert cl["fragments_rescued"] == 0 and cl["candidate_origins"] == {"unspecified": 41}
        pol = P.PatchPolicy(fragment_rescue_min_area_um2=amin)
        plan = P.plan_scale(mpp_x=0.499, mpp_y=0.499, level_downsamples=[1.0], policy=pol)
        new = P.candidate_grid(dims, plan, mask, ds, [], pol)
        cn = coverage(dims=dims, plan=plan, mask=mask, mask_ds=ds, candidates=new, policy=pol)
        assert cn["fragments_total"] == total and cn["fragments_without_candidate"] == 0
        assert cn["fragments_rescued"] == new.stats["fragments"]["rescued"] == (1 if amin == 250.0 else 0)


def test_coarse_mask_is_flagged():
    # A 100k x 80k px slide at 0.25 µm/px with a 1024-px QC mask: 24.4 µm per mask pixel.
    dims = (100_000, 80_000)
    mask = np.zeros((819, 1024), dtype=bool)
    mask[300:500, 300:700] = True
    ds = (dims[0] / 1024, dims[1] / 819)
    pol = P.PatchPolicy()
    plan = P.plan_scale(mpp_x=0.25, mpp_y=0.25, level_downsamples=[1, 4, 16, 64], policy=pol)
    c = P.candidate_grid(dims, plan, mask, ds, [], pol)
    cv = coverage(dims=dims, plan=plan, mask=mask, mask_ds=ds, candidates=c, policy=pol)
    assert cv["mask_um_per_px"][0] == pytest.approx(24.414, abs=1e-2) and cv["mask_coarse"] is True
    assert any("coarser than 8 µm/px" in n for n in cv["notes"])
    assert cv["candidate_tissue_fraction"] == pytest.approx(1.0)


def test_exclusions_are_measured_and_not_counted_as_eligible():
    mask = np.ones((448, 448), dtype=bool)  # mask_ds 1, 0.5 µm/px: 50,176 µm² of tissue
    pol = P.PatchPolicy(fragment_rescue_min_area_um2=None)
    plan = P.plan_scale(mpp_x=0.5, mpp_y=0.5, level_downsamples=[1.0], policy=pol)
    region = {"type": "rectangle", "x": 100, "y": 100, "width": 100, "height": 100}
    c = P.candidate_grid((448, 448), plan, mask, (1.0, 1.0), [region], pol)
    assert len(c) == 3 and c.stats["rejected"]["excluded_region"] == 1
    cv = coverage(dims=(448, 448), plan=plan, mask=mask, mask_ds=(1.0, 1.0), candidates=c, excluded=[region], policy=pol)
    assert cv["excluded_area_um2"] == pytest.approx(2500, rel=0.03)  # 100 x 100 px at 0.25 µm² per px
    assert cv["excluded_tissue_area_um2"] == cv["excluded_area_um2"]
    # 3 of 4 cells remain: 3/4 of all tissue is covered, i.e. 37,632 of the 47,626 eligible µm².
    assert cv["candidate_tissue_area_um2"] == pytest.approx(0.75 * cv["tissue_area_um2"], rel=1e-6)
    assert cv["candidate_tissue_fraction"] == pytest.approx(0.75 * 50176 / (50176 - 2550.25), rel=0.01)


def test_uncalibrated_coverage_reports_level0_units():
    mask = np.zeros((100, 100), dtype=bool)
    mask[10:60, 10:60] = True
    pol = P.PatchPolicy(allow_uncalibrated=True, uncalibrated_downsample=1.0, patch_size=64)
    plan = P.plan_scale(mpp_x=None, mpp_y=None, level_downsamples=[1.0], policy=pol)
    c = P.candidate_grid((400, 400), plan, mask, (4.0, 4.0), [], pol)
    cv = coverage(dims=(400, 400), plan=plan, mask=mask, mask_ds=(4.0, 4.0), candidates=c, policy=pol)
    assert cv["calibrated"] is False and cv["tissue_area_um2"] is None and cv["mask_um_per_px"] is None
    assert cv["mask_coarse"] is None and cv["fragments_total"] is None and cv["radius_um"] is None
    assert cv["areas_level0_px2"]["tissue"] == 50 * 50 * 16 and cv["radius_level0_px"] == 64
    assert cv["tissue_within_radius_of_sample_fraction"] == 1.0
    assert any("uncalibrated" in n for n in cv["notes"])


def test_bare_coordinates_without_span_do_not_invent_edge_numbers(cmu):
    dims, mask, ds = cmu
    plan = P.plan_scale(mpp_x=0.499, mpp_y=0.499, level_downsamples=[1.0], policy=P.PatchPolicy())
    cv = coverage(dims=dims, plan=plan, mask=mask, mask_ds=ds, candidates=np.array([[0, 0]]))
    assert cv["edge_uncovered_tissue_area_um2"] is None and any("grid_span unknown" in n for n in cv["notes"])
