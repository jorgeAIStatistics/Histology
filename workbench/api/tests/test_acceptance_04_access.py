"""Acceptance 4: backend role and project access, for reads and writes, across roles and a
second project the user is not a member of."""

from __future__ import annotations

import pytest

PID = "proj-bcc-demo"
RID = "proj-restricted-demo"
ROLES = {
    "user-assistant": "histology_assistant",
    "user-pathologist": "pathologist",
    "user-research-lead": "research_lead",
    "user-director": "medical_director",
    "user-admin": "admin",
}


def test_unauthenticated_requests_are_refused(clients, ids):
    anon = clients.anon()
    sid = ids["slides"]["p1_a1_l1"]
    for url in (f"/api/v1/projects/{PID}", f"/api/v1/slides/{sid}", f"/api/v1/slides/{sid}/labels",
                f"/api/v1/projects/{PID}/datasets", f"/api/v1/projects/{PID}/worklist", "/api/v1/auth/me"):
        r = anon.get(url)
        assert r.status_code == 401 and r.json()["error"]["code"] == "unauthenticated", url
    assert anon.post(f"/api/v1/slides/{sid}/labels", json={"value": "bcc_present"}).status_code == 401
    # Health and the demo-user picker stay public.
    assert anon.get("/api/v1/health").status_code == 200
    assert anon.get("/api/v1/auth/demo-users").status_code == 200


def test_forged_or_tampered_session_cookie_is_rejected(app, ids):
    from fastapi.testclient import TestClient

    c = TestClient(app)
    with c:
        good = c.post("/api/v1/auth/demo-login", json={"userId": "user-assistant"}).cookies.get("wb_session")
        assert good
        head, body, mac = good.split(".")
        flipped = mac[:-3] + ("B" if mac[-3] != "B" else "C") + mac[-2:]
        c.cookies.clear()
        c.cookies.set("wb_session", f"{head}.{body}.{flipped}")
        assert c.get("/api/v1/auth/me").status_code == 401
        c.cookies.clear()
        c.cookies.set("wb_session", "v1.eyJ1aWQiOiJ1c2VyLWFkbWluIiwiZXhwIjo5OTk5OTk5OTk5fQ.AAAA")
        assert c.get("/api/v1/auth/me").status_code == 401
        c.cookies.clear()
        c.cookies.set("wb_session", good)
        assert c.get("/api/v1/auth/me").status_code == 200


@pytest.mark.parametrize("uid", ["user-assistant", "user-pathologist", "user-director"])
def test_non_member_cannot_read_or_write_another_project(clients, ids, uid):
    c = clients(uid)
    sid = ids["slides"]["restricted_slide"]
    reads = [f"/api/v1/projects/{RID}", f"/api/v1/projects/{RID}/worklist", f"/api/v1/projects/{RID}/cases",
             f"/api/v1/projects/{RID}/datasets", f"/api/v1/projects/{RID}/audit", f"/api/v1/slides/{sid}",
             f"/api/v1/slides/{sid}/labels", f"/api/v1/slides/{sid}/qc", f"/api/v1/slides/{sid}/annotations",
             f"/api/v1/slides/{sid}/viewer-token", f"/api/v1/slides/{sid}/comments",
             f"/api/v1/jobs?project_id={RID}"]
    for url in reads:
        r = c.get(url)
        assert r.status_code == 403, (url, r.status_code)
        assert r.json()["error"]["code"] == "not_project_member", url
    writes = [
        ("post", f"/api/v1/slides/{sid}/labels", {"value": "bcc_present"}),
        ("post", f"/api/v1/slides/{sid}/annotations", {"geometry": {"type": "rectangle", "x": 1, "y": 1,
                                                                    "width": 2, "height": 2}}),
        ("post", f"/api/v1/slides/{sid}/qc/issues", {"category": "fold"}),
        ("post", f"/api/v1/slides/{sid}/review-state", {"state": "pending_review"}),
        ("post", f"/api/v1/slides/{sid}/comments", {"body": "hi"}),
        ("post", f"/api/v1/projects/{RID}/datasets", {"name": "x"}),
        ("post", f"/api/v1/projects/{RID}/uploads", {"filename": "a.svs", "size": 1, "sha256": "a" * 64}),
    ]
    for method, url, body in writes:
        r = getattr(c, method)(url, json=body)
        assert r.status_code == 403 and r.json()["error"]["code"] == "not_project_member", (url, r.text)
    # The restricted project is not even listed.
    listed = {p["id"] for p in c.get("/api/v1/projects").json()["items"]}
    assert RID not in listed and PID in listed


def test_member_of_second_project_can_read_it(clients, ids):
    c = clients("user-pathologist-2")
    assert c.get(f"/api/v1/slides/{ids['slides']['restricted_slide']}").status_code == 200
    assert {p["id"] for p in c.get("/api/v1/projects").json()["items"]} == {PID, RID}


