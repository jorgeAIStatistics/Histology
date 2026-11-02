"""Adversarial verification of the statistics lens (design §6-§7).

Each test asserts one guarantee against an independent reference (scikit-learn, scipy or a
first-principles brute force). A failing test is the reproduction of a defect; a passing test
stays as regression coverage. Part A is pure (no database); Part B trains small runs on the
seeded synthetic cohort and checks the stored evaluation bodies end to end.
"""

from __future__ import annotations

import dataclasses
import re
import warnings
from datetime import UTC, datetime

import numpy as np
import pytest

from test_ml_support import CID, FAST, LEAD, SYNTH, cohort, run_jobs

# =========================================================================== helpers


def _clustered(n_patients=40, *, seed=0, prev=0.35, sep=0.22):
    """Patients with 1-3 bags each; bag labels follow the patient; scores informative but noisy."""
    rng = np.random.default_rng(seed)
    y, s, p = [], [], []
    for i in range(n_patients):
        lab = int(rng.random() < prev)
        for _ in range(int(rng.integers(1, 4))):
            y.append(lab)
            s.append(float(np.clip(rng.normal(0.5 + (sep if lab else -sep), 0.2), 0.0, 1.0)))
            p.append(f"pt{i:03d}")
    return np.array(y), np.array(s), p


def _run(**kw):
    from dermpath.ml.models import TrainingRun

    base = dict(id="run-v", project_id="p", name="r", dataset_version_id="dv", dataset_manifest_sha256="m" * 64,
                encoder_id="handcrafted-stain-texture-v1", head="meanpool_logreg",
                params_json={"n_boot": 100, "boot_min_patients": 10, "subgroup_min_n": 5}, seed=3,
                status="succeeded", synthetic=False, label_scope="slide", positive_class="bcc_present",
                negative_class="bcc_absent_not_benign", evaluation_protocol="holdout", threshold_value=0.5,
                threshold_rule="youden", threshold_frozen_at=datetime(2026, 10, 1, tzinfo=UTC),
                threshold_json={"value": 0.5, "rule": "youden", "selected_on": "val", "selection_status": "selected"},
                created_by="u")
    base.update(kw)
    return TrainingRun(**base)


def _pred(bag, patient, label, score, *, split="val", attrs=None):
    from dermpath.ml.models import Prediction

    return Prediction(run_id="run-v", project_id="p", split=split, bag_kind="slide", bag_id=bag, slide_ids_json=[bag],
                      case_id=f"c-{bag}", coded_patient_id=patient, patient_code=f"CODE-{patient}",
                      label_value="bcc_present" if label else "bcc_absent_not_benign", label_version_ids_json=[],
                      label=int(label), score=float(score), threshold=0.5, predicted=int(score >= 0.5),
                      abstained=False, attributes_json=dict(attrs or {}), feature_artifact_ids_json=[])


# =========================================================================== Part A: pure statistics


def test_auroc_auprc_equal_sklearn_with_heavy_ties_and_constant_scores():
    from sklearn.metrics import average_precision_score, roc_auc_score

    from dermpath.ml import metrics as M

    rng = np.random.default_rng(11)
    checked = 0
    for _ in range(400):
        n = int(rng.integers(2, 40))
        y = rng.integers(0, 2, n)
        if y.min() == y.max():
            continue
        levels = int(rng.integers(1, 5))  # 1 level = constant scores
        s = rng.integers(0, levels, n) / 4.0
        ev = M.evaluate_binary(y, s, [f"p{i}" for i in range(n)], threshold=0.5, n_boot=0)
        assert ev["metrics"]["auroc"]["value"] == pytest.approx(roc_auc_score(y, s), abs=1e-12)
        assert ev["metrics"]["auprc"]["value"] == pytest.approx(average_precision_score(y, s), abs=1e-12)
        assert ev["metrics"]["auprc"]["prevalence_baseline"] == pytest.approx(y.mean())
        checked += 1
    assert checked > 300
    # Constant scores: AUROC 0.5 (all pairs tied), AUPRC equals the prevalence.
    y = np.array([0, 1, 0, 1, 1])
    ev = M.evaluate_binary(y, np.full(5, 0.3), list("abcde"), threshold=0.5, n_boot=0)
    assert ev["metrics"]["auroc"]["value"] == 0.5 and ev["metrics"]["auprc"]["value"] == pytest.approx(0.6)


def test_rank_metrics_and_ratio_metrics_are_undefined_not_imputed():
    from dermpath.ml import metrics as M

    # One class only: AUROC/AUPRC/specificity undefined; no CI is invented for them.
    y = np.ones(30, dtype=int)
    s = np.linspace(0.05, 0.95, 30)
    ev = M.evaluate_binary(y, s, [f"p{i}" for i in range(30)], threshold=0.5, n_boot=200, seed=1)
    m = ev["metrics"]
    for k in ("auroc", "auprc", "specificity"):
        assert m[k]["value"] is None and m[k]["ci"] is None and m[k]["undefined_reason"], k
    assert m["specificity"]["denominator"] == 0
    assert m["npv"]["value"] == 0.0 and m["npv"]["denominator"] == int((s < 0.5).sum())  # defined: 0 of n
    # Nothing predicted positive: PPV undefined (denominator 0), NPV defined.
    y = np.array([0, 1] * 15)
    ev = M.evaluate_binary(y, np.full(30, 0.1), [f"p{i}" for i in range(30)], threshold=0.5, n_boot=100)
    m = ev["metrics"]
    assert m["ppv"]["value"] is None and m["ppv"]["denominator"] == 0 and "no items predicted positive" in \
        m["ppv"]["undefined_reason"]
    assert m["npv"]["value"] == pytest.approx(0.5) and (m["npv"]["numerator"], m["npv"]["denominator"]) == (15, 30)
    assert m["sensitivity"]["value"] == 0.0 and m["specificity"]["value"] == 1.0


def test_confusion_numerators_denominators_from_first_principles():
    from dermpath.ml import metrics as M

    y, s, p = _clustered(50, seed=4)
    t = 0.47
    ev = M.evaluate_binary(y, s, p, threshold=t, n_boot=0)
    pred = s >= t
    tp, fp = int((pred & (y == 1)).sum()), int((pred & (y == 0)).sum())
    tn, fn = int((~pred & (y == 0)).sum()), int((~pred & (y == 1)).sum())
    m = ev["metrics"]
    assert (m["sensitivity"]["numerator"], m["sensitivity"]["denominator"]) == (tp, tp + fn)
    assert (m["specificity"]["numerator"], m["specificity"]["denominator"]) == (tn, tn + fp)
    assert (m["ppv"]["numerator"], m["ppv"]["denominator"]) == (tp, tp + fp)
    assert (m["npv"]["numerator"], m["npv"]["denominator"]) == (tn, tn + fn)
    # Evaluation prevalence stated where PPV/NPV are shown.
    assert m["ppv"]["evaluation_prevalence"] == pytest.approx(y.mean())
    assert ev["evaluation_prevalence"]["numerator"] == int(y.sum()) and ev["evaluation_prevalence"]["denominator"] == y.size


