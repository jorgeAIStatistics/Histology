"""Import an approved subset of the COBRA BCC biopsy package as a public, honestly labelled research dataset.

Research use only. COBRA (Radboud University Medical Center, AWS Open Data registry) is licensed CC BY-NC-SA 4.0:
attribution, NON-COMMERCIAL use only, share-alike. Its slide labels were extracted from free-text pathology reports
by a rule-based method; in this workbench they are ``imported_reference`` labels, never expert reads, and they
become a dataset's reference only when the dataset declares ``reference_standard == "imported_reference"``.

Usage (from ``workbench/api``, with ``WB_VAR_DIR`` pointing at the API's var directory, after
``python -m dermpath.seed`` has created the demo users)::

    .venv/bin/python -m dermpath.importers.cobra \\
        --selection ../var/datasets/cobra/subset/selection.csv \\
        --images ../var/datasets/cobra/images \\
        --sha256 ../var/datasets/cobra/subset/sha256.txt \\
        --metadata ../var/datasets/cobra/metadata \\
        --license-file ../var/datasets/cobra/LICENSE \\
        --project proj-cobra-bcc-subset

then run the worker until the ``ingest`` and ``qc_screen`` jobs are finished
(``.venv/bin/python -m dermpath.worker --once``, or keep ``python -m dermpath.worker`` running), and run the same
command again: a re-run changes nothing and reports each slide's ingest status and whether the ingested
dimensions and pixel size match the dataset's metadata. ``--process-jobs`` runs those jobs in-process instead.

What it creates (idempotent; re-runs add only what is missing and never change existing rows):

* project ``proj-cobra-bcc-subset`` (not demo-seeded, not fictional) with the research lead, a pathologist and the
  medical director as members; ``settings_json.public_dataset`` holds the licence, source, label provenance and
  limitations, and travels into every frozen manifest that includes these slides;
* coded patient ``COBRA-<patient_id>`` (COBRA's published pseudonymous id; sex and age are not imported); one case
  per (patient, specimen number) with accession ``COBRA-<patient_id>-S<specimennumber>``, provenance
  ``public_licensed``, site ``radboudumc`` (single centre, from the dataset documentation) and a case note with the
  licence; part ``A``; the block from the metadata; slide level 1 (COBRA publishes no section level), stain
  ``H&E`` (COBRA's staining name is kept in the import record), scanner from the metadata;
* each file copied into the private object store only if its SHA-256 equals the published checksum list, then the
  normal ``ingest`` job (OpenSlide metadata, thumbnail, ingest manifest) and the automated QC screen;
* one slide-scope ``imported_reference`` label per slide: COBRA label 1 -> ``bcc_present``, 0 -> the task's
  BCC-absent value (``bcc_absent_not_benign``; never rendered as benign), with COBRA's category text in the
  label's provenance;
* a write-once ``import_record.json`` per slide and audit events (``dataset.import_run``, ``slide.imported``).

Files whose checksum differs, rows that disagree with the original metadata (``--metadata``) and rows that would
contradict existing records are refused and listed; nothing is written for them.
"""

from __future__ import annotations

import argparse
import csv
import json
import logging
import re
import sys
from collections import Counter
from dataclasses import asdict, dataclass
from pathlib import Path

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .. import audit
from ..config import get_settings
from ..db import init_db, session_scope, utcnow
from ..errors import ApiError
from ..hierarchy import find_or_create_hierarchy, slide_lineage
from ..labels import SYSTEM_IMPORT, create_imported_reference_label
from ..models import Block, Case, Job, Project, ProjectMember, Slide, SpecimenPart, User, new_id
from ..storage import StoreError, get_store, slide_key
from ..vocab import LABEL_VALUES
from . import ImportRefused, RowRefused, file_sha256, register_slide, safe_member, store_server_file

log = logging.getLogger("dermpath.importers.cobra")

