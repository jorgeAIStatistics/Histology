"""Adversarial verification, lens LEAKAGE (research use only).

Each test asserts one leakage guarantee of the engine (design §1, §2, §6, §7, §8, §9). A failing test is the
reproduction of a defect; a passing one stays as regression coverage.

Attacks:

* test-split predictions obtained WITHOUT a recorded test release (bundle inference on test slides, GET side
  effects, errors / attention / family endpoints);
* a second look at the same sealed test patients without a justification (child dataset version);
* sealed test patients (or their slides) reaching train (new root lineage, new lineage child, child version after a
  slide is moved between patients);
* held-out information reaching fitting, early stopping, scaler / class weights, learning-curve subsets, threshold,
  calibration and abstention (holdout and dev_cv, including confirmed-duplicate patients);
* test slides read by a train job; active-learning pool containing test / val / sealed patients;
* the macenko stain reference planned on non-train slides.
"""

from __future__ import annotations

import copy
import hashlib
import uuid

import numpy as np
import pytest
from sqlalchemy import func, select

from ml_engine_fakes import CID, cohort_dv, install_fakes, make_engine_run, run_jobs
from test_ml_support import FAST, SYNTH, cohort

LEAD = "user-research-lead"
DIRECTOR = "user-director"
PATHOLOGIST = "user-pathologist"
ASSISTANT = "user-assistant"
RELEASE_JOB = "evaluate_test_release"
COHORT_SPLIT = {"partition": "random", "seed": 11, "ratios": {"train": 0.6, "val": 0.2, "test": 0.2}}
COHORT_CONFIG = {"label_scope": "slide", "eligible_review_states": ["approved"],
                 "include_provenance": ["demo_synthetic"], "label_values": ["bcc_present", "bcc_absent_not_benign"]}


# =========================================================================== helpers


def _engine_run(dv_id: str | None = None, ids=None, **kw) -> tuple[str, str, str]:
    from dermpath.db import session_scope
    from dermpath.models import DatasetVersion

    with session_scope() as db:
        dv = db.get(DatasetVersion, dv_id) if dv_id else cohort_dv(db, ids)
        run, fs = make_engine_run(db, dv, **kw)
        return run.id, fs.id, dv.id


def _counts() -> dict:
    from dermpath.db import session_scope
    from dermpath.ml.engine_models import InferencePrediction, TestRelease
    from dermpath.ml.models import Evaluation, Prediction
    from dermpath.models import AuditEvent, Job, SplitFamilyAssignment

    with session_scope() as db:
        return {"test_predictions": db.scalar(select(func.count(Prediction.id)).where(Prediction.split == "test")),
                "predictions": db.scalar(select(func.count(Prediction.id))),
                "inference_predictions": db.scalar(select(func.count(InferencePrediction.id))),
                "evaluations": db.scalar(select(func.count(Evaluation.id))),
                "releases": db.scalar(select(func.count(TestRelease.id))),
                "jobs": db.scalar(select(func.count(Job.id))),
                "audit": db.scalar(select(func.count(AuditEvent.id))),
                "sealed": db.scalar(select(func.count(SplitFamilyAssignment.id))
                                    .where(SplitFamilyAssignment.sealed_at.is_not(None)))}


def _manifest(dv_id: str) -> dict:
    from dermpath.db import session_scope
    from dermpath.models import DatasetVersion

    with session_scope() as db:
        return copy.deepcopy(db.get(DatasetVersion, dv_id).manifest_json)


def _sealed_patients(dv_id: str) -> dict[str, str]:
    """{coded_patient_id: split} of every sealed assignment in the version's split family."""
    from dermpath.datasets import family_assignments, lineage_family
    from dermpath.db import session_scope
    from dermpath.models import DatasetVersion

    with session_scope() as db:
        dv = db.get(DatasetVersion, dv_id)
        return {pid: a.split for pid, a in family_assignments(db, lineage_family(db, dv.lineage_id)).items()
                if a.sealed_at is not None}


def _split_of_patient(manifest: dict) -> dict[str, str]:
    return {s["coded_patient_id"]: s["split"] for s in manifest["splits"]}


def _register_and_release(client, run_id: str, reason: str, *, justification: str | None = None,
                          candidate: str | None = None):
    reg = client.post(f"/api/v1/experiments/{run_id}/register", json={"note": "declared candidate"})
    assert reg.status_code in (200, 201), reg.text
    body = {"reason": reason}
    if justification:
        body["justification"] = justification
    if candidate:
        body["candidate"] = candidate
    return client.post(f"/api/v1/experiments/{run_id}/test-release", json=body)


def _freeze_api(client, dv_id: str):
    return client.post(f"/api/v1/datasets/{dv_id}/freeze",
                       json={"reason": "verification dataset (warnings acknowledged)", "acknowledge_warnings": True})


