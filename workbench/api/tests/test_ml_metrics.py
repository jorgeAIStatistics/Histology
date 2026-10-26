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


# =========================================================================== design §7 API


def _walk_json(obj):
    """Fails on anything json cannot serialise (numpy scalars included)."""
    import json

    json.dumps(obj, allow_nan=False)


def _random_cohort(seed: int, n_patients: int = 40, max_bags: int = 3, ties: bool = True):
    rng = np.random.default_rng(seed)
    patients, y = [], []
    for i in range(n_patients):
        for _ in range(int(rng.integers(1, max_bags + 1))):
            patients.append(f"pt{i:03d}")
            y.append(int(rng.random() < 0.35))
    y = np.array(y)
    s = np.clip(0.3 * y + 0.7 * rng.random(y.size), 0.0, 1.0)
    if ties:
        s = np.round(s, 1)
    return y, s, patients


# --------------------------------------------------------------------------- tie-correct rank metrics


@pytest.mark.parametrize("seed", range(12))
def test_evaluate_binary_rank_metrics_are_tie_correct_against_sklearn(seed):
    y, s, patients = _random_cohort(seed)
    if y.min() == y.max():
        y[0] = 1 - y[0]
    ev = M.evaluate_binary(y, s, patients, threshold=0.5, n_boot=0)
    assert ev["metrics"]["auroc"]["value"] == pytest.approx(roc_auc_score(y, s), abs=1e-12)
    assert ev["metrics"]["auprc"]["value"] == pytest.approx(average_precision_score(y, s), abs=1e-12)
    assert ev["metrics"]["auprc"]["prevalence_baseline"] == pytest.approx(y.mean())
    assert ev["metrics"]["auroc"]["threshold_dependent"] is False and "brier" in ev["threshold_free_metrics"]


def test_rank_metrics_are_invariant_to_item_order_with_ties():
    y, s, patients = _random_cohort(3)
    perm = np.random.default_rng(1).permutation(y.size)
    a = M.evaluate_binary(y, s, patients, threshold=0.5, n_boot=0)
    b = M.evaluate_binary(y[perm], s[perm], [patients[i] for i in perm], threshold=0.5, n_boot=0)
    for k in ("auroc", "auprc", "brier", "sensitivity", "specificity"):
        assert a["metrics"][k]["value"] == pytest.approx(b["metrics"][k]["value"], abs=1e-12)


# --------------------------------------------------------------------------- PPV / NPV and prevalence


def test_ppv_npv_state_evaluation_prevalence_and_bayes_adjustment():
    # 20 positives (18 TP), 80 negatives (64 TN) → sens 0.9, spec 0.8, evaluation prevalence 0.2.
    y = np.array([1] * 20 + [0] * 80)
    s = np.array([0.9] * 18 + [0.1] * 2 + [0.1] * 64 + [0.9] * 16)
    patients = [f"p{i}" for i in range(100)]
    ev = M.evaluate_binary(y, s, patients, threshold=0.5, target_prevalence=0.1, n_boot=0)
    assert ev["evaluation_prevalence"]["value"] == pytest.approx(0.2)
    assert (ev["evaluation_prevalence"]["numerator"], ev["evaluation_prevalence"]["denominator"]) == (20, 100)
    assert "depend on prevalence" in ev["evaluation_prevalence"]["note"]
    assert ev["metrics"]["ppv"]["value"] == pytest.approx(18 / 34)
    assert ev["metrics"]["ppv"]["evaluation_prevalence"] == 0.2
    adj = ev["prevalence_adjusted"]
    assert adj["target_prevalence"] == 0.1
    assert adj["ppv"]["value"] == pytest.approx(0.09 / (0.09 + 0.18))  # Se·π / (Se·π + (1−Sp)(1−π)) = 1/3
    assert adj["npv"]["value"] == pytest.approx(0.72 / (0.72 + 0.01))
    # At the evaluation prevalence, Bayes reproduces the empirical PPV/NPV exactly.
    same = M.prevalence_adjusted_predictive_values(0.9, 0.8, 0.2)
    assert same["ppv"]["value"] == pytest.approx(18 / 34) and same["npv"]["value"] == pytest.approx(64 / 66)


