"""The ``train`` job: frozen dataset → features → bags → head → val threshold (frozen) → records.

Test-set lock
-------------
Training data come ONLY from ``training_eligible_items(purpose="train")`` and validation
data ONLY from ``purpose="validation"``. Before any fit, :func:`assert_no_test` re-checks
every bag against the frozen manifest's test assignments. The threshold is selected on
validation scores only and frozen (``threshold_frozen_at``) inside this job; test items are
scored later, on explicit request by the research lead (:mod:`dermpath.ml.evaluation`).

Idempotency / restart safety
----------------------------
All outputs (predictions, the validation evaluation, threshold, checkpoint reference,
status) are committed in ONE final transaction. A crashed attempt leaves at most cached
feature artifacts (content-addressed, reusable) and a checkpoint object at a run-scoped key
that the rerun overwrites with identical bytes (same data, params and seed → same bytes).
A rerun after success returns the stored result.
"""

from __future__ import annotations

import time
from collections import OrderedDict

import numpy as np
from sqlalchemy import select

from .. import audit
from ..datasets import TestSetLockViolation, training_eligible_items
from ..db import session_scope, utcnow
from ..jobs.registry import PermanentJobError
from ..models import DatasetVersion, LabelVersion, QCIssue, Slide
from ..storage import get_store
from .artifacts import code_revision, dependency_versions, sha256_hex
from .encoders import EncoderUnavailable, get_encoder
from .features import FeatureError, extract_slide_features, load_features
from .heads import HEAD_FITTERS, Bag, LoadedModel, checkpoint_bytes, load_checkpoint
from .metrics import select_threshold
from .models import FeatureArtifact, Prediction, TrainingRun

ATTR_KEYS = ("scanner_id", "site_id", "stain")


class _Progress:
    def __init__(self, ctx, base: float, span: float) -> None:
        self.ctx, self.base, self.span = ctx, base, span

    def __call__(self, frac: float, message: str) -> None:
        if self.ctx is not None:
            self.ctx.progress(self.base + self.span * max(0.0, min(1.0, frac)), message)


def assert_no_test(bags: list[Bag], manifest: dict, where: str) -> None:
    """Defence in depth: no slide or patient assigned to test may reach training/threshold/AL."""
    test_slides = {it["slide_id"] for it in manifest["items"] if it.get("split") == "test"}
    test_patients = {s["coded_patient_id"] for s in manifest.get("splits", []) if s.get("split") == "test"}
    for b in bags:
        if set(b.slide_ids) & test_slides or b.patient_id in test_patients:
            raise TestSetLockViolation(f"test item reached {where} (bag {b.bag_id})")


def _attr(values: list) -> str | None:
    vals = {v for v in values}
    if len(vals) == 1:
        return next(iter(vals))
    return "mixed"


def qc_context(db, slide_ids: list[str]) -> dict:
    """Snapshot of QC/calibration facts at prediction time (used as possible failure reasons)."""
    issues = db.scalars(select(QCIssue).where(QCIssue.slide_id.in_(slide_ids))).all()
    open_or_confirmed = sorted({f"{i.category} ({i.status})" for i in issues if not i.overridden})
    uncalibrated = []
    for s in db.scalars(select(Slide).where(Slide.id.in_(slide_ids))).all():
        if s.image_kind == "wsi" and (s.mpp_x is None or s.mpp_y is None):
            uncalibrated.append(s.id)
    return {"qc_issues": open_or_confirmed, "uncalibrated_slides": uncalibrated}


def build_bags(items: list[dict], label_scope: str, positive_class: str) -> list[Bag]:
    groups: "OrderedDict[str, list[dict]]" = OrderedDict()
    for it in sorted(items, key=lambda r: (r["case_id"], r["slide_id"])):
        key = it["slide_id"] if label_scope == "slide" else it["case_id"]
        groups.setdefault(key, []).append(it)
    bags = []
    for key, rows in groups.items():
        values = {r["label_value"] for r in rows}
        if len(values) != 1:
            raise PermanentJobError(f"bag {key} has conflicting labels {sorted(values)}")
        value = next(iter(values))
        bags.append(Bag(
            bag_id=key, kind=label_scope, slide_ids=[r["slide_id"] for r in rows], case_id=rows[0]["case_id"],
            patient_id=rows[0]["coded_patient_id"], patient_code=rows[0].get("patient_code"), label_value=value,
            label=1 if value == positive_class else 0,
            label_version_ids=sorted({r["label_version_id"] for r in rows}),
            attributes={k: _attr([r.get(k) for r in rows]) for k in ATTR_KEYS}))
    return bags


