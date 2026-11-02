"""ML pipeline: acceptance 9 (a real, loadable checkpoint and metrics, labelled synthetic),
determinism, feature-set reuse, the legacy embedding cache, real-path extraction on the CMU
fixture, excluded regions, cancellation, restart safety, case bags, and immutability against
later uploads/labels. Runs are ``synthetic_pipeline_test`` runs on pinned feature sets."""

from __future__ import annotations

import hashlib
import io
import threading
import time

import numpy as np
import pytest
from sqlalchemy import func, select

from test_ml_support import BANNER, CID, FAST, LEAD, PID, SYNTH, cohort, custom_dataset, run_jobs, start, train, workflow

# --------------------------------------------------------------------------- Acceptance 9


@pytest.mark.parametrize("head", ["meanpool_logreg", "abmil"])
def test_training_smoke_produces_real_checkpoint_and_synthetic_labelled_metrics(clients, ids, head):
    from dermpath.ml.heads import load_checkpoint
    from dermpath.storage import get_store

    lead = clients(LEAD)
    c = cohort(ids)
    run = train(lead, CID, c["dataset_version_id"], head, seed=5)
    # Labelled as a pipeline test everywhere.
    assert run["synthetic"] is True and run["banner"] == BANNER
    assert any("synthetic_encoder" in r for r in run["synthetic_reasons"])
    # Provenance and frozen identity.
    assert run["code_revision"] and run["code_revision"] == run["identity"]["code_revision"]
    assert {"numpy", "torch", "scikit-learn", "python"} <= set(run["deps"])
    assert run["weights_sha256"] == "synthetic:no-weights" == run["identity"]["weights_sha256"]
    assert run["execution_mode"] == "synthetic_pipeline_test" and run["evaluation_protocol"] == "holdout"
    assert run["feature_set_id"] and len(run["identity_sha256"]) == 64 and run["attempts"] == 1
    assert len(run["dataset_manifest_sha256"]) == 64 and run["seed"] == 5
    assert run["split_counts"]["test"]["patients"] > 0 and run["split_counts"]["train"]["items"] > 0
    # A real checkpoint: the bytes in the object store match the recorded sha256 and size, and it loads.
    ck = run["checkpoint"]
    data = get_store().get_bytes(ck["object_key"])
    assert hashlib.sha256(data).hexdigest() == ck["sha256"] and len(data) == ck["bytes"] > 100
    assert ck["object_key"].endswith(f"/checkpoints/{ck['sha256']}.npz")  # content-addressed, write-once
    with np.load(io.BytesIO(data), allow_pickle=False) as z:  # plain numpy can read it
        assert "meta_json" in z.files
    model = load_checkpoint(data)
    assert model.meta["head"] == head and model.meta["synthetic"] is True
    assert model.meta["threshold"]["selected_on"] == "val"
    for k in ("encoder_spec_sha256", "weights_sha256", "feature_set_spec_sha256", "policy_sha256", "code", "deps",
              "calibration", "abstention", "class_mapping"):
        assert model.meta.get(k) is not None, k
    assert model.meta["class_mapping"]["0"] == "bcc_absent_not_benign"
    # Threshold frozen on validation.
    thr = run["threshold"]
    assert thr["selected_on"] == "val" and thr["frozen_at"] and thr["value"] == model.meta["threshold"]["value"]
    # Metrics from stored predictions, labelled synthetic.
    ev = lead.get(f"/api/v1/experiments/{run['id']}/evaluation?split=val").json()
    assert ev["synthetic"] is True and ev["banner"] == BANNER and ev["computed_from"] == "stored prediction rows"
    assert ev["n_items"] == run["split_counts"]["val"]["bags"] and ev["positives"] + ev["negatives"] == ev["n_items"]
    c_ = ev["confusion"]
    assert sum(c_.values()) == ev["n_items"]
    assert ev["metrics"]["sensitivity"]["denominator"] == c_["tp"] + c_["fn"]
    assert ev["metrics"]["auroc"]["defined"] is True and 0.0 <= ev["metrics"]["auroc"]["value"] <= 1.0
    assert ev["bootstrap"]["method"] == "patient_cluster" and ev["calibration"]["note"].startswith("scores are not")
    # Scores reproduce from the stored checkpoint and the PINNED feature set (same code path at test time).
    from dermpath.db import session_scope
    from dermpath.ml.engine_models import FeatureSet
    from dermpath.ml.feature_sets import load_slide_features
    from dermpath.ml.models import Prediction

    with session_scope() as db:
        p = db.scalars(select(Prediction).where(Prediction.run_id == run["id"], Prediction.split == "val")).first()
        fs = db.get(FeatureSet, run["feature_set_id"])
        db.expunge(fs)
    parts = [load_slide_features(fs, sid).embeddings for sid in p.slide_ids_json]
    assert model.score_parts(parts)[0] == pytest.approx(p.score, abs=0)