def _released_cohort(clients, ids, monkeypatch) -> dict:
    """The seeded cohort with one recorded, scored test release (fakes for the partners' loaders)."""
    install_fakes(monkeypatch)
    rid, fs_id, dv = _engine_run(ids=ids)
    lead = clients(LEAD)
    r = _register_and_release(lead, rid, "final evaluation of the registered candidate")
    assert r.status_code == 202, r.text
    out = run_jobs([RELEASE_JOB])
    assert [o.status for o in out] == ["succeeded"], [o.error for o in out]
    sealed = _sealed_patients(dv)
    assert sealed and set(sealed.values()) == {"test"}
    return {"run_id": rid, "dv": dv, "sealed": sealed, "release": r.json()["test_release"]}


# =========================================================================== test results without a release


def test_reads_of_test_results_before_any_release_have_no_side_effects(clients, ids, monkeypatch):
    """GET evaluation / errors / attention / release status / families / review priorities before any release:
    409 or 403, and nothing is computed, enqueued, sealed or written (not even an audit row for the lead)."""
    calls = install_fakes(monkeypatch)
    rid, _fs, dv = _engine_run(ids=ids)
    test_slide = sorted(it["slide_id"] for it in _manifest(dv)["items"] if it["split"] == "test")[0]
    lead = clients(LEAD)
    fam = lead.post(f"/api/v1/projects/{CID}/comparison-families",
                    json={"name": "verification family", "dataset_version_id": dv})
    assert fam.status_code == 201, fam.text
    fam_id = fam.json()["id"]
    before = _counts()
    for path, ok in ((f"/api/v1/experiments/{rid}/evaluation?split=test", {409}),
                     (f"/api/v1/experiments/{rid}/errors?split=test", {409}),
                     (f"/api/v1/experiments/{rid}/attention/{test_slide}", {404, 409}),
                     (f"/api/v1/experiments/{rid}/test-release", {200}),
                     (f"/api/v1/projects/{CID}/test-releases", {200}),
                     (f"/api/v1/comparison-families/{fam_id}", {200}),
                     (f"/api/v1/projects/{CID}/review-priorities?run_id={rid}", {200}),
                     (f"/api/v1/experiments/{rid}", {200})):
        r = lead.get(path)
        assert r.status_code in ok, (path, r.status_code, r.text)
        if r.status_code == 409 and "split=test" in path:
            assert r.json()["error"]["code"] == "test_release_required", r.text
        if path.endswith(fam_id):
            assert r.json()["test_comparison"]["status"] == "locked"
        assert "test_summary" not in r.text and '"split":"test"' not in r.text.replace(" ", "")
    assert _counts() == before, "a lead's test GET before any release wrote something"
    for uid in (DIRECTOR, PATHOLOGIST):
        c = clients(uid)
        for path in (f"/api/v1/experiments/{rid}/evaluation?split=test",
                     f"/api/v1/experiments/{rid}/errors?split=test"):
            r = c.get(path)
            assert r.status_code in (403, 409), (uid, path, r.text)
    after = _counts()
    assert {k: v for k, v in after.items() if k != "audit"} == {k: v for k, v in before.items() if k != "audit"}
    assert calls.load == [] and calls.extract == [] and calls.score == 0


def test_bundle_inference_never_scores_a_test_slide_of_its_own_manifest_before_a_release(env, ids, clients):
    """Design §7: test metrics only through POST /experiments/{id}/test-release (research lead, reason, counted,
    sealing). A registered bundle must not be a side door: scoring the TEST slides of its own frozen manifest
    through POST /bundles/{id}/infer gives per-slide test scores and decisions (readable by every experiment.read
    role through GET /bundles/{id}/predictions) with no release, no count and no seal."""
    from feature_set_support import create_set, get_set, real_cohort

    from dermpath.db import session_scope
    from dermpath.ml.encoders import ENCODER_SPECS
    from dermpath.ml.feature_sets import build_feature_set
    from dermpath.models import DatasetVersion

    hand = "handcrafted-stain-texture-v1"
    rc = real_cohort(ids, n=6, project_id="proj-verify-leak")
    fs_id = create_set(rc["project_id"], encoder_id=hand, execution_mode="supervised_experiment",
                       dataset_version_id=rc["dataset_version_id"], params={"max_patches_per_slide": 4})
    build_feature_set(fs_id)
    assert get_set(fs_id).status == "ready"
    with session_scope() as db:
        dv = db.get(DatasetVersion, rc["dataset_version_id"])
        run, _ = make_engine_run(db, dv, fs=db.get(type(get_set(fs_id)), fs_id), mode="supervised_experiment",
                                 encoder_id=hand, store_val=False, dim=ENCODER_SPECS[hand].embedding_dim)
        rid = run.id
    lead = clients(LEAD)
    reg = lead.post(f"/api/v1/experiments/{rid}/register")
    assert reg.status_code in (200, 201), reg.text
    bundle_id = reg.json()["bundle_id"]
    test_slides = sorted(s for s, sp in rc["split_of"].items() if sp == "test")
    assert test_slides, rc["split_of"]
    sid = test_slides[0]
    before = _counts()
    r = lead.post(f"/api/v1/bundles/{bundle_id}/infer", json={"slide_id": sid})
    evidence = {"status": r.status_code}
    if r.status_code == 202:
        out = run_jobs(["infer_slide"])
        evidence["job"] = [(o.status, o.error) for o in out]
        preds = clients(DIRECTOR).get(f"/api/v1/bundles/{bundle_id}/predictions")
        evidence["director_reads"] = preds.status_code
        evidence["predictions"] = [{k: p.get(k) for k in ("slide_id", "score", "predicted", "abstained")}
                                   for p in preds.json().get("items", [])]
        evidence["label_of_slide"] = rc["label_of"][sid]
        evidence["releases_recorded"] = _counts()["releases"] - before["releases"]
        evidence["patients_sealed"] = _counts()["sealed"] - before["sealed"]
    assert r.status_code in (403, 409), (
        f"bundle inference scored TEST slide {sid} of the bundle's own manifest without a test release: {evidence}")


