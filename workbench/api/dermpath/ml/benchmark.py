"""Benchmark harness and learning curves (design §6). Research use only.

:func:`run_benchmark` runs an encoder × head grid on ONE frozen manifest (identical patient
splits for every run) and groups the runs in a ``comparison_family`` whose bootstrap seed is
shared by every paired comparison:

* one feature set per encoder, built with the SAME patch and sampling policy (only
  ``patch_size`` follows each encoder's ``input_size``; encoders never resize);
* equal optimisation budgets per head: the head parameters are the same for every encoder
  and are documented in the report (``optimisation_budgets``);
* learning curves: nested, stratified, deterministic subsets of TRAIN patients
  (``train_patient_fraction`` × ``subset_repeat``; in ``dev_cv`` the subset restricts the
  fitting part of each fold and the final refit), evaluated on validation or out-of-fold
  predictions only, reported with patient counts and CIs;
* paired comparisons (:func:`dermpath.ml.comparison.paired_comparison`) on the development
  predictions (validation or out-of-fold, never test): encoder effects with the head fixed,
  head effects with the encoder fixed. No winner is declared; selection is a human decision.

In ``real_image_technical`` mode no label is read: only the feature sets are built (and,
when requested, technically validated) and their coverage diagnostics reported.

Configurations are JSON files under ``workbench/experiments/configs/``; the command line is
``python -m dermpath.ml.cli benchmark <config.json>``. The results JSON is written to
``report_path``.
"""

from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Callable
from pathlib import Path

from sqlalchemy import select

from .. import audit
from ..auth import Actor
from ..config import WORKBENCH_DIR
from ..db import session_scope, utcnow
from ..models import DatasetVersion, Job, Project
from . import PIPELINE_TEST_BANNER, RESEARCH_NOTICE
from .comparison import ComparisonRefused, ScoreSet, paired_comparison
from .config import EVALUATION_PROTOCOLS, HEADS, feature_params, resolve_experiment_params
from .encoders import get_encoder
from .engine_models import EXECUTION_MODES, ComparisonFamily, FeatureSet
from .evaluation import reference_standard_fields
from .heads import OPTIMISATION_BUDGETS
from .models import Prediction, TrainingRun

BENCHMARK_SCHEMA = "dermpath.benchmark/1"
CONFIG_KEYS = {"name", "project_id", "dataset", "dataset_version_id", "execution_mode", "evaluation_protocol",
               "encoders", "heads", "seeds", "params", "head_params", "learning_curve", "bootstrap", "report_path",
               "actor", "technical_validation", "description"}
LC_KEYS = {"fractions", "repeats", "encoders", "heads"}
DEFAULT_ACTOR = {"id": "system:benchmark", "role": "research_lead", "display_name": "Benchmark harness"}
REPORTS_DIR = WORKBENCH_DIR / "experiments" / "reports"
JOB_TYPES = ["build_feature_set", "train"]
SELECTION_NOTE = ("No winner is declared. Comparisons use development predictions only (validation for holdout, "
                  "out-of-fold for dev_cv) with one shared patient-level bootstrap seed; the test split is never "
                  "read here. Selecting a candidate (and locking the family before any test release) is a human "
                  "decision.")
LEARNING_CURVE_NOTE = ("Nested stratified subsets of training patients; every point is evaluated on the same "
                       "development set (validation or out-of-fold), never on test.")


class BenchmarkError(ValueError):
    """The benchmark configuration is invalid or cannot run on this database."""


# --------------------------------------------------------------------------- configuration


def load_config(path: str | Path) -> dict:
    data = json.loads(Path(path).read_text())
    if not isinstance(data, dict):
        raise BenchmarkError("a benchmark configuration is a JSON object")
    return data


