"""Acceptance 5 (approval/exclusion change training eligibility), 6 (all slides of a patient
stay in one split), 7 (test items never reach train / active learning / threshold selection)
and 8 (frozen manifests are immutable; a label change forces a new version)."""

from __future__ import annotations

import csv
import io
import random
from collections import Counter
from dataclasses import replace
from datetime import date, timedelta

import pytest
from sqlalchemy import text

PID = "proj-bcc-demo"
APPROVED = ["p1_a1_l1", "p1_a1_l2", "p1_b1_l1", "p2_a1_l1", "p4_a1_l1", "p4_a1_l2", "p4_c2_a1_l1", "p5_a1_l1_neardup"]


def _create(lead, name="ds", **config):
    r = lead.post(f"/api/v1/projects/{PID}/datasets", json={"name": name, "config": config})
    assert r.status_code == 201, r.text
    return r.json()


def _manifest(lead, dsid):
    r = lead.get(f"/api/v1/datasets/{dsid}/manifest")
    assert r.status_code == 200, r.text
    return r.json()


def _freeze(lead, dsid):
    # These tests are about immutability and splits; the open-QC freeze gate has its own test below.
    r = lead.post(f"/api/v1/datasets/{dsid}/freeze", json={"reason": "test", "acknowledge_warnings": True})
    assert r.status_code == 200, r.text
    return r.json()


# --------------------------------------------------------------------------- Acceptance 5


def test_approval_and_exclusion_change_training_eligibility(clients, ids):
    lead, path = clients("user-research-lead"), clients("user-pathologist")
    sid = ids["slides"]["p5_a1_l2"]  # pending_review, expert label from a corrected suggestion
    el = lead.get(f"/api/v1/slides/{sid}/eligibility").json()
    assert el["eligible"] is False and [r["code"] for r in el["reasons"]] == ["review_state_pending_review"]

    draft = _create(lead, "eligibility")
    assert draft["item_count"] == len(APPROVED)
    assert path.post(f"/api/v1/slides/{sid}/review-state", json={"state": "approved"}).status_code == 200
    assert lead.get(f"/api/v1/slides/{sid}/eligibility").json()["eligible"] is True
    refreshed = lead.post(f"/api/v1/datasets/{draft['id']}/refresh").json()
    assert refreshed["item_count"] == len(APPROVED) + 1

    r = path.post(f"/api/v1/slides/{sid}/review-state",
                  json={"state": "excluded", "reason": "section shows a large tear (fictional)"})
    assert r.status_code == 200
    el = lead.get(f"/api/v1/slides/{sid}/eligibility").json()
    assert el["eligible"] is False
    assert el["reasons"] == [{"code": "review_state_excluded", "detail": "section shows a large tear (fictional)"}]
    refreshed = lead.post(f"/api/v1/datasets/{draft['id']}/refresh").json()
    assert refreshed["item_count"] == len(APPROVED)
    summary = lead.get(f"/api/v1/datasets/{draft['id']}/summary").json()
    excl = {e["slide_id"]: e for e in summary["exclusions"]["slides"]}
    assert excl[sid]["reasons"][0]["detail"] == "section shows a large tear (fictional)"
    assert summary["exclusions"]["by_reason"]["review_state_excluded"] >= 2  # + the seeded low-tissue slide


def test_qc_resolution_with_exclusion_changes_eligibility_but_suggestions_do_not(clients, ids, env, run_worker):
    from dermpath.config import set_settings

    lead, asst = clients("user-research-lead"), clients("user-assistant")
    sid = ids["slides"]["p1_a1_l2"]
    assert lead.get(f"/api/v1/slides/{sid}/eligibility").json()["eligible"] is True
    # An absurd threshold forces a heuristic blur SUGGESTION; eligibility must not change.
    settings, _ = env
    set_settings(replace(settings, qc_blur_variance_threshold=1e12))
    assert asst.post(f"/api/v1/slides/{sid}/qc/screen").status_code == 202
    run_worker()
    set_settings(settings)
    qc = asst.get(f"/api/v1/slides/{sid}/qc").json()
    blur = [i for i in qc["issues"] if i["category"] == "blur_heuristic"]
    assert blur and blur[0]["is_suggestion"] and blur[0]["dataset_eligibility_effect"] == "none"
    assert lead.get(f"/api/v1/slides/{sid}/eligibility").json()["eligible"] is True
    # A human records a fold and resolves it with an explicit exclusion → ineligible.
    issue = asst.post(f"/api/v1/slides/{sid}/qc/issues", json={"category": "fold", "note": "fold"}).json()
    asst.patch(f"/api/v1/qc/issues/{issue['id']}", json={"action": "review", "confirmed": True})
    r = asst.patch(f"/api/v1/qc/issues/{issue['id']}", json={
        "action": "resolve", "resolution": "fold covers the tissue", "dataset_eligibility_effect": "exclude_slide",
        "reason": "fold across the whole section"})
    assert r.status_code == 200
    el = lead.get(f"/api/v1/slides/{sid}/eligibility").json()
    assert el["eligible"] is False and el["reasons"][0]["code"] == "qc_excluded"


def test_case_label_is_never_copied_down(clients, ids):
    lead = clients("user-research-lead")
    sid = ids["slides"]["p3_a1_l1_blur"]
    el = lead.get(f"/api/v1/slides/{sid}/eligibility?eligible_review_states=pending_review").json()
    codes = {r["code"]: r.get("detail") for r in el["reasons"]}
    assert "no_reference_label_slide" in codes and "never copied down" in codes["no_reference_label_slide"]
    case_el = lead.get(f"/api/v1/slides/{sid}/eligibility?label_scope=case&eligible_review_states=pending_review")
    assert case_el.json()["eligible"] is True and case_el.json()["label_value"] == "bcc_present"


# --------------------------------------------------------------------------- Acceptance 6


def _random_patients(rng: random.Random, n: int) -> list[dict]:
    out = []
    for i in range(n):
        k = rng.randint(1, 3)
        dates = [date(2025, 1, 1) + timedelta(days=rng.randint(0, 600)) for _ in range(k)]
        out.append({"id": f"pt{i:03d}", "label": rng.choice(["bcc_present", "bcc_absent_not_benign"]),
                    "dates": dates, "sites": {rng.choice(["site-a", "site-b", "site-c"]) for _ in range(k)},
                    "slides": rng.randint(1, 6)})
    return out