def test_prevalence_adjusted_ppv_npv_follow_bayes():
    from dermpath.ml import metrics as M

    for se, sp, pi in [(0.9, 0.8, 0.1), (0.5, 0.5, 0.5), (0.99, 0.6, 0.02), (0.3, 0.95, 0.4)]:
        out = M.prevalence_adjusted_predictive_values(se, sp, pi)
        ppv = se * pi / (se * pi + (1 - sp) * (1 - pi))
        npv = sp * (1 - pi) / (sp * (1 - pi) + (1 - se) * pi)
        assert out["ppv"]["value"] == pytest.approx(ppv) and out["npv"]["value"] == pytest.approx(npv)
    # When the target prevalence equals the evaluation prevalence, adjusted == observed PPV/NPV.
    y, s, p = _clustered(60, seed=5)
    ev = M.evaluate_binary(y, s, p, threshold=0.5, n_boot=0, target_prevalence=float(y.mean()))
    assert ev["prevalence_adjusted"]["ppv"]["value"] == pytest.approx(ev["metrics"]["ppv"]["value"])
    assert ev["prevalence_adjusted"]["npv"]["value"] == pytest.approx(ev["metrics"]["npv"]["value"])
    # Degenerate: sensitivity 0 and specificity 1 -> no positive calls -> PPV undefined (never 0/0 imputed).
    d = M.prevalence_adjusted_predictive_values(0.0, 1.0, 0.2)
    assert d["ppv"]["value"] is None and d["ppv"]["undefined_reason"] and d["npv"]["value"] == pytest.approx(0.8)
    for bad in (0.0, 1.0, -0.1, 1.5):
        with pytest.raises(ValueError):
            M.prevalence_adjusted_predictive_values(0.8, 0.8, bad)


def test_brier_ece_and_equal_width_bins_match_first_principles_and_sklearn():
    from sklearn.calibration import calibration_curve

    from dermpath.ml import metrics as M

    rng = np.random.default_rng(12)
    for _ in range(150):
        n = int(rng.integers(5, 90))
        y = rng.integers(0, 2, n)
        s = rng.random(n)
        nb = int(rng.integers(2, 12))
        rep = M.calibration_report(y, s, n_bins=nb, strategy="uniform")
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            pt, pp = calibration_curve(y, s, n_bins=nb, strategy="uniform")
        full = [b for b in rep["bins"] if b["n"]]
        assert np.allclose([b["fraction_positive"] for b in full], pt)
        assert np.allclose([b["mean_score"] for b in full], pp)
        assert sum(b["n"] for b in rep["bins"]) == n
        ece = sum(b["n"] / n * abs(b["mean_score"] - b["fraction_positive"]) for b in full)
        assert rep["ece"] == pytest.approx(ece, abs=1e-12)
        assert rep["brier"] == pytest.approx(float(np.mean((s - y) ** 2)), abs=1e-12)
        assert rep["mce"] == pytest.approx(max(abs(b["mean_score"] - b["fraction_positive"]) for b in full))


def test_equal_mass_bins_match_sklearn_calibration_curve_as_documented():
    """calibration_report's docstring: 'Bin edges and assignment follow sklearn's calibration_curve'.
    np.percentile(s, linspace(0, 100, k+1)) and sklearn's np.percentile(s, linspace(0, 1, k+1) * 100)
    differ by float noise, so a score sitting on a percentile edge lands in a different bin."""
    from sklearn.calibration import calibration_curve

    from dermpath.ml import metrics as M

    s = np.array([0.05, 0.35, 0.65, 0.95])
    y = np.array([0, 1, 0, 1])
    rep = M.calibration_report(y, s, n_bins=3, strategy="quantile")
    pt, pp = calibration_curve(y, s, n_bins=3, strategy="quantile")
    ours = [b["mean_score"] for b in rep["bins"] if b["n"]]
    assert np.allclose(ours, pp), (ours, pp.tolist())


def test_platt_and_isotonic_match_sklearn_and_refuse_non_development_data():
    from sklearn.calibration import _sigmoid_calibration
    from sklearn.isotonic import IsotonicRegression

    from dermpath.ml.calibration import (
        CalibrationError,
        CalibrationOnTestRefused,
        apply_calibration,
        fit_calibration,
    )

    rng = np.random.default_rng(13)
    for _ in range(40):
        n = int(rng.integers(20, 200))
        y = rng.integers(0, 2, n)
        if min(y.sum(), n - y.sum()) < 5:
            continue
        s = np.clip(rng.normal(0.5 + 0.25 * (y - 0.5), 0.2, n), 0.001, 0.999)
        x = np.log(s) - np.log1p(-s)
        fit = fit_calibration(s, y, method="platt", item_splits=["val"] * n)
        a, b = _sigmoid_calibration(x, y)  # sklearn: P = 1 / (1 + exp(a·x + b)), Platt targets
        assert fit["params"]["slope"] == pytest.approx(-a, abs=1e-3)
        assert fit["params"]["intercept"] == pytest.approx(-b, abs=1e-3)
        iso_fit = fit_calibration(np.round(s, 2), y, method="isotonic", item_splits=["oof"] * n)
        iso = IsotonicRegression(increasing=True, y_min=0, y_max=1, out_of_bounds="clip").fit(np.round(s, 2), y)
        grid = np.linspace(0, 1, 401)
        out = apply_calibration(iso_fit, grid)
        assert np.allclose(out, iso.predict(grid), atol=1e-12) and np.all(np.diff(out) >= 0)
    y = np.array([0, 1] * 10)
    s = np.linspace(0.1, 0.9, 20)
    with pytest.raises(CalibrationOnTestRefused):
        fit_calibration(s, y, method="platt", item_splits=["val"] * 19 + ["test"])
    with pytest.raises(CalibrationOnTestRefused):
        fit_calibration(s, y, method="isotonic", item_splits=["val"] * 19 + [" TEST "])
    with pytest.raises(CalibrationError):  # in-sample training scores are not calibration data
        fit_calibration(s, y, method="platt", item_splits=["train"] * 20)
    fit = fit_calibration(s, y, method="platt", item_splits=["val"] * 20)
    tampered = {**fit, "params": {**fit["params"], "slope": 5.0}}
    with pytest.raises(CalibrationError):
        apply_calibration(tampered, s)


def test_fitted_calibration_map_is_rank_preserving():
    """Decisions use the RAW score against the frozen threshold and the calibrated score is reported
    beside them, so a calibration map must be monotone NON-DECREASING in the raw score. Platt is an
    unconstrained logistic fit: on development scores that run against the labels it learns a negative
    slope and the 'calibrated' probability decreases as the raw score rises (predicted-positive bags get
    the lowest calibrated probabilities). Isotonic is constrained and stays non-decreasing."""
    from dermpath.ml.calibration import apply_calibration, fit_calibration

    rng = np.random.default_rng(14)
    y = np.array([1] * 12 + [0] * 12)
    s = np.r_[rng.uniform(0.05, 0.45, 12), rng.uniform(0.55, 0.95, 12)]  # anti-informative development scores
    grid = np.linspace(0.0, 1.0, 101)
    iso = apply_calibration(fit_calibration(s, y, method="isotonic", item_splits=["val"] * 24), grid)
    assert np.all(np.diff(iso) >= 0)
    platt = fit_calibration(s, y, method="platt", item_splits=["val"] * 24)
    out = apply_calibration(platt, grid)
    assert np.all(np.diff(out) >= -1e-15), (f"Platt slope {platt['params']['slope']:.3f}: calibrated score falls "
                                            f"from {out[0]:.3f} to {out[-1]:.3f} as the raw score rises")


def test_patient_cluster_bootstrap_draws_whole_patients_with_unscorable_bags():
    from dermpath.ml import metrics as M

    patients = ["a", "a", "b", "c", "c", "c", "d", "e", "e", "f"]
    groups = {p: [i for i, q in enumerate(patients) if q == p] for p in set(patients)}
    seen = []
    reps, info = M.run_patient_bootstrap(lambda idx: seen.append(np.sort(idx)) or {"x": 0.0}, patients, n_boot=200,
                                         seed=7, min_patients=2)
    assert info["status"] == "ok" and len(seen) == 200
    for idx in seen:
        counts = np.bincount(idx, minlength=len(patients))
        for p, members in groups.items():
            c = counts[members]
            assert np.all(c == c[0]), "a patient's bags were split inside a replicate"
        # The replicate draws exactly n_patients patients (with replacement).
        drawn = sum(int(counts[m[0]]) for m in groups.values())
        assert drawn == len(groups)
    # evaluate_binary: an unscorable bag travels with its patient (scored TP + unscorable positive each).
    ev = M.evaluate_binary([1] * 12, [0.9] * 12, [f"q{i}" for i in range(12)], threshold=0.5,
                           unscorable_y=[1] * 12, unscorable_patients=[f"q{i}" for i in range(12)], n_boot=300)
    ite = ev["intention_to_evaluate"]["sensitivity"]
    assert ite["value"] == pytest.approx(0.5) and ite["ci"] == [pytest.approx(0.5), pytest.approx(0.5)]


