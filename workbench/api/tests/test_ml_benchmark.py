"""Benchmark harness (design §6): one frozen manifest, one feature set per encoder, a comparison
family with a shared bootstrap seed, paired comparisons on identical development bag and
patient sets, nested learning curves evaluated on development predictions only, and the
shipped configurations."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from sqlalchemy import select

from test_ml_support import BANNER, CID, SYNTH, cohort

CONFIG_DIR = Path(__file__).resolve().parents[2] / "experiments" / "configs"
COHORT_NAME = "Synthetic pipeline-test cohort (no images, no histology)"


def _config(**over) -> dict:
    cfg = {
        "name": "unit benchmark (PIPELINE TEST)",
        "project_id": CID,
        "dataset": {"name": COHORT_NAME},
        "execution_mode": "synthetic_pipeline_test",
        "evaluation_protocol": "dev_cv",
        "encoders": [SYNTH],
        "heads": ["meanpool_logreg", "abmil"],
        "seeds": [0],
        "params": {"pixel_mode": "none", "max_patches_per_slide": 16, "cv_folds": 3, "min_threshold_evidence": 5,
                   "n_boot": 100},
        "head_params": {"abmil": {"max_epochs": 6, "patience": 3}},
        "learning_curve": {"fractions": [0.5, 1.0], "repeats": 2},
        "bootstrap": {"n_boot": 200, "seed": 1234, "min_patients": 10},
    }
    cfg.update(over)
    return cfg


def test_synthetic_benchmark_compares_runs_on_identical_development_sets(env, ids, tmp_path):
    from dermpath.db import session_scope
    from dermpath.ml.benchmark import run_benchmark
    from dermpath.ml.engine_models import ComparisonFamily, ComparisonFamilyMember
    from dermpath.ml.models import Prediction, TrainingRun

    out = tmp_path / "report.json"
    report = run_benchmark(_config(), report_path=out)
    assert out.is_file() and json.loads(out.read_text())["schema"] == "dermpath.benchmark/1"
    assert report["research_use_only"] is True and report["banner"] == BANNER
    assert report["dataset"]["dataset_version_id"] == cohort(ids)["dataset_version_id"]
    runs = report["runs"]
    assert len(runs) == 2 + 2 * 2 and all(r["status"] == "succeeded" for r in runs), runs
    fam_id = report["family"]["family_id"]
    with session_scope() as db:
        fam = db.get(ComparisonFamily, fam_id)
        members = set(db.scalars(select(ComparisonFamilyMember.run_id)
                                 .where(ComparisonFamilyMember.family_id == fam_id)).all())
        assert fam.status == "open" and fam.bootstrap_seed == 1234
        assert members == {r["run_id"] for r in runs}
        rows = {r["run_id"]: db.get(TrainingRun, r["run_id"]) for r in runs}
        assert {r.family_id for r in rows.values()} == {fam_id}
        assert len({r.feature_set_id for r in rows.values()}) == 1  # one feature set per encoder
        assert len({r.dataset_manifest_sha256 for r in rows.values()}) == 1
        oof = {rid: {(p.bag_id, p.coded_patient_id) for p in db.scalars(
            select(Prediction).where(Prediction.run_id == rid, Prediction.split == "oof")).all()} for rid in rows}
        assert not db.scalars(select(Prediction).where(Prediction.run_id.in_(list(rows)),
                                                       Prediction.split == "test")).first()
    grid = [r for r in runs if r["role"] == "grid"]
    assert oof[grid[0]["run_id"]] == oof[grid[1]["run_id"]]  # identical bags and patients
    # Head effects with the encoder fixed: a paired comparison on that identical set, family seed.
    he = report["comparisons"]["head_effects"]
    assert len(he) == 1 and he[0]["status"] == "ok" and he[0]["fixed"] == {"encoder": SYNTH, "seed": 0}
    res = he[0]["result"]
    assert res["bootstrap"]["seed"] == 1234 and res["winner"] is None and res["n_bags"] == len(oof[grid[0]["run_id"]])
    assert res["n_patients"] == len({p for _, p in oof[grid[0]["run_id"]]}) and he[0]["split"] == "oof"
    assert {"auroc", "auprc", "sensitivity", "specificity", "brier"} == set(res["pairs"][0]["deltas"])
    assert report["comparisons"]["encoder_effects"] == []  # one encoder: nothing to compare
    # Learning curves: nested subsets, development (OOF) evaluation, patient counts.
    lc = {(c["encoder"], c["head"]): c for c in report["learning_curves"]}
    assert set(lc) == {(SYNTH, "meanpool_logreg"), (SYNTH, "abmil")}
    pts = {p["fraction"]: p for p in lc[(SYNTH, "abmil")]["points"]}
    assert lc[(SYNTH, "abmil")]["evaluated_on"] == "oof" and pts[0.5]["n_repeats"] == 2 and pts[1.0]["n_repeats"] == 1
    assert all(r["train_patients"] < pts[1.0]["repeats"][0]["train_patients"] for r in pts[0.5]["repeats"])
    with session_scope() as db:
        full = set(db.get(TrainingRun, pts[1.0]["repeats"][0]["run_id"]).provenance_json["train_bag_ids"])
        halves = [set(db.get(TrainingRun, r["run_id"]).provenance_json["train_bag_ids"]) for r in pts[0.5]["repeats"]]
    assert all(h < full for h in halves) and halves[0] != halves[1]
    assert set(report["optimisation_budgets"]) == {"meanpool_logreg", "abmil"}
    assert report["optimisation_budgets"]["abmil"]["params"]["max_epochs"] == 6
    assert report["policy"]["identical_except_patch_size"] is True
    assert "never read" in report["test_split"] and "No winner" in report["selection_note"]


def test_benchmark_variants_cover_the_grid_and_the_learning_curve():
    from dermpath.ml.benchmark import _variants, validate_config

    cfg = validate_config(_config(encoders=[SYNTH, "handcrafted-stain-texture-v1"],
                                  learning_curve={"fractions": [0.25, 0.5, 1.0], "repeats": 3}))
    v = _variants(cfg)
    grid = [x for x in v if x["role"] == "grid"]
    lc = [x for x in v if x["role"] == "learning_curve"]
    assert len(grid) == 2 * 2 * 1 and all(x["fraction"] == 1.0 for x in grid)
    assert len(lc) == 2 * 2 * 2 * 3 and {x["fraction"] for x in lc} == {0.25, 0.5}
    assert len({(x["encoder"], x["head"], x["seed"], x["fraction"], x["repeat"]) for x in v}) == len(v)


@pytest.mark.parametrize("bad, match", [
    ({"bogus": 1}, "unknown benchmark config key"),
    ({"encoders": ["no-such-encoder"]}, "registered encoder"),
    ({"heads": ["svm"]}, "heads must be"),
    ({"evaluation_protocol": "loo"}, "evaluation_protocol"),
    ({"execution_mode": "real_image_technical"}, "no heads"),
    ({"learning_curve": {"fractions": [0.0, 1.0]}}, "fractions"),
    ({"params": {"train_patient_fraction": 0.5}}, "learning_curve block"),
    ({"head_params": {"svm": {}}}, "head_params"),
])
def test_invalid_benchmark_configs_are_refused(bad, match):
    from dermpath.ml.benchmark import BenchmarkError, validate_config

    with pytest.raises(BenchmarkError, match=match):
        validate_config(_config(**bad))


def test_shipped_configs_are_valid():
    from dermpath.ml.benchmark import validate_config

    names = sorted(p.name for p in CONFIG_DIR.glob("*.json"))
    assert {"synthetic_pipeline_benchmark.json", "cobra_technical_validation.json",
            "cobra_supervised_baseline.json"} <= set(names)
    for name in names:
        cfg = validate_config(json.loads((CONFIG_DIR / name).read_text()))
        assert cfg["name"] and cfg["project_id"]
    sup = validate_config(json.loads((CONFIG_DIR / "cobra_supervised_baseline.json").read_text()))
    assert sup["project_id"] == "proj-cobra-bcc-subset" and sup["evaluation_protocol"] == "dev_cv"
    assert sup["params"]["cv_folds"] == 5 and sup["params"]["sampling_strategy"] == "spatial"
    assert sup["params"]["max_patches_per_slide"] == 256
    assert sup["encoders"] == ["handcrafted-stain-texture-v1", "midnight-12k"]
    assert sup["heads"] == ["meanpool_logreg", "abmil"]
    assert sup["learning_curve"] == {"fractions": [0.25, 0.5, 1.0], "repeats": 3,
                                     "encoders": sup["encoders"], "heads": sup["heads"]}
    tech = validate_config(json.loads((CONFIG_DIR / "cobra_technical_validation.json").read_text()))
    assert tech["technical"] is True and tech["heads"] == [] and tech["learning_curve"] is None


def test_technical_benchmark_builds_feature_sets_and_reads_no_label(env, ids, tmp_path, monkeypatch):
    """real_image_technical: feature sets only; no experiment, no label (fakes stand in for real slides)."""
    from types import SimpleNamespace

    from dermpath.ml import benchmark, feature_sets, training

    made, built = [], []

    def fake_create(db, actor, project, *, encoder_id, execution_mode, dataset_version_id=None, params=None,
                    name=None, **kw):
        assert execution_mode == "real_image_technical"
        made.append(encoder_id)
        return SimpleNamespace(id=f"fs-{encoder_id}", patch_policy_json={"patch_size": 224, "target_mpp": 0.5},
                               policy_sha256="p", status="ready", spec_sha256="s", weights_sha256="w",
                               encoder_spec_sha256="e")

    monkeypatch.setattr(feature_sets, "create_feature_set", fake_create)
    monkeypatch.setattr(feature_sets, "build_feature_set", lambda fs_id, ctx=None: built.append(fs_id))
    monkeypatch.setattr(benchmark, "_report", lambda cfg, mode, dv_id, fs_ids, policy, family_id, variants, runs,
                        warnings: {"mode": mode, "family": family_id, "runs": runs, "feature_sets": fs_ids})

    def no_labels(*a, **kw):
        raise AssertionError("a technical benchmark must not read labels")

    monkeypatch.setattr(training, "training_eligible_items", no_labels)
    cfg = _config(execution_mode="real_image_technical", heads=[], learning_curve=None,
                  encoders=["handcrafted-stain-texture-v1"], params={})
    report = benchmark.run_benchmark(cfg, report_path=tmp_path / "t.json")
    assert made == ["handcrafted-stain-texture-v1"] and built == ["fs-handcrafted-stain-texture-v1"]
    assert report["family"] is None and report["runs"] == {} and report["mode"] == "real_image_technical"


def test_missing_project_or_dataset_is_a_clear_error(env, tmp_path):
    from dermpath.ml.benchmark import BenchmarkError, run_benchmark

    with pytest.raises(BenchmarkError, match="does not exist"):
        run_benchmark(_config(project_id="proj-cobra-bcc-subset"), report_path=tmp_path / "x.json")
    with pytest.raises(BenchmarkError, match="import and freeze it first"):
        run_benchmark(_config(dataset={"name": "no such dataset"}), report_path=tmp_path / "x.json")
