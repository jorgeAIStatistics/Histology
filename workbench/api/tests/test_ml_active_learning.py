"""Active learning (design §9): the pool holds development-eligible slides only (QC-eligible, the run's data mode,
never a val/test/sealed patient, no reference label or an open reader disagreement, never proposed before);
candidates are scored out-of-sample through the bundle; selection mixes uncertainty, patient-aware k-centre
diversity (at most one slide per patient per batch) and random; proposals are persisted and never create labels."""

from __future__ import annotations

import hashlib

import numpy as np
import pytest
from sqlalchemy import func, select

from ml_engine_fakes import CID, LEAD, cohort_dv, install_fakes, make_engine_run, run_jobs

# --------------------------------------------------------------------------- selection (pure)


def _cands(n_patients=5, per_patient=3, *, scored=True, seed=0):
    rng = np.random.default_rng(seed)
    out = []
    for p in range(n_patients):
        for j in range(per_patient):
            c = {"slide_id": f"s{p}{j}", "coded_patient_id": f"pt{p}", "pool_reason": "no_reference_label",
                 "family_split": "train", "patient_in_training_set": True}
            if scored:
                c["margin"] = float(rng.uniform(0, 1))
                c["embedding"] = rng.normal(size=4)
            out.append(c)
    return out


def test_at_most_one_slide_per_patient_per_batch_whatever_the_strategy():
    from dermpath.ml.active_learning import select_batch

    for rf, uf in ((0.0, 1.0), (0.0, 0.0), (1.0, 0.5), (0.3, 0.5)):
        picks, info = select_batch(_cands(), k=12, random_fraction=rf, uncertainty_fraction=uf, seed=4)
        patients = [p["coded_patient_id"] for p in picks]
        assert len(patients) == len(set(patients)) == 5  # capped by distinct patients
        assert info["limit"]["k_effective"] == 5 and info["limit"]["rule"] == "at most one slide per patient per batch"
        assert [p["rank"] for p in picks] == [1, 2, 3, 4, 5]
        assert all("embedding" not in p for p in picks)


def test_uncertainty_takes_the_smallest_margins_of_distinct_patients():
    from dermpath.ml.active_learning import select_batch

    cands = _cands(n_patients=4, per_patient=2, scored=False)
    margins = {"s00": 0.01, "s01": 0.02, "s10": 0.5, "s11": 0.03, "s20": 0.9, "s21": 0.8, "s30": 0.4, "s31": 0.7}
    for c in cands:
        c["margin"] = margins[c["slide_id"]]
    picks, info = select_batch(cands, k=3, random_fraction=0.0, uncertainty_fraction=1.0, seed=0)
    assert [p["slide_id"] for p in picks] == ["s00", "s11", "s30"]  # s01 skipped: same patient as s00
    assert all(p["strategy"] == "uncertainty" for p in picks)
    assert picks[0]["components"]["uncertainty"] == pytest.approx(0.99)


def test_diversity_is_k_centre_on_embeddings():
    from dermpath.ml.active_learning import select_batch

    centres = {"a": np.array([10.0, 0, 0]), "b": np.array([0, 10.0, 0]), "c": np.array([0, 0, 10.0])}
    cands = []
    for i, (name, ctr) in enumerate(sorted(centres.items())):
        for j in range(3):
            cands.append({"slide_id": f"{name}{j}", "coded_patient_id": f"pt-{name}{j}", "margin": None,
                          "embedding": ctr + 0.01 * j, "pool_reason": "no_reference_label", "family_split": "train",
                          "patient_in_training_set": False})
    picks, info = select_batch(cands, k=3, random_fraction=0.0, uncertainty_fraction=0.0, seed=1)
    assert {p["slide_id"][0] for p in picks} == {"a", "b", "c"}  # one per cluster
    assert all(p["strategy"] == "diversity" for p in picks) and info["shortfall_filled_at_random"]["uncertainty"] == 0
    assert picks[1]["components"]["measured_as"] == "distance to the batch already selected"