def test_bootstrap_cis_contain_point_estimates_and_are_order_invariant():
    from dermpath.ml import metrics as M

    for seed in range(12):
        y, s, p = _clustered(45, seed=100 + seed)
        ev = M.evaluate_binary(y, s, p, threshold=0.5, n_boot=300, seed=seed, target_prevalence=0.1,
                               unscorable_y=[1, 0], unscorable_patients=[p[0], "extra"])
        entries = dict(ev["metrics"])
        entries.update({f"ite_{k}": ev["intention_to_evaluate"][k] for k in ("sensitivity", "specificity")})
        entries.update({f"adj_{k}": ev["prevalence_adjusted"][k] for k in ("ppv", "npv")})
        for k, e in entries.items():
            if e["value"] is None:
                assert e["ci"] is None
                continue
            assert e["ci"] is not None, (k, e.get("ci_reason"))
            assert e["ci"][0] - 1e-12 <= e["value"] <= e["ci"][1] + 1e-12, (seed, k, e["value"], e["ci"])
        assert ev["n_patients"] == len(set(p) | {"extra"})
    # Permuting the input rows changes nothing (patients are sorted, bags move as a group).
    y, s, p = _clustered(40, seed=3)
    perm = np.random.default_rng(0).permutation(y.size)
    a = M.evaluate_binary(y, s, p, threshold=0.5, n_boot=200, seed=9)
    b = M.evaluate_binary(y[perm], s[perm], [p[i] for i in perm], threshold=0.5, n_boot=200, seed=9)
    for k in ("sensitivity", "specificity", "ppv", "npv", "auroc", "auprc", "brier"):
        assert a["metrics"][k]["ci"] == pytest.approx(b["metrics"][k]["ci"]), k


def test_bootstrap_ci_is_undefined_when_a_class_is_absent_or_too_few_patients():
    from dermpath.ml import metrics as M

    y = np.zeros(40, dtype=int)
    s = np.linspace(0, 1, 40)
    ev = M.evaluate_binary(y, s, [f"p{i}" for i in range(40)], threshold=0.5, n_boot=200)
    for k in ("sensitivity", "auroc", "auprc"):
        assert ev["metrics"][k]["value"] is None and ev["metrics"][k]["ci"] is None
    assert ev["metrics"]["specificity"]["ci"] is not None
    # Rare positives: most replicates lose the class -> no CI rather than a CI from a biased subset.
    y = np.r_[np.ones(1, dtype=int), np.zeros(39, dtype=int)]
    ev = M.evaluate_binary(y, s, [f"p{i}" for i in range(40)], threshold=0.5, n_boot=300, seed=1)
    assert ev["metrics"]["sensitivity"]["value"] is not None and ev["metrics"]["sensitivity"]["ci"] is None
    assert "replicates" in ev["metrics"]["sensitivity"]["ci_reason"]
    # Fewer patients than min_patients: no bootstrap at all (bags of 5 patients, 40 bags).
    ev = M.evaluate_binary(np.array([0, 1] * 20), s, [f"p{i % 5}" for i in range(40)], threshold=0.5, n_boot=200,
                           min_patients=10)
    assert ev["metrics"]["auroc"]["ci"] is None and "insufficient evidence: 5 patient" in \
        ev["metrics"]["auroc"]["ci_reason"]


def _score_sets():
    from dermpath.ml.comparison import ScoreSet

    rng = np.random.default_rng(15)
    bags, pats, ys, sa, sb = [], [], [], [], []
    for i in range(36):
        lab = int(i % 3 == 0)
        for j in range(1 + i % 2):
            bags.append(f"b{i:02d}-{j}")
            pats.append(f"p{i:02d}")
            ys.append(lab)
            sa.append(float(np.clip(rng.normal(0.65 if lab else 0.35, 0.2), 0, 1)))
            sb.append(float(np.clip(rng.normal(0.6 if lab else 0.42, 0.25), 0, 1)))
    a = ScoreSet("A", bags, pats, ys, sa, 0.5, "m", "f")
    b = ScoreSet("B", bags, pats, ys, sb, 0.45, "m", "f")
    return a, b, (bags, pats, ys, sa, sb)


def test_paired_comparison_identical_inputs_give_zero_delta_with_zero_width_ci():
    from dermpath.ml.comparison import ScoreSet, paired_comparison

    a, _, (bags, pats, ys, sa, _) = _score_sets()
    a2 = ScoreSet("A-copy", bags, pats, ys, sa, 0.5, "m", "f")
    r = paired_comparison([a, a2], n_boot=300, seed=4)
    pair = r["pairs"][0]
    for m, e in pair["deltas"].items():
        assert e["value"] == 0.0 and e["ci"] == [0.0, 0.0], m
        assert e["fraction_tied"] == 1.0
    assert pair["mcnemar"]["all"]["n_discordant"] == 0 and pair["mcnemar"]["all"]["p_value"] == 1.0
    assert r["winner"] is None


def test_paired_comparison_swapped_models_negate_deltas_and_order_does_not_matter():
    from dermpath.ml.comparison import ScoreSet, paired_comparison

    a, b, (bags, pats, ys, _, sb) = _score_sets()
    ab = paired_comparison([a, b], n_boot=300, seed=4)["pairs"][0]
    ba = paired_comparison([b, a], n_boot=300, seed=4)["pairs"][0]
    for m in ab["deltas"]:
        x, y = ab["deltas"][m], ba["deltas"][m]
        assert x["value"] == pytest.approx(-y["value"], abs=1e-12)
        assert x["ci"][0] == pytest.approx(-y["ci"][1], abs=1e-12) and x["ci"][1] == pytest.approx(-y["ci"][0],
                                                                                                    abs=1e-12)
        assert x["fraction_favouring"]["A"] == pytest.approx(y["fraction_favouring"]["A"])
    assert ab["mcnemar"]["all"]["b"] == ba["mcnemar"]["all"]["c"]
    assert ab["mcnemar"]["all"]["p_value"] == ba["mcnemar"]["all"]["p_value"]
    perm = np.random.default_rng(1).permutation(len(bags))
    b_shuffled = ScoreSet("B", [bags[i] for i in perm], [pats[i] for i in perm], [ys[i] for i in perm],
                          [sb[i] for i in perm], 0.45, "m", "f")
    again = paired_comparison([a, b_shuffled], n_boot=300, seed=4)["pairs"][0]
    for m in ab["deltas"]:
        assert again["deltas"][m]["ci"] == pytest.approx(ab["deltas"][m]["ci"])


def test_paired_comparison_refuses_mismatched_sets():
    from dermpath.ml.comparison import ComparisonRefused, ScoreSet, paired_comparison

    a, _, (bags, pats, ys, _, sb) = _score_sets()
    variants = {
        "patient_mismatch": ScoreSet("C", bags, pats[:-1] + ["p-other"], ys, sb, 0.5, "m", "f"),
        "bag_set_mismatch": ScoreSet("C", bags[:-1], pats[:-1], ys[:-1], sb[:-1], 0.5, "m", "f"),
        "label_mismatch": ScoreSet("C", bags, pats, [1 - v for v in ys], sb, 0.5, "m", "f"),
        "manifest_sha256_mismatch": ScoreSet("C", bags, pats, ys, sb, 0.5, "other", "f"),
        "split_fingerprint_mismatch": ScoreSet("C", bags, pats, ys, sb, 0.5, "m", "other"),
        "duplicate_bags": ScoreSet("C", bags[:-1] + [bags[0]], pats, ys, sb, 0.5, "m", "f"),
        "invalid_scores": ScoreSet("C", bags, pats, ys, sb[:-1] + [float("nan")], 0.5, "m", "f"),
    }
    for code, other in variants.items():
        with pytest.raises(ComparisonRefused) as exc:
            paired_comparison([a, other], n_boot=10)
        assert exc.value.code == code


