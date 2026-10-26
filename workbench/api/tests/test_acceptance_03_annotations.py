"""Acceptance 3 (backend half): annotation coordinates persist exactly in level-0 space
across save and reload, and versions keep the history. (Zoom/rotation in the browser is the
frontend's half: it converts viewer coordinates to level-0 before saving.)"""

from __future__ import annotations

import random

from fastapi.testclient import TestClient

AWKWARD = [
    [1234.5678901234567, 0.1 + 0.2],
    [9876.000000000002, 17.333333333333332],
    [4321.987654321, 8000.5],
    [0.0, 12287.999999999998],
]


def test_coordinates_round_trip_exactly_and_history_is_kept(clients, ids, app):
    path = clients("user-pathologist")
    sid = ids["slides"]["p2_a1_l1"]
    r = path.post(f"/api/v1/slides/{sid}/annotations", json={
        "geometry": {"type": "polygon", "points": AWKWARD}, "label": "region_of_interest", "comment": "exactness test",
        "transform_meta": {"viewer_rotation_deg": 90, "viewer_zoom": 3.75, "flip": False,
                           "conversion": "OpenSeadragon viewportToImageCoordinates"}})
    assert r.status_code == 201, r.text
    created = r.json()
    aid = created["annotation_id"]
    ring = created["geometry"]["coordinates"][0]
    assert ring[:-1] == AWKWARD and ring[-1] == AWKWARD[0]  # closed ring, exact floats

    # Reload through a brand-new client (fresh connection) and compare exactly.
    fresh = TestClient(app)
    with fresh:
        fresh.post("/api/v1/auth/demo-login", json={"userId": "user-director"})
        items = fresh.get(f"/api/v1/slides/{sid}/annotations").json()["items"]
    mine = [a for a in items if a["annotation_id"] == aid][0]
    assert mine["geometry"]["coordinates"][0][:-1] == AWKWARD
    assert mine["coordinate_space"] == "level0_pixels"
    tm = mine["transform_meta"]
    assert tm["client"]["viewer_rotation_deg"] == 90 and tm["coordinate_space"]["space"] == "level0_pixels"
    assert tm["slide_level0_size"] == [16384, 12288]

    # A change needs a reason and creates version 2; v1 stays, marked superseded.
    noreason = path.patch(f"/api/v1/annotations/{aid}", json={"reason": "", "label": "x"})
    assert noreason.status_code == 422
    moved = [[x + 10.25, y * 0.5 + 0.25] for x, y in AWKWARD]
    v2 = path.patch(f"/api/v1/annotations/{aid}", json={"reason": "boundary refined", "geometry": {
        "type": "polygon", "points": moved}, "transform_meta": {"viewer_rotation_deg": 180}})
    assert v2.status_code == 200 and v2.json()["version"] == 2
    hist = path.get(f"/api/v1/slides/{sid}/annotations?history=1").json()["items"]
    versions = sorted([a for a in hist if a["annotation_id"] == aid], key=lambda a: a["version"])
    assert [v["version"] for v in versions] == [1, 2]
    assert versions[0]["geometry"]["coordinates"][0][:-1] == AWKWARD  # history intact, exact
    assert versions[0]["superseded_by"] == versions[1]["id"]
    assert versions[1]["geometry"]["coordinates"][0][:-1] == moved and versions[1]["reason"] == "boundary refined"

    # Soft delete = version 3; the current list drops it, history keeps all three.
    gone = path.request("DELETE", f"/api/v1/annotations/{aid}", json={"reason": "duplicate of another region"})
    assert gone.status_code == 200 and gone.json()["deleted"] is True and gone.json()["version"] == 3
    current = path.get(f"/api/v1/slides/{sid}/annotations").json()["items"]
    assert aid not in {a["annotation_id"] for a in current}
    hist = path.get(f"/api/v1/slides/{sid}/annotations?history=1").json()["items"]
    assert sorted(a["version"] for a in hist if a["annotation_id"] == aid) == [1, 2, 3]
    assert path.patch(f"/api/v1/annotations/{aid}", json={"reason": "undo", "label": "y"}).status_code == 409


