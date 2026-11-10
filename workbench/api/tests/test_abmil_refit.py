"""ABMIL final-refit semantics (owner's brief item 7; design §6 "ABMIL fitting"). Research use only.

The defect: ``fit_abmil`` fitted on the INNER fit part of its training patients (default 80 %), used the inner
hold-out only for early stopping and kept that model, so the "final model refitted on the whole development pool"
of ``dev_cv`` (and the holdout model) never saw a fifth of its permitted patients, while summaries claimed the whole
pool. Normalisation statistics and class weights came from the inner fit part only.

The contract now, for every ABMIL fit (holdout model, each dev_cv fold model, the dev_cv final model):

1. epoch selection: an inner patient-grouped stratified split of the PERMITTED fitting patients only (never
   validation, never an outer held-out fold, never test); train on the inner fit part, monitor the inner hold-out,
   select the best epoch count;
2. refit: reinitialise (same seed) and fit on ALL permitted fitting patients for exactly that many epochs, with
   normalisation and class weights from all of them, and no early stopping.

Reported counts say which patients and bags each phase used.
"""

from __future__ import annotations

import hashlib
import uuid

import numpy as np
import pytest
from sqlalchemy import select

from test_ml_support import CID, FAST, LEAD, SYNTH, cohort, run_jobs

DIM = 8
CTX = {"split_salt": "abmil-refit-salt", "patient_label_rule": "any_positive", "duplicate_pairs": []}


def _params(**kw):
    from dermpath.ml.config import resolve_params

    return resolve_params({"max_epochs": 8, "patience": 3, "n_boot": 50, "hidden_dim": 8, "attn_dim": 4, **kw})


def _items(n_patients=30, *, pos_every=3, slides=(1, 2), split_of=None):
    rows = []
    for i in range(n_patients):
        code = f"AR-{i:03d}"
        label = "bcc_present" if i % pos_every == 0 else "bcc_absent_not_benign"
        pid, cid = uuid.uuid4().hex, uuid.uuid4().hex
        for j in range(slides[i % len(slides)]):
            rows.append({"slide_id": uuid.uuid4().hex, "case_id": cid, "coded_patient_id": pid, "patient_code": code,
                         "accession_code": f"ARA-{i:03d}", "label_value": label,
                         "slide_sha256": hashlib.sha256(f"{code}|{j}".encode()).hexdigest(),
                         "label_version_id": uuid.uuid4().hex, "split": (split_of or (lambda k: "train"))(i),
                         "scanner_id": "s", "site_id": "x", "stain": "H&E"})
    return rows


def _bags(items):
    from dermpath.ml.training import build_bags

    bags = build_bags(items, "slide", "bcc_present")
    for b in bags:
        rng = np.random.default_rng(int(b.slide_sha256s[0][:8], 16))
        e = rng.normal(size=(5 + int(b.slide_sha256s[0][:2], 16) % 6, DIM)).astype(np.float32)
        e[:, 0] += 1.3 * b.label
        b.embeddings = e
    return bags


class Recording:
    """In-memory access recording which bag ids are read."""

    def __init__(self):
        from dermpath.ml.heads import IN_MEMORY

        self.inner, self.reads = IN_MEMORY, []

    def parts(self, bag):
        self.reads.append(bag.bag_id)
        return self.inner.parts(bag)

    def embeddings(self, bag):
        self.reads.append(bag.bag_id)
        return self.inner.embeddings(bag)

    def mean(self, bag):
        self.reads.append(bag.bag_id)
        return self.inner.mean(bag)


def _ids(bags):
    return {b.bag_id for b in bags}


# =========================================================================== pure


def test_holdout_abmil_is_refitted_on_every_training_patient_for_the_selected_epoch_count():
    from dermpath.ml import training
    from dermpath.ml.heads import IN_MEMORY

    bags = _bags(_items(30, split_of=lambda i: "val" if i % 4 == 0 else "train"))
    train = [b for b in bags if b.split == "train"]
    val = [b for b in bags if b.split == "val"]
    params = _params(max_epochs=10, patience=3)
    out = training.run_holdout(train, val, head="abmil", params=params, seed=1, access=IN_MEMORY, context=CTX)
    s = out.summary
    sel, fin = s["epoch_selection"], s["final_fit"]
    n_pat = len({b.patient_id for b in train})
    assert sel["status"] == "selected" and 1 <= sel["best_epoch"] <= sel["epochs_run"] <= params["max_epochs"]
    assert fin["epochs"] == sel["best_epoch"] == s["best_epoch"] and fin["early_stopping"].startswith("none")
    assert fin["bags"] == len(train) == s["fit_bags"] == s["train_bags"] and fin["patients"] == n_pat
    assert sel["fit"]["patients"] + sel["holdout"]["patients"] == n_pat
    assert sel["fit"]["bags"] + sel["holdout"]["bags"] == len(train)
    held_keys = set(sel["holdout_patient_keys"])
    assert held_keys and held_keys <= {b.patient_key for b in train}
    assert not held_keys & {b.patient_key for b in val}
    # Normalisation and class weights of the FINAL model come from every training bag (never validation).
    inst = np.concatenate([b.embeddings.astype(np.float64) for b in train])
    assert np.allclose(out.arrays["input_mean"], inst.mean(axis=0), atol=1e-5)
    n1 = sum(b.label for b in train)
    assert s["class_weights"]["counts"] == {"positive": n1, "negative": len(train) - n1}
    eff = training.effective_sampling(out.fit_bags, params, s)
    assert eff["class_counts"]["bags"] == {"positive": n1, "negative": len(train) - n1}
    assert eff["epoch_selection"]["holdout_patients"] == sel["holdout"]["patients"]
    assert eff["epoch_selection"]["fit_patients"] == sel["fit"]["patients"]
    assert "validation never seen" in s["early_stopping"]


