"""Experiment creation, cancellation, registry and serialisers (shared by the router and the seed)."""

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import audit
from ..auth import Actor
from ..errors import conflict, not_found, unprocessable
from ..jobs import queue
from ..models import DatasetVersion, Job, Project
from . import PIPELINE_TEST_BANNER, RESEARCH_NOTICE
from .config import HEADS, resolve_params
from .encoders import get_encoder
from .evaluation import threshold_dict
from .models import ModelVersion, TrainingRun

DEFAULT_POSITIVE = "bcc_present"
MODEL_NOTICE = ("Research model candidate. Never deployed automatically and not for clinical use; new uploads or "
                "labels never modify it.")


def create_experiment(db: Session, actor: Actor, project: Project, *, dataset_version_id: str, encoder_id: str,
                      head: str, params: dict | None, seed: int, name: str | None) -> tuple[TrainingRun, Job]:
    dv = db.get(DatasetVersion, dataset_version_id)
    if dv is None or dv.project_id != project.id:
        raise not_found("dataset_version", dataset_version_id)
    if dv.status != "frozen" or not dv.manifest_json:
        raise conflict("dataset_not_frozen", "Experiments use frozen dataset versions only; freeze it first",
                       dataset_version_id=dv.id)
    if head not in HEADS:
        raise unprocessable("invalid_head", f"head must be one of {list(HEADS)}", allowed=list(HEADS))
    encoder = get_encoder(encoder_id)
    if encoder is None:
        raise unprocessable("unknown_encoder", f"Unknown encoder {encoder_id}")
    status, detail = encoder.status()
    if status != "available":
        raise conflict("encoder_unavailable", f"Encoder {encoder_id} is not available ({status})",
                       encoder_id=encoder_id, status=status, status_detail=detail)
    try:
        resolved = resolve_params(params)
    except ValueError as exc:
        raise unprocessable("invalid_params", "Invalid experiment params", errors=exc.args[0]) from exc
    if resolved["pixel_mode"] == "none" and encoder.reads_pixels:
        raise unprocessable("invalid_params", "pixel_mode=none is only valid with an encoder that never reads pixels",
                            errors=[{"loc": ["pixel_mode"], "msg": f"{encoder_id} reads pixels"}])
    if not isinstance(seed, int) or seed < 0 or seed > 2**31 - 1:
        raise unprocessable("invalid_seed", "seed must be an integer in [0, 2^31-1]")
    values = list(dv.config_json.get("label_values") or [])
    if len(values) != 2:
        raise conflict("dataset_not_binary", "The heads are binary; the dataset must have exactly two label values",
                       label_values=values)
    positive = DEFAULT_POSITIVE if DEFAULT_POSITIVE in values else values[0]
    negative = next(v for v in values if v != positive)
    manifest = dv.manifest_json
    reasons = []
    if encoder.synthetic:
        reasons.append("synthetic_encoder: embeddings carry no pathology information")
    if manifest.get("synthetic_only"):
        reasons.append("synthetic_images: procedural tiles with no histology")
    run = TrainingRun(project_id=project.id, name=(name or f"{head} · {encoder_id} · seed {seed}")[:200],
                      dataset_version_id=dv.id, dataset_manifest_sha256=dv.manifest_sha256, encoder_id=encoder_id,
                      head=head, params_json=resolved, seed=seed, status="queued", synthetic=bool(reasons),
                      synthetic_reasons_json=reasons, label_scope=dv.config_json.get("label_scope", "slide"),
                      positive_class=positive, negative_class=negative, created_by=actor.id)
    db.add(run)
    db.flush()
    job, _ = queue.enqueue(db, "train", {"run_id": run.id}, idempotency_key=f"train:{run.id}", project_id=project.id,
                           created_by=actor.id)
    run.job_id = job.id
    audit.record_for(db, actor, project_id=project.id, action="experiment.created", entity_type="training_run",
                     entity_id=run.id, after={"dataset_version_id": dv.id, "manifest_sha256": dv.manifest_sha256,
                                              "encoder_id": encoder_id, "head": head, "seed": seed,
                                              "synthetic": run.synthetic, "job_id": job.id})
    return run, job


def effective_status(run: TrainingRun, job: Job | None) -> str:
    if run.status == "succeeded":
        return "succeeded"
    if job is None:
        return run.status
    if job.status in ("queued", "running", "failed", "canceled"):
        return job.status
    return run.status


def cancel_experiment(db: Session, actor: Actor, run: TrainingRun) -> str:
    job = db.get(Job, run.job_id) if run.job_id else None
    status = effective_status(run, job)
    if status in ("succeeded", "failed", "canceled") or job is None:
        raise conflict("run_finished", f"The run is already {status}", status=status)
    outcome = queue.request_cancel(db, job)
    if outcome == "canceled":
        run.status = "canceled"
        run.error = "canceled before start"
    audit.record_for(db, actor, project_id=run.project_id, action="experiment.cancel_requested",
                     entity_type="training_run", entity_id=run.id, after={"outcome": outcome, "job_id": job.id})
    return outcome


