"""ML routes (docs/ml-api-contract.md). Mounted under /api/v1 by dermpath.main.

Permissions: ``experiment.read`` (reads), ``experiment.write`` (create, cancel, active
learning, feature extraction, comparison families, inference), ``model.register``; the TEST split
needs ``dataset.test_access`` (research lead): test metrics exist only through a recorded test
release (``POST /experiments/{id}/test-release``), and GET routes only read stored results.
"""

from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, Depends, Query, Response
from pydantic import Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import audit
from ..auth import Actor, Scope, authorize, current_actor, entity_scope, project_scope, role_has
from ..db import get_db
from ..errors import ApiError, conflict, not_found, unprocessable
from ..jobs import queue
from ..models import DatasetVersion, Job, Slide
from ..schemas import Req
from . import PIPELINE_TEST_BANNER
from .active_learning import batch_dict, request_batch
from .config import resolve_params
from .encoders import EncoderUnavailable, get_encoder, list_encoders
from .engine_models import ComparisonFamily, InferenceBundle, InferencePrediction, TestRelease
from .evaluation import (
    add_family_member,
    attention_response,
    create_family,
    create_test_release,
    errors_response,
    evaluation_response,
    family_dict,
    family_run_ids,
    lock_family,
    prediction_for_slide,
    require_test_unlocked,
    stored_evaluation,
    stored_test_evaluation,
    test_release_dict,
    test_release_status,
)
from .features import artifact_dict, legacy_refusal
from .inference import (
    build_bundle,
    bundle_dict,
    current_prediction,
    prediction_dict,
    request_inference,
    test_material_reason,
)
from .models import FeatureArtifact, ModelVersion, TrainingRun
from .review_priority import review_priorities
from .service import cancel_experiment, create_experiment, model_dict, register_model, run_dict

router = APIRouter(tags=["ml"])

SPLIT_PATTERN = "^(val|oof|test)$"


class ExperimentIn(Req):
    dataset_version_id: str
    encoder_id: str
    head: str
    params: dict[str, Any] | None = None
    seed: int
    name: str | None = Field(None, max_length=200)
    # Engine fields (design §6); omitted fields keep the service defaults.
    execution_mode: Literal["synthetic_pipeline_test", "real_image_technical", "supervised_experiment"] | None = None
    feature_set_id: str | None = Field(None, max_length=32)
    evaluation_protocol: Literal["holdout", "dev_cv"] | None = None
    family_id: str | None = Field(None, max_length=32)


class RegisterIn(Req):
    note: str | None = Field(None, max_length=2000)


class ActiveLearningIn(Req):
    run_id: str
    dataset_version_id: str | None = None
    k: int = Field(10, ge=1, le=500)
    random_fraction: float = Field(0.2, ge=0.0, le=1.0)
    uncertainty_fraction: float = Field(0.5, ge=0.0, le=1.0)
    seed: int | None = Field(None, ge=0, le=2**31 - 1)


class FeaturesIn(Req):
    encoder_id: str
    params: dict[str, Any] | None = None
    seed: int = Field(0, ge=0, le=2**31 - 1)


class TestReleaseIn(Req):
    __test__ = False  # not a pytest class

    reason: str = Field(..., max_length=4000)
    justification: str | None = Field(None, max_length=4000)
    candidate: Literal["bundle", "family"] | None = None


class InferIn(Req):
    slide_id: str


class FamilyIn(Req):
    name: str = Field(..., min_length=1, max_length=200)
    dataset_version_id: str
    plan: dict[str, Any] | None = None
    bootstrap_seed: int = Field(0, ge=0, le=2**31 - 1)


class FamilyMemberIn(Req):
    run_id: str
    role: str | None = Field(None, max_length=24)


class ReasonIn(Req):
    reason: str = Field(..., max_length=4000)


def _engine_error_types() -> tuple[type, ...]:
    """Exceptions the engine service may raise that are not already API errors (mapped to 409)."""
    from . import feature_sets as fsm

    names = ("ModeMismatch", "FeatureSetNotReady", "FeatureSetIntegrityError")
    return tuple(c for c in (getattr(fsm, n, None) for n in names) if isinstance(c, type))


