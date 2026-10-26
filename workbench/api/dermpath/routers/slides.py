"""Slides, signed viewer tokens, DeepZoom tiles, thumbnails, comments and eligibility.

Tile access: ``GET /slides/{id}/viewer-token`` (membership + ``slide.view_pixels``) returns a
token bound to (slide id, user id, expiry; default 10 minutes). Tile, DZI and thumbnail
routes accept only a valid token; on each request they re-check that the token's user is
active and still a member with pixel-view permission. If a session cookie is present, it
must belong to the token's user. Label and macro images are never served.
"""

from __future__ import annotations

import re
import time
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, Query, Request, Response
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .. import audit
from ..auth import Scope, actor_from_request, authorize, entity_scope, Actor
from ..datasets import normalise_config, slide_eligibility
from ..db import get_db
from ..errors import ApiError, conflict, forbidden, not_found, unprocessable
from ..hierarchy import check_slug
from ..jobs.queue import enqueue
from ..models import Block, Comment, Job, Project, Slide, User
from ..schemas import CommentIn, SlideOut, SlidePatchIn, ViewerTokenOut
from ..signing import TokenError
from ..slides.reader import open_slide_record
from ..slides.tiles import get_tile_service
from ..storage import get_store, issue_access_token, verify_access_token
from .common import image_available, image_unavailable_reason, slide_dict

router = APIRouter(tags=["slides"])
_TILE_RE = re.compile(r"^(\d{1,6})_(\d{1,6})\.jpeg$")


@router.get("/slides/{id}", response_model=SlideOut)
def get_slide(scope: Scope = Depends(entity_scope("hierarchy.read", Slide)), db: Session = Depends(get_db)):
    """Metadata, provenance, QC summary, labels summary and review state."""
    from ..review import labels_view

    slide = scope.obj
    d = slide_dict(db, slide)
    project = db.get(Project, slide.project_id)
    view = labels_view(db, scope.actor, project, scope.member, slide)
    d["labels"] = {k: view[k] for k in ("reference", "suggestions_hidden", "independent_review", "disagreements")}
    d["labels"]["expert_label_count"] = len(view["expert_labels"])
    d["labels"]["model_suggestion_count"] = None if view["suggestions_hidden"] else len(view["model_suggestions"])
    return d


@router.patch("/slides/{id}", response_model=SlideOut)
def patch_slide(body: SlidePatchIn, scope: Scope = Depends(entity_scope("hierarchy.write", Slide)),
                db: Session = Depends(get_db)):
    slide = scope.obj
    fields = body.model_dump(exclude_unset=True)
    reason = fields.pop("reason", None)
    before = {k: getattr(slide, k) for k in fields}
    if "block_id" in fields and fields["block_id"] is not None:
        b = db.get(Block, fields["block_id"])
        if b is None or b.project_id != slide.project_id:
            raise unprocessable("invalid_block", "block_id is not a block of this project")
    if "scanner_id" in fields:
        check_slug(fields["scanner_id"], "scanner_id")
    for k, v in fields.items():
        setattr(slide, k, v)
    audit.record_for(db, scope.actor, project_id=slide.project_id, action="slide.metadata_updated",
                     entity_type="slide", entity_id=slide.id, before=before, after=fields, reason=reason)
    db.commit()
    return slide_dict(db, slide)


@router.post("/slides/{id}/reingest")
def reingest(scope: Scope = Depends(entity_scope("upload.write", Slide)), db: Session = Depends(get_db)):
    """Queue a fresh ingest (e.g. after a failure). Other slides and jobs are unaffected."""
    slide = scope.obj
    if slide.ingest_status in ("pending", "running"):
        raise conflict("ingest_in_progress", "An ingest is already queued or running")
    n = db.scalar(select(func.count(Job.id)).where(Job.type == "ingest", Job.idempotency_key.like(f"ingest:{slide.id}%")))
    job, _ = enqueue(db, "ingest", {"slide_id": slide.id, "auto_qc": True},
                     idempotency_key=f"ingest:{slide.id}:re{n}", project_id=slide.project_id,
                     created_by=scope.actor.id)
    slide.ingest_status = "pending"
    audit.record_for(db, scope.actor, project_id=slide.project_id, action="slide.reingest_requested",
                     entity_type="slide", entity_id=slide.id, after={"job_id": job.id})
    db.commit()
    return {"job_id": job.id, "slide_id": slide.id, "ingest_status": "pending"}


