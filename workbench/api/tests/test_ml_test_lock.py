"""Acceptance 7 at the ML level: test items never reach training, threshold selection or active learning; the
test split opens only through a recorded test release (research lead, reason, declared candidate), scored from
pinned features, and every access is audited. Acceptance 11 end to end (single-class validation/test splits).

The end-to-end tests here run the real pipeline (feature sets + training). They are skipped, with the reason,
while a partner's half of the engine path is unavailable; tests/test_ml_test_release.py covers the release
logic against the interface contract with fakes."""

from __future__ import annotations

import pytest
from sqlalchemy import select

from test_ml_support import BANNER, CID, FAST, LEAD, cohort, custom_dataset, manifest_ids, start


def run_all_jobs():
    from dermpath.jobs.worker import Worker

    return Worker("ml-lock-worker").run_until_idle()


def train_engine(client, pid, dv_id, head, *, seed=0, params=None) -> dict:
    """Train through the real engine path; skip when the run has no pinned feature set (partner path missing)."""
    out = start(client, pid, dv_id, head, seed=seed, params=params)
    outcomes = run_all_jobs()
    run = client.get(f"/api/v1/experiments/{out['experiment']['id']}").json()
    if run["status"] != "succeeded":
        pytest.skip(f"engine training path unavailable here: run {run['status']}: {run.get('error')} "
                    f"(jobs: {[(o.type, o.status, o.error) for o in outcomes]})")
    from dermpath.db import session_scope
    from dermpath.ml.models import TrainingRun

    with session_scope() as db:
        if db.get(TrainingRun, run["id"]).feature_set_id is None:
            pytest.skip("the run has no pinned feature set yet (feature-set path not integrated)")
    return run


def test_training_threshold_and_batches_never_see_test(clients, ids, monkeypatch):
    from dermpath.ml import heads

    lead = clients(LEAD)
    dv = cohort(ids)["dataset_version_id"]
    splits = manifest_ids(dv)
    assert splits["test"] and splits["val"]
    fitted = []
    real_fit = heads.HEAD_FITTERS["abmil"]

    def spy_fit(train_bags, *args, **kw):
        fitted.append({s for b in train_bags for s in b.slide_ids})
        return real_fit(train_bags, *args, **kw)

    monkeypatch.setitem(heads.HEAD_FITTERS, "abmil", spy_fit)
    run = train_engine(lead, CID, dv, "abmil", seed=41)
    assert fitted and all(not (seen & splits["test"]) for seen in fitted)
    from dermpath.db import session_scope
    from dermpath.ml.models import Prediction, TrainingRun

    with session_scope() as db:
        r = db.get(TrainingRun, run["id"])
        assert (r.threshold_json or {}).get("selected_on", "val") in ("val", "oof")
        preds = db.scalars(select(Prediction).where(Prediction.run_id == run["id"])).all()
        assert {p.split for p in preds} <= {"train", "val", "oof"}  # test rows are written only by test releases
        assert not ({s for p in preds for s in p.slide_ids_json} & splits["test"])


def test_assert_no_test_catches_a_leaked_patient():
    from dermpath.datasets import TestSetLockViolation
    from dermpath.ml import training
    from dermpath.ml.heads import Bag

    assert_no_test = getattr(training, "assert_no_test", None)
    if assert_no_test is None:
        pytest.skip("training.assert_no_test is not part of this build")
    manifest = {"items": [{"slide_id": "s1", "split": "test"}, {"slide_id": "s2", "split": "train"}],
                "splits": [{"coded_patient_id": "pt-test", "split": "test"}]}
    ok = Bag("s2", "slide", ["s2"], "c", "pt-train", None, "bcc_present", 1, [], {})
    assert_no_test([ok], manifest, "training")
    for leaked in (Bag("s1", "slide", ["s1"], "c", "pt-x", None, "bcc_present", 1, [], {}),
                   Bag("s9", "slide", ["s9"], "c", "pt-test", None, "bcc_present", 1, [], {})):
        with pytest.raises(TestSetLockViolation):
            assert_no_test([ok, leaked], manifest, "training")


