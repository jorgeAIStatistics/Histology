#!/usr/bin/env python3
"""Near-duplicate sensitivity analysis of the COBRA s3 out-of-fold results. RESEARCH USE ONLY.

Not a medical device. Every number is agreement with COBRA's report-derived imported reference labels, not clinical
performance; "BCC absent" is not "benign". Out-of-fold (OOF) metrics are development estimates.

Why
---
The dataset audit's thumbnail dHash screen found near-duplicate CANDIDATE slide pairs inside the development pool
with no human decision. Each pair links two different patients, and patient-grouped CV folds may place the two
members in different folds. If a pair is truly the same material, a member's held-out (OOF) prediction came from a
fold model that trained on its partner, so its score may be optimistic. This script re-evaluates every s3 grid run
(encoder x head x training seed) twice, with the engine's own metric and comparison functions, so the numbers are
comparable with ``s3.json``:

* (a) on all development patients (the s3 numbers; reproduced and checked against the report and the database);
* (b) excluding every patient of every UNDECIDED near-duplicate candidate pair.

It also recomputes the paired encoder and head deltas (the driver's ``encoder_effects`` / ``head_effects``) with and
without those patients. Nothing is retrained: excluding a patient removes its possibly leaky held-out prediction
from the metric; other patients' OOF predictions are unaffected by the question (their fold models may have trained
on a candidate, which is not leakage for them).

What it reads and writes
------------------------
Reads a workbench SQLite database opened READ-ONLY (``mode=ro`` URI, ``PRAGMA query_only``); use a byte copy of
``var/workbench.db`` (+ ``-wal`` / ``-shm``), not the live file. Reads the s3 report for the run list and the
reported numbers. Writes one JSON file (``--out``) that contains NO patient identifiers, slide ids, bag ids or file
names: only counts, distances, fold indices and metrics. ``WB_VAR_DIR`` is pointed at a throwaway directory before
the engine is imported, so nothing under ``workbench/var`` is touched.

Usage (from ``workbench/api``)::

    .venv/bin/python ../scripts/sensitivity_near_duplicates.py --db /tmp/copy/workbench.db \\
        --out ../experiments/reports/sensitivity_near_duplicates.json

Exit codes: 0 written; 1 a reproduction check failed (the file is still written, with ``reproduced: false``);
2 usage or input error.
"""

from __future__ import annotations

import argparse
import atexit
import datetime as _dt
import hashlib
import json
import math
import os
import shutil
import sqlite3
import statistics
import sys
import tempfile
import urllib.parse
from pathlib import Path

SCRIPT = Path(__file__).resolve()
WORKBENCH = SCRIPT.parents[1]
API_DIR = WORKBENCH / "api"
DEFAULT_S3 = WORKBENCH / "experiments" / "reports" / "s3.json"
SCHEMA = "dermpath.near_duplicate_sensitivity/1"
SPLIT = "oof"
TOL = 1e-12
NOTICE = ("RESEARCH USE ONLY. Not a medical device; nothing here is a diagnosis or a clinical performance claim. "
          "Labels are COBRA's report-derived imported reference labels (not expert reads in this workbench): metrics "
          "measure agreement with that reference. 'BCC absent' is not 'benign'.")
CAVEATS = [
    "Development out-of-fold estimates on 35 development patients (45 slide bags); not test results. The test split "
    "is not read by this script.",
    "Nothing is retrained: the exclusion removes the held-out predictions of the candidate patients, whose fold "
    "models may have trained on a near-duplicate partner. Fold models, thresholds and calibration are unchanged.",
    "The candidates are an automated thumbnail-dHash screen with no human decision: they may be distinct material. "
    "The exclusion is a sensitivity bound for that question, not a finding that they are duplicates.",
    "AUROC and AUPRC are threshold-free. Sensitivity / specificity deltas and McNemar use thresholds selected on the "
    "full OOF scores (Youden): tuning estimates (optimistic), flagged tuning_set.",
    "The bootstrap uses the same seeds as s3 but a different patient set after exclusion, so the full and the "
    "restricted intervals come from different replicate streams; their difference is not a paired estimate.",
    "Training-seed repeats measure optimisation variability on the same patients and folds; they are not additional "
    "independent patients.",
    "Removing patients makes the intervals wider and the estimates noisier; with 31 patients CIs remain approximate.",
    "Per-pair intervals are unadjusted for the several comparisons (4 per seed x 3 seeds, in two analyses): an "
    "interval that excludes 0 in one analysis is not a declared difference, and no winner is declared.",
    "The candidate-rule check re-applies the s3 rule to the restricted numbers for robustness only; it never changes "
    "the pre-declared test candidate, which was fixed before any test access.",
]


