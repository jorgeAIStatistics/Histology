"""Device and precision selection for encoder inference, and the low-precision acceptance check.

Device (``WB_ML_DEVICE``)
-------------------------
``auto`` (the default when nothing is passed and the variable is unset) picks ``cuda``, then
``mps``, then ``cpu``. An explicit ``cpu``, ``mps``, ``cuda`` or ``cuda:<n>`` is honoured only
if that device is usable here; otherwise :class:`DeviceUnavailable` is raised (never a silent
fallback). The resolved device is recorded with every loaded encoder and feature artifact.

Precision
---------
``fp32`` is the default. ``fp16`` and ``bf16`` are used only when passed explicitly, and only
after :func:`compare_precision` has shown on real tissue patches that they meet
:data:`PRECISION_ACCEPTANCE`:

    Low precision is ACCEPTED for an encoder on a device only if, on at least 32
    representative real tissue patches, the fp32 reference and the low-precision candidate
    (same spec, same weights sha256) give ``cosine_min >= 0.999`` (worst patch) and
    ``rel_l2 <= 0.05`` (Frobenius norm of the difference over that of the reference), with
    every output finite.

Even when accepted, low-precision embeddings are a separate feature set (precision is part
of the extraction environment) and are never mixed with fp32 embeddings.

Determinism
-----------
:func:`inference_context` runs inference under ``torch.inference_mode()`` with
deterministic algorithms (strict on CPU, warn-only on accelerators), cuDNN benchmarking off,
and a FIXED intra-op thread count on CPU (``WB_ML_CPU_THREADS``, default 4), all restored
afterwards. Torch's thread count and determinism flags are process-global, so the context
holds :data:`TORCH_STATE_LOCK` while it runs.
"""

from __future__ import annotations

import os
import threading
from contextlib import contextmanager

import numpy as np

DEVICE_ENV = "WB_ML_DEVICE"
THREADS_ENV = "WB_ML_CPU_THREADS"
DEFAULT_CPU_THREADS = 4
PRECISIONS = ("fp32", "fp16", "bf16")
DEFAULT_PRECISION = "fp32"

PRECISION_ACCEPTANCE = {"min_patches": 32, "cosine_min": 0.999, "rel_l2_max": 0.05}
PRECISION_ACCEPTANCE_RULE = (
    "accept low precision only if, on >= 32 representative real tissue patches, the fp32 reference and the "
    "low-precision candidate (same spec and weights sha256) give cosine_min >= 0.999 and rel_l2 <= 0.05 with all "
    "outputs finite; accepted low-precision embeddings are still a separate feature set")

# Torch's intra-op thread count and determinism flags are process-global.
TORCH_STATE_LOCK = threading.RLock()


class DeviceUnavailable(ValueError):
    """The requested device (or precision on that device) cannot be used in this process."""


def _torch():
    import torch

    return torch


def _mps_available(torch) -> bool:
    mps = getattr(torch.backends, "mps", None)
    return bool(mps is not None and mps.is_available())


def available_devices() -> list[str]:
    """Usable device classes in this process, in ``auto`` preference order."""
    torch = _torch()
    out = []
    if torch.cuda.is_available():
        out.append("cuda")
    if _mps_available(torch):
        out.append("mps")
    out.append("cpu")
    return out


def resolve_device(pref: str | None = None) -> str:
    """Canonical device string (``cpu``, ``mps`` or ``cuda:<n>``) for ``pref`` (or ``WB_ML_DEVICE``)."""
    raw = pref if pref not in (None, "") else (os.environ.get(DEVICE_ENV, "").strip() or "auto")
    value = str(raw).strip().lower()
    torch = _torch()
    if value == "auto":
        if torch.cuda.is_available():
            return "cuda:0"
        return "mps" if _mps_available(torch) else "cpu"
    if value == "cpu":
        return "cpu"
    if value == "mps":
        if not _mps_available(torch):
            raise DeviceUnavailable("device 'mps' was requested but the MPS backend is not available here")
        return "mps"
    if value == "cuda" or value.startswith("cuda:"):
        if not torch.cuda.is_available():
            raise DeviceUnavailable(f"device {value!r} was requested but CUDA is not available here")
        index_text = value.partition(":")[2] or "0"
        if not index_text.isdigit() or int(index_text) >= torch.cuda.device_count():
            raise DeviceUnavailable(f"device {value!r} does not exist ({torch.cuda.device_count()} CUDA device(s))")
        return f"cuda:{int(index_text)}"
    raise DeviceUnavailable(f"unknown device {raw!r}; use auto, cpu, mps, cuda or cuda:<n>")


