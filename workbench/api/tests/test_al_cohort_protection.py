"""Evaluation-cohort protection from active-learning selection (owner's brief, item 6; design §9).

Active learning chooses which patients experts look at from MODEL scores (uncertainty, diversity) plus a random
share. A patient chosen that way is "model-selected review" material: it may train later models, but it must
never become clean evaluation material (validation or test), and neither may its linked slides and cases or the
patients a person confirmed as its duplicates. Before this change the pool already excluded validation, test and
sealed patients of the run's own split family, but patients NEW to the family could be proposed and the family
allocator could later put them in val or test (docs/ml-engine-design.md said so: "reported, not prevented").

Each test below is a regression for one defect and fails on the code before the fix:

* a selected, previously unseen patient later entering a new dataset version must land in train (development),
  never val or test, and the manifest must tell the model-selected review cohort apart from the representative
  performance cohort;
* a confirmed duplicate partner of an exposed patient is exposed too (recorded at commit, or confirmed later);
* a proposal committed after freeze-check but before (or during) freeze is still refused at freeze, and a
  freeze that lands between selection and commit makes the commit drop that pick;
* proposals made before this change whose patients are now in val/test (historical conflicts) are reported in
  freeze-check and the audit, past frozen versions are not rewritten, and a new freeze containing them is refused.

All records are fictional; every project is created by the test (the shared database is never touched).
"""

from __future__ import annotations

import hashlib
from datetime import date, timedelta

import pytest
from sqlalchemy import select

from ml_engine_fakes import install_fakes, make_engine_run, run_jobs

POS, NEG = "bcc_present", "bcc_absent_not_benign"
LEAD_ID = "user-research-lead"
SPLITS = ("train", "val", "test")
BLOCKER = "acquisition_exposed_in_evaluation"


# =========================================================================== fixtures (fictional records)


def _actor(kind: str):
    from feature_set_support import actors

    return actors()[kind]


def _project(db, project_id: str):
    from feature_set_support import _project as make

    return make(db, project_id, "active-learning cohort protection (fictional records)")


def _slide(db, project_id: str, block_id: str, code: str, i: int, *, label: str | None):
    from dermpath.labels import create_expert_label
    from dermpath.models import Slide
    from dermpath.review import set_review_state

    s = Slide(project_id=project_id, block_id=block_id, level_index=i + 1, stain="H&E", scanner_id="scanner-a",
              provenance="demo_synthetic", image_kind="synthetic_tiles", object_key=f"alprot/{project_id}/{code}/{i}",
              ingest_status="succeeded",
              sha256=hashlib.sha256(f"alprot|{project_id}|{code}|{i}".encode()).hexdigest())
    db.add(s)
    db.flush()
    if label is not None:
        create_expert_label(db, _actor("pathologist"), s, scope="slide", target_id=None, value=label,
                            reason="cohort-protection fixture label (fictional)")
    set_review_state(db, None, s, "approved", reason=None, system=True)
    return s.id


def _patient(db, project_id: str, code: str, labels: list[str], *, unlabelled: int = 0,
             collected: date | None = date(2026, 1, 15), site: str | None = "site-a") -> dict:
    """A coded patient with one case and block: one approved, expert-labelled slide per label (dataset material)
    and ``unlabelled`` approved slides without a reference label (the active-learning pool). Pipeline-test data
    (demo_synthetic procedural tiles), so a pipeline-test run can propose them without scoring."""
    from dermpath.models import Block, Case, CodedPatient, SpecimenPart

    patient = CodedPatient(project_id=project_id, code=code, created_by="test")
    db.add(patient)
    db.flush()
    case = Case(project_id=project_id, coded_patient_id=patient.id, accession_code=f"A-{code}", collected_on=collected,
                site_id=site, provenance="demo_synthetic")
    db.add(case)
    db.flush()
    part = SpecimenPart(project_id=project_id, case_id=case.id, designation="A")
    db.add(part)
    db.flush()
    block = Block(project_id=project_id, part_id=part.id, designation="A1")
    db.add(block)
    db.flush()
    labelled = [_slide(db, project_id, block.id, code, i, label=v) for i, v in enumerate(labels)]
    pool = [_slide(db, project_id, block.id, code, len(labels) + j, label=None) for j in range(unlabelled)]
    return {"id": patient.id, "code": code, "case_id": case.id, "block_id": block.id, "slides": labelled,
            "unlabelled": pool}


def _label(db, slide_id: str, value: str) -> None:
    from dermpath.labels import create_expert_label
    from dermpath.models import Slide

    create_expert_label(db, _actor("pathologist"), db.get(Slide, slide_id), scope="slide", target_id=None,
                        value=value, reason="expert read of a proposed slide (fictional)")


def _duplicate(db, project_id: str, slide_a: str, slide_b: str) -> None:
    from dermpath.models import NearDuplicateReview

    db.add(NearDuplicateReview(project_id=project_id, slide_a_id=slide_a, slide_b_id=slide_b, decision="duplicate",
                               reason="same tissue re-scanned (fictional)", reviewer_id=LEAD_ID))
    db.flush()


def _config(split: dict) -> dict:
    return {"label_scope": "slide", "eligible_review_states": ["approved"], "label_values": [POS, NEG],
            "split": split}


def _create(lead, project_id: str, name: str, split: dict) -> dict:
    r = lead.post(f"/api/v1/projects/{project_id}/datasets", json={"name": name, "config": _config(split)})
    assert r.status_code == 201, r.text
    return r.json()


