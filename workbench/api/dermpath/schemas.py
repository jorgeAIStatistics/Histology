"""Pydantic request/response schemas for the /api/v1 contract.

Request models forbid unknown fields. Response models list the guaranteed fields and
allow extra keys (``extra="allow"``) so additive changes do not break clients.
"""

from __future__ import annotations

from datetime import date, datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


class Req(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Out(BaseModel):
    model_config = ConfigDict(extra="allow")


# --------------------------------------------------------------------------- auth

class DemoLoginIn(Req):
    user_id: str = Field(..., alias="userId", description="id of a seeded fictional demo user")
    model_config = ConfigDict(extra="forbid", populate_by_name=True)


class UserOut(Out):
    id: str
    display_name: str
    role: str
    active: bool
    demo_user: bool


class MembershipOut(Out):
    project_id: str
    project_name: str
    independent_review: bool | None = None


class MeOut(Out):
    user: UserOut
    mode: str
    notice: str
    authentication: str
    memberships: list[MembershipOut]
    permissions: dict[str, list[str]]


# --------------------------------------------------------------------------- projects & hierarchy

class ProjectSettingsIn(Req):
    independent_review: bool


class MemberSettingsIn(Req):
    independent_review: bool | None = Field(None, description="null = inherit the project setting")


class MemberAddIn(Req):
    user_id: str


class PatientIn(Req):
    code: str = Field(..., examples=["P-0007"], description="coded id; never a name, MRN or birth date")


class CaseIn(Req):
    coded_patient_id: str
    accession_code: str = Field(..., examples=["DEMO-S26-0099"], description="a STUDY code, not the lab accession")
    collected_on: date | None = None
    site_id: str | None = Field(None, examples=["site-north"])
    provenance: Literal["demo_synthetic", "public_cc0", "real_authorized"] = "public_cc0"
    note: str | None = Field(None, max_length=2000)


class CasePatchIn(Req):
    collected_on: date | None = None
    site_id: str | None = None
    note: str | None = Field(None, max_length=2000)
    reason: str | None = None


class PartIn(Req):
    designation: str = Field(..., examples=["A"])
    anatomic_site_text: str | None = Field(None, max_length=200)


class PartPatchIn(Req):
    anatomic_site_text: str | None = Field(None, max_length=200)
    reason: str | None = None


class BlockIn(Req):
    designation: str = Field(..., examples=["A1"])


class SlidePatchIn(Req):
    block_id: str | None = None
    level_index: int | None = Field(None, ge=0, le=999)
    stain: str | None = Field(None, max_length=64)
    scanner_id: str | None = None
    scanned_at: datetime | None = None
    reason: str | None = None


# --------------------------------------------------------------------------- uploads

class NewHierarchyIn(Req):
    patient_code: str
    accession_code: str
    part_designation: str
    block_designation: str
    collected_on: date | None = None
    site_id: str | None = None
    anatomic_site_text: str | None = Field(None, max_length=200)


class UploadIn(Req):
    filename: str = Field(..., max_length=255)
    size: int = Field(..., gt=0)
    sha256: str = Field(..., min_length=64, max_length=64)
    provenance: Literal["public_cc0", "real_authorized"] = "public_cc0"
    kind_hint: Literal["wsi", "field_image"] | None = None
    block_id: str | None = None
    new_hierarchy: NewHierarchyIn | None = None
    level_index: int | None = Field(None, ge=0, le=999)
    stain: str | None = Field(None, max_length=64)
    scanner_id: str | None = None
    governance_attestation: bool = False


class UploadOut(Out):
    upload_id: str
    status: Literal["receiving", "completed", "duplicate", "failed", "canceled"]
    chunk_size: int
    received_bytes: int
    next_chunk_index: int
    total_chunks: int
    declared_size: int
    kind: str
    identifier_risk: list[dict]
    slide_id: str | None = None
    duplicate_of_slide_id: str | None = None
    job_id: str | None = None
    error: str | None = None


# --------------------------------------------------------------------------- slides

class SlideOut(Out):
    id: str
    project_id: str
    image_kind: Literal["wsi", "field_image", "synthetic_tiles"]
    provenance: str
    provenance_display: str
    review_state: str
    ingest_status: str
    ingest_error: str | None = None
    sha256: str
    width: int | None = None
    height: int | None = None
    levels: int | None = None
    mpp_x: float | None = None
    mpp_y: float | None = None
    scale_bar_allowed: bool
    identifier_risk: list[dict]
    lineage: dict


class ViewerTokenOut(Out):
    token: str
    dzi_url: str
    tile_url_template: str
    thumbnail_url: str
    expires_at: datetime
    ttl_seconds: int
    image_kind: str
    provenance: str
    mpp_x: float | None
    mpp_y: float | None
    scale_bar_allowed: bool
    width: int | None
    height: int | None


class CommentIn(Req):
    body: str = Field(..., min_length=1, max_length=4000)


# --------------------------------------------------------------------------- QC

class QCIssueIn(Req):
    category: str
    region: dict | None = Field(None, description="optional level-0 pixel geometry (same format as annotations)")
    note: str | None = Field(None, max_length=4000)
    override_of: str | None = Field(None, description="heuristic issue id this human finding supersedes")
    reason: str | None = None


class QCIssuePatchIn(Req):
    action: Literal["review", "suggest_action", "resolve", "override", "reopen"]
    reason: str | None = None
    confirmed: bool | None = None
    suggested_action: str | None = None
    resolution: str | None = None
    dataset_eligibility_effect: Literal["none", "exclude_slide", "exclude_region"] | None = None


class QCOverrideIn(Req):
    review_id: str
    metric: Literal["tissue_fraction", "focus", "calibration"]
    verdict: Literal["adequate", "inadequate", "not_assessable"]
    reason: str = Field(..., min_length=1)


# --------------------------------------------------------------------------- annotations

class AnnotationIn(Req):
    geometry: dict = Field(..., examples=[{"type": "polygon", "points": [[10.5, 20.25], [300, 20], [150.75, 400]]},
                                          {"type": "rectangle", "x": 100, "y": 200, "width": 50, "height": 80}])
    label: str | None = Field(None, max_length=100)
    comment: str | None = Field(None, max_length=4000)
    transform_meta: dict | None = Field(None, description="how the client converted viewer→level-0 coordinates")


class AnnotationPatchIn(Req):
    reason: str = Field(..., min_length=1)
    geometry: dict | None = None
    label: str | None = Field(None, max_length=100)
    comment: str | None = Field(None, max_length=4000)
    transform_meta: dict | None = None


class AnnotationDeleteIn(Req):
    reason: str = Field(..., min_length=1)


# --------------------------------------------------------------------------- labels & review

LabelValue = Literal["bcc_present", "bcc_absent_not_benign", "indeterminate", "inadequate", "out_of_scope"]


class LabelIn(Req):
    scope: Literal["case", "slide", "region"] = "slide"
    target_id: str | None = Field(None, description="case id (scope=case) or annotation id (scope=region)")
    value: LabelValue
    reason: str | None = None


class SuggestionReviewIn(Req):
    action: Literal["accept", "correct", "reject", "hide"]
    value: LabelValue | None = None
    reason: str | None = None


class AssessmentIn(Req):
    value: LabelValue
    confidence: Literal["low", "medium", "high"] | None = None
    comment: str | None = Field(None, max_length=4000)
    time_spent_seconds: float | None = Field(None, ge=0)
    record_as_label: bool = False


class ReviewStateIn(Req):
    state: Literal["pending_review", "approved", "disputed", "excluded"]
    reason: str | None = None


class AdjudicateIn(Req):
    value: LabelValue
    reason: str = Field(..., min_length=1)


class NearDuplicateReviewIn(Req):
    slide_a_id: str
    slide_b_id: str
    decision: Literal["distinct", "duplicate", "unsure"]
    reason: str | None = None


class LabelOut(Out):
    id: str
    label_id: str
    version: int
    scope: str
    target_id: str
    value: str | None
    display: str | None
    source: Literal["expert", "model_suggestion"]
    review_action: str | None
    review_of_suggestion_id: str | None
    is_adjudication: bool


# --------------------------------------------------------------------------- datasets

class SplitIn(Req):
    """Patient-grouped split request (validated in ``dermpath.splits.normalise_split``). ``seed`` and ``ratios`` are
    for ``random`` and ``external_site`` (ratios for train/val only there); ``temporal`` rejects them."""

    partition: Literal["random", "temporal", "external_site"] = "random"
    seed: int | None = Field(None, description="0 when omitted; rejected for temporal partitions")
    ratios: dict[str, float] | None = Field(None, examples=[{"train": 0.6, "val": 0.2, "test": 0.2}])
    test_cutoff: date | None = None
    val_cutoff: date | None = None
    test_sites: list[str] | None = None
    patient_label_rule: Literal["any_positive", "majority"] | None = Field(
        None, description="patient label used for stratification only (default any_positive)")


class DatasetConfigIn(Req):
    label_scope: Literal["slide", "case"] = "slide"
    eligible_review_states: list[Literal["approved", "pending_review"]] = ["approved"]
    label_values: list[LabelValue] | None = None
    include_provenance: list[Literal["demo_synthetic", "public_cc0", "real_authorized"]] | None = None
    split: SplitIn | None = None


class DatasetIn(Req):
    name: str = Field(..., min_length=1, max_length=200)
    config: DatasetConfigIn = DatasetConfigIn()


class NewVersionIn(Req):
    reason: str = Field(..., min_length=1)
    name: str | None = None
    # Children inherit the lineage's split family. Another partition or seed needs a new lineage (and a new family);
    # test patients sealed by a test release stay test either way.
    new_lineage: bool = False
    split: SplitIn | None = None


class FreezeIn(Req):
    reason: str | None = None
    # Set to freeze despite the warnings freeze-check lists (open QC issues, unresolved cross-split near-duplicates,
    # splits missing a class, uncalibrated real items); a reason is then required and the acknowledged warnings are
    # written into the immutable manifest.
    acknowledge_warnings: bool = False


class DatasetOut(Out):
    id: str
    project_id: str
    lineage_id: str
    name: str
    version: int
    status: Literal["draft", "frozen"]
    config: dict
    manifest_sha256: str | None
    parent_version_id: str | None


# --------------------------------------------------------------------------- jobs & health

class JobOut(Out):
    id: str
    type: str
    status: Literal["queued", "running", "succeeded", "failed", "canceled"]
    attempts: int
    max_attempts: int
    progress: float
    result: dict | None
    error: str | None
    cancel_requested: bool


class HealthOut(Out):
    status: Literal["ok", "degraded", "refusing"]
    mode: str
    checks: dict[str, Any]
