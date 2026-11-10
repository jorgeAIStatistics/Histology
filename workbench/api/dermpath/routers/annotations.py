"""Annotation routes. Coordinates are LEVEL-0 PIXELS (see dermpath.annotations)."""

from __future__ import annotations

from fastapi import APIRouter, Body, Depends, Query
from sqlalchemy.orm import Session

from .. import annotations as ann
from ..auth import Scope, entity_scope, project_scope
from ..db import get_db
from ..errors import conflict
from ..models import Slide
from ..schemas import AnnotationDeleteIn, AnnotationIn, AnnotationPatchIn

router = APIRouter(tags=["annotations"])


@router.get("/slides/{id}/annotations")
def list_annotations(history: int = Query(0, ge=0, le=1),
                     scope: Scope = Depends(entity_scope("annotation.read", Slide)), db: Session = Depends(get_db)):
    """Current versions (``?history=1`` returns every version, including deleted)."""
    rows = ann.list_for_slide(db, scope.obj.id, bool(history))
    return {"items": [ann.version_dict(v) for v in rows], "coordinate_space": ann.COORDINATE_SPACE,
            "history": bool(history)}


@router.post("/slides/{id}/annotations", status_code=201)
def create_annotation(body: AnnotationIn, scope: Scope = Depends(entity_scope("annotation.write", Slide)),
                      db: Session = Depends(get_db)):
    slide = scope.obj
    if slide.ingest_status != "succeeded":
        raise conflict("slide_not_ready", "Annotate only ingested slides")
    v = ann.create(db, scope.actor, slide, geometry=body.geometry, label=body.label, comment=body.comment,
                   transform_meta=body.transform_meta)
    db.commit()
    return ann.version_dict(v)


@router.patch("/annotations/{id}")
def revise_annotation(body: AnnotationPatchIn,
                      scope: Scope = Depends(entity_scope("annotation.write", ann.resolve_annotation,
                                                          entity_name="annotation")),
                      db: Session = Depends(get_db)):
    """Creates a new version; ``reason`` is required. ``{id}`` is the annotation (lineage) id."""
    current = scope.obj
    slide = db.get(Slide, current.slide_id)
    v = ann.revise(db, scope.actor, slide, current, reason=body.reason, geometry=body.geometry, label=body.label,
                   comment=body.comment, transform_meta=body.transform_meta)
    db.commit()
    return ann.version_dict(v)


@router.delete("/annotations/{id}")
def delete_annotation(body: AnnotationDeleteIn | None = Body(None), reason: str | None = Query(None),
                      scope: Scope = Depends(entity_scope("annotation.write", ann.resolve_annotation,
                                                          entity_name="annotation")),
                      db: Session = Depends(get_db)):
    """Soft delete: a new version with ``deleted=true``. Reason via JSON body or ``?reason=``."""
    current = scope.obj
    slide = db.get(Slide, current.slide_id)
    why = (body.reason if body else None) or reason
    v = ann.revise(db, scope.actor, slide, current, reason=why or "", geometry=None, label=None, comment=None,
                   transform_meta=None, delete=True)
    db.commit()
    return ann.version_dict(v)


@router.get("/projects/{pid}/export/annotations.geojson")
def export_geojson(scope: Scope = Depends(project_scope("annotation.read")), db: Session = Depends(get_db)):
    return ann.geojson_export(db, scope.project_id)