def test_seeded_demo_runs_exist_and_are_labelled(clients, ids):
    lead = clients(LEAD)
    for group, pid in (("workflow", PID), ("cohort", CID)):
        g = ids["ml_demo"][group]
        for head, rid in g["runs"].items():
            r = lead.get(f"/api/v1/experiments/{rid}").json()
            assert r["status"] == "succeeded" and r["synthetic"] is True and r["banner"] == BANNER, r
            assert r["head"] == head and "PIPELINE TEST" in r["name"]
        listed = {r["id"] for r in lead.get(f"/api/v1/projects/{pid}/experiments").json()["items"]}
        assert set(g["runs"].values()) <= listed
    # The cohort is a separate project: the workflow demo project gained no patients or slides.
    stats = lead.get(f"/api/v1/projects/{PID}/workflow-stats").json()
    assert stats["slides"] == 17 and stats["patients"] == 7
    cds = lead.get(f"/api/v1/datasets/{cohort(ids)['dataset_version_id']}/summary").json()
    assert cds["synthetic_only"] is True and "PIPELINE TEST" in cds["notice"] and cds["counts"]["patients"] == 60
    # Workflow demo: one patient in val → bootstrap CIs are honestly null.
    wf = workflow(ids)
    ev = lead.get(f"/api/v1/experiments/{wf['runs']['meanpool_logreg']}/evaluation?split=val").json()
    assert ev["n_patients"] <= 2 and ev["bootstrap"]["status"].startswith("insufficient evidence")
    assert all(ev["metrics"][k]["ci"] is None for k in ("sensitivity", "specificity", "ppv", "npv", "auroc"))
    for k in ("sensitivity", "specificity", "ppv", "npv"):
        m = ev["metrics"][k]
        assert (m["value"] is None) == (m["denominator"] == 0)
        assert (m["undefined_reason"] is None) == (m["denominator"] > 0)


# --------------------------------------------------------------------------- determinism & cache


@pytest.mark.parametrize("head", ["meanpool_logreg", "abmil"])
def test_same_seed_gives_identical_metrics_and_checkpoint(clients, ids, head):
    lead = clients(LEAD)
    dv = cohort(ids)["dataset_version_id"]
    a = train(lead, CID, dv, head, seed=21)
    b = train(lead, CID, dv, head, seed=21)
    assert a["id"] != b["id"]
    assert a["checkpoint"]["sha256"] == b["checkpoint"]["sha256"]
    assert a["threshold"]["value"] == b["threshold"]["value"]
    ea = lead.get(f"/api/v1/experiments/{a['id']}/evaluation?split=val").json()
    eb = lead.get(f"/api/v1/experiments/{b['id']}/evaluation?split=val").json()
    for k in ("confusion", "metrics", "calibration", "coverage_curve", "subgroups", "bootstrap"):
        assert ea[k] == eb[k], k
    # Both runs read the same pinned feature set (reused, never re-extracted).
    assert a["feature_set_id"] == b["feature_set_id"] and b["feature_summary"]["reused_feature_set"] is True
    assert b["feature_summary"]["slides"] > 0 and b["checkpoint"]["object_key"] == a["checkpoint"]["object_key"]
    c = train(lead, CID, dv, head, seed=22)
    assert c["checkpoint"]["sha256"] != a["checkpoint"]["sha256"]


