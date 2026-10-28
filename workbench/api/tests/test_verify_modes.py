"""Adversarial verification of execution modes and honesty (design §1, §3, §7, §8, §9).

Every test asserts a guarantee. A failing test is the reproduction of a broken guarantee; a passing
test stays as regression coverage. Attacks go through public APIs and job handlers wherever possible:

* forbidden encoder / data / mode combinations (synthetic encoder on public_cc0, public_licensed and
  real_authorized slides in every mode; real encoders on demo_synthetic data; mixed slide lists), at
  creation through the API and again in the worker;
* label keys in every engine job payload;
* label carriers reaching real encoder adapters; FixtureContext forgery (replace, direct construction,
  object.__new__, copy/pickle and mutation, subclassing) and the deprecated legacy label carrier;
* imported reference labels under the default expert standard, and every API body / report over
  COBRA-like imported-reference data stating the reference standard;
* "BCC absent" never rendered as "benign" in any API body;
* PIPELINE TEST banner on every results-bearing body of a synthetic run; research_use_only bundles;
  inference never writes a label;
* no network or hub download while loading and running real adapters (tiny local weights).

All records are fictional; nothing here measures diagnostic performance.
"""

from __future__ import annotations

import copy
import dataclasses
import hashlib
import json
import pickle
import re
import socket
import urllib.request

import numpy as np
import pytest
from sqlalchemy import func, select

from feature_set_support import CMU_PROJECT, LABELS, actors, cmu_slide_id, create_set, get_set, real_cohort

LEAD = "user-research-lead"
SYNTH = "synthetic-deterministic-v1"
HANDCRAFTED = "handcrafted-stain-texture-v1"
BANNER = "PIPELINE TEST — NOT PATHOLOGY VALIDATION"
MODES = ("synthetic_pipeline_test", "real_image_technical", "supervised_experiment")
REAL_PROVENANCES = ("public_cc0", "public_licensed", "real_authorized")
LABEL_KEYS = ("label", "labels", "fixture_label", "label_value")
COHORT = "proj-synthetic-cohort"


# --------------------------------------------------------------------------- helpers


def _real_copy(ids, provenance: str, n: int) -> str:
    """A whole-slide record of ``provenance`` (byte variant of the CC0 CMU fixture) in the CMU project."""
    from dermpath.db import session_scope, utcnow
    from dermpath.models import Slide
    from dermpath.storage import get_store, slide_key

    store = get_store()
    with session_scope() as db:
        cmu = db.get(Slide, cmu_slide_id(ids))
        if provenance == cmu.provenance and n == 0:
            return cmu.id
        data = store.get_bytes(cmu.object_key) + b"\x00" * (n + 1) + b"verify-modes-variant"
        sid = f"vmslide{n:03d}"
        key = slide_key(cmu.project_id, sid, "original.svs")
        store.put_bytes(key, data)
        db.add(Slide(id=sid, project_id=cmu.project_id, provenance=provenance, image_kind="wsi", object_key=key,
                     sha256=hashlib.sha256(data).hexdigest(), bytes=len(data), format="svs", vendor=cmu.vendor,
                     width=cmu.width, height=cmu.height, levels=cmu.levels,
                     level_dimensions_json=cmu.level_dimensions_json,
                     level_downsamples_json=cmu.level_downsamples_json, mpp_x=cmu.mpp_x, mpp_y=cmu.mpp_y,
                     objective_power=cmu.objective_power, ingest_status="succeeded", ingested_at=utcnow(),
                     processing_version=cmu.processing_version, created_by="user-assistant"))
    return sid


def _counts() -> dict:
    from dermpath.db import session_scope
    from dermpath.ml.engine_models import FeatureSet, InferencePrediction
    from dermpath.ml.models import FeatureArtifact, Prediction, TrainingRun
    from dermpath.models import Disagreement, Job, LabelVersion

    with session_scope() as db:
        return {m.__name__: db.scalar(select(func.count()).select_from(m)) for m in (
            FeatureSet, FeatureArtifact, TrainingRun, Job, Prediction, LabelVersion, Disagreement,
            InferencePrediction)}


def _walk_strings(obj, path="$"):
    if isinstance(obj, dict):
        for k, v in obj.items():
            yield f"{path}.{k}#key", str(k)
            yield from _walk_strings(v, f"{path}.{k}")
    elif isinstance(obj, (list, tuple)):
        for i, v in enumerate(obj):
            yield from _walk_strings(v, f"{path}[{i}]")
    elif isinstance(obj, str):
        yield path, obj


_NEGATION = re.compile(r"(\bnot\b|\bnever\b|not_|n't\b|\bno\b)")


def benign_renderings(body) -> list[str]:
    """Every place a body says 'benign' without a negation in the preceding words."""
    bad = []
    for path, s in _walk_strings(body):
        for m in re.finditer(r"benign", s, flags=re.IGNORECASE):
            window = s[max(0, m.start() - 48):m.start()].lower()
            if not _NEGATION.search(window):
                bad.append(f"{path}: …{s[max(0, m.start() - 60):m.end() + 20]}…")
    return bad


def _says_imported_reference(body) -> bool:
    from dermpath.datasets import IMPORTED_REFERENCE_NOTICE

    def walk(o):
        if isinstance(o, dict):
            if o.get("reference_standard") == "imported_reference":
                return True
            return any(walk(v) for v in o.values())
        if isinstance(o, (list, tuple)):
            return any(walk(v) for v in o)
        return isinstance(o, str) and IMPORTED_REFERENCE_NOTICE in o
    return walk(body)


def _run_worker(types):
    from dermpath.jobs.worker import Worker

    return Worker("verify-modes-worker", types=list(types)).run_until_idle()


# =========================================================================== 1. forbidden combinations at creation


def test_synthetic_encoder_is_refused_on_every_real_provenance_in_every_mode(env, ids):
    """Design §1 invariant 2: the synthetic encoder never runs on public_cc0, public_licensed or real_authorized
    slides, whatever the execution mode; nothing is written."""
    from dermpath.ml.feature_sets import ModeMismatch

    slides = {p: _real_copy(ids, p, n) for n, p in enumerate(REAL_PROVENANCES)}
    before = _counts()
    accepted = []
    for prov, sid in slides.items():
        for mode in MODES:
            for params in ({"pixel_mode": "none"}, {}):
                try:
                    fs_id = create_set(CMU_PROJECT, encoder_id=SYNTH, execution_mode=mode, slide_ids=[sid],
                                       params=params)
                except ModeMismatch as exc:
                    assert exc.status == 409 and exc.code == "mode_mismatch"
                    assert "synthetic" in exc.message.lower()
                    continue
                accepted.append((prov, mode, params, fs_id))
    assert accepted == [], f"synthetic encoder accepted on real slides: {accepted}"
    assert _counts()["FeatureSet"] == before["FeatureSet"]


