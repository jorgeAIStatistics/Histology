"""Active-learning PROPOSALS from the TRAIN pool only. Never labels, never truth.

Selection (k items): ``round(k × random_fraction)`` random picks (seeded, against tunnel
vision); of the rest, half by uncertainty (smallest margin to the frozen threshold) and half
by diversity (greedy k-center on standardised mean-pooled bag embeddings, starting from what
is already selected). The pool is ``training_eligible_items(purpose="active_learning")``,
which never contains validation or test items; it is re-checked here against the manifest.
"""

from __future__ import annotations

import math

import numpy as np
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..datasets import TestSetLockViolation, training_eligible_items
from ..models import DatasetVersion
from . import PIPELINE_TEST_BANNER
from .features import load_features
from .models import FeatureArtifact, Prediction, TrainingRun

NOTICE = ("Proposals for expert review only. Nothing is labelled, relabelled or inferred: model scores are never "
          "expert truth, and the pool is the TRAIN split only (validation and test are never proposed).")


def _mean_embeddings(db: Session, preds: list[Prediction]) -> np.ndarray:
    ids = sorted({a for p in preds for a in p.feature_artifact_ids_json})
    arts = {a.id: a for a in db.scalars(select(FeatureArtifact).where(FeatureArtifact.id.in_(ids))).all()}
    vecs = []
    for p in preds:
        embs = [load_features(arts[a])["embeddings"] for a in p.feature_artifact_ids_json]
        vecs.append(np.concatenate(embs).astype(np.float64).mean(axis=0))
    X = np.stack(vecs)
    sd = X.std(axis=0)
    return (X - X.mean(axis=0)) / np.where(sd > 1e-9, sd, 1.0)


def propose(db: Session, run: TrainingRun, dv: DatasetVersion, *, k: int, random_fraction: float,
            seed: int | None = None) -> dict:
    pool_items = training_eligible_items(db, dv, "active_learning")
    manifest = dv.manifest_json
    locked = {it["slide_id"] for it in manifest["items"] if it.get("split") in ("val", "test")}
    pool_slides = {it["slide_id"] for it in pool_items}
    if pool_slides & locked:
        raise TestSetLockViolation("validation/test items reached the active-learning pool")
    preds = db.scalars(select(Prediction).where(Prediction.run_id == run.id, Prediction.split == "train")
                       .order_by(Prediction.bag_id)).all()
    preds = [p for p in preds if set(p.slide_ids_json) <= pool_slides]
    for p in preds:
        if set(p.slide_ids_json) & locked:  # defence in depth
            raise TestSetLockViolation("a locked item was about to be proposed")
    k = min(k, len(preds))
    n_random = int(round(k * random_fraction))
    n_rest = k - n_random
    n_unc = int(math.ceil(n_rest / 2))
    n_div = n_rest - n_unc
    thr = float(run.threshold_value)
    chosen: list[tuple[int, str, float | None, dict]] = []
    taken: set[int] = set()
    margins = np.array([abs(p.score - thr) for p in preds])
    for i in np.argsort(margins, kind="mergesort")[:n_unc].tolist():
        chosen.append((i, "uncertainty", float(preds[i].score), {"margin_to_threshold": float(margins[i])}))
        taken.add(i)
    if n_div and len(preds) > len(taken):
        X = _mean_embeddings(db, preds)
        if taken:  # k-center: distance to the nearest already-selected bag
            dist = np.min(np.stack([np.linalg.norm(X - X[c], axis=1) for c in sorted(taken)]), axis=0)
        else:  # no centre yet: start from the bag farthest from the pool mean
            dist = np.linalg.norm(X, axis=1)
        for _ in range(n_div):
            masked = dist.copy()
            masked[sorted(taken)] = -np.inf
            i = int(np.argmax(masked))
            if not np.isfinite(masked[i]):
                break
            chosen.append((i, "diversity", float(preds[i].score), {"distance_to_selected": float(masked[i])}))
            taken.add(i)
            dist = np.minimum(dist, np.linalg.norm(X - X[i], axis=1))
    rng = np.random.default_rng(run.seed if seed is None else seed)
    remaining = [i for i in range(len(preds)) if i not in taken]
    for i in rng.permutation(remaining)[: k - len(chosen)].tolist() if remaining else []:
        chosen.append((int(i), "random", None, {}))
        taken.add(int(i))
    items = []
    for i, reason, score, extra in chosen:
        p = preds[i]
        items.append({"slide_id": p.slide_ids_json[0], "slide_ids": p.slide_ids_json, "case_id": p.case_id,
                      "bag_kind": p.bag_kind, "patient_code": p.patient_code, "reason": reason, "score": score,
                      "split": "train", **extra})
    return {"run_id": run.id, "dataset_version_id": dv.id, "items": items, "pool": "train_only",
            "pool_size": len(preds), "requested": {"k": k, "random_fraction": random_fraction},
            "composition": {"uncertainty": sum(1 for c in chosen if c[1] == "uncertainty"),
                            "diversity": sum(1 for c in chosen if c[1] == "diversity"),
                            "random": sum(1 for c in chosen if c[1] == "random")},
            "creates_labels": False, "notice": NOTICE, "synthetic": run.synthetic,
            "banner": PIPELINE_TEST_BANNER if run.synthetic else None}
