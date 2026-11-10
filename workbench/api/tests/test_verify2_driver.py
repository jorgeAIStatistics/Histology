"""Adversarial verification, round 2: the COBRA experiment driver and the evidence exporter. RESEARCH USE ONLY.

Lens: stage reuse vs fingerprinted inputs, artifact integrity, transitive invalidation, summary assembly, test-release
opt-in and audit immutability, development-only sampling comparison, fold identity across seeds/heads, and leaks
from the evidence exporter. Both scripts are imported by path. Reports and evidence packages go to ``tmp_path``; the
only database opened is the per-test copy of the seeded template (``env``). Nothing here touches
``workbench/var``, ``workbench/experiments/reports`` or ``workbench/experiments/evidence``.

A test FAILS when the guarantee it attacks is violated (a reproduction); a passing test stays as regression coverage.
"""

from __future__ import annotations

import importlib.util
import json
import os
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

SCRIPTS = Path(__file__).resolve().parents[2] / "scripts"
COBRA_CODE = "COBRA-P000111"  # fictitious placeholder in COBRA's code format; never a real patient code
COBRA_ACCESSION = "COBRA-P000111-S2"
SLIDE_FILE = "RUMC-B19-8899_HE.tif"


def _load(name: str, file: str):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / file)
    m = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = m
    spec.loader.exec_module(m)
    return m


@pytest.fixture(scope="module")
def mod():
    m = _load("run_cobra_experiments_verify2", "run_cobra_experiments.py")
    yield m
    sys.modules.pop("run_cobra_experiments_verify2", None)


@pytest.fixture(scope="module")
def exp():
    m = _load("export_evidence_verify2", "export_evidence.py")
    yield m
    sys.modules.pop("export_evidence_verify2", None)


# =================================================================================================== harness


class Fakes:
    """Stage bodies shaped like the driver's real reports (enough for the REAL s8 body). ``real`` names stages
    whose real body runs."""

    def __init__(self, mod, real=()):
        self.mod = mod
        self.real = set(real)
        self.calls: list[str] = []
        self.n = {s: 0 for s in mod.STAGES}
        self.fail: set[str] = set()
        self.s3_runs: list[dict] | None = None
        self.s3_extra: dict = {}
        self.s2_per_slide: list[dict] = []
        self.s6_release_ids: list[str] = []
        self.s7_errors: list[dict] = []

    def body(self, stage: str) -> dict:
        # A real re-run never reproduces the same bytes (timings); the attempt number stands in for them.
        return {**self._body(stage), "attempt": self.n[stage]}

    def _body(self, stage: str) -> dict:
        m = self.mod
        self.n[stage] += 1
        n = self.n[stage]
        if stage == "s0":
            return {"machine": {"cpu_count": 1}, "encoders": {"benchmark_encoders": {}}, "devices": {}}
        if stage == "s1":
            return {"dataset": {"dataset_version_id": "dv-1", "manifest_sha256": "m" * 64,
                                "split_fingerprint": "f" * 64, "counts": {"patients": 50, "slides": 60}},
                    "split_table": {}, "test_patients": 15, "development_pool_patients": 35}
        if stage == "s2":
            return {"encoders": {e: {"created": {"feature_set_id": f"fs-tech-{e}", "spec_sha256": f"spec-{e}",
                                                 "policy_sha256": "p" * 64},
                                     "technical_validation": {"passed": True},
                                     "feature_set": {"feature_set": {"feature_set_id": f"fs-tech-{e}"},
                                                     "aggregate": {"patches_total": 10, "coverage": {}},
                                                     "per_slide": list(self.s2_per_slide)}}
                                 for e in m.ENCODERS}}
        if stage == "s3":
            runs = self.s3_runs if self.s3_runs is not None else [
                {"run_id": f"run-{e}-{h}-{n}", "encoder": e, "head": h, "role": "grid", "status": "succeeded",
                 "seed": 0, "fraction": 1.0, "repeat": 0} for e in m.ENCODERS for h in m.HEADS]
            return {"runs": json.loads(json.dumps(runs, default=str)),
                    "feature_sets": {e: {"supervised_feature_set_id": f"fs-sup-{e}",
                                         "supervised_set": {"feature_set": {
                                             "per_slide": list(self.s2_per_slide),
                                             "aggregate": {"coverage": {}}}}} for e in m.ENCODERS},
                    "comparisons": {"encoder_effects": [], "head_effects": []},
                    "pre_declared_test_candidate": {"rule": m.CANDIDATE_RULE, "declared_at": "now",
                                                    "chosen": {"run_id": f"run-cand-{n}", "encoder": m.HANDCRAFTED,
                                                               "head": "meanpool_logreg",
                                                               "identity_sha256": f"id-{n}"}},
                    **self.s3_extra}
        if stage == "s4":
            return {"arms": {}, "not_evidence": []}
        if stage == "s5":
            return {"extraction": []}
        if stage == "s6":
            rid = self.s6_release_ids.pop(0) if self.s6_release_ids else f"rel-{n}"
            return {"candidate": {"chosen": {"run_id": f"run-cand-{self.n['s3']}"}}, "test_release_id": rid,
                    "release_number": n, "action": "new test release recorded",
                    "test_metrics": {"auroc": {"value": 0.71, "ci": [0.5, 0.9]}}}
        if stage == "s7":
            return {"dominant_categories": {}, "learning_curve_slopes": [],
                    "oof_runs": [{"encoder": m.HANDCRAFTED, "head": "abmil", "errors": list(self.s7_errors)}]}
        return {"stage_body": stage}

    def install(self, d):
        for s in self.mod.STAGES:
            if s in self.real:
                continue

            def fake(*_a, _s=s, **_k):
                self.calls.append(_s)
                if _s in self.fail:
                    raise self.mod.StageError(f"{_s} failed on purpose")
                return self.body(_s)

            setattr(d, s, fake)


IDENTITY: dict = {}


@pytest.fixture(autouse=True)
def _reset_identity():
    IDENTITY.clear()
    yield
    IDENTITY.clear()


