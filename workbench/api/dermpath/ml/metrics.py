"""Evaluation metrics as pure functions over (labels, scores, predictions, patients).

Conventions: label 1 = the task's positive class; ``predicted = score >= threshold``.

* Ratio metrics always carry numerator and denominator. A zero denominator gives
  ``value: None`` with an ``undefined_reason``; nothing is imputed.
* AUROC and AUPRC (average precision) are defined only when both classes are present.
* Confidence intervals: patient-cluster bootstrap (resample PATIENTS with replacement,
  keep all of their items; seeded). With fewer than ``min_patients`` patients, or when too
  many replicates leave a metric undefined, the CI is ``None`` with a reason.
* Scores are model outputs, not probabilities unless calibrated (calibration bins, Brier
  and ECE are reported to show how far they are from calibrated).

Evaluation resistant to self-deception (design §7; the second half of this module)
-------------------------------------------------------------------------------------
* :func:`evaluate_binary`: the full body at a frozen operating point. Sensitivity and
  specificity with numerator, denominator and CI; tie-correct AUROC and AUPRC (with the
  prevalence baseline); PPV/NPV with the evaluation prevalence stated, plus Bayes-adjusted
  PPV/NPV for a declared target prevalence; Brier; ECE with equal-width and equal-mass bins;
  intention-to-evaluate sensitivity/specificity (unscorable positives count as missed,
  unscorable negatives as flagged). Every CI comes from one patient-cluster bootstrap that
  resamples patients with ALL of their bags, scored or not; a CI is reported only when the
  point estimate is defined.
* :func:`select_operating_threshold`: prespecified rules ``youden | target_sensitivity |
  fixed`` with a minimum-evidence rule (``selection_status: insufficient_evidence``).
* :func:`risk_coverage_curve`, :func:`select_abstention_policy`, :func:`apply_abstention`,
  :func:`selective_evaluation`: abstention chosen on development scores and frozen. Model
  confidence is not an out-of-distribution detector (:data:`ABSTENTION_NOTE`).
* :func:`subgroup_analysis`: ``min_patients`` counts PATIENTS; patient-cluster CIs.

The first-generation functions (:func:`calibration`, :func:`coverage_curve`,
:func:`subgroups`, :func:`select_threshold`) keep their behaviour for existing callers and
are deprecated in favour of the functions above.
"""

from __future__ import annotations

import hashlib
import json
import math
from collections import defaultdict
from collections.abc import Callable, Iterator, Mapping, Sequence

import numpy as np

from . import SCORE_NOTE

RATIO_METRICS = ("sensitivity", "specificity", "ppv", "npv")
RANK_METRICS = ("auroc", "auprc")
BOOT_MIN_VALID_FRACTION = 0.8


def _arr(y, s=None):
    y = np.asarray(y, dtype=np.int64)
    if s is None:
        return y
    return y, np.asarray(s, dtype=np.float64)


def confusion(y, pred) -> dict:
    y, p = np.asarray(y, dtype=np.int64), np.asarray(pred, dtype=np.int64)
    return {"tp": int(((y == 1) & (p == 1)).sum()), "fp": int(((y == 0) & (p == 1)).sum()),
            "tn": int(((y == 0) & (p == 0)).sum()), "fn": int(((y == 1) & (p == 0)).sum())}


_UNDEFINED = {
    "sensitivity": "undefined (denominator 0: no positive items)",
    "specificity": "undefined (denominator 0: no negative items)",
    "ppv": "undefined (denominator 0: no items predicted positive)",
    "npv": "undefined (denominator 0: no items predicted negative)",
}


def ratio_parts(c: dict) -> dict[str, tuple[int, int]]:
    return {"sensitivity": (c["tp"], c["tp"] + c["fn"]), "specificity": (c["tn"], c["tn"] + c["fp"]),
            "ppv": (c["tp"], c["tp"] + c["fp"]), "npv": (c["tn"], c["tn"] + c["fn"])}


def ratio_metric(name: str, num: int, den: int) -> dict:
    return {"value": (num / den) if den else None, "numerator": int(num), "denominator": int(den), "ci": None,
            "undefined_reason": None if den else _UNDEFINED[name]}


def auroc_fast(y: np.ndarray, s: np.ndarray) -> float | None:
    """Mann–Whitney AUROC with average ranks for ties (equals sklearn's roc_auc_score)."""
    from scipy.stats import rankdata  # lazy: scipy.stats costs ~0.4 s at API start-up

    n_pos = int(y.sum())
    n_neg = int(y.size - n_pos)
    if n_pos == 0 or n_neg == 0:
        return None
    r = rankdata(s, method="average")
    return float((r[y == 1].sum() - n_pos * (n_pos + 1) / 2.0) / (n_pos * n_neg))


def average_precision_fast(y: np.ndarray, s: np.ndarray) -> float | None:
    """Step-wise average precision (equals sklearn's average_precision_score)."""
    n_pos = int(y.sum())
    if n_pos == 0 or n_pos == y.size:
        return None
    order = np.argsort(-s, kind="mergesort")
    ss, yy = s[order], y[order]
    idx = np.r_[np.where(np.diff(ss))[0], yy.size - 1]
    tps = np.cumsum(yy)[idx]
    fps = 1 + idx - tps
    precision = tps / (tps + fps)
    recall = tps / n_pos
    prev = np.r_[0.0, recall[:-1]]
    return float(np.sum((recall - prev) * precision))


def rank_metric(name: str, y: np.ndarray, s: np.ndarray) -> dict:
    n_pos, n_neg = int(y.sum()), int(y.size - y.sum())
    if n_pos == 0 or n_neg == 0:
        return {"value": None, "defined": False, "ci": None,
                "undefined_reason": f"undefined: needs both classes (positives={n_pos}, negatives={n_neg})"}
    from sklearn.metrics import average_precision_score, roc_auc_score

    value = roc_auc_score(y, s) if name == "auroc" else average_precision_score(y, s)
    out = {"value": float(value), "defined": True, "ci": None, "undefined_reason": None}
    if name == "auprc":
        out["method"] = "average precision (step-wise, sklearn-equivalent)"
        out["prevalence_baseline"] = n_pos / y.size
    return out


def point_metrics(y, s, pred) -> tuple[dict, dict]:
    y, s = _arr(y, s)
    c = confusion(y, pred)
    m = {k: ratio_metric(k, *v) for k, v in ratio_parts(c).items()}
    m["auroc"] = rank_metric("auroc", y, s)
    m["auprc"] = rank_metric("auprc", y, s)
    return c, m


def _replicate_values(y: np.ndarray, s: np.ndarray, p: np.ndarray) -> dict[str, float | None]:
    c = confusion(y, p)
    out: dict[str, float | None] = {}
    for k, (num, den) in ratio_parts(c).items():
        out[k] = num / den if den else None
    out["auroc"] = auroc_fast(y, s)
    out["auprc"] = average_precision_fast(y, s)
    return out


def bootstrap_replicates(y, s, pred, patients, *, n_boot: int, seed: int) -> dict[str, list]:
    """Raw replicate values per metric (None where undefined). Exposed for tests."""
    y, s = _arr(y, s)
    p = np.asarray(pred, dtype=np.int64)
    groups: dict = defaultdict(list)
    for i, pid in enumerate(patients):
        groups[pid].append(i)
    keys = sorted(groups)
    idx_by = [np.asarray(groups[k], dtype=np.int64) for k in keys]
    rng = np.random.default_rng(seed)
    reps: dict[str, list] = {k: [] for k in RATIO_METRICS + RANK_METRICS}
    for _ in range(n_boot):
        draw = rng.integers(0, len(keys), size=len(keys))
        idx = np.concatenate([idx_by[d] for d in draw])
        vals = _replicate_values(y[idx], s[idx], p[idx])
        for k in reps:
            reps[k].append(vals[k])
    return reps


