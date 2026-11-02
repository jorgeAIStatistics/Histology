"""Test releases (design §7): research lead, reason, declared candidate, numbered per manifest, justification
from the second release, sealing in the same transaction, scoring ONLY from pinned feature-set artifacts (no
re-extraction; a missing artifact or a different weights sha fails the job), stored results read by GET with no
side effects. Comparison families: paired comparisons on development data, lock, family release.

The partners' feature-set loader and scorer are replaced by fakes that follow the interface contract
(tests/helpers/ml_engine_fakes.py)."""

from __future__ import annotations

import pytest
from sqlalchemy import func, select

from ml_engine_fakes import CID, LEAD, cohort_dv, install_fakes, make_engine_run, run_jobs

RELEASE_JOB = "evaluate_test_release"


def _engine_run(**kw):
    from dermpath.db import session_scope

    with session_scope() as db:
        ids = kw.pop("ids")
        dv = cohort_dv(db, ids)
        run, fs = make_engine_run(db, dv, **kw)
        return run.id, fs.id, dv.id


def _counts():
    from dermpath.db import session_scope
    from dermpath.ml.engine_models import TestRelease
    from dermpath.ml.models import Evaluation, Prediction
    from dermpath.models import AuditEvent, Job, SplitFamilyAssignment

    with session_scope() as db:
        return {"test_predictions": db.scalar(select(func.count(Prediction.id)).where(Prediction.split == "test")),
                "evaluations": db.scalar(select(func.count(Evaluation.id))),
                "releases": db.scalar(select(func.count(TestRelease.id))),
                "jobs": db.scalar(select(func.count(Job.id))),
                "audit": db.scalar(select(func.count(AuditEvent.id))),
                "sealed": db.scalar(select(func.count(SplitFamilyAssignment.id))
                                    .where(SplitFamilyAssignment.sealed_at.is_not(None)))}


def _actions(names: set[str]) -> list[str]:
    from dermpath.db import session_scope
    from dermpath.models import AuditEvent

    with session_scope() as db:
        return list(db.scalars(select(AuditEvent.action).where(AuditEvent.action.in_(sorted(names)))).all())


def _test_patients(dv_id):
    from dermpath.datasets import family_assignments, lineage_family
    from dermpath.db import session_scope
    from dermpath.models import DatasetVersion

    with session_scope() as db:
        dv = db.get(DatasetVersion, dv_id)
        return {pid: a.sealed_at for pid, a in family_assignments(db, lineage_family(db, dv.lineage_id)).items()
                if a.split == "test"}


def _test_slides(dv_id):
    from dermpath.db import session_scope
    from dermpath.models import DatasetVersion

    with session_scope() as db:
        return {it["slide_id"] for it in db.get(DatasetVersion, dv_id).manifest_json["items"] if it["split"] == "test"}


