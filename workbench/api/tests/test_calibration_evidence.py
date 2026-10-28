"""Calibration evidence gates (owner's brief item 7; design §6 "Operating point", §7). Research use only.

The defect: ``fit_calibration`` gated on ``MIN_PER_CLASS`` ITEMS (bags) per class, so four positive patients with
three slides each (twelve positive bags) passed a "5 per class" gate. Bags of one patient, and of patients joined by
a confirmed near-duplicate decision, are not independent evidence.

The gate now counts DISTINCT patient groups per class (a patient, or the union-find group of patients a person
confirmed as duplicates); below it the operating point records ``calibration_selection.status:
insufficient_evidence`` with the counts, and the identity map is frozen. A calibration that WAS fitted is measured on
the same development scores it was fitted on, so every development calibration report is labelled in-sample, and
the selection says that a fitted map is not a validated clinical probability. Threshold-dependent development
metrics stay labelled as tuning estimates.
"""

from __future__ import annotations

import hashlib
import uuid

import numpy as np
import pytest

from test_ml_support import CID, FAST, LEAD, custom_dataset, run_jobs

CTX = {"split_salt": "cal-evidence", "patient_label_rule": "any_positive", "duplicate_pairs": []}


def _params(**kw):
    from dermpath.ml.config import resolve_params

    return resolve_params({"n_boot": 50, "min_threshold_evidence": 1, **kw})


def _scored(spec: list[tuple[str, int, int]], *, seed: int = 0):
    """ScoredBags from ``[(patient_code, label, n_bags)]`` with informative, overlapping scores."""
    from dermpath.ml.heads import Bag
    from dermpath.ml.training import ScoredBag

    rng = np.random.default_rng(seed)
    out = []
    for code, label, n in spec:
        pid = uuid.uuid4().hex
        for j in range(n):
            b = Bag(bag_id=uuid.uuid4().hex, kind="slide", slide_ids=[uuid.uuid4().hex], case_id=None, patient_id=pid,
                    patient_code=code, label_value="bcc_present" if label else "bcc_absent_not_benign", label=label,
                    label_version_ids=[], attributes={},
                    slide_sha256s=[hashlib.sha256(f"{code}|{j}".encode()).hexdigest()])
            s = float(np.clip(0.5 + 0.25 * (label - 0.5) + rng.normal(0, 0.2), 0.01, 0.99))
            out.append(ScoredBag(b, s))
    return out


# =========================================================================== the gate (pure)


def test_fit_calibration_counts_distinct_patient_groups_not_bags():
    from dermpath.ml import calibration as CAL

    # 4 positive patients x 3 bags = 12 positive bags; 20 negative patients.
    groups = [f"P{i // 3}" for i in range(12)] + [f"N{i}" for i in range(20)]
    y = np.array([1] * 12 + [0] * 20)
    s = np.linspace(0.05, 0.95, 32)
    with pytest.raises(CAL.InsufficientCalibrationEvidence) as exc:
        CAL.fit_calibration(s, y, method="platt", item_splits=["oof"] * 32, groups=groups)
    ev = exc.value.evidence
    assert ev["unit"] == "patient_groups" and ev["positive_units"] == 4 and ev["negative_units"] == 20
    assert ev["positive_items"] == 12 and ev["min_per_class"] == CAL.MIN_PER_CLASS
    assert "4 positive and 20 negative patient group(s)" in str(exc.value)
    assert isinstance(exc.value, CAL.CalibrationError)  # existing handlers keep working
    # One more positive PATIENT (not one more bag) clears the gate; the counts are recorded with the fit.
    groups5 = [f"P{i // 3}" for i in range(15)] + [f"N{i}" for i in range(20)]
    y5 = np.array([1] * 15 + [0] * 20)
    p = CAL.fit_calibration(np.linspace(0.05, 0.95, 35), y5, method="isotonic", item_splits=["oof"] * 35,
                            groups=groups5)
    assert p["fitted_on"]["evidence"] == {"unit": "patient_groups", "positive_units": 5, "negative_units": 20,
                                          "positive_items": 15, "negative_items": 20,
                                          "min_per_class": CAL.MIN_PER_CLASS}
    with pytest.raises(CAL.CalibrationError, match="groups has"):
        CAL.fit_calibration(s, y, method="platt", item_splits=["oof"] * 32, groups=groups[:5])


