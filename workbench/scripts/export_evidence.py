#!/usr/bin/env python3
"""Sanitized evidence package of the COBRA experiment driver's local reports. RESEARCH USE ONLY.

Not a medical device. The package documents research measurements against report-derived imported reference
labels; it is never a diagnosis and supports no clinical claim. "BCC absent" is not "benign".

What it does
------------
Reads the driver's local reports (``workbench/experiments/reports``: ``s0``-``s7``, ``summary.json``, the
integrity records, ``_superseded/INDEX.jsonl``, ``test_release_history/`` and the last status snapshot) and writes a
small, reviewable package under ``workbench/experiments/evidence/<experiment-id>/``:

* ``index.json``: every file of the package with its sha256, the generator identity and the sanitization rules;
* ``provenance.json``: code SHA and dirty state, driver and engine identities, configs, commands, machine and
  dependency versions, runtime and memory per stage;
* ``dataset.json``: dataset / reference / manifest / split identities, cohort counts (documented vs actual);
* ``identities.json``: encoders, preprocessing, feature sets, folds, runs, model / bundle identities;
* ``results.json``: compact comparison, seed, learning-curve, ablation, sampling-budget and resource results with
  their uncertainty and caveats, ONLY from stages that are valid offline (see below);
* ``artifacts_index.json``: sha256 and size of the bulky local artifacts and of the artifacts the reports pin
  (checkpoints, manifests, feature-set specs), never the artifacts themselves;
* ``exclusions.json``: stale, invalid, failed, legacy, dry-run and superseded experiments with their reasons;
  arms that are blocked or invalid for comparison;
* ``test_releases.json``: the test-release history (or that none was recorded);
* ``blockers.json``: missing data, weights or accelerators, missing or failed stages, refused requests;
* ``README.md``: a short generated guide.

Never included: databases, slides, model weights, embeddings, per-slide or per-patient tables, patient codes, slide
file names, local absolute paths. Patient codes, accession codes, slide / bag ids and file names that survive the
allowlist are replaced by salted HMAC-SHA256 tokens (``pt:…``, ``file:…``, ``id:…``, ``path:…``); the salt stays
local (``<reports-dir>/_state/evidence_salt`` by default, never in the package). After writing, every file is
re-scanned; any leak aborts the export and nothing is left behind.

Offline validity: a stage contributes results only when its report has a fingerprint, its bytes match the integrity
record, it passes the driver's database-free content rules (``report_content_problems``: every s3 grid run succeeded,
no crashed s4 / s4b work), it is not a dry run (unless ``--include-dry-run``), the recorded implementation (driver
sha256, engine code tree, extractor version) equals the current one, and every upstream report is the one it was
computed from and is itself valid. Database and object-store artifacts cannot be checked offline: a stage whose SAME
report bytes the driver's last status snapshot holds invalid or failed is excluded too, and the snapshot is reported
beside.

Usage (from ``workbench/api``)::

    .venv/bin/python ../scripts/export_evidence.py --experiment-id cobra-bcc-2026-10-28
    .venv/bin/python ../scripts/export_evidence.py --experiment-id X --reports-dir /tmp/r --out-root /tmp/evidence

Exit codes: 0 written, 1 refused (a leak was detected, or the package exists without ``--force``), 2 usage.
"""

from __future__ import annotations

import argparse
import datetime as _dt
import hashlib
import hmac
import importlib.util
import json
import os
import platform
import re
import secrets
import shutil
import subprocess
import sys
from pathlib import Path

SCRIPT = Path(__file__).resolve()
WORKBENCH = SCRIPT.parents[1]
REPO = WORKBENCH.parent
API_DIR = WORKBENCH / "api"
DRIVER_PATH = SCRIPT.parent / "run_cobra_experiments.py"
DEFAULT_REPORTS_DIR = WORKBENCH / "experiments" / "reports"
DEFAULT_OUT_ROOT = WORKBENCH / "experiments" / "evidence"
CONFIG_DIR = WORKBENCH / "experiments" / "configs"
EVIDENCE_SCHEMA = "dermpath.cobra_evidence/1"
ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$")
MAX_FILE_BYTES = 2 * 1024 * 1024
FORBIDDEN_SUFFIXES = {".db", ".sqlite", ".sqlite3", ".npy", ".npz", ".safetensors", ".pt", ".pth", ".bin", ".ckpt",
                      ".svs", ".tif", ".tiff", ".ndpi", ".mrxs", ".scn", ".bif", ".dcm", ".isyntax", ".czi",
                      ".png", ".jpg", ".jpeg", ".parquet", ".h5", ".hdf5", ".pkl", ".pickle"}
DOCUMENTED_COHORT = {"source": "workbench/docs/public-datasets.md (COBRA BCC subset)", "slides": 60, "patients": 50,
                     "slide_labels": {"bcc_present": 30, "bcc_absent_not_benign": 30}}
NOTICE = ("RESEARCH USE ONLY. Not a medical device; nothing here is a diagnosis or a clinical performance claim. "
          "Labels are COBRA's report-derived imported reference labels (not expert reads in this workbench): metrics "
          "measure agreement with that reference. 'BCC absent' is not 'benign'.")


# =================================================================================================== sanitizer

COBRA_CODE_RE = re.compile(r"COBRA-[A-Za-z]*\d[A-Za-z0-9_-]*")
SLIDE_FILE_RE = re.compile(r"[A-Za-z0-9][\w.\-]*\.(?:tiff?|svs|ndpi|mrxs|scn|bif|vms|vmu|svslide|isyntax|dcm|czi|"
                           r"qptiff)\b", re.IGNORECASE)
ABS_PATH_RE = re.compile(r"(?:/Users|/home|/private|/var/folders|/tmp|/Volumes|/mnt|/opt|/root)/[^\s\"'<>|,;)]*")
PATIENT_KEYS = {"patient_code", "patient_codes", "coded_patient_id", "patient_id", "patient", "patient_key",
                "accession_code", "fitting_patient_codes", "patient_codes_by_split"}
FILE_KEYS = {"filename", "source_file", "original_filename", "source_filename", "slide_filename", "file_name"}
ROW_ID_KEYS = {"bag_id", "bag_ids", "slide_id", "slide_ids", "train_slide_ids", "fitting_slide_ids", "case_id",
               "excluded_bags_unscorable_under_some_model"}
ID_KEYED_MAPS = {"fold_of_patient_code", "per_slide", "patient_folds"}  # mappings whose KEYS are identifiers


def _identifier_like(v: str) -> bool:
    return isinstance(v, str) and len(v) >= 6 and any(c.isdigit() for c in v)


class LeakDetected(RuntimeError):
    pass