def test_random_share_and_shortfalls_are_reported_and_seeded():
    from dermpath.ml.active_learning import select_batch

    unscored = _cands(n_patients=8, per_patient=1, scored=False)
    picks, info = select_batch(unscored, k=4, random_fraction=0.25, seed=7)
    assert info["composition"] == {"uncertainty": 0, "diversity": 0, "random": 4}
    assert info["shortfall_filled_at_random"] == {"uncertainty": 2, "diversity": 1}
    again, _ = select_batch(unscored, k=4, random_fraction=0.25, seed=7)
    assert [p["slide_id"] for p in again] == [p["slide_id"] for p in picks]
    mixed, info = select_batch(_cands(n_patients=10, per_patient=1), k=8, random_fraction=0.25, seed=2)
    assert info["composition"] == {"uncertainty": 3, "diversity": 3, "random": 2}
    with pytest.raises(ValueError):
        select_batch(unscored, k=2, random_fraction=1.5)


# --------------------------------------------------------------------------- pool (database)


def _add_slide(db, *, block_id, project_id=CID, provenance="demo_synthetic", image_kind="synthetic_tiles", tag=""):
    from dermpath.db import utcnow
    from dermpath.models import Slide, new_id

    sid = new_id()
    db.add(Slide(id=sid, project_id=project_id, block_id=block_id, level_index=9, provenance=provenance,
                 image_kind=image_kind, object_key=f"projects/{project_id}/slides/{sid}/synthetic_spec.json",
                 sha256=hashlib.sha256(f"{sid}{tag}".encode()).hexdigest(), format="synthetic_procedural",
                 width=8192, height=6144, levels=1, level_dimensions_json=[[8192, 6144]], level_downsamples_json=[1.0],
                 ingest_status="succeeded", ingested_at=utcnow(), created_by=LEAD))
    db.flush()
    return sid


def _setup_pool(db, ids):
    """Unlabelled slides for a train, a val, a test and a brand-new patient; a disputed train slide; a real slide."""
    from dermpath.models import Block, Case, CodedPatient, Disagreement, Slide, SpecimenPart

    dv = cohort_dv(db, ids)
    items = dv.manifest_json["items"]
    by_split = {}
    for it in sorted(items, key=lambda r: r["slide_id"]):
        by_split.setdefault(it["split"], it)
    added = {}
    for split, it in by_split.items():
        block = db.get(Slide, it["slide_id"]).block_id
        added[split] = _add_slide(db, block_id=block, tag=split)
    pt = CodedPatient(project_id=CID, code="SYN-9001", created_by=LEAD)
    db.add(pt)
    db.flush()
    case = Case(project_id=CID, coded_patient_id=pt.id, accession_code="SYN-C26-9001", provenance="demo_synthetic",
                created_by=LEAD)
    db.add(case)
    db.flush()
    part = SpecimenPart(project_id=CID, case_id=case.id, designation="A")
    db.add(part)
    db.flush()
    block = Block(project_id=CID, part_id=part.id, designation="A1")
    db.add(block)
    db.flush()
    added["new"] = _add_slide(db, block_id=block.id, tag="new")
    added["new_patient_id"] = pt.id
    added["real"] = _add_slide(db, block_id=block.id, provenance="public_cc0", image_kind="wsi", tag="real")
    train_items = [it for it in items if it["split"] == "train"]
    disputed = train_items[-1]["slide_id"]
    db.add(Disagreement(project_id=CID, scope="slide", target_id=disputed, slide_id=disputed,
                        label_version_ids_json=[], values_json=["bcc_absent_not_benign", "bcc_present"],
                        status="open"))
    db.flush()
    added["disputed"] = disputed
    return dv, added


