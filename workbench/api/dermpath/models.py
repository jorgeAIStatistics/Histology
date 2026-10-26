"""SQLAlchemy entities (implementation plan, section 5).

Every project-scoped entity carries ``project_id`` (denormalised from its parent and
checked on creation) so authorization is a single lookup. Column types are portable
(String, Text, Integer, BigInteger, Float, Boolean, Date, JSON, timezone-aware DateTime).

Immutability guarantees, enforced at the ORM/session level (and, on SQLite, again by
triggers created with ``execute_if(dialect="sqlite")``):

* ``AuditEvent``, ``LabelVersion`` and ``ReviewAssessment`` are append-only.
* A frozen ``DatasetVersion`` and its ``DatasetItem`` / ``SplitAssignment`` rows reject
  every insert, update and delete.
* ``SplitFamily`` rows are never deleted; salt and lineage never change, and the partition
  only while no version of the lineage is frozen. ``SplitFamilyAssignment`` rows are
  insert-only except for sealing, which is recorded once.
* ``AnnotationVersion`` rows are never deleted; only ``superseded_by`` may be set once.

ML TABLES ---------------------------------------------------------------------
FeatureArtifact, TrainingRun, Prediction, Evaluation and ModelVersion are NOT defined
here. The ML pass defines them in ``dermpath/ml/models.py`` on the same ``Base`` (import
``from dermpath.db import Base, UTCDateTime, utcnow`` and ``from dermpath.models import
new_id``); ``dermpath.db.import_all_models`` registers that module automatically.
-------------------------------------------------------------------------------
"""

from __future__ import annotations

import uuid
from datetime import date, datetime
from typing import Any

from sqlalchemy import (
    DDL,
    JSON,
    BigInteger,
    Boolean,
    Date,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    event,
    inspect,
    select,
)
from sqlalchemy.orm import Mapped, Session, mapped_column, relationship

from .db import Base, UTCDateTime, utcnow


def new_id() -> str:
    return uuid.uuid4().hex


class ImmutableRecordError(RuntimeError):
    """Raised when code tries to modify an append-only or frozen record."""


class FrozenDatasetError(ImmutableRecordError):
    pass


# --------------------------------------------------------------------------- organisation


class User(Base):
    __tablename__ = "user_account"

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=new_id)
    display_name: Mapped[str] = mapped_column(String(120), nullable=False)
    role: Mapped[str] = mapped_column(String(32), nullable=False)
    active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    demo_user: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow, nullable=False)


class Project(Base):
    __tablename__ = "project"

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=new_id)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    description: Mapped[str | None] = mapped_column(Text)
    task_template_json: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    settings_json: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    demo_seeded: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow, nullable=False)


class ProjectMember(Base):
    __tablename__ = "project_member"
    __table_args__ = (UniqueConstraint("project_id", "user_id"),)

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    project_id: Mapped[str] = mapped_column(ForeignKey("project.id"), nullable=False, index=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("user_account.id"), nullable=False, index=True)
    # Reviewer-level override of the project's independent_review setting (None = inherit).
    independent_review: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    added_by: Mapped[str | None] = mapped_column(String(64))
    added_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow, nullable=False)

    user: Mapped[User] = relationship()


# --------------------------------------------------------------------------- hierarchy


class CodedPatient(Base):
    """A coded research subject. NEVER a name, MRN or birth date."""

    __tablename__ = "coded_patient"
    __table_args__ = (UniqueConstraint("project_id", "code"),)

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    project_id: Mapped[str] = mapped_column(ForeignKey("project.id"), nullable=False, index=True)
    code: Mapped[str] = mapped_column(String(32), nullable=False)
    created_by: Mapped[str | None] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow, nullable=False)


class Case(Base):
    __tablename__ = "case_record"
    __table_args__ = (UniqueConstraint("project_id", "accession_code"),)

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    project_id: Mapped[str] = mapped_column(ForeignKey("project.id"), nullable=False, index=True)
    coded_patient_id: Mapped[str] = mapped_column(
        ForeignKey("coded_patient.id"), nullable=False, index=True
    )
    accession_code: Mapped[str] = mapped_column(String(40), nullable=False)
    collected_on: Mapped[date | None] = mapped_column(Date)
    site_id: Mapped[str | None] = mapped_column(String(64))
    provenance: Mapped[str] = mapped_column(String(32), nullable=False, default="demo_synthetic")
    note: Mapped[str | None] = mapped_column(Text)
    created_by: Mapped[str | None] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow, nullable=False)

    coded_patient: Mapped[CodedPatient] = relationship()
    parts: Mapped[list["SpecimenPart"]] = relationship(
        back_populates="case", order_by="SpecimenPart.designation"
    )


