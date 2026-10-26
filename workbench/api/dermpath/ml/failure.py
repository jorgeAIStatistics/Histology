"""Failure-analysis taxonomy over error records (design §7). Pure functions, no DB.

Every misclassified bag gets zero or more categories (non-exclusive). Categories are POSSIBLE
contributing factors read from recorded context; they are never causal claims.

* ``near_threshold``: relative margin below ``near_threshold_margin`` (the score sits close to
  the frozen threshold; see :data:`dermpath.ml.metrics.MARGIN_DEFINITION`).
* ``confident_error``: relative margin at or above ``confident_margin``.
* ``artifact_associated``: a QC issue is recorded on the bag's slide(s).
* ``small_lesion``: a missed positive whose EXPERT OUTLINE gives a lesion area below
  ``small_lesion_max_area_um2``. Without an outline the error is "not assessable", never
  guessed from the model or from attention.
* ``possible_label_error``: a confident error with a reader disagreement on record. It flags
  the reference label for adjudication; it does not change it.
* ``domain_shift``: the bag's scanner or site was not seen in the training data.
* ``mimic_category``: a false positive whose negative reference label carries a category
  (for example a named mimic of the positive finding).

Wording rule: classes are rendered with their own label text. The negative class (for
example "BCC absent") means only that the positive finding was not identified in the
reference; it is never rendered as "benign" or as any other diagnosis.
"""

from __future__ import annotations

import math
from collections import Counter
from collections.abc import Iterable, Mapping
from dataclasses import asdict, dataclass

from .metrics import relative_margin

FAILURE_SCHEMA = "dermpath.failure_taxonomy/1"
CATEGORIES = ("near_threshold", "confident_error", "artifact_associated", "small_lesion", "possible_label_error",
              "domain_shift", "mimic_category")
ERROR_TYPES = ("false_negative", "false_positive")


@dataclass(frozen=True)
class FailurePolicy:
    """Research defaults, recorded with every result; not clinical cut-offs."""

    near_threshold_margin: float = 0.2
    confident_margin: float = 0.6
    small_lesion_max_area_um2: float = 250_000.0  # 0.25 mm²
    score_range: tuple[float, float] = (0.0, 1.0)

    def validate(self) -> None:
        if not 0.0 < self.near_threshold_margin <= self.confident_margin <= 1.0:
            raise ValueError("need 0 < near_threshold_margin <= confident_margin <= 1")
        if not self.small_lesion_max_area_um2 > 0:
            raise ValueError("small_lesion_max_area_um2 must be positive")

    def to_dict(self) -> dict:
        d = asdict(self)
        d["score_range"] = [float(v) for v in self.score_range]
        return d


def _issue_names(issues: Iterable) -> list[str]:
    names = []
    for it in issues:
        if isinstance(it, Mapping):
            names.append(str(it.get("category") or it.get("kind") or it.get("id") or "qc issue"))
        else:
            names.append(str(it))
    return sorted(set(names))


