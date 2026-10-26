"""Engine tables (design ``docs/ml-engine-design.md`` §5, §6, §7, §8, §9).

Registered on the core ``Base``; :func:`dermpath.db.import_all_models` imports this module
(and ``dermpath.ml.models`` imports it first, because ``training_run`` references
``feature_set`` and ``comparison_family``). Schema version 2.

Tables
------
* ``feature_set`` / ``feature_set_item``: the frozen specification of how embeddings are
  produced for a list of slides, and its per-slide build state (§5).
* ``feature_set_validation``: technical-validation results for a feature set
  (re-extraction determinism, throughput, memory; §5 ``technical-validation``).
* ``comparison_family`` / ``comparison_family_member``: runs compared on one frozen
  manifest with a shared paired-bootstrap seed (§6 benchmark, §7 paired comparison).
* ``test_release``: the only route to test metrics; numbered per manifest (§7).
* ``run_attempt``: one row per training attempt, with the identity recomputed at start (§6).
* ``inference_bundle`` / ``inference_prediction``: the immutable research bundle and its
  label-free outputs on new slides (§8).
* ``al_proposal``: persisted active-learning proposals; never labels (§9).

Immutability (ORM ``before_flush`` guard below, bulk UPDATE/DELETE refused, plus SQLite
triggers created with ``execute_if(dialect="sqlite")``; PostgreSQL relies on the ORM
guard, as for the core tables):

* ``feature_set``: the specification columns never change after creation. ``status``
  moves ``building → ready | failed`` and ``failed → building`` (resume); once the
  committed status is ``ready`` the row is frozen and never deleted.
* ``feature_set_item``: ``feature_set_id``, ``slide_id`` and ``slide_sha256`` never change;
  an item whose status is ``done`` is frozen; nothing is inserted, changed or deleted once
  its feature set is ``ready`` (mark the set ready in a flush after its items).
* ``comparison_family``: identity columns never change; ``status`` moves only forward
  ``open → locked → test_released``; once locked only ``status`` may change; members are
  append-only and can be added only while the family is ``open``.
* ``test_release``: append-only (``job_id`` may be set once). ``release_number`` must be
  the next number for the dataset version, a second release needs a ``justification``.
* ``run_attempt``: identity columns never change; ``finished_at``, ``outcome``,
  ``error``, ``result_json`` and ``weights_sha256`` may be written until ``outcome`` is
  set, then the row is frozen. Never deleted.
* ``inference_bundle``, ``inference_prediction``, ``al_proposal``,
  ``feature_set_validation`` and ``comparison_family_member`` are append-only.
  A bundle's ``bundle_sha256`` must equal :func:`bundle_sha256_of` of its
  ``content_json``, and the content must say ``research_use_only: true``.

Research use only: no table here holds a diagnosis, and inference outputs never hold a
label.
"""

from __future__ import annotations

import hashlib
import json
from datetime import UTC, datetime

from sqlalchemy import (
    DDL,
    JSON,
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
    func,
    inspect,
    select,
)
from sqlalchemy.orm import Mapped, Session, mapped_column

from ..db import Base, UTCDateTime, utcnow
from ..models import ImmutableRecordError, new_id

EXECUTION_MODES = ("synthetic_pipeline_test", "real_image_technical", "supervised_experiment")
EVALUATION_PROTOCOLS = ("holdout", "dev_cv")
FEATURE_SET_STATUSES = ("building", "ready", "failed")
FEATURE_SET_ITEM_STATUSES = ("pending", "done", "failed")
FAMILY_STATUSES = ("open", "locked", "test_released")
RELEASE_CANDIDATE_KINDS = ("bundle", "family")
ATTEMPT_OUTCOMES = ("succeeded", "failed", "retryable_error", "canceled", "lease_lost", "run_identity_changed")
AL_STRATEGIES = ("uncertainty", "diversity", "random")

#: Allowed ``(old, new)`` status transitions.
FEATURE_SET_TRANSITIONS = frozenset({("building", "ready"), ("building", "failed"), ("failed", "building")})
FAMILY_TRANSITIONS = frozenset({("open", "locked"), ("locked", "test_released")})


def sql_in(column: str, values: tuple[str, ...]) -> str:
    return f"{column} IN ({', '.join(repr(v) for v in values)})"