def test_feature_cache_hit_on_re_extraction(env, ids):
    from dermpath.db import session_scope
    from dermpath.ml.config import resolve_params
    from dermpath.ml.features import extract_slide_features
    from dermpath.ml.models import FeatureArtifact

    sid = ids["slides"]["p1_a1_l1"]
    params = resolve_params({"max_patches_per_slide": 12})
    first = extract_slide_features(sid, encoder_id=SYNTH, params=params, seed=99, fixture_label=1)
    with session_scope() as db:
        n = db.scalar(select(func.count(FeatureArtifact.id)))
    second = extract_slide_features(sid, encoder_id=SYNTH, params=params, seed=99, fixture_label=1)
    assert first.cache_hit is False and second.cache_hit is True and second.artifact_id == first.artifact_id
    with session_scope() as db:
        assert db.scalar(select(func.count(FeatureArtifact.id))) == n
        art = db.get(FeatureArtifact, first.artifact_id)
        assert art.key_extra_json["fixture_label"] == 1 and art.weights_sha256 == "synthetic:no-weights"
        assert art.stats_json["coordinate_source"] == "tissue_mask" and art.stats_json["pixels_read"] is True
        assert art.calibrated is False and art.scale_key.startswith("level=")  # synthetic tiles: no mpp
        assert "uncalibrated" in art.stats_json["scale"]["note"]
    # Anything in the key changes → a new artifact (seed, label, patch bound).
    other = extract_slide_features(sid, encoder_id=SYNTH, params=params, seed=99, fixture_label=0)
    assert other.cache_hit is False and other.artifact_id != first.artifact_id


# --------------------------------------------------------------------------- real path on the CMU fixture


def test_real_path_extraction_on_cmu_fixture_with_a_real_encoder(clients, ids, run_worker):
    from dermpath.db import session_scope
    from dermpath.ml.features import load_features
    from dermpath.ml.models import FeatureArtifact

    lead = clients(LEAD)
    sid = ids["slides"]["cmu_cc0"]
    # Design §1 invariant 2: the synthetic fixture encoder is refused on a real (public_cc0) slide here too.
    r = lead.post(f"/api/v1/slides/{sid}/features", json={"encoder_id": SYNTH, "seed": 0})
    assert r.status_code == 409 and r.json()["error"]["code"] == "mode_mismatch", r.text
    r = lead.post(f"/api/v1/slides/{sid}/features", json={"encoder_id": "handcrafted-stain-texture-v1", "seed": 0})
    assert r.status_code == 202 and r.json()["synthetic"] is False and r.json()["banner"] is None
    t0 = time.perf_counter()
    outcomes = run_jobs(types=("extract_features",))
    elapsed = time.perf_counter() - t0
    assert [o.status for o in outcomes] == ["succeeded"], outcomes
    items = lead.get(f"/api/v1/slides/{sid}/features").json()["items"]
    assert len(items) == 1
    a = items[0]
    assert a["synthetic"] is False and a["banner"] is None
    assert a["calibrated"] is True and a["scale_key"] == "mpp=0.5"  # CMU-1-Small-Region: 0.499 µm/px
    st = a["stats"]
    assert st["tissue_source"] == "qc_tissue_mask" and st["qc_review_id"]  # the seed's QC screen mask
    assert st["pixels_read"] is True and st["encoder_reads_pixels"] is True
    assert 0 < a["n_patches"] <= 64 and a["embedding_dim"] == 64
    assert st["scale"]["slide_mpp"][0] == pytest.approx(0.499)
    with session_scope() as db:
        arr = load_features(db.get(FeatureArtifact, a["id"]))
    assert arr["coords"].shape == (a["n_patches"], 2) and arr["patch_mean_rgb"].shape == (a["n_patches"], 3)
    ext = arr["extent"].tolist()
    assert ext[0] == round(224 * 0.5 / 0.499)  # level-0 pixels per 224-px patch at 0.5 µm/px
    W, H = 2220, 2967
    assert (arr["coords"][:, 0] + ext[0] <= W).all() and (arr["coords"][:, 1] + ext[1] <= H).all()
    # A real encoder: no fixture label or synthetic config in the cache key.
    assert "fixture_label" not in a["key_extra"]
    print(f"\nCMU extraction via job: {a['n_patches']} patches, {elapsed:.3f}s wall (job), "
          f"{st['total_seconds']}s in extractor")


