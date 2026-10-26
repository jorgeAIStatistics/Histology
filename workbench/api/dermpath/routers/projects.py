"""Projects, membership, worklist, specimen hierarchy, workflow statistics and audit."""

from __future__ import annotations

from collections import Counter

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .. import audit
from ..auth import Actor, Scope, current_actor, entity_scope, project_scope
from ..db import get_db
from ..errors import conflict, not_found, unprocessable
from ..hierarchy import (
    ACCESSION_NOTE,
    block_dict,
    case_dict,
    check_accession,
    check_block,
    check_part,
    check_patient_code,
    check_slug,
    part_dict,
    patient_dict,
)
from ..labels import current_expert_opinions, reference_label
from ..models import (
    AuditEvent,
    Block,
    Case,
    CodedPatient,
    LabelVersion,
    Project,
    ProjectMember,
    QCIssue,
    Slide,
    SpecimenPart,
    User,
)
from ..review import independent_review_on, suggestions_hidden_for
from ..schemas import (
    BlockIn,
    CaseIn,
    CasePatchIn,
    MemberAddIn,
    MemberSettingsIn,
    PartIn,
    PartPatchIn,
    PatientIn,
    ProjectSettingsIn,
)
from ..vocab import PROVENANCE_DISPLAY, REVIEW_STATES
from .common import slide_dict

router = APIRouter(tags=["projects"])


def project_dict(p: Project) -> dict:
    return {"id": p.id, "name": p.name, "description": p.description, "task_template": p.task_template_json,
            "settings": p.settings_json, "demo_seeded": p.demo_seeded, "created_at": p.created_at.isoformat()}


@router.get("/projects")
def list_projects(actor: Actor = Depends(current_actor), db: Session = Depends(get_db)):
    """Projects the caller is a member of (no others are listed)."""
    rows = db.execute(select(Project).join(ProjectMember, ProjectMember.project_id == Project.id)
                      .where(ProjectMember.user_id == actor.id).order_by(Project.name)).scalars().all()
    return {"items": [project_dict(p) for p in rows]}


@router.get("/projects/{pid}")
def get_project(scope: Scope = Depends(project_scope("project.view")), db: Session = Depends(get_db)):
    p = scope.obj
    d = project_dict(p)
    d["my_role"] = scope.actor.role
    d["independent_review_effective"] = independent_review_on(p, scope.member)
    return d


@router.patch("/projects/{pid}/settings")
def patch_settings(body: ProjectSettingsIn, scope: Scope = Depends(project_scope("project.settings")),
                   db: Session = Depends(get_db)):
    p = scope.obj
    before = dict(p.settings_json or {})
    p.settings_json = {**before, "independent_review": body.independent_review}
    audit.record_for(db, scope.actor, project_id=p.id, action="project.settings_changed", entity_type="project",
                     entity_id=p.id, before=before, after=p.settings_json)
    db.commit()
    return project_dict(p)


@router.get("/projects/{pid}/members")
def list_members(scope: Scope = Depends(project_scope("members.read")), db: Session = Depends(get_db)):
    rows = db.execute(select(ProjectMember, User).join(User, User.id == ProjectMember.user_id)
                      .where(ProjectMember.project_id == scope.project_id).order_by(User.role, User.id)).all()
    return {"items": [{"user_id": u.id, "display_name": u.display_name, "role": u.role,
                       "independent_review": m.independent_review, "added_at": m.added_at.isoformat()}
                      for m, u in rows]}


@router.post("/projects/{pid}/members", status_code=201)
def add_member(body: MemberAddIn, scope: Scope = Depends(project_scope("members.manage")),
               db: Session = Depends(get_db)):
    user = db.get(User, body.user_id)
    if user is None:
        raise not_found("user", body.user_id)
    exists = db.scalars(select(ProjectMember).where(ProjectMember.project_id == scope.project_id,
                                                    ProjectMember.user_id == user.id)).first()
    if exists:
        raise conflict("already_member", "User is already a member")
    db.add(ProjectMember(project_id=scope.project_id, user_id=user.id, added_by=scope.actor.id))
    audit.record_for(db, scope.actor, project_id=scope.project_id, action="project.member_added",
                     entity_type="project_member", entity_id=user.id, after={"user_id": user.id, "role": user.role})
    db.commit()
    return {"ok": True, "user_id": user.id}