def bundle_sha256_of(content: dict) -> str:
    """SHA-256 of the canonical JSON of a bundle's ``content_json`` (the bundle identity).

    Same canonical form as :func:`dermpath.ml.artifacts.canonical_json`.
    """
    data = json.dumps(content, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode()
    return hashlib.sha256(data).hexdigest()


# --------------------------------------------------------------------------- feature sets (§5)


class FeatureSet(Base):
    """Frozen specification of how embeddings are produced for a list of slides."""

    __tablename__ = "feature_set"
    __table_args__ = (
        UniqueConstraint("project_id", "spec_sha256", name="uq_feature_set_spec"),
        CheckConstraint(sql_in("status", FEATURE_SET_STATUSES), name="ck_feature_set_status"),
        CheckConstraint(sql_in("execution_mode", EXECUTION_MODES), name="ck_feature_set_mode"),
        Index("ix_feature_set_project_status", "project_id", "status"),
    )

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    project_id: Mapped[str] = mapped_column(ForeignKey("project.id"), nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    execution_mode: Mapped[str] = mapped_column(String(32), nullable=False)
    # Null for technical sets built on explicit slides.
    dataset_version_id: Mapped[str | None] = mapped_column(ForeignKey("dataset_version.id"), index=True)
    encoder_id: Mapped[str] = mapped_column(String(64), nullable=False)
    encoder_spec_json: Mapped[dict] = mapped_column(JSON, nullable=False)
    encoder_spec_sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    # A file sha256, or a weights-free identity such as "handcrafted:<version>:<source sha>".
    weights_sha256: Mapped[str] = mapped_column(String(160), nullable=False)
    patch_policy_json: Mapped[dict] = mapped_column(JSON, nullable=False)
    policy_sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    stain_policy_json: Mapped[dict] = mapped_column(JSON, nullable=False)
    stain_policy_sha256: Mapped[str | None] = mapped_column(String(64))
    extraction_env_json: Mapped[dict] = mapped_column(JSON, nullable=False)
    extraction_env_sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    input_snapshot_json: Mapped[dict] = mapped_column(JSON, nullable=False)
    input_snapshot_sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    spec_sha256: Mapped[str] = mapped_column(String(64), nullable=False)  # over every spec column above
    # Build state (writable until ready).
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="building")
    job_id: Mapped[str | None] = mapped_column(String(32))
    # Stain reference fitted on train-split patches only during the build (macenko-v1).
    stain_reference_key: Mapped[str | None] = mapped_column(String(300))
    stain_reference_sha256: Mapped[str | None] = mapped_column(String(64))
    error: Mapped[str | None] = mapped_column(Text)
    created_by: Mapped[str] = mapped_column(String(64), nullable=False)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow, nullable=False)
    ready_at: Mapped[datetime | None] = mapped_column(UTCDateTime())


#: Columns of a feature set that never change after creation.
FEATURE_SET_SPEC = frozenset({
    "id", "project_id", "name", "execution_mode", "dataset_version_id", "encoder_id", "encoder_spec_json",
    "encoder_spec_sha256", "weights_sha256", "patch_policy_json", "policy_sha256", "stain_policy_json",
    "stain_policy_sha256", "extraction_env_json", "extraction_env_sha256", "input_snapshot_json",
    "input_snapshot_sha256", "spec_sha256", "created_by", "created_at",
})


class FeatureSetItem(Base):
    """One slide of a feature set: its pinned slide sha and, once built, its artifact."""

    __tablename__ = "feature_set_item"
    __table_args__ = (
        UniqueConstraint("feature_set_id", "slide_id", name="uq_feature_set_item_slide"),
        CheckConstraint(sql_in("status", FEATURE_SET_ITEM_STATUSES), name="ck_feature_set_item_status"),
        Index("ix_feature_set_item_set_status", "feature_set_id", "status"),
    )

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    feature_set_id: Mapped[str] = mapped_column(ForeignKey("feature_set.id"), nullable=False)
    project_id: Mapped[str] = mapped_column(ForeignKey("project.id"), nullable=False, index=True)
    slide_id: Mapped[str] = mapped_column(ForeignKey("slide.id"), nullable=False, index=True)
    slide_sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    artifact_id: Mapped[str | None] = mapped_column(ForeignKey("feature_artifact.id"))
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="pending")
    coverage_json: Mapped[dict | None] = mapped_column(JSON)
    # Per-slide build stats: read/preprocess/embed seconds, patches per second, RSS delta, cache hit.
    stats_json: Mapped[dict | None] = mapped_column(JSON)
    error: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow, nullable=False)
    done_at: Mapped[datetime | None] = mapped_column(UTCDateTime())