# ===================================================================================================== helpers


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def close(a, b, tol: float = TOL) -> bool:
    if a is None or b is None:
        return a is None and b is None
    if isinstance(a, (list, tuple)) or isinstance(b, (list, tuple)):
        return (isinstance(a, (list, tuple)) and isinstance(b, (list, tuple)) and len(a) == len(b)
                and all(close(x, y, tol) for x, y in zip(a, b)))
    return math.isfinite(float(a)) and math.isfinite(float(b)) and abs(float(a) - float(b)) <= tol


def stats(vals: list) -> dict | None:
    v = [float(x) for x in vals if x is not None]
    if not v:
        return None
    return {"n": len(v), "mean": statistics.fmean(v), "min": min(v), "max": max(v)}


def metric_view(entry: dict | None) -> dict | None:
    if not isinstance(entry, dict):
        return None
    return {k: entry.get(k) for k in ("value", "ci", "ci_reason", "ci_valid_replicates") if k in entry}


def open_readonly(db_path: Path):
    """A SQLAlchemy engine over ``db_path`` that cannot write: SQLite ``mode=ro`` URI plus ``query_only``."""
    from sqlalchemy import create_engine, event

    uri = "file:" + urllib.parse.quote(str(db_path)) + "?mode=ro"

    def creator():
        con = sqlite3.connect(uri, uri=True, check_same_thread=False)
        con.execute("PRAGMA query_only=ON")
        return con

    engine = create_engine("sqlite://", creator=creator, future=True)

    @event.listens_for(engine, "connect")
    def _ro(dbapi_conn, _rec):  # pragma: no cover - exercised implicitly
        dbapi_conn.execute("PRAGMA query_only=ON")

    return engine


def env_guard() -> str:
    """Point the engine's runtime directory at a throwaway location BEFORE dermpath is imported."""
    sandbox = tempfile.mkdtemp(prefix="dermpath-sensitivity-")
    atexit.register(shutil.rmtree, sandbox, True)
    os.environ["WB_VAR_DIR"] = sandbox
    os.environ.setdefault("HF_HUB_OFFLINE", "1")
    os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
    if str(API_DIR) not in sys.path:
        sys.path.insert(0, str(API_DIR))
    return sandbox


# ===================================================================================================== cohort