def bootstrap_cis(y, s, pred, patients, *, n_boot: int, seed: int, min_patients: int) -> tuple[dict, dict]:
    """``({metric: {ci, ci_reason, valid_replicates}}, bootstrap_info)``."""
    n_patients = len(set(patients))
    info = {"method": "patient_cluster", "n_boot": int(n_boot), "seed": int(seed), "n_patients": n_patients,
            "min_patients": int(min_patients), "interval": "percentile 2.5–97.5"}
    names = RATIO_METRICS + RANK_METRICS
    if n_boot <= 0:
        reason = "bootstrap disabled (n_boot=0)"
        return {k: {"ci": None, "ci_reason": reason, "valid_replicates": 0} for k in names}, {**info, "status": reason}
    if n_patients < min_patients:
        reason = (f"insufficient evidence: {n_patients} patient(s); a patient-cluster bootstrap needs at least "
                  f"{min_patients}")
        return {k: {"ci": None, "ci_reason": reason, "valid_replicates": 0} for k in names}, {**info, "status": reason}
    reps = bootstrap_replicates(y, s, pred, patients, n_boot=n_boot, seed=seed)
    out = {}
    for k in names:
        vals = np.array([v for v in reps[k] if v is not None], dtype=np.float64)
        if vals.size < BOOT_MIN_VALID_FRACTION * n_boot:
            out[k] = {"ci": None, "valid_replicates": int(vals.size),
                      "ci_reason": (f"metric undefined in {n_boot - vals.size} of {n_boot} replicates "
                                    f"(need ≥{int(BOOT_MIN_VALID_FRACTION * 100)}% defined)")}
        else:
            lo, hi = np.percentile(vals, [2.5, 97.5])
            out[k] = {"ci": [float(lo), float(hi)], "ci_reason": None, "valid_replicates": int(vals.size)}
    return out, {**info, "status": "ok"}


def calibration(y, s, n_bins: int = 10) -> dict:
    """Deprecated: use :func:`calibration_report` (equal-width and equal-mass bins, MCE,
    sklearn-compatible bin edges). Kept unchanged for existing callers."""
    y, s = _arr(y, s)
    bins = []
    edges = np.linspace(0.0, 1.0, n_bins + 1)
    ece = 0.0
    n = y.size
    for i in range(n_bins):
        lo, hi = float(edges[i]), float(edges[i + 1])
        sel = (s >= lo) & ((s < hi) if i < n_bins - 1 else (s <= hi))
        k = int(sel.sum())
        if k:
            ms, fp = float(s[sel].mean()), float(y[sel].mean())
            ece += k / n * abs(ms - fp)
        else:
            ms = fp = None
        bins.append({"lo": lo, "hi": hi, "mean_score": ms, "fraction_positive": fp, "n": k})
    return {"bins": bins, "brier": float(np.mean((s - y) ** 2)) if n else None, "ece": float(ece) if n else None,
            "note": SCORE_NOTE, "n": int(n)}


def coverage_curve(y, s, pred, threshold: float, steps: int = 10) -> list[dict]:
    """Abstain on the items closest to the threshold first; report the error among the rest.

    Deprecated: descriptive only. Use :func:`risk_coverage_curve` (tie-invariant, AURC,
    per-class selective risk) and :func:`select_abstention_policy` on development data."""
    y, s = _arr(y, s)
    p = np.asarray(pred, dtype=np.int64)
    n = y.size
    if n == 0:
        return []
    order = np.argsort(-np.abs(s - threshold), kind="mergesort")
    err = (p != y)[order]
    out, seen = [], set()
    for i in range(steps, 0, -1):
        k = max(1, int(math.ceil(n * i / steps)))
        if k in seen:
            continue
        seen.add(k)
        out.append({"coverage": k / n, "error_rate": float(err[:k].mean()), "n_kept": int(k),
                    "abstained": int(n - k)})
    return out


def subgroups(y, s, pred, attrs: list[dict], *, keys=("scanner_id", "site_id", "stain"), min_n: int = 10) -> list[dict]:
    """Deprecated: ``min_n`` counts bags and there are no CIs. Use :func:`subgroup_analysis`
    (``min_patients`` counts patients; patient-cluster CIs)."""
    y, s = _arr(y, s)
    p = np.asarray(pred, dtype=np.int64)
    out = []
    for key in keys:
        groups: dict = defaultdict(list)
        for i, a in enumerate(attrs):
            groups[a.get(key) or "unknown"].append(i)
        for value in sorted(groups):
            idx = np.asarray(groups[value], dtype=np.int64)
            n, pos = int(idx.size), int(y[idx].sum())
            neg = n - pos
            row = {"key": key, "value": value, "n": n, "positives": pos, "negatives": neg}
            if n < min_n or pos == 0 or neg == 0:
                why = []
                if n < min_n:
                    why.append(f"n={n} < {min_n}")
                if pos == 0 or neg == 0:
                    why.append("both classes are not present")
                row.update({"status": "insufficient_evidence", "metrics": None,
                            "reason": "insufficient evidence: " + "; ".join(why)})
            else:
                c, m = point_metrics(y[idx], s[idx], p[idx])
                row.update({"status": "ok", "metrics": {**m, "confusion": c}, "reason": None,
                            "note": "point estimates only (no subgroup CIs); exploratory"})
            out.append(row)
    return out


def select_threshold(y, s, *, rule: str, target_sensitivity: float = 0.9) -> dict:
    """Choose an operating threshold on VALIDATION scores. Predicted positive: score >= value.

    Deprecated: no minimum-evidence rule (one positive is enough). Use
    :func:`select_operating_threshold`."""
    y, s = _arr(y, s)
    n_pos, n_neg = int(y.sum()), int(y.size - y.sum())
    base = {"requested_rule": rule, "n_val_items": int(y.size), "val_positives": n_pos, "val_negatives": n_neg,
            "comparison": "positive if score >= value"}
    if rule == "target_sensitivity":
        base["target_sensitivity"] = target_sensitivity
    need_neg = rule == "youden"
    if y.size == 0 or n_pos == 0 or (need_neg and n_neg == 0):
        why = ("the validation split is empty" if y.size == 0 else
               f"the validation split lacks a class (positives={n_pos}, negatives={n_neg})")
        return {**base, "value": 0.5, "rule": "fixed_0.5_fallback", "selection_status": "fallback",
                "reason": f"{rule} cannot be computed because {why}; a fixed 0.5 was frozen instead. Treat any "
                          "test result at this threshold as unvalidated."}
    cands = np.unique(s)[::-1]  # descending
    pos_s, neg_s = s[y == 1], s[y == 0]
    best = None
    for t in cands:
        sens = float((pos_s >= t).mean())
        spec = float((neg_s < t).mean()) if n_neg else None
        if rule == "youden":
            j = sens + spec - 1.0
            key = (round(j, 12), sens, t)  # ties: higher sensitivity, then higher threshold
            if best is None or key > best[0]:
                best = (key, t, sens, spec, j)
        else:  # target_sensitivity: the highest threshold reaching the target
            if sens >= target_sensitivity:
                best = ((sens,), t, sens, spec, None)
                break
    _, t, sens, spec, j = best
    out = {**base, "value": float(t), "rule": rule, "selection_status": "selected", "reason": None,
           "val_sensitivity_at_threshold": sens, "val_specificity_at_threshold": spec}
    if j is not None:
        out["youden_j"] = j
    return out


# =========================================================================== design §7 API
#
# Everything below validates its inputs (labels 0/1, finite scores). Unscorable bags are
# passed separately with their labels and patients, never as NaN scores. Outputs are plain
# JSON-serialisable dicts (Python ints and floats only).

