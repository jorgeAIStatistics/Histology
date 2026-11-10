"""Evidence helper scripts (``scripts/sensitivity_near_duplicates.py``, ``scripts/measure_bundle_inference.py``).
RESEARCH USE ONLY.

The scripts run against the real shared database in the experiment workflow; these tests cover the parts that must
hold anywhere: the sensitivity script cannot write to the database it reads, both scripts refuse missing inputs
before touching any database, and the measurement reads the cold-extraction record of the right slide."""

from __future__ import annotations

import importlib.util
import sqlite3
import sys
from pathlib import Path

import pytest
from sqlalchemy import text
from sqlalchemy.exc import OperationalError

SCRIPTS = Path(__file__).resolve().parents[2] / "scripts"


def _load(name: str, file: str):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / file)
    m = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = m
    spec.loader.exec_module(m)
    return m


@pytest.fixture(scope="module")
def sens():
    m = _load("sensitivity_near_duplicates_under_test", "sensitivity_near_duplicates.py")
    yield m
    sys.modules.pop("sensitivity_near_duplicates_under_test", None)


@pytest.fixture(scope="module")
def meas():
    m = _load("measure_bundle_inference_under_test", "measure_bundle_inference.py")
    yield m
    sys.modules.pop("measure_bundle_inference_under_test", None)


def test_sensitivity_opens_the_database_read_only(sens, tmp_path):
    db = tmp_path / "dir with space" / "copy.db"
    db.parent.mkdir()
    con = sqlite3.connect(db)
    con.execute("create table t (x integer)")
    con.execute("insert into t values (1)")
    con.commit()
    con.close()
    before = db.read_bytes()
    engine = sens.open_readonly(db)
    with engine.connect() as c:
        assert c.execute(text("select count(*) from t")).scalar() == 1
        with pytest.raises(OperationalError):
            c.execute(text("insert into t values (2)"))
    engine.dispose()
    assert db.read_bytes() == before


def test_sensitivity_refuses_missing_inputs(sens, tmp_path):
    assert sens.main(["--db", str(tmp_path / "none.db"), "--s3-report", str(tmp_path / "s3.json"),
                      "--out", str(tmp_path / "out.json")]) == 2
    assert not (tmp_path / "out.json").exists()


def test_sensitivity_helpers(sens):
    assert sens.stats([1.0, None, 3.0]) == {"n": 2, "mean": 2.0, "min": 1.0, "max": 3.0}
    assert sens.close([0.1, 0.2], [0.1, 0.2 + 1e-15]) and not sens.close([0.1], [0.1, 0.2])
    d = [{"a": "x", "b": "y", "auroc": {"value": 0.1, "ci": [0.0, 0.2]}}]
    assert sens.same_deltas(d, [{"a": "x", "b": "y", "auroc": {"value": 0.1, "ci": [0.0, 0.2]}}])
    assert not sens.same_deltas(d, [{"a": "x", "b": "y", "auroc": {"value": 0.1, "ci": [0.0, 0.3]}}])


def test_measurement_refuses_missing_reports(meas, tmp_path):
    assert meas.main(["--reports-dir", str(tmp_path), "--out", str(tmp_path / "m.json")]) == 2
    assert not (tmp_path / "m.json").exists()


def test_measurement_reads_the_cold_record_of_the_selected_slide(meas):
    rep = {"encoders": {"midnight-12k": {"feature_set": {"per_slide": [
        {"slide_id": "a", "total_seconds": 50.0, "cache_hit": False, "n_patches": 256},
        {"slide_id": "b", "total_seconds": 70.0, "cache_hit": False, "n_patches": 256}]}}}}
    rec = meas.per_slide(rep, ("encoders", "midnight-12k", "feature_set"), "b")
    assert rec["total_seconds"] == 70.0 and rec["cache_hit"] is False
    assert meas.per_slide(rep, ("encoders", "midnight-12k", "feature_set"), "c") is None
    assert meas.per_slide(None, ("encoders",), "a") is None
