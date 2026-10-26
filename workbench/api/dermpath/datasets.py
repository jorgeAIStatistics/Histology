"""Dataset versions: drafts, eligibility, patient-grouped splits, freeze, test-set lock.

Guarantees
----------
* **Patient-grouped splits (mandatory).** Splits are assigned per coded patient; every
  slide of a patient lands in one split. Partitions: ``random`` (seeded, label-
  interleaved), ``temporal`` (by ``collected_on`` cutoffs; a patient goes by their LATEST
  case, so no later material leaks into an earlier split) and ``external_site`` (patients
  with any case at a listed site are test). :func:`assert_patient_grouping` re-checks.
* **Freeze.** A frozen version stores an immutable manifest (slide sha256s, label version
  ids, split assignments, config) and its SHA-256. The ORM/session guard in
  :mod:`dermpath.models` (and SQLite triggers) reject any mutation afterwards.
* **New version on change.** Labels changed after freeze never alter the frozen manifest;
  :func:`staleness` reports them and :func:`new_version` creates a child version
  (``parent_version_id``).
* **Test-set lock.** :func:`training_eligible_items` NEVER returns test items for the
  purposes ``train``, ``active_learning`` or ``threshold_selection``. Only
  ``test_evaluation`` reaches the test split, and only on a frozen version.
"""

from __future__ import annotations

import csv
import hashlib
import io
import json
import random
from collections import Counter, defaultdict
from datetime import date

from sqlalchemy import select
from sqlalchemy.orm import Session

from . import audit
from .auth import Actor
from .db import utcnow
from .errors import conflict, unprocessable
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
    Slide,
    SplitAssignment,
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
    PARTITIONS,
    PROVENANCES,
    PURPOSE_SPLITS,
    TEST_LOCKED_PURPOSES,
)

PIPELINE_TEST_NOTICE = "PIPELINE TEST — NOT PATHOLOGY VALIDATION (synthetic, procedural images; no histology)"
NEAR_DUPLICATE_MAX_DISTANCE = 6


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
        cfg["split"] = normalise_split(config["split"])
    return cfg


def normalise_split(split: dict) -> dict:
    partition = split.get("partition", "random")
    if partition not in PARTITIONS:
        raise unprocessable("invalid_partition", f"partition must be one of {list(PARTITIONS)}")
    ratios = split.get("ratios") or {"train": 0.6, "val": 0.2, "test": 0.2}
    try:
        r = {k: float(ratios.get(k, 0.0)) for k in ("train", "val", "test")}
    except (TypeError, ValueError) as exc:
        raise unprocessable("invalid_ratios", "ratios must be numbers") from exc
    if any(v < 0 for v in r.values()) or abs(sum(r.values()) - 1.0) > 1e-6:
        raise unprocessable("invalid_ratios", "ratios must be non-negative and sum to 1")
    out = {"partition": partition, "seed": int(split.get("seed", 0)), "ratios": r}
    if partition == "temporal":
        try:
            test_cut = date.fromisoformat(split["test_cutoff"])
            val_cut = date.fromisoformat(split["val_cutoff"]) if split.get("val_cutoff") else None
        except (KeyError, ValueError, TypeError) as exc:
            raise unprocessable("invalid_cutoff", "temporal partitions need test_cutoff (and optional val_cutoff) as YYYY-MM-DD") from exc
        if val_cut and val_cut > test_cut:
            raise unprocessable("invalid_cutoff", "val_cutoff must be on or before test_cutoff")
        out["test_cutoff"] = test_cut.isoformat()
        out["val_cutoff"] = val_cut.isoformat() if val_cut else None
    if partition == "external_site":
        sites = split.get("test_sites") or []
        if not sites or not all(isinstance(s, str) for s in sites):
            raise unprocessable("invalid_test_sites", "external_site partitions need test_sites: [site ids]")
        out["test_sites"] = sorted(set(sites))
    return out


# --------------------------------------------------------------------------- eligibility


def _reason(code: str, detail: str | None = None) -> dict:
    return {"code": code, "detail": detail} if detail else {"code": code}


def slide_eligibility(db: Session, slide: Slide, cfg: dict) -> tuple[bool, list[dict], object | None, dict]:
    """Return ``(eligible, reasons, reference_label_version, lineage)`` for one slide."""
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
                                                QCIssue.dataset_eligibility_effect == "exclude_slide")).all()
    for iid in qc_ex:
        reasons.append(_reason("qc_excluded", f"QC issue {iid} resolved with exclude_slide"))
    lineage = slide_lineage(db, slide)
    ref = None
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
    return (not reasons), reasons, ref, lineage


