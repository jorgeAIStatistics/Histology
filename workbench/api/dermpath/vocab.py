"""Controlled vocabularies shared by models, routers and the frontend (``GET /api/v1/meta``)."""

from __future__ import annotations

ROLES = (
    "histology_assistant",
    "pathologist",
    "research_lead",
    "medical_director",
    "admin",
)

PROVENANCES = ("demo_synthetic", "public_cc0", "public_licensed", "real_authorized")
PROVENANCE_DISPLAY = {
    "demo_synthetic": "DEMO SYNTHETIC (procedural tiles, not histology)",
    "public_cc0": "PUBLIC CC0 (OpenSlide test data, unlabeled)",
    # A published research dataset under a licence other than CC0 (for example CC BY-NC-SA 4.0). The licence,
    # attribution and source are recorded with the project (settings_json.public_dataset) and on every case note.
    "public_licensed": ("PUBLIC LICENSED DATASET (third-party research data; licence terms recorded with the project, "
                        "e.g. non-commercial)"),
    "real_authorized": "REAL DATA (authorized; attestation recorded, not proof of de-identification)",
}
#: Provenances whose items are real images (dataset ``data_mode == "real"``).
REAL_PROVENANCES = ("public_cc0", "public_licensed", "real_authorized")
#: Public provenances: no local authorisation is needed, but the source's licence terms apply.
PUBLIC_PROVENANCES = ("public_cc0", "public_licensed")

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
# ``imported_reference``: a label taken from an external dataset's own reference standard (for example the COBRA
# labels, extracted from pathology reports by a rule-based method). It is never an expert read in this workbench,
# never an expert opinion in disagreement detection, and it becomes a dataset's reference label only when the
# dataset declares ``reference_standard == "imported_reference"``. Its free-text provenance is the label's reason.
LABEL_SOURCES = ("expert", "model_suggestion", "imported_reference")
LABEL_SOURCE_DISPLAY = {
    "expert": "Expert label recorded by a pathologist in this workbench",
    "model_suggestion": "Model suggestion (not expert truth)",
    "imported_reference": ("Imported reference label from an external dataset's reference standard "
                           "(not an expert read in this workbench)"),
}
# The reference standard a dataset version declares (config ``reference_standard``, recorded in the manifest).
# ``expert`` is the default everywhere.
REFERENCE_STANDARDS = ("expert", "imported_reference")
DEFAULT_REFERENCE_STANDARD = "expert"
REFERENCE_STANDARD_DISPLAY = {
    "expert": ("Expert reference: adjudicated, agreed or single-reader expert labels recorded in this workbench"),
    "imported_reference": ("Imported reference: labels from an external dataset's own reference standard (see each "
                           "label's provenance); not expert reads in this workbench"),
}
#: Reference standard -> the label sources accepted as reference (and training) labels under it.
REFERENCE_STANDARD_LABEL_SOURCES = {
    "expert": ("expert",),
    "imported_reference": ("imported_reference",),
}
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
DATASET_ELIGIBLE_REVIEW_STATES = ("approved", "pending_review", "imported")
# ``imported`` means nobody has reviewed the slide in this workbench. Only a dataset whose reference standard is
# ``imported_reference`` may list it (explicitly); expert-reference datasets refuse it.
IMPORTED_REFERENCE_ONLY_REVIEW_STATES = ("imported",)
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
