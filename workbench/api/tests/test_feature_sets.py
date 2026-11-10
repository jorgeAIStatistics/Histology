"""Frozen feature sets (design §5): idempotent creation, execution-mode refusals, frozen input
snapshots, resumable label-free builds, determinism on the real CMU fixture, coverage
aggregation, train-only stain references, and the synthetic pipeline-test path.

Real-pixel tests use the CC0 CMU-1-Small-Region fixture (and byte variants of it) with the
handcrafted encoder: a technical baseline, not a pathology model. Nothing here measures
diagnostic performance."""

from __future__ import annotations

import numpy as np
import pytest
from sqlalchemy import event

from feature_set_support import (
    CMU_PROJECT,
    HANDCRAFTED,
    SYNTH,
    cmu_slide_id,
    create_set,
    get_set,
    items_of,
    real_cohort,
)
from test_ml_support import CID, cohort

FAST = {"max_patches_per_slide": 12}


def _build(fs_id: str) -> dict:
    from dermpath.ml.feature_sets import build_feature_set

    return build_feature_set(fs_id)


def _plan(fs_id: str):
    from dermpath.db import session_scope
    from dermpath.ml import feature_sets as fsm

    with session_scope() as db:
        return fsm._plan_of(db, db.get(fsm.FeatureSet, fs_id))


def _recompute(fs_id: str, slide_id: str):
    """Extract one slide of a set again, bypassing the cache and the store."""
    from dermpath.ml import feature_sets as fsm

    plan = _plan(fs_id)
    loaded = None if plan.encoder_spec.synthetic else fsm.load_encoder(
        plan.encoder_id, weights_sha256=plan.weights_sha256, encoder_spec_sha256=plan.encoder_spec_sha256,
        device="cpu", precision="fp32")
    return fsm._extract(plan.snapshots[slide_id], project_id=plan.project_id, encoder_id=plan.encoder_id,
                        encoder_spec=plan.encoder_spec, encoder_spec_sha256=plan.encoder_spec_sha256,
                        weights_sha256=plan.weights_sha256, weights_config_sha256=None,
                        encoder_config=plan.encoder_config, loaded=loaded, patch_policy=plan.patch_policy,
                        stain_policy=fsm._effective_stain(plan), device="cpu", precision="fp32",
                        env_sha256=plan.env_sha256, extraction=plan.extraction, use_cache=False, store=False)


# --------------------------------------------------------------------------- creation


def test_creation_is_idempotent_and_the_snapshot_holds_no_label(env, ids):
    rc = real_cohort(ids, n=4)
    kw = dict(encoder_id=HANDCRAFTED, execution_mode="supervised_experiment",
              dataset_version_id=rc["dataset_version_id"], params=FAST)
    a = create_set(rc["project_id"], **kw)
    b = create_set(rc["project_id"], **kw, name="another name, same specification")
    assert a == b
    # Head / protocol params do not change the feature specification.
    assert create_set(rc["project_id"], **{**kw, "params": {**FAST, "C": 3.0, "lr": 0.1, "seed": 9}}) == a
    # The sampling seed is part of it (and independent of any training seed).
    c = create_set(rc["project_id"], **{**kw, "params": {**FAST, "sampling_seed": 1}})
    assert c != a
    fs = get_set(a)
    assert fs.status == "building" and fs.execution_mode == "supervised_experiment"
    assert set(items_of(a)) == set(rc["slide_ids"])  # every split, test included
    snaps = fs.input_snapshot_json["slides"]
    assert fs.input_snapshot_json["qc_source"] == "dataset_manifest"
    text = repr(fs.input_snapshot_json).lower()
    assert "label" not in text and "bcc_" not in text and "split" not in text
    for s in snaps:
        assert {"slide_sha256", "object_key", "mpp_x", "mpp_y", "width", "height", "level_downsamples",
                "qc_review_id", "mask_object_key", "mask_sha256", "mask_downsample", "excluded_issue_ids",
                "excluded_regions_sha256"} <= set(s)
    # Identity columns.
    from dermpath.ml.encoders import get_encoder

    adapter = get_encoder(HANDCRAFTED)
    assert fs.encoder_spec_sha256 == adapter.spec.spec_sha256()
    assert fs.weights_sha256 == adapter.weights_sha256() and fs.weights_sha256.startswith("handcrafted:")
    assert fs.extraction_env_json["device_class"] == "cpu" and fs.extraction_env_json["precision"] == "fp32"
    assert fs.patch_policy_json["patch_size"] == 224 and fs.patch_policy_json["min_tissue_fraction"] == 0.25
    assert fs.patch_policy_json["sampling"]["strategy"] == "spatial"
    assert fs.encoder_spec_json["extraction"]["batch_size"] == 32


