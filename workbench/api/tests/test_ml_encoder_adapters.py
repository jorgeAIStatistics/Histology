"""Real encoder adapters exercised end to end with TINY random-initialised models.

The models are built through the same builders the adapters use (timm ``vit_large_patch16_224``
with UNI's kwargs but tiny dims; transformers ``Dinov2Model`` / ``Dinov2WithRegistersModel``;
torchvision ``resnet18``), saved to temporary files, and loaded back through ``adapter.load``.
They prove the mechanics (hash binding, cache invalidation, strict loading, pooling,
preprocessing, offline loading, precision comparison), never anything about pathology.
"""

from __future__ import annotations

import copy
import dataclasses
import hashlib
import json
import os
import socket
import urllib.request
from pathlib import Path

import numpy as np
import pytest

torch = pytest.importorskip("torch")
timm = pytest.importorskip("timm")
transformers = pytest.importorskip("transformers")
safetensors_torch = pytest.importorskip("safetensors.torch")

from dermpath.ml import devices, encoders  # noqa: E402
from dermpath.ml.encoders import (  # noqa: E402
    EncoderIdentityMismatch,
    EncoderInputError,
    EncoderLoadError,
    EncoderUnavailable,
)

ENV = ("WB_UNI_WEIGHTS", "WB_UNI_LICENSE_ACCEPTED", "WB_UNI_WEIGHTS_SHA256", "WB_RESNET18_WEIGHTS",
       "WB_RESNET18_WEIGHTS_SHA256", "WB_MIDNIGHT_WEIGHTS", "WB_MIDNIGHT_WEIGHTS_SHA256", "WB_HIBOU_B_WEIGHTS",
       "WB_HIBOU_B_LICENSE_ACCEPTED", "WB_HIBOU_B_WEIGHTS_SHA256", "WB_ML_DEVICE", "WB_ML_CPU_THREADS")
TINY_VIT = {"embed_dim": 32, "depth": 2, "num_heads": 2}
TINY_DINO = {"hidden_size": 32, "num_hidden_layers": 2, "num_attention_heads": 2, "patch_size": 14, "image_size": 224}


@pytest.fixture(autouse=True)
def _isolated(monkeypatch):
    for name in ENV:
        monkeypatch.delenv(name, raising=False)
    # The adapters force these on; register them so monkeypatch restores the original values.
    for name in ("HF_HUB_OFFLINE", "TRANSFORMERS_OFFLINE", "HF_HUB_DISABLE_TELEMETRY"):
        monkeypatch.setenv(name, os.environ.get(name, "1"))
    encoders.clear_loaded_encoders()
    yield
    encoders.clear_loaded_encoders()


def _patches(n: int, seed: int = 0, size: int = 224) -> np.ndarray:
    return np.random.default_rng(seed).integers(0, 256, size=(n, size, size, 3), dtype=np.uint8)


# --------------------------------------------------------------------------- tiny builders


def tiny_uni_spec(**kwargs) -> encoders.EncoderSpec:
    arch = copy.deepcopy(encoders.UNI_SPEC.architecture)
    arch["kwargs"].update({**TINY_VIT, **kwargs})
    return dataclasses.replace(encoders.UNI_SPEC, architecture=arch, embedding_dim=arch["kwargs"]["embed_dim"])


def tiny_vit_state(spec: encoders.EncoderSpec, seed: int) -> dict:
    torch.manual_seed(seed)
    arch = spec.architecture
    model = timm.create_model(arch["model"], pretrained=False, **arch["kwargs"])
    with torch.no_grad():  # LayerScale starts at 1e-5; make the blocks matter for the test
        for name, p in model.named_parameters():
            if name.endswith(("ls1.gamma", "ls2.gamma")):
                p.fill_(0.5)
    return model.eval().state_dict()


def write_uni(path: Path, spec: encoders.EncoderSpec, seed: int = 0, state: dict | None = None) -> Path:
    torch.save(state if state is not None else tiny_vit_state(spec, seed), path)
    return path


