"""The hermetic synthetic fixture (design §1 invariants 3–4): the label-derived signal exists only
in ``dermpath.ml.fixture``, behind a ``FixtureContext`` that cannot exist for real slides, real
image kinds or any mode other than ``synthetic_pipeline_test``."""

from __future__ import annotations

import dataclasses

import numpy as np
import pytest

from dermpath.ml import encoders, fixture
from dermpath.ml.fixture import SyntheticSignalForbidden

SHA = "ab" * 32
COORDS = np.array([[x, y] for x in range(0, 4480, 224) for y in range(0, 2240, 224)], dtype=np.int64)  # 200


def _ctx(label=1, **over):
    args = {"slide_provenance": "demo_synthetic", "image_kind": "synthetic_tiles",
            "execution_mode": "synthetic_pipeline_test", "label": label}
    args.update(over)
    return fixture.fixture_context(**args)


@pytest.mark.parametrize("override, needle", [
    ({"slide_provenance": "real_authorized"}, "slide provenance is 'real_authorized'"),
    ({"slide_provenance": "public_cc0"}, "slide provenance is 'public_cc0'"),
    ({"image_kind": "wsi"}, "image kind is 'wsi'"),
    ({"image_kind": "field_image"}, "image kind is 'field_image'"),
    ({"execution_mode": "supervised_experiment"}, "execution mode is 'supervised_experiment'"),
    ({"execution_mode": "real_image_technical"}, "execution mode is 'real_image_technical'"),
])
def test_fixture_context_refuses_real_provenance_kind_or_mode(override, needle):
    with pytest.raises(SyntheticSignalForbidden) as err:
        _ctx(**override)
    assert needle in str(err.value)


def test_fixture_context_lists_every_violation_at_once():
    with pytest.raises(SyntheticSignalForbidden) as err:
        fixture.fixture_context("real_authorized", "wsi", "supervised_experiment", 1)
    msg = str(err.value)
    assert "provenance" in msg and "image kind" in msg and "execution mode" in msg


def test_fixture_context_cannot_be_constructed_or_rewritten_directly():
    with pytest.raises(SyntheticSignalForbidden, match="fixture_context"):
        fixture.FixtureContext("demo_synthetic", "synthetic_tiles", "synthetic_pipeline_test", 1)
    ctx = _ctx()
    # replace() re-runs the checks: a context cannot be retargeted at a real slide or mode.
    with pytest.raises(SyntheticSignalForbidden):
        dataclasses.replace(ctx, slide_provenance="real_authorized")
    with pytest.raises(SyntheticSignalForbidden):
        dataclasses.replace(ctx, execution_mode="supervised_experiment")
    assert dataclasses.replace(ctx, label=0).label == 0
    with pytest.raises(dataclasses.FrozenInstanceError):
        ctx.slide_provenance = "real_authorized"


@pytest.mark.parametrize("label", [2, -1, "1", 0.5])
def test_fixture_label_must_be_binary_or_unknown(label):
    with pytest.raises(ValueError):
        _ctx(label=label)


def test_signal_only_for_positive_label_and_only_through_the_context():
    neg = fixture.synthetic_embeddings(_ctx(0), COORDS, slide_sha256=SHA, seed=7)
    unk = fixture.synthetic_embeddings(_ctx(None), COORDS, slide_sha256=SHA, seed=7)
    pos = fixture.synthetic_embeddings(_ctx(1), COORDS, slide_sha256=SHA, seed=7)
    assert neg.dtype == np.float32 and neg.shape == (200, 64)
    assert np.array_equal(neg, unk)  # 0 and None are identical: no signal
    moved = np.linalg.norm(pos - neg, axis=1) > 0
    assert 20 < int(moved.sum()) < 100  # about signal_fraction (0.3) of the patches
    assert np.allclose(np.linalg.norm((pos - neg)[moved], axis=1), 2.0, atol=1e-5)  # signal_strength
    # Deterministic and keyed by slide, coordinates and seed.
    assert np.array_equal(pos, fixture.synthetic_embeddings(_ctx(1), COORDS, slide_sha256=SHA, seed=7))
    assert not np.array_equal(neg, fixture.synthetic_embeddings(_ctx(0), COORDS, slide_sha256="cd" * 32, seed=7))
    assert not np.array_equal(neg, fixture.synthetic_embeddings(_ctx(0), COORDS, slide_sha256=SHA, seed=8))
    cfg = fixture.synthetic_embeddings(_ctx(0), COORDS[:3], slide_sha256=SHA, seed=7, config={"dim": 16})
    assert cfg.shape == (3, 16)


