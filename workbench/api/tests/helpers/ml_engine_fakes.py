"""Engine fixtures and fakes for the evaluation / test-release / inference / active-learning tests.

The partners' functions (``feature_sets.load_slide_features``, ``require_ready``, ``extract_slide`` and
``training.score_bags_with_checkpoint``) are replaced by small, faithful fakes so these tests exercise the
W7b code against the interface contract only. ``make_engine_run`` writes a SUCCEEDED run directly
(identity set at INSERT), with a real meanpool checkpoint in the object store, a ready feature set over the
frozen cohort manifest, and stored validation predictions plus their evaluation.

Fake embeddings derive from the slide id only (never from a label): they carry no class signal.
"""

from __future__ import annotations

import hashlib
import uuid
from dataclasses import dataclass, field

import numpy as np

LEAD = "user-research-lead"
CID = "proj-synthetic-cohort"
DIM = 16


@dataclass
class FakeSlideFeatures:
    slide_id: str
    embeddings: np.ndarray
    coords: np.ndarray
    quality: dict = field(default_factory=dict)
    artifact_id: str | None = None
    weights_sha256: str = ""
    encoder_spec_sha256: str = ""
    policy_sha256: str = ""
    n_patches: int = 0
    stain_policy_sha256: str | None = None  # the real SlideFeatures carries the effective stain policy sha


def fake_embeddings(slide_id: str, n: int = 6, dim: int = DIM) -> np.ndarray:
    seed = int(hashlib.sha256(slide_id.encode()).hexdigest()[:8], 16)
    return np.random.default_rng(seed).normal(size=(n, dim)).astype(np.float32)


def _sha(obj) -> str:
    return hashlib.sha256(repr(obj).encode()).hexdigest()


def make_feature_set(db, project_id: str, dv_id: str | None, slide_ids, *, mode: str = "synthetic_pipeline_test",
                     encoder_id: str = "synthetic-deterministic-v1", weights_sha256: str | None = None,
                     ready: bool = True, skip_items=()):
    from dermpath.db import utcnow
    from dermpath.ml.artifacts import extraction_env
    from dermpath.ml.encoders import ENCODER_SPECS
    from dermpath.ml.engine_models import FeatureSet, FeatureSetItem
    from dermpath.ml.patching import PatchPolicy
    from dermpath.ml.stain import StainPolicy

    spec = ENCODER_SPECS[encoder_id]
    pp = PatchPolicy(patch_size=spec.input_size or 224)
    stain = StainPolicy.none()
    env, env_sha = extraction_env("cpu", "fp32")
    snap = {"slides": sorted(slide_ids), "nonce": uuid.uuid4().hex}
    fs = FeatureSet(project_id=project_id, name=f"fake {encoder_id}", execution_mode=mode, dataset_version_id=dv_id,
                    encoder_id=encoder_id, encoder_spec_json=spec.to_dict(), encoder_spec_sha256=spec.spec_sha256(),
                    weights_sha256=weights_sha256 or f"fake-weights-{encoder_id}", patch_policy_json=pp.to_json(),
                    policy_sha256=pp.policy_sha256, stain_policy_json=stain.to_json(),
                    stain_policy_sha256=stain.policy_sha256, extraction_env_json=env, extraction_env_sha256=env_sha,
                    input_snapshot_json=snap, input_snapshot_sha256=_sha(snap), spec_sha256=_sha(("fs", snap)),
                    status="building", created_by=LEAD)
    db.add(fs)
    db.flush()
    from dermpath.models import Slide

    for sid in sorted(slide_ids):
        if sid in skip_items:
            continue
        s = db.get(Slide, sid)
        db.add(FeatureSetItem(feature_set_id=fs.id, project_id=project_id, slide_id=sid, slide_sha256=s.sha256,
                              status="done", done_at=utcnow()))
    db.flush()
    if ready:
        fs.status = "ready"
        fs.ready_at = utcnow()
        db.flush()
    return fs


def checkpoint(dim: int = DIM, seed: int = 0, *, encoder_id: str = "synthetic-deterministic-v1") -> bytes:
    from dermpath.ml.heads import checkpoint_bytes

    rng = np.random.default_rng(seed)
    arrays = {"scaler_mean": np.zeros(dim), "scaler_scale": np.ones(dim), "coef": rng.normal(size=dim) * 0.8,
              "intercept": np.array([0.0])}
    meta = {"head": "meanpool_logreg", "in_dim": dim, "params": {}, "seed": seed, "encoder_id": encoder_id,
            "research_use_only": True}
    return checkpoint_bytes(arrays, meta)


