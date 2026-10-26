"""Policy-driven patching (dermpath.patching/2): physical scale planning and refusals, the
edge-shifted grid, exact tissue fractions, exclusions, fragment rescue, read-time filters
(pen ink, background), patch quality, determinism and the bounded-memory batch iterator.
Pure functions on the CC0 CMU fixture and on synthetic images through openslide.ImageSlide."""

from __future__ import annotations

import gc
import tracemalloc
import weakref

import numpy as np
import openslide
import pytest
from PIL import Image, ImageDraw

from dermpath.config import FIXTURES_DIR
from dermpath.ml import patching as P
from dermpath.ml.coverage import coverage

CMU = FIXTURES_DIR / "CMU-1-Small-Region.svs"
CMU_MPP = 0.499


@pytest.fixture(scope="module")
def cmu():
    osr = openslide.OpenSlide(str(CMU))
    mask, ms = P.otsu_mask(osr, None)
    yield osr, mask, (ms["mask_downsample_x"], ms["mask_downsample_y"])
    osr.close()


def _plan(policy, mpp=(CMU_MPP, CMU_MPP), levels=(1.0,)):
    return P.plan_scale(mpp_x=mpp[0], mpp_y=mpp[1], level_downsamples=list(levels), policy=policy)


# --------------------------------------------------------------------------- policy


def test_policy_canonical_json_round_trip_and_sha():
    pol = P.PatchPolicy()
    assert pol.min_tissue_fraction == 0.25 and pol.edge_mode == "shift_inward" and pol.max_upsample_ratio == 1.05
    assert pol.allow_uncalibrated is False and pol.anisotropy_tolerance == 0.10 and pol.target_mpp == 0.5
    body = pol.to_json()
    assert body["version"] == P.PATCHING_VERSION_V2 == "dermpath.patching/2"
    assert P.PATCHING_VERSION == "dermpath.patching/1"  # the legacy version string is unchanged
    assert {"background_at_read", "pen_marks", "blur_flag"} <= set(body["read_filters"])
    assert {"strategy", "max_patches", "seed"} <= set(body["sampling"])
    again = P.PatchPolicy.from_json(body)
    assert again == pol and again.policy_sha256 == pol.policy_sha256 and len(pol.policy_sha256) == 64
    # Numbers are canonicalised, so equal policies hash equally ...
    assert P.PatchPolicy(target_mpp=1, patch_size=224.0).policy_sha256 == P.PatchPolicy(target_mpp=1.0).policy_sha256
    # ... and every output-affecting field changes the hash.
    shas = {pol.policy_sha256}
    for change in ({"min_tissue_fraction": 0.3}, {"stride_fraction": 0.5}, {"edge_mode": "floor"},
                   {"fragment_rescue_min_area_um2": None}, {"max_upsample_ratio": 1.1}, {"allow_uncalibrated": True},
                   {"read_filters": P.ReadFilters(pen_max_fraction=0.5)}, {"background_fill": "white"},
                   {"sampling": P.SamplingPolicy(seed=1)}):
        shas.add(pol.replace(**change).policy_sha256)
    assert len(shas) == 10


@pytest.mark.parametrize("bad", [{"min_tissue_fraction": 0.0}, {"stride_fraction": 1.5}, {"edge_mode": "wrap"},
                                 {"max_upsample_ratio": 0.9}, {"patch_size": 4}, {"target_mpp": -1},
                                 {"resize_filter": "lanczos"}, {"fragment_rescue_min_area_um2": 0}])
def test_policy_validation(bad):
    with pytest.raises(ValueError):
        P.PatchPolicy(**bad)


def test_patch_size_must_equal_encoder_input_size():
    P.PatchPolicy(patch_size=224).validate_for_encoder(224)
    with pytest.raises(ValueError, match="patch_size_mismatch"):
        P.PatchPolicy(patch_size=448).validate_for_encoder(224)


# --------------------------------------------------------------------------- scale


