"""Evidence exporter (``scripts/export_evidence.py``): sanitized, allowlisted, hash-indexed packages built from the
COBRA driver's local reports. RESEARCH USE ONLY.

The reports are produced by the real driver orchestration (fingerprints, integrity records, history) with fake
stage bodies that deliberately carry patient codes, accession codes, slide file names, slide ids and local absolute
paths, the way real reports do. Everything is written under ``tmp_path``; no database other than the per-test
``env`` copy is opened, and nothing is written to ``workbench/experiments``.
"""

from __future__ import annotations

import hashlib
import importlib.util
import json
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

SCRIPTS = Path(__file__).resolve().parents[2] / "scripts"

PATIENTS = ["COBRA-P858284", "COBRA-P774819", "COBRA-P123456"]
ACCESSION = "COBRA-P858284-S2"
FILES = ["RUMC-B19-8899_HE.tif", "RUMC-B20-0042_HE.tif"]
SLIDE_IDS = ["0995f597c1d24a6e9b1f0000000000aa", "10604dc7c1d24a6e9b1f0000000000bb"]
BARE_PATIENT_ID = "P774819"
HOME_PATH = str(Path.home() / "Desktop" / "private-folder" / "var")


def _load(name: str, file: str):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / file)
    m = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = m
    spec.loader.exec_module(m)
    return m


@pytest.fixture(scope="module")
def drv():
    m = _load("run_cobra_experiments_for_evidence_test", "run_cobra_experiments.py")
    yield m
    sys.modules.pop("run_cobra_experiments_for_evidence_test", None)


@pytest.fixture(scope="module")
def exp():
    m = _load("export_evidence_under_test", "export_evidence.py")
    yield m
    sys.modules.pop("export_evidence_under_test", None)


def _metric(v, lo, hi):
    return {"value": v, "ci": [lo, hi], "ci_reason": None}


