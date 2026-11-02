"""Health and reference vocabularies."""

from __future__ import annotations

import time

from fastapi import APIRouter
from sqlalchemy import text

from .. import RESEARCH_USE_NOTICE, __version__
from ..config import WSI_EXTENSIONS_TESTED, get_settings
from ..db import SCHEMA_VERSION, current_schema_version, session_scope
from ..jobs.registry import HANDLERS, load_handlers
from ..jobs.worker import worker_health
from ..schemas import HealthOut
from ..storage import get_store
from ..vocab import (
    LABEL_DISPLAY,
    LABEL_SCOPES,
    LABEL_VALUES,
    PARTITIONS,
    PROVENANCE_DISPLAY,
    QC_CATEGORIES,
    QC_ELIGIBILITY_EFFECTS,
    QC_HEURISTIC_CATEGORIES,
    QC_MANUAL_CATEGORIES,
    QC_SUGGESTED_ACTIONS,
    REVIEW_STATES,
    REVIEW_TRANSITIONS,
    ROLES,
)

router = APIRouter(tags=["health"])


def _db_check() -> dict:
    t0 = time.perf_counter()
    try:
        with session_scope() as db:
            db.execute(text("SELECT 1"))
            sv = current_schema_version(db)
        return {"status": "ok", "latency_ms": round((time.perf_counter() - t0) * 1000, 2),
                "schema_version": sv, "expected_schema_version": SCHEMA_VERSION,
                "backend": get_settings().db_url.split(":", 1)[0]}
    except Exception as exc:
        return {"status": "error", "error": type(exc).__name__}


def _tile_check() -> dict:
    try:
        import openslide

        from ..slides.tiles import get_tile_service

        return {"status": "ok", "openslide": openslide.__library_version__,
                "openslide_python": openslide.__version__, "cache": get_tile_service().stats(),
                "tested_wsi_formats": list(WSI_EXTENSIONS_TESTED)}
    except Exception as exc:  # pragma: no cover - missing native library
        return {"status": "missing_dependency", "dependency": "openslide", "error": str(exc)}


@router.get("/health", response_model=HealthOut)
def health():
    """Database, object store, worker heartbeat and tile service. Works in every mode."""
    settings = get_settings()
    if not settings.mode_supported:
        return {"status": "refusing", "mode": settings.mode, "version": __version__,
                "checks": {"mode": {"status": "not_implemented",
                                    "message": f"WB_MODE={settings.mode} is not implemented; all other routes refuse"}},
                "research_use_only": RESEARCH_USE_NOTICE}
    checks = {"database": _db_check()}
    try:
        checks["object_store"] = get_store().health()
    except Exception as exc:
        checks["object_store"] = {"status": "error", "error": type(exc).__name__}
    try:
        checks["worker"] = worker_health()
    except Exception as exc:
        checks["worker"] = {"status": "error", "error": type(exc).__name__}
    checks["tile_service"] = _tile_check()
    checks["job_handlers"] = {"status": "ok", "modules": load_handlers(), "types": sorted(HANDLERS)}
    core_ok = all(checks[k]["status"] == "ok" for k in ("database", "object_store", "tile_service"))
    status = "ok" if core_ok and checks["worker"]["status"] == "ok" else "degraded"
    return {"status": status, "mode": settings.mode, "version": __version__, "checks": checks,
            "research_use_only": RESEARCH_USE_NOTICE,
            "notes": ["worker status 'never_seen' or 'stale' means queued jobs will not run until "
                      "`python -m dermpath.worker` is running"]}


@router.get("/meta")
def meta():
    """Controlled vocabularies for the frontend."""
    return {
        "roles": list(ROLES),
        "label_values": [{"value": v, "display": LABEL_DISPLAY[v]} for v in LABEL_VALUES],
        "label_scopes": list(LABEL_SCOPES),
        "review_states": list(REVIEW_STATES),
        "review_transitions": [{"from": f, "to": t, "roles": list(r)} for (f, t), r in REVIEW_TRANSITIONS.items()],
        "provenance": PROVENANCE_DISPLAY,
        "qc": {"categories": list(QC_CATEGORIES), "manual_categories": list(QC_MANUAL_CATEGORIES),
               "heuristic_categories": list(QC_HEURISTIC_CATEGORIES), "suggested_actions": list(QC_SUGGESTED_ACTIONS),
               "eligibility_effects": list(QC_ELIGIBILITY_EFFECTS)},
        "partitions": list(PARTITIONS),
        "upload": {"allowed_extensions": list(get_settings().allowed_extensions),
                   "tested_wsi_formats": list(WSI_EXTENSIONS_TESTED),
                   "chunk_size": get_settings().upload_chunk_bytes,
                   "max_upload_bytes": get_settings().max_upload_bytes},
        "research_use_only": RESEARCH_USE_NOTICE,
    }
