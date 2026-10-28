"""Adversarial verification of the splits and datasets guarantees (design §2 and §9).

Every test asserts a guarantee. A failing test is the reproduction of a defect; a passing one stays as regression
coverage. Pure-allocator properties come first (random cohorts of 3..500 patients, prevalence 0.5 %..60 %, many
ratios including a zero validation split, many seeds), then end-to-end checks through the HTTP API and the dataset
functions on separate fictional projects: the original 10/90 defect, split families (label flips, removals,
re-admission, additions, sibling drafts, sealing), stale-draft detection at freeze, temporal and external-site
edge cases, data-mode refusal and the audit block.
"""

from __future__ import annotations

import ast
import hashlib
import json
import math
import os
import random
import subprocess
import sys
from collections import Counter
from datetime import date, timedelta
from fractions import Fraction
from pathlib import Path

import pytest

POS, NEG = "bcc_present", "bcc_absent_not_benign"
SPLITS = ("train", "val", "test")
API_DIR = Path(__file__).resolve().parent.parent
LEAD_ID, PATHOLOGIST_ID = "user-research-lead", "user-pathologist"

RATIOS = (
    {"train": 0.6, "val": 0.2, "test": 0.2},
    {"train": 0.8, "val": 0.0, "test": 0.2},
    {"train": 0.7, "val": 0.15, "test": 0.15},
    {"train": 0.5, "val": 0.25, "test": 0.25},
    {"train": 0.34, "val": 0.33, "test": 0.33},
    {"train": 0.9, "val": 0.05, "test": 0.05},
    {"train": 0.75, "val": 0.25, "test": 0.0},
    {"train": 0.8, "val": 0.1, "test": 0.1},
    {"train": 0.1, "val": 0.45, "test": 0.45},
    {"train": 1.0, "val": 0.0, "test": 0.0},
)


def _h(*parts) -> int:
    """Deterministic integer from the parts (keeps the property cohorts independent of the random module)."""
    return int(hashlib.sha256("|".join(map(str, parts)).encode()).hexdigest(), 16)


def _cohort(k: int, n: int, n_pos: int, *, tag: str = "c") -> list[dict]:
    return [{"id": f"{tag}{k}-id{i:04d}", "code": f"{tag.upper()}{_h(tag, k, i) % 10**8:08d}-{i:03d}",
             "label": POS if i < n_pos else NEG} for i in range(n)]


def _counts(pts, mapping, cls) -> dict[str, int]:
    return {sp: sum(1 for p in pts if p["label"] == cls and mapping[p["id"]] == sp) for sp in SPLITS}


def _exact_lr(n: int, ratios: dict) -> dict[str, int]:
    """Reference largest remainder in exact rationals; ties go to the split order (train, val, test)."""
    raw = {s: Fraction(str(ratios.get(s, 0.0))) * n for s in SPLITS}
    base = {s: math.floor(raw[s]) for s in SPLITS}
    cand = sorted((s for s in SPLITS if ratios.get(s, 0.0) > 0), key=lambda s: (-(raw[s] - base[s]), SPLITS.index(s)))
    for i in range(n - sum(base.values())):
        base[cand[i % len(cand)]] += 1
    return base


# =========================================================================== the original defect (pure)


@pytest.mark.parametrize("salt", ["", "family-a", "3f2a9c0d11e84b6c9f0a7e5d2c1b0a99"])
def test_original_defect_10_pos_90_neg_gives_val_and_test_two_positives(salt):
    """10 positive / 90 negative patients at 60/20/20 once put all 10 positives in train. Every seed and family salt
    must now give exactly 6/2/2 positives and 54/18/18 negatives (largest-remainder targets)."""
    from dermpath.splits import allocate

    pts = _cohort(0, 100, 10, tag="d")
    for seed in list(range(25)) + [2**31 - 1, 123456789]:
        mapping, diag = allocate(pts, {"partition": "random", "seed": seed,
                                       "ratios": {"train": 0.6, "val": 0.2, "test": 0.2}}, salt=salt)
        assert _counts(pts, mapping, POS) == {"train": 6, "val": 2, "test": 2}, (salt, seed)
        assert _counts(pts, mapping, NEG) == {"train": 54, "val": 18, "test": 18}, (salt, seed)
        assert diag["class_absent"] == [] and diag["empty_splits"] == []


# =========================================================================== stratification properties (pure)


def test_property_random_cohorts_exact_targets_presence_and_reporting():
    """600 cohorts: n in 3..500, prevalence 0.5 %..60 %, ten ratio sets (zero val / zero test / train only), random
    seeds. For singleton units: every patient in exactly one split; zero-ratio splits stay empty; per-split class
    counts equal the reported targets; with no minimum-one move they equal largest remainder exactly (within ±1 of
    ratio × n), otherwise they differ from it by at most the number of moves; both classes are in every active split
    whenever the class has at least as many patients as active splits; class_absent and empty_splits are exactly the
    observed holes; per_split_class matches the mapping."""
    from dermpath.splits import allocate, largest_remainder, stratum_targets

    for k in range(600):
        n = 3 + _h("n", k) % 498
        prevalence = 0.005 + (_h("p", k) % 10_000) / 10_000 * 0.595
        n_pos = min(n, round(prevalence * n))
        ratios = RATIOS[_h("r", k) % len(RATIOS)]
        seed = _h("s", k) % 2**31
        pts = _cohort(k, n, n_pos)
        mapping, diag = allocate(pts, {"partition": "random", "seed": seed, "ratios": ratios}, salt=f"salt{k % 7}")
        ctx = (k, n, n_pos, ratios, seed)
        assert set(mapping) == {p["id"] for p in pts} and set(mapping.values()) <= set(SPLITS), ctx
        active = [s for s in SPLITS if ratios[s] > 0]
        assert diag["active_splits"] == active, ctx
        observed_absent = set()
        for cls, n_cls in ((POS, n_pos), (NEG, n - n_pos)):
            got = _counts(pts, mapping, cls)
            if n_cls == 0:
                assert got == {s: 0 for s in SPLITS}
                continue
            targets, moves = stratum_targets(n_cls, ratios)
            lr = largest_remainder(n_cls, ratios)
            assert got == targets == diag["targets"][cls], (ctx, cls, got, targets)
            for s in SPLITS:
                if ratios[s] == 0:
                    assert got[s] == 0, (ctx, cls, s)
                assert abs(lr[s] - ratios[s] * n_cls) < 1 + 1e-9, (ctx, cls, lr)
                assert abs(got[s] - lr[s]) <= moves, (ctx, cls, got, lr, moves)
                assert diag["per_split_class"][s][cls]["patients"] == got[s], ctx
            if n_cls >= len(active):
                assert all(got[s] >= 1 for s in active), (ctx, cls, got)
            observed_absent |= {(s, cls) for s in active if got[s] == 0}
        assert {(a["split"], a["class"]) for a in diag["class_absent"]} == observed_absent, ctx
        assert diag["empty_splits"] == [s for s in active if not any(v == s for v in mapping.values())], ctx


@pytest.mark.parametrize("rule", ["any_positive", "majority"])
def test_property_bag_labels_stratify_by_rule_and_every_bag_keeps_its_label(rule):
    """Patients with 1..4 bags of mixed labels: the stratum follows patient_label_rule, the per-stratum counts hit the
    targets exactly, mixed-label patients are all listed, and slide counts keep every bag's own label."""
    from dermpath.splits import allocate, patient_label, stratum_targets

    for k in range(80):
        n = 5 + _h("bn", k) % 200
        pts = []
        for i in range(n):
            nb = 1 + _h("nb", k, i) % 4
            bags = [POS if _h("bag", k, i, j) % 100 < 18 else NEG for j in range(nb)]
            pts.append({"id": f"b{k}-{i}", "code": f"B{_h('bc', k, i) % 10**9:09d}", "labels": bags,
                        "slide_labels": bags})
        ratios = RATIOS[k % 9]
        mapping, diag = allocate(pts, {"partition": "random", "seed": k, "ratios": ratios, "patient_label_rule": rule})
        strata = Counter(patient_label(p["labels"], rule) for p in pts)
        for cls, n_cls in strata.items():
            got = {s: sum(1 for p in pts if patient_label(p["labels"], rule) == cls and mapping[p["id"]] == s)
                   for s in SPLITS}
            assert got == stratum_targets(n_cls, ratios)[0], (k, rule, cls, got)
        mixed = sorted(p["code"] for p in pts if len(set(p["labels"])) > 1)
        assert diag["mixed_label_patients"]["count"] == len(mixed)
        assert diag["mixed_label_patients"]["patient_codes"] == mixed[:200]
        for s in SPLITS:
            for cls in (POS, NEG):
                slides = sum(p["labels"].count(cls) for p in pts if mapping[p["id"]] == s)
                assert diag["per_split_class"][s].get(cls, {"slides": 0})["slides"] == slides, (k, s, cls)


def _diag_for_compare(diag: dict) -> str:
    return json.dumps(diag, sort_keys=True, default=sorted)


