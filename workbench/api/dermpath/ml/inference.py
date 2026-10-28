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

Scope (owner brief item 2A). The bundle's ``classes.label_scope`` is enforced: only a bundle trained on
SLIDE bags scores a slide. A case-trained bundle's output is a probability for a case's complete set of
eligible slides, aggregated as in training; it is never computed on one slide and never reported as a
slide probability. :func:`inference_refusal` returns ``scope_mismatch`` for it, so the single-slide API
(409), the ``infer_slide`` worker and every slide acquisition path that scores through
:func:`score_slide` (active learning) fail closed. Case inference would need its own endpoint (a frozen
complete eligible slide set per case, case aggregation consistent with training, case-level provenance).

One input snapshot (owner brief item 2B). The job takes ONE canonical effective input snapshot when it
executes (:func:`effective_input_snapshot`: ``feature_sets.slide_snapshot`` over the live QC state, i.e.
slide sha256 and object key, image kind and provenance, effective mpp and calibration, dimensions and
level downsamples, the QC mask object key / sha256 / downsample and the excluded-region content), and
passes exactly that dict to ``extract_slide(input_snapshot=...)``. The extraction reads only it and
verifies the image bytes and the mask object against it (a mismatch is ``input_changed``: the job fails
permanently and records nothing; it is never an "unscorable" outcome). The returned artifact must have
been built from it (slide sha, mask sha, excluded-regions sha, calibration). The prediction stores the
snapshot and its sha256 (``input_snapshot_sha256``, :func:`snapshot_sha256`), with
``provenance_status = "complete"``; model and preprocessing identity stay pinned by the bundle.

Reuse, versions and concurrency:

* A stored prediction is reused only for the same bundle, subject (scope ``slide`` + slide id) and
  input-snapshot sha256, with complete provenance whose stored snapshot still hashes to that identity.
  A changed input is a NEW prediction row; earlier rows stay (history). Rows written before this rule
  (``legacy_unverified``, see :mod:`dermpath.ml.engine_models`) are never reused or rewritten.
* An embedding is returned only with features extracted from the same snapshot as the score: on reuse
  the features are re-derived from the stored snapshot (a feature-cache hit) and must reproduce the
  recorded feature identity (row count and a chunked sha256 of the scored rows), else the job fails
  (``stale_prediction_refused``): an old score is never paired with a new embedding.
* The API dedupes by ``infer:{bundle}:{slide}:{request-time snapshot sha256}`` (one job per input
  identity; a changed input gets a new job), and the payload carries that sha
  (``expected_input_snapshot_sha256``; the result reports ``requested_input_snapshot_sha256`` and
  ``input_changed_since_request``). The job handed back always answers the request's identity: when the newest
  job of the identity's chain finished on ANOTHER identity (the input changed while it was queued), failed or was
  canceled, a new job is enqueued under ``…:r{n}`` (duplicate re-requests share it through the unique key).
  Workers insert under the unique constraint
  (bundle, subject scope, slide, snapshot sha256); a worker that loses the race returns the winner's
  row (after the same feature-identity check), so duplicate concurrent work yields one prediction.
* Only outcomes that are deterministic functions of the snapshot (and the bundle) are recorded as a snapshot's
  "unscorable" outcome (scale, sampling and stain refusals, no tissue patches, region geometry, ...). A slide whose
  ingest state moved after the snapshot (``feature_sets.NOT_INGESTED``: a re-ingest in flight) raises
  :class:`InputNotReady` (retried with backoff, nothing recorded); worker-side refusals (``extraction_env_changed``,
  ``extraction_code_changed``) fail the job and record nothing.
* Image identity on the reuse path: the snapshot identity is computed from database fields only, so before a
  STORED prediction is served (the worker's reuse path with or without an embedding, and the API's ``prediction``)
  the slide's stored image and QC mask object are verified against the snapshot
  (:func:`dermpath.ml.feature_sets.verify_snapshot_objects`; the image sha is memoised per object key, size,
  mtime, inode and ctime, so an unchanged object costs a ``stat``; the first check in a process streams the file
  once). An object replaced in place fails closed: ``input_changed`` in the worker (both active-learning modes) and
  ``409 input_changed`` from ``POST /bundles/{id}/infer``. A slide without a stored prediction is checked by the
  extraction itself.