def test_feature_set_api_refuses_the_synthetic_encoder_on_real_slides(env, ids, clients):
    lead = clients(LEAD)
    slides = {p: _real_copy(ids, p, n) for n, p in enumerate(REAL_PROVENANCES)}
    before = _counts()
    for prov, sid in slides.items():
        for mode in MODES:
            r = lead.post(f"/api/v1/projects/{CMU_PROJECT}/feature-sets",
                          json={"slide_ids": [sid], "encoder_id": SYNTH, "execution_mode": mode,
                                "params": {"pixel_mode": "none"}})
            assert r.status_code == 409 and r.json()["error"]["code"] == "mode_mismatch", (prov, mode, r.text)
    after = _counts()
    assert (after["FeatureSet"], after["Job"]) == (before["FeatureSet"], before["Job"])


def test_legacy_extraction_refuses_a_fixture_label_on_real_slides(env, ids):
    """The deprecated features.extract_slide_features path routes a labelled synthetic extraction through
    fixture_context(): a real slide is refused before anything is computed or cached."""
    from dermpath.ml.config import resolve_params
    from dermpath.ml.features import extract_slide_features
    from dermpath.ml.fixture import SyntheticSignalForbidden

    params = resolve_params({"pixel_mode": "none", "max_patches_per_slide": 4})
    before = _counts()["FeatureArtifact"]
    for n, prov in enumerate(REAL_PROVENANCES):
        sid = _real_copy(ids, prov, n)
        for label in (0, 1):
            with pytest.raises(SyntheticSignalForbidden):
                extract_slide_features(sid, encoder_id=SYNTH, params=params, seed=0, fixture_label=label)
    assert _counts()["FeatureArtifact"] == before


def test_forbidden_experiment_combinations_are_refused_through_the_api(env, ids, clients):
    """Synthetic encoder on a real_authorized dataset and a real encoder on the demo_synthetic cohort are refused
    (409 mode_mismatch) for every execution mode, inferred or explicit; no run, job or feature set is created."""
    rc = real_cohort(ids, n=4, project_id="proj-verify-api")
    synth_dv = ids["ml_demo"]["cohort"]["dataset_version_id"]
    lead = clients(LEAD)
    before = _counts()
    accepted = []
    cases = [(rc["project_id"], rc["dataset_version_id"], SYNTH, {"max_patches_per_slide": 4})]
    cases += [(COHORT, synth_dv, HANDCRAFTED, {"max_patches_per_slide": 4})]
    for pid, dv_id, enc, params in cases:
        for mode in (None, *MODES):
            body = {"dataset_version_id": dv_id, "encoder_id": enc, "head": "meanpool_logreg", "seed": 0,
                    "params": params}
            if mode is not None:
                body["execution_mode"] = mode
            r = lead.post(f"/api/v1/projects/{pid}/experiments", json=body)
            if r.status_code != 409 or r.json()["error"]["code"] != "mode_mismatch":
                accepted.append((enc, pid, mode, r.status_code, r.text[:200]))
    # A real encoder on real data still cannot train in real_image_technical (no label is read in that mode).
    r = lead.post(f"/api/v1/projects/{rc['project_id']}/experiments",
                  json={"dataset_version_id": rc["dataset_version_id"], "encoder_id": HANDCRAFTED,
                        "head": "meanpool_logreg", "seed": 0, "execution_mode": "real_image_technical",
                        "params": {"max_patches_per_slide": 4}})
    if r.status_code != 409 or r.json()["error"]["code"] != "mode_mismatch":
        accepted.append((HANDCRAFTED, rc["project_id"], "real_image_technical", r.status_code, r.text[:200]))
    assert accepted == [], accepted
    after = _counts()
    for k in ("TrainingRun", "Job", "FeatureSet", "FeatureArtifact"):
        assert after[k] == before[k], (k, before[k], after[k])


def test_mixed_slide_lists_are_refused_for_every_encoder_and_mode(env, ids):
    from dermpath.ml.feature_sets import ModeMismatch

    mixed = [cmu_slide_id(ids), ids["slides"]["p1_a1_l1"]]
    accepted = []
    for enc in (SYNTH, HANDCRAFTED):
        for mode in MODES:
            try:
                create_set(CMU_PROJECT, encoder_id=enc, execution_mode=mode, slide_ids=mixed,
                           params={"pixel_mode": "none"} if enc == SYNTH else {"max_patches_per_slide": 2})
            except ModeMismatch as exc:
                assert exc.code == "mode_mismatch"
                continue
            accepted.append((enc, mode))
    assert accepted == [], f"mixed demo_synthetic + real slide list accepted: {accepted}"


def test_real_encoder_on_demo_synthetic_slides_is_refused_in_feature_sets(env, ids):
    from dermpath.ml.feature_sets import ModeMismatch

    demo = [ids["slides"]["p1_a1_l1"]]
    for mode in ("real_image_technical", "supervised_experiment", "synthetic_pipeline_test"):
        with pytest.raises(ModeMismatch):
            create_set(CMU_PROJECT, encoder_id=HANDCRAFTED, execution_mode=mode, slide_ids=demo,
                       params={"max_patches_per_slide": 2})


def test_legacy_extract_endpoint_refuses_the_synthetic_encoder_on_real_slides(env, ids, clients):
    """Design §1 invariant 2 has no exception for the legacy ``POST /slides/{id}/features`` route: the synthetic
    fixture encoder must not produce embeddings for a public_cc0 / public_licensed / real_authorized slide."""
    from dermpath.db import session_scope
    from dermpath.ml.models import FeatureArtifact

    lead = clients(LEAD)
    slides = {p: _real_copy(ids, p, n) for n, p in enumerate(REAL_PROVENANCES)}
    accepted = {}
    for prov, sid in slides.items():
        r = lead.post(f"/api/v1/slides/{sid}/features",
                      json={"encoder_id": SYNTH, "params": {"pixel_mode": "none", "max_patches_per_slide": 4}})
        if r.status_code != 409:
            accepted[prov] = r.status_code
    if accepted:
        outcomes = _run_worker(["extract_features"])
        with session_scope() as db:
            arts = db.scalars(select(FeatureArtifact).where(FeatureArtifact.slide_id.in_(list(slides.values())),
                                                            FeatureArtifact.synthetic.is_(True))).all()
            evidence = sorted((a.slide_id, a.encoder_id, a.n_patches) for a in arts)
        pytest.fail(f"synthetic encoder accepted on real slides by the legacy route: {accepted}; jobs "
                    f"{[(o.type, o.status) for o in outcomes]}; synthetic artifacts written for real slides: "
                    f"{evidence}")


# =========================================================================== 2. the worker checks again


