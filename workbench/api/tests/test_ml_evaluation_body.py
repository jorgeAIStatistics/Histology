"""The evaluation body (design §7) built from stored prediction rows: operating-point metrics with numerator,
denominator and CI; AUROC/AUPRC with the prevalence baseline; PPV/NPV with the evaluation prevalence (and
prevalence-adjusted when declared); Brier, ECE, raw and calibrated curves; unscorable bags counted (scored-only and
intention-to-evaluate); risk–coverage, AURC and selective risk per class with the OOD note; subgroups with min_n in
PATIENTS; the failure taxonomy; the tuning-set flag; and the negative class never rendered as "benign"."""

from __future__ import annotations

import json
import re
from datetime import UTC, datetime

import numpy as np
import pytest


def _run(**kw):
    from dermpath.ml.models import TrainingRun

    base = dict(id="run-x", project_id="p", name="r", dataset_version_id="dv", dataset_manifest_sha256="m" * 64,
                encoder_id="handcrafted-stain-texture-v1", head="meanpool_logreg",
                params_json={"n_boot": 200, "boot_min_patients": 10, "subgroup_min_n": 5}, seed=3,
                status="succeeded", synthetic=False, label_scope="slide", positive_class="bcc_present",
                negative_class="bcc_absent_not_benign", evaluation_protocol="holdout", threshold_value=0.5,
                threshold_rule="youden", threshold_frozen_at=datetime(2026, 10, 1, tzinfo=UTC),
                threshold_json={"value": 0.5, "rule": "youden", "selected_on": "val", "selection_status": "selected"},
                created_by="u")
    base.update(kw)
    return TrainingRun(**base)


def _preds(n_patients=30, seed=0, split="val"):
    """Bags of patients (1–2 each); scores correlate with labels; attributes for subgroups."""
    from dermpath.ml.models import Prediction

    rng = np.random.default_rng(seed)
    out = []
    for i in range(n_patients):
        label = int(i % 3 == 0)
        for j in range(1 + (i % 2)):
            s = float(np.clip(rng.normal(0.65 if label else 0.35, 0.18), 0.001, 0.999))
            scanner = "scanner-c" if i < 2 else ("scanner-a" if i % 2 else "scanner-b")
            out.append(Prediction(
                run_id="run-x", project_id="p", split=split, bag_kind="slide", bag_id=f"s{i:02d}{j}",
                slide_ids_json=[f"s{i:02d}{j}"], case_id=f"c{i:02d}", coded_patient_id=f"pt{i:02d}",
                patient_code=f"SYN-{i:04d}", label_value="bcc_present" if label else "bcc_absent_not_benign",
                label_version_ids_json=[], label=label, score=s, threshold=0.5, predicted=int(s >= 0.5),
                abstained=False, attributes_json={"scanner_id": scanner, "site_id": f"site-{i % 3}", "stain": "H&E",
                                                  "qc_context": {"qc_issues": ["fold (open)"] if i == 4 else []}},
                feature_artifact_ids_json=[]))
    return out


UNSCORED = [{"bag_id": "u1", "split": "val", "reason": "no tissue patches", "label_value": "bcc_present",
             "coded_patient_id": "pt90"},
            {"bag_id": "u2", "split": "val", "reason": "no tissue patches", "label_value": "bcc_present",
             "coded_patient_id": "pt91"},
            {"bag_id": "u3", "split": "val", "reason": "no tissue patches", "label_value": "bcc_absent_not_benign",
             "coded_patient_id": "pt92"},
            {"bag_id": "t9", "split": "train", "reason": "other split: ignored", "label_value": "bcc_present",
             "coded_patient_id": "pt93"}]


def _yp(preds):
    y = np.array([p.label for p in preds])
    s = np.array([p.score for p in preds])
    return y, s