class Sanitizer:
    """Salted HMAC tokens for identifiers; local paths made relative or tokenised."""

    def __init__(self, salt: bytes, known: set[str] | None = None):
        self.salt = salt
        self.known = {k for k in (known or set()) if _identifier_like(k)}
        self._known_re = (re.compile(r"(?<![\w-])(" + "|".join(re.escape(k) for k in sorted(self.known, key=len,
                                                                                               reverse=True))
                                     + r")(?![\w-])") if self.known else None)
        home = str(Path.home())
        self.literals = [(str(WORKBENCH), "<workbench>"), (str(REPO), "<repo>"), (home, "<home>")]

    @property
    def salt_id(self) -> str:
        return hashlib.sha256(b"dermpath-evidence-salt-id|" + self.salt).hexdigest()[:12]

    def token(self, kind: str, value: str) -> str:
        return f"{kind}:" + hmac.new(self.salt, f"{kind}|{value}".encode(), hashlib.sha256).hexdigest()[:12]

    def scrub_str(self, s: str) -> str:
        for lit, rep in self.literals:
            if lit and lit in s:
                s = s.replace(lit, rep)
        s = ABS_PATH_RE.sub(lambda m: self.token("path", m.group(0)), s)
        s = COBRA_CODE_RE.sub(lambda m: self.token("pt", m.group(0)), s)
        s = SLIDE_FILE_RE.sub(lambda m: self.token("file", m.group(0)), s)
        if self._known_re is not None:
            s = self._known_re.sub(lambda m: self.token("id", m.group(0)), s)
        return s

    def scrub(self, obj, key: str | None = None):
        if isinstance(obj, dict):
            if key in ID_KEYED_MAPS:  # a mapping keyed by identifiers: tokenise the keys
                return {self.token("id", str(k)): self.scrub(v, None) for k, v in obj.items()}
            return {self.scrub_str(str(k)): self.scrub(v, str(k)) for k, v in obj.items()}
        if isinstance(obj, (list, tuple)):
            return [self.scrub(v, key) for v in obj]
        if isinstance(obj, str):
            if key in PATIENT_KEYS:
                return self.token("pt", obj)
            if key in FILE_KEYS:
                return self.token("file", obj)
            if key in ROW_ID_KEYS:
                return self.token("id", obj)
            return self.scrub_str(obj)
        return obj

    def leaks(self, text: str) -> list[str]:
        found = []
        for rx, what in ((COBRA_CODE_RE, "COBRA patient/accession code"), (SLIDE_FILE_RE, "slide file name")):
            m = rx.search(text)
            if m:
                found.append(f"{what}: {m.group(0)[:3]}…")
        if str(Path.home()) in text:
            found.append("local home path")
        if self._known_re is not None and self._known_re.search(text):
            found.append("a known identifier from the reports")
        return found


def collect_identifiers(obj, out: set[str], key: str | None = None) -> None:
    """Every string stored under an identifier key anywhere in the reports (to catch them inside free text)."""
    if isinstance(obj, dict):
        for k, v in obj.items():
            if key in ID_KEYED_MAPS:
                out.add(str(k))
            collect_identifiers(v, out, str(k))
    elif isinstance(obj, (list, tuple)):
        for v in obj:
            collect_identifiers(v, out, key)
    elif isinstance(obj, str) and key in PATIENT_KEYS | FILE_KEYS | ROW_ID_KEYS:
        out.add(obj)
        if key in FILE_KEYS and "." in obj:
            out.add(obj.rsplit(".", 1)[0])  # the stem appears without its extension in other places


def load_salt(path: Path) -> bytes:
    if path.is_file():
        data = path.read_bytes().strip()
        if len(data) >= 32:
            return data
    path.parent.mkdir(parents=True, exist_ok=True)
    data = secrets.token_hex(32).encode()
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "wb") as fh:
        fh.write(data)
    return data


# =================================================================================================== helpers


def load_driver():
    spec = importlib.util.spec_from_file_location("dermpath_cobra_driver_for_evidence", DRIVER_PATH)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def read_json(path: Path):
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return None


def g(d, *keys, default=None):
    """Nested ``.get`` that tolerates missing levels and non-dicts."""
    for k in keys:
        if not isinstance(d, dict):
            return default
        d = d.get(k)
    return default if d is None else d


def metric(entry) -> dict | None:
    if not isinstance(entry, dict):
        return None
    return {k: entry.get(k) for k in ("value", "ci", "ci_reason", "numerator", "denominator", "undefined_reason",
                                      "tuning_set") if k in entry}


def git_state() -> dict:
    def run(*args, text=True):
        try:
            r = subprocess.run(["git", "-c", "core.quotepath=off", *args], cwd=WORKBENCH, capture_output=True,
                               text=text, timeout=20)
            return r if r.returncode == 0 else None
        except (OSError, subprocess.SubprocessError):
            return None

    head = run("rev-parse", "HEAD")
    if head is None:
        return {"git_head": None, "note": "git unavailable"}
    branch = run("rev-parse", "--abbrev-ref", "HEAD")
    status = run("status", "--porcelain", "--", ".")
    diff = run("diff", "HEAD", "--binary", "--no-color", "--no-ext-diff", "--", ".", text=False)
    lines = [ln for ln in (status.stdout.splitlines() if status else []) if ln.strip()]
    return {"git_head": head.stdout.strip(), "branch": branch.stdout.strip() if branch else None,
            "dirty": bool(lines), "changed_paths": len([ln for ln in lines if not ln.startswith("??")]),
            "untracked_paths": len([ln for ln in lines if ln.startswith("??")]),
            "tracked_diff_sha256": hashlib.sha256(diff.stdout).hexdigest() if diff and diff.stdout else None,
            "scope": "workbench/ of the repository"}


def current_engine_identity() -> dict:
    try:
        if str(API_DIR) not in sys.path:
            sys.path.insert(0, str(API_DIR))
        from dermpath.ml.artifacts import code_identity, dependency_versions
        from dermpath.ml.feature_sets import EXTRACTOR_VERSION

        ci = code_identity()
        return {"engine_code_tree_sha256": ci.get("code_tree_sha256"), "code_revision": ci.get("code_revision"),
                "dirty": ci.get("dirty"), "dirty_diff_sha256": ci.get("dirty_diff_sha256"),
                "extractor_version": EXTRACTOR_VERSION,
                "dependency_versions_sha256": hashlib.sha256(json.dumps(
                    dependency_versions(), sort_keys=True, separators=(",", ":")).encode()).hexdigest()}
    except Exception as exc:  # noqa: BLE001 - recorded, the export continues
        return {"error": f"{type(exc).__name__}: {exc}"}


# =================================================================================================== offline status