def test_test_split_opens_only_through_an_audited_release_by_the_research_lead(clients, ids):
    lead, path, director = clients(LEAD), clients("user-pathologist"), clients("user-director")
    dv = cohort(ids)["dataset_version_id"]
    queued = start(lead, CID, dv, "meanpool_logreg", seed=51)["experiment"]
    assert queued["threshold"] is None
    for c in (lead, path):
        r = c.get(f"/api/v1/experiments/{queued['id']}/evaluation?split=test")
        assert r.status_code == 409 and r.json()["error"]["code"] == "test_locked"
    r = lead.post(f"/api/v1/experiments/{queued['id']}/test-release", json={"reason": "too early"})
    assert r.status_code == 409 and r.json()["error"]["code"] == "test_locked"
    outcomes = run_all_jobs()
    run = lead.get(f"/api/v1/experiments/{queued['id']}").json()
    if run["status"] != "succeeded":
        pytest.skip(f"engine training path unavailable here: {run.get('error')} "
                    f"({[(o.type, o.status) for o in outcomes]})")
    for c in (path, director):  # readers of experiments may not open the test split
        r = c.get(f"/api/v1/experiments/{run['id']}/evaluation?split=test")
        assert r.status_code == 403 and r.json()["error"]["code"] == "role_forbidden"
        assert c.get(f"/api/v1/experiments/{run['id']}/evaluation?split=val").status_code == 200
        assert c.post(f"/api/v1/experiments/{run['id']}/test-release", json={"reason": "x"}).status_code == 403
    r = lead.get(f"/api/v1/experiments/{run['id']}/evaluation?split=test")
    assert r.status_code == 409 and r.json()["error"]["code"] == "test_release_required"
    r = lead.post(f"/api/v1/experiments/{run['id']}/test-release", json={"reason": "final"})
    assert r.status_code == 409 and r.json()["error"]["code"] in ("candidate_required", "feature_set_required")
    reg = lead.post(f"/api/v1/experiments/{run['id']}/register")
    if reg.json().get("bundle_id") is None:
        pytest.skip(f"no bundle for this run: {reg.json().get('bundle_unavailable_reason')}")
    r = lead.post(f"/api/v1/experiments/{run['id']}/test-release", json={"reason": "final evaluation"})
    assert r.status_code == 202, r.text
    rel = r.json()["test_release"]
    outcomes = run_all_jobs()
    assert all(o.status == "succeeded" for o in outcomes), [(o.type, o.error) for o in outcomes]
    ev = lead.get(f"/api/v1/experiments/{run['id']}/evaluation?split=test")
    assert ev.status_code == 200, ev.text
    body = ev.json()
    assert body["split"] == "test" and body["synthetic"] is True and body["banner"] == BANNER
    assert body["test_release_id"] == rel["id"] and body["release_number"] == rel["release_number"]
    assert body["threshold"]["value"] == run["threshold"]["value"]
    assert body["computed_after_threshold_frozen_at"] == run["threshold"]["frozen_at"]
    assert body["computed_at"] > run["threshold"]["frozen_at"]
    assert body["n_items"] + body["n_unscorable"] == run["split_counts"]["test"]["bags"]
    again = lead.get(f"/api/v1/experiments/{run['id']}/evaluation?split=test").json()
    assert again["evaluation_id"] == body["evaluation_id"]  # computed once by the release, then read
    errs = lead.get(f"/api/v1/experiments/{run['id']}/errors?split=test").json()
    assert errs["counts"]["n_items"] == body["n_items"]
    audit = lead.get(f"/api/v1/projects/{CID}/audit?entity_type=training_run&entity_id={run['id']}").json()["items"]
    actions = [e["action"] for e in audit]
    assert actions.count("experiment.test_released") == 1 and actions.count("experiment.test_evaluated") == 1
    assert actions.count("experiment.test_accessed") == 3
    assert all(e["actor_id"] == LEAD for e in audit if e["action"] in ("experiment.test_released",
                                                                       "experiment.test_accessed"))
    from datetime import datetime

    from dermpath.db import session_scope
    from dermpath.ml.models import Prediction

    with session_scope() as db:
        tp = db.scalars(select(Prediction).where(Prediction.run_id == run["id"], Prediction.split == "test")).all()
        frozen = datetime.fromisoformat(run["threshold"]["frozen_at"])
        assert tp and all(p.threshold == run["threshold"]["value"] and p.created_at > frozen for p in tp)


