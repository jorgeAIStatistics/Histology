"""Patient-grouped stratified K-fold, inner hold-out and nested learning-curve subsets (design §6):
group integrity, stratification at skewed prevalence, content-stable determinism (never Python
random), duplicate grouping units, rare-class behaviour and nestedness."""

from __future__ import annotations

import json
import math
import random
import warnings

import numpy as np
import pytest

from dermpath.ml import cv


def _pool(n_pos: int, n_neg: int, *, bags_per_patient=(1, 3), seed: int = 0, prefix: str = "P"):
    """Per-bag labels and patients; patient keys are their codes."""
    rng = np.random.default_rng(seed)
    labels, patients = [], []
    for i in range(n_pos + n_neg):
        lab = 1 if i < n_pos else 0
        for _ in range(int(rng.integers(bags_per_patient[0], bags_per_patient[1] + 1))):
            labels.append(lab)
            patients.append(f"{prefix}-{i:04d}")
    return labels, patients, {p: p for p in patients}


def _quiet(fn, *args, **kw):
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", cv.RareClassWarning)
        return fn(*args, **kw)


# --------------------------------------------------------------------------- k-fold


def test_no_patient_spans_folds_and_splits_partition_the_items():
    labels, patients, keys = _pool(20, 60, seed=1)
    folds = cv.grouped_stratified_kfold(labels, patients, k=5, patient_keys=keys, salt="fam|0")
    item_fold = folds.item_folds(patients)
    for p in set(patients):
        assert len({int(item_fold[i]) for i, q in enumerate(patients) if q == p}) == 1
    seen = np.zeros(len(patients), dtype=int)
    for fit, held in folds.splits(patients):
        assert not set(fit.tolist()) & set(held.tolist())
        assert len(fit) + len(held) == len(patients)
        assert {patients[i] for i in fit}.isdisjoint({patients[i] for i in held})
        seen[held] += 1
    assert (seen == 1).all()  # every item is held out exactly once
    json.dumps(folds.to_dict())


@pytest.mark.parametrize("prevalence", [0.01, 0.05, 0.10, 0.30, 0.50])
@pytest.mark.parametrize("salt", ["a", "b", "c"])
def test_stratification_at_skewed_prevalence(prevalence, salt):
    n = 100
    n_pos = max(1, round(prevalence * n))
    labels, patients, keys = _pool(n_pos, n - n_pos, seed=7)
    folds = _quiet(cv.grouped_stratified_kfold, labels, patients, k=5, patient_keys=keys, salt=salt)
    per_fold = [f["patients_by_class"] for f in folds.diagnostics["folds"]]
    pos = [f["positive"] for f in per_fold]
    neg = [f["negative"] for f in per_fold]
    assert sum(pos) == n_pos and sum(neg) == n - n_pos
    assert max(pos) - min(pos) <= 1 and max(neg) - min(neg) <= 1
    assert max(f["n_patients"] for f in folds.diagnostics["folds"]) - min(
        f["n_patients"] for f in folds.diagnostics["folds"]) <= 1
    if n_pos >= 5:
        assert folds.diagnostics["class_absent"] == [] and folds.diagnostics["warnings"] == []


def test_the_audited_ten_in_a_hundred_case_puts_two_positives_in_every_fold():
    labels, patients, keys = _pool(10, 90, bags_per_patient=(1, 1))
    for seed in range(7):
        folds = cv.grouped_stratified_kfold(labels, patients, k=5, patient_keys=keys, salt=f"fam|{seed}")
        assert [f["patients_by_class"]["positive"] for f in folds.diagnostics["folds"]] == [2] * 5


def test_assignment_is_content_stable_and_never_uses_python_random(monkeypatch):
    labels, patients, keys = _pool(15, 45, seed=3)

    def boom(*a, **k):
        raise AssertionError("Python random must not be used")

    monkeypatch.setattr(random, "shuffle", boom)
    monkeypatch.setattr(random, "random", boom)
    monkeypatch.setattr(random, "Random", boom)
    a = cv.grouped_stratified_kfold(labels, patients, k=4, patient_keys=keys, salt="s")
    perm = np.random.default_rng(0).permutation(len(labels))
    b = cv.grouped_stratified_kfold([labels[i] for i in perm], [patients[i] for i in perm], k=4, patient_keys=keys,
                                    salt="s")
    assert a.fold_of == b.fold_of and a.diagnostics["fingerprint"] == b.diagnostics["fingerprint"]
    # Opaque ids (uuid-like) with the same patient codes give the same folds per patient code.
    ids = {p: f"uuid-{abs(hash((p, 'x'))) % 10**9:09d}-{i}" for i, p in enumerate(sorted(set(patients)))}
    c = cv.grouped_stratified_kfold(labels, [ids[p] for p in patients], k=4,
                                    patient_keys={ids[p]: p for p in ids}, salt="s")
    assert {p: c.fold_of[ids[p]] for p in ids} == a.fold_of
    assert c.diagnostics["fingerprint"] == a.diagnostics["fingerprint"]
    d = cv.grouped_stratified_kfold(labels, patients, k=4, patient_keys=keys, salt="other")
    assert d.fold_of != a.fold_of  # the salt (family + seed) changes the order


