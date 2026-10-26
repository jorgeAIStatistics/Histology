"""ML job handlers: ``train`` and ``extract_features`` (idempotent; see the registry docstring)."""

from __future__ import annotations

from ..jobs.registry import JobContext, PermanentJobError, register
from .config import resolve_params
from .encoders import EncoderUnavailable


@register("train", description="Train a research head on a frozen dataset version (val threshold frozen)")
def train(ctx: JobContext, payload: dict) -> dict:
    from .training import run_training

    run_id = payload.get("run_id")
    if not run_id:
        raise PermanentJobError("payload.run_id is required")
    return run_training(run_id, ctx)


@register("extract_features", description="Tissue patches → encoder → cached embeddings for one slide")
def extract_features(ctx: JobContext, payload: dict) -> dict:
    from .features import FeatureError, extract_slide_features

    slide_id, encoder_id = payload.get("slide_id"), payload.get("encoder_id")
    if not slide_id or not encoder_id:
        raise PermanentJobError("payload.slide_id and payload.encoder_id are required")
    try:
        params = resolve_params(payload.get("params") or {})
    except ValueError as exc:
        raise PermanentJobError(f"invalid params: {exc.args[0]}") from exc
    label = payload.get("fixture_label")
    try:
        res = extract_slide_features(slide_id, encoder_id=encoder_id, params=params, seed=int(payload.get("seed", 0)),
                                     fixture_label=None if label is None else int(label), ctx=ctx,
                                     job_id=ctx.job_id, progress_base=0.0, progress_span=1.0)
    except EncoderUnavailable as exc:
        raise PermanentJobError(f"encoder_unavailable: {exc}") from exc
    except (FeatureError, ValueError) as exc:
        raise PermanentJobError(str(exc)) from exc
    return {"slide_id": slide_id, "feature_artifact_id": res.artifact_id, "cache_hit": res.cache_hit,
            "n_patches": res.n_patches, "seconds": round(res.seconds, 3)}
