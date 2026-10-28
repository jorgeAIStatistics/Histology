"""Adversarial verification (round 2) of active-learning evaluation-cohort protection (owner's brief item 6).

Lens: can a patient exposed to active-learning selection (or its duplicate partner, or material moved to another
patient) end up in val/test of a later dataset version, or be used as performance material, through any realistic
path (partitions, lineages, fresh roots, child versions, block/part/case reassignment, label changes, imported
labels, review-priority relabels, dev_cv, test releases)? Is exposure atomic with the proposal commit? Are
historical conflicts reported and never silently rewritten? Can sealed assignments be disturbed? Is the
representative evaluation cohort distinguishable from the model-selected review cohort?

Each test is a reproduction: it FAILS when the guarantee it names is violated and passes (staying as regression
coverage) when it holds. Every project and record is fictional and created by the test (per-test copy of the
seeded template database; the shared var directory is never touched).
"""

from __future__ import annotations

import hashlib
import json
from datetime import date, timedelta
from types import SimpleNamespace

from sqlalchemy import select

from ml_engine_fakes import install_fakes, make_engine_run, run_jobs
from test_al_cohort_protection import (
    BLOCKER,
    LEAD_ID,
    NEG,
    POS,
    _actor,
    _blocker,
    _by_code,
    _create,
    _draft_splits,
    _duplicate,
    _freeze,
    _label,
    _manifest,
    _new_version,
    _patient,
    _project,
    _propose,
    _registered_run,
    _request,
)

EVAL = ("val", "test")


def _cohort(db, project_id: str, prefix: str, n: int, *, sites: bool = False) -> dict:
    """``n`` labelled patients with spread case dates (2025-01-10 + 12 days each) and, with ``sites``, every
    fourth patient at site-b (the others at site-a)."""
    out = {}
    for i in range(n):
        code = f"{prefix}-{i:03d}"
        out[code] = _patient(db, project_id, code, [POS if i % 3 == 0 else NEG],
                             collected=date(2025, 1, 10) + timedelta(days=12 * i),
                             site=("site-b" if (sites and i % 4 == 3) else "site-a"))
    return out


def _exposed_ids(project_id: str) -> dict:
    from dermpath.datasets import acquisition_exposure
    from dermpath.db import session_scope

    with session_scope() as db:
        return acquisition_exposure(db, project_id)["patients"]


# =========================================================================== 1. every partition / lineage path


