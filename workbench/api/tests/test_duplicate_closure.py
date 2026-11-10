"""Confirmed-duplicate groups are transitive through slides no dataset includes (fold-safety fix round 2).
Research use only; every record here is fictional.

``A~X`` and ``X~B`` (X a slide outside the dataset, e.g. an excluded re-scan) make A and B the same material. The
engine-side consumers (folds, inner splits, evidence gates, the reference-fit check, the holdout cross-split record)
are covered by ``tests/test_verify2_fold_safety.py``; this file covers the shared closure and the dataset side:
the split allocator, the freeze warnings and the manifest's decisions in force.
"""

from __future__ import annotations

import hashlib

from test_ml_support import CID, LEAD, cohort

POS, NEG = "bcc_present", "bcc_absent_not_benign"


def test_closure_joins_patients_through_slides_outside_the_mapping_and_through_a_patients_own_slides():
    from dermpath.splits import duplicate_closure_pairs

    owner = {"a1": "A", "a2": "A", "b1": "B", "c1": "C", "d1": "D", "e1": "E"}
    pairs = [("a1", "x"), ("x", "y"), ("y", "b1"),  # A~B through two slides outside the mapping
             ("a2", "c1"),                          # C joins A through A's other slide (so B~C too)
             ("d1", "z"), ("e1", "w")]               # D and E are not joined
    assert duplicate_closure_pairs(pairs, owner) == [("A", "B"), ("A", "C"), ("B", "C")]
    assert duplicate_closure_pairs([("a1", "a2")], owner) == []  # same patient: no pair
    assert duplicate_closure_pairs([], owner) == []


def test_closure_consumers_in_cv_follow_a_chain_through_an_absent_patient():
    from dermpath.ml.cv import build_units, duplicate_groups

    keys = {p: f"K-{p}" for p in ("A", "B", "C")}
    groups = duplicate_groups(["A", "B", "C"], patient_keys=keys, duplicate_pairs=[("A", "T"), ("T", "B")])
    assert groups["A"] == groups["B"] == "K-A+K-B" and groups["C"] == "K-C"
    units, diag = build_units([1, 1, 0], ["A", "B", "C"], patient_keys=keys,
                              duplicate_pairs=[("A", "T"), ("T", "B")])
    assert sorted(u.unit_key for u in units) == ["K-A+K-B", "K-C"]
    assert diag["duplicate_pairs_ignored"] == [["A", "T"], ["B", "T"]]  # listed, yet followed transitively


def _excluded_slide(slide_id: str) -> str:
    from dermpath.db import session_scope, utcnow
    from dermpath.models import Slide

    with session_scope() as db:
        db.add(Slide(id=slide_id, project_id=CID, provenance="demo_synthetic", image_kind="synthetic_tiles",
                     object_key=f"projects/{CID}/slides/{slide_id}/synthetic_spec.json",
                     sha256=hashlib.sha256(slide_id.encode()).hexdigest(), format="synthetic_procedural",
                     width=8192, height=6144, levels=1, level_dimensions_json=[[8192, 6144]],
                     level_downsamples_json=[1.0], ingest_status="succeeded", ingested_at=utcnow(),
                     created_by="test"))
    return slide_id


def _duplicate(a: str, b: str) -> None:
    from dermpath.db import session_scope
    from dermpath.models import NearDuplicateReview

    with session_scope() as db:
        db.add(NearDuplicateReview(project_id=CID, slide_a_id=a, slide_b_id=b, decision="duplicate",
                                   reason="same tissue re-scanned (fictional)", reviewer_id=LEAD))


def _draft(name: str):
    from dermpath.auth import Actor
    from dermpath.datasets import create_draft
    from dermpath.db import session_scope
    from dermpath.models import Project

    with session_scope() as db:
        dv = create_draft(db, Actor(LEAD, "research_lead", "Priya Navarro"), db.get(Project, CID), name=name,
                          config={"label_scope": "slide", "eligible_review_states": ["approved"],
                                  "include_provenance": ["demo_synthetic"], "label_values": [POS, NEG]})
        return dv.id


def test_allocator_freeze_warning_and_manifest_see_a_chain_through_excluded_slides(env, ids):
    from dermpath.datasets import _duplicate_groups, assign_splits, freeze_warnings, item_rows
    from dermpath.db import session_scope
    from dermpath.models import DatasetVersion, SplitAssignment

    dv0 = cohort(ids)["dataset_version_id"]
    with session_scope() as db:
        rows = sorted(item_rows(db, db.get(DatasetVersion, dv0)), key=lambda r: r["slide_id"])
    first = {}
    for r in rows:
        first.setdefault(r["coded_patient_id"], r["slide_id"])
    (pa, sa), (pb, sb) = sorted(first.items())[0], sorted(first.items())[-1]
    x, y = _excluded_slide("dup-closure-x"), _excluded_slide("dup-closure-y")
    _duplicate(sa, x)
    _duplicate(x, y)  # names no included slide: only reachable through the chain
    _duplicate(y, sb)

    dv = _draft("duplicate closure: allocator")
    with session_scope() as db:
        d = db.get(DatasetVersion, dv)
        assert tuple(sorted((pa, pb))) in _duplicate_groups(db, d)
        assign_splits(db, d, {"partition": "random", "seed": 0, "ratios": {"train": 0.6, "val": 0.2, "test": 0.2}})
        split = {s.coded_patient_id: s.split for s in
                 db.query(SplitAssignment).filter(SplitAssignment.dataset_version_id == dv)}
        assert split[pa] == split[pb]  # one unit, allocated whole
        # Force the chain across splits (as an inherited or sealed split could): the freeze warning must block.
        for s in db.query(SplitAssignment).filter(SplitAssignment.dataset_version_id == dv):
            if s.coded_patient_id == pa:
                s.split = "train"
            elif s.coded_patient_id == pb:
                s.split = "val"
        db.flush()
        w = freeze_warnings(db, d)
    chain = [c for c in w["duplicates_across_splits"] if {c["slide_a"], c["slide_b"]} == {sa, sb}]
    assert chain and chain[0]["status"] == "confirmed_duplicate_chain", w["duplicates_across_splits"]

    from test_ml_support import custom_dataset

    dv2 = custom_dataset(CID, "duplicate closure: manifest", lambda code, labels: "train")
    with session_scope() as db:
        m = db.get(DatasetVersion, dv2).manifest_json
    decided = {tuple(sorted((d["slide_a"], d["slide_b"]))) for d in m["near_duplicate_decisions"]}
    assert tuple(sorted((x, y))) in decided  # the middle link is recorded, so the manifest alone closes the chain
    from dermpath.ml.training import duplicate_patient_pairs

    assert tuple(sorted((pa, pb))) in duplicate_patient_pairs(m)
