"""Evaluations computed from stored Prediction rows; test-split access; errors; attention.

* Validation evaluations are written by the train job (same transaction as its predictions).
* The TEST split is scored only on explicit request, only after the threshold was frozen on
  validation, only by the research lead, and every access is audited
  (``experiment.test_evaluated`` once, ``experiment.test_accessed`` on every read).
* Error gallery: false negatives first (lowest score first), then false positives.
  ``failure_reason`` is null unless a QC issue or missing calibration recorded at prediction
  time offers a POSSIBLE contributing factor (it is never a causal claim).
"""

from __future__ import annotations

import numpy as np
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from .. import audit
from ..datasets import training_eligible_items
from ..errors import conflict, not_found
from ..models import DatasetVersion
from . import ATTENTION_NOTICE, PIPELINE_TEST_BANNER, RESEARCH_NOTICE
from .metrics import bootstrap_cis, calibration, coverage_curve, point_metrics, subgroups
from .models import Evaluation, Prediction, TrainingRun

SMALL_SAMPLE_ITEMS = 30


def banner(run: TrainingRun) -> str | None:
    return PIPELINE_TEST_BANNER if run.synthetic else None


def threshold_dict(run: TrainingRun) -> dict | None:
    if run.threshold_frozen_at is None:
        return None
    t = run.threshold_json or {}
    return {"value": run.threshold_value, "selected_on": "val", "rule": run.threshold_rule,
            "frozen_at": run.threshold_frozen_at.isoformat(), "selection_status": t.get("selection_status"),
            "reason": t.get("reason"), "requested_rule": t.get("requested_rule"),
            "val_sensitivity_at_threshold": t.get("val_sensitivity_at_threshold"),
            "val_specificity_at_threshold": t.get("val_specificity_at_threshold"),
            "comparison": "positive if score >= value"}


def build_evaluation(run: TrainingRun, split: str, preds: list[Prediction], unscored: list | None = None) -> dict:
    params = run.params_json or {}
    y = np.array([p.label for p in preds], dtype=np.int64)
    s = np.array([p.score for p in preds], dtype=np.float64)
    pr = np.array([p.predicted for p in preds], dtype=np.int64)
    patients = [p.coded_patient_id for p in preds]
    conf, metrics = point_metrics(y, s, pr)
    cis, boot = bootstrap_cis(y, s, pr, patients, n_boot=int(params.get("n_boot", 1000)), seed=int(run.seed),
                              min_patients=int(params.get("boot_min_patients", 10)))
    for k, v in cis.items():
        metrics[k]["ci"] = v["ci"]
        metrics[k]["ci_reason"] = v["ci_reason"] if metrics[k]["value"] is not None else metrics[k]["undefined_reason"]
    n_patients = len(set(patients))
    warnings = []
    if len(preds) < SMALL_SAMPLE_ITEMS:
        warnings.append(f"small sample: {len(preds)} item(s) (< {SMALL_SAMPLE_ITEMS}); estimates are unstable")
    if n_patients < int(params.get("boot_min_patients", 10)):
        warnings.append(f"insufficient evidence for confidence intervals: {n_patients} patient(s)")
    if not preds:
        warnings.append("no scored items in this split; every metric is undefined")
    thr = run.threshold_value if run.threshold_value is not None else 0.5
    return {
        "run_id": run.id,
        "split": split,
        "label_scope": run.label_scope,
        "positive_class": run.positive_class,
        "negative_class": run.negative_class,
        "n_items": len(preds),
        "n_slides": len({sid for p in preds for sid in p.slide_ids_json}),
        "n_patients": n_patients,
        "positives": int(y.sum()),
        "negatives": int(y.size - y.sum()),
        "confusion": conf,
        "metrics": metrics,
        "calibration": calibration(y, s),
        "coverage_curve": coverage_curve(y, s, pr, thr),
        "subgroups": subgroups(y, s, pr, [p.attributes_json or {} for p in preds],
                               min_n=int(params.get("subgroup_min_n", 10))),
        "bootstrap": boot,
        "threshold": threshold_dict(run),
        "unscored": unscored or [],
        "warnings": warnings,
        "synthetic": run.synthetic,
        "banner": banner(run),
        "notice": RESEARCH_NOTICE,
        "computed_from": "stored prediction rows",
    }


def store_evaluation(db: Session, run: TrainingRun, split: str, body: dict, *, computed_by: str | None) -> Evaluation:
    ev = Evaluation(run_id=run.id, project_id=run.project_id, split=split, metrics_json=body,
                    threshold=float(run.threshold_value), threshold_frozen_from="val",
                    threshold_frozen_at=run.threshold_frozen_at, computed_by=computed_by)
    db.add(ev)
    db.flush()
    return ev


