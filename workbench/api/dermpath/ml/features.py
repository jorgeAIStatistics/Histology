"""Legacy feature extraction (DEPRECATED: :mod:`dermpath.ml.feature_sets` replaces it).

Research use only. Kept, with unchanged outputs and cache keys, for callers that have not
migrated to frozen feature sets yet (``training.extract_for_items``, the ``extract_features``
job, active learning). New code builds a feature set and reads
:func:`dermpath.ml.feature_sets.load_slide_features`.

Phase 3 changes here (storage only, never the embeddings):

* cache lookups take the newest ``generation`` of a cache key and serve it only if its object
  exists and matches its sha256; otherwise a new generation row is written (rows are
  append-only, a corrupt row is never served or rewritten);
* objects are written write-once and content-addressed
  (``projects/<pid>/features/legacy[/gen<n>]/<sha256>.npz``);
* :func:`load_features` also reads engine artifacts (``.npy`` embeddings + ``.npz`` coords).

Cache key = SHA-256 over canonical JSON of::

    slide_sha256, encoder_id, weights_sha256 (or the synthetic marker), preprocessing_version,
    patch_size, scale_key (target mpp | fixed level), coords_sha256, key_extra

``key_extra`` holds what else changes the embeddings: for the synthetic encoder, its config
(dim, signal strength/fraction), the pipeline-test fixture label and the seed; for every
encoder, the pixel mode. Embeddings are stored as a deterministic ``.npz`` in the private
object store; the file's SHA-256 is verified on every load.
"""

from __future__ import annotations

import io
import time
from dataclasses import dataclass

import numpy as np
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from ..db import session_scope
from ..models import QCReview, Slide
from ..qc.service import excluded_regions
from ..slides.reader import open_slide_record
from ..storage import StoreError, get_store
from .artifacts import canonical_json, load_npz, npz_bytes, sha256_hex
from .encoders import EmbedContext, EncoderAdapter, get_encoder
from .fixture import SYNTHETIC_PIPELINE_TEST, fixture_context
from .models import FeatureArtifact
from .patching import (
    PATCHING_VERSION,
    Coordinates,
    mask_from_png,
    otsu_mask,
    plan_scale,
    read_patches,
    tissue_coordinates,
)

CHUNK = 32


class FeatureError(Exception):
    """Deterministic extraction failure (bad slide, unparseable exclusion, pixel mode)."""


@dataclass
class ExtractionResult:
    artifact_id: str
    cache_hit: bool
    n_patches: int
    seconds: float


def _sample_seed(slide_sha256: str, seed: int) -> int:
    import hashlib

    return int.from_bytes(hashlib.sha256(f"sample|{slide_sha256}|{seed}".encode()).digest()[:8], "little")


def _latest_mask(db, slide_id: str) -> tuple[str | None, tuple[float, float] | None, str | None]:
    r = db.scalars(select(QCReview).where(QCReview.slide_id == slide_id, QCReview.kind == "automated_screen",
                                          QCReview.mask_object_key.is_not(None))
                   .order_by(QCReview.created_at.desc())).first()
    if r is None:
        return None, None, None
    t = (r.metrics_json or {}).get("tissue", {})
    ds = (float(t.get("mask_downsample_x") or 0), float(t.get("mask_downsample_y") or 0))
    if not ds[0] or not ds[1]:
        return None, None, None
    return r.mask_object_key, ds, r.id


