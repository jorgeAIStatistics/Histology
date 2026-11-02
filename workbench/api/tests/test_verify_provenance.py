"""Adversarial verification, lens: provenance and identity (design §5, §6, §8, §10).

Each test attacks one guarantee: an existing feature set, experiment, inference bundle or test release must
never change SILENTLY. Every attack has to end in an explicit refusal or staleness signal, or in a provably
identical result. A failing test in this file is the reproduction of a defect; a passing one stays as regression
coverage.

Real-pixel attacks use byte variants of the CC0 CMU-1-Small-Region fixture with the handcrafted encoder (a
technical baseline, not a pathology model); weights attacks use a tiny random-initialised timm ViT through the
real UNI adapter (nothing is downloaded). Labels are fictional test labels set by the helpers.
"""

from __future__ import annotations

import hashlib
import json
import os
import threading
import types

import numpy as np
import pytest
from sqlalchemy import select, text
from sqlalchemy.exc import DBAPIError

from feature_set_support import CMU_PROJECT, HANDCRAFTED, actors, cmu_slide_id, create_set, get_set, items_of, real_cohort
from ml_engine_fakes import cohort_dv, make_engine_run
from ml_engine_fakes import run_jobs as run_engine_jobs
from test_ml_support import CID, FAST, LEAD, SYNTH, cohort, run_jobs

SMALL = {"max_patches_per_slide": 4}
WHOLE_CMU = {"type": "rectangle", "x": 0, "y": 0, "width": 2220, "height": 2967}


# =========================================================================== helpers


def _build(fs_id: str, ctx=None) -> dict:
    from dermpath.ml.feature_sets import build_feature_set

    return build_feature_set(fs_id, ctx)


def _artifact(fs_id: str, slide_id: str):
    from dermpath.db import session_scope
    from dermpath.ml.models import FeatureArtifact

    with session_scope() as db:
        art = db.get(FeatureArtifact, items_of(fs_id)[slide_id].artifact_id)
        db.expunge(art)
        return art


def _refused_orm(mutate) -> None:
    """``mutate(db)`` must be refused by the ORM immutability guard when the session flushes."""
    from dermpath.db import session_scope
    from dermpath.models import ImmutableRecordError

    with pytest.raises(ImmutableRecordError):
        with session_scope() as db:
            mutate(db)


def _refused_sql(sql: str, **params) -> None:
    """Raw SQL (bypassing the ORM) must be refused by the database (SQLite triggers / constraints)."""
    from dermpath.db import get_engine

    with pytest.raises(DBAPIError):
        with get_engine().begin() as conn:
            conn.execute(text(sql), params)


def _lead():
    from dermpath.auth import Actor

    return Actor(LEAD, "research_lead", "Priya Navarro")


def _new_cohort_experiment(ids, seed: int, **kw) -> tuple[str, str]:
    """A queued synthetic-cohort experiment through the service (the seeded pipeline-test cohort)."""
    from dermpath.db import session_scope
    from dermpath.ml.service import create_experiment
    from dermpath.models import Project

    with session_scope() as db:
        run, job = create_experiment(db, _lead(), db.get(Project, CID), dataset_version_id=cohort(ids)["dataset_version_id"],
                                     encoder_id=SYNTH, head="meanpool_logreg", params=dict(FAST), seed=seed, name=None,
                                     **kw)
        return run.id, job.id


def _run_row(run_id: str):
    from dermpath.db import session_scope
    from dermpath.ml.models import TrainingRun

    with session_scope() as db:
        r = db.get(TrainingRun, run_id)
        db.expunge(r)
        return r


def _count(model, **where) -> int:
    from dermpath.db import session_scope

    with session_scope() as db:
        q = select(model)
        for k, v in where.items():
            q = q.where(getattr(model, k) == v)
        return len(db.scalars(q).all())


def _flip_last_byte_in_place(path) -> None:
    """Rewrite one byte in place with the SAME size and a RESTORED mtime (the memo-evasion attack)."""
    st = os.stat(path)
    with open(path, "r+b") as fh:
        fh.seek(-1, 2)
        b = fh.read(1)
        fh.seek(-1, 2)
        fh.write(bytes([b[0] ^ 0x01]))
    os.utime(path, ns=(st.st_atime_ns, st.st_mtime_ns))
    st2 = os.stat(path)
    assert st2.st_size == st.st_size and st2.st_mtime_ns == st.st_mtime_ns and st2.st_ino == st.st_ino


def _patch_library_version(monkeypatch, name: str, version: str) -> None:
    """Simulate a worker whose numerical stack differs (e.g. pillow upgraded) from the one that made the set."""
    from dermpath.ml import artifacts

    deps = dict(artifacts.dependency_versions())
    deps[name] = version
    frozen = tuple(sorted(deps.items()))
    monkeypatch.setattr(artifacts, "_dependency_versions", lambda: frozen)


def _whole_slide_exclusion(slide_id: str) -> str:
    """A human QC issue over the whole CMU slide, reviewed and resolved as exclude_region (service layer)."""
    from dermpath.db import session_scope
    from dermpath.models import Slide
    from dermpath.qc.service import create_manual_issue, transition_issue

    a = actors()["assistant"]
    with session_scope() as db:
        issue = create_manual_issue(db, a, db.get(Slide, slide_id), category="fold", region=dict(WHOLE_CMU),
                                    note="whole-slide exclusion (verification test)", override_of=None, reason=None)
        transition_issue(db, a, issue, action="review", reason=None, confirmed=True)
        transition_issue(db, a, issue, action="resolve", reason="exclude for verification", resolution="excluded",
                         dataset_eligibility_effect="exclude_region")
        return issue.id


def _reopen(issue_id: str) -> None:
    from dermpath.db import session_scope
    from dermpath.models import QCIssue
    from dermpath.qc.service import transition_issue

    with session_scope() as db:
        transition_issue(db, actors()["assistant"], db.get(QCIssue, issue_id), action="reopen",
                         reason="reopened by the verification test")


# =========================================================================== 1. rows: ORM and raw SQL


