"""Inference bundles (design §8): built at registration, immutable, content-addressed (bundle_sha256 = sha of the
canonical content = sha of the stored object); ``infer_slide`` is label-free and identity-verified (encoder spec,
weights, policy) and writes an append-only research prediction, never a label. Pipeline-test bundles refuse.

The partners' extraction and scoring functions are fakes that follow the interface contract."""

from __future__ import annotations

import dataclasses
import hashlib
import os

import pytest
from sqlalchemy import func, select, text

from ml_engine_fakes import CID, LEAD, cohort_dv, install_fakes, make_engine_run, run_jobs

HANDCRAFTED = "handcrafted-stain-texture-v1"


def _supervised_run(ids):
    """A succeeded run whose bundle may infer (structural fixture: real-mode encoder over the cohort manifest)."""
    from dermpath.db import session_scope

    with session_scope() as db:
        run, fs = make_engine_run(db, cohort_dv(db, ids), mode="supervised_experiment", encoder_id=HANDCRAFTED,
                                  weights_sha256="handcrafted:test-identity")
        return run.id


def _real_slide(project_id=CID, provenance="public_cc0", image_kind="wsi"):
    from dermpath.db import session_scope, utcnow
    from dermpath.models import Slide, new_id

    with session_scope() as db:
        sid = new_id()
        db.add(Slide(id=sid, project_id=project_id, provenance=provenance, image_kind=image_kind,
                     object_key=f"projects/{project_id}/slides/{sid}/original.svs",
                     sha256=hashlib.sha256(sid.encode()).hexdigest(), bytes=1, format="aperio", width=2000,
                     height=1500, levels=1, level_dimensions_json=[[2000, 1500]], level_downsamples_json=[1.0],
                     mpp_x=0.5, mpp_y=0.5, ingest_status="succeeded", ingested_at=utcnow(), created_by=LEAD))
        return sid


def test_bundle_is_built_at_registration_immutable_and_content_addressed(clients, ids, monkeypatch, env):
    install_fakes(monkeypatch)
    from dermpath.db import session_scope
    from dermpath.ml.engine_models import InferenceBundle, bundle_sha256_of
    from dermpath.ml.models import TrainingRun
    from dermpath.models import ImmutableRecordError
    from dermpath.storage import get_store

    rid = _supervised_run(ids)
    lead = clients(LEAD)
    reg = lead.post(f"/api/v1/experiments/{rid}/register", json={"note": "candidate"})
    assert reg.status_code == 201, reg.text
    b = reg.json()["bundle"]
    c = b["content"]
    assert b["verified"] is True and b["problems"] == [] and b["research_use_only"] is True and b["can_infer"] is True
    assert b["bundle_sha256"] == bundle_sha256_of(c)
    store = get_store()
    assert b["object_key"].endswith(f"/{b['bundle_sha256']}.json")
    assert hashlib.sha256(store.get_bytes(b["object_key"])).hexdigest() == b["bundle_sha256"]
    # Content per design §8.
    assert c["research_use_only"] is True and c["schema"] == "dermpath.inference_bundle/1"
    assert c["encoder"]["id"] == HANDCRAFTED and c["encoder"]["weights_sha256"] == "handcrafted:test-identity"
    assert len(c["encoder"]["spec_sha256"]) == 64 and c["encoder"]["spec"]["id"] == HANDCRAFTED
    assert len(c["patch_policy"]["policy_sha256"]) == 64 and c["patch_policy"]["policy"]["sampling"]
    assert c["stain_policy"]["policy"]["method"] == "none"
    head = c["head"]
    with session_scope() as db:
        run = db.get(TrainingRun, rid)
        assert head["checkpoint_sha256"] == run.checkpoint_sha256 and run.bundle_id == b["id"]
    assert head["checkpoint_key"].endswith(f"/{head['checkpoint_sha256']}.npz")
    assert hashlib.sha256(store.get_bytes(head["checkpoint_key"])).hexdigest() == head["checkpoint_sha256"]
    assert c["classes"]["negative_class"] == "bcc_absent_not_benign"
    assert "never rendered as benign" in c["classes"]["negative_statement"]
    assert c["threshold"]["value"] == 0.5 and c["calibration"]["method"] == "none"
    assert c["abstention"]["kind"] == "none" and c["abstention"]["frozen"] is True
    assert c["code"]["code_tree_sha256"] == "c" * 64 and c["dataset_manifest_sha256"]
    assert c["feature_set"]["spec_sha256"]
    # Idempotent per run.
    again = lead.post(f"/api/v1/experiments/{rid}/register")
    assert again.status_code == 200 and again.json()["bundle_id"] == b["id"]
    assert lead.get(f"/api/v1/bundles/{b['id']}").json()["bundle_sha256"] == b["bundle_sha256"]
    assert clients("user-director").get(f"/api/v1/bundles/{b['id']}").status_code == 200
    # Immutable: ORM, raw SQL, delete; a forged sha is refused at insert.
    from sqlalchemy.exc import DatabaseError

    with session_scope() as db:
        row = db.get(InferenceBundle, b["id"])
        row.content_json = {**row.content_json, "threshold": {"value": 0.1}}
        with pytest.raises(ImmutableRecordError):
            db.flush()
        db.rollback()
    with session_scope() as db:
        with pytest.raises(DatabaseError):
            db.execute(text("UPDATE inference_bundle SET object_key='x' WHERE id=:i"), {"i": b["id"]})
        db.rollback()
    with session_scope() as db:
        db.add(InferenceBundle(project_id=CID, run_id=rid, bundle_sha256="0" * 64,
                               content_json={"research_use_only": True}, object_key="k", created_by=LEAD))
        with pytest.raises(ImmutableRecordError):
            db.flush()
        db.rollback()
    # A tampered stored object is detected and never used.
    path = store.local_path(b["object_key"])
    os.chmod(path, 0o600)
    path.write_bytes(b'{"tampered": true}')
    got = lead.get(f"/api/v1/bundles/{b['id']}").json()
    assert got["verified"] is False and "stored bundle object does not hash to bundle_sha256" in got["problems"]
    r = lead.post(f"/api/v1/bundles/{b['id']}/infer", json={"slide_id": _real_slide()})
    assert r.status_code == 409 and r.json()["error"]["code"] == "bundle_integrity"