class SpecimenPart(Base):
    __tablename__ = "specimen_part"
    __table_args__ = (UniqueConstraint("case_id", "designation"),)

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    project_id: Mapped[str] = mapped_column(ForeignKey("project.id"), nullable=False, index=True)
    case_id: Mapped[str] = mapped_column(ForeignKey("case_record.id"), nullable=False, index=True)
    designation: Mapped[str] = mapped_column(String(4), nullable=False)
    anatomic_site_text: Mapped[str | None] = mapped_column(String(200))
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow, nullable=False)

    case: Mapped[Case] = relationship(back_populates="parts")
    blocks: Mapped[list["Block"]] = relationship(back_populates="part", order_by="Block.designation")


class Block(Base):
    __tablename__ = "block"
    __table_args__ = (UniqueConstraint("part_id", "designation"),)

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    project_id: Mapped[str] = mapped_column(ForeignKey("project.id"), nullable=False, index=True)
    part_id: Mapped[str] = mapped_column(ForeignKey("specimen_part.id"), nullable=False, index=True)
    designation: Mapped[str] = mapped_column(String(8), nullable=False)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow, nullable=False)

    part: Mapped[SpecimenPart] = relationship(back_populates="blocks")
    slides: Mapped[list["Slide"]] = relationship(
        back_populates="block", order_by="Slide.level_index"
    )


class Slide(Base):
    __tablename__ = "slide"
    # Exact duplicates (same sha256) are never ingested twice within a project.
    __table_args__ = (UniqueConstraint("project_id", "sha256"),)

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    project_id: Mapped[str] = mapped_column(ForeignKey("project.id"), nullable=False, index=True)
    block_id: Mapped[str | None] = mapped_column(ForeignKey("block.id"), index=True)
    level_index: Mapped[int | None] = mapped_column(Integer)
    stain: Mapped[str | None] = mapped_column(String(64))
    scanner_id: Mapped[str | None] = mapped_column(String(64))
    scanned_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    review_state: Mapped[str] = mapped_column(String(24), nullable=False, default="imported")
    review_state_reason: Mapped[str | None] = mapped_column(Text)
    review_state_by: Mapped[str | None] = mapped_column(String(64))
    review_state_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    provenance: Mapped[str] = mapped_column(String(32), nullable=False)
    image_kind: Mapped[str] = mapped_column(String(24), nullable=False)
    object_key: Mapped[str] = mapped_column(String(300), nullable=False)
    # For synthetic_tiles, sha256 identifies the deterministic generator spec (no file).
    sha256: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    bytes: Mapped[int | None] = mapped_column(BigInteger)
    format: Mapped[str | None] = mapped_column(String(32))
    width: Mapped[int | None] = mapped_column(Integer)
    height: Mapped[int | None] = mapped_column(Integer)
    levels: Mapped[int | None] = mapped_column(Integer)
    level_dimensions_json: Mapped[list | None] = mapped_column(JSON)
    level_downsamples_json: Mapped[list | None] = mapped_column(JSON)
    mpp_x: Mapped[float | None] = mapped_column(Float)  # null when unknown, never guessed
    mpp_y: Mapped[float | None] = mapped_column(Float)
    objective_power: Mapped[float | None] = mapped_column(Float)
    vendor: Mapped[str | None] = mapped_column(String(64))
    ingest_status: Mapped[str] = mapped_column(String(16), nullable=False, default="pending")
    ingest_error: Mapped[str | None] = mapped_column(Text)
    processing_version: Mapped[str | None] = mapped_column(String(120))
    original_filename: Mapped[str | None] = mapped_column(String(255))  # metadata only
    identifier_risk_json: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    associated_images_json: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    thumbnail_key: Mapped[str | None] = mapped_column(String(300))
    thumbnail_phash: Mapped[str | None] = mapped_column(String(16))
    ingest_manifest_key: Mapped[str | None] = mapped_column(String(300))
    synthetic_spec_json: Mapped[dict | None] = mapped_column(JSON)
    created_by: Mapped[str | None] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow, nullable=False)
    ingested_at: Mapped[datetime | None] = mapped_column(UTCDateTime())

    block: Mapped[Block | None] = relationship(back_populates="slides")


class Upload(Base):
    __tablename__ = "upload"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    project_id: Mapped[str] = mapped_column(ForeignKey("project.id"), nullable=False, index=True)
    created_by: Mapped[str] = mapped_column(String(64), nullable=False)
    original_filename: Mapped[str] = mapped_column(String(255), nullable=False)  # metadata only
    filename_safe: Mapped[str] = mapped_column(String(255), nullable=False)
    extension: Mapped[str] = mapped_column(String(16), nullable=False)
    kind: Mapped[str] = mapped_column(String(24), nullable=False)  # wsi | field_image
    declared_size: Mapped[int] = mapped_column(BigInteger, nullable=False)
    declared_sha256: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    chunk_size: Mapped[int] = mapped_column(Integer, nullable=False)
    received_bytes: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    chunk_sha256s: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="receiving")
    error: Mapped[str | None] = mapped_column(Text)
    target_json: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    provenance: Mapped[str] = mapped_column(String(32), nullable=False)
    governance_attestation: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    identifier_risk_json: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    slide_id: Mapped[str | None] = mapped_column(ForeignKey("slide.id"))
    duplicate_of_slide_id: Mapped[str | None] = mapped_column(String(32))
    job_id: Mapped[str | None] = mapped_column(String(32))
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        UTCDateTime(), default=utcnow, onupdate=utcnow, nullable=False
    )
    completed_at: Mapped[datetime | None] = mapped_column(UTCDateTime())