def test_ready_feature_set_items_and_artifacts_reject_orm_and_raw_sql_mutation(env, ids):
    from dermpath.db import session_scope
    from dermpath.ml.engine_models import FeatureSet, FeatureSetItem
    from dermpath.ml.models import FeatureArtifact, TrainingRun

    with session_scope() as db:
        fs = db.get(FeatureSet, db.get(TrainingRun, cohort(ids)["runs"]["meanpool_logreg"]).feature_set_id)
        assert fs.status == "ready"
        fs_id = fs.id
        before = {c.name: getattr(fs, c.key) for c in FeatureSet.__table__.columns}
        item = db.scalars(select(FeatureSetItem).where(FeatureSetItem.feature_set_id == fs_id)).first()
        item_id, art_id = item.id, item.artifact_id
        other_art = db.scalars(select(FeatureArtifact.id).where(FeatureArtifact.id != art_id)).first()
        art_before = {c.name: getattr(db.get(FeatureArtifact, art_id), c.key) for c in FeatureArtifact.__table__.columns}
    z = "0" * 64
    for col, val in (("weights_sha256", z), ("spec_sha256", z), ("policy_sha256", z), ("status", "building"),
                     ("stain_reference_sha256", z), ("stain_reference_key", "x"), ("input_snapshot_json", {"slides": []}),
                     ("encoder_spec_sha256", z), ("extraction_env_sha256", z)):
        _refused_orm(lambda db, col=col, val=val: setattr(db.get(FeatureSet, fs_id), col, val))
    _refused_orm(lambda db: db.delete(db.get(FeatureSet, fs_id)))
    _refused_orm(lambda db: setattr(db.get(FeatureSetItem, item_id), "artifact_id", other_art))
    _refused_orm(lambda db: setattr(db.get(FeatureSetItem, item_id), "status", "pending"))
    _refused_orm(lambda db: db.delete(db.get(FeatureSetItem, item_id)))
    _refused_orm(lambda db: setattr(db.get(FeatureArtifact, art_id), "embeddings_sha256", z))
    _refused_orm(lambda db: setattr(db.get(FeatureArtifact, art_id), "embeddings_key", "projects/x/y.npy"))
    _refused_orm(lambda db: db.delete(db.get(FeatureArtifact, art_id)))
    _refused_sql("UPDATE feature_set SET weights_sha256 = :v WHERE id = :id", v=z, id=fs_id)
    _refused_sql("UPDATE feature_set SET status = 'building' WHERE id = :id", id=fs_id)
    _refused_sql("UPDATE feature_set SET stain_reference_key = 'x', stain_reference_sha256 = :v WHERE id = :id",
                 v=z, id=fs_id)
    _refused_sql("UPDATE feature_set SET input_snapshot_json = '{}' WHERE id = :id", id=fs_id)
    _refused_sql("DELETE FROM feature_set WHERE id = :id", id=fs_id)
    _refused_sql("UPDATE feature_set_item SET artifact_id = :a WHERE id = :id", a=other_art, id=item_id)
    _refused_sql("DELETE FROM feature_set_item WHERE id = :id", id=item_id)
    _refused_sql("INSERT INTO feature_set_item (id, feature_set_id, project_id, slide_id, slide_sha256, status, "
                 "created_at) VALUES ('verifyitem000000000000000000001', :fs, :p, :s, :v, 'done', "
                 "'2026-10-26 00:00:00')", fs=fs_id, p=CID, s=cmu_slide_id(ids), v=z)
    _refused_sql("UPDATE feature_artifact SET embeddings_sha256 = :v WHERE id = :id", v=z, id=art_id)
    _refused_sql("DELETE FROM feature_artifact WHERE id = :id", id=art_id)
    with session_scope() as db:
        assert {c.name: getattr(db.get(FeatureSet, fs_id), c.key) for c in FeatureSet.__table__.columns} == before
        assert {c.name: getattr(db.get(FeatureArtifact, art_id), c.key)
                for c in FeatureArtifact.__table__.columns} == art_before
        assert db.get(FeatureSetItem, item_id).artifact_id == art_id


def test_building_feature_set_specification_rejects_orm_and_raw_sql_mutation(env, ids):
    from dermpath.db import session_scope
    from dermpath.ml.engine_models import FeatureSet

    fs_id = create_set(CMU_PROJECT, encoder_id=HANDCRAFTED, execution_mode="real_image_technical",
                       slide_ids=[cmu_slide_id(ids)], params=SMALL)
    spec = get_set(fs_id)
    assert spec.status == "building"
    z = "0" * 64
    for col, val in (("weights_sha256", z), ("patch_policy_json", {"x": 1}), ("policy_sha256", z),
                     ("input_snapshot_json", {"slides": []}), ("encoder_spec_json", {}),
                     ("extraction_env_json", {}), ("dataset_version_id", "d" * 32),
                     ("execution_mode", "supervised_experiment")):
        _refused_orm(lambda db, col=col, val=val: setattr(db.get(FeatureSet, fs_id), col, val))
    _refused_orm(lambda db: setattr(db.get(FeatureSet, fs_id), "status", "ready") or
                 setattr(db.get(FeatureSet, fs_id), "policy_sha256", z))
    for col in ("weights_sha256", "policy_sha256", "spec_sha256", "extraction_env_sha256", "input_snapshot_sha256"):
        _refused_sql(f"UPDATE feature_set SET {col} = :v WHERE id = :id", v=z, id=fs_id)
    _refused_sql("UPDATE feature_set SET encoder_spec_json = '{}' WHERE id = :id", id=fs_id)
    _refused_sql("UPDATE feature_set SET status = 'ready', policy_sha256 = :v WHERE id = :id", v=z, id=fs_id)
    with session_scope() as db:
        now = db.get(FeatureSet, fs_id)
        assert (now.weights_sha256, now.policy_sha256, now.spec_sha256, now.input_snapshot_json) == (
            spec.weights_sha256, spec.policy_sha256, spec.spec_sha256, spec.input_snapshot_json)


def test_training_run_identity_and_outputs_reject_orm_and_raw_sql_mutation(env, ids):
    from dermpath.db import session_scope
    from dermpath.ml.models import TrainingRun

    queued, _ = _new_cohort_experiment(ids, seed=901)
    done = cohort(ids)["runs"]["meanpool_logreg"]
    z = "0" * 64
    identity_cols = (("params_json", {"n_boot": 1}), ("seed", 999), ("feature_set_id", "f" * 32),
                     ("identity_json", {"forged": True}), ("identity_sha256", z), ("dataset_manifest_sha256", z),
                     ("encoder_id", "handcrafted-stain-texture-v1"), ("execution_mode", "real_image_technical"),
                     ("evaluation_protocol", "dev_cv"), ("positive_class", "x"), ("head", "abmil"))
    for rid in (queued, done):
        before = {c.name: getattr(_run_row(rid), c.key) for c in TrainingRun.__table__.columns}
        for col, val in identity_cols:
            _refused_orm(lambda db, col=col, val=val: setattr(db.get(TrainingRun, rid), col, val))
            raw = json.dumps(val) if isinstance(val, dict) else val
            _refused_sql(f"UPDATE training_run SET {col} = :v WHERE id = :id", v=raw, id=rid)
        after = {c.name: getattr(_run_row(rid), c.key) for c in TrainingRun.__table__.columns}
        assert after == before
    # A succeeded run's outputs are frozen too (checkpoint, operating point, status), and it is never deleted.
    for col, val in (("checkpoint_sha256", z), ("checkpoint_key", "projects/x/c.npz"), ("threshold_value", 0.01),
                     ("calibration_json", {"method": "platt"}), ("abstention_json", {"kind": "none"}),
                     ("status", "failed"), ("weights_sha256", z), ("metrics_json", {})):
        _refused_orm(lambda db, col=col, val=val: setattr(db.get(TrainingRun, done), col, val))
        raw = json.dumps(val) if isinstance(val, dict) else val
        _refused_sql(f"UPDATE training_run SET {col} = :v WHERE id = :id", v=raw, id=done)
    _refused_orm(lambda db: db.delete(db.get(TrainingRun, done)))
    _refused_sql("DELETE FROM training_run WHERE id = :id", id=done)
    # The identity re-derives the manifest digest and split fingerprint from the frozen manifest: it cannot move.
    _refused_sql("UPDATE dataset_version SET manifest_json = '{}' WHERE id = :id", id=cohort(ids)["dataset_version_id"])
    with session_scope() as db:
        assert db.get(TrainingRun, done).status == "succeeded"


def test_training_run_recorded_code_revision_and_dependencies_cannot_be_rewritten(env, ids):
    """``run.code_revision`` / ``run.deps_json`` are the provenance the API shows for a run (run_dict) and the
    bundle's fallback code identity. They are recorded at creation and documented as never written again; a
    rewrite before the run succeeds must be refused, like the identity columns."""
    from dermpath.ml.models import TrainingRun

    rid, _ = _new_cohort_experiment(ids, seed=902)
    frozen = _run_row(rid)
    _refused_orm(lambda db: setattr(db.get(TrainingRun, rid), "code_revision", "forged-revision"))
    _refused_orm(lambda db: setattr(db.get(TrainingRun, rid), "deps_json", {"numpy": "0.0-forged"}))
    _refused_sql("UPDATE training_run SET code_revision = 'forged-revision' WHERE id = :id", id=rid)
    now = _run_row(rid)
    assert now.code_revision == frozen.code_revision == frozen.identity_json["code_revision"]
    assert now.deps_json == frozen.deps_json


