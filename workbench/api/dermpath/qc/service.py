"""QC screening job and the issue lifecycle.

Lifecycle: ``open → reviewed → action_suggested → resolved`` (``reopen`` returns to open).
Every transition writes a :class:`QCIssueEvent` and an audit event.

* Automated screening (Otsu tissue fraction, variance-of-Laplacian focus, calibration
  presence) is recorded as ``heuristic`` and ``experimental``. It creates issues only as
  SUGGESTIONS (``is_suggestion=True``) with no dataset effect.
* Suggested actions are proposals for a human (``consider_recut`` …). Nothing is ordered,
  recut, rescanned, discarded or excluded automatically.
* Only a human resolution with ``dataset_eligibility_effect`` = ``exclude_slide`` /
  ``exclude_region`` changes dataset eligibility.
* A heuristic finding can be overridden by a human with a reason (issue action
  ``override``), and a screening metric can be overridden with
  :func:`override_screen` (a ``manual`` QCReview pointing at the automated one).
"""

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import audit
from ..auth import Actor
from ..config import get_settings
from ..db import session_scope, utcnow
from ..errors import ApiError, conflict, unprocessable
from ..jobs.registry import JobContext, PermanentJobError
from ..models import QCIssue, QCIssueEvent, QCReview, Slide, new_id
from ..slides.imaging import bounded_thumbnail
from ..slides.reader import open_slide_record
from ..storage import get_store, slide_key
from ..vocab import (
    QC_CATEGORIES,
    QC_ELIGIBILITY_EFFECTS,
    QC_MANUAL_CATEGORIES,
    QC_SUGGESTED_ACTIONS,
)
from . import focus, tissue

EXPERIMENTAL_LABEL = "EXPERIMENTAL HEURISTIC SCREEN: not a validated detector; suggestions need human review"


def _event(db: Session, issue: QCIssue, action: str, from_status: str | None, to_status: str,
           actor_id: str | None, reason: str | None = None, detail: dict | None = None) -> None:
    db.add(QCIssueEvent(project_id=issue.project_id, issue_id=issue.id, action=action,
                        from_status=from_status, to_status=to_status, actor_id=actor_id,
                        reason=reason, detail_json=detail or {}))


def issue_dict(issue: QCIssue, events: list[QCIssueEvent] | None = None) -> dict:
    d = {
        "id": issue.id,
        "slide_id": issue.slide_id,
        "project_id": issue.project_id,
        "category": issue.category,
        "region": issue.region_json,
        "source": issue.source,
        "is_suggestion": issue.is_suggestion,
        "experimental": issue.source == "heuristic",
        "status": issue.status,
        "human_confirmed": issue.human_confirmed,
        "suggested_action": issue.suggested_action,
        "resolution": issue.resolution,
        "dataset_eligibility_effect": issue.dataset_eligibility_effect,
        "reason": issue.reason,
        "note": issue.note,
        "qc_review_id": issue.qc_review_id,
        "override_of": issue.override_of,
        "overridden": issue.overridden,
        "created_by": issue.created_by,
        "created_at": issue.created_at.isoformat(),
        "updated_at": issue.updated_at.isoformat() if issue.updated_at else None,
        "reviewed_by": issue.reviewed_by,
        "reviewed_at": issue.reviewed_at.isoformat() if issue.reviewed_at else None,
        "resolved_by": issue.resolved_by,
        "resolved_at": issue.resolved_at.isoformat() if issue.resolved_at else None,
    }
    if events is not None:
        d["history"] = [
            {"action": e.action, "from_status": e.from_status, "to_status": e.to_status,
             "actor_id": e.actor_id, "reason": e.reason, "detail": e.detail_json, "at": e.at.isoformat()}
            for e in events
        ]
    return d


def review_dict(r: QCReview) -> dict:
    return {
        "id": r.id,
        "slide_id": r.slide_id,
        "kind": r.kind,
        "method_version": r.method_version,
        "metrics": r.metrics_json,
        "has_mask": bool(r.mask_object_key),
        "experimental": r.experimental,
        "override_of": r.override_of,
        "reason": r.reason,
        "job_id": r.job_id,
        "created_by": r.created_by,
        "created_at": r.created_at.isoformat(),
    }


# --------------------------------------------------------------------------- screening job


