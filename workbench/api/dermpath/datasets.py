"""Dataset versions: drafts, eligibility, patient-grouped splits, split families, freeze, test-set lock, audit.

Guarantees
----------
* **Patient-grouped, stratified splits (mandatory).** Splits are assigned per coded patient; every
  slide of a patient lands in one split. Allocation is the pure :mod:`dermpath.splits`
  (content-stable sha256 ordering, stratified by the declared ``patient_label_rule``, at least one
  patient of each class per split whenever feasible, ``class_absent`` reported otherwise). Near-
  duplicate pairs a person marked ``duplicate`` are grouping constraints. Partitions: ``random``,
  ``temporal`` (latest case date) and ``external_site`` (any case at a test site). Diagnostics are
  stored in the config on every path (create, refresh, new version, POST splits) and in the manifest.
* **Split families.** Every version of a lineage shares a :class:`~dermpath.models.SplitFamily`.
  Once a version is frozen, children inherit every existing patient's split whatever their labels
  are now; only new patients are allocated. Re-seeding or re-partitioning a child is refused
  (``409 family_split_locked``) unless a new lineage is started with a reason. Test patients sealed
  by a test release (:func:`seal_test_patients`) never move; freeze verifies it.
* **Snapshot and freeze.** ``DatasetItem`` snapshots lineage and slide metadata at materialise time;
  manifests read only the snapshot. :func:`freeze` re-materialises in the same transaction and
  refuses ``409 draft_stale`` (with the diff) if eligibility, labels, lineage, provenance or the
  split allocation changed; it refuses ``409 mixed_data_mode`` for synthetic + real items. A frozen
  version stores an immutable manifest and its SHA-256; the ORM guard and SQLite triggers in
  :mod:`dermpath.models` reject any mutation afterwards.
* **New version on change.** Labels changed after freeze never alter the frozen manifest;
  :func:`staleness` reports them and :func:`new_version` creates a child version.
* **Test-set lock.** :func:`training_eligible_items` NEVER returns test items for the purposes
  ``train``, ``active_learning`` or ``threshold_selection``. Only ``test_evaluation`` reaches the
  test split, and only on a frozen version.
* **Audit** (:func:`audit`, design §9): patient independence (snapshot and live lineage), duplicates,
  label-scope consistency, missing metadata, class balance, confounding (Cramér's V with Fisher/χ²
  on patients), mixed-label patients and acquisition exposure. Embedded in the manifest at freeze.
* **Evaluation cohorts are protected from model-driven acquisition** (owner's brief item 6). A patient
  an active-learning batch proposed (``acquisition_exposure`` rows, written with the proposal; legacy
  ``al_proposal`` rows without one count too), its linked slides and cases, and its confirmed
  duplicate partners are model-selected review material (:func:`acquisition_exposure`). The allocator
  pins them to train; freeze (and freeze-check) refuses ``409 acquisition_exposed_in_evaluation`` when
  val or test holds any, re-checked inside the freeze's write transaction so a proposal committed
  meanwhile is caught. Inherited and sealed splits never move: such conflicts (historical ones
  included) are reported per patient with a resolution, and frozen versions are never rewritten
  (their audit lists them). The manifest separates the representative performance cohort (val/test)
  from the model-selected review cohort (``evaluation_cohorts``) and names the other patients whose split
  the train pin changed (``allocation_effect_of_model_selected``). A patient held in val/test only by a
  sealed or family-held duplicate partner is reported ``held_by: duplicate_group``. Runs and test releases
  read :func:`manifest_acquisition_snapshot`: model-selected held-out rows never set a run's operating point
  or estimate, and a test split holding model-selected material is never released.
"""

from __future__ import annotations

import csv
import hashlib
import io
import json
import platform
from collections import Counter, defaultdict
from datetime import date

from sqlalchemy import select
from sqlalchemy.orm import Session

from . import audit as audit_log
from . import splits as splitlib
from .auth import Actor
from .dataset_audit import UNIT_NOTE, association, contingency, patient_attribute
from .db import utcnow
from .errors import ApiError, conflict, unprocessable
from .hierarchy import slide_lineage
from .labels import (
    check_reference_standard,
    current_expert_opinions,
    current_imported_labels,
    label_source_permitted,
    open_disagreement,
    reference_label,
)
from .models import (
    AcquisitionExposure,
    Block,
    Case,
    CodedPatient,
    DatasetItem,
    DatasetVersion,
    LabelVersion,
    NearDuplicateReview,
    Project,
    QCIssue,
    QCReview,
    Slide,
    SplitAssignment,
    SpecimenPart,
    SplitFamily,
    SplitFamilyAssignment,
    Upload,
    new_id,
)
from .slides.imaging import hamming_hex
from .storage import get_store
from .vocab import (
    DATASET_ELIGIBLE_REVIEW_STATES,
    DATASET_LABEL_SCOPES,
    IMPORTED_REFERENCE_ONLY_REVIEW_STATES,
    ITEM_PURPOSES,
    LABEL_DISPLAY,
    LABEL_VALUES,
    PROVENANCES,
    PURPOSE_SPLITS,
    REAL_PROVENANCES,
    REFERENCE_STANDARD_DISPLAY,
    REFERENCE_STANDARD_LABEL_SOURCES,
    TEST_LOCKED_PURPOSES,
)

PIPELINE_TEST_NOTICE = "PIPELINE TEST — NOT PATHOLOGY VALIDATION (synthetic, procedural images; no histology)"
IMPORTED_REFERENCE_NOTICE = ("IMPORTED REFERENCE LABELS: taken from an external dataset's own reference standard (see "
                             "each label's provenance), not expert reads in this workbench. Results on this dataset "
                             "measure agreement with that reference, not clinical performance.")
NEAR_DUPLICATE_MAX_DISTANCE = 6
MANIFEST_SCHEMA = "dermpath.dataset_manifest/2"
AUDIT_SCHEMA = "dermpath.dataset_audit/1"
# REAL_PROVENANCES (public_cc0, public_licensed, real_authorized) is defined in vocab and re-exported here.
# Snapshot fields compared by freeze (draft_stale) and written to every manifest item.
SNAPSHOT_FIELDS = ("slide_sha256", "label_version_id", "label_value", "label_scope", "label_source", "case_id",
                   "coded_patient_id", "patient_code", "accession_code", "part", "block_id", "block", "level_index",
                   "site_id", "collected_on", "scanner_id", "stain", "mpp_x", "mpp_y", "image_kind", "provenance")
# Warnings a research lead must acknowledge (with a reason) to freeze; mixed_label_patients is informational.
ACKNOWLEDGEABLE_WARNINGS = ("open_qc_issues", "unreviewed_near_duplicates", "unsure_near_duplicates",
                            "duplicates_across_splits", "class_absent", "uncalibrated_items")
_DIFF_CAP = 50
ACQUISITION_SCHEMA = "dermpath.acquisition_exposure/1"
EVALUATION_COHORTS_SCHEMA = "dermpath.evaluation_cohorts/1"
#: Splits that form the representative performance cohort (never model-selected material).
EVALUATION_SPLITS = ("val", "test")
ACQUISITION_BLOCKER = "acquisition_exposed_in_evaluation"

# Re-exported so existing callers keep working.
normalise_split = splitlib.normalise_split


class DatasetNotFrozen(Exception):
    pass


class TestSetLockViolation(AssertionError):
    pass


# --------------------------------------------------------------------------- config


def reference_standard_of(cfg: dict | None) -> str:
    """A dataset config's reference standard. Configs written before the key existed are expert-reference."""
    return (cfg or {}).get("reference_standard") or "expert"


def normalise_config(project: Project, config: dict) -> dict:
    tmpl = project.task_template_json or {}
    scope = config.get("label_scope", "slide")
    if scope not in DATASET_LABEL_SCOPES:
        raise unprocessable("invalid_label_scope", f"label_scope must be one of {list(DATASET_LABEL_SCOPES)}")
    standard = check_reference_standard(config.get("reference_standard"))
    states = list(config.get("eligible_review_states") or ["approved"])
    bad = [s for s in states if s not in DATASET_ELIGIBLE_REVIEW_STATES]
    if bad or not states:
        raise unprocessable("invalid_review_states",
                            f"eligible_review_states must be a non-empty subset of {list(DATASET_ELIGIBLE_REVIEW_STATES)}",
                            invalid=bad)
    unreviewed = sorted(set(states) & set(IMPORTED_REFERENCE_ONLY_REVIEW_STATES))
    if unreviewed and standard != "imported_reference":
        raise unprocessable("review_state_requires_imported_reference",
                            "Slides nobody has reviewed in this workbench ('imported') can enter only a dataset whose "
                            "reference_standard is imported_reference; expert-reference datasets need reviewed slides",
                            invalid=unreviewed)
    values = list(config.get("label_values") or tmpl.get("classes") or ["bcc_present", "bcc_absent_not_benign"])
    if any(v not in LABEL_VALUES for v in values):
        raise unprocessable("invalid_label_values", f"label_values must be from {list(LABEL_VALUES)}")
    # The default stays "all provenances", but the included items must resolve to ONE data mode (freeze enforces).
    prov = list(config.get("include_provenance") or list(PROVENANCES))
    if any(p not in PROVENANCES for p in prov):
        raise unprocessable("invalid_provenance", f"include_provenance must be from {list(PROVENANCES)}")
    cfg = {
        "task_template": tmpl,
        "label_scope": scope,
        "eligible_review_states": sorted(set(states)),
        "label_values": values,
        "include_provenance": sorted(set(prov)),
        # Which labels count as the reference (labels.label_source_permitted); recorded in the manifest config.
        "reference_standard": standard,
        "split": None,
    }
    if config.get("split"):
        cfg["split"] = splitlib.normalise_split(config["split"])
    return cfg


def positive_class(cfg: dict) -> str:
    """The positive class for stratification (same rule as the ML service: bcc_present when present)."""
    values = list(cfg.get("label_values") or [])
    return splitlib.DEFAULT_POSITIVE_CLASS if (not values or splitlib.DEFAULT_POSITIVE_CLASS in values) else values[0]


def _label_rule(cfg: dict) -> str:
    return (cfg.get("split") or {}).get("patient_label_rule") or splitlib.DEFAULT_PATIENT_LABEL_RULE


# --------------------------------------------------------------------------- eligibility


def _reason(code: str, detail: str | None = None) -> dict:
    return {"code": code, "detail": detail} if detail else {"code": code}


def _eligibility(db: Session, slide: Slide, cfg: dict) -> tuple[bool, list[dict], object | None, str | None, dict]:
    """``(eligible, reasons, reference_label_version, reference_status, lineage)`` for one slide."""
    reasons: list[dict] = []
    if slide.provenance not in cfg["include_provenance"]:
        reasons.append(_reason("provenance_not_included", slide.provenance))
    if slide.ingest_status != "succeeded":
        reasons.append(_reason(f"ingest_{slide.ingest_status}", slide.ingest_error))
    if slide.image_kind == "field_image":
        reasons.append(_reason("field_image_not_wsi", "JPEG/PNG field images are not whole-slide images"))
    if slide.review_state not in cfg["eligible_review_states"]:
        reasons.append(_reason(f"review_state_{slide.review_state}", slide.review_state_reason))
    qc_ex = db.scalars(select(QCIssue.id).where(QCIssue.slide_id == slide.id, QCIssue.status == "resolved",
                                                QCIssue.dataset_eligibility_effect == "exclude_slide")
                       .order_by(QCIssue.id)).all()
    for iid in qc_ex:
        reasons.append(_reason("qc_excluded", f"QC issue {iid} resolved with exclude_slide"))
    lineage = slide_lineage(db, slide)
    ref, status = None, None
    if lineage["case_id"] is None:
        reasons.append(_reason("no_hierarchy", "slide is not assigned to a coded patient / case"))
    else:
        scope = cfg["label_scope"]
        standard = reference_standard_of(cfg)
        kind = "expert" if standard == "expert" else "imported reference"
        target = slide.id if scope == "slide" else lineage["case_id"]
        ref, status = reference_label(db, slide.project_id, scope, target, reference_standard=standard)
        if open_disagreement(db, slide.project_id, scope, target):
            reasons.append(_reason("open_disagreement", f"{scope}-level expert labels disagree"))
        elif status == "unlabeled":
            detail = f"no {kind} label at {scope} scope"
            if scope == "slide":
                case_ref, _ = reference_label(db, slide.project_id, "case", lineage["case_id"],
                                              reference_standard=standard)
                if case_ref is not None:
                    detail += " (a case-level label exists but is never copied down to slides)"
            if standard == "expert" and current_imported_labels(db, slide.project_id, scope, target):
                detail += (" (an imported reference label exists; it counts only in a dataset whose "
                           "reference_standard is imported_reference)")
            reasons.append(_reason(f"no_reference_label_{scope}", detail))
        elif status == "disputed":
            reasons.append(_reason("label_disputed", f"{scope}-level {kind} labels disagree"))
        if ref is not None and not label_source_permitted(ref.source, standard):  # defence in depth
            reasons.append(_reason("label_source_not_permitted", f"{ref.source} under {standard}"))
        if ref is not None and ref.value not in cfg["label_values"]:
            reasons.append(_reason("label_value_not_in_task", ref.value))
    return (not reasons), reasons, ref, status, lineage


def slide_eligibility(db: Session, slide: Slide, cfg: dict) -> tuple[bool, list[dict], object | None, dict]:
    """Return ``(eligible, reasons, reference_label_version, lineage)`` for one slide."""
    ok, reasons, ref, _status, lineage = _eligibility(db, slide, cfg)
    return ok, reasons, ref, lineage


# --------------------------------------------------------------------------- snapshot / materialise


def _snapshot(db: Session, dv: DatasetVersion) -> tuple[list[dict], list[dict]]:
    """Fresh eligibility + label + lineage snapshot of the project for this config: ``(items, exclusions)``."""
    cfg = dv.config_json
    items, exclusions = [], []
    for s in db.scalars(select(Slide).where(Slide.project_id == dv.project_id).order_by(Slide.id)).all():
        ok, reasons, ref, status, lin = _eligibility(db, s, cfg)
        if not ok:
            exclusions.append({"slide_id": s.id, "patient_code": lin.get("patient_code"),
                               "accession_code": lin.get("accession_code"), "reasons": reasons})
            continue
        items.append({
            "slide_id": s.id, "slide_sha256": s.sha256, "label_version_id": ref.id, "label_value": ref.value,
            "label_scope": cfg["label_scope"], "label_source": status, "case_id": lin["case_id"],
            "coded_patient_id": lin["coded_patient_id"], "patient_code": lin["patient_code"],
            "accession_code": lin["accession_code"], "part": lin["part"], "block_id": lin["block_id"],
            "block": lin["block"], "level_index": s.level_index, "site_id": lin["site_id"],
            "collected_on": lin["collected_on"], "scanner_id": s.scanner_id, "stain": s.stain, "mpp_x": s.mpp_x,
            "mpp_y": s.mpp_y, "image_kind": s.image_kind, "provenance": s.provenance,
        })
    return items, exclusions