@pytest.fixture()
def uni(tmp_path, monkeypatch):
    spec = tiny_uni_spec()
    path = write_uni(tmp_path / "pytorch_model.bin", spec)
    monkeypatch.setenv("WB_UNI_WEIGHTS", str(path))
    monkeypatch.setenv("WB_UNI_LICENSE_ACCEPTED", "1")
    return encoders.UNIEncoder(spec), path, spec


def tiny_dino_spec(base: encoders.EncoderSpec, expected: dict, dim: int) -> encoders.EncoderSpec:
    arch = copy.deepcopy(base.architecture)
    arch["expected_config"] = expected
    return dataclasses.replace(base, architecture=arch, embedding_dim=dim)


def write_hf_dir(directory: Path, config, model_cls, seed: int = 0, *, config_override: dict | None = None):
    directory.mkdir(parents=True, exist_ok=True)
    torch.manual_seed(seed)
    model = model_cls(config).eval()
    safetensors_torch.save_file({k: v.contiguous() for k, v in model.state_dict().items()},
                                str(directory / "model.safetensors"))
    cfg = config.to_dict()
    cfg.update(config_override or {})
    (directory / "config.json").write_text(json.dumps(cfg))
    return model


@pytest.fixture()
def midnight(tmp_path, monkeypatch):
    config = transformers.Dinov2Config(**TINY_DINO, use_swiglu_ffn=True)
    model = write_hf_dir(tmp_path / "midnight", config, transformers.Dinov2Model)
    spec = tiny_dino_spec(encoders.MIDNIGHT_SPEC, {"hidden_size": 32, "num_hidden_layers": 2, "patch_size": 14,
                                                   "use_swiglu_ffn": True}, 64)
    monkeypatch.setenv("WB_MIDNIGHT_WEIGHTS", str(tmp_path / "midnight"))
    return encoders.MidnightEncoder(spec), model, tmp_path / "midnight"


@pytest.fixture()
def hibou(tmp_path, monkeypatch):
    config = transformers.Dinov2WithRegistersConfig(**TINY_DINO, num_register_tokens=4)
    # Shaped like the official release: model_type dinov2 with an auto_map to remote code (ignored here).
    model = write_hf_dir(tmp_path / "hibou", config, transformers.Dinov2WithRegistersModel,
                         config_override={"model_type": "dinov2",
                                          "auto_map": {"AutoModel": "modeling_dinov2.Dinov2Model"}})
    spec = tiny_dino_spec(encoders.HIBOU_B_SPEC, {"hidden_size": 32, "patch_size": 14, "num_register_tokens": 4}, 32)
    monkeypatch.setenv("WB_HIBOU_B_WEIGHTS", str(tmp_path / "hibou"))
    monkeypatch.setenv("WB_HIBOU_B_LICENSE_ACCEPTED", "1")
    return encoders.HibouBEncoder(spec), model, tmp_path / "hibou"


# --------------------------------------------------------------------------- identity and cache


def test_weights_hash_is_bound_to_the_bytes_loaded(uni):
    adapter, path, spec = uni
    assert adapter.status() == ("available", None)
    loaded = adapter.load(device="cpu")
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    assert loaded.weights_sha256 == digest == adapter.weights_sha256()
    out = loaded.embed_batch(_patches(3))
    assert out.shape == (3, 32) and out.dtype == np.float32 and np.isfinite(out).all()
    ident = loaded.identity()
    assert ident["spec_sha256"] == spec.spec_sha256() != encoders.UNI_SPEC.spec_sha256()
    assert ident["device"] == "cpu" and ident["precision"] == "fp32" and ident["libraries"]["timm"] == timm.__version__
    assert ident["runtime"]["cpu_threads"] == devices.DEFAULT_CPU_THREADS
    # Second load: served from the cache (same bytes, same device and precision).
    assert adapter.load(device="cpu") is loaded
    assert encoders.loaded_encoder_keys() == [(spec.id, spec.spec_sha256(), digest, None, "cpu", "fp32")]
    described = adapter.describe()
    assert described["weights_sha256"] == digest and described["spec_sha256"] == spec.spec_sha256()


