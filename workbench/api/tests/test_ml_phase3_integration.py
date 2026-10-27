"""Phase 3 integration regressions: the seams between feature sets (W6), training (W7a), evaluation and
inference (W7b) and label sources (W8) that no single module owns.

* A macenko-v1 feature set stores a DEFERRED stain plan; its inference bundle must carry the EFFECTIVE policy
  (with the reference fitted on train slides) so a registered bundle reproduces the set's extraction exactly.
* Deterministic failures of a run's inline feature-set build are permanent (never retried).
* A train job that ends while its inline build is unfinished leaves the set ``failed`` (resumable), never
  ``building`` forever, unless another job can still finish it.
* Worker processes register every engine job type through ``dermpath.ml.jobs``.
* The dataset API accepts the imported-reference configuration the COBRA import needs.
"""

from __future__ import annotations

import numpy as np
from sqlalchemy import select

from feature_set_support import create_set, get_set, real_cohort
from ml_engine_fakes import make_engine_run, run_jobs
from test_ml_support import CID, FAST, LEAD, cohort

HANDCRAFTED = "handcrafted-stain-texture-v1"


def test_macenko_bundle_carries_the_effective_stain_policy_and_reproduces_the_set(env, ids, clients):
    from dermpath.db import session_scope
    from dermpath.ml import feature_sets as fsm
    from dermpath.ml.encoders import ENCODER_SPECS
    from dermpath.ml.feature_sets import build_feature_set
    from dermpath.ml.models import FeatureArtifact
    from dermpath.models import DatasetVersion

    rc = real_cohort(ids, n=6)
    fs_id = create_set(rc["project_id"], encoder_id=HANDCRAFTED, execution_mode="supervised_experiment",
                       dataset_version_id=rc["dataset_version_id"],
                       params={"max_patches_per_slide": 6, "stain_normalization": "macenko-v1"})
    build_feature_set(fs_id)
    fs = get_set(fs_id)
    assert fs.status == "ready" and fs.stain_policy_json["deferred"] is True
    effective = fsm.effective_stain_policy(fs_id)
    with session_scope() as db:
        dv = db.get(DatasetVersion, rc["dataset_version_id"])
        run, _ = make_engine_run(db, dv, fs=db.get(type(fs), fs_id), mode="supervised_experiment",
                                 encoder_id=HANDCRAFTED, store_val=False,
                                 dim=ENCODER_SPECS[HANDCRAFTED].embedding_dim)
        rid = run.id
    lead = clients(LEAD)
    reg = lead.post(f"/api/v1/experiments/{rid}/register")
    assert reg.status_code in (200, 201), reg.text
    reg = reg.json()
    stain = reg["bundle"]["content"]["stain_policy"]
    assert stain["policy"]["method"] == "macenko-v1" and stain["policy"]["reference"] is not None
    assert stain["policy_sha256"] == effective.policy_sha256 != fs.stain_policy_sha256
    assert stain["declared_policy"]["deferred"] is True and stain["reference_sha256"] == fs.stain_reference_sha256
    # Label-free inference on a held-out (test) slide of the set reproduces the set's pinned embeddings bit for bit.
    sid = next(s for s, sp in sorted(rc["split_of"].items()) if sp == "test")
    r = lead.post(f"/api/v1/bundles/{reg['bundle_id']}/infer", json={"slide_id": sid})
    assert r.status_code == 202, r.text
    out = run_jobs(["infer_slide"])
    assert [o.status for o in out] == ["succeeded"], [o.error for o in out]
    (p,) = lead.get(f"/api/v1/bundles/{reg['bundle_id']}/predictions").json()["items"]
    assert p["unscorable_reason"] is None and p["is_label"] is False
    with session_scope() as db:
        art = db.get(FeatureArtifact, p["feature_artifact_id"])
        assert art.stain_policy_sha256 == effective.policy_sha256
    inferred = fsm._materialise(art)
    pinned = fsm.load_slide_features(fs_id, sid)
    assert np.array_equal(np.asarray(inferred.embeddings), np.asarray(pinned.embeddings))
    assert np.array_equal(inferred.coords, pinned.coords)


def _queued_cohort_run(client, ids, **param_overrides) -> dict:
    c = cohort(ids)
    body = {"dataset_version_id": c["dataset_version_id"], "encoder_id": "synthetic-deterministic-v1",
            "head": "meanpool_logreg", "seed": 0, "params": {**FAST, **param_overrides}}
    r = client.post(f"/api/v1/projects/{CID}/experiments", json=body)
    assert r.status_code == 202, r.text
    return r.json()["experiment"]


def test_deterministic_inline_build_failures_are_permanent(env, ids, clients, monkeypatch):
    """input_changed / extraction_env_changed / mode refusals raised while a train job builds its set inline would
    fail identically on every retry: the job fails at once (one attempt) with a stated reason."""
    from dermpath.db import session_scope
    from dermpath.models import Job
    from dermpath.ml import feature_sets as fsm

    lead = clients(LEAD)
    cases = [(fsm.FeatureError("input_changed: slide bytes differ from the snapshot"), "feature_set_build_failed"),
             (fsm.ModeMismatch("synthetic_pipeline_test needs synthetic data", problems=["x"]), "mode_mismatch")]
    for k, (exc, code) in enumerate(cases):
        run = _queued_cohort_run(lead, ids, sampling_seed=70 + k)
        assert get_set(run["feature_set_id"]).status == "building"

        def boom(fs_id, ctx=None, _exc=exc):
            raise _exc

        monkeypatch.setattr(fsm, "build_feature_set", boom)
        out = run_jobs(["train"])
        assert [o.status for o in out] == ["failed"], out
        assert out[0].error.startswith(code), out[0].error
        with session_scope() as db:
            assert db.get(Job, out[0].job_id).attempts == 1
        assert lead.get(f"/api/v1/experiments/{run['id']}").json()["status"] == "failed"


