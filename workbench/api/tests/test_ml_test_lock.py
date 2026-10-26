"""Acceptance 7 at the ML level: test items never reach training batches, threshold selection
or active learning; the test split opens only after the validation threshold is frozen, only
for the research lead, and every access is audited. Acceptance 11 end to end (single-class
validation/test splits)."""

from __future__ import annotations

import pytest
from sqlalchemy import func, select

from test_ml_support import BANNER, CID, LEAD, cohort, custom_dataset, manifest_ids, run_jobs, start, train


def test_training_threshold_and_batches_never_see_test(clients, ids, monkeypatch):
    from dermpath.ml import heads, training

    lead = clients(LEAD)
    dv = cohort(ids)["dataset_version_id"]
    splits = manifest_ids(dv)
    assert splits["test"] and splits["val"]
    purposes, fitted, thresholds = [], [], []
    real_items, real_fit, real_thr = training.training_eligible_items, heads.HEAD_FITTERS["abmil"], training.select_threshold

    def spy_items(db, dv_, purpose):
        purposes.append(purpose)
        return real_items(db, dv_, purpose)

    def spy_fit(train_bags, val_bags, params, seed, progress):
        fitted.append(({s for b in train_bags for s in b.slide_ids}, {s for b in val_bags for s in b.slide_ids}))
        return real_fit(train_bags, val_bags, params, seed, progress)

    def spy_thr(y, s, **kw):
        thresholds.append(len(y))
        return real_thr(y, s, **kw)

    monkeypatch.setattr(training, "training_eligible_items", spy_items)
    monkeypatch.setitem(training.HEAD_FITTERS, "abmil", spy_fit)
    monkeypatch.setattr(training, "select_threshold", spy_thr)
    run = train(lead, CID, dv, "abmil", seed=41)

    assert sorted(set(purposes)) == ["train", "validation"]  # "test_evaluation" is never requested by training
    train_seen, val_seen = fitted[0]
    assert train_seen <= splits["train"] and not (train_seen & splits["test"]) and not (train_seen & splits["val"])
    assert val_seen <= splits["val"] and not (val_seen & splits["test"])
    assert thresholds == [run["split_counts"]["val"]["bags"]]
    from dermpath.db import session_scope
    from dermpath.ml.models import Prediction, TrainingRun

    with session_scope() as db:
        r = db.get(TrainingRun, run["id"])
        assert set(r.provenance_json["train_bag_ids"]) <= splits["train"]
        assert set(r.threshold_json["val_bag_ids"]) == splits["val"] and r.provenance_json["test_items_used"] == 0
        preds = db.scalars(select(Prediction).where(Prediction.run_id == run["id"])).all()
        assert {p.split for p in preds} == {"train", "val"}
        assert not ({s for p in preds for s in p.slide_ids_json} & splits["test"])


def test_assert_no_test_catches_a_leaked_patient():
    from dermpath.datasets import TestSetLockViolation
    from dermpath.ml.heads import Bag
    from dermpath.ml.training import assert_no_test

    manifest = {"items": [{"slide_id": "s1", "split": "test"}, {"slide_id": "s2", "split": "train"}],
                "splits": [{"coded_patient_id": "pt-test", "split": "test"}]}
    ok = Bag("s2", "slide", ["s2"], "c", "pt-train", None, "bcc_present", 1, [], {})
    assert_no_test([ok], manifest, "training")
    for leaked in (Bag("s1", "slide", ["s1"], "c", "pt-x", None, "bcc_present", 1, [], {}),
                   Bag("s9", "slide", ["s9"], "c", "pt-test", None, "bcc_present", 1, [], {})):
        with pytest.raises(TestSetLockViolation):
            assert_no_test([ok, leaked], manifest, "training")