def compute_coordinates(slide: Slide, osr, *, params: dict, seed: int, db_info: dict) -> Coordinates:
    plan = plan_scale(mpp_x=slide.mpp_x, mpp_y=slide.mpp_y,
                      level_downsamples=slide.level_downsamples_json or [1.0], patch_size=params["patch_size"],
                      target_mpp=params["target_mpp"], fallback_downsample=params["fallback_downsample"])
    dims = (int(slide.width), int(slide.height))
    sseed = _sample_seed(slide.sha256, seed)
    excluded = db_info["excluded"]
    if params["pixel_mode"] == "none":
        return tissue_coordinates(dims=dims, plan=plan, mask=None, mask_ds=None, excluded=excluded,
                                  min_tissue_fraction=0.0, max_patches=params["max_patches_per_slide"],
                                  sample_seed=sseed, coordinate_source="synthetic_grid_no_pixels")
    if db_info["mask_key"]:
        mask = mask_from_png(get_store().get_bytes(db_info["mask_key"]))
        mask_ds, source = db_info["mask_ds"], "qc_tissue_mask"
    else:
        mask, mstats = otsu_mask(osr, slide.sha256)
        mask_ds, source = (mstats["mask_downsample_x"], mstats["mask_downsample_y"]), "otsu_fallback"
    coords = tissue_coordinates(dims=dims, plan=plan, mask=mask, mask_ds=mask_ds, excluded=excluded,
                                min_tissue_fraction=params["min_tissue_fraction"],
                                max_patches=params["max_patches_per_slide"], sample_seed=sseed,
                                coordinate_source="tissue_mask")
    coords.stats["tissue_source"] = source
    coords.stats["qc_review_id"] = db_info.get("qc_review_id") if source == "qc_tissue_mask" else None
    coords.stats["mask_downsample"] = [round(float(mask_ds[0]), 4), round(float(mask_ds[1]), 4)]
    return coords


def cache_fields(slide: Slide, encoder: EncoderAdapter, coords: Coordinates, *, params: dict, seed: int,
                 fixture_label: int | None) -> dict:
    extra: dict = {"pixel_mode": params["pixel_mode"]}
    if encoder.synthetic:
        cfg = encoder.config_from_params(params)
        weights, more = encoder.cache_identity(cfg)
        extra.update(more)
        extra.update({"fixture_label": fixture_label, "seed": seed})
    else:
        weights, more = encoder.cache_identity({})
        extra.update(more)
    return {
        "slide_sha256": slide.sha256,
        "encoder_id": encoder.id,
        "weights_sha256": weights,
        "preprocessing_version": f"{PATCHING_VERSION};{encoder.preprocessing_version}",
        "patch_size": int(params["patch_size"]),
        "scale_key": coords.plan.scale_key,
        "coords_sha256": coords.sha256,
        "key_extra": extra,
    }


