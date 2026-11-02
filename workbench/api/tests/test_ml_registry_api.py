"""Research model registry (never deploys), attention maps (labelled attention only), the
error gallery and failure reasons, and contract field coverage."""

from __future__ import annotations

import pytest
from sqlalchemy import select, text

from test_ml_support import BANNER, CID, LEAD, cohort, workflow

RUN_FIELDS = {"id", "name", "project_id", "dataset_version_id", "dataset_name", "dataset_manifest_sha256", "encoder_id",
              "head", "params", "seed", "status", "job_id", "progress", "progress_message", "synthetic", "banner",
              "code_revision", "deps", "weights_sha256", "checkpoint", "threshold", "split_counts", "created_by",
              "created_at", "finished_at", "error", "registered_model_id"}
EVAL_FIELDS = {"split", "n_items", "n_patients", "positives", "negatives", "confusion", "metrics", "calibration",
               "coverage_curve", "subgroups", "bootstrap", "synthetic", "banner", "threshold", "schema", "classes",
               "tuning_set", "evaluation_prevalence", "operating_point", "threshold_free_metrics",
               "intention_to_evaluate", "n_unscorable", "risk_coverage", "abstention", "failure_analysis",
               "evaluation_protocol", "warnings", "unscored"}


def test_contract_fields_present(clients, ids):
    lead = clients(LEAD)
    rid = cohort(ids)["runs"]["abmil"]
    run = lead.get(f"/api/v1/experiments/{rid}").json()
    assert RUN_FIELDS <= set(run)
    assert set(run["checkpoint"]) >= {"object_key", "sha256", "bytes"}
    assert set(run["threshold"]) >= {"value", "selected_on", "rule", "frozen_at"}
    assert set(run["split_counts"]) == {"train", "val", "test"} and set(run["split_counts"]["val"]) >= {"patients",
                                                                                                       "items"}
    ev = lead.get(f"/api/v1/experiments/{rid}/evaluation?split=val").json()
    assert EVAL_FIELDS <= set(ev)
    assert set(ev["confusion"]) == {"tp", "fp", "tn", "fn"}
    for k in ("sensitivity", "specificity", "ppv", "npv"):
        assert {"value", "numerator", "denominator", "ci", "undefined_reason"} <= set(ev["metrics"][k])
    for k in ("auroc", "auprc"):
        assert {"value", "defined", "undefined_reason", "ci"} <= set(ev["metrics"][k])
    assert {"bins", "brier", "ece", "note", "raw", "calibrated"} <= set(ev["calibration"])
    assert ev["calibration"]["note"] == "scores are not probabilities unless calibrated"
    assert all({"lo", "hi", "mean_score", "fraction_positive", "n"} <= set(b) for b in ev["calibration"]["bins"])
    assert all({"coverage", "error_rate", "n_kept"} <= set(c) for c in ev["coverage_curve"])
    assert ev["risk_coverage"]["aurc"] is not None and "out-of-distribution" in ev["abstention"]["note"]
    sg = ev["subgroups"]
    assert sg["count_unit"] == "patients" and sg["rows"]
    assert all(r["key"] in ("scanner_id", "site_id", "stain", "stain_batch")
               and r["status"] in ("ok", "insufficient_evidence", "not_recorded") for r in sg["rows"])
    assert {r["status"] for r in sg["rows"] if r["key"] != "stain_batch"} <= {"ok", "insufficient_evidence"}
    assert ev["bootstrap"]["method"] == "patient_cluster" and ev["bootstrap"]["n_boot"] == 500
    assert ev["metrics"]["auroc"]["ci"] is not None  # 12 validation patients → a CI is reported
    lo, hi = ev["metrics"]["auroc"]["ci"]
    assert lo <= ev["metrics"]["auroc"]["value"] <= hi
    assert ev["metrics"]["auprc"]["prevalence_baseline"] == pytest.approx(ev["positives"] / ev["n_items"])
    assert ev["metrics"]["ppv"]["evaluation_prevalence"] == pytest.approx(ev["positives"] / ev["n_items"])
    assert ev["tuning_set"] is (ev["threshold"]["selection_status"] == "selected")
    assert ev["classes"]["negative"]["value"] == "bcc_absent_not_benign"
    fa = ev["failure_analysis"]
    assert fa["n_errors"] == ev["confusion"]["fp"] + ev["confusion"]["fn"] and "counts" in fa


