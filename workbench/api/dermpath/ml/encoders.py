"""Encoder adapters: frozen specs, weights identity bound to the bytes loaded, offline only.

Contract: ``docs/ml-engine-design.md`` §1 (invariants 3–4) and §3. Research use only.

Adapters
--------
``synthetic-deterministic-v1``
    Hermetic pipeline-test embeddings (SHA-256 → PCG64 noise keyed by slide sha256, patch
    coordinates and seed). Pixels are never read. The label-derived fixture signal lives only in
    :mod:`dermpath.ml.fixture`, behind a ``FixtureContext`` that exists only for
    ``demo_synthetic`` + ``synthetic_tiles`` slides in ``synthetic_pipeline_test`` mode. Its
    :meth:`LoadedEncoder.embed_batch` refuses; use :func:`dermpath.ml.fixture.synthetic_embeddings`.

``handcrafted-stain-texture-v1``
    Weights-free, label-free technical baseline on real pixels (:mod:`dermpath.ml.handcrafted`):
    64 deterministic colour, optical-density, H&E-deconvolution, sharpness and texture
    statistics. NOT a pathology foundation model. Identity = code hash.

``uni-v1`` (MahmoodLab UNI, ViT-L/16, CC-BY-NC-ND 4.0, gated)
    timm ``vit_large_patch16_224`` with the official kwargs, strict load of ``pytorch_model.bin``,
    ImageNet mean/std, 1024-d. Needs ``WB_UNI_WEIGHTS`` + ``WB_UNI_LICENSE_ACCEPTED=1``.

``midnight-12k`` (kaiko.ai Midnight, MIT)
    Native transformers ``Dinov2Model`` (ViT-g/14), mean/std 0.5, CLS + mean-patch concat,
    3072-d. Needs ``WB_MIDNIGHT_WEIGHTS`` = a local directory with ``config.json`` and
    ``model.safetensors``.

``hibou-b`` (HistAI Hibou-B, Apache-2.0 weights, gated click-through)
    ViT-B/14 with 4 register tokens mapped onto the native ``Dinov2WithRegistersModel``
    WITHOUT remote code; 768-d. Preprocessing constants are provisional and parity with the
    official remote code is unverified. Needs ``WB_HIBOU_B_WEIGHTS`` (directory) +
    ``WB_HIBOU_B_LICENSE_ACCEPTED=1``.

``generic-imagenet-resnet18``
    A GENERIC ImageNet backbone, not a pathology model. Needs ``WB_RESNET18_WEIGHTS``.

Loading (:meth:`EncoderAdapter.load`)
-------------------------------------
* Nothing is ever downloaded. No hub loader is called (models are built from a local config
  dict and a local state dict), remote code is never executed, and ``HF_HUB_OFFLINE=1`` /
  ``TRANSFORMERS_OFFLINE=1`` are set before the model libraries are imported, as a second
  barrier.
* The weights file is read ONCE; the SHA-256 of those bytes is the identity, and the model is
  built from the same buffer (``torch.load(BytesIO, weights_only=True)`` for ``.bin``,
  ``safetensors.torch.load(bytes)`` for safetensors). Peak memory is about the file size twice
  (raw bytes plus tensors) until the raw bytes are released, which happens before the model is
  materialised.
* The state dict is loaded with ``strict=True`` into a model created on the meta device:
  missing, unexpected or mis-shaped keys fail loudly (:class:`EncoderLoadError`).
* An expected SHA-256 (argument and/or the spec's ``*_SHA256`` environment pin) that differs
  raises :class:`EncoderIdentityMismatch`.
* The in-process cache is keyed by (encoder id, spec sha256, weights sha256, config sha256,
  device, precision): a changed file is a new key, so a stale model is never served. Older
  entries for the same encoder with other weights are evicted.
* :meth:`LoadedEncoder.embed_batch` takes ``uint8 (N, S, S, 3)`` with ``S == spec.input_size``
  and NEVER resizes. Inference runs under :func:`dermpath.ml.devices.inference_context`.

Statuses (cheap; never load weights)
------------------------------------
``available``, ``missing_weights`` (weights path or licence acknowledgement missing),
``missing_dependency`` (library absent or too old) and ``weights_mismatch`` (the files do not
match the spec: not a checkpoint, config disagrees, or the ``*_SHA256`` pin differs). The detail
lists every problem found.

Legacy API (deprecated; phase 3 migrates callers)
-------------------------------------------------
``embed(patches, coords, ctx)``, ``cache_identity``, ``config_from_params``,
``weights_sha256``, ``describe``, ``list_encoders`` and ``get_encoder`` keep their signatures.
``EmbedContext(..., fixture_label=x)`` with ``x is not None`` returns a
:class:`dermpath.ml.fixture.LegacySyntheticContext` (an inert label carrier that is NOT an
``EmbedContext``); every adapter, the synthetic one included, refuses it. The fixture signal is
applied only through :func:`dermpath.ml.fixture.fixture_context`.
"""

from __future__ import annotations

import hashlib
import io
import json
import os
import re
import sys
import threading
from abc import ABC, abstractmethod
from collections.abc import Callable
from dataclasses import dataclass, fields
from importlib import metadata
from pathlib import Path

import numpy as np

from . import PIPELINE_TEST_BANNER, devices, fixture, handcrafted
from .fixture import LegacySyntheticContext, SyntheticSignalForbidden

SYNTHETIC_ID = "synthetic-deterministic-v1"
HANDCRAFTED_ID = handcrafted.HANDCRAFTED_ID
UNI_ID = "uni-v1"
MIDNIGHT_ID = "midnight-12k"
HIBOU_B_ID = "hibou-b"
RESNET_ID = "generic-imagenet-resnet18"
SYNTHETIC_WEIGHTS_MARKER = "synthetic:no-weights"

STATUS_AVAILABLE = "available"
STATUS_MISSING_WEIGHTS = "missing_weights"
STATUS_MISSING_DEPENDENCY = "missing_dependency"
STATUS_WEIGHTS_MISMATCH = "weights_mismatch"

KINDS = ("synthetic", "handcrafted", "pathology_foundation", "generic_imagenet")
WEIGHTS_FORMATS = (None, "torch_state_dict", "safetensors", "hf_dir")

IMAGENET_MEAN = (0.485, 0.456, 0.406)
IMAGENET_STD = (0.229, 0.224, 0.225)

NOTHING_DOWNLOADED = "Nothing is downloaded automatically."
_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")


class EncoderUnavailable(Exception):
    def __init__(self, encoder_id: str, status: str, detail: str) -> None:
        super().__init__(f"encoder {encoder_id} is {status}: {detail}")
        self.encoder_id = encoder_id
        self.status = status
        self.detail = detail


class EncoderIdentityMismatch(EncoderUnavailable):
    """The weights' SHA-256 differs from an expected value (argument or ``*_SHA256`` pin)."""

    def __init__(self, encoder_id: str, *, expected: str, actual: str, source: str) -> None:
        super().__init__(encoder_id, STATUS_WEIGHTS_MISMATCH,
                         f"weights SHA-256 {actual} does not match the expected {expected} ({source})")
        self.expected = expected
        self.actual = actual
        self.source = source


class EncoderLoadError(EncoderUnavailable):
    """The local files could not be loaded as this spec (format, config or strict-load failure)."""

    def __init__(self, encoder_id: str, detail: str) -> None:
        super().__init__(encoder_id, STATUS_WEIGHTS_MISMATCH, detail)


class EncoderInputError(ValueError):
    """Patches of the wrong dtype, shape or size (the encoder never resizes)."""


# --------------------------------------------------------------------------- spec


def _jsonable(value):
    if isinstance(value, dict):
        return {str(k): _jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_jsonable(v) for v in value]
    return value


def _canonical_json(obj) -> bytes:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode()


# Fields that change what the encoder outputs; spec_sha256 covers exactly these.
SPEC_OUTPUT_FIELDS = ("id", "kind", "adapter_version", "architecture", "input_size", "resize_policy", "mean", "std",
                      "embedding_dim", "pooling", "weights_format", "reads_pixels", "synthetic")