def near_duplicate_exclusion(db, dv, fold_of: dict) -> tuple[dict, set[str]]:
    """Undecided near-duplicate CANDIDATE pairs of the frozen dataset version, as the engine's audit computes them
    (:func:`dermpath.datasets._near_duplicates` over the frozen manifest with the project's latest decisions).
    Returns a sanitized description and the set of patient keys to exclude (patient codes AND coded patient ids,
    because predictions cluster by patient code and the manifest carries both)."""
    from dermpath.datasets import NEAR_DUPLICATE_MAX_DISTANCE, _decisions, _near_duplicates, item_rows

    rows = item_rows(db, dv)
    by_slide = {r["slide_id"]: r for r in rows}
    decisions = _decisions(db, dv.project_id)
    near, unscreened = _near_duplicates(db, rows, decisions)
    undecided = [c for c in near if not c.get("human_decision")]
    excluded_keys: set[str] = set()
    excluded_patients: set[str] = set()
    pairs = []
    for c in sorted(undecided, key=lambda c: (c["dhash_distance"], c["slide_a"], c["slide_b"])):
        a, b = by_slide[c["slide_a"]], by_slide[c["slide_b"]]
        for r in (a, b):
            excluded_patients.add(r["coded_patient_id"])
            excluded_keys.update(k for k in (r.get("coded_patient_id"), r.get("patient_code")) if k)
        fa, fb = fold_of.get(a["coded_patient_id"]), fold_of.get(b["coded_patient_id"])
        pairs.append({"dhash_distance": c["dhash_distance"], "same_patient": bool(c["same_patient"]),
                      "same_slide_label": a.get("label_value") == b.get("label_value"),
                      "slide_label": a.get("label_value") if a.get("label_value") == b.get("label_value") else None,
                      "splits": sorted({a.get("split"), b.get("split")}),
                      "cv_folds_of_members": sorted(x for x in (fa, fb) if x is not None),
                      "members_in_different_cv_folds": (fa is not None and fb is not None and fa != fb),
                      "human_decision": None})
    dev_rows = [r for r in rows if r.get("split") in ("train", "val")]
    ex_rows = [r for r in dev_rows if r["coded_patient_id"] in excluded_patients]
    in_test = sorted({r["coded_patient_id"] for r in rows if r.get("split") == "test"} & excluded_patients)
    desc = {
        "screen": {"method": f"thumbnail dHash (64-bit), Hamming distance <= {NEAR_DUPLICATE_MAX_DISTANCE}",
                   "source": "dermpath.datasets._near_duplicates over the frozen manifest (the dataset audit's own "
                             "screen) with the project's latest near-duplicate decisions",
                   "candidates": len(near), "with_human_decision": len(near) - len(undecided),
                   "undecided": len(undecided), "unscreened_slides": len(unscreened)},
        "undecided_pairs": pairs,
        "excluded": {"patients": len(excluded_patients),
                     "development_patients": len({r["coded_patient_id"] for r in ex_rows}),
                     "test_patients": len(in_test),
                     "development_slides": len(ex_rows),
                     "development_slides_by_label": dict(sorted(
                         {lv: sum(1 for r in ex_rows if r.get("label_value") == lv)
                          for lv in {r.get("label_value") for r in ex_rows}}.items()))},
        "rule": "every patient of every near-duplicate candidate pair WITHOUT a human decision is excluded from the "
                "evaluation (both members, all of their development slides)",
    }
    return desc, excluded_keys


# ===================================================================================================== single runs


def _patient_key(p) -> str:
    return p.patient_code or p.coded_patient_id


def _unscorable_rows(run, manifest: dict) -> list[dict]:
    """The run's OOF-unscorable bags with label and patient key (resolved from the frozen manifest when missing)."""
    from dermpath.ml.training import development_unscored

    items = {it["slide_id"]: it for it in (manifest or {}).get("items", [])}
    out = []
    for u in development_unscored(run, SPLIT):
        it = items.get(u.get("bag_id")) or {}
        label = u.get("label")
        if label is None:
            lv = u.get("label_value") or it.get("label_value")
            label = None if lv is None else int(lv == run.positive_class)
        key = u.get("patient_code") or it.get("patient_code") or u.get("patient_id") or it.get("coded_patient_id")
        ids = {u.get("patient_code"), u.get("patient_id"), it.get("patient_code"), it.get("coded_patient_id")}
        out.append({"label": label, "patient": key, "ids": {i for i in ids if i}})
    return out