def _freeze(lead, dsid: str):
    return lead.post(f"/api/v1/datasets/{dsid}/freeze",
                     json={"reason": "cohort-protection freeze", "acknowledge_warnings": True})


def _manifest(lead, dsid: str) -> dict:
    r = lead.get(f"/api/v1/datasets/{dsid}/manifest")
    assert r.status_code == 200, r.text
    return r.json()["manifest"]


def _by_code(manifest: dict) -> dict[str, str]:
    return {s["patient_code"]: s["split"] for s in manifest["splits"]}


def _draft_splits(dsid: str) -> dict[str, str]:
    from dermpath.datasets import item_rows
    from dermpath.db import session_scope
    from dermpath.models import DatasetVersion

    with session_scope() as db:
        rows = item_rows(db, db.get(DatasetVersion, dsid))
    return {r["patient_code"]: r["split"] for r in rows}


def _new_version(lead, dsid: str, reason: str = "experts read the proposed slides", **extra) -> dict:
    r = lead.post(f"/api/v1/datasets/{dsid}/new-version", json={"reason": reason, **extra})
    assert r.status_code == 201, r.text
    return r.json()


def _registered_run(lead, dsid: str) -> str:
    """A finished pipeline-test run on ``dsid`` with its inference bundle (registered through the API)."""
    from dermpath.db import session_scope
    from dermpath.models import DatasetVersion

    with session_scope() as db:
        run, _ = make_engine_run(db, db.get(DatasetVersion, dsid))
        rid = run.id
    r = lead.post(f"/api/v1/experiments/{rid}/register")
    assert r.status_code < 300, r.text
    return rid


def _request(lead, project_id: str, run_id: str, *, k: int, seed: int = 0) -> dict:
    r = lead.post(f"/api/v1/projects/{project_id}/active-learning",
                  json={"run_id": run_id, "k": k, "random_fraction": 1.0, "seed": seed})
    assert r.status_code == 202, r.text
    return r.json()


def _propose(lead, project_id: str, run_id: str, *, k: int, seed: int = 0) -> dict:
    """Request a batch through the API and run the worker job; returns the stored batch."""
    req = _request(lead, project_id, run_id, k=k, seed=seed)
    out = run_jobs(["active_learning"])
    assert [o.status for o in out] == ["succeeded"], [o.error for o in out]
    batch = lead.get(f"/api/v1/active-learning/batches/{req['batch_id']}").json()
    assert batch["status"] == "succeeded", batch
    return {**batch, "request": req}


def _blocker(check: dict, code: str = BLOCKER) -> dict | None:
    return next((b for b in check["blockers"] if b["code"] == code), None)


def _base_cohort(db, project_id: str, prefix: str, n: int = 20) -> dict:
    return {f"{prefix}-{i:03d}": _patient(db, project_id, f"{prefix}-{i:03d}", [POS if i % 4 == 0 else NEG])
            for i in range(n)}


# =========================================================================== 1. unseen selected patient


def test_selected_unseen_patient_entering_a_later_version_lands_in_train_never_val_or_test(clients, monkeypatch):
    """v1 (20 labelled patients) is frozen and a run on it proposes six patients nobody has seen (new to the split
    family; only unlabelled slides). Experts read the proposed slides, and v2 includes the six patients. Before the
    fix the family allocator treated them like any new patient: two of the six went to val. They are model-selected
    material: every one must be train, the diagnostics and the manifest must say why, and the exposure (patient,
    linked slides and case, proposal, run, bundle, kind model_selected) must be persisted with the proposals."""
    install_fakes(monkeypatch)
    from dermpath.db import session_scope

    pid = "proj-alprot-unseen"
    with session_scope() as db:
        _project(db, pid)
        _base_cohort(db, pid, "AU")
        unseen = {f"AN-{i:02d}": _patient(db, pid, f"AN-{i:02d}", [], unlabelled=1) for i in range(6)}
    lead = clients(LEAD_ID)
    v1 = _create(lead, pid, "v1", {"partition": "random", "seed": 0})
    assert _freeze(lead, v1["id"]).status_code == 200
    rid = _registered_run(lead, v1["id"])
    batch = _propose(lead, pid, rid, k=6)
    assert sorted(i["coded_patient_id"] for i in batch["items"]) == sorted(p["id"] for p in unseen.values())
    assert all(i["components"]["family_split"] == "new_to_family" for i in batch["items"])
    with session_scope() as db:
        for n, p in enumerate(unseen.values()):
            _label(db, p["unlabelled"][0], POS if n % 2 == 0 else NEG)
    v2 = _new_version(lead, v1["id"])
    draft = _draft_splits(v2["id"])
    assert {c: draft[c] for c in unseen} == {c: "train" for c in unseen}, \
        "model-selected patients must be allocated to train (development), never val or test"

    diag = v2["config"]["split_diagnostics"]["development_only"]
    assert sorted(diag["pinned_to_train"]) == sorted(unseen) and diag["held_in_evaluation"] == []
    check = lead.get(f"/api/v1/datasets/{v2['id']}/freeze-check").json()
    assert _blocker(check) is None and check["acquisition_exposure"]["in_evaluation"] == []
    r = _freeze(lead, v2["id"])
    assert r.status_code == 200, r.text
    m2 = _manifest(lead, v2["id"])
    assert {c: _by_code(m2)[c] for c in unseen} == {c: "train" for c in unseen}
    cohorts = m2["evaluation_cohorts"]
    review = cohorts["model_selected_review_cohort"]
    assert sorted(review["patient_codes"]) == sorted(unseen) and review["patients_per_split"] == {
        "train": 6, "val": 0, "test": 0}
    perf = cohorts["representative_performance_cohort"]
    assert perf["splits"] == ["val", "test"] and perf["model_selected_patients"] == 0
    assert perf["patients"] == sum(1 for s in _by_code(m2).values() if s in ("val", "test"))
    assert m2["audit"]["acquisition_exposure"]["ok"] is True

    from dermpath.ml.engine_models import ALProposal
    from dermpath.models import AcquisitionExposure, SplitFamilyAssignment

    with session_scope() as db:
        props = {p.id: p for p in db.scalars(select(ALProposal).where(ALProposal.batch_id == batch["batch_id"]))}
        rows = db.scalars(select(AcquisitionExposure).where(AcquisitionExposure.project_id == pid)).all()
        assert len(rows) == 6 and {r.proposal_id for r in rows} == set(props)
        for r in rows:
            p = props[r.proposal_id]
            assert (r.kind, r.relation) == ("model_selected", "selected")
            assert r.coded_patient_id == r.selected_patient_id == p.coded_patient_id
            assert (r.run_id, r.bundle_id, r.batch_id) == (rid, batch["bundle_id"], batch["batch_id"])
            assert r.dataset_version_id == v1["id"] and r.proposed_slide_id == p.slide_id
            patient = next(u for u in unseen.values() if u["id"] == r.coded_patient_id)
            assert r.slide_ids_json == sorted(patient["slides"] + patient["unlabelled"])
            assert r.case_ids_json == [patient["case_id"]] and r.created_at is not None
        fam = {a.patient_code: a.split for a in db.scalars(
            select(SplitFamilyAssignment).where(SplitFamilyAssignment.family_id == m2["split_family_id"]))}
        assert {c: fam[c] for c in unseen} == {c: "train" for c in unseen}


