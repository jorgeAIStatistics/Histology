"""Platform behaviour: health, correlation ids, fail-closed mode, origin check, session cookie,
audit immutability and scrubbing, storage, field images, identifier-risk flags, seed, reset."""

from __future__ import annotations

import io
from dataclasses import replace

import pytest
from fastapi.testclient import TestClient
from PIL import Image
from sqlalchemy import text

from conftest import upload_bytes

PID = "proj-bcc-demo"


def test_health_reports_components_and_worker_heartbeat(clients):
    """Health reports every component. The schema version is compared with the code constant
    (it became 2 with the ML engine upgrade, docs/ml-engine-design.md §10) rather than a literal,
    so the check keeps asserting "database matches code" across deliberate bumps."""
    from dermpath.db import SCHEMA_VERSION

    anon = clients.anon()
    h = anon.get("/api/v1/health").json()
    assert h["mode"] == "demo" and set(h["checks"]) >= {"database", "object_store", "worker", "tile_service"}
    assert SCHEMA_VERSION == 2
    assert h["checks"]["database"]["status"] == "ok" and h["checks"]["database"]["schema_version"] == SCHEMA_VERSION
    assert h["checks"]["object_store"] == {"status": "ok", "backend": "local", "root_is_private": True}
    assert h["checks"]["tile_service"]["status"] == "ok" and h["checks"]["tile_service"]["tested_wsi_formats"] == [".svs"]
    assert "ingest" in h["checks"]["job_handlers"]["types"]
    assert h["checks"]["job_handlers"]["modules"]["dermpath.ml.jobs"] in ("not_present", "loaded")
    assert "Research use only" in h["research_use_only"]
    # The seed ran its jobs in-process without a heartbeat: no worker process is claimed alive.
    assert h["checks"]["worker"]["status"] == "never_seen" and h["status"] == "degraded"
    from dermpath.jobs.worker import Worker

    Worker("health-check-worker").beat(force=True)
    h = anon.get("/api/v1/health").json()
    assert h["checks"]["worker"]["status"] == "ok" and h["status"] == "ok"


def test_request_id_is_echoed_and_recorded_in_audit(clients, ids):
    p1 = clients("user-pathologist")
    r = p1.post(f"/api/v1/slides/{ids['slides']['p1_a1_l1']}/comments", json={"body": "x"},
                headers={"X-Request-Id": "client-corr-1234"})
    assert r.headers["x-request-id"] == "client-corr-1234"
    generated = p1.get("/api/v1/auth/me").headers["x-request-id"]
    assert generated.startswith("req-")
    bad = p1.get("/api/v1/auth/me", headers={"X-Request-Id": "bad id with spaces"}).headers["x-request-id"]
    assert bad.startswith("req-")
    audit = clients("user-research-lead").get(f"/api/v1/projects/{PID}/audit?entity_type=comment").json()["items"]
    assert audit[0]["correlation_id"] == "client-corr-1234"
    err = p1.get("/api/v1/slides/does-not-exist")
    assert err.status_code == 404 and err.json()["request_id"] == err.headers["x-request-id"]
    assert r.headers["x-content-type-options"] == "nosniff" and r.headers["x-frame-options"] == "DENY"


def test_secured_mode_fails_closed(env):
    from dermpath.main import create_app

    settings, _ = env
    app = create_app(replace(settings, mode="secured"))
    with TestClient(app) as c:
        h = c.get("/api/v1/health")
        assert h.status_code == 200 and h.json()["status"] == "refusing" and h.json()["mode"] == "secured"
        for method, url in (("get", "/api/v1/auth/demo-users"), ("post", "/api/v1/auth/demo-login"),
                            ("get", "/api/v1/projects"), ("get", "/api/v1/meta"), ("get", "/api/v1/docs"),
                            ("get", "/api/v1/openapi.json"), ("put", "/api/v1/uploads/x/chunks/0")):
            r = getattr(c, method)(url)
            assert r.status_code == 503 and r.json()["error"]["code"] == "mode_not_implemented", url
    app = create_app(replace(settings, mode="anything-else"))
    with TestClient(app) as c:
        assert c.get("/api/v1/projects").status_code == 503