def test_exact_mcnemar_matches_scipy_binomtest():
    from scipy.stats import binomtest

    from dermpath.ml.comparison import exact_mcnemar

    for b in range(0, 35):
        for c in range(0, 35):
            p = exact_mcnemar(b, c)["p_value"]
            ref = 1.0 if b + c == 0 else binomtest(min(b, c), b + c, 0.5).pvalue
            assert p == pytest.approx(ref, rel=1e-12, abs=1e-15), (b, c)
    for b, c in [(2600, 2450), (3100, 3000), (40, 5000)]:  # integer path and scipy path
        assert exact_mcnemar(b, c)["p_value"] == pytest.approx(binomtest(min(b, c), b + c, 0.5).pvalue, rel=1e-9)
    from dermpath.ml.comparison import holm_adjust

    rng = np.random.default_rng(26)
    for _ in range(50):
        ps = list(rng.random(int(rng.integers(1, 8))))
        order = sorted(range(len(ps)), key=lambda i: ps[i])
        want = [0.0] * len(ps)
        for rank, i in enumerate(order):
            want[i] = min(1.0, max((len(ps) - j) * ps[order[j]] for j in range(rank + 1)))
        assert holm_adjust(ps) == pytest.approx(want)


def test_risk_coverage_aurc_brute_force_oracle_bound_and_tie_invariance():
    from dermpath.ml import metrics as M

    rng = np.random.default_rng(16)
    for _ in range(200):
        n = int(rng.integers(1, 60))
        y = rng.integers(0, 2, n)
        s = rng.random(n)
        t = float(rng.choice([0.5, rng.uniform(0.05, 0.95)]))
        rc = M.risk_coverage_curve(y, s, t)
        m = M.relative_margin(s, t)
        err = ((s >= t) != (y == 1))[np.argsort(-m, kind="stable")]
        if np.unique(m).size == n:
            assert rc["aurc"] == pytest.approx(float(np.mean(np.cumsum(err) / np.arange(1, n + 1))), abs=1e-12)
        assert rc["aurc_oracle"] <= rc["aurc"] + 1e-12 and rc["excess_aurc"] >= -1e-12
        cov = [r["coverage"] for r in rc["rows"]]
        assert all(np.diff(cov) > 0) and cov[-1] == pytest.approx(1.0)
        assert all(np.diff([r["min_margin_kept"] for r in rc["rows"]]) < 0)  # least confident deferred first
        assert rc["full_coverage_risk"] == pytest.approx(err.mean())
    y = np.array([1, 0, 1, 0, 1, 0, 1])
    s = np.array([0.7, 0.7, 0.3, 0.3, 0.5, 0.5, 0.45])
    perm = np.array([6, 5, 4, 3, 2, 1, 0])
    assert M.risk_coverage_curve(y, s, 0.5)["aurc"] == M.risk_coverage_curve(y[perm], s[perm], 0.5)["aurc"]


def test_abstention_policy_reaches_target_coverage_on_development_and_is_frozen():
    from dermpath.ml import metrics as M

    rng = np.random.default_rng(17)
    for _ in range(150):
        n = int(rng.integers(20, 80))
        y = rng.integers(0, 2, n)
        s = np.round(rng.random(n), int(rng.integers(1, 4)))
        t = float(rng.choice([0.5, 0.3, 0.7]))
        tc = float(rng.choice([0.5, 0.7, 0.8, 0.95, 1.0]))
        pol = M.select_abstention_policy(y, s, t, target_coverage=tc, selected_on="val")
        ab = M.apply_abstention(s, pol)
        m = M.relative_margin(s, t)
        assert 1 - ab.mean() >= tc - 1e-12
        assert np.array_equal(ab, m < pol["margin"])  # defers exactly the least-confident tie groups
        if (~ab).any():  # widest: deferring the next tie group would break the target
            nxt = m[~ab].min()
            assert (m > nxt).mean() < tc or nxt >= 1.0
        assert pol["development"]["coverage"] == pytest.approx(1 - ab.mean()) and pol["selected_on"] == "val"
    with pytest.raises(ValueError, match="modified"):
        M.apply_abstention(s, {**pol, "upper": 0.99})
    small = M.select_abstention_policy([0, 1] * 5, [0.4, 0.6] * 5, 0.5, target_coverage=0.5)
    assert small["selection_status"] == "insufficient_evidence" and not M.apply_abstention([0.5, 0.55], small).any()


def test_threshold_rules_match_brute_force():
    from dermpath.ml import metrics as M

    rng = np.random.default_rng(18)
    for _ in range(200):
        n = int(rng.integers(4, 60))
        y = rng.integers(0, 2, n)
        if y.min() == y.max():
            continue
        s = np.round(rng.random(n), int(rng.integers(1, 3)))
        r = M.select_operating_threshold(y, s, rule="youden", min_positives=1, min_negatives=1)
        best = None
        for t in np.unique(s):
            se = ((s >= t) & (y == 1)).sum() / (y == 1).sum()
            sp = ((s < t) & (y == 0)).sum() / (y == 0).sum()
            key = (round(se + sp - 1, 12), se, t)
            best = key if best is None or key > best else best
        assert r["value"] == best[2] and r["youden_j"] == pytest.approx(best[0])
        ts = float(rng.choice([0.5, 0.8, 0.9, 1.0]))
        r = M.select_operating_threshold(y, s, rule="target_sensitivity", target_sensitivity=ts, min_positives=1,
                                         min_negatives=0)
        ok = [t for t in np.unique(s) if ((s >= t) & (y == 1)).sum() / (y == 1).sum() >= ts]
        assert r["value"] == max(ok)
        assert r["at_threshold"]["sensitivity"]["value"] >= ts


def test_threshold_minimum_evidence_counts_patients_not_bags():
    from dermpath.ml import metrics as M

    # 4 positive patients with 5 bags each (20 positive bags), 30 negative patients.
    y = [1] * 20 + [0] * 30
    patients = [f"pos{i // 5}" for i in range(20)] + [f"neg{i}" for i in range(30)]
    s = list(np.linspace(0.55, 0.95, 20)) + list(np.linspace(0.05, 0.6, 30))
    r = M.select_operating_threshold(y, s, rule="youden", patients=patients, min_positives=10, min_negatives=10,
                                     fallback_value=0.5)
    assert r["selection_status"] == "insufficient_evidence" and r["value"] == 0.5 and r["rule"] == "fixed_fallback"
    assert r["evidence"]["unit"] == "patients" and r["evidence"]["positives"] == 4
    assert r["tuning_set_note"] is None and "4 positive patients < 10" in r["reason"]
    # The same bags counted as bags would have passed.
    r_bags = M.select_operating_threshold(y, s, rule="youden", min_positives=10, min_negatives=10)
    assert r_bags["selection_status"] == "selected"


