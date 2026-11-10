"""Experiment creation, cancellation, registry and serialisers (shared by the router and the seed)."""

from __future__ import annotations

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .. import audit
from ..auth import Actor
from ..datasets import manifest_acquisition_snapshot
from ..errors import ApiError, conflict, not_found, unprocessable
from ..jobs import queue
from ..models import DatasetVersion, Job, Project
from . import PIPELINE_TEST_BANNER, RESEARCH_NOTICE
from .artifacts import dependency_versions
from .config import EVALUATION_PROTOCOLS, HEADS, feature_params, resolve_experiment_params
from .encoders import EncoderUnavailable, get_encoder
from .engine_models import (
    EXECUTION_MODES,
    ComparisonFamily,
    ComparisonFamilyMember,
    FeatureSet,
    FeatureSetItem,
    RunAttempt,
)
from .evaluation import reference_standard_fields, threshold_dict
from .models import ModelVersion, TrainingRun
from .training import (
    FOLD_UNSAFE_CODE,
    compute_run_identity,
    derive_synthetic,
    identity_sha256,
    infer_execution_mode,
    manifest_data_mode,
    manifest_digest,
    manifest_split_fingerprint,
    mode_problems,
    preprocessing_fold_safety,
    run_preprocessing_validity,
)

DEFAULT_POSITIVE = "bcc_present"
MODEL_NOTICE = ("Research model candidate. Never deployed automatically and not for clinical use; new uploads or "
                "labels never modify it.")


def _feature_set_error(exc: Exception) -> Exception:
    """Map a feature-set refusal to the API error the experiment endpoint returns."""
    from . import feature_sets as fsets

    if isinstance(exc, ApiError):
        return exc
    mode_mismatch = getattr(fsets, "ModeMismatch", None)
    if mode_mismatch is not None and isinstance(exc, mode_mismatch):
        return conflict("mode_mismatch", str(exc), **(getattr(exc, "details", None) or {}))
    if isinstance(exc, EncoderUnavailable):
        return conflict("encoder_unavailable", str(exc), encoder_id=exc.encoder_id, status=exc.status)
    if isinstance(exc, ValueError):
        return unprocessable("invalid_params", str(exc), errors=[{"loc": [], "msg": str(exc)}])
    return exc


def _refuse_fold_unsafe(safety: dict, *, protocol: str, params: dict) -> None:
    """409 ``fold_unsafe_preprocessing`` (owner's brief item 3): learned preprocessing not fitted on each model's
    permitted fitting patients only. The worker refuses the same run again."""
    if safety.get("status") != "fold_unsafe":
        return
    raise conflict(FOLD_UNSAFE_CODE,
                   "The feature set's learned preprocessing (a stain reference fitted once on the dataset's train "
                   "split) is not fold-safe for this protocol",
                   evaluation_protocol=protocol, stain_normalization=params.get("stain_normalization"),
                   train_patient_fraction=params.get("train_patient_fraction"), provenance=safety.get("provenance"),
                   problems=safety.get("problems") or [], remedy=safety.get("remedy"))


def _dev_patients(manifest: dict) -> int:
    return len({s["coded_patient_id"] for s in manifest.get("splits") or [] if s.get("split") in ("train", "val")})


