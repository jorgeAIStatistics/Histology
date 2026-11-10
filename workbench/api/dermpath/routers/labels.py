"""Labels, independent assessments, suggestion review, review states, disagreements."""

from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import audit
from ..auth import Scope, entity_scope, project_scope
from ..db import get_db
from ..errors import conflict, forbidden, unprocessable
from ..labels import adjudicate, create_expert_label, disagreement_dict, label_dict, review_suggestion
from ..models import Disagreement, LabelVersion, NearDuplicateReview, Project, Slide
from ..review import assessment_dict, create_assessment, labels_view, set_review_state, suggestions_hidden_for
from ..schemas import (
    AdjudicateIn,
    AssessmentIn,
    LabelIn,
    NearDuplicateReviewIn,
    ReviewStateIn,
    SuggestionReviewIn,
)
from .common import slide_dict

router = APIRouter(tags=["labels"])


@router.get("/slides/{id}/labels")
def get_labels(scope: Scope = Depends(entity_scope("label.read", Slide)), db: Session = Depends(get_db)):
    """Expert labels and model suggestions, kept separate. Under independent review a
    pathologist sees no suggestions until they record an assessment."""
    project = db.get(Project, scope.project_id)
    return labels_view(db, scope.actor, project, scope.member, scope.obj)


@router.post("/slides/{id}/labels", status_code=201)
def post_label(body: LabelIn, scope: Scope = Depends(entity_scope("label.expert_write", Slide)),
               db: Session = Depends(get_db)):
    lv = create_expert_label(db, scope.actor, scope.obj, scope=body.scope, target_id=body.target_id,
                             value=body.value, reason=body.reason)
    db.commit()
    return label_dict(lv)


@router.post("/slides/{id}/assessment", status_code=201)
def post_assessment(body: AssessmentIn, scope: Scope = Depends(entity_scope("review.assess", Slide)),
                    db: Session = Depends(get_db)):
    project = db.get(Project, scope.project_id)
    a = create_assessment(db, scope.actor, project, scope.member, scope.obj, value=body.value,
                          confidence=body.confidence, comment=body.comment,
                          time_spent_seconds=body.time_spent_seconds, record_as_label=body.record_as_label)
    db.commit()
    return assessment_dict(a)


@router.post("/labels/{id}/review", status_code=201)
def review_label(body: SuggestionReviewIn, scope: Scope = Depends(entity_scope("review.suggestion", LabelVersion)),
                 db: Session = Depends(get_db)):
    """accept | correct | reject | hide a MODEL SUGGESTION. Creates a new expert version and
    preserves the original suggestion unchanged."""
    suggestion = scope.obj
    slide = db.get(Slide, suggestion.slide_id) if suggestion.slide_id else None
    if slide is None:
        raise unprocessable("unsupported_target", "Case-level suggestions are reviewed from a slide of the case")
    project = db.get(Project, scope.project_id)
    if suggestions_hidden_for(db, scope.actor, project, scope.member, slide.id):
        raise conflict("assessment_required",
                       "Independent review is on: record your assessment before reviewing suggestions")
    lv = review_suggestion(db, scope.actor, suggestion, slide, action=body.action, value=body.value,
                           reason=body.reason)
    db.commit()
    return {"review": label_dict(lv), "original_suggestion": label_dict(suggestion)}


@router.post("/slides/{id}/review-state")
def post_review_state(body: ReviewStateIn, scope: Scope = Depends(entity_scope("review.state.route", Slide)),
                      db: Session = Depends(get_db)):
    """imported → pending_review → approved | disputed | excluded (reasons required for
    exclusions and backward moves). Role checks per transition are in vocab.REVIEW_TRANSITIONS."""
    slide = set_review_state(db, scope.actor, scope.obj, body.state, reason=body.reason)
    db.commit()
    return slide_dict(db, slide)


@router.get("/projects/{pid}/disagreements")
def list_disagreements(status: str | None = None, scope: Scope = Depends(project_scope("disagreement.read")),
                       db: Session = Depends(get_db)):
    q = select(Disagreement).where(Disagreement.project_id == scope.project_id)
    if status:
        q = q.where(Disagreement.status == status)
    rows = db.scalars(q.order_by(Disagreement.created_at)).all()
    out = []
    for d in rows:
        dd = disagreement_dict(d)
        dd["labels"] = [label_dict(lv) for lv in
                        db.scalars(select(LabelVersion).where(LabelVersion.id.in_(d.label_version_ids_json))).all()]
        out.append(dd)
    return {"items": out}


@router.post("/disagreements/{id}/adjudicate", status_code=201)
def post_adjudicate(body: AdjudicateIn, scope: Scope = Depends(entity_scope("disagreement.adjudicate", Disagreement)),
                    db: Session = Depends(get_db)):
    lv = adjudicate(db, scope.actor, scope.obj, value=body.value, reason=body.reason)
    db.commit()
    return {"disagreement": disagreement_dict(scope.obj), "adjudication_label": label_dict(lv)}


@router.post("/projects/{pid}/near-duplicates/review", status_code=201)
def review_near_duplicate(body: NearDuplicateReviewIn,
                          scope: Scope = Depends(project_scope("near_duplicate.review")),
                          db: Session = Depends(get_db)):
    """Record a human decision on a near-duplicate CANDIDATE pair. Nothing is removed
    automatically; exclude a slide explicitly through its review state if needed."""
    a, b = db.get(Slide, body.slide_a_id), db.get(Slide, body.slide_b_id)
    if a is None or b is None or a.project_id != scope.project_id or b.project_id != scope.project_id:
        raise forbidden("not_in_project", "Both slides must belong to this project")
    if a.id == b.id:
        raise unprocessable("same_slide", "Choose two different slides")
    r = NearDuplicateReview(project_id=scope.project_id, slide_a_id=a.id, slide_b_id=b.id, decision=body.decision,
                            reason=body.reason, reviewer_id=scope.actor.id)
    db.add(r)
    db.flush()
    audit.record_for(db, scope.actor, project_id=scope.project_id, action="near_duplicate.reviewed",
                     entity_type="near_duplicate_review", entity_id=r.id,
                     after={"slide_a": a.id, "slide_b": b.id, "decision": body.decision}, reason=body.reason)
    db.commit()
    return {"id": r.id, "slide_a_id": a.id, "slide_b_id": b.id, "decision": r.decision, "reason": r.reason,
            "note": "Recorded for review; no slide was removed or excluded automatically."}
