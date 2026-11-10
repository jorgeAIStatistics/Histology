"""``handcrafted-stain-texture-v1``: weights-free, label-free, deterministic, and sensitive to pixels."""

from __future__ import annotations

import inspect

import numpy as np
import pytest
from PIL import Image

from dermpath.ml import encoders, handcrafted

NAMES = handcrafted.FEATURE_NAMES


def _patch(rgb, size=224) -> np.ndarray:
    return np.broadcast_to(np.array(rgb, dtype=np.uint8), (size, size, 3)).copy()


def _he_like(seed: int) -> np.ndarray:
    """A deterministic textured H&E-like patch: pink stroma with purple nuclei-like blobs."""
    rng = np.random.default_rng(seed)
    img = np.empty((224, 224, 3), dtype=np.float64)
    img[:] = (225, 160, 200)
    yy, xx = np.mgrid[0:224, 0:224]
    for cy, cx in rng.integers(10, 214, size=(40, 2)):
        img[(yy - cy) ** 2 + (xx - cx) ** 2 < 36] = (90, 50, 140)
    img += rng.normal(0, 6, img.shape)
    return np.clip(img, 0, 255).astype(np.uint8)


def _f(patch: np.ndarray, name: str) -> float:
    return float(handcrafted.features(patch[None])[0, NAMES.index(name)])


def test_shape_names_and_finiteness_on_extreme_patches():
    batch = np.stack([_patch((255, 255, 255)), _patch((0, 0, 0)), _he_like(0),
                      np.random.default_rng(1).integers(0, 256, (224, 224, 3), dtype=np.uint8)])
    out = handcrafted.features(batch)
    assert out.shape == (4, 64) and out.dtype == np.float32 and np.isfinite(out).all()
    assert len(NAMES) == len(set(NAMES)) == handcrafted.EMBEDDING_DIM == 64
    lbp = out[:, NAMES.index("lbp_riu2_0"):NAMES.index("lbp_riu2_nonuniform") + 1]
    assert np.allclose(lbp.sum(axis=1), 1.0, atol=1e-5)  # a normalised histogram
    assert handcrafted.features(np.zeros((0, 224, 224, 3), np.uint8)).shape == (0, 64)


def test_deterministic_and_independent_of_batch_composition():
    batch = np.stack([_he_like(s) for s in range(5)])
    a = handcrafted.features(batch)
    assert a.tobytes() == handcrafted.features(batch).tobytes()
    one_by_one = np.concatenate([handcrafted.features(batch[i:i + 1]) for i in range(5)])
    assert one_by_one.tobytes() == a.tobytes()
    reordered = handcrafted.features(batch[::-1])[::-1]
    assert reordered.tobytes() == a.tobytes()


def test_identical_patches_identical_rows_and_different_patches_differ():
    p, q = _he_like(3), _he_like(4)
    out = handcrafted.features(np.stack([p, p.copy(), q]))
    assert np.array_equal(out[0], out[1])
    assert not np.array_equal(out[0], out[2])
    # A single changed pixel changes the features: they read the pixels.
    r = p.copy()
    r[100, 100] = (0, 0, 0)
    assert not np.array_equal(handcrafted.features(r[None])[0], out[0])


def test_features_track_what_they_claim_to_measure():
    white, he = _patch((250, 250, 250)), _he_like(0)
    assert _f(white, "tissue_fraction") == 0.0 and _f(he, "tissue_fraction") > 0.95
    # Haematoxylin-like (blue-purple) vs eosin-like (pink) colour moves the deconvolved channels.
    purple, pink = _patch((80, 60, 150)), _patch((235, 140, 190))
    assert _f(purple, "h_mean") > _f(pink, "h_mean")
    assert _f(purple, "h_e_log_ratio_tissue") > _f(pink, "h_e_log_ratio_tissue")
    # Blur lowers the Laplacian variance and the gradient magnitude.
    blurred = np.asarray(Image.fromarray(he).resize((56, 56), Image.Resampling.BILINEAR)
                         .resize((224, 224), Image.Resampling.BILINEAR))
    assert _f(blurred, "log_laplacian_var") < _f(he, "log_laplacian_var")
    assert _f(blurred, "grad_mean") < _f(he, "grad_mean")
    # A flat patch is a single uniform LBP code (all neighbours >= centre: 8 ones).
    assert _f(white, "lbp_riu2_8") == pytest.approx(1.0)
    assert _f(_patch((10, 10, 10)), "dark_fraction") == 1.0 and _f(white, "bright_fraction") == 1.0


def test_wrong_size_or_dtype_is_refused_never_resized():
    with pytest.raises(ValueError, match="exactly 224x224"):
        handcrafted.features(np.zeros((1, 256, 256, 3), np.uint8))
    with pytest.raises(ValueError, match="uint8"):
        handcrafted.features(np.zeros((1, 224, 224, 3), np.float32))
    with pytest.raises(ValueError):
        handcrafted.features(np.zeros((1, 224, 224, 4), np.uint8))


def test_no_label_input_and_code_hash_identity():
    params = inspect.signature(handcrafted.features).parameters
    assert list(params) == ["patches_uint8", "input_size"]
    ident = handcrafted.code_identity()
    prefix = f"handcrafted:{handcrafted.ADAPTER_VERSION}:"
    assert ident.startswith(prefix) and len(ident) == len(prefix) + 64


def test_adapter_load_embed_and_legacy_path():
    adapter = encoders.get_encoder(encoders.HANDCRAFTED_ID)
    assert adapter.status() == ("available", None) and adapter.weights_sha256() == handcrafted.code_identity()
    loaded = adapter.load()
    assert loaded.weights_sha256 == handcrafted.code_identity() and loaded.device == "cpu"
    batch = np.stack([_he_like(0), _he_like(1)])
    assert np.array_equal(loaded.embed_batch(batch), handcrafted.features(batch))
    with pytest.raises(encoders.EncoderInputError):
        loaded.embed_batch(np.zeros((1, 112, 112, 3), np.uint8))
    with pytest.raises(encoders.EncoderIdentityMismatch):
        adapter.load(expected_weights_sha256="handcrafted:0:" + "0" * 64)
    with pytest.raises(ValueError):
        adapter.load(precision="bf16")
    # Legacy (features.py) path: PIL patches with a label-free EmbedContext.
    pil = [Image.fromarray(p) for p in batch]
    ctx = encoders.EmbedContext(slide_sha256="ab" * 32, seed=0)
    assert np.array_equal(adapter.embed(pil, np.zeros((2, 2), np.int64), ctx), handcrafted.features(batch))
    with pytest.raises(encoders.EncoderInputError):
        adapter.embed([Image.fromarray(_patch((1, 2, 3), 256))], np.zeros((1, 2), np.int64), ctx)
    weights, extra = adapter.cache_identity({})
    assert weights == handcrafted.code_identity() and extra["spec_sha256"] == adapter.spec.spec_sha256()