def test_synthetic_embeddings_refuse_anything_but_a_fixture_context():
    for bad in (None, 1, {"label": 1}, encoders.EmbedContext(SHA, 7), encoders.EmbedContext(SHA, 7, fixture_label=1)):
        with pytest.raises(SyntheticSignalForbidden):
            fixture.synthetic_embeddings(bad, COORDS, slide_sha256=SHA, seed=7)


def test_synthetic_config_bounds():
    assert fixture.synthetic_config({}) == fixture.DEFAULT_CONFIG
    assert fixture.synthetic_config({"synthetic_dim": 32, "synthetic_signal_strength": 1.5,
                                     "synthetic_signal_fraction": 0.1}) == {"dim": 32, "signal_strength": 1.5,
                                                                            "signal_fraction": 0.1}
    for bad in ({"synthetic_dim": 4}, {"synthetic_signal_strength": 50}, {"synthetic_signal_fraction": 1.5}):
        with pytest.raises(ValueError):
            fixture.synthetic_config(bad)


def test_legacy_path_is_label_free_and_every_adapter_refuses_the_label_carrier():
    """The legacy synthetic embed gives the fixture's label-free embeddings; the inert carrier returned by
    EmbedContext(..., fixture_label=...) is not an EmbedContext and every adapter (the synthetic one included)
    refuses it, as does legacy_synthetic_embeddings with a label: the signal comes only through fixture_context."""
    syn = encoders.get_encoder(encoders.SYNTHETIC_ID)
    cfg = syn.config_from_params({"synthetic_dim": 64, "synthetic_signal_strength": 2.0,
                                  "synthetic_signal_fraction": 0.3})
    plain = encoders.EmbedContext(slide_sha256=SHA, seed=7, config=cfg)
    assert type(plain) is encoders.EmbedContext and not hasattr(plain, "fixture_label")
    for label in (None, 0):
        assert np.array_equal(syn.embed(None, COORDS, plain),
                              fixture.synthetic_embeddings(_ctx(label), COORDS, slide_sha256=SHA, seed=7, config=cfg))
    assert syn.cache_identity(cfg) == (encoders.SYNTHETIC_WEIGHTS_MARKER, {"encoder_config": cfg})
    for label in (1, 0):
        carrier = encoders.EmbedContext(slide_sha256=SHA, seed=7, fixture_label=label, config=cfg)
        assert type(carrier) is not encoders.EmbedContext and carrier.fixture_label == label
        for encoder_id in (encoders.SYNTHETIC_ID, encoders.HANDCRAFTED_ID, encoders.UNI_ID, encoders.MIDNIGHT_ID,
                           encoders.HIBOU_B_ID, encoders.RESNET_ID):
            with pytest.raises(SyntheticSignalForbidden):
                encoders.get_encoder(encoder_id).embed([], COORDS[:0], carrier)
        with pytest.raises(SyntheticSignalForbidden):
            fixture.legacy_synthetic_embeddings(COORDS, slide_sha256=SHA, seed=7, config=cfg, fixture_label=label)


def test_synthetic_loaded_encoder_has_identity_but_never_embeds_pixels():
    loaded = encoders.get_encoder(encoders.SYNTHETIC_ID).load()
    assert loaded.weights_sha256 == encoders.SYNTHETIC_WEIGHTS_MARKER and loaded.spec.synthetic is True
    with pytest.raises(SyntheticSignalForbidden, match="FixtureContext"):
        loaded.embed_batch(np.zeros((1, 224, 224, 3), dtype=np.uint8))
    with pytest.raises(encoders.EncoderIdentityMismatch):
        encoders.get_encoder(encoders.SYNTHETIC_ID).load(expected_weights_sha256="0" * 64)
    with pytest.raises(ValueError):
        encoders.get_encoder(encoders.SYNTHETIC_ID).load(precision="fp16")