@pytest.mark.parametrize("seed", range(12))
def test_split_property_every_patient_in_exactly_one_split(seed):
    from dermpath.datasets import assert_patient_grouping, compute_splits, normalise_split

    rng = random.Random(seed)
    patients = _random_patients(rng, rng.randint(1, 60))
    configs = [
        {"partition": "random", "seed": rng.randint(0, 10**6)},
        {"partition": "random", "seed": seed, "ratios": {"train": 0.7, "val": 0.15, "test": 0.15}},
        {"partition": "temporal", "test_cutoff": "2026-03-01", "val_cutoff": "2025-11-01"},
        {"partition": "external_site", "test_sites": ["site-c"], "seed": seed},
    ]
    for cfg in configs:
        split = normalise_split(cfg)
        mapping, diag = compute_splits(patients, split)
        assert set(mapping) == {p["id"] for p in patients}
        assert set(mapping.values()) <= {"train", "val", "test"}
        items = [{"coded_patient_id": p["id"], "split": mapping[p["id"]]} for p in patients for _ in range(p["slides"])]
        assert_patient_grouping(items)  # all slides of a patient share one split
        again, _ = compute_splits(patients, split)
        assert again == mapping  # deterministic for a given seed/config
        if cfg["partition"] == "temporal":
            for p in patients:
                assert (mapping[p["id"]] == "test") == (max(p["dates"]) >= date(2026, 3, 1))
        if cfg["partition"] == "external_site":
            for p in patients:
                assert (mapping[p["id"]] == "test") == ("site-c" in p["sites"])


def test_grouping_check_detects_a_leak():
    from dermpath.datasets import assert_patient_grouping

    with pytest.raises(AssertionError):
        assert_patient_grouping([{"coded_patient_id": "a", "split": "train"},
                                 {"coded_patient_id": "a", "split": "test"}])


@pytest.mark.parametrize("split", [
    {"partition": "random", "seed": 0}, {"partition": "random", "seed": 1}, {"partition": "random", "seed": 7},
    {"partition": "temporal", "test_cutoff": "2026-06-01", "val_cutoff": "2026-03-01"},
    {"partition": "external_site", "test_sites": ["site-south"], "seed": 3},
])
def test_api_splits_keep_patients_together(clients, split):
    lead = clients("user-research-lead")
    ds = _create(lead, "split-test", eligible_review_states=["approved", "pending_review"],
                 label_values=["bcc_present", "bcc_absent_not_benign"], split=split)
    _freeze(lead, ds["id"])
    m = _manifest(lead, ds["id"])["manifest"]
    by_patient: dict[str, set] = {}
    for it in m["items"]:
        by_patient.setdefault(it["patient_code"], set()).add(it["split"])
    assert all(len(s) == 1 for s in by_patient.values()), by_patient
    # P-0004 has two cases (two sites, two dates): every one of its slides is in one split.
    p4 = [it for it in m["items"] if it["patient_code"] == "P-0004"]
    assert len({it["case_id"] for it in p4}) == 2 and len({it["split"] for it in p4}) == 1
    if split["partition"] == "temporal":
        assert p4[0]["split"] == "test"  # latest case 2026-08-30 ≥ cutoff: no later material trains
    if split["partition"] == "external_site":
        assert p4[0]["split"] == "test"  # has a case at the test site


def test_temporal_split_requires_dates(clients):
    lead = clients("user-research-lead")
    ds = _create(lead, "t", eligible_review_states=["approved", "pending_review"], include_provenance=["demo_synthetic"])
    r = lead.post(f"/api/v1/datasets/{ds['id']}/splits", json={"partition": "temporal", "test_cutoff": "2026-06-01"})
    assert r.status_code == 200  # all included patients have dates
    bad = lead.post(f"/api/v1/datasets/{ds['id']}/splits", json={"partition": "temporal"})
    assert bad.status_code == 422


# --------------------------------------------------------------------------- Acceptance 7


def test_test_set_lock(clients, env):
    from dermpath.datasets import DatasetNotFrozen, training_eligible_items
    from dermpath.db import session_scope
    from dermpath.models import DatasetVersion

    lead = clients("user-research-lead")
    ds = _create(lead, "locked", eligible_review_states=["approved", "pending_review"],
                 split={"partition": "random", "seed": 0, "ratios": {"train": 0.5, "val": 0.25, "test": 0.25}})
    with session_scope() as db:
        with pytest.raises(DatasetNotFrozen):
            training_eligible_items(db, db.get(DatasetVersion, ds["id"]), "train")
    assert lead.get(f"/api/v1/datasets/{ds['id']}/items?purpose=train").status_code == 409
    _freeze(lead, ds["id"])
    m = _manifest(lead, ds["id"])["manifest"]
    test_ids = {it["slide_id"] for it in m["items"] if it["split"] == "test"}
    val_ids = {it["slide_id"] for it in m["items"] if it["split"] == "val"}
    assert test_ids, "the split must put at least one patient in test for this check"

    with session_scope() as db:
        dv = db.get(DatasetVersion, ds["id"])
        for purpose in ("train", "active_learning", "threshold_selection"):
            got = training_eligible_items(db, dv, purpose)
            assert not ({g["slide_id"] for g in got} & test_ids), purpose
            assert all(g["split"] != "test" for g in got)
        assert {g["slide_id"] for g in training_eligible_items(db, dv, "threshold_selection")} == val_ids
        assert {g["slide_id"] for g in training_eligible_items(db, dv, "test_evaluation")} == test_ids
        with pytest.raises(ValueError):
            training_eligible_items(db, dv, "anything_else")

    for purpose in ("train", "active_learning", "threshold_selection", "validation"):
        r = lead.get(f"/api/v1/datasets/{ds['id']}/items?purpose={purpose}").json()
        assert not ({i["slide_id"] for i in r["items"]} & test_ids)
    # Only the research lead may pull test items, and it is audited.
    assert clients("user-pathologist").get(f"/api/v1/datasets/{ds['id']}/items?purpose=test_evaluation").status_code == 403
    r = lead.get(f"/api/v1/datasets/{ds['id']}/items?purpose=test_evaluation")
    assert r.status_code == 200 and {i["slide_id"] for i in r.json()["items"]} == test_ids
    audit = lead.get(f"/api/v1/projects/{PID}/audit?entity_type=dataset_version").json()["items"]
    assert any(e["action"] == "dataset.test_items_accessed" for e in audit)
    assert lead.get(f"/api/v1/datasets/{ds['id']}/items?purpose=bogus").status_code == 422


