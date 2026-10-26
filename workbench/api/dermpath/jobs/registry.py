"""Job handler registry.

HOW TO ADD A HANDLER (for the ML pass and others)
-------------------------------------------------
1. Create a module, e.g. ``dermpath/ml/jobs.py``::

       from dermpath.jobs.registry import register, JobContext, PermanentJobError

       @register("train", description="Train a research head on a frozen dataset")
       def train(ctx: JobContext, payload: dict) -> dict:
           with ctx.session() as db:          # a fresh transactional session
               ...
           ctx.progress(0.5, "epoch 3/6")     # heartbeats; raises JobCanceled on cancel
           return {"checkpoint_key": "..."}   # stored as job.result_json

2. Make sure the module is imported by workers: ``dermpath.ml.jobs`` is already listed in
   :data:`OPTIONAL_HANDLER_MODULES` (imported if it exists); other modules can be added
   with ``WB_EXTRA_HANDLER_MODULES=pkg.module,other.module``.

3. Enqueue from a router with :func:`dermpath.jobs.queue.enqueue` and a deterministic
   ``idempotency_key`` (e.g. ``f"train:{run_id}"``).

Error semantics: raise :class:`PermanentJobError` for deterministic failures (bad input,
corrupt file); the job fails at once. Any other exception is retried with exponential
backoff up to ``max_attempts``. Handlers must be idempotent: after a crash the same job
can run again from the start.
"""

from __future__ import annotations

import importlib
import logging
from collections.abc import Callable
from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import Any

from ..config import get_settings
from ..db import session_scope

log = logging.getLogger("dermpath.jobs")

OPTIONAL_HANDLER_MODULES = ("dermpath.ml.jobs",)
BUILTIN_HANDLER_MODULES = ("dermpath.jobs.builtin",)


class PermanentJobError(Exception):
    """A deterministic failure: do not retry."""


class JobCanceled(Exception):
    pass


class LeaseLost(Exception):
    pass


@dataclass
class HandlerSpec:
    type: str
    func: Callable[["JobContext", dict], dict | None]
    description: str = ""


HANDLERS: dict[str, HandlerSpec] = {}


def register(job_type: str, *, description: str = "") -> Callable:
    def deco(func: Callable[["JobContext", dict], dict | None]):
        HANDLERS[job_type] = HandlerSpec(type=job_type, func=func, description=description)
        return func

    return deco


_loaded = False
_load_report: dict[str, str] = {}


def load_handlers(force: bool = False) -> dict[str, str]:
    """Import built-in and optional handler modules. Returns ``{module: status}``."""
    global _loaded
    if _loaded and not force:
        return dict(_load_report)
    for mod in BUILTIN_HANDLER_MODULES:
        importlib.import_module(mod)
        _load_report[mod] = "loaded"
    for mod in OPTIONAL_HANDLER_MODULES + tuple(get_settings().extra_handler_modules):
        try:
            importlib.import_module(mod)
            _load_report[mod] = "loaded"
        except ModuleNotFoundError as exc:
            if exc.name and mod.startswith(exc.name):
                _load_report[mod] = "not_present"
            else:
                _load_report[mod] = f"import_error: {exc}"
                log.exception("handler module %s failed to import", mod)
        except Exception as exc:  # pragma: no cover - surfaced in /health
            _load_report[mod] = f"import_error: {type(exc).__name__}: {exc}"
            log.exception("handler module %s failed to import", mod)
    _loaded = True
    return dict(_load_report)


def get_handler(job_type: str) -> HandlerSpec | None:
    load_handlers()
    return HANDLERS.get(job_type)


@dataclass
class JobContext:
    job_id: str
    type: str
    project_id: str | None
    payload: dict[str, Any]
    attempt: int
    worker_id: str
    created_by: str | None
    _progress_cb: Callable[[float | None, str | None], bool] = field(repr=False, default=lambda p, m: False)

    def progress(self, fraction: float | None = None, message: str | None = None) -> None:
        """Report progress and heartbeat. Raises JobCanceled / LeaseLost."""
        cancel = self._progress_cb(fraction, message)
        if cancel:
            raise JobCanceled("cancel requested")

    def check_canceled(self) -> None:
        self.progress(None, None)

    @contextmanager
    def session(self):
        with session_scope() as db:
            yield db
