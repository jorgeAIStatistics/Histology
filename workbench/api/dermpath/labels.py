"""Expert labels, model suggestions and disagreement handling.

Rules
-----
* ``LabelVersion`` rows are append-only. A change is a new version in the same lineage
  (``label_id``) with a reason; nothing is overwritten.
* Expert labels come only from the ``pathologist`` role (enforced by the router
  permission ``label.expert_write`` and re-checked here).
* Model suggestions (``source=model_suggestion``) are separate rows. Reviewing one
  (accept / correct / reject / hide) creates a NEW expert row pointing at the suggestion
  (``review_of_suggestion_id``); the suggestion itself is never modified.
* Scope is explicit: ``case``, ``slide`` or ``region``. A case-level label is valid for the
  case only and is NEVER copied down to its slides.
* ``bcc_absent_not_benign`` means BCC absent; it is NOT the same as benign.
* Disagreement: two experts with different current values at the same scope and target
  open a :class:`Disagreement`; a slide-scope disagreement moves the slide to
  ``disputed``. Adjudication records a separate expert label marked ``is_adjudication``.
"""

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from . import audit
from .auth import Actor
from .db import utcnow
from .errors import conflict, forbidden, unprocessable
from .models import (
    AnnotationVersion,
    Block,
    Case,
    Disagreement,
    LabelVersion,
    Slide,
    SpecimenPart,
    new_id,
)
from .vocab import (
    LABEL_DISPLAY,
    LABEL_SCOPES,
    LABEL_VALUES,
    REVIEW_ACTION_RECORDED,
    REVIEW_ACTIONS,
    SUGGESTION_ORIGIN_DISPLAY,
    SUGGESTION_ORIGINS,
)


def label_dict(lv: LabelVersion) -> dict:
    return {
        "id": lv.id,
        "label_id": lv.label_id,
        "version": lv.version,
        "scope": lv.scope,
        "target_id": lv.target_id,
        "slide_id": lv.slide_id,
        "case_id": lv.case_id,
        "annotation_id": lv.annotation_id,
        "value": lv.value,
        "display": LABEL_DISPLAY.get(lv.value) if lv.value else None,
        "source": lv.source,
        "suggestion_origin": lv.suggestion_origin,
        "suggestion_notice": SUGGESTION_ORIGIN_DISPLAY.get(lv.suggestion_origin) if lv.suggestion_origin else None,
        "model_ref": lv.model_ref,
        "score": lv.score,
        "author_id": lv.author_id,
        "created_at": lv.created_at.isoformat(),
        "reason": lv.reason,
        "review_action": lv.review_action,
        "review_of_suggestion_id": lv.review_of_suggestion_id,
        "supersedes": lv.supersedes,
        "is_adjudication": lv.is_adjudication,
        "disagreement_id": lv.disagreement_id,
    }


def case_of_slide(db: Session, slide: Slide) -> Case | None:
    if slide.block_id is None:
        return None
    block = db.get(Block, slide.block_id)
    part = db.get(SpecimenPart, block.part_id)
    return db.get(Case, part.case_id)


def resolve_target(db: Session, slide: Slide, scope: str, target_id: str | None) -> dict:
    """Map (slide, scope, target) to stored target columns; validates the target."""
    if scope not in LABEL_SCOPES:
        raise unprocessable("invalid_scope", f"scope must be one of {list(LABEL_SCOPES)}")
    if scope == "slide":
        if target_id not in (None, slide.id):
            raise unprocessable("invalid_target", "For scope=slide the target is the slide itself")
        return {"target_id": slide.id, "slide_id": slide.id, "case_id": None, "annotation_id": None}
    if scope == "case":
        case = case_of_slide(db, slide)
        if case is None:
            raise unprocessable("no_case", "This slide is not assigned to a case; assign the hierarchy first")
        if target_id not in (None, case.id):
            raise unprocessable("invalid_target", "For scope=case the target must be this slide's case")
        return {"target_id": case.id, "slide_id": None, "case_id": case.id, "annotation_id": None}
    # region
    if not target_id:
        raise unprocessable("target_required", "scope=region needs target_id = an annotation id on this slide")
    ann = db.scalars(select(AnnotationVersion).where(AnnotationVersion.annotation_id == target_id)
                     .order_by(AnnotationVersion.version.desc())).first()
    if ann is None or ann.slide_id != slide.id or ann.deleted:
        raise unprocessable("invalid_target", "target_id must be a current annotation on this slide")
    return {"target_id": target_id, "slide_id": slide.id, "case_id": None, "annotation_id": target_id}