# --------------------------------------------------------------------------- QC


class QCReview(Base):
    __tablename__ = "qc_review"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    project_id: Mapped[str] = mapped_column(ForeignKey("project.id"), nullable=False, index=True)
    slide_id: Mapped[str] = mapped_column(ForeignKey("slide.id"), nullable=False, index=True)
    kind: Mapped[str] = mapped_column(String(24), nullable=False)  # automated_screen | manual
    method_version: Mapped[str | None] = mapped_column(String(80))
    metrics_json: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    mask_object_key: Mapped[str | None] = mapped_column(String(300))
    experimental: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    override_of: Mapped[str | None] = mapped_column(ForeignKey("qc_review.id"))
    reason: Mapped[str | None] = mapped_column(Text)
    job_id: Mapped[str | None] = mapped_column(String(32))
    created_by: Mapped[str | None] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow, nullable=False)


class QCIssue(Base):
    __tablename__ = "qc_issue"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    project_id: Mapped[str] = mapped_column(ForeignKey("project.id"), nullable=False, index=True)
    slide_id: Mapped[str] = mapped_column(ForeignKey("slide.id"), nullable=False, index=True)
    category: Mapped[str] = mapped_column(String(32), nullable=False)
    region_json: Mapped[dict | None] = mapped_column(JSON)  # level-0 pixel geometry, optional
    source: Mapped[str] = mapped_column(String(16), nullable=False)  # heuristic | human
    is_suggestion: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="open")
    human_confirmed: Mapped[bool | None] = mapped_column(Boolean)
    suggested_action: Mapped[str | None] = mapped_column(String(40))
    resolution: Mapped[str | None] = mapped_column(Text)
    dataset_eligibility_effect: Mapped[str] = mapped_column(String(20), nullable=False, default="none")
    reason: Mapped[str | None] = mapped_column(Text)
    note: Mapped[str | None] = mapped_column(Text)
    qc_review_id: Mapped[str | None] = mapped_column(ForeignKey("qc_review.id"))
    override_of: Mapped[str | None] = mapped_column(ForeignKey("qc_issue.id"))
    overridden: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    created_by: Mapped[str | None] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        UTCDateTime(), default=utcnow, onupdate=utcnow, nullable=False
    )
    reviewed_by: Mapped[str | None] = mapped_column(String(64))
    reviewed_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    resolved_by: Mapped[str | None] = mapped_column(String(64))
    resolved_at: Mapped[datetime | None] = mapped_column(UTCDateTime())


class QCIssueEvent(Base):
    """One row per lifecycle transition (issue → review → action → resolution)."""

    __tablename__ = "qc_issue_event"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    project_id: Mapped[str] = mapped_column(ForeignKey("project.id"), nullable=False, index=True)
    issue_id: Mapped[str] = mapped_column(ForeignKey("qc_issue.id"), nullable=False, index=True)
    action: Mapped[str] = mapped_column(String(24), nullable=False)
    from_status: Mapped[str | None] = mapped_column(String(20))
    to_status: Mapped[str] = mapped_column(String(20), nullable=False)
    detail_json: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    reason: Mapped[str | None] = mapped_column(Text)
    actor_id: Mapped[str | None] = mapped_column(String(64))
    at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow, nullable=False)


# --------------------------------------------------------------------------- annotations


class AnnotationVersion(Base):
    """One immutable version of an annotation. Geometry is in LEVEL-0 PIXEL coordinates
    (x to the right, y downwards, origin at the top-left of level 0)."""

    __tablename__ = "annotation_version"
    __table_args__ = (UniqueConstraint("annotation_id", "version"),)

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    annotation_id: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    version: Mapped[int] = mapped_column(Integer, nullable=False)
    project_id: Mapped[str] = mapped_column(ForeignKey("project.id"), nullable=False, index=True)
    slide_id: Mapped[str] = mapped_column(ForeignKey("slide.id"), nullable=False, index=True)
    geometry_type: Mapped[str] = mapped_column(String(16), nullable=False)  # polygon | rectangle
    geometry_json: Mapped[dict] = mapped_column(JSON, nullable=False)
    transform_meta_json: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    label: Mapped[str | None] = mapped_column(String(100))
    comment: Mapped[str | None] = mapped_column(Text)
    author_id: Mapped[str] = mapped_column(String(64), nullable=False)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow, nullable=False)
    reason: Mapped[str | None] = mapped_column(Text)
    superseded_by: Mapped[str | None] = mapped_column(String(32))
    deleted: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)