def test_test_split_is_locked_until_threshold_frozen_then_research_lead_only_and_audited(clients, ids):
    lead, path, director = clients(LEAD), clients("user-pathologist"), clients("user-director")
    dv = cohort(ids)["dataset_version_id"]
    queued = start(lead, CID, dv, "meanpool_logreg", seed=51)["experiment"]
    assert queued["threshold"] is None
    for c in (lead, path):
        r = c.get(f"/api/v1/experiments/{queued['id']}/evaluation?split=test")
        assert r.status_code == 409 and r.json()["error"]["code"] == "test_locked"
    r = lead.get(f"/api/v1/experiments/{queued['id']}/errors?split=test")
    assert r.status_code == 409 and r.json()["error"]["code"] == "test_locked"
    run_jobs()
    run = lead.get(f"/api/v1/experiments/{queued['id']}").json()
    assert run["status"] == "succeeded" and run["threshold"]["frozen_at"]
    # Readers of experiments may not open the test split.
    for c in (path, director):
        r = c.get(f"/api/v1/experiments/{run['id']}/evaluation?split=test")
        assert r.status_code == 403 and r.json()["error"]["code"] == "role_forbidden"
        assert c.get(f"/api/v1/experiments/{run['id']}/evaluation?split=val").status_code == 200
    ev = lead.get(f"/api/v1/experiments/{run['id']}/evaluation?split=test")
    assert ev.status_code == 200
    body = ev.json()
    assert body["split"] == "test" and body["synthetic"] is True and body["banner"] == BANNER
    assert body["threshold"]["value"] == run["threshold"]["value"] and body["threshold"]["selected_on"] == "val"
    assert body["computed_after_threshold_frozen_at"] == run["threshold"]["frozen_at"]
    assert body["computed_at"] > run["threshold"]["frozen_at"]
    assert body["n_items"] == run["split_counts"]["test"]["bags"]
    again = lead.get(f"/api/v1/experiments/{run['id']}/evaluation?split=test").json()
    assert again["evaluation_id"] == body["evaluation_id"]  # computed once, then stored
    errs = lead.get(f"/api/v1/experiments/{run['id']}/errors?split=test").json()
    assert errs["counts"]["n_items"] == body["n_items"]
    audit = lead.get(f"/api/v1/projects/{CID}/audit?entity_type=training_run&entity_id={run['id']}").json()["items"]
    actions = [e["action"] for e in audit]
    assert actions.count("experiment.test_evaluated") == 1 and actions.count("experiment.test_accessed") == 3
    assert all(e["actor_id"] == LEAD for e in audit if e["action"].startswith("experiment.test_"))
    # Test predictions are stored with the frozen threshold and were created after the freeze.
    from datetime import datetime

    from dermpath.db import session_scope
    from dermpath.ml.models import Prediction

    with session_scope() as db:
        tp = db.scalars(select(Prediction).where(Prediction.run_id == run["id"], Prediction.split == "test")).all()
        frozen = datetime.fromisoformat(run["threshold"]["frozen_at"])
        assert tp and all(p.threshold == run["threshold"]["value"] and p.created_at > frozen for p in tp)


def test_active_learning_proposes_from_train_only_and_never_labels(clients, ids):
    from dermpath.db import session_scope
    from dermpath.models import LabelVersion

    lead = clients(LEAD)
    c = cohort(ids)
    rid, dv = c["runs"]["abmil"], c["dataset_version_id"]
    splits = manifest_ids(dv)
    with session_scope() as db:
        n_labels = db.scalar(select(func.count(LabelVersion.id)))
    r = lead.post(f"/api/v1/projects/{CID}/active-learning", json={"dataset_version_id": dv, "run_id": rid, "k": 12,
                                                                   "random_fraction": 0.25})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["pool"] == "train_only" and body["creates_labels"] is False and "never expert truth" in body["notice"]
    assert body["synthetic"] is True and body["banner"] == BANNER
    assert len(body["items"]) == 12 and body["composition"] == {"uncertainty": 5, "diversity": 4, "random": 3}
    assert {i["reason"] for i in body["items"]} == {"uncertainty", "diversity", "random"}
    proposed = {s for i in body["items"] for s in i["slide_ids"]}
    assert proposed <= splits["train"] and not (proposed & (splits["val"] | splits["test"]))
    assert len({i["slide_id"] for i in body["items"]}) == 12  # no duplicates
    # The whole pool, any mix: still never validation or test.
    for frac in (0.0, 1.0):
        allr = lead.post(f"/api/v1/projects/{CID}/active-learning", json={
            "dataset_version_id": dv, "run_id": rid, "k": 500, "random_fraction": frac}).json()
        got = {s for i in allr["items"] for s in i["slide_ids"]}
        assert got == splits["train"] and allr["pool_size"] == len(splits["train"])
    with session_scope() as db:
        assert db.scalar(select(func.count(LabelVersion.id))) == n_labels  # proposals only
    # Guards: wrong dataset, wrong role, unfinished run.
    other = ids["ml_demo"]["workflow"]["dataset_version_id"]
    assert lead.post(f"/api/v1/projects/{CID}/active-learning", json={
        "dataset_version_id": other, "run_id": rid, "k": 3, "random_fraction": 0.2}).status_code == 404
    assert clients("user-pathologist").post(f"/api/v1/projects/{CID}/active-learning", json={
        "dataset_version_id": dv, "run_id": rid, "k": 3, "random_fraction": 0.2}).status_code == 403


def test_active_learning_pool_function_rejects_locked_items(monkeypatch):
    from dermpath.datasets import TestSetLockViolation
    from dermpath.ml.active_learning import propose
    from dermpath.models import DatasetVersion

    items = [{"slide_id": "a", "split": "train"}, {"slide_id": "b", "split": "test"}]
    dv = DatasetVersion(id="x", status="frozen", manifest_json={"items": items})

    class FakeRun:  # propose() must stop before it touches predictions
        id, seed, threshold_value, synthetic = "r", 0, 0.5, True

    import dermpath.ml.active_learning as al

    monkeypatch.setattr(al, "training_eligible_items", lambda db, d, p: items)  # a broken pool leaking a test item
    with pytest.raises(TestSetLockViolation):
        propose(None, FakeRun(), dv, k=1, random_fraction=0.0)