@pytest.mark.parametrize("seed", range(8))
def test_test_lock_property_across_seeds(seed):
    """Pure check over random manifests: locked purposes never see test items."""
    from dermpath.datasets import training_eligible_items
    from dermpath.models import DatasetVersion

    rng = random.Random(seed)
    items = [{"slide_id": f"s{i}", "coded_patient_id": f"p{i % 7}", "split": rng.choice(["train", "val", "test"])}
             for i in range(50)]
    dv = DatasetVersion(id="x", status="frozen", manifest_json={"items": items})
    for purpose in ("train", "active_learning", "threshold_selection"):
        assert all(i["split"] != "test" for i in training_eligible_items(None, dv, purpose))


# --------------------------------------------------------------------------- Acceptance 8


def test_frozen_manifest_is_immutable_and_label_change_forces_new_version(clients, ids, env):
    from dermpath.db import session_scope
    from dermpath.models import DatasetItem, DatasetVersion, FrozenDatasetError, SplitAssignment

    lead, path = clients("user-research-lead"), clients("user-pathologist")
    ds = _create(lead, "frozen", split={"partition": "random", "seed": 2})
    frozen = _freeze(lead, ds["id"])
    sha = frozen["manifest_sha256"]
    assert frozen["status"] == "frozen" and frozen["manifest_verified"] is True and len(sha) == 64
    m1 = _manifest(lead, ds["id"])
    assert m1["verified"] is True and m1["manifest_sha256"] == sha
    items1 = {it["slide_id"]: it for it in m1["manifest"]["items"]}
    assert all(len(it["slide_sha256"]) == 64 and it["label_version_id"] and it["split"] for it in items1.values())

    # API-level: every mutation is refused.
    for url, body in ((f"/api/v1/datasets/{ds['id']}/refresh", None),
                      (f"/api/v1/datasets/{ds['id']}/splits", {"partition": "random", "seed": 9}),
                      (f"/api/v1/datasets/{ds['id']}/freeze", {})):
        r = lead.post(url, json=body) if body is not None else lead.post(url)
        assert r.status_code == 409 and r.json()["error"]["code"] in ("dataset_frozen",), (url, r.text)

    # ORM/session-level: any change, insert or delete is rejected.
    with session_scope() as db:
        dv = db.get(DatasetVersion, ds["id"])
        dv.name = "renamed"
        with pytest.raises(FrozenDatasetError):
            db.flush()
        db.rollback()
    with session_scope() as db:
        item = db.query(DatasetItem).filter_by(dataset_version_id=ds["id"]).first()
        item.label_value = "out_of_scope"  # differs from every seeded label value
        with pytest.raises(FrozenDatasetError):
            db.flush()
        db.rollback()
    with session_scope() as db:
        sa = db.query(SplitAssignment).filter_by(dataset_version_id=ds["id"]).first()
        patient_id = sa.coded_patient_id
        db.delete(sa)
        with pytest.raises(FrozenDatasetError):
            db.flush()
        db.rollback()
    with session_scope() as db:
        db.add(SplitAssignment(dataset_version_id=ds["id"], coded_patient_id=patient_id, split="test",
                               partition="random"))
        with pytest.raises(FrozenDatasetError):
            db.flush()
        db.rollback()
    # Raw SQL is stopped by the SQLite triggers too.
    from sqlalchemy.exc import DatabaseError

    with session_scope() as db:
        with pytest.raises(DatabaseError):
            db.execute(text("UPDATE dataset_version SET name='raw' WHERE id=:i"), {"i": ds["id"]})
        db.rollback()
    with session_scope() as db:
        with pytest.raises(DatabaseError):
            db.execute(text("DELETE FROM dataset_item WHERE dataset_version_id=:i"), {"i": ds["id"]})
        db.rollback()

    # A label changes after freeze (a new LabelVersion; the frozen manifest is untouched).
    sid = ids["slides"]["p1_a1_l2"]
    old_lv = items1[sid]["label_version_id"]
    r = path.post(f"/api/v1/slides/{sid}/labels", json={"value": "bcc_absent_not_benign",
                                                        "reason": "re-review after recut (fictional)"})
    assert r.status_code == 201
    new_lv = r.json()["id"]
    st = lead.get(f"/api/v1/datasets/{ds['id']}/staleness").json()
    assert st["stale"] is True and st["changed_labels"][0]["slide_id"] == sid
    assert st["changed_labels"][0]["dataset_label_version_id"] == old_lv
    assert st["changed_labels"][0]["current_label_version_id"] == new_lv and "new version" in st["action"]
    m1b = _manifest(lead, ds["id"])
    assert m1b["manifest_sha256"] == sha and m1b["verified"] is True and m1b["manifest"] == m1["manifest"]

    # The change requires a NEW version, which records its parent.
    assert lead.post(f"/api/v1/datasets/{ds['id']}/new-version", json={"reason": ""}).status_code == 422
    child = lead.post(f"/api/v1/datasets/{ds['id']}/new-version", json={"reason": "label changed after freeze"})
    assert child.status_code == 201
    c = child.json()
    assert c["parent_version_id"] == ds["id"] and c["version"] == 2 and c["status"] == "draft"
    assert c["lineage_id"] == frozen["lineage_id"] and c["config"]["split"]["seed"] == 2
    _freeze(lead, c["id"])
    m2 = _manifest(lead, c["id"])["manifest"]
    it2 = {it["slide_id"]: it for it in m2["items"]}
    assert it2[sid]["label_version_id"] == new_lv and it2[sid]["label_value"] == "bcc_absent_not_benign"
    assert m2["parent_version_id"] == ds["id"]
    assert _manifest(lead, ds["id"])["manifest_sha256"] == sha  # v1 never changed
    # A draft cannot spawn a child (refresh it instead).
    d = _create(lead, "draft-only")
    assert lead.post(f"/api/v1/datasets/{d['id']}/new-version", json={"reason": "x"}).status_code == 409


