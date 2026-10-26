"""Pure split allocation (dermpath/splits.py, design §2): stratification, content-stable ordering, families,
grouping constraints, temporal / external-site validation. No database."""

from __future__ import annotations

import random
from collections import Counter
from datetime import date, timedelta

import pytest

POS, NEG = "bcc_present", "bcc_absent_not_benign"


def _cohort(n_pos: int, n_neg: int, *, prefix: str = "pt", code_prefix: str = "P-") -> list[dict]:
    out = []
    for i in range(n_pos + n_neg):
        out.append({"id": f"{prefix}{i:05d}", "code": f"{code_prefix}{i:05d}", "label": POS if i < n_pos else NEG,
                    "dates": [], "sites": set()})
    return out


def _table(patients: list[dict], mapping: dict[str, str]) -> dict[str, dict[str, int]]:
    c = Counter((mapping[p["id"]], p["label"]) for p in patients)
    return {sp: {POS: c.get((sp, POS), 0), NEG: c.get((sp, NEG), 0)} for sp in ("train", "val", "test")}


# --------------------------------------------------------------------------- the defect


@pytest.mark.parametrize("seed", [0, 1, 2, 3, 7, 42, 12345])
def test_ten_positive_ninety_negative_puts_positives_in_val_and_test(seed):
    """Regression for the audit's critical finding: with 10 positive / 90 negative patients at 60/20/20 the old
    round-robin + positional cut put ALL 10 positives in train (val and test had none, for every seed).
    Stratified allocation gives val and test about 2 positives each (±1)."""
    from dermpath.datasets import compute_splits, normalise_split

    pts = _cohort(10, 90)
    mapping, diag = compute_splits(pts, normalise_split({"partition": "random", "seed": seed}))
    t = _table(pts, mapping)
    for sp in ("val", "test"):
        assert abs(t[sp][POS] - 2) <= 1, (seed, t)
    assert t["train"][POS] + t["val"][POS] + t["test"][POS] == 10
    assert diag["class_absent"] == []


# --------------------------------------------------------------------------- property tests


@pytest.mark.parametrize("prevalence", [0.01, 0.05, 0.10, 0.30, 0.50])
def test_stratified_allocation_property_across_seeds_and_sizes(prevalence):
    """Across many seeds and cohort sizes: both classes are in val and test whenever feasible (the class has at
    least one patient per split with ratio > 0), per-split class counts equal the reported targets, and the
    targets are within ±1 of ratio × n (±2 only where the minimum-one rule moved a patient)."""
    from dermpath.splits import allocate

    ratios = {"train": 0.6, "val": 0.2, "test": 0.2}
    for n in (12, 23, 37, 60, 100, 257):
        n_pos = max(1, round(prevalence * n))
        pts = _cohort(n_pos, n - n_pos)
        for seed in range(0, 40, 3):
            mapping, diag = allocate(pts, {"partition": "random", "seed": seed, "ratios": ratios})
            assert set(mapping) == {p["id"] for p in pts}
            t = _table(pts, mapping)
            for cls, n_cls in ((POS, n_pos), (NEG, n - n_pos)):
                for sp in ("train", "val", "test"):
                    assert t[sp][cls] == diag["targets"][cls][sp], (n, seed, cls, sp, t, diag["targets"])
                    tol = 2 if diag["min_one_adjustments"].get(cls) else 1
                    assert abs(t[sp][cls] - ratios[sp] * n_cls) < tol, (n, seed, cls, sp, t)
                if n_cls >= 3:
                    assert all(t[sp][cls] >= 1 for sp in ("train", "val", "test")), (n, seed, cls, t)
                else:
                    absent = {(a["split"], a["class"]) for a in diag["class_absent"]}
                    assert {(sp, cls) for sp in ("train", "val", "test") if t[sp][cls] == 0} <= absent
            feasible = n_pos >= 3 and n - n_pos >= 3
            assert (diag["class_absent"] == []) == feasible, (n, seed, diag["class_absent"])


@pytest.mark.parametrize("ratios", [{"train": 0.7, "val": 0.15, "test": 0.15},
                                    {"train": 0.34, "val": 0.33, "test": 0.33},
                                    {"train": 0.8, "val": 0.0, "test": 0.2}])
