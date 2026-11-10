"""Append-only audit events.

Call :func:`record` inside the same transaction as the write it describes, so the event
and the change commit (or roll back) together. ``before``/``after`` are scrubbed: keys
that could carry credentials, tokens or file contents are dropped, binary values are
refused, and long strings are truncated. Pixels never reach the audit log.
"""

from __future__ import annotations

from datetime import date, datetime
from typing import Any

from sqlalchemy.orm import Session

from .context import get_request_id
from .models import AuditEvent

_DENY_KEY_FRAGMENTS = (
    "password",
    "secret",
    "token",
    "cookie",
    "credential",
    "authorization",
    "pixels",
    "content",
    "bytes_b64",
    "data_b64",
    "image_data",
)
_MAX_STR = 500
_MAX_ITEMS = 50


def _scrub(value: Any, depth: int = 0) -> Any:
    if depth > 6:
        return "<truncated: depth>"
    if value is None or isinstance(value, (bool, int, float)):
        return value
    if isinstance(value, (bytes, bytearray, memoryview)):
        return "<binary omitted>"
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, str):
        return value if len(value) <= _MAX_STR else value[:_MAX_STR] + "…<truncated>"
    if isinstance(value, dict):
        out = {}
        for k, v in list(value.items())[:_MAX_ITEMS]:
            ks = str(k)
            if any(frag in ks.lower() for frag in _DENY_KEY_FRAGMENTS):
                out[ks] = "<redacted>"
            else:
                out[ks] = _scrub(v, depth + 1)
        return out
    if isinstance(value, (list, tuple, set)):
        items = list(value)
        out_list = [_scrub(v, depth + 1) for v in items[:_MAX_ITEMS]]
        if len(items) > _MAX_ITEMS:
            out_list.append(f"<{len(items) - _MAX_ITEMS} more items omitted>")
        return out_list
    return str(value)[:_MAX_STR]


def record(
    db: Session,
    *,
    action: str,
    entity_type: str,
    entity_id: str | None,
    actor_id: str | None,
    actor_role: str | None,
    project_id: str | None,
    before: Any = None,
    after: Any = None,
    reason: str | None = None,
    correlation_id: str | None = None,
) -> AuditEvent:
    ev = AuditEvent(
        actor_id=actor_id,
        actor_role=actor_role,
        project_id=project_id,
        action=action,
        entity_type=entity_type,
        entity_id=entity_id,
        before_json=_scrub(before) if before is not None else None,
        after_json=_scrub(after) if after is not None else None,
        reason=(reason[:2000] if reason else None),
        correlation_id=correlation_id or get_request_id(),
    )
    db.add(ev)
    return ev


def record_for(db: Session, actor, *, project_id: str | None, **kwargs) -> AuditEvent:
    """Convenience wrapper taking an ``Actor`` (see :mod:`dermpath.auth`)."""
    return record(
        db,
        actor_id=getattr(actor, "id", None),
        actor_role=getattr(actor, "role", None),
        project_id=project_id,
        **kwargs,
    )


SYSTEM_WORKER = "system:worker"
SYSTEM_SEED = "system:seed"