def test_origin_check_on_state_changing_requests(clients, ids):
    p1 = clients("user-pathologist")
    url = f"/api/v1/slides/{ids['slides']['p1_a1_l1']}/comments"
    evil = p1.post(url, json={"body": "x"}, headers={"Origin": "https://evil.example"})
    assert evil.status_code == 403 and evil.json()["error"]["code"] == "origin_rejected"
    ok = p1.post(url, json={"body": "x"}, headers={"Origin": "http://localhost:3000"})
    assert ok.status_code == 201
    assert p1.get(url, headers={"Origin": "https://evil.example"}).status_code == 200  # reads are not state-changing


def test_demo_login_cookie_and_me_notice(app):
    with TestClient(app) as c:
        users = c.get("/api/v1/auth/demo-users").json()
        assert {u["role"] for u in users} == {"histology_assistant", "pathologist", "research_lead",
                                              "medical_director", "admin"}
        assert all(u["fictional"] for u in users)
        r = c.post("/api/v1/auth/demo-login", json={"userId": "user-director"})
        cookie = r.headers["set-cookie"].lower()
        assert "httponly" in cookie and "samesite=lax" in cookie and "path=/" in cookie
        me = c.get("/api/v1/auth/me").json()
        assert me["notice"].startswith("Demo role switch, not authentication")
        assert me["authentication"] == "none (demo role switch)" and me["user"]["role"] == "medical_director"
        assert "comment.write" in me["permissions"] and "label.expert_write" not in me["permissions"]
        assert c.post("/api/v1/auth/demo-login", json={"userId": "nobody"}).status_code == 404
        c.post("/api/v1/auth/logout")
        assert c.get("/api/v1/auth/me").status_code == 401


def test_audit_is_append_only_and_scrubbed(env, clients, cmu_variant, ids):
    from dermpath import audit as audit_mod
    from dermpath.db import session_scope
    from dermpath.models import AuditEvent, ImmutableRecordError, LabelVersion

    asst = clients("user-assistant")
    upload_bytes(asst, PID, cmu_variant, "Smith_John_2026-03-04.svs")
    with session_scope() as db:
        ev = db.query(AuditEvent).filter(AuditEvent.action == "upload.created").order_by(AuditEvent.id.desc()).first()
        after = ev.after_json
        assert set(after) >= {"filename_safe", "size", "sha256", "identifier_risk_flags"}
        assert "filename_date_like" in after["identifier_risk_flags"]
        ev.reason = "tamper"
        with pytest.raises(ImmutableRecordError):
            db.flush()
        db.rollback()
    with session_scope() as db:
        ev = db.query(AuditEvent).first()
        db.delete(ev)
        with pytest.raises(ImmutableRecordError):
            db.flush()
        db.rollback()
    from sqlalchemy.exc import DatabaseError

    with session_scope() as db:
        with pytest.raises(DatabaseError):
            db.execute(text("UPDATE audit_event SET reason='x'"))
        db.rollback()
    with session_scope() as db:
        with pytest.raises(DatabaseError):
            db.execute(text("DELETE FROM label_version"))
        db.rollback()
    with session_scope() as db:
        lv = db.query(LabelVersion).first()
        lv.value = "out_of_scope"
        with pytest.raises(ImmutableRecordError):
            db.flush()
        db.rollback()
    scrubbed = audit_mod._scrub({"password": "p", "session_token": "t", "pixels": [1, 2], "ok": "v",
                                 "blob": b"\x00\x01", "nested": {"api_secret": "s"}, "long": "x" * 900})
    assert scrubbed["password"] == scrubbed["session_token"] == scrubbed["pixels"] == "<redacted>"
    assert scrubbed["blob"] == "<binary omitted>" and scrubbed["nested"]["api_secret"] == "<redacted>"
    assert scrubbed["ok"] == "v" and len(scrubbed["long"]) < 600
    # No audit row anywhere contains slide bytes.
    with session_scope() as db:
        rows = db.execute(text("SELECT after_json FROM audit_event")).all()
        assert not any("II*" in str(r[0]) for r in rows)