FEATURE_SET_ITEM_IDENTITY = frozenset({"id", "feature_set_id", "project_id", "slide_id", "slide_sha256", "created_at"})


class FeatureSetValidation(Base):
    """Technical validation of a feature set (seeded re-extraction). Append-only."""

    __tablename__ = "feature_set_validation"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    feature_set_id: Mapped[str] = mapped_column(ForeignKey("feature_set.id"), nullable=False, index=True)
    project_id: Mapped[str] = mapped_column(ForeignKey("project.id"), nullable=False, index=True)
    job_id: Mapped[str | None] = mapped_column(String(32))
    seed: Mapped[int] = mapped_column(Integer, nullable=False)
    slide_ids_json: Mapped[list] = mapped_column(JSON, nullable=False)
    # max abs difference, identical coords, throughput, memory, environment.
    result_json: Mapped[dict] = mapped_column(JSON, nullable=False)
    passed: Mapped[bool | None] = mapped_column(Boolean)
    created_by: Mapped[str] = mapped_column(String(64), nullable=False)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow, nullable=False)


# --------------------------------------------------------------------------- comparison families (§6, §7)


class ComparisonFamily(Base):
    """Runs compared on one frozen manifest and identical patient splits."""

    __tablename__ = "comparison_family"
    __table_args__ = (CheckConstraint(sql_in("status", FAMILY_STATUSES), name="ck_comparison_family_status"),)

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    project_id: Mapped[str] = mapped_column(ForeignKey("project.id"), nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    dataset_version_id: Mapped[str] = mapped_column(ForeignKey("dataset_version.id"), nullable=False, index=True)
    dataset_manifest_sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    split_fingerprint: Mapped[str | None] = mapped_column(String(64))
    # Pre-registered plan: encoders, heads, seeds, primary metric, optimisation budgets.
    plan_json: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    bootstrap_seed: Mapped[int] = mapped_column(Integer, nullable=False)  # shared by paired comparisons
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="open")
    created_by: Mapped[str] = mapped_column(String(64), nullable=False)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow, nullable=False)
    locked_by: Mapped[str | None] = mapped_column(String(64))
    locked_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    lock_reason: Mapped[str | None] = mapped_column(Text)


#: Writable while the family is open (status, and the lock record set when locking).
FAMILY_MUTABLE = frozenset({"status", "locked_by", "locked_at", "lock_reason"})


class ComparisonFamilyMember(Base):
    """A run in a comparison family. Append-only; added only while the family is open."""

    __tablename__ = "comparison_family_member"
    __table_args__ = (UniqueConstraint("family_id", "run_id", name="uq_comparison_family_member"),)

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    family_id: Mapped[str] = mapped_column(ForeignKey("comparison_family.id"), nullable=False, index=True)
    project_id: Mapped[str] = mapped_column(ForeignKey("project.id"), nullable=False, index=True)
    run_id: Mapped[str] = mapped_column(ForeignKey("training_run.id"), nullable=False, index=True)
    role: Mapped[str | None] = mapped_column(String(24))  # e.g. candidate | baseline
    created_by: Mapped[str] = mapped_column(String(64), nullable=False)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow, nullable=False)


# --------------------------------------------------------------------------- test releases (§7)


class TestRelease(Base):
    """A recorded decision to compute test metrics. Append-only (``job_id`` set once)."""

    __test__ = False  # not a pytest test class
    __tablename__ = "test_release"
    __table_args__ = (
        UniqueConstraint("dataset_version_id", "release_number", name="uq_test_release_number"),
        CheckConstraint("release_number >= 1", name="ck_test_release_number"),
        CheckConstraint(sql_in("candidate_kind", RELEASE_CANDIDATE_KINDS), name="ck_test_release_kind"),
        CheckConstraint("(candidate_kind = 'bundle' AND bundle_id IS NOT NULL) OR "
                        "(candidate_kind = 'family' AND family_id IS NOT NULL)", name="ck_test_release_candidate"),
    )

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    project_id: Mapped[str] = mapped_column(ForeignKey("project.id"), nullable=False, index=True)
    dataset_version_id: Mapped[str] = mapped_column(ForeignKey("dataset_version.id"), nullable=False, index=True)
    dataset_manifest_sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    release_number: Mapped[int] = mapped_column(Integer, nullable=False)  # 1, 2, ... per dataset version
    candidate_kind: Mapped[str] = mapped_column(String(16), nullable=False)
    bundle_id: Mapped[str | None] = mapped_column(ForeignKey("inference_bundle.id"))
    family_id: Mapped[str | None] = mapped_column(ForeignKey("comparison_family.id"))
    run_ids_json: Mapped[list] = mapped_column(JSON, nullable=False)
    split_family_id: Mapped[str | None] = mapped_column(String(32))  # dermpath.models split_family (sealed)
    sealed_patient_count: Mapped[int | None] = mapped_column(Integer)
    reason: Mapped[str] = mapped_column(Text, nullable=False)
    justification: Mapped[str | None] = mapped_column(Text)  # required from the second release on
    job_id: Mapped[str | None] = mapped_column(String(32))
    released_by: Mapped[str] = mapped_column(String(64), nullable=False)
    released_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow, nullable=False)