# --------------------------------------------------------------------------- labels & review


class LabelVersion(Base):
    """Append-only. Expert labels and model suggestions are separate rows (``source``);
    reviewing a suggestion creates a NEW expert row that points at the suggestion."""

    __tablename__ = "label_version"
    __table_args__ = (
        UniqueConstraint("label_id", "version"),
        Index("ix_label_target", "project_id", "scope", "target_id"),
    )

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    label_id: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    version: Mapped[int] = mapped_column(Integer, nullable=False)
    project_id: Mapped[str] = mapped_column(ForeignKey("project.id"), nullable=False, index=True)
    scope: Mapped[str] = mapped_column(String(16), nullable=False)  # case | slide | region
    target_id: Mapped[str] = mapped_column(String(32), nullable=False)
    slide_id: Mapped[str | None] = mapped_column(ForeignKey("slide.id"), index=True)
    case_id: Mapped[str | None] = mapped_column(ForeignKey("case_record.id"), index=True)
    annotation_id: Mapped[str | None] = mapped_column(String(32))
    value: Mapped[str | None] = mapped_column(String(40))  # null for reject/hide judgements
    source: Mapped[str] = mapped_column(String(24), nullable=False)  # expert | model_suggestion
    suggestion_origin: Mapped[str | None] = mapped_column(String(24))
    model_ref: Mapped[str | None] = mapped_column(String(120))
    score: Mapped[float | None] = mapped_column(Float)
    author_id: Mapped[str | None] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow, nullable=False)
    reason: Mapped[str | None] = mapped_column(Text)
    review_action: Mapped[str | None] = mapped_column(String(16))  # accepted|corrected|rejected|hidden
    review_of_suggestion_id: Mapped[str | None] = mapped_column(ForeignKey("label_version.id"))
    supersedes: Mapped[str | None] = mapped_column(ForeignKey("label_version.id"))
    is_adjudication: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    disagreement_id: Mapped[str | None] = mapped_column(String(32))


class ReviewAssessment(Base):
    """Independent initial assessment, recorded before model suggestions are revealed."""

    __tablename__ = "review_assessment"
    __table_args__ = (UniqueConstraint("slide_id", "reviewer_id"),)

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    project_id: Mapped[str] = mapped_column(ForeignKey("project.id"), nullable=False, index=True)
    slide_id: Mapped[str] = mapped_column(ForeignKey("slide.id"), nullable=False, index=True)
    reviewer_id: Mapped[str] = mapped_column(String(64), nullable=False)
    value: Mapped[str] = mapped_column(String(40), nullable=False)
    confidence: Mapped[str | None] = mapped_column(String(16))
    comment: Mapped[str | None] = mapped_column(Text)
    time_spent_seconds: Mapped[float | None] = mapped_column(Float)
    suggestions_were_hidden: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    label_version_id: Mapped[str | None] = mapped_column(String(32))
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow, nullable=False)


class Disagreement(Base):
    __tablename__ = "disagreement"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    project_id: Mapped[str] = mapped_column(ForeignKey("project.id"), nullable=False, index=True)
    scope: Mapped[str] = mapped_column(String(16), nullable=False)
    target_id: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    slide_id: Mapped[str | None] = mapped_column(String(32))
    case_id: Mapped[str | None] = mapped_column(String(32))
    label_version_ids_json: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    values_json: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="open")
    adjudication_label_version_id: Mapped[str | None] = mapped_column(String(32))
    adjudicated_by: Mapped[str | None] = mapped_column(String(64))
    adjudicated_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    reason: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        UTCDateTime(), default=utcnow, onupdate=utcnow, nullable=False
    )


class Comment(Base):
    __tablename__ = "comment"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    project_id: Mapped[str] = mapped_column(ForeignKey("project.id"), nullable=False, index=True)
    slide_id: Mapped[str] = mapped_column(ForeignKey("slide.id"), nullable=False, index=True)
    author_id: Mapped[str] = mapped_column(String(64), nullable=False)
    body: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow, nullable=False)


# --------------------------------------------------------------------------- datasets


class DatasetVersion(Base):
    __tablename__ = "dataset_version"
    __table_args__ = (UniqueConstraint("lineage_id", "version"),)

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    project_id: Mapped[str] = mapped_column(ForeignKey("project.id"), nullable=False, index=True)
    lineage_id: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="draft")
    config_json: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    manifest_json: Mapped[dict | None] = mapped_column(JSON)
    manifest_sha256: Mapped[str | None] = mapped_column(String(64))
    manifest_object_key: Mapped[str | None] = mapped_column(String(300))
    # Snapshot of slides NOT included and why, taken when items were (re)materialised.
    exclusions_json: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    materialized_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    reason: Mapped[str | None] = mapped_column(Text)
    created_by: Mapped[str] = mapped_column(String(64), nullable=False)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow, nullable=False)
    frozen_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    frozen_by: Mapped[str | None] = mapped_column(String(64))
    parent_version_id: Mapped[str | None] = mapped_column(ForeignKey("dataset_version.id"))