# --------------------------------------------------------------------------- registry


def test_registry_creates_research_candidates_and_never_deploys(clients, ids):
    from dermpath.db import session_scope
    from dermpath.ml.models import ModelVersion
    from dermpath.models import ImmutableRecordError

    lead = clients(LEAD)
    rid = cohort(ids)["runs"]["meanpool_logreg"]
    r = lead.post(f"/api/v1/experiments/{rid}/register", json={"note": "baseline candidate"})
    assert r.status_code == 201
    mv = r.json()
    assert mv["status"] == "research_candidate" and mv["deployed"] is False and mv["run_id"] == rid
    assert mv["synthetic"] is True and mv["banner"] == BANNER and "Never deployed" in mv["notice"]
    from dermpath.ml.models import TrainingRun

    with session_scope() as db:
        pinned = db.get(TrainingRun, rid).feature_set_id is not None
    if pinned:  # an engine run: registration builds its immutable, research-only inference bundle
        assert mv["bundle_id"] and mv["bundle"]["verified"] is True and mv["bundle"]["research_use_only"] is True
        assert mv["bundle"]["can_infer"] is False  # a pipeline-test bundle cannot score new slides
    else:
        assert mv["bundle_id"] is None and "legacy run" in mv["bundle_unavailable_reason"]
    again = lead.post(f"/api/v1/experiments/{rid}/register")
    assert again.status_code == 200 and again.json()["id"] == mv["id"]  # idempotent per run
    assert again.json()["bundle_id"] == mv["bundle_id"]
    assert lead.get(f"/api/v1/experiments/{rid}").json()["registered_model_id"] == mv["id"]
    listed = lead.get(f"/api/v1/projects/{CID}/models").json()
    assert [m["id"] for m in listed["items"]] == [mv["id"]] and "no deployment path" in listed["note"]
    assert listed["items"][0]["bundle_id"] == mv["bundle_id"]
    # There is no deploy route, and the state cannot be forced.
    for url in (f"/api/v1/models/{mv['id']}/deploy", f"/api/v1/models/{mv['id']}"):
        assert lead.post(url).status_code in (404, 405)
    with session_scope() as db:
        m = db.get(ModelVersion, mv["id"])
        m.status = "deployed"
        with pytest.raises(ImmutableRecordError):
            db.flush()
        db.rollback()
    from sqlalchemy.exc import DatabaseError

    with session_scope() as db:
        with pytest.raises(DatabaseError):
            db.execute(text("UPDATE model_version SET status='deployed' WHERE id=:i"), {"i": mv["id"]})
        db.rollback()
    with session_scope() as db:
        assert db.get(ModelVersion, mv["id"]).status == "research_candidate"
    # Audited.
    audit = lead.get(f"/api/v1/projects/{CID}/audit?entity_type=model_version").json()["items"]
    assert audit[0]["action"] == "model.registered" and audit[0]["after"]["deployed"] is False


def test_unfinished_run_cannot_be_registered(clients, ids):
    from test_ml_support import start

    lead = clients(LEAD)
    out = start(lead, CID, cohort(ids)["dataset_version_id"], "meanpool_logreg", seed=77)
    r = lead.post(f"/api/v1/experiments/{out['experiment']['id']}/register")
    assert r.status_code == 409 and r.json()["error"]["code"] == "run_not_succeeded"


# --------------------------------------------------------------------------- attention


