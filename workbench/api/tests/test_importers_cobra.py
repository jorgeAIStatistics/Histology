"""COBRA importer (``dermpath.importers.cobra``) on stand-in images.

The stand-ins are copies of the CC0 fixture ``CMU-1-Small-Region.svs`` written as ``<name>.tif``, each with distinct
trailing padding (TIFF readers ignore trailing bytes) so every copy has its own sha256; the checksum list holds
their real sha256s. Their pixels say nothing about BCC: the rows' labels are fictional stand-ins for COBRA's
published labels and exist only to exercise the import path. Nothing here reads the real COBRA files.
"""

from __future__ import annotations

import csv
import hashlib
import json

import pytest
from sqlalchemy import select

from dermpath.db import session_scope
from dermpath.hierarchy import slide_lineage
from dermpath.importers import ImportRefused
from dermpath.importers.cobra import LICENCE, PROJECT_ID, PROJECT_NAME, import_cobra, main, scanner_slug
from dermpath.labels import label_dict, reference_label
from dermpath.models import AuditEvent, Case, CodedPatient, Job, LabelVersion, Project, ProjectMember, Slide
from dermpath.storage import get_store, slide_key

SCANNER = "3D Histech Panoramic P1000"
HEADER = ["filename", "patient_id", "group", "label", "category", "specimennumber", "block", "stainingname",
          "size_mb", "width", "height", "levels", "spacing0_um", "scanner"]
# CMU-1-Small-Region.svs: 2220 x 2967 px, one level, 0.499 um/px (its own metadata).
GEOMETRY = {"size_mb": "1.94", "width": "2220", "height": "2967", "levels": "1", "spacing0_um": "0.499"}
ROWS = [
    {"filename": "a" * 32, "patient_id": "P000101", "group": "single", "label": "1",
     "category": "Basal cell carcinoma", "specimennumber": "1", "block": "1", "stainingname": "HE  1"},
    {"filename": "b" * 32, "patient_id": "P000102", "group": "mixed", "label": "0",
     "category": "Non-malignant", "specimennumber": "2", "block": "1", "stainingname": "HE 1-2-3"},
    {"filename": "c" * 32, "patient_id": "P000102", "group": "mixed", "label": "1",
     "category": "Basal cell carcinoma", "specimennumber": "1", "block": "1", "stainingname": "HE  1"},
]


