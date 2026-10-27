"""Evaluation bodies, test releases, comparison families, errors and attention (design §7).

Evaluation bodies
-----------------
:func:`build_evaluation` turns STORED prediction rows of one split into the evaluation body
(schema ``dermpath.evaluation/2``) with :func:`dermpath.ml.metrics.evaluate_binary` at the frozen
operating point: sensitivity, specificity, PPV and NPV with numerator, denominator and a
patient-cluster bootstrap CI; tie-correct AUROC/AUPRC with the AUPRC prevalence baseline; PPV/NPV
with the evaluation prevalence stated (and prevalence-adjusted when ``params.target_prevalence``
is declared); Brier, ECE and calibration curves (raw, and calibrated when the run froze a
calibration); unscorable bags counted (scored-only and intention-to-evaluate); risk–coverage
with AURC and selective risk per class (confidence is not an out-of-distribution detector);
subgroups by scanner/site/stain with ``min_n`` counted in PATIENTS; the failure taxonomy with
counts and per-error categories. Threshold-dependent metrics on the split the threshold was
chosen on are flagged ``tuning_set`` (optimistic).

Test releases
-------------
Test metrics exist only through :func:`create_test_release` (``POST /experiments/{id}/test-release``,
research lead, reason required, candidate declared: the run's registered inference bundle or a
LOCKED comparison family containing it). The release row is numbered per manifest (dataset
version); a second or later release needs a justification. The test patients of the split family
are sealed in the same transaction. The ``evaluate_test_release`` job scores the test bags ONLY
from the run's pinned feature-set artifacts (:func:`dermpath.ml.feature_sets.load_slide_features`)
with :func:`dermpath.ml.training.score_bags_with_checkpoint`: nothing is re-extracted, and a
missing or corrupt artifact, or a weights/spec/policy sha that differs from the pins, fails the
job permanently. ``GET …/evaluation?split=test`` and ``…/errors?split=test`` only read stored
results (409 ``test_release_required`` otherwise).

Wording rule: the negative class (for example ``bcc_absent_not_benign``) is rendered with its own
display text and is never called "benign".
"""

from __future__ import annotations

import math

import numpy as np
from sqlalchemy import or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, object_session

from .. import audit
from ..datasets import IMPORTED_REFERENCE_NOTICE, seal_test_patients, training_eligible_items
from ..db import session_scope
from ..errors import conflict, not_found, unprocessable
from ..jobs import queue
from ..jobs.registry import PermanentJobError, register
from ..models import (
    AnnotationVersion,
    DatasetVersion,
    Disagreement,
    ImmutableRecordError,
    Job,
    QCIssue,
    Slide,
)
from ..vocab import LABEL_DISPLAY
from . import ATTENTION_NOTICE, PIPELINE_TEST_BANNER, RESEARCH_NOTICE, SCORE_NOTE
from . import metrics as M
from .calibration import CALIBRATION_SCHEMA, apply_calibration
from .comparison import ComparisonRefused, ScoreSet, paired_comparison
from .engine_models import ComparisonFamily, ComparisonFamilyMember, FeatureSet, InferenceBundle, TestRelease
from .failure import failure_taxonomy
from .heads import Bag
from .models import Evaluation, Prediction, TrainingRun

EVALUATION_SCHEMA = "dermpath.evaluation/2"
SMALL_SAMPLE_ITEMS = 30
ATTR_KEYS = ("scanner_id", "site_id", "stain", "stain_batch")
DEVELOPMENT_SPLITS = ("val", "oof")
EVALUATION_SPLITS = ("val", "oof", "test")
TEST_RELEASE_JOB = "evaluate_test_release"
SCORE_CHUNK = 16  # bags scored per call: bounded memory, one chunk of embeddings at a time
NEGATIVE_NOTE = ("'{neg}' means only that '{pos}' was not identified in the reference standard; it is never "
                 "rendered as benign and is not a diagnosis of anything else.")
TEST_RELEASE_NOTE = ("Test metrics come only from recorded test releases: research lead, stated reason, declared "
                     "candidate, numbered per manifest, scored from pinned feature-set artifacts (no "
                     "re-extraction). Every further release on the same manifest weakens the independence of the "
                     "test split and is counted.")
FAMILY_NOTE = ("Paired comparisons are computed from stored development predictions (validation or out-of-fold) "
               "with the family's shared bootstrap seed; they are the only basis for selection. Test comparisons "
               "appear only after a test release of the whole locked family.")


# =========================================================================== helpers


def banner(run: TrainingRun) -> str | None:
    return PIPELINE_TEST_BANNER if run.synthetic else None


def _session(obj) -> Session | None:
    try:
        return object_session(obj)
    except Exception:  # pragma: no cover - transient/detached objects
        return None


def threshold_dict(run: TrainingRun) -> dict | None:
    if run.threshold_frozen_at is None:
        return None
    t = run.threshold_json or {}
    return {"value": run.threshold_value, "selected_on": t.get("selected_on") or "val", "rule": run.threshold_rule,
            "frozen_at": run.threshold_frozen_at.isoformat(), "selection_status": t.get("selection_status"),
            "reason": t.get("reason"), "requested_rule": t.get("requested_rule"),
            "val_sensitivity_at_threshold": t.get("val_sensitivity_at_threshold"),
            "val_specificity_at_threshold": t.get("val_specificity_at_threshold"),
            "at_threshold": t.get("at_threshold"), "evidence": t.get("evidence"),
            "tuning_set_note": t.get("tuning_set_note"),
            "comparison": "positive if score >= value"}


def class_info(run: TrainingRun) -> dict:
    pos, neg = run.positive_class, run.negative_class
    return {"positive": {"value": pos, "display": LABEL_DISPLAY.get(pos, pos)},
            "negative": {"value": neg, "display": LABEL_DISPLAY.get(neg, neg),
                         "note": NEGATIVE_NOTE.format(neg=neg, pos=pos)}}


def _selected_on(run: TrainingRun) -> str:
    t = run.threshold_json or {}
    if t.get("selected_on"):
        return str(t["selected_on"])
    return "oof" if run.evaluation_protocol == "dev_cv" else "val"


def _threshold_tuned_on(run: TrainingRun, split: str) -> bool:
    """True when the operating threshold was CHOSEN from these data (threshold-dependent metrics are optimistic)."""
    status = (run.threshold_json or {}).get("selection_status")
    return split == _selected_on(run) and status in (None, "selected")


def _boot_seed(db: Session | None, run: TrainingRun) -> tuple[int, str]:
    if run.family_id and db is not None:
        fam = db.get(ComparisonFamily, run.family_id)
        if fam is not None:
            return int(fam.bootstrap_seed), "comparison family bootstrap seed (shared by its runs)"
    return int(run.seed), "run seed"


def _manifest(db: Session | None, run: TrainingRun) -> dict | None:
    if db is None:
        return None
    dv = db.get(DatasetVersion, run.dataset_version_id)
    return dv.manifest_json if dv is not None else None


def _bag_index(manifest: dict | None, label_scope: str) -> dict[str, dict]:
    out: dict[str, dict] = {}
    for it in (manifest or {}).get("items", []):
        key = it["slide_id"] if label_scope == "slide" else it.get("case_id")
        e = out.setdefault(key, {"label_value": it.get("label_value"), "coded_patient_id": it.get("coded_patient_id"),
                                 "patient_code": it.get("patient_code"), "split": it.get("split"), "slide_ids": []})
        e["slide_ids"].append(it["slide_id"])
    return out


def _unscorable(run: TrainingRun, split: str, unscored: list | None, manifest: dict | None) -> tuple[list, list, list, int]:
    """Labels and patients of the unscorable bags of ``split`` (from the entries, else the frozen manifest)."""
    index = None
    ys, ps, rows, unresolved = [], [], [], 0
    for u in unscored or []:
        u = dict(u)
        if u.get("split") not in (None, split):
            continue
        label, pid = u.get("label"), u.get("coded_patient_id") or u.get("patient_id")
        value = u.get("label_value")
        if label is None and value is not None:
            label = 1 if value == run.positive_class else 0
        if label is None or pid is None:
            if index is None:
                index = _bag_index(manifest, run.label_scope)
            e = index.get(u.get("bag_id"))
            if e is not None:
                value = value or e["label_value"]
                label = (1 if value == run.positive_class else 0) if label is None else label
                pid = pid or e["coded_patient_id"]
                u.setdefault("patient_code", e["patient_code"])
        if label in (0, 1) and pid:
            ys.append(int(label))
            ps.append(pid)
            u.update({"label_value": value, "coded_patient_id": pid})
        else:
            unresolved += 1
        u.pop("label", None)  # bodies show class values, never 0/1 codes without their meaning
        rows.append(u)
    return ys, ps, rows, unresolved