def attach_features(bags: list[Bag], artifact_by_slide: dict[str, str]) -> None:
    with session_scope() as db:
        arts = {a.id: a for a in db.scalars(select(FeatureArtifact).where(
            FeatureArtifact.id.in_(list(artifact_by_slide.values())))).all()}
        for a in arts.values():
            db.expunge(a)
    for b in bags:
        embs, coords, idx, extents = [], [], [], []
        b.artifact_ids = [artifact_by_slide[s] for s in b.slide_ids]
        for j, sid in enumerate(b.slide_ids):
            arr = load_features(arts[artifact_by_slide[sid]])
            embs.append(arr["embeddings"])
            coords.append(arr["coords"])
            idx.append(np.full(arr["embeddings"].shape[0], j, dtype=np.int64))
            extents.append([int(v) for v in arr["extent"]])
        b.embeddings = np.concatenate(embs) if embs else None
        b.coords = np.concatenate(coords) if coords else None
        b.slide_index = np.concatenate(idx) if idx else None
        b.extents = extents


def extract_for_items(items: list[dict], *, encoder_id: str, params: dict, seed: int, positive_class: str,
                      ctx, job_id: str | None, base: float, span: float) -> tuple[dict[str, str], dict]:
    slides = OrderedDict()
    for it in sorted(items, key=lambda r: r["slide_id"]):
        slides[it["slide_id"]] = 1 if it["label_value"] == positive_class else 0
    out, hits, secs = {}, 0, 0.0
    n = max(len(slides), 1)
    for i, (sid, fixture_label) in enumerate(slides.items()):
        res = extract_slide_features(sid, encoder_id=encoder_id, params=params, seed=seed,
                                     fixture_label=fixture_label, ctx=ctx, job_id=job_id,
                                     progress_base=base + span * i / n, progress_span=span / n)
        out[sid] = res.artifact_id
        hits += res.cache_hit
        secs += res.seconds
        if ctx is not None:
            ctx.progress(base + span * (i + 1) / n,
                         f"features {i + 1}/{len(slides)} slides ({hits} from cache)")
    return out, {"slides": len(slides), "cache_hits": hits, "computed": len(slides) - hits,
                 "seconds": round(secs, 3)}


def attention_rows(bag: Bag, att: np.ndarray | None) -> list | None:
    if att is None:
        return None
    rows = []
    for k in range(bag.n_patches):
        j = int(bag.slide_index[k])
        w, h = bag.extents[j]
        rows.append([j, int(bag.coords[k, 0]), int(bag.coords[k, 1]), w, h, round(float(att[k]), 8)])
    return rows


def prediction_rows(run: TrainingRun, split: str, bags: list[Bag], model: LoadedModel, threshold: float,
                    qc: dict[str, dict]) -> list[Prediction]:
    out = []
    for b in bags:
        score, att = model.score(b.embeddings)
        out.append(Prediction(
            run_id=run.id, project_id=run.project_id, split=split, bag_kind=b.kind, bag_id=b.bag_id,
            slide_ids_json=b.slide_ids, case_id=b.case_id, coded_patient_id=b.patient_id,
            patient_code=b.patient_code, label_value=b.label_value, label_version_ids_json=b.label_version_ids,
            label=b.label, score=score, threshold=threshold, predicted=int(score >= threshold), abstained=False,
            attributes_json={**b.attributes, "n_patches": b.n_patches, "qc_context": qc.get(b.bag_id)},
            attention_json=attention_rows(b, att), feature_artifact_ids_json=b.artifact_ids))
    return out


def split_counts(manifest: dict, label_scope: str) -> dict:
    out = {}
    for sp in ("train", "val", "test"):
        rows = [r for r in manifest["items"] if r.get("split") == sp]
        out[sp] = {"patients": len({r["coded_patient_id"] for r in rows}), "items": len(rows),
                   "bags": len({r["slide_id"] if label_scope == "slide" else r["case_id"] for r in rows})}
    return out


def _fail(run_id: str, status: str, message: str) -> None:
    with session_scope() as db:
        run = db.get(TrainingRun, run_id)
        if run is not None and run.status != "succeeded":
            run.status = status
            run.error = message[:4000]
            run.finished_at = utcnow()


def run_training(run_id: str, ctx=None) -> dict:
    try:
        return _run_training(run_id, ctx)
    except TestSetLockViolation as exc:
        _fail(run_id, "failed", f"test-set lock violation: {exc}")
        raise PermanentJobError(f"test-set lock violation: {exc}") from exc
    except PermanentJobError as exc:
        _fail(run_id, "failed", str(exc))
        raise
    except Exception as exc:
        from ..jobs.registry import JobCanceled

        if isinstance(exc, JobCanceled):
            _fail(run_id, "canceled", "canceled on request")
        raise