# =========================================================================== 2. duplicate partners


def test_confirmed_duplicate_partner_of_an_exposed_patient_never_becomes_evaluation_material(clients, monkeypatch):
    """Six unseen patients AS-0..5 are proposed. Their re-scanned tissue also exists under other patients AP-0..5
    (a person confirmed each pair ``duplicate``): AP-0..2 before the proposal, AP-3..5 after it. AP-* are labelled
    and new to the family, so v2 allocates them. Before the fix nothing tied them to the proposal and two went to
    val. A partner is the same material: all six must be train. The partners known at commit are persisted with
    the exposure; later confirmations are honoured from the current decisions. A seventh unseen patient whose slide
    duplicates a VALIDATION patient's slide is never proposed (selecting it would contaminate that patient)."""
    install_fakes(monkeypatch)
    from dermpath.db import session_scope

    pid = "proj-alprot-dup"
    with session_scope() as db:
        _project(db, pid)
        _base_cohort(db, pid, "DB")
    lead = clients(LEAD_ID)
    v1 = _create(lead, pid, "v1", {"partition": "random", "seed": 0})
    assert _freeze(lead, v1["id"]).status_code == 200
    m1 = _manifest(lead, v1["id"])
    val_item = next(it for it in sorted(m1["items"], key=lambda r: r["slide_id"]) if it["split"] == "val")
    with session_scope() as db:
        selected = {f"AS-{i}": _patient(db, pid, f"AS-{i}", [], unlabelled=1) for i in range(6)}
        partners = {f"AP-{i}": _patient(db, pid, f"AP-{i}", [POS if i % 2 == 0 else NEG]) for i in range(6)}
        for i in range(3):
            _duplicate(db, pid, selected[f"AS-{i}"]["unlabelled"][0], partners[f"AP-{i}"]["slides"][0])
        val_dup = _patient(db, pid, "AS-VALDUP", [], unlabelled=1)
        _duplicate(db, pid, val_dup["unlabelled"][0], val_item["slide_id"])
    rid = _registered_run(lead, v1["id"])
    req = _request(lead, pid, rid, k=10)
    assert req["pool_size"] == 6 and req["pool_exclusions"]["duplicate_of_evaluation_patient"] == 1
    run_jobs(["active_learning"])
    batch = lead.get(f"/api/v1/active-learning/batches/{req['batch_id']}").json()
    assert sorted(i["coded_patient_id"] for i in batch["items"]) == sorted(p["id"] for p in selected.values())
    with session_scope() as db:
        for i in range(3, 6):
            _duplicate(db, pid, partners[f"AP-{i}"]["slides"][0], selected[f"AS-{i}"]["unlabelled"][0])
    v2 = _new_version(lead, v1["id"], reason="duplicate partners arrive")
    draft = _draft_splits(v2["id"])
    assert {c: draft[c] for c in partners} == {c: "train" for c in partners}, \
        "confirmed duplicate partners of a model-selected patient must be train"
    assert _freeze(lead, v2["id"]).status_code == 200
    assert {c: _by_code(_manifest(lead, v2["id"]))[c] for c in partners} == {c: "train" for c in partners}

    from dermpath.datasets import acquisition_exposure
    from dermpath.models import AcquisitionExposure

    with session_scope() as db:
        rows = db.scalars(select(AcquisitionExposure).where(AcquisitionExposure.project_id == pid)).all()
        recorded = {(r.patient_code, r.relation) for r in rows}
        assert recorded == ({(c, "selected") for c in selected} | {(f"AP-{i}", "duplicate_partner") for i in range(3)})
        for r in rows:
            if r.relation == "duplicate_partner":
                sel = next(s for s in selected.values() if s["id"] == r.selected_patient_id)
                assert sel["code"][-1] == r.patient_code[-1] and r.duplicate_links_json
        exposed = acquisition_exposure(db, pid)["patients"]
        assert {exposed[p["id"]]["patient_code"] for p in partners.values()} == set(partners)
        assert "duplicate_partner_now" in exposed[partners["AP-4"]["id"]]["sources"]
        assert val_dup["id"] not in exposed and val_item["coded_patient_id"] not in exposed