def resolve_feature_set(db: Session, actor: Actor, project: Project, dv: DatasetVersion, *, encoder_id: str,
                        execution_mode: str, params: dict, feature_set_id: str | None):
    """The run's feature set: the given one (checked against the run), or the one
    ``feature_sets.create_feature_set`` returns for these params (idempotent: an existing set
    with the same specification is reused)."""
    from . import feature_sets as fsets

    if feature_set_id is None:
        try:
            return fsets.create_feature_set(db, actor, project, encoder_id=encoder_id, execution_mode=execution_mode,
                                            dataset_version_id=dv.id, params=feature_params(params))
        except Exception as exc:  # noqa: BLE001 - mapped to the API error, or re-raised
            raise _feature_set_error(exc) from exc
    fs = db.get(FeatureSet, feature_set_id)
    if fs is None or fs.project_id != project.id:
        raise not_found("feature_set", feature_set_id)
    problems = []
    if fs.encoder_id != encoder_id:
        problems.append(f"feature set encoder {fs.encoder_id} != {encoder_id}")
    if fs.execution_mode != execution_mode:
        problems.append(f"feature set mode {fs.execution_mode} != {execution_mode}")
    if fs.dataset_version_id not in (None, dv.id):
        problems.append("the feature set was built for another dataset version")
    built = set(db.scalars(select(FeatureSetItem.slide_id).where(FeatureSetItem.feature_set_id == fs.id)).all())
    missing = sorted({it["slide_id"] for it in dv.manifest_json["items"]} - built)
    if missing:
        problems.append(f"{len(missing)} dataset slide(s) are not in the feature set")
    spec = get_encoder(encoder_id).spec
    policies = getattr(fsets, "policies_from_params", None)
    if policies is not None:
        try:
            patch_policy = policies(feature_params(params), spec, execution_mode)[0]
            if patch_policy.policy_sha256 != fs.policy_sha256:
                problems.append("the experiment params give a different patch/sampling policy than the feature set")
        except Exception as exc:  # noqa: BLE001
            raise _feature_set_error(exc) from exc
    stain = (fs.stain_policy_json or {}).get("method", "none")
    if stain != params.get("stain_normalization", "none"):
        problems.append(f"stain normalisation: feature set {stain}, params {params.get('stain_normalization')}")
    enc_json = fs.encoder_spec_json or {}
    pixel_mode = (enc_json.get("extraction") or {}).get("pixel_mode")
    if pixel_mode is not None and pixel_mode != params.get("pixel_mode", "read"):
        problems.append(f"pixel_mode: feature set {pixel_mode}, params {params.get('pixel_mode')}")
    if spec is not None and spec.synthetic:
        from .fixture import synthetic_config

        if enc_json.get("encoder_config") not in (None, synthetic_config(params)):
            problems.append("the synthetic fixture configuration differs from the feature set's")
    if problems:
        raise conflict("feature_set_mismatch", "The feature set does not match this experiment",
                       feature_set_id=fs.id, problems=problems)
    return fs


def _check_family(db: Session, project: Project, dv: DatasetVersion, family_id: str | None) -> ComparisonFamily | None:
    if family_id is None:
        return None
    fam = db.get(ComparisonFamily, family_id)
    if fam is None or fam.project_id != project.id:
        raise not_found("comparison_family", family_id)
    if fam.status != "open":
        raise conflict("family_locked", "Runs can join a comparison family only while it is open",
                       family_id=fam.id, status=fam.status)
    if fam.dataset_version_id != dv.id or fam.dataset_manifest_sha256 != dv.manifest_sha256:
        raise conflict("family_manifest_mismatch", "A comparison family holds runs on ONE frozen manifest",
                       family_id=fam.id, family_manifest_sha256=fam.dataset_manifest_sha256,
                       manifest_sha256=dv.manifest_sha256)
    fp = manifest_split_fingerprint(dv.manifest_json)
    if fam.split_fingerprint and fam.split_fingerprint != fp:
        raise conflict("family_manifest_mismatch", "The family's split fingerprint differs from this dataset's",
                       family_id=fam.id)
    return fam