def test_manifest_qc_snapshot_matches_dataset_qc_definitions(env, ids):
    """The snapshot's excluded-regions sha uses the same definition as datasets.qc_snapshot."""
    from dermpath.datasets import qc_snapshot
    from dermpath.db import session_scope
    from dermpath.ml.feature_sets import live_qc

    sid = cmu_slide_id(ids)
    with session_scope() as db:
        mine, theirs = live_qc(db, sid), qc_snapshot(db, sid)
    for k in ("qc_review_id", "mask_object_key", "mask_sha256", "excluded_regions_sha256"):
        assert mine[k] == theirs[k], k
    assert mine["excluded_issue_ids"] == theirs["excluded_region_issue_ids"]
    assert mine["mask_downsample"] and mine["mask_sha256"]


@pytest.mark.parametrize("case", ["synthetic_encoder_on_real", "synthetic_mode_on_real", "real_encoder_on_demo",
                                  "supervised_on_synthetic_dataset", "supervised_uncalibrated",
                                  "supervised_allow_uncalibrated", "synthetic_mode_real_encoder",
                                  "supervised_without_dataset"])
def test_mode_refusals(env, ids, case):
    from dermpath.ml.feature_sets import ModeMismatch

    cmu = [cmu_slide_id(ids)]
    synth_slides = [ids["slides"]["p1_a1_l1"]]
    calls = {
        "synthetic_encoder_on_real": dict(project=CMU_PROJECT, encoder_id=SYNTH, execution_mode="real_image_technical",
                                          slide_ids=cmu),
        "synthetic_mode_on_real": dict(project=CMU_PROJECT, encoder_id=SYNTH, execution_mode="synthetic_pipeline_test",
                                       slide_ids=cmu),
        "real_encoder_on_demo": dict(project=CMU_PROJECT, encoder_id=HANDCRAFTED,
                                     execution_mode="real_image_technical", slide_ids=synth_slides),
        "supervised_on_synthetic_dataset": dict(project=CID, encoder_id=HANDCRAFTED,
                                                execution_mode="supervised_experiment",
                                                dataset_version_id=cohort(ids)["dataset_version_id"]),
        "synthetic_mode_real_encoder": dict(project=CID, encoder_id=HANDCRAFTED,
                                            execution_mode="synthetic_pipeline_test",
                                            dataset_version_id=cohort(ids)["dataset_version_id"]),
        "supervised_without_dataset": dict(project=CMU_PROJECT, encoder_id=HANDCRAFTED,
                                           execution_mode="supervised_experiment", slide_ids=cmu),
    }
    if case in ("supervised_uncalibrated", "supervised_allow_uncalibrated"):
        rc = real_cohort(ids, n=4, uncalibrated=(1,) if case == "supervised_uncalibrated" else ())
        calls[case] = dict(project=rc["project_id"], encoder_id=HANDCRAFTED, execution_mode="supervised_experiment",
                           dataset_version_id=rc["dataset_version_id"],
                           params={"allow_uncalibrated": True} if case == "supervised_allow_uncalibrated" else None)
    kw = dict(calls[case])
    project = kw.pop("project")
    with pytest.raises(ModeMismatch) as err:
        create_set(project, **kw)
    assert err.value.status == 409 and err.value.code == "mode_mismatch"
    if case == "supervised_uncalibrated":
        assert "rfslide001" in err.value.message and "calibrated" in err.value.message


def test_policy_parameters_are_validated(env, ids):
    from dermpath.ml.feature_sets import InvalidFeatureParams

    cmu = [cmu_slide_id(ids)]
    for params, loc in (({"patch_size": 256}, "patch_size"), ({"sampling_strategy": "lesion_aware"},
                                                            "sampling_strategy"),
                        ({"stain_normalization": "reinhard"}, "stain_normalization"), ({"precision": "fp16"},
                                                                                       "precision")):
        with pytest.raises(InvalidFeatureParams) as err:
            create_set(CMU_PROJECT, encoder_id=HANDCRAFTED, execution_mode="real_image_technical", slide_ids=cmu,
                       params=params)
        assert err.value.status == 422 and loc in repr(err.value.details["errors"])
    # macenko needs the TRAIN split of a dataset version.
    from dermpath.errors import ApiError

    with pytest.raises(ApiError) as err:
        create_set(CMU_PROJECT, encoder_id=HANDCRAFTED, execution_mode="real_image_technical", slide_ids=cmu,
                   params={"stain_normalization": "macenko-v1"})
    assert err.value.code == "stain_reference_needs_dataset"


