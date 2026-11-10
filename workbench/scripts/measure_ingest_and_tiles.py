#!/usr/bin/env python3
"""Measure (do not invent) ingest memory and tile latency on THIS machine.

Usage (from workbench/api):
    .venv/bin/python ../scripts/measure_ingest_and_tiles.py [--slide ../fixtures/CMU-1-Small-Region.svs]

What it does, in a throwaway var directory:
1. Peak RSS: a fresh child process imports the backend, records its RSS baseline, runs the
   real ingest of the slide (OpenSlide open, decode checks, thumbnail, manifest), then
   reports ru_maxrss. The ingest delta is (peak - baseline).
2. Tile latency, through the real HTTP stack (FastAPI TestClient, in-process):
   * cold DZI: first descriptor request (opens the slide, builds the DeepZoom generator);
   * first tile: first tile request at the full-resolution DZI level;
   * cached: repeated tile requests with the slide handle already open (median, p95).
Prints one JSON object.
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import resource
import shutil
import statistics
import subprocess
import sys
import tempfile
import time
from pathlib import Path

API_DIR = Path(__file__).resolve().parent.parent / "api"
DEFAULT_SLIDE = API_DIR.parent / "fixtures" / "CMU-1-Small-Region.svs"


def _maxrss_bytes(r) -> int:
    return int(r.ru_maxrss if platform.system() == "Darwin" else r.ru_maxrss * 1024)


CHILD = r"""
import json, os, platform, resource, sys, time
sys.path.insert(0, os.environ["API_DIR"])
from pathlib import Path
from dermpath.config import Settings, set_settings
var = Path(os.environ["VAR"])
set_settings(Settings(var_dir=var, secret="m" * 40, auto_seed=False))
from dermpath.db import init_db, session_scope
from dermpath.models import Block, Case, CodedPatient, Project, Slide, SpecimenPart, User
from dermpath.slides.ingest import ingest_slide
from dermpath.storage import get_store, slide_key
init_db()
def rss():
    r = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return int(r if platform.system() == "Darwin" else r * 1024)
src = Path(os.environ["SLIDE"])
with session_scope() as db:
    db.add(User(id="u", display_name="Measure", role="histology_assistant"))
    db.add(Project(id="p", name="measure", task_template_json={}))
    db.flush()
    pt = CodedPatient(project_id="p", code="M-0001"); db.add(pt); db.flush()
    c = Case(project_id="p", coded_patient_id=pt.id, accession_code="MEAS-0001", provenance="public_cc0"); db.add(c); db.flush()
    part = SpecimenPart(project_id="p", case_id=c.id, designation="A"); db.add(part); db.flush()
    b = Block(project_id="p", part_id=part.id, designation="A1"); db.add(b); db.flush()
    key = slide_key("p", "s1", "original" + src.suffix)
    get_store().put_file(key, src)
    db.add(Slide(id="s1", project_id="p", block_id=b.id, provenance="public_cc0", image_kind="wsi", object_key=key,
                 sha256=get_store().sha256(key), bytes=src.stat().st_size, ingest_status="pending"))
baseline = rss()
t0 = time.perf_counter()
res = ingest_slide("s1", None, auto_qc=False)
dt = time.perf_counter() - t0
peak = rss()
print(json.dumps({"baseline_rss_bytes": baseline, "peak_rss_bytes": peak, "ingest_seconds": dt,
                  "width": res["width"], "height": res["height"], "levels": res["levels"]}))
