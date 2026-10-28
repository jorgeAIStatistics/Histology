"""Adversarial verification (round 2), lens: inference identity (owner brief items 2A, 2B and 5).

Each test attacks one guarantee of the inference fix round through a realistic path (API requests, worker jobs,
active learning's scoring entry, startup migration). A test FAILS when the guarantee is violated (a reproduction)
and passes, staying as regression coverage, when it holds.

Guarantees under attack:

* scope: a bundle trained on anything but SLIDE bags never yields a slide score (API, crafted jobs, listings);
* identity: a stored prediction is the answer only for the exact input it was computed from; nothing transient,
  stale or belonging to another input identity is served or recorded as the outcome of an input snapshot;
* completeness: every extraction-affecting per-slide field is part of the snapshot identity, and extraction reads
  the job's snapshot, not live state;
* memory/numerics: the chunked pooled embedding is the exact vector the mean-pool head scores;
* migration: a real schema-v2 database (built by the code at 23a68f6) keeps every historical row verbatim.

Research use only: predictions are never labels; the negative class is "BCC absent", never "benign".
"""

from __future__ import annotations

import os
import subprocess
import sys
import tarfile
import threading
import types
from pathlib import Path

import numpy as np
import pytest
from sqlalchemy import create_engine, text

from inference_support import (
    CID,
    DIM,
    HANDCRAFTED,
    LEAD,
    fake_embeddings_for,
    fake_slide,
    prediction_rows,
    register,
    set_mpp,
    slide_run,
    snapshot_aware_fakes,
)
from ml_engine_fakes import cohort_dv, install_fakes, make_engine_run, run_jobs

ASSISTANT = "user-assistant"
SMALL_REGION = {"type": "rectangle", "x": 0, "y": 0, "width": 100, "height": 100}
V2_COMMIT = "23a68f6"


# =========================================================================== helpers


def _infer(clients, bid: str, sid: str) -> dict:
    r = clients(LEAD).post(f"/api/v1/bundles/{bid}/infer", json={"slide_id": sid})
    assert r.status_code == 202, r.text
    return r.json()


def _real_bundle(ids, clients) -> tuple[str, str]:
    """A slide-scope bundle whose extraction is REAL (handcrafted encoder on the seeded CC0 CMU slide's pixels)."""
    from dermpath.db import session_scope
    from dermpath.ml.encoders import ENCODER_SPECS
    from dermpath.ml.handcrafted import code_identity
    from dermpath.models import DatasetVersion

    with session_scope() as db:
        dv = db.get(DatasetVersion, ids["ml_demo"]["workflow"]["dataset_version_id"])
        run, _ = make_engine_run(db, dv, mode="supervised_experiment", encoder_id=HANDCRAFTED,
                                 weights_sha256=code_identity(), store_val=False,
                                 dim=ENCODER_SPECS[HANDCRAFTED].embedding_dim)
        rid = run.id
    return rid, register(clients, rid)


def _snapshot_sha(slide_id: str) -> str:
    from dermpath.db import session_scope
    from dermpath.ml import inference
    from dermpath.models import Slide

    with session_scope() as db:
        return inference.effective_input_snapshot(db, db.get(Slide, slide_id))[1]


def _resolved_exclusion(slide_id: str, region: dict) -> str:
    from dermpath.db import session_scope
    from dermpath.models import Slide
    from dermpath.qc.service import create_manual_issue, transition_issue
    from feature_set_support import actors

    a = actors()["assistant"]
    with session_scope() as db:
        issue = create_manual_issue(db, a, db.get(Slide, slide_id), category="fold", region=dict(region),
                                    note="verify2 exclusion", override_of=None, reason=None)
        transition_issue(db, a, issue, action="review", reason=None, confirmed=True)
        transition_issue(db, a, issue, action="resolve", reason="exclude for the test", resolution="excluded",
                         dataset_eligibility_effect="exclude_region")
        return issue.id


def _reopen(issue_id: str) -> None:
    from dermpath.db import session_scope
    from dermpath.models import QCIssue
    from dermpath.qc.service import transition_issue
    from feature_set_support import actors

    with session_scope() as db:
        transition_issue(db, actors()["assistant"], db.get(QCIssue, issue_id), action="reopen",
                         reason="reopened by the verify2 test")


def _job(clients, job_id: str) -> dict:
    r = clients(LEAD).get(f"/api/v1/jobs/{job_id}")
    assert r.status_code == 200, r.text
    return r.json()