class DatasetItem(Base):
    """One included slide. Lineage and slide metadata are SNAPSHOTS taken at materialise time (design §2):
    manifests and split allocation read these columns, never the live hierarchy, so a slide moved or re-described
    after materialise cannot silently change a version (freeze re-materialises and refuses a stale draft)."""

    __tablename__ = "dataset_item"
    __table_args__ = (UniqueConstraint("dataset_version_id", "slide_id"),)

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    dataset_version_id: Mapped[str] = mapped_column(
        ForeignKey("dataset_version.id"), nullable=False, index=True
    )
    slide_id: Mapped[str] = mapped_column(ForeignKey("slide.id"), nullable=False)
    slide_sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    label_version_id: Mapped[str] = mapped_column(ForeignKey("label_version.id"), nullable=False)
    label_value: Mapped[str] = mapped_column(String(40), nullable=False)
    label_scope: Mapped[str] = mapped_column(String(16), nullable=False)
    case_id: Mapped[str] = mapped_column(ForeignKey("case_record.id"), nullable=False)
    coded_patient_id: Mapped[str] = mapped_column(ForeignKey("coded_patient.id"), nullable=False)
    # Snapshot at materialise time (nullable: a value may genuinely be unknown, e.g. mpp or site).
    patient_code: Mapped[str | None] = mapped_column(String(32))
    accession_code: Mapped[str | None] = mapped_column(String(40))
    part: Mapped[str | None] = mapped_column(String(4))
    block_id: Mapped[str | None] = mapped_column(String(32))
    block: Mapped[str | None] = mapped_column(String(8))
    level_index: Mapped[int | None] = mapped_column(Integer)
    site_id: Mapped[str | None] = mapped_column(String(64))
    collected_on: Mapped[date | None] = mapped_column(Date)
    scanner_id: Mapped[str | None] = mapped_column(String(64))
    stain: Mapped[str | None] = mapped_column(String(64))
    mpp_x: Mapped[float | None] = mapped_column(Float)
    mpp_y: Mapped[float | None] = mapped_column(Float)
    image_kind: Mapped[str | None] = mapped_column(String(24))
    provenance: Mapped[str | None] = mapped_column(String(32))
    # How the reference label was reached: adjudicated | agreed | single_reader (always an expert label).
    label_source: Mapped[str | None] = mapped_column(String(24))


class SplitAssignment(Base):
    __tablename__ = "split_assignment"
    __table_args__ = (UniqueConstraint("dataset_version_id", "coded_patient_id"),)

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    dataset_version_id: Mapped[str] = mapped_column(
        ForeignKey("dataset_version.id"), nullable=False, index=True
    )
    coded_patient_id: Mapped[str] = mapped_column(ForeignKey("coded_patient.id"), nullable=False)
    split: Mapped[str] = mapped_column(String(8), nullable=False)
    partition: Mapped[str] = mapped_column(String(16), nullable=False)


class SplitFamily(Base):
    """Patient → split assignments shared by every version of one dataset lineage (design §2, split families).

    Created by the lineage's first split assignment. ``salt`` and the lineage never change; ``partition_json`` may
    change only while no version of the lineage is frozen (afterwards a different partition or seed needs a new
    lineage, with a reason). Rows are never deleted.
    """

    __tablename__ = "split_family"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    project_id: Mapped[str] = mapped_column(ForeignKey("project.id"), nullable=False, index=True)
    lineage_id: Mapped[str] = mapped_column(String(32), nullable=False, unique=True)
    salt: Mapped[str] = mapped_column(String(64), nullable=False)
    partition_json: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow, nullable=False)
    created_by: Mapped[str | None] = mapped_column(String(64))


class SplitFamilyAssignment(Base):
    """A patient's split in a family, written when the first version containing the patient is frozen.

    Insert-only: ``split`` never changes and rows are never deleted. ``sealed_at``/``sealed_reason``/``sealed_by``
    are set once, when a test release happens on any version of the lineage; sealed patients never change split.
    """

    __tablename__ = "split_family_assignment"
    __table_args__ = (UniqueConstraint("family_id", "coded_patient_id"),)

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    family_id: Mapped[str] = mapped_column(ForeignKey("split_family.id"), nullable=False, index=True)
    coded_patient_id: Mapped[str] = mapped_column(ForeignKey("coded_patient.id"), nullable=False)
    patient_code: Mapped[str] = mapped_column(String(32), nullable=False)
    split: Mapped[str] = mapped_column(String(8), nullable=False)
    first_version_id: Mapped[str] = mapped_column(ForeignKey("dataset_version.id"), nullable=False)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow, nullable=False)
    sealed_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    sealed_reason: Mapped[str | None] = mapped_column(Text)
    sealed_by: Mapped[str | None] = mapped_column(String(64))