def test_subgroup_min_n_counts_patients_and_reports_patient_cluster_cis():
    from dermpath.ml import metrics as M

    # Scanner X: 4 patients with 6 bags each (24 bags); scanner Y: 30 patients, one bag each.
    y, s, p, attrs = [], [], [], []
    rng = np.random.default_rng(19)
    for i in range(4):
        for _ in range(6):
            y.append(i % 2)
            s.append(float(rng.uniform(0.6, 0.9) if i % 2 else rng.uniform(0.1, 0.4)))
            p.append(f"x{i}")
            attrs.append({"scanner_id": "X"})
    for i in range(30):
        y.append(int(i % 3 == 0))
        s.append(float(np.clip(rng.normal(0.65 if i % 3 == 0 else 0.35, 0.2), 0, 1)))
        p.append(f"y{i}")
        attrs.append({"scanner_id": "Y"})
    out = M.subgroup_analysis(y, s, p, attrs, threshold=0.5, keys=("scanner_id", "site_id"), min_patients=10,
                              n_boot=200, seed=2)
    rows = {(r["key"], r["value"]): r for r in out["rows"]}
    assert rows[("scanner_id", "X")]["n_bags"] == 24 and rows[("scanner_id", "X")]["n_patients"] == 4
    assert rows[("scanner_id", "X")]["status"] == "insufficient_evidence" and rows[("scanner_id", "X")]["metrics"] is None
    ok = rows[("scanner_id", "Y")]
    assert ok["status"] == "ok" and ok["n_patients"] == 30 and ok["bootstrap"]["method"] == "patient_cluster"
    assert ok["bootstrap"]["n_patients"] == 30 and ok["metrics"]["auroc"]["ci"] is not None
    assert rows[("site_id", None)]["status"] == "not_recorded" and out["count_unit"] == "patients"


def test_subgroup_threshold_metrics_are_flagged_tuning_set_on_the_tuning_split():
    """On the split the threshold was chosen on, every threshold-dependent metric is optimistic and must say
    so (design §6: 'Threshold-dependent val metrics are labelled tuning_set: true'). The body-level metrics
    do; the per-subgroup sensitivity/specificity/PPV/NPV in the same body are hard-coded tuning_set False."""
    from dermpath.ml.evaluation import build_evaluation

    rng = np.random.default_rng(20)
    preds = []
    for i in range(30):
        lab = int(i % 3 == 0)
        preds.append(_pred(f"s{i:02d}", f"pt{i:02d}", lab, float(np.clip(rng.normal(0.65 if lab else 0.35, 0.2),
                                                                         0.01, 0.99)),
                           attrs={"scanner_id": "scanner-a", "site_id": "site-1", "stain": "H&E"}))
    body = build_evaluation(_run(), "val", preds, [])
    assert body["tuning_set"] is True and body["metrics"]["sensitivity"]["tuning_set"] is True
    ok_rows = [r for r in body["subgroups"]["rows"] if r["status"] == "ok"]
    assert ok_rows
    flags = {(r["key"], r["value"], k): r["metrics"][k]["tuning_set"] for r in ok_rows
             for k in ("sensitivity", "specificity", "ppv", "npv")}
    assert all(flags.values()), f"subgroup threshold metrics on the tuning split flagged tuning_set False: {flags}"


def test_learning_curve_subsets_are_nested_stratified_and_keep_duplicates_together():
    from dermpath.ml.cv import build_units, nested_learning_curve_subsets

    rng = np.random.default_rng(21)
    for _ in range(40):
        npat = int(rng.integers(8, 70))
        labels, pats = [], []
        for i in range(npat):
            lab = int(rng.random() < 0.3)
            for _ in range(int(rng.integers(1, 4))):
                labels.append(lab)
                pats.append(f"u{i}")
        keys = {q: f"CODE-{q}" for q in set(pats)}
        dups = [(f"u{a}", f"u{b}") for a, b in rng.integers(0, npat, (2, 2)) if a != b]
        units, _ = build_units(labels, pats, patient_keys=keys, duplicate_pairs=dups)
        lc = nested_learning_curve_subsets(labels, pats, patient_keys=keys, salt="lc", repeats=2,
                                           duplicate_pairs=dups)
        for r in range(2):
            subs = [x for x in lc["subsets"] if x["repeat"] == r]
            assert [x["fraction"] for x in subs] == [0.1, 0.25, 0.5, 1.0]
            for small, big in zip(subs, subs[1:]):
                assert set(small["patients"]) <= set(big["patients"])
            assert set(subs[-1]["patients"]) == set(pats)
            for x in subs:
                for c, name in ((1, "positive"), (0, "negative")):
                    n_c = sum(1 for u in units if u.label == c)
                    want = min(max(int(np.floor(x["fraction"] * n_c + 0.5)), min(1, n_c)), n_c)
                    assert x["units_by_class"][name] == want
                chosen = set(x["patients"])
                assert all((a in chosen) == (b in chosen) for a, b in dups)


def test_cv_folds_preserve_groups_balance_classes_and_ignore_row_order():
    from dermpath.ml.cv import build_units, grouped_stratified_kfold

    rng = np.random.default_rng(22)
    warnings.simplefilter("ignore")
    for _ in range(60):
        npat = int(rng.integers(10, 80))
        prev = float(rng.choice([0.05, 0.1, 0.3, 0.5]))
        labels, pats = [], []
        for i in range(npat):
            lab = int(rng.random() < prev)
            for _ in range(int(rng.integers(1, 4))):
                labels.append(lab if rng.random() > 0.1 else 1 - lab)  # some mixed-label patients
                pats.append(f"u{i}")
        keys = {q: f"CODE-{q}" for q in set(pats)}
        dups = [(f"u{a}", f"u{b}") for a, b in rng.integers(0, npat, (3, 2)) if a != b]
        k = int(rng.integers(2, 6))
        units, _ = build_units(labels, pats, patient_keys=keys, duplicate_pairs=dups)
        if len(units) < k:
            continue
        folds = grouped_stratified_kfold(labels, pats, k=k, patient_keys=keys, salt="cv", duplicate_pairs=dups)
        for a, b in dups:
            assert folds.fold_of[a] == folds.fold_of[b]
        for fit_idx, held_idx in folds.splits(pats):
            assert not ({pats[i] for i in fit_idx} & {pats[i] for i in held_idx})
        biggest = max(len(u.patients) for u in units)
        for c in (0, 1):
            per = [sum(len(u.patients) for u in units if u.label == c and folds.fold_of[u.patients[0]] == f)
                   for f in range(k)]
            assert max(per) - min(per) <= biggest
        perm = rng.permutation(len(pats))
        again = grouped_stratified_kfold([labels[i] for i in perm], [pats[i] for i in perm], k=k, patient_keys=keys,
                                         salt="cv", duplicate_pairs=dups)
        assert again.fold_of == folds.fold_of


BENIGN_RE = re.compile(r"benign", re.IGNORECASE)


def _benign_uses(obj, path="") -> list[str]:
    """Strings that say 'benign' other than the negation built into the class value or its display text."""
    out = []
    if isinstance(obj, dict):
        for k, v in obj.items():
            out += _benign_uses(v, f"{path}.{k}")
    elif isinstance(obj, (list, tuple)):
        for i, v in enumerate(obj):
            out += _benign_uses(v, f"{path}[{i}]")
    elif isinstance(obj, str) and BENIGN_RE.search(obj):
        cleaned = obj.replace("bcc_absent_not_benign", "").replace("NOT the same as benign", "")
        cleaned = re.sub(r"never (?:rendered as |called )?['\"]?benign", "", cleaned, flags=re.IGNORECASE)
        cleaned = re.sub(r"not ['\"]?benign", "", cleaned, flags=re.IGNORECASE)
        if BENIGN_RE.search(cleaned):
            out.append(f"{path}: {obj}")
    return out