def _calibration(run: TrainingRun) -> dict | None:
    cal = run.calibration_json
    if isinstance(cal, dict) and cal.get("schema") == CALIBRATION_SCHEMA:
        return cal
    return None


def _abstention(run: TrainingRun) -> dict | None:
    pol = run.abstention_json
    if isinstance(pol, dict) and pol.get("schema") == M.ABSTENTION_SCHEMA and pol.get("frozen"):
        return pol
    return None


def _clean_attr(v):
    return None if v in (None, "", "mixed", "unknown") else v


# --------------------------------------------------------------------------- failure contexts


def _ring_area(ring) -> float:
    pts = np.asarray(ring, dtype=np.float64)
    if pts.ndim != 2 or pts.shape[0] < 3:
        return 0.0
    x, y = pts[:, 0], pts[:, 1]
    return float(abs(np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1))) / 2.0)


def lesion_areas_um2(db: Session, project_id: str, slide_ids: list[str], positive_class: str,
                     mpp: dict[str, tuple] | None = None) -> dict[str, float]:
    """Area (µm²) of EXPERT-labelled lesion outlines per slide: current annotations whose region-scope
    reference label is ``positive_class``. Slides without such an outline, or without a physical scale, are
    absent (not assessable). Never derived from the model or from attention."""
    from ..labels import reference_label

    if not slide_ids:
        return {}
    rows = db.scalars(select(AnnotationVersion).where(AnnotationVersion.project_id == project_id,
                                                      AnnotationVersion.slide_id.in_(slide_ids))).all()
    newest: dict[str, AnnotationVersion] = {}
    for r in rows:
        if r.annotation_id not in newest or r.version > newest[r.annotation_id].version:
            newest[r.annotation_id] = r
    out: dict[str, float] = {}
    for ann in newest.values():
        if ann.deleted:
            continue
        ref, status = reference_label(db, project_id, "region", ann.annotation_id)
        if ref is None or ref.value != positive_class:
            continue
        mx, my = (mpp or {}).get(ann.slide_id, (None, None))
        if mx is None or my is None:
            s = db.get(Slide, ann.slide_id)
            mx, my = (s.mpp_x, s.mpp_y) if s is not None else (None, None)
        if not mx or not my:
            continue
        rings = (ann.geometry_json or {}).get("coordinates") or []
        if not rings:
            continue
        out[ann.slide_id] = out.get(ann.slide_id, 0.0) + _ring_area(rings[0]) * float(mx) * float(my)
    return out


def failure_contexts(db: Session | None, run: TrainingRun, preds: list, manifest: dict | None) -> tuple[dict, dict | None]:
    """``(contexts by bag_id, train_domain)`` for :func:`dermpath.ml.failure.failure_taxonomy`.

    QC issues come from the snapshot taken at prediction time; reader disagreement is any disagreement on
    record for the bag's slide or case target; lesion areas only from expert-labelled outlines; the training
    domain (scanners, sites) from the frozen manifest (train split; the development pool under dev_cv)."""
    contexts: dict[str, dict] = {}
    slide_ids = sorted({s for p in preds for s in (p.slide_ids_json or [])})
    case_ids = sorted({p.case_id for p in preds if p.case_id})
    disputed: set[str] = set()
    areas: dict[str, float] = {}
    if db is not None and preds:
        conds = [Disagreement.slide_id.in_(slide_ids), Disagreement.target_id.in_(slide_ids)]
        if case_ids:
            conds += [Disagreement.case_id.in_(case_ids), Disagreement.target_id.in_(case_ids)]
        for d in db.scalars(select(Disagreement).where(Disagreement.project_id == run.project_id, or_(*conds))).all():
            disputed.update(x for x in (d.slide_id, d.case_id, d.target_id) if x)
        mpp = {it["slide_id"]: (it.get("mpp_x"), it.get("mpp_y")) for it in (manifest or {}).get("items", [])}
        areas = lesion_areas_um2(db, run.project_id, slide_ids, run.positive_class, mpp)
    for p in preds:
        attrs = p.attributes_json or {}
        qc = attrs.get("qc_context") or {}
        sids = list(p.slide_ids_json or [])
        known = [areas[s] for s in sids if s in areas]
        contexts[p.bag_id] = {
            "qc_issues": list(qc.get("qc_issues") or []),
            "reader_disagreement": bool(set(sids) & disputed or (p.case_id and p.case_id in disputed)),
            "scanner_id": _clean_attr(attrs.get("scanner_id")),
            "site_id": _clean_attr(attrs.get("site_id")),
            "lesion_area_um2": float(sum(known)) if known else None,
            "negative_category": None,  # the label vocabulary carries no category for the negative class
        }
    train_domain = None
    if manifest:
        dev = ("train", "val") if run.evaluation_protocol == "dev_cv" else ("train",)
        rows = [it for it in manifest.get("items", []) if it.get("split") in dev]
        train_domain = {"scanner_ids": sorted({r["scanner_id"] for r in rows if r.get("scanner_id")}),
                        "site_ids": sorted({r["site_id"] for r in rows if r.get("site_id")}),
                        "splits": list(dev)}
    return contexts, train_domain


def qc_context(db: Session, slide_ids: list[str]) -> dict:
    """QC/calibration facts at prediction time (possible failure factors; never causes)."""
    issues = db.scalars(select(QCIssue).where(QCIssue.slide_id.in_(slide_ids))).all()
    open_or_confirmed = sorted({f"{i.category} ({i.status})" for i in issues if not i.overridden})
    uncalibrated = [s.id for s in db.scalars(select(Slide).where(Slide.id.in_(slide_ids))).all()
                    if s.image_kind == "wsi" and (s.mpp_x is None or s.mpp_y is None)]
    return {"qc_issues": open_or_confirmed, "uncalibrated_slides": sorted(uncalibrated)}


# =========================================================================== evaluation body