def test_excluded_regions_are_respected(clients, ids):
    from dermpath.db import session_scope
    from dermpath.ml.config import resolve_params
    from dermpath.ml.features import extract_slide_features, load_features
    from dermpath.ml.models import FeatureArtifact

    asst = clients("user-assistant")
    sid = ids["slides"]["cmu_cc0"]
    params = resolve_params({"max_patches_per_slide": 4096})
    hand = "handcrafted-stain-texture-v1"  # a real slide: the synthetic fixture encoder is refused here
    before = extract_slide_features(sid, encoder_id=hand, params=params, seed=0, fixture_label=None)
    region = {"type": "rectangle", "x": 0, "y": 0, "width": 1200, "height": 1500}
    issue = asst.post(f"/api/v1/slides/{sid}/qc/issues", json={"category": "fold", "region": region,
                                                              "note": "fold (test)"}).json()
    asst.patch(f"/api/v1/qc/issues/{issue['id']}", json={"action": "review", "confirmed": True})
    r = asst.patch(f"/api/v1/qc/issues/{issue['id']}", json={
        "action": "resolve", "resolution": "fold region excluded", "dataset_eligibility_effect": "exclude_region",
        "reason": "fold over the upper-left area"})
    assert r.status_code == 200, r.text
    after = extract_slide_features(sid, encoder_id=hand, params=params, seed=0, fixture_label=None)
    assert after.artifact_id != before.artifact_id and after.cache_hit is False
    with session_scope() as db:
        a0 = load_features(db.get(FeatureArtifact, before.artifact_id))
        a1 = load_features(db.get(FeatureArtifact, after.artifact_id))
        stats = db.get(FeatureArtifact, after.artifact_id).stats_json
    ew, eh = a1["extent"].tolist()
    inside = lambda c: (c[:, 0] < 1200) & (c[:, 1] < 1500)  # noqa: E731  (cells touching the region)
    assert inside(a0["coords"]).any(), "the region should contain tissue patches before the exclusion"
    assert not inside(a1["coords"]).any()
    assert stats["excluded_regions"] == 1 and stats["cells_dropped_by_excluded_regions"] > 0


# --------------------------------------------------------------------------- cancellation & restart safety


def test_cancel_mid_training(clients, ids):
    from dermpath.db import session_scope
    from dermpath.jobs.worker import Worker
    from dermpath.ml.models import Prediction
    from dermpath.models import Job

    lead = clients(LEAD)
    dv = cohort(ids)["dataset_version_id"]
    out = start(lead, CID, dv, "abmil", seed=3, params={**FAST, "max_epochs": 2000, "patience": 2000})
    rid, jid = out["experiment"]["id"], out["job_id"]
    result = {}
    t = threading.Thread(target=lambda: result.setdefault("o", Worker("cancel-w", types=["train"]).run_once()))
    t.start()
    deadline = time.time() + 60
    while time.time() < deadline:
        with session_scope() as db:
            job = db.get(Job, jid)
            if job.status == "running" and (job.progress_message or "").startswith("abmil epoch"):
                break
        time.sleep(0.05)
    else:
        raise AssertionError("training never reached the epoch loop")
    r = lead.post(f"/api/v1/experiments/{rid}/cancel")
    assert r.status_code == 200
    t.join(timeout=60)
    assert result["o"].status == "canceled"
    run = lead.get(f"/api/v1/experiments/{rid}").json()
    assert run["status"] == "canceled" and run["checkpoint"] is None and run["threshold"] is None
    with session_scope() as db:
        assert db.scalar(select(func.count(Prediction.id)).where(Prediction.run_id == rid)) == 0
    assert lead.get(f"/api/v1/experiments/{rid}/evaluation?split=val").status_code == 409
    r = lead.get(f"/api/v1/experiments/{rid}/evaluation?split=test")
    assert r.status_code == 409 and r.json()["error"]["code"] == "test_locked"
    assert lead.post(f"/api/v1/experiments/{rid}/cancel").status_code == 409  # already finished


