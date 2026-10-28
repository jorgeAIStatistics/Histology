"""Adversarial verification, round 2: fold safety and the training protocol (owner's brief items 3 and 7).
Research use only; every record here is fictional.

Each test attacks one guarantee through a realistic path (the API / service, the worker, the ML command line, the
benchmark harness, or the exact protocol functions the worker calls with the inputs it passes). A test FAILS when
the guarantee is violated (a reproduction) and passes, as regression coverage, when it holds.

Guarantees attacked:

* learned preprocessing (the dataset-fitted ``macenko-v1`` reference) never reaches a ``dev_cv`` or learning-curve
  fit, whatever the path (a feature set first built by a holdout run and then reused, the ML command line, the
  benchmark harness);
* a refused benchmark is refused before any work is recorded or any reference is fitted;
* confirmed-duplicate units (union-find, so transitive) stay whole in outer folds, ABMIL inner hold-outs, the
  holdout reference-fit check and the calibration evidence gate, including when the slide that joins two patients
  is outside the scored or included set;
* a holdout head is not silently fitted on a confirmed duplicate of a validation patient (the standard the engine
  already applies to the stain reference);
* the calibration evidence gate counts distinct patient / confirmed-duplicate groups in the worker;
* outer folds are identical across feature sets ("encoders"), heads, training seeds and unscorable bags, and such
  runs are not refused as ``mixed_fold_assignment``;
* ABMIL fit counts (epoch selection vs final refit, learning-curve subsets) are reported accurately.
"""

from __future__ import annotations

import hashlib
import json
import uuid

import numpy as np
from sqlalchemy import func, select

from feature_set_support import HANDCRAFTED, real_cohort
from test_ml_support import CID, FAST, LEAD, SYNTH, cohort, custom_dataset, run_jobs

CODE = "fold_unsafe_preprocessing"
RATIOS = {"train": 0.5, "val": 0.25, "test": 0.25}
MACENKO = {"max_patches_per_slide": 4, "n_boot": 50, "stain_normalization": "macenko-v1"}
POS, NEG = "bcc_present", "bcc_absent_not_benign"
DIM = 8


# =========================================================================== shared helpers


def _params(**kw):
    from dermpath.ml.config import resolve_params

    return resolve_params({"max_epochs": 3, "patience": 2, "n_boot": 50, "hidden_dim": 8, "attn_dim": 4, **kw})


def _items(n_patients=30, *, pos_every=3, val_every=None):
    rows = []
    for i in range(n_patients):
        code = f"V2-{i:03d}"
        rows.append({"slide_id": f"v2slide{i:03d}", "case_id": f"v2case{i:03d}", "coded_patient_id": f"v2pt{i:03d}",
                     "patient_code": code, "accession_code": f"V2A-{i:03d}",
                     "label_value": POS if i % pos_every == 0 else NEG,
                     "slide_sha256": hashlib.sha256(f"{code}|0".encode()).hexdigest(),
                     "label_version_id": uuid.uuid4().hex,
                     "split": "val" if (val_every and i % val_every == 1) else "train",
                     "scanner_id": "s", "site_id": "x", "stain": "H&E"})
    return rows


def _bags(items, *, unscorable=frozenset(), n_instances=6):
    """Bags as the worker builds them; ``unscorable`` patients have no tissue patch in this feature set (the worker's
    ``FeatureSetAccess.describe`` records ``patch_counts`` 0, so ``n_patches`` is 0)."""
    from dermpath.ml.training import build_bags

    bags = build_bags(items, "slide", POS)
    for b in bags:
        if b.patient_id in unscorable:
            b.patch_counts = [0] * len(b.slide_ids)
            continue
        rng = np.random.default_rng(int(b.slide_sha256s[0][:8], 16))
        e = rng.normal(size=(n_instances, DIM)).astype(np.float32)
        e[:, 0] += 1.2 * b.label
        b.embeddings = e
    return bags


def _session():
    from dermpath.db import session_scope

    return session_scope()


def _manifest(dv_id: str) -> dict:
    from dermpath.models import DatasetVersion

    with _session() as db:
        return db.get(DatasetVersion, dv_id).manifest_json


def _run(run_id: str):
    from dermpath.ml.models import TrainingRun

    with _session() as db:
        r = db.get(TrainingRun, run_id)
        db.expunge(r)
        return r