def test_bundle_and_test_release_rows_reject_orm_and_raw_sql_mutation(env, ids):
    from dermpath.db import session_scope
    from dermpath.ml.engine_models import InferenceBundle, TestRelease, bundle_sha256_of
    from dermpath.ml.evaluation import create_test_release
    from dermpath.ml.inference import build_bundle
    from dermpath.ml.models import TrainingRun

    with session_scope() as db:
        run, _ = make_engine_run(db, cohort_dv(db, ids), seed=31)
        bundle, created, _ = build_bundle(db, _lead(), run)
        assert created
        rel, job = create_test_release(db, _lead(), run, reason="verification of append-only releases",
                                       candidate="bundle")
        rid, bid, rel_id = run.id, bundle.id, rel.id
        content = dict(bundle.content_json)
    z = "0" * 64
    forged = {**content, "threshold": {**content["threshold"], "value": 0.01}}
    for col, val in (("content_json", forged), ("bundle_sha256", bundle_sha256_of(forged)), ("object_key", "x"),
                     ("run_id", "r" * 32)):
        _refused_orm(lambda db, col=col, val=val: setattr(db.get(InferenceBundle, bid), col, val))
    _refused_orm(lambda db: db.delete(db.get(InferenceBundle, bid)))
    _refused_orm(lambda db: setattr(db.get(TrainingRun, rid), "bundle_id", "b" * 32))
    _refused_sql("UPDATE inference_bundle SET content_json = :c, bundle_sha256 = :s WHERE id = :id",
                 c=json.dumps(forged), s=bundle_sha256_of(forged), id=bid)
    _refused_sql("DELETE FROM inference_bundle WHERE id = :id", id=bid)
    _refused_sql("UPDATE training_run SET bundle_id = :b WHERE id = :id", b="b" * 32, id=rid)

    def forged_bundle(db):
        db.add(InferenceBundle(project_id=CID, run_id=rid, bundle_sha256=z, content_json=forged, object_key="x",
                               created_by=LEAD))

    _refused_orm(forged_bundle)
    for col, val in (("reason", "rewritten"), ("run_ids_json", ["x"]), ("release_number", 7),
                     ("justification", "after the fact"), ("job_id", "j" * 32), ("bundle_id", None)):
        _refused_orm(lambda db, col=col, val=val: setattr(db.get(TestRelease, rel_id), col, val))
    _refused_orm(lambda db: db.delete(db.get(TestRelease, rel_id)))
    _refused_sql("UPDATE test_release SET reason = 'rewritten' WHERE id = :id", id=rel_id)
    _refused_sql("UPDATE test_release SET job_id = :j WHERE id = :id", j="j" * 32, id=rel_id)
    _refused_sql("DELETE FROM test_release WHERE id = :id", id=rel_id)
    insert = ("INSERT INTO test_release (id, project_id, dataset_version_id, dataset_manifest_sha256, release_number, "
              "candidate_kind, bundle_id, run_ids_json, reason, justification, released_by, released_at) VALUES "
              "(:id, :p, :dv, :m, :n, 'bundle', :b, '[]', 'forged', :j, :by, '2026-10-26 00:00:00')")
    with session_scope() as db:
        r = db.get(TestRelease, rel_id)
        base = {"p": r.project_id, "dv": r.dataset_version_id, "m": r.dataset_manifest_sha256, "b": bid, "by": LEAD}
    _refused_sql(insert, id="forgedrelease00000000000000001", n=1, j=None, **base)  # a second "release 1"
    _refused_sql(insert, id="forgedrelease00000000000000002", n=2, j=None, **base)  # no justification
    _refused_sql(insert, id="forgedrelease00000000000000003", n=5, j="skip ahead", **base)  # not the next number
    with session_scope() as db:
        b = db.get(InferenceBundle, bid)
        assert b.content_json == content and b.bundle_sha256 == bundle_sha256_of(content)
        r = db.get(TestRelease, rel_id)
        assert r.reason == "verification of append-only releases" and r.job_id == job.id and r.release_number == 1
        assert db.get(TrainingRun, rid).bundle_id == bid


# =========================================================================== 2. QC changes after freeze / creation


def _screened_cohort(ids, project_id: str, n: int, exclude: int | None) -> dict:
    """A labelled real cohort whose slides were QC-screened (masks) BEFORE the freeze of a new dataset version,
    optionally with a resolved whole-slide exclude_region on one slide."""
    from dermpath.datasets import create_draft, freeze
    from dermpath.db import session_scope
    from dermpath.models import DatasetVersion, Project
    from dermpath.qc.service import run_screen

    rc = real_cohort(ids, n=n, project_id=project_id)
    for sid in rc["slide_ids"]:
        run_screen(sid)
    issue = _whole_slide_exclusion(rc["slide_ids"][exclude]) if exclude is not None else None
    with session_scope() as db:
        src = db.get(DatasetVersion, rc["dataset_version_id"])
        dv = create_draft(db, _lead(), db.get(Project, project_id), name="screened version",
                          config=dict(src.config_json))
        freeze(db, _lead(), dv, reason="screened dataset (verification)", acknowledge_warnings=True)
        items = {it["slide_id"]: it for it in dv.manifest_json["items"]}
        return {**rc, "dataset_version_id": dv.id, "items": items, "issue_id": issue}


def test_dataset_feature_set_keeps_the_frozen_qc_after_rescreen_and_region_reopen(env, ids, monkeypatch):
    from dermpath.db import session_scope
    from dermpath.ml import feature_sets as fsm
    from dermpath.qc import tissue
    from dermpath.qc.service import run_screen

    c = _screened_cohort(ids, "proj-verify-qc", n=4, exclude=0)
    excluded = c["slide_ids"][0]
    assert all(it.get("mask_sha256") for it in c["items"].values()), "the frozen manifest records QC masks"
    assert c["issue_id"] in c["items"][excluded]["excluded_region_issue_ids"]
    kw = dict(encoder_id=HANDCRAFTED, execution_mode="supervised_experiment",
              dataset_version_id=c["dataset_version_id"], params=SMALL)
    fs1 = create_set(c["project_id"], **kw)
    snap = get_set(fs1).input_snapshot_json
    # Attack: a new QC screen with a DIFFERENT mask on every slide, the exclusion reopened, a new exclusion elsewhere.
    real_segment = tissue.segment

    def other_mask(thumb, dims):
        mask, stats = real_segment(thumb, dims)
        return ~mask, stats

    monkeypatch.setattr(tissue, "segment", other_mask)
    for sid in c["slide_ids"]:
        run_screen(sid)
    _reopen(c["issue_id"])
    _whole_slide_exclusion(c["slide_ids"][1])
    fs2 = create_set(c["project_id"], **kw)
    assert fs2 == fs1 and get_set(fs1).input_snapshot_json == snap  # provably the same set
    with session_scope() as db:
        stale = fsm.staleness(db, get_set(fs1))
    assert stale["stale"] and {s["slide_id"] for s in stale["qc_changed_since_snapshot"]} == set(c["slide_ids"])
    assert _build(fs1)["status"] == "ready"
    for sid in c["slide_ids"]:
        art = _artifact(fs1, sid)
        assert art.mask_sha256 == c["items"][sid]["mask_sha256"]  # the manifest's mask, not the new screen
        assert art.excluded_regions_sha256 == c["items"][sid]["excluded_regions_sha256"]
    assert items_of(fs1)[excluded].stats_json["n_patches"] == 0  # the frozen exclusion still applies
    assert items_of(fs1)[c["slide_ids"][1]].stats_json["n_patches"] > 0  # the post-freeze exclusion does not