def build_evaluation(run: TrainingRun, split: str, preds: list, unscored: list | None = None, *,
                     manifest: dict | None = None, release: TestRelease | None = None,
                     db: Session | None = None) -> dict:
    """The evaluation body of ``split`` from its prediction rows (persisted or about to be).

    ``unscored``: bags that could not be scored (``{bag_id, reason, split?, label_value?,
    coded_patient_id?}``); labels and patients missing from an entry are read from the frozen manifest.
    The run's frozen threshold, calibration and abstention policy are applied as stored."""
    db = db or _session(run)
    manifest = manifest if manifest is not None else _manifest(db, run)
    params = run.params_json or {}
    if run.threshold_value is None:
        raise ValueError("no frozen operating threshold: an evaluation needs the run's frozen threshold")
    t = float(run.threshold_value)
    preds = sorted(preds, key=lambda p: p.bag_id)
    y = np.array([int(p.label) for p in preds], dtype=np.int64)
    s = np.array([float(p.score) for p in preds], dtype=np.float64)
    patients = [p.coded_patient_id for p in preds]
    n_boot = int(params.get("n_boot", 1000))
    min_patients = int(params.get("boot_min_patients", 10))
    seed, seed_source = _boot_seed(db, run)
    tuning = _threshold_tuned_on(run, split)
    warnings: list[str] = []

    uy, up, unscored_rows, unresolved = _unscorable(run, split, unscored, manifest)
    if unresolved:
        warnings.append(f"{unresolved} unscorable bag(s) could not be matched to a reference label; they are listed "
                        "under 'unscored' but not counted in the intention-to-evaluate metrics")

    cal = _calibration(run)
    calibrated, cal_meta = None, None
    if cal is not None:
        fitted = cal.get("fitted_on") or {}
        cal_meta = {"method": cal.get("method"), "params_sha256": cal.get("params_sha256"),
                    "fitted_on": fitted, "applied": False,
                    "in_sample": split in (fitted.get("splits") or [])}
        if cal.get("method") not in (None, "none") and s.size:
            try:
                calibrated = apply_calibration(cal, s)
                cal_meta["applied"] = True
            except (ValueError, KeyError) as exc:
                warnings.append(f"the frozen calibration could not be applied ({exc}); only raw calibration is shown")
    core = M.evaluate_binary(y, s, patients, threshold=t, unscorable_y=uy, unscorable_patients=up,
                             target_prevalence=params.get("target_prevalence"), calibrated_scores=calibrated,
                             n_boot=n_boot, seed=seed, min_patients=min_patients, tuning_set=tuning)
    raw = core["calibration"]["raw"]
    eq = raw.get("equal_width") if isinstance(raw, dict) else None
    calibration = {
        # Top-level bins/brier/ece/note mirror the raw equal-width report (kept for existing readers).
        "bins": (eq or {}).get("bins", []), "brier": (eq or {}).get("brier"), "ece": (eq or {}).get("ece"),
        "note": SCORE_NOTE, "raw": raw, "calibrated": core["calibration"]["calibrated"], "frozen_calibration": cal_meta,
    }
    if cal_meta and cal_meta.get("in_sample") and cal_meta.get("applied"):
        calibration["calibrated_note"] = "in-sample: the calibration map was fitted on these data"

    try:
        risk = M.risk_coverage_curve(y, s, t)
    except ValueError as exc:  # scores or threshold outside [0, 1]
        risk = {"rows": [], "aurc": None, "undefined_reason": f"not applicable: {exc}", "note": M.ABSTENTION_NOTE}
    coverage_curve = [{"coverage": r["coverage"], "error_rate": r["selective_risk"], "n_kept": r["n_kept"],
                       "abstained": r["n_abstained"]} for r in risk.get("rows", [])]

    policy = _abstention(run)
    abstention = {"policy": None, "selective": None, "note": M.ABSTENTION_NOTE}
    if policy is not None:
        abstention["policy"] = {k: policy.get(k) for k in ("kind", "lower", "upper", "margin", "selection_status",
                                                           "selected_on", "target_coverage", "max_risk",
                                                           "policy_sha256", "reason")}
        abstention["selected_on_this_split"] = policy.get("selected_on") in (split, "development") and split != "test"
        if not math.isclose(float(policy.get("threshold", t)), t, rel_tol=0, abs_tol=1e-12):
            warnings.append("the frozen abstention policy refers to another threshold; it was not applied")
        elif s.size:
            try:
                abstention["selective"] = M.selective_evaluation(y, s, policy, patients=patients, n_boot=n_boot,
                                                                 seed=seed, min_patients=min_patients)
            except ValueError as exc:
                warnings.append(f"the frozen abstention policy failed verification ({exc}); it was not applied")

    attrs = [{k: (p.attributes_json or {}).get(k) for k in ATTR_KEYS if k in (p.attributes_json or {})}
             for p in preds]
    try:
        subgroups = M.subgroup_analysis(y, s, patients, attrs, threshold=t,
                                        min_patients=int(params.get("subgroup_min_n", 10)), n_boot=n_boot, seed=seed)
    except ValueError as exc:  # analytics never fail the job that stores the evaluation
        subgroups = {"count_unit": "patients", "min_patients": int(params.get("subgroup_min_n", 10)), "rows": [],
                     "note": f"not available: {exc}"}
        warnings.append(f"subgroup analysis not available: {exc}")
    contexts, train_domain = failure_contexts(db, run, preds, manifest)
    try:
        failure = failure_taxonomy([{"bag_id": p.bag_id, "label": int(p.label), "score": float(p.score),
                                     "threshold": t, "predicted": int(p.predicted)} for p in preds], contexts,
                                   positive_class=run.positive_class, negative_class=run.negative_class,
                                   train_domain=train_domain)
    except ValueError as exc:
        failure = {"status": "not_available", "reason": str(exc), "errors": [], "counts": {}, "n_errors": None}
        warnings.append(f"failure analysis not available: {exc}")
    failure["train_domain"] = train_domain

    n_patients = core["n_patients"]
    if len(preds) < SMALL_SAMPLE_ITEMS:
        warnings.append(f"small sample: {len(preds)} item(s) (< {SMALL_SAMPLE_ITEMS}); estimates are unstable")
    if n_patients < min_patients:
        warnings.append(f"insufficient evidence for confidence intervals: {n_patients} patient(s)")
    if not preds:
        warnings.append("no scored items in this split; every metric is undefined")
    if core["n_unscorable"]:
        warnings.append(f"{core['n_unscorable']} bag(s) could not be scored; scored-only metrics exclude them and "
                        "the intention-to-evaluate metrics count them (missed positives, flagged negatives)")
    status = (run.threshold_json or {}).get("selection_status")
    if status in ("insufficient_evidence", "fallback"):
        warnings.append("threshold_unvalidated: the operating threshold is a fallback, not selected on development "
                        f"data ({(run.threshold_json or {}).get('reason') or status}); treat operating-point results "
                        "as unvalidated")
    if tuning:
        warnings.append("tuning set: the threshold was chosen on these data, so threshold-dependent metrics "
                        "(sensitivity, specificity, PPV, NPV) are optimistic; threshold-free metrics (AUROC, AUPRC, "
                        "Brier) are reported separately")

    body = {
        "schema": EVALUATION_SCHEMA,
        "metrics_schema": core["schema"],
        "run_id": run.id,
        "split": split,
        "evaluation_protocol": run.evaluation_protocol or "holdout",
        "label_scope": run.label_scope,
        "positive_class": run.positive_class,
        "negative_class": run.negative_class,
        "classes": class_info(run),
        "n_items": core["n_items"],
        "n_slides": len({sid for p in preds for sid in (p.slide_ids_json or [])}),
        "n_patients": n_patients,
        "n_scored_patients": core["n_scored_patients"],
        "positives": core["positives"],
        "negatives": core["negatives"],
        "positive_patients": core["positive_patients"],
        "negative_patients": core["negative_patients"],
        "n_unscorable": core["n_unscorable"],
        "unscorable_positives": core["unscorable_positives"],
        "unscorable_negatives": core["unscorable_negatives"],
        "evaluation_prevalence": core["evaluation_prevalence"],
        "operating_point": core["operating_point"],
        "tuning_set": tuning,
        "tuning_set_note": M.TUNING_SET_NOTE if tuning else None,
        "confusion": core["confusion"],
        "metrics": core["metrics"],
        "threshold_free_metrics": core["threshold_free_metrics"],
        "intention_to_evaluate": core["intention_to_evaluate"],
        "prevalence_adjusted": core["prevalence_adjusted"],
        "calibration": calibration,
        "risk_coverage": risk,
        "coverage_curve": coverage_curve,
        "abstention": abstention,
        "subgroups": subgroups,
        "failure_analysis": failure,
        "bootstrap": {**core["bootstrap"], "seed_source": seed_source},
        "threshold": threshold_dict(run),
        "unscored": unscored_rows,
        "warnings": warnings,
        "notes": core["notes"],
        "synthetic": run.synthetic,
        "banner": banner(run),
        "notice": RESEARCH_NOTICE,
        "computed_from": "stored prediction rows",
    }
    # Which labels this evaluation measures agreement with (W8 contract D). Imported reference labels are an external
    # dataset's own standard, not expert reads in this workbench: the body says so wherever metrics are shown.
    standard = ((manifest or {}).get("config") or {}).get("reference_standard", "expert")
    body["reference_standard"] = standard
    if standard == "imported_reference":
        body["reference_standard_notice"] = IMPORTED_REFERENCE_NOTICE
        body["warnings"].append(IMPORTED_REFERENCE_NOTICE)
    if release is not None:
        body.update(test_release_fields(release))
        body["computed_after_threshold_frozen_at"] = run.threshold_frozen_at.isoformat()
        body["feature_set_id"] = run.feature_set_id
        body["scored_from"] = "pinned feature-set artifacts (no re-extraction)"
        if release.release_number > 1:
            body["warnings"].append(
                f"this is test release {release.release_number} on this manifest: {release.release_number - 1} "
                "earlier release(s) looked at this test split, so these results are not fully independent of "
                "earlier decisions")
    return body