def materialize(db: Session, dv: DatasetVersion) -> dict:
    if dv.status != "draft":
        raise conflict("dataset_frozen", "Frozen dataset versions never change; create a new version")
    cfg = dv.config_json
    for it in db.scalars(select(DatasetItem).where(DatasetItem.dataset_version_id == dv.id)).all():
        db.delete(it)
    for sa in db.scalars(select(SplitAssignment).where(SplitAssignment.dataset_version_id == dv.id)).all():
        db.delete(sa)
    db.flush()
    slides = db.scalars(select(Slide).where(Slide.project_id == dv.project_id).order_by(Slide.id)).all()
    exclusions = []
    n = 0
    for s in slides:
        ok, reasons, ref, lineage = slide_eligibility(db, s, cfg)
        if not ok:
            exclusions.append({"slide_id": s.id, "patient_code": lineage.get("patient_code"),
                               "accession_code": lineage.get("accession_code"), "reasons": reasons})
            continue
        db.add(DatasetItem(dataset_version_id=dv.id, slide_id=s.id, slide_sha256=s.sha256,
                           label_version_id=ref.id, label_value=ref.value, label_scope=cfg["label_scope"],
                           case_id=lineage["case_id"], coded_patient_id=lineage["coded_patient_id"]))
        n += 1
    dv.exclusions_json = exclusions
    dv.materialized_at = utcnow()
    db.flush()
    split_result = None
    if cfg.get("split"):
        split_result = assign_splits(db, dv, cfg["split"])
    return {"items": n, "excluded": len(exclusions), "split": split_result}


# --------------------------------------------------------------------------- splits


def _patient_infos(db: Session, dv: DatasetVersion) -> list[dict]:
    items = db.scalars(select(DatasetItem).where(DatasetItem.dataset_version_id == dv.id)).all()
    by_patient: dict[str, dict] = {}
    for it in items:
        p = by_patient.setdefault(it.coded_patient_id, {"id": it.coded_patient_id, "labels": [], "dates": [],
                                                         "sites": set(), "slides": 0})
        p["labels"].append(it.label_value)
        p["slides"] += 1
        case = db.get(Case, it.case_id)
        if case.collected_on:
            p["dates"].append(case.collected_on)
        else:
            p.setdefault("missing_date_cases", set()).add(case.id)
        if case.site_id:
            p["sites"].add(case.site_id)
    for p in by_patient.values():
        p["label"] = Counter(p["labels"]).most_common(1)[0][0]
    return sorted(by_patient.values(), key=lambda p: p["id"])


def _positional(ids: list[str], ratios: dict[str, float], order=("train", "val", "test")) -> dict[str, str]:
    n = len(ids)
    out = {}
    bounds = []
    acc = 0.0
    for k in order:
        acc += ratios.get(k, 0.0)
        bounds.append((acc, k))
    for i, pid in enumerate(ids):
        pos = (i + 0.5) / n
        for b, k in bounds:
            if pos <= b + 1e-12:
                out[pid] = k
                break
        else:
            out[pid] = order[-1]
    return out