def extract_slide_features(slide_id: str, *, encoder_id: str, params: dict, seed: int,
                           fixture_label: int | None, ctx=None, job_id: str | None = None,
                           progress_base: float = 0.0, progress_span: float = 0.0) -> ExtractionResult:
    """Embed one slide (or return the cached artifact). Safe to call repeatedly (idempotent)."""
    t0 = time.perf_counter()
    encoder = get_encoder(encoder_id)
    if encoder is None:
        raise FeatureError(f"unknown encoder {encoder_id}")
    encoder.require_available()  # raises EncoderUnavailable; never substitutes another encoder
    if params["pixel_mode"] == "none" and encoder.reads_pixels:
        raise FeatureError(f"pixel_mode=none is only valid for encoders that do not read pixels ({encoder_id} does)")
    with session_scope() as db:
        slide = db.get(Slide, slide_id)
        if slide is None:
            raise FeatureError(f"slide {slide_id} does not exist")
        if slide.ingest_status != "succeeded":
            raise FeatureError(f"slide {slide_id} is not ingested ({slide.ingest_status})")
        if slide.image_kind == "field_image":
            raise FeatureError("field images are not whole-slide images; no patch pipeline")
        mask_key, mask_ds, qc_id = _latest_mask(db, slide_id)
        info = {"excluded": excluded_regions(db, slide_id), "mask_key": mask_key, "mask_ds": mask_ds,
                "qc_review_id": qc_id}
        db.expunge(slide)
    if encoder.synthetic and fixture_label is not None:
        # Design §1 invariant 3: a label-derived fixture signal only ever reaches demo_synthetic
        # synthetic_tiles. This legacy path has no execution mode; a labelled synthetic
        # extraction is by definition a synthetic pipeline test, so fixture.py's rule applies
        # (raises SyntheticSignalForbidden for real or public slides, before any cache lookup).
        fixture_context(slide.provenance, slide.image_kind, SYNTHETIC_PIPELINE_TEST, fixture_label)
    project_id = slide.project_id
    osr = None
    try:
        if params["pixel_mode"] == "read":
            osr = open_slide_record(slide)
        try:
            coords = compute_coordinates(slide, osr, params=params, seed=seed, db_info=info)
        except ValueError as exc:
            raise FeatureError(str(exc)) from exc
        fields = cache_fields(slide, encoder, coords, params=params, seed=seed, fixture_label=fixture_label)
        cache_key = sha256_hex(canonical_json(fields))
        hit, generation = _legacy_cache_lookup(project_id, cache_key)
        if hit is not None:
            return ExtractionResult(hit.id, True, hit.n_patches, time.perf_counter() - t0)
        # Compute.
        n = coords.coords.shape[0]
        cfg = encoder.config_from_params(params) if encoder.synthetic else {}
        ectx = EmbedContext(slide_sha256=slide.sha256, seed=seed,
                            fixture_label=fixture_label if encoder.synthetic else None, config=cfg)
        embs, means = [], []
        t_read = t_embed = 0.0
        for start in range(0, n, CHUNK):
            chunk = coords.coords[start:start + CHUNK]
            patches = None
            if osr is not None:
                tr = time.perf_counter()
                patches, m = read_patches(osr, chunk, coords.plan)
                means.append(m)
                t_read += time.perf_counter() - tr
            te = time.perf_counter()
            embs.append(encoder.embed(patches, chunk, ectx))
            t_embed += time.perf_counter() - te
            if ctx is not None:
                frac = (start + len(chunk)) / max(n, 1)
                ctx.progress(progress_base + progress_span * frac if progress_span else None,
                             f"extracting features: slide {slide_id[:8]} {start + len(chunk)}/{n} patches")
        dim = encoder.config_from_params(params)["dim"] if encoder.synthetic else encoder.embedding_dim
        emb = np.concatenate(embs) if embs else np.zeros((0, dim), dtype=np.float32)
        arrays = {"coords": coords.coords.astype(np.int64), "embeddings": emb.astype(np.float32),
                  "extent": np.array(coords.plan.extent, dtype=np.int64)}
        if means:
            arrays["patch_mean_rgb"] = np.concatenate(means).astype(np.float32)
        meta = {"schema": "dermpath.features/1", "cache_key": cache_key, "fields": fields,
                "synthetic": encoder.synthetic, "scale": coords.plan.scale}
        data = npz_bytes(arrays, meta)
        suffix = "" if generation == 0 else f"/gen{generation}"
        key, _ = get_store().put_content_addressed(f"projects/{project_id}/features/legacy{suffix}", data, ".npz")
        stats = {**coords.stats, "scale": coords.plan.scale, "read_seconds": round(t_read, 4),
                 "embed_seconds": round(t_embed, 4), "total_seconds": round(time.perf_counter() - t0, 4),
                 "pixels_read": osr is not None,
                 "encoder_reads_pixels": encoder.reads_pixels,
                 "notice": encoder.notice if encoder.synthetic else None}
        if osr is not None and n:
            stats["patches_per_second"] = round(n / max(t_read + t_embed, 1e-9), 1)
        art = FeatureArtifact(project_id=project_id, slide_id=slide_id, slide_sha256=slide.sha256,
                              encoder_id=encoder.id, weights_sha256=fields["weights_sha256"],
                              preprocessing_version=fields["preprocessing_version"], patch_size=fields["patch_size"],
                              scale_key=fields["scale_key"], coords_sha256=fields["coords_sha256"],
                              key_extra_json=fields["key_extra"], cache_key=cache_key, object_key=key,
                              sha256=sha256_hex(data), bytes=len(data), n_patches=int(n),
                              embedding_dim=int(emb.shape[1]), calibrated=coords.plan.calibrated,
                              synthetic=encoder.synthetic, stats_json=stats, job_id=job_id, generation=generation)
        try:
            with session_scope() as db:
                db.add(art)
                db.flush()
                art_id = art.id
        except IntegrityError:  # a concurrent worker wrote the same cache entry (generation) first
            with session_scope() as db:
                art_id = db.scalars(select(FeatureArtifact.id).where(FeatureArtifact.project_id == project_id,
                                                                     FeatureArtifact.cache_key == cache_key,
                                                                     FeatureArtifact.generation == generation)).one()
        return ExtractionResult(art_id, False, int(n), time.perf_counter() - t0)
    finally:
        if osr is not None:
            osr.close()