METRICS_SCHEMA = "dermpath.metrics/2"
ABSTENTION_SCHEMA = "dermpath.abstention/1"
THRESHOLD_RULES = ("youden", "target_sensitivity", "fixed")
THRESHOLD_MIN_POSITIVES = 10
THRESHOLD_MIN_NEGATIVES = 10
SUBGROUP_KEYS = ("scanner_id", "site_id", "stain", "stain_batch")
COMPARISON_RULE = "positive if score >= threshold"
BOOT_INTERVAL = "percentile 2.5–97.5"
MARGIN_DECIMALS = 12
TUNING_SET_NOTE = "optimistic: the threshold was chosen on these data"
PREVALENCE_NOTE = ("PPV and NPV depend on prevalence. At the evaluation prevalence they describe this split, whose "
                   "class mix is set by the dataset design; they do not transfer to another population.")
ITE_RULE = ("intention to evaluate: unscorable positives are counted as missed (false negatives) and unscorable "
            "negatives as flagged (false positives)")
ABSTENTION_NOTE = ("Model confidence is not a validated out-of-distribution detector. Abstention defers items whose "
                   "scores lie near the threshold on data like the development set; it does not recognise unfamiliar "
                   "slides, scanners, stains or diagnoses, and it is not a safety guarantee.")
MARGIN_DEFINITION = ("relative margin: (score - threshold) / (hi - threshold) at or above the threshold and "
                     "(threshold - score) / (threshold - lo) below it, so 0 at the threshold and 1 at either end of "
                     "the score range [lo, hi]")
SUBGROUP_NOTE = ("Exploratory: no multiplicity correction and no test of subgroup differences. A patient whose bags "
                 "fall in several subgroups is counted in each; case bags whose slides differ carry the value "
                 "'mixed'.")


def canonical_sha256(obj) -> str:
    """sha256 of canonical JSON (sorted keys, compact separators, ASCII, NaN refused)."""
    data = json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=True, allow_nan=False).encode()
    return hashlib.sha256(data).hexdigest()


# --------------------------------------------------------------------------- validation


def binary_labels(y) -> np.ndarray:
    """Labels as int64, refusing anything other than 0 (negative class) and 1 (positive class)."""
    a = np.asarray(y)
    if a.ndim != 1:
        raise ValueError("labels must be a one-dimensional sequence")
    if a.size and not np.isin(a, (0, 1)).all():
        raise ValueError("labels must be 0 (negative class) or 1 (positive class)")
    return a.astype(np.int64)


def finite_scores(s, n: int | None = None, *, what: str = "scores") -> np.ndarray:
    a = np.asarray(s, dtype=np.float64)
    if a.ndim != 1:
        raise ValueError(f"{what} must be a one-dimensional sequence")
    if n is not None and a.size != n:
        raise ValueError(f"{what} has {a.size} value(s) for {n} label(s)")
    if a.size and not np.isfinite(a).all():
        raise ValueError(f"{what} must be finite; pass unscorable bags separately, never as NaN")
    return a


def _score_range(score_range) -> tuple[float, float]:
    lo, hi = (float(v) for v in score_range)
    if not lo < hi:
        raise ValueError("score_range must be (lo, hi) with lo < hi")
    return lo, hi


def _check_in_range(s: np.ndarray, lo: float, hi: float, what: str = "scores") -> None:
    if s.size and (s.min() < lo or s.max() > hi):
        raise ValueError(f"{what} must lie in [{lo}, {hi}]")


def _patient_list(patients, n: int) -> list:
    p = list(patients)
    if len(p) != n:
        raise ValueError(f"patients has {len(p)} entries for {n} item(s)")
    return p


def _ratio(num: int, den: int, undefined_reason: str) -> dict:
    return {"value": (num / den) if den else None, "numerator": int(num), "denominator": int(den), "ci": None,
            "undefined_reason": None if den else undefined_reason}


# --------------------------------------------------------------------------- exact and Bayes helpers


def exact_binomial_ci(k: int, n: int, alpha: float = 0.05) -> list[float] | None:
    """Clopper–Pearson (exact) interval for ``k`` successes in ``n`` trials; ``None`` when n == 0.
    Item-level: it ignores the clustering of bags within patients."""
    if n == 0:
        return None
    from scipy.stats import beta  # lazy, see auroc_fast

    lo = 0.0 if k == 0 else float(beta.ppf(alpha / 2, k, n - k + 1))
    hi = 1.0 if k == n else float(beta.ppf(1 - alpha / 2, k + 1, n - k))
    return [lo, hi]


def _bayes_pv(sens: float | None, spec: float | None, prevalence: float) -> tuple[float | None, float | None]:
    if sens is None or spec is None:
        return None, None
    tp, fp = sens * prevalence, (1.0 - spec) * (1.0 - prevalence)
    tn, fn = spec * (1.0 - prevalence), (1.0 - sens) * prevalence
    return (tp / (tp + fp) if tp + fp > 0 else None), (tn / (tn + fn) if tn + fn > 0 else None)


def prevalence_adjusted_predictive_values(sensitivity: float | None, specificity: float | None,
                                          prevalence: float) -> dict:
    """PPV and NPV that ``sensitivity`` and ``specificity`` would give at a DECLARED target
    prevalence π (Bayes' theorem):

        PPV = Se·π / (Se·π + (1 − Sp)(1 − π)),   NPV = Sp(1 − π) / (Sp(1 − π) + (1 − Se)π).

    It assumes sensitivity and specificity transfer unchanged to the target population
    (no spectrum shift), which is itself unverified."""
    prevalence = float(prevalence)
    if not 0.0 < prevalence < 1.0:
        raise ValueError("target prevalence must lie strictly between 0 and 1")
    ppv, npv = _bayes_pv(sensitivity, specificity, prevalence)
    missing = sensitivity is None or specificity is None
    why_missing = "undefined: needs both sensitivity and specificity"
    return {
        "target_prevalence": prevalence,
        "method": "Bayes' theorem from sensitivity and specificity",
        "assumption": "sensitivity and specificity transfer unchanged to a population with the target prevalence",
        "ppv": {"value": ppv, "ci": None, "undefined_reason": None if ppv is not None else (
            why_missing if missing else "undefined: no positive calls expected (sensitivity 0 and specificity 1)")},
        "npv": {"value": npv, "ci": None, "undefined_reason": None if npv is not None else (
            why_missing if missing else "undefined: no negative calls expected (sensitivity 1 and specificity 0)")},
    }


# --------------------------------------------------------------------------- patient-cluster bootstrap


def patient_strata(y, patients) -> dict:
    """Patient → 1 if any of the patient's bags is positive, else 0 (strata for a stratified bootstrap)."""
    out: dict = {}
    for yi, p in zip(np.asarray(y).tolist(), patients):
        out[p] = max(out.get(p, 0), int(yi))
    return out


def patient_bootstrap_indices(patients: Sequence, *, n_boot: int, seed: int,
                              strata: Mapping | None = None) -> Iterator[np.ndarray]:
    """Yield one item-index array per replicate. Patients are drawn with replacement and each
    drawn patient contributes ALL of its items, so the bags of one patient always move together.

    Patient keys are sorted before drawing, so which patients are drawn depends only on the
    patient identifiers, the seed and the strata. Unstratified, the stream is identical to
    :func:`bootstrap_replicates`. With ``strata`` (patient → stratum), each stratum is resampled
    to its own size (the patient count per stratum is fixed), strata in sorted order."""
    groups: dict = defaultdict(list)
    for i, pid in enumerate(patients):
        groups[pid].append(i)
    keys = sorted(groups)
    idx_by = [np.asarray(groups[k], dtype=np.int64) for k in keys]
    if strata is None:
        pools = [np.arange(len(keys), dtype=np.int64)]
    else:
        by: dict = defaultdict(list)
        for j, k in enumerate(keys):
            by[strata[k]].append(j)
        pools = [np.asarray(by[st], dtype=np.int64) for st in sorted(by)]
    rng = np.random.default_rng(seed)
    for _ in range(int(n_boot)):
        draw = np.concatenate([pool[rng.integers(0, pool.size, size=pool.size)] for pool in pools]) \
            if keys else np.empty(0, dtype=np.int64)
        yield np.concatenate([idx_by[d] for d in draw]) if draw.size else np.empty(0, dtype=np.int64)