def failure_taxonomy(records: Iterable[Mapping], contexts: Mapping[str, Mapping] | None = None, *,
                     positive_class: str, negative_class: str, train_domain: Mapping | None = None,
                     policy: FailurePolicy = FailurePolicy()) -> dict:
    """Categorise the errors among ``records`` and count them.

    ``records``: ``{bag_id, label (1 = positive_class), score, threshold, predicted?}``;
    correct predictions are skipped and counted. ``predicted``, when given, must equal
    ``score >= threshold``. ``contexts`` maps bag_id to optional facts: ``qc_issues`` (list of
    names or dicts with ``category``), ``lesion_area_um2`` (from expert outlines only),
    ``reader_disagreement`` (bool), ``scanner_id``, ``site_id``, ``negative_category``.
    ``train_domain``: ``{"scanner_ids": [...], "site_ids": [...]}`` seen in training; without
    it ``domain_shift`` is not assessable."""
    policy.validate()
    contexts = contexts or {}
    train_scanners = set((train_domain or {}).get("scanner_ids") or ())
    train_sites = set((train_domain or {}).get("site_ids") or ())
    counts = {c: 0 for c in CATEGORIES}
    counts["uncategorised"] = 0
    by_type = {et: {c: 0 for c in (*CATEGORIES, "uncategorised")} for et in ERROR_TYPES}
    not_assessable = {"small_lesion": 0, "domain_shift": 0, "mimic_category": 0}
    mimic: Counter = Counter()
    errors, n_records, n_correct = [], 0, 0
    for r in records:
        n_records += 1
        label, s, t = int(r["label"]), float(r["score"]), float(r["threshold"])
        if label not in (0, 1):
            raise ValueError(f"bag {r.get('bag_id')}: label must be 0 or 1")
        if not (math.isfinite(s) and math.isfinite(t)):
            raise ValueError(f"bag {r.get('bag_id')}: score and threshold must be finite")
        pred = s >= t
        if r.get("predicted") is not None and bool(r["predicted"]) != pred:
            raise ValueError(f"bag {r.get('bag_id')}: 'predicted' disagrees with score >= threshold")
        if pred == (label == 1):
            n_correct += 1
            continue
        bag_id = str(r["bag_id"])
        ctx = contexts.get(bag_id) or {}
        margin = float(relative_margin([s], t, score_range=policy.score_range)[0])
        etype = "false_negative" if label == 1 else "false_positive"
        cats: list[str] = []
        details: dict[str, str] = {}
        confident = margin >= policy.confident_margin
        if margin < policy.near_threshold_margin:
            cats.append("near_threshold")
            details["near_threshold"] = f"relative margin {margin:.2f} < {policy.near_threshold_margin}"
        if confident:
            cats.append("confident_error")
            details["confident_error"] = f"relative margin {margin:.2f} >= {policy.confident_margin}"
        qc = _issue_names(ctx.get("qc_issues") or ())
        if qc:
            cats.append("artifact_associated")
            details["artifact_associated"] = (f"QC issue(s) recorded on the slide: {', '.join(qc)} "
                                              "(a possible association, not a cause)")
        if label == 1:
            area = ctx.get("lesion_area_um2")
            if area is None:
                not_assessable["small_lesion"] += 1
            elif float(area) < policy.small_lesion_max_area_um2:
                cats.append("small_lesion")
                details["small_lesion"] = (f"expert-outlined lesion area {float(area):.0f} µm² < "
                                           f"{policy.small_lesion_max_area_um2:.0f} µm²")
        if confident and ctx.get("reader_disagreement"):
            cats.append("possible_label_error")
            details["possible_label_error"] = ("confident error with a reader disagreement on record: the reference "
                                               "label may need adjudication (it is not changed here)")
        scanner, site = ctx.get("scanner_id"), ctx.get("site_id")
        if train_domain is None or (scanner is None and site is None):
            not_assessable["domain_shift"] += 1
        else:
            unseen = []
            if scanner is not None and scanner not in train_scanners:
                unseen.append(f"scanner '{scanner}'")
            if site is not None and site not in train_sites:
                unseen.append(f"site '{site}'")
            if unseen:
                cats.append("domain_shift")
                details["domain_shift"] = f"{' and '.join(unseen)} not seen in the training data"
        if label == 0:
            category = ctx.get("negative_category")
            if category:
                cats.append("mimic_category")
                details["mimic_category"] = f"the '{negative_class}' reference carries the category '{category}'"
                mimic[str(category)] += 1
            else:
                not_assessable["mimic_category"] += 1
        cats = cats or ["uncategorised"]
        for c in cats:
            counts[c] += 1
            by_type[etype][c] += 1
        if label == 1:
            description = (f"missed '{positive_class}': reference '{positive_class}', score {s:.3f} below the "
                           f"threshold {t:.3f}")
        else:
            description = (f"flagged as '{positive_class}': reference '{negative_class}', score {s:.3f} at or above "
                           f"the threshold {t:.3f}")
        errors.append({"bag_id": bag_id, "error_type": etype, "reference": positive_class if label else negative_class,
                       "predicted": positive_class if pred else negative_class, "description": description,
                       "score": s, "threshold": t, "relative_margin": margin, "categories": cats,
                       "details": details})
    errors.sort(key=lambda e: (e["error_type"] != "false_negative",
                               e["score"] if e["error_type"] == "false_negative" else -e["score"], e["bag_id"]))
    n_fn = sum(1 for e in errors if e["error_type"] == "false_negative")
    return {
        "schema": FAILURE_SCHEMA,
        "policy": policy.to_dict(),
        "positive_class": positive_class,
        "negative_class": negative_class,
        "n_records": n_records,
        "n_correct_skipped": n_correct,
        "n_errors": len(errors),
        "n_false_negatives": n_fn,
        "n_false_positives": len(errors) - n_fn,
        "counts": counts,
        "counts_by_error_type": by_type,
        "mimic_categories": dict(sorted(mimic.items())),
        "not_assessable": {
            "small_lesion": {"n": not_assessable["small_lesion"],
                             "reason": "missed positive without an expert outline giving the lesion area"},
            "domain_shift": {"n": not_assessable["domain_shift"],
                             "reason": "no training scanner/site list given, or the bag records neither"},
            "mimic_category": {"n": not_assessable["mimic_category"],
                               "reason": "the negative reference label carries no category"},
        },
        "errors": errors,
        "notes": [
            "Categories are possible contributing factors read from recorded context, not causes; an error can carry "
            "several categories.",
            f"'{negative_class}' means only that '{positive_class}' was not identified in the reference; it is not a "
            "diagnosis of anything else.",
            "Absence of a recorded reader disagreement is not evidence that the reference label is right.",
        ],
    }