def _service_run(dv_id: str, head: str, *, params: dict, seed: int, protocol: str, project_id: str = CID,
                 encoder: str = SYNTH, feature_set_id: str | None = None) -> str:
    from dermpath.auth import Actor
    from dermpath.ml.service import create_experiment
    from dermpath.models import Project

    with _session() as db:
        run, _ = create_experiment(db, Actor(LEAD, "research_lead", "Priya Navarro"), db.get(Project, project_id),
                                   dataset_version_id=dv_id, encoder_id=encoder, head=head, params=params, seed=seed,
                                   name=None, evaluation_protocol=protocol, feature_set_id=feature_set_id)
        return run.id


def _counts() -> dict:
    from dermpath.ml.engine_models import ComparisonFamily, FeatureSet
    from dermpath.ml.models import TrainingRun
    from dermpath.models import Job

    with _session() as db:
        return {"runs": db.scalar(select(func.count(TrainingRun.id))),
                "feature_sets": db.scalar(select(func.count(FeatureSet.id))),
                "fitted_references": db.scalar(select(func.count(FeatureSet.id))
                                               .where(FeatureSet.stain_reference_key.is_not(None))),
                "families": db.scalar(select(func.count(ComparisonFamily.id))),
                "queued_train_jobs": db.scalar(select(func.count(Job.id)).where(Job.type == "train",
                                                                                Job.status == "queued"))}


def _cli(argv, capsys):
    from dermpath.ml.cli import main

    code = main(argv)
    out = capsys.readouterr()
    return code, out.out, out.err


# --------------------------------------------------------------------------- synthetic cohort with duplicates


def _cid_patients(ids) -> dict:
    """Patient code -> {pid, labels, slides} for every approved slide of the synthetic pipeline-test cohort."""
    items = _manifest(cohort(ids)["dataset_version_id"])["items"]
    pats: dict = {}
    for it in sorted(items, key=lambda r: r["slide_id"]):
        p = pats.setdefault(it["patient_code"], {"pid": it["coded_patient_id"], "labels": set(), "slides": []})
        p["labels"].add(it["label_value"])
        p["slides"].append(it["slide_id"])
    return pats


def _excluded_slide(slide_id: str = "v2-dup-chain-x") -> str:
    """A project slide that no dataset includes (no coded patient / case; never reviewed): for instance a re-scan
    that was reviewed for near-duplicates in an earlier version and is no longer eligible."""
    from dermpath.db import utcnow
    from dermpath.models import Slide

    with _session() as db:
        db.add(Slide(id=slide_id, project_id=CID, provenance="demo_synthetic", image_kind="synthetic_tiles",
                     object_key=f"projects/{CID}/slides/{slide_id}/synthetic_spec.json",
                     sha256=hashlib.sha256(slide_id.encode()).hexdigest(), format="synthetic_procedural",
                     width=8192, height=6144, levels=1, level_dimensions_json=[[8192, 6144]],
                     level_downsamples_json=[1.0], ingest_status="succeeded", ingested_at=utcnow(),
                     created_by="test"))
    return slide_id


def _duplicate(slide_a: str, slide_b: str) -> None:
    from dermpath.models import NearDuplicateReview

    with _session() as db:
        db.add(NearDuplicateReview(project_id=CID, slide_a_id=slide_a, slide_b_id=slide_b, decision="duplicate",
                                   reason="same tissue re-scanned (fictional)", reviewer_id=LEAD))


def _duplicate_dataset(ids, name: str, *, via_excluded_slide: bool) -> dict:
    """Validation holds exactly 5 pure-positive patients (A, B and three others) and 6 pure-negative ones; test 9
    patients; everything else train. A person confirmed A and B as the same material: directly (A~B), or through
    one excluded slide X (A~X and X~B; union-find makes A, X, B one group)."""
    pats = _cid_patients(ids)
    pos = sorted(c for c, p in pats.items() if p["labels"] == {POS})
    neg = sorted(c for c, p in pats.items() if p["labels"] == {NEG})
    a, b = pos[0], pos[1]
    val = set(pos[:5]) | set(neg[:6])
    test = set(pos[5:8]) | set(neg[6:12])
    if via_excluded_slide:
        x = _excluded_slide()
        _duplicate(pats[a]["slides"][0], x)
        _duplicate(x, pats[b]["slides"][0])
    else:
        _duplicate(pats[a]["slides"][0], pats[b]["slides"][0])

    def assign(code, labels):
        return "val" if code in val else "test" if code in test else "train"

    dv = custom_dataset(CID, name, assign)
    m = _manifest(dv)
    decided = {(d["slide_a"], d["slide_b"]) for d in m["near_duplicate_decisions"] if d["decision"] == "duplicate"}
    assert len(decided) == (2 if via_excluded_slide else 1), m["near_duplicate_decisions"]  # setup sanity
    return {"dv": dv, "a": a, "b": b, "pid_a": pats[a]["pid"], "pid_b": pats[b]["pid"], "manifest": m}