def _engine_error(exc: Exception):
    code = {"ModeMismatch": "mode_mismatch", "FeatureSetNotReady": "feature_set_not_ready",
            "FeatureSetIntegrityError": "feature_set_integrity"}.get(type(exc).__name__, "engine_error")
    return conflict(code, str(exc))


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
    engine = {k: v for k, v in (("execution_mode", body.execution_mode), ("feature_set_id", body.feature_set_id),
                                ("evaluation_protocol", body.evaluation_protocol), ("family_id", body.family_id))
              if v is not None}
    if body.family_id is not None:
        fam = db.get(ComparisonFamily, body.family_id)
        if fam is None or fam.project_id != scope.project_id:
            raise not_found("comparison_family", body.family_id)
    errors = _engine_error_types()
    try:
        run, job = create_experiment(db, scope.actor, scope.obj, dataset_version_id=body.dataset_version_id,
                                     encoder_id=body.encoder_id, head=body.head, params=body.params, seed=body.seed,
                                     name=body.name, **engine)
    except errors as exc:
        if isinstance(exc, ApiError):  # already a 409 with its details (e.g. mode_mismatch)
            raise
        raise _engine_error(exc) from exc
    except EncoderUnavailable as exc:
        raise conflict("encoder_unavailable", str(exc), encoder_id=body.encoder_id) from exc
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


def _audit_test_read(db: Session, actor, run: TrainingRun, what: str, ev) -> None:
    """The only write of a test GET: an access record for a stored result (never a computation)."""
    audit.record_for(db, actor, project_id=run.project_id, action="experiment.test_accessed",
                     entity_type="training_run", entity_id=run.id,
                     after={"what": what, "evaluation_id": ev.id,
                            "test_release_id": (ev.metrics_json or {}).get("test_release_id")})
    db.commit()


@router.get("/experiments/{id}/evaluation")
def evaluation(split: str = Query("val", pattern=SPLIT_PATTERN),
               scope: Scope = Depends(entity_scope("experiment.read", TrainingRun, entity_name="experiment")),
               db: Session = Depends(get_db)):
    run = scope.obj
    if split == "test":
        _test_gate(db, scope, run)
        ev = stored_test_evaluation(db, run)  # 409 test_release_required / pending / failed; never computes
        _audit_test_read(db, scope.actor, run, "evaluation", ev)
        return evaluation_response(ev, run)
    ev = stored_evaluation(db, run.id, split)
    if ev is None:
        raise conflict("evaluation_not_ready", f"The {split} evaluation exists once the run has succeeded "
                       f"({'out-of-fold under dev_cv' if split == 'oof' else 'validation under holdout'})",
                       run_status=run_dict(db, run)["status"], evaluation_protocol=run.evaluation_protocol)
    return evaluation_response(ev, run)


@router.get("/experiments/{id}/errors")
def errors(split: str = Query("val", pattern=SPLIT_PATTERN),
           scope: Scope = Depends(entity_scope("experiment.read", TrainingRun, entity_name="experiment")),
           db: Session = Depends(get_db)):
    run = scope.obj
    if split == "test":
        _test_gate(db, scope, run)
        ev = stored_test_evaluation(db, run)
        out = errors_response(db, run, split)
        _audit_test_read(db, scope.actor, run, "errors", ev)
        return out
    if stored_evaluation(db, run.id, split) is None:
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
        ev = stored_test_evaluation(db, run)
        out = attention_response(run, p, slide_id)  # may refuse (409): then nothing is recorded
        _audit_test_read(db, scope.actor, run, f"attention:{slide_id}", ev)
        return out
    return attention_response(run, p, slide_id)


# --------------------------------------------------------------------------- test releases


@router.post("/experiments/{id}/test-release", status_code=202)
def post_test_release(body: TestReleaseIn,
                      scope: Scope = Depends(entity_scope("dataset.test_access", TrainingRun,
                                                          entity_name="experiment")),
                      db: Session = Depends(get_db)):
    """Record a test release (research lead, reason, declared candidate); seals the split family's test
    patients and enqueues ``evaluate_test_release`` (scores pinned feature-set artifacts only)."""
    rel, job = create_test_release(db, scope.actor, scope.obj, reason=body.reason, justification=body.justification,
                                   candidate=body.candidate)
    db.commit()
    return {"test_release": test_release_dict(db, rel), "job_id": job.id, "status": job.status}


