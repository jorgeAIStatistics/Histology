"""Regression coverage for the shared reporting helpers added in verification round 2 (reporting honesty; design
§6-§7 'Implemented differently'). Pure functions, no database. RESEARCH USE ONLY.

The end-to-end paths (API, benchmark, COBRA driver, evidence exporter) are exercised by
``test_verify2_reporting.py``; these tests pin the helper semantics those paths share."""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest

SCRIPTS = Path(__file__).resolve().parents[2] / "scripts"


def _run(protocol: str, rows: list[dict], threshold: dict | None = None, folds: list[dict] | None = None):
    metrics = {"unscored_bags": rows}
    if folds is not None:
        metrics["protocol"] = {"cv": {"folds_summary": folds}, "learning_curve": {"n_patients": 48}}
    return SimpleNamespace(evaluation_protocol=protocol, metrics_json=metrics, threshold_json=threshold or {})


def test_development_unscored_reads_dev_cv_rows_recorded_with_their_manifest_split():
    from dermpath.ml.training import development_unscored

    legacy = [{"bag_id": "a", "split": "train"}, {"bag_id": "b", "split": "val"},
              {"bag_id": "c", "split": "oof", "manifest_split": "train"}]
    assert [u["bag_id"] for u in development_unscored(_run("dev_cv", legacy), "oof")] == ["a", "b", "c"]
    assert development_unscored(_run("dev_cv", legacy), "val") == []
    holdout = [{"bag_id": "a", "split": "train"}, {"bag_id": "b", "split": "val"}]
    assert [u["bag_id"] for u in development_unscored(_run("holdout", holdout), "val")] == ["b"]
    assert [u["bag_id"] for u in development_unscored(_run("holdout", holdout), "train")] == ["a"]


def test_oof_fitting_patients_labels_points_with_the_fold_models_patients():
    from dermpath.ml.training import oof_fitting_patients

    folds = [{"status": "fitted", "fit_patients": 30}, {"status": "fitted", "fit_patients": 32},
             {"status": "not_fitted", "fit_patients": 90}, {"status": "fitted", "fit_patients": 31}]
    out = oof_fitting_patients(_run("dev_cv", [], folds=folds).metrics_json)
    assert out["train_patients"] == 31 and isinstance(out["train_patients"], int)
    assert out["train_patients_by_fold"] == [30, 32, 31] and out["train_patients_max"] == 32
    assert out["final_model_patients"] == 48
    two = oof_fitting_patients(_run("dev_cv", [], folds=folds[:2]).metrics_json)
    assert two["train_patients"] == 30  # low median: an actual fold's count, never above the largest fold
    assert oof_fitting_patients(_run("dev_cv", [], folds=[folds[2]]).metrics_json) is None
    assert oof_fitting_patients({}) is None


def test_threshold_tuned_on_requires_selection_on_the_same_split():
    from dermpath.ml.training import threshold_tuned_on

    assert threshold_tuned_on(_run("dev_cv", [], {"selection_status": "selected", "selected_on": "oof"}), "oof")
    assert not threshold_tuned_on(_run("dev_cv", [], {"selection_status": "selected", "selected_on": "oof"}), "test")
    assert not threshold_tuned_on(_run("dev_cv", [], {"selection_status": "insufficient_evidence",
                                                      "selected_on": "oof"}), "oof")


def test_subject_accounting_counts_bags_no_model_could_score():
    from dermpath.ml.comparison import subject_accounting

    out = subject_accounting({"a": {"scored": {"b1": "p1", "b2": "p2"}, "unscorable": {"b9": "p9"}},
                              "b": {"scored": {"b1": "p1", "b2": "p2"}, "unscorable": {"b9": "p9"}}})
    assert out["paired_evaluable"] == {"bags": 2, "patients": 2}
    assert out["unscorable"]["a"] == out["unscorable"]["b"] == {"bags": 1, "patients": 1}
    assert out["excluded_from_pairing"] == {"bags": 1, "patients": 1}


def test_label_tuning_estimates_flags_threshold_dependent_deltas_only():
    from dermpath.ml.comparison import TUNING_COMPARISON_NOTE, ScoreSet, label_tuning_estimates, paired_comparison

    rng = np.random.default_rng(3)
    y = [i % 2 for i in range(40)]
    pts = [f"p{i // 2}" for i in range(40)]
    s = np.clip(np.array(y) * 0.3 + rng.random(40) * 0.7, 0, 1).tolist()
    sets = [ScoreSet("a", [f"x{i}" for i in range(40)], pts, y, s, 0.5),
            ScoreSet("b", [f"x{i}" for i in range(40)], pts, y, [v * 0.9 for v in s], 0.45)]
    res = label_tuning_estimates(paired_comparison(sets, n_boot=20, min_patients=5), {"a": True, "b": False})
    d = res["pairs"][0]["deltas"]
    assert res["tuning_set"] is True and res["tuning_set_note"] == TUNING_COMPARISON_NOTE
    assert res["threshold_tuned_on_these_data"] == ["a"]
    assert d["sensitivity"]["tuning_set"] is True and d["specificity"]["tuning_set"] is True
    assert all("tuning_set" not in d[m] for m in ("auroc", "auprc", "brier"))
    assert res["pairs"][0]["mcnemar"]["tuning_set"] is True
    res2 = label_tuning_estimates(paired_comparison(sets, n_boot=20, min_patients=5), {"a": False, "b": False})
    assert res2["tuning_set"] is False and res2["tuning_set_note"] is None
    assert "tuning_set" not in res2["pairs"][0]["deltas"]["sensitivity"]


@pytest.fixture(scope="module")
def drv():
    spec = importlib.util.spec_from_file_location("run_cobra_experiments_reporting_acc",
                                                  SCRIPTS / "run_cobra_experiments.py")
    m = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = m
    spec.loader.exec_module(m)
    yield m
    sys.modules.pop(spec.name, None)


def test_driver_calibration_block_reads_the_nested_development_calibration(drv):
    cal = {"raw": {"equal_width": {"brier": 0.19, "ece": 0.15}},
           "calibrated": {"equal_width": {"brier": 0.17, "ece": 0.08}},
           "calibrated_in_sample": True, "calibrated_note": "in-sample: ...", "calibration_status": "fitted"}
    out = drv.calibration_block(cal, {"status": "fitted", "evaluated_in_sample": True, "evidence": {"unit": "x"}})
    assert (out["brier"], out["ece"]) == (0.19, 0.15)
    assert (out["calibrated_brier"], out["calibrated_ece"]) == (0.17, 0.08)
    assert out["calibrated_in_sample"] is True and out["calibration_status"] == "fitted"
    assert out["selection"]["evaluated_in_sample"] is True and out["selection"]["evidence"] == {"unit": "x"}
    assert drv.calibration_block({"brier": 0.2, "ece": 0.1})["brier"] == 0.2  # flat bodies still read
