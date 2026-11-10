"""Feature-set routes (design §5). Mounted under ``/api/v1`` by :mod:`dermpath.main`. Research use only.

* ``POST /projects/{pid}/feature-sets`` (``experiment.write``): ``{dataset_version_id | slide_ids,
  encoder_id, execution_mode, params?, patch_policy?, stain_policy?, device?, precision?, name?,
  build?}``. Idempotent per specification: the same request returns the existing set. The
  build is enqueued unless ``build`` is false.
* ``GET /feature-sets/{id}`` (``experiment.read``): the set with aggregated coverage
  diagnostics (per-slide table, min/median/max, zero-patch slides, slides below the coverage
  floor, uncalibrated count) and technical validations; ``?staleness=true`` adds QC changes
  since the snapshot.
* ``GET /projects/{pid}/feature-sets`` (``experiment.read``).
* ``POST /feature-sets/{id}/build`` (``experiment.write``): enqueue or resume the build
  (``{"repair": true}`` on a ready set re-extracts missing or corrupt artifacts).
* ``POST /feature-sets/{id}/technical-validation`` (``experiment.write``): enqueue a seeded
  re-extraction that checks determinism (max abs difference, cosine, identical coords) and
  records throughput, peak RSS and cache reuse; ``GET /feature-sets/{id}/validations`` lists
  the stored results.
"""

from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, Depends, Query
from pydantic import Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..auth import Scope, entity_scope, project_scope
from ..db import get_db
from ..errors import conflict, unprocessable
from ..jobs import queue
from ..schemas import Req
from . import feature_sets as fsm
from .encoders import EncoderUnavailable
from .engine_models import EXECUTION_MODES, FeatureSet, FeatureSetValidation

router = APIRouter(tags=["feature-sets"])

SYNTHETIC_PARAM_KEYS = ("synthetic_dim", "synthetic_signal_strength", "synthetic_signal_fraction")
ALLOWED_PARAM_KEYS = frozenset(fsm.PARAM_KEYS + SYNTHETIC_PARAM_KEYS)


class FeatureSetIn(Req):
    encoder_id: str = Field(..., max_length=64)
    execution_mode: Literal[EXECUTION_MODES]  # type: ignore[valid-type]
    dataset_version_id: str | None = Field(None, max_length=32)
    slide_ids: list[str] | None = Field(None, max_length=20000)
    # Feature-generation parameters (ExperimentParams names); patch_policy is accepted as an alias.
    params: dict[str, Any] | None = None
    patch_policy: dict[str, Any] | None = None
    # "none" | "macenko-v1", or {"method": ..., "source_estimate": "per_slide" | "per_patch"}
    stain_policy: str | dict[str, Any] | None = None
    device: str | None = Field(None, max_length=16)
    precision: Literal["fp32", "fp16", "bf16"] | None = None
    name: str | None = Field(None, max_length=200)
    build: bool = True


class BuildIn(Req):
    repair: bool = False


class ValidationIn(Req):
    seed: int = Field(0, ge=0, le=2**31 - 1)
    n_slides: int = Field(2, ge=1, le=100)
    max_patches: int | None = Field(None, ge=1, le=100000)


def _merged_params(body: FeatureSetIn) -> dict:
    params: dict[str, Any] = {}
    for part in (body.patch_policy, body.params):
        for k, v in (part or {}).items():
            if k in params and params[k] != v:
                raise unprocessable("invalid_params", f"{k} is given twice with different values",
                                    errors=[{"loc": [k], "msg": "conflicting values in params and patch_policy"}])
            params[k] = v
    unknown = sorted(set(params) - ALLOWED_PARAM_KEYS)
    if unknown:
        raise unprocessable("invalid_params", "Unknown feature-generation parameters",
                            errors=[{"loc": [k], "msg": "unknown parameter"} for k in unknown],
                            allowed=sorted(ALLOWED_PARAM_KEYS))
    if isinstance(body.stain_policy, str):
        params["stain_normalization"] = body.stain_policy
    elif isinstance(body.stain_policy, dict):
        extra = sorted(set(body.stain_policy) - {"method", "source_estimate"})
        if extra:
            raise unprocessable("invalid_params", "stain_policy takes method and source_estimate only",
                                errors=[{"loc": ["stain_policy", k], "msg": "unknown key"} for k in extra])
        params["stain_normalization"] = body.stain_policy.get("method", "none")
        if body.stain_policy.get("source_estimate") is not None:
            params["stain_source_estimate"] = body.stain_policy["source_estimate"]
    if body.device is not None:
        params["device"] = body.device
    if body.precision is not None:
        params["precision"] = body.precision
    return params


