"""Active-learning PROPOSALS for expert review (design §9). Never labels, never truth.

Pool (:func:`development_pool`): development-eligible slides of the run's project only:

* QC-eligible (ingested, not a field image, not excluded by review or by a resolved
  ``exclude_slide`` QC issue) and of the run's data mode (synthetic or real);
* the slide's patient is NOT sealed (any test release, this lineage or an ancestor's) and has no
  ``test`` or ``val`` assignment in the split family or in the run's frozen manifest;
* the slide (or its case, for case-level tasks) has NO reference label, or an OPEN reader
  disagreement;
* never proposed before in this project (earlier ``al_proposal`` rows).

Scoring: every candidate is scored out-of-sample through the run's registered inference bundle
(:func:`dermpath.ml.inference.score_slide`, label-free; the result is an ``inference_prediction``
row). A candidate's slide was never in training; when its PATIENT is a training patient this is
recorded (``patient_in_training_set``). Pipeline-test bundles cannot score new slides (their signal
is label-derived), so their batches are random only, and say so.

Selection (:func:`select_batch`): ``round(k × random_fraction)`` random picks against tunnel
vision; of the rest, ``uncertainty_fraction`` (default half) by uncertainty (smallest relative
margin to the frozen threshold) and the remainder by diversity (greedy k-centre on standardised
mean embeddings, starting from what is already selected). At most ONE slide per patient per batch,
whatever the strategy. Shortfalls (too few scored candidates) are filled at random and reported.
Proposals are persisted as ``al_proposal`` rows (append-only) and never create labels.
"""

from __future__ import annotations

import hashlib
import math

import numpy as np
from sqlalchemy import select

from .. import audit
from ..datasets import family_assignments, item_data_mode, lineage_family, sealed_constraints
from ..db import session_scope
from ..errors import conflict
from ..hierarchy import slide_lineage
from ..jobs import queue
from ..jobs.registry import PermanentJobError, register
from ..labels import open_disagreement, reference_label
from ..models import DatasetVersion, Job, QCIssue, Slide, new_id
from . import PIPELINE_TEST_BANNER
from .engine_models import ALProposal, InferenceBundle
from .metrics import relative_margin
from .models import TrainingRun

AL_JOB = "active_learning"
SELECTION_VERSION = "dermpath.al/1"
NOTICE = ("Proposals for expert review only. Nothing is labelled, relabelled or inferred: model scores are never "
          "expert truth. The pool holds development-eligible slides without a reference label (or with an open "
          "reader disagreement); validation, test and sealed patients are never proposed.")
EXCLUSION_ORDER = ("not_ingested", "field_image", "review_excluded", "qc_excluded", "other_data_mode", "no_hierarchy",
                   "sealed_test_patient", "test_patient", "validation_patient", "has_reference_label",
                   "previously_proposed")


def _data_mode(manifest: dict) -> str:
    mode = manifest.get("data_mode")
    if isinstance(mode, dict):  # tolerate the datasets.data_mode() summary shape
        mode = mode.get("mode")
    return mode or ("synthetic" if manifest.get("synthetic_only") else "real")


def development_pool(db, run: TrainingRun, dv: DatasetVersion) -> tuple[list[dict], dict[str, int]]:
    """``(candidates, exclusion counts)``; candidates are sorted by slide id. Reads labels only to EXCLUDE
    labelled slides (and to find open disagreements); no label is ever attached to a candidate."""
    manifest = dv.manifest_json or {}
    mode = _data_mode(manifest)
    assign = family_assignments(db, lineage_family(db, dv.lineage_id))
    sealed = sealed_constraints(db, dv)
    man_split = {s["coded_patient_id"]: s["split"] for s in manifest.get("splits", [])}
    for it in manifest.get("items", []):
        man_split.setdefault(it.get("coded_patient_id"), it.get("split"))
    proposed = set(db.scalars(select(ALProposal.slide_id).where(ALProposal.project_id == run.project_id)).all())
    excluded_qc = set(db.scalars(select(QCIssue.slide_id).where(QCIssue.project_id == run.project_id,
                                                                QCIssue.status == "resolved",
                                                                QCIssue.dataset_eligibility_effect == "exclude_slide"))
                      .all())
    scope = run.label_scope or "slide"
    counts = {k: 0 for k in EXCLUSION_ORDER}
    out = []
    for s in db.scalars(select(Slide).where(Slide.project_id == run.project_id).order_by(Slide.id)).all():
        reason = None
        if s.ingest_status != "succeeded":
            reason = "not_ingested"
        elif s.image_kind == "field_image":
            reason = "field_image"
        elif s.review_state == "excluded":
            reason = "review_excluded"
        elif s.id in excluded_qc:
            reason = "qc_excluded"
        elif item_data_mode(s.provenance, s.image_kind) != mode:
            reason = "other_data_mode"
        lineage = slide_lineage(db, s) if reason is None else {}
        pid = lineage.get("coded_patient_id")
        fam = assign.get(pid) if pid else None
        split = man_split.get(pid) or (fam.split if fam is not None else None)
        if reason is None:
            if pid is None:
                reason = "no_hierarchy"
            elif pid in sealed:
                reason = "sealed_test_patient"
            elif split == "test" or (fam is not None and fam.split == "test"):
                reason = "test_patient"
            elif split == "val" or (fam is not None and fam.split == "val"):
                reason = "validation_patient"
        pool_reason = None
        if reason is None:
            target = s.id if scope == "slide" else lineage["case_id"]
            if open_disagreement(db, run.project_id, scope, target) is not None:
                pool_reason = "open_reader_disagreement"
            else:
                _ref, status = reference_label(db, run.project_id, scope, target)
                if status == "unlabeled":
                    pool_reason = "no_reference_label"
                else:
                    reason = "has_reference_label"
        if reason is None and s.id in proposed:
            reason = "previously_proposed"
        if reason is not None:
            counts[reason] += 1
            continue
        out.append({"slide_id": s.id, "coded_patient_id": pid, "patient_code": lineage.get("patient_code"),
                    "case_id": lineage.get("case_id"), "pool_reason": pool_reason,
                    "family_split": fam.split if fam is not None else "new_to_family",
                    "patient_in_training_set": split == "train"})
    return out, counts