def run_screen(slide_id: str, ctx: JobContext | None = None, *, job_id: str | None = None) -> dict:
    settings = get_settings()
    with session_scope() as db:
        slide = db.get(Slide, slide_id)
        if slide is None:
            raise PermanentJobError(f"slide {slide_id} does not exist")
        if slide.ingest_status != "succeeded":
            raise PermanentJobError(f"slide {slide_id} is not ingested (status {slide.ingest_status})")
        db.expunge(slide)
    osr = open_slide_record(slide)
    try:
        dims = osr.dimensions
        thumb = bounded_thumbnail(osr, (1024, 1024))
        mask, tstats = tissue.segment(thumb, dims)
        if ctx:
            ctx.progress(0.3, "tissue segmentation done")
        fstats = focus.measure(osr, mask, settings.qc_blur_variance_threshold)
        if ctx:
            ctx.progress(0.8, "focus heuristic done")
    finally:
        osr.close()

    if slide.mpp_x is None or slide.mpp_y is None:
        calibration = ({"status": "not_applicable_synthetic",
                        "note": "procedural synthetic tiles have no physical calibration by construction"}
                       if slide.image_kind == "synthetic_tiles" else
                       {"status": "missing", "note": "microns-per-pixel unknown: no scale bar, no physical measurements"})
    else:
        calibration = {"status": "present", "mpp_x": slide.mpp_x, "mpp_y": slide.mpp_y}

    review_id = new_id()
    mask_key = slide_key(slide.project_id, slide_id, f"qc/mask-{review_id}.png")
    get_store().put_bytes(mask_key, tissue.mask_png(mask))

    created: list[str] = []
    suppressed: list[str] = []
    with session_scope() as db:
        review = QCReview(
            id=review_id, project_id=slide.project_id, slide_id=slide_id, kind="automated_screen",
            method_version=f"{tissue.METHOD_VERSION}+{focus.METHOD_VERSION}",
            metrics_json={
                "label": EXPERIMENTAL_LABEL,
                "source": "heuristic",
                "tissue": tstats,
                "focus": fstats,
                "calibration": calibration,
                "thresholds": {"low_tissue_fraction": settings.qc_low_tissue_fraction,
                               "blur_variance": settings.qc_blur_variance_threshold,
                               "calibrated": False},
            },
            mask_object_key=mask_key, experimental=True, job_id=job_id or (ctx.job_id if ctx else None),
            created_by=audit.SYSTEM_WORKER,
        )
        db.add(review)
        db.flush()
        findings = []
        if tstats["tissue_fraction"] < settings.qc_low_tissue_fraction:
            findings.append(("low_tissue_heuristic",
                             f"Tissue fraction {tstats['tissue_fraction']:.3f} is below "
                             f"{settings.qc_low_tissue_fraction} (Otsu on saturation; experimental)"))
        if fstats.get("suspected_blur"):
            findings.append(("blur_heuristic",
                             f"Median variance of Laplacian {fstats['median_variance']} is below the "
                             f"uncalibrated threshold {settings.qc_blur_variance_threshold} (experimental)"))
        if calibration["status"] == "missing":
            findings.append(("missing_calibration", "Microns-per-pixel is absent from the file metadata"))
        for category, note in findings:
            existing = db.scalars(select(QCIssue).where(
                QCIssue.slide_id == slide_id, QCIssue.category == category)).all()
            if any(i.overridden for i in existing):
                suppressed.append(category)
                continue
            open_existing = [i for i in existing if i.status != "resolved"]
            if open_existing:
                open_existing[0].qc_review_id = review_id
                continue
            issue = QCIssue(project_id=slide.project_id, slide_id=slide_id, category=category,
                            source="heuristic", is_suggestion=True, status="open",
                            dataset_eligibility_effect="none", note=note, qc_review_id=review_id,
                            created_by=audit.SYSTEM_WORKER)
            db.add(issue)
            db.flush()
            _event(db, issue, "created", None, "open", audit.SYSTEM_WORKER, detail={"suggestion": True})
            audit.record(db, action="qc.issue_suggested", entity_type="qc_issue", entity_id=issue.id,
                         actor_id=audit.SYSTEM_WORKER, actor_role="system", project_id=slide.project_id,
                         after={"category": category, "slide_id": slide_id, "source": "heuristic"})
            created.append(category)
        review.metrics_json = {**review.metrics_json, "suggestions_created": created,
                               "suggestions_suppressed_by_human_override": suppressed}
        audit.record(db, action="qc.screened", entity_type="qc_review", entity_id=review_id,
                     actor_id=audit.SYSTEM_WORKER, actor_role="system", project_id=slide.project_id,
                     after={"slide_id": slide_id, "tissue_fraction": tstats["tissue_fraction"],
                            "focus_median": fstats.get("median_variance"), "suggestions": created})
    return {"slide_id": slide_id, "qc_review_id": review_id, "tissue_fraction": tstats["tissue_fraction"],
            "focus_median_variance": fstats.get("median_variance"), "suggestions_created": created}


# --------------------------------------------------------------------------- manual issues & lifecycle