# =========================================================================== 3. proposal vs freeze interleavings


def _interleaving_setup(clients, pid: str):
    """v1 frozen (20 patients), a registered run on it, six new labelled patients, and a v2 draft. Returns the
    lead client, ids, and one new patient X that v2 allocated to val or test; X gets an unlabelled second slide
    after the draft (the only slide in the active-learning pool; the draft's items do not change)."""
    from dermpath.db import session_scope

    with session_scope() as db:
        _project(db, pid)
        _base_cohort(db, pid, "IB")
    lead = clients(LEAD_ID)
    v1 = _create(lead, pid, "v1", {"partition": "random", "seed": 0})
    assert _freeze(lead, v1["id"]).status_code == 200
    rid = _registered_run(lead, v1["id"])
    with session_scope() as db:
        new = {f"IX-{i}": _patient(db, pid, f"IX-{i}", [POS if i % 2 == 0 else NEG]) for i in range(6)}
    v2 = _new_version(lead, v1["id"], reason="six new patients")
    draft = _draft_splits(v2["id"])
    code = next(c for c in sorted(new) if draft[c] in ("val", "test"))
    x = new[code]
    with session_scope() as db:
        x["unlabelled"] = [_slide(db, pid, x["block_id"], code, 9, label=None)]
    return lead, v1, v2, rid, x, draft[code]


def test_proposal_committed_after_freeze_check_but_before_freeze_is_refused_at_freeze(clients, monkeypatch):
    install_fakes(monkeypatch)
    lead, v1, v2, rid, x, split = _interleaving_setup(clients, "proj-alprot-seq")
    check = lead.get(f"/api/v1/datasets/{v2['id']}/freeze-check").json()
    assert _blocker(check) is None and check["blockers"] == []
    batch = _propose(lead, "proj-alprot-seq", rid, k=1)  # commits after the check, before the freeze
    assert [i["slide_id"] for i in batch["items"]] == x["unlabelled"]
    r = _freeze(lead, v2["id"])
    assert r.status_code == 409, r.text
    err = r.json()["error"]
    assert err["code"] == BLOCKER, err
    (p,) = err["details"]["patients"]
    assert (p["patient_code"], p["split"], p["held_by"], p["historical_conflict"]) == (x["code"], split,
                                                                                        "draft_allocation", False)
    assert "refresh" in p["resolution"]
    check = lead.get(f"/api/v1/datasets/{v2['id']}/freeze-check").json()
    assert _blocker(check) is not None
    # The resolution works: the refreshed draft pins X to train and freezes.
    assert lead.post(f"/api/v1/datasets/{v2['id']}/refresh").status_code == 200
    assert _draft_splits(v2["id"])[x["code"]] == "train"
    r = _freeze(lead, v2["id"])
    assert r.status_code == 200, r.text
    assert _by_code(_manifest(lead, v2["id"]))[x["code"]] == "train"


def test_proposal_committed_while_a_freeze_is_in_flight_is_caught_by_the_write_locked_final_check(clients,
                                                                                                  monkeypatch):
    """The freeze re-plans (reads only), then a worker commits a proposal for X, then the freeze writes. The final
    exposure check runs inside the freeze's write transaction, so it sees the proposal and refuses; nothing of the
    freeze is kept."""
    install_fakes(monkeypatch)
    from dermpath import datasets as ds
    from dermpath.db import session_scope
    from dermpath.ml import active_learning
    from dermpath.ml.models import TrainingRun
    from dermpath.models import DatasetVersion

    pid = "proj-alprot-inflight"
    lead, v1, v2, rid, x, _split = _interleaving_setup(clients, pid)
    original = ds._draft_state_with_plan
    fired = []

    def interleaved(db, dv):
        out = original(db, dv)
        if not fired:
            fired.append(True)
            with session_scope() as other:
                active_learning.request_batch(other, _actor("lead"), other.get(TrainingRun, rid),
                                              other.get(DatasetVersion, v1["id"]), k=1, random_fraction=1.0)
            done = run_jobs(["active_learning"])
            assert [o.status for o in done] == ["succeeded"], [o.error for o in done]
        return out

    checks = []
    original_check = ds._acquisition_freeze_check

    def spy(db, dv, *args, **kwargs):
        when = "after_replan" if fired else "before_replan"
        try:
            original_check(db, dv, *args, **kwargs)
        except ds.ApiError:
            checks.append(f"refused_{when}")
            raise
        checks.append(f"passed_{when}")

    monkeypatch.setattr(ds, "_draft_state_with_plan", interleaved)
    monkeypatch.setattr(ds, "_acquisition_freeze_check", spy)
    r = _freeze(lead, v2["id"])
    assert fired, "the interleaving hook did not run"
    assert r.status_code == 409 and r.json()["error"]["code"] == BLOCKER, r.text
    (p,) = r.json()["error"]["details"]["patients"]
    assert (p["patient_code"], p["held_by"]) == (x["code"], "draft_allocation") and "refresh" in p["resolution"]
    # The early check could not see the proposal; the final check, inside the freeze's write transaction, did.
    assert checks == ["passed_before_replan", "refused_after_replan"], checks
    with session_scope() as db:
        dv = db.get(DatasetVersion, v2["id"])
        assert dv.status == "draft" and dv.manifest_json is None
        assert x["id"] in ds.acquisition_exposure(db, pid)["patients"]