def test_explicit_set_snapshot_survives_region_resolve_and_reopen(env, ids, clients):
    from dermpath.db import session_scope
    from dermpath.ml import feature_sets as fsm

    sid = cmu_slide_id(ids)
    kw = dict(encoder_id=HANDCRAFTED, execution_mode="real_image_technical", slide_ids=[sid], params=SMALL)
    a = create_set(CMU_PROJECT, **kw)  # no exclusion in force
    issue = _whole_slide_exclusion(sid)
    b = create_set(CMU_PROJECT, **kw)  # the exclusion in force
    assert a != b
    _reopen(issue)  # the exclusion no longer in force; b was created with it
    _build(a)
    _build(b)
    assert items_of(a)[sid].stats_json["n_patches"] > 0
    assert items_of(b)[sid].stats_json["n_patches"] == 0
    for fs_id in (a, b):
        snap = get_set(fs_id).input_snapshot_json["slides"][0]
        assert _artifact(fs_id, sid).excluded_regions_sha256 == snap["excluded_regions_sha256"]
    with session_scope() as db:
        st = fsm.staleness(db, get_set(b))
    assert st["stale"] and "excluded_regions_sha256" in st["qc_changed_since_snapshot"][0]["changed"]
    r = clients(LEAD).get(f"/api/v1/feature-sets/{b}?staleness=true")  # the signal is visible through the API
    assert r.status_code == 200 and r.json()["staleness"]["stale"] is True and r.json()["status"] == "ready"


# =========================================================================== 3. replaced objects


def test_slide_bytes_rewritten_in_place_with_same_size_and_mtime_are_detected(env, ids):
    from dermpath.db import session_scope
    from dermpath.ml import feature_sets as fsm
    from dermpath.models import Slide
    from dermpath.storage import get_store

    rc = real_cohort(ids, n=2, project_id="proj-verify-bytes")
    s0, s1 = rc["slide_ids"]
    a = create_set(rc["project_id"], encoder_id=HANDCRAFTED, execution_mode="real_image_technical",
                   slide_ids=[s0, s1], params=SMALL)
    _build(a)
    pinned = np.array(fsm.load_slide_features(a, s1).embeddings)
    b = create_set(rc["project_id"], encoder_id=HANDCRAFTED, execution_mode="real_image_technical", slide_ids=[s1],
                   params={**SMALL, "sampling_seed": 7})
    with session_scope() as db:
        key = db.get(Slide, s1).object_key
    fsm.object_sha256(key)  # the per-process memo is warm
    _flip_last_byte_in_place(get_store().local_path(key))
    # The ready set is pinned: provably the same embeddings.
    assert np.array_equal(np.asarray(fsm.load_slide_features(a, s1).embeddings), pinned)
    # Anything that would READ the slide again is refused: a pending set and a label-free (inference) extraction.
    with pytest.raises(fsm.FeatureError, match="input_changed"):
        _build(b)
    with pytest.raises(fsm.FeatureError, match="input_changed"):
        fsm.extract_slide(s1, **fsm.extraction_kwargs(a))
    assert get_set(b).status == "failed" and items_of(b)[s1].status == "pending"


def test_encoder_weights_swapped_in_place_with_same_size_and_mtime_are_refused(env, ids, monkeypatch, tmp_path):
    torch = pytest.importorskip("torch")
    timm = pytest.importorskip("timm")
    import copy
    import dataclasses

    from dermpath.ml import encoders
    from dermpath.ml import feature_sets as fsm

    arch = copy.deepcopy(encoders.UNI_SPEC.architecture)
    arch["kwargs"].update({"embed_dim": 32, "depth": 2, "num_heads": 2})
    spec = dataclasses.replace(encoders.UNI_SPEC, architecture=arch, embedding_dim=32)
    wpath = tmp_path / "pytorch_model.bin"

    def weights(seed: int) -> bytes:
        torch.manual_seed(seed)
        model = timm.create_model(arch["model"], pretrained=False, **arch["kwargs"])
        p = tmp_path / f"w{seed}.bin"
        torch.save(model.eval().state_dict(), p)
        return p.read_bytes()

    for name in ("HF_HUB_OFFLINE", "TRANSFORMERS_OFFLINE", "HF_HUB_DISABLE_TELEMETRY"):
        monkeypatch.setenv(name, "1")
    wa, wb = weights(0), weights(1)
    if len(wa) != len(wb):
        pytest.skip("torch serialised the two random models with different sizes")
    wpath.write_bytes(wa)
    sha_a, sha_b = hashlib.sha256(wa).hexdigest(), hashlib.sha256(wb).hexdigest()
    monkeypatch.setenv("WB_UNI_WEIGHTS", str(wpath))
    monkeypatch.setenv("WB_UNI_LICENSE_ACCEPTED", "1")
    monkeypatch.setitem(encoders.REGISTRY, encoders.UNI_ID, encoders.UNIEncoder(spec))
    encoders.clear_loaded_encoders()
    sid = cmu_slide_id(ids)
    try:
        fs_id = create_set(CMU_PROJECT, encoder_id=encoders.UNI_ID, execution_mode="real_image_technical",
                           slide_ids=[sid], params={"max_patches_per_slide": 4, "device": "cpu"})
        assert get_set(fs_id).weights_sha256 == sha_a
        assert _build(fs_id)["status"] == "ready"  # model A is now cached in-process; its hash is memoised
        pinned = np.array(fsm.load_slide_features(fs_id, sid).embeddings)
        st = os.stat(wpath)
        with open(wpath, "r+b") as fh:  # same inode, same size ...
            fh.write(wb)
        os.utime(wpath, ns=(st.st_atime_ns, st.st_mtime_ns))  # ... and the old mtime
        assert os.stat(wpath).st_size == st.st_size and os.stat(wpath).st_mtime_ns == st.st_mtime_ns
        assert encoders.get_encoder(encoders.UNI_ID).weights_sha256() == sha_b  # the memo is not fooled
        with pytest.raises(encoders.EncoderIdentityMismatch):
            fsm.extract_slide(sid, **fsm.extraction_kwargs(fs_id))  # never the cached model A, never B silently
        with pytest.raises(encoders.EncoderIdentityMismatch):
            _build(fs_id)  # a repair pass refuses too
        assert np.array_equal(np.asarray(fsm.load_slide_features(fs_id, sid).embeddings), pinned)  # pinned
        other = create_set(CMU_PROJECT, encoder_id=encoders.UNI_ID, execution_mode="real_image_technical",
                           slide_ids=[sid], params={"max_patches_per_slide": 4, "device": "cpu"})
        assert other != fs_id and get_set(other).weights_sha256 == sha_b  # a NEW set, never the old one
    finally:
        encoders.clear_loaded_encoders()


