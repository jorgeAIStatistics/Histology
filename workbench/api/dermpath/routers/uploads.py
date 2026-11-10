"""Resumable chunked uploads (protocol documented in dermpath.uploads)."""

from __future__ import annotations

from fastapi import APIRouter, Depends, Header, Request, Response
from sqlalchemy.orm import Session

from ..auth import Scope, entity_scope, project_scope
from ..db import get_db
from ..models import Upload
from ..schemas import UploadIn, UploadOut
from ..uploads import cancel_upload, complete_upload, init_upload, receive_chunk, upload_dict

router = APIRouter(tags=["uploads"])


@router.post("/projects/{pid}/uploads", response_model=UploadOut, status_code=201)
def create_upload(body: UploadIn, response: Response, scope: Scope = Depends(project_scope("upload.write")),
                  db: Session = Depends(get_db)):
    u, resumed = init_upload(
        db, scope.actor, scope.project_id, filename=body.filename, size=body.size, sha256=body.sha256,
        provenance=body.provenance, kind_hint=body.kind_hint, block_id=body.block_id,
        new_hierarchy=body.new_hierarchy.model_dump(mode="json") if body.new_hierarchy else None,
        level_index=body.level_index, stain=body.stain, scanner_id=body.scanner_id,
        governance_attestation=body.governance_attestation)
    db.commit()
    if resumed:
        response.status_code = 200
    return {**upload_dict(u), "resumed": resumed}


@router.get("/uploads/{id}", response_model=UploadOut)
def get_upload(scope: Scope = Depends(entity_scope("upload.write", Upload)), db: Session = Depends(get_db)):
    """Resume point: ``received_bytes`` and ``next_chunk_index``."""
    return upload_dict(scope.obj)


@router.put("/uploads/{id}/chunks/{index}", response_model=UploadOut)
async def put_chunk(index: int, request: Request, x_chunk_sha256: str | None = Header(None),
                    scope: Scope = Depends(entity_scope("upload.write", Upload)), db: Session = Depends(get_db)):
    """Raw chunk bytes as the body; ``X-Chunk-SHA256`` = hex sha256 of the chunk."""
    return await receive_chunk(db, scope.actor, scope.obj, index, x_chunk_sha256, request.stream())


@router.post("/uploads/{id}/complete", response_model=UploadOut)
def complete(scope: Scope = Depends(entity_scope("upload.write", Upload)), db: Session = Depends(get_db)):
    """Verify the whole-file sha256, detect duplicates, create the slide and enqueue ``ingest``."""
    return complete_upload(db, scope.actor, scope.obj)


@router.delete("/uploads/{id}", response_model=UploadOut)
def cancel(scope: Scope = Depends(entity_scope("upload.write", Upload)), db: Session = Depends(get_db)):
    return cancel_upload(db, scope.actor, scope.obj)