def test_family_test_comparison_reads_are_audited_and_restricted(clients, ids, monkeypatch):
    """A family's test comparison is a test result: only the research lead sees it, only after the family release,
    and every read is an access record like GET evaluation?split=test (design §7 'Reading stored test results')."""
    from dermpath.db import session_scope
    from dermpath.models import AuditEvent

    install_fakes(monkeypatch)
    lead = clients(LEAD)
    with session_scope() as db:
        dv_id = cohort_dv(db, ids).id
    fam = lead.post(f"/api/v1/projects/{CID}/comparison-families",
                    json={"name": "verification family", "dataset_version_id": dv_id}).json()
    a, _, _ = _engine_run(ids=ids, seed=1, family_id=fam["id"])
    b, _, _ = _engine_run(ids=ids, seed=2, family_id=fam["id"])
    assert lead.post(f"/api/v1/comparison-families/{fam['id']}/lock",
                     json={"reason": "candidates fixed before the test release"}).status_code == 200
    r = lead.post(f"/api/v1/experiments/{a}/test-release", json={"reason": "family release", "candidate": "family"})
    assert r.status_code == 202, r.text
    assert [o.status for o in run_jobs([RELEASE_JOB])] == ["succeeded"]
    assert clients(DIRECTOR).get(f"/api/v1/comparison-families/{fam['id']}").json()["test_comparison"]["status"] \
        == "restricted"

    def accessed():
        with session_scope() as db:
            return db.scalar(select(func.count(AuditEvent.id)).where(AuditEvent.action == "experiment.test_accessed"))

    n0 = accessed()
    body = lead.get(f"/api/v1/comparison-families/{fam['id']}").json()
    assert body["test_comparison"]["status"] == "ok", body["test_comparison"]
    assert accessed() > n0, ("GET /comparison-families/{id} returned the TEST comparison (paired test metrics of "
                             "runs %s) without an experiment.test_accessed audit row" % sorted([a, b]))


# =========================================================================== repeated test looks


@pytest.mark.parametrize("route", ["child_version", "fresh_root_same_config"])
def test_a_second_look_at_sealed_test_patients_needs_a_justification(clients, ids, monkeypatch, route):
    """Design §7: a second release on the same test patients is justified, counted and shown. A child dataset
    version inherits every sealed test patient (same lineage, same split family); a fresh root dataset with the
    same configuration reproduces the same test patients. Releasing a run of either is a second look at the SAME
    sealed test set and must not be presented as release 1 with 0 prior releases and no justification."""
    rel = _released_cohort(clients, ids, monkeypatch)
    lead = clients(LEAD)
    # Same manifest: a second release needs a justification (holds).
    other, _, _ = _engine_run(ids=ids, seed=7)
    r = _register_and_release(lead, other, "another candidate")
    assert r.status_code == 422 and r.json()["error"]["code"] == "justification_required", r.text
    if route == "child_version":  # only a reason is needed
        child = lead.post(f"/api/v1/datasets/{rel['dv']}/new-version", json={"reason": "routine new version"})
    else:
        child = lead.post(f"/api/v1/projects/{CID}/datasets",
                          json={"name": "same cohort again", "config": {**COHORT_CONFIG, "split": COHORT_SPLIT}})
    assert child.status_code == 201, child.text
    child_id = child.json()["id"]
    assert _freeze_api(lead, child_id).status_code == 200
    m1, m2 = _manifest(rel["dv"]), _manifest(child_id)
    test1 = {s["coded_patient_id"] for s in m1["splits"] if s["split"] == "test"}
    test2 = {s["coded_patient_id"] for s in m2["splits"] if s["split"] == "test"}
    assert test1 == test2 == set(rel["sealed"])
    rid2, _, _ = _engine_run(dv_id=child_id, seed=8)
    r = _register_and_release(lead, rid2, "evaluation on the child version")
    got = r.json()
    assert r.status_code == 422 and got["error"]["code"] == "justification_required", (
        f"a release on a {route} dataset re-reads the same sealed test patients without a justification: "
        f"status {r.status_code}, release_number={(got.get('test_release') or {}).get('release_number')}, "
        f"prior_releases_on_manifest={(got.get('test_release') or {}).get('prior_releases_on_manifest')}, "
        f"sealed test patients re-read: {len(test2 & set(rel['sealed']))}")


