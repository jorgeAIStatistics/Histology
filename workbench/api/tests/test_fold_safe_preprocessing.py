"""Fold-safe learned preprocessing (owner's brief item 3; design §4 ``stain.py``, §6 ``dev_cv``). Research use only.

The confirmed defect: a ``macenko-v1`` feature set fits ONE stain reference at build time on train-split slides of the
frozen manifest (``feature_sets.create_feature_set`` / ``_fit_stain_reference``) and every ``dev_cv`` fold of a run
reads that set (one ``FeatureSetAccess`` over train ∪ val). Every development patient is held out in exactly one
fold, so each fold's held-out images shaped the normalisation of its own fitting data: preprocessing leakage (not
test-label leakage; its numerical effect is unknown). A learning-curve subset has the same flaw in both protocols:
the reference is fitted on training patients outside the subset, so the "fraction f" point used more patients'
images than it reports.

Fold-specific preprocessing is not implemented, so the engine refuses the combination with
``409 fold_unsafe_preprocessing`` at experiment creation (API and service) AND in the worker (a run recorded before
the guard, or through a path that bypassed it, fails permanently before anything is built or fitted). Historical
contaminated runs stay readable but are marked invalid for cross-validated comparison. ``holdout`` at fraction 1
keeps fitting the reference on train-split slides only (verified and recorded per run), and label-free fixed-encoder
extraction (``stain_normalization: none``) is unaffected under every protocol.
"""

from __future__ import annotations

import pytest
from sqlalchemy import func, select

from feature_set_support import HANDCRAFTED, LEAD_ID, actors, create_set, get_set, real_cohort
from test_ml_support import CID, FAST, SYNTH, cohort, run_jobs

MACENKO = {"max_patches_per_slide": 4, "n_boot": 50, "stain_normalization": "macenko-v1", "cv_folds": 3}
RATIOS = {"train": 0.5, "val": 0.25, "test": 0.25}
CODE = "fold_unsafe_preprocessing"


def _cohort(ids, project_id: str, n: int = 10) -> dict:
    return real_cohort(ids, n=n, project_id=project_id, ratios=RATIOS)


def _manifest(dv_id: str) -> dict:
    from dermpath.db import session_scope
    from dermpath.models import DatasetVersion

    with session_scope() as db:
        return db.get(DatasetVersion, dv_id).manifest_json


def _counts() -> dict:
    from dermpath.db import session_scope
    from dermpath.ml.engine_models import FeatureSet
    from dermpath.ml.models import Prediction, TrainingRun

    with session_scope() as db:
        return {"runs": db.scalar(select(func.count(TrainingRun.id))),
                "feature_sets": db.scalar(select(func.count(FeatureSet.id))),
                "predictions": db.scalar(select(func.count(Prediction.id)))}


def _post(client, rc: dict, *, protocol: str, params: dict, encoder: str = HANDCRAFTED, head: str = "meanpool_logreg",
          feature_set_id: str | None = None):
    body = {"dataset_version_id": rc["dataset_version_id"], "encoder_id": encoder, "head": head, "seed": 0,
            "params": params, "evaluation_protocol": protocol}
    if feature_set_id:
        body["feature_set_id"] = feature_set_id
    return client.post(f"/api/v1/projects/{rc['project_id']}/experiments", json=body)