# =========================================================================== D1: chains through an unscorable patient


def test_abmil_inner_hold_out_keeps_a_duplicate_chain_through_an_unscorable_patient_whole():
    """A~T and T~B are confirmed duplicates (one unit: the same material). T's slide has no tissue patch in this
    feature set. The worker passes every training bag to ``run_holdout``; it drops T before the head is fitted, and
    the ABMIL inner early-stopping split is drawn on the remaining bags with the context's duplicate pairs. A and B
    must still fall on the same side of the inner split (never one in the inner fit part and one in the inner
    hold-out that selects the epoch count)."""
    from dermpath.ml import heads, training

    items = _items(30, val_every=5)
    a, t, b = "v2pt000", "v2pt003", "v2pt009"  # three training patients (positives; val is i % 5 == 1)
    bags = _bags(items, unscorable={t})
    train = [x for x in bags if x.split == "train"]
    val = [x for x in bags if x.split == "val" and x.n_patches > 0]
    pairs = [(a, t), (t, b)]
    ctx = {"split_salt": "v2-chain", "patient_label_rule": "any_positive", "duplicate_pairs": pairs}
    params = _params()
    scorable = [x for x in train if x.n_patches > 0]
    seed = 0
    for s in range(40):  # the same split function the head calls, with the inputs it receives
        fit, stop, _ = heads.inner_split(scorable, params, split_salt=ctx["split_salt"], seed=s,
                                         duplicate_pairs=pairs)
        sides = ({p.patient_id for p in fit} & {a, b}, {p.patient_id for p in stop} & {a, b})
        if all(sides):
            seed = s
            break
    out = training.run_holdout(train, val, head="abmil", params=params, seed=seed, access=heads.IN_MEMORY,
                               context=ctx)
    held = set(out.summary["epoch_selection"]["holdout_patient_keys"])
    assert t not in {x.patient_id for x in out.fit_bags}  # T really is unscorable here
    assert {a, b} <= {x.patient_id for x in train if x.n_patches > 0}
    # Control: when T is scorable the split sees the chain and keeps A, T and B on one side (for the same seed).
    fit2, stop2, _ = heads.inner_split([x for x in _bags(items) if x.split == "train"], params,
                                       split_salt=ctx["split_salt"], seed=seed, duplicate_pairs=pairs)
    assert {a, t, b} <= {p.patient_id for p in fit2} or {a, t, b} <= {p.patient_id for p in stop2}
    assert len(held & {"V2-000", "V2-009"}) != 1, (
        f"seed {seed}: confirmed duplicates A (V2-000) and B (V2-009), joined through the unscorable patient T, "
        f"were split across the ABMIL inner fit part and the inner hold-out {sorted(held)}")