# --------------------------------------------------------------------------- run attempts (§6)


class RunAttempt(Base):
    """One attempt of a training run, with the run identity recomputed at its start."""

    __tablename__ = "run_attempt"
    __table_args__ = (
        UniqueConstraint("run_id", "attempt_number", name="uq_run_attempt_number"),
        CheckConstraint(sql_in("outcome", ATTEMPT_OUTCOMES), name="ck_run_attempt_outcome"),
    )

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    run_id: Mapped[str] = mapped_column(ForeignKey("training_run.id"), nullable=False, index=True)
    project_id: Mapped[str] = mapped_column(ForeignKey("project.id"), nullable=False, index=True)
    attempt_number: Mapped[int] = mapped_column(Integer, nullable=False)  # 1, 2, ... across job retries
    job_id: Mapped[str | None] = mapped_column(String(32))
    job_attempt: Mapped[int | None] = mapped_column(Integer)  # job.attempts when claimed
    job_retry_count: Mapped[int | None] = mapped_column(Integer)
    worker_id: Mapped[str | None] = mapped_column(String(120))
    code_revision: Mapped[str | None] = mapped_column(String(80))
    code_tree_sha256: Mapped[str | None] = mapped_column(String(64))
    code_dirty: Mapped[bool | None] = mapped_column(Boolean)
    deps_json: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    identity_sha256: Mapped[str | None] = mapped_column(String(64))  # recomputed at attempt start
    identity_matches: Mapped[bool | None] = mapped_column(Boolean)
    identity_diff_json: Mapped[list | None] = mapped_column(JSON)  # differing identity fields
    started_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow, nullable=False)
    # Settlement (writable until outcome is set).
    weights_sha256: Mapped[str | None] = mapped_column(String(160))
    finished_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    outcome: Mapped[str | None] = mapped_column(String(24))
    error: Mapped[str | None] = mapped_column(Text)
    result_json: Mapped[dict | None] = mapped_column(JSON)


RUN_ATTEMPT_SETTLE = frozenset({"weights_sha256", "finished_at", "outcome", "error", "result_json"})


# --------------------------------------------------------------------------- inference (§8)


class InferenceBundle(Base):
    """Everything needed to reproduce features and decisions of a registered run. Immutable."""

    __tablename__ = "inference_bundle"
    __table_args__ = (UniqueConstraint("run_id", name="uq_inference_bundle_run"),)

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    project_id: Mapped[str] = mapped_column(ForeignKey("project.id"), nullable=False, index=True)
    run_id: Mapped[str] = mapped_column(ForeignKey("training_run.id"), nullable=False)
    bundle_sha256: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    content_json: Mapped[dict] = mapped_column(JSON, nullable=False)
    object_key: Mapped[str] = mapped_column(String(300), nullable=False)
    created_by: Mapped[str] = mapped_column(String(64), nullable=False)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow, nullable=False)