def test_freeze_landing_between_selection_and_commit_makes_the_commit_drop_the_pick(clients, monkeypatch):
    """The other order: the batch picks X while X is only in a draft, then v2 is frozen (X becomes a family val/test
    patient), then the batch commits. The commit re-checks under the write lock and drops X instead of exposing an
    evaluation patient; the frozen v2 stays clean."""
    install_fakes(monkeypatch)
    from dermpath import datasets as ds
    from dermpath.db import session_scope
    from dermpath.ml import active_learning
    from dermpath.ml.engine_models import ALProposal
    from dermpath.models import DatasetVersion

    pid = "proj-alprot-reverse"
    lead, v1, v2, rid, x, split = _interleaving_setup(clients, pid)
    original = active_learning.select_batch

    def select_then_freeze(*args, **kwargs):
        out = original(*args, **kwargs)
        with session_scope() as other:
            ds.freeze(other, _actor("lead"), other.get(DatasetVersion, v2["id"]), reason="concurrent freeze",
                      acknowledge_warnings=True)
        return out

    monkeypatch.setattr(active_learning, "select_batch", select_then_freeze)
    req = _request(lead, pid, rid, k=1)
    assert req["pool_size"] == 1
    out = run_jobs(["active_learning"])
    assert [o.status for o in out] == ["succeeded"], [o.error for o in out]
    batch = lead.get(f"/api/v1/active-learning/batches/{req['batch_id']}").json()
    assert batch["items"] == [], "a patient frozen into val/test meanwhile must not be proposed"
    dropped = batch["result"]["dropped_at_commit"]
    assert [(d["slide_id"], d["reason"]) for d in dropped] == [(x["unlabelled"][0], "evaluation_patient")]
    with session_scope() as db:
        assert db.scalars(select(ALProposal.id).where(ALProposal.batch_id == req["batch_id"])).first() is None
        assert x["id"] not in ds.acquisition_exposure(db, pid)["patients"]
    assert _by_code(_manifest(lead, v2["id"]))[x["code"]] == split


# =========================================================================== 4. historical conflicts


def test_historical_proposal_conflicts_are_reported_never_rewritten_and_block_new_evaluation_freezes(clients,
                                                                                                    monkeypatch):
    """Proposals committed before this change have no exposure row, and the old allocator could have put their
    patients in val or test. Such a legacy ``al_proposal`` row for a val patient H and a test patient T (T then
    sealed by a test release) must be: reported by the audit of the frozen v1 (whose manifest and splits stay
    exactly as frozen), listed project-wide, and refused (409) at the freeze of a child version that still holds
    them in val/test, with a resolution per patient: a new lineage pins H to train; T stays sealed in test, so it
    must be excluded."""
    install_fakes(monkeypatch)
    from dermpath.datasets import seal_test_patients
    from dermpath.db import session_scope, utcnow
    from dermpath.ml.engine_models import ALProposal
    from dermpath.models import DatasetVersion

    pid = "proj-alprot-history"
    with session_scope() as db:
        _project(db, pid)
        _base_cohort(db, pid, "HB")
    lead = clients(LEAD_ID)
    v1 = _create(lead, pid, "v1", {"partition": "random", "seed": 0})
    assert _freeze(lead, v1["id"]).status_code == 200
    m1 = _manifest(lead, v1["id"])
    sha1 = lead.get(f"/api/v1/datasets/{v1['id']}/manifest").json()["manifest_sha256"]
    items = sorted(m1["items"], key=lambda r: r["slide_id"])
    h = next(it for it in items if it["split"] == "val")
    t = next(it for it in items if it["split"] == "test")
    with session_scope() as db:
        for n, it in enumerate((h, t)):  # what the pre-change code wrote: a proposal and nothing else
            db.add(ALProposal(project_id=pid, batch_id=f"legacybatch{n}", slide_id=it["slide_id"],
                              coded_patient_id=it["coded_patient_id"], proposal_rank=1, strategy="uncertainty",
                              components_json={"family_split": "new_to_family"}, seed=0, created_by="system:worker",
                              created_at=utcnow() - timedelta(days=30)))
        seal_test_patients(db, db.get(DatasetVersion, v1["id"]), "test release 1 (fictional)", actor=_actor("lead"))

    audit_v1 = lead.get(f"/api/v1/datasets/{v1['id']}/audit").json()["acquisition_exposure"]
    conflicts = {c["patient_code"]: c for c in audit_v1["historical_conflicts"]}
    assert set(conflicts) == {h["patient_code"], t["patient_code"]}, audit_v1
    assert conflicts[h["patient_code"]]["split"] == "val" and conflicts[t["patient_code"]]["split"] == "test"
    assert all(c["sources"] == ["legacy_al_proposal"] for c in conflicts.values())
    assert audit_v1["ok"] is False and audit_v1["frozen_version_rewritten"] is False
    m1_again = lead.get(f"/api/v1/datasets/{v1['id']}/manifest").json()
    assert m1_again["manifest_sha256"] == sha1 and m1_again["verified"] is True
    assert _by_code(m1_again["manifest"]) == _by_code(m1)

    listed = lead.get(f"/api/v1/projects/{pid}/acquisition-exposure").json()
    assert listed["legacy_proposals"] == 2 and listed["creates_labels"] is False
    per_version = {c["dataset_version_id"]: c for c in listed["historical_conflicts"]}
    assert {c["patient_code"] for c in per_version[v1["id"]]["patients"]} == {h["patient_code"], t["patient_code"]}

    v2 = _new_version(lead, v1["id"], reason="child version after the legacy proposals")
    check = lead.get(f"/api/v1/datasets/{v2['id']}/freeze-check").json()
    blocker = _blocker(check)
    assert blocker is not None, check["blockers"]
    held = {p["patient_code"]: p for p in blocker["patients"]}
    assert (held[h["patient_code"]]["held_by"], held[h["patient_code"]]["historical_conflict"]) == ("split_family",
                                                                                                    True)
    assert (held[t["patient_code"]]["held_by"], held[t["patient_code"]]["historical_conflict"]) == ("sealed", True)
    assert "new lineage" in held[h["patient_code"]]["resolution"]
    assert "exclude" in held[t["patient_code"]]["resolution"]
    r = _freeze(lead, v2["id"])
    assert r.status_code == 409 and r.json()["error"]["code"] == BLOCKER, r.text

    nl = _new_version(lead, v1["id"], reason="separate study without the model-selected patients", new_lineage=True,
                      split={"partition": "random", "seed": 5})
    splits = _draft_splits(nl["id"])
    assert splits[h["patient_code"]] == "train" and splits[t["patient_code"]] == "test"  # sealed never moves
    check = lead.get(f"/api/v1/datasets/{nl['id']}/freeze-check").json()
    assert [p["patient_code"] for p in _blocker(check)["patients"]] == [t["patient_code"]]


