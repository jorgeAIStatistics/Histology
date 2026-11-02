"""Real OpenSlide ingestion and DeepZoom tiling of the CC0 fixture, tile tokens, synthetic
tiles, and printed (measured, not invented) latency and memory numbers."""

from __future__ import annotations

import io
import json
import math
import subprocess
import sys
import time
import xml.etree.ElementTree as ET
from dataclasses import replace

import numpy as np
from PIL import Image

from conftest import API_DIR

DZ_NS = "{http://schemas.microsoft.com/deepzoom/2008}"


def _token(client, sid):
    r = client.get(f"/api/v1/slides/{sid}/viewer-token")
    assert r.status_code == 200, r.text
    return r.json()


def test_cmu_fixture_ingested_with_real_openslide_metadata(clients, ids):
    s = clients("user-pathologist").get(f"/api/v1/slides/{ids['slides']['cmu_cc0']}").json()
    assert s["ingest_status"] == "succeeded" and s["image_kind"] == "wsi" and s["is_whole_slide_image"]
    assert (s["width"], s["height"], s["levels"]) == (2220, 2967, 1)
    assert s["vendor"] == "aperio" and s["format"] == "aperio.svs"
    assert s["mpp_x"] == 0.499 and s["mpp_y"] == 0.499 and s["objective_power"] == 20.0
    assert s["scale_bar_allowed"] is True
    assert s["sha256"] == "ed92d5a9f2e86df67640d6f92ce3e231419ce127131697fbbce42ad5e002c8a7"
    assert s["provenance"] == "public_cc0" and "unlabeled" in s["provenance_display"].lower()
    assert "openslide" in s["processing_version"] and s["processing_version"].startswith("ingest-1.0")
    assert set(s["associated_images_present_not_served"]) == {"label", "macro", "thumbnail"}
    codes = {f["code"] for f in s["identifier_risk"]}
    assert {"label_image_present", "macro_image_present", "metadata_may_contain_identifiers"} <= codes
    meta_flag = [f for f in s["identifier_risk"] if f["code"] == "metadata_may_contain_identifiers"][0]
    assert "aperio.Date" in meta_flag["property_keys"] and "aperio.User" in meta_flag["property_keys"]
    assert all(f["message"] == "possible identifier source: review before any non-demo use" for f in s["identifier_risk"])
    # The flags never echo identifying VALUES (e.g. the scanner user GUID in the comment).
    assert "b414003d" not in json.dumps(s)
    # Unlabeled: no expert labels, no suggestions.
    lab = clients("user-pathologist").get(f"/api/v1/slides/{s['id']}/labels").json()
    assert lab["expert_labels"] == [] and lab["model_suggestions"] == []
    assert lab["reference"]["slide"]["status"] == "unlabeled"


def test_dzi_xml_and_jpeg_tiles(clients, ids):
    c = clients("user-pathologist")
    sid = ids["slides"]["cmu_cc0"]
    tok = _token(c, sid)
    assert tok["ttl_seconds"] <= 600 and tok["scale_bar_allowed"] is True and tok["bounds_offset_level0"] == [0, 0]
    r = c.get(tok["dzi_url"])
    assert r.status_code == 200 and r.headers["content-type"].startswith("application/xml")
    root = ET.fromstring(r.text)
    assert root.tag == f"{DZ_NS}Image"
    assert root.get("Format") == "jpeg" and root.get("TileSize") == "254" and root.get("Overlap") == "1"
    size = root.find(f"{DZ_NS}Size")
    assert (int(size.get("Width")), int(size.get("Height"))) == (2220, 2967)
    max_level = math.ceil(math.log2(2967))
    t = c.get(tok["tile_url_template"].format(level=max_level, col=0, row=0))
    assert t.status_code == 200 and t.headers["content-type"] == "image/jpeg"
    img = Image.open(io.BytesIO(t.content))
    assert img.format == "JPEG" and img.size == (255, 255)  # 254 + 1 overlap at the corner
    mid = Image.open(io.BytesIO(c.get(tok["tile_url_template"].format(level=max_level, col=4, row=5)).content))
    assert mid.size == (256, 256)
    low = Image.open(io.BytesIO(c.get(tok["tile_url_template"].format(level=0, col=0, row=0)).content))
    assert low.size == (1, 1)
    assert c.get(tok["tile_url_template"].format(level=max_level, col=999, row=0)).status_code == 404
    assert c.get(tok["tile_url_template"].format(level=max_level + 1, col=0, row=0)).status_code == 404
    assert c.get(tok["dzi_url"].replace("slide.dzi", "slide_files/12/0_0.png")).status_code == 404
    th = c.get(tok["thumbnail_url"])
    assert th.status_code == 200 and Image.open(io.BytesIO(th.content)).format == "JPEG"


