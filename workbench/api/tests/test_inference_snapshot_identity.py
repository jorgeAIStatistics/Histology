"""One canonical input snapshot per inference (owner brief item 2B).

The ``infer_slide`` job takes ONE canonical effective input snapshot of the slide when it executes (image identity,
effective mpp/calibration, QC mask and excluded-region content: the per-slide state the feature-set subsystem
models), passes exactly that snapshot to ``feature_sets.extract_slide(input_snapshot=...)``, and persists it, with
its sha256, on the prediction. A stored prediction is reused only for the same bundle, subject (scope + slide) and
input-snapshot identity; a changed input gets a NEW prediction row (history kept), never an old score with a new
embedding. Historical rows without that provenance are marked and never reused. Duplicate concurrent work yields
one prediction per (bundle, subject, snapshot). Research use only: predictions are never labels.
"""

from __future__ import annotations

import threading

import numpy as np
import pytest
from sqlalchemy import create_engine, inspect, select, text
from sqlalchemy.exc import DatabaseError, IntegrityError

from inference_support import (
    CID,
    HANDCRAFTED,
    LEAD,
    checkpoint_model,
    fake_embeddings_for,
    fake_slide,
    prediction_rows,
    register,
    set_mpp,
    slide_run,
    snapshot_aware_fakes,
)
from ml_engine_fakes import make_engine_run, run_jobs

WHOLE_CMU = {"type": "rectangle", "x": 0, "y": 0, "width": 2220, "height": 2967}


# =========================================================================== helpers


def _infer(clients, bid: str, sid: str) -> dict:
    r = clients(LEAD).post(f"/api/v1/bundles/{bid}/infer", json={"slide_id": sid})
    assert r.status_code == 202, r.text
    return r.json()


def _jobs(job_type: str = "infer_slide") -> list:
    from dermpath.db import session_scope
    from dermpath.models import Job

    with session_scope() as db:
        return [j.id for j in db.scalars(select(Job).where(Job.type == job_type).order_by(Job.created_at)).all()]


def _real_bundle(ids, clients) -> tuple[str, str]:
    """A bundle whose extraction is REAL (handcrafted encoder, real pixels of the seeded CC0 CMU slide)."""
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


def _artifact(art_id: str):
    from dermpath.db import session_scope
    from dermpath.ml.models import FeatureArtifact

    with session_scope() as db:
        art = db.get(FeatureArtifact, art_id)
        db.expunge(art)
        return art


def _whole_slide_exclusion(slide_id: str) -> str:
    from dermpath.db import session_scope
    from dermpath.models import Slide
    from dermpath.qc.service import create_manual_issue, transition_issue
    from feature_set_support import actors

    a = actors()["assistant"]
    with session_scope() as db:
        issue = create_manual_issue(db, a, db.get(Slide, slide_id), category="fold", region=dict(WHOLE_CMU),
                                    note="whole-slide exclusion (inference snapshot test)", override_of=None,
                                    reason=None)
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
                         reason="reopened by the inference snapshot test")


def _current_snapshot_sha(slide_id: str) -> str:
    from dermpath.db import session_scope
    from dermpath.ml import inference
    from dermpath.models import Slide

    with session_scope() as db:
        return inference.effective_input_snapshot(db, db.get(Slide, slide_id))[1]


# =========================================================================== reuse


def test_unchanged_input_reuses_the_prediction_and_extraction_reads_the_recorded_snapshot(clients, ids, monkeypatch):
    calls = snapshot_aware_fakes(monkeypatch)
    from dermpath.ml import inference
    from dermpath.ml.heads import streaming_mean

    sid = fake_slide()
    rid = slide_run(ids)
    bid = register(clients, rid)
    first = _infer(clients, bid, sid)
    out = run_jobs(["infer_slide"])
    assert [o.status for o in out] == ["succeeded"], [o.error for o in out]
    (call,) = calls.extract
    # The extraction read ONE explicit snapshot (never a second, live one), and the prediction records exactly it.
    assert isinstance(call["input_snapshot"], dict) and call["input_snapshot"]["slide_id"] == sid
    (row,) = prediction_rows(bid, sid)
    assert row.provenance_status == "complete" and row.subject_scope == "slide"
    assert row.input_snapshot_sha256 == inference.snapshot_sha256(call["input_snapshot"])
    assert {k: row.input_snapshot_json[k] for k in call["input_snapshot"]} == call["input_snapshot"]
    # Unchanged input: the same job, the same stored prediction, no re-extraction.
    again = _infer(clients, bid, sid)
    assert again["job_id"] == first["job_id"] and again["prediction"]["id"] == row.id
    assert again["prediction"]["input_snapshot_sha256"] == row.input_snapshot_sha256
    pred, mean = inference.score_slide(bid, sid, need_embedding=False)
    assert pred["id"] == row.id and mean is None and len(calls.extract) == 1
    # With an embedding (active learning), the embedding comes from the SAME snapshot as the stored score.
    pred, mean = inference.score_slide(bid, sid)
    assert pred["id"] == row.id and len(prediction_rows(bid, sid)) == 1
    emb = fake_embeddings_for(sid, row.input_snapshot_json)
    assert np.array_equal(mean, streaming_mean([emb]))
    assert pred["score"] == pytest.approx(checkpoint_model(rid).score(emb)[0], abs=1e-12)


