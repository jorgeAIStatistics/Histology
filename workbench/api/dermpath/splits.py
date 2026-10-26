"""Patient-grouped, stratified, content-stable split allocation (design §2). Pure functions: no database.

Guarantees
----------
* **Content-stable ordering.** Patients are ordered by ``sha256(f"{salt}|{patient_code}")`` with
  ``salt = f"{family_salt}|{seed}"``. Never by database uuid and never by ``random.shuffle``, so the
  same cohort gives the same ``{patient_code: split}`` on any interpreter, whatever its ids are.
* **Patient label for stratification** (``patient_label_rule``): ``any_positive`` (default; positive if
  any bag is the positive class) or ``majority`` (ties break toward the positive class, then by
  sorted value). The rule only stratifies; every bag keeps its own label. Mixed-label patients are
  counted and listed in the diagnostics.
* **Stratified grouped allocation** (``random``, and the train/val remainder of ``external_site``):
  per stratum, targets come from largest-remainder rounding of ``ratio × n``. Every split with
  ``ratio > 0`` gets at least one patient of each class whenever the class has at least as many
  patients as there are such splits (one patient moves from the split with the largest surplus,
  preferring train). When that is impossible the allocation still succeeds and
  ``diag["class_absent"]`` lists ``{split, class}``.
* **Grouping constraints.** Patient pairs (e.g. near-duplicates a person marked ``duplicate``) are
  joined by union-find into units that are allocated whole.
* **Families.** ``existing`` maps patients to a split they already hold in the family; they keep it
  whatever their label is now. Only new patients are allocated, toward the per-stratum targets
  given the existing counts.
* ``temporal``: a patient goes by their LATEST case date; ``val_cutoff < test_cutoff``; unused
  ``seed``/``ratios`` are rejected. ``external_site``: a patient with ANY case at a test site is
  test; sites can be validated against the known ones; ``ratios.test`` is rejected.
"""

from __future__ import annotations

import hashlib
import json
import math
from collections import Counter, defaultdict
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from datetime import date

from .errors import unprocessable

ALGORITHM = "dermpath.splits/2"
SPLITS = ("train", "val", "test")
PARTITIONS = ("random", "temporal", "external_site")
PATIENT_LABEL_RULES = ("any_positive", "majority")
DEFAULT_PATIENT_LABEL_RULE = "any_positive"
DEFAULT_POSITIVE_CLASS = "bcc_present"
DEFAULT_RATIOS = {"train": 0.6, "val": 0.2, "test": 0.2}
DEFAULT_EXTERNAL_RATIOS = {"train": 0.75, "val": 0.25}
MAX_SEED = 2**31 - 1
_SPLIT_KEYS = frozenset({"partition", "seed", "ratios", "test_cutoff", "val_cutoff", "test_sites",
                         "patient_label_rule", "algorithm"})
_UNUSED = {
    "random": ("test_cutoff", "val_cutoff", "test_sites"),
    "temporal": ("seed", "ratios", "test_sites"),
    "external_site": ("test_cutoff", "val_cutoff"),
}
_DIAG_LIST_CAP = 200


# --------------------------------------------------------------------------- config


def _seed(value) -> int:
    if value is None:
        return 0
    if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= MAX_SEED:
        raise unprocessable("invalid_seed", f"seed must be an integer in [0, {MAX_SEED}]", seed=repr(value))
    return value


def _ratios(value, keys: tuple[str, ...], default: Mapping[str, float]) -> dict[str, float]:
    if value is None:
        return {k: float(default.get(k, 0.0)) for k in keys}
    if not isinstance(value, Mapping):
        raise unprocessable("invalid_ratios", "ratios must be an object of split → fraction")
    unknown = sorted(set(value) - set(keys))
    if unknown:
        raise unprocessable("invalid_ratios", f"ratios accepts only {list(keys)}", unknown=unknown)
    out: dict[str, float] = {}
    for k in keys:
        v = value.get(k, 0.0)
        if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(float(v)):
            raise unprocessable("invalid_ratios", "ratios must be finite numbers")
        out[k] = float(v)
    if any(v < 0 for v in out.values()) or abs(sum(out.values()) - 1.0) > 1e-6:
        raise unprocessable("invalid_ratios", "ratios must be non-negative and sum to 1", ratios=out)
    if out["train"] <= 0:
        raise unprocessable("invalid_ratios", "ratios.train must be greater than 0 (no training data otherwise)",
                            ratios=out)
    return out


