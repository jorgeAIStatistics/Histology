"""Independent review, suggestion-review history, disagreements, adjudication, label rules."""

from __future__ import annotations

PID = "proj-bcc-demo"


def test_independent_review_hides_suggestions_until_assessment(clients, ids):
    sid = ids["slides"]["p2_a1_l2_pas"]  # has a demo-fixture suggestion
    p2 = clients("user-pathologist-2")  # independent_review is on for this reviewer
    view = p2.get(f"/api/v1/slides/{sid}/labels").json()
    assert view["independent_review"] is True and view["suggestions_hidden"] is True
    assert view["model_suggestions"] == [] and "assessment" in view["hidden_reason"]
    # No leakage through the slide detail or the worklist either.
    detail = p2.get(f"/api/v1/slides/{sid}").json()
    assert detail["labels"]["model_suggestion_count"] is None and detail["labels"]["suggestions_hidden"]
    row = [r for r in p2.get(f"/api/v1/projects/{PID}/worklist").json()["items"] if r["slide_id"] == sid][0]
    assert row["model_suggestions"] is None and row["suggestions_hidden"] is True
    # Reviewing the hidden suggestion by id is refused.
    p1 = clients("user-pathologist")
    sugg = p1.get(f"/api/v1/slides/{sid}/labels").json()["model_suggestions"][0]
    r = p2.post(f"/api/v1/labels/{sugg['id']}/review", json={"action": "accept"})
    assert r.status_code == 409 and r.json()["error"]["code"] == "assessment_required"
    # After the assessment the suggestion is revealed.
    a = p2.post(f"/api/v1/slides/{sid}/assessment", json={"value": "indeterminate", "confidence": "medium",
                                                          "time_spent_seconds": 42.5})
    assert a.status_code == 201 and a.json()["suggestions_were_hidden"] is True
    assert p2.post(f"/api/v1/slides/{sid}/assessment", json={"value": "bcc_present"}).status_code == 409
    view = p2.get(f"/api/v1/slides/{sid}/labels").json()
    assert view["suggestions_hidden"] is False and len(view["model_suggestions"]) == 1
    assert view["my_assessment"]["value"] == "indeterminate"
    assert p2.post(f"/api/v1/labels/{sugg['id']}/review", json={"action": "hide"}).status_code == 201


def test_independent_review_setting_scopes(clients, ids):
    sid = ids["slides"]["p3_a1_l1_blur"]
    p1, lead = clients("user-pathologist"), clients("user-research-lead")
    assert p1.get(f"/api/v1/slides/{sid}/labels").json()["suggestions_hidden"] is False
    assert lead.patch(f"/api/v1/projects/{PID}/settings", json={"independent_review": True}).status_code == 200
    assert p1.get(f"/api/v1/slides/{sid}/labels").json()["suggestions_hidden"] is True
    # Non-pathologist readers are not in a reader study; they still see suggestions (labelled as such).
    assert lead.get(f"/api/v1/slides/{sid}/labels").json()["suggestions_hidden"] is False
    # A reviewer-level override wins over the project setting.
    r = p1.patch(f"/api/v1/projects/{PID}/members/me", json={"independent_review": False})
    assert r.status_code == 200 and r.json()["independent_review_effective"] is False
    assert p1.get(f"/api/v1/slides/{sid}/labels").json()["suggestions_hidden"] is False


