"""Database-backed job queue.

Lifecycle: ``queued → running → succeeded | failed | canceled`` (failed/canceled jobs can
be retried, which re-queues the same row).

* ``idempotency_key`` is unique: enqueueing the same key twice returns the existing job.
* Claiming is a compare-and-swap ``UPDATE … WHERE id=? AND (claimable)``; exactly one
  worker wins, on SQLite and on PostgreSQL alike (no ``SKIP LOCKED`` needed).
* A running job holds a lease (``lease_until``) renewed by heartbeats. If the worker
  crashes or restarts, the lease expires and another worker reclaims the job
  (``attempts`` increments). A job whose lease expires after ``max_attempts`` attempts
  is failed with a readable error instead of looping forever.
* Retryable failures are re-queued with exponential backoff (``not_before``).
* Cancellation is cooperative: queued jobs cancel immediately; running jobs get
  ``cancel_requested`` and stop at their next progress report.
* Every transition to ``failed`` or ``canceled`` made here (lease recovery, exhausted
  retries, permanent errors, cancel) runs the job type's settle hooks in the same
  transaction, so domain rows (``TrainingRun.status``, ``feature_set.status``) follow the
  job (:func:`dermpath.jobs.registry.register_settle_hook`).
* :func:`fence_lease` is the fencing primitive behind
  :func:`dermpath.jobs.registry.assert_lease` for domain commits.
"""

from __future__ import annotations

from datetime import timedelta
from typing import Any

from sqlalchemy import and_, func, or_, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..config import get_settings
from ..db import session_scope, utcnow
from ..models import Job
from .registry import run_settle_hooks

TERMINAL = ("succeeded", "failed", "canceled")


def enqueue(
    db: Session,
    job_type: str,
    payload: dict[str, Any],
    *,
    idempotency_key: str,
    project_id: str | None = None,
    created_by: str | None = None,
    max_attempts: int | None = None,
) -> tuple[Job, bool]:
    """Insert a job unless one with the same idempotency key exists.

    Returns ``(job, created)``. The caller's transaction is used (commit it yourself).
    """
    existing = db.scalars(select(Job).where(Job.idempotency_key == idempotency_key)).first()
    if existing is not None:
        return existing, False
    job = Job(
        type=job_type,
        payload_json=payload,
        idempotency_key=idempotency_key,
        project_id=project_id,
        created_by=created_by,
        max_attempts=max_attempts or get_settings().job_max_attempts,
        not_before=utcnow(),
    )
    try:
        with db.begin_nested():
            db.add(job)
            db.flush()
    except IntegrityError:
        existing = db.scalars(select(Job).where(Job.idempotency_key == idempotency_key)).first()
        if existing is None:
            raise
        return existing, False
    return job, True


def _claimable(now):
    return or_(
        and_(Job.status == "queued", Job.not_before <= now),
        and_(Job.status == "running", Job.lease_until < now),
    )


def recover_expired(db: Session, now=None) -> dict[str, int]:
    """Settle running jobs whose lease expired and that must not run again."""
    now = now or utcnow()
    stats = {"canceled": 0, "failed": 0}
    rows = db.scalars(
        select(Job).where(Job.status == "running", Job.lease_until < now)
    ).all()
    for job in rows:
        if job.cancel_requested:
            status, error = "canceled", "canceled (lease expired after cancel was requested)"
        elif job.attempts >= job.max_attempts:
            status, error = "failed", (f"lease expired on attempt {job.attempts} of {job.max_attempts} "
                                       "(worker crashed or was restarted); no attempts left. Use retry.")
        else:
            continue
        res = db.execute(
            update(Job)
            .where(Job.id == job.id, Job.status == "running", Job.lease_until < now)
            .values(status=status, finished_at=now, lease_owner=None, lease_until=None, error=error)
            .execution_options(synchronize_session=False)
        )
        stats[status] += res.rowcount
        if res.rowcount == 1:
            db.refresh(job)
            run_settle_hooks(db, job, status, error)
    return stats


def claim_next(worker_id: str, *, lease_seconds: int | None = None, types: list[str] | None = None) -> Job | None:
    """Atomically claim one job (queued, or running with an expired lease)."""
    lease = lease_seconds if lease_seconds is not None else get_settings().job_lease_seconds
    with session_scope() as db:
        now = utcnow()
        recover_expired(db, now)
        db.flush()
        q = select(Job.id).where(_claimable(now))
        if types is not None:
            q = q.where(Job.type.in_(types))
        q = q.order_by(Job.created_at, Job.id).limit(20)
        for job_id in db.scalars(q).all():
            res = db.execute(
                update(Job)
                .where(Job.id == job_id, _claimable(now))
                .values(
                    status="running",
                    lease_owner=worker_id,
                    lease_until=now + timedelta(seconds=lease),
                    heartbeat_at=now,
                    attempts=Job.attempts + 1,
                    started_at=func.coalesce(Job.started_at, now),
                    error=None,
                )
                .execution_options(synchronize_session=False)
            )
            if res.rowcount == 1:
                db.commit()
                job = db.get(Job, job_id)
                db.refresh(job)
                db.expunge(job)
                return job
    return None


def heartbeat(job_id: str, worker_id: str, *, progress: float | None = None,
              message: str | None = None, lease_seconds: int | None = None) -> tuple[bool, bool]:
    """Renew the lease. Returns ``(still_owner, cancel_requested)``."""
    lease = lease_seconds if lease_seconds is not None else get_settings().job_lease_seconds
    with session_scope() as db:
        now = utcnow()
        values: dict[str, Any] = {"heartbeat_at": now, "lease_until": now + timedelta(seconds=lease)}
        if progress is not None:
            values["progress"] = max(0.0, min(1.0, float(progress)))
        if message is not None:
            values["progress_message"] = message[:300]
        res = db.execute(
            update(Job)
            .where(Job.id == job_id, Job.lease_owner == worker_id, Job.status == "running")
            .values(**values)
            .execution_options(synchronize_session=False)
        )
        owner = res.rowcount == 1
        cancel = bool(db.scalar(select(Job.cancel_requested).where(Job.id == job_id)))
        return owner, cancel