def create_experiment(db: Session, actor: Actor, project: Project, *, dataset_version_id: str, encoder_id: str,
                      head: str, params: dict | None, seed: int, name: str | None,
                      execution_mode: str | None = None, feature_set_id: str | None = None,
                      evaluation_protocol: str | None = None, family_id: str | None = None,
                      family_role: str | None = None) -> tuple[TrainingRun, Job]:
    """Validate, resolve the feature set and freeze the run identity at INSERT (design §1, §6).

    ``execution_mode`` is inferred when absent (synthetic encoder: ``synthetic_pipeline_test``,
    otherwise ``supervised_experiment``) and checked against the encoder and the manifest's
    ``data_mode`` (``409 mode_mismatch``); the worker checks again. Threshold rule, calibration
    and abstention come from ``params``."""
    dv = db.get(DatasetVersion, dataset_version_id)
    if dv is None or dv.project_id != project.id:
        raise not_found("dataset_version", dataset_version_id)
    if dv.status != "frozen" or not dv.manifest_json:
        raise conflict("dataset_not_frozen", "Experiments use frozen dataset versions only; freeze it first",
                       dataset_version_id=dv.id)
    if head not in HEADS:
        raise unprocessable("invalid_head", f"head must be one of {list(HEADS)}", allowed=list(HEADS))
    protocol = evaluation_protocol or "holdout"
    if protocol not in EVALUATION_PROTOCOLS:
        raise unprocessable("invalid_protocol", f"evaluation_protocol must be one of {list(EVALUATION_PROTOCOLS)}",
                            allowed=list(EVALUATION_PROTOCOLS))
    encoder = get_encoder(encoder_id)
    if encoder is None:
        raise unprocessable("unknown_encoder", f"Unknown encoder {encoder_id}")
    status, detail = encoder.status()
    if status != "available":
        raise conflict("encoder_unavailable", f"Encoder {encoder_id} is not available ({status})",
                       encoder_id=encoder_id, status=status, status_detail=detail)
    spec = encoder.spec if encoder.spec is not None else encoder
    try:
        resolved = resolve_experiment_params(params, encoder_spec=spec)
    except ValueError as exc:
        raise unprocessable("invalid_params", "Invalid experiment params", errors=exc.args[0]) from exc
    if not isinstance(seed, int) or isinstance(seed, bool) or seed < 0 or seed > 2**31 - 1:
        raise unprocessable("invalid_seed", "seed must be an integer in [0, 2^31-1]")
    values = list(dv.config_json.get("label_values") or [])
    if len(values) != 2:
        raise conflict("dataset_not_binary", "The heads are binary; the dataset must have exactly two label values",
                       label_values=values)
    positive = DEFAULT_POSITIVE if DEFAULT_POSITIVE in values else values[0]
    negative = next(v for v in values if v != positive)
    manifest = dv.manifest_json
    if manifest_digest(manifest) != dv.manifest_sha256:
        raise conflict("manifest_integrity", "The frozen manifest no longer matches its recorded sha256",
                       dataset_version_id=dv.id)
    data_mode = manifest_data_mode(manifest)
    mode = execution_mode or infer_execution_mode(spec)
    if mode not in EXECUTION_MODES:
        raise unprocessable("invalid_execution_mode", f"execution_mode must be one of {list(EXECUTION_MODES)}",
                            allowed=list(EXECUTION_MODES))
    problems = mode_problems(spec, data_mode, mode)
    if problems:
        raise conflict("mode_mismatch", "The encoder, the execution mode and the dataset are incompatible",
                       execution_mode=mode, data_mode=data_mode, encoder_id=encoder_id, problems=problems)
    if protocol == "dev_cv" and _dev_patients(manifest) < int(resolved["cv_folds"]):
        raise conflict("cv_infeasible", f"dev_cv with {resolved['cv_folds']} folds needs at least as many "
                       "development (train + val) patients", development_patients=_dev_patients(manifest))
    # Refused before any feature set or run is recorded: the declared stain plan is enough to know (only the
    # dataset-fitted macenko-v1 reference exists). Checked again on the resolved feature set below and in the worker.
    if resolved.get("stain_normalization", "none") != "none":
        _refuse_fold_unsafe(preprocessing_fold_safety({"method": resolved["stain_normalization"], "deferred": True},
                                                      protocol=protocol, params=resolved),
                            protocol=protocol, params=resolved)
    synthetic, reasons = derive_synthetic(spec, data_mode)
    family = _check_family(db, project, dv, family_id)
    fs = resolve_feature_set(db, actor, project, dv, encoder_id=encoder_id, execution_mode=mode, params=resolved,
                             feature_set_id=feature_set_id)
    _refuse_fold_unsafe(preprocessing_fold_safety(fs.stain_policy_json, protocol=protocol, params=resolved,
                                                  manifest=manifest), protocol=protocol, params=resolved)
    label_scope = dv.config_json.get("label_scope", "slide")
    identity = compute_run_identity(encoder=encoder, feature_set=fs, manifest=manifest, dataset_version_id=dv.id,
                                    params=resolved, seed=seed, head=head, execution_mode=mode,
                                    evaluation_protocol=protocol, label_scope=label_scope, positive_class=positive,
                                    negative_class=negative, synthetic=synthetic)
    run = TrainingRun(project_id=project.id, name=(name or f"{head} · {encoder_id} · seed {seed}")[:200],
                      dataset_version_id=dv.id, dataset_manifest_sha256=dv.manifest_sha256, encoder_id=encoder_id,
                      head=head, params_json=resolved, seed=seed, status="queued", synthetic=synthetic,
                      synthetic_reasons_json=reasons, label_scope=label_scope, positive_class=positive,
                      negative_class=negative, execution_mode=mode, feature_set_id=fs.id,
                      evaluation_protocol=protocol, identity_json=identity, identity_sha256=identity_sha256(identity),
                      family_id=family.id if family else None, weights_sha256=fs.weights_sha256,
                      code_revision=identity["code_revision"], deps_json=dependency_versions(),
                      created_by=actor.id)
    # Model-selected (active-learning-exposed) patients of the manifest at creation: the worker reports their
    # held-out (val / out-of-fold) predictions apart from the representative estimate and never selects the
    # operating point or calibration on them (it adds any exposure recorded since; exposure only grows).
    acquisition = manifest_acquisition_snapshot(db, project.id, manifest)
    run.provenance_json = {"acquisition_exposure_at_creation": acquisition}
    db.add(run)
    db.flush()
    if family is not None:
        db.add(ComparisonFamilyMember(family_id=family.id, project_id=project.id, run_id=run.id, role=family_role,
                                      created_by=actor.id))
        db.flush()
    job, _ = queue.enqueue(db, "train", {"run_id": run.id}, idempotency_key=f"train:{run.id}", project_id=project.id,
                           created_by=actor.id)
    run.job_id = job.id
    audit.record_for(db, actor, project_id=project.id, action="experiment.created", entity_type="training_run",
                     entity_id=run.id, after={"dataset_version_id": dv.id, "manifest_sha256": dv.manifest_sha256,
                                              "encoder_id": encoder_id, "head": head, "seed": seed,
                                              "synthetic": run.synthetic, "job_id": job.id, "execution_mode": mode,
                                              "evaluation_protocol": protocol, "feature_set_id": fs.id,
                                              "identity_sha256": run.identity_sha256,
                                              "family_id": run.family_id,
                                              "model_selected_patients": acquisition["per_split"]})
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
    metrics = (run.metrics_json or {}) if status == "succeeded" else {}
    attempts = db.scalar(select(func.count(RunAttempt.id)).where(RunAttempt.run_id == run.id)) or 0
    # Development metrics are measured against the manifest's labels: an imported reference standard is stated with
    # them (top level and inside each development summary), as on every other result surface.
    standard = reference_standard_fields(dv.manifest_json if dv is not None else None)

    def _summary(key: str):
        summ = metrics.get(key)
        return {**summ, **standard} if isinstance(summ, dict) else summ

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
        "val_summary": _summary("val_summary"),
        "oof_summary": _summary("oof_summary"),
        **standard,
        "unscored_bags": metrics.get("unscored_bags") if status == "succeeded" else None,
        "effective_sampling": metrics.get("effective_sampling"),
        "protocol_summary": metrics.get("protocol"),
        "operating_point": metrics.get("operating_point"),
        "execution_mode": run.execution_mode,
        "evaluation_protocol": run.evaluation_protocol,
        "feature_set_id": run.feature_set_id,
        "family_id": run.family_id,
        "identity_sha256": run.identity_sha256,
        "identity": run.identity_json,
        "preprocessing_fold_safety": run_preprocessing_validity(db, run, dv),
        "attempts": int(attempts),
        "calibration": run.calibration_json if status == "succeeded" else None,
        "abstention": run.abstention_json if status == "succeeded" else None,
        "bundle_id": run.bundle_id,
        "test_evaluation_requires": ("a recorded test release by the research lead "
                                     "(POST /experiments/{id}/test-release)"),
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

