"""FastAPI application factory.

Run: ``uvicorn dermpath.main:app --port 8000`` (from workbench/api, with the venv).

Middleware (pure ASGI, so streamed upload bodies are untouched):
* correlation id: incoming ``X-Request-Id`` (if well-formed) or a new one; echoed on every
  response and recorded on audit events;
* fail-closed mode guard: if ``WB_MODE`` is not ``demo``, every route except
  ``GET /api/v1/health`` returns 503 ``mode_not_implemented``;
* origin check: state-changing requests carrying an ``Origin`` header must come from an
  allowed origin (``WB_CORS_ORIGINS``) or the API's own origin (CSRF defence in addition
  to SameSite=Lax cookies);
* security headers.

ML ROUTES: ``dermpath/ml/router.py`` (experiments, models) and
``dermpath/ml/router_features.py`` (feature sets) each define ``router`` (an APIRouter) and
are mounted under ``/api/v1`` when present (see :data:`OPTIONAL_ROUTER_MODULES`).
"""

from __future__ import annotations

import importlib
import json
import logging
from contextlib import asynccontextmanager

from fastapi import APIRouter, FastAPI
from fastapi.middleware.cors import CORSMiddleware

from . import __version__
from .config import Settings, ensure_var_dirs, get_settings, set_settings
from .context import new_request_id, reset_request_id, set_request_id
from .errors import error_body, install_error_handlers

log = logging.getLogger("dermpath")

API_PREFIX = "/api/v1"
OPTIONAL_ROUTER_MODULES = ("dermpath.ml.router", "dermpath.ml.router_features")
_UNSAFE = {"POST", "PUT", "PATCH", "DELETE"}
_SECURITY_HEADERS = [
    (b"x-content-type-options", b"nosniff"),
    (b"referrer-policy", b"no-referrer"),
    (b"x-frame-options", b"DENY"),
]


class CoreMiddleware:
    def __init__(self, app) -> None:
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        headers = {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in scope.get("headers", [])}
        rid = new_request_id(headers.get("x-request-id"))
        token = set_request_id(rid)
        try:
            settings = get_settings()
            path = scope.get("path", "")
            if not settings.mode_supported and path != f"{API_PREFIX}/health":
                return await self._reject(send, rid, 503, "mode_not_implemented",
                                          f"WB_MODE={settings.mode} is not implemented; this API refuses every "
                                          "request except GET /api/v1/health (fail closed).")
            origin = headers.get("origin")
            if scope.get("method") in _UNSAFE and origin:
                host = headers.get("host", "")
                own = {f"http://{host}", f"https://{host}"}
                if origin not in settings.cors_origins and origin not in own:
                    return await self._reject(send, rid, 403, "origin_rejected",
                                              "State-changing requests from this origin are not allowed")

            async def send_wrapper(message):
                if message["type"] == "http.response.start":
                    hdrs = list(message.get("headers", []))
                    hdrs.append((b"x-request-id", rid.encode()))
                    names = {k.lower() for k, _ in hdrs}
                    hdrs.extend(h for h in _SECURITY_HEADERS if h[0] not in names)
                    if b"cache-control" not in names:
                        hdrs.append((b"cache-control", b"no-store"))
                    message["headers"] = hdrs
                await send(message)

            await self.app(scope, receive, send_wrapper)
        finally:
            reset_request_id(token)

    @staticmethod
    async def _reject(send, rid: str, status: int, code: str, message: str) -> None:
        body = json.dumps(error_body(code, message)).encode()
        await send({"type": "http.response.start", "status": status,
                    "headers": [(b"content-type", b"application/json"), (b"x-request-id", rid.encode()),
                                (b"content-length", str(len(body)).encode())] + _SECURITY_HEADERS})
        await send({"type": "http.response.body", "body": body})


def _bootstrap(settings: Settings) -> None:
    if not settings.mode_supported:
        log.error("WB_MODE=%s is not implemented: refusing all routes except /health", settings.mode)
        return
    from .config import resolve_secret
    from .db import init_db
    from .jobs.registry import load_handlers

    ensure_var_dirs(settings)
    resolve_secret(settings)
    init_db()
    load_handlers()
    if settings.auto_seed:
        from .seed import seed_if_empty

        seed_if_empty()


def include_optional_routers(api: APIRouter) -> dict[str, str]:
    report = {}
    for mod in OPTIONAL_ROUTER_MODULES:
        try:
            m = importlib.import_module(mod)
        except ModuleNotFoundError as exc:
            if exc.name and mod.startswith(exc.name):
                report[mod] = "not_present"
                continue
            raise
        api.include_router(m.router)
        report[mod] = "mounted"
    return report


def create_app(settings: Settings | None = None) -> FastAPI:
    if settings is not None:
        set_settings(settings)
    settings = get_settings()

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        _bootstrap(get_settings())
        yield
        try:
            from .slides.tiles import get_tile_service

            get_tile_service().clear()
        except Exception:  # pragma: no cover
            pass

    app = FastAPI(
        title="DermPath Research Workbench API (research use only)",
        version=__version__,
        description=("Research-use-only computational-pathology prototype. Not a medical device; makes no "
                     "diagnostic claim. Demo mode uses a role switch, not authentication."),
        openapi_url=f"{API_PREFIX}/openapi.json",
        docs_url=f"{API_PREFIX}/docs",
        redoc_url=None,
        lifespan=lifespan,
    )
    install_error_handlers(app)
    from .routers import annotations, auth, datasets, demo, health, jobs, labels, projects, qc, slides, uploads

    api = APIRouter(prefix=API_PREFIX)
    for r in (health, auth, projects, uploads, slides, qc, annotations, labels, datasets, jobs, demo):
        api.include_router(r.router)
    app.state.optional_routers = include_optional_routers(api)
    app.include_router(api)
    app.add_middleware(CoreMiddleware)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(settings.cors_origins),
        allow_credentials=True,
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        allow_headers=["content-type", "x-chunk-sha256", "x-request-id"],
        expose_headers=["x-request-id"],
    )
    return app


app = create_app()