def test_exposed_material_never_reaches_val_or_test_under_any_partition_lineage_or_reassignment(clients,
                                                                                                monkeypatch):
    """Six unseen patients XU-0..5 are proposed (their cases dated after every cutoff and at the external test site,
    so every label-free rule would put them in val/test). Afterwards: XP-0 (confirmed duplicate of XU-0 BEFORE the
    proposal) and XP-1 (confirmed AFTER) are partners; XU-2's BLOCK is re-parented under XW-0's part and XU-3's PART
    is re-parented under XW-1's case (lineage corrections); the proposed slides are read by an expert and XU-4 is
    re-read with the opposite label. In a child version, a new lineage, and fresh root datasets under random,
    temporal and external_site partitions, every exposed patient must be train, freeze must succeed without an
    exposure blocker, and the manifest must keep the model-selected review cohort apart from the performance
    cohort."""
    install_fakes(monkeypatch)
    from dermpath.db import session_scope
    from dermpath.models import Block, SpecimenPart

    pid = "proj-v2al-paths"
    late, site = date(2025, 12, 15), "site-b"
    with session_scope() as db:
        _project(db, pid)
        _cohort(db, pid, "XB", 24, sites=True)
    lead = clients(LEAD_ID)
    v1 = _create(lead, pid, "v1", {"partition": "random", "seed": 0})
    assert _freeze(lead, v1["id"]).status_code == 200
    with session_scope() as db:
        unseen = {f"XU-{i}": _patient(db, pid, f"XU-{i}", [], unlabelled=1, collected=late, site=site)
                  for i in range(6)}
        p0 = _patient(db, pid, "XP-0", [POS], collected=late, site=site)
        _duplicate(db, pid, unseen["XU-0"]["unlabelled"][0], p0["slides"][0])
    rid = _registered_run(lead, v1["id"])
    batch = _propose(lead, pid, rid, k=10)
    assert sorted(i["coded_patient_id"] for i in batch["items"]) == sorted(u["id"] for u in unseen.values())
    with session_scope() as db:
        p1 = _patient(db, pid, "XP-1", [NEG], collected=late, site=site)
        _duplicate(db, pid, p1["slides"][0], unseen["XU-1"]["unlabelled"][0])
        w0 = _patient(db, pid, "XW-0", [POS], collected=late, site=site)
        w1 = _patient(db, pid, "XW-1", [NEG], collected=late, site=site)
        with db.no_autoflush:
            moved_block = db.get(Block, unseen["XU-2"]["block_id"])
            moved_block.designation = "A2"
            moved_block.part_id = db.get(Block, w0["block_id"]).part_id  # block re-parented under XW-0's part
            moved_part = db.get(SpecimenPart, db.get(Block, unseen["XU-3"]["block_id"]).part_id)
            moved_part.designation = "B"
            moved_part.case_id = w1["case_id"]  # part re-parented under XW-1's case
        db.flush()
        for n, code in enumerate(sorted(unseen)):
            _label(db, unseen[code]["unlabelled"][0], POS if n % 2 == 0 else NEG)
        _label(db, unseen["XU-4"]["unlabelled"][0], NEG)  # re-read: the label flips (XU-4 was POS)
    exposed_codes = {"XU-0", "XU-1", "XU-4", "XU-5", "XP-0", "XP-1", "XW-0", "XW-1"}  # XU-2/3 now own no slides
    exposed = _exposed_ids(pid)
    assert {e["patient_code"] for e in exposed.values()} >= exposed_codes

    versions = {
        "child": _new_version(lead, v1["id"], reason="experts read the proposed slides"),
        "new_lineage": _new_version(lead, v1["id"], reason="new lineage", new_lineage=True,
                                    split={"partition": "random", "seed": 9}),
        "root_random": _create(lead, pid, "root random", {"partition": "random", "seed": 4}),
        "root_temporal": _create(lead, pid, "root temporal", {"partition": "temporal", "test_cutoff": "2025-10-01",
                                                              "val_cutoff": "2025-07-01"}),
        "root_external": _create(lead, pid, "root external", {"partition": "external_site",
                                                              "test_sites": ["site-b"], "seed": 1}),
    }
    for name, dsv in versions.items():
        draft = _draft_splits(dsv["id"])
        present = exposed_codes & set(draft)
        assert present == exposed_codes, (name, sorted(exposed_codes - present))
        assert {c: draft[c] for c in present} == {c: "train" for c in present}, \
            f"{name}: model-selected material must be allocated to train, never val or test"
        check = lead.get(f"/api/v1/datasets/{dsv['id']}/freeze-check").json()
        assert _blocker(check) is None, (name, _blocker(check))
        r = _freeze(lead, dsv["id"])
        assert r.status_code == 200, (name, r.text)
        m = _manifest(lead, dsv["id"])
        assert {c: _by_code(m)[c] for c in present} == {c: "train" for c in present}, name
        cohorts = m["evaluation_cohorts"]
        assert set(cohorts["model_selected_review_cohort"]["patient_codes"]) == present, name
        assert cohorts["representative_performance_cohort"]["model_selected_patients"] == 0, name
        assert m["audit"]["acquisition_exposure"]["ok"] is True, name
    # The temporal and external-site diagnostics name the pinned patients as placed against the rule.
    temporal = _manifest(lead, versions["root_temporal"]["id"])["split_diagnostics"]
    assert exposed_codes <= set(temporal["against_rule"])


# =========================================================================== 2. atomicity of proposal + exposure