def compute_splits(patients: list[dict], split: dict) -> tuple[dict[str, str], dict]:
    """Pure function: patient infos + split config → ``{patient_id: split}`` and diagnostics.

    ``patients``: dicts with ``id``, ``label``, ``dates`` (list of date), ``sites`` (set).
    """
    partition = split["partition"]
    rng = random.Random(split.get("seed", 0))
    diag: dict = {"partition": partition}
    if partition == "random":
        strata: dict[str, list[str]] = defaultdict(list)
        for p in sorted(patients, key=lambda p: p["id"]):
            strata[p["label"]].append(p["id"])
        for key in sorted(strata):
            rng.shuffle(strata[key])
        # Interleave strata so each split gets a similar label mix, then assign by position.
        order: list[str] = []
        queues = [list(strata[k]) for k in sorted(strata)]
        while any(queues):
            for q in queues:
                if q:
                    order.append(q.pop(0))
        mapping = _positional(order, split["ratios"])
    elif partition == "temporal":
        test_cut = date.fromisoformat(split["test_cutoff"])
        val_cut = date.fromisoformat(split["val_cutoff"]) if split.get("val_cutoff") else None
        missing = [p["id"] for p in patients if not p["dates"] or p.get("missing_date_cases")]
        if missing:
            raise unprocessable("missing_collected_on",
                                "Temporal partitions need collected_on for every case of every included patient",
                                patients=missing)
        mapping = {}
        spanning = 0
        for p in patients:
            latest, earliest = max(p["dates"]), min(p["dates"])
            if latest >= test_cut:
                mapping[p["id"]] = "test"
                spanning += earliest < test_cut
            elif val_cut and latest >= val_cut:
                mapping[p["id"]] = "val"
                spanning += earliest < val_cut
            else:
                mapping[p["id"]] = "train"
        diag["patients_spanning_a_cutoff"] = spanning
        diag["rule"] = "a patient is assigned by their LATEST case date (later material never trains)"
    elif partition == "external_site":
        test_sites = set(split["test_sites"])
        mapping = {}
        rest = []
        mixed = 0
        for p in sorted(patients, key=lambda p: p["id"]):
            if p["sites"] & test_sites:
                mapping[p["id"]] = "test"
                mixed += bool(p["sites"] - test_sites)
            else:
                rest.append(p["id"])
        rng.shuffle(rest)
        r = split["ratios"]
        tv = r["train"] + r["val"]
        sub = {"train": r["train"] / tv, "val": r["val"] / tv} if tv > 0 else {"train": 1.0, "val": 0.0}
        mapping.update(_positional(rest, sub, order=("train", "val")))
        diag["patients_with_cases_at_test_and_other_sites"] = mixed
        diag["rule"] = "a patient with ANY case at a test site is entirely test"
    else:  # pragma: no cover - validated earlier
        raise ValueError(partition)
    counts = Counter(mapping.values())
    diag["patients_per_split"] = {k: counts.get(k, 0) for k in ("train", "val", "test")}
    return mapping, diag


def assert_patient_grouping(items: list[dict]) -> None:
    """Every coded patient appears in exactly one split (items carry coded_patient_id and split)."""
    seen: dict[str, str] = {}
    for it in items:
        pid, sp = it["coded_patient_id"], it.get("split")
        if sp is None:
            raise AssertionError(f"item for patient {pid} has no split")
        if seen.setdefault(pid, sp) != sp:
            raise AssertionError(f"patient {pid} appears in splits {seen[pid]} and {sp}")


def assign_splits(db: Session, dv: DatasetVersion, split: dict) -> dict:
    if dv.status != "draft":
        raise conflict("dataset_frozen", "Frozen dataset versions never change; create a new version")
    split = normalise_split(split)
    for sa in db.scalars(select(SplitAssignment).where(SplitAssignment.dataset_version_id == dv.id)).all():
        db.delete(sa)
    db.flush()
    patients = _patient_infos(db, dv)
    mapping, diag = compute_splits(patients, split)
    for pid, sp in sorted(mapping.items()):
        db.add(SplitAssignment(dataset_version_id=dv.id, coded_patient_id=pid, split=sp, partition=split["partition"]))
    dv.config_json = {**dv.config_json, "split": split}
    db.flush()
    items = [{"coded_patient_id": it.coded_patient_id, "split": mapping.get(it.coded_patient_id)}
             for it in db.scalars(select(DatasetItem).where(DatasetItem.dataset_version_id == dv.id)).all()]
    assert_patient_grouping(items)
    return diag


def item_rows(db: Session, dv: DatasetVersion) -> list[dict]:
    """Items with split and lineage (from the manifest when frozen)."""
    if dv.status == "frozen" and dv.manifest_json:
        return list(dv.manifest_json["items"])
    splits = {sa.coded_patient_id: sa for sa in db.scalars(
        select(SplitAssignment).where(SplitAssignment.dataset_version_id == dv.id)).all()}
    rows = []
    for it in db.scalars(select(DatasetItem).where(DatasetItem.dataset_version_id == dv.id)
                         .order_by(DatasetItem.slide_id)).all():
        s = db.get(Slide, it.slide_id)
        lin = slide_lineage(db, s)
        sa = splits.get(it.coded_patient_id)
        rows.append({
            "slide_id": it.slide_id, "slide_sha256": it.slide_sha256, "label_version_id": it.label_version_id,
            "label_value": it.label_value, "label_scope": it.label_scope, "case_id": it.case_id,
            "coded_patient_id": it.coded_patient_id, "patient_code": lin["patient_code"],
            "accession_code": lin["accession_code"], "part": lin["part"], "block_id": lin["block_id"],
            "block": lin["block"], "level_index": s.level_index, "stain": s.stain, "scanner_id": s.scanner_id,
            "site_id": lin["site_id"], "collected_on": lin["collected_on"], "image_kind": s.image_kind,
            "provenance": s.provenance, "mpp_x": s.mpp_x, "mpp_y": s.mpp_y,
            "split": sa.split if sa else None, "partition": sa.partition if sa else None,
        })
    return rows