class InferencePrediction(Base):
    """A research output of a bundle on one slide. Append-only; never a label, never routed to care."""

    __tablename__ = "inference_prediction"
    __table_args__ = (UniqueConstraint("bundle_id", "slide_id", name="uq_inference_prediction_slide"),)

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    project_id: Mapped[str] = mapped_column(ForeignKey("project.id"), nullable=False, index=True)
    bundle_id: Mapped[str] = mapped_column(ForeignKey("inference_bundle.id"), nullable=False, index=True)
    slide_id: Mapped[str] = mapped_column(ForeignKey("slide.id"), nullable=False, index=True)
    slide_sha256: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    feature_artifact_id: Mapped[str | None] = mapped_column(ForeignKey("feature_artifact.id"))
    job_id: Mapped[str | None] = mapped_column(String(32))
    score: Mapped[float | None] = mapped_column(Float)  # None when the slide is unscorable
    calibrated_score: Mapped[float | None] = mapped_column(Float)
    threshold: Mapped[float] = mapped_column(Float, nullable=False)
    predicted: Mapped[int | None] = mapped_column(Integer)  # 1 = positive class at the threshold
    abstained: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    unscorable_reason: Mapped[str | None] = mapped_column(String(200))
    coverage_json: Mapped[dict | None] = mapped_column(JSON)
    attention_key: Mapped[str | None] = mapped_column(String(300))
    attention_sha256: Mapped[str | None] = mapped_column(String(64))
    input_snapshot_json: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    research_use_only: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    created_by: Mapped[str] = mapped_column(String(64), nullable=False)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow, nullable=False)


# --------------------------------------------------------------------------- active learning (§9)


class ALProposal(Base):
    """One slide proposed for expert review. Append-only; it never creates a label."""

    __tablename__ = "al_proposal"
    __table_args__ = (
        UniqueConstraint("batch_id", "slide_id", name="uq_al_proposal_batch_slide"),
        CheckConstraint(sql_in("strategy", AL_STRATEGIES), name="ck_al_proposal_strategy"),
        Index("ix_al_proposal_project_slide", "project_id", "slide_id"),
    )

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    project_id: Mapped[str] = mapped_column(ForeignKey("project.id"), nullable=False, index=True)
    batch_id: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    run_id: Mapped[str | None] = mapped_column(ForeignKey("training_run.id"))
    bundle_id: Mapped[str | None] = mapped_column(ForeignKey("inference_bundle.id"))
    dataset_version_id: Mapped[str | None] = mapped_column(ForeignKey("dataset_version.id"))
    slide_id: Mapped[str] = mapped_column(ForeignKey("slide.id"), nullable=False)
    coded_patient_id: Mapped[str | None] = mapped_column(String(32))
    proposal_rank: Mapped[int] = mapped_column(Integer, nullable=False)
    strategy: Mapped[str] = mapped_column(String(24), nullable=False)
    score: Mapped[float | None] = mapped_column(Float)  # out-of-sample uncertainty, when scored
    components_json: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    seed: Mapped[int | None] = mapped_column(Integer)
    created_by: Mapped[str] = mapped_column(String(64), nullable=False)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow, nullable=False)


# --------------------------------------------------------------------------- immutability guards

_APPEND_ONLY = (FeatureSetValidation, ComparisonFamilyMember, InferenceBundle, InferencePrediction, ALProposal)
ENGINE_TABLES = (FeatureSet, FeatureSetItem, FeatureSetValidation, ComparisonFamily, ComparisonFamilyMember,
                 TestRelease, RunAttempt, InferenceBundle, InferencePrediction, ALProposal)


def _same(a, b) -> bool:
    if isinstance(a, datetime) and isinstance(b, datetime):
        a = a if a.tzinfo else a.replace(tzinfo=UTC)
        b = b if b.tzinfo else b.replace(tzinfo=UTC)
    return a == b


def db_values(session: Session, obj) -> dict | None:
    """The row as stored in the database before this flush (None if absent).

    Read through the session's connection, so it sees earlier flushes of the same
    transaction. Unlike ``committed_state`` it does not depend on whether the old values
    were loaded before the attribute was set.
    """
    table = obj.__table__
    ident = inspect(obj).identity
    if not ident:
        return None
    with session.no_autoflush:
        row = session.connection().execute(select(table).where(table.c.id == ident[0])).mappings().first()
    return dict(row) if row is not None else None


def changed_columns(session: Session, obj) -> tuple[dict, set[str]]:
    """``(old_row, keys whose new value differs from the stored one)`` for a dirty object."""
    old = db_values(session, obj) or {}
    state = inspect(obj)
    changed: set[str] = set()
    for attr in state.mapper.column_attrs:
        key = attr.key
        if state.attrs[key].history.has_changes() and (key not in old or not _same(old[key], getattr(obj, key))):
            changed.add(key)
    return old, changed


