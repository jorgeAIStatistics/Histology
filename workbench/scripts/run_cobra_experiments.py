#!/usr/bin/env python3
"""COBRA BCC subset experiment driver for the DermPath Research Workbench ML engine. RESEARCH USE ONLY.

Not a medical device. Outputs are research measurements, never diagnoses, never labels, and never routed to care.
The COBRA subset is CC BY-NC-SA 4.0 (non-commercial); its labels are report-derived imported reference labels.

Staged, checkpointed and reproducible. Every stage writes ``<reports-dir>/<stage>.json`` (default
``workbench/experiments/reports``) and is skipped on a re-run when its report exists, unless ``--force <stage>``
(a forced stage's previous report is archived under ``<reports-dir>/_superseded/``). Every report records the code
identity, the dependency versions, the driver's own sha256 and the command line. The driver only calls the engine's
public services (dataset, feature-set, experiment, comparison, registry and test-release services) as the research
lead ``user-research-lead``, with the same permission checks as the HTTP routers, and runs the engine's jobs with an
in-process worker. It never modifies ``dermpath/`` code or rows directly.

Stages
------
s0  environment: machine, devices, code identity, dependency versions, encoder status (describe-encoders).
s1  dataset: create and freeze ONE dataset version of ``proj-cobra-bcc-subset`` (slide scope, imported_reference,
    public_licensed, bcc_present / bcc_absent_not_benign, patient-grouped stratified random split, seed 20261027,
    ratios train 0.7 / val 0.0 / test 0.3: the development pool is train ∪ val). Freeze warnings are acknowledged
    only with ``--freeze-ack-reason`` (recorded in the manifest).
s2  technical validation (real_image_technical, no labels): one feature set per encoder with an identical policy,
    built for every slide; determinism job; coverage; timings; storage; cache reuse.
s3  supervised baselines (dev_cv, patient-grouped stratified folds; the test split is untouched): {handcrafted,
    midnight-12k} x {meanpool_logreg, abmil}, learning curves for meanpool_logreg, paired OOF comparisons, and the
    PRE-DECLARED test candidate (rule and choice written into s3.json before any test access).
s4  ablations (paired OOF comparisons, meanpool_logreg): sampling uniform vs spatial, stain macenko-v1 vs none,
    midnight fp16 / bf16 vs fp32 (devices.compare_precision; downstream fp16 only if accepted).
s5  resources: throughput, memory, seconds and storage per slide, cache speedup; cost only as a formula of compute
    seconds x a user-supplied hourly rate (``--hourly-rate``); prices are never invented.
s6  ONE pre-declared test release of the s3 candidate (registered bundle). A second run needs ``--force s6`` AND
    ``--justification``.
s7  failure analysis: OOF error taxonomy of every s3 run, test errors of the candidate (from s6, no new test
    access), learning-curve slopes, dominant error categories.
s8  summary.json linking every stage, the key numbers, every caveat and the elapsed time per stage.

Usage (from ``workbench/api``)::

    .venv/bin/python ../scripts/run_cobra_experiments.py --device mps
    .venv/bin/python ../scripts/run_cobra_experiments.py --only s3,s4 --force s4
    .venv/bin/python ../scripts/run_cobra_experiments.py --var-dir /tmp/dryrun/var --dry-run-subset 6 \\
        --skip-precision-downstream
    .venv/bin/python ../scripts/run_cobra_experiments.py --status

Exit codes: 0 every requested stage succeeded (or was skipped), 1 a stage failed (its traceback is written to
``<reports-dir>/_state/<stage>.error.json``), 2 invalid usage.
"""

from __future__ import annotations

import argparse
import datetime as _dt
import gc
import hashlib
import json
import math
import os
import platform
import statistics
import sys
import threading
import time
import traceback
from pathlib import Path

SCRIPT = Path(__file__).resolve()
WORKBENCH = SCRIPT.parents[1]
API_DIR = WORKBENCH / "api"
DEFAULT_VAR_DIR = WORKBENCH / "var"
DEFAULT_REPORTS_DIR = WORKBENCH / "experiments" / "reports"
BASELINE_CONFIG = WORKBENCH / "experiments" / "configs" / "cobra_supervised_baseline.json"
DEFAULT_MIDNIGHT_WEIGHTS = DEFAULT_VAR_DIR / "models" / "midnight-12k"

REPORT_SCHEMA = "dermpath.cobra_experiments/1"
PROJECT_ID = "proj-cobra-bcc-subset"
LEAD_USER_ID = "user-research-lead"
HANDCRAFTED = "handcrafted-stain-texture-v1"
MIDNIGHT = "midnight-12k"
ENCODERS = (HANDCRAFTED, MIDNIGHT)
HEADS = ("meanpool_logreg", "abmil")
TECHNICAL = "real_image_technical"
SUPERVISED = "supervised_experiment"
POSITIVE = "bcc_present"
NEGATIVE = "bcc_absent_not_benign"
SPLIT_SEED = 20261027
SPLIT_RATIOS = {"train": 0.7, "val": 0.0, "test": 0.3}
DATASET_NAME = "COBRA BCC benchmark (run_cobra_experiments)"
ELIGIBLE_REVIEW_STATES = ["approved", "imported"]
SEED = 0
PRECISION_SEED = 20261027

STAGES = ("s0", "s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8")
TITLES = {
    "s0": "environment",
    "s1": "dataset version (create and freeze once)",
    "s2": "technical validation (real_image_technical, no labels)",
    "s3": "supervised baselines (dev_cv; test untouched) and the pre-declared test candidate",
    "s4": "ablations (paired out-of-fold comparisons)",
    "s5": "resources",
    "s6": "one pre-declared test release",
    "s7": "failure analysis",
    "s8": "summary",
}
REQUIRES = {"s0": (), "s1": (), "s2": ("s1",), "s3": ("s1", "s2"), "s4": ("s1", "s3"), "s5": ("s2",),
            "s6": ("s1", "s3"), "s7": ("s1", "s3"), "s8": ()}

NOTICE = ("Research use only. Not a medical device; outputs are not diagnoses, never become labels and are never "
          "routed to care. COBRA labels are report-derived imported reference labels (not expert reads in this "
          "workbench): metrics measure agreement with that reference, not clinical performance.")
CANDIDATE_RULE = ("the encoder x head combination with the highest out-of-fold AUROC point estimate in S3; ties "
                  "resolved toward meanpool_logreg, then handcrafted")
RELEASE_REASON = "pre-declared final candidate of the COBRA baseline benchmark (rule recorded in s3 report)"
CAVEATS = [
    "Labels are imported reference labels extracted from free-text pathology reports by COBRA's rule-based method, "
    "not expert reads in this workbench; a report-level diagnosis may have been copied to a slide that does not "
    "show the lesion. Every metric measures agreement with that reference standard, not clinical performance.",
    "Single site (Radboudumc) and a single scanner model (3DHistech Pannoramic 1000): no site or scanner shift can "
    "be measured; results may not transfer to other laboratories, stains or scanners.",
    "Small cohort (about 50 patients, 60 slides): confidence intervals are wide; a ~30 % patient test split holds "
    "only about 15 patients.",
    "Enriched prevalence (about half BCC by construction of the subset): PPV and NPV are stated at the evaluation "
    "prevalence and do not transfer to a clinical population.",
    "Non-commercial licence (CC BY-NC-SA 4.0); whether trained weights are ShareAlike adaptations is unsettled; legal "
    "review is needed before any commercial use.",
    "Research use only: not a medical device, not a diagnosis, never routed to care; 'BCC absent' is not 'benign'.",
    "handcrafted-stain-texture-v1 is a technical baseline, not a pathology foundation model.",
    "Threshold (Youden), Platt calibration and abstention were selected on out-of-fold predictions; threshold-"
    "dependent OOF metrics are optimistic (tuning set). Calibration fitted on pooled OOF scores is applied to the "
    "refitted final model (an approximation).",
    "No winner is declared from development comparisons; the single test release evaluates a candidate chosen by a "
    "rule written before any test access.",
]


class StageError(RuntimeError):
    """A stage cannot continue; ``details`` go into the error file."""

    def __init__(self, message: str, **details):
        super().__init__(message)
        self.details = details


# =================================================================================================== helpers