def test_storage_keys_privacy_and_s3_dependency_state(env, tmp_path):
    from dermpath.storage import LocalObjectStore, S3ObjectStore, StoreDependencyError, StoreError

    settings, _ = env
    store = LocalObjectStore(tmp_path / "objs")
    for bad in ("../escape", "a/../../b", "/abs", "a//b", "a/", "", "x" * 400):
        with pytest.raises(StoreError):
            store.put_bytes(bad, b"x")
    store.put_bytes("projects/p/slides/s/original.svs", b"abc")
    assert store.get_bytes("projects/p/slides/s/original.svs") == b"abc"
    assert oct((tmp_path / "objs").stat().st_mode & 0o777) == "0o700"
    s3 = S3ObjectStore(replace(settings, object_store="s3", s3_bucket="b"))
    h = s3.health()
    try:
        import boto3  # noqa: F401

        has_boto = True
    except ImportError:
        has_boto = False
    if not has_boto:
        assert h["status"] == "missing_dependency" and h["dependency"] == "boto3"
        with pytest.raises(StoreDependencyError):
            s3.put_bytes("k", b"x")
    # The object root is inside var/, which is never a web root.
    assert settings.objects_dir.is_relative_to(settings.var_dir)


def test_s3_backend_selected_without_boto3_reports_in_health(env):
    from dermpath.main import create_app

    settings, _ = env
    app = create_app(replace(settings, object_store="s3", s3_bucket="demo"))
    with TestClient(app) as c:
        store = c.get("/api/v1/health").json()["checks"]["object_store"]
        assert store["backend"] == "s3" and store["status"] in ("missing_dependency", "ok", "error")


def test_field_images_are_never_whole_slide_images(clients, run_worker):
    asst = clients("user-assistant")
    buf = io.BytesIO()
    Image.new("RGB", (640, 480), (180, 90, 140)).save(buf, "JPEG", quality=90)
    up = upload_bytes(asst, PID, buf.getvalue(), "camera_field.jpg", extra={"kind_hint": "field_image"})
    assert up["status"] == "completed" and up["kind"] == "field_image"
    run_worker()
    s = asst.get(f"/api/v1/slides/{up['slide_id']}").json()
    assert s["image_kind"] == "field_image" and s["is_whole_slide_image"] is False
    assert (s["width"], s["height"], s["levels"]) == (640, 480, 1)  # never rescaled into a pyramid
    assert s["mpp_x"] is None and s["scale_bar_allowed"] is False
    qc = asst.get(f"/api/v1/slides/{up['slide_id']}/qc").json()
    assert "missing_calibration" in {i["category"] for i in qc["issues"]}
    el = asst.get(f"/api/v1/slides/{up['slide_id']}/eligibility?eligible_review_states=pending_review").json()
    assert any(r["code"] == "field_image_not_wsi" for r in el["reasons"])
    tok = asst.get(f"/api/v1/slides/{up['slide_id']}/viewer-token").json()
    assert tok["image_kind"] == "field_image" and asst.get(tok["dzi_url"]).status_code == 200
    # PNG too.
    png = io.BytesIO()
    Image.new("RGB", (50, 40), (10, 200, 10)).save(png, "PNG")
    up2 = upload_bytes(asst, PID, png.getvalue(), "field.png")
    run_worker()
    assert asst.get(f"/api/v1/slides/{up2['slide_id']}").json()["format"] == "png"


