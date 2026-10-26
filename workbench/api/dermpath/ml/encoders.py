"""Encoder adapter registry: license metadata, honest dependency status, no downloads.

Adapters
--------
``synthetic-deterministic-v1``
    Always available. Embeddings are a pure function of (slide sha256, level-0 patch
    coordinates, seed) through SHA-256 → PCG64 Gaussian noise, plus an injected class signal
    taken from the dataset label of the pipeline-test fixture (so a head can learn
    *something* and the orchestration is testable). Pixels are never used. It carries NO
    pathology information; everything downstream is a PIPELINE TEST.

``uni-v1`` (pathology foundation model, CC-BY-NC-ND 4.0, gated)
    ``missing_weights`` unless ``WB_UNI_WEIGHTS`` names an existing local file AND
    ``WB_UNI_LICENSE_ACCEPTED=1``. With both, it still needs the ``timm`` package for the
    ViT-L/16 architecture; without it the status is ``missing_dependency``. The weights'
    SHA-256 is computed on load. It never downloads anything (``pretrained=False``; no hub
    client is imported) and never substitutes another encoder under its name.

``generic-imagenet-resnet18``
    A GENERIC ImageNet backbone, not a pathology model. Needs ``torchvision`` AND a local
    weights file in ``WB_RESNET18_WEIGHTS``; otherwise ``missing_dependency`` /
    ``missing_weights``. Never downloaded.
"""

from __future__ import annotations

import hashlib
import importlib.util
import os
import threading
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from . import PIPELINE_TEST_BANNER

SYNTHETIC_ID = "synthetic-deterministic-v1"
UNI_ID = "uni-v1"
RESNET_ID = "generic-imagenet-resnet18"
SYNTHETIC_WEIGHTS_MARKER = "synthetic:no-weights"

STATUS_AVAILABLE = "available"
STATUS_MISSING_WEIGHTS = "missing_weights"
STATUS_MISSING_DEPENDENCY = "missing_dependency"

IMAGENET_MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
IMAGENET_STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)


class EncoderUnavailable(Exception):
    def __init__(self, encoder_id: str, status: str, detail: str) -> None:
        super().__init__(f"encoder {encoder_id} is {status}: {detail}")
        self.encoder_id = encoder_id
        self.status = status
        self.detail = detail


@dataclass
class EmbedContext:
    """What an encoder may know about the patches it embeds."""

    slide_sha256: str
    seed: int
    fixture_label: int | None = None  # synthetic encoder only: 1 positive, 0 negative, None unknown
    config: dict = field(default_factory=dict)


class EncoderAdapter(ABC):
    id: str
    name: str
    kind: str  # synthetic | pathology_foundation | generic_imagenet
    license: dict
    synthetic: bool = False
    notice: str = ""
    preprocessing_version: str = ""
    embedding_dim: int = 0
    reads_pixels: bool = True

    @abstractmethod
    def status(self) -> tuple[str, str | None]:
        """``(status, status_detail)``. Cheap; never downloads, never loads weights."""

    def weights_sha256(self) -> str | None:
        return None

    def describe(self) -> dict:
        status, detail = self.status()
        return {
            "id": self.id,
            "name": self.name,
            "kind": self.kind,
            "license": self.license,
            "status": status,
            "status_detail": detail,
            "weights_sha256": self.weights_sha256() if status == STATUS_AVAILABLE else None,
            "embedding_dim": self.embedding_dim,
            "preprocessing_version": self.preprocessing_version,
            "synthetic": self.synthetic,
            "reads_pixels": self.reads_pixels,
            "notice": self.notice,
            "banner": PIPELINE_TEST_BANNER if self.synthetic else None,
        }

    def require_available(self) -> None:
        status, detail = self.status()
        if status != STATUS_AVAILABLE:
            raise EncoderUnavailable(self.id, status, detail or status)

    def cache_identity(self, config: dict) -> tuple[str, dict]:
        """``(weights_sha256 or marker, extra key fields)`` for the feature cache."""
        return self.weights_sha256() or "unknown", {}

    @abstractmethod
    def embed(self, patches: list | None, coords: np.ndarray, ctx: EmbedContext) -> np.ndarray:
        """Return float32 ``(N, D)`` embeddings for N patches (``coords`` level-0 x, y)."""


# --------------------------------------------------------------------------- synthetic


def _u64(data: bytes) -> int:
    return int.from_bytes(hashlib.sha256(data).digest()[:8], "little")


