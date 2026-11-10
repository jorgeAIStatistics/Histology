"""Paired model comparison (design §7): identity verification and refusal, patient-level paired
bootstrap with a shared seed (symmetry, identical scores → zero delta, shared replicates),
exact McNemar at the operating points, all pairs reported and no winner declared."""

from __future__ import annotations

import json
import math

import numpy as np
import pytest
from scipy.stats import binomtest
from sklearn.metrics import average_precision_score, roc_auc_score

from dermpath.ml import comparison as C
from dermpath.ml import metrics as M


def _cohort(seed: int = 0, n_patients: int = 30):
    rng = np.random.default_rng(seed)
    bags, patients, y = [], [], []
    for i in range(n_patients):
        for j in range(int(rng.integers(1, 4))):
            bags.append(f"bag-{i:03d}-{j}")
            patients.append(f"pt{i:03d}")
            y.append(int(rng.random() < 0.4))
    y = np.array(y)
    s_a = np.clip(0.35 * y + 0.65 * rng.random(y.size), 0, 1)
    s_b = np.clip(s_a + rng.normal(0, 0.15, y.size), 0, 1)
    s_c = np.clip(0.2 * y + 0.8 * rng.random(y.size), 0, 1)
    return bags, patients, y, s_a, s_b, s_c


def _sets(seed: int = 0):
    bags, patients, y, s_a, s_b, s_c = _cohort(seed)
    return (C.ScoreSet("A", bags, patients, y, s_a, 0.5), C.ScoreSet("B", bags, patients, y, s_b, 0.45),
            C.ScoreSet("C", bags, patients, y, s_c, 0.55))


# --------------------------------------------------------------------------- identity


def test_refuses_anything_but_the_identical_bag_and_patient_set():
    a, b, _ = _sets()
    with pytest.raises(C.ComparisonRefused) as e:
        C.paired_comparison([a, C.ScoreSet("B", list(b.bag_ids)[:-1], list(b.patients)[:-1], list(b.labels)[:-1],
                                           list(b.scores)[:-1], 0.5)], n_boot=0)
    assert e.value.code == "bag_set_mismatch" and "1 bag(s) missing" in e.value.detail
    moved = list(b.patients)
    moved[0] = "someone-else"
    with pytest.raises(C.ComparisonRefused, match="patient_mismatch"):
        C.paired_comparison([a, C.ScoreSet("B", b.bag_ids, moved, b.labels, b.scores, 0.5)], n_boot=0)
    relabelled = np.array(b.labels).copy()
    relabelled[3] = 1 - relabelled[3]
    with pytest.raises(C.ComparisonRefused, match="label_mismatch"):
        C.paired_comparison([a, C.ScoreSet("B", b.bag_ids, b.patients, relabelled, b.scores, 0.5)], n_boot=0)
    with pytest.raises(C.ComparisonRefused, match="manifest_sha256_mismatch"):
        C.paired_comparison([C.ScoreSet("A", a.bag_ids, a.patients, a.labels, a.scores, 0.5, manifest_sha256="x"),
                             C.ScoreSet("B", b.bag_ids, b.patients, b.labels, b.scores, 0.5, manifest_sha256="y")])
    with pytest.raises(C.ComparisonRefused, match="too_few_models"):
        C.paired_comparison([a])
    with pytest.raises(C.ComparisonRefused, match="duplicate_names"):
        C.paired_comparison([a, a])
    dup = list(b.bag_ids)
    dup[1] = dup[0]
    with pytest.raises(C.ComparisonRefused, match="duplicate_bags"):
        C.paired_comparison([a, C.ScoreSet("B", dup, b.patients, b.labels, b.scores, 0.5)])
    nan_scores = np.array(b.scores, dtype=float)
    nan_scores[2] = np.nan
    with pytest.raises(C.ComparisonRefused, match="invalid_scores"):
        C.paired_comparison([a, C.ScoreSet("B", b.bag_ids, b.patients, b.labels, nan_scores, 0.5)])


def test_alignment_is_by_bag_id_not_by_position():
    a, b, _ = _sets(1)
    perm = np.random.default_rng(3).permutation(len(b.bag_ids))
    shuffled = C.ScoreSet("B", [b.bag_ids[i] for i in perm], [b.patients[i] for i in perm],
                          [b.labels[i] for i in perm], [b.scores[i] for i in perm], b.threshold)
    x = C.paired_comparison([a, b], n_boot=200, seed=5)
    z = C.paired_comparison([a, shuffled], n_boot=200, seed=5)
    assert x == z
    assert x["identity"]["bag_set_sha256"] == z["identity"]["bag_set_sha256"]