def device_class(device: str) -> str:
    return device.split(":", 1)[0]


def resolve_precision(precision: str | None = None) -> str:
    """``fp32`` unless ``fp16``/``bf16`` is passed explicitly. Anything else raises ``ValueError``."""
    if precision in (None, ""):
        return DEFAULT_PRECISION
    value = str(precision).strip().lower()
    if value not in PRECISIONS:
        raise ValueError(f"unknown precision {precision!r}; use one of {', '.join(PRECISIONS)}")
    return value


def torch_dtype(precision: str):
    torch = _torch()
    return {"fp32": torch.float32, "fp16": torch.float16, "bf16": torch.bfloat16}[resolve_precision(precision)]


_PRECISION_PROBE: dict[tuple[str, str], tuple[bool, str | None]] = {}


def precision_supported(device: str, precision: str) -> tuple[bool, str | None]:
    """Probe (once per process) that a small matmul and LayerNorm run at ``precision`` on ``device``."""
    precision = resolve_precision(precision)
    if precision == "fp32":
        return True, None
    key = (device, precision)
    if key not in _PRECISION_PROBE:
        torch = _torch()
        try:
            dtype = torch_dtype(precision)
            x = torch.ones((2, 8), dtype=dtype, device=device)
            y = torch.nn.functional.layer_norm(x @ x.T, (2,))
            ok = bool(torch.isfinite(y.float()).all().item())
            _PRECISION_PROBE[key] = (ok, None if ok else f"{precision} on {device} produced non-finite values")
        except (RuntimeError, TypeError) as exc:
            _PRECISION_PROBE[key] = (False, f"{precision} is not supported on {device}: {exc}")
    return _PRECISION_PROBE[key]


def cpu_threads() -> int:
    """The fixed intra-op thread count for CPU inference (``WB_ML_CPU_THREADS``, default 4)."""
    raw = os.environ.get(THREADS_ENV, "").strip()
    if not raw:
        return DEFAULT_CPU_THREADS
    if not raw.isdigit() or int(raw) < 1:
        raise ValueError(f"{THREADS_ENV} must be a positive integer, not {raw!r}")
    return int(raw)


@contextmanager
def inference_context(device: str, *, threads: int | None = None):
    """Deterministic inference settings for the duration of the block (see the module docstring)."""
    torch = _torch()
    n_threads = int(threads or cpu_threads())
    strict = device_class(device) == "cpu"
    with TORCH_STATE_LOCK:
        prev_threads = torch.get_num_threads()
        prev_det = torch.are_deterministic_algorithms_enabled()
        prev_warn = torch.is_deterministic_algorithms_warn_only_enabled()
        prev_bench, prev_cudnn_det = torch.backends.cudnn.benchmark, torch.backends.cudnn.deterministic
        try:
            torch.set_num_threads(n_threads)
            torch.use_deterministic_algorithms(True, warn_only=not strict)
            torch.backends.cudnn.benchmark = False
            torch.backends.cudnn.deterministic = True
            with torch.inference_mode():
                yield torch
        finally:
            torch.backends.cudnn.benchmark, torch.backends.cudnn.deterministic = prev_bench, prev_cudnn_det
            torch.use_deterministic_algorithms(prev_det, warn_only=prev_warn)
            torch.set_num_threads(prev_threads)


def runtime_info(device: str, precision: str, *, threads: int | None = None) -> dict:
    """What is recorded about the execution environment of a loaded encoder."""
    torch = _torch()
    info = {"device": device, "device_class": device_class(device), "precision": resolve_precision(precision),
            "torch": torch.__version__, "cpu_threads": int(threads or cpu_threads())}
    if device_class(device) == "cuda":
        info["cuda"] = torch.version.cuda
        info["device_name"] = torch.cuda.get_device_name(int(device.partition(":")[2] or 0))
    return info