def fence_lease(db: Session, job_id: str, worker_id: str, *, attempt: int, retry_count: int | None = None,
                lease_seconds: int | None = None) -> bool:
    """Renew the lease only if this attempt still owns the job; ``True`` when it does.

    A conditional UPDATE (owner, attempt, retry count, status ``running``) in the caller's
    transaction: it takes the row's write lock until that transaction ends, so a reclaim
    by another worker cannot interleave with the caller's domain commit.
    """
    lease = lease_seconds if lease_seconds is not None else get_settings().job_lease_seconds
    now = utcnow()
    conds = [Job.id == job_id, Job.lease_owner == worker_id, Job.status == "running", Job.attempts == attempt]
    if retry_count is not None:
        conds.append(Job.retry_count == retry_count)
    res = db.execute(
        update(Job).where(*conds)
        .values(heartbeat_at=now, lease_until=now + timedelta(seconds=lease))
        .execution_options(synchronize_session=False)
    )
    return res.rowcount == 1


def finish(job_id: str, worker_id: str, *, status: str, result: dict | None = None,
           error: str | None = None) -> bool:
    """Terminal transition, only if this worker still holds the lease."""
    assert status in TERMINAL
    with session_scope() as db:
        now = utcnow()
        values: dict[str, Any] = {
            "status": status,
            "finished_at": now,
            "lease_owner": None,
            "lease_until": None,
            "error": error[:4000] if error else None,
        }
        if status == "succeeded":
            values["progress"] = 1.0
            values["result_json"] = result or {}
        res = db.execute(
            update(Job)
            .where(Job.id == job_id, Job.lease_owner == worker_id, Job.status == "running")
            .values(**values)
            .execution_options(synchronize_session=False)
        )
        if res.rowcount == 1 and status != "succeeded":
            job = db.get(Job, job_id)
            if job is not None:
                run_settle_hooks(db, job, status, values["error"])
        return res.rowcount == 1


def requeue_with_backoff(job_id: str, worker_id: str, *, error: str) -> str:
    """After a retryable failure: re-queue with exponential backoff, or fail when attempts are exhausted."""
    settings = get_settings()
    with session_scope() as db:
        job = db.get(Job, job_id)
        if job is None or job.lease_owner != worker_id or job.status != "running":
            return "lease_lost"
        now = utcnow()
        if job.attempts >= job.max_attempts:
            status = "failed"
            values = {"status": "failed", "finished_at": now,
                      "error": f"{error[:3500]} (attempt {job.attempts}/{job.max_attempts}; no attempts left)"}
        else:
            delay = min(settings.job_backoff_max_seconds,
                        settings.job_backoff_base_seconds * (2 ** max(0, job.attempts - 1)))
            status = "queued"
            values = {"status": "queued", "not_before": now + timedelta(seconds=delay),
                      "error": f"{error[:3500]} (attempt {job.attempts}/{job.max_attempts}; retrying in {delay:.0f}s)"}
        values.update({"lease_owner": None, "lease_until": None})
        res = db.execute(
            update(Job).where(Job.id == job_id, Job.lease_owner == worker_id)
            .values(**values).execution_options(synchronize_session=False)
        )
        if status == "failed" and res.rowcount == 1:
            db.refresh(job)
            run_settle_hooks(db, job, "failed", values["error"])
        return status


def request_cancel(db: Session, job: Job) -> str:
    """Cancel a queued job now, or ask a running job to stop. Returns the new status."""
    if job.status == "queued":
        job.status = "canceled"
        job.finished_at = utcnow()
        job.cancel_requested = True
        run_settle_hooks(db, job, "canceled", "canceled before start")
        return "canceled"
    if job.status == "running":
        job.cancel_requested = True
        return "cancel_requested"
    raise ValueError(f"job is already {job.status}")


def retry(db: Session, job: Job) -> None:
    if job.status not in ("failed", "canceled"):
        raise ValueError(f"only failed or canceled jobs can be retried (job is {job.status})")
    job.status = "queued"
    job.attempts = 0
    job.retry_count = (job.retry_count or 0) + 1
    job.cancel_requested = False
    job.error = None
    job.result_json = None
    job.progress = 0.0
    job.progress_message = None
    job.finished_at = None
    job.lease_owner = None
    job.lease_until = None
    job.not_before = utcnow()


def serialize(job: Job) -> dict[str, Any]:
    return {
        "id": job.id,
        "project_id": job.project_id,
        "type": job.type,
        "status": job.status,
        "payload": job.payload_json,
        "idempotency_key": job.idempotency_key,
        "attempts": job.attempts,
        "max_attempts": job.max_attempts,
        "retry_count": job.retry_count,
        "progress": job.progress,
        "progress_message": job.progress_message,
        "result": job.result_json,
        "error": job.error,
        "cancel_requested": job.cancel_requested,
        "lease_owner": job.lease_owner,
        "lease_until": job.lease_until.isoformat() if job.lease_until else None,
        "heartbeat_at": job.heartbeat_at.isoformat() if job.heartbeat_at else None,
        "not_before": job.not_before.isoformat() if job.not_before else None,
        "created_by": job.created_by,
        "created_at": job.created_at.isoformat() if job.created_at else None,
        "started_at": job.started_at.isoformat() if job.started_at else None,
        "finished_at": job.finished_at.isoformat() if job.finished_at else None,
    }