def _legacy_run(rc: dict, *, protocol: str, params: dict, seed: int = 0) -> str:
    """A train run recorded the way ``service.create_experiment`` records one, but WITHOUT its creation guards: a run
    created before the fold-safety rule existed, or through a path that bypassed it. The worker must still refuse."""
    from dermpath.db import session_scope
    from dermpath.jobs import queue
    from dermpath.ml import feature_sets as fsets
    from dermpath.ml import training
    from dermpath.ml.artifacts import dependency_versions
    from dermpath.ml.config import feature_params, resolve_experiment_params
    from dermpath.ml.encoders import get_encoder
    from dermpath.ml.models import TrainingRun
    from dermpath.models import DatasetVersion, Project

    lead = actors()["lead"]
    with session_scope() as db:
        dv = db.get(DatasetVersion, rc["dataset_version_id"])
        enc = get_encoder(HANDCRAFTED)
        resolved = resolve_experiment_params(params, encoder_spec=enc.spec)
        fs = fsets.create_feature_set(db, lead, db.get(Project, rc["project_id"]), encoder_id=HANDCRAFTED,
                                      execution_mode="supervised_experiment", dataset_version_id=dv.id,
                                      params=feature_params(resolved))
        values = list(dv.config_json["label_values"])
        positive = "bcc_present"
        negative = next(v for v in values if v != positive)
        identity = training.compute_run_identity(
            encoder=enc, feature_set=fs, manifest=dv.manifest_json, dataset_version_id=dv.id, params=resolved,
            seed=seed, head="meanpool_logreg", execution_mode="supervised_experiment", evaluation_protocol=protocol,
            label_scope="slide", positive_class=positive, negative_class=negative, synthetic=False)
        run = TrainingRun(project_id=rc["project_id"], name="legacy fold-unsafe run (test)", dataset_version_id=dv.id,
                          dataset_manifest_sha256=dv.manifest_sha256, encoder_id=HANDCRAFTED, head="meanpool_logreg",
                          params_json=resolved, seed=seed, status="queued", synthetic=False, synthetic_reasons_json=[],
                          label_scope="slide", positive_class=positive, negative_class=negative,
                          execution_mode="supervised_experiment", feature_set_id=fs.id, evaluation_protocol=protocol,
                          identity_json=identity, identity_sha256=training.identity_sha256(identity),
                          weights_sha256=fs.weights_sha256, code_revision=identity["code_revision"],
                          deps_json=dependency_versions(), created_by=LEAD_ID)
        db.add(run)
        db.flush()
        job, _ = queue.enqueue(db, "train", {"run_id": run.id}, idempotency_key=f"train:{run.id}",
                               project_id=rc["project_id"], created_by=LEAD_ID)
        run.job_id = job.id
        return run.id


def _run_row(run_id: str):
    from dermpath.db import session_scope
    from dermpath.ml.models import TrainingRun

    with session_scope() as db:
        r = db.get(TrainingRun, run_id)
        db.expunge(r)
        return r


# =========================================================================== the leak (confirmation)


def test_every_reference_fit_slide_is_held_out_by_some_dev_cv_fold(ids):
    """Confirms the leak on the CURRENT plan: the macenko-v1 reference is planned on train-split slides, and under
    dev_cv every development patient is held out by exactly one fold. So every slide that shaped the shared reference
    is a held-out image of some fold whose fitting data were normalised with it."""
    from dermpath.ml import cv as cvlib
    from dermpath.ml import training

    rc = _cohort(ids, "proj-fold-leak")
    fs_id = create_set(rc["project_id"], encoder_id=HANDCRAFTED, execution_mode="supervised_experiment",
                       dataset_version_id=rc["dataset_version_id"], params=MACENKO)
    ref_slides = set(get_set(fs_id).stain_policy_json["reference_fit"]["train_slide_ids"])
    m = _manifest(rc["dataset_version_id"])
    dev_items = [it for it in m["items"] if it["split"] in ("train", "val")]
    bags = training.build_bags(dev_items, "slide", "bcc_present")
    ctx = training.split_context(m, rc["project_id"])
    folds = cvlib.grouped_stratified_kfold([b.label for b in bags], [b.patient_id for b in bags], k=3,
                                           patient_keys=training.patient_keys(bags), salt=training.cv_salt(ctx, 3),
                                           duplicate_pairs=ctx["duplicate_pairs"])
    held_by_fold = {f: {s for b in bags if folds.fold_of[b.patient_id] == f for s in b.slide_ids} for f in range(3)}
    leaking = [(f, s) for f, held in held_by_fold.items() for s in held & ref_slides]
    assert ref_slides and len(leaking) == len(ref_slides), (sorted(ref_slides), held_by_fold)


