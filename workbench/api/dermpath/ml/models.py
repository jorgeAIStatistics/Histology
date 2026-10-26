"""ML tables: FeatureArtifact, TrainingRun, Prediction, Evaluation, ModelVersion.

Registered on the core ``Base``; :func:`dermpath.db.import_all_models` imports this module,
so ``create_all`` adds these tables to an existing schema-v1 database without touching the
core tables (the core ``SCHEMA_VERSION`` stays 1).

Immutability (ORM guard below, plus SQLite triggers):
* ``Prediction`` and ``Evaluation`` are append-only (no update, no delete).
* ``FeatureArtifact`` rows never change once written (a cache entry is a fact).
* A ``TrainingRun`` whose committed status is ``succeeded`` rejects every change; before
  that, only the worker's own status/output writes happen.
* ``ModelVersion`` may change only its ``status`` and only among :data:`MODEL_STATUSES`
  (``deployed`` does not exist).
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import (
    DDL,
    JSON,
    BigInteger,
    Boolean,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    event,
    inspect,
)
from sqlalchemy.orm import Mapped, Session, mapped_column

from ..db import Base, UTCDateTime, utcnow
from ..models import ImmutableRecordError, new_id

RUN_STATUSES = ("queued", "running", "succeeded", "failed", "canceled")
MODEL_STATUSES = ("research_candidate", "retired")


class FeatureArtifact(Base):
    """Cached patch embeddings for one slide under one extraction configuration."""

    __tablename__ = "feature_artifact"
    __table_args__ = (UniqueConstraint("project_id", "cache_key"),)

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    project_id: Mapped[str] = mapped_column(ForeignKey("project.id"), nullable=False, index=True)
    slide_id: Mapped[str] = mapped_column(ForeignKey("slide.id"), nullable=False, index=True)
    # Cache key components (the key is sha256 over all of them, canonical JSON).
    slide_sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    encoder_id: Mapped[str] = mapped_column(String(64), nullable=False)
    weights_sha256: Mapped[str] = mapped_column(String(80), nullable=False)
    preprocessing_version: Mapped[str] = mapped_column(String(200), nullable=False)
    patch_size: Mapped[int] = mapped_column(Integer, nullable=False)
    scale_key: Mapped[str] = mapped_column(String(80), nullable=False)  # "mpp=0.5" | "level=1(ds=4)"
    coords_sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    key_extra_json: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    cache_key: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    # Payload
    object_key: Mapped[str] = mapped_column(String(300), nullable=False)
    sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    bytes: Mapped[int] = mapped_column(BigInteger, nullable=False)
    n_patches: Mapped[int] = mapped_column(Integer, nullable=False)
    embedding_dim: Mapped[int] = mapped_column(Integer, nullable=False)
    calibrated: Mapped[bool] = mapped_column(Boolean, nullable=False)
    synthetic: Mapped[bool] = mapped_column(Boolean, nullable=False)
    stats_json: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    job_id: Mapped[str | None] = mapped_column(String(32))
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow, nullable=False)


class TrainingRun(Base):
    __tablename__ = "training_run"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    project_id: Mapped[str] = mapped_column(ForeignKey("project.id"), nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    dataset_version_id: Mapped[str] = mapped_column(ForeignKey("dataset_version.id"), nullable=False, index=True)
    dataset_manifest_sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    encoder_id: Mapped[str] = mapped_column(String(64), nullable=False)
    head: Mapped[str] = mapped_column(String(32), nullable=False)
    params_json: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    seed: Mapped[int] = mapped_column(Integer, nullable=False)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="queued")
    job_id: Mapped[str | None] = mapped_column(String(32))
    synthetic: Mapped[bool] = mapped_column(Boolean, nullable=False)
    synthetic_reasons_json: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    label_scope: Mapped[str] = mapped_column(String(16), nullable=False)
    positive_class: Mapped[str] = mapped_column(String(40), nullable=False)
    negative_class: Mapped[str] = mapped_column(String(40), nullable=False)
    # provenance
    code_revision: Mapped[str | None] = mapped_column(String(80))
    deps_json: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    weights_sha256: Mapped[str | None] = mapped_column(String(80))
    # outputs
    checkpoint_key: Mapped[str | None] = mapped_column(String(300))
    checkpoint_sha256: Mapped[str | None] = mapped_column(String(64))
    checkpoint_bytes: Mapped[int | None] = mapped_column(BigInteger)
    threshold_value: Mapped[float | None] = mapped_column(Float)
    threshold_rule: Mapped[str | None] = mapped_column(String(40))
    threshold_frozen_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    threshold_json: Mapped[dict | None] = mapped_column(JSON)
    split_counts_json: Mapped[dict | None] = mapped_column(JSON)
    metrics_json: Mapped[dict | None] = mapped_column(JSON)
    provenance_json: Mapped[dict | None] = mapped_column(JSON)
    # record
    created_by: Mapped[str] = mapped_column(String(64), nullable=False)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow, nullable=False)
    started_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    finished_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    error: Mapped[str | None] = mapped_column(Text)


class Prediction(Base):
    """One scored bag (a slide, or a case for case-level labels). Append-only."""

    __tablename__ = "prediction"
    __table_args__ = (UniqueConstraint("run_id", "split", "bag_id"), Index("ix_prediction_run_split", "run_id", "split"))

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    run_id: Mapped[str] = mapped_column(ForeignKey("training_run.id"), nullable=False)
    project_id: Mapped[str] = mapped_column(ForeignKey("project.id"), nullable=False, index=True)
    split: Mapped[str] = mapped_column(String(8), nullable=False)  # train (in-sample) | val | test
    bag_kind: Mapped[str] = mapped_column(String(8), nullable=False)  # slide | case
    bag_id: Mapped[str] = mapped_column(String(32), nullable=False)
    slide_ids_json: Mapped[list] = mapped_column(JSON, nullable=False)
    case_id: Mapped[str | None] = mapped_column(String(32))
    coded_patient_id: Mapped[str] = mapped_column(String(32), nullable=False)
    patient_code: Mapped[str | None] = mapped_column(String(32))
    label_value: Mapped[str] = mapped_column(String(40), nullable=False)
    label_version_ids_json: Mapped[list] = mapped_column(JSON, nullable=False)
    label: Mapped[int] = mapped_column(Integer, nullable=False)  # 1 = positive class
    score: Mapped[float] = mapped_column(Float, nullable=False)
    threshold: Mapped[float] = mapped_column(Float, nullable=False)
    predicted: Mapped[int] = mapped_column(Integer, nullable=False)
    abstained: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    attributes_json: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)  # scanner/site/stain
    attention_json: Mapped[list | None] = mapped_column(JSON)  # [[slide_idx, x, y, w, h, weight], ...]
    feature_artifact_ids_json: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow, nullable=False)


class Evaluation(Base):
    """Metrics computed from the run's Prediction rows for one split. Append-only."""

    __tablename__ = "evaluation"
    __table_args__ = (UniqueConstraint("run_id", "split"),)

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    run_id: Mapped[str] = mapped_column(ForeignKey("training_run.id"), nullable=False, index=True)
    project_id: Mapped[str] = mapped_column(ForeignKey("project.id"), nullable=False, index=True)
    split: Mapped[str] = mapped_column(String(8), nullable=False)
    metrics_json: Mapped[dict] = mapped_column(JSON, nullable=False)
    threshold: Mapped[float] = mapped_column(Float, nullable=False)
    threshold_frozen_from: Mapped[str] = mapped_column(String(8), nullable=False, default="val")
    threshold_frozen_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False)
    computed_by: Mapped[str | None] = mapped_column(String(64))
    computed_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow, nullable=False)