class NearDuplicateReview(Base):
    """A human decision on a near-duplicate CANDIDATE pair. Nothing is removed automatically."""

    __tablename__ = "near_duplicate_review"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    project_id: Mapped[str] = mapped_column(ForeignKey("project.id"), nullable=False, index=True)
    slide_a_id: Mapped[str] = mapped_column(ForeignKey("slide.id"), nullable=False)
    slide_b_id: Mapped[str] = mapped_column(ForeignKey("slide.id"), nullable=False)
    decision: Mapped[str] = mapped_column(String(16), nullable=False)  # distinct|duplicate|unsure
    reason: Mapped[str | None] = mapped_column(Text)
    reviewer_id: Mapped[str] = mapped_column(String(64), nullable=False)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow, nullable=False)


# --------------------------------------------------------------------------- platform


class Job(Base):
    __tablename__ = "job"
    __table_args__ = (Index("ix_job_claim", "status", "not_before"),)

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    project_id: Mapped[str | None] = mapped_column(ForeignKey("project.id"), index=True)
    type: Mapped[str] = mapped_column(String(64), nullable=False)
    payload_json: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    idempotency_key: Mapped[str] = mapped_column(String(200), nullable=False, unique=True)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="queued")
    attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    max_attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=3)
    retry_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    not_before: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow, nullable=False)
    lease_owner: Mapped[str | None] = mapped_column(String(120))
    lease_until: Mapped[datetime | None] = mapped_column(UTCDateTime())
    heartbeat_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    progress: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    progress_message: Mapped[str | None] = mapped_column(String(300))
    result_json: Mapped[dict | None] = mapped_column(JSON)
    error: Mapped[str | None] = mapped_column(Text)
    cancel_requested: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    created_by: Mapped[str | None] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow, nullable=False)
    started_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    finished_at: Mapped[datetime | None] = mapped_column(UTCDateTime())
    updated_at: Mapped[datetime] = mapped_column(
        UTCDateTime(), default=utcnow, onupdate=utcnow, nullable=False
    )


class WorkerHeartbeat(Base):
    __tablename__ = "worker_heartbeat"

    worker_id: Mapped[str] = mapped_column(String(120), primary_key=True)
    pid: Mapped[int | None] = mapped_column(Integer)
    hostname: Mapped[str | None] = mapped_column(String(200))
    started_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow, nullable=False)
    last_seen_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow, nullable=False)
    current_job_id: Mapped[str | None] = mapped_column(String(32))
    jobs_processed: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    handler_types_json: Mapped[list] = mapped_column(JSON, nullable=False, default=list)


class AuditEvent(Base):
    """Append-only. No pixels, no credentials, no file contents."""

    __tablename__ = "audit_event"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow, nullable=False, index=True)
    actor_id: Mapped[str | None] = mapped_column(String(64))
    actor_role: Mapped[str | None] = mapped_column(String(32))
    project_id: Mapped[str | None] = mapped_column(String(64), index=True)
    action: Mapped[str] = mapped_column(String(64), nullable=False)
    entity_type: Mapped[str] = mapped_column(String(48), nullable=False)
    entity_id: Mapped[str | None] = mapped_column(String(64), index=True)
    before_json: Mapped[Any | None] = mapped_column(JSON)
    after_json: Mapped[Any | None] = mapped_column(JSON)
    reason: Mapped[str | None] = mapped_column(Text)
    correlation_id: Mapped[str | None] = mapped_column(String(64), index=True)


# --------------------------------------------------------------------------- immutability guards

_APPEND_ONLY = (AuditEvent, LabelVersion, ReviewAssessment)
_NO_BULK = (AuditEvent, LabelVersion, ReviewAssessment, DatasetVersion, DatasetItem, SplitAssignment, SplitFamily,
            SplitFamilyAssignment)
_SEAL_FIELDS = {"sealed_at", "sealed_reason", "sealed_by"}


def _dataset_frozen(session: Session, dataset_version_id: str | None) -> bool:
    if not dataset_version_id:
        return False
    for obj in session.new:
        if isinstance(obj, DatasetVersion) and obj.id == dataset_version_id:
            return obj.status == "frozen"
    with session.no_autoflush:
        dv = session.get(DatasetVersion, dataset_version_id)
    if dv is None:
        return False
    committed = inspect(dv).committed_state.get("status", dv.status)
    return committed == "frozen"


def _lineage_locked(session: Session, lineage_id: str | None) -> bool:
    """A split family is locked once any version of its lineage is frozen (in the database)."""
    if not lineage_id:
        return False
    with session.no_autoflush:
        return session.scalars(select(DatasetVersion.id).where(DatasetVersion.lineage_id == lineage_id,
                                                               DatasetVersion.status == "frozen")).first() is not None