def test_single_class_validation_and_test_are_reported_honestly(clients, ids):
    """Acceptance 11 end to end: val and test contain only negative patients."""

    def assign(code, labels):
        n = int(code[-2:])
        if all(v == "bcc_absent_not_benign" for v in labels):
            return ("train", "val", "test")[n % 3]
        return "train"

    dv = custom_dataset(CID, "all-negative-val-test", assign)
    lead = clients(LEAD)
    run = train(lead, CID, dv, "meanpool_logreg", seed=1)
    thr = run["threshold"]
    assert thr["selection_status"] == "fallback" and thr["rule"] == "fixed_0.5_fallback" and thr["value"] == 0.5
    assert "lacks a class" in thr["reason"]
    for split in ("val", "test"):
        ev = lead.get(f"/api/v1/experiments/{run['id']}/evaluation?split={split}").json()
        assert ev["positives"] == 0 and ev["negatives"] == ev["n_items"] > 0
        m = ev["metrics"]
        assert m["sensitivity"]["value"] is None and m["sensitivity"]["denominator"] == 0
        assert m["sensitivity"]["undefined_reason"] == "undefined (denominator 0: no positive items)"
        assert m["auroc"]["defined"] is False and m["auprc"]["defined"] is False and m["auroc"]["ci"] is None
        assert m["specificity"]["denominator"] == ev["negatives"]
        assert (m["ppv"]["value"] is None) == (m["ppv"]["denominator"] == 0)
        assert all(s["status"] == "insufficient_evidence" for s in ev["subgroups"])
        assert ev["threshold"]["selection_status"] == "fallback"
        if ev["n_patients"] < 10:
            assert ev["bootstrap"]["status"].startswith("insufficient evidence")
            assert all(m[k]["ci"] is None for k in m)
        errs = lead.get(f"/api/v1/experiments/{run['id']}/errors?split={split}").json()
        assert errs["counts"]["false_negative"] == 0  # no positives → no false negatives


def test_role_permissions_on_ml_routes(clients, ids):
    c = cohort(ids)
    rid, dv = c["runs"]["meanpool_logreg"], c["dataset_version_id"]
    asst = clients("user-assistant")
    assert asst.get(f"/api/v1/projects/{CID}/experiments").status_code == 403  # experiment.read excludes assistants
    for uid in ("user-pathologist", "user-director"):
        cl = clients(uid)
        assert cl.get(f"/api/v1/experiments/{rid}").status_code == 200
        assert cl.post(f"/api/v1/projects/{CID}/experiments", json={
            "dataset_version_id": dv, "encoder_id": "synthetic-deterministic-v1", "head": "abmil", "seed": 0}
        ).status_code == 403
        assert cl.post(f"/api/v1/experiments/{rid}/register").status_code == 403
    # pathologist-2 is not a member of the cohort project.
    r = clients("user-pathologist-2").get(f"/api/v1/experiments/{rid}")
    assert r.status_code == 403 and r.json()["error"]["code"] == "not_project_member"
    assert clients.anon().get(f"/api/v1/experiments/{rid}").status_code == 401


def test_experiment_creation_validation(clients, ids):
    lead = clients(LEAD)
    c = cohort(ids)
    dv = c["dataset_version_id"]
    base = {"dataset_version_id": dv, "encoder_id": "synthetic-deterministic-v1", "head": "abmil", "seed": 0}
    url = f"/api/v1/projects/{CID}/experiments"
    assert lead.post(url, json={**base, "head": "svm"}).json()["error"]["code"] == "invalid_head"
    r = lead.post(url, json={**base, "params": {"lr": -1}})
    assert r.status_code == 422 and r.json()["error"]["code"] == "invalid_params"
    assert lead.post(url, json={**base, "params": {"bogus": 1}}).status_code == 422
    assert lead.post(url, json={**base, "encoder_id": "nope"}).json()["error"]["code"] == "unknown_encoder"
    assert lead.post(url, json={k: v for k, v in base.items() if k != "seed"}).status_code == 422
    # A draft dataset is refused.
    draft = lead.post(f"/api/v1/projects/{CID}/datasets", json={"name": "draft", "config": {}}).json()
    r = lead.post(url, json={**base, "dataset_version_id": draft["id"]})
    assert r.status_code == 409 and r.json()["error"]["code"] == "dataset_not_frozen"
    # A dataset of another project is not found here.
    other = ids["ml_demo"]["workflow"]["dataset_version_id"]
    assert lead.post(url, json={**base, "dataset_version_id": other}).status_code == 404