def _region_run(ids) -> str:
    """A succeeded real-mode run whose training bags are neither slides nor cases (``label_scope == "region"``)."""
    from dermpath.db import session_scope

    with session_scope() as db:
        dv = cohort_dv(db, ids)
        region_dv = types.SimpleNamespace(id=dv.id, project_id=dv.project_id, manifest_json=dv.manifest_json,
                                          manifest_sha256=dv.manifest_sha256,
                                          config_json={**(dv.config_json or {}), "label_scope": "region"})
        run, _ = make_engine_run(db, region_dv, mode="supervised_experiment", encoder_id=HANDCRAFTED,
                                 weights_sha256="handcrafted:test-identity", store_val=False, dim=DIM)
        assert run.label_scope == "region"
        return run.id


def _case_run(ids) -> str:
    from dermpath.db import session_scope

    with session_scope() as db:
        dv = cohort_dv(db, ids)
        case_dv = types.SimpleNamespace(id=dv.id, project_id=dv.project_id, manifest_json=dv.manifest_json,
                                        manifest_sha256=dv.manifest_sha256,
                                        config_json={**(dv.config_json or {}), "label_scope": "case"})
        run, _ = make_engine_run(db, case_dv, mode="supervised_experiment", encoder_id=HANDCRAFTED,
                                 weights_sha256="handcrafted:test-identity", store_val=False, dim=DIM)
        return run.id


# =========================================================================== identity: transient state and races


def test_reingest_racing_an_inference_job_never_becomes_the_recorded_outcome_of_the_input(clients, ids, monkeypatch):
    """Realistic race: ``POST /slides/{id}/reingest`` (same bytes, e.g. after a reader upgrade) lands while an
    ``infer_slide`` job is loading its encoder, i.e. after the job's snapshot and before extraction. The slide is
    then briefly ``pending``. That transient state is not an input of the snapshot (the bytes, calibration, mask and
    exclusions are unchanged, and the re-ingest's auto QC job is idempotent per slide sha, so no new screen), so it
    must never be recorded as the snapshot's research outcome. Otherwise the identity is poisoned: unique per
    (bundle, slide, snapshot), the transient "unscorable" row is served as the current prediction forever, and
    active learning with diversity picks fails permanently on it (stale_prediction_refused)."""
    from dermpath.jobs.registry import PermanentJobError
    from dermpath.ml import feature_sets as fsm
    from dermpath.ml import inference

    sid = ids["slides"]["cmu_cc0"]
    _rid, bid = _real_bundle(ids, clients)
    sha_at_request = _snapshot_sha(sid)
    first = _infer(clients, bid, sid)
    real_extract = fsm.extract_slide
    state = {"reingest": None}

    def racing(slide_id, **kw):
        if state["reingest"] is None:  # the re-ingest request arrives while the job is in flight
            r = clients(ASSISTANT).post(f"/api/v1/slides/{slide_id}/reingest")
            assert r.status_code == 200, r.text
            state["reingest"] = r.json()["job_id"]
        return real_extract(slide_id, **kw)

    monkeypatch.setattr(fsm, "extract_slide", racing)
    run_jobs(["infer_slide"])
    monkeypatch.setattr(fsm, "extract_slide", real_extract)
    assert state["reingest"] is not None
    out = run_jobs(["ingest", "qc_screen"])  # the re-ingest finishes (and its auto QC, if any)
    assert [o.status for o in out if o.job_id == state["reingest"]] == ["succeeded"], [(o.status, o.error)
                                                                                       for o in out]
    # Precondition: the input identity is exactly the one the user asked about (nothing extraction-affecting moved).
    assert _snapshot_sha(sid) == sha_at_request

    violations = []
    poisoned = [p for p in prediction_rows(bid, sid) if "not ingested" in (p.unscorable_reason or "")]
    if poisoned:
        violations.append(f"prediction {poisoned[0].id} records the transient re-ingest state as the complete "
                          f"outcome of input snapshot {sha_at_request[:12]}: {poisoned[0].unscorable_reason!r} "
                          f"(provenance_status={poisoned[0].provenance_status})")
    again = _infer(clients, bid, sid)
    run_jobs(["infer_slide"])
    again = _infer(clients, bid, sid)
    cur = again["prediction"]
    if cur is None or cur["score"] is None:
        violations.append(f"the ingested, unchanged slide has no score for its current input identity: the API "
                          f"returns job {again['job_id']} (same as the first: {again['job_id'] == first['job_id']}) "
                          f"and prediction {None if cur is None else (cur['id'], cur['unscorable_reason'])}")
    try:
        inference.score_slide(bid, sid, need_embedding=True)  # active learning with diversity picks
    except PermanentJobError as exc:
        violations.append(f"active learning (need_embedding) now fails permanently on this slide: {str(exc)[:160]}")
    assert not violations, "\n".join(violations)


