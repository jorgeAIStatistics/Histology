"""Adversarial verification, second round: REPORTING HONESTY (owner's brief item 7; design §6-§7). RESEARCH USE ONLY.

Each test attacks one reporting guarantee through a realistic path (the API, the training worker, the benchmark
harness, the COBRA experiment driver and the evidence exporter) on the seeded synthetic cohort, which carries no
pathology signal. A failing test reproduces a defect; a passing test stays as regression coverage.

Guarantees under attack:

* paired head/encoder comparisons are computed on PAIRED EVALUABLE subjects, and unscorable subjects (bags
  without tissue patches) are accounted separately, never silently dropped;
* the prediction unit and the independent patient counts are stated;
* development metrics after threshold selection are labelled tuning estimates; same-sample calibration is labelled
  in-sample;
* the reference-standard notice accompanies results on an imported-reference dataset;
* below a patient gate an insufficient-evidence status is returned, not a number;
* "BCC absent" is never rendered as benign;
* intervals come from patient clusters;
* learning-curve points are labelled with the patient counts that produced them.

One module-scoped world is trained once (about 20 s): a dev_cv comparison family (meanpool_logreg + abmil, Platt
calibration, Youden threshold on out-of-fold scores), one dev_cv run on a different declared fold seed, and a small
dev_cv benchmark with a learning curve. Two development slides (one train, one validation) have no tissue patches,
which is a real extraction outcome. After training, the frozen manifest is re-declared ``imported_reference`` in this
module's private database copy (a raw SQL edit of the per-test copy, never ``workbench/var``), so the live reporting
surfaces can be checked for the reference-standard notice. Nothing is downloaded and nothing under ``workbench/var``
or ``workbench/experiments`` is touched.
"""

from __future__ import annotations

import contextlib
import dataclasses
import importlib.util
import json
import re
import shutil
import sys
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest

from test_ml_support import CID, FAST, LEAD, SYNTH, cohort, run_jobs

SCRIPTS = Path(__file__).resolve().parents[2] / "scripts"
COHORT_NAME = "Synthetic pipeline-test cohort (no images, no histology)"
LR, AB = "meanpool_logreg", "abmil"


# =========================================================================== module world


def _load(name: str, file: str):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / file)
    m = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = m
    spec.loader.exec_module(m)
    return m


@pytest.fixture(scope="module")
def drv():
    m = _load("run_cobra_experiments_verify2_reporting", "run_cobra_experiments.py")
    yield m
    sys.modules.pop("run_cobra_experiments_verify2_reporting", None)


@pytest.fixture(scope="module")
def exp():
    m = _load("export_evidence_verify2_reporting", "export_evidence.py")
    yield m
    sys.modules.pop("export_evidence_verify2_reporting", None)


@dataclasses.dataclass
class World:
    settings: object
    ids: dict
    dv_id: str
    family_id: str
    runs: dict  # head -> run id (dev_cv, family members, cv_fold_seed 0)
    alt_fold_run: str  # dev_cv meanpool run declared on cv_fold_seed 1 (not a family member)
    no_patch_slides: set
    bench: dict  # benchmark report


def _zero_patch(mp, slide_ids: set[str]) -> None:
    """The pinned artifacts of these slides hold no tissue patches (a real outcome of extraction)."""
    from dermpath.ml import feature_sets as fsm

    real = fsm.load_slide_features

    def load(fs, slide_id):
        sf = real(fs, slide_id)
        if slide_id in slide_ids:
            dim = int(sf.embeddings.shape[1]) if np.ndim(sf.embeddings) == 2 else 1
            return dataclasses.replace(sf, embeddings=np.zeros((0, dim), np.float32),
                                       coords=np.zeros((0, 2), np.int64), n_patches=0)
        return sf

    mp.setattr(fsm, "load_slide_features", load)


def _manifest(dv_id: str) -> dict:
    from dermpath.db import session_scope
    from dermpath.models import DatasetVersion

    with session_scope() as db:
        return json.loads(json.dumps(db.get(DatasetVersion, dv_id).manifest_json))


def _declare_imported_reference(dv_id: str) -> None:
    """Re-declare the frozen manifest's reference standard as ``imported_reference`` in THIS module's private
    database copy (the frozen-row trigger is dropped and recreated around one UPDATE)."""
    from sqlalchemy import text

    from dermpath.db import session_scope

    m = _manifest(dv_id)
    m.setdefault("config", {})["reference_standard"] = "imported_reference"
    with session_scope() as db:
        ddl = db.execute(text("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND "
                              "name = 'dataset_version_frozen_update'")).scalar_one()
        db.execute(text("DROP TRIGGER dataset_version_frozen_update"))
        db.execute(text("UPDATE dataset_version SET manifest_json = :m WHERE id = :i"),
                   {"m": json.dumps(m), "i": dv_id})
        db.execute(text(ddl))
    assert _manifest(dv_id)["config"]["reference_standard"] == "imported_reference"


