"""Failure taxonomy (design §7): each category on crafted cases, counts, not-assessable
reporting, and the wording rule that a negative class such as "BCC absent" is never rendered
as "benign"."""

from __future__ import annotations

import json

import pytest

from dermpath.ml import failure as F

POS, NEG = "BCC present", "BCC absent"
DOMAIN = {"scanner_ids": ["scanner-a"], "site_ids": ["site-1"]}


def _rec(bag_id, label, score, threshold=0.5, **kw):
    return {"bag_id": bag_id, "label": label, "score": score, "threshold": threshold, **kw}


def _strings(obj):
    if isinstance(obj, str):
        yield obj
    elif isinstance(obj, dict):
        for k, v in obj.items():
            yield str(k)
            yield from _strings(v)
    elif isinstance(obj, (list, tuple)):
        for v in obj:
            yield from _strings(v)


def _cats(out, bag_id):
    return next(e["categories"] for e in out["errors"] if e["bag_id"] == bag_id)


def test_each_category_on_a_crafted_case():
    records = [
        _rec("fn-near", 1, 0.45),       # margin 0.1 → near_threshold
        _rec("fn-conf", 1, 0.05),       # margin 0.9 → confident_error (+ small lesion, disagreement)
        _rec("fp-qc", 0, 0.55),         # near + artifact
        _rec("fp-conf", 0, 0.95),       # confident + disagreement → possible_label_error, mimic
        _rec("fp-shift", 0, 0.7),       # margin 0.4: neither near nor confident; unseen scanner
        _rec("tp", 1, 0.9),             # correct: skipped
        _rec("tn", 0, 0.1),             # correct: skipped
    ]
    contexts = {
        "fn-near": {"scanner_id": "scanner-a", "site_id": "site-1", "lesion_area_um2": 900_000.0},
        "fn-conf": {"scanner_id": "scanner-a", "site_id": "site-1", "lesion_area_um2": 40_000.0,
                    "reader_disagreement": True},
        "fp-qc": {"scanner_id": "scanner-a", "site_id": "site-1",
                  "qc_issues": [{"category": "fold"}, {"category": "pen_mark"}]},
        "fp-conf": {"scanner_id": "scanner-a", "site_id": "site-1", "reader_disagreement": True,
                    "negative_category": "trichoepithelioma"},
        "fp-shift": {"scanner_id": "scanner-z", "site_id": "site-9"},
    }
    out = F.failure_taxonomy(records, contexts, positive_class=POS, negative_class=NEG, train_domain=DOMAIN)
    assert (out["n_records"], out["n_correct_skipped"], out["n_errors"]) == (7, 2, 5)
    assert (out["n_false_negatives"], out["n_false_positives"]) == (2, 3)
    assert _cats(out, "fn-near") == ["near_threshold"]
    assert _cats(out, "fn-conf") == ["confident_error", "small_lesion", "possible_label_error"]
    assert _cats(out, "fp-qc") == ["near_threshold", "artifact_associated"]
    assert _cats(out, "fp-conf") == ["confident_error", "possible_label_error", "mimic_category"]
    assert _cats(out, "fp-shift") == ["domain_shift"]
    assert out["counts"] == {"near_threshold": 2, "confident_error": 2, "artifact_associated": 1, "small_lesion": 1,
                             "possible_label_error": 2, "domain_shift": 1, "mimic_category": 1, "uncategorised": 0}
    assert out["counts_by_error_type"]["false_positive"]["confident_error"] == 1
    assert out["mimic_categories"] == {"trichoepithelioma": 1}
    detail = next(e for e in out["errors"] if e["bag_id"] == "fp-qc")["details"]["artifact_associated"]
    assert "fold, pen_mark" in detail and "not a cause" in detail
    assert "scanner 'scanner-z' and site 'site-9'" in next(
        e for e in out["errors"] if e["bag_id"] == "fp-shift")["details"]["domain_shift"]
    json.dumps(out, allow_nan=False)


def test_margins_are_relative_to_the_threshold():
    # threshold 0.1: a positive scored 0.0 is maximally confident (margin 1), 0.09 is near (margin 0.1),
    # 0.08 sits exactly on the near boundary (margin 0.2, not below it)
    recs = [_rec("fn-low", 1, 0.0, threshold=0.1), _rec("fn-near", 1, 0.09, threshold=0.1),
            _rec("fn-edge", 1, 0.08, threshold=0.1),
            _rec("fp-mid", 0, 0.55, threshold=0.1)]
    out = F.failure_taxonomy(recs, positive_class=POS, negative_class=NEG)
    assert _cats(out, "fn-low") == ["confident_error"]
    assert _cats(out, "fn-near") == ["near_threshold"]
    assert _cats(out, "fn-edge") == ["uncategorised"]
    assert _cats(out, "fp-mid") == ["uncategorised"]  # margin 0.5
    assert out["counts"]["uncategorised"] == 2
    custom = F.failure_taxonomy(recs, positive_class=POS, negative_class=NEG,
                                policy=F.FailurePolicy(near_threshold_margin=0.5, confident_margin=0.5))
    assert _cats(custom, "fp-mid") == ["confident_error"] and custom["policy"]["confident_margin"] == 0.5
    with pytest.raises(ValueError):
        F.failure_taxonomy(recs, positive_class=POS, negative_class=NEG,
                           policy=F.FailurePolicy(near_threshold_margin=0.7, confident_margin=0.6))


