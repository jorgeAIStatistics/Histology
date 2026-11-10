"""QC heuristics on the real fixture and synthetic variants; the issue lifecycle."""

from __future__ import annotations

import numpy as np
import openslide

from conftest import CMU


def test_otsu_and_laplacian_units():
    from dermpath.qc.focus import laplacian_variance
    from dermpath.qc.tissue import otsu_threshold

    bimodal = np.concatenate([np.full(1000, 10, np.uint8), np.full(1000, 200, np.uint8)])
    t, degenerate = otsu_threshold(bimodal)
    assert 10 <= t < 200 and not degenerate
    t, degenerate = otsu_threshold(np.full(100, 7, np.uint8))
    assert degenerate
    flat = np.full((64, 64), 128.0)
    assert laplacian_variance(flat) == 0.0
    checker = (np.indices((64, 64)).sum(axis=0) % 2) * 255.0
    assert laplacian_variance(checker) > 1e4


def test_heuristics_on_the_cc0_fixture(clients, ids):
    c = clients("user-assistant")
    qc = c.get(f"/api/v1/slides/{ids['slides']['cmu_cc0']}/qc").json()
    auto = [r for r in qc["reviews"] if r["kind"] == "automated_screen"]
    assert len(auto) == 1 and auto[0]["experimental"] is True and auto[0]["has_mask"]
    m = auto[0]["metrics"]
    assert m["source"] == "heuristic" and "EXPERIMENTAL" in m["label"]
    assert 0.15 < m["tissue"]["tissue_fraction"] < 0.6  # mostly white background around a strip of tissue
    assert m["tissue"]["channel"] == "hsv_saturation" and m["tissue"]["tissue_bbox_level0"]
    assert m["focus"]["tiles_measured"] == 12 and m["focus"]["median_variance"] > m["focus"]["threshold"]
    assert m["focus"]["threshold_calibrated"] is False
    assert m["calibration"] == {"status": "present", "mpp_x": 0.499, "mpp_y": 0.499}
    assert qc["issues"] == []  # nothing suggested for this slide
    assert "never orders" in qc["policy"]
    tok = c.get(f"/api/v1/slides/{ids['slides']['cmu_cc0']}/viewer-token").json()
    mask = c.get(f"/api/v1/slides/{ids['slides']['cmu_cc0']}/qc/mask?token={tok['token']}")
    assert mask.status_code == 200 and mask.content[:4] == b"\x89PNG"


def test_heuristics_direct_on_fixture_file():
    from dermpath.qc import focus, tissue

    s = openslide.OpenSlide(str(CMU))
    mask, st = tissue.segment(s.get_thumbnail((1024, 1024)), s.dimensions)
    f = focus.measure(s, mask, threshold=60.0)
    print(f"\nCMU fixture: tissue_fraction={st['tissue_fraction']:.3f} otsu={st['otsu_threshold']} "
          f"focus_median_var={f['median_variance']} tiles={f['tiles_measured']}")
    assert f["suspected_blur"] is False


def test_suggestions_on_synthetic_variants(clients, ids):
    c = clients("user-assistant")

    def issues(key):
        return {i["category"]: i for i in c.get(f"/api/v1/slides/{ids['slides'][key]}/qc").json()["issues"]}

    blur = issues("p3_a1_l1_blur")["blur_heuristic"]
    assert blur["source"] == "heuristic" and blur["is_suggestion"] and blur["status"] == "open"
    assert blur["experimental"] and blur["dataset_eligibility_effect"] == "none"
    low = issues("p3_b1_l1_low")["low_tissue_heuristic"]
    assert low["status"] == "resolved" and low["dataset_eligibility_effect"] == "exclude_slide"
    assert [h["action"] for h in low["history"]] == ["created", "review", "suggest_action", "resolve"]
    field = issues("p6_a1_field")
    assert "missing_calibration" in field and field["missing_calibration"]["is_suggestion"]
    # Synthetic tiles have no calibration by construction; no missing_calibration noise.
    qc = c.get(f"/api/v1/slides/{ids['slides']['p3_a1_l1_blur']}/qc").json()
    assert qc["reviews"][0]["metrics"]["calibration"]["status"] == "not_applicable_synthetic"
    assert "missing_calibration" not in issues("p3_a1_l1_blur")
    overridden = issues("p6_a1_l1_blur")["blur_heuristic"]
    assert overridden["overridden"] and overridden["status"] == "resolved" and overridden["reason"]


