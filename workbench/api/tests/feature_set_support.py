"""Shared helpers for the feature-set tests (this module defines no tests).

* :func:`real_cohort` builds a separate project of ``real_authorized`` whole-slide records whose
  files are byte variants of the CC0 CMU-1-Small-Region fixture (trailing padding: still a valid
  SVS, a distinct sha256), with expert test labels set by the test (never derived from pixels)
  and a frozen, patient-split dataset version.
* :func:`image_slide` registers a ``real_authorized`` slide whose stored file is a small
  placeholder and whose reader is patched (``feature_sets.open_slide``) to serve an
  ``openslide.ImageSlide`` over a deterministic PIL image (design §11).
"""

from __future__ import annotations

import hashlib
from datetime import date

import numpy as np

LEAD_ID = "user-research-lead"
PATHOLOGIST_ID = "user-pathologist"
ASSISTANT_ID = "user-assistant"
DIRECTOR_ID = "user-director"
CMU_PROJECT = "proj-bcc-demo"
SYNTH = "synthetic-deterministic-v1"
HANDCRAFTED = "handcrafted-stain-texture-v1"
MEMBERS = (ASSISTANT_ID, PATHOLOGIST_ID, LEAD_ID, DIRECTOR_ID, "user-admin")
LABELS = ("bcc_present", "bcc_absent_not_benign")


def actors():
    from dermpath.auth import Actor

    return {"lead": Actor(LEAD_ID, "research_lead", "Priya Navarro"),
            "pathologist": Actor(PATHOLOGIST_ID, "pathologist", "Dr. Imani Castell"),
            "assistant": Actor(ASSISTANT_ID, "histology_assistant", "Sam Rivera")}


def cmu_slide_id(ids) -> str:
    return ids["slides"]["cmu_cc0"]


def _project(db, project_id: str, name: str):
    from dermpath.models import Project, ProjectMember
    from dermpath.seed import TASK_TEMPLATE

    project = db.get(Project, project_id)
    if project is not None:
        return project
    project = Project(id=project_id, name=name, description="feature-set test project (fictional records)",
                      task_template_json=TASK_TEMPLATE, settings_json={"independent_review": False})
    db.add(project)
    db.flush()
    for uid in MEMBERS:
        db.add(ProjectMember(project_id=project.id, user_id=uid, added_by="test"))
    db.flush()
    return project


def _lineage(db, project_id: str, i: int, *, prefix: str):
    from dermpath.models import Block, Case, CodedPatient, SpecimenPart

    patient = CodedPatient(id=f"{prefix}pt{i:03d}", project_id=project_id, code=f"{prefix.upper()}-{i:03d}",
                           created_by="test")
    db.add(patient)
    db.flush()
    case = Case(id=f"{prefix}case{i:03d}", project_id=project_id, coded_patient_id=patient.id,
                accession_code=f"{prefix.upper()}-C-{i:03d}", collected_on=date(2026, 1, 1 + i), site_id="site-a",
                provenance="real_authorized", created_by="test")
    db.add(case)
    db.flush()
    part = SpecimenPart(project_id=project_id, case_id=case.id, designation="A")
    db.add(part)
    db.flush()
    block = Block(project_id=project_id, part_id=part.id, designation="A1")
    db.add(block)
    db.flush()
    return block


def real_cohort(ids, *, n: int = 6, project_id: str = "proj-real-fs", uncalibrated: tuple[int, ...] = (),
                split_seed: int = 0, ratios: dict | None = None) -> dict:
    """A labelled real_authorized cohort (one slide per patient) and its frozen dataset version."""
    from dermpath.datasets import create_draft, freeze
    from dermpath.db import session_scope, utcnow
    from dermpath.labels import create_expert_label
    from dermpath.models import Slide
    from dermpath.review import set_review_state
    from dermpath.storage import get_store, slide_key

    a = actors()
    store = get_store()
    with session_scope() as db:
        cmu = db.get(Slide, cmu_slide_id(ids))
        base = store.get_bytes(cmu.object_key)
        project = _project(db, project_id, "Real-image feature-set test cohort (CMU variants)")
        slides = []
        for i in range(n):
            block = _lineage(db, project.id, i, prefix="rfs")
            data = base + b"\x00" * (i + 1) + b"dermpath-feature-set-test"
            sid = f"rfslide{i:03d}"
            key = slide_key(project.id, sid, "original.svs")
            store.put_bytes(key, data)
            cal = i not in uncalibrated
            s = Slide(id=sid, project_id=project.id, block_id=block.id, level_index=1, stain="H&E",
                      scanner_id="scanner-a", provenance="real_authorized", image_kind="wsi", object_key=key,
                      sha256=hashlib.sha256(data).hexdigest(), bytes=len(data), format="svs", vendor=cmu.vendor,
                      width=cmu.width, height=cmu.height, levels=cmu.levels,
                      level_dimensions_json=cmu.level_dimensions_json,
                      level_downsamples_json=cmu.level_downsamples_json,
                      mpp_x=cmu.mpp_x if cal else None, mpp_y=cmu.mpp_y if cal else None,
                      objective_power=cmu.objective_power, ingest_status="succeeded", ingested_at=utcnow(),
                      processing_version=cmu.processing_version, created_by=ASSISTANT_ID)
            db.add(s)
            db.flush()
            slides.append(s)
        for i, s in enumerate(slides):
            set_review_state(db, a["assistant"], s, "pending_review", reason="routed for expert labelling (test)")
            create_expert_label(db, a["pathologist"], s, scope="slide", target_id=None, value=LABELS[i % 2],
                                reason="expert test label set by the test (fictional record)")
            set_review_state(db, a["pathologist"], s, "approved", reason=None)
        db.flush()
        dv = create_draft(db, a["lead"], project, name="real feature-set cohort",
                          config={"label_scope": "slide", "eligible_review_states": ["approved"],
                                  "include_provenance": ["real_authorized"], "label_values": list(LABELS),
                                  "split": {"partition": "random", "seed": split_seed,
                                            "ratios": ratios or {"train": 0.5, "val": 0.25, "test": 0.25}}})
        freeze(db, a["lead"], dv, reason="feature-set test dataset", acknowledge_warnings=True)
        items = dv.manifest_json["items"]
        return {"project_id": project.id, "dataset_version_id": dv.id, "slide_ids": sorted(s.id for s in slides),
                "split_of": {it["slide_id"]: it["split"] for it in items},
                "label_of": {it["slide_id"]: it["label_value"] for it in items}}