def make_driver(mod, env, tmp_path, fakes, *argv, artifacts=None):
    settings, _ = env
    reports = tmp_path / "reports"
    args = mod.build_parser().parse_args(["--var-dir", str(settings.var_dir), "--reports-dir", str(reports), *argv])
    d = mod.Driver(args)
    d.reports_dir.mkdir(parents=True, exist_ok=True)
    d.state_dir.mkdir(parents=True, exist_ok=True)
    d.actor = SimpleNamespace(id="user-research-lead", role="research_lead", display_name="Research lead")
    d.midnight_device = "cpu"
    d.lead = lambda: d.actor
    d.encoder_identity = lambda e: dict(IDENTITY.get(e) or {"status": "available", "spec_sha256": f"spec-{e}",
                                                             "weights_sha256": f"weights-{e}"})
    d.artifact_problems = artifacts or (lambda stage, rep: [])
    fakes.install(d)
    return d


def run(mod, env, tmp_path, fakes, *argv, artifacts=None) -> int:
    return make_driver(mod, env, tmp_path, fakes, *argv, artifacts=artifacts).run()


def status_of(mod, env, tmp_path, fakes, *argv, artifacts=None) -> dict:
    d = make_driver(mod, env, tmp_path, fakes, *argv, artifacts=artifacts)
    return {s: d.evaluate(s) for s in mod.STAGES}


def export(exp, reports: Path, tmp_path: Path, *extra) -> tuple[int, Path]:
    out_root = tmp_path / "evidence"
    rc = exp.main(["--experiment-id", "verify2-pkg", "--reports-dir", str(reports), "--out-root", str(out_root),
                   "--salt-file", str(tmp_path / "salt"), *extra])
    return rc, out_root / "verify2-pkg"


def all_text(pkg: Path) -> str:
    return "\n".join(p.read_text() for p in sorted(pkg.rglob("*")) if p.is_file())


NON_TEST = ["s0", "s1", "s2", "s3", "s4", "s4b", "s5", "s7", "s8"]


# =================================================================================================== 1. reuse vs inputs


# (changed command line, stages whose OWN config must flag the change, a substring of that changed component)
CHANGES = [
    (("--n-boot", "500"), ("s3", "s4", "s4b"), "n_boot"),
    (("--cv-folds", "3"), ("s3", "s4", "s4b"), "cv_folds"),
    (("--seeds", "0,1"), ("s3",), "seeds"),
    (("--seeds", "1,0,2"), ("s3", "s4", "s4b"), "seed"),
    (("--lc-fractions", "0.5,1.0"), ("s3",), "fractions"),
    (("--lc-repeats", "2"), ("s3",), "repeats"),
    (("--sampling-budget", "1024"), ("s4b",), "higher"),
    (("--sampling-encoders", "handcrafted-stain-texture-v1"), ("s4b",), "encoders"),
    (("--precision-patches", "64"), ("s4",), "patches"),
    (("--skip-precision-downstream",), ("s4",), "skip_downstream"),
    (("--hourly-rate", "2.5"), ("s5",), "hourly_rate"),
    (("--max-patches", "128"), ("s2", "s3", "s4", "s4b"), "max_patches_per_slide"),
]


@pytest.mark.parametrize("argv,direct,component", CHANGES, ids=[" ".join(c[0]) for c in CHANGES])
def test_every_budget_seed_and_config_change_makes_its_stage_stale(mod, env, tmp_path, argv, direct, component):
    f = Fakes(mod)
    assert run(mod, env, tmp_path, f) == 0
    st = status_of(mod, env, tmp_path, f, *argv)
    for s in direct:
        assert st[s]["status"] == "stale", (argv, s, st[s])
        assert any(component in r and not r.startswith("upstream") for r in st[s]["reasons"]), (s, st[s]["reasons"])
    for s in ("s0", "s1"):
        assert st[s]["status"] == "valid", (argv, s, st[s])  # their inputs did not change
    assert st["s8"]["status"] == "stale"  # the summary never outlives a changed stage
    f.calls.clear()
    assert run(mod, env, tmp_path, f, *argv) == 0
    for s in direct:
        assert s in f.calls, (argv, f.calls)
    assert "s6" not in f.calls


@pytest.mark.parametrize("what", ["code_tree", "extractor_version", "dependencies", "weights", "weights_config",
                                  "encoder_spec"])
def test_engine_weights_and_dependency_identity_changes_make_stages_stale(mod, env, tmp_path, monkeypatch, what):
    import dermpath.ml.artifacts as art
    import dermpath.ml.feature_sets as fsets

    f = Fakes(mod)
    assert run(mod, env, tmp_path, f) == 0
    if what == "code_tree":
        real = art.code_identity
        monkeypatch.setattr(art, "code_identity", lambda: {**real(), "code_tree_sha256": "e" * 64})
    elif what == "extractor_version":
        monkeypatch.setattr(fsets, "EXTRACTOR_VERSION", fsets.EXTRACTOR_VERSION + "-changed")
    elif what == "dependencies":
        real_dv = art.dependency_versions
        monkeypatch.setattr(art, "dependency_versions", lambda: {**real_dv(), "numpy": "99.0.0"})
    else:
        key = {"weights": "weights_sha256", "weights_config": "weights_config_sha256",
               "encoder_spec": "spec_sha256"}[what]
        IDENTITY[mod.MIDNIGHT] = {"status": "available", "spec_sha256": f"spec-{mod.MIDNIGHT}",
                                  "weights_sha256": f"weights-{mod.MIDNIGHT}", key: "changed"}
    st = status_of(mod, env, tmp_path, f)
    stale = {s for s, v in st.items() if v["status"] == "stale"}
    must = {"s0", "s2", "s3", "s4", "s4b", "s5", "s7", "s8"} if what not in ("code_tree", "extractor_version",
                                                                           "dependencies") else set(NON_TEST)
    assert must <= stale, (what, {s: v["status"] for s, v in st.items()})


def test_forcing_s1_makes_every_transitive_dependent_stale_and_s6_obsolete_never_rerun(mod, env, tmp_path):
    f = Fakes(mod)
    assert run(mod, env, tmp_path, f) == 0
    assert run(mod, env, tmp_path, f, "--only", "s6", "--release-test", "run-cand-1", "--release-reason", "r") == 0
    s6_bytes = (tmp_path / "reports" / "s6.json").read_bytes()
    f.calls.clear()
    assert run(mod, env, tmp_path, f, "--only", "s1", "--force", "s1") == 0
    assert f.calls == ["s1"]
    st = status_of(mod, env, tmp_path, f)
    for s in ("s2", "s3", "s4", "s4b", "s5", "s7", "s8"):
        assert st[s]["status"] == "stale", (s, st[s])
    assert st["s0"]["status"] == "valid"
    assert st["s6"]["status"] == "obsolete"
    f.calls.clear()
    assert run(mod, env, tmp_path, f) == 0
    assert f.calls == ["s2", "s3", "s4", "s4b", "s5", "s7", "s8"]  # every dependent, in order; never s6
    assert (tmp_path / "reports" / "s6.json").read_bytes() == s6_bytes
    st = status_of(mod, env, tmp_path, f)
    assert {s: v["status"] for s, v in st.items()} == {**{s: "valid" for s in NON_TEST}, "s6": "obsolete"}