def test_changed_file_is_rebuilt_in_the_same_process(uni):
    adapter, path, spec = uni
    first = adapter.load()
    e1 = first.embed_batch(_patches(2))
    st = path.stat()
    write_uni(path, spec, seed=1)  # same path, same size: new weights
    os.utime(path, ns=(st.st_atime_ns, st.st_mtime_ns))  # restore the mtime, as cp -p or rsync -t would
    assert path.stat().st_size == st.st_size and path.stat().st_mtime_ns == st.st_mtime_ns
    second = adapter.load()
    assert second is not first and second.weights_sha256 != first.weights_sha256
    assert second.weights_sha256 == hashlib.sha256(path.read_bytes()).hexdigest()
    e2 = second.embed_batch(_patches(2))
    assert not np.allclose(e1, e2)
    assert np.array_equal(first.embed_batch(_patches(2)), e1)  # a held object stays bound to its own bytes
    assert [k[2] for k in encoders.loaded_encoder_keys()] == [second.weights_sha256]  # stale entry evicted


def test_file_sha256_memo_is_not_fooled_by_same_size_rewrite(tmp_path):
    p = tmp_path / "w.bin"
    p.write_bytes(b"A" * 1000)
    a = encoders.file_sha256(p)
    st = p.stat()
    p.write_bytes(b"B" * 1000)
    os.utime(p, ns=(st.st_atime_ns, st.st_mtime_ns))
    assert encoders.file_sha256(p) == hashlib.sha256(b"B" * 1000).hexdigest() != a


def test_expected_sha_mismatch_and_env_pin(uni, monkeypatch):
    adapter, path, _ = uni
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    with pytest.raises(EncoderIdentityMismatch) as err:
        adapter.load(expected_weights_sha256="0" * 64)
    assert err.value.status == "weights_mismatch" and err.value.actual == digest and err.value.expected == "0" * 64
    assert isinstance(err.value, EncoderUnavailable)  # callers that catch EncoderUnavailable fail permanently
    assert encoders.loaded_encoder_keys() == []  # nothing was cached under a refused identity
    assert adapter.load(expected_weights_sha256=digest.upper()).weights_sha256 == digest
    # The cached model is not served past a pin either.
    monkeypatch.setenv("WB_UNI_WEIGHTS_SHA256", "f" * 64)
    status, detail = adapter.status()
    assert status == "weights_mismatch" and "WB_UNI_WEIGHTS_SHA256 pins" in detail and digest in detail
    with pytest.raises(EncoderIdentityMismatch, match="WB_UNI_WEIGHTS_SHA256"):
        adapter.load()
    with pytest.raises(EncoderUnavailable):
        adapter.require_available()
    monkeypatch.setenv("WB_UNI_WEIGHTS_SHA256", "not-a-sha")
    assert adapter.status()[0] == "weights_mismatch" and "64-character" in adapter.status()[1]
    monkeypatch.setenv("WB_UNI_WEIGHTS_SHA256", digest)
    assert adapter.status() == ("available", None) and adapter.load().weights_sha256 == digest
    with pytest.raises(ValueError):
        adapter.load(expected_weights_sha256="xyz")


# --------------------------------------------------------------------------- strict loading and dims


def test_strict_load_fails_loudly(uni, tmp_path, monkeypatch):
    adapter, path, spec = uni
    good = tiny_vit_state(spec, 0)
    missing = dict(good)
    missing.pop("blocks.1.mlp.fc2.weight")
    unexpected = {**good, "head.weight": torch.zeros(10, 32)}
    deeper = tiny_vit_state(tiny_uni_spec(depth=3), 0)
    wider = tiny_vit_state(tiny_uni_spec(embed_dim=48, num_heads=2), 0)
    for state, needle in ((missing, "Missing key"), (unexpected, "Unexpected key"), (deeper, "Unexpected key"),
                          (wider, "size mismatch")):
        write_uni(path, spec, state=state)
        assert adapter.status() == ("available", None)  # the format is valid; the strict load is what fails
        with pytest.raises(EncoderLoadError) as err:
            adapter.load()
        assert needle in str(err.value) and err.value.status == "weights_mismatch"
        assert encoders.loaded_encoder_keys() == []
    # A wrapped checkpoint ({"state_dict": ...}) is not unwrapped silently.
    write_uni(path, spec, state={"state_dict": good})
    with pytest.raises(EncoderLoadError):
        adapter.load()