# =========================================================================== sealed patients never reach train


def test_sealed_test_patients_stay_test_in_child_versions_and_new_lineage_children(clients, ids, monkeypatch):
    rel = _released_cohort(clients, ids, monkeypatch)
    lead = clients(LEAD)
    child = lead.post(f"/api/v1/datasets/{rel['dv']}/new-version", json={"reason": "routine new version"}).json()
    assert _freeze_api(lead, child["id"]).status_code == 200
    split = _split_of_patient(_manifest(child["id"]))
    assert {pid: split.get(pid) for pid in rel["sealed"]} == {pid: "test" for pid in rel["sealed"]}
    # New lineage with another seed (the documented way to re-split): sealed patients stay test.
    nl = lead.post(f"/api/v1/datasets/{rel['dv']}/new-version",
                   json={"reason": "re-split with another seed", "new_lineage": True,
                         "split": {**COHORT_SPLIT, "seed": 977}})
    assert nl.status_code == 201, nl.text
    f = _freeze_api(lead, nl.json()["id"])
    if f.status_code == 200:
        split = _split_of_patient(_manifest(nl.json()["id"]))
        assert all(split.get(pid) in (None, "test") for pid in rel["sealed"]), split
    else:
        assert f.status_code == 409, f.text


def test_sealed_test_patients_never_reach_train_through_a_fresh_root_lineage(clients, ids, monkeypatch):
    """Design §2: 'Sealed patients can never change split.' A new root dataset of the same cohort in the same
    project (POST /projects/{pid}/datasets, another seed) must not place a sealed test patient in train or val."""
    rel = _released_cohort(clients, ids, monkeypatch)
    lead = clients(LEAD)
    r = lead.post(f"/api/v1/projects/{CID}/datasets",
                  json={"name": "same cohort, fresh lineage",
                        "config": {**COHORT_CONFIG, "split": {**COHORT_SPLIT, "seed": 977}}})
    assert r.status_code == 201, r.text
    dv2 = r.json()["id"]
    f = _freeze_api(lead, dv2)
    if f.status_code != 200:
        assert f.status_code == 409, f.text  # refusing the freeze is an acceptable outcome
        return
    split = _split_of_patient(_manifest(dv2))
    leaked = sorted(pid for pid in rel["sealed"] if split.get(pid) in ("train", "val"))
    in_train = sorted(pid for pid in leaked if split[pid] == "train")
    from dermpath.datasets import training_eligible_items
    from dermpath.db import session_scope
    from dermpath.models import DatasetVersion

    with session_scope() as db:
        train_items = training_eligible_items(db, db.get(DatasetVersion, dv2), "train")
    sealed_train_slides = sorted(it["slide_id"] for it in train_items if it["coded_patient_id"] in rel["sealed"])
    assert not leaked, (f"{len(leaked)} of {len(rel['sealed'])} SEALED test patients (released in test release "
                        f"{rel['release']['id']}) were frozen into train/val of a fresh root lineage "
                        f"({len(in_train)} in train; {len(sealed_train_slides)} training slides, e.g. "
                        f"{sealed_train_slides[:3]})")


def test_patients_sealed_in_a_new_lineage_never_reach_train_in_a_child_of_the_original_lineage(
        clients, ids, monkeypatch):
    """Re-split the cohort as a new lineage (documented route), release there (its test patients are sealed), then
    continue the ORIGINAL lineage with a child version: a patient sealed by that release must not be a training
    patient of the child (design §2: sealed patients never change split; freeze verifies it)."""
    install_fakes(monkeypatch)
    lead = clients(LEAD)
    dv1 = cohort(ids)["dataset_version_id"]
    nl = lead.post(f"/api/v1/datasets/{dv1}/new-version",
                   json={"reason": "re-split with another seed", "new_lineage": True,
                         "split": {**COHORT_SPLIT, "seed": 977}})
    assert nl.status_code == 201, nl.text
    dv2 = nl.json()["id"]
    assert _freeze_api(lead, dv2).status_code == 200
    rid2, _, _ = _engine_run(dv_id=dv2, seed=3)
    r = _register_and_release(lead, rid2, "final evaluation on the re-split lineage")
    assert r.status_code == 202, r.text
    sealed = _sealed_patients(dv2)
    assert sealed and set(sealed.values()) == {"test"}
    child = lead.post(f"/api/v1/datasets/{dv1}/new-version", json={"reason": "routine new version"})
    assert child.status_code == 201, child.text
    f = _freeze_api(lead, child.json()["id"])
    if f.status_code != 200:
        assert f.status_code == 409, f.text
        return
    split = _split_of_patient(_manifest(child.json()["id"]))
    in_train = sorted(pid for pid in sealed if split.get(pid) == "train")
    assert not in_train, (f"{len(in_train)} of {len(sealed)} patients sealed by test release "
                          f"{r.json()['test_release']['id']} (lineage of {dv2}) are TRAIN patients of child version "
                          f"{child.json()['id']} of the original lineage, e.g. {in_train[:3]}")