def _cutoff(value, name: str) -> date:
    if isinstance(value, date):
        return value
    try:
        return date.fromisoformat(value)
    except (TypeError, ValueError) as exc:
        raise unprocessable("invalid_cutoff", f"{name} must be a date (YYYY-MM-DD)") from exc


def normalise_split(split: Mapping) -> dict:
    """Validate a split request and return its canonical form (idempotent).

    Rejected (422): unknown keys, a ``seed`` outside ``[0, 2^31-1]``, ratios that are negative, do not sum to 1,
    have unknown keys or ``train <= 0``; parameters a partition does not use (``unused_split_parameter``: e.g. a seed
    or ratios on ``temporal``); ``ratios.test`` on ``external_site`` (the test set is defined by the sites);
    ``val_cutoff >= test_cutoff``.
    """
    if not isinstance(split, Mapping):
        raise unprocessable("invalid_split", "split must be an object")
    unknown = sorted(set(split) - _SPLIT_KEYS)
    if unknown:
        raise unprocessable("invalid_split_parameter", f"unknown split parameter(s): {unknown}", unknown=unknown)
    partition = split.get("partition") or "random"
    if partition not in PARTITIONS:
        raise unprocessable("invalid_partition", f"partition must be one of {list(PARTITIONS)}")
    rule = split.get("patient_label_rule") or DEFAULT_PATIENT_LABEL_RULE
    if rule not in PATIENT_LABEL_RULES:
        raise unprocessable("invalid_patient_label_rule", f"patient_label_rule must be one of {list(PATIENT_LABEL_RULES)}")
    unused = [k for k in _UNUSED[partition] if split.get(k) is not None]
    if partition == "external_site" and isinstance(split.get("ratios"), Mapping) and "test" in split["ratios"]:
        raise unprocessable("test_ratio_not_allowed",
                            "external_site partitions define the test split by site; give ratios for train and val only")
    if unused:
        raise unprocessable("unused_split_parameter",
                            f"{partition} partitions do not use {unused}; they are rejected rather than stored",
                            unused=unused, partition=partition)
    out: dict = {"partition": partition, "patient_label_rule": rule, "algorithm": ALGORITHM}
    if partition == "random":
        out["seed"] = _seed(split.get("seed"))
        out["ratios"] = _ratios(split.get("ratios"), SPLITS, DEFAULT_RATIOS)
    elif partition == "temporal":
        if split.get("test_cutoff") is None:
            raise unprocessable("invalid_cutoff", "temporal partitions need test_cutoff (and optional val_cutoff) as YYYY-MM-DD")
        test_cut = _cutoff(split["test_cutoff"], "test_cutoff")
        val_cut = _cutoff(split["val_cutoff"], "val_cutoff") if split.get("val_cutoff") is not None else None
        if val_cut is not None and not val_cut < test_cut:
            raise unprocessable("invalid_cutoff", "val_cutoff must be before test_cutoff (otherwise val is empty)",
                                val_cutoff=val_cut.isoformat(), test_cutoff=test_cut.isoformat())
        out["test_cutoff"] = test_cut.isoformat()
        out["val_cutoff"] = val_cut.isoformat() if val_cut else None
    else:  # external_site
        out["seed"] = _seed(split.get("seed"))
        out["ratios"] = _ratios(split.get("ratios"), ("train", "val"), DEFAULT_EXTERNAL_RATIOS)
        sites = split.get("test_sites") or []
        if (not isinstance(sites, (list, tuple)) or not sites
                or not all(isinstance(s, str) and s.strip() for s in sites)):
            raise unprocessable("invalid_test_sites", "external_site partitions need test_sites: [site ids]")
        out["test_sites"] = sorted({s.strip() for s in sites})
    return out


def partition_key(split: Mapping | None) -> dict | None:
    """The parts of a normalised split that define an allocation (what a split family locks)."""
    if not split:
        return None
    return {k: split.get(k) for k in ("partition", "seed", "ratios", "test_cutoff", "val_cutoff", "test_sites",
                                      "patient_label_rule") if k in split}


