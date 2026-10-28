"""ML settings (environment, prefix ``WB_ML_``) and experiment parameter validation.

Defaults
--------
``WB_ML_TARGET_MPP`` (0.5 µm/px): patch scale when the slide's microns-per-pixel is known.
``WB_ML_PATCH_SIZE`` (224): patch edge in output pixels for the legacy path and for encoders
that read no pixels; an encoder that reads pixels always uses its own ``input_size``.
``WB_ML_MAX_PATCHES`` (64): bound on patches per slide (seeded sampling above it).
``WB_ML_FALLBACK_DOWNSAMPLE`` (4): when mpp is unknown, the pyramid level closest to this
downsample is used and the scale is recorded as UNCALIBRATED (legacy path).
``WB_ML_MIN_TISSUE`` (0.25): minimum tissue fraction (from the mask) for a patch; the same
default as :class:`dermpath.ml.patching.PatchPolicy` (design §4).
``WB_ML_N_BOOT`` (1000), ``WB_ML_BOOT_MIN_PATIENTS`` (10): patient-cluster bootstrap.
``WB_ML_SUBGROUP_MIN_N`` (10): minimum PATIENTS (with both classes) per subgroup.

Experiment parameters (:class:`ExperimentParams`, unknown keys refused with 422) are resolved
ONCE at experiment creation and frozen into the run (``params_json``, hashed into the run
identity). :func:`resolve_params` is the generic resolver (legacy feature path);
:func:`resolve_experiment_params` adds the encoder-aware rules used by experiment creation,
the benchmark harness and the CLI.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator

HEADS = ("meanpool_logreg", "abmil")
EVALUATION_PROTOCOLS = ("holdout", "dev_cv")
SYNTHETIC_PARAM_PREFIX = "synthetic_"
#: Parameters that shape feature generation (they reach the feature set through
#: ``feature_sets.policies_from_params``); everything else configures heads and protocols.
FEATURE_PARAM_KEYS = ("patch_size", "target_mpp", "fallback_downsample", "max_patches_per_slide",
                      "min_tissue_fraction", "pixel_mode", "sampling_strategy", "sampling_seed",
                      "stain_normalization", "stain_source_estimate", "edge_mode", "fragment_rescue_min_area_um2",
                      "allow_uncalibrated", "device", "precision", "synthetic_dim", "synthetic_signal_strength",
                      "synthetic_signal_fraction")


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
    # Aligned with PatchPolicy.min_tissue_fraction (design §4).
    min_tissue_fraction: float = 0.25
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

    # ---- feature generation (mapped to PatchPolicy / SamplingPolicy / StainPolicy by
    #      feature_sets.policies_from_params; any change gives a new feature set)
    # None -> the encoder's input_size; another value must equal it (no resizing in encoders).
    patch_size: int | None = Field(None, ge=32, le=1024)
    target_mpp: float | None = Field(None, gt=0.05, le=8.0)
    fallback_downsample: float | None = Field(None, ge=1.0, le=256.0)
    max_patches_per_slide: int | None = Field(None, ge=1, le=4096)
    # > 0 (as PatchPolicy requires): 0 would accept every grid cell, pure background included.
    min_tissue_fraction: float | None = Field(None, gt=0.0, le=1.0)
    pixel_mode: Literal["read", "none"] = "read"
    sampling_strategy: Literal["spatial", "uniform", "all", "lesion_aware"] = "spatial"
    # Independent of the training seed: head-seed and sampling variance are not confounded.
    sampling_seed: int = Field(0, ge=0, le=2**31 - 1)
    # macenko-v1: the reference is fitted on TRAIN slides of the dataset only (feature_sets).
    stain_normalization: Literal["none", "macenko-v1"] = "none"
    stain_source_estimate: Literal["per_slide", "per_patch"] = "per_slide"
    edge_mode: Literal["shift_inward", "pad", "floor"] = "shift_inward"
    fragment_rescue_min_area_um2: float | None = Field(2000.0, ge=0.0, le=1e9)
    # Forced True in synthetic_pipeline_test only (synthetic tiles have no physical scale).
    allow_uncalibrated: bool = False
    device: str | None = Field(None, pattern=r"^(auto|cpu|mps|cuda(:[0-9]{1,2})?)$")
    precision: Literal["fp32", "fp16", "bf16"] = "fp32"
    # synthetic encoder fixture controls (synthetic_pipeline_test only; refused for real encoders)
    synthetic_dim: int = Field(64, ge=8, le=1024)
    synthetic_signal_strength: float = Field(2.0, ge=0.0, le=20.0)
    synthetic_signal_fraction: float = Field(0.3, ge=0.0, le=1.0)
    # ---- operating point, selected on development data (val for holdout, OOF for dev_cv)
    threshold_rule: Literal["youden", "target_sensitivity", "fixed"] = "youden"
    target_sensitivity: float = Field(0.9, gt=0.0, le=1.0)
    threshold_value: float | None = Field(None, ge=0.0, le=1.0)  # rule "fixed" only
    # Minimum PATIENTS per class before a data-driven threshold is selected; below it a
    # fixed 0.5 is frozen and marked insufficient_evidence (unvalidated).
    min_threshold_evidence: int = Field(10, ge=1, le=100000)
    calibration: Literal["none", "platt", "isotonic"] = "none"
    abstention_target_coverage: float | None = Field(None, gt=0.0, le=1.0)
    target_prevalence: float | None = Field(None, gt=0.0, lt=1.0)
    # ---- development protocols
    inner_val_fraction: float = Field(0.2, gt=0.0, lt=1.0)  # ABMIL early stopping (inner split of train)
    cv_folds: int = Field(5, ge=2, le=20)  # dev_cv only
    # dev_cv only: declared seed of the outer-fold assignment (recorded in the run identity). Folds depend on the
    # development pool's patient / duplicate-group content, k and this seed only (never the head, the training
    # seed or the feature set); 0 keeps the salt of runs made before the parameter existed.
    cv_fold_seed: int = Field(0, ge=0, le=2**31 - 1)
    # learning curves: nested stratified subset of TRAIN patients (dev pool fitting in dev_cv)
    train_patient_fraction: float = Field(1.0, gt=0.0, le=1.0)
    subset_repeat: int = Field(0, ge=0, le=1000)
    # ---- heads
    C: float = Field(1.0, gt=0.0, le=1e6)  # meanpool_logreg
    class_weight: Literal["balanced", "none"] = "balanced"  # both heads
    hidden_dim: int = Field(64, ge=4, le=2048)  # abmil
    attn_dim: int = Field(32, ge=4, le=1024)
    dropout: float = Field(0.0, ge=0.0, le=0.9)
    lr: float = Field(1e-3, gt=0.0, le=1.0)
    weight_decay: float = Field(1e-4, ge=0.0, le=1.0)
    max_epochs: int = Field(40, ge=1, le=2000)
    patience: int = Field(8, ge=1, le=2000)
    # Per-epoch seeded instance subsampling for large bags (None: every instance each epoch).
    max_instances_per_bag: int | None = Field(None, ge=1, le=1_000_000)
    # ---- evaluation
    n_boot: int | None = Field(None, ge=0, le=20000)
    boot_min_patients: int | None = Field(None, ge=2, le=100000)
    subgroup_min_n: int | None = Field(None, ge=1, le=100000)

    @model_validator(mode="after")
    def _threshold_rule_inputs(self) -> "ExperimentParams":
        if self.threshold_rule == "fixed" and self.threshold_value is None:
            raise ValueError("threshold_rule 'fixed' needs threshold_value (prespecified, in [0, 1])")
        if self.threshold_rule != "fixed" and self.threshold_value is not None:
            raise ValueError("threshold_value is used only with threshold_rule 'fixed'")
        if self.train_patient_fraction == 1.0 and self.subset_repeat != 0:
            raise ValueError("subset_repeat is used only with train_patient_fraction < 1 (the whole pool has one "
                             "subset)")
        return self


def _errors(exc: ValidationError) -> list[dict]:
    return [{"loc": [str(x) for x in e.get("loc", ())], "msg": e.get("msg")} for e in exc.errors()]


def resolve_params(raw: dict | None, *, settings: MLSettings | None = None) -> dict:
    """Validate and fill defaults. Raises :class:`ValueError` with readable errors."""
    s = settings or ml_settings()
    try:
        p = ExperimentParams.model_validate(raw or {})
    except ValidationError as exc:
        raise ValueError(_errors(exc)) from exc
    out = p.model_dump()
    defaults = {"patch_size": s.patch_size, "target_mpp": s.target_mpp, "fallback_downsample": s.fallback_downsample,
                "max_patches_per_slide": s.max_patches_per_slide, "min_tissue_fraction": s.min_tissue_fraction,
                "n_boot": s.n_boot, "boot_min_patients": s.boot_min_patients, "subgroup_min_n": s.subgroup_min_n}
    for k, v in defaults.items():
        if out.get(k) is None:
            out[k] = v
    return out


def resolve_experiment_params(raw: dict | None, *, encoder_spec, settings: MLSettings | None = None) -> dict:
    """Resolve experiment params for ``encoder_spec`` (an :class:`~dermpath.ml.encoders.EncoderSpec`).

    On top of :func:`resolve_params`:

    * ``synthetic_*`` keys are accepted only for the synthetic encoder (refused for a real
      encoder, and dropped from its resolved params);
    * ``patch_size``: an encoder that reads pixels uses its ``input_size``; an explicit
      different value is refused (encoders never resize);
    * ``pixel_mode`` ``none`` only for an encoder that reads no pixels;
    * ``lesion_aware`` sampling is refused (it needs permitted expert regions on train slides,
      which experiment creation cannot supply).

    Raises :class:`ValueError` with a list of ``{loc, msg}`` errors."""
    raw = dict(raw or {})
    errors: list[dict] = []
    synthetic = bool(getattr(encoder_spec, "synthetic", False))
    reads_pixels = bool(getattr(encoder_spec, "reads_pixels", True))
    input_size = int(getattr(encoder_spec, "input_size", 0) or 0)
    if not synthetic:
        for k in sorted(raw):
            if k.startswith(SYNTHETIC_PARAM_PREFIX):
                errors.append({"loc": [k], "msg": f"{k} is a synthetic-fixture control, accepted only for the "
                                                  "synthetic encoder"})
    if reads_pixels and input_size > 0 and raw.get("patch_size") not in (None, input_size):
        errors.append({"loc": ["patch_size"], "msg": f"patch_size must equal the encoder input_size {input_size} "
                                                     "(patches arrive at exactly that size; encoders never resize)"})
    if raw.get("pixel_mode") == "none" and reads_pixels:
        errors.append({"loc": ["pixel_mode"], "msg": f"{getattr(encoder_spec, 'id', 'this encoder')} reads pixels; "
                                                     "pixel_mode=none is only valid for an encoder that does not"})
    if raw.get("sampling_strategy") == "lesion_aware":
        errors.append({"loc": ["sampling_strategy"],
                       "msg": "lesion_aware sampling needs permitted expert regions on train slides and is not "
                              "available through experiment creation"})
    if errors:
        raise ValueError(errors)
    if reads_pixels and input_size > 0 and raw.get("patch_size") is None:
        raw["patch_size"] = input_size
    out = resolve_params(raw, settings=settings)
    if not synthetic:
        for k in [k for k in out if k.startswith(SYNTHETIC_PARAM_PREFIX)]:
            del out[k]
    return out


def feature_params(params: dict) -> dict:
    """The subset of resolved params that shapes feature generation."""
    return {k: params[k] for k in FEATURE_PARAM_KEYS if k in params}