class SyntheticDeterministicEncoder(EncoderAdapter):
    id = SYNTHETIC_ID
    name = "Synthetic deterministic embeddings (pipeline test)"
    kind = "synthetic"
    synthetic = True
    reads_pixels = False
    preprocessing_version = "synthetic-hash/1"
    embedding_dim = 64
    license = {"name": "Project code (no third-party weights)", "url": None, "commercial_use": "unknown",
               "notes": "No model weights exist. The workbench's own licence terms apply to the code."}
    notice = ("Embeddings are SHA-256-seeded Gaussian noise keyed by (slide sha256, patch coordinates, seed), with a "
              "class signal injected from the pipeline-test fixture's dataset label so learning is possible. They carry "
              "NO pathology information and never look at pixels. Every result is a PIPELINE TEST — NOT PATHOLOGY "
              "VALIDATION.")

    def status(self) -> tuple[str, str | None]:
        return STATUS_AVAILABLE, None

    def config_from_params(self, params: dict) -> dict:
        return {"dim": int(params.get("synthetic_dim", 64)),
                "signal_strength": float(params.get("synthetic_signal_strength", 2.0)),
                "signal_fraction": float(params.get("synthetic_signal_fraction", 0.3))}

    def cache_identity(self, config: dict) -> tuple[str, dict]:
        return SYNTHETIC_WEIGHTS_MARKER, {"encoder_config": config}

    def embed(self, patches, coords: np.ndarray, ctx: EmbedContext) -> np.ndarray:
        cfg = ctx.config or {"dim": 64, "signal_strength": 2.0, "signal_fraction": 0.3}
        dim = int(cfg["dim"])
        n = int(coords.shape[0])
        out = np.empty((n, dim), dtype=np.float64)
        slide_key = f"{ctx.slide_sha256}|seed={ctx.seed}".encode()
        # A per-slide nuisance offset (a stand-in for batch effects) and a fixed signal direction.
        slide_offset = np.random.default_rng(_u64(b"offset|" + slide_key)).standard_normal(dim) * 0.3
        direction = np.random.default_rng(_u64(f"direction|{ctx.seed}|{dim}".encode())).standard_normal(dim)
        direction /= np.linalg.norm(direction)
        for i in range(n):
            x, y = int(coords[i, 0]), int(coords[i, 1])
            pk = slide_key + f"|{x}|{y}".encode()
            vec = np.random.default_rng(_u64(b"patch|" + pk)).standard_normal(dim) + slide_offset
            if ctx.fixture_label == 1:
                u = (_u64(b"signal|" + pk) % 1_000_000) / 1_000_000.0
                if u < cfg["signal_fraction"]:
                    vec = vec + cfg["signal_strength"] * direction
            out[i] = vec
        return out.astype(np.float32)


# --------------------------------------------------------------------------- weights helpers

_hash_cache: dict[tuple[str, int, float], str] = {}
_hash_lock = threading.Lock()


def file_sha256(path: Path) -> str:
    st = path.stat()
    key = (str(path.resolve()), st.st_size, st.st_mtime)
    with _hash_lock:
        if key in _hash_cache:
            return _hash_cache[key]
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for block in iter(lambda: fh.read(4 * 1024 * 1024), b""):
            h.update(block)
    digest = h.hexdigest()
    with _hash_lock:
        _hash_cache[key] = digest
    return digest


def _module_present(name: str) -> bool:
    return importlib.util.find_spec(name) is not None


def _to_tensor_batch(patches: list, size: int) -> "object":
    import torch
    from PIL import Image

    arrs = []
    for p in patches:
        img = p.convert("RGB")
        if img.size != (size, size):
            img = img.resize((size, size), Image.Resampling.BILINEAR)
        a = (np.asarray(img, dtype=np.float32) / 255.0 - IMAGENET_MEAN) / IMAGENET_STD
        arrs.append(a.transpose(2, 0, 1))
    return torch.from_numpy(np.stack(arrs))


class _LocalWeightsEncoder(EncoderAdapter):
    weights_env: str = ""
    license_env: str | None = None
    dependency: str = ""
    expected_file: str = ""
    _model = None
    _model_lock = threading.Lock()

    def _weights_path(self) -> Path | None:
        raw = os.environ.get(self.weights_env, "").strip()
        return Path(raw).expanduser() if raw else None

    def status(self) -> tuple[str, str | None]:
        path = self._weights_path()
        problems = []
        if path is None:
            problems.append(f"{self.weights_env} is not set; it must name a local file: {self.expected_file}")
        elif not path.is_file():
            problems.append(f"{self.weights_env}={path} does not exist or is not a file (expected {self.expected_file})")
        if self.license_env and os.environ.get(self.license_env, "").strip() != "1":
            problems.append(f"{self.license_env}=1 is not set (confirms the licence terms were accepted and the weights "
                            "were obtained legally)")
        if problems:
            return STATUS_MISSING_WEIGHTS, "; ".join(problems) + ". Nothing is downloaded automatically."
        if not _module_present(self.dependency):
            return STATUS_MISSING_DEPENDENCY, (
                f"Python package '{self.dependency}' is not installed; it is required to build this encoder's "
                f"architecture (weights file found at {path}). Nothing is installed or downloaded automatically.")
        return STATUS_AVAILABLE, None

    def weights_sha256(self) -> str | None:
        path = self._weights_path()
        if path is None or not path.is_file():
            return None
        return file_sha256(path)

    def cache_identity(self, config: dict) -> tuple[str, dict]:
        self.require_available()
        return self.weights_sha256(), {}

    @abstractmethod
    def _build(self, path: Path):
        ...

    def _loaded(self):
        self.require_available()
        with self._model_lock:
            if self._model is None:
                self._model = self._build(self._weights_path())
        return self._model

    def embed(self, patches, coords, ctx):  # pragma: no cover - needs weights + timm/torchvision (absent here)
        import torch

        if patches is None:
            raise ValueError(f"{self.id} needs pixels (pixel_mode=read)")
        model = self._loaded()
        out = []
        with torch.inference_mode():
            for i in range(0, len(patches), 32):
                out.append(model(_to_tensor_batch(patches[i:i + 32], 224)).float().numpy())
        return np.concatenate(out).astype(np.float32) if out else np.zeros((0, self.embedding_dim), np.float32)