def _item_snapshot(it: DatasetItem) -> dict:
    out = {k: getattr(it, k) for k in SNAPSHOT_FIELDS if k != "collected_on"}
    out["slide_id"] = it.slide_id
    out["collected_on"] = it.collected_on.isoformat() if it.collected_on else None
    return out


def _stored_items(db: Session, dv: DatasetVersion) -> list[DatasetItem]:
    return list(db.scalars(select(DatasetItem).where(DatasetItem.dataset_version_id == dv.id)
                           .order_by(DatasetItem.slide_id)).all())


def item_data_mode(provenance: str | None, image_kind: str | None) -> str:
    """``synthetic`` (demo_synthetic procedural tiles), ``real`` (public_cc0 / public_licensed / real_authorized) or
    ``inconsistent`` (any other combination, e.g. a synthetic provenance on a scanned file)."""
    if provenance == "demo_synthetic" and image_kind == "synthetic_tiles":
        return "synthetic"
    if provenance in REAL_PROVENANCES and image_kind != "synthetic_tiles":
        return "real"
    return "inconsistent"


def data_mode(rows: list[dict]) -> dict:
    """The dataset's data mode from its included items: ``synthetic``, ``real``, ``mixed`` (refused at freeze)
    or None when there are no items."""
    counts = Counter(item_data_mode(r.get("provenance"), r.get("image_kind")) for r in rows)
    kinds = set(counts)
    mode = None if not kinds else "synthetic" if kinds == {"synthetic"} else "real" if kinds == {"real"} else "mixed"
    return {"mode": mode, "item_counts": dict(sorted(counts.items())),
            "rule": "synthetic = every item demo_synthetic + synthetic_tiles; real = every item public_cc0, "
                    "public_licensed or real_authorized; anything else is mixed and cannot be frozen"}


def materialize(db: Session, dv: DatasetVersion) -> dict:
    if dv.status != "draft":
        raise conflict("dataset_frozen", "Frozen dataset versions never change; create a new version")
    cfg = dv.config_json
    for it in db.scalars(select(DatasetItem).where(DatasetItem.dataset_version_id == dv.id)).all():
        db.delete(it)
    for sa in db.scalars(select(SplitAssignment).where(SplitAssignment.dataset_version_id == dv.id)).all():
        db.delete(sa)
    db.flush()
    items, exclusions = _snapshot(db, dv)
    for r in items:
        fields = {k: r[k] for k in SNAPSHOT_FIELDS if k != "collected_on"}
        db.add(DatasetItem(dataset_version_id=dv.id, slide_id=r["slide_id"],
                           collected_on=date.fromisoformat(r["collected_on"]) if r["collected_on"] else None, **fields))
    dv.exclusions_json = exclusions
    dv.materialized_at = utcnow()
    db.flush()
    split_result = None
    if cfg.get("split"):
        split_result = assign_splits(db, dv, cfg["split"])
    elif "split_diagnostics" in cfg:
        dv.config_json = {k: v for k, v in cfg.items() if k != "split_diagnostics"}
    return {"items": len(items), "excluded": len(exclusions), "split": split_result, "data_mode": data_mode(items)}


# --------------------------------------------------------------------------- patients


def _patient_infos(db: Session, dv: DatasetVersion) -> list[dict]:
    """Patient infos for :func:`dermpath.splits.allocate`, deterministic (ORDER BY everywhere).

    Labels come from the included bags (slide scope: one per slide; case scope: one per case). Dates and sites
    come from ALL of the patient's cases in the project (a later or other-site case that is not included still
    defines the patient), and an included case without a date is reported for temporal partitions.
    """
    cfg = dv.config_json
    rule, pos = _label_rule(cfg), positive_class(cfg)
    items = db.scalars(select(DatasetItem).where(DatasetItem.dataset_version_id == dv.id)
                       .order_by(DatasetItem.coded_patient_id, DatasetItem.slide_id)).all()
    by_patient: dict[str, dict] = {}
    for it in items:
        p = by_patient.setdefault(it.coded_patient_id, {"id": it.coded_patient_id, "code": it.patient_code,
                                                        "bags": {}, "slide_labels": [], "included_cases": set()})
        p["bags"].setdefault(it.slide_id if it.label_scope == "slide" else it.case_id, it.label_value)
        p["slide_labels"].append(it.label_value)
        p["included_cases"].add(it.case_id)
    if not by_patient:
        return []
    codes = dict(db.execute(select(CodedPatient.id, CodedPatient.code)
                            .where(CodedPatient.id.in_(list(by_patient)))).all())
    cases_by_patient: dict[str, list[Case]] = defaultdict(list)
    for c in db.scalars(select(Case).where(Case.project_id == dv.project_id,
                                           Case.coded_patient_id.in_(list(by_patient))).order_by(Case.id)).all():
        cases_by_patient[c.coded_patient_id].append(c)
    out = []
    for pid in sorted(by_patient):
        p = by_patient[pid]
        cases = cases_by_patient.get(pid, [])
        bags = [p["bags"][k] for k in sorted(p["bags"])]
        out.append({
            "id": pid, "code": p["code"] or codes.get(pid) or pid, "labels": bags,
            "label": splitlib.patient_label(bags, rule, positive_class=pos), "slide_labels": p["slide_labels"],
            "slides": len(p["slide_labels"]), "dates": sorted({c.collected_on for c in cases if c.collected_on}),
            "sites": {c.site_id for c in cases if c.site_id},
            "missing_date_cases": sorted(c.id for c in cases if c.id in p["included_cases"] and not c.collected_on),
        })
    return out


def _row_patients(rows: list[dict]) -> tuple[list[dict], dict[str, str] | None]:
    """Patients (as :func:`dermpath.splits.class_report` expects) and their split from item rows; the mapping is
    None when any row has no split."""
    by: dict[str, dict] = {}
    for r in sorted(rows, key=lambda r: (r["coded_patient_id"], r["slide_id"])):
        p = by.setdefault(r["coded_patient_id"], {"id": r["coded_patient_id"],
                                                  "code": r.get("patient_code") or r["coded_patient_id"],
                                                  "bags": {}, "slide_labels": [], "split": r.get("split")})
        p["bags"].setdefault(r["slide_id"] if r["label_scope"] == "slide" else r["case_id"], r["label_value"])
        p["slide_labels"].append(r["label_value"])
    patients = [{"id": p["id"], "code": p["code"], "labels": [p["bags"][k] for k in sorted(p["bags"])],
                 "slide_labels": p["slide_labels"]} for p in by.values()]
    mapping = None if any(r.get("split") is None for r in rows) else {p["id"]: p["split"] for p in by.values()}
    return patients, mapping


def _class_report(rows: list[dict], cfg: dict) -> dict | None:
    patients, mapping = _row_patients(rows)
    if not patients or mapping is None:
        return None
    return splitlib.class_report(patients, mapping, cfg.get("split"), classes=cfg.get("label_values"),
                                 positive_class=positive_class(cfg))


# --------------------------------------------------------------------------- splits


def compute_splits(patients: list[dict], split: dict) -> tuple[dict[str, str], dict]:
    """Pure: patient infos + split config → ``{patient_id: split}`` and diagnostics.

    .. deprecated:: kept for existing callers; use :func:`dermpath.splits.allocate` (salt, family, grouping).
       Behaviour changed by design (§2): the ``random`` partition is now stratified with content-stable ordering.
    """
    return splitlib.allocate(patients, split)


def assert_patient_grouping(items: list[dict]) -> None:
    """Every coded patient appears in exactly one split (items carry coded_patient_id and split)."""
    seen: dict[str, str] = {}
    for it in items:
        pid, sp = it["coded_patient_id"], it.get("split")
        if sp is None:
            raise AssertionError(f"item for patient {pid} has no split")
        if seen.setdefault(pid, sp) != sp:
            raise AssertionError(f"patient {pid} appears in splits {seen[pid]} and {sp}")


def _check_grouping(items: list[dict]) -> None:
    try:
        assert_patient_grouping(items)
    except AssertionError as exc:
        raise conflict("patient_grouping_violation", str(exc)) from exc


def project_salt(project_id: str) -> str:
    """Family salt for new lineages: derived from the project, so the same cohort, config and seed reproduce."""
    return hashlib.sha256(f"dermpath.split_family|{project_id}".encode()).hexdigest()[:32]


def lineage_family(db: Session, lineage_id: str) -> SplitFamily | None:
    return db.scalars(select(SplitFamily).where(SplitFamily.lineage_id == lineage_id)).first()


def family_locked(db: Session, lineage_id: str) -> bool:
    """A lineage's split family is locked once any of its versions is frozen."""
    return db.scalars(select(DatasetVersion.id).where(DatasetVersion.lineage_id == lineage_id,
                                                      DatasetVersion.status == "frozen")).first() is not None


def family_assignments(db: Session, family: SplitFamily | None) -> dict[str, SplitFamilyAssignment]:
    if family is None:
        return {}
    return {a.coded_patient_id: a for a in db.scalars(
        select(SplitFamilyAssignment).where(SplitFamilyAssignment.family_id == family.id)
        .order_by(SplitFamilyAssignment.coded_patient_id)).all()}


def _lineages_in_scope(db: Session, dv: DatasetVersion) -> list[str]:
    """This version's lineage plus the lineages of its ancestors (a new lineage started from a parent)."""
    out, seen, cur = [dv.lineage_id], {dv.id}, dv.parent_version_id
    while cur and cur not in seen:
        seen.add(cur)
        parent = db.get(DatasetVersion, cur)
        if parent is None:
            break
        if parent.lineage_id not in out:
            out.append(parent.lineage_id)
        cur = parent.parent_version_id
    return out


def sealed_constraints(db: Session, dv: DatasetVersion) -> dict[str, dict]:
    """``{coded_patient_id: {split, family_id, lineage_id, sealed_at, sealed_reason}}`` sealed by a test release in
    ANY split family of the project. Sealing is patient-level per project: a fresh root lineage, a new lineage or a
    child of another lineage of the same cohort sees every seal, so a sealed test patient can never reach train or
    val by re-splitting elsewhere. This version's own lineage and its ancestors come first (their family is named
    when a patient was sealed in several)."""
    out: dict[str, dict] = {}
    scope = _lineages_in_scope(db, dv)
    rank = {lineage_id: i for i, lineage_id in enumerate(scope)}
    fams = db.scalars(select(SplitFamily).where(SplitFamily.project_id == dv.project_id)).all()
    for fam in sorted(fams, key=lambda f: (rank.get(f.lineage_id, len(rank)), f.created_at, f.id)):
        for a in family_assignments(db, fam).values():
            if a.sealed_at is not None and a.coded_patient_id not in out:
                out[a.coded_patient_id] = {"split": a.split, "family_id": a.family_id, "lineage_id": fam.lineage_id,
                                           "patient_code": a.patient_code, "sealed_at": a.sealed_at.isoformat(),
                                           "sealed_reason": a.sealed_reason}
    return out


def project_sealed_patients(db: Session, project_id: str) -> set[str]:
    """Coded patient ids sealed by a test release in any split family of the project."""
    return set(db.scalars(select(SplitFamilyAssignment.coded_patient_id)
                          .join(SplitFamily, SplitFamily.id == SplitFamilyAssignment.family_id)
                          .where(SplitFamily.project_id == project_id,
                                 SplitFamilyAssignment.sealed_at.is_not(None))).all())


def sealed_slides(db: Session, project_id: str) -> dict[str, dict]:
    """``{slide_id: {slide_sha256, coded_patient_id, family_id, lineage_id, dataset_version_id}}``: every slide that
    was a TEST item of a sealed patient in a frozen version of that patient's split family (the slides a test release
    looked at). A slide later moved to another patient keeps this record, so freeze can refuse it outside test."""
    rows = db.execute(
        select(DatasetItem.slide_id, DatasetItem.slide_sha256, DatasetItem.coded_patient_id, SplitFamily.id,
               SplitFamily.lineage_id, DatasetVersion.id)
        .join(DatasetVersion, DatasetVersion.id == DatasetItem.dataset_version_id)
        .join(SplitAssignment, (SplitAssignment.dataset_version_id == DatasetItem.dataset_version_id)
              & (SplitAssignment.coded_patient_id == DatasetItem.coded_patient_id))
        .join(SplitFamily, SplitFamily.lineage_id == DatasetVersion.lineage_id)
        .join(SplitFamilyAssignment, (SplitFamilyAssignment.family_id == SplitFamily.id)
              & (SplitFamilyAssignment.coded_patient_id == DatasetItem.coded_patient_id))
        .where(DatasetVersion.project_id == project_id, DatasetVersion.status == "frozen",
               SplitAssignment.split == "test", SplitFamilyAssignment.sealed_at.is_not(None))
        .order_by(DatasetVersion.frozen_at, DatasetItem.slide_id)).all()
    out: dict[str, dict] = {}
    for slide_id, sha, pid, fam_id, lineage_id, dv_id in rows:
        out.setdefault(slide_id, {"slide_sha256": sha, "coded_patient_id": pid, "family_id": fam_id,
                                  "lineage_id": lineage_id, "dataset_version_id": dv_id})
    return out


def _decisions(db: Session, project_id: str) -> dict[tuple[str, str], NearDuplicateReview]:
    """The latest human near-duplicate decision per (sorted) slide pair."""
    out: dict[tuple[str, str], NearDuplicateReview] = {}
    for nd in db.scalars(select(NearDuplicateReview).where(NearDuplicateReview.project_id == project_id)
                         .order_by(NearDuplicateReview.created_at, NearDuplicateReview.id)).all():
        out[tuple(sorted((nd.slide_a_id, nd.slide_b_id)))] = nd
    return out


def _duplicate_groups(db: Session, dv: DatasetVersion) -> list[tuple[str, str]]:
    """Included patient pairs joined, directly or transitively, by the project's ``duplicate`` decisions: the
    closure runs over every decided slide, including slides the dataset does not include (``A~X``, ``X~B`` join A
    and B), and every pair inside a group is returned (:func:`dermpath.splits.duplicate_closure_pairs`)."""
    owner = dict(db.execute(select(DatasetItem.slide_id, DatasetItem.coded_patient_id)
                            .where(DatasetItem.dataset_version_id == dv.id)).all())
    decided = [(a, b) for (a, b), nd in sorted(_decisions(db, dv.project_id).items()) if nd.decision == "duplicate"]
    return splitlib.duplicate_closure_pairs(decided, owner)


def known_sites(db: Session, project_id: str) -> list[str]:
    return sorted(s for s in db.scalars(select(Case.site_id).where(Case.project_id == project_id).distinct()) if s)


