"""Feature-set HTTP API (design §5): permissions, idempotent creation, build and technical
validation through the job queue, refusals with their error codes, and the settle hook."""

from __future__ import annotations

from sqlalchemy import select

from feature_set_support import CMU_PROJECT, HANDCRAFTED, SYNTH, cmu_slide_id
from test_ml_support import CID, cohort

BASE = "/api/v1"


def _run(types=("build_feature_set", "validate_feature_set")):
    from dermpath.jobs.worker import Worker

    return Worker("fs-test-worker", types=list(types)).run_until_idle()


def _body(ids, **kw):
    body = {"encoder_id": HANDCRAFTED, "execution_mode": "real_image_technical", "slide_ids": [cmu_slide_id(ids)],
            "params": {"max_patches_per_slide": 10}}
    body.update(kw)
    return body


def test_permissions(clients, ids):
    lead, path, asst, director = (clients(u) for u in ("user-research-lead", "user-pathologist", "user-assistant",
                                                        "user-director"))
    for c in (path, asst, director):
        r = c.post(f"{BASE}/projects/{CMU_PROJECT}/feature-sets", json=_body(ids))
        assert r.status_code == 403, r.text
    r = lead.post(f"{BASE}/projects/{CMU_PROJECT}/feature-sets", json=_body(ids))
    assert r.status_code == 202, r.text
    fs_id = r.json()["feature_set"]["id"]
    for c in (lead, path, director):  # experiment.read
        assert c.get(f"{BASE}/feature-sets/{fs_id}").status_code == 200
        assert c.get(f"{BASE}/projects/{CMU_PROJECT}/feature-sets").status_code == 200
    assert asst.get(f"{BASE}/feature-sets/{fs_id}").status_code == 403
    for c in (path, asst, director):  # experiment.write
        assert c.post(f"{BASE}/feature-sets/{fs_id}/build").status_code == 403
        assert c.post(f"{BASE}/feature-sets/{fs_id}/technical-validation", json={}).status_code == 403
    assert clients.anon().get(f"{BASE}/feature-sets/{fs_id}").status_code == 401
    assert lead.get(f"{BASE}/feature-sets/does-not-exist").status_code == 404


def test_create_build_read_and_validate_through_the_api(clients, ids):
    lead = clients("user-research-lead")
    r = lead.post(f"{BASE}/projects/{CMU_PROJECT}/feature-sets", json=_body(ids, name="CMU handcrafted"))
    assert r.status_code == 202, r.text
    out = r.json()
    fs = out["feature_set"]
    assert out["created"] is True and out["job_id"] and fs["status"] == "building" and fs["name"] == "CMU handcrafted"
    assert fs["label_free"] is True and fs["synthetic"] is False and fs["banner"] is None
    again = lead.post(f"{BASE}/projects/{CMU_PROJECT}/feature-sets", json=_body(ids)).json()
    assert again["created"] is False and again["feature_set"]["id"] == fs["id"] and again["job_id"] == out["job_id"]
    outcomes = _run()
    assert [o.status for o in outcomes] == ["succeeded"], outcomes
    d = lead.get(f"{BASE}/feature-sets/{fs['id']}?staleness=true").json()
    assert d["status"] == "ready" and d["ready_at"] and d["counts"]["done"] == 1
    assert d["coverage"]["per_slide"][0]["n_patches"] == 10 and d["coverage"]["total_patches"] == 10
    assert d["staleness"]["stale"] is False and d["qc_source"] == "live_qc_at_creation"
    assert d["patch_policy"]["sampling"]["max_patches"] == 10 and d["extraction_env"]["device_class"] == "cpu"
    listed = lead.get(f"{BASE}/projects/{CMU_PROJECT}/feature-sets").json()["items"]
    mine = [x for x in listed if x["id"] == fs["id"]]  # the seed may hold other (demo) feature sets
    assert len(mine) == 1 and mine[0]["status"] == "ready" and "coverage" not in mine[0]
    # Technical validation: seeded re-extraction compared with the stored artifacts.
    r = lead.post(f"{BASE}/feature-sets/{fs['id']}/technical-validation", json={"seed": 3, "n_slides": 1})
    assert r.status_code == 202, r.text
    assert [o.status for o in _run()] == ["succeeded"]
    vals = lead.get(f"{BASE}/feature-sets/{fs['id']}/validations").json()["items"]
    assert len(vals) == 1 and vals[0]["passed"] is True
    res = vals[0]["result"]
    slide = res["per_slide"][0]
    assert slide["coords_identical"] and slide["max_abs_diff"] == 0.0 and slide["cache_key_match"]
    assert slide["patches_per_second"] > 0 and slide["peak_rss_bytes"] > 0 and res["tolerance"]["max_abs_diff"] == 0
    assert lead.get(f"{BASE}/feature-sets/{fs['id']}").json()["validations"][0]["passed"] is True
    # A subset validation (seeded patches) also passes.
    lead.post(f"{BASE}/feature-sets/{fs['id']}/technical-validation", json={"seed": 1, "max_patches": 4})
    _run()
    vals = lead.get(f"{BASE}/feature-sets/{fs['id']}/validations").json()["items"]
    assert len(vals) == 2 and all(v["passed"] for v in vals)
    sub = next(v for v in vals if v["result"]["max_patches"] == 4)["result"]["per_slide"][0]
    assert sub["mode"] == "subset" and sub["n_compared"] == 4 and sub["sampled_coords_sha256_match"] is True
    # Build on a ready set: nothing to do (the job already succeeded).
    r = lead.post(f"{BASE}/feature-sets/{fs['id']}/build")
    assert r.status_code == 202 and r.json()["job"]["status"] == "succeeded"