def test_output_dimension_must_match_the_spec(uni):
    adapter, _, spec = uni
    wrong = encoders.UNIEncoder(dataclasses.replace(spec, embedding_dim=33))
    with pytest.raises(EncoderLoadError, match="spec says"):
        wrong.load()


def test_status_reports_everything_missing_at_once(monkeypatch, tmp_path):
    adapter = encoders.UNIEncoder()
    status, detail = adapter.status()
    assert status == "missing_weights"
    assert "WB_UNI_WEIGHTS is not set" in detail and "WB_UNI_LICENSE_ACCEPTED=1 is not set" in detail
    garbage = tmp_path / "pytorch_model.bin"
    garbage.write_bytes(b"\x00garbage")
    monkeypatch.setenv("WB_UNI_WEIGHTS", str(tmp_path))  # a directory holding pytorch_model.bin is accepted
    monkeypatch.setenv("WB_UNI_LICENSE_ACCEPTED", "1")
    status, detail = adapter.status()
    assert status == "weights_mismatch" and "not a PyTorch checkpoint" in detail and str(garbage) in detail
    with pytest.raises(EncoderLoadError):
        adapter.load()
    resnet = encoders.GenericResNet18Encoder()
    monkeypatch.setenv("WB_RESNET18_WEIGHTS", str(tmp_path / "nope"))
    assert resnet.status()[0] == "missing_weights" and "does not exist" in resnet.status()[1]


# --------------------------------------------------------------------------- preprocessing and input size


def _capture_input(module):
    seen = {}

    def hook(_mod, args):
        seen["x"] = args[0].detach().float().cpu().clone()

    return seen, module.register_forward_pre_hook(hook)


def _expected_normalised(x: np.ndarray, spec) -> np.ndarray:
    mean = np.array(spec.mean, dtype=np.float32).reshape(1, 3, 1, 1)
    std = np.array(spec.std, dtype=np.float32).reshape(1, 3, 1, 1)
    return (x.transpose(0, 3, 1, 2).astype(np.float32) / 255.0 - mean) / std


def test_preprocessing_constants_are_applied(uni, midnight, hibou):
    x = _patches(2, seed=3)
    cases = ((uni[0], lambda m: m.patch_embed.proj, encoders.IMAGENET_MEAN),
             (midnight[0], lambda m: m.embeddings.patch_embeddings.projection, (0.5, 0.5, 0.5)),
             (hibou[0], lambda m: m.embeddings.patch_embeddings.projection, (0.7068, 0.5755, 0.722)))
    for adapter, first_layer, mean in cases:
        assert adapter.spec.mean == mean
        loaded = adapter.load()
        seen, handle = _capture_input(first_layer(loaded.model))
        try:
            loaded.embed_batch(x)
        finally:
            handle.remove()
        np.testing.assert_allclose(seen["x"].numpy(), _expected_normalised(x, adapter.spec), rtol=0, atol=1e-6)
        assert seen["x"].shape == (2, 3, 224, 224)
    # The pure function agrees too, and a mid-grey pixel lands where the constants say.
    t = encoders.preprocess(np.full((1, 224, 224, 3), 128, np.uint8), encoders.UNI_SPEC)
    assert t.is_contiguous() and t.dtype == torch.float32
    assert float(t[0, 0, 0, 0]) == pytest.approx((128 / 255 - 0.485) / 0.229, abs=1e-6)