def test_fold_safety_classifies_learned_preprocessing_per_protocol():
    from dermpath.ml.training import preprocessing_fold_safety

    deferred = {"method": "macenko-v1", "deferred": True,
                "reference_fit": {"train_slide_ids": ["a", "b"], "fitted_on": "train-split slides"}}
    none = {"method": "none"}
    ok = preprocessing_fold_safety(deferred, protocol="holdout", params={"train_patient_fraction": 1.0})
    assert ok["status"] == "fold_safe" and ok["learned"] is True and ok["problems"] == []
    assert ok["provenance"] == "dataset_fitted_train_split"
    for protocol, frac in (("dev_cv", 1.0), ("dev_cv", 0.5), ("holdout", 0.5)):
        out = preprocessing_fold_safety(deferred, protocol=protocol, params={"train_patient_fraction": frac})
        assert out["status"] == "fold_unsafe" and out["code"] == CODE and out["problems"], (protocol, frac)
    for protocol in ("holdout", "dev_cv"):
        out = preprocessing_fold_safety(none, protocol=protocol, params={"train_patient_fraction": 0.5})
        assert out["status"] == "no_learned_preprocessing" and out["learned"] is False and out["problems"] == []
    # Unknown provenance of a learned transform fails closed (treated as dataset-fitted).
    odd = preprocessing_fold_safety({"method": "macenko-v1", "reference": {"x": 1}}, protocol="dev_cv",
                                    params={"train_patient_fraction": 1.0})
    assert odd["status"] == "fold_unsafe"


def test_holdout_verification_catches_fitting_slides_of_held_out_patients_and_their_duplicates():
    """Defence in depth for holdout: the fitting slides must be train-split material whose patients are disjoint
    from the validation / test patients INCLUDING confirmed-duplicate groups; otherwise fold_unsafe."""
    from dermpath.ml.training import preprocessing_fold_safety

    def item(i, split):
        return {"slide_id": f"s{i}", "coded_patient_id": f"p{i}", "patient_code": f"PT-{i}", "split": split}

    items = [item(0, "train"), item(1, "train"), item(2, "train"), item(3, "val"), item(4, "test")]
    manifest = {"items": items, "splits": [{"coded_patient_id": it["coded_patient_id"], "split": it["split"]}
                                           for it in items], "near_duplicate_decisions": []}
    plan = {"method": "macenko-v1", "deferred": True, "reference_fit": {"train_slide_ids": ["s0", "s1", "s2"]}}
    clean = preprocessing_fold_safety(plan, protocol="holdout", params={}, manifest=manifest)
    assert clean["status"] == "fold_safe" and clean["held_out_overlap"] == []
    assert clean["fitting_patient_codes"] == ["PT-0", "PT-1", "PT-2"]
    # A person confirmed s2 (train patient p2) and s3 (validation patient p3) as duplicates.
    dup = {**manifest, "near_duplicate_decisions": [{"slide_a": "s2", "slide_b": "s3", "decision": "duplicate"}]}
    out = preprocessing_fold_safety(plan, protocol="holdout", params={}, manifest=dup)
    assert out["status"] == "fold_unsafe" and out["code"] == CODE
    assert [(o["slide_id"], o["via"]) for o in out["held_out_overlap"]] == [
        ("s2", "confirmed duplicate of a held-out patient")]
    # A validation or test slide in the plan, or a slide outside the manifest.
    for bad in ("s3", "s4", "elsewhere"):
        out = preprocessing_fold_safety({**plan, "reference_fit": {"train_slide_ids": ["s0", bad]}},
                                        protocol="holdout", params={}, manifest=manifest)
        assert out["status"] == "fold_unsafe" and [o["slide_id"] for o in out["held_out_overlap"]] == [bad], bad
    # A learned transform whose fitting slides are not recorded cannot be verified.
    assert preprocessing_fold_safety({"method": "macenko-v1", "reference": {"x": 1}}, protocol="holdout", params={},
                                     manifest=manifest)["status"] == "fold_unsafe"


