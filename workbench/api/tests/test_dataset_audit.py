"""Dataset audit (design §9): association statistics (pure) and GET /datasets/{id}/audit contents."""

from __future__ import annotations

import json
import math

import pytest

PID = "proj-bcc-demo"


def _create(lead, name, **config):
    r = lead.post(f"/api/v1/projects/{PID}/datasets", json={"name": name, "config": config})
    assert r.status_code == 201, r.text
    return r.json()


def _freeze(lead, dsid):
    r = lead.post(f"/api/v1/datasets/{dsid}/freeze", json={"reason": "audit test", "acknowledge_warnings": True})
    assert r.status_code == 200, r.text


# --------------------------------------------------------------------------- statistics (pure)


def test_association_matches_scipy_and_definitions():
    from scipy.stats import chi2_contingency, fisher_exact

    from dermpath.dataset_audit import association

    perfect = {"pos": {"a": 6, "b": 0}, "neg": {"a": 0, "b": 6}}
    out = association(perfect)
    assert out["cramers_v"] == 1.0 and out["test"].startswith("fisher_exact")
    assert out["p_value"] == round(fisher_exact([[6, 0], [0, 6]])[1], 6) and out["n"] == 12
    assert association({"pos": {"a": 5, "b": 5}, "neg": {"a": 5, "b": 5}})["cramers_v"] == 0.0
    three = {"pos": {"a": 10, "b": 4, "c": 1}, "neg": {"a": 3, "b": 8, "c": 9}}
    got = association(three)
    chi2, p, dof, _ = chi2_contingency([[10, 4, 1], [3, 8, 9]], correction=False)
    assert got["test"].startswith("chi_square") and got["dof"] == dof == 2
    assert got["p_value"] == round(p, 6) and got["cramers_v"] == round(math.sqrt(chi2 / 35), 4)
    assert got["low_expected_counts"] is True  # expected counts below 5 are flagged, not hidden


@pytest.mark.parametrize("table", [{}, {"pos": {"a": 3}}, {"pos": {"a": 3, "b": 1}}, {"pos": {"a": 0}, "neg": {"a": 0}}])
def test_association_undefined_is_none_with_a_reason(table):
    from dermpath.dataset_audit import association

    out = association(table)
    assert out["cramers_v"] is None and out["p_value"] is None and out["undefined_reason"]
    json.dumps(out, allow_nan=False)  # never NaN


def test_contingency_and_patient_attribute():
    from dermpath.dataset_audit import contingency, patient_attribute

    assert contingency([("pos", "b"), ("pos", "a"), ("neg", "a"), ("pos", "a")]) == {
        "neg": {"a": 1}, "pos": {"a": 2, "b": 1}}
    assert patient_attribute(["site-a", "site-a", None]) == "site-a"
    assert patient_attribute(["site-a", "site-b"]) == "multiple"
    assert patient_attribute([None, ""]) == "unknown"


# --------------------------------------------------------------------------- GET /datasets/{id}/audit


def test_audit_contents_for_the_workflow_draft(clients, ids):
    lead = clients("user-research-lead")
    ds = _create(lead, "audit", split={"partition": "random", "seed": 2})
    r = clients("user-pathologist").get(f"/api/v1/datasets/{ds['id']}/audit")  # dataset.read is enough
    assert r.status_code == 200, r.text
    a = r.json()
    assert a["schema"] == "dermpath.dataset_audit/1" and a["status"] == "draft" and a["research_use_only"] is True
    pi = a["patient_independence"]
    assert pi["patients_in_more_than_one_split"] == [] and pi["live_lineage"]["moved_count"] == 0
    assert pi["live_lineage"]["patients_spanning_splits_now"] == []
    assert a["mixed_label_patients"]["count"] == 2 and a["mixed_label_patients"]["patient_codes"] == ["P-0001", "P-0004"]
    assert a["missing_metadata"]["mpp"] == {"count": 8, "fraction": 1.0}  # synthetic tiles carry no calibration
    assert a["missing_metadata"]["site_id"]["count"] == 0
    assert a["label_scope"] == {"scope": "slide", "items_with_other_scope": [], "cases_with_inconsistent_labels": []}
    assert a["duplicates"]["exact_within_dataset"] == [] and a["duplicates"]["exact_in_other_projects"] == 0
    assert a["duplicates"]["near_duplicate_candidates"] >= 1
    assert a["data_mode"]["mode"] == "synthetic"
    balance = a["class_balance"]
    assert sum(balance[sp][c]["patients"] for sp in balance for c in balance[sp]) == 4
    assert sum(balance[sp][c]["slides"] for sp in balance for c in balance[sp]) == 8
    conf = a["confounding"]
    for key in ("label_by_site", "label_by_scanner", "label_by_stain", "split_by_site"):
        assert conf[key]["unit"] == "patients" and conf[key]["n"] == 4
        assert sum(n for row in conf[key]["slide_table"].values() for n in row.values()) == 8
    # P-0004 has cases at two sites: one patient-level observation, "multiple".
    assert any("multiple" in row for row in conf["label_by_site"]["table"].values())
    assert "not independent" in conf["note"]
    json.dumps(a, allow_nan=False)


