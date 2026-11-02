"""The ``ingest`` job: read a stored original, extract metadata, make a thumbnail.

Outcomes
--------
* success → ``ingest_status=succeeded`` with dimensions, levels, vendor, mpp (null when
  absent, never guessed), objective power, processing version, thumbnail, perceptual
  hash, identifier-risk flags and an ingest manifest in the object store;
* unsupported or corrupt input → ``ingest_status=failed`` with a readable, recoverable
  error. The job fails permanently (no retries) and nothing else is affected. A failed
  slide is never dataset- or training-eligible.

JPEG/PNG uploads are ingested as ``field_image`` (single-level, mpp null); they are not
whole-slide images and are never rescaled to look like one.
"""

from __future__ import annotations

import json
from dataclasses import dataclass

import openslide
from PIL import Image, UnidentifiedImageError

from .. import PROCESSING_VERSION, audit
from ..db import session_scope, utcnow
from ..jobs.registry import JobContext, PermanentJobError
from ..models import Slide
from ..storage import get_store, slide_key
from . import identifier_risk
from .imaging import THUMBNAIL_MAX, bounded_thumbnail, dhash, to_jpeg
from .reader import library_versions
from .synthetic import SyntheticSlide
from .tiles import get_tile_service

RECOVERY_HINT = (
    "The slide is marked failed and is not eligible for any dataset. Other slides and jobs "
    "are unaffected. To recover, upload a valid file (tested whole-slide format: Aperio .svs; "
    "JPEG/PNG are accepted as field images), or retry the ingest job if the file was replaced."
)