def test_proposals_and_their_exposure_commit_together_or_not_at_all(clients, monkeypatch):
    """A crash while the exposure rows are being written (second proposal of the batch), and a crash after every
    exposure row was written but before the transaction commits (the batch audit), must leave neither proposals
    nor exposure behind. A later batch then writes exactly one ``selected`` exposure row per proposal."""
    install_fakes(monkeypatch)
    from dermpath import audit as audit_mod
    from dermpath.db import session_scope
    from dermpath.ml import active_learning as al
    from dermpath.ml.engine_models import ALProposal
    from dermpath.models import AcquisitionExposure, Job

    pid = "proj-v2al-atomic"
    with session_scope() as db:
        _project(db, pid)
        _cohort(db, pid, "AB", 20)
        unseen = {f"AU-{i}": _patient(db, pid, f"AU-{i}", [], unlabelled=1) for i in range(3)}
    lead = clients(LEAD_ID)
    v1 = _create(lead, pid, "v1", {"partition": "random", "seed": 0})
    assert _freeze(lead, v1["id"]).status_code == 200
    rid = _registered_run(lead, v1["id"])

    def nothing_persisted(batch_id: str) -> None:
        with session_scope() as db:
            assert db.scalars(select(ALProposal.id).where(ALProposal.batch_id == batch_id)).first() is None
            assert db.scalars(select(AcquisitionExposure.id)
                              .where(AcquisitionExposure.project_id == pid)).first() is None
            job = db.scalars(select(Job).where(Job.idempotency_key == f"al:{batch_id}")).first()
            assert job.status == "failed", job.status
        assert _exposed_ids(pid) == {}

    original = al.record_acquisition_exposure
    calls: list[str] = []

    def crash_on_second(db, **kw):
        calls.append(kw["slide_id"])
        if len(calls) >= 2:
            raise RuntimeError("simulated crash while writing the exposure")
        return original(db, **kw)

    with monkeypatch.context() as m:
        m.setattr(al, "record_acquisition_exposure", crash_on_second)
        req = _request(lead, pid, rid, k=3)
        out = run_jobs(["active_learning"])
        assert out and all(o.status != "succeeded" for o in out), [o.status for o in out]
    nothing_persisted(req["batch_id"])

    real_record = audit_mod.record

    def crash_at_batch_audit(db, *args, **kw):
        if kw.get("action") == "active_learning.proposed":
            raise RuntimeError("simulated crash after the exposure rows, before commit")
        return real_record(db, *args, **kw)

    with monkeypatch.context() as m:
        m.setattr(audit_mod, "record", crash_at_batch_audit)
        req2 = _request(lead, pid, rid, k=3)
        out = run_jobs(["active_learning"])
        assert out and all(o.status != "succeeded" for o in out), [o.status for o in out]
    nothing_persisted(req2["batch_id"])

    batch = _propose(lead, pid, rid, k=3)
    assert sorted(i["coded_patient_id"] for i in batch["items"]) == sorted(u["id"] for u in unseen.values())
    with session_scope() as db:
        props = db.scalars(select(ALProposal).where(ALProposal.batch_id == batch["batch_id"])).all()
        rows = db.scalars(select(AcquisitionExposure).where(AcquisitionExposure.project_id == pid)).all()
        assert sorted(r.proposal_id for r in rows if r.relation == "selected") == sorted(p.id for p in props)


# =========================================================================== 3. sealed + resolution guidance


def test_sealed_partner_never_moves_and_each_conflict_resolution_actually_resolves_it(clients, monkeypatch):
    """v1's test patients are sealed. Unseen patient E is proposed; afterwards a person confirms E's slide as a
    duplicate of sealed test patient S's slide. In a new lineage S must stay test (sealed never moves) and freeze
    must be refused (model-selected material in test). Each blocked patient carries a resolution; following it must
    clear that patient's conflict. E is reported as ``held_by: draft_allocation`` with "Refresh the draft", but E is
    held in test by its duplicate grouping with the sealed S, so a refresh changes nothing."""
    install_fakes(monkeypatch)
    from dermpath.datasets import seal_test_patients
    from dermpath.db import session_scope
    from dermpath.models import DatasetVersion

    pid = "proj-v2al-sealed"
    with session_scope() as db:
        _project(db, pid)
        _cohort(db, pid, "SB", 20)
    lead = clients(LEAD_ID)
    v1 = _create(lead, pid, "v1", {"partition": "random", "seed": 0})
    assert _freeze(lead, v1["id"]).status_code == 200
    m1 = _manifest(lead, v1["id"])
    s_item = next(it for it in sorted(m1["items"], key=lambda r: r["slide_id"]) if it["split"] == "test")
    with session_scope() as db:
        seal_test_patients(db, db.get(DatasetVersion, v1["id"]), "test release 1 (fictional)", actor=_actor("lead"))
        e = _patient(db, pid, "SE-01", [], unlabelled=1)
    rid = _registered_run(lead, v1["id"])
    batch = _propose(lead, pid, rid, k=1)
    assert [i["coded_patient_id"] for i in batch["items"]] == [e["id"]]
    with session_scope() as db:
        _duplicate(db, pid, e["unlabelled"][0], s_item["slide_id"])
        _label(db, e["unlabelled"][0], POS)
    nl = _new_version(lead, v1["id"], reason="new lineage after the duplicate decision", new_lineage=True,
                      split={"partition": "random", "seed": 9})
    draft = _draft_splits(nl["id"])
    assert draft[s_item["patient_code"]] == "test", "a sealed patient never moves"
    assert _freeze(lead, nl["id"]).status_code == 409
    check = lead.get(f"/api/v1/datasets/{nl['id']}/freeze-check").json()
    held = {p["patient_code"]: p for p in _blocker(check)["patients"]}
    assert held[s_item["patient_code"]]["held_by"] == "sealed"
    e_entry = held["SE-01"]
    # Follow E's stated resolution.
    if "refresh" in e_entry["resolution"].lower():
        assert lead.post(f"/api/v1/datasets/{nl['id']}/refresh").status_code == 200
        after = lead.get(f"/api/v1/datasets/{nl['id']}/freeze-check").json()
        still = {p["patient_code"]: p for p in (_blocker(after) or {"patients": []})["patients"]}
        assert "SE-01" not in still, (
            "the resolution given for SE-01 ('" + e_entry["resolution"] + "', held_by " + e_entry["held_by"]
            + ") does not resolve it: after the refresh SE-01 is still in " + still.get("SE-01", {}).get("split", "?")
            + " because its duplicate grouping with the sealed test patient holds it there")
    assert _draft_splits(nl["id"])[s_item["patient_code"]] == "test"