def test_an_input_reverted_after_its_queued_job_ran_on_another_input_can_still_be_scored(clients, ids, monkeypatch):
    """Request at input A (an exclusion is open), the QC assistant resolves the exclusion (input B) while the job is
    queued, the worker scores B (correct: the job snapshots at execution), then the exclusion is reopened: the
    input is A again. Re-requesting inference for A must eventually give a prediction for A, and the job the API
    hands back for A must not carry the score of B."""
    snapshot_aware_fakes(monkeypatch)
    sid = fake_slide()
    bid = register(clients, slide_run(ids))
    sha_a = _snapshot_sha(sid)
    r1 = _infer(clients, bid, sid)
    assert r1["input_snapshot_sha256"] == sha_a and r1["prediction"] is None
    issue = _resolved_exclusion(sid, SMALL_REGION)  # input B while the job waits in the queue
    sha_b = _snapshot_sha(sid)
    assert sha_b != sha_a
    assert [o.status for o in run_jobs(["infer_slide"])] == ["succeeded"]
    (row_b,) = prediction_rows(bid, sid)
    assert row_b.input_snapshot_sha256 == sha_b  # the job scored the input it saw: fine
    _reopen(issue)  # back to input A
    assert _snapshot_sha(sid) == sha_a

    violations = []
    r2 = _infer(clients, bid, sid)
    run_jobs(["infer_slide"])
    r2 = _infer(clients, bid, sid)
    job = _job(clients, r2["job_id"])
    if job["status"] == "succeeded" and (job["result"] or {}).get("input_snapshot_sha256") != sha_a:
        violations.append(f"POST infer for input {sha_a[:12]} hands back finished job {job['id']} whose result is "
                          f"the score {job['result'].get('score')!r} of input "
                          f"{(job['result'] or {}).get('input_snapshot_sha256', '')[:12]}")
    if r2["prediction"] is None:
        rows = prediction_rows(bid, sid)
        violations.append(f"input {sha_a[:12]} can never be scored: its idempotency key is bound to job "
                          f"{r2['job_id']} ({job['status']}), which recorded only "
                          f"{[p.input_snapshot_sha256[:12] for p in rows]}; no retry is possible for a succeeded job")
    assert not violations, "\n".join(violations)


def test_an_object_replaced_in_place_is_not_served_as_the_current_prediction(clients, ids, monkeypatch):
    """Image identity failure on the REUSE path: after a prediction exists, the slide's stored object is replaced
    in place (same key, the database sha256 unchanged: disk corruption, a manual copy, a botched restore). The
    snapshot identity is computed from the database only, so it is unchanged. Extraction fails closed on such
    bytes (``input_changed``); the reuse path must not keep presenting the old score as the prediction for the
    slide's current input, and active learning must not use it in one mode while failing in the other."""
    from dermpath.db import session_scope
    from dermpath.jobs.registry import PermanentJobError
    from dermpath.ml import feature_sets as fsm
    from dermpath.ml import inference
    from dermpath.models import Slide
    from dermpath.storage import get_store

    sid = ids["slides"]["cmu_cc0"]
    _rid, bid = _real_bundle(ids, clients)
    _infer(clients, bid, sid)
    assert [o.status for o in run_jobs(["infer_slide"])] == ["succeeded"]
    (p1,) = prediction_rows(bid, sid)
    assert p1.score is not None
    with session_scope() as db:
        key = db.get(Slide, sid).object_key
    store = get_store()
    store.put_bytes(key, store.get_bytes(key) + b"\x00replaced-in-place")
    fsm.clear_sha_memo()

    violations = []
    r = clients(LEAD).post(f"/api/v1/bundles/{bid}/infer", json={"slide_id": sid})
    if r.status_code == 202:
        run_jobs(["infer_slide"])
        body = clients(LEAD).post(f"/api/v1/bundles/{bid}/infer", json={"slide_id": sid}).json()
        if (body.get("prediction") or {}).get("id") == p1.id:
            violations.append(f"POST infer still serves prediction {p1.id} (score {p1.score:.4f}) as the prediction "
                              "for the current input although the slide's bytes no longer hash to its sha256")
    modes = {}
    for need in (False, True):
        try:
            pred, _ = inference.score_slide(bid, sid, need_embedding=need)
            modes[need] = f"returned prediction {pred['id']}"
        except PermanentJobError as exc:
            modes[need] = f"failed: {str(exc)[:60]}"
    if modes[False] != modes[True]:
        violations.append(f"active learning is inconsistent on the corrupt slide: uncertainty-only batches "
                          f"(need_embedding False) {modes[False]}; diversity batches {modes[True]}")
    assert not violations, "\n".join(violations)