@dataclass(frozen=True)
class EncoderSpec:
    """Frozen description of an encoder. ``adapter_version`` is bumped on any code change that alters outputs."""

    id: str
    name: str
    kind: str  # synthetic | handcrafted | pathology_foundation | generic_imagenet
    adapter_version: str
    architecture: dict  # e.g. {"library": "timm", "model": "vit_large_patch16_224", "kwargs": {...}}
    input_size: int  # pixels; patches arrive at exactly this size (0: pixels are not read)
    resize_policy: str
    mean: tuple[float, float, float]
    std: tuple[float, float, float]
    embedding_dim: int
    pooling: str
    weights_format: str | None  # torch_state_dict | safetensors | hf_dir | None
    weights_env: str | None
    license_env: str | None
    expected_weights_sha256_env: str | None  # optional pin, e.g. WB_UNI_WEIGHTS_SHA256
    license: dict
    reads_pixels: bool
    synthetic: bool
    notice: str
    official_reference: dict  # URLs and the claims verified (and not verified) against them

    def __post_init__(self) -> None:
        if self.kind not in KINDS:
            raise ValueError(f"unknown encoder kind {self.kind!r}")
        if self.weights_format not in WEIGHTS_FORMATS:
            raise ValueError(f"unknown weights format {self.weights_format!r}")
        if len(self.mean) != 3 or len(self.std) != 3 or any(s <= 0 for s in self.std):
            raise ValueError("mean and std need three channels (std > 0)")
        if self.reads_pixels and self.input_size <= 0:
            raise ValueError("an encoder that reads pixels needs input_size > 0")

    def output_fields(self) -> dict:
        return {name: _jsonable(getattr(self, name)) for name in SPEC_OUTPUT_FIELDS}

    def spec_sha256(self) -> str:
        """SHA-256 of the canonical JSON of the output-affecting fields."""
        return hashlib.sha256(_canonical_json(self.output_fields())).hexdigest()

    def to_dict(self) -> dict:
        out = {f.name: _jsonable(getattr(self, f.name)) for f in fields(self)}
        out["spec_sha256"] = self.spec_sha256()
        return out


_RESIZE_NONE = ("none: patches arrive at exactly {s} px at the target mpp (default 0.5 µm/px); the encoder never "
                "resizes and refuses any other size.")

SYNTHETIC_SPEC = EncoderSpec(
    id=SYNTHETIC_ID,
    name="Synthetic deterministic embeddings (pipeline test)",
    kind="synthetic",
    adapter_version="1",
    architecture={"library": "numpy", "module": "dermpath.ml.fixture", "function": "synthetic_embeddings",
                  "derivation": "SHA-256 -> PCG64 standard normal per (slide sha256, seed, level-0 x, y) plus a "
                                "per-slide offset 0.3*N(0, I); fixture signal only through a FixtureContext"},
    input_size=0,
    resize_policy="not applicable: pixels are never read",
    mean=(0.0, 0.0, 0.0),
    std=(1.0, 1.0, 1.0),
    embedding_dim=fixture.DEFAULT_CONFIG["dim"],
    pooling="none",
    weights_format=None,
    weights_env=None,
    license_env=None,
    expected_weights_sha256_env=None,
    license={"name": "Project code (no third-party weights)", "url": None, "commercial_use": "unknown",
             "notes": "No model weights exist. The workbench's own licence terms apply to the code."},
    reads_pixels=False,
    synthetic=True,
    notice=("Embeddings are SHA-256-seeded Gaussian noise keyed by (slide sha256, patch coordinates, seed). A class "
            "signal is added only by the pipeline-test fixture (dermpath.ml.fixture), and only for demo_synthetic "
            "synthetic_tiles slides in synthetic_pipeline_test mode, so learning is possible. They carry NO pathology "
            "information and never look at pixels. Every result is a PIPELINE TEST — NOT PATHOLOGY VALIDATION."),
    official_reference={"source": "project code: workbench/api/dermpath/ml/fixture.py", "verified_claims": [],
                        "not_verified": []},
)

HANDCRAFTED_SPEC = EncoderSpec(
    id=HANDCRAFTED_ID,
    name="Handcrafted stain and texture features (technical baseline, NOT a pathology foundation model)",
    kind="handcrafted",
    adapter_version=handcrafted.ADAPTER_VERSION,
    architecture={"library": "numpy", "module": "dermpath.ml.handcrafted", "function": "features",
                  "feature_names": list(handcrafted.FEATURE_NAMES),
                  "stain_matrix": "Ruifrok-Johnston H, E, DAB optical-density vectors, unit-normalised",
                  "tissue_od_threshold": handcrafted.TISSUE_OD_THRESHOLD},
    input_size=handcrafted.INPUT_SIZE,
    resize_policy=_RESIZE_NONE.format(s=handcrafted.INPUT_SIZE),
    mean=(0.0, 0.0, 0.0),
    std=(1.0, 1.0, 1.0),
    embedding_dim=handcrafted.EMBEDDING_DIM,
    pooling="per-patch statistics (no pooling)",
    weights_format=None,
    weights_env=None,
    license_env=None,
    expected_weights_sha256_env=None,
    license={"name": "Project code (no third-party weights)", "url": None, "commercial_use": "unknown",
             "notes": "No model weights exist. The workbench's own licence terms apply to the code."},
    reads_pixels=True,
    synthetic=False,
    notice=("A technical baseline: 64 deterministic colour, optical-density, H&E-deconvolution, sharpness and texture "
            "statistics of the pixels. It is NOT a pathology foundation model, has no learned pathology knowledge, "
            "needs no weights and never reads labels."),
    official_reference={
        "references": [
            "Ruifrok AC, Johnston DA. Quantification of histochemical staining by color deconvolution. Anal Quant "
            "Cytol Histol 2001;23(4):291-299",
            "Ojala T, Pietikainen M, Maenpaa T. Multiresolution gray-scale and rotation invariant texture "
            "classification with local binary patterns. IEEE TPAMI 2002;24(7):971-987",
        ],
        "verified_claims": [],
        "not_verified": ["the H, E and DAB optical-density vectors were transcribed as tabulated in common open-source "
                         "implementations of Ruifrok-Johnston; they were not re-checked against the paper on "
                         "2026-10-26"],
    },
)

UNI_SPEC = EncoderSpec(
    id=UNI_ID,
    name="UNI (ViT-L/16, pathology foundation model)",
    kind="pathology_foundation",
    adapter_version="2",
    architecture={"library": "timm", "model": "vit_large_patch16_224",
                  "kwargs": {"img_size": 224, "patch_size": 16, "init_values": 1e-5, "num_classes": 0,
                             "dynamic_img_size": True},
                  "weights_file": "pytorch_model.bin"},
    input_size=224,
    resize_policy=_RESIZE_NONE.format(s=224) + (
        " The official eval transform is Resize(224) + CenterCrop(224) + ImageNet normalisation; on a 224 x 224 input "
        "both Resize(224) and CenterCrop(224) are the identity, so it is equivalent for the patches this encoder "
        "accepts."),
    mean=IMAGENET_MEAN,
    std=IMAGENET_STD,
    embedding_dim=1024,
    pooling="timm_global_pool_token (CLS token after the final LayerNorm; num_classes=0)",
    weights_format="torch_state_dict",
    weights_env="WB_UNI_WEIGHTS",
    license_env="WB_UNI_LICENSE_ACCEPTED",
    expected_weights_sha256_env="WB_UNI_WEIGHTS_SHA256",
    license={"name": "CC-BY-NC-ND 4.0 (gated access)", "url": "https://huggingface.co/MahmoodLab/UNI",
             "commercial_use": "no",
             "notes": "Non-commercial academic research only. Commercial use of UNI and its derivatives, including "
                      "models trained on UNI outputs, needs prior approval from the rights holder. No redistribution. "
                      "Access requires accepting the model terms. The workbench never downloads it."},
    reads_pixels=True,
    synthetic=False,
    notice=("Pathology foundation encoder. Enabled only with legally obtained local weights; results from it are "
            "still research outputs, not validated diagnostics. Models trained on its outputs are restricted "
            "derivatives under its licence."),
    official_reference={
        "model_card": "https://huggingface.co/MahmoodLab/UNI",
        "files": "https://huggingface.co/MahmoodLab/UNI/tree/main",
        "code": "https://raw.githubusercontent.com/mahmoodlab/UNI/main/uni/get_encoder/get_encoder.py",
        "readme": "https://raw.githubusercontent.com/mahmoodlab/UNI/main/README.md",
        "paper": "https://arxiv.org/html/2308.15474v1",
        "verified_on": "2026-10-26",
        "verified_claims": [
            "local load: timm.create_model('vit_large_patch16_224', img_size=224, patch_size=16, init_values=1e-5, "
            "num_classes=0, dynamic_img_size=True) then load_state_dict(torch.load(pytorch_model.bin), strict=True) "
            "(model card; get_encoder.py)",
            "output dimension 1024 (model card example output shape [1, 1024])",
            "ImageNet normalisation mean (0.485, 0.456, 0.406), std (0.229, 0.224, 0.225) (model card; get_encoder.py)",
            "eval transform Resize(224) + CenterCrop(224) (get_encoder.py: get_eval_transforms(img_resize=224, "
            "center_crop=True)); torchvision default interpolation BILINEAR with antialias",
            "checkpoint pytorch_model.bin, a PyTorch state dict of 1.21 GB (files tab)",
            "licence CC-BY-NC-ND 4.0, gated; non-commercial academic research only; derivatives include models trained "
            "on UNI outputs (model card; README)",
        ],
        "not_verified": [
            "the official SHA-256 of pytorch_model.bin (pin it with WB_UNI_WEIGHTS_SHA256 once obtained)",
            "the hub pretrained_cfg interpolation and crop_pct (config.json is gated)",
            "the microns per pixel of the 20x pretraining patches (20x is usually about 0.5 µm/px; an inference)",
        ],
    },
)

