"""Inference request/answer identity (verify2 inference round, design §8 "Request chain" and "Transient state").

* Only outcomes that are deterministic functions of the input snapshot (and the bundle) are recorded as the
  snapshot's research outcome. A slide whose ingest state moved after the job's snapshot (a re-ingest in flight) is
  retried (``input_not_ready``) and nothing is recorded; worker-side refusals (extraction environment or code) fail
  the job and record nothing.
* ``POST /bundles/{id}/infer`` always hands back a job that answers the CURRENT input identity: when the newest job
  of that identity finished on another identity, failed or was canceled, a new job (``…:r{n}``) is enqueued, and
  duplicate re-requests share it.
* A stored prediction is served (API, reuse path of the worker and of active learning) only after the slide's
  stored image and QC mask objects are verified against its snapshot; otherwise ``input_changed`` (409 in the API).

Research use only: predictions are never labels.
"""

from __future__ import annotations

import hashlib

import pytest

from inference_support import CID, HANDCRAFTED, LEAD, fake_slide, prediction_rows, register, slide_run, \
    snapshot_aware_fakes
from ml_engine_fakes import make_engine_run, run_jobs


def _infer(clients, bid: str, sid: str) -> dict:
    r = clients(LEAD).post(f"/api/v1/bundles/{bid}/infer", json={"slide_id": sid})
    assert r.status_code == 202, r.text
    return r.json()


def _job(job_id: str):
    from dermpath.db import session_scope
    from dermpath.models import Job

    with session_scope() as db:
        job = db.get(Job, job_id)
        db.expunge(job)
        return job


def _snapshot_sha(slide_id: str) -> str:
    from dermpath.db import session_scope
    from dermpath.ml import inference
    from dermpath.models import Slide

    with session_scope() as db:
        return inference.effective_input_snapshot(db, db.get(Slide, slide_id))[1]


def test_a_transient_ingest_state_is_retried_never_recorded_and_a_re_request_scores_the_input(clients, ids,
                                                                                              monkeypatch):
    from dermpath.ml import feature_sets as fsm
    from dermpath.ml.features import FeatureError

    state = {"pending": True}

    def before_extract(slide_id):
        if state["pending"]:  # what feature_sets._prepare raises while a re-ingest is in flight
            raise FeatureError(f"{fsm.NOT_INGESTED}: slide {slide_id} is not ingested (pending)")

    snapshot_aware_fakes(monkeypatch, before_extract=before_extract)
    sid = fake_slide()
    bid = register(clients, slide_run(ids))
    sha = _snapshot_sha(sid)
    first = _infer(clients, bid, sid)
    out = run_jobs(["infer_slide"])
    assert out[0].status == "queued" and "input_not_ready" in out[0].error  # retried, not a permanent failure
    assert {o.status for o in out} <= {"queued", "failed"}
    assert prediction_rows(bid, sid) == []  # the transient state is never a snapshot's outcome
    assert _job(first["job_id"]).status == "failed"  # attempts exhausted while the slide stayed "pending"

    state["pending"] = False  # the re-ingest finished; the input identity is unchanged
    assert _snapshot_sha(sid) == sha
    again = _infer(clients, bid, sid)
    assert again["job_id"] != first["job_id"]  # a failed job does not answer the request: a new one
    assert _infer(clients, bid, sid)["job_id"] == again["job_id"]  # duplicate re-requests share it
    new_job = _job(again["job_id"])
    assert new_job.idempotency_key.endswith(f"{sha}:r1")
    assert new_job.payload_json["expected_input_snapshot_sha256"] == sha
    assert [o.status for o in run_jobs(["infer_slide"])] == ["succeeded"]
    final = _infer(clients, bid, sid)
    assert final["job_id"] == again["job_id"]
    assert final["prediction"] is not None and final["prediction"]["score"] is not None
    result = _job(final["job_id"]).result_json
    assert result["input_snapshot_sha256"] == sha and result["input_changed_since_request"] is False