def test_issue_lifecycle_transitions_and_audit(clients, ids):
    asst, path = clients("user-assistant"), clients("user-pathologist")
    sid = ids["slides"]["p2_a1_l1"]
    bad = asst.post(f"/api/v1/slides/{sid}/qc/issues", json={"category": "blur_heuristic"})
    assert bad.status_code == 422  # heuristic categories are machine-only
    region = {"type": "rectangle", "x": 100, "y": 100, "width": 400, "height": 300}
    issue = asst.post(f"/api/v1/slides/{sid}/qc/issues", json={"category": "contamination_concern",
                                                               "region": region, "note": "floater"}).json()
    iid = issue["id"]
    assert issue["status"] == "open" and issue["source"] == "human" and issue["region"]["coordinate_space"] == "level0_pixels"
    # Out-of-order transitions are refused.
    r = asst.patch(f"/api/v1/qc/issues/{iid}", json={"action": "resolve", "resolution": "x"})
    assert r.status_code == 409 and r.json()["error"]["code"] == "invalid_transition"
    assert asst.patch(f"/api/v1/qc/issues/{iid}", json={"action": "review"}).status_code == 422  # confirmed required
    assert asst.patch(f"/api/v1/qc/issues/{iid}", json={"action": "review", "confirmed": True}).status_code == 200
    r = asst.patch(f"/api/v1/qc/issues/{iid}", json={"action": "suggest_action", "suggested_action": "order_recut"})
    assert r.status_code == 422  # not in the vocabulary: nothing is ever ordered
    r = path.patch(f"/api/v1/qc/issues/{iid}", json={"action": "suggest_action",
                                                     "suggested_action": "exclude_region_from_training"})
    assert r.status_code == 200 and r.json()["status"] == "action_suggested"
    r = asst.patch(f"/api/v1/qc/issues/{iid}", json={"action": "resolve", "resolution": "region masked",
                                                     "dataset_eligibility_effect": "exclude_region"})
    assert r.status_code == 422 and r.json()["error"]["code"] == "reason_required"
    r = asst.patch(f"/api/v1/qc/issues/{iid}", json={"action": "resolve", "resolution": "region masked",
                                                     "dataset_eligibility_effect": "exclude_region",
                                                     "reason": "floater over the region"})
    assert r.status_code == 200
    done = r.json()
    assert [h["action"] for h in done["history"]] == ["created", "review", "suggest_action", "resolve"]
    assert done["history"][2]["detail"]["note"].startswith("a suggestion for a human decision")
    # Region exclusion does not exclude the slide.
    assert clients("user-research-lead").get(f"/api/v1/slides/{sid}/eligibility").json()["eligible"] is True
    from dermpath.db import session_scope
    from dermpath.qc.service import excluded_regions

    with session_scope() as db:
        regs = excluded_regions(db, sid)
        assert regs and regs[0]["region"]["coordinates"][0][0] == [100, 100]
    # Reopen needs a reason; override is only for heuristic issues.
    assert asst.patch(f"/api/v1/qc/issues/{iid}", json={"action": "reopen"}).status_code == 422
    assert asst.patch(f"/api/v1/qc/issues/{iid}", json={"action": "reopen", "reason": "recheck"}).status_code == 200
    r = asst.patch(f"/api/v1/qc/issues/{iid}", json={"action": "override", "reason": "x"})
    assert r.status_code == 422
    audit = clients("user-research-lead").get(f"/api/v1/projects/proj-bcc-demo/audit?entity_id={iid}").json()["items"]
    assert {e["action"] for e in audit} >= {"qc.issue_created", "qc.issue_review", "qc.issue_suggest_action",
                                            "qc.issue_resolve", "qc.issue_reopen"}
    assert all(e["correlation_id"] for e in audit)


def test_human_override_of_heuristic(clients, ids):
    asst = clients("user-assistant")
    sid = ids["slides"]["p3_a1_l1_blur"]
    qc = asst.get(f"/api/v1/slides/{sid}/qc").json()
    blur = [i for i in qc["issues"] if i["category"] == "blur_heuristic"][0]
    assert asst.patch(f"/api/v1/qc/issues/{blur['id']}", json={"action": "override"}).status_code == 422
    # A human issue can supersede the heuristic one (override_of), with a reason.
    r = asst.post(f"/api/v1/slides/{sid}/qc/issues", json={
        "category": "scan_focus", "override_of": blur["id"], "reason": "confirmed out of focus; scanner problem"})
    assert r.status_code == 201
    qc = asst.get(f"/api/v1/slides/{sid}/qc").json()
    old = [i for i in qc["issues"] if i["id"] == blur["id"]][0]
    assert old["status"] == "resolved" and old["overridden"] and old["history"][-1]["action"] == "override"
    # Screening metric override (a manual review pointing at the automated one).
    auto = [x for x in qc["reviews"] if x["kind"] == "automated_screen"][0]
    r = asst.post(f"/api/v1/slides/{sid}/qc/override", json={"review_id": auto["id"], "metric": "focus",
                                                            "verdict": "inadequate", "reason": "visual check"})
    assert r.status_code == 201 and r.json()["override_of"] == auto["id"] and r.json()["experimental"] is False
    # Re-screening does not resurrect an overridden suggestion.
    from dermpath.jobs.worker import Worker

    assert asst.post(f"/api/v1/slides/{sid}/qc/screen").status_code == 202
    Worker("t").run_until_idle()
    qc2 = asst.get(f"/api/v1/slides/{sid}/qc").json()
    assert len([i for i in qc2["issues"] if i["category"] == "blur_heuristic"]) == 1
    assert qc2["reviews"][0]["metrics"]["suggestions_suppressed_by_human_override"] == ["blur_heuristic"]


def test_screen_requires_ingested_slide_and_dedupes(clients, ids):
    asst = clients("user-assistant")
    r = asst.post(f"/api/v1/slides/{ids['slides']['p5_b1_l1_failed']}/qc/screen")
    assert r.status_code == 409
    sid = ids["slides"]["p2_a1_l1"]
    a = asst.post(f"/api/v1/slides/{sid}/qc/screen").json()
    b = asst.post(f"/api/v1/slides/{sid}/qc/screen").json()
    assert b["deduplicated"] is True and b["job_id"] == a["job_id"]
