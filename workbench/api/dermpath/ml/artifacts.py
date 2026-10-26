"""Deterministic ``.npz`` artifacts and run provenance (code identity, dependency versions).

``numpy.savez`` stamps the current time into the zip entries, so identical arrays give
different bytes. :func:`npz_bytes` writes the same ``.npz`` layout (one ``.npy`` member per
array, readable with ``numpy.load``) with a fixed timestamp and sorted member order, so the
same content always has the same SHA-256 (needed for checkpoint determinism checks).

Provenance (design §10):

* :func:`code_identity` is computed **once, when this module is imported** (process start
  for the API and the worker): ``code_revision`` (``WB_CODE_REVISION`` when set, else git
  ``HEAD``, else ``unknown``), ``code_tree_sha256`` over the bytes of every ``.py`` file of
  the ``dermpath`` package (sorted relative path + per-file sha256; works without git, e.g.
  in the Docker image), and, when git is available, ``dirty`` plus ``dirty_diff_sha256``
  (the uncommitted diff and untracked files under the package), so two different dirty
  trees never share an identity. :func:`code_tree_drift` reports whether the files on disk
  still match what the process started with.
* :func:`dependency_versions` (computed once per process) records the numerical stack:
  versions of the modules actually loaded (falling back to installed metadata), the
  OpenSlide C library, the torch build (CUDA/MPS), Python and the platform.
* :func:`extraction_env` is the subset that can change embeddings (libraries, device class,
  precision, CPU architecture) and its sha256, recorded on feature sets and artifacts.
"""

from __future__ import annotations

import functools
import hashlib
import io
import json
import os
import platform
import subprocess
import sys
import zipfile
from collections.abc import Mapping
from importlib import metadata
from pathlib import Path

import numpy as np

_FIXED_TIME = (1980, 1, 1, 0, 0, 0)
PACKAGE_DIR = Path(__file__).resolve().parent.parent  # .../api/dermpath
CODE_REVISION_ENV = "WB_CODE_REVISION"
CODE_IDENTITY_SCHEMA = "dermpath.code_identity/1"
EXTRACTION_ENV_SCHEMA = "dermpath.extraction_env/1"
PRECISIONS = ("fp32", "fp16", "bf16")


def canonical_json(obj) -> bytes:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode()


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def npz_bytes(arrays: dict[str, np.ndarray], meta: dict | None = None) -> bytes:
    buf = io.BytesIO()
    members = dict(arrays)
    if meta is not None:
        members["meta_json"] = np.frombuffer(canonical_json(meta), dtype=np.uint8)
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_STORED) as zf:
        for name in sorted(members):
            arr = np.ascontiguousarray(members[name])
            if arr.dtype == object:
                raise ValueError(f"array {name!r} has dtype object; refusing to pickle")
            body = io.BytesIO()
            np.lib.format.write_array(body, arr, allow_pickle=False)
            info = zipfile.ZipInfo(name + ".npy", date_time=_FIXED_TIME)
            info.compress_type = zipfile.ZIP_STORED
            info.external_attr = 0o600 << 16
            zf.writestr(info, body.getvalue())
    return buf.getvalue()


def load_npz(data: bytes) -> tuple[dict[str, np.ndarray], dict | None]:
    with np.load(io.BytesIO(data), allow_pickle=False) as z:
        arrays = {k: z[k] for k in z.files}
    meta = None
    if "meta_json" in arrays:
        meta = json.loads(arrays.pop("meta_json").tobytes().decode())
    return arrays, meta


# --------------------------------------------------------------------------- code identity


