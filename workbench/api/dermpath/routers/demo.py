"""Demo reset (admin, demo mode only)."""

from __future__ import annotations

from fastapi import APIRouter, Depends

from ..auth import Actor, current_actor, require_role
from ..config import get_settings
from ..errors import forbidden

router = APIRouter(tags=["demo"])


@router.post("/demo/reset")
def demo_reset(actor: Actor = Depends(current_actor)):
    """Drop and re-seed the demo database and object store. Admin only; demo mode only.
    Synchronous: seeding ingests the fixtures in-process (a few seconds)."""
    require_role(actor, "admin")
    if get_settings().mode != "demo":
        raise forbidden("demo_only", "Reset is only available in demo mode")
    from ..seed import reset_and_seed

    summary = reset_and_seed(actor=actor)
    return {"ok": True, "seed": summary, "note": "All sessions remain valid only if the user ids still exist."}