def test_modes_cannot_be_flipped_after_creation_and_the_worker_rederives_them(env, ids, clients, monkeypatch):
    """Execution mode and encoder identity are immutable after creation (ORM and SQL), and the worker re-derives
    the mode rules from the installed adapter: a run or feature set whose encoder no longer fits its mode fails
    permanently before any feature is extracted or any prediction is written."""
    from sqlalchemy import text
    from sqlalchemy.exc import DatabaseError

    from dermpath.db import session_scope
    from dermpath.ml import encoders
    from dermpath.ml import feature_sets as fsm
    from dermpath.ml.engine_models import FeatureSet
    from dermpath.ml.models import TrainingRun
    from dermpath.models import ImmutableRecordError

    lead = clients(LEAD)
    c = ids["ml_demo"]["cohort"]
    r = lead.post(f"/api/v1/projects/{COHORT}/experiments",
                  json={"dataset_version_id": c["dataset_version_id"], "encoder_id": SYNTH,
                        "head": "meanpool_logreg", "seed": 3,
                        "params": {"pixel_mode": "none", "max_patches_per_slide": 8, "n_boot": 50}})
    assert r.status_code == 202, r.text
    run = r.json()["experiment"]
    fs_id = create_set(CMU_PROJECT, encoder_id=HANDCRAFTED, execution_mode="real_image_technical",
                       slide_ids=[cmu_slide_id(ids)], params={"max_patches_per_slide": 2})
    # Immutable through the ORM and through raw SQL.
    for model, row_id, column, value in ((TrainingRun, run["id"], "execution_mode", "supervised_experiment"),
                                         (TrainingRun, run["id"], "synthetic", False),
                                         (FeatureSet, fs_id, "execution_mode", "synthetic_pipeline_test"),
                                         (FeatureSet, fs_id, "encoder_id", SYNTH)):
        with session_scope() as db:
            setattr(db.get(model, row_id), column, value)
            with pytest.raises(ImmutableRecordError):
                db.flush()
            db.rollback()
        with session_scope() as db:
            with pytest.raises(DatabaseError):
                db.execute(text(f"UPDATE {model.__tablename__} SET {column}=:v WHERE id=:i"),
                           {"v": value, "i": row_id})
            db.rollback()
    before = _counts()
    # The worker's adapter no longer matches the mode: the synthetic encoder is now "real", the handcrafted one
    # now "synthetic". Both must be refused in the worker.
    monkeypatch.setitem(encoders.REGISTRY, SYNTH, encoders.SyntheticDeterministicEncoder(
        dataclasses.replace(encoders.SYNTHETIC_SPEC, synthetic=False)))
    monkeypatch.setitem(encoders.REGISTRY, HANDCRAFTED, encoders.HandcraftedStainTextureEncoder(
        dataclasses.replace(encoders.HANDCRAFTED_SPEC, synthetic=True)))
    outcomes = _run_worker(["train"])
    mine = [o for o in outcomes if o.job_id == run["job_id"]]
    assert [o.status for o in mine] == ["failed"], outcomes
    assert mine[0].error.startswith("mode_mismatch"), mine[0].error
    assert lead.get(f"/api/v1/experiments/{run['id']}").json()["status"] == "failed"
    with pytest.raises(fsm.ModeMismatch):
        fsm.build_feature_set(fs_id)
    assert get_set(fs_id).status == "failed"
    after = _counts()
    assert after["FeatureArtifact"] == before["FeatureArtifact"] and after["Prediction"] == before["Prediction"]


# =========================================================================== 3. labels in job payloads


def _ready_synthetic_set(ids) -> str:
    """A small ready pipeline-test set over a demo_synthetic slide of the workflow project."""
    fs_id = create_set(CMU_PROJECT, encoder_id=SYNTH, execution_mode="synthetic_pipeline_test",
                       slide_ids=[ids["slides"]["p1_a1_l1"]], params={"pixel_mode": "none",
                                                                      "max_patches_per_slide": 4})
    from dermpath.ml.feature_sets import build_feature_set

    build_feature_set(fs_id)
    assert get_set(fs_id).status == "ready"
    return fs_id


def _payload_for(job_type: str, ids) -> dict:
    """The smallest payload that would make ``job_type`` do real work (so a missing guard shows as success)."""
    if job_type == "train":
        return {"run_id": next(iter(ids["ml_demo"]["cohort"]["runs"].values()))}  # succeeded: idempotent replay
    if job_type in ("build_feature_set", "validate_feature_set"):
        fs_id = _ready_synthetic_set(ids)
        return ({"feature_set_id": fs_id} if job_type == "build_feature_set"
                else {"feature_set_id": fs_id, "seed": 0, "n_slides": 1, "max_patches": None})
    if job_type == "extract_features":
        return {"slide_id": ids["slides"]["p1_a1_l1"], "encoder_id": SYNTH,
                "params": {"pixel_mode": "none", "max_patches_per_slide": 4}, "seed": 0}
    if job_type == "infer_slide":
        return {"bundle_id": "no-such-bundle", "slide_id": cmu_slide_id(ids)}
    if job_type == "evaluate_test_release":
        return {"test_release_id": "no-such-release"}
    if job_type == "active_learning":
        return {"batch_id": "no-such-batch", "run_id": "no-such-run"}
    raise AssertionError(job_type)


@pytest.mark.parametrize("job_type", ["train", "build_feature_set", "validate_feature_set", "infer_slide",
                                      "evaluate_test_release", "extract_features", "active_learning"])
def test_every_engine_job_refuses_a_payload_that_carries_a_label(env, ids, job_type):
    """Design §1 invariant 4: no job payload carries a label or a fixture label. Every engine handler must refuse
    each label key permanently, before doing anything."""
    from dermpath.db import session_scope
    from dermpath.jobs import queue

    base = _payload_for(job_type, ids)
    job_ids = {}
    with session_scope() as db:
        for key in LABEL_KEYS:
            job, _ = queue.enqueue(db, job_type, {**base, key: {"x": 1} if key == "labels" else 1},
                                   idempotency_key=f"verify-label:{job_type}:{key}", project_id=None,
                                   created_by=LEAD)
            job_ids[job.id] = key
    outcomes = {o.job_id: o for o in _run_worker([job_type]) if o.job_id in job_ids}
    not_refused = {job_ids[j]: (o.status, (o.error or "")[:120]) for j, o in outcomes.items()
                   if not (o.status == "failed" and "label" in (o.error or "").lower())}
    assert not_refused == {}, f"{job_type} accepted label keys: {not_refused}"


# =========================================================================== 4. label carriers and forged contexts