MIDNIGHT_SPEC = EncoderSpec(
    id=MIDNIGHT_ID,
    name="Midnight-12k (kaiko.ai; DINOv2 ViT-g/14, pathology foundation model)",
    kind="pathology_foundation",
    adapter_version="1",
    architecture={"library": "transformers", "model_class": "Dinov2Model", "config_class": "Dinov2Config",
                  "accepted_model_types": ["dinov2"],
                  "expected_config": {"hidden_size": 1536, "num_hidden_layers": 40, "patch_size": 14,
                                      "use_swiglu_ffn": True},
                  "attn_implementation": "sdpa", "config_file": "config.json", "weights_file": "model.safetensors",
                  "trust_remote_code": False},
    input_size=224,
    resize_policy=_RESIZE_NONE.format(s=224) + (
        " The official transform is Resize(224) + CenterCrop(224) + Normalize(0.5, 0.5); both resize steps are the "
        "identity on a 224 x 224 input."),
    mean=(0.5, 0.5, 0.5),
    std=(0.5, 0.5, 0.5),
    embedding_dim=3072,
    pooling="cls+mean_patch_concat (CLS token and the mean of the patch tokens of last_hidden_state, concatenated)",
    weights_format="hf_dir",
    weights_env="WB_MIDNIGHT_WEIGHTS",
    license_env=None,
    expected_weights_sha256_env="WB_MIDNIGHT_WEIGHTS_SHA256",
    license={"name": "MIT", "url": "https://huggingface.co/kaiko-ai/midnight", "commercial_use": "yes",
             "notes": "The weights licence (MIT) permits commercial use; the model was trained on public TCGA FFPE "
                      "slides, whose terms are a question for counsel. The workbench never downloads it and uses it "
                      "for research only."},
    reads_pixels=True,
    synthetic=False,
    notice=("Pathology foundation encoder (about 1.1B parameters; model.safetensors is 4.55 GB): slow on CPU. Enabled "
            "only with local weights; results are research outputs, not validated diagnostics."),
    official_reference={
        "model_card": "https://huggingface.co/kaiko-ai/midnight",
        "readme": "https://huggingface.co/kaiko-ai/midnight/blob/main/README.md",
        "config": "https://huggingface.co/kaiko-ai/midnight/raw/main/config.json",
        "files": "https://huggingface.co/kaiko-ai/midnight/tree/main",
        "paper": "https://arxiv.org/html/2504.05186",
        "verified_on": "2026-10-26",
        "verified_claims": [
            "licence MIT, no gated fields (model card)",
            "config.json is a native transformers Dinov2Model (model_type dinov2) with no auto_map, so no remote code; "
            "hidden_size 1536, 40 layers, patch 14, SwiGLU feed-forward (config.json)",
            "transform Resize(224), CenterCrop(224), mean and std 0.5 (model card)",
            "recommended embedding: CLS token concatenated with the mean of the patch tokens (model card)",
            "weights file model.safetensors, 4.55 GB (files tab)",
            "trained at 2, 1, 0.5 and 0.25 µm/px (paper)",
        ],
        "not_verified": ["the official SHA-256 of model.safetensors (pin it with WB_MIDNIGHT_WEIGHTS_SHA256)",
                         "the resize interpolation of the official transform",
                         "numerical parity with the official pipeline (needs the weights)"],
    },
)

HIBOU_B_SPEC = EncoderSpec(
    id=HIBOU_B_ID,
    name="Hibou-B (HistAI; ViT-B/14 with 4 registers, pathology foundation model; parity unverified)",
    kind="pathology_foundation",
    adapter_version="1",
    architecture={"library": "transformers", "model_class": "Dinov2WithRegistersModel",
                  "config_class": "Dinov2WithRegistersConfig",
                  "accepted_model_types": ["dinov2", "dinov2_with_registers"],
                  "expected_config": {"hidden_size": 768, "patch_size": 14, "num_register_tokens": 4},
                  "attn_implementation": "sdpa", "config_file": "config.json", "weights_file": "model.safetensors",
                  "trust_remote_code": False,
                  "mapping": "official release needs remote code; mapped onto the native register-token DINOv2 "
                             "architecture instead (strict load proves only key and shape compatibility)"},
    input_size=224,
    resize_policy=_RESIZE_NONE.format(s=224),
    mean=(0.7068, 0.5755, 0.722),
    std=(0.195, 0.2316, 0.1816),
    embedding_dim=768,
    pooling="pooler_output (CLS token of the final-LayerNorm sequence)",
    weights_format="hf_dir",
    weights_env="WB_HIBOU_B_WEIGHTS",
    license_env="WB_HIBOU_B_LICENSE_ACCEPTED",
    expected_weights_sha256_env="WB_HIBOU_B_WEIGHTS_SHA256",
    license={"name": "Apache-2.0 (weights; gated click-through)", "url": "https://huggingface.co/histai/hibou-b",
             "commercial_use": "yes",
             "notes": "The weights licence (Apache-2.0) permits commercial use and the authors state it is available "
                      "for commercial use; access needs a click-through. Training-data terms are a question for "
                      "counsel. The workbench never downloads it."},
    reads_pixels=True,
    synthetic=False,
    notice=("Pathology foundation encoder loaded WITHOUT remote code by mapping onto the native register-token DINOv2 "
            "architecture. Its preprocessing constants are provisional and numerical parity with the official code is "
            "UNVERIFIED until checked with the weights. Results are research outputs, not validated diagnostics."),
    official_reference={
        "model_card": "https://huggingface.co/histai/hibou-b",
        "files": "https://huggingface.co/histai/hibou-b/tree/main",
        "code": "https://github.com/HistAI/hibou",
        "paper": "https://arxiv.org/html/2406.05074",
        "constants_source": "https://raw.githubusercontent.com/mahmoodlab/TRIDENT/main/trident/patch_encoder_models/"
                            "utils/constants.py",
        "verified_on": "2026-10-26",
        "verified_claims": [
            "weights licence Apache-2.0; gated by a share-your-information click-through (model card)",
            "ViT-B/14 with 4 register tokens, image size 224 (official model code)",
            "85.7M parameters; model.safetensors of 343 MB (model card; files tab)",
            "the documented hub load needs remote code, which this adapter never runs (model card)",
        ],
        "not_verified": [
            "embedding dimension 768 (inferred from ViT-B; the card does not state it)",
            "mean (0.7068, 0.5755, 0.722) and std (0.195, 0.2316, 0.1816): TRIDENT's Hibou constants, used there for "
            "Hibou-L; Hibou-B's own preprocessor_config.json is gated (if present locally it is checked against these)",
            "the resize interpolation and the training microns per pixel",
            "that the release's state-dict keys and config field names match Dinov2WithRegistersModel",
            "numerical parity with the official remote code (needs the weights)",
            "pooling: pooler_output (CLS) as the embedding",
        ],
    },
)