def stored_evaluation(db: Session, run_id: str, split: str) -> Evaluation | None:
    return db.scalars(select(Evaluation).where(Evaluation.run_id == run_id, Evaluation.split == split)).first()


def require_test_unlocked(run: TrainingRun) -> None:
    if run.status != "succeeded" or run.threshold_frozen_at is None:
        raise conflict("test_locked", "The test split stays locked until the run has finished and its threshold "
                       "was frozen on the validation split", run_status=run.status)


def ensure_test_evaluation(db: Session, run: TrainingRun, actor) -> Evaluation:
    """Score the test split once with the frozen checkpoint and threshold (research lead only)."""
    from .training import prediction_rows, qc_context, score_split_bags

    require_test_unlocked(run)
    ev = stored_evaluation(db, run.id, "test")
    if ev is not None:
        return ev
    dv = db.get(DatasetVersion, run.dataset_version_id)
    items = training_eligible_items(db, dv, "test_evaluation")
    bags, model, unscored = score_split_bags(run, items) if items else ([], None, [])
    qc = {b.bag_id: qc_context(db, b.slide_ids) for b in bags}
    preds = prediction_rows(run, "test", bags, model, float(run.threshold_value), qc) if bags else []
    try:
        with db.begin_nested():
            for p in preds:
                db.add(p)
            db.flush()
            body = build_evaluation(run, "test", preds, unscored)
            body["computed_after_threshold_frozen_at"] = run.threshold_frozen_at.isoformat()
            ev = store_evaluation(db, run, "test", body, computed_by=actor.id)
            audit.record_for(db, actor, project_id=run.project_id, action="experiment.test_evaluated",
                             entity_type="training_run", entity_id=run.id,
                             after={"n_items": len(preds), "threshold": run.threshold_value,
                                    "threshold_frozen_at": run.threshold_frozen_at.isoformat()})
    except IntegrityError:  # a concurrent request stored it first
        ev = stored_evaluation(db, run.id, "test")
        if ev is None:
            raise
    return ev


def audit_test_access(db: Session, actor, run: TrainingRun, what: str) -> None:
    audit.record_for(db, actor, project_id=run.project_id, action="experiment.test_accessed",
                     entity_type="training_run", entity_id=run.id, after={"what": what})


def evaluation_response(ev: Evaluation, run: TrainingRun) -> dict:
    return {**ev.metrics_json, "evaluation_id": ev.id, "computed_at": ev.computed_at.isoformat(),
            "computed_by": ev.computed_by, "synthetic": run.synthetic, "banner": banner(run)}


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
    fns = sorted([p for p in preds if p.label == 1 and p.predicted == 0], key=lambda p: (p.score, p.bag_id))
    fps = sorted([p for p in preds if p.label == 0 and p.predicted == 1], key=lambda p: (-p.score, p.bag_id))
    items = []
    for p, kind in [(p, "false_negative") for p in fns] + [(p, "false_positive") for p in fps]:
        items.append({"slide_id": p.slide_ids_json[0], "slide_ids": p.slide_ids_json, "case_id": p.case_id,
                      "bag_kind": p.bag_kind, "patient_code": p.patient_code, "label": p.label_value,
                      "score": p.score, "threshold": p.threshold, "predicted": run.positive_class if p.predicted
                      else run.negative_class, "error_type": kind, "attention_available": p.attention_json is not None,
                      "failure_reason": failure_reason(p), "attributes": {k: v for k, v in (p.attributes_json or {}).items()
                                                                          if k != "qc_context"}})
    return {"run_id": run.id, "split": split, "items": items,
            "counts": {"false_negative": len(fns), "false_positive": len(fps), "errors": len(fns) + len(fps),
                       "n_items": len(preds)},
            "order": "false negatives first (lowest score first), then false positives (highest score first)",
            "failure_reason_note": "null unless a QC issue or missing calibration offers a possible contributing "
                                   "factor; never a causal explanation",
            "synthetic": run.synthetic, "banner": banner(run)}


def prediction_for_slide(db: Session, run: TrainingRun, slide_id: str) -> Prediction | None:
    preds = db.scalars(select(Prediction).where(Prediction.run_id == run.id)).all()
    for p in sorted(preds, key=lambda p: {"val": 0, "test": 1, "train": 2}.get(p.split, 3)):
        if slide_id in (p.slide_ids_json or []):
            return p
    return None


def attention_response(run: TrainingRun, p: Prediction, slide_id: str) -> dict:
    if p is None:
        raise not_found("prediction for slide", slide_id)
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