def test_filename_identifier_risk_flags():
    from dermpath.slides.identifier_risk import MESSAGE, filename_flags

    def codes(name):
        return {f["code"] for f in filename_flags(name)}

    assert codes("CMU-1-Small-Region.svs") == set()
    assert codes("synthetic_field_photo.png") == set()
    assert {"filename_date_like", "filename_name_like"} <= codes("Smith_John_2026-03-04.svs")
    assert "filename_name_like" in codes("Doe, Jane.svs")
    assert "filename_date_like" in codes("biopsy 3-14-26.svs")
    assert "filename_date_like" in codes("scan_14Mar2026.jpg")
    assert "filename_identifier_keyword" in codes("MRN_slide.svs")
    assert "filename_long_number" in codes("12345678.svs")
    assert "filename_accession_like" in codes("S26-12345_A1.svs")
    assert all(f["message"] == MESSAGE for f in filename_flags("Smith_John_2026-03-04.svs"))


def test_upload_reports_filename_flags_and_checkbox_is_not_deidentification(clients, cmu_variant):
    asst = clients("user-assistant")
    body = {"filename": "Garcia_Maria_2026-02-01.svs", "size": len(cmu_variant), "sha256": "e" * 64,
            "provenance": "public_cc0", "governance_attestation": True}
    up = asst.post(f"/api/v1/projects/{PID}/uploads", json=body).json()
    assert {f["code"] for f in up["identifier_risk"]} >= {"filename_date_like", "filename_name_like"}
    assert "NOT proof of de-identification" in up["governance_note"]


def test_seeded_demo_scenario(clients, ids):
    lead = clients("user-research-lead")
    stats = lead.get(f"/api/v1/projects/{PID}/workflow-stats").json()
    assert stats["kind"] == "workflow_metadata" and stats["seeded_fictional"] is True
    assert stats["patients"] == 7 and stats["slides"] == 17  # six coded patients + the CC0 placeholder
    assert stats["slides_by_ingest_status"] == {"succeeded": 16, "failed": 1}
    assert stats["slides_by_review_state"]["approved"] == 8 and stats["slides_by_review_state"]["disputed"] == 1
    assert stats["slides_by_review_state"]["excluded"] == 1
    assert stats["slides_by_provenance"] == {"demo_synthetic": 16, "public_cc0": 1}
    assert set(stats["qc_issues_by_status"]) == {"open", "reviewed", "action_suggested", "resolved"}
    patients = {p["code"] for p in lead.get(f"/api/v1/projects/{PID}/patients").json()["items"]}
    assert patients == {"P-0001", "P-0002", "P-0003", "P-0004", "P-0005", "P-0006", "PUB-0001"}
    cases = {c["accession_code"]: c for c in lead.get(f"/api/v1/projects/{PID}/cases").json()["items"]}
    assert cases["DEMO-S26-0006"]["incomplete"] is True and cases["DEMO-S26-0001"]["parts"] == ["A", "B"]
    case = lead.get(f"/api/v1/cases/{cases['DEMO-S26-0001']['id']}").json()
    assert [p["designation"] for p in case["parts"]] == ["A", "B"]
    assert [s["level_index"] for s in case["parts"][0]["blocks"][0]["slides"]] == [1, 2]
    stains = {s["stain"] for s in lead.get(f"/api/v1/projects/{PID}/worklist").json()["items"]}
    assert "PAS" in stains and "H&E" in stains
    excluded = lead.get(f"/api/v1/slides/{ids['slides']['p3_b1_l1_low']}").json()
    assert excluded["review_state"] == "excluded" and "insufficient tissue" in excluded["review_state_reason"]
    users = {u["display_name"] for u in lead.get("/api/v1/auth/demo-users").json()}
    assert "Robb Wilentz" not in " ".join(users) and "Wilentz" not in " ".join(users)
    wl = lead.get(f"/api/v1/projects/{PID}/worklist").json()
    assert wl["sort"].startswith("accession order")
    assert lead.get(f"/api/v1/projects/{PID}").json()["task_template"]["classes"] == ["bcc_present",
                                                                                     "bcc_absent_not_benign"]