@router.post("/projects/{pid}/feature-sets", status_code=202)
def post_feature_set(body: FeatureSetIn, scope: Scope = Depends(project_scope("experiment.write")),
                     db: Session = Depends(get_db)):
    params = _merged_params(body)
    existing_ids = set(db.scalars(select(FeatureSet.id).where(FeatureSet.project_id == scope.project_id)).all())
    try:
        fs = fsm.create_feature_set(db, scope.actor, scope.obj, encoder_id=body.encoder_id,
                                    execution_mode=body.execution_mode, dataset_version_id=body.dataset_version_id,
                                    slide_ids=body.slide_ids, params=params, name=body.name)
    except EncoderUnavailable as exc:
        raise conflict("encoder_unavailable", f"Encoder {exc.encoder_id} is not available ({exc.status})",
                       encoder_id=exc.encoder_id, status=exc.status, status_detail=exc.detail) from exc
    created = fs.id not in existing_ids
    job = None
    if body.build and fs.status != "ready":
        job = fsm.enqueue_build(db, fs, scope.actor)
    db.commit()
    return {"feature_set": fsm.feature_set_dict(db, fs), "created": created, "job_id": job.id if job else fs.job_id}


@router.get("/projects/{pid}/feature-sets")
def list_feature_sets(scope: Scope = Depends(project_scope("experiment.read")), db: Session = Depends(get_db)):
    rows = db.scalars(select(FeatureSet).where(FeatureSet.project_id == scope.project_id)
                      .order_by(FeatureSet.created_at.desc())).all()
    return {"items": [fsm.feature_set_dict(db, r, detail=False) for r in rows]}


@router.get("/feature-sets/{id}")
def get_feature_set(staleness: bool = Query(False),
                    scope: Scope = Depends(entity_scope("experiment.read", FeatureSet, entity_name="feature_set")),
                    db: Session = Depends(get_db)):
    out = fsm.feature_set_dict(db, scope.obj)
    if staleness:
        out["staleness"] = fsm.staleness(db, scope.obj)
    return out


@router.post("/feature-sets/{id}/build", status_code=202)
def build(body: BuildIn | None = None,
          scope: Scope = Depends(entity_scope("experiment.write", FeatureSet, entity_name="feature_set")),
          db: Session = Depends(get_db)):
    fs = scope.obj
    repair = bool(body.repair) if body else False
    if repair and fs.status != "ready":
        raise conflict("feature_set_not_ready", "repair applies to a ready feature set; build it first",
                       status=fs.status)
    job = fsm.enqueue_build(db, fs, scope.actor, repair=repair)
    db.commit()
    return {"job_id": job.id, "job": queue.serialize(job), "feature_set": fsm.feature_set_dict(db, fs, detail=False)}


@router.post("/feature-sets/{id}/technical-validation", status_code=202)
def technical_validation(body: ValidationIn | None = None,
                         scope: Scope = Depends(entity_scope("experiment.write", FeatureSet,
                                                             entity_name="feature_set")),
                         db: Session = Depends(get_db)):
    body = body or ValidationIn()
    job = fsm.enqueue_validation(db, scope.obj, scope.actor, seed=body.seed, n_slides=body.n_slides,
                                 max_patches=body.max_patches)
    db.commit()
    return {"job_id": job.id, "job": queue.serialize(job)}


@router.get("/feature-sets/{id}/validations")
def validations(scope: Scope = Depends(entity_scope("experiment.read", FeatureSet, entity_name="feature_set")),
                db: Session = Depends(get_db)):
    rows = db.scalars(select(FeatureSetValidation).where(FeatureSetValidation.feature_set_id == scope.obj.id)
                      .order_by(FeatureSetValidation.created_at.desc())).all()
    return {"items": [{"id": v.id, "job_id": v.job_id, "seed": v.seed, "slide_ids": v.slide_ids_json,
                       "passed": v.passed, "result": v.result_json, "created_by": v.created_by,
                       "created_at": v.created_at.isoformat()} for v in rows]}
