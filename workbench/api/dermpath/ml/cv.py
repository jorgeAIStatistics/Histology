"""Deterministic patient-grouped stratified K-fold, inner hold-out and nested learning-curve
subsets over a DEVELOPMENT pool (design §6). Pure functions, no DB.

* **Content-stable ordering.** Every grouping unit is ordered by
  ``sha256(f"{salt}|{unit_key}")``, where ``unit_key`` joins the sorted patient keys supplied
  by the caller (patient codes, never uuids or row ids). Python's ``random`` module is never
  used, so assignments are identical across processes, Python versions and input orders.
  Callers derive ``salt`` from the split family and the seed, e.g.
  ``f"{family_salt}|cv|{seed}"``.
* **Grouping units.** Patients joined by near-duplicate pairs that a person marked
  ``duplicate`` form one unit (union-find); a unit is always allocated whole, so no patient,
  and no confirmed duplicate, spans folds.
* **Stratification.** Units are stratified by the declared ``patient_label_rule``
  (``any_positive``: positive if any bag is positive; ``majority``: ties break toward
  positive). The rule only stratifies; every bag keeps its own label. Mixed-label patients are
  listed in the diagnostics.
* **Rare classes** (:data:`RARE_CLASS_NOTE`): with fewer units of a class than folds, the
  assignment still succeeds, the folds without that class are listed in ``class_absent``, a
  :class:`RareClassWarning` is issued and recorded in ``diagnostics["warnings"]``. Fewer units
  than folds in total is refused.
"""

from __future__ import annotations

import hashlib
import math
import warnings
from collections import defaultdict
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field

import numpy as np

from .metrics import binary_labels, canonical_sha256

CV_SCHEMA = "dermpath.cv/1"
LEARNING_CURVE_SCHEMA = "dermpath.learning_curve/1"
PATIENT_LABEL_RULES = ("any_positive", "majority")
CLASS_NAMES = {0: "negative", 1: "positive"}
ORDERING = "sha256(salt|unit key); unit key = sorted patient keys of the unit joined by '+'"
RARE_CLASS_NOTE = ("When a class has fewer grouping units than folds, some folds hold out none of it: their per-fold "
                   "metrics that need that class are undefined, so evaluate the pooled out-of-fold predictions. When a "
                   "class has a single unit, the fold holding it trains without that class. The assignment still "
                   "succeeds; affected folds are listed in class_absent and train_class_absent.")


class RareClassWarning(UserWarning):
    """A class has fewer grouping units than folds (or than needed for a hold-out)."""


@dataclass(frozen=True)
class GroupingUnit:
    """Patients allocated together (one patient, or patients joined by confirmed duplicates)."""

    unit_key: str
    patients: tuple[str, ...]
    label: int
    n_bags: int


def _sha(salt: str, key: str) -> str:
    return hashlib.sha256(f"{salt}|{key}".encode()).hexdigest()


def _rule_label(bag_labels: Sequence[int], rule: str) -> int:
    pos = sum(bag_labels)
    if rule == "any_positive":
        return int(pos > 0)
    return int(pos >= len(bag_labels) - pos)  # majority; ties toward positive


class _UnionFind:
    def __init__(self, items: Iterable[str]):
        self.parent = {i: i for i in items}

    def find(self, a: str) -> str:
        while self.parent[a] != a:
            self.parent[a] = self.parent[self.parent[a]]
            a = self.parent[a]
        return a

    def union(self, a: str, b: str) -> None:
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            self.parent[max(ra, rb)] = min(ra, rb)