def validate_config(config: dict) -> dict:
    """Normalised configuration. Unknown keys are refused (keys starting with ``_`` are
    comments)."""
    cfg = {k: v for k, v in config.items() if not str(k).startswith("_")}
    unknown = sorted(set(cfg) - CONFIG_KEYS)
    if unknown:
        raise BenchmarkError(f"unknown benchmark config key(s) {unknown}; allowed: {sorted(CONFIG_KEYS)}")
    for key in ("name", "project_id", "encoders"):
        if not cfg.get(key):
            raise BenchmarkError(f"benchmark config needs {key!r}")
    if "dataset" not in cfg and "dataset_version_id" not in cfg:
        raise BenchmarkError("benchmark config needs 'dataset' ({'name', 'version'?} or 'latest_frozen') or "
                             "'dataset_version_id'")
    encoders = list(cfg["encoders"])
    unknown_enc = [e for e in encoders if get_encoder(e) is None]
    if unknown_enc or len(set(encoders)) != len(encoders):
        raise BenchmarkError(f"encoders must be distinct registered encoder ids (unknown: {unknown_enc})")
    mode = cfg.get("execution_mode")
    if mode is not None and mode not in EXECUTION_MODES:
        raise BenchmarkError(f"execution_mode must be one of {list(EXECUTION_MODES)}")
    technical = mode == "real_image_technical"
    heads = list(cfg.get("heads") or ([] if technical else list(HEADS)))
    if technical and heads:
        raise BenchmarkError("real_image_technical reads no labels: a technical benchmark has no heads")
    if any(h not in HEADS for h in heads) or len(set(heads)) != len(heads):
        raise BenchmarkError(f"heads must be distinct values of {list(HEADS)}")
    protocol = cfg.get("evaluation_protocol", "holdout")
    if protocol not in EVALUATION_PROTOCOLS:
        raise BenchmarkError(f"evaluation_protocol must be one of {list(EVALUATION_PROTOCOLS)}")
    seeds = [int(s) for s in (cfg.get("seeds") or [0])]
    params = dict(cfg.get("params") or {})
    for k in ("train_patient_fraction", "subset_repeat"):
        if k in params:
            raise BenchmarkError(f"{k} is set by the learning_curve block, not by params")
    head_params = {h: dict(v or {}) for h, v in (cfg.get("head_params") or {}).items()}
    if set(head_params) - set(HEADS):
        raise BenchmarkError(f"head_params keys must be heads ({list(HEADS)})")
    lc = cfg.get("learning_curve")
    if lc is not None:
        if technical:
            raise BenchmarkError("learning curves need labels; not available in real_image_technical")
        if set(lc) - LC_KEYS:
            raise BenchmarkError(f"unknown learning_curve key(s) {sorted(set(lc) - LC_KEYS)}")
        fractions = sorted({float(f) for f in lc.get("fractions") or []})
        if not fractions or fractions[0] <= 0.0 or fractions[-1] > 1.0:
            raise BenchmarkError("learning_curve.fractions must lie in (0, 1]")
        repeats = int(lc.get("repeats", 3))
        if repeats < 1:
            raise BenchmarkError("learning_curve.repeats must be at least 1")
        lc = {"fractions": fractions, "repeats": repeats,
              "encoders": list(lc.get("encoders") or encoders), "heads": list(lc.get("heads") or heads)}
        if set(lc["encoders"]) - set(encoders) or set(lc["heads"]) - set(heads):
            raise BenchmarkError("learning_curve encoders/heads must be part of the grid")
    boot = {"n_boot": 2000, "seed": None, "min_patients": 10, **(cfg.get("bootstrap") or {})}
    actor = {**DEFAULT_ACTOR, **(cfg.get("actor") or {})}
    return {**cfg, "encoders": encoders, "heads": heads, "seeds": seeds, "evaluation_protocol": protocol,
            "params": params, "head_params": head_params, "learning_curve": lc, "bootstrap": boot, "actor": actor,
            "technical": technical}


def _slug(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:80] or "benchmark"


def default_report_path(name: str) -> Path:
    return REPORTS_DIR / f"{_slug(name)}.json"


def bootstrap_seed_for(cfg: dict, manifest_sha256: str) -> int:
    """The family's shared bootstrap seed: configured, or derived from the name and manifest."""
    if cfg["bootstrap"].get("seed") is not None:
        return int(cfg["bootstrap"]["seed"])
    return int(hashlib.sha256(f"{cfg['name']}|{manifest_sha256}".encode()).hexdigest()[:8], 16) % (2**31 - 1)