def test_calibration_gate_counts_a_duplicate_chain_through_an_unscorable_patient_once():
    """Validation scores (what the worker passes: scored bags only) of 5 positive patients, two of which (A and B)
    are one confirmed-duplicate group through T, whose bag is unscorable. Independent positive groups: 4 < 5, so the
    gate must refuse to fit (``insufficient_evidence``). Control: when T is scored too, the gate sees the chain."""
    from dermpath.ml.training import ScoredBag, select_operating_point

    items = _items(30)  # the development (validation) scores of a holdout run
    pos_ids = [f"v2pt{i:03d}" for i in (0, 3, 6, 9, 12, 15)]  # 6 positive patients
    a, t, b = pos_ids[0], pos_ids[1], pos_ids[2]
    keep = set(pos_ids) | {f"v2pt{i:03d}" for i in range(30) if i % 3 != 0}
    bags = [x for x in _bags([it for it in items if it["coded_patient_id"] in keep], unscorable={t})]
    rng = np.random.default_rng(0)
    dev = [ScoredBag(x, float(np.clip(0.5 + 0.3 * (x.label - 0.5) + rng.normal(0, 0.15), 0.01, 0.99)))
           for x in bags if x.n_patches > 0]
    ctx = {"split_salt": "v2-cal", "patient_label_rule": "any_positive", "duplicate_pairs": [(a, t), (t, b)]}
    params = _params(calibration="platt", min_threshold_evidence=1)
    # Control: with T scored too, the gate joins A, T and B (4 positive groups from 6 positive patients).
    full = [ScoredBag(x, 0.4 + 0.2 * x.label) for x in _bags([it for it in items if it["coded_patient_id"] in keep])]
    ctl = select_operating_point(full, params, selected_on="val", context=ctx)["calibration_selection"]
    assert ctl["evidence"]["positive_units"] == 4 and ctl["status"] == "insufficient_evidence", ctl
    sel = select_operating_point(dev, params, selected_on="val", context=ctx)["calibration_selection"]
    # 5 scored positive patients: A, B, and three others; A and B are one group through T.
    assert sel["evidence"]["positive_items"] == 5
    assert sel["evidence"]["positive_units"] == 4 and sel["status"] == "insufficient_evidence", (
        f"gate counted {sel['evidence']['positive_units']} positive groups and status {sel['status']!r}: the "
        f"chain A~T~B through the unscorable patient T was not counted as one group")


# =========================================================================== D7: chains through an excluded slide


def test_dev_cv_folds_keep_a_duplicate_chain_through_an_excluded_slide_whole(env, ids):
    """End to end on a frozen manifest: A~X and X~B are confirmed duplicate decisions in force (recorded in the
    manifest's ``near_duplicate_decisions``); X is a slide that the dataset does not include. A and B are therefore
    the same material (union-find is transitive) and must never sit in different outer folds: a fold model would
    then be fitted on A and score B out-of-fold."""
    from dermpath.ml import training
    from dermpath.ml.config import resolve_params

    d = _duplicate_dataset(ids, "v2 duplicate chain via an excluded slide (folds)", via_excluded_slide=True)
    m = d["manifest"]
    dev_items = [it for it in m["items"] if it["split"] in ("train", "val")]
    assert {d["pid_a"], d["pid_b"]} <= {it["coded_patient_id"] for it in dev_items}
    bags = training.build_bags(dev_items, "slide", POS)
    ctx = training.split_context(m, CID)
    fold_seed = 0
    for s in range(60):  # the worker's own fold function on the manifest's development pool
        folds = training.dev_cv_folds(bags, resolve_params({"cv_folds": 3, "cv_fold_seed": s}), ctx)
        if folds.fold_of[d["pid_a"]] != folds.fold_of[d["pid_b"]]:
            fold_seed = s
            break
    rid = _service_run(d["dv"], "meanpool_logreg", params={**FAST, "cv_folds": 3, "cv_fold_seed": fold_seed,
                                                            "min_threshold_evidence": 5},
                       seed=0, protocol="dev_cv")
    assert [o.status for o in run_jobs()] == ["succeeded"]
    fold_of = _run(rid).metrics_json["protocol"]["cv"]["fold_of_patient_code"]
    assert fold_of[d["a"]] == fold_of[d["b"]], (
        f"cv_fold_seed {fold_seed}: {d['a']} (fold {fold_of[d['a']]}) and {d['b']} (fold {fold_of[d['b']]}) are "
        "joined by confirmed duplicate decisions through an excluded slide, yet were cross-validated in different "
        "outer folds")


def test_calibration_gate_counts_a_duplicate_chain_through_an_excluded_slide_once(env, ids):
    """Worker, holdout, calibration requested: validation has 5 positive patients, two of which (A, B) are one
    confirmed-duplicate group through an excluded slide. 4 independent positive groups < 5: insufficient_evidence."""
    d = _duplicate_dataset(ids, "v2 duplicate chain via an excluded slide (calibration)", via_excluded_slide=True)
    rid = _service_run(d["dv"], "meanpool_logreg", params={**FAST, "calibration": "platt", "min_threshold_evidence": 3},
                       seed=0, protocol="holdout")
    assert [o.status for o in run_jobs()] == ["succeeded"]
    run = _run(rid)
    sel = run.metrics_json["operating_point"]["calibration"]
    assert sel["evidence"]["unit"] == "patient_groups"
    assert sel["evidence"]["positive_units"] == 4 and sel["status"] == "insufficient_evidence", (
        f"positive groups {sel['evidence']['positive_units']}, status {sel['status']!r}, calibration "
        f"{run.calibration_json.get('method')!r}: the chain through the excluded slide was not counted once")