def test_policies_from_params_mapping():
    from dermpath.ml.encoders import HANDCRAFTED_SPEC, SYNTHETIC_SPEC
    from dermpath.ml.feature_sets import DeferredMacenkoPolicy, policies_from_params

    patch, sampling, stain = policies_from_params({"max_patches_per_slide": 9, "sampling_seed": 4, "edge_mode": "pad",
                                                   "fragment_rescue_min_area_um2": 0, "C": 2.0},
                                                  HANDCRAFTED_SPEC, "real_image_technical")
    assert patch.patch_size == HANDCRAFTED_SPEC.input_size and patch.sampling is sampling
    assert sampling.max_patches == 9 and sampling.seed == 4 and sampling.strategy == "spatial"
    assert patch.edge_mode == "pad" and patch.fragment_rescue_min_area_um2 is None
    assert patch.allow_uncalibrated is False and stain.method == "none"
    patch, sampling, stain = policies_from_params({"sampling_strategy": "all", "allow_uncalibrated": False},
                                                  SYNTHETIC_SPEC, "synthetic_pipeline_test")
    assert patch.allow_uncalibrated is True and sampling.max_patches is None and patch.patch_size == 224
    _, _, stain = policies_from_params({"stain_normalization": "macenko-v1"}, HANDCRAFTED_SPEC,
                                       "supervised_experiment", stain_fit={"train_slide_ids": ["a"]})
    assert isinstance(stain, DeferredMacenkoPolicy) and stain.to_json()["reference_fit"]["train_slide_ids"] == ["a"]


# --------------------------------------------------------------------------- input snapshot


def test_snapshot_freezes_qc_and_a_changed_mask_object_is_refused(env, ids):
    from dermpath.db import session_scope
    from dermpath.ml import feature_sets as fsm
    from dermpath.ml.models import FeatureArtifact
    from dermpath.qc.service import run_screen
    from dermpath.storage import get_store

    sid = cmu_slide_id(ids)
    kw = dict(encoder_id=HANDCRAFTED, execution_mode="real_image_technical", slide_ids=[sid], params=FAST)
    a = create_set(CMU_PROJECT, **kw)
    snap = get_set(a).input_snapshot_json["slides"][0]
    # A re-screen after creation never changes the set; it shows up as staleness and a NEW spec.
    run_screen(sid)
    assert get_set(a).input_snapshot_json["slides"][0] == snap
    with session_scope() as db:
        stale = fsm.staleness(db, get_set(a))
    assert stale["stale"] and stale["qc_changed_since_snapshot"][0]["slide_id"] == sid
    b = create_set(CMU_PROJECT, **kw)
    assert b != a and get_set(b).input_snapshot_json["slides"][0]["qc_review_id"] != snap["qc_review_id"]
    _build(a)
    item = items_of(a)[sid]
    with session_scope() as db:
        art = db.get(FeatureArtifact, item.artifact_id)
    assert art.mask_sha256 == snap["mask_sha256"]  # built from the snapshot's mask, not the newer screen
    # The snapshot's mask object changes underneath: refused, nothing is written for that set.
    c = create_set(CMU_PROJECT, **{**kw, "params": {**FAST, "sampling_seed": 5}})
    mask_key = get_set(c).input_snapshot_json["slides"][0]["mask_object_key"]
    data = get_store().get_bytes(mask_key)
    get_store().put_bytes(mask_key, data + b"tampered")
    fsm.clear_sha_memo()
    with pytest.raises(fsm.FeatureError, match="input_changed"):
        _build(c)
    fs = get_set(c)
    assert fs.status == "failed" and "input_changed" in fs.error
    assert items_of(c)[sid].status == "pending"


# --------------------------------------------------------------------------- builds