class Reports:
    def __init__(self, drv, reports_dir: Path, include_dry_run: bool, current_impl: dict):
        self.drv = drv
        self.dir = reports_dir
        self.state = reports_dir / "_state"
        self.include_dry_run = include_dry_run
        self.current = {**current_impl, "driver_sha256": sha256_file(DRIVER_PATH)}
        self.reports = {}
        for s in drv.STAGES:
            p = self.path(s)
            self.reports[s] = read_json(p) if p.is_file() else None
        snap = read_json(self.state / "status.json")
        self.snapshot = snap if isinstance(snap, dict) else {}
        self._status: dict[str, dict] = {}

    def snapshot_verdict(self, stage: str, rep: dict, report_sha256: str) -> dict | None:
        """The driver's last status snapshot entry for ``stage`` when it judged THESE report bytes (its
        ``report_sha256``; for an older snapshot without it, the same recorded fingerprint and finish time)."""
        v = (self.snapshot.get("stages") or {}).get(stage)
        if not isinstance(v, dict):
            return None
        if v.get("report_sha256"):
            same = v["report_sha256"] == report_sha256
        else:
            same = (bool(v.get("recorded_fingerprint_sha256"))
                    and v.get("recorded_fingerprint_sha256") == g(rep, "fingerprint", "sha256")
                    and v.get("finished_at") is not None and v.get("finished_at") == rep.get("finished_at"))
        return v if same else None

    def path(self, stage: str) -> Path:
        return self.dir / ("summary.json" if stage == "s8" else f"{stage}.json")

    def status(self, stage: str) -> dict:
        if stage in self._status:
            return self._status[stage]
        self._status[stage] = {"status": "invalid", "reasons": ["dependency cycle"]}
        drv = self.drv
        p = self.path(stage)
        err = read_json(self.state / f"{stage}.error.json")
        reasons: list[str] = []
        integrity: list[str] = []
        failed: list[str] = []
        rep = self.reports.get(stage)
        out = {"stage": stage, "title": drv.TITLES.get(stage), "report": p.name if p.is_file() else None}
        if not p.is_file():
            out.update(status="failed" if err else "missing",
                       reasons=[f"last attempt failed: {str((err or {}).get('error'))[:300]}"] if err else
                       ["no report"])
            self._status[stage] = out
            return out
        if not isinstance(rep, dict):
            integrity.append("report unreadable")
        else:
            out.update(finished_at=rep.get("finished_at"), dry_run=bool(rep.get("dry_run")),
                       recorded_code_revision=g(rep, "code_identity", "code_revision"),
                       recorded_driver_sha256=g(rep, "driver", "sha256"))
            fp = rep.get("fingerprint") or {}
            side = read_json(self.state / f"{stage}.integrity.json")
            comps = fp.get("components") or {}
            if not fp:
                reasons.append("legacy report without an input fingerprint: inputs cannot be verified")
            elif not side:
                integrity.append("no integrity record")
            elif side.get("report_sha256") != sha256_file(p):
                integrity.append("report bytes changed after it was written")
            # The driver's database-free content rules (e.g. an s3 whose grid run did not succeed, s4 / s4b work
            # that crashed): a report the driver holds invalid is never evidence here either.
            integrity.extend(f"content: {x}" for x in drv.report_content_problems(stage, rep))
            verdict = self.snapshot_verdict(stage, rep, sha256_file(p))
            if verdict and verdict.get("status") in ("invalid", "failed"):
                why = "; ".join(str(x) for x in (verdict.get("reasons") or [])[:3])
                (integrity if verdict["status"] == "invalid" else failed).append(
                    f"the driver's last status snapshot ({self.snapshot.get('at')}) holds this report "
                    f"{verdict['status']}" + (f": {why[:400]}" if why else ""))
            if rep.get("dry_run") and not self.include_dry_run:
                reasons.append("dry run (plumbing only; never evidence)")
            impl = comps.get("implementation") or {}
            for k in ("driver_sha256", "engine_code_tree_sha256", "extractor_version", "dependency_versions_sha256"):
                if impl and impl.get(k) and self.current.get(k) and impl.get(k) != self.current.get(k):
                    reasons.append(f"implementation changed since the run: {k} {str(impl.get(k))[:12]} -> "
                                   f"{str(self.current.get(k))[:12]}")
            for dep, ident in (comps.get("upstream") or {}).items():
                reasons.extend(self._chain(stage, dep, ident, optional=False))
            for dep, ident in (comps.get("optional_upstream") or {}).items():
                reasons.extend(self._chain(stage, dep, ident, optional=True))
        if err and (self.state / f"{stage}.error.json").stat().st_mtime >= p.stat().st_mtime:
            failed.append(f"last attempt failed: {str(err.get('error'))[:300]}")
        if integrity:
            status = "invalid"
        elif failed:
            status = "failed"
        elif reasons:
            status = "obsolete" if stage == "s6" else "stale"
        else:
            status = "valid"
        out.update(status=status, reasons=integrity + failed + reasons)
        self._status[stage] = out
        return out

    def _chain(self, stage: str, dep: str, ident, *, optional: bool) -> list[str]:
        p = self.path(dep)
        lab = f"{'optional ' if optional else ''}upstream {dep}"
        if ident is None:
            if not p.is_file():
                return []
            if optional and dep == "s6":
                return (["a valid test release appeared since this report was written"]
                        if stage == "s7" and self.status(dep)["status"] == "valid" else [])
            return [f"{lab} appeared since this report was written"]
        if not p.is_file():
            return [f"{lab} report is missing now"]
        if ident.get("report_sha256") != sha256_file(p):
            return [f"{lab} changed since this report was written (re-run, forced or edited)"]
        st = self.status(dep)["status"]
        if st != "valid" and not (dep == "s6" and st in ("obsolete", "failed")):
            return [f"{lab} is {st}"]
        return []

    def valid(self, stage: str) -> bool:
        return self.status(stage)["status"] == "valid"

    def get(self, stage: str):
        """The report of a stage that is valid offline, else None (its numbers are not evidence)."""
        return self.reports.get(stage) if self.valid(stage) else None


# =================================================================================================== builders