def run_dict(db: Session, run: TrainingRun) -> dict:
    job = db.get(Job, run.job_id) if run.job_id else None
    dv = db.get(DatasetVersion, run.dataset_version_id)
    status = effective_status(run, job)
    mv = db.scalars(select(ModelVersion.id).where(ModelVersion.run_id == run.id)).first()
    if status == "succeeded":
        finished = run.finished_at
    elif status in ("failed", "canceled"):
        finished = (job.finished_at if job is not None else None) or run.finished_at
    else:
        finished = None
    error = None
    if status in ("failed", "canceled", "queued"):  # queued after a retryable failure keeps the last error
        error = (job.error if job is not None else None) or (run.error if status != "queued" else None)
    return {
        "id": run.id,
        "name": run.name,
        "project_id": run.project_id,
        "dataset_version_id": run.dataset_version_id,
        "dataset_name": f"{dv.name} v{dv.version}" if dv else None,
        "dataset_manifest_sha256": run.dataset_manifest_sha256,
        "encoder_id": run.encoder_id,
        "head": run.head,
        "params": run.params_json,
        "seed": run.seed,
        "status": status,
        "job_id": run.job_id,
        "progress": 1.0 if status == "succeeded" else (job.progress if job else 0.0),
        "progress_message": "done" if status == "succeeded" else (job.progress_message if job else None),
        "synthetic": run.synthetic,
        "synthetic_reasons": run.synthetic_reasons_json,
        "banner": PIPELINE_TEST_BANNER if run.synthetic else None,
        "notice": RESEARCH_NOTICE,
        "label_scope": run.label_scope,
        "positive_class": run.positive_class,
        "negative_class": run.negative_class,
        "code_revision": run.code_revision,
        "deps": run.deps_json,
        "weights_sha256": run.weights_sha256,
        "checkpoint": ({"object_key": run.checkpoint_key, "sha256": run.checkpoint_sha256,
                        "bytes": run.checkpoint_bytes, "format": "npz (deterministic)"}
                       if run.checkpoint_key and status == "succeeded" else None),
        "threshold": threshold_dict(run) if status == "succeeded" else None,
        "split_counts": run.split_counts_json,
        "training_summary": (run.metrics_json or {}).get("training") if status == "succeeded" else None,
        "feature_summary": (run.metrics_json or {}).get("features") if status == "succeeded" else None,
        "timings_seconds": (run.metrics_json or {}).get("timings_seconds") if status == "succeeded" else None,
        "val_summary": (run.metrics_json or {}).get("val_summary") if status == "succeeded" else None,
        "unscored_bags": (run.metrics_json or {}).get("unscored_bags") if status == "succeeded" else None,
        "test_evaluation_requires": "research_lead, after the threshold is frozen on validation (audited)",
        "created_by": run.created_by,
        "created_at": run.created_at.isoformat(),
        "started_at": run.started_at.isoformat() if run.started_at else None,
        "finished_at": finished.isoformat() if finished else None,
        "error": error,
        "registered_model_id": mv,
    }


def model_dict(mv: ModelVersion) -> dict:
    return {"id": mv.id, "run_id": mv.run_id, "project_id": mv.project_id, "status": mv.status,
            "created_by": mv.created_by, "created_at": mv.created_at.isoformat(), "synthetic": mv.synthetic,
            "banner": PIPELINE_TEST_BANNER if mv.synthetic else None, "checkpoint_sha256": mv.checkpoint_sha256,
            "deployed": False, "note": mv.note, "notice": MODEL_NOTICE}


def register_model(db: Session, actor: Actor, run: TrainingRun, note: str | None = None) -> tuple[ModelVersion, bool]:
    existing = db.scalars(select(ModelVersion).where(ModelVersion.run_id == run.id)).first()
    if existing is not None:
        return existing, False
    if run.status != "succeeded" or not run.checkpoint_sha256:
        raise conflict("run_not_succeeded", "Only a finished run with a checkpoint can be registered",
                       status=run.status)
    mv = ModelVersion(project_id=run.project_id, run_id=run.id, status="research_candidate", synthetic=run.synthetic,
                      checkpoint_sha256=run.checkpoint_sha256, note=note, created_by=actor.id)
    db.add(mv)
    db.flush()
    audit.record_for(db, actor, project_id=run.project_id, action="model.registered", entity_type="model_version",
                     entity_id=mv.id, after={"run_id": run.id, "status": mv.status, "synthetic": mv.synthetic,
                                             "checkpoint_sha256": mv.checkpoint_sha256, "deployed": False})
    return mv, True