@router.get("/experiments/{id}/test-release")
def get_test_release(scope: Scope = Depends(entity_scope("experiment.read", TrainingRun, entity_name="experiment")),
                     db: Session = Depends(get_db)):
    """What a test release of this run needs and which releases exist. Read-only, no test metrics."""
    return test_release_status(db, scope.obj, actor_role=scope.actor.role)


@router.get("/test-releases/{id}")
def get_release(scope: Scope = Depends(entity_scope("experiment.read", TestRelease, entity_name="test_release")),
                db: Session = Depends(get_db)):
    return test_release_dict(db, scope.obj)


@router.get("/projects/{pid}/test-releases")
def list_releases(scope: Scope = Depends(project_scope("experiment.read")), db: Session = Depends(get_db)):
    rows = db.scalars(select(TestRelease).where(TestRelease.project_id == scope.project_id)
                      .order_by(TestRelease.released_at, TestRelease.release_number)).all()
    return {"items": [test_release_dict(db, r) for r in rows]}


# --------------------------------------------------------------------------- registry and bundles


@router.post("/experiments/{id}/register")
def register(response: Response, body: RegisterIn | None = None,
             scope: Scope = Depends(entity_scope("model.register", TrainingRun, entity_name="experiment")),
             db: Session = Depends(get_db)):
    """Register a research candidate and build its immutable inference bundle. Idempotent per run.
    Nothing is ever deployed."""
    mv, created = register_model(db, scope.actor, scope.obj, note=body.note if body else None)
    bundle, b_created, unavailable = build_bundle(db, scope.actor, scope.obj)
    db.commit()
    response.status_code = 201 if (created or b_created) else 200
    return {**model_dict(mv), "bundle_id": bundle.id if bundle else None,
            "bundle": bundle_dict(db, bundle) if bundle else None, "bundle_unavailable_reason": unavailable}


@router.get("/projects/{pid}/models")
def models(scope: Scope = Depends(project_scope("experiment.read")), db: Session = Depends(get_db)):
    rows = db.scalars(select(ModelVersion).where(ModelVersion.project_id == scope.project_id)
                      .order_by(ModelVersion.created_at.desc())).all()
    bundles = {b.run_id: b.id for b in db.scalars(select(InferenceBundle).where(
        InferenceBundle.project_id == scope.project_id)).all()}
    return {"items": [{**model_dict(m), "bundle_id": bundles.get(m.run_id)} for m in rows],
            "note": "Research candidates only; there is no deployment path in this workbench."}


@router.get("/projects/{pid}/bundles")
def list_bundles(scope: Scope = Depends(project_scope("experiment.read")), db: Session = Depends(get_db)):
    rows = db.scalars(select(InferenceBundle).where(InferenceBundle.project_id == scope.project_id)
                      .order_by(InferenceBundle.created_at.desc())).all()
    return {"items": [bundle_dict(db, b, verify_object=False) for b in rows]}


@router.get("/bundles/{id}")
def get_bundle(scope: Scope = Depends(entity_scope("experiment.read", InferenceBundle, entity_name="bundle")),
               db: Session = Depends(get_db)):
    return bundle_dict(db, scope.obj)


@router.post("/bundles/{id}/infer", status_code=202)
def infer(body: InferIn, scope: Scope = Depends(entity_scope("experiment.write", InferenceBundle,
                                                             entity_name="bundle")),
          db: Session = Depends(get_db)):
    """Enqueue label-free research inference of this bundle on one slide (``infer_slide``): one job per (bundle,
    slide, current input identity). ``prediction`` is the stored prediction for the slide's CURRENT input snapshot
    (null when the input changed since the last one, or for rows recorded without input-snapshot provenance).
    The job returned always answers the current input identity (a job that scored another identity, failed or was
    canceled is followed by a new one). A stored prediction whose slide image or mask object no longer matches its
    snapshot (replaced in place) is refused (409 ``input_changed``). A bundle trained on case bags is refused (409
    ``scope_mismatch``)."""
    b = scope.obj
    job, _ = request_inference(db, scope.actor, b, body.slide_id)
    current, snapshot_sha = current_prediction(db, b, body.slide_id)
    n_rows = len(db.scalars(select(InferencePrediction.id).where(
        InferencePrediction.bundle_id == b.id, InferencePrediction.slide_id == body.slide_id)).all())
    db.commit()
    return {"job_id": job.id, "status": job.status, "bundle_id": b.id, "slide_id": body.slide_id,
            "input_snapshot_sha256": snapshot_sha,
            "prediction": prediction_dict(current, b.content_json) if current else None,
            "other_predictions_for_slide": n_rows - (1 if current else 0), "research_use_only": True}


