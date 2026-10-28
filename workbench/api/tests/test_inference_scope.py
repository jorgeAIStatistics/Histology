"""Inference scope (owner brief item 2A): a bundle trained on CASE bags must never score a single slide.

A case-level model outputs a probability for a case's complete set of eligible slides, aggregated as in
training; one slide fed through it as if it were a case is a different question, and its score is not a slide
probability. Every slide path must fail closed with an actionable ``scope_mismatch``: the single-slide API
(409), the ``infer_slide`` worker (defence in depth, e.g. a job enqueued by older code), and the active-learning
acquisition path (which scores slides through :func:`dermpath.ml.inference.score_slide`). Slide-scope bundles keep
working. Research use only; the negative class is "BCC absent", never "benign".
"""

from __future__ import annotations

import pytest
from sqlalchemy import func, select

from inference_support import CID, LEAD, case_run, fake_slide, prediction_rows, register, slide_run
from ml_engine_fakes import install_fakes, run_jobs


def _job_count(job_type: str) -> int:
    from dermpath.db import session_scope
    from dermpath.models import Job

    with session_scope() as db:
        return db.scalar(select(func.count(Job.id)).where(Job.type == job_type))


def test_single_slide_endpoint_refuses_a_case_scoped_bundle_and_keeps_slide_inference(clients, ids, monkeypatch):
    calls = install_fakes(monkeypatch)
    lead = clients(LEAD)
    sid = fake_slide()
    case_bid = register(clients, case_run(ids))
    got = lead.get(f"/api/v1/bundles/{case_bid}").json()
    assert got["content"]["classes"]["label_scope"] == "case"
    # The bundle says up front that it cannot score single slides, and why.
    assert got["can_infer"] is False and "scope" in (got["inference_refusal"] or "").lower()
    before = _job_count("infer_slide")
    r = lead.post(f"/api/v1/bundles/{case_bid}/infer", json={"slide_id": sid})
    assert r.status_code == 409, r.text
    err = r.json()["error"]
    assert err["code"] == "scope_mismatch"
    msg = err["message"].lower()
    assert "case" in msg and "slide" in msg  # actionable: says what the bundle is and what the endpoint needs
    assert _job_count("infer_slide") == before and calls.extract == []
    assert prediction_rows(case_bid) == []
    # Valid slide inference is preserved.
    slide_bid = register(clients, slide_run(ids))
    r = lead.post(f"/api/v1/bundles/{slide_bid}/infer", json={"slide_id": sid})
    assert r.status_code == 202, r.text
    out = run_jobs(["infer_slide"])
    assert [o.status for o in out] == ["succeeded"], [o.error for o in out]
    (p,) = lead.get(f"/api/v1/bundles/{slide_bid}/predictions").json()["items"]
    assert p["slide_id"] == sid and p["score"] is not None and p["is_label"] is False
    assert p["bag_scope"] == "slide" and "case" not in p["bag_scope"]


def test_infer_slide_worker_refuses_a_case_scoped_bundle(clients, ids, monkeypatch):
    """A job that reaches the worker without the API check (enqueued directly) still fails closed."""
    calls = install_fakes(monkeypatch)
    from dermpath.db import session_scope
    from dermpath.jobs import queue
    from dermpath.jobs.registry import PermanentJobError
    from dermpath.ml import inference

    sid = fake_slide()
    bid = register(clients, case_run(ids))
    with session_scope() as db:
        queue.enqueue(db, "infer_slide", {"bundle_id": bid, "slide_id": sid}, idempotency_key=f"direct:{bid}:{sid}",
                      project_id=CID, created_by=LEAD)
    out = run_jobs(["infer_slide"])
    assert [o.status for o in out] == ["failed"], [o.error for o in out]
    assert "scope_mismatch" in out[0].error
    assert calls.extract == [] and prediction_rows(bid) == []
    # The scoring entry used by every slide path (infer_slide, active learning) refuses too.
    with pytest.raises(PermanentJobError, match="scope_mismatch"):
        inference.score_slide(bid, sid)
    with pytest.raises(PermanentJobError, match="scope_mismatch"):
        inference.score_slide(bid, sid, need_embedding=False)
    assert calls.extract == [] and prediction_rows(bid) == []