def _bench_config(report_path: Path) -> dict:
    return {
        "name": "verify2 reporting benchmark (PIPELINE TEST)", "project_id": CID, "dataset": {"name": COHORT_NAME},
        "execution_mode": "synthetic_pipeline_test", "evaluation_protocol": "dev_cv", "encoders": [SYNTH],
        "heads": [LR, AB], "seeds": [0],
        "params": {"pixel_mode": "none", "max_patches_per_slide": 16, "cv_folds": 3, "min_threshold_evidence": 3,
                   "n_boot": 100},
        "head_params": {"abmil": {"max_epochs": 6, "patience": 3}},
        "learning_curve": {"fractions": [0.5, 1.0], "repeats": 1, "heads": [LR]},
        "bootstrap": {"n_boot": 200, "seed": 1234, "min_patients": 10},
        "report_path": str(report_path),
    }


@pytest.fixture(scope="module")
def world(template_dir, tmp_path_factory):
    from conftest import make_settings

    from dermpath.auth import Actor
    from dermpath.config import set_settings
    from dermpath.db import reset_engine, session_scope
    from dermpath.ml.benchmark import run_benchmark
    from dermpath.ml.evaluation import create_family
    from dermpath.ml.service import create_experiment
    from dermpath.models import Project

    root = tmp_path_factory.mktemp("verify2-reporting")
    var = root / "var"
    shutil.copytree(template_dir, var)
    settings = make_settings(var)
    set_settings(settings)
    try:
        ids = json.loads((var / "seed-summary.json").read_text())
        dv_id = cohort(ids)["dataset_version_id"]
        items = sorted(_manifest(dv_id)["items"], key=lambda it: it["slide_id"])
        no_patch = {next(it for it in items if it["split"] == "val" and it["label_value"] == "bcc_present")["slide_id"],
                    next(it for it in items if it["split"] == "train")["slide_id"]}
        lead = Actor(LEAD, "research_lead", "Priya Navarro")
        params = {**FAST, "n_boot": 100, "min_threshold_evidence": 3, "cv_folds": 3, "calibration": "platt",
                  "max_epochs": 8, "patience": 3}
        with pytest.MonkeyPatch.context() as mp:
            _zero_patch(mp, no_patch)
            with session_scope() as db:
                fam = create_family(db, lead, db.get(Project, CID), name="verify2 reporting family",
                                    dataset_version_id=dv_id)
                fid = fam.id
            runs = {}
            for head in (LR, AB):
                with session_scope() as db:
                    run, _ = create_experiment(db, lead, db.get(Project, CID), dataset_version_id=dv_id,
                                               encoder_id=SYNTH, head=head, params=params, seed=0, name=None,
                                               evaluation_protocol="dev_cv", family_id=fid)
                    runs[head] = run.id
            with session_scope() as db:
                run, _ = create_experiment(db, lead, db.get(Project, CID), dataset_version_id=dv_id, encoder_id=SYNTH,
                                           head=LR, params={**params, "cv_fold_seed": 1}, seed=0, name=None,
                                           evaluation_protocol="dev_cv")
                alt = run.id
            out = run_jobs()
            assert [o.status for o in out] == ["succeeded"] * 3, [o.error for o in out]
            bench = run_benchmark(_bench_config(root / "bench.json"), report_path=root / "bench.json")
        assert all(r["status"] == "succeeded" for r in bench["runs"]), bench["runs"]
        _declare_imported_reference(dv_id)
        yield World(settings, ids, dv_id, fid, runs, alt, no_patch, bench)
    finally:
        reset_engine()
        set_settings(None)


@pytest.fixture()
def w(world):
    from dermpath.config import set_settings
    from dermpath.db import reset_engine

    set_settings(world.settings)
    yield world
    reset_engine()


@contextlib.contextmanager
def _client(w: World):
    from fastapi.testclient import TestClient

    from dermpath.main import create_app

    c = TestClient(create_app(w.settings))
    c.__enter__()
    try:
        r = c.post("/api/v1/auth/demo-login", json={"userId": LEAD})
        assert r.status_code == 200, r.text
        yield c
    finally:
        c.__exit__(None, None, None)


def _driver(drv, w: World, tmp_path: Path):
    args = drv.build_parser().parse_args(["--var-dir", str(w.settings.var_dir),
                                          "--reports-dir", str(tmp_path / "reports")])
    d = drv.Driver(args)
    d.actor = SimpleNamespace(id=LEAD, role="research_lead", display_name="Research lead")
    d.authorize = lambda db, perm: None
    return d


def _stored_oof(rid: str) -> dict:
    from dermpath.db import session_scope
    from dermpath.ml.evaluation import stored_evaluation

    with session_scope() as db:
        return json.loads(json.dumps(stored_evaluation(db, rid, "oof").metrics_json))


def _oof_rows(rid: str) -> list[tuple]:
    from sqlalchemy import select

    from dermpath.db import session_scope
    from dermpath.ml.models import Prediction

    with session_scope() as db:
        return [(p.bag_id, p.patient_code or p.coded_patient_id, p.label, p.score) for p in db.scalars(
            select(Prediction).where(Prediction.run_id == rid, Prediction.split == "oof"))]