def test_concurrent_jobs_on_two_inputs_each_record_exactly_their_own_snapshot(clients, ids, monkeypatch):
    """Two workers score the same (bundle, slide) while the calibration changes between their snapshots: each row
    must record the snapshot its features came from, and its score must be the model's score of those features."""
    from dermpath.ml import inference
    from inference_support import checkpoint_model

    gate = {"first_in": threading.Event(), "go": threading.Event()}

    def before_extract(_sid):
        if not gate["first_in"].is_set():
            gate["first_in"].set()
            assert gate["go"].wait(20)

    snapshot_aware_fakes(monkeypatch, before_extract=before_extract)
    sid = fake_slide()
    rid = slide_run(ids)
    bid = register(clients, rid)
    model = checkpoint_model(rid)
    results, errors = [], []

    def work():
        try:
            results.append(inference.score_slide(bid, sid, need_embedding=True))
        except Exception as exc:  # noqa: BLE001 - asserted below
            errors.append(exc)

    t1 = threading.Thread(target=work)
    t1.start()
    assert gate["first_in"].wait(20)  # worker 1 holds snapshot A and is extracting
    set_mpp(sid, 0.25)  # input B
    t2 = threading.Thread(target=work)
    t2.start()
    t2.join(30)
    gate["go"].set()
    t1.join(30)
    assert errors == [], errors
    rows = prediction_rows(bid, sid)
    assert len(rows) == 2 and len({r.input_snapshot_sha256 for r in rows}) == 2
    by_id = {r.id: r for r in rows}
    for pred, mean in results:
        row = by_id[pred["id"]]
        emb = fake_embeddings_for(sid, row.input_snapshot_json)
        assert row.score == pytest.approx(model.score(emb)[0], abs=1e-12)
        assert np.array_equal(mean, inference.embedding_mean(emb))
    assert sorted(r.input_snapshot_json["mpp_x"] for r in rows) == [0.25, 0.5]


def test_a_calibration_edit_mid_job_never_reaches_the_extraction_of_that_job(clients, ids, monkeypatch):
    """Real extraction: the effective mpp changes after the job's snapshot. The artifact must be planned with the
    snapshot's mpp (the one recorded on the prediction), and the next request must give a new row planned with the
    new mpp."""
    from dermpath.db import session_scope
    from dermpath.ml import feature_sets as fsm
    from dermpath.ml.artifacts import load_npz
    from dermpath.ml.models import FeatureArtifact
    from dermpath.storage import get_store

    sid = ids["slides"]["cmu_cc0"]
    _rid, bid = _real_bundle(ids, clients)
    real_extract = fsm.extract_slide
    state = {"old": None}

    def mutating(slide_id, **kw):
        if state["old"] is None:
            state["old"] = kw["input_snapshot"]["mpp_x"]
            set_mpp(slide_id, state["old"] * 0.8)
        return real_extract(slide_id, **kw)

    def planned_mpp(art_id):
        with session_scope() as db:
            qkey = db.get(FeatureArtifact, art_id).quality_key
        _arrays, meta = load_npz(get_store().get_bytes(qkey))
        return meta["scale"]["slide_mpp"]

    monkeypatch.setattr(fsm, "extract_slide", mutating)
    _infer(clients, bid, sid)
    assert [o.status for o in run_jobs(["infer_slide"])] == ["succeeded"]
    (p1,) = prediction_rows(bid, sid)
    assert p1.input_snapshot_json["mpp_x"] == state["old"]
    assert planned_mpp(p1.feature_artifact_id)[0] == pytest.approx(state["old"]), (
        "the extraction was planned with a calibration other than the job's recorded snapshot")
    _infer(clients, bid, sid)
    assert [o.status for o in run_jobs(["infer_slide"])] == ["succeeded"]
    p2 = prediction_rows(bid, sid)[-1]
    assert p2.id != p1.id and p2.input_snapshot_json["mpp_x"] == pytest.approx(state["old"] * 0.8)
    assert planned_mpp(p2.feature_artifact_id)[0] == pytest.approx(state["old"] * 0.8)


# =========================================================================== identity: completeness and legacy rows