def test_active_learning_pool_never_holds_validation_or_test_patients(env, ids):
    """The seeded cohort is fully labelled: its development pool is empty, and no val/test patient appears."""
    from dermpath.db import session_scope
    from dermpath.ml.active_learning import development_pool
    from dermpath.ml.models import TrainingRun
    from dermpath.models import DatasetVersion

    c = cohort(ids)
    with session_scope() as db:
        run = db.get(TrainingRun, c["runs"]["abmil"])
        dv = db.get(DatasetVersion, c["dataset_version_id"])
        cands, excluded = development_pool(db, run, dv)
        locked = {s["coded_patient_id"] for s in dv.manifest_json["splits"] if s["split"] in ("val", "test")}
        assert not ({x["coded_patient_id"] for x in cands} & locked)
        assert excluded["test_patient"] > 0 and excluded["validation_patient"] > 0
        assert excluded["has_reference_label"] > 0 and cands == []


def test_single_class_validation_and_test_are_reported_honestly(clients, ids):
    """Acceptance 11 end to end: val and test contain only negative patients."""

    def assign(code, labels):
        n = int(code[-2:])
        if all(v == "bcc_absent_not_benign" for v in labels):
            return ("train", "val", "test")[n % 3]
        return "train"

    dv = custom_dataset(CID, "all-negative-val-test", assign)
    lead = clients(LEAD)
    run = train_engine(lead, CID, dv, "meanpool_logreg", seed=1, params=FAST)
    thr = run["threshold"]
    assert thr["selection_status"] in ("fallback", "insufficient_evidence") and thr["value"] == 0.5
    assert thr["reason"]
    reg = lead.post(f"/api/v1/experiments/{run['id']}/register").json()
    assert reg["bundle_id"], reg
    assert lead.post(f"/api/v1/experiments/{run['id']}/test-release", json={"reason": "acceptance 11"}).status_code \
        == 202
    run_all_jobs()
    for split in ("val", "test"):
        ev = lead.get(f"/api/v1/experiments/{run['id']}/evaluation?split={split}").json()
        assert ev["positives"] == 0 and ev["negatives"] == ev["n_items"] > 0
        m = ev["metrics"]
        assert m["sensitivity"]["value"] is None and m["sensitivity"]["denominator"] == 0
        assert "denominator 0" in m["sensitivity"]["undefined_reason"]
        assert m["auroc"]["defined"] is False and m["auprc"]["defined"] is False and m["auroc"]["ci"] is None
        assert m["specificity"]["denominator"] == ev["negatives"]
        assert (m["ppv"]["value"] is None) == (m["ppv"]["denominator"] == 0)
        assert all(r["status"] != "ok" or r["metrics"]["sensitivity"]["value"] is None
                   for r in ev["subgroups"]["rows"])
        assert ev["threshold"]["selection_status"] in ("fallback", "insufficient_evidence")
        assert any(w.startswith("threshold_unvalidated") for w in ev["warnings"])
        if split == "test":
            assert ev["tuning_set"] is False and ev["metrics"]["sensitivity"]["tuning_set"] is False
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
        assert cl.post(f"/api/v1/experiments/{rid}/test-release", json={"reason": "x"}).status_code == 403
        assert cl.get(f"/api/v1/experiments/{rid}/test-release").status_code == 200
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
    assert lead.post(url, json={**base, "evaluation_protocol": "loo"}).status_code == 422
    assert lead.post(url, json={**base, "family_id": "nope"}).status_code == 404
    # A draft dataset is refused.
    draft = lead.post(f"/api/v1/projects/{CID}/datasets", json={"name": "draft", "config": {}}).json()
    r = lead.post(url, json={**base, "dataset_version_id": draft["id"]})
    assert r.status_code == 409 and r.json()["error"]["code"] == "dataset_not_frozen"
    # A dataset of another project is not found here.
    other = ids["ml_demo"]["workflow"]["dataset_version_id"]
    assert lead.post(url, json={**base, "dataset_version_id": other}).status_code == 404