# =================================================================================================== 2. integrity


def test_missing_integrity_record_reformatted_or_truncated_reports_are_never_valid(mod, env, tmp_path):
    f = Fakes(mod)
    assert run(mod, env, tmp_path, f) == 0
    reports = tmp_path / "reports"
    (reports / "_state" / "s2.integrity.json").unlink()
    st = status_of(mod, env, tmp_path, f)
    assert st["s2"]["status"] == "invalid"
    assert all(st[s]["status"] == "stale" for s in ("s3", "s4", "s4b", "s5", "s7", "s8"))
    f.calls.clear()
    # (a re-run that reproduces the very same bytes leaves its dependents legitimately valid)
    assert run(mod, env, tmp_path, f) == 0 and f.calls[:1] == ["s2"]
    assert all(v["status"] == "valid" for s, v in status_of(mod, env, tmp_path, f).items() if s != "s6")
    # same JSON content, different bytes (re-serialised by an editor): not the recorded report
    p = reports / "s3.json"
    p.write_text(json.dumps(json.loads(p.read_text())))
    assert status_of(mod, env, tmp_path, f)["s3"]["status"] == "invalid"
    assert run(mod, env, tmp_path, f) == 0
    (reports / "s4.json").write_text("")  # truncated by a crash or a full disk
    st = status_of(mod, env, tmp_path, f)
    assert st["s4"]["status"] == "invalid" and st["s5"]["status"] == "stale"


def test_a_restored_upstream_report_never_revalidates_dependents_computed_on_another(mod, env, tmp_path):
    """Upstream report bytes are part of every dependent's fingerprint: restoring the previous s3 (with its own
    integrity record) leaves s3 internally valid, but s4..s8 were computed on the other s3."""
    f = Fakes(mod)
    assert run(mod, env, tmp_path, f) == 0
    reports = tmp_path / "reports"
    assert run(mod, env, tmp_path, f, "--only", "s3", "--force", "s3") == 0
    assert run(mod, env, tmp_path, f) == 0  # dependents recomputed on the new s3
    old_rep = sorted((reports / "_superseded").glob("s3.*.json"))[0]
    old_int = sorted((reports / "_superseded" / "_state").glob("s3.integrity.*.json"))[0]
    os.replace(old_rep, reports / "s3.json")
    os.replace(old_int, reports / "_state" / "s3.integrity.json")
    st = status_of(mod, env, tmp_path, f)
    assert st["s3"]["status"] == "valid"
    for s in ("s4", "s4b", "s5", "s7", "s8"):
        assert st[s]["status"] == "stale", (s, st[s])
        assert any("s3" in r for r in st[s]["reasons"])


def test_database_artifact_changes_after_the_report_make_it_invalid(mod, env, tmp_path):
    """Real artifact checks on the database rows a report pins: a grid run that did not succeed, a run or test
    release that is gone, and any change to a pinned feature set or run row that the database lets through (the ORM
    guards and the triggers refuse every one tried here) make the stage invalid."""
    from sqlalchemy import select

    from dermpath.db import session_scope
    from dermpath.ml.engine_models import FeatureSet
    from dermpath.ml.models import TrainingRun

    d = make_driver(mod, env, tmp_path, Fakes(mod))
    check = lambda stage, rep: mod.Driver.artifact_problems(d, stage, rep)  # noqa: E731
    with session_scope() as db:
        fs = db.scalars(select(FeatureSet).where(FeatureSet.status == "ready")).first()
        run_ = db.scalars(select(TrainingRun).where(TrainingRun.status == "succeeded",
                                                    TrainingRun.checkpoint_sha256.is_not(None))).first()
        assert fs is not None and run_ is not None
        fs_id, spec, rid, ident, ck = fs.id, fs.spec_sha256, run_.id, run_.identity_sha256, run_.checkpoint_sha256
    s2 = {"encoders": {"x": {"created": {"feature_set_id": fs_id, "spec_sha256": spec}}}}
    s3 = {"runs": [{"run_id": rid, "status": "succeeded", "role": "grid", "identity_sha256": ident,
                    "checkpoint": {"sha256": ck}}], "feature_sets": {}}
    assert check("s2", s2) == [] and check("s3", s3) == []
    s3_failed_grid = {"runs": [{**s3["runs"][0]}, {"run_id": rid, "status": "failed", "role": "grid"}],
                      "feature_sets": {}}
    assert any("did not succeed" in p for p in check("s3", s3_failed_grid))
    # The ORM guards and the database triggers make these rows immutable. Whatever a damaged or hand-edited
    # database lets through must be caught by the artifact check; whatever it refuses cannot drift silently.
    import sqlalchemy.exc

    from dermpath.db import get_engine

    def tamper(sql: str, params: tuple) -> bool:
        try:
            with get_engine().begin() as conn:
                conn.exec_driver_sql(sql, params)
            outcomes.append((sql.split(" WHERE")[0], "accepted"))
            return True
        except sqlalchemy.exc.DatabaseError as exc:
            outcomes.append((sql.split(" WHERE")[0], f"refused: {str(exc.orig)[:60]}"))
            return False

    outcomes: list = []

    if tamper("UPDATE feature_set SET status = 'failed' WHERE id = ?", (fs_id,)):
        assert any("not ready" in p for p in check("s2", s2))
    if tamper("UPDATE feature_set SET spec_sha256 = ? WHERE id = ?", ("1" * 64, fs_id)):
        assert check("s2", s2)
    if tamper("DELETE FROM feature_set WHERE id = ?", (fs_id,)):
        assert check("s2", s2)
    if tamper("UPDATE training_run SET checkpoint_sha256 = ? WHERE id = ?", ("0" * 64, rid)):
        assert any("checkpoint" in p for p in check("s3", s3))
    if tamper("UPDATE training_run SET identity_sha256 = ? WHERE id = ?", ("2" * 64, rid)):
        assert any("identity" in p for p in check("s3", s3))
    if tamper("UPDATE training_run SET status = 'failed' WHERE id = ?", (rid,)):
        assert any("failed now" in p for p in check("s3", s3))
    assert len(outcomes) == 6  # each attempt was either refused by the database or caught by the check
    assert check("s4", {"arms": {"a": {"x": {"status": "succeeded", "run": {"run_id": "gone",
                                                                           "status": "succeeded"}}}}})
    assert check("s6", {"test_release_id": "gone"})