def build_units(labels, patients: Sequence[str], *, patient_keys: Mapping[str, str],
                duplicate_pairs: Iterable[tuple[str, str]] = (),
                patient_label_rule: str = "any_positive") -> tuple[list[GroupingUnit], dict]:
    """Grouping units over per-bag ``labels`` and ``patients``. ``patient_keys`` maps every
    patient id to a content-stable, unique key (the patient code). ``duplicate_pairs`` are
    patient-id pairs a person confirmed as duplicates; pairs naming an absent patient are
    ignored and listed."""
    if patient_label_rule not in PATIENT_LABEL_RULES:
        raise ValueError(f"unknown patient_label_rule {patient_label_rule!r}; use one of "
                         f"{', '.join(PATIENT_LABEL_RULES)}")
    y = binary_labels(labels)
    patients = list(patients)
    if len(patients) != y.size:
        raise ValueError(f"patients has {len(patients)} entries for {y.size} label(s)")
    bags: dict[str, list[int]] = defaultdict(list)
    for p, v in zip(patients, y.tolist()):
        bags[p].append(int(v))
    missing = sorted(str(p) for p in bags if p not in patient_keys)
    if missing:
        raise ValueError(f"patient_keys has no key for {len(missing)} patient(s), e.g. {missing[:3]}")
    keys = {p: str(patient_keys[p]) for p in bags}
    if len(set(keys.values())) != len(keys):
        raise ValueError("patient_keys must be unique per patient (ordering would be ambiguous)")
    uf = _UnionFind(bags)
    ignored = []
    for a, b in duplicate_pairs:
        if a in bags and b in bags:
            uf.union(a, b)
        else:
            ignored.append(sorted([str(a), str(b)]))
    members: dict[str, list[str]] = defaultdict(list)
    for p in bags:
        members[uf.find(p)].append(p)
    units = []
    for ms in members.values():
        ms = sorted(ms, key=lambda p: keys[p])
        all_bags = [v for p in ms for v in bags[p]]
        units.append(GroupingUnit(unit_key="+".join(keys[p] for p in ms), patients=tuple(ms),
                                  label=_rule_label(all_bags, patient_label_rule), n_bags=len(all_bags)))
    units.sort(key=lambda u: u.unit_key)
    diag = {
        "patient_label_rule": patient_label_rule,
        "n_patients": len(bags),
        "n_units": len(units),
        "n_bags": int(y.size),
        "mixed_label_patients": sorted((p for p, v in bags.items() if 0 < sum(v) < len(v)), key=lambda p: keys[p]),
        "duplicate_units": [list(u.patients) for u in units if len(u.patients) > 1],
        "duplicate_pairs_ignored": sorted(ignored),
    }
    return units, diag


def _class_counts(units: Iterable[GroupingUnit], bags: Mapping[str, list[int]], rule: str) -> dict:
    units = list(units)
    pats = [p for u in units for p in u.patients]
    pat_labels = [_rule_label(bags[p], rule) for p in pats]
    bag_labels = [v for p in pats for v in bags[p]]
    return {
        "units_by_class": {CLASS_NAMES[c]: sum(1 for u in units if u.label == c) for c in (1, 0)},
        "patients_by_class": {CLASS_NAMES[c]: sum(1 for v in pat_labels if v == c) for c in (1, 0)},
        "bags_by_class": {CLASS_NAMES[c]: sum(1 for v in bag_labels if v == c) for c in (1, 0)},
    }


def _bags_by_patient(labels, patients) -> dict[str, list[int]]:
    out: dict[str, list[int]] = defaultdict(list)
    for p, v in zip(list(patients), binary_labels(labels).tolist()):
        out[p].append(int(v))
    return out


@dataclass(frozen=True)
class CVFolds:
    """Fold assignment per patient (folds numbered from 0) plus diagnostics."""

    k: int
    fold_of: dict = field(default_factory=dict)  # patient id -> fold
    diagnostics: dict = field(default_factory=dict)

    def item_folds(self, patients: Sequence[str]) -> np.ndarray:
        unknown = sorted({str(p) for p in patients if p not in self.fold_of})
        if unknown:
            raise ValueError(f"{len(unknown)} patient(s) have no fold assignment, e.g. {unknown[:3]}")
        return np.asarray([self.fold_of[p] for p in patients], dtype=np.int64)

    def splits(self, patients: Sequence[str]) -> list[tuple[np.ndarray, np.ndarray]]:
        """``[(fit_indices, held_out_indices)]`` per fold over the items whose patients are given."""
        folds = self.item_folds(patients)
        return [(np.flatnonzero(folds != f), np.flatnonzero(folds == f)) for f in range(self.k)]

    def to_dict(self) -> dict:
        return {"k": self.k, "fold_of": dict(sorted(self.fold_of.items())), "diagnostics": self.diagnostics}


def _rare_warning(diag: dict, msg: str) -> None:
    diag["warnings"].append(msg)
    warnings.warn(msg, RareClassWarning, stacklevel=3)