def test_export_and_summary(clients, ids):
    """Export and summary. Changed by design (docs/ml-engine-design.md §2): the manifest schema is now
    ``dermpath.dataset_manifest/2`` (data_mode, patient_label_rule, split family and fingerprint, split diagnostics,
    near-duplicate decisions, per-item QC inputs, audit block, python_version)."""
    lead = clients("user-research-lead")
    ds = _create(lead, "export", split={"partition": "random", "seed": 4})
    assert lead.get(f"/api/v1/datasets/{ds['id']}/export").status_code == 409  # draft
    _freeze(lead, ds["id"])
    j = lead.get(f"/api/v1/datasets/{ds['id']}/export?format=json")
    assert j.status_code == 200 and "attachment" in j.headers["content-disposition"]
    body = j.json()
    assert body["manifest"]["schema"] == "dermpath.dataset_manifest/2" and len(body["manifest_sha256"]) == 64
    c = lead.get(f"/api/v1/datasets/{ds['id']}/export?format=csv")
    lines = [ln for ln in c.text.splitlines() if not ln.startswith("#")]
    rows = list(csv.DictReader(io.StringIO("\n".join(lines))))
    assert len(rows) == len(APPROVED) and {"slide_sha256", "label_version_id", "split", "patient_code"} <= set(rows[0])

    s = lead.get(f"/api/v1/datasets/{ds['id']}/summary").json()
    assert s["counts"]["patients"] == 4 and s["counts"]["slides"] == len(APPROVED) and s["counts"]["cases"] == 5
    assert s["counts"]["patches"] is None
    assert s["label_balance"]["bcc_present"]["slides"] == 5 and s["label_balance"]["bcc_absent_not_benign"]["slides"] == 3
    assert "NOT the same as benign" in s["label_balance"]["bcc_absent_not_benign"]["display"]
    assert set(s["batches"]["site"]) == {"site-north", "site-south"} and set(s["batches"]["scanner"]) == {"scanner-a", "scanner-b"}
    assert s["missing_metadata"]["mpp"]["count"] == len(APPROVED)  # synthetic tiles have no calibration
    assert s["synthetic_only"] is True and "PIPELINE TEST" in s["notice"]
    ra = s["reviewer_agreement"]
    assert ra["targets_with_2plus_readers"] == 4 and ra["reader_pairs"] == 4 and ra["agreeing_pairs"] == 2
    assert ra["observed_agreement"] == 0.5 and "insufficient evidence" in ra["cohen_kappa"]
    near = s["duplicates"]["near_duplicate_candidates"]
    pair = {ids["slides"]["p1_a1_l1"], ids["slides"]["p5_a1_l1_neardup"]}
    match = [n for n in near if {n["slide_a"], n["slide_b"]} == pair]
    assert match and match[0]["same_patient"] is False and match[0]["status"] == "candidate_for_human_review"
    assert s["duplicates"]["exact_within_dataset"] == []
    # A human decision is recorded; nothing is removed.
    r = clients("user-pathologist").post(f"/api/v1/projects/{PID}/near-duplicates/review", json={
        "slide_a_id": ids["slides"]["p1_a1_l1"], "slide_b_id": ids["slides"]["p5_a1_l1_neardup"],
        "decision": "duplicate", "reason": "same section rescanned (fictional)"})
    assert r.status_code == 201
    s2 = lead.get(f"/api/v1/datasets/{ds['id']}/summary").json()
    m = [n for n in s2["duplicates"]["near_duplicate_candidates"] if {n["slide_a"], n["slide_b"]} == pair][0]
    assert m["human_decision"]["decision"] == "duplicate" and s2["counts"]["slides"] == len(APPROVED)


def test_freeze_with_open_qc_issue_requires_acknowledgement_recorded_in_manifest(clients, ids):
    """A summary warning is enforced: an open, person-raised QC issue blocks freeze until acknowledged with a reason,
    and the acknowledgement is written into the immutable manifest."""
    lead, asst = clients("user-research-lead"), clients("user-assistant")
    sid = ids["slides"]["p1_a1_l1"]
    issue = asst.post(f"/api/v1/slides/{sid}/qc/issues", json={"category": "fold", "note": "fold near the edge"})
    assert issue.status_code in (200, 201), issue.text
    ds = _create(lead, "gate", split={"partition": "random", "seed": 4})

    check = lead.get(f"/api/v1/datasets/{ds['id']}/freeze-check").json()
    assert check["requires_acknowledgement"] is True
    assert any(w["slide_id"] == sid for w in check["open_qc_issues"])
    assert check["slides"][sid]["accession_code"] and check["slides"][sid]["part"]

    refused = lead.post(f"/api/v1/datasets/{ds['id']}/freeze", json={"reason": "x"})
    assert refused.status_code == 409, refused.text
    err = refused.json()["error"]
    assert err["code"] == "freeze_warnings_unacknowledged"
    assert any(w["slide_id"] == sid for w in err["details"]["open_qc_issues"])
    assert lead.get(f"/api/v1/datasets/{ds['id']}").json()["status"] == "draft"

    no_reason = lead.post(f"/api/v1/datasets/{ds['id']}/freeze", json={"acknowledge_warnings": True})
    assert no_reason.status_code == 422 and no_reason.json()["error"]["code"] == "reason_required"

    ok = lead.post(f"/api/v1/datasets/{ds['id']}/freeze",
                   json={"acknowledge_warnings": True, "reason": "fold is outside the tissue used for this study"})
    assert ok.status_code == 200, ok.text
    ack = _manifest(lead, ds["id"])["manifest"]["acknowledged_warnings"]
    assert ack["reason"] == "fold is outside the tissue used for this study"
    assert any(w["slide_id"] == sid for w in ack["open_qc_issues"])


# --------------------------------------------------------------------------- design §2: families, staleness, data mode

COHORT = "proj-synthetic-cohort"
PATHOLOGIST = ("user-pathologist", "pathologist", "Dr. Imani Castell")
LEAD_ACTOR = ("user-research-lead", "research_lead", "Priya Navarro")


def _actor(t):
    from dermpath.auth import Actor

    return Actor(*t)


def _add_patient(db, project_id: str, code: str, labels: list[str], *, site: str = "site-north",
                 collected: date = date(2026, 6, 1), provenance: str = "demo_synthetic",
                 image_kind: str = "synthetic_tiles") -> str:
    """A coded patient with one case, one block and one approved, expert-labelled slide per label (fixture)."""
    import hashlib

    from dermpath.labels import create_expert_label
    from dermpath.models import Block, Case, CodedPatient, Slide, SpecimenPart
    from dermpath.review import set_review_state

    patient = CodedPatient(project_id=project_id, code=code, created_by="test")
    db.add(patient)
    db.flush()
    case = Case(project_id=project_id, coded_patient_id=patient.id, accession_code=f"ACC-{code}", collected_on=collected,
                site_id=site, provenance=provenance)
    db.add(case)
    db.flush()
    part = SpecimenPart(project_id=project_id, case_id=case.id, designation="A")
    db.add(part)
    db.flush()
    block = Block(project_id=project_id, part_id=part.id, designation="A1")
    db.add(block)
    db.flush()
    for i, value in enumerate(labels):
        slide = Slide(project_id=project_id, block_id=block.id, level_index=i + 1, stain="H&E", scanner_id="scanner-a",
                      provenance=provenance, image_kind=image_kind, object_key=f"test/{code}/{i}",
                      sha256=hashlib.sha256(f"{project_id}|{code}|{i}".encode()).hexdigest(), ingest_status="succeeded")
        db.add(slide)
        db.flush()
        create_expert_label(db, _actor(PATHOLOGIST), slide, scope="slide", target_id=None, value=value,
                            reason="test fixture label (fictional)")
        set_review_state(db, None, slide, "approved", reason=None, system=True)
    return patient.id