def resolve_dataset(db, project_id: str, cfg: dict) -> DatasetVersion:
    if cfg.get("dataset_version_id"):
        dv = db.get(DatasetVersion, cfg["dataset_version_id"])
    else:
        ref = cfg["dataset"]
        q = select(DatasetVersion).where(DatasetVersion.project_id == project_id, DatasetVersion.status == "frozen")
        if isinstance(ref, dict):
            if ref.get("name"):
                q = q.where(DatasetVersion.name == ref["name"])
            if ref.get("version") is not None:
                q = q.where(DatasetVersion.version == int(ref["version"]))
        elif ref != "latest_frozen":
            raise BenchmarkError("dataset must be {'name': ..., 'version'?: ...} or 'latest_frozen'")
        dv = db.scalars(q.order_by(DatasetVersion.frozen_at.desc(), DatasetVersion.version.desc())).first()
    if dv is None or dv.project_id != project_id:
        raise BenchmarkError(f"no matching frozen dataset version in project {project_id} "
                             f"({cfg.get('dataset_version_id') or cfg.get('dataset')}); import and freeze it first")
    if dv.status != "frozen" or not dv.manifest_json:
        raise BenchmarkError(f"dataset version {dv.id} is not frozen")
    return dv


# --------------------------------------------------------------------------- execution


def run_queued_jobs(job_ids: list[str], *, worker_id: str = "benchmark-in-process", max_jobs: int = 10000) -> list:
    """Run queued build/train jobs in this process until every job in ``job_ids`` has
    finished (other queued jobs of these types may run first)."""
    from ..jobs.worker import Worker

    worker = Worker(worker_id, record_heartbeat=False, types=JOB_TYPES)
    outcomes = []
    pending = set(job_ids)
    for _ in range(max_jobs):
        with session_scope() as db:
            pending = {j for j in pending if (job := db.get(Job, j)) is not None
                       and job.status in ("queued", "running")}
        if not pending:
            break
        o = worker.run_once()
        if o is None:
            break  # what remains is leased by another worker
        outcomes.append(o)
    return outcomes


def _variant_params(cfg: dict, head: str, *, fraction: float = 1.0, repeat: int = 0) -> dict:
    p = {**cfg["params"], **cfg["head_params"].get(head, {})}
    if fraction < 1.0:
        p.update({"train_patient_fraction": float(fraction), "subset_repeat": int(repeat)})
    return p


def _feature_sets(db, actor: Actor, project: Project, dv: DatasetVersion, cfg: dict, mode: str) -> dict:
    from . import feature_sets as fsets

    out = {}
    for enc in cfg["encoders"]:
        spec = get_encoder(enc).spec
        resolved = resolve_experiment_params(cfg["params"], encoder_spec=spec)
        out[enc] = fsets.create_feature_set(db, actor, project, encoder_id=enc, execution_mode=mode,
                                            dataset_version_id=dv.id, params=feature_params(resolved),
                                            name=f"{cfg['name']} · {enc}")
    return out


def _policy_check(sets: dict) -> dict:
    """Patch and sampling policies must be identical across encoders except ``patch_size``."""
    def strip(fs):
        pol = dict(fs.patch_policy_json or {})
        pol.pop("patch_size", None)
        return json.dumps(pol, sort_keys=True)

    shapes = {enc: strip(fs) for enc, fs in sets.items()}
    same = len(set(shapes.values())) <= 1
    return {"identical_except_patch_size": same,
            "patch_size": {enc: (fs.patch_policy_json or {}).get("patch_size") for enc, fs in sets.items()},
            "policy_sha256": {enc: fs.policy_sha256 for enc, fs in sets.items()}}


def _metric_entry(entry: dict | None) -> dict | None:
    if not entry:
        return None
    return {k: entry.get(k) for k in ("value", "ci", "ci_reason", "numerator", "denominator", "undefined_reason")
            if k in entry}