def active_splits(split: Mapping | None) -> tuple[str, ...]:
    """Splits the configuration intends to populate (class presence is checked for these)."""
    if not split or split.get("partition") not in PARTITIONS:
        return SPLITS
    if split["partition"] == "random":
        return tuple(s for s in SPLITS if split["ratios"].get(s, 0.0) > 0)
    if split["partition"] == "temporal":
        return ("train", "val", "test") if split.get("val_cutoff") else ("train", "test")
    return tuple(s for s in ("train", "val") if split["ratios"].get(s, 0.0) > 0) + ("test",)


# --------------------------------------------------------------------------- keys, labels, fingerprints


def ordering_salt(family_salt: str, seed: int) -> str:
    return f"{family_salt}|{seed}"


def patient_key(salt: str, patient_code: str) -> str:
    """Content-stable ordering key: ``sha256(f"{salt}|{patient_code}")`` (hex)."""
    return hashlib.sha256(f"{salt}|{patient_code}".encode("utf-8")).hexdigest()


def patient_label(bag_labels: Sequence[str], rule: str = DEFAULT_PATIENT_LABEL_RULE, *,
                  positive_class: str = DEFAULT_POSITIVE_CLASS) -> str:
    """Stratification label of one patient from the labels of their included bags (deterministic)."""
    if rule not in PATIENT_LABEL_RULES:
        raise ValueError(f"unknown patient_label_rule {rule!r}")
    labels = [lb for lb in bag_labels if lb is not None]
    if not labels:
        raise ValueError("a patient needs at least one labelled bag")
    counts = Counter(labels)
    if rule == "any_positive" and positive_class in counts:
        return positive_class
    if rule == "any_positive":
        counts.pop(positive_class, None)
    top = max(counts.values())
    tied = sorted(v for v, n in counts.items() if n == top)
    return positive_class if positive_class in tied else tied[0]


def split_fingerprint(assignments: Iterable[tuple[str, str]]) -> str:
    """sha256 over the sorted ``(patient_code, split)`` pairs (canonical JSON)."""
    pairs = sorted([str(code), str(sp)] for code, sp in assignments)
    return hashlib.sha256(json.dumps(pairs, separators=(",", ":"), ensure_ascii=True).encode()).hexdigest()


# --------------------------------------------------------------------------- targets


def largest_remainder(n: int, ratios: Mapping[str, float], order: Sequence[str] = SPLITS) -> dict[str, int]:
    """Integer counts summing to ``n`` from ``ratio × n`` by largest remainder (ties: ``order``)."""
    raw = {s: float(ratios.get(s, 0.0)) * n for s in order}
    base = {s: math.floor(raw[s] + 1e-9) for s in order}
    left = n - sum(base.values())
    candidates = sorted((s for s in order if ratios.get(s, 0.0) > 0),
                        key=lambda s: (-(raw[s] - base[s]), order.index(s)))
    for i in range(left):
        base[candidates[i % len(candidates)]] += 1
    return base


def stratum_targets(n: int, ratios: Mapping[str, float], order: Sequence[str] = SPLITS) -> tuple[dict[str, int], int]:
    """Largest-remainder targets plus the minimum-one rule. Returns ``(targets, moves)``.

    When ``n`` is at least the number of splits with ``ratio > 0``, each such split gets at least one patient; a
    patient moves from the split with the largest target (largest surplus), preferring train.
    """
    t = largest_remainder(n, ratios, order)
    active = [s for s in order if ratios.get(s, 0.0) > 0]
    moves = 0
    if active and n >= len(active):
        for s in active:
            if t[s] == 0:
                donor = max(active, key=lambda d: (t[d], d == "train", -order.index(d)))
                t[donor] -= 1
                t[s] += 1
                moves += 1
    return t, moves


# --------------------------------------------------------------------------- patients and units


@dataclass(frozen=True)
class _Patient:
    id: str
    code: str
    label: str
    bag_labels: tuple[str, ...]
    slide_labels: tuple[str, ...]
    dates: tuple[date, ...]
    sites: frozenset[str]
    missing_dates: bool


def _as_date(v) -> date:
    return v if isinstance(v, date) else date.fromisoformat(v)