def _split_by_code(manifest: dict) -> dict[str, str]:
    return {s["patient_code"]: s["split"] for s in manifest["splits"]}


def test_child_version_inherits_splits_after_label_changes_and_new_patients(clients, ids):
    """Split family (design §2): a child version keeps every existing patient's split whatever their labels are now;
    only new patients are allocated. Re-seeding the child is refused (409 family_split_locked); a new lineage with
    a reason may re-split."""
    from dermpath.db import session_scope
    from dermpath.splits import split_fingerprint

    lead, path = clients("user-research-lead"), clients("user-pathologist")
    v1 = ids["ml_demo"]["cohort"]["dataset_version_id"]
    m1 = _manifest(lead, v1)["manifest"]
    split1 = _split_by_code(m1)
    assert len(split1) == 60 and m1["split_family_id"] and m1["data_mode"] == "synthetic"
    assert m1["split_fingerprint"] == split_fingerprint(split1.items())
    # Both classes in val and test (the old allocator gave a label-blind cut).
    per = m1["split_diagnostics"]["per_split_class"]
    assert all(per[sp][c]["patients"] >= 1 for sp in ("val", "test") for c in ("bcc_present", "bcc_absent_not_benign"))
    assert m1["split_diagnostics"]["mixed_label_patients"]["count"] == 13

    # Labels change on several slides, and nine new patients arrive (three positive).
    flipped = 0
    for it in m1["items"][:12:3]:
        new = "bcc_absent_not_benign" if it["label_value"] == "bcc_present" else "bcc_present"
        r = path.post(f"/api/v1/slides/{it['slide_id']}/labels", json={"value": new, "reason": "re-read (fictional)"})
        assert r.status_code == 201, r.text
        flipped += 1
    with session_scope() as db:
        for i in range(9):
            _add_patient(db, COHORT, f"NEW-{i:02d}", ["bcc_present" if i % 3 == 0 else "bcc_absent_not_benign"],
                         site="site-east")

    child = lead.post(f"/api/v1/datasets/{v1}/new-version", json={"reason": "labels corrected; new patients"})
    assert child.status_code == 201, child.text
    c = child.json()
    fam = c["config"]["split_diagnostics"]["family"]
    assert fam["inherited"] == 60 and fam["new"] == 9 and fam["locked"] is True
    assert fam["split_family_id"] == m1["split_family_id"]

    # Re-seeding or re-partitioning the child is refused; the same configuration is accepted.
    same = {k: v for k, v in c["config"]["split"].items() if k not in ("algorithm",)}
    for bad in ({**same, "seed": 12}, {"partition": "temporal", "test_cutoff": "2026-06-01"}):
        r = lead.post(f"/api/v1/datasets/{c['id']}/splits", json=bad)
        assert r.status_code == 409 and r.json()["error"]["code"] == "family_split_locked", r.text
    assert lead.post(f"/api/v1/datasets/{c['id']}/splits", json=same).status_code == 200

    _freeze(lead, c["id"])
    m2 = _manifest(lead, c["id"])["manifest"]
    split2 = _split_by_code(m2)
    assert all(split2[code] == sp for code, sp in split1.items())  # nobody moved
    assert m2["split_family_id"] == m1["split_family_id"]
    assert m2["split_family_counts"] == {"inherited": 60, "new": 9, "dropped": 0}
    new_splits = Counter(split2[f"NEW-{i:02d}"] for i in range(9))
    assert sum(new_splits.values()) == 9 and set(new_splits) <= {"train", "val", "test"}
    assert sum(m2["split_diagnostics"]["per_split_class"][sp][c]["patients"]
               for sp in ("train", "val", "test") for c in ("bcc_present", "bcc_absent_not_benign")) == 69
    assert m2["split_fingerprint"] == split_fingerprint(split2.items()) != m1["split_fingerprint"]

    # A different split needs a new lineage (and a reason).
    r = lead.post(f"/api/v1/datasets/{c['id']}/new-version", json={"reason": "x", "split": {"partition": "random", "seed": 5}})
    assert r.status_code == 409 and r.json()["error"]["code"] == "family_split_locked"
    r = lead.post(f"/api/v1/datasets/{c['id']}/new-version",
                  json={"reason": "re-split for a separate study", "new_lineage": True,
                        "split": {"partition": "random", "seed": 5}})
    assert r.status_code == 201, r.text
    nl = r.json()
    assert nl["lineage_id"] != c["lineage_id"] and nl["version"] == 1 and nl["parent_version_id"] == c["id"]
    assert nl["config"]["split"]["seed"] == 5 and nl["config"]["split_diagnostics"]["family"]["locked"] is False