def test_hierarchy_crud_and_code_validation(clients):
    asst = clients("user-assistant")
    for bad in ("John Smith", "p-0001", "19800101", "P-19800101", "P 0001"):
        r = asst.post(f"/api/v1/projects/{PID}/patients", json={"code": bad})
        assert r.status_code == 422, bad
    p = asst.post(f"/api/v1/projects/{PID}/patients", json={"code": "P-0042"}).json()
    assert asst.post(f"/api/v1/projects/{PID}/patients", json={"code": "P-0042"}).status_code == 409
    c = asst.post(f"/api/v1/projects/{PID}/cases", json={"coded_patient_id": p["id"], "accession_code": "DEMO-S26-0042",
                                                         "collected_on": "2026-09-01", "site_id": "site-north"})
    assert c.status_code == 201 and "study code" in c.json()["identifier_note"]
    part = asst.post(f"/api/v1/cases/{c.json()['id']}/parts", json={"designation": "A"}).json()
    blk = asst.post(f"/api/v1/parts/{part['id']}/blocks", json={"designation": "A1"})
    assert blk.status_code == 201
    assert asst.post(f"/api/v1/parts/{part['id']}/blocks", json={"designation": "a1"}).status_code == 422
    r = asst.patch(f"/api/v1/cases/{c.json()['id']}", json={"site_id": "site-south", "reason": "corrected"})
    assert r.status_code == 200 and r.json()["site_id"] == "site-south"
    assert clients("user-pathologist").post(f"/api/v1/projects/{PID}/patients", json={"code": "P-0043"}).status_code == 403


def test_schema_version_mismatch_is_reported(env):
    from dermpath import db as dbmod
    from dermpath.db import SchemaMismatchError, init_db, session_scope

    with session_scope() as s:
        s.add(dbmod.SchemaVersion(version=999, description="future"))
    with pytest.raises(SchemaMismatchError):
        init_db()


def test_optional_ml_modules_are_reported_not_required(app):
    assert app.state.optional_routers["dermpath.ml.router"] in ("not_present", "mounted")


def test_demo_reset_is_admin_only(clients):
    assert clients("user-research-lead").post("/api/v1/demo/reset").status_code == 403
    r = clients("user-admin").post("/api/v1/demo/reset")
    assert r.status_code == 200 and r.json()["seed"]["project_id"] == PID
    lead = clients("user-research-lead")
    assert lead.get(f"/api/v1/projects/{PID}/workflow-stats").json()["slides"] == 17



def test_imageless_cohort_records_are_marked_and_not_viewable(clients):
    """Pipeline-test cohort slide records carry metadata only: image_available is false and the viewer refuses."""
    lead = clients("user-research-lead")
    cohort_items = lead.get("/api/v1/projects/proj-synthetic-cohort/worklist")
    if cohort_items.status_code != 200 or not cohort_items.json()["items"]:
        import pytest
        pytest.skip("synthetic cohort not seeded in this test database")
    cohort_id = cohort_items.json()["items"][0]["slide_id"]
    s = lead.get(f"/api/v1/slides/{cohort_id}").json()
    assert s["image_available"] is False and "metadata only" in s["image_unavailable_reason"]
    v = lead.get(f"/api/v1/slides/{cohort_id}/viewer-token")
    assert v.status_code == 409 and v.json()["error"]["code"] == "image_unavailable"
    items = lead.get("/api/v1/projects/proj-bcc-demo/worklist").json()["items"]
    assert all("case_id" in i and "image_available" in i for i in items)
    viewable = [i for i in items if i["image_kind"] == "synthetic_tiles" and i["ingest_status"] == "succeeded"]
    assert viewable and all(i["image_available"] for i in viewable)