def test_confirmed_duplicates_form_one_unit_that_never_spans_folds():
    labels, patients, keys = _pool(12, 36, seed=4)
    pairs = [("P-0000", "P-0020"), ("P-0020", "P-0030"), ("P-0005", "P-0040"), ("P-0001", "nobody")]
    folds = cv.grouped_stratified_kfold(labels, patients, k=4, patient_keys=keys, salt="dup", duplicate_pairs=pairs)
    assert folds.fold_of["P-0000"] == folds.fold_of["P-0020"] == folds.fold_of["P-0030"]
    assert folds.fold_of["P-0005"] == folds.fold_of["P-0040"]
    assert sorted(map(sorted, folds.diagnostics["duplicate_units"])) == [
        ["P-0000", "P-0020", "P-0030"], ["P-0005", "P-0040"]]
    assert folds.diagnostics["duplicate_pairs_ignored"] == [["P-0001", "nobody"]]
    assert folds.diagnostics["n_units"] == 48 - 3


def test_rare_class_warns_and_lists_folds_without_it():
    labels, patients, keys = _pool(3, 40, seed=5)
    with pytest.warns(cv.RareClassWarning, match="3 grouping unit"):
        folds = cv.grouped_stratified_kfold(labels, patients, k=5, patient_keys=keys, salt="r")
    absent = folds.diagnostics["class_absent"]
    assert len(absent) == 2 and all(a["class"] == "positive" for a in absent)
    assert folds.diagnostics["train_class_absent"] == [] and folds.diagnostics["warnings"]
    assert "pooled out-of-fold" in folds.diagnostics["rare_class_behaviour"]
    one, opat, okeys = _pool(1, 20, seed=6)
    with pytest.warns(cv.RareClassWarning, match="trains without that class"):
        f1 = cv.grouped_stratified_kfold(one, opat, k=3, patient_keys=okeys, salt="r")
    assert [a["fold"] for a in f1.diagnostics["train_class_absent"]] == [f1.fold_of["P-0000"]]
    with pytest.warns(cv.RareClassWarning, match="no positive grouping unit"):
        cv.grouped_stratified_kfold([0] * 10, [f"n{i}" for i in range(10)], k=2,
                                    patient_keys={f"n{i}": f"n{i}" for i in range(10)}, salt="r")


def test_refuses_fewer_units_than_folds_bad_keys_and_rules():
    labels, patients, keys = _pool(2, 2, seed=0)
    with pytest.raises(ValueError, match="at least 5 grouping units"):
        cv.grouped_stratified_kfold(labels, patients, k=5, patient_keys=keys, salt="x")
    with pytest.raises(ValueError, match="no key"):
        cv.grouped_stratified_kfold(labels, patients, k=2, patient_keys={}, salt="x")
    with pytest.raises(ValueError, match="unique"):
        cv.grouped_stratified_kfold(labels, patients, k=2, patient_keys={p: "same" for p in patients}, salt="x")
    with pytest.raises(ValueError, match="patient_label_rule"):
        cv.grouped_stratified_kfold(labels, patients, k=2, patient_keys=keys, salt="x", patient_label_rule="first")
    folds = cv.grouped_stratified_kfold(labels, patients, k=2, patient_keys=keys, salt="x")
    with pytest.raises(ValueError, match="no fold assignment"):
        folds.item_folds(["stranger"])


def test_patient_label_rules_and_mixed_label_patients():
    # patient M has bags [1, 0, 0]: any_positive → positive, majority → negative.
    labels = [1, 0, 0] + [1] * 4 + [0] * 4
    patients = ["M"] * 3 + [f"p{i}" for i in range(4)] + [f"n{i}" for i in range(4)]
    keys = {p: p for p in patients}
    units_any, diag = cv.build_units(labels, patients, patient_keys=keys)
    units_maj, _ = cv.build_units(labels, patients, patient_keys=keys, patient_label_rule="majority")
    assert {u.unit_key: u.label for u in units_any}["M"] == 1
    assert {u.unit_key: u.label for u in units_maj}["M"] == 0
    assert diag["mixed_label_patients"] == ["M"]
    tie, _ = cv.build_units([1, 0], ["T", "T"], patient_keys={"T": "T"}, patient_label_rule="majority")
    assert tie[0].label == 1  # majority ties break toward positive


