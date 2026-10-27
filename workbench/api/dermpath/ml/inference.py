"""Inference bundles and label-free inference on new slides (design §8). Research use only.

Bundle
------
:func:`build_bundle` runs at registration (``POST /experiments/{id}/register``) for a succeeded run
with a pinned feature set. ``content_json`` holds everything needed to reproduce the run's features
and decisions on a new slide:

* the encoder spec, its sha and the weights sha (from the feature set);
* the patch policy (with its sampling policy) and its sha; the stain policy with its reference sha;
* the extraction environment (device class, precision, library versions) and its sha;
* the head checkpoint, copied to a content-addressed write-once object (key and sha);
* the class mapping (``positive_class``, ``negative_class``, display text, and the statement that
  the negative class is not "benign");
* the frozen threshold, calibration and abstention policy, verbatim (they carry their own hashes);
* ``code_tree_sha256``, revision and dependency versions of the code that trained the run;
* ``dataset_manifest_sha256`` and the feature set's ``spec_sha256``;
* ``research_use_only: true``.

``bundle_sha256`` is :func:`dermpath.ml.engine_models.bundle_sha256_of` of that content (the ORM
refuses anything else); the canonical JSON is stored write-once and content-addressed, so the
object key ends in the bundle sha. The run's ``bundle_id`` is set once. Bundles are append-only.

Inference
---------
``POST /bundles/{id}/infer {slide_id}`` enqueues ``infer_slide``. The job verifies the bundle (content
sha and stored object), the encoder spec sha of the installed adapter, and the run's checkpoint,
threshold, calibration and abstention against the bundle; extracts features LABEL-FREE with the
bundle's policies through :func:`dermpath.ml.feature_sets.extract_slide` (the loaded weights must
equal the pinned sha); checks the returned artifact identity; scores with
:func:`dermpath.ml.training.score_bags_with_checkpoint`; and appends an ``inference_prediction``
row. It never reads or writes a label, and outputs are never routed to care. Pipeline-test bundles
(synthetic encoder) cannot score new slides: their signal is label-derived by construction.
"""

from __future__ import annotations

import json

import numpy as np
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from .. import audit
from ..datasets import IMPORTED_REFERENCE_NOTICE, item_data_mode, qc_snapshot
from ..db import session_scope
from ..errors import conflict, not_found
from ..jobs import queue
from ..jobs.registry import PermanentJobError, register
from ..models import Slide
from ..storage import get_store
from ..vocab import LABEL_DISPLAY
from . import PIPELINE_TEST_BANNER
from .artifacts import sha256_hex
from .calibration import identity_calibration
from .engine_models import FeatureSet, InferenceBundle, InferencePrediction, RunAttempt, bundle_sha256_of
from .evaluation import NEGATIVE_NOTE, threshold_dict
from .heads import CHECKPOINT_SCHEMA, Bag
from .metrics import no_abstention_policy
from .models import FeatureArtifact, TrainingRun

BUNDLE_SCHEMA = "dermpath.inference_bundle/1"
INFER_JOB = "infer_slide"
BUNDLE_NOTICE = ("Research inference bundle. Not a medical device and not for clinical use: its outputs are research "
                 "scores, never labels or diagnoses, and they are never routed to care.")
PREDICTION_NOTICE = ("Research output of a registered bundle. Not a label, not a diagnosis, never routed to care; "
                     "model confidence is not a validated out-of-distribution detector.")
SYNTHETIC_REFUSAL = ("Pipeline-test bundles cannot score new slides: the synthetic encoder's class signal is derived "
                     "from reference labels by construction, so it has nothing label-free to offer.")


# =========================================================================== bundles