def test_sealed_test_patients_never_move(clients, ids):
    """A test release seals the family's test patients: they stay test in every later version, also in a new
    lineage started from the sealed one; freeze verifies it and the rows cannot be changed or deleted."""
    from sqlalchemy.exc import DatabaseError

    from dermpath.datasets import _family_freeze_check, freeze, seal_test_patients
    from dermpath.db import session_scope
    from dermpath.errors import ApiError
    from dermpath.models import DatasetVersion, ImmutableRecordError, SplitAssignment, SplitFamilyAssignment

    lead = clients("user-research-lead")
    v1 = ids["ml_demo"]["cohort"]["dataset_version_id"]
    split1 = _split_by_code(_manifest(lead, v1)["manifest"])
    test_codes = sorted(c for c, s in split1.items() if s == "test")
    with session_scope() as db:
        dv = db.get(DatasetVersion, v1)
        with pytest.raises(ApiError) as exc:
            seal_test_patients(db, dv, "  ")
        assert exc.value.code == "reason_required"
        out = seal_test_patients(db, dv, "test release #1 (fictional)", actor=_actor(LEAD_ACTOR))
        assert out["sealed"] == len(test_codes) == 12 and out["patient_codes"] == test_codes
    with session_scope() as db:
        again = seal_test_patients(db, db.get(DatasetVersion, v1), "second call")
        assert again["sealed"] == 0 and again["already_sealed"] == 12

    # A new lineage with another seed still keeps every sealed patient in test.
    r = lead.post(f"/api/v1/datasets/{v1}/new-version",
                  json={"reason": "new study on the same cohort", "new_lineage": True,
                        "split": {"partition": "random", "seed": 77}})
    assert r.status_code == 201, r.text
    nl = r.json()
    assert nl["config"]["split_diagnostics"]["family"]["sealed_patients_pinned"] == 12
    with session_scope() as db:
        from dermpath.datasets import item_rows

        rows = item_rows(db, db.get(DatasetVersion, nl["id"]))
        assert {r["patient_code"] for r in rows if r["split"] == "test"} >= set(test_codes)
        # Moving a sealed patient by hand: freeze refuses.
        sealed_pid = next(r["coded_patient_id"] for r in rows if r["patient_code"] == test_codes[0])
        sa = db.query(SplitAssignment).filter_by(dataset_version_id=nl["id"], coded_patient_id=sealed_pid).one()
        sa.split = "train"
        db.flush()
        dv = db.get(DatasetVersion, nl["id"])
        with pytest.raises(ApiError) as exc:
            _family_freeze_check(db, dv)
        assert exc.value.code == "sealed_patient_moved"
        with pytest.raises(ApiError) as exc:
            freeze(db, _actor(LEAD_ACTOR), dv, reason="x", acknowledge_warnings=True)
        assert exc.value.status == 409 and exc.value.code in ("draft_stale", "sealed_patient_moved")
        db.rollback()

    # Family rows are immutable: split never changes, sealing happens once, nothing is deleted.
    with session_scope() as db:
        a = db.query(SplitFamilyAssignment).filter(SplitFamilyAssignment.sealed_at.is_not(None)).first()
        a.split = "train"
        with pytest.raises(ImmutableRecordError):
            db.flush()
        db.rollback()
    with session_scope() as db:
        a = db.query(SplitFamilyAssignment).filter(SplitFamilyAssignment.sealed_at.is_not(None)).first()
        a.sealed_reason = "rewritten"
        with pytest.raises(ImmutableRecordError):
            db.flush()
        db.rollback()
    with session_scope() as db:
        a = db.query(SplitFamilyAssignment).first()
        db.delete(a)
        with pytest.raises(ImmutableRecordError):
            db.flush()
        db.rollback()
    with session_scope() as db:
        with pytest.raises(DatabaseError):
            db.execute(text("UPDATE split_family_assignment SET split='train' WHERE split='test'"))
        db.rollback()
    with session_scope() as db:
        with pytest.raises(DatabaseError):
            db.execute(text("UPDATE split_family SET partition_json='{}'"))
        db.rollback()
    with session_scope() as db:
        with pytest.raises(DatabaseError):
            db.execute(text("DELETE FROM split_family"))
        db.rollback()


def test_root_draft_may_be_reseeded_until_the_lineage_is_frozen(clients):
    from dermpath.db import session_scope
    from dermpath.models import SplitFamily

    lead = clients("user-research-lead")
    ds = _create(lead, "reseed", split={"partition": "random", "seed": 1})
    fam_id = ds["config"]["split_diagnostics"]["family"]["split_family_id"]
    r = lead.post(f"/api/v1/datasets/{ds['id']}/splits", json={"partition": "random", "seed": 2})
    assert r.status_code == 200 and r.json()["diagnostics"]["family"]["split_family_id"] == fam_id
    with session_scope() as db:
        assert db.get(SplitFamily, fam_id).partition_json["seed"] == 2


def test_diagnostics_are_persisted_on_every_path(clients):
    """Split diagnostics are stored in the config on create, refresh and POST splits (new_version: see the family
    test), and in the manifest; audit events carry a summary."""
    lead = clients("user-research-lead")
    ds = _create(lead, "diag", split={"partition": "random", "seed": 3})
    d = ds["config"]["split_diagnostics"]
    assert d["algorithm"] == "dermpath.splits/3" and d["patient_label_rule"] == "any_positive"
    assert {"per_split_class", "class_absent", "mixed_label_patients", "targets", "family"} <= set(d)
    refreshed = lead.post(f"/api/v1/datasets/{ds['id']}/refresh").json()
    assert refreshed["config"]["split_diagnostics"]["patients_per_split"] == d["patients_per_split"]
    assert refreshed["refresh"]["data_mode"]["mode"] == "synthetic"
    r = lead.post(f"/api/v1/datasets/{ds['id']}/splits", json={"partition": "random", "seed": 3,
                                                               "patient_label_rule": "majority"}).json()
    assert r["diagnostics"]["patient_label_rule"] == "majority"
    assert lead.get(f"/api/v1/datasets/{ds['id']}").json()["config"]["split_diagnostics"]["patient_label_rule"] == "majority"
    _freeze(lead, ds["id"])
    m = _manifest(lead, ds["id"])["manifest"]
    assert m["split_diagnostics"]["patient_label_rule"] == "majority" and m["patient_label_rule"] == "majority"
    assert "split_diagnostics" not in m["config"]
    events = lead.get(f"/api/v1/projects/{PID}/audit?entity_type=dataset_version").json()["items"]
    created = [e for e in events if e["action"] == "dataset.draft_created" and e["entity_id"] == ds["id"]]
    assert created and created[0]["after"]["split"]["patients_per_split"] == d["patients_per_split"]