def test_build_is_resumable_and_gives_the_uninterrupted_result(env, ids, monkeypatch):
    from dermpath.ml import feature_sets as fsm

    rc = real_cohort(ids, n=4)
    fs_id = create_set(rc["project_id"], encoder_id=HANDCRAFTED, execution_mode="supervised_experiment",
                       dataset_version_id=rc["dataset_version_id"], params=FAST)
    real_extract = fsm._extract
    calls: list[str] = []

    def killed_after_two(snap, **kw):
        if len(calls) == 2:
            raise RuntimeError("worker killed (simulated)")
        calls.append(snap["slide_id"])
        return real_extract(snap, **kw)

    monkeypatch.setattr(fsm, "_extract", killed_after_two)
    with pytest.raises(RuntimeError, match="killed"):
        _build(fs_id)
    done = {s for s, it in items_of(fs_id).items() if it.status == "done"}
    assert done == set(calls) and len(done) == 2 and get_set(fs_id).status == "failed"
    resumed: list[str] = []

    def counting(snap, **kw):
        resumed.append(snap["slide_id"])
        return real_extract(snap, **kw)

    monkeypatch.setattr(fsm, "_extract", counting)
    summary = _build(fs_id)
    assert summary["status"] == "ready" and summary["skipped_done"] == 2 and summary["built_now"] == 2
    assert sorted(resumed) == sorted(set(rc["slide_ids"]) - done)  # done slides were skipped
    assert get_set(fs_id).status == "ready"
    monkeypatch.setattr(fsm, "_extract", real_extract)
    for sid in rc["slide_ids"]:
        stored = fsm.load_slide_features(fs_id, sid)
        fresh = _recompute(fs_id, sid)
        assert np.array_equal(stored.coords, fresh.coords)
        assert np.array_equal(np.asarray(stored.embeddings), fresh.embeddings)
    # Building a ready set again is a verification pass that changes nothing.
    again = _build(fs_id)
    assert again["verified"] == 4 and again["repaired"] == []


def test_same_set_twice_gives_identical_embeddings_on_the_real_cmu_fixture(env, ids):
    from dermpath.ml import feature_sets as fsm

    sid = cmu_slide_id(ids)
    fs_id = create_set(CMU_PROJECT, encoder_id=HANDCRAFTED, execution_mode="real_image_technical", slide_ids=[sid],
                       params={"max_patches_per_slide": 24})
    _build(fs_id)
    first = fsm.load_slide_features(fs_id, sid)
    assert first.n_patches > 0 and first.embeddings.shape == (first.n_patches, 64)
    assert first.embeddings.dtype == np.float32 and isinstance(first.embeddings, np.memmap)
    assert first.coords.dtype == np.int64 and first.coords.shape == (first.n_patches, 2)
    assert set(first.quality) >= {"tissue_fraction", "pen_fraction", "laplacian_variance", "mean_rgb"}
    again = _recompute(fs_id, sid)
    assert again.cache_key == first.cache_key
    assert np.array_equal(again.coords, first.coords)
    assert np.array_equal(again.embeddings, np.asarray(first.embeddings))  # bit-identical
    # Coordinates lie inside the slide at the physical scale (CMU: 0.499 µm/px, 224 px at 0.5 µm/px).
    ext = round(224 * 0.5 / 0.499)
    assert (first.coords[:, 0] + ext <= 2220).all() and (first.coords[:, 1] + ext <= 2967).all()
    validation = fsm.validate_feature_set(fs_id, n_slides=1)
    assert validation["summary"]["passed"] is True and validation["per_slide"][0]["max_abs_diff"] == 0.0
    assert validation["per_slide"][0]["coords_identical"] and validation["per_slide"][0]["cache_key_match"]


def test_test_slides_are_built_without_reading_labels(env, ids, monkeypatch):
    from dermpath.ml import feature_sets as fsm
    from dermpath.models import DatasetVersion

    rc = real_cohort(ids, n=6)
    assert "test" in rc["split_of"].values()
    fs_id = create_set(rc["project_id"], encoder_id=HANDCRAFTED, execution_mode="supervised_experiment",
                       dataset_version_id=rc["dataset_version_id"], params={"max_patches_per_slide": 6})
    loaded_versions = []

    def guard(target, _context):
        loaded_versions.append(target.id)
        raise AssertionError("the build loaded a dataset version (labels live in its manifest)")

    def no_labels(*_a, **_k):
        raise AssertionError("the build asked for fixture labels outside synthetic_pipeline_test")

    import dermpath.labels as labels_mod

    monkeypatch.setattr(fsm, "_fixture_labels", no_labels)
    for name in ("reference_label", "current_imported_labels"):
        if hasattr(labels_mod, name):
            monkeypatch.setattr(labels_mod, name, no_labels)
    event.listen(DatasetVersion, "load", guard)
    try:
        summary = _build(fs_id)
    finally:
        event.remove(DatasetVersion, "load", guard)
    assert summary["status"] == "ready" and loaded_versions == []
    test_slides = [s for s, sp in rc["split_of"].items() if sp == "test"]
    items = items_of(fs_id)
    assert all(items[s].status == "done" and items[s].artifact_id for s in test_slides)
    assert get_set(fs_id).status == "ready"