def test_operating_point_rank_and_prevalence_metrics():
    from sklearn.metrics import average_precision_score, roc_auc_score

    from dermpath.ml.evaluation import build_evaluation

    preds = _preds()
    run = _run(params_json={"n_boot": 200, "boot_min_patients": 10, "subgroup_min_n": 5, "target_prevalence": 0.1})
    body = build_evaluation(run, "val", preds, UNSCORED)
    y, s = _yp(preds)
    tp = int(((s >= 0.5) & (y == 1)).sum())
    fn = int(((s < 0.5) & (y == 1)).sum())
    m = body["metrics"]
    assert m["sensitivity"]["numerator"] == tp and m["sensitivity"]["denominator"] == tp + fn
    for k in ("sensitivity", "specificity", "ppv", "npv"):
        e = m[k]
        assert {"value", "numerator", "denominator", "ci", "ci_reason", "undefined_reason"} <= set(e)
        assert e["threshold_dependent"] is True
        if e["value"] is not None and e["ci"] is not None:
            assert e["ci"][0] <= e["value"] <= e["ci"][1]
    assert m["auroc"]["value"] == pytest.approx(roc_auc_score(y, s))
    assert m["auprc"]["value"] == pytest.approx(average_precision_score(y, s))
    assert m["auprc"]["prevalence_baseline"] == pytest.approx(y.mean())
    assert m["auroc"]["ci"] is not None and body["bootstrap"]["method"] == "patient_cluster"
    assert body["bootstrap"]["seed"] == 3 and body["bootstrap"]["seed_source"] == "run seed"
    assert set(body["threshold_free_metrics"]) == {"auroc", "auprc", "brier"}
    # PPV/NPV at the evaluation prevalence, which is stated; adjusted to the declared target prevalence.
    assert m["ppv"]["evaluation_prevalence"] == pytest.approx(y.mean())
    assert body["evaluation_prevalence"]["value"] == pytest.approx(y.mean()) and "prevalence" in \
        body["evaluation_prevalence"]["note"]
    adj = body["prevalence_adjusted"]
    se, sp = m["sensitivity"]["value"], m["specificity"]["value"]
    assert adj["target_prevalence"] == 0.1
    assert adj["ppv"]["value"] == pytest.approx(se * 0.1 / (se * 0.1 + (1 - sp) * 0.9))
    # Brier, ECE and the calibration curves (raw; the chart keeps reading top-level bins).
    assert m["brier"]["value"] == pytest.approx(float(np.mean((s - y) ** 2)))
    cal = body["calibration"]
    assert cal["raw"]["equal_width"]["ece"] == cal["ece"] and cal["bins"] == cal["raw"]["equal_width"]["bins"]
    assert cal["raw"]["equal_mass"]["bins"] and cal["calibrated"] is None and cal["note"].startswith("scores are not")


def test_unscorable_bags_are_counted_scored_only_and_intention_to_evaluate():
    from dermpath.ml.evaluation import build_evaluation

    preds = _preds()
    body = build_evaluation(_run(), "val", preds, UNSCORED)
    y, s = _yp(preds)
    tp = int(((s >= 0.5) & (y == 1)).sum())
    fn = int(((s < 0.5) & (y == 1)).sum())
    assert body["n_unscorable"] == 3 and body["unscorable_positives"] == 2 and body["unscorable_negatives"] == 1
    ite = body["intention_to_evaluate"]
    assert ite["sensitivity"]["denominator"] == tp + fn + 2 and ite["sensitivity"]["numerator"] == tp
    assert body["metrics"]["sensitivity"]["denominator"] == tp + fn  # scored only
    assert "unscorable positives are counted as missed" in ite["rule"]
    assert [u["bag_id"] for u in body["unscored"]] == ["u1", "u2", "u3"]  # other splits are not this split's
    assert any("could not be scored" in w for w in body["warnings"])
    # Labels missing from an entry are read from the frozen manifest.
    manifest = {"items": [{"slide_id": "u7", "case_id": "c7", "label_value": "bcc_present",
                           "coded_patient_id": "pt97", "split": "val"}]}
    body = build_evaluation(_run(), "val", preds, [{"bag_id": "u7", "reason": "no tissue"}], manifest=manifest)
    assert body["n_unscorable"] == 1 and body["unscorable_positives"] == 1