def _run_json(rid: str) -> dict:
    from dermpath.db import session_scope
    from dermpath.ml.models import TrainingRun

    with session_scope() as db:
        r = db.get(TrainingRun, rid)
        return json.loads(json.dumps({"metrics": r.metrics_json, "threshold": r.threshold_json,
                                      "calibration": r.calibration_json}, default=str))


def _walk(obj, key=None):
    """Yield (key, value) for every value in a nested JSON-like object."""
    if isinstance(obj, dict):
        for k, v in obj.items():
            yield k, v
            yield from _walk(v, k)
    elif isinstance(obj, list):
        for v in obj:
            yield from _walk(v, key)


def _unscorable_counts(obj) -> list[int]:
    """Every count an object gives under a key that mentions unscorable subjects (ints, list lengths, bag counts)."""
    out = []
    for k, v in _walk(obj):
        if "unscor" not in str(k).lower():
            continue
        if isinstance(v, bool):
            continue
        if isinstance(v, int):
            out.append(v)
        elif isinstance(v, list):
            out.append(len(v))
        elif isinstance(v, dict):
            out.extend(int(x) for kk, x in _walk(v) if kk in ("bags", "n", "count") and isinstance(x, int))
    return out


def _labels_tuning(obj) -> bool:
    """True when the object labels its threshold-dependent numbers as tuning estimates (a ``tuning_set: true`` flag
    or a note that says tuning / optimistic)."""
    for k, v in _walk(obj):
        if k in ("tuning_set", "threshold_tuned_on_these_data") and v is True:
            return True
        if isinstance(v, str) and re.search(r"tuning|optimistic", v, re.IGNORECASE):
            return True
    return False


BENIGN_OK = re.compile(r"(not[_ ]benign|not the same as benign|never (?:be )?(?:rendered|called|shown)[^.]{0,40}benign"
                       r"|not ['\"]benign|is not benign|never [\"']benign)", re.IGNORECASE)


def _benign_renderings(obj) -> list[str]:
    """Strings that mention 'benign' outside an explicit negation ('BCC absent is NOT the same as benign')."""
    bad = []
    texts = [obj] if isinstance(obj, str) else [v for _, v in _walk(obj) if isinstance(v, str)] + \
        [str(k) for k, _ in _walk(obj)]
    for t in texts:
        for m in re.finditer(r"benign", t, re.IGNORECASE):
            window = t[max(0, m.start() - 60): m.end() + 2]
            if not BENIGN_OK.search(window):
                bad.append(window)
    return bad


# =========================================================================== paired evaluable subjects


def test_driver_subject_accounting_counts_bags_without_tissue_patches(w, drv, exp, tmp_path):
    """The driver's paired comparison (s3 / s4b) must account unscorable subjects separately: a development bag
    without tissue patches is unscorable under every model and must appear in ``subject_accounting`` (per model and
    excluded from pairing) and in the run record's ``unscorable_oof``, as the engine's own OOF body counts it."""
    d = _driver(drv, w, tmp_path)
    body = _stored_oof(w.runs[LR])
    assert body["n_unscorable"] >= 2  # the two no-patch development slides (engine body: correct)
    no_patch_in_body = {u["bag_id"] for u in body["unscored"]} & w.no_patch_slides
    assert no_patch_in_body == w.no_patch_slides
    entry = d.compare({LR: w.runs[LR], AB: w.runs[AB]})
    assert entry["status"] == "ok", entry
    acc = entry["subject_accounting"]
    rec = d.run_record(w.runs[LR])
    exported = exp.comparison_view(entry)["subject_accounting"]
    assert acc["unscorable"][LR]["bags"] == body["n_unscorable"] and \
        acc["excluded_from_pairing"]["bags"] >= len(w.no_patch_slides), (
        f"driver subject_accounting drops the no-tissue bags: engine OOF body n_unscorable="
        f"{body['n_unscorable']} (bags {sorted(no_patch_in_body)}), but subject_accounting={acc}; "
        f"run_record unscorable_oof={rec['unscorable_oof']} while run_record oof.n_unscorable="
        f"{rec['oof']['n_unscorable']}; the evidence package copies it unchanged: {exported}")


def test_family_development_comparison_accounts_unscorable_subjects(w):
    """GET /comparison-families/{id}: the development comparison pairs the scored bags; the bags no model could
    score (no tissue patches) must be accounted separately in the comparison, not vanish from it."""
    body = _stored_oof(w.runs[LR])
    with _client(w) as c:
        r = c.get(f"/api/v1/comparison-families/{w.family_id}", params={"n_boot": 50})
    assert r.status_code == 200, r.text
    dc = r.json()["development_comparison"]
    assert dc["status"] == "ok", dc
    n_unscorable = body["n_unscorable"]
    assert n_unscorable in _unscorable_counts(dc), (
        f"the family's development comparison (n_bags={dc['result']['n_bags']}, n_patients="
        f"{dc['result']['n_patients']}) never mentions the {n_unscorable} development bag(s) both models could not "
        f"score (engine OOF body: unscored={[u['bag_id'][:8] for u in body['unscored']]}); keys: {sorted(dc)}")