def bodies(m) -> dict:
    """Stage bodies shaped like the driver's real reports, with identifiers in the places real reports have them."""
    run = lambda e, h, s, st="succeeded": {  # noqa: E731
        "run_id": f"run-{e[:4]}-{h[:4]}-{s}", "encoder": e, "head": h, "seed": s, "role": "grid", "fraction": 1.0,
        "repeat": 0, "status": st, "error": None if st == "succeeded" else f"failed on {FILES[0]}",
        "identity_sha256": "i" * 64, "checkpoint": {"sha256": "c" * 64}, "feature_set_id": f"fs-{e[:4]}",
        "fold_assignment_sha256": "f" * 64, "threshold": {"value": 0.42},
        "oof": {"n_items": 45, "n_patients": 35, "positives": 22, "negatives": 23, "n_unscorable": 1,
                "tuning_set": True, "threshold_free": {"auroc": _metric(0.77, 0.60, 0.90)},
                "at_operating_point": {"sensitivity": _metric(0.8, 0.6, 0.95)}},
        "unscorable_oof": {"bags": 1, "patients": 1}}
    comp = {"fixed": {"encoder": m.HANDCRAFTED}, "seed": 0, "models": ["abmil", "meanpool_logreg"], "status": "ok",
            "excluded_bags_unscorable_under_some_model": [SLIDE_IDS[0]],
            "unscorable_bags_by_model": {"abmil": [SLIDE_IDS[0]], "meanpool_logreg": []},
            "subject_accounting": {"paired_evaluable": {"bags": 44, "patients": 34}},
            "deltas": [{"a": "abmil", "b": "meanpool_logreg", "auroc": _metric(0.07, -0.04, 0.22),
                        "mcnemar_p": 0.38}]}
    return {
        "s0": {"machine": {"cpu_count": 11, "platform": "macOS"},
               "devices": {"available": ["cpu"], "cuda": False},
               "environment": {"WB_VAR_DIR": HOME_PATH},
               "encoders": {"benchmark_encoders": {
                   m.HANDCRAFTED: {"status": "available", "spec_sha256": "s" * 64, "weights_sha256": "handcrafted:1"},
                   m.MIDNIGHT: {"status": "missing_weights", "status_detail": f"no weights in {HOME_PATH}/models"}}}},
        "s1": {"dataset": {"dataset_version_id": "dv-1", "manifest_sha256": "m" * 64, "split_fingerprint": "p" * 64,
                           "counts": {"patients": 50, "slides": 60}, "reference_standard": "imported_reference"},
               "split_table": {"train": {"slides": {"bcc_present": 22, "bcc_absent_not_benign": 23}},
                               "test": {"slides": {"bcc_present": 8, "bcc_absent_not_benign": 7}}},
               "audit_now": {"mixed_label_patients": {"patient_codes": PATIENTS[:2]}},
               "exclusions": [{"slide_id": SLIDE_IDS[1], "original_filename": FILES[1], "patient_code": PATIENTS[2],
                               "patient_id": BARE_PATIENT_ID, "accession_code": ACCESSION}],
               "labels_note": "task labels are bcc_present / bcc_absent_not_benign; BCC absent is never 'benign'"},
        "s2": {"encoders": {m.HANDCRAFTED: {
            "created": {"feature_set_id": "fs-tech", "spec_sha256": "t" * 64, "policy_sha256": "q" * 64},
            "technical_validation": {"passed": True},
            "feature_set": {"feature_set": {"feature_set_id": "fs-tech", "spec_sha256": "t" * 64},
                            "aggregate": {"patches_total": 15360},
                            "per_slide": [{"slide_id": SLIDE_IDS[0], "source_file": FILES[0]}]}}}},
        "s3": {"runs": [run(m.HANDCRAFTED, h, s) for h in m.HEADS for s in (0, 1, 2)]
               + [run(m.MIDNIGHT, "abmil", 0, "failed")],
               "feature_sets": {m.HANDCRAFTED: {"supervised_feature_set_id": "fs-sup"}},
               "comparisons": {"encoder_effects": [], "head_effects": [comp], "four_way": comp, "primary_seed": 0,
                               "by_seed": {"0": {"head_effects": [comp], "encoder_effects": [], "four_way": comp}}},
               "seed_summary": {"seeds": [0, 1, 2], "note": m.SEED_NOTE},
               "protocol": {"evaluation_protocol": "dev_cv", "cv_folds": 5,
                            "fold_of_patient_code": {PATIENTS[0]: 0, PATIENTS[1]: 1}},
               "pre_declared_test_candidate": {"rule": m.CANDIDATE_RULE, "declared_at": "2026-10-28",
                                               "chosen": {"run_id": "run-cand", "encoder": m.HANDCRAFTED,
                                                          "head": "meanpool_logreg"}}},
        "s4": {"arms": {"b_stain_macenko": {
                   m.HANDCRAFTED: {"status": "succeeded", "overrides": {"stain_normalization": "macenko-v1"},
                                   "comparison": comp},  # recorded before the fold-safety rule
                   m.MIDNIGHT: {"status": "blocked", "code": "fold_unsafe_preprocessing",
                                "overrides": {"stain_normalization": "macenko-v1"},
                                "reason": "dev_cv shares one dataset-fitted reference", "counts_as_evidence": False}},
                        "a_sampling_uniform": {m.HANDCRAFTED: {"status": "succeeded", "counts_as_evidence": True,
                                                               "overrides": {"sampling_strategy": "uniform"},
                                                               "comparison": comp}}},
               "coverage_side_by_side": {m.HANDCRAFTED: {"per_slide": {SLIDE_IDS[0]: {"spatial": {}}}}}},
        "s4b": {"budgets": {"current": 256, "higher": 512}, "development_only": True,
                "encoders": {m.HANDCRAFTED: {"status": "succeeded",
                                             "coverage": {"slides": 45, "delta": {"x": {"mean": 0.1}}},
                                             "prediction_changes": {"paired_bags": 44, "decision_flips": 3},
                                             "comparison": comp}}},
        "s5": {"extraction": [{"source": "s2 technical", "encoder": m.HANDCRAFTED, "peak_rss_bytes_max": 10 ** 9}]},
        "s6": {"candidate": {"chosen": {"run_id": "run-cand", "encoder": m.HANDCRAFTED, "head": "meanpool_logreg"}},
               "test_release_id": "rel-1", "release_number": 1, "reason": "pre-declared",
               "test_metrics": {"auroc": _metric(0.7, 0.4, 0.95)},
               "test_evaluation": {"failure_analysis": {"errors": [
                   {"bag_id": SLIDE_IDS[0], "patient_code": PATIENTS[0],
                    "description": f"{PATIENTS[0]} slide {FILES[0]} missed"}]}}},
        "s7": {"oof_runs": [{"encoder": m.HANDCRAFTED, "head": "abmil", "errors": [
            {"bag_id": SLIDE_IDS[1], "patient_code": PATIENTS[1], "label": 1}]}],
            "dominant_categories": {"grid_runs_oof": [{"category": "near_threshold", "count": 4}]}},
        "s8": {"caveats": ["Labels are imported reference labels.", "BCC absent is not benign."],
               "blockers": [{"what": f"encoder {m.MIDNIGHT}", "status": "missing_weights"}]},
    }