Memory (owner brief item 5): embeddings are never copied whole. The pooled embedding (only computed when
asked: active learning's diversity) uses the head's chunked float64 :func:`dermpath.ml.heads.streaming_mean`
(``MEAN_CHUNK_ROWS`` rows at a time; identical bits to what ``meanpool_logreg`` scores), and the feature
identity hash streams the same chunks. ABMIL itself needs the whole bag in float32 (attention spans every
patch); that is the head's requirement, not a copy made here.
"""

from __future__ import annotations

import hashlib
import json
import types

import numpy as np
from sqlalchemy import or_, select
from sqlalchemy.exc import IntegrityError

from .. import audit
from ..datasets import IMPORTED_REFERENCE_NOTICE, item_data_mode
from ..db import session_scope
from ..errors import conflict, not_found
from ..jobs import queue
from ..jobs.registry import PermanentJobError, refuse_label_payload, register
from ..models import Slide
from ..storage import get_store
from ..vocab import LABEL_DISPLAY
from . import PIPELINE_TEST_BANNER
from . import heads as _heads
from .artifacts import canonical_json, sha256_hex
from .calibration import identity_calibration
from .engine_models import FeatureSet, InferenceBundle, InferencePrediction, RunAttempt, bundle_sha256_of
from .evaluation import NEGATIVE_NOTE, threshold_dict
from .heads import CHECKPOINT_SCHEMA, Bag, streaming_mean
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
#: The scope every slide path scores (single-slide inference, active-learning slide acquisition).
SUBJECT_SCOPE = "slide"
INPUT_SNAPSHOT_SCHEMA = "dermpath.inference_input_snapshot/1"
EMBEDDINGS_IDENTITY_SCHEMA = "dermpath.embeddings_rows/1"
PROVENANCE_COMPLETE = "complete"
PROVENANCE_LEGACY = "legacy_unverified"
#: Keys the prediction adds to its stored snapshot (outputs and identity; never part of the snapshot identity).
SNAPSHOT_RECORD_KEYS = frozenset({"schema", "input_snapshot_sha256", "n_patches", "feature_artifact_id", "features"})
#: Extraction error prefixes that describe the worker (environment, extraction code), not the input snapshot: they
#: fail the job and are never recorded as a snapshot's "unscorable" outcome.
NOT_SNAPSHOT_OUTCOMES = ("extraction_env_changed", "extraction_code_changed")


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


def scope_refusal(content: dict, subject_scope: str = SUBJECT_SCOPE) -> tuple[str, str] | None:
    """``("scope_mismatch", message)`` when the bundle's training bag scope is not ``subject_scope``, else None.

    Fails closed: a bundle that does not state its scope is refused too."""
    scope = (content.get("classes") or {}).get("label_scope")
    if scope == subject_scope:
        return None
    if scope == "case":
        what = ("its model was trained on case-level bags (label_scope 'case'), so its output is a probability for a "
                "case's complete set of eligible slides, aggregated as in training; it cannot score a single slide, "
                "and a case probability is never reported as a slide probability")
    else:
        what = f"its model was trained on {scope!r} bags, not on single slides"
    return "scope_mismatch", (
        f"Scope mismatch: {what}. Single-slide inference and active-learning slide acquisition refuse this bundle. "
        "Use a bundle registered from a run on a slide-scope dataset (label_scope 'slide'). Case-level inference "
        "needs its own endpoint (a frozen complete eligible slide set per case, case aggregation consistent with "
        "training, case-level provenance); it is not implemented.")


def inference_refusal(content: dict, slide: Slide | None = None) -> tuple[str, str] | None:
    """``(code, message)`` when this bundle may not score (this) slide, else None (label-free checks only).

    Every caller scores SLIDES, so the bundle's training scope must be ``slide`` (:func:`scope_refusal`)."""
    enc = content.get("encoder") or {}
    if content.get("execution_mode") == "synthetic_pipeline_test" or (enc.get("spec") or {}).get("synthetic"):
        return "mode_mismatch", SYNTHETIC_REFUSAL
    scope = scope_refusal(content)
    if scope is not None:
        return scope
    if slide is not None:
        if item_data_mode(slide.provenance, slide.image_kind) == "synthetic":
            return "mode_mismatch", ("Synthetic demo slides are refused for a real encoder outside the pipeline-test "
                                     "mode (design §1)")
        if slide.ingest_status != "succeeded" or slide.image_kind == "field_image":
            return "slide_not_extractable", "Only ingested whole-slide images can be scored"
    return None


def test_material_reason(db, run: TrainingRun | None, slide: Slide, *, cache: dict | None = None) -> str | None:
    """Why scoring ``slide`` through this run's bundle would read TEST material, else None.

    Test material is a test item or a slide of a test patient of the run's frozen manifest, a slide of a patient
    sealed by a test release anywhere in the project, or a slide a test release looked at (moved since). Bundle
    inference must not be a side door to test predictions: such slides are scored only once a recorded test release
    covers the run (design §7), and their predictions are then readable only with ``dataset.test_access``.
    ``cache``: a dict reused across calls for one run (the manifest and project seals are read once)."""
    from ..datasets import project_sealed_patients, sealed_slides
    from ..hierarchy import slide_lineage
    from ..models import DatasetVersion

    ctx = cache if cache is not None else {}
    if "items" not in ctx:
        dv = db.get(DatasetVersion, run.dataset_version_id) if run is not None and run.dataset_version_id else None
        manifest = (dv.manifest_json if dv is not None else None) or {}
        ctx["items"] = {it["slide_id"]: it for it in manifest.get("items", []) if it.get("slide_id")}
        ctx["test_patients"] = {s["coded_patient_id"] for s in manifest.get("splits", []) if s.get("split") == "test"}
        ctx["sealed_patients"] = project_sealed_patients(db, slide.project_id)
        ctx["sealed_slides"] = sealed_slides(db, slide.project_id)
    item = ctx["items"].get(slide.id)
    if item is not None and item.get("split") == "test":
        return "a test item of the bundle's frozen manifest"
    patients = {slide_lineage(db, slide).get("coded_patient_id"), (item or {}).get("coded_patient_id")} - {None}
    if patients & ctx["test_patients"]:
        return "a slide of a test patient of the bundle's frozen manifest"
    if patients & ctx["sealed_patients"]:
        return "a slide of a patient sealed by a test release"
    if slide.id in ctx["sealed_slides"]:
        return "a slide a test release looked at"
    return None


def test_material_refusal(db, run: TrainingRun | None, slide: Slide) -> tuple[str, str] | None:
    """``("test_release_required", message)`` when the slide is test material and no recorded test release covers
    the bundle's run, else None."""
    from .evaluation import releases_for_run

    why = test_material_reason(db, run, slide)
    if why is None or (run is not None and releases_for_run(db, run)):
        return None
    return ("test_release_required", f"Slide {slide.id} is {why}. Test predictions exist only through a recorded "
            "test release (POST /experiments/{id}/test-release: research lead, reason, counted, sealing), not "
            "through bundle inference")


def bundle_dict(db, b: InferenceBundle, *, verify_object: bool = True) -> dict:
    c = b.content_json or {}
    problems = verify_bundle(b, check_object=verify_object)
    refusal = inference_refusal(c)
    n_pred = len(db.scalars(select(InferencePrediction.id).where(InferencePrediction.bundle_id == b.id)).all())
    return {"id": b.id, "project_id": b.project_id, "run_id": b.run_id, "bundle_sha256": b.bundle_sha256,
            "object_key": b.object_key, "verified": not problems, "problems": problems,
            "created_by": b.created_by, "created_at": b.created_at.isoformat(), "research_use_only": True,
            "can_infer": refusal is None, "inference_refusal": refusal[1] if refusal else None,
            "inference_refusal_code": refusal[0] if refusal else None,
            "label_scope": (c.get("classes") or {}).get("label_scope"), "subject_scope": SUBJECT_SCOPE,
            "n_predictions": n_pred, "synthetic": bool(c.get("synthetic")),
            "banner": PIPELINE_TEST_BANNER if c.get("synthetic") else None, "notice": BUNDLE_NOTICE, "content": c}


# =========================================================================== inference


def snapshot_sha256(snapshot: dict) -> str:
    """Identity of a canonical effective input snapshot (the keys the prediction adds are not part of it)."""
    ident = {k: v for k, v in (snapshot or {}).items() if k not in SNAPSHOT_RECORD_KEYS}
    return sha256_hex(canonical_json({"schema": INPUT_SNAPSHOT_SCHEMA, "snapshot": ident}))


def effective_input_snapshot(db, slide: Slide) -> tuple[dict, str]:
    """``(snapshot, sha256)``: the slide's canonical effective input snapshot NOW, exactly the dict
    :func:`dermpath.ml.feature_sets.extract_slide` reads (``slide_snapshot`` over ``live_qc``): slide sha256 and
    object key, image kind, provenance and format, effective mpp and calibration, dimensions and level
    downsamples, the QC mask (review id, object key, sha256, downsample) and the excluded regions (issue ids,
    geometry, sha256). Never a label."""
    from . import feature_sets as fsm

    snap = fsm.slide_snapshot(slide, {**fsm.live_qc(db, slide.id), "qc_source": "live_qc_at_inference"})
    return snap, snapshot_sha256(snap)


def _stored_prediction(db, bundle_id: str, slide_id: str, snapshot_sha: str) -> InferencePrediction | None:
    """The reusable prediction for exactly this (bundle, subject, input identity), or None.

    Only complete provenance counts, and the stored snapshot must still hash to the identity."""
    row = db.scalars(select(InferencePrediction).where(
        InferencePrediction.bundle_id == bundle_id, InferencePrediction.subject_scope == SUBJECT_SCOPE,
        InferencePrediction.slide_id == slide_id, InferencePrediction.input_snapshot_sha256 == snapshot_sha,
        InferencePrediction.provenance_status == PROVENANCE_COMPLETE)).first()
    if row is not None and snapshot_sha256(row.input_snapshot_json or {}) != snapshot_sha:
        raise PermanentJobError(f"prediction_integrity: stored prediction {row.id} does not hash to its recorded "
                                "input-snapshot sha256; it is not reused")
    return row


class InputNotReady(RuntimeError):
    """The slide is in a transient state that is not part of any input snapshot (a re-ingest in flight after the
    job's snapshot). Not a :class:`PermanentJobError`: the worker retries the job with backoff, and nothing is
    recorded as the snapshot's outcome."""


def _verify_objects(slide_ref, snapshot: dict, pred_id: str | None = None) -> str | None:
    """None when the stored slide image (and QC mask object) still are the snapshot's, else the ``input_changed``
    detail (:func:`dermpath.ml.feature_sets.verify_snapshot_objects`; memoised, a ``stat`` when unchanged)."""
    from . import feature_sets as fsm

    try:
        fsm.verify_snapshot_objects(slide_ref, snapshot)
    except fsm.FeatureError as exc:
        what = f"prediction {pred_id} is not served for it" if pred_id else "nothing is served for it"
        return f"{exc} (the stored objects no longer match the input snapshot; {what})"
    return None


def current_prediction(db, bundle: InferenceBundle, slide_id: str) -> tuple[InferencePrediction | None, str | None]:
    """``(prediction for the slide's current input identity or None, that identity)`` (for the API).

    A stored prediction is presented as the answer for the current input only after the slide's stored image and
    mask object are verified against its snapshot (the snapshot identity is computed from database fields only, so
    an object replaced in place would otherwise keep its old score): a mismatch is ``409 input_changed``."""
    slide = db.get(Slide, slide_id)
    if slide is None or slide.project_id != bundle.project_id:
        return None, None
    snap, sha = effective_input_snapshot(db, slide)
    try:
        row = _stored_prediction(db, bundle.id, slide_id, sha)
    except PermanentJobError:
        return None, sha
    if row is not None:
        bad = _verify_objects(slide, snap, row.id)
        if bad is not None:
            raise conflict("input_changed", bad, bundle_id=bundle.id, slide_id=slide_id, input_snapshot_sha256=sha,
                           prediction_id=row.id)
    return row, sha


def _infer_key(bundle_id: str, slide_id: str, snapshot_sha: str) -> str:
    return f"infer:{bundle_id}:{slide_id}:{snapshot_sha}"


def _latest_infer_job(db, base_key: str):
    """``(newest job of the request chain of one input identity, its attempt number)`` or ``(None, -1)``.

    The chain is ``base_key`` (attempt 0) then ``base_key:r1``, ``base_key:r2``, ..."""
    from ..models import Job

    rows = db.scalars(select(Job).where(or_(Job.idempotency_key == base_key,
                                            Job.idempotency_key.startswith(base_key + ":r", autoescape=True)))).all()
    best, best_n = None, -1
    for job in rows:
        suffix = job.idempotency_key[len(base_key):]
        n = 0 if suffix == "" else (int(suffix[2:]) if suffix[2:].isdigit() else -1)
        if n > best_n:
            best, best_n = job, n
    return best, best_n


def _job_answers(job, snapshot_sha: str) -> bool:
    """Whether ``job`` is the answer to a request for input identity ``snapshot_sha``: still in flight, or finished
    with a result FOR that identity. A job that scored another identity (the input changed while it was queued), or
    that failed or was canceled, is not: the request gets a new job."""
    if job.status in ("queued", "running"):
        return True
    return job.status == "succeeded" and (job.result_json or {}).get("input_snapshot_sha256") == snapshot_sha


def request_inference(db, actor, bundle: InferenceBundle, slide_id: str):
    """Validate and enqueue ``infer_slide``: one job per (bundle, slide, current input identity). Returns
    ``(job, created)``. The job takes its own snapshot when it runs; this one keys the deduplication and travels in
    the payload (``expected_input_snapshot_sha256``), so a changed input (QC mask, exclusions, calibration,
    re-ingested image) gets a new job and an unchanged one does not. The job returned always answers THIS identity:
    when the newest job of the identity's chain finished on another identity (its input changed while it was
    queued), failed or was canceled, a new job is enqueued under ``infer:{bundle}:{slide}:{sha}:r{n}`` (concurrent
    requests share it through the unique key); a job whose result belongs to another input is never handed back."""
    slide = db.get(Slide, slide_id)
    if slide is None or slide.project_id != bundle.project_id:
        raise not_found("slide", slide_id)
    problems = verify_bundle(bundle)
    if problems:
        raise conflict("bundle_integrity", "The bundle failed verification; it is not used", problems=problems)
    refusal = inference_refusal(bundle.content_json or {}, slide) or test_material_refusal(
        db, db.get(TrainingRun, bundle.run_id), slide)
    if refusal is not None:
        extra = {}
        if refusal[0] == "scope_mismatch":
            extra = {"bundle_label_scope": ((bundle.content_json or {}).get("classes") or {}).get("label_scope"),
                     "endpoint_scope": SUBJECT_SCOPE}
        raise conflict(refusal[0], refusal[1], bundle_id=bundle.id, slide_id=slide_id, **extra)
    from .encoders import get_encoder

    enc_id = (bundle.content_json.get("encoder") or {}).get("id")
    adapter = get_encoder(enc_id)
    if adapter is None:
        raise conflict("encoder_unavailable", f"Encoder {enc_id} is not installed", encoder_id=enc_id)
    status, detail = adapter.status()
    if status != "available":
        raise conflict("encoder_unavailable", f"Encoder {enc_id} is not available ({status})", encoder_id=enc_id,
                       status=status, status_detail=detail)
    _snap, snap_sha = effective_input_snapshot(db, slide)
    base_key = _infer_key(bundle.id, slide.id, snap_sha)
    latest, attempt = _latest_infer_job(db, base_key)
    if latest is not None and _job_answers(latest, snap_sha):
        return latest, False
    key = base_key if latest is None else f"{base_key}:r{attempt + 1}"
    job, created = queue.enqueue(db, INFER_JOB, {"bundle_id": bundle.id, "slide_id": slide.id,
                                                 "expected_input_snapshot_sha256": snap_sha},
                                 idempotency_key=key, project_id=bundle.project_id, created_by=actor.id)
    if created:
        audit.record_for(db, actor, project_id=bundle.project_id, action="inference.requested",
                         entity_type="inference_bundle", entity_id=bundle.id,
                         after={"slide_id": slide.id, "slide_sha256": slide.sha256, "job_id": job.id,
                                "input_snapshot_sha256_at_request": snap_sha,
                                "supersedes_job": None if latest is None else {"id": latest.id,
                                                                               "status": latest.status}})
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
            ("stain_policy_sha256", (content.get("stain_policy") or {}).get("policy_sha256")),
            ("extraction_env_sha256", (content.get("extraction_env") or {}).get("sha256"))]
    bad = [f"{k}: {getattr(sf, k, None)} != pinned {want}" for k, want in pins if getattr(sf, k, None) != want]
    pinned_version = ((enc.get("spec") or {}).get("extraction") or {}).get("extractor_version")
    used_version = ((getattr(sf, "meta", None) or {}).get("fields") or {}).get("extractor_version")
    if pinned_version is not None and used_version != pinned_version:
        bad.append(f"extractor_version: {used_version} != pinned {pinned_version}")
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