def test_infer_job_is_label_free_identity_verified_and_never_writes_a_label(clients, ids, monkeypatch):
    """Deliberate change (owner brief item 2B, 2026-10-28): this test used to assert ``input_snapshot is None``,
    i.e. that the extraction took its own live snapshot while the prediction recorded a separate one. That was the
    defect (recorded provenance could differ from the extraction's inputs). The job now passes ONE canonical
    snapshot to the extraction and the prediction records exactly it (``tests/test_inference_snapshot_identity.py``)."""
    calls = install_fakes(monkeypatch)
    from dermpath import labels
    from dermpath.db import session_scope
    from dermpath.ml import fixture
    from dermpath.ml.engine_models import InferencePrediction
    from dermpath.models import Job, LabelVersion

    def forbidden(*_a, **_k):
        raise AssertionError("inference must not read labels or build fixture contexts")

    monkeypatch.setattr(fixture, "fixture_context", forbidden)
    monkeypatch.setattr(labels, "reference_label", forbidden)
    rid = _supervised_run(ids)
    sid = _real_slide()
    lead = clients(LEAD)
    bid = lead.post(f"/api/v1/experiments/{rid}/register").json()["bundle_id"]
    with session_scope() as db:
        n_labels = db.scalar(select(func.count(LabelVersion.id)))
    assert clients("user-pathologist").post(f"/api/v1/bundles/{bid}/infer", json={"slide_id": sid}).status_code == 403
    r = lead.post(f"/api/v1/bundles/{bid}/infer", json={"slide_id": sid})
    assert r.status_code == 202, r.text
    job_id = r.json()["job_id"]
    assert lead.post(f"/api/v1/bundles/{bid}/infer", json={"slide_id": sid}).json()["job_id"] == job_id  # idempotent
    with session_scope() as db:
        # No label in the payload. The request-time input identity travels with the job (verify2 inference fix:
        # a job's result can then be matched to the identity it was requested for); it is a snapshot hash, not a label.
        assert set(db.get(Job, job_id).payload_json) == {"bundle_id", "slide_id", "expected_input_snapshot_sha256"}
    out = run_jobs(["infer_slide"])
    assert [o.status for o in out] == ["succeeded"], [o.error for o in out]
    # Extraction used the bundle's pins and policies, with nothing label-like.
    (call,) = calls.extract
    bundle = lead.get(f"/api/v1/bundles/{bid}").json()["content"]
    assert call["weights_sha256"] == bundle["encoder"]["weights_sha256"]
    assert call["encoder_spec_sha256"] == bundle["encoder"]["spec_sha256"]
    assert call["policy_sha256"] == bundle["patch_policy"]["policy_sha256"]
    snap = call["input_snapshot"]  # the job's one snapshot, label-free
    assert isinstance(snap, dict) and snap["slide_id"] == sid and call["device"] == "cpu"
    assert not [k for k in snap if "label" in k or "fixture" in k]
    assert call["extra"] and not [k for k in call["extra"] if "label" in k or "fixture" in k]
    preds = lead.get(f"/api/v1/bundles/{bid}/predictions").json()["items"]
    assert len(preds) == 1
    p = preds[0]
    assert p["slide_id"] == sid and p["research_use_only"] is True and p["is_label"] is False
    assert p["predicted"] == int(p["score"] >= p["threshold"]) and p["unscorable_reason"] is None
    assert p["predicted_class"] in ("bcc_present", "bcc_absent_not_benign")
    if p["predicted_class"] == "bcc_absent_not_benign":
        assert "NOT the same as benign" in p["predicted_display"]
    assert p["input_snapshot"]["slide_sha256"] == hashlib.sha256(sid.encode()).hexdigest()
    assert {k: p["input_snapshot"][k] for k in snap} == snap and p["provenance_status"] == "complete"
    cols = {c.name for c in InferencePrediction.__table__.columns}
    assert not {"label", "label_value", "label_version_id"} & cols
    with session_scope() as db:
        assert db.scalar(select(func.count(LabelVersion.id))) == n_labels  # never a label
    # A second request returns the stored prediction (append-only, one per bundle, slide and input snapshot).
    r = lead.post(f"/api/v1/bundles/{bid}/infer", json={"slide_id": sid}).json()
    assert r["prediction"]["id"] == p["id"]


