"""SQLAlchemy engine, sessions and schema bootstrap.

SQLite (WAL) is the local default; any SQLAlchemy URL works through ``WB_DATABASE_URL``
(PostgreSQL is the intended production path, unverified here). The models use only
portable column types; SQLite-specific behaviour is confined to connection PRAGMAs in
this module.

Schema management is ``create_all`` plus an explicit ``schema_version`` table. There
are no migrations: when the stored version differs from :data:`SCHEMA_VERSION`, startup
fails with an instruction to reset the demo database.
"""

from __future__ import annotations

import threading
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime

from sqlalchemy import DateTime, Engine, Integer, String, create_engine, event, select
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column, sessionmaker
from sqlalchemy.types import TypeDecorator

from .config import ensure_var_dirs, get_settings

#: Bump when models change incompatibly. v1: backend core. The ML pass adds tables
#: (registered on the same Base) and bumps this to 2 when it lands.
SCHEMA_VERSION = 1


def utcnow() -> datetime:
    return datetime.now(UTC)


class UTCDateTime(TypeDecorator):
    """Timezone-aware UTC datetimes on every backend (SQLite drops tzinfo)."""

    impl = DateTime(timezone=True)
    cache_ok = True

    def process_bind_param(self, value, dialect):
        if value is None:
            return None
        if value.tzinfo is None:
            value = value.replace(tzinfo=UTC)
        return value.astimezone(UTC)

    def process_result_value(self, value, dialect):
        if value is None:
            return None
        if value.tzinfo is None:
            return value.replace(tzinfo=UTC)
        return value.astimezone(UTC)


class Base(DeclarativeBase):
    pass


class SchemaVersion(Base):
    __tablename__ = "schema_version"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    version: Mapped[int] = mapped_column(Integer, nullable=False)
    description: Mapped[str] = mapped_column(String(200), nullable=False)
    applied_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow, nullable=False)


_engine: Engine | None = None
_SessionLocal: sessionmaker[Session] | None = None
_lock = threading.Lock()


def _configure_sqlite(engine: Engine) -> None:
    @event.listens_for(engine, "connect")
    def _pragmas(dbapi_conn, _record):  # pragma: no cover - exercised implicitly
        cur = dbapi_conn.cursor()
        cur.execute("PRAGMA journal_mode=WAL")
        cur.execute("PRAGMA foreign_keys=ON")
        cur.execute("PRAGMA busy_timeout=10000")
        cur.execute("PRAGMA synchronous=NORMAL")
        cur.close()


def get_engine() -> Engine:
    global _engine, _SessionLocal
    if _engine is not None:
        return _engine
    with _lock:
        if _engine is None:
            settings = get_settings()
            url = settings.db_url
            kwargs: dict = {"future": True}
            if url.startswith("sqlite"):
                ensure_var_dirs(settings)
                kwargs["connect_args"] = {"check_same_thread": False, "timeout": 10}
            else:
                kwargs["pool_pre_ping"] = True
            engine = create_engine(url, **kwargs)
            if url.startswith("sqlite"):
                _configure_sqlite(engine)
            _engine = engine
            _SessionLocal = sessionmaker(bind=engine, expire_on_commit=False, autoflush=True)
    return _engine


def reset_engine() -> None:
    global _engine, _SessionLocal
    with _lock:
        if _engine is not None:
            _engine.dispose()
        _engine = None
        _SessionLocal = None


def SessionLocal() -> Session:
    get_engine()
    assert _SessionLocal is not None
    return _SessionLocal()


@contextmanager
def session_scope() -> Iterator[Session]:
    """Transactional scope for scripts and the worker: commit on success, rollback on error."""
    db = SessionLocal()
    try:
        yield db
        db.commit()
    except BaseException:
        db.rollback()
        raise
    finally:
        db.close()


def get_db() -> Iterator[Session]:
    """FastAPI dependency: one session per request; routers commit explicitly."""
    db = SessionLocal()
    try:
        yield db
    except BaseException:
        db.rollback()
        raise
    finally:
        db.close()


def import_all_models() -> None:
    """Import every module that registers tables on :class:`Base`.

    ML TABLES (FeatureArtifact, TrainingRun, Prediction, Evaluation, ModelVersion) are
    defined by the ML pass in ``dermpath/ml/models.py`` on this same ``Base``; they are
    picked up here automatically once that module exists.
    """
    from . import models  # noqa: F401

    try:
        from .ml import models as _ml_models  # noqa: F401
    except ModuleNotFoundError as exc:  # ML pass not installed yet
        if exc.name not in ("dermpath.ml", "dermpath.ml.models"):
            raise


class SchemaMismatchError(RuntimeError):
    pass


def init_db(engine: Engine | None = None) -> None:
    """Create all tables and record/verify the schema version."""
    engine = engine or get_engine()
    import_all_models()
    Base.metadata.create_all(engine)
    with Session(engine) as db:
        row = db.scalars(select(SchemaVersion).order_by(SchemaVersion.id.desc())).first()
        if row is None:
            db.add(SchemaVersion(version=SCHEMA_VERSION, description="create_all bootstrap"))
            db.commit()
        elif row.version != SCHEMA_VERSION:
            raise SchemaMismatchError(
                f"Database schema version {row.version} does not match code version "
                f"{SCHEMA_VERSION}. There are no migrations in this prototype: reset the demo "
                f"database with `python -m dermpath.seed --reset`."
            )


def drop_all(engine: Engine | None = None) -> None:
    engine = engine or get_engine()
    import_all_models()
    Base.metadata.drop_all(engine)


def current_schema_version(db: Session) -> int | None:
    row = db.scalars(select(SchemaVersion).order_by(SchemaVersion.id.desc())).first()
    return row.version if row else None