def make_reports(drv, env, tmp_path, *, release=True) -> Path:
    settings, _ = env
    reports = tmp_path / "reports"
    b = bodies(drv)

    def driver(*argv):
        args = drv.build_parser().parse_args(["--var-dir", str(settings.var_dir), "--reports-dir", str(reports),
                                              *argv])
        d = drv.Driver(args)
        d.reports_dir.mkdir(parents=True, exist_ok=True)
        d.state_dir.mkdir(parents=True, exist_ok=True)
        d.actor = SimpleNamespace(id="user-research-lead", role="research_lead")
        d.midnight_device = "cpu"
        d.lead = lambda: d.actor
        d.encoder_identity = lambda e: {"status": "available", "spec_sha256": f"spec-{e}", "weights_sha256": "w"}
        d.artifact_problems = lambda stage, rep: []
        for s in drv.STAGES:
            setattr(d, s, (lambda _s: (lambda *a, **k: json.loads(json.dumps(b[_s]))))(s))
        return d

    assert driver().run() == 0
    if release:
        assert driver("--only", "s6", "--release-test", "run-cand", "--release-reason", "pre-declared look").run() == 0
        assert driver("--only", "s7,s8", "--force", "s7,s8").run() == 0
    return reports


def export(exp, reports: Path, tmp_path: Path, *extra) -> tuple[int, Path]:
    out_root = tmp_path / "evidence"
    rc = exp.main(["--experiment-id", "cobra-test-1", "--reports-dir", str(reports), "--out-root", str(out_root),
                   "--salt-file", str(tmp_path / "salt"), *extra])
    return rc, out_root / "cobra-test-1"


def all_text(pkg: Path) -> str:
    return "\n".join(p.read_text() for p in sorted(pkg.rglob("*")) if p.is_file())


# --------------------------------------------------------------------------- sanitizer


def test_sanitizer_tokens_are_salted_and_stable(exp):
    a = exp.Sanitizer(b"a" * 64)
    b = exp.Sanitizer(b"b" * 64)
    s = f"patient {PATIENTS[0]} ({ACCESSION}) slide {FILES[0]} at {HOME_PATH}/x"
    out = a.scrub_str(s)
    assert "COBRA-P" not in out and ".tif" not in out and str(Path.home()) not in out
    assert a.scrub_str(s) == out  # stable for one salt
    assert b.scrub_str(s) != out  # salted
    assert a.token("pt", PATIENTS[0]) != hashlib.sha256(PATIENTS[0].encode()).hexdigest()[:12]


def test_sanitizer_hashes_identifier_keys_and_known_literals(exp):
    known = set()
    exp.collect_identifiers({"exclusions": [{"patient_id": BARE_PATIENT_ID, "slide_id": SLIDE_IDS[0]}]}, known)
    s = exp.Sanitizer(b"k" * 64, known)
    out = s.scrub({"patient_id": BARE_PATIENT_ID, "note": f"slide {SLIDE_IDS[0]} of {BARE_PATIENT_ID}",
                   "head": "meanpool_logreg", "fold_of_patient_code": {PATIENTS[0]: 1}})
    text = json.dumps(out)
    assert BARE_PATIENT_ID not in text and SLIDE_IDS[0] not in text and "COBRA-P" not in text
    assert out["head"] == "meanpool_logreg"  # ordinary values are untouched
    assert s.leaks(f"x {BARE_PATIENT_ID} y") and s.leaks(PATIENTS[1]) and s.leaks(FILES[0])
    assert not s.leaks(text)


# --------------------------------------------------------------------------- package