def test_real_adapters_never_receive_a_label():
    import inspect

    from dermpath.ml import encoders, fixture
    from dermpath.ml.fixture import SyntheticSignalForbidden

    ctx = encoders.EmbedContext("ab" * 32, 0)
    assert "fixture_label" not in encoders.EmbedContext.__slots__ and not hasattr(ctx, "fixture_label")
    with pytest.raises(AttributeError):
        ctx.fixture_label = 1  # no slot for a label
    with pytest.raises(AttributeError):
        ctx.label = 1
    assert list(inspect.signature(encoders.LoadedEncoder.embed_batch).parameters) == ["self", "patches_uint8"]
    adapter = encoders.get_encoder(HANDCRAFTED)
    coords = np.zeros((1, 2), np.int64)
    from PIL import Image

    patch = [Image.new("RGB", (224, 224), (200, 120, 170))]
    for carrier in (encoders.EmbedContext("ab" * 32, 0, fixture_label=1),
                    encoders.EmbedContext("ab" * 32, 0, fixture_label=0),
                    fixture.fixture_context("demo_synthetic", "synthetic_tiles", "synthetic_pipeline_test", 1)):
        with pytest.raises(SyntheticSignalForbidden):
            adapter.embed(patch, coords, carrier)

    class Labelled(encoders.EmbedContext):
        __slots__ = ("label",)

    sneaky = Labelled("ab" * 32, 0)
    sneaky.label = 1
    with pytest.raises((TypeError, SyntheticSignalForbidden)):
        adapter.embed(patch, coords, sneaky)


def test_fixture_context_cannot_be_forged_for_real_slides_or_other_modes():
    from dermpath.ml import fixture
    from dermpath.ml.fixture import SyntheticSignalForbidden

    coords = np.array([[0, 0], [224, 0], [448, 224], [672, 448]], dtype=np.int64)
    sha = "cd" * 32
    for prov in REAL_PROVENANCES:
        for kind in ("wsi", "synthetic_tiles"):
            for mode in MODES:
                with pytest.raises(SyntheticSignalForbidden):
                    fixture.fixture_context(prov, kind, mode, 1)
    for mode in ("real_image_technical", "supervised_experiment"):
        with pytest.raises(SyntheticSignalForbidden):
            fixture.fixture_context("demo_synthetic", "synthetic_tiles", mode, 1)
    ok = fixture.fixture_context("demo_synthetic", "synthetic_tiles", "synthetic_pipeline_test", 1)
    for change in ({"slide_provenance": "real_authorized"}, {"slide_provenance": "public_cc0"},
                   {"image_kind": "wsi"}, {"execution_mode": "supervised_experiment"},
                   {"execution_mode": "real_image_technical"}):
        with pytest.raises(SyntheticSignalForbidden):
            dataclasses.replace(ok, **change)
        with pytest.raises(SyntheticSignalForbidden):
            copy.replace(ok, **change)
    with pytest.raises(SyntheticSignalForbidden):
        fixture.FixtureContext("demo_synthetic", "synthetic_tiles", "synthetic_pipeline_test", 1)
    with pytest.raises(SyntheticSignalForbidden):
        fixture.FixtureContext("real_authorized", "wsi", "synthetic_pipeline_test", 1,
                               _token=fixture._CONSTRUCTION_TOKEN)
    # Bypassing __init__ entirely: every use re-checks the fields.
    forged = object.__new__(fixture.FixtureContext)
    for k, v in {"slide_provenance": "real_authorized", "image_kind": "wsi",
                 "execution_mode": "synthetic_pipeline_test", "label": 1, "_token": None}.items():
        object.__setattr__(forged, k, v)
    mutated = copy.copy(ok)
    object.__setattr__(mutated, "slide_provenance", "public_cc0")
    unpickled = pickle.loads(pickle.dumps(ok))
    unpickled.__dict__["execution_mode"] = "supervised_experiment"

    class Sub(fixture.FixtureContext):
        pass

    sub = object.__new__(Sub)
    for k, v in {"slide_provenance": "demo_synthetic", "image_kind": "synthetic_tiles",
                 "execution_mode": "synthetic_pipeline_test", "label": 1, "_token": None}.items():
        object.__setattr__(sub, k, v)
    for bad in (forged, mutated, unpickled, sub, None, {"label": 1}):
        with pytest.raises(SyntheticSignalForbidden):
            fixture.synthetic_embeddings(bad, coords, slide_sha256=sha, seed=0)
    # Sanity: through a VALID context the fixture label does change the embeddings (so the refusals above matter).
    grid = np.stack([np.arange(64) * 224, np.zeros(64)], axis=1).astype(np.int64)
    neg = fixture.fixture_context("demo_synthetic", "synthetic_tiles", "synthetic_pipeline_test", 0)
    assert not np.array_equal(fixture.synthetic_embeddings(ok, grid, slide_sha256=sha, seed=0),
                              fixture.synthetic_embeddings(neg, grid, slide_sha256=sha, seed=0))


def test_the_legacy_label_carrier_cannot_inject_a_signal_without_the_fixture_checks(ids, env):
    """Design §1 invariant 3: a label-derived signal is applied only through a FixtureContext from
    fixture_context(), which checks provenance, image kind and mode. The deprecated carrier
    (EmbedContext(..., fixture_label=1) -> LegacySyntheticContext) and fixture.legacy_synthetic_embeddings
    must not apply the signal for an arbitrary (here: a real public_cc0) slide's sha without those checks."""
    from dermpath.db import session_scope
    from dermpath.ml import encoders, fixture
    from dermpath.ml.fixture import LegacySyntheticContext, SyntheticSignalForbidden
    from dermpath.models import Slide

    with session_scope() as db:
        real = db.get(Slide, cmu_slide_id(ids))
        assert real.provenance == "public_cc0"
        sha = real.sha256
    coords = np.stack([np.arange(64) * 224, np.zeros(64)], axis=1).astype(np.int64)
    adapter = encoders.get_encoder(SYNTH)
    problems = []
    for carrier in (encoders.EmbedContext(sha, 0, fixture_label=1),
                    LegacySyntheticContext(slide_sha256=sha, seed=0, fixture_label=1)):
        try:
            with_label = adapter.embed(None, coords, carrier)
        except (SyntheticSignalForbidden, TypeError):
            continue
        without = adapter.embed(None, coords, encoders.EmbedContext(sha, 0))
        if not np.array_equal(with_label, without):
            n = int(np.sum(np.any(with_label != without, axis=1)))
            problems.append(f"{type(carrier).__name__}: {n}/64 patch embeddings of public_cc0 slide {sha[:12]}… "
                            "carry the label-derived signal")
    try:
        legacy = fixture.legacy_synthetic_embeddings(coords, slide_sha256=sha, seed=0, config=None, fixture_label=1)
        plain = fixture.legacy_synthetic_embeddings(coords, slide_sha256=sha, seed=0, config=None,
                                                    fixture_label=None)
        if not np.array_equal(legacy, plain):
            problems.append("fixture.legacy_synthetic_embeddings applies the label signal with no provenance or "
                            "mode check")
    except SyntheticSignalForbidden:
        pass
    assert problems == [], problems