def test_release_fields(rel: TestRelease) -> dict:
    return {"test_release_id": rel.id, "release_number": int(rel.release_number),
            "prior_releases_on_manifest": int(rel.release_number) - 1,
            "test_release_candidate": {"kind": rel.candidate_kind, "bundle_id": rel.bundle_id,
                                       "family_id": rel.family_id},
            "test_release_note": TEST_RELEASE_NOTE}


def store_evaluation(db: Session, run: TrainingRun, split: str, body: dict, *, computed_by: str | None) -> Evaluation:
    ev = Evaluation(run_id=run.id, project_id=run.project_id, split=split, metrics_json=body,
                    threshold=float(run.threshold_value), threshold_frozen_from=_selected_on(run)[:8],
                    threshold_frozen_at=run.threshold_frozen_at, computed_by=computed_by)
    db.add(ev)
    db.flush()
    return ev


def stored_evaluation(db: Session, run_id: str, split: str) -> Evaluation | None:
    return db.scalars(select(Evaluation).where(Evaluation.run_id == run_id, Evaluation.split == split)).first()


def evaluation_response(ev: Evaluation, run: TrainingRun) -> dict:
    return {**ev.metrics_json, "evaluation_id": ev.id, "computed_at": ev.computed_at.isoformat(),
            "computed_by": ev.computed_by, "synthetic": run.synthetic, "banner": banner(run)}


def require_test_unlocked(run: TrainingRun) -> None:
    if run.status != "succeeded" or run.threshold_frozen_at is None:
        raise conflict("test_locked", "The test split stays locked until the run has finished and its threshold "
                       "was frozen on development data", run_status=run.status)


# =========================================================================== test releases


def releases_for_run(db: Session, run: TrainingRun) -> list[TestRelease]:
    rows = db.scalars(select(TestRelease).where(TestRelease.dataset_version_id == run.dataset_version_id)
                      .order_by(TestRelease.release_number)).all()
    return [r for r in rows if run.id in (r.run_ids_json or [])]


def release_count(db: Session, dataset_version_id: str) -> int:
    return len(db.scalars(select(TestRelease.id).where(TestRelease.dataset_version_id == dataset_version_id)).all())


def family_run_ids(db: Session, fam: ComparisonFamily) -> list[str]:
    ids = set(db.scalars(select(ComparisonFamilyMember.run_id).where(ComparisonFamilyMember.family_id == fam.id)).all())
    ids |= set(db.scalars(select(TrainingRun.id).where(TrainingRun.family_id == fam.id)).all())
    return sorted(ids)


def families_of_run(db: Session, run: TrainingRun) -> list[ComparisonFamily]:
    ids = set(db.scalars(select(ComparisonFamilyMember.family_id).where(ComparisonFamilyMember.run_id == run.id)).all())
    if run.family_id:
        ids.add(run.family_id)
    return [f for f in (db.get(ComparisonFamily, i) for i in sorted(ids)) if f is not None]


def bundle_of_run(db: Session, run: TrainingRun) -> InferenceBundle | None:
    return db.scalars(select(InferenceBundle).where(InferenceBundle.run_id == run.id)).first()


def _fs_error_types() -> tuple[type, ...]:
    from . import feature_sets as fsm

    return tuple(c for c in (getattr(fsm, "FeatureSetNotReady", None), getattr(fsm, "FeatureSetIntegrityError", None))
                 if isinstance(c, type))


def test_slide_ids(db: Session, dv: DatasetVersion) -> list[str]:
    return sorted({it["slide_id"] for it in training_eligible_items(db, dv, "test_evaluation")})


def _check_releasable(db: Session, run: TrainingRun, dv: DatasetVersion) -> None:
    """Refuse (409) before anything is sealed when a run's test split could not be scored from pins."""
    from . import feature_sets as fsm

    if run.status != "succeeded" or run.threshold_frozen_at is None or not run.checkpoint_sha256:
        raise conflict("test_locked", f"Run {run.id} has not finished with a frozen threshold", run_id=run.id,
                       run_status=run.status)
    if run.dataset_version_id != dv.id or run.dataset_manifest_sha256 != dv.manifest_sha256:
        raise conflict("manifest_mismatch", f"Run {run.id} was trained on another manifest", run_id=run.id)
    if stored_evaluation(db, run.id, "test") is not None or releases_for_run(db, run):
        rel = (releases_for_run(db, run) or [None])[-1]
        raise conflict("test_already_released", f"The test split of run {run.id} was already released",
                       run_id=run.id, test_release_id=rel.id if rel else None,
                       release_number=rel.release_number if rel else None)
    if not run.feature_set_id:
        raise conflict("feature_set_required", "This run has no pinned feature set (a legacy run): its test split "
                       "cannot be scored from pinned artifacts, and it is never re-extracted", run_id=run.id)
    fs = db.get(FeatureSet, run.feature_set_id)
    if fs is None or fs.status != "ready":
        raise conflict("feature_set_not_ready", "The run's feature set is not ready", run_id=run.id,
                       feature_set_id=run.feature_set_id, status=fs.status if fs else None)
    if run.weights_sha256 and fs.weights_sha256 != run.weights_sha256:
        raise conflict("weights_mismatch", "The run's pinned weights differ from its feature set's", run_id=run.id,
                       run_weights_sha256=run.weights_sha256, feature_set_weights_sha256=fs.weights_sha256)
    try:
        fsm.require_ready(db, fs, test_slide_ids(db, dv))
    except _fs_error_types() as exc:
        raise conflict("feature_set_not_ready", f"Test slides lack pinned features: {exc}", run_id=run.id,
                       feature_set_id=fs.id, missing=list(getattr(exc, "missing", []) or [])[:50]) from exc


def _resolve_candidate(db: Session, run: TrainingRun, requested: str | None):
    families = families_of_run(db, run)
    locked = [f for f in families if f.status == "locked"]
    bundle = bundle_of_run(db, run)
    if requested == "family" or (requested is None and locked):
        if not locked:
            states = {f.id: f.status for f in families}
            if any(s == "test_released" for s in states.values()):
                raise conflict("test_already_released", "The run's comparison family was already released",
                               families=states)
            raise conflict("candidate_required", "The run is not in a locked comparison family; lock it first "
                           "(POST /comparison-families/{id}/lock) or release the run's registered bundle",
                           families=states)
        if len(locked) > 1:
            raise conflict("ambiguous_candidate", "The run is in several locked comparison families",
                           families=[f.id for f in locked])
        fam = locked[0]
        return "family", None, fam, family_run_ids(db, fam)
    if bundle is None:
        raise conflict("candidate_required", "Declare the candidate first: register the run "
                       "(POST /experiments/{id}/register builds its inference bundle) or lock a comparison family "
                       "containing it", run_id=run.id)
    return "bundle", bundle, None, [run.id]


