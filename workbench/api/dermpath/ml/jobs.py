"""ML job handlers: ``train`` and ``extract_features`` (idempotent; see the registry docstring),
the ``train`` settle hook that ends a run when the queue fails or cancels its job, and the
loading of the engine modules whose handlers live next to their domain code
(``build_feature_set`` in :mod:`dermpath.ml.feature_sets`, ``evaluate_test_release`` in
:mod:`dermpath.ml.evaluation`, ``infer_slide`` in :mod:`dermpath.ml.inference`, ``active_learning``
in :mod:`dermpath.ml.active_learning`).

Workers import only this module (``OPTIONAL_HANDLER_MODULES``), so it imports the engine
modules: their ``@register`` decorators then run in every worker process, not only in the API.
"""

from __future__ import annotations

import importlib
import logging

from ..db import utcnow
from ..jobs.registry import JobContext, PermanentJobError, register, register_settle_hook
from .config import resolve_params
from .encoders import EncoderUnavailable

log = logging.getLogger("dermpath.ml.jobs")

#: Engine modules that register job handlers or settle hooks when imported.
ENGINE_HANDLER_MODULES = ("dermpath.ml.feature_sets", "dermpath.ml.evaluation", "dermpath.ml.inference",
                          "dermpath.ml.active_learning")
BUILD_FEATURE_SET = "build_feature_set"
ACTIVE_JOB_STATUSES = ("queued", "running")


@register("train", description="Train a research head on a frozen dataset version and its pinned feature set")
def train(ctx: JobContext, payload: dict) -> dict:
    from .training import run_training

    run_id = payload.get("run_id")
    if not run_id:
        raise PermanentJobError("payload.run_id is required")
    if any(k in payload for k in ("label", "labels", "fixture_label")):
        raise PermanentJobError("job payloads never carry labels")
    return run_training(run_id, ctx)


@register_settle_hook("train")
def settle_training_run(db, job, status: str, error: str | None) -> None:
    """Settle the run of a ``train`` job the queue ended ``failed`` or ``canceled`` (expired
    lease with attempts exhausted, cancel of a queued job, ...), so it never stays ``running``,
    and close any attempt left open by a worker that died.

    Idempotent; a finished run (succeeded, or already failed/canceled) is never touched, and
    a succeeded run is immutable anyway."""
    from sqlalchemy import select

    from .engine_models import RunAttempt
    from .models import TrainingRun

    run_id = (job.payload_json or {}).get("run_id")
    run = db.get(TrainingRun, run_id) if run_id else None
    if run is None:
        return
    for a in db.scalars(select(RunAttempt).where(RunAttempt.run_id == run.id, RunAttempt.outcome.is_(None))).all():
        a.outcome = "canceled" if status == "canceled" else "failed"
        a.error = f"settled by the queue: {(error or status)}"[:4000]
        a.finished_at = utcnow()
    _settle_inline_feature_set(db, job, run, status, error)
    if run.status not in ("queued", "running"):
        return
    run.status = status
    run.error = (error or status)[:4000]
    run.finished_at = utcnow()


def _settle_inline_feature_set(db, job, run, status: str, error: str | None) -> None:
    """A train job builds its run's feature set inline when it is not ready. If the queue ends that job while
    the set is still ``building`` (attempts exhausted mid-build, cancel, dead worker), and no other queued or
    running job can still finish it, the set becomes ``failed`` so it never shows as building forever. A failed
    set is resumable: the next build (POST /feature-sets/{id}/build or another run's inline build) flips it back to
    ``building`` and skips the slides already done."""
    from sqlalchemy import select

    from ..models import Job
    from .engine_models import FeatureSet
    from .models import TrainingRun

    fs = db.get(FeatureSet, run.feature_set_id) if run.feature_set_id else None
    if fs is None or fs.status != "building":
        return
    active = db.scalars(select(Job).where(Job.id != job.id, Job.status.in_(ACTIVE_JOB_STATUSES),
                                          Job.type.in_((BUILD_FEATURE_SET, "train")))).all()
    train_runs = [(j.payload_json or {}).get("run_id") for j in active if j.type == "train"]
    pinned = set(db.scalars(select(TrainingRun.id).where(TrainingRun.id.in_([r for r in train_runs if r]),
                                                         TrainingRun.feature_set_id == fs.id)).all())
    for j in active:
        payload = j.payload_json or {}
        if (j.type == BUILD_FEATURE_SET and payload.get("feature_set_id") == fs.id) or payload.get("run_id") in pinned:
            return
    fs.status = "failed"
    fs.error = f"inline build by train job {job.id} ended {status}: {error or status}"[:4000]


@register("extract_features", description="Tissue patches → encoder → cached embeddings for one slide")
def extract_features(ctx: JobContext, payload: dict) -> dict:
    from .features import FeatureError, extract_slide_features

    slide_id, encoder_id = payload.get("slide_id"), payload.get("encoder_id")
    if not slide_id or not encoder_id:
        raise PermanentJobError("payload.slide_id and payload.encoder_id are required")
    if "fixture_label" in payload or "label" in payload:
        # Design §1 invariant 4: no job payload carries a label or a fixture label.
        raise PermanentJobError("job payloads never carry labels (fixture labels are derived in the worker "
                                "from a frozen manifest)")
    try:
        params = resolve_params(payload.get("params") or {})
    except ValueError as exc:
        raise PermanentJobError(f"invalid params: {exc.args[0]}") from exc
    try:
        res = extract_slide_features(slide_id, encoder_id=encoder_id, params=params, seed=int(payload.get("seed", 0)),
                                     fixture_label=None, ctx=ctx,
                                     job_id=ctx.job_id, progress_base=0.0, progress_span=1.0)
    except EncoderUnavailable as exc:
        raise PermanentJobError(f"encoder_unavailable: {exc}") from exc
    except (FeatureError, ValueError) as exc:
        raise PermanentJobError(str(exc)) from exc
    return {"slide_id": slide_id, "feature_artifact_id": res.artifact_id, "cache_hit": res.cache_hit,
            "n_patches": res.n_patches, "seconds": round(res.seconds, 3)}


def _load_engine_modules() -> dict[str, str]:
    report = {}
    for mod in ENGINE_HANDLER_MODULES:
        try:
            importlib.import_module(mod)
            report[mod] = "loaded"
        except Exception as exc:  # a broken engine module must not take the train handler down
            report[mod] = f"import_error: {type(exc).__name__}: {exc}"
            log.exception("engine handler module %s failed to import", mod)
    return report


ENGINE_MODULES_REPORT = _load_engine_modules()