@router.get("/slides/{id}/eligibility")
def eligibility(label_scope: str = Query("slide"), eligible_review_states: list[str] = Query(["approved"]),
                scope: Scope = Depends(entity_scope("dataset.read", Slide)), db: Session = Depends(get_db)):
    """Would this slide enter a dataset with this config? Lists every blocking reason."""
    project = db.get(Project, scope.project_id)
    cfg = normalise_config(project, {"label_scope": label_scope, "eligible_review_states": eligible_review_states})
    ok, reasons, ref, _ = slide_eligibility(db, scope.obj, cfg)
    return {"slide_id": scope.obj.id, "eligible": ok, "reasons": reasons, "label_scope": label_scope,
            "label_version_id": ref.id if ref is not None else None,
            "label_value": ref.value if ref is not None else None}


# --------------------------------------------------------------------------- viewer token & tiles


@router.get("/slides/{id}/viewer-token", response_model=ViewerTokenOut)
def viewer_token(scope: Scope = Depends(entity_scope("slide.view_pixels", Slide)), db: Session = Depends(get_db)):
    slide = scope.obj
    if slide.ingest_status != "succeeded":
        raise conflict("slide_not_ready", "The slide has not been ingested successfully",
                       ingest_status=slide.ingest_status, ingest_error=slide.ingest_error)
    if not image_available(slide):
        raise conflict("image_unavailable", image_unavailable_reason(slide) or "No image for this slide record")
    token, exp = issue_access_token(slide.id, scope.actor.id)
    offset = get_tile_service().bounds_offset(slide.id, _opener(slide), serialize=slide.image_kind == "field_image")
    base = f"/api/v1/tiles/{token}"
    return {
        "token": token,
        "dzi_url": f"{base}/slide.dzi",
        "tile_url_template": f"{base}/slide_files/{{level}}/{{col}}_{{row}}.jpeg",
        "thumbnail_url": f"/api/v1/slides/{slide.id}/thumbnail?token={token}",
        "expires_at": datetime.fromtimestamp(exp, UTC),
        "ttl_seconds": exp - int(time.time()),
        "image_kind": slide.image_kind,
        "provenance": slide.provenance,
        "mpp_x": slide.mpp_x,
        "mpp_y": slide.mpp_y,
        "scale_bar_allowed": slide.mpp_x is not None and slide.mpp_y is not None,
        "width": slide.width,
        "height": slide.height,
        "coordinate_space": ("Annotations use level-0 pixels. The highest DZI level has level-0 resolution; "
                             "level-0 x,y = DZI x,y + bounds_offset_level0."),
        "bounds_offset_level0": offset,
    }


def slide_for_token(token: str, request: Request, db: Session, expected_slide_id: str | None = None) -> Slide:
    try:
        claims = verify_access_token(token)
    except TokenError as exc:
        raise ApiError(403, exc.code, str(exc))
    if expected_slide_id is not None and claims["sid"] != expected_slide_id:
        raise forbidden("token_slide_mismatch", "This token was issued for a different slide")
    cookie_actor = actor_from_request(request, db)
    if cookie_actor is not None and cookie_actor.id != claims["uid"]:
        raise forbidden("token_user_mismatch", "This token was issued to a different user")
    user = db.get(User, claims["uid"])
    if user is None or not user.active:
        raise forbidden("token_user_inactive", "The token's user is not active")
    slide = db.get(Slide, claims["sid"])
    if slide is None:
        raise not_found("slide", claims["sid"])
    authorize(db, Actor(user.id, user.role, user.display_name), slide.project_id, "slide.view_pixels")
    if slide.ingest_status != "succeeded":
        raise conflict("slide_not_ready", "The slide is not ingested")
    if not image_available(slide):
        raise conflict("image_unavailable", image_unavailable_reason(slide) or "No image for this slide record")
    return slide