def test_a_sealed_test_slide_never_reaches_train_in_a_child_version_after_a_patient_move(
        clients, ids, monkeypatch):
    """A sealed test slide moved to another (training) patient by a lineage edit must not silently become a
    training item of the next child version (no refusal, no freeze warning)."""
    from dermpath.db import session_scope
    from dermpath.models import Slide

    rel = _released_cohort(clients, ids, monkeypatch)
    m = _manifest(rel["dv"])
    test_slide = sorted(it["slide_id"] for it in m["items"] if it["split"] == "test")[0]
    train_slide = sorted(it["slide_id"] for it in m["items"] if it["split"] == "train")[0]
    with session_scope() as db:
        target_block = db.get(Slide, train_slide).block_id
    r = clients(ASSISTANT).patch(f"/api/v1/slides/{test_slide}",
                                 json={"block_id": target_block, "reason": "lineage correction"})
    assert r.status_code == 200, r.text
    lead = clients(LEAD)
    child = lead.post(f"/api/v1/datasets/{rel['dv']}/new-version", json={"reason": "after a lineage correction"})
    assert child.status_code == 201, child.text
    check = lead.get(f"/api/v1/datasets/{child.json()['id']}/freeze-check").json()
    f = _freeze_api(lead, child.json()["id"])
    if f.status_code != 200:
        assert f.status_code == 409, f.text
        return
    split = {it["slide_id"]: it["split"] for it in _manifest(child.json()["id"])["items"]}
    assert split.get(test_slide) in (None, "test"), (
        f"sealed test slide {test_slide} (scored in test release {rel['release']['id']}) is a "
        f"'{split.get(test_slide)}' item of child version {child.json()['id']}; freeze-check blockers="
        f"{check.get('blockers')} warnings needing acknowledgement={check.get('requires_acknowledgement')}")


# =========================================================================== roles of data (pure, in memory)


DIM = 6


class _RecordingAccess:
    """In-memory access that records every bag read and, around each fit, which bags the fitter read."""

    def __init__(self):
        from dermpath.ml.heads import IN_MEMORY

        self.inner, self.reads = IN_MEMORY, []

    def parts(self, bag):
        self.reads.append(bag.bag_id)
        return self.inner.parts(bag)

    def embeddings(self, bag):
        self.reads.append(bag.bag_id)
        return self.inner.embeddings(bag)

    def mean(self, bag):
        self.reads.append(bag.bag_id)
        return self.inner.mean(bag)


def _items(n_patients: int = 36, *, val_every: int = 4) -> list[dict]:
    """Manifest-like development rows (train/val) with random uuids; several cases per patient, several slides
    per case; labels per patient (so case bags never conflict)."""
    rows = []
    for i in range(n_patients):
        code = f"VP-{i:03d}"
        label = "bcc_present" if i % 3 == 0 else "bcc_absent_not_benign"
        pid = uuid.uuid4().hex
        for c in range(1 + i % 2):
            cid = uuid.uuid4().hex
            for j in range(1 + (i + c) % 2):
                rows.append({"slide_id": uuid.uuid4().hex, "case_id": cid, "coded_patient_id": pid,
                             "patient_code": code, "accession_code": f"VA-{i:03d}-{c}",
                             "slide_sha256": hashlib.sha256(f"{code}|{c}|{j}".encode()).hexdigest(),
                             "label_value": label, "label_version_id": uuid.uuid4().hex,
                             "split": "val" if i % val_every == 0 else "train", "scanner_id": "s", "site_id": "x",
                             "stain": "H&E"})
    return rows


def _bags(items, scope="slide"):
    from dermpath.ml.training import build_bags

    bags = build_bags(items, scope, "bcc_present")
    for b in bags:
        parts = []
        for sha in b.slide_sha256s:
            rng = np.random.default_rng(int(sha[:8], 16))
            e = rng.normal(size=(4 + int(sha[:2], 16) % 5, DIM)).astype(np.float32)
            e[:, 0] += 1.2 * b.label
            parts.append(e)
        b.embeddings = np.concatenate(parts)
        b.slide_index = np.concatenate([np.full(p.shape[0], k) for k, p in enumerate(parts)])
    return bags


def _params(**kw):
    from dermpath.ml.config import resolve_params

    return resolve_params({"max_epochs": 6, "patience": 2, "n_boot": 50, "hidden_dim": 8, "attn_dim": 4, **kw})


def _spy_fits(mp, access):
    """Record, for every fit_head call, the fit bags/patients and the bag ids the fitter READ during the call."""
    from dermpath.ml import training

    fits = []
    real = training.fit_head

    def spy(head, fit_bags, params, seed, progress, *, access, context):
        start = len(access.reads)
        out = real(head, fit_bags, params, seed, progress, access=access, context=context)
        fits.append({"bags": {b.bag_id for b in fit_bags}, "patients": {b.patient_id for b in fit_bags},
                     "read": set(access.reads[start:]), "arrays": out[0], "summary": out[2],
                     "labels": [b.label for b in fit_bags], "fit_list": list(fit_bags)})
        return out

    mp.setattr(training, "fit_head", spy)
    return fits