def create_manual_issue(db: Session, actor: Actor, slide: Slide, *, category: str, region: dict | None,
                        note: str | None, override_of: str | None, reason: str | None) -> QCIssue:
    if category not in QC_MANUAL_CATEGORIES:
        raise unprocessable("invalid_category", f"Manual issues use one of {list(QC_MANUAL_CATEGORIES)}",
                            allowed=list(QC_MANUAL_CATEGORIES))
    overridden_issue = None
    if override_of:
        overridden_issue = db.get(QCIssue, override_of)
        if overridden_issue is None or overridden_issue.slide_id != slide.id:
            raise unprocessable("invalid_override", "override_of must reference an issue on this slide")
        if overridden_issue.source != "heuristic":
            raise unprocessable("invalid_override", "only heuristic issues can be overridden")
        if not reason:
            raise unprocessable("reason_required", "Overriding a heuristic finding requires a reason")
    issue = QCIssue(project_id=slide.project_id, slide_id=slide.id, category=category, region_json=region,
                    source="human", is_suggestion=False, status="open", dataset_eligibility_effect="none",
                    note=note, reason=reason, override_of=override_of, created_by=actor.id)
    db.add(issue)
    db.flush()
    _event(db, issue, "created", None, "open", actor.id, reason=reason, detail={"override_of": override_of})
    audit.record_for(db, actor, project_id=slide.project_id, action="qc.issue_created", entity_type="qc_issue",
                     entity_id=issue.id, after={"category": category, "slide_id": slide.id,
                                                "override_of": override_of, "has_region": region is not None},
                     reason=reason)
    if overridden_issue is not None and overridden_issue.status != "resolved":
        _close_as_override(db, actor, overridden_issue, f"superseded by human issue {issue.id}: {reason}")
    return issue


def _close_as_override(db: Session, actor: Actor, issue: QCIssue, reason: str) -> None:
    before = issue.status
    issue.status = "resolved"
    issue.overridden = True
    issue.resolution = "human override: heuristic finding not confirmed as stated"
    issue.dataset_eligibility_effect = "none"
    issue.reason = reason
    issue.resolved_by = actor.id
    issue.resolved_at = utcnow()
    _event(db, issue, "override", before, "resolved", actor.id, reason=reason)
    audit.record_for(db, actor, project_id=issue.project_id, action="qc.issue_override", entity_type="qc_issue",
                     entity_id=issue.id, before={"status": before}, after={"status": "resolved", "overridden": True},
                     reason=reason)


_ALLOWED_FROM = {
    "review": ("open",),
    "suggest_action": ("reviewed", "action_suggested"),
    "resolve": ("reviewed", "action_suggested"),
    "override": ("open", "reviewed", "action_suggested"),
    "reopen": ("resolved",),
}


def transition_issue(db: Session, actor: Actor, issue: QCIssue, *, action: str, reason: str | None,
                     confirmed: bool | None = None, suggested_action: str | None = None,
                     resolution: str | None = None, dataset_eligibility_effect: str | None = None) -> QCIssue:
    if action not in _ALLOWED_FROM:
        raise unprocessable("invalid_action", f"action must be one of {list(_ALLOWED_FROM)}")
    if issue.status not in _ALLOWED_FROM[action]:
        raise conflict("invalid_transition", f"Cannot {action} an issue that is {issue.status}",
                       status=issue.status, allowed_from=list(_ALLOWED_FROM[action]))
    before = {"status": issue.status, "suggested_action": issue.suggested_action,
              "dataset_eligibility_effect": issue.dataset_eligibility_effect}
    now = utcnow()
    detail: dict = {}
    if action == "review":
        if confirmed is None:
            raise unprocessable("confirmed_required", "Reviewing requires confirmed: true|false")
        issue.status = "reviewed"
        issue.human_confirmed = confirmed
        issue.reviewed_by, issue.reviewed_at = actor.id, now
        detail["confirmed"] = confirmed
    elif action == "suggest_action":
        if suggested_action not in QC_SUGGESTED_ACTIONS:
            raise unprocessable("invalid_suggested_action", f"suggested_action must be one of {list(QC_SUGGESTED_ACTIONS)}")
        issue.status = "action_suggested"
        issue.suggested_action = suggested_action
        detail["suggested_action"] = suggested_action
        detail["note"] = "a suggestion for a human decision; nothing is ordered automatically"
    elif action == "resolve":
        if not resolution:
            raise unprocessable("resolution_required", "Resolving requires a resolution text")
        effect = dataset_eligibility_effect or "none"
        if effect not in QC_ELIGIBILITY_EFFECTS:
            raise unprocessable("invalid_effect", f"dataset_eligibility_effect must be one of {list(QC_ELIGIBILITY_EFFECTS)}")
        if effect == "exclude_region" and not issue.region_json:
            raise unprocessable("region_required", "exclude_region needs an issue with a region")
        if effect != "none" and not reason:
            raise unprocessable("reason_required", "A dataset eligibility effect requires a reason")
        issue.status = "resolved"
        issue.resolution = resolution
        issue.dataset_eligibility_effect = effect
        issue.resolved_by, issue.resolved_at = actor.id, now
        detail.update({"resolution": resolution, "dataset_eligibility_effect": effect})
    elif action == "override":
        if issue.source != "heuristic":
            raise unprocessable("invalid_override", "Only heuristic findings can be overridden; resolve human issues instead")
        if not reason:
            raise unprocessable("reason_required", "Overriding a heuristic finding requires a reason")
        _close_as_override(db, actor, issue, reason)
        return issue
    elif action == "reopen":
        if not reason:
            raise unprocessable("reason_required", "Reopening requires a reason")
        issue.status = "open"
        issue.dataset_eligibility_effect = "none"
        issue.overridden = False
        issue.resolution = None
        issue.resolved_by = issue.resolved_at = None
    if reason:
        issue.reason = reason
    _event(db, issue, action, before["status"], issue.status, actor.id, reason=reason, detail=detail)
    audit.record_for(db, actor, project_id=issue.project_id, action=f"qc.issue_{action}", entity_type="qc_issue",
                     entity_id=issue.id, before=before,
                     after={"status": issue.status, "suggested_action": issue.suggested_action,
                            "dataset_eligibility_effect": issue.dataset_eligibility_effect},
                     reason=reason)
    return issue