def build_provenance(r: Reports, git: dict, engine: dict, argv: list[str]) -> dict:
    stages = {}
    for s in r.drv.STAGES:
        rep = r.reports.get(s)
        if not isinstance(rep, dict):
            continue
        stages[s] = {"command_argv": rep.get("argv"), "started_at": rep.get("started_at"),
                     "finished_at": rep.get("finished_at"), "elapsed_seconds": rep.get("elapsed_seconds"),
                     "dry_run": rep.get("dry_run"), "code_identity": rep.get("code_identity"),
                     "driver_sha256": g(rep, "driver", "sha256"), "budgets": rep.get("budgets"),
                     "fingerprint_sha256": g(rep, "fingerprint", "sha256"),
                     "implementation": g(rep, "fingerprint", "components", "implementation"),
                     "costs": rep.get("costs"), "midnight_device": rep.get("midnight_device"),
                     "offline_status": r.status(s)["status"]}
    configs = []
    for p in sorted(CONFIG_DIR.glob("*.json")):
        configs.append({"file": f"experiments/configs/{p.name}", "sha256": sha256_file(p), "content": read_json(p)})
    any_rep = next((rep for rep in r.reports.values() if isinstance(rep, dict)), {}) or {}
    s0 = r.reports.get("s0") if isinstance(r.reports.get("s0"), dict) else {}
    return {"code": {"repository": git, "engine_now": engine,
                     "driver": {"file": "workbench/scripts/run_cobra_experiments.py",
                                "sha256_now": sha256_file(DRIVER_PATH)},
                     "exporter": {"file": "workbench/scripts/export_evidence.py", "sha256": sha256_file(SCRIPT)},
                     "recorded_code_revisions": sorted({str(g(v, "code_identity", "code_revision"))
                                                        for v in r.reports.values() if isinstance(v, dict)})},
            "configs": configs,
            "commands": {"export": ["export_evidence.py", *argv],
                         "per_stage": {s: v["command_argv"] for s, v in stages.items()}},
            "stages": stages,
            "machine": (s0 or {}).get("machine"),
            "devices": {k: (s0 or {}).get("devices", {}).get(k) for k in (
                "available", "resolved_for_midnight", "cuda", "mps_built", "precision_support")} if s0 else None,
            "dependency_versions": any_rep.get("dependency_versions"),
            "export_host": {"python": platform.python_version(), "platform": platform.platform()}}


def build_dataset(r: Reports) -> dict:
    s1 = r.reports.get("s1") if isinstance(r.reports.get("s1"), dict) else None
    if not s1:
        return {"status": r.status("s1")["status"], "note": "no dataset report"}
    d = s1.get("dataset") or {}
    table = s1.get("split_table") or {}
    slide_labels: dict = {}
    for sp in ("train", "val", "test"):
        for c, n in (g(table, sp, "slides") or {}).items():
            slide_labels[c] = slide_labels.get(c, 0) + int(n or 0)
    counts = d.get("counts") or {}
    actual = {"slides": counts.get("slides"), "patients": counts.get("patients"), "slide_labels": slide_labels}
    audit = s1.get("audit_now") or s1.get("audit_at_freeze") or {}
    return {"offline_status": r.status("s1")["status"],
            "identity": {k: d.get(k) for k in ("dataset_version_id", "name", "version", "lineage_id", "status",
                                               "frozen_at", "manifest_sha256", "manifest_verified",
                                               "split_family_id", "split_fingerprint", "data_mode",
                                               "positive_class", "patient_label_rule")},
            "reference_standard": d.get("reference_standard"),
            "reference_standard_notice": d.get("reference_standard_notice"),
            "label_display": d.get("label_display"),
            "labels_note": s1.get("labels_note"),
            "counts": counts, "split_table": table, "split_request": s1.get("split_request"),
            "development_pool_patients": s1.get("development_pool_patients"),
            "test_patients": s1.get("test_patients"),
            "cohort_reconciliation": {"documented": DOCUMENTED_COHORT, "actual": actual,
                                      "matches": all(actual.get(k) == DOCUMENTED_COHORT[k]
                                                     for k in ("slides", "patients", "slide_labels"))},
            "public_dataset": {k: (s1.get("public_dataset") or {}).get(k) for k in (
                "dataset", "full_name", "licence", "license", "commercial_use", "attribution_required",
                "documentation", "label_mapping")},
            "audit_summary": {"status": audit.get("status"),
                              "mixed_label_patients": len(g(audit, "mixed_label_patients", "patient_codes") or []),
                              "patients_in_more_than_one_split": g(audit, "patient_independence",
                                                                   "patients_in_more_than_one_split"),
                              "class_absent": audit.get("class_absent")},
            "exclusions_count": len(s1.get("exclusions") or []),
            "near_duplicate_decisions_count": len(s1.get("near_duplicate_decisions") or []),
            "acknowledged_warnings": (s1.get("acknowledged_warnings") or {}).get("warnings")
            if isinstance(s1.get("acknowledged_warnings"), dict) else s1.get("acknowledged_warnings")}


FS_KEYS = ("feature_set_id", "name", "status", "execution_mode", "encoder_id", "dataset_version_id", "spec_sha256",
           "encoder_spec_sha256", "weights_sha256", "weights_config_sha256", "policy_sha256", "stain_policy_sha256",
           "stain_reference_sha256", "extraction_env_sha256", "input_snapshot_sha256", "patch_policy", "precision",
           "device_class", "qc_source", "extraction")


def fs_identity(summary) -> dict | None:
    fs = g(summary, "feature_set")
    if not isinstance(fs, dict):
        return None
    out = {k: fs.get(k) for k in FS_KEYS}
    sp = fs.get("stain_policy") or {}
    out["stain_policy"] = {"method": sp.get("method"), "reference_sha256": sp.get("reference_sha256"),
                           "fitted_on": g(sp, "reference_fit", "fitted_on"),
                           "fitting_slides": len(g(sp, "reference_fit", "train_slide_ids") or [])} if sp else None
    out["counts"] = fs.get("counts")
    return out


def run_identity(rec: dict) -> dict:
    return {"run_id": rec.get("run_id"), "encoder": rec.get("encoder"), "head": rec.get("head"),
            "seed": rec.get("seed"), "role": rec.get("role"), "fraction": rec.get("fraction"),
            "repeat": rec.get("repeat"), "status": rec.get("status"), "identity_sha256": rec.get("identity_sha256"),
            "checkpoint_sha256": g(rec, "checkpoint", "sha256"), "feature_set_id": rec.get("feature_set_id"),
            "family_id": rec.get("family_id"), "code_revision": rec.get("code_revision"),
            "fold_assignment_sha256": rec.get("fold_assignment_sha256"),
            "threshold": (g(rec, "threshold", "value") if isinstance(rec.get("threshold"), dict)
                          else rec.get("threshold")),
            "preprocessing_fold_safety": {k: g(rec, "preprocessing_fold_safety", k) for k in
                                          ("status", "valid_for_cv_comparison")}
            if rec.get("preprocessing_fold_safety") else None,
            "training_summary": rec.get("training_summary")}


