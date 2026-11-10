"""HMAC-SHA256 signed, expiring tokens.

Format: ``v1.<base64url(json payload)>.<base64url(hmac)>``. Each use (session cookie,
slide access token) derives its own key from the master secret with a context string,
so a token minted for one purpose never verifies for another.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time
from typing import Any

from .config import get_settings, resolve_secret

_cache: dict[tuple[bytes, str], bytes] = {}


class TokenError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def _b64e(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _b64d(text: str) -> bytes:
    pad = "=" * (-len(text) % 4)
    return base64.urlsafe_b64decode(text + pad)


def derived_key(context: str) -> bytes:
    master = resolve_secret(get_settings())
    k = (master, context)
    if k not in _cache:
        _cache[k] = hmac.new(master, b"dermpath:" + context.encode(), hashlib.sha256).digest()
    return _cache[k]


def sign(payload: dict[str, Any], context: str) -> str:
    body = _b64e(json.dumps(payload, separators=(",", ":"), sort_keys=True).encode())
    mac = hmac.new(derived_key(context), ("v1." + body).encode(), hashlib.sha256).digest()
    return f"v1.{body}.{_b64e(mac)}"


def verify(token: str, context: str, *, now: float | None = None) -> dict[str, Any]:
    if not token or len(token) > 2048:
        raise TokenError("token_malformed", "Token is missing or too long")
    parts = token.split(".")
    if len(parts) != 3 or parts[0] != "v1":
        raise TokenError("token_malformed", "Token is malformed")
    try:
        mac = _b64d(parts[2])
    except Exception as exc:
        raise TokenError("token_malformed", "Token is malformed") from exc
    expected = hmac.new(derived_key(context), ("v1." + parts[1]).encode(), hashlib.sha256).digest()
    if not hmac.compare_digest(mac, expected):
        raise TokenError("token_invalid", "Token signature is invalid")
    try:
        payload = json.loads(_b64d(parts[1]))
    except Exception as exc:
        raise TokenError("token_malformed", "Token payload is malformed") from exc
    exp = payload.get("exp")
    if not isinstance(exp, (int, float)):
        raise TokenError("token_malformed", "Token has no expiry")
    if (now if now is not None else time.time()) >= exp:
        raise TokenError("token_expired", "Token has expired")
    return payload
