"""Shared helpers for the inference scope / input-snapshot / memory tests (this module defines no tests).

* :func:`slide_run` / :func:`case_run` write a SUCCEEDED real-mode engine run (``ml_engine_fakes.make_engine_run``)
  whose ``label_scope`` is ``slide`` or ``case``; :func:`register` builds its inference bundle through the API.
* :func:`fake_slide` adds a ``public_cc0`` WSI record (no stored object: only the faked extraction reads it).
* :func:`snapshot_aware_fakes` installs the contract fakes and replaces ``feature_sets.extract_slide`` with a fake
  whose embeddings derive from the extraction-affecting fields of the input snapshot it was given (or, like the
  real function, of a live snapshot when given ``None``), so a test can tell which inputs a score or an embedding
  came from. Embeddings never derive from a label.
"""

from __future__ import annotations

import hashlib
import types

import numpy as np

from ml_engine_fakes import CID, DIM, LEAD, FakeSlideFeatures, cohort_dv, install_fakes, make_engine_run

HANDCRAFTED = "handcrafted-stain-texture-v1"
#: Snapshot fields that decide the fake's embeddings (present in the old provenance snapshot and the new one).
FAKE_KEYS = ("slide_sha256", "mpp_x", "mpp_y", "mask_sha256", "excluded_regions_sha256")


def slide_run(ids, *, dim: int = DIM) -> str:
    from dermpath.db import session_scope

    with session_scope() as db:
        run, _ = make_engine_run(db, cohort_dv(db, ids), mode="supervised_experiment", encoder_id=HANDCRAFTED,
                                 weights_sha256="handcrafted:test-identity", store_val=False, dim=dim)
        return run.id


def case_run(ids, *, dim: int = DIM) -> str:
    """A succeeded real-mode run trained on CASE bags (``label_scope == "case"``)."""
    from dermpath.db import session_scope

    with session_scope() as db:
        dv = cohort_dv(db, ids)
        case_dv = types.SimpleNamespace(id=dv.id, project_id=dv.project_id, manifest_json=dv.manifest_json,
                                        manifest_sha256=dv.manifest_sha256,
                                        config_json={**(dv.config_json or {}), "label_scope": "case"})
        run, _ = make_engine_run(db, case_dv, mode="supervised_experiment", encoder_id=HANDCRAFTED,
                                 weights_sha256="handcrafted:test-identity", store_val=False, dim=dim)
        assert run.label_scope == "case"
        return run.id


def register(clients, rid: str) -> str:
    r = clients(LEAD).post(f"/api/v1/experiments/{rid}/register")
    assert r.status_code in (200, 201), r.text
    return r.json()["bundle_id"]


def fake_slide(project_id: str = CID, *, block_id: str | None = None, tag: str = "") -> str:
    from dermpath.db import session_scope, utcnow
    from dermpath.models import Slide, new_id

    with session_scope() as db:
        sid = new_id()
        db.add(Slide(id=sid, project_id=project_id, block_id=block_id, level_index=9 if block_id else None,
                     provenance="public_cc0", image_kind="wsi",
                     object_key=f"projects/{project_id}/slides/{sid}/original.svs",
                     sha256=hashlib.sha256(f"{sid}{tag}".encode()).hexdigest(), bytes=1, format="aperio", width=2000,
                     height=1500, levels=1, level_dimensions_json=[[2000, 1500]], level_downsamples_json=[1.0],
                     mpp_x=0.5, mpp_y=0.5, ingest_status="succeeded", ingested_at=utcnow(), created_by=LEAD))
        return sid


def set_mpp(slide_id: str, mpp: float | None) -> None:
    """A calibration edit (the slide's effective microns per pixel)."""
    from dermpath.db import session_scope
    from dermpath.models import Slide

    with session_scope() as db:
        s = db.get(Slide, slide_id)
        s.mpp_x = s.mpp_y = mpp


def fake_embeddings_for(slide_id: str, snapshot: dict, *, n: int = 6, dim: int = DIM) -> np.ndarray:
    key = "|".join([slide_id] + [repr(snapshot.get(k)) for k in FAKE_KEYS])
    seed = int(hashlib.sha256(key.encode()).hexdigest()[:8], 16)
    return np.random.default_rng(seed).normal(size=(n, dim)).astype(np.float32)


def snapshot_aware_fakes(monkeypatch, *, dim: int = DIM, n: int = 6, before_extract=None):
    """Contract fakes whose extraction depends on (and records) the snapshot it reads."""
    calls = install_fakes(monkeypatch)
    from dermpath.ml import feature_sets as fsm
    from dermpath.ml.artifacts import extraction_env

    def extract_slide(slide_id, *, encoder_id, weights_sha256, encoder_spec_sha256, patch_policy, sampling_policy,
                      stain_policy, device, precision, input_snapshot, ctx=None, **extra):
        if before_extract is not None:
            before_extract(slide_id)
        snap = input_snapshot if input_snapshot is not None else fsm.live_snapshot(slide_id)
        calls.extract.append({"slide_id": slide_id, "input_snapshot": input_snapshot, "used_snapshot": snap})
        emb = fake_embeddings_for(slide_id, snap, n=n, dim=dim)
        return FakeSlideFeatures(slide_id=slide_id, embeddings=emb, coords=np.zeros((n, 2), dtype=np.int64),
                                 artifact_id=None, weights_sha256=weights_sha256,
                                 encoder_spec_sha256=encoder_spec_sha256, policy_sha256=patch_policy.policy_sha256,
                                 n_patches=n, stain_policy_sha256=stain_policy.policy_sha256,
                                 extraction_env_sha256=extraction_env(device, precision)[1],
                                 meta={"fields": {"extractor_version": fsm.EXTRACTOR_VERSION}})

    monkeypatch.setattr(fsm, "extract_slide", extract_slide)
    return calls


def checkpoint_model(rid: str):
    """The run's checkpoint, loaded (to recompute a score from known embeddings)."""
    from dermpath.db import session_scope
    from dermpath.ml.heads import load_checkpoint
    from dermpath.ml.models import TrainingRun
    from dermpath.storage import get_store

    with session_scope() as db:
        key = db.get(TrainingRun, rid).checkpoint_key
    return load_checkpoint(get_store().get_bytes(key))


def prediction_rows(bundle_id: str, slide_id: str | None = None) -> list:
    from sqlalchemy import select

    from dermpath.db import session_scope
    from dermpath.ml.engine_models import InferencePrediction

    with session_scope() as db:
        q = select(InferencePrediction).where(InferencePrediction.bundle_id == bundle_id)
        if slide_id is not None:
            q = q.where(InferencePrediction.slide_id == slide_id)
        rows = db.scalars(q.order_by(InferencePrediction.created_at, InferencePrediction.id)).all()
        for r in rows:
            db.expunge(r)
        return rows


__all__ = ["CID", "DIM", "HANDCRAFTED", "LEAD", "case_run", "checkpoint_model", "fake_embeddings_for", "fake_slide",
           "prediction_rows", "register", "set_mpp", "slide_run", "snapshot_aware_fakes"]