def percentile_ci(values: Sequence[float | None], n_boot: int,
                  *, min_valid_fraction: float = BOOT_MIN_VALID_FRACTION) -> dict:
    """Percentile 2.5–97.5 interval over the replicates where the metric is defined; ``None``
    (with the count) when fewer than ``min_valid_fraction`` of the replicates are defined."""
    vals = np.array([v for v in values if v is not None], dtype=np.float64)
    if n_boot <= 0 or vals.size < min_valid_fraction * n_boot:
        return {"ci": None, "ci_valid_replicates": int(vals.size),
                "ci_reason": (f"metric undefined in {int(n_boot) - int(vals.size)} of {int(n_boot)} replicates "
                              f"(need ≥{int(min_valid_fraction * 100)}% defined)")}
    lo, hi = np.percentile(vals, [2.5, 97.5])
    return {"ci": [float(lo), float(hi)], "ci_reason": None, "ci_valid_replicates": int(vals.size)}


def bootstrap_gate(n_boot: int, n_patients: int, min_patients: int) -> str | None:
    """Reason no bootstrap is run, or ``None`` when it can run."""
    if n_boot <= 0:
        return "bootstrap disabled (n_boot=0)"
    if n_patients < min_patients:
        return (f"insufficient evidence: {n_patients} patient(s); a patient-cluster bootstrap needs at least "
                f"{min_patients}")
    return None


def run_patient_bootstrap(stat: Callable[[np.ndarray], dict], patients: Sequence, *, n_boot: int, seed: int,
                          min_patients: int, strata: Mapping | None = None) -> tuple[dict | None, dict]:
    """``(replicates or None, info)``: ``stat(idx)`` is called once per replicate with the item
    indices of that replicate and returns ``{metric: value or None}``."""
    n_patients = len(set(patients))
    gate = bootstrap_gate(n_boot, n_patients, min_patients)
    info = {"method": "patient_cluster",
            "resampling_unit": "patient: every bag of a drawn patient enters the replicate together",
            "stratified": strata is not None,
            "strata": "patient label (any bag positive)" if strata is not None else None,
            "n_boot": int(n_boot), "seed": int(seed), "n_patients": int(n_patients),
            "min_patients": int(min_patients), "interval": BOOT_INTERVAL,
            "min_valid_fraction": BOOT_MIN_VALID_FRACTION, "status": gate or "ok"}
    if gate is not None:
        return None, info
    reps: dict[str, list] = defaultdict(list)
    for idx in patient_bootstrap_indices(patients, n_boot=n_boot, seed=seed, strata=strata):
        for k, v in stat(idx).items():
            reps[k].append(v)
    return dict(reps), info


def attach_cis(entries: Mapping[str, dict], reps: Mapping[str, list] | None, info: dict) -> None:
    """Set ``ci``, ``ci_reason`` and ``ci_valid_replicates`` on each entry in place. A CI is
    reported only when the point estimate is defined; otherwise the reason is the metric's own
    ``undefined_reason``."""
    for name, entry in entries.items():
        if entry.get("value") is None:
            entry.update({"ci": None, "ci_reason": entry.get("undefined_reason") or "undefined",
                          "ci_valid_replicates": 0})
        elif reps is None:
            entry.update({"ci": None, "ci_reason": info["status"], "ci_valid_replicates": 0})
        else:
            entry.update(percentile_ci(reps.get(name, []), info["n_boot"]))


# --------------------------------------------------------------------------- point metrics at an operating point


def _rank_entry(name: str, y: np.ndarray, s: np.ndarray) -> dict:
    n_pos, n_neg = int(y.sum()), int(y.size - y.sum())
    if n_pos == 0 or n_neg == 0:
        out = {"value": None, "defined": False, "ci": None,
               "undefined_reason": f"undefined: needs both classes (positives={n_pos}, negatives={n_neg})"}
    else:
        v = auroc_fast(y, s) if name == "auroc" else average_precision_fast(y, s)
        out = {"value": float(v), "defined": True, "ci": None, "undefined_reason": None}
    if name == "auroc":
        out["method"] = "Mann–Whitney with average ranks for tied scores (equals sklearn roc_auc_score)"
    else:
        out["method"] = ("average precision, step-wise; tied scores form one operating point "
                         "(equals sklearn average_precision_score)")
        out["prevalence_baseline"] = (n_pos / y.size) if y.size else None
    out["threshold_dependent"] = False
    return out


def _stats_at(y: np.ndarray, s: np.ndarray, t: float, *, probabilistic: bool, u_pos: int = 0, u_neg: int = 0,
              prevalence: float | None = None) -> dict[str, float | None]:
    """All replicate-level statistics for one (resampled) set; ``None`` where undefined."""
    pred = s >= t
    pos = y == 1
    tp, fn = int((pred & pos).sum()), int((~pred & pos).sum())
    tn, fp = int((~pred & ~pos).sum()), int((pred & ~pos).sum())
    sens = tp / (tp + fn) if tp + fn else None
    spec = tn / (tn + fp) if tn + fp else None
    out: dict[str, float | None] = {
        "sensitivity": sens, "specificity": spec,
        "ppv": tp / (tp + fp) if tp + fp else None, "npv": tn / (tn + fn) if tn + fn else None,
        "auroc": auroc_fast(y, s), "auprc": average_precision_fast(y, s),
        "brier": float(np.mean((s - y) ** 2)) if (probabilistic and y.size) else None,
        "ite_sensitivity": tp / (tp + fn + u_pos) if tp + fn + u_pos else None,
        "ite_specificity": tn / (tn + fp + u_neg) if tn + fp + u_neg else None,
    }
    if prevalence is not None:
        out["ppv_adjusted"], out["npv_adjusted"] = _bayes_pv(sens, spec, prevalence)
    return out


def _evaluate_core(y: np.ndarray, s: np.ndarray, patients: list, t: float, *, uy: np.ndarray, up: list,
                   target_prevalence: float | None, n_boot: int, seed: int, min_patients: int, stratify: bool,
                   tuning_set: bool) -> dict:
    n = int(y.size)
    probabilistic = not (s.size and (s.min() < 0.0 or s.max() > 1.0))
    pred = (s >= t).astype(np.int64)
    c = confusion(y, pred)
    metrics = {k: ratio_metric(k, *v) for k, v in ratio_parts(c).items()}
    n_pos = int(y.sum())
    prevalence = n_pos / n if n else None
    for k in RATIO_METRICS:
        metrics[k].update({"threshold_dependent": True, "tuning_set": bool(tuning_set)})
    for k in ("ppv", "npv"):
        metrics[k]["evaluation_prevalence"] = prevalence
    metrics["auroc"] = _rank_entry("auroc", y, s)
    metrics["auprc"] = _rank_entry("auprc", y, s)
    metrics["brier"] = {
        "value": float(np.mean((s - y) ** 2)) if (n and probabilistic) else None, "ci": None,
        "undefined_reason": None if (n and probabilistic) else (
            "undefined: no scored items" if not n else "undefined: scores are not in [0, 1]"),
        "threshold_dependent": False}
    u_pos = int(uy.sum())
    u_neg = int(uy.size - u_pos)
    ite = {"sensitivity": ratio_metric("sensitivity", c["tp"], c["tp"] + c["fn"] + u_pos),
           "specificity": ratio_metric("specificity", c["tn"], c["tn"] + c["fp"] + u_neg)}
    adjusted = None
    if target_prevalence is not None:
        adjusted = prevalence_adjusted_predictive_values(metrics["sensitivity"]["value"],
                                                         metrics["specificity"]["value"], target_prevalence)
    # Intention-to-evaluate and prevalence-adjusted values are computed at the same threshold: they are optimistic
    # on the tuning split too, and say so like the scored-only metrics.
    for entry in (ite["sensitivity"], ite["specificity"], *((adjusted["ppv"], adjusted["npv"]) if adjusted else ())):
        entry.update({"threshold_dependent": True, "tuning_set": bool(tuning_set)})

    # One bootstrap over scored AND unscorable bags: patients carry all of their bags.
    all_y = np.r_[y, uy].astype(np.int64)
    all_s = np.r_[s, np.zeros(uy.size)]
    scorable = np.r_[np.ones(n, dtype=bool), np.zeros(uy.size, dtype=bool)]
    all_p = list(patients) + list(up)

    def stat(idx: np.ndarray) -> dict:
        sc, yy = scorable[idx], all_y[idx]
        unsc = yy[~sc]
        return _stats_at(yy[sc], all_s[idx][sc], t, probabilistic=probabilistic, u_pos=int(unsc.sum()),
                         u_neg=int(unsc.size - unsc.sum()), prevalence=target_prevalence)

    strata = patient_strata(all_y, all_p) if stratify else None
    reps, info = run_patient_bootstrap(stat, all_p, n_boot=n_boot, seed=seed, min_patients=min_patients,
                                       strata=strata)
    attach_cis({k: metrics[k] for k in (*RATIO_METRICS, *RANK_METRICS, "brier")}, reps, info)
    attach_cis({"ite_sensitivity": ite["sensitivity"], "ite_specificity": ite["specificity"]}, reps, info)
    if adjusted is not None:
        attach_cis({"ppv_adjusted": adjusted["ppv"], "npv_adjusted": adjusted["npv"]}, reps, info)
    return {"confusion": c, "metrics": metrics, "ite": ite, "adjusted": adjusted, "bootstrap": info,
            "prevalence": prevalence, "probabilistic": probabilistic, "u_pos": u_pos, "u_neg": u_neg}