def test_calibration_gate_counts_a_direct_duplicate_pair_once_in_the_worker(env, ids):
    """Regression (worker + real manifest duplicates, not only the pure gate): A~B confirmed directly, both in
    validation among 5 positive patients -> 4 groups -> insufficient_evidence, identity map frozen."""
    d = _duplicate_dataset(ids, "v2 direct duplicate (calibration)", via_excluded_slide=False)
    rid = _service_run(d["dv"], "meanpool_logreg", params={**FAST, "calibration": "platt", "min_threshold_evidence": 3},
                       seed=0, protocol="holdout")
    assert [o.status for o in run_jobs()] == ["succeeded"]
    run = _run(rid)
    sel = run.metrics_json["operating_point"]["calibration"]
    assert sel["evidence"]["positive_units"] == 4 and sel["status"] == "insufficient_evidence", sel
    assert run.calibration_json["method"] == "none"


def test_holdout_reference_check_sees_a_duplicate_chain_through_an_excluded_slide():
    """The holdout fold-safety verification of a macenko reference (``preprocessing_fold_safety`` with the run's
    manifest, called at creation and in the worker): the reference was fitted on train slide s0, whose patient is
    the same material as validation patient p2 through the excluded slide sX (s0~sX, sX~s2 confirmed). The
    reference therefore saw a validation patient's material: fold_unsafe."""
    from dermpath.ml.training import preprocessing_fold_safety

    def item(i, split):
        return {"slide_id": f"s{i}", "coded_patient_id": f"p{i}", "patient_code": f"PT-{i}", "split": split}

    items = [item(0, "train"), item(1, "train"), item(2, "val"), item(3, "test")]
    manifest = {"items": items,
                "splits": [{"coded_patient_id": it["coded_patient_id"], "split": it["split"]} for it in items],
                "near_duplicate_decisions": [
                    {"slide_a": "s0", "slide_b": "sX", "decision": "duplicate", "both_in_dataset": False},
                    {"slide_a": "s2", "slide_b": "sX", "decision": "duplicate", "both_in_dataset": False}]}
    plan = {"method": "macenko-v1", "deferred": True, "reference_fit": {"train_slide_ids": ["s0", "s1"]}}
    out = preprocessing_fold_safety(plan, protocol="holdout", params={}, manifest=manifest)
    assert out["status"] == "fold_unsafe", (out["status"], out.get("held_out_overlap"))
    # Control: the same decision made directly is caught today.
    direct = {**manifest, "near_duplicate_decisions": [{"slide_a": "s0", "slide_b": "s2", "decision": "duplicate"}]}
    assert preprocessing_fold_safety(plan, protocol="holdout", params={}, manifest=direct)["status"] == "fold_unsafe"


def test_holdout_head_is_not_silently_fitted_on_a_confirmed_duplicate_of_a_validation_patient(env, ids):
    """The engine's own standard (``_reference_overlap``: a stain reference fitted on a training slide whose patient
    is a confirmed duplicate of a validation patient is ``fold_unsafe``) applied to the head itself. A person
    confirmed that training patient P and validation patient Q are the same material; the freeze warning
    ``duplicates_across_splits`` was acknowledged (``custom_dataset`` freezes with acknowledge_warnings, as the API
    allows). A holdout run then fits its head on Q's material and tunes threshold / calibration on Q. The run must
    refuse, or at least record the cross-split duplicate in its development results; today it does neither."""
    pats = _cid_patients(ids)
    pos = sorted(c for c, p in pats.items() if p["labels"] == {POS})
    neg = sorted(c for c, p in pats.items() if p["labels"] == {NEG})
    p_code, q_code = pos[0], pos[1]
    val = {q_code} | set(pos[2:6]) | set(neg[:6])
    test = set(pos[6:9]) | set(neg[6:12])
    _duplicate(pats[p_code]["slides"][0], pats[q_code]["slides"][0])
    dv = custom_dataset(CID, "v2 train/val duplicate (acknowledged)",
                        lambda code, labels: "val" if code in val else "test" if code in test else "train")
    m = _manifest(dv)
    split_of = {it["patient_code"]: it["split"] for it in m["items"]}
    assert (split_of[p_code], split_of[q_code]) == ("train", "val")
    rid = _service_run(dv, "meanpool_logreg", params={**FAST, "min_threshold_evidence": 3}, seed=0,
                       protocol="holdout")
    run_jobs()
    run = _run(rid)
    fitted_on_p = bool(set(pats[p_code]["slides"]) & set((run.provenance_json or {}).get("train_bag_ids") or []))
    tuned_on_q = bool(set(pats[q_code]["slides"]) & set((run.provenance_json or {}).get("development_bag_ids") or []))
    met = run.metrics_json or {}
    flagged = any(p_code in json.dumps(met.get(k), default=str) and q_code in json.dumps(met.get(k), default=str)
                  for k in ("val_summary", "protocol", "operating_point", "warnings"))
    assert run.status != "succeeded" or flagged, (
        f"holdout run {run.status}: fitted on {p_code} (train) and tuned on {q_code} (validation), confirmed "
        f"duplicates, with nothing in its development results saying so (head fitted on P: {fitted_on_p}, "
        f"threshold tuned on Q: {tuned_on_q})")