RESNET_SPEC = EncoderSpec(
    id=RESNET_ID,
    name="ResNet-18 (generic ImageNet, NOT a pathology model)",
    kind="generic_imagenet",
    adapter_version="2",
    architecture={"library": "torchvision", "model": "resnet18", "kwargs": {"weights": None},
                  "post_load": "fc replaced by Identity after the strict load (the file keeps the 1000-class fc)"},
    input_size=224,
    resize_policy=_RESIZE_NONE.format(s=224) + (
        " This deviates from torchvision's ImageNet eval transform (Resize(256) + CenterCrop(224)): the whole patch is "
        "used, without a centre crop."),
    mean=IMAGENET_MEAN,
    std=IMAGENET_STD,
    embedding_dim=512,
    pooling="torchvision global average pool (fc = Identity)",
    weights_format="torch_state_dict",
    weights_env="WB_RESNET18_WEIGHTS",
    license_env=None,
    expected_weights_sha256_env="WB_RESNET18_WEIGHTS_SHA256",
    license={"name": "BSD-3-Clause (torchvision code); weights terms per their source",
             "url": "https://github.com/pytorch/vision", "commercial_use": "unknown",
             "notes": "ImageNet-trained weights; check the terms of the weights you supply."},
    reads_pixels=True,
    synthetic=False,
    notice="Generic natural-image features. Not trained on pathology; not a pathology encoder.",
    official_reference={"code": "https://github.com/pytorch/vision", "verified_claims": [],
                        "not_verified": ["the licence and terms of the ImageNet weights a user supplies",
                                         "the SHA-256 of those weights (pin it with WB_RESNET18_WEIGHTS_SHA256)"]},
)

ENCODER_SPECS: dict[str, EncoderSpec] = {s.id: s for s in (SYNTHETIC_SPEC, HANDCRAFTED_SPEC, UNI_SPEC, MIDNIGHT_SPEC,
                                                            HIBOU_B_SPEC, RESNET_SPEC)}


# --------------------------------------------------------------------------- contexts


class EmbedContext:
    """What a real encoder may know about the patches it embeds. It has NO label field.

    Deprecated legacy constructor: ``EmbedContext(slide_sha256, seed, fixture_label=..., config=...)``.
    With ``fixture_label is None`` it is a plain, label-free ``EmbedContext``. With any other
    value it returns an inert :class:`dermpath.ml.fixture.LegacySyntheticContext` instead (which is
    not an ``EmbedContext``); every adapter, the synthetic one included, refuses it.
    """

    __slots__ = ("slide_sha256", "seed", "config")

    def __new__(cls, slide_sha256: str, seed: int, fixture_label: int | None = None, config: dict | None = None):
        if fixture_label is not None:
            return LegacySyntheticContext(slide_sha256=slide_sha256, seed=int(seed), fixture_label=fixture_label,
                                          config=dict(config or {}))
        return super().__new__(cls)

    def __init__(self, slide_sha256: str, seed: int, fixture_label: int | None = None,
                 config: dict | None = None) -> None:
        self.slide_sha256 = slide_sha256
        self.seed = int(seed)
        self.config = dict(config or {})

    def __repr__(self) -> str:
        return f"EmbedContext(slide_sha256={self.slide_sha256!r}, seed={self.seed}, config={self.config!r})"


def _refuse_label_context(encoder_id: str, ctx) -> None:
    if ctx is None or type(ctx) is EmbedContext:
        return
    if isinstance(ctx, (LegacySyntheticContext, fixture.FixtureContext)):
        raise SyntheticSignalForbidden(f"{encoder_id} is a real encoder; it never receives a label or fixture context")
    raise TypeError(f"{encoder_id} expects an EmbedContext, not {type(ctx).__name__}")


# --------------------------------------------------------------------------- patches and preprocessing


def check_patch_batch(patches_uint8, input_size: int) -> np.ndarray:
    """Validate ``uint8 (N, input_size, input_size, 3)``. Raises :class:`EncoderInputError`; never resizes."""
    if not isinstance(patches_uint8, np.ndarray):
        raise EncoderInputError(f"patches must be a numpy array, not {type(patches_uint8).__name__}")
    if patches_uint8.dtype != np.uint8:
        raise EncoderInputError(f"patches must be uint8 RGB, got dtype {patches_uint8.dtype}")
    if patches_uint8.ndim != 4 or patches_uint8.shape[3] != 3:
        raise EncoderInputError(f"patches must have shape (N, H, W, 3), got {tuple(patches_uint8.shape)}")
    h, w = int(patches_uint8.shape[1]), int(patches_uint8.shape[2])
    if h != input_size or w != input_size:
        raise EncoderInputError(f"patches must be exactly {input_size}x{input_size} px (got {h}x{w}); the encoder "
                                "never resizes, so read them at that size at the target mpp")
    return patches_uint8


def pil_patches_to_uint8(patches: list, input_size: int) -> np.ndarray:
    """Legacy helper: PIL patches → ``uint8 (N, S, S, 3)``. Alpha is composited on white; no resizing."""
    from PIL import Image

    arrays = []
    for p in patches:
        if p.mode in ("RGBA", "LA") or (p.mode == "P" and "transparency" in p.info):
            rgba = p.convert("RGBA")
            flat = Image.new("RGB", rgba.size, (255, 255, 255))
            flat.paste(rgba, mask=rgba.split()[3])
            p = flat
        elif p.mode != "RGB":
            p = p.convert("RGB")
        if p.size != (input_size, input_size):
            raise EncoderInputError(f"patch is {p.size[0]}x{p.size[1]} px; this encoder takes exactly "
                                    f"{input_size}x{input_size} and never resizes (set patch_size={input_size})")
        arrays.append(np.asarray(p, dtype=np.uint8))
    if not arrays:
        return np.zeros((0, input_size, input_size, 3), dtype=np.uint8)
    return np.ascontiguousarray(np.stack(arrays))


def preprocess(patches_uint8: np.ndarray, spec: EncoderSpec):
    """``uint8 (N, S, S, 3)`` → contiguous float32 ``(N, 3, S, S)`` tensor: ``(x / 255 - mean) / std`` on CPU."""
    import torch

    x = torch.from_numpy(np.ascontiguousarray(check_patch_batch(patches_uint8, spec.input_size)))
    x = x.permute(0, 3, 1, 2).to(torch.float32).div(255.0)
    mean = torch.tensor(spec.mean, dtype=torch.float32).view(1, 3, 1, 1)
    std = torch.tensor(spec.std, dtype=torch.float32).view(1, 3, 1, 1)
    return ((x - mean) / std).contiguous()


# --------------------------------------------------------------------------- loaded encoder


def _library_versions() -> dict:
    out = {}
    for dist in ("numpy", "torch", "timm", "torchvision", "transformers", "safetensors"):
        try:
            out[dist] = metadata.version(dist)
        except metadata.PackageNotFoundError:
            out[dist] = None
    return out


class LoadedEncoder:
    """An encoder built from, and bound to, the exact weights bytes it was loaded from."""

    def __init__(self, *, spec: EncoderSpec, weights_sha256: str, device: str, precision: str,
                 embed_fn: Callable[[np.ndarray], np.ndarray] | None, runtime: dict | None = None,
                 config_sha256: str | None = None, model=None) -> None:
        self.spec = spec
        self.weights_sha256 = weights_sha256
        self.device = device
        self.precision = precision
        self.config_sha256 = config_sha256
        self.runtime = dict(runtime or {})
        self.model = model
        self._embed_fn = embed_fn

    @property
    def embedding_dim(self) -> int:
        return self.spec.embedding_dim

    def embed_batch(self, patches_uint8: np.ndarray) -> np.ndarray:
        """``uint8 (N, S, S, 3)`` with ``S == spec.input_size`` → float32 ``(N, embedding_dim)``. Never resizes."""
        if self.spec.synthetic or self._embed_fn is None:
            raise SyntheticSignalForbidden(f"{self.spec.id} does not embed pixels; it is usable only through "
                                           "dermpath.ml.fixture.synthetic_embeddings with a FixtureContext")
        x = check_patch_batch(patches_uint8, self.spec.input_size)
        n = int(x.shape[0])
        if n == 0:
            return np.zeros((0, self.spec.embedding_dim), dtype=np.float32)
        out = np.ascontiguousarray(self._embed_fn(x), dtype=np.float32)
        if out.shape != (n, self.spec.embedding_dim):
            raise EncoderLoadError(self.spec.id, f"the model produced output of shape {tuple(out.shape)}; the spec "
                                                 f"says ({n}, {self.spec.embedding_dim})")
        if not np.all(np.isfinite(out)):
            raise FloatingPointError(f"{self.spec.id} produced non-finite embeddings on {self.device} at "
                                     f"{self.precision}")
        return out

    def identity(self) -> dict:
        """Everything that identifies these embeddings' producer (for feature-set and run records)."""
        return {"encoder_id": self.spec.id, "adapter_version": self.spec.adapter_version,
                "spec_sha256": self.spec.spec_sha256(), "weights_sha256": self.weights_sha256,
                "config_sha256": self.config_sha256, "device": self.device, "precision": self.precision,
                "runtime": dict(self.runtime), "libraries": _library_versions()}

    def __repr__(self) -> str:
        return (f"LoadedEncoder({self.spec.id}, weights={self.weights_sha256[:16]}…, device={self.device}, "
                f"precision={self.precision})")