def _units(bags, pairs):
    parent = {b.patient_id: b.patient_id for b in bags}

    def find(a):
        while parent[a] != a:
            a = parent[a]
        return a

    for a, b in pairs:
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[max(ra, rb)] = min(ra, rb)
    groups = {}
    for p in parent:
        groups.setdefault(find(p), set()).add(p)
    return {p: groups[find(p)] for p in parent}


@pytest.mark.parametrize("scope", ["slide", "case"])
@pytest.mark.parametrize("fraction", [1.0, 0.5])
def test_dev_cv_never_scores_a_patient_or_its_confirmed_duplicate_with_a_model_that_saw_it(scope, fraction):
    """OOF integrity (design §6): every development bag is scored out-of-fold by a model whose fitting data hold
    neither its patient nor any patient joined to it by a confirmed duplicate; each fitter (and its scaler and
    class weights) reads only its fitting bags; learning-curve subsets restrict fitting only; the refit uses the
    development pool."""
    from dermpath.ml.training import run_dev_cv

    bags = _bags(_items(), scope)
    pats = sorted({b.patient_id for b in bags}, key=lambda p: next(b.patient_code for b in bags if b.patient_id == p))
    pairs = [(pats[0], pats[1]), (pats[1], pats[2]), (pats[7], pats[20]), (pats[11], pats[30])]  # cross-class too
    unit = _units(bags, pairs)
    ctx = {"split_salt": "verify-leakage", "patient_label_rule": "any_positive", "duplicate_pairs": pairs}
    access = _RecordingAccess()
    with pytest.MonkeyPatch.context() as mp:
        fits = _spy_fits(mp, access)
        out = run_dev_cv(bags, head="meanpool_logreg", params=_params(cv_folds=5, train_patient_fraction=fraction,
                                                                      **({"subset_repeat": 0} if fraction < 1 else {})),
                         seed=4, access=access, context=ctx)
    assert len(fits) == 5 + 1
    scored = [sb.bag.bag_id for sb in out.dev] + [u["bag_id"] for u in out.unscored]
    assert sorted(scored) == sorted(b.bag_id for b in bags) and len(scored) == len(set(scored))
    for sb in out.dev:
        seen = fits[sb.fold]["patients"]
        assert not (unit[sb.bag.patient_id] & seen), (sb.bag.patient_code, sb.fold)
    allowed = fits[-1]["bags"]
    for f in fits:
        assert f["read"] <= f["bags"], "a fitter read bags it was not given"
        assert f["bags"] <= allowed
        arrays, fb = f["arrays"], f["fit_list"]
        means = np.stack([np.asarray(b.embeddings, dtype=np.float64).mean(axis=0) for b in fb])
        assert np.allclose(arrays["scaler_mean"], means.mean(axis=0)), "scaler not fitted on the fitting bags"
        cw = f["summary"]["class_weights"]["counts"]
        assert cw == {"positive": sum(f["labels"]), "negative": len(f["labels"]) - sum(f["labels"])}
    if fraction == 1.0:
        assert allowed == {b.bag_id for b in bags}


def test_holdout_fitters_never_read_validation_and_abmil_inner_holdout_keeps_duplicate_units_whole():
    from dermpath.ml import heads
    from dermpath.ml.training import run_holdout

    bags = _bags(_items(40), "case")
    train = [b for b in bags if b.split == "train"]
    val = [b for b in bags if b.split == "val"]
    tp = sorted({b.patient_id for b in train}, key=lambda p: next(b.patient_code for b in train if b.patient_id == p))
    pairs = [(tp[0], tp[1]), (tp[2], tp[3]), (tp[3], tp[4]), (tp[9], tp[17])]
    unit = _units(train, pairs)
    ctx = {"split_salt": "verify-leakage", "patient_label_rule": "any_positive", "duplicate_pairs": pairs}
    val_ids = {b.bag_id for b in val}
    for head in ("meanpool_logreg", "abmil"):
        access = _RecordingAccess()
        inner = {}
        real_split = heads.inner_split

        def spy_split(train_bags, params, **kw):
            fit, stop, info = real_split(train_bags, params, **kw)
            inner["fit"], inner["stop"] = {b.patient_id for b in fit}, {b.patient_id for b in stop}
            return fit, stop, info

        with pytest.MonkeyPatch.context() as mp:
            fits = _spy_fits(mp, access)
            mp.setattr(heads, "inner_split", spy_split)
            out = run_holdout(train, val, head=head, params=_params(), seed=3, access=access, context=ctx)
        (f,) = fits
        assert not (f["read"] & val_ids) and f["read"] <= f["bags"] <= {b.bag_id for b in train}
        assert {sb.bag.bag_id for sb in out.dev} == val_ids and out.dev_split == "val"
        if head == "abmil":
            assert inner["stop"] and not (inner["stop"] & inner["fit"])
            for p in inner["stop"]:
                assert unit[p] <= inner["stop"], "a confirmed-duplicate unit spans the inner fit part and hold-out"
            fit_bags = [b for b in train if b.patient_id in inner["fit"]]
            inst = np.concatenate([np.asarray(b.embeddings, dtype=np.float64) for b in fit_bags])
            assert np.allclose(out.arrays["input_mean"], inst.mean(axis=0), atol=1e-5), \
                "ABMIL input normalisation not fitted on the inner fit part only"
            assert f["summary"]["class_weights"]["counts"]["positive"] == sum(b.label for b in fit_bags)
        else:
            means = np.stack([np.asarray(b.embeddings, dtype=np.float64).mean(axis=0) for b in train])
            assert np.allclose(out.arrays["scaler_mean"], means.mean(axis=0))


