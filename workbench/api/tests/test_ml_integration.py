"""Phase-2 integration of the ML engine upgrade (docs/ml-engine-design.md) with the existing
training and feature paths: label-free job payloads (§1 invariant 4), no fixture signal on
real slides (§1 invariant 3), permanent encoder-identity failures, the set-once
``weights_sha256`` pin, the lease-fenced final commit (§6, §10), the ``train`` settle hook
(§10) and the shared torch-state lock."""

from __future__ import annotations

from datetime import timedelta

import pytest
from sqlalchemy import func, select, update

from test_ml_support import CID, FAST, LEAD, SYNTH, cohort, run_jobs, start


def _job(job_id: str):
    from dermpath.db import session_scope
    from dermpath.models import Job

    with session_scope() as db:
        job = db.get(Job, job_id)
        db.expunge(job)
        return job


def _run(run_id: str):
    from dermpath.db import session_scope
    from dermpath.ml.models import TrainingRun

    with session_scope() as db:
        run = db.get(TrainingRun, run_id)
        db.expunge(run)
        return run


def _n_predictions(run_id: str) -> int:
    from dermpath.db import session_scope
    from dermpath.ml.models import Prediction

    with session_scope() as db:
        return db.scalar(select(func.count(Prediction.id)).where(Prediction.run_id == run_id))


def test_heads_and_devices_share_one_torch_state_lock():
    """Both contexts mutate process-global torch state; two locks could interleave."""
    from dermpath.ml import devices, heads

    assert heads._TORCH_LOCK is devices.TORCH_STATE_LOCK


# --------------------------------------------------------------------------- labels never travel


def test_extract_features_job_refuses_a_payload_carrying_a_label(env, ids):
    from dermpath.db import session_scope
    from dermpath.jobs import queue

    sid = ids["slides"]["p1_a1_l1"]
    with session_scope() as db:
        job, _ = queue.enqueue(db, "extract_features", {"slide_id": sid, "encoder_id": SYNTH, "fixture_label": 1},
                               idempotency_key="label-in-payload", project_id="proj-bcc-demo")
        jid = job.id
    outcomes = run_jobs(types=("extract_features",))
    assert [o.status for o in outcomes] == ["failed"]
    assert "never carry labels" in outcomes[0].error
    assert _job(jid).attempts == 1  # permanent: not retried


def test_fixture_label_never_reaches_a_real_slide(env, ids):
    """The legacy features path applies fixture.py's rule: a labelled synthetic extraction on
    a public/real slide is refused before any cache lookup or write."""
    from dermpath.db import session_scope
    from dermpath.ml.config import resolve_params
    from dermpath.ml.features import extract_slide_features
    from dermpath.ml.fixture import SyntheticSignalForbidden
    from dermpath.ml.models import FeatureArtifact

    params = resolve_params({"max_patches_per_slide": 8})
    with session_scope() as db:
        before = db.scalar(select(func.count(FeatureArtifact.id)))
    for label in (0, 1):
        with pytest.raises(SyntheticSignalForbidden, match="demo_synthetic"):
            extract_slide_features(ids["slides"]["cmu_cc0"], encoder_id=SYNTH, params=params, seed=0,
                                   fixture_label=label)
    with session_scope() as db:
        assert db.scalar(select(func.count(FeatureArtifact.id))) == before
    # Unlabelled extraction of the same slide, and labelled extraction of a synthetic tile, still work.
    assert extract_slide_features(ids["slides"]["cmu_cc0"], encoder_id=SYNTH, params=params, seed=0,
                                  fixture_label=None).n_patches > 0
    assert extract_slide_features(ids["slides"]["p1_a1_l1"], encoder_id=SYNTH, params=params, seed=0,
                                  fixture_label=1).n_patches > 0


# --------------------------------------------------------------------------- training failures are permanent


@pytest.mark.parametrize("kind", ["identity_mismatch", "load_error", "synthetic_forbidden"])
def test_encoder_identity_and_fixture_refusals_fail_training_permanently(clients, ids, monkeypatch, kind):
    """A weights pin mismatch or strict-load failure during extraction (EncoderUnavailable
    subclasses), or a refused fixture signal, must not be retried job_max_attempts times."""
    from dermpath.ml import training
    from dermpath.ml.encoders import EncoderIdentityMismatch, EncoderLoadError
    from dermpath.ml.fixture import SyntheticSignalForbidden

    exc = {"identity_mismatch": EncoderIdentityMismatch(SYNTH, expected="a" * 64, actual="b" * 64, source="pin"),
           "load_error": EncoderLoadError(SYNTH, "strict load failed: missing key"),
           "synthetic_forbidden": SyntheticSignalForbidden("slide provenance is public_cc0")}[kind]

    def boom(*a, **kw):
        raise exc

    monkeypatch.setattr(training, "extract_slide_features", boom)
    lead = clients(LEAD)
    out = start(lead, CID, cohort(ids)["dataset_version_id"], "meanpool_logreg", seed=31)
    outcomes = run_jobs()
    assert [o.status for o in outcomes] == ["failed"], outcomes
    prefix = "synthetic_signal_forbidden" if kind == "synthetic_forbidden" else "encoder_unavailable"
    assert outcomes[0].error.startswith(prefix)
    assert _job(out["job_id"]).attempts == 1
    run = _run(out["experiment"]["id"])
    assert run.status == "failed" and run.error.startswith(prefix)