def test_active_learning_never_scores_slides_with_a_case_scoped_bundle(clients, ids, monkeypatch):
    """The slide acquisition path: no case probability is ever attached to a slide proposal. Either the request
    is refused with ``scope_mismatch`` or the batch carries no model score and says why (no prediction rows)."""
    calls = install_fakes(monkeypatch)
    from dermpath.db import session_scope
    from dermpath.ml import active_learning
    from dermpath.ml.engine_models import ALProposal, InferencePrediction
    from dermpath.models import Job

    pool_ids = sorted(fake_slide(tag=f"al{i}") for i in range(4))
    fake_pool = [{"slide_id": s, "coded_patient_id": f"pt-scope-{i}", "patient_code": None, "case_id": None,
                  "pool_reason": "no_reference_label", "family_split": "new_to_family",
                  "patient_in_training_set": False} for i, s in enumerate(pool_ids)]
    monkeypatch.setattr(active_learning, "development_pool", lambda db, run, dv: (list(fake_pool), {}))
    rid = case_run(ids)
    register(clients, rid)
    r = clients(LEAD).post(f"/api/v1/projects/{CID}/active-learning",
                           json={"run_id": rid, "k": 3, "random_fraction": 0.0})
    if r.status_code == 409:
        assert r.json()["error"]["code"] == "scope_mismatch", r.text
    else:
        assert r.status_code == 202, r.text
        out = run_jobs(["active_learning"])
        assert len(out) == 1
        if out[0].status == "failed":
            assert "scope_mismatch" in out[0].error
        else:
            with session_scope() as db:
                job = db.scalars(select(Job).where(Job.type == "active_learning")).one()
                result = job.result_json or {}
                rows = db.scalars(select(ALProposal).where(ALProposal.run_id == rid)).all()
                # (proposals may also be dropped at commit by the cohort-protection rules; none carries a score)
                assert all((p.components_json or {}).get("model_score") is None for p in rows)
                assert all(p.strategy == "random" for p in rows)
            assert "scope mismatch" in (result.get("unscorable_reason") or "").lower()
            assert result["composition"]["uncertainty"] == 0 and result["composition"]["diversity"] == 0
    assert calls.extract == []
    with session_scope() as db:
        assert db.scalar(select(func.count(InferencePrediction.id))) == 0


def test_active_learning_request_with_a_case_scoped_bundle_is_refused_up_front(clients, ids, monkeypatch):
    """Integration (stricter than the test above): POST /projects/{pid}/active-learning fails closed with 409
    ``scope_mismatch`` before any job is enqueued, naming the bundle's scope, instead of accepting the request and
    producing a random-only batch whose proposals are attributed to a model that cannot score slides."""
    calls = install_fakes(monkeypatch)
    from dermpath.ml import active_learning

    pool_ids = sorted(fake_slide(tag=f"alr{i}") for i in range(3))
    fake_pool = [{"slide_id": s, "coded_patient_id": f"pt-scope-r{i}", "patient_code": None, "case_id": None,
                  "pool_reason": "no_reference_label", "family_split": "new_to_family",
                  "patient_in_training_set": False} for i, s in enumerate(pool_ids)]
    monkeypatch.setattr(active_learning, "development_pool", lambda db, run, dv: (list(fake_pool), {}))
    rid = case_run(ids)
    bid = register(clients, rid)
    before = _job_count("active_learning")
    r = clients(LEAD).post(f"/api/v1/projects/{CID}/active-learning",
                           json={"run_id": rid, "k": 2, "random_fraction": 0.0})
    assert r.status_code == 409, r.text
    err = r.json()["error"]
    assert err["code"] == "scope_mismatch"
    assert "case" in err["message"].lower() and "slide" in err["message"].lower()
    details = err.get("details") or {}
    assert details.get("bundle_label_scope") == "case" and details.get("bundle_id") == bid
    assert _job_count("active_learning") == before and calls.extract == []


def test_active_learning_worker_fails_closed_on_a_case_scoped_bundle(clients, ids, monkeypatch):
    """Defence in depth: an active-learning job that reaches the worker without the API check (enqueued directly,
    e.g. by older code) fails with ``scope_mismatch``; it records no proposal, no acquisition exposure, no
    prediction and extracts nothing."""
    calls = install_fakes(monkeypatch)
    from dermpath.db import session_scope
    from dermpath.jobs import queue
    from dermpath.ml import active_learning
    from dermpath.ml.engine_models import ALProposal, InferencePrediction
    from dermpath.ml.models import TrainingRun
    from dermpath.models import AcquisitionExposure, new_id

    pool_ids = sorted(fake_slide(tag=f"alw{i}") for i in range(3))
    fake_pool = [{"slide_id": s, "coded_patient_id": f"pt-scope-w{i}", "patient_code": None, "case_id": None,
                  "pool_reason": "no_reference_label", "family_split": "new_to_family",
                  "patient_in_training_set": False} for i, s in enumerate(pool_ids)]
    monkeypatch.setattr(active_learning, "development_pool", lambda db, run, dv: (list(fake_pool), {}))
    rid = case_run(ids)
    bid = register(clients, rid)
    batch_id = new_id()
    with session_scope() as db:
        run = db.get(TrainingRun, rid)
        queue.enqueue(db, "active_learning",
                      {"batch_id": batch_id, "run_id": rid, "bundle_id": bid,
                       "dataset_version_id": run.dataset_version_id, "k": 2, "random_fraction": 0.5,
                       "uncertainty_fraction": 0.5, "seed": 0, "pool_slide_ids": pool_ids},
                      idempotency_key=f"al:{batch_id}", project_id=CID, created_by=LEAD)
    out = run_jobs(["active_learning"])
    assert [o.status for o in out] == ["failed"], [(o.status, o.error) for o in out]
    assert "scope_mismatch" in out[0].error
    assert calls.extract == []
    with session_scope() as db:
        assert db.scalars(select(ALProposal).where(ALProposal.batch_id == batch_id)).all() == []
        assert db.scalar(select(func.count(AcquisitionExposure.id))
                         .where(AcquisitionExposure.batch_id == batch_id)) == 0
        assert db.scalar(select(func.count(InferencePrediction.id))
                         .where(InferencePrediction.bundle_id == bid)) == 0
