"""Paired comparison of two or more models on the IDENTICAL bag and patient set (design §7).
Pure functions, no DB.

* **Identity is verified, never assumed.** Every score set must cover exactly the same bag
  ids, each bag with the same patient and the same reference label (and the same dataset
  manifest and split fingerprint when given). Anything else raises
  :class:`ComparisonRefused`; nothing is silently intersected.
* **Patient-level paired bootstrap with one shared seed.** Each replicate draws patients with
  replacement (every bag of a drawn patient enters together) ONCE, and every model is scored
  on that same replicate, so the deltas are paired. Deltas (a − b) for AUROC, AUPRC,
  sensitivity and specificity (each model at its own frozen threshold) and Brier, with
  percentile CIs and the fraction of replicates favouring each model.
* **Exact McNemar** at the operating points (all bags, positives only, negatives only).
  Bags are treated as independent here, so with several bags per patient the p-value is
  approximate; the paired bootstrap CIs are the clustered evidence.
* **No winner is declared.** Every pair is reported; with several models the pairwise
  results are a family of comparisons (:data:`MULTIPLE_COMPARISON_NOTE`). Selection is made
  by people on validation or out-of-fold comparisons, never on test.
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass
from fractions import Fraction
from itertools import combinations

import numpy as np

from .metrics import (
    BOOT_INTERVAL,
    BOOT_MIN_VALID_FRACTION,
    COMPARISON_RULE,
    average_precision_fast,
    auroc_fast,
    binary_labels,
    bootstrap_gate,
    canonical_sha256,
    finite_scores,
    patient_bootstrap_indices,
    patient_strata,
    percentile_ci,
)

COMPARISON_SCHEMA = "dermpath.comparison/1"
DELTA_METRICS = ("auroc", "auprc", "sensitivity", "specificity", "brier")
HIGHER_IS_BETTER = {"auroc": True, "auprc": True, "sensitivity": True, "specificity": True, "brier": False}
EXACT_MCNEMAR_MAX_N = 5000  # discordant pairs; above this the binomial tail comes from scipy
MULTIPLE_COMPARISON_NOTE = (
    "All pairs are reported. With more than two models these are several comparisons on the same data: the per-pair "
    "CIs and p-values are unadjusted (Holm-adjusted McNemar p-values are given for reference), and the chance that "
    "at least one pair looks different by chance grows with the number of pairs. No winner is declared "
    "automatically; selection is a human decision made on validation or out-of-fold comparisons, never on test.")
MCNEMAR_NOTE = ("Exact McNemar (two-sided binomial test on discordant bags). Bags are treated as independent; with "
                "several bags per patient the p-value is approximate.")


class ComparisonRefused(ValueError):
    """The score sets are not on the identical bag and patient set (or are otherwise unusable)."""

    def __init__(self, code: str, detail: str):
        super().__init__(f"{code}: {detail}")
        self.code = code
        self.detail = detail


@dataclass(frozen=True)
class ScoreSet:
    """One model's frozen scores on an evaluation set. ``threshold`` is the model's own frozen
    operating threshold (positive if score >= threshold)."""

    name: str
    bag_ids: Sequence[str]
    patients: Sequence[str]
    labels: Sequence[int]
    scores: Sequence[float]
    threshold: float
    manifest_sha256: str | None = None
    split_fingerprint: str | None = None


def exact_mcnemar(b: int, c: int) -> dict:
    """Exact two-sided McNemar test on ``b`` and ``c`` discordant pairs:
    ``p = min(1, 2 · P(X ≤ min(b, c)))`` with ``X ~ Binomial(b + c, 1/2)``; ``p = 1`` when
    there are no discordant pairs. Integer arithmetic up to :data:`EXACT_MCNEMAR_MAX_N`."""
    b, c = int(b), int(c)
    n, k = b + c, min(b, c)
    if n == 0:
        return {"b": b, "c": c, "n_discordant": 0, "p_value": 1.0, "method": "exact binomial",
                "note": "no discordant bags"}
    if n <= EXACT_MCNEMAR_MAX_N:
        term, total = 1, 1  # C(n, 0); C(n, i + 1) = C(n, i)·(n − i)/(i + 1), exact in integers
        for i in range(k):
            term = term * (n - i) // (i + 1)
            total += term
        tail = Fraction(total, 2 ** n)
        p = float(min(Fraction(1), 2 * tail))
        method = "exact binomial (integer arithmetic)"
    else:
        from scipy.stats import binom  # lazy

        p = float(min(1.0, 2.0 * binom.cdf(k, n, 0.5)))
        method = "exact binomial (scipy)"
    return {"b": b, "c": c, "n_discordant": n, "p_value": p, "method": method, "note": None}


def holm_adjust(p_values: Sequence[float]) -> list[float]:
    """Holm step-down adjusted p-values (same order as given)."""
    m = len(p_values)
    order = sorted(range(m), key=lambda i: (p_values[i], i))
    out = [0.0] * m
    running = 0.0
    for rank, i in enumerate(order):
        running = max(running, min(1.0, (m - rank) * float(p_values[i])))
        out[i] = running
    return out


def _align(score_sets: Sequence[ScoreSet]) -> tuple[list[str], list, np.ndarray, list[np.ndarray], dict]:
    """Verify identity and return (bag ids, patients, labels, scores per model, identity)."""
    if len(score_sets) < 2:
        raise ComparisonRefused("too_few_models", "a paired comparison needs at least two score sets")
    names = [ss.name for ss in score_sets]
    if len(set(names)) != len(names):
        raise ComparisonRefused("duplicate_names", f"score set names must be unique; got {names}")
    for attr in ("manifest_sha256", "split_fingerprint"):
        by_name = {ss.name: getattr(ss, attr) for ss in score_sets}
        if len(set(by_name.values())) > 1:
            raise ComparisonRefused(f"{attr}_mismatch", f"the score sets disagree on {attr}: {by_name}")
    ref: dict | None = None
    ref_name = names[0]
    aligned_scores = []
    for ss in score_sets:
        bag_ids = [str(b) for b in ss.bag_ids]
        n = len(bag_ids)
        if len(set(bag_ids)) != n:
            raise ComparisonRefused("duplicate_bags", f"{ss.name} lists a bag more than once")
        if not (len(ss.patients) == len(ss.labels) == len(ss.scores) == n):
            raise ComparisonRefused("length_mismatch", f"{ss.name}: bag_ids, patients, labels and scores differ in "
                                                       "length")
        try:
            y = binary_labels(ss.labels)
            s = finite_scores(ss.scores, n)
        except ValueError as exc:
            raise ComparisonRefused("invalid_scores", f"{ss.name}: {exc}") from exc
        if not math.isfinite(float(ss.threshold)):
            raise ComparisonRefused("invalid_threshold", f"{ss.name}: the threshold must be finite")
        rows = {b: (str(p), int(v), float(x)) for b, p, v, x in zip(bag_ids, ss.patients, y.tolist(), s.tolist())}
        if ref is None:
            ref = rows
        else:
            missing, extra = sorted(set(ref) - set(rows)), sorted(set(rows) - set(ref))
            if missing or extra:
                raise ComparisonRefused("bag_set_mismatch",
                                        f"{ss.name} vs {ref_name}: {len(missing)} bag(s) missing, {len(extra)} extra "
                                        f"(e.g. missing {missing[:3]}, extra {extra[:3]})")
            bad_p = sorted(b for b in rows if rows[b][0] != ref[b][0])
            if bad_p:
                raise ComparisonRefused("patient_mismatch", f"{ss.name} vs {ref_name}: {len(bad_p)} bag(s) belong to "
                                                            f"a different patient, e.g. {bad_p[:3]}")
            bad_y = sorted(b for b in rows if rows[b][1] != ref[b][1])
            if bad_y:
                raise ComparisonRefused("label_mismatch", f"{ss.name} vs {ref_name}: {len(bad_y)} bag(s) carry a "
                                                          f"different reference label, e.g. {bad_y[:3]}")
        aligned_scores.append(rows)
    bag_order = sorted(ref)  # content-stable order
    patients = [ref[b][0] for b in bag_order]
    y = np.asarray([ref[b][1] for b in bag_order], dtype=np.int64)
    scores = [np.asarray([rows[b][2] for b in bag_order], dtype=np.float64) for rows in aligned_scores]
    identity = {"bag_set_sha256": canonical_sha256([[b, ref[b][0], ref[b][1]] for b in bag_order]),
                "manifest_sha256": score_sets[0].manifest_sha256,
                "split_fingerprint": score_sets[0].split_fingerprint,
                "verified": "identical bag ids; identical patient and reference label per bag"}
    return bag_order, patients, y, scores, identity


def _model_stats(y: np.ndarray, s: np.ndarray, t: float) -> dict[str, float | None]:
    pred = s >= t
    pos = y == 1
    n_pos, n_neg = int(pos.sum()), int((~pos).sum())
    probabilistic = not (s.size and (s.min() < 0.0 or s.max() > 1.0))
    return {"auroc": auroc_fast(y, s), "auprc": average_precision_fast(y, s),
            "sensitivity": float((pred & pos).sum() / n_pos) if n_pos else None,
            "specificity": float((~pred & ~pos).sum() / n_neg) if n_neg else None,
            "brier": float(np.mean((s - y) ** 2)) if (y.size and probabilistic) else None}


def _delta(a: float | None, b: float | None) -> float | None:
    return None if a is None or b is None else float(a - b)


def paired_comparison(score_sets: Sequence[ScoreSet], *, n_boot: int = 2000, seed: int = 0, min_patients: int = 10,
                      stratify_bootstrap: bool = False, keep_replicates: bool = False) -> dict:
    """Compare every pair of score sets on the identical bag/patient set (see module docstring).

    ``seed`` is the family's shared seed: all models and all pairs use the same replicates.
    ``keep_replicates`` adds the raw replicate deltas per pair (``None`` where undefined).
    Raises :class:`ComparisonRefused` when the sets are not identical."""
    bag_order, patients, y, scores, identity = _align(score_sets)
    names = [ss.name for ss in score_sets]
    thresholds = [float(ss.threshold) for ss in score_sets]
    preds = [s >= t for s, t in zip(scores, thresholds)]
    per_model = {}
    for name, s, t in zip(names, scores, thresholds):
        st = _model_stats(y, s, t)
        per_model[name] = {"threshold": t, "comparison": COMPARISON_RULE, **st}

    n_patients = len(set(patients))
    gate = bootstrap_gate(n_boot, n_patients, min_patients)
    strata = patient_strata(y, patients) if stratify_bootstrap else None
    boot_info = {"method": "patient_paired",
                 "resampling_unit": "patient: every bag of a drawn patient enters the replicate together; the same "
                                    "replicate is used for every model",
                 "stratified": strata is not None, "n_boot": int(n_boot), "seed": int(seed),
                 "n_patients": n_patients, "min_patients": int(min_patients), "interval": BOOT_INTERVAL,
                 "min_valid_fraction": BOOT_MIN_VALID_FRACTION, "status": gate or "ok"}
    pairs = list(combinations(range(len(names)), 2))
    reps: dict[tuple[int, int], dict[str, list]] = {pr: {m: [] for m in DELTA_METRICS} for pr in pairs}
    if gate is None:
        for idx in patient_bootstrap_indices(patients, n_boot=n_boot, seed=seed, strata=strata):
            yy = y[idx]
            st = [_model_stats(yy, s[idx], t) for s, t in zip(scores, thresholds)]
            for i, j in pairs:
                for m in DELTA_METRICS:
                    reps[(i, j)][m].append(_delta(st[i][m], st[j][m]))

    out_pairs = []
    for i, j in pairs:
        a, b = names[i], names[j]
        deltas = {}
        for m in DELTA_METRICS:
            value = _delta(per_model[a][m], per_model[b][m])
            entry: dict = {"value": value, "better": "higher" if HIGHER_IS_BETTER[m] else "lower",
                           "undefined_reason": None if value is not None else
                           f"undefined: {m} is undefined for at least one model on this set"}
            vals = [v for v in reps[(i, j)][m] if v is not None]
            if value is None:
                entry.update({"ci": None, "ci_reason": entry["undefined_reason"], "ci_valid_replicates": 0})
            elif gate is not None:
                entry.update({"ci": None, "ci_reason": gate, "ci_valid_replicates": 0})
            else:
                entry.update(percentile_ci(reps[(i, j)][m], int(n_boot)))
            if vals:
                arr = np.asarray(vals, dtype=np.float64)
                sign = 1.0 if HIGHER_IS_BETTER[m] else -1.0
                entry["fraction_favouring"] = {a: float(np.mean(sign * arr > 0)), b: float(np.mean(sign * arr < 0))}
                entry["fraction_tied"] = float(np.mean(arr == 0))
            else:
                entry["fraction_favouring"] = None
                entry["fraction_tied"] = None
            deltas[m] = entry
        correct_a, correct_b = preds[i] == (y == 1), preds[j] == (y == 1)
        mcn = {}
        for part, mask in (("all", np.ones(y.size, dtype=bool)), ("positives", y == 1), ("negatives", y == 0)):
            res = exact_mcnemar(int((correct_a & ~correct_b & mask).sum()), int((~correct_a & correct_b & mask).sum()))
            mcn[part] = {**res, "n_bags": int(mask.sum()),
                         "b_meaning": f"{a} correct, {b} wrong", "c_meaning": f"{a} wrong, {b} correct"}
        pair = {"a": a, "b": b, "delta": "a - b", "deltas": deltas, "mcnemar": mcn}
        if keep_replicates:
            pair["replicates"] = {m: list(reps[(i, j)][m]) for m in DELTA_METRICS}
        out_pairs.append(pair)
    holm = holm_adjust([p["mcnemar"]["all"]["p_value"] for p in out_pairs])
    for p, h in zip(out_pairs, holm):
        p["mcnemar"]["all"]["p_value_holm"] = h

    return {
        "schema": COMPARISON_SCHEMA,
        "models": names,
        "n_bags": int(y.size),
        "n_patients": n_patients,
        "positives": int(y.sum()),
        "negatives": int(y.size - y.sum()),
        "identity": identity,
        "per_model": per_model,
        "pairs": out_pairs,
        "bootstrap": boot_info,
        "mcnemar_note": MCNEMAR_NOTE,
        "multiple_comparisons": {"n_models": len(names), "n_pairs": len(pairs), "adjustment": "none (Holm shown "
                                 "for McNemar)", "note": MULTIPLE_COMPARISON_NOTE},
        "winner": None,
    }
