"""Versioned annotations in LEVEL-0 PIXEL coordinates.

Coordinate contract: ``x`` grows to the right, ``y`` grows downwards, origin at the
top-left pixel corner of level 0 (the full-resolution image), units are level-0 pixels.
Clients convert from viewer coordinates (zoom, rotation, flip) BEFORE sending and may
record how they did it in ``transform_meta`` (stored verbatim, bounded size). Values are
stored as JSON numbers and round-trip exactly (IEEE-754 doubles via ``repr``).

Geometry input:
* ``{"type": "polygon", "points": [[x, y], ...]}`` (≥ 3 distinct points, open or closed)
* ``{"type": "rectangle", "x": .., "y": .., "width": .., "height": ..}`` (axis-aligned in
  level 0; a rectangle drawn on a rotated view is a polygon)

Every change (PATCH) and deletion (soft, DELETE) creates a NEW version and requires a
reason; old versions are kept and marked ``superseded_by``.
"""

from __future__ import annotations

import json
import math

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from . import audit
from .auth import Actor
from .errors import conflict, unprocessable
from .models import AnnotationVersion, Slide, new_id

MAX_POINTS = 20000
MAX_TRANSFORM_BYTES = 4096
COORDINATE_SPACE = {
    "space": "level0_pixels",
    "origin": "top-left corner of level 0",
    "x_axis": "right",
    "y_axis": "down",
    "units": "level-0 pixels (not microns, not geographic)",
}


def _finite(v) -> float:
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v):
        raise unprocessable("invalid_coordinate", "Coordinates must be finite numbers")
    return v


def normalise_geometry(geometry: dict, slide: Slide) -> tuple[str, dict]:
    """Validate and convert input geometry to stored form ``{"type": "Polygon", "coordinates": [[...]]}``."""
    if slide.width is None or slide.height is None:
        raise conflict("slide_not_ready", "Slide dimensions are unknown (ingest not finished)")
    gtype = (geometry or {}).get("type")
    W, H = slide.width, slide.height

    def inside(x: float, y: float) -> None:
        if x < 0 or y < 0 or x > W or y > H:
            raise unprocessable("out_of_bounds", f"Point ({x}, {y}) is outside the level-0 image (0..{W}, 0..{H})")

    if gtype == "rectangle":
        x, y = _finite(geometry.get("x")), _finite(geometry.get("y"))
        w, h = _finite(geometry.get("width")), _finite(geometry.get("height"))
        if w <= 0 or h <= 0:
            raise unprocessable("invalid_rectangle", "Rectangle width and height must be positive")
        inside(x, y)
        inside(x + w, y + h)
        ring = [[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]]
        return "rectangle", {"type": "Polygon", "coordinates": [ring],
                             "rect": {"x": x, "y": y, "width": w, "height": h}}
    if gtype == "polygon":
        pts = geometry.get("points")
        if not isinstance(pts, list) or len(pts) < 3 or len(pts) > MAX_POINTS:
            raise unprocessable("invalid_polygon", f"A polygon needs 3..{MAX_POINTS} points")
        ring = []
        for p in pts:
            if not isinstance(p, (list, tuple)) or len(p) != 2:
                raise unprocessable("invalid_polygon", "Each point is [x, y]")
            x, y = _finite(p[0]), _finite(p[1])
            inside(x, y)
            ring.append([x, y])
        if ring[0] != ring[-1]:
            ring.append(list(ring[0]))
        if len({(p[0], p[1]) for p in ring}) < 3:
            raise unprocessable("invalid_polygon", "A polygon needs at least 3 distinct points")
        return "polygon", {"type": "Polygon", "coordinates": [ring]}
    raise unprocessable("invalid_geometry", "geometry.type must be 'polygon' or 'rectangle'")


def _transform_meta(meta: dict | None, slide: Slide) -> dict:
    meta = dict(meta or {})
    if len(json.dumps(meta)) > MAX_TRANSFORM_BYTES:
        raise unprocessable("transform_meta_too_large", f"transform_meta must be under {MAX_TRANSFORM_BYTES} bytes")
    return {"client": meta, "coordinate_space": COORDINATE_SPACE, "slide_level0_size": [slide.width, slide.height]}


def version_dict(v: AnnotationVersion) -> dict:
    return {
        "id": v.id,
        "annotation_id": v.annotation_id,
        "version": v.version,
        "slide_id": v.slide_id,
        "geometry_type": v.geometry_type,
        "geometry": v.geometry_json,
        "transform_meta": v.transform_meta_json,
        "label": v.label,
        "comment": v.comment,
        "author_id": v.author_id,
        "created_at": v.created_at.isoformat(),
        "reason": v.reason,
        "superseded_by": v.superseded_by,
        "deleted": v.deleted,
        "coordinate_space": "level0_pixels",
    }


def latest(db: Session, annotation_id: str) -> AnnotationVersion | None:
    return db.scalars(select(AnnotationVersion).where(AnnotationVersion.annotation_id == annotation_id)
                      .order_by(AnnotationVersion.version.desc())).first()


def resolve_annotation(db: Session, annotation_id: str) -> AnnotationVersion | None:
    """Route resolver: an annotation (by lineage id) → its latest version (carries project_id)."""
    return latest(db, annotation_id)