# =========================================================================== D3: reported ABMIL counts


def test_effective_sampling_reports_the_final_heads_own_instance_subsampling():
    """``metrics.effective_sampling`` is "what the final head actually saw". With instance subsampling, its
    ``bag_epochs_subsampled`` must be the final refit's count, not the refit plus the discarded epoch-selection
    model's epochs."""
    from dermpath.ml import heads, training

    bags = _bags(_items(30, val_every=5), n_instances=9)
    train = [x for x in bags if x.split == "train"]
    val = [x for x in bags if x.split == "val"]
    params = _params(max_epochs=4, patience=4, max_instances_per_bag=3)
    ctx = {"split_salt": "v2-sub", "patient_label_rule": "any_positive", "duplicate_pairs": []}
    out = training.run_holdout(train, val, head="abmil", params=params, seed=2, access=heads.IN_MEMORY, context=ctx)
    s = out.summary
    assert s["epoch_selection"]["status"] == "selected"
    final = s["final_fit"]["bag_epochs_subsampled"]
    assert final == len(train) * s["final_fit"]["epochs"]  # every bag has 9 > 3 instances, every epoch
    eff = training.effective_sampling(out.fit_bags, params, s)
    assert eff["instance_subsampling"]["bag_epochs_subsampled"] == final, (
        f"effective_sampling (the final head) reports {eff['instance_subsampling']['bag_epochs_subsampled']} "
        f"subsampled bag-epochs; the final refit subsampled {final} (the rest belong to the discarded "
        f"epoch-selection model: {s['epoch_selection']['bag_epochs_subsampled']})")


def test_dev_cv_abmil_learning_curve_counts_are_accurate_in_the_worker(env, ids):
    """Regression (worker, learning-curve fraction 0.5): every fold model and the final model report the patients
    they were really fitted on; epoch selection splits exactly those; OOF still covers the whole development pool."""
    from dermpath.ml.models import Prediction

    rid = _service_run(cohort(ids)["dataset_version_id"], "abmil",
                       params={**FAST, "cv_folds": 3, "max_epochs": 4, "patience": 2, "train_patient_fraction": 0.5,
                               "subset_repeat": 0, "min_threshold_evidence": 5}, seed=4, protocol="dev_cv")
    assert [o.status for o in run_jobs()] == ["succeeded"]
    run = _run(rid)
    with _session() as db:
        rows = [(p.split, p.coded_patient_id) for p in
                db.scalars(select(Prediction).where(Prediction.run_id == rid)).all()]
    m = run.metrics_json
    t, lc = m["training"], m["protocol"]["learning_curve"]
    train_patients = {p for sp, p in rows if sp == "train"}
    assert t["final_fit"]["patients"] == len(train_patients) == lc["n_patients"]
    sel = t["epoch_selection"]
    assert sel["fit"]["patients"] + sel["holdout"]["patients"] == t["final_fit"]["patients"]
    for f in t["folds"]:
        fs = f["summary"]
        assert fs["final_fit_patients"] == f["fit_patients"] == f["learning_curve"]["n_patients"], f
        assert fs["epoch_selection_fit_patients"] + fs["epoch_selection_holdout_patients"] == f["fit_patients"], f
        assert f["fit_patients"] < f["fit_part_patients"], f  # the fraction really restricted the fold's fit
    dev = {it["coded_patient_id"] for it in _manifest(cohort(ids)["dataset_version_id"])["items"]
           if it["split"] in ("train", "val")}
    assert {p for sp, p in rows if sp == "oof"} == dev