def test_wrong_patch_size_dtype_or_shape_is_refused(uni):
    from PIL import Image

    adapter, _, _ = uni
    loaded = adapter.load()
    for bad in (_patches(1, size=256), np.zeros((1, 224, 223, 3), np.uint8), np.zeros((1, 224, 224, 3), np.float32),
                np.zeros((1, 224, 224, 4), np.uint8), np.zeros((224, 224, 3), np.uint8), [[0]]):
        with pytest.raises(EncoderInputError):
            loaded.embed_batch(bad)
    assert loaded.embed_batch(np.zeros((0, 224, 224, 3), np.uint8)).shape == (0, 32)
    ctx = encoders.EmbedContext(slide_sha256="ab" * 32, seed=0)
    with pytest.raises(EncoderInputError, match="never resizes"):
        adapter.embed([Image.new("RGB", (256, 256))], np.zeros((1, 2), np.int64), ctx)


# --------------------------------------------------------------------------- pooling per architecture


def test_midnight_concatenates_cls_and_mean_patch_tokens(midnight):
    adapter, model, _ = midnight
    assert adapter.status() == ("available", None)
    loaded = adapter.load()
    x = _patches(3, seed=5)
    out = loaded.embed_batch(x)
    assert out.shape == (3, 64)
    with torch.inference_mode():
        h = model(pixel_values=encoders.preprocess(x, adapter.spec)).last_hidden_state
    expected = torch.cat([h[:, 0], h[:, 1:].mean(dim=1)], dim=-1).numpy()
    np.testing.assert_allclose(out, expected, rtol=1e-4, atol=1e-5)
    assert loaded.config_sha256 == hashlib.sha256((midnight[2] / "config.json").read_bytes()).hexdigest()
    assert loaded.weights_sha256 == hashlib.sha256((midnight[2] / "model.safetensors").read_bytes()).hexdigest()


def test_hibou_maps_onto_native_register_dinov2_without_remote_code(hibou):
    adapter, model, directory = hibou
    assert adapter.status() == ("available", None)
    loaded = adapter.load()
    assert loaded.runtime["ignored_auto_map"] is True
    assert type(loaded.model).__name__ == "Dinov2WithRegistersModel"
    x = _patches(2, seed=6)
    with torch.inference_mode():
        expected = model(pixel_values=encoders.preprocess(x, adapter.spec)).pooler_output.numpy()
    np.testing.assert_allclose(loaded.embed_batch(x), expected, rtol=1e-4, atol=1e-5)


def test_hf_dir_status_says_exactly_what_is_wrong(hibou, monkeypatch):
    adapter, _, directory = hibou
    cfg = json.loads((directory / "config.json").read_text())
    # A local preprocessor config that disagrees with the provisional constants is refused.
    (directory / "preprocessor_config.json").write_text(json.dumps({"image_mean": [0.485, 0.456, 0.406],
                                                                    "image_std": [0.229, 0.224, 0.225]}))
    status, detail = adapter.status()
    assert status == "weights_mismatch" and "preprocessor_config.json declares image_mean" in detail
    for malformed in ({"image_mean": "abc"}, {"image_std": 0.5}, [1, 2, 3]):  # reported, never a crash
        (directory / "preprocessor_config.json").write_text(json.dumps(malformed))
        assert adapter.status()[0] == "weights_mismatch"
    (directory / "preprocessor_config.json").write_text(json.dumps({"image_mean": list(adapter.spec.mean),
                                                                    "image_std": list(adapter.spec.std)}))
    assert adapter.status() == ("available", None)
    # Config fields the spec pins must be present and equal.
    (directory / "config.json").write_text(json.dumps({k: v for k, v in cfg.items() if k != "num_register_tokens"}))
    status, detail = adapter.status()
    assert status == "weights_mismatch" and "lacks 'num_register_tokens'" in detail
    (directory / "config.json").write_text(json.dumps({**cfg, "hidden_size": 64}))
    assert "hidden_size=64" in adapter.status()[1]
    (directory / "config.json").write_text(json.dumps({**cfg, "model_type": "vit"}))
    assert "model_type 'vit'" in adapter.status()[1]
    with pytest.raises(EncoderLoadError):
        adapter.load()
    (directory / "config.json").write_text(json.dumps(cfg))
    (directory / "model.safetensors").write_bytes(b"\x05\x00\x00\x00\x00\x00\x00\x00{}")
    assert "not a safetensors file" in adapter.status()[1] or "without tensors" in adapter.status()[1]
    (directory / "model.safetensors").unlink()
    monkeypatch.delenv("WB_HIBOU_B_LICENSE_ACCEPTED")
    status, detail = adapter.status()
    assert status == "missing_weights" and "has no model.safetensors" in detail
    assert "WB_HIBOU_B_LICENSE_ACCEPTED=1 is not set" in detail and detail.endswith("Nothing is downloaded automatically.")