def create(db: Session, actor: Actor, slide: Slide, *, geometry: dict, label: str | None, comment: str | None,
           transform_meta: dict | None) -> AnnotationVersion:
    gtype, geo = normalise_geometry(geometry, slide)
    v = AnnotationVersion(annotation_id=new_id(), version=1, project_id=slide.project_id, slide_id=slide.id,
                          geometry_type=gtype, geometry_json=geo, transform_meta_json=_transform_meta(transform_meta, slide),
                          label=label, comment=comment, author_id=actor.id, reason=None)
    db.add(v)
    db.flush()
    audit.record_for(db, actor, project_id=slide.project_id, action="annotation.created", entity_type="annotation",
                     entity_id=v.annotation_id, after={"version": 1, "geometry_type": gtype, "label": label,
                                                       "points": len(geo["coordinates"][0])})
    return v


def revise(db: Session, actor: Actor, slide: Slide, current: AnnotationVersion, *, reason: str,
           geometry: dict | None, label: str | None, comment: str | None, transform_meta: dict | None,
           delete: bool = False) -> AnnotationVersion:
    if not reason or not reason.strip():
        raise unprocessable("reason_required", "A reason is required to change or delete an annotation")
    if current.deleted:
        raise conflict("annotation_deleted", "This annotation is deleted; its history remains readable")
    if geometry is not None:
        gtype, geo = normalise_geometry(geometry, slide)
        tmeta = _transform_meta(transform_meta, slide)
    else:
        gtype, geo = current.geometry_type, current.geometry_json
        tmeta = _transform_meta(transform_meta, slide) if transform_meta is not None else current.transform_meta_json
    nxt = AnnotationVersion(
        annotation_id=current.annotation_id, version=current.version + 1, project_id=current.project_id,
        slide_id=current.slide_id, geometry_type=gtype, geometry_json=geo, transform_meta_json=tmeta,
        label=current.label if label is None else label, comment=current.comment if comment is None else comment,
        author_id=actor.id, reason=reason.strip(), deleted=delete,
    )
    db.add(nxt)
    db.flush()
    current.superseded_by = nxt.id
    audit.record_for(db, actor, project_id=current.project_id,
                     action="annotation.deleted" if delete else "annotation.revised", entity_type="annotation",
                     entity_id=current.annotation_id,
                     before={"version": current.version, "label": current.label},
                     after={"version": nxt.version, "label": nxt.label, "deleted": delete,
                            "geometry_changed": geometry is not None}, reason=reason)
    return nxt


def list_for_slide(db: Session, slide_id: str, history: bool) -> list[AnnotationVersion]:
    rows = db.scalars(select(AnnotationVersion).where(AnnotationVersion.slide_id == slide_id)
                      .order_by(AnnotationVersion.created_at, AnnotationVersion.annotation_id,
                                AnnotationVersion.version)).all()
    if history:
        return list(rows)
    newest: dict[str, AnnotationVersion] = {}
    for r in rows:
        if r.annotation_id not in newest or r.version > newest[r.annotation_id].version:
            newest[r.annotation_id] = r
    return [r for r in newest.values() if not r.deleted]


def geojson_export(db: Session, project_id: str) -> dict:
    sub = (select(AnnotationVersion.annotation_id, func.max(AnnotationVersion.version).label("v"))
           .where(AnnotationVersion.project_id == project_id).group_by(AnnotationVersion.annotation_id).subquery())
    rows = db.scalars(select(AnnotationVersion).join(
        sub, (AnnotationVersion.annotation_id == sub.c.annotation_id) & (AnnotationVersion.version == sub.c.v))
        .order_by(AnnotationVersion.slide_id, AnnotationVersion.annotation_id)).all()
    slides = {s.id: s for s in db.scalars(select(Slide).where(Slide.project_id == project_id)).all()}
    features = []
    for v in rows:
        if v.deleted:
            continue
        s = slides.get(v.slide_id)
        features.append({
            "type": "Feature",
            "id": v.annotation_id,
            "geometry": {"type": "Polygon", "coordinates": v.geometry_json["coordinates"]},
            "properties": {
                "annotation_id": v.annotation_id,
                "version": v.version,
                "slide_id": v.slide_id,
                "slide_sha256": s.sha256 if s else None,
                "slide_level0_size": [s.width, s.height] if s else None,
                "geometry_type": v.geometry_type,
                "label": v.label,
                "comment": v.comment,
                "author_id": v.author_id,
                "created_at": v.created_at.isoformat(),
                "coordinate_space": COORDINATE_SPACE,
                "provenance": s.provenance if s else None,
            },
        })
    return {
        "type": "FeatureCollection",
        "features": features,
        # Foreign members (allowed by RFC 7946 §6.1). Coordinates are NOT geographic.
        "properties": {
            "schema": "dermpath.annotations.geojson/1",
            "project_id": project_id,
            "coordinate_space": COORDINATE_SPACE,
            "note": ("Coordinates are LEVEL-0 IMAGE PIXELS (x right, y down, origin top-left), not "
                     "longitude/latitude. Only the latest non-deleted version of each annotation is exported."),
            "research_use_only": True,
        },
    }
