"""Outer-fold stability (owner's brief item 7: "multiple predeclared training seeds ... without changing folds
between heads"; design §6 "Folds and seeds"). Research use only.

Contract:

* dev_cv folds are a function of the frozen manifest's development pool (train ∪ val patients and their
  confirmed-duplicate groups, by content-stable patient code), k and a declared ``cv_fold_seed`` only: never of the
  head, the training seed, or which bags the run's feature set could score. The fold seed and k are part of the run
  identity (``identity.fold_assignment``); ``cv_fold_seed`` 0 keeps the salt (and therefore the folds) of runs made
  before the parameter existed.
* Defect fixed here: the worker dropped bags without tissue patches BEFORE assigning folds, so two encoders (two
  feature sets) on one manifest could get different folds whenever one of them could not score a slide, and the
  unscorable patient vanished from the fold map.
* Learning-curve subsets are drawn WITHIN each fold: a fold's fitting subset is the nested stratified fraction of
  that fold's own fitting patients (a function of its fitting part only, never of its held-out patients or their
  labels); the final model's subset is the same fraction of the whole development pool.
"""

from __future__ import annotations

import hashlib
import uuid

import numpy as np
import pytest

from test_ml_support import CID, FAST, LEAD, SYNTH, cohort, run_jobs

DIM = 8
CTX = {"split_salt": "fold-stability", "patient_label_rule": "any_positive", "duplicate_pairs": []}


def _params(**kw):
    from dermpath.ml.config import resolve_params

    return resolve_params({"max_epochs": 4, "patience": 2, "n_boot": 50, "hidden_dim": 8, "attn_dim": 4, **kw})


def _items(n_patients=30, *, pos_every=3, slides=(1, 2)):
    rows = []
    for i in range(n_patients):
        code = f"FS-{i:03d}"
        label = "bcc_present" if i % pos_every == 0 else "bcc_absent_not_benign"
        pid, cid = uuid.uuid4().hex, uuid.uuid4().hex
        for j in range(slides[i % len(slides)]):
            rows.append({"slide_id": uuid.uuid4().hex, "case_id": cid, "coded_patient_id": pid, "patient_code": code,
                         "accession_code": f"FSA-{i:03d}", "label_value": label,
                         "slide_sha256": hashlib.sha256(f"{code}|{j}".encode()).hexdigest(),
                         "label_version_id": uuid.uuid4().hex, "split": "val" if i % 5 == 0 else "train",
                         "scanner_id": "s", "site_id": "x", "stain": "H&E"})
    return rows


def _bags(items, *, unscorable: set[str] = frozenset()):
    from dermpath.ml.training import build_bags

    bags = build_bags(items, "slide", "bcc_present")
    for b in bags:
        if b.patient_code in unscorable:
            b.patch_counts = [0] * len(b.slide_ids)  # this feature set has no tissue patch for the slide
            continue
        rng = np.random.default_rng(int(b.slide_sha256s[0][:8], 16))
        e = rng.normal(size=(4 + int(b.slide_sha256s[0][:2], 16) % 5, DIM)).astype(np.float32)
        e[:, 0] += 1.2 * b.label
        b.embeddings = e
    return bags


def _mem():
    from dermpath.ml.heads import IN_MEMORY

    return IN_MEMORY


# =========================================================================== pure


def test_folds_are_shared_by_every_head_and_training_seed():
    from dermpath.ml.training import run_dev_cv

    bags = _bags(_items(24))
    maps = {(h, s): run_dev_cv(bags, head=h, params=_params(cv_folds=4), seed=s, access=_mem(), context=CTX)
            .cv["fold_of_patient_code"] for h in ("meanpool_logreg", "abmil") for s in (0, 5)}
    assert len({tuple(sorted(m.items())) for m in maps.values()}) == 1, maps


def test_folds_do_not_depend_on_which_bags_a_feature_set_can_score():
    """Same manifest, two feature sets: one cannot score two patients' slides. The fold map is identical (the
    unscorable patients keep their fold), and their bags are reported unscorable in that fold, never imputed."""
    from dermpath.ml.training import run_dev_cv

    items = _items(30)
    full = run_dev_cv(_bags(items), head="meanpool_logreg", params=_params(cv_folds=4), seed=0, access=_mem(),
                      context=CTX)
    holes = {"FS-000", "FS-004"}
    part = run_dev_cv(_bags(items, unscorable=holes), head="meanpool_logreg", params=_params(cv_folds=4), seed=0,
                      access=_mem(), context=CTX)
    assert part.cv["fold_of_patient_code"] == full.cv["fold_of_patient_code"]
    assert part.cv["fingerprint"] == full.cv["fingerprint"]
    un = [u for u in part.unscored if u["patient_code"] in holes]
    assert un and all(u["fold"] == full.cv["fold_of_patient_code"][u["patient_code"]] for u in un)
    assert all("no tissue patches" in u["reason"] for u in un)
    assert not {sb.bag.patient_code for sb in part.dev} & holes