# =========================================================================== selection


def _rank(seed: int, key: str) -> str:
    return hashlib.sha256(f"{SELECTION_VERSION}|{int(seed)}|{key}".encode()).hexdigest()


def select_batch(candidates: list[dict], *, k: int, random_fraction: float, uncertainty_fraction: float = 0.5,
                 seed: int = 0) -> tuple[list[dict], dict]:
    """Choose up to ``k`` candidates (see the module docstring). Candidates may carry ``margin`` (relative
    margin to the threshold; None when unscored) and ``embedding`` (mean embedding; None when unscored).
    Returns ``(picks, info)``; each pick is the candidate plus ``strategy``, ``rank`` and ``components``."""
    if not 0.0 <= random_fraction <= 1.0 or not 0.0 <= uncertainty_fraction <= 1.0:
        raise ValueError("fractions must lie in [0, 1]")
    cands = sorted(candidates, key=lambda c: c["slide_id"])
    n_patients = len({c["coded_patient_id"] for c in cands})
    k_eff = max(0, min(int(k), n_patients))
    n_random = int(round(k_eff * random_fraction))
    n_rest = k_eff - n_random
    n_unc = int(math.ceil(n_rest * uncertainty_fraction))
    n_div = n_rest - n_unc
    picks: list[dict] = []
    used_patients: set = set()
    taken: set[str] = set()

    def available(c: dict) -> bool:
        return c["slide_id"] not in taken and c["coded_patient_id"] not in used_patients

    def take(c: dict, strategy: str, components: dict) -> None:
        picks.append({**{k_: v for k_, v in c.items() if k_ != "embedding"}, "strategy": strategy,
                      "rank": len(picks) + 1, "components": components})
        taken.add(c["slide_id"])
        used_patients.add(c["coded_patient_id"])

    scored = [c for c in cands if c.get("margin") is not None]
    got_unc = 0
    for c in sorted(scored, key=lambda c: (c["margin"], _rank(seed, c["slide_id"]))):
        if got_unc >= n_unc:
            break
        if available(c):
            take(c, "uncertainty", {"relative_margin": c["margin"], "uncertainty": 1.0 - c["margin"]})
            got_unc += 1

    got_div = 0
    emb = [c for c in cands if c.get("embedding") is not None]
    if n_div and emb:
        X = np.stack([np.asarray(c["embedding"], dtype=np.float64) for c in emb])
        sd = X.std(axis=0)
        X = (X - X.mean(axis=0)) / np.where(sd > 1e-12, sd, 1.0)
        ranks = np.array([_rank(seed, c["slide_id"]) for c in emb])
        centres = [i for i, c in enumerate(emb) if c["slide_id"] in taken]
        if centres:
            dist = np.min(np.stack([np.linalg.norm(X - X[i], axis=1) for i in centres]), axis=0)
            start = "distance to the batch already selected"
        else:  # no centre yet: start from the candidate farthest from the pool mean
            dist = np.linalg.norm(X, axis=1)
            start = "distance to the pool mean (first pick)"
        while got_div < n_div:
            ok = np.array([available(c) for c in emb])
            if not ok.any():
                break
            d = np.where(ok, np.round(dist, 12), -np.inf)
            best = max(np.flatnonzero(d == d.max()), key=lambda i: ranks[i])  # seeded tie-break
            c = emb[int(best)]
            take(c, "diversity", {"distance_to_selected": float(dist[best]), "measured_as": start,
                                  "space": "standardised mean embedding (k-centre)"})
            start = "distance to the batch already selected"
            got_div += 1
            dist = np.minimum(dist, np.linalg.norm(X - X[best], axis=1))

    shortfall = {"uncertainty": n_unc - got_unc, "diversity": n_div - got_div}
    for c in sorted(cands, key=lambda c: _rank(seed, c["slide_id"])):
        if len(picks) >= k_eff:
            break
        if available(c):
            take(c, "random", {"seeded_rank": _rank(seed, c["slide_id"])[:16]})
    composition = {s: sum(1 for p in picks if p["strategy"] == s) for s in ("uncertainty", "diversity", "random")}
    info = {"requested": {"k": int(k), "random_fraction": random_fraction, "uncertainty_fraction": uncertainty_fraction,
                          "seed": int(seed)},
            "planned": {"uncertainty": n_unc, "diversity": n_div, "random": n_random},
            "composition": composition, "shortfall_filled_at_random": shortfall,
            "limit": {"distinct_patients": n_patients, "k_effective": k_eff,
                      "rule": "at most one slide per patient per batch"},
            "selection_version": SELECTION_VERSION}
    return picks, info