def test_historical_rows_without_provenance_are_marked_and_never_reused(clients, ids, monkeypatch):
    snapshot_aware_fakes(monkeypatch)
    from dermpath.db import session_scope
    from dermpath.ml.engine_models import InferencePrediction

    sid = fake_slide()
    bid = register(clients, slide_run(ids))
    with session_scope() as db:  # a row written before input snapshots existed (no identity columns set)
        legacy = InferencePrediction(project_id=CID, bundle_id=bid, slide_id=sid, slide_sha256="0" * 64, score=0.99,
                                     threshold=0.5, predicted=1, abstained=False,
                                     input_snapshot_json={"slide_sha256": "0" * 64, "n_patches": 6},
                                     created_by="system:worker")
        db.add(legacy)
        db.flush()
        legacy_id = legacy.id
    lead = clients(LEAD)
    (item,) = lead.get(f"/api/v1/bundles/{bid}/predictions").json()["items"]
    assert item["id"] == legacy_id and item["provenance_status"] == "legacy_unverified"
    assert item["reusable"] is False and item["input_snapshot_sha256"] is None
    r = _infer(clients, bid, sid)
    assert r["prediction"] is None  # the legacy row is never offered as the answer for the current input
    assert [o.status for o in run_jobs(["infer_slide"])] == ["succeeded"]
    rows = prediction_rows(bid, sid)
    assert [p.id for p in rows][0] == legacy_id and len(rows) == 2
    old, new = rows
    assert old.score == 0.99 and old.provenance_status == "legacy_unverified"  # marked, never rewritten
    assert new.provenance_status == "complete" and new.input_snapshot_sha256 == _current_snapshot_sha(sid)


# =========================================================================== invalidation (real extraction)