def _patients(raw: Sequence[Mapping], rule: str, positive_class: str) -> list[_Patient]:
    out: list[_Patient] = []
    for p in raw:
        bags = tuple(p.get("labels") or ())
        label = p.get("label") or patient_label(bags, rule, positive_class=positive_class)
        bags = bags or (label,)
        slide_labels = tuple(p.get("slide_labels") or ((label,) * max(int(p.get("slides") or 1), 1)))
        out.append(_Patient(id=str(p["id"]), code=str(p.get("code") or p["id"]), label=label, bag_labels=bags,
                            slide_labels=slide_labels, dates=tuple(_as_date(d) for d in (p.get("dates") or ())),
                            sites=frozenset(s for s in (p.get("sites") or ()) if s),
                            missing_dates=bool(p.get("missing_date_cases"))))
    ids = Counter(p.id for p in out)
    codes = Counter(p.code for p in out)
    dup = sorted([i for i, n in ids.items() if n > 1] + [c for c, n in codes.items() if n > 1])
    if dup:
        raise ValueError(f"patient ids and codes must be unique; duplicated: {dup[:10]}")
    return out


def _units(patients: list[_Patient], groups: Iterable[tuple[str, str]]) -> tuple[list[list[_Patient]], int]:
    """Union-find over grouping pairs; returns units (lists of patients) and the number of pairs applied."""
    parent = {p.id: p.id for p in patients}

    def find(x: str) -> str:
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    used = 0
    for a, b in groups:
        if a in parent and b in parent and a != b:
            ra, rb = find(a), find(b)
            used += 1
            if ra != rb:
                parent[max(ra, rb)] = min(ra, rb)
    by_root: dict[str, list[_Patient]] = defaultdict(list)
    for p in patients:
        by_root[find(p.id)].append(p)
    return list(by_root.values()), used


def _unit_label(unit: list[_Patient], rule: str, positive_class: str) -> str:
    if len(unit) == 1:
        return unit[0].label
    return patient_label([lb for p in unit for lb in p.bag_labels], rule, positive_class=positive_class)


def _allocate_stratified(units: list[list[_Patient]], unit_split: dict[int, str], keys: dict[str, str],
                         ratios: Mapping[str, float], order: Sequence[str], rule: str, positive_class: str) -> dict:
    """Assign every unit index not in ``unit_split`` (in place). Returns per-stratum targets and adjustments."""
    strata: dict[str, list[int]] = defaultdict(list)
    for i, u in enumerate(units):
        strata[_unit_label(u, rule, positive_class)].append(i)
    active = [s for s in order if ratios.get(s, 0.0) > 0]
    targets, moves, infeasible = {}, {}, []
    for label in sorted(strata):
        idx = strata[label]
        n = sum(len(units[i]) for i in idx)
        t, m = stratum_targets(n, ratios, order)
        targets[label], moves[label] = t, m
        if n < len(active):
            infeasible.append({"class": label, "patients": n, "splits_with_ratio": len(active)})
        counts = {s: 0 for s in order}
        for i in idx:
            if i in unit_split:
                counts[unit_split[i]] = counts.get(unit_split[i], 0) + len(units[i])
        free = sorted((i for i in idx if i not in unit_split),
                      key=lambda i: (-len(units[i]), min(keys[p.id] for p in units[i])))
        for i in free:
            s = max(active, key=lambda s: (t[s] - counts[s], -order.index(s)))
            unit_split[i] = s
            counts[s] += len(units[i])
    return {"targets": targets, "min_one_adjustments": {k: v for k, v in moves.items() if v},
            "min_one_infeasible": infeasible}


def _by_date(p: _Patient, test_cut: date, val_cut: date | None) -> str:
    """Temporal rule: a patient goes by their LATEST case date (later material never trains)."""
    latest = max(p.dates)
    return "test" if latest >= test_cut else "val" if (val_cut and latest >= val_cut) else "train"


# --------------------------------------------------------------------------- allocation


