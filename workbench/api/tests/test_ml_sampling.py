"""Patch sampling (dermpath.sampling/1): policy validation, determinism and version stability,
the recorded safety cap of ``all``, spatial stratification (equal inclusion, never worse coverage
than uniform on the CMU fixture across seeds), the sampling seed's independence from training,
and lesion-aware refusal without permitted train-split expert regions."""

from __future__ import annotations

import inspect

import numpy as np
import openslide
import pytest

from dermpath.config import FIXTURES_DIR
from dermpath.ml import patching as P
from dermpath.ml import sampling as S
from dermpath.ml.coverage import coverage

CMU = FIXTURES_DIR / "CMU-1-Small-Region.svs"


@pytest.fixture(scope="module")
def cmu_candidates():
    osr = openslide.OpenSlide(str(CMU))
    mask, ms = P.otsu_mask(osr, None)
    ds = (ms["mask_downsample_x"], ms["mask_downsample_y"])
    out = {}
    for name, pol in (("default", P.PatchPolicy()), ("stride_half", P.PatchPolicy(stride_fraction=0.5))):
        plan = P.plan_scale(mpp_x=0.499, mpp_y=0.499, level_downsamples=[1.0], policy=pol)
        out[name] = (P.candidate_grid(osr.dimensions, plan, mask, ds, [], pol), pol)
    yield osr.dimensions, mask, ds, out
    osr.close()


class Grid:
    """A bare candidate set: an n x n grid of 10-px cells."""

    def __init__(self, n=10, ext=10):
        self.coords = np.array([[x * ext, y * ext] for y in range(n) for x in range(n)], dtype=np.int64)
        self.extent = (ext, ext)


def test_policy_validation_and_json():
    sp = S.SamplingPolicy()
    assert (sp.strategy, sp.max_patches, sp.seed) == ("spatial", 64, 0)
    assert S.SamplingPolicy.from_json(sp.to_json()) == sp and sp.to_json()["version"] == S.SAMPLING_VERSION
    assert S.SamplingPolicy(strategy="all", max_patches=10).max_patches is None  # canonical: "all" has no bound
    assert S.SamplingPolicy(max_patches=16.0) == S.SamplingPolicy(max_patches=16)
    for bad in ({"strategy": "random"}, {"max_patches": 0}, {"strategy": "uniform", "max_patches": None},
                {"seed": -1}, {"lesion_fraction": 1.5}, {"all_safety_cap": 0}, {"max_patches": 2.5}):
        with pytest.raises(S.SamplingError):
            S.SamplingPolicy(**bad)


def test_seeded_ranks_are_version_stable():
    """Pinned values: the rank is sha256-based, so it cannot drift with a NumPy upgrade."""
    r = S.seeded_ranks(np.array([[0, 0], [224, 448]]), seed=0)
    assert r.dtype == np.uint64
    again = S.seeded_ranks(np.array([[0, 0], [224, 448]]), seed=0)
    assert np.array_equal(r, again)
    import hashlib

    expected = int.from_bytes(hashlib.sha256(b"dermpath.sampling/1|0||224|448").digest()[:8], "little")
    assert int(r[1]) == expected
    assert not np.array_equal(r, S.seeded_ranks(np.array([[0, 0], [224, 448]]), seed=1))
    assert not np.array_equal(r, S.seeded_ranks(np.array([[0, 0], [224, 448]]), seed=0, salt="slide-sha"))


@pytest.mark.parametrize("strategy", ["uniform", "spatial"])
def test_deterministic_and_seed_dependent(cmu_candidates, strategy):
    _, _, _, cands = cmu_candidates
    c, pol = cands["default"]
    sp = S.SamplingPolicy(strategy=strategy, max_patches=16, seed=3)
    a, sa = S.sample(c, pol.replace(sampling=sp))
    b, sb = S.sample(c, sp)  # a SamplingPolicy or a PatchPolicy carrying it: same result
    assert np.array_equal(a, b) and sa == sb and a.shape == (16, 2) and sa["saturated"] is True
    assert np.array_equal(a, a[np.lexsort((a[:, 0], a[:, 1]))])  # ordered by (y, x)
    assert {tuple(r) for r in a.tolist()} <= {tuple(r) for r in c.coords.tolist()}
    other, _ = S.sample(c, S.SamplingPolicy(strategy=strategy, max_patches=16, seed=4))
    salted, _ = S.sample(c, sp, salt="another-slide")
    assert not np.array_equal(a, other) and not np.array_equal(a, salted)


def test_sampling_seed_is_independent_of_training_seed():
    # The only randomness is SamplingPolicy.seed (and the optional salt): no training seed enters.
    assert list(inspect.signature(S.sample).parameters) == ["candidates", "policy", "permitted_lesion_regions", "salt"]
    pol = P.PatchPolicy(sampling=S.SamplingPolicy(strategy="uniform", max_patches=5, seed=11))
    g = Grid()
    assert np.array_equal(S.sample(g, pol)[0], S.sample(g, pol)[0])
    assert pol.to_json()["sampling"]["seed"] == 11  # recorded in the policy (and its sha)