# =========================================================================== refusal at creation (API + service)


def test_api_refuses_dev_cv_on_a_dataset_fitted_macenko_reference(ids, clients):
    rc = _cohort(ids, "proj-fold-api")
    lead = clients(LEAD_ID)
    before = _counts()
    r = _post(lead, rc, protocol="dev_cv", params=MACENKO)
    assert r.status_code == 409, r.text
    err = r.json()["error"]
    assert err["code"] == CODE and err["details"]["evaluation_protocol"] == "dev_cv"
    assert err["details"]["stain_normalization"] == "macenko-v1" and err["details"]["problems"]
    assert "remedy" in err["details"]
    assert _counts() == before  # refused before any run or feature set is recorded
    # An explicit macenko feature set id is refused the same way.
    fs_id = create_set(rc["project_id"], encoder_id=HANDCRAFTED, execution_mode="supervised_experiment",
                       dataset_version_id=rc["dataset_version_id"], params=MACENKO)
    r = _post(lead, rc, protocol="dev_cv", params=MACENKO, feature_set_id=fs_id)
    assert r.status_code == 409 and r.json()["error"]["code"] == CODE, r.text


@pytest.mark.parametrize("protocol", ["holdout", "dev_cv"])
def test_api_refuses_learning_curve_subsets_on_a_dataset_fitted_macenko_reference(ids, clients, protocol):
    rc = _cohort(ids, f"proj-fold-lc-{protocol}")
    r = _post(clients(LEAD_ID), rc, protocol=protocol,
              params={**MACENKO, "train_patient_fraction": 0.5, "subset_repeat": 0})
    assert r.status_code == 409, r.text
    assert r.json()["error"]["code"] == CODE
    assert any("learning-curve" in p for p in r.json()["error"]["details"]["problems"])


def test_service_refuses_too(ids):
    from dermpath.db import session_scope
    from dermpath.errors import ApiError
    from dermpath.ml.service import create_experiment
    from dermpath.models import Project

    rc = _cohort(ids, "proj-fold-svc")
    with session_scope() as db, pytest.raises(ApiError) as exc:
        create_experiment(db, actors()["lead"], db.get(Project, rc["project_id"]),
                          dataset_version_id=rc["dataset_version_id"], encoder_id=HANDCRAFTED, head="abmil",
                          params=MACENKO, seed=0, name=None, evaluation_protocol="dev_cv")
    assert exc.value.code == CODE and exc.value.status == 409


# =========================================================================== refusal in the worker


def test_worker_refuses_a_legacy_dev_cv_run_on_a_dataset_fitted_macenko_reference(ids, clients):
    from dermpath.db import session_scope
    from dermpath.ml.engine_models import RunAttempt
    from dermpath.ml.models import Prediction

    rc = _cohort(ids, "proj-fold-worker")
    rid = _legacy_run(rc, protocol="dev_cv", params=MACENKO)
    out = run_jobs(["train", "build_feature_set"])
    assert [o.status for o in out] == ["failed"], [(o.status, o.error) for o in out]
    assert out[0].error.startswith(CODE), out[0].error
    run = _run_row(rid)
    assert run.status == "failed" and run.error.startswith(CODE) and run.checkpoint_sha256 is None
    fs = get_set(run.feature_set_id)
    assert fs.stain_reference_key is None and fs.status != "ready"  # refused before any build or fit
    with session_scope() as db:
        assert db.scalar(select(func.count(Prediction.id)).where(Prediction.run_id == rid)) == 0
        att = db.scalars(select(RunAttempt).where(RunAttempt.run_id == rid)).all()
        assert len(att) == 1 and att[0].outcome == "failed" and CODE in att[0].error
    body = clients(LEAD_ID).get(f"/api/v1/experiments/{rid}").json()
    safety = body["preprocessing_fold_safety"]
    assert safety["status"] == "fold_unsafe" and safety["valid_for_cv_comparison"] is False


