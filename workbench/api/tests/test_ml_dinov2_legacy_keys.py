"""Legacy (transformers 4.x) Dinov2 checkpoints load through the hashed-bytes path exactly as from_pretrained does.

Midnight-12k was saved with transformers 4.43, whose Dinov2 parameter names differ from transformers 5. The adapter
loads from the exact bytes it hashed (not from_pretrained), so it applies the same renaming rules itself. These tests
prove parity against transformers' own conversion in both directions on tiny random models: transformers'
revert_weight_conversion produces the legacy layout, and from_pretrained is the reference loader.
"""

from __future__ import annotations

import json

import pytest

torch = pytest.importorskip("torch")
transformers = pytest.importorskip("transformers")
safetensors_torch = pytest.importorskip("safetensors.torch")
from transformers.core_model_loading import revert_weight_conversion  # noqa: E402

from dermpath.ml import encoders  # noqa: E402


def _tiny(model_cls, config_cls, **extra):
    cfg = config_cls(hidden_size=32, num_hidden_layers=2, num_attention_heads=4, use_swiglu_ffn=True, image_size=28,
                     patch_size=14, layerscale_value=1.0, **extra)
    torch.manual_seed(0)
    return model_cls(cfg).eval(), cfg


@pytest.mark.parametrize("registers", [False, True])
def test_legacy_layout_converts_to_the_from_pretrained_result(tmp_path, registers):
    if registers:
        model, cfg = _tiny(transformers.Dinov2WithRegistersModel, transformers.Dinov2WithRegistersConfig,
                           num_register_tokens=4)
    else:
        model, cfg = _tiny(transformers.Dinov2Model, transformers.Dinov2Config)
    legacy = revert_weight_conversion(model, {k: v.clone() for k, v in model.state_dict().items()})
    assert any(".mlp.weights_in." in k for k in legacy), "transformers no longer produces the legacy layout"
    safetensors_torch.save_file({k: v.contiguous() for k, v in legacy.items()}, str(tmp_path / "model.safetensors"))
    (tmp_path / "config.json").write_text(json.dumps(cfg.to_dict()))

    converted, report = encoders.convert_legacy_dinov2_state(dict(legacy))
    assert report["split"] == 2 * cfg.num_hidden_layers and report["renamed"] > 0
    rebuilt = type(model)(cfg).eval()
    rebuilt.load_state_dict(converted, strict=True)
    reference = type(model).from_pretrained(str(tmp_path), local_files_only=True).eval()
    x = torch.randn(2, 3, 28, 28)
    with torch.inference_mode():
        ours = rebuilt(pixel_values=x).last_hidden_state
        ref = reference(pixel_values=x).last_hidden_state
    assert torch.allclose(ours, ref, atol=1e-6)


def test_new_layout_passes_through_unchanged():
    model, _ = _tiny(transformers.Dinov2Model, transformers.Dinov2Config)
    state = model.state_dict()
    converted, report = encoders.convert_legacy_dinov2_state(dict(state))
    assert report == {**report, "renamed": 0, "split": 0}
    assert set(converted) == set(state)


def test_unknown_layout_still_fails_strict_loading():
    model, cfg = _tiny(transformers.Dinov2Model, transformers.Dinov2Config)
    state = {k.replace(".mlp.", ".ffn_unknown."): v for k, v in model.state_dict().items()}
    converted, _ = encoders.convert_legacy_dinov2_state(state)
    with pytest.raises(RuntimeError):
        type(model)(cfg).load_state_dict(converted, strict=True)


def test_odd_fused_projection_is_refused():
    with pytest.raises(ValueError):
        encoders.convert_legacy_dinov2_state({"encoder.layer.0.mlp.weights_in.weight": torch.zeros(3, 2)})
