"""COBRA experiment driver: stage fingerprints, resumption, dependent-stage invalidation and test-release
discipline (owner's brief item 4, plus the driver side of items 3 and 7). RESEARCH USE ONLY.

The driver script is imported by path. No real experiment runs: every stage body is replaced by a small fake
that records the call, reports go to a temporary directory, and the seeded per-test database of the ``env``
fixture only backs the report header (settings) and the artifact-integrity checks. Nothing here touches the
shared ``workbench/var`` database or ``workbench/experiments/reports``.
"""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "run_cobra_experiments.py"


@pytest.fixture(scope="module")
def mod():
    spec = importlib.util.spec_from_file_location("run_cobra_experiments_under_test", SCRIPT)
    m = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = m
    spec.loader.exec_module(m)
    yield m
    sys.modules.pop(spec.name, None)


# --------------------------------------------------------------------------- harness


class Fakes:
    """Stage bodies that record their calls. ``s3`` declares a NEW candidate run on every execution (a re-run
    of the development stage is a new comparison); ``s2`` returns feature-set identities that can be changed."""

    def __init__(self, mod):
        self.mod = mod
        self.calls: list[str] = []
        self.n = {s: 0 for s in mod.STAGES}
        self.fs_suffix = "a"
        self.fail: set[str] = set()

    def body(self, stage: str) -> dict:
        m = self.mod
        self.n[stage] += 1
        n = self.n[stage]
        if stage == "s0":
            return {"machine": {"cpu_count": 1}}
        if stage == "s1":
            return {"dataset": {"dataset_version_id": "dv-1", "manifest_sha256": "m" * 64,
                                "split_fingerprint": "f" * 64, "counts": {"patients": 50, "slides": 60}},
                    "split_table": {}, "test_patients": 15, "development_pool_patients": 35}
        if stage == "s2":
            return {"encoders": {e: {"created": {"feature_set_id": f"fs-tech-{e}-{self.fs_suffix}",
                                                 "spec_sha256": f"spec-{e}-{self.fs_suffix}",
                                                 "policy_sha256": "p" * 64}} for e in m.ENCODERS}}
        if stage == "s3":
            return {"runs": [{"run_id": f"run-{e}-{h}-{n}", "encoder": e, "head": h, "role": "grid",
                              "status": "succeeded", "seed": 0, "fraction": 1.0, "repeat": 0}
                             for e in m.ENCODERS for h in m.HEADS],
                    "feature_sets": {e: {"supervised_feature_set_id": f"fs-sup-{e}"} for e in m.ENCODERS},
                    "comparisons": {"encoder_effects": [], "head_effects": []},
                    "pre_declared_test_candidate": {"rule": m.CANDIDATE_RULE, "declared_at": "now",
                                                    "chosen": {"run_id": f"run-cand-{n}", "encoder": m.HANDCRAFTED,
                                                               "head": "meanpool_logreg",
                                                               "identity_sha256": f"id-{n}"}}}
        if stage == "s6":
            return {"candidate": {"chosen": {"run_id": f"run-cand-{self.n['s3']}"}},
                    "test_release_id": f"rel-{n}", "release_number": n, "action": "new test release recorded"}
        return {"stage_body": stage}

    def install(self, d):
        for s in self.mod.STAGES:
            def fake(*_a, _s=s, **_k):
                self.calls.append(_s)
                if _s in self.fail:
                    raise self.mod.StageError(f"{_s} failed on purpose")
                return self.body(_s)
            setattr(d, s, fake)


IDENTITY = {}


def make_driver(mod, env, tmp_path, fakes, *argv, monkeypatch=None, artifacts=None):
    settings, _ = env
    reports = tmp_path / "reports"
    args = mod.build_parser().parse_args(["--var-dir", str(settings.var_dir), "--reports-dir", str(reports), *argv])
    d = mod.Driver(args)
    d.reports_dir.mkdir(parents=True, exist_ok=True)
    d.state_dir.mkdir(parents=True, exist_ok=True)
    d.actor = SimpleNamespace(id="user-research-lead", role="research_lead", display_name="Research lead")
    d.midnight_device = "cpu"
    d.lead = lambda: d.actor
    # Encoder identities come from the engine (weights hashing) in a real run; here they are fixed per test.
    d.encoder_identity = lambda e: dict(IDENTITY.get(e) or {"status": "available", "spec_sha256": f"spec-{e}",
                                                             "weights_sha256": f"weights-{e}"})
    d.artifact_problems = artifacts or (lambda stage, rep: [])
    fakes.install(d)
    return d


def run(mod, env, tmp_path, fakes, *argv, artifacts=None) -> tuple[int, object]:
    d = make_driver(mod, env, tmp_path, fakes, *argv, artifacts=artifacts)
    return d.run(), d


def status_of(mod, env, tmp_path, fakes, *argv, artifacts=None) -> dict:
    d = make_driver(mod, env, tmp_path, fakes, *argv, artifacts=artifacts)
    return {s: d.evaluate(s) for s in mod.STAGES}


NON_TEST = ["s0", "s1", "s2", "s3", "s4", "s4b", "s5", "s7", "s8"]


@pytest.fixture(autouse=True)
def _reset_identity():
    IDENTITY.clear()
    yield
    IDENTITY.clear()


# --------------------------------------------------------------------------- reuse and staleness


def test_unchanged_inputs_reuse_every_valid_stage(mod, env, tmp_path):
    f = Fakes(mod)
    rc, _ = run(mod, env, tmp_path, f)
    assert rc == 0
    assert f.calls == NON_TEST
    f.calls.clear()
    rc, _ = run(mod, env, tmp_path, f)
    assert rc == 0 and f.calls == []  # every stage valid: fingerprint, report sha and artifacts verified
    st = status_of(mod, env, tmp_path, f)
    assert {s: v["status"] for s, v in st.items()} == {**{s: "valid" for s in NON_TEST}, "s6": "missing"}


def test_changed_budget_marks_s3_stale_and_reruns_it(mod, env, tmp_path):
    """The reviewed defect: an s3 report with a 256-patch budget was reused for a 1024-patch request."""
    f = Fakes(mod)
    assert run(mod, env, tmp_path, f)[0] == 0
    f.calls.clear()
    st = status_of(mod, env, tmp_path, f, "--max-patches", "1024")
    assert st["s3"]["status"] == "stale"
    assert any("max_patches_per_slide" in r and "256" in r and "1024" in r for r in st["s3"]["reasons"]), \
        st["s3"]["reasons"]
    rc, _ = run(mod, env, tmp_path, f, "--max-patches", "1024")
    assert rc == 0
    assert "s2" in f.calls and "s3" in f.calls and "s4" in f.calls and "s8" in f.calls
    assert "s0" not in f.calls and "s1" not in f.calls  # their inputs did not change