def test_pool_is_development_eligible_only(env, ids, monkeypatch):
    install_fakes(monkeypatch)
    from dermpath.db import session_scope
    from dermpath.ml.active_learning import development_pool

    with session_scope() as db:
        dv, added = _setup_pool(db, ids)
        run, _ = make_engine_run(db, dv)
        cands, excluded = development_pool(db, run, dv)
        got = {c["slide_id"]: c for c in cands}
        assert set(got) == {added["train"], added["new"], added["disputed"]}
        assert got[added["new"]]["family_split"] == "new_to_family"
        assert got[added["new"]]["patient_in_training_set"] is False
        assert got[added["train"]]["patient_in_training_set"] is True
        assert got[added["disputed"]]["pool_reason"] == "open_reader_disagreement"
        assert got[added["train"]]["pool_reason"] == "no_reference_label"
        assert excluded["test_patient"] >= 1 and excluded["validation_patient"] >= 1
        assert excluded["other_data_mode"] == 1 and excluded["has_reference_label"] > 0
        # Sealing (a test release) keeps them out too; nothing in the pool is a test or val patient.
        from dermpath.auth import Actor
        from dermpath.datasets import seal_test_patients

        seal_test_patients(db, dv, "test release", Actor(LEAD, "research_lead", "Lead"))
        cands2, excluded2 = development_pool(db, run, dv)
        assert {c["slide_id"] for c in cands2} == set(got) and excluded2["sealed_test_patient"] >= 1
        test_patients = {s["coded_patient_id"] for s in dv.manifest_json["splits"] if s["split"] in ("val", "test")}
        assert not ({c["coded_patient_id"] for c in cands2} & test_patients)
        db.rollback()


def test_batch_is_persisted_never_labels_and_excludes_previous_proposals(clients, ids, monkeypatch):
    calls = install_fakes(monkeypatch)
    from dermpath.db import session_scope
    from dermpath.ml.engine_models import ALProposal, InferencePrediction
    from dermpath.models import LabelVersion

    with session_scope() as db:
        dv, added = _setup_pool(db, ids)
        run, _ = make_engine_run(db, dv)
        rid, dv_id = run.id, dv.id
        n_labels = db.scalar(select(func.count(LabelVersion.id)))
    lead = clients(LEAD)
    url = f"/api/v1/projects/{CID}/active-learning"
    r = lead.post(url, json={"run_id": rid, "k": 2})
    assert r.status_code == 409 and r.json()["error"]["code"] == "bundle_required"
    lead.post(f"/api/v1/experiments/{rid}/register")
    assert clients("user-pathologist").post(url, json={"run_id": rid, "k": 2}).status_code == 403
    r = lead.post(url, json={"run_id": rid, "dataset_version_id": dv_id, "k": 2, "random_fraction": 0.5, "seed": 3})
    assert r.status_code == 202, r.text
    first = r.json()
    assert first["pool_size"] == 3 and first["creates_labels"] is False and first["pool"] == "development_eligible"
    assert first["synthetic"] is True and first["pool_exclusions"]["test_patient"] >= 1
    out = run_jobs(["active_learning"])
    assert [o.status for o in out] == ["succeeded"], [o.error for o in out]
    batch = lead.get(f"/api/v1/active-learning/batches/{first['batch_id']}").json()
    assert batch["status"] == "succeeded" and len(batch["items"]) == 2 and batch["creates_labels"] is False
    # A pipeline-test bundle cannot score unlabelled slides: the batch says so and is random only.
    assert batch["composition"] == {"uncertainty": 0, "diversity": 0, "random": 2}
    assert "label" in batch["result"]["unscorable_reason"] and calls.extract == []
    proposed = [i["slide_id"] for i in batch["items"]]
    assert set(proposed) <= {added["train"], added["new"], added["disputed"]}
    assert len({i["coded_patient_id"] for i in batch["items"]}) == 2
    with session_scope() as db:
        assert db.scalar(select(func.count(ALProposal.id)).where(ALProposal.batch_id == first["batch_id"])) == 2
        assert db.scalar(select(func.count(LabelVersion.id))) == n_labels
        assert db.scalar(select(func.count(InferencePrediction.id))) == 0
    # Previously proposed slides are excluded from the next pool.
    second = lead.post(url, json={"run_id": rid, "k": 5}).json()
    assert second["pool_size"] == 1 and second["pool_exclusions"]["previously_proposed"] == 2
    run_jobs(["active_learning"])
    b2 = lead.get(f"/api/v1/active-learning/batches/{second['batch_id']}").json()
    assert [i["slide_id"] for i in b2["items"]] == sorted({added["train"], added["new"], added["disputed"]} - set(proposed))
    listed = lead.get(f"/api/v1/projects/{CID}/active-learning?run_id={rid}").json()["items"]
    assert {b["batch_id"] for b in listed} == {first["batch_id"], second["batch_id"]}
    # Guards: another project's dataset, a mismatching dataset version.
    other = ids["ml_demo"]["workflow"]["dataset_version_id"]
    assert lead.post(url, json={"run_id": rid, "dataset_version_id": other, "k": 1}).status_code == 404


