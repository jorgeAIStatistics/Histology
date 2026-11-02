"""Per-request correlation id (``X-Request-Id``), available to audit and error handlers."""

from __future__ import annotations

import re
import uuid
from contextvars import ContextVar

_request_id: ContextVar[str | None] = ContextVar("request_id", default=None)
_SAFE_ID = re.compile(r"^[A-Za-z0-9._:-]{8,64}$")


def new_request_id(incoming: str | None = None) -> str:
    """Accept a well-formed incoming id (so a client can correlate), else generate one."""
    if incoming and _SAFE_ID.match(incoming):
        return incoming
    return "req-" + uuid.uuid4().hex


def set_request_id(value: str | None):
    return _request_id.set(value)


def reset_request_id(token) -> None:
    _request_id.reset(token)


def get_request_id() -> str | None:
    return _request_id.get()
