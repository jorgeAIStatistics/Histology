"""Evaluation metrics as pure functions: agreement with scikit-learn, undefined metrics,
patient-cluster bootstrap correctness, calibration, coverage, subgroups, threshold rules
(acceptance 11 at the function level)."""

from __future__ import annotations

import numpy as np
import pytest
from sklearn.metrics import average_precision_score, roc_auc_score

from dermpath.ml import metrics as M

# --------------------------------------------------------------------------- AUROC / AUPRC


def test_auroc_equals_sklearn_on_a_fixed_example():
    y = np.array([0, 0, 1, 1, 0, 1, 0, 1, 1, 0])
    s = np.array([0.1, 0.4, 0.35, 0.8, 0.4, 0.9, 0.05, 0.4, 0.65, 0.3])  # includes tied scores across classes
    expected = roc_auc_score(y, s)
    assert expected == pytest.approx(0.88)  # 22 of 25 positive/negative pairs ordered (ties count 1/2)
    assert M.auroc_fast(y, s) == pytest.approx(expected, abs=1e-12)
    _, m = M.point_metrics(y, s, (s >= 0.5).astype(int))
    assert m["auroc"]["defined"] is True and m["auroc"]["value"] == pytest.approx(expected, abs=1e-12)
    assert m["auprc"]["value"] == pytest.approx(average_precision_score(y, s), abs=1e-12)


@pytest.mark.parametrize("seed", range(20))
def test_fast_rank_metrics_match_sklearn_with_ties(seed):
    rng = np.random.default_rng(seed)
    n = int(rng.integers(2, 60))
    y = rng.integers(0, 2, n)
    if y.min() == y.max():
        y[0] = 1 - y[0]
    s = np.round(rng.random(n), 1)  # coarse rounding → many ties
    assert M.auroc_fast(y, s) == pytest.approx(roc_auc_score(y, s), abs=1e-12)
    assert M.average_precision_fast(y, s) == pytest.approx(average_precision_score(y, s), abs=1e-12)


# --------------------------------------------------------------------------- undefined metrics


def test_missing_class_all_negatives_and_zero_denominators():
    y = np.zeros(6, dtype=int)
    s = np.array([0.1, 0.2, 0.3, 0.2, 0.1, 0.05])
    pred = (s >= 0.5).astype(int)  # nothing predicted positive
    c, m = M.point_metrics(y, s, pred)
    assert c == {"tp": 0, "fp": 0, "tn": 6, "fn": 0}
    assert m["sensitivity"] == {"value": None, "numerator": 0, "denominator": 0, "ci": None,
                                "undefined_reason": "undefined (denominator 0: no positive items)"}
    assert m["ppv"]["value"] is None and m["ppv"]["denominator"] == 0 and "predicted positive" in m["ppv"]["undefined_reason"]
    assert m["specificity"]["value"] == 1.0 and (m["specificity"]["numerator"], m["specificity"]["denominator"]) == (6, 6)
    assert m["npv"]["value"] == 1.0
    for k in ("auroc", "auprc"):
        assert m[k]["defined"] is False and m[k]["value"] is None and "both classes" in m[k]["undefined_reason"]


def test_empty_split_is_all_undefined_not_an_error():
    c, m = M.point_metrics([], [], [])
    assert c == {"tp": 0, "fp": 0, "tn": 0, "fn": 0}
    assert all(m[k]["value"] is None for k in ("sensitivity", "specificity", "ppv", "npv", "auroc", "auprc"))
    assert M.calibration([], [])["brier"] is None and M.coverage_curve([], [], [], 0.5) == []
    t = M.select_threshold([], [], rule="youden")
    assert t["selection_status"] == "fallback" and t["value"] == 0.5 and "empty" in t["reason"]


def test_small_samples_give_null_cis_with_reasons():
    y = [1, 0, 1, 0]
    s = [0.9, 0.2, 0.4, 0.6]
    pred = [1, 0, 0, 1]
    cis, info = M.bootstrap_cis(y, s, pred, ["p1", "p1", "p2", "p2"], n_boot=200, seed=0, min_patients=10)
    assert info["status"].startswith("insufficient evidence") and info["n_patients"] == 2
    assert all(v["ci"] is None and "insufficient evidence" in v["ci_reason"] for v in cis.values())
    cis0, info0 = M.bootstrap_cis(y, s, pred, ["a", "b", "c", "d"], n_boot=0, seed=0, min_patients=2)
    assert all(v["ci"] is None for v in cis0.values()) and "disabled" in info0["status"]


