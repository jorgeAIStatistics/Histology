"""Review priority queue (design §9): items ranked for HUMAN review. Nothing is resolved automatically.

Two kinds of signal, both on development data only:

* **Reader disagreements**: open ``disagreement`` rows (expert labels that differ). They are
  adjudicated by pathologists through the existing review flow; this queue only orders them.
* **Model-vs-reference discordances**: stored predictions of finished runs on the VALIDATION or
  OUT-OF-FOLD split (out-of-sample for the bag; never train, which is in-sample, and never test)
  whose decision differs from the reference label. A confident discordance is a "possible label
  error" to look at, never evidence that the reference is wrong. Discordances of patients sealed by
  a test release are left out (no test-informed relabelling). Each discordance states the reference
  standard it is measured against; under ``imported_reference`` (an external dataset's labels, not
  expert reads) it is worded as a discordance with the imported reference and carries the notice.

Ranking (transparent tiers, then the largest relative margin to the threshold, then the number of
discordant runs, then the oldest disagreement, then the target id):

1. an open reader disagreement AND a confident model discordance on the same target;
2. an open reader disagreement;
3. a confident model discordance (relative margin ≥ 0.6);
4. any other model discordance.
"""

from __future__ import annotations

from sqlalchemy import select

from ..datasets import IMPORTED_REFERENCE_NOTICE
from ..db import utcnow
from ..models import Case, DatasetVersion, Disagreement, Slide, SplitFamily, SplitFamilyAssignment
from ..vocab import LABEL_DISPLAY
from . import PIPELINE_TEST_BANNER
from .failure import FailurePolicy
from .metrics import relative_margin
from .models import Prediction, TrainingRun

SCHEMA = "dermpath.review_priorities/1"
DEVELOPMENT_SPLITS = ("val", "oof")
CONFIDENT_MARGIN = FailurePolicy().confident_margin
TIERS = {1: "reader disagreement and confident model discordance", 2: "open reader disagreement",
         3: "confident model discordance (possible label error)", 4: "model discordance"}
#: Tier wording when every discordance of the item is measured against IMPORTED reference labels (an external
#: dataset's standard, not an expert read here): a discordance with that reference, not a "label error" of an expert.
IMPORTED_TIER_LABELS = {1: "reader disagreement and confident discordance with the imported reference",
                        3: "confident discordance with the imported reference (not an expert read)",
                        4: "discordance with the imported reference"}
NOTICE = ("Ranked for human review only. Nothing is resolved, relabelled or adjudicated automatically; model "
          "discordance is not evidence that the reference label is wrong, and model scores are never expert truth.")


def _margin(score: float, threshold: float) -> float:
    try:
        return float(relative_margin([score], threshold)[0])
    except ValueError:  # scores outside [0, 1]: fall back to the absolute distance
        return abs(float(score) - float(threshold))


def _sealed_patients(db, project_id: str) -> set[str]:
    rows = db.execute(select(SplitFamilyAssignment.coded_patient_id)
                      .join(SplitFamily, SplitFamily.id == SplitFamilyAssignment.family_id)
                      .where(SplitFamily.project_id == project_id, SplitFamilyAssignment.sealed_at.is_not(None))).all()
    return {r[0] for r in rows}


def _patient_of(db, scope: str, slide_id: str | None, case_id: str | None) -> str | None:
    from ..hierarchy import slide_lineage

    if case_id:
        c = db.get(Case, case_id)
        if c is not None:
            return c.coded_patient_id
    if slide_id:
        s = db.get(Slide, slide_id)
        if s is not None:
            return slide_lineage(db, s).get("coded_patient_id")
    return None