def test_the_refit_is_a_fresh_fixed_epoch_fit_on_all_fitting_bags():
    """Bit-identical to reinitialising and fitting every bag for the selected number of epochs."""
    from dermpath.ml import heads

    train = _bags(_items(24))
    p = _params(max_epochs=9, patience=2)
    arrays, meta, summary = heads.fit_abmil(train, p, 4, access=heads.IN_MEMORY, **CTX)
    ref_arrays, ref_meta, ref_summary = heads.fit_abmil_fixed_epochs(train, p, 4, epochs=summary["best_epoch"],
                                                                     access=heads.IN_MEMORY)
    assert sorted(arrays) == sorted(ref_arrays)
    for k in arrays:
        assert np.array_equal(arrays[k], ref_arrays[k]), k
    assert ref_summary["final_fit"]["epochs"] == summary["best_epoch"] == summary["final_fit"]["epochs"]
    assert meta["fit_semantics"] == heads.ABMIL_FIT_SEMANTICS


@pytest.mark.parametrize("fraction", [1.0, 0.5])
def test_each_abmil_phase_sees_only_its_permitted_patients_under_dev_cv(fraction):
    """For every fold model and the final model: epoch selection splits ONLY that fit's permitted patients (inner
    fit part + inner hold-out = the fitting part, patient-disjoint), the refit uses exactly the fitting part for the
    selected epoch count, and no phase reads the outer held-out fold."""
    from dermpath.ml import heads, training

    bags = _bags(_items(36, slides=(1, 2, 3)))
    k = 4
    calls: list[dict] = []
    real_select, real_fixed, real_fit = heads.select_abmil_epochs, heads.fit_abmil_fixed_epochs, training.fit_head
    access = Recording()

    def spy_select(fit_bags, stop_bags, params, seed, *a, **kw):
        res = real_select(fit_bags, stop_bags, params, seed, *a, **kw)
        calls[-1]["select"] = {"fit": _ids(fit_bags), "stop": _ids(stop_bags), "best": res["best_epoch"],
                               "fit_p": {b.patient_id for b in fit_bags}, "stop_p": {b.patient_id for b in stop_bags}}
        return res

    def spy_fixed(fit_bags, params, seed, *a, epochs, **kw):
        calls[-1]["refit"] = {"bags": _ids(fit_bags), "epochs": epochs}
        return real_fixed(fit_bags, params, seed, *a, epochs=epochs, **kw)

    def spy_fit(head, fit_bags, params, seed, progress, *, access, context):
        start = len(access.reads)
        calls.append({"given": _ids(fit_bags)})
        out = real_fit(head, fit_bags, params, seed, progress, access=access, context=context)
        calls[-1]["read"] = set(access.reads[start:])
        return out

    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(heads, "select_abmil_epochs", spy_select)
        mp.setattr(heads, "fit_abmil_fixed_epochs", spy_fixed)
        mp.setattr(training, "fit_head", spy_fit)
        params = _params(cv_folds=k, max_epochs=6, patience=2, train_patient_fraction=fraction,
                         **({"subset_repeat": 0} if fraction < 1 else {}))
        out = training.run_dev_cv(bags, head="abmil", params=params, seed=3, access=access, context=CTX)
    assert len(calls) == k + 1
    held = {f: {sb.bag.bag_id for sb in out.dev if sb.fold == f} for f in range(k)}
    for i, c in enumerate(calls):
        sel, ref = c["select"], c["refit"]
        assert sel["fit"] | sel["stop"] == c["given"] and not (sel["fit_p"] & sel["stop_p"]), i
        assert ref["bags"] == c["given"] and ref["epochs"] == sel["best"], i
        assert c["read"] <= c["given"], f"fit {i} read bags it was not given"
        if i < k:
            assert held[i] and not (c["read"] & held[i]), f"fold {i} read its outer held-out bags"
    if fraction == 1.0:
        assert calls[-1]["refit"]["bags"] == _ids(bags)  # the final model: the whole development pool
    fin = out.summary
    assert fin["final_fit"]["bags"] == len(calls[-1]["given"]) and fin["final_model"].startswith("refitted")