def _run_record(run: TrainingRun, variant: dict) -> dict:
    m = run.metrics_json or {}
    dev_split = (run.threshold_json or {}).get("selected_on")
    s = m.get(f"{dev_split}_summary") or {}
    rec = {"run_id": run.id, **variant, "status": run.status, "error": run.error, "development_split": dev_split,
           "feature_set_id": run.feature_set_id, "identity_sha256": run.identity_sha256,
           "checkpoint_sha256": run.checkpoint_sha256, "threshold": run.threshold_value,
           "threshold_rule": run.threshold_rule,
           "threshold_selection_status": (run.threshold_json or {}).get("selection_status")}
    if s:
        rec["development"] = {
            "n_items": s.get("n_items"), "n_patients": s.get("n_patients"), "n_unscorable": s.get("n_unscorable"),
            "tuning_set": s.get("tuning_set"),
            "threshold_free": {k: _metric_entry(v) for k, v in (s.get("threshold_free") or {}).items()},
            "at_operating_point": {k: _metric_entry(v) for k, v in (s.get("at_operating_point") or {}).items()}}
        lc = (m.get("protocol") or {}).get("learning_curve")
        sc = run.split_counts_json or {}
        pool = ("train", "val") if run.evaluation_protocol == "dev_cv" else ("train",)
        rec["train_patients"] = lc["n_patients"] if lc else sum((sc.get(k) or {}).get("patients", 0) for k in pool)
        rec["training"] = {k: (m.get("training") or {}).get(k) for k in ("epochs_run", "best_epoch", "n_iter",
                                                                        "converged", "train_bags", "fit_bags")}
    return rec


def _score_set(db, run: TrainingRun, name: str, dv: DatasetVersion) -> ScoreSet:
    split = (run.threshold_json or {}).get("selected_on") or "val"
    preds = db.scalars(select(Prediction).where(Prediction.run_id == run.id, Prediction.split == split)
                       .order_by(Prediction.bag_id)).all()
    return ScoreSet(name=name, bag_ids=[p.bag_id for p in preds],
                    patients=[p.patient_code or p.coded_patient_id for p in preds],  # content-stable clusters
                    labels=[p.label for p in preds], scores=[p.score for p in preds],
                    threshold=float(run.threshold_value), manifest_sha256=dv.manifest_sha256,
                    split_fingerprint=(dv.manifest_json or {}).get("split_fingerprint"))


def _restrict(sets: list[ScoreSet]) -> tuple[list[ScoreSet], list[str]]:
    """Paired comparisons need the identical bag set: bags unscorable under any model are dropped
    (and listed)."""
    common = set(sets[0].bag_ids)
    for ss in sets[1:]:
        common &= set(ss.bag_ids)
    excluded = sorted(set().union(*[set(ss.bag_ids) for ss in sets]) - common)
    out = []
    for ss in sets:
        keep = [i for i, b in enumerate(ss.bag_ids) if b in common]
        out.append(ScoreSet(name=ss.name, bag_ids=[ss.bag_ids[i] for i in keep],
                            patients=[ss.patients[i] for i in keep], labels=[ss.labels[i] for i in keep],
                            scores=[ss.scores[i] for i in keep], threshold=ss.threshold,
                            manifest_sha256=ss.manifest_sha256, split_fingerprint=ss.split_fingerprint))
    return out, excluded


def _compare(db, dv, runs: dict[str, TrainingRun], *, fixed: dict, n_boot: int, seed: int,
             min_patients: int) -> dict:
    done = {name: r for name, r in runs.items() if r.status == "succeeded"}
    entry = {"fixed": fixed, "models": sorted(runs), "run_ids": {n: r.id for n, r in runs.items()}}
    if len(done) < 2:
        return {**entry, "status": "insufficient_members", "reason": "a paired comparison needs at least two "
                "finished runs"}
    sets, excluded = _restrict([_score_set(db, r, name, dv) for name, r in sorted(done.items())])
    try:
        res = paired_comparison(sets, n_boot=n_boot, seed=seed, min_patients=min_patients)
    except ComparisonRefused as exc:
        return {**entry, "status": "refused", "code": exc.code, "reason": exc.detail}
    return {**entry, "status": "ok", "split": (next(iter(done.values())).threshold_json or {}).get("selected_on"),
            "excluded_bags_unscorable_under_some_model": excluded, "result": res}


def _learning_curves(records: list[dict], cfg: dict) -> list[dict]:
    lc = cfg["learning_curve"]
    if not lc:
        return []
    out = []
    for enc in lc["encoders"]:
        for head in lc["heads"]:
            points = []
            for f in lc["fractions"]:
                rows = [r for r in records if r["encoder"] == enc and r["head"] == head and r["fraction"] == f
                        and r["seed"] == cfg["seeds"][0] and r["status"] == "succeeded"]
                aurocs = [((r.get("development") or {}).get("threshold_free") or {}).get("auroc") or {}
                          for r in rows]
                vals = [a.get("value") for a in aurocs if a.get("value") is not None]
                points.append({
                    "fraction": f, "repeats": [{"repeat": r["repeat"], "run_id": r["run_id"],
                                                "train_patients": r.get("train_patients"),
                                                "auroc": a or None,
                                                "auprc": ((r.get("development") or {}).get("threshold_free") or {})
                                                .get("auprc")} for r, a in zip(rows, aurocs)],
                    "n_repeats": len(rows),
                    "auroc_mean": (sum(vals) / len(vals)) if vals else None,
                    "auroc_min": min(vals) if vals else None, "auroc_max": max(vals) if vals else None})
            out.append({"encoder": enc, "head": head, "evaluated_on": "val" if cfg["evaluation_protocol"] == "holdout"
                        else "oof", "points": points, "note": LEARNING_CURVE_NOTE})
    return out