def evaluate_binary(y, s, patients, *, threshold: float, unscorable_y=(), unscorable_patients=(),
                    target_prevalence: float | None = None, calibrated_scores=None, n_boot: int = 1000,
                    seed: int = 0, min_patients: int = 10, n_bins: int = 10, stratify_bootstrap: bool = False,
                    tuning_set: bool = False) -> dict:
    """Full evaluation body at a frozen operating point (design §7).

    ``y``, ``s`` and ``patients`` describe the SCORED bags. Unscorable bags (no tissue
    patches, failed extraction) are passed as ``unscorable_y`` / ``unscorable_patients``: they
    count in ``n_unscorable``, in the intention-to-evaluate sensitivity and specificity and in
    the bootstrap (a drawn patient brings all of its bags), never in the scored-only metrics.
    ``tuning_set=True`` marks every threshold-dependent metric as optimistic (the threshold was
    chosen on these data); threshold-free metrics are listed in ``threshold_free_metrics``.
    ``calibrated_scores`` (optional, same bags) adds a calibration report for them; the
    operating point always applies to ``s``."""
    y = binary_labels(y)
    s = finite_scores(s, y.size)
    patients = _patient_list(patients, y.size)
    uy = binary_labels(unscorable_y)
    up = _patient_list(unscorable_patients, uy.size)
    t = float(threshold)
    if not math.isfinite(t):
        raise ValueError("threshold must be finite")
    core = _evaluate_core(y, s, patients, t, uy=uy, up=up, target_prevalence=target_prevalence, n_boot=n_boot,
                          seed=seed, min_patients=min_patients, stratify=stratify_bootstrap, tuning_set=tuning_set)
    n, n_pos = int(y.size), int(y.sum())
    if core["probabilistic"]:
        raw = {"equal_width": calibration_report(y, s, n_bins=n_bins, strategy="uniform"),
               "equal_mass": calibration_report(y, s, n_bins=n_bins, strategy="quantile")}
        from .calibration import logistic_recalibration  # lazy: calibration imports this module

        raw["logistic_recalibration"] = logistic_recalibration(y, s)
    else:
        raw = {"status": "not_applicable", "reason": "scores are not in [0, 1]; calibration needs probabilities"}
    calibrated = None
    if calibrated_scores is not None:
        cs = finite_scores(calibrated_scores, n, what="calibrated_scores")
        _check_in_range(cs, 0.0, 1.0, "calibrated_scores")
        calibrated = {"equal_width": calibration_report(y, cs, n_bins=n_bins, strategy="uniform"),
                      "equal_mass": calibration_report(y, cs, n_bins=n_bins, strategy="quantile")}
    pos_patients = {p for p, v in zip(patients, y.tolist()) if v == 1}
    neg_patients = {p for p, v in zip(patients, y.tolist()) if v == 0}
    return {
        "schema": METRICS_SCHEMA,
        "n_items": n,
        "n_patients": len(set(patients) | set(up)),
        "n_scored_patients": len(set(patients)),
        "positives": n_pos,
        "negatives": n - n_pos,
        "positive_patients": len(pos_patients),
        "negative_patients": len(neg_patients),
        "n_unscorable": int(uy.size),
        "unscorable_positives": core["u_pos"],
        "unscorable_negatives": core["u_neg"],
        "evaluation_prevalence": {"value": core["prevalence"], "numerator": n_pos, "denominator": n,
                                  "unit": "scored bags", "note": PREVALENCE_NOTE},
        "operating_point": {"threshold": t, "comparison": COMPARISON_RULE, "tuning_set": bool(tuning_set),
                            "note": TUNING_SET_NOTE if tuning_set else None},
        "confusion": core["confusion"],
        "metrics": core["metrics"],
        "threshold_free_metrics": ["auroc", "auprc", "brier"],
        "intention_to_evaluate": {**core["ite"], "n_unscorable": int(uy.size), "rule": ITE_RULE},
        "prevalence_adjusted": core["adjusted"],
        "calibration": {"raw": raw, "calibrated": calibrated},
        "bootstrap": core["bootstrap"],
        "notes": [SCORE_NOTE, PREVALENCE_NOTE,
                  "CIs are percentile intervals from a patient-cluster bootstrap; with few patients they are "
                  "approximate and tend to be too narrow."],
    }


# --------------------------------------------------------------------------- calibration report


def calibration_report(y, s, *, n_bins: int = 10, strategy: str = "uniform") -> dict:
    """Reliability bins with counts, ECE, MCE and the Brier score, for scores in [0, 1].

    Bin edges and assignment follow sklearn's ``calibration_curve``. ``uniform`` (equal-width)
    uses ``n_bins`` equal edges on [0, 1]; ``quantile`` (equal-mass) uses percentiles of the
    scores, so bins hold about n / n_bins items (tied scores stay in one bin, so duplicate
    edges can leave empty bins; they are reported with ``n = 0``). An item goes to the first
    bin whose upper edge is ≥ its score: bins are (lo, hi], the first is [lo, hi].
    ECE = Σ_b (n_b / n)·|mean score_b − fraction positive_b|; MCE is the largest gap over
    non-empty bins. Both are biased upward with few items per bin."""
    y = binary_labels(y)
    s = finite_scores(s, y.size)
    _check_in_range(s, 0.0, 1.0)
    if strategy not in ("uniform", "quantile"):
        raise ValueError("strategy must be 'uniform' (equal-width) or 'quantile' (equal-mass)")
    if int(n_bins) < 1:
        raise ValueError("n_bins must be at least 1")
    n_bins, n = int(n_bins), int(y.size)
    base = {"strategy": strategy, "binning": "equal-width" if strategy == "uniform" else "equal-mass",
            "n_bins": n_bins, "n": n, "assignment": "(lo, hi]; the first bin is [lo, hi] (sklearn-compatible)",
            "note": SCORE_NOTE}
    if n == 0:
        return {**base, "bins": [], "ece": None, "mce": None, "brier": None, "n_empty_bins": n_bins,
                "undefined_reason": "undefined: no scored items"}
    # Exactly sklearn's grids (``linspace(0, 1, k+1)``; quantile edges ``percentile(s, linspace(0, 1, k+1) * 100)``):
    # ``linspace(0, 100, k+1)`` differs in the last bit, which moves a score sitting on an edge to another bin.
    edges = (np.linspace(0.0, 1.0, n_bins + 1) if strategy == "uniform"
             else np.percentile(s, np.linspace(0.0, 1.0, n_bins + 1) * 100))
    ids = np.searchsorted(edges[1:-1], s)
    cnt = np.bincount(ids, minlength=n_bins)
    ssum = np.bincount(ids, weights=s, minlength=n_bins)
    ysum = np.bincount(ids, weights=y.astype(np.float64), minlength=n_bins)
    bins, ece, mce = [], 0.0, 0.0
    for b in range(n_bins):
        k = int(cnt[b])
        if k:
            ms, fp = float(ssum[b] / k), float(ysum[b] / k)
            gap = abs(ms - fp)
            ece += k / n * gap
            mce = max(mce, gap)
        else:
            ms = fp = gap = None
        bins.append({"lo": float(edges[b]), "hi": float(edges[b + 1]), "n": k, "n_positive": int(round(ysum[b])),
                     "mean_score": ms, "fraction_positive": fp, "gap": gap})
    return {**base, "bins": bins, "ece": float(ece), "mce": float(mce), "brier": float(np.mean((s - y) ** 2)),
            "n_empty_bins": int((cnt == 0).sum()), "undefined_reason": None}


