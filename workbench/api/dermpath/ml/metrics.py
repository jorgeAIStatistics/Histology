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
"""

from __future__ import annotations

import math
from collections import defaultdict

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
    """Abstain on the items closest to the threshold first; report the error among the rest."""
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
    """Choose an operating threshold on VALIDATION scores. Predicted positive: score >= value."""
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