# =========================================================================== 4. dev_cv uses model-selected patients


def test_dev_cv_never_reports_model_selected_patients_as_held_out_performance_without_saying_so(clients, ids):
    """A train patient of the seeded synthetic cohort gets an open reader disagreement, so active learning proposes
    its slide: the patient is model-selected review material, which the manifest describes as "development
    (training) only; never a performance estimate". A dev_cv run on the cohort then scores that patient OUT OF
    FOLD and its OOF metrics, operating point and calibration are computed over it. Either the patient is kept out
    of the held-out (performance) material, or the run says that its OOF performance includes model-selected
    patients. Neither happens.

    Strengthened by the fix agent: since the fix every run reports an ``acquisition_exposure`` block (also when
    nothing is exposed), so the keyword check alone is always satisfied. The test therefore also checks the
    behaviour: the exposed OOF patients are reported as excluded, their bags are not among the bags the operating
    point was selected on, their rows carry ``attributes.model_selected`` and the stored OOF evaluation is computed
    without them."""
    from dermpath.db import session_scope
    from dermpath.ml.models import Evaluation, Prediction, TrainingRun
    from dermpath.models import DatasetVersion, Disagreement
    from test_ml_support import CID, FAST, SYNTH, cohort
    from test_ml_support import run_jobs as run_ml_jobs

    lead = clients(LEAD_ID)
    dv_id = cohort(ids)["dataset_version_id"]
    seeded_run = ids["ml_demo"]["cohort"]["runs"]["meanpool_logreg"]
    r = lead.post(f"/api/v1/experiments/{seeded_run}/register")
    assert r.status_code < 300, r.text
    with session_scope() as db:
        m = db.get(DatasetVersion, dv_id).manifest_json
        target = next(it for it in sorted(m["items"], key=lambda r: r["slide_id"]) if it["split"] == "train")
        db.add(Disagreement(project_id=CID, scope="slide", target_id=target["slide_id"], slide_id=target["slide_id"],
                            label_version_ids_json=[], values_json=[NEG, POS], status="open"))
    req = lead.post(f"/api/v1/projects/{CID}/active-learning",
                    json={"run_id": seeded_run, "k": 500, "random_fraction": 1.0, "seed": 0})
    assert req.status_code == 202, req.text
    out = run_ml_jobs(("active_learning",))
    assert [o.status for o in out] == ["succeeded"], [o.error for o in out]
    exposed = _exposed_ids(CID)
    assert target["coded_patient_id"] in exposed
    dev_exposed = {it["coded_patient_id"] for it in m["items"]
                   if it["split"] in ("train", "val") and it["coded_patient_id"] in exposed}
    assert dev_exposed

    body = {"dataset_version_id": dv_id, "encoder_id": SYNTH, "head": "meanpool_logreg", "seed": 5,
            "params": {**FAST, "cv_folds": 4, "min_threshold_evidence": 5}, "evaluation_protocol": "dev_cv",
            "execution_mode": "synthetic_pipeline_test"}
    r = lead.post(f"/api/v1/projects/{CID}/experiments", json=body)
    assert r.status_code == 202, r.text
    run_id = r.json()["experiment"]["id"]
    run_ml_jobs(("build_feature_set", "train"))
    with session_scope() as db:
        run = db.get(TrainingRun, run_id)
        assert run.status == "succeeded", run.error
        oof_patients = set(db.scalars(select(Prediction.coded_patient_id)
                                      .where(Prediction.run_id == run_id, Prediction.split == "oof")).all())
        ev = db.scalars(select(Evaluation).where(Evaluation.run_id == run_id, Evaluation.split == "oof")).first()
        reported = json.dumps({"metrics": run.metrics_json, "threshold": run.threshold_json,
                               "calibration": run.calibration_json,
                               "evaluation": ev.metrics_json if ev is not None else None}, default=str).lower()
        acq = run.metrics_json["acquisition_exposure"]
        selected_on = set(run.threshold_json["selected_on_bag_ids"])
        oof_rows = db.scalars(select(Prediction).where(Prediction.run_id == run_id, Prediction.split == "oof")).all()
        exposed_rows = [p for p in oof_rows if p.coded_patient_id in dev_exposed]
        ev_held_out = ev.metrics_json["acquisition_exposure"]["held_out"]
        ev_patients = ev.metrics_json["n_patients"]
    scored = dev_exposed & oof_patients
    if scored:
        assert acq["status"] == "model_selected_held_out_excluded" and scored <= set(acq["model_selected_patient_ids"])
        assert not ({p.bag_id for p in exposed_rows} & selected_on), "operating point selected on model-selected bags"
        assert all((p.attributes_json or {}).get("model_selected") is True for p in exposed_rows)
        assert ev_held_out["model_selected_patients"] >= len(scored)
        assert ev_patients <= len(oof_patients) - len(scored), "the OOF evaluation still counts model-selected patients"
    flagged = ("model_selected" in reported) or ("acquisition" in reported) or ("model-selected" in reported)
    assert not scored or flagged, (
        f"{len(scored)} model-selected patient(s) were scored as held-out OOF performance material (OOF metrics, "
        "operating point and calibration) and the run never says so")