def test_changed_exclusion_calibration_or_mask_gives_a_new_versioned_prediction(clients, ids, monkeypatch):
    """Real extraction (no fakes) on the seeded CC0 CMU slide: each extraction-affecting change gets its own job and
    prediction whose recorded snapshot is what the artifact was built from; earlier predictions stay."""
    from dermpath.qc import tissue
    from dermpath.qc.service import run_screen

    sid = ids["slides"]["cmu_cc0"]
    _rid, bid = _real_bundle(ids, clients)
    lead = clients(LEAD)

    def run_one():
        out = run_jobs(["infer_slide"])
        assert [o.status for o in out] == ["succeeded"], [o.error for o in out]

    first = _infer(clients, bid, sid)
    run_one()
    (p1,) = prediction_rows(bid, sid)
    assert p1.score is not None and p1.input_snapshot_json["n_patches"] > 0
    art1 = _artifact(p1.feature_artifact_id)
    assert art1.excluded_regions_sha256 == p1.input_snapshot_json["excluded_regions_sha256"]
    assert art1.mask_sha256 == p1.input_snapshot_json["mask_sha256"]
    assert _infer(clients, bid, sid)["job_id"] == first["job_id"]  # unchanged: nothing new

    # 1. Exclusion content changes: a new job, a new prediction built from the new snapshot.
    issue = _whole_slide_exclusion(sid)
    second = _infer(clients, bid, sid)
    assert second["job_id"] != first["job_id"] and second["prediction"] is None
    run_one()
    p2 = prediction_rows(bid, sid)[-1]
    assert p2.id != p1.id and p2.input_snapshot_sha256 != p1.input_snapshot_sha256
    assert p2.score is None and "no tissue patches" in p2.unscorable_reason
    assert p2.input_snapshot_json["excluded_issue_ids"] == [issue]
    assert _artifact(p2.feature_artifact_id).excluded_regions_sha256 == p2.input_snapshot_json[
        "excluded_regions_sha256"]
    # Back to the first input: the first prediction is the answer again (same identity, reused).
    _reopen(issue)
    back = _infer(clients, bid, sid)
    assert back["prediction"]["id"] == p1.id and run_jobs(["infer_slide"]) == []

    # 2. Calibration (effective mpp) changes.
    mpp = p1.input_snapshot_json["mpp_x"]
    set_mpp(sid, mpp * 0.8)
    third = _infer(clients, bid, sid)
    assert third["job_id"] not in (first["job_id"], second["job_id"])
    run_one()
    p3 = prediction_rows(bid, sid)[-1]
    assert p3.id not in (p1.id, p2.id) and p3.input_snapshot_json["mpp_x"] == pytest.approx(mpp * 0.8)
    assert len({p1.input_snapshot_sha256, p2.input_snapshot_sha256, p3.input_snapshot_sha256}) == 3

    # 3. Mask content changes (a new automated screen with a different tissue mask).
    real_segment = tissue.segment

    def inverted(thumb, dims):
        mask, stats = real_segment(thumb, dims)
        return ~mask, stats

    monkeypatch.setattr(tissue, "segment", inverted)
    run_screen(sid)
    fourth = _infer(clients, bid, sid)
    run_one()
    p4 = prediction_rows(bid, sid)[-1]
    assert fourth["job_id"] != third["job_id"] and p4.id not in (p1.id, p2.id, p3.id)
    assert p4.input_snapshot_json["mask_sha256"] != p3.input_snapshot_json["mask_sha256"]
    if p4.feature_artifact_id:
        assert _artifact(p4.feature_artifact_id).mask_sha256 == p4.input_snapshot_json["mask_sha256"]
    # History is kept: every version is listed, each with its own identity.
    items = lead.get(f"/api/v1/bundles/{bid}/predictions").json()["items"]
    assert [i["id"] for i in items] == [p1.id, p2.id, p3.id, p4.id]
    assert all(i["provenance_status"] == "complete" and i["reusable"] for i in items)


@pytest.mark.parametrize("when", ["before_the_request", "between_snapshot_and_extraction"])
def test_image_identity_failure_fails_closed_and_records_nothing(clients, ids, monkeypatch, when):
    """Slide bytes that no longer hash to the slide's sha256 are an input-identity failure, not an "unscorable"
    research outcome: the job fails permanently and no prediction is written."""
    from dermpath.db import session_scope
    from dermpath.ml import feature_sets as fsm
    from dermpath.models import Slide
    from dermpath.storage import get_store

    sid = ids["slides"]["cmu_cc0"]
    _rid, bid = _real_bundle(ids, clients)
    with session_scope() as db:
        key = db.get(Slide, sid).object_key
    store = get_store()

    def corrupt():
        store.put_bytes(key, store.get_bytes(key) + b"\x00tampered")
        fsm.clear_sha_memo()

    if when == "before_the_request":
        corrupt()
    else:
        real_extract = fsm.extract_slide

        def mutating(slide_id, **kw):
            corrupt()
            return real_extract(slide_id, **kw)

        monkeypatch.setattr(fsm, "extract_slide", mutating)
    _infer(clients, bid, sid)
    out = run_jobs(["infer_slide"])
    assert [o.status for o in out] == ["failed"], [o.error for o in out]
    assert "input_changed" in out[0].error
    assert prediction_rows(bid) == []