def run_oof_metrics(db, run, manifest: dict, excluded: set[str]) -> dict:
    """OOF threshold-free metrics of one run as :func:`dermpath.ml.training.development_summary` computes them
    (same y, scores, patient-code clusters, threshold, n_boot, bootstrap seed and minimum patients), on the bags of
    the patients NOT in ``excluded``."""
    from sqlalchemy import select

    from dermpath.ml import metrics as M
    from dermpath.ml.models import Prediction

    params = run.params_json or {}
    summary = ((run.metrics_json or {}).get("oof_summary") or {})
    boot = summary.get("bootstrap") or {}
    seed = int(boot.get("seed", run.seed))
    n_boot = int(boot.get("n_boot", params.get("n_boot", 1000)))
    min_patients = int(boot.get("min_patients", params.get("boot_min_patients", 10)))
    preds = db.scalars(select(Prediction).where(Prediction.run_id == run.id, Prediction.split == SPLIT)
                       .order_by(Prediction.bag_id)).all()
    keep = [p for p in preds if not ({p.patient_code, p.coded_patient_id} & excluded)]
    unsc = [u for u in _unscorable_rows(run, manifest) if u["label"] in (0, 1) and not (u["ids"] & excluded)]
    tuning = (run.threshold_json or {}).get("selection_status") == "selected"
    ev = M.evaluate_binary([int(p.label) for p in keep], [float(p.score) for p in keep],
                           [_patient_key(p) for p in keep], threshold=float(run.threshold_value),
                           unscorable_y=[u["label"] for u in unsc], unscorable_patients=[u["patient"] for u in unsc],
                           target_prevalence=params.get("target_prevalence"), n_boot=n_boot, seed=seed,
                           min_patients=min_patients, tuning_set=tuning)
    m = ev["metrics"]
    return {"n_items": ev["n_items"], "n_patients": ev["n_patients"], "positives": ev["positives"],
            "negatives": ev["negatives"], "positive_patients": ev["positive_patients"],
            "negative_patients": ev["negative_patients"], "n_unscorable": ev["n_unscorable"],
            "auroc": metric_view(m["auroc"]), "auprc": metric_view(m["auprc"]),
            "bootstrap": {k: ev["bootstrap"].get(k) for k in ("method", "n_boot", "seed", "n_patients",
                                                              "min_patients", "stratified", "status", "interval")}}


# ===================================================================================================== comparisons


def paired_excluding(db, named: dict, manifest: dict, excluded: set[str], *, n_boot: int, seed: int,
                     min_patients: int) -> dict:
    """:func:`dermpath.ml.evaluation.paired_runs_comparison` restricted to the bags of patients NOT in ``excluded``
    (scored and unscorable alike), otherwise identical: paired evaluable subjects, the engine's
    :func:`dermpath.ml.comparison.paired_comparison` with the same seed / n_boot / min_patients, tuning labels."""
    from sqlalchemy import select

    from dermpath.ml.comparison import (ComparisonRefused, ScoreSet, label_tuning_estimates, paired_comparison,
                                        restrict_to_common, subject_accounting)
    from dermpath.ml.models import Prediction
    from dermpath.ml.training import development_unscored, threshold_tuned_on

    runs = dict(sorted(named.items()))
    sets, accounting = [], {}
    for name, run in runs.items():
        preds = [p for p in db.scalars(select(Prediction).where(Prediction.run_id == run.id,
                                                                Prediction.split == SPLIT)
                                       .order_by(Prediction.bag_id)).all()
                 if not ({p.patient_code, p.coded_patient_id} & excluded)]
        unsc = [u for u in development_unscored(run, SPLIT)
                if not ({u.get("patient_code"), u.get("patient_id")} & excluded)]
        accounting[name] = {"scored": {p.bag_id: _patient_key(p) for p in preds},
                            "unscorable": {u["bag_id"]: u.get("patient_code") or u.get("patient_id") for u in unsc}}
        sets.append(ScoreSet(name=name, bag_ids=[p.bag_id for p in preds], patients=[_patient_key(p) for p in preds],
                             labels=[p.label for p in preds], scores=[p.score for p in preds],
                             threshold=float(run.threshold_value), manifest_sha256=run.dataset_manifest_sha256,
                             split_fingerprint=(manifest or {}).get("split_fingerprint")))
    if any(not ss.bag_ids for ss in sets):
        return {"status": "not_available", "reason": "a run has no OOF predictions after the exclusion"}
    restricted, _excluded_bags = restrict_to_common(sets)
    try:
        res = paired_comparison(restricted, n_boot=n_boot, seed=int(seed), min_patients=min_patients)
    except ComparisonRefused as exc:
        return {"status": "refused", "code": exc.code, "reason": exc.detail}
    label_tuning_estimates(res, {n: threshold_tuned_on(r, SPLIT) for n, r in runs.items()})
    return {"status": "ok", "subject_accounting": subject_accounting(accounting), "tuning_set": res["tuning_set"],
            "result": res}