def test_suggestion_review_preserves_the_original_and_records_history(clients, ids):
    p1 = clients("user-pathologist")
    sid = ids["slides"]["p3_a1_l1_blur"]
    view = p1.get(f"/api/v1/slides/{sid}/labels").json()
    sugg = view["model_suggestions"][0]
    assert sugg["source"] == "model_suggestion" and sugg["suggestion_origin"] == "demo_fixture"
    assert "NOT produced by a trained model" in sugg["suggestion_notice"]
    # Correct requires a different value and a reason; reject requires a reason; hide takes no value.
    assert p1.post(f"/api/v1/labels/{sugg['id']}/review", json={"action": "correct", "value": "bcc_present",
                                                                "reason": "x"}).status_code == 422
    assert p1.post(f"/api/v1/labels/{sugg['id']}/review", json={"action": "reject"}).status_code == 422
    assert p1.post(f"/api/v1/labels/{sugg['id']}/review", json={"action": "hide",
                                                                "value": "bcc_present"}).status_code == 422
    r1 = p1.post(f"/api/v1/labels/{sugg['id']}/review", json={"action": "accept"})
    assert r1.status_code == 201
    first = r1.json()["review"]
    assert first["source"] == "expert" and first["review_action"] == "accepted" and first["value"] == "bcc_present"
    assert first["review_of_suggestion_id"] == sugg["id"] and first["version"] == 1
    assert r1.json()["original_suggestion"] == sugg  # untouched
    r2 = p1.post(f"/api/v1/labels/{sugg['id']}/review", json={"action": "correct", "value": "indeterminate",
                                                               "reason": "out-of-focus; cannot commit"})
    second = r2.json()["review"]
    assert second["review_action"] == "corrected" and second["version"] == 2 and second["supersedes"] == first["id"]
    assert second["label_id"] == first["label_id"]
    r3 = p1.post(f"/api/v1/labels/{sugg['id']}/review", json={"action": "reject", "reason": "not supported"})
    third = r3.json()["review"]
    assert third["review_action"] == "rejected" and third["value"] is None and third["version"] == 3
    view = p1.get(f"/api/v1/slides/{sid}/labels").json()
    reviews = sorted([e for e in view["expert_labels"] if e["review_of_suggestion_id"] == sugg["id"]],
                     key=lambda e: e["version"])
    assert [e["review_action"] for e in reviews] == ["accepted", "corrected", "rejected"]
    assert view["model_suggestions"][0] == sugg  # the suggestion row never changes
    # Seeded history: an accepted and a corrected suggestion exist.
    p5 = p1.get(f"/api/v1/slides/{ids['slides']['p5_a1_l2']}/labels").json()
    assert [e["review_action"] for e in p5["expert_labels"]] == ["corrected"]
    assert p5["model_suggestions"][0]["value"] == "bcc_present" and p5["expert_labels"][0]["value"] == "bcc_absent_not_benign"
    # Only model suggestions can be "reviewed"; expert labels cannot.
    expert_id = p5["expert_labels"][0]["id"]
    assert p1.post(f"/api/v1/labels/{expert_id}/review", json={"action": "accept"}).status_code == 422
    # Model suggestions never count as reference truth.
    pas = p1.get(f"/api/v1/slides/{ids['slides']['p2_a1_l2_pas']}/labels").json()
    assert pas["model_suggestions"] and pas["reference"]["slide"]["status"] == "unlabeled"


def test_expert_labels_only_from_pathologists_with_versions(clients, ids):
    sid = ids["slides"]["p6_a1_l1_blur"]
    for uid in ("user-assistant", "user-research-lead", "user-director", "user-admin"):
        r = clients(uid).post(f"/api/v1/slides/{sid}/labels", json={"value": "bcc_present"})
        assert r.status_code == 403, uid
    p1 = clients("user-pathologist")
    v1 = p1.post(f"/api/v1/slides/{sid}/labels", json={"value": "bcc_present"})
    assert v1.status_code == 201 and v1.json()["version"] == 1
    assert p1.post(f"/api/v1/slides/{sid}/labels", json={"value": "bcc_absent_not_benign"}).status_code == 422
    assert p1.post(f"/api/v1/slides/{sid}/labels", json={"value": "bcc_present", "reason": "same"}).status_code == 409
    v2 = p1.post(f"/api/v1/slides/{sid}/labels", json={"value": "bcc_absent_not_benign", "reason": "second look"})
    assert v2.json()["version"] == 2 and v2.json()["supersedes"] == v1.json()["id"]
    assert v2.json()["label_id"] == v1.json()["label_id"]
    assert "NOT the same as benign" in v2.json()["display"]
    bad = p1.post(f"/api/v1/slides/{sid}/labels", json={"value": "benign"})
    assert bad.status_code == 422
    meta = p1.get("/api/v1/meta").json()
    absent = [v for v in meta["label_values"] if v["value"] == "bcc_absent_not_benign"][0]
    assert "BCC absent" in absent["display"] and "NOT the same as benign" in absent["display"]