# --------------------------------------------------------------------------- create / freeze / version


def create_draft(db: Session, actor: Actor, project: Project, *, name: str, config: dict,
                 parent: DatasetVersion | None = None, reason: str | None = None) -> DatasetVersion:
    cfg = normalise_config(project, config) if parent is None else json.loads(json.dumps(parent.config_json))
    if parent is not None:
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
    audit.record_for(db, actor, project_id=project.id, action="dataset.draft_created", entity_type="dataset_version",
                     entity_id=dv.id, after={"name": name, "version": version, "parent_version_id": dv.parent_version_id,
                                             "items": result["items"], "excluded": result["excluded"],
                                             "label_scope": cfg["label_scope"]}, reason=reason)
    return dv


def canonical_json(obj) -> bytes:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode()


def build_manifest(db: Session, dv: DatasetVersion, frozen_at, frozen_by: str) -> dict:
    rows = item_rows(db, dv)
    splits = []
    for sa in db.scalars(select(SplitAssignment).where(SplitAssignment.dataset_version_id == dv.id)
                         .order_by(SplitAssignment.coded_patient_id)).all():
        p = db.get(CodedPatient, sa.coded_patient_id)
        splits.append({"coded_patient_id": sa.coded_patient_id, "patient_code": p.code, "split": sa.split,
                       "partition": sa.partition})
    prov = Counter(r["provenance"] for r in rows)
    synthetic_only = bool(rows) and set(prov) == {"demo_synthetic"}
    return {
        "schema": "dermpath.dataset_manifest/1",
        "dataset_version_id": dv.id,
        "lineage_id": dv.lineage_id,
        "name": dv.name,
        "version": dv.version,
        "parent_version_id": dv.parent_version_id,
        "project_id": dv.project_id,
        "config": dv.config_json,
        "created_by": dv.created_by,
        "frozen_at": frozen_at.isoformat(),
        "frozen_by": frozen_by,
        "counts": {
            "patients": len({r["coded_patient_id"] for r in rows}),
            "cases": len({r["case_id"] for r in rows}),
            "blocks": len({r["block_id"] for r in rows}),
            "slides": len(rows),
        },
        "provenance_mix": dict(sorted(prov.items())),
        "synthetic_only": synthetic_only,
        "notice": PIPELINE_TEST_NOTICE if synthetic_only else None,
        "label_display": {v: LABEL_DISPLAY[v] for v in dv.config_json["label_values"]},
        "items": rows,
        "splits": splits,
        "exclusions": dv.exclusions_json,
        "research_use_only": True,
    }


def freeze(db: Session, actor: Actor, dv: DatasetVersion, reason: str | None = None) -> DatasetVersion:
    if dv.status != "draft":
        raise conflict("dataset_frozen", "Already frozen")
    rows = item_rows(db, dv)
    if not rows:
        raise conflict("empty_dataset", "Cannot freeze a dataset version with no eligible items")
    missing = sorted({r["coded_patient_id"] for r in rows if r["split"] is None})
    if missing:
        raise conflict("splits_missing", "Assign patient-grouped splits before freezing (POST /datasets/{id}/splits)",
                       patients_without_split=missing)
    assert_patient_grouping(rows)
    now = utcnow()
    manifest = build_manifest(db, dv, now, actor.id)
    digest = hashlib.sha256(canonical_json(manifest)).hexdigest()
    key = f"projects/{dv.project_id}/datasets/{dv.id}/manifest.json"
    get_store().put_bytes(key, json.dumps(manifest, indent=2, sort_keys=True).encode())
    dv.manifest_json = manifest
    dv.manifest_sha256 = digest
    dv.manifest_object_key = key
    dv.frozen_at = now
    dv.frozen_by = actor.id
    dv.status = "frozen"
    audit.record_for(db, actor, project_id=dv.project_id, action="dataset.frozen", entity_type="dataset_version",
                     entity_id=dv.id, before={"status": "draft"},
                     after={"status": "frozen", "manifest_sha256": digest, "items": len(rows)}, reason=reason)
    db.flush()
    return dv


