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

FENCING DOMAIN COMMITS
----------------------
A worker can lose its lease (crash recovery reclaims the job) while its handler is still
running. A handler's final domain commit must therefore be fenced::

    with ctx.session() as db:
        ...write the domain rows...
        ctx.assert_lease(db)   # same transaction; raises LeaseLost if no longer the owner

:func:`assert_lease` performs a conditional ``UPDATE`` of the job row (owner, attempt,
retry count, status ``running``) inside the caller's transaction, so on both SQLite and
PostgreSQL a concurrent reclaim waits for this commit or makes it fail.

SETTLE HOOKS
------------
When a job ends ``failed`` or ``canceled`` outside its handler's control (lease expired
after a crash, retries exhausted, permanent error, cancel), its domain row must follow
(for example ``TrainingRun.status``, ``feature_set.status``). Register a hook per job
type::

    @register_settle_hook("train")
    def settle_train(db, job, status, error):  # status: "failed" | "canceled"
        ...set the domain row's status if it is not terminal yet (idempotent)...

Hooks run inside the transaction that settles the job row, each in a SAVEPOINT; a hook
that raises is logged and rolled back to its savepoint and never blocks the queue.
"""

from __future__ import annotations

import importlib
import logging
from collections.abc import Callable
from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import Any

from sqlalchemy.orm import Session

from ..config import get_settings
from ..db import session_scope

log = logging.getLogger("dermpath.jobs")

OPTIONAL_HANDLER_MODULES = ("dermpath.ml.jobs", "dermpath.ml.feature_sets", "dermpath.ml.inference")
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


#: ``fn(db, job, status, error)`` with status ``failed`` or ``canceled``.
SettleHook = Callable[[Session, Any, str, "str | None"], None]
SETTLE_HOOKS: dict[str, list[SettleHook]] = {}
SETTLE_STATUSES = ("failed", "canceled")


def register_settle_hook(job_type: str, fn: SettleHook | None = None):
    """Register ``fn`` to settle the domain row of ``job_type`` jobs that end failed or
    canceled. Usable as ``register_settle_hook("train", fn)`` or as a decorator."""

    def deco(func: SettleHook) -> SettleHook:
        hooks = SETTLE_HOOKS.setdefault(job_type, [])
        if func not in hooks:
            hooks.append(func)
        return func

    return deco(fn) if fn is not None else deco


def run_settle_hooks(db: Session, job, status: str, error: str | None) -> int:
    """Run the settle hooks of ``job.type`` in ``db`` (one SAVEPOINT each). Returns the
    number of hooks that completed; failures are logged, never raised."""
    if status not in SETTLE_STATUSES:
        return 0
    load_handlers()  # hooks are registered by handler modules
    done = 0
    for fn in list(SETTLE_HOOKS.get(job.type, ())):
        try:
            with db.begin_nested():
                fn(db, job, status, error)
            done += 1
        except Exception:
            log.exception("settle hook %s for job %s (%s -> %s) failed", getattr(fn, "__name__", fn), job.id,
                          job.type, status)
    return done


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
    retry_count: int = 0
    _lease_lost: Callable[[], bool] = field(repr=False, default=lambda: False)

    def progress(self, fraction: float | None = None, message: str | None = None) -> None:
        """Report progress and heartbeat. Raises JobCanceled / LeaseLost."""
        cancel = self._progress_cb(fraction, message)
        if cancel:
            raise JobCanceled("cancel requested")

    def check_canceled(self) -> None:
        self.progress(None, None)

    def assert_lease(self, db: Session | None = None) -> None:
        """See :func:`assert_lease`."""
        assert_lease(self, db)

    @contextmanager
    def session(self):
        with session_scope() as db:
            yield db


def assert_lease(ctx: JobContext, db: Session | None = None) -> None:
    """Raise :class:`LeaseLost` unless this attempt still owns its job.

    The job row must be ``running``, leased by ``ctx.worker_id``, on the same attempt and
    retry count as when it was claimed. Pass the session of the domain commit: the check is
    a conditional UPDATE (it also renews the lease) inside that transaction, so it fences
    the commit. Without ``db`` it is only a point-in-time check in its own transaction.
    """
    from . import queue

    if ctx._lease_lost():
        raise LeaseLost(f"job {ctx.job_id}: lease lost (observed by the heartbeat)")
    if db is not None:
        owned = queue.fence_lease(db, ctx.job_id, ctx.worker_id, attempt=ctx.attempt, retry_count=ctx.retry_count)
    else:
        with session_scope() as own:
            owned = queue.fence_lease(own, ctx.job_id, ctx.worker_id, attempt=ctx.attempt,
                                      retry_count=ctx.retry_count)
    if not owned:
        raise LeaseLost(f"job {ctx.job_id}: attempt {ctx.attempt} of worker {ctx.worker_id} no longer holds the lease")