@pytest.mark.parametrize("prefix", ["extraction_env_changed", "extraction_code_changed"])
def test_worker_side_refusals_fail_the_job_and_are_never_recorded(clients, ids, monkeypatch, prefix):
    from dermpath.ml.features import FeatureError

    def before_extract(_slide_id):
        raise FeatureError(f"{prefix}: this worker is not the bundle's")

    snapshot_aware_fakes(monkeypatch, before_extract=before_extract)
    sid = fake_slide()
    bid = register(clients, slide_run(ids))
    _infer(clients, bid, sid)
    out = run_jobs(["infer_slide"])
    assert [o.status for o in out] == ["failed"] and prefix in out[0].error
    assert prediction_rows(bid, sid) == []


def test_a_mask_object_replaced_in_place_fails_the_reuse_check(ids):
    """The reuse-path check covers the QC mask object as well as the image (extraction checks both)."""
    from dermpath.db import session_scope
    from dermpath.ml import feature_sets as fsm
    from dermpath.ml import inference
    from dermpath.models import Slide
    from dermpath.storage import get_store

    sid = ids["slides"]["cmu_cc0"]
    with session_scope() as db:
        slide = db.get(Slide, sid)
        snap, _ = inference.effective_input_snapshot(db, slide)
        db.expunge(slide)
    store = get_store()
    key, data = f"projects/{CID}/verify2/mask-{sid}.png", b"verify2 mask bytes"
    store.put_bytes(key, data)
    snap = {**snap, "mask_object_key": key, "mask_sha256": hashlib.sha256(data).hexdigest()}
    fsm.verify_snapshot_objects(slide, snap)  # unchanged objects: no error
    store.put_bytes(key, data + b"\x00")
    with pytest.raises(fsm.FeatureError, match="input_changed: mask object"):
        fsm.verify_snapshot_objects(slide, snap)


def test_an_image_replaced_in_place_is_refused_by_the_api_and_by_both_worker_modes(clients, ids):
    from dermpath.db import session_scope
    from dermpath.jobs.registry import PermanentJobError
    from dermpath.ml import feature_sets as fsm
    from dermpath.ml import inference
    from dermpath.ml.encoders import ENCODER_SPECS
    from dermpath.ml.handcrafted import code_identity
    from dermpath.models import DatasetVersion, Slide
    from dermpath.storage import get_store

    sid = ids["slides"]["cmu_cc0"]
    with session_scope() as db:
        dv = db.get(DatasetVersion, ids["ml_demo"]["workflow"]["dataset_version_id"])
        run, _ = make_engine_run(db, dv, mode="supervised_experiment", encoder_id=HANDCRAFTED,
                                 weights_sha256=code_identity(), store_val=False,
                                 dim=ENCODER_SPECS[HANDCRAFTED].embedding_dim)
        rid = run.id
    bid = register(clients, rid)
    _infer(clients, bid, sid)
    assert [o.status for o in run_jobs(["infer_slide"])] == ["succeeded"]
    (p1,) = prediction_rows(bid, sid)
    assert _infer(clients, bid, sid)["prediction"]["id"] == p1.id  # unchanged objects: the stored score is served
    with session_scope() as db:
        key = db.get(Slide, sid).object_key
    store = get_store()
    store.put_bytes(key, store.get_bytes(key) + b"\x00replaced-in-place")
    fsm.clear_sha_memo()
    r = clients(LEAD).post(f"/api/v1/bundles/{bid}/infer", json={"slide_id": sid})
    assert r.status_code == 409 and r.json()["error"]["code"] == "input_changed", r.text
    for need in (False, True):  # uncertainty-only and diversity active-learning batches agree: both refuse
        with pytest.raises(PermanentJobError, match="input_changed"):
            inference.score_slide(bid, sid, need_embedding=need)
    assert [p.id for p in prediction_rows(bid, sid)] == [p1.id]  # history kept, nothing new recorded