def test_missing_or_corrupt_objects_are_refused_on_the_real_release_and_inference_paths(env, ids, clients):
    from dermpath.db import session_scope
    from dermpath.ml import feature_sets as fsm
    from dermpath.ml.engine_models import FeatureSet, InferenceBundle, InferencePrediction
    from dermpath.ml.models import Evaluation, Prediction
    from dermpath.models import DatasetVersion
    from dermpath.storage import get_store

    rc = real_cohort(ids, n=6, project_id="proj-verify-objects")
    fs_id = create_set(rc["project_id"], encoder_id=HANDCRAFTED, execution_mode="supervised_experiment",
                       dataset_version_id=rc["dataset_version_id"], params=SMALL)
    _build(fs_id)
    with session_scope() as db:
        run, _ = make_engine_run(db, db.get(DatasetVersion, rc["dataset_version_id"]), fs=db.get(FeatureSet, fs_id),
                                 mode="supervised_experiment", encoder_id=HANDCRAFTED, store_val=False, dim=64)
        rid, ck_key = run.id, run.checkpoint_key
    lead = clients(LEAD)
    reg = lead.post(f"/api/v1/experiments/{rid}/register")
    assert reg.status_code == 201, reg.text
    bid = reg.json()["bundle_id"]
    store = get_store()
    # (a) a pinned test-slide embeddings object disappears: the release job fails, nothing is re-extracted or stored.
    test_sid = next(s for s, sp in sorted(rc["split_of"].items()) if sp == "test")
    os.remove(store.local_path(_artifact(fs_id, test_sid).embeddings_key))
    fsm.clear_sha_memo()
    with pytest.raises(fsm.FeatureSetIntegrityError):
        fsm.load_slide_features(fs_id, test_sid)
    r = lead.post(f"/api/v1/experiments/{rid}/test-release", json={"reason": "verification", "candidate": "bundle"})
    assert r.status_code == 202, r.text
    out = run_engine_jobs(["evaluate_test_release"])
    assert [o.status for o in out] == ["failed"] and "pinned_artifact_missing_or_corrupt" in out[0].error
    assert _count(Evaluation, run_id=rid, split="test") == 0 and _count(Prediction, run_id=rid, split="test") == 0
    # (b) the checkpoint object is corrupted: inference refuses, nothing is recorded.
    train_sid = next(s for s, sp in sorted(rc["split_of"].items()) if sp == "train")
    data = store.get_bytes(ck_key)
    store.put_bytes(ck_key, data[:-1] + bytes([data[-1] ^ 0x01]))
    r = lead.post(f"/api/v1/bundles/{bid}/infer", json={"slide_id": train_sid})
    assert r.status_code == 202, r.text
    out = run_engine_jobs(["infer_slide"])
    assert [o.status for o in out] == ["failed"] and "checkpoint" in out[0].error
    assert _count(InferencePrediction, bundle_id=bid) == 0
    store.put_bytes(ck_key, data)
    # (c) the stored bundle object is corrupted: refused before anything is queued.
    with session_scope() as db:
        bkey = db.get(InferenceBundle, bid).object_key
    store.put_bytes(bkey, store.get_bytes(bkey) + b" ")
    r = lead.post(f"/api/v1/bundles/{bid}/infer", json={"slide_id": rc["slide_ids"][1]})
    assert r.status_code == 409 and r.json()["error"]["code"] == "bundle_integrity", r.text


def _real_engine_run(ids, project_id: str, n: int = 6) -> dict:
    """A built real-pixel feature set over a frozen cohort and a succeeded structural run pinned to it."""
    from dermpath.db import session_scope
    from dermpath.ml.engine_models import FeatureSet
    from dermpath.models import DatasetVersion

    rc = real_cohort(ids, n=n, project_id=project_id)
    fs_id = create_set(rc["project_id"], encoder_id=HANDCRAFTED, execution_mode="supervised_experiment",
                       dataset_version_id=rc["dataset_version_id"], params=SMALL)
    _build(fs_id)
    with session_scope() as db:
        run, _ = make_engine_run(db, db.get(DatasetVersion, rc["dataset_version_id"]), fs=db.get(FeatureSet, fs_id),
                                 mode="supervised_experiment", encoder_id=HANDCRAFTED, store_val=False, dim=64)
        return {**rc, "fs_id": fs_id, "run_id": run.id}


def test_test_release_scores_the_pinned_artifacts_after_slide_and_qc_changes(env, ids, clients, monkeypatch):
    """Provably identical: after the test slide's bytes are rewritten and its QC re-screened, a test release
    still scores exactly the pinned artifacts, re-extracts nothing, and gives the scores of those embeddings."""
    from dermpath.db import session_scope
    from dermpath.ml import feature_sets as fsm
    from dermpath.ml import training
    from dermpath.ml.evaluation import bags_from_items
    from dermpath.ml.models import FeatureArtifact, Prediction, TrainingRun
    from dermpath.models import DatasetVersion, Slide
    from dermpath.qc.service import run_screen
    from dermpath.storage import get_store

    c = _real_engine_run(ids, "proj-verify-release")
    test_slides = sorted(s for s, sp in c["split_of"].items() if sp == "test")
    pinned = {s: _artifact(c["fs_id"], s).id for s in test_slides}
    lead = clients(LEAD)
    assert lead.post(f"/api/v1/experiments/{c['run_id']}/register").status_code == 201
    for sid in test_slides:  # attack: the test slides change on disk and get a new QC screen
        run_screen(sid)
        with session_scope() as db:
            key = db.get(Slide, sid).object_key
        _flip_last_byte_in_place(get_store().local_path(key))
    fsm.clear_sha_memo()
    n_artifacts = _count(FeatureArtifact, project_id=c["project_id"])
    extract_calls = []
    real_extract = fsm._extract
    monkeypatch.setattr(fsm, "_extract", lambda *a, **kw: extract_calls.append(1) or real_extract(*a, **kw))
    r = lead.post(f"/api/v1/experiments/{c['run_id']}/test-release", json={"reason": "verification",
                                                                          "candidate": "bundle"})
    assert r.status_code == 202, r.text
    out = run_engine_jobs(["evaluate_test_release"])
    assert [o.status for o in out] == ["succeeded"], [(o.status, o.error) for o in out]
    assert not extract_calls and _count(FeatureArtifact, project_id=c["project_id"]) == n_artifacts
    with session_scope() as db:
        preds = db.scalars(select(Prediction).where(Prediction.run_id == c["run_id"], Prediction.split == "test")).all()
        assert sorted(a for p in preds for a in p.feature_artifact_ids_json) == sorted(pinned.values())
        run = db.get(TrainingRun, c["run_id"])
        dv = db.get(DatasetVersion, run.dataset_version_id)
        bags = bags_from_items([it for it in dv.manifest_json["items"] if it["split"] == "test"], run)
        for b in bags:
            b.embeddings = np.concatenate([np.asarray(fsm.load_slide_features(c["fs_id"], s).embeddings)
                                           for s in b.slide_ids])
        expected = {b.bag_id: s for b, s, *_ in training.score_bags_with_checkpoint(run, bags)}
        assert {p.bag_id: p.score for p in preds} == expected


