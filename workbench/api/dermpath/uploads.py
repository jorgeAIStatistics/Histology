"""Resumable chunked uploads.

Protocol (all under ``/api/v1``):

1. ``POST /projects/{pid}/uploads`` with ``{filename, size, sha256, provenance, ...}``
   → ``{upload_id, chunk_size, received_bytes, next_chunk_index, total_chunks}``.
   The server fixes ``chunk_size``. A matching in-progress upload by the same user
   (same sha256 and size) is returned instead of a new one (``resumed: true``). If a
   slide with the same sha256 already exists in the project → 409 ``duplicate_slide``
   naming the existing slide; nothing is ingested twice.
2. ``PUT /uploads/{id}/chunks/{index}`` with the raw chunk bytes as the body and the
   chunk's hex SHA-256 in ``X-Chunk-SHA256``. Chunks are sequential: index ``i`` covers
   bytes ``[i*chunk_size, min((i+1)*chunk_size, size))``. Re-sending an already received
   chunk with the same checksum is a no-op (idempotent). Bodies are streamed to disk
   (bounded memory); a body longer than the expected chunk is cut off and rejected.
3. ``GET /uploads/{id}`` → the resume offset (``received_bytes``, ``next_chunk_index``).
4. ``POST /uploads/{id}/complete`` verifies the whole-file SHA-256 against the declared
   value, re-checks duplicates, stores the original under a generated key, creates the
   slide and enqueues an ``ingest`` job.

The original filename is kept ONLY as metadata and is checked for identifier risk; the
stored object key never contains it.
"""

from __future__ import annotations

import hashlib
import os
import re
import unicodedata
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session

from . import audit
from .auth import Actor
from .config import FIELD_IMAGE_EXTENSIONS, get_settings
from .db import utcnow
from .errors import ApiError, conflict, unprocessable
from .hierarchy import find_or_create_hierarchy
from .jobs.queue import enqueue
from .models import Block, Slide, Upload, new_id
from .slides.identifier_risk import filename_flags
from .storage import get_store, slide_key

_SHA_RE = re.compile(r"^[0-9a-f]{64}$")
UPLOAD_PROVENANCES = ("public_cc0", "real_authorized")


def safe_filename(name: str) -> str:
    base = name.replace("\\", "/").rsplit("/", 1)[-1]
    base = unicodedata.normalize("NFKC", base)
    base = "".join(ch for ch in base if ch.isprintable() and ch not in '<>:"|?*\x00')
    base = re.sub(r"\s+", " ", base).strip(" .")
    return (base or "unnamed")[:200]


def extension_of(name: str) -> str:
    base = safe_filename(name).lower()
    return "." + base.rsplit(".", 1)[-1] if "." in base else ""


def kind_for_extension(ext: str) -> str:
    return "field_image" if ext in FIELD_IMAGE_EXTENSIONS else "wsi"


def staging_path(upload_id: str) -> Path:
    d = get_settings().uploads_dir
    d.mkdir(parents=True, exist_ok=True)
    return d / f"{upload_id}.part"