@router.delete("/projects/{pid}/members/{user_id}")
def remove_member(user_id: str, scope: Scope = Depends(project_scope("members.manage")),
                  db: Session = Depends(get_db)):
    m = db.scalars(select(ProjectMember).where(ProjectMember.project_id == scope.project_id,
                                               ProjectMember.user_id == user_id)).first()
    if m is None:
        raise not_found("member", user_id)
    if user_id == scope.actor.id:
        raise conflict("cannot_remove_self", "Admins cannot remove their own membership")
    db.delete(m)
    audit.record_for(db, scope.actor, project_id=scope.project_id, action="project.member_removed",
                     entity_type="project_member", entity_id=user_id)
    db.commit()
    return {"ok": True}


@router.patch("/projects/{pid}/members/me")
def patch_my_settings(body: MemberSettingsIn, scope: Scope = Depends(project_scope("project.view")),
                      db: Session = Depends(get_db)):
    """A reviewer's own independent-review override (null = inherit the project setting)."""
    m = scope.member
    before = m.independent_review
    m.independent_review = body.independent_review
    audit.record_for(db, scope.actor, project_id=scope.project_id, action="project.member_settings_changed",
                     entity_type="project_member", entity_id=scope.actor.id,
                     before={"independent_review": before}, after={"independent_review": body.independent_review})
    db.commit()
    return {"user_id": scope.actor.id, "independent_review": m.independent_review,
            "independent_review_effective": independent_review_on(scope.obj, m)}


# --------------------------------------------------------------------------- worklist & stats


@router.get("/projects/{pid}/worklist")
def worklist(review_state: str | None = Query(None), ingest_status: str | None = Query(None),
             image_kind: str | None = Query(None),
             scope: Scope = Depends(project_scope("hierarchy.read")), db: Session = Depends(get_db)):
    """Slides in accession order (no automatic reprioritisation)."""
    q = select(Slide).where(Slide.project_id == scope.project_id)
    if review_state:
        q = q.where(Slide.review_state == review_state)
    if ingest_status:
        q = q.where(Slide.ingest_status == ingest_status)
    if image_kind:
        q = q.where(Slide.image_kind == image_kind)
    slides = db.scalars(q).all()
    items = []
    for s in slides:
        d = slide_dict(db, s, include_qc=False)
        lin = d["lineage"]
        opinions = current_expert_opinions(db, s.project_id, "slide", s.id)
        _, ref_status = reference_label(db, s.project_id, "slide", s.id)
        hidden = suggestions_hidden_for(db, scope.actor, scope.obj, scope.member, s.id)
        n_sugg = db.scalar(select(func.count(LabelVersion.id)).where(
            LabelVersion.slide_id == s.id, LabelVersion.source == "model_suggestion"))
        open_qc = db.scalar(select(func.count(QCIssue.id)).where(QCIssue.slide_id == s.id,
                                                                 QCIssue.status != "resolved"))
        items.append({
            "slide_id": s.id, "patient_code": lin["patient_code"], "accession_code": lin["accession_code"],
            "part": lin["part"], "block": lin["block"], "level_index": s.level_index, "stain": s.stain,
            "scanner_id": s.scanner_id, "site_id": lin["site_id"], "image_kind": s.image_kind,
            "provenance": s.provenance, "provenance_display": PROVENANCE_DISPLAY.get(s.provenance),
            "review_state": s.review_state, "ingest_status": s.ingest_status, "ingest_error": s.ingest_error,
            "open_qc_issues": open_qc, "expert_readers": len(opinions),
            "my_label": opinions[scope.actor.id].value if scope.actor.id in opinions else None,
            "slide_label_status": ref_status,
            "model_suggestions": None if hidden else n_sugg, "suggestions_hidden": hidden,
            "identifier_risk_flags": len(s.identifier_risk_json or []), "has_thumbnail": bool(s.thumbnail_key),
            "unassigned": s.block_id is None,
        })
    items.sort(key=lambda r: (r["accession_code"] or "~", r["part"] or "", r["block"] or "",
                              r["level_index"] if r["level_index"] is not None else 999, r["slide_id"]))
    counts = Counter(s.review_state for s in db.scalars(select(Slide).where(Slide.project_id == scope.project_id)))
    return {"items": items, "sort": "accession order (no automatic reprioritisation)",
            "counts_by_review_state": {k: counts.get(k, 0) for k in REVIEW_STATES}}