def test_bundle_inference_never_uses_another_extractor_version(env, ids, clients, monkeypatch):
    """The bundle pins the set's ``extraction.extractor_version``. After an extraction-code upgrade (version
    correctly bumped), inference must refuse (a new bundle is needed), not score features of the new extractor.

    Corrected by the fix round: the simulated upgrade was the literal "dermpath.feature_sets/2", which became the
    real current version when the round bumped EXTRACTOR_VERSION; it is now derived from the current constant."""
    from dermpath.db import session_scope
    from dermpath.ml import feature_sets as fsm
    from dermpath.ml.engine_models import InferenceBundle
    from dermpath.ml.models import FeatureArtifact

    c = _real_engine_run(ids, "proj-verify-extractor-infer", n=4)
    lead = clients(LEAD)
    bid = lead.post(f"/api/v1/experiments/{c['run_id']}/register").json()["bundle_id"]
    with session_scope() as db:
        pinned = db.get(InferenceBundle, bid).content_json["encoder"]["spec"]["extraction"]["extractor_version"]
    # Deployed + worker restarted. Derived from the current constant (not the literal "dermpath.feature_sets/2"):
    # the fix round bumped the real version to /2, so the literal would no longer simulate an upgrade.
    monkeypatch.setattr(fsm, "EXTRACTOR_VERSION", fsm.EXTRACTOR_VERSION + "-next")
    r = lead.post(f"/api/v1/bundles/{bid}/infer", json={"slide_id": c["slide_ids"][0]})
    if r.status_code == 409:
        return
    assert r.status_code == 202, r.text
    out = run_engine_jobs(["infer_slide"])
    if out and out[0].status == "failed":
        return
    (p,) = lead.get(f"/api/v1/bundles/{bid}/predictions").json()["items"]
    with session_scope() as db:
        used = db.get(FeatureArtifact, p["feature_artifact_id"]).key_extra_json["extractor_version"]
    assert used == pinned, (f"prediction {p['id']} scored features of extractor {used}; the bundle pins {pinned} "
                            "and nothing refused or recorded the difference")


class _Jitter:
    """A loaded encoder whose re-extraction is not bit-identical (GPU, BLAS or thread scheduling): within the
    torch technical-validation tolerance (1e-4), as design §5 allows for re-extractions."""

    def __init__(self, inner):
        self._inner = inner

    def __getattr__(self, name):
        return getattr(self._inner, name)

    def embed_batch(self, patches):
        return (self._inner.embed_batch(patches) + np.float32(1e-5)).astype(np.float32)


def test_a_repair_never_serves_embeddings_that_differ_from_the_pinned_artifact(env, ids, monkeypatch):
    """The item pins artifact A (embeddings sha S). A's object goes missing; a repair re-extracts. Unless the new
    generation reproduces S (or the read is refused), experiments and test releases silently read other numbers."""
    from dermpath.ml import feature_sets as fsm
    from dermpath.storage import get_store

    sid = cmu_slide_id(ids)
    fs_id = create_set(CMU_PROJECT, encoder_id=HANDCRAFTED, execution_mode="real_image_technical", slide_ids=[sid],
                       params={"max_patches_per_slide": 8})
    _build(fs_id)
    pinned = _artifact(fs_id, sid)
    original = np.array(fsm.load_slide_features(fs_id, sid).embeddings)
    os.remove(get_store().local_path(pinned.embeddings_key))
    fsm.clear_sha_memo()
    real_load = fsm.load_encoder
    monkeypatch.setattr(fsm, "load_encoder", lambda *a, **kw: _Jitter(real_load(*a, **kw)))
    summary = _build(fs_id)  # repair pass on a ready set
    assert summary["repaired"] and summary["repaired"][0]["pinned_artifact_id"] == pinned.id
    try:
        served = fsm.load_slide_features(fs_id, sid)
    except fsm.FeatureSetIntegrityError:
        return  # an explicit refusal is acceptable
    got = np.asarray(served.embeddings)
    assert hashlib.sha256(np.ascontiguousarray(got).tobytes()).hexdigest() == \
        hashlib.sha256(np.ascontiguousarray(original).tobytes()).hexdigest(), (
        f"pinned artifact {pinned.id} (embeddings sha {pinned.embeddings_sha256[:12]}) was silently replaced by "
        f"artifact {served.artifact_id} with different embeddings (max |diff| "
        f"{float(np.abs(got - original).max()):.2e})")


def test_an_appended_artifact_row_cannot_substitute_the_pinned_embeddings(env, ids):
    """feature_artifact is append-only, so a new row with the pinned row's cache key and a higher generation can be
    INSERTED (ORM or SQL) without touching any frozen row. Once the pinned object is gone it must not be served."""
    import io

    from dermpath.db import session_scope
    from dermpath.ml import feature_sets as fsm
    from dermpath.ml.models import FeatureArtifact
    from dermpath.models import new_id
    from dermpath.storage import get_store

    sid = cmu_slide_id(ids)
    fs_id = create_set(CMU_PROJECT, encoder_id=HANDCRAFTED, execution_mode="real_image_technical", slide_ids=[sid],
                       params=SMALL)
    _build(fs_id)
    pinned = _artifact(fs_id, sid)
    original = np.array(fsm.load_slide_features(fs_id, sid).embeddings)
    buf = io.BytesIO()
    np.save(buf, np.zeros_like(original))
    key, sha = get_store().put_content_addressed(f"projects/{pinned.project_id}/features/embeddings/gen1",
                                                 buf.getvalue(), ".npy")
    with session_scope() as db:
        row = {c.key: getattr(pinned, c.key) for c in FeatureArtifact.__table__.columns}
        row.update(id=new_id(), generation=1, embeddings_key=key, embeddings_sha256=sha)
        db.add(FeatureArtifact(**row))  # an append: the guard allows it
    os.remove(get_store().local_path(pinned.embeddings_key))
    fsm.clear_sha_memo()
    try:
        served = fsm.load_slide_features(fs_id, sid)
    except fsm.FeatureSetIntegrityError:
        return
    assert np.array_equal(np.asarray(served.embeddings), original), (
        f"artifact {served.artifact_id} (embeddings sha {sha[:12]}) was served in place of pinned "
        f"{pinned.id} (sha {pinned.embeddings_sha256[:12]})")


# =========================================================================== 4. environment and code


def test_feature_set_build_refuses_a_changed_extraction_environment(env, ids, monkeypatch):
    from dermpath.ml import feature_sets as fsm

    fs_id = create_set(CMU_PROJECT, encoder_id=HANDCRAFTED, execution_mode="real_image_technical",
                       slide_ids=[cmu_slide_id(ids)], params=SMALL)
    _patch_library_version(monkeypatch, "pillow", "0.0-verify")
    with pytest.raises(fsm.FeatureError, match="extraction_env_changed"):
        _build(fs_id)
    assert get_set(fs_id).status == "failed" and all(i.status == "pending" for i in items_of(fs_id).values())


def test_bundle_inference_refuses_or_flags_a_changed_extraction_environment(env, ids, clients, monkeypatch):
    """A bundle pins the extraction environment (libraries, device class, precision). Inference in another
    environment must be refused (as a feature-set build is) or at least recorded as such: a prediction whose
    features came from another environment, with nothing saying so, is a silent change."""
    from dermpath.db import session_scope
    from dermpath.ml.encoders import ENCODER_SPECS
    from dermpath.ml.engine_models import InferenceBundle
    from dermpath.ml.handcrafted import code_identity
    from dermpath.ml.models import FeatureArtifact
    from dermpath.models import DatasetVersion

    with session_scope() as db:
        dv = db.get(DatasetVersion, ids["ml_demo"]["workflow"]["dataset_version_id"])
        run, _ = make_engine_run(db, dv, mode="supervised_experiment", encoder_id=HANDCRAFTED,
                                 weights_sha256=code_identity(), store_val=False,
                                 dim=ENCODER_SPECS[HANDCRAFTED].embedding_dim)
        rid = run.id
    lead = clients(LEAD)
    bid = lead.post(f"/api/v1/experiments/{rid}/register").json()["bundle_id"]
    with session_scope() as db:
        pinned_env = db.get(InferenceBundle, bid).content_json["extraction_env"]["sha256"]
    _patch_library_version(monkeypatch, "pillow", "0.0-verify")  # the worker's pillow is not the bundle's
    r = lead.post(f"/api/v1/bundles/{bid}/infer", json={"slide_id": cmu_slide_id(ids)})
    assert r.status_code in (202, 409), r.text
    if r.status_code == 409:
        return
    out = run_engine_jobs(["infer_slide"])
    if out and out[0].status == "failed":
        assert "env" in (out[0].error or ""), out[0].error
        return
    (p,) = lead.get(f"/api/v1/bundles/{bid}/predictions").json()["items"]
    with session_scope() as db:
        art_env = db.get(FeatureArtifact, p["feature_artifact_id"]).extraction_env_sha256
    flagged = "extraction_env" in json.dumps(p.get("input_snapshot") or {}) and art_env != pinned_env
    assert art_env == pinned_env or flagged, (
        f"prediction {p['id']} (score {p['score']:.4f}) was computed from features extracted in environment "
        f"{art_env[:12]}…, the bundle pins {pinned_env[:12]}…; the job succeeded and nothing records the mismatch")


