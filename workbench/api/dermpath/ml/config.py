"""ML settings (environment, prefix ``WB_ML_``) and experiment parameter validation.

Defaults
--------
``WB_ML_TARGET_MPP`` (0.5 µm/px): patch scale when the slide's microns-per-pixel is known.
``WB_ML_PATCH_SIZE`` (224): patch edge in output pixels.
``WB_ML_MAX_PATCHES`` (64): bound on patches per slide (seeded sampling above it).
``WB_ML_FALLBACK_DOWNSAMPLE`` (4): when mpp is unknown, the pyramid level closest to this
downsample is used and the scale is recorded as UNCALIBRATED.
``WB_ML_MIN_TISSUE`` (0.5): minimum tissue fraction (from the mask) for a patch.
``WB_ML_N_BOOT`` (1000), ``WB_ML_BOOT_MIN_PATIENTS`` (10): patient-cluster bootstrap.
``WB_ML_SUBGROUP_MIN_N`` (10): minimum items (with both classes) per subgroup.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError

HEADS = ("meanpool_logreg", "abmil")


def _f(name: str, default: float) -> float:
    raw = os.environ.get(name)
    return float(raw) if raw not in (None, "") else default


def _i(name: str, default: int) -> int:
    raw = os.environ.get(name)
    return int(raw) if raw not in (None, "") else default


@dataclass(frozen=True)
class MLSettings:
    target_mpp: float = 0.5
    patch_size: int = 224
    max_patches_per_slide: int = 64
    fallback_downsample: float = 4.0
    min_tissue_fraction: float = 0.5
    n_boot: int = 1000
    boot_min_patients: int = 10
    subgroup_min_n: int = 10

    @classmethod
    def from_env(cls) -> "MLSettings":
        return cls(
            target_mpp=_f("WB_ML_TARGET_MPP", cls.target_mpp),
            patch_size=_i("WB_ML_PATCH_SIZE", cls.patch_size),
            max_patches_per_slide=_i("WB_ML_MAX_PATCHES", cls.max_patches_per_slide),
            fallback_downsample=_f("WB_ML_FALLBACK_DOWNSAMPLE", cls.fallback_downsample),
            min_tissue_fraction=_f("WB_ML_MIN_TISSUE", cls.min_tissue_fraction),
            n_boot=_i("WB_ML_N_BOOT", cls.n_boot),
            boot_min_patients=_i("WB_ML_BOOT_MIN_PATIENTS", cls.boot_min_patients),
            subgroup_min_n=_i("WB_ML_SUBGROUP_MIN_N", cls.subgroup_min_n),
        )


def ml_settings() -> MLSettings:
    return MLSettings.from_env()


class ExperimentParams(BaseModel):
    """Every tunable of one experiment. Unknown keys are rejected (422)."""

    model_config = ConfigDict(extra="forbid")

    # patching / features
    patch_size: int | None = Field(None, ge=32, le=1024)
    target_mpp: float | None = Field(None, gt=0.05, le=8.0)
    fallback_downsample: float | None = Field(None, ge=1.0, le=256.0)
    max_patches_per_slide: int | None = Field(None, ge=1, le=4096)
    min_tissue_fraction: float | None = Field(None, ge=0.0, le=1.0)
    pixel_mode: Literal["read", "none"] = "read"
    # synthetic encoder fixture controls (pipeline tests only)
    synthetic_dim: int = Field(64, ge=8, le=1024)
    synthetic_signal_strength: float = Field(2.0, ge=0.0, le=20.0)
    synthetic_signal_fraction: float = Field(0.3, ge=0.0, le=1.0)
    # threshold
    threshold_rule: Literal["youden", "target_sensitivity"] = "youden"
    target_sensitivity: float = Field(0.9, gt=0.0, le=1.0)
    # meanpool_logreg
    C: float = Field(1.0, gt=0.0, le=1e6)
    class_weight: Literal["balanced", "none"] = "balanced"
    # abmil
    hidden_dim: int = Field(64, ge=4, le=2048)
    attn_dim: int = Field(32, ge=4, le=1024)
    dropout: float = Field(0.0, ge=0.0, le=0.9)
    lr: float = Field(1e-3, gt=0.0, le=1.0)
    weight_decay: float = Field(1e-4, ge=0.0, le=1.0)
    max_epochs: int = Field(40, ge=1, le=2000)
    patience: int = Field(8, ge=1, le=2000)
    # evaluation
    n_boot: int | None = Field(None, ge=0, le=20000)
    boot_min_patients: int | None = Field(None, ge=2, le=100000)
    subgroup_min_n: int | None = Field(None, ge=1, le=100000)


def resolve_params(raw: dict | None, *, settings: MLSettings | None = None) -> dict:
    """Validate and fill defaults. Raises :class:`ValueError` with readable errors."""
    s = settings or ml_settings()
    try:
        p = ExperimentParams.model_validate(raw or {})
    except ValidationError as exc:
        errors = [{"loc": [str(x) for x in e.get("loc", ())], "msg": e.get("msg")} for e in exc.errors()]
        raise ValueError(errors) from exc
    out = p.model_dump()
    defaults = {"patch_size": s.patch_size, "target_mpp": s.target_mpp, "fallback_downsample": s.fallback_downsample,
                "max_patches_per_slide": s.max_patches_per_slide, "min_tissue_fraction": s.min_tissue_fraction,
                "n_boot": s.n_boot, "boot_min_patients": s.boot_min_patients, "subgroup_min_n": s.subgroup_min_n}
    for k, v in defaults.items():
        if out.get(k) is None:
            out[k] = v
    return out
