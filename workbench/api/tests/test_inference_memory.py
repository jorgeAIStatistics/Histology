"""Bounded-memory inference (owner brief item 5).

Inference used to pool a slide with ``emb.astype(np.float64).mean(axis=0)``: a full float64 copy of the embedding
matrix (for 100,000 x 1,536 that is 1.23 GB on top of the 0.61 GB float32 memory-mapped artifact), computed even
when no diversity embedding was requested. It now reduces in fixed-size chunks with the head's own streaming mean
(:func:`dermpath.ml.heads.streaming_mean`, ``MEAN_CHUNK_ROWS`` rows of float64 at a time), computes the pooled
embedding only when asked (active learning's diversity), and hashes the scored rows chunk by chunk.

Measurement method (documented here and printed by the slow test):

* ``tracemalloc`` peak: every numpy buffer allocated while the code under test runs (numpy reports its
  allocations to tracemalloc). This is the deterministic measure of copies and the one the assertions use.
* Incremental anonymous memory: the process's physical footprint (macOS ``proc_pid_rusage`` ``ri_phys_footprint``;
  Linux ``RssAnon``) sampled every 2 ms by a thread, minus its value before the call. It excludes clean
  file-backed pages.
* Total resident memory (macOS ``ri_resident_size``; Linux ``VmRSS``) sampled the same way, and
  ``resource.getrusage(RUSAGE_SELF).ru_maxrss`` before/after. These INCLUDE the pages of the memory-mapped
  artifact that the reduction touched. Those pages are clean and backed by the file, and the OS can drop them, so
  total RSS grows with the artifact size even for a streaming reduction. That growth is page cache, not a copy.

A synthetic memory-mapped fixture proves resource behaviour, not diagnostic quality. Research use only.
"""

from __future__ import annotations

import ctypes
import gc
import json
import os
import resource
import sys
import threading
import time
import tracemalloc

import numpy as np
import pytest

from inference_support import fake_slide, register, slide_run
from ml_engine_fakes import FakeSlideFeatures, install_fakes

CHUNK_ROWS = 4096  # the fixed chunk size of the streaming reduction (heads.MEAN_CHUNK_ROWS)


# =========================================================================== fixtures and probes


def make_memmap(path, n: int, d: int, *, seed: int = 0, offset: float = 0.0) -> np.ndarray:
    """A float32 ``.npy`` written in chunks (never fully in RAM), reopened read-only memory-mapped."""
    mm = np.lib.format.open_memmap(str(path), mode="w+", dtype=np.float32, shape=(n, d))
    rng = np.random.default_rng(seed)
    for s in range(0, n, CHUNK_ROWS):
        e = min(n, s + CHUNK_ROWS)
        mm[s:e] = rng.standard_normal((e - s, d), dtype=np.float32) + np.float32(offset)
    mm.flush()
    del mm
    return np.load(str(path), mmap_mode="r")


class _RusageInfoV2(ctypes.Structure):
    _fields_ = [("ri_uuid", ctypes.c_uint8 * 16)] + [(name, ctypes.c_uint64) for name in (
        "ri_user_time", "ri_system_time", "ri_pkg_idle_wkups", "ri_interrupt_wkups", "ri_pageins", "ri_wired_size",
        "ri_resident_size", "ri_phys_footprint", "ri_proc_start_abstime", "ri_proc_exit_abstime",
        "ri_child_user_time", "ri_child_system_time", "ri_child_pkg_idle_wkups", "ri_child_interrupt_wkups",
        "ri_child_pageins", "ri_child_elapsed_abstime", "ri_diskio_bytesread", "ri_diskio_byteswritten")]


def _probe_darwin():
    lib = ctypes.CDLL("/usr/lib/libproc.dylib")

    def probe():
        ri = _RusageInfoV2()
        if lib.proc_pid_rusage(os.getpid(), 2, ctypes.byref(ri)) != 0:  # RUSAGE_INFO_V2
            return None, None
        return int(ri.ri_phys_footprint), int(ri.ri_resident_size)

    return probe