def create_test_release(db: Session, actor, run: TrainingRun, *, reason: str, justification: str | None = None,
                        candidate: str | None = None) -> tuple[TestRelease, Job]:
    """Record a test release and enqueue its scoring job; seals the split family's test patients in the same
    transaction (the caller commits)."""
    reason = (reason or "").strip()
    justification = (justification or "").strip() or None
    if not reason:
        raise unprocessable("reason_required", "A test release needs a reason")
    require_test_unlocked(run)
    dv = db.get(DatasetVersion, run.dataset_version_id)
    if dv is None or dv.status != "frozen" or dv.manifest_sha256 != run.dataset_manifest_sha256:
        raise conflict("manifest_mismatch", "The run's frozen manifest is not available or differs")
    done = releases_for_run(db, run)
    if done or stored_evaluation(db, run.id, "test") is not None:
        raise conflict("test_already_released", f"The test split of run {run.id} was already released",
                       run_id=run.id, test_release_id=done[-1].id if done else None,
                       release_number=done[-1].release_number if done else None)
    kind, bundle, family, run_ids = _resolve_candidate(db, run, candidate)
    runs = []
    for rid in run_ids:
        r = db.get(TrainingRun, rid)
        if r is None:  # pragma: no cover - FK
            raise conflict("run_missing", f"Run {rid} of the candidate does not exist")
        _check_releasable(db, r, dv)
        runs.append(r)
    if family is not None and family.dataset_version_id != dv.id:
        raise conflict("manifest_mismatch", "The comparison family uses another dataset version")
    prior = release_count(db, dv.id)
    number = prior + 1
    if number > 1 and not justification:
        raise unprocessable("justification_required", f"{prior} test release(s) already exist on this manifest; a "
                            "further release needs a justification, and it is counted and shown",
                            prior_releases_on_manifest=prior)
    seal = seal_test_patients(db, dv, f"test release {number} ({kind}): {reason}", actor)
    rel = TestRelease(project_id=run.project_id, dataset_version_id=dv.id, dataset_manifest_sha256=dv.manifest_sha256,
                      release_number=number, candidate_kind=kind, bundle_id=bundle.id if bundle else None,
                      family_id=family.id if family else None, run_ids_json=sorted(run_ids),
                      split_family_id=seal["split_family_id"],
                      sealed_patient_count=int(seal["sealed"]) + int(seal["already_sealed"]), reason=reason,
                      justification=justification, released_by=actor.id)
    try:
        with db.begin_nested():
            db.add(rel)
            db.flush()
    except (IntegrityError, ImmutableRecordError) as exc:
        raise conflict("concurrent_test_release", "Another test release on this manifest was recorded at the same "
                       "time; reload and try again") from exc
    job, _ = queue.enqueue(db, TEST_RELEASE_JOB, {"test_release_id": rel.id}, idempotency_key=f"test_release:{rel.id}",
                           project_id=run.project_id, created_by=actor.id)
    rel.job_id = job.id
    if family is not None:
        family.status = "test_released"
    db.flush()
    after = {"release_number": number, "prior_releases_on_manifest": prior, "candidate_kind": kind,
             "bundle_id": rel.bundle_id, "family_id": rel.family_id, "run_ids": rel.run_ids_json,
             "dataset_manifest_sha256": dv.manifest_sha256, "sealed_patients": rel.sealed_patient_count,
             "justification": justification, "job_id": job.id}
    audit.record_for(db, actor, project_id=run.project_id, action="test_release.created", entity_type="test_release",
                     entity_id=rel.id, after=after, reason=reason)
    for r in runs:
        audit.record_for(db, actor, project_id=run.project_id, action="experiment.test_released",
                         entity_type="training_run", entity_id=r.id,
                         after={"test_release_id": rel.id, "release_number": number}, reason=reason)
    return rel, job


def test_release_dict(db: Session, rel: TestRelease) -> dict:
    job = db.get(Job, rel.job_id) if rel.job_id else None
    stored = {rid: (ev.id if (ev := stored_evaluation(db, rid, "test")) is not None else None)
              for rid in rel.run_ids_json or []}
    return {"id": rel.id, "project_id": rel.project_id, "dataset_version_id": rel.dataset_version_id,
            "dataset_manifest_sha256": rel.dataset_manifest_sha256, "release_number": rel.release_number,
            "prior_releases_on_manifest": rel.release_number - 1, "candidate_kind": rel.candidate_kind,
            "bundle_id": rel.bundle_id, "family_id": rel.family_id, "run_ids": rel.run_ids_json,
            "split_family_id": rel.split_family_id, "sealed_patient_count": rel.sealed_patient_count,
            "reason": rel.reason, "justification": rel.justification, "released_by": rel.released_by,
            "released_at": rel.released_at.isoformat(), "job_id": rel.job_id,
            "job_status": job.status if job else None, "job_error": job.error if job else None,
            "evaluations": stored, "complete": all(v is not None for v in stored.values()),
            "note": TEST_RELEASE_NOTE}


def test_release_status(db: Session, run: TrainingRun, actor_role: str | None = None) -> dict:
    """What a test release of this run needs and what exists (read-only)."""
    from ..auth import role_has

    rels = releases_for_run(db, run)
    prior = release_count(db, run.dataset_version_id)
    families = families_of_run(db, run)
    locked = [f for f in families if f.status == "locked"]
    bundle = bundle_of_run(db, run)
    if locked:
        cand = {"kind": "family", "family_id": locked[0].id, "bundle_id": bundle.id if bundle else None,
                "ready": True, "reason": None}
    elif bundle is not None:
        cand = {"kind": "bundle", "bundle_id": bundle.id, "family_id": None, "ready": True, "reason": None}
    else:
        cand = {"kind": None, "bundle_id": None, "family_id": None, "ready": False,
                "reason": "register the run (its inference bundle becomes the candidate) or lock a comparison family "
                          "containing it"}
    blockers = []
    if run.status != "succeeded" or run.threshold_frozen_at is None:
        blockers.append("the run has not finished with a frozen threshold")
    if not run.feature_set_id:
        blockers.append("legacy run without a pinned feature set: its test split cannot be scored from pins")
    if not cand["ready"]:
        blockers.append(cand["reason"])
    return {"run_id": run.id, "released": bool(rels), "releases": [test_release_dict(db, r) for r in rels],
            "test_evaluation_stored": stored_evaluation(db, run.id, "test") is not None,
            "candidate": cand, "families": [{"id": f.id, "name": f.name, "status": f.status} for f in families],
            "prior_releases_on_manifest": prior, "next_release_number": prior + 1,
            "justification_required": prior > 0, "blockers": blockers,
            "can_release": not rels and not blockers and (actor_role is None or role_has(actor_role,
                                                                                         "dataset.test_access")),
            "requires": "research lead (dataset.test_access), a reason, and a declared candidate",
            "note": TEST_RELEASE_NOTE}


def stored_test_evaluation(db: Session, run: TrainingRun) -> Evaluation:
    """The stored test evaluation, or 409: ``test_release_required`` / ``test_release_pending`` /
    ``test_release_failed``. Never computes anything."""
    ev = stored_evaluation(db, run.id, "test")
    if ev is not None:
        return ev
    rels = releases_for_run(db, run)
    if not rels:
        raise conflict("test_release_required", "Test results exist only after a recorded test release "
                       "(POST /experiments/{id}/test-release by the research lead, with a reason)", run_id=run.id)
    rel = rels[-1]
    job = db.get(Job, rel.job_id) if rel.job_id else None
    status = job.status if job else None
    code = "test_release_failed" if status in ("failed", "canceled") else "test_release_pending"
    raise conflict(code, f"Test release {rel.release_number} is {status or 'recorded'}; its results are not stored",
                   test_release_id=rel.id, release_number=rel.release_number, job_id=rel.job_id, job_status=status,
                   job_error=job.error if job else None)


# --------------------------------------------------------------------------- the scoring job


def bags_from_items(items: list[dict], run: TrainingRun) -> list[Bag]:
    """Bags of frozen-manifest items (slide or case scope), in a content-stable order. Labels stay on their bag."""
    groups: dict[str, list[dict]] = {}
    for it in items:
        key = it["slide_id"] if run.label_scope == "slide" else it["case_id"]
        groups.setdefault(key, []).append(it)

    def order(rows):
        r = rows[0]
        return (r.get("patient_code") or "", r.get("accession_code") or "", min(x.get("slide_sha256") or "" for x in rows),
                r["slide_id"])

    bags = []
    for key, rows in sorted(groups.items(), key=lambda kv: order(kv[1])):
        rows = sorted(rows, key=lambda r: (r.get("slide_sha256") or "", r["slide_id"]))
        values = {r["label_value"] for r in rows}
        if len(values) != 1:
            raise PermanentJobError(f"bag {key} has conflicting labels {sorted(values)}")
        value = next(iter(values))
        attrs = {}
        for k in ATTR_KEYS:
            vals = {r.get(k) for r in rows}
            if k == "stain_batch" and vals == {None}:
                continue
            attrs[k] = next(iter(vals)) if len(vals) == 1 else "mixed"
        bags.append(Bag(bag_id=key, kind=run.label_scope, slide_ids=[r["slide_id"] for r in rows],
                        case_id=rows[0].get("case_id"), patient_id=rows[0]["coded_patient_id"],
                        patient_code=rows[0].get("patient_code"), label_value=value,
                        label=1 if value == run.positive_class else 0,
                        label_version_ids=sorted({r["label_version_id"] for r in rows if r.get("label_version_id")}),
                        attributes=attrs))
    return bags