def test_cancel_queued_run_is_immediate(clients, ids):
    lead = clients(LEAD)
    out = start(lead, CID, cohort(ids)["dataset_version_id"], "meanpool_logreg", seed=4)
    r = lead.post(f"/api/v1/experiments/{out['experiment']['id']}/cancel")
    assert r.status_code == 200 and r.json()["status"] == "canceled"
    assert run_jobs() == []  # nothing left to run


def test_crashed_attempt_is_retried_and_reproduces_the_same_result(clients, ids, monkeypatch):
    """A failure inside the final transaction rolls back every output; the retry (same seed)
    produces the same checkpoint as an uninterrupted run and no duplicate predictions."""
    from dermpath.db import session_scope
    from dermpath.ml import training as tr_mod
    from dermpath.ml.models import Prediction

    lead = clients(LEAD)
    dv = cohort(ids)["dataset_version_id"]
    reference = train(lead, CID, dv, "abmil", seed=31)

    real = tr_mod.store_development_evaluation
    calls = {"n": 0}

    def crash_once(*a, **kw):
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("simulated worker crash during the final commit")
        return real(*a, **kw)

    monkeypatch.setattr(tr_mod, "store_development_evaluation", crash_once)
    out = start(lead, CID, dv, "abmil", seed=31)
    from dermpath.jobs.worker import Worker

    first = Worker("crash-w", types=["train"]).run_once()  # exactly one attempt
    assert first.status == "queued"  # retryable failure → re-queued (backoff 0 in tests)
    mid = lead.get(f"/api/v1/experiments/{out['experiment']['id']}").json()
    assert mid["status"] == "queued" and "simulated worker crash" in mid["error"] and mid["checkpoint"] is None
    second = run_jobs()
    assert [o.status for o in second] == ["succeeded"]
    run = lead.get(f"/api/v1/experiments/{out['experiment']['id']}").json()
    assert run["status"] == "succeeded" and run["checkpoint"]["sha256"] == reference["checkpoint"]["sha256"]
    assert run["attempts"] == 2  # one appended RunAttempt per attempt
    with session_scope() as db:
        n = db.scalar(select(func.count(Prediction.id)).where(Prediction.run_id == run["id"]))
        n_ref = db.scalar(select(func.count(Prediction.id)).where(Prediction.run_id == reference["id"]))
    assert n == n_ref > 0
    # Re-running a finished job's handler is an idempotent replay.
    from dermpath.ml.training import run_training

    assert run_training(run["id"])["idempotent_replay"] is True


def test_expired_lease_after_worker_death_is_reclaimed(clients, ids):
    from datetime import timedelta

    from dermpath.db import session_scope, utcnow
    from dermpath.jobs import queue
    from dermpath.models import Job

    lead = clients(LEAD)
    out = start(lead, CID, cohort(ids)["dataset_version_id"], "meanpool_logreg", seed=8)
    claimed = queue.claim_next("worker-that-dies", lease_seconds=30, types=["train"])
    assert claimed.id == out["job_id"]
    with session_scope() as db:
        db.get(Job, out["job_id"]).lease_until = utcnow() - timedelta(seconds=1)
    assert [o.status for o in run_jobs()] == ["succeeded"]
    with session_scope() as db:
        assert db.get(Job, out["job_id"]).attempts == 2


# --------------------------------------------------------------------------- case bags


