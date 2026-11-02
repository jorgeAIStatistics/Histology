"""Worker loop: claim → run handler (with a heartbeat thread) → finish.

Run as a process with ``python -m dermpath.worker``. Tests and the seed use
:meth:`Worker.run_until_idle` in-process; it executes exactly the same code path.
"""

from __future__ import annotations

import logging
import os
import socket
import threading
import time
import traceback
import uuid
from dataclasses import dataclass

from sqlalchemy import select

from ..config import get_settings
from ..db import session_scope, utcnow
from ..models import WorkerHeartbeat
from . import queue
from .registry import HANDLERS, JobCanceled, JobContext, LeaseLost, PermanentJobError, get_handler, load_handlers

log = logging.getLogger("dermpath.worker")


@dataclass
class Outcome:
    job_id: str
    type: str
    status: str  # succeeded | failed | canceled | queued (retry) | lease_lost
    error: str | None = None


def _short_error(exc: BaseException) -> str:
    tb = traceback.extract_tb(exc.__traceback__)
    where = f" at {tb[-1].name}:{tb[-1].lineno}" if tb else ""
    return f"{type(exc).__name__}: {exc}{where}"


class Worker:
    def __init__(self, worker_id: str | None = None, *, lease_seconds: int | None = None,
                 types: list[str] | None = None, record_heartbeat: bool = True) -> None:
        self.worker_id = worker_id or f"worker-{socket.gethostname()}-{os.getpid()}-{uuid.uuid4().hex[:6]}"
        self.lease_seconds = lease_seconds or get_settings().job_lease_seconds
        self.types = types
        self.processed = 0
        self._last_beat = 0.0
        # In-process runs (seed) must not make /health claim that a worker process is alive.
        self.record_heartbeat = record_heartbeat
        load_handlers()

    # ---------------------------------------------------------------- heartbeat row
    def beat(self, current_job_id: str | None = None, force: bool = False) -> None:
        if not self.record_heartbeat:
            return
        now_mono = time.monotonic()
        if not force and now_mono - self._last_beat < 2.0:
            return
        self._last_beat = now_mono
        try:
            with session_scope() as db:
                row = db.get(WorkerHeartbeat, self.worker_id)
                if row is None:
                    row = WorkerHeartbeat(worker_id=self.worker_id, pid=os.getpid(),
                                          hostname=socket.gethostname())
                    db.add(row)
                row.last_seen_at = utcnow()
                row.current_job_id = current_job_id
                row.jobs_processed = self.processed
                row.handler_types_json = sorted(HANDLERS)
        except Exception:  # pragma: no cover - heartbeat must never kill the worker
            log.exception("worker heartbeat failed")

    # ---------------------------------------------------------------- one job
    def run_once(self) -> Outcome | None:
        self.beat()
        job = queue.claim_next(self.worker_id, lease_seconds=self.lease_seconds, types=self.types)
        if job is None:
            return None
        self.beat(job.id, force=True)
        outcome = self._execute(job)
        self.processed += 1
        self.beat(None, force=True)
        return outcome

    def _execute(self, job) -> Outcome:
        spec = get_handler(job.type)
        if spec is None:
            msg = f"no handler registered for job type {job.type!r} (is its module installed?)"
            queue.finish(job.id, self.worker_id, status="failed", error=msg)
            return Outcome(job.id, job.type, "failed", msg)

        if job.cancel_requested:
            queue.finish(job.id, self.worker_id, status="canceled", error="canceled before start")
            return Outcome(job.id, job.type, "canceled")

        state = {"lost": False, "cancel": False}
        stop = threading.Event()

        def hb_loop():
            interval = max(0.5, self.lease_seconds / 3.0)
            while not stop.wait(interval):
                owner, cancel = queue.heartbeat(job.id, self.worker_id, lease_seconds=self.lease_seconds)
                state["lost"] = state["lost"] or not owner
                state["cancel"] = state["cancel"] or cancel

        def progress_cb(fraction, message) -> bool:
            owner, cancel = queue.heartbeat(job.id, self.worker_id, progress=fraction, message=message,
                                            lease_seconds=self.lease_seconds)
            if not owner:
                state["lost"] = True
                raise LeaseLost("lease lost (another worker reclaimed this job)")
            state["cancel"] = state["cancel"] or cancel
            return state["cancel"]

        ctx = JobContext(
            job_id=job.id, type=job.type, project_id=job.project_id, payload=dict(job.payload_json or {}),
            attempt=job.attempts, worker_id=self.worker_id, created_by=job.created_by,
            _progress_cb=progress_cb,
        )
        hb = threading.Thread(target=hb_loop, name=f"hb-{job.id[:8]}", daemon=True)
        hb.start()
        try:
            result = spec.func(ctx, ctx.payload) or {}
        except JobCanceled:
            stop.set()
            queue.finish(job.id, self.worker_id, status="canceled", error="canceled on request")
            return Outcome(job.id, job.type, "canceled")
        except LeaseLost as exc:
            stop.set()
            return Outcome(job.id, job.type, "lease_lost", str(exc))
        except PermanentJobError as exc:
            stop.set()
            msg = str(exc)
            queue.finish(job.id, self.worker_id, status="failed", error=msg)
            return Outcome(job.id, job.type, "failed", msg)
        except Exception as exc:
            stop.set()
            msg = _short_error(exc)
            log.warning("job %s (%s) failed: %s", job.id, job.type, msg)
            status = queue.requeue_with_backoff(job.id, self.worker_id, error=msg)
            return Outcome(job.id, job.type, status, msg)
        finally:
            stop.set()
            hb.join(timeout=5)
        if state["lost"]:
            return Outcome(job.id, job.type, "lease_lost", "lease lost; result discarded")
        if not queue.finish(job.id, self.worker_id, status="succeeded", result=result):
            return Outcome(job.id, job.type, "lease_lost", "lease lost; result discarded")
        return Outcome(job.id, job.type, "succeeded")

    # ---------------------------------------------------------------- loops
    def run_until_idle(self, max_jobs: int = 1000) -> list[Outcome]:
        out: list[Outcome] = []
        for _ in range(max_jobs):
            o = self.run_once()
            if o is None:
                break
            out.append(o)
        return out

    def run_forever(self, stop_event: threading.Event | None = None, poll_seconds: float | None = None) -> None:
        stop_event = stop_event or threading.Event()
        poll = poll_seconds if poll_seconds is not None else get_settings().worker_poll_seconds
        log.info("worker %s started; handlers: %s", self.worker_id, sorted(HANDLERS))
        self.beat(force=True)
        while not stop_event.is_set():
            try:
                outcome = self.run_once()
            except Exception:  # pragma: no cover - keep the loop alive (e.g. DB locked)
                log.exception("worker iteration failed")
                outcome = None
            if outcome is None:
                stop_event.wait(poll)
        log.info("worker %s stopping", self.worker_id)


def worker_health() -> dict:
    settings = get_settings()
    with session_scope() as db:
        rows = db.scalars(select(WorkerHeartbeat).order_by(WorkerHeartbeat.last_seen_at.desc())).all()
        now = utcnow()
        workers = []
        for r in rows[:10]:
            age = (now - r.last_seen_at).total_seconds()
            workers.append({
                "worker_id": r.worker_id,
                "last_seen_at": r.last_seen_at.isoformat(),
                "age_seconds": round(age, 1),
                "alive": age <= settings.worker_stale_seconds,
                "current_job_id": r.current_job_id,
                "jobs_processed": r.jobs_processed,
                "handler_types": r.handler_types_json,
            })
    alive = [w for w in workers if w["alive"]]
    if alive:
        status = "ok"
    elif workers:
        status = "stale"
    else:
        status = "never_seen"
    return {"status": status, "stale_after_seconds": settings.worker_stale_seconds, "workers": workers}