def test_mixed_label_patient_counts_once_in_each_class_it_has():
    from dermpath.ml import calibration as CAL

    groups = ["A", "A", "B", "C", "D", "E"] + [f"N{i}" for i in range(6)]
    y = np.array([1, 0, 1, 1, 1, 1] + [0] * 6)
    p = CAL.fit_calibration(np.linspace(0.1, 0.9, 12), y, method="isotonic", item_splits=["val"] * 12, groups=groups)
    assert p["fitted_on"]["evidence"]["positive_units"] == 5 and p["fitted_on"]["evidence"]["negative_units"] == 7


def test_operating_point_gate_counts_patients_and_confirmed_duplicate_groups():
    from dermpath.ml.training import select_operating_point

    spec = [(f"POS-{i}", 1, 3) for i in range(6)] + [(f"NEG-{i}", 0, 1) for i in range(12)]
    dev = _scored(spec)
    params = _params(calibration="platt")
    op = select_operating_point(dev, params, selected_on="oof", context=CTX)
    sel = op["calibration_selection"]
    assert sel["status"] == "fitted" and op["calibration"]["method"] == "platt"
    assert sel["evidence"]["positive_units"] == 6 and sel["evidence"]["positive_items"] == 18
    # Two confirmed-duplicate decisions join POS-0/POS-1 and POS-2/POS-3: 4 positive groups < 5.
    pid = {sb.bag.patient_code: sb.bag.patient_id for sb in dev}
    ctx = {**CTX, "duplicate_pairs": [(pid["POS-0"], pid["POS-1"]), (pid["POS-2"], pid["POS-3"])]}
    op2 = select_operating_point(dev, params, selected_on="oof", context=ctx)
    sel2 = op2["calibration_selection"]
    assert sel2["status"] == "insufficient_evidence" and op2["calibration"]["method"] == "none"
    assert sel2["evidence"]["positive_units"] == 4 and sel2["evidence"]["unit"] == "patient_groups"
    assert "insufficient evidence" in sel2["reason"]
    # 18 positive BAGS from only 4 patients: never enough.
    few = _scored([(f"POS-{i}", 1, 6) for i in range(4)] + [(f"NEG-{i}", 0, 2) for i in range(10)], seed=1)
    op3 = select_operating_point(few, params, selected_on="val")
    assert op3["calibration_selection"]["status"] == "insufficient_evidence"
    assert op3["calibration_selection"]["evidence"]["positive_items"] == 24


def test_fitted_calibration_is_labelled_in_sample_and_not_a_validated_probability():
    from dermpath.ml.training import development_summary, select_operating_point

    dev = _scored([(f"POS-{i}", 1, 2) for i in range(8)] + [(f"NEG-{i}", 0, 2) for i in range(10)], seed=2)
    params = _params(calibration="isotonic")
    op = select_operating_point(dev, params, selected_on="oof", context=CTX)
    sel = op["calibration_selection"]
    assert sel["status"] == "fitted" and sel["evaluated_in_sample"] is True
    assert "not a validated" in sel["reliability_note"]
    s = development_summary(dev, [], op, params, 0, split="oof", protocol="dev_cv")
    assert s["calibration"]["calibrated_in_sample"] is True
    assert "in-sample" in s["calibration"]["calibrated_note"]
    assert s["calibration"]["calibrated"] is not None
    # Preserved: threshold-dependent development metrics after threshold selection are tuning estimates.
    assert s["tuning_set"] is True and s["at_operating_point"]["sensitivity"]["tuning_set"] is True
    # Not requested: nothing is labelled as a fitted calibration.
    op0 = select_operating_point(dev, _params(), selected_on="oof", context=CTX)
    s0 = development_summary(dev, [], op0, _params(), 0, split="oof", protocol="dev_cv")
    assert op0["calibration_selection"]["status"] == "not_requested"
    assert s0["calibration"]["calibrated"] is None and s0["calibration"]["calibrated_in_sample"] is False