def test_missing_or_corrupted_stored_artifacts_are_never_valid(mod, env, tmp_path):
    """The DB rows are immutable, but the objects they pin live in the object store. A checkpoint object that no
    longer hashes to the run's checkpoint_sha256, or feature embeddings that are gone, must not leave s3 / s2
    'valid' ("artifacts verified")."""
    from sqlalchemy import select

    from dermpath.db import session_scope
    from dermpath.ml.engine_models import FeatureSet, FeatureSetItem
    from dermpath.ml.models import FeatureArtifact, TrainingRun
    from dermpath.storage import get_store

    d = make_driver(mod, env, tmp_path, Fakes(mod))
    check = lambda stage, rep: mod.Driver.artifact_problems(d, stage, rep)  # noqa: E731
    store = get_store()
    with session_scope() as db:
        fs = next(f for f in db.scalars(select(FeatureSet).where(FeatureSet.status == "ready")).all()
                  if db.scalars(select(FeatureSetItem).where(FeatureSetItem.feature_set_id == f.id,
                                                             FeatureSetItem.artifact_id.is_not(None))).first())
        art_ids = [i.artifact_id for i in db.scalars(select(FeatureSetItem).where(
            FeatureSetItem.feature_set_id == fs.id, FeatureSetItem.artifact_id.is_not(None))).all()]
        emb_keys = [a.embeddings_key for a in db.scalars(select(FeatureArtifact).where(
            FeatureArtifact.id.in_(art_ids))).all() if a.embeddings_key]
        run_ = db.scalars(select(TrainingRun).where(TrainingRun.status == "succeeded",
                                                    TrainingRun.checkpoint_key.is_not(None))).first()
        s2 = {"encoders": {"x": {"created": {"feature_set_id": fs.id, "spec_sha256": fs.spec_sha256}}}}
        s3 = {"runs": [{"run_id": run_.id, "status": "succeeded", "role": "grid", "seed": 0,
                        "identity_sha256": run_.identity_sha256, "checkpoint": {"sha256": run_.checkpoint_sha256}}],
              "feature_sets": {}}
        ck_key = run_.checkpoint_key
    assert emb_keys and store.exists(ck_key)
    assert check("s2", s2) == [] and check("s3", s3) == []
    store.local_path(ck_key).write_bytes(b"not the checkpoint that was evaluated")
    for k in emb_keys:
        store.delete(k)
    p2, p3 = check("s2", s2), check("s3", s3)
    assert p2 and p3, (f"s3 problems {p3} although the checkpoint object no longer matches checkpoint_sha256; "
                       f"s2 problems {p2} although {len(emb_keys)} embeddings object(s) of its feature set are gone")


# =================================================================================================== 3. s6 opt-in


def test_no_command_line_runs_s6_without_the_explicit_opt_in(mod, env, tmp_path):
    f = Fakes(mod)
    assert run(mod, env, tmp_path, f) == 0
    assert run(mod, env, tmp_path, f, "--only", "all") == 0
    assert run(mod, env, tmp_path, f, "--force", "s0,s1,s2,s3,s4,s4b,s5,s7,s8") == 0
    # an interrupted release: the engine release was recorded in the state, the report never written
    state = tmp_path / "reports" / "_state"
    (state / "s6.json").write_text(json.dumps({"release_id": "rel-interrupted", "job_id": "job-x"}))
    (state / "s6.error.json").write_text(json.dumps({"stage": "s6", "at": "now", "error": "KeyboardInterrupt"}))
    assert run(mod, env, tmp_path, f) == 0
    run(mod, env, tmp_path, f, "--only", "s6")
    # explicit flags naming the wrong candidate, even with --force and a justification
    rc = run(mod, env, tmp_path, f, "--only", "s6", "--force", "s6", "--release-test", "run-cand-1",
             "--release-reason", "r", "--justification", "j")
    assert rc == 1
    # selected stages without s6: the release flags alone do nothing
    assert run(mod, env, tmp_path, f, "--only", "s3,s7", "--release-test", "run-cand-1",
               "--release-reason", "r") == 0
    assert "s6" not in f.calls, f.calls
    assert not (tmp_path / "reports" / "s6.json").exists()
    assert (state / "s6.refusals.jsonl").read_text().strip()
    # main() refuses before opening anything
    base = ["--var-dir", str(tmp_path / "never-var"), "--reports-dir", str(tmp_path / "never-reports")]
    assert mod.main([*base, "--force", "all"]) == 2
    assert mod.main([*base, "--only", "s6"]) == 2
    assert mod.main([*base, "--only", "s6", "--force", "s6", "--release-test", "x", "--release-reason", "r"]) == 2
    assert not (tmp_path / "never-var").exists() and not (tmp_path / "never-reports").exists()


def test_a_release_the_database_forgot_still_counts_as_a_look(mod, env, tmp_path):
    """The database is restored from a backup taken before the release (the TestRelease row is gone): s6 turns
    invalid, and an explicit request for the same candidate still needs a justification (the driver's own history
    remembers the look)."""
    f = Fakes(mod)
    assert run(mod, env, tmp_path, f) == 0
    assert run(mod, env, tmp_path, f, "--only", "s6", "--release-test", "run-cand-1", "--release-reason", "r") == 0
    forgot = lambda stage, rep: ["test release rel-1 is not in the database"] if stage == "s6" else []  # noqa: E731
    assert status_of(mod, env, tmp_path, f, artifacts=forgot)["s6"]["status"] == "invalid"
    f.calls.clear()
    rc = run(mod, env, tmp_path, f, "--only", "s6", "--release-test", "run-cand-1", "--release-reason", "r",
             artifacts=forgot)
    assert rc == 1 and f.calls == []
    assert "justification" in (tmp_path / "reports" / "_state" / "s6.refusals.jsonl").read_text()