# =========================================================================== batches


def request_batch(db, actor, run: TrainingRun, dv: DatasetVersion, *, k: int, random_fraction: float,
                  uncertainty_fraction: float = 0.5, seed: int | None = None) -> dict:
    """Validate, compute the pool and enqueue the ``active_learning`` job (the caller commits)."""
    if run.status != "succeeded":
        raise conflict("run_not_succeeded", "Active learning needs a finished run", status=run.status)
    bundle = db.scalars(select(InferenceBundle).where(InferenceBundle.run_id == run.id)).first()
    if bundle is None:
        raise conflict("bundle_required", "Register the run first: proposals are scored out-of-sample through its "
                       "inference bundle (POST /experiments/{id}/register)", run_id=run.id)
    cands, counts = development_pool(db, run, dv)
    batch_id = new_id()
    seed = int(run.seed if seed is None else seed)
    payload = {"batch_id": batch_id, "run_id": run.id, "bundle_id": bundle.id, "dataset_version_id": dv.id, "k": k,
               "random_fraction": random_fraction, "uncertainty_fraction": uncertainty_fraction, "seed": seed,
               "pool_slide_ids": [c["slide_id"] for c in cands]}
    job, _ = queue.enqueue(db, AL_JOB, payload, idempotency_key=f"al:{batch_id}", project_id=run.project_id,
                           created_by=actor.id)
    audit.record_for(db, actor, project_id=run.project_id, action="active_learning.requested",
                     entity_type="training_run", entity_id=run.id,
                     after={"batch_id": batch_id, "job_id": job.id, "k": k, "random_fraction": random_fraction,
                            "uncertainty_fraction": uncertainty_fraction, "seed": seed, "pool_size": len(cands),
                            "pool_exclusions": counts})
    return {"batch_id": batch_id, "job_id": job.id, "status": job.status, "run_id": run.id, "bundle_id": bundle.id,
            "dataset_version_id": dv.id, "pool_size": len(cands), "pool_exclusions": counts,
            "pool": "development_eligible", "creates_labels": False, "notice": NOTICE, "synthetic": run.synthetic,
            "banner": PIPELINE_TEST_BANNER if run.synthetic else None}