def test_split_validation_through_the_api(clients):
    lead = clients("user-research-lead")
    r = lead.post(f"/api/v1/projects/{PID}/datasets",
                  json={"name": "x", "config": {"split": {"partition": "external_site", "test_sites": ["site-South"]}}})
    assert r.status_code == 422 and r.json()["error"]["code"] == "unknown_site"
    assert r.json()["error"]["details"]["known"] == ["site-north", "site-south"]
    ds = _create(lead, "v")
    for body, code in (({"partition": "temporal", "test_cutoff": "2026-06-01", "seed": 3}, "unused_split_parameter"),
                       ({"partition": "temporal", "test_cutoff": "2026-06-01", "val_cutoff": "2026-06-01"}, "invalid_cutoff"),
                       ({"partition": "external_site", "test_sites": ["site-south"],
                         "ratios": {"train": 0.6, "val": 0.2, "test": 0.2}}, "test_ratio_not_allowed"),
                       ({"partition": "random", "ratios": {"train": 0.6, "val": 0.2, "test": 0.2, "x": 0}}, "invalid_ratios")):
        r = lead.post(f"/api/v1/datasets/{ds['id']}/splits", json=body)
        assert r.status_code == 422 and r.json()["error"]["code"] == code, (body, r.text)
    r = lead.post(f"/api/v1/datasets/{ds['id']}/splits", json={"partition": "external_site", "test_sites": ["site-south"]})
    assert r.status_code == 200
    diag = r.json()["diagnostics"]
    assert diag["rule"].startswith("a patient with ANY case") and "seed" in diag and "remainder_targets" in diag
    assert r.json()["split"]["ratios"] == {"train": 0.75, "val": 0.25}


def test_freeze_refuses_a_stale_draft_with_the_diff(clients, ids):
    """freeze() re-materialises in the same transaction: a slide moved to another patient, a label changed or a slide
    excluded after the draft was materialised gives 409 draft_stale with the diff; after a refresh it freezes and
    the manifest carries the snapshot (one split per patient, also for the moved slide)."""
    from dermpath.db import session_scope
    from dermpath.models import Slide

    lead, path = clients("user-research-lead"), clients("user-pathologist")
    ds = _create(lead, "stale", split={"partition": "random", "seed": 1})
    moved = ids["slides"]["p2_a1_l1"]
    with session_scope() as db:
        target_block = db.get(Slide, ids["slides"]["p5_a1_l2"]).block_id
        db.get(Slide, moved).block_id = target_block
    check = lead.get(f"/api/v1/datasets/{ds['id']}/freeze-check").json()
    assert [b["code"] for b in check["blockers"]] == ["draft_stale"]
    r = lead.post(f"/api/v1/datasets/{ds['id']}/freeze", json={"reason": "x", "acknowledge_warnings": True})
    assert r.status_code == 409 and r.json()["error"]["code"] == "draft_stale", r.text
    diff = r.json()["error"]["details"]["diff"]
    changed = {c["slide_id"]: c["fields"] for c in diff["items_changed"]}
    assert set(changed[moved]) >= {"coded_patient_id", "patient_code", "accession_code", "block_id", "case_id"}
    assert changed[moved]["patient_code"] == ["P-0002", "P-0005"]
    assert lead.get(f"/api/v1/datasets/{ds['id']}").json()["status"] == "draft"
    lead.post(f"/api/v1/datasets/{ds['id']}/refresh")
    _freeze(lead, ds["id"])
    m = _manifest(lead, ds["id"])["manifest"]
    row = next(it for it in m["items"] if it["slide_id"] == moved)
    assert row["patient_code"] == "P-0005"
    by_patient: dict[str, set] = {}
    for it in m["items"]:
        by_patient.setdefault(it["patient_code"], set()).add(it["split"])
    assert all(len(s) == 1 for s in by_patient.values())

    # A label change after materialise.
    ds2 = _create(lead, "stale-label", split={"partition": "random", "seed": 1})
    sid = ids["slides"]["p1_a1_l2"]
    assert path.post(f"/api/v1/slides/{sid}/labels", json={"value": "bcc_absent_not_benign",
                                                           "reason": "re-read (fictional)"}).status_code == 201
    r = lead.post(f"/api/v1/datasets/{ds2['id']}/freeze", json={"reason": "x", "acknowledge_warnings": True})
    assert r.status_code == 409 and r.json()["error"]["code"] == "draft_stale"
    fields = {c["slide_id"]: c["fields"] for c in r.json()["error"]["details"]["diff"]["items_changed"]}[sid]
    assert fields["label_value"] == ["bcc_present", "bcc_absent_not_benign"] and "label_version_id" in fields

    # An exclusion after materialise.
    ds3 = _create(lead, "stale-exclusion", split={"partition": "random", "seed": 1})
    assert path.post(f"/api/v1/slides/{ids['slides']['p4_a1_l1']}/review-state",
                     json={"state": "excluded", "reason": "tear (fictional)"}).status_code == 200
    r = lead.post(f"/api/v1/datasets/{ds3['id']}/freeze", json={"reason": "x", "acknowledge_warnings": True})
    assert r.status_code == 409 and r.json()["error"]["details"]["diff"]["items_removed"] == [ids["slides"]["p4_a1_l1"]]


def test_mixed_data_mode_is_refused_and_real_items_need_calibration(clients, ids):
    """A dataset never mixes demo_synthetic procedural tiles with real images: refused at freeze (409
    mixed_data_mode) and reported earlier (materialise result, freeze-check). Real items without mpp are a warning
    that needs acknowledgement."""
    from dermpath.db import session_scope
    from dermpath.labels import create_expert_label
    from dermpath.models import Slide
    from dermpath.review import set_review_state

    lead = clients("user-research-lead")
    cmu = ids["slides"]["cmu_cc0"]
    with session_scope() as db:
        s = db.get(Slide, cmu)
        assert s.provenance == "public_cc0" and s.mpp_x
        if s.review_state != "approved":
            set_review_state(db, None, s, "approved", reason=None, system=True)
        create_expert_label(db, _actor(PATHOLOGIST), s, scope="slide", target_id=None, value="bcc_absent_not_benign",
                            reason="test fixture label on the public slide (fictional)")
    ds = _create(lead, "mixed", split={"partition": "random", "seed": 0})  # default include_provenance: all three
    refreshed = lead.post(f"/api/v1/datasets/{ds['id']}/refresh").json()["refresh"]
    assert refreshed["data_mode"]["mode"] == "mixed" and refreshed["data_mode"]["item_counts"] == {"real": 1, "synthetic": 8}
    check = lead.get(f"/api/v1/datasets/{ds['id']}/freeze-check").json()
    assert check["data_mode"] == "mixed" and "mixed_data_mode" in [b["code"] for b in check["blockers"]]
    r = lead.post(f"/api/v1/datasets/{ds['id']}/freeze", json={"reason": "x", "acknowledge_warnings": True})
    assert r.status_code == 409 and r.json()["error"]["code"] == "mixed_data_mode"

    synthetic = _create(lead, "synthetic-only", include_provenance=["demo_synthetic"], split={"partition": "random"})
    assert lead.get(f"/api/v1/datasets/{synthetic['id']}/freeze-check").json()["uncalibrated_items"] == []
    _freeze(lead, synthetic["id"])
    assert _manifest(lead, synthetic["id"])["manifest"]["data_mode"] == "synthetic"

    with session_scope() as db:
        s = db.get(Slide, cmu)
        s.mpp_x = s.mpp_y = None
    real = _create(lead, "real-only", include_provenance=["public_cc0"], split={"partition": "random"})
    check = lead.get(f"/api/v1/datasets/{real['id']}/freeze-check").json()
    assert check["data_mode"] == "real" and check["blockers"] == []
    assert check["uncalibrated_items"] == [{"slide_id": cmu, "missing": ["mpp_x", "mpp_y"]}]
    assert check["requires_acknowledgement"] is True and cmu in check["slides"]
    r = lead.post(f"/api/v1/datasets/{real['id']}/freeze", json={"reason": "x"})
    assert r.status_code == 409 and r.json()["error"]["code"] == "freeze_warnings_unacknowledged"
    _freeze(lead, real["id"])
    m = _manifest(lead, real["id"])["manifest"]
    assert m["data_mode"] == "real" and m["synthetic_only"] is False
    assert m["acknowledged_warnings"]["uncalibrated_items"][0]["slide_id"] == cmu


