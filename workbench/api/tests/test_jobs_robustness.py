"""Job robustness (design §10): heartbeat resilience, lease fencing, settle hooks."""

from __future__ import annotations

import time
from datetime import timedelta

import pytest
from sqlalchemy import select, update
from sqlalchemy.exc import OperationalError

from dermpath.jobs import queue, registry
from dermpath.jobs.registry import HandlerSpec, JobContext, LeaseLost, PermanentJobError


def _handler(monkeypatch, job_type: str, func) -> None:
    monkeypatch.setitem(registry.HANDLERS, job_type, HandlerSpec(type=job_type, func=func))


def _enqueue(job_type: str, payload: dict | None = None, **kw) -> str:
    from dermpath.db import session_scope

    with session_scope() as db:
        job, _ = queue.enqueue(db, job_type, payload or {}, idempotency_key=f"{job_type}:{time.time_ns()}", **kw)
        return job.id


def _job(job_id: str):
    from dermpath.db import session_scope
    from dermpath.models import Job

    with session_scope() as db:
        job = db.get(Job, job_id)
        db.expunge(job)
        return job


def _steal(job_id: str, *, owner: str = "worker-2", bump_attempt: bool = True) -> None:
    """What claim_next does when another worker reclaims an expired lease."""
    from dermpath.db import session_scope
    from dermpath.models import Job

    values = {"lease_owner": owner}
    if bump_attempt:
        values["attempts"] = Job.attempts + 1
    with session_scope() as db:
        db.execute(update(Job).where(Job.id == job_id).values(**values))


# --------------------------------------------------------------------------- heartbeat


def test_heartbeat_thread_survives_transient_db_errors(env, monkeypatch):
    from dermpath.jobs.worker import Worker

    real = queue.heartbeat
    calls = {"n": 0}

    def flaky(*args, **kwargs):
        calls["n"] += 1
        if calls["n"] <= 3:
            raise OperationalError("UPDATE job ...", {}, Exception("database is locked"))
        return real(*args, **kwargs)

    monkeypatch.setattr(queue, "heartbeat", flaky)

    def slow(ctx, payload):
        time.sleep(1.6)
        return {"done": True}

    _handler(monkeypatch, "test_hb_slow", slow)
    jid = _enqueue("test_hb_slow")
    worker = Worker("hb-worker", lease_seconds=1, types=["test_hb_slow"], record_heartbeat=False)
    worker.heartbeat_retry_seconds = 0.02
    started = time.time()
    [outcome] = worker.run_until_idle()
    assert outcome.status == "succeeded", outcome
    state = worker.last_lease_state
    assert state["renewal_failures"] == 3 and state["renewals"] >= 1 and state["lost"] is False
    job = _job(jid)
    assert job.status == "succeeded" and job.heartbeat_at.timestamp() > started + 0.4  # renewed after the errors


def test_heartbeat_stops_only_on_lease_loss_and_result_is_discarded(env, monkeypatch):
    from dermpath.jobs.worker import Worker

    def stolen(ctx, payload):
        _steal(ctx.job_id)
        time.sleep(0.8)  # the heartbeat (every 0.5 s) sees the new owner
        return {"should": "be discarded"}

    _handler(monkeypatch, "test_hb_stolen", stolen)
    jid = _enqueue("test_hb_stolen")
    worker = Worker("hb-worker", lease_seconds=1, types=["test_hb_stolen"], record_heartbeat=False)
    outcome = worker.run_once()
    assert outcome.status == "lease_lost"
    assert worker.last_lease_state["lost"] is True
    job = _job(jid)
    assert job.status == "running" and job.lease_owner == "worker-2" and job.result_json is None


def test_progress_reports_are_best_effort(env, monkeypatch):
    from dermpath.jobs.worker import Worker

    real = queue.heartbeat

    def flaky(*args, **kwargs):
        if kwargs.get("message") == "step 1":
            raise OperationalError("UPDATE job ...", {}, Exception("database is locked"))
        return real(*args, **kwargs)

    monkeypatch.setattr(queue, "heartbeat", flaky)

    def steps(ctx, payload):
        for i in range(3):
            ctx.progress(i / 3, f"step {i}")
        return {"steps": 3}

    _handler(monkeypatch, "test_progress", steps)
    _enqueue("test_progress")
    [outcome] = Worker("p-worker", types=["test_progress"], record_heartbeat=False).run_until_idle()
    assert outcome.status == "succeeded"


# --------------------------------------------------------------------------- assert_lease


def _claimed_ctx(job_type: str = "test_fence") -> JobContext:
    jid = _enqueue(job_type)
    job = queue.claim_next("worker-1", types=[job_type])
    assert job is not None and job.id == jid
    return JobContext(job_id=job.id, type=job.type, project_id=None, payload={}, attempt=job.attempts,
                      worker_id="worker-1", created_by=None, retry_count=job.retry_count)