def test_changed_driver_identity_marks_stages_stale(mod, env, tmp_path):
    f = Fakes(mod)
    assert run(mod, env, tmp_path, f)[0] == 0
    d = make_driver(mod, env, tmp_path, f)
    d.driver_sha256 = "0" * 64
    ev = d.evaluate("s3")
    assert ev["status"] == "stale"
    assert any("driver_sha256" in r for r in ev["reasons"])


def test_changed_baseline_config_marks_s3_stale(mod, env, tmp_path):
    f = Fakes(mod)
    assert run(mod, env, tmp_path, f)[0] == 0
    d = make_driver(mod, env, tmp_path, f)
    d.baseline_cfg = json.loads(json.dumps(d.baseline_cfg))
    d.baseline_cfg["head_params"]["abmil"]["lr"] = 0.001
    ev = d.evaluate("s3")
    assert ev["status"] == "stale"
    assert any("abmil" in r and "lr" in r for r in ev["reasons"]), ev["reasons"]
    assert d.evaluate("s2")["status"] == "valid"  # the extraction policy did not change


def test_changed_encoder_weights_mark_dependent_stages_stale(mod, env, tmp_path):
    f = Fakes(mod)
    assert run(mod, env, tmp_path, f)[0] == 0
    IDENTITY[mod.MIDNIGHT] = {"status": "available", "spec_sha256": f"spec-{mod.MIDNIGHT}",
                              "weights_sha256": "other-weights"}
    st = status_of(mod, env, tmp_path, f)
    for s in ("s0", "s2", "s3", "s4"):
        assert st[s]["status"] == "stale", (s, st[s])
    assert any("weights_sha256" in r for r in st["s2"]["reasons"])
    assert st["s1"]["status"] == "valid"


def test_forced_upstream_marks_dependents_stale_and_a_default_run_propagates(mod, env, tmp_path):
    f = Fakes(mod)
    assert run(mod, env, tmp_path, f)[0] == 0
    f.calls.clear()
    assert run(mod, env, tmp_path, f, "--only", "s3", "--force", "s3")[0] == 0
    assert f.calls == ["s3"]
    st = status_of(mod, env, tmp_path, f)
    for s in ("s4", "s4b", "s5", "s7", "s8"):
        assert st[s]["status"] == "stale", (s, st[s])
        assert any("s3" in r for r in st[s]["reasons"]), st[s]["reasons"]
    for s in ("s0", "s1", "s2", "s3"):
        assert st[s]["status"] == "valid"
    f.calls.clear()
    assert run(mod, env, tmp_path, f)[0] == 0
    assert f.calls == ["s4", "s4b", "s5", "s7", "s8"]


def test_changed_upstream_identity_marks_dependents_stale(mod, env, tmp_path):
    f = Fakes(mod)
    assert run(mod, env, tmp_path, f)[0] == 0
    f.fs_suffix = "b"  # the technical feature sets are different objects now
    assert run(mod, env, tmp_path, f, "--only", "s2", "--force", "s2")[0] == 0
    st = status_of(mod, env, tmp_path, f)
    assert st["s3"]["status"] == "stale"
    assert any("s2" in r for r in st["s3"]["reasons"])


def test_upstream_that_is_not_valid_blocks_a_dependent_stage(mod, env, tmp_path):
    f = Fakes(mod)
    assert run(mod, env, tmp_path, f)[0] == 0
    f.calls.clear()
    rc, _ = run(mod, env, tmp_path, f, "--only", "s4", "--max-patches", "1024")
    assert rc == 1 and f.calls == []  # s3 is stale for this request and is not selected: s4 must not run on it


# --------------------------------------------------------------------------- integrity


def test_corrupt_report_is_not_valid_and_reruns(mod, env, tmp_path):
    f = Fakes(mod)
    assert run(mod, env, tmp_path, f)[0] == 0
    p = tmp_path / "reports" / "s3.json"
    data = json.loads(p.read_text())
    data["runs"][0]["status"] = "failed"
    p.write_text(json.dumps(data))
    st = status_of(mod, env, tmp_path, f)
    assert st["s3"]["status"] == "invalid"
    assert any("sha256" in r for r in st["s3"]["reasons"])
    f.calls.clear()
    assert run(mod, env, tmp_path, f)[0] == 0
    assert "s3" in f.calls


def test_unreadable_report_is_not_valid(mod, env, tmp_path):
    f = Fakes(mod)
    assert run(mod, env, tmp_path, f)[0] == 0
    (tmp_path / "reports" / "s2.json").write_text("{not json")
    st = status_of(mod, env, tmp_path, f)
    assert st["s2"]["status"] == "invalid"
    assert st["s3"]["status"] == "stale"


def test_legacy_report_without_fingerprint_is_stale(mod, env, tmp_path):
    """Reports written before fingerprints existed (the local s0-s3) are never trusted on existence alone."""
    f = Fakes(mod)
    reports = tmp_path / "reports"
    reports.mkdir()
    (reports / "s3.json").write_text(json.dumps({"schema": mod.REPORT_SCHEMA, "stage": "s3",
                                                 "budgets": {"max_patches_per_slide": 256}, "runs": []}))
    d = make_driver(mod, env, tmp_path, f, "--max-patches", "1024")
    ev = d.evaluate("s3")
    assert ev["status"] in ("stale", "invalid")
    assert any("fingerprint" in r for r in ev["reasons"])
    f.calls.clear()
    rc = make_driver(mod, env, tmp_path, f, "--max-patches", "1024").run()
    assert rc == 0 and "s3" in f.calls