IMPORTER_VERSION = "dermpath.importers.cobra/1"
IMPORT_RECORD_SCHEMA = "dermpath.import_record/1"
PROJECT_ID = "proj-cobra-bcc-subset"
PROJECT_NAME = "COBRA BCC biopsy subset (public, CC BY-NC-SA 4.0, report-derived labels)"
PROVENANCE = "public_licensed"
SITE_ID = "radboudumc"
PART = "A"
LEVEL_INDEX = 1
STAIN = "H&E"
EXT = ".tif"
#: Demo members, ids as in dermpath.seed.USERS.
MEMBERS = ("user-research-lead", "user-pathologist", "user-director")
POSITIVE_VALUE = "bcc_present"
DEFAULT_NEGATIVE_VALUE = "bcc_absent_not_benign"
BCC_CATEGORY = "basal cell carcinoma"
LICENCE = "CC BY-NC-SA 4.0"
LICENCE_URL = "https://creativecommons.org/licenses/by-nc-sa/4.0/"
LABEL_METHOD = ("COBRA rule-based extraction from free-text pathology reports (Geijs et al., Med Image Anal 2024); "
                "not an expert read in this workbench")
REQUIRED_COLUMNS = ("filename", "patient_id", "label", "category", "specimennumber", "block", "scanner")
OPTIONAL_COLUMNS = ("group", "stainingname", "size_mb", "width", "height", "levels", "spacing0_um")
_PID_RE = re.compile(r"^[A-Z0-9]{1,10}$")
_BLOCK_RE = re.compile(r"^[A-Z0-9]{1,6}$")
_SHA_LINE_RE = re.compile(r"^([0-9a-fA-F]{64}) [ *]?(\S.*)$")
_MPP_REL_TOL = 1e-3

LIMITATIONS = (
    "Labels are report-derived (rule-based extraction from pathology reports), not expert reads in this workbench; "
    "a report-level diagnosis may have been copied to a slide that does not itself show the lesion.",
    "Single centre (Radboudumc) and a single scanner model (3DHistech Pannoramic 1000): no site or scanner shift "
    "can be measured.",
    "Enriched prevalence (about half BCC by construction): PPV and NPV do not transfer to a clinical population.",
    "Non-commercial licence (CC BY-NC-SA 4.0); whether trained weights are ShareAlike adaptations is unsettled; "
    "get legal review before any commercial use.",
    "Results on this subset are not a validation of clinical performance.",
)


@dataclass(frozen=True)
class CobraRow:
    line: int
    filename: str  # stem, without .tif
    patient_id: str
    label: str  # "0" | "1" as published
    category: str
    specimennumber: int
    block: str
    scanner: str
    group: str | None = None
    stainingname: str | None = None
    size_mb: float | None = None
    width: int | None = None
    height: int | None = None
    levels: int | None = None
    spacing0_um: float | None = None

    @property
    def patient_code(self) -> str:
        return f"COBRA-{self.patient_id}"

    @property
    def accession_code(self) -> str:
        return f"COBRA-{self.patient_id}-S{self.specimennumber}"

    @property
    def source_filename(self) -> str:
        return self.filename + EXT


# --------------------------------------------------------------------------- reading the listings


def _stem(name: str) -> str:
    name = (name or "").strip()
    return name[: -len(EXT)] if name.lower().endswith(EXT) else name


def _text(value: str | None, limit: int = 120) -> str:
    out = "".join(ch for ch in (value or "") if ch.isprintable()).strip()
    return out[:limit]


def _opt_num(raw: str | None, kind):
    raw = (raw or "").strip()
    if not raw:
        return None
    try:
        return kind(float(raw)) if kind is int else kind(raw)
    except ValueError:
        return None