# --------------------------------------------------------------------------- operating threshold


def _evidence(y: np.ndarray, patients) -> dict:
    n_pos_b = int(y.sum())
    out = {"n_items": int(y.size), "positive_bags": n_pos_b, "negative_bags": int(y.size - n_pos_b)}
    if patients is None:
        return {**out, "unit": "bags", "positives": n_pos_b, "negatives": int(y.size - n_pos_b)}
    p = _patient_list(patients, y.size)
    pos = {pi for pi, yi in zip(p, y.tolist()) if yi == 1}
    neg = {pi for pi, yi in zip(p, y.tolist()) if yi == 0}
    return {**out, "unit": "patients", "positives": len(pos), "negatives": len(neg), "n_patients": len(set(p))}


def _rates_at(y: np.ndarray, s: np.ndarray, t: float) -> dict:
    pred = s >= t
    pos = y == 1
    tp, n_pos = int((pred & pos).sum()), int(pos.sum())
    tn, n_neg = int((~pred & ~pos).sum()), int((~pos).sum())
    return {"sensitivity": {"value": tp / n_pos if n_pos else None, "numerator": tp, "denominator": n_pos,
                            "exact_ci": exact_binomial_ci(tp, n_pos)},
            "specificity": {"value": tn / n_neg if n_neg else None, "numerator": tn, "denominator": n_neg,
                            "exact_ci": exact_binomial_ci(tn, n_neg)},
            "ci_method": "Clopper–Pearson exact, item-level (ignores clustering within patients)"}


def select_operating_threshold(y, s, *, rule: str, patients=None, target_sensitivity: float = 0.9,
                               fixed_value: float = 0.5, min_positives: int = THRESHOLD_MIN_POSITIVES,
                               min_negatives: int = THRESHOLD_MIN_NEGATIVES, fallback_value: float | None = 0.5,
                               selected_on: str = "val") -> dict:
    """Choose the operating threshold on DEVELOPMENT scores (val or out-of-fold) with a
    prespecified rule. Predicted positive: ``score >= value``; the value is an observed
    development score.

    * ``youden``: maximise sensitivity + specificity − 1 (ties: higher sensitivity, then the
      higher threshold).
    * ``target_sensitivity``: the highest threshold whose development sensitivity reaches the
      target. The target is met in-sample only; the exact lower bound is reported.
    * ``fixed``: ``fixed_value``, prespecified; no data are used (``selection_status:
      prespecified``).

    Minimum-evidence rule: a data-driven rule needs at least ``min_positives`` positive and
    ``min_negatives`` negative units, counted in PATIENTS when ``patients`` is given (else
    bags). Youden always needs one of each, target sensitivity one positive. Below that,
    ``selection_status`` is ``insufficient_evidence`` and ``fallback_value`` (or ``None``) is
    returned with the reason; any result at it is unvalidated.
    Development sensitivity/specificity at a selected threshold are optimistic
    (``tuning_set_note``)."""
    if rule not in THRESHOLD_RULES:
        raise ValueError(f"unknown threshold rule {rule!r}; use one of {', '.join(THRESHOLD_RULES)}")
    y = binary_labels(y)
    s = finite_scores(s, y.size)
    ev = _evidence(y, patients)
    base = {"schema": METRICS_SCHEMA, "requested_rule": rule, "selected_on": selected_on,
            "comparison": COMPARISON_RULE, "evidence": ev, "min_positives": int(min_positives),
            "min_negatives": int(min_negatives)}
    if rule == "target_sensitivity":
        if not 0.0 < float(target_sensitivity) <= 1.0:
            raise ValueError("target_sensitivity must lie in (0, 1]")
        base["target_sensitivity"] = float(target_sensitivity)
    if rule == "fixed":
        t = float(fixed_value)
        return {**base, "value": t, "rule": "fixed", "selection_status": "prespecified", "reason": None,
                "tuning_set_note": None, "at_threshold": _rates_at(y, s, t)}
    need_pos = max(int(min_positives), 1)
    need_neg = max(int(min_negatives), 1 if rule == "youden" else 0)
    short = []
    if ev["positives"] < need_pos:
        short.append(f"{ev['positives']} positive {ev['unit']} < {need_pos}")
    if ev["negatives"] < need_neg:
        short.append(f"{ev['negatives']} negative {ev['unit']} < {need_neg}")
    if short:
        fb = None if fallback_value is None else float(fallback_value)
        tail = (f"a fixed {fb} was frozen instead; treat any result at this threshold as unvalidated"
                if fb is not None else "no threshold was frozen")
        return {**base, "value": fb, "rule": "fixed_fallback" if fb is not None else None,
                "selection_status": "insufficient_evidence",
                "reason": f"{rule} was not selected: insufficient evidence ({'; '.join(short)}); {tail}.",
                "tuning_set_note": None, "at_threshold": _rates_at(y, s, fb) if fb is not None else None}
    cands = np.unique(s)[::-1]  # descending
    pos_sorted, neg_sorted = np.sort(s[y == 1]), np.sort(s[y == 0])
    n_pos, n_neg = pos_sorted.size, neg_sorted.size
    sens = (n_pos - np.searchsorted(pos_sorted, cands, side="left")) / n_pos
    out = {**base, "rule": rule, "selection_status": "selected", "reason": None, "tuning_set_note": TUNING_SET_NOTE}
    if rule == "youden":
        spec = np.searchsorted(neg_sorted, cands, side="left") / n_neg
        j = sens + spec - 1.0
        best = int(np.lexsort((cands, sens, np.round(j, 12)))[-1])
        out["youden_j"] = float(j[best])
    else:
        best = int(np.flatnonzero(sens >= float(target_sensitivity))[0])  # sens reaches 1 at the lowest score
    t = float(cands[best])
    return {**out, "value": t, "at_threshold": _rates_at(y, s, t)}


# --------------------------------------------------------------------------- risk–coverage and abstention


def relative_margin(s, threshold: float, *, score_range=(0.0, 1.0)) -> np.ndarray:
    """Distance from the threshold as a fraction of the room on that side (see
    :data:`MARGIN_DEFINITION`). With threshold 0.5 on [0, 1] it orders items like
    ``max(p, 1 − p)``; with other thresholds it stays comparable on both sides. Rounded to
    :data:`MARGIN_DECIMALS` decimals."""
    lo, hi = _score_range(score_range)
    s = finite_scores(s)
    t = float(threshold)
    if not lo <= t <= hi:
        raise ValueError(f"threshold {t} lies outside the score range [{lo}, {hi}]")
    _check_in_range(s, lo, hi)
    out = np.zeros(s.size, dtype=np.float64)
    up = s >= t
    if hi > t:
        out[up] = (s[up] - t) / (hi - t)
    if t > lo:
        out[~up] = (t - s[~up]) / (t - lo)
    # Round away float noise so scores symmetric about the threshold (0.45 and 0.55 around 0.5)
    # form one tie group everywhere margins are compared.
    return np.round(out, MARGIN_DECIMALS)