# (permission, method, url-template, body, roles allowed)
MATRIX = [
    ("read slide", "get", "/api/v1/slides/{sid}", None, {"histology_assistant", "pathologist", "research_lead", "medical_director"}),
    ("read labels", "get", "/api/v1/slides/{sid}/labels", None, {"histology_assistant", "pathologist", "research_lead", "medical_director"}),
    ("read qc", "get", "/api/v1/slides/{sid}/qc", None, {"histology_assistant", "pathologist", "research_lead", "medical_director"}),
    ("viewer token", "get", "/api/v1/slides/{sid}/viewer-token", None, {"histology_assistant", "pathologist", "research_lead", "medical_director"}),
    ("worklist", "get", "/api/v1/projects/{pid}/worklist", None, {"histology_assistant", "pathologist", "research_lead", "medical_director"}),
    ("datasets", "get", "/api/v1/projects/{pid}/datasets", None, {"histology_assistant", "pathologist", "research_lead", "medical_director"}),
    ("audit", "get", "/api/v1/projects/{pid}/audit", None, {"research_lead", "medical_director", "admin"}),
    ("members", "get", "/api/v1/projects/{pid}/members", None, {"histology_assistant", "pathologist", "research_lead", "medical_director", "admin"}),
    ("project", "get", "/api/v1/projects/{pid}", None, {"histology_assistant", "pathologist", "research_lead", "medical_director", "admin"}),
    ("expert label", "post", "/api/v1/slides/{sid}/labels", {"value": "indeterminate", "reason": "matrix test"}, {"pathologist"}),
    ("annotate", "post", "/api/v1/slides/{sid}/annotations",
     {"geometry": {"type": "rectangle", "x": 1, "y": 1, "width": 9, "height": 9}}, {"pathologist"}),
    ("qc issue", "post", "/api/v1/slides/{sid}/qc/issues", {"category": "chatter"}, {"histology_assistant", "pathologist"}),
    ("qc screen", "post", "/api/v1/slides/{sid}/qc/screen", None, {"histology_assistant", "pathologist"}),
    ("comment", "post", "/api/v1/slides/{sid}/comments", {"body": "note"},
     {"histology_assistant", "pathologist", "research_lead", "medical_director"}),
    ("dataset draft", "post", "/api/v1/projects/{pid}/datasets", {"name": "matrix"}, {"research_lead"}),
    ("create patient", "post", "/api/v1/projects/{pid}/patients", {"code": "P-0{n}"}, {"histology_assistant"}),
    ("upload", "post", "/api/v1/projects/{pid}/uploads",
     {"filename": "m{n}.svs", "size": 5, "sha256": "{sha}", "provenance": "public_cc0"}, {"histology_assistant"}),
    ("project settings", "patch", "/api/v1/projects/{pid}/settings", {"independent_review": False}, {"research_lead"}),
    ("assessment", "post", "/api/v1/slides/{sid2}/assessment", {"value": "indeterminate"}, {"pathologist"}),
]


@pytest.mark.parametrize("uid,role", list(ROLES.items()))
def test_role_matrix(clients, ids, uid, role):
    c = clients(uid)
    n = 0
    for name, method, tmpl, body, allowed in MATRIX:
        n += 1
        url = tmpl.format(sid=ids["slides"]["p1_a1_l2"], sid2=ids["slides"]["p2_a1_l1"], pid=PID)
        payload = None
        if body is not None:
            import json as _json

            raw = _json.dumps(body).replace("{n}", f"{n:03d}{len(uid)}").replace("{sha}", f"{n:02d}" + "c" * 62)
            payload = _json.loads(raw)
        r = getattr(c, method)(url, json=payload) if payload is not None else getattr(c, method)(url)
        if role in allowed:
            assert r.status_code < 400, (role, name, r.status_code, r.text)
        else:
            assert r.status_code == 403, (role, name, r.status_code, r.text)
            assert r.json()["error"]["code"] == "role_forbidden"


def test_review_state_transition_roles(clients, ids):
    sid = ids["slides"]["p6_a1_l1_blur"]  # imported
    lead = clients("user-research-lead")
    r = lead.post(f"/api/v1/slides/{sid}/review-state", json={"state": "pending_review"})
    assert r.status_code == 403
    asst = clients("user-assistant")
    assert asst.post(f"/api/v1/slides/{sid}/review-state", json={"state": "pending_review"}).status_code == 200
    # Assistants route work but cannot approve or exclude.
    r = asst.post(f"/api/v1/slides/{sid}/review-state", json={"state": "approved"})
    assert r.status_code == 403 and r.json()["error"]["code"] == "role_forbidden"
    path = clients("user-pathologist")
    r = path.post(f"/api/v1/slides/{sid}/review-state", json={"state": "excluded"})
    assert r.status_code == 422 and r.json()["error"]["code"] == "reason_required"


def test_tile_token_is_bound_to_user_and_membership(clients, ids, app):
    from fastapi.testclient import TestClient

    sid = ids["slides"]["p1_a1_l1"]
    tok = clients("user-pathologist").get(f"/api/v1/slides/{sid}/viewer-token").json()
    # Another logged-in user cannot use someone else's token.
    other = clients("user-assistant")
    r = other.get(tok["dzi_url"])
    assert r.status_code == 403 and r.json()["error"]["code"] == "token_user_mismatch"
    # Without a cookie the token alone works (image requests), but only while the user is a member.
    bare = TestClient(app)
    with bare:
        assert bare.get(tok["dzi_url"]).status_code == 200
        admin = clients("user-admin")
        assert admin.delete(f"/api/v1/projects/{PID}/members/user-pathologist").status_code == 200
        r = bare.get(tok["dzi_url"])
        assert r.status_code == 403 and r.json()["error"]["code"] == "not_project_member"


def test_admin_manages_membership_but_has_no_clinical_permissions(clients, ids):
    admin = clients("user-admin")
    sid = ids["slides"]["restricted_slide"]
    assert admin.get(f"/api/v1/slides/{sid}").status_code == 403
    assert admin.post(f"/api/v1/projects/{RID}/members", json={"user_id": "user-pathologist"}).status_code == 201
    path = clients("user-pathologist")
    assert path.get(f"/api/v1/slides/{sid}").status_code == 200
    assert clients("user-research-lead").post(f"/api/v1/projects/{RID}/members",
                                              json={"user_id": "user-assistant"}).status_code == 403