def _legacy_cache_lookup(project_id: str, cache_key: str) -> tuple[FeatureArtifact | None, int]:
    """``(newest row if its object verifies, generation to write next)``. A row whose object is
    missing or corrupt is never served; the replacement is a new generation row."""
    with session_scope() as db:
        rows = db.scalars(select(FeatureArtifact).where(FeatureArtifact.project_id == project_id,
                                                        FeatureArtifact.cache_key == cache_key)
                          .order_by(FeatureArtifact.generation.desc())).all()
    if not rows:
        return None, 0
    latest = rows[0]
    store = get_store()
    try:
        ok = store.exists(latest.object_key) and store.sha256(latest.object_key) == latest.sha256
    except (OSError, StoreError):
        ok = False
    return (latest, latest.generation) if ok else (None, latest.generation + 1)


def load_features(artifact: FeatureArtifact) -> dict[str, np.ndarray]:
    """All arrays of an artifact, sha256-verified (``coords``, ``embeddings``, ...). Engine
    artifacts (feature sets) return their quality arrays prefixed ``q_`` as stored."""
    store = get_store()
    data = store.get_bytes(artifact.object_key)
    if sha256_hex(data) != artifact.sha256:
        raise FeatureError(f"feature artifact {artifact.id} failed its sha256 check (object store corruption)")
    arrays, _ = load_npz(data)
    if artifact.embeddings_key:
        raw = store.get_bytes(artifact.embeddings_key)
        if sha256_hex(raw) != artifact.embeddings_sha256:
            raise FeatureError(f"feature artifact {artifact.id}: embeddings failed their sha256 check")
        arrays["embeddings"] = np.load(io.BytesIO(raw), allow_pickle=False)
    return arrays


def artifact_dict(a: FeatureArtifact) -> dict:
    from . import PIPELINE_TEST_BANNER

    return {
        "id": a.id, "slide_id": a.slide_id, "slide_sha256": a.slide_sha256, "encoder_id": a.encoder_id,
        "weights_sha256": a.weights_sha256, "preprocessing_version": a.preprocessing_version,
        "patch_size": a.patch_size, "scale_key": a.scale_key, "calibrated": a.calibrated,
        "coords_sha256": a.coords_sha256, "key_extra": a.key_extra_json, "cache_key": a.cache_key,
        "object_key": a.object_key, "sha256": a.sha256, "bytes": a.bytes, "n_patches": a.n_patches,
        "embedding_dim": a.embedding_dim, "stats": a.stats_json, "synthetic": a.synthetic,
        "banner": PIPELINE_TEST_BANNER if a.synthetic else None, "job_id": a.job_id,
        "created_at": a.created_at.isoformat(), "generation": a.generation,
        # Engine provenance (feature sets; null on legacy rows).
        "encoder_spec_sha256": a.encoder_spec_sha256, "policy_sha256": a.policy_sha256,
        "stain_policy_sha256": a.stain_policy_sha256, "mask_sha256": a.mask_sha256,
        "excluded_regions_sha256": a.excluded_regions_sha256, "extraction_env_sha256": a.extraction_env_sha256,
        "embeddings_key": a.embeddings_key, "embeddings_sha256": a.embeddings_sha256, "quality_key": a.quality_key,
        "quality_sha256": a.quality_sha256, "device": a.device, "precision": a.precision, "coverage": a.coverage_json,
    }