def risk_coverage_curve(y, s, threshold: float, *, score_range=(0.0, 1.0)) -> dict:
    """Selective risk against coverage when the least confident items are deferred first
    (confidence = relative margin). Tied margins are kept or deferred together, so the curve is
    invariant to item order. AURC is the area under the step curve (Σ Δcoverage × risk; without
    ties it equals the mean selective risk over k = 1..n). ``aurc_oracle`` ranks every error
    last; ``excess_aurc`` = AURC − oracle. Per class: ``risk_positive`` is the missed fraction
    among kept positives, ``risk_negative`` the flagged fraction among kept negatives."""
    lo, hi = _score_range(score_range)
    y = binary_labels(y)
    s = finite_scores(s, y.size)
    t = float(threshold)
    m = relative_margin(s, t, score_range=(lo, hi))
    n = int(y.size)
    base = {"schema": METRICS_SCHEMA, "threshold": t, "comparison": COMPARISON_RULE, "confidence": MARGIN_DEFINITION,
            "score_range": [lo, hi], "n": n, "note": ABSTENTION_NOTE}
    if n == 0:
        return {**base, "rows": [], "aurc": None, "aurc_oracle": None, "excess_aurc": None,
                "full_coverage_risk": None, "undefined_reason": "undefined: no scored items"}
    pred = s >= t
    pos = y == 1
    err = pred != pos
    order = np.argsort(-m, kind="mergesort")
    ms = m[order]
    ends = np.r_[np.flatnonzero(np.diff(ms) != 0), n - 1]
    err_c = np.cumsum(err[order])
    pos_c = np.cumsum(pos[order])
    fn_c = np.cumsum((pos & ~pred)[order])
    fp_c = np.cumsum((~pos & pred)[order])
    n_pos, n_neg = int(pos.sum()), int(n - pos.sum())
    rows, aurc, prev_cov = [], 0.0, 0.0
    for e in ends:
        k = int(e + 1)
        kp = int(pos_c[e])
        kn = k - kp
        cov, risk = k / n, float(err_c[e] / k)
        rows.append({"coverage": cov, "n_kept": k, "n_abstained": n - k, "min_margin_kept": float(ms[e]),
                     "selective_risk": risk, "kept_positives": kp, "kept_negatives": kn,
                     "coverage_positive": kp / n_pos if n_pos else None,
                     "coverage_negative": kn / n_neg if n_neg else None,
                     "risk_positive": float(fn_c[e] / kp) if kp else None,
                     "risk_negative": float(fp_c[e] / kn) if kn else None})
        aurc += (cov - prev_cov) * risk
        prev_cov = cov
    n_err = int(err.sum())
    k = np.arange(1, n + 1)
    oracle = float(np.mean(np.maximum(0, k - (n - n_err)) / k))
    return {**base, "rows": rows, "aurc": float(aurc), "aurc_oracle": oracle, "excess_aurc": float(aurc - oracle),
            "full_coverage_risk": n_err / n, "undefined_reason": None}


def _freeze_policy(policy: dict) -> dict:
    body = {k: v for k, v in policy.items() if k != "policy_sha256"}
    body["frozen"] = True
    return {**body, "policy_sha256": canonical_sha256(body)}


def no_abstention_policy(threshold: float, *, score_range=(0.0, 1.0), reason: str | None = None) -> dict:
    """Frozen policy that never abstains (``abstention: none``)."""
    lo, hi = _score_range(score_range)
    t = float(threshold)
    return _freeze_policy({"schema": ABSTENTION_SCHEMA, "kind": "none", "threshold": t, "score_range": [lo, hi],
                           "margin": 0.0, "lower": t, "upper": t, "abstain_if": "never",
                           "selection_status": "prespecified", "reason": reason, "note": ABSTENTION_NOTE})


def _selective_counts(y: np.ndarray, s: np.ndarray, t: float, abstained: np.ndarray) -> dict:
    kept = ~abstained
    pred = s >= t
    pos = y == 1
    n, n_pos = int(y.size), int(pos.sum())
    kp, kn = int((kept & pos).sum()), int((kept & ~pos).sum())
    n_kept = int(kept.sum())
    return {"n": n, "n_kept": n_kept, "n_abstained": n - n_kept,
            "coverage": n_kept / n if n else None,
            "coverage_positive": kp / n_pos if n_pos else None,
            "coverage_negative": kn / (n - n_pos) if n - n_pos else None,
            "selective_risk": float(((pred != pos) & kept).sum() / n_kept) if n_kept else None,
            "risk_positive": float((kept & pos & ~pred).sum() / kp) if kp else None,
            "risk_negative": float((kept & ~pos & pred).sum() / kn) if kn else None,
            "full_coverage_risk": float((pred != pos).sum() / n) if n else None}


def select_abstention_policy(y, s, threshold: float, *, target_coverage: float | None = None,
                             max_risk: float | None = None, score_range=(0.0, 1.0), min_items: int = 20,
                             selected_on: str = "development") -> dict:
    """Choose an abstention band around the frozen threshold on DEVELOPMENT scores and freeze it.

    Items whose relative margin is below ``margin`` are deferred; in score units that is
    ``lower < score < upper``. Exactly one criterion:

    * ``target_coverage``: the widest band whose development coverage stays ≥ the target;
    * ``max_risk``: the narrowest band whose development selective risk is ≤ ``max_risk``
      (``selection_status: infeasible`` and no abstention when even the most confident tie
      group exceeds it).

    The band edge sits midway between the last deferred and the first kept margin. Fewer than
    ``min_items`` development items give ``insufficient_evidence`` and no abstention. The policy
    is returned frozen (``policy_sha256``); :func:`apply_abstention` refuses a modified one.
    See :data:`ABSTENTION_NOTE`: confidence is not an out-of-distribution detector."""
    if (target_coverage is None) == (max_risk is None):
        raise ValueError("give exactly one of target_coverage or max_risk")
    if target_coverage is not None and not 0.0 < float(target_coverage) <= 1.0:
        raise ValueError("target_coverage must lie in (0, 1]")
    if max_risk is not None and not 0.0 <= float(max_risk) < 1.0:
        raise ValueError("max_risk must lie in [0, 1)")
    lo, hi = _score_range(score_range)
    y = binary_labels(y)
    s = finite_scores(s, y.size)
    t = float(threshold)
    m = relative_margin(s, t, score_range=(lo, hi))
    criterion = ({"rule": "target_coverage", "target_coverage": float(target_coverage)} if target_coverage is not None
                 else {"rule": "max_risk", "max_risk": float(max_risk)})
    base = {"schema": ABSTENTION_SCHEMA, "kind": "threshold_band", "threshold": t, "score_range": [lo, hi],
            "margin_definition": MARGIN_DEFINITION, "abstain_if": "lower < score < upper",
            "selected_on": selected_on, **criterion, "min_items": int(min_items), "note": ABSTENTION_NOTE}

    def finish(margin: float, status: str, reason: str | None) -> dict:
        lower, upper = t - margin * (t - lo), t + margin * (hi - t)
        policy = _freeze_policy({**base, "margin": float(margin), "lower": float(lower), "upper": float(upper),
                                 "selection_status": status, "reason": reason, "development": None})
        dev = _selective_counts(y, s, t, apply_abstention(s, policy))
        return _freeze_policy({**policy, "development": dev})

    if y.size < int(min_items):
        return finish(0.0, "insufficient_evidence",
                      f"insufficient evidence: {y.size} development item(s) < {int(min_items)}; no abstention")
    err = (s >= t) != (y == 1)
    order = np.argsort(m, kind="mergesort")
    ms = m[order]
    err_suffix = np.r_[np.cumsum(err[order][::-1])[::-1], 0]  # errors among items order[i:]
    u = np.unique(ms)  # ascending; deferring j tie groups keeps the items with margin >= u[j]
    start = np.searchsorted(ms, u, side="left")
    n_kept = y.size - start
    coverage = n_kept / y.size  # non-increasing in j; coverage[0] == 1
    risk = err_suffix[start] / n_kept
    if target_coverage is not None:
        j_best: int | None = int(np.flatnonzero(coverage >= float(target_coverage)).max())
    else:
        ok = np.flatnonzero(risk <= float(max_risk))
        j_best = int(ok.min()) if ok.size else None
    if j_best is None:
        return finish(0.0, "infeasible", f"no band reaches development selective risk ≤ {float(max_risk)}; "
                                         "no abstention")
    margin = 0.0 if j_best == 0 else float((u[j_best - 1] + u[j_best]) / 2.0)
    return finish(margin, "selected", None)


