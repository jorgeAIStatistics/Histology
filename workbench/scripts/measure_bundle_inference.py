#!/usr/bin/env python3
"""Real-WSI bundle inference measurement (owner brief item 5, last sentence). RESEARCH USE ONLY.

Not a medical device. The output is a technical resource measurement of the inference path on one real development
slide; it is never a diagnosis, never a label and never routed to care. No score, decision or label is recorded in
the measurement file.

What it does, only through the engine's public services as the research lead ``user-research-lead`` (the same
service calls and permission checks as ``POST /experiments/{id}/register`` and ``POST /bundles/{id}/infer``):

1. reads the PRE-DECLARED test candidate of the s3 report (``pre_declared_test_candidate.chosen.run_id``) and
   registers it: :func:`dermpath.ml.service.register_model` + :func:`dermpath.ml.inference.build_bundle`
   (idempotent per run). Registering a bundle is NOT a test release: no test prediction is made or read;
2. picks the LARGEST DEVELOPMENT slide of the run's frozen manifest (split ``train`` or ``val``; largest stored image
   in bytes, ties by level-0 pixel area). It stops before any write when the engine's test-material rule
   (:func:`dermpath.ml.inference.test_material_reason`) says the slide is test material, or when a test release /
   test access exists for the project. The engine refuses test slides anyway (``test_release_required``);
3. requests inference (:func:`dermpath.ml.inference.request_inference`) and runs the ``infer_slide`` job with an
   in-process worker (``dermpath.jobs.worker.Worker``, ``types=["infer_slide"]``), measuring wall time, the
   process's peak RSS (``getrusage``), the patch count and whether the slide's features came from the feature cache
   (the extraction call is observed, not changed; the feature-artifact row count is compared before and after);
4. reports separately the COLD extraction cost of the same slide from the s2 (and s4b) per-slide extraction
   records. A cached extraction makes inference fast; the cold cost comes from those records, not from this run.

It writes to the shared database only through those services (a model-version row, a bundle row and object, a job,
an ``inference_prediction`` row and their audit rows). Afterwards it verifies that no test release, no test access
audit row and no new sealed patient appeared.

Usage (from ``workbench/api``)::

    .venv/bin/python ../scripts/measure_bundle_inference.py \\
        --out ../experiments/reports/inference_measurement.json

Exit codes: 0 measured; 1 stopped by a safety check or the job failed (the reason is written to ``--out``); 2 usage.
"""

from __future__ import annotations

import argparse
import datetime as _dt
import hashlib
import json
import os
import platform
import sys
import time
from pathlib import Path

try:
    import resource as _resource
except ImportError:  # pragma: no cover - not on Windows
    _resource = None

SCRIPT = Path(__file__).resolve()
WORKBENCH = SCRIPT.parents[1]
API_DIR = WORKBENCH / "api"
REPORTS = WORKBENCH / "experiments" / "reports"
DEFAULT_VAR_DIR = WORKBENCH / "var"
DEFAULT_MIDNIGHT_WEIGHTS = DEFAULT_VAR_DIR / "models" / "midnight-12k"
LEAD_USER_ID = "user-research-lead"
INFER_JOB = "infer_slide"
SCHEMA = "dermpath.bundle_inference_measurement/1"
NOTICE = ("RESEARCH USE ONLY. Technical resource measurement; not a medical device, not a diagnosis, never a label, "
          "never routed to care. No score or decision is recorded here.")
REGISTER_NOTE = ("measure_bundle_inference.py: registration of the pre-declared s3 candidate for a development-slide "
                 "inference resource measurement (brief item 5); not a test release")


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def peak_rss_bytes() -> int | None:
    """getrusage maximum resident set size of this process so far (bytes; macOS reports bytes, Linux KiB)."""
    if _resource is None:
        return None
    v = _resource.getrusage(_resource.RUSAGE_SELF).ru_maxrss
    return int(v if sys.platform == "darwin" else v * 1024)


def now_iso() -> str:
    return _dt.datetime.now(_dt.timezone.utc).isoformat(timespec="seconds")


