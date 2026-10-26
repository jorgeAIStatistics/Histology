"""ML tables: FeatureArtifact, TrainingRun, Prediction, Evaluation, ModelVersion.

Registered on the core ``Base``; :func:`dermpath.db.import_all_models` imports this module.
The engine tables (feature sets, comparison families, test releases, run attempts,
inference bundles, active-learning proposals) live in :mod:`dermpath.ml.engine_models`,
imported first because ``training_run`` references them. Schema version 2 added the
engine columns below; existing databases are reset with ``python -m dermpath.seed --reset``.

Immutability (ORM guard below, plus SQLite triggers):
* ``Prediction`` and ``Evaluation`` are append-only (no update, no delete).
* ``FeatureArtifact`` rows never change once written (a cache entry is a fact) and are
  never deleted. A corrupt or missing object is replaced by a new row with a higher
  ``generation`` under the same ``cache_key``, never by rewriting a row.
* ``TrainingRun`` identity (:data:`RUN_IDENTITY`: dataset version and manifest sha,
  encoder, head, params, seed, classes, label scope, execution mode, feature set,
  identity json/sha, evaluation protocol, ...) never changes once the run is created,
  whatever its status. :data:`RUN_SET_ONCE` columns (``weights_sha256``, ``family_id``,
  ``bundle_id``) may be set once from null and never changed. A run whose stored status
  is ``succeeded`` rejects every change except setting ``bundle_id`` once (registration),
  and is never deleted.
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
    CheckConstraint,
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
from .engine_models import (  # noqa: F401  (registers feature_set, comparison_family, ... first)
    EVALUATION_PROTOCOLS,
    EXECUTION_MODES,
    any_changed,
    changed_columns,
    db_values,
    sql_in,
)

RUN_STATUSES = ("queued", "running", "succeeded", "failed", "canceled")
MODEL_STATUSES = ("research_candidate", "retired")


class FeatureArtifact(Base):
    """Cached patch embeddings for one slide under one extraction configuration."""

    __tablename__ = "feature_artifact"
    __table_args__ = (UniqueConstraint("project_id", "cache_key", "generation", name="uq_feature_artifact_key"),)

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    project_id: Mapped[str] = mapped_column(ForeignKey("project.id"), nullable=False, index=True)
    slide_id: Mapped[str] = mapped_column(ForeignKey("slide.id"), nullable=False, index=True)
    # Cache key components (the key is sha256 over all of them, canonical JSON).
    slide_sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    encoder_id: Mapped[str] = mapped_column(String(64), nullable=False)
    weights_sha256: Mapped[str] = mapped_column(String(160), nullable=False)
    preprocessing_version: Mapped[str] = mapped_column(String(200), nullable=False)
    patch_size: Mapped[int] = mapped_column(Integer, nullable=False)
    scale_key: Mapped[str] = mapped_column(String(80), nullable=False)  # "mpp=0.5" | "level=1(ds=4)"
    coords_sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    key_extra_json: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    cache_key: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    # 0 for the first row of a cache key; a replacement after a missing/corrupt object is +1.
    generation: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    # Engine cache-key components (design §5; null on legacy rows).
    encoder_spec_sha256: Mapped[str | None] = mapped_column(String(64))
    policy_sha256: Mapped[str | None] = mapped_column(String(64))
    stain_policy_sha256: Mapped[str | None] = mapped_column(String(64))
    mask_sha256: Mapped[str | None] = mapped_column(String(64))
    excluded_regions_sha256: Mapped[str | None] = mapped_column(String(64))
    extraction_env_sha256: Mapped[str | None] = mapped_column(String(64))
    device: Mapped[str | None] = mapped_column(String(32))
    precision: Mapped[str | None] = mapped_column(String(16))
    # Payload. Legacy rows: one npz at object_key/sha256. Engine rows: content-addressed,
    # write-once embeddings (.npy float32, memory-mappable) and coords/quality/meta (.npz).
    object_key: Mapped[str] = mapped_column(String(300), nullable=False)
    sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    bytes: Mapped[int] = mapped_column(BigInteger, nullable=False)
    embeddings_key: Mapped[str | None] = mapped_column(String(300))
    embeddings_sha256: Mapped[str | None] = mapped_column(String(64))
    quality_key: Mapped[str | None] = mapped_column(String(300))
    quality_sha256: Mapped[str | None] = mapped_column(String(64))
    n_patches: Mapped[int] = mapped_column(Integer, nullable=False)
    embedding_dim: Mapped[int] = mapped_column(Integer, nullable=False)
    calibrated: Mapped[bool] = mapped_column(Boolean, nullable=False)
    synthetic: Mapped[bool] = mapped_column(Boolean, nullable=False)
    stats_json: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    coverage_json: Mapped[dict | None] = mapped_column(JSON)
    job_id: Mapped[str | None] = mapped_column(String(32))
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow, nullable=False)


class TrainingRun(Base):
    __tablename__ = "training_run"
    __table_args__ = (
        CheckConstraint(sql_in("execution_mode", EXECUTION_MODES), name="ck_training_run_mode"),
        CheckConstraint(sql_in("evaluation_protocol", EVALUATION_PROTOCOLS), name="ck_training_run_protocol"),
    )

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
    # Engine identity (design §6). Null on legacy rows; frozen at creation.
    execution_mode: Mapped[str | None] = mapped_column(String(32))
    feature_set_id: Mapped[str | None] = mapped_column(ForeignKey("feature_set.id"), index=True)
    evaluation_protocol: Mapped[str] = mapped_column(String(16), nullable=False, default="holdout")
    identity_json: Mapped[dict | None] = mapped_column(JSON)
    identity_sha256: Mapped[str | None] = mapped_column(String(64))
    family_id: Mapped[str | None] = mapped_column(ForeignKey("comparison_family.id"), index=True)  # set once
    # provenance
    code_revision: Mapped[str | None] = mapped_column(String(80))
    deps_json: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    weights_sha256: Mapped[str | None] = mapped_column(String(160))  # set once
    # outputs
    checkpoint_key: Mapped[str | None] = mapped_column(String(300))
    checkpoint_sha256: Mapped[str | None] = mapped_column(String(64))
    checkpoint_bytes: Mapped[int | None] = mapped_column(BigInteger)
    threshold_value: Mapped[float | None] = mapped_column(Float)
    threshold_rule: Mapped[str | None] = mapped_column(String(40))
    threshold_frozen_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    threshold_json: Mapped[dict | None] = mapped_column(JSON)
    # Requested method at creation; fitted parameters once selected on development data.
    calibration_json: Mapped[dict | None] = mapped_column(JSON)
    abstention_json: Mapped[dict | None] = mapped_column(JSON)
    split_counts_json: Mapped[dict | None] = mapped_column(JSON)
    metrics_json: Mapped[dict | None] = mapped_column(JSON)
    provenance_json: Mapped[dict | None] = mapped_column(JSON)
    # Set once at registration (an inference_bundle row; no FK: the bundle references the run).
    bundle_id: Mapped[str | None] = mapped_column(String(32))
    # record
    created_by: Mapped[str] = mapped_column(String(64), nullable=False)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow, nullable=False)
    started_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    finished_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    error: Mapped[str | None] = mapped_column(Text)


#: Columns fixed when a run is created; no status allows changing them.
RUN_IDENTITY = frozenset({
    "id", "project_id", "dataset_version_id", "dataset_manifest_sha256", "encoder_id", "head", "params_json",
    "seed", "synthetic", "label_scope", "positive_class", "negative_class", "execution_mode", "feature_set_id",
    "evaluation_protocol", "identity_json", "identity_sha256", "created_by", "created_at",
})
#: Columns that may be set once from null and never changed afterwards.
RUN_SET_ONCE = frozenset({"weights_sha256", "family_id", "bundle_id"})
#: The only change a succeeded run accepts (registration records its bundle).
RUN_SET_AFTER_SUCCESS = frozenset({"bundle_id"})


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
    # Failure-analysis categories (design §7); append-only, so computed before insert.
    failure_categories_json: Mapped[list | None] = mapped_column(JSON)
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


def _guard_training_run(session: Session, run: TrainingRun) -> None:
    old, changed = changed_columns(session, run)
    if not changed:
        return
    identity = changed & RUN_IDENTITY
    if identity:
        raise ImmutableRecordError(f"training run identity is immutable once the run is created: {sorted(identity)} "
                                   "(set it when constructing the run)")
    rewritten = sorted(k for k in changed & RUN_SET_ONCE if old.get(k) is not None)
    if rewritten:
        raise ImmutableRecordError(f"training run columns {rewritten} may be set only once")
    if old.get("status") == "succeeded" and changed - RUN_SET_AFTER_SUCCESS:
        raise ImmutableRecordError("a completed training run is immutable")


@event.listens_for(Session, "before_flush")
def _guard_ml(session: Session, flush_context, instances) -> None:
    for obj in list(session.new):
        if isinstance(obj, TrainingRun):
            if obj.execution_mode is not None and obj.execution_mode not in EXECUTION_MODES:
                raise ImmutableRecordError(f"execution_mode must be one of {EXECUTION_MODES}")
            if obj.evaluation_protocol is not None and obj.evaluation_protocol not in EVALUATION_PROTOCOLS:
                raise ImmutableRecordError(f"evaluation_protocol must be one of {EVALUATION_PROTOCOLS}")
    for obj in list(session.dirty):
        if not session.is_modified(obj, include_collections=False):
            continue
        if isinstance(obj, _APPEND_ONLY):
            raise ImmutableRecordError(f"{type(obj).__name__} rows are immutable")
        if isinstance(obj, TrainingRun):
            _guard_training_run(session, obj)
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
        if isinstance(obj, TrainingRun) and (db_values(session, obj) or {}).get("status") == "succeeded":
            raise ImmutableRecordError("a completed training run is never deleted")


@event.listens_for(Session, "do_orm_execute")
def _guard_ml_bulk(state) -> None:
    if not (state.is_update or state.is_delete):
        return
    mapper = state.bind_mapper
    if mapper is not None and mapper.class_ in (Prediction, Evaluation, FeatureArtifact, ModelVersion, TrainingRun):
        raise ImmutableRecordError(f"bulk UPDATE/DELETE on {mapper.class_.__name__} is not allowed")


_RUN = TrainingRun.__table__
_MV = ModelVersion.__table__
_RUN_SET_ONCE_SQL = " OR ".join(f'(OLD."{c}" IS NOT NULL AND NEW."{c}" IS NOT OLD."{c}")' for c in sorted(RUN_SET_ONCE))
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
    FeatureArtifact.__table__: [
        "CREATE TRIGGER IF NOT EXISTS feature_artifact_no_update BEFORE UPDATE ON feature_artifact "
        "BEGIN SELECT RAISE(ABORT, 'feature_artifact is append-only'); END",
        "CREATE TRIGGER IF NOT EXISTS feature_artifact_no_delete BEFORE DELETE ON feature_artifact "
        "BEGIN SELECT RAISE(ABORT, 'feature_artifact is append-only'); END",
    ],
    _RUN: [
        "CREATE TRIGGER IF NOT EXISTS training_run_identity_update BEFORE UPDATE ON training_run "
        f"WHEN {any_changed(_RUN, only=RUN_IDENTITY)} "
        "BEGIN SELECT RAISE(ABORT, 'training run identity is immutable'); END",
        "CREATE TRIGGER IF NOT EXISTS training_run_set_once_update BEFORE UPDATE ON training_run "
        f"WHEN {_RUN_SET_ONCE_SQL} "
        "BEGIN SELECT RAISE(ABORT, 'training run column may be set only once'); END",
        "CREATE TRIGGER IF NOT EXISTS training_run_completed_update BEFORE UPDATE ON training_run "
        f"WHEN OLD.status = 'succeeded' AND {any_changed(_RUN, exclude=RUN_SET_AFTER_SUCCESS)} "
        "BEGIN SELECT RAISE(ABORT, 'completed training run is immutable'); END",
        "CREATE TRIGGER IF NOT EXISTS training_run_completed_delete BEFORE DELETE ON training_run "
        "WHEN OLD.status = 'succeeded' BEGIN SELECT RAISE(ABORT, 'completed training run is never deleted'); END",
    ],
    _MV: [
        "CREATE TRIGGER IF NOT EXISTS model_version_no_delete BEFORE DELETE ON model_version "
        "BEGIN SELECT RAISE(ABORT, 'model versions are never deleted'); END",
        "CREATE TRIGGER IF NOT EXISTS model_version_status_only BEFORE UPDATE ON model_version "
        f"WHEN NEW.status NOT IN {MODEL_STATUSES!r} OR {any_changed(_MV, exclude={'status'})} "
        "BEGIN SELECT RAISE(ABORT, 'model version: only status may change; never deployed'); END",
    ],
}
for _table, _stmts in _SQLITE_TRIGGERS.items():
    for _stmt in _stmts:
        event.listen(_table, "after_create", DDL(_stmt).execute_if(dialect="sqlite"))
