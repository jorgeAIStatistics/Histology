"""Acceptance 5 (approval/exclusion change training eligibility), 6 (all slides of a patient
stay in one split), 7 (test items never reach train / active learning / threshold selection)
and 8 (frozen manifests are immutable; a label change forces a new version)."""

from __future__ import annotations

import csv
import io
import random
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
    lead = clients("user-research-lead")
    ds = _create(lead, "export", split={"partition": "random", "seed": 4})
    assert lead.get(f"/api/v1/datasets/{ds['id']}/export").status_code == 409  # draft
    _freeze(lead, ds["id"])
    j = lead.get(f"/api/v1/datasets/{ds['id']}/export?format=json")
    assert j.status_code == 200 and "attachment" in j.headers["content-disposition"]
    body = j.json()
    assert body["manifest"]["schema"] == "dermpath.dataset_manifest/1" and len(body["manifest_sha256"]) == 64
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