def test_missing_artifacts_make_a_stage_not_valid(mod, env, tmp_path):
    f = Fakes(mod)
    assert run(mod, env, tmp_path, f)[0] == 0

    def broken(stage, rep):  # the first generation of technical sets is no longer ready in the database
        if stage != "s2":
            return []
        ids = [v["created"]["feature_set_id"] for v in (rep.get("encoders") or {}).values()]
        return [f"feature set {i} is failed, not ready" for i in ids if i.endswith("-a")]

    st = status_of(mod, env, tmp_path, f, artifacts=broken)
    assert st["s2"]["status"] == "invalid"
    assert "not ready" in " ".join(st["s2"]["reasons"])
    assert st["s3"]["status"] == "stale"
    f.calls.clear()
    f.fs_suffix = "b"  # the re-run builds (or re-uses) ready sets
    assert run(mod, env, tmp_path, f, artifacts=broken)[0] == 0
    assert f.calls[:2] == ["s2", "s3"]
    assert status_of(mod, env, tmp_path, f, artifacts=broken)["s2"]["status"] == "valid"


def test_artifact_checks_read_the_database(mod, env, tmp_path):
    """The real checks: a dataset version or run that is not in the database is a problem; a frozen dataset
    version whose manifest sha matches is not."""
    from sqlalchemy import select

    from dermpath.db import session_scope
    from dermpath.models import DatasetVersion

    f = Fakes(mod)
    settings, _ = env
    args = mod.build_parser().parse_args(["--var-dir", str(settings.var_dir), "--reports-dir",
                                          str(tmp_path / "reports")])
    d = mod.Driver(args)
    assert d.artifact_problems("s1", {"dataset": {"dataset_version_id": "nope", "manifest_sha256": "x"}})
    assert d.artifact_problems("s3", {"runs": [{"run_id": "nope", "status": "succeeded", "role": "grid"}],
                                      "feature_sets": {}})
    assert d.artifact_problems("s2", {"encoders": {"x": {"created": {"feature_set_id": "nope"}}}})
    assert d.artifact_problems("s6", {"test_release_id": "nope"})
    assert d.artifact_problems("s3", {"runs": "garbage"})  # malformed reports are problems, not crashes
    with session_scope() as db:
        dv = db.scalars(select(DatasetVersion).where(DatasetVersion.status == "frozen")).first()
        frozen = (dv.id, dv.manifest_sha256) if dv is not None else None
    if frozen:
        assert d.artifact_problems("s1", {"dataset": {"dataset_version_id": frozen[0],
                                                      "manifest_sha256": frozen[1]}}) == []
        assert d.artifact_problems("s1", {"dataset": {"dataset_version_id": frozen[0],
                                                      "manifest_sha256": "0" * 64}})
    del f


def test_status_distinguishes_valid_missing_failed_stale(mod, env, tmp_path):
    f = Fakes(mod)
    f.fail = {"s4"}
    rc, _ = run(mod, env, tmp_path, f)
    assert rc == 1
    st = status_of(mod, env, tmp_path, f)
    assert st["s3"]["status"] == "valid"
    assert st["s4"]["status"] == "failed" and "failed on purpose" in " ".join(st["s4"]["reasons"])
    assert st["s5"]["status"] == "missing"
    f.fail = set()
    f.calls.clear()
    assert run(mod, env, tmp_path, f)[0] == 0
    assert f.calls[0] == "s4"  # a failed stage is retried, never skipped
    assert run(mod, env, tmp_path, f, "--max-patches", "512", "--only", "s0")[0] == 0
    st = status_of(mod, env, tmp_path, f, "--max-patches", "512")
    assert st["s3"]["status"] == "stale" and st["s0"]["status"] == "valid"
    printed = make_driver(mod, env, tmp_path, f, "--max-patches", "512").status_rows()
    assert {r["stage"]: r["status"] for r in printed}["s3"] == "stale"


def test_stale_outputs_are_preserved_with_a_reason(mod, env, tmp_path):
    f = Fakes(mod)
    assert run(mod, env, tmp_path, f)[0] == 0
    before = (tmp_path / "reports" / "s3.json").read_bytes()
    assert run(mod, env, tmp_path, f, "--max-patches", "1024")[0] == 0
    sup = tmp_path / "reports" / "_superseded"
    archived = [p for p in sup.glob("s3.*.json")]
    assert len(archived) == 1 and archived[0].read_bytes() == before
    index = [json.loads(line) for line in (sup / "INDEX.jsonl").read_text().splitlines()]
    entry = [e for e in index if e["stage"] == "s3" and e["kind"] == "report"][0]
    assert "max_patches_per_slide" in entry["reason"]
    state = [e for e in index if e["stage"] == "s3" and e["kind"] == "state"][0]
    assert "other inputs" in state["reason"]  # resumable runs of the old inputs are never resumed


# --------------------------------------------------------------------------- dry run isolation


def test_dry_run_refuses_the_shared_var_and_reports_dirs(mod, tmp_path, monkeypatch):
    for k in ("WB_VAR_DIR", "WB_MIDNIGHT_WEIGHTS", "HF_HUB_OFFLINE", "TRANSFORMERS_OFFLINE"):
        monkeypatch.setenv(k, "unused")
    args = mod.build_parser().parse_args(["--var-dir", str(mod.DEFAULT_VAR_DIR), "--dry-run-subset", "4",
                                          "--reports-dir", str(tmp_path / "r")])
    with pytest.raises(SystemExit, match="shared"):
        mod.Driver(args).setup()
    args = mod.build_parser().parse_args(["--var-dir", str(tmp_path / "var"), "--dry-run-subset", "4",
                                          "--reports-dir", str(mod.DEFAULT_REPORTS_DIR)])
    with pytest.raises(SystemExit, match="experiments/reports"):
        mod.Driver(args).setup()


def test_dry_run_reports_are_never_reused_by_a_real_run(mod, env, tmp_path):
    f = Fakes(mod)
    assert run(mod, env, tmp_path, f, "--dry-run-subset", "6")[0] == 0
    f.calls.clear()
    st = status_of(mod, env, tmp_path, f)
    assert all(st[s]["status"] == "stale" for s in NON_TEST)
    assert any("dry_run" in r for r in st["s1"]["reasons"])
    assert run(mod, env, tmp_path, f)[0] == 0
    assert f.calls == NON_TEST


# --------------------------------------------------------------------------- test-release discipline


def test_s6_never_runs_automatically(mod, env, tmp_path):
    f = Fakes(mod)
    assert run(mod, env, tmp_path, f)[0] == 0
    assert "s6" not in f.calls
    assert not (tmp_path / "reports" / "s6.json").exists()
    rc, _ = run(mod, env, tmp_path, f, "--only", "s6")
    assert "s6" not in f.calls  # selecting the stage is not enough: --release-test is the explicit opt-in