def grouped_stratified_kfold(labels, patients: Sequence[str], *, k: int = 5, patient_keys: Mapping[str, str],
                             salt: str, duplicate_pairs: Iterable[tuple[str, str]] = (),
                             patient_label_rule: str = "any_positive") -> CVFolds:
    """Patient-grouped stratified K-fold over the development pool (train ∪ val).

    Within each class stratum (rarest first) units are taken largest first, then in
    content-hash order, and each goes to the fold with the fewest units' patients of that class,
    then the fewest patients, then the fewest bags, then the lowest index. Per-class patient
    counts therefore differ by at most the largest unit between folds."""
    k = int(k)
    if k < 2:
        raise ValueError("k must be at least 2")
    units, udiag = build_units(labels, patients, patient_keys=patient_keys, duplicate_pairs=duplicate_pairs,
                               patient_label_rule=patient_label_rule)
    if len(units) < k:
        raise ValueError(f"{k} folds need at least {k} grouping units; the development pool has {len(units)}")
    bags = _bags_by_patient(labels, patients)
    strata: dict[int, list[GroupingUnit]] = defaultdict(list)
    for u in units:
        strata[u.label].append(u)
    fold_class = [[0, 0] for _ in range(k)]
    fold_pat = [0] * k
    fold_bags = [0] * k
    fold_units: list[list[GroupingUnit]] = [[] for _ in range(k)]
    for c in sorted(strata, key=lambda c: (len(strata[c]), c)):
        for u in sorted(strata[c], key=lambda u: (-len(u.patients), _sha(salt, u.unit_key), u.unit_key)):
            f = min(range(k), key=lambda i: (fold_class[i][c], fold_pat[i], fold_bags[i], i))
            fold_units[f].append(u)
            fold_class[f][c] += len(u.patients)
            fold_pat[f] += len(u.patients)
            fold_bags[f] += u.n_bags
    fold_of = {p: f for f in range(k) for u in fold_units[f] for p in u.patients}
    key_of = {p: str(patient_keys[p]) for p in fold_of}

    diag = {"schema": CV_SCHEMA,
            "method": "patient-grouped stratified k-fold; greedy balanced allocation in content-hash order",
            "ordering": ORDERING, "k": k, "salt": salt, **udiag,
            "classes": _class_counts(units, bags, patient_label_rule),
            "folds": [], "class_absent": [], "train_class_absent": [], "warnings": [],
            "rare_class_behaviour": RARE_CLASS_NOTE}
    for f in range(k):
        held = _class_counts(fold_units[f], bags, patient_label_rule)
        fit = _class_counts((u for g in range(k) if g != f for u in fold_units[g]), bags, patient_label_rule)
        diag["folds"].append({"fold": f, "n_units": len(fold_units[f]), "n_patients": fold_pat[f],
                              "n_bags": fold_bags[f], **held,
                              "fit_patients_by_class": fit["patients_by_class"],
                              "fit_bags_by_class": fit["bags_by_class"]})
        for c in (1, 0):
            name = CLASS_NAMES[c]
            if diag["classes"]["bags_by_class"][name] == 0:
                continue
            if held["bags_by_class"][name] == 0:
                diag["class_absent"].append({"fold": f, "class": name, "part": "held_out"})
            if fit["bags_by_class"][name] == 0:
                diag["train_class_absent"].append({"fold": f, "class": name})
    for c in (1, 0):
        name, n_c = CLASS_NAMES[c], len(strata.get(c, []))
        if n_c == 0:
            _rare_warning(diag, f"no {name} grouping unit in the development pool: every fold lacks the {name} "
                                f"class (stratification is trivial)")
        elif n_c < k:
            msg = (f"{name} class has {n_c} grouping unit(s) for {k} folds: {k - n_c} fold(s) hold out no {name} "
                   f"unit, so their per-fold metrics that need it are undefined; evaluate the pooled out-of-fold "
                   f"predictions")
            if n_c == 1:
                msg += f"; the fold holding the only {name} unit trains without that class"
            _rare_warning(diag, msg)
    diag["fingerprint"] = canonical_sha256(sorted([key_of[p], f] for p, f in fold_of.items()))
    return CVFolds(k=k, fold_of=fold_of, diagnostics=diag)