def _check_value(value: str | None) -> str:
    if value not in LABEL_VALUES:
        raise unprocessable("invalid_label_value", f"value must be one of {list(LABEL_VALUES)}",
                            allowed=list(LABEL_VALUES))
    return value


def current_expert_opinions(db: Session, project_id: str, scope: str, target_id: str) -> dict[str, LabelVersion]:
    """Latest valued, non-adjudication expert label per author at (scope, target)."""
    rows = db.scalars(select(LabelVersion).where(
        LabelVersion.project_id == project_id, LabelVersion.scope == scope, LabelVersion.target_id == target_id,
        LabelVersion.source == "expert", LabelVersion.is_adjudication.is_(False))
        .order_by(LabelVersion.created_at, LabelVersion.version)).all()
    latest_by_author: dict[str, LabelVersion] = {}
    for r in rows:
        if r.author_id is None:
            continue
        if r.value is None:  # reject/hide judgements are not opinions about the target
            continue
        latest_by_author[r.author_id] = r
    return latest_by_author


def reference_label(db: Session, project_id: str, scope: str, target_id: str) -> tuple[LabelVersion | None, str]:
    """The label a dataset would use: adjudicated > unanimous expert opinion. Never a suggestion."""
    adj = db.scalars(select(LabelVersion).where(
        LabelVersion.project_id == project_id, LabelVersion.scope == scope, LabelVersion.target_id == target_id,
        LabelVersion.is_adjudication.is_(True)).order_by(LabelVersion.created_at.desc())).first()
    if adj is not None:
        return adj, "adjudicated"
    opinions = current_expert_opinions(db, project_id, scope, target_id)
    if not opinions:
        return None, "unlabeled"
    values = {o.value for o in opinions.values()}
    if len(values) > 1:
        return None, "disputed"
    newest = max(opinions.values(), key=lambda o: (o.created_at, o.version))
    return newest, ("agreed" if len(opinions) > 1 else "single_reader")


def _next_in_lineage(db: Session, label_id: str) -> int:
    v = db.scalars(select(LabelVersion.version).where(LabelVersion.label_id == label_id)
                   .order_by(LabelVersion.version.desc())).first()
    return (v or 0) + 1


def create_expert_label(db: Session, actor: Actor, slide: Slide, *, scope: str, target_id: str | None,
                        value: str, reason: str | None) -> LabelVersion:
    if actor.role != "pathologist":
        raise forbidden("role_forbidden", "Only pathologists record expert labels")
    _check_value(value)
    tgt = resolve_target(db, slide, scope, target_id)
    prev = db.scalars(select(LabelVersion).where(
        LabelVersion.project_id == slide.project_id, LabelVersion.scope == scope,
        LabelVersion.target_id == tgt["target_id"], LabelVersion.source == "expert",
        LabelVersion.author_id == actor.id, LabelVersion.review_of_suggestion_id.is_(None),
        LabelVersion.is_adjudication.is_(False)).order_by(LabelVersion.created_at.desc(),
                                                         LabelVersion.version.desc())).first()
    if prev is not None:
        if not reason or not reason.strip():
            raise unprocessable("reason_required", "Changing your label requires a reason (a new version is created)")
        if prev.value == value:
            raise conflict("label_unchanged", "Your current label already has this value", label_version_id=prev.id)
        label_id, version, supersedes = prev.label_id, _next_in_lineage(db, prev.label_id), prev.id
    else:
        label_id, version, supersedes = new_id(), 1, None
    lv = LabelVersion(label_id=label_id, version=version, project_id=slide.project_id, scope=scope,
                      value=value, source="expert", author_id=actor.id, reason=reason, supersedes=supersedes,
                      **tgt)
    db.add(lv)
    db.flush()
    audit.record_for(db, actor, project_id=slide.project_id, action="label.expert_recorded", entity_type="label",
                     entity_id=lv.id, before={"value": prev.value, "label_version_id": prev.id} if prev else None,
                     after={"value": value, "scope": scope, "target_id": tgt["target_id"], "version": version},
                     reason=reason)
    detect_disagreement(db, actor, slide.project_id, scope, tgt["target_id"], slide_id=tgt["slide_id"],
                        case_id=tgt["case_id"])
    return lv