def test_main_refuses_s6_without_explicit_release_request(mod, tmp_path, monkeypatch):
    for k in ("WB_VAR_DIR", "WB_MIDNIGHT_WEIGHTS", "HF_HUB_OFFLINE", "TRANSFORMERS_OFFLINE"):
        monkeypatch.setenv(k, "unused")
    base = ["--var-dir", str(tmp_path / "var"), "--reports-dir", str(tmp_path / "r")]
    assert mod.main([*base, "--only", "s6"]) == 2
    assert mod.main([*base, "--force", "s6", "--justification", "x"]) == 2
    assert mod.main([*base, "--release-test", "run-x"]) == 2  # no --release-reason
    assert not (tmp_path / "var").exists()  # refused before any database is opened


def test_release_needs_the_predeclared_candidate_and_a_reason(mod, env, tmp_path):
    f = Fakes(mod)
    assert run(mod, env, tmp_path, f)[0] == 0
    f.calls.clear()
    rc, _ = run(mod, env, tmp_path, f, "--only", "s6", "--release-test", "run-other", "--release-reason", "r")
    assert rc == 1 and f.calls == []
    rc, _ = run(mod, env, tmp_path, f, "--only", "s6", "--release-test", "run-cand-1", "--release-reason", "r")
    assert rc == 0 and f.calls == ["s6"]
    hist = list((tmp_path / "reports" / "test_release_history").glob("*.json"))
    assert len(hist) == 1
    f.calls.clear()
    rc, _ = run(mod, env, tmp_path, f, "--only", "s6", "--release-test", "run-cand-1", "--release-reason", "r")
    assert rc == 0 and f.calls == []  # already released and valid: no second look


def test_development_changes_never_trigger_a_new_test_look(mod, env, tmp_path):
    f = Fakes(mod)
    assert run(mod, env, tmp_path, f)[0] == 0
    assert run(mod, env, tmp_path, f, "--only", "s6", "--release-test", "run-cand-1", "--release-reason", "r")[0] == 0
    s6_bytes = (tmp_path / "reports" / "s6.json").read_bytes()
    f.calls.clear()
    # The habitual command line, including the explicit release flags and even a justification, after a
    # development change: s3 is re-run (new candidate) and the old release must stay untouched.
    rc, _ = run(mod, env, tmp_path, f, "--max-patches", "1024", "--release-test", "run-cand-1",
                "--release-reason", "r", "--justification", "habit")
    assert "s3" in f.calls and "s6" not in f.calls
    assert rc == 1  # the explicit request was refused (candidate mismatch), loudly
    assert (tmp_path / "reports" / "s6.json").read_bytes() == s6_bytes
    st = status_of(mod, env, tmp_path, f, "--max-patches", "1024")
    assert st["s6"]["status"] == "obsolete"
    assert any("candidate" in r or "s3" in r for r in st["s6"]["reasons"])
    for s in ("s7", "s8"):
        assert st[s]["status"] == "valid"  # the obsolete historical release does not block development summaries
    # A new look at the same test patients for the NEW candidate needs a justification.
    f.calls.clear()
    rc, _ = run(mod, env, tmp_path, f, "--max-patches", "1024", "--only", "s6", "--release-test", "run-cand-2",
                "--release-reason", "r")
    assert rc == 1 and f.calls == []
    rc, _ = run(mod, env, tmp_path, f, "--max-patches", "1024", "--only", "s6", "--release-test", "run-cand-2",
                "--release-reason", "r", "--justification", "pre-registered second evaluation")
    assert rc == 0 and f.calls == ["s6"]
    hist = sorted((tmp_path / "reports" / "test_release_history").glob("*.json"))
    assert len(hist) == 2 and any(p.read_bytes() == s6_bytes for p in hist)  # the first audit is immutable


def test_s8_refuses_to_summarise_stale_or_invalid_stages(mod, env, tmp_path):
    f = Fakes(mod)
    assert run(mod, env, tmp_path, f)[0] == 0
    p = tmp_path / "reports" / "s4.json"
    p.write_text(p.read_text().replace("stage_body", "edited_by_hand"))
    f.calls.clear()
    rc, _ = run(mod, env, tmp_path, f, "--only", "s8", "--force", "s8")
    assert rc == 1 and f.calls == []


# --------------------------------------------------------------------------- item 3: fold-unsafe macenko