def test_export_builds_a_sanitized_indexed_package(drv, exp, env, tmp_path):
    reports = make_reports(drv, env, tmp_path)
    raw = "\n".join(p.read_text() for p in reports.rglob("*.json"))
    assert PATIENTS[0] in raw and FILES[0] in raw  # the local reports DO carry identifiers
    rc, pkg = export(exp, reports, tmp_path)
    assert rc == 0 and pkg.is_dir()
    text = all_text(pkg)
    for needle in (*PATIENTS, ACCESSION, *FILES, *SLIDE_IDS, BARE_PATIENT_ID, "COBRA-P", ".tif",
                   str(Path.home()), "RUMC-B19"):
        assert needle not in text, needle
    names = {p.name for p in pkg.iterdir()}
    assert {"index.json", "provenance.json", "dataset.json", "identities.json", "results.json",
            "artifacts_index.json", "exclusions.json", "test_releases.json", "blockers.json", "README.md"} <= names
    for p in pkg.iterdir():
        assert p.suffix in (".json", ".md")  # no database, slide, weights or embeddings
        assert p.stat().st_size < 2 * 1024 * 1024
    index = json.loads((pkg / "index.json").read_text())
    for f in index["files"]:
        assert hashlib.sha256((pkg / f["path"]).read_bytes()).hexdigest() == f["sha256"]
    assert index["research_use_only"] is True and index["sanitization"]["salt_id"]
    assert (tmp_path / "salt").read_bytes() not in (pkg / "index.json").read_bytes()
    # results: only valid stages, with uncertainty; macenko recorded before the rule is not evidence
    res = json.loads((pkg / "results.json").read_text())
    assert "s3" in res["included_stages"]
    auroc = res["development_comparison"]["runs_oof"][0]["threshold_free"]["auroc"]
    assert auroc["value"] == pytest.approx(0.77) and auroc["ci"] == [0.6, 0.9]
    arms = res["ablations"]["arms"]["b_stain_macenko"]
    assert arms[drv.HANDCRAFTED]["counts_as_evidence"] is False and arms[drv.HANDCRAFTED]["comparison"] is None
    assert arms[drv.MIDNIGHT]["status"] == "blocked"
    assert res["ablations"]["arms"]["a_sampling_uniform"][drv.HANDCRAFTED]["comparison"]["deltas"]
    assert "BCC absent is not benign." in res["caveats"]
    exc = json.loads((pkg / "exclusions.json").read_text())
    bad = {(a["arm"], a["encoder"]): a["status"] for a in exc["arms_not_evidence"]}
    assert bad[("b_stain_macenko", drv.HANDCRAFTED)] == "invalid_for_cv_comparison"
    assert bad[("b_stain_macenko", drv.MIDNIGHT)] == "blocked"
    assert any(r["status"] == "failed" for r in exc["failed_runs"])
    assert all(isinstance(v, list) for v in exc["skipped_work"].values())
    rel = json.loads((pkg / "test_releases.json").read_text())
    assert rel["count"] == 1 and rel["releases"][0]["metrics"]["auroc"]["ci"] == [0.4, 0.95]
    ds = json.loads((pkg / "dataset.json").read_text())
    assert ds["counts"] == {"patients": 50, "slides": 60} and ds["cohort_reconciliation"]["matches"] is True
    assert ds["audit_summary"]["mixed_label_patients"] == 2
    prov = json.loads((pkg / "provenance.json").read_text())
    assert prov["code"]["repository"].get("git_head") and "dirty" in prov["code"]["repository"]
    assert any(c["file"].endswith("cobra_supervised_baseline.json") for c in prov["configs"])
    blk = json.loads((pkg / "blockers.json").read_text())
    assert any("midnight" in b["what"] for b in blk["blockers"])
    art = json.loads((pkg / "artifacts_index.json").read_text())
    assert any(a["path"] == "s3.json" and len(a["sha256"]) == 64 for a in art["local_reports"])
    assert any(a["kind"] == "checkpoint" for a in art["pinned_artifacts"])