def test_other_ratios_keep_minority_in_every_split_with_ratio(ratios):
    from dermpath.splits import allocate

    pts = _cohort(10, 90)
    for seed in range(10):
        mapping, diag = allocate(pts, {"partition": "random", "seed": seed, "ratios": ratios})
        t = _table(pts, mapping)
        for sp, r in ratios.items():
            if r > 0:
                assert t[sp][POS] >= 1 and abs(t[sp][POS] - r * 10) < 1, (ratios, t)
            else:
                assert t[sp][POS] == t[sp][NEG] == 0
        assert diag["class_absent"] == [] and diag["active_splits"] == [s for s in ("train", "val", "test") if ratios[s]]


def test_infeasible_class_is_reported_not_refused():
    """1 positive and three splits: the allocation succeeds and class_absent says where the class is missing."""
    from dermpath.splits import allocate

    pts = _cohort(1, 99)
    mapping, diag = allocate(pts, {"partition": "random", "seed": 0})
    t = _table(pts, mapping)
    assert t["train"][POS] == 1
    assert {(a["split"], a["class"]) for a in diag["class_absent"]} == {("val", POS), ("test", POS)}
    assert diag["min_one_infeasible"] == [{"class": POS, "patients": 1, "splits_with_ratio": 3}]


def test_seed_changes_membership_not_composition():
    from dermpath.splits import allocate

    pts = _cohort(30, 70)
    tables, memberships = set(), set()
    for seed in range(8):
        mapping, _ = allocate(pts, {"partition": "random", "seed": seed})
        tables.add(str(_table(pts, mapping)))
        memberships.add(tuple(sorted(p for p, s in mapping.items() if s == "test")))
    assert len(tables) == 1 and len(memberships) == 8


def test_uuid_independence_and_input_order_independence():
    """Ordering is by sha256(salt|patient_code): the same cohort with different ids (and in another order) gives
    the same {patient_code: split}."""
    from dermpath.splits import allocate

    rng = random.Random(5)
    a = _cohort(17, 63, prefix="uuid-a-")
    b = [{**p, "id": f"{rng.getrandbits(128):032x}"} for p in a]
    rng.shuffle(b)
    for seed in (0, 9, 2**31 - 1):
        for salt in ("", "family-salt-1"):
            ma, _ = allocate(a, {"partition": "random", "seed": seed}, salt=salt)
            mb, _ = allocate(b, {"partition": "random", "seed": seed}, salt=salt)
            by_code_a = {p["code"]: ma[p["id"]] for p in a}
            by_code_b = {p["code"]: mb[p["id"]] for p in b}
            assert by_code_a == by_code_b
    # A different salt (another family) gives a different allocation of the same cohort.
    m1, _ = allocate(a, {"partition": "random", "seed": 0}, salt="x")
    m2, _ = allocate(a, {"partition": "random", "seed": 0}, salt="y")
    assert m1 != m2


# --------------------------------------------------------------------------- patient label rule


def test_patient_label_rules_are_deterministic():
    from dermpath.splits import patient_label

    assert patient_label([NEG, NEG, POS]) == POS  # any_positive (default)
    assert patient_label([NEG, NEG]) == NEG
    assert patient_label([NEG, NEG, POS], "majority") == NEG
    assert patient_label([NEG, POS], "majority") == POS and patient_label([POS, NEG], "majority") == POS  # tie → pos
    assert patient_label(["inadequate", NEG], "majority") == "bcc_absent_not_benign"  # tie, no positive → sorted
    assert patient_label(["inadequate", NEG]) == patient_label([NEG, "inadequate"])
    with pytest.raises(ValueError):
        patient_label([POS], "coin_flip")


def test_mixed_label_patients_are_listed_and_stratified_by_rule():
    from dermpath.splits import allocate

    pts = [{"id": f"p{i}", "code": f"C{i}", "labels": [POS, NEG] if i < 4 else [NEG], "dates": [], "sites": set()}
           for i in range(20)]
    _, diag = allocate(pts, {"partition": "random", "seed": 1})
    assert diag["mixed_label_patients"]["count"] == 4
    assert diag["mixed_label_patients"]["patient_codes"] == ["C0", "C1", "C2", "C3"]
    assert sum(diag["per_split_class"][sp][POS]["patients"] for sp in ("train", "val", "test")) == 4  # any_positive
    _, diag_m = allocate(pts, {"partition": "random", "seed": 1, "patient_label_rule": "majority"})
    assert diag_m["patient_label_rule"] == "majority"
    assert sum(diag_m["per_split_class"][sp][POS]["patients"] for sp in ("train", "val", "test")) == 4  # ties → pos