def test_bootstrap_ci_is_null_when_metric_is_mostly_undefined():
    # One positive patient among 12: most replicates have no positives → sensitivity CI is null.
    patients = [f"p{i}" for i in range(12)]
    y = [1] + [0] * 11
    s = [0.9] + [0.1] * 11
    cis, info = M.bootstrap_cis(y, s, [1] + [0] * 11, patients, n_boot=300, seed=1, min_patients=10)
    assert info["status"] == "ok"
    assert cis["sensitivity"]["ci"] is None and "undefined in" in cis["sensitivity"]["ci_reason"]
    assert cis["specificity"]["ci"] == [1.0, 1.0]


# --------------------------------------------------------------------------- patient-cluster bootstrap


def test_patient_cluster_bootstrap_resamples_patients_not_items():
    """Patient A: 10 true positives. Patient B: 1 false negative. Patient C: 1 true negative.
    Resampling PATIENTS can only produce sensitivities of the form 10a/(10a+b); an item-level
    bootstrap would produce many other values (e.g. 7/8)."""
    patients = ["A"] * 10 + ["B", "C"]
    y = np.array([1] * 10 + [1, 0])
    s = np.array([0.9] * 10 + [0.2, 0.1])
    pred = (s >= 0.5).astype(int)
    reps = M.bootstrap_replicates(y, s, pred, patients, n_boot=400, seed=3)
    achievable = {10 * a / (10 * a + b) for a in range(4) for b in range(4) if a + b > 0}
    sens = [v for v in reps["sensitivity"] if v is not None]
    assert sens and set(np.round(sens, 12)) <= set(np.round(list(achievable), 12))
    assert len(set(sens)) > 2  # it really varies

    # Exact reproduction with the same RNG stream: draw patient indices, keep all their items.
    rng = np.random.default_rng(3)
    keys = sorted(set(patients))
    idx_by = {k: [i for i, p in enumerate(patients) if p == k] for k in keys}
    for b in range(400):
        draw = rng.integers(0, len(keys), size=len(keys))
        idx = [i for d in draw for i in idx_by[keys[d]]]
        tp = sum(1 for i in idx if y[i] == 1 and pred[i] == 1)
        pos = sum(1 for i in idx if y[i] == 1)
        expected = tp / pos if pos else None
        got = reps["sensitivity"][b]
        assert (got is None and expected is None) or got == pytest.approx(expected)


def test_bootstrap_is_seeded_and_perfect_data_gives_degenerate_interval():
    patients = [f"p{i // 2}" for i in range(40)]
    y = np.array([i % 2 for i in range(40)])
    s = np.where(y == 1, 0.9, 0.1)
    pred = (s >= 0.5).astype(int)
    a, _ = M.bootstrap_cis(y, s, pred, patients, n_boot=300, seed=11, min_patients=10)
    b, _ = M.bootstrap_cis(y, s, pred, patients, n_boot=300, seed=11, min_patients=10)
    assert a == b
    assert a["sensitivity"]["ci"] == [1.0, 1.0] and a["auroc"]["ci"] == [1.0, 1.0]


# --------------------------------------------------------------------------- calibration / coverage / subgroups


def test_calibration_brier_ece_on_a_known_example():
    y = np.array([0, 0, 1, 1])
    s = np.array([0.05, 0.15, 0.85, 0.95])
    cal = M.calibration(y, s)
    assert cal["brier"] == pytest.approx(np.mean((s - y) ** 2))
    # Bin [0.0,0.1): mean 0.05, frac 0; [0.1,0.2): 0.15 vs 0; [0.8,0.9): 0.85 vs 1; [0.9,1.0]: 0.95 vs 1.
    assert cal["ece"] == pytest.approx((0.05 + 0.15 + 0.15 + 0.05) / 4)
    assert sum(b["n"] for b in cal["bins"]) == 4 and cal["note"] == "scores are not probabilities unless calibrated"