def test_coverage_aggregation(env, ids, clients):
    from dermpath.db import session_scope
    from dermpath.ml import feature_sets as fsm

    rc = real_cohort(ids, n=3, project_id="proj-real-cov")
    asst = clients("user-assistant")
    zero = rc["slide_ids"][0]
    whole = {"type": "rectangle", "x": 0, "y": 0, "width": 2220, "height": 2967}
    issue = asst.post(f"/api/v1/slides/{zero}/qc/issues", json={"category": "fold", "region": whole,
                                                               "note": "whole slide (test)"}).json()
    asst.patch(f"/api/v1/qc/issues/{issue['id']}", json={"action": "review", "confirmed": True})
    r = asst.patch(f"/api/v1/qc/issues/{issue['id']}", json={
        "action": "resolve", "resolution": "excluded", "dataset_eligibility_effect": "exclude_region",
        "reason": "whole-slide exclusion (test)"})
    assert r.status_code == 200, r.text
    fs_id = create_set(rc["project_id"], encoder_id=HANDCRAFTED, execution_mode="real_image_technical",
                       slide_ids=rc["slide_ids"], params={"max_patches_per_slide": 3})
    _build(fs_id)
    with session_scope() as db:
        d = fsm.feature_set_dict(db, get_set(fs_id))
    cov = d["coverage"]
    assert d["status"] == "ready" and d["counts"] == {"slides": 3, "pending": 0, "done": 3, "failed": 0}
    assert len(cov["per_slide"]) == 3 and cov["slides_with_zero_patches"] == [zero]
    assert cov["n_patches"]["min"] == 0 and cov["n_patches"]["max"] == 3 and cov["total_patches"] == 6
    radius = cov["tissue_within_radius_of_sample_fraction"]
    assert radius["n"] == 2 and 0 < radius["min"] <= radius["median"] <= radius["max"] <= 1
    # Three patches of 112 µm cannot cover most of the CMU tissue: below the documented floor.
    assert set(cov["slides_below_coverage_floor"]) == set(rc["slide_ids"][1:])
    assert zero in cov["slides_without_coverage"] and cov["uncalibrated_count"] == 0
    assert cov["coverage_floor"]["value"] == fsm.COVERAGE_FLOOR
    row = next(r for r in cov["per_slide"] if r["slide_id"] == rc["slide_ids"][1])
    assert row["n_candidates"] > 3 and row["mask_source"] == "otsu_fallback"  # no QC screen: Otsu fallback


def test_stain_reference_is_fitted_on_train_slides_only(env, ids, monkeypatch):
    from dermpath.ml import feature_sets as fsm
    from dermpath.ml import stain as stainlib

    rc = real_cohort(ids, n=6)
    train = sorted(s for s, sp in rc["split_of"].items() if sp == "train")
    seen = {}
    real_fit = stainlib.fit_reference

    def spy(patches, *, splits=None, params=None):
        seen["splits"] = splits
        return real_fit(patches, splits=splits, params=params)

    opened: list[str] = []
    real_prepare = fsm._prepare

    def spy_prepare(snap, **kw):
        opened.append(snap["slide_id"])
        return real_prepare(snap, **kw)

    monkeypatch.setattr(stainlib, "fit_reference", spy)
    monkeypatch.setattr(fsm, "_prepare", spy_prepare)
    fs_id = create_set(rc["project_id"], encoder_id=HANDCRAFTED, execution_mode="supervised_experiment",
                       dataset_version_id=rc["dataset_version_id"],
                       params={"max_patches_per_slide": 6, "stain_normalization": "macenko-v1"})
    fs = get_set(fs_id)
    fit = fs.stain_policy_json["reference_fit"]
    assert fit["train_slide_ids"] == train and fs.stain_policy_json["deferred"] is True
    _build(fs_id)
    assert seen["splits"] == "train"
    assert opened[:len(train)] == train  # the reference fit read train slides, and only them, first
    fs = get_set(fs_id)
    assert fs.status == "ready" and fs.stain_reference_key and fs.stain_reference_sha256
    effective = fsm.effective_stain_policy(fs_id)
    assert effective.method == "macenko-v1" and effective.reference.sha256 == fs.stain_reference_sha256
    feats = fsm.load_slide_features(fs_id, rc["slide_ids"][0])
    assert feats.stain_policy_sha256 == effective.policy_sha256 != fs.stain_policy_sha256
    assert feats.meta["stain"]["source_sha256"]  # per-slide source estimate from the slide's own patches
    # A set without stain normalisation produces different embeddings for the same slide.
    plain = create_set(rc["project_id"], encoder_id=HANDCRAFTED, execution_mode="supervised_experiment",
                       dataset_version_id=rc["dataset_version_id"], params={"max_patches_per_slide": 6})
    assert plain != fs_id