def test_stale_invalid_and_legacy_reports_are_excluded_with_reasons(drv, exp, env, tmp_path):
    reports = make_reports(drv, env, tmp_path, release=False)
    p = reports / "s4.json"
    p.write_text(p.read_text().replace("uniform", "edited"))  # invalid: bytes changed after writing
    (reports / "s5.json").unlink()
    (reports / "s5.json").write_text(json.dumps({"stage": "s5", "extraction": []}))  # legacy: no fingerprint
    rc, pkg = export(exp, reports, tmp_path)
    assert rc == 0
    res = json.loads((pkg / "results.json").read_text())
    assert "s4" not in res["included_stages"] and "ablations" not in res
    assert "s5" not in res["included_stages"] and "resources" not in res
    exc = json.loads((pkg / "exclusions.json").read_text())
    assert exc["stages"]["s4"]["status"] == "invalid"
    assert exc["stages"]["s5"]["status"] == "stale" and "legacy" in " ".join(exc["stages"]["s5"]["reasons"])
    assert exc["stages"]["s8"]["status"] == "stale"  # its upstream reports changed under it
    assert exc["stages"]["s6"]["status"] == "missing"
    rel = json.loads((pkg / "test_releases.json").read_text())
    assert rel["count"] == 0 and "never read" in rel["note"]


def test_obsolete_release_history_is_kept_and_marked(drv, exp, env, tmp_path):
    reports = make_reports(drv, env, tmp_path)
    s3 = reports / "s3.json"  # a forced development re-run makes the release obsolete
    settings, _ = env
    args = drv.build_parser().parse_args(["--var-dir", str(settings.var_dir), "--reports-dir", str(reports),
                                          "--only", "s3", "--force", "s3"])
    d = drv.Driver(args)
    d.actor = SimpleNamespace(id="user-research-lead", role="research_lead")
    d.midnight_device, d.lead = "cpu", (lambda: d.actor)
    d.encoder_identity = lambda e: {"status": "available", "spec_sha256": f"spec-{e}", "weights_sha256": "w"}
    d.artifact_problems = lambda stage, rep: []
    body = json.loads(s3.read_text())
    d.s3 = lambda: {k: v for k, v in body.items() if k in ("runs", "comparisons", "pre_declared_test_candidate")}
    assert d.run() == 0
    rc, pkg = export(exp, reports, tmp_path)
    assert rc == 0
    rel = json.loads((pkg / "test_releases.json").read_text())
    assert rel["count"] == 1 and rel["releases"][0]["status"] == "obsolete"
    res = json.loads((pkg / "results.json").read_text())
    assert "s6" not in res["included_stages"]


def test_dry_run_reports_are_not_evidence(drv, exp, env, tmp_path):
    settings, _ = env
    reports = tmp_path / "reports"
    args = drv.build_parser().parse_args(["--var-dir", str(settings.var_dir), "--reports-dir", str(reports),
                                          "--dry-run-subset", "6", "--only", "s0"])
    d = drv.Driver(args)
    d.reports_dir.mkdir(parents=True)
    d.state_dir.mkdir(parents=True)
    d.actor = SimpleNamespace(id="user-research-lead", role="research_lead")
    d.midnight_device, d.lead = "cpu", (lambda: d.actor)
    d.encoder_identity = lambda e: {"status": "available"}
    d.artifact_problems = lambda stage, rep: []
    d.s0 = lambda: {"machine": {}}
    assert d.run() == 0
    rc, pkg = export(exp, reports, tmp_path)
    assert rc == 0
    exc = json.loads((pkg / "exclusions.json").read_text())
    assert exc["stages"]["s0"]["status"] == "stale" and "dry run" in " ".join(exc["stages"]["s0"]["reasons"])


def test_export_refuses_overwrite_bad_ids_and_aborts_on_leaks(drv, exp, env, tmp_path, monkeypatch):
    reports = make_reports(drv, env, tmp_path, release=False)
    assert export(exp, reports, tmp_path)[0] == 0
    assert export(exp, reports, tmp_path)[0] == 1  # exists, no --force
    assert export(exp, reports, tmp_path, "--force")[0] == 0
    assert exp.main(["--experiment-id", "../escape", "--reports-dir", str(reports)]) == 2
    # A leak that slips past the allowlist aborts the export and leaves nothing behind.
    monkeypatch.setattr(exp, "readme", lambda *a, **k: f"oops {PATIENTS[0]}\n")
    monkeypatch.setattr(exp.Sanitizer, "scrub_str", lambda self, s: s)
    out_root = tmp_path / "evidence2"
    rc = exp.main(["--experiment-id", "leaky", "--reports-dir", str(reports), "--out-root", str(out_root),
                   "--salt-file", str(tmp_path / "salt")])
    assert rc == 1
    assert not (out_root / "leaky").exists() and not any(out_root.glob(".tmp-*"))