# --------------------------------------------------------------------------- precision comparison


def _row_cosines(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    na, nb = np.linalg.norm(a, axis=1), np.linalg.norm(b, axis=1)
    dot = (a * b).sum(axis=1)
    both_zero = (na == 0) & (nb == 0)
    with np.errstate(divide="ignore", invalid="ignore"):
        cos = np.where(both_zero, 1.0, dot / np.where((na == 0) | (nb == 0), np.inf, na * nb))
    return np.clip(cos, -1.0, 1.0)


def compare_precision(loaded_ref, loaded_lowp, patches: np.ndarray, *, batch_size: int = 32) -> dict:
    """Compare an fp32 reference with a low-precision (or other-device) load of the SAME encoder.

    ``loaded_ref`` and ``loaded_lowp`` are :class:`dermpath.ml.encoders.LoadedEncoder` objects
    with identical spec and weights sha256; ``loaded_ref`` must be fp32. Returns
    ``cosine_min``, ``cosine_mean`` (per-patch cosine similarity), ``max_abs_diff``, ``rel_l2``
    and the verdict under :data:`PRECISION_ACCEPTANCE` (with its reasons).
    """
    if loaded_ref.spec.spec_sha256() != loaded_lowp.spec.spec_sha256():
        raise ValueError("compare_precision needs two loads of the same encoder spec")
    if loaded_ref.weights_sha256 != loaded_lowp.weights_sha256:
        raise ValueError("compare_precision needs two loads of the same weights (weights_sha256 differs)")
    if loaded_ref.precision != "fp32":
        raise ValueError(f"the reference must be fp32, not {loaded_ref.precision}")
    n = int(patches.shape[0])
    if n == 0:
        raise ValueError("compare_precision needs at least one patch")
    ref, cand = [], []
    finite, error = True, None
    try:
        for i in range(0, n, batch_size):
            chunk = patches[i:i + batch_size]
            ref.append(loaded_ref.embed_batch(chunk))
            cand.append(loaded_lowp.embed_batch(chunk))
    except FloatingPointError as exc:  # embed_batch refuses non-finite output
        finite, error = False, str(exc)
    if finite:
        a = np.concatenate(ref).astype(np.float64)
        b = np.concatenate(cand).astype(np.float64)
        cos = _row_cosines(a, b)
        ref_norm, diff_norm = float(np.linalg.norm(a)), float(np.linalg.norm(a - b))
        rel_l2 = (diff_norm / ref_norm) if ref_norm > 0 else (0.0 if diff_norm == 0 else float("inf"))
        max_abs = float(np.max(np.abs(a - b)))
    else:
        cos, rel_l2, max_abs = np.array([np.nan]), float("nan"), float("nan")
    result = {
        "encoder_id": loaded_ref.spec.id,
        "weights_sha256": loaded_ref.weights_sha256,
        "reference": {"device": loaded_ref.device, "precision": loaded_ref.precision},
        "candidate": {"device": loaded_lowp.device, "precision": loaded_lowp.precision},
        "n_patches": n,
        "all_finite": finite,
        "cosine_min": float(np.min(cos)),
        "cosine_mean": float(np.mean(cos)),
        "max_abs_diff": max_abs,
        "rel_l2": float(rel_l2),
        "acceptance": dict(PRECISION_ACCEPTANCE),
        "acceptance_rule": PRECISION_ACCEPTANCE_RULE,
    }
    reasons = []
    if not finite:
        reasons.append(f"non-finite outputs ({error})")
    if n < PRECISION_ACCEPTANCE["min_patches"]:
        reasons.append(f"only {n} patches (needs >= {PRECISION_ACCEPTANCE['min_patches']})")
    if finite and result["cosine_min"] < PRECISION_ACCEPTANCE["cosine_min"]:
        reasons.append(f"cosine_min {result['cosine_min']:.6f} < {PRECISION_ACCEPTANCE['cosine_min']}")
    if finite and result["rel_l2"] > PRECISION_ACCEPTANCE["rel_l2_max"]:
        reasons.append(f"rel_l2 {result['rel_l2']:.6f} > {PRECISION_ACCEPTANCE['rel_l2_max']}")
    result["accepted"] = not reasons
    result["reasons"] = reasons
    return result