_LOADED: dict[tuple, LoadedEncoder] = {}
_LOAD_LOCK = threading.RLock()


def clear_loaded_encoders() -> None:
    """Drop every cached model (tests, or to free memory)."""
    with _LOAD_LOCK:
        _LOADED.clear()


def loaded_encoder_keys() -> list[tuple]:
    """Cache keys ``(encoder_id, spec_sha256, weights_sha256, config_sha256, device, precision)``."""
    with _LOAD_LOCK:
        return list(_LOADED)


# --------------------------------------------------------------------------- weights hashing


_hash_memo: dict[tuple[int, int, int, int, int], str] = {}
_hash_lock = threading.Lock()


def _stat_key(path: Path) -> tuple[int, int, int, int, int]:
    st = os.stat(path)
    return st.st_dev, st.st_ino, st.st_size, st.st_mtime_ns, st.st_ctime_ns


def _memo_get(path: Path) -> str | None:
    try:
        key = _stat_key(path)
    except OSError:
        return None
    with _hash_lock:
        return _hash_memo.get(key)


def file_sha256(path: Path) -> str:
    """SHA-256 of a file, memoised by (st_dev, st_ino, st_size, st_mtime_ns, st_ctime_ns).

    ``st_ctime_ns`` changes on every content write and cannot be set by ``utime``, so an
    in-place rewrite with the same size and a restored mtime is still re-hashed.
    """
    path = Path(path)
    key = _stat_key(path)
    with _hash_lock:
        if key in _hash_memo:
            return _hash_memo[key]
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for block in iter(lambda: fh.read(4 * 1024 * 1024), b""):
            h.update(block)
    digest = h.hexdigest()
    if _stat_key(path) == key:  # unchanged while hashing
        with _hash_lock:
            _hash_memo[key] = digest
    return digest


def _read_once(path: Path) -> tuple[bytes, str]:
    """Read the file once; return its bytes and the SHA-256 of exactly those bytes."""
    before = _stat_key(path)
    data = path.read_bytes()
    digest = hashlib.sha256(data).hexdigest()
    if _stat_key(path) == before:
        with _hash_lock:
            _hash_memo[before] = digest
    return data, digest


# --------------------------------------------------------------------------- adapters


def _dist_version(name: str) -> str | None:
    try:
        return metadata.version(name)
    except metadata.PackageNotFoundError:
        return None


def _version_tuple(version: str) -> tuple[int, ...]:
    parts = []
    for piece in version.split("."):
        digits = re.match(r"\d+", piece)
        if digits is None:
            break
        parts.append(int(digits.group()))
    return tuple(parts)


def _legacy_device() -> str:
    """Legacy pipeline device: ``WB_ML_DEVICE`` when set, otherwise CPU (the pre-upgrade behaviour)."""
    return devices.resolve_device(os.environ.get(devices.DEVICE_ENV, "").strip() or "cpu")


class EncoderAdapter(ABC):
    id: str
    name: str
    kind: str  # synthetic | handcrafted | pathology_foundation | generic_imagenet
    license: dict
    synthetic: bool = False
    notice: str = ""
    preprocessing_version: str = ""
    embedding_dim: int = 0
    reads_pixels: bool = True
    spec: EncoderSpec | None = None

    @abstractmethod
    def status(self) -> tuple[str, str | None]:
        """``(status, status_detail)``. Cheap; never downloads, never loads weights."""

    def weights_sha256(self) -> str | None:
        return None

    def _describe_weights_sha256(self, status: str) -> str | None:
        return self.weights_sha256() if status == STATUS_AVAILABLE else None

    def describe(self) -> dict:
        status, detail = self.status()
        out = {
            "id": self.id,
            "name": self.name,
            "kind": self.kind,
            "license": self.license,
            "status": status,
            "status_detail": detail,
            "weights_sha256": self._describe_weights_sha256(status),
            "embedding_dim": self.embedding_dim,
            "preprocessing_version": self.preprocessing_version,
            "synthetic": self.synthetic,
            "reads_pixels": self.reads_pixels,
            "notice": self.notice,
            "banner": PIPELINE_TEST_BANNER if self.synthetic else None,
        }
        if self.spec is not None:
            for key, value in self.spec.to_dict().items():
                out.setdefault(key, value)
        return out

    def require_available(self) -> None:
        status, detail = self.status()
        if status != STATUS_AVAILABLE:
            raise EncoderUnavailable(self.id, status, detail or status)

    def cache_identity(self, config: dict) -> tuple[str, dict]:
        """DEPRECATED (feature sets replace it): ``(weights identity, extra key fields)`` for the legacy cache."""
        raise NotImplementedError(f"{self.id} declares no cache identity")

    def config_from_params(self, params: dict) -> dict:
        """DEPRECATED: encoder config from experiment params (only the synthetic fixture has one)."""
        return {}

    def load(self, *, expected_weights_sha256: str | None = None, device: str = "cpu",
             precision: str = "fp32") -> LoadedEncoder:
        raise NotImplementedError(f"{self.id} cannot be loaded")

    @abstractmethod
    def embed(self, patches: list | None, coords: np.ndarray, ctx) -> np.ndarray:
        """DEPRECATED: float32 ``(N, D)`` embeddings for N patches (``coords`` level-0 x, y)."""


class _SpecAdapter(EncoderAdapter):
    default_spec: EncoderSpec

    def __init__(self, spec: EncoderSpec | None = None) -> None:
        spec = spec or self.default_spec
        self.spec = spec
        self.id = spec.id
        self.name = spec.name
        self.kind = spec.kind
        self.license = dict(spec.license)
        self.synthetic = spec.synthetic
        self.notice = spec.notice
        self.embedding_dim = spec.embedding_dim
        self.reads_pixels = spec.reads_pixels
        self.preprocessing_version = f"{spec.id}/a{spec.adapter_version}/spec-{spec.spec_sha256()[:16]}"

    @staticmethod
    def _check_expected(encoder_id: str, actual: str, expected: str | None, source: str) -> None:
        if expected is not None and expected != actual:
            raise EncoderIdentityMismatch(encoder_id, expected=expected, actual=actual, source=source)


class SyntheticDeterministicEncoder(_SpecAdapter):
    default_spec = SYNTHETIC_SPEC

    def __init__(self, spec: EncoderSpec | None = None) -> None:
        super().__init__(spec)
        self.preprocessing_version = "synthetic-hash/1"  # unchanged: the derivation is unchanged

    def status(self) -> tuple[str, str | None]:
        return STATUS_AVAILABLE, None

    def config_from_params(self, params: dict) -> dict:
        return fixture.synthetic_config(params)

    def cache_identity(self, config: dict) -> tuple[str, dict]:
        return SYNTHETIC_WEIGHTS_MARKER, {"encoder_config": config}

    def load(self, *, expected_weights_sha256: str | None = None, device: str = "cpu",
             precision: str = "fp32") -> LoadedEncoder:
        """Identity only: :meth:`LoadedEncoder.embed_batch` refuses; embeddings come from :mod:`dermpath.ml.fixture`."""
        if devices.resolve_precision(precision) != "fp32":
            raise ValueError(f"{self.id} has no low-precision mode")
        self._check_expected(self.id, SYNTHETIC_WEIGHTS_MARKER, expected_weights_sha256, "expected_weights_sha256")
        return LoadedEncoder(spec=self.spec, weights_sha256=SYNTHETIC_WEIGHTS_MARKER, device="cpu", precision="fp32",
                             embed_fn=None, runtime={"device": "cpu", "device_class": "cpu", "precision": "fp32"})

    def embed(self, patches, coords: np.ndarray, ctx) -> np.ndarray:
        """DEPRECATED legacy path: label-free embeddings only.

        The label-derived signal is applied only through a ``FixtureContext`` from
        :func:`dermpath.ml.fixture.fixture_context` (design §1 invariant 3), via
        :func:`dermpath.ml.fixture.synthetic_embeddings`. A legacy label carrier is refused here
        like in every real adapter, whatever its label, because it carries no provenance or mode.
        """
        if isinstance(ctx, (LegacySyntheticContext, fixture.FixtureContext)):
            raise SyntheticSignalForbidden(f"{self.id} legacy embed is label-free; the fixture signal is applied only "
                                           "through fixture.synthetic_embeddings(fixture_context(...))")
        if type(ctx) is not EmbedContext:
            raise TypeError(f"{self.id} legacy embed expects an EmbedContext, not {type(ctx).__name__}")
        return fixture.legacy_synthetic_embeddings(coords, slide_sha256=ctx.slide_sha256, seed=ctx.seed,
                                                   config=ctx.config or None, fixture_label=None)