def test_benchmark_comparisons_account_bags_unscorable_under_every_model(w):
    """Benchmark head comparison: ``_restrict`` lists only bags unscorable under SOME model; bags unscorable under
    EVERY model (no tissue patches) must still be accounted in the comparison entry."""
    entry = w.bench["comparisons"]["head_effects"][0]
    assert entry["status"] == "ok", entry
    per_run = {r["head"]: (r.get("development") or {}).get("n_unscorable") for r in w.bench["runs"]
               if r["role"] == "grid"}
    assert set(per_run.values()) == {2}, per_run  # both runs: the two no-tissue bags
    counts = _unscorable_counts(entry)
    assert 2 in counts, (
        f"benchmark head comparison pairs {entry['result']['n_bags']} bags and reports "
        f"excluded_bags_unscorable_under_some_model={entry['excluded_bags_unscorable_under_some_model']} while each "
        f"run had 2 unscorable development bags ({per_run}); the comparison entry never accounts them")


# =========================================================================== tuning labels


@pytest.mark.parametrize("surface", ["family_api", "benchmark", "driver"])
def test_paired_development_deltas_at_tuned_thresholds_are_labelled_tuning_estimates(w, drv, tmp_path, surface):
    """Each model's threshold was selected (Youden) on the same out-of-fold scores the comparison uses, so the
    paired Δsensitivity / Δspecificity (and McNemar at the operating points) are tuning estimates and must say so,
    like the evaluation bodies do (``tuning_set``)."""
    if surface == "family_api":
        for rid in w.runs.values():
            th = _run_json(rid)["threshold"]
            assert th["selection_status"] == "selected" and th["selected_on"] == "oof", th
        with _client(w) as c:
            fam = c.get(f"/api/v1/comparison-families/{w.family_id}", params={"n_boot": 50}).json()
        obj = {"development_comparison": fam["development_comparison"], "note": fam.get("note")}
        assert obj["development_comparison"]["status"] == "ok"
    elif surface == "benchmark":
        recs = [r for r in w.bench["runs"] if r["role"] == "grid"]
        assert {r["threshold_selection_status"] for r in recs} == {"selected"}, recs
        obj = {"entry": w.bench["comparisons"]["head_effects"][0], "selection_note": w.bench["selection_note"]}
        assert obj["entry"]["status"] == "ok"
    else:
        obj = _driver(drv, w, tmp_path).compare({LR: w.runs[LR], AB: w.runs[AB]})
        assert obj["status"] == "ok"
    res = (obj.get("development_comparison") or obj.get("entry") or obj)["result"]
    assert {"sensitivity", "specificity"} <= set(res["pairs"][0]["deltas"])
    assert _labels_tuning(obj), (
        f"{surface}: paired development comparison reports threshold-dependent deltas "
        f"(sensitivity {res['pairs'][0]['deltas']['sensitivity']['value']}, specificity "
        f"{res['pairs'][0]['deltas']['specificity']['value']}) at thresholds selected on these same OOF scores, with no "
        "tuning_set flag or tuning/optimistic note anywhere in the comparison")


def test_development_bodies_label_tuning_in_sample_calibration_units_and_patients(w):
    """GET evaluation?split=oof and GET /experiments/{id}: threshold-dependent OOF metrics are tuning estimates,
    the calibration fitted on those OOF scores is labelled in-sample and not a validated probability, and the body
    states the prediction unit and the independent patient counts."""
    with _client(w) as c:
        ev = c.get(f"/api/v1/experiments/{w.runs[LR]}/evaluation", params={"split": "oof"}).json()
        run = c.get(f"/api/v1/experiments/{w.runs[LR]}").json()
    assert ev["tuning_set"] is True and ev["operating_point"]["tuning_set"] is True
    assert all(ev["metrics"][k]["tuning_set"] is True for k in ("sensitivity", "specificity", "ppv", "npv"))
    assert ev["intention_to_evaluate"]["sensitivity"]["tuning_set"] is True
    fc = ev["calibration"]["frozen_calibration"]
    assert fc["method"] == "platt" and fc["applied"] is True and fc["in_sample"] is True
    assert "in-sample" in ev["calibration"]["calibrated_note"]
    assert ev["label_scope"] == "slide" and ev["n_patients"] > 0 and ev["n_items"] > 0
    assert ev["positive_patients"] > 0 and ev["negative_patients"] > 0
    summ = run["oof_summary"]
    assert summ["tuning_set"] is True and summ["calibration"]["calibrated_in_sample"] is True
    sel = run["operating_point"]["calibration"]
    assert sel["status"] == "fitted" and sel["evaluated_in_sample"] is True and sel["reliability_note"]
    assert sel["evidence"]["unit"] == "patient_groups"