def _audit(db, action: str, job_id: str) -> None:
    from dermpath import audit

    audit.record(db, action=action, entity_type="job", entity_id=job_id, actor_id=None, actor_role=None,
                 project_id=None)


def _audit_count(db, action: str) -> int:
    from sqlalchemy import func

    from dermpath.models import AuditEvent

    return db.scalar(select(func.count(AuditEvent.id)).where(AuditEvent.action == action))


def test_assert_lease_fences_the_domain_commit(env):
    from dermpath.db import session_scope

    ctx = _claimed_ctx()
    before = _job(ctx.job_id).lease_until
    with session_scope() as db:
        _audit(db, "test.fenced_commit", ctx.job_id)
        ctx.assert_lease(db)  # owner, attempt, status: commit proceeds and the lease is renewed
    assert _job(ctx.job_id).lease_until >= before
    _steal(ctx.job_id)  # another worker reclaimed the expired lease
    with pytest.raises(LeaseLost):
        with session_scope() as db:
            _audit(db, "test.stale_commit", ctx.job_id)
            registry.assert_lease(ctx, db)
    with session_scope() as db:
        assert _audit_count(db, "test.fenced_commit") == 1
        assert _audit_count(db, "test.stale_commit") == 0  # the stale attempt's domain write rolled back


@pytest.mark.parametrize("change", ["same_owner_new_attempt", "not_running", "retried"])
def test_assert_lease_checks_attempt_status_and_retry(env, change):
    from dermpath.db import session_scope
    from dermpath.models import Job

    ctx = _claimed_ctx()
    ctx.assert_lease()  # own transaction: still the owner
    with session_scope() as db:
        if change == "same_owner_new_attempt":  # a restarted worker with a stable id reclaimed it
            db.execute(update(Job).where(Job.id == ctx.job_id).values(attempts=Job.attempts + 1))
        elif change == "not_running":
            db.execute(update(Job).where(Job.id == ctx.job_id).values(status="failed"))
        else:  # failed, retried by a person, claimed again by the same worker id on attempt 1
            db.execute(update(Job).where(Job.id == ctx.job_id).values(retry_count=Job.retry_count + 1))
    with pytest.raises(LeaseLost):
        ctx.assert_lease()


def test_assert_lease_trusts_an_observed_loss_without_the_db(env):
    ctx = _claimed_ctx()
    ctx._lease_lost = lambda: True
    with pytest.raises(LeaseLost, match="observed by the heartbeat"):
        ctx.assert_lease()


def test_worker_handler_can_fence_its_commit(env, monkeypatch):
    from dermpath.db import session_scope
    from dermpath.jobs.worker import Worker

    def fenced(ctx, payload):
        with ctx.session() as db:
            ctx.assert_lease(db)
        _steal(ctx.job_id, owner=ctx.worker_id)  # same id, next attempt
        with ctx.session() as db:
            ctx.assert_lease(db)
        return {"unreachable": True}

    _handler(monkeypatch, "test_fenced", fenced)
    jid = _enqueue("test_fenced")
    [outcome] = Worker("f-worker", types=["test_fenced"], record_heartbeat=False).run_until_idle()
    assert outcome.status == "lease_lost"
    assert _job(jid).result_json is None


# --------------------------------------------------------------------------- settle hooks


@pytest.fixture()
def run_row(env):
    """A queued TrainingRun on the seeded synthetic cohort (the domain row a hook settles)."""
    from test_ml_support import CID, cohort

    from dermpath.db import session_scope
    from dermpath.ml.models import TrainingRun
    from dermpath.models import DatasetVersion

    _, ids = env
    dv_id = cohort(ids)["dataset_version_id"]
    with session_scope() as db:
        dv = db.get(DatasetVersion, dv_id)
        run = TrainingRun(project_id=CID, name="settle", dataset_version_id=dv_id,
                          dataset_manifest_sha256=dv.manifest_sha256, encoder_id="synthetic-deterministic-v1",
                          head="meanpool_logreg", params_json={}, seed=0, status="running", synthetic=True,
                          label_scope="slide", positive_class="bcc_present",
                          negative_class="bcc_absent_not_benign", created_by="user-research-lead",
                          execution_mode="synthetic_pipeline_test")
        db.add(run)
        db.flush()
        return run.id


@pytest.fixture()
def hooks(monkeypatch):
    """Settle hooks for test job types; each call is recorded and settles the run row."""
    from dermpath.ml.models import TrainingRun

    calls: list[tuple] = []

    def settle_run(db, job, status, error):
        calls.append((job.id, job.type, status, error))
        run = db.get(TrainingRun, (job.payload_json or {}).get("run_id"))
        if run is not None and run.status in ("queued", "running"):
            run.status, run.error = status, f"job {status}: {error}"

    for job_type in ("test_settle", "test_settle_perm", "test_settle_flaky", "test_settle_cancel"):
        monkeypatch.setitem(registry.SETTLE_HOOKS, job_type, [settle_run])
    return calls