# --------------------------------------------------------------------------- families


def test_family_allocation_never_moves_existing_patients():
    """Child versions: adding patients and changing labels never moves an existing patient; new patients are
    allocated toward the per-stratum targets given the existing counts."""
    from dermpath.splits import allocate

    rng = random.Random(11)
    for trial in range(15):
        pts = _cohort(rng.randint(3, 25), rng.randint(20, 80), prefix=f"t{trial}-")
        base, _ = allocate(pts, {"partition": "random", "seed": trial}, salt="fam")
        # Change some labels and add new patients (some positive).
        child = [dict(p) for p in pts]
        for p in rng.sample(child, 5):
            p["label"] = POS if p["label"] == NEG else NEG
        start = len(child)
        child += [{"id": f"t{trial}-new{i}", "code": f"N-{trial}-{i}", "label": POS if i % 3 == 0 else NEG,
                   "dates": [], "sites": set()} for i in range(rng.randint(1, 30))]
        # Drop a couple of existing patients too.
        dropped = {p["id"] for p in child[:2]}
        child = child[2:]
        mapping, diag = allocate(child, {"partition": "random", "seed": trial}, salt="fam", existing=base)
        for p in child:
            if p["id"] in base:
                assert mapping[p["id"]] == base[p["id"]], (trial, p["id"])
        assert diag["family"] == {"inherited": start - 2, "new": len(child) - (start - 2), "dropped": len(dropped)}
        # A different seed does not move inherited patients either (the family decides, not the seed).
        reseeded, _ = allocate(child, {"partition": "random", "seed": trial + 100}, salt="fam", existing=base)
        assert all(reseeded[p] == base[p] for p in base if p in reseeded)


def test_family_new_patients_fill_the_missing_class_first():
    from dermpath.splits import allocate

    existing = {f"e{i}": "train" for i in range(6)} | {"e6": "val", "e7": "test"}
    pts = [{"id": f"e{i}", "code": f"E{i}", "label": NEG, "dates": [], "sites": set()} for i in range(8)]
    pts += [{"id": f"n{i}", "code": f"N{i}", "label": POS, "dates": [], "sites": set()} for i in range(3)]
    mapping, diag = allocate(pts, {"partition": "random", "seed": 0}, existing=existing)
    assert sorted(mapping[f"n{i}"] for i in range(3)) == ["test", "train", "val"]
    assert all(mapping[k] == v for k, v in existing.items())
    assert diag["class_absent"] == []


def test_sealed_existing_patients_never_move_under_any_partition():
    from dermpath.splits import allocate

    pts = [{"id": f"p{i}", "code": f"C{i}", "label": POS if i % 4 == 0 else NEG,
            "dates": [date(2025, 1, 1) + timedelta(days=17 * i)], "sites": {"site-a" if i % 2 else "site-b"}}
           for i in range(40)]
    sealed = {f"p{i}": "test" for i in range(0, 40, 5)}
    for cfg in ({"partition": "random", "seed": 3},
                {"partition": "temporal", "test_cutoff": "2026-06-01", "val_cutoff": "2026-01-01"},
                {"partition": "external_site", "test_sites": ["site-a"], "seed": 2}):
        mapping, diag = allocate(pts, cfg, existing=sealed)
        assert all(mapping[k] == "test" for k in sealed), cfg


# --------------------------------------------------------------------------- grouping constraints


def test_duplicate_pairs_are_allocated_as_one_unit():
    from dermpath.splits import allocate

    pts = _cohort(20, 80)
    groups = [(pts[i]["id"], pts[i + 1]["id"]) for i in range(0, 60, 2)] + [(pts[90]["id"], pts[95]["id"]),
                                                                              (pts[95]["id"], pts[99]["id"])]
    for seed in range(10):
        mapping, diag = allocate(pts, {"partition": "random", "seed": seed}, groups=groups)
        for a, b in groups:
            assert mapping[a] == mapping[b]
        assert diag["grouping"]["constraints_applied"] == len(groups)
        assert len(diag["grouping"]["multi_patient_units"]) == 31
        t = _table(pts, mapping)
        assert t["val"][POS] >= 1 and t["test"][POS] >= 1