def now_iso() -> str:
    return _dt.datetime.now(_dt.timezone.utc).isoformat(timespec="seconds")


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def jsonable(obj):
    """JSON-safe copy (numpy scalars, NaN -> None, sets -> sorted lists, datetimes -> ISO)."""
    try:
        import numpy as np
    except ImportError:  # pragma: no cover
        np = None
    if isinstance(obj, dict):
        return {str(k): jsonable(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [jsonable(v) for v in obj]
    if isinstance(obj, (set, frozenset)):
        return sorted(jsonable(v) for v in obj)
    if isinstance(obj, float):
        return obj if math.isfinite(obj) else None
    if isinstance(obj, (_dt.datetime, _dt.date)):
        return obj.isoformat()
    if isinstance(obj, Path):
        return str(obj)
    if np is not None:
        if isinstance(obj, np.integer):
            return int(obj)
        if isinstance(obj, np.floating):
            v = float(obj)
            return v if math.isfinite(v) else None
        if isinstance(obj, np.bool_):
            return bool(obj)
        if isinstance(obj, np.ndarray):
            return jsonable(obj.tolist())
    return obj


def stats(values) -> dict | None:
    vals = [float(v) for v in values if v is not None and isinstance(v, (int, float)) and math.isfinite(float(v))]
    if not vals:
        return None
    return {"n": len(vals), "min": min(vals), "median": statistics.median(vals), "mean": statistics.fmean(vals),
            "max": max(vals), "sum": sum(vals)}


def ratio(a, b):
    try:
        return float(a) / float(b) if a is not None and b not in (None, 0) and float(b) > 0 else None
    except (TypeError, ValueError):
        return None


def metric_entry(entry: dict | None) -> dict | None:
    if not entry:
        return None
    return {k: entry.get(k) for k in ("value", "ci", "ci_reason", "numerator", "denominator", "undefined_reason",
                                      "evaluation_prevalence", "tuning_set") if k in entry}


def parse_stage_list(values) -> list[str]:
    out: list[str] = []
    for v in values or []:
        for part in str(v).split(","):
            part = part.strip().lower()
            if not part:
                continue
            if part == "all":
                out.extend(STAGES)
                continue
            if part not in STAGES:
                raise SystemExit(f"error: unknown stage {part!r}; stages are {', '.join(STAGES)}")
            out.append(part)
    return sorted(set(out), key=STAGES.index)


def parse_fractions(text: str) -> list[float]:
    fr = sorted({float(x) for x in text.split(",") if x.strip()})
    if not fr or fr[0] <= 0 or fr[-1] > 1:
        raise SystemExit("error: --lc-fractions must lie in (0, 1]")
    if 1.0 not in fr:
        fr.append(1.0)
    return fr


# =================================================================================================== arguments


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="run_cobra_experiments.py", description=__doc__.split("\n\n")[0],
                                formatter_class=argparse.RawDescriptionHelpFormatter,
                                epilog="Stages: " + "; ".join(f"{s} {t}" for s, t in TITLES.items()))
    p.add_argument("--var-dir", help="workbench var directory holding the database and object store "
                                     "(default: WB_VAR_DIR or workbench/var)")
    p.add_argument("--reports-dir", help="where <stage>.json reports go (default: workbench/experiments/reports; "
                                         "with --dry-run-subset: <var-dir>/cobra-experiment-reports)")
    p.add_argument("--only", action="append", metavar="STAGES", help="run only these stages (comma list, e.g. s0,s1)")
    p.add_argument("--force", action="append", metavar="STAGES",
                   help="re-run these stages even if their report exists (comma list); s6 also needs --justification")
    p.add_argument("--device", choices=("auto", "mps", "cpu"), default="auto",
                   help="device for midnight-12k (handcrafted always runs on the CPU)")
    p.add_argument("--dry-run-subset", type=int, metavar="N",
                   help="proof run on a THROWAWAY var dir holding at most N eligible slides: small budgets, reports "
                        "flagged dry_run, refused on the shared workbench/var")
    p.add_argument("--max-patches", type=int, help="max_patches_per_slide (default 256; dry run 16)")
    p.add_argument("--cv-folds", type=int, help="dev_cv folds (default 5; dry run 2)")
    p.add_argument("--lc-fractions", help="learning-curve train-patient fractions (default 0.25,0.5,1.0)")
    p.add_argument("--lc-repeats", type=int, help="learning-curve repeats per fraction < 1 (default 3; dry run 1)")
    p.add_argument("--n-boot", type=int, help="bootstrap replicates (default from the baseline config: 2000; "
                                              "dry run 200)")
    p.add_argument("--precision-patches", type=int, default=512,
                   help="seeded development patches for the precision comparison (default 512)")
    p.add_argument("--skip-precision-downstream", action="store_true",
                   help="never build the fp16 feature set / run even when fp16 meets the acceptance rule")
    p.add_argument("--hourly-rate", type=float, help="compute price per hour (your currency) for the cost formula; "
                                                     "without it only the formula is reported")
    p.add_argument("--freeze-ack-reason", help="written reason that acknowledges freeze warnings (recorded in the "
                                               "manifest); without it a freeze with warnings stops")
    p.add_argument("--justification", help="required with --force s6 (a second look at the test patients)")
    p.add_argument("--midnight-weights", help="midnight-12k weights directory (default: WB_MIDNIGHT_WEIGHTS or "
                                              "workbench/var/models/midnight-12k)")
    p.add_argument("--job-timeout", type=float, default=0.0,
                   help="seconds to wait for one batch of jobs (0: no limit)")
    p.add_argument("--status", action="store_true", help="list the stage reports and exit")
    return p


# =================================================================================================== driver


class Driver:
    def __init__(self, args):
        self.args = args
        self.var_dir = Path(args.var_dir or os.environ.get("WB_VAR_DIR") or DEFAULT_VAR_DIR).resolve()
        self.dry = args.dry_run_subset is not None
        default_reports = (self.var_dir / "cobra-experiment-reports") if self.dry else DEFAULT_REPORTS_DIR
        self.reports_dir = Path(args.reports_dir).resolve() if args.reports_dir else default_reports
        self.state_dir = self.reports_dir / "_state"
        self.only = parse_stage_list(args.only) if args.only else list(STAGES)
        self.force = parse_stage_list(args.force) if args.force else []
        self.driver_sha256 = sha256_file(SCRIPT)
        self.t_stage = 0.0
        self.warnings: list[str] = []
        # budgets
        self.max_patches = args.max_patches or (16 if self.dry else 256)
        self.cv_folds = args.cv_folds or (2 if self.dry else 5)
        self.lc_fractions = parse_fractions(args.lc_fractions) if args.lc_fractions else [0.25, 0.5, 1.0]
        self.lc_repeats = args.lc_repeats or (1 if self.dry else 3)
        self.skip_precision_downstream = bool(args.skip_precision_downstream)
        self.baseline_cfg = json.loads(BASELINE_CONFIG.read_text())
        self.n_boot = args.n_boot or (200 if self.dry else int(self.baseline_cfg["params"].get("n_boot", 2000)))
        self.boot_seed = int((self.baseline_cfg.get("bootstrap") or {}).get("seed", 20261026))
        self.boot_min_patients = int((self.baseline_cfg.get("bootstrap") or {}).get("min_patients", 10))
        self.dataset_name = DATASET_NAME + (" [dry run]" if self.dry else "")

    # ------------------------------------------------------------------ environment and imports
    def setup(self) -> None:
        if self.dry:
            if self.args.dry_run_subset < 2:
                raise SystemExit("error: --dry-run-subset needs at least 2 slides")
            if self.var_dir == DEFAULT_VAR_DIR.resolve():
                raise SystemExit("error: --dry-run-subset is refused on the shared workbench/var; import an N-slide "
                                 "subset into a throwaway --var-dir instead")
            if self.reports_dir == DEFAULT_REPORTS_DIR.resolve():
                raise SystemExit("error: a dry run must not write into workbench/experiments/reports (it would make "
                                 "the real run skip stages); pass another --reports-dir")
        os.environ["WB_VAR_DIR"] = str(self.var_dir)
        for k, v in {"HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1", "HF_HUB_DISABLE_TELEMETRY": "1"}.items():
            os.environ.setdefault(k, v)
        weights = self.args.midnight_weights or os.environ.get("WB_MIDNIGHT_WEIGHTS") or (
            str(DEFAULT_MIDNIGHT_WEIGHTS) if DEFAULT_MIDNIGHT_WEIGHTS.is_dir() else None)
        if weights:
            os.environ["WB_MIDNIGHT_WEIGHTS"] = str(Path(weights).resolve())
        if str(API_DIR) not in sys.path:
            sys.path.insert(0, str(API_DIR))
        from dermpath.config import Settings, set_settings
        from dermpath.db import init_db

        set_settings(Settings.from_env())
        init_db()
        import dermpath.ml.jobs  # noqa: F401 - registers the engine job handlers
        from dermpath.ml import devices

        self.midnight_device = devices.resolve_device(self.args.device)
        self.reports_dir.mkdir(parents=True, exist_ok=True)
        self.state_dir.mkdir(parents=True, exist_ok=True)

    def lead(self):
        """The research lead actor, loaded from the database (must be a project member)."""
        from dermpath.auth import Actor
        from dermpath.db import session_scope
        from dermpath.models import User

        with session_scope() as db:
            u = db.get(User, LEAD_USER_ID)
            if u is None:
                raise StageError(f"user {LEAD_USER_ID} does not exist on this database (run python -m dermpath.seed)")
            if u.role != "research_lead":
                raise StageError(f"{LEAD_USER_ID} has role {u.role}, not research_lead")
            return Actor(u.id, u.role, u.display_name)

    def authorize(self, db, permission: str) -> None:
        from dermpath.auth import authorize

        authorize(db, self.actor, PROJECT_ID, permission)

    # ------------------------------------------------------------------ logging and reports
    def log(self, msg: str) -> None:
        print(f"[{_dt.datetime.now().strftime('%H:%M:%S')}] {msg}", file=sys.stderr, flush=True)

    def report_path(self, stage: str) -> Path:
        name = "summary.json" if stage == "s8" else f"{stage}.json"
        return self.reports_dir / name

    def load_report(self, stage: str) -> dict | None:
        p = self.report_path(stage)
        return json.loads(p.read_text()) if p.is_file() else None

    def require(self, stage: str) -> dict:
        rep = self.load_report(stage)
        if rep is None:
            raise StageError(f"this stage needs the {stage} report ({self.report_path(stage)}); run {stage} first")
        return rep

    def header(self, stage: str) -> dict:
        from dermpath.config import get_settings
        from dermpath.ml.artifacts import code_identity, dependency_versions

        settings = get_settings()
        return {
            "schema": REPORT_SCHEMA, "stage": stage, "title": TITLES[stage], "research_use_only": True,
            "notice": NOTICE, "dry_run": self.dry, "dry_run_subset": self.args.dry_run_subset,
            "var_dir": str(self.var_dir), "database": "sqlite" if settings.database_url.startswith("sqlite") else
            "external", "reports_dir": str(self.reports_dir), "argv": sys.argv[1:],
            "driver": {"path": str(SCRIPT), "sha256": self.driver_sha256},
            "code_identity": code_identity(), "dependency_versions": dependency_versions(),
            "budgets": {"max_patches_per_slide": self.max_patches, "cv_folds": self.cv_folds,
                        "lc_fractions": self.lc_fractions, "lc_repeats": self.lc_repeats, "n_boot": self.n_boot,
                        "precision_patches": self.args.precision_patches,
                        "skip_precision_downstream": self.skip_precision_downstream},
            "midnight_device": self.midnight_device, "project_id": PROJECT_ID, "actor": self.actor.id,
        }

    def write_json(self, path: Path, data: dict) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(path.suffix + f".tmp{os.getpid()}")
        tmp.write_text(json.dumps(jsonable(data), indent=2, sort_keys=True, default=str))
        os.replace(tmp, path)

    def write_report(self, stage: str, body: dict, started_at: str) -> Path:
        rep = {**self.header(stage), **body, "started_at": started_at, "finished_at": now_iso(),
               "elapsed_seconds": round(time.perf_counter() - self.t_stage, 3)}
        rep["warnings"] = list(dict.fromkeys((body.get("warnings") or []) + self.warnings))
        path = self.report_path(stage)
        self.write_json(path, rep)
        return path

    def archive(self, stage: str) -> None:
        p = self.report_path(stage)
        if p.is_file():
            dst = self.reports_dir / "_superseded" / f"{p.stem}.{_dt.datetime.now().strftime('%Y%m%dT%H%M%S')}.json"
            dst.parent.mkdir(parents=True, exist_ok=True)
            os.replace(p, dst)
            self.log(f"{stage}: previous report archived to {dst}")

    def state(self, stage: str) -> dict:
        p = self.state_dir / f"{stage}.json"
        return json.loads(p.read_text()) if p.is_file() else {}

    def save_state(self, stage: str, data: dict) -> None:
        self.write_json(self.state_dir / f"{stage}.json", data)

    def reset_state(self, stage: str) -> None:
        p = self.state_dir / f"{stage}.json"
        if p.is_file():
            os.replace(p, self.state_dir / f"{stage}.superseded-{_dt.datetime.now().strftime('%Y%m%dT%H%M%S')}.json")

    # ------------------------------------------------------------------ jobs
    def run_jobs(self, job_ids: list[str], types: list[str], label: str) -> dict:
        """Run the engine's queued jobs in this process until every job in ``job_ids`` has finished."""
        from dermpath.db import session_scope
        from dermpath.jobs.worker import Worker
        from dermpath.models import Job

        worker = Worker(f"cobra-driver-{os.getpid()}", record_heartbeat=False, types=types)
        pending = set(job_ids)
        t0 = time.monotonic()
        last_note = 0.0
        stop = threading.Event()

        def monitor():  # progress of long jobs (a midnight build of 60 slides takes about an hour)
            while not stop.wait(120.0):
                try:
                    with session_scope() as db:
                        for j in sorted(pending):
                            job = db.get(Job, j)
                            if job is not None and job.status == "running":
                                self.log(f"  {label}: job {j[:8]} {job.type} {100 * (job.progress or 0):.0f}% "
                                         f"{job.progress_message or ''}")
                except Exception:  # noqa: BLE001 - progress display only
                    pass

        mon = threading.Thread(target=monitor, name="cobra-progress", daemon=True)
        mon.start()
        try:
            return self._run_jobs_loop(worker, job_ids, pending, label, t0, last_note)
        finally:
            stop.set()

    def _run_jobs_loop(self, worker, job_ids, pending, label, t0, last_note) -> dict:
        from dermpath.db import session_scope
        from dermpath.models import Job

        while True:
            with session_scope() as db:
                pending = {j for j in pending if (job := db.get(Job, j)) is not None
                           and job.status in ("queued", "running")}
            if not pending:
                break
            o = worker.run_once()
            if o is not None:
                self.log(f"  job {o.job_id[:8]} {o.type}: {o.status}"
                         + (f" ({str(o.error or '')[:200]})" if o.status != "succeeded" else ""))
                continue
            # Nothing claimable now: a retry back-off, or a lease held by a dead process (recovered on expiry).
            if time.monotonic() - last_note > 60:
                self.log(f"  {label}: waiting for {len(pending)} job(s) (back-off or an expiring lease)")
                last_note = time.monotonic()
            if self.args.job_timeout and time.monotonic() - t0 > self.args.job_timeout:
                raise StageError(f"{label}: jobs still pending after {self.args.job_timeout}s",
                                 pending=sorted(pending))
            time.sleep(2.0)
        out = {}
        with session_scope() as db:
            for j in job_ids:
                job = db.get(Job, j)
                out[j] = {"status": job.status, "error": job.error, "result": job.result_json,
                          "attempts": job.attempts, "type": job.type,
                          "seconds": (job.finished_at - job.started_at).total_seconds()
                          if job.finished_at and job.started_at else None}
        return out

    # ------------------------------------------------------------------ dataset helpers
    def dataset(self) -> tuple[str, dict]:
        s1 = self.require("s1")
        return s1["dataset"]["dataset_version_id"], s1

    def manifest(self, dv_id: str) -> dict:
        from dermpath.db import session_scope
        from dermpath.models import DatasetVersion

        with session_scope() as db:
            return db.get(DatasetVersion, dv_id).manifest_json

    @staticmethod
    def dev_slide_ids(manifest: dict) -> list[str]:
        return sorted({it["slide_id"] for it in manifest["items"] if it.get("split") in ("train", "val")})

    # ------------------------------------------------------------------ feature-set helpers
    def policy_params(self, **overrides) -> dict:
        """The S2 patch / sampling / stain / precision policy (identical for every encoder)."""
        p = {"target_mpp": 0.5, "min_tissue_fraction": 0.25, "sampling_strategy": "spatial",
             "max_patches_per_slide": self.max_patches, "sampling_seed": 0, "stain_normalization": "none",
             "precision": "fp32"}
        p.update(overrides)
        return p

    def device_for(self, encoder: str) -> str:
        return "cpu" if encoder == HANDCRAFTED else self.midnight_device

    def create_set(self, encoder: str, mode: str, params: dict, name: str, dv_id: str) -> dict:
        from dermpath.db import session_scope
        from dermpath.ml import feature_sets as fsets
        from dermpath.ml.config import feature_params, resolve_experiment_params
        from dermpath.ml.encoders import get_encoder
        from dermpath.models import Project

        spec = get_encoder(encoder).spec
        fp = feature_params(resolve_experiment_params(params, encoder_spec=spec))
        t = time.perf_counter()
        with session_scope() as db:
            self.authorize(db, "experiment.write")
            fs = fsets.create_feature_set(db, self.actor, db.get(Project, PROJECT_ID), encoder_id=encoder,
                                          execution_mode=mode, dataset_version_id=dv_id, params=fp, name=name)
            out = {"feature_set_id": fs.id, "status_at_request": fs.status, "spec_sha256": fs.spec_sha256,
                   "policy_sha256": fs.policy_sha256}
        out["request_seconds"] = round(time.perf_counter() - t, 4)
        out["feature_params"] = fp
        return out

    def build_set(self, fs_id: str, label: str) -> dict:
        from dermpath.db import session_scope
        from dermpath.ml import feature_sets as fsets
        from dermpath.ml.engine_models import FeatureSet

        with session_scope() as db:
            fs = db.get(FeatureSet, fs_id)
            if fs.status == "ready":
                return {"feature_set_id": fs_id, "status": "ready", "already_ready": True, "wall_seconds": 0.0}
            self.authorize(db, "experiment.write")
            job_id = fsets.enqueue_build(db, fs, self.actor).id
        self.log(f"  building feature set {fs_id[:8]} ({label})")
        t = time.perf_counter()
        jobs = self.run_jobs([job_id], ["build_feature_set"], f"build {label}")
        wall = time.perf_counter() - t
        with session_scope() as db:
            fs = db.get(FeatureSet, fs_id)
            return {"feature_set_id": fs_id, "status": fs.status, "error": fs.error, "already_ready": False,
                    "job_id": job_id, "job": jobs[job_id], "wall_seconds": round(wall, 3)}

    def set_summary(self, fs_id: str) -> dict:
        """Specification, aggregated coverage, and a per-slide table (timings, storage, coverage) of a set."""
        from sqlalchemy import select

        from dermpath.db import session_scope
        from dermpath.ml import feature_sets as fsets
        from dermpath.ml.engine_models import FeatureSet, FeatureSetItem
        from dermpath.ml.models import FeatureArtifact
        from dermpath.storage import get_store

        store = get_store()
        with session_scope() as db:
            fs = db.get(FeatureSet, fs_id)
            d = fsets.feature_set_dict(db, fs, detail=True)
            items = db.scalars(select(FeatureSetItem).where(FeatureSetItem.feature_set_id == fs_id)
                               .order_by(FeatureSetItem.slide_id)).all()
            art_ids = [i.artifact_id for i in items if i.artifact_id]
            arts = {a.id: a for a in db.scalars(select(FeatureArtifact).where(FeatureArtifact.id.in_(art_ids))).all()}
            rows = []
            for it in items:
                st, cov, art = it.stats_json or {}, it.coverage_json or {}, arts.get(it.artifact_id)
                emb_b = q_b = None
                if art is not None:
                    try:
                        emb_b, q_b = store.size(art.embeddings_key), store.size(art.quality_key)
                    except Exception:  # noqa: BLE001 - diagnostics only
                        pass
                rows.append({
                    "slide_id": it.slide_id, "status": it.status, "error": it.error,
                    "n_candidates": st.get("n_candidates"), "n_sampled": st.get("n_sampled"),
                    "n_patches": st.get("n_patches"), "read_seconds": st.get("read_seconds"),
                    "pixel_read_seconds": st.get("pixel_read_seconds"),
                    "preprocess_seconds": st.get("preprocess_seconds"), "embed_seconds": st.get("embed_seconds"),
                    "write_seconds": st.get("write_seconds"), "total_seconds": st.get("total_seconds"),
                    "patches_per_second": st.get("patches_per_second"), "peak_rss_bytes": st.get("peak_rss_bytes"),
                    "peak_rss_delta_bytes": st.get("peak_rss_delta_bytes"), "cache_hit": st.get("cache_hit"),
                    "mask_source": st.get("mask_source"), "rejected_at_read": st.get("rejected_at_read"),
                    "artifact_id": it.artifact_id, "artifact_bytes": art.bytes if art else None,
                    "embeddings_bytes": emb_b, "quality_bytes": q_b,
                    "artifact_device": art.device if art else None, "artifact_precision": art.precision if art else None,
                    "original_extraction": ({k: (art.stats_json or {}).get(k) for k in (
                        "total_seconds", "read_seconds", "embed_seconds", "patches_per_second", "n_patches")}
                        if art is not None else None),
                    "coverage": {k: cov.get(k) for k in (
                        "tissue_area_um2", "candidate_tissue_fraction", "sampled_tissue_fraction",
                        "tissue_within_radius_of_sample_fraction", "radius_um", "fragments_total",
                        "fragments_without_candidate", "fragments_without_sampled_patch", "fragments_rescued",
                        "edge_uncovered_tissue_area_um2", "excluded_area_um2", "mask_um_per_px", "mask_coarse",
                        "sampled_origins")},
                })
            enc = fs.encoder_spec_json or {}
            spec = {"feature_set_id": fs.id, "name": fs.name, "status": fs.status, "error": fs.error,
                    "execution_mode": fs.execution_mode, "encoder_id": fs.encoder_id,
                    "dataset_version_id": fs.dataset_version_id, "spec_sha256": fs.spec_sha256,
                    "encoder_spec_sha256": fs.encoder_spec_sha256, "weights_sha256": fs.weights_sha256,
                    "weights_config_sha256": enc.get("weights_config_sha256"), "policy_sha256": fs.policy_sha256,
                    "stain_policy_sha256": fs.stain_policy_sha256, "stain_reference_sha256": fs.stain_reference_sha256,
                    "extraction_env_sha256": fs.extraction_env_sha256,
                    "input_snapshot_sha256": fs.input_snapshot_sha256, "patch_policy": fs.patch_policy_json,
                    "stain_policy": fs.stain_policy_json, "extraction": enc.get("extraction"),
                    "precision": (fs.extraction_env_json or {}).get("precision"),
                    "device_class": (fs.extraction_env_json or {}).get("device_class"),
                    "qc_source": (fs.input_snapshot_json or {}).get("qc_source"), "counts": d.get("counts")}
        cov = dict(d.get("coverage") or {})
        cov.pop("per_slide", None)
        return {"feature_set": spec, "coverage": cov, "per_slide": rows, "aggregate": self.aggregate(rows)}

    @staticmethod
    def aggregate(rows: list[dict]) -> dict:
        done = [r for r in rows if r["status"] == "done"]
        fresh = [r for r in done if not r.get("cache_hit")]
        patches = sum(int(r["n_patches"] or 0) for r in fresh)

        def tot(key):
            return sum(float(r[key] or 0.0) for r in fresh)

        out = {"slides": len(rows), "done": len(done), "failed": sum(1 for r in rows if r["status"] == "failed"),
               "fresh_extractions": len(fresh), "cache_hits": len(done) - len(fresh),
               "patches_total": sum(int(r["n_patches"] or 0) for r in done),
               "patches_per_slide": stats(r["n_patches"] for r in done),
               "candidates_per_slide": stats(r["n_candidates"] for r in done),
               "storage_bytes_per_slide": stats(r["artifact_bytes"] for r in done),
               "storage_bytes_total": sum(int(r["artifact_bytes"] or 0) for r in done),
               "seconds_per_slide_this_build": stats(r["total_seconds"] for r in done),
               "peak_rss_bytes_max": max((int(r["peak_rss_bytes"] or 0) for r in done), default=None),
               "coverage": {k: stats((r["coverage"] or {}).get(k) for r in done) for k in (
                   "tissue_within_radius_of_sample_fraction", "sampled_tissue_fraction",
                   "fragments_without_sampled_patch", "fragments_without_candidate")}}
        if fresh:
            out["fresh"] = {
                "patches": patches, "read_seconds": tot("read_seconds"), "pixel_read_seconds": tot("pixel_read_seconds"),
                "preprocess_seconds": tot("preprocess_seconds"), "embed_seconds": tot("embed_seconds"),
                "total_seconds": tot("total_seconds"),
                "read_patches_per_second": ratio(patches, tot("read_seconds")),
                "embed_patches_per_second": ratio(patches, tot("embed_seconds")),
                "end_to_end_patches_per_second": ratio(patches, tot("total_seconds")),
                "seconds_per_slide": stats(r["total_seconds"] for r in fresh),
                "read_seconds_per_slide": stats(r["read_seconds"] for r in fresh),
                "embed_seconds_per_slide": stats(r["embed_seconds"] for r in fresh),
                "seconds_per_patch": ratio(tot("total_seconds"), patches)}
        return out

    # ------------------------------------------------------------------ experiment helpers
    def base_run_params(self, head: str, encoder: str, **overrides) -> dict:
        """S3 params from the baseline config (equal budgets), with this run's budget overrides."""
        cfg = self.baseline_cfg
        p = dict(cfg["params"])
        p.update({"max_patches_per_slide": self.max_patches, "cv_folds": self.cv_folds, "n_boot": self.n_boot,
                  "device": self.device_for(encoder)})
        p.update(cfg["head_params"].get(head) or {})
        p.update(overrides)
        return p

    def create_run(self, *, dv_id: str, encoder: str, head: str, params: dict, name: str, fs_id: str,
                   family_id: str | None, role: str | None) -> tuple[str, str]:
        from dermpath.db import session_scope
        from dermpath.ml.service import create_experiment
        from dermpath.models import Project

        with session_scope() as db:
            self.authorize(db, "experiment.write")
            run, job = create_experiment(db, self.actor, db.get(Project, PROJECT_ID), dataset_version_id=dv_id,
                                         encoder_id=encoder, head=head, params=params, seed=SEED, name=name[:200],
                                         execution_mode=SUPERVISED, feature_set_id=fs_id,
                                         evaluation_protocol="dev_cv", family_id=family_id, family_role=role)
            return run.id, job.id

    def run_train_jobs(self, run_ids: list[str], label: str) -> dict:
        from dermpath.db import session_scope
        from dermpath.ml.models import TrainingRun

        with session_scope() as db:
            job_ids = [db.get(TrainingRun, r).job_id for r in run_ids]
        t = time.perf_counter()
        out = self.run_jobs([j for j in job_ids if j], ["train", "build_feature_set"], label)
        self.log(f"  {label}: {len(job_ids)} train job(s) in {time.perf_counter() - t:.1f}s")
        return out

    def run_record(self, run_id: str) -> dict:
        from sqlalchemy import select

        from dermpath.db import session_scope
        from dermpath.ml.evaluation import reference_standard_fields
        from dermpath.ml.models import Prediction, TrainingRun
        from dermpath.ml.service import run_dict

        from dermpath.models import DatasetVersion

        with session_scope() as db:
            self.authorize(db, "experiment.read")
            run = db.get(TrainingRun, run_id)
            d = run_dict(db, run)
            manifest = db.get(DatasetVersion, run.dataset_version_id).manifest_json
            test_used = (run.provenance_json or {}).get("test_items_used")
            splits_scored = sorted({s for (s,) in db.execute(
                select(Prediction.split).where(Prediction.run_id == run_id).distinct()).all()})
        oof = d.get("oof_summary") or {}
        protocol = d.get("protocol_summary") or {}
        lc = protocol.get("learning_curve")
        sc = d.get("split_counts") or {}
        rec = {"run_id": run_id, "name": d["name"], "encoder": d["encoder_id"], "head": d["head"],
               "status": d["status"], "error": d["error"], "feature_set_id": d["feature_set_id"],
               "family_id": d["family_id"], "identity_sha256": d["identity_sha256"],
               "test_items_used": test_used, "prediction_splits": splits_scored,
               "code_revision": d["code_revision"], "checkpoint": d["checkpoint"], "params": d["params"],
               "threshold": d["threshold"], "operating_point": d.get("operating_point"),
               "calibration_method": (d.get("calibration") or {}).get("method"),
               "timings_seconds": d.get("timings_seconds"), "attempts": d.get("attempts"),
               "train_patient_fraction": (d["params"] or {}).get("train_patient_fraction", 1.0),
               "subset_repeat": (d["params"] or {}).get("subset_repeat", 0),
               "train_patients": (lc or {}).get("n_patients") if lc else
               sum((sc.get(k) or {}).get("patients", 0) for k in ("train", "val")),
               "learning_curve": lc, "effective_sampling": d.get("effective_sampling"),
               "training_summary": {k: (d.get("training_summary") or {}).get(k) for k in (
                   "head", "epochs_run", "best_epoch", "n_iter", "converged", "train_bags", "fit_bags")},
               "folds": [{k: f.get(k) for k in ("fold", "status", "fit_bags", "held_out_bags", "fit_patients",
                                                "held_out_patients", "reason")}
                         for f in ((protocol.get("cv") or {}).get("folds_summary") or [])],
               **reference_standard_fields(manifest)}
        if oof:
            rec["oof"] = {
                "n_items": oof.get("n_items"), "n_patients": oof.get("n_patients"), "positives": oof.get("positives"),
                "negatives": oof.get("negatives"), "n_unscorable": oof.get("n_unscorable"),
                "tuning_set": oof.get("tuning_set"), "threshold": oof.get("threshold"),
                "threshold_selection_status": oof.get("threshold_selection_status"),
                "threshold_free": {k: metric_entry(v) for k, v in (oof.get("threshold_free") or {}).items()},
                "at_operating_point": {k: metric_entry(v) for k, v in (oof.get("at_operating_point") or {}).items()},
                "intention_to_evaluate": oof.get("intention_to_evaluate"),
                "evaluation_prevalence": oof.get("evaluation_prevalence"),
                "calibration": {k: (oof.get("calibration") or {}).get(k) for k in ("brier", "ece")},
                "bootstrap": oof.get("bootstrap")}
        return rec

    @staticmethod
    def oof_auroc(rec: dict) -> float | None:
        return (((rec.get("oof") or {}).get("threshold_free") or {}).get("auroc") or {}).get("value")

    def compare(self, run_ids: dict[str, str], *, split: str = "oof") -> dict:
        """Paired patient-level bootstrap on the stored development predictions of finished runs (identical bag
        set: bags unscorable under any model are dropped and listed). Family seed shared by every comparison."""
        from sqlalchemy import select

        from dermpath.db import session_scope
        from dermpath.ml.comparison import ComparisonRefused, ScoreSet, paired_comparison
        from dermpath.ml.evaluation import reference_standard_fields
        from dermpath.ml.models import Prediction, TrainingRun
        from dermpath.models import DatasetVersion

        entry = {"models": sorted(run_ids), "run_ids": dict(run_ids), "split": split, "n_boot": self.n_boot,
                 "bootstrap_seed": self.boot_seed, "min_patients": self.boot_min_patients}
        sets, manifest = [], None
        with session_scope() as db:
            for name, rid in sorted(run_ids.items()):
                run = db.get(TrainingRun, rid)
                if run is None or run.status != "succeeded" or run.threshold_value is None:
                    entry.update(status="insufficient_members",
                                 reason=f"{name} ({rid}) has not succeeded ({getattr(run, 'status', None)})")
                    return entry
                if manifest is None:
                    manifest = db.get(DatasetVersion, run.dataset_version_id).manifest_json
                preds = db.scalars(select(Prediction).where(Prediction.run_id == rid, Prediction.split == split)
                                   .order_by(Prediction.bag_id)).all()
                sets.append(ScoreSet(name=name, bag_ids=[p.bag_id for p in preds],
                                     patients=[p.patient_code or p.coded_patient_id for p in preds],
                                     labels=[p.label for p in preds], scores=[p.score for p in preds],
                                     threshold=float(run.threshold_value), manifest_sha256=run.dataset_manifest_sha256,
                                     split_fingerprint=(manifest or {}).get("split_fingerprint")))
        common = set(sets[0].bag_ids)
        for ss in sets[1:]:
            common &= set(ss.bag_ids)
        excluded = sorted(set().union(*[set(ss.bag_ids) for ss in sets]) - common)
        restricted = []
        for ss in sets:
            keep = [i for i, b in enumerate(ss.bag_ids) if b in common]
            restricted.append(ScoreSet(name=ss.name, bag_ids=[ss.bag_ids[i] for i in keep],
                                       patients=[ss.patients[i] for i in keep], labels=[ss.labels[i] for i in keep],
                                       scores=[ss.scores[i] for i in keep], threshold=ss.threshold,
                                       manifest_sha256=ss.manifest_sha256, split_fingerprint=ss.split_fingerprint))
        entry.update(reference_standard_fields(manifest))
        entry["excluded_bags_unscorable_under_some_model"] = excluded
        try:
            res = paired_comparison(restricted, n_boot=self.n_boot, seed=self.boot_seed,
                                    min_patients=self.boot_min_patients)
        except ComparisonRefused as exc:
            entry.update(status="refused", code=exc.code, reason=exc.detail)
            return entry
        entry["status"] = "ok"
        entry["result"] = res
        entry["deltas"] = [{"a": p["a"], "b": p["b"], "delta": p["delta"],
                            **{m: {k: v.get(k) for k in ("value", "ci", "ci_reason", "fraction_favouring")}
                               for m, v in p["deltas"].items()},
                            "mcnemar_p": (p["mcnemar"]["all"] or {}).get("p_value")} for p in res["pairs"]]
        return entry

    # =============================================================================================== stages
    # ------------------------------------------------------------------ s0
    def s0(self) -> dict:
        from sqlalchemy import func, select

        from dermpath.config import get_settings
        from dermpath.db import session_scope
        from dermpath.ml import devices
        from dermpath.ml.artifacts import extraction_env
        from dermpath.ml.encoders import get_encoder, list_encoders
        from dermpath.models import Project, Slide

        import torch

        mem = None
        try:
            if sys.platform == "darwin":
                import subprocess

                mem = int(subprocess.run(["sysctl", "-n", "hw.memsize"], capture_output=True, text=True,
                                         check=True).stdout.strip())
            else:
                mem = os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES")
        except Exception:  # noqa: BLE001 - informational
            pass
        machine = {"platform": platform.platform(), "machine": platform.machine(), "processor": platform.processor(),
                   "python": platform.python_version(), "cpu_count": os.cpu_count(), "memory_bytes": mem,
                   "torch_threads": torch.get_num_threads(), "wb_ml_cpu_threads": devices.cpu_threads(),
                   "wb_ml_batch_size": os.environ.get("WB_ML_BATCH_SIZE", "32 (default)")}
        precision = {}
        for dev in devices.available_devices():
            d = devices.resolve_device(dev)
            precision[d] = {p: dict(zip(("supported", "reason"), devices.precision_supported(d, p)))
                            for p in devices.PRECISIONS}
        devs = {"available": devices.available_devices(), "requested_for_midnight": self.args.device,
                "resolved_for_midnight": self.midnight_device, "handcrafted": "cpu (numpy encoder)",
                "mps_built": bool(getattr(torch.backends, "mps", None) and torch.backends.mps.is_built()),
                "cuda": torch.cuda.is_available(), "precision_support": precision,
                "precision_acceptance_rule": devices.PRECISION_ACCEPTANCE_RULE,
                "extraction_env": {e: extraction_env(self.device_for(e), "fp32")[0] for e in ENCODERS}}
        self.log("s0: hashing encoder weights (streaming sha256)")
        enc_status = list_encoders()
        identities = {}
        for e in ENCODERS:
            ad = get_encoder(e)
            st, detail = ad.status()
            ident = {"status": st, "status_detail": detail, "spec_sha256": ad.spec.spec_sha256(),
                     "input_size": ad.spec.input_size, "embedding_dim": ad.spec.embedding_dim,
                     "license": ad.spec.license}
            if st == "available":
                from dermpath.ml.feature_sets import resolve_weights_identity

                w, c = resolve_weights_identity(ad)
                ident.update(weights_sha256=w, weights_config_sha256=c)
            identities[e] = ident
            if st != "available":
                self.warnings.append(f"encoder {e} is {st}: {detail}")
        settings = get_settings()
        with session_scope() as db:
            project = db.get(Project, PROJECT_ID)
            slides = db.scalar(select(func.count(Slide.id)).where(Slide.project_id == PROJECT_ID)) or 0
            ingested = db.scalar(select(func.count(Slide.id)).where(Slide.project_id == PROJECT_ID,
                                                                    Slide.ingest_status == "succeeded")) or 0
        return {"machine": machine, "devices": devs, "encoders": {"describe_encoders": enc_status,
                                                                   "benchmark_encoders": identities},
                "environment": {"WB_VAR_DIR": str(self.var_dir), "WB_MIDNIGHT_WEIGHTS":
                                os.environ.get("WB_MIDNIGHT_WEIGHTS"), "HF_HUB_OFFLINE": os.environ.get("HF_HUB_OFFLINE"),
                                "objects_dir": str(settings.objects_dir)},
                "project": {"id": PROJECT_ID, "exists": project is not None, "slides": slides,
                            "slides_ingested": ingested, "name": project.name if project else None},
                "nothing_downloaded": True}

    # ------------------------------------------------------------------ s1
    def dataset_config(self) -> dict:
        return {"label_scope": "slide", "reference_standard": "imported_reference",
                "eligible_review_states": list(ELIGIBLE_REVIEW_STATES), "label_values": [POSITIVE, NEGATIVE],
                "include_provenance": ["public_licensed"],
                "split": {"partition": "random", "seed": SPLIT_SEED, "ratios": dict(SPLIT_RATIOS),
                          "patient_label_rule": "any_positive"}}

    @staticmethod
    def split_table(manifest: dict) -> dict:
        pos = manifest.get("positive_class") or POSITIVE
        out: dict = {}
        patients: dict[str, dict] = {}
        for it in manifest["items"]:
            sp = it.get("split")
            t = out.setdefault(sp, {"slides": {}, "patients": {}})
            t["slides"][it["label_value"]] = t["slides"].get(it["label_value"], 0) + 1
            p = patients.setdefault(it["coded_patient_id"], {"split": sp, "labels": set()})
            p["labels"].add(it["label_value"])
        for p in patients.values():
            cls = POSITIVE if pos in p["labels"] else NEGATIVE
            t = out[p["split"]]["patients"]
            t[cls] = t.get(cls, 0) + 1
        for sp in ("train", "val", "test"):
            out.setdefault(sp, {"slides": {}, "patients": {}})
        dev = {"slides": {}, "patients": {}}
        for sp in ("train", "val"):
            for k in ("slides", "patients"):
                for c, n in out[sp][k].items():
                    dev[k][c] = dev[k].get(c, 0) + n
        out["development_pool (train ∪ val)"] = dev
        return out

    def s1(self) -> dict:
        from sqlalchemy import func, select

        from dermpath import datasets as ds
        from dermpath.db import session_scope
        from dermpath.ml.evaluation import reference_standard_fields
        from dermpath.models import DatasetVersion, Project, Slide

        name = self.dataset_name
        freeze_check = None
        acknowledged = None
        with session_scope() as db:
            project = db.get(Project, PROJECT_ID)
            if project is None:
                raise StageError(f"project {PROJECT_ID} does not exist on {self.var_dir}; import the COBRA subset "
                                 "first (python -m dermpath.importers.cobra ...)")
            self.authorize(db, "dataset.write")
            n_slides = db.scalar(select(func.count(Slide.id)).where(Slide.project_id == PROJECT_ID)) or 0
            if self.dry and n_slides > self.args.dry_run_subset:
                raise StageError(f"--dry-run-subset {self.args.dry_run_subset}: the project holds {n_slides} slides. "
                                 "A frozen dataset version includes every eligible slide, so a subset needs a "
                                 "throwaway var dir into which only that many slides were imported.")
            rows = db.scalars(select(DatasetVersion).where(DatasetVersion.project_id == PROJECT_ID,
                                                           DatasetVersion.name == name)
                              .order_by(DatasetVersion.created_at)).all()
            frozen = [d for d in rows if d.status == "frozen"]
            drafts = [d for d in rows if d.status == "draft"]
            if len(frozen) > 1:
                raise StageError(f"{len(frozen)} frozen versions are named {name!r}; refusing to choose one",
                                 ids=[d.id for d in frozen])
            if frozen:
                dv_id, origin = frozen[0].id, "existing frozen version reused (s1 never freezes a second one)"
            elif drafts:
                dv = drafts[-1]
                ds.refresh(db, self.actor, dv)
                dv_id, origin = dv.id, "existing draft (from an interrupted run) refreshed; frozen by this run"
            else:
                dv = ds.create_draft(db, self.actor, project, name=name, config=self.dataset_config())
                dv_id, origin = dv.id, "draft created by this run; frozen by this run"
        self.log(f"s1: dataset version {dv_id} ({origin.split(';')[0]})")
        if not frozen:
            with session_scope() as db:
                dv = db.get(DatasetVersion, dv_id)
                freeze_check = ds.freeze_check(db, dv)
                counts = {"items": len(ds.item_rows(db, dv)), "excluded": len(dv.exclusions_json or [])}
            if freeze_check["blockers"]:
                raise StageError("the draft cannot be frozen", blockers=freeze_check["blockers"])
            if counts["items"] == 0:
                raise StageError("no eligible items")
            if freeze_check["requires_acknowledgement"]:
                pending = {k: freeze_check[k] for k in freeze_check["acknowledgeable"] if freeze_check.get(k)}
                if not (self.args.freeze_ack_reason or "").strip():
                    raise StageError("freezing would lock in warnings that need a written acknowledgement; review "
                                     "them and re-run with --freeze-ack-reason \"<your reason>\"", warnings=pending)
                acknowledged = {"warnings": sorted(pending), "reason": self.args.freeze_ack_reason.strip()}
            with session_scope() as db:
                self.authorize(db, "dataset.write")
                dv = db.get(DatasetVersion, dv_id)
                ds.freeze(db, self.actor, dv, reason=acknowledged["reason"] if acknowledged else None,
                          acknowledge_warnings=bool(acknowledged))
        with session_scope() as db:
            self.authorize(db, "dataset.read")
            dv = db.get(DatasetVersion, dv_id)
            m = dv.manifest_json
            verified = ds.verify_manifest(dv)
            live_audit = ds.audit(db, dv)
            info = {"dataset_version_id": dv.id, "name": dv.name, "version": dv.version, "lineage_id": dv.lineage_id,
                    "status": dv.status, "frozen_at": dv.frozen_at, "frozen_by": dv.frozen_by,
                    "manifest_sha256": dv.manifest_sha256, "manifest_verified": verified,
                    "manifest_object_key": dv.manifest_object_key, "origin": origin}
        table = self.split_table(m)
        pool = table["development_pool (train ∪ val)"]
        return {
            "dataset": {**info, "split_family_id": m.get("split_family_id"),
                        "split_fingerprint": m.get("split_fingerprint"), "data_mode": m.get("data_mode"),
                        "counts": m.get("counts"), "positive_class": m.get("positive_class"),
                        "label_display": m.get("label_display"), "patient_label_rule": m.get("patient_label_rule"),
                        **reference_standard_fields(m)},
            "config": m.get("config"),
            "split_request": self.dataset_config()["split"],
            "split_note": ("patient-grouped stratified random split; test ~30 % of patients; val ratio 0, so the "
                           "development pool (train ∪ val, used by dev_cv) is the remaining patients"),
            "split_table": table,
            "development_pool_patients": sum(pool["patients"].values()),
            "test_patients": sum(table["test"]["patients"].values()),
            "split_diagnostics": m.get("split_diagnostics"),
            "split_family_counts": m.get("split_family_counts"),
            "audit_at_freeze": m.get("audit"),
            "audit_now": live_audit,
            "freeze_check_before_freeze": freeze_check,
            "acknowledged_warnings": m.get("acknowledged_warnings") or acknowledged,
            "exclusions": m.get("exclusions"),
            "label_provenance": m.get("label_provenance"),
            "public_dataset": m.get("public_dataset"),
            "near_duplicate_decisions": m.get("near_duplicate_decisions"),
            "labels_note": "task labels are bcc_present / bcc_absent_not_benign; BCC absent is never 'benign'",
        }

    # ------------------------------------------------------------------ s2
    def cache_reuse(self, fs_id: str, encoder: str, mode: str, params: dict, name: str, dv_id: str,
                    summary: dict) -> dict:
        """(1) re-requesting the identical specification returns the existing set; (2) re-extracting every built
        slide through ``feature_sets.extract_slide`` is a content-addressed cache hit (timed)."""
        from dermpath.db import session_scope
        from dermpath.ml import feature_sets as fsets
        from dermpath.ml.engine_models import FeatureSet

        again = self.create_set(encoder, mode, params, name, dv_id)
        kw = fsets.extraction_kwargs(fs_id)
        with session_scope() as db:
            fs = db.get(FeatureSet, fs_id)
            snaps = {s["slide_id"]: s for s in fs.input_snapshot_json["slides"]}
        t = time.perf_counter()
        loaded = fsets.load_encoder(encoder, weights_sha256=kw["weights_sha256"],
                                    encoder_spec_sha256=kw["encoder_spec_sha256"], device=kw["device"],
                                    precision=kw["precision"], weights_config_sha256=kw["weights_config_sha256"])
        load_s = time.perf_counter() - t
        rows = []
        orig = {r["slide_id"]: r for r in summary["per_slide"]}
        for sid, r in orig.items():
            if r["status"] != "done":
                continue
            t = time.perf_counter()
            sf = fsets.extract_slide(sid, input_snapshot=snaps[sid], loaded=loaded, **kw)
            dt = time.perf_counter() - t
            first = (r.get("original_extraction") or {}).get("total_seconds") or r.get("total_seconds")
            rows.append({"slide_id": sid, "cache_hit": bool(sf.cache_hit), "seconds": round(dt, 4),
                         "same_artifact": sf.artifact_id == r["artifact_id"], "first_extraction_seconds": first,
                         "speedup": ratio(first, dt)})
        return {"re_request_identical_spec": {"returned_feature_set_id": again["feature_set_id"],
                                              "same_set": again["feature_set_id"] == fs_id,
                                              "seconds": again["request_seconds"]},
                "encoder_load_seconds": round(load_s, 3),
                "re_extraction": {"slides": len(rows), "all_cache_hits": all(x["cache_hit"] for x in rows),
                                  "all_same_artifact": all(x["same_artifact"] for x in rows),
                                  "seconds_per_slide": stats(x["seconds"] for x in rows),
                                  "speedup": stats(x["speedup"] for x in rows), "per_slide": rows,
                                  "note": "a cache hit still verifies the slide bytes (sha256 memoised per process) "
                                          "and the stored objects' sha256; nothing is re-embedded"}}

    def validate_set(self, fs_id: str) -> dict:
        from dermpath.db import session_scope
        from dermpath.ml import feature_sets as fsets
        from dermpath.ml.engine_models import FeatureSet, FeatureSetValidation

        with session_scope() as db:
            self.authorize(db, "experiment.write")
            job_id = fsets.enqueue_validation(db, db.get(FeatureSet, fs_id), self.actor, seed=0, n_slides=2).id
        jobs = self.run_jobs([job_id], ["validate_feature_set"], "technical validation")
        j = jobs[job_id]
        out = {"job_id": job_id, "job_status": j["status"], "job_error": j["error"], "job_seconds": j["seconds"]}
        vid = (j.get("result") or {}).get("validation_id")
        if vid:
            with session_scope() as db:
                v = db.get(FeatureSetValidation, vid)
                out.update(validation_id=vid, passed=v.passed, result=v.result_json)
        return out

    def s2(self) -> dict:
        dv_id, _ = self.dataset()
        out: dict = {"policy": self.policy_params(), "labels_read": False,
                     "note": "real_image_technical: no label is read anywhere; every slide (test included) is "
                             "extracted label-free", "encoders": {}}
        for enc in ENCODERS:
            params = {**self.policy_params(), "device": self.device_for(enc)}
            name = f"S2 technical · {enc}"
            self.log(f"s2: {enc} on {self.device_for(enc)}")
            created = self.create_set(enc, TECHNICAL, params, name, dv_id)
            fs_id = created["feature_set_id"]
            build = self.build_set(fs_id, f"s2 {enc}")
            entry = {"device": self.device_for(enc), "params": params, "created": created, "build": build}
            if build["status"] != "ready":
                entry["error"] = build.get("error")
                out["encoders"][enc] = entry
                raise StageError(f"s2: the {enc} feature set did not build: {build.get('error')}",
                                 build=build)
            summary = self.set_summary(fs_id)
            entry["feature_set"] = summary
            if not build.get("already_ready"):
                items_s = (summary["aggregate"].get("seconds_per_slide_this_build") or {}).get("sum") or 0.0
                entry["build"]["overhead_seconds"] = round(max(0.0, build["wall_seconds"] - items_s), 3)
                entry["build"]["overhead_note"] = ("build wall time minus per-slide extraction time: encoder load "
                                                   "(weights hashed and deserialised once per process), job "
                                                   "bookkeeping and the readiness transaction")
            self.log(f"s2: {enc} technical validation (determinism, 2 seeded slides)")
            entry["technical_validation"] = self.validate_set(fs_id)
            self.log(f"s2: {enc} cache reuse")
            entry["cache_reuse"] = self.cache_reuse(fs_id, enc, TECHNICAL, params, name, dv_id, summary)
            out["encoders"][enc] = entry
        pol = {e: dict(v["feature_set"]["feature_set"]["patch_policy"] or {}) for e, v in out["encoders"].items()}
        stripped = {e: json.dumps({k: v for k, v in p.items() if k != "patch_size"}, sort_keys=True)
                    for e, p in pol.items()}
        out["policy_identity"] = {"identical_except_patch_size": len(set(stripped.values())) == 1,
                                  "patch_size": {e: p.get("patch_size") for e, p in pol.items()},
                                  "policy_sha256": {e: v["feature_set"]["feature_set"]["policy_sha256"]
                                                    for e, v in out["encoders"].items()}}
        if not out["policy_identity"]["identical_except_patch_size"]:
            self.warnings.append("s2: patch/sampling policies differ across encoders beyond patch_size")
        out["validation_passed"] = {e: v["technical_validation"].get("passed") for e, v in out["encoders"].items()}
        return out

    # ------------------------------------------------------------------ s3
    def supervised_set(self, encoder: str, dv_id: str, *, label: str, technical_fs_id: str | None = None,
                       **policy_overrides) -> dict:
        """A supervised feature set with the given policy (built; artifacts are reused from the content cache
        whenever the extraction is identical)."""
        params = {**self.policy_params(**policy_overrides), "device": self.device_for(encoder)}
        created = self.create_set(encoder, SUPERVISED, params, f"{label} · {encoder}", dv_id)
        build = self.build_set(created["feature_set_id"], f"{label} {encoder}")
        out = {"params": params, "created": created, "build": build}
        if build["status"] == "ready":
            out["feature_set"] = self.set_summary(created["feature_set_id"])
        if technical_fs_id:
            out["technical_feature_set_id"] = technical_fs_id
        return out

    def reuse_probe(self, dv_id: str, encoder: str, technical_fs_id: str) -> dict:
        """Ask the engine to run a supervised experiment on the S2 technical set (identical policy). Nothing is
        written: the engine either accepts (the run would reuse the set) or refuses before inserting anything."""
        from dermpath.db import session_scope
        from dermpath.errors import ApiError
        from dermpath.ml.service import create_experiment
        from dermpath.models import Project

        class _Rollback(Exception):
            pass

        res: dict = {}
        try:
            with session_scope() as db:
                self.authorize(db, "experiment.write")
                run, _ = create_experiment(db, self.actor, db.get(Project, PROJECT_ID), dataset_version_id=dv_id,
                                           encoder_id=encoder, head="meanpool_logreg",
                                           params=self.base_run_params("meanpool_logreg", encoder), seed=SEED,
                                           name="reuse probe (rolled back)", execution_mode=SUPERVISED,
                                           feature_set_id=technical_fs_id, evaluation_protocol="dev_cv")
                res = {"accepted": True, "note": "the engine accepted the technical set for a supervised run "
                                                 "(probe rolled back)"}
                raise _Rollback
        except _Rollback:
            pass
        except ApiError as exc:
            res = {"accepted": False, "code": exc.code, "message": exc.message, "details": exc.details,
                   "note": "execution_mode is part of a feature set's specification, so a supervised run cannot "
                           "pin the technical set; supervised sets with the IDENTICAL policy are created instead and "
                           "their artifacts come from the content-addressed cache (no re-embedding)"}
        return res

    def s3(self) -> dict:
        from sqlalchemy import func, select

        from dermpath.db import session_scope
        from dermpath.ml.config import resolve_params
        from dermpath.ml.engine_models import TestRelease
        from dermpath.ml.evaluation import create_family, reference_standard_fields
        from dermpath.ml.heads import OPTIMISATION_BUDGETS
        from dermpath.models import Project

        dv_id, s1 = self.dataset()
        s2 = self.require("s2")
        manifest = self.manifest(dv_id)
        st = self.state("s3")
        st.setdefault("runs", {})
        # ---- feature sets: probe reuse of the technical sets, then supervised sets with the identical policy
        sets: dict = {}
        for enc in ENCODERS:
            tech = s2["encoders"][enc]["created"]["feature_set_id"]
            self.log(f"s3: {enc}: reuse probe and supervised feature set")
            probe = self.reuse_probe(dv_id, enc, tech)
            sup = self.supervised_set(enc, dv_id, label="S3 supervised", technical_fs_id=tech)
            if sup["build"]["status"] != "ready":
                raise StageError(f"s3: supervised {enc} set did not build: {sup['build'].get('error')}")
            agg = sup["feature_set"]["aggregate"]
            same_policy = sup["created"]["policy_sha256"] == s2["encoders"][enc]["created"]["policy_sha256"]
            sets[enc] = {"technical_feature_set_id": tech, "supervised_feature_set_id": sup["created"]["feature_set_id"],
                         "reuse_probe": probe, "identical_policy_sha256": same_policy,
                         "duplicate_extraction_cost": {
                             "build_wall_seconds": sup["build"].get("wall_seconds"),
                             "slides": agg["done"], "cache_hits": agg["cache_hits"],
                             "fresh_extractions": agg["fresh_extractions"],
                             "seconds_in_items": (agg.get("seconds_per_slide_this_build") or {}).get("sum"),
                             "extra_storage_bytes": 0 if agg["fresh_extractions"] == 0 else None,
                             "note": "artifacts are content-addressed and shared; a cache hit verifies hashes only"},
                         "supervised_set": sup}
            if not same_policy:
                self.warnings.append(f"s3: {enc} supervised policy sha differs from the s2 technical set")
        # ---- family and runs (resumable through the state file)
        if not st.get("family_id"):
            with session_scope() as db:
                self.authorize(db, "experiment.write")
                fam = create_family(db, self.actor, db.get(Project, PROJECT_ID), name="S3 COBRA baselines",
                                    dataset_version_id=dv_id, bootstrap_seed=self.boot_seed,
                                    plan={"schema": REPORT_SCHEMA, "stage": "s3", "n_boot": self.n_boot,
                                          "boot_min_patients": self.boot_min_patients,
                                          "comparisons": "encoder effects with the head fixed; head effects with the "
                                                         "encoder fixed; out-of-fold predictions only"})
                st["family_id"] = fam.id
            self.save_state("s3", st)
        family_id = st["family_id"]
        variants = [{"encoder": e, "head": h, "fraction": 1.0, "repeat": 0, "role": "grid"}
                    for e in ENCODERS for h in HEADS]
        for e in ENCODERS:
            for f in self.lc_fractions:
                if f >= 1.0:
                    continue
                for r in range(self.lc_repeats):
                    variants.append({"encoder": e, "head": "meanpool_logreg", "fraction": f, "repeat": r,
                                     "role": "learning_curve"})
        for v in variants:
            key = f"{v['encoder']}|{v['head']}|{v['fraction']}|{v['repeat']}"
            if key in st["runs"]:
                continue
            extra = {"train_patient_fraction": v["fraction"], "subset_repeat": v["repeat"]} if v["fraction"] < 1 else {}
            params = self.base_run_params(v["head"], v["encoder"], **extra)
            lc = f" · train fraction {v['fraction']} r{v['repeat']}" if v["fraction"] < 1 else ""
            rid, _ = self.create_run(dv_id=dv_id, encoder=v["encoder"], head=v["head"], params=params,
                                     name=f"S3 · {v['encoder']} · {v['head']}{lc}",
                                     fs_id=sets[v["encoder"]]["supervised_feature_set_id"], family_id=family_id,
                                     role=v["role"])
            st["runs"][key] = rid
            self.save_state("s3", st)
        self.log(f"s3: training {len(st['runs'])} run(s) (dev_cv, {self.cv_folds} folds)")
        self.run_train_jobs(list(st["runs"].values()), "s3 runs")
        records = []
        for v in variants:
            key = f"{v['encoder']}|{v['head']}|{v['fraction']}|{v['repeat']}"
            rec = self.run_record(st["runs"][key])
            rec.update(role=v["role"], fraction=v["fraction"], repeat=v["repeat"])
            records.append(rec)
        failed = [r for r in records if r["status"] != "succeeded"]
        for r in failed:
            self.warnings.append(f"s3: run {r['run_id']} ({r['encoder']} {r['head']} f={r['fraction']} "
                                 f"r={r['repeat']}) {r['status']}: {str(r['error'])[:300]}")
        grid = {(r["encoder"], r["head"]): r for r in records if r["role"] == "grid"}
        # ---- paired comparisons on OOF
        comparisons = {"encoder_effects": [], "head_effects": []}
        for h in HEADS:
            comparisons["encoder_effects"].append({"fixed": {"head": h}, **self.compare(
                {e: grid[(e, h)]["run_id"] for e in ENCODERS})})
        for e in ENCODERS:
            comparisons["head_effects"].append({"fixed": {"encoder": e}, **self.compare(
                {h: grid[(e, h)]["run_id"] for h in HEADS})})
        # ---- learning curves
        curves = []
        for e in ENCODERS:
            points = []
            for f in self.lc_fractions:
                rows = [r for r in records if r["encoder"] == e and r["head"] == "meanpool_logreg"
                        and r["fraction"] == f]
                vals = [self.oof_auroc(r) for r in rows if r["status"] == "succeeded" and self.oof_auroc(r) is not None]
                points.append({"fraction": f, "n_repeats": len(rows), "n_succeeded": len(vals),
                               "train_patients": stats(r["train_patients"] for r in rows),
                               "auroc_mean": statistics.fmean(vals) if vals else None,
                               "auroc_min": min(vals) if vals else None, "auroc_max": max(vals) if vals else None,
                               "repeats": [{"repeat": r["repeat"], "run_id": r["run_id"], "status": r["status"],
                                            "train_patients": r["train_patients"],
                                            "auroc": ((r.get("oof") or {}).get("threshold_free") or {}).get("auroc"),
                                            "auprc": ((r.get("oof") or {}).get("threshold_free") or {}).get("auprc"),
                                            "error": r["error"]} for r in rows]})
            curves.append({"encoder": e, "head": "meanpool_logreg", "evaluated_on": "oof", "points": points,
                           "note": "nested stratified subsets of development patients restrict each fold's fitting "
                                   "part and the refit; every point is scored on the same full out-of-fold set"})
        # ---- pre-declared test candidate (written BEFORE any test access)
        eligible = [r for r in grid.values() if r["status"] == "succeeded" and self.oof_auroc(r) is not None]
        if not eligible:
            raise StageError("s3: no grid run succeeded with a defined OOF AUROC; no candidate can be declared")
        order = sorted(eligible, key=lambda r: (-self.oof_auroc(r), HEADS.index(r["head"]),
                                                ENCODERS.index(r["encoder"])))
        best = order[0]
        with session_scope() as db:
            n_releases = db.scalar(select(func.count(TestRelease.id)).where(TestRelease.project_id == PROJECT_ID)) or 0
        candidate = {
            "rule": CANDIDATE_RULE,
            "uses": "development (out-of-fold) predictions only; the test split was never read",
            "declared_at": now_iso(),
            "test_releases_in_project_at_declaration": n_releases,
            "ranking": [{"encoder": r["encoder"], "head": r["head"], "run_id": r["run_id"],
                         "oof_auroc": self.oof_auroc(r)} for r in order],
            "tie": len(order) > 1 and self.oof_auroc(order[1]) == self.oof_auroc(best),
            "chosen": {"encoder": best["encoder"], "head": best["head"], "run_id": best["run_id"],
                       "feature_set_id": best["feature_set_id"], "identity_sha256": best["identity_sha256"],
                       "checkpoint_sha256": (best.get("checkpoint") or {}).get("sha256"),
                       "threshold": best["threshold"], "oof": best.get("oof")},
            "release_reason": RELEASE_REASON,
        }
        if n_releases:
            self.warnings.append(f"s3: {n_releases} test release(s) already exist in this project")
        budgets = {}
        for h in HEADS:
            p = resolve_params({**{k: v for k, v in self.base_run_params(h, HANDCRAFTED).items() if k != "device"}})
            keys = (("C", "class_weight") if h == "meanpool_logreg" else
                    ("hidden_dim", "attn_dim", "dropout", "lr", "weight_decay", "max_epochs", "patience",
                     "inner_val_fraction", "max_instances_per_bag", "class_weight"))
            budgets[h] = {"description": OPTIMISATION_BUDGETS[h], "params": {k: p[k] for k in keys},
                          "same_for_every_encoder": True, "source": str(BASELINE_CONFIG.relative_to(WORKBENCH))}
        return {
            "protocol": {"evaluation_protocol": "dev_cv", "cv_folds": self.cv_folds,
                         "folds": "patient-grouped stratified over the development pool (train ∪ val); they depend "
                                  "on the pool and k only, so every run shares them",
                         "threshold_rule": "youden", "calibration": "platt", "class_weight": "balanced",
                         "test": "untouched (only a recorded test release reads it)", "seed": SEED},
            "base_params": {e: {h: self.base_run_params(h, e) for h in HEADS} for e in ENCODERS},
            "optimisation_budgets": budgets,
            "feature_sets": sets,
            "family": {"family_id": family_id, "bootstrap_seed": self.boot_seed, "status": "open",
                       "note": "the family stays open; the test candidate is the registered bundle of the chosen run"},
            "runs": records,
            "test_untouched_check": {
                "every_run_scored_only_train_and_oof": all(set(r.get("prediction_splits") or []) <= {"train", "oof"}
                                                           for r in records),
                "test_items_used": sorted({r.get("test_items_used") for r in records}, key=str)},
            "comparisons": comparisons,
            "learning_curves": curves,
            "pre_declared_test_candidate": candidate,
            "selection_note": "No winner is declared by the comparisons; the test candidate follows the rule above, "
                              "fixed before any test access.",
            **reference_standard_fields(manifest),
        }

    # ------------------------------------------------------------------ s4
    def precision_patches(self, fs_id: str, manifest: dict) -> tuple:
        """``(uint8 [N,S,S,3], provenance)``: a seeded subset of the patches a ready midnight set embedded, on
        development slides only, read again at the set's policy (same plan, no stain normalisation)."""
        import numpy as np

        from dermpath.db import session_scope
        from dermpath.ml import feature_sets as fsets
        from dermpath.ml.engine_models import FeatureSet
        from dermpath.ml.patching import PatchPolicy, iter_patch_batches, plan_scale
        from dermpath.models import Slide

        dev = set(self.dev_slide_ids(manifest))
        with session_scope() as db:
            fs = db.get(FeatureSet, fs_id)
            policy = PatchPolicy.from_json(fs.patch_policy_json)
            snaps = {s["slide_id"]: s for s in fs.input_snapshot_json["slides"] if s["slide_id"] in dev}
        ranked = []
        for sid, snap in sorted(snaps.items()):
            sf = fsets.load_slide_features(fs_id, sid)
            for x, y in np.asarray(sf.coords).tolist():
                key = hashlib.sha256(f"precision|{PRECISION_SEED}|{snap['slide_sha256']}|{x}|{y}".encode()).hexdigest()
                ranked.append((key, sid, int(x), int(y)))
        ranked.sort()
        chosen = ranked[:int(self.args.precision_patches)]
        by_slide: dict[str, list] = {}
        for _, sid, x, y in chosen:
            by_slide.setdefault(sid, []).append((x, y))
        patches = []
        for sid, coords in sorted(by_slide.items()):
            snap = snaps[sid]
            plan = plan_scale(mpp_x=snap["mpp_x"], mpp_y=snap["mpp_y"], level_downsamples=snap["level_downsamples"],
                              policy=policy)
            with session_scope() as db:
                slide = db.get(Slide, sid)
                db.expunge(slide)
            osr = fsets.open_slide(slide)
            try:
                for _, batch, _ in iter_patch_batches(osr, np.asarray(sorted(coords), dtype=np.int64), plan,
                                                      batch_size=32):
                    if len(batch):
                        patches.append(np.asarray(batch, dtype=np.uint8))
            finally:
                osr.close()
        arr = np.concatenate(patches) if patches else np.zeros((0, policy.patch_size, policy.patch_size, 3), np.uint8)
        return arr, {"source_feature_set_id": fs_id, "seed": PRECISION_SEED, "requested": self.args.precision_patches,
                     "n_patches": int(arr.shape[0]), "slides": len(by_slide), "development_slides_only": True,
                     "selection": "sha256(precision|seed|slide_sha256|x|y) ranks over the embedded coordinates",
                     "patches_sha256": hashlib.sha256(arr.tobytes()).hexdigest()}

    def embed_throughput(self, loaded, patches) -> dict:
        n = int(patches.shape[0])
        if n == 0:
            return {"n_patches": 0}
        loaded.embed_batch(patches[:min(8, n)])  # warm-up (kernels, allocator)
        t = time.perf_counter()
        for i in range(0, n, 32):
            loaded.embed_batch(patches[i:i + 32])
        dt = time.perf_counter() - t
        return {"n_patches": n, "seconds": round(dt, 4), "patches_per_second": ratio(n, dt), "batch_size": 32}

    def precision_study(self, s2: dict, manifest: dict) -> dict:
        from dermpath.ml import devices, encoders
        from dermpath.ml import feature_sets as fsets

        fs_id = s2["encoders"][MIDNIGHT]["created"]["feature_set_id"]
        kw = fsets.extraction_kwargs(fs_id)
        dev = kw["device"]
        self.log(f"s4c: reading {self.args.precision_patches} seeded development patches")
        patches, prov = self.precision_patches(fs_id, manifest)
        out = {"device": dev, "patches": prov, "acceptance_rule": devices.PRECISION_ACCEPTANCE_RULE,
               "acceptance": dict(devices.PRECISION_ACCEPTANCE), "candidates": {}}
        t = time.perf_counter()
        ref = fsets.load_encoder(MIDNIGHT, weights_sha256=kw["weights_sha256"],
                                 encoder_spec_sha256=kw["encoder_spec_sha256"], device=dev, precision="fp32",
                                 weights_config_sha256=kw["weights_config_sha256"])
        out["fp32"] = {"load_seconds": round(time.perf_counter() - t, 3),
                       "throughput": self.embed_throughput(ref, patches)}
        for prec in ("fp16", "bf16"):
            ok, why = devices.precision_supported(dev, prec)
            entry: dict = {"supported": ok, "reason": why}
            if ok:
                try:
                    t = time.perf_counter()
                    low = fsets.load_encoder(MIDNIGHT, weights_sha256=kw["weights_sha256"],
                                             encoder_spec_sha256=kw["encoder_spec_sha256"], device=dev,
                                             precision=prec, weights_config_sha256=kw["weights_config_sha256"])
                    entry["load_seconds"] = round(time.perf_counter() - t, 3)
                    entry["throughput"] = self.embed_throughput(low, patches)
                    entry["comparison"] = devices.compare_precision(ref, low, patches)
                    entry["accepted"] = bool(entry["comparison"]["accepted"])
                    entry["speedup_vs_fp32"] = ratio(entry["throughput"].get("patches_per_second"),
                                                     out["fp32"]["throughput"].get("patches_per_second"))
                except Exception as exc:  # noqa: BLE001 - an unsupported kernel is a result, not a crash
                    entry.update(accepted=False, error=f"{type(exc).__name__}: {exc}")
                finally:
                    low = None
            out["candidates"][prec] = entry
            # Free the low-precision copy: the cache entries go, `ref` keeps the one fp32 model alive.
            encoders.clear_loaded_encoders()
            gc.collect()
            self._empty_device_cache()
        del ref
        encoders.clear_loaded_encoders()
        gc.collect()
        self._empty_device_cache()
        return out

    @staticmethod
    def _empty_device_cache() -> None:
        try:
            import torch

            if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
                torch.mps.empty_cache()
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except Exception:  # noqa: BLE001 - best effort
            pass

    def s4(self) -> dict:
        from dermpath.db import session_scope
        from dermpath.ml.engine_models import ComparisonFamily
        from dermpath.ml.evaluation import add_family_member, create_family, reference_standard_fields
        from dermpath.ml.models import TrainingRun
        from dermpath.models import Project

        dv_id, _ = self.dataset()
        s2, s3 = self.require("s2"), self.require("s3")
        manifest = self.manifest(dv_id)
        st = self.state("s4")
        st.setdefault("runs", {})
        st.setdefault("sets", {})
        baseline = {r["encoder"]: r for r in s3["runs"] if r["role"] == "grid" and r["head"] == "meanpool_logreg"}
        if not st.get("family_id"):
            with session_scope() as db:
                self.authorize(db, "experiment.write")
                fam = create_family(db, self.actor, db.get(Project, PROJECT_ID), name="S4 COBRA ablations",
                                    dataset_version_id=dv_id, bootstrap_seed=self.boot_seed,
                                    plan={"schema": REPORT_SCHEMA, "stage": "s4", "n_boot": self.n_boot,
                                          "boot_min_patients": self.boot_min_patients,
                                          "comparisons": "each ablation vs the s3 meanpool_logreg baseline of the same "
                                                         "encoder, out-of-fold, identical folds"})
                for e, r in baseline.items():
                    add_family_member(db, self.actor, fam, db.get(TrainingRun, r["run_id"]), role="s3_baseline")
                st["family_id"] = fam.id
            self.save_state("s4", st)
        family_id = st["family_id"]
        arms = [("a_sampling_uniform", {"sampling_strategy": "uniform"}, ENCODERS),
                ("b_stain_macenko", {"stain_normalization": "macenko-v1"}, ENCODERS)]
        results: dict = {}

        def arm_run(arm: str, enc: str, overrides: dict) -> dict:
            entry: dict = {"arm": arm, "encoder": enc, "overrides": overrides,
                           "baseline_run_id": baseline[enc]["run_id"]}
            self.log(f"s4: {arm} · {enc}: feature set")
            sup = self.supervised_set(enc, dv_id, label=f"S4 {arm}", **overrides)
            entry["feature_set"] = sup
            fit = ((sup.get("feature_set") or {}).get("feature_set") or {}).get("stain_policy") or {}
            fit = fit.get("reference_fit") or {}
            if fit:
                split_of = {it["slide_id"]: it.get("split") for it in manifest["items"]}
                ids = list(fit.get("train_slide_ids") or [])
                entry["stain_reference_fit_check"] = {
                    "fitted_on_slides": len(ids), "splits": sorted({split_of.get(s) for s in ids}, key=str),
                    "all_train_split": bool(ids) and all(split_of.get(s) == "train" for s in ids),
                    "fitted_on": fit.get("fitted_on")}
                if not entry["stain_reference_fit_check"]["all_train_split"]:
                    self.warnings.append(f"s4: {arm} {enc}: the stain reference was not fitted on train slides only")
            if sup["build"]["status"] != "ready":
                entry["status"] = "feature_set_failed"
                entry["error"] = sup["build"].get("error")
                self.warnings.append(f"s4: {arm} {enc} feature set failed: {str(entry['error'])[:300]}")
                return entry
            key = f"{arm}|{enc}"
            if key not in st["runs"]:
                params = self.base_run_params("meanpool_logreg", enc, **overrides)
                rid, _ = self.create_run(dv_id=dv_id, encoder=enc, head="meanpool_logreg", params=params,
                                         name=f"S4 {arm} · {enc} · meanpool_logreg",
                                         fs_id=sup["created"]["feature_set_id"], family_id=family_id, role=arm)
                st["runs"][key] = rid
                self.save_state("s4", st)
            self.run_train_jobs([st["runs"][key]], f"s4 {arm} {enc}")
            rec = self.run_record(st["runs"][key])
            entry["run"] = rec
            entry["status"] = rec["status"]
            entry["comparison"] = self.compare({"ablation": rec["run_id"], "baseline": baseline[enc]["run_id"]})
            if rec["status"] != "succeeded":
                self.warnings.append(f"s4: {arm} {enc} run {rec['status']}: {str(rec['error'])[:300]}")
            return entry

        for arm, overrides, encs in arms:
            results[arm] = {}
            for enc in encs:
                try:
                    results[arm][enc] = arm_run(arm, enc, overrides)
                except StageError:
                    raise
                except Exception as exc:  # noqa: BLE001 - one failed arm is a result; the others still run
                    self.warnings.append(f"s4: {arm} {enc} raised {type(exc).__name__}: {exc}")
                    results[arm][enc] = {"arm": arm, "encoder": enc, "status": "error",
                                         "error": f"{type(exc).__name__}: {exc}",
                                         "traceback": traceback.format_exc()[-4000:]}
        # coverage side by side (sampling ablation)
        coverage = {}
        for enc in ENCODERS:
            base_fs = s3["feature_sets"][enc]["supervised_set"]["feature_set"]
            uni = ((results["a_sampling_uniform"].get(enc) or {}).get("feature_set") or {}).get("feature_set")
            keys = ("tissue_within_radius_of_sample_fraction", "sampled_tissue_fraction",
                    "fragments_without_sampled_patch")
            per = {}
            for r in base_fs["per_slide"]:
                per[r["slide_id"]] = {"spatial": {k: (r["coverage"] or {}).get(k) for k in keys}}
            for r in (uni or {}).get("per_slide", []):
                per.setdefault(r["slide_id"], {})["uniform"] = {k: (r["coverage"] or {}).get(k) for k in keys}
            coverage[enc] = {"aggregate": {"spatial": {k: base_fs["aggregate"]["coverage"].get(k) for k in keys
                                                       if k in base_fs["aggregate"]["coverage"]}
                                           | {"fragments_without_sampled_patch": stats(
                                               (r["coverage"] or {}).get("fragments_without_sampled_patch")
                                               for r in base_fs["per_slide"])},
                                           "uniform": ({k: uni["aggregate"]["coverage"].get(k) for k in keys
                                                        if k in uni["aggregate"]["coverage"]}
                                                       | {"fragments_without_sampled_patch": stats(
                                                           (r["coverage"] or {}).get("fragments_without_sampled_patch")
                                                           for r in uni["per_slide"])}) if uni else None},
                             "per_slide": per}
        # precision
        precision: dict
        try:
            precision = self.precision_study(s2, manifest)
        except Exception as exc:  # noqa: BLE001
            self.warnings.append(f"s4c: precision study raised {type(exc).__name__}: {exc}")
            precision = {"status": "error", "error": f"{type(exc).__name__}: {exc}",
                         "traceback": traceback.format_exc()[-4000:]}
        fp16 = ((precision.get("candidates") or {}).get("fp16") or {})
        downstream: dict
        if not fp16.get("accepted"):
            downstream = {"status": "not_run", "reason": "fp16 did not meet the documented acceptance rule"
                          if fp16 else "fp16 was not evaluated"}
        elif self.skip_precision_downstream:
            downstream = {"status": "skipped", "reason": "--skip-precision-downstream"}
        else:
            try:
                downstream = arm_run("c_precision_fp16", MIDNIGHT, {"precision": "fp16"})
            except Exception as exc:  # noqa: BLE001
                downstream = {"status": "error", "error": f"{type(exc).__name__}: {exc}"}
        precision["downstream_fp16"] = downstream
        with session_scope() as db:
            fam = db.get(ComparisonFamily, family_id)
            fam_status = fam.status
        return {"family": {"family_id": family_id, "status": fam_status, "bootstrap_seed": self.boot_seed},
                "head": "meanpool_logreg", "baselines": {e: r["run_id"] for e, r in baseline.items()},
                "arms": results, "coverage_side_by_side": coverage, "precision": precision,
                "macenko_note": "macenko-v1 references are fitted at build time on train-split slides of the dataset "
                                "only (never validation or test); the development pool here is the train split",
                **reference_standard_fields(manifest)}

    # ------------------------------------------------------------------ s5
    def s5(self) -> dict:
        s2, s3, s4 = self.require("s2"), self.load_report("s3"), self.load_report("s4")
        rate = self.args.hourly_rate
        rows = []

        def add(source: str, enc: str, summary: dict, cache: dict | None = None, extra: dict | None = None):
            fs = summary["feature_set"]
            agg = summary["aggregate"]
            fresh = agg.get("fresh") or {}
            per_slide_compute = (fresh.get("seconds_per_slide") or {}).get("mean")
            row = {"source": source, "encoder": enc, "device": (fs.get("extraction") or {}).get("device"),
                   "precision": fs.get("precision"), "feature_set_id": fs["feature_set_id"],
                   "slides": agg["done"], "fresh_extractions": agg["fresh_extractions"],
                   "patches_per_slide": agg.get("patches_per_slide"),
                   "patch_read_patches_per_second": fresh.get("read_patches_per_second"),
                   "embedding_patches_per_second": fresh.get("embed_patches_per_second"),
                   "end_to_end_patches_per_second": fresh.get("end_to_end_patches_per_second"),
                   "end_to_end_seconds_per_slide": fresh.get("seconds_per_slide"),
                   "compute_seconds_per_slide": per_slide_compute,
                   "peak_rss_bytes_max": agg.get("peak_rss_bytes_max"),
                   "storage_bytes_per_slide": agg.get("storage_bytes_per_slide"),
                   "cache_reuse_speedup": ((cache or {}).get("re_extraction") or {}).get("speedup"),
                   "cache_hit_seconds_per_slide": ((cache or {}).get("re_extraction") or {}).get("seconds_per_slide"),
                   "cost_per_slide": (per_slide_compute * rate / 3600.0) if (rate and per_slide_compute) else None}
            row.update(extra or {})
            rows.append(row)

        for enc, e in s2["encoders"].items():
            add("s2 technical", enc, e["feature_set"], e.get("cache_reuse"),
                {"build_wall_seconds": (e.get("build") or {}).get("wall_seconds"),
                 "build_overhead_seconds": (e.get("build") or {}).get("overhead_seconds")})
        if s4:
            entries = [(arm, enc, entry) for arm, by_enc in (s4.get("arms") or {}).items()
                       for enc, entry in by_enc.items()]
            down = (s4.get("precision") or {}).get("downstream_fp16") or {}
            if down.get("feature_set"):
                entries.append(("c_precision_fp16", MIDNIGHT, down))
            for arm, enc, entry in entries:
                fs = (entry.get("feature_set") or {}).get("feature_set")
                if fs and (fs["aggregate"].get("fresh_extractions") or 0) > 0:
                    add(f"s4 {arm}", enc, fs)
        training = []
        if s3:
            for r in s3["runs"]:
                t = r.get("timings_seconds") or {}
                training.append({"run_id": r["run_id"], "encoder": r["encoder"], "head": r["head"],
                                 "fraction": r["fraction"], "training_seconds": t.get("training"),
                                 "total_seconds": t.get("total"),
                                 "development_slides": ((r.get("oof") or {}).get("n_items") or 0)
                                 + ((r.get("oof") or {}).get("n_unscorable") or 0)})
        precision = None
        if s4 and isinstance(s4.get("precision"), dict) and s4["precision"].get("fp32"):
            p = s4["precision"]
            precision = {"device": p.get("device"), "n_patches": (p.get("patches") or {}).get("n_patches"),
                         "fp32_patches_per_second": (p["fp32"].get("throughput") or {}).get("patches_per_second"),
                         **{prec: {"supported": c.get("supported"), "accepted": c.get("accepted"),
                                   "patches_per_second": (c.get("throughput") or {}).get("patches_per_second"),
                                   "speedup_vs_fp32": c.get("speedup_vs_fp32"),
                                   "cosine_min": (c.get("comparison") or {}).get("cosine_min"),
                                   "rel_l2": (c.get("comparison") or {}).get("rel_l2")}
                            for prec, c in (p.get("candidates") or {}).items()}}
        return {"extraction": rows,
                "training": {"runs": training,
                             "training_seconds": stats(t["training_seconds"] for t in training),
                             "by_head": {h: stats(t["training_seconds"] for t in training if t["head"] == h)
                                         for h in HEADS}},
                "precision_throughput": precision,
                "cost": {"formula": "cost_per_slide = compute_seconds_per_slide x hourly_rate / 3600",
                         "hourly_rate": rate,
                         "note": "compute_seconds_per_slide is the mean end-to-end extraction time of freshly "
                                 "extracted slides (read + preprocess + embed + write) on this machine; no price is "
                                 "assumed" + ("" if rate else "; pass --hourly-rate to evaluate the formula")},
                "definitions": {
                    "patch_read_patches_per_second": "patches / read_seconds (OpenSlide read + resize, read filters)",
                    "embedding_patches_per_second": "patches / embed_seconds (encoder forward pass only)",
                    "peak_rss_bytes_max": "process peak resident set size (getrusage; monotonic over the process)",
                    "storage_bytes_per_slide": "embeddings .npy + coords/quality .npz, content-addressed",
                    "cache_reuse_speedup": "first extraction seconds / cache-hit re-extraction seconds"}}

    # ------------------------------------------------------------------ s6
    def read_test(self, run_id: str, what: str) -> dict:
        """The stored test evaluation through the same gate as GET /experiments/{id}/evaluation?split=test (test
        unlocked, dataset.test_access, stored result only, one experiment.test_accessed audit row)."""
        from dermpath import audit
        from dermpath.db import session_scope
        from dermpath.ml.evaluation import evaluation_response, require_test_unlocked, stored_test_evaluation
        from dermpath.ml.models import TrainingRun

        with session_scope() as db:
            run = db.get(TrainingRun, run_id)
            require_test_unlocked(run)
            self.authorize(db, "dataset.test_access")
            ev = stored_test_evaluation(db, run)
            body = evaluation_response(ev, run)
            audit.record_for(db, self.actor, project_id=run.project_id, action="experiment.test_accessed",
                             entity_type="training_run", entity_id=run.id,
                             after={"what": what, "evaluation_id": ev.id,
                                    "test_release_id": (ev.metrics_json or {}).get("test_release_id")})
        return body

    def s6(self, forced: bool) -> dict:
        from dermpath.db import session_scope
        from dermpath.ml.evaluation import (create_test_release, releases_for_run, test_release_dict,
                                            test_release_status)
        from dermpath.ml.inference import build_bundle, bundle_dict
        from dermpath.ml.models import TrainingRun
        from dermpath.ml.service import model_dict, register_model

        s3 = self.require("s3")
        s3_path = self.report_path("s3")
        cand = s3.get("pre_declared_test_candidate")
        if not cand or not (cand.get("chosen") or {}).get("run_id"):
            raise StageError("the s3 report has no pre-declared test candidate; s6 refuses to choose one")
        if cand.get("rule") != CANDIDATE_RULE:
            raise StageError("the s3 candidate rule differs from the driver's pre-declared rule")
        run_id = cand["chosen"]["run_id"]
        st = self.state("s6")
        justification = (self.args.justification or "").strip() or None
        history = list(st.get("invocations") or [])
        # Register the candidate (idempotent per run) and build its immutable inference bundle.
        with session_scope() as db:
            run = db.get(TrainingRun, run_id)
            if run is None or run.status != "succeeded":
                raise StageError(f"candidate run {run_id} is not a succeeded run")
            self.authorize(db, "model.register")
            mv, mv_created = register_model(db, self.actor, run, note="s6: pre-declared COBRA candidate")
            bundle, b_created, unavailable = build_bundle(db, self.actor, run)
            if bundle is None:
                raise StageError(f"no inference bundle: {unavailable}")
            registry = {"model": model_dict(mv), "model_created": mv_created, "bundle_id": bundle.id,
                        "bundle_created": b_created, "bundle": bundle_dict(db, bundle)}
            prior = releases_for_run(db, run)
            status_before = test_release_status(db, run, actor_role=self.actor.role)
        action: str
        if prior:
            rel_id = prior[-1].id
            if st.get("release_id") == rel_id and not forced:
                action = "resumed the release recorded by an earlier invocation (no new test release)"
            elif forced:
                action = ("--force s6: the candidate run was already released (the engine refuses a second release "
                          "of one run); its stored result is re-read (audited), no new release")
            else:
                raise StageError("the candidate run already has a test release that this driver did not record; "
                                 "refusing to continue without --force s6 and --justification",
                                 releases=[r.id for r in prior])
        else:
            self.log(f"s6: test release of run {run_id} ({cand['chosen']['encoder']} · {cand['chosen']['head']})")
            with session_scope() as db:
                run = db.get(TrainingRun, run_id)
                self.authorize(db, "dataset.test_access")
                rel, job = create_test_release(db, self.actor, run, reason=RELEASE_REASON,
                                               justification=justification if forced else None, candidate="bundle")
                rel_id, job_id = rel.id, job.id
            st.update(release_id=rel_id, job_id=job_id, released_at=now_iso())
            self.save_state("s6", st)
            action = "new test release recorded" + (" (forced, with justification)" if forced else "")
        with session_scope() as db:
            from dermpath.ml.engine_models import TestRelease

            rel = db.get(TestRelease, rel_id)
            job_id = rel.job_id
        self.run_jobs([job_id], ["evaluate_test_release"], "test release scoring")
        body = self.read_test(run_id, "evaluation")
        with session_scope() as db:
            from dermpath.ml.engine_models import TestRelease

            release = test_release_dict(db, db.get(TestRelease, rel_id))
        history.append({"at": now_iso(), "action": action, "forced": forced, "justification": justification,
                        "release_id": rel_id})
        st["invocations"] = history
        self.save_state("s6", st)
        m = body.get("metrics") or {}
        return {
            "candidate": cand, "s3_report": {"path": str(s3_path), "sha256": sha256_file(s3_path),
                                             "candidate_declared_at": cand.get("declared_at")},
            "action": action, "reason": RELEASE_REASON, "justification": justification,
            "registry": registry, "test_release_status_before": status_before, "test_release": release,
            "release_number": body.get("release_number"), "test_release_id": body.get("test_release_id"),
            "prior_releases_on_manifest": body.get("prior_releases_on_manifest"),
            "prior_releases_on_test_patients": body.get("prior_releases_on_test_patients"),
            "test_metrics": {k: metric_entry(m.get(k)) for k in ("auroc", "auprc", "sensitivity", "specificity",
                                                                  "ppv", "npv", "brier") if k in m},
            "evaluation_prevalence": body.get("evaluation_prevalence"),
            "unscorable": {k: body.get(k) for k in ("n_unscorable", "unscorable_positives", "unscorable_negatives",
                                                    "unscored")},
            "intention_to_evaluate": body.get("intention_to_evaluate"),
            "counts": {k: body.get(k) for k in ("n_items", "n_patients", "n_scored_patients", "positives",
                                                "negatives", "positive_patients", "negative_patients")},
            "reference_standard": body.get("reference_standard"),
            "reference_standard_notice": body.get("reference_standard_notice"),
            "test_evaluation": body,
            "invocations": history,
            "audit": "one experiment.test_accessed row was written for this read (same gate as the router)",
        }

    # ------------------------------------------------------------------ s7
    def s7(self) -> dict:
        from dermpath.db import session_scope
        from dermpath.ml.evaluation import errors_response
        from dermpath.ml.models import TrainingRun

        s3, s6 = self.require("s3"), self.load_report("s6")
        runs = []
        totals: dict[str, int] = {}
        grid_totals: dict[str, int] = {}
        for r in s3["runs"]:
            if r["status"] != "succeeded":
                runs.append({"run_id": r["run_id"], "encoder": r["encoder"], "head": r["head"], "role": r["role"],
                             "fraction": r["fraction"], "repeat": r["repeat"], "status": r["status"],
                             "error": r["error"]})
                continue
            with session_scope() as db:
                self.authorize(db, "experiment.read")
                er = errors_response(db, db.get(TrainingRun, r["run_id"]), "oof")
            cats = er["categories"]
            for k, v in (cats.get("counts") or {}).items():
                totals[k] = totals.get(k, 0) + int(v or 0)
                if r["role"] == "grid":
                    grid_totals[k] = grid_totals.get(k, 0) + int(v or 0)
            runs.append({"run_id": r["run_id"], "encoder": r["encoder"], "head": r["head"], "role": r["role"],
                         "fraction": r["fraction"], "repeat": r["repeat"], "status": r["status"],
                         "counts": er["counts"], "categories": cats.get("counts"),
                         "counts_by_error_type": cats.get("counts_by_error_type"),
                         "not_assessable": cats.get("not_assessable"),
                         "errors": [{k: e.get(k) for k in ("bag_id", "patient_code", "label", "score", "threshold",
                                                           "error_type", "categories", "relative_margin",
                                                           "failure_reason")} for e in er["items"]]})
        test = None
        if s6:
            fa = (s6.get("test_evaluation") or {}).get("failure_analysis") or {}
            test = {"run_id": s6["candidate"]["chosen"]["run_id"], "release_number": s6.get("release_number"),
                    "counts": fa.get("counts"), "counts_by_error_type": fa.get("counts_by_error_type"),
                    "not_assessable": fa.get("not_assessable"),
                    "n_errors": len(fa.get("errors") or []),
                    "errors": [{k: e.get(k) for k in ("bag_id", "error_type", "reference", "predicted", "categories",
                                                      "relative_margin", "description")}
                               for e in fa.get("errors") or []],
                    "source": "the stored test evaluation in s6.json (no new test access)"}
        slopes = []
        for c in s3.get("learning_curves") or []:
            pts = [(p["fraction"], (p.get("train_patients") or {}).get("mean"), p.get("auroc_mean"))
                   for p in c["points"] if p.get("auroc_mean") is not None]
            entry = {"encoder": c["encoder"], "head": c["head"], "points": [
                {"fraction": f, "train_patients": n, "auroc_mean": a} for f, n, a in pts]}
            if len(pts) >= 2:
                xs = [math.log2(n) for _, n, _ in pts if n]
                ys = [a for _, n, a in pts if n]
                if len(xs) >= 2 and len(set(xs)) >= 2:
                    mx, my = statistics.fmean(xs), statistics.fmean(ys)
                    entry["auroc_per_doubling_of_patients"] = (sum((x - mx) * (y - my) for x, y in zip(xs, ys))
                                                               / sum((x - mx) ** 2 for x in xs))
                (f1, n1, a1), (f2, n2, a2) = pts[-2], pts[-1]
                entry["last_segment"] = {"from_fraction": f1, "to_fraction": f2, "delta_auroc": a2 - a1,
                                         "per_doubling": ((a2 - a1) / math.log2(n2 / n1)) if n1 and n2 and n2 > n1
                                         else None}
                entry["note"] = ("least-squares slope of the mean OOF AUROC on log2(train patients); few repeats, no "
                                 "interval: descriptive only")
            else:
                entry["note"] = "fewer than two defined points"
            slopes.append(entry)

        def ranked(d):
            tot = sum(d.values()) or 0
            return [{"category": k, "count": v, "share_of_category_tags": (v / tot) if tot else None}
                    for k, v in sorted(d.items(), key=lambda kv: (-kv[1], kv[0])) if v]

        return {"oof_runs": runs, "test_errors_of_candidate": test, "learning_curve_slopes": slopes,
                "dominant_categories": {"grid_runs_oof": ranked(grid_totals), "all_s3_runs_oof": ranked(totals),
                                        "test_candidate": ranked((test or {}).get("counts") or {})},
                "note": "Categories are possible contributing factors, never causes; a bag can carry several. "
                        "'possible_label_error' needs a reader disagreement on record; with imported reference "
                        "labels, discordances are 'discordance with the imported reference', not proof of a label "
                        "error.",
                "reference_standard": s3.get("reference_standard"),
                "reference_standard_notice": s3.get("reference_standard_notice")}

    # ------------------------------------------------------------------ s8
    def s8(self) -> dict:
        reps = {s: self.load_report(s) for s in STAGES if s != "s8"}
        links = {}
        for s, r in reps.items():
            p = self.report_path(s)
            links[s] = {"title": TITLES[s], "path": str(p), "exists": r is not None,
                        "sha256": sha256_file(p) if r is not None else None,
                        "elapsed_seconds": (r or {}).get("elapsed_seconds"),
                        "finished_at": (r or {}).get("finished_at"), "warnings": len((r or {}).get("warnings") or [])}
        key: dict = {}
        if reps["s1"]:
            d = reps["s1"]["dataset"]
            key["dataset"] = {"dataset_version_id": d["dataset_version_id"], "manifest_sha256": d["manifest_sha256"],
                              "counts": d.get("counts"), "split_table": reps["s1"]["split_table"],
                              "development_pool_patients": reps["s1"].get("development_pool_patients"),
                              "test_patients": reps["s1"].get("test_patients")}
        if reps["s2"]:
            key["technical"] = {e: {"feature_set_id": v["created"]["feature_set_id"],
                                    "validation_passed": v.get("technical_validation", {}).get("passed"),
                                    "max_abs_diff": ((v.get("technical_validation", {}).get("result") or {})
                                                     .get("summary") or {}).get("max_abs_diff"),
                                    "patches_total": v["feature_set"]["aggregate"]["patches_total"],
                                    "embed_patches_per_second": (v["feature_set"]["aggregate"].get("fresh") or {})
                                    .get("embed_patches_per_second"),
                                    "coverage_tissue_within_radius_median": ((v["feature_set"]["aggregate"]["coverage"]
                                                                              .get("tissue_within_radius_of_sample_fraction")
                                                                              or {}).get("median")),
                                    "cache_hit_all": v.get("cache_reuse", {}).get("re_extraction", {})
                                    .get("all_cache_hits")}
                                for e, v in reps["s2"]["encoders"].items()}
        if reps["s3"]:
            s3 = reps["s3"]
            key["baselines_oof"] = [{"encoder": r["encoder"], "head": r["head"], "status": r["status"],
                                     "auroc": ((r.get("oof") or {}).get("threshold_free") or {}).get("auroc"),
                                     "auprc": ((r.get("oof") or {}).get("threshold_free") or {}).get("auprc"),
                                     "sensitivity": ((r.get("oof") or {}).get("at_operating_point") or {})
                                     .get("sensitivity"),
                                     "specificity": ((r.get("oof") or {}).get("at_operating_point") or {})
                                     .get("specificity")}
                                    for r in s3["runs"] if r["role"] == "grid"]
            key["comparisons_oof"] = {g: [{"fixed": c.get("fixed"), "status": c.get("status"),
                                           "deltas": [{"a": d["a"], "b": d["b"], "auroc": d.get("auroc"),
                                                       "auprc": d.get("auprc")} for d in c.get("deltas") or []]}
                                          for c in cs] for g, cs in s3["comparisons"].items()}
            key["test_candidate"] = {k: s3["pre_declared_test_candidate"].get(k) for k in ("rule", "declared_at")} | {
                "chosen": {k: s3["pre_declared_test_candidate"]["chosen"].get(k)
                           for k in ("encoder", "head", "run_id")}}
        if reps["s4"]:
            key["ablations_oof"] = {arm: {e: {"status": v.get("status"),
                                              "deltas": [{"a": d["a"], "b": d["b"], "auroc": d.get("auroc")}
                                                         for d in (v.get("comparison") or {}).get("deltas") or []]}
                                          for e, v in by.items()} for arm, by in reps["s4"]["arms"].items()}
            prec = reps["s4"].get("precision") or {}
            key["precision"] = {p: {"accepted": c.get("accepted"),
                                    "cosine_min": (c.get("comparison") or {}).get("cosine_min"),
                                    "rel_l2": (c.get("comparison") or {}).get("rel_l2"),
                                    "speedup_vs_fp32": c.get("speedup_vs_fp32")}
                                for p, c in (prec.get("candidates") or {}).items()}
            down = prec.get("downstream_fp16") or {}
            key["precision_downstream_fp16"] = {
                "status": down.get("status"), "reason": down.get("reason"),
                "deltas": [{"a": d["a"], "b": d["b"], "auroc": d.get("auroc")}
                           for d in (down.get("comparison") or {}).get("deltas") or []]}
        if reps["s5"]:
            key["resources"] = [{k: r.get(k) for k in ("source", "encoder", "device", "precision",
                                                       "embedding_patches_per_second", "patch_read_patches_per_second",
                                                       "compute_seconds_per_slide", "peak_rss_bytes_max",
                                                       "cost_per_slide")}
                                | {"storage_bytes_per_slide_mean": (r.get("storage_bytes_per_slide") or {}).get("mean"),
                                   "cache_speedup_median": (r.get("cache_reuse_speedup") or {}).get("median")}
                                for r in reps["s5"]["extraction"]]
        if reps["s6"]:
            s6 = reps["s6"]
            key["test_release"] = {"release_number": s6.get("release_number"),
                                   "test_release_id": s6.get("test_release_id"), "metrics": s6.get("test_metrics"),
                                   "evaluation_prevalence": s6.get("evaluation_prevalence"),
                                   "unscorable": {k: v for k, v in (s6.get("unscorable") or {}).items()
                                                  if k != "unscored"},
                                   "reference_standard": s6.get("reference_standard")}
        if reps["s7"]:
            key["failure_analysis"] = {"dominant_categories": reps["s7"]["dominant_categories"],
                                       "learning_curve_slopes": [{k: c.get(k) for k in (
                                           "encoder", "auroc_per_doubling_of_patients", "last_segment")}
                                           for c in reps["s7"]["learning_curve_slopes"]]}
        caveats = list(CAVEATS)
        if reps["s1"]:
            c = (reps["s1"]["dataset"].get("counts") or {})
            caveats[2] = (f"Small cohort ({c.get('patients')} patients, {c.get('slides')} slides; "
                          f"{reps['s1'].get('test_patients')} test patients): confidence intervals are wide.")
        if self.dry:
            caveats.insert(0, "DRY RUN on a throwaway database with tiny budgets: these numbers prove the plumbing "
                              "only and say nothing about performance.")
        stage_warnings = {s: (r or {}).get("warnings") or [] for s, r in reps.items()}
        return {"stages": links, "elapsed_seconds_per_stage": {s: v["elapsed_seconds"] for s, v in links.items()},
                "elapsed_seconds_total": sum(v["elapsed_seconds"] or 0 for v in links.values()),
                "key_numbers": key, "caveats": caveats, "stage_warnings": stage_warnings,
                "missing_stages": [s for s, r in reps.items() if r is None]}

    # =============================================================================================== orchestration
    def status(self) -> int:
        for s in STAGES:
            r = self.load_report(s)
            err = self.state_dir / f"{s}.error.json"
            print(f"{s}  {TITLES[s]:<70} {'done ' + str(r.get('finished_at')) if r else 'pending'}"
                  f"{'  (last error recorded)' if err.is_file() else ''}")
        return 0

    def run(self) -> int:
        self.actor = self.lead()
        rc = 0
        for stage in STAGES:
            if stage not in self.only:
                continue
            forced = stage in self.force
            if self.report_path(stage).is_file() and not forced:
                self.log(f"{stage}: skipped (report exists: {self.report_path(stage)}; --force {stage} re-runs it)")
                continue
            if stage == "s6" and forced and self.report_path("s6").is_file() and not (self.args.justification or
                                                                                      "").strip():
                self.log("s6: refused: a test release was already reported; re-running s6 needs --force s6 AND "
                         "--justification \"<why another look at the test patients is warranted>\"")
                return 1
            missing = [d for d in REQUIRES[stage] if not self.report_path(d).is_file()]
            if missing:
                self.log(f"{stage}: cannot run: missing report(s) {missing}")
                return 1
            self.log(f"{stage}: {TITLES[stage]}")
            self.t_stage = time.perf_counter()
            self.warnings = []
            started = now_iso()
            if forced and stage in ("s3", "s4"):
                self.reset_state(stage)  # a forced s3/s4 starts a new family with new runs
            try:
                body = self.s6(forced) if stage == "s6" else getattr(self, stage)()
            except Exception as exc:  # noqa: BLE001 - recorded, then the run stops (later stages depend on it)
                err = {"stage": stage, "at": now_iso(), "error": f"{type(exc).__name__}: {exc}",
                       "details": getattr(exc, "details", None), "traceback": traceback.format_exc()}
                try:
                    from dermpath.errors import ApiError

                    if isinstance(exc, ApiError):
                        err["api_error"] = {"code": exc.code, "message": exc.message, "details": exc.details}
                except Exception:  # noqa: BLE001
                    pass
                self.write_json(self.state_dir / f"{stage}.error.json", err)
                self.log(f"{stage}: FAILED: {err['error'][:500]} (details in {self.state_dir / (stage + '.error.json')})")
                rc = 1
                break
            if forced:
                self.archive(stage)
            path = self.write_report(stage, body, started)
            (self.state_dir / f"{stage}.error.json").unlink(missing_ok=True)
            self.log(f"{stage}: done in {time.perf_counter() - self.t_stage:.1f}s -> {path}")
        return rc


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    for n, v in (("--max-patches", args.max_patches), ("--cv-folds", args.cv_folds), ("--lc-repeats", args.lc_repeats),
                 ("--n-boot", args.n_boot)):
        if v is not None and v < 1:
            print(f"error: {n} must be at least 1", file=sys.stderr)
            return 2
    if args.cv_folds is not None and args.cv_folds < 2:
        print("error: --cv-folds must be at least 2", file=sys.stderr)
        return 2
    print("DermPath Research Workbench, COBRA experiment driver. RESEARCH USE ONLY: not a medical device; outputs "
          "are not diagnoses. Local database only; nothing is downloaded.", file=sys.stderr)
    d = Driver(args)
    d.setup()
    if args.status:
        return d.status()
    return d.run()


if __name__ == "__main__":
    raise SystemExit(main())