# --------------------------------------------------------------------------- acquisition exposure (brief item 6)
#
# Active learning chooses which patients experts look at from MODEL scores (plus a random share). Their material is
# a model-selected review cohort: it may train later models but must never become validation or test material,
# where it would make evaluation depend on the model being evaluated (or a predecessor). The record is the
# append-only ``acquisition_exposure`` table, written in the proposal's transaction; everything below derives the
# EFFECTIVE exposure from it, from legacy proposals and from the current hierarchy and duplicate decisions.


def _patient_material(db: Session, project_id: str, patient_id: str) -> tuple[list[str], list[str]]:
    """Sorted ``(slide ids, case ids)`` of a coded patient in the project (live hierarchy)."""
    cases = sorted(db.scalars(select(Case.id).where(Case.project_id == project_id,
                                                    Case.coded_patient_id == patient_id)).all())
    if not cases:
        return [], []
    slides = sorted(db.scalars(select(Slide.id).join(Block, Block.id == Slide.block_id)
                               .join(SpecimenPart, SpecimenPart.id == Block.part_id)
                               .where(Slide.project_id == project_id, SpecimenPart.case_id.in_(cases))).all())
    return slides, cases


def _slide_owners(db: Session, slide_ids) -> dict[str, tuple[str | None, str | None]]:
    """``{slide_id: (coded_patient_id, patient_code)}`` from the live hierarchy (None for an unassigned slide)."""
    out: dict[str, tuple[str | None, str | None]] = {}
    for sid in sorted(set(slide_ids)):
        slide = db.get(Slide, sid)
        lin = slide_lineage(db, slide) if slide is not None else {}
        out[sid] = (lin.get("coded_patient_id"), lin.get("patient_code"))
    return out


def duplicate_links(db: Session, project_id: str) -> list[dict]:
    """Patient pairs joined by the latest ``duplicate`` decision on two slides that now belong to different
    patients: ``[{patient_a, patient_b, slide_a, slide_b, decision_id}]`` (live hierarchy, whole project)."""
    decided = [(a, b, nd) for (a, b), nd in sorted(_decisions(db, project_id).items()) if nd.decision == "duplicate"]
    owners = _slide_owners(db, [x for a, b, _ in decided for x in (a, b)])
    links = []
    for a, b, nd in decided:
        pa, pb = owners[a][0], owners[b][0]
        if pa and pb and pa != pb:
            links.append({"patient_a": pa, "patient_b": pb, "slide_a": a, "slide_b": b, "decision_id": nd.id})
    return links


def duplicate_patient_groups(db: Session, project_id: str, links: list[dict] | None = None) -> dict[str, set[str]]:
    """``{coded_patient_id: every patient of its confirmed-duplicate group (itself included)}`` for the patients in
    at least one ``duplicate`` link (union-find, so groups are transitive)."""
    links = duplicate_links(db, project_id) if links is None else links
    groups: dict[str, set[str]] = {}
    for cluster in _union_clusters([(lk["patient_a"], lk["patient_b"]) for lk in links]):
        members = set(cluster)
        for pid in cluster:
            groups[pid] = members
    return groups


def record_acquisition_exposure(db: Session, *, project_id: str, proposal_id: str, batch_id: str, slide_id: str,
                                run_id: str | None, bundle_id: str | None, dataset_version_id: str | None,
                                created_by: str, kind: str = "model_selected") -> list[AcquisitionExposure]:
    """Persist the patient-level exposure of one committed proposal, in the caller's transaction (the proposal's):
    the patient that owns ``slide_id`` now (relation ``selected``, with every slide and case of the patient) and
    every patient of its confirmed-duplicate group (relation ``duplicate_partner``, with the decisions that join
    them). Rows are append-only (:class:`~dermpath.models.AcquisitionExposure`)."""
    slide = db.get(Slide, slide_id)
    lin = slide_lineage(db, slide) if slide is not None else {}
    pid = lin.get("coded_patient_id")
    if pid is None:
        raise ValueError(f"slide {slide_id} has no coded patient; an exposure needs one")
    links = duplicate_links(db, project_id)
    group = duplicate_patient_groups(db, project_id, links).get(pid, {pid})
    members = [(pid, "selected")] + [(m, "duplicate_partner") for m in sorted(group - {pid})]
    codes = dict(db.execute(select(CodedPatient.id, CodedPatient.code)
                            .where(CodedPatient.id.in_([m for m, _ in members]))).all())
    rows = []
    for member, relation in members:
        slides, cases = _patient_material(db, project_id, member)
        if relation == "selected" and slide_id not in slides:
            slides = sorted(set(slides) | {slide_id})
        via = [{"slide_a": lk["slide_a"], "slide_b": lk["slide_b"], "decision_id": lk["decision_id"]}
               for lk in links if member in (lk["patient_a"], lk["patient_b"])
               and lk["patient_a"] in group and lk["patient_b"] in group]
        rows.append(AcquisitionExposure(
            project_id=project_id, coded_patient_id=member, patient_code=codes.get(member), kind=kind,
            relation=relation, selected_patient_id=pid, proposal_id=proposal_id, batch_id=batch_id, run_id=run_id,
            bundle_id=bundle_id, dataset_version_id=dataset_version_id, proposed_slide_id=slide_id,
            slide_ids_json=slides, case_ids_json=cases, duplicate_links_json=via, created_by=created_by))
    db.add_all(rows)
    db.flush()
    return rows


def acquisition_exposure(db: Session, project_id: str) -> dict:
    """The project's EFFECTIVE model-selected exposure (read-only; conservative: material only ever joins it).

    A patient is exposed when any of these holds (each is listed in its ``sources``):

    * ``selected``: an ``acquisition_exposure`` row (a committed active-learning proposal of one of its slides);
    * ``duplicate_partner_recorded``: a partner recorded with such a proposal (a ``duplicate`` decision then);
    * ``legacy_al_proposal``: an ``al_proposal`` row committed before exposures were recorded (historical);
    * ``exposed_slide_now_belongs_to_patient`` / ``exposed_case_now_belongs_to_patient``: a lineage correction
      moved exposed material to this patient;
    * ``duplicate_partner_now``: a CURRENT ``duplicate`` decision joins the patient to an exposed patient.

    Returns ``{schema, patients: {coded_patient_id: {coded_patient_id, patient_code, kinds, sources, proposal_ids,
    first_exposed_at}}, slides: {slide_id: {coded_patient_id, proposal_id}}, cases, recorded_rows,
    legacy_proposals}``."""
    patients: dict[str, dict] = {}
    slides: dict[str, dict] = {}
    cases: set[str] = set()

    def mark(pid: str | None, code: str | None, source: str, *, proposal_id: str | None = None, at=None) -> None:
        if not pid:
            return
        e = patients.setdefault(pid, {"coded_patient_id": pid, "patient_code": code, "kinds": set(),
                                      "sources": set(), "proposal_ids": set(), "first_exposed_at": None})
        e["patient_code"] = e["patient_code"] or code
        e["kinds"].add("model_selected")
        e["sources"].add(source)
        if proposal_id:
            e["proposal_ids"].add(proposal_id)
        if at is not None and (e["first_exposed_at"] is None or at < e["first_exposed_at"]):
            e["first_exposed_at"] = at

    recorded = db.scalars(select(AcquisitionExposure).where(AcquisitionExposure.project_id == project_id)
                          .order_by(AcquisitionExposure.created_at, AcquisitionExposure.id)).all()
    for r in recorded:
        mark(r.coded_patient_id, r.patient_code,
             "selected" if r.relation == "selected" else "duplicate_partner_recorded",
             proposal_id=r.proposal_id, at=r.created_at)
        for sid in r.slide_ids_json or []:
            slides.setdefault(sid, {"coded_patient_id": r.coded_patient_id, "proposal_id": r.proposal_id})
        cases.update(r.case_ids_json or [])
    legacy = 0
    try:
        from .ml.engine_models import ALProposal
    except ModuleNotFoundError:  # pragma: no cover - ML package not installed: no proposals exist
        ALProposal = None  # noqa: N806
    if ALProposal is not None:
        covered = {r.proposal_id for r in recorded}
        for prop in db.scalars(select(ALProposal).where(ALProposal.project_id == project_id)
                               .order_by(ALProposal.created_at, ALProposal.id)).all():
            if prop.id in covered:
                continue
            legacy += 1
            pid = prop.coded_patient_id or _slide_owners(db, [prop.slide_id])[prop.slide_id][0]
            mark(pid, None, "legacy_al_proposal", proposal_id=prop.id, at=prop.created_at)
            slides.setdefault(prop.slide_id, {"coded_patient_id": pid, "proposal_id": prop.id})
    for sid, (pid, code) in _slide_owners(db, slides).items():
        if pid and pid != slides[sid]["coded_patient_id"]:
            mark(pid, code, "exposed_slide_now_belongs_to_patient", proposal_id=slides[sid]["proposal_id"])
    for case in (db.scalars(select(Case).where(Case.id.in_(sorted(cases)))).all() if cases else []):
        if case.coded_patient_id not in patients:
            mark(case.coded_patient_id, None, "exposed_case_now_belongs_to_patient")
    groups = duplicate_patient_groups(db, project_id)
    for pid in sorted(patients):
        for member in sorted(groups.get(pid, ())):
            if member != pid:
                mark(member, None, "duplicate_partner_now")
    missing = [pid for pid, e in patients.items() if not e["patient_code"]]
    if missing:
        codes = dict(db.execute(select(CodedPatient.id, CodedPatient.code).where(CodedPatient.id.in_(missing))).all())
        for pid in missing:
            patients[pid]["patient_code"] = codes.get(pid)
    out = {}
    for pid in sorted(patients):
        e = patients[pid]
        out[pid] = {**e, "kinds": sorted(e["kinds"]), "sources": sorted(e["sources"]),
                    "proposal_ids": sorted(e["proposal_ids"]),
                    "first_exposed_at": e["first_exposed_at"].isoformat() if e["first_exposed_at"] else None}
    return {"schema": ACQUISITION_SCHEMA, "patients": out, "slides": slides, "cases": sorted(cases),
            "recorded_rows": len(recorded), "legacy_proposals": legacy}


def evaluation_patients(db: Session, project_id: str) -> dict[str, dict]:
    """The reserved evaluation cohort of the project: every patient holding ``val`` or ``test`` in ANY split family
    (frozen versions write family assignments), sealed patients included. ``{coded_patient_id: {split, family_id,
    lineage_id, patient_code, sealed}}``; a patient in several families reports test (and sealed) first."""
    rows = db.execute(
        select(SplitFamilyAssignment, SplitFamily.lineage_id)
        .join(SplitFamily, SplitFamily.id == SplitFamilyAssignment.family_id)
        .where(SplitFamily.project_id == project_id,
               (SplitFamilyAssignment.split.in_(EVALUATION_SPLITS)) | (SplitFamilyAssignment.sealed_at.is_not(None)))
        .order_by(SplitFamilyAssignment.coded_patient_id, SplitFamilyAssignment.family_id)).all()
    out: dict[str, dict] = {}
    for a, lineage_id in rows:
        rec = {"split": a.split, "family_id": a.family_id, "lineage_id": lineage_id, "patient_code": a.patient_code,
               "sealed": a.sealed_at is not None}
        cur = out.get(a.coded_patient_id)
        if cur is None or (rec["sealed"], rec["split"] == "test") > (cur["sealed"], cur["split"] == "test"):
            out[a.coded_patient_id] = rec
    return out


def evaluation_reservation(db: Session, dv: DatasetVersion, patient_id: str) -> dict:
    """Whether the version's partition reserves a patient NEW to its split family for evaluation by a LABEL-FREE
    rule, decided before anyone labels or selects them: ``temporal`` (latest case date on or after the validation
    cutoff, or the test cutoff when there is no validation split; a patient without any dated case is reserved,
    because the rule cannot place them) and ``external_site`` (any case at a test site). Proposing such a patient
    would force evaluation-period or external-site material into training. ``random`` partitions stratify by label,
    so no label-free reservation exists; their protection is the exposure pin. Returns ``{reserved_for_evaluation,
    rule, split_by_rule, reason}``."""
    split = (dv.config_json or {}).get("split") or {}
    partition = split.get("partition")
    if partition not in ("temporal", "external_site"):
        return {"reserved_for_evaluation": False, "rule": partition, "split_by_rule": None,
                "reason": "random partitions stratify by label: no label-free reservation before labelling"}
    cases = db.scalars(select(Case).where(Case.project_id == dv.project_id,
                                          Case.coded_patient_id == patient_id).order_by(Case.id)).all()
    if partition == "temporal":
        dates = [c.collected_on for c in cases if c.collected_on]
        if not dates:
            return {"reserved_for_evaluation": True, "rule": "temporal", "split_by_rule": None,
                    "reason": "no dated case: the temporal rule cannot place the patient"}
        latest = max(dates)
        test_cut = date.fromisoformat(split["test_cutoff"])
        val_cut = date.fromisoformat(split["val_cutoff"]) if split.get("val_cutoff") else None
        by_rule = "test" if latest >= test_cut else "val" if (val_cut and latest >= val_cut) else "train"
        return {"reserved_for_evaluation": by_rule != "train", "rule": "temporal", "split_by_rule": by_rule,
                "reason": f"latest case date {latest.isoformat()}"}
    test_sites = set(split.get("test_sites") or [])
    at_test_site = sorted({c.site_id for c in cases if c.site_id in test_sites})
    return {"reserved_for_evaluation": bool(at_test_site), "rule": "external_site",
            "split_by_rule": "test" if at_test_site else None,
            "reason": f"cases at test sites {at_test_site}" if at_test_site else "no case at a test site"}


_HELD_BY_RESOLUTION = {
    "draft_allocation": "Refresh the draft (POST /datasets/{id}/refresh): the allocator pins model-selected patients "
                        "to train.",
    "split_family": "This lineage's split family holds the patient in this split and inherited splits never move. "
                    "Start a new lineage (POST /datasets/{id}/new-version with new_lineage=true and a reason; the "
                    "patient is allocated to train there) or exclude the patient's slides from the dataset.",
    "sealed": "The patient is sealed in test by a test release (it can never move to train) and model-selected "
              "material can never be clean test material: exclude the patient's slides from new versions (review "
              "state 'excluded' with a reason).",
    "duplicate_group": "The patient shares a confirmed-duplicate group with a patient whose split is inherited or "
                       "sealed (held_with), and the allocator keeps a group together, so re-allocating this draft "
                       "cannot move it. Exclude this patient's slides from the dataset (review state 'excluded' "
                       "with a reason), or exclude the partner's slides so this patient can be allocated to train; "
                       "when no partner is sealed (only this lineage's split family holds it), a new lineage "
                       "(POST /datasets/{id}/new-version with new_lineage=true) also resolves it.",
}