def test_small_lesion_needs_an_expert_outline_and_only_applies_to_missed_positives():
    recs = [_rec("fn-outlined", 1, 0.3), _rec("fn-unknown", 1, 0.3), _rec("fp", 0, 0.8)]
    ctx = {"fn-outlined": {"lesion_area_um2": 10_000}, "fp": {"lesion_area_um2": 10_000}}
    out = F.failure_taxonomy(recs, ctx, positive_class=POS, negative_class=NEG)
    assert "small_lesion" in _cats(out, "fn-outlined")
    assert "small_lesion" not in _cats(out, "fn-unknown") and "small_lesion" not in _cats(out, "fp")
    assert out["not_assessable"]["small_lesion"]["n"] == 1 and "expert outline" in out["not_assessable"][
        "small_lesion"]["reason"]


def test_possible_label_error_needs_a_confident_error_and_a_recorded_disagreement():
    recs = [_rec("near", 1, 0.45), _rec("conf", 1, 0.02), _rec("conf-agreed", 1, 0.02)]
    ctx = {"near": {"reader_disagreement": True}, "conf": {"reader_disagreement": True}}
    out = F.failure_taxonomy(recs, ctx, positive_class=POS, negative_class=NEG)
    assert "possible_label_error" not in _cats(out, "near")
    assert "possible_label_error" in _cats(out, "conf")
    assert "possible_label_error" not in _cats(out, "conf-agreed")
    assert any("not evidence that the reference label is right" in n for n in out["notes"])


def test_domain_shift_and_mimic_are_not_assessable_without_context():
    recs = [_rec("fp", 0, 0.8), _rec("fn", 1, 0.2)]
    out = F.failure_taxonomy(recs, {"fp": {"scanner_id": "scanner-z"}}, positive_class=POS, negative_class=NEG)
    assert out["counts"]["domain_shift"] == 0 and out["not_assessable"]["domain_shift"]["n"] == 2
    assert out["not_assessable"]["mimic_category"]["n"] == 1
    seen = F.failure_taxonomy(recs, {"fp": {"scanner_id": "scanner-a"}}, positive_class=POS, negative_class=NEG,
                              train_domain=DOMAIN)
    assert seen["counts"]["domain_shift"] == 0 and seen["not_assessable"]["domain_shift"]["n"] == 1


@pytest.mark.parametrize("negative_class", ["BCC absent", "No BCC identified", "negative", "Melanoma absent"])
def test_negative_class_is_never_rendered_as_benign(negative_class):
    recs = [_rec(f"b{i}", i % 2, s) for i, s in enumerate([0.9, 0.1, 0.55, 0.45, 0.99, 0.01, 0.7, 0.3])]
    ctx = {"b0": {"negative_category": "seborrhoeic keratosis", "reader_disagreement": True, "qc_issues": ["blur"]},
           "b2": {"scanner_id": "x", "site_id": "y"}, "b1": {"lesion_area_um2": 5.0}}
    out = F.failure_taxonomy(recs, ctx, positive_class="BCC present", negative_class=negative_class,
                             train_domain=DOMAIN)
    assert out["n_errors"] == 8
    for text in _strings(out):
        assert "benign" not in text.lower(), text
    fp = next(e for e in out["errors"] if e["error_type"] == "false_positive")
    assert fp["reference"] == negative_class and f"reference '{negative_class}'" in fp["description"]
    assert any(f"'{negative_class}' means only that 'BCC present' was not identified" in n for n in out["notes"])


def test_input_validation_and_ordering():
    with pytest.raises(ValueError, match="disagrees"):
        F.failure_taxonomy([_rec("b", 1, 0.9, predicted=False)], positive_class=POS, negative_class=NEG)
    with pytest.raises(ValueError, match="label must be 0 or 1"):
        F.failure_taxonomy([_rec("b", 2, 0.9)], positive_class=POS, negative_class=NEG)
    out = F.failure_taxonomy([_rec("fp1", 0, 0.6), _rec("fn1", 1, 0.4), _rec("fn0", 1, 0.1), _rec("fp0", 0, 0.9)],
                             positive_class=POS, negative_class=NEG)
    assert [e["bag_id"] for e in out["errors"]] == ["fn0", "fn1", "fp0", "fp1"]  # FN lowest first, then FP highest