def test_worker_refuses_a_legacy_learning_curve_run_on_a_dataset_fitted_macenko_reference(ids):
    rc = _cohort(ids, "proj-fold-worker-lc")
    rid = _legacy_run(rc, protocol="holdout", params={**MACENKO, "train_patient_fraction": 0.5})
    out = run_jobs(["train", "build_feature_set"])
    assert [o.status for o in out] == ["failed"] and out[0].error.startswith(CODE), [(o.status, o.error) for o in out]
    assert get_set(_run_row(rid).feature_set_id).stain_reference_key is None


def test_historical_contaminated_dev_cv_result_is_marked_invalid_for_cv_comparison(ids, clients, monkeypatch):
    """A dev_cv run trained on a dataset-fitted macenko reference by the previous code (simulated by switching the
    worker guard off) keeps its stored result, but every read of the run marks it invalid for cross-validated
    comparison, with the reason."""
    from dermpath.ml import training

    rc = _cohort(ids, "proj-fold-history")
    rid = _legacy_run(rc, protocol="dev_cv", params=MACENKO)
    with monkeypatch.context() as mp:
        mp.setattr(training, "preprocessing_fold_safety",
                   lambda *a, **k: {"status": "fold_safe", "problems": [], "learned": True}, raising=False)
        out = run_jobs(["train", "build_feature_set"])
    assert [o.status for o in out] == ["succeeded"], [(o.status, o.error) for o in out]
    lead = clients(LEAD_ID)
    body = lead.get(f"/api/v1/experiments/{rid}").json()
    assert body["status"] == "succeeded"
    safety = body["preprocessing_fold_safety"]
    assert safety["status"] == "fold_unsafe" and safety["valid_for_cv_comparison"] is False
    assert safety["code"] == CODE and safety["problems"]
    listed = {r["id"]: r for r in lead.get(f"/api/v1/projects/{rc['project_id']}/experiments").json()["items"]}
    assert listed[rid]["preprocessing_fold_safety"]["valid_for_cv_comparison"] is False


# =========================================================================== allowed combinations


def test_holdout_macenko_fits_its_reference_on_training_patients_only_and_records_it(ids, clients):
    """Holdout at fraction 1 keeps the train-only reference: the fitted slides are train-split slides whose patients
    (and confirmed-duplicate groups) are disjoint from the validation and test patients; the run records the fitting
    slide ids, their patient codes, the reference sha256 and the feature-set identity."""
    rc = _cohort(ids, "proj-fold-holdout")
    lead = clients(LEAD_ID)
    r = _post(lead, rc, protocol="holdout", params=MACENKO)
    assert r.status_code == 202, r.text
    rid = r.json()["experiment"]["id"]
    out = run_jobs(["train", "build_feature_set"])
    assert [o.status for o in out] == ["succeeded"], [(o.status, o.error) for o in out]
    run = _run_row(rid)
    fs = get_set(run.feature_set_id)
    pre = run.metrics_json["protocol"]["preprocessing"]
    assert pre["status"] == "fold_safe" and pre["learned"] is True
    assert pre["provenance"] == "dataset_fitted_train_split"
    assert pre["reference_sha256"] == fs.stain_reference_sha256 and pre["feature_set_spec_sha256"] == fs.spec_sha256
    m = _manifest(rc["dataset_version_id"])
    split_of_slide = {it["slide_id"]: it["split"] for it in m["items"]}
    code_split = {it["patient_code"]: it["split"] for it in m["items"]}
    fitted = set(pre["fitting_slide_ids"])
    assert fitted and all(split_of_slide[s] == "train" for s in fitted)
    fit_codes = set(pre["fitting_patient_codes"])
    held_codes = {c for c, sp in code_split.items() if sp in ("val", "test")}
    assert fit_codes and not (fit_codes & held_codes)
    assert pre["held_out_overlap"] == []
    body = lead.get(f"/api/v1/experiments/{rid}").json()
    assert body["preprocessing_fold_safety"]["status"] == "fold_safe"
    assert body["preprocessing_fold_safety"]["valid_for_cv_comparison"] is True