class ModelVersion(Base):
    """A research model candidate. There is no deployment state and no deploy path."""

    __tablename__ = "model_version"
    __table_args__ = (UniqueConstraint("run_id"),)

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    project_id: Mapped[str] = mapped_column(ForeignKey("project.id"), nullable=False, index=True)
    run_id: Mapped[str] = mapped_column(ForeignKey("training_run.id"), nullable=False)
    status: Mapped[str] = mapped_column(String(24), nullable=False, default="research_candidate")
    synthetic: Mapped[bool] = mapped_column(Boolean, nullable=False)
    checkpoint_sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    note: Mapped[str | None] = mapped_column(Text)
    created_by: Mapped[str] = mapped_column(String(64), nullable=False)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow, nullable=False)


# --------------------------------------------------------------------------- immutability guards

_APPEND_ONLY = (Prediction, Evaluation, FeatureArtifact)


@event.listens_for(Session, "before_flush")
def _guard_ml(session: Session, flush_context, instances) -> None:
    for obj in list(session.dirty):
        if not session.is_modified(obj, include_collections=False):
            continue
        if isinstance(obj, _APPEND_ONLY):
            raise ImmutableRecordError(f"{type(obj).__name__} rows are immutable")
        if isinstance(obj, TrainingRun):
            committed = inspect(obj).committed_state.get("status", obj.status)
            if committed == "succeeded":
                raise ImmutableRecordError("a completed training run is immutable")
        if isinstance(obj, ModelVersion):
            state = inspect(obj)
            changed = {a.key for a in state.attrs if a.history.has_changes()}
            if changed - {"status"}:
                raise ImmutableRecordError("a model version may change only its status")
    for obj in list(session.new) + list(session.dirty):
        if isinstance(obj, ModelVersion) and obj.status not in MODEL_STATUSES:
            raise ImmutableRecordError(f"model status must be one of {MODEL_STATUSES}; nothing is ever deployed")
    for obj in list(session.deleted):
        if isinstance(obj, _APPEND_ONLY) or isinstance(obj, ModelVersion):
            raise ImmutableRecordError(f"{type(obj).__name__} rows are never deleted")
        if isinstance(obj, TrainingRun) and inspect(obj).committed_state.get("status", obj.status) == "succeeded":
            raise ImmutableRecordError("a completed training run is never deleted")