@router.get("/projects/{pid}/workflow-stats")
def workflow_stats(scope: Scope = Depends(project_scope("workflow_stats.read")), db: Session = Depends(get_db)):
    """Workflow metadata counts. Kept separate from experiment results by design."""
    pid = scope.project_id
    slides = db.scalars(select(Slide).where(Slide.project_id == pid)).all()
    issues = db.scalars(select(QCIssue).where(QCIssue.project_id == pid)).all()
    return {
        "kind": "workflow_metadata",
        "seeded_fictional": bool(scope.obj.demo_seeded),
        "note": "Seeded fictional workflow metadata; NOT experiment or performance results.",
        "patients": db.scalar(select(func.count(CodedPatient.id)).where(CodedPatient.project_id == pid)),
        "cases": db.scalar(select(func.count(Case.id)).where(Case.project_id == pid)),
        "slides": len(slides),
        "slides_by_review_state": dict(Counter(s.review_state for s in slides)),
        "slides_by_ingest_status": dict(Counter(s.ingest_status for s in slides)),
        "slides_by_image_kind": dict(Counter(s.image_kind for s in slides)),
        "slides_by_provenance": dict(Counter(s.provenance for s in slides)),
        "qc_issues_by_status": dict(Counter(i.status for i in issues)),
        "qc_issues_by_category": dict(Counter(i.category for i in issues)),
    }


@router.get("/projects/{pid}/audit")
def project_audit(limit: int = Query(100, ge=1, le=1000), offset: int = Query(0, ge=0),
                  entity_type: str | None = None, entity_id: str | None = None,
                  scope: Scope = Depends(project_scope("audit.read")), db: Session = Depends(get_db)):
    q = select(AuditEvent).where(AuditEvent.project_id == scope.project_id)
    if entity_type:
        q = q.where(AuditEvent.entity_type == entity_type)
    if entity_id:
        q = q.where(AuditEvent.entity_id == entity_id)
    total = db.scalar(select(func.count()).select_from(q.subquery()))
    rows = db.scalars(q.order_by(AuditEvent.id.desc()).limit(limit).offset(offset)).all()
    return {"total": total, "items": [{
        "id": e.id, "at": e.at.isoformat(), "actor_id": e.actor_id, "actor_role": e.actor_role,
        "action": e.action, "entity_type": e.entity_type, "entity_id": e.entity_id, "before": e.before_json,
        "after": e.after_json, "reason": e.reason, "correlation_id": e.correlation_id} for e in rows],
        "note": "Append-only. No pixels, credentials or file contents are recorded."}


# --------------------------------------------------------------------------- hierarchy


@router.get("/projects/{pid}/patients")
def list_patients(scope: Scope = Depends(project_scope("hierarchy.read")), db: Session = Depends(get_db)):
    rows = db.scalars(select(CodedPatient).where(CodedPatient.project_id == scope.project_id)
                      .order_by(CodedPatient.code)).all()
    return {"items": [patient_dict(p) for p in rows]}


@router.post("/projects/{pid}/patients", status_code=201)
def create_patient(body: PatientIn, scope: Scope = Depends(project_scope("hierarchy.write")),
                   db: Session = Depends(get_db)):
    check_patient_code(body.code)
    if db.scalars(select(CodedPatient).where(CodedPatient.project_id == scope.project_id,
                                             CodedPatient.code == body.code)).first():
        raise conflict("duplicate_code", "A coded patient with this code exists")
    p = CodedPatient(project_id=scope.project_id, code=body.code, created_by=scope.actor.id)
    db.add(p)
    db.flush()
    audit.record_for(db, scope.actor, project_id=scope.project_id, action="patient.created",
                     entity_type="coded_patient", entity_id=p.id, after={"code": p.code})
    db.commit()
    return patient_dict(p)