def build_identities(r: Reports) -> dict:
    s0, s2, s3 = (r.reports.get(s) if isinstance(r.reports.get(s), dict) else {} for s in ("s0", "s2", "s3"))
    s4, s4b, s6 = (r.reports.get(s) if isinstance(r.reports.get(s), dict) else {} for s in ("s4", "s4b", "s6"))
    encs = {}
    for e, v in (g(s0, "encoders", "benchmark_encoders") or {}).items():
        encs[e] = {k: v.get(k) for k in ("status", "spec_sha256", "weights_sha256", "weights_config_sha256",
                                         "input_size", "embedding_dim")}
        encs[e]["license"] = {k: g(v, "license", k) for k in ("name", "commercial_use", "url")}
    sets = {}
    for e, v in (g(s2, "encoders") or {}).items():
        sets[f"s2 technical {e}"] = fs_identity(v.get("feature_set"))
    for e, v in (g(s3, "feature_sets") or {}).items():
        sets[f"s3 supervised {e}"] = fs_identity(g(v, "supervised_set", "feature_set"))
    for arm, by in (g(s4, "arms") or {}).items():
        for e, v in (by or {}).items():
            if isinstance(v, dict) and v.get("feature_set"):
                sets[f"s4 {arm} {e}"] = fs_identity(g(v, "feature_set", "feature_set"))
    for e, v in (g(s4b, "encoders") or {}).items():
        if isinstance(v, dict) and v.get("feature_set"):
            sets[f"s4b budget {e}"] = fs_identity(g(v, "feature_set", "feature_set"))
    runs = [run_identity(x) for x in (g(s3, "runs") or []) if isinstance(x, dict)]
    for arm, by in (g(s4, "arms") or {}).items():
        for e, v in (by or {}).items():
            if isinstance(v, dict) and isinstance(v.get("run"), dict):
                runs.append({**run_identity(v["run"]), "role": arm, "stage": "s4"})
    for e, v in (g(s4b, "encoders") or {}).items():
        if isinstance(v, dict) and isinstance(v.get("run"), dict):
            runs.append({**run_identity(v["run"]), "role": "sampling_budget_higher", "stage": "s4b"})
    reg = g(s6, "registry") or {}
    return {"encoders": encs,
            "preprocessing": {"policy": g(s2, "policy"), "policy_identity": g(s2, "policy_identity")},
            "feature_sets": sets,
            "folds": {"protocol": g(s3, "protocol"),
                      "note": "fold_assignment_sha256 hashes each run's patient -> fold map (the map itself contains "
                              "patient codes and is not exported)"},
            "runs": runs,
            "model_and_bundle": {"model_id": g(reg, "model", "id"), "bundle_id": reg.get("bundle_id"),
                                 "bundle_sha256": g(reg, "bundle", "bundle_sha256"),
                                 "checkpoint_sha256": g(reg, "model", "checkpoint_sha256")} if reg else None,
            "offline_status": {s: r.status(s)["status"] for s in ("s0", "s2", "s3", "s4", "s4b", "s6")}}


def oof_view(rec: dict) -> dict:
    oof = rec.get("oof") or {}
    return {"encoder": rec.get("encoder"), "head": rec.get("head"), "seed": rec.get("seed"), "role": rec.get("role"),
            "fraction": rec.get("fraction"), "repeat": rec.get("repeat"), "status": rec.get("status"),
            "prediction_unit": "slide (bag)", "n_items": oof.get("n_items"), "n_patients": oof.get("n_patients"),
            "positives": oof.get("positives"), "negatives": oof.get("negatives"),
            "n_unscorable": oof.get("n_unscorable"), "tuning_set": oof.get("tuning_set"),
            "threshold": oof.get("threshold"), "threshold_selection_status": oof.get("threshold_selection_status"),
            "threshold_free": {k: metric(v) for k, v in (oof.get("threshold_free") or {}).items()},
            "at_operating_point": {k: metric(v) for k, v in (oof.get("at_operating_point") or {}).items()},
            "evaluation_prevalence": oof.get("evaluation_prevalence"),
            "calibration": oof.get("calibration"), "intention_to_evaluate": oof.get("intention_to_evaluate")}


def comparison_view(c) -> dict | None:
    if not isinstance(c, dict):
        return None
    return {"fixed": c.get("fixed"), "seed": c.get("seed"), "models": c.get("models"), "status": c.get("status"),
            "code": c.get("code"), "reason": c.get("reason"), "n_boot": c.get("n_boot"),
            "bootstrap_seed": c.get("bootstrap_seed"), "prediction_unit": c.get("prediction_unit"),
            "subject_accounting": c.get("subject_accounting"),
            "excluded_bags": len(c.get("excluded_bags_unscorable_under_some_model") or []),
            "tuning_set": c.get("tuning_set"), "tuning_set_note": c.get("tuning_set_note"),
            "deltas": [{"a": d.get("a"), "b": d.get("b"), "delta": d.get("delta"),
                        **{m: {**{k: (d.get(m) or {}).get(k) for k in ("value", "ci", "ci_reason")},
                               **({"tuning_set": True} if (d.get(m) or {}).get("tuning_set") else {})}
                           for m in ("auroc", "auprc", "sensitivity", "specificity", "brier") if d.get(m)},
                        "mcnemar_p": d.get("mcnemar_p"), "mcnemar_tuning_set": d.get("mcnemar_tuning_set")}
                       for d in c.get("deltas") or []],
            "reference_standard": c.get("reference_standard")}


LEGACY_MACENKO = ("macenko under dev_cv recorded before the fold-safety rule: its shared dataset-fitted stain "
                  "reference saw the held-out folds; invalid for CV comparison")


def arm_is_evidence(v: dict) -> bool:
    """An ablation arm counts only when it succeeded AND (for learned preprocessing such as macenko) the driver
    recorded it as evidence after the fold-safety rule; pre-rule macenko results never count."""
    if v.get("status") != "succeeded":
        return False
    if "counts_as_evidence" in v:
        return v.get("counts_as_evidence") is True
    return not str(g(v, "overrides", "stain_normalization") or "").startswith("macenko")