def apply_abstention(scores, policy: Mapping) -> np.ndarray:
    """Boolean mask of deferred items under a frozen policy (refuses a modified policy)."""
    if policy.get("schema") != ABSTENTION_SCHEMA:
        raise ValueError(f"not an abstention policy of schema {ABSTENTION_SCHEMA}")
    body = {k: v for k, v in policy.items() if k != "policy_sha256"}
    if not policy.get("frozen") or policy.get("policy_sha256") != canonical_sha256(body):
        raise ValueError("abstention policy is not frozen or was modified after it was frozen")
    s = finite_scores(scores)
    if policy["kind"] == "none":
        return np.zeros(s.size, dtype=bool)
    if policy["kind"] != "threshold_band":
        raise ValueError(f"unknown abstention policy kind {policy['kind']!r}")
    return (s > float(policy["lower"])) & (s < float(policy["upper"]))


def selective_evaluation(y, s, policy: Mapping, *, patients=None, n_boot: int = 0, seed: int = 0,
                         min_patients: int = 10) -> dict:
    """Apply a frozen abstention policy to an evaluation set: coverage (overall and per
    class), selective risk overall and per class, and selective sensitivity/specificity, each
    with numerator and denominator; patient-cluster CIs when ``patients`` and ``n_boot`` are
    given."""
    y = binary_labels(y)
    s = finite_scores(s, y.size)
    abstained = apply_abstention(s, policy)
    t = float(policy["threshold"])
    pred = s >= t
    pos = y == 1
    kept = ~abstained
    kp, kn = kept & pos, kept & ~pos
    entries = {
        "coverage": _ratio(int(kept.sum()), int(y.size), "undefined: no items"),
        "coverage_positive": _ratio(int(kp.sum()), int(pos.sum()), "undefined: no positive items"),
        "coverage_negative": _ratio(int(kn.sum()), int((~pos).sum()), "undefined: no negative items"),
        "selective_risk": _ratio(int(((pred != pos) & kept).sum()), int(kept.sum()), "undefined: every item deferred"),
        "selective_sensitivity": _ratio(int((kp & pred).sum()), int(kp.sum()), "undefined: no kept positive items"),
        "selective_specificity": _ratio(int((kn & ~pred).sum()), int(kn.sum()), "undefined: no kept negative items"),
    }
    reps, info = None, {"n_boot": 0, "status": "no patients given; no CIs"}
    if patients is not None:
        p = _patient_list(patients, y.size)

        def stat(idx: np.ndarray) -> dict:
            kk, pp, pr = kept[idx], pos[idx], pred[idx]

            def r(num, den):
                return float(num / den) if den else None

            return {"coverage": r(kk.sum(), kk.size), "coverage_positive": r((kk & pp).sum(), pp.sum()),
                    "coverage_negative": r((kk & ~pp).sum(), (~pp).sum()),
                    "selective_risk": r(((pr != pp) & kk).sum(), kk.sum()),
                    "selective_sensitivity": r((kk & pp & pr).sum(), (kk & pp).sum()),
                    "selective_specificity": r((kk & ~pp & ~pr).sum(), (kk & ~pp).sum())}

        reps, info = run_patient_bootstrap(stat, p, n_boot=n_boot, seed=seed, min_patients=min_patients)
    attach_cis(entries, reps, info)
    return {"schema": METRICS_SCHEMA, "policy_sha256": policy["policy_sha256"], "threshold": t,
            "n": int(y.size), "n_abstained": int(abstained.sum()),
            "abstained_positives": int((abstained & pos).sum()), "abstained_negatives": int((abstained & ~pos).sum()),
            **entries, "bootstrap": info, "note": ABSTENTION_NOTE}


# --------------------------------------------------------------------------- subgroups


def subgroup_analysis(y, s, patients, attrs: Sequence[Mapping | None], *, threshold: float,
                      keys: Sequence[str] = SUBGROUP_KEYS, min_patients: int = 10, n_boot: int = 1000, seed: int = 0,
                      stratify_bootstrap: bool = False, tuning_set: bool = False) -> dict:
    """Metrics per subgroup (scanner, site, stain, stain batch) at the frozen threshold.

    ``min_patients`` counts PATIENTS, not bags: below it the subgroup is
    ``insufficient_evidence`` with no metrics. Otherwise the subgroup gets the scored-only
    metrics of :func:`evaluate_binary` with a patient-cluster bootstrap over the subgroup's own
    patients (same seed for every subgroup). A key that no item records is ``not_recorded``.
    ``tuning_set=True`` (the threshold was chosen on these data) flags every subgroup's
    threshold-dependent metrics as optimistic, like the body's own."""
    y = binary_labels(y)
    s = finite_scores(s, y.size)
    patients = _patient_list(patients, y.size)
    attrs = list(attrs)
    if len(attrs) != y.size:
        raise ValueError(f"attrs has {len(attrs)} entries for {y.size} item(s)")
    t = float(threshold)
    rows = []
    for key in keys:
        if not any(key in (a or {}) for a in attrs):
            rows.append({"key": key, "value": None, "status": "not_recorded", "metrics": None, "confusion": None,
                         "reason": f"no item records '{key}'"})
            continue
        groups: dict[str, list[int]] = defaultdict(list)
        for i, a in enumerate(attrs):
            v = (a or {}).get(key)
            groups["unknown" if v in (None, "") else str(v)].append(i)
        for value in sorted(groups):
            idx = np.asarray(groups[value], dtype=np.int64)
            sp = [patients[i] for i in idx.tolist()]
            yy = y[idx]
            row = {"key": key, "value": value, "n_bags": int(idx.size), "n_patients": len(set(sp)),
                   "positive_bags": int(yy.sum()), "negative_bags": int(yy.size - yy.sum()),
                   "positive_patients": len({p for p, v in zip(sp, yy.tolist()) if v == 1}),
                   "negative_patients": len({p for p, v in zip(sp, yy.tolist()) if v == 0}),
                   "min_patients": int(min_patients)}
            if row["n_patients"] < int(min_patients):
                row.update({"status": "insufficient_evidence", "metrics": None, "confusion": None,
                            "reason": f"insufficient evidence: {row['n_patients']} patient(s) < {int(min_patients)}"})
            else:
                core = _evaluate_core(yy, s[idx], sp, t, uy=np.empty(0, dtype=np.int64), up=[],
                                      target_prevalence=None, n_boot=n_boot, seed=seed, min_patients=min_patients,
                                      stratify=stratify_bootstrap, tuning_set=tuning_set)
                row.update({"status": "ok", "metrics": core["metrics"], "confusion": core["confusion"],
                            "reason": None, "bootstrap": core["bootstrap"]})
            rows.append(row)
    return {"schema": METRICS_SCHEMA, "threshold": t, "count_unit": "patients", "min_patients": int(min_patients),
            "rows": rows, "note": SUBGROUP_NOTE}