def _canonical(content: dict) -> bytes:
    return json.dumps(content, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode()


def bundle_of_run(db, run: TrainingRun) -> InferenceBundle | None:
    return db.scalars(select(InferenceBundle).where(InferenceBundle.run_id == run.id)).first()


def _checkpoint_object(run: TrainingRun) -> tuple[str, str, int]:
    """Copy the run's checkpoint to a content-addressed, write-once object (verified against the run's sha)."""
    store = get_store()
    try:
        data = store.get_bytes(run.checkpoint_key)
    except (FileNotFoundError, OSError) as exc:
        raise conflict("checkpoint_missing", "The run's checkpoint object is missing", run_id=run.id) from exc
    if sha256_hex(data) != run.checkpoint_sha256:
        raise conflict("checkpoint_mismatch", "The stored checkpoint no longer matches the run's sha256",
                       run_id=run.id)
    key, sha = store.put_content_addressed(f"projects/{run.project_id}/checkpoints", data, ".npz")
    return key, sha, len(data)


def _code_identity(db, run: TrainingRun) -> dict:
    ident = run.identity_json or {}
    code = {"code_tree_sha256": ident.get("code_tree_sha256"), "code_revision": ident.get("code_revision"),
            "deps": ident.get("deps") or ident.get("dependency_versions"), "source": "run identity (frozen at creation)"}
    if not code["code_tree_sha256"] or not code["deps"]:
        att = db.scalars(select(RunAttempt).where(RunAttempt.run_id == run.id, RunAttempt.outcome == "succeeded")
                         .order_by(RunAttempt.attempt_number.desc())).first()
        if att is not None:
            code["code_tree_sha256"] = code["code_tree_sha256"] or att.code_tree_sha256
            code["code_revision"] = code["code_revision"] or att.code_revision
            code["deps"] = code["deps"] or att.deps_json
            code["source"] = "succeeded run attempt"
    code["code_revision"] = code["code_revision"] or run.code_revision
    code["deps"] = code["deps"] or run.deps_json or {}
    return code


def bundle_content(db, run: TrainingRun, fs: FeatureSet, head: tuple[str, str, int]) -> dict:
    pos, neg = run.positive_class, run.negative_class
    thr = threshold_dict(run)
    calibration = run.calibration_json if run.calibration_json is not None else {
        **identity_calibration(), "note": "no calibration was frozen with the run"}
    abstention = run.abstention_json if run.abstention_json is not None else no_abstention_policy(
        float(run.threshold_value), reason="no abstention policy was frozen with the run")
    env = fs.extraction_env_json or {}
    # The EFFECTIVE stain policy: for macenko-v1 the set stores a deferred plan (reference fitted at build on train
    # slides only); the bundle carries the policy with its fitted reference, so inference applies exactly the
    # normalisation the set's artifacts were produced with. The declared plan is kept for provenance.
    standard = (run.identity_json or {}).get("reference_standard") or "expert"
    declared = fs.stain_policy_json or {}
    if declared.get("deferred"):
        from .feature_sets import effective_stain_policy

        stain = effective_stain_policy(fs.id)
        stain_json, stain_sha = stain.to_json(), stain.policy_sha256
    else:  # none, or a policy that already carries its reference: the declared policy is the effective one
        stain_json, stain_sha = declared, fs.stain_policy_sha256
    return {
        "schema": BUNDLE_SCHEMA,
        "research_use_only": True,
        "notice": BUNDLE_NOTICE,
        "run_id": run.id,
        "project_id": run.project_id,
        "execution_mode": run.execution_mode or fs.execution_mode,
        "evaluation_protocol": run.evaluation_protocol or "holdout",
        "synthetic": bool(run.synthetic),
        "encoder": {"id": fs.encoder_id, "spec": fs.encoder_spec_json, "spec_sha256": fs.encoder_spec_sha256,
                    "weights_sha256": fs.weights_sha256,
                    "config_sha256": (fs.encoder_spec_json or {}).get("weights_config_sha256")},
        "patch_policy": {"policy": fs.patch_policy_json, "policy_sha256": fs.policy_sha256,
                         "includes": "sampling policy (strategy, max patches, sampling seed)"},
        "stain_policy": {"policy": stain_json, "policy_sha256": stain_sha,
                         "declared_policy": fs.stain_policy_json, "declared_policy_sha256": fs.stain_policy_sha256,
                         "reference_key": fs.stain_reference_key, "reference_sha256": fs.stain_reference_sha256},
        "extraction_env": {"env": env, "sha256": fs.extraction_env_sha256,
                           "device_class": env.get("device_class"), "precision": env.get("precision")},
        "head": {"name": run.head, "checkpoint_key": head[0], "checkpoint_sha256": head[1], "bytes": head[2],
                 "format": f"npz ({CHECKPOINT_SCHEMA})"},
        "classes": {"label_scope": run.label_scope, "positive_class": pos, "negative_class": neg,
                    "positive_display": LABEL_DISPLAY.get(pos, pos), "negative_display": LABEL_DISPLAY.get(neg, neg),
                    "negative_statement": NEGATIVE_NOTE.format(neg=neg, pos=pos),
                    "reference_standard": standard,
                    **({"reference_standard_notice": IMPORTED_REFERENCE_NOTICE}
                       if standard == "imported_reference" else {})},
        "threshold": thr,
        "calibration": calibration,
        "abstention": abstention,
        "code": _code_identity(db, run),
        "dataset_manifest_sha256": run.dataset_manifest_sha256,
        "feature_set": {"id": fs.id, "spec_sha256": fs.spec_sha256, "input_snapshot_sha256": fs.input_snapshot_sha256},
        "run_identity_sha256": run.identity_sha256,
    }


def build_bundle(db, actor, run: TrainingRun) -> tuple[InferenceBundle | None, bool, str | None]:
    """``(bundle, created, unavailable_reason)``. Idempotent per run (one bundle per run, set once)."""
    existing = bundle_of_run(db, run)
    if existing is not None:
        return existing, False, None
    if run.status != "succeeded" or not run.checkpoint_sha256 or run.threshold_value is None:
        raise conflict("run_not_succeeded", "Only a finished run with a checkpoint and a frozen threshold has a "
                       "bundle", status=run.status)
    if not run.feature_set_id:
        return None, False, ("legacy run without a pinned feature set: no inference bundle can reproduce its "
                             "features")
    fs = db.get(FeatureSet, run.feature_set_id)
    if fs is None or fs.status != "ready":
        raise conflict("feature_set_not_ready", "The run's feature set is not ready", feature_set_id=run.feature_set_id)
    if run.weights_sha256 and run.weights_sha256 != fs.weights_sha256:
        raise conflict("weights_mismatch", "The run's pinned weights differ from its feature set's",
                       run_weights_sha256=run.weights_sha256, feature_set_weights_sha256=fs.weights_sha256)
    content = bundle_content(db, run, fs, _checkpoint_object(run))
    sha = bundle_sha256_of(content)
    key, obj_sha = get_store().put_content_addressed(f"projects/{run.project_id}/bundles", _canonical(content), ".json")
    if obj_sha != sha:  # pragma: no cover - same canonical form
        raise RuntimeError("bundle object sha differs from bundle_sha256")
    b = InferenceBundle(project_id=run.project_id, run_id=run.id, bundle_sha256=sha, content_json=content,
                        object_key=key, created_by=actor.id)
    try:
        with db.begin_nested():
            db.add(b)
            db.flush()
    except IntegrityError:  # registered concurrently
        existing = bundle_of_run(db, run)
        if existing is None:
            raise
        return existing, False, None
    if run.bundle_id is None:
        run.bundle_id = b.id
    elif run.bundle_id != b.id:  # pragma: no cover - unique per run
        raise conflict("bundle_conflict", "The run already records another bundle", bundle_id=run.bundle_id)
    db.flush()
    audit.record_for(db, actor, project_id=run.project_id, action="inference_bundle.created",
                     entity_type="inference_bundle", entity_id=b.id,
                     after={"run_id": run.id, "bundle_sha256": sha, "object_key": key,
                            "weights_sha256": fs.weights_sha256, "research_use_only": True})
    return b, True, None


def verify_bundle(bundle: InferenceBundle, *, check_object: bool = True) -> list[str]:
    """Problems with the bundle's integrity (empty when intact)."""
    problems = []
    if bundle_sha256_of(bundle.content_json or {}) != bundle.bundle_sha256:
        problems.append("content_json does not hash to bundle_sha256")
    if (bundle.content_json or {}).get("research_use_only") is not True:
        problems.append("content does not state research_use_only")
    if check_object:
        try:
            if get_store().stored_sha256(bundle.object_key) != bundle.bundle_sha256:
                problems.append("stored bundle object does not hash to bundle_sha256")
        except (FileNotFoundError, OSError):
            problems.append("stored bundle object is missing")
    return problems


def inference_refusal(content: dict, slide: Slide | None = None) -> tuple[str, str] | None:
    """``(code, message)`` when this bundle may not score (this) slide, else None (label-free checks only)."""
    enc = content.get("encoder") or {}
    if content.get("execution_mode") == "synthetic_pipeline_test" or (enc.get("spec") or {}).get("synthetic"):
        return "mode_mismatch", SYNTHETIC_REFUSAL
    if slide is not None:
        if item_data_mode(slide.provenance, slide.image_kind) == "synthetic":
            return "mode_mismatch", ("Synthetic demo slides are refused for a real encoder outside the pipeline-test "
                                     "mode (design §1)")
        if slide.ingest_status != "succeeded" or slide.image_kind == "field_image":
            return "slide_not_extractable", "Only ingested whole-slide images can be scored"
    return None


def bundle_dict(db, b: InferenceBundle, *, verify_object: bool = True) -> dict:
    c = b.content_json or {}
    problems = verify_bundle(b, check_object=verify_object)
    refusal = inference_refusal(c)
    n_pred = len(db.scalars(select(InferencePrediction.id).where(InferencePrediction.bundle_id == b.id)).all())
    return {"id": b.id, "project_id": b.project_id, "run_id": b.run_id, "bundle_sha256": b.bundle_sha256,
            "object_key": b.object_key, "verified": not problems, "problems": problems,
            "created_by": b.created_by, "created_at": b.created_at.isoformat(), "research_use_only": True,
            "can_infer": refusal is None, "inference_refusal": refusal[1] if refusal else None,
            "n_predictions": n_pred, "synthetic": bool(c.get("synthetic")),
            "banner": PIPELINE_TEST_BANNER if c.get("synthetic") else None, "notice": BUNDLE_NOTICE, "content": c}


# =========================================================================== inference


def _provenance_snapshot(db, slide: Slide) -> dict:
    """What the slide looked like when it was scored (provenance; the extraction verifies its own inputs)."""
    return {"slide_sha256": slide.sha256, "object_key": slide.object_key, "mpp_x": slide.mpp_x, "mpp_y": slide.mpp_y,
            "width": slide.width, "height": slide.height, "level_downsamples": slide.level_downsamples_json,
            "provenance": slide.provenance, "image_kind": slide.image_kind, **qc_snapshot(db, slide.id)}


def request_inference(db, actor, bundle: InferenceBundle, slide_id: str):
    """Validate and enqueue ``infer_slide`` (idempotent per bundle and slide). Returns ``(job, created)``."""
    slide = db.get(Slide, slide_id)
    if slide is None or slide.project_id != bundle.project_id:
        raise not_found("slide", slide_id)
    problems = verify_bundle(bundle)
    if problems:
        raise conflict("bundle_integrity", "The bundle failed verification; it is not used", problems=problems)
    refusal = inference_refusal(bundle.content_json or {}, slide)
    if refusal is not None:
        raise conflict(refusal[0], refusal[1], bundle_id=bundle.id, slide_id=slide_id)
    from .encoders import get_encoder

    enc_id = (bundle.content_json.get("encoder") or {}).get("id")
    adapter = get_encoder(enc_id)
    if adapter is None:
        raise conflict("encoder_unavailable", f"Encoder {enc_id} is not installed", encoder_id=enc_id)
    status, detail = adapter.status()
    if status != "available":
        raise conflict("encoder_unavailable", f"Encoder {enc_id} is not available ({status})", encoder_id=enc_id,
                       status=status, status_detail=detail)
    job, created = queue.enqueue(db, INFER_JOB, {"bundle_id": bundle.id, "slide_id": slide.id},
                                 idempotency_key=f"infer:{bundle.id}:{slide.id}", project_id=bundle.project_id,
                                 created_by=actor.id)
    if created:
        audit.record_for(db, actor, project_id=bundle.project_id, action="inference.requested",
                         entity_type="inference_bundle", entity_id=bundle.id,
                         after={"slide_id": slide.id, "slide_sha256": slide.sha256, "job_id": job.id})
    return job, created


def _check_run_matches(run: TrainingRun, content: dict) -> None:
    head = content.get("head") or {}
    thr = content.get("threshold") or {}
    bad = []
    if run.checkpoint_sha256 != head.get("checkpoint_sha256"):
        bad.append("checkpoint_sha256")
    if run.threshold_value is None or float(run.threshold_value) != float(thr.get("value")):
        bad.append("threshold")
    if run.calibration_json is not None and run.calibration_json != content.get("calibration"):
        bad.append("calibration")
    if run.abstention_json is not None and run.abstention_json != content.get("abstention"):
        bad.append("abstention")
    if run.dataset_manifest_sha256 != content.get("dataset_manifest_sha256"):
        bad.append("dataset_manifest_sha256")
    if bad:
        raise PermanentJobError(f"bundle_run_mismatch: {', '.join(bad)} of run {run.id} differ from the bundle")


def _policies(content: dict):
    from .patching import PatchPolicy
    from .stain import StainPolicy

    try:
        pp = PatchPolicy.from_json((content.get("patch_policy") or {}).get("policy") or {})
        stain = StainPolicy.from_json((content.get("stain_policy") or {}).get("policy") or {})
    except (TypeError, ValueError, KeyError) as exc:
        raise PermanentJobError(f"bundle policies are unreadable: {exc}") from exc
    if pp.policy_sha256 != (content.get("patch_policy") or {}).get("policy_sha256"):
        raise PermanentJobError("bundle patch policy does not hash to its recorded policy_sha256")
    if stain.policy_sha256 != (content.get("stain_policy") or {}).get("policy_sha256"):
        raise PermanentJobError("bundle stain policy does not hash to its recorded policy_sha256")
    return pp, stain


def _verify_features(sf, content: dict, slide_id: str) -> None:
    enc = content.get("encoder") or {}
    pins = [("weights_sha256", enc.get("weights_sha256")), ("encoder_spec_sha256", enc.get("spec_sha256")),
            ("policy_sha256", (content.get("patch_policy") or {}).get("policy_sha256")),
            ("stain_policy_sha256", (content.get("stain_policy") or {}).get("policy_sha256"))]
    bad = [f"{k}: {getattr(sf, k, None)} != pinned {want}" for k, want in pins if getattr(sf, k, None) != want]
    if getattr(sf, "slide_id", slide_id) != slide_id:
        bad.append(f"slide_id {sf.slide_id} != {slide_id}")
    if bad:
        raise PermanentJobError(f"weights_or_identity_mismatch for slide {slide_id}: " + "; ".join(bad))


def _integrity_errors() -> tuple[type, ...]:
    from . import feature_sets as fsm

    cls = getattr(fsm, "FeatureSetIntegrityError", None)
    return (cls,) if isinstance(cls, type) else ()


def _unscorable_errors() -> tuple[type, ...]:
    from .features import FeatureError
    from .patching import ScaleError
    from .sampling import SamplingError
    from .stain import StainError

    return (FeatureError, ScaleError, SamplingError, StainError)


def score_slide(bundle_id: str, slide_id: str, ctx=None, *, created_by: str | None = None,
                need_embedding: bool = True) -> tuple[dict, np.ndarray | None]:
    """Score one slide through a bundle, label-free; reuse the stored prediction if there is one.

    Returns ``(prediction dict, mean embedding or None)``; the mean embedding (for active-learning
    diversity) comes from the label-free extraction, which the feature cache makes cheap on repeat."""
    from . import feature_sets as fsm
    from . import training
    from .encoders import EncoderInputError, EncoderUnavailable, get_encoder
    from .fixture import SyntheticSignalForbidden

    with session_scope() as db:
        bundle = db.get(InferenceBundle, bundle_id)
        slide = db.get(Slide, slide_id)
        if bundle is None or slide is None or slide.project_id != bundle.project_id:
            raise PermanentJobError(f"bundle {bundle_id} or slide {slide_id} does not exist in one project")
        problems = verify_bundle(bundle)
        if problems:
            raise PermanentJobError("bundle_integrity: " + "; ".join(problems))
        content = dict(bundle.content_json)
        refusal = inference_refusal(content, slide)
        if refusal is not None:
            raise PermanentJobError(f"{refusal[0]}: {refusal[1]}")
        run = db.get(TrainingRun, bundle.run_id)
        _check_run_matches(run, content)
        enc = content.get("encoder") or {}
        adapter = get_encoder(enc.get("id"))
        spec = getattr(adapter, "spec", None)
        if adapter is None or spec is None or spec.spec_sha256() != enc.get("spec_sha256"):
            raise PermanentJobError(f"encoder_spec_changed: the installed {enc.get('id')} adapter does not match the "
                                    "bundle's encoder spec sha256 (a new adapter version needs a new bundle)")
        snapshot = _provenance_snapshot(db, slide)
        existing = db.scalars(select(InferencePrediction).where(InferencePrediction.bundle_id == bundle_id,
                                                                InferencePrediction.slide_id == slide_id)).first()
        existing_dict = prediction_dict(existing, content) if existing is not None else None
    if existing_dict is not None and not need_embedding:
        return existing_dict, None
    pp, stain = _policies(content)
    env = content.get("extraction_env") or {}
    spec_json = enc.get("spec") or {}
    extraction = spec_json.get("extraction") or {}
    sf, reason = None, None
    try:
        # input_snapshot=None: the extraction snapshots the slide's live row and QC state itself.
        sf = fsm.extract_slide(slide_id, encoder_id=enc["id"], weights_sha256=enc["weights_sha256"],
                               encoder_spec_sha256=enc["spec_sha256"], patch_policy=pp, sampling_policy=pp.sampling,
                               stain_policy=stain, device=extraction.get("device") or env.get("device_class") or "cpu",
                               precision=env.get("precision") or "fp32", input_snapshot=None, ctx=ctx,
                               pixel_mode=extraction.get("pixel_mode") or "read",
                               batch_size=extraction.get("batch_size"),
                               weights_config_sha256=enc.get("config_sha256"),
                               encoder_config=spec_json.get("encoder_config") or None,
                               job_id=getattr(ctx, "job_id", None))
    except EncoderUnavailable as exc:  # includes EncoderIdentityMismatch: loaded weights != pinned sha
        raise PermanentJobError(f"encoder_unavailable_or_weights_mismatch: {exc}") from exc
    except SyntheticSignalForbidden as exc:
        raise PermanentJobError(f"synthetic_signal_forbidden: {exc}") from exc
    except EncoderInputError as exc:
        raise PermanentJobError(f"encoder_input_error: {exc}") from exc
    except _integrity_errors() as exc:  # a corrupt artifact is a failure, never a recorded "unscorable" outcome
        raise PermanentJobError(f"feature_integrity: {exc}") from exc
    except _unscorable_errors() as exc:
        reason = f"{type(exc).__name__}: {exc}"[:200]
    mean = None
    if sf is not None:
        _verify_features(sf, content, slide_id)
        emb = np.asarray(sf.embeddings, dtype=np.float32)
        if emb.shape[0] == 0:
            reason = "no tissue patches after QC exclusions"
        else:
            mean = emb.astype(np.float64).mean(axis=0)
    if existing_dict is not None:
        return existing_dict, mean
    score = cal = pred = None
    abstained = False
    if reason is None:
        bag = Bag(bag_id=slide_id, kind="slide", slide_ids=[slide_id], case_id=None, patient_id="", patient_code=None,
                  label_value=None, label=None, label_version_ids=[], attributes={},
                  artifact_ids=[sf.artifact_id] if getattr(sf, "artifact_id", None) else [], embeddings=emb)
        with session_scope() as db:
            run = db.get(TrainingRun, content["run_id"])
            try:
                (_, score, cal, pred, abstained), = training.score_bags_with_checkpoint(run, [bag])
            except ValueError as exc:
                raise PermanentJobError(f"scoring failed: {exc}") from exc
        score, pred = float(score), int(pred)
        cal = None if cal is None else float(cal)
        if pred != int(score >= float(content["threshold"]["value"])):
            raise PermanentJobError("decision disagrees with score >= the bundle threshold")
    with session_scope() as db:
        existing = db.scalars(select(InferencePrediction).where(InferencePrediction.bundle_id == bundle_id,
                                                                InferencePrediction.slide_id == slide_id)).first()
        if existing is not None:  # another attempt recorded it first
            return prediction_dict(existing, content), mean
        art_id = getattr(sf, "artifact_id", None) if sf is not None else None
        art = db.get(FeatureArtifact, art_id) if art_id else None
        p = InferencePrediction(project_id=content["project_id"], bundle_id=bundle_id, slide_id=slide_id,
                                slide_sha256=snapshot["slide_sha256"], feature_artifact_id=art.id if art else None,
                                job_id=getattr(ctx, "job_id", None), score=score, calibrated_score=cal,
                                threshold=float(content["threshold"]["value"]), predicted=pred,
                                abstained=bool(abstained), unscorable_reason=reason,
                                coverage_json=art.coverage_json if art is not None else None,
                                input_snapshot_json={**snapshot, "n_patches": int(getattr(sf, "n_patches", 0) or 0)
                                                     if sf is not None else 0,
                                                     "feature_artifact_id": art_id},
                                research_use_only=True, created_by=created_by or audit.SYSTEM_WORKER)
        db.add(p)
        db.flush()
        audit.record(db, action="inference.recorded", entity_type="inference_prediction", entity_id=p.id,
                     actor_id=audit.SYSTEM_WORKER, actor_role="system", project_id=content["project_id"],
                     after={"bundle_id": bundle_id, "slide_id": slide_id, "score": score, "abstained": bool(abstained),
                            "unscorable_reason": reason, "research_use_only": True})
        if ctx is not None:
            ctx.assert_lease(db)
        return prediction_dict(p, content), mean


def infer_slide(bundle_id: str, slide_id: str, ctx=None) -> dict:
    created_by = getattr(ctx, "created_by", None)
    pred, _ = score_slide(bundle_id, slide_id, ctx, created_by=created_by, need_embedding=False)
    return {"bundle_id": bundle_id, "slide_id": slide_id, "inference_prediction_id": pred["id"],
            "score": pred["score"], "abstained": pred["abstained"], "unscorable_reason": pred["unscorable_reason"]}


@register(INFER_JOB, description="Label-free research inference of a registered bundle on one slide")
def infer_slide_job(ctx, payload: dict) -> dict:
    if any(k in payload for k in ("label", "labels", "fixture_label", "label_value")):
        raise PermanentJobError("inference payloads never carry labels")
    bundle_id, slide_id = payload.get("bundle_id"), payload.get("slide_id")
    if not bundle_id or not slide_id:
        raise PermanentJobError("payload.bundle_id and payload.slide_id are required")
    return infer_slide(bundle_id, slide_id, ctx)


def prediction_dict(p: InferencePrediction, content: dict) -> dict:
    classes = content.get("classes") or {}
    pos, neg = classes.get("positive_class"), classes.get("negative_class")
    predicted = None if p.predicted is None else (pos if p.predicted else neg)
    return {"id": p.id, "bundle_id": p.bundle_id, "slide_id": p.slide_id, "slide_sha256": p.slide_sha256,
            "score": p.score, "calibrated_score": p.calibrated_score, "threshold": p.threshold,
            "predicted": p.predicted, "predicted_class": predicted,
            "predicted_display": LABEL_DISPLAY.get(predicted, predicted) if predicted else None,
            "abstained": bool(p.abstained), "unscorable_reason": p.unscorable_reason,
            "feature_artifact_id": p.feature_artifact_id, "coverage": p.coverage_json,
            "input_snapshot": p.input_snapshot_json, "job_id": p.job_id, "created_by": p.created_by,
            "created_at": p.created_at.isoformat() if p.created_at else None, "research_use_only": True,
            "is_label": False, "bag_scope": "slide" + (" (the model was trained on case bags)"
                                                      if classes.get("label_scope") == "case" else ""),
            "notice": PREDICTION_NOTICE}


# Workers import dermpath.ml.inference (dermpath.ml.jobs ENGINE_HANDLER_MODULES); importing active learning here
# registers its ``active_learning`` job handler in the same worker process (it imports this module lazily).
from . import active_learning as _active_learning  # noqa: E402,F401