def test_every_extraction_affecting_slide_field_is_part_of_the_snapshot_identity():
    """``plan_scale``/``_prepare``/the reader consume these per-slide fields; each one changes the identity, and the
    prediction-record keys (outputs) never do."""
    from dermpath.ml import feature_sets as fsm
    from dermpath.ml import inference

    base_slide = dict(id="s1", sha256="a" * 64, object_key="k/original.svs", image_kind="wsi",
                      provenance="public_cc0", format="aperio", mpp_x=0.5, mpp_y=0.5, width=2000, height=1500,
                      level_downsamples_json=[1.0, 4.0])
    base_qc = {"qc_review_id": "r1", "mask_object_key": "m/1.png", "mask_sha256": "b" * 64,
               "mask_downsample": [16.0, 16.0], "excluded_issue_ids": ["i1"],
               "excluded_regions": [{"issue_id": "i1", "category": "fold", "region": dict(SMALL_REGION)}],
               "excluded_regions_sha256": "c" * 64, "qc_source": "live_qc_at_inference"}

    def sha(slide_over=None, qc_over=None):
        s = types.SimpleNamespace(**{**base_slide, **(slide_over or {})})
        return inference.snapshot_sha256(fsm.slide_snapshot(s, {**base_qc, **(qc_over or {})}))

    base = sha()
    slide_changes = {"sha256": "d" * 64, "object_key": "k/other.svs", "image_kind": "field_image",
                     "provenance": "real_authorized", "format": "tiff", "mpp_x": 0.25, "mpp_y": 0.25,
                     "width": 2001, "height": 1499, "level_downsamples_json": [1.0, 2.0]}
    qc_changes = {"qc_review_id": "r2", "mask_object_key": "m/2.png", "mask_sha256": "e" * 64,
                  "mask_downsample": [8.0, 8.0], "excluded_issue_ids": [], "excluded_regions": [],
                  "excluded_regions_sha256": "f" * 64}
    same = [k for k, v in slide_changes.items() if sha(slide_over={k: v}) == base]
    same += [k for k, v in qc_changes.items() if sha(qc_over={k: v}) == base]
    assert same == [], f"extraction-affecting fields outside the snapshot identity: {same}"
    snap = fsm.slide_snapshot(types.SimpleNamespace(**base_slide), base_qc)
    record = {**snap, "schema": "x", "input_snapshot_sha256": "y", "n_patches": 3, "feature_artifact_id": "z",
              "features": {"n_patches": 3}}
    assert inference.snapshot_sha256(record) == base  # stored record re-hashes to its identity


def test_legacy_rows_are_never_reused_even_when_their_snapshot_equals_the_current_input(clients, ids, monkeypatch):
    """A historical row (``legacy_unverified``) whose stored snapshot is byte-for-byte the slide's current snapshot
    is still never the answer: neither the API's ``prediction`` nor the worker's reuse nor active learning."""
    calls = snapshot_aware_fakes(monkeypatch)
    from dermpath.db import session_scope
    from dermpath.ml import inference
    from dermpath.ml.engine_models import InferencePrediction
    from dermpath.models import Slide

    sid = fake_slide()
    bid = register(clients, slide_run(ids))
    with session_scope() as db:
        snap, _sha = inference.effective_input_snapshot(db, db.get(Slide, sid))
        legacy = InferencePrediction(project_id=CID, bundle_id=bid, slide_id=sid, slide_sha256=snap["slide_sha256"],
                                     score=0.987654, threshold=0.5, predicted=1, abstained=False,
                                     input_snapshot_json=dict(snap), created_by="system:worker")
        db.add(legacy)
        db.flush()
        legacy_id = legacy.id
    r = _infer(clients, bid, sid)
    assert r["prediction"] is None and r["other_predictions_for_slide"] == 1
    pred, _ = inference.score_slide(bid, sid, need_embedding=False)
    assert pred["id"] != legacy_id and pred["score"] != 0.987654 and len(calls.extract) == 1
    pred2, mean = inference.score_slide(bid, sid, need_embedding=True)
    assert pred2["id"] == pred["id"] and mean is not None
    rows = prediction_rows(bid, sid)
    assert [p.provenance_status for p in rows] == ["legacy_unverified", "complete"]
    assert rows[0].score == 0.987654  # history kept verbatim


# =========================================================================== scope


