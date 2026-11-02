"""Demo ML records: clearly SYNTHETIC pipeline tests, so the UI has real records to show.

``python -m dermpath.ml.seed_demo`` (or automatically at the end of ``dermpath.seed``).

Every run uses ``execution_mode = synthetic_pipeline_test`` (the only mode in which the
synthetic encoder and its label-derived fixture signal are allowed, design §1) and a pinned
feature set built label-free except for the fixture signal derived inside ``feature_sets``
from the frozen manifest through ``fixture.py``.

1. Workflow demo project (``proj-bcc-demo``): freezes "Workflow demo slides — pipeline test"
   from the approved synthetic slides (if no such version exists) and runs ONE experiment
   per head with ``synthetic-deterministic-v1`` through the real path (QC tissue mask or
   Otsu fallback → patches read from the procedural tiles → synthetic embeddings). With 4
   patients, validation and test hold one patient each, so most metrics are honestly
   undefined or "insufficient evidence" (the threshold is a recorded fallback); that is the
   point of showing it.
2. A SEPARATE project, "Synthetic pipeline-test cohort (no images, no histology)": 60
   fictional coded patients whose slide records are generator specs only (never ingested,
   no thumbnails, no pixels read; coordinates from a grid). Fixture labels are recorded by
   the seeded fictional pathologist with an explicit reason. One experiment per head runs on
   it so metrics, CIs, calibration and subgroups have enough items to be exercised.
   It is never mixed with the workflow-demo slides.

Everything here is a PIPELINE TEST — NOT PATHOLOGY VALIDATION.
"""

from __future__ import annotations

import json
import logging
import random
import time
from datetime import date, timedelta

from sqlalchemy import select

from ..auth import Actor
from ..db import init_db, session_scope, utcnow
from ..models import Block, Case, CodedPatient, DatasetVersion, Project, ProjectMember, Slide, SpecimenPart
from ..slides.synthetic import SyntheticSlide, make_spec, spec_sha256
from ..storage import get_store, slide_key
from . import PIPELINE_TEST_BANNER
from .encoders import SYNTHETIC_ID
from .models import TrainingRun

log = logging.getLogger("dermpath.ml.seed_demo")

WORKFLOW_PROJECT_ID = "proj-bcc-demo"
COHORT_PROJECT_ID = "proj-synthetic-cohort"
WORKFLOW_DATASET_NAME = "Workflow demo slides — pipeline test (synthetic)"
COHORT_DATASET_NAME = "Synthetic pipeline-test cohort (no images, no histology)"
COHORT_PATIENTS = 60
COHORT_MEMBERS = ("user-assistant", "user-pathologist", "user-research-lead", "user-director", "user-admin")
FIXTURE_REASON = "synthetic pipeline-test fixture label (fictional; not a diagnosis; no histology exists)"
COHORT_PROCESSING = "pipeline-test-cohort/1 (metadata from the generator spec; not ingested; no thumbnail)"

LEAD = Actor("user-research-lead", "research_lead", "Priya Navarro")
PATHOLOGIST = Actor("user-pathologist", "pathologist", "Dr. Imani Castell")
ASSISTANT = Actor("user-assistant", "histology_assistant", "Sam Rivera")

WORKFLOW_PARAMS = {"max_patches_per_slide": 24, "n_boot": 200, "pixel_mode": "read", "max_epochs": 30,
                   "patience": 6}
# The cohort's validation split holds 6 positive and 6 negative patients: below the default
# minimum evidence (10 per class) the threshold would be a recorded fallback. This pipeline test
# prespecifies 5 so the selected-threshold path is exercised (recorded in the run's params).
COHORT_PARAMS = {"max_patches_per_slide": 32, "n_boot": 500, "pixel_mode": "none", "max_epochs": 40, "patience": 8,
                 "min_threshold_evidence": 5}
DEMO_SEED = 7
DEMO_MODE = "synthetic_pipeline_test"
JOB_TYPES = ["build_feature_set", "train"]


def _freeze_dataset(db, project: Project, name: str, config: dict) -> DatasetVersion:
    from ..datasets import create_draft, freeze

    existing = db.scalars(select(DatasetVersion).where(DatasetVersion.project_id == project.id,
                                                       DatasetVersion.name == name,
                                                       DatasetVersion.status == "frozen")).first()
    if existing is not None:
        return existing
    dv = create_draft(db, LEAD, project, name=name, config=config,
                      reason="pipeline-test dataset for the ML demo (synthetic)")
    # The demo slides deliberately carry open QC issues at every lifecycle stage; a research lead freezing this
    # version acknowledges them with a reason, and they are written into the manifest (never hidden).
    freeze(db, LEAD, dv, acknowledge_warnings=True,
           reason="frozen for synthetic pipeline-test experiments; open QC issues on the demo slides acknowledged")
    return dv


