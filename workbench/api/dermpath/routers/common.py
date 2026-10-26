"""Shared serializers for routers."""

from __future__ import annotations

from sqlalchemy.orm import Session

from ..hierarchy import slide_lineage
from ..identifier_notice import IDENTIFIER_NOTICE
from ..models import Slide
from ..qc.service import slide_qc_summary
from ..slides.synthetic import NOTICE as SYNTHETIC_NOTICE
from ..vocab import PROVENANCE_DISPLAY


def slide_dict(db: Session, slide: Slide, *, include_qc: bool = True) -> dict:
    d = {
        "id": slide.id,
        "project_id": slide.project_id,
        "block_id": slide.block_id,
        "level_index": slide.level_index,
        "stain": slide.stain,
        "scanner_id": slide.scanner_id,
        "scanned_at": slide.scanned_at.isoformat() if slide.scanned_at else None,
        "image_kind": slide.image_kind,
        "is_whole_slide_image": slide.image_kind == "wsi",
        "provenance": slide.provenance,
        "provenance_display": PROVENANCE_DISPLAY.get(slide.provenance, slide.provenance),
        "synthetic_notice": SYNTHETIC_NOTICE if slide.image_kind == "synthetic_tiles" else None,
        "review_state": slide.review_state,
        "review_state_reason": slide.review_state_reason,
        "review_state_by": slide.review_state_by,
        "review_state_at": slide.review_state_at.isoformat() if slide.review_state_at else None,
        "ingest_status": slide.ingest_status,
        "ingest_error": slide.ingest_error,
        "processing_version": slide.processing_version,
        "sha256": slide.sha256,
        "sha256_note": ("sha256 of the deterministic generator spec (no file)"
                        if slide.image_kind == "synthetic_tiles" else "sha256 of the original file"),
        "bytes": slide.bytes,
        "format": slide.format,
        "vendor": slide.vendor,
        "width": slide.width,
        "height": slide.height,
        "levels": slide.levels,
        "level_dimensions": slide.level_dimensions_json,
        "level_downsamples": slide.level_downsamples_json,
        "mpp_x": slide.mpp_x,
        "mpp_y": slide.mpp_y,
        "objective_power": slide.objective_power,
        "scale_bar_allowed": slide.mpp_x is not None and slide.mpp_y is not None,
        "calibration_note": None if slide.mpp_x is not None else
        "microns-per-pixel unknown: no scale bar and no physical measurements",
        "original_filename": slide.original_filename,
        "original_filename_note": "metadata only; possible identifier source" if slide.original_filename else None,
        "identifier_risk": slide.identifier_risk_json or [],
        "identifier_notice": IDENTIFIER_NOTICE,
        "associated_images_present_not_served": slide.associated_images_json or [],
        "has_thumbnail": bool(slide.thumbnail_key),
        "image_available": image_available(slide),
        "image_unavailable_reason": image_unavailable_reason(slide),
        "created_at": slide.created_at.isoformat(),
        "ingested_at": slide.ingested_at.isoformat() if slide.ingested_at else None,
        "lineage": slide_lineage(db, slide),
    }
    if include_qc:
        d["qc_summary"] = slide_qc_summary(db, slide.id)
    return d

# Slide records of the pipeline-test cohort are generator specs that were never ingested: they have metadata, but no
# image to view. The flag is explicit so a client never has to infer it from other fields.
_NO_IMAGE_PREFIX = "pipeline-test-cohort/"


def image_available(slide) -> bool:
    return slide.ingest_status == "succeeded" and not (slide.processing_version or "").startswith(_NO_IMAGE_PREFIX)


def image_unavailable_reason(slide) -> str | None:
    if image_available(slide):
        return None
    if (slide.processing_version or "").startswith(_NO_IMAGE_PREFIX):
        return "Pipeline-test cohort record: metadata only, no image (never ingested)."
    return f"Not viewable: ingest status is {slide.ingest_status}."