def verify_manifest(dv: DatasetVersion) -> bool | None:
    if dv.status != "frozen" or not dv.manifest_json:
        return None
    return hashlib.sha256(canonical_json(dv.manifest_json)).hexdigest() == dv.manifest_sha256


def new_version(db: Session, actor: Actor, parent: DatasetVersion, *, reason: str, name: str | None = None) -> DatasetVersion:
    if parent.status != "frozen":
        raise conflict("parent_not_frozen", "Only frozen versions get child versions; refresh the draft instead")
    if not reason or not reason.strip():
        raise unprocessable("reason_required", "A new dataset version needs a reason (e.g. a label changed after freeze)")
    project = db.get(Project, parent.project_id)
    return create_draft(db, actor, project, name=name or parent.name, config={}, parent=parent, reason=reason)


def refresh(db: Session, actor: Actor, dv: DatasetVersion) -> dict:
    result = materialize(db, dv)
    audit.record_for(db, actor, project_id=dv.project_id, action="dataset.refreshed", entity_type="dataset_version",
                     entity_id=dv.id, after={"items": result["items"], "excluded": result["excluded"]})
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

    per_split = {}
    for sp in ("train", "val", "test"):
        sr = [r for r in rows if r.get("split") == sp]
        per_split[sp] = {"patients": len({r["coded_patient_id"] for r in sr}), "slides": len(sr),
                         "label_balance": dict(Counter(r["label_value"] for r in sr))}
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
    slides = {s.id: s for s in db.scalars(select(Slide).where(Slide.id.in_([r["slide_id"] for r in rows]))).all()}
    by_id = {r["slide_id"]: r for r in rows}
    decisions = {}
    for nd in db.scalars(select(NearDuplicateReview).where(NearDuplicateReview.project_id == dv.project_id)
                         .order_by(NearDuplicateReview.created_at)).all():
        decisions[tuple(sorted((nd.slide_a_id, nd.slide_b_id)))] = {"decision": nd.decision, "reason": nd.reason,
                                                                    "reviewer_id": nd.reviewer_id}
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
                near.append({"slide_a": a.id, "slide_b": b.id, "dhash_distance": d,
                             "same_patient": ra["coded_patient_id"] == rb["coded_patient_id"],
                             "cross_split": (ra.get("split") is not None and ra.get("split") != rb.get("split")),
                             "status": "candidate_for_human_review",
                             "human_decision": decisions.get(tuple(sorted((a.id, b.id))))})
    scope = cfg["label_scope"]
    project_targets = (list(db.scalars(select(Slide.id).where(Slide.project_id == dv.project_id)))
                       if scope == "slide" else
                       list(db.scalars(select(Case.id).where(Case.project_id == dv.project_id))))
    qc_warnings = []
    for r in rows:
        open_issues = db.scalars(select(QCIssue).where(QCIssue.slide_id == r["slide_id"],
                                                       QCIssue.status != "resolved")).all()
        if open_issues:
            qc_warnings.append({"slide_id": r["slide_id"],
                                "open_issues": [{"id": i.id, "category": i.category, "is_suggestion": i.is_suggestion}
                                                for i in open_issues]})
    prov = Counter(r["provenance"] for r in rows)
    synthetic_only = bool(rows) and set(prov) == {"demo_synthetic"}
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
                   "per_split": per_split, "unassigned_slide_ids": unassigned},
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
            "near_duplicate_method": f"thumbnail dHash (64-bit), Hamming distance <= {NEAR_DUPLICATE_MAX_DISTANCE}",
            "near_duplicate_note": "Candidates for HUMAN review only; nothing is removed automatically.",
        },
        "qc_warnings": qc_warnings,
        "provenance_mix": dict(sorted(prov.items())),
        "synthetic_only": synthetic_only,
        "notice": PIPELINE_TEST_NOTICE if synthetic_only else None,
        "workflow_metadata_note": "Counts describe workflow metadata, not experiment results.",
    }
    if dv.status == "frozen":
        out["manifest_sha256"] = dv.manifest_sha256
        out["manifest_verified"] = verify_manifest(dv)
    return out


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