def override_screen(db: Session, actor: Actor, slide: Slide, *, review_id: str, metric: str, verdict: str,
                    reason: str) -> QCReview:
    auto = db.get(QCReview, review_id)
    if auto is None or auto.slide_id != slide.id or auto.kind != "automated_screen":
        raise unprocessable("invalid_review", "review_id must be an automated screen of this slide")
    if metric not in ("tissue_fraction", "focus", "calibration"):
        raise unprocessable("invalid_metric", "metric must be tissue_fraction, focus or calibration")
    if verdict not in ("adequate", "inadequate", "not_assessable"):
        raise unprocessable("invalid_verdict", "verdict must be adequate, inadequate or not_assessable")
    if not reason:
        raise unprocessable("reason_required", "An override requires a reason")
    r = QCReview(project_id=slide.project_id, slide_id=slide.id, kind="manual", method_version="human_override",
                 metrics_json={"override": {"metric": metric, "verdict": verdict}}, experimental=False,
                 override_of=review_id, reason=reason, created_by=actor.id)
    db.add(r)
    db.flush()
    audit.record_for(db, actor, project_id=slide.project_id, action="qc.screen_override", entity_type="qc_review",
                     entity_id=r.id, after={"override_of": review_id, "metric": metric, "verdict": verdict},
                     reason=reason)
    return r


def slide_qc_summary(db: Session, slide_id: str) -> dict:
    issues = db.scalars(select(QCIssue).where(QCIssue.slide_id == slide_id)).all()
    latest = db.scalars(select(QCReview).where(QCReview.slide_id == slide_id, QCReview.kind == "automated_screen")
                        .order_by(QCReview.created_at.desc())).first()
    by_status: dict[str, int] = {}
    for i in issues:
        by_status[i.status] = by_status.get(i.status, 0) + 1
    excluded_by = [i.id for i in issues if i.status == "resolved" and i.dataset_eligibility_effect == "exclude_slide"]
    region_exclusions = [i.id for i in issues if i.status == "resolved" and i.dataset_eligibility_effect == "exclude_region"]
    return {
        "issue_counts_by_status": by_status,
        "open_suggestions": sum(1 for i in issues if i.is_suggestion and i.status != "resolved"),
        "open_issues": sum(1 for i in issues if i.status != "resolved"),
        "categories_open": sorted({i.category for i in issues if i.status != "resolved"}),
        "excluded_by_issue_ids": excluded_by,
        "region_exclusion_issue_ids": region_exclusions,
        "latest_screen": None if latest is None else {
            "id": latest.id,
            "at": latest.created_at.isoformat(),
            "tissue_fraction": latest.metrics_json.get("tissue", {}).get("tissue_fraction"),
            "focus_median_variance": latest.metrics_json.get("focus", {}).get("median_variance"),
            "calibration": latest.metrics_json.get("calibration", {}).get("status"),
            "experimental": True,
        },
    }


def excluded_regions(db: Session, slide_id: str) -> list[dict]:
    """Regions (level-0 px) a human excluded from training; for the patching pipeline."""
    issues = db.scalars(select(QCIssue).where(
        QCIssue.slide_id == slide_id, QCIssue.status == "resolved",
        QCIssue.dataset_eligibility_effect == "exclude_region")).all()
    return [{"issue_id": i.id, "category": i.category, "region": i.region_json} for i in issues]


def validate_category(category: str) -> None:
    if category not in QC_CATEGORIES:
        raise ApiError(422, "invalid_category", f"category must be one of {list(QC_CATEGORIES)}")