"""


def measure_ingest(slide: Path, var: Path) -> dict:
    env = {**os.environ, "API_DIR": str(API_DIR), "VAR": str(var), "SLIDE": str(slide)}
    out = subprocess.run([sys.executable, "-c", CHILD], env=env, capture_output=True, text=True, check=True)
    data = json.loads(out.stdout.strip().splitlines()[-1])
    data["ingest_delta_rss_bytes"] = data["peak_rss_bytes"] - data["baseline_rss_bytes"]
    data["child_ru_maxrss_bytes"] = _maxrss_bytes(resource.getrusage(resource.RUSAGE_CHILDREN))
    return data


def measure_tiles(slide: Path, var: Path, repeats: int = 30) -> dict:
    sys.path.insert(0, str(API_DIR))
    from fastapi.testclient import TestClient

    from dermpath.config import Settings
    from dermpath.main import create_app
    from dermpath.seed import PROJECT_ID, seed

    from dermpath.config import set_settings

    settings = Settings(var_dir=var, secret="t" * 40, auto_seed=False)
    set_settings(settings)
    summary = seed()
    sid = summary["slides"]["cmu_cc0"]
    app = create_app(settings)
    from dermpath.slides.tiles import get_tile_service

    get_tile_service().clear()  # cold start for the tile service
    with TestClient(app) as c:
        c.post("/api/v1/auth/demo-login", json={"userId": "user-pathologist"})
        tok = c.get(f"/api/v1/slides/{sid}/viewer-token").json()
        get_tile_service().clear()  # viewer-token opened the slide for bounds; start cold again
        t0 = time.perf_counter()
        dzi = c.get(tok["dzi_url"])
        cold_dzi = time.perf_counter() - t0
        assert dzi.status_code == 200
        import xml.etree.ElementTree as ET

        root = ET.fromstring(dzi.text)
        tile_size = int(root.get("TileSize"))
        size = root.find("{http://schemas.microsoft.com/deepzoom/2008}Size")
        w, h = int(size.get("Width")), int(size.get("Height"))
        import math

        max_level = math.ceil(math.log2(max(w, h)))
        cols, rows = math.ceil(w / tile_size), math.ceil(h / tile_size)
        url = tok["tile_url_template"].format(level=max_level, col=cols // 2, row=rows // 2)
        t0 = time.perf_counter()
        first = c.get(url)
        first_tile = time.perf_counter() - t0
        assert first.status_code == 200 and first.content[:2] == b"\xff\xd8"
        cached = []
        for i in range(repeats):
            col, row = (cols // 2 + i) % cols, (rows // 2 + i // cols) % rows
            u = tok["tile_url_template"].format(level=max_level, col=col, row=row)
            t0 = time.perf_counter()
            r = c.get(u)
            cached.append(time.perf_counter() - t0)
            assert r.status_code == 200
        same = []
        for _ in range(repeats):
            t0 = time.perf_counter()
            c.get(url)
            same.append(time.perf_counter() - t0)
    q = lambda xs, p: sorted(xs)[min(len(xs) - 1, int(round(p * (len(xs) - 1))))]  # noqa: E731
    return {
        "slide": slide.name,
        "dzi_size": [w, h], "dzi_tile_size": tile_size, "dzi_max_level": max_level,
        "cold_dzi_ms": round(cold_dzi * 1000, 2),
        "first_tile_ms": round(first_tile * 1000, 2),
        "cached_handle_distinct_tiles_ms": {"median": round(statistics.median(cached) * 1000, 2),
                                            "p95": round(q(cached, 0.95) * 1000, 2), "n": len(cached)},
        "cached_handle_same_tile_ms": {"median": round(statistics.median(same) * 1000, 2),
                                       "p95": round(q(same, 0.95) * 1000, 2), "n": len(same)},
        "note": "In-process HTTP (TestClient) incl. token check, membership check, JPEG encode; no network.",
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--slide", default=str(DEFAULT_SLIDE))
    args = ap.parse_args()
    slide = Path(args.slide).resolve()
    tmp = Path(tempfile.mkdtemp(prefix="wb-measure-"))
    try:
        ingest = measure_ingest(slide, tmp / "ingest")
        tiles = measure_tiles(slide, tmp / "tiles") if slide == DEFAULT_SLIDE.resolve() else None
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    print(json.dumps({"machine": f"{platform.system()} {platform.machine()}, Python {platform.python_version()}",
                      "ingest": ingest, "tiles": tiles}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