def test_dry_run_cannot_reach_the_shared_reports_dir_through_a_symlink(mod, tmp_path, monkeypatch):
    for k in ("WB_VAR_DIR", "WB_MIDNIGHT_WEIGHTS", "HF_HUB_OFFLINE", "TRANSFORMERS_OFFLINE"):
        monkeypatch.setenv(k, "unused")
    link = tmp_path / "reports-link"
    link.symlink_to(mod.DEFAULT_REPORTS_DIR, target_is_directory=True)
    args = mod.build_parser().parse_args(["--var-dir", str(tmp_path / "var"), "--dry-run-subset", "4",
                                          "--reports-dir", str(link)])
    with pytest.raises(SystemExit, match="experiments/reports"):
        mod.Driver(args).setup()
    assert not (tmp_path / "var").exists()


def _release_then_reread_then_change_s3(mod, env, tmp_path) -> tuple[Fakes, Path]:
    f = Fakes(mod, real={"s8"})
    f.s6_release_ids = ["rel-1", "rel-1"]  # the forced re-read reads the SAME release again
    assert run(mod, env, tmp_path, f) == 0
    assert run(mod, env, tmp_path, f, "--only", "s6", "--release-test", "run-cand-1", "--release-reason", "r") == 0
    assert run(mod, env, tmp_path, f, "--only", "s6", "--force", "s6", "--release-test", "run-cand-1",
               "--release-reason", "r", "--justification", "audit re-read of the stored result") == 0
    assert run(mod, env, tmp_path, f, "--max-patches", "1024") == 0  # development change: s3 re-run
    return f, tmp_path / "reports"


def test_test_release_audit_is_immutable_and_the_obsolete_release_is_marked(mod, env, tmp_path):
    f, reports = _release_then_reread_then_change_s3(mod, env, tmp_path)
    hist = sorted((reports / "test_release_history").glob("s6.*.json"))
    assert len(hist) == 2
    for p in hist:
        assert p.stat().st_mode & 0o222 == 0, p  # write-once, read-only
    first = hist[0].read_bytes()
    d = make_driver(mod, env, tmp_path, f, "--max-patches", "1024")
    d.record_test_release_history(reports / "s6.json", json.loads((reports / "s6.json").read_text()),
                                  mod.sha256_file(reports / "s6.json"))
    assert sorted((reports / "test_release_history").glob("s6.*.json")) == hist and hist[0].read_bytes() == first
    st = status_of(mod, env, tmp_path, f, "--max-patches", "1024")
    assert st["s6"]["status"] == "obsolete"
    assert f.calls.count("s6") == 2  # the release and the explicit re-read; never the development re-run
    summary = json.loads((reports / "summary.json").read_text())
    assert "test_release" not in summary["key_numbers"]  # an obsolete release contributes no numbers
    cur = [h for h in summary["test_release_history"] if h["is_current_s6"]]
    assert len(cur) == 1 and cur[0]["status"] == "obsolete"
    assert any("earlier candidate" in c for c in summary["caveats"])


def test_release_history_never_claims_a_later_release_that_does_not_exist(mod, exp, env, tmp_path):
    """Audit wording: a forced re-read of the SAME release adds a second history copy. The earlier copy is then
    labelled 'historical (superseded by a later release)' in summary.json and in the evidence package, although no
    later release exists (both copies carry the same test_release_id)."""
    _, reports = _release_then_reread_then_change_s3(mod, env, tmp_path)
    summary = json.loads((reports / "summary.json").read_text())
    rows = summary["test_release_history"]
    assert {r["test_release_id"] for r in rows} == {"rel-1"}
    wrong = [r for r in rows if "later release" in str(r["status"])]
    rc, pkg = export(exp, reports, tmp_path)
    assert rc == 0
    rel = json.loads((pkg / "test_releases.json").read_text())
    wrong_pkg = [r for r in rel["releases"] if "later release" in str(r["status"])]
    assert not wrong and not wrong_pkg, (
        f"summary.json: {[(r['file'], r['test_release_id'], r['status']) for r in wrong]}; evidence: "
        f"{[(r['source'], r['test_release_id'], r['status']) for r in wrong_pkg]}")


# =================================================================================================== 4. summary


def test_s8_refuses_stale_failed_or_dependent_on_missing_stages(mod, env, tmp_path):
    f = Fakes(mod)
    assert run(mod, env, tmp_path, f) == 0
    f.calls.clear()
    assert run(mod, env, tmp_path, f, "--sampling-budget", "1024", "--only", "s8", "--force", "s8") == 1
    state = tmp_path / "reports" / "_state"
    (state / "s7.error.json").write_text(json.dumps({"stage": "s7", "at": "later", "error": "boom"}))
    assert run(mod, env, tmp_path, f, "--only", "s8", "--force", "s8") == 1
    (state / "s7.error.json").unlink()
    assert run(mod, env, tmp_path, f, "--only", "s4", "--force", "s4") == 0  # s5 was computed on the old s4
    f.calls.clear()
    assert run(mod, env, tmp_path, f, "--only", "s8", "--force", "s8") == 1
    assert f.calls == []


# =================================================================================================== 5. evidence


def _grid_runs_from_db(mod, n=4) -> list[str]:
    from sqlalchemy import select

    from dermpath.db import session_scope
    from dermpath.ml.models import TrainingRun

    with session_scope() as db:
        ids = [r.id for r in db.scalars(select(TrainingRun).where(TrainingRun.status == "succeeded")
                                        .order_by(TrainingRun.id)).all()]
    assert len(ids) >= n
    return ids[:n]


def test_exporter_never_counts_an_s3_that_the_driver_holds_invalid(mod, exp, env, tmp_path):
    """s3 writes its report even when a grid run failed; the driver then holds it invalid ('the four-way comparison
    is incomplete') and blocks s4..s8. The exporter must not publish that s3 as evidence."""
    rids = _grid_runs_from_db(mod)
    f = Fakes(mod)
    combos = [(e, h) for e in mod.ENCODERS for h in mod.HEADS]
    f.s3_runs = [{"run_id": rid, "encoder": e, "head": h, "role": "grid", "seed": 0, "fraction": 1.0, "repeat": 0,
                  "status": "failed" if (e, h) == (mod.MIDNIGHT, "abmil") else "succeeded",
                  "error": "MPS backend out of memory" if (e, h) == (mod.MIDNIGHT, "abmil") else None,
                  "oof": {"n_items": 45, "threshold_free": {"auroc": {"value": 0.8, "ci": [0.6, 0.9]}}}}
                 for rid, (e, h) in zip(rids, combos)]
    f.s3_extra = {"feature_sets": {}}  # only the run records are checked against the database here
    assert run(mod, env, tmp_path, f) == 0  # artifact checks stubbed while writing the reports
    reports = tmp_path / "reports"
    d = make_driver(mod, env, tmp_path, f)
    d.artifact_problems = lambda stage, rep: (mod.Driver.artifact_problems(d, stage, rep) if stage == "s3" else [])
    ev = d.evaluate("s3")
    assert ev["status"] == "invalid" and ev["reasons"] and all("did not succeed" in r for r in ev["reasons"]), ev
    rc, pkg = export(exp, reports, tmp_path)
    assert rc == 0
    res = json.loads((pkg / "results.json").read_text())
    exc = json.loads((pkg / "exclusions.json").read_text())
    assert "s3" not in res["included_stages"] and "development_comparison" not in res, (
        f"the evidence package counts s3 as valid evidence (included_stages={res['included_stages']}; "
        f"offline status {exc['stages']['s3']['status']}) while the driver holds it invalid: {ev['reasons'][:1]}")