@router.get("/bundles/{id}/predictions")
def bundle_predictions(scope: Scope = Depends(entity_scope("experiment.read", InferenceBundle, entity_name="bundle")),
                       db: Session = Depends(get_db)):
    """Stored research predictions of the bundle. Predictions of TEST material (test items or patients of the run's
    manifest, sealed patients or slides) are test results: they are listed only for ``dataset.test_access`` (the
    research lead), with one ``experiment.test_accessed`` audit row; other roles see how many were withheld."""
    b = scope.obj
    rows = db.scalars(select(InferencePrediction).where(InferencePrediction.bundle_id == b.id)
                      .order_by(InferencePrediction.created_at, InferencePrediction.id)).all()
    run = db.get(TrainingRun, b.run_id)
    test_rows, cache = set(), {}
    for p in rows:
        slide = db.get(Slide, p.slide_id)
        if slide is not None and test_material_reason(db, run, slide, cache=cache) is not None:
            test_rows.add(p.id)
    can_read_test = role_has(scope.actor.role, "dataset.test_access")
    shown = [p for p in rows if p.id not in test_rows or can_read_test]
    if test_rows and can_read_test:
        audit.record_for(db, scope.actor, project_id=b.project_id, action="experiment.test_accessed",
                         entity_type="training_run", entity_id=b.run_id,
                         after={"what": f"bundle_predictions:{b.id}", "slide_ids": sorted(
                             p.slide_id for p in rows if p.id in test_rows)})
        db.commit()
    return {"bundle_id": b.id, "items": [prediction_dict(p, b.content_json) for p in shown],
            "withheld_test_predictions": 0 if can_read_test else len(test_rows),
            "notice": "Research outputs only: never labels, never diagnoses, never routed to care."}


# --------------------------------------------------------------------------- active learning


def _al_job(db: Session, raw_id: str) -> Job | None:
    return db.scalars(select(Job).where(Job.idempotency_key == f"al:{raw_id}")).first()


@router.post("/projects/{pid}/active-learning", status_code=202)
def active_learning(body: ActiveLearningIn, scope: Scope = Depends(project_scope("experiment.write")),
                    db: Session = Depends(get_db)):
    """Enqueue an active-learning batch: development-eligible pool, scored out-of-sample through the run's
    bundle, persisted as proposals. Never creates labels."""
    run = db.get(TrainingRun, body.run_id)
    if run is None or run.project_id != scope.project_id:
        raise not_found("experiment", body.run_id)
    if run.status != "succeeded":
        raise conflict("run_not_succeeded", "Active learning needs a finished run", status=run.status)
    dv_id = body.dataset_version_id or run.dataset_version_id
    dv = db.get(DatasetVersion, dv_id)
    if dv is None or dv.project_id != scope.project_id:
        raise not_found("dataset_version", dv_id)
    if dv.status != "frozen":
        raise conflict("dataset_not_frozen", "Active learning uses frozen dataset versions")
    if dv.id != run.dataset_version_id:
        raise conflict("dataset_mismatch", "Proposals use the run's own frozen dataset version (its split family)",
                       run_dataset_version_id=run.dataset_version_id)
    out = request_batch(db, scope.actor, run, dv, k=body.k, random_fraction=body.random_fraction,
                        uncertainty_fraction=body.uncertainty_fraction, seed=body.seed)
    db.commit()
    return out


@router.get("/active-learning/batches/{id}")
def active_learning_batch(scope: Scope = Depends(entity_scope("experiment.read", _al_job,
                                                              entity_name="active_learning_batch")),
                          db: Session = Depends(get_db)):
    return batch_dict(db, scope.obj)


@router.get("/projects/{pid}/active-learning")
def active_learning_batches(run_id: str | None = None, scope: Scope = Depends(project_scope("experiment.read")),
                            db: Session = Depends(get_db)):
    jobs = db.scalars(select(Job).where(Job.project_id == scope.project_id, Job.type == "active_learning")
                      .order_by(Job.created_at.desc())).all()
    if run_id:
        jobs = [j for j in jobs if (j.payload_json or {}).get("run_id") == run_id]
    return {"items": [batch_dict(db, j) for j in jobs]}