def test_candidates_are_scored_out_of_sample_through_the_bundle(clients, ids, monkeypatch):
    """Scoring path: a real-mode bundle scores each candidate label-free (inference predictions) and the batch
    mixes uncertainty, diversity and random."""
    calls = install_fakes(monkeypatch)
    from dermpath.db import session_scope
    from dermpath.ml import active_learning
    from dermpath.ml.engine_models import ALProposal, InferencePrediction
    from dermpath.models import Slide

    with session_scope() as db:
        dv = cohort_dv(db, ids)
        run, _ = make_engine_run(db, dv, mode="supervised_experiment", encoder_id="handcrafted-stain-texture-v1",
                                 weights_sha256="handcrafted:test")
        rid = run.id
        block = db.get(Slide, dv.manifest_json["items"][0]["slide_id"]).block_id
        real = [_add_slide(db, block_id=block, provenance="public_cc0", image_kind="wsi", tag=f"r{i}")
                for i in range(8)]
    fake_pool = [{"slide_id": s, "coded_patient_id": f"pt-real-{i}", "patient_code": None, "case_id": None,
                  "pool_reason": "no_reference_label", "family_split": "new_to_family",
                  "patient_in_training_set": False} for i, s in enumerate(sorted(real))]
    monkeypatch.setattr(active_learning, "development_pool", lambda db, run, dv: (list(fake_pool), {}))
    lead = clients(LEAD)
    lead.post(f"/api/v1/experiments/{rid}/register")
    r = lead.post(f"/api/v1/projects/{CID}/active-learning", json={"run_id": rid, "k": 6, "random_fraction": 0.34})
    assert r.status_code == 202 and r.json()["pool_size"] == 8
    out = run_jobs(["active_learning"])
    assert [o.status for o in out] == ["succeeded"], [o.error for o in out]
    batch = lead.get(f"/api/v1/active-learning/batches/{r.json()['batch_id']}").json()
    assert batch["composition"] == {"uncertainty": 2, "diversity": 2, "random": 2}
    assert len(calls.extract) == 8 and all(c["input_snapshot"] is None for c in calls.extract)
    unc = [i for i in batch["items"] if i["strategy"] == "uncertainty"]
    assert all(i["components"]["model_score"] is not None and i["uncertainty"] is not None for i in unc)
    assert all(i["components"]["inference_prediction_id"] for i in batch["items"])
    with session_scope() as db:
        assert db.scalar(select(func.count(InferencePrediction.id))) == 8  # label-free research outputs
        rows = db.scalars(select(ALProposal).where(ALProposal.run_id == rid)).all()
        assert sorted(r_.proposal_rank for r_ in rows) == list(range(1, 7))


# --------------------------------------------------------------------------- review priorities