# --------------------------------------------------------------------------- point deltas and bootstrap


def test_point_deltas_equal_sklearn_differences_at_each_models_own_threshold():
    a, b, _ = _sets(2)
    out = C.paired_comparison([a, b], n_boot=0)
    y = np.array(a.labels)
    d = out["pairs"][0]["deltas"]
    assert d["auroc"]["value"] == pytest.approx(roc_auc_score(y, a.scores) - roc_auc_score(y, b.scores), abs=1e-12)
    assert d["auprc"]["value"] == pytest.approx(
        average_precision_score(y, a.scores) - average_precision_score(y, b.scores), abs=1e-12)
    sens = lambda s, t: np.mean(np.asarray(s)[y == 1] >= t)  # noqa: E731
    spec = lambda s, t: np.mean(np.asarray(s)[y == 0] < t)  # noqa: E731
    assert d["sensitivity"]["value"] == pytest.approx(sens(a.scores, 0.5) - sens(b.scores, 0.45))
    assert d["specificity"]["value"] == pytest.approx(spec(a.scores, 0.5) - spec(b.scores, 0.45))
    assert d["brier"]["value"] == pytest.approx(np.mean((a.scores - y) ** 2) - np.mean((b.scores - y) ** 2))
    assert d["brier"]["better"] == "lower" and d["auroc"]["better"] == "higher"
    assert all(v["ci"] is None and "disabled" in v["ci_reason"] for v in d.values())


def test_identical_scores_give_zero_deltas_ties_and_mcnemar_p_one():
    a, _, _ = _sets(3)
    twin = C.ScoreSet("A2", a.bag_ids, a.patients, a.labels, a.scores, a.threshold)
    out = C.paired_comparison([a, twin], n_boot=300, seed=1)
    pair = out["pairs"][0]
    for m, d in pair["deltas"].items():
        assert d["value"] == 0.0 and d["ci"] == [0.0, 0.0], m
        assert d["fraction_tied"] == 1.0 and d["fraction_favouring"] == {"A": 0.0, "A2": 0.0}
    for part in ("all", "positives", "negatives"):
        assert pair["mcnemar"][part]["b"] == pair["mcnemar"][part]["c"] == 0
        assert pair["mcnemar"][part]["p_value"] == 1.0
    assert out["winner"] is None


def test_paired_bootstrap_is_antisymmetric_under_swapping_models():
    a, b, _ = _sets(4)
    ab = C.paired_comparison([a, b], n_boot=400, seed=7)["pairs"][0]
    ba = C.paired_comparison([b, a], n_boot=400, seed=7)["pairs"][0]
    for m in C.DELTA_METRICS:
        x, z = ab["deltas"][m], ba["deltas"][m]
        assert x["value"] == pytest.approx(-z["value"], abs=1e-12)
        assert x["ci"] == pytest.approx([-z["ci"][1], -z["ci"][0]], abs=1e-12)
        assert x["fraction_favouring"]["A"] == pytest.approx(z["fraction_favouring"]["A"])
        assert x["fraction_favouring"]["B"] == pytest.approx(z["fraction_favouring"]["B"])
        assert x["fraction_tied"] == pytest.approx(z["fraction_tied"])
    assert (ab["mcnemar"]["all"]["b"], ab["mcnemar"]["all"]["c"]) == (ba["mcnemar"]["all"]["c"],
                                                                      ba["mcnemar"]["all"]["b"])
    assert ab["mcnemar"]["all"]["p_value"] == ba["mcnemar"]["all"]["p_value"]


def test_all_models_share_each_replicate_so_deltas_add_up():
    """With ONE patient resample per replicate shared by every model, Δ(A,C) = Δ(A,B) + Δ(B,C)
    holds replicate by replicate. Independent resamples per pair would break this."""
    sets = _sets(5)
    out = C.paired_comparison(list(sets), n_boot=200, seed=11, keep_replicates=True)
    pairs = {(p["a"], p["b"]): p for p in out["pairs"]}
    assert set(pairs) == {("A", "B"), ("A", "C"), ("B", "C")}
    for m in C.DELTA_METRICS:
        ab, bc, ac = (pairs[k]["replicates"][m] for k in (("A", "B"), ("B", "C"), ("A", "C")))
        for x, y, z in zip(ab, bc, ac):
            if None not in (x, y, z):
                assert z == pytest.approx(x + y, abs=1e-12)