def _grouping_holds(db: Session, dv: DatasetVersion, assigned: dict[str, str], sealed: dict, fam: dict
                    ) -> dict[str, list[dict]]:
    """Patients whose split is held by a PARTNER of their confirmed-duplicate group (the allocator's grouping
    units, :func:`_duplicate_groups`): ``{coded_patient_id: [{coded_patient_id, patient_code, held_by, split}]}``
    for each partner in the same split that is sealed or holds that split in the lineage's split family. The
    allocator gives such a unit the partner's inherited or sealed split before it pins model-selected units to
    train, so a refresh never moves its other members."""
    parent: dict[str, str] = {}

    def find(x: str) -> str:
        parent.setdefault(x, x)
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    for a, b in _duplicate_groups(db, dv):
        if a in assigned and b in assigned:
            parent[find(a)] = find(b)
    members: dict[str, list[str]] = {}
    for pid in list(parent):
        members.setdefault(find(pid), []).append(pid)
    out: dict[str, list[dict]] = {}
    for group in members.values():
        for pid in group:
            holders = []
            for other in sorted(group):
                if other == pid or assigned.get(other) != assigned.get(pid):
                    continue
                how = ("sealed" if other in sealed else
                       "split_family" if other in fam and fam[other].split == assigned.get(other) else None)
                if how:
                    holders.append({"coded_patient_id": other, "held_by": how, "split": assigned.get(other),
                                    "patient_code": (sealed.get(other) or {}).get("patient_code")
                                    or getattr(fam.get(other), "patient_code", None)})
            if holders:
                out[pid] = holders
    return out


def _exposure_conflicts(db: Session, dv: DatasetVersion, assigned: dict[str, str], items: list[dict],
                        exposure: dict, family: dict | None = None) -> tuple[list[dict], list[dict]]:
    """Exposed material in val/test of a version: ``(patients, slides)``. ``assigned``: ``{coded_patient_id:
    split}``; ``items``: rows with ``slide_id``, ``coded_patient_id``, ``patient_code``. Each patient says what holds
    it there (``held_by``: draft_allocation, split_family or sealed), whether it is a ``historical_conflict`` (the
    split was already part of an evaluation cohort, or the exposure is a legacy proposal from before exposures were
    recorded) and its ``resolution``. ``held_by: duplicate_group`` means a partner of its confirmed-duplicate group
    is sealed or family-held in that split (``held_with`` names them): the allocator keeps the group together, so a
    refresh cannot move it, and the conflict is historical because the partner's hold is. Slides: exposed slides in
    val/test whose patient is not listed. ``family``: the split-family assignments to judge ``held_by`` against
    (default: the lineage's current ones; a freeze in progress passes those from before its own new assignments)."""
    sealed = sealed_constraints(db, dv)
    fam = family_assignments(db, lineage_family(db, dv.lineage_id)) if family is None else family
    exposed = exposure["patients"]
    patients = []
    grouping = None
    for pid, split in sorted(assigned.items()):
        e = exposed.get(pid)
        if split not in EVALUATION_SPLITS or e is None:
            continue
        held_by = ("sealed" if pid in sealed else
                   "split_family" if pid in fam and fam[pid].split == split else "draft_allocation")
        held_with = None
        if held_by == "draft_allocation":
            grouping = _grouping_holds(db, dv, assigned, sealed, fam) if grouping is None else grouping
            if pid in grouping:
                held_by, held_with = "duplicate_group", grouping[pid]
        entry = {"patient_code": e["patient_code"], "coded_patient_id": pid, "split": split,
                 "sources": e["sources"], "proposal_ids": e["proposal_ids"][:_DIFF_CAP],
                 "first_exposed_at": e["first_exposed_at"], "held_by": held_by,
                 "historical_conflict": held_by != "draft_allocation" or "legacy_al_proposal" in e["sources"],
                 "resolution": _HELD_BY_RESOLUTION[held_by]}
        if held_with is not None:
            entry["held_with"] = held_with
        patients.append(entry)
    listed = {p["coded_patient_id"] for p in patients}
    slides = []
    for it in sorted(items, key=lambda r: r["slide_id"]):
        rec = exposure["slides"].get(it["slide_id"])
        split = assigned.get(it["coded_patient_id"])
        if rec is not None and split in EVALUATION_SPLITS and it["coded_patient_id"] not in listed:
            slides.append({"slide_id": it["slide_id"], "split": split, "patient_code": it.get("patient_code"),
                           "proposal_id": rec["proposal_id"], "exposed_with_patient": rec["coded_patient_id"]})
    return patients, slides


def acquisition_report(db: Session, dv: DatasetVersion, rows: list[dict] | None = None,
                       exposure: dict | None = None) -> dict:
    """Acquisition exposure of one dataset version (audit, freeze-check, manifest): how many exposed patients it
    holds per split, and any exposed material in val/test (``in_evaluation``), with the historical conflicts named.
    Descriptive: a frozen version is never rewritten; its stored evaluations stand, and a conflict listed here means
    its val/test metrics include model-selected material."""
    rows = item_rows(db, dv) if rows is None else rows
    exposure = acquisition_exposure(db, dv.project_id) if exposure is None else exposure
    assigned = {r["coded_patient_id"]: r.get("split") for r in rows}
    per_split = Counter(sp for pid, sp in assigned.items() if pid in exposure["patients"])
    patients, slides = _exposure_conflicts(db, dv, {k: v for k, v in assigned.items() if v}, rows, exposure)
    frozen = dv.status == "frozen"
    historical = [p for p in patients if frozen or p["historical_conflict"]]
    return {
        "schema": ACQUISITION_SCHEMA,
        "exposed_patients": sum(per_split.values()),
        "exposed_patients_per_split": {sp: per_split.get(sp, 0) for sp in splitlib.SPLITS},
        "in_evaluation": patients,
        "slides_in_evaluation": slides,
        "historical_conflicts": historical,
        "ok": not patients and not slides,
        "frozen_version_rewritten": False if frozen else None,
        "project_legacy_proposals": exposure["legacy_proposals"],
        "note": ("Patients chosen by active learning (with their slides, cases and confirmed duplicates) are "
                 "model-selected review material: development only, never validation or test. A frozen version "
                 "is never rewritten; a conflict listed for it means its stored val/test metrics include "
                 "model-selected material."),
    }


def manifest_acquisition_snapshot(db: Session, project_id: str, manifest: dict, exposure: dict | None = None) -> dict:
    """Model-selected (active-learning-exposed, :func:`acquisition_exposure`) patients among a FROZEN manifest's
    patients now, by manifest split. Experiments record it at creation and again in the worker (model-selected
    held-out material is reported apart from the representative performance estimate), and test releases refuse a
    test split holding any. ``{schema, computed_at, count, per_split, patient_ids, patients: [{coded_patient_id,
    patient_code, split, sources, historical}]}``; ``historical`` is a legacy proposal or a val/test patient (the
    version was frozen before the exposure)."""
    exposure = acquisition_exposure(db, project_id) if exposure is None else exposure
    split_of = {s["coded_patient_id"]: s["split"] for s in (manifest or {}).get("splits", [])}
    code_of = {s["coded_patient_id"]: s.get("patient_code") for s in (manifest or {}).get("splits", [])}
    for it in (manifest or {}).get("items", []):
        split_of.setdefault(it.get("coded_patient_id"), it.get("split"))
        code_of.setdefault(it.get("coded_patient_id"), it.get("patient_code"))
    patients = []
    for pid in sorted(p for p in split_of if p in exposure["patients"]):
        e = exposure["patients"][pid]
        patients.append({"coded_patient_id": pid, "patient_code": e.get("patient_code") or code_of.get(pid),
                         "split": split_of[pid], "sources": e["sources"],
                         "historical": "legacy_al_proposal" in e["sources"] or split_of[pid] in EVALUATION_SPLITS})
    per_split = Counter(p["split"] for p in patients)
    return {"schema": ACQUISITION_SCHEMA, "computed_at": utcnow().isoformat(), "count": len(patients),
            "per_split": {sp: per_split.get(sp, 0) for sp in splitlib.SPLITS},
            "patient_ids": [p["coded_patient_id"] for p in patients], "patients": patients[:_DIFF_CAP * 4]}


def evaluation_cohorts(rows: list[dict], splits: list[dict], exposure: dict, diag: dict | None = None) -> dict:
    """Manifest block separating the REPRESENTATIVE PERFORMANCE COHORT (val + test: allocated by the content-stable
    split rule, never model-selected) from the MODEL-SELECTED REVIEW COHORT (patients active learning chose, with
    their confirmed duplicates: development only). ``diag``: the version's split diagnostics; their
    ``development_only.effect_on_other_patients`` (which non-selected patients the train pin moved into val/test
    or displaced to train) is repeated here, because the performance cohort's COMPOSITION is not independent of
    active-learning selection when model-selected patients were pinned."""
    split_of = {s["coded_patient_id"]: s["split"] for s in splits}
    code_of = {s["coded_patient_id"]: s["patient_code"] for s in splits}
    exposed = {pid for pid in split_of if pid in exposure["patients"]}
    perf = {pid for pid, sp in split_of.items() if sp in EVALUATION_SPLITS}
    return {
        "schema": EVALUATION_COHORTS_SCHEMA,
        "representative_performance_cohort": {
            "splits": list(EVALUATION_SPLITS),
            "patients": len(perf),
            "patients_per_split": {sp: sum(1 for p in perf if split_of[p] == sp) for sp in EVALUATION_SPLITS},
            "slides": sum(1 for r in rows if r.get("split") in EVALUATION_SPLITS),
            "model_selected_patients": len(perf & exposed),
            "selection": "allocated by the content-stable split rule (dermpath.splits: seeded patient hash, or the "
                         "temporal / external-site rule), never by model scores; model-selected patients are never "
                         "placed here. They are pinned to train first and count toward train's targets, so which "
                         "OTHER patients fill val/test can depend on what active learning selected (see "
                         "allocation_effect_of_model_selected)",
            "allocation_effect_of_model_selected": ((diag or {}).get("development_only") or {}).get(
                "effect_on_other_patients"),
            "use": "performance estimates: validation for model and threshold selection, test only at a recorded "
                   "test release",
        },
        "model_selected_review_cohort": {
            "patients": len(exposed),
            "patient_codes": sorted(code_of[p] for p in exposed)[:_DIFF_CAP * 4],
            "patients_per_split": {sp: sum(1 for p in exposed if split_of[p] == sp) for sp in splitlib.SPLITS},
            "slides": sum(1 for r in rows if r["coded_patient_id"] in exposed),
            "kinds": {"model_selected": len(exposed)},
            "selection": "chosen for expert review by active learning (uncertainty and diversity on model scores, "
                         "plus a random share), with their confirmed duplicate partners",
            "use": "development (training) only; never a performance estimate",
        },
        "limitation": ("Model-selected patients never enter val or test, so the performance cohort is drawn from the "
                       "cohort without them. Active learning favours uncertain cases: when many patients are "
                       "model-selected, the evaluation population can be easier than the full cohort; compare the "
                       "counts above. Under a random partition the pinned patients count toward train's targets, so "
                       "other patients take their val/test places: the composition of the performance cohort "
                       "depends on active-learning selection (allocation_effect_of_model_selected names the moved "
                       "patients). Temporal and external-site partitions reserve their evaluation patients by a "
                       "label-free rule before any proposal; random partitions stratify by label and cannot."),
    }


def _plan_splits(db: Session, dv: DatasetVersion, split: dict) -> tuple[dict, dict[str, str], dict, SplitFamily | None]:
    """Compute (never write) the allocation for this draft: ``(split, mapping, diag, family)``."""
    split = splitlib.normalise_split(split)
    cfg = dv.config_json
    fam = lineage_family(db, dv.lineage_id)
    locked = family_locked(db, dv.lineage_id)
    if locked and fam is not None and splitlib.partition_key(split) != splitlib.partition_key(fam.partition_json):
        raise conflict("family_split_locked",
                       "A version of this lineage is frozen, so its patient splits are locked. To use another "
                       "partition or seed, start a new lineage (POST /datasets/{parent}/new-version with "
                       "new_lineage=true and a reason).",
                       split_family_id=fam.id, family_partition=splitlib.partition_key(fam.partition_json),
                       requested=splitlib.partition_key(split))
    existing = {pid: a.split for pid, a in family_assignments(db, fam).items()} if locked else {}
    sealed = sealed_constraints(db, dv)
    for pid, s in sealed.items():
        existing.setdefault(pid, s["split"])
    patients = _patient_infos(db, dv)
    in_cohort = {p["id"] for p in patients}
    # Model-selected material (active-learning proposals, their slides/cases and confirmed duplicate partners) is
    # development only: the allocator pins it to train; inherited or sealed splits stay and freeze refuses them.
    exposed = sorted(pid for pid in acquisition_exposure(db, dv.project_id)["patients"] if pid in in_cohort)
    sites = known_sites(db, dv.project_id) if split["partition"] == "external_site" else None
    mapping, diag = splitlib.allocate(patients, split, salt=fam.salt if fam else project_salt(dv.project_id),
                                      existing=existing, groups=_duplicate_groups(db, dv),
                                      classes=cfg.get("label_values"), known_sites=sites,
                                      positive_class=positive_class(cfg), development_only=exposed)
    diag["family"] = {**diag.get("family", {}), "split_family_id": fam.id if fam else None, "locked": locked,
                      "sealed_patients_pinned": sum(1 for pid in sealed if pid in in_cohort)}
    return split, mapping, diag, fam


def assign_splits(db: Session, dv: DatasetVersion, split: dict) -> dict:
    """Allocate patient-grouped splits for a DRAFT and store them (and the diagnostics, in the config).

    The lineage's first assignment creates its split family. While no version of the lineage is frozen the
    family's partition may change (a root draft can be re-seeded); afterwards children inherit and a different
    partition or seed is refused (``409 family_split_locked``).
    """
    if dv.status != "draft":
        raise conflict("dataset_frozen", "Frozen dataset versions never change; create a new version")
    split, mapping, diag, fam = _plan_splits(db, dv, split)
    if fam is None:
        fam = SplitFamily(project_id=dv.project_id, lineage_id=dv.lineage_id, salt=project_salt(dv.project_id),
                          partition_json=split, created_by=dv.created_by)
        db.add(fam)
        db.flush()
    elif not family_locked(db, dv.lineage_id) and fam.partition_json != split:
        fam.partition_json = split
    diag["family"]["split_family_id"] = fam.id
    for sa in db.scalars(select(SplitAssignment).where(SplitAssignment.dataset_version_id == dv.id)).all():
        db.delete(sa)
    db.flush()
    for pid, sp in sorted(mapping.items()):
        db.add(SplitAssignment(dataset_version_id=dv.id, coded_patient_id=pid, split=sp, partition=split["partition"]))
    dv.config_json = {**dv.config_json, "split": split, "split_diagnostics": diag}
    db.flush()
    _check_grouping([{"coded_patient_id": it.coded_patient_id, "split": mapping.get(it.coded_patient_id)}
                     for it in _stored_items(db, dv)])
    return diag