def test_pinned_weights_mismatch_fails_with_run_identity_changed(clients, ids):
    """weights_sha256 is set-once (ml/models.py RUN_SET_ONCE): a pin that differs from the
    encoder's identity at the end of training is a permanent identity failure, never a retry."""
    from dermpath.db import session_scope
    from dermpath.ml.models import TrainingRun

    lead = clients(LEAD)
    out = start(lead, CID, cohort(ids)["dataset_version_id"], "meanpool_logreg", seed=32)
    rid = out["experiment"]["id"]
    with session_scope() as db:
        db.get(TrainingRun, rid).weights_sha256 = "pinned:" + "0" * 64
    outcomes = run_jobs()
    assert [o.status for o in outcomes] == ["failed"], outcomes
    assert "run_identity_changed: weights_sha256" in outcomes[0].error
    run = _run(rid)
    assert run.status == "failed" and run.weights_sha256 == "pinned:" + "0" * 64
    assert _n_predictions(rid) == 0


def test_training_records_the_weights_marker_once(clients, ids):
    from test_ml_support import train

    run = train(clients(LEAD), CID, cohort(ids)["dataset_version_id"], "meanpool_logreg", seed=33)
    assert run["weights_sha256"] == "synthetic:no-weights"


# --------------------------------------------------------------------------- lease fencing and settling


def test_final_training_commit_is_fenced_by_the_job_lease(clients, ids, monkeypatch):
    """A worker whose lease was reclaimed while it trained must not record success."""
    from dermpath.db import session_scope
    from dermpath.ml import training
    from dermpath.models import Job

    lead = clients(LEAD)
    out = start(lead, CID, cohort(ids)["dataset_version_id"], "meanpool_logreg", seed=34)
    rid, jid = out["experiment"]["id"], out["job_id"]
    real_qc_context = training.qc_context
    stolen = []

    def steal_then_qc(db, slide_ids):
        if not stolen:  # last step before the final commit: another worker reclaims the job
            with session_scope() as other:
                other.execute(update(Job).where(Job.id == jid).values(lease_owner="worker-2",
                                                                      attempts=Job.attempts + 1))
            stolen.append(True)
        return real_qc_context(db, slide_ids)

    monkeypatch.setattr(training, "qc_context", steal_then_qc)
    outcomes = run_jobs()
    assert [o.status for o in outcomes] == ["lease_lost"], outcomes
    run = _run(rid)
    assert run.status != "succeeded" and run.checkpoint_sha256 is None and run.threshold_value is None
    assert _n_predictions(rid) == 0
    assert _job(jid).lease_owner == "worker-2"  # the new owner's attempt is untouched


@pytest.mark.parametrize("cancel", [False, True])
def test_train_settle_hook_settles_a_run_whose_worker_died(clients, ids, cancel):
    from dermpath.db import session_scope, utcnow
    from dermpath.jobs import queue
    from dermpath.models import Job

    lead = clients(LEAD)
    out = start(lead, CID, cohort(ids)["dataset_version_id"], "meanpool_logreg", seed=35 + int(cancel))
    rid, jid = out["experiment"]["id"], out["job_id"]
    with session_scope() as db:
        db.execute(update(Job).where(Job.id == jid).values(max_attempts=1))
    assert queue.claim_next("crashed-worker", types=["train"]).id == jid
    with session_scope() as db:  # the worker died mid-run: the run row says running, the lease runs out
        from dermpath.ml.models import TrainingRun

        db.get(TrainingRun, rid).status = "running"
        db.execute(update(Job).where(Job.id == jid).values(lease_until=utcnow() - timedelta(seconds=5),
                                                           cancel_requested=cancel))
    assert queue.claim_next("rescuer", types=["train"]) is None
    expected = "canceled" if cancel else "failed"
    assert _job(jid).status == expected
    run = _run(rid)
    assert run.status == expected and run.error and run.finished_at is not None
    assert lead.get(f"/api/v1/experiments/{rid}").json()["status"] == expected


def test_train_settle_hook_never_touches_a_succeeded_run(clients, ids):
    from dermpath.db import session_scope
    from dermpath.ml.jobs import settle_training_run
    from dermpath.ml.models import TrainingRun
    from dermpath.models import Job

    rid = next(iter(cohort(ids)["runs"].values()))
    with session_scope() as db:
        run = db.get(TrainingRun, rid)
        assert run.status == "succeeded"
        job = db.get(Job, run.job_id)
        settle_training_run(db, job, "failed", "late settle")  # idempotent no-op, and must not raise
        db.flush()
    assert _run(rid).status == "succeeded"


def test_seeded_fast_params_still_valid():
    """FAST params used throughout the ML tests remain valid after the min_tissue_fraction
    tightening (0 is refused: it would accept pure background cells)."""
    from dermpath.ml.config import resolve_params

    resolve_params(FAST)
    with pytest.raises(ValueError):
        resolve_params({"min_tissue_fraction": 0.0})
    assert resolve_params({"min_tissue_fraction": 0.01})["min_tissue_fraction"] == 0.01