def test_refusals_carry_their_codes(clients, ids):
    lead = clients("user-research-lead")
    url = f"{BASE}/projects/{CMU_PROJECT}/feature-sets"
    r = lead.post(url, json=_body(ids, encoder_id=SYNTH))
    assert r.status_code == 409 and r.json()["error"]["code"] == "mode_mismatch"
    r = lead.post(url, json=_body(ids, params={"max_patches_per_slide": 4, "head_lr": 0.1}))
    assert r.status_code == 422 and r.json()["error"]["code"] == "invalid_params"
    r = lead.post(url, json=_body(ids, params={"patch_size": 256}))
    assert r.status_code == 422 and r.json()["error"]["code"] == "invalid_params"
    r = lead.post(url, json=_body(ids, encoder_id="uni-v1"))
    assert r.status_code == 409 and r.json()["error"]["code"] == "encoder_unavailable"
    r = lead.post(url, json=_body(ids, encoder_id="no-such-encoder"))
    assert r.status_code == 422 and r.json()["error"]["code"] == "unknown_encoder"
    r = lead.post(url, json=_body(ids, slide_ids=None))
    assert r.status_code == 422 and r.json()["error"]["code"] == "invalid_slides"
    r = lead.post(url, json=_body(ids, slide_ids=[ids["slides"]["p6_a1_field"]]))
    assert r.status_code == 409 and r.json()["error"]["code"] == "slide_not_extractable"
    r = lead.post(url, json=_body(ids, execution_mode="clinical"))
    assert r.status_code == 422
    # Technical validation needs a ready set.
    fs = lead.post(url, json=_body(ids, build=False)).json()["feature_set"]
    r = lead.post(f"{BASE}/feature-sets/{fs['id']}/technical-validation", json={})
    assert r.status_code == 409 and r.json()["error"]["code"] == "feature_set_not_ready"
    r = lead.post(f"{BASE}/feature-sets/{fs['id']}/build", json={"repair": True})
    assert r.status_code == 409


def test_synthetic_pipeline_set_via_the_api_is_labelled(clients, ids):
    lead = clients("user-research-lead")
    r = lead.post(f"{BASE}/projects/{CID}/feature-sets", json={
        "encoder_id": SYNTH, "execution_mode": "synthetic_pipeline_test",
        "dataset_version_id": cohort(ids)["dataset_version_id"],
        "params": {"pixel_mode": "none", "max_patches_per_slide": 4}, "build": False})
    assert r.status_code == 202, r.text
    fs = r.json()["feature_set"]
    assert fs["synthetic"] is True and "PIPELINE TEST" in fs["banner"] and fs["label_free"] is False
    assert r.json()["job_id"] is None and fs["status"] == "building"


def test_failed_build_settles_the_set_and_a_new_request_resumes_it(clients, ids, monkeypatch):
    from dermpath.db import session_scope
    from dermpath.ml import feature_sets as fsm
    from dermpath.ml.engine_models import FeatureSet
    from dermpath.models import Job

    lead = clients("user-research-lead")
    out = lead.post(f"{BASE}/projects/{CMU_PROJECT}/feature-sets", json=_body(ids)).json()
    fs_id, job_id = out["feature_set"]["id"], out["job_id"]

    def broken(*_a, **_k):
        raise fsm.FeatureError("simulated deterministic failure")

    monkeypatch.setattr(fsm, "_extract", broken)
    outcomes = _run()
    assert [o.status for o in outcomes] == ["failed"]
    with session_scope() as db:
        fs, job = db.get(FeatureSet, fs_id), db.get(Job, job_id)
        assert fs.status == "failed" and "simulated" in fs.error and job.attempts == 1
    monkeypatch.undo()
    r = lead.post(f"{BASE}/feature-sets/{fs_id}/build")
    assert r.status_code == 202 and r.json()["job_id"] == job_id and r.json()["job"]["status"] == "queued"
    assert r.json()["feature_set"]["status"] == "building"
    assert [o.status for o in _run()] == ["succeeded"]
    assert lead.get(f"{BASE}/feature-sets/{fs_id}").json()["status"] == "ready"


def test_settle_hook_is_registered_for_the_build_job(env):
    from dermpath.jobs.registry import SETTLE_HOOKS, get_handler, load_handlers

    report = load_handlers(force=True)
    assert report.get("dermpath.ml.feature_sets") == "loaded"
    assert get_handler("build_feature_set") is not None and get_handler("validate_feature_set") is not None
    assert SETTLE_HOOKS.get("build_feature_set")


def test_build_payload_never_carries_labels(env, ids):
    from dermpath.db import session_scope
    from dermpath.jobs import queue
    from dermpath.models import Job

    with session_scope() as db:
        job, _ = queue.enqueue(db, "build_feature_set", {"feature_set_id": "x", "fixture_label": 1},
                               idempotency_key="fs-label-in-payload", project_id=CMU_PROJECT)
        jid = job.id
    outcomes = _run()
    assert [o.status for o in outcomes] == ["failed"] and "never carry labels" in outcomes[0].error
    with session_scope() as db:
        assert db.scalars(select(Job).where(Job.id == jid)).one().attempts == 1
