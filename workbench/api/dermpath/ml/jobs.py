"""ML job handlers: ``train`` and ``extract_features`` (idempotent; see the registry docstring),
and the ``train`` settle hook that ends a run when the queue fails or cancels its job."""

from __future__ import annotations

from ..db import utcnow
from ..jobs.registry import JobContext, PermanentJobError, register, register_settle_hook
from .config import resolve_params
from .encoders import EncoderUnavailable


@register("train", description="Train a research head on a frozen dataset version (val threshold frozen)")
def train(ctx: JobContext, payload: dict) -> dict:
    from .training import run_training

    run_id = payload.get("run_id")
    if not run_id:
        raise PermanentJobError("payload.run_id is required")
    return run_training(run_id, ctx)


@register_settle_hook("train")
def settle_training_run(db, job, status: str, error: str | None) -> None:
    """Settle the run of a ``train`` job the queue ended ``failed`` or ``canceled`` (expired
    lease with attempts exhausted, cancel of a queued job, ...), so it never stays ``running``.

    Idempotent; a finished run (succeeded, or already failed/canceled) is never touched, and
    a succeeded run is immutable anyway."""
    from .models import TrainingRun

    run_id = (job.payload_json or {}).get("run_id")
    run = db.get(TrainingRun, run_id) if run_id else None
    if run is None or run.status not in ("queued", "running"):
        return
    run.status = status
    run.error = (error or status)[:4000]
    run.finished_at = utcnow()


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