class IngestFailure(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass
class IngestResult:
    meta: dict
    thumbnail: Image.Image
    flags: list[dict]


def processing_version() -> str:
    v = library_versions()
    return (f"{PROCESSING_VERSION}; openslide {v['openslide']}; openslide-python "
            f"{v['openslide_python']}; pillow {v['pillow']}")


def _float_prop(props, key) -> float | None:
    raw = props.get(key)
    if raw in (None, ""):
        return None
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return None
    return value if value > 0 else None


def _ingest_wsi(path: str, original_ext: str) -> IngestResult:
    try:
        osr = openslide.OpenSlide(path)
    except openslide.OpenSlideUnsupportedFormatError as exc:
        raise IngestFailure(
            "unsupported_format",
            "OpenSlide could not identify this file as a supported whole-slide image "
            f"({exc}). Only Aperio .svs has a compatibility test in this prototype.",
        ) from exc
    except openslide.OpenSlideError as exc:
        raise IngestFailure("corrupt_file", f"OpenSlide could not open the file: {exc}") from exc
    try:
        dims = osr.dimensions
        if dims[0] <= 0 or dims[1] <= 0:
            raise IngestFailure("corrupt_file", "The slide reports empty dimensions")
        # Decode checks: the lowest-resolution level (thumbnail) and a level-0 region.
        thumb = bounded_thumbnail(osr, (THUMBNAIL_MAX, THUMBNAIL_MAX))
        cx, cy = max(0, dims[0] // 2 - 128), max(0, dims[1] // 2 - 128)
        osr.read_region((cx, cy), 0, (min(256, dims[0]), min(256, dims[1]))).load()
        props = dict(osr.properties)
        assoc = list(osr.associated_images.keys())
        meta = {
            "format": f"{(props.get('openslide.vendor') or 'unknown')}{original_ext}",
            "vendor": props.get("openslide.vendor"),
            "width": dims[0],
            "height": dims[1],
            "levels": osr.level_count,
            "level_dimensions": [list(d) for d in osr.level_dimensions],
            "level_downsamples": [float(d) for d in osr.level_downsamples],
            "mpp_x": _float_prop(props, openslide.PROPERTY_NAME_MPP_X),
            "mpp_y": _float_prop(props, openslide.PROPERTY_NAME_MPP_Y),
            "objective_power": _float_prop(props, openslide.PROPERTY_NAME_OBJECTIVE_POWER),
            "associated_images": assoc,
        }
        flags = identifier_risk.metadata_flags(props, assoc)
        return IngestResult(meta=meta, thumbnail=thumb, flags=flags)
    except openslide.OpenSlideError as exc:
        raise IngestFailure("corrupt_file", f"OpenSlide failed while decoding the slide: {exc}") from exc
    finally:
        osr.close()


def _ingest_field_image(path: str, max_pixels: int) -> IngestResult:
    try:
        with Image.open(path) as im:
            fmt = im.format
            w, h = im.size
            if fmt not in ("JPEG", "PNG"):
                raise IngestFailure("unsupported_format", f"Field images must be JPEG or PNG (got {fmt})")
            if w * h > max_pixels:
                raise IngestFailure(
                    "too_large",
                    f"The image is {w}x{h} pixels, above the field-image limit of {max_pixels} pixels",
                )
            im.verify()
        with Image.open(path) as im:
            im.load()
            has_exif = bool(im.info.get("exif")) or len(im.getexif()) > 0
            rgb = im.convert("RGB")
    except IngestFailure:
        raise
    except (UnidentifiedImageError, OSError, SyntaxError, ValueError, Image.DecompressionBombError) as exc:
        raise IngestFailure("corrupt_file", f"The image could not be decoded: {exc}") from exc
    thumb = rgb.copy()
    thumb.thumbnail((THUMBNAIL_MAX, THUMBNAIL_MAX))
    meta = {
        "format": fmt.lower(),
        "vendor": None,
        "width": w,
        "height": h,
        "levels": 1,
        "level_dimensions": [[w, h]],
        "level_downsamples": [1.0],
        "mpp_x": None,  # pixel size of a camera field image is unknown; never inferred from DPI
        "mpp_y": None,
        "objective_power": None,
        "associated_images": [],
    }
    return IngestResult(meta=meta, thumbnail=thumb, flags=identifier_risk.exif_flags(has_exif))


def _ingest_synthetic(spec: dict) -> IngestResult:
    s = SyntheticSlide(spec)
    thumb = bounded_thumbnail(s, (THUMBNAIL_MAX, THUMBNAIL_MAX))
    meta = {
        "format": "synthetic_procedural",
        "vendor": "dermpath-synthetic",
        "width": s.dimensions[0],
        "height": s.dimensions[1],
        "levels": s.level_count,
        "level_dimensions": [list(d) for d in s.level_dimensions],
        "level_downsamples": list(s.level_downsamples),
        "mpp_x": None,  # procedural pattern: no physical calibration exists
        "mpp_y": None,
        "objective_power": None,
        "associated_images": [],
    }
    return IngestResult(meta=meta, thumbnail=thumb, flags=[])


def ingest_slide(slide_id: str, ctx: JobContext | None = None, *, auto_qc: bool = True) -> dict:
    from ..jobs.queue import enqueue  # local import: queue ↔ handlers

    store = get_store()
    with session_scope() as db:
        slide = db.get(Slide, slide_id)
        if slide is None:
            raise PermanentJobError(f"slide {slide_id} does not exist")
        slide.ingest_status = "running"
        slide.ingest_error = None
        kind, key, spec = slide.image_kind, slide.object_key, slide.synthetic_spec_json
        project_id = slide.project_id
        ext = "." + key.rsplit(".", 1)[-1] if "." in key.rsplit("/", 1)[-1] else ""
    if ctx:
        ctx.progress(0.05, "opening")
    get_tile_service().evict(slide_id)
    from ..config import get_settings

    try:
        if kind == "synthetic_tiles":
            res = _ingest_synthetic(spec or {})
        else:
            path = str(store.local_path(key))
            if kind == "field_image":
                res = _ingest_field_image(path, get_settings().max_field_image_pixels)
            else:
                res = _ingest_wsi(path, ext)
    except IngestFailure as exc:
        message = f"{exc.message}. {RECOVERY_HINT}"
        with session_scope() as db:
            slide = db.get(Slide, slide_id)
            slide.ingest_status = "failed"
            slide.ingest_error = f"[{exc.code}] {message}"
            slide.processing_version = processing_version()
            audit.record(db, action="slide.ingest_failed", entity_type="slide", entity_id=slide_id,
                         actor_id=audit.SYSTEM_WORKER, actor_role="system", project_id=project_id,
                         after={"ingest_status": "failed", "error_code": exc.code})
        raise PermanentJobError(f"[{exc.code}] {exc.message}") from exc

    if ctx:
        ctx.progress(0.6, "writing thumbnail and manifest")
    thumb_key = slide_key(project_id, slide_id, "thumbnail.jpg")
    store.put_bytes(thumb_key, to_jpeg(res.thumbnail))
    phash = dhash(res.thumbnail)
    pv = processing_version()
    now = utcnow()
    with session_scope() as db:
        slide = db.get(Slide, slide_id)
        before = {"ingest_status": slide.ingest_status}
        m = res.meta
        slide.format = m["format"]
        slide.vendor = m["vendor"]
        slide.width, slide.height = m["width"], m["height"]
        slide.levels = m["levels"]
        slide.level_dimensions_json = m["level_dimensions"]
        slide.level_downsamples_json = m["level_downsamples"]
        slide.mpp_x, slide.mpp_y = m["mpp_x"], m["mpp_y"]
        slide.objective_power = m["objective_power"]
        slide.associated_images_json = m["associated_images"]
        # Keep upload-time (filename) flags, replace file-derived flags.
        kept = [f for f in (slide.identifier_risk_json or []) if f.get("source") == "filename"]
        slide.identifier_risk_json = kept + res.flags
        slide.thumbnail_key = thumb_key
        slide.thumbnail_phash = phash
        slide.processing_version = pv
        slide.ingest_status = "succeeded"
        slide.ingest_error = None
        slide.ingested_at = now
        manifest = {
            "schema": "dermpath.ingest_manifest/1",
            "slide_id": slide.id,
            "project_id": project_id,
            "sha256": slide.sha256,
            "bytes": slide.bytes,
            "image_kind": slide.image_kind,
            "provenance": slide.provenance,
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
            "associated_images_present_not_served": slide.associated_images_json,
            "identifier_risk_flags": [f["code"] for f in slide.identifier_risk_json],
            "thumbnail_dhash": phash,
            "processing_version": pv,
            "ingested_at": now.isoformat(),
            "synthetic_spec": slide.synthetic_spec_json,
        }
        mkey = slide_key(project_id, slide_id, "ingest_manifest.json")
        store.put_bytes(mkey, json.dumps(manifest, indent=2, sort_keys=True).encode())
        slide.ingest_manifest_key = mkey
        audit.record(db, action="slide.ingested", entity_type="slide", entity_id=slide_id,
                     actor_id=audit.SYSTEM_WORKER, actor_role="system", project_id=project_id,
                     before=before,
                     after={"ingest_status": "succeeded", "width": slide.width, "height": slide.height,
                            "levels": slide.levels, "mpp_x": slide.mpp_x,
                            "identifier_risk_flags": [f["code"] for f in slide.identifier_risk_json]})
        qc_job_id = None
        if auto_qc:
            job, _ = enqueue(db, "qc_screen", {"slide_id": slide_id},
                             idempotency_key=f"qc_screen:{slide_id}:{slide.sha256[:16]}:{pv}",
                             project_id=project_id, created_by=audit.SYSTEM_WORKER)
            qc_job_id = job.id
    if ctx:
        ctx.progress(1.0, "done")
    return {"slide_id": slide_id, "ingest_status": "succeeded", "width": res.meta["width"],
            "height": res.meta["height"], "levels": res.meta["levels"], "mpp_x": res.meta["mpp_x"],
            "qc_job_id": qc_job_id}