def test_supervised_build_never_hands_a_label_to_the_encoder_or_the_fixture(env, ids, monkeypatch):
    """A supervised feature set over a labelled real cohort: the encoder receives pixels only, no fixture context
    is ever built and no fixture label is derived (labels never reach real adapters)."""
    from dermpath.ml import encoders, fixture
    from dermpath.ml import feature_sets as fsm

    rc = real_cohort(ids, n=3, project_id="proj-verify-sup")
    fs_id = create_set(rc["project_id"], encoder_id=HANDCRAFTED, execution_mode="supervised_experiment",
                       dataset_version_id=rc["dataset_version_id"], params={"max_patches_per_slide": 2})
    seen = []
    real_embed = encoders.LoadedEncoder.embed_batch

    def spy(self, *args, **kwargs):
        seen.append((len(args), sorted(kwargs), type(args[0]).__name__, str(args[0].dtype)))
        return real_embed(self, *args, **kwargs)

    def forbidden(*_a, **_k):
        raise AssertionError("a supervised build must never derive fixture labels or build a fixture context")

    monkeypatch.setattr(encoders.LoadedEncoder, "embed_batch", spy)
    monkeypatch.setattr(fixture, "fixture_context", forbidden)
    monkeypatch.setattr(fsm, "_fixture_labels", forbidden)
    assert fsm.build_feature_set(fs_id)["status"] == "ready"
    assert seen and all(s == (1, [], "ndarray", "uint8") for s in seen), seen


def test_real_image_technical_mode_reads_no_label_anywhere(env, ids, monkeypatch):
    """Design §1: in real_image_technical "no label is read anywhere", even when the set is built over a labelled
    frozen dataset (train-split stain reference included). Build and technical validation issue no query on label,
    dataset-version, dataset-item or disagreement tables and never touch the fixture."""
    from sqlalchemy import event

    from dermpath.db import get_engine
    from dermpath.ml import feature_sets as fsm
    from dermpath.ml import fixture

    rc = real_cohort(ids, n=4, project_id="proj-verify-tech")
    fs_id = create_set(rc["project_id"], encoder_id=HANDCRAFTED, execution_mode="real_image_technical",
                       dataset_version_id=rc["dataset_version_id"],
                       params={"max_patches_per_slide": 2, "stain_normalization": "macenko-v1"})
    touched = []
    pattern = re.compile(r'\b(from|join|update|into)\s+"?(label_version|dataset_version|dataset_item|disagreement|'
                         r'split_assignment)\b', re.IGNORECASE)

    def capture(_conn, _cursor, statement, _params, _context, _many):
        if pattern.search(statement):
            touched.append(" ".join(statement.split())[:140])

    def forbidden(*_a, **_k):
        raise AssertionError("fixture labels / contexts in real_image_technical")

    monkeypatch.setattr(fixture, "fixture_context", forbidden)
    monkeypatch.setattr(fsm, "_fixture_labels", forbidden)
    engine = get_engine()
    event.listen(engine, "before_cursor_execute", capture)
    try:
        assert fsm.build_feature_set(fs_id)["status"] == "ready"
        assert fsm.validate_feature_set(fs_id, seed=0, n_slides=2, created_by=LEAD)["summary"]["passed"] is True
    finally:
        event.remove(engine, "before_cursor_execute", capture)
    assert touched == [], touched
    fs = get_set(fs_id)
    assert fs.stain_reference_sha256 and "label" not in json.dumps(fs.input_snapshot_json).lower()


# =========================================================================== 5. imported reference labels


def _imported_cohort(ids) -> dict:
    """A COBRA-like cohort: every slide also carries an IMPORTED reference label that DISAGREES with its expert
    label, plus an expert-standard and an imported_reference-standard frozen dataset over the same slides."""
    from dermpath.datasets import create_draft, freeze
    from dermpath.db import session_scope
    from dermpath.labels import create_imported_reference_label
    from dermpath.models import Project, Slide

    rc = real_cohort(ids, n=8, project_id="proj-verify-imported")
    flip = {LABELS[0]: LABELS[1], LABELS[1]: LABELS[0]}
    imported = {}
    rc["disagreements_before_import"] = _counts()["Disagreement"]
    with session_scope() as db:
        for sid in rc["slide_ids"]:
            value = flip[rc["label_of"][sid]]
            create_imported_reference_label(db, slide=db.get(Slide, sid), value=value,
                                            provenance="COBRA-like test import (fictional): report-derived label")
            imported[sid] = value
        dv = create_draft(db, actors()["lead"], db.get(Project, rc["project_id"]), name="imported reference",
                          config={"label_scope": "slide", "eligible_review_states": ["approved"],
                                  "include_provenance": ["real_authorized"], "label_values": list(LABELS),
                                  "reference_standard": "imported_reference",
                                  "split": {"partition": "random", "seed": 0,
                                            "ratios": {"train": 0.5, "val": 0.25, "test": 0.25}}})
        freeze(db, actors()["lead"], dv, reason="imported-reference test dataset (fictional)",
               acknowledge_warnings=True)
        rc["imported_dv"] = dv.id
        rc["imported_manifest"] = dv.manifest_json
        rc["expert_manifest"] = db.get(type(dv), rc["dataset_version_id"]).manifest_json
    rc["imported_of"] = imported
    rc["disagreements_after_import"] = _counts()["Disagreement"]
    return rc


def _imported_benchmark(rc, tmp_path, seeds, protocol: str = "holdout") -> dict:
    from dermpath.ml.benchmark import run_benchmark

    params = {"max_patches_per_slide": 4, "n_boot": 50, **({"cv_folds": 3} if protocol == "dev_cv" else {})}
    report = run_benchmark({"name": "verify imported reference", "project_id": rc["project_id"],
                            "dataset_version_id": rc["imported_dv"], "encoders": [HANDCRAFTED],
                            "heads": ["meanpool_logreg"], "seeds": list(seeds), "evaluation_protocol": protocol,
                            "params": params},
                           run_jobs=True, report_path=tmp_path / "report.json")
    assert len(report["runs"]) == len(seeds) and all(r["status"] == "succeeded" for r in report["runs"]), \
        report["runs"]
    return report