def test_resnet18_strict_load_then_identity_head(tmp_path, monkeypatch):
    torchvision = pytest.importorskip("torchvision")
    torch.manual_seed(0)
    state = torchvision.models.resnet18(weights=None).eval().state_dict()
    path = tmp_path / "resnet18.pth"
    torch.save(state, path)
    monkeypatch.setenv("WB_RESNET18_WEIGHTS", str(path))
    adapter = encoders.GenericResNet18Encoder()
    assert adapter.status() == ("available", None)
    out = adapter.load().embed_batch(_patches(2))
    assert out.shape == (2, 512)
    torch.save({k: v for k, v in state.items() if not k.startswith("fc.")}, path)  # the file must keep its fc
    with pytest.raises(EncoderLoadError, match="Missing key"):
        adapter.load()


# --------------------------------------------------------------------------- offline, legacy path, determinism


def test_loading_never_touches_the_network_or_the_hub(uni, midnight, hibou, monkeypatch):
    import huggingface_hub
    import huggingface_hub.constants

    attempts: list = []

    def refuse(*args, **kwargs):
        attempts.append((args, kwargs))
        raise OSError("network disabled in this test")

    monkeypatch.setattr(socket.socket, "connect", refuse)
    monkeypatch.setattr(socket.socket, "connect_ex", refuse)
    monkeypatch.setattr(socket, "create_connection", refuse)
    monkeypatch.setattr(urllib.request, "urlopen", refuse)
    for owner, name in ((huggingface_hub, "hf_hub_download"), (huggingface_hub, "snapshot_download"),
                        (transformers.PreTrainedModel, "from_pretrained"), (torch.hub, "load_state_dict_from_url"),
                        (torch.hub, "download_url_to_file")):
        monkeypatch.setattr(owner, name, refuse)
    monkeypatch.setattr(huggingface_hub.constants, "HF_HUB_OFFLINE", False)
    x = _patches(2)
    for adapter, *_ in (uni, midnight, hibou):
        assert adapter.load().embed_batch(x).shape[0] == 2
    assert attempts == []
    assert os.environ["HF_HUB_OFFLINE"] == "1" and os.environ["TRANSFORMERS_OFFLINE"] == "1"
    assert huggingface_hub.constants.HF_HUB_OFFLINE is True
    for adapter, *_ in (uni, midnight, hibou):
        assert adapter.spec.architecture.get("trust_remote_code", False) is False


def test_legacy_embed_and_cache_identity_use_the_loaded_bytes(uni):
    from PIL import Image

    adapter, path, spec = uni
    x = _patches(3, seed=9)
    ctx = encoders.EmbedContext(slide_sha256="ab" * 32, seed=0)
    legacy = adapter.embed([Image.fromarray(p) for p in x], np.zeros((3, 2), np.int64), ctx)
    np.testing.assert_array_equal(legacy, adapter.load().embed_batch(x))
    weights, extra = adapter.cache_identity({})
    assert weights == hashlib.sha256(path.read_bytes()).hexdigest()
    assert extra == {"spec_sha256": spec.spec_sha256(), "adapter_version": spec.adapter_version, "device": "cpu",
                     "precision": "fp32"}
    assert adapter.config_from_params({"synthetic_dim": 64}) == {}
    with pytest.raises(ValueError, match="needs pixels"):
        adapter.embed(None, np.zeros((1, 2), np.int64), ctx)


