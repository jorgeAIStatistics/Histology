"""``python -m dermpath.ml.cli``: research-use banner, local database only (``--var-dir`` /
``WB_VAR_DIR``), no network, JSON output and exit codes."""

from __future__ import annotations

import json
import socket
import subprocess
import sys
import urllib.request

import pytest

from test_ml_support import CID, FAST, SYNTH, cohort

API_DIR = __import__("pathlib").Path(__file__).resolve().parent.parent
COHORT_NAME = "Synthetic pipeline-test cohort (no images, no histology)"


@pytest.fixture()
def offline(monkeypatch):
    attempts: list = []

    def refuse(*args, **kwargs):
        attempts.append(args[1:] if args else kwargs)
        raise OSError("network disabled in this test")

    monkeypatch.setattr(socket.socket, "connect", refuse)
    monkeypatch.setattr(socket.socket, "connect_ex", refuse)
    monkeypatch.setattr(socket, "create_connection", lambda *a, **k: refuse(None, *a))
    monkeypatch.setattr(urllib.request, "urlopen", lambda *a, **k: refuse(None, *a))
    return attempts


def _cli(argv, capsys):
    from dermpath.ml.cli import main

    code = main(argv)
    out = capsys.readouterr()
    return code, out.out, out.err


def test_describe_encoders(env, capsys, offline):
    code, out, err = _cli(["describe-encoders", "--json"], capsys)
    assert code == 0 and "research use only" in err
    items = {e["id"]: e for e in json.loads(out)["items"]}
    assert items[SYNTH]["status"] == "available" and "midnight-12k" in items
    code, out, _ = _cli(["describe-encoders"], capsys)
    assert code == 0 and SYNTH in out
    assert offline == []


def test_run_config_trains_one_experiment(env, ids, tmp_path, capsys, offline):
    cfg = {"project_id": CID, "dataset": {"name": COHORT_NAME}, "encoder_id": SYNTH, "head": "meanpool_logreg",
           "seed": 13, "params": FAST, "evaluation_protocol": "holdout", "_comment": "ignored"}
    path = tmp_path / "run.json"
    path.write_text(json.dumps(cfg))
    code, out, err = _cli(["run-config", str(path)], capsys)
    assert code == 0, err
    run = json.loads(out)
    assert run["status"] == "succeeded" and run["execution_mode"] == "synthetic_pipeline_test"
    assert run["dataset_version_id"] == cohort(ids)["dataset_version_id"] and run["created_by"] == "system:cli"
    assert run["threshold"]["selected_on"] == "val" and offline == []


def test_feature_set_create_is_idempotent_and_status_reports_coverage(env, ids, tmp_path, capsys):
    from dermpath.db import session_scope
    from dermpath.ml.models import TrainingRun

    rid = cohort(ids)["runs"]["meanpool_logreg"]
    with session_scope() as db:
        seeded = db.get(TrainingRun, rid)
        fs_id, params = seeded.feature_set_id, seeded.params_json
    cfg = {"project_id": CID, "dataset": {"name": COHORT_NAME}, "encoder_id": SYNTH,
           "params": {k: params[k] for k in ("pixel_mode", "max_patches_per_slide", "synthetic_dim",
                                              "synthetic_signal_strength", "synthetic_signal_fraction")}}
    path = tmp_path / "fs.json"
    path.write_text(json.dumps(cfg))
    code, out, err = _cli(["feature-set", "create", str(path)], capsys)
    assert code == 0, err
    assert json.loads(out)["id"] == fs_id  # the same specification: the existing set is reused
    code, out, _ = _cli(["feature-set", "status", fs_id], capsys)
    body = json.loads(out)
    assert code == 0 and body["status"] == "ready" and body["counts"]["done"] == body["counts"]["slides"] > 0


def test_benchmark_command_writes_a_report(env, ids, tmp_path, capsys):
    cfg = {"name": "cli smoke (PIPELINE TEST)", "project_id": CID, "dataset": {"name": COHORT_NAME},
           "execution_mode": "synthetic_pipeline_test", "evaluation_protocol": "holdout", "encoders": [SYNTH],
           "heads": ["meanpool_logreg"], "params": {"pixel_mode": "none", "max_patches_per_slide": 16, "n_boot": 50},
           "bootstrap": {"n_boot": 50, "seed": 3}}
    path = tmp_path / "bench.json"
    path.write_text(json.dumps(cfg))
    report = tmp_path / "out" / "report.json"
    code, out, err = _cli(["benchmark", str(path), "--report", str(report)], capsys)
    assert code == 0, err
    summary = json.loads(out)
    assert summary["report_path"] == str(report) and report.is_file()
    assert [r["status"] for r in summary["runs"]] == ["succeeded"] and "No winner" in summary["selection_note"]


@pytest.mark.parametrize("argv, needle", [
    (["run-config", "/nonexistent/config.json"], "config file not found"),
    (["benchmark", "/nonexistent/config.json"], "cannot read"),
    (["feature-set", "status", "no-such-feature-set"], "does not exist"),
])
def test_usage_errors_exit_2(env, capsys, argv, needle):
    code, _, err = _cli(argv, capsys)
    assert code == 2 and needle in err


def test_unknown_config_keys_and_commands_are_refused(env, tmp_path, capsys):
    path = tmp_path / "bad.json"
    path.write_text(json.dumps({"project_id": CID, "encoder_id": SYNTH, "head": "abmil", "dataset": "latest_frozen",
                                "learning_rate": 1}))
    code, _, err = _cli(["run-config", str(path)], capsys)
    assert code == 2 and "unknown run-config key" in err
    code, _, err = _cli(["frobnicate"], capsys)
    assert code == 2 and "research use only" in err
    code, _, err = _cli([], capsys)
    assert code == 2 and "research use only" in err


def test_cli_uses_the_given_var_dir_in_a_fresh_process(env):
    """A separate interpreter operating on this test's copied database via --var-dir."""
    settings, _ = env
    out = subprocess.run([sys.executable, "-m", "dermpath.ml.cli", "--var-dir", str(settings.var_dir),
                          "describe-encoders", "--json"], cwd=API_DIR, capture_output=True, text=True, timeout=120)
    assert out.returncode == 0, out.stderr
    assert "research use only" in out.stderr and json.loads(out.stdout)["items"]