def run_benchmark(config: dict, *, run_jobs: bool = True, report_path: str | Path | None = None,
                  log: Callable[[str], None] | None = None) -> dict:
    """Run (or resume) a benchmark described by ``config`` and write its results JSON.

    Idempotent per run identity: feature sets are reused by specification, and a second
    invocation creates a new comparison family with new runs (the report lists both ids)."""
    from .service import create_experiment

    log = log or (lambda msg: None)
    cfg = validate_config(config)
    a = cfg["actor"]
    actor = Actor(a["id"], a.get("role", "research_lead"), a.get("display_name", a["id"]))
    warnings: list[str] = []
    with session_scope() as db:
        project = db.get(Project, cfg["project_id"])
        if project is None:
            raise BenchmarkError(f"project {cfg['project_id']} does not exist on this database (import it first)")
        dv = resolve_dataset(db, project.id, cfg)
        dv_id, manifest = dv.id, dv.manifest_json
        specs = [get_encoder(e).spec for e in cfg["encoders"]]
        mode = cfg.get("execution_mode") or ("synthetic_pipeline_test" if any(s.synthetic for s in specs)
                                             else "supervised_experiment")
        sets = _feature_sets(db, actor, project, dv, cfg, mode)
        fs_ids = {enc: fs.id for enc, fs in sets.items()}
        policy = _policy_check(sets)
        if not policy["identical_except_patch_size"]:
            warnings.append("patch/sampling policies differ across encoders beyond patch_size")
        family_id = None
        if not cfg["technical"]:
            fam = ComparisonFamily(project_id=project.id, name=cfg["name"][:200], dataset_version_id=dv.id,
                                   dataset_manifest_sha256=dv.manifest_sha256,
                                   split_fingerprint=manifest.get("split_fingerprint"),
                                   plan_json=_plan(cfg, mode, policy), bootstrap_seed=bootstrap_seed_for(
                                       cfg, dv.manifest_sha256), created_by=actor.id)
            db.add(fam)
            db.flush()
            family_id = fam.id
            audit.record_for(db, actor, project_id=project.id, action="benchmark.started",
                             entity_type="comparison_family", entity_id=fam.id,
                             after={"name": cfg["name"], "dataset_version_id": dv.id, "encoders": cfg["encoders"],
                                    "heads": cfg["heads"], "protocol": cfg["evaluation_protocol"]})
    log(f"feature sets: {fs_ids}")
    technical_validation = {}
    if run_jobs:
        from . import feature_sets as fsets

        for enc, fs_id in fs_ids.items():
            log(f"building feature set for {enc}")
            fsets.build_feature_set(fs_id)
        tv = cfg.get("technical_validation")
        if tv and cfg["technical"] and hasattr(fsets, "validate_feature_set"):
            for enc, fs_id in fs_ids.items():
                log(f"technical validation of the {enc} feature set")
                technical_validation[enc] = fsets.validate_feature_set(fs_id, seed=int(tv.get("seed", 0)),
                                                                       n_slides=int(tv.get("n_slides", 2)))
    variants = _variants(cfg)
    runs: dict[tuple, str] = {}
    job_ids = []
    if family_id is not None:
        for v in variants:
            with session_scope() as db:
                run, job = create_experiment(
                    db, actor, db.get(Project, cfg["project_id"]), dataset_version_id=dv_id, encoder_id=v["encoder"],
                    head=v["head"], params=_variant_params(cfg, v["head"], fraction=v["fraction"], repeat=v["repeat"]),
                    seed=v["seed"], name=_run_name(cfg, v), execution_mode=mode, feature_set_id=fs_ids[v["encoder"]],
                    evaluation_protocol=cfg["evaluation_protocol"], family_id=family_id, family_role=v["role"])
                runs[_key(v)] = run.id
                job_ids.append(job.id)
        log(f"{len(runs)} run(s) queued in family {family_id}")
        if run_jobs:
            run_queued_jobs(job_ids)
    report = _report(cfg, mode, dv_id, fs_ids, policy, family_id, variants, runs, warnings)
    if technical_validation:
        report["technical_validation"] = technical_validation
    path = Path(report_path or cfg.get("report_path") or default_report_path(cfg["name"]))
    if not path.is_absolute():
        path = WORKBENCH_DIR / path
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(report, indent=2, sort_keys=True, default=str))
    report["report_path"] = str(path)
    if family_id is not None:
        with session_scope() as db:
            audit.record_for(db, actor, project_id=cfg["project_id"], action="benchmark.completed",
                             entity_type="comparison_family", entity_id=family_id,
                             after={"report_path": str(path), "runs": len(runs),
                                    "succeeded": sum(1 for r in report["runs"] if r["status"] == "succeeded")})
    return report