def _ensure_family(db: Session, dv: DatasetVersion, actor_id: str) -> SplitFamily:
    fam = lineage_family(db, dv.lineage_id)
    if fam is None:
        partition = dv.config_json.get("split") or {
            "partition": "custom", "note": "split assignments were written directly, not by the allocator"}
        fam = SplitFamily(project_id=dv.project_id, lineage_id=dv.lineage_id, salt=project_salt(dv.project_id),
                          partition_json=partition, created_by=actor_id)
        db.add(fam)
        db.flush()
    return fam


def seal_test_patients(db: Session, dv: DatasetVersion, reason: str, actor: Actor | None = None) -> dict:
    """Seal every test patient of the version's split family (call at a test release on any version of the
    lineage). Sealed patients never change split: child versions inherit them and freeze verifies it, also for
    a new lineage started from this one. Idempotent; returns counts."""
    if dv.status != "frozen":
        raise conflict("not_frozen", "Only frozen dataset versions have sealed test patients")
    if not reason or not reason.strip():
        raise unprocessable("reason_required", "Sealing test patients needs a reason (e.g. the test release)")
    fam = lineage_family(db, dv.lineage_id)
    if fam is None:  # pragma: no cover - freeze always creates the family
        raise conflict("split_family_missing", "This lineage has no split family")
    now = utcnow()
    newly, already = [], []
    for a in family_assignments(db, fam).values():
        if a.split != "test":
            continue
        if a.sealed_at is not None:
            already.append(a.patient_code)
            continue
        a.sealed_at, a.sealed_reason, a.sealed_by = now, reason.strip(), actor.id if actor else None
        newly.append(a.patient_code)
    db.flush()
    out = {"split_family_id": fam.id, "dataset_version_id": dv.id, "sealed": len(newly), "already_sealed": len(already),
           "patient_codes": sorted(newly + already)}
    if actor is not None:
        audit_log.record_for(db, actor, project_id=dv.project_id, action="dataset.test_patients_sealed",
                             entity_type="split_family", entity_id=fam.id,
                             after={"dataset_version_id": dv.id, "sealed": len(newly), "already_sealed": len(already)},
                             reason=reason)
    return out


def item_rows(db: Session, dv: DatasetVersion) -> list[dict]:
    """Items with split and lineage. Frozen: the manifest. Draft: the materialise-time SNAPSHOT (never live
    lineage) plus the stored split assignments."""
    if dv.status == "frozen" and dv.manifest_json:
        return list(dv.manifest_json["items"])
    splits = {sa.coded_patient_id: sa for sa in db.scalars(
        select(SplitAssignment).where(SplitAssignment.dataset_version_id == dv.id)).all()}
    rows = []
    for it in _stored_items(db, dv):
        sa = splits.get(it.coded_patient_id)
        rows.append({**_item_snapshot(it), "split": sa.split if sa else None, "partition": sa.partition if sa else None})
    return rows


# --------------------------------------------------------------------------- create / freeze / version


def create_draft(db: Session, actor: Actor, project: Project, *, name: str, config: dict,
                 parent: DatasetVersion | None = None, reason: str | None = None,
                 new_lineage: bool = False) -> DatasetVersion:
    """A new draft. With ``parent``: the next version of the parent's lineage (``config`` defaults to the parent's;
    the split family is inherited), or with ``new_lineage`` version 1 of a new lineage that records the parent."""
    if parent is None:
        cfg = normalise_config(project, config)
    else:
        cfg = json.loads(json.dumps(config or parent.config_json))
        cfg.pop("split_diagnostics", None)
    if parent is not None and not new_lineage:
        lineage_id = parent.lineage_id
        top = db.scalars(select(DatasetVersion.version).where(DatasetVersion.lineage_id == lineage_id)
                         .order_by(DatasetVersion.version.desc())).first() or 0
        version = top + 1
    else:
        lineage_id, version = new_id(), 1
    dv = DatasetVersion(project_id=project.id, lineage_id=lineage_id, name=name, version=version, status="draft",
                        config_json=cfg, created_by=actor.id, parent_version_id=parent.id if parent else None,
                        reason=reason)
    db.add(dv)
    db.flush()
    result = materialize(db, dv)
    audit_log.record_for(db, actor, project_id=project.id, action="dataset.draft_created",
                         entity_type="dataset_version", entity_id=dv.id,
                         after={"name": name, "version": version, "parent_version_id": dv.parent_version_id,
                                "new_lineage": bool(parent is not None and new_lineage),
                                "items": result["items"], "excluded": result["excluded"],
                                "label_scope": cfg["label_scope"], "data_mode": result["data_mode"]["mode"],
                                "split": _split_audit(result["split"])}, reason=reason)
    return dv


def _split_audit(diag: dict | None) -> dict | None:
    if not diag:
        return None
    return {k: diag.get(k) for k in ("partition", "patients_per_split", "class_absent", "family")}


def canonical_json(obj) -> bytes:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode()


def _sha256_json(obj) -> str:
    return hashlib.sha256(canonical_json(obj)).hexdigest()


def qc_snapshot(db: Session, slide_id: str) -> dict:
    """QC inputs that shape feature extraction, as of now: the latest automated screen with a tissue mask (same
    choice as the feature pipeline), the mask object's sha256, and the resolved exclude_region issues with a
    sha256 over their canonical JSON (sorted by issue id)."""
    review = db.scalars(select(QCReview).where(QCReview.slide_id == slide_id, QCReview.kind == "automated_screen",
                                               QCReview.mask_object_key.is_not(None))
                        .order_by(QCReview.created_at.desc(), QCReview.id.desc())).first()
    mask_sha = None
    if review is not None:
        try:
            mask_sha = get_store().sha256(review.mask_object_key)
        except (FileNotFoundError, OSError):
            mask_sha = None  # recorded as missing; extraction must not use a mask it cannot verify
    regions = [{"issue_id": i.id, "category": i.category, "region": i.region_json}
               for i in db.scalars(select(QCIssue).where(QCIssue.slide_id == slide_id, QCIssue.status == "resolved",
                                                         QCIssue.dataset_eligibility_effect == "exclude_region")
                                   .order_by(QCIssue.id)).all()]
    return {"qc_review_id": review.id if review else None,
            "mask_object_key": review.mask_object_key if review else None, "mask_sha256": mask_sha,
            "excluded_region_issue_ids": [r["issue_id"] for r in regions],
            "excluded_regions_sha256": _sha256_json(regions)}


def _decisions_in_force(db: Session, dv: DatasetVersion, slide_ids: set[str]) -> list[dict]:
    """Decisions naming an included slide, plus every ``duplicate`` decision of a duplicate chain that reaches one
    (``A~X``, ``X~Y``, ``Y~B`` with X and Y not included), so the manifest alone determines the transitive groups."""
    decisions = _decisions(db, dv.project_id)
    dup = [k for k, nd in sorted(decisions.items()) if nd.decision == "duplicate"]
    reach = set(slide_ids)
    changed = True
    while changed:  # slides joined to an included slide by a chain of duplicate decisions
        changed = False
        for a, b in dup:
            if (a in reach) != (b in reach):
                reach |= {a, b}
                changed = True
    out = []
    for (a, b), nd in sorted(decisions.items()):
        if a in slide_ids or b in slide_ids or (nd.decision == "duplicate" and a in reach and b in reach):
            out.append({"slide_a": a, "slide_b": b, "decision": nd.decision, "reason": nd.reason,
                        "reviewer_id": nd.reviewer_id, "decided_at": nd.created_at.isoformat(),
                        "both_in_dataset": a in slide_ids and b in slide_ids})
    return out


def label_provenance(db: Session, dv: DatasetVersion, rows: list[dict] | None = None) -> dict:
    """How the dataset's reference labels were produced: the declared reference standard, the label sources and
    reference statuses of the items, and (imported reference) the distinct provenance texts plus the items where a
    workbench expert currently reads the target differently. Descriptive; nothing is resolved automatically."""
    rows = item_rows(db, dv) if rows is None else rows
    standard = reference_standard_of(dv.config_json)
    lv_ids = sorted({r["label_version_id"] for r in rows if r.get("label_version_id")})
    labels: dict[str, LabelVersion] = {}
    for i in range(0, len(lv_ids), 500):
        for lv in db.scalars(select(LabelVersion).where(LabelVersion.id.in_(lv_ids[i:i + 500]))).all():
            labels[lv.id] = lv
    sources = Counter(labels[r["label_version_id"]].source if r.get("label_version_id") in labels else "missing"
                      for r in rows)
    not_permitted = sorted(r["slide_id"] for r in rows
                           if not label_source_permitted(getattr(labels.get(r.get("label_version_id")), "source",
                                                                 None), standard))
    out = {
        "reference_standard": standard,
        "display": REFERENCE_STANDARD_DISPLAY[standard],
        "accepted_label_sources": list(REFERENCE_STANDARD_LABEL_SOURCES[standard]),
        "label_sources": dict(sorted(sources.items())),
        "reference_statuses": dict(sorted(Counter(r.get("label_source") or "unknown" for r in rows).items())),
        "items_with_label_source_not_permitted": not_permitted,
        "notice": IMPORTED_REFERENCE_NOTICE if standard == "imported_reference" else None,
    }
    if standard == "imported_reference":
        texts = Counter((labels[r["label_version_id"]].reason or "") for r in rows if r["label_version_id"] in labels)
        out["provenance_texts"] = [{"provenance": t, "items": n} for t, n in sorted(texts.items())][:_DIFF_CAP]
        differing = []
        for r in rows:
            target = r["slide_id"] if r["label_scope"] == "slide" else r["case_id"]
            experts = sorted({o.value for o in current_expert_opinions(db, dv.project_id, r["label_scope"],
                                                                       target).values()})
            if experts and experts != [r["label_value"]]:
                differing.append({"slide_id": r["slide_id"], "imported_value": r["label_value"],
                                  "expert_values": experts})
        out["expert_reads_differing_from_imported"] = {"count": len(differing), "items": differing[:_DIFF_CAP],
                                                       "note": "Candidates for human review (possible label noise); "
                                                               "the imported reference is not changed."}
    return out


def public_dataset_record(db: Session, project_id: str, rows: list[dict]) -> dict | None:
    """The licence and source record of a public licensed dataset (``Project.settings_json.public_dataset``, written
    by the importer) when any item has ``public_licensed`` provenance, so the licence terms travel with the frozen
    manifest."""
    if not any(r.get("provenance") == "public_licensed" for r in rows):
        return None
    project = db.get(Project, project_id)
    record = (project.settings_json or {}).get("public_dataset") if project is not None else None
    return record or {"missing": True, "note": "public_licensed items but no licence record on the project"}


def build_manifest(db: Session, dv: DatasetVersion, frozen_at, frozen_by: str, *,
                   family: SplitFamily | None = None, exposure: dict | None = None) -> dict:
    rows = [{**r, **qc_snapshot(db, r["slide_id"])} for r in item_rows(db, dv)]
    exposure = acquisition_exposure(db, dv.project_id) if exposure is None else exposure
    cfg = dv.config_json
    splits = []
    for sa in db.scalars(select(SplitAssignment).where(SplitAssignment.dataset_version_id == dv.id)
                         .order_by(SplitAssignment.coded_patient_id)).all():
        p = db.get(CodedPatient, sa.coded_patient_id)
        splits.append({"coded_patient_id": sa.coded_patient_id, "patient_code": p.code, "split": sa.split,
                       "partition": sa.partition})
    prov = Counter(r["provenance"] for r in rows)
    mode = data_mode(rows)
    synthetic_only = mode["mode"] == "synthetic"
    family = family or lineage_family(db, dv.lineage_id)
    fam_existing = family_assignments(db, family)
    version_patients = {s["coded_patient_id"] for s in splits}
    diag = cfg.get("split_diagnostics")
    if diag is None:
        report = _class_report(rows, cfg)
        diag = {"partition": "custom", **report} if report else None
    return {
        "schema": MANIFEST_SCHEMA,
        "dataset_version_id": dv.id,
        "lineage_id": dv.lineage_id,
        "name": dv.name,
        "version": dv.version,
        "parent_version_id": dv.parent_version_id,
        "project_id": dv.project_id,
        "config": {k: v for k, v in cfg.items() if k != "split_diagnostics"},
        "created_by": dv.created_by,
        "materialized_at": dv.materialized_at.isoformat() if dv.materialized_at else None,
        "frozen_at": frozen_at.isoformat(),
        "frozen_by": frozen_by,
        "counts": {
            "patients": len({r["coded_patient_id"] for r in rows}),
            "cases": len({r["case_id"] for r in rows}),
            "blocks": len({r["block_id"] for r in rows}),
            "slides": len(rows),
        },
        "provenance_mix": dict(sorted(prov.items())),
        "data_mode": mode["mode"],
        "data_mode_item_counts": mode["item_counts"],
        "synthetic_only": synthetic_only,
        "notice": PIPELINE_TEST_NOTICE if synthetic_only else None,
        "label_display": {v: LABEL_DISPLAY[v] for v in cfg["label_values"]},
        "positive_class": positive_class(cfg),
        "patient_label_rule": _label_rule(cfg),
        "reference_standard": reference_standard_of(cfg),
        "label_provenance": label_provenance(db, dv, rows),
        "public_dataset": public_dataset_record(db, dv.project_id, rows),
        "items": rows,
        "splits": splits,
        "split_family_id": family.id if family else None,
        "split_family_salt": family.salt if family else None,
        "split_fingerprint": splitlib.split_fingerprint((s["patient_code"], s["split"]) for s in splits),
        "split_family_counts": {"inherited": len(version_patients & set(fam_existing)),
                                "new": len(version_patients - set(fam_existing)),
                                "dropped": len(set(fam_existing) - version_patients)},
        "split_diagnostics": diag,
        "evaluation_cohorts": evaluation_cohorts(rows, splits, exposure, diag),
        "near_duplicate_decisions": _decisions_in_force(db, dv, {r["slide_id"] for r in rows}),
        "exclusions": dv.exclusions_json,
        "audit": audit(db, dv, exposure=exposure),
        "python_version": platform.python_version(),
        "research_use_only": True,
    }


def _draft_state(db: Session, dv: DatasetVersion) -> tuple[dict | None, list[dict]]:
    """Re-materialise in memory and diff against the stored draft: ``(diff or None, fresh exclusions)``."""
    diff, exclusions, _ = _draft_state_with_plan(db, dv)
    return diff, exclusions