def _file_sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for block in iter(lambda: fh.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def code_tree_files(package_dir: Path) -> dict[str, str]:
    """``{relative posix path: sha256}`` for every ``.py`` file of a package (no caches).

    Paths are relative to the package's parent, so they start with the package name.
    """
    package_dir = Path(package_dir).resolve()
    out: dict[str, str] = {}
    for path in package_dir.rglob("*.py"):
        rel = path.relative_to(package_dir.parent)
        if "__pycache__" in rel.parts or not path.is_file():
            continue
        out[rel.as_posix()] = _file_sha256(path)
    return out


def code_tree_sha256(files: Mapping[str, str]) -> str:
    """sha256 over the sorted ``(relative path, file sha256)`` pairs."""
    h = hashlib.sha256()
    for rel in sorted(files):
        h.update(f"{rel}\0{files[rel]}\n".encode())
    return h.hexdigest()


def _git(cwd: Path, *args: str, text: bool = True) -> subprocess.CompletedProcess | None:
    try:
        return subprocess.run(["git", "-c", "core.quotepath=off", *args], cwd=cwd, capture_output=True, text=text,
                              timeout=10)
    except (OSError, subprocess.SubprocessError):
        return None


def _git_state(package_dir: Path) -> dict:
    """HEAD, dirty flag and a sha256 of the uncommitted changes under ``package_dir``."""
    head = _git(package_dir, "rev-parse", "HEAD")
    if head is None or head.returncode != 0 or not head.stdout.strip():
        return {"git_head": None, "dirty": None, "dirty_diff_sha256": None}
    diff = _git(package_dir, "diff", "HEAD", "--binary", "--no-color", "--no-ext-diff", "--", ".", text=False)
    untracked = _git(package_dir, "ls-files", "--others", "--exclude-standard", "-z", "--", ".", text=False)
    if diff is None or diff.returncode != 0 or untracked is None or untracked.returncode != 0:
        return {"git_head": head.stdout.strip(), "dirty": None, "dirty_diff_sha256": None}
    names = sorted(n for n in untracked.stdout.decode("utf-8", "surrogateescape").split("\0") if n)
    dirty = bool(diff.stdout) or bool(names)
    digest = None
    if dirty:
        h = hashlib.sha256(diff.stdout)
        for name in names:
            p = package_dir / name
            h.update(b"\0untracked\0" + name.encode("utf-8", "surrogateescape") + b"\0")
            h.update((_file_sha256(p) if p.is_file() else "missing").encode())
        digest = h.hexdigest()
    return {"git_head": head.stdout.strip(), "dirty": dirty, "dirty_diff_sha256": digest}


def compute_code_identity(package_dir: Path = PACKAGE_DIR, *, environ: Mapping[str, str] | None = None,
                          use_git: bool = True) -> tuple[dict, dict[str, str]]:
    """``(identity, per-file shas)`` of the code in ``package_dir`` as it is on disk now.

    The tree covers every ``.py`` file of the package, not only the modules imported so far:
    the API and the worker import different subsets, and the same code must give the same
    identity in both, or every run would fail with ``run_identity_changed``.
    """
    environ = os.environ if environ is None else environ
    files = code_tree_files(package_dir)
    git = _git_state(Path(package_dir)) if use_git else {"git_head": None, "dirty": None, "dirty_diff_sha256": None}
    env_rev = (environ.get(CODE_REVISION_ENV) or "").strip()
    if env_rev:
        revision, source = env_rev[:80], "env"
    elif git["git_head"]:
        revision, source = git["git_head"], "git"
    else:
        revision, source = "unknown", "unknown"
    identity = {
        "schema": CODE_IDENTITY_SCHEMA,
        "package": Path(package_dir).resolve().name,
        "code_revision": revision,
        "code_revision_source": source,
        "git_head": git["git_head"],
        "code_tree_sha256": code_tree_sha256(files),
        "code_tree_files": len(files),
        "dirty": git["dirty"],
        "dirty_diff_sha256": git["dirty_diff_sha256"],
    }
    return identity, files


# Computed once, at import (process start). Never refreshed: it describes the code this
# process loaded, not whatever is on disk later (see code_tree_drift).
_CODE_IDENTITY, _CODE_FILES = compute_code_identity()


def code_identity() -> dict:
    """The code identity captured when this process imported the module (a copy)."""
    return dict(_CODE_IDENTITY)


def code_tree_drift(package_dir: Path = PACKAGE_DIR) -> dict:
    """Compare the package files on disk now with the snapshot taken at process start.

    A worker whose files changed after it started may run code that differs from both
    the snapshot and the disk; callers should refuse new attempts until it restarts.
    """
    now = code_tree_files(package_dir)
    before = _CODE_FILES
    changed = sorted(k for k in now.keys() & before.keys() if now[k] != before[k])
    added = sorted(now.keys() - before.keys())
    removed = sorted(before.keys() - now.keys())
    return {"matches": not (changed or added or removed), "changed": changed, "added": added, "removed": removed,
            "code_tree_sha256_at_start": _CODE_IDENTITY["code_tree_sha256"],
            "code_tree_sha256_now": code_tree_sha256(now)}


def code_revision() -> str:
    """Legacy one-string revision (kept for callers): ``<revision>`` plus
    ``+uncommitted.<12 hex of dirty_diff_sha256>`` for a dirty tree, or
    ``+tree.<12 hex of code_tree_sha256>`` when the revision is unknown."""
    ident = _CODE_IDENTITY
    rev = ident["code_revision"]
    if ident["dirty"]:
        return f"{rev}+uncommitted.{(ident['dirty_diff_sha256'] or '')[:12]}"
    if rev == "unknown":
        return f"unknown+tree.{ident['code_tree_sha256'][:12]}"
    return rev


# --------------------------------------------------------------------------- dependencies

#: (distribution name recorded, importable module that carries ``__version__`` or None)
_DISTRIBUTIONS = (
    ("numpy", "numpy"), ("scipy", "scipy"), ("scikit-learn", "sklearn"), ("torch", "torch"),
    ("torchvision", "torchvision"), ("timm", "timm"), ("transformers", "transformers"),
    ("safetensors", "safetensors"), ("huggingface_hub", "huggingface_hub"), ("openslide-python", "openslide"),
    ("openslide-bin", None), ("pillow", "PIL"), ("sqlalchemy", "sqlalchemy"), ("fastapi", "fastapi"),
)


def _version(dist: str, module: str | None) -> str:
    """The version of the module already loaded in this process (what actually runs),
    else the installed distribution's metadata, else ``not installed``."""
    mod = sys.modules.get(module) if module else None
    ver = getattr(mod, "__version__", None) if mod is not None else None
    if isinstance(ver, str) and ver:
        return ver
    try:
        return metadata.version(dist)
    except metadata.PackageNotFoundError:
        return "not installed"


def _torch_build() -> dict[str, str]:
    try:
        import torch
    except Exception:  # pragma: no cover - torch is a hard requirement
        return {"torch.cuda": "not installed"}
    out = {"torch.cuda": str(getattr(torch.version, "cuda", None) or "none"),
           "torch.git_version": str(getattr(torch.version, "git_version", "") or "unknown")}
    try:
        out["torch.cuda_available"] = str(bool(torch.cuda.is_available())).lower()
    except Exception:  # pragma: no cover
        out["torch.cuda_available"] = "unknown"
    try:
        mps = torch.backends.mps
        out["torch.mps_built"] = str(bool(mps.is_built())).lower()
        out["torch.mps_available"] = str(bool(mps.is_available())).lower()
    except Exception:  # pragma: no cover
        out["torch.mps_available"] = "unknown"
    return out


@functools.cache
def _dependency_versions() -> tuple[tuple[str, str], ...]:
    out = {"python": platform.python_version(), "python_implementation": platform.python_implementation(),
           "platform": platform.platform(), "machine": platform.machine()}
    for dist, module in _DISTRIBUTIONS:
        out[dist] = _version(dist, module)
    try:
        import openslide

        out["openslide (C library)"] = str(openslide.__library_version__)
    except Exception:  # pragma: no cover - reported, never fatal
        out["openslide (C library)"] = "not available"
    out.update(_torch_build())
    return tuple(sorted(out.items()))


def dependency_versions() -> dict[str, str]:
    """Versions of the numerical stack, computed once per process (a copy)."""
    return dict(_dependency_versions())


# --------------------------------------------------------------------------- extraction environment

#: Libraries whose version can change embeddings (design §5 feature artifact key).
EXTRACTION_LIBRARIES = ("openslide (C library)", "openslide-python", "pillow", "numpy", "torch", "torchvision",
                        "timm", "transformers", "safetensors")


def device_class(device: str) -> str:
    """``cpu`` | ``cuda`` | ``mps`` from a concrete torch device string (``cuda:1`` -> ``cuda``)."""
    cls = (device or "").split(":", 1)[0].strip().lower()
    if cls == "auto":
        raise ValueError("resolve device 'auto' to a concrete device before recording the extraction environment")
    if cls not in ("cpu", "cuda", "mps"):
        raise ValueError(f"unknown device {device!r} (expected cpu, cuda[:n] or mps)")
    return cls


def extraction_env(device: str = "cpu", precision: str = "fp32",
                   versions: Mapping[str, str] | None = None) -> tuple[dict, str]:
    """``(env, sha256)`` describing everything outside the spec that can change embeddings:
    library versions, device class, precision and CPU architecture (plus the CUDA toolkit
    on CUDA). ``versions`` defaults to :func:`dependency_versions`."""
    if precision not in PRECISIONS:
        raise ValueError(f"precision must be one of {PRECISIONS}")
    deps = dict(dependency_versions() if versions is None else versions)
    cls = device_class(device)
    env = {
        "schema": EXTRACTION_ENV_SCHEMA,
        "libraries": {name: deps.get(name, "not installed") for name in EXTRACTION_LIBRARIES},
        "device_class": cls,
        "precision": precision,
        "machine": deps.get("machine", platform.machine()),
    }
    if cls == "cuda":
        env["cuda"] = deps.get("torch.cuda", "unknown")
    return env, sha256_hex(canonical_json(env))