def test_prevalence_adjusted_values_report_undefined_reasons():
    none = M.prevalence_adjusted_predictive_values(None, 0.8, 0.1)
    assert none["ppv"]["value"] is None and "needs both" in none["ppv"]["undefined_reason"]
    no_calls = M.prevalence_adjusted_predictive_values(0.0, 1.0, 0.1)
    assert no_calls["ppv"]["value"] is None and "no positive calls" in no_calls["ppv"]["undefined_reason"]
    assert no_calls["npv"]["value"] == pytest.approx(0.9)
    for bad in (0.0, 1.0, -0.1, 1.5):
        with pytest.raises(ValueError):
            M.prevalence_adjusted_predictive_values(0.9, 0.8, bad)


# --------------------------------------------------------------------------- calibration report


@pytest.mark.parametrize("strategy", ["uniform", "quantile"])
@pytest.mark.parametrize("seed", range(4))
def test_calibration_report_matches_sklearn_bins_and_brier(strategy, seed):
    from sklearn.calibration import calibration_curve
    from sklearn.metrics import brier_score_loss

    rng = np.random.default_rng(seed)
    s = rng.random(200)
    y = (rng.random(200) < s).astype(int)
    rep = M.calibration_report(y, s, n_bins=10, strategy=strategy)
    prob_true, prob_pred = calibration_curve(y, s, n_bins=10, strategy=strategy)
    nonempty = [b for b in rep["bins"] if b["n"]]
    assert [b["fraction_positive"] for b in nonempty] == pytest.approx(list(prob_true), abs=1e-12)
    assert [b["mean_score"] for b in nonempty] == pytest.approx(list(prob_pred), abs=1e-12)
    assert sum(b["n"] for b in rep["bins"]) == 200 and rep["n_empty_bins"] == 10 - len(nonempty)
    assert rep["brier"] == pytest.approx(brier_score_loss(y, s), abs=1e-12)
    manual = sum(b["n"] / 200 * abs(b["mean_score"] - b["fraction_positive"]) for b in nonempty)
    assert rep["ece"] == pytest.approx(manual) and rep["mce"] == pytest.approx(max(b["gap"] for b in nonempty))
    if strategy == "quantile":
        assert rep["binning"] == "equal-mass" and all(b["n"] == 20 for b in rep["bins"])
    _walk_json(rep)


def test_calibration_report_refuses_non_probabilities_and_handles_empty():
    with pytest.raises(ValueError, match=r"\[0.0, 1.0\]"):
        M.calibration_report([0, 1], [0.2, 1.3])
    empty = M.calibration_report([], [])
    assert empty["ece"] is None and empty["brier"] is None and "no scored items" in empty["undefined_reason"]
    ev = M.evaluate_binary([0, 1, 0, 1], [-2.0, 3.0, -1.0, 0.5], ["a", "b", "c", "d"], threshold=0.0, n_boot=0)
    assert ev["metrics"]["brier"]["value"] is None and "not in [0, 1]" in ev["metrics"]["brier"]["undefined_reason"]
    assert ev["calibration"]["raw"]["status"] == "not_applicable"


def test_evaluate_binary_reports_raw_and_calibrated_calibration():
    y, s, patients = _random_cohort(2, ties=False)
    cal = np.clip(s * 0.8 + 0.1, 0, 1)
    ev = M.evaluate_binary(y, s, patients, threshold=0.5, calibrated_scores=cal, n_boot=0)
    assert ev["calibration"]["raw"]["equal_width"]["brier"] == pytest.approx(np.mean((s - y) ** 2))
    assert ev["calibration"]["calibrated"]["equal_mass"]["brier"] == pytest.approx(np.mean((cal - y) ** 2))
    assert ev["calibration"]["raw"]["logistic_recalibration"]["slope"] is not None


# --------------------------------------------------------------------------- patient-cluster bootstrap