def scanner_slug(name: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", (name or "").lower()).strip("-")[:64]
    return slug or "unknown-scanner"


def read_selection(path: Path) -> tuple[list[CobraRow], list[dict]]:
    """Parse the subset listing. Returns ``(rows, refused)``; malformed rows are refused, never guessed."""
    rows, refused = [], []
    with open(path, newline="", encoding="utf-8") as fh:
        reader = csv.DictReader(fh)
        missing = [c for c in REQUIRED_COLUMNS if c not in (reader.fieldnames or [])]
        if missing:
            raise ImportRefused(f"{path}: missing columns {missing}")
        for i, raw in enumerate(reader, start=2):
            stem = _stem(raw.get("filename", ""))
            try:
                pid = (raw.get("patient_id") or "").strip().upper()
                if not _PID_RE.match(pid):
                    raise RowRefused("invalid_patient_id", "patient_id must be 1-10 letters or digits")
                label = (raw.get("label") or "").strip()
                if label not in ("0", "1"):
                    raise RowRefused("invalid_label", "label must be 0 or 1", label=label)
                category = _text(raw.get("category"))
                if not category:
                    raise RowRefused("invalid_category", "category text is required")
                if (label == "1") != (category.lower() == BCC_CATEGORY):
                    raise RowRefused("label_category_inconsistent",
                                     "label 1 must have category 'Basal cell carcinoma' and label 0 another category",
                                     label=label, category=category)
                spec = (raw.get("specimennumber") or "").strip()
                if not spec.isdigit() or len(spec) > 9:
                    raise RowRefused("invalid_specimennumber", "specimennumber must be a non-negative integer")
                block = (raw.get("block") or "").strip().upper()
                if not _BLOCK_RE.match(block):
                    raise RowRefused("invalid_block", "block must be 1-6 letters or digits")
                scanner = _text(raw.get("scanner"))
                if not scanner:
                    raise RowRefused("invalid_scanner", "scanner is required")
                rows.append(CobraRow(
                    line=i, filename=stem, patient_id=pid, label=label, category=category,
                    specimennumber=int(spec), block=block, scanner=scanner,
                    group=_text(raw.get("group"), 24) or None, stainingname=_text(raw.get("stainingname"), 40) or None,
                    size_mb=_opt_num(raw.get("size_mb"), float), width=_opt_num(raw.get("width"), int),
                    height=_opt_num(raw.get("height"), int), levels=_opt_num(raw.get("levels"), int),
                    spacing0_um=_opt_num(raw.get("spacing0_um"), float)))
            except RowRefused as exc:
                refused.append({"line": i, "filename": stem, "status": "refused", "code": exc.code,
                                "message": exc.message, **exc.details})
    return rows, refused


def read_sha256_list(path: Path) -> dict[str, str]:
    """``sha256sum`` format (``<64 hex>  <name>``) -> {file stem: lower-case sha256}."""
    out: dict[str, str] = {}
    for n, line in enumerate(Path(path).read_text(encoding="utf-8").splitlines(), start=1):
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        m = _SHA_LINE_RE.match(line.strip())
        if not m:
            raise ImportRefused(f"{path}:{n}: not a '<sha256>  <file name>' line")
        stem = _stem(m.group(2))
        sha = m.group(1).lower()
        if out.get(stem, sha) != sha:
            raise ImportRefused(f"{path}:{n}: {stem} is listed twice with different checksums")
        out[stem] = sha
    return out


def read_metadata(directory: Path) -> dict[str, dict]:
    """The fields of COBRA's original metadata needed to cross-check a selection, by file stem. Patient sex and age
    (in bcc_patient.csv) are deliberately not kept."""
    out: dict[str, dict] = {}

    def rows(name):
        p = Path(directory) / name
        if not p.is_file():
            raise ImportRefused(f"metadata file {p} not found")
        with open(p, newline="", encoding="utf-8") as fh:
            yield from csv.DictReader(fh)

    for r in rows("bcc_bcc.csv"):
        out.setdefault(_stem(r.get("filename")), {}).update(
            {"label": (r.get("label") or "").strip(), "category": _text(r.get("category"))})
    for r in rows("bcc_patient.csv"):
        out.setdefault(_stem(r.get("filename")), {}).update(
            {"patient_id": (r.get("patient_id") or "").strip().upper(),
             "specimennumber": (r.get("specimennumber") or "").strip(),
             "block": (r.get("block") or "").strip().upper(), "stainingname": _text(r.get("stainingname"), 40),
             "specimenmethod": _text(r.get("specimenmethod"), 40)})
    for r in rows("bcc_images.csv"):
        out.setdefault(_stem(r.get("filename")), {}).update(
            {"scanner": _text(r.get("Scanner")), "width": (r.get("Width (px)") or "").strip(),
             "height": (r.get("Height (px)") or "").strip(), "levels": (r.get("Levels") or "").strip()})
    return out


def cross_check(row: CobraRow, meta: dict[str, dict]) -> dict:
    """Compare a selection row with COBRA's original metadata; refuse on any difference."""
    m = meta.get(row.filename)
    if m is None or not {"label", "patient_id", "scanner"} <= set(m):
        raise RowRefused("metadata_missing", "The file is not in all of COBRA's metadata files", filename=row.filename)
    expected = {"label": row.label, "category": row.category, "patient_id": row.patient_id,
                "specimennumber": str(row.specimennumber), "block": row.block, "scanner": row.scanner}
    if row.stainingname is not None:
        expected["stainingname"] = row.stainingname
    for k, v in (("width", row.width), ("height", row.height), ("levels", row.levels)):
        if v is not None:
            expected[k] = str(v)
    diff = {k: {"selection": v, "metadata": m.get(k)} for k, v in expected.items() if str(m.get(k)) != str(v)}
    if diff:
        raise RowRefused("metadata_mismatch", "The selection row disagrees with COBRA's metadata", fields=diff)
    return {"checked_fields": sorted(expected), "specimenmethod": m.get("specimenmethod")}


# --------------------------------------------------------------------------- records


def label_value(row: CobraRow, negative_value: str) -> str:
    return POSITIVE_VALUE if row.label == "1" else negative_value


def label_provenance(row: CobraRow, value: str) -> str:
    """Free-text provenance stored on the imported label (one text per COBRA label/category pair)."""
    return (f"Imported reference label from COBRA (bcc package, slide-level label file): COBRA label {row.label}, "
            f"category '{row.category}' (verbatim), recorded as '{value}'. Label method: {LABEL_METHOD}. "
            + ("'BCC absent' is NOT the same as benign. " if value != POSITIVE_VALUE else "")
            + f"Licence {LICENCE}.")


def case_note(row: CobraRow) -> str:
    return (f"Public research dataset COBRA (Radboud University Medical Center; AWS Open Data registry), licence "
            f"{LICENCE}: attribution required, non-commercial use only, share-alike. Coded from COBRA patient id "
            f"{row.patient_id}, specimen number {row.specimennumber}. Labels on this case's slides are imported "
            f"reference labels ({LABEL_METHOD}). Collection date and anatomic site are not published by COBRA.")


def public_dataset_record(*, selection_sha256: str, sha256_list_sha256: str, licence_file_sha256: str | None,
                          rows: int, negative_value: str) -> dict:
    return {
        "dataset": "COBRA",
        "full_name": "COBRA (Classification Of Basal cell carcinoma, Risky skin tumours and Abnormalities)",
        "package": "bcc (skin biopsies: BCC and non-BCC)",
        "publisher": "Radboud University Medical Center (Geijs et al.)",
        "host": "AWS Open Data registry, s3://cobra-pathology (https://registry.opendata.aws/cobra/)",
        "licence": LICENCE,
        "licence_url": LICENCE_URL,
        "licence_file_sha256": licence_file_sha256,
        "attribution_required": True,
        "commercial_use": "not permitted",
        "share_alike": True,
        "label_source": "imported_reference",
        "label_method": LABEL_METHOD,
        "label_mapping": {"1": POSITIVE_VALUE, "0": negative_value},
        "label_mapping_note": "COBRA's non-BCC category ('Non-malignant') is recorded as BCC absent, which is NOT "
                              "the same as benign.",
        "reference_standard_for_datasets": "imported_reference",
        "selection": {"rows": rows, "file_sha256": selection_sha256, "sha256_list_sha256": sha256_list_sha256},
        "personal_attributes_imported": "none (COBRA's patient sex and age are not imported)",
        "limitations": list(LIMITATIONS),
        "importer": IMPORTER_VERSION,
        "documentation": "workbench/docs/public-datasets.md",
        "research_use_only": True,
    }


def _negative_value(project: Project | None) -> str:
    classes = list(((project.task_template_json if project else None) or {}).get("classes") or [])
    negatives = [c for c in classes if c != POSITIVE_VALUE]
    value = negatives[0] if negatives else DEFAULT_NEGATIVE_VALUE
    if value not in LABEL_VALUES or "benign" == value or value.startswith("benign"):
        raise ImportRefused(f"the project's BCC-absent class {value!r} is not a valid, non-benign label value")
    return value


# --------------------------------------------------------------------------- project


def ensure_project(db: Session, project_id: str, record: dict) -> tuple[Project, bool]:
    from ..seed import TASK_TEMPLATE

    for uid in MEMBERS:
        if db.get(User, uid) is None:
            raise ImportRefused(f"demo user {uid} does not exist; seed the database first "
                                "(python -m dermpath.seed, or --reset for a fresh one)")
    project = db.get(Project, project_id)
    created = project is None
    if created:
        project = Project(
            id=project_id, name=PROJECT_NAME,
            description=("Public research dataset: an approved subset of the COBRA BCC biopsy package (Radboud "
                         f"University Medical Center; AWS Open Data registry). Licence {LICENCE}: attribution, "
                         "non-commercial use only, share-alike. Slide labels are imported reference labels "
                         "extracted from pathology reports by COBRA's rule-based method, not expert reads in this "
                         "workbench. Single site and scanner; enriched prevalence (about half BCC). Not a "
                         "validation of clinical performance. Research use only."),
            task_template_json=json.loads(json.dumps(TASK_TEMPLATE)),
            settings_json={"independent_review": False, "public_dataset": record},
            demo_seeded=False)
        db.add(project)
        db.flush()
        audit.record(db, action="project.created", entity_type="project", entity_id=project_id,
                     actor_id=SYSTEM_IMPORT, actor_role="system", project_id=project_id,
                     after={"name": PROJECT_NAME, "public_dataset": "COBRA", "licence": LICENCE,
                            "importer": IMPORTER_VERSION})
    elif not (project.settings_json or {}).get("public_dataset"):
        raise ImportRefused(f"project {project_id} exists but is not a public dataset project; choose another id")
    have = set(db.scalars(select(ProjectMember.user_id).where(ProjectMember.project_id == project_id)).all())
    for uid in MEMBERS:
        if uid not in have:
            db.add(ProjectMember(project_id=project_id, user_id=uid, added_by=SYSTEM_IMPORT))
    db.flush()
    return project, created


# --------------------------------------------------------------------------- rows


@dataclass
class _Context:
    project_id: str
    images: Path
    sha_map: dict[str, str]
    meta: dict[str, dict] | None
    negative_value: str
    dry_run: bool


def _expected_lineage(row: CobraRow) -> dict:
    return {"patient_code": row.patient_code, "accession_code": row.accession_code, "part": PART, "block": row.block}


def _check_existing(db: Session, slide: Slide, row: CobraRow) -> None:
    lin = slide_lineage(db, slide)
    have = {k: lin.get(k) for k in ("patient_code", "accession_code", "part", "block")}
    if have != _expected_lineage(row) or slide.provenance != PROVENANCE:
        raise RowRefused("lineage_conflict", "A slide with this sha256 exists with another hierarchy or provenance; "
                         "it was left unchanged", slide_id=slide.id, existing=have, expected=_expected_lineage(row),
                         provenance=slide.provenance)


def _ensure_label(db: Session, slide: Slide, row: CobraRow, value: str) -> tuple[str, bool]:
    try:
        lv, created = create_imported_reference_label(db, slide=slide, value=value,
                                                      provenance=label_provenance(row, value))
    except ApiError as exc:
        raise RowRefused("label_conflict", exc.message, slide_id=slide.id, **exc.details) from exc
    return lv.id, created


def _import_record(row: CobraRow, *, slide_id: str, sha256: str, size: int, value: str, label_version_id: str,
                   metadata_check: dict | None) -> dict:
    return {
        "schema": IMPORT_RECORD_SCHEMA,
        "importer": IMPORTER_VERSION,
        "dataset": "COBRA",
        "licence": LICENCE,
        "licence_url": LICENCE_URL,
        "slide_id": slide_id,
        "source_file": row.source_filename,
        "sha256": sha256,
        "bytes": size,
        "sha256_verified_against": "published checksum list (sha256.txt), hashed while copying",
        "source_row": {k: v for k, v in asdict(row).items() if k != "line"},
        "metadata_cross_check": metadata_check,
        "mapping": {**_expected_lineage(row), "site_id": SITE_ID, "level_index": LEVEL_INDEX, "stain": STAIN,
                    "scanner_id": scanner_slug(row.scanner), "provenance": PROVENANCE},
        "label": {"value": value, "source": "imported_reference", "label_version_id": label_version_id,
                  "cobra_label": row.label, "cobra_category": row.category, "method": LABEL_METHOD},
        "imported_at": utcnow().isoformat(),
        "research_use_only": True,
    }


def _import_row(ctx: _Context, row: CobraRow, seen_sha: dict[str, str]) -> dict:
    base = {"line": row.line, "filename": row.filename, "patient_code": row.patient_code,
            "accession_code": row.accession_code}
    if not re.match(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$", row.filename):
        raise RowRefused("unsafe_filename", "The listed file name is not a plain file name")
    expected = ctx.sha_map.get(row.filename)
    if expected is None:
        raise RowRefused("sha256_missing", "The file is not in the published checksum list")
    if seen_sha.setdefault(expected, row.filename) != row.filename:
        raise RowRefused("duplicate_in_selection", "Another listed file has the same sha256",
                         other=seen_sha[expected])
    metadata_check = cross_check(row, ctx.meta) if ctx.meta is not None else None
    value = label_value(row, ctx.negative_value)

    with session_scope() as db:
        existing = db.scalars(select(Slide).where(Slide.project_id == ctx.project_id,
                                                  Slide.sha256 == expected)).first()
        if existing is not None:
            _check_existing(db, existing, row)
            if ctx.dry_run:
                return {**base, "status": "existing", "slide_id": existing.id}
            label_id, label_created = _ensure_label(db, existing, row, value)
            return {**base, "status": "existing", "slide_id": existing.id, "label_version_id": label_id,
                    "label_created": label_created, "ingest_status": existing.ingest_status}

    path = safe_member(ctx.images, row.source_filename)
    if not path.is_file():
        raise RowRefused("file_missing", "The image file is not in the images directory")
    if ctx.dry_run:
        actual = file_sha256(path)
        if actual != expected:
            raise RowRefused("sha256_mismatch", "The file's sha256 differs from the published checksum list",
                             expected=expected, actual=actual)
        return {**base, "status": "would_import", "sha256": expected, "label_value": value}

    slide_id = new_id()
    try:
        stored = store_server_file(ctx.project_id, slide_id, path, expected_sha256=expected, ext=EXT)
    except StoreError as exc:
        raise RowRefused("sha256_mismatch", "The file's sha256 differs from the published checksum list; nothing "
                         "was stored", expected=expected, detail=str(exc)) from exc
    store = get_store()
    record_key = slide_key(ctx.project_id, slide_id, "import_record.json")
    try:
        with session_scope() as db:
            try:
                block = find_or_create_hierarchy(
                    db, ctx.project_id, SYSTEM_IMPORT, patient_code=row.patient_code,
                    accession_code=row.accession_code, part_designation=PART, block_designation=row.block,
                    collected_on=None, site_id=SITE_ID, anatomic_site_text=None, provenance=PROVENANCE)
            except ApiError as exc:
                raise RowRefused(exc.code, exc.message, **exc.details) from exc
            part = db.get(SpecimenPart, db.get(Block, block.id).part_id)
            case = db.get(Case, part.case_id)
            if case.provenance != PROVENANCE:
                raise RowRefused("lineage_conflict", "The case exists with another provenance; left unchanged",
                                 accession_code=row.accession_code, provenance=case.provenance)
            if not case.note:
                case.note = case_note(row)
            slide, job = register_slide(
                db, project_id=ctx.project_id, slide_id=slide_id, stored=stored, ext=EXT, block_id=block.id,
                level_index=LEVEL_INDEX, stain=STAIN, scanner_id=scanner_slug(row.scanner), provenance=PROVENANCE,
                original_filename=row.source_filename, created_by=SYSTEM_IMPORT)
            label_id, _ = _ensure_label(db, slide, row, value)
            record = _import_record(row, slide_id=slide_id, sha256=stored.sha256, size=stored.size, value=value,
                                    label_version_id=label_id, metadata_check=metadata_check)
            store.put_if_absent(record_key, json.dumps(record, indent=2, sort_keys=True).encode())
            audit.record(db, action="slide.imported", entity_type="slide", entity_id=slide_id,
                         actor_id=SYSTEM_IMPORT, actor_role="system", project_id=ctx.project_id,
                         after={"dataset": "COBRA", "source_file": row.source_filename, "sha256": stored.sha256,
                                "provenance": PROVENANCE, "licence": LICENCE, "patient_code": row.patient_code,
                                "accession_code": row.accession_code, "label_value": value,
                                "label_version_id": label_id, "import_record_key": record_key, "job_id": job.id})
            job_id = job.id
    except BaseException:
        for key in (stored.key, record_key):  # nothing of a failed row stays behind
            try:
                if store.exists(key):
                    store.delete(key)
            except OSError:
                log.warning("could not remove %s after a failed import row", key)
        raise
    return {**base, "status": "imported", "slide_id": slide_id, "sha256": stored.sha256, "label_value": value,
            "label_version_id": label_id, "ingest_job_id": job_id}


# --------------------------------------------------------------------------- verification


def verify_project(project_id: str, rows: list[CobraRow], sha_map: dict[str, str]) -> dict:
    """Ingest status per imported slide, and agreement of the ingested size, levels and pixel size with the dataset's
    metadata (descriptive; nothing is changed). Also the project's ingest and QC job counts."""
    by_sha = {sha_map.get(r.filename): r for r in rows if sha_map.get(r.filename)}
    with session_scope() as db:
        slides = db.scalars(select(Slide).where(Slide.project_id == project_id).order_by(Slide.id)).all()
        status = Counter(s.ingest_status for s in slides)
        mismatches, failed = [], []
        for s in slides:
            if s.ingest_status == "failed":
                failed.append({"slide_id": s.id, "source_file": s.original_filename, "error": s.ingest_error})
            row = by_sha.get(s.sha256)
            if row is None or s.ingest_status != "succeeded":
                continue
            diff = {}
            if row.width is not None and s.width != row.width:
                diff["width"] = [row.width, s.width]
            if row.height is not None and s.height != row.height:
                diff["height"] = [row.height, s.height]
            if row.levels is not None and s.levels != row.levels:
                diff["levels"] = [row.levels, s.levels]
            if row.spacing0_um is not None:
                for axis in ("mpp_x", "mpp_y"):
                    got = getattr(s, axis)
                    if got is None or abs(got - row.spacing0_um) > _MPP_REL_TOL * row.spacing0_um:
                        diff[axis] = [row.spacing0_um, got]
            if diff:
                mismatches.append({"slide_id": s.id, "source_file": s.original_filename, "metadata_vs_ingested": diff})
        jobs = db.execute(select(Job.type, Job.status, func.count(Job.id)).where(
            Job.project_id == project_id, Job.type.in_(("ingest", "qc_screen")))
            .group_by(Job.type, Job.status)).all()
    job_counts: dict[str, dict[str, int]] = {}
    for t, st, n in jobs:
        job_counts.setdefault(t, {})[st] = n
    pending = sum(n for t in job_counts.values() for st, n in t.items() if st in ("queued", "running"))
    return {"slides": len(slides), "ingest_status": dict(sorted(status.items())), "ingest_failed": failed,
            "metadata_mismatches": mismatches, "jobs": job_counts, "jobs_pending": pending,
            "complete": pending == 0 and status.get("succeeded", 0) == len(slides) and not mismatches}


# --------------------------------------------------------------------------- entry points


def import_cobra(selection: Path, images: Path, sha256_file: Path, *, project_id: str = PROJECT_ID,
                 metadata_dir: Path | None = None, license_file: Path | None = None, dry_run: bool = False,
                 limit: int | None = None, process_jobs: bool = False) -> dict:
    """Import (or re-check) the subset. Returns a JSON-able summary; see the module docstring."""
    settings = get_settings()
    if not settings.mode_supported:
        raise ImportRefused(f"WB_MODE={settings.mode} is not implemented; the importer refuses to run (fail closed)")
    if not re.match(r"^[a-z0-9][a-z0-9-]{2,63}$", project_id or ""):
        raise ImportRefused("--project must be a lower-case slug such as proj-cobra-bcc-subset")
    selection, images, sha256_file = Path(selection), Path(images), Path(sha256_file)
    for p, what in ((selection, "selection"), (sha256_file, "sha256 list")):
        if not p.is_file():
            raise ImportRefused(f"{what} file {p} not found")
    if not images.is_dir():
        raise ImportRefused(f"images directory {images} not found")
    if license_file is not None and not Path(license_file).is_file():
        raise ImportRefused(f"licence file {license_file} not found")
    rows, refused = read_selection(selection)
    if limit is not None:
        rows = rows[: max(0, limit)]
    sha_map = read_sha256_list(sha256_file)
    meta = read_metadata(Path(metadata_dir)) if metadata_dir is not None else None
    init_db()
    record = public_dataset_record(selection_sha256=file_sha256(selection),
                                   sha256_list_sha256=file_sha256(sha256_file),
                                   licence_file_sha256=file_sha256(Path(license_file)) if license_file else None,
                                   rows=len(rows) + len(refused), negative_value=DEFAULT_NEGATIVE_VALUE)
    with session_scope() as db:
        if dry_run:
            for uid in MEMBERS:
                if db.get(User, uid) is None:
                    raise ImportRefused(f"demo user {uid} does not exist; seed the database first")
            project, created = db.get(Project, project_id), False
        else:
            project, created = ensure_project(db, project_id, record)
        negative = _negative_value(project)
    ctx = _Context(project_id=project_id, images=images, sha_map=sha_map, meta=meta, negative_value=negative,
                   dry_run=dry_run)
    results: list[dict] = []
    seen_sha: dict[str, str] = {}
    for row in rows:
        try:
            results.append(_import_row(ctx, row, seen_sha))
        except RowRefused as exc:
            results.append({"line": row.line, "filename": row.filename, "status": "refused", "code": exc.code,
                            "message": exc.message, **exc.details})
    results = sorted(refused + results, key=lambda r: r["line"])
    counts = Counter(r["status"] for r in results)
    summary = {
        "importer": IMPORTER_VERSION,
        "project_id": project_id,
        "project_created": created,
        "dry_run": dry_run,
        "var_dir": str(settings.var_dir),
        "rows": len(results),
        "counts": dict(sorted(counts.items())),
        "refused": [r for r in results if r["status"] == "refused"],
        "label_values": dict(sorted(Counter(r.get("label_value") for r in results
                                            if r["status"] in ("imported", "would_import")).items())),
        "results": results,
    }
    if not dry_run:
        with session_scope() as db:
            audit.record(db, action="dataset.import_run", entity_type="project", entity_id=project_id,
                         actor_id=SYSTEM_IMPORT, actor_role="system", project_id=project_id,
                         after={"importer": IMPORTER_VERSION, "dataset": "COBRA", "counts": summary["counts"],
                                "selection_sha256": record["selection"]["file_sha256"],
                                "refused": [{"filename": r["filename"], "code": r["code"]}
                                            for r in summary["refused"]]})
        if process_jobs:
            from ..jobs.worker import Worker

            outcomes = Worker(f"cobra-import-{new_id()[:6]}", types=["ingest", "qc_screen"],
                              record_heartbeat=False).run_until_idle(max_jobs=10 * max(1, len(results)) + 10)
            summary["jobs_processed"] = dict(sorted(Counter(f"{o.type}:{o.status}" for o in outcomes).items()))
        summary["verification"] = verify_project(project_id, rows, sha_map)
        summary["next_step"] = (
            "Done: every slide is ingested and matches the metadata." if summary["verification"]["complete"] else
            "Run the worker until the ingest and qc_screen jobs finish (python -m dermpath.worker --once, or the "
            "long-running worker), then run this command again to verify.")
    return summary


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m dermpath.importers.cobra",
                                     description="Import the approved COBRA BCC biopsy subset (CC BY-NC-SA 4.0).")
    parser.add_argument("--selection", required=True, type=Path, help="subset listing (selection.csv)")
    parser.add_argument("--images", required=True, type=Path, help="directory holding <filename>.tif")
    parser.add_argument("--sha256", required=True, type=Path, help="published checksum list (sha256sum format)")
    parser.add_argument("--metadata", type=Path, default=None,
                        help="COBRA metadata directory (bcc_bcc.csv, bcc_patient.csv, bcc_images.csv) to cross-check")
    parser.add_argument("--license-file", type=Path, default=None, help="the dataset's LICENSE file (sha256 recorded)")
    parser.add_argument("--project", default=PROJECT_ID)
    parser.add_argument("--dry-run", action="store_true", help="validate and hash only; write nothing")
    parser.add_argument("--limit", type=int, default=None, help="import only the first N rows")
    parser.add_argument("--process-jobs", action="store_true",
                        help="run the ingest and qc_screen jobs in-process after importing")
    parser.add_argument("--verbose", action="store_true", help="print every row's result")
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    try:
        summary = import_cobra(args.selection, args.images, args.sha256, project_id=args.project,
                               metadata_dir=args.metadata, license_file=args.license_file, dry_run=args.dry_run,
                               limit=args.limit, process_jobs=args.process_jobs)
    except ImportRefused as exc:
        log.error("%s", exc)
        return 2
    if not args.verbose:
        summary = {k: v for k, v in summary.items() if k != "results"}
    print(json.dumps(summary, indent=2, sort_keys=True, default=str))
    verification = summary.get("verification") or {}
    return 1 if summary["refused"] or verification.get("metadata_mismatches") or verification.get("ingest_failed") \
        else 0


if __name__ == "__main__":
    sys.exit(main())