def test_label_and_macro_images_are_never_served(clients, ids):
    c = clients("user-pathologist")
    sid = ids["slides"]["cmu_cc0"]
    for name in ("label", "macro", "thumbnail"):
        r = c.get(f"/api/v1/slides/{sid}/associated/{name}")
        assert r.status_code == 403 and r.json()["error"]["code"] == "associated_images_not_served"
    # No route exposes them in the OpenAPI document except the refusal.
    spec = c.get("/api/v1/openapi.json").json()
    assert not [p for p in spec["paths"] if "macro" in p or "label_image" in p]


def test_tile_tokens_expire_and_are_bound_to_slide_and_user(clients, ids, env, app):
    from fastapi.testclient import TestClient

    from dermpath.config import set_settings
    from dermpath.storage import issue_access_token, verify_access_token

    settings, _ = env
    c = clients("user-pathologist")
    a, b = ids["slides"]["cmu_cc0"], ids["slides"]["p1_a1_l1"]
    tok = _token(c, a)
    # Bound to the slide: a token for A cannot fetch B's thumbnail.
    r = c.get(f"/api/v1/slides/{b}/thumbnail?token={tok['token']}")
    assert r.status_code == 403 and r.json()["error"]["code"] == "token_slide_mismatch"
    # Tampering with the payload (pointing it at slide B) breaks the signature.
    v, payload, mac = tok["token"].split(".")
    forged_payload = issue_access_token(b, "user-pathologist")[0].split(".")[1]
    r = c.get(f"/api/v1/tiles/v1.{forged_payload}.{mac}/slide.dzi")
    assert r.status_code == 403 and r.json()["error"]["code"] == "token_invalid"
    # Bound to the user: another user's session cannot use it.
    r = clients("user-director").get(tok["dzi_url"])
    assert r.status_code == 403 and r.json()["error"]["code"] == "token_user_mismatch"
    # Expiry: default lifetime 10 minutes; a short-lived token stops working.
    claims = verify_access_token(tok["token"])
    assert 590 <= claims["exp"] - time.time() <= 600
    from dermpath.signing import TokenError

    try:
        verify_access_token(tok["token"], now=claims["exp"] + 1)
        raise AssertionError("expired token verified")
    except TokenError as exc:
        assert exc.code == "token_expired"
    set_settings(replace(settings, access_token_ttl_seconds=1))
    short = _token(c, a)
    assert c.get(short["dzi_url"]).status_code == 200
    time.sleep(1.2)
    r = c.get(short["dzi_url"])
    assert r.status_code == 403 and r.json()["error"]["code"] == "token_expired"
    set_settings(settings)
    # Tokens are not session cookies: a request with neither fails.
    with TestClient(app) as anon:
        assert anon.get("/api/v1/tiles/garbage/slide.dzi").status_code == 403


def test_synthetic_tiles_served_through_same_routes_with_burned_in_text(clients, ids):
    c = clients("user-assistant")
    sid = ids["slides"]["p1_a1_l1"]
    s = c.get(f"/api/v1/slides/{sid}").json()
    assert s["image_kind"] == "synthetic_tiles" and s["provenance"] == "demo_synthetic"
    assert s["synthetic_notice"] == "SYNTHETIC — NO HISTOLOGY" and s["mpp_x"] is None and not s["scale_bar_allowed"]
    tok = _token(c, sid)
    root = ET.fromstring(c.get(tok["dzi_url"]).text)
    size = root.find(f"{DZ_NS}Size")
    assert (int(size.get("Width")), int(size.get("Height"))) == (16384, 12288)
    # The synthetic palette has no dark colours; near-black pixels can only be the burned-in text.
    level = math.ceil(math.log2(16384))
    found_text = False
    for col, row in ((0, 0), (1, 0), (2, 0), (3, 0), (0, 1), (1, 1), (2, 1), (3, 1)):
        img = np.asarray(Image.open(io.BytesIO(c.get(
            tok["tile_url_template"].format(level=level - 2, col=col, row=row)).content)).convert("L"))
        if (img < 40).sum() > 50:
            found_text = True
            break
    assert found_text, "no burned-in SYNTHETIC — NO HISTOLOGY text found in the first tiles"
    # Deterministic: the same tile is byte-identical across requests and fresh generators.
    u = tok["tile_url_template"].format(level=level - 3, col=1, row=1)
    first = c.get(u).content
    from dermpath.slides.tiles import get_tile_service

    get_tile_service().clear()
    assert c.get(u).content == first