# =========================================================================== 5. new evaluations on a conflicted version


def test_test_release_on_a_version_whose_test_holds_model_selected_material_is_refused_or_flagged(clients,
                                                                                                    monkeypatch):
    """A historical active-learning proposal (made before exposures were recorded) chose a patient T that frozen v1
    holds in TEST; the audit reports it as a historical conflict. A test release of a run on v1 afterwards must
    not silently present T as representative test material: it is refused, or the release / its evaluation says
    that the test cohort includes model-selected material."""
    install_fakes(monkeypatch)
    from dermpath.db import session_scope, utcnow
    from dermpath.ml.engine_models import ALProposal
    from dermpath.models import DatasetVersion

    pid = "proj-v2al-release"
    with session_scope() as db:
        _project(db, pid)
        _cohort(db, pid, "RB", 20)
    lead = clients(LEAD_ID)
    v1 = _create(lead, pid, "v1", {"partition": "random", "seed": 0})
    assert _freeze(lead, v1["id"]).status_code == 200
    m1 = _manifest(lead, v1["id"])
    t = next(it for it in sorted(m1["items"], key=lambda r: r["slide_id"]) if it["split"] == "test")
    with session_scope() as db:
        db.add(ALProposal(project_id=pid, batch_id="legacybatch-r", slide_id=t["slide_id"],
                          coded_patient_id=t["coded_patient_id"], proposal_rank=1, strategy="uncertainty",
                          components_json={"family_split": "new_to_family"}, seed=0, created_by="system:worker",
                          created_at=utcnow() - timedelta(days=30)))
    conflicts = lead.get(f"/api/v1/datasets/{v1['id']}/audit").json()["acquisition_exposure"]["historical_conflicts"]
    assert [c["patient_code"] for c in conflicts] == [t["patient_code"]]
    with session_scope() as db:
        run, _fs = make_engine_run(db, db.get(DatasetVersion, v1["id"]))
        rid = run.id
    assert lead.post(f"/api/v1/experiments/{rid}/register").status_code < 300
    r = lead.post(f"/api/v1/experiments/{rid}/test-release", json={"reason": "first look at the test split"})
    if r.status_code == 409 and "acquisition" in r.json()["error"]["code"]:
        return  # refused: the guarantee holds
    assert r.status_code == 202, r.text
    release = r.json()
    out = run_jobs(["evaluate_test_release"])
    assert [o.status for o in out] == ["succeeded"], [o.error for o in out]
    ev = lead.get(f"/api/v1/experiments/{rid}/evaluation?split=test")
    assert ev.status_code == 200, ev.text
    text = json.dumps({"release": release, "evaluation": ev.json()}).lower()
    assert ("acquisition" in text) or ("model_selected" in text) or ("model-selected" in text), (
        f"test release accepted and evaluated test patient {t['patient_code']} (a historical active-learning "
        "selection) as representative test material without any acquisition-exposure flag")


# =========================================================================== 6. review priorities under dev_cv