def _bundle_pins(bundle: InferenceBundle | None) -> dict:
    c = (bundle.content_json or {}) if bundle is not None else {}
    enc = c.get("encoder") or {}
    return {"weights_sha256": enc.get("weights_sha256"), "encoder_spec_sha256": enc.get("spec_sha256"),
            "policy_sha256": (c.get("patch_policy") or {}).get("policy_sha256"),
            "checkpoint_sha256": (c.get("head") or {}).get("checkpoint_sha256")}


def verify_slide_features(sf, fs: FeatureSet, run: TrainingRun, bundle: InferenceBundle | None, slide_id: str) -> None:
    """Every loaded artifact must carry the pinned identity (feature set, run, and bundle when declared)."""
    pins = _bundle_pins(bundle)
    checks = [("weights_sha256", getattr(sf, "weights_sha256", None), fs.weights_sha256),
              ("encoder_spec_sha256", getattr(sf, "encoder_spec_sha256", None), fs.encoder_spec_sha256),
              ("policy_sha256", getattr(sf, "policy_sha256", None), fs.policy_sha256)]
    if run.weights_sha256:
        checks.append(("weights_sha256 (run)", getattr(sf, "weights_sha256", None), run.weights_sha256))
    for key in ("weights_sha256", "encoder_spec_sha256", "policy_sha256"):
        if pins.get(key):
            checks.append((f"{key} (bundle)", getattr(sf, key, None), pins[key]))
    bad = [f"{name}: artifact {got} != pinned {want}" for name, got, want in checks if got != want]
    if getattr(sf, "slide_id", slide_id) != slide_id:
        bad.append(f"slide_id: artifact {sf.slide_id} != {slide_id}")
    emb = getattr(sf, "embeddings", None)
    if emb is None or getattr(emb, "ndim", 0) != 2 or int(getattr(sf, "n_patches", emb.shape[0])) != int(emb.shape[0]):
        bad.append("embeddings: missing or inconsistent with n_patches")
    if bad:
        raise PermanentJobError(f"weights_or_identity_mismatch for slide {slide_id}: " + "; ".join(bad) +
                                " (refusing to score; nothing is re-extracted)")


def _attach(bag: Bag, feats: dict) -> None:
    embs, coords, idx, arts = [], [], [], []
    for j, sid in enumerate(bag.slide_ids):
        sf = feats[sid]
        e = np.asarray(sf.embeddings, dtype=np.float32)
        embs.append(e)
        c = getattr(sf, "coords", None)
        coords.append(np.asarray(c, dtype=np.int64) if c is not None else np.zeros((e.shape[0], 2), dtype=np.int64))
        idx.append(np.full(e.shape[0], j, dtype=np.int64))
        if getattr(sf, "artifact_id", None):
            arts.append(sf.artifact_id)
    bag.embeddings = np.concatenate(embs) if embs else None
    bag.coords = np.concatenate(coords) if coords else None
    bag.slide_index = np.concatenate(idx) if idx else None
    bag.artifact_ids = arts


def score_bags(run: TrainingRun, bags: list[Bag], feats: dict | None = None) -> list[tuple]:
    """``training.score_bags_with_checkpoint`` in bounded chunks: with ``feats`` (slide id → loaded pinned
    features, memory-mapped) each chunk's embeddings are attached just before scoring and released after, so
    at most one chunk is in memory. Checks each decision against the frozen threshold."""
    from . import training

    out = []
    t = float(run.threshold_value)
    for i in range(0, len(bags), SCORE_CHUNK):
        chunk = bags[i:i + SCORE_CHUNK]
        if feats is not None:
            for b in chunk:
                _attach(b, feats)
        try:
            res = training.score_bags_with_checkpoint(run, chunk)
        except PermanentJobError:
            raise
        except ValueError as exc:
            raise PermanentJobError(f"scoring failed: {exc}") from exc
        for bag, score, cal, pred, abst in res:
            if not math.isfinite(float(score)):
                raise PermanentJobError(f"non-finite score for bag {bag.bag_id}")
            if int(pred) != int(float(score) >= t):
                raise PermanentJobError(f"bag {bag.bag_id}: decision {pred} disagrees with score >= frozen threshold")
            out.append((bag, float(score), None if cal is None else float(cal), int(pred), bool(abst)))
        for b in chunk:  # release the embeddings of this chunk
            b.embeddings = None
    return out


def _release_run(release_id: str, run_id: str, ctx) -> dict:
    from . import feature_sets as fsm

    errors = _fs_error_types()
    with session_scope() as db:
        rel = db.get(TestRelease, release_id)
        run = db.get(TrainingRun, run_id)
        if rel is None or run is None:
            raise PermanentJobError(f"test release {release_id} or run {run_id} does not exist")
        ev = stored_evaluation(db, run_id, "test")
        if ev is not None:
            return {"status": "stored", "evaluation_id": ev.id, "idempotent_replay": True}
        if run.status != "succeeded" or run.threshold_value is None or run.threshold_frozen_at is None:
            raise PermanentJobError(f"run {run_id} is not a finished run with a frozen threshold")
        dv = db.get(DatasetVersion, run.dataset_version_id)
        if dv is None or dv.manifest_sha256 != rel.dataset_manifest_sha256 or \
                run.dataset_manifest_sha256 != rel.dataset_manifest_sha256:
            raise PermanentJobError("manifest_mismatch: the run, its dataset version and the release disagree")
        fs = db.get(FeatureSet, run.feature_set_id) if run.feature_set_id else None
        if fs is None or fs.status != "ready":
            raise PermanentJobError("pinned feature set missing or not ready; test features are never re-extracted")
        bundle = db.get(InferenceBundle, rel.bundle_id) if rel.bundle_id else None
        pins = _bundle_pins(bundle)
        if run.weights_sha256 and run.weights_sha256 != fs.weights_sha256:
            raise PermanentJobError(f"weights_mismatch: run {run.weights_sha256} != feature set {fs.weights_sha256}")
        if pins["weights_sha256"] and pins["weights_sha256"] != fs.weights_sha256:
            raise PermanentJobError("weights_mismatch: bundle weights differ from the feature set's")
        if pins["checkpoint_sha256"] and pins["checkpoint_sha256"] != run.checkpoint_sha256:
            raise PermanentJobError("checkpoint_mismatch: bundle head differs from the run's checkpoint")
        items = training_eligible_items(db, dv, "test_evaluation")
        bags = bags_from_items(items, run)
        slide_ids = sorted({s for b in bags for s in b.slide_ids})
        try:
            fsm.require_ready(db, fs, slide_ids)
        except errors as exc:
            raise PermanentJobError(f"pinned_artifact_missing: {exc} (nothing is re-extracted)") from exc
        feats = {}
        for i, sid in enumerate(slide_ids):
            try:
                sf = fsm.load_slide_features(fs, sid)
            except errors as exc:
                raise PermanentJobError(f"pinned_artifact_missing_or_corrupt for slide {sid}: {exc} "
                                        "(nothing is re-extracted)") from exc
            verify_slide_features(sf, fs, run, bundle, sid)
            feats[sid] = sf
            if ctx is not None and (i % 16 == 0):
                ctx.progress(0.6 * (i + 1) / max(len(slide_ids), 1), f"loaded pinned features {i + 1}/{len(slide_ids)}")
        n_patches = {b.bag_id: sum(int(np.shape(feats[s].embeddings)[0]) for s in b.slide_ids) for b in bags}
        scorable = [b for b in bags if n_patches[b.bag_id] > 0]
        unscored = [{"bag_id": b.bag_id, "split": "test", "reason": "no tissue patches in the pinned artifact",
                     "label_value": b.label_value, "coded_patient_id": b.patient_id, "patient_code": b.patient_code}
                    for b in bags if n_patches[b.bag_id] == 0]
        meta = {b.bag_id: {"n_patches": n_patches[b.bag_id],
                           "artifacts": [feats[s].artifact_id for s in b.slide_ids if getattr(feats[s], "artifact_id",
                                                                                              None)]}
                for b in scorable}
        scored = score_bags(run, scorable, feats)
        qc = {b.bag_id: qc_context(db, b.slide_ids) for b in scorable}
    if ctx is not None:
        ctx.progress(0.9, f"scored {len(scored)} test bag(s); recording")

    with session_scope() as db:
        run = db.get(TrainingRun, run_id)
        rel = db.get(TestRelease, release_id)
        ev = stored_evaluation(db, run_id, "test")
        if ev is not None:  # another attempt finished first
            return {"status": "stored", "evaluation_id": ev.id, "idempotent_replay": True}
        dv = db.get(DatasetVersion, run.dataset_version_id)
        preds = []
        for bag, score, _cal, pred, abst in scored:
            preds.append(Prediction(
                run_id=run.id, project_id=run.project_id, split="test", bag_kind=bag.kind, bag_id=bag.bag_id,
                slide_ids_json=bag.slide_ids, case_id=bag.case_id, coded_patient_id=bag.patient_id,
                patient_code=bag.patient_code, label_value=bag.label_value, label_version_ids_json=bag.label_version_ids,
                label=bag.label, score=score, threshold=float(run.threshold_value), predicted=pred, abstained=abst,
                attributes_json={**bag.attributes, "n_patches": meta[bag.bag_id]["n_patches"],
                                 "qc_context": qc.get(bag.bag_id), "test_release_id": rel.id},
                attention_json=None, feature_artifact_ids_json=meta[bag.bag_id]["artifacts"]))
        body = build_evaluation(run, "test", preds, unscored, manifest=dv.manifest_json, release=rel, db=db)
        cats = {e["bag_id"]: e["categories"] for e in body["failure_analysis"].get("errors", [])}
        for p in preds:
            p.failure_categories_json = cats.get(p.bag_id, [])
            db.add(p)
        db.flush()
        ev = store_evaluation(db, run, "test", body, computed_by=audit.SYSTEM_WORKER)
        rows_sha = M.canonical_sha256(sorted([p.bag_id, p.score, p.predicted, bool(p.abstained)] for p in preds))
        audit.record(db, action="experiment.test_evaluated", entity_type="training_run", entity_id=run.id,
                     actor_id=audit.SYSTEM_WORKER, actor_role="system", project_id=run.project_id,
                     after={"test_release_id": rel.id, "release_number": rel.release_number, "evaluation_id": ev.id,
                            "n_items": len(preds), "n_unscorable": len(unscored),
                            "threshold": run.threshold_value, "metrics_sha256": M.canonical_sha256(body),
                            "predictions_sha256": rows_sha, "scored_from": "pinned feature-set artifacts"})
        if ctx is not None:
            ctx.assert_lease(db)  # fence the domain commit
        return {"status": "stored", "evaluation_id": ev.id, "n_items": len(preds), "n_unscorable": len(unscored)}