def test_synthetic_generator_is_deterministic_and_non_histological():
    from openslide.deepzoom import DeepZoomGenerator

    from dermpath.slides.synthetic import NOTICE, SyntheticSlide, make_spec, spec_sha256

    a, b = SyntheticSlide(make_spec(42)), SyntheticSlide(make_spec(42))
    ra = np.asarray(a.read_region((5000, 4000), 0, (300, 200)))
    rb = np.asarray(b.read_region((5000, 4000), 0, (300, 200)))
    assert np.array_equal(ra, rb)
    assert spec_sha256(make_spec(42)) == spec_sha256(make_spec(42)) != spec_sha256(make_spec(43))
    assert a.associated_images == {} and a.properties["dermpath.synthetic.notice"] == NOTICE
    dz = DeepZoomGenerator(a, 254, 1, True)
    assert dz.get_dzi("jpeg").startswith("<?xml") or "Image" in dz.get_dzi("jpeg")
    # Text is drawn at fixed lattice points in level coordinates: (ox, oy) is always inside the text.
    ox, oy = a._text_offset
    region = np.asarray(a.read_region((ox - 4, oy), 0, (400, 60)).convert("L"))
    assert (region < 40).sum() > 100


def test_measure_tile_latency_and_ingest_memory():
    """Runs workbench/scripts/measure_ingest_and_tiles.py and PRINTS the measured numbers."""
    script = API_DIR.parent / "scripts" / "measure_ingest_and_tiles.py"
    out = subprocess.run([sys.executable, str(script)], cwd=API_DIR, capture_output=True, text=True, timeout=300)
    assert out.returncode == 0, out.stderr[-2000:]
    data = json.loads(out.stdout[out.stdout.index("{"):])
    ing, tiles = data["ingest"], data["tiles"]
    print("\nMEASURED on", data["machine"])
    print(f"  ingest CMU-1-Small-Region.svs: {ing['ingest_seconds'] * 1000:.0f} ms; peak RSS "
          f"{ing['peak_rss_bytes'] / 2**20:.1f} MiB (baseline after imports {ing['baseline_rss_bytes'] / 2**20:.1f} MiB, "
          f"ingest delta {ing['ingest_delta_rss_bytes'] / 2**20:.1f} MiB)")
    print(f"  tiles: cold DZI {tiles['cold_dzi_ms']} ms; first tile {tiles['first_tile_ms']} ms; cached handle "
          f"distinct tiles median {tiles['cached_handle_distinct_tiles_ms']['median']} ms "
          f"(p95 {tiles['cached_handle_distinct_tiles_ms']['p95']} ms); same tile median "
          f"{tiles['cached_handle_same_tile_ms']['median']} ms")
    assert ing["peak_rss_bytes"] > ing["baseline_rss_bytes"] > 0
    assert tiles["first_tile_ms"] > 0 and tiles["cached_handle_distinct_tiles_ms"]["n"] == 30
    assert (ing["width"], ing["height"], ing["levels"]) == (2220, 2967, 1)
    out_dir = API_DIR.parent / "var"
    out_dir.mkdir(exist_ok=True)
    (out_dir / "last-measurements.json").write_text(json.dumps(data, indent=2))  # gitignored


def test_tile_service_lru_is_bounded():
    from dermpath.slides.synthetic import SyntheticSlide, make_spec
    from dermpath.slides.tiles import TileService

    svc = TileService(capacity=2, tile_size=254, overlap=1, quality=75)
    opened = []

    def opener(seed):
        def _open():
            opened.append(seed)
            return SyntheticSlide(make_spec(seed, width=2048, height=2048, downsamples=(1, 4)))
        return _open

    for seed in (1, 2, 1, 3, 1, 2):
        assert svc.tile_jpeg(f"s{seed}", opener(seed), 11, 0, 0)[:2] == b"\xff\xd8"
    st = svc.stats()
    assert st["open_slides"] == 2 and st["capacity"] == 2 and st["evictions"] == 2
    assert opened == [1, 2, 3, 2]  # s1 stayed hot (LRU), s2 was evicted and reopened


def test_bounded_thumbnail_matches_direct_path_for_large_single_level_images(monkeypatch):
    import numpy as np

    from dermpath.slides import imaging
    from dermpath.slides.synthetic import SyntheticSlide, make_spec

    s = SyntheticSlide(make_spec(5, width=2048, height=1536, downsamples=(1,)))  # one level
    monkeypatch.setattr(imaging, "DIRECT_THUMBNAIL_MAX_PIXELS", 1_000_000)  # force the strip path
    monkeypatch.setattr(imaging, "STRIP_ROWS", 256)  # several strips
    strips = imaging.bounded_thumbnail(s, (512, 512))
    monkeypatch.setattr(imaging, "DIRECT_THUMBNAIL_MAX_PIXELS", 10**12)
    direct = imaging.bounded_thumbnail(s, (512, 512))
    assert strips.size == direct.size == (512, 384)
    diff = np.abs(np.asarray(strips, dtype=int) - np.asarray(direct, dtype=int)).mean()
    assert diff < 4 and imaging.hamming_hex(imaging.dhash(strips), imaging.dhash(direct)) <= 2