def test_review_priority_flags_validation_patients_also_for_dev_cv_oof_discordances(clients, monkeypatch):
    """The review-priority queue flags ``evaluation_patient`` so a model-prompted relabel of a validation patient is
    adjudicated blind. Under dev_cv the validation patients are scored out of fold (split ``oof``, the manifest
    split kept in ``attributes.manifest_split``). A confident OOF discordance on a VALIDATION patient prompts the
    same relabel and must carry the same flag; a train patient's must not."""
    install_fakes(monkeypatch)
    from dermpath.db import session_scope
    from dermpath.ml.models import Prediction
    from dermpath.models import DatasetVersion

    pid = "proj-v2al-review"
    with session_scope() as db:
        _project(db, pid)
        _cohort(db, pid, "VB", 20)
    lead = clients(LEAD_ID)
    v1 = _create(lead, pid, "v1", {"partition": "random", "seed": 0})
    assert _freeze(lead, v1["id"]).status_code == 200
    m1 = _manifest(lead, v1["id"])
    items = sorted(m1["items"], key=lambda r: r["slide_id"])
    val_item = next(it for it in items if it["split"] == "val")
    train_item = next(it for it in items if it["split"] == "train")
    with session_scope() as db:
        run, _ = make_engine_run(db, db.get(DatasetVersion, v1["id"]), protocol="dev_cv", store_val=False)
        rid = run.id
        for fold, it in enumerate((val_item, train_item)):
            label = 1 if it["label_value"] == POS else 0
            db.add(Prediction(run_id=rid, project_id=pid, split="oof", bag_kind="slide", bag_id=f"oof-{it['slide_id']}",
                              slide_ids_json=[it["slide_id"]], case_id=it["case_id"],
                              coded_patient_id=it["coded_patient_id"], patient_code=it["patient_code"],
                              label_value=it["label_value"], label_version_ids_json=[], label=label,
                              score=0.02 if label else 0.98, threshold=0.5, predicted=0 if label else 1,
                              abstained=False, attributes_json={"fold": fold, "manifest_split": it["split"]},
                              feature_artifact_ids_json=[]))
    body = clients("user-director").get(f"/api/v1/projects/{pid}/review-priorities?run_id={rid}").json()
    by_target = {i["target"]["target_id"]: i for i in body["items"]}
    assert by_target[train_item["slide_id"]]["evaluation_patient"] is False
    assert by_target[val_item["slide_id"]]["evaluation_patient"] is True, (
        "a confident dev_cv OOF discordance on a VALIDATION patient is not flagged evaluation_patient (the flag "
        "keys on the prediction split 'val', not on the patient's split), so a model-prompted relabel of a "
        "validation patient is not marked 'adjudicate blind'")


# =========================================================================== 7. manifest wording of the cohorts


def test_representative_cohort_composition_is_independent_of_active_learning_as_the_manifest_states(clients,
                                                                                                    monkeypatch):
    """The manifest describes the representative performance cohort (val + test) as allocated "independent of
    model scores and of active-learning selection". Pinning model-selected patients to train counts them toward
    train's targets, so OTHER patients are pushed into val/test: which non-selected patients form the performance
    cohort then depends on what active learning chose. Compared with the same fresh root allocated without the
    exposure (same salt, seed, cohort and grouping), the non-selected val/test membership must be unchanged for the
    statement to hold."""
    install_fakes(monkeypatch)
    from dermpath import splits as splitlib
    from dermpath.datasets import _duplicate_groups, _patient_infos, positive_class
    from dermpath.db import session_scope
    from dermpath.models import DatasetVersion

    pid = "proj-v2al-cohorts"
    with session_scope() as db:
        _project(db, pid)
        _cohort(db, pid, "CB", 30)
        unseen = {f"CU-{i}": _patient(db, pid, f"CU-{i}", [], unlabelled=1) for i in range(8)}
    lead = clients(LEAD_ID)
    v1 = _create(lead, pid, "v1", {"partition": "random", "seed": 0})
    assert _freeze(lead, v1["id"]).status_code == 200
    rid = _registered_run(lead, v1["id"])
    batch = _propose(lead, pid, rid, k=8)
    assert len(batch["items"]) == 8
    with session_scope() as db:
        for n, code in enumerate(sorted(unseen)):
            _label(db, unseen[code]["unlabelled"][0], POS if n % 2 == 0 else NEG)
    root = _create(lead, pid, "fresh root", {"partition": "random", "seed": 2})
    exposed = set(_exposed_ids(pid))
    with session_scope() as db:
        dv = db.get(DatasetVersion, root["id"])
        pts = _patient_infos(db, dv)
        counterfactual, _ = splitlib.allocate(pts, dv.config_json["split"], salt=_family_salt(db, dv),
                                              groups=_duplicate_groups(db, dv),
                                              classes=dv.config_json.get("label_values"),
                                              positive_class=positive_class(dv.config_json))
        code_of = {p["id"]: p["code"] for p in pts}
    assert _freeze(lead, root["id"]).status_code == 200
    m = _manifest(lead, root["id"])
    claim = m["evaluation_cohorts"]["representative_performance_cohort"]["selection"]
    actual = {s["patient_code"] for s in m["splits"] if s["split"] in EVAL and s["coded_patient_id"] not in exposed}
    without = {code_of[p] for p, sp in counterfactual.items() if sp in EVAL and p not in exposed}
    if "independent of model scores and of active-learning selection" in claim:
        assert actual == without, (
            "the manifest says the performance cohort is independent of active-learning selection, but the "
            f"non-selected patients in val/test changed because selected ones were pinned to train: now in "
            f"val/test only {sorted(actual - without)}, displaced back to train {sorted(without - actual)}")
    else:  # added by the fix agent: the corrected manifest must name exactly the patients the pin moved
        effect = m["evaluation_cohorts"]["representative_performance_cohort"]["allocation_effect_of_model_selected"]
        assert effect["status"] == "computed"
        assert {r["patient_code"] for r in effect["moved_into_evaluation"]} == actual - without
        assert {r["patient_code"] for r in effect["displaced_to_train"]} == without - actual