@router.patch("/patients/{id}")
def patch_patient(body: PatientIn, scope: Scope = Depends(entity_scope("hierarchy.write", CodedPatient)),
                  db: Session = Depends(get_db)):
    p = scope.obj
    check_patient_code(body.code)
    clash = db.scalars(select(CodedPatient).where(CodedPatient.project_id == p.project_id,
                                                  CodedPatient.code == body.code, CodedPatient.id != p.id)).first()
    if clash:
        raise conflict("duplicate_code", "A coded patient with this code exists")
    before = p.code
    p.code = body.code
    audit.record_for(db, scope.actor, project_id=p.project_id, action="patient.updated", entity_type="coded_patient",
                     entity_id=p.id, before={"code": before}, after={"code": p.code})
    db.commit()
    return patient_dict(p)


@router.get("/projects/{pid}/cases")
def list_cases(scope: Scope = Depends(project_scope("hierarchy.read")), db: Session = Depends(get_db)):
    rows = db.execute(select(Case, CodedPatient).join(CodedPatient, CodedPatient.id == Case.coded_patient_id)
                      .where(Case.project_id == scope.project_id).order_by(Case.accession_code)).all()
    items = []
    for c, p in rows:
        d = case_dict(c, p)
        parts = db.scalars(select(SpecimenPart).where(SpecimenPart.case_id == c.id)).all()
        n_slides = db.scalar(select(func.count(Slide.id)).join(Block, Block.id == Slide.block_id)
                             .join(SpecimenPart, SpecimenPart.id == Block.part_id).where(SpecimenPart.case_id == c.id))
        d.update({"parts": [x.designation for x in parts], "slide_count": n_slides,
                  "incomplete": n_slides == 0 or c.collected_on is None or c.site_id is None})
        items.append(d)
    return {"items": items}


@router.post("/projects/{pid}/cases", status_code=201)
def create_case(body: CaseIn, scope: Scope = Depends(project_scope("hierarchy.write")),
                db: Session = Depends(get_db)):
    check_accession(body.accession_code)
    check_slug(body.site_id, "site_id")
    patient = db.get(CodedPatient, body.coded_patient_id)
    if patient is None or patient.project_id != scope.project_id:
        raise unprocessable("invalid_patient", "coded_patient_id is not a patient of this project")
    if db.scalars(select(Case).where(Case.project_id == scope.project_id,
                                     Case.accession_code == body.accession_code)).first():
        raise conflict("duplicate_accession", "A case with this accession code exists")
    c = Case(project_id=scope.project_id, coded_patient_id=patient.id, accession_code=body.accession_code,
             collected_on=body.collected_on, site_id=body.site_id, provenance=body.provenance, note=body.note,
             created_by=scope.actor.id)
    db.add(c)
    db.flush()
    audit.record_for(db, scope.actor, project_id=scope.project_id, action="case.created", entity_type="case",
                     entity_id=c.id, after=case_dict(c, patient))
    db.commit()
    return {**case_dict(c, patient), "identifier_note": ACCESSION_NOTE}


@router.get("/cases/{id}")
def get_case(scope: Scope = Depends(entity_scope("hierarchy.read", Case)), db: Session = Depends(get_db)):
    """A case with parts → blocks → slides."""
    c = scope.obj
    patient = db.get(CodedPatient, c.coded_patient_id)
    out = case_dict(c, patient)
    parts_out = []
    for part in db.scalars(select(SpecimenPart).where(SpecimenPart.case_id == c.id)
                           .order_by(SpecimenPart.designation)).all():
        blocks_out = []
        for b in db.scalars(select(Block).where(Block.part_id == part.id).order_by(Block.designation)).all():
            slides = db.scalars(select(Slide).where(Slide.block_id == b.id)
                                .order_by(Slide.level_index, Slide.id)).all()
            blocks_out.append({**block_dict(b), "slides": [slide_dict(db, s, include_qc=True) for s in slides]})
        parts_out.append({**part_dict(part), "blocks": blocks_out})
    out["parts"] = parts_out
    case_labels = db.scalars(select(LabelVersion).where(LabelVersion.scope == "case", LabelVersion.case_id == c.id,
                                                        LabelVersion.source == "expert")).all()
    ref, status = reference_label(db, c.project_id, "case", c.id)
    out["case_label"] = {"status": status, "value": ref.value if ref else None,
                         "label_version_id": ref.id if ref else None, "expert_label_versions": len(case_labels),
                         "note": "valid at case scope only; never copied down to slides"}
    return out