def embedding_mean(emb: np.ndarray) -> np.ndarray:
    """Mean embedding of one slide in float64, streamed in fixed ``heads.MEAN_CHUNK_ROWS`` chunks (bounded memory,
    no whole-matrix copy; identical bits to the pooling ``meanpool_logreg`` scores). Raises ``ValueError`` when
    there is no row."""
    return streaming_mean([emb])


def embeddings_content_sha256(emb: np.ndarray) -> str:
    """sha256 over the scored rows (little-endian float32, row-major) plus their shape, streamed in the same fixed
    chunks (a contiguous float32 chunk, such as a slice of the memory-mapped artifact, is hashed without a copy)."""
    if emb.ndim != 2:
        raise ValueError("embeddings must be 2-D (N, D)")
    rows, dim = int(emb.shape[0]), int(emb.shape[1])
    h = hashlib.sha256(f"{EMBEDDINGS_IDENTITY_SCHEMA}|<f4|{rows}x{dim}|".encode())
    step = max(1, int(_heads.MEAN_CHUNK_ROWS))
    for start in range(0, rows, step):
        h.update(np.ascontiguousarray(emb[start:start + step], dtype="<f4"))
    return h.hexdigest()


def _feature_identity(sf, emb: np.ndarray) -> dict:
    return {"n_patches": int(emb.shape[0]), "embedding_dim": int(emb.shape[1]),
            "embeddings_content_sha256": embeddings_content_sha256(emb),
            "feature_artifact_id": getattr(sf, "artifact_id", None), "cache_key": getattr(sf, "cache_key", None),
            "extraction_env_sha256": getattr(sf, "extraction_env_sha256", None)}