def test_a_resumed_build_never_mixes_extractor_versions(env, ids, monkeypatch):
    """A set pins ``encoder_spec_json.extraction.extractor_version``. If the extraction code is upgraded (and its
    version correctly bumped) while a build is interrupted, the resumed build must refuse, not finish the set with
    artifacts from two extractor versions.

    Corrected by the fix round: the simulated upgrade was the literal "dermpath.feature_sets/2", which became the
    real current version when the round bumped EXTRACTOR_VERSION; it is now derived from the current constant."""
    from dermpath.ml import feature_sets as fsm

    rc = real_cohort(ids, n=3, project_id="proj-verify-extractor")
    fs_id = create_set(rc["project_id"], encoder_id=HANDCRAFTED, execution_mode="real_image_technical",
                       slide_ids=rc["slide_ids"], params=SMALL)
    pinned_version = get_set(fs_id).encoder_spec_json["extraction"]["extractor_version"]
    real_extract = fsm._extract
    calls = []

    def killed_after_one(snap, **kw):
        if calls:
            raise RuntimeError("worker killed (simulated)")
        calls.append(snap["slide_id"])
        return real_extract(snap, **kw)

    monkeypatch.setattr(fsm, "_extract", killed_after_one)
    with pytest.raises(RuntimeError):
        _build(fs_id)
    monkeypatch.setattr(fsm, "_extract", real_extract)
    # Deployed + worker restarted. Derived from the current constant (not the literal "dermpath.feature_sets/2"):
    # the fix round bumped the real version to /2, so the literal would no longer simulate an upgrade.
    monkeypatch.setattr(fsm, "EXTRACTOR_VERSION", fsm.EXTRACTOR_VERSION + "-next")
    try:
        _build(fs_id)
    except fsm.FeatureError:
        assert get_set(fs_id).status != "ready"
        return
    versions = {sid: _artifact(fs_id, sid).key_extra_json["extractor_version"] for sid in rc["slide_ids"]}
    assert set(versions.values()) == {pinned_version}, (
        f"feature set {fs_id} is 'ready' with artifacts from several extractor versions: {versions} "
        f"(the set pins {pinned_version})")


# =========================================================================== 5. training attempts


def test_a_crashed_train_job_resumes_to_the_uninterrupted_result(env, ids, monkeypatch):
    from dermpath.jobs.worker import Worker
    from dermpath.ml import training
    from dermpath.ml.engine_models import RunAttempt
    from dermpath.ml.models import Prediction

    crashed, _ = _new_cohort_experiment(ids, seed=912)
    real = training.store_development_evaluation
    calls = {"n": 0}

    def crash_once(*a, **kw):
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("worker crashed during the final commit (simulated)")
        return real(*a, **kw)

    monkeypatch.setattr(training, "store_development_evaluation", crash_once)
    assert Worker("w-crash", types=["train"]).run_once().status == "queued"
    twin, _ = _new_cohort_experiment(ids, seed=912)  # same identity inputs, never interrupted
    assert [o.status for o in run_jobs()] == ["succeeded", "succeeded"]
    a, b = _run_row(crashed), _run_row(twin)
    assert a.identity_json == b.identity_json and a.feature_set_id == b.feature_set_id
    assert a.checkpoint_sha256 == b.checkpoint_sha256 and a.threshold_value == b.threshold_value
    assert _count(RunAttempt, run_id=crashed) == 2 and _count(RunAttempt, run_id=twin) == 1
    from dermpath.db import session_scope

    with session_scope() as db:
        def scores(rid):
            return sorted((p.split, p.bag_id, p.score, p.predicted) for p in
                          db.scalars(select(Prediction).where(Prediction.run_id == rid)).all())
        assert scores(crashed) == scores(twin)


def test_a_crashed_train_job_resumed_after_a_code_edit_fails_with_run_identity_changed(env, ids, monkeypatch):
    from dermpath.jobs.worker import Worker
    from dermpath.ml import artifacts, training
    from dermpath.ml.engine_models import RunAttempt
    from dermpath.ml.models import Prediction

    rid, _ = _new_cohort_experiment(ids, seed=913)
    real = training.store_development_evaluation
    monkeypatch.setattr(training, "store_development_evaluation",
                        lambda *a, **kw: (_ for _ in ()).throw(RuntimeError("crash (simulated)")))
    assert Worker("w-crash", types=["train"]).run_once().status == "queued"
    monkeypatch.setattr(training, "store_development_evaluation", real)
    # The code on disk changes before the retry (what code_tree_drift sees after a deploy without a restart).
    files = dict(artifacts._CODE_FILES)
    victim = next(k for k in sorted(files) if k.endswith("ml/heads.py"))
    monkeypatch.setattr(artifacts, "_CODE_FILES", {**files, victim: "0" * 64})
    out = run_jobs()
    assert [o.status for o in out] == ["failed"] and out[0].error.startswith("run_identity_changed")
    assert "code_tree_drift" in out[0].error
    run = _run_row(rid)
    assert run.status == "failed" and run.checkpoint_sha256 is None and _count(Prediction, run_id=rid) == 0
    from dermpath.db import session_scope

    with session_scope() as db:
        att = db.scalars(select(RunAttempt).where(RunAttempt.run_id == rid).order_by(RunAttempt.attempt_number)).all()
        assert [x.outcome for x in att] == ["retryable_error", "run_identity_changed"]


def test_a_crashed_inline_build_resumed_after_a_slide_change_fails_permanently(env, ids, monkeypatch):
    from dermpath.db import session_scope
    from dermpath.jobs.worker import Worker
    from dermpath.ml import feature_sets as fsm
    from dermpath.ml.engine_models import RunAttempt
    from dermpath.ml.models import Prediction
    from dermpath.ml.service import create_experiment
    from dermpath.models import Job, Project, Slide
    from dermpath.storage import get_store

    rc = real_cohort(ids, n=4, project_id="proj-verify-resume")
    with session_scope() as db:
        run, job = create_experiment(db, _lead(), db.get(Project, rc["project_id"]),
                                     dataset_version_id=rc["dataset_version_id"], encoder_id=HANDCRAFTED,
                                     head="meanpool_logreg", params={**SMALL, "n_boot": 50}, seed=0, name=None)
        rid, jid, fs_id = run.id, job.id, run.feature_set_id
    assert get_set(fs_id).status == "building"
    real_extract = fsm._extract
    calls = []

    def killed_after_one(snap, **kw):
        if calls:
            raise RuntimeError("worker killed mid-build (simulated)")
        calls.append(snap["slide_id"])
        return real_extract(snap, **kw)

    monkeypatch.setattr(fsm, "_extract", killed_after_one)
    assert Worker("w-kill", types=["train"]).run_once().status == "queued"
    monkeypatch.setattr(fsm, "_extract", real_extract)
    done = {s for s, it in items_of(fs_id).items() if it.status == "done"}
    assert done == set(calls)
    victim = sorted(set(rc["slide_ids"]) - done)[-1]
    with session_scope() as db:
        key = db.get(Slide, victim).object_key
    _flip_last_byte_in_place(get_store().local_path(key))
    out = run_jobs(["train"])
    assert [o.status for o in out] == ["failed"], [(o.status, o.error) for o in out]
    assert out[0].error.startswith("feature_set_build_failed") and "input_changed" in out[0].error
    with session_scope() as db:
        assert db.get(Job, jid).attempts == 2
        att = db.scalars(select(RunAttempt).where(RunAttempt.run_id == rid).order_by(RunAttempt.attempt_number)).all()
        assert [x.outcome for x in att] == ["retryable_error", "failed"]
    assert _run_row(rid).status == "failed" and _count(Prediction, run_id=rid) == 0
    assert get_set(fs_id).status == "failed" and items_of(fs_id)[victim].status == "pending"


