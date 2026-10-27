"""Review workflow: independent initial review, review states and the slide label view.

Independent initial review
--------------------------
When ``independent_review`` is on (project setting ``settings_json.independent_review``,
overridable per reviewer on ``ProjectMember.independent_review``), a pathologist does
not see model suggestions for a slide (in ``GET /slides/{id}/labels``, ``GET
/slides/{id}`` and the worklist) until they ``POST /slides/{id}/assessment``. Reviewing
a hidden suggestion by id is refused with 409 ``assessment_required``.

Review states
-------------
``imported → pending_review → approved | disputed | excluded`` (see
:data:`dermpath.vocab.REVIEW_TRANSITIONS`). Exclusions and backward moves need a reason.
Every change is audited. Approval requires a successful ingest and no open
disagreement on the slide or its case.
"""

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from . import audit
from .auth import Actor
from .db import utcnow
from .errors import conflict, forbidden, unprocessable
from .labels import (
    case_of_slide,
    current_expert_opinions,
    label_dict,
    open_disagreement,
    reference_label,
)
from .models import (
    Disagreement,
    LabelVersion,
    Project,
    ProjectMember,
    ReviewAssessment,
    Slide,
)
from .vocab import LABEL_VALUES, REVIEW_REASON_REQUIRED, REVIEW_STATES, REVIEW_TRANSITIONS


def independent_review_on(project: Project, member: ProjectMember | None) -> bool:
    if member is not None and member.independent_review is not None:
        return bool(member.independent_review)
    return bool((project.settings_json or {}).get("independent_review", False))


def has_assessed(db: Session, slide_id: str, reviewer_id: str) -> bool:
    return db.scalars(select(ReviewAssessment.id).where(ReviewAssessment.slide_id == slide_id,
                                                        ReviewAssessment.reviewer_id == reviewer_id)).first() is not None


def suggestions_hidden_for(db: Session, actor: Actor, project: Project, member: ProjectMember | None,
                           slide_id: str) -> bool:
    if actor.role != "pathologist":
        return False
    return independent_review_on(project, member) and not has_assessed(db, slide_id, actor.id)


def assessment_dict(a: ReviewAssessment) -> dict:
    return {"id": a.id, "slide_id": a.slide_id, "reviewer_id": a.reviewer_id, "value": a.value,
            "confidence": a.confidence, "comment": a.comment, "time_spent_seconds": a.time_spent_seconds,
            "suggestions_were_hidden": a.suggestions_were_hidden, "label_version_id": a.label_version_id,
            "created_at": a.created_at.isoformat()}


def create_assessment(db: Session, actor: Actor, project: Project, member: ProjectMember, slide: Slide, *,
                      value: str, confidence: str | None, comment: str | None, time_spent_seconds: float | None,
                      record_as_label: bool) -> ReviewAssessment:
    from .labels import create_expert_label

    if actor.role != "pathologist":
        raise forbidden("role_forbidden", "Only pathologists record review assessments")
    if value not in LABEL_VALUES:
        raise unprocessable("invalid_label_value", f"value must be one of {list(LABEL_VALUES)}")
    if confidence not in (None, "low", "medium", "high"):
        raise unprocessable("invalid_confidence", "confidence must be low, medium or high")
    if has_assessed(db, slide.id, actor.id):
        raise conflict("already_assessed", "You already recorded an independent assessment for this slide; "
                       "assessments are immutable. Record or change a label instead.")
    hidden = suggestions_hidden_for(db, actor, project, member, slide.id)
    label_version_id = None
    if record_as_label:
        mine = current_expert_opinions(db, slide.project_id, "slide", slide.id).get(actor.id)
        if mine is not None and mine.value == value:
            label_version_id = mine.id
        else:
            lv = create_expert_label(db, actor, slide, scope="slide", target_id=None, value=value,
                                     reason="recorded from independent assessment")
            label_version_id = lv.id
    # Append-only: the label link is set at creation, never afterwards.
    a = ReviewAssessment(project_id=slide.project_id, slide_id=slide.id, reviewer_id=actor.id, value=value,
                         confidence=confidence, comment=comment, time_spent_seconds=time_spent_seconds,
                         suggestions_were_hidden=hidden, label_version_id=label_version_id)
    db.add(a)
    db.flush()
    audit.record_for(db, actor, project_id=slide.project_id, action="review.assessment_recorded",
                     entity_type="review_assessment", entity_id=a.id,
                     after={"slide_id": slide.id, "value": value, "suggestions_were_hidden": hidden,
                            "recorded_as_label": record_as_label})
    return a