def _draft_state_with_plan(db: Session, dv: DatasetVersion) -> tuple[dict | None, list[dict], dict | None]:
    """:func:`_draft_state` plus the fresh split diagnostics of the re-plan (None when nothing was re-planned)."""
    fresh, exclusions = _snapshot(db, dv)
    stored = {it.slide_id: _item_snapshot(it) for it in _stored_items(db, dv)}
    fresh_by = {r["slide_id"]: r for r in fresh}
    added = sorted(set(fresh_by) - set(stored))
    removed = sorted(set(stored) - set(fresh_by))
    changed = []
    for sid in sorted(set(stored) & set(fresh_by)):
        fields = {k: [stored[sid].get(k), fresh_by[sid].get(k)] for k in SNAPSHOT_FIELDS
                  if stored[sid].get(k) != fresh_by[sid].get(k)}
        if fields:
            changed.append({"slide_id": sid, "fields": fields})
    split_changes = []
    cfg = dv.config_json
    fresh_diag = None
    if not (added or removed or changed) and cfg.get("split"):
        _, mapping, fresh_diag, _ = _plan_splits(db, dv, cfg["split"])
        stored_sa = {sa.coded_patient_id: sa.split for sa in db.scalars(
            select(SplitAssignment).where(SplitAssignment.dataset_version_id == dv.id)).all()}
        codes = {it["coded_patient_id"]: it["patient_code"] for it in stored.values()}
        for pid in sorted(set(mapping) | set(stored_sa)):
            if mapping.get(pid) != stored_sa.get(pid):
                split_changes.append({"patient_code": codes.get(pid, pid), "draft": stored_sa.get(pid),
                                      "now": mapping.get(pid)})
    if not (added or removed or changed or split_changes):
        return None, exclusions, fresh_diag
    return {
        "materialized_at": dv.materialized_at.isoformat() if dv.materialized_at else None,
        "counts": {"items_added": len(added), "items_removed": len(removed), "items_changed": len(changed),
                   "patients_changing_split": len(split_changes)},
        "items_added": added[:_DIFF_CAP], "items_removed": removed[:_DIFF_CAP], "items_changed": changed[:_DIFF_CAP],
        "splits_changed": split_changes[:_DIFF_CAP],
        "action": "Refresh the draft (POST /datasets/{id}/refresh), review it, then freeze.",
    }, exclusions, fresh_diag


def draft_diff(db: Session, dv: DatasetVersion) -> dict | None:
    """What changed since the draft was materialised (eligibility, labels, lineage, provenance, split allocation);
    None when nothing did."""
    return _draft_state(db, dv)[0]


def _near_duplicates(db: Session, rows: list[dict], decisions: dict) -> tuple[list[dict], list[str]]:
    """Near-duplicate CANDIDATES among the rows (thumbnail dHash) with the latest human decision, and the slides
    that could not be screened (no thumbnail hash)."""
    slides = {s.id: s for s in db.scalars(select(Slide).where(Slide.id.in_([r["slide_id"] for r in rows]))).all()}
    by_id = {r["slide_id"]: r for r in rows}
    ids = sorted(slides)
    near = []
    for i in range(len(ids)):
        for j in range(i + 1, len(ids)):
            a, b = slides[ids[i]], slides[ids[j]]
            if not a.thumbnail_phash or not b.thumbnail_phash or a.sha256 == b.sha256:
                continue
            d = hamming_hex(a.thumbnail_phash, b.thumbnail_phash)
            if d <= NEAR_DUPLICATE_MAX_DISTANCE:
                ra, rb = by_id[a.id], by_id[b.id]
                nd = decisions.get(tuple(sorted((a.id, b.id))))
                near.append({"slide_a": a.id, "slide_b": b.id, "dhash_distance": d,
                             "same_patient": ra["coded_patient_id"] == rb["coded_patient_id"],
                             "cross_split": (ra.get("split") is not None and ra.get("split") != rb.get("split")),
                             "status": "candidate_for_human_review",
                             "human_decision": ({"decision": nd.decision, "reason": nd.reason,
                                                 "reviewer_id": nd.reviewer_id} if nd else None)})
    unscreened = sorted(sid for sid, s in slides.items() if not s.thumbnail_phash)
    return near, unscreened


def _near_duplicate_warnings(db: Session, dv: DatasetVersion, rows: list[dict], near: list[dict],
                             decisions: dict) -> dict[str, list[dict]]:
    """Only ``distinct`` clears a cross-split pair. ``unsure`` keeps blocking; a ``duplicate`` pair still in two
    splits (the grouping could not apply, e.g. both patients were inherited) blocks too."""
    by_id = {r["slide_id"]: r for r in rows}
    pairs = {tuple(sorted((c["slide_a"], c["slide_b"]))): c for c in near}
    # Human decisions on pairs the screen did not flag still count (a person can record any pair).
    for (a, b), nd in sorted(decisions.items()):
        if (a, b) not in pairs and a in by_id and b in by_id:
            ra, rb = by_id[a], by_id[b]
            pairs[(a, b)] = {"slide_a": a, "slide_b": b, "dhash_distance": None,
                             "same_patient": ra["coded_patient_id"] == rb["coded_patient_id"],
                             "cross_split": ra.get("split") is not None and ra.get("split") != rb.get("split"),
                             "status": "human_recorded_pair",
                             "human_decision": {"decision": nd.decision, "reason": nd.reason,
                                                "reviewer_id": nd.reviewer_id}}
    # Included slides joined only THROUGH other decided slides (``A~X``, ``X~B`` with X not included) are the same
    # material too (union-find is transitive): a chain across splits blocks like a direct pair.
    decided = [k for k, nd in sorted(decisions.items()) if nd.decision == "duplicate"]
    for a, b in splitlib.duplicate_closure_pairs(decided, {s: s for s in by_id}):
        if (a, b) not in pairs:
            ra, rb = by_id[a], by_id[b]
            pairs[(a, b)] = {"slide_a": a, "slide_b": b, "dhash_distance": None,
                             "same_patient": ra["coded_patient_id"] == rb["coded_patient_id"],
                             "cross_split": ra.get("split") is not None and ra.get("split") != rb.get("split"),
                             "status": "confirmed_duplicate_chain",
                             "human_decision": {"decision": "duplicate", "reviewer_id": None,
                                                "reason": "joined transitively through confirmed duplicate decisions "
                                                          "on other slides"}}
    out: dict[str, list[dict]] = {"unreviewed_near_duplicates": [], "unsure_near_duplicates": [],
                                  "duplicates_across_splits": []}
    for key in sorted(pairs):
        c = pairs[key]
        if not c["cross_split"]:
            continue
        decision = (c.get("human_decision") or {}).get("decision")
        if decision is None:
            out["unreviewed_near_duplicates"].append(c)
        elif decision == "unsure":
            out["unsure_near_duplicates"].append(c)
        elif decision == "duplicate":
            out["duplicates_across_splits"].append(c)
    return out


def freeze_warnings(db: Session, dv: DatasetVersion) -> dict:
    """What a freeze would lock in that a person should look at first. Every list except ``mixed_label_patients``
    (informational) needs an acknowledgement with a reason (see :data:`ACKNOWLEDGEABLE_WARNINGS`):

    * ``open_qc_issues``: unresolved QC issues a person raised or confirmed on included slides;
    * ``unreviewed_near_duplicates`` / ``unsure_near_duplicates`` / ``duplicates_across_splits``: near-duplicate
      pairs in different splits without a ``distinct`` decision (possible leakage);
    * ``class_absent``: a split the configuration populates has no patient of a class (single-class or empty);
    * ``uncalibrated_items``: real-image items without mpp (supervised use needs calibration).
    """
    s = summary(db, dv)
    rows = item_rows(db, dv)
    cfg = dv.config_json
    decisions = _decisions(db, dv.project_id)
    near = _near_duplicate_warnings(db, dv, rows, s["duplicates"]["near_duplicate_candidates"], decisions)
    # Unconfirmed heuristic suggestions (automated screen, never reviewed) do not block: they are noise until a
    # person confirms them. Issues a person raised or confirmed do.
    confirmed = []
    for w in s["qc_warnings"]:
        ids = [i["id"] for i in w["open_issues"]]
        issues = db.scalars(select(QCIssue).where(QCIssue.id.in_(ids)).order_by(QCIssue.id)).all()
        real = [{"id": i.id, "category": i.category, "status": i.status} for i in issues
                if not (i.is_suggestion and i.status == "open")]
        if real:
            confirmed.append({"slide_id": w["slide_id"], "open_issues": real})
    report = _class_report(rows, cfg)
    mode = data_mode(rows)["mode"]
    uncalibrated = [{"slide_id": r["slide_id"], "missing": [k for k in ("mpp_x", "mpp_y") if not r.get(k)]}
                    for r in rows if not (r.get("mpp_x") and r.get("mpp_y"))] if mode == "real" else []
    return {"open_qc_issues": confirmed, **near,
            "class_absent": report["class_absent"] if report else [],
            "uncalibrated_items": uncalibrated,
            "mixed_label_patients": (report or {}).get("mixed_label_patients") or {"count": 0, "patient_codes": []}}


def freeze_blockers(db: Session, dv: DatasetVersion) -> list[dict]:
    """Conditions that refuse a freeze outright (no acknowledgement can override them)."""
    if dv.status != "draft":
        return [{"code": "dataset_frozen", "message": "Already frozen"}]
    out = []
    try:
        diff = draft_diff(db, dv)
    except ApiError as exc:  # e.g. a test site no longer exists, or the family is locked
        out.append({"code": exc.code, "message": exc.message, **exc.details})
        diff = None
    if diff:
        out.append({"code": "draft_stale", "message": "Eligibility, labels, lineage, provenance or the split "
                    "allocation changed since this draft was materialised; refresh it first.", "diff": diff})
    rows = item_rows(db, dv)
    if not rows:
        out.append({"code": "empty_dataset", "message": "No eligible items"})
    elif any(r["split"] is None for r in rows):
        out.append({"code": "splits_missing", "message": "Assign patient-grouped splits before freezing"})
    mode = data_mode(rows)
    if mode["mode"] == "mixed":
        out.append({"code": "mixed_data_mode", "message": "Synthetic and real items cannot be frozen together; "
                    "restrict include_provenance", "item_counts": mode["item_counts"]})
    if rows and not any(r["split"] is None for r in rows):
        out.extend(_family_freeze_problems(db, dv))
        out.extend(_acquisition_freeze_problems(db, dv))
    return out


def freeze_check(db: Session, dv: DatasetVersion) -> dict:
    """Read-only preview of :func:`freeze`: blockers, warnings needing acknowledgement, informational items.
    ``acquisition_exposure`` reports model-selected material in this version (historical conflicts included)."""
    w = freeze_warnings(db, dv)
    rows = item_rows(db, dv)
    return {**w, "blockers": freeze_blockers(db, dv), "data_mode": data_mode(rows)["mode"],
            "acquisition_exposure": acquisition_report(db, dv, rows),
            "acknowledgeable": list(ACKNOWLEDGEABLE_WARNINGS),
            "requires_acknowledgement": any(w[k] for k in ACKNOWLEDGEABLE_WARNINGS)}


def _acquisition_freeze_problems(db: Session, dv: DatasetVersion, exposure: dict | None = None,
                                 family: dict | None = None) -> list[dict]:
    """``acquisition_exposed_in_evaluation``: val or test of this draft holds model-selected material (a patient an
    active-learning batch proposed, its linked slides or cases, or a confirmed duplicate partner). No
    acknowledgement overrides it; each patient carries ``held_by``, ``historical_conflict`` and a ``resolution``."""
    exposure = acquisition_exposure(db, dv.project_id) if exposure is None else exposure
    assigned = {sa.coded_patient_id: sa.split for sa in db.scalars(
        select(SplitAssignment).where(SplitAssignment.dataset_version_id == dv.id)).all()}
    items = [{"slide_id": it.slide_id, "coded_patient_id": it.coded_patient_id, "patient_code": it.patient_code}
             for it in _stored_items(db, dv)]
    patients, slides = _exposure_conflicts(db, dv, assigned, items, exposure, family)
    if not patients and not slides:
        return []
    return [{"code": ACQUISITION_BLOCKER,
             "message": "Material selected by active learning (the proposed patients, their slides and cases, and "
                        "their confirmed duplicate partners) is model-selected review material and can never be "
                        "validation or test material. See each patient's resolution.",
             "patients": patients[:_DIFF_CAP], "slides": slides[:_DIFF_CAP],
             "historical_conflicts": sum(1 for p in patients if p["historical_conflict"])}]


def _acquisition_freeze_check(db: Session, dv: DatasetVersion, exposure: dict | None = None,
                              family: dict | None = None) -> None:
    for problem in _acquisition_freeze_problems(db, dv, exposure, family):
        details = {k: v for k, v in problem.items() if k not in ("code", "message")}
        raise conflict(problem["code"], problem["message"], **details)


def lock_project_writes(db: Session, project_id: str) -> None:
    """Serialise a dataset freeze with an active-learning commit of the same project. On SQLite the caller already
    holds the database write lock (it flushed a write first; SQLite has one writer), so this is a no-op there
    (``FOR UPDATE`` is not rendered); on PostgreSQL it takes the project row lock both writers ask for."""
    db.execute(select(Project.id).where(Project.id == project_id).with_for_update())


def _family_freeze_problems(db: Session, dv: DatasetVersion) -> list[dict]:
    """Split-family violations that refuse a freeze (each a blocker dict with ``code``, ``message`` and details):

    * ``sealed_patient_moved``: a patient sealed by a test release anywhere in the project is outside test (for
      example a child of another lineage that inherited the patient as train);
    * ``sealed_slide_moved``: a slide a test release looked at (a test item of a sealed patient) is outside test,
      for example after it was moved to another patient's block;
    * ``family_split_locked``: an existing family patient holds another split.
    """
    assigned = {sa.coded_patient_id: sa.split for sa in db.scalars(
        select(SplitAssignment).where(SplitAssignment.dataset_version_id == dv.id)).all()}
    out = []
    sealed = sealed_constraints(db, dv)
    moved = [{"patient_code": s["patient_code"], "sealed_split": s["split"], "split": assigned[pid],
              "split_family_id": s["family_id"], "sealed_in_lineage": s["lineage_id"]}
             for pid, s in sorted(sealed.items()) if pid in assigned and assigned[pid] != s["split"]]
    if moved:
        out.append({"code": "sealed_patient_moved",
                    "message": "Test patients sealed by a test release can never change split (sealing is "
                               "project-wide: it holds in every lineage of the project)",
                    "patients": moved[:_DIFF_CAP]})
    seal_slides = sealed_slides(db, dv.project_id)
    if seal_slides:
        slides_moved = []
        for it in _stored_items(db, dv):
            seal = seal_slides.get(it.slide_id)
            split = assigned.get(it.coded_patient_id)
            if seal is not None and split is not None and split != "test":
                slides_moved.append({"slide_id": it.slide_id, "slide_sha256": it.slide_sha256, "split": split,
                                     "patient_code": it.patient_code, "sealed_with_patient": seal["coded_patient_id"],
                                     "split_family_id": seal["family_id"],
                                     "released_in_dataset_version": seal["dataset_version_id"]})
        if slides_moved:
            out.append({"code": "sealed_slide_moved",
                        "message": "Slides a test release looked at (test items of sealed patients) can never become "
                                   "train or validation items, also after a lineage correction moved them to another "
                                   "patient",
                        "slides": slides_moved[:_DIFF_CAP]})
    existing = family_assignments(db, lineage_family(db, dv.lineage_id))
    conflicts = [{"patient_code": a.patient_code, "family_split": a.split, "split": assigned[pid]}
                 for pid, a in sorted(existing.items()) if pid in assigned and assigned[pid] != a.split]
    if conflicts:
        out.append({"code": "family_split_locked", "message": "These patients already hold another split in this "
                    "lineage's split family; child versions inherit them", "patients": conflicts[:_DIFF_CAP]})
    return out