def upload_dict(u: Upload) -> dict:
    total_chunks = max(1, -(-u.declared_size // u.chunk_size)) if u.declared_size else 0
    return {
        "upload_id": u.id,
        "id": u.id,
        "project_id": u.project_id,
        "status": u.status,
        "filename_safe": u.filename_safe,
        "original_filename_is_metadata_only": True,
        "kind": u.kind,
        "provenance": u.provenance,
        "governance_attestation": u.governance_attestation,
        "governance_note": "An attestation is recorded but is NOT proof of de-identification.",
        "declared_size": u.declared_size,
        "declared_sha256": u.declared_sha256,
        "chunk_size": u.chunk_size,
        "received_bytes": u.received_bytes,
        "next_chunk_index": u.received_bytes // u.chunk_size if u.chunk_size else 0,
        "total_chunks": total_chunks,
        "identifier_risk": u.identifier_risk_json,
        "slide_id": u.slide_id,
        "duplicate_of_slide_id": u.duplicate_of_slide_id,
        "job_id": u.job_id,
        "error": u.error,
        "created_by": u.created_by,
        "created_at": u.created_at.isoformat(),
        "completed_at": u.completed_at.isoformat() if u.completed_at else None,
    }


def init_upload(db: Session, actor: Actor, project_id: str, *, filename: str, size: int, sha256: str,
                provenance: str, kind_hint: str | None, block_id: str | None, new_hierarchy: dict | None,
                level_index: int | None, stain: str | None, scanner_id: str | None,
                governance_attestation: bool) -> tuple[Upload, bool]:
    settings = get_settings()
    sha256 = (sha256 or "").lower()
    if not _SHA_RE.match(sha256):
        raise unprocessable("invalid_sha256", "sha256 must be 64 lower-case hex characters")
    if size <= 0:
        raise unprocessable("invalid_size", "size must be positive")
    if size > settings.max_upload_bytes:
        raise ApiError(413, "too_large", f"File exceeds the maximum upload size of {settings.max_upload_bytes} bytes",
                       max_upload_bytes=settings.max_upload_bytes)
    ext = extension_of(filename)
    if ext not in settings.allowed_extensions:
        raise ApiError(415, "unsupported_extension",
                       f"Extension {ext or '(none)'} is not accepted. Accepted: {', '.join(settings.allowed_extensions)}. "
                       "Only Aperio .svs is tested as a whole-slide format; JPEG/PNG are imported as field images.",
                       allowed=list(settings.allowed_extensions))
    kind = kind_for_extension(ext)
    if kind_hint and kind_hint != kind:
        raise unprocessable("kind_mismatch", f"A {ext} file is imported as {kind}, not {kind_hint}")
    if provenance not in UPLOAD_PROVENANCES:
        raise unprocessable("invalid_provenance",
                            "Uploads are public_cc0 or real_authorized (demo_synthetic is reserved for procedural tiles)")
    if provenance == "real_authorized":
        if not settings.allow_real_data:
            raise conflict("real_data_disabled",
                           "Real data uploads are disabled in this demo (WB_ALLOW_REAL_DATA is off). "
                           "Real data needs secured mode, data agreements and authorization, which are not implemented.")
        if not governance_attestation:
            raise unprocessable("governance_attestation_required",
                                "real_authorized uploads need the governance attestation (recorded, not proof of de-identification)")
    if block_id and new_hierarchy:
        raise unprocessable("ambiguous_target", "Give either block_id or new_hierarchy, not both")
    if block_id:
        block = db.get(Block, block_id)
        if block is None or block.project_id != project_id:
            raise unprocessable("invalid_block", "block_id is not a block of this project")
    if new_hierarchy:
        # Validate now (no rows are created until completion).
        from .hierarchy import check_accession, check_block, check_part, check_patient_code, check_slug

        check_patient_code(new_hierarchy.get("patient_code", ""))
        check_accession(new_hierarchy.get("accession_code", ""))
        check_part(new_hierarchy.get("part_designation", ""))
        check_block(new_hierarchy.get("block_designation", ""))
        check_slug(new_hierarchy.get("site_id"), "site_id")
    from .hierarchy import check_slug as _slug

    _slug(scanner_id, "scanner_id")

    existing_slide = db.scalars(select(Slide).where(Slide.project_id == project_id, Slide.sha256 == sha256)).first()
    if existing_slide is not None:
        raise conflict("duplicate_slide", "A slide with this sha256 already exists in this project; it was not ingested again",
                       existing_slide_id=existing_slide.id)
    resumable = db.scalars(select(Upload).where(
        Upload.project_id == project_id, Upload.declared_sha256 == sha256, Upload.declared_size == size,
        Upload.created_by == actor.id, Upload.status == "receiving")).first()
    if resumable is not None:
        return resumable, True

    flags = filename_flags(filename)
    u = Upload(
        id=new_id(), project_id=project_id, created_by=actor.id, original_filename=filename[:255],
        filename_safe=safe_filename(filename), extension=ext, kind=kind, declared_size=size,
        declared_sha256=sha256, chunk_size=settings.upload_chunk_bytes, received_bytes=0, chunk_sha256s=[],
        status="receiving", provenance=provenance, governance_attestation=bool(governance_attestation),
        identifier_risk_json=flags,
        target_json={"block_id": block_id, "new_hierarchy": new_hierarchy, "level_index": level_index,
                     "stain": stain, "scanner_id": scanner_id},
    )
    db.add(u)
    staging_path(u.id).touch(mode=0o600)
    audit.record_for(db, actor, project_id=project_id, action="upload.created", entity_type="upload", entity_id=u.id,
                     after={"filename_safe": u.filename_safe, "size": size, "sha256": sha256, "kind": kind,
                            "provenance": provenance, "identifier_risk_flags": [f["code"] for f in flags]})
    return u, False


async def receive_chunk(db: Session, actor: Actor, upload: Upload, index: int, header_sha: str | None,
                        body_stream) -> dict:
    """Stream one chunk to a temp file (bounded), verify it, append it. See module doc."""
    if upload.status != "receiving":
        raise conflict("upload_not_receiving", f"Upload is {upload.status}", status=upload.status)
    header_sha = (header_sha or "").lower()
    if not _SHA_RE.match(header_sha):
        raise unprocessable("chunk_sha256_required", "X-Chunk-SHA256 header with the chunk's hex sha256 is required")
    expected_index = upload.received_bytes // upload.chunk_size
    if index < expected_index:
        if index < len(upload.chunk_sha256s) and upload.chunk_sha256s[index] == header_sha:
            # Drain the body (bounded) and acknowledge: idempotent re-send.
            async for _ in body_stream:
                pass
            return {**upload_dict(upload), "chunk_index": index, "already_received": True}
        raise conflict("chunk_conflict", "This chunk index was already received with a different checksum",
                       expected_index=expected_index)
    if index > expected_index:
        raise conflict("out_of_order_chunk", f"Expected chunk {expected_index}", expected_index=expected_index,
                       received_bytes=upload.received_bytes)
    expected_len = min(upload.chunk_size, upload.declared_size - upload.received_bytes)
    tmp = staging_path(upload.id).with_name(f"{upload.id}.{index}.chunk")
    h = hashlib.sha256()
    n = 0
    too_long = False
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        with os.fdopen(fd, "wb") as fh:
            async for part in body_stream:
                if not part:
                    continue
                if n + len(part) > expected_len:
                    too_long = True
                    break
                fh.write(part)
                h.update(part)
                n += len(part)
        if too_long:
            raise ApiError(413, "chunk_too_large", f"Chunk {index} exceeds its expected length {expected_len}",
                           expected_length=expected_len)
        if n != expected_len:
            raise unprocessable("chunk_length_mismatch",
                                f"Chunk {index} has {n} bytes; expected {expected_len} (interrupted transfer?)",
                                expected_length=expected_len, received_length=n)
        digest = h.hexdigest()
        if digest != header_sha:
            raise unprocessable("chunk_checksum_mismatch", f"Chunk {index} checksum mismatch; re-send the chunk",
                                expected_index=expected_index)
        # Critical section (no awaits below): re-read state, truncate, append, commit.
        db.refresh(upload)
        if upload.status != "receiving" or upload.received_bytes // upload.chunk_size != index:
            raise conflict("out_of_order_chunk", "Upload state changed concurrently; GET the upload and resume",
                           received_bytes=upload.received_bytes)
        part_path = staging_path(upload.id)
        with open(part_path, "r+b" if part_path.exists() else "w+b") as out:
            out.truncate(upload.received_bytes)  # drop any bytes from a crash after a previous append
            out.seek(upload.received_bytes)
            with open(tmp, "rb") as src:
                for block in iter(lambda: src.read(1024 * 1024), b""):
                    out.write(block)
            out.flush()
            os.fsync(out.fileno())
        upload.received_bytes += n
        upload.chunk_sha256s = [*upload.chunk_sha256s, digest]
        db.commit()
    finally:
        tmp.unlink(missing_ok=True)
    return {**upload_dict(upload), "chunk_index": index, "already_received": False}


def complete_upload(db: Session, actor: Actor, upload: Upload) -> dict:
    if upload.status in ("completed", "duplicate"):
        return upload_dict(upload)
    if upload.status != "receiving":
        raise conflict("upload_not_receiving", f"Upload is {upload.status}", status=upload.status)
    if upload.received_bytes != upload.declared_size:
        raise conflict("upload_incomplete", "Not all bytes have been received",
                       received_bytes=upload.received_bytes, declared_size=upload.declared_size,
                       next_chunk_index=upload.received_bytes // upload.chunk_size)
    part = staging_path(upload.id)
    if not part.exists() or part.stat().st_size < upload.declared_size:
        upload.status = "failed"
        upload.error = "staging data missing; start a new upload"
        db.commit()
        raise conflict("staging_missing", upload.error)
    with open(part, "r+b") as fh:
        fh.truncate(upload.declared_size)
    h = hashlib.sha256()
    with open(part, "rb") as fh:
        for block in iter(lambda: fh.read(1024 * 1024), b""):
            h.update(block)
    digest = h.hexdigest()
    if digest != upload.declared_sha256:
        upload.status = "failed"
        upload.error = (f"Whole-file checksum mismatch (got {digest[:12]}…, declared "
                        f"{upload.declared_sha256[:12]}…). The data was discarded; start a new upload.")
        part.unlink(missing_ok=True)
        audit.record_for(db, actor, project_id=upload.project_id, action="upload.checksum_failed",
                         entity_type="upload", entity_id=upload.id, after={"status": "failed"})
        db.commit()
        raise unprocessable("checksum_mismatch", upload.error, upload_id=upload.id)

    existing = db.scalars(select(Slide).where(Slide.project_id == upload.project_id, Slide.sha256 == digest)).first()
    if existing is not None:
        upload.status = "duplicate"
        upload.duplicate_of_slide_id = existing.id
        upload.completed_at = utcnow()
        part.unlink(missing_ok=True)
        audit.record_for(db, actor, project_id=upload.project_id, action="upload.duplicate", entity_type="upload",
                         entity_id=upload.id, after={"duplicate_of_slide_id": existing.id, "sha256": digest})
        db.commit()
        return upload_dict(upload)

    target = upload.target_json or {}
    block_id = target.get("block_id")
    nh = target.get("new_hierarchy")
    if nh:
        from datetime import date as _date

        collected = nh.get("collected_on")
        block = find_or_create_hierarchy(
            db, upload.project_id, actor.id, patient_code=nh["patient_code"], accession_code=nh["accession_code"],
            part_designation=nh["part_designation"], block_designation=nh["block_designation"],
            collected_on=_date.fromisoformat(collected) if collected else None, site_id=nh.get("site_id"),
            anatomic_site_text=nh.get("anatomic_site_text"), provenance=upload.provenance)
        block_id = block.id
    slide_id = new_id()
    key = slide_key(upload.project_id, slide_id, "original" + upload.extension)
    slide = Slide(
        id=slide_id, project_id=upload.project_id, block_id=block_id, level_index=target.get("level_index"),
        stain=target.get("stain"), scanner_id=target.get("scanner_id"), provenance=upload.provenance,
        image_kind=upload.kind, object_key=key, sha256=digest, bytes=upload.declared_size,
        format=upload.extension.lstrip("."), ingest_status="pending", original_filename=upload.original_filename,
        identifier_risk_json=list(upload.identifier_risk_json or []), review_state="imported", created_by=actor.id,
    )
    db.add(slide)
    db.flush()
    get_store().put_file(key, part, move=True)
    job, _ = enqueue(db, "ingest", {"slide_id": slide_id, "auto_qc": True}, idempotency_key=f"ingest:{slide_id}",
                     project_id=upload.project_id, created_by=actor.id)
    upload.status = "completed"
    upload.slide_id = slide_id
    upload.job_id = job.id
    upload.completed_at = utcnow()
    audit.record_for(db, actor, project_id=upload.project_id, action="upload.completed", entity_type="upload",
                     entity_id=upload.id, after={"slide_id": slide_id, "sha256": digest, "job_id": job.id})
    audit.record_for(db, actor, project_id=upload.project_id, action="slide.created", entity_type="slide",
                     entity_id=slide_id, after={"image_kind": upload.kind, "provenance": upload.provenance,
                                                "block_id": block_id, "sha256": digest,
                                                "identifier_risk_flags": [f["code"] for f in slide.identifier_risk_json]})
    db.commit()
    return upload_dict(upload)


def cancel_upload(db: Session, actor: Actor, upload: Upload) -> dict:
    if upload.status != "receiving":
        raise conflict("upload_not_receiving", f"Upload is {upload.status}")
    upload.status = "canceled"
    staging_path(upload.id).unlink(missing_ok=True)
    audit.record_for(db, actor, project_id=upload.project_id, action="upload.canceled", entity_type="upload",
                     entity_id=upload.id, after={"status": "canceled"})
    db.commit()
    return upload_dict(upload)