def test_release_requires_research_lead_reason_and_declared_candidate(clients, ids, monkeypatch):
    calls = install_fakes(monkeypatch)
    rid, _fs, dv = _engine_run(ids=ids)
    lead = clients(LEAD)
    url = f"/api/v1/experiments/{rid}/test-release"
    before = _counts()
    # Other roles cannot release.
    for uid in ("user-pathologist", "user-director"):
        r = clients(uid).post(url, json={"reason": "final evaluation"})
        assert r.status_code == 403 and r.json()["error"]["code"] == "role_forbidden"
    # A reason is required.
    assert lead.post(url, json={}).status_code == 422
    r = lead.post(url, json={"reason": "   "})
    assert r.status_code == 422 and r.json()["error"]["code"] == "reason_required"
    # A candidate must be declared first (registered bundle or locked family).
    r = lead.post(url, json={"reason": "final evaluation"})
    assert r.status_code == 409 and r.json()["error"]["code"] == "candidate_required"
    after = _counts()  # nothing recorded, nothing sealed by refusals (403s add only access-denied audit rows)
    assert {k: v for k, v in after.items() if k != "audit"} == {k: v for k, v in before.items() if k != "audit"}
    assert all(v is None for v in _test_patients(dv).values())
    assert not _actions({"test_release.created", "dataset.test_patients_sealed"})
    st = lead.get(url).json()
    assert st["candidate"]["ready"] is False and st["can_release"] is False and st["next_release_number"] == 1

    reg = lead.post(f"/api/v1/experiments/{rid}/register", json={"note": "final candidate"})
    assert reg.status_code == 201, reg.text
    bundle_id = reg.json()["bundle_id"]
    assert bundle_id and reg.json()["bundle"]["verified"] is True
    st = lead.get(url).json()
    assert st["candidate"] == {"kind": "bundle", "bundle_id": bundle_id, "family_id": None, "ready": True,
                               "reason": None} and st["can_release"] is True
    r = lead.post(url, json={"reason": "final evaluation of the registered candidate"})
    assert r.status_code == 202, r.text
    rel = r.json()["test_release"]
    assert rel["release_number"] == 1 and rel["prior_releases_on_manifest"] == 0
    assert rel["candidate_kind"] == "bundle" and rel["bundle_id"] == bundle_id and rel["run_ids"] == [rid]
    assert rel["job_status"] == "queued" and rel["complete"] is False
    # Sealing happened in the same transaction: every test patient of the split family.
    sealed = _test_patients(dv)
    assert sealed and all(v is not None for v in sealed.values())
    assert rel["sealed_patient_count"] == len(sealed)
    # Before the job runs, GET reads nothing and computes nothing.
    r = lead.get(f"/api/v1/experiments/{rid}/evaluation?split=test")
    assert r.status_code == 409 and r.json()["error"]["code"] == "test_release_pending"
    assert calls.load == [] and calls.extract == []

    out = run_jobs([RELEASE_JOB])
    assert [o.status for o in out] == ["succeeded"], [o.error for o in out]
    assert set(calls.load) == _test_slides(dv) and calls.extract == []  # pinned artifacts only, test slides only
    ev = lead.get(f"/api/v1/experiments/{rid}/evaluation?split=test")
    assert ev.status_code == 200, ev.text
    body = ev.json()
    assert body["split"] == "test" and body["test_release_id"] == rel["id"] and body["release_number"] == 1
    assert body["prior_releases_on_manifest"] == 0 and body["tuning_set"] is False
    assert body["scored_from"] == "pinned feature-set artifacts (no re-extraction)"
    assert body["metrics"]["sensitivity"]["tuning_set"] is False
    assert body["n_items"] + body["n_unscorable"] == len(_test_slides(dv))  # slide-level bags
    again = lead.get(f"/api/v1/experiments/{rid}/evaluation?split=test").json()
    assert again["evaluation_id"] == body["evaluation_id"]
    errs = lead.get(f"/api/v1/experiments/{rid}/errors?split=test").json()
    assert errs["counts"]["n_items"] == body["n_items"]
    assert all("categories" in i for i in errs["items"])
    # Released once only.
    r = lead.post(url, json={"reason": "again"})
    assert r.status_code == 409 and r.json()["error"]["code"] == "test_already_released"
    # Audit trail: release with its reason, per-run release, sealing, the worker's evaluation, reads.
    audit = lead.get(f"/api/v1/projects/{CID}/audit?limit=200").json()["items"]
    actions = [e["action"] for e in audit]
    created = next(e for e in audit if e["action"] == "test_release.created")
    assert created["actor_id"] == LEAD and created["reason"] == "final evaluation of the registered candidate"
    assert created["after"]["release_number"] == 1 and created["after"]["candidate_kind"] == "bundle"
    assert "experiment.test_released" in actions and "dataset.test_patients_sealed" in actions
    evaluated = next(e for e in audit if e["action"] == "experiment.test_evaluated")
    assert evaluated["actor_id"] == "system:worker" and evaluated["after"]["test_release_id"] == rel["id"]
    assert evaluated["after"]["metrics_sha256"] and evaluated["after"]["predictions_sha256"]
    assert actions.count("experiment.test_accessed") == 3
    # The stored test predictions carry the frozen threshold, the release id and failure categories.
    from dermpath.db import session_scope
    from dermpath.ml.models import Prediction

    with session_scope() as db:
        tp = db.scalars(select(Prediction).where(Prediction.run_id == rid, Prediction.split == "test")).all()
        assert tp and all(p.threshold == 0.5 and p.attributes_json["test_release_id"] == rel["id"] for p in tp)
        assert all(p.failure_categories_json is not None for p in tp)
        assert all(p.failure_categories_json == [] for p in tp if p.predicted == p.label)


