"""Bounded-memory extraction and artifact integrity for feature sets (design §5).

* memory stays bounded (tracemalloc) while many patches stream from an ``openslide.ImageSlide``
  over a large synthetic PIL image;
* embeddings are streamed into a memory-mapped ``.npy`` and stored content-addressed and
  write-once next to a small coords/quality ``.npz``; artifact rows carry the provenance columns;
* a feature set pinned to weights sha A refuses when the encoder now loads sha B (tiny random
  timm ViT through the real UNI adapter code; no weights are downloaded);
* a changed slide file is refused (``input_changed``) and the slide hash is memoised per process;
* a missing or corrupt object is never served: a new generation is written (engine and legacy);
* builds stop cooperatively between batches and resume.
"""

from __future__ import annotations

import hashlib
import tracemalloc

import numpy as np
import pytest
from sqlalchemy import select

from feature_set_support import (
    CMU_PROJECT,
    HANDCRAFTED,
    cmu_slide_id,
    create_set,
    get_set,
    image_slide,
    items_of,
    real_cohort,
)


def _build(fs_id: str, ctx=None) -> dict:
    from dermpath.ml.feature_sets import build_feature_set

    return build_feature_set(fs_id, ctx)


def _tiled_image(side: int, seed: int = 0):
    """A large tissue-like image built by tiling a small random texture (cheap to make)."""
    from PIL import Image

    rng = np.random.default_rng(seed)
    tile = np.empty((256, 256, 3), dtype=np.uint8)
    tile[..., 0] = rng.integers(170, 235, (256, 256))
    tile[..., 1] = rng.integers(90, 160, (256, 256))
    tile[..., 2] = rng.integers(140, 210, (256, 256))
    reps = -(-side // 256)
    return Image.fromarray(np.tile(tile, (reps, reps, 1))[:side, :side], "RGB")


def _cheap_features(patches_uint8, *, input_size=224):
    """Stand-in for the handcrafted features in the memory test: deterministic, 64-d, fast."""
    x = patches_uint8[:, ::8, ::8].reshape(patches_uint8.shape[0], -1, 3).astype(np.float32)
    m = x.mean(axis=1)
    return np.concatenate([np.repeat(m, 21, axis=1), x.std(axis=1)[:, :1]], axis=1).astype(np.float32)


def _peak_while_building(monkeypatch, *, side: int, slide_id: str) -> tuple[int, int, int]:
    """``(overall tracemalloc peak, peak of the patch-streaming loop, n patches)`` of one build."""
    import openslide

    from dermpath.ml import feature_sets as fsm
    from dermpath.ml import handcrafted
    from dermpath.ml.patching import otsu_mask

    image_slide(monkeypatch, slide_id=slide_id, image=_tiled_image(side))
    fs_id = create_set(CMU_PROJECT, encoder_id=HANDCRAFTED, execution_mode="real_image_technical",
                       slide_ids=[slide_id], params={"sampling_strategy": "all"})
    snap = get_set(fs_id).input_snapshot_json["slides"][0]
    otsu_mask(openslide.ImageSlide(fsm._test_images[slide_id]), snap["slide_sha256"])  # warm the mask memo
    monkeypatch.setattr(handcrafted, "features", _cheap_features)
    loop = {}
    real_compute = fsm._compute

    def measured(*a, **kw):
        before = tracemalloc.get_traced_memory()[1]
        tracemalloc.reset_peak()
        try:
            return real_compute(*a, **kw)
        finally:
            loop["peak"] = tracemalloc.get_traced_memory()[1]
            loop["overall_before"] = before

    monkeypatch.setattr(fsm, "_compute", measured)
    tracemalloc.start()
    try:
        _build(fs_id)
        overall = max(tracemalloc.get_traced_memory()[1], loop["overall_before"])
    finally:
        tracemalloc.stop()
        monkeypatch.setattr(fsm, "_compute", real_compute)
    n = items_of(fs_id)[slide_id].stats_json["n_patches"]
    return overall, loop["peak"], n


def test_memory_stays_bounded_while_streaming_many_patches(env, ids, monkeypatch):
    monkeypatch.setenv("WB_ML_BATCH_SIZE", "16")
    small, small_loop, small_n = _peak_while_building(monkeypatch, side=224 * 6, slide_id="memslidesmall")
    large, large_loop, large_n = _peak_while_building(monkeypatch, side=224 * 18, slide_id="memslidelarge")
    patch_bytes = 224 * 224 * 3
    assert small_n == 36 and large_n == 324  # strategy "all": every grid cell of the tissue-filled image
    print(f"\ntracemalloc peaks: streaming loop {small_loop / 1e6:.1f} MB ({small_n} patches) vs "
          f"{large_loop / 1e6:.1f} MB ({large_n} patches); whole build {small / 1e6:.1f} vs {large / 1e6:.1f} MB; "
          f"all {large_n} patches at once would be {large_n * patch_bytes / 1e6:.1f} MB")
    # Nine times the patches, the same streaming peak: one batch is held, never the whole slide.
    assert large_loop < 1.25 * small_loop + 1e6
    assert large_loop < 0.25 * large_n * patch_bytes
    # The rest of the build works on the (bounded, 1024-px) tissue mask grid, not on patches.
    assert large < 1.25 * small + 2e6


def test_embeddings_are_memmapped_npy_and_stored_write_once_with_provenance(env, ids, monkeypatch):
    from dermpath.db import session_scope
    from dermpath.ml import feature_sets as fsm
    from dermpath.ml.artifacts import load_npz
    from dermpath.ml.models import FeatureArtifact
    from dermpath.storage import get_store

    opened = []
    real_open_memmap = np.lib.format.open_memmap

    def spy(*a, **kw):
        opened.append(kw.get("shape"))
        return real_open_memmap(*a, **kw)

    monkeypatch.setattr(np.lib.format, "open_memmap", spy)
    sid = cmu_slide_id(ids)
    fs_id = create_set(CMU_PROJECT, encoder_id=HANDCRAFTED, execution_mode="real_image_technical", slide_ids=[sid],
                       params={"max_patches_per_slide": 20})
    _build(fs_id)
    assert opened and opened[0] == (20, 64)  # rows streamed into a memmap sized for the sampled patches
    item = items_of(fs_id)[sid]
    with session_scope() as db:
        art = db.get(FeatureArtifact, item.artifact_id)
    store = get_store()
    assert art.embeddings_key.endswith(f"/{art.embeddings_sha256}.npy")
    assert art.quality_key.endswith(f"/{art.quality_sha256}.npz") and art.object_key == art.quality_key
    assert store.sha256(art.embeddings_key) == art.embeddings_sha256
    emb = np.load(store.local_path(art.embeddings_key), mmap_mode="r")
    assert emb.dtype == np.float32 and emb.shape == (art.n_patches, 64) and isinstance(emb, np.memmap)
    arrays, meta = load_npz(store.get_bytes(art.quality_key))
    assert arrays["coords"].shape == (art.n_patches, 2) and arrays["q_mean_rgb"].shape == (art.n_patches, 3)
    assert meta["cache_key"] == art.cache_key and meta["research_use_only"] is True
    fs = get_set(fs_id)
    for col, want in (("encoder_spec_sha256", fs.encoder_spec_sha256), ("policy_sha256", fs.policy_sha256),
                      ("stain_policy_sha256", fs.stain_policy_sha256),
                      ("extraction_env_sha256", fs.extraction_env_sha256), ("weights_sha256", fs.weights_sha256),
                      ("device", "cpu"), ("precision", "fp32")):
        assert getattr(art, col) == want, col
    snap = fs.input_snapshot_json["slides"][0]
    assert art.mask_sha256 == snap["mask_sha256"] and art.excluded_regions_sha256 == snap["excluded_regions_sha256"]
    assert art.coverage_json["n_sampled"] == art.n_patches and art.generation == 0
    assert set(art.key_extra_json) >= {"slide_sha256", "encoder_spec_sha256", "weights_sha256", "policy_sha256",
                                       "stain_policy_sha256", "mask_sha256", "excluded_regions_sha256",
                                       "coords_sha256", "extraction_env_sha256", "extraction"}
    st = item.stats_json
    for k in ("read_seconds", "preprocess_seconds", "embed_seconds", "patches_per_second", "peak_rss_bytes",
              "peak_rss_delta_bytes", "rejected_at_read", "cache_hit"):
        assert k in st, k
    assert st["cache_hit"] is False and set(st["rejected_at_read"]) == {"pen_marks", "background_at_read", "blur"}
    # Writing the same content again is a no-op (write-once); a second identical set hits the cache.
    assert store.put_content_addressed(art.embeddings_key.rsplit("/", 1)[0],
                                       store.get_bytes(art.embeddings_key), ".npy")[0] == art.embeddings_key
    other = create_set(CMU_PROJECT, encoder_id=HANDCRAFTED, execution_mode="real_image_technical", slide_ids=[sid],
                       params={"max_patches_per_slide": 20}, name="same spec")
    assert other == fs_id
    via_extract = fsm.extract_slide(sid, **fsm.extraction_kwargs(fs_id))
    assert via_extract.cache_hit and via_extract.artifact_id == art.id


def test_slide_file_change_is_refused_and_the_slide_hash_is_memoised(env, ids, monkeypatch):
    from dermpath.db import session_scope
    from dermpath.ml import feature_sets as fsm
    from dermpath.models import Slide
    from dermpath.storage import get_store

    rc = real_cohort(ids, n=2, project_id="proj-real-sha")
    sid = rc["slide_ids"][0]
    with session_scope() as db:
        key = db.get(Slide, sid).object_key
    fsm.clear_sha_memo()
    reads = []
    import builtins

    def counting_open(path, mode="r", *a, **kw):
        if "b" in mode and str(path).endswith("original.svs"):
            reads.append(str(path))
        return builtins.open(path, mode, *a, **kw)

    monkeypatch.setattr(fsm, "open", counting_open, raising=False)
    first = fsm.object_sha256(key)
    assert fsm.object_sha256(key) == first and len(reads) == 1  # streamed once per process per slide
    fs_id = create_set(rc["project_id"], encoder_id=HANDCRAFTED, execution_mode="real_image_technical",
                       slide_ids=[sid], params={"max_patches_per_slide": 4})
    get_store().put_bytes(key, get_store().get_bytes(key) + b"replaced after the snapshot")
    with pytest.raises(fsm.FeatureError, match="input_changed"):
        _build(fs_id)
    assert get_set(fs_id).status == "failed" and items_of(fs_id)[sid].status == "pending"


def test_corrupt_artifacts_are_never_served_and_repair_writes_a_new_generation(env, ids):
    from dermpath.db import session_scope
    from dermpath.ml import feature_sets as fsm
    from dermpath.ml.models import FeatureArtifact
    from dermpath.storage import get_store

    sid = cmu_slide_id(ids)
    fs_id = create_set(CMU_PROJECT, encoder_id=HANDCRAFTED, execution_mode="real_image_technical", slide_ids=[sid],
                       params={"max_patches_per_slide": 8})
    _build(fs_id)
    original = fsm.load_slide_features(fs_id, sid)
    values = np.array(original.embeddings)
    with session_scope() as db:
        art = db.get(FeatureArtifact, items_of(fs_id)[sid].artifact_id)
    path = get_store().local_path(art.embeddings_key)
    with open(path, "r+b") as fh:  # flip one byte of the stored embeddings
        fh.seek(-1, 2)
        b = fh.read(1)
        fh.seek(-1, 2)
        fh.write(bytes([b[0] ^ 0xFF]))
    with pytest.raises(fsm.FeatureSetIntegrityError, match="missing or corrupt"):
        fsm.load_slide_features(fs_id, sid)
    assert fsm._cache_lookup(art.project_id, art.cache_key) == (None, 1)
    summary = _build(fs_id)  # a ready set: verification pass and repair
    assert summary["status"] == "ready" and summary["repaired"][0]["pinned_artifact_id"] == art.id
    repaired = fsm.load_slide_features(fs_id, sid)
    assert repaired.artifact_id != art.id and repaired.meta["repaired_from_artifact_id"] == art.id
    assert np.array_equal(np.asarray(repaired.embeddings), values)
    with session_scope() as db:
        new = db.get(FeatureArtifact, repaired.artifact_id)
    assert new.generation == 1 and "/gen1/" in new.embeddings_key and new.cache_key == art.cache_key
    assert items_of(fs_id)[sid].artifact_id == art.id  # the ready set's item is never rewritten


def test_legacy_cache_never_serves_a_corrupt_object(env, ids):
    from dermpath.db import session_scope
    from dermpath.ml.config import resolve_params
    from dermpath.ml.features import extract_slide_features
    from dermpath.ml.models import FeatureArtifact
    from dermpath.storage import get_store

    sid = ids["slides"]["p1_a1_l1"]
    params = resolve_params({"max_patches_per_slide": 6})
    first = extract_slide_features(sid, encoder_id="synthetic-deterministic-v1", params=params, seed=3,
                                   fixture_label=None)
    with session_scope() as db:
        a0 = db.get(FeatureArtifact, first.artifact_id)
    assert a0.object_key.endswith(f"/{a0.sha256}.npz") and a0.generation == 0
    assert extract_slide_features(sid, encoder_id="synthetic-deterministic-v1", params=params, seed=3,
                                  fixture_label=None).cache_hit
    get_store().put_bytes(a0.object_key, b"corrupt")
    again = extract_slide_features(sid, encoder_id="synthetic-deterministic-v1", params=params, seed=3,
                                   fixture_label=None)
    assert again.cache_hit is False and again.artifact_id != a0.id
    with session_scope() as db:
        a1 = db.get(FeatureArtifact, again.artifact_id)
        n = len(db.scalars(select(FeatureArtifact).where(FeatureArtifact.cache_key == a0.cache_key)).all())
    assert a1.generation == 1 and "/gen1/" in a1.object_key and n == 2


class _FakeCtx:
    """A job context whose progress raises JobCanceled after ``cancel_after`` reports."""

    def __init__(self, cancel_after: int):
        self.cancel_after, self.calls, self.job_id, self.created_by = cancel_after, 0, None, "test"

    def progress(self, fraction=None, message=None):
        from dermpath.jobs.registry import JobCanceled

        self.calls += 1
        if self.calls > self.cancel_after:
            raise JobCanceled("cancel requested")

    def assert_lease(self, db=None):
        return None


def test_build_stops_between_batches_on_cancel_and_resumes(env, ids, monkeypatch):
    from dermpath.db import session_scope
    from dermpath.jobs.registry import JobCanceled
    from dermpath.ml import feature_sets as fsm
    from dermpath.models import Job

    monkeypatch.setattr(fsm, "PROGRESS_INTERVAL_SECONDS", 0.0)
    monkeypatch.setenv("WB_ML_BATCH_SIZE", "4")
    rc = real_cohort(ids, n=3, project_id="proj-real-cancel")
    fs_id = create_set(rc["project_id"], encoder_id=HANDCRAFTED, execution_mode="real_image_technical",
                       slide_ids=rc["slide_ids"], params={"max_patches_per_slide": 12})
    ctx = _FakeCtx(cancel_after=6)
    with pytest.raises(JobCanceled):
        _build(fs_id, ctx)
    items = items_of(fs_id)
    done = [s for s, it in items.items() if it.status == "done"]
    assert len(done) == 1 and get_set(fs_id).status == "building"  # stopped inside the second slide
    with session_scope() as db:  # what the queue does when it settles a canceled job
        fsm.settle_feature_set(db, Job(type=fsm.BUILD_JOB, payload_json={"feature_set_id": fs_id}), "canceled",
                               "cancel requested")
    assert get_set(fs_id).status == "failed" and get_set(fs_id).error.startswith("canceled")
    summary = _build(fs_id)
    assert summary["status"] == "ready" and summary["skipped_done"] == 1 and summary["built_now"] == 2


# --------------------------------------------------------------------------- weights identity (tiny timm ViT)


def test_a_set_pinned_to_weights_a_refuses_weights_b(env, ids, monkeypatch, tmp_path):
    torch = pytest.importorskip("torch")
    timm = pytest.importorskip("timm")
    import copy
    import dataclasses

    from dermpath.ml import encoders
    from dermpath.ml import feature_sets as fsm
    from dermpath.ml.models import FeatureArtifact

    arch = copy.deepcopy(encoders.UNI_SPEC.architecture)
    arch["kwargs"].update({"embed_dim": 32, "depth": 2, "num_heads": 2})
    spec = dataclasses.replace(encoders.UNI_SPEC, architecture=arch, embedding_dim=32)

    def write(seed: int):
        torch.manual_seed(seed)
        model = timm.create_model(arch["model"], pretrained=False, **arch["kwargs"])
        torch.save(model.eval().state_dict(), tmp_path / "pytorch_model.bin")
        return hashlib.sha256((tmp_path / "pytorch_model.bin").read_bytes()).hexdigest()

    for name in ("HF_HUB_OFFLINE", "TRANSFORMERS_OFFLINE", "HF_HUB_DISABLE_TELEMETRY"):
        monkeypatch.setenv(name, "1")
    sha_a = write(0)
    monkeypatch.setenv("WB_UNI_WEIGHTS", str(tmp_path / "pytorch_model.bin"))
    monkeypatch.setenv("WB_UNI_LICENSE_ACCEPTED", "1")
    monkeypatch.setitem(encoders.REGISTRY, encoders.UNI_ID, encoders.UNIEncoder(spec))
    encoders.clear_loaded_encoders()
    sid = cmu_slide_id(ids)
    try:
        fs_id = create_set(CMU_PROJECT, encoder_id=encoders.UNI_ID, execution_mode="real_image_technical",
                           slide_ids=[sid], params={"max_patches_per_slide": 4, "device": "cpu"})
        assert get_set(fs_id).weights_sha256 == sha_a
        sha_b = write(1)
        assert sha_b != sha_a
        with pytest.raises(encoders.EncoderIdentityMismatch):
            _build(fs_id)
        assert get_set(fs_id).status == "failed" and items_of(fs_id)[sid].status == "pending"
        from dermpath.db import session_scope

        with session_scope() as db:
            assert not db.scalars(select(FeatureArtifact).where(FeatureArtifact.weights_sha256 == sha_b)).all()
        # The pinned weights come back (same bytes): the set builds, bound to sha A.
        assert write(0) == sha_a
        assert _build(fs_id)["status"] == "ready"
        feats = fsm.load_slide_features(fs_id, sid)
        assert feats.weights_sha256 == sha_a and feats.embeddings.shape == (4, 32)
    finally:
        encoders.clear_loaded_encoders()