class UNIEncoder(_LocalWeightsEncoder):
    id = UNI_ID
    name = "UNI (ViT-L/16, pathology foundation model)"
    kind = "pathology_foundation"
    weights_env = "WB_UNI_WEIGHTS"
    license_env = "WB_UNI_LICENSE_ACCEPTED"
    dependency = "timm"
    expected_file = ("pytorch_model.bin from the gated MahmoodLab UNI release (ViT-L/16 state dict), obtained after "
                     "accepting its terms")
    preprocessing_version = "uni/resize224+imagenet-norm/1"
    embedding_dim = 1024
    license = {"name": "CC-BY-NC-ND 4.0 (gated access)", "url": "https://huggingface.co/MahmoodLab/UNI",
               "commercial_use": "no",
               "notes": "Non-commercial research only, no derivatives distributed; access requires accepting the "
                        "model terms. The workbench never downloads it."}
    notice = ("Pathology foundation encoder. Enabled only with legally obtained local weights; results from it are "
              "still research outputs, not validated diagnostics.")

    def _build(self, path: Path):  # pragma: no cover - timm is not installed in this environment
        import timm
        import torch

        model = timm.create_model("vit_large_patch16_224", img_size=224, patch_size=16, init_values=1e-5,
                                  num_classes=0, dynamic_img_size=True, pretrained=False)
        state = torch.load(str(path), map_location="cpu", weights_only=True)
        model.load_state_dict(state, strict=True)  # a mismatched file fails loudly; no partial load
        model.eval()
        return model


class GenericResNet18Encoder(_LocalWeightsEncoder):
    id = RESNET_ID
    name = "ResNet-18 (generic ImageNet, NOT a pathology model)"
    kind = "generic_imagenet"
    weights_env = "WB_RESNET18_WEIGHTS"
    license_env = None
    dependency = "torchvision"
    expected_file = "a torchvision resnet18 ImageNet state dict (.pth) stored locally"
    preprocessing_version = "resnet18/resize224+imagenet-norm/1"
    embedding_dim = 512
    license = {"name": "BSD-3-Clause (torchvision code); weights terms per their source", "url":
               "https://github.com/pytorch/vision", "commercial_use": "unknown",
               "notes": "ImageNet-trained weights; check the terms of the weights you supply."}
    notice = "Generic natural-image features. Not trained on pathology; not a pathology encoder."

    def status(self) -> tuple[str, str | None]:
        # Report the missing library first: without torchvision the weights cannot be used at all.
        if not _module_present(self.dependency):
            path = self._weights_path()
            weights = (f"{self.weights_env} is also not set" if path is None else
                       f"{self.weights_env}={path}" + ("" if path.is_file() else " (file not found)"))
            return STATUS_MISSING_DEPENDENCY, (f"Python package 'torchvision' is not installed; {weights}. "
                                               "Nothing is installed or downloaded automatically.")
        return super().status()

    def _build(self, path: Path):  # pragma: no cover - torchvision is not installed in this environment
        import torch
        import torchvision

        model = torchvision.models.resnet18(weights=None)
        model.load_state_dict(torch.load(str(path), map_location="cpu", weights_only=True), strict=True)
        model.fc = torch.nn.Identity()
        model.eval()
        return model


REGISTRY: dict[str, EncoderAdapter] = {
    a.id: a for a in (SyntheticDeterministicEncoder(), UNIEncoder(), GenericResNet18Encoder())
}


def get_encoder(encoder_id: str) -> EncoderAdapter | None:
    return REGISTRY.get(encoder_id)


def list_encoders() -> list[dict]:
    return [a.describe() for a in REGISTRY.values()]