def test_failure_taxonomy_never_renders_bcc_absent_as_benign():
    from dermpath.ml.evaluation import build_evaluation
    from dermpath.ml.failure import failure_taxonomy

    recs = [{"bag_id": f"b{i}", "label": i % 2, "score": float(v), "threshold": 0.5}
            for i, v in enumerate(np.linspace(0.02, 0.98, 20))]
    ctx = {f"b{i}": {"negative_category": "seborrheic keratosis", "reader_disagreement": True, "scanner_id": "z"}
           for i in range(20)}
    out = failure_taxonomy(recs, ctx, positive_class="bcc_present", negative_class="bcc_absent_not_benign",
                           train_domain={"scanner_ids": ["a"], "site_ids": []})
    assert out["n_errors"] > 0
    for e in out["errors"]:
        assert e["reference"] in ("bcc_present", "bcc_absent_not_benign")
        assert e["predicted"] in ("bcc_present", "bcc_absent_not_benign")
    assert _benign_uses(out) == []
    rng = np.random.default_rng(23)
    preds = [_pred(f"s{i:02d}", f"pt{i:02d}", int(i % 3 == 0), float(rng.uniform(0.01, 0.99)),
                   attrs={"scanner_id": "a"}) for i in range(30)]
    body = build_evaluation(_run(), "val", preds, [])
    assert body["classes"]["negative"]["value"] == "bcc_absent_not_benign"
    assert _benign_uses(body) == []


def test_oof_domain_shift_is_judged_against_the_fold_fitting_data():
    """Under dev_cv an out-of-fold bag was scored by a model that never saw it. The failure taxonomy takes
    the 'training domain' from the whole development pool (train ∪ val), which contains the bag itself, so
    a scanner seen ONLY on that bag counts as 'seen in training' and domain_shift can never fire for OOF."""
    from dermpath.ml.evaluation import build_evaluation

    rng = np.random.default_rng(24)
    preds, items = [], []
    for i in range(24):
        lab = int(i % 3 == 0)
        scanner = "scanner-z" if i == 0 else "scanner-a"
        score = 0.03 if i == 0 else float(np.clip(rng.normal(0.7 if lab else 0.3, 0.15), 0.01, 0.99))
        split = "val" if i % 4 == 0 else "train"
        preds.append(_pred(f"s{i:02d}", f"pt{i:02d}", lab, score, split="oof",
                           attrs={"scanner_id": scanner, "site_id": "site-1", "fold": i % 3, "manifest_split": split}))
        items.append({"slide_id": f"s{i:02d}", "case_id": f"c-s{i:02d}", "coded_patient_id": f"pt{i:02d}",
                      "patient_code": f"CODE-pt{i:02d}", "split": split, "scanner_id": scanner, "site_id": "site-1",
                      "label_value": "bcc_present" if lab else "bcc_absent_not_benign"})
    items.append({"slide_id": "t0", "case_id": "c-t0", "coded_patient_id": "ptt", "patient_code": "CODE-ptt",
                  "split": "test", "scanner_id": "scanner-a", "site_id": "site-1", "label_value": "bcc_present"})
    run = _run(evaluation_protocol="dev_cv",
               threshold_json={"value": 0.5, "rule": "youden", "selected_on": "oof", "selection_status": "selected"})
    body = build_evaluation(run, "oof", preds, [], manifest={"items": items})
    err = {e["bag_id"]: e for e in body["failure_analysis"]["errors"]}
    assert "s00" in err and err["s00"]["error_type"] == "false_negative"
    assert "domain_shift" in err["s00"]["categories"], (
        f"scanner-z exists only on the held-out bag itself; train_domain={body['failure_analysis']['train_domain']}")


def test_test_split_body_is_never_flagged_tuning_set():
    from dermpath.ml.evaluation import build_evaluation

    rng = np.random.default_rng(25)
    preds = [_pred(f"s{i:02d}", f"pt{i:02d}", int(i % 3 == 0), float(rng.uniform(0.01, 0.99)), split="test")
             for i in range(30)]
    for protocol, selected_on in (("holdout", "val"), ("dev_cv", "oof")):
        run = _run(evaluation_protocol=protocol, threshold_json={"value": 0.5, "rule": "youden",
                                                                 "selected_on": selected_on,
                                                                 "selection_status": "selected"})
        body = build_evaluation(run, "test", preds, [])
        assert body["tuning_set"] is False and body["operating_point"]["tuning_set"] is False
        assert all(body["metrics"][k]["tuning_set"] is False for k in ("sensitivity", "specificity", "ppv", "npv"))
    # A prespecified (fixed) or fallback threshold was not tuned on validation either.
    for status in ("prespecified", "insufficient_evidence"):
        run = _run(threshold_json={"value": 0.5, "rule": "fixed", "selected_on": "val", "selection_status": status})
        body = build_evaluation(run, "val", preds, [])
        assert body["tuning_set"] is False and body["metrics"]["sensitivity"]["tuning_set"] is False


def test_dev_cv_fold_without_a_class_is_counted_unscorable_never_imputed():
    """A fold whose fitting part lacks a class is not fitted; its held-out bags are unscorable and count in the
    intention-to-evaluate metrics (design §6 'Unscorable folds'); the threshold never sees them."""
    import hashlib
    import uuid

    from dermpath.ml.config import resolve_params
    from dermpath.ml.heads import IN_MEMORY
    from dermpath.ml.training import build_bags, development_summary, run_dev_cv, select_operating_point

    rows = []
    for i in range(15):
        code = f"PT-{i:03d}"
        label = "bcc_present" if i == 0 else "bcc_absent_not_benign"  # one positive patient, k = 3
        pid, cid = uuid.uuid4().hex, uuid.uuid4().hex
        rows.append({"slide_id": uuid.uuid4().hex, "case_id": cid, "coded_patient_id": pid, "patient_code": code,
                     "accession_code": f"ACC-{i:03d}", "slide_sha256": hashlib.sha256(code.encode()).hexdigest(),
                     "label_value": label, "label_version_id": uuid.uuid4().hex, "split": "train" if i % 3 else "val",
                     "scanner_id": "s", "site_id": "x", "stain": "H&E"})
    bags = build_bags(rows, "slide", "bcc_present")
    rng = np.random.default_rng(27)
    for b in bags:
        b.embeddings = rng.normal(size=(5, 6)).astype(np.float32) + b.label
        b.slide_index = np.zeros(5, dtype=np.int64)
    params = resolve_params({"n_boot": 50, "cv_folds": 3, "min_threshold_evidence": 1})
    ctx = {"split_salt": "verify", "patient_label_rule": "any_positive", "duplicate_pairs": []}
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        out = run_dev_cv(bags, head="meanpool_logreg", params=params, seed=0, access=IN_MEMORY, context=ctx)
    not_fitted = [f for f in out.summary["folds"] if f["status"] == "not_fitted"]
    held_unscored = {u["bag_id"] for u in out.unscored}
    assert len(not_fitted) == 1 and held_unscored  # the fold holding the only positive trains without it
    assert len(out.dev) + len(held_unscored) == len(bags) and not ({sb.bag.bag_id for sb in out.dev} & held_unscored)
    assert sum(f["held_out_bags"] for f in not_fitted) == len(held_unscored)
    op = select_operating_point(out.dev, params, selected_on="oof")
    assert op["threshold"]["evidence"]["n_items"] == len(out.dev)
    summ = development_summary(out.dev, out.unscored, op, params, 0, split="oof", protocol="dev_cv")
    assert summ["n_unscorable"] == len(held_unscored)
    u_pos = sum(1 for u in out.unscored if u["label"] == 1)
    ite = summ["intention_to_evaluate"]["sensitivity"]
    assert ite["denominator"] == summ["at_operating_point"]["sensitivity"]["denominator"] + u_pos


