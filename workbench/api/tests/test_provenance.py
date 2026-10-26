"""Run provenance (design §10): code identity, dependency versions, extraction environment."""

from __future__ import annotations

import os
import shutil
import subprocess

import pytest

from dermpath.ml import artifacts as A

GIT = shutil.which("git")


def _package(root, files: dict[str, str]):
    pkg = root / "pkgx"
    for rel, body in files.items():
        p = pkg / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(body)
    return pkg


FILES = {"__init__.py": "", "core.py": "X = 1\n", "sub/__init__.py": "", "sub/model.py": "def f():\n    return 2\n"}


def test_code_tree_sha_is_stable_and_order_independent(tmp_path):
    a = _package(tmp_path / "a", FILES)
    b = _package(tmp_path / "b", dict(reversed(list(FILES.items()))))
    (b / "__pycache__").mkdir()
    (b / "__pycache__" / "core.cpython-314.pyc").write_bytes(b"compiled")
    (b / "notes.txt").write_text("not code")
    ia, fa = A.compute_code_identity(a, environ={}, use_git=False)
    ib, fb = A.compute_code_identity(b, environ={}, use_git=False)
    assert fa == fb and set(fa) == {"pkgx/__init__.py", "pkgx/core.py", "pkgx/sub/__init__.py", "pkgx/sub/model.py"}
    assert ia["code_tree_sha256"] == ib["code_tree_sha256"] == A.code_tree_sha256(fa)
    assert ia == A.compute_code_identity(a, environ={}, use_git=False)[0]  # stable across calls
    assert ia["code_revision"] == "unknown" and ia["code_revision_source"] == "unknown" and ia["dirty"] is None


@pytest.mark.parametrize("change", ["edit", "add", "rename", "delete"])
def test_code_tree_sha_changes_with_any_code_change(tmp_path, change):
    pkg = _package(tmp_path, FILES)
    before = A.compute_code_identity(pkg, environ={}, use_git=False)[0]["code_tree_sha256"]
    if change == "edit":
        (pkg / "sub" / "model.py").write_text("def f():\n    return 3\n")
    elif change == "add":
        (pkg / "extra.py").write_text("")
    elif change == "rename":
        (pkg / "core.py").rename(pkg / "core2.py")
    else:
        (pkg / "core.py").unlink()
    after = A.compute_code_identity(pkg, environ={}, use_git=False)[0]["code_tree_sha256"]
    assert after != before


def test_code_revision_env_override(tmp_path):
    pkg = _package(tmp_path, FILES)
    ident, _ = A.compute_code_identity(pkg, environ={A.CODE_REVISION_ENV: "release-2026.10"}, use_git=False)
    assert ident["code_revision"] == "release-2026.10" and ident["code_revision_source"] == "env"


def _git(cwd, *args):
    subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "core.hooksPath=/dev/null",
                    "-c", "commit.gpgsign=false", *args], cwd=cwd, check=True, capture_output=True)


@pytest.mark.skipif(GIT is None, reason="git is not installed")
def test_git_dirty_trees_get_distinct_identities(tmp_path):
    pkg = _package(tmp_path / "repo", FILES)
    _git(pkg.parent, "init", "-q")
    _git(pkg.parent, "add", ".")
    _git(pkg.parent, "commit", "-q", "-m", "init")
    clean, _ = A.compute_code_identity(pkg, environ={})
    head = subprocess.run(["git", "rev-parse", "HEAD"], cwd=pkg, capture_output=True, text=True).stdout.strip()
    assert clean["code_revision"] == head and clean["code_revision_source"] == "git"
    assert clean["dirty"] is False and clean["dirty_diff_sha256"] is None
    (pkg / "core.py").write_text("X = 2\n")
    d1, _ = A.compute_code_identity(pkg, environ={})
    (pkg / "core.py").write_text("X = 3\n")
    d2, _ = A.compute_code_identity(pkg, environ={})
    assert d1["dirty"] is d2["dirty"] is True and d1["code_revision"] == d2["code_revision"] == head
    assert len({clean["code_tree_sha256"], d1["code_tree_sha256"], d2["code_tree_sha256"]}) == 3
    assert d1["dirty_diff_sha256"] != d2["dirty_diff_sha256"]  # two dirty trees never share an identity
    (pkg / "core.py").write_text("X = 1\n")
    (pkg / "new_module.py").write_text("Y = 1\n")  # untracked files count as dirty
    d3, _ = A.compute_code_identity(pkg, environ={})
    assert d3["dirty"] is True and d3["dirty_diff_sha256"] not in (None, d1["dirty_diff_sha256"])


def test_code_identity_is_captured_once_at_import(monkeypatch):
    ident = A.code_identity()
    assert ident == A.code_identity() and ident is not A.code_identity()
    assert ident["package"] == "dermpath" and len(ident["code_tree_sha256"]) == 64 and ident["code_tree_files"] > 20
    ident["code_tree_sha256"] = "tampered"
    assert A.code_identity()["code_tree_sha256"] != "tampered"  # callers get copies
    # The snapshot does not follow the environment after import.
    monkeypatch.setenv(A.CODE_REVISION_ENV, "set-after-import")
    assert A.code_identity()["code_revision"] != "set-after-import"