def _experiments(db, project: Project, dv: DatasetVersion, params: dict, label: str) -> dict[str, str]:
    from .service import create_experiment

    out = {}
    for head in ("meanpool_logreg", "abmil"):
        existing = db.scalars(select(TrainingRun).where(TrainingRun.dataset_version_id == dv.id,
                                                        TrainingRun.head == head,
                                                        TrainingRun.encoder_id == SYNTHETIC_ID)).first()
        if existing is not None:
            out[head] = existing.id
            continue
        run, _ = create_experiment(db, LEAD, project, dataset_version_id=dv.id, encoder_id=SYNTHETIC_ID, head=head,
                                   params=params, seed=DEMO_SEED, name=f"{label} · {head} (PIPELINE TEST)",
                                   execution_mode=DEMO_MODE, evaluation_protocol="holdout")
        out[head] = run.id
    return out


def _cohort_project(db) -> Project:
    from ..seed import TASK_TEMPLATE

    project = db.get(Project, COHORT_PROJECT_ID)
    if project is not None:
        return project
    project = Project(id=COHORT_PROJECT_ID, name=COHORT_DATASET_NAME,
                      description=("Fictional synthetic pipeline-test cohort: 60 coded patients whose slide records are "
                                   "procedural generator specs. The ML pipeline never reads their pixels (synthetic "
                                   "embeddings on a coordinate grid). Labels are fixture labels, not diagnoses. "
                                   "Exists only to exercise metrics, confidence intervals, calibration and subgroups. "
                                   + PIPELINE_TEST_BANNER),
                      task_template_json=TASK_TEMPLATE,
                      settings_json={"independent_review": False, "synthetic_pipeline_test_cohort": True},
                      demo_seeded=True)
    db.add(project)
    db.flush()
    for uid in COHORT_MEMBERS:
        db.add(ProjectMember(project_id=project.id, user_id=uid, added_by="system:seed"))
    db.flush()
    rng = random.Random(2026)
    sites = ["site-north", "site-south", "site-east"]
    store = get_store()
    from ..labels import create_expert_label
    from ..review import set_review_state

    slides: list[tuple[Slide, str]] = []
    for i in range(1, COHORT_PATIENTS + 1):
        # Deterministic ids: patient-grouped splits order patients by id, so reseeding reproduces them.
        patient = CodedPatient(id=f"synpt{i:04d}", project_id=project.id, code=f"SYN-{i:04d}", created_by="system:seed")
        db.add(patient)
        db.flush()
        site = rng.choices(sites, weights=[0.5, 0.3, 0.2])[0]
        case = Case(id=f"syncase{i:04d}", project_id=project.id, coded_patient_id=patient.id,
                    accession_code=f"SYN-C26-{i:04d}",
                    collected_on=date(2026, 1, 5) + timedelta(days=rng.randint(0, 270)), site_id=site,
                    provenance="demo_synthetic", created_by="system:seed",
                    note="Synthetic pipeline-test cohort record (fictional; no images are used, no histology).")
        db.add(case)
        db.flush()
        scanner = rng.choice(["scanner-a", "scanner-a", "scanner-b"])
        for designation in (["A", "B"] if rng.random() < 0.35 else ["A"]):
            part = SpecimenPart(project_id=project.id, case_id=case.id, designation=designation,
                                anatomic_site_text="synthetic fixture (fictional)")
            db.add(part)
            db.flush()
            block = Block(project_id=project.id, part_id=part.id, designation=f"{designation}1")
            db.add(block)
            db.flush()
            value = "bcc_present" if rng.random() < 0.45 else "bcc_absent_not_benign"
            for level in range(1, (2 if rng.random() < 0.4 else 1) + 1):
                spec = make_spec(100000 + len(slides), width=8192, height=6144, downsamples=(1, 4, 16, 64))
                spec["purpose"] = "synthetic pipeline-test cohort record; the ML pipeline never reads its pixels"
                synth = SyntheticSlide(spec)
                sid = f"synslide{len(slides):05d}"
                key = slide_key(project.id, sid, "synthetic_spec.json")
                store.put_bytes(key, json.dumps(spec, sort_keys=True).encode())
                s = Slide(id=sid, project_id=project.id, block_id=block.id, level_index=level,
                          stain="PAS" if rng.random() < 0.1 else "H&E", scanner_id=scanner,
                          provenance="demo_synthetic", image_kind="synthetic_tiles", object_key=key,
                          sha256=spec_sha256(spec), bytes=None, format="synthetic_procedural",
                          vendor="dermpath-synthetic", width=synth.dimensions[0], height=synth.dimensions[1],
                          levels=synth.level_count, level_dimensions_json=[list(d) for d in synth.level_dimensions],
                          level_downsamples_json=list(synth.level_downsamples), mpp_x=None, mpp_y=None,
                          synthetic_spec_json=spec, ingest_status="succeeded", ingested_at=utcnow(),
                          processing_version=COHORT_PROCESSING, created_by="system:seed")
                db.add(s)
                slides.append((s, value))
    db.flush()
    for s, value in slides:
        set_review_state(db, ASSISTANT, s, "pending_review", reason="routed for fixture labelling (synthetic cohort)")
        create_expert_label(db, PATHOLOGIST, s, scope="slide", target_id=None, value=value, reason=FIXTURE_REASON)
        set_review_state(db, PATHOLOGIST, s, "approved", reason=None)
    return project