def test_attention_is_labelled_attention_and_only_for_abmil(clients, ids):
    from dermpath.db import session_scope
    from dermpath.ml.models import Prediction

    lead = clients(LEAD)
    c = cohort(ids)
    with session_scope() as db:
        p = db.scalars(select(Prediction).where(Prediction.run_id == c["runs"]["abmil"],
                                                Prediction.split == "val")).first()
        sid, n = p.slide_ids_json[0], p.attributes_json["n_patches"]
    r = lead.get(f"/api/v1/experiments/{c['runs']['abmil']}/attention/{sid}")
    assert r.status_code == 200
    a = r.json()
    assert a["kind"] == "attention"
    assert a["notice"] == "Attention weights — not tumour segmentation and not a causal explanation"
    assert a["synthetic"] is True and a["banner"] == BANNER and a["coordinate_space"] == "level0_pixels"
    assert len(a["patches"]) == n and all(set(pp) == {"x", "y", "w", "h", "weight"} for pp in a["patches"])
    assert sum(pp["weight"] for pp in a["patches"]) == pytest.approx(1.0, abs=1e-5)
    assert all(pp["weight"] >= 0 for pp in a["patches"])
    text_blob = str(a).lower()
    assert "segmentation" in a["notice"] and "explanation" in a["notice"]
    assert "heatmap of tumour" not in text_blob and "explains" not in text_blob
    r = lead.get(f"/api/v1/experiments/{c['runs']['meanpool_logreg']}/attention/{sid}")
    assert r.status_code == 409 and r.json()["error"]["code"] == "attention_unavailable"
    assert lead.get(f"/api/v1/experiments/{c['runs']['abmil']}/attention/nonexistent").status_code == 404
    # The workflow-demo run reads real pixels from procedural tiles: patch boxes are level-0 boxes inside the slide.
    wf = workflow(ids)
    with session_scope() as db:
        p = db.scalars(select(Prediction).where(Prediction.run_id == wf["runs"]["abmil"])).first()
        sid = p.slide_ids_json[0]
    a = lead.get(f"/api/v1/experiments/{wf['runs']['abmil']}/attention/{sid}").json()
    slide = lead.get(f"/api/v1/slides/{sid}").json()
    assert a["patches"] and all(pp["x"] + pp["w"] <= slide["width"] and pp["y"] + pp["h"] <= slide["height"]
                                for pp in a["patches"])


# --------------------------------------------------------------------------- error gallery


def test_error_gallery_orders_false_negatives_first(clients, ids):
    lead = clients(LEAD)
    rid = cohort(ids)["runs"]["abmil"]
    body = lead.get(f"/api/v1/experiments/{rid}/errors?split=val").json()
    ev = lead.get(f"/api/v1/experiments/{rid}/evaluation?split=val").json()
    assert body["counts"]["false_negative"] == ev["confusion"]["fn"]
    assert body["counts"]["false_positive"] == ev["confusion"]["fp"]
    kinds = [i["error_type"] for i in body["items"]]
    assert kinds == sorted(kinds, key=lambda k: k != "false_negative")  # FN block first
    fn_scores = [i["score"] for i in body["items"] if i["error_type"] == "false_negative"]
    assert fn_scores == sorted(fn_scores)
    for i in body["items"]:
        assert i["attention_available"] is True and i["patient_code"].startswith("SYN-")
        assert i["failure_reason"] is None  # no QC issue and nothing uncalibrated on the cohort records
        assert (i["error_type"] == "false_negative") == (i["label"] == "bcc_present")
        assert i["categories"] and set(i["category_details"]) <= set(i["categories"])
        assert "benign" not in i["description"].replace("not_benign", "")
    assert body["categories"]["counts"] and body["classes"]["negative"]["value"] == "bcc_absent_not_benign"
    assert body["synthetic"] is True and body["banner"] == BANNER


def test_failure_reason_only_from_qc_or_calibration():
    from dermpath.ml.evaluation import failure_reason
    from dermpath.ml.models import Prediction

    def pred(ctx):
        return Prediction(attributes_json={"qc_context": ctx})

    assert failure_reason(pred(None)) is None
    assert failure_reason(pred({"qc_issues": [], "uncalibrated_slides": []})) is None
    r = failure_reason(pred({"qc_issues": ["fold (action_suggested)"], "uncalibrated_slides": ["s1"]}))
    assert r.startswith("possible contributing factor") and "fold (action_suggested)" in r
    assert "missing calibration" in r


def test_qc_context_snapshot_records_issues_on_workflow_slides(env, ids):
    from dermpath.db import session_scope
    from dermpath.ml.evaluation import qc_context

    with session_scope() as db:
        ctx = qc_context(db, [ids["slides"]["p4_a1_l1"]])  # seeded fold issue at "action_suggested"
        assert "fold (action_suggested)" in ctx["qc_issues"] and ctx["uncalibrated_slides"] == []
        cmu = qc_context(db, [ids["slides"]["cmu_cc0"]])
        assert cmu["uncalibrated_slides"] == []  # the CMU fixture has mpp