def _family_salt(db, dv) -> str:
    from dermpath.datasets import lineage_family

    return lineage_family(db, dv.lineage_id).salt


# =========================================================================== 8. imported labels and the pool


def test_pool_honours_the_datasets_reference_standard_for_imported_labels(clients, monkeypatch):
    """Under ``reference_standard: imported_reference`` (the COBRA set-up) a slide with an imported reference label
    IS labelled. The pool must not offer it as "no_reference_label": proposing it exposes its patient, and a patient
    new to the family (e.g. a later import) is then pinned to train forever, removed from the representative
    evaluation cohort although its label never came from model-prompted review."""
    from dermpath.datasets import acquisition_exposure
    from dermpath.db import session_scope, utcnow
    from dermpath.labels import create_imported_reference_label
    from dermpath.ml.active_learning import development_pool
    from dermpath.models import Block, Case, CodedPatient, DatasetVersion, Slide, SpecimenPart
    from dermpath.review import set_review_state

    pid = "proj-v2al-imported"

    def real_patient(db, code: str, value: str) -> str:
        patient = CodedPatient(project_id=pid, code=code, created_by="test")
        db.add(patient)
        db.flush()
        case = Case(project_id=pid, coded_patient_id=patient.id, accession_code=f"A-{code}",
                    collected_on=date(2025, 3, 1), site_id="site-a", provenance="real_authorized")
        db.add(case)
        db.flush()
        part = SpecimenPart(project_id=pid, case_id=case.id, designation="A")
        db.add(part)
        db.flush()
        block = Block(project_id=pid, part_id=part.id, designation="A1")
        db.add(block)
        db.flush()
        s = Slide(project_id=pid, block_id=block.id, level_index=1, stain="H&E", scanner_id="scanner-a",
                  provenance="real_authorized", image_kind="wsi", object_key=f"v2al/{pid}/{code}",
                  sha256=hashlib.sha256(f"v2al|{pid}|{code}".encode()).hexdigest(), mpp_x=0.5, mpp_y=0.5,
                  ingest_status="succeeded", ingested_at=utcnow())
        db.add(s)
        db.flush()
        create_imported_reference_label(db, slide=s, value=value,
                                        provenance="fictional imported reference (report-derived, test)")
        set_review_state(db, None, s, "approved", reason=None, system=True)
        return s.id

    with session_scope() as db:
        _project(db, pid)
        for i in range(12):
            real_patient(db, f"IM-{i:03d}", POS if i % 3 == 0 else NEG)
    lead = clients(LEAD_ID)
    r = lead.post(f"/api/v1/projects/{pid}/datasets", json={"name": "imported v1", "config": {
        "label_scope": "slide", "eligible_review_states": ["approved"], "label_values": [POS, NEG],
        "reference_standard": "imported_reference", "include_provenance": ["real_authorized"],
        "split": {"partition": "random", "seed": 0}}})
    assert r.status_code == 201, r.text
    v1 = r.json()
    assert _freeze(lead, v1["id"]).status_code == 200
    with session_scope() as db:
        later = real_patient(db, "IM-LATER", POS)  # a later import: labelled, new to the family
    with session_scope() as db:
        dv = db.get(DatasetVersion, v1["id"])
        pool, _counts = development_pool(db, SimpleNamespace(project_id=pid, label_scope="slide"), dv)
        offered = {c["slide_id"]: c["pool_reason"] for c in pool}
        assert acquisition_exposure(db, pid)["patients"] == {}
    labelled_train = {it["slide_id"] for it in dv.manifest_json["items"] if it["split"] == "train"}
    assert later not in offered and not (labelled_train & set(offered)), (
        f"slides carrying an imported reference label are offered as {sorted(set(offered.values()))}: "
        f"{len(offered)} pool slide(s), including the later import {later in offered} and "
        f"{len(labelled_train & set(offered))} labelled train slide(s)")