def _run_status(run_id: str) -> tuple[str, str | None]:
    from dermpath.db import session_scope
    from dermpath.ml.models import TrainingRun

    with session_scope() as db:
        run = db.get(TrainingRun, run_id)
        return run.status, run.error


def _expire(job_id: str, **values) -> None:
    from dermpath.db import session_scope, utcnow
    from dermpath.models import Job

    with session_scope() as db:
        db.execute(update(Job).where(Job.id == job_id)
                   .values(lease_until=utcnow() - timedelta(seconds=5), **values))


@pytest.mark.parametrize("cancel", [False, True])
def test_recover_expired_settles_the_domain_row(env, run_row, hooks, cancel):
    jid = _enqueue("test_settle", {"run_id": run_row}, max_attempts=1)
    assert queue.claim_next("crashed-worker", types=["test_settle"]).id == jid
    _expire(jid, cancel_requested=cancel)  # the worker died; its lease ran out
    assert queue.claim_next("rescuer", types=["test_settle"]) is None
    expected = "canceled" if cancel else "failed"
    assert _job(jid).status == expected
    assert [(c[0], c[2]) for c in hooks] == [(jid, expected)]
    status, error = _run_status(run_row)
    assert status == expected and "lease expired" in error


def test_worker_failures_and_cancel_settle_the_domain_row(env, run_row, hooks, monkeypatch):
    from dermpath.db import session_scope
    from dermpath.jobs.worker import Worker
    from dermpath.models import Job

    def perm(ctx, payload):
        raise PermanentJobError("corrupt input")

    def flaky(ctx, payload):
        raise RuntimeError("disk full")

    def ok(ctx, payload):
        return {}

    _handler(monkeypatch, "test_settle_perm", perm)
    _handler(monkeypatch, "test_settle_flaky", flaky)
    _handler(monkeypatch, "test_settle", ok)
    j_perm = _enqueue("test_settle_perm", {"run_id": run_row})
    j_flaky = _enqueue("test_settle_flaky", {"run_id": "no-such-run"}, max_attempts=1)
    j_ok = _enqueue("test_settle", {"run_id": "no-such-run"})
    outcomes = Worker("s-worker", types=["test_settle_perm", "test_settle_flaky", "test_settle"],
                      record_heartbeat=False).run_until_idle()
    assert {o.job_id: o.status for o in outcomes} == {j_perm: "failed", j_flaky: "failed", j_ok: "succeeded"}
    assert {(c[0], c[2]) for c in hooks} == {(j_perm, "failed"), (j_flaky, "failed")}  # never on success
    assert _run_status(run_row) == ("failed", "job failed: corrupt input")
    # Cancelling a queued job settles it too.
    j_cancel = _enqueue("test_settle_cancel", {"run_id": run_row})
    with session_scope() as db:
        assert queue.request_cancel(db, db.get(Job, j_cancel)) == "canceled"
    assert hooks[-1][:3] == (j_cancel, "test_settle_cancel", "canceled")


def test_a_failing_hook_never_blocks_the_queue(env, run_row, monkeypatch):
    seen = []

    def broken(db, job, status, error):
        _audit(db, "test.partial_hook_write", job.id)
        db.flush()
        raise RuntimeError("bug in a hook")

    def good(db, job, status, error):
        seen.append(status)

    monkeypatch.setitem(registry.SETTLE_HOOKS, "test_settle", [broken, good])
    jid = _enqueue("test_settle", {"run_id": run_row}, max_attempts=1)
    queue.claim_next("crashed-worker", types=["test_settle"])
    _expire(jid)
    queue.claim_next("rescuer", types=["test_settle"])
    assert _job(jid).status == "failed" and seen == ["failed"]
    from dermpath.db import session_scope

    with session_scope() as db:
        assert _audit_count(db, "test.partial_hook_write") == 0  # rolled back to its savepoint


def test_register_settle_hook_forms_and_dedupe(monkeypatch):
    monkeypatch.setattr(registry, "SETTLE_HOOKS", {})

    @registry.register_settle_hook("t1")
    def a(db, job, status, error):
        pass

    def b(db, job, status, error):
        pass

    registry.register_settle_hook("t1", b)
    registry.register_settle_hook("t1", b)
    assert registry.SETTLE_HOOKS == {"t1": [a, b]}
    assert registry.run_settle_hooks(None, type("J", (), {"type": "t1", "id": "x"})(), "succeeded", None) == 0
