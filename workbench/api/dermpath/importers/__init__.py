"""Server-side importers for published research datasets (research use only).

An importer registers files that already sit on the server (downloaded by a person, under the
dataset's licence) as first-class slides, through the same pipeline as a browser upload:

* the file's SHA-256 must equal the dataset's published checksum list; the copy into the
  private object store is hashed while it is written (one read of the source) and a mismatch
  stores nothing (:func:`store_server_file`);
* the slide row, its hierarchy and an ``ingest`` job (``auto_qc``: OpenSlide metadata,
  thumbnail, ingest manifest, then the automated QC screen) are created in one transaction
  (:func:`register_slide`), exactly as ``uploads.complete_upload`` does after an upload;
* the jobs run in a worker (``python -m dermpath.worker --once`` until the queue is idle, or the
  long-running worker), never inside the importer unless it is asked to.

Importers never execute anything found in the dataset, never read pixels themselves, and never
record personal attributes beyond the coded patient identifier the dataset publishes. Labels
taken from a dataset's own reference standard are ``imported_reference`` labels
(:func:`dermpath.labels.create_imported_reference_label`), never expert labels.
"""

from __future__ import annotations

import hashlib
import re
from pathlib import Path

from sqlalchemy.orm import Session

from ..jobs.queue import enqueue
from ..models import Job, Slide
from ..slides.identifier_risk import filename_flags
from ..storage import PutResult, get_store, slide_key

#: File names an importer accepts from a dataset's (untrusted) listing: no separators, no traversal.
SAFE_FILENAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$")
_CHUNK = 1024 * 1024


class ImportRefused(RuntimeError):
    """The whole import cannot run (bad arguments, missing users, unsupported mode)."""


class RowRefused(Exception):
    """One row of a dataset listing is refused; nothing was written for it."""

    def __init__(self, code: str, message: str, **details) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.details = details


def file_sha256(path: Path) -> str:
    """Streaming SHA-256 of a file (bounded memory)."""
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for block in iter(lambda: fh.read(_CHUNK), b""):
            h.update(block)
    return h.hexdigest()


def safe_member(directory: Path, name: str) -> Path:
    """``directory / name`` for a listed file name, refusing anything that could leave ``directory``."""
    if not SAFE_FILENAME_RE.match(name or "") or ".." in name:
        raise RowRefused("unsafe_filename", "The listed file name is not a plain file name", filename=name)
    root = directory.resolve()
    path = (root / name).resolve()
    if path.parent != root:
        raise RowRefused("unsafe_filename", "The listed file name resolves outside the images directory",
                         filename=name)
    return path


def store_server_file(project_id: str, slide_id: str, path: Path, *, expected_sha256: str, ext: str) -> PutResult:
    """Copy a server-side file into the object store under the slide's generated key (never the file name),
    write-once, hashing while copying. Raises :class:`dermpath.storage.StoreError` and stores nothing when the
    bytes do not hash to ``expected_sha256``."""
    key = slide_key(project_id, slide_id, "original" + ext)
    return get_store().put_if_absent(key, path, expected_sha256=expected_sha256)


def register_slide(db: Session, *, project_id: str, slide_id: str, stored: PutResult, ext: str, block_id: str,
                   level_index: int | None, stain: str | None, scanner_id: str | None, provenance: str,
                   original_filename: str, created_by: str, auto_qc: bool = True) -> tuple[Slide, Job]:
    """Create the slide row for a stored original and enqueue its ``ingest`` job (same idempotency key and payload
    as an upload), in the caller's transaction."""
    slide = Slide(
        id=slide_id, project_id=project_id, block_id=block_id, level_index=level_index, stain=stain,
        scanner_id=scanner_id, provenance=provenance, image_kind="wsi", object_key=stored.key, sha256=stored.sha256,
        bytes=stored.size, format=ext.lstrip("."), ingest_status="pending", original_filename=original_filename,
        identifier_risk_json=filename_flags(original_filename), review_state="imported", created_by=created_by,
    )
    db.add(slide)
    db.flush()
    job, _ = enqueue(db, "ingest", {"slide_id": slide_id, "auto_qc": auto_qc}, idempotency_key=f"ingest:{slide_id}",
                     project_id=project_id, created_by=created_by)
    return slide, job