def test_paired_replicates_resample_patients_with_all_their_bags():
    a, b, _ = _sets(6)
    out = C.paired_comparison([a, b], n_boot=50, seed=13, keep_replicates=True)
    order = sorted(range(len(a.bag_ids)), key=lambda i: a.bag_ids[i])
    patients = [a.patients[i] for i in order]
    y = np.array([a.labels[i] for i in order])
    sa = np.array([a.scores[i] for i in order])
    sb = np.array([b.scores[i] for i in order])
    reps = out["pairs"][0]["replicates"]["auroc"]
    for r, idx in enumerate(M.patient_bootstrap_indices(patients, n_boot=50, seed=13)):
        ra, rb = M.auroc_fast(y[idx], sa[idx]), M.auroc_fast(y[idx], sb[idx])
        expected = None if ra is None or rb is None else ra - rb
        assert (reps[r] is None and expected is None) or reps[r] == pytest.approx(expected, abs=1e-12)


def test_bootstrap_gate_and_serialisable_output():
    a, b, _ = _sets(7)
    few = C.paired_comparison([a, b], n_boot=100, seed=0, min_patients=1000)
    deltas = few["pairs"][0]["deltas"].values()
    assert all(d["ci"] is None and "insufficient evidence" in d["ci_reason"] for d in deltas)
    assert few["pairs"][0]["mcnemar"]["all"]["p_value"] <= 1.0  # McNemar does not need the bootstrap
    out = C.paired_comparison(list(_sets(7)), n_boot=100, seed=0)
    json.dumps(out, allow_nan=False)
    assert out["multiple_comparisons"]["n_pairs"] == 3
    assert "No winner is declared" in out["multiple_comparisons"]["note"]
    assert out["winner"] is None and out["bootstrap"]["seed"] == 0 and out["bootstrap"]["method"] == "patient_paired"


# --------------------------------------------------------------------------- McNemar


@pytest.mark.parametrize("b,c", [(0, 5), (1, 6), (3, 3), (7, 2), (10, 25), (0, 0), (40, 61)])
def test_exact_mcnemar_matches_the_binomial_test(b, c):
    out = C.exact_mcnemar(b, c)
    n = b + c
    expected = 1.0 if n == 0 else binomtest(min(b, c), n, 0.5, alternative="two-sided").pvalue
    assert out["p_value"] == pytest.approx(expected, rel=1e-12, abs=1e-15)
    if n:
        manual = min(1.0, 2 * sum(math.comb(n, i) for i in range(min(b, c) + 1)) / 2 ** n)
        assert out["p_value"] == pytest.approx(manual, rel=1e-12)


def test_exact_mcnemar_hand_values_and_large_n_branch():
    assert C.exact_mcnemar(0, 5)["p_value"] == pytest.approx(2 / 32)
    assert C.exact_mcnemar(1, 6)["p_value"] == pytest.approx(2 * 8 / 128)
    k, n = 2400, C.EXACT_MCNEMAR_MAX_N + 2
    big = C.exact_mcnemar(k, n - k)
    assert big["method"] == "exact binomial (scipy)"
    assert big["p_value"] == pytest.approx(binomtest(k, n, 0.5).pvalue, rel=1e-9)


def test_mcnemar_counts_discordance_at_each_models_operating_point():
    bags = [f"b{i}" for i in range(6)]
    patients = [f"p{i}" for i in range(6)]
    y = [1, 1, 1, 0, 0, 0]
    # A at 0.5: correct on b0, b1, b3, b4; B at 0.3: correct on b0, b1, b2, b3.
    sa = [0.9, 0.6, 0.4, 0.2, 0.3, 0.7]
    sb = [0.9, 0.6, 0.35, 0.1, 0.4, 0.8]
    out = C.paired_comparison([C.ScoreSet("A", bags, patients, y, sa, 0.5),
                               C.ScoreSet("B", bags, patients, y, sb, 0.3)], n_boot=0)
    mc = out["pairs"][0]["mcnemar"]
    assert (mc["all"]["b"], mc["all"]["c"]) == (1, 1)  # b4: A right, B wrong; b2: A wrong, B right
    assert (mc["positives"]["b"], mc["positives"]["c"]) == (0, 1)
    assert (mc["negatives"]["b"], mc["negatives"]["c"]) == (1, 0)
    assert mc["all"]["b_meaning"] == "A correct, B wrong" and "approximate" in out["mcnemar_note"]


def test_holm_adjustment():
    assert C.holm_adjust([0.01, 0.04, 0.03]) == pytest.approx([0.03, 0.06, 0.06])
    assert C.holm_adjust([0.5, 0.9]) == pytest.approx([1.0, 1.0])
    assert C.holm_adjust([]) == []