def _same_features(recorded: dict | None, now: dict | None) -> bool:
    """Whether features extracted now from a stored prediction's snapshot are the ones it was scored on."""
    if recorded is None or now is None:
        return recorded is None and now is None  # both unextractable (the same deterministic refusal) or not
    return all(recorded.get(k) == now.get(k) for k in ("n_patches", "embedding_dim", "embeddings_content_sha256"))


def _stale_refusal(pred_id: str, recorded: dict | None, now: dict | None) -> PermanentJobError:
    def show(f):
        return "none (not extractable)" if f is None else (
            f"{f.get('n_patches')} rows, sha256 {str(f.get('embeddings_content_sha256'))[:16]}…")

    return PermanentJobError(
        f"stale_prediction_refused: prediction {pred_id} for this input snapshot was scored on features "
        f"[{show(recorded)}], but extraction from the same snapshot now gives [{show(now)}]; a stored score is never "
        "returned with an embedding of other features (check the feature cache and the extraction environment)")


def _snapshot_mismatches(art: FeatureArtifact | None, sf, snapshot: dict) -> list[str]:
    """Differences between the job's snapshot and the inputs the returned features were built from."""
    bad = []
    fields = (getattr(sf, "meta", None) or {}).get("fields") or {}
    for key in ("slide_sha256", "excluded_regions_sha256"):
        if key in fields and fields[key] != snapshot.get(key):
            bad.append(f"artifact key {key} {str(fields[key])[:16]} != snapshot {str(snapshot.get(key))[:16]}")
    if art is not None:
        for key, want in (("slide_sha256", snapshot.get("slide_sha256")),
                          ("mask_sha256", snapshot.get("mask_sha256")),
                          ("excluded_regions_sha256", snapshot.get("excluded_regions_sha256")),
                          ("calibrated", bool(snapshot.get("calibrated")))):
            got = bool(art.calibrated) if key == "calibrated" else getattr(art, key)
            if got != want:
                bad.append(f"artifact {art.id} {key} {str(got)[:16]} != snapshot {str(want)[:16]}")
        if art.slide_id != snapshot.get("slide_id"):
            bad.append(f"artifact {art.id} is of slide {art.slide_id}")
    return bad