def test_grouping_conflict_with_inherited_splits_is_reported_and_nobody_moves():
    from dermpath.splits import allocate

    pts = _cohort(5, 15)
    existing = {pts[0]["id"]: "train", pts[1]["id"]: "test"}
    mapping, diag = allocate(pts, {"partition": "random", "seed": 0}, existing=existing,
                             groups=[(pts[0]["id"], pts[1]["id"]), (pts[1]["id"], pts[2]["id"])])
    assert mapping[pts[0]["id"]] == "train" and mapping[pts[1]["id"]] == "test"
    assert mapping[pts[2]["id"]] in ("train", "test")
    assert diag["grouping"]["conflicts"] and diag["grouping"]["conflicts"][0]["inherited_splits"] == {
        pts[0]["code"]: "train", pts[1]["code"]: "test"}


# --------------------------------------------------------------------------- validation


@pytest.mark.parametrize("cfg,code", [
    ({"partition": "temporal", "test_cutoff": "2026-01-01", "seed": 3}, "unused_split_parameter"),
    ({"partition": "temporal", "test_cutoff": "2026-01-01", "ratios": {"train": 1.0}}, "unused_split_parameter"),
    ({"partition": "temporal", "test_cutoff": "2026-01-01", "val_cutoff": "2026-01-01"}, "invalid_cutoff"),
    ({"partition": "temporal", "test_cutoff": "2026-01-01", "val_cutoff": "2026-02-01"}, "invalid_cutoff"),
    ({"partition": "temporal"}, "invalid_cutoff"),
    ({"partition": "external_site", "test_sites": ["a"], "ratios": {"train": 0.6, "val": 0.2, "test": 0.2}},
     "test_ratio_not_allowed"),
    ({"partition": "external_site", "test_sites": []}, "invalid_test_sites"),
    ({"partition": "external_site", "test_sites": ["a"], "test_cutoff": "2026-01-01"}, "unused_split_parameter"),
    ({"partition": "random", "seed": -5}, "invalid_seed"),
    ({"partition": "random", "seed": 2**31}, "invalid_seed"),
    ({"partition": "random", "seed": 1.9}, "invalid_seed"),
    ({"partition": "random", "seed": True}, "invalid_seed"),
    ({"partition": "random", "ratios": {"train": 0.6, "val": 0.2, "test": 0.2, "holdout": 5}}, "invalid_ratios"),
    ({"partition": "random", "ratios": {"train": 0.0, "val": 0.0, "test": 1.0}}, "invalid_ratios"),
    ({"partition": "random", "ratios": {"train": 0.6, "val": 0.2}}, "invalid_ratios"),
    ({"partition": "random", "test_site": ["typo"]}, "invalid_split_parameter"),
    ({"partition": "random", "patient_label_rule": "coin"}, "invalid_patient_label_rule"),
    ({"partition": "stratified"}, "invalid_partition"),
])
def test_normalise_split_rejects(cfg, code):
    from dermpath.errors import ApiError
    from dermpath.splits import normalise_split

    with pytest.raises(ApiError) as exc:
        normalise_split(cfg)
    assert exc.value.status == 422 and exc.value.code == code


def test_normalise_split_is_idempotent_and_stores_no_unused_parameters():
    from dermpath.splits import ALGORITHM, normalise_split

    t = normalise_split({"partition": "temporal", "test_cutoff": "2026-06-01", "val_cutoff": "2026-03-01"})
    assert "seed" not in t and "ratios" not in t and t["algorithm"] == ALGORITHM
    e = normalise_split({"partition": "external_site", "test_sites": ["b", "a", "a"], "seed": 4})
    assert e["ratios"] == {"train": 0.75, "val": 0.25} and e["test_sites"] == ["a", "b"]
    r = normalise_split({})
    assert r == {"partition": "random", "patient_label_rule": "any_positive", "algorithm": ALGORITHM, "seed": 0,
                 "ratios": {"train": 0.6, "val": 0.2, "test": 0.2}}
    for s in (t, e, r):
        assert normalise_split(s) == s