def test_evaluation_cis_do_not_depend_on_database_ids():
    """Identical content stored under regenerated database ids (coded_patient_id uuids) must give identical
    evaluation bodies. Every other ordering in the engine is content-stable (patient_code, accession, slide
    sha); the patient-cluster bootstrap sorts the raw coded_patient_id, so which patients a replicate draws,
    and therefore every CI, changes when the same cohort is re-imported."""
    import uuid

    from dermpath.ml.evaluation import build_evaluation

    rng = np.random.default_rng(28)
    base = []
    for i in range(40):
        lab = int(i % 3 == 0)
        for j in range(1 + i % 2):
            base.append((f"s{i:02d}{j}", f"CODE-{i:03d}", lab,
                         float(np.clip(rng.normal(0.62 if lab else 0.38, 0.2), 0.01, 0.99))))

    def body_with_fresh_ids():
        ids_ = {code: uuid.uuid4().hex for code in sorted({c for _, c, _, _ in base})}
        preds = []
        for bag, code, lab, score in base:
            p = _pred(bag, ids_[code], lab, score)
            p.patient_code = code
            preds.append(p)
        return build_evaluation(_run(), "val", preds, [])

    a, b = body_with_fresh_ids(), body_with_fresh_ids()
    for k in ("sensitivity", "specificity", "auroc", "auprc", "brier"):
        assert a["metrics"][k]["value"] == b["metrics"][k]["value"]
    diffs = {k: (a["metrics"][k]["ci"], b["metrics"][k]["ci"]) for k in ("sensitivity", "specificity", "auroc",
                                                                          "auprc", "brier")
             if a["metrics"][k]["ci"] != b["metrics"][k]["ci"]}
    assert not diffs, f"same content, regenerated ids, different CIs: {diffs}"


# =========================================================================== Part B: end to end on the synthetic cohort


def _manifest(dv_id):
    from dermpath.db import session_scope
    from dermpath.models import DatasetVersion

    with session_scope() as db:
        return db.get(DatasetVersion, dv_id).manifest_json


def _zero_patch(monkeypatch, slide_ids: set[str]) -> None:
    """The pinned artifacts of these slides hold no tissue patches (a real outcome of extraction)."""
    from dermpath.ml import feature_sets as fsm

    real = fsm.load_slide_features

    def load(fs, slide_id):
        sf = real(fs, slide_id)
        if slide_id in slide_ids:
            dim = int(sf.embeddings.shape[1]) if np.ndim(sf.embeddings) == 2 else 1
            return dataclasses.replace(sf, embeddings=np.zeros((0, dim), np.float32),
                                       coords=np.zeros((0, 2), np.int64), n_patches=0)
        return sf

    monkeypatch.setattr(fsm, "load_slide_features", load)


def _pick_unscorable(manifest) -> dict[str, list[dict]]:
    """One positive and one negative validation slide, one training slide (deterministic)."""
    items = sorted(manifest["items"], key=lambda it: it["slide_id"])
    val_pos = next(it for it in items if it["split"] == "val" and it["label_value"] == "bcc_present")
    val_neg = next(it for it in items if it["split"] == "val" and it["label_value"] != "bcc_present")
    train = next(it for it in items if it["split"] == "train")
    return {"val": [val_pos, val_neg], "train": [train]}


def _train(ids, *, params, protocol="holdout", seed=0, head="meanpool_logreg"):
    from dermpath.auth import Actor
    from dermpath.db import session_scope
    from dermpath.ml.service import create_experiment
    from dermpath.models import Project

    lead = Actor(LEAD, "research_lead", "Priya Navarro")
    with session_scope() as db:
        run, _ = create_experiment(db, lead, db.get(Project, CID), dataset_version_id=cohort(ids)["dataset_version_id"],
                                   encoder_id=SYNTH, head=head, params=params, seed=seed, name=None,
                                   evaluation_protocol=protocol)
        rid = run.id
    out = run_jobs()
    assert [o.status for o in out] == ["succeeded"], [o.error for o in out]
    return rid


def _stored(rid):
    from sqlalchemy import select

    from dermpath.db import session_scope
    from dermpath.ml.models import Evaluation, Prediction, TrainingRun

    with session_scope() as db:
        run = db.get(TrainingRun, rid)
        evs = {e.split: dict(e.metrics_json) for e in db.scalars(select(Evaluation).where(Evaluation.run_id == rid))}
        preds = [(p.split, p.bag_id, p.coded_patient_id, p.label, p.score, p.predicted)
                 for p in db.scalars(select(Prediction).where(Prediction.run_id == rid))]
        return {"threshold_json": dict(run.threshold_json), "calibration_json": dict(run.calibration_json or {}),
                "abstention_json": dict(run.abstention_json or {}), "metrics_json": dict(run.metrics_json),
                "threshold": run.threshold_value}, evs, preds


def test_holdout_body_counts_unscorable_states_prevalence_and_flags_the_tuning_set(env, ids, monkeypatch):
    dv_id = cohort(ids)["dataset_version_id"]
    manifest = _manifest(dv_id)
    pick = _pick_unscorable(manifest)
    _zero_patch(monkeypatch, {it["slide_id"] for v in pick.values() for it in v})
    params = {**FAST, "n_boot": 100, "min_threshold_evidence": 3, "calibration": "platt",
              "abstention_target_coverage": 0.8}
    rid = _train(ids, params=params, seed=61)
    run, evs, preds = _stored(rid)
    assert set(evs) == {"val"}
    body = evs["val"]
    val_items = [it for it in manifest["items"] if it["split"] == "val"]
    scored = [p for p in preds if p[0] == "val"]
    unscorable_ids = {it["slide_id"] for it in pick["val"]}
    assert {p[1] for p in scored} == {it["slide_id"] for it in val_items} - unscorable_ids
    # Unscorable bags: counted (validation only), never silently dropped.
    assert body["n_unscorable"] == 2 and body["unscorable_positives"] == 1 and body["unscorable_negatives"] == 1
    assert sorted(u["bag_id"] for u in body["unscored"]) == sorted(unscorable_ids)
    assert body["n_items"] == len(scored) and body["n_patients"] == len({it["coded_patient_id"] for it in val_items})
    y = np.array([p[3] for p in scored])
    pred = np.array([p[5] for p in scored])
    tp, fn = int(((pred == 1) & (y == 1)).sum()), int(((pred == 0) & (y == 1)).sum())
    tn, fp = int(((pred == 0) & (y == 0)).sum()), int(((pred == 1) & (y == 0)).sum())
    ite = body["intention_to_evaluate"]
    assert (ite["sensitivity"]["numerator"], ite["sensitivity"]["denominator"]) == (tp, tp + fn + 1)
    assert (ite["specificity"]["numerator"], ite["specificity"]["denominator"]) == (tn, tn + fp + 1)
    assert body["metrics"]["sensitivity"]["denominator"] == tp + fn
    # Prevalence stated (scored bags) and attached to PPV/NPV.
    prev = body["evaluation_prevalence"]
    assert (prev["numerator"], prev["denominator"]) == (int(y.sum()), y.size) and prev["unit"] == "scored bags"
    assert body["metrics"]["ppv"]["evaluation_prevalence"] == pytest.approx(y.mean())
    # Threshold, calibration and abstention selected on the SCORED validation bags only; tuning flags set.
    th = run["threshold_json"]
    assert th["selection_status"] == "selected" and th["selected_on"] == "val"
    assert set(th["val_bag_ids"]) == {p[1] for p in scored}
    assert run["calibration_json"]["fitted_on"]["splits"] == ["val"]
    assert run["calibration_json"]["fitted_on"]["n"] == len(scored)
    assert run["abstention_json"]["selected_on"] == "val" and run["abstention_json"]["development"]["n"] == len(scored)
    assert body["tuning_set"] is True and body["operating_point"]["tuning_set"] is True
    assert all(body["metrics"][k]["tuning_set"] is True for k in ("sensitivity", "specificity", "ppv", "npv"))
    assert all("tuning_set" not in body["metrics"][k] for k in ("auroc", "auprc", "brier"))
    assert body["calibration"]["frozen_calibration"]["in_sample"] is True
    summary = run["metrics_json"]["val_summary"]
    assert summary["n_unscorable"] == 2 and summary["tuning_set"] is True
    assert summary["n_items"] == len(scored)