# =========================================================================== 5. allocator (pure)


def _pts(n: int, n_pos: int, tag: str) -> list[dict]:
    return [{"id": f"{tag}{i:03d}", "code": f"{tag.upper()}-{i:03d}", "label": POS if i < n_pos else NEG}
            for i in range(n)]


def test_allocator_development_only_pins_new_units_to_train_and_reports_held_ones():
    from dermpath.splits import allocate

    pts = _pts(100, 10, "p")
    split = {"partition": "random", "seed": 0}
    base, d0 = allocate(pts, split, salt="s")
    same, d1 = allocate(pts, split, salt="s", development_only=())
    assert same == base and {k: v for k, v in d1.items() if k != "development_only"} == d0  # nothing else changes
    per = d0["per_split_class"]
    assert {s: per[s][POS]["patients"] for s in SPLITS} == {"train": 6, "val": 2, "test": 2}

    evaluation = sorted(p for p, s in base.items() if s != "train")
    exposed = evaluation[:5]
    pinned, diag = allocate(pts, split, salt="s", development_only=exposed)
    assert all(pinned[p] == "train" for p in exposed)
    assert sorted(diag["development_only"]["pinned_to_train"]) == sorted(
        next(x["code"] for x in pts if x["id"] == p) for p in exposed)
    assert diag["patients_per_split"] == d0["patients_per_split"]  # targets still met by the others

    # A duplicate unit with one exposed member moves whole; inherited (and sealed) splits are kept and reported.
    a, b = evaluation[0], evaluation[1]
    held_p = evaluation[2]
    mapping, diag = allocate(pts, split, salt="s", existing={held_p: base[held_p]}, groups=[(a, b)],
                             development_only=[a, held_p])
    assert mapping[a] == mapping[b] == "train" and mapping[held_p] == base[held_p]
    held = diag["development_only"]["held_in_evaluation"]
    assert held == [{"patient_code": next(x["code"] for x in pts if x["id"] == held_p), "split": base[held_p]}]

    # Temporal: an exposed patient after the cutoff is still train (development) and is named against the rule.
    tp = [{"id": f"t{i}", "code": f"T-{i}", "label": NEG if i % 3 else POS,
           "dates": [date(2025, 1, 1) + timedelta(days=40 * i)]} for i in range(12)]
    tsplit = {"partition": "temporal", "test_cutoff": "2025-10-01", "val_cutoff": "2025-07-01"}
    late = [p["id"] for p in tp if p["dates"][0] >= date(2025, 10, 1)][0]
    m, diag = allocate(tp, tsplit, development_only=[late])
    assert m[late] == "train" and next(p["code"] for p in tp if p["id"] == late) in diag["against_rule"]


# =========================================================================== 6. pool keeps evaluation reserved