def allocate(patients: Sequence[Mapping], split: Mapping, *, salt: str = "",
             existing: Mapping[str, str] | None = None, groups: Iterable[tuple[str, str]] = (),
             classes: Sequence[str] | None = None, known_sites: Iterable[str] | None = None,
             positive_class: str = DEFAULT_POSITIVE_CLASS) -> tuple[dict[str, str], dict]:
    """Patient infos + split config → ``({patient_id: split}, diagnostics)``.

    ``patients``: mappings with ``id``, ``code`` (the content-stable key; defaults to ``id``), either ``label``
    (stratum) or ``labels`` (per-bag labels; the stratum then follows ``patient_label_rule``), optional
    ``slide_labels``/``slides``, ``dates`` (all of the patient's case dates), ``sites`` (all of the patient's case
    sites) and ``missing_date_cases`` (included cases without a date).
    ``salt``: the split family salt. ``existing``: ``{patient_id: split}`` already held in the family (inherited,
    never moved). ``groups``: patient-id pairs that must share a split. ``classes``: task classes whose presence
    per split is checked besides those in the cohort. ``known_sites``: when given, ``test_sites`` must be among them
    (422 ``unknown_site``).
    """
    split = normalise_split(split)
    partition, rule = split["partition"], split["patient_label_rule"]
    pts = _patients(patients, rule, positive_class)
    by_id = {p.id: p for p in pts}
    seed = split.get("seed", 0)
    salt_s = ordering_salt(salt, seed)
    keys = {p.id: patient_key(salt_s, p.code) for p in pts}
    family = existing is not None
    inherited = {pid: sp for pid, sp in (existing or {}).items() if pid in by_id}
    bad = sorted({sp for sp in inherited.values() if sp not in SPLITS})
    if bad:
        raise ValueError(f"existing assignments must be one of {SPLITS}; got {bad}")
    units, groups_used = _units(pts, groups)
    units.sort(key=lambda u: min(keys[p.id] for p in u))

    unit_split: dict[int, str] = {}
    conflicts = []
    for i, u in enumerate(units):
        held = {inherited[p.id] for p in u if p.id in inherited}
        if len(held) == 1:
            unit_split[i] = held.pop()
        elif len(held) > 1:
            first = min((p for p in u if p.id in inherited), key=lambda p: keys[p.id])
            unit_split[i] = inherited[first.id]
            conflicts.append({"patient_codes": sorted(p.code for p in u),
                              "inherited_splits": {p.code: inherited[p.id] for p in u if p.id in inherited}})

    diag: dict = {"algorithm": ALGORITHM, "partition": partition, "patient_label_rule": rule,
                  "positive_class": positive_class, "ordering": "sha256(f'{family_salt}|{seed}|{patient_code}')"}
    if partition in ("random", "external_site"):
        diag["seed"] = seed

    if partition == "random":
        diag.update(_allocate_stratified(units, unit_split, keys, split["ratios"], SPLITS, rule, positive_class))
    elif partition == "temporal":
        test_cut = date.fromisoformat(split["test_cutoff"])
        val_cut = date.fromisoformat(split["val_cutoff"]) if split.get("val_cutoff") else None
        free = [p for i, u in enumerate(units) if i not in unit_split for p in u]
        missing = sorted(p.id for p in free if not p.dates or p.missing_dates)
        if missing:
            raise unprocessable("missing_collected_on",
                                "Temporal partitions need collected_on for every case of every included patient",
                                patients=missing)
        for i, u in enumerate(units):
            if i not in unit_split:
                unit_split[i] = max((_by_date(p, test_cut, val_cut) for p in u), key=SPLITS.index)
    else:  # external_site
        test_sites = set(split["test_sites"])
        if known_sites is not None:
            unknown = sorted(test_sites - set(known_sites))
            if unknown:
                raise unprocessable("unknown_site", f"test_sites not found among the project's case sites: {unknown}",
                                    unknown=unknown, known=sorted(set(known_sites)))
        for i, u in enumerate(units):
            if i not in unit_split and any(p.sites & test_sites for p in u):
                unit_split[i] = "test"
        rest = [i for i, u in enumerate(units) if unit_split.get(i) != "test"]
        sub_units = [units[i] for i in rest]
        sub_split = {j: unit_split[i] for j, i in enumerate(rest) if i in unit_split}
        alloc = _allocate_stratified(sub_units, sub_split, keys, split["ratios"], ("train", "val"), rule, positive_class)
        for j, i in enumerate(rest):
            unit_split[i] = sub_split[j]
        diag.update({"remainder_" + k: v for k, v in alloc.items()})
        diag["rule"] = "a patient with ANY case at a test site is entirely test"
        diag["patients_with_cases_at_test_and_other_sites"] = sum(
            1 for p in pts if p.sites & test_sites and p.sites - test_sites)
        unknown_site = sorted(p.code for p in pts if not p.sites)
        diag["patients_with_unknown_site"] = {"count": len(unknown_site), "patient_codes": unknown_site[:_DIAG_LIST_CAP],
                                              "note": "no case of these patients has a site; they cannot be test"}
        per_site: dict[str, Counter] = defaultdict(Counter)
        for p in pts:
            for s in p.sites or {"unknown"}:
                per_site[s][p.label] += 1
        diag["per_site_patients_by_class"] = {s: dict(sorted(c.items())) for s, c in sorted(per_site.items())}

    # Inherited patients keep their own split, even inside a unit whose members disagree (reported as a conflict).
    mapping = {p.id: inherited.get(p.id, unit_split[i]) for i, u in enumerate(units) for p in u}
    if partition == "temporal":
        spanning = 0
        for p in pts:
            cut = test_cut if mapping[p.id] == "test" else val_cut if mapping[p.id] == "val" else None
            spanning += bool(p.dates and cut and min(p.dates) < cut)
        diag["patients_spanning_a_cutoff"] = spanning
        diag["rule"] = "a patient is assigned by their LATEST case date (later material never trains)"
        diag["inherited_against_rule"] = sorted(p.code for p in pts
                                                if p.id in inherited and p.dates
                                                and _by_date(p, test_cut, val_cut) != mapping[p.id])
    diag.update(_composition(pts, mapping, split, classes))
    diag["grouping"] = {"constraints_applied": groups_used,
                        "multi_patient_units": [sorted(p.code for p in u) for u in units if len(u) > 1][:_DIAG_LIST_CAP],
                        "conflicts": conflicts}
    if partition == "temporal":
        ranges = {}
        for sp in SPLITS:
            ds = [d for p in pts if mapping[p.id] == sp for d in p.dates]
            ranges[sp] = {"earliest": min(ds).isoformat(), "latest": max(ds).isoformat()} if ds else None
        diag["date_range_per_split"] = ranges
    if partition == "external_site":
        n = len(pts)
        diag["achieved_test_fraction"] = round(diag["patients_per_split"]["test"] / n, 4) if n else None
    if family:
        diag["family"] = {"inherited": len(inherited), "new": len(pts) - len(inherited),
                          "dropped": len(set(existing or {}) - set(by_id))}
    return mapping, diag