def _opener(slide: Slide):
    snapshot = Slide(id=slide.id, image_kind=slide.image_kind, object_key=slide.object_key,
                     synthetic_spec_json=slide.synthetic_spec_json, project_id=slide.project_id,
                     provenance=slide.provenance, sha256=slide.sha256)
    return lambda: open_slide_record(snapshot)


_TILE_HEADERS = {"Cache-Control": "private, max-age=300", "X-Content-Type-Options": "nosniff"}


@router.get("/tiles/{token}/slide.dzi")
def tile_dzi(token: str, request: Request, db: Session = Depends(get_db)):
    slide = slide_for_token(token, request, db)
    xml = get_tile_service().dzi(slide.id, _opener(slide), serialize=slide.image_kind == "field_image")
    return Response(content=xml, media_type="application/xml", headers=_TILE_HEADERS)


@router.get("/tiles/{token}/slide_files/{level}/{tile_name}")
def tile(token: str, level: int, tile_name: str, request: Request, db: Session = Depends(get_db)):
    m = _TILE_RE.match(tile_name)
    if not m:
        raise not_found("tile", tile_name)
    slide = slide_for_token(token, request, db)
    data = get_tile_service().tile_jpeg(slide.id, _opener(slide), level, int(m.group(1)), int(m.group(2)),
                                        serialize=slide.image_kind == "field_image")
    if data is None:
        raise not_found("tile", f"{level}/{tile_name}")
    return Response(content=data, media_type="image/jpeg", headers=_TILE_HEADERS)


@router.get("/slides/{id}/thumbnail")
def thumbnail(id: str, request: Request, token: str = Query(...), db: Session = Depends(get_db)):
    slide = slide_for_token(token, request, db, expected_slide_id=id)
    if not slide.thumbnail_key:
        raise not_found("thumbnail", id)
    return Response(content=get_store().get_bytes(slide.thumbnail_key), media_type="image/jpeg",
                    headers=_TILE_HEADERS)


@router.get("/slides/{id}/associated/{name}")
def associated_image(id: str, name: str):
    """Label and macro images are never served (identifier risk)."""
    raise ApiError(403, "associated_images_not_served",
                   "Label, macro and other associated images are never served: possible identifier source")


# --------------------------------------------------------------------------- comments


@router.get("/slides/{id}/comments")
def list_comments(scope: Scope = Depends(entity_scope("comment.read", Slide)), db: Session = Depends(get_db)):
    rows = db.scalars(select(Comment).where(Comment.slide_id == scope.obj.id).order_by(Comment.created_at)).all()
    return {"items": [{"id": c.id, "author_id": c.author_id, "body": c.body, "created_at": c.created_at.isoformat()}
                      for c in rows]}


@router.post("/slides/{id}/comments", status_code=201)
def add_comment(body: CommentIn, scope: Scope = Depends(entity_scope("comment.write", Slide)),
                db: Session = Depends(get_db)):
    c = Comment(project_id=scope.project_id, slide_id=scope.obj.id, author_id=scope.actor.id, body=body.body)
    db.add(c)
    db.flush()
    audit.record_for(db, scope.actor, project_id=scope.project_id, action="comment.created", entity_type="comment",
                     entity_id=c.id, after={"slide_id": scope.obj.id, "length": len(body.body)})
    db.commit()
    return {"id": c.id, "author_id": c.author_id, "body": c.body, "created_at": c.created_at.isoformat()}