def test_a_change_between_snapshot_and_extraction_never_splits_provenance(clients, ids, monkeypatch):
    """An exclusion resolved while the job runs (after its snapshot, before extraction) does not leak into this
    prediction: the extraction reads the job's snapshot, so the recorded snapshot IS the artifact's input. The next
    request sees the new state and gets a new prediction."""
    from dermpath.ml import feature_sets as fsm

    sid = ids["slides"]["cmu_cc0"]
    _rid, bid = _real_bundle(ids, clients)
    real_extract = fsm.extract_slide
    state = {"issue": None}

    def mutating(slide_id, **kw):
        if state["issue"] is None:
            state["issue"] = _whole_slide_exclusion(slide_id)
        return real_extract(slide_id, **kw)

    monkeypatch.setattr(fsm, "extract_slide", mutating)
    _infer(clients, bid, sid)
    assert [o.status for o in run_jobs(["infer_slide"])] == ["succeeded"]
    (p1,) = prediction_rows(bid, sid)
    art = _artifact(p1.feature_artifact_id)
    assert art.excluded_regions_sha256 == p1.input_snapshot_json["excluded_regions_sha256"], (
        "the recorded input snapshot is not the one the features were extracted from")
    assert p1.score is not None and art.n_patches > 0  # the mid-job exclusion did not leak in
    assert state["issue"] is not None and p1.input_snapshot_json["excluded_issue_ids"] == []
    _infer(clients, bid, sid)
    assert [o.status for o in run_jobs(["infer_slide"])] == ["succeeded"]
    p2 = prediction_rows(bid, sid)[-1]
    assert p2.id != p1.id and p2.input_snapshot_json["excluded_issue_ids"] == [state["issue"]]
    assert p2.score is None and _artifact(p2.feature_artifact_id).n_patches == 0


# =========================================================================== concurrency