# =========================================================================== 6. concurrency


def test_two_concurrent_builders_of_one_set_agree(env, ids):
    from dermpath.db import session_scope
    from dermpath.ml import feature_sets as fsm
    from dermpath.ml.models import FeatureArtifact

    rc = real_cohort(ids, n=4, project_id="proj-verify-race")
    fs_id = create_set(rc["project_id"], encoder_id=HANDCRAFTED, execution_mode="real_image_technical",
                       slide_ids=rc["slide_ids"], params=SMALL)
    barrier = threading.Barrier(2)
    results: list = [None, None]

    def builder(k):
        barrier.wait()
        try:
            results[k] = ("ok", _build(fs_id))
        except Exception as exc:  # noqa: BLE001 - recorded and checked below
            results[k] = ("error", exc)

    threads = [threading.Thread(target=builder, args=(k,)) for k in range(2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(120)
    assert all(r is not None for r in results), "a builder hung"
    status = get_set(fs_id).status
    for kind, res in results:  # a builder that says "ready" must be telling the truth
        if kind == "ok":
            assert res["status"] == status, (res, status)
    if status != "ready":  # one builder failed explicitly (e.g. a lock): a plain resume must finish the set
        assert any(k == "error" for k, _ in results)
        assert _build(fs_id)["status"] == "ready"
    with session_scope() as db:
        rows = db.scalars(select(FeatureArtifact).where(FeatureArtifact.project_id == rc["project_id"])).all()
        keys = [(r.slide_id, r.cache_key, r.generation) for r in rows]
    assert len(keys) == len(set(keys)) == len(rc["slide_ids"]) and {g for _, _, g in keys} == {0}
    plan_items = items_of(fs_id)
    with session_scope() as db:
        plan = fsm._plan_of(db, db.get(fsm.FeatureSet, fs_id))
    loaded = fsm.load_encoder(plan.encoder_id, weights_sha256=plan.weights_sha256,
                              encoder_spec_sha256=plan.encoder_spec_sha256, device="cpu", precision="fp32")
    for sid in rc["slide_ids"]:
        assert plan_items[sid].status == "done"
        stored = fsm.load_slide_features(fs_id, sid)
        fresh = fsm._extract(plan.snapshots[sid], project_id=plan.project_id, encoder_id=plan.encoder_id,
                             encoder_spec=plan.encoder_spec, encoder_spec_sha256=plan.encoder_spec_sha256,
                             weights_sha256=plan.weights_sha256, weights_config_sha256=None,
                             encoder_config=plan.encoder_config, loaded=loaded, patch_policy=plan.patch_policy,
                             stain_policy=fsm._effective_stain(plan), device="cpu", precision="fp32",
                             env_sha256=plan.env_sha256, extraction=plan.extraction, use_cache=False, store=False)
        assert np.array_equal(np.asarray(stored.embeddings), fresh.embeddings)
        assert np.array_equal(stored.coords, fresh.coords)


# =========================================================================== 7. cache keys (design §5 list)


def test_cache_key_changes_for_every_input_listed_in_design_section_5():
    from dermpath.ml import feature_sets as fsm
    from dermpath.ml.artifacts import EXTRACTION_LIBRARIES, extraction_env

    def prep(**over):
        o = {"slide_sha256": "a" * 64, "excluded_regions_sha256": "b" * 64, "mask": "c" * 64, "coords": "d" * 64,
             **over}
        return types.SimpleNamespace(snap={"slide_sha256": o["slide_sha256"],
                                           "excluded_regions_sha256": o["excluded_regions_sha256"]},
                                     mask_info={"source": "qc_screen", "sha256": o["mask"]},
                                     sampled=types.SimpleNamespace(sha256=o["coords"]))

    def key(p=None, **kw):
        args = {"encoder_id": HANDCRAFTED, "encoder_spec_sha256": "e" * 64, "weights_sha256": "f" * 64,
                "weights_config_sha256": None, "encoder_config": {},
                "patch_policy": types.SimpleNamespace(policy_sha256="1" * 64, sampling=types.SimpleNamespace(seed=0)),
                "stain_policy": types.SimpleNamespace(policy_sha256="2" * 64), "env_sha256": "3" * 64,
                "extraction": {"pixel_mode": "read", "batch_size": 32, "cpu_threads": None}, "fixture_label": None,
                "synthetic": False, **kw}
        return fsm._sha_json(fsm._key_fields(p or prep(), **args))

    base = key()
    variants = {
        "slide_sha256": key(prep(slide_sha256="9" * 64)),
        "encoder_spec_sha256": key(encoder_spec_sha256="9" * 64),
        "weights_sha256": key(weights_sha256="9" * 64),
        "policy_sha256": key(patch_policy=types.SimpleNamespace(policy_sha256="9" * 64,
                                                                 sampling=types.SimpleNamespace(seed=0))),
        "stain_policy_sha256": key(stain_policy=types.SimpleNamespace(policy_sha256="9" * 64)),
        "mask_sha256": key(prep(mask="9" * 64)),
        "excluded_regions_sha256": key(prep(excluded_regions_sha256="9" * 64)),
        "coords_sha256": key(prep(coords="9" * 64)),
        "extraction_env_sha256": key(env_sha256="9" * 64),
    }
    assert all(v != base for v in variants.values()), [k for k, v in variants.items() if v == base]
    assert len(set(variants.values())) == len(variants)
    # extraction_env_sha256 covers every listed library, the device class and the precision.
    env0 = dict(extraction_env("cpu", "fp32")[0]["libraries"])
    sha0 = extraction_env("cpu", "fp32", versions={**env0, "machine": "arm64"})[1]
    changed = {}
    for lib in EXTRACTION_LIBRARIES:
        changed[lib] = extraction_env("cpu", "fp32", versions={**env0, "machine": "arm64", lib: "0.0-other"})[1]
    changed["device_class"] = extraction_env("mps", "fp32", versions={**env0, "machine": "arm64"})[1]
    changed["precision"] = extraction_env("cpu", "fp16", versions={**env0, "machine": "arm64"})[1]
    changed["machine"] = extraction_env("cpu", "fp32", versions={**env0, "machine": "x86_64"})[1]
    assert all(v != sha0 for v in changed.values()), [k for k, v in changed.items() if v == sha0]
    assert {"openslide (C library)", "openslide-python", "pillow", "numpy", "torch", "timm", "transformers",
            "safetensors"} <= set(EXTRACTION_LIBRARIES)