def test_legacy_code_revision_string(monkeypatch):
    base = dict(A.code_identity(), code_tree_sha256="ab" * 32)
    monkeypatch.setattr(A, "_CODE_IDENTITY", {**base, "code_revision": "c0ffee", "dirty": False})
    assert A.code_revision() == "c0ffee"
    monkeypatch.setattr(A, "_CODE_IDENTITY", {**base, "code_revision": "c0ffee", "dirty": True,
                                              "dirty_diff_sha256": "12" * 32})
    assert A.code_revision() == "c0ffee+uncommitted.121212121212"
    monkeypatch.setattr(A, "_CODE_IDENTITY", {**base, "code_revision": "unknown", "dirty": None})
    assert A.code_revision() == "unknown+tree.abababababab"


def test_code_tree_drift_reports_changes_since_start(tmp_path, monkeypatch):
    pkg = _package(tmp_path, FILES)
    ident, files = A.compute_code_identity(pkg, environ={}, use_git=False)
    monkeypatch.setattr(A, "_CODE_IDENTITY", ident)
    monkeypatch.setattr(A, "_CODE_FILES", files)
    assert A.code_tree_drift(pkg)["matches"] is True
    (pkg / "core.py").write_text("X = 42\n")
    (pkg / "late.py").write_text("")
    drift = A.code_tree_drift(pkg)
    assert drift["matches"] is False and drift["changed"] == ["pkgx/core.py"] and drift["added"] == ["pkgx/late.py"]
    assert drift["code_tree_sha256_now"] != drift["code_tree_sha256_at_start"] == ident["code_tree_sha256"]


def test_dependency_versions_cover_the_numerical_stack():
    deps = A.dependency_versions()
    required = {"python", "platform", "machine", "numpy", "torch", "scikit-learn", "timm", "torchvision",
                "transformers", "safetensors", "huggingface_hub", "openslide-python", "openslide (C library)",
                "pillow", "torch.cuda", "torch.cuda_available", "torch.mps_available"}
    assert required <= set(deps)
    assert all(isinstance(v, str) and v for v in deps.values())
    import numpy

    assert deps["numpy"] == numpy.__version__  # the loaded module, not just metadata
    deps["numpy"] = "tampered"
    assert A.dependency_versions()["numpy"] == numpy.__version__


def test_extraction_env_sha_tracks_only_output_affecting_facts():
    versions = {name: "1.0" for name in A.EXTRACTION_LIBRARIES} | {"fastapi": "0.1", "machine": "arm64",
                                                                    "torch.cuda": "12.4"}
    env, sha = A.extraction_env("cpu", "fp32", versions=versions)
    assert env["device_class"] == "cpu" and env["precision"] == "fp32" and set(env["libraries"]) == set(
        A.EXTRACTION_LIBRARIES)
    assert sha == A.sha256_hex(A.canonical_json(env)) == A.extraction_env("cpu", "fp32", versions=versions)[1]
    assert A.extraction_env("cpu", "fp32", versions={**versions, "fastapi": "9.9"})[1] == sha  # not numerics
    for other in (A.extraction_env("cpu", "bf16", versions=versions)[1],
                  A.extraction_env("mps", "fp32", versions=versions)[1],
                  A.extraction_env("cpu", "fp32", versions={**versions, "timm": "1.1"})[1],
                  A.extraction_env("cpu", "fp32", versions={**versions, "openslide (C library)": "4.1"})[1],
                  A.extraction_env("cpu", "fp32", versions={**versions, "machine": "x86_64"})[1]):
        assert other != sha
    assert A.extraction_env("cuda:0", "fp32", versions=versions) == A.extraction_env("cuda:1", "fp32",
                                                                                      versions=versions)
    assert A.extraction_env("cuda", "fp32", versions=versions)[0]["cuda"] == "12.4"
    with pytest.raises(ValueError, match="auto"):
        A.extraction_env("auto")
    with pytest.raises(ValueError, match="precision"):
        A.extraction_env("cpu", "fp8")
    with pytest.raises(ValueError, match="unknown device"):
        A.extraction_env("tpu")
    real_env, real_sha = A.extraction_env()  # this process
    assert real_env["libraries"]["numpy"] == A.dependency_versions()["numpy"] and len(real_sha) == 64


def test_conftest_isolates_engine_environment_variables():
    from conftest import ISOLATED_ENV_PREFIXES, isolated_env_names

    leaked = [k for k in os.environ if k.startswith(ISOLATED_ENV_PREFIXES) or k == "WB_CODE_REVISION"]
    assert leaked == []
    fake = {"WB_ML_DEVICE": "mps", "WB_UNI_WEIGHTS": "/w", "WB_RESNET18_WEIGHTS": "/r", "WB_HIBOU_DIR": "/h",
            "WB_MIDNIGHT_DIR": "/m", "WB_CODE_REVISION": "x", "WB_MODE": "demo", "WB_MLX": "kept"}
    assert isolated_env_names(fake) == sorted(set(fake) - {"WB_MODE", "WB_MLX"})
