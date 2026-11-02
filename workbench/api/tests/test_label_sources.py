"""Label sources and reference standards (imported_reference labels, contract D of the ML engine upgrade).

* ``labels.label_source_permitted(source, reference_standard)``: expert accepts only expert labels, imported_reference
  only imported reference labels; model suggestions and unknown values are never permitted.
* Imported reference labels are importer-only, never expert opinions, never on demo_synthetic slides, idempotent,
  and never changed silently.
* A dataset declares ``reference_standard``; ``expert`` is the default and ignores imported labels. A dataset with
  ``imported_reference`` freezes with the standard and the label provenance recorded in its manifest.
"""

from __future__ import annotations

import csv
import io

import pytest

from dermpath.auth import Actor
from dermpath.db import session_scope
from dermpath.errors import ApiError
from dermpath.labels import (
    create_expert_label,
    create_imported_reference_label,
    label_dict,
    label_source_permitted,
    open_disagreement,
    reference_label,
)
from dermpath.models import LabelVersion, Project, Slide

PID = "proj-bcc-demo"
LEAD = Actor("user-research-lead", "research_lead", "Priya Navarro")
PATHOLOGIST = Actor("user-pathologist", "pathologist", "Dr. Imani Castell")
PATHOLOGIST_2 = Actor("user-pathologist-2", "pathologist", "Dr. Tomas Lindqvist")
PROVENANCE = "Test import (fictional): rule-based extraction from reports of an external dataset"


@pytest.mark.parametrize("source, standard, permitted", [
    ("expert", "expert", True),
    ("imported_reference", "expert", False),
    ("model_suggestion", "expert", False),
    ("expert", "imported_reference", False),
    ("imported_reference", "imported_reference", True),
    ("model_suggestion", "imported_reference", False),
    ("expert", None, False),
    ("expert", "", False),
    (None, "expert", False),
    ("expert", "consensus", False),
    ("unknown", "imported_reference", False),
])
def test_label_source_permitted_matrix(source, standard, permitted):
    assert label_source_permitted(source, standard) is permitted


def test_imported_labels_are_importer_only_records_and_never_expert_opinions(env, ids):
    with session_scope() as db:
        synthetic = db.get(Slide, ids["slides"]["p2_a1_l2_pas"])
        with pytest.raises(ApiError) as e:
            create_imported_reference_label(db, slide=synthetic, value="bcc_present", provenance=PROVENANCE)
        assert e.value.code == "imported_label_not_allowed"
        cmu = db.get(Slide, ids["slides"]["cmu_cc0"])
        with pytest.raises(ApiError) as e:
            create_imported_reference_label(db, slide=cmu, value="bcc_present", provenance="  ")
        assert e.value.code == "provenance_required"
        with pytest.raises(ApiError) as e:
            create_imported_reference_label(db, slide=cmu, value="benign", provenance=PROVENANCE)
        assert e.value.code == "invalid_label_value"
        lv, created = create_imported_reference_label(db, slide=cmu, value="bcc_absent_not_benign",
                                                      provenance=PROVENANCE)
        assert created and lv.source == "imported_reference" and lv.author_id is None and lv.reason == PROVENANCE
        assert lv.scope == "slide" and lv.target_id == cmu.id and not lv.is_adjudication
        d = label_dict(lv)
        assert d["display"].startswith("BCC absent") and "NOT the same as benign" in d["display"]
        assert "not an expert read" in d["source_display"]
        again, created = create_imported_reference_label(db, slide=cmu, value="bcc_absent_not_benign",
                                                         provenance=PROVENANCE)
        assert again.id == lv.id and created is False  # idempotent
        with pytest.raises(ApiError) as e:
            create_imported_reference_label(db, slide=cmu, value="bcc_present", provenance=PROVENANCE)
        assert e.value.code == "imported_label_conflict"  # never changed silently
        new, created = create_imported_reference_label(db, slide=cmu, value="bcc_present", provenance=PROVENANCE,
                                                       supersede_reason="source dataset corrected its label (test)")
        assert created and new.label_id == lv.label_id and new.version == 2 and new.supersedes == lv.id
        # Two experts agreeing never interacts with the imported label; disagreement detection ignores it.
        create_expert_label(db, PATHOLOGIST, cmu, scope="slide", target_id=None, value="bcc_absent_not_benign",
                            reason=None)
        assert open_disagreement(db, PID, "slide", cmu.id) is None
        ref, status = reference_label(db, PID, "slide", cmu.id)
        assert status == "single_reader" and ref.source == "expert" and ref.value == "bcc_absent_not_benign"
        ref, status = reference_label(db, PID, "slide", cmu.id, reference_standard="imported_reference")
        assert status == "imported_reference" and ref.id == new.id and ref.value == "bcc_present"
        with pytest.raises(ValueError):
            reference_label(db, PID, "slide", cmu.id, reference_standard="consensus")
        assert db.query(LabelVersion).filter(LabelVersion.source == "imported_reference").count() == 2


def test_reference_status_is_unlabeled_without_a_label_of_the_standard(env, ids):
    with session_scope() as db:
        cmu = db.get(Slide, ids["slides"]["cmu_cc0"])
        assert reference_label(db, PID, "slide", cmu.id) == (None, "unlabeled")
        assert reference_label(db, PID, "slide", cmu.id, reference_standard="imported_reference") == (None, "unlabeled")
        expert_only = db.get(Slide, ids["slides"]["p1_a1_l2"])
        assert reference_label(db, PID, "slide", expert_only.id,
                               reference_standard="imported_reference") == (None, "unlabeled")