def _cross_split_seed(lead, pair: set[str]) -> int:
    for seed in range(40):
        ds = _create(lead, f"probe-{seed}", split={"partition": "random", "seed": seed})
        check = lead.get(f"/api/v1/datasets/{ds['id']}/freeze-check").json()
        if any({c["slide_a"], c["slide_b"]} == pair for c in check["unreviewed_near_duplicates"]):
            return seed
    raise AssertionError("no seed puts the near-duplicate pair in different splits")


def test_near_duplicate_decisions_only_distinct_clears_duplicate_groups(clients, ids):
    """Near-duplicate semantics (design §2): 'unsure' keeps blocking like an unreviewed pair; only 'distinct'
    clears the warning; 'duplicate' becomes a grouping constraint (both patients in one split), and a duplicate
    decision recorded after materialise makes the draft stale until it is refreshed."""
    lead, path = clients("user-research-lead"), clients("user-pathologist")
    a, b = ids["slides"]["p1_a1_l1"], ids["slides"]["p5_a1_l1_neardup"]
    seed = _cross_split_seed(lead, {a, b})
    ds = _create(lead, "neardup", split={"partition": "random", "seed": seed})

    def decide(decision):
        r = path.post(f"/api/v1/projects/{PID}/near-duplicates/review",
                      json={"slide_a_id": a, "slide_b_id": b, "decision": decision, "reason": "test (fictional)"})
        assert r.status_code == 201

    def pair_in(check, key):
        return any({c["slide_a"], c["slide_b"]} == {a, b} for c in check[key])

    decide("unsure")
    check = lead.get(f"/api/v1/datasets/{ds['id']}/freeze-check").json()
    assert pair_in(check, "unsure_near_duplicates") and not pair_in(check, "unreviewed_near_duplicates")
    assert check["requires_acknowledgement"] is True
    decide("distinct")
    check = lead.get(f"/api/v1/datasets/{ds['id']}/freeze-check").json()
    assert not any(pair_in(check, k) for k in ("unsure_near_duplicates", "unreviewed_near_duplicates",
                                               "duplicates_across_splits"))
    decide("duplicate")
    check = lead.get(f"/api/v1/datasets/{ds['id']}/freeze-check").json()
    assert pair_in(check, "duplicates_across_splits")
    assert "draft_stale" in [x["code"] for x in check["blockers"]]  # the grouping would change the allocation
    r = lead.post(f"/api/v1/datasets/{ds['id']}/freeze", json={"reason": "x", "acknowledge_warnings": True})
    assert r.status_code == 409 and r.json()["error"]["code"] == "draft_stale"
    assert r.json()["error"]["details"]["diff"]["splits_changed"]
    refreshed = lead.post(f"/api/v1/datasets/{ds['id']}/refresh").json()
    assert refreshed["refresh"]["split"]["grouping"]["constraints_applied"] == 1
    check = lead.get(f"/api/v1/datasets/{ds['id']}/freeze-check").json()
    assert not pair_in(check, "duplicates_across_splits") and check["blockers"] == []
    _freeze(lead, ds["id"])
    m = _manifest(lead, ds["id"])["manifest"]
    items = {it["slide_id"]: it for it in m["items"]}
    assert items[a]["split"] == items[b]["split"]
    decisions = [d for d in m["near_duplicate_decisions"] if {d["slide_a"], d["slide_b"]} == {a, b}]
    assert decisions and decisions[0]["decision"] == "duplicate" and decisions[0]["both_in_dataset"] is True


def test_manifest_records_qc_inputs_environment_and_audit(clients, ids, run_worker):
    import hashlib

    from dermpath.storage import get_store

    lead, asst = clients("user-research-lead"), clients("user-assistant")
    sid = ids["slides"]["p1_a1_l2"]
    assert asst.post(f"/api/v1/slides/{sid}/qc/screen").status_code == 202
    run_worker()
    ds = _create(lead, "qc-inputs", split={"partition": "random", "seed": 2})
    _freeze(lead, ds["id"])
    m = _manifest(lead, ds["id"])["manifest"]
    items = {it["slide_id"]: it for it in m["items"]}
    it = items[sid]
    assert it["qc_review_id"] and it["mask_object_key"]
    assert it["mask_sha256"] == hashlib.sha256(get_store().get_bytes(it["mask_object_key"])).hexdigest()
    assert it["excluded_region_issue_ids"] == [] and len(it["excluded_regions_sha256"]) == 64
    unscreened = items[ids["slides"]["p2_a1_l1"]]
    assert unscreened["qc_review_id"] is None and unscreened["mask_sha256"] is None
    assert it["label_source"] in ("single_reader", "agreed", "adjudicated")
    assert m["python_version"].count(".") == 2 and m["audit"]["schema"] == "dermpath.dataset_audit/1"
    assert m["data_mode"] == "synthetic" and m["positive_class"] == "bcc_present"
    assert m["split_family_counts"] == {"inherited": 0, "new": 4, "dropped": 0}
    # The workflow cohort is tiny: the negative class cannot reach every split, which needed an acknowledgement.
    assert {a["split"] for a in m["acknowledged_warnings"]["class_absent"]} <= {"val", "test", "train"}
    assert m["acknowledged_warnings"]["mixed_label_patients"]["count"] == 2