def _key(v: dict) -> tuple:
    return (v["encoder"], v["head"], v["seed"], v["fraction"], v["repeat"])


def _run_name(cfg: dict, v: dict) -> str:
    lc = f" · train fraction {v['fraction']} r{v['repeat']}" if v["fraction"] < 1.0 else ""
    return f"{cfg['name']} · {v['encoder']} · {v['head']} · seed {v['seed']}{lc}"[:200]


def _variants(cfg: dict) -> list[dict]:
    """Grid runs (every encoder × head × seed at the full training set) plus learning-curve
    runs (fractions < 1 × repeats, first seed). The full-set point of a learning curve is the
    grid run itself."""
    out = [{"encoder": e, "head": h, "seed": s, "fraction": 1.0, "repeat": 0, "role": "grid"}
           for e in cfg["encoders"] for h in cfg["heads"] for s in cfg["seeds"]]
    lc = cfg["learning_curve"]
    if lc:
        for e in lc["encoders"]:
            for h in lc["heads"]:
                for f in lc["fractions"]:
                    if f >= 1.0:
                        continue
                    for r in range(lc["repeats"]):
                        out.append({"encoder": e, "head": h, "seed": cfg["seeds"][0], "fraction": f, "repeat": r,
                                    "role": "learning_curve"})
    return out


def _budgets(cfg: dict) -> dict:
    from .config import resolve_params

    out = {}
    for h in cfg["heads"]:
        p = resolve_params({**{k: v for k, v in cfg["params"].items() if not k.startswith("synthetic_")},
                            **cfg["head_params"].get(h, {})})
        keys = (("C", "class_weight") if h == "meanpool_logreg" else
                ("hidden_dim", "attn_dim", "dropout", "lr", "weight_decay", "max_epochs", "patience",
                 "inner_val_fraction", "max_instances_per_bag", "class_weight"))
        out[h] = {"description": OPTIMISATION_BUDGETS[h], "params": {k: p[k] for k in keys},
                  "same_for_every_encoder": True}
    return out


def _plan(cfg: dict, mode: str, policy: dict) -> dict:
    return {"schema": BENCHMARK_SCHEMA, "name": cfg["name"], "execution_mode": mode,
            "evaluation_protocol": cfg["evaluation_protocol"], "encoders": cfg["encoders"], "heads": cfg["heads"],
            "seeds": cfg["seeds"], "params": cfg["params"], "head_params": cfg["head_params"],
            "learning_curve": cfg["learning_curve"], "optimisation_budgets": _budgets(cfg),
            "policy": policy, "comparisons": "encoder effects with the head fixed; head effects with the encoder "
                                             "fixed; development predictions only"}