class HandcraftedStainTextureEncoder(_SpecAdapter):
    default_spec = HANDCRAFTED_SPEC

    def status(self) -> tuple[str, str | None]:
        return STATUS_AVAILABLE, None

    def weights_sha256(self) -> str:
        """Weights-free identity: ``handcrafted:<adapter_version>:<sha256 of the module source>``."""
        return handcrafted.code_identity()

    def cache_identity(self, config: dict) -> tuple[str, dict]:
        return self.weights_sha256(), {"spec_sha256": self.spec.spec_sha256(),
                                       "adapter_version": self.spec.adapter_version}

    def load(self, *, expected_weights_sha256: str | None = None, device: str = "cpu",
             precision: str = "fp32") -> LoadedEncoder:
        devices.resolve_device(device)  # validate the request; numpy always computes on the CPU
        if devices.resolve_precision(precision) != "fp32":
            raise ValueError(f"{self.id} is computed in float64 numpy; there is no low-precision mode")
        identity = self.weights_sha256()
        self._check_expected(self.id, identity, expected_weights_sha256, "expected_weights_sha256")
        size = self.spec.input_size
        return LoadedEncoder(spec=self.spec, weights_sha256=identity, device="cpu", precision="fp32",
                             embed_fn=lambda x: handcrafted.features(x, input_size=size),
                             runtime={"device": "cpu", "device_class": "cpu", "precision": "fp32",
                                      "compute": "numpy float64, output float32"})

    def embed(self, patches, coords: np.ndarray, ctx) -> np.ndarray:
        """DEPRECATED legacy path used by :mod:`dermpath.ml.features`."""
        _refuse_label_context(self.id, ctx)
        if patches is None:
            raise ValueError(f"{self.id} needs pixels (pixel_mode=read)")
        return self.load().embed_batch(pil_patches_to_uint8(patches, self.spec.input_size))


# Keys of a local config.json that never change a model's forward output (or are handled explicitly).
_HF_CONFIG_DROP = {"auto_map", "architectures", "model_type", "transformers_version", "_name_or_path", "torch_dtype",
                   "dtype", "_attn_implementation", "attn_implementation"}
_OFFLINE_ENV = {"HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1", "HF_HUB_DISABLE_TELEMETRY": "1"}


def _force_offline() -> None:
    """Second barrier against any network access by the model libraries (nothing here calls the hub)."""
    os.environ.update(_OFFLINE_ENV)
    constants = sys.modules.get("huggingface_hub.constants")
    if constants is not None and hasattr(constants, "HF_HUB_OFFLINE"):
        constants.HF_HUB_OFFLINE = True


def _meta_build(builder: Callable[[], object]):
    import torch

    with torch.device("meta"):
        return builder()


def _strict_load(model, state: dict) -> None:
    """Strict, assigning load: missing, unexpected or mis-shaped keys raise."""
    model.load_state_dict(state, strict=True, assign=True)
    leftovers = [n for n, t in list(model.named_parameters()) + list(model.named_buffers()) if t.is_meta]
    if leftovers:
        raise RuntimeError(f"tensors not provided by the state dict: {leftovers[:8]}")


