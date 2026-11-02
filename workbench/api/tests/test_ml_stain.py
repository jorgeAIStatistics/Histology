"""Stain normalisation (dermpath.stain/1): none and macenko-v1. Recovery of known stain vectors,
normalisation of a stain-shifted copy, determinism, the train-only reference fit (it uses only
the patches passed and refuses validation or test patches), versioned policy JSON and sha."""

from __future__ import annotations

import numpy as np
import openslide
import pytest

from dermpath.config import FIXTURES_DIR
from dermpath.ml import patching as P
from dermpath.ml import stain as ST

CMU = FIXTURES_DIR / "CMU-1-Small-Region.svs"


def _unit(v):
    v = np.asarray(v, dtype=np.float64)
    return v / np.linalg.norm(v)


HE_A = np.stack([_unit([0.65, 0.70, 0.29]), _unit([0.07, 0.99, 0.11])], axis=1)  # columns H, E
HE_B = np.stack([_unit([0.50, 0.78, 0.38]), _unit([0.16, 0.94, 0.30])], axis=1)  # a different lab's stain


def _concentrations(n=6, size=64, seed=0):
    rng = np.random.default_rng(seed)  # test data only
    kind = rng.integers(0, 3, size=(n, size, size))  # background, haematoxylin-rich, eosin-rich
    c = np.zeros((n, size, size, 2))
    h, e = kind == 1, kind == 2
    c[h, 0], c[h, 1] = rng.uniform(0.4, 1.6, h.sum()), rng.uniform(0.0, 0.3, h.sum())
    c[e, 1], c[e, 0] = rng.uniform(0.4, 1.2, e.sum()), rng.uniform(0.0, 0.3, e.sum())
    return c


def _render(conc, he, scale=1.0):
    od = (conc * scale) @ he.T
    return np.clip(np.rint(256.0 * np.exp(-od) - 1.0), 0, 255).astype(np.uint8)


def test_macenko_recovers_known_stain_vectors():
    ref = ST.fit_reference(_render(_concentrations(), HE_A), splits="train")
    m = ref.matrix()
    assert m.shape == (3, 2) and ref.role == "reference" and ref.n_patches == 6
    assert float(m[:, 0] @ HE_A[:, 0]) > 0.99 and float(m[:, 1] @ HE_A[:, 1]) > 0.99  # cosine similarity
    assert m[0, 0] > m[0, 1]  # haematoxylin is the vector with the larger red OD


def test_macenko_normalises_a_stain_shifted_copy():
    conc = _concentrations(seed=1)
    a = _render(conc, HE_A)
    b = _render(conc, HE_B, scale=0.75)  # other stain vectors, paler
    ref = ST.fit_reference(a, splits=["train"] * len(a))
    src = ST.fit_source(b)
    assert src.role == "source" and float(src.matrix()[:, 0] @ HE_B[:, 0]) > 0.99
    out, stats = ST.apply_with_stats(b, ref, source=src)
    before = np.abs(b.astype(int) - a).mean()
    after = np.abs(out.astype(int) - a).mean()
    assert after < 0.3 * before and after < 6, (before, after)
    assert stats["source"] == "per_slide" and stats["source_sha256"] == src.sha256
    white = np.full((1, 64, 64, 3), 255, np.uint8)
    assert (ST.apply(white, ref, source=src) == 255).all()  # white maps to white
    out_pp, st_pp = ST.apply_with_stats(np.concatenate([b, white]), ref)  # per-patch mode
    assert st_pp["unchanged_insufficient_tissue_or_degenerate"] == 1 and (out_pp[-1] == 255).all()


def test_fit_and_apply_are_deterministic():
    a = _render(_concentrations(seed=2), HE_A)
    r1, r2 = ST.fit_reference(a), ST.fit_reference(a)
    assert r1 == r2 and r1.sha256 == r2.sha256 and len(r1.sha256) == 64
    assert ST.MacenkoReference.from_json(r1.to_json()) == r1
    b = _render(_concentrations(seed=3), HE_B)
    src = ST.fit_source(b)
    assert np.array_equal(ST.apply(b, r1, source=src), ST.apply(b, r1, source=src))
    assert np.array_equal(ST.apply(b, r1), ST.apply(b, r1))
    # Batches streamed through an iterable give the same reference as one array.
    assert ST.fit_reference(iter([a[:2], a[2:]])) == r1