def create_model_suggestion(db: Session, *, project_id: str, slide: Slide, scope: str, target_id: str | None,
                            value: str, score: float | None, model_ref: str, origin: str,
                            actor_id: str = audit.SYSTEM_WORKER) -> LabelVersion:
    """Store a suggestion (for the ML pass and the demo seed). Never an expert label."""
    _check_value(value)
    if origin not in SUGGESTION_ORIGINS:
        raise ValueError(f"origin must be one of {SUGGESTION_ORIGINS}")
    tgt = resolve_target(db, slide, scope, target_id)
    lv = LabelVersion(label_id=new_id(), version=1, project_id=project_id, scope=scope, value=value,
                      source="model_suggestion", suggestion_origin=origin, model_ref=model_ref[:120],
                      score=score, author_id=None, **tgt)
    db.add(lv)
    db.flush()
    audit.record(db, action="label.suggestion_created", entity_type="label", entity_id=lv.id, actor_id=actor_id,
                 actor_role="system", project_id=project_id,
                 after={"value": value, "scope": scope, "target_id": tgt["target_id"], "origin": origin,
                        "model_ref": model_ref})
    return lv


def review_suggestion(db: Session, actor: Actor, suggestion: LabelVersion, slide: Slide, *, action: str,
                      value: str | None, reason: str | None) -> LabelVersion:
    if actor.role != "pathologist":
        raise forbidden("role_forbidden", "Only pathologists review suggestions")
    if suggestion.source != "model_suggestion":
        raise unprocessable("not_a_suggestion", "Only model suggestions can be reviewed this way")
    if action not in REVIEW_ACTIONS:
        raise unprocessable("invalid_action", f"action must be one of {list(REVIEW_ACTIONS)}")
    if action == "accept":
        new_value = suggestion.value
    elif action == "correct":
        new_value = _check_value(value)
        if new_value == suggestion.value:
            raise unprocessable("not_a_correction", "A correction must differ from the suggestion; use accept")
        if not reason:
            raise unprocessable("reason_required", "A correction requires a reason")
    else:  # reject / hide: a judgement on the suggestion, not a label for the target
        if value is not None:
            raise unprocessable("value_not_allowed", f"{action} records no label value; use correct to give one")
        if action == "reject" and not reason:
            raise unprocessable("reason_required", "A rejection requires a reason")
        new_value = None
    prev = db.scalars(select(LabelVersion).where(LabelVersion.review_of_suggestion_id == suggestion.id,
                                                 LabelVersion.author_id == actor.id)
                      .order_by(LabelVersion.version.desc())).first()
    if prev is not None and not reason:
        raise unprocessable("reason_required", "Changing your review of this suggestion requires a reason")
    label_id = prev.label_id if prev else new_id()
    lv = LabelVersion(
        label_id=label_id, version=_next_in_lineage(db, label_id) if prev else 1, project_id=suggestion.project_id,
        scope=suggestion.scope, target_id=suggestion.target_id, slide_id=suggestion.slide_id,
        case_id=suggestion.case_id, annotation_id=suggestion.annotation_id, value=new_value, source="expert",
        author_id=actor.id, reason=reason, review_action=REVIEW_ACTION_RECORDED[action],
        review_of_suggestion_id=suggestion.id, supersedes=prev.id if prev else None,
    )
    db.add(lv)
    db.flush()
    audit.record_for(db, actor, project_id=suggestion.project_id, action=f"label.suggestion_{REVIEW_ACTION_RECORDED[action]}",
                     entity_type="label", entity_id=lv.id,
                     before={"suggestion_id": suggestion.id, "suggested_value": suggestion.value},
                     after={"value": new_value, "review_action": REVIEW_ACTION_RECORDED[action]}, reason=reason)
    if new_value is not None:
        detect_disagreement(db, actor, suggestion.project_id, suggestion.scope, suggestion.target_id,
                            slide_id=suggestion.slide_id, case_id=suggestion.case_id)
    return lv


def disagreement_dict(d: Disagreement) -> dict:
    return {
        "id": d.id, "project_id": d.project_id, "scope": d.scope, "target_id": d.target_id,
        "slide_id": d.slide_id, "case_id": d.case_id, "label_version_ids": d.label_version_ids_json,
        "values": d.values_json, "status": d.status, "adjudication_label_version_id": d.adjudication_label_version_id,
        "adjudicated_by": d.adjudicated_by, "adjudicated_at": d.adjudicated_at.isoformat() if d.adjudicated_at else None,
        "reason": d.reason, "created_at": d.created_at.isoformat(),
    }