def inner_holdout_split(labels, patients: Sequence[str], *, fraction: float = 0.2, patient_keys: Mapping[str, str],
                        salt: str, duplicate_pairs: Iterable[tuple[str, str]] = (),
                        patient_label_rule: str = "any_positive") -> dict:
    """Patient-grouped stratified hold-out INSIDE the training data (for ABMIL early stopping;
    design §6 ``inner_val_fraction``). Per class stratum the first ``round_half_up(fraction ×
    n_units)`` units in content-hash order are held out, at least one and at most all but one
    when the class has two or more units. A class with a single unit stays in the fitting part
    (warned)."""
    if not 0.0 < float(fraction) < 1.0:
        raise ValueError("fraction must lie strictly between 0 and 1")
    units, udiag = build_units(labels, patients, patient_keys=patient_keys, duplicate_pairs=duplicate_pairs,
                               patient_label_rule=patient_label_rule)
    bags = _bags_by_patient(labels, patients)
    diag = {"schema": CV_SCHEMA, "method": "patient-grouped stratified inner hold-out", "ordering": ORDERING,
            "fraction": float(fraction), "salt": salt, **udiag, "warnings": []}
    held: list[GroupingUnit] = []
    fit: list[GroupingUnit] = []
    for c in (1, 0):
        us = sorted((u for u in units if u.label == c), key=lambda u: (_sha(salt, u.unit_key), u.unit_key))
        if not us:
            continue
        if len(us) == 1:
            n_hold = 0
            _rare_warning(diag, f"{CLASS_NAMES[c]} class has a single grouping unit; it stays in the fitting part "
                                "and the inner hold-out lacks that class")
        else:
            n_hold = min(max(math.floor(float(fraction) * len(us) + 0.5), 1), len(us) - 1)
        held.extend(us[:n_hold])
        fit.extend(us[n_hold:])
    diag["held_out"] = _class_counts(held, bags, patient_label_rule)
    diag["fit"] = _class_counts(fit, bags, patient_label_rule)
    return {"fit_patients": sorted(p for u in fit for p in u.patients),
            "holdout_patients": sorted(p for u in held for p in u.patients), "diagnostics": diag}


def nested_learning_curve_subsets(labels, patients: Sequence[str], *, patient_keys: Mapping[str, str], salt: str,
                                  fractions: Sequence[float] = (0.1, 0.25, 0.5, 1.0), repeats: int = 3,
                                  duplicate_pairs: Iterable[tuple[str, str]] = (),
                                  patient_label_rule: str = "any_positive", min_units_per_class: int = 1) -> dict:
    """Nested, stratified, deterministic subsets of TRAINING patients for learning curves.

    For repeat ``r`` each class stratum is ordered by ``sha256(f"{salt}|repeat={r}|{unit_key}")``
    and a fraction ``f`` takes the first ``clamp(round_half_up(f × n_c), min_units_per_class,
    n_c)`` units of class ``c``. Per-class counts never decrease as ``f`` grows, so within a
    repeat every subset contains the smaller ones (nested); ``f = 1`` is the whole pool.
    Rounding is per class (no largest-remainder step, which can shrink a class when the total
    grows), so totals can differ slightly from ``f × n``; the achieved counts are reported.
    Evaluate every subset on validation or out-of-fold predictions, never on test."""
    fr = sorted({float(f) for f in fractions})
    if not fr or fr[0] <= 0.0 or fr[-1] > 1.0:
        raise ValueError("fractions must lie in (0, 1]")
    if int(repeats) < 1:
        raise ValueError("repeats must be at least 1")
    units, udiag = build_units(labels, patients, patient_keys=patient_keys, duplicate_pairs=duplicate_pairs,
                               patient_label_rule=patient_label_rule)
    bags = _bags_by_patient(labels, patients)
    key_of = {p: str(patient_keys[p]) for p in bags}
    by_class = {c: [u for u in units if u.label == c] for c in (1, 0)}
    subsets = []
    for r in range(int(repeats)):
        rsalt = f"{salt}|repeat={r}"
        orders = {c: sorted(us, key=lambda u: (_sha(rsalt, u.unit_key), u.unit_key)) for c, us in by_class.items()}
        for f in fr:
            chosen: list[GroupingUnit] = []
            for c in (1, 0):
                n_c = len(orders[c])
                n_take = min(max(math.floor(f * n_c + 0.5), min(int(min_units_per_class), n_c)), n_c)
                chosen.extend(orders[c][:n_take])
            pats = sorted(p for u in chosen for p in u.patients)
            counts = _class_counts(chosen, bags, patient_label_rule)
            subsets.append({"repeat": r, "fraction": f, "patients": pats, "n_patients": len(pats),
                            "n_units": len(chosen), "n_bags": sum(u.n_bags for u in chosen), **counts,
                            "class_absent": [CLASS_NAMES[c] for c in (1, 0)
                                             if by_class[c] and counts["units_by_class"][CLASS_NAMES[c]] == 0],
                            "fingerprint": canonical_sha256(sorted(key_of[p] for p in pats))})
    return {"schema": LEARNING_CURVE_SCHEMA,
            "method": "nested stratified patient subsets; per-class prefixes of a content-hash order",
            "ordering": ORDERING, "salt": salt, "fractions": fr, "repeats": int(repeats),
            "min_units_per_class": int(min_units_per_class), **udiag, "subsets": subsets,
            "note": "evaluate on validation or out-of-fold predictions, never on test; report patient counts and CIs"}
