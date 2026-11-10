"""Identifier-risk checks.

These checks only RAISE FLAGS for human review. They never de-identify anything, and a
governance checkbox never counts as de-identification. Every flag carries the same
instruction: "possible identifier source: review before any non-demo use".

Flags never echo the suspicious text itself (the original filename is already stored
separately as metadata; property VALUES are not copied into flags).
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Mapping

MESSAGE = "possible identifier source: review before any non-demo use"
NOT_DEIDENTIFICATION = "A checkbox or attestation is not de-identification."

_MONTHS = r"(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*"
_DATE_PATTERNS = [
    re.compile(r"(19|20)\d{2}[-_.]?(0[1-9]|1[0-2])[-_.]?(0[1-9]|[12]\d|3[01])"),  # 20260131, 2026-01-31
    re.compile(r"(?<!\d)(0?[1-9]|1[0-2])[-_./](0?[1-9]|[12]\d|3[01])[-_./](\d{2}|\d{4})(?!\d)"),  # 1/31/26
    re.compile(r"(?<!\d)(0?[1-9]|[12]\d|3[01])[-_./](0?[1-9]|1[0-2])[-_./](\d{2}|\d{4})(?!\d)"),  # 31.01.2026
    re.compile(r"(?<![a-z])(0?[1-9]|[12]\d|3[01])[-_ ]?" + _MONTHS + r"[-_ ]?(\d{2}|\d{4})?", re.I),
    re.compile(_MONTHS + r"[-_ ]?(0?[1-9]|[12]\d|3[01])?[-_ ,]*(19|20)\d{2}", re.I),
]
_KEYWORDS = re.compile(r"(?<![a-z])(dob|mrn|patient|pt|name|ssn|birth|nhs|medrec)(?![a-z])", re.I)
_LONG_DIGITS = re.compile(r"\d{6,}")
_ACCESSION = re.compile(r"(?<![A-Za-z])[A-Za-z]{1,3}\d{2}[-_]\d{3,}")
_WORD = re.compile(r"[A-Za-z]+")
# Tokens that are common in slide filenames and not person names.
_BENIGN_WORDS = {
    "slide", "scan", "image", "level", "block", "part", "stain", "he", "h", "e", "ihc", "pas",
    "svs", "tif", "tiff", "ndpi", "jpg", "jpeg", "png", "case", "demo", "test", "synthetic",
    "small", "region", "cmu", "copy", "final", "new", "old", "left", "right", "skin", "biopsy",
    "shave", "punch", "excision", "x", "mag", "thumb", "macro", "label", "aperio", "field",
}


def filename_flags(filename: str) -> list[dict]:
    flags: list[dict] = []
    stem = filename.rsplit("/", 1)[-1].rsplit("\\", 1)[-1]
    stem = stem.rsplit(".", 1)[0] if "." in stem else stem

    def add(code: str, detail: str) -> None:
        flags.append({"code": code, "source": "filename", "detail": detail, "message": MESSAGE})

    if any(p.search(stem) for p in _DATE_PATTERNS):
        add("filename_date_like", "the filename contains a date-like pattern")
    if _KEYWORDS.search(stem):
        add("filename_identifier_keyword", "the filename contains an identifier keyword (e.g. DOB, MRN, name)")
    if _LONG_DIGITS.search(stem):
        add("filename_long_number", "the filename contains a long number (possible MRN or accession)")
    if _ACCESSION.search(stem):
        add("filename_accession_like", "the filename contains an accession-like code")
    words = [w for w in _WORD.findall(stem) if len(w) >= 2 and w.lower() not in _BENIGN_WORDS]
    capitalised = [w for w in words if w[0].isupper()]
    if "," in stem and len(words) >= 2:
        add("filename_name_like", "the filename looks like 'Last, First'")
    elif len(capitalised) >= 2 and len(words) >= 2:
        add("filename_name_like", "the filename contains two or more capitalised words (possible person name)")
    return flags


_SUSPICIOUS_KEY = re.compile(
    r"(date|time|user|operator|filename|patient|barcode|name|subject|accession|institution|dob|id$)", re.I
)
_SAFE_KEYS = {
    "openslide.level-count", "openslide.vendor", "openslide.mpp-x", "openslide.mpp-y",
    "openslide.objective-power", "openslide.quickhash-1", "openslide.background-color",
    "openslide.bounds-x", "openslide.bounds-y", "openslide.bounds-width", "openslide.bounds-height",
}
_COMMENT_HINT = re.compile(r"(Date\s*=|Time\s*=|User\s*=|Filename\s*=|Barcode|Patient)", re.I)


def metadata_flags(properties: Mapping[str, str], associated_images: Iterable[str]) -> list[dict]:
    flags: list[dict] = []
    names = set(associated_images)
    if "label" in names:
        flags.append({
            "code": "label_image_present", "source": "associated_image",
            "detail": "the file contains a slide LABEL image (often printed with identifiers); it is never served",
            "message": MESSAGE,
        })
    if "macro" in names:
        flags.append({
            "code": "macro_image_present", "source": "associated_image",
            "detail": "the file contains a MACRO overview image (may show the label); it is never served",
            "message": MESSAGE,
        })
    keys = []
    for k, v in properties.items():
        if k in _SAFE_KEYS or k.startswith("openslide.level[") or k.startswith("openslide.associated."):
            continue
        if k.startswith("dermpath."):
            continue
        if _SUSPICIOUS_KEY.search(k.split(".")[-1]):
            keys.append(k)
        elif k == "openslide.comment" and isinstance(v, str) and _COMMENT_HINT.search(v):
            keys.append(k)
    if keys:
        flags.append({
            "code": "metadata_may_contain_identifiers", "source": "file_metadata",
            "detail": "embedded metadata fields that may carry dates, user or file names",
            "property_keys": sorted(keys)[:30],
            "message": MESSAGE,
        })
    return flags


def exif_flags(has_exif: bool) -> list[dict]:
    if not has_exif:
        return []
    return [{
        "code": "exif_metadata_present", "source": "file_metadata",
        "detail": "the image carries EXIF metadata (may include dates, device or location)",
        "message": MESSAGE,
    }]