def test_imported_labels_act_only_under_their_declared_standard_and_inference_writes_no_label(
        env, ids, clients, tmp_path):
    """COBRA-like flow: imported labels never act under the default expert standard (they all disagree with the
    expert reads here, so any leak shows); under the declared imported_reference standard training, validation and
    the stored evaluation use exactly the imported labels and say so; the bundle is research-use-only and states the
    standard; label-free inference writes no label; nothing renders BCC absent as benign.

    Corrected by the fix round: the label-free inference step used to score a TEST slide of the bundle's own manifest
    before any test release. tests/test_verify_leakage.py::test_bundle_inference_never_scores_a_test_slide_of_its_own_
    manifest_before_a_release shows that this is a test-split leak (now refused with 409 test_release_required), so
    the step scores a VALIDATION slide instead; what it checks (no label, prediction, disagreement or run is written,
    review state unchanged) is unchanged."""
    from dermpath.db import session_scope
    from dermpath.jobs.registry import PermanentJobError
    from dermpath.ml import training
    from dermpath.ml.models import Prediction
    from dermpath.models import DatasetVersion, LabelVersion, Slide

    rc = _imported_cohort(ids)
    em, im = rc["expert_manifest"], rc["imported_manifest"]
    # Imported labels are never expert opinions: 8 contradicting imports open no disagreement.
    assert rc["disagreements_after_import"] == rc["disagreements_before_import"]
    assert (em.get("config") or {}).get("reference_standard", "expert") == "expert"
    assert im["config"]["reference_standard"] == "imported_reference"
    with session_scope() as db:
        src = {it["label_version_id"]: db.get(LabelVersion, it["label_version_id"]).source
               for it in em["items"] + im["items"]}
    assert all(src[it["label_version_id"]] == "expert" and it["label_value"] == rc["label_of"][it["slide_id"]]
               and it["label_source"] != "imported_reference" for it in em["items"])
    assert all(src[it["label_version_id"]] == "imported_reference" and it["label_source"] == "imported_reference"
               and it["label_value"] == rc["imported_of"][it["slide_id"]] for it in im["items"])
    with session_scope() as db:
        dv = db.get(DatasetVersion, rc["imported_dv"])
        items = training.training_eligible_items(db, dv, "train") + training.training_eligible_items(
            db, dv, "validation")
        with pytest.raises(PermanentJobError):  # imported labels are never training truth under "expert"
            training._label_sources_ok(db, items, "expert")
        training._label_sources_ok(db, items, "imported_reference")

    report = _imported_benchmark(rc, tmp_path, seeds=[0])
    rid = report["runs"][0]["run_id"]
    lead = clients(LEAD)
    bodies = {"benchmark report": report, "run": lead.get(f"/api/v1/experiments/{rid}").json()}
    ev = lead.get(f"/api/v1/experiments/{rid}/evaluation?split=val")
    assert ev.status_code == 200, ev.text
    ev = bodies["evaluation"] = ev.json()
    assert ev["reference_standard"] == "imported_reference" and ev["reference_standard_notice"]
    assert bodies["run"]["identity"]["reference_standard"] == "imported_reference"
    # Development predictions are measured against the IMPORTED labels (never the expert ones).
    with session_scope() as db:
        preds = db.scalars(select(Prediction).where(Prediction.run_id == rid, Prediction.split == "val")).all()
        assert preds and all(p.label_value == rc["imported_of"][p.slide_ids_json[0]] for p in preds)
    reg = lead.post(f"/api/v1/experiments/{rid}/register")
    assert reg.status_code in (200, 201), reg.text
    bundle = reg.json()["bundle"]
    assert bundle["research_use_only"] is True and bundle["content"]["research_use_only"] is True
    assert bundle["verified"] is True and bundle["can_infer"] is True
    assert bundle["content"]["classes"]["reference_standard"] == "imported_reference"
    assert bundle["content"]["classes"]["reference_standard_notice"]
    bodies["register"] = reg.json()
    # Label-free inference on a held-out (validation) slide writes no label, no development prediction, no
    # disagreement. A test slide would be refused before a test release (409 test_release_required).
    test_sid = next(it["slide_id"] for it in im["items"] if it["split"] == "val")
    with session_scope() as db:
        state_before = db.get(Slide, test_sid).review_state
    before = _counts()
    r = lead.post(f"/api/v1/bundles/{bundle['id']}/infer", json={"slide_id": test_sid})
    assert r.status_code == 202, r.text
    out = _run_worker(["infer_slide"])
    assert [o.status for o in out] == ["succeeded"], out
    after = _counts()
    assert after["InferencePrediction"] == before["InferencePrediction"] + 1
    for k in ("LabelVersion", "Prediction", "Disagreement", "TrainingRun"):
        assert after[k] == before[k], k
    with session_scope() as db:
        assert db.get(Slide, test_sid).review_state == state_before
    preds_body = bodies["predictions"] = lead.get(f"/api/v1/bundles/{bundle['id']}/predictions").json()
    (p,) = preds_body["items"]
    assert p["is_label"] is False and p["research_use_only"] is True and p["unscorable_reason"] is None
    # Slide label views never present an imported label as an expert label or as the expert reference.
    from dermpath.labels import create_imported_reference_label

    only_imported = _real_copy(ids, "real_authorized", 7)
    with session_scope() as db:
        create_imported_reference_label(db, slide=db.get(Slide, only_imported), value="bcc_present",
                                        provenance="COBRA-like test import (fictional)")
    path_client = clients("user-pathologist")
    for sid, expert_value in ((rc["slide_ids"][0], rc["label_of"][rc["slide_ids"][0]]), (only_imported, None)):
        for c in (lead, path_client):
            view = c.get(f"/api/v1/slides/{sid}/labels").json()
            bodies[f"labels {sid} as {id(c)}"] = view
            assert all(e["source"] == "expert" for e in view["expert_labels"])
            ref = view["reference"]["slide"]
            if expert_value is None:
                assert ref["status"] == "unlabeled" and ref["label"] is None and view["expert_labels"] == []
            else:
                assert ref["label"]["value"] == expert_value and ref["label"]["source"] == "expert"
            for imp in view["imported_reference_labels"]:
                assert imp["source"] == "imported_reference" and "not an expert read" in imp["source_display"]
            detail = c.get(f"/api/v1/slides/{sid}").json()["labels"]
            assert detail["expert_label_count"] == (0 if expert_value is None else 1)
    benign = {name: benign_renderings(b) for name, b in bodies.items()}
    assert {k: v for k, v in benign.items() if v} == {}