@pytest.mark.parametrize("failure", ["weights_differ", "loaded_weights_mismatch", "spec_changed"])
def test_infer_refuses_an_identity_mismatch(clients, ids, monkeypatch, failure):
    from dermpath.ml import encoders
    from dermpath.ml.encoders import EncoderIdentityMismatch

    kw = {}
    if failure == "weights_differ":
        kw["extract_weights"] = "e" * 64
    elif failure == "loaded_weights_mismatch":
        kw["extract_raises"] = EncoderIdentityMismatch(HANDCRAFTED, expected="a", actual="b", source="bundle")
    calls = install_fakes(monkeypatch, **kw)
    rid = _supervised_run(ids)
    sid = _real_slide()
    lead = clients(LEAD)
    bid = lead.post(f"/api/v1/experiments/{rid}/register").json()["bundle_id"]
    if failure == "spec_changed":
        adapter = encoders.get_encoder(HANDCRAFTED)
        monkeypatch.setattr(adapter, "spec", dataclasses.replace(adapter.spec, adapter_version="999"))
    assert lead.post(f"/api/v1/bundles/{bid}/infer", json={"slide_id": sid}).status_code == 202
    out = run_jobs(["infer_slide"])
    assert [o.status for o in out] == ["failed"]
    expected = {"weights_differ": "weights_or_identity_mismatch",
                "loaded_weights_mismatch": "encoder_unavailable_or_weights_mismatch",
                "spec_changed": "encoder_spec_changed"}[failure]
    assert expected in out[0].error
    if failure == "spec_changed":
        assert calls.extract == []
    assert lead.get(f"/api/v1/bundles/{bid}/predictions").json()["items"] == []


def test_unscorable_slide_is_recorded_honestly(clients, ids, monkeypatch):
    from dermpath.ml.features import FeatureError

    install_fakes(monkeypatch, extract_raises=FeatureError("uncalibrated slide refused by the patch policy"))
    rid = _supervised_run(ids)
    sid = _real_slide()
    lead = clients(LEAD)
    bid = lead.post(f"/api/v1/experiments/{rid}/register").json()["bundle_id"]
    lead.post(f"/api/v1/bundles/{bid}/infer", json={"slide_id": sid})
    assert [o.status for o in run_jobs(["infer_slide"])] == ["succeeded"]
    (p,) = lead.get(f"/api/v1/bundles/{bid}/predictions").json()["items"]
    assert p["score"] is None and p["predicted"] is None and p["predicted_class"] is None
    assert "uncalibrated slide refused" in p["unscorable_reason"]