def test_case_level_labels_make_case_bags(clients, ids):
    """label_scope=case: all slides of a case form ONE bag (case truth is never copied to slides)."""
    from dermpath.auth import Actor
    from dermpath.db import session_scope
    from dermpath.labels import case_of_slide, create_expert_label
    from dermpath.models import Slide

    path = Actor("user-pathologist", "pathologist", "Dr. Imani Castell")
    with session_scope() as db:
        slides = db.scalars(select(Slide).where(Slide.project_id == CID).order_by(Slide.id)).all()
        seen = set()
        for s in slides:
            case = case_of_slide(db, s)
            if case.id in seen:
                continue
            seen.add(case.id)
            value = "bcc_present" if int(case.id[-2:]) % 2 else "bcc_absent_not_benign"
            create_expert_label(db, path, s, scope="case", target_id=None, value=value,
                                reason="case-level fixture label (synthetic pipeline test)")
    dv = custom_dataset(CID, "case-scope", lambda code, labels: ("train", "val", "test", "train", "train")[
        int(code[-2:]) % 5], label_scope="case")
    lead = clients(LEAD)
    run = train(lead, CID, dv, "abmil", seed=2)
    assert run["label_scope"] == "case"
    from dermpath.ml.models import Prediction

    with session_scope() as db:
        preds = db.scalars(select(Prediction).where(Prediction.run_id == run["id"])).all()
        assert preds and all(p.bag_kind == "case" and p.bag_id == p.case_id for p in preds)
        multi = [p for p in preds if len(p.slide_ids_json) > 1]
        assert multi, "some cases have several slides in one bag"
        p = multi[0]
        assert {r[0] for r in p.attention_json} == set(range(len(p.slide_ids_json)))
    assert p.split in ("train", "val")  # the train job never scores test bags
    # The case label lives on the case bag only: no slide-level label or prediction exists.
    assert all(len(x.slide_ids_json) == len({s for s in x.slide_ids_json}) for x in preds)
    by_case = {}
    for x in preds:
        by_case.setdefault((x.split, x.case_id), []).append(x)
    assert all(len(v) == 1 for v in by_case.values())
    att = lead.get(f"/api/v1/experiments/{run['id']}/attention/{p.slide_ids_json[1]}")
    assert att.status_code == 200, att.text
    body = att.json()
    assert body["bag_kind"] == "case" and "spans several slides" in body["weight_normalization"]


# --------------------------------------------------------------------------- immutability against later changes


def test_new_uploads_and_label_changes_never_modify_a_run_or_model(clients, ids, cmu_variant, run_worker):
    from conftest import upload_bytes

    from dermpath.db import session_scope
    from dermpath.ml.models import Prediction, TrainingRun
    from dermpath.models import ImmutableRecordError

    lead = clients(LEAD)
    rid = workflow(ids)["runs"]["abmil"]
    before = lead.get(f"/api/v1/experiments/{rid}").json()
    ev_before = lead.get(f"/api/v1/experiments/{rid}/evaluation?split=val").json()
    mv = lead.post(f"/api/v1/experiments/{rid}/register", json={"note": "test"}).json()
    # A new upload and a changed label on a slide of the run's dataset.
    res = upload_bytes(clients("user-assistant"), PID, cmu_variant, "new_scan.svs")
    assert res["status_code"] in (200, 202)
    run_worker()
    sid = ids["slides"]["p1_a1_l2"]
    r = clients("user-pathologist").post(f"/api/v1/slides/{sid}/labels", json={
        "value": "bcc_absent_not_benign", "reason": "re-review (fictional)"})
    assert r.status_code == 201
    after = lead.get(f"/api/v1/experiments/{rid}").json()
    for k in ("checkpoint", "threshold", "dataset_manifest_sha256", "status", "split_counts", "params"):
        assert after[k] == before[k], k
    assert lead.get(f"/api/v1/experiments/{rid}/evaluation?split=val").json()["metrics"] == ev_before["metrics"]
    models = lead.get(f"/api/v1/projects/{PID}/models").json()["items"]
    assert [m for m in models if m["id"] == mv["id"]][0]["status"] == "research_candidate"
    # ORM-level: a completed run and its predictions cannot be modified.
    with session_scope() as db:
        run = db.get(TrainingRun, rid)
        run.threshold_value = 0.01
        with pytest.raises(ImmutableRecordError):
            db.flush()
        db.rollback()
    with session_scope() as db:
        p = db.scalars(select(Prediction).where(Prediction.run_id == rid)).first()
        p.score = 0.0
        with pytest.raises(ImmutableRecordError):
            db.flush()
        db.rollback()
    from sqlalchemy import text
    from sqlalchemy.exc import DatabaseError

    with session_scope() as db:
        with pytest.raises(DatabaseError):
            db.execute(text("UPDATE prediction SET score=0 WHERE run_id=:r"), {"r": rid})
        db.rollback()