# =========================================================================== fold identity across feature sets


def test_folds_are_identical_across_feature_sets_heads_seeds_and_unscorable_bags(env, ids, clients, monkeypatch):
    """Two feature sets on one manifest (different synthetic_dim: two embedding spaces, as two encoders would give),
    different heads and training seeds, and the second feature set cannot score one development patient. The outer
    folds, the fold identity and the fingerprint are identical, the unscorable patient keeps its fold, and a
    comparison family of the two is never refused as mixed_fold_assignment or fold_unsafe."""
    from dermpath.ml import training

    dv = cohort(ids)["dataset_version_id"]
    base = {**FAST, "cv_folds": 3, "max_epochs": 3, "patience": 2, "min_threshold_evidence": 5}
    a = _service_run(dv, "meanpool_logreg", params=base, seed=0, protocol="dev_cv")
    assert [o.status for o in run_jobs()] == ["succeeded"]
    victim = sorted(it["patient_code"] for it in _manifest(dv)["items"] if it["split"] in ("train", "val"))[3]
    real_describe = training.FeatureSetAccess.describe

    def describe(self, bag):
        real_describe(self, bag)
        if bag.patient_code == victim:
            bag.patch_counts = [0] * len(bag.slide_ids)

    monkeypatch.setattr(training.FeatureSetAccess, "describe", describe)
    b = _service_run(dv, "abmil", params={**base, "synthetic_dim": 32}, seed=11, protocol="dev_cv")
    assert [o.status for o in run_jobs()] == ["succeeded"]
    ra, rb = _run(a), _run(b)
    assert ra.feature_set_id != rb.feature_set_id
    ca, cb = ra.metrics_json["protocol"]["cv"], rb.metrics_json["protocol"]["cv"]
    assert ca["fold_of_patient_code"] == cb["fold_of_patient_code"] and ca["fingerprint"] == cb["fingerprint"]
    assert ra.identity_json["fold_assignment"] == rb.identity_json["fold_assignment"]
    un = [u for u in rb.metrics_json["unscored_bags"] if u.get("patient_code") == victim]
    assert un and all(u["fold"] == ca["fold_of_patient_code"][victim] for u in un)
    lead = clients(LEAD)
    fam = lead.post(f"/api/v1/projects/{CID}/comparison-families", json={"name": "v2 folds", "dataset_version_id": dv})
    assert fam.status_code == 201, fam.text
    for rid in (a, b):
        r = lead.post(f"/api/v1/comparison-families/{fam.json()['id']}/members", json={"run_id": rid})
        assert r.status_code in (200, 201), r.text
    dev = lead.get(f"/api/v1/comparison-families/{fam.json()['id']}?n_boot=50").json()["development_comparison"]
    assert dev.get("code") not in ("mixed_fold_assignment", CODE), dev


# =========================================================================== fold-unsafe preprocessing: other paths


def _write(tmp_path, name: str, cfg: dict) -> str:
    p = tmp_path / name
    p.write_text(json.dumps(cfg))
    return str(p)