def run_test_release(release_id: str, ctx=None) -> dict:
    with session_scope() as db:
        rel = db.get(TestRelease, release_id)
        if rel is None:
            raise PermanentJobError(f"test release {release_id} does not exist")
        run_ids = list(rel.run_ids_json or [])
    out = {}
    for i, rid in enumerate(run_ids):
        if ctx is not None:
            ctx.progress(i / max(len(run_ids), 1), f"run {i + 1}/{len(run_ids)}")
        out[rid] = _release_run(release_id, rid, ctx)
    return {"test_release_id": release_id, "runs": out}


@register(TEST_RELEASE_JOB, description="Score a recorded test release from pinned feature-set artifacts")
def evaluate_test_release(ctx, payload: dict) -> dict:
    if any(k in payload for k in ("label", "labels", "fixture_label")):
        raise PermanentJobError("job payloads never carry labels")
    rid = payload.get("test_release_id")
    if not rid:
        raise PermanentJobError("payload.test_release_id is required")
    return run_test_release(rid, ctx)


# =========================================================================== errors and attention


def failure_reason(p: Prediction) -> str | None:
    ctx = (p.attributes_json or {}).get("qc_context") or {}
    parts = []
    if ctx.get("qc_issues"):
        parts.append("QC issue(s) on the slide: " + ", ".join(ctx["qc_issues"]))
    if ctx.get("uncalibrated_slides"):
        parts.append("missing calibration (uncalibrated scale)")
    return ("possible contributing factor: " + "; ".join(parts)) if parts else None


def errors_response(db: Session, run: TrainingRun, split: str) -> dict:
    preds = db.scalars(select(Prediction).where(Prediction.run_id == run.id, Prediction.split == split)).all()
    t = float(run.threshold_value) if run.threshold_value is not None else 0.5
    contexts, train_domain = failure_contexts(db, run, preds, _manifest(db, run))
    tax = failure_taxonomy([{"bag_id": p.bag_id, "label": p.label, "score": p.score, "threshold": p.threshold,
                             "predicted": p.predicted} for p in preds], contexts, positive_class=run.positive_class,
                           negative_class=run.negative_class, train_domain=train_domain)
    by_bag = {p.bag_id: p for p in preds}
    items = []
    for e in tax["errors"]:
        p = by_bag[e["bag_id"]]
        stored_cats = p.failure_categories_json
        items.append({"slide_id": p.slide_ids_json[0], "slide_ids": p.slide_ids_json, "case_id": p.case_id,
                      "bag_kind": p.bag_kind, "bag_id": p.bag_id, "patient_code": p.patient_code,
                      "label": p.label_value, "score": p.score, "threshold": p.threshold,
                      "predicted": run.positive_class if p.predicted else run.negative_class,
                      "error_type": e["error_type"], "description": e["description"],
                      "categories": stored_cats if stored_cats is not None else e["categories"],
                      "category_details": e["details"], "relative_margin": e["relative_margin"],
                      "abstained": bool(p.abstained), "attention_available": p.attention_json is not None,
                      "failure_reason": failure_reason(p),
                      "attributes": {k: v for k, v in (p.attributes_json or {}).items() if k != "qc_context"}})
    fns = tax["n_false_negatives"]
    return {"run_id": run.id, "split": split, "items": items,
            "counts": {"false_negative": fns, "false_positive": tax["n_false_positives"], "errors": tax["n_errors"],
                       "n_items": len(preds)},
            "categories": {"counts": tax["counts"], "counts_by_error_type": tax["counts_by_error_type"],
                           "not_assessable": tax["not_assessable"], "policy": tax["policy"], "notes": tax["notes"]},
            "classes": class_info(run), "threshold": t,
            "order": "false negatives first (lowest score first), then false positives (highest score first)",
            "failure_reason_note": "null unless a QC issue or missing calibration offers a possible contributing "
                                   "factor; never a causal explanation",
            "synthetic": run.synthetic, "banner": banner(run)}


def prediction_for_slide(db: Session, run: TrainingRun, slide_id: str) -> Prediction | None:
    preds = db.scalars(select(Prediction).where(Prediction.run_id == run.id)).all()
    order = {"val": 0, "oof": 1, "test": 2, "train": 3}
    for p in sorted(preds, key=lambda p: (order.get(p.split, 4), p.bag_id)):
        if slide_id in (p.slide_ids_json or []):
            return p
    return None


def attention_response(run: TrainingRun, p: Prediction, slide_id: str) -> dict:
    if p is None:
        raise not_found("prediction for slide", slide_id)
    if p.attention_json is None:
        raise conflict("attention_unavailable", "No attention weights were stored for this prediction (test-release "
                       "predictions are scored from pinned features without attention)", split=p.split)
    j = p.slide_ids_json.index(slide_id)
    rows = [r for r in (p.attention_json or []) if r[0] == j]
    total = float(sum(r[5] for r in p.attention_json or []))
    return {
        "kind": "attention",
        "notice": ATTENTION_NOTICE,
        "run_id": run.id,
        "slide_id": slide_id,
        "split": p.split,
        "bag_kind": p.bag_kind,
        "bag_id": p.bag_id,
        "coordinate_space": "level0_pixels",
        "weight_normalization": ("softmax over all patches of the bag (sums to 1 across the bag"
                                 + (", which spans several slides of the case)" if p.bag_kind == "case" else ")")),
        "bag_weight_total": round(total, 6),
        "score": p.score,
        "patches": [{"x": r[1], "y": r[2], "w": r[3], "h": r[4], "weight": r[5]} for r in rows],
        "in_sample": p.split == "train",
        "synthetic": run.synthetic,
        "banner": banner(run),
    }


# =========================================================================== comparison families