def test_all_strategy_safety_cap_is_recorded():
    g = Grid(n=10)
    coords, st = S.sample(g, S.SamplingPolicy(strategy="all"))
    assert coords.shape == (100, 2) and st["safety_cap"] == {"cap": S.DEFAULT_ALL_SAFETY_CAP, "applied": False, "dropped": 0}
    capped, st = S.sample(g, S.SamplingPolicy(strategy="all", all_safety_cap=30))
    assert capped.shape == (30, 2) and st["saturated"] is True
    assert st["safety_cap"] == {"cap": 30, "applied": True, "dropped": 70, "fill_rule": "uniform_rank"}


def test_small_and_empty_candidate_sets():
    g = Grid(n=3)
    coords, st = S.sample(g, S.SamplingPolicy(strategy="spatial", max_patches=64))
    assert coords.shape == (9, 2) and st["saturated"] is False and st["selected"] == 9

    class Empty:
        coords = np.zeros((0, 2), dtype=np.int64)
        extent = (10, 10)

    coords, st = S.sample(Empty(), S.SamplingPolicy())
    assert coords.shape == (0, 2) and st["selected"] == 0


def test_spatial_strata_spread_and_equal_inclusion():
    g = Grid(n=10)  # 100 cells
    coords, st = S.sample(g, S.SamplingPolicy(strategy="spatial", max_patches=4, seed=0))
    assert st["algorithm"] == "kd_strata_seeded_pick"
    quadrants = {(int(x >= 50), int(y >= 50)) for x, y in coords.tolist()}
    assert quadrants == {(0, 0), (0, 1), (1, 0), (1, 1)}  # one pick per compact stratum
    counts = np.zeros(100)
    for seed in range(300):
        idx, _ = S.select_indices(g, S.SamplingPolicy(strategy="spatial", max_patches=10, seed=seed))
        counts[idx] += 1
    # Equal strata (10 cells each) with a seeded pick: every cell is chosen with probability 1/10.
    assert counts.sum() == 3000 and counts.min() >= 12 and counts.max() <= 52  # expected 30 each


def test_spatial_coverage_never_below_uniform_on_cmu(cmu_candidates):
    """Minimum (over seeds) tissue fraction within one patch side of a sampled patch: spatial >= uniform.

    Measured with this code (20 seeds; mean/min): 58 candidates, k=16: uniform 0.866/0.777,
    spatial 0.948/0.907; 215 candidates (stride 0.5), k=32: uniform 0.969/0.908, spatial 0.995/0.986.
    """
    dims, mask, ds, cands = cmu_candidates
    for name, k in (("default", 16), ("stride_half", 32)):
        c, pol = cands[name]
        res = {}
        for strategy in ("uniform", "spatial"):
            vals = []
            for seed in range(8):
                coords, _ = S.sample(c, S.SamplingPolicy(strategy=strategy, max_patches=k, seed=seed))
                cv = coverage(dims=dims, plan=c.plan, mask=mask, mask_ds=ds, candidates=c, sampled=coords, policy=pol)
                vals.append(cv["tissue_within_radius_of_sample_fraction"])
            res[strategy] = vals
        assert min(res["spatial"]) >= min(res["uniform"]), (name, res)
        assert np.mean(res["spatial"]) >= np.mean(res["uniform"]), (name, res)


def _lesion_region(split="train", source="expert_annotation"):
    return {"region": {"type": "rectangle", "x": 0, "y": 0, "width": 30, "height": 30}, "split": split,
            "source": source, "annotation_id": "a1"}


def test_lesion_aware_refuses_without_permitted_train_expert_regions():
    g = Grid(n=10)
    sp = S.SamplingPolicy(strategy="lesion_aware", max_patches=10)
    for regions in (None, []):
        with pytest.raises(S.SamplingError) as e:
            S.sample(g, sp, permitted_lesion_regions=regions)
        assert e.value.reason == "lesion_aware_requires_permitted_regions"
    for split in ("val", "test", None):
        with pytest.raises(S.SamplingError) as e:
            S.sample(g, sp, permitted_lesion_regions=[_lesion_region(split=split)])
        assert e.value.reason == "lesion_region_not_train"
    with pytest.raises(S.SamplingError) as e:
        S.sample(g, sp, permitted_lesion_regions=[_lesion_region(source="model_prediction")])
    assert e.value.reason == "lesion_region_not_expert"
    with pytest.raises(S.SamplingError) as e:  # regions are never silently used by another strategy
        S.sample(g, S.SamplingPolicy(strategy="spatial", max_patches=10), permitted_lesion_regions=[_lesion_region()])
    assert e.value.reason == "permitted_regions_unused"


def test_lesion_aware_spends_its_budget_in_permitted_regions():
    g = Grid(n=10)  # the region covers the 3 x 3 cells at the top-left
    coords, st = S.sample(g, S.SamplingPolicy(strategy="lesion_aware", max_patches=10, lesion_fraction=0.5),
                          permitted_lesion_regions=[_lesion_region()])
    les = st["lesion"]
    assert coords.shape == (10, 2) and les["experimental"] is True and "train-split" in les["note"]
    assert les["candidates_in_regions"] == 9 and les["budget_in_regions"] == 5 and les["selected_in_regions"] >= 5
    inside = (coords[:, 0] < 30) & (coords[:, 1] < 30)
    assert inside.sum() == les["selected_in_regions"]
    again, _ = S.sample(g, S.SamplingPolicy(strategy="lesion_aware", max_patches=10, lesion_fraction=0.5),
                        permitted_lesion_regions=[_lesion_region()])
    assert np.array_equal(coords, again)