def set_review_state(db: Session, actor: Actor | None, slide: Slide, to_state: str, *, reason: str | None,
                     system: bool = False) -> Slide:
    if to_state not in REVIEW_STATES:
        raise unprocessable("invalid_state", f"state must be one of {list(REVIEW_STATES)}")
    frm = slide.review_state
    if frm == to_state:
        raise conflict("state_unchanged", f"Slide is already {to_state}")
    if not system:
        roles = REVIEW_TRANSITIONS.get((frm, to_state))
        if roles is None:
            raise conflict("invalid_transition", f"Cannot move a slide from {frm} to {to_state}",
                           allowed=[t for (f, t) in REVIEW_TRANSITIONS if f == frm])
        if actor is None or actor.role not in roles:
            raise forbidden("role_forbidden", f"Role {getattr(actor, 'role', None)} cannot move {frm} → {to_state}",
                            allowed_roles=list(roles))
        if (frm, to_state) in REVIEW_REASON_REQUIRED and not (reason and reason.strip()):
            raise unprocessable("reason_required", f"Moving {frm} → {to_state} requires a reason")
        if to_state in ("pending_review", "approved") and slide.ingest_status != "succeeded":
            raise conflict("not_ingested", "Only successfully ingested slides can be routed or approved",
                           ingest_status=slide.ingest_status)
        if to_state == "approved":
            if open_disagreement(db, slide.project_id, "slide", slide.id):
                raise conflict("open_disagreement", "Adjudicate the open disagreement before approving")
            case = case_of_slide(db, slide)
            if case is not None and open_disagreement(db, slide.project_id, "case", case.id):
                raise conflict("open_disagreement", "The slide's case has an open disagreement; adjudicate it first")
    slide.review_state = to_state
    slide.review_state_reason = reason
    slide.review_state_by = actor.id if actor else "system"
    slide.review_state_at = utcnow()
    audit.record(db, action="slide.review_state_changed", entity_type="slide", entity_id=slide.id,
                 actor_id=actor.id if actor else "system", actor_role=actor.role if actor else "system",
                 project_id=slide.project_id, before={"review_state": frm},
                 after={"review_state": to_state, "system": system}, reason=reason)
    return slide


def labels_view(db: Session, actor: Actor, project: Project, member: ProjectMember, slide: Slide) -> dict:
    """Everything label-related for one slide, honouring independent review."""
    case = case_of_slide(db, slide)
    slide_rows = db.scalars(select(LabelVersion).where(LabelVersion.slide_id == slide.id)
                            .order_by(LabelVersion.created_at, LabelVersion.version)).all()
    case_rows = []
    if case is not None:
        case_rows = db.scalars(select(LabelVersion).where(LabelVersion.scope == "case", LabelVersion.case_id == case.id)
                               .order_by(LabelVersion.created_at)).all()
    hidden = suggestions_hidden_for(db, actor, project, member, slide.id)
    rows = list(slide_rows) + [r for r in case_rows if r not in slide_rows]
    expert = [label_dict(r) for r in rows if r.source == "expert"]
    suggestions = [] if hidden else [label_dict(r) for r in rows if r.source == "model_suggestion"]
    # Imported reference labels (an external dataset's own standard, e.g. report-derived) are not expert reads. Like
    # model suggestions they are hidden until the reader has recorded an independent assessment, so they never
    # anchor a blinded read.
    imported = [] if hidden else [label_dict(r) for r in rows if r.source == "imported_reference"]
    if hidden:
        # Do not leak suggestion content through expert review rows either.
        expert = [e for e in expert if not (e["review_of_suggestion_id"] and e["author_id"] != actor.id)]
    ref_slide, ref_slide_status = reference_label(db, slide.project_id, "slide", slide.id)
    ref_case, ref_case_status = (reference_label(db, slide.project_id, "case", case.id) if case else (None, "no_case"))
    ref_imported, ref_imported_status = (None, "hidden") if hidden else reference_label(
        db, slide.project_id, "slide", slide.id, reference_standard="imported_reference")
    my = db.scalars(select(ReviewAssessment).where(ReviewAssessment.slide_id == slide.id,
                                                   ReviewAssessment.reviewer_id == actor.id)).first()
    disagreements = db.scalars(select(Disagreement).where(
        Disagreement.project_id == slide.project_id,
        ((Disagreement.scope == "slide") & (Disagreement.target_id == slide.id))
        | ((Disagreement.scope == "case") & (Disagreement.target_id == (case.id if case else "-")))
    )).all()
    from .labels import disagreement_dict

    return {
        "slide_id": slide.id,
        "review_state": slide.review_state,
        "independent_review": independent_review_on(project, member),
        "suggestions_hidden": hidden,
        "hidden_reason": ("independent review: record your assessment (POST /slides/{id}/assessment) to reveal "
                          "model suggestions") if hidden else None,
        "my_assessment": assessment_dict(my) if my else None,
        "expert_labels": expert,
        "model_suggestions": suggestions,
        "imported_reference_labels": imported,
        "reference": {
            "slide": {"status": ref_slide_status, "label": label_dict(ref_slide) if ref_slide else None},
            "slide_imported": {"status": ref_imported_status,
                               "label": label_dict(ref_imported) if ref_imported else None,
                               "note": "Imported reference (external dataset standard), not an expert read; it counts "
                                       "only in datasets whose reference_standard is imported_reference."},
            "case": {"status": ref_case_status, "label": label_dict(ref_case) if ref_case else None,
                     "case_id": case.id if case else None,
                     "note": "A case-level label is valid for the case only; it is never copied to slides."},
        },
        "readers": {
            "slide": sorted(current_expert_opinions(db, slide.project_id, "slide", slide.id)),
        },
        "disagreements": [disagreement_dict(d) for d in disagreements],
        "notice": "Model suggestions are not expert truth. 'BCC absent' is NOT the same as benign.",
    }