def test_pool_never_proposes_evaluation_patients_of_any_lineage_or_patients_reserved_by_a_label_free_rule(
        clients, monkeypatch):
    """The randomly assembled evaluation cohort stays outside acquisition: a val/test patient of ANOTHER lineage of
    the project is never proposed (before the fix only the run's own family was checked). Under a temporal
    partition, a new patient whose latest case is past the validation cutoff is evaluation material by a
    label-free rule; proposing it would force future material into training, so it is not proposed either."""
    install_fakes(monkeypatch)
    from dermpath.db import session_scope

    pid = "proj-alprot-pool"
    with session_scope() as db:
        _project(db, pid)
        base = {f"PB-{i:03d}": _patient(db, pid, f"PB-{i:03d}", [POS if i % 4 == 0 else NEG], unlabelled=1,
                                        collected=date(2025, 1, 1) + timedelta(days=15 * i)) for i in range(20)}
    lead = clients(LEAD_ID)
    a = _create(lead, pid, "lineage A", {"partition": "random", "seed": 0})
    b = _create(lead, pid, "lineage B", {"partition": "random", "seed": 7})
    assert _freeze(lead, a["id"]).status_code == 200 and _freeze(lead, b["id"]).status_code == 200
    sa, sb = _by_code(_manifest(lead, a["id"])), _by_code(_manifest(lead, b["id"]))
    train_a_eval_b = sorted(c for c in base if sa[c] == "train" and sb[c] != "train")
    train_both = sorted(c for c in base if sa[c] == "train" and sb[c] == "train")
    assert train_a_eval_b and train_both
    rid = _registered_run(lead, a["id"])
    req = _request(lead, pid, rid, k=50)
    # Exclusions count slides: each of these patients has a labelled and an unlabelled slide.
    assert req["pool_exclusions"]["evaluation_patient_other_lineage"] == 2 * len(train_a_eval_b)
    assert req["pool_size"] == len(train_both)

    tpid = "proj-alprot-temporal"
    with session_scope() as db:
        _project(db, tpid)
        for i in range(12):
            _patient(db, tpid, f"TB-{i:03d}", [POS if i % 3 == 0 else NEG], collected=date(2025, 1, 10) + timedelta(
                days=20 * i))
        early = _patient(db, tpid, "TN-EARLY", [], unlabelled=1, collected=date(2025, 2, 1))
        late = _patient(db, tpid, "TN-LATE", [], unlabelled=1, collected=date(2025, 12, 1))
    t1 = _create(lead, tpid, "temporal v1", {"partition": "temporal", "test_cutoff": "2025-06-01",
                                             "val_cutoff": "2025-04-01"})
    assert _freeze(lead, t1["id"]).status_code == 200
    trid = _registered_run(lead, t1["id"])
    req = _request(lead, tpid, trid, k=5)
    assert req["pool_size"] == 1 and req["pool_exclusions"]["evaluation_reserved_by_rule"] == 1
    run_jobs(["active_learning"])
    batch = lead.get(f"/api/v1/active-learning/batches/{req['batch_id']}").json()
    assert [i["coded_patient_id"] for i in batch["items"]] == [early["id"]]
    from dermpath.datasets import evaluation_reservation
    from dermpath.models import DatasetVersion

    with session_scope() as db:
        res = evaluation_reservation(db, db.get(DatasetVersion, t1["id"]), late["id"])
        assert res["reserved_for_evaluation"] is True and res["rule"] == "temporal"
        assert evaluation_reservation(db, db.get(DatasetVersion, t1["id"]),
                                       early["id"])["reserved_for_evaluation"] is False


# =========================================================================== 7. the exposure record is immutable


def test_acquisition_exposure_rows_are_append_only(tmp_path):
    from sqlalchemy import create_engine, text, update
    from sqlalchemy.exc import DatabaseError
    from sqlalchemy.orm import sessionmaker

    from dermpath.db import Base, import_all_models
    from dermpath.models import AcquisitionExposure, ImmutableRecordError

    import_all_models()
    engine = create_engine(f"sqlite:///{tmp_path / 'exposure.db'}")
    Base.metadata.create_all(engine)
    db = sessionmaker(bind=engine, expire_on_commit=False)()
    row = AcquisitionExposure(project_id="p", coded_patient_id="pt", patient_code="X-1", kind="model_selected",
                              relation="selected", selected_patient_id="pt", proposal_id="prop", batch_id="b",
                              proposed_slide_id="s", slide_ids_json=["s"], case_ids_json=["c"],
                              duplicate_links_json=[], created_by="system:worker")
    db.add(row)
    db.commit()
    row.relation = "duplicate_partner"
    with pytest.raises(ImmutableRecordError):
        db.flush()
    db.rollback()
    db.delete(row)
    with pytest.raises(ImmutableRecordError):
        db.flush()
    db.rollback()
    with pytest.raises(ImmutableRecordError):
        db.execute(update(AcquisitionExposure).values(kind="x"))
    db.rollback()
    with engine.begin() as conn, pytest.raises(DatabaseError, match="append-only"):
        conn.execute(text("UPDATE acquisition_exposure SET relation = 'x'"))
    with engine.begin() as conn, pytest.raises(DatabaseError, match="append-only"):
        conn.execute(text("DELETE FROM acquisition_exposure"))
    with engine.begin() as conn, pytest.raises(DatabaseError):
        conn.execute(text("INSERT INTO acquisition_exposure (id, project_id, coded_patient_id, patient_code, kind, "
                          "relation, selected_patient_id, proposal_id, batch_id, proposed_slide_id, slide_ids_json, "
                          "case_ids_json, duplicate_links_json, created_by, created_at) VALUES ('i2', 'p', 'pt', "
                          "'X-1', 'random_guess', 'selected', 'pt', 'prop2', 'b', 's', '[]', '[]', '[]', 'w', "
                          "'2026-01-01')"))
    db.close()
    engine.dispose()


# =========================================================================== 8. review priorities say which cohort