# =========================================================================== reference-standard notice


@pytest.mark.parametrize("surface", ["evaluation_body", "errors", "family_api", "driver", "experiment_api"])
def test_imported_reference_notice_accompanies_every_result_surface(w, drv, tmp_path, surface):
    """After the manifest declares ``imported_reference``, every surface that shows metrics measured against the
    manifest's labels must carry the imported-reference notice."""
    from dermpath.datasets import IMPORTED_REFERENCE_NOTICE
    from dermpath.db import session_scope
    from dermpath.ml.evaluation import build_evaluation, errors_response
    from dermpath.ml.models import Prediction, TrainingRun
    from sqlalchemy import select

    rid = w.runs[LR]
    if surface == "evaluation_body":
        with session_scope() as db:
            run = db.get(TrainingRun, rid)
            preds = db.scalars(select(Prediction).where(Prediction.run_id == rid, Prediction.split == "oof")).all()
            uns = [{"bag_id": u["bag_id"], "split": "oof", "reason": u.get("reason"),
                    "coded_patient_id": u.get("patient_id")} for u in run.metrics_json["unscored_bags"]]
            obj = build_evaluation(run, "oof", list(preds), uns, db=db)
        has_metrics = obj["metrics"]["auroc"]["value"] is not None
    elif surface == "errors":
        with session_scope() as db:
            obj = errors_response(db, db.get(TrainingRun, rid), "oof")
        has_metrics = True
    elif surface == "family_api":
        with _client(w) as c:
            obj = c.get(f"/api/v1/comparison-families/{w.family_id}", params={"n_boot": 50}).json()
        has_metrics = obj["development_comparison"]["status"] == "ok"
        assert obj["development_comparison"].get("reference_standard_notice") == IMPORTED_REFERENCE_NOTICE
    elif surface == "driver":
        d = _driver(drv, w, tmp_path)
        obj = {"compare": d.compare({LR: w.runs[LR], AB: w.runs[AB]}), "record": d.run_record(rid)}
        has_metrics = True
        assert obj["compare"].get("reference_standard_notice") and obj["record"].get("reference_standard_notice")
    else:
        with _client(w) as c:
            obj = c.get(f"/api/v1/experiments/{rid}").json()
            listed = c.get(f"/api/v1/projects/{CID}/experiments").json()["items"]
        has_metrics = (obj.get("oof_summary") or {}).get("auroc") is not None
        assert any(it["id"] == rid and it.get("oof_summary") for it in listed)
    assert has_metrics, f"{surface}: no metrics shown (precondition)"
    notices = [v for k, v in _walk(obj) if k == "reference_standard_notice"]
    assert IMPORTED_REFERENCE_NOTICE in notices or "IMPORTED REFERENCE LABELS" in json.dumps(obj), (
        f"{surface}: shows development metrics (oof_summary AUROC "
        f"{(obj.get('oof_summary') or {}).get('auroc') if isinstance(obj, dict) else None}) on an imported-reference "
        f"dataset without the reference-standard notice; top-level keys: {sorted(obj)[:60]}")


# =========================================================================== learning curves


@pytest.mark.parametrize("surface", ["benchmark", "driver"])
def test_learning_curve_points_state_the_patients_that_fitted_the_scored_models(w, drv, tmp_path, surface):
    """Under dev_cv every learning-curve point is an OUT-OF-FOLD AUROC: it is produced by the fold models, each
    fitted on the fold's (subset of) fitting patients. The patient count that labels the point must not exceed the
    number of patients any OOF-scoring model was fitted on (the final refit's count does not produce OOF scores)."""
    lc = next(c for c in w.bench["learning_curves"] if c["head"] == LR)
    reps = [rep for p in lc["points"] for rep in p["repeats"]]
    assert {p["fraction"] for p in lc["points"]} == {0.5, 1.0} and len(reps) == 2
    d = _driver(drv, w, tmp_path) if surface == "driver" else None
    problems = []
    for rep in reps:
        folds = _run_json(rep["run_id"])["metrics"]["protocol"]["cv"]["folds_summary"]
        fitted = [f["fit_patients"] for f in folds if f.get("status") == "fitted"]
        label = rep["train_patients"] if surface == "benchmark" else d.run_record(rep["run_id"])["train_patients"]
        if not isinstance(label, int) or label > max(fitted):
            problems.append({"run": rep["run_id"][:8], "labelled_train_patients": label,
                             "fold_models_fitted_on_patients": fitted})
    assert not problems, (f"{surface}: learning-curve points are labelled with the final refit's patient count, "
                          f"not the patients behind their out-of-fold AUROC: {problems}")


# =========================================================================== calibration block of the driver