def test_risk_coverage_abstention_and_calibrated_curves():
    from dermpath.ml.calibration import fit_calibration
    from dermpath.ml.evaluation import build_evaluation
    from dermpath.ml.metrics import select_abstention_policy

    preds = _preds(n_patients=40)
    y, s = _yp(preds)
    cal = fit_calibration(s, y, method="platt", item_splits=["val"] * len(y))
    pol = select_abstention_policy(y, s, 0.5, target_coverage=0.8, selected_on="val")
    body = build_evaluation(_run(calibration_json=cal, abstention_json=pol), "val", preds, [])
    rc = body["risk_coverage"]
    assert rc["aurc"] is not None and rc["aurc_oracle"] <= rc["aurc"]
    assert rc["rows"][-1]["coverage"] == 1.0 and {"risk_positive", "risk_negative"} <= set(rc["rows"][0])
    assert "not a validated out-of-distribution detector" in rc["note"]
    assert "not a validated out-of-distribution detector" in body["abstention"]["note"]
    assert body["coverage_curve"][-1]["coverage"] == 1.0 and "error_rate" in body["coverage_curve"][0]
    sel = body["abstention"]["selective"]
    assert sel["policy_sha256"] == pol["policy_sha256"] and sel["coverage"]["denominator"] == len(y)
    assert {"selective_risk", "selective_sensitivity", "selective_specificity"} <= set(sel)
    assert body["abstention"]["selected_on_this_split"] is True
    calib = body["calibration"]
    assert calib["calibrated"] is not None and calib["calibrated"]["equal_width"]["ece"] is not None
    assert calib["frozen_calibration"]["method"] == "platt" and calib["frozen_calibration"]["in_sample"] is True
    assert calib["calibrated_note"].startswith("in-sample")
    # A tampered policy is refused, never silently applied.
    bad = {**pol, "upper": 0.99}
    body = build_evaluation(_run(abstention_json=bad), "val", preds, [])
    assert body["abstention"]["selective"] is None and any("failed verification" in w for w in body["warnings"])


def test_subgroups_count_patients_not_bags():
    from dermpath.ml.evaluation import build_evaluation

    body = build_evaluation(_run(), "val", _preds(), [])
    sg = body["subgroups"]
    assert sg["count_unit"] == "patients" and sg["min_patients"] == 5
    rows = {(r["key"], r["value"]): r for r in sg["rows"]}
    c = rows[("scanner_id", "scanner-c")]  # 3 bags from 2 patients
    assert c["n_bags"] == 3 and c["n_patients"] == 2 and c["status"] == "insufficient_evidence"
    assert c["metrics"] is None and "2 patient(s)" in c["reason"]
    a = rows[("scanner_id", "scanner-a")]
    assert a["status"] == "ok" and a["n_patients"] >= 5 and a["metrics"]["sensitivity"]["denominator"] >= 1
    assert rows[("stain_batch", None)]["status"] == "not_recorded"


def test_failure_taxonomy_counts_and_categories():
    from dermpath.ml.evaluation import build_evaluation

    preds = _preds()
    body = build_evaluation(_run(), "val", preds, [])
    fa = body["failure_analysis"]
    y, s = _yp(preds)
    n_err = int(((s >= 0.5) != (y == 1)).sum())
    assert fa["n_errors"] == n_err == body["confusion"]["fp"] + body["confusion"]["fn"]
    assert set(fa["counts"]) >= {"near_threshold", "confident_error", "artifact_associated", "small_lesion",
                                 "possible_label_error", "domain_shift", "mimic_category", "uncategorised"}
    assert all(e["categories"] for e in fa["errors"])
    for e in fa["errors"]:
        assert e["reference"] in ("bcc_present", "bcc_absent_not_benign")
    # Errors are listed false negatives first.
    kinds = [e["error_type"] for e in fa["errors"]]
    assert kinds == sorted(kinds, key=lambda k: k != "false_negative")
    assert fa["not_assessable"]["small_lesion"]["n"] == fa["n_false_negatives"]  # no expert outline → not guessed