class _ApiErr(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code, self.message, self.details = code, message, {}


def _arm_driver(mod, env, tmp_path, *, create_run=None, record=None, stain_policy=None, precheck=False):
    """``precheck=False`` simulates an engine without the declared-plan rule, so the creation and worker paths
    are exercised; ``precheck=True`` keeps the engine's real ``preprocessing_fold_safety``."""
    f = Fakes(mod)
    d = make_driver(mod, env, tmp_path, f)
    if not precheck:
        d.fold_safety_precheck = lambda enc, overrides: None
    compared = []
    fs_summary = {"feature_set": {"stain_policy": stain_policy or {}}, "aggregate": {}, "per_slide": []}
    d.supervised_set = lambda enc, dv_id, **kw: {"build": {"status": "ready"}, "created": {"feature_set_id": "fs-m"},
                                                  "feature_set": fs_summary, "params": {}}
    d.create_run = create_run or (lambda **kw: ("run-m", "job-m"))
    d.run_train_jobs = lambda ids, label: {}
    d.run_record = lambda rid: dict(record or {"run_id": rid, "status": "succeeded", "error": None, "params": {}})
    d.compare = lambda runs, **kw: compared.append(runs) or {"status": "ok", "deltas": []}
    return d, compared


def _arm(mod, d, st=None):
    return d.ablation_arm("b_stain_macenko", mod.HANDCRAFTED, {"stain_normalization": "macenko-v1"}, dv_id="dv",
                          manifest={"items": []}, baseline={mod.HANDCRAFTED: {"run_id": "run-base"}}, family_id="fam",
                          st={"runs": {}} if st is None else st)


def test_macenko_is_blocked_before_any_extraction_by_the_engine_rule(mod, env, tmp_path):
    """The engine decides from the declared plan: no feature set is built for an arm it will refuse."""
    d, compared = _arm_driver(mod, env, tmp_path, precheck=True)
    built = []
    d.supervised_set = lambda *a, **k: built.append(a) or {}
    d.skipped = []
    entry = _arm(mod, d)
    assert entry["status"] == "blocked" and entry["blocked_at"] == "precheck"
    assert entry["code"] == "fold_unsafe_preprocessing" and entry["counts_as_evidence"] is False
    assert built == [] and compared == []
    assert any("not built" in s["reason"] for s in d.skipped)


def test_macenko_refused_at_creation_is_blocked_not_evidence(mod, env, tmp_path):
    def refuse(**kw):
        raise _ApiErr("fold_unsafe_preprocessing", "dev_cv with a dataset-fitted shared stain reference")

    d, compared = _arm_driver(mod, env, tmp_path, create_run=refuse)
    entry = _arm(mod, d)
    assert entry["status"] == "blocked" and entry["code"] == "fold_unsafe_preprocessing"
    assert "comparison" not in entry or entry["comparison"].get("status") != "ok"
    assert compared == []


def test_macenko_refused_in_the_worker_is_blocked(mod, env, tmp_path):
    d, compared = _arm_driver(mod, env, tmp_path, record={
        "run_id": "run-m", "status": "failed", "params": {},
        "error": "PermanentJobError: fold_unsafe_preprocessing: the stain reference saw held-out folds"})
    entry = _arm(mod, d)
    assert entry["status"] == "blocked" and compared == []


def test_existing_contaminated_macenko_cv_result_is_invalid_for_comparison(mod, env, tmp_path):
    """A macenko run recorded before the rule (its id is in the resumable state) is evaluated, never re-created,
    and marked invalid for CV comparison."""
    d, compared = _arm_driver(mod, env, tmp_path, precheck=True, stain_policy={
        "method": "macenko-v1", "reference_fit": {"fitted_on": "train-split slides of the dataset version only"}})
    created = []
    d.create_run = lambda **kw: created.append(kw) or ("run-new", "job")
    entry = _arm(mod, d, st={"runs": {f"b_stain_macenko|{mod.HANDCRAFTED}": "run-m"}})
    assert created == []
    assert entry["status"] == "invalid_for_cv_comparison"
    assert compared == [] and entry["comparison"]["status"] == "invalid"


def test_fold_specific_macenko_result_is_compared(mod, env, tmp_path):
    d, compared = _arm_driver(mod, env, tmp_path, record={
        "run_id": "run-m", "status": "succeeded", "error": None, "params": {},
        "preprocessing": {"stain_reference": {"fit_scope": "per_fold", "fold_safe": True}}})
    entry = _arm(mod, d)
    assert entry["status"] == "succeeded" and len(compared) == 1


def test_engine_fold_safety_verdict_decides_macenko_validity(mod, env, tmp_path):
    """The engine records ``preprocessing_fold_safety`` on every run; its verdict wins over any declaration."""
    unsafe = {"run_id": "run-m", "status": "succeeded", "error": None, "params": {},
              "preprocessing": {"fold_safe": True},  # a stray declaration never overrides the engine
              "preprocessing_fold_safety": {"status": "fold_unsafe", "valid_for_cv_comparison": False,
                                            "problems": ["dev_cv shares one dataset-fitted macenko-v1 reference"]}}
    d, compared = _arm_driver(mod, env, tmp_path, record=unsafe)
    entry = _arm(mod, d)
    assert entry["status"] == "invalid_for_cv_comparison" and compared == []
    assert "dataset-fitted" in entry["reason"]
    safe = {"run_id": "run-m", "status": "succeeded", "error": None, "params": {},
            "preprocessing_fold_safety": {"status": "fold_safe", "valid_for_cv_comparison": True}}
    d, compared = _arm_driver(mod, env, tmp_path, record=safe)
    assert _arm(mod, d)["status"] == "succeeded" and len(compared) == 1


def test_sampling_arm_is_not_affected_by_the_macenko_rule(mod, env, tmp_path):
    d, compared = _arm_driver(mod, env, tmp_path)
    entry = d.ablation_arm("a_sampling_uniform", mod.HANDCRAFTED, {"sampling_strategy": "uniform"}, dv_id="dv",
                           manifest={"items": []}, baseline={mod.HANDCRAFTED: {"run_id": "run-base"}},
                           family_id="fam", st={"runs": {}})
    assert entry["status"] == "succeeded" and len(compared) == 1


# --------------------------------------------------------------------------- item 7: seeds, sampling budget


def test_default_seeds_are_three_and_predeclared(mod, env, tmp_path):
    f = Fakes(mod)
    d = make_driver(mod, env, tmp_path, f)
    assert d.seeds == [0, 1, 2]
    grid = [v for v in d.s3_variants() if v["role"] == "grid"]
    assert len(grid) == len(mod.ENCODERS) * len(mod.HEADS) * 3
    lc = [v for v in d.s3_variants() if v["role"] == "learning_curve"]
    assert lc and {v["seed"] for v in lc} == {0}
    d2 = make_driver(mod, env, tmp_path, f, "--seeds", "0")
    assert d2.seeds == [0]
    assert d2.evaluate("s3")["status"] == "missing"


def test_fold_consistency_across_heads_and_seeds(mod):
    recs = [{"run_id": f"r{i}", "role": "grid", "status": "succeeded", "fold_assignment_sha256": "A"}
            for i in range(4)]
    assert mod.fold_consistency(recs)["identical"] is True
    recs[2]["fold_assignment_sha256"] = "B"
    out = mod.fold_consistency(recs)
    assert out["identical"] is False and out["distinct"] == 2


def test_seed_summary_reports_variability_not_extra_patients(mod):
    recs = [{"encoder": "e", "head": h, "seed": s, "role": "grid", "status": "succeeded",
             "oof": {"threshold_free": {"auroc": {"value": v}}, "n_patients": 35}}
            for h, vals in (("meanpool_logreg", (0.8, 0.8, 0.8)), ("abmil", (0.7, 0.75, 0.9)))
            for s, v in zip((0, 1, 2), vals)]
    out = mod.seed_summary(recs, [0, 1, 2])
    by = {(r["encoder"], r["head"]): r for r in out["per_model"]}
    assert by[("e", "abmil")]["auroc"]["n"] == 3
    assert by[("e", "abmil")]["auroc"]["max"] == pytest.approx(0.9)
    assert by[("e", "meanpool_logreg")]["auroc"]["range"] == pytest.approx(0.0)
    assert "not additional independent patients" in out["note"]


def test_paired_accounting_separates_unscorable_subjects(mod):
    out = mod.paired_accounting(
        {"a": {"scored": {"b1": "p1", "b2": "p1", "b3": "p2"}, "unscorable": {"b4": "p3"}},
         "b": {"scored": {"b1": "p1", "b3": "p2", "b4": "p3"}, "unscorable": {"b2": "p1"}}})
    assert out["paired_evaluable"] == {"bags": 2, "patients": 2}
    assert out["unscorable"]["a"] == {"bags": 1, "patients": 1}
    assert out["unscorable"]["b"] == {"bags": 1, "patients": 1}
    assert out["excluded_from_pairing"]["bags"] == 2


def test_sampling_budget_must_be_higher_and_is_in_the_s4b_fingerprint(mod, env, tmp_path):
    f = Fakes(mod)
    with pytest.raises(SystemExit):
        make_driver(mod, env, tmp_path, f, "--sampling-budget", "256")
    assert run(mod, env, tmp_path, f)[0] == 0
    st = status_of(mod, env, tmp_path, f, "--sampling-budget", "1024")
    assert st["s4b"]["status"] == "stale" and st["s3"]["status"] == "valid"
    assert any("1024" in r for r in st["s4b"]["reasons"])


def test_prediction_changes_between_budgets_are_paired_and_development_only(mod):
    base = [{"bag_id": "b1", "patient": "p1", "label": 1, "score": 0.2, "threshold": 0.5, "split": "oof"},
            {"bag_id": "b2", "patient": "p2", "label": 0, "score": 0.6, "threshold": 0.5, "split": "oof"},
            {"bag_id": "b3", "patient": "p3", "label": 1, "score": 0.9, "threshold": 0.5, "split": "oof"}]
    high = [{"bag_id": "b1", "patient": "p1", "label": 1, "score": 0.7, "threshold": 0.55, "split": "oof"},
            {"bag_id": "b2", "patient": "p2", "label": 0, "score": 0.6, "threshold": 0.55, "split": "oof"}]
    out = mod.prediction_changes(base, high)
    assert out["paired_bags"] == 2 and out["only_in_current"] == 1
    assert out["decision_flips"] == 1 and out["flips_to_correct"] == 1 and out["flips_to_incorrect"] == 0
    with pytest.raises(ValueError):
        mod.prediction_changes(base + [{"bag_id": "t", "patient": "pt", "label": 1, "score": 0.1,
                                        "threshold": 0.5, "split": "test"}], high)


def test_paired_coverage_uses_development_slides_only(mod):
    rows_cur = [{"slide_id": s, "status": "done", "n_patches": 256,
                 "coverage": {"tissue_within_radius_of_sample_fraction": 0.5, "fragments_without_sampled_patch": 2,
                              "sampled_tissue_fraction": 0.1}} for s in ("d1", "d2", "t1")]
    rows_hi = [{"slide_id": s, "status": "done", "n_patches": 512,
                "coverage": {"tissue_within_radius_of_sample_fraction": 0.7, "fragments_without_sampled_patch": 1,
                             "sampled_tissue_fraction": 0.2}} for s in ("d1", "d2", "t1")]
    out = mod.paired_coverage(rows_cur, rows_hi, {"d1", "d2"})
    assert out["slides"] == 2
    assert out["delta"]["tissue_within_radius_of_sample_fraction"]["mean"] == pytest.approx(0.2)
    assert out["slides_with_fewer_unsampled_fragments"] == 2


# --------------------------------------------------------------------------- real stage bodies (engine calls stubbed)


MANIFEST = {"reference_standard": "imported_reference",
            "items": [{"slide_id": f"d{i}", "split": "train", "coded_patient_id": f"p{i}",
                       "label_value": "bcc_present" if i % 2 else "bcc_absent_not_benign"} for i in range(6)]
            + [{"slide_id": "t0", "split": "test", "coded_patient_id": "pt0", "label_value": "bcc_present"}]}

# seed-0 point estimates would pick midnight-12k | abmil (0.90); the pre-declared rule uses the mean over seeds
AUROC = {("handcrafted-stain-texture-v1", "meanpool_logreg"): (0.80, 0.80, 0.80),
         ("handcrafted-stain-texture-v1", "abmil"): (0.85, 0.70, 0.72),
         ("midnight-12k", "meanpool_logreg"): (0.78, 0.79, 0.80),
         ("midnight-12k", "abmil"): (0.90, 0.60, 0.65)}


class Engine:
    """Stand-ins for the engine services the stage bodies call; records what was requested."""

    def __init__(self, mod):
        self.mod = mod
        self.runs: dict[str, dict] = {}
        self.status_override: dict[str, str] = {}
        self.compared: list[dict] = []
        self.create_calls: list[dict] = []
        self.refuse_macenko = False

    def create_run(self, **kw):
        if self.refuse_macenko and str(kw["params"].get("stain_normalization", "")).startswith("macenko"):
            raise _ApiErr("fold_unsafe_preprocessing", "dev_cv with a dataset-fitted shared stain reference")
        rid = f"run-{len(self.runs) + 1}"
        self.runs[rid] = kw
        self.create_calls.append(kw)
        return rid, f"job-{rid}"

    def run_record(self, rid):
        kw = self.runs[rid]
        seed = kw["seed"]
        auc = AUROC.get((kw["encoder"], kw["head"]), (0.7, 0.7, 0.7))[seed % 3]
        if kw["params"].get("train_patient_fraction"):
            auc -= 0.1
        status = self.status_override.get(rid, "succeeded")
        return {"run_id": rid, "encoder": kw["encoder"], "head": kw["head"], "seed": seed, "status": status,
                "error": None if status == "succeeded" else "boom", "feature_set_id": kw["fs_id"],
                "identity_sha256": f"id-{rid}", "checkpoint": {"sha256": f"ck-{rid}"}, "threshold": {"value": 0.5},
                "params": kw["params"], "prediction_splits": ["oof", "train"], "test_items_used": 0,
                "train_patients": 6, "fold_assignment_sha256": "folds-A",
                "oof": {"threshold_free": {"auroc": {"value": auc, "ci": [auc - 0.2, auc + 0.1]}}, "n_patients": 6}}

    def compare(self, run_ids, **kw):
        self.compared.append(dict(run_ids))
        names = sorted(run_ids)
        return {"status": "ok", "models": names, "subject_accounting": {"paired_evaluable": {"bags": 6}},
                "deltas": [{"a": names[0], "b": names[1], "auroc": {"value": 0.01, "ci": [-0.1, 0.1]}}]}


def stage_driver(mod, env, tmp_path, monkeypatch, *argv):
    import dermpath.ml.evaluation as ev

    f = Fakes(mod)
    d = make_driver(mod, env, tmp_path, f, *argv)
    for s in mod.STAGES:  # real stage bodies
        d.__dict__.pop(s, None)
    eng = Engine(mod)
    reports = tmp_path / "reports"
    (reports / "s1.json").write_text(json.dumps({"dataset": {"dataset_version_id": "dv-1"}}))
    (reports / "s2.json").write_text(json.dumps({"encoders": {e: {"created": {
        "feature_set_id": f"fs-tech-{e}", "policy_sha256": "pol"}} for e in mod.ENCODERS}}))
    d.manifest = lambda dv_id: MANIFEST
    d.authorize = lambda db, perm: None
    d.reuse_probe = lambda dv_id, enc, tech: {"accepted": False}
    d.supervised_set = lambda enc, dv_id, label, technical_fs_id=None, **ov: {
        "params": ov, "build": {"status": "ready", "wall_seconds": 1.0},
        "created": {"feature_set_id": f"fs-{label}-{enc}", "policy_sha256": "pol"},
        "feature_set": {"aggregate": {"done": 7, "cache_hits": 0, "fresh_extractions": 7, "coverage": {}},
                        "feature_set": {"stain_policy": {}},
                        "per_slide": [{"slide_id": it["slide_id"], "status": "done", "cache_hit": False,
                                       "n_patches": ov.get("max_patches_per_slide", 256), "total_seconds": 2.0,
                                       "peak_rss_bytes": 10 ** 9,
                                       "coverage": {"tissue_within_radius_of_sample_fraction":
                                                    0.8 if ov.get("max_patches_per_slide") else 0.6,
                                                    "fragments_without_sampled_patch":
                                                    0 if ov.get("max_patches_per_slide") else 1,
                                                    "sampled_tissue_fraction": 0.1}}
                                      for it in MANIFEST["items"]]}}
    d.create_run = eng.create_run
    d.run_status = lambda rid: eng.status_override.get(rid, "succeeded")
    d.run_train_jobs = lambda ids, label: {}
    d.run_record = eng.run_record
    d.compare = eng.compare
    monkeypatch.setattr(ev, "create_family", lambda *a, **k: SimpleNamespace(id="fam-1"))
    monkeypatch.setattr(ev, "add_family_member", lambda *a, **k: True)
    return d, eng


def test_s3_body_runs_every_seed_on_fixed_folds_and_declares_by_seed_mean(mod, env, tmp_path, monkeypatch):
    d, eng = stage_driver(mod, env, tmp_path, monkeypatch)
    d.prepare_state("s3", d.stage_fingerprint("s3"), False)
    body = d.s3()
    grid = [c for c in eng.create_calls if c["role"] == "grid"]
    assert sorted({c["seed"] for c in grid}) == [0, 1, 2] and len(grid) == 12
    lc = [c for c in eng.create_calls if c["role"] == "learning_curve"]
    assert lc and {c["seed"] for c in lc} == {0}
    assert body["protocol"]["fold_consistency"]["identical"] is True
    assert set(body["comparisons"]["by_seed"]) == {"0", "1", "2"}
    assert body["comparisons"]["four_way"]["status"] == "ok"
    assert len(eng.compared[-1]) == 4 or any(len(c) == 4 for c in eng.compared)
    cand = body["pre_declared_test_candidate"]
    assert (cand["chosen"]["encoder"], cand["chosen"]["head"]) == (mod.HANDCRAFTED, "meanpool_logreg")
    assert eng.runs[cand["chosen"]["run_id"]]["seed"] == 0
    assert cand["rule"] == mod.CANDIDATE_RULE and "mean" in cand["rule"]
    hm = {(m["encoder"], m["head"]): m for m in body["seed_summary"]["per_model"]}
    assert hm[(mod.MIDNIGHT, "abmil")]["auroc"]["range"] == pytest.approx(0.30)
    lc_points = body["learning_curves"][0]["points"]
    assert lc_points[-1]["n_repeats"] == 1  # the 1.0 point is the first seed's grid run only
    # resume: nothing is re-created; a failed run is replaced and recorded
    n = len(eng.create_calls)
    d.s3()
    assert len(eng.create_calls) == n
    victim = grid[0]
    rid = [r for r, kw in eng.runs.items() if kw is victim][0]
    eng.status_override[rid] = "failed"
    d.skipped = []
    body = d.s3()
    assert len(eng.create_calls) == n + 1
    assert body["costs"]["replaced_runs"][0]["run_id"] == rid
    assert any("replaced" in s["reason"] for s in d.skipped)


def test_s4_body_blocks_macenko_and_keeps_the_sampling_arm(mod, env, tmp_path, monkeypatch):
    d, eng = stage_driver(mod, env, tmp_path, monkeypatch)
    d.prepare_state("s3", d.stage_fingerprint("s3"), False)
    (tmp_path / "reports" / "s3.json").write_text(json.dumps(d.s3(), default=str))
    eng.refuse_macenko = True  # the engine's 409 fold_unsafe_preprocessing for dev_cv + shared reference
    d.precision_study = lambda s2, manifest: {"candidates": {}}
    d.prepare_state("s4", d.stage_fingerprint("s4"), False)
    d.warnings, d.skipped = [], []
    body = d.s4()
    assert body["arm_status"]["b_stain_macenko"] == {e: "blocked" for e in mod.ENCODERS}
    assert body["arm_status"]["a_sampling_uniform"] == {e: "succeeded" for e in mod.ENCODERS}
    assert {(x["arm"], x["status"]) for x in body["not_evidence"]} == {("b_stain_macenko", "blocked")}
    for e in mod.ENCODERS:
        assert body["arms"]["b_stain_macenko"][e]["comparison"]["status"] == "not_computed"
        assert body["arms"]["a_sampling_uniform"][e]["comparison"]["status"] == "ok"
    # only the sampling arm's runs were created; every s4 run uses the first pre-declared seed
    s4_runs = [kw for kw in eng.create_calls if kw["role"] in ("a_sampling_uniform", "b_stain_macenko")]
    assert {kw["role"] for kw in s4_runs} == {"a_sampling_uniform"} and {kw["seed"] for kw in s4_runs} == {0}
    assert any("blocked" in s["reason"] for s in d.skipped)
    assert body["precision"]["downstream_fp16"]["status"] == "not_run"


def test_s4b_body_is_development_only_and_paired(mod, env, tmp_path, monkeypatch):
    d, eng = stage_driver(mod, env, tmp_path, monkeypatch, "--sampling-budget", "512")
    d.prepare_state("s3", d.stage_fingerprint("s3"), False)
    s3 = d.s3()
    for enc in mod.ENCODERS:  # the s3 report carries the supervised sets' per-slide coverage
        s3["feature_sets"][enc]["supervised_set"] = d.supervised_set(enc, "dv-1", label="S3 supervised")
    (tmp_path / "reports" / "s3.json").write_text(json.dumps(s3, default=str))
    preds = {}

    def dev_predictions(rid):
        kw = eng.runs[rid]
        hi = kw["params"]["max_patches_per_slide"] == 512
        return [{"bag_id": it["slide_id"], "patient": it["coded_patient_id"], "label": int(i % 2), "split": "oof",
                 "score": (0.7 if hi and i == 0 else 0.3) if i % 2 == 0 else 0.8, "threshold": 0.5}
                for i, it in enumerate(MANIFEST["items"]) if it["split"] == "train"]

    d.dev_predictions = dev_predictions
    d.prepare_state("s4b", d.stage_fingerprint("s4b"), False)
    d.skipped = []
    body = d.s4b()
    del preds
    assert body["development_only"] is True and body["budgets"]["higher"] == 512
    for enc in mod.ENCODERS:
        e = body["encoders"][enc]
        assert e["status"] == "succeeded"
        assert e["coverage"]["slides"] == 6  # the test slide t0 is excluded
        assert e["coverage"]["delta"]["tissue_within_radius_of_sample_fraction"]["mean"] == pytest.approx(0.2)
        assert e["resources"]["test_slides_extracted_label_free"] == 1
        assert e["prediction_changes"]["paired_bags"] == 6 and e["prediction_changes"]["decision_flips"] == 1
        assert set(e["comparison"]["models"]) == {"current_budget", "higher_budget"}
        hi_run = e["run"]["run_id"]
        assert eng.runs[hi_run]["params"]["max_patches_per_slide"] == 512 and eng.runs[hi_run]["seed"] == 0
    assert any("abmil" in s["what"] for s in d.skipped)


def test_run_record_and_compare_on_real_dev_cv_runs(mod, env, ids, tmp_path):
    """Two synthetic dev_cv runs (seeds 0 and 1) trained by the worker: the driver records the seed and the fold
    identity, finds the folds identical across seeds, and compares them on paired evaluable bags with the
    unscorable ones accounted per model."""
    from dermpath.auth import Actor
    from dermpath.db import session_scope
    from dermpath.ml.service import create_experiment
    from dermpath.models import Project
    from test_ml_support import CID, FAST, LEAD, SYNTH, cohort, run_jobs

    lead = Actor(LEAD, "research_lead", "Priya Navarro")
    rids = []
    for seed in (0, 1):
        with session_scope() as db:
            run, _ = create_experiment(db, lead, db.get(Project, CID),
                                       dataset_version_id=cohort(ids)["dataset_version_id"], encoder_id=SYNTH,
                                       head="meanpool_logreg", params={**FAST, "cv_folds": 3, "min_threshold_evidence": 5}, seed=seed,
                                       name=None, evaluation_protocol="dev_cv")
            rids.append(run.id)
    assert [o.status for o in run_jobs()] == ["succeeded", "succeeded"]
    f = Fakes(mod)
    d = make_driver(mod, env, tmp_path, f)
    d.authorize = lambda db, perm: None
    recs = [d.run_record(r) for r in rids]
    assert [r["seed"] for r in recs] == [0, 1]
    assert all(r["fold_assignment_sha256"] for r in recs)
    assert mod.fold_consistency(recs)["identical"] is True  # folds do not depend on the training seed
    assert "preprocessing_fold_safety" in recs[0] and recs[0]["unscorable_oof"]["bags"] >= 0
    out = d.compare({"seed0": rids[0], "seed1": rids[1]})
    assert out["status"] == "ok", out
    acc = out["subject_accounting"]
    assert acc["paired_evaluable"]["bags"] == recs[0]["oof"]["n_items"]
    assert set(acc["unscorable"]) == {"seed0", "seed1"}
    with pytest.raises(mod.StageError):
        d.compare({"a": rids[0], "b": rids[1]}, split="test")  # the driver never compares test predictions


def test_run_record_carries_abmil_epoch_selection_and_final_fit_counts(mod, env, ids, tmp_path):
    """Brief item 7 (driver side of the ABMIL refit): the s3 run record copies the engine's ABMIL fitting
    semantics, i.e. which patients and bags selected the epoch count (inner hold-out) and which the final model was
    refitted on, as counts only (no patient keys, no per-epoch history), so the report and the evidence package
    state the effective fitting and early-stopping populations accurately."""
    from dermpath.auth import Actor
    from dermpath.db import session_scope
    from dermpath.ml.service import create_experiment
    from dermpath.models import Project
    from test_ml_support import CID, FAST, LEAD, SYNTH, cohort, run_jobs

    lead = Actor(LEAD, "research_lead", "Priya Navarro")
    with session_scope() as db:
        run, _ = create_experiment(db, lead, db.get(Project, CID),
                                   dataset_version_id=cohort(ids)["dataset_version_id"], encoder_id=SYNTH,
                                   head="abmil", params={**FAST, "max_epochs": 4, "patience": 2, "cv_folds": 3,
                                                         "min_threshold_evidence": 5},
                                   seed=0, name=None, evaluation_protocol="dev_cv")
        rid = run.id
    assert [o.status for o in run_jobs()] == ["succeeded"]
    d = make_driver(mod, env, tmp_path, Fakes(mod))
    d.authorize = lambda db, perm: None
    ts = d.run_record(rid)["training_summary"]
    sel, fin = ts.get("epoch_selection"), ts.get("final_fit")
    assert sel is not None and fin is not None, sorted(ts)
    assert sel["status"] in ("selected", "not_possible")
    assert {"bags", "patients"} <= set(fin) and fin["epochs"] == ts["final_fit_epochs"]
    if sel["status"] == "selected":
        assert sel["fit"]["patients"] + sel["holdout"]["patients"] == fin["patients"]
        assert fin["epochs"] == sel["best_epoch"]
    assert ts.get("fit_semantics")
    blob = json.dumps(ts)
    assert "holdout_patient_keys" not in blob and '"history"' not in blob
