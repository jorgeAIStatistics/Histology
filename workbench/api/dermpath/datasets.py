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
  on patients) and mixed-label patients. Embedded in the manifest at freeze.
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
from .labels import current_expert_opinions, open_disagreement, reference_label
from .models import (
    Case,
    CodedPatient,
    DatasetItem,
    DatasetVersion,
    NearDuplicateReview,
    Project,
    QCIssue,
    QCReview,
    Slide,
    SplitAssignment,
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
    ITEM_PURPOSES,
    LABEL_DISPLAY,
    LABEL_VALUES,
    PROVENANCES,
    PURPOSE_SPLITS,
    TEST_LOCKED_PURPOSES,
)

PIPELINE_TEST_NOTICE = "PIPELINE TEST — NOT PATHOLOGY VALIDATION (synthetic, procedural images; no histology)"
NEAR_DUPLICATE_MAX_DISTANCE = 6
MANIFEST_SCHEMA = "dermpath.dataset_manifest/2"
AUDIT_SCHEMA = "dermpath.dataset_audit/1"
REAL_PROVENANCES = ("public_cc0", "real_authorized")
# Snapshot fields compared by freeze (draft_stale) and written to every manifest item.
SNAPSHOT_FIELDS = ("slide_sha256", "label_version_id", "label_value", "label_scope", "label_source", "case_id",
                   "coded_patient_id", "patient_code", "accession_code", "part", "block_id", "block", "level_index",
                   "site_id", "collected_on", "scanner_id", "stain", "mpp_x", "mpp_y", "image_kind", "provenance")
# Warnings a research lead must acknowledge (with a reason) to freeze; mixed_label_patients is informational.
ACKNOWLEDGEABLE_WARNINGS = ("open_qc_issues", "unreviewed_near_duplicates", "unsure_near_duplicates",
                            "duplicates_across_splits", "class_absent", "uncalibrated_items")
_DIFF_CAP = 50

# Re-exported so existing callers keep working.
normalise_split = splitlib.normalise_split


class DatasetNotFrozen(Exception):
    pass


class TestSetLockViolation(AssertionError):
    pass


# --------------------------------------------------------------------------- config