def test_second_release_on_a_manifest_needs_a_justification_and_is_counted(clients, ids, monkeypatch):
    install_fakes(monkeypatch)
    a, _fs, dv = _engine_run(ids=ids, seed=1)
    b, _fs2, _ = _engine_run(ids=ids, seed=2)
    lead = clients(LEAD)
    for rid in (a, b):
        assert lead.post(f"/api/v1/experiments/{rid}/register").status_code == 201
    assert lead.post(f"/api/v1/experiments/{a}/test-release", json={"reason": "first look"}).status_code == 202
    before = _counts()
    st = lead.get(f"/api/v1/experiments/{b}/test-release").json()
    assert st["justification_required"] is True and st["prior_releases_on_manifest"] == 1
    r = lead.post(f"/api/v1/experiments/{b}/test-release", json={"reason": "second candidate"})
    assert r.status_code == 422 and r.json()["error"]["code"] == "justification_required"
    assert r.json()["error"]["details"]["prior_releases_on_manifest"] == 1
    assert _counts() == before
    r = lead.post(f"/api/v1/experiments/{b}/test-release",
                  json={"reason": "second candidate", "justification": "the first candidate's encoder was withdrawn"})
    assert r.status_code == 202
    rel = r.json()["test_release"]
    assert rel["release_number"] == 2 and rel["prior_releases_on_manifest"] == 1
    assert rel["justification"] == "the first candidate's encoder was withdrawn"
    out = run_jobs([RELEASE_JOB])
    assert {o.status for o in out} == {"succeeded"}
    body = lead.get(f"/api/v1/experiments/{b}/evaluation?split=test").json()
    assert body["release_number"] == 2 and body["prior_releases_on_manifest"] == 1
    assert any("test release 2" in w for w in body["warnings"])
    first = lead.get(f"/api/v1/experiments/{a}/evaluation?split=test").json()
    assert first["release_number"] == 1 and first["prior_releases_on_manifest"] == 0
    listed = lead.get(f"/api/v1/projects/{CID}/test-releases").json()["items"]
    assert [r["release_number"] for r in listed] == [1, 2] and all(r["complete"] for r in listed)
    # The append-only row cannot be renumbered or rewritten.
    from dermpath.db import session_scope
    from dermpath.ml.engine_models import TestRelease
    from dermpath.models import ImmutableRecordError

    with session_scope() as db:
        row = db.get(TestRelease, rel["id"])
        row.reason = "rewritten"
        with pytest.raises(ImmutableRecordError):
            db.flush()
        db.rollback()


def test_get_test_results_have_no_side_effects(clients, ids, monkeypatch):
    install_fakes(monkeypatch)
    rid, _fs, _dv = _engine_run(ids=ids)
    lead = clients(LEAD)
    before = _counts()
    for path in ("evaluation", "errors"):
        r = lead.get(f"/api/v1/experiments/{rid}/{path}?split=test")
        assert r.status_code == 409 and r.json()["error"]["code"] == "test_release_required"
    st = lead.get(f"/api/v1/experiments/{rid}/test-release")
    assert st.status_code == 200 and st.json()["released"] is False
    assert _counts() == before  # no computation, no job, no sealing, not even an audit row
    lead.post(f"/api/v1/experiments/{rid}/register")
    lead.post(f"/api/v1/experiments/{rid}/test-release", json={"reason": "final"})
    run_jobs([RELEASE_JOB])
    stored = _counts()
    for _ in range(2):
        assert lead.get(f"/api/v1/experiments/{rid}/evaluation?split=test").status_code == 200
        assert lead.get(f"/api/v1/experiments/{rid}/errors?split=test").status_code == 200
    after = _counts()
    # Reading stored results writes only the access record; no prediction, evaluation, release, job or seal.
    assert {k: v for k, v in after.items() if k != "audit"} == {k: v for k, v in stored.items() if k != "audit"}
    assert after["audit"] == stored["audit"] + 4


def test_scoring_refuses_a_missing_pinned_artifact_and_never_re_extracts(clients, ids, monkeypatch):
    rid, _fs, dv = _engine_run(ids=ids)
    victim = sorted(_test_slides(dv))[0]
    calls = install_fakes(monkeypatch, corrupt={victim})
    lead = clients(LEAD)
    lead.post(f"/api/v1/experiments/{rid}/register")
    assert lead.post(f"/api/v1/experiments/{rid}/test-release", json={"reason": "final"}).status_code == 202
    out = run_jobs([RELEASE_JOB])
    assert [o.status for o in out] == ["failed"]
    assert "pinned_artifact_missing" in out[0].error and victim in out[0].error
    assert calls.extract == [] and calls.score == 0  # no re-extraction, nothing scored
    assert _counts()["test_predictions"] == 0
    r = lead.get(f"/api/v1/experiments/{rid}/evaluation?split=test")
    assert r.status_code == 409 and r.json()["error"]["code"] == "test_release_failed"
    assert "pinned_artifact_missing" in r.json()["error"]["details"]["job_error"]