def _report(cfg: dict, mode: str, dv_id: str, fs_ids: dict, policy: dict, family_id: str | None,
            variants: list[dict], runs: dict, warnings: list[str]) -> dict:
    from . import feature_sets as fsets

    n_boot, min_patients = int(cfg["bootstrap"]["n_boot"]), int(cfg["bootstrap"]["min_patients"])
    with session_scope() as db:
        dv = db.get(DatasetVersion, dv_id)
        manifest = dv.manifest_json
        fam = db.get(ComparisonFamily, family_id) if family_id else None
        feature_sets = []
        for enc, fs_id in fs_ids.items():
            fs = db.get(FeatureSet, fs_id)
            entry = {"encoder_id": enc, "feature_set_id": fs.id, "status": fs.status, "spec_sha256": fs.spec_sha256,
                     "policy_sha256": fs.policy_sha256, "weights_sha256": fs.weights_sha256,
                     "encoder_spec_sha256": fs.encoder_spec_sha256}
            try:
                d = fsets.feature_set_dict(db, fs, detail=True)
                entry["counts"] = d.get("counts")
                entry["coverage"] = d.get("coverage")
                entry["validations"] = d.get("validations")
            except Exception as exc:  # noqa: BLE001 - diagnostics only
                entry["coverage_error"] = f"{type(exc).__name__}: {exc}"
            feature_sets.append(entry)
        records, by_key = [], {}
        for v in variants:
            rid = runs.get(_key(v))
            if rid is None:
                continue
            run = db.get(TrainingRun, rid)
            by_key[_key(v)] = run
            records.append(_run_record(run, {k: v[k] for k in ("encoder", "head", "seed", "fraction", "repeat",
                                                               "role")}))
        comparisons = {"encoder_effects": [], "head_effects": []}
        if fam is not None:
            seed = int(fam.bootstrap_seed)
            for s in cfg["seeds"]:
                for h in cfg["heads"]:
                    group = {e: by_key[(e, h, s, 1.0, 0)] for e in cfg["encoders"] if (e, h, s, 1.0, 0) in by_key}
                    if len(group) >= 2:
                        comparisons["encoder_effects"].append(_compare(
                            db, dv, group, fixed={"head": h, "seed": s}, n_boot=n_boot, seed=seed,
                            min_patients=min_patients))
                for e in cfg["encoders"]:
                    group = {h: by_key[(e, h, s, 1.0, 0)] for h in cfg["heads"] if (e, h, s, 1.0, 0) in by_key}
                    if len(group) >= 2:
                        comparisons["head_effects"].append(_compare(
                            db, dv, group, fixed={"encoder": e, "seed": s}, n_boot=n_boot, seed=seed,
                            min_patients=min_patients))
    failed = [r for r in records if r["status"] != "succeeded"]
    if failed:
        warnings.append(f"{len(failed)} run(s) did not succeed; see runs[].error")
    # Every metric and comparison below is measured against the manifest's reference standard; imported reference
    # labels (an external dataset's own standard, not expert reads here) are stated wherever results appear.
    standard = reference_standard_fields(manifest)
    if standard.get("reference_standard_notice"):
        warnings.append(standard["reference_standard_notice"])
    for rec in records:
        rec.update(standard)
    for group in comparisons.values():
        for entry in group:
            entry.update(standard)
    synthetic = mode == "synthetic_pipeline_test"
    return {
        "schema": BENCHMARK_SCHEMA,
        "name": cfg["name"],
        "description": cfg.get("description"),
        "research_use_only": True,
        "notice": RESEARCH_NOTICE,
        "banner": PIPELINE_TEST_BANNER if synthetic else None,
        "created_at": utcnow().isoformat(),
        "execution_mode": mode,
        "evaluation_protocol": cfg["evaluation_protocol"],
        **standard,
        "dataset": {"dataset_version_id": dv_id, "name": dv.name, "version": dv.version,
                    "manifest_sha256": dv.manifest_sha256, "split_fingerprint": manifest.get("split_fingerprint"),
                    "data_mode": manifest.get("data_mode"), "patients": (manifest.get("counts") or {}).get("patients"),
                    **standard},
        "family": None if fam is None else {"family_id": fam.id, "status": fam.status,
                                            "bootstrap_seed": fam.bootstrap_seed,
                                            "lock_note": "the family stays open; locking it (before any test release) "
                                                         "is a human decision"},
        "feature_sets": feature_sets,
        "policy": policy,
        "optimisation_budgets": _budgets(cfg) if cfg["heads"] else {},
        "runs": records,
        "comparisons": comparisons,
        "learning_curves": _learning_curves(records, cfg),
        "selection_note": SELECTION_NOTE,
        "test_split": "never read by the benchmark (test metrics exist only through a recorded test release)",
        "warnings": warnings,
        "config": {k: v for k, v in cfg.items() if k != "technical"},
    }