def deltas_view(out: dict) -> list[dict]:
    """The pairwise deltas of a comparison as the s3 report shows them (no bag ids)."""
    if out.get("status") != "ok":
        return []
    return [{"a": p["a"], "b": p["b"], "delta": p["delta"],
             **{m: {**{k: v.get(k) for k in ("value", "ci", "ci_reason", "fraction_favouring")},
                    **({"tuning_set": True} if v.get("tuning_set") else {})}
                for m, v in p["deltas"].items()},
             "mcnemar_p": (p["mcnemar"]["all"] or {}).get("p_value"),
             "mcnemar_tuning_set": p["mcnemar"].get("tuning_set", False)} for p in out["result"]["pairs"]]


def comparison_counts(out: dict) -> dict | None:
    if out.get("status") != "ok":
        return None
    r = out["result"]
    return {"n_bags": r["n_bags"], "n_patients": r["n_patients"], "positives": r["positives"],
            "negatives": r["negatives"], "subject_accounting": {k: v for k, v in out["subject_accounting"].items()
                                                                if k != "note"}}


def same_deltas(x: list[dict], y: list[dict]) -> bool:
    if len(x) != len(y):
        return False
    for a, b in zip(x, y):
        if (a["a"], a["b"]) != (b["a"], b["b"]):
            return False
        for m in ("auroc", "auprc", "sensitivity", "specificity", "brier"):
            if (m in a) != (m in b):
                return False
            if m in a and not (close(a[m].get("value"), b[m].get("value")) and close(a[m].get("ci"), b[m].get("ci"))):
                return False
    return True