def test_scoring_refuses_a_weights_sha_that_differs_from_the_pins(clients, ids, monkeypatch):
    rid, _fs, dv = _engine_run(ids=ids)
    victim = sorted(_test_slides(dv))[-1]
    calls = install_fakes(monkeypatch, weights_override={victim: "f" * 64})
    lead = clients(LEAD)
    lead.post(f"/api/v1/experiments/{rid}/register")
    lead.post(f"/api/v1/experiments/{rid}/test-release", json={"reason": "final"})
    out = run_jobs([RELEASE_JOB])
    assert [o.status for o in out] == ["failed"]
    assert "weights_or_identity_mismatch" in out[0].error and "weights_sha256" in out[0].error
    assert calls.extract == [] and calls.score == 0 and _counts()["test_predictions"] == 0


def test_release_is_refused_before_sealing_when_test_features_are_not_pinned(clients, ids, monkeypatch):
    install_fakes(monkeypatch)
    from dermpath.db import session_scope

    with session_scope() as db:
        dv = cohort_dv(db, ids)
        missing = sorted({it["slide_id"] for it in dv.manifest_json["items"] if it["split"] == "test"})[0]
        dv_id = dv.id
    rid, _fs, _ = _engine_run(ids=ids, skip_items={missing})
    lead = clients(LEAD)
    assert lead.post(f"/api/v1/experiments/{rid}/register").status_code == 201
    before = _counts()
    r = lead.post(f"/api/v1/experiments/{rid}/test-release", json={"reason": "final"})
    assert r.status_code == 409 and r.json()["error"]["code"] == "feature_set_not_ready"
    assert _counts() == before and all(v is None for v in _test_patients(dv_id).values())


def test_unfinished_and_legacy_runs_cannot_be_released(clients, ids, monkeypatch):
    install_fakes(monkeypatch)
    from dermpath.db import session_scope
    from dermpath.ml.models import TrainingRun

    with session_scope() as db:
        dv = cohort_dv(db, ids)
        queued = TrainingRun(project_id=dv.project_id, name="queued", dataset_version_id=dv.id,
                             dataset_manifest_sha256=dv.manifest_sha256, encoder_id="synthetic-deterministic-v1",
                             head="meanpool_logreg", params_json={}, seed=0, status="queued", synthetic=True,
                             label_scope="slide", positive_class="bcc_present",
                             negative_class="bcc_absent_not_benign", created_by=LEAD)
        db.add(queued)
        db.flush()
        qid = queued.id
    lead = clients(LEAD)
    r = lead.post(f"/api/v1/experiments/{qid}/test-release", json={"reason": "x"})
    assert r.status_code == 409 and r.json()["error"]["code"] == "test_locked"
    assert lead.get(f"/api/v1/experiments/{qid}/evaluation?split=test").json()["error"]["code"] == "test_locked"
    # A legacy run (no pinned feature set) gets a model version but no bundle, so it has no candidate.
    with session_scope() as db:
        run, _ = make_engine_run(db, cohort_dv(db, ids))
        legacy = TrainingRun(project_id=run.project_id, name="legacy", dataset_version_id=run.dataset_version_id,
                             dataset_manifest_sha256=run.dataset_manifest_sha256, encoder_id=run.encoder_id,
                             head=run.head, params_json=run.params_json, seed=5, status="succeeded", synthetic=True,
                             label_scope="slide", positive_class=run.positive_class,
                             negative_class=run.negative_class, checkpoint_key=run.checkpoint_key,
                             checkpoint_sha256=run.checkpoint_sha256, checkpoint_bytes=run.checkpoint_bytes,
                             threshold_value=0.5, threshold_rule="youden", threshold_frozen_at=run.threshold_frozen_at,
                             threshold_json={"selected_on": "val", "selection_status": "selected"}, created_by=LEAD)
        db.add(legacy)
        db.flush()
        lid = legacy.id
    reg = lead.post(f"/api/v1/experiments/{lid}/register")
    assert reg.status_code == 201 and reg.json()["bundle_id"] is None
    assert "legacy run" in reg.json()["bundle_unavailable_reason"]
    r = lead.post(f"/api/v1/experiments/{lid}/test-release", json={"reason": "x"})
    assert r.status_code == 409 and r.json()["error"]["code"] == "candidate_required"


