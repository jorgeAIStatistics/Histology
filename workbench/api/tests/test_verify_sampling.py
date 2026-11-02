"""Adversarial verification, lens "sampling, scale and memory" (research use only).

Each test states one guarantee of design §4/§5 and tries to break it through the public
functions, the feature-set build or the HTTP API. A failing test is a reproduction of a
defect; a passing one stays as regression coverage.

Guarantees attacked here:
* physical scale: the effective mpp equals the target at every pyramid level choice; coarse
  scans are refused (``would_upsample``) on every extraction path; anisotropic pixels and
  uncalibrated slides are refused (uncalibrated always in ``supervised_experiment``);
* the pixels read for a patch are exactly the rectangle that the exclusion check verified;
* ``shift_inward`` reaches tissue touching the right and bottom edges;
* isolated fragments get a patch (candidate level, and after sampling);
* excluded regions are never sampled (exact geometry, including what the QC API accepts);
* pen ink and background are rejected at read during a real build;
* spatial / uniform sampling: determinism, permutation invariance, exact counts, coverage;
* lesion-aware sampling is refused on every public path;
* the sampling seed is independent of the training seed;
* the macenko reference reads train-split slides only (and needs some);
* extraction memory does not grow with the number of patches; the streamed ``.npy`` equals an
  in-memory reference;
* coverage diagnostics are internally consistent (real CMU fixture) and measure excluded areas
  with the same pixel rule as everything else.
"""

from __future__ import annotations

import dataclasses
import math
import tracemalloc

import numpy as np
import openslide
import pytest
from PIL import Image

from dermpath.config import FIXTURES_DIR
from dermpath.ml import patching as P
from dermpath.ml import sampling as S
from dermpath.ml.coverage import coverage

from feature_set_support import (
    CMU_PROJECT,
    HANDCRAFTED,
    LEAD_ID,
    cmu_slide_id,
    create_set,
    get_set,
    image_slide,
    items_of,
    real_cohort,
)

CMU = FIXTURES_DIR / "CMU-1-Small-Region.svs"
CMU_MPP = 0.499
PS = 224

#: Realistic scanner pixel sizes (µm/px), pyramid layouts (incl. non-integer and 2x/3x levels) and targets.
SCANNER_MPPS = (0.1, 0.2266, 0.2425, 0.2462, 0.2482, 0.25, 0.2527, 0.263, 0.3, 0.4, 0.46, 0.4995, 0.5, 0.51,
                0.52, 0.525, 0.55, 1.0)
PYRAMIDS = ([1.0], [1.0, 4.0, 16.0, 64.0], [1.0, 2.0, 4.0, 8.0, 16.0], [1.0, 4.000345, 16.0021, 64.01],
            [1.0, 3.0, 9.0], [1.0, 2.0001, 4.0004, 8.0011])
TARGETS = (0.25, 0.5, 1.0, 2.0)


def _build(fs_id: str, ctx=None) -> dict:
    from dermpath.ml.feature_sets import build_feature_set

    return build_feature_set(fs_id, ctx)


def _footprint(plan: P.PatchPlan) -> tuple[float, float]:
    """Level-0 px actually covered by one ``read_region(level, read_size)`` call."""
    return plan.read_size[0] * plan.level_downsample, plan.read_size[1] * plan.level_downsample


def _sweep():
    for mpp in SCANNER_MPPS:
        for pyr in PYRAMIDS:
            for t in TARGETS:
                pol = P.PatchPolicy(target_mpp=t)
                try:
                    yield mpp, pyr, t, P.plan_scale(mpp_x=mpp, mpp_y=mpp, level_downsamples=pyr, policy=pol), None
                except P.ScaleError as exc:
                    yield mpp, pyr, t, None, exc


# --------------------------------------------------------------------------- physical scale


def test_effective_mpp_equals_target_at_every_pyramid_level_choice():
    accepted = refused = 0
    for mpp, pyr, t, plan, exc in _sweep():
        ext0 = max(1, int(round(PS * t / mpp)))
        if exc is not None:
            refused += 1
            if exc.reason == "would_upsample":
                assert PS / ext0 > 1.05, (mpp, pyr, t)  # refused only when level 0 itself is too coarse
            else:
                assert exc.reason == "read_size_cap", (mpp, pyr, t, exc)
                best = max(d for d in pyr if round(ext0 / d) >= PS)
                assert round(ext0 / best) > 4 * PS, (mpp, pyr, t)
            continue
        accepted += 1
        assert plan.calibrated and plan.upsample_ratio <= 1.05 + 1e-12
        for f in _footprint(plan):  # the pixels actually read, resized once to PS
            assert abs(f * mpp / PS - t) / t <= 0.005, (mpp, pyr, t, plan.level, plan.read_size)
        for eff in (plan.effective_mpp_x, plan.effective_mpp_y):  # the recorded claim
            assert abs(eff - t) / t <= 0.005, (mpp, pyr, t)
        # The coarsest level that still has >= PS px is used (a coarser one would upsample).
        for d in pyr:
            if d > plan.level_downsample + 1e-9:
                assert round(plan.extent[0] / d) < PS, (mpp, pyr, t, plan.level)
    assert accepted > 200 and refused > 10


def test_anisotropy_and_uncalibrated_refusals_hold_for_every_degenerate_mpp():
    pol = P.PatchPolicy()
    ok = P.plan_scale(mpp_x=0.25, mpp_y=0.27, level_downsamples=[1.0, 4.0], policy=pol)  # 8 %: accepted
    for f, mpp in zip(_footprint(ok), (0.25, 0.27)):
        assert abs(f * mpp / PS - 0.5) / 0.5 <= 0.005  # each axis at the target, then a square patch
    edge = P.plan_scale(mpp_x=0.25, mpp_y=0.275, level_downsamples=[1.0], policy=pol)  # exactly 10 %
    assert edge.calibrated
    with pytest.raises(P.ScaleError) as e:
        P.plan_scale(mpp_x=0.25, mpp_y=0.2760, level_downsamples=[1.0], policy=pol)
    assert e.value.reason == "anisotropic"
    for mx, my in ((None, None), (0.25, None), (None, 0.25), (0.0, 0.0), (-0.25, -0.25), (float("nan"), 0.25),
                   (float("inf"), float("inf")), ("", "")):
        with pytest.raises(P.ScaleError) as e:
            P.plan_scale(mpp_x=mx, mpp_y=my, level_downsamples=[1.0, 4.0], policy=pol)
        assert e.value.reason == "uncalibrated", (mx, my)
        unc = P.plan_scale(mpp_x=mx, mpp_y=my, level_downsamples=[1.0, 4.0],
                           policy=pol.replace(allow_uncalibrated=True))
        assert unc.calibrated is False and unc.effective_mpp is None
    for mx in (1e-4, 25.0):
        with pytest.raises(P.ScaleError) as e:
            P.plan_scale(mpp_x=mx, mpp_y=mx, level_downsamples=[1.0], policy=pol)
        assert e.value.reason == "implausible_mpp"