def test_fold_seed_is_declared_and_zero_keeps_the_previous_folds():
    from dermpath.ml import cv as cvlib
    from dermpath.ml.training import patient_keys, run_dev_cv

    p0 = _params(cv_folds=4)
    assert p0["cv_fold_seed"] == 0
    bags = _bags(_items(24))
    a = run_dev_cv(bags, head="meanpool_logreg", params=p0, seed=1, access=_mem(), context=CTX)
    keys = patient_keys(bags)
    legacy = cvlib.grouped_stratified_kfold([b.label for b in bags], [b.patient_id for b in bags], k=4,
                                            patient_keys=keys, salt=f"{CTX['split_salt']}|cv|k=4")
    assert a.cv["fold_of_patient_code"] == {keys[p]: f for p, f in legacy.fold_of.items()}
    assert a.cv["fold_seed"] == 0
    b = run_dev_cv(bags, head="meanpool_logreg", params=_params(cv_folds=4, cv_fold_seed=7), seed=1, access=_mem(),
                   context=CTX)
    assert b.cv["fold_seed"] == 7 and b.cv["fold_of_patient_code"] != a.cv["fold_of_patient_code"]
    with pytest.raises(ValueError):
        _params(cv_fold_seed=-1)


def test_learning_curve_subsets_are_drawn_within_each_fold():
    from dermpath.ml import training

    bags = _bags(_items(40))
    fits = []
    real = training.fit_head

    def spy(head, fit_bags, params, seed, progress, *, access, context):
        fits.append({b.bag_id for b in fit_bags})
        return real(head, fit_bags, params, seed, progress, access=access, context=context)

    params = _params(cv_folds=4, train_patient_fraction=0.5, subset_repeat=0)
    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(training, "fit_head", spy)
        out = training.run_dev_cv(bags, head="meanpool_logreg", params=params, seed=0, access=_mem(), context=CTX)
    fold_of = out.cv["fold_of"]
    assert len(fits) == 5
    for f in range(4):
        fit_part = [b for b in bags if fold_of[b.patient_id] != f]
        expected, info = training.learning_curve_subset(fit_part, params, CTX)
        assert fits[f] == {b.bag_id for b in expected}, f"fold {f}: subset not drawn from its own fitting part"
        assert {b.label for b in expected} == {0, 1}
        summ = out.cv["folds_summary"][f]["learning_curve"]
        assert summ["n_patients"] == info["n_patients"] and summ["fingerprint"] == info["fingerprint"]
        assert summ["pool_patients"] == len({b.patient_id for b in fit_part})
    final, _ = training.learning_curve_subset(bags, params, CTX)
    assert fits[-1] == {b.bag_id for b in final}
    # Within a fold the subsets stay nested across fractions.
    quarter = _params(cv_folds=4, train_patient_fraction=0.25, subset_repeat=0)
    for f in range(4):
        fit_part = [b for b in bags if fold_of[b.patient_id] != f]
        q, _ = training.learning_curve_subset(fit_part, quarter, CTX)
        h, _ = training.learning_curve_subset(fit_part, params, CTX)
        assert {b.bag_id for b in q} <= {b.bag_id for b in h}


# =========================================================================== worker


def _service_run(ids, head, *, params, seed, protocol="dev_cv"):
    from dermpath.auth import Actor
    from dermpath.db import session_scope
    from dermpath.ml.service import create_experiment
    from dermpath.models import Project

    with session_scope() as db:
        run, _ = create_experiment(db, Actor(LEAD, "research_lead", "Priya Navarro"), db.get(Project, CID),
                                   dataset_version_id=cohort(ids)["dataset_version_id"], encoder_id=SYNTH, head=head,
                                   params=params, seed=seed, name=None, evaluation_protocol=protocol)
        return run.id


def _run(rid):
    from dermpath.db import session_scope
    from dermpath.ml.models import TrainingRun

    with session_scope() as db:
        r = db.get(TrainingRun, rid)
        db.expunge(r)
        return r


