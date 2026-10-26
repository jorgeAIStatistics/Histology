"""Job routes: list, get, cancel, retry."""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import audit
from ..auth import Actor, Scope, authorize, current_actor, entity_scope
from ..db import get_db
from ..errors import conflict
from ..jobs import queue
from ..models import Job
from ..schemas import JobOut

router = APIRouter(tags=["jobs"])


def _job_scope(permission: str):
    def resolver(db: Session, raw: str):
        job = db.get(Job, raw)
        return job if job is not None and job.project_id is not None else None

    return entity_scope(permission, resolver, entity_name="job")


@router.get("/jobs")
def list_jobs(project_id: str = Query(...), status: str | None = None, type: str | None = None,
              limit: int = Query(100, ge=1, le=500), actor: Actor = Depends(current_actor),
              db: Session = Depends(get_db)):
    authorize(db, actor, project_id, "jobs.read")
    q = select(Job).where(Job.project_id == project_id)
    if status:
        q = q.where(Job.status == status)
    if type:
        q = q.where(Job.type == type)
    rows = db.scalars(q.order_by(Job.created_at.desc()).limit(limit)).all()
    return {"items": [queue.serialize(j) for j in rows]}


@router.get("/jobs/{id}", response_model=JobOut)
def get_job(scope: Scope = Depends(_job_scope("jobs.read"))):
    return queue.serialize(scope.obj)


@router.post("/jobs/{id}/cancel", response_model=JobOut)
def cancel_job(scope: Scope = Depends(_job_scope("jobs.manage")), db: Session = Depends(get_db)):
    job = scope.obj
    try:
        outcome = queue.request_cancel(db, job)
    except ValueError as exc:
        raise conflict("job_finished", str(exc), status=job.status)
    audit.record_for(db, scope.actor, project_id=job.project_id, action="job.cancel_requested", entity_type="job",
                     entity_id=job.id, after={"outcome": outcome, "type": job.type})
    db.commit()
    return queue.serialize(job)


@router.post("/jobs/{id}/retry", response_model=JobOut)
def retry_job(scope: Scope = Depends(_job_scope("jobs.manage")), db: Session = Depends(get_db)):
    job = scope.obj
    try:
        queue.retry(db, job)
    except ValueError as exc:
        raise conflict("job_not_retryable", str(exc), status=job.status)
    audit.record_for(db, scope.actor, project_id=job.project_id, action="job.retried", entity_type="job",
                     entity_id=job.id, after={"retry_count": job.retry_count, "type": job.type})
    db.commit()
    return queue.serialize(job)