def test_inference_is_deterministic_and_restores_torch_state(uni):
    adapter, _, _ = uni
    loaded = adapter.load()
    threads, det = torch.get_num_threads(), torch.are_deterministic_algorithms_enabled()
    x = _patches(4, seed=2)
    a = loaded.embed_batch(x)
    assert a.tobytes() == loaded.embed_batch(x).tobytes()
    assert torch.get_num_threads() == threads and torch.are_deterministic_algorithms_enabled() == det


def test_device_and_precision_requests_are_validated(uni):
    adapter, _, _ = uni
    if not torch.cuda.is_available():
        with pytest.raises(devices.DeviceUnavailable):
            adapter.load(device="cuda")
    with pytest.raises(devices.DeviceUnavailable):
        adapter.load(device="tpu")
    with pytest.raises(ValueError):
        adapter.load(precision="fp8")


# --------------------------------------------------------------------------- precision comparison


def test_compare_precision_on_cpu(uni):
    adapter, _, _ = uni
    ref = adapter.load(device="cpu", precision="fp32")
    patches = _patches(32, seed=4)
    same = devices.compare_precision(ref, ref, patches)
    assert same["cosine_min"] == pytest.approx(1.0) and same["max_abs_diff"] == 0.0 and same["rel_l2"] == 0.0
    assert same["accepted"] is True and same["reasons"] == []
    few = devices.compare_precision(ref, ref, patches[:4])
    assert few["accepted"] is False and "only 4 patches" in few["reasons"][0]
    ok, _ = devices.precision_supported("cpu", "bf16")
    if ok:
        low = adapter.load(device="cpu", precision="bf16")
        assert low is not ref and low.precision == "bf16" and low.weights_sha256 == ref.weights_sha256
        cmp = devices.compare_precision(ref, low, patches)
        assert {"cosine_min", "cosine_mean", "max_abs_diff", "rel_l2"} <= set(cmp)
        assert 0.9 < cmp["cosine_min"] <= cmp["cosine_mean"] <= 1.0 and 0 < cmp["max_abs_diff"] and cmp["rel_l2"] > 0
        assert cmp["accepted"] == (cmp["cosine_min"] >= 0.999 and cmp["rel_l2"] <= 0.05)
        with pytest.raises(ValueError, match="reference must be fp32"):
            devices.compare_precision(low, ref, patches)
    with pytest.raises(ValueError, match="same encoder spec"):
        devices.compare_precision(ref, _fake_loaded(tiny_uni_spec(depth=3), ref.weights_sha256), patches)
    with pytest.raises(ValueError, match="same weights"):
        devices.compare_precision(ref, _fake_loaded(ref.spec, "0" * 64), patches)


def _fake_loaded(spec, weights_sha256):
    return encoders.LoadedEncoder(spec=spec, weights_sha256=weights_sha256, device="cpu", precision="fp16",
                                  embed_fn=lambda x: np.zeros((len(x), spec.embedding_dim), np.float32))


def test_compare_precision_rejects_non_finite_candidate(uni):
    adapter, _, spec = uni
    ref = adapter.load()
    broken = encoders.LoadedEncoder(spec=spec, weights_sha256=ref.weights_sha256, device="cpu", precision="fp16",
                                    embed_fn=lambda x: np.full((len(x), spec.embedding_dim), np.inf, np.float32))
    cmp = devices.compare_precision(ref, broken, _patches(32))
    assert cmp["accepted"] is False and cmp["all_finite"] is False and "non-finite" in cmp["reasons"][0]


@pytest.mark.skipif(not (hasattr(torch.backends, "mps") and torch.backends.mps.is_available()),
                    reason="MPS is not available on this machine")
def test_compare_precision_cpu_fp32_against_mps_fp16(uni):
    adapter, _, _ = uni
    ref = adapter.load(device="cpu", precision="fp32")
    mps = adapter.load(device="mps", precision="fp16")
    assert mps.device == "mps" and mps is not ref
    cmp = devices.compare_precision(ref, mps, _patches(32, seed=8))
    assert cmp["candidate"] == {"device": "mps", "precision": "fp16"} and cmp["all_finite"] is True
    assert 0.9 < cmp["cosine_min"] <= 1.0