def review_priorities(db, project_id: str, *, run_id: str | None = None, limit: int = 200) -> dict:
    sealed = _sealed_patients(db, project_id)
    now = utcnow()
    items: dict[tuple[str, str], dict] = {}

    def item(scope: str, target: str, slide_ids: list[str], case_id: str | None, patient_id: str | None,
             patient_code: str | None) -> dict:
        key = (scope, target)
        if key not in items:
            items[key] = {"target": {"scope": scope, "target_id": target, "slide_ids": slide_ids, "case_id": case_id,
                                     "coded_patient_id": patient_id, "patient_code": patient_code},
                          "reader_disagreement": None, "model_discordances": [],
                          "sealed_test_patient": bool(patient_id and patient_id in sealed)}
        return items[key]

    for d in db.scalars(select(Disagreement).where(Disagreement.project_id == project_id,
                                                   Disagreement.status == "open")
                        .order_by(Disagreement.created_at, Disagreement.id)).all():
        pid = _patient_of(db, d.scope, d.slide_id, d.case_id)
        it = item(d.scope, d.target_id, [d.slide_id] if d.slide_id else [], d.case_id, pid, None)
        created = d.created_at if d.created_at.tzinfo else d.created_at.replace(tzinfo=now.tzinfo)
        it["reader_disagreement"] = {"id": d.id, "values": d.values_json,
                                     "displays": [LABEL_DISPLAY.get(v, v) for v in d.values_json or []],
                                     "label_version_ids": d.label_version_ids_json, "created_at": d.created_at.isoformat(),
                                     "age_days": round((now - created).total_seconds() / 86400.0, 2)}

    q = select(TrainingRun).where(TrainingRun.project_id == project_id, TrainingRun.status == "succeeded")
    if run_id:
        q = q.where(TrainingRun.id == run_id)
    runs = {r.id: r for r in db.scalars(q).all()}
    standards: dict[str, str] = {}
    for r in runs.values():  # the labels each run's discordances are measured against
        standard = (r.identity_json or {}).get("reference_standard")
        if not standard:
            dv = db.get(DatasetVersion, r.dataset_version_id) if r.dataset_version_id else None
            standard = (((dv.manifest_json if dv is not None else None) or {}).get("config") or {}).get(
                "reference_standard")
        standards[r.id] = standard or "expert"
    excluded_sealed = 0
    if runs:
        preds = db.scalars(select(Prediction).where(Prediction.run_id.in_(list(runs)),
                                                    Prediction.split.in_(DEVELOPMENT_SPLITS))
                           .order_by(Prediction.run_id, Prediction.split, Prediction.bag_id)).all()
        for p in preds:
            if int(p.predicted) == int(p.label):
                continue
            if p.coded_patient_id in sealed:
                excluded_sealed += 1
                continue
            run = runs[p.run_id]
            scope, target = ("slide", p.slide_ids_json[0]) if p.bag_kind == "slide" else ("case", p.case_id)
            it = item(scope, target, list(p.slide_ids_json), p.case_id, p.coded_patient_id, p.patient_code)
            if it["target"]["patient_code"] is None:
                it["target"]["patient_code"] = p.patient_code
            m = _margin(p.score, p.threshold)
            predicted = run.positive_class if p.predicted else run.negative_class
            it["model_discordances"].append({
                "run_id": run.id, "run_name": run.name, "split": p.split, "reference": p.label_value,
                "reference_display": LABEL_DISPLAY.get(p.label_value, p.label_value), "predicted": predicted,
                "predicted_display": LABEL_DISPLAY.get(predicted, predicted), "score": p.score,
                "threshold": p.threshold, "relative_margin": m, "confident": m >= CONFIDENT_MARGIN,
                "error_type": "false_negative" if p.label == 1 else "false_positive", "synthetic": run.synthetic,
                "reference_standard": standards[run.id],
                **({"reference_standard_notice": IMPORTED_REFERENCE_NOTICE}
                   if standards[run.id] == "imported_reference" else {})})

    out = []
    for it in items.values():
        dis = it["model_discordances"]
        confident = any(x["confident"] for x in dis)
        has_rd = it["reader_disagreement"] is not None
        tier = 1 if has_rd and confident else 2 if has_rd else 3 if confident else 4
        max_margin = max((x["relative_margin"] for x in dis), default=0.0)
        imported_only = bool(dis) and all(x["reference_standard"] == "imported_reference" for x in dis)
        reasons = []
        if has_rd:
            reasons.append("open reader disagreement: " + " vs ".join(it["reader_disagreement"]["values"] or []))
        if dis:
            caveat = ("discordant with the imported reference, not an expert read" if imported_only
                      else "possible label error, not proof")
            reasons.append(f"{len(dis)} model discordance(s) on development data, largest relative margin "
                           f"{max_margin:.2f}" + (f" (confident: {caveat})" if confident else ""))
        if it["sealed_test_patient"]:
            reasons.append("patient sealed by a test release: adjudicate blind to model outputs")
        tier_label = IMPORTED_TIER_LABELS.get(tier, TIERS[tier]) if imported_only else TIERS[tier]
        out.append({**it, "tier": tier, "tier_label": tier_label, "max_relative_margin": max_margin,
                    "n_discordant_runs": len({x["run_id"] for x in dis}), "reasons": reasons,
                    "synthetic": any(x["synthetic"] for x in dis), "resolved": False, "action": "human review"})
    out.sort(key=lambda r: (r["tier"], -r["max_relative_margin"], -r["n_discordant_runs"],
                            -((r["reader_disagreement"] or {}).get("age_days") or 0.0), r["target"]["target_id"] or ""))
    for i, r in enumerate(out, start=1):
        r["rank"] = i
    synthetic = any(r["synthetic"] for r in out)
    used = sorted({x["reference_standard"] for r in out for x in r["model_discordances"]})
    standard_fields = {"reference_standards": used}
    if "imported_reference" in used:
        standard_fields["reference_standard_notice"] = IMPORTED_REFERENCE_NOTICE
    return {"schema": SCHEMA, "project_id": project_id, "run_id": run_id, "n_items": len(out), **standard_fields,
            "items": out[: int(limit)], "truncated": len(out) > int(limit),
            "counts": {TIERS[t]: sum(1 for r in out if r["tier"] == t) for t in TIERS},
            "excluded": {"sealed_patient_discordances": excluded_sealed},
            "sources": {"reader_disagreements": "open disagreement rows",
                        "model_discordances": f"stored predictions on {', '.join(DEVELOPMENT_SPLITS)} of finished runs "
                                              "(never train, never test)"},
            "confident_margin": CONFIDENT_MARGIN, "resolves_automatically": False, "notice": NOTICE,
            "synthetic": synthetic, "banner": PIPELINE_TEST_BANNER if synthetic else None}