def test_pipeline_test_bundles_and_synthetic_slides_are_refused(clients, ids, monkeypatch):
    install_fakes(monkeypatch)
    from dermpath.db import session_scope

    with session_scope() as db:
        syn, _ = make_engine_run(db, cohort_dv(db, ids))
        syn_id = syn.id
        demo_slide = cohort_dv(db, ids).manifest_json["items"][0]["slide_id"]
    lead = clients(LEAD)
    reg = lead.post(f"/api/v1/experiments/{syn_id}/register").json()
    assert reg["bundle"]["can_infer"] is False and "label" in reg["bundle"]["inference_refusal"]
    r = lead.post(f"/api/v1/bundles/{reg['bundle_id']}/infer", json={"slide_id": _real_slide()})
    assert r.status_code == 409 and r.json()["error"]["code"] == "mode_mismatch"
    sup = _supervised_run(ids)
    bid = lead.post(f"/api/v1/experiments/{sup}/register").json()["bundle_id"]
    r = lead.post(f"/api/v1/bundles/{bid}/infer", json={"slide_id": demo_slide})
    assert r.status_code == 409 and r.json()["error"]["code"] == "mode_mismatch"
    r = lead.post(f"/api/v1/bundles/{bid}/infer", json={"slide_id": "nope"})
    assert r.status_code == 404
    other_project_slide = _real_slide(project_id="proj-bcc-demo")
    assert lead.post(f"/api/v1/bundles/{bid}/infer", json={"slide_id": other_project_slide}).status_code == 404


def test_real_extraction_and_scoring_on_the_public_fixture(clients, ids):
    """No fakes: W6's label-free extract_slide (handcrafted encoder, real pixels of the CC0 CMU slide) and W7a's
    scorer, through a bundle whose run is a structural fixture (64-d checkpoint, real weights identity)."""
    from dermpath.db import session_scope
    from dermpath.ml.encoders import ENCODER_SPECS
    from dermpath.ml.handcrafted import code_identity
    from dermpath.models import DatasetVersion

    spec = ENCODER_SPECS[HANDCRAFTED]
    with session_scope() as db:
        dv = db.get(DatasetVersion, ids["ml_demo"]["workflow"]["dataset_version_id"])
        run, _ = make_engine_run(db, dv, mode="supervised_experiment", encoder_id=HANDCRAFTED,
                                 weights_sha256=code_identity(), store_val=False, dim=spec.embedding_dim)
        rid = run.id
    lead = clients(LEAD)
    reg = lead.post(f"/api/v1/experiments/{rid}/register").json()
    assert reg["bundle"]["can_infer"] is True
    cmu = ids["slides"]["cmu_cc0"]
    r = lead.post(f"/api/v1/bundles/{reg['bundle_id']}/infer", json={"slide_id": cmu})
    assert r.status_code == 202, r.text
    out = run_jobs(["infer_slide"])
    assert [o.status for o in out] == ["succeeded"], [o.error for o in out]
    (p,) = lead.get(f"/api/v1/bundles/{reg['bundle_id']}/predictions").json()["items"]
    assert p["unscorable_reason"] is None and 0.0 <= p["score"] <= 1.0
    assert p["predicted"] == int(p["score"] >= 0.5) and p["is_label"] is False
    assert p["feature_artifact_id"] and p["input_snapshot"]["n_patches"] > 0


def test_a_corrupt_feature_artifact_fails_the_job_instead_of_recording_unscorable(clients, ids, monkeypatch):
    from dermpath.ml import feature_sets as fsm

    install_fakes(monkeypatch)
    integrity = fsm.FeatureSetIntegrityError
    install_fakes(monkeypatch, extract_raises=integrity("embeddings object sha256 mismatch"))
    rid = _supervised_run(ids)
    sid = _real_slide()
    lead = clients(LEAD)
    bid = lead.post(f"/api/v1/experiments/{rid}/register").json()["bundle_id"]
    lead.post(f"/api/v1/bundles/{bid}/infer", json={"slide_id": sid})
    out = run_jobs(["infer_slide"])
    assert [o.status for o in out] == ["failed"] and "feature_integrity" in out[0].error
    assert lead.get(f"/api/v1/bundles/{bid}/predictions").json()["items"] == []