def test_coverage_curve_abstains_closest_to_threshold_first():
    y = np.array([1, 0, 1, 0])
    s = np.array([0.95, 0.05, 0.52, 0.49])  # all correct at t=0.5
    s2 = np.array([0.95, 0.05, 0.48, 0.51])  # the two near-threshold items are wrong
    pred = (s2 >= 0.5).astype(int)
    curve = M.coverage_curve(y, s2, pred, 0.5, steps=2)
    assert curve[0] == {"coverage": 1.0, "error_rate": 0.5, "n_kept": 4, "abstained": 0}
    assert curve[1] == {"coverage": 0.5, "error_rate": 0.0, "n_kept": 2, "abstained": 2}
    assert M.coverage_curve(y, s, (s >= 0.5).astype(int), 0.5)[0]["error_rate"] == 0.0


def test_subgroups_report_insufficient_evidence_below_min_n_or_single_class():
    n = 30
    y = np.array([i % 2 for i in range(n)])
    s = np.where(y == 1, 0.8, 0.2)
    attrs = [{"scanner_id": "scanner-a" if i < 24 else "scanner-b", "site_id": "site-1", "stain": "H&E"} for i in range(n)]
    attrs[0]["stain"] = "PAS"
    rows = {(r["key"], r["value"]): r for r in M.subgroups(y, s, (s >= 0.5).astype(int), attrs, min_n=10)}
    assert rows[("scanner_id", "scanner-a")]["status"] == "ok" and rows[("scanner_id", "scanner-a")]["n"] == 24
    assert rows[("scanner_id", "scanner-b")]["status"] == "insufficient_evidence"
    assert rows[("scanner_id", "scanner-b")]["metrics"] is None and "n=6 < 10" in rows[("scanner_id", "scanner-b")]["reason"]
    assert rows[("stain", "PAS")]["status"] == "insufficient_evidence" and "both classes" in rows[("stain", "PAS")]["reason"]
    one_class = M.subgroups(np.zeros(12, int), np.full(12, 0.3), np.zeros(12, int), [{"site_id": "x"}] * 12,
                            keys=("site_id",), min_n=10)
    assert one_class[0]["status"] == "insufficient_evidence" and "both classes" in one_class[0]["reason"]


# --------------------------------------------------------------------------- threshold selection (validation only)


def test_youden_threshold_selection():
    y = np.array([0, 0, 0, 1, 1, 1])
    s = np.array([0.1, 0.2, 0.6, 0.4, 0.7, 0.9])
    t = M.select_threshold(y, s, rule="youden")
    # Candidates (>=): 0.4 gives sens 1, spec 2/3 → J=0.667 (best); 0.7 gives sens 2/3, spec 1 → J=0.667 (tie;
    # higher sensitivity wins).
    assert t["value"] == pytest.approx(0.4) and t["selection_status"] == "selected"
    assert t["youden_j"] == pytest.approx(2 / 3) and t["val_sensitivity_at_threshold"] == 1.0


def test_target_sensitivity_threshold_and_fallbacks():
    y = np.array([0, 0, 0, 1, 1, 1, 1])
    s = np.array([0.1, 0.5, 0.3, 0.2, 0.6, 0.7, 0.9])
    t = M.select_threshold(y, s, rule="target_sensitivity", target_sensitivity=0.75)
    assert t["value"] == pytest.approx(0.6) and t["val_sensitivity_at_threshold"] == 0.75
    only_neg = M.select_threshold(np.zeros(4, int), np.array([0.1, 0.2, 0.3, 0.4]), rule="youden")
    assert only_neg["rule"] == "fixed_0.5_fallback" and only_neg["selection_status"] == "fallback"
    assert "lacks a class" in only_neg["reason"] and "unvalidated" in only_neg["reason"]
    only_pos = M.select_threshold(np.ones(3, int), np.array([0.6, 0.7, 0.8]), rule="target_sensitivity",
                                  target_sensitivity=0.9)
    assert only_pos["selection_status"] == "selected"  # sensitivity needs positives only