def test_audit_on_the_cohort_reports_confounding_statistics(clients, ids):
    lead = clients("user-research-lead")
    dsid = ids["ml_demo"]["cohort"]["dataset_version_id"]
    a = lead.get(f"/api/v1/datasets/{dsid}/audit").json()
    site = a["confounding"]["label_by_site"]
    assert site["n"] == 60 and site["test"].startswith("chi_square") and 0 <= site["p_value"] <= 1
    assert 0 <= site["cramers_v"] <= 1
    assert a["confounding"]["split_by_site"]["n"] == 60
    assert a["mixed_label_patients"]["count"] == 13 and a["class_absent"] == []
    assert a["patient_independence"]["ok"] is True
    # Frozen: the audit taken at freeze is embedded in the manifest and returned alongside.
    assert a["at_freeze"]["schema"] == "dermpath.dataset_audit/1"
    assert a["at_freeze"]["confounding"]["label_by_site"]["table"] == site["table"]


def test_audit_flags_near_duplicate_clusters_across_splits_until_a_distinct_decision(clients, ids):
    lead, path = clients("user-research-lead"), clients("user-pathologist")
    a_id, b_id = ids["slides"]["p1_a1_l1"], ids["slides"]["p5_a1_l1_neardup"]
    for seed in range(40):
        ds = _create(lead, f"cluster-{seed}", split={"partition": "random", "seed": seed})
        audit = lead.get(f"/api/v1/datasets/{ds['id']}/audit").json()
        clusters = audit["patient_independence"]["near_duplicate_clusters_across_splits"]
        if clusters:
            break
    else:
        raise AssertionError("no seed splits the near-duplicate pair")
    assert {a_id, b_id} <= set(clusters[0]["slide_ids"]) and len(clusters[0]["splits"]) == 2
    assert audit["patient_independence"]["ok"] is False
    assert path.post(f"/api/v1/projects/{PID}/near-duplicates/review",
                     json={"slide_a_id": a_id, "slide_b_id": b_id, "decision": "distinct",
                           "reason": "different sections (fictional)"}).status_code == 201
    after = lead.get(f"/api/v1/datasets/{ds['id']}/audit").json()
    assert after["patient_independence"]["near_duplicate_clusters_across_splits"] == []
    assert after["duplicates"]["near_duplicate_decisions"] == {"distinct": 1}


def test_audit_of_a_frozen_version_checks_the_live_lineage(clients, ids):
    """A slide moved to another patient AFTER freeze does not change the frozen manifest, but the audit reports it,
    and reports a patient who now spans two splits."""
    from dermpath.db import session_scope
    from dermpath.models import Slide

    lead = clients("user-research-lead")
    moved, target = ids["slides"]["p2_a1_l1"], ids["slides"]["p5_a1_l2"]
    for seed in range(40):
        ds = _create(lead, f"live-{seed}", split={"partition": "random", "seed": seed})
        items = {r["slide_id"]: r for r in _draft_items(ds["id"])}
        if items[moved]["split"] != items[ids["slides"]["p5_a1_l1_neardup"]]["split"]:
            break
    else:
        raise AssertionError("no seed separates P-0002 and P-0005")
    _freeze(lead, ds["id"])
    with session_scope() as db:
        db.get(Slide, moved).block_id = db.get(Slide, target).block_id
    a = lead.get(f"/api/v1/datasets/{ds['id']}/audit").json()
    live = a["patient_independence"]["live_lineage"]
    assert live["moved_count"] == 1 and live["slides_moved_since_snapshot"][0] == {
        "slide_id": moved, "snapshot_patient_code": "P-0002", "current_patient_code": "P-0005"}
    assert live["patients_spanning_splits_now"] == ["P-0005"]
    assert a["patient_independence"]["ok"] is False
    assert a["at_freeze"]["patient_independence"]["live_lineage"]["moved_count"] == 0  # as it was at freeze


def _draft_items(dsid: str) -> list[dict]:
    from dermpath.datasets import item_rows
    from dermpath.db import session_scope
    from dermpath.models import DatasetVersion

    with session_scope() as db:
        return item_rows(db, db.get(DatasetVersion, dsid))