def per_slide(report: dict | None, path: tuple, slide_id: str) -> dict | None:
    x = report or {}
    for k in path:
        x = (x or {}).get(k) if isinstance(x, dict) else None
    for row in (x or {}).get("per_slide") or []:
        if row.get("slide_id") == slide_id:
            return {k: row.get(k) for k in ("status", "cache_hit", "n_candidates", "n_sampled", "n_patches",
                                            "read_seconds", "pixel_read_seconds", "embed_seconds", "write_seconds",
                                            "total_seconds", "patches_per_second", "artifact_id", "artifact_device",
                                            "artifact_precision", "artifact_bytes", "original_extraction")}
    return None


def aggregate(report: dict | None, path: tuple) -> dict | None:
    x = report or {}
    for k in path:
        x = (x or {}).get(k) if isinstance(x, dict) else None
    agg = (x or {}).get("aggregate") or {}
    fresh = agg.get("fresh") or {}
    return {"slides": agg.get("slides"), "fresh_extractions": agg.get("fresh_extractions"),
            "seconds_per_slide": fresh.get("seconds_per_slide"), "embed_patches_per_second":
                fresh.get("embed_patches_per_second"), "peak_rss_bytes_max": agg.get("peak_rss_bytes_max")} if agg \
        else None


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="measure_bundle_inference.py", description=__doc__.split("\n\n")[0],
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--var-dir", default=str(DEFAULT_VAR_DIR), help="workbench runtime directory (shared database)")
    p.add_argument("--reports-dir", default=str(REPORTS), help="the driver's reports (s2, s3, s4b)")
    p.add_argument("--out", required=True, help="measurement JSON (no patient identifiers, no scores)")
    p.add_argument("--timeout", type=float, default=3600.0, help="seconds to wait for the inference job")
    return p


