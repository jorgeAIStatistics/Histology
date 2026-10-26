"""Quality review routes (lifecycle documented in dermpath.qc.service)."""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query, Request, Response
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .. import audit
from ..annotations import normalise_geometry
from ..auth import Scope, entity_scope, project_scope
from ..db import get_db
from ..errors import conflict, not_found
from ..jobs.queue import enqueue
from ..models import Job, QCIssue, QCIssueEvent, QCReview, Slide
from ..qc.service import (
    EXPERIMENTAL_LABEL,
    create_manual_issue,
    issue_dict,
    override_screen,
    review_dict,
    slide_qc_summary,
    transition_issue,
)
from ..schemas import QCIssueIn, QCIssuePatchIn, QCOverrideIn
from ..storage import get_store
from .slides import slide_for_token

router = APIRouter(tags=["qc"])


def _events(db: Session, issue_ids: list[str]) -> dict[str, list[QCIssueEvent]]:
    out: dict[str, list[QCIssueEvent]] = {i: [] for i in issue_ids}
    if not issue_ids:
        return out
    for e in db.scalars(select(QCIssueEvent).where(QCIssueEvent.issue_id.in_(issue_ids))
                        .order_by(QCIssueEvent.at)).all():
        out[e.issue_id].append(e)
    return out


@router.get("/slides/{id}/qc")
def get_qc(scope: Scope = Depends(entity_scope("qc.read", Slide)), db: Session = Depends(get_db)):
    slide = scope.obj
    reviews = db.scalars(select(QCReview).where(QCReview.slide_id == slide.id).order_by(QCReview.created_at.desc())).all()
    issues = db.scalars(select(QCIssue).where(QCIssue.slide_id == slide.id).order_by(QCIssue.created_at)).all()
    ev = _events(db, [i.id for i in issues])
    return {
        "slide_id": slide.id,
        "summary": slide_qc_summary(db, slide.id),
        "reviews": [review_dict(r) for r in reviews],
        "issues": [issue_dict(i, ev[i.id]) for i in issues],
        "experimental_notice": EXPERIMENTAL_LABEL,
        "policy": "A flag never orders a recut, rescan or discard; suggested actions are for a human decision.",
    }


@router.post("/slides/{id}/qc/screen", status_code=202)
def queue_screen(scope: Scope = Depends(entity_scope("qc.screen", Slide)), db: Session = Depends(get_db)):
    slide = scope.obj
    if slide.ingest_status != "succeeded":
        raise conflict("slide_not_ready", "Only ingested slides can be screened", ingest_status=slide.ingest_status)
    n = db.scalar(select(func.count(Job.id)).where(Job.type == "qc_screen",
                                                  Job.idempotency_key.like(f"qc_screen:{slide.id}:%")))
    active = db.scalars(select(Job).where(Job.type == "qc_screen", Job.status.in_(("queued", "running")),
                                          Job.idempotency_key.like(f"qc_screen:{slide.id}:%"))).first()
    if active is not None:
        return {"job_id": active.id, "status": active.status, "deduplicated": True}
    job, _ = enqueue(db, "qc_screen", {"slide_id": slide.id}, idempotency_key=f"qc_screen:{slide.id}:manual-{n}",
                     project_id=slide.project_id, created_by=scope.actor.id)
    audit.record_for(db, scope.actor, project_id=slide.project_id, action="qc.screen_requested", entity_type="slide",
                     entity_id=slide.id, after={"job_id": job.id})
    db.commit()
    return {"job_id": job.id, "status": job.status, "deduplicated": False}


@router.post("/slides/{id}/qc/issues", status_code=201)
def create_issue(body: QCIssueIn, scope: Scope = Depends(entity_scope("qc.write", Slide)),
                 db: Session = Depends(get_db)):
    slide = scope.obj
    region = None
    if body.region is not None:
        gtype, geo = normalise_geometry(body.region, slide)
        region = {**geo, "geometry_type": gtype, "coordinate_space": "level0_pixels"}
    issue = create_manual_issue(db, scope.actor, slide, category=body.category, region=region, note=body.note,
                                override_of=body.override_of, reason=body.reason)
    db.commit()
    return issue_dict(issue, _events(db, [issue.id])[issue.id])


@router.patch("/qc/issues/{id}")
def patch_issue(body: QCIssuePatchIn, scope: Scope = Depends(entity_scope("qc.write", QCIssue)),
                db: Session = Depends(get_db)):
    issue = transition_issue(db, scope.actor, scope.obj, action=body.action, reason=body.reason,
                             confirmed=body.confirmed, suggested_action=body.suggested_action,
                             resolution=body.resolution, dataset_eligibility_effect=body.dataset_eligibility_effect)
    db.commit()
    return issue_dict(issue, _events(db, [issue.id])[issue.id])


@router.post("/slides/{id}/qc/override", status_code=201)
def override(body: QCOverrideIn, scope: Scope = Depends(entity_scope("qc.write", Slide)),
             db: Session = Depends(get_db)):
    """Override an automated screening metric with a human verdict and a reason."""
    r = override_screen(db, scope.actor, scope.obj, review_id=body.review_id, metric=body.metric,
                        verdict=body.verdict, reason=body.reason)
    db.commit()
    return review_dict(r)


@router.get("/slides/{id}/qc/mask")
def qc_mask(id: str, request: Request, token: str = Query(...), review_id: str | None = None,
            db: Session = Depends(get_db)):
    """Tissue mask PNG of the latest (or a given) automated screen. Token-checked like tiles."""
    slide = slide_for_token(token, request, db, expected_slide_id=id)
    q = select(QCReview).where(QCReview.slide_id == slide.id, QCReview.kind == "automated_screen")
    if review_id:
        q = q.where(QCReview.id == review_id)
    r = db.scalars(q.order_by(QCReview.created_at.desc())).first()
    if r is None or not r.mask_object_key:
        raise not_found("qc_mask", id)
    return Response(get_store().get_bytes(r.mask_object_key), media_type="image/png",
                    headers={"Cache-Control": "private, max-age=300"})


@router.get("/projects/{pid}/qc/issues")
def project_issues(status: str | None = None, category: str | None = None,
                   scope: Scope = Depends(project_scope("qc.read")), db: Session = Depends(get_db)):
    q = select(QCIssue).where(QCIssue.project_id == scope.project_id)
    if status:
        q = q.where(QCIssue.status == status)
    if category:
        q = q.where(QCIssue.category == category)
    issues = db.scalars(q.order_by(QCIssue.created_at)).all()
    ev = _events(db, [i.id for i in issues])
    return {"items": [issue_dict(i, ev[i.id]) for i in issues]}