def test_learning_curve_subsets_never_contain_validation_or_test_patients():
    from dermpath.ml.training import learning_curve_subset

    bags = _bags(_items(40), "slide")
    train = [b for b in bags if b.split == "train"]
    ctx = {"split_salt": "verify-leakage", "patient_label_rule": "any_positive", "duplicate_pairs": []}
    for f in (0.25, 0.5, 0.75):
        for r in (0, 1):
            sub, info = learning_curve_subset(train, _params(train_patient_fraction=f, subset_repeat=r), ctx)
            assert sub and {b.bag_id for b in sub} <= {b.bag_id for b in train}
            assert info["pool_patients"] == len({b.patient_id for b in train})


def test_operating_point_selection_refuses_test_items():
    """Calibration fitted on any test item is refused at the source (defence in depth for §7)."""
    from dermpath.ml.calibration import CalibrationOnTestRefused, fit_calibration

    s = np.linspace(0.05, 0.95, 30)
    y = (np.arange(30) % 2).astype(int)
    with pytest.raises(CalibrationOnTestRefused):
        fit_calibration(s, y, method="platt", item_splits=["val"] * 29 + ["test"])


# =========================================================================== end to end: the train job


def _service_run(ids, *, params: dict, protocol: str, seed: int, head: str = "meanpool_logreg") -> str:
    from dermpath.auth import Actor
    from dermpath.db import session_scope
    from dermpath.ml.service import create_experiment
    from dermpath.models import Project

    with session_scope() as db:
        run, _job = create_experiment(db, Actor(LEAD, "research_lead", "Priya Navarro"), db.get(Project, CID),
                                      dataset_version_id=cohort(ids)["dataset_version_id"], encoder_id=SYNTH,
                                      head=head, params=params, seed=seed, name=None, evaluation_protocol=protocol)
        return run.id


@pytest.mark.parametrize("protocol,head", [("holdout", "abmil"), ("dev_cv", "meanpool_logreg")])
def test_train_job_never_reads_test_features_and_freezes_its_operating_point_from_development_data_only(
        env, ids, monkeypatch, protocol, head):
    """A train job loads pinned features of development slides only (never a test slide), writes no test
    prediction, and its threshold / calibration / abstention are exactly what the stored DEVELOPMENT predictions
    (val for holdout, out-of-fold for dev_cv) give; under dev_cv every out-of-fold row was scored by the fold model
    of its patient's fold."""
    from types import SimpleNamespace

    from dermpath.db import session_scope
    from dermpath.ml import feature_sets as fsm
    from dermpath.ml.models import Prediction, TrainingRun
    from dermpath.ml.training import ScoredBag, select_operating_point

    loaded = []
    real_load = fsm.load_slide_features

    def spy(fs, slide_id):
        loaded.append(slide_id)
        return real_load(fs, slide_id)

    monkeypatch.setattr(fsm, "load_slide_features", spy)
    params = {**FAST, "calibration": "platt", "abstention_target_coverage": 0.8, "min_threshold_evidence": 5,
              "cv_folds": 4, "sampling_seed": 0}
    rid = _service_run(ids, params=params, protocol=protocol, seed=71, head=head)
    out = run_jobs(["train"])
    assert [o.status for o in out] == ["succeeded"], [o.error for o in out]
    m = _manifest(cohort(ids)["dataset_version_id"])
    split_of = {it["slide_id"]: it["split"] for it in m["items"]}
    test_slides = {s for s, sp in split_of.items() if sp == "test"}
    assert loaded and not (set(loaded) & test_slides), sorted(set(loaded) & test_slides)[:5]
    dev_split = "val" if protocol == "holdout" else "oof"
    with session_scope() as db:
        run = db.get(TrainingRun, rid)
        preds = db.scalars(select(Prediction).where(Prediction.run_id == rid)).all()
        rows = sorted([p for p in preds if p.split == dev_split],
                      key=lambda p: (p.patient_code or "", p.bag_id))
        thr, cal, ab = dict(run.threshold_json), dict(run.calibration_json), dict(run.abstention_json)
        cv = (run.metrics_json["protocol"] or {}).get("cv")
        preds_view = [(p.split, p.slide_ids_json, p.coded_patient_id, p.patient_code, dict(p.attributes_json or {}))
                      for p in preds]
        dev = [ScoredBag(SimpleNamespace(label=p.label, patient_id=p.coded_patient_id, bag_id=p.bag_id), p.score)
               for p in rows]
    assert {sp for sp, *_ in preds_view} == {"train", dev_split}
    assert not any(s in test_slides for _, slides, *_ in preds_view for s in slides), "a test slide was scored"
    assert set(thr["selected_on_bag_ids"]) == {sb.bag.bag_id for sb in dev} and thr["selected_on"] == dev_split
    op = select_operating_point(dev, {**params, "threshold_rule": "youden", "target_sensitivity": 0.9},
                                selected_on=dev_split)
    assert op["threshold"]["value"] == thr["value"]
    assert cal["fitted_on"]["n"] == len(dev) and cal["fitted_on"]["splits"] == [dev_split]
    for k in ("slope", "intercept"):
        assert np.isclose(op["calibration"]["params"][k], cal["params"][k], rtol=1e-9, atol=1e-12)
    assert np.isclose(op["abstention"]["lower"], ab["lower"]) and np.isclose(op["abstention"]["upper"], ab["upper"])
    if protocol == "dev_cv":
        fold_of = cv["fold_of_patient_code"]
        for sp, slides, pid, code, attrs in preds_view:
            if sp == "oof":
                assert attrs["fold"] == fold_of[code] and attrs["manifest_split"] in ("train", "val")
        for f in cv["folds_summary"]:
            held = {code for code, k in fold_of.items() if k == f["fold"]}
            assert f["held_out_patients"] == len(held)