def test_reference_is_fitted_only_on_the_train_patches_passed():
    train = _render(_concentrations(seed=4), HE_A)
    val = _render(_concentrations(seed=5), HE_B, scale=0.7)
    ref = ST.fit_reference(train, splits="train")
    assert ref.n_patches == len(train) and ref.to_json()["fitted_on"] == "train-split patches only"
    ST.fit_reference(val)  # fitting something else in between leaves no hidden state behind
    assert ST.fit_reference(train, splits="train") == ref
    assert ST.fit_reference(np.concatenate([train, val])) != ref  # other images would change it: never pass them
    for splits in ("val", "test", ["train"] * 5 + ["val"]):
        with pytest.raises(ST.StainError) as e:
            ST.fit_reference(train, splits=splits)
        assert e.value.reason == "fit_on_non_train_split"
    with pytest.raises(ST.StainError) as e:
        ST.fit_reference(train, splits=["train"] * 3)
    assert e.value.reason == "splits_length_mismatch"
    with pytest.raises(ST.StainError) as e:
        ST.fit_reference(np.full((2, 16, 16, 3), 255, np.uint8))
    assert e.value.reason == "no_tissue_pixels"


def test_stain_policy_versioning_and_refusals():
    none = ST.StainPolicy.none()
    batch = _render(_concentrations(n=1), HE_A)
    assert ST.normalise(batch, none) is batch
    assert none.to_json() == {"version": ST.STAIN_VERSION, "method": "none", "reference": None, "reference_sha256": None}
    ref = ST.fit_reference(_render(_concentrations(seed=6), HE_A))
    mac = ST.StainPolicy.macenko(ref)
    assert mac.source_estimate == "per_slide" and mac.to_json()["reference_sha256"] == ref.sha256
    assert ST.StainPolicy.from_json(mac.to_json()) == mac
    shas = {none.policy_sha256, mac.policy_sha256, ST.StainPolicy.macenko(ref, source_estimate="per_patch").policy_sha256,
            ST.StainPolicy.macenko(ST.fit_reference(_render(_concentrations(seed=7), HE_B))).policy_sha256}
    assert len(shas) == 4  # any change of method, mode or reference is a new feature set
    with pytest.raises(ST.StainError, match="source_required"):
        ST.normalise(batch, mac)
    assert ST.normalise(batch, ST.StainPolicy.macenko(ref, source_estimate="per_patch")).shape == batch.shape
    tampered = mac.to_json()
    tampered["reference_sha256"] = "0" * 64
    with pytest.raises(ST.StainError, match="reference_sha_mismatch"):
        ST.StainPolicy.from_json(tampered)
    src = ST.fit_source(batch)
    with pytest.raises(ST.StainError, match="not_a_reference"):
        ST.StainPolicy.macenko(src)
    with pytest.raises(ST.StainError, match="not_a_source"):
        ST.apply(batch, ref, source=ref)
    with pytest.raises(ST.StainError, match="reference_required"):
        ST.StainPolicy(method="macenko-v1")
    with pytest.raises(ST.StainError, match="unknown_method"):
        ST.StainPolicy(method="reinhard")


def test_macenko_on_cmu_patches_per_slide_beats_per_patch():
    """Measured on the fixture: self-normalisation changes pixels by about 6.6 grey levels per channel
    with a per-slide source estimate and about 16.6 with per-patch estimates (ideal: 0)."""
    osr = openslide.OpenSlide(str(CMU))
    try:
        mask, ms = P.otsu_mask(osr, None)
        pol = P.PatchPolicy()
        plan = P.plan_scale(mpp_x=0.499, mpp_y=0.499, level_downsamples=[1.0], policy=pol)
        c = P.candidate_grid(osr.dimensions, plan, mask, (ms["mask_downsample_x"], ms["mask_downsample_y"]), [], pol)
        patches = np.concatenate([pb for _, pb, _ in P.iter_patch_batches(osr, c, plan, batch_size=32, policy=pol)])
    finally:
        osr.close()
    ref = ST.fit_reference(patches, splits="train")
    per_slide = np.abs(ST.apply(patches, ref, source=ST.fit_source(patches)).astype(int) - patches).mean()
    per_patch = np.abs(ST.apply(patches, ref).astype(int) - patches).mean()
    assert per_slide < 8 and per_patch > 2 * per_slide, (per_slide, per_patch)