def _probe_linux():
    def probe():
        vals = {}
        with open("/proc/self/status") as fh:
            for line in fh:
                k, _, v = line.partition(":")
                if k in ("RssAnon", "VmRSS"):
                    vals[k] = int(v.split()[0]) * 1024
        return vals.get("RssAnon"), vals.get("VmRSS")

    return probe


def memory_probe():
    """``() -> (anonymous/footprint bytes, total resident bytes)``; ``(None, None)`` where unsupported."""
    try:
        if sys.platform == "darwin":
            return _probe_darwin()
        if sys.platform.startswith("linux"):
            return _probe_linux()
    except OSError:
        pass
    return lambda: (None, None)


def _maxrss_bytes() -> int:
    r = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return int(r if sys.platform == "darwin" else r * 1024)


def measure(fn, *, interval: float = 0.002):
    """Run ``fn()``; return ``(result, record)`` with the tracemalloc peak, the sampled incremental anonymous and
    total resident memory, ``ru_maxrss`` before/after and the wall time."""
    probe = memory_probe()
    gc.collect()
    anon0, rss0 = probe()
    peaks = {"anon": anon0, "rss": rss0}
    stop = threading.Event()

    def sample():
        while not stop.is_set():
            a, r = probe()
            if a is not None:
                peaks["anon"] = max(peaks["anon"], a)
            if r is not None:
                peaks["rss"] = max(peaks["rss"], r)
            time.sleep(interval)

    sampler = threading.Thread(target=sample, daemon=True)
    maxrss0 = _maxrss_bytes()
    tracemalloc.start()
    tracemalloc.reset_peak()
    sampler.start()
    t0 = time.perf_counter()
    try:
        result = fn()
    finally:
        seconds = time.perf_counter() - t0
        stop.set()
        sampler.join()
        _, traced_peak = tracemalloc.get_traced_memory()
        tracemalloc.stop()
    a1, r1 = probe()
    return result, {
        "tracemalloc_peak_bytes": int(traced_peak),
        "incremental_anonymous_peak_bytes": None if anon0 is None else int(max(peaks["anon"], a1 or 0) - anon0),
        "incremental_total_rss_peak_bytes": None if rss0 is None else int(max(peaks["rss"], r1 or 0) - rss0),
        "ru_maxrss_before_bytes": maxrss0, "ru_maxrss_after_bytes": _maxrss_bytes(), "seconds": round(seconds, 3)}


def memmap_extraction(monkeypatch, embeddings_of: dict):
    """Contract fakes whose extraction serves the given (memory-mapped) embeddings per slide."""
    calls = install_fakes(monkeypatch)
    from dermpath.ml import feature_sets as fsm
    from dermpath.ml.artifacts import extraction_env

    def extract_slide(slide_id, *, encoder_id, weights_sha256, encoder_spec_sha256, patch_policy, sampling_policy,
                      stain_policy, device, precision, input_snapshot, ctx=None, **extra):
        emb = embeddings_of[slide_id]
        calls.extract.append({"slide_id": slide_id, "input_snapshot": input_snapshot})
        return FakeSlideFeatures(slide_id=slide_id, embeddings=emb, coords=np.zeros((emb.shape[0], 2), np.int64),
                                 artifact_id=None, weights_sha256=weights_sha256,
                                 encoder_spec_sha256=encoder_spec_sha256, policy_sha256=patch_policy.policy_sha256,
                                 n_patches=int(emb.shape[0]), stain_policy_sha256=stain_policy.policy_sha256,
                                 extraction_env_sha256=extraction_env(device, precision)[1],
                                 meta={"fields": {"extractor_version": fsm.EXTRACTOR_VERSION}})

    monkeypatch.setattr(fsm, "extract_slide", extract_slide)
    return calls


# =========================================================================== fast checks