@pytest.mark.parametrize("scope", ["case", "region"])
def test_no_slide_score_from_a_non_slide_bundle_through_any_path(clients, ids, monkeypatch, scope):
    """API (409), a crafted ``infer_slide`` job (with an unrelated idempotency key), the scoring entry used by
    active learning, an active-learning payload pointing a slide run's job at this bundle, and the listing of a
    historical row (marked, never reusable, never offered as the current prediction)."""
    calls = install_fakes(monkeypatch)
    from dermpath.db import session_scope
    from dermpath.jobs import queue
    from dermpath.jobs.registry import PermanentJobError
    from dermpath.ml import inference
    from dermpath.ml.engine_models import InferencePrediction
    from dermpath.ml.models import TrainingRun
    from dermpath.models import new_id

    sid = fake_slide()
    rid = _case_run(ids) if scope == "case" else _region_run(ids)
    bid = register(clients, rid)
    lead = clients(LEAD)
    b = lead.get(f"/api/v1/bundles/{bid}").json()
    assert b["can_infer"] is False and b["inference_refusal_code"] == "scope_mismatch" and b["label_scope"] == scope
    r = lead.post(f"/api/v1/bundles/{bid}/infer", json={"slide_id": sid})
    assert r.status_code == 409 and r.json()["error"]["code"] == "scope_mismatch", r.text
    with session_scope() as db:
        queue.enqueue(db, "infer_slide", {"bundle_id": bid, "slide_id": sid, "note": "crafted"},
                      idempotency_key=f"crafted:{new_id()}", project_id=CID, created_by=LEAD)
    out = run_jobs(["infer_slide"])
    assert [o.status for o in out] == ["failed"] and "scope_mismatch" in out[0].error
    for need in (False, True):
        with pytest.raises(PermanentJobError, match="scope_mismatch"):
            inference.score_slide(bid, sid, need_embedding=need)
    # An active-learning job of a SLIDE run whose payload names this bundle is refused (bundle/run mismatch).
    slide_rid = slide_run(ids)
    register(clients, slide_rid)
    batch_id = new_id()
    with session_scope() as db:
        dv_id = db.get(TrainingRun, slide_rid).dataset_version_id
        queue.enqueue(db, "active_learning",
                      {"batch_id": batch_id, "run_id": slide_rid, "bundle_id": bid, "dataset_version_id": dv_id,
                       "k": 2, "random_fraction": 0.0, "uncertainty_fraction": 1.0, "seed": 0,
                       "pool_slide_ids": [sid]},
                      idempotency_key=f"al:{batch_id}", project_id=CID, created_by=LEAD)
    out = run_jobs(["active_learning"])
    assert [o.status for o in out] == ["failed"], [(o.status, o.error) for o in out]
    assert calls.extract == [] and prediction_rows(bid) == []
    # A historical row of this bundle (scored before the scope rule) is listed as history only.
    with session_scope() as db:
        db.add(InferencePrediction(project_id=CID, bundle_id=bid, slide_id=sid, slide_sha256="0" * 64, score=0.9,
                                   threshold=0.5, predicted=1, abstained=False, input_snapshot_json={},
                                   created_by="system:worker"))
    (item,) = lead.get(f"/api/v1/bundles/{bid}/predictions").json()["items"]
    assert item["reusable"] is False and "scope_warning" in item and item["provenance_status"] == "legacy_unverified"
    r = lead.post(f"/api/v1/bundles/{bid}/infer", json={"slide_id": sid})
    assert r.status_code == 409 and "prediction" not in r.json()


# =========================================================================== bounded memory and numerics


def test_chunked_mean_is_exactly_the_vector_the_meanpool_head_scores(tmp_path, clients, ids, monkeypatch):
    """The diversity embedding returned with a score is bit-identical to the pooled vector the meanpool head
    scored (memory-mapped bag, row count not a multiple of the chunk), float64, and within float64 rounding of the
    exact mean."""
    from dermpath.ml import heads, inference
    from dermpath.ml.heads import LoadedModel
    from dermpath.ml.models import TrainingRun

    n = 2 * heads.MEAN_CHUNK_ROWS + 17
    rng = np.random.default_rng(7)
    path = tmp_path / "emb.npy"
    np.save(path, (rng.normal(size=(n, DIM)) * 0.5 + 0.03).astype(np.float32))
    mm = np.load(path, mmap_mode="r")
    seen = []
    real_score_mean = LoadedModel.score_mean

    def spy(self, x):
        seen.append(np.array(x, copy=True))
        return real_score_mean(self, x)

    monkeypatch.setattr(LoadedModel, "score_mean", spy)
    # Only the extraction is faked (it serves the memory-mapped bag); scoring is the real checkpoint path.
    from dermpath.ml import feature_sets as fsm
    from dermpath.ml.artifacts import extraction_env
    from ml_engine_fakes import FakeSlideFeatures

    def extract(slide_id, *, weights_sha256, encoder_spec_sha256, patch_policy, stain_policy, device, precision,
                input_snapshot, **_):
        return FakeSlideFeatures(slide_id=slide_id, embeddings=mm, coords=np.zeros((n, 2), np.int64),
                                 weights_sha256=weights_sha256, encoder_spec_sha256=encoder_spec_sha256,
                                 policy_sha256=patch_policy.policy_sha256, n_patches=n,
                                 stain_policy_sha256=stain_policy.policy_sha256,
                                 extraction_env_sha256=extraction_env(device, precision)[1],
                                 meta={"fields": {"extractor_version": fsm.EXTRACTOR_VERSION}})

    monkeypatch.setattr(fsm, "extract_slide", extract)
    sid = fake_slide()
    rid = slide_run(ids)
    bid = register(clients, rid)
    pred, mean = inference.score_slide(bid, sid, need_embedding=True)
    assert len(seen) == 1, "the meanpool head was not scored through LoadedModel.score_mean"
    assert mean.dtype == np.float64 and seen[0].dtype == np.float64
    assert np.array_equal(mean, seen[0]), "the diversity embedding is not the pooled vector the head scored"
    exact = np.asarray(mm, dtype=np.float64).sum(axis=0) / n
    assert np.allclose(mean, exact, rtol=1e-14, atol=0)
    from dermpath.db import session_scope

    with session_scope() as db:
        run = db.get(TrainingRun, rid)
        assert run.head == "meanpool_logreg"
    assert pred["score"] == pytest.approx(real_score_mean(_model(rid), mean), abs=0)