def fake_score_bags_with_checkpoint(run, bags):
    """Reference scorer for the contract: checkpoint (sha verified) → score → calibration → threshold → abstention."""
    from dermpath.jobs.registry import PermanentJobError
    from dermpath.ml.calibration import apply_calibration
    from dermpath.ml.heads import load_checkpoint
    from dermpath.ml.metrics import ABSTENTION_SCHEMA, apply_abstention
    from dermpath.storage import get_store

    data = get_store().get_bytes(run.checkpoint_key)
    if hashlib.sha256(data).hexdigest() != run.checkpoint_sha256:
        raise PermanentJobError("checkpoint sha256 mismatch")
    model = load_checkpoint(data)
    out = []
    for b in bags:
        s = float(model.score(b.embeddings)[0])
        cal = None
        if isinstance(run.calibration_json, dict) and run.calibration_json.get("method") not in (None, "none"):
            cal = float(apply_calibration(run.calibration_json, [s])[0])
        abst = False
        if isinstance(run.abstention_json, dict) and run.abstention_json.get("schema") == ABSTENTION_SCHEMA:
            abst = bool(apply_abstention([s], run.abstention_json)[0])
        out.append((b, s, cal, int(s >= float(run.threshold_value)), abst))
    return out


class Calls:
    def __init__(self):
        self.load: list[str] = []
        self.extract: list[dict] = []
        self.score: int = 0


def install_fakes(monkeypatch, *, corrupt=(), weights_override: dict | None = None, extract_weights: str | None = None,
                  extract_raises: Exception | None = None, n_patches: dict | None = None) -> Calls:
    """Patch the partners' feature-set and scoring functions with fakes; returns a call recorder."""
    from dermpath.ml import feature_sets as fsm
    from dermpath.ml import training
    from sqlalchemy import select

    calls = Calls()
    not_ready = getattr(fsm, "FeatureSetNotReady", None)
    if not isinstance(not_ready, type):
        class FeatureSetNotReady(Exception):  # noqa: N818 - contract name
            def __init__(self, missing=()):
                self.missing = list(missing)
                super().__init__(f"feature set not ready for {len(self.missing)} slide(s)")

        not_ready = FeatureSetNotReady
        monkeypatch.setattr(fsm, "FeatureSetNotReady", not_ready, raising=False)
    integrity = getattr(fsm, "FeatureSetIntegrityError", None)
    if not isinstance(integrity, type):
        class FeatureSetIntegrityError(Exception):
            pass

        integrity = FeatureSetIntegrityError
        monkeypatch.setattr(fsm, "FeatureSetIntegrityError", integrity, raising=False)

    def make_not_ready(missing):
        try:
            return not_ready(missing=missing)
        except TypeError:
            return not_ready(f"missing: {missing}")

    def require_ready(db, fs, slide_ids):
        from dermpath.ml.engine_models import FeatureSetItem

        done = set(db.scalars(select(FeatureSetItem.slide_id).where(FeatureSetItem.feature_set_id == fs.id,
                                                                    FeatureSetItem.status == "done")).all())
        missing = sorted(set(slide_ids) - done)
        if fs.status != "ready" or missing:
            raise make_not_ready(missing)

    def load_slide_features(fs, slide_id):
        calls.load.append(slide_id)
        if slide_id in corrupt:
            raise integrity(f"object of slide {slide_id} is missing (sha256 check failed)")
        n = (n_patches or {}).get(slide_id, 6)
        emb = fake_embeddings(slide_id, n=n)
        return FakeSlideFeatures(slide_id=slide_id, embeddings=emb, coords=np.zeros((n, 2), dtype=np.int64),
                                 quality={}, artifact_id=None,
                                 weights_sha256=(weights_override or {}).get(slide_id, fs.weights_sha256),
                                 encoder_spec_sha256=fs.encoder_spec_sha256, policy_sha256=fs.policy_sha256,
                                 n_patches=n, stain_policy_sha256=fs.stain_policy_sha256)

    def extract_slide(slide_id, *, encoder_id, weights_sha256, encoder_spec_sha256, patch_policy, sampling_policy,
                      stain_policy, device, precision, input_snapshot, ctx=None, **extra):
        calls.extract.append({"slide_id": slide_id, "encoder_id": encoder_id, "weights_sha256": weights_sha256,
                              "encoder_spec_sha256": encoder_spec_sha256, "policy_sha256": patch_policy.policy_sha256,
                              "sampling": sampling_policy.to_json(), "stain": stain_policy.to_json(),
                              "device": device, "precision": precision, "input_snapshot": input_snapshot,
                              "extra": sorted(extra)})
        if extract_raises is not None:
            raise extract_raises
        n = (n_patches or {}).get(slide_id, 6)
        emb = fake_embeddings(slide_id, n=n)
        return FakeSlideFeatures(slide_id=slide_id, embeddings=emb, coords=np.zeros((n, 2), dtype=np.int64),
                                 artifact_id=None, weights_sha256=extract_weights or weights_sha256,
                                 encoder_spec_sha256=encoder_spec_sha256, policy_sha256=patch_policy.policy_sha256,
                                 n_patches=n, stain_policy_sha256=stain_policy.policy_sha256)

    def score(run, bags):
        calls.score += 1
        return fake_score_bags_with_checkpoint(run, bags)

    monkeypatch.setattr(fsm, "require_ready", require_ready, raising=False)
    monkeypatch.setattr(fsm, "load_slide_features", load_slide_features, raising=False)
    monkeypatch.setattr(fsm, "extract_slide", extract_slide, raising=False)
    monkeypatch.setattr(training, "score_bags_with_checkpoint", score, raising=False)
    return calls