# ===================================================================================================== main


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="sensitivity_near_duplicates.py", description=__doc__.split("\n\n")[0],
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--db", required=True, help="workbench SQLite database (a byte copy; opened read-only)")
    p.add_argument("--s3-report", default=str(DEFAULT_S3), help="the driver's s3.json (run list, reported numbers)")
    p.add_argument("--out", required=True, help="output JSON (no patient identifiers)")
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    db_path = Path(args.db).resolve()
    s3_path = Path(args.s3_report).resolve()
    out_path = Path(args.out).resolve()
    if not db_path.is_file() or not s3_path.is_file():
        print("error: --db and --s3-report must be existing files", file=sys.stderr)
        return 2
    live = (WORKBENCH / "var").resolve()
    if live in db_path.parents:
        print(f"note: {db_path} is the live database directory; it is opened read-only, but a byte copy is "
              "preferred", file=sys.stderr)
    inputs = {"database_sha256": sha256_file(db_path),
              "database_wal_sha256": sha256_file(Path(str(db_path) + "-wal"))
              if Path(str(db_path) + "-wal").is_file() else None,
              "s3_report_sha256": sha256_file(s3_path), "script_sha256": sha256_file(SCRIPT)}
    s3 = json.loads(s3_path.read_text())
    sandbox = env_guard()

    from sqlalchemy.orm import Session

    from dermpath.db import import_all_models
    from dermpath.ml.artifacts import code_identity
    from dermpath.ml.evaluation import paired_runs_comparison
    from dermpath.ml.models import TrainingRun
    from dermpath.ml.training import comparison_refusal
    from dermpath.models import DatasetVersion

    import_all_models()
    engine = open_readonly(db_path)
    grid = [r for r in s3.get("runs") or [] if r.get("role") == "grid"]
    problems: list[str] = []
    with Session(engine) as db:
        runs = {r["run_id"]: db.get(TrainingRun, r["run_id"]) for r in grid}
        missing = [rid for rid, r in runs.items() if r is None or r.status != "succeeded"]
        if missing or not grid:
            print(f"error: s3 grid runs missing or not succeeded in this database: {missing}", file=sys.stderr)
            return 2
        dv_ids = {r.dataset_version_id for r in runs.values()}
        if len(dv_ids) != 1:
            print(f"error: the grid runs use {len(dv_ids)} dataset versions", file=sys.stderr)
            return 2
        dv = db.get(DatasetVersion, dv_ids.pop())
        manifest = dv.manifest_json or {}
        # every identifier the output must never contain (checked on the serialized text before writing)
        identifiers = {str(it.get(k)) for it in manifest.get("items", []) for k in (
            "slide_id", "coded_patient_id", "patient_code", "case_id", "block_id", "accession_code",
            "original_filename", "filename") if it.get(k)}
        from dermpath.models import Slide

        for sid in {it["slide_id"] for it in manifest.get("items", [])}:
            sl = db.get(Slide, sid)
            if sl is not None and sl.original_filename:
                identifiers.add(sl.original_filename)
        identifiers |= {Path(i).stem for i in identifiers if "." in i}
        fold_maps = {json.dumps((((r.metrics_json or {}).get("protocol") or {}).get("cv") or {}).get("fold_of"),
                                sort_keys=True) for r in runs.values()}
        fold_of = json.loads(next(iter(fold_maps))) if len(fold_maps) == 1 else {}
        if len(fold_maps) != 1:
            problems.append("the grid runs record different fold maps; fold placement of the pairs not reported")
        nd, excluded = near_duplicate_exclusion(db, dv, fold_of or {})

        # ---------------------------------------------------------------- single runs
        run_rows = []
        for rec in grid:
            run = runs[rec["run_id"]]
            full = run_oof_metrics(db, run, manifest, set())
            restricted = run_oof_metrics(db, run, manifest, excluded)
            reported = ((rec.get("oof") or {}).get("threshold_free") or {})
            stored = (((run.metrics_json or {}).get("oof_summary") or {}).get("threshold_free") or {})
            checks = {}
            for m in ("auroc", "auprc"):
                checks[m] = {"matches_s3_report": close(full[m]["value"], (reported.get(m) or {}).get("value"))
                             and close(full[m]["ci"], (reported.get(m) or {}).get("ci")),
                             "matches_database_oof_summary": close(full[m]["value"], (stored.get(m) or {}).get("value"))
                             and close(full[m]["ci"], (stored.get(m) or {}).get("ci"))}
                if not all(checks[m].values()):
                    problems.append(f"run {rec['encoder']}/{rec['head']}/seed {rec['seed']}: {m} not reproduced")
            run_rows.append({
                "run_id": rec["run_id"], "encoder": rec["encoder"], "head": rec["head"], "seed": rec["seed"],
                "threshold_free_only": True, "all_development_patients": full,
                "excluding_undecided_near_duplicate_patients": restricted,
                "change": {m: (None if restricted[m]["value"] is None or full[m]["value"] is None
                               else restricted[m]["value"] - full[m]["value"]) for m in ("auroc", "auprc")},
                "reproduction_check": checks})

        # ---------------------------------------------------------------- paired comparisons
        comps = []
        by_seed = ((s3.get("comparisons") or {}).get("by_seed") or {})
        for seed_key in sorted(by_seed, key=lambda s: int(s)):
            for group in ("encoder_effects", "head_effects"):
                for c in by_seed[seed_key].get(group) or []:
                    named = {n: runs.get(rid) or db.get(TrainingRun, rid) for n, rid in (c.get("run_ids") or {}).items()}
                    n_boot, bseed, minp = int(c["n_boot"]), int(c["bootstrap_seed"]), int(c["min_patients"])
                    entry = {"group": group, "fixed": c.get("fixed"), "seed": c.get("seed"),
                             "models": sorted(named), "run_ids": c.get("run_ids"), "n_boot": n_boot,
                             "bootstrap_seed": bseed, "min_patients": minp, "split": SPLIT}
                    refusal = comparison_refusal(db, list(named.values()))
                    if refusal is not None:
                        entry.update(status="refused", code=refusal["code"], reason=refusal.get("reason"))
                        comps.append(entry)
                        continue
                    engine_full = paired_runs_comparison(db, named, SPLIT, manifest=manifest, n_boot=n_boot,
                                                         seed=bseed, min_patients=minp, refuse_unaccounted=False)
                    mirror_full = paired_excluding(db, named, manifest, set(), n_boot=n_boot, seed=bseed,
                                                   min_patients=minp)
                    restricted = paired_excluding(db, named, manifest, excluded, n_boot=n_boot, seed=bseed,
                                                  min_patients=minp)
                    full_d = deltas_view(engine_full)
                    check = {"engine_matches_s3_report": same_deltas(full_d, c.get("deltas") or []),
                             "exclusion_path_with_no_exclusion_matches_engine": same_deltas(deltas_view(mirror_full),
                                                                                             full_d)}
                    if not all(check.values()):
                        problems.append(f"comparison {group} {c.get('fixed')} seed {c.get('seed')}: not reproduced")
                    entry.update(status=restricted.get("status"),
                                 all_development_patients={"counts": comparison_counts(engine_full),
                                                           "deltas": full_d},
                                 excluding_undecided_near_duplicate_patients={
                                     "counts": comparison_counts(restricted), "deltas": deltas_view(restricted)},
                                 tuning_set_note=engine_full.get("tuning_set_note"), reproduction_check=check)
                    comps.append(entry)

    # -------------------------------------------------------------------- across seeds
    def seed_summary_runs() -> list[dict]:
        out = []
        for enc, head in sorted({(r["encoder"], r["head"]) for r in run_rows}):
            rows = [r for r in run_rows if (r["encoder"], r["head"]) == (enc, head)]
            out.append({"encoder": enc, "head": head, "seeds": [r["seed"] for r in rows],
                        **{f"{m}_{which}": stats([r[key][m]["value"] for r in rows])
                           for m in ("auroc", "auprc")
                           for which, key in (("all", "all_development_patients"),
                                              ("excluding", "excluding_undecided_near_duplicate_patients"))}})
        return out

    def seed_summary_comps() -> list[dict]:
        acc: dict = {}
        for c in comps:
            for which, key in (("all", "all_development_patients"),
                               ("excluding", "excluding_undecided_near_duplicate_patients")):
                for d in (c.get(key) or {}).get("deltas") or []:
                    k = (c["group"], json.dumps(c["fixed"], sort_keys=True), d["a"], d["b"])
                    acc.setdefault(k, {}).setdefault(which, []).append(
                        {"seed": c["seed"], "auroc": (d.get("auroc") or {}).get("value"),
                         "auroc_ci": (d.get("auroc") or {}).get("ci"), "auprc": (d.get("auprc") or {}).get("value"),
                         "auprc_ci": (d.get("auprc") or {}).get("ci")})
        out = []
        for (group, fixed, a, b), parts in sorted(acc.items()):
            row = {"group": group, "fixed": json.loads(fixed), "a": a, "b": b, "delta": "a - b"}
            for which, rows in parts.items():
                vals = [r["auroc"] for r in rows if r["auroc"] is not None]
                row[which] = {"by_seed": rows, "auroc_delta": stats(vals),
                              "auprc_delta": stats([r["auprc"] for r in rows]),
                              "auroc_sign_consistent": bool(vals) and (all(v > 0 for v in vals)
                                                                       or all(v < 0 for v in vals)),
                              "auroc_ci_excludes_zero_in_seeds": sum(
                                  1 for r in rows if r["auroc_ci"] and (r["auroc_ci"][0] > 0 or r["auroc_ci"][1] < 0))}
            out.append(row)
        return out

    def candidate_rule_check() -> dict:
        """The s3 candidate rule (highest mean OOF AUROC point estimate over the seeds; ties toward meanpool_logreg,
        then handcrafted) re-applied to both analyses. Descriptive: the declared candidate is never changed."""
        decl = (s3.get("pre_declared_test_candidate") or {})
        chosen = decl.get("chosen") or {}

        def rank(key: str) -> list[dict]:
            rows = []
            for enc, head in sorted({(r["encoder"], r["head"]) for r in run_rows}):
                vals = [r[key]["auroc"]["value"] for r in run_rows if (r["encoder"], r["head"]) == (enc, head)]
                rows.append({"encoder": enc, "head": head, "mean_oof_auroc_over_seeds": statistics.fmean(vals)})
            return sorted(rows, key=lambda x: (-x["mean_oof_auroc_over_seeds"], x["head"] != "meanpool_logreg",
                                               not x["encoder"].startswith("handcrafted")))

        full, restricted = rank("all_development_patients"), rank("excluding_undecided_near_duplicate_patients")
        same = lambda r: (r[0]["encoder"], r[0]["head"]) == (chosen.get("encoder"), chosen.get("head"))  # noqa: E731
        return {"rule": decl.get("rule"), "declared": {k: chosen.get(k) for k in ("encoder", "head", "run_id")},
                "ranking_all": full, "ranking_excluding": restricted,
                "rule_reproduces_declared_choice_on_all": same(full),
                "rule_picks_same_combination_after_exclusion": same(restricted),
                "note": "robustness check only; the pre-declared candidate is not re-selected"}

    reproduced = not problems
    report = {
        "schema": SCHEMA, "research_use_only": True, "notice": NOTICE,
        "created_at": _dt.datetime.now(_dt.timezone.utc).isoformat(timespec="seconds"),
        "question": "Do the s3 out-of-fold results and the encoder / head deltas depend on the patients of the "
                    "undecided near-duplicate candidate pairs (which patient-grouped CV placed in different folds)?",
        "inputs": {**inputs, "dataset_version_id": dv.id, "manifest_sha256": dv.manifest_sha256,
                   "split_fingerprint": (manifest or {}).get("split_fingerprint"),
                   "s3_finished_at": s3.get("finished_at"),
                   "s3_code_revision": (s3.get("code_identity") or {}).get("code_revision"),
                   "database_opened": "read-only (sqlite mode=ro URI, PRAGMA query_only=ON)"},
        "code": {"engine": {k: code_identity().get(k) for k in ("code_revision", "code_tree_sha256", "dirty")},
                 "script": "workbench/scripts/sensitivity_near_duplicates.py",
                 "functions": ["dermpath.ml.metrics.evaluate_binary (as dermpath.ml.training.development_summary "
                               "calls it)", "dermpath.ml.evaluation.paired_runs_comparison (full set)",
                               "dermpath.ml.comparison.paired_comparison / restrict_to_common / "
                               "label_tuning_estimates (restricted set)",
                               "dermpath.datasets._near_duplicates (candidate screen)"]},
        "near_duplicates": nd,
        "unit": "prediction unit: slide (bag); resampling unit: patient (patient-cluster bootstrap)",
        "runs": run_rows,
        "runs_across_seeds": seed_summary_runs(),
        "comparisons": comps,
        "comparisons_across_seeds": seed_summary_comps(),
        "candidate_rule_check": candidate_rule_check(),
        "reproduced": reproduced, "problems": problems, "caveats": CAVEATS,
        "engine_runtime_dir": "a throwaway WB_VAR_DIR (removed on exit); workbench/var is never opened",
    }
    shutil.rmtree(sandbox, ignore_errors=True)
    text = json.dumps(report, indent=2, sort_keys=True, default=str) + "\n"
    leaks = sorted({k for k in identifiers | excluded if k and k in text})
    if leaks:
        print(f"error: refusing to write: the output would contain {len(leaks)} patient / slide / case "
              "identifier(s)", file=sys.stderr)
        return 2
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(text, encoding="utf-8")
    print(f"written {out_path} (reproduced: {reproduced}; excluded patients: {nd['excluded']['patients']})",
          file=sys.stderr)
    return 0 if reproduced else 1


if __name__ == "__main__":
    raise SystemExit(main())