class _RecordingSlide:
    """A pyramid reader that records every ``read_region`` call (no pixels of interest)."""

    def __init__(self, dims=(4000, 4000), downsamples=(1.0, 2.0)):
        self.dimensions = dims
        self.level_downsamples = downsamples
        self.properties = {}
        self.reads: list[tuple] = []

    def read_region(self, loc, level, size):
        self.reads.append((tuple(loc), int(level), tuple(size)))
        return Image.new("RGBA", tuple(size), (200, 120, 170, 255))


def test_read_footprint_never_exceeds_the_extent_checked_against_exclusions():
    """The exclusion check (exact geometry) is done on ``[x, x + extent)``; the pixels read must lie inside it."""
    over = []
    for mpp, pyr, t, plan, exc in _sweep():
        if plan is None:
            continue
        fx, fy = _footprint(plan)
        if fx > plan.extent[0] + 1e-9 or fy > plan.extent[1] + 1e-9:
            over.append((round(fx - plan.extent[0], 3), mpp, pyr, t, plan.level, plan.extent, plan.read_size))
    # Concrete case: a 0.2462 µm/px scan with a 2x level. A human excluded [455, 1000) x [0, 455); the
    # candidate at (0, 0) does not touch it, so it is kept, then its pixels are read.
    pol = P.PatchPolicy(fragment_rescue_min_area_um2=None)
    plan = P.plan_scale(mpp_x=0.2462, mpp_y=0.2462, level_downsamples=[1.0, 2.0], policy=pol)
    excluded = [{"type": "rectangle", "x": plan.extent[0], "y": 0, "width": 545, "height": plan.extent[1]}]
    mask = np.ones((1000, 1000), dtype=bool)
    cands = P.candidate_grid((4000, 4000), plan, mask, (4.0, 4.0), excluded, pol)
    assert [0, 0] in cands.coords.tolist()  # the exact-geometry check keeps the abutting cell
    osr = _RecordingSlide()
    list(P.iter_patch_batches(osr, cands.subset(np.array([cands.coords.tolist().index([0, 0])])), plan,
                              batch_size=4, policy=pol))
    ((loc, level, size),) = osr.reads
    read_right = loc[0] + size[0] * osr.level_downsamples[level]
    worst = max(over, default=None)
    assert read_right <= excluded[0]["x"], (
        f"the patch at (0, 0) reads level-0 x in [0, {read_right}) but the excluded region starts at "
        f"{excluded[0]['x']} (plan extent {plan.extent}, level {plan.level}, read {plan.read_size}); "
        f"{len(over)} of the swept plans read beyond their extent, worst {worst}")
    assert not over


# --------------------------------------------------------------------------- edges and fragments


def test_shift_inward_reaches_all_tissue_touching_right_and_bottom_edges_property():
    rng = np.random.default_rng(7)
    pol = P.PatchPolicy(fragment_rescue_min_area_um2=None, min_tissue_fraction=0.05)
    plan = P.plan_scale(mpp_x=0.5, mpp_y=0.5, level_downsamples=[1.0], policy=pol)
    assert plan.extent == (PS, PS)
    floor_missed = 0
    for _ in range(30):
        W, H = int(rng.integers(240, 1600)), int(rng.integers(240, 1600))
        mw, mh = int(math.ceil(W / 4)), int(math.ceil(H / 4))
        ds = (W / mw, H / mh)  # what qc.tissue.segment records
        mask = np.zeros((mh, mw), dtype=bool)
        bw, bh = int(rng.integers(3, 12)), int(rng.integers(3, 12))
        mask[:, mw - bw:] = True  # tissue touching the right edge
        mask[mh - bh:, :] = True  # and the bottom edge (and the corner)
        for stride in (1.0, 0.5):
            p = pol.replace(stride_fraction=stride)
            c = P.candidate_grid((W, H), plan, mask, ds, [], p)
            assert c.grid_span == (W, H)
            assert (c.coords[:, 0] + PS <= W).all() and (c.coords[:, 1] + PS <= H).all()  # shifted, not padded
            cover = P.paint_rects(mask.shape, ds, c.coords, plan.extent)
            assert cover[mask].all(), (W, H, bw, bh, stride)
            cv = coverage(dims=(W, H), plan=plan, mask=mask, mask_ds=ds, candidates=c, policy=p)
            assert cv["edge_uncovered_tissue_area_um2"] == 0 and cv["candidate_tissue_fraction"] == 1.0
            fl = P.candidate_grid((W, H), plan, mask, ds, [], p.replace(edge_mode="floor"))
            floor_missed += int(not P.paint_rects(mask.shape, ds, fl.coords, plan.extent)[mask].all())
    assert floor_missed > 20  # the attack is meaningful: a floor grid loses these strips