def test_dev_cv_body_counts_unscorable_train_and_val_bags_and_flags_oof(env, ids, monkeypatch):
    dv_id = cohort(ids)["dataset_version_id"]
    manifest = _manifest(dv_id)
    pick = _pick_unscorable(manifest)
    _zero_patch(monkeypatch, {it["slide_id"] for v in pick.values() for it in v})
    params = {**FAST, "n_boot": 100, "min_threshold_evidence": 3, "cv_folds": 3}
    rid = _train(ids, params=params, protocol="dev_cv", seed=62)
    run, evs, preds = _stored(rid)
    assert set(evs) == {"oof"}
    body = evs["oof"]
    dev_items = [it for it in manifest["items"] if it["split"] in ("train", "val")]
    oof = [p for p in preds if p[0] == "oof"]
    assert not [p for p in preds if p[0] == "test"]
    n_fold_unscored = sum(1 for u in run["metrics_json"]["unscored_bags"] if u.get("split") == "oof")
    assert body["n_unscorable"] == 3 + n_fold_unscored
    assert body["n_items"] + body["n_unscorable"] == len({it["slide_id"] for it in dev_items})
    assert body["n_patients"] == len({it["coded_patient_id"] for it in dev_items})
    assert body["evaluation_protocol"] == "dev_cv" and body["tuning_set"] is True
    assert run["threshold_json"]["selected_on"] == "oof" and set(run["threshold_json"]["oof_bag_ids"]) == \
        {p[1] for p in oof}
    y = np.array([p[3] for p in oof])
    assert body["evaluation_prevalence"]["value"] == pytest.approx(y.mean())
    assert body["metrics"]["sensitivity"]["tuning_set"] is True
    # The stored OOF metrics agree with an independent recomputation from the stored rows.
    from sklearn.metrics import roc_auc_score

    assert body["metrics"]["auroc"]["value"] == pytest.approx(roc_auc_score(y, [p[4] for p in oof]))


def test_default_minimum_evidence_gives_unvalidated_fallback_not_a_tuning_set(env, ids):
    dv_id = cohort(ids)["dataset_version_id"]
    manifest = _manifest(dv_id)
    val = [it for it in manifest["items"] if it["split"] == "val"]
    pos_patients = len({it["coded_patient_id"] for it in val if it["label_value"] == "bcc_present"})
    assert pos_patients < 10  # the cohort's validation split is below the default evidence rule
    rid = _train(ids, params={**FAST, "n_boot": 50}, seed=63)
    run, evs, _ = _stored(rid)
    th = run["threshold_json"]
    assert th["selection_status"] == "insufficient_evidence" and run["threshold"] == 0.5
    assert th["evidence"]["unit"] == "patients" and th["evidence"]["positives"] == pos_patients
    body = evs["val"]
    assert body["tuning_set"] is False and body["metrics"]["sensitivity"]["tuning_set"] is False
    assert any(w.startswith("threshold_unvalidated") for w in body["warnings"])


def test_test_release_applies_the_development_operating_point_unchanged(env, ids, clients, monkeypatch):
    """Threshold, calibration and abstention are frozen on validation and applied to test as stored: test
    decisions/abstentions follow the frozen policy, nothing is re-selected on test, the test body is not a tuning
    set, and a test slide without patches is counted (intention to evaluate)."""
    from sqlalchemy import select

    from dermpath.db import session_scope
    from dermpath.ml.calibration import apply_calibration
    from dermpath.ml.metrics import apply_abstention
    from dermpath.ml.models import Prediction

    dv_id = cohort(ids)["dataset_version_id"]
    manifest = _manifest(dv_id)
    test_items = sorted((it for it in manifest["items"] if it["split"] == "test"), key=lambda it: it["slide_id"])
    empty = test_items[0]["slide_id"]
    _zero_patch(monkeypatch, {empty})
    params = {**FAST, "n_boot": 100, "min_threshold_evidence": 3, "calibration": "isotonic",
              "abstention_target_coverage": 0.7}
    rid = _train(ids, params=params, seed=64)
    before, _, _ = _stored(rid)
    lead = clients(LEAD)
    assert lead.post(f"/api/v1/experiments/{rid}/register").status_code in (200, 201)
    r = lead.post(f"/api/v1/experiments/{rid}/test-release", json={"reason": "verification of frozen operating point"})
    assert r.status_code == 202, r.text
    out = run_jobs(["evaluate_test_release"])
    assert [o.status for o in out] == ["succeeded"], [o.error for o in out]
    after, evs, _ = _stored(rid)
    for k in ("threshold_json", "calibration_json", "abstention_json", "threshold"):
        assert after[k] == before[k], f"{k} changed by the test release"
    body = lead.get(f"/api/v1/experiments/{rid}/evaluation?split=test").json()
    assert body["tuning_set"] is False and body["metrics"]["sensitivity"]["tuning_set"] is False
    assert body["abstention"]["selected_on_this_split"] is False
    assert body["calibration"]["frozen_calibration"]["in_sample"] is False
    assert body["calibration"]["frozen_calibration"]["fitted_on"]["splits"] == ["val"]
    assert body["n_unscorable"] == 1 and body["unscored"][0]["bag_id"] == empty
    assert body["n_items"] + body["n_unscorable"] == len({it["slide_id"] for it in test_items})
    with session_scope() as db:
        rows = db.scalars(select(Prediction).where(Prediction.run_id == rid, Prediction.split == "test")
                          .order_by(Prediction.bag_id)).all()
        scores = np.array([p.score for p in rows])
        labels = np.array([p.label for p in rows])
        abst = [bool(p.abstained) for p in rows]
        predicted = [int(p.predicted) for p in rows]
    t = before["threshold"]
    assert predicted == [int(v >= t) for v in scores]
    assert abst == apply_abstention(scores, before["abstention_json"]).tolist()
    assert body["abstention"]["selective"]["n_abstained"] == sum(abst)
    cal = apply_calibration(before["calibration_json"], scores)
    assert body["calibration"]["calibrated"]["equal_width"]["brier"] == pytest.approx(float(np.mean((cal - labels) ** 2)))
    from sklearn.metrics import roc_auc_score

    if 0 < labels.sum() < labels.size:
        assert body["metrics"]["auroc"]["value"] == pytest.approx(roc_auc_score(labels, scores))


def test_test_prediction_rows_carry_the_calibrated_score(env, ids, clients):
    """Design §6 (Outputs): prediction rows carry ``calibrated_score`` in ``attributes_json``. Development rows do;
    the test-release job drops the calibrated value returned by the scorer (``for bag, score, _cal, ...``)."""
    from sqlalchemy import select

    from dermpath.db import session_scope
    from dermpath.ml.calibration import apply_calibration
    from dermpath.ml.models import Prediction

    params = {**FAST, "n_boot": 50, "min_threshold_evidence": 3, "calibration": "platt"}
    rid = _train(ids, params=params, seed=65)
    run, _, _ = _stored(rid)
    lead = clients(LEAD)
    assert lead.post(f"/api/v1/experiments/{rid}/register").status_code in (200, 201)
    assert lead.post(f"/api/v1/experiments/{rid}/test-release", json={"reason": "verification"}).status_code == 202
    assert [o.status for o in run_jobs(["evaluate_test_release"])] == ["succeeded"]
    with session_scope() as db:
        rows = db.scalars(select(Prediction).where(Prediction.run_id == rid)).all()
        by_split = {}
        for p in rows:
            by_split.setdefault(p.split, []).append((p.score, (p.attributes_json or {}).get("calibrated_score")))
    assert all(c is not None for _, c in by_split["val"])
    test_rows = by_split["test"]
    assert all(c is not None for _, c in test_rows), "test prediction rows have no calibrated_score"
    want = apply_calibration(run["calibration_json"], np.array([s for s, _ in test_rows]))
    assert np.allclose([c for _, c in test_rows], want)