def run_batch(payload: dict, ctx=None) -> dict:
    from . import inference

    batch_id = payload["batch_id"]
    with session_scope() as db:
        if db.scalars(select(ALProposal.id).where(ALProposal.batch_id == batch_id)).first() is not None:
            return {"batch_id": batch_id, "status": "stored", "idempotent_replay": True}
        run = db.get(TrainingRun, payload["run_id"])
        dv = db.get(DatasetVersion, payload["dataset_version_id"])
        bundle = db.get(InferenceBundle, payload["bundle_id"])
        if run is None or dv is None or bundle is None or bundle.run_id != run.id:
            raise PermanentJobError("run, dataset version or bundle of the batch does not exist")
        # Re-check eligibility now: a patient sealed or moved to test/val since the request is never proposed.
        current, _ = development_pool(db, run, dv)
        allowed = set(payload.get("pool_slide_ids") or [])
        cands = [c for c in current if c["slide_id"] in allowed]
        refusal = inference.inference_refusal(bundle.content_json or {})
        threshold = float((bundle.content_json.get("threshold") or {}).get("value"))
        job = db.scalars(select(Job).where(Job.idempotency_key == f"al:{batch_id}")).first()
        created_by = job.created_by if job is not None else None
    unscorable = {}
    for i, c in enumerate(cands):
        if refusal is not None:
            unscorable[c["slide_id"]] = refusal[1]
            continue
        pred, mean = inference.score_slide(payload["bundle_id"], c["slide_id"], ctx, created_by=created_by)
        c["inference_prediction_id"] = pred["id"]
        if pred["score"] is None:
            unscorable[c["slide_id"]] = pred["unscorable_reason"]
            continue
        c["score"] = pred["score"]
        c["abstained"] = pred["abstained"]
        c["margin"] = float(relative_margin([pred["score"]], threshold)[0])
        c["embedding"] = mean
        if ctx is not None:
            ctx.progress(0.8 * (i + 1) / max(len(cands), 1), f"scored {i + 1}/{len(cands)} candidates")
    picks, info = select_batch(cands, k=int(payload["k"]), random_fraction=float(payload["random_fraction"]),
                               uncertainty_fraction=float(payload.get("uncertainty_fraction", 0.5)),
                               seed=int(payload["seed"]))
    with session_scope() as db:
        if db.scalars(select(ALProposal.id).where(ALProposal.batch_id == batch_id)).first() is not None:
            return {"batch_id": batch_id, "status": "stored", "idempotent_replay": True}
        for p in picks:
            comps = {**p["components"], "pool_reason": p["pool_reason"], "family_split": p["family_split"],
                     "patient_in_training_set": p["patient_in_training_set"],
                     "model_score": p.get("score"), "abstained": p.get("abstained"),
                     "inference_prediction_id": p.get("inference_prediction_id"),
                     "unscorable_reason": unscorable.get(p["slide_id"])}
            unc = (1.0 - p["margin"]) if p.get("margin") is not None else None
            db.add(ALProposal(project_id=run.project_id, batch_id=batch_id, run_id=run.id, bundle_id=payload["bundle_id"],
                              dataset_version_id=payload["dataset_version_id"], slide_id=p["slide_id"],
                              coded_patient_id=p["coded_patient_id"], proposal_rank=p["rank"], strategy=p["strategy"],
                              score=unc, components_json=comps, seed=int(payload["seed"]),
                              created_by=created_by or audit.SYSTEM_WORKER))
        db.flush()
        audit.record(db, action="active_learning.proposed", entity_type="training_run", entity_id=run.id,
                     actor_id=audit.SYSTEM_WORKER, actor_role="system", project_id=run.project_id,
                     after={"batch_id": batch_id, "proposed": len(picks), "composition": info["composition"],
                            "pool_size": len(cands), "unscorable": len(unscorable), "creates_labels": False})
        if ctx is not None:
            ctx.assert_lease(db)
    return {"batch_id": batch_id, "status": "stored", "proposed": len(picks), "pool_size": len(cands),
            "unscorable": len(unscorable), "unscorable_reason": refusal[1] if refusal else None, **info}


@register(AL_JOB, description="Active-learning proposals scored out-of-sample through a bundle (never labels)")
def active_learning_job(ctx, payload: dict) -> dict:
    if any(k in payload for k in ("label", "labels", "fixture_label", "label_value")):
        raise PermanentJobError("job payloads never carry labels")
    if not payload.get("batch_id"):
        raise PermanentJobError("payload.batch_id is required")
    return run_batch(payload, ctx)


def batch_dict(db, job: Job) -> dict:
    payload = job.payload_json or {}
    batch_id = payload.get("batch_id")
    rows = db.scalars(select(ALProposal).where(ALProposal.batch_id == batch_id)
                      .order_by(ALProposal.proposal_rank)).all()
    run = db.get(TrainingRun, payload.get("run_id")) if payload.get("run_id") else None
    items = []
    for r in rows:
        c = r.components_json or {}
        items.append({"slide_id": r.slide_id, "coded_patient_id": r.coded_patient_id, "rank": r.proposal_rank,
                      "reason": r.strategy, "strategy": r.strategy, "uncertainty": r.score,
                      "score": c.get("model_score"), "components": c, "split": c.get("family_split"),
                      "creates_label": False})
    result = job.result_json or {}
    return {"batch_id": batch_id, "job_id": job.id, "status": job.status, "error": job.error,
            "run_id": payload.get("run_id"), "bundle_id": payload.get("bundle_id"),
            "dataset_version_id": payload.get("dataset_version_id"),
            "requested": {k: payload.get(k) for k in ("k", "random_fraction", "uncertainty_fraction", "seed")},
            "pool_size": len(payload.get("pool_slide_ids") or []), "items": items,
            "composition": result.get("composition") or {s: sum(1 for i in items if i["strategy"] == s)
                                                         for s in ("uncertainty", "diversity", "random")},
            "result": result or None, "pool": "development_eligible", "creates_labels": False, "notice": NOTICE,
            "synthetic": bool(run.synthetic) if run else None,
            "banner": PIPELINE_TEST_BANNER if run is not None and run.synthetic else None}
