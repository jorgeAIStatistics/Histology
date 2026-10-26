"""Specimen hierarchy: coded patient → case → part → block → slide (level, stain).

Codes are validated so that free text such as a person's name cannot be stored as a
patient code: patient codes are upper-case alphanumeric segments joined by hyphens
(``P-0001``). Accession codes are STUDY codes (``DEMO-S26-0001``), not a laboratory's
real accession numbers; the format cannot prove that, so the API reminds the caller.
"""

from __future__ import annotations

import re
from datetime import date

from sqlalchemy import select
from sqlalchemy.orm import Session

from .errors import unprocessable
from .models import Block, Case, CodedPatient, Slide, SpecimenPart

PATIENT_CODE_RE = re.compile(r"^[A-Z0-9]{1,6}(-[A-Z0-9]{1,10}){1,2}$")
ACCESSION_RE = re.compile(r"^[A-Z0-9]{2,8}(-[A-Z0-9]{1,10}){1,3}$")
PART_RE = re.compile(r"^[A-Z]{1,2}$")
BLOCK_RE = re.compile(r"^[A-Z0-9]{1,6}$")
SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
_DATEY = re.compile(r"(19|20)\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])")

ACCESSION_NOTE = "accession_code must be a study code, never the laboratory's real accession number"


def check_patient_code(code: str) -> str:
    if not PATIENT_CODE_RE.match(code or "") or _DATEY.search(code.replace("-", "")):
        raise unprocessable(
            "invalid_patient_code",
            "Patient codes are coded identifiers such as P-0001 (upper-case letters/digits and hyphens). "
            "Never a name, MRN or birth date.",
        )
    return code


def check_accession(code: str) -> str:
    if not ACCESSION_RE.match(code or ""):
        raise unprocessable("invalid_accession_code",
                            f"Accession codes look like DEMO-S26-0001. {ACCESSION_NOTE}.")
    return code


def check_part(designation: str) -> str:
    if not PART_RE.match(designation or ""):
        raise unprocessable("invalid_part_designation", "Part designations are A, B, … (1–2 upper-case letters)")
    return designation


def check_block(designation: str) -> str:
    if not BLOCK_RE.match(designation or ""):
        raise unprocessable("invalid_block_designation", "Block designations are 1–6 upper-case letters or digits")
    return designation


def check_slug(value: str | None, field: str) -> str | None:
    if value is None:
        return None
    if not SLUG_RE.match(value):
        raise unprocessable(f"invalid_{field}", f"{field} must be a lower-case code such as site-north")
    return value


def find_or_create_hierarchy(db: Session, project_id: str, actor_id: str, *, patient_code: str,
                             accession_code: str, part_designation: str, block_designation: str,
                             collected_on: date | None = None, site_id: str | None = None,
                             anatomic_site_text: str | None = None, provenance: str = "public_cc0") -> Block:
    check_patient_code(patient_code)
    check_accession(accession_code)
    check_part(part_designation)
    check_block(block_designation)
    check_slug(site_id, "site_id")
    patient = db.scalars(select(CodedPatient).where(CodedPatient.project_id == project_id,
                                                    CodedPatient.code == patient_code)).first()
    if patient is None:
        patient = CodedPatient(project_id=project_id, code=patient_code, created_by=actor_id)
        db.add(patient)
        db.flush()
    case = db.scalars(select(Case).where(Case.project_id == project_id,
                                         Case.accession_code == accession_code)).first()
    if case is None:
        case = Case(project_id=project_id, coded_patient_id=patient.id, accession_code=accession_code,
                    collected_on=collected_on, site_id=site_id, provenance=provenance, created_by=actor_id)
        db.add(case)
        db.flush()
    elif case.coded_patient_id != patient.id:
        raise unprocessable("hierarchy_conflict",
                            "That accession code already belongs to a different coded patient")
    part = db.scalars(select(SpecimenPart).where(SpecimenPart.case_id == case.id,
                                                 SpecimenPart.designation == part_designation)).first()
    if part is None:
        part = SpecimenPart(project_id=project_id, case_id=case.id, designation=part_designation,
                            anatomic_site_text=anatomic_site_text)
        db.add(part)
        db.flush()
    block = db.scalars(select(Block).where(Block.part_id == part.id,
                                           Block.designation == block_designation)).first()
    if block is None:
        block = Block(project_id=project_id, part_id=part.id, designation=block_designation)
        db.add(block)
        db.flush()
    return block


def slide_lineage(db: Session, slide: Slide) -> dict:
    """Codes and ids above a slide (all None for an unassigned slide)."""
    out = {"block_id": None, "block": None, "part_id": None, "part": None, "case_id": None,
           "accession_code": None, "coded_patient_id": None, "patient_code": None,
           "collected_on": None, "site_id": None}
    if slide.block_id is None:
        return out
    block = db.get(Block, slide.block_id)
    part = db.get(SpecimenPart, block.part_id)
    case = db.get(Case, part.case_id)
    patient = db.get(CodedPatient, case.coded_patient_id)
    out.update({
        "block_id": block.id, "block": block.designation, "part_id": part.id, "part": part.designation,
        "anatomic_site_text": part.anatomic_site_text,
        "case_id": case.id, "accession_code": case.accession_code, "coded_patient_id": patient.id,
        "patient_code": patient.code, "collected_on": case.collected_on.isoformat() if case.collected_on else None,
        "site_id": case.site_id, "case_provenance": case.provenance,
    })
    return out


def patient_dict(p: CodedPatient) -> dict:
    return {"id": p.id, "project_id": p.project_id, "code": p.code, "created_at": p.created_at.isoformat()}


def case_dict(c: Case, patient: CodedPatient | None = None) -> dict:
    return {
        "id": c.id, "project_id": c.project_id, "coded_patient_id": c.coded_patient_id,
        "patient_code": patient.code if patient else None, "accession_code": c.accession_code,
        "collected_on": c.collected_on.isoformat() if c.collected_on else None, "site_id": c.site_id,
        "provenance": c.provenance, "note": c.note, "created_at": c.created_at.isoformat(),
    }


def part_dict(p: SpecimenPart) -> dict:
    return {"id": p.id, "case_id": p.case_id, "designation": p.designation,
            "anatomic_site_text": p.anatomic_site_text}


def block_dict(b: Block) -> dict:
    return {"id": b.id, "part_id": b.part_id, "designation": b.designation}