def _run_training(run_id: str, ctx) -> dict:
    t_start = time.perf_counter()
    with session_scope() as db:
        run = db.get(TrainingRun, run_id)
        if run is None:
            raise PermanentJobError(f"training run {run_id} does not exist")
        if run.status == "succeeded":
            return {"run_id": run.id, "status": "succeeded", "checkpoint_sha256": run.checkpoint_sha256,
                    "idempotent_replay": True}
        dv = db.get(DatasetVersion, run.dataset_version_id)
        if dv is None or dv.status != "frozen" or not dv.manifest_json:
            raise PermanentJobError("the dataset version is not frozen")
        if dv.manifest_sha256 != run.dataset_manifest_sha256:
            raise PermanentJobError("dataset manifest sha256 differs from the one recorded at experiment creation")
        run.status = "running"
        run.error = None
        run.started_at = run.started_at or utcnow()
        run.code_revision = code_revision()
        run.deps_json = dependency_versions()
        manifest = dv.manifest_json
        train_items = training_eligible_items(db, dv, "train")
        val_items = training_eligible_items(db, dv, "validation")
        lv_ids = sorted({r["label_version_id"] for r in train_items + val_items})
        sources = dict(db.execute(select(LabelVersion.id, LabelVersion.source).where(LabelVersion.id.in_(lv_ids))).all())
        bad = [i for i in lv_ids if sources.get(i) != "expert"]
        if bad:
            raise PermanentJobError(f"{len(bad)} training/validation label(s) are not expert labels; model "
                                    "suggestions never become training truth")
        params, seed, head = dict(run.params_json), int(run.seed), run.head
        encoder_id, positive, label_scope = run.encoder_id, run.positive_class, run.label_scope
        project_id = run.project_id
        manifest_sha = run.dataset_manifest_sha256
        synthetic = run.synthetic
    job_id = getattr(ctx, "job_id", None)
    encoder = get_encoder(encoder_id)
    try:
        if encoder is None:
            raise EncoderUnavailable(encoder_id, "unknown", "no such encoder")
        encoder.require_available()
    except EncoderUnavailable as exc:
        raise PermanentJobError(f"encoder_unavailable: {exc}") from exc

    train_bags = build_bags(train_items, label_scope, positive)
    val_bags = build_bags(val_items, label_scope, positive)
    assert_no_test(train_bags, manifest, "training")
    assert_no_test(val_bags, manifest, "threshold selection")
    if ctx is not None:
        ctx.progress(0.02, f"{len(train_bags)} train bags, {len(val_bags)} validation bags")

    t0 = time.perf_counter()
    try:
        artifacts, feat_summary = extract_for_items(train_items + val_items, encoder_id=encoder_id, params=params,
                                                    seed=seed, positive_class=positive, ctx=ctx, job_id=job_id,
                                                    base=0.02, span=0.48)
    except (FeatureError, ValueError) as exc:
        raise PermanentJobError(f"feature extraction failed: {exc}") from exc
    extraction_seconds = time.perf_counter() - t0
    attach_features(train_bags, artifacts)
    attach_features(val_bags, artifacts)
    unscored = [{"bag_id": b.bag_id, "split": sp, "reason": "no tissue patches after QC exclusions"}
                for sp, bags in (("train", train_bags), ("val", val_bags)) for b in bags if b.n_patches == 0]
    train_bags = [b for b in train_bags if b.n_patches > 0]
    val_bags = [b for b in val_bags if b.n_patches > 0]
    classes = {b.label for b in train_bags}
    if classes != {0, 1}:
        raise PermanentJobError(f"the train split has {len(train_bags)} scorable bag(s) with class(es) "
                                f"{sorted(classes)}; a binary head needs both classes")

    t1 = time.perf_counter()
    fit = HEAD_FITTERS[head]
    arrays, head_meta, train_summary = fit(train_bags, val_bags, params, seed, _Progress(ctx, 0.5, 0.35))
    training_seconds = time.perf_counter() - t1

    # Threshold: validation scores only; frozen before anything touches test.
    provisional = LoadedModel(arrays, {**head_meta})
    val_scores = np.array([provisional.score(b.embeddings)[0] for b in val_bags], dtype=np.float64)
    val_y = np.array([b.label for b in val_bags], dtype=np.int64)
    thr = select_threshold(val_y, val_scores, rule=params["threshold_rule"],
                           target_sensitivity=params["target_sensitivity"])
    frozen_at = utcnow()
    thr.update({"selected_on": "val", "frozen_at": frozen_at.isoformat(),
                "val_bag_ids": [b.bag_id for b in val_bags]})
    if ctx is not None:
        ctx.progress(0.88, f"threshold {thr['value']:.4f} frozen ({thr['rule']}, on validation)")

    weights_marker, _ = encoder.cache_identity(encoder.config_from_params(params) if encoder.synthetic else {})
    # No run id or timestamps in the checkpoint: identical inputs and seed give identical bytes.
    meta = {**head_meta, "params": params, "seed": seed, "encoder_id": encoder_id, "weights_sha256": weights_marker,
            "positive_class": positive, "label_scope": label_scope, "dataset_manifest_sha256": manifest_sha,
            "threshold": {"value": thr["value"], "rule": thr["rule"], "selected_on": "val"},
            "synthetic": synthetic, "research_use_only": True}
    data = checkpoint_bytes(arrays, meta)
    ck_key = f"projects/{project_id}/runs/{run_id}/checkpoint.npz"
    get_store().put_bytes(ck_key, data)
    ck_sha = sha256_hex(data)
    model = load_checkpoint(get_store().get_bytes(ck_key))  # reload: scores below come from the stored file
    check = np.array([model.score(b.embeddings)[0] for b in val_bags], dtype=np.float64)
    if not np.array_equal(check, val_scores):
        raise RuntimeError("checkpoint round trip changed validation scores")
    if ctx is not None:
        ctx.progress(0.92, "checkpoint written and verified; scoring train/validation bags")

    with session_scope() as db:
        qc = {b.bag_id: qc_context(db, b.slide_ids) for b in train_bags + val_bags}
    from .evaluation import build_evaluation, store_evaluation  # local: evaluation imports this module

    with session_scope() as db:
        run = db.get(TrainingRun, run_id)
        if run.status == "succeeded":  # another attempt finished first
            return {"run_id": run_id, "status": "succeeded", "idempotent_replay": True}
        preds = (prediction_rows(run, "train", train_bags, model, thr["value"], qc)
                 + prediction_rows(run, "val", val_bags, model, thr["value"], qc))
        for p in preds:
            db.add(p)
        db.flush()
        run.threshold_value = float(thr["value"])
        run.threshold_rule = thr["rule"]
        run.threshold_frozen_at = frozen_at
        run.threshold_json = thr
        run.checkpoint_key, run.checkpoint_sha256, run.checkpoint_bytes = ck_key, ck_sha, len(data)
        run.weights_sha256 = weights_marker
        run.split_counts_json = split_counts(manifest, label_scope)
        val_rows = [p for p in preds if p.split == "val"]
        ev_body = build_evaluation(run, "val", val_rows)
        store_evaluation(db, run, "val", ev_body, computed_by=audit.SYSTEM_WORKER)
        run.metrics_json = {
            "training": train_summary,
            "features": {**feat_summary, "encoder_id": encoder_id, "notice": encoder.notice if encoder.synthetic
                         else None},
            "timings_seconds": {"feature_extraction": round(extraction_seconds, 3),
                                "training": round(training_seconds, 3),
                                "total": round(time.perf_counter() - t_start, 3)},
            "unscored_bags": unscored,
            "val_summary": {k: ev_body["metrics"][k]["value"] for k in ("sensitivity", "specificity", "auroc")},
            "in_sample_note": "train-split predictions are in-sample and are never reported as performance",
        }
        run.provenance_json = {"train_bag_ids": [b.bag_id for b in train_bags],
                               "val_bag_ids": [b.bag_id for b in val_bags],
                               "feature_artifact_ids": sorted(set(artifacts.values())),
                               "test_items_used": 0}
        run.status = "succeeded"
        run.finished_at = utcnow()
        audit.record(db, action="experiment.succeeded", entity_type="training_run", entity_id=run_id,
                     actor_id=audit.SYSTEM_WORKER, actor_role="system", project_id=project_id,
                     after={"head": head, "encoder_id": encoder_id, "checkpoint_sha256": ck_sha,
                            "threshold": thr["value"], "threshold_rule": thr["rule"], "synthetic": synthetic})
    return {"run_id": run_id, "status": "succeeded", "checkpoint_sha256": ck_sha, "threshold": thr["value"],
            "train_bags": len(train_bags), "val_bags": len(val_bags)}


def score_split_bags(run: TrainingRun, items: list[dict], *, ctx=None) -> tuple[list[Bag], LoadedModel, list[dict]]:
    """Extract (or reuse) features for ``items`` and return scorable bags with the run's checkpoint."""
    data = get_store().get_bytes(run.checkpoint_key)
    if sha256_hex(data) != run.checkpoint_sha256:
        raise PermanentJobError("checkpoint sha256 mismatch: refusing to score with a modified checkpoint")
    model = load_checkpoint(data)
    bags = build_bags(items, run.label_scope, run.positive_class)
    artifacts, _ = extract_for_items(items, encoder_id=run.encoder_id, params=run.params_json, seed=run.seed,
                                     positive_class=run.positive_class, ctx=ctx, job_id=None, base=0.0, span=1.0)
    attach_features(bags, artifacts)
    unscored = [{"bag_id": b.bag_id, "reason": "no tissue patches after QC exclusions"} for b in bags
                if b.n_patches == 0]
    return [b for b in bags if b.n_patches > 0], model, unscored