def _changed_attrs(obj) -> set[str]:
    return {a.key for a in inspect(obj).attrs if a.history.has_changes()}


@event.listens_for(Session, "before_flush")
def _guard_immutables(session: Session, flush_context, instances) -> None:
    for obj in list(session.dirty):
        if not session.is_modified(obj, include_collections=False):
            continue
        if isinstance(obj, _APPEND_ONLY):
            raise ImmutableRecordError(f"{type(obj).__name__} is append-only")
        if isinstance(obj, DatasetVersion):
            committed = inspect(obj).committed_state.get("status", obj.status)
            if committed == "frozen":
                raise FrozenDatasetError(f"dataset version {obj.id} is frozen")
        if isinstance(obj, (DatasetItem, SplitAssignment)):
            if _dataset_frozen(session, obj.dataset_version_id):
                raise FrozenDatasetError("frozen dataset items and splits are immutable")
        if isinstance(obj, AnnotationVersion):
            state = inspect(obj)
            changed = {a.key for a in state.attrs if a.history.has_changes()}
            if changed - {"superseded_by"}:
                raise ImmutableRecordError("annotation versions are immutable; create a new version")
            previous = [v for v in state.attrs.superseded_by.history.deleted if v is not None]
            if previous:
                raise ImmutableRecordError("annotation version already superseded")
        if isinstance(obj, SplitFamily):
            changed = _changed_attrs(obj)
            if changed - {"partition_json"}:
                raise ImmutableRecordError("a split family's salt and lineage never change")
            committed_lineage = inspect(obj).committed_state.get("lineage_id", obj.lineage_id)
            if changed and _lineage_locked(session, committed_lineage):
                raise ImmutableRecordError("split family is locked (a version of its lineage is frozen); "
                                           "start a new lineage to change the partition")
        if isinstance(obj, SplitFamilyAssignment):
            state = inspect(obj)
            changed = _changed_attrs(obj)
            if changed - _SEAL_FIELDS:
                raise ImmutableRecordError("split family assignments never change split; only sealing is recorded")
            hist = state.attrs.sealed_at.history
            previous = list(hist.deleted) if hist.has_changes() else [obj.sealed_at]
            if changed and any(v is not None for v in previous):
                raise ImmutableRecordError("split family assignment is already sealed")
    for obj in list(session.deleted):
        if isinstance(obj, (*_APPEND_ONLY, AnnotationVersion, SplitFamily, SplitFamilyAssignment)):
            raise ImmutableRecordError(f"{type(obj).__name__} rows are never deleted")
        if isinstance(obj, DatasetVersion):
            committed = inspect(obj).committed_state.get("status", obj.status)
            if committed == "frozen":
                raise FrozenDatasetError(f"dataset version {obj.id} is frozen")
        if isinstance(obj, (DatasetItem, SplitAssignment)):
            if _dataset_frozen(session, obj.dataset_version_id):
                raise FrozenDatasetError("frozen dataset items and splits are immutable")
    for obj in list(session.new):
        if isinstance(obj, (DatasetItem, SplitAssignment)):
            if _dataset_frozen(session, obj.dataset_version_id):
                raise FrozenDatasetError("cannot add items or splits to a frozen dataset version")


@event.listens_for(Session, "do_orm_execute")
def _guard_bulk(state) -> None:
    if not (state.is_update or state.is_delete):
        return
    mapper = state.bind_mapper
    if mapper is not None and mapper.class_ in _NO_BULK:
        raise ImmutableRecordError(
            f"bulk UPDATE/DELETE on {mapper.class_.__name__} is not allowed (immutability guard)"
        )