def test_streaming_mean_matches_the_float64_reference_over_many_chunks(tmp_path, monkeypatch):
    """Parity: the chunked reduction equals the head's own pooled vector bit for bit, and the whole-matrix float64
    mean within float64 rounding (20 chunks of 1,000 rows, values offset to 1e3 so float32 accumulation would
    visibly drift)."""
    from dermpath.ml import heads, inference

    monkeypatch.setattr(heads, "MEAN_CHUNK_ROWS", 1000)
    emb = make_memmap(tmp_path / "small.npy", 20_000, 48, seed=3, offset=1000.0)
    got = inference.embedding_mean(emb)
    assert got.dtype == np.float64 and got.shape == (48,)
    assert np.array_equal(got, heads.streaming_mean([emb]))  # what meanpool_logreg scores
    ref = np.asarray(emb, dtype=np.float64).mean(axis=0)
    assert np.max(np.abs(got - ref)) <= 1e-9
    drift32 = np.max(np.abs(np.asarray(emb).mean(axis=0, dtype=np.float32) - ref))
    assert np.max(np.abs(got - ref)) < drift32 or drift32 == 0.0
    with pytest.raises(ValueError):
        inference.embedding_mean(np.zeros((0, 48), dtype=np.float32))


def test_infer_and_acquisition_scoring_make_no_whole_matrix_copy(clients, ids, monkeypatch, tmp_path):
    """Through the worker functions (``infer_slide`` and the active-learning ``score_slide``) on a 60,000 x 256
    memory-mapped bag: the traced peak stays far below one float64 copy of the matrix (123 MB)."""
    from dermpath.ml import inference

    n, d = 60_000, 256
    a, b = fake_slide(tag="mem-a"), fake_slide(tag="mem-b")
    emb_a = make_memmap(tmp_path / "a.npy", n, d, seed=1)
    emb_b = make_memmap(tmp_path / "b.npy", n, d, seed=2)
    memmap_extraction(monkeypatch, {a: emb_a, b: emb_b})
    bid = register(clients, slide_run(ids, dim=d))
    float64_copy = n * d * 8
    out, rec = measure(lambda: inference.infer_slide(bid, a))
    assert out["score"] is not None
    assert rec["tracemalloc_peak_bytes"] < float64_copy / 4, rec
    (pred, mean), rec2 = measure(lambda: inference.score_slide(bid, b, need_embedding=True))
    assert pred["score"] is not None and mean is not None
    assert rec2["tracemalloc_peak_bytes"] < float64_copy / 4, rec2
    assert np.max(np.abs(mean - np.asarray(emb_b, dtype=np.float64).mean(axis=0))) <= 1e-9


def test_no_diversity_embedding_is_computed_unless_requested(clients, ids, monkeypatch):
    from dermpath.ml import inference

    s1, s2 = fake_slide(tag="div-1"), fake_slide(tag="div-2")
    rng = np.random.default_rng(0)
    memmap_extraction(monkeypatch, {s: rng.normal(size=(50, 16)).astype(np.float32) for s in (s1, s2)})
    bid = register(clients, slide_run(ids))
    real = inference.embedding_mean
    count = {"n": 0}

    def counting(emb):
        count["n"] += 1
        return real(emb)

    monkeypatch.setattr(inference, "embedding_mean", counting)
    inference.infer_slide(bid, s1)  # research inference: no embedding is wanted
    assert count["n"] == 0
    _, mean = inference.score_slide(bid, s2, need_embedding=True)  # active learning's diversity
    assert count["n"] == 1 and mean is not None
    _, mean = inference.score_slide(bid, s2, need_embedding=False)  # reuse, no embedding
    assert count["n"] == 1 and mean is None