def test_duplicate_concurrent_requests_record_one_prediction(clients, ids, monkeypatch):
    """Two workers scoring the same (bundle, slide, snapshot) at once: both pass the reuse check, both extract, and
    exactly one row is written; the loser returns the winner's prediction (never an error, never a second row)."""
    barrier = threading.Barrier(2, timeout=20)
    snapshot_aware_fakes(monkeypatch, before_extract=lambda _sid: barrier.wait())
    from dermpath.ml import inference

    sid = fake_slide()
    bid = register(clients, slide_run(ids))
    # API: duplicate requests are one job.
    a, b = _infer(clients, bid, sid), _infer(clients, bid, sid)
    assert a["job_id"] == b["job_id"] and len(_jobs()) == 1
    results, errors = [], []

    def work(need_embedding):
        try:
            results.append(inference.score_slide(bid, sid, need_embedding=need_embedding))
        except Exception as exc:  # noqa: BLE001 - collected and asserted below
            errors.append(exc)

    threads = [threading.Thread(target=work, args=(flag,)) for flag in (False, True)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(60)
    assert errors == [], errors
    assert len(results) == 2 and results[0][0]["id"] == results[1][0]["id"]
    assert results[0][0]["score"] == results[1][0]["score"]
    (row,) = prediction_rows(bid, sid)
    assert row.id == results[0][0]["id"] and row.provenance_status == "complete"


# =========================================================================== active learning


def test_active_learning_score_and_embedding_come_from_one_snapshot(clients, ids, monkeypatch):
    """A candidate scored before a calibration edit is re-scored after it: the batch must use a NEW prediction for
    the new snapshot, and the diversity embedding must come from the same features as that prediction's score
    (an old score paired with a new embedding is the defect)."""
    snapshot_aware_fakes(monkeypatch)
    from dermpath.db import session_scope
    from dermpath.ml import active_learning
    from dermpath.ml.engine_models import InferencePrediction

    pool_ids = sorted(fake_slide(tag=f"al{i}") for i in range(3))
    fake_pool = [{"slide_id": s, "coded_patient_id": f"pt-al-{i}", "patient_code": None, "case_id": None,
                  "pool_reason": "no_reference_label", "family_split": "new_to_family",
                  "patient_in_training_set": False} for i, s in enumerate(pool_ids)]
    monkeypatch.setattr(active_learning, "development_pool", lambda db, run, dv: (list(fake_pool), {}))
    seen: list[list[dict]] = []
    real_select = active_learning.select_batch

    def capture(candidates, **kw):
        seen.append([dict(c) for c in candidates])
        return real_select(candidates, **kw)

    monkeypatch.setattr(active_learning, "select_batch", capture)
    rid = slide_run(ids)
    register(clients, rid)
    model = checkpoint_model(rid)
    url = f"/api/v1/projects/{CID}/active-learning"
    body = {"run_id": rid, "k": 1, "random_fraction": 0.0, "uncertainty_fraction": 0.0}
    assert clients(LEAD).post(url, json=body).status_code == 202
    assert [o.status for o in run_jobs(["active_learning"])] == ["succeeded"]
    for s in pool_ids:
        set_mpp(s, 0.25)  # a calibration edit on every candidate
    assert clients(LEAD).post(url, json=body).status_code == 202
    assert [o.status for o in run_jobs(["active_learning"])] == ["succeeded"]
    assert len(seen) == 2
    first_ids = {c["inference_prediction_id"] for c in seen[0]}
    for c in seen[1]:
        assert c.get("score") is not None and c.get("embedding") is not None
        with session_scope() as db:
            pred = db.get(InferencePrediction, c["inference_prediction_id"])
            snap = dict(pred.input_snapshot_json)
            score = pred.score
        emb = fake_embeddings_for(c["slide_id"], snap)
        # Score and embedding are two views of ONE set of features.
        assert np.allclose(c["embedding"], emb.astype(np.float64).mean(axis=0), rtol=0, atol=1e-12), (
            f"slide {c['slide_id']}: the diversity embedding does not come from the features its score was "
            f"computed on (prediction {c['inference_prediction_id']})")
        assert score == pytest.approx(model.score(emb)[0], abs=1e-12) and c["score"] == score
        assert snap["mpp_x"] == 0.25 and c["inference_prediction_id"] not in first_ids
    bid = _bundle_of(rid)
    for s in pool_ids:  # history kept: one prediction per snapshot
        assert len(prediction_rows(bid, s)) == 2


def _bundle_of(rid: str) -> str:
    from dermpath.db import session_scope
    from dermpath.ml.models import TrainingRun

    with session_scope() as db:
        return db.get(TrainingRun, rid).bundle_id


# =========================================================================== migration of existing databases


V2_TABLE = """CREATE TABLE inference_prediction (
    id VARCHAR(32) NOT NULL, project_id VARCHAR(64) NOT NULL, bundle_id VARCHAR(32) NOT NULL,
    slide_id VARCHAR(32) NOT NULL, slide_sha256 VARCHAR(64) NOT NULL, feature_artifact_id VARCHAR(32),
    job_id VARCHAR(32), score FLOAT, calibrated_score FLOAT, threshold FLOAT NOT NULL, predicted INTEGER,
    abstained BOOLEAN NOT NULL, unscorable_reason VARCHAR(200), coverage_json JSON, attention_key VARCHAR(300),
    attention_sha256 VARCHAR(64), input_snapshot_json JSON NOT NULL, research_use_only BOOLEAN NOT NULL,
    created_by VARCHAR(64) NOT NULL, created_at DATETIME NOT NULL, PRIMARY KEY (id),
    CONSTRAINT uq_inference_prediction_slide UNIQUE (bundle_id, slide_id),
    FOREIGN KEY(project_id) REFERENCES project (id), FOREIGN KEY(bundle_id) REFERENCES inference_bundle (id),
    FOREIGN KEY(slide_id) REFERENCES slide (id), FOREIGN KEY(feature_artifact_id) REFERENCES feature_artifact (id))"""
V2_EXTRA = [
    "CREATE INDEX ix_inference_prediction_slide_id ON inference_prediction (slide_id)",
    "CREATE INDEX ix_inference_prediction_slide_sha256 ON inference_prediction (slide_sha256)",
    "CREATE INDEX ix_inference_prediction_bundle_id ON inference_prediction (bundle_id)",
    "CREATE INDEX ix_inference_prediction_project_id ON inference_prediction (project_id)",
    "CREATE TRIGGER inference_prediction_no_update BEFORE UPDATE ON inference_prediction BEGIN "
    "SELECT RAISE(ABORT, 'inference_prediction is append-only'); END",
    "CREATE TRIGGER inference_prediction_no_delete BEFORE DELETE ON inference_prediction BEGIN "
    "SELECT RAISE(ABORT, 'inference_prediction is append-only'); END",
]
V2_ROW = ("INSERT INTO inference_prediction (id, project_id, bundle_id, slide_id, slide_sha256, feature_artifact_id, "
          "job_id, score, calibrated_score, threshold, predicted, abstained, unscorable_reason, coverage_json, "
          "attention_key, attention_sha256, input_snapshot_json, research_use_only, created_by, created_at) VALUES "
          "(:id, 'p', 'b1', :slide, :sha, NULL, 'j', :score, NULL, 0.5, 1, 0, NULL, NULL, NULL, NULL, :snap, 1, "
          "'system:worker', '2026-10-27 10:00:00.000000')")


def test_a_schema_v2_database_is_migrated_in_place_and_its_rows_are_marked_not_rewritten(tmp_path):
    """Existing local databases (schema v2, no Alembic) gain the provenance columns in place when the app starts
    (``create_all``): every historical row is kept verbatim and marked ``legacy_unverified`` (never reused), the
    old one-row-per-(bundle, slide) uniqueness becomes one row per (bundle, subject, snapshot), the append-only
    triggers still hold, and a second start changes nothing."""
    from dermpath.db import Base, import_all_models

    import_all_models()
    engine = create_engine(f"sqlite:///{tmp_path / 'v2.db'}")
    with engine.begin() as conn:
        conn.execute(text(V2_TABLE))
        for stmt in V2_EXTRA:
            conn.execute(text(stmt))
        for i, score in enumerate((0.81, None)):
            conn.execute(text(V2_ROW), {"id": f"legacy{i}", "slide": f"s{i}", "sha": f"{i}" * 64, "score": score,
                                        "snap": '{"slide_sha256": "%s", "n_patches": 6}' % (f"{i}" * 64)})
    with engine.connect() as conn:
        before = [dict(r) for r in conn.execute(text("SELECT * FROM inference_prediction ORDER BY id")).mappings()]
    Base.metadata.create_all(engine)
    cols = {c["name"] for c in inspect(engine).get_columns("inference_prediction")}
    assert {"subject_scope", "input_snapshot_sha256", "provenance_status"} <= cols
    with engine.connect() as conn:
        after = [dict(r) for r in conn.execute(text("SELECT * FROM inference_prediction ORDER BY id")).mappings()]
    assert [{k: r[k] for k in before[0]} for r in after] == before  # every stored value kept verbatim
    assert all(r["provenance_status"] == "legacy_unverified" and r["input_snapshot_sha256"] is None
               and r["subject_scope"] is None for r in after)
    # Versioned rows are now possible; a duplicate (bundle, subject, snapshot) is not.
    ins = ("INSERT INTO inference_prediction (id, project_id, bundle_id, slide_id, slide_sha256, threshold, abstained, "
           "input_snapshot_json, research_use_only, created_by, created_at, subject_scope, input_snapshot_sha256, "
           "provenance_status) VALUES (:id, 'p', 'b1', 's0', :sha, 0.5, 0, '{}', 1, 'w', '2026-10-28 10:00:00', "
           "'slide', :snap, 'complete')")
    with engine.begin() as conn:
        conn.execute(text(ins), {"id": "v1", "sha": "0" * 64, "snap": "a" * 64})
        conn.execute(text(ins), {"id": "v2", "sha": "0" * 64, "snap": "b" * 64})
    with pytest.raises(IntegrityError), engine.begin() as conn:
        conn.execute(text(ins), {"id": "v3", "sha": "0" * 64, "snap": "b" * 64})
    with pytest.raises(IntegrityError), engine.begin() as conn:  # complete provenance needs a snapshot identity
        conn.execute(text(ins), {"id": "v4", "sha": "0" * 64, "snap": None})
    for sql in ("UPDATE inference_prediction SET score = 0.1 WHERE id = 'legacy0'",
                "DELETE FROM inference_prediction WHERE id = 'legacy1'"):
        with pytest.raises(DatabaseError, match="append-only"), engine.begin() as conn:
            conn.execute(text(sql))
    # Idempotent: a second start finds nothing to do and keeps every row.
    Base.metadata.create_all(engine)
    with engine.connect() as conn:
        assert conn.execute(text("SELECT count(*) FROM inference_prediction")).scalar() == 4
        names = {r[0] for r in conn.execute(text("SELECT name FROM sqlite_master WHERE type = 'trigger' AND "
                                                 "tbl_name = 'inference_prediction'"))}
    assert {"inference_prediction_no_update", "inference_prediction_no_delete"} <= names
    engine.dispose()


def test_fresh_schema_has_the_snapshot_uniqueness(tmp_path):
    from dermpath.db import Base, import_all_models

    import_all_models()
    engine = create_engine(f"sqlite:///{tmp_path / 'fresh.db'}")
    Base.metadata.create_all(engine)
    uniques = {tuple(u["column_names"]) for u in inspect(engine).get_unique_constraints("inference_prediction")}
    assert ("bundle_id", "slide_id") not in uniques
    assert ("bundle_id", "subject_scope", "slide_id", "input_snapshot_sha256") in uniques
    with engine.connect() as conn:
        assert conn.execute(text("SELECT count(*) FROM inference_prediction")).scalar() == 0
    engine.dispose()