def test_external_site_validates_sites_and_stratifies_the_remainder():
    from dermpath.errors import ApiError
    from dermpath.splits import allocate

    rng = random.Random(3)
    pts = []
    for i in range(120):
        sites = {rng.choice(["site-a", "site-b", "site-c"])}
        if i % 17 == 0:
            sites = set()  # unknown site
        if i % 23 == 0:
            sites |= {"site-c", "site-a"}
        pts.append({"id": f"p{i}", "code": f"C{i:03d}", "label": POS if i % 10 == 0 else NEG, "dates": [],
                    "sites": sites})
    known = ["site-a", "site-b", "site-c"]
    with pytest.raises(ApiError) as exc:
        allocate(pts, {"partition": "external_site", "test_sites": ["site-C"]}, known_sites=known)
    assert exc.value.code == "unknown_site" and exc.value.details["unknown"] == ["site-C"]
    for seed in range(6):
        mapping, diag = allocate(pts, {"partition": "external_site", "test_sites": ["site-c"], "seed": seed},
                                 known_sites=known)
        for p in pts:
            assert (mapping[p["id"]] == "test") == ("site-c" in p["sites"])  # ANY case at the test site
        rest = [p for p in pts if "site-c" not in p["sites"]]
        val_pos = sum(1 for p in rest if mapping[p["id"]] == "val" and p["label"] == POS)
        n_pos_rest = sum(1 for p in rest if p["label"] == POS)
        assert val_pos >= 1 and abs(val_pos - 0.25 * n_pos_rest) < 1, (seed, val_pos, n_pos_rest)
        assert diag["patients_with_unknown_site"]["count"] == sum(1 for p in pts if not p["sites"])
        assert diag["achieved_test_fraction"] == round(sum(1 for p in pts if "site-c" in p["sites"]) / 120, 4)
        assert set(diag["per_site_patients_by_class"]) == {"site-a", "site-b", "site-c", "unknown"}


def test_temporal_reports_label_by_split_and_absent_classes():
    from dermpath.splits import allocate

    pts = [{"id": f"p{i}", "code": f"C{i}", "label": POS if i < 3 else NEG,
            "dates": [date(2025, 1, 1) + timedelta(days=30 * i)]} for i in range(12)]
    mapping, diag = allocate(pts, {"partition": "temporal", "test_cutoff": "2025-10-01", "val_cutoff": "2025-07-01"})
    # Dates: Jan 1 + 30 days × i → Jul 30, Aug 29, Sep 28 are val; Oct 28 and Nov 27 are test.
    assert [mapping[f"p{i}"] for i in range(12)] == ["train"] * 7 + ["val"] * 3 + ["test"] * 2
    assert diag["per_split_class"]["train"][POS]["patients"] == 3
    assert {(a["split"], a["class"]) for a in diag["class_absent"]} == {("val", POS), ("test", POS)}
    assert diag["date_range_per_split"]["test"] == {"earliest": "2025-10-28", "latest": "2025-11-27"}
    assert "seed" not in diag
    # Only the rule decides: a cohort entirely after the cutoff leaves train empty, and that is reported.
    late = [{**p, "dates": [date(2027, 1, 1)]} for p in pts]
    _, d2 = allocate(late, {"partition": "temporal", "test_cutoff": "2026-01-01"})
    assert d2["empty_splits"] == ["train"] and d2["active_splits"] == ["train", "test"]


def test_split_fingerprint_is_order_independent_and_sensitive():
    from dermpath.splits import split_fingerprint

    a = [("P-1", "train"), ("P-2", "test"), ("P-3", "val")]
    assert split_fingerprint(a) == split_fingerprint(reversed(a))
    assert split_fingerprint(a) != split_fingerprint([("P-1", "train"), ("P-2", "val"), ("P-3", "test")])
    assert len(split_fingerprint([])) == 64


def test_targets_largest_remainder_and_minimum_one():
    from dermpath.splits import largest_remainder, stratum_targets

    r = {"train": 0.6, "val": 0.2, "test": 0.2}
    assert largest_remainder(10, r) == {"train": 6, "val": 2, "test": 2}
    assert largest_remainder(2, r) == {"train": 1, "val": 1, "test": 0}
    assert stratum_targets(3, r) == ({"train": 1, "val": 1, "test": 1}, 1)
    assert stratum_targets(2, r) == ({"train": 1, "val": 1, "test": 0}, 0)  # infeasible: no move
    assert stratum_targets(3, {"train": 0.7, "val": 0.15, "test": 0.15}) == ({"train": 1, "val": 1, "test": 1}, 1)
    for n in range(0, 200):
        t, _ = stratum_targets(n, r)
        assert sum(t.values()) == n