class _TorchWeightsAdapter(_SpecAdapter):
    """Common status, identity and load logic for encoders built from a local weights file."""

    dependencies: tuple[tuple[str, str], ...] = (("torch", "2.1"),)
    expected_location: str = ""

    # ---- paths

    def _env_path(self) -> Path | None:
        raw = os.environ.get(self.spec.weights_env or "", "").strip()
        return Path(raw).expanduser() if raw else None

    def _weights_file(self) -> Path | None:
        path = self._env_path()
        if path is None:
            return None
        name = self.spec.architecture.get("weights_file")
        if name and (self.spec.weights_format == "hf_dir" or path.is_dir()):
            return path / name
        return path

    def _config_file(self) -> Path | None:
        if self.spec.weights_format != "hf_dir":
            return None
        path = self._env_path()
        return None if path is None else path / self.spec.architecture["config_file"]

    def _weights_kind(self, wfile: Path) -> str:
        if self.spec.weights_format == "hf_dir":
            return "safetensors" if wfile.suffix == ".safetensors" else "torch_state_dict"
        return self.spec.weights_format or "torch_state_dict"

    # ---- status

    def _missing_weights_problems(self) -> list[str]:
        env = self.spec.weights_env
        path = self._env_path()
        problems = []
        if path is None:
            problems.append(f"{env} is not set; it must name {self.expected_location}")
        elif self.spec.weights_format == "hf_dir":
            if not path.is_dir():
                problems.append(f"{env}={path} does not exist or is not a directory (expected {self.expected_location})")
            else:
                for name in (self.spec.architecture["config_file"], self.spec.architecture["weights_file"]):
                    if not (path / name).is_file():
                        problems.append(f"{env}={path} has no {name} (expected {self.expected_location})")
        else:
            wfile = self._weights_file()
            if wfile is None or not wfile.is_file():
                problems.append(f"{env}={path} does not exist or is not a file (expected {self.expected_location})")
        if self.spec.license_env and os.environ.get(self.spec.license_env, "").strip() != "1":
            problems.append(f"{self.spec.license_env}=1 is not set (confirms the licence terms were accepted and the "
                            "weights were obtained legally)")
        return problems

    def _dependency_problems(self) -> list[str]:
        problems = []
        for dist, minimum in self.dependencies:
            version = _dist_version(dist)
            if version is None:
                problems.append(f"Python package '{dist}' is not installed; it is required to build this encoder's "
                                "architecture")
            elif _version_tuple(version) < _version_tuple(minimum):
                problems.append(f"Python package '{dist}' {version} is older than the required {minimum}")
        return problems

    def _format_problems(self, wfile: Path) -> list[str]:
        where = f"{self.spec.weights_env} ({wfile})"
        try:
            with open(wfile, "rb") as fh:
                head = fh.read(8)
                if self._weights_kind(wfile) == "safetensors":
                    if len(head) < 8:
                        return [f"the weights file at {where} is not a safetensors file (too short)"]
                    n = int.from_bytes(head, "little")
                    if n <= 1 or n > min(100 * 1024 * 1024, wfile.stat().st_size - 8):
                        return [f"the weights file at {where} is not a safetensors file (bad header length)"]
                    header = json.loads(fh.read(n).decode("utf-8"))
                    if not isinstance(header, dict) or not any(k != "__metadata__" for k in header):
                        return [f"the weights file at {where} is a safetensors file without tensors"]
                elif not (head.startswith(b"PK\x03\x04") or head[:1] == b"\x80"):
                    return [f"the weights file at {where} is not a PyTorch checkpoint (neither a zip archive nor a "
                            "pickle)"]
        except (OSError, ValueError, UnicodeDecodeError) as exc:
            return [f"the weights file at {where} could not be read as {self._weights_kind(wfile)}: {exc}"]
        return []

    def _config_problems(self, cfg: dict) -> list[str]:
        arch = self.spec.architecture
        name = arch["config_file"]
        problems = []
        model_type = cfg.get("model_type")
        if model_type not in arch["accepted_model_types"]:
            problems.append(f"{name} has model_type {model_type!r}; this adapter accepts {arch['accepted_model_types']}")
        for key, expected in arch["expected_config"].items():
            if key not in cfg:
                problems.append(f"{name} lacks {key!r} (expected {expected!r})")
            elif cfg[key] != expected:
                problems.append(f"{name} has {key}={cfg[key]!r}; expected {expected!r}")
        return problems

    def _preprocessor_problems(self, directory: Path) -> list[str]:
        pre = directory / "preprocessor_config.json"
        if not pre.is_file():
            return []
        try:
            cfg = json.loads(pre.read_text())
        except (OSError, ValueError) as exc:
            return [f"preprocessor_config.json could not be read: {exc}"]
        if not isinstance(cfg, dict):
            return ["preprocessor_config.json is not a JSON object"]
        problems = []
        for key, ours in (("image_mean", self.spec.mean), ("image_std", self.spec.std)):
            theirs = cfg.get(key)
            if theirs is None:
                continue
            try:
                same = len(theirs) == 3 and all(abs(float(a) - float(b)) <= 1e-4 for a, b in zip(theirs, ours))
            except (TypeError, ValueError):
                same = False
            if not same:
                problems.append(f"preprocessor_config.json declares {key} {theirs}, but this adapter uses {list(ours)}; "
                                "review it and release a new adapter_version before use")
        return problems

    def _read_config(self) -> tuple[dict | None, bytes | None, list[str]]:
        cfile = self._config_file()
        if cfile is None:
            return None, None, []
        try:
            raw = cfile.read_bytes()
            cfg = json.loads(raw.decode("utf-8"))
        except (OSError, ValueError, UnicodeDecodeError) as exc:
            return None, None, [f"{cfile.name} could not be parsed: {exc}"]
        if not isinstance(cfg, dict):
            return None, raw, [f"{cfile.name} is not a JSON object"]
        return cfg, raw, []

    def _pin(self) -> tuple[str | None, list[str]]:
        env = self.spec.expected_weights_sha256_env
        raw = os.environ.get(env or "", "").strip().lower()
        if not raw:
            return None, []
        if not _SHA256_RE.match(raw):
            return None, [f"{env} is set but is not a 64-character hex SHA-256"]
        return raw, []

    def _problems(self, *, check_pin: bool = True) -> dict[str, list[str]]:
        out = {"weights": self._missing_weights_problems(), "dependency": self._dependency_problems(), "mismatch": []}
        if out["weights"]:
            return out
        wfile = self._weights_file()
        out["mismatch"] += self._format_problems(wfile)
        if self.spec.weights_format == "hf_dir":
            cfg, _, problems = self._read_config()
            out["mismatch"] += problems
            if cfg is not None:
                out["mismatch"] += self._config_problems(cfg)
            out["mismatch"] += self._preprocessor_problems(self._env_path())
        pin, problems = self._pin()
        out["mismatch"] += problems
        if check_pin and pin is not None and not out["mismatch"]:
            try:
                actual = file_sha256(wfile)
            except OSError as exc:
                out["mismatch"].append(f"the weights file at {self.spec.weights_env} could not be hashed: {exc}")
                return out
            if actual != pin:
                out["mismatch"].append(f"{self.spec.expected_weights_sha256_env} pins {pin}, but the weights file's "
                                       f"SHA-256 is {actual}")
        return out

    @staticmethod
    def _status_of(problems: dict[str, list[str]]) -> str:
        if problems["weights"]:
            return STATUS_MISSING_WEIGHTS
        if problems["dependency"]:
            return STATUS_MISSING_DEPENDENCY
        if problems["mismatch"]:
            return STATUS_WEIGHTS_MISMATCH
        return STATUS_AVAILABLE

    @staticmethod
    def _detail_of(problems: dict[str, list[str]]) -> str | None:
        found = problems["weights"] + problems["dependency"] + problems["mismatch"]
        return "; ".join(found) + ". " + NOTHING_DOWNLOADED if found else None

    def status(self) -> tuple[str, str | None]:
        problems = self._problems()
        return self._status_of(problems), self._detail_of(problems)

    # ---- identity (legacy API)

    def weights_sha256(self) -> str | None:
        wfile = self._weights_file()
        if wfile is None or not wfile.is_file():
            return None
        return file_sha256(wfile)

    def _describe_weights_sha256(self, status: str) -> str | None:
        return self.weights_sha256() if status in (STATUS_AVAILABLE, STATUS_WEIGHTS_MISMATCH) else None

    def cache_identity(self, config: dict) -> tuple[str, dict]:
        """DEPRECATED legacy cache identity: the weights digest plus spec, device and precision."""
        self.require_available()
        extra = {"spec_sha256": self.spec.spec_sha256(), "adapter_version": self.spec.adapter_version,
                 "device": _legacy_device(), "precision": "fp32"}
        if self.spec.weights_format == "hf_dir":
            _, raw, _ = self._read_config()
            extra["config_sha256"] = hashlib.sha256(raw).hexdigest() if raw is not None else None
        return self.weights_sha256(), extra

    # ---- loading

    def _deserialize(self, data: bytes, kind: str) -> dict:
        if kind == "safetensors":
            import safetensors.torch

            return safetensors.torch.load(data)
        import torch

        return torch.load(io.BytesIO(data), map_location="cpu", weights_only=True)

    @abstractmethod
    def _build(self, state: dict, config: dict | None):
        """Return ``(model, forward)`` with the state dict strictly loaded; ``forward(model, x) -> (N, D)``."""

    def load(self, *, expected_weights_sha256: str | None = None, device: str = "cpu",
             precision: str = "fp32") -> LoadedEncoder:
        dev = devices.resolve_device(device)
        prec = devices.resolve_precision(precision)
        ok, why = devices.precision_supported(dev, prec)
        if not ok:
            raise devices.DeviceUnavailable(why or f"{prec} is not supported on {dev}")
        problems = self._problems(check_pin=False)
        if problems["weights"] or problems["dependency"]:
            raise EncoderUnavailable(self.id, self._status_of(problems), self._detail_of(problems))
        if problems["mismatch"]:
            raise EncoderLoadError(self.id, self._detail_of(problems))
        pins: list[tuple[str, str]] = []
        if expected_weights_sha256 is not None:
            expected = str(expected_weights_sha256).strip().lower()
            if not _SHA256_RE.match(expected):
                raise ValueError("expected_weights_sha256 must be a 64-character hex SHA-256")
            pins.append(("expected_weights_sha256", expected))
        env_pin, _ = self._pin()
        if env_pin is not None:
            pins.append((self.spec.expected_weights_sha256_env, env_pin))
        _force_offline()
        wfile = self._weights_file()
        # Validate the very config bytes the model is built from (not an earlier read).
        cfg, raw_cfg, cfg_problems = self._read_config()
        if cfg is not None:
            cfg_problems += self._config_problems(cfg)
        if cfg_problems:
            raise EncoderLoadError(self.id, "; ".join(cfg_problems))
        config_sha = hashlib.sha256(raw_cfg).hexdigest() if raw_cfg is not None else None
        spec_sha = self.spec.spec_sha256()

        def check(actual: str) -> None:
            for source, expected in pins:
                self._check_expected(self.id, actual, expected, source)

        known = _memo_get(wfile)
        if known is not None:
            check(known)
            with _LOAD_LOCK:
                hit = _LOADED.get((self.id, spec_sha, known, config_sha, dev, prec))
            if hit is not None:
                return hit
        with _LOAD_LOCK:
            data, digest = _read_once(wfile)  # the one read: these bytes are hashed AND deserialised
            check(digest)
            key = (self.id, spec_sha, digest, config_sha, dev, prec)
            if key in _LOADED:
                return _LOADED[key]
            kind = self._weights_kind(wfile)
            try:
                state = self._deserialize(data, kind)
            except Exception as exc:
                raise EncoderLoadError(self.id, f"{wfile.name} could not be read as {kind}: {exc}") from exc
            del data
            if not isinstance(state, dict) or not all(isinstance(k, str) for k in state):
                raise EncoderLoadError(self.id, f"{wfile.name} is not a flat state dict of named tensors")
            loaded = self._materialise(state, cfg, digest, config_sha, dev, prec)
            for stale in [k for k in _LOADED if k[0] == self.id and k[1:4] != key[1:4]]:
                del _LOADED[stale]
            _LOADED[key] = loaded
            return loaded

    def _materialise(self, state: dict, cfg: dict | None, digest: str, config_sha: str | None, dev: str,
                     prec: str) -> LoadedEncoder:
        import torch

        weights_dtypes = sorted({str(t.dtype).removeprefix("torch.") for t in state.values()
                                 if isinstance(t, torch.Tensor)})
        try:
            model, forward = self._build(state, cfg)
        except EncoderUnavailable:
            raise
        except Exception as exc:
            raise EncoderLoadError(self.id, f"strict load failed: {exc}") from exc
        del state
        model.eval()
        model.to(device=dev, dtype=devices.torch_dtype(prec))
        threads = devices.cpu_threads()
        runtime = {**devices.runtime_info(dev, prec, threads=threads), "weights_dtypes": weights_dtypes}
        if cfg is not None and "auto_map" in cfg:
            runtime["ignored_auto_map"] = True  # remote code is never executed
        dtype = devices.torch_dtype(prec)
        spec = self.spec

        def run(x: np.ndarray) -> np.ndarray:
            batch = preprocess(x, spec)
            with devices.inference_context(dev, threads=threads):
                out = forward(model, batch.to(device=dev, dtype=dtype))
                return out.float().cpu().numpy()

        loaded = LoadedEncoder(spec=spec, weights_sha256=digest, device=dev, precision=prec, embed_fn=run,
                               runtime=runtime, config_sha256=config_sha, model=model)
        # Probe one blank patch: proves the forward pass runs and the output dimension matches the spec.
        loaded.embed_batch(np.full((1, spec.input_size, spec.input_size, 3), 255, dtype=np.uint8))
        return loaded

    def embed(self, patches, coords, ctx) -> np.ndarray:
        """DEPRECATED legacy path used by :mod:`dermpath.ml.features` (CPU unless ``WB_ML_DEVICE``, fp32)."""
        _refuse_label_context(self.id, ctx)
        if patches is None:
            raise ValueError(f"{self.id} needs pixels (pixel_mode=read)")
        arr = pil_patches_to_uint8(patches, self.spec.input_size)
        return self.load(device=_legacy_device(), precision="fp32").embed_batch(arr)