def test_review_priorities_flag_model_selected_patients_and_validation_relabels(clients, monkeypatch):
    """The review-priority queue is model-selected review too. An item of a patient active learning chose is flagged
    ``acquisition_exposed`` (development material only), and an item whose discordance is on the VALIDATION split is
    flagged ``evaluation_patient`` with the reason to adjudicate blind (a model-prompted relabel of an evaluation
    patient biases validation metrics toward the model). Before the fix neither was said."""
    install_fakes(monkeypatch)
    from dermpath.db import session_scope
    from dermpath.ml.models import Prediction
    from dermpath.models import Disagreement

    pid = "proj-alprot-review"
    with session_scope() as db:
        _project(db, pid)
        _base_cohort(db, pid, "RB")
        unseen = _patient(db, pid, "RN-01", [], unlabelled=1)
    lead = clients(LEAD_ID)
    v1 = _create(lead, pid, "v1", {"partition": "random", "seed": 0})
    assert _freeze(lead, v1["id"]).status_code == 200
    rid = _registered_run(lead, v1["id"])
    batch = _propose(lead, pid, rid, k=1)
    assert [i["coded_patient_id"] for i in batch["items"]] == [unseen["id"]]
    m1 = _manifest(lead, v1["id"])
    val_item = next(it for it in sorted(m1["items"], key=lambda r: r["slide_id"]) if it["split"] == "val")
    with session_scope() as db:
        sid = unseen["unlabelled"][0]
        db.add(Disagreement(project_id=pid, scope="slide", target_id=sid, slide_id=sid, label_version_ids_json=[],
                            values_json=[NEG, POS], status="open"))
        label = 1 if val_item["label_value"] == POS else 0
        db.add(Prediction(run_id=rid, project_id=pid, split="val", bag_kind="slide", bag_id="manual-discordance",
                          slide_ids_json=[val_item["slide_id"]], case_id=val_item["case_id"],
                          coded_patient_id=val_item["coded_patient_id"], patient_code=val_item["patient_code"],
                          label_value=val_item["label_value"], label_version_ids_json=[], label=label,
                          score=0.02 if label else 0.98, threshold=0.5, predicted=0 if label else 1, abstained=False,
                          attributes_json={}, feature_artifact_ids_json=[]))
    body = clients("user-director").get(f"/api/v1/projects/{pid}/review-priorities?run_id={rid}").json()
    by_target = {i["target"]["target_id"]: i for i in body["items"]}
    exposed_item = by_target[unseen["unlabelled"][0]]
    assert exposed_item["acquisition_exposed"] is True
    assert any("active learning" in r for r in exposed_item["reasons"])
    val_entry = by_target[val_item["slide_id"]]
    assert val_entry["evaluation_patient"] is True and val_entry["acquisition_exposed"] is False
    assert any(r.startswith("validation patient") and "blind" in r for r in val_entry["reasons"])
    assert all(i["evaluation_patient"] == any(d["split"] == "val" for d in i["model_discordances"])
               for i in body["items"])
    assert "model-selected review" in body["cohort_note"] and body["resolves_automatically"] is False


# =========================================================================== 9. linked slides and cases follow the material


def test_proposed_slide_or_case_moved_to_another_patient_keeps_that_patient_out_of_evaluation(clients, monkeypatch):
    """Exposure follows the material. Six unseen patients are proposed; afterwards a lineage correction moves three
    proposed SLIDES (block reassignment) and three proposed CASES (case reassignment) to six other, labelled
    patients W-0..5 that are new to the family. Those patients now own model-selected material: v2 must put all of
    them in train (before the fix two went to val), and the exposure names the reason."""
    install_fakes(monkeypatch)
    from dermpath.db import session_scope
    from dermpath.models import Case, Slide

    pid = "proj-alprot-moved"
    with session_scope() as db:
        _project(db, pid)
        _base_cohort(db, pid, "MB")
        unseen = {f"MU-{i}": _patient(db, pid, f"MU-{i}", [], unlabelled=1) for i in range(6)}
    lead = clients(LEAD_ID)
    v1 = _create(lead, pid, "v1", {"partition": "random", "seed": 0})
    assert _freeze(lead, v1["id"]).status_code == 200
    rid = _registered_run(lead, v1["id"])
    batch = _propose(lead, pid, rid, k=6)
    assert len(batch["items"]) == 6
    with session_scope() as db:
        owners = {f"MW-{i}": _patient(db, pid, f"MW-{i}", [POS if i % 2 == 0 else NEG]) for i in range(6)}
        for i in range(3):  # slide moved into W's block
            db.get(Slide, unseen[f"MU-{i}"]["unlabelled"][0]).block_id = owners[f"MW-{i}"]["block_id"]
        for i in range(3, 6):  # the whole proposed case reassigned to W
            db.get(Case, unseen[f"MU-{i}"]["case_id"]).coded_patient_id = owners[f"MW-{i}"]["id"]
    v2 = _new_version(lead, v1["id"], reason="lineage corrections")
    draft = _draft_splits(v2["id"])
    assert {c: draft[c] for c in owners} == {c: "train" for c in owners}, \
        "patients that now own proposed (model-selected) slides or cases must be train"
    from dermpath.datasets import acquisition_exposure

    with session_scope() as db:
        exposed = acquisition_exposure(db, pid)["patients"]
        for i in range(6):
            sources = exposed[owners[f"MW-{i}"]["id"]]["sources"]
            assert ("exposed_slide_now_belongs_to_patient" in sources) or (
                "exposed_case_now_belongs_to_patient" in sources), sources
        assert all(exposed[u["id"]]["sources"] == ["selected"] for u in unseen.values())
    assert _freeze(lead, v2["id"]).status_code == 200