def test_synthetic_pipeline_set_is_pixel_free_and_signal_only_through_the_fixture(env, ids, monkeypatch):
    from dermpath.db import session_scope
    from dermpath.ml import feature_sets as fsm
    from dermpath.ml import fixture
    from dermpath.models import DatasetVersion

    dv_id = cohort(ids)["dataset_version_id"]
    fs_id = create_set(CID, encoder_id=SYNTH, execution_mode="synthetic_pipeline_test", dataset_version_id=dv_id,
                       params={"pixel_mode": "none", "max_patches_per_slide": 8})
    fs = get_set(fs_id)
    assert fs.patch_policy_json["allow_uncalibrated"] is True  # forced in the pipeline test only
    contexts = []
    real_ctx = fixture.fixture_context

    def spy(provenance, image_kind, mode, label):
        contexts.append((provenance, image_kind, mode, label))
        return real_ctx(provenance, image_kind, mode, label)

    monkeypatch.setattr(fixture, "fixture_context", spy)
    summary = _build(fs_id)
    assert summary["status"] == "ready"
    assert contexts and all(c[:3] == ("demo_synthetic", "synthetic_tiles", "synthetic_pipeline_test") for c in contexts)
    with session_scope() as db:
        manifest = db.get(DatasetVersion, dv_id).manifest_json
    label = {it["slide_id"]: int(it["label_value"] == manifest["positive_class"]) for it in manifest["items"]}
    pos = next(s for s, v in label.items() if v == 1)
    feats = fsm.load_slide_features(fs_id, pos)
    assert feats.quality == {} and feats.meta["read"]["pixels_read"] is False
    ctx = real_ctx("demo_synthetic", "synthetic_tiles", "synthetic_pipeline_test", 1)
    expect = fixture.synthetic_embeddings(ctx, feats.coords, slide_sha256=items_of(fs_id)[pos].slide_sha256, seed=0,
                                          config=fixture.synthetic_config({}))
    assert np.array_equal(np.asarray(feats.embeddings), expect)
    assert feats.embeddings.shape == (8, 64)


def test_require_ready_lists_missing_slides(env, ids):
    from dermpath.db import session_scope
    from dermpath.ml import feature_sets as fsm

    sid = cmu_slide_id(ids)
    fs_id = create_set(CMU_PROJECT, encoder_id=HANDCRAFTED, execution_mode="real_image_technical", slide_ids=[sid],
                       params=FAST)
    with session_scope() as db:
        with pytest.raises(fsm.FeatureSetNotReady) as err:
            fsm.require_ready(db, get_set(fs_id), [sid])
    assert err.value.missing == [sid] and err.value.code == "feature_set_not_ready"
    with pytest.raises(fsm.FeatureSetNotReady):
        fsm.load_slide_features(fs_id, sid)
    _build(fs_id)
    with session_scope() as db:
        fsm.require_ready(db, get_set(fs_id), [sid])
        with pytest.raises(fsm.FeatureSetNotReady) as err:
            fsm.require_ready(db, get_set(fs_id), [sid, "not-in-the-set"])
    assert err.value.missing == ["not-in-the-set"]


def test_artifact_identity_is_verified_on_load(env, ids, monkeypatch):
    """An artifact whose identity differs from the set's (here: the pinned weights) is refused."""
    from dermpath.ml import feature_sets as fsm

    sid = cmu_slide_id(ids)
    fs_id = create_set(CMU_PROJECT, encoder_id=HANDCRAFTED, execution_mode="real_image_technical", slide_ids=[sid],
                       params=FAST)
    _build(fs_id)
    assert fsm.load_slide_features(fs_id, sid).n_patches > 0
    real = fsm._expected_identity

    def pinned_elsewhere(db, row):
        return {**real(db, row), "weights_sha256": "0" * 64}

    monkeypatch.setattr(fsm, "_expected_identity", pinned_elsewhere)
    with pytest.raises(fsm.FeatureSetIntegrityError, match="weights_sha256"):
        fsm.load_slide_features(fs_id, sid)
