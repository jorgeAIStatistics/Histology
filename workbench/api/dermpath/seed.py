"""Demo seed: plausible FICTIONAL workflow metadata only.

``python -m dermpath.seed`` seeds an empty database; ``--reset`` drops everything first.
The API seeds automatically on first start in demo mode (``WB_AUTO_SEED=1``).

What it creates
---------------
* six fictional users (one per role, plus a second pathologist for disagreement);
* project "BCC research template (demo)" with the research task template, and a second
  restricted project for access-control tests;
* six coded patients (P-0001 … P-0006; codes only), cases with parts A/B, blocks, levels,
  mostly H&E with one PAS slide, two sites and two scanners;
* slides: procedural synthetic tiles (DEMO SYNTHETIC, no histology), one synthetic PNG
  field image, the real CMU-1-Small-Region.svs as PUBLIC CC0 and UNLABELED, and one
  corrupt file whose ingest fails (a scan failure);
* workflow states: an approved set, a disputed slide, an adjudicated disagreement, an
  excluded slide with a reason, an incomplete case, QC issues at every lifecycle stage,
  DEMO-FIXTURE model suggestions (clearly marked as not produced by a trained model) with
  accepted and corrected reviews, a case-level label (not copied down), annotations with
  version history.

Nothing here is an experiment result. Seeded workflow statistics are reported by
``/projects/{pid}/workflow-stats`` with ``kind="workflow_metadata"``.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import logging
import random
import shutil
from datetime import date

from sqlalchemy import select

from . import audit
from .auth import Actor
from .config import FIXTURES_DIR, ensure_var_dirs, get_settings
from .db import drop_all, init_db, session_scope
from .jobs.queue import enqueue
from .jobs.worker import Worker
from .models import Block, Case, CodedPatient, Project, ProjectMember, QCIssue, Slide, SpecimenPart, User, new_id
from .slides.synthetic import SyntheticSlide, make_spec, spec_sha256
from .storage import get_store, slide_key

log = logging.getLogger("dermpath.seed")

PROJECT_ID = "proj-bcc-demo"
RESTRICTED_PROJECT_ID = "proj-restricted-demo"
CMU_FIXTURE = FIXTURES_DIR / "CMU-1-Small-Region.svs"
CMU_SHA256 = "ed92d5a9f2e86df67640d6f92ce3e231419ce127131697fbbce42ad5e002c8a7"

USERS = [
    ("user-assistant", "Sam Rivera", "histology_assistant"),
    ("user-pathologist", "Dr. Imani Castell", "pathologist"),
    ("user-pathologist-2", "Dr. Tomas Lindqvist", "pathologist"),
    ("user-research-lead", "Priya Navarro", "research_lead"),
    ("user-director", "Dr. Elena Marsh", "medical_director"),
    ("user-admin", "Jordan Pike", "admin"),
]

TASK_TEMPLATE = {
    "name": "BCC present vs BCC absent (research template)",
    "status": "engineering starting point awaiting clinical protocol approval",
    "population": "H&E skin-biopsy slides; population to be defined by the approved protocol",
    "classes": ["bcc_present", "bcc_absent_not_benign"],
    "other_states": ["indeterminate", "inadequate", "out_of_scope"],
    "display": {
        "bcc_present": "BCC present",
        "bcc_absent_not_benign": "BCC absent (may include other malignancy, inflammation or mimics). "
                                 "BCC absent is NOT the same as benign.",
        "indeterminate": "Indeterminate",
        "inadequate": "Inadequate for assessment",
        "out_of_scope": "Out of scope for this research task",
    },
    "label_scopes": ["case", "slide", "region"],
    "not_in_scope": ["autonomous diagnosis", "margin clearance", "melanoma exclusion", "IHC scoring",
                     "clinical report generation"],
    "research_use_only": True,
}

DEMO_FIXTURE_REF = "demo-fixture-suggestions (NOT a trained model)"


def _actors() -> dict[str, Actor]:
    return {uid.split("user-")[1]: Actor(uid, role, name) for uid, name, role in USERS}


def _corrupt_bytes() -> bytes:
    """A deterministic 'scan failure': a TIFF header followed by garbage (fictional)."""
    rng = random.Random(4242)
    return b"II*\x00\x08\x00\x00\x00" + bytes(rng.randrange(256) for _ in range(6000))


def _field_png() -> bytes:
    """A synthetic camera-style field image (PNG): procedural pattern, not histology."""
    s = SyntheticSlide(make_spec(909, width=4096, height=3072, downsamples=(1, 4)))
    img = s.read_region((0, 0), 1, (1024, 768)).convert("RGB")
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()


def _hier(db, pid, actor, patient_code, accession, collected, site, parts, provenance="demo_synthetic"):
    patient = db.scalars(select(CodedPatient).where(CodedPatient.project_id == pid,
                                                    CodedPatient.code == patient_code)).first()
    if patient is None:
        patient = CodedPatient(project_id=pid, code=patient_code, created_by=actor)
        db.add(patient)
        db.flush()
    case = Case(project_id=pid, coded_patient_id=patient.id, accession_code=accession, collected_on=collected,
                site_id=site, provenance=provenance, created_by=actor)
    db.add(case)
    db.flush()
    blocks = {}
    for designation, site_text, block_designations in parts:
        part = SpecimenPart(project_id=pid, case_id=case.id, designation=designation, anatomic_site_text=site_text)
        db.add(part)
        db.flush()
        for bd in block_designations:
            b = Block(project_id=pid, part_id=part.id, designation=bd)
            db.add(b)
            db.flush()
            blocks[bd] = b.id
    return case, blocks


def _synthetic_slide(db, pid, block_id, level, stain, scanner, seed, variant="standard", base_seed=None,
                     created_by="user-assistant") -> str:
    spec = make_spec(seed, variant=variant, base_seed=base_seed)
    sid = new_id()
    key = slide_key(pid, sid, "synthetic_spec.json")
    get_store().put_bytes(key, json.dumps(spec, sort_keys=True).encode())
    db.add(Slide(id=sid, project_id=pid, block_id=block_id, level_index=level, stain=stain, scanner_id=scanner,
                 provenance="demo_synthetic", image_kind="synthetic_tiles", object_key=key, sha256=spec_sha256(spec),
                 bytes=None, format="synthetic", synthetic_spec_json=spec, ingest_status="pending",
                 created_by=created_by))
    return sid


def _file_slide(db, pid, block_id, data_or_path, ext, *, kind, provenance, level=None, stain=None, scanner=None,
                original_filename=None) -> str:
    sid = new_id()
    key = slide_key(pid, sid, "original" + ext)
    store = get_store()
    if isinstance(data_or_path, bytes):
        store.put_bytes(key, data_or_path)
        digest = hashlib.sha256(data_or_path).hexdigest()
        size = len(data_or_path)
    else:
        store.put_file(key, data_or_path)
        digest = store.sha256(key)
        size = data_or_path.stat().st_size
    from .slides.identifier_risk import filename_flags

    db.add(Slide(id=sid, project_id=pid, block_id=block_id, level_index=level, stain=stain, scanner_id=scanner,
                 provenance=provenance, image_kind=kind, object_key=key, sha256=digest, bytes=size,
                 format=ext.lstrip("."), ingest_status="pending", original_filename=original_filename,
                 identifier_risk_json=filename_flags(original_filename) if original_filename else [],
                 created_by="user-assistant"))
    return sid


def seed(*, verbose: bool = False) -> dict:
    """Seed an EMPTY database. Returns a summary with the key ids."""
    settings = get_settings()
    ensure_var_dirs(settings)
    init_db()
    A = _actors()
    S: dict[str, str] = {}
    with session_scope() as db:
        if db.scalars(select(User)).first() is not None:
            raise RuntimeError("database is not empty; use --reset")
        for uid, name, role in USERS:
            db.add(User(id=uid, display_name=name, role=role, active=True, demo_user=True))
        db.add(Project(id=PROJECT_ID, name="BCC research template (demo)",
                       description=("Fictional demo project. Synthetic procedural images and one public CC0 test "
                                    "slide. No patient data. Research use only."),
                       task_template_json=TASK_TEMPLATE, settings_json={"independent_review": False},
                       demo_seeded=True))
        db.add(Project(id=RESTRICTED_PROJECT_ID, name="Restricted demo project (access test)",
                       description="Fictional second project used to demonstrate project-scoped access.",
                       task_template_json=TASK_TEMPLATE, settings_json={"independent_review": False},
                       demo_seeded=True))
        db.flush()
        for uid, _, _ in USERS:
            db.add(ProjectMember(project_id=PROJECT_ID, user_id=uid, added_by="system:seed",
                                 independent_review=True if uid == "user-pathologist-2" else None))
        for uid in ("user-admin", "user-research-lead", "user-pathologist-2"):
            db.add(ProjectMember(project_id=RESTRICTED_PROJECT_ID, user_id=uid, added_by="system:seed"))
        db.flush()

        pid = PROJECT_ID
        c1, b1 = _hier(db, pid, "user-assistant", "P-0001", "DEMO-S26-0001", date(2026, 1, 14), "site-north",
                       [("A", "left forearm (fictional)", ["A1"]), ("B", "right cheek (fictional)", ["B1"])])
        c2, b2 = _hier(db, pid, "user-assistant", "P-0002", "DEMO-S26-0002", date(2026, 2, 3), "site-north",
                       [("A", "nasal ala (fictional)", ["A1"])])
        c3, b3 = _hier(db, pid, "user-assistant", "P-0003", "DEMO-S26-0003", date(2026, 3, 22), "site-south",
                       [("A", "upper back (fictional)", ["A1"]), ("B", "scalp (fictional)", ["B1"])])
        c4, b4 = _hier(db, pid, "user-assistant", "P-0004", "DEMO-S26-0004", date(2026, 5, 9), "site-south",
                       [("A", "temple (fictional)", ["A1"])])
        c4b, b4b = _hier(db, pid, "user-assistant", "P-0004", "DEMO-S26-0007", date(2026, 8, 30), "site-north",
                         [("A", "temple, re-excision (fictional)", ["A1"])])
        c5, b5 = _hier(db, pid, "user-assistant", "P-0005", "DEMO-S26-0005", date(2026, 6, 17), "site-north",
                       [("A", "shoulder (fictional)", ["A1"]), ("B", "shoulder, second site (fictional)", ["B1"])])
        c6, b6 = _hier(db, pid, "user-assistant", "P-0006", "DEMO-S26-0006", None, None,
                       [("A", "eyelid (fictional)", ["A1"]), ("B", None, ["B1"])])
        c6.note = "Incomplete case (fictional): collection date and site not yet recorded; part B not scanned."
        cpub, bpub = _hier(db, pid, "user-assistant", "PUB-0001", "CC0-CMU-0001", None, None,
                           [("A", None, ["A1"])], provenance="public_cc0")
        cpub.note = ("Placeholder hierarchy for the public CC0 OpenSlide test slide (CMU-1-Small-Region.svs). "
                     "Unlabeled; no diagnosis may be inferred from its name or appearance.")
        S["case_incomplete"] = c6.id
        S["case_with_case_label"] = c3.id

        S["p1_a1_l1"] = _synthetic_slide(db, pid, b1["A1"], 1, "H&E", "scanner-a", 101)
        S["p1_a1_l2"] = _synthetic_slide(db, pid, b1["A1"], 2, "H&E", "scanner-a", 102)
        S["p1_b1_l1"] = _synthetic_slide(db, pid, b1["B1"], 1, "H&E", "scanner-a", 103)
        S["p2_a1_l1"] = _synthetic_slide(db, pid, b2["A1"], 1, "H&E", "scanner-a", 201)
        S["p2_a1_l2_pas"] = _synthetic_slide(db, pid, b2["A1"], 2, "PAS", "scanner-a", 202)
        S["p3_a1_l1_blur"] = _synthetic_slide(db, pid, b3["A1"], 1, "H&E", "scanner-b", 301, variant="blurred")
        S["p3_a1_l2"] = _synthetic_slide(db, pid, b3["A1"], 2, "H&E", "scanner-b", 302)
        S["p3_b1_l1_low"] = _synthetic_slide(db, pid, b3["B1"], 1, "H&E", "scanner-b", 303, variant="low_tissue")
        S["p4_a1_l1"] = _synthetic_slide(db, pid, b4["A1"], 1, "H&E", "scanner-b", 401)
        S["p4_a1_l2"] = _synthetic_slide(db, pid, b4["A1"], 2, "H&E", "scanner-b", 402)
        S["p4_c2_a1_l1"] = _synthetic_slide(db, pid, b4b["A1"], 1, "H&E", "scanner-a", 411)
        S["p5_a1_l1_neardup"] = _synthetic_slide(db, pid, b5["A1"], 1, "H&E", "scanner-a", 501,
                                                 variant="near_duplicate", base_seed=101)
        S["p5_a1_l2"] = _synthetic_slide(db, pid, b5["A1"], 2, "H&E", "scanner-a", 502)
        S["p5_b1_l1_failed"] = _file_slide(db, pid, b5["B1"], _corrupt_bytes(), ".svs", kind="wsi",
                                           provenance="demo_synthetic", level=1, stain="H&E", scanner="scanner-a")
        S["p6_a1_l1_blur"] = _synthetic_slide(db, pid, b6["A1"], 1, "H&E", "scanner-b", 601, variant="blurred")
        S["p6_a1_field"] = _file_slide(db, pid, b6["A1"], _field_png(), ".png", kind="field_image",
                                       provenance="demo_synthetic", stain="H&E (camera field)",
                                       original_filename="synthetic_field_photo.png")
        if CMU_FIXTURE.exists():
            S["cmu_cc0"] = _file_slide(db, pid, bpub["A1"], CMU_FIXTURE, ".svs", kind="wsi", provenance="public_cc0",
                                       level=1, stain="H&E", scanner=None,
                                       original_filename="CMU-1-Small-Region.svs")
        q, qb = _hier(db, RESTRICTED_PROJECT_ID, "user-admin", "Q-0001", "RSTR-S26-0001", date(2026, 4, 1),
                      "site-north", [("A", None, ["A1"])])
        S["restricted_slide"] = _synthetic_slide(db, RESTRICTED_PROJECT_ID, qb["A1"], 1, "H&E", "scanner-a", 9001,
                                                 created_by="user-admin")
        db.flush()
        screen = {S["p3_a1_l1_blur"], S["p3_b1_l1_low"], S["p6_a1_l1_blur"], S["p6_a1_field"], S.get("cmu_cc0")}
        for key, sid in S.items():
            if key.startswith("case_"):
                continue
            slide = db.get(Slide, sid)
            enqueue(db, "ingest", {"slide_id": sid, "auto_qc": sid in screen}, idempotency_key=f"ingest:{sid}",
                    project_id=slide.project_id, created_by=audit.SYSTEM_SEED)
        audit.record(db, action="demo.seed_started", entity_type="project", entity_id=PROJECT_ID,
                     actor_id=audit.SYSTEM_SEED, actor_role="system", project_id=PROJECT_ID,
                     after={"fictional": True})

    # Ingest (and the auto-queued QC screens) through the real worker code path.
    outcomes = Worker("seed-in-process", record_heartbeat=False).run_until_idle()
    if verbose:
        for o in outcomes:
            log.info("seed job %s %s -> %s %s", o.type, o.job_id, o.status, o.error or "")

    _seed_workflow(S, A)
    with session_scope() as db:
        audit.record(db, action="demo.seeded", entity_type="project", entity_id=PROJECT_ID,
                     actor_id=audit.SYSTEM_SEED, actor_role="system", project_id=PROJECT_ID,
                     after={"slides": len([k for k in S if not k.startswith("case_")]), "fictional": True})
    return {"project_id": PROJECT_ID, "restricted_project_id": RESTRICTED_PROJECT_ID,
            "users": [u[0] for u in USERS], "slides": {k: v for k, v in S.items() if not k.startswith("case_")},
            "cases": {k: v for k, v in S.items() if k.startswith("case_")},
            "jobs": [{"type": o.type, "status": o.status} for o in outcomes],
            "ml_demo": _seed_ml_demo()}


def _seed_ml_demo() -> dict:
    """ML pass hook: synthetic PIPELINE-TEST experiments (dermpath/ml/seed_demo.py). Never raises."""
    try:
        from .ml.seed_demo import seed_ml_demo
    except ModuleNotFoundError:
        return {"status": "not_present"}
    return seed_ml_demo()


def _seed_workflow(S: dict[str, str], A: dict[str, Actor]) -> None:
    from . import annotations as ann
    from .labels import adjudicate, create_expert_label, create_model_suggestion, open_disagreement, review_suggestion
    from .qc.service import create_manual_issue, transition_issue
    from .review import create_assessment, set_review_state

    asst, p1, p2 = A["assistant"], A["pathologist"], A["pathologist-2"]

    def route(db, sid):
        set_review_state(db, asst, db.get(Slide, sid), "pending_review", reason="routed for review (demo)")

    with session_scope() as db:
        for key in ("p1_a1_l1", "p1_a1_l2", "p1_b1_l1", "p2_a1_l1", "p2_a1_l2_pas", "p3_a1_l1_blur", "p3_a1_l2",
                    "p3_b1_l1_low", "p4_a1_l1", "p4_a1_l2", "p4_c2_a1_l1", "p5_a1_l1_neardup", "p5_a1_l2"):
            route(db, S[key])

    with session_scope() as db:
        g = lambda k: db.get(Slide, S[k])  # noqa: E731
        # Approved set with slide-level expert labels.
        create_expert_label(db, p1, g("p1_a1_l1"), scope="slide", target_id=None, value="bcc_present", reason=None)
        create_expert_label(db, p2, g("p1_a1_l1"), scope="slide", target_id=None, value="bcc_present", reason=None)
        create_expert_label(db, p1, g("p1_a1_l2"), scope="slide", target_id=None, value="bcc_present", reason=None)
        create_expert_label(db, p1, g("p1_b1_l1"), scope="slide", target_id=None, value="bcc_absent_not_benign",
                            reason=None)
        create_expert_label(db, p1, g("p2_a1_l1"), scope="slide", target_id=None, value="bcc_absent_not_benign",
                            reason=None)
        create_expert_label(db, p2, g("p2_a1_l1"), scope="slide", target_id=None, value="bcc_absent_not_benign",
                            reason=None)
        create_expert_label(db, p1, g("p4_a1_l1"), scope="slide", target_id=None, value="bcc_present", reason=None)
        create_expert_label(db, p2, g("p4_c2_a1_l1"), scope="slide", target_id=None, value="bcc_absent_not_benign",
                            reason=None)
        create_expert_label(db, p1, g("p5_a1_l1_neardup"), scope="slide", target_id=None, value="bcc_present",
                            reason=None)
        # Open disagreement → slide becomes disputed automatically.
        create_expert_label(db, p1, g("p3_a1_l2"), scope="slide", target_id=None, value="bcc_present", reason=None)
        create_expert_label(db, p2, g("p3_a1_l2"), scope="slide", target_id=None, value="bcc_absent_not_benign",
                            reason=None)
        # Disagreement that gets adjudicated.
        create_expert_label(db, p1, g("p4_a1_l2"), scope="slide", target_id=None, value="bcc_present", reason=None)
        create_expert_label(db, p2, g("p4_a1_l2"), scope="slide", target_id=None, value="bcc_absent_not_benign",
                            reason=None)
        d = open_disagreement(db, PROJECT_ID, "slide", S["p4_a1_l2"])
        adjudicate(db, p1, d, value="bcc_present",
                   reason="consensus review at a multi-head session (fictional demo record)")
        # Case-level label: valid for the case only, never copied down to its slides.
        create_expert_label(db, p1, g("p3_a1_l1_blur"), scope="case", target_id=None, value="bcc_present",
                            reason=None)

    with session_scope() as db:
        g = lambda k: db.get(Slide, S[k])  # noqa: E731
        for key in ("p1_a1_l1", "p1_a1_l2", "p1_b1_l1", "p2_a1_l1", "p4_a1_l1", "p4_a1_l2", "p4_c2_a1_l1",
                    "p5_a1_l1_neardup"):
            set_review_state(db, p1, g(key), "approved", reason=None)
        # Demo-fixture suggestions (NOT model outputs) and their reviews.
        s_acc = create_model_suggestion(db, project_id=PROJECT_ID, slide=g("p1_a1_l1"), scope="slide", target_id=None,
                                        value="bcc_present", score=0.88, model_ref=DEMO_FIXTURE_REF,
                                        origin="demo_fixture")
        review_suggestion(db, p1, s_acc, g("p1_a1_l1"), action="accept", value=None, reason=None)
        s_cor = create_model_suggestion(db, project_id=PROJECT_ID, slide=g("p5_a1_l2"), scope="slide", target_id=None,
                                        value="bcc_present", score=0.64, model_ref=DEMO_FIXTURE_REF,
                                        origin="demo_fixture")
        review_suggestion(db, p1, s_cor, g("p5_a1_l2"), action="correct", value="bcc_absent_not_benign",
                          reason="pattern judged not supportive on review (fictional demo record)")
        create_model_suggestion(db, project_id=PROJECT_ID, slide=g("p3_a1_l1_blur"), scope="slide", target_id=None,
                                value="bcc_present", score=0.71, model_ref=DEMO_FIXTURE_REF, origin="demo_fixture")
        create_model_suggestion(db, project_id=PROJECT_ID, slide=g("p2_a1_l2_pas"), scope="slide", target_id=None,
                                value="bcc_absent_not_benign", score=0.55, model_ref=DEMO_FIXTURE_REF,
                                origin="demo_fixture")
        # Independent assessment by the second pathologist (independent review is on for them).
        create_assessment(db, p2, db.get(Project, PROJECT_ID),
                          db.scalars(select(ProjectMember).where(ProjectMember.project_id == PROJECT_ID,
                                                                 ProjectMember.user_id == p2.id)).first(),
                          g("p3_a1_l1_blur"), value="indeterminate", confidence="low",
                          comment="focus too poor to commit (fictional demo record)", time_spent_seconds=95.0,
                          record_as_label=False)

    with session_scope() as db:
        g = lambda k: db.get(Slide, S[k])  # noqa: E731
        issues = {i.category + ":" + i.slide_id: i for i in db.scalars(select(QCIssue)).all()}
        # Low tissue: heuristic suggestion → confirmed → consider recut → resolved with exclusion.
        low = issues.get("low_tissue_heuristic:" + S["p3_b1_l1_low"])
        if low is not None:
            transition_issue(db, asst, low, action="review", reason="little tissue on the section", confirmed=True)
            transition_issue(db, asst, low, action="suggest_action", reason=None, suggested_action="consider_recut")
            transition_issue(db, asst, low, action="resolve",
                             reason="insufficient tissue for this research task (fictional)",
                             resolution="Lab lead decided not to recut for the research set; slide excluded",
                             dataset_eligibility_effect="exclude_slide")
        set_review_state(db, p1, g("p3_b1_l1_low"), "excluded",
                         reason="insufficient tissue on the section (QC issue resolved with exclusion)")
        # Blur on P-0006: the heuristic suggestion is overridden by a human with a reason.
        blur6 = issues.get("blur_heuristic:" + S["p6_a1_l1_blur"])
        if blur6 is not None:
            transition_issue(db, asst, blur6, action="override",
                             reason="checked at full resolution; focus acceptable (heuristic threshold uncalibrated)")
        # Fold with a region, at 'action suggested'.
        s4 = g("p4_a1_l1")
        fold = create_manual_issue(db, asst, s4, category="fold",
                                   region={"type": "Polygon", "coordinates": [[[2000.0, 1500.0], [5200.0, 1500.0],
                                                                               [5200.0, 2600.0], [2000.0, 2600.0],
                                                                               [2000.0, 1500.0]]],
                                           "geometry_type": "rectangle", "coordinate_space": "level0_pixels"},
                                   note="fold across the upper region", override_of=None, reason=None)
        transition_issue(db, p1, fold, action="review", reason=None, confirmed=True)
        transition_issue(db, p1, fold, action="suggest_action", reason=None, suggested_action="review_region")
        # Stain variation on the PAS slide: reviewed.
        stain = create_manual_issue(db, asst, g("p2_a1_l2_pas"), category="stain_variation", region=None,
                                    note="paler than the batch", override_of=None, reason=None)
        transition_issue(db, asst, stain, action="review", reason=None, confirmed=True)
        # Chatter on the incomplete case: open.
        create_manual_issue(db, asst, g("p6_a1_l1_blur"), category="chatter", region=None,
                            note="possible chatter lines; awaiting review", override_of=None, reason=None)

    with session_scope() as db:
        g = lambda k: db.get(Slide, S[k])  # noqa: E731
        s = g("p1_a1_l1")
        poly = ann.create(db, p1, s, geometry={"type": "polygon", "points": [[3200.5, 2100.25], [6900.0, 2050.0],
                                                                              [7400.75, 5200.5], [3600.0, 5600.0]]},
                          label="region_of_interest", comment="region reviewed for the BCC label (demo)",
                          transform_meta={"viewer": "demo-seed", "rotation_deg": 0})
        ann.revise(db, p1, s, poly, reason="tightened the boundary", label=None, comment=None,
                   geometry={"type": "polygon", "points": [[3300.5, 2150.25], [6800.0, 2100.0], [7300.75, 5100.5],
                                                           [3700.0, 5500.0]]},
                   transform_meta={"viewer": "demo-seed", "rotation_deg": 90})
        create_expert_label(db, p1, s, scope="region", target_id=poly.annotation_id, value="bcc_present", reason=None)
        ann.create(db, p1, g("p4_a1_l1"), geometry={"type": "rectangle", "x": 8000, "y": 4000, "width": 1800,
                                                   "height": 1200},
                   label="region_of_interest", comment=None, transform_meta=None)


def seed_if_empty() -> dict | None:
    with session_scope() as db:
        if db.scalars(select(User)).first() is not None:
            return None
    return seed()


def reset_and_seed(*, verbose: bool = False, actor: Actor | None = None) -> dict:
    settings = get_settings()
    from .slides.tiles import get_tile_service

    get_tile_service().clear()
    drop_all()
    for d in (settings.objects_dir, settings.uploads_dir):
        if d.exists() and settings.var_dir in d.resolve().parents:
            shutil.rmtree(d)
    ensure_var_dirs(settings)
    summary = seed(verbose=verbose)
    if actor is not None:
        with session_scope() as db:
            audit.record_for(db, actor, project_id=PROJECT_ID, action="demo.reset", entity_type="project",
                             entity_id=PROJECT_ID, after={"reseeded": True})
    return summary


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m dermpath.seed")
    parser.add_argument("--reset", action="store_true", help="drop all tables and objects first")
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    settings = get_settings()
    if settings.mode != "demo":
        log.error("seeding is only available in demo mode")
        return 2
    summary = reset_and_seed(verbose=True) if args.reset else seed(verbose=True)
    print(json.dumps({k: v for k, v in summary.items() if k != "jobs"}, indent=2))
    from collections import Counter

    print("jobs:", dict(Counter(f"{j['type']}:{j['status']}" for j in summary["jobs"])))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