def create_family(db: Session, actor, project, *, name: str, dataset_version_id: str, plan: dict | None = None,
                  bootstrap_seed: int | None = None) -> ComparisonFamily:
    dv = db.get(DatasetVersion, dataset_version_id)
    if dv is None or dv.project_id != project.id:
        raise not_found("dataset_version", dataset_version_id)
    if dv.status != "frozen" or not dv.manifest_json:
        raise conflict("dataset_not_frozen", "Comparison families use frozen dataset versions only")
    fam = ComparisonFamily(project_id=project.id, name=name[:200], dataset_version_id=dv.id,
                           dataset_manifest_sha256=dv.manifest_sha256,
                           split_fingerprint=(dv.manifest_json or {}).get("split_fingerprint"), plan_json=plan or {},
                           bootstrap_seed=int(bootstrap_seed if bootstrap_seed is not None else 0),
                           created_by=actor.id)
    db.add(fam)
    db.flush()
    audit.record_for(db, actor, project_id=project.id, action="comparison_family.created",
                     entity_type="comparison_family", entity_id=fam.id,
                     after={"name": fam.name, "dataset_version_id": dv.id, "bootstrap_seed": fam.bootstrap_seed})
    return fam


def add_family_member(db: Session, actor, fam: ComparisonFamily, run: TrainingRun, role: str | None = None) -> bool:
    if fam.status != "open":
        raise conflict("family_locked", "Runs can be added only while the comparison family is open",
                       status=fam.status)
    if run.project_id != fam.project_id:
        raise not_found("experiment", run.id)
    if run.dataset_version_id != fam.dataset_version_id or run.dataset_manifest_sha256 != fam.dataset_manifest_sha256:
        raise conflict("manifest_mismatch", "A family compares runs on ONE frozen manifest")
    if run.id in family_run_ids(db, fam):
        return False
    db.add(ComparisonFamilyMember(family_id=fam.id, project_id=fam.project_id, run_id=run.id, role=role,
                                  created_by=actor.id))
    db.flush()
    audit.record_for(db, actor, project_id=fam.project_id, action="comparison_family.member_added",
                     entity_type="comparison_family", entity_id=fam.id, after={"run_id": run.id, "role": role})
    return True


def lock_family(db: Session, actor, fam: ComparisonFamily, reason: str) -> ComparisonFamily:
    reason = (reason or "").strip()
    if not reason:
        raise unprocessable("reason_required", "Locking a comparison family needs a reason")
    if fam.status != "open":
        raise conflict("family_not_open", f"The comparison family is already {fam.status}", status=fam.status)
    ids = family_run_ids(db, fam)
    if not ids:
        raise conflict("family_empty", "A comparison family needs at least one run before it is locked")
    not_ready = []
    for rid in ids:
        r = db.get(TrainingRun, rid)
        if r is None or r.status != "succeeded" or r.threshold_frozen_at is None:
            not_ready.append({"run_id": rid, "status": r.status if r else None})
    if not_ready:
        raise conflict("family_members_not_ready", "Every run of the family must have finished with a frozen "
                       "threshold before the family is locked", runs=not_ready)
    from ..db import utcnow

    fam.status = "locked"
    fam.locked_by, fam.locked_at, fam.lock_reason = actor.id, utcnow(), reason
    db.flush()
    audit.record_for(db, actor, project_id=fam.project_id, action="comparison_family.locked",
                     entity_type="comparison_family", entity_id=fam.id, after={"run_ids": ids}, reason=reason)
    return fam


def _score_set(db: Session, run: TrainingRun, split: str, manifest: dict | None) -> ScoreSet:
    preds = db.scalars(select(Prediction).where(Prediction.run_id == run.id, Prediction.split == split)
                       .order_by(Prediction.bag_id)).all()
    return ScoreSet(name=run.id, bag_ids=[p.bag_id for p in preds], patients=[p.coded_patient_id for p in preds],
                    labels=[p.label for p in preds], scores=[p.score for p in preds],
                    threshold=float(run.threshold_value), manifest_sha256=run.dataset_manifest_sha256,
                    split_fingerprint=(manifest or {}).get("split_fingerprint"))


def family_comparison(db: Session, fam: ComparisonFamily, runs: list[TrainingRun], split: str, *, n_boot: int,
                      min_patients: int) -> dict:
    done = [r for r in runs if r.status == "succeeded" and r.threshold_value is not None]
    if len(done) < 2:
        return {"status": "insufficient_members", "split": split, "reason": "a paired comparison needs at least two "
                "finished runs", "n_runs": len(done)}
    manifest = (db.get(DatasetVersion, fam.dataset_version_id).manifest_json or {})
    sets = [_score_set(db, r, split, manifest) for r in done]
    if any(not ss.bag_ids for ss in sets):
        return {"status": "not_available", "split": split,
                "reason": f"at least one run has no stored '{split}' predictions"}
    try:
        res = paired_comparison(sets, n_boot=n_boot, seed=int(fam.bootstrap_seed), min_patients=min_patients)
    except ComparisonRefused as exc:
        return {"status": "refused", "split": split, "code": exc.code, "reason": exc.detail}
    return {"status": "ok", "split": split, "result": res}


def family_dict(db: Session, fam: ComparisonFamily, *, actor_role: str | None = None, n_boot: int | None = None,
                with_comparison: bool = True) -> dict:
    from ..auth import role_has

    ids = family_run_ids(db, fam)
    runs = [r for r in (db.get(TrainingRun, i) for i in ids) if r is not None]
    protocols = {r.evaluation_protocol or "holdout" for r in runs}
    out = {"id": fam.id, "project_id": fam.project_id, "name": fam.name, "dataset_version_id": fam.dataset_version_id,
           "dataset_manifest_sha256": fam.dataset_manifest_sha256, "split_fingerprint": fam.split_fingerprint,
           "plan": fam.plan_json, "bootstrap_seed": fam.bootstrap_seed, "status": fam.status,
           "created_by": fam.created_by, "created_at": fam.created_at.isoformat(), "locked_by": fam.locked_by,
           "locked_at": fam.locked_at.isoformat() if fam.locked_at else None, "lock_reason": fam.lock_reason,
           "runs": [{"id": r.id, "name": r.name, "head": r.head, "encoder_id": r.encoder_id, "seed": r.seed,
                     "status": r.status, "evaluation_protocol": r.evaluation_protocol or "holdout",
                     "synthetic": r.synthetic} for r in runs],
           "synthetic": any(r.synthetic for r in runs),
           "banner": PIPELINE_TEST_BANNER if any(r.synthetic for r in runs) else None, "note": FAMILY_NOTE,
           "winner": None}
    if not with_comparison:
        return out
    nb = int(n_boot if n_boot is not None else (fam.plan_json or {}).get("n_boot", 1000))
    mp = int((fam.plan_json or {}).get("boot_min_patients", 10))
    if len(protocols) > 1:
        out["development_comparison"] = {"status": "refused", "code": "mixed_protocols",
                                         "reason": "runs use different evaluation protocols (validation vs "
                                                   "out-of-fold), so their development sets differ"}
    else:
        split = "oof" if protocols == {"dev_cv"} else "val"
        out["development_comparison"] = family_comparison(db, fam, runs, split, n_boot=nb, min_patients=mp)
    if fam.status != "test_released":
        out["test_comparison"] = {"status": "locked", "reason": "test comparisons appear only after a test release of "
                                                                "the whole locked family"}
    elif actor_role is not None and not role_has(actor_role, "dataset.test_access"):
        out["test_comparison"] = {"status": "restricted", "reason": "test results are visible to the research lead "
                                                                    "only (dataset.test_access)"}
    elif any(stored_evaluation(db, r.id, "test") is None for r in runs):
        out["test_comparison"] = {"status": "pending", "reason": "the family's test release has not finished"}
    else:
        out["test_comparison"] = family_comparison(db, fam, runs, "test", n_boot=nb, min_patients=mp)
    return out


__all__ = ["build_evaluation", "store_evaluation", "stored_evaluation", "evaluation_response", "threshold_dict",
           "require_test_unlocked", "create_test_release", "run_test_release", "stored_test_evaluation",
           "test_release_status", "test_release_dict", "errors_response", "attention_response",
           "prediction_for_slide", "failure_reason", "qc_context", "bags_from_items", "verify_slide_features",
           "create_family", "add_family_member", "lock_family", "family_dict", "family_run_ids"]