def test_cli_run_config_cannot_reuse_a_holdout_macenko_feature_set_for_dev_cv_or_a_learning_curve(env, ids, tmp_path,
                                                                                                  capsys):
    """A holdout macenko run (fold-safe) builds its feature set and fits the reference through the ML command line.
    Reusing that very feature set (by id) for dev_cv, or for a holdout learning-curve point, is refused with
    fold_unsafe_preprocessing; dropping the stain parameter to sneak it in is refused as a feature-set mismatch.
    No run is recorded by any refused call."""
    rc = real_cohort(ids, n=10, project_id="proj-v2-cli", ratios=RATIOS)
    base = {"project_id": rc["project_id"], "dataset_version_id": rc["dataset_version_id"], "encoder_id": HANDCRAFTED,
            "head": "meanpool_logreg", "seed": 0}
    code, out, err = _cli(["run-config", _write(tmp_path, "h.json", {**base, "params": MACENKO,
                                                                     "evaluation_protocol": "holdout"})], capsys)
    assert code == 0, err
    first = json.loads(out)
    assert first["status"] == "succeeded" and first["preprocessing_fold_safety"]["status"] == "fold_safe"
    fs_id = first["feature_set_id"]
    before = _counts()
    assert before["fitted_references"] >= 1
    attempts = {
        "dev_cv": {**base, "params": {**MACENKO, "cv_folds": 3}, "evaluation_protocol": "dev_cv",
                   "feature_set_id": fs_id},
        "learning_curve": {**base, "params": {**MACENKO, "train_patient_fraction": 0.5, "subset_repeat": 0},
                           "evaluation_protocol": "holdout", "feature_set_id": fs_id},
    }
    for name, cfg in attempts.items():
        code, out, err = _cli(["run-config", _write(tmp_path, f"{name}.json", cfg)], capsys)
        assert code == 2 and CODE in err, (name, code, err[-600:])
    sneak = {**base, "params": {"max_patches_per_slide": 4, "n_boot": 50, "cv_folds": 3},
             "evaluation_protocol": "dev_cv", "feature_set_id": fs_id}
    code, out, err = _cli(["run-config", _write(tmp_path, "sneak.json", sneak)], capsys)
    assert code == 2 and "feature_set_mismatch" in err, err[-600:]
    assert _counts()["runs"] == before["runs"]


def _benchmark_cfg(rc: dict, tmp_path, **kw) -> dict:
    return {"name": kw.pop("name"), "project_id": rc["project_id"], "dataset_version_id": rc["dataset_version_id"],
            "execution_mode": "supervised_experiment", "encoders": [HANDCRAFTED], "heads": ["meanpool_logreg"],
            "seeds": [0], "bootstrap": {"n_boot": 50, "min_patients": 2},
            "report_path": str(tmp_path / "bench-report.json"), **kw}


def test_cli_benchmark_refuses_fold_unsafe_preprocessing_before_any_extraction(env, ids, tmp_path, capsys):
    """``python -m dermpath.ml.cli benchmark`` with dev_cv and macenko-v1: the engine refuses the combination. The
    refusal must come before any work: no feature set built (no stain reference fitted on the development pool),
    no comparison family, no run (the driver already prechecks; the benchmark harness should too)."""
    rc = real_cohort(ids, n=10, project_id="proj-v2-bench-cv", ratios=RATIOS)
    before = _counts()
    cfg = _benchmark_cfg(rc, tmp_path, name="v2 fold-unsafe dev_cv benchmark", evaluation_protocol="dev_cv",
                         params={**MACENKO, "cv_folds": 3})
    code, out, err = _cli(["benchmark", _write(tmp_path, "b.json", cfg), "--report",
                           str(tmp_path / "bench-report.json")], capsys)
    assert code == 2 and CODE in err, (code, err[-600:])
    after = _counts()
    assert after["runs"] == before["runs"]
    assert (after["fitted_references"], after["feature_sets"], after["families"]) == (
        before["fitted_references"], before["feature_sets"], before["families"]), (
        f"refused only after building {after['feature_sets'] - before['feature_sets']} feature set(s), fitting "
        f"{after['fitted_references'] - before['fitted_references']} dataset stain reference(s) and creating "
        f"{after['families'] - before['families']} comparison family(ies)")


def test_refused_benchmark_leaves_no_queued_runs_behind(env, ids, tmp_path, capsys):
    """Holdout + macenko-v1 with a learning curve: the full-set grid run is fold-safe, the learning-curve point is
    not. The benchmark is refused; it must not leave the grid run queued (a worker would later train a member of a
    half-created family that no report describes)."""
    rc = real_cohort(ids, n=10, project_id="proj-v2-bench-lc", ratios=RATIOS)
    before = _counts()
    cfg = _benchmark_cfg(rc, tmp_path, name="v2 fold-unsafe learning-curve benchmark", evaluation_protocol="holdout",
                         params=dict(MACENKO), learning_curve={"fractions": [0.5, 1.0], "repeats": 1})
    code, out, err = _cli(["benchmark", _write(tmp_path, "lc.json", cfg), "--report",
                           str(tmp_path / "bench-report.json")], capsys)
    assert code == 2 and CODE in err, (code, err[-600:])
    after = _counts()
    assert after["queued_train_jobs"] == before["queued_train_jobs"] and after["runs"] == before["runs"], (
        f"the refused benchmark left {after['runs'] - before['runs']} run(s) and "
        f"{after['queued_train_jobs'] - before['queued_train_jobs']} queued train job(s) behind")