def build_results(r: Reports) -> dict:
    out: dict = {"notice": NOTICE, "included_stages": [s for s in r.drv.STAGES if r.valid(s)],
                 "rule": "only stages valid offline contribute numbers; everything else is in exclusions.json"}
    s2 = r.get("s2")
    if s2:
        out["technical"] = {e: {"validation_passed": g(v, "technical_validation", "passed"),
                                "max_abs_diff": g(v, "technical_validation", "result", "summary", "max_abs_diff"),
                                "patches_total": g(v, "feature_set", "aggregate", "patches_total"),
                                "patches_per_slide": g(v, "feature_set", "aggregate", "patches_per_slide"),
                                "embed_patches_per_second": g(v, "feature_set", "aggregate", "fresh",
                                                              "embed_patches_per_second"),
                                "coverage": g(v, "feature_set", "aggregate", "coverage"),
                                "cache_reuse_all_hits": g(v, "cache_reuse", "re_extraction", "all_cache_hits")}
                            for e, v in (s2.get("encoders") or {}).items()}
    s3 = r.get("s3")
    if s3:
        comps = s3.get("comparisons") or {}
        out["development_comparison"] = {
            "protocol": {k: g(s3, "protocol", k) for k in ("evaluation_protocol", "cv_folds", "threshold_rule",
                                                           "calibration", "seeds", "fold_consistency", "test")},
            "runs_oof": [oof_view(x) for x in s3.get("runs") or [] if isinstance(x, dict)],
            "seed_summary": s3.get("seed_summary"),
            "comparisons_primary_seed": {k: [comparison_view(c) for c in comps.get(k) or []]
                                         for k in ("encoder_effects", "head_effects")},
            "four_way_primary_seed": comparison_view(comps.get("four_way")),
            "comparisons_by_seed": {s: {k: ([comparison_view(c) for c in v.get(k) or []] if k != "four_way"
                                            else comparison_view(v.get(k)))
                                        for k in ("encoder_effects", "head_effects", "four_way")}
                                    for s, v in (comps.get("by_seed") or {}).items()},
            "comparisons_across_seeds": comps.get("across_seeds"),
            "learning_curves": [{"encoder": c.get("encoder"), "head": c.get("head"),
                                 "points": [{k: p.get(k) for k in ("fraction", "n_repeats", "n_succeeded",
                                                                   "train_patients", "final_model_patients",
                                                                   "auroc_mean", "auroc_min", "auroc_max")}
                                            for p in c.get("points") or []]}
                                for c in s3.get("learning_curves") or []],
            "pre_declared_test_candidate": {k: g(s3, "pre_declared_test_candidate", k)
                                            for k in ("rule", "declared_at", "seeds", "ranking", "tie")}
            | {"chosen": {k: g(s3, "pre_declared_test_candidate", "chosen", k)
                          for k in ("encoder", "head", "run_id")}},
            "test_untouched_check": s3.get("test_untouched_check"),
            "labels": "development metrics after threshold selection are tuning estimates (optimistic); calibration "
                      "measured on the same out-of-fold scores used to fit it is in-sample"}
    s4 = r.get("s4")
    if s4:
        arms = {}
        for arm, by in (s4.get("arms") or {}).items():
            arms[arm] = {}
            for e, v in (by or {}).items():
                v = v or {}
                ev = arm_is_evidence(v)
                arms[arm][e] = {"status": v.get("status") if ev or v.get("status") != "succeeded"
                                else "invalid_for_cv_comparison", "counts_as_evidence": ev,
                                "reason": v.get("reason") or v.get("error") or (None if ev else LEGACY_MACENKO),
                                "comparison": comparison_view(v.get("comparison")) if ev else None}
        prec = s4.get("precision") or {}
        out["ablations"] = {"head": s4.get("head"), "seed": s4.get("seed"), "arms": arms,
                            "not_evidence": s4.get("not_evidence"),
                            "coverage_uniform_vs_spatial": {e: g(v, "aggregate") for e, v in
                                                            (s4.get("coverage_side_by_side") or {}).items()},
                            "precision": {p: {k: c.get(k) for k in ("supported", "accepted", "speedup_vs_fp32",
                                                                    "reason")}
                                          | {"cosine_min": g(c, "comparison", "cosine_min"),
                                             "rel_l2": g(c, "comparison", "rel_l2")}
                                          for p, c in (prec.get("candidates") or {}).items()},
                            "precision_downstream_fp16": {k: g(prec, "downstream_fp16", k) for k in ("status",
                                                                                                    "reason")}}
    s4b = r.get("s4b")
    if s4b:
        out["sampling_budget"] = {
            "budgets": s4b.get("budgets"), "head": s4b.get("head"), "seed": s4b.get("seed"),
            "development_only": s4b.get("development_only"), "note": s4b.get("note"),
            "encoders": {e: {"status": (v or {}).get("status"), "reason": (v or {}).get("reason"),
                             "coverage": (v or {}).get("coverage"), "resources": (v or {}).get("resources"),
                             "prediction_changes": (v or {}).get("prediction_changes"),
                             "comparison": comparison_view((v or {}).get("comparison")),
                             "costs": (v or {}).get("costs")} for e, v in (s4b.get("encoders") or {}).items()}}
    s5 = r.get("s5")
    if s5:
        out["resources"] = {"extraction": [{k: row.get(k) for k in (
            "source", "encoder", "device", "precision", "slides", "fresh_extractions", "patches_per_slide",
            "patch_read_patches_per_second", "embedding_patches_per_second", "end_to_end_patches_per_second",
            "end_to_end_seconds_per_slide", "compute_seconds_per_slide", "peak_rss_bytes_max",
            "storage_bytes_per_slide", "cache_reuse_speedup", "cost_per_slide")} for row in s5.get("extraction") or []],
            "training": {k: g(s5, "training", k) for k in ("training_seconds", "by_head")},
            "precision_throughput": s5.get("precision_throughput"), "cost": s5.get("cost"),
            "definitions": s5.get("definitions")}
    s7 = r.get("s7")
    if s7:
        out["failure_analysis"] = {"dominant_categories": s7.get("dominant_categories"),
                                   "learning_curve_slopes": s7.get("learning_curve_slopes"),
                                   "test_errors_note": s7.get("test_errors_note"),
                                   "oof_error_counts": [{k: x.get(k) for k in ("encoder", "head", "seed", "role",
                                                                               "fraction", "status", "counts",
                                                                               "counts_by_error_type")}
                                                        for x in s7.get("oof_runs") or []],
                                   "note": s7.get("note")}
    s8 = r.get("s8")
    out["caveats"] = (s8 or {}).get("caveats") or list(getattr(r.drv, "CAVEATS", []))
    out["statements"] = [NOTICE, "Seed repeats measure optimisation variability, not additional independent patients.",
                         "Out-of-fold comparisons are development evidence; no winner is declared from them."]
    return out


def build_test_releases(r: Reports) -> dict:
    hist_dir = r.dir / "test_release_history"
    cur = r.path("s6")
    cur_sha = sha256_file(cur) if cur.is_file() else None
    items = []
    files = sorted(hist_dir.glob("s6.*.json")) if hist_dir.is_dir() else []
    if cur.is_file() and not any(sha256_file(p) == cur_sha for p in files):
        files.append(cur)
    for p in files:
        rep = read_json(p) or {}
        is_cur = sha256_file(p) == cur_sha
        body = rep.get("test_evaluation") or {}
        items.append({"source": "s6.json" if p == cur else f"test_release_history/{p.name}",
                      "is_current_s6": is_cur,
                      "sha256": sha256_file(p), "test_release_id": rep.get("test_release_id"),
                      "release_number": rep.get("release_number"), "finished_at": rep.get("finished_at"),
                      "action": rep.get("action"), "reason": rep.get("reason"),
                      "justification": rep.get("justification"),
                      "candidate": {k: g(rep, "candidate", "chosen", k) for k in ("encoder", "head", "run_id")},
                      "candidate_rule": g(rep, "candidate", "rule"),
                      "prior_releases_on_manifest": rep.get("prior_releases_on_manifest"),
                      "prior_releases_on_test_patients": rep.get("prior_releases_on_test_patients"),
                      "metrics": {k: metric(v) for k, v in (rep.get("test_metrics") or {}).items()},
                      "counts": rep.get("counts"),
                      "unscorable": {k: v for k, v in (rep.get("unscorable") or {}).items() if k != "unscored"},
                      "evaluation_prevalence": rep.get("evaluation_prevalence"),
                      "reference_standard": rep.get("reference_standard") or body.get("reference_standard"),
                      "status_reasons": r.status("s6")["reasons"] if is_cur else []})
    # labelled by test_release_id with the driver's own rule: an earlier copy of the SAME release (a forced, audited
    # re-read) is never "superseded by a later release"
    r.drv.release_history_labels(items, cur_sha, r.status("s6")["status"] if cur.is_file() else None)
    return {"releases": items, "count": len(items),
            "note": ("no test release recorded: the test split was never read by the driver" if not items else
                     "every recorded test look is listed; an obsolete release's candidate no longer matches the "
                     "current development stage, and its test patients count as already looked at")}