def _model(rid):
    from inference_support import checkpoint_model

    return checkpoint_model(rid)


# =========================================================================== migration of a real v2 database


def _export_v2_code(dest: Path) -> Path | None:
    root = Path(__file__).resolve().parents[3]
    try:
        tar = subprocess.run(["git", "-C", str(root), "archive", V2_COMMIT, "workbench/api/dermpath"],
                             capture_output=True, check=True, timeout=60).stdout
    except (OSError, subprocess.SubprocessError):
        return None
    tar_path = dest / "v2.tar"
    tar_path.write_bytes(tar)
    with tarfile.open(tar_path) as tf:
        tf.extractall(dest, filter="data")
    return dest / "workbench" / "api"


V2_DDL = r"""
import json, sys
sys.path.insert(0, sys.argv[1])
from sqlalchemy import create_engine, text
from dermpath.db import init_db
eng = create_engine("sqlite:///" + sys.argv[2])
init_db(eng)
with eng.connect() as c:
    rows = c.execute(text("SELECT type, name, sql FROM sqlite_master WHERE tbl_name = 'inference_prediction' "
                          "AND sql IS NOT NULL ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END, "
                          "name")).all()
print(json.dumps([list(r) for r in rows]))
eng.dispose()
"""

V2_INSERT = ("INSERT INTO inference_prediction (id, project_id, bundle_id, slide_id, slide_sha256, feature_artifact_id, "
             "job_id, score, calibrated_score, threshold, predicted, abstained, unscorable_reason, coverage_json, "
             "attention_key, attention_sha256, input_snapshot_json, research_use_only, created_by, created_at) VALUES "
             "(:id, :pid, :bid, :sid, :sha, NULL, 'job-legacy', :score, :score, 0.5, :pred, 0, :why, '{\"n\": 1}', "
             "NULL, NULL, :snap, 1, 'system:worker', '2026-10-27 10:00:00.123456')")


