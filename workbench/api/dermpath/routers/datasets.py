"""Dataset routes: drafts, summary, splits, freeze, manifest, export, new versions, test lock."""

from __future__ import annotations

import json

from fastapi import APIRouter, Depends, Query, Response
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .. import audit
from .. import datasets as ds
from ..auth import Scope, authorize, entity_scope, project_scope
from ..db import get_db
from ..errors import conflict, unprocessable
from ..models import DatasetItem, DatasetVersion
from ..schemas import DatasetIn, DatasetOut, FreezeIn, NewVersionIn, SplitIn
from ..vocab import ITEM_PURPOSES

router = APIRouter(tags=["datasets"])


def _count(db: Session, dv: DatasetVersion) -> int:
    if dv.status == "frozen" and dv.manifest_json:
        return len(dv.manifest_json["items"])
    return db.scalar(select(func.count(DatasetItem.id)).where(DatasetItem.dataset_version_id == dv.id)) or 0


def _require_draft(dv: DatasetVersion) -> None:
    if dv.status != "draft":
        raise conflict("dataset_frozen", "This dataset version is frozen and immutable; create a new version",
                       dataset_version_id=dv.id)


@router.get("/projects/{pid}/datasets")
def list_datasets(scope: Scope = Depends(project_scope("dataset.read")), db: Session = Depends(get_db)):
    rows = db.scalars(select(DatasetVersion).where(DatasetVersion.project_id == scope.project_id)
                      .order_by(DatasetVersion.created_at)).all()
    return {"items": [ds.dataset_dict(dv, _count(db, dv)) for dv in rows]}


@router.post("/projects/{pid}/datasets", response_model=DatasetOut, status_code=201)
def create_dataset(body: DatasetIn, scope: Scope = Depends(project_scope("dataset.write")),
                   db: Session = Depends(get_db)):
    cfg = body.config.model_dump(mode="json", exclude_none=True)
    dv = ds.create_draft(db, scope.actor, scope.obj, name=body.name, config=cfg)
    db.commit()
    return ds.dataset_dict(dv, _count(db, dv))


@router.get("/datasets/{id}", response_model=DatasetOut)
def get_dataset(scope: Scope = Depends(entity_scope("dataset.read", DatasetVersion)), db: Session = Depends(get_db)):
    dv = scope.obj
    return {**ds.dataset_dict(dv, _count(db, dv)), "manifest_verified": ds.verify_manifest(dv)}


@router.get("/datasets/{id}/summary")
def summary(scope: Scope = Depends(entity_scope("dataset.read", DatasetVersion)), db: Session = Depends(get_db)):
    return ds.summary(db, scope.obj)


@router.post("/datasets/{id}/refresh")
def refresh(scope: Scope = Depends(entity_scope("dataset.write", DatasetVersion)), db: Session = Depends(get_db)):
    """Re-evaluate eligibility for a DRAFT (picks up approvals, exclusions, label changes)."""
    _require_draft(scope.obj)
    result = ds.refresh(db, scope.actor, scope.obj)
    db.commit()
    return {**ds.dataset_dict(scope.obj, _count(db, scope.obj)), "refresh": result}


@router.post("/datasets/{id}/splits")
def splits(body: SplitIn, scope: Scope = Depends(entity_scope("dataset.write", DatasetVersion)),
           db: Session = Depends(get_db)):
    """Patient-grouped split assignment (random | temporal | external_site)."""
    dv = scope.obj
    _require_draft(dv)
    diag = ds.assign_splits(db, dv, body.model_dump(mode="json", exclude_none=True))
    audit.record_for(db, scope.actor, project_id=dv.project_id, action="dataset.splits_assigned",
                     entity_type="dataset_version", entity_id=dv.id, after=diag)
    db.commit()
    return {"dataset_version_id": dv.id, "split": dv.config_json["split"], "diagnostics": diag,
            "guarantee": "every slide of a coded patient is in exactly one split"}