def build_artifacts_index(r: Reports) -> dict:
    local = []
    for p in sorted(r.dir.rglob("*")):
        if p.is_file() and p.name != "evidence_salt" and not p.name.startswith("."):
            local.append({"path": str(p.relative_to(r.dir)), "bytes": p.stat().st_size, "sha256": sha256_file(p)})
    pinned = []
    s1 = r.reports.get("s1") if isinstance(r.reports.get("s1"), dict) else {}
    if s1:
        pinned.append({"kind": "dataset_manifest", "sha256": g(s1, "dataset", "manifest_sha256"),
                       "id": g(s1, "dataset", "dataset_version_id")})
    for x in build_identities(r)["runs"]:
        if x.get("checkpoint_sha256"):
            pinned.append({"kind": "checkpoint", "sha256": x["checkpoint_sha256"], "run_id": x["run_id"]})
    for name, fs in build_identities(r)["feature_sets"].items():
        if fs:
            pinned.append({"kind": "feature_set_spec", "sha256": fs.get("spec_sha256"),
                           "feature_set_id": fs.get("feature_set_id"), "label": name,
                           "weights_sha256": fs.get("weights_sha256"),
                           "stain_reference_sha256": fs.get("stain_reference_sha256")})
    return {"local_reports": local, "pinned_artifacts": pinned,
            "note": "hashes only: reports (which contain patient codes), databases, slides, weights and "
                    "embeddings stay local and out of Git"}


def build_exclusions(r: Reports) -> dict:
    stages = {s: r.status(s) for s in r.drv.STAGES}
    snapshot = read_json(r.state / "status.json") or {}
    superseded = []
    idx = r.dir / "_superseded" / "INDEX.jsonl"
    if idx.is_file():
        for line in idx.read_text().splitlines():
            try:
                e = json.loads(line)
            except ValueError:
                continue
            superseded.append({k: e.get(k) for k in ("at", "stage", "kind", "from", "to", "sha256", "reason")})
    failed_runs = []
    for s in ("s3",):
        for x in g(r.reports.get(s) if isinstance(r.reports.get(s), dict) else {}, "runs") or []:
            if isinstance(x, dict) and x.get("status") != "succeeded":
                failed_runs.append({"stage": s, "run_id": x.get("run_id"), "encoder": x.get("encoder"),
                                    "head": x.get("head"), "seed": x.get("seed"), "status": x.get("status"),
                                    "error": str(x.get("error"))[:300]})
    arms = []
    s4 = r.reports.get("s4") if isinstance(r.reports.get("s4"), dict) else {}
    for arm, by in (g(s4, "arms") or {}).items():
        for e, v in (by or {}).items():
            v = v or {}
            st = v.get("status")
            if not arm_is_evidence(v):
                legacy = st == "succeeded"
                arms.append({"arm": arm, "encoder": e, "status": "invalid_for_cv_comparison" if legacy else st,
                             "reason": v.get("reason") or v.get("error") or (LEGACY_MACENKO if legacy else None),
                             "stage_status": r.status("s4")["status"]})
    return {"stages": {s: {k: v.get(k) for k in ("status", "reasons", "finished_at", "dry_run",
                                                  "recorded_code_revision")} for s, v in stages.items()},
            "excluded_from_results": {s: v["reasons"] for s, v in stages.items()
                                      if v["status"] not in ("valid", "missing")},
            "driver_status_snapshot": {"at": snapshot.get("at"),
                                       "stages": {s: {"status": v.get("status"),
                                                      "reasons": (v.get("reasons") or [])[:5]}
                                                  for s, v in (snapshot.get("stages") or {}).items()}}
            if snapshot else None,
            "database_artifacts": "not checked offline (no database is opened); a stage whose same report bytes "
                                  "the driver_status_snapshot holds invalid or failed is excluded",
            "superseded_outputs": superseded, "failed_runs": failed_runs, "arms_not_evidence": arms,
            "skipped_work": {s: rep.get("skipped_work") for s, rep in r.reports.items()
                             if isinstance(rep, dict) and rep.get("skipped_work")}}


def build_blockers(r: Reports) -> dict:
    out = []
    s8 = r.reports.get("s8") if isinstance(r.reports.get("s8"), dict) else {}
    out.extend(s8.get("blockers") or [])
    s0 = r.reports.get("s0") if isinstance(r.reports.get("s0"), dict) else {}
    if not s8:
        for e, ident in (g(s0, "encoders", "benchmark_encoders") or {}).items():
            if (ident or {}).get("status") != "available":
                out.append({"what": f"encoder {e}", "status": (ident or {}).get("status"),
                            "detail": (ident or {}).get("status_detail")})
    for s in r.drv.STAGES:
        st = r.status(s)
        if st["status"] in ("missing", "failed") and s != "s6":
            out.append({"what": f"stage {s}", "status": st["status"], "detail": (st["reasons"] or [None])[0]})
    for p in sorted(r.state.glob("*.refusals.jsonl")) if r.state.is_dir() else []:
        for line in p.read_text().splitlines()[-5:]:
            try:
                e = json.loads(line)
            except ValueError:
                continue
            out.append({"what": f"refused request ({p.name.split('.')[0]})", "status": "refused",
                        "detail": e.get("message"), "at": e.get("at")})
    return {"blockers": out, "note": "missing data, weights or hardware are blockers, never a reason to invent results"}


def readme(experiment_id: str, results: dict, exclusions: dict, releases: dict) -> str:
    inc = ", ".join(results.get("included_stages") or []) or "none"
    exc = ", ".join(f"{s} ({v})" for s, v in ((k, x["status"]) for k, x in exclusions["stages"].items())
                    if v not in ("valid",)) or "none"
    return "\n".join([
        f"# Evidence package `{experiment_id}`",
        "",
        "Research use only. Not a medical device; nothing here is a diagnosis or a clinical performance claim.",
        "Labels are imported reference labels (report-derived); metrics measure agreement with that reference.",
        "BCC absent is not benign.",
        "",
        f"* Stages contributing numbers (valid offline): {inc}",
        f"* Stages excluded or not present: {exc}",
        f"* Test releases recorded: {releases.get('count', 0)}",
        "",
        "Files: `index.json` (hashes of every file), `provenance.json`, `dataset.json`, `identities.json`,",
        "`results.json`, `artifacts_index.json`, `exclusions.json`, `test_releases.json`, `blockers.json`.",
        "",
        "Identifiers are salted HMAC tokens (`pt:`, `file:`, `id:`, `path:`); the salt is not in the package.",
        "No database, slide, weight, embedding, patient code or slide file name is included.",
        "",
    ])