def test_api_results_bodies_on_imported_reference_data_state_the_reference_standard(env, ids, clients, tmp_path):
    """Design §1: with reference_standard imported_reference, results measure agreement with that external
    reference "and every evaluation body and bundle says so". The failure analysis (errors), the paired comparisons
    of the comparison family and the review-priority discordances ("possible label error" against the reference)
    all show results measured against the imported labels; each must state the standard."""
    rc = _imported_cohort(ids)
    report = _imported_benchmark(rc, tmp_path, seeds=[0, 1], protocol="dev_cv")
    runs = [r["run_id"] for r in report["runs"]]
    lead = clients(LEAD)
    bodies = {}
    for rid in runs:
        ev = lead.get(f"/api/v1/experiments/{rid}/evaluation?split=oof").json()
        assert _says_imported_reference(ev)  # the stored (out-of-fold) evaluation body does say so
        bodies[f"GET /experiments/{rid[:8]}/errors?split=oof"] = lead.get(
            f"/api/v1/experiments/{rid}/errors?split=oof").json()
    bodies["GET /comparison-families/{id}"] = lead.get(
        f"/api/v1/comparison-families/{report['family']['family_id']}").json()
    bodies["GET /projects/{pid}/review-priorities"] = lead.get(
        f"/api/v1/projects/{rc['project_id']}/review-priorities").json()
    missing = {}
    for name, b in bodies.items():
        if _says_imported_reference(b):
            continue
        if "errors" in name:
            missing[name] = {"counts": b["counts"], "first_item": {k: b["items"][0][k] for k in (
                "label", "predicted", "error_type")} if b["items"] else None}
        elif "comparison" in name:
            dc = b.get("development_comparison") or {}
            missing[name] = {"development_comparison": dc.get("status"), "split": dc.get("split")}
        else:
            disc = [(it["tier_label"], d) for it in b["items"] for d in it["model_discordances"]]
            missing[name] = {"n_items": b["n_items"], "first_discordance": {
                "tier_label": disc[0][0], **{k: disc[0][1][k] for k in ("reference", "predicted", "confident")}}
                if disc else None}
    assert missing == {}, ("results measured against IMPORTED reference labels are shown without the reference "
                           f"standard or IMPORTED_REFERENCE_NOTICE: {json.dumps(missing, default=str)}")


def test_benchmark_report_on_imported_reference_data_states_the_reference_standard(env, ids, tmp_path):
    """The benchmark harness (python -m dermpath.ml.cli benchmark) is how COBRA-like imported data is compared
    across encoders and heads. Its report carries development AUROC/AUPRC/sensitivity and paired comparisons
    measured against the imported labels, so it must state the imported reference standard."""
    rc = _imported_cohort(ids)
    report = _imported_benchmark(rc, tmp_path, seeds=[0])
    written = json.loads((tmp_path / "report.json").read_text())
    dev = report["runs"][0].get("development") or {}
    assert dev.get("threshold_free"), report["runs"][0]  # the report does show metrics on these labels
    assert _says_imported_reference(written), (
        "benchmark report on an imported_reference manifest never states the reference standard: dataset block "
        f"{json.dumps(written['dataset'])}; development metric keys {sorted(dev.get('threshold_free') or {})}")


# =========================================================================== 6. synthetic banner, benign wording


def test_every_results_body_of_a_synthetic_run_carries_the_pipeline_test_banner(env, ids, clients):
    from dermpath.db import session_scope
    from dermpath.ml.models import Prediction, TrainingRun

    lead = clients(LEAD)
    bodies: dict[str, dict] = {}
    groups = ids["ml_demo"]
    families = []
    for group in ("cohort", "workflow"):
        pid = groups[group]["project_id"]
        run_ids = list(groups[group]["runs"].values())
        with session_scope() as db:
            heads = {rid: db.get(TrainingRun, rid).head for rid in run_ids}
            assert all(db.get(TrainingRun, rid).synthetic for rid in run_ids)
        for rid in run_ids:
            tag = f"{group}/{heads[rid]}"
            bodies[f"{tag} run"] = lead.get(f"/api/v1/experiments/{rid}").json()
            bodies[f"{tag} evaluation"] = lead.get(f"/api/v1/experiments/{rid}/evaluation?split=val").json()
            bodies[f"{tag} errors"] = lead.get(f"/api/v1/experiments/{rid}/errors?split=val").json()
            if heads[rid] == "abmil":
                with session_scope() as db:
                    p = db.scalars(select(Prediction).where(Prediction.run_id == rid, Prediction.split == "val")
                                   ).first()
                    sid = p.slide_ids_json[0]
                att = lead.get(f"/api/v1/experiments/{rid}/attention/{sid}")
                assert att.status_code == 200, att.text
                bodies[f"{tag} attention"] = att.json()
            reg = lead.post(f"/api/v1/experiments/{rid}/register")
            assert reg.status_code in (200, 201), reg.text
            bodies[f"{tag} register"] = reg.json()
            assert reg.json()["bundle"] is not None
            bodies[f"{tag} bundle"] = lead.get(f"/api/v1/bundles/{reg.json()['bundle_id']}").json()
            with session_scope() as db:
                fs_id = db.get(TrainingRun, rid).feature_set_id
            bodies[f"{tag} feature set"] = lead.get(f"/api/v1/feature-sets/{fs_id}").json()
        fam = lead.post(f"/api/v1/projects/{pid}/comparison-families",
                        json={"name": f"verify {group}", "dataset_version_id": groups[group]["dataset_version_id"]})
        assert fam.status_code == 201, fam.text
        for rid in run_ids:
            assert lead.post(f"/api/v1/comparison-families/{fam.json()['id']}/members",
                             json={"run_id": rid}).status_code in (200, 201)
        families.append(fam.json()["id"])
        bodies[f"{group} family"] = lead.get(f"/api/v1/comparison-families/{fam.json()['id']}").json()
        for name, url in ((f"{group} experiments", f"/api/v1/projects/{pid}/experiments"),
                          (f"{group} models", f"/api/v1/projects/{pid}/models"),
                          (f"{group} bundles", f"/api/v1/projects/{pid}/bundles"),
                          (f"{group} feature sets", f"/api/v1/projects/{pid}/feature-sets")):
            body = lead.get(url).json()
            for i, item in enumerate(body["items"]):
                bodies[f"{name}[{i}]"] = item
        rp = lead.get(f"/api/v1/projects/{pid}/review-priorities").json()
        if rp["items"]:
            bodies[f"{group} review priorities"] = rp
    missing = sorted(n for n, b in bodies.items() if not (b.get("banner") == BANNER and b.get("synthetic") is True))
    assert missing == [], f"synthetic results without the PIPELINE TEST banner: {missing}"
    for name, b in bodies.items():
        if "bundle" in name and "content" in b:
            assert b["research_use_only"] is True and b["content"]["research_use_only"] is True, name
        if name.endswith("register"):
            assert b["deployed"] is False and b["bundle"]["research_use_only"] is True
            assert b["bundle"]["can_infer"] is False  # pipeline-test bundles never score new slides
    benign = {n: benign_renderings(b) for n, b in bodies.items()}
    assert {k: v for k, v in benign.items() if v} == {}


def test_api_vocabulary_and_encoder_listing_never_render_bcc_absent_as_benign(env, ids, clients):
    from dermpath import vocab
    from dermpath.ml import encoders
    from dermpath.ml.evaluation import NEGATIVE_NOTE

    lead = clients(LEAD)
    bodies = {"encoders": lead.get("/api/v1/encoders").json(),
              "label display": vocab.LABEL_DISPLAY,
              "source display": vocab.LABEL_SOURCE_DISPLAY,
              "negative note": NEGATIVE_NOTE.format(neg="bcc_absent_not_benign", pos="bcc_present"),
              "specs": [s.to_dict() for s in encoders.ENCODER_SPECS.values()]}
    sid = ids["slides"]["p1_a1_l1"]
    bodies["slide"] = lead.get(f"/api/v1/slides/{sid}").json()
    benign = {n: benign_renderings(b) for n, b in bodies.items()}
    assert {k: v for k, v in benign.items() if v} == {}


