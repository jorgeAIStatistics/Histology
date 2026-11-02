"""Acceptance 1 (resume an interrupted upload; recover after a worker restart) and
Acceptance 2 (reject corrupt/unsupported files without losing other jobs)."""

from __future__ import annotations

import io
import os
import signal
import subprocess
import sys
import time
from datetime import timedelta
from pathlib import Path

from PIL import Image
from sqlalchemy import select

from conftest import API_DIR, TEST_SECRET, sha256_bytes, upload_bytes

PID = "proj-bcc-demo"


def _init(client, data: bytes, filename: str, **extra):
    body = {"filename": filename, "size": len(data), "sha256": sha256_bytes(data), "provenance": "public_cc0"}
    body.update(extra)
    return client.post(f"/api/v1/projects/{PID}/uploads", json=body)


def _put(client, uid, index, chunk, sha=None):
    return client.put(f"/api/v1/uploads/{uid}/chunks/{index}", content=chunk,
                      headers={"X-Chunk-SHA256": sha or sha256_bytes(chunk)})


# --------------------------------------------------------------------------- Acceptance 1: uploads


def test_interrupted_upload_resumes_and_completes(clients, cmu_variant, run_worker, env):
    settings, _ = env
    asst = clients("user-assistant")
    r = _init(asst, cmu_variant, "cmu-variant.svs",
              new_hierarchy={"patient_code": "P-0901", "accession_code": "DEMO-S26-0901",
                             "part_designation": "A", "block_designation": "A1", "site_id": "site-north"})
    assert r.status_code == 201, r.text
    up = r.json()
    uid, cs = up["upload_id"], up["chunk_size"]
    assert cs == 256 * 1024 and up["received_bytes"] == 0 and up["total_chunks"] == -(-len(cmu_variant) // cs)

    # Three chunks arrive, then the connection drops mid-chunk (truncated body).
    for i in range(3):
        assert _put(asst, uid, i, cmu_variant[i * cs:(i + 1) * cs]).status_code == 200
    full = cmu_variant[3 * cs:4 * cs]
    rr = _put(asst, uid, 3, full[: cs // 3], sha=sha256_bytes(full))
    assert rr.status_code == 422 and rr.json()["error"]["code"] == "chunk_length_mismatch"

    # Simulate a server crash after appending bytes but before recording them.
    part = settings.uploads_dir / f"{uid}.part"
    with open(part, "ab") as fh:
        fh.write(b"garbage-from-a-crash" * 100)

    # The client asks where to resume.
    st = asst.get(f"/api/v1/uploads/{uid}").json()
    assert st["received_bytes"] == 3 * cs and st["next_chunk_index"] == 3 and st["status"] == "receiving"

    # Re-sending an already received chunk is idempotent; skipping ahead is refused.
    again = _put(asst, uid, 1, cmu_variant[cs:2 * cs])
    assert again.status_code == 200 and again.json()["already_received"] is True
    ahead = _put(asst, uid, 5, cmu_variant[5 * cs:6 * cs])
    assert ahead.status_code == 409 and ahead.json()["error"]["details"]["expected_index"] == 3
    bad = _put(asst, uid, 3, full, sha="0" * 64)
    assert bad.status_code == 422 and bad.json()["error"]["code"] == "chunk_checksum_mismatch"

    # Re-initialising the same upload returns the resumable one (not a new upload).
    again_init = _init(asst, cmu_variant, "cmu-variant.svs")
    assert again_init.status_code == 200 and again_init.json()["upload_id"] == uid and again_init.json()["resumed"]

    # Complete before all bytes → refused with the resume point.
    early = asst.post(f"/api/v1/uploads/{uid}/complete")
    assert early.status_code == 409 and early.json()["error"]["details"]["next_chunk_index"] == 3

    for i in range(3, st["total_chunks"]):
        assert _put(asst, uid, i, cmu_variant[i * cs:(i + 1) * cs]).status_code == 200
    done = asst.post(f"/api/v1/uploads/{uid}/complete")
    assert done.status_code == 200, done.text
    d = done.json()
    assert d["status"] == "completed" and d["slide_id"] and d["job_id"]
    assert not part.exists()

    # Stored under a generated key; the original filename is metadata only.
    from dermpath.db import session_scope
    from dermpath.models import Slide

    with session_scope() as db:
        s = db.get(Slide, d["slide_id"])
        assert "cmu-variant" not in s.object_key and s.object_key.endswith("/original.svs")
        assert s.original_filename == "cmu-variant.svs" and s.sha256 == sha256_bytes(cmu_variant)
        stored = Path(settings.objects_dir) / s.object_key
        assert stored.read_bytes() == cmu_variant
        assert oct(stored.stat().st_mode & 0o777) == "0o600"

    outcomes = run_worker()
    assert {(o.type, o.status) for o in outcomes} >= {("ingest", "succeeded"), ("qc_screen", "succeeded")}
    slide = asst.get(f"/api/v1/slides/{d['slide_id']}").json()
    assert slide["ingest_status"] == "succeeded" and slide["width"] == 2220 and slide["height"] == 2967
    assert slide["lineage"]["patient_code"] == "P-0901"


def test_duplicate_detected_by_sha256_and_never_ingested_twice(clients, cmu_bytes, ids):
    asst = clients("user-assistant")
    r = _init(asst, cmu_bytes, "another-name.svs")
    assert r.status_code == 409
    err = r.json()["error"]
    assert err["code"] == "duplicate_slide" and err["details"]["existing_slide_id"] == ids["slides"]["cmu_cc0"]


def test_duplicate_detected_at_completion(clients, cmu_variant, run_worker):
    """Two people upload the same new file concurrently: the second completion is reported as a
    duplicate of the first slide and nothing is ingested twice."""
    from dermpath.db import session_scope
    from dermpath.models import Slide, Upload

    asst = clients("user-assistant")
    u1 = _init(asst, cmu_variant, "first.svs").json()
    cs = u1["chunk_size"]
    for i in range(u1["total_chunks"]):
        assert _put(asst, u1["upload_id"], i, cmu_variant[i * cs:(i + 1) * cs]).status_code == 200
    with session_scope() as db:  # pretend a colleague started u1, so u2 is a separate upload
        db.get(Upload, u1["upload_id"]).created_by = "user-colleague"
    second = upload_bytes(asst, PID, cmu_variant, "second.svs")
    assert second["status"] == "completed" and second["upload_id"] != u1["upload_id"]
    dup = asst.post(f"/api/v1/uploads/{u1['upload_id']}/complete")
    assert dup.status_code == 200
    assert dup.json()["status"] == "duplicate" and dup.json()["duplicate_of_slide_id"] == second["slide_id"]
    with session_scope() as db:
        assert len(db.query(Slide).filter(Slide.sha256 == sha256_bytes(cmu_variant)).all()) == 1
    # Same content again → 409 at init, pointing at the existing slide.
    again = _init(asst, cmu_variant, "again.svs")
    assert again.status_code == 409 and again.json()["error"]["details"]["existing_slide_id"] == second["slide_id"]


def test_whole_file_checksum_mismatch_fails_upload(clients, cmu_variant):
    asst = clients("user-assistant")
    data = cmu_variant[:300_000]
    r = asst.post(f"/api/v1/projects/{PID}/uploads", json={
        "filename": "lie.svs", "size": len(data), "sha256": "a" * 64, "provenance": "public_cc0"})
    up = r.json()
    cs = up["chunk_size"]
    for i in range(up["total_chunks"]):
        chunk = data[i * cs:(i + 1) * cs]
        assert _put(asst, up["upload_id"], i, chunk).status_code == 200
    done = asst.post(f"/api/v1/uploads/{up['upload_id']}/complete")
    assert done.status_code == 422 and done.json()["error"]["code"] == "checksum_mismatch"
    assert asst.get(f"/api/v1/uploads/{up['upload_id']}").json()["status"] == "failed"


def test_upload_limits_and_validation(clients, env):
    asst = clients("user-assistant")
    ok = {"filename": "a.svs", "size": 10, "sha256": "b" * 64, "provenance": "public_cc0"}
    big = asst.post(f"/api/v1/projects/{PID}/uploads", json={**ok, "size": 10**12})
    assert big.status_code == 413 and big.json()["error"]["code"] == "too_large"
    ext = asst.post(f"/api/v1/projects/{PID}/uploads", json={**ok, "filename": "a.ndpi"})
    assert ext.status_code == 415 and ext.json()["error"]["code"] == "unsupported_extension"
    exe = asst.post(f"/api/v1/projects/{PID}/uploads", json={**ok, "filename": "payload.exe"})
    assert exe.status_code == 415
    hint = asst.post(f"/api/v1/projects/{PID}/uploads", json={**ok, "kind_hint": "field_image"})
    assert hint.status_code == 422 and hint.json()["error"]["code"] == "kind_mismatch"
    real = asst.post(f"/api/v1/projects/{PID}/uploads", json={**ok, "provenance": "real_authorized"})
    assert real.status_code == 409 and real.json()["error"]["code"] == "real_data_disabled"
    synth = asst.post(f"/api/v1/projects/{PID}/uploads", json={**ok, "provenance": "demo_synthetic"})
    assert synth.status_code == 422
    badcode = asst.post(f"/api/v1/projects/{PID}/uploads", json={**ok, "new_hierarchy": {
        "patient_code": "John Smith", "accession_code": "DEMO-1", "part_designation": "A", "block_designation": "A1"}})
    assert badcode.status_code == 422 and badcode.json()["error"]["code"] == "invalid_patient_code"
    # Path components are stripped from the stored safe filename.
    trav = asst.post(f"/api/v1/projects/{PID}/uploads", json={**ok, "filename": "../../etc/x.svs"})
    assert trav.status_code == 201 and trav.json()["filename_safe"] == "x.svs"


def test_upload_body_is_bounded(clients, cmu_variant):
    asst = clients("user-assistant")
    up = _init(asst, cmu_variant, "bounded.svs").json()
    cs = up["chunk_size"]
    oversized = cmu_variant[: cs + 1000]
    r = _put(asst, up["upload_id"], 0, oversized)
    assert r.status_code == 413 and r.json()["error"]["code"] == "chunk_too_large"
    assert asst.get(f"/api/v1/uploads/{up['upload_id']}").json()["received_bytes"] == 0


# --------------------------------------------------------------------------- Acceptance 1: worker restart


def test_expired_lease_is_reclaimed_after_simulated_crash(env, ids):
    """A job left 'running' by a dead worker (expired lease) is reclaimed and finishes."""
    from dermpath.db import session_scope, utcnow
    from dermpath.jobs import queue
    from dermpath.jobs.worker import Worker
    from dermpath.models import Job

    sid = ids["slides"]["cmu_cc0"]
    with session_scope() as db:
        job, created = queue.enqueue(db, "qc_screen", {"slide_id": sid}, idempotency_key="crash-test-1",
                                     project_id=PID, created_by="test")
        assert created
        job_id = job.id
    claimed = queue.claim_next("worker-that-will-crash", lease_seconds=30)
    assert claimed is not None and claimed.id == job_id and claimed.attempts == 1
    # The worker "crashes": no heartbeat, no completion. Its lease runs out.
    with session_scope() as db:
        j = db.get(Job, job_id)
        assert j.status == "running" and j.lease_owner == "worker-that-will-crash"
        j.lease_until = utcnow() - timedelta(seconds=1)
    # A fresh worker (after restart) reclaims and completes it.
    outcome = Worker("restarted-worker").run_once()
    assert outcome is not None and outcome.job_id == job_id and outcome.status == "succeeded"
    with session_scope() as db:
        j = db.get(Job, job_id)
        assert j.status == "succeeded" and j.attempts == 2 and j.result_json["qc_review_id"]
    # The crashed worker cannot overwrite the result later (lease lost).
    assert queue.finish(job_id, "worker-that-will-crash", status="failed", error="late") is False


def test_lease_expiry_after_max_attempts_fails_readably(env, ids):
    from dermpath.db import session_scope, utcnow
    from dermpath.jobs import queue
    from dermpath.models import Job

    with session_scope() as db:
        job, _ = queue.enqueue(db, "qc_screen", {"slide_id": ids["slides"]["cmu_cc0"]},
                               idempotency_key="crash-test-2", project_id=PID, max_attempts=1)
        job_id = job.id
    assert queue.claim_next("w1", lease_seconds=30).id == job_id
    with session_scope() as db:
        db.get(Job, job_id).lease_until = utcnow() - timedelta(seconds=1)
    assert queue.claim_next("w2") is None
    with session_scope() as db:
        j = db.get(Job, job_id)
        assert j.status == "failed" and "lease expired" in j.error and "worker crashed" in j.error


def test_real_worker_process_killed_mid_job_then_recovered(env):
    """Start `python -m dermpath.worker`, SIGKILL it mid-job, let the lease expire, recover."""
    import crash_handlers  # noqa: F401  (registers test handlers in this process too)

    from dermpath.db import session_scope
    from dermpath.jobs import queue
    from dermpath.jobs.worker import Worker
    from dermpath.models import Job

    settings, _ = env
    with session_scope() as db:
        job, _ = queue.enqueue(db, "test_sleep", {"seconds": 60}, idempotency_key="kill-test", project_id=PID)
        job_id = job.id
    child_env = {**os.environ, "WB_VAR_DIR": str(settings.var_dir), "WB_SECRET": TEST_SECRET,
                 "WB_JOB_LEASE_SECONDS": "2", "WB_EXTRA_HANDLER_MODULES": "crash_handlers", "WB_AUTO_SEED": "0",
                 "PYTHONPATH": os.pathsep.join([str(API_DIR), str(Path(__file__).parent / "helpers")])}
    proc = subprocess.Popen([sys.executable, "-m", "dermpath.worker", "--poll", "0.1", "--worker-id", "doomed",
                             "--types", "test_sleep"], cwd=API_DIR, env=child_env,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        deadline = time.time() + 30
        while time.time() < deadline:
            with session_scope() as db:
                j = db.get(Job, job_id)
                if j.status == "running" and j.lease_owner == "doomed":
                    break
            time.sleep(0.1)
        else:
            raise AssertionError("worker subprocess never claimed the job")
        time.sleep(0.8)  # let at least one heartbeat happen
        os.kill(proc.pid, signal.SIGKILL)
        proc.wait(timeout=10)
    finally:
        if proc.poll() is None:
            proc.kill()
    with session_scope() as db:
        j = db.get(Job, job_id)
        assert j.status == "running" and j.attempts == 1  # orphaned by the crash
    # Until the lease expires, nobody else can take it.
    assert Worker("too-early", types=["test_sleep"]).run_once() is None
    time.sleep(2.6)
    outcome = Worker("restarted", types=["test_sleep"]).run_once()
    assert outcome is not None and outcome.status == "succeeded"
    with session_scope() as db:
        j = db.get(Job, job_id)
        assert j.status == "succeeded" and j.attempts == 2 and j.result_json == {"attempt": 2, "finished": True}


def test_idempotency_retry_backoff_cancel(env, clients):
    import crash_handlers  # noqa: F401

    from dermpath.db import session_scope
    from dermpath.jobs import queue
    from dermpath.jobs.worker import Worker
    from dermpath.models import Job

    with session_scope() as db:
        a, c1 = queue.enqueue(db, "test_flaky", {"succeed_on": 2}, idempotency_key="flaky-1", project_id=PID)
        b, c2 = queue.enqueue(db, "test_flaky", {"succeed_on": 2}, idempotency_key="flaky-1", project_id=PID)
        assert c1 and not c2 and a.id == b.id
        jid = a.id
    w = Worker("w-flaky", types=["test_flaky"])
    first = w.run_once()
    assert first.status == "queued" and "transient failure" in first.error
    second = w.run_once()  # backoff base is 0 in tests
    assert second.status == "succeeded"
    with session_scope() as db:
        assert db.get(Job, jid).attempts == 2

    # Cancel a queued job via the API, then retry it.
    with session_scope() as db:
        q, _ = queue.enqueue(db, "test_flaky", {"succeed_on": 1}, idempotency_key="cancel-me", project_id=PID)
        qid = q.id
    lead = clients("user-research-lead")
    r = lead.post(f"/api/v1/jobs/{qid}/cancel")
    assert r.status_code == 200 and r.json()["status"] == "canceled"
    assert lead.post(f"/api/v1/jobs/{qid}/cancel").status_code == 409
    r = lead.post(f"/api/v1/jobs/{qid}/retry")
    assert r.status_code == 200 and r.json()["status"] == "queued" and r.json()["retry_count"] == 1
    assert Worker("w2", types=["test_flaky"]).run_once().status == "succeeded"
    # The director can read jobs but not manage them.
    director = clients("user-director")
    assert director.get(f"/api/v1/jobs/{qid}").status_code == 200
    assert director.post(f"/api/v1/jobs/{qid}/retry").status_code == 403


def test_running_job_cooperative_cancel(env):
    import threading

    import crash_handlers  # noqa: F401

    from dermpath.db import session_scope
    from dermpath.jobs import queue
    from dermpath.jobs.worker import Worker
    from dermpath.models import Job

    with session_scope() as db:
        j, _ = queue.enqueue(db, "test_cooperative", {}, idempotency_key="coop", project_id=PID)
        jid = j.id
    result = {}
    t = threading.Thread(target=lambda: result.setdefault("o", Worker("coop", types=["test_cooperative"]).run_once()))
    t.start()
    deadline = time.time() + 10
    while time.time() < deadline:
        with session_scope() as db:
            job = db.get(Job, jid)
            if job.status == "running" and job.progress > 0:
                assert queue.request_cancel(db, job) == "cancel_requested"
                break
        time.sleep(0.05)
    t.join(timeout=15)
    assert result["o"].status == "canceled"
    with session_scope() as db:
        assert db.get(Job, jid).status == "canceled"


# --------------------------------------------------------------------------- Acceptance 2: corrupt / unsupported


def test_corrupt_and_unsupported_files_fail_without_losing_other_jobs(clients, cmu_variant, run_worker):
    asst = clients("user-assistant")
    rng_bytes = bytes((i * 7919 + 13) % 256 for i in range(50_000))
    corrupt = upload_bytes(asst, PID, b"II*\x00" + rng_bytes, "broken_scan.svs")
    truncated = upload_bytes(asst, PID, cmu_variant[:200_000], "truncated.svs")
    buf = io.BytesIO()
    Image.new("RGB", (64, 48), (200, 120, 150)).save(buf, "PNG")
    png_named_svs = upload_bytes(asst, PID, buf.getvalue(), "actually_png.svs")
    good = upload_bytes(asst, PID, cmu_variant, "good.svs")
    jpeg = io.BytesIO()
    Image.new("RGB", (320, 240), (90, 160, 160)).save(jpeg, "JPEG")
    broken_jpeg = upload_bytes(asst, PID, jpeg.getvalue()[:400], "broken.jpg")
    for u in (corrupt, truncated, png_named_svs, good, broken_jpeg):
        assert u["status"] == "completed", u

    outcomes = run_worker()
    by_slide = {}
    from dermpath.db import session_scope
    from dermpath.models import Job

    with session_scope() as db:
        for o in outcomes:
            if o.type == "ingest":
                by_slide[db.get(Job, o.job_id).payload_json["slide_id"]] = o
    for bad in (corrupt, truncated, png_named_svs, broken_jpeg):
        assert by_slide[bad["slide_id"]].status == "failed"
        s = asst.get(f"/api/v1/slides/{bad['slide_id']}").json()
        assert s["ingest_status"] == "failed"
        assert "not eligible" in s["ingest_error"] and "recover" in s["ingest_error"].lower()
        # Never training-eligible; no viewer token.
        el = asst.get(f"/api/v1/slides/{bad['slide_id']}/eligibility").json()
        assert el["eligible"] is False and any(r["code"] == "ingest_failed" for r in el["reasons"])
        assert asst.get(f"/api/v1/slides/{bad['slide_id']}/viewer-token").status_code == 409
    assert by_slide[good["slide_id"]].status == "succeeded"
    assert asst.get(f"/api/v1/slides/{good['slide_id']}").json()["ingest_status"] == "succeeded"
    # Failed ingest jobs fail permanently after one attempt (no retry storm).
    with session_scope() as db:
        j = db.get(Job, corrupt["job_id"])
        assert j.status == "failed" and j.attempts == 1
        assert "unsupported_format" in j.error or "corrupt" in j.error
    # The QC job of the good slide ran too.
    assert any(o.type == "qc_screen" and o.status == "succeeded" for o in outcomes)

    # Recoverable: re-ingest can be requested; it fails again for the same bytes, others unaffected.
    rr = asst.post(f"/api/v1/slides/{corrupt['slide_id']}/reingest")
    assert rr.status_code == 200
    again = run_worker()
    assert [o.status for o in again if o.type == "ingest"] == ["failed"]


def test_seeded_scan_failure_is_failed_and_isolated(clients, ids):
    lead = clients("user-research-lead")
    s = lead.get(f"/api/v1/slides/{ids['slides']['p5_b1_l1_failed']}").json()
    assert s["ingest_status"] == "failed" and "[unsupported_format]" in s["ingest_error"]
    ok = lead.get(f"/api/v1/slides/{ids['slides']['cmu_cc0']}").json()
    assert ok["ingest_status"] == "succeeded"