# =================================================================================================== main


def write_package(out_dir: Path, files: dict[str, object], sanitizer: Sanitizer, meta: dict) -> dict:
    out_dir.mkdir(parents=True, exist_ok=False)
    entries = []
    for name, content in files.items():
        data = content if isinstance(content, str) else json.dumps(sanitizer.scrub(content), indent=2,
                                                                     sort_keys=True, default=str) + "\n"
        if isinstance(content, str):
            data = sanitizer.scrub_str(data)
        p = out_dir / name
        p.write_text(data, encoding="utf-8")
        entries.append({"path": name, "bytes": p.stat().st_size, "sha256": sha256_file(p)})
    index = {**meta, "files": entries}
    (out_dir / "index.json").write_text(json.dumps(sanitizer.scrub(index), indent=2, sort_keys=True) + "\n",
                                        encoding="utf-8")
    return index


def verify_clean(out_dir: Path, sanitizer: Sanitizer) -> list[str]:
    problems = []
    for p in sorted(out_dir.rglob("*")):
        if not p.is_file():
            continue
        rel = p.relative_to(out_dir)
        if p.suffix.lower() in FORBIDDEN_SUFFIXES:
            problems.append(f"{rel}: forbidden file type")
        if p.stat().st_size > MAX_FILE_BYTES:
            problems.append(f"{rel}: larger than {MAX_FILE_BYTES} bytes (bulky artifacts are indexed, not copied)")
        try:
            text = p.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            problems.append(f"{rel}: not UTF-8 text")
            continue
        problems.extend(f"{rel}: {w}" for w in sanitizer.leaks(text))
    return problems


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="export_evidence.py", description=__doc__.split("\n\n")[0],
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--experiment-id", required=True, help="package name: letters, digits, '.', '_' or '-'")
    p.add_argument("--reports-dir", help="driver reports (default workbench/experiments/reports)")
    p.add_argument("--out-root", help="where <experiment-id>/ is written (default workbench/experiments/evidence)")
    p.add_argument("--salt-file", help="local secret salt for identifier tokens (default "
                                       "<reports-dir>/_state/evidence_salt; created when absent; never exported)")
    p.add_argument("--include-dry-run", action="store_true", help="let dry-run reports contribute (flagged)")
    p.add_argument("--force", action="store_true", help="replace an existing package of the same id")
    return p


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    args = build_parser().parse_args(argv)
    if not ID_RE.match(args.experiment_id):
        print("error: --experiment-id must be letters, digits, '.', '_' or '-' (at most 81 characters)",
              file=sys.stderr)
        return 2
    reports_dir = Path(args.reports_dir).resolve() if args.reports_dir else DEFAULT_REPORTS_DIR
    out_root = Path(args.out_root).resolve() if args.out_root else DEFAULT_OUT_ROOT
    if not reports_dir.is_dir():
        print(f"error: no reports directory {reports_dir}", file=sys.stderr)
        return 2
    final = out_root / args.experiment_id
    if final.exists() and not args.force:
        print(f"error: {final} exists; pass --force to replace it", file=sys.stderr)
        return 1
    drv = load_driver()
    salt = load_salt(Path(args.salt_file).resolve() if args.salt_file else reports_dir / "_state" / "evidence_salt")
    r = Reports(drv, reports_dir, args.include_dry_run, current_engine_identity())
    known: set[str] = set()
    for rep in list(r.reports.values()) + [read_json(p) for p in (reports_dir / "test_release_history").glob("*.json")
                                           if (reports_dir / "test_release_history").is_dir()]:
        collect_identifiers(rep, known)
    sanitizer = Sanitizer(salt, known)
    git = git_state()
    engine = current_engine_identity()
    results = build_results(r)
    exclusions = build_exclusions(r)
    releases = build_test_releases(r)
    files = {
        "provenance.json": build_provenance(r, git, engine, argv),
        "dataset.json": build_dataset(r),
        "identities.json": build_identities(r),
        "results.json": results,
        "artifacts_index.json": build_artifacts_index(r),
        "exclusions.json": exclusions,
        "test_releases.json": releases,
        "blockers.json": build_blockers(r),
        "README.md": readme(args.experiment_id, results, exclusions, releases),
    }
    meta = {"schema": EVIDENCE_SCHEMA, "experiment_id": args.experiment_id,
            "created_at": _dt.datetime.now(_dt.timezone.utc).isoformat(timespec="seconds"),
            "research_use_only": True, "notice": NOTICE,
            "code": {"git_head": git.get("git_head"), "dirty": git.get("dirty"),
                     "tracked_diff_sha256": git.get("tracked_diff_sha256"),
                     "engine_code_tree_sha256": engine.get("engine_code_tree_sha256")},
            "generator": {"file": "workbench/scripts/export_evidence.py", "sha256": sha256_file(SCRIPT)},
            "sanitization": {"salt_id": sanitizer.salt_id,
                             "rules": ["allowlisted fields only (no per-slide or per-patient tables)",
                                       "patient / accession codes -> pt:<hmac>", "slide file names -> file:<hmac>",
                                       "slide, bag and case ids -> id:<hmac>", "local absolute paths -> "
                                       "<workbench>, <repo>, <home> or path:<hmac>",
                                       "every file re-scanned after writing; any leak aborts the export"],
                             "excluded": ["databases", "slides", "model weights", "embeddings", "feature arrays",
                                          "raw reports"]}}
    out_root.mkdir(parents=True, exist_ok=True)
    tmp = out_root / f".tmp-{args.experiment_id}-{os.getpid()}"
    if tmp.exists():
        shutil.rmtree(tmp)
    try:
        write_package(tmp, files, sanitizer, meta)
        problems = verify_clean(tmp, sanitizer)
        if problems:
            raise LeakDetected("; ".join(problems[:20]))
    except LeakDetected as exc:
        shutil.rmtree(tmp, ignore_errors=True)
        print(f"error: export aborted, the package would leak: {exc}", file=sys.stderr)
        return 1
    except BaseException:
        shutil.rmtree(tmp, ignore_errors=True)
        raise
    if final.exists():
        shutil.rmtree(final)
    os.replace(tmp, final)
    print(f"evidence package written: {final} ({len(files) + 1} files; stages contributing numbers: "
          f"{', '.join(results['included_stages']) or 'none'})", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
