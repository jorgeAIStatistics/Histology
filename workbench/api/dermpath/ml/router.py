"""ML routes (docs/ml-api-contract.md). Mounted under /api/v1 by dermpath.main.

Permissions: ``experiment.read`` (reads), ``experiment.write`` (create, cancel, active
learning, feature extraction), ``model.register``; the TEST split additionally needs
``dataset.test_access`` (research lead) and a frozen validation threshold, and is audited.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Query, Response
from pydantic import Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import audit
from ..auth import Actor, Scope, authorize, current_actor, entity_scope, project_scope
from ..datasets import TestSetLockViolation
from ..db import get_db
from ..errors import conflict, not_found, unprocessable
from ..jobs import queue
from ..models import DatasetVersion, Slide
from ..schemas import Req
from . import PIPELINE_TEST_BANNER
from .active_learning import propose
from .config import resolve_params
from .encoders import get_encoder, list_encoders
from .evaluation import (
    attention_response,
    audit_test_access,
    ensure_test_evaluation,
    errors_response,
    evaluation_response,
    prediction_for_slide,
    require_test_unlocked,
    stored_evaluation,
)
from .features import artifact_dict
from .models import FeatureArtifact, ModelVersion, TrainingRun
from .service import cancel_experiment, create_experiment, model_dict, register_model, run_dict

router = APIRouter(tags=["ml"])

SPLIT_PATTERN = "^(val|test)$"


class ExperimentIn(Req):
    dataset_version_id: str
    encoder_id: str
    head: str
    params: dict[str, Any] | None = None
    seed: int
    name: str | None = Field(None, max_length=200)


class RegisterIn(Req):
    note: str | None = Field(None, max_length=2000)


class ActiveLearningIn(Req):
    dataset_version_id: str
    run_id: str
    k: int = Field(10, ge=1, le=500)
    random_fraction: float = Field(0.2, ge=0.0, le=1.0)
    seed: int | None = Field(None, ge=0, le=2**31 - 1)


class FeaturesIn(Req):
    encoder_id: str
    params: dict[str, Any] | None = None
    seed: int = Field(0, ge=0, le=2**31 - 1)


# --------------------------------------------------------------------------- encoders


@router.get("/encoders")
def encoders(_actor: Actor = Depends(current_actor)):
    """Encoder adapters with licence metadata and honest dependency status. Never downloads."""
    return {"items": list_encoders(),
            "note": "Encoders are enabled only by locally present, legally obtained weights; nothing is downloaded."}


# --------------------------------------------------------------------------- experiments


@router.post("/projects/{pid}/experiments", status_code=202)
def post_experiment(body: ExperimentIn, scope: Scope = Depends(project_scope("experiment.write")),
                    db: Session = Depends(get_db)):
    run, job = create_experiment(db, scope.actor, scope.obj, dataset_version_id=body.dataset_version_id,
                                 encoder_id=body.encoder_id, head=body.head, params=body.params, seed=body.seed,
                                 name=body.name)
    db.commit()
    return {"experiment": run_dict(db, run), "job_id": job.id}


@router.get("/projects/{pid}/experiments")
def list_experiments(scope: Scope = Depends(project_scope("experiment.read")), db: Session = Depends(get_db)):
    rows = db.scalars(select(TrainingRun).where(TrainingRun.project_id == scope.project_id)
                      .order_by(TrainingRun.created_at.desc())).all()
    return {"items": [run_dict(db, r) for r in rows]}


@router.get("/experiments/{id}")
def get_experiment(scope: Scope = Depends(entity_scope("experiment.read", TrainingRun, entity_name="experiment")),
                   db: Session = Depends(get_db)):
    return run_dict(db, scope.obj)


@router.post("/experiments/{id}/cancel")
def cancel(scope: Scope = Depends(entity_scope("experiment.write", TrainingRun, entity_name="experiment")),
           db: Session = Depends(get_db)):
    cancel_experiment(db, scope.actor, scope.obj)
    db.commit()
    return run_dict(db, scope.obj)


def _test_gate(db: Session, scope: Scope, run: TrainingRun) -> None:
    require_test_unlocked(run)  # 409 test_locked
    authorize(db, scope.actor, run.project_id, "dataset.test_access")  # 403 unless research lead


@router.get("/experiments/{id}/evaluation")
def evaluation(split: str = Query("val", pattern=SPLIT_PATTERN),
               scope: Scope = Depends(entity_scope("experiment.read", TrainingRun, entity_name="experiment")),
               db: Session = Depends(get_db)):
    run = scope.obj
    if split == "test":
        _test_gate(db, scope, run)
        ev = ensure_test_evaluation(db, run, scope.actor)
        audit_test_access(db, scope.actor, run, "evaluation")
        db.commit()
        return evaluation_response(ev, run)
    ev = stored_evaluation(db, run.id, "val")
    if ev is None:
        raise conflict("evaluation_not_ready", "The validation evaluation exists once the run has succeeded",
                       run_status=run_dict(db, run)["status"])
    return evaluation_response(ev, run)


@router.get("/experiments/{id}/errors")
def errors(split: str = Query("val", pattern=SPLIT_PATTERN),
           scope: Scope = Depends(entity_scope("experiment.read", TrainingRun, entity_name="experiment")),
           db: Session = Depends(get_db)):
    run = scope.obj
    if split == "test":
        _test_gate(db, scope, run)
        ensure_test_evaluation(db, run, scope.actor)
        audit_test_access(db, scope.actor, run, "errors")
        db.commit()
    elif stored_evaluation(db, run.id, "val") is None:
        raise conflict("evaluation_not_ready", "Errors are available once the run has succeeded")
    return errors_response(db, run, split)


@router.get("/experiments/{id}/attention/{slide_id}")
def attention(slide_id: str,
              scope: Scope = Depends(entity_scope("experiment.read", TrainingRun, entity_name="experiment")),
              db: Session = Depends(get_db)):
    run = scope.obj
    if run.head != "abmil":
        raise conflict("attention_unavailable", f"Head {run.head} has no attention weights (only abmil does)",
                       head=run.head)
    if run.status != "succeeded":
        raise conflict("evaluation_not_ready", "Attention is available once the run has succeeded")
    p = prediction_for_slide(db, run, slide_id)
    if p is not None and p.split == "test":
        _test_gate(db, scope, run)
        audit_test_access(db, scope.actor, run, f"attention:{slide_id}")
        db.commit()
    return attention_response(run, p, slide_id)


# --------------------------------------------------------------------------- registry


@router.post("/experiments/{id}/register")
def register(response: Response, body: RegisterIn | None = None,
             scope: Scope = Depends(entity_scope("model.register", TrainingRun, entity_name="experiment")),
             db: Session = Depends(get_db)):
    """Register a research candidate. Idempotent per run. Nothing is ever deployed."""
    mv, created = register_model(db, scope.actor, scope.obj, note=body.note if body else None)
    db.commit()
    response.status_code = 201 if created else 200
    return model_dict(mv)


@router.get("/projects/{pid}/models")
def models(scope: Scope = Depends(project_scope("experiment.read")), db: Session = Depends(get_db)):
    rows = db.scalars(select(ModelVersion).where(ModelVersion.project_id == scope.project_id)
                      .order_by(ModelVersion.created_at.desc())).all()
    return {"items": [model_dict(m) for m in rows],
            "note": "Research candidates only; there is no deployment path in this workbench."}


# --------------------------------------------------------------------------- active learning


@router.post("/projects/{pid}/active-learning")
def active_learning(body: ActiveLearningIn, scope: Scope = Depends(project_scope("experiment.write")),
                    db: Session = Depends(get_db)):
    run = db.get(TrainingRun, body.run_id)
    if run is None or run.project_id != scope.project_id:
        raise not_found("experiment", body.run_id)
    if run.status != "succeeded":
        raise conflict("run_not_succeeded", "Active learning needs a finished run", status=run.status)
    dv = db.get(DatasetVersion, body.dataset_version_id)
    if dv is None or dv.project_id != scope.project_id:
        raise not_found("dataset_version", body.dataset_version_id)
    if dv.status != "frozen":
        raise conflict("dataset_not_frozen", "Active learning uses frozen dataset versions")
    if dv.id != run.dataset_version_id:
        raise conflict("dataset_mismatch", "Proposals use the run's own frozen dataset version (its train pool)",
                       run_dataset_version_id=run.dataset_version_id)
    try:
        out = propose(db, run, dv, k=body.k, random_fraction=body.random_fraction, seed=body.seed)
    except TestSetLockViolation as exc:  # pragma: no cover - defence in depth
        raise conflict("test_set_lock", str(exc))
    audit.record_for(db, scope.actor, project_id=scope.project_id, action="active_learning.proposed",
                     entity_type="training_run", entity_id=run.id,
                     after={"k": body.k, "random_fraction": body.random_fraction, "proposed": len(out["items"]),
                            "composition": out["composition"], "pool": "train_only"})
    db.commit()
    return out


# --------------------------------------------------------------------------- feature extraction (additive)


@router.post("/slides/{id}/features", status_code=202)
def extract(body: FeaturesIn, scope: Scope = Depends(entity_scope("experiment.write", Slide)),
            db: Session = Depends(get_db)):
    """Enqueue ``extract_features`` for one slide (no label is used: no synthetic class signal)."""
    encoder = get_encoder(body.encoder_id)
    if encoder is None:
        raise unprocessable("unknown_encoder", f"Unknown encoder {body.encoder_id}")
    status, detail = encoder.status()
    if status != "available":
        raise conflict("encoder_unavailable", f"Encoder {body.encoder_id} is not available ({status})",
                       encoder_id=body.encoder_id, status=status, status_detail=detail)
    try:
        params = resolve_params(body.params)
    except ValueError as exc:
        raise unprocessable("invalid_params", "Invalid params", errors=exc.args[0]) from exc
    slide = scope.obj
    if slide.ingest_status != "succeeded" or slide.image_kind == "field_image":
        raise conflict("slide_not_extractable", "Only ingested whole-slide or synthetic tiled images are patched")
    import hashlib
    import json

    digest = hashlib.sha256(json.dumps({"p": params, "s": body.seed}, sort_keys=True).encode()).hexdigest()[:16]
    job, _ = queue.enqueue(db, "extract_features", {"slide_id": slide.id, "encoder_id": body.encoder_id,
                                                    "params": body.params or {}, "seed": body.seed},
                           idempotency_key=f"extract:{slide.id}:{body.encoder_id}:{digest}",
                           project_id=slide.project_id, created_by=scope.actor.id)
    audit.record_for(db, scope.actor, project_id=slide.project_id, action="features.extraction_requested",
                     entity_type="slide", entity_id=slide.id, after={"encoder_id": body.encoder_id, "job_id": job.id})
    db.commit()
    return {"job_id": job.id, "status": job.status, "synthetic": encoder.synthetic,
            "banner": PIPELINE_TEST_BANNER if encoder.synthetic else None}


@router.get("/slides/{id}/features")
def list_features(scope: Scope = Depends(entity_scope("experiment.read", Slide)), db: Session = Depends(get_db)):
    rows = db.scalars(select(FeatureArtifact).where(FeatureArtifact.slide_id == scope.obj.id)
                      .order_by(FeatureArtifact.created_at)).all()
    return {"items": [artifact_dict(a) for a in rows]}