def _family_freeze_check(db: Session, dv: DatasetVersion) -> None:
    for problem in _family_freeze_problems(db, dv):
        details = {k: v for k, v in problem.items() if k not in ("code", "message")}
        raise conflict(problem["code"], problem["message"], **details)


def freeze(db: Session, actor: Actor, dv: DatasetVersion, reason: str | None = None,
           acknowledge_warnings: bool = False) -> DatasetVersion:
    if dv.status != "draft":
        raise conflict("dataset_frozen", "Already frozen")
    # Model-selected material in val/test (e.g. a proposal committed after the draft was allocated): refused with
    # its own code before the stale check, so the response names the patients and the resolution.
    _acquisition_freeze_check(db, dv)
    diff, exclusions, fresh_diag = _draft_state_with_plan(db, dv)
    if diff:
        raise conflict("draft_stale", "Eligibility, labels, lineage, provenance or the split allocation changed "
                       "since this draft was materialised. Refresh the draft, review it, then freeze.", diff=diff)
    dv.exclusions_json = exclusions  # same items; exclusions as of freeze time
    if fresh_diag is not None:
        # The mapping is unchanged (else draft_stale), but its diagnostics (date ranges, cutoff spanning, unknown
        # sites, per-site table, sealed pins) are recomputed now, so the immutable manifest records them as frozen.
        dv.config_json = {**dv.config_json, "split_diagnostics": fresh_diag}
    rows = item_rows(db, dv)
    if not rows:
        raise conflict("empty_dataset", "Cannot freeze a dataset version with no eligible items")
    missing = sorted({r["coded_patient_id"] for r in rows if r["split"] is None})
    if missing:
        raise conflict("splits_missing", "Assign patient-grouped splits before freezing (POST /datasets/{id}/splits)",
                       patients_without_split=missing)
    _check_grouping(rows)
    mode = data_mode(rows)
    if mode["mode"] == "mixed":
        raise conflict("mixed_data_mode", "A dataset never mixes synthetic (demo_synthetic procedural tiles) and real "
                       "items; restrict include_provenance and refresh", item_counts=mode["item_counts"])
    _family_freeze_check(db, dv)
    warnings = freeze_warnings(db, dv)
    has_warnings = any(warnings[k] for k in ACKNOWLEDGEABLE_WARNINGS)
    if has_warnings and not acknowledge_warnings:
        raise conflict("freeze_warnings_unacknowledged",
                       "Open QC issues, unresolved near-duplicates across splits, splits missing a class or "
                       "uncalibrated items would be frozen into this version. Resolve them, or freeze anyway with "
                       "acknowledge_warnings and a reason (recorded in the manifest).",
                       **warnings)
    if has_warnings and not (reason and reason.strip()):
        raise unprocessable("reason_required", "Freezing with acknowledged warnings needs a reason")
    now = utcnow()
    fam = _ensure_family(db, dv, actor.id)
    exposure = acquisition_exposure(db, dv.project_id)
    manifest = build_manifest(db, dv, now, actor.id, family=fam, exposure=exposure)
    if has_warnings:
        manifest["acknowledged_warnings"] = {**warnings, "reason": reason, "acknowledged_by": actor.id}
    existing = family_assignments(db, fam)
    for s in manifest["splits"]:
        if s["coded_patient_id"] not in existing:
            db.add(SplitFamilyAssignment(family_id=fam.id, coded_patient_id=s["coded_patient_id"],
                                         patient_code=s["patient_code"], split=s["split"], first_version_id=dv.id))
    digest = hashlib.sha256(canonical_json(manifest)).hexdigest()
    key = f"projects/{dv.project_id}/datasets/{dv.id}/manifest.json"
    dv.manifest_json = manifest
    dv.manifest_sha256 = digest
    dv.manifest_object_key = key
    dv.frozen_at = now
    dv.frozen_by = actor.id
    dv.status = "frozen"
    audit_log.record_for(db, actor, project_id=dv.project_id, action="dataset.frozen", entity_type="dataset_version",
                         entity_id=dv.id, before={"status": "draft"},
                         after={"status": "frozen", "manifest_sha256": digest, "items": len(rows),
                                "data_mode": mode["mode"], "split_family_id": fam.id,
                                "split_fingerprint": manifest["split_fingerprint"],
                                "acknowledged": [k for k in ACKNOWLEDGEABLE_WARNINGS if warnings[k]]}, reason=reason)
    db.flush()
    # Final exposure check INSIDE this write transaction: the flush above took the database write lock (SQLite has
    # one writer; PostgreSQL takes the project row lock below, which the active-learning commit also takes), so an
    # active-learning proposal committed while this freeze was re-planning is visible now, and none can commit until
    # this transaction ends. A refusal rolls everything back (the caller never commits it).
    lock_project_writes(db, dv.project_id)
    current = acquisition_exposure(db, dv.project_id)
    _acquisition_freeze_check(db, dv, current, existing)  # the family as it was before this freeze added to it
    in_version = ({s["coded_patient_id"] for s in manifest["splits"]}, {r["slide_id"] for r in manifest["items"]})
    if _version_exposure(current, *in_version) != _version_exposure(exposure, *in_version):
        raise conflict("draft_stale", "Patients of this version were selected by active learning while it was being "
                       "frozen (they stay in train); freeze again so the manifest records them as model-selected.")
    get_store().put_bytes(key, json.dumps(manifest, indent=2, sort_keys=True).encode())
    return dv


def _version_exposure(exposure: dict, patient_ids: set[str], slide_ids: set[str]) -> tuple[list[str], list[str]]:
    return (sorted(pid for pid in exposure["patients"] if pid in patient_ids),
            sorted(sid for sid in exposure["slides"] if sid in slide_ids))


def verify_manifest(dv: DatasetVersion) -> bool | None:
    if dv.status != "frozen" or not dv.manifest_json:
        return None
    return hashlib.sha256(canonical_json(dv.manifest_json)).hexdigest() == dv.manifest_sha256


def new_version(db: Session, actor: Actor, parent: DatasetVersion, *, reason: str, name: str | None = None,
                new_lineage: bool = False, split: dict | None = None) -> DatasetVersion:
    """A child draft of a frozen version. It inherits the parent's split family (every existing patient keeps
    their split). A different ``split`` needs ``new_lineage`` (a new family; sealed test patients still stay
    test); otherwise ``409 family_split_locked``."""
    if parent.status != "frozen":
        raise conflict("parent_not_frozen", "Only frozen versions get child versions; refresh the draft instead")
    if not reason or not reason.strip():
        raise unprocessable("reason_required", "A new dataset version needs a reason (e.g. a label changed after freeze)")
    project = db.get(Project, parent.project_id)
    cfg = json.loads(json.dumps(parent.config_json))
    cfg.pop("split_diagnostics", None)
    if split is not None:
        requested = splitlib.normalise_split(split)
        if not new_lineage and splitlib.partition_key(requested) != splitlib.partition_key(cfg.get("split")):
            fam = lineage_family(db, parent.lineage_id)
            raise conflict("family_split_locked",
                           "Child versions inherit the lineage's patient splits. To use another partition or seed, "
                           "start a new lineage (new_lineage=true) with a reason.",
                           split_family_id=fam.id if fam else None,
                           family_partition=splitlib.partition_key(cfg.get("split")),
                           requested=splitlib.partition_key(requested))
        cfg["split"] = requested
    return create_draft(db, actor, project, name=name or parent.name, config=cfg, parent=parent, reason=reason,
                        new_lineage=new_lineage)


def refresh(db: Session, actor: Actor, dv: DatasetVersion) -> dict:
    result = materialize(db, dv)
    audit_log.record_for(db, actor, project_id=dv.project_id, action="dataset.refreshed",
                         entity_type="dataset_version", entity_id=dv.id,
                         after={"items": result["items"], "excluded": result["excluded"],
                                "data_mode": result["data_mode"]["mode"], "split": _split_audit(result["split"])})
    return result


def staleness(db: Session, dv: DatasetVersion) -> dict:
    """Differences between this version's labels and the current reference labels."""
    rows = item_rows(db, dv)
    standard = reference_standard_of(dv.config_json)
    changed = []
    for r in rows:
        target = r["slide_id"] if r["label_scope"] == "slide" else r["case_id"]
        ref, status = reference_label(db, dv.project_id, r["label_scope"], target, reference_standard=standard)
        if ref is None or ref.id != r["label_version_id"]:
            changed.append({"slide_id": r["slide_id"], "label_scope": r["label_scope"],
                            "dataset_label_version_id": r["label_version_id"], "dataset_value": r["label_value"],
                            "current_label_version_id": ref.id if ref else None,
                            "current_value": ref.value if ref else None, "current_status": status})
    return {
        "dataset_version_id": dv.id,
        "status": dv.status,
        "reference_standard": standard,
        "changed_labels": changed,
        "stale": bool(changed),
        "action": ("Frozen versions never change. Create a new version (POST /datasets/{id}/new-version) "
                   "to include the changed labels.") if (changed and dv.status == "frozen") else None,
    }


# --------------------------------------------------------------------------- test-set lock


def training_eligible_items(db: Session, dv: DatasetVersion, purpose: str) -> list[dict]:
    """Items usable for ``purpose``. Test items are NEVER returned for train, active_learning
    or threshold_selection. Only frozen versions are usable (reproducibility)."""
    if purpose not in ITEM_PURPOSES:
        raise ValueError(f"unknown purpose {purpose!r}; expected one of {ITEM_PURPOSES}")
    if dv.status != "frozen" or not dv.manifest_json:
        raise DatasetNotFrozen("freeze the dataset version before using it for any purpose")
    allowed = PURPOSE_SPLITS[purpose]
    items = [dict(r) for r in dv.manifest_json["items"] if r.get("split") in allowed]
    if purpose in TEST_LOCKED_PURPOSES and any(r.get("split") == "test" for r in items):
        raise TestSetLockViolation("test items reached a locked purpose")  # defence in depth
    return items


# --------------------------------------------------------------------------- summary


def reviewer_agreement(db: Session, project_id: str, scope: str, target_ids: list[str]) -> dict:
    pairs = agree = multi = 0
    pair_counts: Counter = Counter()
    pair_tables: dict[tuple[str, str], list[tuple[str, str]]] = defaultdict(list)
    for t in target_ids:
        ops = current_expert_opinions(db, project_id, scope, t)
        if len(ops) < 2:
            continue
        multi += 1
        authors = sorted(ops)
        for i in range(len(authors)):
            for j in range(i + 1, len(authors)):
                a, b = authors[i], authors[j]
                pairs += 1
                agree += ops[a].value == ops[b].value
                pair_counts[(a, b)] += 1
                pair_tables[(a, b)].append((ops[a].value, ops[b].value))
    out: dict = {"scope": scope, "targets_considered": len(target_ids), "targets_with_2plus_readers": multi,
                 "reader_pairs": pairs, "agreeing_pairs": agree}
    out["observed_agreement"] = round(agree / pairs, 4) if pairs else "undefined (denominator 0)"
    if pair_counts:
        (a, b), n = pair_counts.most_common(1)[0]
        if n < 10:
            out["cohen_kappa"] = f"insufficient evidence (n={n} co-read targets; need at least 10)"
        else:
            tab = pair_tables[(a, b)]
            cats = sorted({x for p in tab for x in p})
            po = sum(x == y for x, y in tab) / n
            pa = Counter(x for x, _ in tab)
            pb = Counter(y for _, y in tab)
            pe = sum(pa[c] * pb[c] for c in cats) / (n * n)
            out["cohen_kappa"] = round((po - pe) / (1 - pe), 4) if pe < 1 else "undefined (expected agreement is 1)"
        out["kappa_reader_pair"] = [a, b]
    else:
        out["cohen_kappa"] = "undefined (no target read by two experts)"
    return out