# --------------------------------------------------------------------------- inner hold-out


def test_inner_holdout_is_grouped_stratified_and_deterministic():
    labels, patients, keys = _pool(10, 40, seed=8)
    a = cv.inner_holdout_split(labels, patients, fraction=0.2, patient_keys=keys, salt="inner")
    b = cv.inner_holdout_split(labels, patients, fraction=0.2, patient_keys=keys, salt="inner")
    assert a == b
    assert set(a["fit_patients"]).isdisjoint(a["holdout_patients"])
    assert len(a["fit_patients"]) + len(a["holdout_patients"]) == 50
    assert a["diagnostics"]["held_out"]["patients_by_class"] == {"positive": 2, "negative": 8}
    with pytest.warns(cv.RareClassWarning, match="single grouping unit"):
        single = cv.inner_holdout_split([1] + [0] * 10, ["x"] + [f"n{i}" for i in range(10)], fraction=0.3,
                                        patient_keys={p: p for p in ["x"] + [f"n{i}" for i in range(10)]}, salt="s")
    assert "x" in single["fit_patients"] and single["diagnostics"]["held_out"]["patients_by_class"]["positive"] == 0


# --------------------------------------------------------------------------- learning curves


def test_learning_curve_subsets_are_nested_stratified_and_deterministic():
    labels, patients, keys = _pool(12, 48, seed=9)
    fr = (0.1, 0.25, 0.5, 1.0)
    out = cv.nested_learning_curve_subsets(labels, patients, patient_keys=keys, salt="lc", fractions=fr, repeats=3)
    assert out == cv.nested_learning_curve_subsets(labels, patients, patient_keys=keys, salt="lc", fractions=fr,
                                                   repeats=3)
    json.dumps(out)
    by_repeat: dict = {}
    for sub in out["subsets"]:
        by_repeat.setdefault(sub["repeat"], []).append(sub)
        f = sub["fraction"]
        assert sub["units_by_class"]["positive"] == min(max(math.floor(f * 12 + 0.5), 1), 12)
        assert sub["units_by_class"]["negative"] == min(max(math.floor(f * 48 + 0.5), 1), 48)
    for subs in by_repeat.values():
        assert [s["fraction"] for s in subs] == list(fr)
        for small, big in zip(subs, subs[1:]):
            assert set(small["patients"]) <= set(big["patients"])
        assert len(subs[-1]["patients"]) == 60  # fraction 1.0 is the whole pool
    assert by_repeat[0][1]["patients"] != by_repeat[1][1]["patients"]  # repeats differ


def test_learning_curve_counts_never_shrink_where_largest_remainder_would():
    """Per-class rounding is monotone in the fraction; Hamilton apportionment of a growing total
    is not (the Alabama paradox), which would break nestedness."""
    labels, patients, keys = _pool(3, 7, bags_per_patient=(1, 1))
    fr = [i / 20 for i in range(1, 21)]
    out = cv.nested_learning_curve_subsets(labels, patients, patient_keys=keys, salt="m", fractions=fr, repeats=2,
                                           min_units_per_class=0)
    for r in (0, 1):
        subs = [s for s in out["subsets"] if s["repeat"] == r]
        for small, big in zip(subs, subs[1:]):
            assert set(small["patients"]) <= set(big["patients"])
            for c in ("positive", "negative"):
                assert small["units_by_class"][c] <= big["units_by_class"][c]


def test_learning_curve_respects_minimum_per_class_and_duplicates():
    labels, patients, keys = _pool(4, 36, seed=10)
    out = cv.nested_learning_curve_subsets(labels, patients, patient_keys=keys, salt="min", fractions=(0.05,),
                                           repeats=1, min_units_per_class=2,
                                           duplicate_pairs=[("P-0010", "P-0011")])
    sub = out["subsets"][0]
    assert sub["units_by_class"]["positive"] == 2 and sub["class_absent"] == []
    assert ("P-0010" in sub["patients"]) == ("P-0011" in sub["patients"])
    with pytest.raises(ValueError, match="fractions"):
        cv.nested_learning_curve_subsets(labels, patients, patient_keys=keys, salt="x", fractions=(0.0, 0.5))