def test_a_real_schema_v2_database_keeps_every_historical_row_through_startup(tmp_path, clients, ids, monkeypatch):
    """The ``inference_prediction`` table, indexes and append-only triggers are exactly those the code at the
    reviewed commit (23a68f6) creates; its rows reference a real project, bundle and slides of a seeded database.
    The current startup path (``init_db`` on an engine configured like the app's: WAL, foreign keys ON) must keep
    every historical row and value, mark them legacy, leave nothing referencing the renamed temporary table, keep
    the append-only triggers and the foreign-key integrity, keep the schema version, and a second start is a
    no-op. A migrated row is never reused by inference."""
    import json
    import shutil

    from sqlalchemy.exc import DatabaseError

    from dermpath.config import get_settings
    from dermpath.db import SCHEMA_VERSION, _configure_sqlite, init_db, reset_engine

    api = _export_v2_code(tmp_path)
    if api is None or not (api / "dermpath" / "db.py").is_file():
        pytest.skip(f"git history with {V2_COMMIT} is not available")
    env = {k: v for k, v in os.environ.items() if not k.startswith("WB_")}
    done = subprocess.run([sys.executable, "-c", V2_DDL, str(api), str(tmp_path / "empty_v2.db")],
                          capture_output=True, text=True, timeout=120, env=env, cwd=str(tmp_path))
    assert done.returncode == 0, done.stderr[-2000:]
    ddl = json.loads(done.stdout.strip().splitlines()[-1])
    assert ddl[0][0] == "table" and "uq_inference_prediction_slide" in ddl[0][2]

    snapshot_aware_fakes(monkeypatch)
    s1, s2 = fake_slide(tag="v2a"), fake_slide(tag="v2b")
    bid = register(clients, slide_run(ids))
    src = Path(get_settings().db_url.split("sqlite:///", 1)[1])
    reset_engine()  # checkpoint the WAL and close the app's connections before copying
    db_path = tmp_path / "v2_seeded.db"
    shutil.copyfile(src, db_path)

    eng = create_engine(f"sqlite:///{db_path}", future=True)
    _configure_sqlite(eng)
    with eng.begin() as c:  # downgrade inference_prediction to the reviewed commit's exact definition
        c.exec_driver_sql("DROP TABLE inference_prediction")
        for _type, _name, sql in ddl:
            c.exec_driver_sql(sql)
        for rid, sid, score, pred, why, snap in (
                ("legacy-a", s1, 0.8125, 1, None, '{"slide_sha256": "aa", "n_patches": 6, "mpp_x": 0.5}'),
                ("legacy-b", s2, None, None, "FeatureError: scale_refused", '{"slide_sha256": "bb"}')):
            c.execute(text(V2_INSERT), {"id": rid, "pid": CID, "bid": bid, "sid": sid, "sha": rid * 2,
                                        "score": score, "pred": pred, "why": why, "snap": snap})
    with eng.connect() as c:
        before = [dict(r) for r in c.execute(text("SELECT * FROM inference_prediction ORDER BY id")).mappings()]
        v_before = c.execute(text("SELECT version FROM schema_version ORDER BY id")).scalars().all()
        assert c.exec_driver_sql("PRAGMA foreign_key_check").fetchall() == []
    eng.dispose()
    assert len(before) == 2 and set(v_before) == {SCHEMA_VERSION}

    eng = create_engine(f"sqlite:///{db_path}", future=True)
    _configure_sqlite(eng)
    init_db(eng)
    with eng.connect() as c:
        after = [dict(r) for r in c.execute(text("SELECT * FROM inference_prediction ORDER BY id")).mappings()]
        schema_sql = [r[0] or "" for r in c.execute(text("SELECT sql FROM sqlite_master"))]
        names = {r[0] for r in c.execute(text("SELECT name FROM sqlite_master WHERE tbl_name = "
                                              "'inference_prediction'"))}
        fk_after = c.exec_driver_sql("PRAGMA foreign_key_check").fetchall()
        integrity = c.exec_driver_sql("PRAGMA integrity_check").scalar()
        versions = c.execute(text("SELECT version FROM schema_version ORDER BY id")).scalars().all()
    assert [{k: r[k] for k in before[0]} for r in after] == before, "historical values were not kept verbatim"
    assert all(r["provenance_status"] == "legacy_unverified" and r["input_snapshot_sha256"] is None
               and r["subject_scope"] is None for r in after)
    assert not [q for q in schema_sql if "schema_v2" in q], "objects still reference the renamed temporary table"
    assert {"inference_prediction_no_update", "inference_prediction_no_delete"} <= names
    assert integrity == "ok" and fk_after == []
    assert set(versions) == {SCHEMA_VERSION} and len(versions) == len(v_before) + 1
    for sql in ("UPDATE inference_prediction SET score = 0.2 WHERE id = 'legacy-a'",
                "DELETE FROM inference_prediction WHERE id = 'legacy-b'"):
        with pytest.raises(DatabaseError, match="append-only"), eng.begin() as c:
            c.execute(text(sql))
    init_db(eng)  # second start: nothing to do
    with eng.connect() as c:
        assert len(c.execute(text("SELECT version FROM schema_version")).scalars().all()) == len(versions)
        again = [dict(r) for r in c.execute(text("SELECT * FROM inference_prediction ORDER BY id")).mappings()]
    assert again == after
    eng.dispose()

    # Point the app at the migrated database: the legacy rows are listed as history and never reused.
    shutil.copyfile(db_path, src)
    for suffix in ("-wal", "-shm"):
        Path(str(src) + suffix).unlink(missing_ok=True)
    reset_engine()
    from dermpath.ml import inference

    items = clients(LEAD).get(f"/api/v1/bundles/{bid}/predictions").json()["items"]
    assert [i["id"] for i in items] == ["legacy-a", "legacy-b"]
    assert all(i["provenance_status"] == "legacy_unverified" and i["reusable"] is False for i in items)
    assert _infer(clients, bid, s1)["prediction"] is None
    pred, _ = inference.score_slide(bid, s1, need_embedding=False)
    assert pred["id"] != "legacy-a" and pred["provenance_status"] == "complete"