def test_dataset_config_records_the_reference_standard(env):
    from dermpath.datasets import normalise_config

    with session_scope() as db:
        project = db.get(Project, PID)
        assert normalise_config(project, {})["reference_standard"] == "expert"
        cfg = normalise_config(project, {"reference_standard": "imported_reference",
                                         "eligible_review_states": ["imported", "approved"]})
        assert cfg["reference_standard"] == "imported_reference"
        assert cfg["eligible_review_states"] == ["approved", "imported"]
        with pytest.raises(ApiError) as e:
            normalise_config(project, {"reference_standard": "consensus"})
        assert e.value.code == "invalid_reference_standard" and e.value.status == 422
        # Unreviewed ('imported') slides never enter an expert-reference dataset.
        with pytest.raises(ApiError) as e:
            normalise_config(project, {"eligible_review_states": ["imported"]})
        assert e.value.code == "review_state_requires_imported_reference"
        assert "public_licensed" in normalise_config(project, {})["include_provenance"]


def _imported_cmu(db, ids, value="bcc_absent_not_benign") -> Slide:
    cmu = db.get(Slide, ids["slides"]["cmu_cc0"])
    assert cmu.provenance == "public_cc0" and cmu.ingest_status == "succeeded" and cmu.review_state == "imported"
    create_imported_reference_label(db, slide=cmu, value=value, provenance=PROVENANCE)
    return cmu


def test_default_dataset_ignores_imported_labels(env, ids):
    from dermpath.datasets import create_draft, slide_eligibility, staleness
    from dermpath.review import set_review_state

    with session_scope() as db:
        cmu = _imported_cmu(db, ids)
        set_review_state(db, None, cmu, "approved", reason=None, system=True)
        project = db.get(Project, PID)
        dv = create_draft(db, LEAD, project, name="expert-default", config={"include_provenance": ["public_cc0"]})
        assert dv.config_json["reference_standard"] == "expert"
        (excluded,) = [e for e in dv.exclusions_json if e["slide_id"] == cmu.id]
        reasons = excluded["reasons"]
        assert [r["code"] for r in reasons] == ["no_reference_label_slide"]
        assert "imported reference label exists" in reasons[0]["detail"]
        ok, reasons, ref, _ = slide_eligibility(db, cmu, dv.config_json)
        assert not ok and ref is None
        assert staleness(db, dv)["reference_standard"] == "expert"


def test_imported_reference_dataset_freezes_and_records_the_standard(env, ids):
    from dermpath.datasets import create_draft, export_csv, freeze, staleness, training_eligible_items

    with session_scope() as db:
        cmu = _imported_cmu(db, ids)
        # A workbench expert reads the slide differently: recorded as a review candidate, the reference is unchanged.
        create_expert_label(db, PATHOLOGIST, cmu, scope="slide", target_id=None, value="bcc_present", reason=None)
        project = db.get(Project, PID)
        dv = create_draft(db, LEAD, project, name="imported-ref", config={
            "include_provenance": ["public_cc0"], "reference_standard": "imported_reference",
            "eligible_review_states": ["imported", "pending_review", "approved"],
            "split": {"partition": "random", "seed": 0}})
        assert cmu.id not in {e["slide_id"] for e in dv.exclusions_json}
        assert dv.config_json["reference_standard"] == "imported_reference"
        freeze(db, LEAD, dv, reason="single public slide; class_absent acknowledged (test)",
               acknowledge_warnings=True)
        m = dv.manifest_json
        assert m["config"]["reference_standard"] == "imported_reference" and m["reference_standard"] == "imported_reference"
        assert m["data_mode"] == "real"
        (item,) = m["items"]
        assert item["label_source"] == "imported_reference" and item["label_value"] == "bcc_absent_not_benign"
        lp = m["label_provenance"]
        assert lp["label_sources"] == {"imported_reference": 1} and lp["items_with_label_source_not_permitted"] == []
        assert lp["accepted_label_sources"] == ["imported_reference"] and "not expert reads" in lp["notice"]
        assert lp["provenance_texts"] == [{"provenance": PROVENANCE, "items": 1}]
        assert lp["expert_reads_differing_from_imported"]["count"] == 1
        assert lp["expert_reads_differing_from_imported"]["items"][0]["expert_values"] == ["bcc_present"]
        assert m["public_dataset"] is None  # public_cc0, not public_licensed
        # The training-label check (contract D) accepts these labels only under the manifest's standard.
        items = training_eligible_items(db, dv, "test_evaluation") + training_eligible_items(db, dv, "train")
        for it in items:
            src = db.get(LabelVersion, it["label_version_id"]).source
            assert label_source_permitted(src, m["config"].get("reference_standard", "expert"))
            assert not label_source_permitted(src, "expert")
        assert staleness(db, dv)["stale"] is False
        lines = export_csv(dv).splitlines()
        assert any(ln.startswith("# reference_standard=imported_reference") for ln in lines)
        rows = list(csv.DictReader(io.StringIO("\n".join(ln for ln in lines if not ln.startswith("#")))))
        assert rows[0]["label_source"] == "imported_reference"


def test_frozen_expert_manifest_records_expert_standard(env, ids):
    from dermpath.datasets import create_draft, freeze

    with session_scope() as db:
        project = db.get(Project, PID)
        dv = create_draft(db, LEAD, project, name="expert", config={"include_provenance": ["demo_synthetic"],
                                                                    "split": {"partition": "random", "seed": 1}})
        freeze(db, LEAD, dv, reason="test", acknowledge_warnings=True)
        m = dv.manifest_json
        assert m["config"]["reference_standard"] == "expert" and m["reference_standard"] == "expert"
        lp = m["label_provenance"]
        assert set(lp["label_sources"]) == {"expert"} and lp["notice"] is None
        assert "provenance_texts" not in lp and lp["items_with_label_source_not_permitted"] == []