def _forward_plain(model, x):
    return model(x)


class UNIEncoder(_TorchWeightsAdapter):
    default_spec = UNI_SPEC
    dependencies = (("torch", "2.1"), ("timm", "0.9.8"))
    expected_location = ("a local file: pytorch_model.bin from the gated MahmoodLab UNI release (ViT-L/16 state dict), "
                         "obtained after accepting its terms (or the directory that contains it)")

    def _build(self, state: dict, config: dict | None):
        import timm

        arch = self.spec.architecture
        model = _meta_build(lambda: timm.create_model(arch["model"], pretrained=False, **arch["kwargs"]))
        _strict_load(model, state)
        return model, _forward_plain


class GenericResNet18Encoder(_TorchWeightsAdapter):
    default_spec = RESNET_SPEC
    dependencies = (("torch", "2.1"), ("torchvision", "0.16"))
    expected_location = "a local file: a torchvision resnet18 ImageNet state dict (.pth), including its fc layer"

    def _build(self, state: dict, config: dict | None):
        import torch
        import torchvision

        arch = self.spec.architecture
        model = _meta_build(lambda: getattr(torchvision.models, arch["model"])(**arch["kwargs"]))
        _strict_load(model, state)
        model.fc = torch.nn.Identity()
        return model, _forward_plain


def _dinov2_cls_mean_patch(model, x):
    import torch

    hidden = model(pixel_values=x).last_hidden_state
    n_registers = int(getattr(model.config, "num_register_tokens", 0) or 0)
    return torch.cat([hidden[:, 0], hidden[:, 1 + n_registers:].mean(dim=1)], dim=-1)


def _dinov2_pooler(model, x):
    return model(pixel_values=x).pooler_output


_DINOV2_POOLING = {"cls+mean_patch_concat": _dinov2_cls_mean_patch, "pooler_output": _dinov2_pooler}

# Checkpoints saved with transformers 4.x (for example Midnight-12k, saved with 4.43) use the legacy Dinov2 parameter
# names. transformers 5 renamed them, and its own pretrained-checkpoint loader converts on load with these rules
# (transformers conversion_mapping.py, "Dinov2Model" / "Dinov2WithRegistersModel"): three attention renames, the fused
# SwiGLU input projection split in two along dim 0 (first half gate, second half up), and the output projection
# renamed. We never use that loader (it can reach the network); we build from the exact hashed bytes, so the same
# rules are applied here. Parity with the transformers loader is checked by tests (tiny models,
# tests/test_ml_dinov2_legacy_keys.py) and was measured once on the real Midnight-12k weights (CPU fp32, 8 patches,
# max abs diff 2.0e-06; to be recorded in docs/ml-engine-report.md).
_DINOV2_LEGACY_RENAMES = (
    (".attention.attention.query.", ".attention.q_proj."),
    (".attention.attention.key.", ".attention.k_proj."),
    (".attention.attention.value.", ".attention.v_proj."),
    (".attention.output.dense.", ".attention.o_proj."),
    (".mlp.weights_out.", ".mlp.down_proj."),
)
_DINOV2_LEGACY_SPLIT = (".mlp.weights_in.", (".mlp.gate_proj.", ".mlp.up_proj."))


def convert_legacy_dinov2_state(state: dict) -> tuple[dict, dict]:
    """Rename transformers-4 Dinov2 keys to transformers-5 names; return ``(state, report)``.

    A state dict that already uses the new names is returned unchanged. Anything not covered by the rules keeps its
    name, so an unknown layout still fails the strict load loudly instead of loading partially.
    """
    out: dict = {}
    renamed = split = 0
    src, (gate, up) = _DINOV2_LEGACY_SPLIT
    for key, tensor in state.items():
        if src in key:
            if tensor.shape[0] % 2:
                raise ValueError(f"{key}: fused SwiGLU projection has an odd first dimension {tuple(tensor.shape)}")
            g, u = tensor.chunk(2, dim=0)
            out[key.replace(src, gate)] = g.contiguous()
            out[key.replace(src, up)] = u.contiguous()
            split += 1
            continue
        new = key
        for old, rep in _DINOV2_LEGACY_RENAMES:
            if old in new:
                new = new.replace(old, rep)
        renamed += new != key
        out[new] = tensor
    report = {"rule": "transformers-5 Dinov2 legacy key conversion (q/k/v/o renames, SwiGLU weights_in chunk dim 0 → "
                      "gate, up; weights_out → down_proj)", "renamed": renamed, "split": split}
    return out, report


class _HFDinov2Adapter(_TorchWeightsAdapter):
    """A configurable, offline transformers DINOv2 adapter (native classes only; no remote code)."""

    dependencies = (("torch", "2.1"), ("transformers", "4.48"), ("safetensors", "0.4"))

    def _build(self, state: dict, config: dict | None):
        import transformers

        arch = self.spec.architecture
        if config is None:
            raise RuntimeError("config.json is required for an hf_dir encoder")
        config_cls = getattr(transformers, arch["config_class"])
        model_cls = getattr(transformers, arch["model_class"])
        cfg = config_cls.from_dict({k: v for k, v in config.items() if k not in _HF_CONFIG_DROP},
                                   attn_implementation=arch["attn_implementation"])
        model = _meta_build(lambda: model_cls(cfg))
        state, self._last_key_conversion = convert_legacy_dinov2_state(state)
        _strict_load(model, state)
        pooling = self.spec.pooling.split(" ", 1)[0]
        return model, _DINOV2_POOLING[pooling]


class MidnightEncoder(_HFDinov2Adapter):
    default_spec = MIDNIGHT_SPEC
    expected_location = ("a local directory with config.json and model.safetensors from kaiko-ai/midnight (MIT), "
                         "copied there by you")


class HibouBEncoder(_HFDinov2Adapter):
    default_spec = HIBOU_B_SPEC
    expected_location = ("a local directory with config.json and model.safetensors from the gated histai/hibou-b "
                         "release, obtained after accepting its terms")


REGISTRY: dict[str, EncoderAdapter] = {
    a.id: a for a in (SyntheticDeterministicEncoder(), HandcraftedStainTextureEncoder(), UNIEncoder(),
                      MidnightEncoder(), HibouBEncoder(), GenericResNet18Encoder())
}


def get_encoder(encoder_id: str) -> EncoderAdapter | None:
    return REGISTRY.get(encoder_id)


def list_encoders() -> list[dict]:
    return [a.describe() for a in REGISTRY.values()]