def test_random_float_coordinates_round_trip(clients, ids):
    path = clients("user-pathologist")
    sid = ids["slides"]["p4_a1_l1"]
    rng = random.Random(1234)
    for _ in range(5):
        pts = [[rng.uniform(0, 16384), rng.uniform(0, 12288)] for _ in range(rng.randint(3, 40))]
        r = path.post(f"/api/v1/slides/{sid}/annotations", json={"geometry": {"type": "polygon", "points": pts}})
        aid = r.json()["annotation_id"]
        back = [a for a in path.get(f"/api/v1/slides/{sid}/annotations").json()["items"] if a["annotation_id"] == aid]
        assert back[0]["geometry"]["coordinates"][0][:-1] == pts


def test_rectangle_and_validation(clients, ids):
    path = clients("user-pathologist")
    sid = ids["slides"]["cmu_cc0"]  # 2220 x 2967 level 0
    r = path.post(f"/api/v1/slides/{sid}/annotations", json={
        "geometry": {"type": "rectangle", "x": 100.5, "y": 200.25, "width": 50.125, "height": 80}})
    assert r.status_code == 201
    g = r.json()["geometry"]
    assert g["rect"] == {"x": 100.5, "y": 200.25, "width": 50.125, "height": 80}
    assert g["coordinates"][0] == [[100.5, 200.25], [150.625, 200.25], [150.625, 280.25], [100.5, 280.25],
                                   [100.5, 200.25]]
    out = path.post(f"/api/v1/slides/{sid}/annotations", json={
        "geometry": {"type": "polygon", "points": [[0, 0], [2221, 0], [0, 10]]}})
    assert out.status_code == 422 and out.json()["error"]["code"] == "out_of_bounds"
    nan = path.post(f"/api/v1/slides/{sid}/annotations", content=b'{"geometry": {"type": "polygon", '
                    b'"points": [[0, 0], [NaN, 0], [0, 10]]}}', headers={"content-type": "application/json"})
    assert nan.status_code == 422
    degenerate = path.post(f"/api/v1/slides/{sid}/annotations", json={
        "geometry": {"type": "polygon", "points": [[1, 1], [1, 1], [2, 2]]}})
    assert degenerate.status_code == 422


def test_annotation_permissions_and_geojson_export(clients, ids):
    sid = ids["slides"]["p1_a1_l1"]
    for uid in ("user-assistant", "user-research-lead", "user-director"):
        r = clients(uid).post(f"/api/v1/slides/{sid}/annotations",
                              json={"geometry": {"type": "rectangle", "x": 1, "y": 1, "width": 5, "height": 5}})
        assert r.status_code == 403, uid
    gj = clients("user-research-lead").get("/api/v1/projects/proj-bcc-demo/export/annotations.geojson").json()
    assert gj["type"] == "FeatureCollection"
    assert gj["properties"]["coordinate_space"]["space"] == "level0_pixels"
    assert "not" in gj["properties"]["note"].lower() and "longitude" in gj["properties"]["note"].lower()
    seeded = [f for f in gj["features"] if f["properties"]["slide_id"] == sid]
    assert seeded and seeded[0]["properties"]["version"] == 2  # latest version of the seeded polygon
    assert seeded[0]["geometry"]["type"] == "Polygon"
    assert seeded[0]["properties"]["coordinate_space"]["units"].startswith("level-0 pixels")
    assert clients("user-admin").get("/api/v1/projects/proj-bcc-demo/export/annotations.geojson").status_code == 403


def test_region_label_targets_an_annotation(clients, ids):
    path = clients("user-pathologist")
    sid = ids["slides"]["p1_a1_l1"]
    labels = path.get(f"/api/v1/slides/{sid}/labels").json()
    region = [lbl for lbl in labels["expert_labels"] if lbl["scope"] == "region"]
    assert region and region[0]["annotation_id"] and region[0]["value"] == "bcc_present"
    bad = path.post(f"/api/v1/slides/{sid}/labels", json={"scope": "region", "target_id": "nope",
                                                          "value": "bcc_present"})
    assert bad.status_code == 422