def normalise_config(project: Project, config: dict) -> dict:
    tmpl = project.task_template_json or {}
    scope = config.get("label_scope", "slide")
    if scope not in DATASET_LABEL_SCOPES:
        raise unprocessable("invalid_label_scope", f"label_scope must be one of {list(DATASET_LABEL_SCOPES)}")
    states = list(config.get("eligible_review_states") or ["approved"])
    bad = [s for s in states if s not in DATASET_ELIGIBLE_REVIEW_STATES]
    if bad or not states:
        raise unprocessable("invalid_review_states",
                            f"eligible_review_states must be a non-empty subset of {list(DATASET_ELIGIBLE_REVIEW_STATES)}",
                            invalid=bad)
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
        target = slide.id if scope == "slide" else lineage["case_id"]
        ref, status = reference_label(db, slide.project_id, scope, target)
        if open_disagreement(db, slide.project_id, scope, target):
            reasons.append(_reason("open_disagreement", f"{scope}-level expert labels disagree"))
        elif status == "unlabeled":
            detail = f"no expert label at {scope} scope"
            if scope == "slide":
                case_ref, _ = reference_label(db, slide.project_id, "case", lineage["case_id"])
                if case_ref is not None:
                    detail += " (a case-level label exists but is never copied down to slides)"
            reasons.append(_reason(f"no_reference_label_{scope}", detail))
        elif status == "disputed":
            reasons.append(_reason("label_disputed", f"{scope}-level expert labels disagree"))
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
    """``synthetic`` (demo_synthetic procedural tiles), ``real`` (public_cc0 / real_authorized images) or
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
            "rule": "synthetic = every item demo_synthetic + synthetic_tiles; real = every item public_cc0 or "
                    "real_authorized; anything else is mixed and cannot be frozen"}


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
    """``{coded_patient_id: {split, family_id, sealed_at, sealed_reason}}`` sealed in this version's family or in
    the family of any ancestor lineage. Sealed patients never change split."""
    out: dict[str, dict] = {}
    for lineage_id in _lineages_in_scope(db, dv):
        fam = lineage_family(db, lineage_id)
        for a in family_assignments(db, fam).values():
            if a.sealed_at is not None and a.coded_patient_id not in out:
                out[a.coded_patient_id] = {"split": a.split, "family_id": a.family_id, "patient_code": a.patient_code,
                                           "sealed_at": a.sealed_at.isoformat(), "sealed_reason": a.sealed_reason}
    return out


def _decisions(db: Session, project_id: str) -> dict[tuple[str, str], NearDuplicateReview]:
    """The latest human near-duplicate decision per (sorted) slide pair."""
    out: dict[tuple[str, str], NearDuplicateReview] = {}
    for nd in db.scalars(select(NearDuplicateReview).where(NearDuplicateReview.project_id == project_id)
                         .order_by(NearDuplicateReview.created_at, NearDuplicateReview.id)).all():
        out[tuple(sorted((nd.slide_a_id, nd.slide_b_id)))] = nd
    return out


def _duplicate_groups(db: Session, dv: DatasetVersion) -> list[tuple[str, str]]:
    """Patient pairs joined by a ``duplicate`` decision on two included slides of different patients."""
    owner = dict(db.execute(select(DatasetItem.slide_id, DatasetItem.coded_patient_id)
                            .where(DatasetItem.dataset_version_id == dv.id)).all())
    pairs = []
    for (a, b), nd in sorted(_decisions(db, dv.project_id).items()):
        if nd.decision == "duplicate" and a in owner and b in owner and owner[a] != owner[b]:
            pairs.append((owner[a], owner[b]))
    return pairs


def known_sites(db: Session, project_id: str) -> list[str]:
    return sorted(s for s in db.scalars(select(Case.site_id).where(Case.project_id == project_id).distinct()) if s)


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
    sites = known_sites(db, dv.project_id) if split["partition"] == "external_site" else None
    mapping, diag = splitlib.allocate(patients, split, salt=fam.salt if fam else project_salt(dv.project_id),
                                      existing=existing, groups=_duplicate_groups(db, dv),
                                      classes=cfg.get("label_values"), known_sites=sites,
                                      positive_class=positive_class(cfg))
    in_cohort = {p["id"] for p in patients}
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
    out = []
    for (a, b), nd in sorted(_decisions(db, dv.project_id).items()):
        if a in slide_ids or b in slide_ids:
            out.append({"slide_a": a, "slide_b": b, "decision": nd.decision, "reason": nd.reason,
                        "reviewer_id": nd.reviewer_id, "decided_at": nd.created_at.isoformat(),
                        "both_in_dataset": a in slide_ids and b in slide_ids})
    return out


def build_manifest(db: Session, dv: DatasetVersion, frozen_at, frozen_by: str, *,
                   family: SplitFamily | None = None) -> dict:
    rows = [{**r, **qc_snapshot(db, r["slide_id"])} for r in item_rows(db, dv)]
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
        "items": rows,
        "splits": splits,
        "split_family_id": family.id if family else None,
        "split_family_salt": family.salt if family else None,
        "split_fingerprint": splitlib.split_fingerprint((s["patient_code"], s["split"]) for s in splits),
        "split_family_counts": {"inherited": len(version_patients & set(fam_existing)),
                                "new": len(version_patients - set(fam_existing)),
                                "dropped": len(set(fam_existing) - version_patients)},
        "split_diagnostics": diag,
        "near_duplicate_decisions": _decisions_in_force(db, dv, {r["slide_id"] for r in rows}),
        "exclusions": dv.exclusions_json,
        "audit": audit(db, dv),
        "python_version": platform.python_version(),
        "research_use_only": True,
    }


def _draft_state(db: Session, dv: DatasetVersion) -> tuple[dict | None, list[dict]]:
    """Re-materialise in memory and diff against the stored draft: ``(diff or None, fresh exclusions)``."""
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
    if not (added or removed or changed) and cfg.get("split"):
        _, mapping, _, _ = _plan_splits(db, dv, cfg["split"])
        stored_sa = {sa.coded_patient_id: sa.split for sa in db.scalars(
            select(SplitAssignment).where(SplitAssignment.dataset_version_id == dv.id)).all()}
        codes = {it["coded_patient_id"]: it["patient_code"] for it in stored.values()}
        for pid in sorted(set(mapping) | set(stored_sa)):
            if mapping.get(pid) != stored_sa.get(pid):
                split_changes.append({"patient_code": codes.get(pid, pid), "draft": stored_sa.get(pid),
                                      "now": mapping.get(pid)})
    if not (added or removed or changed or split_changes):
        return None, exclusions
    return {
        "materialized_at": dv.materialized_at.isoformat() if dv.materialized_at else None,
        "counts": {"items_added": len(added), "items_removed": len(removed), "items_changed": len(changed),
                   "patients_changing_split": len(split_changes)},
        "items_added": added[:_DIFF_CAP], "items_removed": removed[:_DIFF_CAP], "items_changed": changed[:_DIFF_CAP],
        "splits_changed": split_changes[:_DIFF_CAP],
        "action": "Refresh the draft (POST /datasets/{id}/refresh), review it, then freeze.",
    }, exclusions


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
    return out


def freeze_check(db: Session, dv: DatasetVersion) -> dict:
    """Read-only preview of :func:`freeze`: blockers, warnings needing acknowledgement, informational items."""
    w = freeze_warnings(db, dv)
    rows = item_rows(db, dv)
    return {**w, "blockers": freeze_blockers(db, dv), "data_mode": data_mode(rows)["mode"],
            "acknowledgeable": list(ACKNOWLEDGEABLE_WARNINGS),
            "requires_acknowledgement": any(w[k] for k in ACKNOWLEDGEABLE_WARNINGS)}


def _family_freeze_check(db: Session, dv: DatasetVersion) -> None:
    assigned = {sa.coded_patient_id: sa.split for sa in db.scalars(
        select(SplitAssignment).where(SplitAssignment.dataset_version_id == dv.id)).all()}
    sealed = sealed_constraints(db, dv)
    moved = [{"patient_code": s["patient_code"], "sealed_split": s["split"], "split": assigned[pid],
              "split_family_id": s["family_id"]}
             for pid, s in sorted(sealed.items()) if pid in assigned and assigned[pid] != s["split"]]
    if moved:
        raise conflict("sealed_patient_moved", "Test patients sealed by a test release can never change split",
                       patients=moved)
    existing = family_assignments(db, lineage_family(db, dv.lineage_id))
    conflicts = [{"patient_code": a.patient_code, "family_split": a.split, "split": assigned[pid]}
                 for pid, a in sorted(existing.items()) if pid in assigned and assigned[pid] != a.split]
    if conflicts:
        raise conflict("family_split_locked", "These patients already hold another split in this lineage's split "
                       "family; child versions inherit them", patients=conflicts[:_DIFF_CAP])


def freeze(db: Session, actor: Actor, dv: DatasetVersion, reason: str | None = None,
           acknowledge_warnings: bool = False) -> DatasetVersion:
    if dv.status != "draft":
        raise conflict("dataset_frozen", "Already frozen")
    diff, exclusions = _draft_state(db, dv)
    if diff:
        raise conflict("draft_stale", "Eligibility, labels, lineage, provenance or the split allocation changed "
                       "since this draft was materialised. Refresh the draft, review it, then freeze.", diff=diff)
    dv.exclusions_json = exclusions  # same items; exclusions as of freeze time
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
    manifest = build_manifest(db, dv, now, actor.id, family=fam)
    if has_warnings:
        manifest["acknowledged_warnings"] = {**warnings, "reason": reason, "acknowledged_by": actor.id}
    existing = family_assignments(db, fam)
    for s in manifest["splits"]:
        if s["coded_patient_id"] not in existing:
            db.add(SplitFamilyAssignment(family_id=fam.id, coded_patient_id=s["coded_patient_id"],
                                         patient_code=s["patient_code"], split=s["split"], first_version_id=dv.id))
    digest = hashlib.sha256(canonical_json(manifest)).hexdigest()
    key = f"projects/{dv.project_id}/datasets/{dv.id}/manifest.json"
    get_store().put_bytes(key, json.dumps(manifest, indent=2, sort_keys=True).encode())
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
    return dv


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
    changed = []
    for r in rows:
        target = r["slide_id"] if r["label_scope"] == "slide" else r["case_id"]
        ref, status = reference_label(db, dv.project_id, r["label_scope"], target)
        if ref is None or ref.id != r["label_version_id"]:
            changed.append({"slide_id": r["slide_id"], "label_scope": r["label_scope"],
                            "dataset_label_version_id": r["label_version_id"], "dataset_value": r["label_value"],
                            "current_label_version_id": ref.id if ref else None,
                            "current_value": ref.value if ref else None, "current_status": status})
    return {
        "dataset_version_id": dv.id,
        "status": dv.status,
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


def audit(db: Session, dv: DatasetVersion) -> dict:
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
        "research_use_only": True,
    }


# --------------------------------------------------------------------------- export


CSV_FIELDS = ["slide_id", "slide_sha256", "label_version_id", "label_value", "label_scope", "split", "partition",
              "coded_patient_id", "patient_code", "case_id", "accession_code", "part", "block_id", "block",
              "level_index", "stain", "scanner_id", "site_id", "collected_on", "image_kind", "provenance",
              "mpp_x", "mpp_y"]


def export_csv(dv: DatasetVersion) -> str:
    buf = io.StringIO()
    buf.write(f"# dermpath dataset manifest {dv.id} v{dv.version}; manifest_sha256={dv.manifest_sha256}\n")
    buf.write("# Research use only. Coded identifiers only. Label 'bcc_absent_not_benign' is NOT 'benign'.\n")
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