# SQLite triggers: defence in depth against raw SQL on the local database. Created only on
# SQLite (execute_if); PostgreSQL relies on the ORM guards above (equivalent PL/pgSQL
# triggers are not written yet; see the backend report).
_SQLITE_TRIGGERS = {
    AuditEvent.__table__: [
        "CREATE TRIGGER IF NOT EXISTS audit_event_no_update BEFORE UPDATE ON audit_event "
        "BEGIN SELECT RAISE(ABORT, 'audit_event is append-only'); END",
        "CREATE TRIGGER IF NOT EXISTS audit_event_no_delete BEFORE DELETE ON audit_event "
        "BEGIN SELECT RAISE(ABORT, 'audit_event is append-only'); END",
    ],
    LabelVersion.__table__: [
        "CREATE TRIGGER IF NOT EXISTS label_version_no_update BEFORE UPDATE ON label_version "
        "BEGIN SELECT RAISE(ABORT, 'label_version is append-only'); END",
        "CREATE TRIGGER IF NOT EXISTS label_version_no_delete BEFORE DELETE ON label_version "
        "BEGIN SELECT RAISE(ABORT, 'label_version is append-only'); END",
    ],
    DatasetVersion.__table__: [
        "CREATE TRIGGER IF NOT EXISTS dataset_version_frozen_update BEFORE UPDATE ON dataset_version "
        "WHEN OLD.status = 'frozen' BEGIN SELECT RAISE(ABORT, 'dataset version is frozen'); END",
        "CREATE TRIGGER IF NOT EXISTS dataset_version_frozen_delete BEFORE DELETE ON dataset_version "
        "WHEN OLD.status = 'frozen' BEGIN SELECT RAISE(ABORT, 'dataset version is frozen'); END",
    ],
    DatasetItem.__table__: [
        "CREATE TRIGGER IF NOT EXISTS dataset_item_frozen_insert BEFORE INSERT ON dataset_item "
        "WHEN (SELECT status FROM dataset_version WHERE id = NEW.dataset_version_id) = 'frozen' "
        "BEGIN SELECT RAISE(ABORT, 'dataset version is frozen'); END",
        "CREATE TRIGGER IF NOT EXISTS dataset_item_frozen_update BEFORE UPDATE ON dataset_item "
        "WHEN (SELECT status FROM dataset_version WHERE id = OLD.dataset_version_id) = 'frozen' "
        "BEGIN SELECT RAISE(ABORT, 'dataset version is frozen'); END",
        "CREATE TRIGGER IF NOT EXISTS dataset_item_frozen_delete BEFORE DELETE ON dataset_item "
        "WHEN (SELECT status FROM dataset_version WHERE id = OLD.dataset_version_id) = 'frozen' "
        "BEGIN SELECT RAISE(ABORT, 'dataset version is frozen'); END",
    ],
    SplitFamily.__table__: [
        "CREATE TRIGGER IF NOT EXISTS split_family_identity_update BEFORE UPDATE ON split_family "
        "WHEN NEW.salt IS NOT OLD.salt OR NEW.lineage_id IS NOT OLD.lineage_id OR NEW.project_id IS NOT OLD.project_id "
        "OR NEW.id IS NOT OLD.id BEGIN SELECT RAISE(ABORT, 'split family identity never changes'); END",
        "CREATE TRIGGER IF NOT EXISTS split_family_locked_update BEFORE UPDATE ON split_family "
        "WHEN EXISTS (SELECT 1 FROM dataset_version WHERE lineage_id = OLD.lineage_id AND status = 'frozen') "
        "BEGIN SELECT RAISE(ABORT, 'split family is locked'); END",
        "CREATE TRIGGER IF NOT EXISTS split_family_no_delete BEFORE DELETE ON split_family "
        "BEGIN SELECT RAISE(ABORT, 'split families are never deleted'); END",
    ],
    SplitFamilyAssignment.__table__: [
        "CREATE TRIGGER IF NOT EXISTS split_family_assignment_update BEFORE UPDATE ON split_family_assignment "
        "WHEN NEW.split IS NOT OLD.split OR NEW.family_id IS NOT OLD.family_id "
        "OR NEW.coded_patient_id IS NOT OLD.coded_patient_id OR NEW.patient_code IS NOT OLD.patient_code "
        "OR NEW.first_version_id IS NOT OLD.first_version_id OR NEW.id IS NOT OLD.id "
        "OR OLD.sealed_at IS NOT NULL "
        "BEGIN SELECT RAISE(ABORT, 'split family assignments never change; only sealing is recorded, once'); END",
        "CREATE TRIGGER IF NOT EXISTS split_family_assignment_no_delete BEFORE DELETE ON split_family_assignment "
        "BEGIN SELECT RAISE(ABORT, 'split family assignments are never deleted'); END",
    ],
    SplitAssignment.__table__: [
        "CREATE TRIGGER IF NOT EXISTS split_frozen_insert BEFORE INSERT ON split_assignment "
        "WHEN (SELECT status FROM dataset_version WHERE id = NEW.dataset_version_id) = 'frozen' "
        "BEGIN SELECT RAISE(ABORT, 'dataset version is frozen'); END",
        "CREATE TRIGGER IF NOT EXISTS split_frozen_update BEFORE UPDATE ON split_assignment "
        "WHEN (SELECT status FROM dataset_version WHERE id = OLD.dataset_version_id) = 'frozen' "
        "BEGIN SELECT RAISE(ABORT, 'dataset version is frozen'); END",
        "CREATE TRIGGER IF NOT EXISTS split_frozen_delete BEFORE DELETE ON split_assignment "
        "WHEN (SELECT status FROM dataset_version WHERE id = OLD.dataset_version_id) = 'frozen' "
        "BEGIN SELECT RAISE(ABORT, 'dataset version is frozen'); END",
    ],
}
for _table, _stmts in _SQLITE_TRIGGERS.items():
    for _stmt in _stmts:
        event.listen(_table, "after_create", DDL(_stmt).execute_if(dialect="sqlite"))
