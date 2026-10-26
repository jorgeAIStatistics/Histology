"""The hermetic pipeline-test fixture: the ONLY place a label-derived signal may enter an embedding.

Design contract §1, invariant 3 (``docs/ml-engine-design.md``):

* Real encoder adapters never see a label. Their embedding API takes pixels only, and the
  context type they receive (:class:`dermpath.ml.encoders.EmbedContext`) has no label field.
* The synthetic signal lives here. It is applied only through a :class:`FixtureContext`, and a
  ``FixtureContext`` can be created only by :func:`fixture_context`, which raises
  :class:`SyntheticSignalForbidden` unless the slide is ``demo_synthetic`` +
  ``synthetic_tiles`` AND the execution mode is ``synthetic_pipeline_test``.

What the fixture computes (unchanged from the original ``synthetic-deterministic-v1``)
------------------------------------------------------------------------------------
A pure function of (slide sha256, level-0 patch coordinates, seed); pixels are never read:

* base vector: ``standard_normal(dim)`` from PCG64 seeded by the first 8 bytes (little
  endian) of ``SHA-256(b"patch|" + key)`` with ``key = f"{slide_sha256}|seed={seed}|{x}|{y}"``;
* a per-slide nuisance offset (a stand-in for batch effects): ``0.3 * standard_normal(dim)``
  seeded by ``SHA-256(b"offset|" + slide_key)``;
* the fixture signal, only when the context label is 1: for the patches with
  ``u < signal_fraction`` (``u`` from ``SHA-256(b"signal|" + key)``), add
  ``signal_strength * direction``, a unit vector seeded by ``(seed, dim)``.

Labels 0 and ``None`` give identical output. The result carries NO pathology information;
everything computed from it is a PIPELINE TEST, not pathology validation.

Deprecated legacy path
----------------------
Until the phase-3 callers migrate, :mod:`dermpath.ml.features` still constructs
``EmbedContext(..., fixture_label=...)`` for the synthetic encoder. That constructor returns a
:class:`LegacySyntheticContext` (not an ``EmbedContext``), which only the synthetic adapter's
legacy ``embed`` accepts; every real adapter refuses it with
:class:`SyntheticSignalForbidden`. :func:`legacy_synthetic_embeddings` gives output identical
to :func:`synthetic_embeddings` for the same label. Both are removed once callers use
:func:`fixture_context`.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass, field

import numpy as np

SYNTHETIC_PROVENANCE = "demo_synthetic"
SYNTHETIC_IMAGE_KIND = "synthetic_tiles"
SYNTHETIC_PIPELINE_TEST = "synthetic_pipeline_test"
EXECUTION_MODES = ("synthetic_pipeline_test", "real_image_technical", "supervised_experiment")

DEFAULT_CONFIG = {"dim": 64, "signal_strength": 2.0, "signal_fraction": 0.3}
CONFIG_BOUNDS = {"dim": (8, 1024), "signal_strength": (0.0, 20.0), "signal_fraction": (0.0, 1.0)}


class SyntheticSignalForbidden(Exception):
    """A label-derived fixture signal was requested outside the synthetic pipeline test."""


_CONSTRUCTION_TOKEN = object()


def _refusals(slide_provenance: str, image_kind: str, execution_mode: str) -> list[str]:
    problems = []
    if slide_provenance != SYNTHETIC_PROVENANCE:
        problems.append(f"slide provenance is {slide_provenance!r} (needs {SYNTHETIC_PROVENANCE!r})")
    if image_kind != SYNTHETIC_IMAGE_KIND:
        problems.append(f"image kind is {image_kind!r} (needs {SYNTHETIC_IMAGE_KIND!r})")
    if execution_mode != SYNTHETIC_PIPELINE_TEST:
        problems.append(f"execution mode is {execution_mode!r} (needs {SYNTHETIC_PIPELINE_TEST!r})")
    return problems


def _check_allowed(slide_provenance: str, image_kind: str, execution_mode: str) -> None:
    problems = _refusals(slide_provenance, image_kind, execution_mode)
    if problems:
        raise SyntheticSignalForbidden("the synthetic fixture signal is forbidden here: " + "; ".join(problems)
                                       + ". It exists only for demo_synthetic synthetic_tiles slides in "
                                       "synthetic_pipeline_test mode.")


def _normalise_label(label) -> int | None:
    if label is None:
        return None
    if isinstance(label, (bool, np.bool_)) or label in (0, 1):
        value = int(label)
        if value in (0, 1):
            return value
    raise ValueError(f"fixture label must be 1 (positive), 0 (negative) or None (unknown), not {label!r}")


@dataclass(frozen=True)
class FixtureContext:
    """Permission to apply the fixture signal to one synthetic slide. Create it with :func:`fixture_context`.

    Direct construction (or :func:`dataclasses.replace`) re-runs the same checks, so a context
    for a real slide, a real image kind or another execution mode cannot exist.
    """

    slide_provenance: str
    image_kind: str
    execution_mode: str
    label: int | None
    _token: object = field(default=None, repr=False, compare=False)

    def __post_init__(self) -> None:
        if self._token is not _CONSTRUCTION_TOKEN:
            raise SyntheticSignalForbidden("FixtureContext can only be created by dermpath.ml.fixture.fixture_context()")
        _check_allowed(self.slide_provenance, self.image_kind, self.execution_mode)
        object.__setattr__(self, "label", _normalise_label(self.label))


def fixture_context(slide_provenance: str, image_kind: str, execution_mode: str, label) -> FixtureContext:
    """The only way to obtain a :class:`FixtureContext`.

    Raises :class:`SyntheticSignalForbidden` unless ``slide_provenance == "demo_synthetic"``,
    ``image_kind == "synthetic_tiles"`` and ``execution_mode == "synthetic_pipeline_test"``.
    ``label`` is the fixture label derived from the frozen manifest (1, 0 or ``None``).
    """
    _check_allowed(slide_provenance, image_kind, execution_mode)
    return FixtureContext(slide_provenance=slide_provenance, image_kind=image_kind, execution_mode=execution_mode,
                          label=label, _token=_CONSTRUCTION_TOKEN)


def synthetic_config(params: dict | None = None) -> dict:
    """Fixture config from experiment params (``synthetic_dim``, ``synthetic_signal_strength``,
    ``synthetic_signal_fraction``) or a config dict (``dim``, ``signal_strength``,
    ``signal_fraction``). Values outside :data:`CONFIG_BOUNDS` raise ``ValueError``."""
    params = params or {}
    cfg = {
        "dim": int(params.get("synthetic_dim", params.get("dim", DEFAULT_CONFIG["dim"]))),
        "signal_strength": float(params.get("synthetic_signal_strength",
                                            params.get("signal_strength", DEFAULT_CONFIG["signal_strength"]))),
        "signal_fraction": float(params.get("synthetic_signal_fraction",
                                            params.get("signal_fraction", DEFAULT_CONFIG["signal_fraction"]))),
    }
    for key, (lo, hi) in CONFIG_BOUNDS.items():
        if not lo <= cfg[key] <= hi:
            raise ValueError(f"synthetic fixture {key}={cfg[key]} is outside [{lo}, {hi}]")
    return cfg


def _u64(data: bytes) -> int:
    return int.from_bytes(hashlib.sha256(data).digest()[:8], "little")


def _embed(coords: np.ndarray, *, slide_sha256: str, seed: int, config: dict, signal_label: int | None) -> np.ndarray:
    dim = int(config["dim"])
    coords = np.asarray(coords)
    n = int(coords.shape[0])
    out = np.empty((n, dim), dtype=np.float64)
    slide_key = f"{slide_sha256}|seed={seed}".encode()
    # A per-slide nuisance offset (a stand-in for batch effects) and a fixed signal direction.
    slide_offset = np.random.default_rng(_u64(b"offset|" + slide_key)).standard_normal(dim) * 0.3
    direction = np.random.default_rng(_u64(f"direction|{seed}|{dim}".encode())).standard_normal(dim)
    direction /= np.linalg.norm(direction)
    for i in range(n):
        x, y = int(coords[i, 0]), int(coords[i, 1])
        pk = slide_key + f"|{x}|{y}".encode()
        vec = np.random.default_rng(_u64(b"patch|" + pk)).standard_normal(dim) + slide_offset
        if signal_label == 1:
            u = (_u64(b"signal|" + pk) % 1_000_000) / 1_000_000.0
            if u < config["signal_fraction"]:
                vec = vec + config["signal_strength"] * direction
        out[i] = vec
    return out.astype(np.float32)


def synthetic_embeddings(ctx: FixtureContext, coords: np.ndarray, *, slide_sha256: str, seed: int,
                         config: dict | None = None) -> np.ndarray:
    """``synthetic-deterministic-v1`` embeddings (float32 ``(N, dim)``) for one synthetic slide.

    ``ctx`` must come from :func:`fixture_context`; the checks are repeated here, so a context
    can never authorise a real slide or another execution mode.
    """
    if type(ctx) is not FixtureContext:
        raise SyntheticSignalForbidden("synthetic-deterministic-v1 needs a FixtureContext from fixture_context(); "
                                       f"got {type(ctx).__name__}")
    _check_allowed(ctx.slide_provenance, ctx.image_kind, ctx.execution_mode)
    return _embed(coords, slide_sha256=slide_sha256, seed=int(seed), config=synthetic_config(config),
                  signal_label=ctx.label)


# --------------------------------------------------------------------------- deprecated legacy path


@dataclass(frozen=True)
class LegacySyntheticContext:
    """DEPRECATED label carrier for the pre-fixture synthetic path (removed in phase 3).

    Returned by ``EmbedContext(..., fixture_label=<not None>)``. It is deliberately NOT an
    ``EmbedContext``: only the synthetic adapter's legacy ``embed`` accepts it, and every real
    adapter refuses it.
    """

    slide_sha256: str
    seed: int
    fixture_label: int | None
    config: dict = field(default_factory=dict)


def legacy_synthetic_embeddings(coords: np.ndarray, *, slide_sha256: str, seed: int, config: dict | None,
                                fixture_label: int | None) -> np.ndarray:
    """DEPRECATED: the pre-fixture synthetic path, kept so :mod:`dermpath.ml.features` keeps
    working until phase 3. It applies the signal from a bare label without provenance or mode
    checks; output is identical to :func:`synthetic_embeddings` for the same label."""
    cfg = synthetic_config(config) if config else dict(DEFAULT_CONFIG)
    return _embed(coords, slide_sha256=slide_sha256, seed=int(seed), config=cfg,
                  signal_label=_normalise_label(fixture_label))