def _write_csv(path, header, rows):
    with open(path, "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=header)
        w.writeheader()
        w.writerows(rows)


def _dataset(tmp_path, cmu_bytes, rows, *, bad_sha: set[str] = frozenset(), missing_sha: set[str] = frozenset(),
             missing_file: set[str] = frozenset()):
    """A COBRA-shaped directory: images/, subset/selection.csv, subset/sha256.txt, metadata/*.csv, LICENSE."""
    root = tmp_path / "cobra"
    images, subset, metadata = root / "images", root / "subset", root / "metadata"
    for d in (images, subset, metadata):
        d.mkdir(parents=True, exist_ok=True)
    lines = []
    for i, r in enumerate(rows):
        data = cmu_bytes + b"\x00" * 4096 + f"cobra-stand-in-{i}".encode()
        if r["filename"] not in missing_file:
            (images / f"{r['filename']}.tif").write_bytes(data)
        sha = hashlib.sha256(data).hexdigest()
        if r["filename"] in bad_sha:
            sha = hashlib.sha256(b"not these bytes").hexdigest()
        if r["filename"] not in missing_sha:
            lines.append(f"{sha}  {r['filename']}.tif")
    (subset / "sha256.txt").write_text("\n".join(lines) + "\n")
    full = [{**GEOMETRY, **r, "scanner": SCANNER} for r in rows]
    _write_csv(subset / "selection.csv", HEADER, full)
    _write_csv(metadata / "bcc_bcc.csv", ["filename", "category", "label"],
               [{"filename": r["filename"], "category": r["category"], "label": r["label"]} for r in full])
    _write_csv(metadata / "bcc_patient.csv",
               ["filename", "stainingname", "block", "specimennumber", "specimenmethod", "patientgender", "patient_id",
                "patient_age"],
               [{"filename": r["filename"], "stainingname": r["stainingname"], "block": r["block"],
                 "specimennumber": r["specimennumber"], "specimenmethod": "biopt", "patientgender": "F",
                 "patient_id": r["patient_id"], "patient_age": "77"} for r in full])
    _write_csv(metadata / "bcc_images.csv",
               ["filename", "File Size (MB)", "Width (px)", "Height (px)", "Levels", "Spacings (mu)", "Downsamples",
                "Scanner"],
               [{"filename": r["filename"] + ".tif", "File Size (MB)": r["size_mb"], "Width (px)": r["width"],
                 "Height (px)": r["height"], "Levels": r["levels"], "Spacings (mu)": f"[{r['spacing0_um']}]",
                 "Downsamples": "(1.0,)", "Scanner": r["scanner"]} for r in full])
    (root / "LICENSE").write_text("Attribution-NonCommercial-ShareAlike 4.0 International (test copy)\n")
    return root


def _run(root, **kw):
    return import_cobra(root / "subset" / "selection.csv", root / "images", root / "subset" / "sha256.txt",
                        metadata_dir=root / "metadata", license_file=root / "LICENSE", **kw)


def _counts(db):
    def n(model, *where):
        return len(db.scalars(select(model.id).where(*where)).all())

    return {"slides": n(Slide, Slide.project_id == PROJECT_ID), "cases": n(Case, Case.project_id == PROJECT_ID),
            "patients": n(CodedPatient, CodedPatient.project_id == PROJECT_ID),
            "labels": n(LabelVersion, LabelVersion.project_id == PROJECT_ID),
            "jobs": n(Job, Job.project_id == PROJECT_ID),
            "members": n(ProjectMember, ProjectMember.project_id == PROJECT_ID)}


def test_import_creates_an_honestly_labelled_public_dataset_and_is_idempotent(env, tmp_path, cmu_bytes, run_worker):
    root = _dataset(tmp_path, cmu_bytes, ROWS)
    summary = _run(root)
    assert summary["counts"] == {"imported": 3} and summary["refused"] == [] and summary["project_created"] is True
    assert summary["label_values"] == {"bcc_absent_not_benign": 1, "bcc_present": 2}
    assert summary["verification"]["jobs_pending"] == 3 and "worker" in summary["next_step"]
    with session_scope() as db:
        project = db.get(Project, PROJECT_ID)
        assert project.name == PROJECT_NAME and project.demo_seeded is False
        pub = project.settings_json["public_dataset"]
        assert pub["licence"] == LICENCE == "CC BY-NC-SA 4.0" and pub["commercial_use"] == "not permitted"
        assert pub["label_source"] == "imported_reference" and "rule-based" in pub["label_method"]
        assert pub["licence_file_sha256"] == hashlib.sha256((root / "LICENSE").read_bytes()).hexdigest()
        assert pub["selection"]["rows"] == 3 and "sex and age are not imported" in pub["personal_attributes_imported"]
        assert pub["label_mapping"] == {"1": "bcc_present", "0": "bcc_absent_not_benign"}
        members = set(db.scalars(select(ProjectMember.user_id).where(ProjectMember.project_id == PROJECT_ID)).all())
        assert members == {"user-research-lead", "user-pathologist", "user-director"}
        before = _counts(db)
        assert before == {"slides": 3, "cases": 3, "patients": 2, "labels": 3, "jobs": 3, "members": 3}
        cases = {c.accession_code: c for c in db.scalars(select(Case).where(Case.project_id == PROJECT_ID)).all()}
        assert set(cases) == {"COBRA-P000101-S1", "COBRA-P000102-S2", "COBRA-P000102-S1"}
        for c in cases.values():
            assert c.provenance == "public_licensed" and c.site_id == "radboudumc" and c.collected_on is None
            assert "CC BY-NC-SA 4.0" in c.note and "non-commercial" in c.note
        slides = {s.original_filename: s for s in db.scalars(select(Slide).where(Slide.project_id == PROJECT_ID))}
        for r in ROWS:
            s = slides[r["filename"] + ".tif"]
            lin = slide_lineage(db, s)
            assert lin["patient_code"] == f"COBRA-{r['patient_id']}"
            assert lin["accession_code"] == f"COBRA-{r['patient_id']}-S{r['specimennumber']}"
            assert (lin["part"], lin["block"], s.level_index, s.stain) == ("A", "1", 1, "H&E")
            assert s.scanner_id == scanner_slug(SCANNER) == "3d-histech-panoramic-p1000"
            assert (s.provenance, s.image_kind, s.review_state, s.ingest_status) == (
                "public_licensed", "wsi", "imported", "pending")
            # The stored original is byte-identical to the listed file (verified against the checksum list).
            src = (root / "images" / f"{r['filename']}.tif").read_bytes()
            assert s.sha256 == hashlib.sha256(src).hexdigest() == get_store().sha256(s.object_key)
            assert r["filename"] not in s.object_key  # keys are generated, never file names
            (lv,) = db.scalars(select(LabelVersion).where(LabelVersion.slide_id == s.id)).all()
            assert lv.source == "imported_reference" and lv.author_id is None and lv.scope == "slide"
            assert f"category '{r['category']}'" in lv.reason and "rule-based" in lv.reason
            if r["label"] == "1":
                assert lv.value == "bcc_present"
            else:
                assert lv.value == "bcc_absent_not_benign" and "NOT the same as benign" in lv.reason
                assert label_dict(lv)["display"].startswith("BCC absent")
            # Expert reference (the default) ignores it; the imported standard uses it.
            assert reference_label(db, PROJECT_ID, "slide", s.id) == (None, "unlabeled")
            ref, status = reference_label(db, PROJECT_ID, "slide", s.id, reference_standard="imported_reference")
            assert ref.id == lv.id and status == "imported_reference"
            record = json.loads(get_store().get_bytes(slide_key(PROJECT_ID, s.id, "import_record.json")))
            assert record["sha256"] == s.sha256 and record["licence"] == LICENCE
            assert record["label"]["cobra_category"] == r["category"] and record["source_row"]["group"] == r["group"]
            assert record["metadata_cross_check"]["specimenmethod"] == "biopt"
            flat = json.dumps(record)
            assert "patientgender" not in flat and "patient_age" not in flat and '"77"' not in flat
        events = db.scalars(select(AuditEvent.action).where(AuditEvent.project_id == PROJECT_ID)).all()
        assert events.count("slide.imported") == 3 and "dataset.import_run" in events
        assert events.count("label.imported_reference_recorded") == 3

    outcomes = run_worker()
    assert {(o.type, o.status) for o in outcomes} >= {("ingest", "succeeded"), ("qc_screen", "succeeded")}
    with session_scope() as db:
        for s in db.scalars(select(Slide).where(Slide.project_id == PROJECT_ID)):
            assert s.ingest_status == "succeeded" and s.thumbnail_key and abs(s.mpp_x - 0.499) < 1e-3

    again = _run(root)  # idempotent: nothing new, and the ingest is verified against the metadata
    assert again["counts"] == {"existing": 3} and again["project_created"] is False
    assert all(r["label_created"] is False for r in again["results"])
    v = again["verification"]
    assert v["complete"] is True and v["ingest_status"] == {"succeeded": 3} and v["metadata_mismatches"] == []
    assert v["jobs"]["ingest"] == {"succeeded": 3} and v["jobs"]["qc_screen"] == {"succeeded": 3}
    with session_scope() as db:
        assert _counts(db) == {**before, "jobs": 6}  # + the three QC screens queued by ingest

    # The imported slides form a real-data dataset only under the imported reference standard.
    from dermpath.auth import Actor
    from dermpath.datasets import create_draft, freeze

    lead = Actor("user-research-lead", "research_lead", "Priya Navarro")
    with session_scope() as db:
        project = db.get(Project, PROJECT_ID)
        expert = create_draft(db, lead, project, name="expert", config={"include_provenance": ["public_licensed"]})
        assert {r["code"] for e in expert.exclusions_json for r in e["reasons"]} == {
            "review_state_imported", "no_reference_label_slide"} and len(expert.exclusions_json) == 3
        dv = create_draft(db, lead, project, name="cobra-imported", config={
            "include_provenance": ["public_licensed"], "reference_standard": "imported_reference",
            "eligible_review_states": ["imported"], "split": {"partition": "random", "seed": 0}})
        assert dv.exclusions_json == []
        freeze(db, lead, dv, reason="tiny stand-in cohort; warnings acknowledged (test)", acknowledge_warnings=True)
        m = dv.manifest_json
        assert m["data_mode"] == "real" and m["provenance_mix"] == {"public_licensed": 3}
        assert m["counts"] == {"patients": 2, "cases": 3, "blocks": 3, "slides": 3}
        assert m["config"]["reference_standard"] == "imported_reference"
        assert {it["label_source"] for it in m["items"]} == {"imported_reference"}
        assert m["label_provenance"]["label_sources"] == {"imported_reference": 3}
        assert len(m["label_provenance"]["provenance_texts"]) == 2  # one text per COBRA label/category pair
        assert m["public_dataset"]["licence"] == LICENCE and m["public_dataset"]["commercial_use"] == "not permitted"
        assert m["split_diagnostics"]["mixed_label_patients"]["patient_codes"] == ["COBRA-P000102"]


def test_refuses_mismatched_unlisted_missing_and_inconsistent_rows(env, tmp_path, cmu_bytes, capsys):
    rows = ROWS + [
        {"filename": "d" * 32, "patient_id": "P000103", "group": "single", "label": "0", "category": "Non-malignant",
         "specimennumber": "1", "block": "1", "stainingname": "HE  1"},
        {"filename": "e" * 32, "patient_id": "P000104", "group": "single", "label": "1",
         "category": "Basal cell carcinoma", "specimennumber": "1", "block": "1", "stainingname": "HE  1"},
        {"filename": "f" * 32, "patient_id": "P000105", "group": "single", "label": "1",
         "category": "Basal cell carcinoma", "specimennumber": "1", "block": "1", "stainingname": "HE  1"},
        {"filename": "../" + "g" * 29, "patient_id": "P000106", "group": "single", "label": "1",
         "category": "Basal cell carcinoma", "specimennumber": "1", "block": "1", "stainingname": "HE  1"},
        {"filename": "h" * 32, "patient_id": "P000107", "group": "single", "label": "1",
         "category": "Non-malignant", "specimennumber": "1", "block": "1", "stainingname": "HE  1"},
    ]
    root = _dataset(tmp_path, cmu_bytes, rows, bad_sha={"d" * 32}, missing_sha={"e" * 32}, missing_file={"f" * 32})
    # A selection row that disagrees with COBRA's own metadata is refused too.
    sel = list(csv.DictReader(open(root / "subset" / "selection.csv")))
    sel[2]["block"] = "2"
    _write_csv(root / "subset" / "selection.csv", HEADER, sel)

    code = main(["--selection", str(root / "subset" / "selection.csv"), "--images", str(root / "images"),
                 "--sha256", str(root / "subset" / "sha256.txt"), "--metadata", str(root / "metadata"),
                 "--process-jobs"])
    assert code == 1
    out = json.loads(capsys.readouterr().out)
    assert out["jobs_processed"] == {"ingest:succeeded": 2, "qc_screen:succeeded": 2}
    assert out["verification"]["complete"] is True and out["verification"]["ingest_status"] == {"succeeded": 2}
    refused = {r["filename"]: r["code"] for r in out["refused"]}
    assert refused == {"d" * 32: "sha256_mismatch", "e" * 32: "sha256_missing", "f" * 32: "file_missing",
                       "../" + "g" * 29: "unsafe_filename", "h" * 32: "label_category_inconsistent",
                       "c" * 32: "metadata_mismatch"}
    assert out["counts"] == {"imported": 2, "refused": 6}
    with session_scope() as db:
        names = set(db.scalars(select(Slide.original_filename).where(Slide.project_id == PROJECT_ID)).all())
        assert names == {"a" * 32 + ".tif", "b" * 32 + ".tif"}  # nothing was written for a refused row
        assert db.scalars(select(CodedPatient.id).where(CodedPatient.code == "COBRA-P000103")).first() is None
    # The mismatching file left no object behind.
    settings, _ = env
    stored = sorted((settings.objects_dir / "projects" / PROJECT_ID).rglob("*.tif"))
    assert len(stored) == 2 and all(p.name == "original.tif" for p in stored)
    assert not list((settings.objects_dir / "projects" / PROJECT_ID).rglob("*.tmp"))


def test_dry_run_writes_nothing_and_project_ids_are_checked(env, tmp_path, cmu_bytes):
    root = _dataset(tmp_path, cmu_bytes, ROWS[:1])
    summary = _run(root, dry_run=True)
    assert summary["counts"] == {"would_import": 1} and "verification" not in summary
    with session_scope() as db:
        assert db.get(Project, PROJECT_ID) is None
    with pytest.raises(ImportRefused):  # an existing project that is not a public dataset project
        _run(root, project_id="proj-bcc-demo")
    with pytest.raises(ImportRefused):
        _run(root, project_id="Not A Slug")
    assert main(["--selection", str(root / "missing.csv"), "--images", str(root / "images"),
                 "--sha256", str(root / "subset" / "sha256.txt")]) == 2