def summary(db: Session, dv: DatasetVersion) -> dict:
    rows = item_rows(db, dv)
    cfg = dv.config_json
    by_label = defaultdict(lambda: {"slides": 0, "cases": set(), "patients": set()})
    for r in rows:
        b = by_label[r["label_value"]]
        b["slides"] += 1
        b["cases"].add(r["case_id"])
        b["patients"].add(r["coded_patient_id"])
    label_balance = {k: {"slides": v["slides"], "cases": len(v["cases"]), "patients": len(v["patients"]),
                         "display": LABEL_DISPLAY.get(k)} for k, v in sorted(by_label.items())}

    def tally(key):
        return dict(sorted(Counter((r.get(key) or "unknown") for r in rows).items()))

    def cross(key):
        t: dict = defaultdict(Counter)
        for r in rows:
            t[r.get(key) or "unknown"][r["label_value"]] += 1
        return {k: dict(v) for k, v in sorted(t.items())}

    report = _class_report(rows, cfg)
    per_split = {}
    for sp in ("train", "val", "test"):
        sr = [r for r in rows if r.get("split") == sp]
        per_split[sp] = {"patients": len({r["coded_patient_id"] for r in sr}), "slides": len(sr),
                         "label_balance": dict(Counter(r["label_value"] for r in sr)),
                         "patient_label_balance": ({c: v["patients"] for c, v in report["per_split_class"][sp].items()}
                                                   if report else None)}
    unassigned = [r["slide_id"] for r in rows if r.get("split") is None]
    missing = {}
    for field, getter in (("mpp", lambda r: r.get("mpp_x")), ("scanner_id", lambda r: r.get("scanner_id")),
                          ("stain", lambda r: r.get("stain")), ("collected_on", lambda r: r.get("collected_on")),
                          ("site_id", lambda r: r.get("site_id"))):
        ids = [r["slide_id"] for r in rows if not getter(r)]
        missing[field] = {"count": len(ids), "slide_ids": ids[:50]}
    exclusions = dv.manifest_json["exclusions"] if (dv.status == "frozen" and dv.manifest_json) else dv.exclusions_json
    reason_counts = Counter(rsn["code"] for e in exclusions for rsn in e["reasons"])

    # Duplicates: exact (sha256) inside the dataset, and near-duplicate CANDIDATES (thumbnail dHash).
    sha_groups = defaultdict(list)
    for r in rows:
        sha_groups[r["slide_sha256"]].append(r["slide_id"])
    exact = [{"sha256": k, "slide_ids": v} for k, v in sha_groups.items() if len(v) > 1]
    rejected_at_upload = db.scalars(select(Upload.id).where(Upload.project_id == dv.project_id,
                                                            Upload.status == "duplicate")).all()
    near, unscreened = _near_duplicates(db, rows, _decisions(db, dv.project_id))
    scope = cfg["label_scope"]
    project_targets = (list(db.scalars(select(Slide.id).where(Slide.project_id == dv.project_id)))
                       if scope == "slide" else
                       list(db.scalars(select(Case.id).where(Case.project_id == dv.project_id))))
    qc_warnings = []
    for r in rows:
        open_issues = db.scalars(select(QCIssue).where(QCIssue.slide_id == r["slide_id"],
                                                       QCIssue.status != "resolved").order_by(QCIssue.id)).all()
        if open_issues:
            qc_warnings.append({"slide_id": r["slide_id"],
                                "open_issues": [{"id": i.id, "category": i.category, "is_suggestion": i.is_suggestion}
                                                for i in open_issues]})
    prov = Counter(r["provenance"] for r in rows)
    mode = data_mode(rows)
    synthetic_only = mode["mode"] == "synthetic"
    out = {
        "dataset_version_id": dv.id,
        "name": dv.name,
        "version": dv.version,
        "status": dv.status,
        "label_scope": scope,
        "reference_standard": reference_standard_of(cfg),
        "counts": {
            "patients": len({r["coded_patient_id"] for r in rows}),
            "cases": len({r["case_id"] for r in rows}),
            "blocks": len({r["block_id"] for r in rows}),
            "slides": len(rows),
            "patches": None,
            "patches_note": "Patches are produced by the processing pipeline (ML pass); none are counted here.",
        },
        "label_balance": label_balance,
        "splits": {"assigned": not unassigned and bool(rows), "partition": (cfg.get("split") or {}).get("partition"),
                   "per_split": per_split, "unassigned_slide_ids": unassigned,
                   "class_absent": report["class_absent"] if report else [],
                   "mixed_label_patients": report["mixed_label_patients"] if report else None,
                   "patient_label_rule": _label_rule(cfg)},
        "batches": {"site": tally("site_id"), "scanner": tally("scanner_id"), "stain": tally("stain"),
                    "label_by_site": cross("site_id"), "label_by_scanner": cross("scanner_id"),
                    "label_by_stain": cross("stain")},
        "missing_metadata": missing,
        "exclusions": {"count": len(exclusions), "by_reason": dict(sorted(reason_counts.items())),
                       "slides": exclusions},
        "reviewer_agreement": reviewer_agreement(db, dv.project_id, scope, project_targets),
        "duplicates": {
            "exact_within_dataset": exact,
            "exact_rejected_at_upload": len(rejected_at_upload),
            "exact_note": "Uploads with an existing sha256 are rejected per project (unique constraint).",
            "near_duplicate_candidates": near,
            "near_duplicate_unscreened_slides": len(unscreened),
            "near_duplicate_method": f"thumbnail dHash (64-bit), Hamming distance <= {NEAR_DUPLICATE_MAX_DISTANCE}",
            "near_duplicate_note": ("Candidates for HUMAN review only; nothing is removed automatically. Only a "
                                    "'distinct' decision clears a cross-split pair; 'duplicate' keeps both patients "
                                    "in one split."),
        },
        "qc_warnings": qc_warnings,
        "provenance_mix": dict(sorted(prov.items())),
        "data_mode": mode["mode"],
        "synthetic_only": synthetic_only,
        "notice": PIPELINE_TEST_NOTICE if synthetic_only else None,
        "workflow_metadata_note": "Counts describe workflow metadata, not experiment results.",
    }
    if dv.status == "frozen":
        out["manifest_sha256"] = dv.manifest_sha256
        out["manifest_verified"] = verify_manifest(dv)
    return out


# --------------------------------------------------------------------------- audit (design §9)


def _union_clusters(edges: list[tuple[str, str]]) -> list[list[str]]:
    parent: dict[str, str] = {}

    def find(x: str) -> str:
        parent.setdefault(x, x)
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    for a, b in edges:
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[max(ra, rb)] = min(ra, rb)
    groups: dict[str, list[str]] = defaultdict(list)
    for x in sorted(parent):
        groups[find(x)].append(x)
    return [g for g in groups.values() if len(g) > 1]


def _confounding(patients: dict[str, dict], key: str, row_of) -> dict:
    """Patient-level table ``row_of(patient) × patient attribute`` with association, plus the slide table."""
    table = contingency((row_of(p), patient_attribute(p["values"][key])) for p in patients.values())
    slide_table = contingency((row_of(p), v or "unknown") for p in patients.values() for v in p["slide_values"][key])
    return {"unit": "patients", "table": table, "slide_table": slide_table, **association(table)}


def audit(db: Session, dv: DatasetVersion, *, exposure: dict | None = None) -> dict:
    """Dataset audit (design §9). Descriptive; nothing is changed or resolved automatically."""
    rows = item_rows(db, dv)
    cfg = dv.config_json
    rule, pos = _label_rule(cfg), positive_class(cfg)
    report = _class_report(rows, cfg)
    # Patients: stratum label (rule), split, and per-attribute values from the snapshot rows.
    patients: dict[str, dict] = {}
    for r in sorted(rows, key=lambda r: (r["coded_patient_id"], r["slide_id"])):
        p = patients.setdefault(r["coded_patient_id"], {
            "code": r.get("patient_code"), "bags": {}, "splits": set(),
            "values": defaultdict(set), "slide_values": defaultdict(list)})
        p["bags"].setdefault(r["slide_id"] if r["label_scope"] == "slide" else r["case_id"], r["label_value"])
        p["splits"].add(r.get("split"))
        for k in ("site_id", "scanner_id", "stain"):
            p["values"][k].add(r.get(k))
            p["slide_values"][k].append(r.get(k))
    for p in patients.values():
        p["label"] = splitlib.patient_label([p["bags"][k] for k in sorted(p["bags"])], rule, positive_class=pos)
        p["split"] = next(iter(p["splits"])) if len(p["splits"]) == 1 else "multiple"

    # Patient independence: by snapshot, and against the CURRENT lineage (slides moved since the snapshot).
    multi = sorted(p["code"] or pid for pid, p in patients.items() if len(p["splits"]) > 1)
    live_split: dict[str, set] = defaultdict(set)
    moved = []
    for r in rows:
        slide = db.get(Slide, r["slide_id"])
        lin = slide_lineage(db, slide) if slide is not None else {}
        live_pid = lin.get("coded_patient_id")
        live_split[live_pid or f"unassigned:{r['slide_id']}"].add(r.get("split"))
        if live_pid != r["coded_patient_id"]:
            moved.append({"slide_id": r["slide_id"], "snapshot_patient_code": r.get("patient_code"),
                          "current_patient_code": lin.get("patient_code")})
    live_multi_ids = [pid for pid, sps in live_split.items() if len(sps) > 1]
    live_codes = dict(db.execute(select(CodedPatient.id, CodedPatient.code)
                                 .where(CodedPatient.id.in_(live_multi_ids))).all()) if live_multi_ids else {}
    live_multi = sorted(live_codes.get(pid, pid) for pid in live_multi_ids)

    decisions = _decisions(db, dv.project_id)
    near, unscreened = _near_duplicates(db, rows, decisions)
    by_id = {r["slide_id"]: r for r in rows}
    edges = [(c["slide_a"], c["slide_b"]) for c in near
             if (c.get("human_decision") or {}).get("decision") != "distinct"]
    edges += [(a, b) for (a, b), nd in sorted(decisions.items())
              if nd.decision in ("duplicate", "unsure") and a in by_id and b in by_id]
    clusters = []
    for g in _union_clusters(edges):
        sps = sorted({by_id[s].get("split") or "unassigned" for s in g})
        if len(sps) > 1:
            clusters.append({"slide_ids": g, "splits": sps})
    decision_counts = Counter(nd.decision for (a, b), nd in decisions.items() if a in by_id and b in by_id)

    sha_groups = defaultdict(list)
    for r in rows:
        sha_groups[r["slide_sha256"]].append(r["slide_id"])
    shas = sorted(sha_groups)
    other_projects = 0
    for i in range(0, len(shas), 500):
        other_projects += len(db.scalars(select(Slide.id).where(Slide.sha256.in_(shas[i:i + 500]),
                                                                Slide.project_id != dv.project_id)).all())

    scope = cfg["label_scope"]
    other_scope = sorted(r["slide_id"] for r in rows if r["label_scope"] != scope)
    case_labels: dict[str, set] = defaultdict(set)
    for r in rows:
        case_labels[r["case_id"]].add((r["label_version_id"], r["label_value"]))
    inconsistent_cases = sorted(c for c, v in case_labels.items() if len(v) > 1) if scope == "case" else []

    n = len(rows)
    missing = {}
    for field, getter in (("mpp", lambda r: r.get("mpp_x") and r.get("mpp_y")), ("scanner_id", lambda r: r.get("scanner_id")),
                          ("site_id", lambda r: r.get("site_id")), ("stain", lambda r: r.get("stain")),
                          ("collected_on", lambda r: r.get("collected_on"))):
        k = sum(1 for r in rows if not getter(r))
        missing[field] = {"count": k, "fraction": round(k / n, 4) if n else None}

    confounding = {
        "label_by_site": _confounding(patients, "site_id", lambda p: p["label"]),
        "label_by_scanner": _confounding(patients, "scanner_id", lambda p: p["label"]),
        "label_by_stain": _confounding(patients, "stain", lambda p: p["label"]),
        "split_by_site": _confounding(patients, "site_id", lambda p: p["split"] or "unassigned"),
        "note": UNIT_NOTE,
    }
    return {
        "schema": AUDIT_SCHEMA,
        "dataset_version_id": dv.id,
        "status": dv.status,
        "patient_label_rule": rule,
        "positive_class": pos,
        "patient_independence": {
            "patients_in_more_than_one_split": multi,
            "live_lineage": {"slides_moved_since_snapshot": moved[:_DIFF_CAP], "moved_count": len(moved),
                             "patients_spanning_splits_now": live_multi},
            "near_duplicate_clusters_across_splits": clusters,
            "ok": not multi and not live_multi and not clusters,
        },
        "duplicates": {
            "exact_within_dataset": [{"sha256": k, "slide_ids": v} for k, v in sorted(sha_groups.items()) if len(v) > 1],
            "exact_in_other_projects": other_projects,
            "uploads_rejected_as_exact_duplicate": len(db.scalars(select(Upload.id).where(
                Upload.project_id == dv.project_id, Upload.status == "duplicate")).all()),
            "near_duplicate_candidates": len(near),
            "near_duplicate_decisions": dict(sorted(decision_counts.items())),
            "near_duplicate_unscreened_slides": len(unscreened),
        },
        "label_scope": {"scope": scope, "items_with_other_scope": other_scope,
                        "cases_with_inconsistent_labels": inconsistent_cases},
        "missing_metadata": missing,
        "class_balance": report["per_split_class"] if report else None,
        "class_absent": report["class_absent"] if report else [],
        "confounding": confounding,
        "mixed_label_patients": (report or {}).get("mixed_label_patients"),
        "data_mode": data_mode(rows),
        "acquisition_exposure": acquisition_report(db, dv, rows, exposure),
        "research_use_only": True,
    }


def project_acquisition_report(db: Session, project_id: str) -> dict:
    """Project-wide acquisition exposure: every exposed patient with its sources, and the historical conflicts of
    every FROZEN version (exposed material in its val/test). Read-only: frozen versions and their stored
    evaluations are never rewritten; a listed conflict qualifies their val/test metrics."""
    exposure = acquisition_exposure(db, project_id)
    conflicts = []
    for dv in db.scalars(select(DatasetVersion).where(DatasetVersion.project_id == project_id,
                                                      DatasetVersion.status == "frozen")
                         .order_by(DatasetVersion.frozen_at, DatasetVersion.id)).all():
        rep = acquisition_report(db, dv, exposure=exposure)
        if rep["in_evaluation"] or rep["slides_in_evaluation"]:
            conflicts.append({"dataset_version_id": dv.id, "name": dv.name, "version": dv.version,
                              "lineage_id": dv.lineage_id, "frozen_at": dv.frozen_at.isoformat() if dv.frozen_at
                              else None, "patients": rep["in_evaluation"], "slides": rep["slides_in_evaluation"]})
    return {"schema": ACQUISITION_SCHEMA, "project_id": project_id,
            "exposed_patients": list(exposure["patients"].values()), "recorded_rows": exposure["recorded_rows"],
            "legacy_proposals": exposure["legacy_proposals"], "historical_conflicts": conflicts,
            "frozen_versions_rewritten": False, "creates_labels": False,
            "notice": "Model-selected review material (active-learning proposals with their slides, cases and "
                      "confirmed duplicates) trains models but never evaluates them. Research use only."}


# --------------------------------------------------------------------------- export


CSV_FIELDS = ["slide_id", "slide_sha256", "label_version_id", "label_value", "label_scope", "split", "partition",
              "coded_patient_id", "patient_code", "case_id", "accession_code", "part", "block_id", "block",
              "level_index", "stain", "scanner_id", "site_id", "collected_on", "image_kind", "provenance",
              "mpp_x", "mpp_y", "label_source"]


def export_csv(dv: DatasetVersion) -> str:
    buf = io.StringIO()
    buf.write(f"# dermpath dataset manifest {dv.id} v{dv.version}; manifest_sha256={dv.manifest_sha256}\n")
    buf.write("# Research use only. Coded identifiers only. Label 'bcc_absent_not_benign' is NOT 'benign'.\n")
    standard = (dv.manifest_json or {}).get("config", {}).get("reference_standard") or "expert"
    buf.write(f"# reference_standard={standard}: {REFERENCE_STANDARD_DISPLAY.get(standard, standard)}\n")
    licence = ((dv.manifest_json or {}).get("public_dataset") or {}).get("licence")
    if licence:
        buf.write(f"# Contains public licensed data under {licence}; the licence terms apply to this export.\n")
    w = csv.DictWriter(buf, fieldnames=CSV_FIELDS, extrasaction="ignore", lineterminator="\n")
    w.writeheader()
    for r in dv.manifest_json["items"]:
        w.writerow(r)
    return buf.getvalue()


def dataset_dict(dv: DatasetVersion, item_count: int | None = None) -> dict:
    return {
        "id": dv.id, "project_id": dv.project_id, "lineage_id": dv.lineage_id, "name": dv.name,
        "version": dv.version, "status": dv.status, "config": dv.config_json,
        "manifest_sha256": dv.manifest_sha256, "created_by": dv.created_by, "created_at": dv.created_at.isoformat(),
        "frozen_at": dv.frozen_at.isoformat() if dv.frozen_at else None, "frozen_by": dv.frozen_by,
        "parent_version_id": dv.parent_version_id, "reason": dv.reason,
        "materialized_at": dv.materialized_at.isoformat() if dv.materialized_at else None,
        "item_count": item_count, "excluded_count": len(dv.exclusions_json or []),
    }