def test_plan_records_effective_mpp_and_read_geometry():
    pol = P.PatchPolicy()
    plan = _plan(pol)
    assert plan.calibrated and plan.version == P.PATCHING_VERSION_V2
    assert plan.extent == (224, 224) and plan.read_size == (224, 224) and plan.read_level == 0
    assert plan.effective_mpp_x == pytest.approx(0.499) and plan.effective_mpp_y == pytest.approx(0.499)
    assert plan.upsample_ratio == 1.0 and plan.scale["effective_mpp"] == [0.499, 0.499]
    # 40x pyramid with integer and non-integer downsamples: the coarsest level that still reads >= patch_size.
    p40 = _plan(pol, (0.25, 0.25), (1.0, 2.0, 8.0))
    assert p40.extent == (448, 448) and p40.level == 1 and p40.read_size == (224, 224)
    p40b = _plan(pol, (0.25, 0.25), (1.0, 2.0001, 4.0004))
    assert p40b.level == 1 and p40b.read_size == (224, 224) and p40b.upsample_ratio == 1.0
    p40c = _plan(pol, (0.25, 0.25), (1.0, 4.0, 16.0))  # no level 2: read level 0 and downsample once
    assert p40c.level == 0 and p40c.read_size == (448, 448)


def test_coarse_scan_is_refused_instead_of_upsampled():
    pol = P.PatchPolicy()
    with pytest.raises(P.ScaleError) as e:
        _plan(pol, (1.0, 1.0), (1.0, 4.0))  # a 10x scan read at 0.5 µm/px would be a 2x upsample
    assert e.value.reason == "would_upsample"
    ok = _plan(pol, (0.52, 0.52))  # within the 1.05 tolerance: allowed, and the ratio is recorded
    assert 1.0 < ok.upsample_ratio <= 1.05 and ok.scale["upsample_ratio"] == pytest.approx(ok.upsample_ratio, abs=1e-6)
    with pytest.raises(P.ScaleError, match="would_upsample"):
        _plan(pol, (0.53, 0.53))
    assert _plan(pol.replace(max_upsample_ratio=2.5), (1.0, 1.0)).upsample_ratio == pytest.approx(2.0)


def test_anisotropic_implausible_and_read_cap_refusals():
    pol = P.PatchPolicy()
    with pytest.raises(P.ScaleError) as e:
        _plan(pol, (0.25, 0.30))
    assert e.value.reason == "anisotropic"
    within = _plan(pol, (0.25, 0.26))  # 4 % anisotropy: per-axis extents keep the patch square in microns
    assert within.extent == (448, 431) and within.effective_mpp[0] == pytest.approx(within.effective_mpp[1], rel=2e-3)
    for mpp in (1e-4, 25.0):
        with pytest.raises(P.ScaleError) as e:
            _plan(pol, (mpp, mpp))
        assert e.value.reason == "implausible_mpp"
    with pytest.raises(P.ScaleError) as e:
        _plan(pol, (0.1, 0.1))  # single level: a 1120 px read per patch exceeds 4 × 224
    assert e.value.reason == "read_size_cap"
    assert _plan(pol, (0.1, 0.1), (1.0, 4.0)).read_size == (280, 280)  # a pyramid level solves it


def test_uncalibrated_refused_unless_allowed_and_pyramid_independent():
    pol = P.PatchPolicy()
    for mpp in ((None, None), (0.25, None), (0.0, 0.0)):
        with pytest.raises(P.ScaleError) as e:
            _plan(pol, mpp)
        assert e.value.reason == "uncalibrated"
    allowed = pol.replace(allow_uncalibrated=True)
    single = _plan(allowed, (None, None), (1.0,))
    pyramid = _plan(allowed, (None, None), (1.0, 4.0, 16.0))
    assert not single.calibrated and single.scale["mode"] == "uncalibrated" and single.effective_mpp is None
    assert single.extent == pyramid.extent == (896, 896)  # same level-0 footprint whatever the pyramid
    assert pyramid.level == 1 and pyramid.read_size == (224, 224) and single.read_size == (896, 896)
    assert _plan(allowed, (0.25, None)).scale["partial_mpp"] is True


def test_legacy_plan_scale_is_unchanged():
    p = P.plan_scale(mpp_x=CMU_MPP, mpp_y=CMU_MPP, level_downsamples=[1.0], patch_size=224, target_mpp=0.5,
                     fallback_downsample=4.0)
    assert p.scale == {"mode": "calibrated", "target_mpp": 0.5, "slide_mpp": [CMU_MPP, CMU_MPP], "read_level": 0,
                       "read_level_downsample": 1.0}
    assert p.scale_key == "mpp=0.5" and p.extent == (224, 224) and p.version == P.PATCHING_VERSION
    up = P.plan_scale(mpp_x=1.0, mpp_y=1.0, level_downsamples=[1.0, 4.0], patch_size=224, target_mpp=0.5,
                      fallback_downsample=4.0)
    assert up.read_size == (112, 112) and up.upsample_ratio == 2.0  # legacy still upsamples; now it is visible
    unc = P.plan_scale(mpp_x=None, mpp_y=None, level_downsamples=[1, 4, 16], patch_size=224, target_mpp=0.5,
                       fallback_downsample=4.0)
    assert unc.scale_key == "level=1(ds=4)" and unc.extent == (896, 896)
    with pytest.raises(ValueError):
        P.plan_scale(mpp_x=0.5, mpp_y=0.5, level_downsamples=[1.0], patch_size=224, policy=P.PatchPolicy())