def _stored_status(session: Session, model, row_id: str | None) -> tuple[str | None, str | None]:
    """``(status in this session, status in the database)`` of a parent row."""
    if not row_id:
        return None, None
    pending = next((o for o in session.new if isinstance(o, model) and o.id == row_id), None)
    if pending is not None:  # inserted in this flush: the column default applies when unset
        return pending.status or model.__table__.c.status.default.arg, None
    with session.no_autoflush:
        obj = session.get(model, row_id)
        db_status = session.connection().execute(
            select(model.__table__.c.status).where(model.__table__.c.id == row_id)).scalar()
    return (obj.status if obj is not None else None), db_status


def _feature_set_ready(session: Session, feature_set_id: str | None) -> bool:
    return "ready" in _stored_status(session, FeatureSet, feature_set_id)


def _family_open(session: Session, family_id: str | None) -> bool:
    pending, stored = _stored_status(session, ComparisonFamily, family_id)
    return pending in (None, "open") and stored in (None, "open") and (pending or stored) is not None


def _check_new(session: Session, obj) -> None:
    if isinstance(obj, FeatureSetItem) and _feature_set_ready(session, obj.feature_set_id):
        raise ImmutableRecordError("cannot add items to a ready feature set")
    if isinstance(obj, ComparisonFamilyMember) and not _family_open(session, obj.family_id):
        raise ImmutableRecordError("runs can be added to a comparison family only while it is open")
    if isinstance(obj, TestRelease):
        if not (obj.reason or "").strip():
            raise ImmutableRecordError("a test release needs a reason")
        if (obj.release_number or 0) > 1 and not (obj.justification or "").strip():
            raise ImmutableRecordError("a second or later test release on a manifest needs a justification")
        with session.no_autoflush:
            last = session.connection().execute(
                select(func.max(TestRelease.__table__.c.release_number))
                .where(TestRelease.__table__.c.dataset_version_id == obj.dataset_version_id)).scalar()
        if obj.release_number != (last or 0) + 1:
            raise ImmutableRecordError(
                f"release_number must be {(last or 0) + 1} for this dataset version (got {obj.release_number})")
    if isinstance(obj, InferenceBundle):
        if not isinstance(obj.content_json, dict) or obj.content_json.get("research_use_only") is not True:
            raise ImmutableRecordError("an inference bundle must state research_use_only: true")
        if obj.bundle_sha256 != bundle_sha256_of(obj.content_json):
            raise ImmutableRecordError("bundle_sha256 does not match the canonical sha256 of content_json")
    if isinstance(obj, InferencePrediction) and obj.research_use_only is False:
        raise ImmutableRecordError("inference predictions are research use only")


def _check_dirty(session: Session, obj) -> None:
    name = type(obj).__name__
    if isinstance(obj, _APPEND_ONLY):
        raise ImmutableRecordError(f"{name} rows are append-only")
    old, changed = changed_columns(session, obj)
    if not changed:
        return
    if isinstance(obj, FeatureSet):
        if old.get("status") == "ready":
            raise ImmutableRecordError("a ready feature set is immutable")
        if changed & FEATURE_SET_SPEC:
            raise ImmutableRecordError(f"feature set specification is immutable: {sorted(changed & FEATURE_SET_SPEC)}")
        if "status" in changed and (old.get("status"), obj.status) not in FEATURE_SET_TRANSITIONS:
            raise ImmutableRecordError(f"feature set status cannot move {old.get('status')} -> {obj.status}")
    elif isinstance(obj, FeatureSetItem):
        if changed & FEATURE_SET_ITEM_IDENTITY:
            raise ImmutableRecordError(
                f"feature set item identity is immutable: {sorted(changed & FEATURE_SET_ITEM_IDENTITY)}")
        if old.get("status") == "done":
            raise ImmutableRecordError("a done feature set item is immutable")
        if _feature_set_ready(session, obj.feature_set_id):
            raise ImmutableRecordError("items of a ready feature set are immutable (flush item changes before "
                                       "marking the set ready)")
    elif isinstance(obj, ComparisonFamily):
        if changed - FAMILY_MUTABLE:
            raise ImmutableRecordError(f"comparison family identity is immutable: {sorted(changed - FAMILY_MUTABLE)}")
        if old.get("status") != "open" and changed - {"status"}:
            raise ImmutableRecordError("a locked comparison family may change only its status")
        if "status" in changed and (old.get("status"), obj.status) not in FAMILY_TRANSITIONS:
            raise ImmutableRecordError(f"comparison family status cannot move {old.get('status')} -> {obj.status}")
    elif isinstance(obj, TestRelease):
        if changed - {"job_id"} or old.get("job_id") is not None:
            raise ImmutableRecordError("test releases are append-only (job_id may be set once)")
    elif isinstance(obj, RunAttempt):
        if changed - RUN_ATTEMPT_SETTLE:
            raise ImmutableRecordError(f"run attempt identity is immutable: {sorted(changed - RUN_ATTEMPT_SETTLE)}")
        if old.get("outcome") is not None:
            raise ImmutableRecordError("a settled run attempt is immutable")