def _extract(content: dict, slide_id: str, snapshot: dict, ctx):
    """``(slide features or None, unscorable reason or None)`` from exactly ``snapshot``."""
    from . import feature_sets as fsm
    from .encoders import EncoderInputError, EncoderUnavailable
    from .fixture import SyntheticSignalForbidden

    enc = content.get("encoder") or {}
    pp, stain = _policies(content)
    env = content.get("extraction_env") or {}
    spec_json = enc.get("spec") or {}
    extraction = spec_json.get("extraction") or {}
    # The bundle pins the extraction code version and environment of its feature set; features produced by other
    # extraction code or in another environment are never scored as if they were the bundle's (design §5, §8).
    try:
        fsm.check_extractor_version(extraction, what="bundle",
                                    remedy="register a new bundle (a new feature set and run) for this extractor")
        fsm.check_extraction_env(env.get("env") or {}, env.get("sha256"),
                                 {**extraction, "device": extraction.get("device") or env.get("device_class") or "cpu"},
                                 what="bundle", remedy="register a bundle built in this environment")
    except fsm.FeatureError as exc:
        raise PermanentJobError(str(exc)) from exc
    try:
        # The job's ONE snapshot: the extraction reads only it and verifies the image bytes and mask against it.
        sf = fsm.extract_slide(slide_id, encoder_id=enc["id"], weights_sha256=enc["weights_sha256"],
                               encoder_spec_sha256=enc["spec_sha256"], patch_policy=pp, sampling_policy=pp.sampling,
                               stain_policy=stain, device=extraction.get("device") or env.get("device_class") or "cpu",
                               precision=env.get("precision") or "fp32", input_snapshot=snapshot, ctx=ctx,
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
        # Only outcomes that are deterministic functions of the snapshot (and the bundle) are recorded as the
        # snapshot's research outcome: a row is unique per (bundle, slide, snapshot) and is served from then on.
        msg = str(exc)
        if msg.startswith("input_changed"):  # image identity / mask / snapshot failure: fail closed
            raise PermanentJobError(f"{exc} (slide {slide_id}: the inputs no longer match the job's input snapshot; "
                                    "nothing was recorded)") from exc
        if msg.startswith(fsm.NOT_INGESTED):  # transient state outside the snapshot: retry, record nothing
            raise InputNotReady(f"input_not_ready: {exc}; nothing was recorded, the job is retried") from exc
        if msg.startswith(NOT_SNAPSHOT_OUTCOMES):  # the worker's environment or code, not the input
            raise PermanentJobError(f"{exc} (not an outcome of slide {slide_id}'s input snapshot; nothing was "
                                    "recorded)") from exc
        return None, f"{type(exc).__name__}: {exc}"[:200]
    return sf, None


def score_slide(bundle_id: str, slide_id: str, ctx=None, *, created_by: str | None = None,
                need_embedding: bool = True) -> tuple[dict, np.ndarray | None]:
    """Score one slide through a SLIDE-scope bundle, label-free, from ONE input snapshot taken now.

    Returns ``(prediction dict, mean embedding or None)``. The stored prediction for this exact (bundle, slide,
    input-snapshot) identity is reused; otherwise features are extracted from the snapshot, scored and recorded
    as a new row. The mean embedding (active-learning diversity) is computed only when ``need_embedding``, in
    bounded memory, and always from the same features as the returned score (see the module docstring)."""
    from . import training
    from .encoders import get_encoder

    with session_scope() as db:
        bundle = db.get(InferenceBundle, bundle_id)
        slide = db.get(Slide, slide_id)
        if bundle is None or slide is None or slide.project_id != bundle.project_id:
            raise PermanentJobError(f"bundle {bundle_id} or slide {slide_id} does not exist in one project")
        problems = verify_bundle(bundle)
        if problems:
            raise PermanentJobError("bundle_integrity: " + "; ".join(problems))
        content = dict(bundle.content_json)
        run = db.get(TrainingRun, bundle.run_id)
        # Defence in depth: the worker re-checks what the request checked (scope, test material, modes).
        refusal = inference_refusal(content, slide) or test_material_refusal(db, run, slide)
        if refusal is not None:
            raise PermanentJobError(f"{refusal[0]}: {refusal[1]}")
        _check_run_matches(run, content)
        enc = content.get("encoder") or {}
        adapter = get_encoder(enc.get("id"))
        spec = getattr(adapter, "spec", None)
        if adapter is None or spec is None or spec.spec_sha256() != enc.get("spec_sha256"):
            raise PermanentJobError(f"encoder_spec_changed: the installed {enc.get('id')} adapter does not match the "
                                    "bundle's encoder spec sha256 (a new adapter version needs a new bundle)")
        snapshot, snap_sha = effective_input_snapshot(db, slide)  # the job's one canonical input snapshot
        existing = _stored_prediction(db, bundle_id, slide_id, snap_sha)
        existing_dict = prediction_dict(existing, content) if existing is not None else None
        recorded = (existing.input_snapshot_json or {}).get("features") if existing is not None else None
        slide_ref = types.SimpleNamespace(id=slide.id, synthetic_spec_json=slide.synthetic_spec_json)
    if existing_dict is not None:
        # The snapshot identity is computed from database fields only: before a stored score is served (with or
        # without an embedding), the stored image and mask objects must still be the snapshot's. Fail closed.
        bad = _verify_objects(slide_ref, snapshot, existing_dict["id"])
        if bad is not None:
            raise PermanentJobError(f"{bad} (slide {slide_id})")
    if existing_dict is not None and not need_embedding:
        return existing_dict, None
    sf, reason = _extract(content, slide_id, snapshot, ctx)
    emb = features = coverage = None
    art_id = getattr(sf, "artifact_id", None) if sf is not None else None
    if sf is not None:
        _verify_features(sf, content, slide_id)
        emb = sf.embeddings  # memory-mapped float32 for stored artifacts: never copied whole
        if getattr(emb, "ndim", None) != 2:
            raise PermanentJobError(f"feature_integrity: embeddings of slide {slide_id} are not 2-D")
        with session_scope() as db:
            art = db.get(FeatureArtifact, art_id) if art_id else None
            bad = _snapshot_mismatches(art, sf, snapshot)
            coverage = art.coverage_json if art is not None else None
        if bad:
            raise PermanentJobError(f"input_snapshot_mismatch for slide {slide_id}: the features were not built from "
                                    "the job's input snapshot: " + "; ".join(bad))
        features = _feature_identity(sf, emb)
        if emb.shape[0] == 0:
            reason = "no tissue patches after QC exclusions"
    mean = embedding_mean(emb) if (need_embedding and reason is None and emb is not None) else None
    if existing_dict is not None:
        if not _same_features(recorded, features):
            raise _stale_refusal(existing_dict["id"], recorded, features)
        return existing_dict, mean
    score = cal = pred = None
    abstained = False
    if reason is None:
        bag = Bag(bag_id=slide_id, kind="slide", slide_ids=[slide_id], case_id=None, patient_id="", patient_code=None,
                  label_value=None, label=None, label_version_ids=[], attributes={},
                  artifact_ids=[art_id] if art_id else [], embeddings=emb)
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
    record = {**snapshot, "schema": INPUT_SNAPSHOT_SCHEMA, "input_snapshot_sha256": snap_sha,
              "n_patches": features["n_patches"] if features else 0, "feature_artifact_id": art_id,
              "features": features}
    with session_scope() as db:
        p = InferencePrediction(project_id=content["project_id"], bundle_id=bundle_id, slide_id=slide_id,
                                slide_sha256=snapshot["slide_sha256"], feature_artifact_id=art_id,
                                job_id=getattr(ctx, "job_id", None), score=score, calibrated_score=cal,
                                threshold=float(content["threshold"]["value"]), predicted=pred,
                                abstained=bool(abstained), unscorable_reason=reason,
                                coverage_json=coverage, input_snapshot_json=record,
                                subject_scope=SUBJECT_SCOPE, input_snapshot_sha256=snap_sha,
                                provenance_status=PROVENANCE_COMPLETE, research_use_only=True,
                                created_by=created_by or audit.SYSTEM_WORKER)
        try:
            with db.begin_nested():
                db.add(p)
                db.flush()
        except IntegrityError:  # another worker recorded this (bundle, slide, snapshot) first: one row
            winner = _stored_prediction(db, bundle_id, slide_id, snap_sha)
            if winner is None:
                raise
            if not _same_features((winner.input_snapshot_json or {}).get("features"), features):
                raise _stale_refusal(winner.id, (winner.input_snapshot_json or {}).get("features"),
                                     features) from None
            return prediction_dict(winner, content), mean
        audit.record(db, action="inference.recorded", entity_type="inference_prediction", entity_id=p.id,
                     actor_id=audit.SYSTEM_WORKER, actor_role="system", project_id=content["project_id"],
                     after={"bundle_id": bundle_id, "slide_id": slide_id, "score": score, "abstained": bool(abstained),
                            "unscorable_reason": reason, "input_snapshot_sha256": snap_sha,
                            "provenance_status": PROVENANCE_COMPLETE, "research_use_only": True})
        if ctx is not None:
            ctx.assert_lease(db)
        return prediction_dict(p, content), mean


def infer_slide(bundle_id: str, slide_id: str, ctx=None, *, expected_input_snapshot_sha256: str | None = None) -> dict:
    """Score the slide's input as it is when the job runs. ``input_snapshot_sha256`` is the identity actually
    scored; ``requested_input_snapshot_sha256`` the one the request saw (they differ when the input changed while
    the job was queued: the request path then gives that identity a new job, see :func:`request_inference`)."""
    created_by = getattr(ctx, "created_by", None)
    pred, _ = score_slide(bundle_id, slide_id, ctx, created_by=created_by, need_embedding=False)
    out = {"bundle_id": bundle_id, "slide_id": slide_id, "inference_prediction_id": pred["id"],
           "input_snapshot_sha256": pred["input_snapshot_sha256"], "score": pred["score"],
           "abstained": pred["abstained"], "unscorable_reason": pred["unscorable_reason"]}
    if expected_input_snapshot_sha256 is not None:
        out["requested_input_snapshot_sha256"] = expected_input_snapshot_sha256
        out["input_changed_since_request"] = expected_input_snapshot_sha256 != pred["input_snapshot_sha256"]
    return out


@register(INFER_JOB, description="Label-free research inference of a registered bundle on one slide")
def infer_slide_job(ctx, payload: dict) -> dict:
    refuse_label_payload(payload)  # design §1 invariant 4
    bundle_id, slide_id = payload.get("bundle_id"), payload.get("slide_id")
    if not bundle_id or not slide_id:
        raise PermanentJobError("payload.bundle_id and payload.slide_id are required")
    return infer_slide(bundle_id, slide_id, ctx,
                       expected_input_snapshot_sha256=payload.get("expected_input_snapshot_sha256"))


def prediction_dict(p: InferencePrediction, content: dict) -> dict:
    classes = content.get("classes") or {}
    pos, neg = classes.get("positive_class"), classes.get("negative_class")
    predicted = None if p.predicted is None else (pos if p.predicted else neg)
    status = p.provenance_status or PROVENANCE_LEGACY
    verified = bool(status == PROVENANCE_COMPLETE and p.input_snapshot_sha256
                    and snapshot_sha256(p.input_snapshot_json or {}) == p.input_snapshot_sha256)
    label_scope = classes.get("label_scope")
    out = {"id": p.id, "bundle_id": p.bundle_id, "slide_id": p.slide_id, "slide_sha256": p.slide_sha256,
           "score": p.score, "calibrated_score": p.calibrated_score, "threshold": p.threshold,
           "predicted": p.predicted, "predicted_class": predicted,
           "predicted_display": LABEL_DISPLAY.get(predicted, predicted) if predicted else None,
           "abstained": bool(p.abstained), "unscorable_reason": p.unscorable_reason,
           "feature_artifact_id": p.feature_artifact_id, "coverage": p.coverage_json,
           "input_snapshot": p.input_snapshot_json, "input_snapshot_sha256": p.input_snapshot_sha256,
           "subject_scope": p.subject_scope or SUBJECT_SCOPE, "provenance_status": status,
           "snapshot_verified": verified, "reusable": verified and label_scope == SUBJECT_SCOPE,
           "job_id": p.job_id, "created_by": p.created_by,
           "created_at": p.created_at.isoformat() if p.created_at else None, "research_use_only": True,
           "is_label": False, "bag_scope": SUBJECT_SCOPE, "notice": PREDICTION_NOTICE}
    if status != PROVENANCE_COMPLETE:
        out["provenance_note"] = ("Recorded before inference passed one input snapshot to extraction: the stored "
                                  "snapshot may not be the extraction's input. Kept for history; never reused.")
    if label_scope != SUBJECT_SCOPE:
        out["scope_warning"] = (f"Historical row: a bundle trained on {label_scope!r} bags scored this single slide. "
                                "This is not a slide-level probability; such bundles are now refused.")
    return out


# Workers import dermpath.ml.inference (dermpath.ml.jobs ENGINE_HANDLER_MODULES); importing active learning here
# registers its ``active_learning`` job handler in the same worker process (it imports this module lazily).
from . import active_learning as _active_learning  # noqa: E402,F401