def test_train_settle_hook_fails_an_unfinished_inline_build_unless_another_job_can_finish_it(env, ids, clients):
    from dermpath.auth import Actor
    from dermpath.db import session_scope
    from dermpath.models import Job
    from dermpath.ml import feature_sets as fsm
    from dermpath.ml.engine_models import FeatureSet
    from dermpath.ml.jobs import settle_training_run

    lead = clients(LEAD)
    run = _queued_cohort_run(lead, ids, sampling_seed=81)
    fs_id = run["feature_set_id"]
    with session_scope() as db:
        train_job = db.scalars(select(Job).where(Job.type == "train", Job.status == "queued")).all()
        (train_job,) = [j for j in train_job if (j.payload_json or {}).get("run_id") == run["id"]]
        build = fsm.enqueue_build(db, db.get(FeatureSet, fs_id), Actor(LEAD, "research_lead", "Lead"))
        build_id = build.id
        # Another job (the queued build) can still finish the set: it stays building.
        settle_training_run(db, train_job, "failed", "attempts exhausted mid-build")
        assert db.get(FeatureSet, fs_id).status == "building"
    with session_scope() as db:
        db.get(Job, build_id).status = "canceled"
        train_job = db.get(Job, train_job.id)
        settle_training_run(db, train_job, "failed", "attempts exhausted mid-build")
        fs = db.get(FeatureSet, fs_id)
        assert fs.status == "failed" and "inline build by train job" in fs.error
        settle_training_run(db, train_job, "failed", "again")  # idempotent
        assert db.get(FeatureSet, fs_id).status == "failed"


def test_worker_processes_register_every_engine_job_type():
    import dermpath.ml.jobs as ml_jobs
    from dermpath.jobs.registry import HANDLERS, SETTLE_HOOKS

    assert "dermpath.ml.active_learning" in ml_jobs.ENGINE_HANDLER_MODULES
    assert all(v == "loaded" for v in ml_jobs.ENGINE_MODULES_REPORT.values()), ml_jobs.ENGINE_MODULES_REPORT
    assert {"train", "build_feature_set", "validate_feature_set", "evaluate_test_release", "infer_slide",
            "active_learning"} <= set(HANDLERS)
    assert {"train", "build_feature_set"} <= set(SETTLE_HOOKS)


def test_dataset_api_accepts_the_imported_reference_configuration(env, clients):
    lead = clients(LEAD)
    pid = "proj-bcc-demo"
    ok = lead.post(f"/api/v1/projects/{pid}/datasets", json={
        "name": "imported-reference draft",
        "config": {"reference_standard": "imported_reference", "include_provenance": ["public_licensed"],
                   "eligible_review_states": ["imported", "approved"]}})
    assert ok.status_code == 201, ok.text
    assert ok.json()["config"]["reference_standard"] == "imported_reference"
    refused = lead.post(f"/api/v1/projects/{pid}/datasets", json={
        "name": "expert draft with unreviewed slides", "config": {"eligible_review_states": ["imported"]}})
    assert refused.status_code == 422 and refused.json()["error"]["code"] == "review_state_requires_imported_reference"
    default = lead.post(f"/api/v1/projects/{pid}/datasets", json={"name": "default draft"})
    assert default.status_code == 201 and default.json()["config"]["reference_standard"] == "expert"


def test_imported_reference_labels_are_visible_but_blinded_and_drive_eligibility_only_under_their_standard(
        env, ids, clients):
    from dermpath.db import session_scope
    from dermpath.labels import create_imported_reference_label
    from dermpath.models import Project, Slide

    sid = ids["slides"]["cmu_cc0"]
    with session_scope() as db:
        create_imported_reference_label(db, slide=db.get(Slide, sid), value="bcc_present",
                                        provenance="test import: report-derived label (fictional)")
        project = db.get(Project, db.get(Slide, sid).project_id)
        project.settings_json = {**(project.settings_json or {}), "independent_review": True}
    lead = clients(LEAD)
    view = lead.get(f"/api/v1/slides/{sid}/labels").json()
    (imp,) = view["imported_reference_labels"]
    assert imp["source"] == "imported_reference" and imp["value"] == "bcc_present"
    assert view["reference"]["slide_imported"]["status"] == "imported_reference"
    assert all(e["source"] == "expert" for e in view["expert_labels"])  # never shown as an expert read
    assert lead.get(f"/api/v1/slides/{sid}").json()["labels"]["imported_reference_label_count"] == 1
    # A pathologist under independent review sees neither suggestions nor imported labels before assessing.
    blind = clients("user-pathologist").get(f"/api/v1/slides/{sid}/labels").json()
    assert blind["suggestions_hidden"] is True and blind["imported_reference_labels"] == []
    assert blind["reference"]["slide_imported"]["status"] == "hidden"
    # Eligibility follows the reference standard requested.
    q = "?eligible_review_states=imported&eligible_review_states=approved&eligible_review_states=pending_review"
    imported = lead.get(f"/api/v1/slides/{sid}/eligibility{q}&reference_standard=imported_reference").json()
    assert imported["reference_standard"] == "imported_reference" and imported["label_value"] == "bcc_present"
    expert = lead.get(f"/api/v1/slides/{sid}/eligibility").json()
    assert expert["reference_standard"] == "expert" and expert["label_version_id"] != imported["label_version_id"]
    meta = lead.get("/api/v1/meta").json()
    assert "imported_reference" in meta["label_sources"] and "public_licensed" in meta["real_provenances"]