def cohort_dv(db, ids):
    from dermpath.models import DatasetVersion

    return db.get(DatasetVersion, ids["ml_demo"]["cohort"]["dataset_version_id"])


def make_engine_run(db, dv, *, fs=None, mode: str = "synthetic_pipeline_test",
                    encoder_id: str = "synthetic-deterministic-v1", seed: int = 0, threshold: float = 0.5,
                    calibration: dict | None = None, abstention: dict | None = None, protocol: str = "holdout",
                    family_id: str | None = None, params: dict | None = None, store_val: bool = True,
                    skip_items=(), weights_sha256: str | None = None, dim: int = DIM):
    """A succeeded engine run on ``dv`` with stored val predictions (fake embeddings, real checkpoint)."""
    from dermpath.db import utcnow
    from dermpath.ml.config import resolve_params
    from dermpath.ml.evaluation import bags_from_items, build_evaluation, store_evaluation
    from dermpath.ml.models import Prediction, TrainingRun
    from dermpath.storage import get_store

    manifest = dv.manifest_json
    slide_ids = sorted({it["slide_id"] for it in manifest["items"]})
    if fs is None:
        fs = make_feature_set(db, dv.project_id, dv.id, slide_ids, mode=mode, encoder_id=encoder_id,
                              weights_sha256=weights_sha256, skip_items=skip_items)
    data = checkpoint(dim, seed=seed, encoder_id=encoder_id)
    key, sha = get_store().put_content_addressed(f"projects/{dv.project_id}/checkpoints", data, ".npz")
    values = list(dv.config_json.get("label_values"))
    pos = "bcc_present" if "bcc_present" in values else values[0]
    neg = next(v for v in values if v != pos)
    p = resolve_params({"n_boot": 200, **(params or {})})
    now = utcnow()
    run = TrainingRun(project_id=dv.project_id, name=f"fake engine run seed {seed}", dataset_version_id=dv.id,
                      dataset_manifest_sha256=dv.manifest_sha256, encoder_id=fs.encoder_id, head="meanpool_logreg",
                      params_json=p, seed=seed, status="succeeded", synthetic=mode == "synthetic_pipeline_test",
                      synthetic_reasons_json=["fake fixture"] if mode == "synthetic_pipeline_test" else [],
                      label_scope=dv.config_json.get("label_scope", "slide"), positive_class=pos, negative_class=neg,
                      execution_mode=mode, feature_set_id=fs.id, evaluation_protocol=protocol,
                      identity_json={"code_tree_sha256": "c" * 64, "code_revision": "fake", "deps": {"numpy": "x"}},
                      identity_sha256="d" * 64, family_id=family_id, weights_sha256=fs.weights_sha256,
                      checkpoint_key=key, checkpoint_sha256=sha, checkpoint_bytes=len(data),
                      threshold_value=threshold, threshold_rule="youden", threshold_frozen_at=now,
                      threshold_json={"value": threshold, "rule": "youden", "selected_on": "val",
                                      "selection_status": "selected", "reason": None},
                      calibration_json=calibration, abstention_json=abstention, created_by=LEAD,
                      started_at=now, finished_at=now, metrics_json={})
    db.add(run)
    db.flush()
    if store_val:
        items = [it for it in manifest["items"] if it.get("split") == "val"]
        bags = bags_from_items(items, run)
        for b in bags:
            b.embeddings = np.concatenate([fake_embeddings(s, dim=dim) for s in b.slide_ids])
        preds = []
        for b, s, _cal, pred, abst in fake_score_bags_with_checkpoint(run, bags):
            preds.append(Prediction(run_id=run.id, project_id=run.project_id, split="val", bag_kind=b.kind,
                                    bag_id=b.bag_id, slide_ids_json=b.slide_ids, case_id=b.case_id,
                                    coded_patient_id=b.patient_id, patient_code=b.patient_code,
                                    label_value=b.label_value, label_version_ids_json=b.label_version_ids,
                                    label=b.label, score=s, threshold=threshold, predicted=pred, abstained=abst,
                                    attributes_json={**b.attributes, "n_patches": b.n_patches,
                                                     "qc_context": {"qc_issues": [], "uncalibrated_slides": []}},
                                    feature_artifact_ids_json=[]))
        body = build_evaluation(run, "val", preds, [], manifest=manifest, db=db)
        for pr in preds:
            db.add(pr)
        db.flush()
        store_evaluation(db, run, "val", body, computed_by="system:worker")
    return run, fs


def run_jobs(types):
    from dermpath.jobs.worker import Worker

    return Worker("w7b-test-worker", types=list(types)).run_until_idle()