def _check_deleted(session: Session, obj) -> None:
    name = type(obj).__name__
    if isinstance(obj, _APPEND_ONLY + (TestRelease, RunAttempt)):
        raise ImmutableRecordError(f"{name} rows are never deleted")
    old = db_values(session, obj) or {}
    if isinstance(obj, FeatureSet) and old.get("status") == "ready":
        raise ImmutableRecordError("a ready feature set is never deleted")
    if isinstance(obj, FeatureSetItem) and (old.get("status") == "done"
                                            or _feature_set_ready(session, obj.feature_set_id)):
        raise ImmutableRecordError("built items and items of a ready feature set are never deleted")
    if isinstance(obj, ComparisonFamily) and old.get("status") not in (None, "open"):
        raise ImmutableRecordError("a locked comparison family is never deleted")


@event.listens_for(Session, "before_flush")
def _guard_engine(session: Session, flush_context, instances) -> None:
    for obj in list(session.new):
        if isinstance(obj, ENGINE_TABLES):
            _check_new(session, obj)
    for obj in list(session.dirty):
        if isinstance(obj, ENGINE_TABLES) and session.is_modified(obj, include_collections=False):
            _check_dirty(session, obj)
    for obj in list(session.deleted):
        if isinstance(obj, ENGINE_TABLES):
            _check_deleted(session, obj)


@event.listens_for(Session, "do_orm_execute")
def _guard_engine_bulk(state) -> None:
    if not (state.is_update or state.is_delete):
        return
    mapper = state.bind_mapper
    if mapper is not None and mapper.class_ in ENGINE_TABLES:
        raise ImmutableRecordError(
            f"bulk UPDATE/DELETE on {mapper.class_.__name__} is not allowed (immutability guard)")


# SQLite triggers: defence in depth against raw SQL (generated from the column lists, so a
# new column is covered automatically). PostgreSQL relies on the ORM guard above.


def any_changed(table, *, only=None, exclude=()) -> str:
    """SQL ``(NEW."c" IS NOT OLD."c" OR ...)`` over the table's columns."""
    cols = [c.name for c in table.columns if (only is None or c.name in only) and c.name not in exclude]
    return "(" + " OR ".join(f'NEW."{c}" IS NOT OLD."{c}"' for c in sorted(cols)) + ")"


def _abort(name: str, when: str, table: str, op: str, message: str) -> str:
    return (f"CREATE TRIGGER IF NOT EXISTS {name} BEFORE {op} ON {table} "
            f"{'WHEN ' + when + ' ' if when else ''}BEGIN SELECT RAISE(ABORT, '{message}'); END")


def append_only_triggers(table) -> list[str]:
    t = table.name
    return [_abort(f"{t}_no_update", "", t, "UPDATE", f"{t} is append-only"),
            _abort(f"{t}_no_delete", "", t, "DELETE", f"{t} is append-only")]


_FS = FeatureSet.__table__
_FSI = FeatureSetItem.__table__
_CF = ComparisonFamily.__table__
_TR = TestRelease.__table__
_RA = RunAttempt.__table__
_FS_READY = "(SELECT status FROM feature_set WHERE id = {}.feature_set_id) = 'ready'"


def _transitions_sql(allowed) -> str:
    return " OR ".join(f"(OLD.status = '{a}' AND NEW.status = '{b}')" for a, b in sorted(allowed))


_FS_OK_TRANSITIONS = _transitions_sql(FEATURE_SET_TRANSITIONS)
_CF_OK_TRANSITIONS = _transitions_sql(FAMILY_TRANSITIONS)