# =========================================================================== worker / API


def _few_positive_patients_many_bags_dataset() -> str:
    """Validation holds 4 positive patients with 2+ slides each (8+ positive bags) and 6 negative patients."""
    state = {"val_pos": 0, "val_neg": 0, "test": 0}

    def assign(code, labels):
        pos = all(v == "bcc_present" for v in labels)
        neg = all(v != "bcc_present" for v in labels)
        if pos and len(labels) >= 2 and state["val_pos"] < 4:
            state["val_pos"] += 1
            return "val"
        if neg and state["val_neg"] < 6:
            state["val_neg"] += 1
            return "val"
        if state["test"] < 6:
            state["test"] += 1
            return "test"
        return "train"

    dv = custom_dataset(CID, "calibration evidence gate", assign)
    assert state["val_pos"] == 4 and state["val_neg"] == 6, state
    return dv


def test_worker_refuses_to_fit_calibration_on_four_patients_whatever_their_bag_count(env, ids, clients):
    from dermpath.db import session_scope
    from dermpath.ml.models import Prediction, TrainingRun
    from sqlalchemy import select

    dv = _few_positive_patients_many_bags_dataset()
    lead = clients(LEAD)
    r = lead.post(f"/api/v1/projects/{CID}/experiments",
                  json={"dataset_version_id": dv, "encoder_id": "synthetic-deterministic-v1",
                        "head": "meanpool_logreg", "seed": 0, "evaluation_protocol": "holdout",
                        "params": {**FAST, "calibration": "platt", "min_threshold_evidence": 3}})
    assert r.status_code == 202, r.text
    rid = r.json()["experiment"]["id"]
    assert [o.status for o in run_jobs()] == ["succeeded"]
    with session_scope() as db:
        run = db.get(TrainingRun, rid)
        val = db.scalars(select(Prediction).where(Prediction.run_id == rid, Prediction.split == "val")).all()
        pos_bags = sum(p.label for p in val)
        pos_patients = len({p.coded_patient_id for p in val if p.label == 1})
        cal, metrics = dict(run.calibration_json), dict(run.metrics_json)
    assert pos_patients == 4 and pos_bags >= 5  # enough bags for the old gate, too few patients
    sel = metrics["operating_point"]["calibration"]
    assert sel["status"] == "insufficient_evidence" and cal["method"] == "none"
    assert sel["evidence"]["positive_units"] == 4 and sel["evidence"]["positive_items"] == pos_bags
    body = lead.get(f"/api/v1/experiments/{rid}").json()
    assert body["operating_point"]["calibration"]["status"] == "insufficient_evidence"


def test_dev_cv_calibration_report_is_labelled_in_sample_end_to_end(env, ids, clients):
    from test_ml_support import cohort

    lead = clients(LEAD)
    r = lead.post(f"/api/v1/projects/{CID}/experiments",
                  json={"dataset_version_id": cohort(ids)["dataset_version_id"],
                        "encoder_id": "synthetic-deterministic-v1", "head": "meanpool_logreg", "seed": 3,
                        "evaluation_protocol": "dev_cv",
                        "params": {**FAST, "calibration": "isotonic", "cv_folds": 3, "min_threshold_evidence": 5}})
    assert r.status_code == 202, r.text
    rid = r.json()["experiment"]["id"]
    assert [o.status for o in run_jobs()] == ["succeeded"]
    body = lead.get(f"/api/v1/experiments/{rid}").json()
    sel = body["operating_point"]["calibration"]
    assert sel["status"] == "fitted" and sel["evaluated_in_sample"] is True and sel["evidence"]["unit"] == \
        "patient_groups"
    summ = body["oof_summary"]
    assert summ["calibration"]["calibrated_in_sample"] is True and summ["tuning_set"] is True
    ev = lead.get(f"/api/v1/experiments/{rid}/evaluation?split=oof").json()
    assert ev["calibration"]["frozen_calibration"]["in_sample"] is True and "in-sample" in ev["calibration"][
        "calibrated_note"]
    assert ev["development_summary"]["calibration"]["calibrated_in_sample"] is True