# --------------------------------------------------------------------------- grid


def test_shift_inward_covers_right_and_bottom_edges():
    # 1000 x 700 px slide at 0.5 µm/px (extent 224 px): tissue only in the right and bottom strips.
    W, H = 1000, 700
    mask = np.zeros((H // 4, W // 4), dtype=bool)  # mask_ds = 4 level-0 px
    mask[:, (W - 100) // 4:] = True  # right strip, 100 px wide (outside the floor grid: 4 × 224 = 896)
    mask[(H - 30) // 4:, :] = True  # bottom strip, 30 px tall (floor grid stops at 3 × 224 = 672)
    pol = P.PatchPolicy(min_tissue_fraction=0.1, fragment_rescue_min_area_um2=None)
    plan = _plan(pol, (0.5, 0.5))
    floor = P.candidate_grid((W, H), plan, mask, (4.0, 4.0), [], pol.replace(edge_mode="floor"))
    inward = P.candidate_grid((W, H), plan, mask, (4.0, 4.0), [], pol)
    assert floor.grid_span == (896, 672) and inward.grid_span == (W, H)
    assert inward.coords[:, 0].max() == W - 224 and inward.coords[:, 1].max() == H - 224
    assert (inward.coords[:, 0] + 224 <= W).all() and (inward.coords[:, 1] + 224 <= H).all()
    assert inward.origin_counts()["edge"] > 0
    cf = coverage(dims=(W, H), plan=plan, mask=mask, mask_ds=(4.0, 4.0), candidates=floor)
    ci = coverage(dims=(W, H), plan=plan, mask=mask, mask_ds=(4.0, 4.0), candidates=inward)
    assert cf["edge_uncovered_tissue_area_um2"] > 0 and ci["edge_uncovered_tissue_area_um2"] == 0
    assert ci["candidate_tissue_area_um2"] == ci["tissue_area_um2"]  # every tissue pixel is reachable


def test_slide_smaller_than_one_patch():
    pol = P.PatchPolicy(fragment_rescue_min_area_um2=None)
    plan = _plan(pol, (0.5, 0.5))
    mask = np.ones((50, 50), dtype=bool)
    small = P.candidate_grid((200, 200), plan, mask, (4.0, 4.0), [], pol)
    assert small.coords.tolist() == [[0, 0]] and small.stats["grid"]["slide_smaller_than_patch"]
    assert len(P.candidate_grid((200, 200), plan, mask, (4.0, 4.0), [], pol.replace(edge_mode="floor"))) == 0


def test_exact_tissue_fractions_threshold_and_stride():
    pol = P.PatchPolicy(fragment_rescue_min_area_um2=None)
    plan = _plan(pol, (0.5, 0.5))  # extent 224
    mask = np.zeros((224, 448), dtype=bool)  # mask_ds 1: one mask px per level-0 px
    mask[:, :56] = True  # cell 0: 25 % tissue (kept at the 0.25 default)
    mask[:, 224:224 + 55] = True  # cell 1: 24.6 % (rejected)
    c = P.candidate_grid((448, 224), plan, mask, (1.0, 1.0), [], pol)
    assert c.coords.tolist() == [[0, 0]] and c.tissue_fraction.tolist() == [0.25]
    assert c.stats["rejected"] == {"background": 1, "excluded_region": 0}
    frac = P.cell_tissue_fractions(mask, (2.0, 2.0), np.array([[0, 0], [1, 0]]), (224, 224))
    assert frac[0] == pytest.approx(0.5) and frac[1] == pytest.approx(55.5 / 112)  # fractional mask coordinates
    half = P.candidate_grid((448, 224), plan, np.ones((224, 448), bool), (1.0, 1.0), [], pol.replace(stride_fraction=0.5))
    assert half.coords[:, 0].tolist() == [0, 112, 224] and half.stats["grid"]["stride"] == [112, 112]


def test_excluded_regions_exact_geometry():
    ext = (224, 224)
    cells = np.array([[0, 0], [224, 0], [448, 0], [0, 224]], dtype=np.int64)
    rect = {"type": "rectangle", "x": 100, "y": 50, "width": 124, "height": 20}  # ends exactly at x = 224
    assert P.cells_hit_regions(cells, ext, [rect]).tolist() == [True, False, False, False]
    big = {"type": "polygon", "coordinates": [[[-10, -10], [1000, -10], [1000, 1000], [-10, 1000], [-10, -10]]]}
    assert P.cells_hit_regions(cells, ext, [big]).all()  # cells fully inside: caught by the centre test
    tiny = {"points": [[300, 100], [310, 100], [305, 110]]}  # polygon inside one cell: caught by the edge test
    assert P.cells_hit_regions(cells, ext, [{"region": tiny}]).tolist() == [False, True, False, False]
    sliver = {"points": [[447.5, -5], [448.5, -5], [448.5, 500], [447.5, 500]]}  # 1 px wide, crosses 3 cells
    assert P.cells_hit_regions(cells, ext, [sliver]).tolist() == [False, True, True, False]
    with pytest.raises(ValueError):
        P.cells_hit_regions(cells, ext, [{"type": "circle"}])


def test_candidate_grid_respects_exclusions(cmu):
    osr, mask, ds = cmu
    pol = P.PatchPolicy()
    plan = _plan(pol)
    base = P.candidate_grid(osr.dimensions, plan, mask, ds, [], pol)
    W, H = osr.dimensions
    interior = base.coords[(base.origin == P.ORIGIN_GRID) & (base.coords[:, 0] < W - 448) & (base.coords[:, 1] < H - 448)]
    x, y = (int(v) for v in interior[len(interior) // 2])  # a cell no edge-shifted cell overlaps
    region = {"type": "rectangle", "x": x + 10, "y": y + 10, "width": 30, "height": 30}
    excl = P.candidate_grid(osr.dimensions, plan, mask, ds, [{"region": region}], pol)
    assert len(excl) == len(base) - 1 and [x, y] not in excl.coords.tolist()
    assert excl.stats["rejected"]["excluded_region"] == 1
    assert not P.cells_hit_regions(excl.coords, plan.extent, [region]).any()


def _fragment_mask():
    """2000 x 2000 px at 0.5 µm/px (mask px = 4 level-0 px = 2 µm): a tissue block, an isolated
    60 x 60 µm fragment centred on a grid corner (each of its four cells holds 7 % tissue) and a
    10 x 10 µm speck."""
    mask = np.zeros((500, 500), dtype=bool)  # mask_ds 4 -> 2 µm per mask px
    mask[20:200, 20:200] = True
    mask[209:239, 433:463] = True  # 30 x 30 mask px = 60 x 60 µm, centred on the grid corner (1792, 896)
    mask[400:405, 50:55] = True
    return mask


def test_fragment_rescue_gives_isolated_fragments_one_tissue_centred_patch():
    mask = _fragment_mask()
    pol = P.PatchPolicy()  # rescue for fragments >= 2000 µm²; the 60 x 60 µm fragment is 3600 µm²
    plan = _plan(pol, (0.5, 0.5))
    off = P.candidate_grid((2000, 2000), plan, mask, (4.0, 4.0), [], pol.replace(fragment_rescue_min_area_um2=None))
    on = P.candidate_grid((2000, 2000), plan, mask, (4.0, 4.0), [], pol)
    c_off = coverage(dims=(2000, 2000), plan=plan, mask=mask, mask_ds=(4.0, 4.0), candidates=off, policy=pol)
    c_on = coverage(dims=(2000, 2000), plan=plan, mask=mask, mask_ds=(4.0, 4.0), candidates=on, policy=pol)
    assert c_off["fragments_total"] == 2 and c_off["fragments_without_candidate"] == 1
    assert c_on["fragments_without_candidate"] == 0 and c_on["fragments_rescued"] == 1
    st = on.stats["fragments"]
    assert st["eligible"] == 2 and st["without_candidate"] == 1 and st["rescued"] == 1 and st["components"] == 3
    rescue = on.coords[on.origin == P.ORIGIN_RESCUE]
    assert len(rescue) == 1
    x, y = rescue[0]
    cx, cy = (433 + 15) * 4, (209 + 15) * 4  # fragment centre in level-0 px (1792, 896)
    assert x <= cx < x + 224 and y <= cy < y + 224  # tissue-centred
    assert abs(x + 112 - cx) <= 4 and abs(y + 112 - cy) <= 4
    # Read time uses the rescue floor, not the grid threshold, for this patch.
    assert on.read_floors(pol)[on.origin == P.ORIGIN_RESCUE].tolist() == [0.02]
    # The speck (100 µm²) is below the rescue area and is left alone.
    assert c_on["components_total"] == 3


def test_fragment_rescue_respects_exclusions_and_needs_calibration():
    mask = _fragment_mask()
    pol = P.PatchPolicy()
    plan = _plan(pol, (0.5, 0.5))
    # An exclusion over the fragment removes it from the eligible tissue entirely.
    region = {"type": "rectangle", "x": 1720, "y": 820, "width": 150, "height": 150}
    excl = P.candidate_grid((2000, 2000), plan, mask, (4.0, 4.0), [region], pol)
    assert excl.origin_counts()["fragment_rescue"] == 0 and excl.stats["fragments"]["eligible"] == 1
    assert not P.cells_hit_regions(excl.coords, plan.extent, [region]).any()
    unc_pol = pol.replace(allow_uncalibrated=True, uncalibrated_downsample=1.0)
    unc = P.candidate_grid((2000, 2000), _plan(unc_pol, (None, None)), mask, (4.0, 4.0), [], unc_pol)
    assert unc.stats["fragments"]["skipped"].startswith("uncalibrated")


def test_candidate_grid_is_deterministic_and_no_mask_mode(cmu):
    osr, mask, ds = cmu
    pol = P.PatchPolicy()
    plan = _plan(pol)
    a = P.candidate_grid(osr.dimensions, plan, mask, ds, [], pol)
    b = P.candidate_grid(osr.dimensions, plan, mask.copy(), ds, [], pol)
    assert a.sha256 == b.sha256 and np.array_equal(a.tissue_fraction, b.tissue_fraction)
    nomask = P.candidate_grid(osr.dimensions, plan, None, None, [], pol)
    assert len(nomask) == 140 and np.isnan(nomask.tissue_fraction).all()  # 10 x 14 cells with shift_inward


def test_cmu_edge_loss_legacy_vs_shift_inward(cmu):
    """Measured on the fixture: the legacy floor grid cannot reach 2.8 % of the tissue; shift_inward reaches all."""
    osr, mask, ds = cmu
    W, H = osr.dimensions
    legacy_plan = P.plan_scale(mpp_x=CMU_MPP, mpp_y=CMU_MPP, level_downsamples=[1.0], patch_size=224, target_mpp=0.5,
                               fallback_downsample=4.0)
    legacy = P.tissue_coordinates(dims=(W, H), plan=legacy_plan, mask=mask, mask_ds=ds, excluded=[],
                                  min_tissue_fraction=0.5, max_patches=10**6, sample_seed=0, coordinate_source="t")
    assert legacy.stats["candidates"] == 41  # the legacy path is unchanged
    cl = coverage(dims=(W, H), plan=legacy_plan, mask=mask, mask_ds=ds, candidates=legacy.coords,
                  grid_span=((W // 224) * 224, (H // 224) * 224))
    pol = P.PatchPolicy()
    new = P.candidate_grid((W, H), _plan(pol), mask, ds, [], pol)
    cn = coverage(dims=(W, H), plan=new.plan, mask=mask, mask_ds=ds, candidates=new, policy=pol)
    assert 0.02 < cl["edge_uncovered_tissue_area_um2"] / cl["tissue_area_um2"] < 0.04
    assert cn["edge_uncovered_tissue_area_um2"] == 0
    assert cn["candidate_tissue_fraction"] > cl["candidate_tissue_fraction"] + 0.1  # 0.94 vs 0.81 measured


# --------------------------------------------------------------------------- reading and quality


def test_patch_quality_measures():
    white = np.full((1, 16, 16, 3), 255, np.uint8)
    blue = np.zeros((1, 16, 16, 3), np.uint8)
    blue[...] = (40, 60, 160)
    pink = np.zeros((1, 16, 16, 3), np.uint8)
    pink[...] = (230, 150, 200)
    checker = np.full((1, 16, 16, 3), 100, np.uint8)  # grey: neither tissue nor ink
    checker[0, ::2, ::2] = 200
    checker[0, 1::2, 1::2] = 200
    q = P.patch_quality(np.concatenate([white, blue, pink, checker]))
    assert q["tissue_fraction"].tolist() == [0.0, 0.0, 1.0, 0.0]  # ink is not tissue
    assert q["pen_fraction"].tolist() == [0.0, 1.0, 0.0, 0.0] and q["pen_blue_fraction"][1] == 1.0
    assert q["laplacian_variance"][0] == 0.0 and q["laplacian_variance"][3] > 1e4
    assert q["mean_rgb"][1].tolist() == [40.0, 60.0, 160.0]
    with pytest.raises(ValueError):
        P.patch_quality(np.zeros((2, 8, 8, 3), np.float32))


def _ink_slide(cmu):
    """A 4-tile strip of real H&E tissue (CMU tiles with >= 90 % mask tissue); tile 1 gets a blue ink
    band, tile 2 green ink, tile 3 black ink; tile 0 stays clean. 0.5 µm/px, 224-px tiles."""
    osr, mask, ds = cmu
    pol = P.PatchPolicy(min_tissue_fraction=0.9, fragment_rescue_min_area_um2=None)
    tiles = P.candidate_grid(osr.dimensions, _plan(pol), mask, ds, [], pol).coords[:4]
    img = Image.new("RGB", (4 * 224, 224), "white")
    for i, (x, y) in enumerate(tiles.tolist()):
        img.paste(osr.read_region((x, y), 0, (224, 224)).convert("RGB"), (i * 224, 0))
    d = ImageDraw.Draw(img)
    d.rectangle([224, 0, 447, 150], fill=(40, 60, 160))  # 67 % of tile 1
    d.rectangle([448, 60, 671, 223], fill=(40, 140, 60))  # 73 % of tile 2
    d.rectangle([672, 0, 895, 100], fill=(30, 30, 30))  # 45 % of tile 3
    return openslide.ImageSlide(img)


def test_pen_marks_are_rejected_at_read_with_reasons(cmu):
    osr = _ink_slide(cmu)
    pol = P.PatchPolicy()
    plan = _plan(pol, (0.5, 0.5))
    coords = np.array([[0, 0], [224, 0], [448, 0], [672, 0]], dtype=np.int64)
    tally = P.ReadTally()
    kept, quality = [], []
    for cb, pb, st in P.iter_patch_batches(osr, coords, plan, batch_size=3, policy=pol):
        tally.add(st)
        kept += cb.tolist()
        quality.append(st["quality"]["pen_fraction"])
        assert pb.shape == (len(cb), 224, 224, 3) and pb.dtype == np.uint8
    assert kept == [[0, 0]]
    assert tally.as_dict()["rejected"] == {"pen_marks": 3, "background_at_read": 0, "blur": 0}
    pen = np.concatenate(quality)
    assert pen[0] < 0.1 and (pen[1:] > 0.4).all()
    # With the filter off the ink patches are read and yielded (the measure is still recorded).
    off = pol.replace(read_filters=P.ReadFilters(pen_marks=False))
    n = sum(len(cb) for cb, _, _ in P.iter_patch_batches(osr, coords, plan, batch_size=4, policy=off))
    assert n == 4


def test_background_at_read_and_rescue_floor():
    img = Image.new("RGB", (448, 224), "white")
    ImageDraw.Draw(img).rectangle([224, 0, 224 + 30, 223], fill=(200, 120, 170))  # 13 % tissue in tile 1
    osr = openslide.ImageSlide(img)
    pol = P.PatchPolicy()
    plan = _plan(pol, (0.5, 0.5))
    coords = np.array([[0, 0], [224, 0]], dtype=np.int64)
    out = list(P.iter_patch_batches(osr, coords, plan, batch_size=8, policy=pol))
    assert out[0][0].shape == (0, 2) and out[0][1].shape == (0, 224, 224, 3)  # empty batch still yielded
    assert out[0][2]["rejected"]["background_at_read"] == 2
    assert [r[2] for r in out[0][2]["rejected_coords"]] == ["background_at_read"] * 2
    cands = P.Candidates(coords=coords, tissue_fraction=np.array([0.0, 0.13]),
                         origin=np.array([P.ORIGIN_GRID, P.ORIGIN_RESCUE], np.int8), plan=plan, grid_span=(448, 224))
    kept = [cb.tolist() for cb, _, _ in P.iter_patch_batches(osr, cands, plan, batch_size=8, policy=pol)]
    assert kept == [[[224, 0]]]  # the rescue patch passes its 2 % floor; the blank grid cell does not


def test_single_resize_fill_and_anisotropic_read():
    img = Image.new("RGB", (300, 300), (200, 100, 150))
    osr = openslide.ImageSlide(img)
    # Filters off: a black fill would itself match the black-ink rule.
    pol = P.PatchPolicy(patch_size=32, target_mpp=1.0,
                        read_filters=P.ReadFilters(background_at_read=False, pen_marks=False))
    plan = _plan(pol, (0.5, 0.52))  # anisotropic within tolerance: read 64 x 62, resized once to 32 x 32
    assert plan.read_size == (64, 62)
    (cb, pb, st), = list(P.iter_patch_batches(osr, np.array([[0, 0], [280, 280]]), plan, batch_size=4, policy=pol))
    assert pb.shape == (2, 32, 32, 3) and st["resize_filter"] == "bilinear" and st["resized"] == 2
    assert st["fill_rgb"] == [255, 255, 255]  # ImageSlide has no background-color property
    assert (pb[0] == (200, 100, 150)).all()
    assert (pb[1, -1, -1] == 255).all() and (pb[1, 0, 0] == (200, 100, 150)).all()  # past the edge: the fill

    class BlackBackground:  # a reader whose slide declares a black background
        properties = {"openslide.background-color": "000000"}

        def read_region(self, *a):
            return osr.read_region(*a)

    (_, pb2, st2), = list(P.iter_patch_batches(BlackBackground(), np.array([[280, 280]]), plan, batch_size=4, policy=pol))
    assert st2["fill_rgb"] == [0, 0, 0] and (pb2[0, -1, -1] == 0).all()
    white = pol.replace(background_fill="white")
    (_, pb3, _), = list(P.iter_patch_batches(BlackBackground(), np.array([[280, 280]]), plan, batch_size=4, policy=white))
    assert (pb3[0, -1, -1] == 255).all()


def test_iteration_is_deterministic_on_cmu(cmu):
    osr, mask, ds = cmu
    pol = P.PatchPolicy()
    plan = _plan(pol)
    c = P.candidate_grid(osr.dimensions, plan, mask, ds, [], pol)
    a = np.concatenate([pb for _, pb, _ in P.iter_patch_batches(osr, c, plan, batch_size=16, policy=pol)])
    b = np.concatenate([pb for _, pb, _ in P.iter_patch_batches(osr, c, plan, batch_size=7, policy=pol)])
    assert a.shape == (len(c), 224, 224, 3) and np.array_equal(a, b)
    legacy, _ = P.read_patches(osr, c.coords[:3], plan)  # the legacy reader still works and agrees at 224 px
    assert np.array_equal(np.stack([np.asarray(p) for p in legacy]), a[:3])


def test_iter_patch_batches_holds_at_most_one_batch():
    rng = np.random.default_rng(0)
    osr = openslide.ImageSlide(Image.fromarray(rng.integers(0, 255, (256, 256, 3), dtype=np.uint8)))
    pol = P.PatchPolicy(patch_size=32, allow_uncalibrated=True, uncalibrated_downsample=1.0,
                        read_filters=P.ReadFilters(background_at_read=False, pen_marks=False))
    plan = _plan(pol, (None, None))
    base = np.array([[x, y] for y in range(0, 224, 32) for x in range(0, 224, 32)], dtype=np.int64)
    coords = np.tile(base, (50, 1))[:2400]
    batch, batch_bytes = 64, 64 * 32 * 32 * 3
    refs, n, max_alive = [], 0, 0
    gc.collect()
    tracemalloc.start()
    try:
        for cb, pb, st in P.iter_patch_batches(osr, coords, plan, batch_size=batch, policy=pol):
            refs.append(weakref.ref(pb))
            n += pb.shape[0]
            del cb, pb, st
            max_alive = max(max_alive, sum(r() is not None for r in refs))
        _, peak = tracemalloc.get_traced_memory()
    finally:
        tracemalloc.stop()
    total_bytes = n * 32 * 32 * 3
    assert n == 2400 and len(refs) == 38
    assert max_alive == 1  # the generator never keeps an earlier batch alive
    assert peak < 3 * batch_bytes < total_bytes / 10  # measured about 288 kB vs 7.4 MB of patches in total