def test_driver_run_record_reports_the_development_calibration_it_claims(w, drv, tmp_path):
    """The s3 run record (and the evidence package's runs_oof) carry ``oof.calibration`` = {brier, ece}; they must
    hold the development numbers, not nulls that read as 'undefined'."""
    rec = _driver(drv, w, tmp_path).run_record(w.runs[LR])
    body = _stored_oof(w.runs[LR])
    cal = rec["oof"]["calibration"]
    assert body["calibration"]["brier"] is not None and body["calibration"]["ece"] is not None
    assert cal.get("brier") is not None and cal.get("ece") is not None, (
        f"driver run_record oof.calibration={cal} although the OOF body has brier={body['calibration']['brier']:.4f}, "
        f"ece={body['calibration']['ece']:.4f}; the development summary nests them under raw/equal_width")


# =========================================================================== fold assignment in the driver


def test_driver_compare_refuses_runs_cross_validated_on_different_folds(w, drv, tmp_path):
    """The engine refuses to pair dev_cv runs cross-validated on different outer folds (mixed_fold_assignment);
    the driver's own compare(), which feeds s3/s4/s4b and the evidence package, must not pair them either."""
    from dermpath.db import session_scope
    from dermpath.ml.models import TrainingRun
    from dermpath.ml.training import comparison_refusal

    with session_scope() as db:
        ref = comparison_refusal(db, [db.get(TrainingRun, w.runs[LR]), db.get(TrainingRun, w.alt_fold_run)])
    assert ref is not None and ref["code"] == "mixed_fold_assignment", ref
    entry = _driver(drv, w, tmp_path).compare({"fold_seed_0": w.runs[LR], "fold_seed_1": w.alt_fold_run})
    assert entry["status"] != "ok", (
        f"driver compare paired runs on different outer folds (engine: {ref['code']}); "
        f"AUROC delta {entry['deltas'][0]['auroc']['value']}")


# =========================================================================== prediction unit


@pytest.mark.parametrize("surface", ["family_api", "benchmark"])
def test_paired_comparisons_state_the_prediction_unit(w, surface):
    """A comparison states what one prediction is (slide or case bag) next to its bag and patient counts."""
    if surface == "family_api":
        with _client(w) as c:
            obj = c.get(f"/api/v1/comparison-families/{w.family_id}", params={"n_boot": 50}).json()
        res = obj["development_comparison"]["result"]
    else:
        obj = w.bench
        res = obj["comparisons"]["head_effects"][0]["result"]
    assert res["n_bags"] > 0 and res["n_patients"] > 0
    units = [v for k, v in _walk(obj) if k in ("label_scope", "prediction_unit", "bag_kind")]
    assert units, (f"{surface}: n_bags={res['n_bags']}, n_patients={res['n_patients']} but no label_scope / "
                   "prediction unit anywhere in the response")


# =========================================================================== benign, patient clusters, gates


def test_bcc_absent_is_never_rendered_as_benign_on_reporting_surfaces(w, drv, tmp_path):
    with _client(w) as c:
        surfaces = {
            "evaluation": c.get(f"/api/v1/experiments/{w.runs[AB]}/evaluation", params={"split": "oof"}).json(),
            "errors": c.get(f"/api/v1/experiments/{w.runs[AB]}/errors", params={"split": "oof"}).json(),
            "experiment": c.get(f"/api/v1/experiments/{w.runs[AB]}").json(),
            "family": c.get(f"/api/v1/comparison-families/{w.family_id}", params={"n_boot": 50}).json(),
        }
    d = _driver(drv, w, tmp_path)
    surfaces["benchmark"] = w.bench
    surfaces["driver_record"] = d.run_record(w.runs[AB])
    surfaces["driver_compare"] = d.compare({LR: w.runs[LR], AB: w.runs[AB]})
    surfaces["driver_caveats"] = list(drv.CAVEATS) + [drv.NOTICE]
    assert surfaces["errors"]["items"], "precondition: the OOF errors list is not empty"
    neg = surfaces["evaluation"]["classes"]["negative"]
    assert "NOT the same as benign" in neg["display"] and "never rendered as benign" in neg["note"]
    bad = {k: _benign_renderings(v) for k, v in surfaces.items()}
    assert not any(bad.values()), bad


def test_intervals_resample_whole_patients_on_every_surface(w, drv, tmp_path):
    """Every interval comes from a patient-cluster bootstrap whose cluster count is the number of distinct patients
    (content-stable patient codes) of the set it describes."""
    rows = _oof_rows(w.runs[LR])
    scored_patients = {p for _, p, _, _ in rows}
    body = _stored_oof(w.runs[LR])
    run = _run_json(w.runs[LR])
    unscored_patients = {u.get("patient_code") or u["patient_id"] for u in run["metrics"]["unscored_bags"]}
    assert body["bootstrap"]["method"] == "patient_cluster" and body["bootstrap"]["status"] == "ok"
    assert body["bootstrap"]["n_patients"] == body["n_patients"] == len(scored_patients | unscored_patients)
    summ = run["metrics"]["oof_summary"]["bootstrap"]
    assert summ["method"] == "patient_cluster" and summ["n_patients"] == len(scored_patients | unscored_patients)
    with _client(w) as c:
        fam = c.get(f"/api/v1/comparison-families/{w.family_id}", params={"n_boot": 50}).json()
    d = _driver(drv, w, tmp_path)
    comps = {"family": fam["development_comparison"]["result"],
             "driver": d.compare({LR: w.runs[LR], AB: w.runs[AB]})["result"],
             "benchmark": w.bench["comparisons"]["head_effects"][0]["result"]}
    for name, res in comps.items():
        b = res["bootstrap"]
        assert b["method"] == "patient_paired" and "patient" in b["resampling_unit"], (name, b)
        assert b["n_patients"] == res["n_patients"], (name, b, res["n_patients"])
    assert comps["family"]["n_patients"] == comps["driver"]["n_patients"] == len(scored_patients)
    for k in ("sensitivity", "specificity", "auroc"):
        assert body["metrics"][k]["ci"] is not None  # 48 patients: above the gate, intervals reported