def test_active_learning_asks_for_diversity_embeddings_only_when_its_plan_has_diversity_picks(clients, ids,
                                                                                               monkeypatch):
    """Integration through the active-learning job (brief item 5: no diversity embedding unless requested): an
    uncertainty-only batch (no diversity picks planned) scores every candidate with ``need_embedding=False``, so no
    pooled embedding is computed; a batch whose plan has diversity picks asks for them."""
    from dermpath.ml import active_learning, inference
    from ml_engine_fakes import CID, LEAD, run_jobs

    pool_ids = sorted(fake_slide(tag=f"aldiv{i}") for i in range(4))
    rng = np.random.default_rng(5)
    memmap_extraction(monkeypatch, {s: rng.normal(size=(40, 16)).astype(np.float32) for s in pool_ids})
    fake_pool = [{"slide_id": s, "coded_patient_id": f"pt-div-{i}", "patient_code": None, "case_id": None,
                  "pool_reason": "no_reference_label", "family_split": "new_to_family",
                  "patient_in_training_set": False} for i, s in enumerate(pool_ids)]
    monkeypatch.setattr(active_learning, "development_pool", lambda db, run, dv: (list(fake_pool), {}))
    asked: list[bool] = []
    real = inference.score_slide

    def spy(bundle_id, slide_id, ctx=None, **kw):
        asked.append(bool(kw.get("need_embedding", True)))
        return real(bundle_id, slide_id, ctx, **kw)

    monkeypatch.setattr(inference, "score_slide", spy)
    rid = slide_run(ids)
    register(clients, rid)
    lead = clients(LEAD)
    r = lead.post(f"/api/v1/projects/{CID}/active-learning",
                  json={"run_id": rid, "k": 2, "random_fraction": 0.0, "uncertainty_fraction": 1.0})
    assert r.status_code == 202, r.text
    out = run_jobs(["active_learning"])
    assert [o.status for o in out] == ["succeeded"], [o.error for o in out]
    assert asked == [False] * 4, asked
    asked.clear()
    r = lead.post(f"/api/v1/projects/{CID}/active-learning",
                  json={"run_id": rid, "k": 2, "random_fraction": 0.0, "uncertainty_fraction": 0.5})
    assert r.status_code == 202, r.text
    out = run_jobs(["active_learning"])
    assert [o.status for o in out] == ["succeeded"], [o.error for o in out]
    assert asked and all(asked), asked


def test_abmil_scoring_normalises_with_a_single_bag_sized_temporary(monkeypatch):
    """Downstream of extraction (brief item 5): ABMIL scoring needs the whole bag (attention spans every patch) but
    its input normalisation must not hold two bag-sized float32 temporaries at once (``(x - mean) / std``). Scores
    are unchanged (compared with the two-temporary expression)."""
    from dermpath.ml import heads

    n, d = 40_000, 128
    rng = np.random.default_rng(11)
    emb = rng.normal(size=(n, d)).astype(np.float32)
    meta = {"head": "abmil", "in_dim": d, "hidden_dim": 16, "attn_dim": 8, "dropout": 0.0}
    arrays = {"input_mean": rng.normal(size=d).astype(np.float32),
              "input_std": (1.0 + rng.random(d)).astype(np.float32)}
    import torch

    torch.manual_seed(0)
    net = heads.build_abmil(d, meta["hidden_dim"], meta["attn_dim"], meta["dropout"])
    for name, t in net.state_dict().items():
        arrays[f"state.{name}"] = t.detach().cpu().numpy()
    model = heads.LoadedModel(arrays, meta)
    model.score_parts([emb[:10]])  # warm-up: lazily built network and imports are not counted
    bag_bytes = n * d * 4
    tracemalloc.start()
    try:
        got = model.score_parts([emb])
        _, peak = tracemalloc.get_traced_memory()
    finally:
        tracemalloc.stop()
    assert peak < 1.6 * bag_bytes, {"tracemalloc_peak_bytes": peak, "bag_bytes": bag_bytes}
    ref_x = (emb - arrays["input_mean"]) / arrays["input_std"]  # the previous expression
    with heads.torch_single_thread() as th, th.no_grad():
        ref_logit, ref_att = model._torch_model(th.from_numpy(np.ascontiguousarray(ref_x, dtype=np.float32)))
        ref = (float(th.sigmoid(ref_logit).item()), ref_att.numpy().astype(np.float64))
    assert got[0] == ref[0] and np.array_equal(got[1], ref[1])