def test_exporter_tokenises_the_identifiers_of_a_real_abmil_run_record(mod, exp, env, ids, tmp_path):
    """A REAL dev_cv ABMIL run's record (Driver.run_record) carries training_summary.inner_holdout (its key contains
    'inner'), including holdout_bag_ids, and the exporter writes training_summary verbatim into identities.json.
    With the per-slide tables every real s2/s3 report carries, those ids are known to the sanitizer and tokenised;
    no slide id, coded patient id or patient code of the cohort reaches the package."""
    from dermpath.auth import Actor
    from dermpath.db import session_scope
    from dermpath.ml.service import create_experiment
    from dermpath.models import DatasetVersion, Project
    from test_ml_support import CID, FAST, LEAD, SYNTH, cohort, run_jobs

    lead = Actor(LEAD, "research_lead", "Priya Navarro")
    dv_id = cohort(ids)["dataset_version_id"]
    with session_scope() as db:
        run_, _ = create_experiment(db, lead, db.get(Project, CID), dataset_version_id=dv_id, encoder_id=SYNTH,
                                    head="abmil", params={**FAST, "max_epochs": 4, "patience": 2, "cv_folds": 3,
                                                          "min_threshold_evidence": 5},
                                    seed=0, name=None, evaluation_protocol="dev_cv")
        rid = run_.id
        manifest = db.get(DatasetVersion, dv_id).manifest_json
    assert [o.status for o in run_jobs()] == ["succeeded"]
    f = Fakes(mod)
    d = make_driver(mod, env, tmp_path, f)
    d.authorize = lambda db, perm: None
    rec = d.run_record(rid)
    rec.update(role="grid", fraction=1.0, repeat=0)
    held = ((rec.get("training_summary") or {}).get("inner_holdout") or {}).get("holdout_bag_ids") or []
    assert held, "precondition: the record carries per-bag ids (inner_holdout.holdout_bag_ids)"
    slides = sorted({it["slide_id"] for it in manifest["items"]})
    coded = sorted({it["coded_patient_id"] for it in manifest["items"]})
    codes = sorted({it["patient_code"] for it in manifest["items"] if it.get("patient_code")})
    # What real reports carry around it: per-slide tables (slide ids) and s7 errors (patient codes).
    f.s2_per_slide = [{"slide_id": it["slide_id"], "status": "done"} for it in manifest["items"]]
    f.s7_errors = [{"bag_id": it["slide_id"], "patient_code": it.get("patient_code"), "label": 1}
                   for it in manifest["items"][:5]]
    f.s3_runs = [rec]
    assert run(mod, env, tmp_path, f) == 0
    rc, pkg = export(exp, tmp_path / "reports", tmp_path)
    assert rc == 0
    text = all_text(pkg)
    leaked = [x for x in slides + coded + codes if x in text]
    assert not leaked, leaked[:5]
    ident = json.loads((pkg / "identities.json").read_text())
    tokens = ident["runs"][0]["training_summary"]["inner_holdout"]["holdout_bag_ids"]
    assert len(tokens) == len(held) and all(str(t).startswith("id:") for t in tokens)


def test_exporter_scrubs_identifiers_nested_anywhere_and_never_copies_bulky_artifacts(mod, exp, env, tmp_path):
    f = Fakes(mod)
    f.s3_extra = {"skipped_work": [{"what": "s3 run", "reason": f"patient {COBRA_CODE} has no tissue",
                                    "details": {"case": COBRA_ACCESSION, "file": SLIDE_FILE}}]}
    f.s3_runs = [{"run_id": f"run-{e}-{h}", "encoder": e, "head": h, "role": "grid", "status": "succeeded", "seed": 0,
                  "fraction": 1.0, "repeat": 0,
                  "training_summary": {"inner_holdout": {"note": f"held out {COBRA_CODE}",
                                                         "codes": [COBRA_ACCESSION]}}}
                 for e in mod.ENCODERS for h in mod.HEADS]
    assert run(mod, env, tmp_path, f) == 0
    reports = tmp_path / "reports"
    (reports / "_state" / "s6.refusals.jsonl").write_text(json.dumps(
        {"at": "now", "message": f"refused: candidate trained on {SLIDE_FILE} of {COBRA_CODE}"}) + "\n")
    (reports / "_state" / "s5.error.json").write_text(json.dumps(
        {"stage": "s5", "at": "now", "error": f"OpenSlideError: {Path.home()}/cobra/{SLIDE_FILE} ({COBRA_CODE})"}))
    (reports / "_state" / "embeddings.npy").write_bytes(b"\x93NUMPY" + b"\0" * 4096)
    (reports / "bulky.bin").write_bytes(os.urandom(3 * 1024 * 1024))
    rc, pkg = export(exp, reports, tmp_path)
    assert rc == 0
    text = all_text(pkg)
    for needle in (COBRA_CODE, COBRA_ACCESSION, SLIDE_FILE, "RUMC-B19", str(Path.home())):
        assert needle not in text, needle
    for p in pkg.rglob("*"):
        assert p.suffix in (".json", ".md") and p.stat().st_size < 2 * 1024 * 1024, p
    art = json.loads((pkg / "artifacts_index.json").read_text())
    assert {a["path"] for a in art["local_reports"]} >= {"bulky.bin", "_state/embeddings.npy"}  # indexed only
    assert not any(a["path"].endswith("evidence_salt") for a in art["local_reports"])
    assert (tmp_path / "salt").read_bytes() not in (pkg / "index.json").read_bytes()


# =================================================================================================== 6. folds / s4b dev-only