def test_property_uuid_and_input_order_independence_with_groups_and_families():
    """Content-stable ordering: the same cohort under fresh uuids and any input order gives the same
    {patient_code: split} and the same diagnostics, for every partition, with grouping pairs and inherited
    family assignments."""
    from dermpath.splits import allocate

    rng = random.Random(20261026)
    d0 = date(2025, 1, 1)
    for k in range(40):
        n = 8 + _h("un", k) % 150
        pts = []
        for i in range(n):
            pts.append({"id": f"u{k}-{i}", "code": f"U{_h('uc', k, i) % 10**9:09d}",
                        "label": POS if _h("ul", k, i) % 100 < 25 else NEG,
                        "dates": [d0 + timedelta(days=_h("ud", k, i, j) % 700) for j in range(1 + i % 2)],
                        "sites": {f"site-{_h('us', k, i) % 4}"} if i % 11 else set()})
        groups = [(pts[(_h("ga", k, j) % n)]["id"], pts[(_h("gb", k, j) % n)]["id"]) for j in range(n // 10)]
        existing = {pts[i]["id"]: SPLITS[_h("ex", k, i) % 3] for i in range(0, n, 7)}
        cfg = [{"partition": "random", "seed": k, "ratios": RATIOS[k % 9]},
               {"partition": "temporal", "test_cutoff": "2026-06-01", "val_cutoff": "2026-01-01"},
               {"partition": "external_site", "test_sites": ["site-1"], "seed": k}][k % 3]
        m1, diag1 = allocate(pts, cfg, salt="fam", existing=existing, groups=groups)
        ids = {p["id"]: hashlib.sha256(f"uuid|{k}|{p['id']}".encode()).hexdigest()[:32] for p in pts}
        shuffled = [{**p, "id": ids[p["id"]]} for p in pts]
        rng.shuffle(shuffled)
        m2, diag2 = allocate(shuffled, cfg, salt="fam", existing={ids[a]: s for a, s in existing.items()},
                             groups=[(ids[b], ids[a]) for a, b in reversed(groups)])
        assert {p["code"]: m1[p["id"]] for p in pts} == {p["code"]: m2[ids[p["id"]]] for p in pts}, (k, cfg)
        assert _diag_for_compare(diag1) == _diag_for_compare(diag2), (k, cfg)


_HASHSEED_SCRIPT = r"""
import hashlib, json, sys
from datetime import date, timedelta
sys.path.insert(0, sys.argv[1])
from dermpath.splits import allocate, split_fingerprint
def h(*a): return int(hashlib.sha256("|".join(map(str, a)).encode()).hexdigest(), 16)
out = []
for k in range(12):
    n = 20 + h("n", k) % 180
    pts = [{"id": f"x{k}-{i}", "code": f"X{h('c', k, i) % 10**9:09d}", "labels": ["bcc_present" if h("l", k, i, j) % 9 == 0
            else "bcc_absent_not_benign" for j in range(1 + i % 3)],
            "dates": [date(2025, 1, 1) + timedelta(days=h("d", k, i) % 600)],
            "sites": {f"s{h('s', k, i) % 3}", f"s{h('t', k, i) % 5}"}} for i in range(n)]
    groups = [(f"x{k}-{h('a', k, j) % n}", f"x{k}-{h('b', k, j) % n}") for j in range(n // 8)]
    existing = {f"x{k}-{i}": ("train", "val", "test")[h("e", k, i) % 3] for i in range(0, n, 9)}
    for cfg in ({"partition": "random", "seed": k, "patient_label_rule": ("any_positive", "majority")[k % 2]},
                {"partition": "temporal", "test_cutoff": "2026-03-01", "val_cutoff": "2025-10-01"},
                {"partition": "external_site", "test_sites": ["s1", "s4"], "seed": k}):
        m, d = allocate(pts, cfg, salt="hs", existing=existing, groups=groups)
        out.append([split_fingerprint((p["code"], m[p["id"]]) for p in pts),
                    hashlib.sha256(json.dumps(d, sort_keys=True, default=sorted).encode()).hexdigest()])
print(hashlib.sha256(json.dumps(out).encode()).hexdigest())
"""


def test_allocation_is_independent_of_python_hash_randomisation():
    """Python-version / interpreter independence: set and dict iteration must never reach the result. The same
    allocations (random, temporal, external_site; groups; families; both label rules) under PYTHONHASHSEED 0, 1 and
    2718281 give byte-identical fingerprints and diagnostics."""
    digests = set()
    for hs in ("0", "1", "2718281"):
        env = {**os.environ, "PYTHONHASHSEED": hs}
        r = subprocess.run([sys.executable, "-c", _HASHSEED_SCRIPT, str(API_DIR)], env=env, capture_output=True,
                           text=True, timeout=60, cwd=str(API_DIR))
        assert r.returncode == 0, r.stderr
        digests.add(r.stdout.strip())
    assert len(digests) == 1, digests


def test_splits_module_has_no_nondeterministic_sources():
    """No random module, uuid, secrets, time or builtin hash()/id() in the allocator (ordering is sha256 only)."""
    src = (API_DIR / "dermpath" / "splits.py").read_text()
    tree = ast.parse(src)
    banned_modules = {"random", "uuid", "secrets", "time", "numpy"}
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            assert not {a.name.split(".")[0] for a in node.names} & banned_modules
        if isinstance(node, ast.ImportFrom):
            assert (node.module or "").split(".")[0] not in banned_modules
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name):
            assert node.func.id not in ("hash", "id"), ast.dump(node)


def test_largest_remainder_ties_follow_split_order_not_float_noise():
    """``largest_remainder`` documents '(ties: order)'. Exact-rational remainders that tie must be broken by the
    split order (train, val, test), not by binary floating-point noise in ``ratio × n``. 70/10/20 with 8 patients:
    5.6, 0.8, 1.6 → floors 5, 0, 1; two left; val (0.8) first, then train and test tie at 0.6 → train by order:
    {6, 1, 1}. Float noise (0.7 × 8 = 5.59999…, 0.2 × 8 = 1.6000…01) currently gives test the patient."""
    from dermpath.splits import largest_remainder

    cases = []
    for ratios in ({"train": 0.7, "val": 0.1, "test": 0.2}, {"train": 0.65, "val": 0.15, "test": 0.2},
                   {"train": 0.7, "val": 0.2, "test": 0.1}, {"train": 0.6, "val": 0.2, "test": 0.2}):
        for n in range(1, 120):
            got, want = largest_remainder(n, ratios), _exact_lr(n, ratios)
            if got != want:
                cases.append((ratios, n, got, want))
    assert cases == [], f"{len(cases)} tie-breaks decided by float noise, e.g. {cases[:3]}"


# =========================================================================== grouping constraints (pure)


def test_property_grouping_units_never_split_under_any_partition():
    """Union-find units (chains, stars, cliques) are allocated whole under random, temporal and external_site; an
    inherited member decides the unit; only two inherited members with different splits may disagree (reported as a
    conflict, nobody moves)."""
    from dermpath.splits import allocate

    d0 = date(2025, 1, 1)
    for k in range(60):
        n = 10 + _h("gn", k) % 250
        pts = [{"id": f"g{k}-{i}", "code": f"G{_h('gc', k, i) % 10**9:09d}",
                "label": POS if _h("gl", k, i) % 100 < 20 else NEG,
                "dates": [d0 + timedelta(days=_h("gd", k, i) % 720)],
                "sites": {f"site-{_h('gs', k, i) % 3}"}} for i in range(n)]
        ids = [p["id"] for p in pts]
        groups = []
        for j in range(n // 6):  # chains and stars
            a, b = _h("ga", k, j) % n, _h("gb", k, j) % n
            groups.append((ids[a], ids[b]))
        clique = [ids[i] for i in range(0, min(n, 12), 3)]
        groups += [(a, b) for a in clique for b in clique if a < b]
        existing = {ids[i]: SPLITS[_h("ge", k, i) % 3] for i in range(0, n, 13)} if k % 2 else None
        cfg = [{"partition": "random", "seed": k, "ratios": RATIOS[k % 9]},
               {"partition": "temporal", "test_cutoff": "2026-09-01", "val_cutoff": "2026-03-01"},
               {"partition": "external_site", "test_sites": ["site-2"], "seed": k}][k % 3]
        mapping, diag = allocate(pts, cfg, existing=existing, groups=groups)
        # Recompute the units independently.
        parent = {i: i for i in ids}

        def find(x):
            while parent[x] != x:
                x = parent[x]
            return x

        for a, b in groups:
            ra, rb = find(a), find(b)
            if ra != rb:
                parent[ra] = rb
        units: dict[str, list[str]] = {}
        for i in ids:
            units.setdefault(find(i), []).append(i)
        for members in units.values():
            inherited = {existing[m] for m in members if existing and m in existing}
            for m in members:
                if existing and m in existing:
                    assert mapping[m] == existing[m], (k, cfg, m)
            if len(inherited) <= 1:
                assert len({mapping[m] for m in members}) == 1, (k, cfg, members)
                if inherited:
                    assert {mapping[m] for m in members} == inherited, (k, cfg)
            else:
                codes = {p["code"] for p in pts if p["id"] in members}
                assert any(set(c["patient_codes"]) == codes for c in diag["grouping"]["conflicts"]), (k, cfg)


def test_grouping_units_keep_both_classes_in_every_split_when_feasible():
    """Design §2: every split with ratio > 0 gets at least one patient of each class whenever the class has at least
    as many patients as such splits; with grouping units this is feasible whenever the class has at least as many
    UNITS as active splits. 5 positive patients in units of sizes 2, 2 and 1 (two confirmed near-duplicate pairs)
    at 60/20/20: (2 → train, 2 → val, 1 → test) satisfies it, yet both pairs go to train and test gets no positive
    for every seed."""
    from dermpath.splits import allocate

    pts = [{"id": f"p{i}", "code": f"P{i:02d}", "label": POS} for i in range(5)]
    pts += [{"id": f"n{i}", "code": f"N{i:02d}", "label": NEG} for i in range(30)]
    groups = [("p0", "p1"), ("p2", "p3")]
    failures = []
    for seed in range(20):
        mapping, diag = allocate(pts, {"partition": "random", "seed": seed}, groups=groups)
        assert mapping["p0"] == mapping["p1"] and mapping["p2"] == mapping["p3"]
        got = _counts(pts, mapping, POS)
        if min(got.values()) == 0:
            failures.append((seed, got, [(a["split"], a["class"]) for a in diag["class_absent"]]))
    assert failures == [], f"{len(failures)}/20 seeds leave a split without positives: {failures[:3]}"


# =========================================================================== families (pure)


def test_property_family_inheritance_never_moves_an_existing_patient():
    """Random lineages of up to four versions per partition: label flips, removals, re-admissions, additions, new
    duplicate pairs (also joining inherited and new patients) and a different seed in the request. Every patient
    already in the family keeps their first split; new patients go only to splits the configuration populates."""
    from dermpath.splits import allocate

    d0 = date(2025, 1, 1)
    for k in range(36):
        cfg = [{"partition": "random", "seed": k, "ratios": RATIOS[k % 9]},
               {"partition": "temporal", "test_cutoff": "2026-06-01", "val_cutoff": "2026-01-01"},
               {"partition": "temporal", "test_cutoff": "2026-06-01"},
               {"partition": "external_site", "test_sites": ["site-1"], "seed": k}][k % 4]
        n = 6 + _h("fn", k) % 120
        pool = [{"id": f"f{k}-{i}", "code": f"F{_h('fc', k, i) % 10**9:09d}",
                 "label": POS if _h("fl", k, i) % 100 < 22 else NEG,
                 "dates": [d0 + timedelta(days=_h("fd", k, i) % 700)],
                 "sites": {f"site-{_h('fs', k, i) % 3}"}} for i in range(n + 60)]
        present = {p["id"] for p in pool[:n]}
        family: dict[str, str] = {}
        for version in range(4):
            cohort = [dict(p) for p in pool if p["id"] in present]
            mapping, diag = allocate(cohort, cfg, salt=f"fam{k}", existing=dict(family),
                                     groups=[(cohort[i]["id"], cohort[-1 - i]["id"]) for i in range(0, len(cohort) // 9)])
            for pid, sp in family.items():
                if pid in mapping:
                    assert mapping[pid] == sp, (k, version, cfg, pid)
            active = set(diag["active_splits"])
            for p in cohort:
                if p["id"] not in family:
                    assert mapping[p["id"]] in active, (k, version, cfg)
            assert diag["family"]["inherited"] == sum(1 for p in cohort if p["id"] in family)
            assert diag["family"]["dropped"] == len(set(family) - {p["id"] for p in cohort})
            for pid, sp in mapping.items():
                family.setdefault(pid, sp)  # what freeze writes for new patients
            # Next version: flip labels, drop some, re-admit some, add new patients.
            for p in pool:
                if p["id"] in present and _h("flip", k, version, p["id"]) % 6 == 0:
                    p["label"] = POS if p["label"] == NEG else NEG
                    p["dates"] = p["dates"] + [date(2026, 12, 1)]  # a later case (temporal rule says test)
            dropped = {pid for pid in present if _h("drop", k, version, pid) % 9 == 0}
            readmit = {pid for pid in family if pid not in present and _h("re", k, version, pid) % 2 == 0}
            added = {p["id"] for p in pool if p["id"] not in family and _h("add", k, version, p["id"]) % 4 == 0}
            present = (present - dropped) | readmit | added


def test_family_new_patients_fill_a_split_missing_the_class_when_feasible():
    """Families: new patients are allocated toward the per-stratum targets given the existing counts, and every
    split with ratio > 0 must still get a patient of each class when that is feasible. Realistic case: a test release
    sealed 2 positive patients in test; a later allocation (child version, or a new lineage whose sealed patients
    stay pinned) has 2 new positive patients at 60/20/20. Targets are {train 2, val 1, test 1}; test already holds 2,
    so (train 1, val 1) is feasible, but both new positives go to train (largest deficit first, train wins the tie)
    and val has no positive patient, for every seed."""
    from dermpath.splits import allocate

    negatives = [{"id": f"n{i}", "code": f"N{i:02d}", "label": NEG} for i in range(40)]
    base, _ = allocate(negatives, {"partition": "random", "seed": 0}, salt="fam")
    pts = negatives + [{"id": "s0", "code": "S0", "label": POS}, {"id": "s1", "code": "S1", "label": POS},
                       {"id": "new0", "code": "NEW0", "label": POS}, {"id": "new1", "code": "NEW1", "label": POS}]
    existing = {**base, "s0": "test", "s1": "test"}
    failures = []
    for seed in range(10):
        mapping, diag = allocate(pts, {"partition": "random", "seed": seed}, salt="fam", existing=existing)
        assert mapping["s0"] == mapping["s1"] == "test"
        got = _counts(pts, mapping, POS)
        if got["val"] == 0 or got["train"] == 0:
            failures.append((seed, got, diag["targets"][POS]))
    assert failures == [], f"{len(failures)}/10 seeds leave val without positives: {failures[:2]}"


# =========================================================================== temporal and external site (pure)


def test_temporal_cutoff_equality_latest_date_units_and_missing_dates():
    from dermpath.errors import ApiError
    from dermpath.splits import allocate

    tc, vc = date(2026, 6, 1), date(2026, 3, 1)
    pts = [
        {"id": "eq-test", "code": "EQ-T", "label": POS, "dates": [tc]},
        {"id": "eq-val", "code": "EQ-V", "label": POS, "dates": [vc]},
        {"id": "before-val", "code": "BV", "label": NEG, "dates": [vc - timedelta(days=1)]},
        {"id": "before-test", "code": "BT", "label": NEG, "dates": [tc - timedelta(days=1)]},
        {"id": "span", "code": "SPAN", "label": NEG, "dates": [date(2025, 1, 1), tc + timedelta(days=3)]},
        {"id": "unit-a", "code": "UA", "label": NEG, "dates": [date(2025, 5, 5)]},
        {"id": "unit-b", "code": "UB", "label": NEG, "dates": [vc + timedelta(days=10)]},
    ]
    cfg = {"partition": "temporal", "test_cutoff": tc.isoformat(), "val_cutoff": vc.isoformat()}
    mapping, diag = allocate(pts, cfg, groups=[("unit-a", "unit-b")])
    assert mapping == {"eq-test": "test", "eq-val": "val", "before-val": "train", "before-test": "val",
                       "span": "test", "unit-a": "val", "unit-b": "val"}
    assert diag["patients_spanning_a_cutoff"] >= 2  # SPAN (earliest before test cut) and UA (in val, earlier date)
    # Without val_cutoff, val is never populated and is not an active split.
    m2, d2 = allocate(pts, {"partition": "temporal", "test_cutoff": tc.isoformat()})
    assert "val" not in m2.values() and d2["active_splits"] == ["train", "test"]
    # All patients on one side: allocation succeeds and the empty splits / missing classes are reported.
    m3, d3 = allocate(pts, {"partition": "temporal", "test_cutoff": "2030-01-01", "val_cutoff": "2029-01-01"})
    assert set(m3.values()) == {"train"} and d3["empty_splits"] == ["val", "test"]
    assert {(a["split"], a["class"]) for a in d3["class_absent"]} == {(s, c) for s in ("val", "test") for c in (POS, NEG)}
    m4, d4 = allocate(pts, {"partition": "temporal", "test_cutoff": "2020-01-01"})
    assert set(m4.values()) == {"test"} and d4["empty_splits"] == ["train"]
    # Missing dates: refused, naming the patients; an included case without a date counts even if others have one.
    bad = pts + [{"id": "nodate", "code": "ND", "label": NEG, "dates": []},
                 {"id": "partial", "code": "PD", "label": NEG, "dates": [date(2025, 1, 1)], "missing_date_cases": ["c9"]}]
    with pytest.raises(ApiError) as exc:
        allocate(bad, cfg)
    assert exc.value.status == 422 and exc.value.code == "missing_collected_on"
    assert exc.value.details["patients"] == ["nodate", "partial"]
    # Inherited patients keep their split against the rule, and are reported.
    m5, d5 = allocate(pts, cfg, existing={"eq-test": "train"})
    assert m5["eq-test"] == "train" and d5["inherited_against_rule"] == ["EQ-T"]


def test_external_site_edges_unknown_sites_one_sided_cohorts_and_remainder_stratification():
    from dermpath.errors import ApiError
    from dermpath.splits import allocate, stratum_targets

    pts = []
    for i in range(90):
        sites = {("site-a", "site-b", "site-c")[i % 3]}
        if i % 10 == 0:
            sites = set()
        if i % 14 == 0:
            sites |= {"site-c"}
        pts.append({"id": f"x{i}", "code": f"X{i:03d}", "label": POS if i % 6 == 0 else NEG, "sites": sites})
    known = ["site-a", "site-b", "site-c"]
    for bad_sites in (["Site-C"], ["site-d"], ["site-c", "elsewhere"]):
        with pytest.raises(ApiError) as exc:
            allocate(pts, {"partition": "external_site", "test_sites": bad_sites}, known_sites=known)
        assert exc.value.status == 422 and exc.value.code == "unknown_site", bad_sites
    for seed in range(8):
        for ratios in ({"train": 0.75, "val": 0.25}, {"train": 0.9, "val": 0.1}, {"train": 1.0, "val": 0.0}):
            mapping, diag = allocate(pts, {"partition": "external_site", "test_sites": [" site-c "], "seed": seed,
                                           "ratios": ratios}, known_sites=known)
            for p in pts:
                assert (mapping[p["id"]] == "test") == ("site-c" in p["sites"]), (seed, p)
                if not p["sites"]:
                    assert mapping[p["id"]] != "test"
            rest = [p for p in pts if "site-c" not in p["sites"]]
            for cls in (POS, NEG):
                n_cls = sum(1 for p in rest if p["label"] == cls)
                got = {s: sum(1 for p in rest if p["label"] == cls and mapping[p["id"]] == s) for s in ("train", "val")}
                want = stratum_targets(n_cls, ratios, ("train", "val"))[0]
                assert got == want == diag["remainder_targets"][cls], (seed, ratios, cls, got, want)
            assert diag["active_splits"] == [s for s in ("train", "val") if ratios[s] > 0] + ["test"]
            assert diag["patients_with_unknown_site"]["count"] == sum(1 for p in pts if not p["sites"])
    # Everyone at a test site: train and val are empty and reported, nothing is refused.
    one = [{**p, "sites": {"site-a"}} for p in pts]
    m, d = allocate(one, {"partition": "external_site", "test_sites": ["site-a"]}, known_sites=known)
    assert set(m.values()) == {"test"} and d["empty_splits"] == ["train", "val"] and d["achieved_test_fraction"] == 1.0
    assert {(a["split"], a["class"]) for a in d["class_absent"]} == {(s, c) for s in ("train", "val") for c in (POS, NEG)}
    # Nobody at the (known) test site: test is empty and reported.
    m, d = allocate([p for p in pts if "site-c" not in p["sites"]],
                    {"partition": "external_site", "test_sites": ["site-c"]}, known_sites=known)
    assert "test" not in m.values() and d["empty_splits"] == ["test"]


def test_association_statistics_are_always_finite_or_explicitly_undefined():
    """dataset_audit.association on 400 random tables (2..6 × 2..6, sparse, with empty rows/columns, large counts):
    Cramér's V in [0, 1], p in [0, 1], all finite and JSON-serialisable without NaN; degenerate tables give None with
    a reason."""
    from dermpath.dataset_audit import association, contingency

    rng = random.Random(7)
    for t in range(400):
        rows, cols = rng.randint(1, 6), rng.randint(1, 6)
        table = {f"r{i}": {f"c{j}": (0 if rng.random() < 0.35 else rng.randint(0, 3 if t % 2 else 400))
                           for j in range(cols)} for i in range(rows)}
        out = association(table)
        json.dumps(out, allow_nan=False)
        if out["cramers_v"] is None:
            assert out["undefined_reason"] and out["p_value"] is None
        else:
            assert 0.0 <= out["cramers_v"] <= 1.0 and 0.0 <= out["p_value"] <= 1.0, (table, out)
            assert math.isfinite(out["min_expected"]) and out["min_expected"] > 0
    assert association(contingency([("a", "x"), ("a", "y")]))["undefined_reason"]
    perfect = association(contingency([("pos", "s1")] * 5 + [("neg", "s2")] * 5))
    assert perfect["cramers_v"] == 1.0 and perfect["test"].startswith("fisher")


# =========================================================================== end to end (API + dataset functions)


def _actor(kind: str):
    from feature_set_support import actors

    return actors()[kind]


def _new_project(db, project_id: str):
    from feature_set_support import _project

    return _project(db, project_id, "split verification cohort (fictional records)")


def _patient(db, project_id: str, code: str, labels: list[str], *, site: str | None = "site-a",
             collected: date | None = date(2026, 1, 15), provenance: str = "real_authorized", image_kind: str = "wsi",
             scanners: tuple[str, ...] = ("scanner-a",), stain: str = "H&E", mpp: float | None = 0.25,
             extra_cases: tuple[tuple[str | None, date | None], ...] = ()) -> dict:
    """A coded patient with one case (one block, one approved expert-labelled slide per label) and optional extra
    cases without slides (they still define the patient's dates and sites)."""
    from dermpath.labels import create_expert_label
    from dermpath.models import Block, Case, CodedPatient, Slide, SpecimenPart
    from dermpath.review import set_review_state

    patient = CodedPatient(project_id=project_id, code=code, created_by="test")
    db.add(patient)
    db.flush()
    case = Case(project_id=project_id, coded_patient_id=patient.id, accession_code=f"A-{code}", collected_on=collected,
                site_id=site, provenance=provenance)
    db.add(case)
    db.flush()
    part = SpecimenPart(project_id=project_id, case_id=case.id, designation="A")
    db.add(part)
    db.flush()
    block = Block(project_id=project_id, part_id=part.id, designation="A1")
    db.add(block)
    db.flush()
    slide_ids = []
    for i, value in enumerate(labels):
        s = Slide(project_id=project_id, block_id=block.id, level_index=i + 1, stain=stain,
                  scanner_id=scanners[i % len(scanners)], provenance=provenance, image_kind=image_kind,
                  object_key=f"verify/{project_id}/{code}/{i}", mpp_x=mpp, mpp_y=mpp, ingest_status="succeeded",
                  sha256=hashlib.sha256(f"verify|{project_id}|{code}|{i}".encode()).hexdigest())
        db.add(s)
        db.flush()
        create_expert_label(db, _actor("pathologist"), s, scope="slide", target_id=None, value=value,
                            reason="verification fixture label (fictional)")
        set_review_state(db, None, s, "approved", reason=None, system=True)
        slide_ids.append(s.id)
    for j, (xsite, xdate) in enumerate(extra_cases):
        db.add(Case(project_id=project_id, coded_patient_id=patient.id, accession_code=f"A-{code}-x{j}",
                    collected_on=xdate, site_id=xsite, provenance=provenance))
    db.flush()
    return {"id": patient.id, "code": code, "case_id": case.id, "slides": slide_ids}


def _config(split: dict | None = None, **extra) -> dict:
    cfg = {"label_scope": "slide", "eligible_review_states": ["approved"], "label_values": [POS, NEG]}
    if split is not None:
        cfg["split"] = split
    cfg.update(extra)
    return cfg


def _create(lead, project_id: str, name: str, split: dict | None = None, **extra) -> dict:
    r = lead.post(f"/api/v1/projects/{project_id}/datasets", json={"name": name, "config": _config(split, **extra)})
    assert r.status_code == 201, r.text
    return r.json()


def _freeze(lead, dsid: str, *, ack: bool = True):
    return lead.post(f"/api/v1/datasets/{dsid}/freeze", json={"reason": "verification freeze", "acknowledge_warnings": ack})


def _manifest(lead, dsid: str) -> dict:
    r = lead.get(f"/api/v1/datasets/{dsid}/manifest")
    assert r.status_code == 200, r.text
    return r.json()["manifest"]


def _split_by_code(manifest: dict) -> dict[str, str]:
    return {s["patient_code"]: s["split"] for s in manifest["splits"]}


def _assert_one_split_per_patient(rows: list[dict]) -> None:
    seen: dict[str, set] = {}
    for r in rows:
        seen.setdefault(r["coded_patient_id"], set()).add(r["split"])
    assert all(len(v) == 1 and None not in v for v in seen.values()), {k: v for k, v in seen.items() if len(v) != 1}


def _draft_splits(dsid: str) -> dict[str, str]:
    from dermpath.datasets import item_rows
    from dermpath.db import session_scope
    from dermpath.models import DatasetVersion

    with session_scope() as db:
        rows = item_rows(db, db.get(DatasetVersion, dsid))
    _assert_one_split_per_patient(rows)
    return {r["patient_code"]: r["split"] for r in rows}


def test_e2e_original_defect_scenario_through_the_api(clients):
    """The audit's critical finding end to end: 100 patients (10 positive) frozen at 60/20/20 through the API. The
    manifest must put exactly 2 positive patients in val and 2 in test for several seeds; freeze needs no
    acknowledgement (no split lacks a class); the stored allocation is a pure function of the patient codes (fresh
    uuids give the same splits) and a second lineage with the same configuration reproduces it."""
    from dermpath.datasets import _patient_infos, lineage_family
    from dermpath.db import session_scope
    from dermpath.models import DatasetVersion
    from dermpath.splits import allocate, split_fingerprint

    pid = "proj-verify-defect"
    with session_scope() as db:
        _new_project(db, pid)
        for i in range(100):
            _patient(db, pid, f"VD-{i:03d}", [POS if i % 10 == 7 else NEG])
    lead = clients(LEAD_ID)
    ratios = {"train": 0.6, "val": 0.2, "test": 0.2}
    ds = _create(lead, pid, "defect", {"partition": "random", "seed": 0, "ratios": ratios})
    for seed in (0, 1, 2, 3, 99):
        r = lead.post(f"/api/v1/datasets/{ds['id']}/splits", json={"partition": "random", "seed": seed, "ratios": ratios})
        assert r.status_code == 200, r.text
        per = r.json()["diagnostics"]["per_split_class"]
        assert {s: per[s][POS]["patients"] for s in SPLITS} == {"train": 6, "val": 2, "test": 2}, seed
        assert {s: per[s][NEG]["patients"] for s in SPLITS} == {"train": 54, "val": 18, "test": 18}, seed
    check = lead.get(f"/api/v1/datasets/{ds['id']}/freeze-check").json()
    assert check["blockers"] == [] and check["class_absent"] == [] and check["requires_acknowledgement"] is False
    r = _freeze(lead, ds["id"], ack=False)
    assert r.status_code == 200, r.text
    m = _manifest(lead, ds["id"])
    _assert_one_split_per_patient(m["items"])
    recount = Counter((it["split"], it["label_value"]) for it in m["items"])
    assert {s: recount[(s, POS)] for s in SPLITS} == {"train": 6, "val": 2, "test": 2}
    assert m["split_fingerprint"] == split_fingerprint(_split_by_code(m).items())
    assert m["audit"]["patient_independence"]["ok"] is True

    with session_scope() as db:
        dv = db.get(DatasetVersion, ds["id"])
        fam = lineage_family(db, dv.lineage_id)
        infos = _patient_infos(db, dv)
        fresh = {p["id"]: hashlib.sha256(f"other-uuid|{p['id']}".encode()).hexdigest()[:32] for p in infos}
        mapping, _ = allocate([{**p, "id": fresh[p["id"]]} for p in reversed(infos)], dv.config_json["split"],
                              salt=fam.salt, classes=[POS, NEG])
        assert {p["code"]: mapping[fresh[p["id"]]] for p in infos} == _split_by_code(m)
    other = _create(lead, pid, "same config, new lineage", {"partition": "random", "seed": 99, "ratios": ratios})
    assert other["lineage_id"] != ds["lineage_id"]
    assert _draft_splits(other["id"]) == _split_by_code(m)


def test_e2e_family_inheritance_survives_label_flips_removals_readmission_and_additions(clients):
    """v1 → v2 (labels flipped in every split, one patient excluded, six new patients) → v3 (the excluded patient is
    eligible again, three more new patients, a re-assignment with the same configuration). No patient ever leaves
    the split the family first gave them, the re-admitted patient included, and the manifest counts say so."""
    from dermpath.db import session_scope
    from dermpath.models import Slide, SplitFamilyAssignment
    from dermpath.review import set_review_state

    pid = "proj-verify-family"
    pts = {}
    with session_scope() as db:
        _new_project(db, pid)
        for i in range(40):
            labels = [POS if i % 5 == 0 else NEG] + ([NEG] if i % 7 == 0 else [])
            pts[f"VF-{i:03d}"] = _patient(db, pid, f"VF-{i:03d}", labels, scanners=("scanner-a", "scanner-b"))
    lead, path = clients(LEAD_ID), clients(PATHOLOGIST_ID)
    v1 = _create(lead, pid, "family v1", {"partition": "random", "seed": 4})
    assert _freeze(lead, v1["id"]).status_code == 200
    s1 = _split_by_code(_manifest(lead, v1["id"]))

    # Flip one positive and one negative patient in each split; exclude one patient; add six patients.
    flipped = []
    for sp in SPLITS:
        for want in (POS, NEG):
            code = next(c for c in sorted(s1) if s1[c] == sp and c not in flipped
                        and (c[-3:] and int(c[-3:]) % 5 == 0) == (want == POS))
            new = NEG if want == POS else POS
            r = path.post(f"/api/v1/slides/{pts[code]['slides'][0]}/labels",
                          json={"value": new, "reason": "re-read (fictional)"})
            assert r.status_code == 201, r.text
            flipped.append(code)
    excluded = next(c for c in sorted(s1) if s1[c] == "test" and c not in flipped)
    with session_scope() as db:
        for sid in pts[excluded]["slides"]:
            set_review_state(db, None, db.get(Slide, sid), "excluded", reason="tear (fictional)", system=True)
        for i in range(6):
            pts[f"VN-{i:02d}"] = _patient(db, pid, f"VN-{i:02d}", [POS if i % 2 == 0 else NEG])
    r = lead.post(f"/api/v1/datasets/{v1['id']}/new-version", json={"reason": "labels corrected; new patients"})
    assert r.status_code == 201, r.text
    v2 = r.json()
    assert _freeze(lead, v2["id"]).status_code == 200
    m2 = _manifest(lead, v2["id"])
    s2 = _split_by_code(m2)
    assert excluded not in s2
    assert {c: s2[c] for c in s2 if c in s1} == {c: s1[c] for c in s2 if c in s1}
    assert m2["split_family_counts"] == {"inherited": 39, "new": 6, "dropped": 1}

    # The excluded patient comes back; three more new patients arrive.
    with session_scope() as db:
        for sid in pts[excluded]["slides"]:
            set_review_state(db, None, db.get(Slide, sid), "approved", reason=None, system=True)
        for i in range(6, 9):
            _patient(db, pid, f"VN-{i:02d}", [POS])
    r = lead.post(f"/api/v1/datasets/{v2['id']}/new-version", json={"reason": "patient re-admitted"})
    assert r.status_code == 201, r.text
    v3 = r.json()
    same = {k: v for k, v in v3["config"]["split"].items() if k != "algorithm"}
    assert lead.post(f"/api/v1/datasets/{v3['id']}/splits", json=same).status_code == 200
    assert _freeze(lead, v3["id"]).status_code == 200
    m3 = _manifest(lead, v3["id"])
    s3 = _split_by_code(m3)
    assert s3[excluded] == s1[excluded], "a re-admitted patient must get their family split back"
    assert all(s3[c] == s2[c] for c in s2) and all(s3[c] == s1[c] for c in s1)
    assert m3["split_family_counts"] == {"inherited": 46, "new": 3, "dropped": 0}
    with session_scope() as db:
        rows = db.query(SplitFamilyAssignment).filter_by(family_id=m3["split_family_id"]).all()
        assert len(rows) == 49 and len({r.coded_patient_id for r in rows}) == 49
        assert {r.patient_code: r.split for r in rows} == s3


def test_e2e_sibling_drafts_cannot_freeze_a_split_that_contradicts_the_family(clients):
    """Two child drafts of one frozen version, both with new patients A. v2a freezes (A enters the family); then
    patients X arrive, so v2b is stale. After its refresh, v2b re-plans with A present AND X new: without the family,
    A would be re-allocated among A + X. Every patient of A must end with the split v2a gave them, and the family
    table must hold exactly one row per patient that matches both manifests."""
    from dermpath.db import session_scope
    from dermpath.models import SplitFamilyAssignment

    pid = "proj-verify-siblings"
    with session_scope() as db:
        _new_project(db, pid)
        for i in range(30):
            _patient(db, pid, f"VS-{i:03d}", [POS if i % 4 == 0 else NEG])
    lead = clients(LEAD_ID)
    v1 = _create(lead, pid, "siblings v1", {"partition": "random", "seed": 2})
    assert _freeze(lead, v1["id"]).status_code == 200
    with session_scope() as db:
        for i in range(7):
            _patient(db, pid, f"VA-{i:02d}", [POS if i < 3 else NEG])
    v2a = lead.post(f"/api/v1/datasets/{v1['id']}/new-version", json={"reason": "A"}).json()
    v2b = lead.post(f"/api/v1/datasets/{v1['id']}/new-version", json={"reason": "A, sibling"}).json()
    assert _draft_splits(v2a["id"]) == _draft_splits(v2b["id"])
    assert _freeze(lead, v2a["id"]).status_code == 200
    sa = _split_by_code(_manifest(lead, v2a["id"]))
    with session_scope() as db:
        for i in range(11):
            _patient(db, pid, f"VX-{i:02d}", [POS if i % 2 else NEG])
    r = _freeze(lead, v2b["id"])
    assert r.status_code == 409 and r.json()["error"]["code"] == "draft_stale", r.text
    assert lead.post(f"/api/v1/datasets/{v2b['id']}/refresh").status_code == 200
    r = _freeze(lead, v2b["id"])
    assert r.status_code == 200, r.text
    mb = _manifest(lead, v2b["id"])
    sb = _split_by_code(mb)
    assert {c: sb[c] for c in sa} == sa
    assert mb["split_family_counts"] == {"inherited": 37, "new": 11, "dropped": 0}
    with session_scope() as db:
        rows = db.query(SplitFamilyAssignment).filter_by(family_id=mb["split_family_id"]).all()
        assert {r.patient_code: r.split for r in rows} == sb and len(rows) == len(sb) == 48


def test_e2e_new_lineage_after_a_test_release_keeps_both_classes_in_val(clients):
    """Sealing plus a new lineage (design §2): 5 positive / 30 negative patients frozen at 40/20/40 (2 positives in
    test), test patients sealed by a test release, then a new lineage at 80/10/10 for a separate study. Sealed
    patients stay test (they do), and val must still get a positive patient: 3 free positives and targets
    {train 3, val 1, test 1} make (train 2, val 1) feasible. The family allocator fills train first and leaves val
    without positives, which then needs an acknowledgement to freeze."""
    from dermpath.datasets import seal_test_patients
    from dermpath.db import session_scope
    from dermpath.models import DatasetVersion

    pid = "proj-verify-seal"
    with session_scope() as db:
        _new_project(db, pid)
        for i in range(35):
            _patient(db, pid, f"VL-{i:03d}", [POS if i < 5 else NEG])
    lead = clients(LEAD_ID)
    v1 = _create(lead, pid, "sealed v1", {"partition": "random", "seed": 0,
                                         "ratios": {"train": 0.4, "val": 0.2, "test": 0.4}})
    assert _freeze(lead, v1["id"]).status_code == 200
    m1 = _manifest(lead, v1["id"])
    pos_test = sorted(it["patient_code"] for it in m1["items"] if it["label_value"] == POS and it["split"] == "test")
    assert len(pos_test) == 2
    with session_scope() as db:
        seal_test_patients(db, db.get(DatasetVersion, v1["id"]), "test release #1 (fictional)", actor=_actor("lead"))
    r = lead.post(f"/api/v1/datasets/{v1['id']}/new-version",
                  json={"reason": "separate study (fictional)", "new_lineage": True,
                        "split": {"partition": "random", "seed": 3, "ratios": {"train": 0.8, "val": 0.1, "test": 0.1}}})
    assert r.status_code == 201, r.text
    nl = r.json()
    splits = _draft_splits(nl["id"])
    assert all(splits[c] == "test" for c in pos_test)  # sealed patients never move
    per = nl["config"]["split_diagnostics"]["per_split_class"]
    assert per["val"][POS]["patients"] >= 1, {s: per[s][POS]["patients"] for s in SPLITS}


def test_e2e_freeze_detects_stale_drafts(clients):
    """freeze() re-materialises and refuses 409 draft_stale when, after the draft was materialised: a whole case was
    reassigned to another patient; a slide's provenance or image kind changed; a patient gained a later case
    (temporal) or a case at a test site (external_site) without any included item changing; a near-duplicate pair
    across splits was confirmed as duplicate; or a test release sealed patients a new-lineage draft had moved. After
    a refresh the draft freezes and honours the change."""
    from dermpath.datasets import seal_test_patients
    from dermpath.db import session_scope
    from dermpath.models import Case, DatasetVersion, Slide

    pid = "proj-verify-stale"
    pts = {}
    with session_scope() as db:
        _new_project(db, pid)
        for i in range(24):
            pts[f"VT-{i:03d}"] = _patient(db, pid, f"VT-{i:03d}", [POS if i % 4 == 0 else NEG],
                                          site=("site-a", "site-b")[i % 2],
                                          collected=date(2026, 1, 1) + timedelta(days=7 * i))
    lead, path = clients(LEAD_ID), clients(PATHOLOGIST_ID)

    def refused(dsid, *codes):
        r = _freeze(lead, dsid)
        assert r.status_code == 409 and r.json()["error"]["code"] in codes, r.text
        blockers = [b["code"] for b in lead.get(f"/api/v1/datasets/{dsid}/freeze-check").json()["blockers"]]
        assert set(blockers) & set(codes), blockers
        return r.json()["error"]["details"]

    # (a) A whole case moves to another patient (no slide moves).
    d = _create(lead, pid, "case moved", {"partition": "random", "seed": 1})
    with session_scope() as db:
        db.get(Case, pts["VT-003"]["case_id"]).coded_patient_id = pts["VT-005"]["id"]
    diff = refused(d["id"], "draft_stale")["diff"]
    fields = {c["slide_id"]: c["fields"] for c in diff["items_changed"]}[pts["VT-003"]["slides"][0]]
    assert fields["patient_code"] == ["VT-003", "VT-005"] and "coded_patient_id" in fields
    assert lead.post(f"/api/v1/datasets/{d['id']}/refresh").status_code == 200
    assert _freeze(lead, d["id"]).status_code == 200
    _assert_one_split_per_patient(_manifest(lead, d["id"])["items"])

    # (b) Provenance and image kind change on one slide.
    d = _create(lead, pid, "provenance", {"partition": "random", "seed": 1})
    sid = pts["VT-010"]["slides"][0]
    with session_scope() as db:
        db.get(Slide, sid).provenance = "public_licensed"
    fields = {c["slide_id"]: c["fields"] for c in refused(d["id"], "draft_stale")["diff"]["items_changed"]}[sid]
    assert fields == {"provenance": ["real_authorized", "public_licensed"]}
    assert lead.post(f"/api/v1/datasets/{d['id']}/refresh").status_code == 200
    with session_scope() as db:
        db.get(Slide, sid).image_kind = "synthetic_tiles"
    fields = {c["slide_id"]: c["fields"] for c in refused(d["id"], "draft_stale")["diff"]["items_changed"]}[sid]
    assert fields == {"image_kind": ["wsi", "synthetic_tiles"]}
    assert lead.post(f"/api/v1/datasets/{d['id']}/refresh").status_code == 200
    assert refused(d["id"], "mixed_data_mode")["item_counts"] == {"inconsistent": 1, "real": 23}
    with session_scope() as db:
        s = db.get(Slide, sid)
        s.image_kind, s.provenance = "wsi", "real_authorized"

    # (c) Temporal: a later case (no slides) moves a train patient past the test cutoff.
    d = _create(lead, pid, "temporal", {"partition": "temporal", "test_cutoff": "2026-05-01",
                                        "val_cutoff": "2026-04-01"})
    before = _draft_splits(d["id"])
    assert before["VT-002"] == "train"
    with session_scope() as db:
        db.add(Case(project_id=pid, coded_patient_id=pts["VT-002"]["id"], accession_code="A-VT-002-late",
                    collected_on=date(2026, 5, 1), site_id="site-a", provenance="real_authorized"))
    diff = refused(d["id"], "draft_stale")["diff"]
    assert diff["counts"]["items_changed"] == 0
    assert {"patient_code": "VT-002", "draft": "train", "now": "test"} in diff["splits_changed"]
    assert lead.post(f"/api/v1/datasets/{d['id']}/refresh").status_code == 200
    assert _draft_splits(d["id"])["VT-002"] == "test"

    # (d) External site: a case at the test site appears for a site-a patient.
    d = _create(lead, pid, "external", {"partition": "external_site", "test_sites": ["site-b"], "seed": 0})
    assert _draft_splits(d["id"])["VT-004"] != "test"
    with session_scope() as db:
        db.add(Case(project_id=pid, coded_patient_id=pts["VT-004"]["id"], accession_code="A-VT-004-b",
                    collected_on=date(2026, 2, 2), site_id="site-b", provenance="real_authorized"))
    diff = refused(d["id"], "draft_stale")["diff"]
    assert any(c["patient_code"] == "VT-004" and c["now"] == "test" for c in diff["splits_changed"])

    # (e) A duplicate decision joins two patients that sit in different splits.
    d = _create(lead, pid, "duplicates", {"partition": "random", "seed": 5})
    sp = _draft_splits(d["id"])
    a = next(c for c in sorted(sp) if sp[c] == "train" and c != "VT-003")
    b = next(c for c in sorted(sp) if sp[c] == "test" and c != "VT-003")
    r = lead.post(f"/api/v1/projects/{pid}/near-duplicates/review",
                  json={"slide_a_id": pts[a]["slides"][0], "slide_b_id": pts[b]["slides"][0],
                        "decision": "duplicate", "reason": "same section (fictional)"})
    assert r.status_code == 201, r.text
    diff = refused(d["id"], "draft_stale")["diff"]
    assert diff["counts"]["patients_changing_split"] >= 1
    assert lead.post(f"/api/v1/datasets/{d['id']}/refresh").status_code == 200
    sp = _draft_splits(d["id"])
    assert sp[a] == sp[b]
    assert lead.get(f"/api/v1/datasets/{d['id']}/freeze-check").json()["duplicates_across_splits"] == []
    assert _freeze(lead, d["id"]).status_code == 200

    # (f) A new-lineage draft planned before a test release on its parent.
    nl = lead.post(f"/api/v1/datasets/{d['id']}/new-version",
                   json={"reason": "other study", "new_lineage": True, "split": {"partition": "random", "seed": 77}})
    assert nl.status_code == 201, nl.text
    nl = nl.json()
    parent_test = {c for c, s in _split_by_code(_manifest(lead, d["id"])).items() if s == "test"}
    moved = {c for c, s in _draft_splits(nl["id"]).items() if c in parent_test and s != "test"}
    with session_scope() as db:
        seal_test_patients(db, db.get(DatasetVersion, d["id"]), "test release (fictional)", actor=_actor("lead"))
    if moved:
        refused(nl["id"], "draft_stale", "sealed_patient_moved")
        assert lead.post(f"/api/v1/datasets/{nl['id']}/refresh").status_code == 200
    after = _draft_splits(nl["id"])
    assert all(after[c] == "test" for c in parent_test)
    assert _freeze(lead, nl["id"]).status_code == 200


def test_e2e_temporal_edges_through_the_api(clients):
    """Cutoff equality goes to the later split; the latest date of ALL of a patient's cases decides (a non-included
    later case included); an included case without a date is refused (422 missing_collected_on); a cohort entirely
    before the val cutoff freezes only with an acknowledgement that records the empty, single-class splits."""
    from dermpath.db import session_scope
    from dermpath.models import Case

    pid = "proj-verify-temporal"
    tc, vc = date(2026, 6, 1), date(2026, 3, 1)
    with session_scope() as db:
        _new_project(db, pid)
        _patient(db, pid, "TE-TEST-EQ", [POS], collected=tc)
        _patient(db, pid, "TE-VAL-EQ", [NEG], collected=vc)
        _patient(db, pid, "TE-DAY-BEFORE", [POS], collected=vc - timedelta(days=1))
        _patient(db, pid, "TE-LATE-OTHER", [NEG], collected=date(2026, 1, 10), extra_cases=(("site-a", tc),))
        for i in range(12):
            _patient(db, pid, f"TE-{i:02d}", [POS if i % 3 == 0 else NEG], collected=date(2025, 6, 1) + timedelta(days=30 * i))
    lead = clients(LEAD_ID)
    cfg = {"partition": "temporal", "test_cutoff": tc.isoformat(), "val_cutoff": vc.isoformat()}
    d = _create(lead, pid, "temporal", cfg)
    sp = _draft_splits(d["id"])
    assert (sp["TE-TEST-EQ"], sp["TE-VAL-EQ"], sp["TE-DAY-BEFORE"], sp["TE-LATE-OTHER"]) == ("test", "val", "train", "test")
    diag = lead.get(f"/api/v1/datasets/{d['id']}").json()["config"]["split_diagnostics"]
    assert "seed" not in diag and diag["date_range_per_split"]["test"] == {"earliest": "2026-01-10",
                                                                           "latest": tc.isoformat()}
    assert diag["patients_spanning_a_cutoff"] >= 1  # TE-LATE-OTHER has material from before the test cutoff
    # All before the val cutoff.
    r = lead.post(f"/api/v1/datasets/{d['id']}/splits", json={"partition": "temporal", "test_cutoff": "2031-01-01",
                                                             "val_cutoff": "2030-01-01"})
    assert r.status_code == 200 and r.json()["diagnostics"]["empty_splits"] == ["val", "test"]
    check = lead.get(f"/api/v1/datasets/{d['id']}/freeze-check").json()
    assert check["requires_acknowledgement"] is True
    assert {(a["split"], a["class"]) for a in check["class_absent"]} == {(s, c) for s in ("val", "test") for c in (POS, NEG)}
    r = _freeze(lead, d["id"], ack=False)
    assert r.status_code == 409 and r.json()["error"]["code"] == "freeze_warnings_unacknowledged"
    assert _freeze(lead, d["id"]).status_code == 200
    assert _manifest(lead, d["id"])["acknowledged_warnings"]["class_absent"]
    # An included case without a date.
    with session_scope() as db:
        _patient(db, pid, "TE-NODATE", [NEG], collected=None)
    r = lead.post(f"/api/v1/projects/{pid}/datasets", json={"name": "t2", "config": _config(cfg)})
    assert r.status_code == 422 and r.json()["error"]["code"] == "missing_collected_on", r.text
    with session_scope() as db:
        case = db.query(Case).filter_by(project_id=pid, accession_code="A-TE-NODATE").one()
        case.collected_on = date(2026, 2, 1)
    assert _draft_splits(_create(lead, pid, "t3", cfg)["id"])["TE-NODATE"] == "train"


def test_e2e_external_site_edges_through_the_api(clients):
    """Test sites are validated against this project's case sites (case and other projects' sites do not count);
    a patient with ANY case at a test site (an extra case without slides included) is test; patients without a site
    are never test and are reported; a cohort entirely at the test site leaves train and val empty, reported and
    acknowledged rather than refused."""
    from dermpath.db import session_scope

    pid = "proj-verify-site"
    with session_scope() as db:
        _new_project(db, pid)
        for i in range(30):
            _patient(db, pid, f"XS-{i:03d}", [POS if i % 3 == 0 else NEG], site=("site-a", "site-b", "site-c")[i % 3])
        _patient(db, pid, "XS-EXTRA", [POS], site="site-a", extra_cases=(("site-c", date(2026, 3, 3)),))
        for i in range(3):
            _patient(db, pid, f"XS-NOSITE-{i}", [NEG], site=None)
        _new_project(db, "proj-verify-site-other")
        _patient(db, "proj-verify-site-other", "XO-1", [POS], site="site-elsewhere")
    lead = clients(LEAD_ID)
    d = _create(lead, pid, "sites")
    for bad in (["SITE-C"], ["site-elsewhere"], ["site-c", "nowhere"]):
        r = lead.post(f"/api/v1/datasets/{d['id']}/splits", json={"partition": "external_site", "test_sites": bad})
        assert r.status_code == 422 and r.json()["error"]["code"] == "unknown_site", (bad, r.text)
    r = lead.post(f"/api/v1/datasets/{d['id']}/splits", json={"partition": "external_site", "test_sites": ["site-c"]})
    assert r.status_code == 200, r.text
    diag = r.json()["diagnostics"]
    sp = _draft_splits(d["id"])
    assert sp["XS-EXTRA"] == "test"
    assert all(sp[f"XS-NOSITE-{i}"] != "test" for i in range(3))
    assert diag["patients_with_unknown_site"]["count"] == 3
    assert {c for c, s in sp.items() if s == "test"} == {f"XS-{i:03d}" for i in range(2, 30, 3)} | {"XS-EXTRA"}
    for cls in (POS, NEG):
        got = {s: diag["per_split_class"][s][cls]["patients"] for s in ("train", "val")}
        assert got == diag["remainder_targets"][cls], (cls, got)
    # Everyone at the test site, in a separate project.
    one = "proj-verify-site-one"
    with session_scope() as db:
        _new_project(db, one)
        for i in range(8):
            _patient(db, one, f"XA-{i}", [POS if i % 2 else NEG], site="site-only")
    d1 = _create(lead, one, "one site", {"partition": "external_site", "test_sites": ["site-only"]})
    diag1 = d1["config"]["split_diagnostics"]
    assert diag1["empty_splits"] == ["train", "val"] and diag1["achieved_test_fraction"] == 1.0
    check = lead.get(f"/api/v1/datasets/{d1['id']}/freeze-check").json()
    assert check["requires_acknowledgement"] is True and check["blockers"] == []
    assert _freeze(lead, d1["id"], ack=False).status_code == 409


def test_e2e_data_mode_is_one_mode_or_refused(clients):
    """Included items must resolve to one data mode: demo_synthetic on a scanned file, or a real provenance on
    procedural tiles, is 'inconsistent' and refused like a synthetic/real mix (409 mixed_data_mode, also a
    freeze-check blocker), and reported at materialise; a consistent real cohort freezes with data_mode real."""
    from dermpath.db import session_scope

    pid = "proj-verify-mode"
    with session_scope() as db:
        _new_project(db, pid)
        for i in range(8):
            _patient(db, pid, f"XM-{i}", [POS if i % 2 else NEG])
        _patient(db, pid, "XM-SYN-ON-WSI", [NEG], provenance="demo_synthetic", image_kind="wsi")
        _patient(db, pid, "XM-REAL-TILES", [POS], provenance="real_authorized", image_kind="synthetic_tiles")
        _patient(db, pid, "XM-SYN", [NEG], provenance="demo_synthetic", image_kind="synthetic_tiles", mpp=None)
    lead = clients(LEAD_ID)
    for include, counts in ((None, {"inconsistent": 2, "real": 8, "synthetic": 1}),
                            (["real_authorized"], {"inconsistent": 1, "real": 8}),
                            (["demo_synthetic"], {"inconsistent": 1, "synthetic": 1})):
        extra = {"include_provenance": include} if include else {}
        d = _create(lead, pid, f"mode {include}", {"partition": "random", "seed": 0}, **extra)
        refreshed = lead.post(f"/api/v1/datasets/{d['id']}/refresh").json()["refresh"]["data_mode"]
        assert refreshed["mode"] == "mixed" and refreshed["item_counts"] == counts, (include, refreshed)
        check = lead.get(f"/api/v1/datasets/{d['id']}/freeze-check").json()
        assert check["data_mode"] == "mixed" and "mixed_data_mode" in [b["code"] for b in check["blockers"]]
        r = _freeze(lead, d["id"])
        assert r.status_code == 409 and r.json()["error"]["code"] == "mixed_data_mode", (include, r.text)
    with session_scope() as db:
        from dermpath.models import Slide

        for s in db.query(Slide).filter(Slide.project_id == pid, Slide.object_key.like("%XM-REAL-TILES%")).all():
            s.image_kind = "wsi"
    d = _create(lead, pid, "real only", {"partition": "random", "seed": 0}, include_provenance=["real_authorized"])
    assert _freeze(lead, d["id"]).status_code == 200
    m = _manifest(lead, d["id"])
    assert m["data_mode"] == "real" and m["synthetic_only"] is False and m["data_mode_item_counts"] == {"real": 9}


def test_e2e_audit_block_is_finite_and_reports_patient_independence(clients):
    """The audit frozen into the manifest: JSON without NaN; every association has V and p in [0, 1] or None with a
    reason; label × site is computed on patients (a patient with slides on two scanners is 'multiple'); patient
    independence is zero everywhere and ok; class balance equals the split diagnostics. After freeze, a slide moved
    to a patient in another split shows up in the LIVE audit while the frozen one is unchanged."""
    from dermpath.db import session_scope
    from dermpath.models import Slide

    pid = "proj-verify-audit"
    pts = {}
    with session_scope() as db:
        _new_project(db, pid)
        for i in range(36):
            pos = i % 3 == 0
            site = "site-a" if (pos and i % 9 != 0) or (not pos and i % 5 == 0) else ("site-b", "site-c")[i % 2]
            scanners = ("scanner-a", "scanner-b") if i % 4 == 0 else (("scanner-a",) if i % 2 else ("scanner-c",))
            pts[f"AU-{i:03d}"] = _patient(db, pid, f"AU-{i:03d}", [POS if pos else NEG] * (1 + (i % 4 == 0)),
                                          site=site, scanners=scanners)
    lead = clients(LEAD_ID)
    d = _create(lead, pid, "audit", {"partition": "random", "seed": 8})
    assert _freeze(lead, d["id"]).status_code == 200
    m = _manifest(lead, d["id"])
    a = m["audit"]
    json.dumps(a, allow_nan=False)
    pi = a["patient_independence"]
    assert pi["ok"] is True and pi["patients_in_more_than_one_split"] == []
    assert pi["live_lineage"]["moved_count"] == 0 and pi["live_lineage"]["patients_spanning_splits_now"] == []
    assert pi["near_duplicate_clusters_across_splits"] == []
    for key in ("label_by_site", "label_by_scanner", "label_by_stain", "split_by_site"):
        c = a["confounding"][key]
        assert c["unit"] == "patients"
        if c["cramers_v"] is None:
            assert c["undefined_reason"], key
        else:
            assert 0 <= c["cramers_v"] <= 1 and 0 <= c["p_value"] <= 1 and math.isfinite(c["min_expected"]), key
    assert a["confounding"]["label_by_stain"]["cramers_v"] is None  # one stain only
    site_truth = Counter((POS if i % 3 == 0 else NEG,
                          "site-a" if (i % 3 == 0 and i % 9 != 0) or (i % 3 and i % 5 == 0) else ("site-b", "site-c")[i % 2])
                         for i in range(36))
    assert a["confounding"]["label_by_site"]["table"] == {
        lbl: {s: n for (l2, s), n in sorted(site_truth.items()) if l2 == lbl} for lbl in sorted({k[0] for k in site_truth})}
    assert a["confounding"]["label_by_scanner"]["table"][POS].get("multiple", 0) == sum(
        1 for i in range(0, 36, 3) if i % 4 == 0)
    assert a["class_balance"] == m["split_diagnostics"]["per_split_class"]
    assert a["confounding"]["label_by_site"]["p_value"] < 0.05  # the planted label × site confounding is visible
    # Move one slide to a patient in another split after the freeze.
    sp = _split_by_code(m)
    src = next(c for c in sorted(sp) if sp[c] == "train")
    dst = next(c for c in sorted(sp) if sp[c] == "test")
    with session_scope() as db:
        db.get(Slide, pts[src]["slides"][0]).block_id = db.get(Slide, pts[dst]["slides"][0]).block_id
    live = lead.get(f"/api/v1/datasets/{d['id']}/audit").json()
    assert live["patient_independence"]["ok"] is False
    assert dst in live["patient_independence"]["live_lineage"]["patients_spanning_splits_now"]
    assert live["at_freeze"]["patient_independence"]["ok"] is True


# =========================================================================== rule exceptions must be reported


def test_external_site_inherited_patient_at_a_test_site_is_reported():
    """External site: 'a patient with ANY case at a test site is entirely test'. A child version keeps an inherited
    train patient in train after they gain a case at the test site (inheritance wins, by design), but, unlike the
    temporal partition's ``inherited_against_rule``, nothing names that patient: train now silently holds test-site
    material. The diagnostics must list inherited patients that disagree with the site rule."""
    from dermpath.splits import allocate

    pts = [{"id": f"p{i}", "code": f"P{i}", "label": NEG if i % 3 else POS, "sites": {"site-a"}} for i in range(12)]
    pts.append({"id": "inh", "code": "INH", "label": POS, "sites": {"site-a", "site-t"}})
    mapping, diag = allocate(pts, {"partition": "external_site", "test_sites": ["site-t"]}, existing={"inh": "train"})
    assert mapping["inh"] == "train"  # inherited patients never move
    assert diag.get("inherited_against_rule") == ["INH"], {k: diag.get(k) for k in (
        "rule", "patients_with_cases_at_test_and_other_sites", "inherited_against_rule")}


def test_temporal_unit_member_placed_against_the_date_rule_is_reported():
    """Temporal: later material never trains, and inherited exceptions are listed in ``inherited_against_rule``. A
    NEW patient whose latest case is after the test cutoff, joined by a confirmed duplicate pair to an inherited
    train patient, is put in train with the unit, and no diagnostic names them (not in inherited_against_rule,
    patients_spanning_a_cutoff = 0)."""
    from dermpath.splits import allocate

    pts = [{"id": "e", "code": "E", "label": NEG, "dates": [date(2025, 1, 1)]},
           {"id": "n", "code": "N", "label": POS, "dates": [date(2026, 9, 1)]}]
    pts += [{"id": f"q{i}", "code": f"Q{i}", "label": NEG, "dates": [date(2025, 2, i + 1)]} for i in range(5)]
    mapping, diag = allocate(pts, {"partition": "temporal", "test_cutoff": "2026-06-01"}, existing={"e": "train"},
                             groups=[("e", "n")])
    assert mapping["e"] == mapping["n"] == "train"  # inheritance and grouping both honoured
    reported = set(diag["inherited_against_rule"]) | set(diag.get("against_rule", []))
    assert "N" in reported, {k: diag[k] for k in ("inherited_against_rule", "patients_spanning_a_cutoff", "grouping")}


def test_e2e_manifest_split_diagnostics_are_current_at_freeze(clients):
    """freeze() re-plans the allocation and refuses a stale mapping, but the manifest's ``split_diagnostics`` come
    from the last materialise. A later case for a patient who is already test (temporal) changes the diagnostics
    (date_range_per_split) but not the mapping, so the draft freezes and the immutable manifest records an
    out-of-date date range while the audit next to it is fresh. (external_site's patients_with_unknown_site and
    per_site_patients_by_class go stale the same way.)"""
    from dermpath.datasets import _plan_splits
    from dermpath.db import session_scope
    from dermpath.models import Case, DatasetVersion

    pid = "proj-verify-diag"
    pts = {}
    with session_scope() as db:
        _new_project(db, pid)
        for i in range(12):
            pts[f"DG-{i:02d}"] = _patient(db, pid, f"DG-{i:02d}", [POS if i % 3 == 0 else NEG],
                                          collected=date(2026, 1, 1) + timedelta(days=20 * i),
                                          site="site-a" if i % 4 else None)
    lead = clients(LEAD_ID)
    d = _create(lead, pid, "temporal diag", {"partition": "temporal", "test_cutoff": "2026-05-01"})
    assert _draft_splits(d["id"])["DG-11"] == "test"
    with session_scope() as db:  # a later case for a patient who is already test: no split changes
        db.add(Case(project_id=pid, coded_patient_id=pts["DG-11"]["id"], accession_code="A-DG-11-later",
                    collected_on=date(2026, 12, 24), site_id="site-a", provenance="real_authorized"))
    assert _freeze(lead, d["id"]).status_code == 200
    m = _manifest(lead, d["id"])
    with session_scope() as db:
        _, _, fresh, _ = _plan_splits(db, db.get(DatasetVersion, d["id"]), m["config"]["split"])
    assert fresh["date_range_per_split"]["test"]["latest"] == "2026-12-24"
    assert m["split_diagnostics"]["date_range_per_split"] == fresh["date_range_per_split"], (
        m["split_diagnostics"]["date_range_per_split"]["test"], fresh["date_range_per_split"]["test"])
