"""Uniform error envelope.

Every error response has the shape::

    {"error": {"code": "<machine_code>", "message": "<human text>", "details": {...}},
     "request_id": "<correlation id>"}

``code`` is stable and meant for the frontend; ``message`` is readable and safe to show.
Dependency problems use HTTP 503 with ``code="dependency_unavailable"`` and
``details.dependency`` naming the missing piece.
"""

from __future__ import annotations

from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from .context import get_request_id
from .models import FrozenDatasetError, ImmutableRecordError


class ApiError(Exception):
    def __init__(self, http_status: int, code: str, message: str, /, **details: Any) -> None:
        super().__init__(message)
        self.status = http_status
        self.code = code
        self.message = message
        self.details = details


def not_found(entity: str, entity_id: str | None = None) -> ApiError:
    return ApiError(404, "not_found", f"{entity} not found", entity=entity, id=entity_id)


def forbidden(code: str, message: str, /, **details: Any) -> ApiError:
    return ApiError(403, code, message, **details)


def conflict(code: str, message: str, /, **details: Any) -> ApiError:
    return ApiError(409, code, message, **details)


def unprocessable(code: str, message: str, /, **details: Any) -> ApiError:
    return ApiError(422, code, message, **details)


def dependency_unavailable(dependency: str, message: str, /, **details: Any) -> ApiError:
    return ApiError(503, "dependency_unavailable", message, dependency=dependency, **details)


def error_body(code: str, message: str, details: dict | None = None) -> dict:
    body: dict[str, Any] = {"error": {"code": code, "message": message}}
    if details:
        body["error"]["details"] = details
    body["request_id"] = get_request_id()
    return body


def _json(status: int, code: str, message: str, details: dict | None = None) -> JSONResponse:
    return JSONResponse(status_code=status, content=error_body(code, message, details))


def install_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(ApiError)
    async def _api_error(_request: Request, exc: ApiError):
        return _json(exc.status, exc.code, exc.message, exc.details or None)

    @app.exception_handler(FrozenDatasetError)
    async def _frozen(_request: Request, exc: FrozenDatasetError):
        return _json(409, "dataset_frozen", str(exc))

    @app.exception_handler(ImmutableRecordError)
    async def _immutable(_request: Request, exc: ImmutableRecordError):
        return _json(409, "immutable_record", str(exc))

    from .storage import StoreDependencyError

    @app.exception_handler(StoreDependencyError)
    async def _store_dependency(_request: Request, exc: StoreDependencyError):
        return _json(503, "dependency_unavailable", str(exc), {"dependency": exc.dependency})

    @app.exception_handler(RequestValidationError)
    async def _validation(_request: Request, exc: RequestValidationError):
        errors = []
        for err in exc.errors():
            errors.append(
                {
                    "loc": [str(p) for p in err.get("loc", ())],
                    "msg": err.get("msg"),
                    "type": err.get("type"),
                }
            )
        return _json(422, "validation_error", "Request validation failed", {"errors": errors})

    @app.exception_handler(StarletteHTTPException)
    async def _http(_request: Request, exc: StarletteHTTPException):
        code = {404: "not_found", 405: "method_not_allowed", 401: "unauthenticated"}.get(
            exc.status_code, "http_error"
        )
        return _json(exc.status_code, code, str(exc.detail))

    @app.exception_handler(Exception)
    async def _unhandled(_request: Request, exc: Exception):  # pragma: no cover - defensive
        import logging

        logging.getLogger("dermpath").exception("unhandled error")
        return _json(500, "internal_error", "Internal error; see server log with the request id")