def test_real_runs_share_folds_across_heads_seeds_and_subsets_and_dev_predictions_are_development_only(
        mod, env, ids, tmp_path):
    from dermpath.auth import Actor
    from dermpath.db import session_scope
    from dermpath.ml.service import create_experiment
    from dermpath.models import DatasetVersion, Project
    from test_ml_support import CID, FAST, LEAD, SYNTH, cohort, run_jobs

    lead = Actor(LEAD, "research_lead", "Priya Navarro")
    dv_id = cohort(ids)["dataset_version_id"]
    base = {**FAST, "max_epochs": 4, "patience": 2, "cv_folds": 3, "min_threshold_evidence": 5}
    plan = [("meanpool_logreg", 0, {}), ("abmil", 1, {}), ("meanpool_logreg", 2, {}),
            ("meanpool_logreg", 0, {"train_patient_fraction": 0.5, "subset_repeat": 0})]
    rids = []
    with session_scope() as db:
        for head, seed, extra in plan:
            run_, _ = create_experiment(db, lead, db.get(Project, CID), dataset_version_id=dv_id, encoder_id=SYNTH,
                                        head=head, params={**base, **extra}, seed=seed, name=None,
                                        evaluation_protocol="dev_cv")
            rids.append(run_.id)
        manifest = db.get(DatasetVersion, dv_id).manifest_json
    assert [o.status for o in run_jobs()] == ["succeeded"] * len(plan)
    d = make_driver(mod, env, tmp_path, Fakes(mod))
    d.authorize = lambda db, perm: None
    recs = [d.run_record(r) for r in rids]
    fc = mod.fold_consistency(recs)
    assert fc["identical"] is True and fc["runs"] == len(plan), fc
    assert len({r["n_folds_recorded"] for r in recs}) == 1
    dev = {it["slide_id"] for it in manifest["items"] if it.get("split") in ("train", "val")}
    test = {it["slide_id"] for it in manifest["items"] if it.get("split") == "test"}
    assert test, "precondition: the cohort has a test split"
    for rec in recs:
        assert set(rec["prediction_splits"]) <= {"train", "oof"} and not rec["test_items_used"], rec["run_id"]
    for r in rids:
        rows = d.dev_predictions(r)
        assert rows and {x["split"] for x in rows} == {"oof"}
        assert {x["bag_id"] for x in rows} <= dev and not ({x["bag_id"] for x in rows} & test)
    changes = mod.prediction_changes(d.dev_predictions(rids[0]), d.dev_predictions(rids[2]))
    assert changes["paired_bags"] > 0
    poisoned = d.dev_predictions(rids[2]) + [{"bag_id": sorted(test)[0], "patient": "x", "label": 1, "score": 0.5,
                                              "threshold": 0.5, "split": "test"}]
    with pytest.raises(ValueError):
        mod.prediction_changes(d.dev_predictions(rids[0]), poisoned)
    cmp = d.compare({"meanpool": rids[0], "abmil": rids[1]})
    assert cmp["status"] == "ok", cmp
    with pytest.raises(mod.StageError):
        d.compare({"a": rids[0], "b": rids[2]}, split="test")


# =================================================================================================== 7. partial failures


def test_an_s4_whose_arms_crashed_is_not_reused_as_valid(mod, env, tmp_path, monkeypatch):
    """A transient crash in an ablation arm (here: every arm that needs extraction, and the precision study) is
    written into s4.json as status 'error'. The real artifact checks find nothing to verify, so s4 is 'valid' and
    a default run never retries it; s8 summarises it. Compare s3, where a grid run that did not succeed makes the
    stage invalid.

    Test correction (fix round): the first run asserted ``rc == 0``, i.e. that the run continued past the crashed s4
    into s5..s8, which is the very symptom reported ("s5 and s8 build on it"). With the real artifact check on s4
    the run now stops at s5 (rc 1: its optional upstream s4 is invalid) and nothing downstream is built on it."""
    import dermpath.ml.evaluation as ev

    monkeypatch.setattr(ev, "create_family", lambda *a, **k: SimpleNamespace(id="fam-s4"))
    monkeypatch.setattr(ev, "add_family_member", lambda *a, **k: True)

    def crash(*_a, **_k):
        raise RuntimeError("MPS backend out of memory (transient)")

    def configure(d):
        d.authorize = lambda db, perm: None
        d.manifest = lambda dv_id: {"items": []}
        d.supervised_set = crash
        d.precision_study = crash
        d.artifact_problems = lambda stage, rep: (mod.Driver.artifact_problems(d, stage, rep)
                                                  if stage == "s4" else [])
        return d

    f = Fakes(mod, real={"s4"})
    d = configure(make_driver(mod, env, tmp_path, f))
    assert d.run() == 1  # stops at s5: nothing downstream is built on the crashed s4 (see the docstring)
    assert not {"s5", "s7", "s8"} & set(f.calls), f.calls
    rep = json.loads((tmp_path / "reports" / "s4.json").read_text())
    assert rep["arm_status"]["a_sampling_uniform"] == {e: "error" for e in mod.ENCODERS}
    assert rep["precision"]["status"] == "error"
    d2 = configure(make_driver(mod, env, tmp_path, f))
    status = d2.evaluate("s4")["status"]
    assert status != "valid", ("s4 records crashed arms (status 'error', no result) yet is 'valid': it is reused as "
                               "is and never retried by a default run")


# ======================================================================================== 8. fix-round regressions


def test_report_content_rules_are_shared_and_keep_legitimate_results(mod):
    """The database-free content rules: crashed or unfinished s4 / s4b work is a problem; engine refusals
    (blocked), recorded-but-never-counted arms (invalid_for_cv_comparison) and excluded work (not_run) are results."""
    ok = {"arms": {"a": {"x": {"status": "succeeded", "run": {"run_id": "r", "status": "succeeded"}},
                         "y": {"status": "blocked", "code": "fold_unsafe_preprocessing"}},
                   "b": {"x": {"status": "invalid_for_cv_comparison", "run": {"run_id": "r2", "status": "succeeded"}}}},
          "precision": {"candidates": {}, "downstream_fp16": {"status": "not_run"}}}
    assert mod.report_content_problems("s4", ok) == []
    for bad in ({"status": "error", "error": "boom"}, {"status": "feature_set_failed", "error": "x"},
                {"status": "failed", "run": {"run_id": "r", "status": "failed"}}, {"status": None}, "not a dict",
                {"status": "succeeded", "run": {"run_id": "r", "status": "failed"}}):
        assert mod.report_content_problems("s4", {"arms": {"a": {"x": bad}}}), bad
        assert mod.report_content_problems("s4b", {"encoders": {"x": bad}}), bad
    assert mod.report_content_problems("s4b", {"encoders": {"x": {"status": "not_run"}}}) == []
    assert mod.report_content_problems("s4", {"arms": {}, "precision": {"status": "error", "error": "oom"}})
    assert mod.report_content_problems("s4", {"arms": {}, "precision": {"downstream_fp16": {"status": "error"}}})
    assert mod.report_content_problems("s3", {"runs": None}) == ["the report has no run list"]
    assert mod.report_content_problems("s3", {"runs": [{"run_id": "r", "role": "learning_curve",
                                                        "status": "failed"}]}) == []
    assert mod.report_content_problems("s0", {}) == [] and mod.report_content_problems("s3", []) != []


