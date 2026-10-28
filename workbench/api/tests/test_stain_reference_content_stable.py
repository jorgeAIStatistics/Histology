"""Regression: the macenko-v1 stain reference is keyed by slide content, not database ids.

Found by the COBRA experiment driver's dry run (2026-10-27): three imports of the same six COBRA slides (identical
bytes and an identical, content-stable patient split) fitted three different macenko-v1 references, because the
reference's choice of train slides (above ``STAIN_REFERENCE_MAX_SLIDES``) and of their patches was seeded with the
database slide ids. Every macenko feature set, and every run on it, then depended on the import. The same cohort under
new ids must fit the same reference (design §5, "Implemented differently", stain reference seeding).
"""

from __future__ import annotations

import hashlib

from feature_set_support import (
    ASSISTANT_ID,
    HANDCRAFTED,
    LABELS,
    _lineage,
    _project,
    actors,
    cmu_slide_id,
    create_set,
    get_set,
)


def _cohort(ids, *, project_id: str, prefix: str, n: int = 4) -> dict:
    """The same ``n`` CMU byte variants as :func:`feature_set_support.real_cohort`, under id ``prefix`` and in its
    own project. Every patient is train (ratios train 1.0), so the split cannot depend on the project's salt."""
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
        project = _project(db, project_id, f"stain reference re-import test {prefix} (fictional records)")
        slides = []
        for i in range(n):
            block = _lineage(db, project.id, i, prefix=prefix)
            data = base + b"\x00" * (i + 1) + b"dermpath-feature-set-test"
            sid = f"{prefix}slide{i:03d}"
            key = slide_key(project.id, sid, "original.svs")
            store.put_bytes(key, data)
            s = Slide(id=sid, project_id=project.id, block_id=block.id, level_index=1, stain="H&E",
                      scanner_id="scanner-a", provenance="real_authorized", image_kind="wsi", object_key=key,
                      sha256=hashlib.sha256(data).hexdigest(), bytes=len(data), format="svs", vendor=cmu.vendor,
                      width=cmu.width, height=cmu.height, levels=cmu.levels,
                      level_dimensions_json=cmu.level_dimensions_json,
                      level_downsamples_json=cmu.level_downsamples_json, mpp_x=cmu.mpp_x, mpp_y=cmu.mpp_y,
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
        dv = create_draft(db, a["lead"], project, name="stain reference re-import cohort",
                          config={"label_scope": "slide", "eligible_review_states": ["approved"],
                                  "include_provenance": ["real_authorized"], "label_values": list(LABELS),
                                  "split": {"partition": "random", "seed": 0,
                                            "ratios": {"train": 1.0, "val": 0.0, "test": 0.0}}})
        freeze(db, a["lead"], dv, reason="stain reference test dataset", acknowledge_warnings=True)
        assert {it["split"] for it in dv.manifest_json["items"]} == {"train"}
        return {"project_id": project.id, "dataset_version_id": dv.id, "sha_of": {s.id: s.sha256 for s in slides}}


def test_stain_reference_does_not_depend_on_database_ids(env, ids, monkeypatch):
    from dermpath.ml import feature_sets as fsm

    # Two of four train slides: the slide choice is seeded too, not only the patch choice.
    monkeypatch.setattr(fsm, "STAIN_REFERENCE_MAX_SLIDES", 2)
    params = {"max_patches_per_slide": 16, "stain_normalization": "macenko-v1"}  # 16 sampled > 8 reference patches
    out = []
    for project_id, prefix in (("proj-stain-a", "sta"), ("proj-stain-b", "stb")):
        c = _cohort(ids, project_id=project_id, prefix=prefix)
        fs_id = create_set(c["project_id"], encoder_id=HANDCRAFTED, execution_mode="supervised_experiment",
                           dataset_version_id=c["dataset_version_id"], params=params)
        fsm.build_feature_set(fs_id)
        fs = get_set(fs_id)
        assert fs.status == "ready" and fs.stain_reference_sha256
        out.append((fs, fs.stain_policy_json["reference_fit"], c))
    (fa, fit_a, ca), (fb, fit_b, cb) = out
    # The same cohort under other ids fits the identical reference ...
    assert fa.stain_reference_sha256 == fb.stain_reference_sha256
    # ... from the same slides (by content), chosen by the declared content key.
    assert fit_a["selection_key"] == fit_b["selection_key"] == fsm.STAIN_REFERENCE_SELECTION_KEY == "slide_sha256"
    assert len(fit_a["train_slide_ids"]) == len(fit_b["train_slide_ids"]) == 2
    assert sorted(ca["sha_of"][s] for s in fit_a["train_slide_ids"]) == \
        sorted(cb["sha_of"][s] for s in fit_b["train_slide_ids"])
    # Normalised embeddings of the same slide bytes are then identical across the two imports.
    a_by_sha = {ca["sha_of"][s]: s for s in ca["sha_of"]}
    b_by_sha = {cb["sha_of"][s]: s for s in cb["sha_of"]}
    sha = sorted(a_by_sha)[0]
    ea = fsm.load_slide_features(fa.id, a_by_sha[sha])
    eb = fsm.load_slide_features(fb.id, b_by_sha[sha])
    assert ea.stain_policy_sha256 == eb.stain_policy_sha256
    assert ea.embeddings.shape == eb.embeddings.shape and (ea.embeddings == eb.embeddings).all()


def test_choose_train_slides_ranks_by_content():
    from dermpath.ml.feature_sets import _choose_train_slides

    shas = [hashlib.sha256(f"slide-{i}".encode()).hexdigest() for i in range(10)]
    a = {f"id-a-{i}": s for i, s in enumerate(shas)}
    b = {f"zz-other-id-{9 - i}": s for i, s in enumerate(shas)}  # same content, unrelated ids
    pick_a = _choose_train_slides(sorted(a), 7, 3, a)
    pick_b = _choose_train_slides(sorted(b), 7, 3, b)
    assert len(pick_a) == len(pick_b) == 3 and pick_a == sorted(pick_a)
    assert sorted(a[s] for s in pick_a) == sorted(b[s] for s in pick_b)
    assert _choose_train_slides(sorted(a), 7, 10, a) == sorted(a)  # up to the limit: every train slide