def test_disagreement_detection_and_adjudication(clients, ids):
    p1, p2 = clients("user-pathologist"), clients("user-pathologist-2")
    sid = ids["slides"]["p3_a1_l2"]
    s = p1.get(f"/api/v1/slides/{sid}").json()
    assert s["review_state"] == "disputed"
    dis = p1.get(f"/api/v1/projects/{PID}/disagreements?status=open").json()["items"]
    d = [x for x in dis if x["target_id"] == sid][0]
    assert d["values"] == ["bcc_absent_not_benign", "bcc_present"] and len(d["labels"]) == 2
    # Approval is blocked while the disagreement is open.
    r = p1.post(f"/api/v1/slides/{sid}/review-state", json={"state": "approved"})
    assert r.status_code == 409 and r.json()["error"]["code"] == "open_disagreement"
    assert clients("user-assistant").post(f"/api/v1/disagreements/{d['id']}/adjudicate", json={
        "value": "bcc_present", "reason": "x"}).status_code == 403
    assert p2.post(f"/api/v1/disagreements/{d['id']}/adjudicate", json={"value": "bcc_present",
                                                                         "reason": ""}).status_code == 422
    r = p2.post(f"/api/v1/disagreements/{d['id']}/adjudicate",
                json={"value": "bcc_present", "reason": "consensus at review conference (fictional)"})
    assert r.status_code == 201
    adj = r.json()
    assert adj["disagreement"]["status"] == "adjudicated" and adj["adjudication_label"]["is_adjudication"]
    s = p1.get(f"/api/v1/slides/{sid}").json()
    assert s["review_state"] == "pending_review"
    assert s["labels"]["reference"]["slide"]["status"] == "adjudicated"
    assert p1.post(f"/api/v1/slides/{sid}/review-state", json={"state": "approved"}).status_code == 200
    # Original conflicting labels are preserved.
    view = p1.get(f"/api/v1/slides/{sid}/labels").json()
    slide_scope = [e for e in view["expert_labels"] if e["scope"] == "slide" and not e["is_adjudication"]]
    assert sorted(e["value"] for e in slide_scope) == ["bcc_absent_not_benign", "bcc_present"]
    # The case-level label of this slide's case is shown separately, at case scope.
    assert [e["value"] for e in view["expert_labels"] if e["scope"] == "case"] == ["bcc_present"]
    assert p2.post(f"/api/v1/disagreements/{d['id']}/adjudicate", json={
        "value": "bcc_present", "reason": "again"}).status_code == 409


def test_disagreement_resolves_when_readers_converge(clients, ids):
    p1, p2 = clients("user-pathologist"), clients("user-pathologist-2")
    sid = ids["slides"]["p2_a1_l1"]  # both readers: bcc_absent_not_benign, approved
    r = p2.post(f"/api/v1/slides/{sid}/labels", json={"value": "bcc_present", "reason": "second look (fictional)"})
    assert r.status_code == 201
    assert p1.get(f"/api/v1/slides/{sid}").json()["review_state"] == "disputed"
    p2.post(f"/api/v1/slides/{sid}/labels", json={"value": "bcc_absent_not_benign", "reason": "back again"})
    dis = p1.get(f"/api/v1/projects/{PID}/disagreements").json()["items"]
    assert [x["status"] for x in dis if x["target_id"] == sid] == ["resolved_by_agreement"]


def test_review_state_transitions(clients, ids):
    p1 = clients("user-pathologist")
    sid = ids["slides"]["p5_b1_l1_failed"]  # imported, ingest failed
    r = p1.post(f"/api/v1/slides/{sid}/review-state", json={"state": "approved"})
    assert r.status_code == 409 and r.json()["error"]["code"] == "invalid_transition"
    r = p1.post(f"/api/v1/slides/{sid}/review-state", json={"state": "pending_review"})
    assert r.status_code == 409 and r.json()["error"]["code"] == "not_ingested"
    r = p1.post(f"/api/v1/slides/{sid}/review-state", json={"state": "excluded", "reason": "scan failure"})
    assert r.status_code == 200 and r.json()["review_state"] == "excluded"
    approved = ids["slides"]["p1_a1_l2"]
    assert p1.post(f"/api/v1/slides/{approved}/review-state", json={"state": "pending_review"}).status_code == 422
    r = p1.post(f"/api/v1/slides/{approved}/review-state", json={"state": "pending_review", "reason": "re-review"})
    assert r.status_code == 200
    audit = clients("user-director").get(f"/api/v1/projects/{PID}/audit?entity_id={approved}").json()["items"]
    changes = [e for e in audit if e["action"] == "slide.review_state_changed"]
    assert changes[0]["before"] == {"review_state": "approved"} and changes[0]["reason"] == "re-review"


def test_director_comments_but_cannot_label(clients, ids):
    d = clients("user-director")
    sid = ids["slides"]["p1_a1_l1"]
    assert d.post(f"/api/v1/slides/{sid}/comments", json={"body": "Interesting case for the walkthrough"}).status_code == 201
    assert d.get(f"/api/v1/slides/{sid}/comments").json()["items"][-1]["author_id"] == "user-director"
    assert d.post(f"/api/v1/slides/{sid}/labels", json={"value": "bcc_present"}).status_code == 403
    assert d.post(f"/api/v1/slides/{sid}/review-state", json={"state": "excluded", "reason": "x"}).status_code == 403