# =========================================================================== active learning and stain reference


def _clone_unlabelled_slide(db, src_slide_id: str, tag: str) -> str:
    """A new, unlabelled slide in the same block (same patient) as ``src_slide_id``."""
    from dermpath.models import Slide

    src = db.get(Slide, src_slide_id)
    skip = {"id", "sha256", "object_key", "created_at", "review_state", "review_state_reason", "review_state_by",
            "review_state_at", "thumbnail_key", "thumbnail_phash"}
    cols = {c.name: getattr(src, c.name) for c in Slide.__table__.columns if c.name not in skip}
    new = Slide(**cols, sha256=hashlib.sha256(f"verify-al|{tag}".encode()).hexdigest(),
                object_key=f"{src.object_key}.verify-{tag}", review_state="pending_review")
    db.add(new)
    db.flush()
    return new.id


def test_active_learning_pool_never_holds_test_val_or_sealed_patients(clients, ids, monkeypatch):
    """Design §9: the AL pool is development-eligible slides only; new unlabelled slides of a test, validation or
    sealed (ancestor-lineage) patient are never candidates, a training patient's new slide is."""
    from dermpath.db import session_scope
    from dermpath.ml.active_learning import development_pool
    from dermpath.ml.models import TrainingRun
    from dermpath.models import DatasetVersion

    rel = _released_cohort(clients, ids, monkeypatch)
    lead = clients(LEAD)
    nl = lead.post(f"/api/v1/datasets/{rel['dv']}/new-version",
                   json={"reason": "re-split", "new_lineage": True, "split": {**COHORT_SPLIT, "seed": 977}})
    assert nl.status_code == 201, nl.text
    dv2 = nl.json()["id"]
    assert _freeze_api(lead, dv2).status_code == 200
    rid2, _, _ = _engine_run(dv_id=dv2, seed=5, store_val=False)
    m2 = _manifest(dv2)
    by_split = {}
    for it in sorted(m2["items"], key=lambda r: r["slide_id"]):
        sp = "sealed" if it["coded_patient_id"] in rel["sealed"] else it["split"]
        by_split.setdefault(sp, it)
    assert {"sealed", "val", "train"} <= set(by_split), set(by_split)
    with session_scope() as db:
        new = {sp: _clone_unlabelled_slide(db, it["slide_id"], sp) for sp, it in by_split.items()}
    with session_scope() as db:
        pool, counts = development_pool(db, db.get(TrainingRun, rid2), db.get(DatasetVersion, dv2))
    cand = {c["slide_id"] for c in pool}
    assert new["train"] in cand
    for sp in ("sealed", "val", "test"):
        if sp in new:
            assert new[sp] not in cand, (sp, counts)
    assert all(c["coded_patient_id"] not in rel["sealed"] for c in pool)


def test_macenko_reference_is_planned_on_train_slides_only(ids):
    """The macenko-v1 reference plan (fitted at build) names only TRAIN-split slides of the frozen manifest."""
    from feature_set_support import create_set, get_set, real_cohort

    rc = real_cohort(ids, n=8, project_id="proj-verify-stain", ratios={"train": 0.5, "val": 0.25, "test": 0.25})
    fs_id = create_set(rc["project_id"], encoder_id="handcrafted-stain-texture-v1",
                       execution_mode="supervised_experiment", dataset_version_id=rc["dataset_version_id"],
                       params={"max_patches_per_slide": 4, "stain_normalization": "macenko-v1"})
    fit = get_set(fs_id).stain_policy_json["reference_fit"]
    train = {s for s, sp in rc["split_of"].items() if sp == "train"}
    assert fit["train_slide_ids"] and set(fit["train_slide_ids"]) <= train, (fit["train_slide_ids"], rc["split_of"])
