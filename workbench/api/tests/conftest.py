"""Test fixtures.

A seeded template var directory (SQLite DB + private object store) is built once per test
session; every test gets its own copy, so tests are isolated and fast. All data is the
fictional demo seed plus the public CC0 fixture.

Environment isolation: every ``WB_ML_*``, ``WB_UNI_*``, ``WB_RESNET18_*``, ``WB_HIBOU_*``
and ``WB_MIDNIGHT_*`` variable and ``WB_CODE_REVISION`` is removed for the whole session
(at import, before any ``dermpath`` module reads it, and again by an autouse session
fixture that restores the developer's values at the end). Tests opt in explicitly with
``monkeypatch.setenv``.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import sys
from dataclasses import replace
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

ISOLATED_ENV_PREFIXES = ("WB_ML_", "WB_UNI_", "WB_RESNET18_", "WB_HIBOU_", "WB_MIDNIGHT_")
ISOLATED_ENV_NAMES = ("WB_CODE_REVISION",)


def isolated_env_names(environ=None) -> list[str]:
    environ = os.environ if environ is None else environ
    return sorted(k for k in environ if k.startswith(ISOLATED_ENV_PREFIXES) or k in ISOLATED_ENV_NAMES)


# Cleared at import: dermpath.ml.artifacts captures WB_CODE_REVISION when it is imported.
_DEVELOPER_ENV = {k: os.environ.pop(k) for k in isolated_env_names()}

API_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(API_DIR))
sys.path.insert(0, str(Path(__file__).resolve().parent / "helpers"))

from dermpath.config import FIXTURES_DIR, Settings, set_settings  # noqa: E402
from dermpath.db import reset_engine  # noqa: E402

CMU = FIXTURES_DIR / "CMU-1-Small-Region.svs"
TEST_SECRET = "test-secret-" + "x" * 40


def make_settings(var_dir: Path, **overrides) -> Settings:
    base = Settings(
        mode="demo",
        var_dir=var_dir,
        secret=TEST_SECRET,
        upload_chunk_bytes=256 * 1024,
        max_upload_bytes=64 * 1024 * 1024,
        job_lease_seconds=30,
        job_backoff_base_seconds=0.0,
        auto_seed=False,
        cors_origins=("http://localhost:3000",),
    )
    return replace(base, **overrides)


@pytest.fixture(scope="session", autouse=True)
def _isolated_wb_env():
    """Session-wide: no developer encoder/ML/code-revision variable reaches any test."""
    with pytest.MonkeyPatch.context() as mp:
        for name in isolated_env_names():
            mp.delenv(name, raising=False)
        yield
    os.environ.update(_DEVELOPER_ENV)


@pytest.fixture(scope="session")
def template_dir(tmp_path_factory, _isolated_wb_env) -> Path:
    from dermpath.seed import seed

    d = tmp_path_factory.mktemp("template-var")
    set_settings(make_settings(d))
    summary = seed()
    (d / "seed-summary.json").write_text(json.dumps(summary))
    reset_engine()  # closes connections and checkpoints the WAL before copying
    set_settings(None)
    return d


@pytest.fixture()
def env(template_dir, tmp_path):
    """Fresh copy of the seeded var dir; settings point at it. Yields (settings, ids)."""
    var = tmp_path / "var"
    shutil.copytree(template_dir, var)
    settings = make_settings(var)
    set_settings(settings)
    ids = json.loads((var / "seed-summary.json").read_text())
    yield settings, ids
    reset_engine()
    set_settings(None)


@pytest.fixture()
def app(env):
    from dermpath.main import create_app

    settings, _ = env
    return create_app(settings)


@pytest.fixture()
def ids(env):
    return env[1]


class Clients:
    """Logged-in TestClients by user id (each client keeps its own cookie jar)."""

    def __init__(self, app):
        self.app = app
        self._clients: dict[str, TestClient] = {}

    def anon(self) -> TestClient:
        c = TestClient(self.app)
        c.__enter__()
        self._clients[f"anon-{len(self._clients)}"] = c
        return c

    def __call__(self, user_id: str) -> TestClient:
        if user_id not in self._clients:
            c = TestClient(self.app)
            c.__enter__()
            r = c.post("/api/v1/auth/demo-login", json={"userId": user_id})
            assert r.status_code == 200, r.text
            self._clients[user_id] = c
        return self._clients[user_id]

    def close(self):
        for c in self._clients.values():
            c.__exit__(None, None, None)


@pytest.fixture()
def clients(app):
    cs = Clients(app)
    yield cs
    cs.close()


@pytest.fixture()
def run_worker():
    from dermpath.jobs.worker import Worker

    def _run(max_jobs: int = 100):
        return Worker("test-worker").run_until_idle(max_jobs=max_jobs)

    return _run


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def upload_bytes(client: TestClient, project_id: str, data: bytes, filename: str, *, chunk_size: int | None = None,
                 extra: dict | None = None) -> dict:
    """Full happy-path upload helper. Returns the completion response JSON."""
    body = {"filename": filename, "size": len(data), "sha256": sha256_bytes(data), "provenance": "public_cc0"}
    body.update(extra or {})
    r = client.post(f"/api/v1/projects/{project_id}/uploads", json=body)
    assert r.status_code in (200, 201), r.text
    up = r.json()
    cs = up["chunk_size"]
    for i in range(up["next_chunk_index"], up["total_chunks"]):
        chunk = data[i * cs:(i + 1) * cs]
        rr = client.put(f"/api/v1/uploads/{up['upload_id']}/chunks/{i}", content=chunk,
                        headers={"X-Chunk-SHA256": sha256_bytes(chunk)})
        assert rr.status_code == 200, rr.text
    rc = client.post(f"/api/v1/uploads/{up['upload_id']}/complete")
    return {"status_code": rc.status_code, **rc.json()}


@pytest.fixture()
def cmu_bytes() -> bytes:
    return CMU.read_bytes()


@pytest.fixture()
def cmu_variant(cmu_bytes) -> bytes:
    """CMU fixture plus trailing padding: still a valid SVS (TIFF ignores trailing bytes),
    but a different sha256, so it is not a duplicate of the seeded copy."""
    return cmu_bytes + b"\x00" * 4096 + b"dermpath-test-padding"
