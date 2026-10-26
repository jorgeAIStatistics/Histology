"""Device and precision resolution (``WB_ML_DEVICE``), and deterministic inference settings."""

from __future__ import annotations

import pytest

torch = pytest.importorskip("torch")

from dermpath.ml import devices  # noqa: E402


@pytest.fixture(autouse=True)
def _clean(monkeypatch):
    monkeypatch.delenv("WB_ML_DEVICE", raising=False)
    monkeypatch.delenv("WB_ML_CPU_THREADS", raising=False)


def _auto() -> str:
    if torch.cuda.is_available():
        return "cuda:0"
    return "mps" if torch.backends.mps.is_available() else "cpu"


def test_auto_prefers_cuda_then_mps_then_cpu(monkeypatch):
    assert devices.resolve_device() == _auto() == devices.resolve_device("auto") == devices.resolve_device("AUTO")
    assert devices.available_devices()[-1] == "cpu"
    assert devices.available_devices()[0] == devices.device_class(_auto())
    monkeypatch.setenv("WB_ML_DEVICE", "cpu")
    assert devices.resolve_device() == "cpu"  # the environment applies when nothing is passed
    assert devices.resolve_device("auto") == _auto()  # an explicit argument wins


def test_explicit_devices_are_honoured_or_refused_never_substituted(monkeypatch):
    assert devices.resolve_device("cpu") == "cpu"
    for bad in ("tpu", "gpu", "cuda:x"):
        with pytest.raises(devices.DeviceUnavailable):
            devices.resolve_device(bad)
    if not torch.cuda.is_available():
        for want in ("cuda", "cuda:0"):
            with pytest.raises(devices.DeviceUnavailable, match="CUDA is not available"):
                devices.resolve_device(want)
    if not torch.backends.mps.is_available():
        with pytest.raises(devices.DeviceUnavailable, match="MPS"):
            devices.resolve_device("mps")
    else:
        assert devices.resolve_device("mps") == "mps"
    monkeypatch.setenv("WB_ML_DEVICE", "tpu")
    with pytest.raises(devices.DeviceUnavailable):
        devices.resolve_device()


def test_precision_is_fp32_unless_requested_explicitly():
    assert devices.resolve_precision(None) == devices.resolve_precision("") == "fp32"
    assert devices.resolve_precision("BF16") == "bf16" and devices.resolve_precision("fp16") == "fp16"
    for bad in ("fp8", "float32", "half", "int8"):
        with pytest.raises(ValueError):
            devices.resolve_precision(bad)
    assert devices.torch_dtype("fp32") is torch.float32 and devices.torch_dtype("bf16") is torch.bfloat16
    assert devices.precision_supported("cpu", "fp32") == (True, None)


def test_cpu_threads_are_fixed_and_validated(monkeypatch):
    assert devices.cpu_threads() == devices.DEFAULT_CPU_THREADS == 4
    monkeypatch.setenv("WB_ML_CPU_THREADS", "2")
    assert devices.cpu_threads() == 2
    for bad in ("0", "-1", "two"):
        monkeypatch.setenv("WB_ML_CPU_THREADS", bad)
        with pytest.raises(ValueError):
            devices.cpu_threads()


def test_inference_context_sets_and_restores_global_torch_state():
    before = (torch.get_num_threads(), torch.are_deterministic_algorithms_enabled(),
              torch.is_deterministic_algorithms_warn_only_enabled())
    with devices.inference_context("cpu", threads=2):
        assert torch.get_num_threads() == 2
        assert torch.are_deterministic_algorithms_enabled() and not torch.is_deterministic_algorithms_warn_only_enabled()
        assert torch.is_inference_mode_enabled()
    assert (torch.get_num_threads(), torch.are_deterministic_algorithms_enabled(),
            torch.is_deterministic_algorithms_warn_only_enabled()) == before
    with pytest.raises(RuntimeError):
        with devices.inference_context("cpu", threads=1):
            raise RuntimeError("boom")
    assert torch.get_num_threads() == before[0]  # restored on error too
    info = devices.runtime_info("cpu", "fp32", threads=3)
    assert info["device_class"] == "cpu" and info["cpu_threads"] == 3 and info["torch"] == torch.__version__


def test_acceptance_rule_is_documented():
    assert devices.PRECISION_ACCEPTANCE == {"min_patches": 32, "cosine_min": 0.999, "rel_l2_max": 0.05}
    for needle in ("32", "0.999", "0.05", "separate feature set"):
        assert needle in devices.PRECISION_ACCEPTANCE_RULE
        assert needle in devices.__doc__