def seed_ml_demo() -> dict:
    """Idempotent. Returns a summary; never raises (failures are reported in the summary)."""
    t0 = time.perf_counter()
    summary: dict = {}
    try:
        return _seed(t0, summary)
    except Exception as exc:  # the core demo must still start; the failure (and what exists) is visible
        log.exception("ML demo seeding failed")
        return {**summary, "status": "failed", "error": f"{type(exc).__name__}: {exc}",
                "seconds": round(time.perf_counter() - t0, 2)}


WORKFLOW_CONFIG = {
    "label_scope": "slide", "eligible_review_states": ["approved"], "include_provenance": ["demo_synthetic"],
    "label_values": ["bcc_present", "bcc_absent_not_benign"],
    "split": {"partition": "random", "seed": 3, "ratios": {"train": 0.6, "val": 0.2, "test": 0.2}}}
COHORT_CONFIG = {
    "label_scope": "slide", "eligible_review_states": ["approved"], "include_provenance": ["demo_synthetic"],
    "label_values": ["bcc_present", "bcc_absent_not_benign"],
    "split": {"partition": "random", "seed": 11, "ratios": {"train": 0.6, "val": 0.2, "test": 0.2}}}


def _seed(t0: float, summary: dict) -> dict:
    from ..jobs.worker import Worker

    init_db()
    summary.update({"banner": PIPELINE_TEST_BANNER, "encoder_id": SYNTHETIC_ID, "execution_mode": DEMO_MODE})
    # Datasets are frozen in their own transactions first, so they exist (and are reported) even
    # if experiment creation fails afterwards.
    with session_scope() as db:
        project = db.get(Project, WORKFLOW_PROJECT_ID)
        if project is None:
            raise RuntimeError("the core demo seed has not run (no workflow project)")
        dv_id = _freeze_dataset(db, project, WORKFLOW_DATASET_NAME, WORKFLOW_CONFIG).id
    summary["workflow"] = {"project_id": WORKFLOW_PROJECT_ID, "dataset_version_id": dv_id, "runs": {}}
    t_cohort = time.perf_counter()
    with session_scope() as db:
        _cohort_project(db)
    with session_scope() as db:
        cdv_id = _freeze_dataset(db, db.get(Project, COHORT_PROJECT_ID), COHORT_DATASET_NAME, COHORT_CONFIG).id
    summary["cohort"] = {"project_id": COHORT_PROJECT_ID, "dataset_version_id": cdv_id, "runs": {}}
    summary["cohort_build_seconds"] = round(time.perf_counter() - t_cohort, 2)
    for group, pid, dvid, params, label in (
            ("workflow", WORKFLOW_PROJECT_ID, dv_id, WORKFLOW_PARAMS, "Workflow demo slides"),
            ("cohort", COHORT_PROJECT_ID, cdv_id, COHORT_PARAMS, "Synthetic cohort")):
        with session_scope() as db:
            runs = _experiments(db, db.get(Project, pid), db.get(DatasetVersion, dvid), params, label)
            summary[group]["runs"] = runs
            summary[group]["feature_set_ids"] = sorted({db.get(TrainingRun, r).feature_set_id for r in runs.values()})
    outcomes = Worker("seed-in-process-ml", record_heartbeat=False, types=JOB_TYPES).run_until_idle()
    summary["jobs"] = [{"type": o.type, "status": o.status, "error": o.error} for o in outcomes]
    with session_scope() as db:
        statuses = {}
        for group in ("workflow", "cohort"):
            for head, rid in summary[group]["runs"].items():
                r = db.get(TrainingRun, rid)
                statuses[f"{group}:{head}"] = {"status": r.status, "error": r.error,
                                               "execution_mode": r.execution_mode,
                                               "feature_set_id": r.feature_set_id,
                                               "timings_seconds": (r.metrics_json or {}).get("timings_seconds")}
    summary["runs"] = statuses
    states = {v["status"] for v in statuses.values()}
    # "pending": a separate worker process claimed a job first and is still running it.
    summary["status"] = ("succeeded" if states == {"succeeded"} else
                         "failed" if states & {"failed", "canceled"} else "pending")
    summary["seconds"] = round(time.perf_counter() - t0, 2)
    return summary


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    out = seed_ml_demo()
    print(json.dumps(out, indent=2, default=str))
    return 0 if out.get("status") == "succeeded" else 1


if __name__ == "__main__":
    raise SystemExit(main())