# =========================================================================== large fixture (slow)


@pytest.mark.slow
def test_large_memmap_inference_peak_memory_and_parity(clients, ids, monkeypatch, tmp_path):
    """100,000 x 1,536 float32 (614 MB memory-mapped): the chunked reduction (fixed ``MEAN_CHUNK_ROWS`` = 4,096),
    the full ``score_slide`` path that active learning uses (extraction faked to serve the memmap; real meanpool
    checkpoint, real streaming scorer) and, last, the replaced whole-matrix float64 pooling. Each measurement maps
    the file afresh, so total RSS shows the file-backed pages each one touches. Prints one JSON record (see the
    module docstring for the method)."""
    from dermpath.ml import heads, inference

    monkeypatch.setattr(heads, "MEAN_CHUNK_ROWS", CHUNK_ROWS)
    n, d = 100_000, 1536
    path_npy = tmp_path / "large.npy"
    sid = fake_slide(tag="large")
    t0 = time.perf_counter()
    make_memmap(path_npy, n, d, seed=7)  # written in chunks; each measurement below maps it afresh
    build_seconds = time.perf_counter() - t0
    float64_copy = n * d * 8

    def fresh():
        return np.load(str(path_npy), mmap_mode="r")

    emb_new = fresh()
    new_mean, new = measure(lambda: inference.embedding_mean(emb_new))
    del emb_new
    emb_path = fresh()
    memmap_extraction(monkeypatch, {sid: emb_path})
    bid = register(clients, slide_run(ids, dim=d))
    (pred, path_mean), path = measure(lambda: inference.score_slide(bid, sid, need_embedding=True))
    emb_old = fresh()
    gc.collect()
    ref, old = measure(lambda: emb_old.astype(np.float64).mean(axis=0))  # the replaced expression, measured last
    del emb_old
    record = {
        "fixture": {"rows": n, "dim": d, "dtype": "float32", "file_bytes": int(os.path.getsize(path_npy)),
                    "float64_copy_bytes": float64_copy, "chunk_rows": CHUNK_ROWS,
                    "build_seconds": round(build_seconds, 2)},
        "chunked_streaming_mean": new, "score_slide_with_embedding": path, "old_whole_matrix_float64_mean": old,
        "parity_max_abs_diff_vs_float64_reference": float(np.max(np.abs(new_mean - ref))),
        "score_slide_mean_max_abs_diff": float(np.max(np.abs(path_mean - ref))),
        "platform": sys.platform, "numpy": np.__version__,
        "method": "tracemalloc peak (assertions); sampled phys_footprint/RssAnon delta (incremental anonymous); "
                  "sampled resident size delta (total, includes the clean file-backed memmap pages touched); "
                  "ru_maxrss is the process-lifetime peak (pytest process), reported, not asserted"}
    print("\nINFERENCE_MEMORY_RECORD " + json.dumps(record, sort_keys=True))
    assert old["tracemalloc_peak_bytes"] >= float64_copy  # the method sees a whole-matrix copy
    assert new["tracemalloc_peak_bytes"] <= 128 * 2**20 and new["tracemalloc_peak_bytes"] <= float64_copy / 8
    assert path["tracemalloc_peak_bytes"] <= 192 * 2**20 and path["tracemalloc_peak_bytes"] <= float64_copy / 6
    assert record["parity_max_abs_diff_vs_float64_reference"] <= 1e-9
    assert record["score_slide_mean_max_abs_diff"] <= 1e-9 and pred["score"] is not None
    if new["incremental_anonymous_peak_bytes"] is not None:  # where the platform reports it
        assert new["incremental_anonymous_peak_bytes"] < float64_copy / 4