def test_release_history_labels_by_release_id(mod):
    rows = [{"sha256": "a", "test_release_id": "rel-1", "release_number": 1, "finished_at": "t1"},
            {"sha256": "b", "test_release_id": "rel-2", "release_number": 2, "finished_at": "t2"},
            {"sha256": "c", "test_release_id": "rel-2", "release_number": 2, "finished_at": "t3"}]
    out = {r["sha256"]: r["status"] for r in mod.release_history_labels([dict(r) for r in rows], "c", "valid")}
    assert out["c"] == "valid"
    assert out["b"].startswith("earlier record of the current release rel-2") and "later release" not in out["b"]
    assert out["a"] == "historical (superseded by a later release)"
    # the current report is an audited re-read of the EARLIER release: rel-2 is not "superseded by a later release"
    out = {r["sha256"]: r["status"] for r in mod.release_history_labels([dict(r) for r in rows[:2]], "a", "obsolete")}
    assert out["a"] == "obsolete" and "later release" not in out["b"]
    out = {r["sha256"]: r["status"] for r in mod.release_history_labels([dict(r) for r in rows[:2]], None, None)}
    assert out["a"] == "historical (superseded by a later release)" and "later release" not in out["b"]


def test_a_failed_s4_or_s4b_run_is_retried_on_resume_but_a_fold_safety_refusal_is_not(mod, env, tmp_path):
    """An invalid s4 / s4b re-runs from its state: a run that failed or is gone is replaced (recorded, nothing
    deleted), as s3 does; a succeeded run is kept; a failure that is the engine's fold-safety refusal is a 'blocked'
    result and stays."""
    rid = _grid_runs_from_db(mod, 1)[0]
    d = make_driver(mod, env, tmp_path, Fakes(mod))
    d.authorize = lambda db, perm: None
    d.skipped = []
    st = {"runs": {"ok": rid, "gone": "no-such-run"}}
    d.retry_unfinished_run("s4b", st, "ok")
    d.retry_unfinished_run("s4b", st, "gone")
    assert st["runs"] == {"ok": rid} and [x["run_id"] for x in st["replaced_runs"]] == ["no-such-run"]
    assert json.loads((d.state_dir / "s4b.json").read_text())["runs"] == {"ok": rid}
    assert [x["what"] for x in d.skipped] == ["s4b run gone"]
    rec = {"run_id": "run-m", "status": "failed",
           "error": "PermanentJobError: fold_unsafe_preprocessing: the stain reference saw held-out folds"}
    d.run_record = lambda r: dict(rec)
    st = {"runs": {"m": "run-m"}}
    d.retry_unfinished_run("s4", st, "m", keep_fold_unsafe=True)
    assert st["runs"] == {"m": "run-m"}
    rec["error"] = "RuntimeError: MPS backend out of memory"
    d.retry_unfinished_run("s4", st, "m", keep_fold_unsafe=True)
    assert st["runs"] == {} and st["replaced_runs"][0]["status"] == "failed"


def test_exporter_excludes_crashed_s4_work_and_what_the_driver_snapshot_holds_invalid(mod, exp, env, tmp_path):
    f = Fakes(mod)
    assert run(mod, env, tmp_path, f) == 0
    reports = tmp_path / "reports"
    rc, pkg = export(exp, reports, tmp_path)
    assert rc == 0 and "s2" in json.loads((pkg / "results.json").read_text())["included_stages"]
    # (1) the driver's last snapshot holds s2 invalid (a database / object-store problem the exporter cannot see):
    # excluded for THESE bytes, with its dependents
    snap_p = reports / "_state" / "status.json"
    snap = json.loads(snap_p.read_text())
    assert snap["stages"]["s2"]["report_sha256"] == mod.sha256_file(reports / "s2.json")
    snap["stages"]["s2"].update(status="invalid", reasons=["artifact: s2 x: feature set fs: 8 of 8 pinned artifact(s) "
                                                           "are missing"])
    snap_p.write_text(json.dumps(snap))
    rc, pkg = export(exp, reports, tmp_path, "--force")
    res = json.loads((pkg / "results.json").read_text())
    exc = json.loads((pkg / "exclusions.json").read_text())
    assert rc == 0 and "s2" not in res["included_stages"] and "s3" not in res["included_stages"], res
    assert exc["stages"]["s2"]["status"] == "invalid"
    # ... but a verdict on OTHER bytes (an older report) never excludes the current one
    snap["stages"]["s2"]["report_sha256"] = "0" * 64
    snap_p.write_text(json.dumps(snap))
    rc, pkg = export(exp, reports, tmp_path, "--force")
    assert "s2" in json.loads((pkg / "results.json").read_text())["included_stages"]
    # (2) an s4 that records crashed arms is never evidence in the package
    f2 = Fakes(mod)
    f2_body = f2._body

    def s4_crashed(stage):
        b = f2_body(stage)
        if stage == "s4":
            b["arms"] = {"a_sampling_uniform": {e: {"status": "error", "error": "RuntimeError: oom"}
                                                for e in mod.ENCODERS}}
        return b

    f2._body = s4_crashed
    tmp2 = tmp_path / "second"
    tmp2.mkdir()
    assert run(mod, env, tmp2, f2) == 0  # artifact checks stubbed while writing the reports
    rc, pkg = export(exp, tmp2 / "reports", tmp2)
    res = json.loads((pkg / "results.json").read_text())
    exc = json.loads((pkg / "exclusions.json").read_text())
    assert rc == 0 and "s4" not in res["included_stages"] and exc["stages"]["s4"]["status"] == "invalid", res