def test_review_priorities_rank_disagreements_and_development_discordances_and_resolve_nothing(clients, ids,
                                                                                               monkeypatch):
    install_fakes(monkeypatch)
    from dermpath.auth import Actor
    from dermpath.datasets import seal_test_patients
    from dermpath.db import session_scope
    from dermpath.ml.models import Prediction
    from dermpath.models import Disagreement, LabelVersion

    with session_scope() as db:
        dv = cohort_dv(db, ids)
        run, _ = make_engine_run(db, dv, store_val=False)
        items = sorted(dv.manifest_json["items"], key=lambda r: r["slide_id"])
        train = [it for it in items if it["split"] == "train"]
        test = [it for it in items if it["split"] == "test"]
        a, b, c, d, e = train[:5]
        f = test[0]

        def pred(it, split, label, score):
            return Prediction(run_id=run.id, project_id=CID, split=split, bag_kind="slide", bag_id=it["slide_id"],
                              slide_ids_json=[it["slide_id"]], case_id=it["case_id"],
                              coded_patient_id=it["coded_patient_id"], patient_code=it["patient_code"],
                              label_value="bcc_present" if label else "bcc_absent_not_benign",
                              label_version_ids_json=[], label=label, score=score, threshold=0.5,
                              predicted=int(score >= 0.5), abstained=False, attributes_json={},
                              feature_artifact_ids_json=[])

        db.add_all([pred(a, "val", 0, 0.95),  # confident false positive + reader disagreement: tier 1
                    pred(b, "val", 0, 0.2),  # correct; reader disagreement only: tier 2
                    pred(c, "val", 1, 0.05),  # confident false negative: tier 3
                    pred(d, "val", 1, 0.45),  # near-threshold false negative: tier 4
                    pred(e, "train", 0, 0.99),  # in-sample: never used
                    pred(f, "test", 0, 0.97),  # test: never used
                    pred(f, "val", 0, 0.96)])  # a sealed (test) patient: left out
        for it in (a, b):
            db.add(Disagreement(project_id=CID, scope="slide", target_id=it["slide_id"], slide_id=it["slide_id"],
                                label_version_ids_json=[], values_json=["bcc_absent_not_benign", "bcc_present"],
                                status="open"))
        seal_test_patients(db, dv, "test release", Actor(LEAD, "research_lead", "Lead"))
        rid = run.id
        n_labels = db.scalar(select(func.count(LabelVersion.id)))
        ids_ = {k: it["slide_id"] for k, it in zip("abcdef", (a, b, c, d, e, f))}
    assert clients("user-assistant").get(f"/api/v1/projects/{CID}/review-priorities").status_code == 403
    body = clients("user-director").get(f"/api/v1/projects/{CID}/review-priorities?run_id={rid}").json()
    assert body["resolves_automatically"] is False and "Nothing is resolved" in body["notice"]
    order = [(i["target"]["target_id"], i["tier"]) for i in body["items"]]
    mine = [x for x in order if x[0] in ids_.values()]
    assert mine == [(ids_["a"], 1), (ids_["b"], 2), (ids_["c"], 3), (ids_["d"], 4)]
    assert [i["rank"] for i in body["items"]] == list(range(1, len(body["items"]) + 1))
    tiers = [i["tier"] for i in body["items"]]
    assert tiers == sorted(tiers)
    targets = {i["target"]["target_id"] for i in body["items"]}
    assert ids_["e"] not in targets and ids_["f"] not in targets  # never train (in-sample), never test or sealed
    assert body["excluded"]["sealed_patient_discordances"] == 1
    first = body["items"][0]
    assert first["reader_disagreement"]["values"] == ["bcc_absent_not_benign", "bcc_present"]
    disc = first["model_discordances"][0]
    assert disc["confident"] is True and disc["error_type"] == "false_positive" and first["resolved"] is False
    assert disc["reference"] == "bcc_absent_not_benign" and "NOT the same as benign" in disc["reference_display"]
    third = next(i for i in body["items"] if i["target"]["target_id"] == ids_["c"])
    assert any("possible label error" in r for r in third["reasons"])
    with session_scope() as db:
        statuses = set(db.scalars(select(Disagreement.status).where(Disagreement.project_id == CID)).all())
        assert statuses == {"open"} and db.scalar(select(func.count(LabelVersion.id))) == n_labels
