"""Controlled vocabularies shared by models, routers and the frontend (``GET /api/v1/meta``)."""

from __future__ import annotations

ROLES = (
    "histology_assistant",
    "pathologist",
    "research_lead",
    "medical_director",
    "admin",
)

PROVENANCES = ("demo_synthetic", "public_cc0", "real_authorized")
PROVENANCE_DISPLAY = {
    "demo_synthetic": "DEMO SYNTHETIC (procedural tiles, not histology)",
    "public_cc0": "PUBLIC CC0 (OpenSlide test data, unlabeled)",
    "real_authorized": "REAL DATA (authorized; attestation recorded, not proof of de-identification)",
}

IMAGE_KINDS = ("wsi", "field_image", "synthetic_tiles")
INGEST_STATUSES = ("pending", "running", "succeeded", "failed")

REVIEW_STATES = ("imported", "pending_review", "approved", "disputed", "excluded")
# (from, to) → roles allowed. "system" transitions (disagreement detection) bypass roles.
REVIEW_TRANSITIONS: dict[tuple[str, str], tuple[str, ...]] = {
    ("imported", "pending_review"): ("histology_assistant", "pathologist"),
    ("imported", "excluded"): ("pathologist",),
    ("pending_review", "approved"): ("pathologist",),
    ("pending_review", "disputed"): ("pathologist",),
    ("pending_review", "excluded"): ("pathologist",),
    ("disputed", "pending_review"): ("pathologist",),
    ("disputed", "approved"): ("pathologist",),
    ("disputed", "excluded"): ("pathologist",),
    ("approved", "pending_review"): ("pathologist",),
    ("approved", "excluded"): ("pathologist",),
    ("approved", "disputed"): ("pathologist",),
    ("excluded", "pending_review"): ("pathologist",),
}
# Transitions that must carry a reason.
REVIEW_REASON_REQUIRED = {
    ("pending_review", "disputed"),
    ("approved", "disputed"),
    ("imported", "excluded"),
    ("pending_review", "excluded"),
    ("disputed", "excluded"),
    ("approved", "excluded"),
    ("approved", "pending_review"),
    ("excluded", "pending_review"),
    ("disputed", "pending_review"),
}

LABEL_SCOPES = ("case", "slide", "region")
LABEL_SOURCES = ("expert", "model_suggestion")
LABEL_VALUES = (
    "bcc_present",
    "bcc_absent_not_benign",
    "indeterminate",
    "inadequate",
    "out_of_scope",
)
LABEL_DISPLAY = {
    "bcc_present": "BCC present",
    "bcc_absent_not_benign": (
        "BCC absent (may include other malignancy, inflammation or mimics). "
        "BCC absent is NOT the same as benign."
    ),
    "indeterminate": "Indeterminate",
    "inadequate": "Inadequate for assessment",
    "out_of_scope": "Out of scope for this research task",
}
REVIEW_ACTIONS = ("accept", "correct", "reject", "hide")
REVIEW_ACTION_RECORDED = {
    "accept": "accepted",
    "correct": "corrected",
    "reject": "rejected",
    "hide": "hidden",
}
SUGGESTION_ORIGINS = ("demo_fixture", "model")
SUGGESTION_ORIGIN_DISPLAY = {
    "demo_fixture": "DEMO FIXTURE SUGGESTION: NOT produced by a trained model",
    "model": "Research model suggestion (not expert truth)",
}

QC_CATEGORIES = (
    "fold",
    "chatter",
    "stain_variation",
    "contamination_concern",
    "incomplete_tissue",
    "scan_focus",
    "low_tissue_heuristic",
    "blur_heuristic",
    "unreadable_region",
    "missing_calibration",
)
QC_MANUAL_CATEGORIES = (
    "fold",
    "chatter",
    "stain_variation",
    "contamination_concern",
    "incomplete_tissue",
    "scan_focus",
    "unreadable_region",
    "missing_calibration",
)
QC_HEURISTIC_CATEGORIES = ("low_tissue_heuristic", "blur_heuristic", "missing_calibration")
QC_STATUSES = ("open", "reviewed", "action_suggested", "resolved")
QC_ACTIONS = ("review", "suggest_action", "resolve", "override", "reopen")
# Suggested corrective actions are proposals for a human decision. Nothing is ordered,
# recut, rescanned or discarded automatically.
QC_SUGGESTED_ACTIONS = (
    "consider_rescan",
    "consider_recut",
    "consider_restain",
    "review_region",
    "exclude_region_from_training",
    "exclude_slide_from_training",
    "record_calibration",
    "no_action",
    "other",
)
QC_ELIGIBILITY_EFFECTS = ("none", "exclude_slide", "exclude_region")

DATASET_STATUSES = ("draft", "frozen")
SPLITS = ("train", "val", "test")
PARTITIONS = ("random", "temporal", "external_site")
DATASET_LABEL_SCOPES = ("slide", "case")
DATASET_ELIGIBLE_REVIEW_STATES = ("approved", "pending_review")
# Purposes for training_eligible_items(). The test split is reachable ONLY through
# "test_evaluation"; "train", "active_learning" and "threshold_selection" never see it.
ITEM_PURPOSES = ("train", "active_learning", "threshold_selection", "validation", "test_evaluation")
PURPOSE_SPLITS = {
    "train": ("train",),
    "active_learning": ("train",),
    "threshold_selection": ("val",),
    "validation": ("val",),
    "test_evaluation": ("test",),
}
TEST_LOCKED_PURPOSES = ("train", "active_learning", "threshold_selection")

JOB_STATUSES = ("queued", "running", "succeeded", "failed", "canceled")