def class_report(patients: Sequence[Mapping], mapping: Mapping[str, str], split: Mapping | None = None, *,
                 classes: Sequence[str] | None = None, positive_class: str = DEFAULT_POSITIVE_CLASS) -> dict:
    """Per split × class counts, ``class_absent``, empty splits and mixed-label patients for an EXISTING mapping
    (e.g. a frozen manifest or manually written assignments). Patients as in :func:`allocate`."""
    rule = (split or {}).get("patient_label_rule") or DEFAULT_PATIENT_LABEL_RULE
    return _composition(_patients(patients, rule, positive_class), mapping, split, classes)


def _composition(pts: list[_Patient], mapping: Mapping[str, str], split: Mapping | None,
                 classes: Sequence[str] | None) -> dict:
    """Per split × class patient and slide counts, class presence, empty splits, mixed-label patients."""
    cohort_classes = {p.label for p in pts} | {lb for p in pts for lb in p.slide_labels}
    ordered = [c for c in (classes or ()) if c] + sorted(cohort_classes - set(classes or ()))
    ordered = list(dict.fromkeys(ordered))
    per: dict[str, dict[str, dict[str, int]]] = {sp: {c: {"patients": 0, "slides": 0} for c in ordered} for sp in SPLITS}
    for p in pts:
        sp = mapping[p.id]
        per[sp][p.label]["patients"] += 1
        for lb in p.slide_labels:
            per[sp][lb]["slides"] += 1
    counts = Counter(mapping.values())
    active = active_splits(split)
    patient_classes = [c for c in ordered if c in {p.label for p in pts} or c in (classes or ())]
    absent = [{"split": sp, "class": c, "patients": 0, "slides": per[sp][c]["slides"]}
              for sp in active for c in patient_classes if per[sp][c]["patients"] == 0]
    mixed = sorted(p.code for p in pts if len(set(p.bag_labels)) > 1)
    return {
        "patients_per_split": {sp: counts.get(sp, 0) for sp in SPLITS},
        "slides_per_split": {sp: sum(len(p.slide_labels) for p in pts if mapping[p.id] == sp) for sp in SPLITS},
        "classes": ordered,
        "per_split_class": per,
        "active_splits": list(active),
        "class_absent": absent,
        "empty_splits": [sp for sp in active if counts.get(sp, 0) == 0],
        "mixed_label_patients": {"count": len(mixed), "patient_codes": mixed[:_DIAG_LIST_CAP],
                                 "note": "patients whose included bags carry different labels; each bag keeps its own "
                                         "label, the rule only stratifies"},
    }
