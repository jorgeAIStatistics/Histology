"""Deterministic ``.npz`` artifacts and run provenance (code revision, dependency versions).

``numpy.savez`` stamps the current time into the zip entries, so identical arrays give
different bytes. :func:`npz_bytes` writes the same ``.npz`` layout (one ``.npy`` member per
array, readable with ``numpy.load``) with a fixed timestamp and sorted member order, so the
same content always has the same SHA-256 (needed for checkpoint determinism checks).
"""

from __future__ import annotations

import functools
import hashlib
import io
import json
import platform
import subprocess
import zipfile
from importlib import metadata

import numpy as np

from ..config import WORKBENCH_DIR

_FIXED_TIME = (1980, 1, 1, 0, 0, 0)


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


# --------------------------------------------------------------------------- provenance


def _git(*args: str) -> subprocess.CompletedProcess | None:
    try:
        return subprocess.run(["git", *args], cwd=WORKBENCH_DIR, capture_output=True, text=True, timeout=5)
    except (OSError, subprocess.SubprocessError):
        return None


@functools.lru_cache(maxsize=1)
def code_revision() -> str:
    """``git rev-parse HEAD`` (read-only), plus ``+uncommitted`` when the backend package
    has local changes or untracked files; ``unknown`` when git is unavailable."""
    head = _git("rev-parse", "HEAD")
    if head is None or head.returncode != 0 or not head.stdout.strip():
        return "unknown"
    rev = head.stdout.strip()
    diff = _git("diff", "--quiet", "HEAD", "--", "api/dermpath")
    untracked = _git("ls-files", "--others", "--exclude-standard", "--", "api/dermpath")
    dirty = (diff is not None and diff.returncode == 1) or (untracked is not None and bool(untracked.stdout.strip()))
    return rev + ("+uncommitted" if dirty else "")


def dependency_versions() -> dict[str, str]:
    out = {"python": platform.python_version()}
    for dist in ("numpy", "scipy", "scikit-learn", "torch", "openslide-python", "openslide-bin", "pillow",
                 "sqlalchemy", "fastapi"):
        try:
            out[dist] = metadata.version(dist)
        except metadata.PackageNotFoundError:
            out[dist] = "not installed"
    try:
        import openslide

        out["openslide (C library)"] = openslide.__library_version__
    except Exception:  # pragma: no cover
        pass
    return out