# =========================================================================== 9. new runs on a conflicted version


def test_holdout_run_on_a_version_whose_val_holds_model_selected_material_says_so(clients, ids):
    """Same historical conflict as above on VALIDATION: a legacy active-learning proposal chose a patient the frozen
    synthetic cohort holds in val (the audit lists it). A NEW holdout run on that version selects its threshold and
    reports validation metrics over that patient. The run must say that its validation (tuning) cohort includes
    model-selected material, or refuse; it does neither.

    Strengthened by the fix agent (every run now reports an ``acquisition_exposure`` block, so the keyword check
    alone is always satisfied): the val patient is reported as excluded, its bags are not among the bags the threshold
    was selected on, and the stored val evaluation is computed without it."""
    from dermpath.db import session_scope, utcnow
    from dermpath.ml.engine_models import ALProposal
    from dermpath.ml.models import Evaluation, Prediction, TrainingRun
    from dermpath.models import DatasetVersion
    from test_ml_support import CID, FAST, SYNTH, cohort
    from test_ml_support import run_jobs as run_ml_jobs

    lead = clients(LEAD_ID)
    dv_id = cohort(ids)["dataset_version_id"]
    with session_scope() as db:
        m = db.get(DatasetVersion, dv_id).manifest_json
        v = next(it for it in sorted(m["items"], key=lambda r: r["slide_id"]) if it["split"] == "val")
        db.add(ALProposal(project_id=CID, batch_id="legacybatch-holdout", slide_id=v["slide_id"],
                          coded_patient_id=v["coded_patient_id"], proposal_rank=1, strategy="uncertainty",
                          components_json={"family_split": "new_to_family"}, seed=0, created_by="system:worker",
                          created_at=utcnow() - timedelta(days=30)))
    audit = lead.get(f"/api/v1/datasets/{dv_id}/audit").json()["acquisition_exposure"]
    assert v["patient_code"] in {c["patient_code"] for c in audit["historical_conflicts"]}
    body = {"dataset_version_id": dv_id, "encoder_id": SYNTH, "head": "meanpool_logreg", "seed": 6,
            "params": {**FAST, "min_threshold_evidence": 5}, "evaluation_protocol": "holdout",
            "execution_mode": "synthetic_pipeline_test"}
    r = lead.post(f"/api/v1/projects/{CID}/experiments", json=body)
    if r.status_code == 409 and "acquisition" in r.json()["error"]["code"]:
        return  # refused: the guarantee holds
    assert r.status_code == 202, r.text
    run_id = r.json()["experiment"]["id"]
    run_ml_jobs(("build_feature_set", "train"))
    with session_scope() as db:
        run = db.get(TrainingRun, run_id)
        assert run.status == "succeeded", run.error
        val_patients = set(db.scalars(select(Prediction.coded_patient_id)
                                      .where(Prediction.run_id == run_id, Prediction.split == "val")).all())
        ev = db.scalars(select(Evaluation).where(Evaluation.run_id == run_id, Evaluation.split == "val")).first()
        reported = json.dumps({"metrics": run.metrics_json, "threshold": run.threshold_json,
                               "evaluation": ev.metrics_json if ev is not None else None}, default=str).lower()
        acq = run.metrics_json["acquisition_exposure"]
        v_bags = set(db.scalars(select(Prediction.bag_id).where(Prediction.run_id == run_id, Prediction.split == "val",
                                                                Prediction.coded_patient_id == v["coded_patient_id"]))
                     .all())
        selected_on = set(run.threshold_json["selected_on_bag_ids"])
        ev_patients = ev.metrics_json["n_patients"]
    assert v["coded_patient_id"] in val_patients
    assert acq["status"] == "model_selected_held_out_excluded" and v["coded_patient_id"] in acq["model_selected_patient_ids"]
    assert v_bags and not (v_bags & selected_on), "the threshold was selected on the model-selected val patient"
    assert ev_patients <= len(val_patients) - 1, "the val evaluation still counts the model-selected patient"
    assert ("acquisition" in reported) or ("model_selected" in reported) or ("model-selected" in reported), (
        f"validation patient {v['patient_code']} is historical model-selected material (listed by the audit), yet "
        "the new run selected its threshold and reported validation metrics on it without any flag")