def test_comparison_family_paired_on_development_data_then_locked_and_released_as_one(clients, ids, monkeypatch):
    install_fakes(monkeypatch)
    lead, director = clients(LEAD), clients("user-director")
    a, _fs, dv = _engine_run(ids=ids, seed=3)
    b, _fs2, _ = _engine_run(ids=ids, seed=4)
    r = lead.post(f"/api/v1/projects/{CID}/comparison-families",
                  json={"name": "baseline grid", "dataset_version_id": dv, "bootstrap_seed": 17,
                        "plan": {"n_boot": 200, "primary_metric": "auroc"}})
    assert r.status_code == 201, r.text
    fid = r.json()["id"]
    assert clients("user-pathologist").post(f"/api/v1/comparison-families/{fid}/members",
                                            json={"run_id": a}).status_code == 403
    for rid in (a, b):
        assert lead.post(f"/api/v1/comparison-families/{fid}/members", json={"run_id": rid}).status_code == 201
    assert lead.post(f"/api/v1/comparison-families/{fid}/members", json={"run_id": a}).status_code == 200
    fam = director.get(f"/api/v1/comparison-families/{fid}").json()
    assert fam["status"] == "open" and {x["id"] for x in fam["runs"]} == {a, b} and fam["winner"] is None
    dev = fam["development_comparison"]
    assert dev["status"] == "ok" and dev["split"] == "val"
    res = dev["result"]
    assert res["bootstrap"]["seed"] == 17 and res["bootstrap"]["method"] == "patient_paired"
    assert res["winner"] is None and len(res["pairs"]) == 1 and set(res["pairs"][0]["deltas"]) >= {"auroc", "brier"}
    assert fam["test_comparison"]["status"] == "locked"
    # Locking needs a reason and the research lead; afterwards membership is frozen.
    assert lead.post(f"/api/v1/comparison-families/{fid}/lock", json={"reason": " "}).status_code == 422
    assert director.post(f"/api/v1/comparison-families/{fid}/lock", json={"reason": "x"}).status_code == 403
    locked = lead.post(f"/api/v1/comparison-families/{fid}/lock", json={"reason": "plan complete"})
    assert locked.status_code == 200 and locked.json()["status"] == "locked"
    c, _fs3, _ = _engine_run(ids=ids, seed=5)
    r = lead.post(f"/api/v1/comparison-families/{fid}/members", json={"run_id": c})
    assert r.status_code == 409 and r.json()["error"]["code"] == "family_locked"
    # Releasing a member releases the locked family as one candidate.
    r = lead.post(f"/api/v1/experiments/{a}/test-release", json={"reason": "final comparison"})
    assert r.status_code == 202, r.text
    rel = r.json()["test_release"]
    assert rel["candidate_kind"] == "family" and rel["family_id"] == fid and sorted(rel["run_ids"]) == sorted([a, b])
    out = run_jobs([RELEASE_JOB])
    assert [o.status for o in out] == ["succeeded"]
    for rid in (a, b):
        body = lead.get(f"/api/v1/experiments/{rid}/evaluation?split=test").json()
        assert body["test_release_id"] == rel["id"] and body["test_release_candidate"]["family_id"] == fid
    fam = lead.get(f"/api/v1/comparison-families/{fid}").json()
    assert fam["status"] == "test_released" and fam["test_comparison"]["status"] == "ok"
    assert director.get(f"/api/v1/comparison-families/{fid}").json()["test_comparison"]["status"] == "restricted"
    r = lead.post(f"/api/v1/experiments/{b}/test-release", json={"reason": "again", "justification": "x"})
    assert r.status_code == 409 and r.json()["error"]["code"] == "test_already_released"


def test_job_payload_never_carries_labels():
    from dermpath.jobs.registry import PermanentJobError
    from dermpath.ml.evaluation import evaluate_test_release

    with pytest.raises(PermanentJobError):
        evaluate_test_release(None, {"test_release_id": "x", "labels": [1, 0]})
    with pytest.raises(PermanentJobError):
        evaluate_test_release(None, {})


def test_a_test_slide_without_patches_is_counted_unscorable_not_dropped(clients, ids, monkeypatch):
    rid, _fs, dv = _engine_run(ids=ids)
    empty = sorted(_test_slides(dv))[1]
    install_fakes(monkeypatch, n_patches={empty: 0})
    lead = clients(LEAD)
    lead.post(f"/api/v1/experiments/{rid}/register")
    lead.post(f"/api/v1/experiments/{rid}/test-release", json={"reason": "final"})
    assert [o.status for o in run_jobs([RELEASE_JOB])] == ["succeeded"]
    body = lead.get(f"/api/v1/experiments/{rid}/evaluation?split=test").json()
    assert body["n_unscorable"] == 1 and [u["bag_id"] for u in body["unscored"]] == [empty]
    assert body["unscored"][0]["reason"] == "no tissue patches in the pinned artifact"
    ite = body["intention_to_evaluate"]
    pos = body["unscorable_positives"]
    assert ite["sensitivity"]["denominator"] == body["metrics"]["sensitivity"]["denominator"] + pos
    assert ite["specificity"]["denominator"] == body["metrics"]["specificity"]["denominator"] + (1 - pos)
    assert body["n_items"] == len(_test_slides(dv)) - 1