def test_patient_gates_return_insufficient_evidence_statuses_not_numbers():
    """Below a patient (or duplicate-group) gate the engine returns an insufficient-evidence status and no fitted
    number, however many bags the patients contribute."""
    from dermpath.ml import metrics as M
    from dermpath.ml.comparison import ScoreSet, paired_comparison
    from dermpath.ml.heads import Bag
    from dermpath.ml.training import ScoredBag, select_operating_point

    rng = np.random.default_rng(7)

    def bag(i, j, lab):
        return Bag(bag_id=f"b{i:02d}-{j}", kind="slide", slide_ids=[f"b{i:02d}-{j}"], case_id=f"c{i}",
                   patient_id=f"p{i:02d}", patient_code=f"VP-{i:03d}",
                   label_value="bcc_present" if lab else "bcc_absent_not_benign", label=lab, label_version_ids=[],
                   attributes={})

    dev = []
    for i in range(30):
        lab = int(i < 6)
        for j in range(5 if lab else 1):  # 6 positive patients x 5 bags = 30 positive bags
            dev.append(ScoredBag(bag(i, j, lab), float(np.clip(rng.normal(0.7 if lab else 0.3, 0.12), 0.01, 0.99))))
    params = {"threshold_rule": "youden", "target_sensitivity": 0.9, "min_threshold_evidence": 10,
              "calibration": "platt"}
    # Calibration: 6 positive patients but confirmed duplicates join them into 3 groups (< 5): no fitted map.
    op = select_operating_point(dev, params, selected_on="val",
                                context={"duplicate_pairs": [("p00", "p01"), ("p02", "p03"), ("p04", "p05")]})
    cs = op["calibration_selection"]
    assert cs["status"] == "insufficient_evidence" and cs["evidence"]["positive_units"] == 3, cs
    assert cs["evidence"]["positive_items"] == 30 and op["calibration"]["method"] in (None, "none")
    # Threshold: 6 positive patients < 10 although there are 30 positive bags: fallback, flagged unvalidated.
    assert op["threshold"]["selection_status"] == "insufficient_evidence" and op["threshold"]["evidence"][
        "unit"] == "patients"
    assert op["threshold"]["tuning_set_note"] is None and "unvalidated" in op["threshold"]["reason"]
    # Without the duplicate pairs the same scores have 6 groups: the calibration is fitted and labelled in-sample.
    op2 = select_operating_point(dev, params, selected_on="val", context={"duplicate_pairs": []})
    assert op2["calibration_selection"]["status"] == "fitted" and op2["calibration_selection"]["evaluated_in_sample"]
    # Subgroups and intervals: 9 patients with 27 bags are below a 10-patient gate.
    y = np.array([i % 2 for i in range(27)])
    s = np.clip(y * 0.4 + rng.random(27) * 0.6, 0, 1)
    pts = [f"q{i // 3}" for i in range(27)]
    sg = M.subgroup_analysis(y, s, pts, [{"scanner_id": "x"}] * 27, threshold=0.5, min_patients=10, n_boot=50)
    row = next(r for r in sg["rows"] if r.get("value") == "x" or r.get("key") == "scanner_id")
    assert row["status"] == "insufficient_evidence" and row["metrics"] is None, row
    ev = M.evaluate_binary(y, s, pts, threshold=0.5, n_boot=50, min_patients=10)
    assert ev["bootstrap"]["status"].startswith("insufficient evidence")
    assert all(ev["metrics"][k]["ci"] is None for k in ("sensitivity", "specificity", "auroc"))
    res = paired_comparison([ScoreSet("a", [f"x{i}" for i in range(27)], pts, y.tolist(), s.tolist(), 0.5),
                             ScoreSet("b", [f"x{i}" for i in range(27)], pts, y.tolist(), (s * 0.9).tolist(), 0.5)],
                            n_boot=50, min_patients=10)
    assert res["bootstrap"]["status"].startswith("insufficient evidence")
    assert all(v["ci"] is None for v in res["pairs"][0]["deltas"].values())


# =========================================================================== evidence package