def test_patient_bootstrap_indices_move_all_bags_of_a_patient_together():
    rng = np.random.default_rng(0)
    patients = []
    for i in range(25):
        patients += [f"q{i}"] * int(rng.integers(1, 5))
    order = rng.permutation(len(patients))
    patients = [patients[i] for i in order]  # bags of one patient are not contiguous
    groups = {p: sorted(i for i, q in enumerate(patients) if q == p) for p in set(patients)}
    for idx in M.patient_bootstrap_indices(patients, n_boot=200, seed=4):
        drawn: dict = {}
        for i in idx.tolist():
            drawn.setdefault(patients[i], []).append(i)
        for p, got in drawn.items():
            size = len(groups[p])
            assert len(got) % size == 0  # whole copies of the patient only
            assert sorted(got) == sorted(groups[p] * (len(got) // size))
        assert sum(len(groups[p]) * (len(v) // len(groups[p])) for p, v in drawn.items()) == idx.size


def test_patient_bootstrap_stream_equals_legacy_replicates_and_stratified_keeps_class_counts():
    y, s, patients = _random_cohort(5)
    pred = (s >= 0.5).astype(int)
    legacy = M.bootstrap_replicates(y, s, pred, patients, n_boot=100, seed=9)
    for idx, old in zip(M.patient_bootstrap_indices(patients, n_boot=100, seed=9), legacy["sensitivity"]):
        pos = y[idx] == 1
        new = float((pred[idx][pos] == 1).sum() / pos.sum()) if pos.any() else None
        assert (new is None and old is None) or new == pytest.approx(old)
    strata = M.patient_strata(y, patients)
    n_pos_patients = sum(strata.values())
    first_bag = {}
    for i, p in enumerate(patients):
        first_bag.setdefault(p, i)
    for idx in M.patient_bootstrap_indices(patients, n_boot=100, seed=9, strata=strata):
        # every drawn copy of a patient contains its first bag exactly once
        drawn = [patients[i] for i in idx.tolist() if first_bag[patients[i]] == i]
        assert sum(strata[p] for p in drawn) == n_pos_patients
        assert len(drawn) == len(strata)


def test_unscorable_bags_move_with_their_patient_in_the_bootstrap():
    """Each patient has one scored true positive and one unscorable positive. If the bags of a
    patient move together, intention-to-evaluate sensitivity is exactly 1/2 in EVERY replicate."""
    patients = [f"p{i}" for i in range(15)]
    ev = M.evaluate_binary([1] * 15 + [0] * 15, [0.9] * 15 + [0.1] * 15, patients + [f"n{i}" for i in range(15)],
                           threshold=0.5, unscorable_y=[1] * 15, unscorable_patients=patients, n_boot=300, seed=2)
    ite = ev["intention_to_evaluate"]["sensitivity"]
    assert (ite["numerator"], ite["denominator"]) == (15, 30) and ite["ci"] == [0.5, 0.5]
    assert ev["metrics"]["sensitivity"]["value"] == 1.0 and ev["n_unscorable"] == 15
    assert ev["bootstrap"]["n_patients"] == 30


def test_cis_are_reported_only_when_the_metric_is_defined():
    y = np.zeros(30, dtype=int)
    s = np.linspace(0.0, 0.9, 30)
    ev = M.evaluate_binary(y, s, [f"p{i}" for i in range(30)], threshold=0.5, n_boot=200, seed=0)
    m = ev["metrics"]
    for k in ("sensitivity", "auroc", "auprc"):
        assert m[k]["value"] is None and m[k]["ci"] is None and m[k]["ci_reason"] == m[k]["undefined_reason"]
    assert m["specificity"]["ci"] is not None and m["specificity"]["ci_valid_replicates"] == 200
    few = M.evaluate_binary([1, 0, 1, 0], [0.9, 0.1, 0.8, 0.3], ["a", "a", "b", "b"], threshold=0.5, n_boot=200)
    assert all(few["metrics"][k]["ci"] is None and "insufficient evidence" in few["metrics"][k]["ci_reason"]
               for k in ("sensitivity", "specificity", "auroc"))
    assert few["bootstrap"]["status"].startswith("insufficient evidence")


def test_evaluate_binary_is_seeded_and_serialisable():
    y, s, patients = _random_cohort(7)
    a = M.evaluate_binary(y, s, patients, threshold=0.5, target_prevalence=0.05, n_boot=200, seed=3)
    b = M.evaluate_binary(y, s, patients, threshold=0.5, target_prevalence=0.05, n_boot=200, seed=3)
    assert a == b
    _walk_json(a)
    assert a["prevalence_adjusted"]["ppv"]["ci"] is not None
    with pytest.raises(ValueError, match="finite"):
        M.evaluate_binary([0, 1], [0.1, float("nan")], ["a", "b"], threshold=0.5)
    with pytest.raises(ValueError, match="0 \\(negative class\\) or 1"):
        M.evaluate_binary([0, 2], [0.1, 0.2], ["a", "b"], threshold=0.5)


def test_tuning_set_marks_threshold_dependent_metrics_as_optimistic():
    y, s, patients = _random_cohort(8)
    ev = M.evaluate_binary(y, s, patients, threshold=0.5, n_boot=0, tuning_set=True)
    assert ev["operating_point"]["tuning_set"] is True and "optimistic" in ev["operating_point"]["note"]
    assert all(ev["metrics"][k]["tuning_set"] is True for k in ("sensitivity", "specificity", "ppv", "npv"))
    assert all("tuning_set" not in ev["metrics"][k] for k in ("auroc", "auprc", "brier"))


# --------------------------------------------------------------------------- intention to evaluate


def test_intention_to_evaluate_counts_unscorable_positives_missed_and_negatives_flagged():
    y = [1] * 10 + [0] * 10
    s = [0.9] * 8 + [0.1] * 2 + [0.1] * 9 + [0.9]
    patients = [f"p{i}" for i in range(20)]
    ev = M.evaluate_binary(y, s, patients, threshold=0.5, unscorable_y=[1, 1, 0, 0, 0],
                           unscorable_patients=["u1", "u2", "u3", "u4", "u5"], n_boot=0)
    assert ev["metrics"]["sensitivity"]["value"] == pytest.approx(8 / 10)
    assert ev["metrics"]["specificity"]["value"] == pytest.approx(9 / 10)
    ite = ev["intention_to_evaluate"]
    assert (ite["sensitivity"]["numerator"], ite["sensitivity"]["denominator"]) == (8, 12)
    assert (ite["specificity"]["numerator"], ite["specificity"]["denominator"]) == (9, 13)
    assert ite["n_unscorable"] == 5 and "missed" in ite["rule"] and "flagged" in ite["rule"]
    assert (ev["unscorable_positives"], ev["unscorable_negatives"]) == (2, 3)


# --------------------------------------------------------------------------- operating threshold


@pytest.mark.parametrize("seed", range(10))
def test_select_operating_threshold_agrees_with_legacy_rules_when_evidence_suffices(seed):
    rng = np.random.default_rng(seed)
    y = np.array([1] * 15 + [0] * 25)
    s = np.round(np.clip(0.3 * y + 0.7 * rng.random(40), 0, 1), 2)
    for rule in ("youden", "target_sensitivity"):
        old = M.select_threshold(y, s, rule=rule, target_sensitivity=0.8)
        new = M.select_operating_threshold(y, s, rule=rule, target_sensitivity=0.8)
        assert new["selection_status"] == "selected" and new["value"] == pytest.approx(old["value"])
        assert new["at_threshold"]["sensitivity"]["value"] == pytest.approx(old["val_sensitivity_at_threshold"])
        assert new["tuning_set_note"] == "optimistic: the threshold was chosen on these data"
        lo, hi = new["at_threshold"]["sensitivity"]["exact_ci"]
        assert lo <= new["at_threshold"]["sensitivity"]["value"] <= hi


def test_threshold_minimum_evidence_counts_patients_and_is_configurable():
    # 3 positive PATIENTS carrying 12 positive bags; 12 negative patients.
    patients = [f"pos{i % 3}" for i in range(12)] + [f"neg{i}" for i in range(12)]
    y = np.array([1] * 12 + [0] * 12)
    s = np.r_[np.linspace(0.6, 0.95, 12), np.linspace(0.05, 0.55, 12)]
    out = M.select_operating_threshold(y, s, rule="youden", patients=patients, min_positives=5, min_negatives=5)
    assert out["selection_status"] == "insufficient_evidence" and out["rule"] == "fixed_fallback"
    assert out["value"] == 0.5 and "3 positive patients < 5" in out["reason"] and "unvalidated" in out["reason"]
    assert out["evidence"] == {"n_items": 24, "positive_bags": 12, "negative_bags": 12, "unit": "patients",
                               "positives": 3, "negatives": 12, "n_patients": 15}
    by_bags = M.select_operating_threshold(y, s, rule="youden", min_positives=5, min_negatives=5)
    assert by_bags["selection_status"] == "selected" and by_bags["evidence"]["unit"] == "bags"
    relaxed = M.select_operating_threshold(y, s, rule="youden", patients=patients, min_positives=3, min_negatives=3)
    assert relaxed["selection_status"] == "selected"
    no_fb = M.select_operating_threshold(y, s, rule="target_sensitivity", patients=patients, fallback_value=None)
    assert no_fb["value"] is None and no_fb["rule"] is None and "no threshold was frozen" in no_fb["reason"]


def test_threshold_default_minimums_and_fixed_rule():
    y = np.array([1] * 6 + [0] * 30)
    s = np.r_[np.full(6, 0.8), np.full(30, 0.2)]
    out = M.select_operating_threshold(y, s, rule="target_sensitivity")
    assert out["selection_status"] == "insufficient_evidence" and f"< {M.THRESHOLD_MIN_POSITIVES}" in out["reason"]
    fixed = M.select_operating_threshold(y, s, rule="fixed", fixed_value=0.7)
    assert fixed["selection_status"] == "prespecified" and fixed["value"] == 0.7 and fixed["tuning_set_note"] is None
    assert fixed["at_threshold"]["sensitivity"]["value"] == 1.0
    with pytest.raises(ValueError, match="unknown threshold rule"):
        M.select_operating_threshold(y, s, rule="best_on_test")
    one_each = M.select_operating_threshold([1, 0], [0.9, 0.1], rule="youden", min_positives=0, min_negatives=0)
    assert one_each["selection_status"] == "selected"  # Youden still needs one of each class
    assert M.select_operating_threshold([1, 1], [0.9, 0.8], rule="youden", min_positives=0,
                                        min_negatives=0)["selection_status"] == "insufficient_evidence"


def test_exact_binomial_ci_matches_scipy():
    from scipy.stats import binomtest

    for k, n in ((0, 10), (3, 10), (10, 10), (17, 40)):
        ci = binomtest(k, n).proportion_ci(confidence_level=0.95, method="exact")
        assert M.exact_binomial_ci(k, n) == pytest.approx([ci.low, ci.high], abs=1e-10)
    assert M.exact_binomial_ci(0, 0) is None


# --------------------------------------------------------------------------- risk–coverage and abstention


def test_risk_coverage_curve_known_example_and_aurc():
    # threshold 0.5: margins 0.9, 0.8, 0.6, 0.2 (errors at 0.6 and 0.2)
    y = np.array([1, 0, 1, 0])
    s = np.array([0.95, 0.10, 0.20, 0.60])
    rc = M.risk_coverage_curve(y, s, 0.5)
    risks = [r["selective_risk"] for r in rc["rows"]]
    assert [r["coverage"] for r in rc["rows"]] == [0.25, 0.5, 0.75, 1.0]
    assert risks == pytest.approx([0.0, 0.0, 1 / 3, 0.5])
    assert rc["aurc"] == pytest.approx(np.mean(risks))  # no ties → mean selective risk
    assert rc["aurc_oracle"] == pytest.approx(np.mean([0, 0, 1 / 3, 0.5]))  # errors already last here
    assert rc["rows"][-1]["risk_positive"] == pytest.approx(0.5)
    assert rc["rows"][-1]["risk_negative"] == pytest.approx(0.5)
    assert rc["rows"][1]["risk_positive"] == 0.0 and rc["rows"][1]["coverage_positive"] == 0.5
    assert "not a validated out-of-distribution detector" in rc["note"]


def test_risk_coverage_curve_groups_ties_and_is_order_invariant():
    y, s, _ = _random_cohort(11)
    perm = np.random.default_rng(2).permutation(y.size)
    a, b = M.risk_coverage_curve(y, s, 0.4), M.risk_coverage_curve(y[perm], s[perm], 0.4)
    assert a == b
    assert len(a["rows"]) == np.unique(M.relative_margin(s, 0.4)).size
    assert a["aurc"] >= a["aurc_oracle"] - 1e-12 and a["excess_aurc"] == pytest.approx(a["aurc"] - a["aurc_oracle"])


def test_relative_margin_is_comparable_on_both_sides_of_the_threshold():
    m = M.relative_margin([0.0, 0.05, 0.1, 0.55, 1.0], 0.1)
    assert m == pytest.approx([1.0, 0.5, 0.0, 0.5, 1.0])
    sym = M.relative_margin([0.45, 0.55, 0.2, 0.8], 0.5)  # float noise must not split symmetric ties
    assert sym[0] == sym[1] and sym[2] == sym[3]
    with pytest.raises(ValueError):
        M.relative_margin([0.2], 1.5)


def test_abstention_policy_for_target_coverage_is_frozen_and_selected_on_development():
    rng = np.random.default_rng(4)
    y = rng.integers(0, 2, 200)
    s = np.clip(0.35 * y + 0.65 * rng.random(200), 0, 1)
    pol = M.select_abstention_policy(y, s, 0.5, target_coverage=0.8)
    dev = pol["development"]
    assert pol["selection_status"] == "selected" and pol["frozen"] is True and len(pol["policy_sha256"]) == 64
    assert dev["coverage"] >= 0.8
    # the band is maximal: deferring the next tie group would drop coverage below the target
    m = M.relative_margin(s, 0.5)
    next_margin = np.min(m[m >= pol["margin"]])
    assert np.mean(m > next_margin) < 0.8
    assert pol["lower"] < 0.5 < pol["upper"] and "out-of-distribution" in pol["note"]
    abst = M.apply_abstention(s, pol)
    assert abst.sum() == dev["n_abstained"] and np.array_equal(abst, (s > pol["lower"]) & (s < pol["upper"]))
    _walk_json(pol)


def test_abstention_policy_for_max_risk_infeasible_and_insufficient():
    y = np.array([1, 0] * 20)
    s = np.array([0.95, 0.05] * 10 + [0.45, 0.55] * 10)  # 20 confident correct, 20 near-threshold errors
    pol = M.select_abstention_policy(y, s, 0.5, max_risk=0.0)
    assert pol["selection_status"] == "selected" and pol["development"]["selective_risk"] == 0.0
    assert pol["development"]["coverage"] == 0.5
    bad = np.array([0.95, 0.05] * 20)
    infeasible = M.select_abstention_policy(1 - np.array([1, 0] * 20), bad, 0.5, max_risk=0.1)
    assert infeasible["selection_status"] == "infeasible" and infeasible["margin"] == 0.0
    assert not M.apply_abstention(bad, infeasible).any()
    small = M.select_abstention_policy(y[:6], s[:6], 0.5, target_coverage=0.5)
    assert small["selection_status"] == "insufficient_evidence" and small["development"]["n_abstained"] == 0
    with pytest.raises(ValueError, match="exactly one"):
        M.select_abstention_policy(y, s, 0.5)


@pytest.mark.parametrize("seed", range(15))
def test_abstention_selection_matches_a_brute_force_search(seed):
    rng = np.random.default_rng(seed)
    y = rng.integers(0, 2, 60)
    s = np.round(np.clip(0.3 * y + 0.7 * rng.random(60), 0, 1), 2)  # many tied margins
    m = M.relative_margin(s, 0.5)
    u = np.unique(m)
    err = (s >= 0.5) != (y == 1)
    for crit, value in (("target_coverage", 0.7), ("max_risk", 0.15)):
        best = None
        for j in range(u.size):
            kept = m >= u[j]
            if crit == "target_coverage":
                if kept.mean() < value:
                    break
                best = j
            elif err[kept].mean() <= value:
                best = j
                break
        pol = M.select_abstention_policy(y, s, 0.5, **{crit: value})
        if best is None:
            assert pol["selection_status"] == "infeasible"
        else:
            assert pol["margin"] == pytest.approx(0.0 if best == 0 else (u[best - 1] + u[best]) / 2, abs=1e-12)


def test_apply_abstention_refuses_a_modified_policy():
    y = np.array([1, 0] * 20)
    s = np.linspace(0.01, 0.99, 40)
    pol = M.select_abstention_policy(y, s, 0.5, target_coverage=0.7)
    tampered = {**pol, "upper": 0.99}
    with pytest.raises(ValueError, match="modified"):
        M.apply_abstention(s, tampered)
    none = M.no_abstention_policy(0.5)
    assert not M.apply_abstention(s, none).any() and none["kind"] == "none"


def test_selective_evaluation_applies_a_frozen_policy_with_per_class_counts():
    y = np.array([1, 1, 1, 0, 0, 0])
    s = np.array([0.9, 0.55, 0.2, 0.1, 0.45, 0.8])
    pol = M.select_abstention_policy(y, s, 0.5, target_coverage=0.5, min_items=1)
    ev = M.selective_evaluation(y, s, pol)
    # margins 0.8, 0.1, 0.6, 0.8, 0.1, 0.6: the 0.1 tie group (0.55, 0.45) is deferred; deferring the
    # 0.6 tie group (0.2, 0.8) too would leave coverage 2/6 < 0.5.
    assert ev["n_abstained"] == 2 and ev["abstained_positives"] == 1 and ev["abstained_negatives"] == 1
    assert ev["coverage"]["value"] == pytest.approx(4 / 6)
    assert (ev["selective_risk"]["numerator"], ev["selective_risk"]["denominator"]) == (2, 4)
    assert ev["selective_sensitivity"]["value"] == 0.5 and ev["selective_specificity"]["value"] == 0.5
    rng = np.random.default_rng(0)
    yy = rng.integers(0, 2, 60)
    ss = np.clip(0.4 * yy + 0.6 * rng.random(60), 0, 1)
    pol2 = M.select_abstention_policy(yy, ss, 0.5, target_coverage=0.8)
    ev2 = M.selective_evaluation(yy, ss, pol2, patients=[f"p{i // 2}" for i in range(60)], n_boot=200, seed=1)
    assert ev2["coverage"]["ci"] is not None and ev2["bootstrap"]["status"] == "ok"
    _walk_json(ev2)


# --------------------------------------------------------------------------- subgroups


def test_subgroup_analysis_counts_patients_not_bags_and_reports_cluster_cis():
    rng = np.random.default_rng(6)
    patients, y, attrs = [], [], []
    for i in range(30):  # scanner A: 30 patients × 2 bags
        for _ in range(2):
            patients.append(f"a{i}")
            y.append(i % 2)
            attrs.append({"scanner_id": "A", "site_id": "s1"})
    for i in range(3):  # scanner B: 3 patients × 8 bags = 24 bags (would pass a bag count of 10)
        for j in range(8):
            patients.append(f"b{i}")
            y.append(j % 2)
            attrs.append({"scanner_id": "B", "site_id": "s1"})
    y = np.array(y)
    s = np.clip(0.4 * y + 0.6 * rng.random(y.size), 0, 1)
    out = M.subgroup_analysis(y, s, patients, attrs, threshold=0.5, min_patients=10, n_boot=200, seed=0)
    rows = {(r["key"], r["value"]): r for r in out["rows"]}
    b = rows[("scanner_id", "B")]
    assert b["n_bags"] == 24 and b["n_patients"] == 3 and b["status"] == "insufficient_evidence"
    assert b["metrics"] is None and "3 patient(s) < 10" in b["reason"]
    a = rows[("scanner_id", "A")]
    assert a["status"] == "ok" and a["metrics"]["auroc"]["ci"] is not None and a["bootstrap"]["n_patients"] == 30
    assert rows[("stain", None)]["status"] == "not_recorded"
    assert out["count_unit"] == "patients" and "Exploratory" in out["note"]
    _walk_json(out)