@router.patch("/cases/{id}")
def patch_case(body: CasePatchIn, scope: Scope = Depends(entity_scope("hierarchy.write", Case)),
               db: Session = Depends(get_db)):
    c = scope.obj
    before = case_dict(c)
    fields = body.model_dump(exclude_unset=True)
    if "site_id" in fields:
        check_slug(fields["site_id"], "site_id")
        c.site_id = fields["site_id"]
    if "collected_on" in fields:
        c.collected_on = fields["collected_on"]
    if "note" in fields:
        c.note = fields["note"]
    audit.record_for(db, scope.actor, project_id=c.project_id, action="case.updated", entity_type="case",
                     entity_id=c.id, before=before, after=case_dict(c), reason=body.reason)
    db.commit()
    return case_dict(c, db.get(CodedPatient, c.coded_patient_id))


@router.post("/cases/{id}/parts", status_code=201)
def create_part(body: PartIn, scope: Scope = Depends(entity_scope("hierarchy.write", Case)),
                db: Session = Depends(get_db)):
    check_part(body.designation)
    c = scope.obj
    if db.scalars(select(SpecimenPart).where(SpecimenPart.case_id == c.id,
                                             SpecimenPart.designation == body.designation)).first():
        raise conflict("duplicate_part", "This case already has that part")
    p = SpecimenPart(project_id=c.project_id, case_id=c.id, designation=body.designation,
                     anatomic_site_text=body.anatomic_site_text)
    db.add(p)
    db.flush()
    audit.record_for(db, scope.actor, project_id=c.project_id, action="part.created", entity_type="specimen_part",
                     entity_id=p.id, after=part_dict(p))
    db.commit()
    return part_dict(p)


@router.patch("/parts/{id}")
def patch_part(body: PartPatchIn, scope: Scope = Depends(entity_scope("hierarchy.write", SpecimenPart)),
               db: Session = Depends(get_db)):
    p = scope.obj
    before = part_dict(p)
    p.anatomic_site_text = body.anatomic_site_text
    audit.record_for(db, scope.actor, project_id=p.project_id, action="part.updated", entity_type="specimen_part",
                     entity_id=p.id, before=before, after=part_dict(p), reason=body.reason)
    db.commit()
    return part_dict(p)


@router.post("/parts/{id}/blocks", status_code=201)
def create_block(body: BlockIn, scope: Scope = Depends(entity_scope("hierarchy.write", SpecimenPart)),
                 db: Session = Depends(get_db)):
    check_block(body.designation)
    part = scope.obj
    if db.scalars(select(Block).where(Block.part_id == part.id, Block.designation == body.designation)).first():
        raise conflict("duplicate_block", "This part already has that block")
    b = Block(project_id=part.project_id, part_id=part.id, designation=body.designation)
    db.add(b)
    db.flush()
    audit.record_for(db, scope.actor, project_id=part.project_id, action="block.created", entity_type="block",
                     entity_id=b.id, after=block_dict(b))
    db.commit()
    return block_dict(b)


@router.patch("/blocks/{id}")
def patch_block(body: BlockIn, scope: Scope = Depends(entity_scope("hierarchy.write", Block)),
                db: Session = Depends(get_db)):
    b = scope.obj
    check_block(body.designation)
    before = block_dict(b)
    b.designation = body.designation
    audit.record_for(db, scope.actor, project_id=b.project_id, action="block.updated", entity_type="block",
                     entity_id=b.id, before=before, after=block_dict(b))
    db.commit()
    return block_dict(b)