def open_disagreement(db: Session, project_id: str, scope: str, target_id: str) -> Disagreement | None:
    return db.scalars(select(Disagreement).where(Disagreement.project_id == project_id, Disagreement.scope == scope,
                                                 Disagreement.target_id == target_id,
                                                 Disagreement.status == "open")).first()


def detect_disagreement(db: Session, actor: Actor | None, project_id: str, scope: str, target_id: str, *,
                        slide_id: str | None, case_id: str | None) -> Disagreement | None:
    from .review import set_review_state  # cycle-safe local import

    opinions = current_expert_opinions(db, project_id, scope, target_id)
    values = sorted({o.value for o in opinions.values()})
    existing = open_disagreement(db, project_id, scope, target_id)
    adjudicated = db.scalars(select(LabelVersion).where(
        LabelVersion.project_id == project_id, LabelVersion.scope == scope, LabelVersion.target_id == target_id,
        LabelVersion.is_adjudication.is_(True))).first()
    if len(values) > 1 and adjudicated is None:
        ids = sorted(o.id for o in opinions.values())
        if existing is None:
            existing = Disagreement(project_id=project_id, scope=scope, target_id=target_id, slide_id=slide_id,
                                    case_id=case_id, label_version_ids_json=ids, values_json=values, status="open")
            db.add(existing)
            db.flush()
            audit.record(db, action="disagreement.detected", entity_type="disagreement", entity_id=existing.id,
                         actor_id=getattr(actor, "id", None), actor_role=getattr(actor, "role", None),
                         project_id=project_id, after={"scope": scope, "target_id": target_id, "values": values})
        else:
            existing.label_version_ids_json = ids
            existing.values_json = values
        if scope == "slide" and slide_id:
            slide = db.get(Slide, slide_id)
            if slide is not None and slide.review_state in ("imported", "pending_review", "approved"):
                set_review_state(db, None, slide, "disputed", reason="expert labels disagree", system=True)
        return existing
    if existing is not None and len(values) <= 1:
        existing.status = "resolved_by_agreement"
        existing.reason = "readers' current labels now agree"
        audit.record(db, action="disagreement.resolved_by_agreement", entity_type="disagreement", entity_id=existing.id,
                     actor_id=getattr(actor, "id", None), actor_role=getattr(actor, "role", None),
                     project_id=project_id, after={"values": values})
    return None


def adjudicate(db: Session, actor: Actor, d: Disagreement, *, value: str, reason: str) -> LabelVersion:
    from .review import set_review_state

    if actor.role != "pathologist":
        raise forbidden("role_forbidden", "Only pathologists adjudicate")
    if d.status != "open":
        raise conflict("disagreement_not_open", f"Disagreement is {d.status}")
    _check_value(value)
    if not reason or not reason.strip():
        raise unprocessable("reason_required", "Adjudication requires a reason")
    parties = {db.get(LabelVersion, i).author_id for i in d.label_version_ids_json if db.get(LabelVersion, i)}
    lv = LabelVersion(label_id=new_id(), version=1, project_id=d.project_id, scope=d.scope, target_id=d.target_id,
                      slide_id=d.slide_id, case_id=d.case_id, value=value, source="expert", author_id=actor.id,
                      reason=reason, is_adjudication=True, disagreement_id=d.id)
    db.add(lv)
    db.flush()
    d.status = "adjudicated"
    d.adjudication_label_version_id = lv.id
    d.adjudicated_by = actor.id
    d.adjudicated_at = utcnow()
    d.reason = reason
    audit.record_for(db, actor, project_id=d.project_id, action="disagreement.adjudicated", entity_type="disagreement",
                     entity_id=d.id, before={"values": d.values_json},
                     after={"value": value, "label_version_id": lv.id, "adjudicator_was_party": actor.id in parties},
                     reason=reason)
    if d.scope == "slide" and d.slide_id:
        slide = db.get(Slide, d.slide_id)
        if slide is not None and slide.review_state == "disputed":
            set_review_state(db, actor, slide, "pending_review", reason=f"adjudicated: {reason}", system=True)
    return lv
