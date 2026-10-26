"""Built-in job handlers: ``ingest`` and ``qc_screen``."""

from __future__ import annotations

from .registry import JobContext, PermanentJobError, register


@register("ingest", description="Open a stored original, extract metadata and a thumbnail")
def ingest(ctx: JobContext, payload: dict) -> dict:
    from ..slides.ingest import ingest_slide

    slide_id = payload.get("slide_id")
    if not slide_id:
        raise PermanentJobError("payload.slide_id is required")
    return ingest_slide(slide_id, ctx, auto_qc=bool(payload.get("auto_qc", True)))


@register("qc_screen", description="Experimental tissue (Otsu) and focus (variance of Laplacian) screen")
def qc_screen(ctx: JobContext, payload: dict) -> dict:
    from ..qc.service import run_screen

    slide_id = payload.get("slide_id")
    if not slide_id:
        raise PermanentJobError("payload.slide_id is required")
    return run_screen(slide_id, ctx)