def test_evidence_package_keeps_units_patients_tuning_in_sample_notice_and_wording(w, drv, exp, tmp_path):
    """The real driver orchestration writes reports whose s3 body holds REAL run records and comparisons of this
    world; the exporter's package must keep the prediction unit, patient counts, tuning and in-sample labels, the
    imported-reference notice and the 'BCC absent is not benign' wording."""
    from dermpath.ml.evaluation import reference_standard_fields

    d0 = _driver(drv, w, tmp_path)
    recs = []
    for head in (LR, AB):
        r = d0.run_record(w.runs[head])
        r.update(role="grid", fraction=1.0, repeat=0, seed=0, encoder=drv.HANDCRAFTED)
        recs.append(r)
    comp = {"fixed": {"encoder": drv.HANDCRAFTED}, "seed": 0, **d0.compare({LR: w.runs[LR], AB: w.runs[AB]})}
    manifest = _manifest(w.dv_id)
    s3 = {"runs": recs,
          "comparisons": {"encoder_effects": [], "head_effects": [comp], "four_way": comp, "primary_seed": 0,
                          "by_seed": {"0": {"encoder_effects": [], "head_effects": [comp], "four_way": comp}}},
          "seed_summary": drv.seed_summary(recs, [0]),
          "protocol": {"evaluation_protocol": "dev_cv", "cv_folds": 3, "fold_consistency": drv.fold_consistency(recs)},
          "learning_curves": [{"encoder": drv.HANDCRAFTED, "head": LR, "evaluated_on": "oof", "points": [
              {"fraction": 1.0, "n_repeats": 1, "n_succeeded": 1, "train_patients": drv.stats([recs[0]["train_patients"]]),
               "auroc_mean": d0.oof_auroc(recs[0])}]}],
          "pre_declared_test_candidate": {"rule": drv.CANDIDATE_RULE, "declared_at": "2026-10-28",
                                          "chosen": {"run_id": recs[0]["run_id"], "encoder": drv.HANDCRAFTED,
                                                     "head": LR}},
          **reference_standard_fields(manifest)}
    bodies = {"s0": {"machine": {"cpu_count": 1}},
              "s1": {"dataset": {"dataset_version_id": w.dv_id, "manifest_sha256": "m" * 64,
                                 "counts": {"patients": 60, "slides": 113},
                                 **reference_standard_fields(manifest)},
                     "split_table": {}, "labels_note": "task labels are bcc_present / bcc_absent_not_benign; BCC "
                                                       "absent is never 'benign'"},
              "s2": {"encoders": {}}, "s3": s3, "s8": {"caveats": list(drv.CAVEATS)}}
    reports = tmp_path / "reports"

    def driver():
        args = drv.build_parser().parse_args(["--var-dir", str(w.settings.var_dir), "--reports-dir", str(reports)])
        d = drv.Driver(args)
        d.reports_dir.mkdir(parents=True, exist_ok=True)
        d.state_dir.mkdir(parents=True, exist_ok=True)
        d.actor = SimpleNamespace(id=LEAD, role="research_lead")
        d.midnight_device = "cpu"
        d.lead = lambda: d.actor
        d.encoder_identity = lambda e: {"status": "available", "spec_sha256": f"spec-{e}", "weights_sha256": "w"}
        d.artifact_problems = lambda stage, rep: []
        for s in drv.STAGES:
            body = bodies.get(s, {"stage_body": s})
            setattr(d, s, (lambda _b: (lambda *a, **k: json.loads(json.dumps(_b, default=str))))(body))
        return d

    assert driver().run() == 0
    out_root = tmp_path / "evidence"
    rc = exp.main(["--experiment-id", "verify2-reporting", "--reports-dir", str(reports), "--out-root", str(out_root),
                   "--salt-file", str(tmp_path / "salt")])
    assert rc == 0
    pkg = out_root / "verify2-reporting"
    res = json.loads((pkg / "results.json").read_text())
    assert "s3" in res["included_stages"], res["included_stages"]
    dc = res["development_comparison"]
    runs = dc["runs_oof"]
    assert len(runs) == 2 and all(r["prediction_unit"] == "slide (bag)" and r["n_patients"] > 0 for r in runs)
    assert all(r["tuning_set"] is True and r["at_operating_point"]["sensitivity"]["tuning_set"] is True for r in runs)
    assert "tuning" in dc["labels"] and "in-sample" in dc["labels"]
    assert "imported reference" in res["notice"].lower()
    head = dc["comparisons_primary_seed"]["head_effects"][0]
    assert head["status"] == "ok" and head["subject_accounting"]["paired_evaluable"]["patients"] > 0
    assert head["reference_standard"] == "imported_reference"
    assert dc["learning_curves"][0]["points"][0]["train_patients"]
    text = "\n".join(p.read_text() for p in sorted(pkg.rglob("*")) if p.is_file())
    assert not _benign_renderings(text), _benign_renderings(text)
    assert "BCC absent is not benign" in (pkg / "README.md").read_text()