def test_without_an_inner_hold_out_the_fit_uses_every_bag_for_max_epochs_and_says_so():
    from dermpath.ml import heads

    train = _bags(_items(2, pos_every=2, slides=(4, 5)))  # one positive and one negative patient
    p = _params(max_epochs=4)
    _, _, s = heads.fit_abmil(train, p, 0, access=heads.IN_MEMORY, **CTX)
    assert s["epoch_selection"]["status"] == "not_possible" and s["epoch_selection"]["reason"]
    assert s["best_epoch"] is None and s["final_fit"]["epochs"] == 4 and s["final_fit"]["bags"] == len(train)


# =========================================================================== worker


def _service_run(ids, head, *, params, seed, protocol):
    from dermpath.auth import Actor
    from dermpath.db import session_scope
    from dermpath.ml.service import create_experiment
    from dermpath.models import Project

    with session_scope() as db:
        run, _ = create_experiment(db, Actor(LEAD, "research_lead", "Priya Navarro"), db.get(Project, CID),
                                   dataset_version_id=cohort(ids)["dataset_version_id"], encoder_id=SYNTH, head=head,
                                   params=params, seed=seed, name=None, evaluation_protocol=protocol)
        return run.id


def _run_and_preds(rid):
    from dermpath.db import session_scope
    from dermpath.ml.models import Prediction, TrainingRun

    with session_scope() as db:
        run = db.get(TrainingRun, rid)
        db.expunge(run)
        preds = db.scalars(select(Prediction).where(Prediction.run_id == rid)).all()
        rows = [(p.split, p.bag_id, p.coded_patient_id, p.label) for p in preds]
    return run, rows


def test_dev_cv_abmil_run_reports_accurate_fitting_and_epoch_selection_counts(env, ids, clients):
    rid = _service_run(ids, "abmil", params={**FAST, "max_epochs": 6, "patience": 2, "cv_folds": 3}, seed=5,
                       protocol="dev_cv")
    assert [o.status for o in run_jobs()] == ["succeeded"]
    run, rows = _run_and_preds(rid)
    t = run.metrics_json["training"]
    oof = [r for r in rows if r[0] == "oof"]
    train_rows = [r for r in rows if r[0] == "train"]  # the final model's in-sample scores on its fitting bags
    dev_patients = {r[2] for r in oof}
    assert t["final_fit"]["bags"] == len(train_rows) == len(oof)
    assert t["final_fit"]["patients"] == len(dev_patients)
    sel = t["epoch_selection"]
    assert sel["fit"]["patients"] + sel["holdout"]["patients"] == len(dev_patients)
    assert t["final_fit"]["epochs"] == sel["best_epoch"]
    assert t["final_model"].startswith("refitted") and "inner" in t["final_model"]
    for f in t["folds"]:
        fs = f["summary"]
        assert fs["final_fit_patients"] == f["fit_patients"] and fs["final_fit_bags"] == f["fit_bags"]
        assert fs["epoch_selection_fit_patients"] + fs["epoch_selection_holdout_patients"] == f["fit_patients"]
        assert fs["final_fit_epochs"] == fs["best_epoch"]
    eff = run.metrics_json["effective_sampling"]
    n1 = sum(r[3] for r in train_rows)
    assert eff["class_counts"]["bags"] == {"positive": n1, "negative": len(train_rows) - n1}
    assert eff["epoch_selection"]["holdout_patients"] == sel["holdout"]["patients"]
    roles = run.metrics_json["protocol"]["roles"]
    assert "refit" in roles["fitting"] and "never" in roles["early_stopping"]
    body = clients(LEAD).get(f"/api/v1/experiments/{rid}").json()
    assert body["training_summary"]["final_fit"]["patients"] == len(dev_patients)


def test_holdout_abmil_run_refits_on_all_training_patients(env, ids):
    from dermpath.db import session_scope
    from dermpath.models import DatasetVersion

    rid = _service_run(ids, "abmil", params={**FAST, "max_epochs": 6, "patience": 2}, seed=6, protocol="holdout")
    assert [o.status for o in run_jobs()] == ["succeeded"]
    run, rows = _run_and_preds(rid)
    t = run.metrics_json["training"]
    train_rows = [r for r in rows if r[0] == "train"]
    assert t["final_fit"]["bags"] == len(train_rows) == len(run.provenance_json["train_bag_ids"])
    assert t["final_fit"]["patients"] == len({r[2] for r in train_rows})
    with session_scope() as db:
        items = db.get(DatasetVersion, run.dataset_version_id).manifest_json["items"]
    codes = {sp: {it["patient_code"] for it in items if it["split"] == sp} for sp in ("train", "val", "test")}
    held = set(t["epoch_selection"]["holdout_patient_keys"])
    assert held and held <= codes["train"] and not held & (codes["val"] | codes["test"])
    assert t["epoch_selection"]["fit"]["patients"] + t["epoch_selection"]["holdout"]["patients"] == \
        t["final_fit"]["patients"]
    assert run.metrics_json["protocol"]["roles"]["early_stopping"].endswith("never validation")