def _fragment_layout(W=4000, H=4000):
    """0.5 µm/px, mask px = 4 level-0 px (2 µm): a big tissue block and one isolated 60 x 60 µm fragment."""
    mask = np.zeros((H // 4, W // 4), dtype=bool)
    mask[20:700, 20:700] = True
    mask[870:900, 870:900] = True  # 3600 µm², 2.1 mm from the block
    return mask


def test_isolated_fragments_touching_the_slide_edges_get_a_candidate():
    pol = P.PatchPolicy()
    plan = P.plan_scale(mpp_x=0.5, mpp_y=0.5, level_downsamples=[1.0], policy=pol)
    W = H = 2000  # mask px = 4 level-0 px = 2 µm; fragments are 30 x 30 mask px = 3600 µm² (rescue >= 2000)
    cases = {"right_edge": (slice(200, 230), slice(470, 500)),  # split 96/24 px over two shifted cells: < 25 %
             "bottom_edge": (slice(470, 500), slice(100, 130)),
             "bottom_right_corner": (slice(470, 500), slice(470, 500)),
             "bottom_left_corner": (slice(470, 500), slice(0, 30)),
             "straddling_four_cells": (slice(209, 239), slice(209, 239))}
    rescued = 0
    for name, (ys, xs) in cases.items():
        mask = np.zeros((H // 4, W // 4), dtype=bool)
        mask[10:120, 10:120] = True
        mask[ys, xs] = True
        c = P.candidate_grid((W, H), plan, mask, (4.0, 4.0), [], pol)
        cv = coverage(dims=(W, H), plan=plan, mask=mask, mask_ds=(4.0, 4.0), candidates=c, policy=pol)
        assert cv["fragments_total"] == 2 and cv["fragments_without_candidate"] == 0, (name, c.stats["fragments"])
        for x, y in c.coords[c.origin == P.ORIGIN_RESCUE].tolist():
            rescued += 1
            assert 0 <= x <= W - PS and 0 <= y <= H - PS, name  # inside the slide
            sub = mask[ys, xs]
            assert P.paint_rects(mask.shape, (4.0, 4.0), np.array([[x, y]]), plan.extent)[ys, xs][sub].all(), name
    assert rescued >= 3


def test_fragment_next_to_an_exclusion_still_gets_a_patch_when_one_fits():
    """The fragment's own tissue is not excluded and a patch covering all of it without touching the excluded
    region exists ([3376, 3600) x [3376, 3600)); the fragment must not be left without a patch."""
    pol = P.PatchPolicy()
    plan = P.plan_scale(mpp_x=0.5, mpp_y=0.5, level_downsamples=[1.0], policy=pol)
    mask = _fragment_layout()  # fragment at level-0 [3480, 3600) x [3480, 3600)
    region = {"type": "rectangle", "x": 3600, "y": 3300, "width": 300, "height": 600}  # starts where it ends
    assert not P.cells_hit_regions(np.array([[3376, 3376]]), plan.extent, [region]).any()
    c = P.candidate_grid((4000, 4000), plan, mask, (4.0, 4.0), [region], pol)
    cv = coverage(dims=(4000, 4000), plan=plan, mask=mask, mask_ds=(4.0, 4.0), candidates=c, excluded=[region],
                  policy=pol)
    assert not P.cells_hit_regions(c.coords, plan.extent, [region]).any()
    assert cv["fragments_without_candidate"] == 0, (cv["fragments_without_candidate"], c.stats["fragments"])


def test_rescued_isolated_fragment_survives_the_default_sampling():
    """Design §4: a tissue fragment with no candidate gets one patch. With the default policy (spatial, 64
    patches per slide) on a slide with more than 64 candidates, that patch must still be embedded."""
    pol = P.PatchPolicy()  # spatial, max_patches 64 (feature-set default)
    plan = P.plan_scale(mpp_x=0.5, mpp_y=0.5, level_downsamples=[1.0], policy=pol)
    mask = _fragment_layout()
    c = P.candidate_grid((4000, 4000), plan, mask, (4.0, 4.0), [], pol)
    rescue = np.flatnonzero(c.origin == P.ORIGIN_RESCUE)
    assert len(rescue) == 1 and len(c) > 64
    dropped = []
    for seed in range(20):
        idx, _ = S.select_indices(c, pol.replace(sampling=S.SamplingPolicy(strategy="spatial", max_patches=64,
                                                                           seed=seed)), salt=f"slide-{seed}")
        if not np.isin(rescue, idx).all():
            cv = coverage(dims=(4000, 4000), plan=plan, mask=mask, mask_ds=(4.0, 4.0), candidates=c,
                          sampled=c.subset(idx), policy=pol)
            dropped.append((seed, cv["fragments_without_candidate"], cv["fragments_rescued"],
                            cv["sampled_origins"]["fragment_rescue"]))
    assert not dropped, (f"the rescued fragment has no embedded patch for {len(dropped)} of 20 sampling seeds, "
                         f"while coverage reports (fragments_without_candidate, fragments_rescued) = "
                         f"{dropped[0][1:3]} and sampled_origins.fragment_rescue = {dropped[0][3]}")


# --------------------------------------------------------------------------- exclusions


def _clip_area(poly, x0, y0, x1, y1) -> float:
    """Exact area of ``poly`` ∩ rectangle (Sutherland–Hodgman against the convex rectangle)."""
    pts = [(float(a), float(b)) for a, b in poly]

    def clip(pts, inside, cross):
        out = []
        for i in range(len(pts)):
            cur, prev = pts[i], pts[i - 1]
            if inside(cur):
                if not inside(prev):
                    out.append(cross(prev, cur))
                out.append(cur)
            elif inside(prev):
                out.append(cross(prev, cur))
        return out

    def at_x(xc):
        return lambda p, q: (xc, p[1] + (q[1] - p[1]) * (xc - p[0]) / (q[0] - p[0]))

    def at_y(yc):
        return lambda p, q: (p[0] + (q[0] - p[0]) * (yc - p[1]) / (q[1] - p[1]), yc)

    for inside, cross in ((lambda p: p[0] >= x0, at_x(x0)), (lambda p: p[0] <= x1, at_x(x1)),
                          (lambda p: p[1] >= y0, at_y(y0)), (lambda p: p[1] <= y1, at_y(y1))):
        pts = clip(pts, inside, cross)
        if not pts:
            return 0.0
    xs, ys = np.array([p[0] for p in pts]), np.array([p[1] for p in pts])
    return float(abs(np.dot(xs, np.roll(ys, -1)) - np.dot(ys, np.roll(xs, -1))) / 2)


def test_exclusion_check_matches_exact_intersection_area_for_simple_polygons():
    rng = np.random.default_rng(11)
    cells = np.array([[x, y] for y in range(0, 1000, 100) for x in range(0, 1000, 100)], dtype=np.int64)
    checked = 0
    for trial in range(120):
        if trial % 3 == 0:  # rectangles snapped to the grid lines (touching cases) or nudged off them
            x0, y0 = (float(rng.integers(0, 9)) * 100 + rng.choice([0.0, 1e-3, -1e-3, 0.5]) for _ in range(2))
            w, h = (float(rng.integers(1, 4)) * 100 + rng.choice([0.0, 1e-3, -1e-3]) for _ in range(2))
            poly = [(x0, y0), (x0 + w, y0), (x0 + w, y0 + h), (x0, y0 + h)]
        else:  # star-shaped (simple) polygons
            cx, cy = rng.uniform(100, 900, 2)
            ang = np.sort(rng.uniform(0, 2 * np.pi, int(rng.integers(3, 12))))
            rad = rng.uniform(5, 260, ang.size)
            poly = list(zip(cx + rad * np.cos(ang), cy + rad * np.sin(ang)))
        hit = P.cells_hit_regions(cells, (100, 100), [{"points": [list(p) for p in poly]}])
        for i, (x, y) in enumerate(cells.tolist()):
            a = _clip_area(poly, x, y, x + 100, y + 100)
            if a > 1e-6:
                assert hit[i], (trial, poly, (x, y), a)
                checked += 1
            elif a == 0.0:
                assert not hit[i], (trial, poly, (x, y))
    assert checked > 300


def test_exclusion_check_memory_does_not_grow_with_polygon_vertex_count():
    """A freehand QC lasso may have up to annotations.MAX_POINTS (20000) vertices; candidate_grid runs inside every
    extraction, so its memory must stay bounded whatever the outline's resolution."""
    from types import SimpleNamespace

    from dermpath.annotations import MAX_POINTS, normalise_geometry

    pol = P.PatchPolicy(fragment_rescue_min_area_um2=None)
    plan = P.plan_scale(mpp_x=0.5, mpp_y=0.5, level_downsamples=[1.0], policy=pol)
    W = H = PS * 64  # 4096 cells of 112 µm (a 7 x 7 mm region)
    mask = np.ones((1024, 1024), dtype=bool)
    ds = (W / 1024, H / 1024)
    peaks = {}
    for nv in (250, 4000):
        ang = np.linspace(0, 2 * np.pi, nv, endpoint=False)
        rad = 5000 + 300 * np.sin(7 * ang)  # a wobbly lasso around a fold
        pts = np.stack([W / 2 + rad * np.cos(ang), H / 2 + rad * np.sin(ang)], axis=1).round(2).tolist()
        _, geo = normalise_geometry({"type": "polygon", "points": pts}, SimpleNamespace(width=W, height=H))
        tracemalloc.start()
        try:
            tracemalloc.reset_peak()
            c = P.candidate_grid((W, H), plan, mask, ds, [{"region": geo}], pol)
            peaks[nv] = tracemalloc.get_traced_memory()[1]
        finally:
            tracemalloc.stop()
        assert len(c) == 2438
    assert MAX_POINTS >= 4000  # the QC API accepts outlines this detailed
    assert peaks[4000] < 1.5 * peaks[250] + 20e6, (
        f"tracemalloc peak of candidate_grid: {peaks[250] / 1e6:.0f} MB with a 250-vertex exclusion, "
        f"{peaks[4000] / 1e6:.0f} MB with a 4000-vertex one (linear in vertices; {MAX_POINTS} are accepted)")


def test_self_intersecting_exclusion_polygon_accepted_by_the_qc_api_is_never_sampled(env, ids, clients, monkeypatch):
    """A freehand lasso drawn twice around a fold (a self-intersecting ring) passes the QC API's geometry
    validation; nothing inside the region the person enclosed may be embedded."""
    from dermpath.ml import feature_sets as fsm

    sid = image_slide(monkeypatch, slide_id="verifylasso01", width=1344, height=1344, mpp=0.5, seed=3)
    asst = clients("user-assistant")
    outer = [[224, 224], [1120, 224], [1120, 1120], [224, 1120], [224, 224]]
    inner = [[260, 260], [1084, 260], [1084, 1084], [260, 1084], [260, 260]]  # second loop, same direction
    r = asst.post(f"/api/v1/slides/{sid}/qc/issues", json={"category": "fold", "region": {
        "type": "polygon", "points": outer + inner}, "note": "lasso drawn twice around a fold (test)"})
    assert r.status_code in (200, 201), r.text
    issue = r.json()
    asst.patch(f"/api/v1/qc/issues/{issue['id']}", json={"action": "review", "confirmed": True})
    r = asst.patch(f"/api/v1/qc/issues/{issue['id']}", json={
        "action": "resolve", "resolution": "fold excluded", "dataset_eligibility_effect": "exclude_region",
        "reason": "fold (test)"})
    assert r.status_code == 200, r.text
    fs_id = create_set(CMU_PROJECT, encoder_id=HANDCRAFTED, execution_mode="real_image_technical",
                       slide_ids=[sid], params={"sampling_strategy": "all", "fragment_rescue_min_area_um2": 0})
    _build(fs_id)
    feats = fsm.load_slide_features(fs_id, sid)
    enclosed = [tuple(xy) for xy in feats.coords.tolist()
                if _clip_area([tuple(p) for p in outer[:-1]], xy[0], xy[1], xy[0] + PS, xy[1] + PS) > 0]
    assert feats.n_patches > 0
    assert not enclosed, (f"{len(enclosed)} embedded patches lie inside the lasso the person drew "
                          f"(fully inside the second loop): {enclosed}")


# --------------------------------------------------------------------------- read-time filters


def test_pen_ink_and_background_are_rejected_at_read_during_a_build(env, ids, clients, monkeypatch):
    """A slide with a marker stroke and some blank glass inside the tissue mask builds through the API; the ink and
    the glass are rejected when read and never embedded."""
    from dermpath.jobs.worker import Worker
    from dermpath.ml import feature_sets as fsm

    osr = openslide.OpenSlide(str(CMU))
    W, H = osr.dimensions
    img = np.asarray(osr.read_region((0, 0), 0, (W, H)).convert("RGB")).copy()
    osr.close()
    yy, xx = np.mgrid[0:H, 0:W]
    ink = np.abs((yy - 0.9 * xx) - 700) < 110  # a blue marker stroke across the tissue
    img[ink] = (35, 70, 175)
    white = np.zeros((H, W), dtype=bool)
    white[2250:2700, 250:1150] = True  # blank glass that a stale/coarse mask calls tissue
    img[white] = (243, 243, 243)
    sid = image_slide(monkeypatch, slide_id="verifypenbg01", image=Image.fromarray(img), mpp=CMU_MPP)
    real_otsu = fsm.otsu_mask

    def otsu_with_stale_tissue(o, sha=None):
        mask, st = real_otsu(o, None)
        mask = mask.copy()
        dx, dy = st["mask_downsample_x"], st["mask_downsample_y"]
        mask[int(2250 / dy):int(2700 / dy), int(250 / dx):int(1150 / dx)] = True
        return mask, st

    monkeypatch.setattr(fsm, "otsu_mask", otsu_with_stale_tissue)
    lead = clients(LEAD_ID)
    r = lead.post(f"/api/v1/projects/{CMU_PROJECT}/feature-sets", json={
        "encoder_id": HANDCRAFTED, "execution_mode": "real_image_technical", "slide_ids": [sid],
        "params": {"sampling_strategy": "all", "fragment_rescue_min_area_um2": 0}})
    assert r.status_code == 202, r.text
    fs_id = r.json()["feature_set"]["id"]
    out = Worker("verify-pen", types=["build_feature_set"]).run_until_idle()
    got = lead.get(f"/api/v1/feature-sets/{fs_id}").json()
    assert got["status"] == "ready", ([(o.status, o.error) for o in out], got.get("error"))
    item = items_of(fs_id)[sid]
    feats = fsm.load_slide_features(fs_id, sid)
    rej = item.stats_json["rejected_at_read"]
    assert rej["pen_marks"] > 0 and rej["background_at_read"] > 0, rej
    assert item.stats_json["n_patches"] == feats.n_patches == item.stats_json["n_sampled"] - sum(rej.values())
    e = PS  # extent at 0.499 µm/px is 224 level-0 px: patches are the image pixels, no resize
    for x, y in feats.coords.tolist():
        assert ink[y:y + e, x:x + e].mean() <= 0.25 + 1e-9, (x, y)  # painted ink is all detected as blue ink
        assert white[y:y + e, x:x + e].mean() <= 0.75 + 1e-9, (x, y)  # blank glass is never tissue
    assert (feats.quality["pen_fraction"] <= 0.25).all() and (feats.quality["tissue_fraction"] >= 0.25).all()
    # Every grid cell that is mostly ink or mostly blank glass was read and rejected, never embedded.
    kept = {tuple(c) for c in feats.coords.tolist()}
    plan = P.plan_scale(mpp_x=CMU_MPP, mpp_y=CMU_MPP, level_downsamples=[1.0], policy=P.PatchPolicy())
    for x in list(range(0, W - e + 1, e)) + [W - e]:
        for y in list(range(0, H - e + 1, e)) + [H - e]:
            if ink[y:y + e, x:x + e].mean() > 0.3 or white[y:y + e, x:x + e].mean() > 0.8:
                assert (x, y) not in kept, (x, y, plan.extent)


# --------------------------------------------------------------------------- sampling


class _Cands:
    def __init__(self, coords, ext=(100, 100)):
        self.coords = np.asarray(coords, dtype=np.int64).reshape(-1, 2)
        self.extent = ext


def test_sampling_is_deterministic_permutation_invariant_and_exact_in_count():
    rng = np.random.default_rng(5)
    for trial in range(40):
        n_side = int(rng.integers(3, 30))
        grid = np.array([[x * 100, y * 100] for y in range(n_side) for x in range(n_side)], dtype=np.int64)
        keep = rng.random(len(grid)) < rng.uniform(0.2, 1.0)
        base = grid[keep] if keep.any() else grid[:1]
        k = int(rng.integers(1, max(2, len(base) + 5)))
        for strategy in ("spatial", "uniform"):
            sp = S.SamplingPolicy(strategy=strategy, max_patches=k, seed=int(rng.integers(0, 1000)))
            a, st = S.sample(_Cands(base), sp, salt="slide-a")
            perm = base[rng.permutation(len(base))]
            b, _ = S.sample(_Cands(perm), sp, salt="slide-a")
            assert np.array_equal(a, b), (trial, strategy)  # input order never matters
            assert a.shape[0] == min(k, len(base)) == st["selected"], (trial, strategy, k, len(base))
            assert len({tuple(r) for r in a.tolist()}) == a.shape[0]  # no duplicates
            again, _ = S.sample(_Cands(base), sp, salt="slide-a")
            assert np.array_equal(a, again)
    # Seed and salt are the only sources of variation.
    g = np.array([[x * 100, y * 100] for y in range(20) for x in range(20)], dtype=np.int64)
    a, _ = S.sample(_Cands(g), S.SamplingPolicy(strategy="spatial", max_patches=16, seed=1), salt="s")
    assert not np.array_equal(a, S.sample(_Cands(g), S.SamplingPolicy(strategy="spatial", max_patches=16, seed=2),
                                          salt="s")[0])
    assert not np.array_equal(a, S.sample(_Cands(g), S.SamplingPolicy(strategy="spatial", max_patches=16, seed=1),
                                          salt="t")[0])


def test_spatial_coverage_is_not_below_uniform_on_irregular_tissue_layouts():
    H, W = 750, 1000
    yy, xx = np.mgrid[0:H, 0:W]
    ring = (np.hypot(yy - 375, xx - 500) > 250) & (np.hypot(yy - 375, xx - 500) < 300)
    ell = np.zeros((H, W), dtype=bool)
    ell[100:700, 100:160] = True
    ell[640:700, 100:900] = True
    pol = P.PatchPolicy(fragment_rescue_min_area_um2=None)
    plan = P.plan_scale(mpp_x=0.5, mpp_y=0.5, level_downsamples=[1.0], policy=pol)
    for name, mask in (("ring", ring), ("L", ell)):
        c = P.candidate_grid((8000, 6000), plan, mask, (8.0, 8.0), [], pol)
        for k in (16, 32):
            res = {}
            for strategy in ("uniform", "spatial"):
                vals = []
                for seed in range(5):
                    coords, _ = S.sample(c, S.SamplingPolicy(strategy=strategy, max_patches=k, seed=seed), salt=name)
                    cv = coverage(dims=(8000, 6000), plan=plan, mask=mask, mask_ds=(8.0, 8.0), candidates=c,
                                  sampled=coords, policy=pol)
                    vals.append(cv["tissue_within_radius_of_sample_fraction"])
                res[strategy] = vals
            assert np.mean(res["spatial"]) >= np.mean(res["uniform"]), (name, k, res)
            assert min(res["spatial"]) >= min(res["uniform"]), (name, k, res)


def test_lesion_aware_is_refused_on_every_public_path(env, ids, clients):
    from dermpath.ml.feature_sets import InvalidFeatureParams

    lead = clients(LEAD_ID)
    sid = cmu_slide_id(ids)
    for body in ({"params": {"sampling_strategy": "lesion_aware"}},
                 {"patch_policy": {"sampling_strategy": "lesion_aware"}}):
        r = lead.post(f"/api/v1/projects/{CMU_PROJECT}/feature-sets",
                      json={"encoder_id": HANDCRAFTED, "execution_mode": "real_image_technical", "slide_ids": [sid],
                            **body})
        assert r.status_code == 422, r.text
    with pytest.raises(InvalidFeatureParams):
        create_set(CMU_PROJECT, encoder_id=HANDCRAFTED, execution_mode="real_image_technical", slide_ids=[sid],
                   params={"sampling_strategy": "lesion_aware"})
    rc = real_cohort(ids, n=4, project_id="proj-verify-lesion")
    r = lead.post(f"/api/v1/projects/{rc['project_id']}/experiments", json={
        "dataset_version_id": rc["dataset_version_id"], "encoder_id": HANDCRAFTED, "head": "meanpool_logreg",
        "seed": 0, "params": {"sampling_strategy": "lesion_aware"}})
    assert r.status_code == 422, r.text
    g = _Cands([[x * 100, y * 100] for y in range(10) for x in range(10)])
    region = {"region": {"type": "rectangle", "x": 0, "y": 0, "width": 300, "height": 300},
              "source": "expert_annotation"}
    for regions, reason in ((None, "lesion_aware_requires_permitted_regions"), ([], "lesion_aware_requires_permitted_regions"),
                            ([{**region, "split": "val"}], "lesion_region_not_train"),
                            ([{**region, "split": "test"}], "lesion_region_not_train"),
                            ([{**region, "split": None}], "lesion_region_not_train"),
                            ([{**region, "split": "train", "source": "model_suggestion"}], "lesion_region_not_expert")):
        with pytest.raises(S.SamplingError) as e:
            S.select_indices(g, S.SamplingPolicy(strategy="lesion_aware", max_patches=5), permitted_lesion_regions=regions)
        assert e.value.reason == reason
    with pytest.raises(S.SamplingError):  # also refused when there is nothing to sample
        S.select_indices(_Cands(np.zeros((0, 2))), S.SamplingPolicy(strategy="lesion_aware", max_patches=5))
    with pytest.raises(S.SamplingError) as e:  # regions never leak into another strategy
        S.select_indices(g, S.SamplingPolicy(strategy="spatial", max_patches=5),
                         permitted_lesion_regions=[{**region, "split": "train"}])
    assert e.value.reason == "permitted_regions_unused"


def test_training_seed_never_changes_the_sampled_coordinates(env, ids, clients):
    from dermpath.ml import feature_sets as fsm

    rc = real_cohort(ids, n=4, project_id="proj-verify-seed")
    lead = clients(LEAD_ID)

    def experiment_set(seed: int, **params) -> str:
        r = lead.post(f"/api/v1/projects/{rc['project_id']}/experiments", json={
            "dataset_version_id": rc["dataset_version_id"], "encoder_id": HANDCRAFTED, "head": "meanpool_logreg",
            "seed": seed, "params": {"max_patches_per_slide": 4, **params}})
        assert r.status_code == 202, r.text
        return r.json()["experiment"]["feature_set_id"]

    fs_ids = [experiment_set(seed) for seed in (0, 1, 7, 12345)]
    assert len(set(fs_ids)) == 1, fs_ids  # one pinned feature set whatever the head seed
    assert get_set(fs_ids[0]).patch_policy_json["sampling"]["seed"] == 0
    other = experiment_set(0, sampling_seed=9)
    assert other != fs_ids[0] and experiment_set(5, sampling_seed=9) == other
    _build(fs_ids[0])
    _build(other)
    differs = [s for s in rc["slide_ids"]
               if not np.array_equal(fsm.load_slide_features(fs_ids[0], s).coords,
                                     fsm.load_slide_features(other, s).coords)]
    assert differs  # only the sampling seed moves the coordinates


# --------------------------------------------------------------------------- macenko


def test_macenko_reference_reads_train_split_slides_only(env, ids, monkeypatch):
    from dermpath.ml import feature_sets as fsm
    from dermpath.ml import stain as stainlib

    rc = real_cohort(ids, n=6, project_id="proj-verify-stain")
    train = {s for s, sp in rc["split_of"].items() if sp == "train"}
    assert train and set(rc["split_of"].values()) >= {"train", "val", "test"}
    during_fit: list[str] = []
    state = {"fitting": False}
    real_fit, real_prepare = stainlib.fit_reference, fsm._prepare

    def fit_spy(patches, *, splits=None, params=None):
        state["fitting"] = True
        try:
            return real_fit(patches, splits=splits, params=params)
        finally:
            state["fitting"] = False

    def prepare_spy(snap, **kw):
        if state["fitting"]:
            during_fit.append(snap["slide_id"])
        return real_prepare(snap, **kw)

    monkeypatch.setattr(stainlib, "fit_reference", fit_spy)
    monkeypatch.setattr(fsm, "_prepare", prepare_spy)
    fs_id = create_set(rc["project_id"], encoder_id=HANDCRAFTED, execution_mode="supervised_experiment",
                       dataset_version_id=rc["dataset_version_id"],
                       params={"max_patches_per_slide": 4, "stain_normalization": "macenko-v1"})
    _build(fs_id)
    assert during_fit and set(during_fit) <= train, (during_fit, rc["split_of"])
    assert set(during_fit) == set(get_set(fs_id).stain_policy_json["reference_fit"]["train_slide_ids"])


def test_macenko_is_refused_when_the_train_split_is_empty(env, ids):
    from dermpath.errors import ApiError

    rc = real_cohort(ids, n=2, project_id="proj-verify-notrain", ratios={"train": 0.1, "val": 0.45, "test": 0.45})
    assert "train" not in set(rc["split_of"].values()), rc["split_of"]
    with pytest.raises(ApiError) as e:
        create_set(rc["project_id"], encoder_id=HANDCRAFTED, execution_mode="supervised_experiment",
                   dataset_version_id=rc["dataset_version_id"], params={"stain_normalization": "macenko-v1"})
    assert (e.value.status, e.value.code) == (409, "no_train_slides")


# --------------------------------------------------------------------------- memory and streaming


WIDE_ID = "verify-wide-pixels-v1"
WIDE_PS = 64
WIDE_DIM = 4096


def _wide_features(x: np.ndarray) -> np.ndarray:
    """Pixel-exact, deterministic, wide embeddings (an in-memory reference can recompute them)."""
    return (x.reshape(x.shape[0], -1)[:, :WIDE_DIM].astype(np.float32) / 255.0).astype(np.float32)


def _register_wide_encoder(monkeypatch):
    from dermpath.ml import encoders
    from dermpath.ml.encoders import HANDCRAFTED_SPEC, HandcraftedStainTextureEncoder, LoadedEncoder

    spec = dataclasses.replace(HANDCRAFTED_SPEC, id=WIDE_ID, name="verification encoder (wide, pixel-exact)",
                               input_size=WIDE_PS, embedding_dim=WIDE_DIM)

    class Wide(HandcraftedStainTextureEncoder):
        def load(self, *, expected_weights_sha256=None, device="cpu", precision="fp32"):
            ident = self.weights_sha256()
            self._check_expected(self.id, ident, expected_weights_sha256, "expected_weights_sha256")
            return LoadedEncoder(spec=self.spec, weights_sha256=ident, device="cpu", precision="fp32",
                                 embed_fn=_wide_features, runtime={"device": "cpu", "device_class": "cpu",
                                                                   "precision": "fp32"})

    monkeypatch.setitem(encoders.REGISTRY, WIDE_ID, Wide(spec))


def _tiled(side: int, seed: int = 0) -> Image.Image:
    rng = np.random.default_rng(seed)
    tile = np.empty((128, 128, 3), dtype=np.uint8)
    tile[..., 0] = rng.integers(170, 235, (128, 128))
    tile[..., 1] = rng.integers(90, 160, (128, 128))
    tile[..., 2] = rng.integers(140, 210, (128, 128))
    reps = -(-side // 128)
    return Image.fromarray(np.tile(tile, (reps, reps, 1))[:side, :side], "RGB")


def _wide_build_peak(monkeypatch, side: int, slide_id: str) -> tuple[int, int]:
    from dermpath.ml import feature_sets as fsm

    image_slide(monkeypatch, slide_id=slide_id, image=_tiled(side), mpp=0.5)
    fs_id = create_set(CMU_PROJECT, encoder_id=WIDE_ID, execution_mode="real_image_technical", slide_ids=[slide_id],
                       params={"sampling_strategy": "all", "fragment_rescue_min_area_um2": 0})
    snap = get_set(fs_id).input_snapshot_json["slides"][0]
    fsm.otsu_mask(openslide.ImageSlide(fsm._test_images[slide_id]), snap["slide_sha256"])  # warm the mask memo
    tracemalloc.start()
    try:
        tracemalloc.reset_peak()
        _build(fs_id)
        peak = tracemalloc.get_traced_memory()[1]
    finally:
        tracemalloc.stop()
    return peak, items_of(fs_id)[slide_id].stats_json["n_patches"]


def test_build_memory_does_not_grow_with_the_number_of_patches(env, ids, monkeypatch):
    _register_wide_encoder(monkeypatch)
    monkeypatch.setenv("WB_ML_BATCH_SIZE", "16")
    small, n_small = _wide_build_peak(monkeypatch, 1024, "verifymemsmall")
    large, n_large = _wide_build_peak(monkeypatch, 2048, "verifymemlarge")
    assert (n_small, n_large) == (256, 1024)
    grown = (n_large - n_small) * WIDE_DIM * 4  # what holding the embeddings in memory would add
    print(f"\ntracemalloc peak: {small / 1e6:.1f} MB ({n_small} patches) vs {large / 1e6:.1f} MB ({n_large}); "
          f"all embeddings in memory would add {grown / 1e6:.1f} MB")
    assert large - small < 0.15 * grown, (small, large, grown)


def test_streamed_npy_equals_an_in_memory_reference_with_read_rejections(env, ids, monkeypatch):
    from dermpath.ml import feature_sets as fsm

    _register_wide_encoder(monkeypatch)
    monkeypatch.setenv("WB_ML_BATCH_SIZE", "7")  # batches that do not divide the patch count
    arr = np.asarray(_tiled(1024, seed=4)).copy()
    arr[0:300, 512:1024] = 244  # blank glass the (stale) mask calls tissue: rejected at read -> trimmed sink
    img = Image.fromarray(arr)
    sid = image_slide(monkeypatch, slide_id="verifystream01", image=img, mpp=0.5)
    monkeypatch.setattr(fsm, "otsu_mask", lambda o, sha=None: (np.ones((256, 256), dtype=bool),
                                                               {"mask_downsample_x": 4.0, "mask_downsample_y": 4.0}))
    fs_id = create_set(CMU_PROJECT, encoder_id=WIDE_ID, execution_mode="real_image_technical", slide_ids=[sid],
                       params={"sampling_strategy": "spatial", "max_patches_per_slide": 150,
                               "fragment_rescue_min_area_um2": 0})
    _build(fs_id)
    feats = fsm.load_slide_features(fs_id, sid)
    assert isinstance(feats.embeddings, np.memmap)
    rej = items_of(fs_id)[sid].stats_json["rejected_at_read"]["background_at_read"]
    assert rej > 0 and feats.n_patches == 150 - rej
    osr = openslide.ImageSlide(img)
    ref = np.stack([np.asarray(osr.read_region((int(x), int(y)), 0, (WIDE_PS, WIDE_PS)).convert("RGB"))
                    for x, y in feats.coords.tolist()])
    assert np.array_equal(np.asarray(feats.embeddings), _wide_features(ref))
    order = np.lexsort((feats.coords[:, 0], feats.coords[:, 1]))
    assert np.array_equal(order, np.arange(len(order)))  # rows follow the candidate order (y, x)


def test_embedding_sink_trims_exactly_across_its_copy_chunks(tmp_path):
    from dermpath.ml.feature_sets import _EmbeddingSink

    rng = np.random.default_rng(1)
    parts = [rng.normal(size=(n, 3)).astype(np.float32) for n in (1, 4095, 4097, 3, 8000, 2)]
    sink = _EmbeddingSink(tmp_path, capacity=20000, dim=3)
    for p in parts:
        sink.write(p)
    out = np.load(sink.finalise(), mmap_mode="r")
    ref = np.concatenate(parts)
    assert out.shape == (16198, 3) and out.dtype == np.float32 and np.array_equal(np.asarray(out), ref)


# --------------------------------------------------------------------------- coverage diagnostics


def test_cmu_coverage_diagnostics_are_internally_consistent(env, ids, clients):
    from dermpath.db import session_scope
    from dermpath.ml import feature_sets as fsm
    from dermpath.ml.models import FeatureArtifact

    sid = cmu_slide_id(ids)
    asst = clients("user-assistant")
    region = {"type": "rectangle", "x": 1120.0, "y": 672.0, "width": 300.0, "height": 500.0}
    issue = asst.post(f"/api/v1/slides/{sid}/qc/issues", json={"category": "fold", "region": region}).json()
    asst.patch(f"/api/v1/qc/issues/{issue['id']}", json={"action": "review", "confirmed": True})
    r = asst.patch(f"/api/v1/qc/issues/{issue['id']}", json={
        "action": "resolve", "resolution": "excluded", "dataset_eligibility_effect": "exclude_region",
        "reason": "fold (test)"})
    assert r.status_code == 200, r.text
    fs_id = create_set(CMU_PROJECT, encoder_id=HANDCRAFTED, execution_mode="real_image_technical", slide_ids=[sid],
                       params={"max_patches_per_slide": 16})
    _build(fs_id)
    item = items_of(fs_id)[sid]
    with session_scope() as db:
        art = db.get(FeatureArtifact, item.artifact_id)
        full, summary, st = dict(art.coverage_json), dict(item.coverage_json), dict(item.stats_json)
        d = fsm.feature_set_dict(db, get_set(fs_id))
    for k, v in summary.items():
        if k != "version":
            assert full.get(k) == v, k
    areas = ("tissue_area_um2", "candidate_tissue_area_um2", "sampled_tissue_area_um2", "excluded_area_um2",
             "excluded_tissue_area_um2", "edge_uncovered_tissue_area_um2")
    for k in areas:
        assert full[k] is not None and full[k] >= 0, k
    for k in ("candidate_tissue_fraction", "sampled_tissue_fraction", "tissue_within_radius_of_sample_fraction"):
        assert 0.0 <= full[k] <= 1.0, k
    assert full["excluded_area_um2"] > 0 and full["excluded_tissue_area_um2"] > 0
    assert full["sampled_tissue_area_um2"] <= full["candidate_tissue_area_um2"] <= full["tissue_area_um2"]
    assert full["excluded_tissue_area_um2"] <= min(full["excluded_area_um2"], full["tissue_area_um2"])
    assert full["sampled_tissue_fraction"] <= full["candidate_tissue_fraction"]
    assert full["edge_uncovered_tissue_area_um2"] == 0
    assert full["n_sampled"] == st["n_patches"] == art.n_patches <= full["n_sampled_before_read_filters"]
    assert full["n_sampled_before_read_filters"] == st["n_sampled"] == 16 <= full["n_candidates"] == st["n_candidates"]
    assert 0 <= full["fragments_without_candidate"] <= full["fragments_total"] <= full["components_total"]
    assert full["fragments_rescued"] == full["candidate_origins"]["fragment_rescue"]
    assert sum(full["sampled_origins"].values()) == full["n_sampled"]
    assert full["radius_um"] == pytest.approx(full["patch_side_um"][0], abs=1e-3)
    assert full["mask_um_per_px"][0] > 0 and full["calibrated"] is True
    cov = d["coverage"]
    row = cov["per_slide"][0]
    assert cov["total_patches"] == st["n_patches"] and row["n_patches"] == st["n_patches"]
    assert row["sampled_tissue_fraction"] == summary["sampled_tissue_fraction"]
    assert cov["rejected_at_read"] == {k: int(v) for k, v in summary["rejected_at_read"].items()}
    # No embedded patch touches the excluded rectangle (exact geometry).
    feats = fsm.load_slide_features(fs_id, sid)
    assert not P.cells_hit_regions(feats.coords, (PS, PS), [region]).any()


def test_excluded_area_uses_the_same_pixel_rule_as_candidate_coverage():
    """coverage.py: "a mask pixel counts as covered by a patch when its CENTRE lies inside the patch rectangle".
    Excluded regions must be measured with that rule too, so excluded and candidate-covered tissue never overlap
    and an excluded area is not overstated."""
    pol = P.PatchPolicy(fragment_rescue_min_area_um2=None)
    plan = P.plan_scale(mpp_x=0.5, mpp_y=0.5, level_downsamples=[1.0], policy=pol)  # extent 224
    mask = np.ones((224, 448), dtype=bool)  # mask px = 4 level-0 px = 2 µm; slide 1792 x 896
    region = {"type": "rectangle", "x": 448.0, "y": 0.0, "width": 448.0, "height": 448.0}  # 224 x 224 µm exactly
    c = P.candidate_grid((1792, 896), plan, mask, (4.0, 4.0), [region], pol)
    assert not P.cells_hit_regions(c.coords, plan.extent, [region]).any()
    cv = coverage(dims=(1792, 896), plan=plan, mask=mask, mask_ds=(4.0, 4.0), candidates=c, excluded=[region],
                  policy=pol)
    exact_um2 = 448 * 0.5 * 448 * 0.5
    px2 = cv["areas_level0_px2"]
    overlap_px2 = px2["candidate"] - cv["candidate_tissue_fraction"] * (px2["tissue"] - px2["excluded_tissue"])
    # Same quantities on the real CMU fixture with an exclusion abutting candidate cells.
    osr = openslide.OpenSlide(str(CMU))
    cmask, ms = P.otsu_mask(osr, None)
    cds = (ms["mask_downsample_x"], ms["mask_downsample_y"])
    cplan = P.plan_scale(mpp_x=CMU_MPP, mpp_y=CMU_MPP, level_downsamples=[1.0], policy=pol)
    cregion = {"type": "rectangle", "x": 1344.01, "y": 2016.0, "width": 300.0, "height": 224.0}
    cc = P.candidate_grid(osr.dimensions, cplan, cmask, cds, [cregion], pol)
    ccv = coverage(dims=osr.dimensions, plan=cplan, mask=cmask, mask_ds=cds, candidates=cc, excluded=[cregion],
                   policy=pol)
    osr.close()
    cpx = ccv["areas_level0_px2"]
    c_overlap = cpx["candidate"] - ccv["candidate_tissue_fraction"] * (cpx["tissue"] - cpx["excluded_tissue"])
    assert cv["excluded_area_um2"] == pytest.approx(exact_um2, rel=1e-6) and overlap_px2 < 1 and c_overlap < 50, (
        f"synthetic: excluded_area_um2 {cv['excluded_area_um2']} for an exact {exact_um2} µm² rectangle; "
        f"candidate-covered tissue also counted as excluded: {overlap_px2:.0f} level-0 px² (synthetic), "
        f"{c_overlap:.0f} level-0 px² on CMU")


# --------------------------------------------------------------------------- refusals through the API


def test_uncalibrated_slides_are_refused_in_supervised_mode(env, ids, clients):
    from dermpath.db import session_scope
    from dermpath.errors import ApiError
    from dermpath.ml.feature_sets import ModeMismatch
    from dermpath.models import Slide

    rc = real_cohort(ids, n=4, project_id="proj-verify-uncal", uncalibrated=(0,))
    with pytest.raises(ModeMismatch):
        create_set(rc["project_id"], encoder_id=HANDCRAFTED, execution_mode="supervised_experiment",
                   dataset_version_id=rc["dataset_version_id"])
    with pytest.raises(ApiError) as e:
        create_set(rc["project_id"], encoder_id=HANDCRAFTED, execution_mode="supervised_experiment",
                   dataset_version_id=rc["dataset_version_id"], params={"allow_uncalibrated": True})
    assert e.value.status in (409, 422)
    # Technical mode: refused unless explicitly allowed (then labelled uncalibrated).
    with pytest.raises(ApiError) as e:
        create_set(rc["project_id"], encoder_id=HANDCRAFTED, execution_mode="real_image_technical",
                   slide_ids=rc["slide_ids"])
    assert (e.value.status, e.value.code) == (422, "scale_refused")
    assert e.value.details["slides"][0]["reason"] == "uncalibrated"
    # A partially calibrated slide (one axis only) still counts as uncalibrated.
    with session_scope() as db:
        s = db.get(Slide, rc["slide_ids"][0])
        s.mpp_x, s.mpp_y = CMU_MPP, None
    with pytest.raises(ModeMismatch) as e:
        create_set(rc["project_id"], encoder_id=HANDCRAFTED, execution_mode="supervised_experiment",
                   dataset_version_id=rc["dataset_version_id"])
    assert rc["slide_ids"][0] in e.value.message
    # The supervised experiment API (feature set created or reused there) refuses the same cohort.
    r = clients(LEAD_ID).post(f"/api/v1/projects/{rc['project_id']}/experiments", json={
        "dataset_version_id": rc["dataset_version_id"], "encoder_id": HANDCRAFTED, "head": "meanpool_logreg",
        "seed": 0, "params": {"max_patches_per_slide": 4}})
    assert r.status_code == 409 and r.json()["error"]["code"] == "mode_mismatch", r.text


def test_coarse_scan_is_refused_by_the_feature_set_api(env, ids, clients):
    from dermpath.db import session_scope
    from dermpath.models import Slide

    sid = cmu_slide_id(ids)
    with session_scope() as db:  # a 10x scan (1.0 µm/px): reading 0.5 µm/px patches would upsample 2x
        s = db.get(Slide, sid)
        s.mpp_x = s.mpp_y = 1.0
    r = clients(LEAD_ID).post(f"/api/v1/projects/{CMU_PROJECT}/feature-sets", json={
        "encoder_id": HANDCRAFTED, "execution_mode": "real_image_technical", "slide_ids": [sid]})
    assert r.status_code == 422, r.text
    err = r.json()["error"]
    assert err["code"] == "scale_refused" and err["details"]["slides"][0]["reason"] == "would_upsample"


def test_coarse_scan_is_refused_by_the_legacy_slide_features_endpoint(env, ids, clients):
    """POST /slides/{id}/features (legacy, still mounted) must not silently upsample a coarse scan either."""
    from dermpath.db import session_scope
    from dermpath.jobs.worker import Worker
    from dermpath.ml.models import FeatureArtifact
    from dermpath.models import Slide
    from sqlalchemy import select

    sid = cmu_slide_id(ids)
    with session_scope() as db:
        s = db.get(Slide, sid)
        s.mpp_x = s.mpp_y = 1.0
    r = clients(LEAD_ID).post(f"/api/v1/slides/{sid}/features", json={"encoder_id": HANDCRAFTED})
    if r.status_code >= 400:
        return  # refused at the request: the guarantee holds
    out = Worker("verify-legacy", types=["extract_features"]).run_until_idle()
    with session_scope() as db:
        arts = db.scalars(select(FeatureArtifact).where(FeatureArtifact.slide_id == sid)).all()
        made = [(a.id, a.scale_key, a.patch_size, a.n_patches, a.calibrated) for a in arts]
    assert [o.status for o in out] == ["failed"] and not made, (
        f"request {r.status_code}; job outcomes {[(o.status, o.error) for o in out]}; artifacts written from a "
        f"1.0 µm/px scan at target 0.5 µm/px (112 level-0 px read, resized to 224: 2x upsampling): {made}")