# --------------------------------------------------------------------------- review priorities


@router.get("/projects/{pid}/review-priorities")
def get_review_priorities(run_id: str | None = None, limit: int = Query(200, ge=1, le=2000),
                          scope: Scope = Depends(project_scope("experiment.read")), db: Session = Depends(get_db)):
    """Expert disagreements and model-vs-reference discordances on development data, ranked for human
    review. Read-only: nothing is resolved automatically."""
    if run_id is not None:
        run = db.get(TrainingRun, run_id)
        if run is None or run.project_id != scope.project_id:
            raise not_found("experiment", run_id)
    return review_priorities(db, scope.project_id, run_id=run_id, limit=limit)


# --------------------------------------------------------------------------- comparison families


@router.post("/projects/{pid}/comparison-families", status_code=201)
def post_family(body: FamilyIn, scope: Scope = Depends(project_scope("experiment.write")),
                db: Session = Depends(get_db)):
    fam = create_family(db, scope.actor, scope.obj, name=body.name, dataset_version_id=body.dataset_version_id,
                        plan=body.plan, bootstrap_seed=body.bootstrap_seed)
    db.commit()
    return family_dict(db, fam, actor_role=scope.actor.role, with_comparison=False)


@router.get("/projects/{pid}/comparison-families")
def list_families(scope: Scope = Depends(project_scope("experiment.read")), db: Session = Depends(get_db)):
    rows = db.scalars(select(ComparisonFamily).where(ComparisonFamily.project_id == scope.project_id)
                      .order_by(ComparisonFamily.created_at.desc())).all()
    return {"items": [family_dict(db, f, with_comparison=False) for f in rows]}


@router.get("/comparison-families/{id}")
def get_family(n_boot: int | None = Query(None, ge=0, le=5000),
               scope: Scope = Depends(entity_scope("experiment.read", ComparisonFamily,
                                                   entity_name="comparison_family")),
               db: Session = Depends(get_db)):
    """The family with paired comparisons from stored development predictions (test only after a family
    test release, research lead only). Returning the TEST comparison is a read of stored test results: one
    ``experiment.test_accessed`` audit row per member run, like GET evaluation?split=test."""
    out = family_dict(db, scope.obj, actor_role=scope.actor.role, n_boot=n_boot)
    if (out.get("test_comparison") or {}).get("status") == "ok":
        for rid in family_run_ids(db, scope.obj):
            run = db.get(TrainingRun, rid)
            ev = stored_evaluation(db, rid, "test") if run is not None else None
            if ev is not None:
                _audit_test_read(db, scope.actor, run, f"comparison_family:{scope.obj.id}:test_comparison", ev)
    return out


@router.post("/comparison-families/{id}/members")
def post_family_member(body: FamilyMemberIn, response: Response,
                       scope: Scope = Depends(entity_scope("experiment.write", ComparisonFamily,
                                                           entity_name="comparison_family")),
                       db: Session = Depends(get_db)):
    run = db.get(TrainingRun, body.run_id)
    if run is None or run.project_id != scope.obj.project_id:
        raise not_found("experiment", body.run_id)
    created = add_family_member(db, scope.actor, scope.obj, run, body.role)
    db.commit()
    response.status_code = 201 if created else 200
    return family_dict(db, scope.obj, actor_role=scope.actor.role, with_comparison=False)


@router.post("/comparison-families/{id}/lock")
def post_family_lock(body: ReasonIn,
                     scope: Scope = Depends(entity_scope("experiment.write", ComparisonFamily,
                                                         entity_name="comparison_family")),
                     db: Session = Depends(get_db)):
    """Lock the family (research lead, reason): its members become the declared test-release candidate."""
    fam = lock_family(db, scope.actor, scope.obj, body.reason)
    db.commit()
    return family_dict(db, fam, actor_role=scope.actor.role, with_comparison=False)


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
    refusal = legacy_refusal(slide, encoder, params)
    if refusal is not None:
        code, message = refusal
        if code == "mode_mismatch":
            raise conflict(code, message, encoder_id=encoder.id, provenance=slide.provenance,
                           image_kind=slide.image_kind)
        raise unprocessable(code, message, reason="would_upsample")
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