@router.post("/datasets/{id}/freeze", response_model=DatasetOut)
def freeze(body: FreezeIn | None = None, scope: Scope = Depends(entity_scope("dataset.write", DatasetVersion)),
           db: Session = Depends(get_db)):
    dv = scope.obj
    _require_draft(dv)
    ds.freeze(db, scope.actor, dv, reason=body.reason if body else None)
    db.commit()
    return {**ds.dataset_dict(dv, _count(db, dv)), "manifest_verified": ds.verify_manifest(dv)}


@router.post("/datasets/{id}/new-version", response_model=DatasetOut, status_code=201)
def new_version(body: NewVersionIn, scope: Scope = Depends(entity_scope("dataset.write", DatasetVersion)),
                db: Session = Depends(get_db)):
    """A child draft of a frozen version (``parent_version_id``), re-materialised from current labels."""
    child = ds.new_version(db, scope.actor, scope.obj, reason=body.reason, name=body.name)
    db.commit()
    return ds.dataset_dict(child, _count(db, child))


@router.get("/datasets/{id}/staleness")
def staleness(scope: Scope = Depends(entity_scope("dataset.read", DatasetVersion)), db: Session = Depends(get_db)):
    return ds.staleness(db, scope.obj)


@router.get("/datasets/{id}/manifest")
def manifest(scope: Scope = Depends(entity_scope("dataset.read", DatasetVersion))):
    dv = scope.obj
    if dv.status != "frozen":
        raise conflict("not_frozen", "Only frozen versions have a manifest; freeze first")
    return {"manifest": dv.manifest_json, "manifest_sha256": dv.manifest_sha256,
            "verified": ds.verify_manifest(dv),
            "hash_method": "sha256 over canonical JSON (sorted keys, no whitespace, ASCII)"}


@router.get("/datasets/{id}/export")
def export(format: str = Query("json", pattern="^(json|csv)$"),
           scope: Scope = Depends(entity_scope("dataset.read", DatasetVersion))):
    """Portable manifest: JSON (full) or CSV (items). Frozen versions only."""
    dv = scope.obj
    if dv.status != "frozen":
        raise conflict("not_frozen", "Export is for frozen versions (reproducibility); freeze first")
    name = f"dataset-{dv.id}-v{dv.version}"
    if format == "csv":
        return Response(ds.export_csv(dv), media_type="text/csv",
                        headers={"Content-Disposition": f'attachment; filename="{name}.csv"'})
    body = json.dumps({"manifest": dv.manifest_json, "manifest_sha256": dv.manifest_sha256}, indent=2, sort_keys=True)
    return Response(body, media_type="application/json",
                    headers={"Content-Disposition": f'attachment; filename="{name}.json"'})


@router.get("/datasets/{id}/items")
def items(purpose: str = Query(..., description=f"one of {ITEM_PURPOSES}"),
          scope: Scope = Depends(entity_scope("dataset.read", DatasetVersion)), db: Session = Depends(get_db)):
    """Test-set lock: train / active_learning / threshold_selection never include test items.
    ``test_evaluation`` needs the research lead role and is audited."""
    dv = scope.obj
    if purpose not in ITEM_PURPOSES:
        raise unprocessable("invalid_purpose", f"purpose must be one of {list(ITEM_PURPOSES)}")
    if purpose == "test_evaluation":
        authorize(db, scope.actor, dv.project_id, "dataset.test_access")
    try:
        rows = ds.training_eligible_items(db, dv, purpose)
    except ds.DatasetNotFrozen as exc:
        raise conflict("not_frozen", str(exc))
    if purpose == "test_evaluation":
        audit.record_for(db, scope.actor, project_id=dv.project_id, action="dataset.test_items_accessed",
                         entity_type="dataset_version", entity_id=dv.id, after={"count": len(rows)})
        db.commit()
    return {"dataset_version_id": dv.id, "purpose": purpose, "count": len(rows), "items": rows,
            "test_set_locked_for": ["train", "active_learning", "threshold_selection"]}