def test_worker_folds_are_identical_across_heads_seeds_and_scorability(env, ids, monkeypatch):
    """Two dev_cv runs on one manifest (different head and training seed); in the second, the feature set cannot
    score one development patient's slides. Both runs record the same fold map and fold identity."""
    from dermpath.db import session_scope
    from dermpath.ml import training
    from dermpath.models import DatasetVersion

    params = {**FAST, "cv_folds": 3, "max_epochs": 3, "patience": 2}
    a = _service_run(ids, "meanpool_logreg", params=params, seed=0)
    assert [o.status for o in run_jobs()] == ["succeeded"]
    with session_scope() as db:
        items = db.get(DatasetVersion, cohort(ids)["dataset_version_id"]).manifest_json["items"]
    victim = sorted(it["patient_code"] for it in items if it["split"] in ("train", "val"))[0]
    real_describe = training.FeatureSetAccess.describe

    def describe(self, bag):
        real_describe(self, bag)
        if bag.patient_code == victim:
            bag.patch_counts = [0] * len(bag.slide_ids)

    monkeypatch.setattr(training.FeatureSetAccess, "describe", describe)
    b = _service_run(ids, "abmil", params=params, seed=9)
    assert [o.status for o in run_jobs()] == ["succeeded"]
    ra, rb = _run(a), _run(b)
    ca, cb = ra.metrics_json["protocol"]["cv"], rb.metrics_json["protocol"]["cv"]
    assert victim in cb["fold_of_patient_code"]
    assert cb["fold_of_patient_code"] == ca["fold_of_patient_code"] and cb["fingerprint"] == ca["fingerprint"]
    assert ra.identity_json["fold_assignment"] == rb.identity_json["fold_assignment"]
    fa = ra.identity_json["fold_assignment"]
    assert fa["protocol"] == "dev_cv" and fa["k"] == 3 and fa["fold_seed"] == 0
    un = [u for u in rb.metrics_json["unscored_bags"] if u.get("patient_code") == victim]
    assert un and all(u["fold"] == ca["fold_of_patient_code"][victim] for u in un)


def test_fold_seed_is_part_of_the_run_identity(env, ids):
    params = {**FAST, "cv_folds": 3}
    a = _run(_service_run(ids, "meanpool_logreg", params={**params, "cv_fold_seed": 2}, seed=0))
    b = _run(_service_run(ids, "meanpool_logreg", params=params, seed=0))
    h = _run(_service_run(ids, "meanpool_logreg", params=FAST, seed=0, protocol="holdout"))
    assert a.identity_json["fold_assignment"]["fold_seed"] == 2 and b.identity_json["fold_assignment"]["fold_seed"] == 0
    assert a.identity_json["fold_assignment"]["k"] == 3
    assert "content" in a.identity_json["fold_assignment"]["keyed_by"]
    assert a.identity_sha256 != b.identity_sha256
    assert h.identity_json["fold_assignment"] is None


def test_comparisons_refuse_dev_cv_runs_with_different_fold_assignments(env, ids, clients):
    """Brief item 7 ("the same ... outer folds" for every compared model): a declared ``cv_fold_seed`` (or k) makes a
    different outer-fold assignment. The family's development comparison and the benchmark's paired comparison
    refuse to pair such runs (``mixed_fold_assignment``); runs with the same declared folds are still compared."""
    from dermpath.db import session_scope
    from dermpath.ml import benchmark
    from dermpath.ml.models import TrainingRun
    from dermpath.models import DatasetVersion

    params = {**FAST, "cv_folds": 3, "min_threshold_evidence": 5}
    a = _service_run(ids, "meanpool_logreg", params=params, seed=0)
    b = _service_run(ids, "meanpool_logreg", params={**params, "cv_fold_seed": 7}, seed=0)
    c = _service_run(ids, "meanpool_logreg", params=params, seed=1)
    assert [o.status for o in run_jobs()] == ["succeeded"] * 3
    dv_id = cohort(ids)["dataset_version_id"]
    lead = clients(LEAD)

    def family(name, members):
        fam = lead.post(f"/api/v1/projects/{CID}/comparison-families", json={"name": name, "dataset_version_id": dv_id})
        assert fam.status_code == 201, fam.text
        for rid in members:
            r = lead.post(f"/api/v1/comparison-families/{fam.json()['id']}/members", json={"run_id": rid})
            assert r.status_code in (200, 201), r.text
        return lead.get(f"/api/v1/comparison-families/{fam.json()['id']}?n_boot=50").json()["development_comparison"]

    mixed = family("mixed folds", [a, b])
    assert mixed["status"] == "refused" and mixed["code"] == "mixed_fold_assignment", mixed
    assert "result" not in mixed
    same = family("same folds", [a, c])
    assert same.get("code") != "mixed_fold_assignment", same
    with session_scope() as db:
        dv = db.get(DatasetVersion, dv_id)
        ra, rb, rc_ = (db.get(TrainingRun, r) for r in (a, b, c))
        refused = benchmark._compare(db, dv, {"a": ra, "b": rb}, fixed={"head": "meanpool_logreg"}, n_boot=50,
                                     seed=1, min_patients=2)
        kept = benchmark._compare(db, dv, {"a": ra, "c": rc_}, fixed={"head": "meanpool_logreg"}, n_boot=50,
                                  seed=1, min_patients=2)
    assert refused["status"] == "refused" and refused["code"] == "mixed_fold_assignment", refused
    assert kept.get("code") != "mixed_fold_assignment", kept