def test_dev_cv_without_learned_preprocessing_is_allowed_and_says_so(ids, clients):
    """Label-free fixed-encoder extraction is not learned preprocessing: dev_cv with stain_normalization none runs,
    and the run records that nothing was fitted on images."""
    lead = clients(LEAD_ID)
    body = {"dataset_version_id": cohort(ids)["dataset_version_id"], "encoder_id": SYNTH, "head": "meanpool_logreg",
            "seed": 0, "params": {**FAST, "cv_folds": 3}, "evaluation_protocol": "dev_cv"}
    r = lead.post(f"/api/v1/projects/{CID}/experiments", json=body)
    assert r.status_code == 202, r.text
    rid = r.json()["experiment"]["id"]
    assert [o.status for o in run_jobs()] == ["succeeded"]
    pre = _run_row(rid).metrics_json["protocol"]["preprocessing"]
    assert pre["status"] == "no_learned_preprocessing" and pre["learned"] is False
    assert "label-free" in pre["note"]
    safety = lead.get(f"/api/v1/experiments/{rid}").json()["preprocessing_fold_safety"]
    assert safety["valid_for_cv_comparison"] is True


# =========================================================================== comparisons refuse invalid runs


def test_family_and_benchmark_comparisons_refuse_runs_invalid_for_cv_comparison(ids, clients, monkeypatch):
    """Brief item 3, "existing contaminated results must be marked invalid for CV comparison": marking the run is
    not enough if comparison code still pairs it. Two historical dev_cv runs on a dataset-fitted macenko reference
    (trained by the previous code, simulated by switching the worker guard off) in one comparison family: the
    family's development comparison and the benchmark's paired comparison both refuse with
    ``fold_unsafe_preprocessing`` and name the runs, instead of reporting a paired difference."""
    from dermpath.db import session_scope
    from dermpath.ml import benchmark, training
    from dermpath.ml.models import TrainingRun
    from dermpath.models import DatasetVersion

    rc = _cohort(ids, "proj-fold-compare")
    a = _legacy_run(rc, protocol="dev_cv", params=MACENKO, seed=0)
    b = _legacy_run(rc, protocol="dev_cv", params=MACENKO, seed=1)
    with monkeypatch.context() as mp:
        mp.setattr(training, "preprocessing_fold_safety",
                   lambda *a_, **k: {"status": "fold_safe", "problems": [], "learned": True}, raising=False)
        out = run_jobs(["train", "build_feature_set"])
    assert sorted(o.status for o in out) == ["succeeded", "succeeded"], [(o.status, o.error) for o in out]
    lead = clients(LEAD_ID)
    fam = lead.post(f"/api/v1/projects/{rc['project_id']}/comparison-families",
                    json={"name": "historical macenko cv", "dataset_version_id": rc["dataset_version_id"]})
    assert fam.status_code == 201, fam.text
    fid = fam.json()["id"]
    for rid in (a, b):
        r = lead.post(f"/api/v1/comparison-families/{fid}/members", json={"run_id": rid})
        assert r.status_code in (200, 201), r.text
    dev = lead.get(f"/api/v1/comparison-families/{fid}?n_boot=50").json()["development_comparison"]
    assert dev["status"] == "refused" and dev["code"] == CODE, dev
    assert set(dev.get("run_ids") or []) == {a, b}, dev
    assert "result" not in dev
    with session_scope() as db:
        dv = db.get(DatasetVersion, rc["dataset_version_id"])
        runs = {"seed0": db.get(TrainingRun, a), "seed1": db.get(TrainingRun, b)}
        cmp_ = benchmark._compare(db, dv, runs, fixed={"encoder": HANDCRAFTED}, n_boot=50, seed=1, min_patients=2)
    assert cmp_["status"] == "refused" and cmp_["code"] == CODE, cmp_
    assert "result" not in cmp_