def test_tuning_set_flag_and_unvalidated_threshold():
    from dermpath.ml.evaluation import build_evaluation

    preds = _preds()
    val = build_evaluation(_run(), "val", preds, [])
    assert val["tuning_set"] is True and val["operating_point"]["tuning_set"] is True
    assert val["metrics"]["sensitivity"]["tuning_set"] is True and val["metrics"]["auroc"]["threshold_dependent"] is False
    assert val["tuning_set_note"] == "optimistic: the threshold was chosen on these data"
    assert any(w.startswith("tuning set") for w in val["warnings"])
    test = build_evaluation(_run(), "test", _preds(split="test"), [])
    assert test["tuning_set"] is False and test["metrics"]["sensitivity"]["tuning_set"] is False
    oof = build_evaluation(_run(evaluation_protocol="dev_cv", threshold_json={"selected_on": "oof",
                                                                            "selection_status": "selected"}),
                           "oof", _preds(split="oof"), [])
    assert oof["tuning_set"] is True and oof["evaluation_protocol"] == "dev_cv"
    fb = build_evaluation(_run(threshold_json={"selected_on": "val", "selection_status": "insufficient_evidence",
                                               "reason": "3 positive patients < 10"}), "val", preds, [])
    assert fb["tuning_set"] is False and any(w.startswith("threshold_unvalidated") for w in fb["warnings"])
    with pytest.raises(ValueError):
        build_evaluation(_run(threshold_value=None), "val", preds, [])


def _benign_mentions_are_negated(text: str) -> bool:
    for m in re.finditer(r"benign", text, re.IGNORECASE):
        window = text[max(0, m.start() - 40):m.start()]
        if not re.search(r"\b(not|never)\b|not_", window, re.IGNORECASE):
            return False
    return True


def test_bcc_absent_is_never_rendered_as_benign():
    from dermpath.ml.evaluation import build_evaluation

    body = build_evaluation(_run(), "val", _preds(), UNSCORED)
    assert body["classes"]["negative"]["value"] == "bcc_absent_not_benign"
    assert "NOT the same as benign" in body["classes"]["negative"]["display"]
    assert "never rendered as benign" in body["classes"]["negative"]["note"]
    text = json.dumps(body)
    assert "benign" in text and _benign_mentions_are_negated(text)
    assert not _benign_mentions_are_negated('{"predicted": "benign"}')  # the checker itself works


def test_failure_contexts_read_disagreements_and_expert_outlines(env, ids):
    from dermpath.auth import Actor
    from dermpath.db import session_scope
    from dermpath.labels import create_expert_label
    from dermpath.ml.evaluation import failure_contexts, lesion_areas_um2
    from dermpath.models import AnnotationVersion, Disagreement, Slide, new_id

    from ml_engine_fakes import cohort_dv, make_engine_run

    path = Actor("user-pathologist", "pathologist", "Dr")
    with session_scope() as db:
        run, _ = make_engine_run(db, cohort_dv(db, ids))
        from sqlalchemy import select

        from dermpath.ml.models import Prediction

        preds = db.scalars(select(Prediction).where(Prediction.run_id == run.id)).all()
        disputed, outlined = preds[0], preds[1]
        db.add(Disagreement(project_id=run.project_id, scope="slide", target_id=disputed.slide_ids_json[0],
                            slide_id=disputed.slide_ids_json[0], label_version_ids_json=[],
                            values_json=["bcc_absent_not_benign", "bcc_present"], status="resolved_by_agreement"))
        sid = outlined.slide_ids_json[0]
        ann_id = new_id()
        ring = [[0, 0], [100, 0], [100, 50], [0, 50], [0, 0]]
        db.add(AnnotationVersion(annotation_id=ann_id, version=1, project_id=run.project_id, slide_id=sid,
                                 geometry_type="polygon", geometry_json={"type": "Polygon", "coordinates": [ring]},
                                 label="lesion", author_id="user-pathologist"))
        db.flush()
        create_expert_label(db, path, db.get(Slide, sid), scope="region", target_id=ann_id, value="bcc_present",
                            reason="outline")
        contexts, domain = failure_contexts(db, run, preds, cohort_dv(db, ids).manifest_json)
        assert contexts[disputed.bag_id]["reader_disagreement"] is True  # any disagreement on record
        assert contexts[outlined.bag_id]["reader_disagreement"] is False
        assert contexts[outlined.bag_id]["lesion_area_um2"] is None  # synthetic slides have no physical scale
        assert lesion_areas_um2(db, run.project_id, [sid], "bcc_present", {sid: (0.5, 0.5)}) == {sid: 1250.0}
        assert lesion_areas_um2(db, run.project_id, [sid], "bcc_absent_not_benign", {sid: (0.5, 0.5)}) == {}
        assert set(domain) == {"scanner_ids", "site_ids", "splits"} and domain["splits"] == ["train"]
        db.rollback()