# =========================================================================== 7. no network, no hub download


def test_real_adapters_load_and_run_through_the_pipeline_with_the_network_and_hub_disabled(
        env, ids, clients, monkeypatch, tmp_path):
    """Tiny local timm ViT (UNI adapter) and transformers Dinov2 (Midnight adapter) weights, loaded and run through
    the full feature-set API + worker path (build, technical validation) while every socket connection and every
    hub / torch-hub download function raises. Real adapters also refuse label carriers."""
    torch = pytest.importorskip("torch")
    timm = pytest.importorskip("timm")
    transformers = pytest.importorskip("transformers")
    safetensors_torch = pytest.importorskip("safetensors.torch")
    import huggingface_hub
    import huggingface_hub.constants

    from dermpath.ml import encoders
    from dermpath.ml.fixture import SyntheticSignalForbidden

    for name in ("HF_HUB_OFFLINE", "TRANSFORMERS_OFFLINE", "HF_HUB_DISABLE_TELEMETRY"):
        monkeypatch.setenv(name, "1")
    # Tiny UNI (timm vit_large_patch16_224 builder, tiny dims).
    arch = copy.deepcopy(encoders.UNI_SPEC.architecture)
    arch["kwargs"].update({"embed_dim": 32, "depth": 2, "num_heads": 2})
    uni_spec = dataclasses.replace(encoders.UNI_SPEC, architecture=arch, embedding_dim=32)
    torch.manual_seed(0)
    torch.save(timm.create_model(arch["model"], pretrained=False, **arch["kwargs"]).eval().state_dict(),
               tmp_path / "pytorch_model.bin")
    monkeypatch.setenv("WB_UNI_WEIGHTS", str(tmp_path / "pytorch_model.bin"))
    monkeypatch.setenv("WB_UNI_LICENSE_ACCEPTED", "1")
    monkeypatch.setitem(encoders.REGISTRY, encoders.UNI_ID, encoders.UNIEncoder(uni_spec))
    # Tiny Midnight (transformers Dinov2Model, local hf_dir).
    cfg = transformers.Dinov2Config(hidden_size=32, num_hidden_layers=2, num_attention_heads=2, patch_size=14,
                                    image_size=224, use_swiglu_ffn=True)
    d = tmp_path / "midnight"
    d.mkdir()
    torch.manual_seed(0)
    model = transformers.Dinov2Model(cfg).eval()
    safetensors_torch.save_file({k: v.contiguous() for k, v in model.state_dict().items()},
                                str(d / "model.safetensors"))
    (d / "config.json").write_text(json.dumps(cfg.to_dict()))
    m_arch = copy.deepcopy(encoders.MIDNIGHT_SPEC.architecture)
    m_arch["expected_config"] = {"hidden_size": 32, "num_hidden_layers": 2, "patch_size": 14, "use_swiglu_ffn": True}
    m_spec = dataclasses.replace(encoders.MIDNIGHT_SPEC, architecture=m_arch, embedding_dim=64)
    monkeypatch.setenv("WB_MIDNIGHT_WEIGHTS", str(d))
    midnight_id = encoders.MIDNIGHT_SPEC.id
    monkeypatch.setitem(encoders.REGISTRY, midnight_id, encoders.MidnightEncoder(m_spec))
    encoders.clear_loaded_encoders()

    attempts: list = []

    def refuse(*args, **kwargs):
        attempts.append((args[:2], sorted(kwargs)))
        raise OSError("network and hub downloads are disabled in this test")

    monkeypatch.setattr(socket.socket, "connect", refuse)
    monkeypatch.setattr(socket.socket, "connect_ex", refuse)
    monkeypatch.setattr(socket, "create_connection", refuse)
    monkeypatch.setattr(socket, "getaddrinfo", refuse)
    monkeypatch.setattr(urllib.request, "urlopen", refuse)
    for owner, name in ((huggingface_hub, "hf_hub_download"), (huggingface_hub, "snapshot_download"),
                        (transformers.PreTrainedModel, "from_pretrained"),
                        (transformers.PretrainedConfig, "from_pretrained"),
                        (transformers.AutoModel, "from_pretrained"), (transformers.AutoConfig, "from_pretrained"),
                        (torch.hub, "load_state_dict_from_url"), (torch.hub, "download_url_to_file"),
                        (torch.hub, "load")):
        monkeypatch.setattr(owner, name, refuse)
    import timm.models

    for name in ("load_pretrained", "load_checkpoint"):
        if hasattr(timm.models, name):
            monkeypatch.setattr(timm.models, name, refuse)
    monkeypatch.setattr(huggingface_hub.constants, "HF_HUB_OFFLINE", False)

    lead = clients(LEAD)
    sid = cmu_slide_id(ids)
    try:
        for enc_id, dim in ((encoders.UNI_ID, 32), (midnight_id, 64)):
            r = lead.post(f"/api/v1/projects/{CMU_PROJECT}/feature-sets",
                          json={"slide_ids": [sid], "encoder_id": enc_id, "execution_mode": "real_image_technical",
                                "params": {"max_patches_per_slide": 2}, "device": "cpu"})
            assert r.status_code == 202, r.text
            fs_id = r.json()["feature_set"]["id"]
            out = _run_worker(["build_feature_set"])
            assert [o.status for o in out] == ["succeeded"], out
            v = lead.post(f"/api/v1/feature-sets/{fs_id}/technical-validation", json={"seed": 0, "n_slides": 1})
            assert v.status_code == 202, v.text
            out = _run_worker(["validate_feature_set"])
            assert [o.status for o in out] == ["succeeded"], out
            fs = lead.get(f"/api/v1/feature-sets/{fs_id}").json()
            assert fs["status"] == "ready" and fs["synthetic"] is False and fs["label_free"] is True
            from dermpath.ml.feature_sets import load_slide_features

            assert load_slide_features(fs_id, sid).embeddings.shape == (2, dim)
            adapter = encoders.get_encoder(enc_id)
            from PIL import Image

            patch = [Image.new("RGB", (224, 224), (190, 110, 160))]
            for carrier in (encoders.EmbedContext("ab" * 32, 0, fixture_label=1),
                            encoders.EmbedContext("ab" * 32, 0, fixture_label=0)):
                with pytest.raises(SyntheticSignalForbidden):
                    adapter.embed(patch, np.zeros((1, 2), np.int64), carrier)
    finally:
        encoders.clear_loaded_encoders()
    assert attempts == [], f"network / hub download attempted: {attempts}"
    assert huggingface_hub.constants.HF_HUB_OFFLINE is True