def main(argv: list[str] | None = None) -> int:  # noqa: C901 - one linear procedure, kept readable
    args = build_parser().parse_args(argv)
    reports = Path(args.reports_dir).resolve()
    out_path = Path(args.out).resolve()
    s3_path, s2_path, s4b_path = reports / "s3.json", reports / "s2.json", reports / "s4b.json"
    if not s3_path.is_file() or not s2_path.is_file():
        print("error: s3.json and s2.json are required in --reports-dir", file=sys.stderr)
        return 2
    s3 = json.loads(s3_path.read_text())
    s2 = json.loads(s2_path.read_text())
    s4b = json.loads(s4b_path.read_text()) if s4b_path.is_file() else None
    chosen = ((s3.get("pre_declared_test_candidate") or {}).get("chosen") or {})
    run_id = chosen.get("run_id")
    if not run_id:
        print("error: the s3 report declares no test candidate", file=sys.stderr)
        return 2

    var_dir = Path(args.var_dir).resolve()
    os.environ["WB_VAR_DIR"] = str(var_dir)
    for k, v in {"HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1", "HF_HUB_DISABLE_TELEMETRY": "1"}.items():
        os.environ.setdefault(k, v)
    if not os.environ.get("WB_MIDNIGHT_WEIGHTS") and DEFAULT_MIDNIGHT_WEIGHTS.is_dir():
        os.environ["WB_MIDNIGHT_WEIGHTS"] = str(DEFAULT_MIDNIGHT_WEIGHTS.resolve())
    if str(API_DIR) not in sys.path:
        sys.path.insert(0, str(API_DIR))
    rss_start = peak_rss_bytes()
    t_import = time.perf_counter()

    from sqlalchemy import func, select

    from dermpath.auth import Actor, authorize
    from dermpath.config import Settings, set_settings
    from dermpath.db import init_db, session_scope
    from dermpath.errors import ApiError

    set_settings(Settings.from_env())
    init_db()
    import dermpath.ml.jobs  # noqa: F401 - registers the engine job handlers
    from dermpath.jobs.worker import Worker
    from dermpath.ml import feature_sets as fsm
    from dermpath.ml.artifacts import code_identity, dependency_versions
    from dermpath.ml.engine_models import InferenceBundle, InferencePrediction, TestRelease
    from dermpath.ml.inference import build_bundle, request_inference, test_material_reason
    from dermpath.ml.models import FeatureArtifact, ModelVersion, TrainingRun
    from dermpath.ml.service import register_model
    from dermpath.models import AuditEvent, DatasetVersion, Job, Slide, SplitFamilyAssignment, User

    import_seconds = time.perf_counter() - t_import
    report: dict = {"schema": SCHEMA, "research_use_only": True, "notice": NOTICE, "started_at": now_iso(),
                    "argv": sys.argv[1:], "script_sha256": sha256_file(SCRIPT),
                    "code": {k: code_identity().get(k) for k in ("code_revision", "code_tree_sha256", "dirty")},
                    "inputs": {"s3_report_sha256": sha256_file(s3_path), "s2_report_sha256": sha256_file(s2_path),
                               "s4b_report_sha256": sha256_file(s4b_path) if s4b else None},
                    "machine": {"platform": platform.platform(), "machine": platform.machine(),
                                "python": platform.python_version(), "cpu_count": os.cpu_count()},
                    "dependency_versions": dependency_versions()}

    def finish(rc: int, status: str, reason: str | None = None) -> int:
        report.update(status=status, stop_reason=reason, finished_at=now_iso())
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(json.dumps(report, indent=2, sort_keys=True, default=str) + "\n", encoding="utf-8")
        print(f"{status}: {reason or 'ok'} -> {out_path}", file=sys.stderr)
        return rc

    def safety_counts(db, project_id: str) -> dict:
        return {"test_releases": db.scalar(select(func.count()).select_from(TestRelease)
                                           .where(TestRelease.project_id == project_id)),
                "test_access_audit_rows": db.scalar(select(func.count()).select_from(AuditEvent).where(
                    AuditEvent.project_id == project_id, AuditEvent.action == "experiment.test_accessed")),
                "sealed_patients": db.scalar(select(func.count()).select_from(SplitFamilyAssignment)
                                             .where(SplitFamilyAssignment.sealed_at.is_not(None))),
                "inference_bundles": db.scalar(select(func.count()).select_from(InferenceBundle)
                                               .where(InferenceBundle.project_id == project_id)),
                "inference_predictions": db.scalar(select(func.count()).select_from(InferencePrediction)
                                                   .where(InferencePrediction.project_id == project_id)),
                "model_versions": db.scalar(select(func.count()).select_from(ModelVersion)
                                            .where(ModelVersion.project_id == project_id)),
                "feature_artifacts": db.scalar(select(func.count()).select_from(FeatureArtifact))}

    # ------------------------------------------------------------------------------------------ checks, no writes
    with session_scope() as db:
        u = db.get(User, LEAD_USER_ID)
        if u is None or u.role != "research_lead":
            return finish(1, "stopped", f"{LEAD_USER_ID} is missing or not a research lead on this database")
        actor = Actor(u.id, u.role, u.display_name)
        run = db.get(TrainingRun, run_id)
        if run is None or run.status != "succeeded":
            return finish(1, "stopped", f"the declared candidate run {run_id} is missing or not succeeded")
        project_id = run.project_id
        dv = db.get(DatasetVersion, run.dataset_version_id)
        manifest = dv.manifest_json or {}
        before = safety_counts(db, project_id)
        report["safety_before"] = before
        if before["test_releases"] or before["test_access_audit_rows"] or before["sealed_patients"]:
            return finish(1, "stopped", "a test release, test access or sealed patient already exists: this "
                                        "measurement only runs on a project whose test split was never looked at")
        other = db.scalar(select(func.count()).select_from(Job).where(Job.type == INFER_JOB,
                                                                       Job.status.in_(("queued", "running"))))
        if other:
            return finish(1, "stopped", f"{other} other {INFER_JOB} job(s) are queued or running; the in-process "
                                        "worker would run them too")
        dev_ids = sorted({it["slide_id"] for it in manifest.get("items", []) if it.get("split") in ("train", "val")})
        slides = [db.get(Slide, sid) for sid in dev_ids]
        slides = [s for s in slides if s is not None]
        slides.sort(key=lambda s: (-(s.bytes or 0), -((s.width or 0) * (s.height or 0)), s.id))
        slide = slides[0]
        by_area = sorted(slides, key=lambda s: -((s.width or 0) * (s.height or 0)))
        why = test_material_reason(db, run, slide)
        if why is not None:
            return finish(1, "stopped", f"the selected slide is test material ({why}); nothing was written")
        item_split = next(it.get("split") for it in manifest["items"] if it["slide_id"] == slide.id)
        report["candidate"] = {"rule": (s3.get("pre_declared_test_candidate") or {}).get("rule"),
                               "run_id": run.id, "encoder": run.encoder_id, "head": run.head,
                               "seed": run.seed, "checkpoint_sha256": run.checkpoint_sha256,
                               "feature_set_id": run.feature_set_id,
                               "matches_s3_declaration": (run.encoder_id, run.head) == (chosen.get("encoder"),
                                                                                       chosen.get("head"))}
        report["slide"] = {"slide_id": slide.id, "selection_rule": "largest stored image (bytes) among the "
                           "development slides (split train or val) of the run's frozen manifest; ties by level-0 "
                           "pixel area", "development_slides": len(slides), "manifest_split": item_split,
                           "bytes": slide.bytes, "width": slide.width, "height": slide.height, "levels": slide.levels,
                           "format": slide.format, "mpp_x": slide.mpp_x, "mpp_y": slide.mpp_y,
                           "rank_by_pixel_area": 1 + [s.id for s in by_area].index(slide.id),
                           "test_material_check": "not test material (engine rule test_material_reason)",
                           "labels_read": False}

    # ------------------------------------------------------------------------------------------ register (public)
    t0 = time.perf_counter()
    try:
        with session_scope() as db:
            authorize(db, actor, project_id, "model.register")
            run = db.get(TrainingRun, run_id)
            mv, mv_created = register_model(db, actor, run, note=REGISTER_NOTE)
            bundle, b_created, unavailable = build_bundle(db, actor, run)
            if bundle is None:
                raise RuntimeError(f"no inference bundle: {unavailable}")
            reg = {"model_version_id": mv.id, "model_status": mv.status, "model_created": mv_created,
                   "bundle_id": bundle.id, "bundle_sha256": bundle.bundle_sha256, "bundle_created": b_created,
                   "bundle_label_scope": ((bundle.content_json or {}).get("classes") or {}).get("label_scope"),
                   "extraction_device": (((bundle.content_json or {}).get("extraction_env") or {})
                                         .get("device_class")),
                   "precision": (((bundle.content_json or {}).get("extraction_env") or {}).get("precision"))}
            bundle_id = bundle.id
    except (ApiError, RuntimeError) as exc:
        return finish(1, "stopped", f"registration refused: {exc}")
    reg["wall_seconds"] = round(time.perf_counter() - t0, 4)
    report["registration"] = reg

    # ------------------------------------------------------------------------------------------ request (public)
    t0 = time.perf_counter()
    try:
        with session_scope() as db:
            authorize(db, actor, project_id, "experiment.write")
            b = db.get(InferenceBundle, bundle_id)
            job, created = request_inference(db, actor, b, slide.id)
            job_id, job_status = job.id, job.status
    except ApiError as exc:
        return finish(1, "stopped", f"inference request refused by the engine: {exc}")
    report["request"] = {"job_id": job_id, "job_created": created, "job_status_at_request": job_status,
                         "wall_seconds": round(time.perf_counter() - t0, 4)}
    if not created or job_status != "queued":
        return finish(1, "stopped", f"the inference job already existed ({job_status}): a repeated request reuses "
                                    "the stored prediction, so it is not a fresh measurement")

    # ------------------------------------------------------------------------------------------ in-process worker
    observed: list[dict] = []
    real_extract = fsm.extract_slide

    def observing_extract(*a, **k):  # observes the engine's extraction call; the call itself is unchanged
        t = time.perf_counter()
        sf = real_extract(*a, **k)
        observed.append({"cache_hit": bool(getattr(sf, "cache_hit", False)), "n_patches": getattr(sf, "n_patches",
                                                                                                    None),
                         "artifact_id": getattr(sf, "artifact_id", None), "seconds": round(time.perf_counter() - t, 4),
                         "stats": {k2: v for k2, v in (getattr(sf, "stats", None) or {}).items()
                                   if isinstance(v, (int, float, bool, str)) or v is None}})
        return sf

    real_load = fsm.load_encoder
    loads: list[dict] = []

    def observing_load(*a, **k):  # observes the encoder load extract_slide performs (before its cache lookup)
        t, r0 = time.perf_counter(), peak_rss_bytes()
        loaded = real_load(*a, **k)
        loads.append({"seconds": round(time.perf_counter() - t, 4), "peak_rss_before": r0,
                      "peak_rss_after": peak_rss_bytes(), "device": k.get("device"), "precision": k.get("precision"),
                      "weights_sha256_verified": getattr(loaded, "weights_sha256", None) == k.get("weights_sha256")})
        return loaded

    fsm.extract_slide = observing_extract
    fsm.load_encoder = observing_load
    rss_before_job = peak_rss_bytes()
    worker = Worker(f"measure-inference-{os.getpid()}", record_heartbeat=False, types=[INFER_JOB])
    t0 = time.perf_counter()
    outcomes = []
    try:
        while True:
            with session_scope() as db:
                j = db.get(Job, job_id)
                status = j.status
            if status not in ("queued", "running"):
                break
            if time.perf_counter() - t0 > args.timeout:
                return finish(1, "stopped", f"the inference job did not finish within {args.timeout}s")
            o = worker.run_once()
            if o is not None:
                outcomes.append({"job_id": o.job_id, "type": o.type, "status": o.status})
            else:
                time.sleep(0.5)
    finally:
        fsm.extract_slide = real_extract
        fsm.load_encoder = real_load
    worker_wall = time.perf_counter() - t0
    rss_after_job = peak_rss_bytes()

    # ------------------------------------------------------------------------------------------ results
    with session_scope() as db:
        j = db.get(Job, job_id)
        pred = db.scalars(select(InferencePrediction).where(InferencePrediction.bundle_id == bundle_id,
                                                            InferencePrediction.slide_id == slide.id)
                          .order_by(InferencePrediction.created_at.desc())).first()
        after = safety_counts(db, project_id)
        snap = (pred.input_snapshot_json or {}) if pred is not None else {}
        feats = snap.get("features") or {}
        result = {"job_status": j.status, "job_attempts": j.attempts, "job_error": j.error,
                  "job_seconds_recorded": ((j.finished_at - j.started_at).total_seconds()
                                           if j.finished_at and j.started_at else None),
                  "worker_wall_seconds": round(worker_wall, 4), "jobs_run_by_worker": outcomes,
                  "prediction_recorded": pred is not None,
                  "scored": bool(pred is not None and pred.score is not None and not pred.unscorable_reason),
                  "unscorable_reason": pred.unscorable_reason if pred is not None else None,
                  "provenance_status": pred.provenance_status if pred is not None else None,
                  "patch_count": snap.get("n_patches", feats.get("n_patches")),
                  "embedding_dim": feats.get("embedding_dim"),
                  "feature_artifact_id": pred.feature_artifact_id if pred is not None else None}
    s2_rec = per_slide(s2, ("encoders", "midnight-12k", "feature_set"), slide.id)
    s4b_rec = per_slide(s4b, ("encoders", "midnight-12k", "feature_set", "feature_set"), slide.id)
    hc_rec = per_slide(s2, ("encoders", "handcrafted-stain-texture-v1", "feature_set"), slide.id)
    obs = observed[-1] if observed else {}
    cache_hit = obs.get("cache_hit")
    new_artifacts = (after["feature_artifacts"] or 0) - (before["feature_artifacts"] or 0)
    result.update({
        "features_cache_hit": cache_hit,
        "features_cache_hit_evidence": {
            "extraction_call_reported_cache_hit": cache_hit,
            "new_feature_artifact_rows": new_artifacts,
            "same_artifact_as_s2_extraction_record": (s2_rec or {}).get("artifact_id") == result["feature_artifact_id"]
            if s2_rec else None},
        "extraction_call": obs,
        "encoder_load_calls": loads,
        "time_breakdown_seconds": {
            "worker_job_wall": round(worker_wall, 4),
            "extraction_call": obs.get("seconds"),
            "encoder_load_inside_extraction": round(sum(x["seconds"] for x in loads), 4) if loads else 0.0,
            "plan_and_cache_lookup_inside_extraction": (obs.get("stats") or {}).get("total_seconds")
            if cache_hit else None,
            "rest_of_job (bundle, snapshot and object verification, scoring, recording)":
                round(worker_wall - (obs.get("seconds") or 0.0), 4)},
        "peak_rss_bytes": {"process_at_start": rss_start, "after_engine_import": rss_before_job,
                           "after_inference_job": rss_after_job,
                           "delta_during_job": (rss_after_job - rss_before_job)
                           if rss_after_job is not None and rss_before_job is not None else None,
                           "note": "getrusage maximum resident set size of this process (monotonic high-water mark; "
                                   "includes the engine import and everything loaded before the job)"},
        "engine_import_seconds": round(import_seconds, 3)})
    report["measurement"] = result
    report["cold_extraction_from_records"] = {
        "source": "per-slide extraction records of the driver's reports for THIS slide (not measured by this script)",
        "midnight_spatial_256_s2": s2_rec, "midnight_spatial_512_s4b": s4b_rec,
        "handcrafted_spatial_256_s2": hc_rec,
        "midnight_s2_aggregate": aggregate(s2, ("encoders", "midnight-12k", "feature_set")),
        "device": s2.get("midnight_device"),
        "note": "total_seconds = read + embed + write of the first (cold) extraction on the recorded device; the "
                "bundle pins the s3 feature set, whose artifacts are the s2 Midnight artifacts (spatial sampling, "
                "256 patches, stain none, fp32)"}
    report["labels"] = [
        ("A CACHED extraction makes this inference fast: the slide's Midnight-12k features were already in the "
         "content-addressed feature cache (built by s2), so the measured wall time covers bundle and snapshot "
         "verification, the sampling plan and cache lookup, loading the stored embeddings and ABMIL scoring, and no "
         "patch embedding (encoder compute).")
        if cache_hit else
        ("The features were NOT served from the cache: the measured wall time includes a cold extraction."),
        "The COLD cost of a new slide (reading the patches and running the encoder) comes from the per-slide "
        "extraction records above (s2 at 256 patches; s4b at 512), not from this run.",
        *([f"Even on this cache hit the engine loaded the encoder before its cache lookup "
           f"(dermpath.ml.feature_sets.extract_slide calls load_encoder first): {sum(x['seconds'] for x in loads):.1f} s "
           f"of the {worker_wall:.1f} s job, and the process peak RSS rose from {loads[0]['peak_rss_before']} to "
           f"{loads[-1]['peak_rss_after']} bytes during the load. The cache lookup itself took "
           f"{(obs.get('stats') or {}).get('total_seconds')} s."] if cache_hit and loads else []),
        "One slide, one run: a resource measurement, not a throughput benchmark; peak RSS is the process "
        "high-water mark.",
        "The slide is a development slide the final model was fitted on: no score is reported, and none would be a "
        "performance estimate.",
    ]
    report["safety_after"] = after
    breach = [k for k in ("test_releases", "test_access_audit_rows", "sealed_patients") if after[k] != before[k]]
    report["test_safety"] = {"test_release_created": False if not breach else None, "breaches": breach,
                             "statement": "registering a bundle is not a test release; the slide is development "
                                          "material; no test prediction was made or read"}
    if breach:
        return finish(1, "failed", f"safety counters changed: {breach}")
    if result["job_status"] != "succeeded":
        return finish(1, "failed", f"the inference job ended {result['job_status']}: {result['job_error']}")
    return finish(0, "measured")


if __name__ == "__main__":
    raise SystemExit(main())