SQLITE_TRIGGERS = {
    _FS: [
        _abort("feature_set_ready_update", "OLD.status = 'ready'", "feature_set", "UPDATE",
               "a ready feature set is immutable"),
        _abort("feature_set_spec_update", any_changed(_FS, only=FEATURE_SET_SPEC), "feature_set", "UPDATE",
               "feature set specification is immutable"),
        _abort("feature_set_status_update",
               f"NEW.status IS NOT OLD.status AND NOT ({_FS_OK_TRANSITIONS})", "feature_set", "UPDATE",
               "feature set status transition not allowed"),
        _abort("feature_set_ready_delete", "OLD.status = 'ready'", "feature_set", "DELETE",
               "a ready feature set is never deleted"),
    ],
    _FSI: [
        _abort("feature_set_item_ready_insert", _FS_READY.format("NEW"), "feature_set_item", "INSERT",
               "feature set is ready"),
        _abort("feature_set_item_ready_update", _FS_READY.format("OLD"), "feature_set_item", "UPDATE",
               "feature set is ready"),
        _abort("feature_set_item_done_update", "OLD.status = 'done'", "feature_set_item", "UPDATE",
               "a done feature set item is immutable"),
        _abort("feature_set_item_identity_update", any_changed(_FSI, only=FEATURE_SET_ITEM_IDENTITY),
               "feature_set_item", "UPDATE", "feature set item identity is immutable"),
        _abort("feature_set_item_delete", f"OLD.status = 'done' OR {_FS_READY.format('OLD')}", "feature_set_item",
               "DELETE", "built items and items of a ready feature set are never deleted"),
    ],
    FeatureSetValidation.__table__: append_only_triggers(FeatureSetValidation.__table__),
    _CF: [
        _abort("comparison_family_identity_update", any_changed(_CF, exclude=FAMILY_MUTABLE), "comparison_family",
               "UPDATE", "comparison family identity is immutable"),
        _abort("comparison_family_locked_update", f"OLD.status != 'open' AND {any_changed(_CF, exclude={'status'})}",
               "comparison_family", "UPDATE", "a locked comparison family may change only its status"),
        _abort("comparison_family_status_update", f"NEW.status IS NOT OLD.status AND NOT ({_CF_OK_TRANSITIONS})",
               "comparison_family", "UPDATE", "comparison family status moves only forward"),
        _abort("comparison_family_locked_delete", "OLD.status != 'open'", "comparison_family", "DELETE",
               "a locked comparison family is never deleted"),
    ],
    ComparisonFamilyMember.__table__: append_only_triggers(ComparisonFamilyMember.__table__) + [
        _abort("comparison_family_member_open_insert",
               "(SELECT status FROM comparison_family WHERE id = NEW.family_id) IS NOT 'open'",
               "comparison_family_member", "INSERT", "the comparison family is not open"),
    ],
    _TR: [
        _abort("test_release_update",
               f"{any_changed(_TR, exclude={'job_id'})} OR (OLD.job_id IS NOT NULL AND NEW.job_id IS NOT OLD.job_id)",
               "test_release", "UPDATE", "test releases are append-only"),
        _abort("test_release_no_delete", "", "test_release", "DELETE", "test releases are append-only"),
        _abort("test_release_number_insert",
               "NEW.release_number IS NOT (SELECT COALESCE(MAX(release_number), 0) + 1 FROM test_release "
               "WHERE dataset_version_id = NEW.dataset_version_id)",
               "test_release", "INSERT", "release_number must be the next number for this dataset version"),
        _abort("test_release_justification_insert",
               "NEW.release_number > 1 AND (NEW.justification IS NULL OR trim(NEW.justification) = '')",
               "test_release", "INSERT", "a second test release needs a justification"),
        _abort("test_release_reason_insert", "NEW.reason IS NULL OR trim(NEW.reason) = ''", "test_release",
               "INSERT", "a test release needs a reason"),
    ],
    _RA: [
        _abort("run_attempt_identity_update", any_changed(_RA, exclude=RUN_ATTEMPT_SETTLE), "run_attempt", "UPDATE",
               "run attempt identity is immutable"),
        _abort("run_attempt_settled_update", "OLD.outcome IS NOT NULL", "run_attempt", "UPDATE",
               "a settled run attempt is immutable"),
        _abort("run_attempt_no_delete", "", "run_attempt", "DELETE", "run attempts are never deleted"),
    ],
    InferenceBundle.__table__: append_only_triggers(InferenceBundle.__table__),
    InferencePrediction.__table__: append_only_triggers(InferencePrediction.__table__),
    ALProposal.__table__: append_only_triggers(ALProposal.__table__),
}
for _table, _stmts in SQLITE_TRIGGERS.items():
    for _stmt in _stmts:
        event.listen(_table, "after_create", DDL(_stmt).execute_if(dialect="sqlite"))