@event.listens_for(Session, "do_orm_execute")
def _guard_ml_bulk(state) -> None:
    if not (state.is_update or state.is_delete):
        return
    mapper = state.bind_mapper
    if mapper is not None and mapper.class_ in (Prediction, Evaluation, FeatureArtifact, ModelVersion):
        raise ImmutableRecordError(f"bulk UPDATE/DELETE on {mapper.class_.__name__} is not allowed")


_SQLITE_TRIGGERS = {
    Prediction.__table__: [
        "CREATE TRIGGER IF NOT EXISTS prediction_no_update BEFORE UPDATE ON prediction "
        "BEGIN SELECT RAISE(ABORT, 'prediction is append-only'); END",
        "CREATE TRIGGER IF NOT EXISTS prediction_no_delete BEFORE DELETE ON prediction "
        "BEGIN SELECT RAISE(ABORT, 'prediction is append-only'); END",
    ],
    Evaluation.__table__: [
        "CREATE TRIGGER IF NOT EXISTS evaluation_no_update BEFORE UPDATE ON evaluation "
        "BEGIN SELECT RAISE(ABORT, 'evaluation is append-only'); END",
        "CREATE TRIGGER IF NOT EXISTS evaluation_no_delete BEFORE DELETE ON evaluation "
        "BEGIN SELECT RAISE(ABORT, 'evaluation is append-only'); END",
    ],
    TrainingRun.__table__: [
        "CREATE TRIGGER IF NOT EXISTS training_run_completed_update BEFORE UPDATE ON training_run "
        "WHEN OLD.status = 'succeeded' BEGIN SELECT RAISE(ABORT, 'completed training run is immutable'); END",
    ],
    ModelVersion.__table__: [
        "CREATE TRIGGER IF NOT EXISTS model_version_no_delete BEFORE DELETE ON model_version "
        "BEGIN SELECT RAISE(ABORT, 'model versions are never deleted'); END",
        "CREATE TRIGGER IF NOT EXISTS model_version_status_only BEFORE UPDATE ON model_version "
        "WHEN NEW.status NOT IN ('research_candidate', 'retired') OR NEW.run_id != OLD.run_id "
        "OR NEW.checkpoint_sha256 != OLD.checkpoint_sha256 "
        "BEGIN SELECT RAISE(ABORT, 'model version: only status may change; never deployed'); END",
    ],
}
for _table, _stmts in _SQLITE_TRIGGERS.items():
    for _stmt in _stmts:
        event.listen(_table, "after_create", DDL(_stmt).execute_if(dialect="sqlite"))