def synthetic_tissue_image(width: int, height: int, seed: int = 0):
    """A deterministic tissue-like RGB image: pink/purple noise everywhere (every cell is tissue)."""
    from PIL import Image

    rng = np.random.default_rng(seed)
    yy, xx = np.mgrid[0:height, 0:width]
    base = np.stack([200 + 30 * np.sin(xx / 37.0), 120 + 40 * np.cos(yy / 23.0), 170 + 25 * np.sin((xx + yy) / 51.0)],
                    axis=-1)
    noise = rng.normal(0, 18, size=(height, width, 3))
    return Image.fromarray(np.clip(base + noise, 0, 255).astype(np.uint8), "RGB")


def image_slide(monkeypatch, *, project_id: str = CMU_PROJECT, slide_id: str = "imgslide0001", width: int = 2048,
                height: int = 2048, mpp: float | None = 0.5, seed: int = 0, image=None) -> str:
    """Register a real_authorized slide served by ``openslide.ImageSlide`` over a PIL image."""
    import openslide

    from dermpath.db import session_scope, utcnow
    from dermpath.ml import feature_sets
    from dermpath.models import Slide
    from dermpath.storage import get_store, slide_key

    img = image if image is not None else synthetic_tissue_image(width, height, seed)
    data = f"placeholder for a deterministic synthetic test image {slide_id} seed={seed}".encode()
    store = get_store()
    with session_scope() as db:
        key = slide_key(project_id, slide_id, "original.tiff")
        store.put_bytes(key, data)
        db.add(Slide(id=slide_id, project_id=project_id, provenance="real_authorized", image_kind="wsi",
                     object_key=key, sha256=hashlib.sha256(data).hexdigest(), bytes=len(data), format="tiff",
                     width=img.size[0], height=img.size[1], levels=1, level_dimensions_json=[list(img.size)],
                     level_downsamples_json=[1.0], mpp_x=mpp, mpp_y=mpp, ingest_status="succeeded",
                     ingested_at=utcnow(), created_by=ASSISTANT_ID))
    images = getattr(feature_sets, "_test_images", None)
    if images is None:
        images = {}
        original = feature_sets.open_slide

        def fake_open(slide):
            if slide.id in images:
                return openslide.ImageSlide(images[slide.id])
            return original(slide)

        monkeypatch.setattr(feature_sets, "open_slide", fake_open)
        monkeypatch.setattr(feature_sets, "_test_images", images, raising=False)
    images[slide_id] = img
    return slide_id


def create_set(project_id: str, *, encoder_id: str, execution_mode: str, dataset_version_id: str | None = None,
               slide_ids: list[str] | None = None, params: dict | None = None, name: str | None = None) -> str:
    from dermpath.db import session_scope
    from dermpath.ml.feature_sets import create_feature_set
    from dermpath.models import Project

    with session_scope() as db:
        fs = create_feature_set(db, actors()["lead"], db.get(Project, project_id), encoder_id=encoder_id,
                                execution_mode=execution_mode, dataset_version_id=dataset_version_id,
                                slide_ids=slide_ids, params=params, name=name)
        return fs.id


def get_set(fs_id: str):
    from dermpath.db import session_scope
    from dermpath.ml.engine_models import FeatureSet

    with session_scope() as db:
        return db.get(FeatureSet, fs_id)


def items_of(fs_id: str) -> dict:
    from sqlalchemy import select

    from dermpath.db import session_scope
    from dermpath.ml.engine_models import FeatureSetItem

    with session_scope() as db:
        return {i.slide_id: i for i in db.scalars(select(FeatureSetItem).where(FeatureSetItem.feature_set_id == fs_id))}
