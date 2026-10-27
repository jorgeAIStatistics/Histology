"""Command line for the ML engine: ``python -m dermpath.ml.cli`` (design §6). Research use only.

Operates on the LOCAL database and object store of ``WB_VAR_DIR`` (or ``--var-dir``) and never
touches the network: model hubs are forced offline and nothing is downloaded. Jobs run in this
process.

Commands
--------
``describe-encoders``
    Encoder adapters with licence, spec and honest availability status.
``run-config CONFIG.json``
    Create ONE experiment (``project_id``, ``dataset`` or ``dataset_version_id``,
    ``encoder_id``, ``head``, ``seed``, ``params``, optional ``execution_mode``,
    ``evaluation_protocol``, ``feature_set_id``, ``name``) and train it.
``benchmark CONFIG.json``
    :func:`dermpath.ml.benchmark.run_benchmark`; writes the results JSON (``--report``).
``feature-set create CONFIG.json`` | ``build ID`` | ``status ID`` | ``validate ID``
    Create (idempotent), build (resumable), inspect or technically validate a feature set.

Output is JSON on stdout; the research-use banner and progress go to stderr. Exit codes: 0
success, 1 the work failed (for example a run did not succeed), 2 invalid usage or config.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

BANNER = ("DermPath Research Workbench ML engine, research use only. Not a medical device; outputs are not "
          "diagnoses and never become labels. Local database only; nothing is downloaded.")
OFFLINE_ENV = {"HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1", "HF_HUB_DISABLE_TELEMETRY": "1"}
DEFAULT_ACTOR = {"id": "system:cli", "role": "research_lead", "display_name": "ML command line"}


class UsageError(Exception):
    pass


def _err(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def _out(obj) -> None:
    print(json.dumps(obj, indent=2, sort_keys=True, default=str), flush=True)


def _load_json(path: str) -> dict:
    p = Path(path)
    if not p.is_file():
        raise UsageError(f"config file not found: {path}")
    try:
        data = json.loads(p.read_text())
    except json.JSONDecodeError as exc:
        raise UsageError(f"{path} is not valid JSON: {exc}") from exc
    if not isinstance(data, dict):
        raise UsageError(f"{path} must contain a JSON object")
    return data


def _actor(cfg: dict):
    from ..auth import Actor

    a = {**DEFAULT_ACTOR, **(cfg.get("actor") or {})}
    return Actor(a["id"], a.get("role", "research_lead"), a.get("display_name", a["id"]))


def _setup(var_dir: str | None) -> None:
    for k, v in OFFLINE_ENV.items():
        os.environ.setdefault(k, v)
    if var_dir:
        from ..config import Settings, set_settings

        os.environ["WB_VAR_DIR"] = str(Path(var_dir).resolve())
        set_settings(Settings.from_env())
    from ..db import init_db

    init_db()


def _dataset_id(db, project_id: str, cfg: dict) -> str:
    from .benchmark import BenchmarkError, resolve_dataset

    try:
        return resolve_dataset(db, project_id, cfg).id
    except BenchmarkError as exc:
        raise UsageError(str(exc)) from exc


# --------------------------------------------------------------------------- commands


def cmd_describe_encoders(args) -> int:
    from .encoders import list_encoders

    items = list_encoders()
    if args.json:
        _out({"items": items, "note": "Encoders are enabled only by locally present, legally obtained weights; "
                                      "nothing is downloaded."})
    else:
        for e in items:
            print(f"{e['id']:<32} {e['kind']:<22} {e['status']:<18} dim={e.get('embedding_dim')} "
                  f"input={e.get('input_size')} synthetic={e['synthetic']}")
            if e.get("status_detail") and e["status"] != "available":
                print(f"    {e['status_detail']}")
    return 0


def cmd_run_config(args) -> int:
    from ..db import session_scope
    from ..models import Project
    from .benchmark import run_queued_jobs
    from .service import create_experiment, run_dict

    cfg = _load_json(args.config)
    allowed = {"project_id", "dataset", "dataset_version_id", "encoder_id", "head", "seed", "params",
               "execution_mode", "evaluation_protocol", "feature_set_id", "name", "actor", "family_id", "description"}
    unknown = sorted(k for k in cfg if k not in allowed and not k.startswith("_"))
    if unknown:
        raise UsageError(f"unknown run-config key(s) {unknown}; allowed: {sorted(allowed)}")
    for k in ("project_id", "encoder_id", "head"):
        if not cfg.get(k):
            raise UsageError(f"run-config needs {k!r}")
    actor = _actor(cfg)
    with session_scope() as db:
        project = db.get(Project, cfg["project_id"])
        if project is None:
            raise UsageError(f"project {cfg['project_id']} does not exist on this database")
        dv_id = _dataset_id(db, project.id, cfg)
        run, job = create_experiment(db, actor, project, dataset_version_id=dv_id, encoder_id=cfg["encoder_id"],
                                     head=cfg["head"], params=cfg.get("params"), seed=int(cfg.get("seed", 0)),
                                     name=cfg.get("name"), execution_mode=cfg.get("execution_mode"),
                                     feature_set_id=cfg.get("feature_set_id"),
                                     evaluation_protocol=cfg.get("evaluation_protocol"),
                                     family_id=cfg.get("family_id"))
        run_id, job_id = run.id, job.id
    _err(f"experiment {run_id} queued (job {job_id})")
    if not args.no_run:
        run_queued_jobs([job_id], worker_id="cli-in-process")
    with session_scope() as db:
        from .models import TrainingRun

        out = run_dict(db, db.get(TrainingRun, run_id))
    _out(out)
    return 0 if (args.no_run or out["status"] == "succeeded") else 1


def cmd_benchmark(args) -> int:
    from .benchmark import BenchmarkError, load_config, run_benchmark

    try:
        cfg = load_config(args.config)
    except (OSError, json.JSONDecodeError) as exc:
        raise UsageError(f"cannot read {args.config}: {exc}") from exc
    try:
        report = run_benchmark(cfg, run_jobs=not args.no_run, report_path=args.report, log=_err)
    except BenchmarkError as exc:
        raise UsageError(str(exc)) from exc
    summary = {"report_path": report["report_path"], "family": report["family"],
               "execution_mode": report["execution_mode"], "evaluation_protocol": report["evaluation_protocol"],
               "feature_sets": [{k: fs.get(k) for k in ("encoder_id", "feature_set_id", "status")}
                                for fs in report["feature_sets"]],
               "runs": [{k: r.get(k) for k in ("run_id", "encoder", "head", "seed", "fraction", "repeat", "status")}
                        for r in report["runs"]],
               "comparisons": {k: len(v) for k, v in report["comparisons"].items()},
               "warnings": report["warnings"], "selection_note": report["selection_note"]}
    _out(summary)
    failed = [r for r in report["runs"] if r["status"] != "succeeded"]
    return 1 if (failed and not args.no_run) else 0


def cmd_feature_set(args) -> int:
    from ..db import session_scope
    from ..models import Project
    from . import feature_sets as fsets
    from .engine_models import FeatureSet

    if args.fs_command == "create":
        cfg = _load_json(args.target)
        for k in ("project_id", "encoder_id"):
            if not cfg.get(k):
                raise UsageError(f"feature-set create needs {k!r}")
        actor = _actor(cfg)
        with session_scope() as db:
            project = db.get(Project, cfg["project_id"])
            if project is None:
                raise UsageError(f"project {cfg['project_id']} does not exist on this database")
            spec_kwargs = {}
            if cfg.get("slide_ids"):
                spec_kwargs["slide_ids"] = list(cfg["slide_ids"])
            else:
                spec_kwargs["dataset_version_id"] = _dataset_id(db, project.id, cfg)
            from .encoders import get_encoder
            from .training import infer_execution_mode

            enc = get_encoder(cfg["encoder_id"])
            if enc is None:
                raise UsageError(f"unknown encoder {cfg['encoder_id']}")
            mode = cfg.get("execution_mode") or infer_execution_mode(enc.spec)
            from .config import feature_params, resolve_experiment_params

            try:  # the same resolution as experiment creation: one specification, one feature set
                params = feature_params(resolve_experiment_params(cfg.get("params") or {}, encoder_spec=enc.spec))
            except ValueError as exc:
                raise UsageError(f"invalid params: {exc.args[0]}") from exc
            fs = fsets.create_feature_set(db, actor, project, encoder_id=cfg["encoder_id"], execution_mode=mode,
                                          params=params, name=cfg.get("name"), **spec_kwargs)
            fs_id = fs.id
        _err(f"feature set {fs_id}")
        if args.build:
            fsets.build_feature_set(fs_id)
    else:
        fs_id = args.target
        with session_scope() as db:
            if db.get(FeatureSet, fs_id) is None:
                raise UsageError(f"feature set {fs_id} does not exist")
        if args.fs_command == "build":
            fsets.build_feature_set(fs_id)
        elif args.fs_command == "validate":
            _out(fsets.validate_feature_set(fs_id, seed=args.seed, n_slides=args.n_slides))
            return 0
    with session_scope() as db:
        _out(fsets.feature_set_dict(db, db.get(FeatureSet, fs_id)))
    return 0


# --------------------------------------------------------------------------- entry point


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="python -m dermpath.ml.cli", description=BANNER)
    p.add_argument("--var-dir", help="workbench var directory (default: WB_VAR_DIR or workbench/var)")
    sub = p.add_subparsers(dest="command", required=True)
    d = sub.add_parser("describe-encoders", help="list encoders with licence and availability")
    d.add_argument("--json", action="store_true")
    r = sub.add_parser("run-config", help="create and train one experiment from a JSON config")
    r.add_argument("config")
    r.add_argument("--no-run", action="store_true", help="only create and queue the experiment")
    b = sub.add_parser("benchmark", help="run an encoder x head benchmark from a JSON config")
    b.add_argument("config")
    b.add_argument("--report", help="results JSON path (default: the config's report_path)")
    b.add_argument("--no-run", action="store_true", help="create the family, feature sets and runs without "
                                                         "running jobs")
    f = sub.add_parser("feature-set", help="create, build, inspect or validate a feature set")
    f.add_argument("fs_command", choices=["create", "build", "status", "validate"])
    f.add_argument("target", help="config JSON (create) or feature set id")
    f.add_argument("--build", action="store_true", help="with create: build it now")
    f.add_argument("--seed", type=int, default=0, help="with validate: seed of the re-extracted subset")
    f.add_argument("--n-slides", type=int, default=2, help="with validate: slides re-extracted")
    return p


COMMANDS = {"describe-encoders": cmd_describe_encoders, "run-config": cmd_run_config, "benchmark": cmd_benchmark,
            "feature-set": cmd_feature_set}


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    _err(BANNER)
    try:
        args = parser.parse_args(argv)
    except SystemExit as exc:  # argparse already printed the usage
        return int(exc.code or 0) if exc.code in (0, None) else 2
    try:
        _setup(args.var_dir)
        return COMMANDS[args.command](args)
    except UsageError as exc:
        _err(f"error: {exc}")
        return 2
    except Exception as exc:  # noqa: BLE001 - reported as JSON-free text, non-zero exit
        from ..db import SchemaMismatchError
        from ..errors import ApiError

        from .encoders import EncoderUnavailable

        if isinstance(exc, (SchemaMismatchError, EncoderUnavailable)):
            _err(f"error: {exc}")
            return 2
        if isinstance(exc, ApiError):
            _err(f"error: {exc.code}: {exc.message} {json.dumps(exc.details, default=str)[:2000]}")
            return 2
        raise


if __name__ == "__main__":
    raise SystemExit(main())
