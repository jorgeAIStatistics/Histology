"""Training protocols (design §1 invariants 2 and 5, §6): roles of data, content-stable
ordering, class weights in both heads, inner early stopping, dev_cv out-of-fold integrity,
operating points frozen from development data, learning-curve subsets, run identity and mode
checks at creation and in the worker.

Part A uses in-memory bags (no database). Part B uses the seeded synthetic cohort."""

from __future__ import annotations

import copy
import hashlib
import random
import uuid

import numpy as np
import pytest
from sqlalchemy import func, select

from test_ml_support import CID, FAST, LEAD, SYNTH, cohort, run_jobs

DIM = 8
CTX = {"split_salt": "unit-test-salt", "patient_label_rule": "any_positive", "duplicate_pairs": []}


def _params(**kw):
    from dermpath.ml.config import resolve_params

    return resolve_params({"max_epochs": 8, "patience": 3, "n_boot": 50, "hidden_dim": 8, "attn_dim": 4, **kw})


def _content_embedding(sha: str, label: int, n: int) -> np.ndarray:
    """Embeddings that depend on CONTENT (the slide sha) only, never on database ids."""
    rng = np.random.default_rng(int(hashlib.sha256(sha.encode()).hexdigest()[:8], 16))
    e = rng.normal(size=(n, DIM)).astype(np.float32)
    e[:, 0] += 1.5 * label
    return e


def _items(n_patients=30, *, seed=0, pos_every=3, slides_per_case=(1, 2), split_of=None):
    """Manifest-like rows with fresh uuids; content (codes, shas, labels) is deterministic."""
    rows = []
    for i in range(n_patients):
        code = f"PT-{i:03d}"
        label = "bcc_present" if i % pos_every == 0 else "bcc_absent_not_benign"
        pid, cid = uuid.uuid4().hex, uuid.uuid4().hex
        for j in range(slides_per_case[i % len(slides_per_case)]):
            rows.append({"slide_id": uuid.uuid4().hex, "case_id": cid, "coded_patient_id": pid, "patient_code": code,
                         "accession_code": f"ACC-{i:03d}", "slide_sha256": hashlib.sha256(f"{code}|{j}".encode())
                         .hexdigest(), "label_value": label, "label_version_id": uuid.uuid4().hex,
                         "split": (split_of or (lambda k: "train"))(i), "scanner_id": "s", "site_id": "x",
                         "stain": "H&E"})
    return rows


def _bags(items, scope="slide"):
    from dermpath.ml.training import build_bags

    bags = build_bags(items, scope, "bcc_present")
    for b in bags:
        parts = [_content_embedding(sha, b.label, 6 + int(sha[:2], 16) % 9) for sha in b.slide_sha256s]
        b.embeddings = np.concatenate(parts)
        b.slide_index = np.concatenate([np.full(p.shape[0], k) for k, p in enumerate(parts)])
    return bags


class RecordingAccess:
    """EmbeddingAccess that records which bags are read (and in which phase)."""

    def __init__(self):
        from dermpath.ml.heads import IN_MEMORY

        self.inner, self.reads, self.phase = IN_MEMORY, [], "fit"

    def parts(self, bag):
        self.reads.append((self.phase, bag.bag_id))
        return self.inner.parts(bag)

    def embeddings(self, bag):
        self.reads.append((self.phase, bag.bag_id))
        return self.inner.embeddings(bag)

    def mean(self, bag):
        self.reads.append((self.phase, bag.bag_id))
        return self.inner.mean(bag)


# =========================================================================== Part A: pure


def test_bags_are_ordered_by_content_and_case_labels_stay_on_case_bags():
    from dermpath.jobs.registry import PermanentJobError
    from dermpath.ml.training import build_bags

    items = _items(12, slides_per_case=(1, 3))
    shuffled = copy.deepcopy(items)
    random.Random(4).shuffle(shuffled)
    a = build_bags(items, "case", "bcc_present")
    b = build_bags(shuffled, "case", "bcc_present")
    assert [x.sort_key[:3] for x in a] == [x.sort_key[:3] for x in b]
    assert [x.patient_code for x in a] == sorted(x.patient_code for x in a)
    # Case scope: ONE bag per case with every slide; the case label lives on the bag only.
    by_case = {}
    for it in items:
        by_case.setdefault(it["case_id"], []).append(it["slide_id"])
    assert len(a) == len(by_case)
    for bag in a:
        assert sorted(bag.slide_ids) == sorted(by_case[bag.case_id]) and bag.kind == "case"
        assert not hasattr(bag, "slide_labels") and bag.label in (0, 1)
        assert bag.slide_sha256s == sorted(bag.slide_sha256s)  # slides inside a bag: content order
    conflicting = copy.deepcopy(items[:2])
    conflicting[1]["case_id"] = conflicting[0]["case_id"]
    conflicting[1]["label_value"] = ("bcc_absent_not_benign" if conflicting[0]["label_value"] == "bcc_present"
                                     else "bcc_present")
    with pytest.raises(PermanentJobError, match="conflicting labels"):
        build_bags(conflicting, "case", "bcc_present")


@pytest.mark.parametrize("head", ["meanpool_logreg", "abmil"])
@pytest.mark.parametrize("protocol", ["holdout", "dev_cv"])
def test_regenerated_ids_give_identical_model_arrays(head, protocol):
    """Identical content with new database ids (and another row order) trains identical models."""
    from dermpath.ml.training import run_dev_cv, run_holdout

    split_of = (lambda i: "val" if i % 5 == 0 else "train")
    params = _params(cv_folds=3)

    def train_once(seed_order):
        items = _items(30, split_of=split_of)
        random.Random(seed_order).shuffle(items)
        bags = _bags(items)
        train = [b for b in bags if b.split == "train"]
        val = [b for b in bags if b.split == "val"]
        if protocol == "holdout":
            out = run_holdout(train, val, head=head, params=params, seed=3, access=_mem(), context=CTX)
        else:
            out = run_dev_cv(train + val, head=head, params=params, seed=3, access=_mem(), context=CTX)
        return out

    a, b = train_once(1), train_once(2)
    assert sorted(a.arrays) == sorted(b.arrays)
    for k in a.arrays:
        assert np.array_equal(a.arrays[k], b.arrays[k]), k
    assert [round(sb.score, 12) for sb in a.dev] == [round(sb.score, 12) for sb in b.dev]
    assert [sb.bag.patient_code for sb in a.dev] == [sb.bag.patient_code for sb in b.dev]


def _mem():
    from dermpath.ml.heads import IN_MEMORY

    return IN_MEMORY


def test_inner_early_stopping_never_touches_validation():
    """ABMIL early stopping uses an inner patient-grouped hold-out of TRAIN; val bags are read only
    when the finished model scores them."""
    from dermpath.ml import heads, training

    items = _items(30, split_of=lambda i: "val" if i % 4 == 0 else "train")
    bags = _bags(items)
    train = [b for b in bags if b.split == "train"]
    val = [b for b in bags if b.split == "val"]
    acc = RecordingAccess()
    seen = {}
    real_split = heads.inner_split

    def spy_split(train_bags, params, **kw):
        fit, stop, info = real_split(train_bags, params, **kw)
        seen["fit"], seen["stop"] = fit, stop
        return fit, stop, info

    real_fit = training.fit_head

    def spy_fit(head, fit_bags, params, seed, progress, *, access, context):
        out = real_fit(head, fit_bags, params, seed, progress, access=access, context=context)
        acc.phase = "score"
        return out

    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(heads, "inner_split", spy_split)
        mp.setattr(training, "fit_head", spy_fit)
        out = training.run_holdout(train, val, head="abmil", params=_params(max_epochs=12, patience=2), seed=1,
                                   access=acc, context=CTX)
    val_ids = {b.bag_id for b in val}
    fit_reads = {bid for phase, bid in acc.reads if phase == "fit"}
    assert fit_reads and not (fit_reads & val_ids)
    assert seen["stop"], "the inner hold-out is used for early stopping"
    stop_patients = {b.patient_id for b in seen["stop"]}
    fit_patients = {b.patient_id for b in seen["fit"]}
    assert not (stop_patients & fit_patients)  # patient-grouped
    assert stop_patients <= {b.patient_id for b in train} and not (stop_patients & {b.patient_id for b in val})
    assert {b.label for b in seen["stop"]} == {0, 1}  # stratified
    s = out.summary
    assert s["best_epoch"] is not None and "validation never seen" in s["early_stopping"]
    assert s["inner_holdout"]["holdout_patients"] == len(stop_patients)
    assert all("inner_holdout_loss" in h and "val_loss" not in h for h in s["history"])


@pytest.mark.parametrize("head", ["meanpool_logreg", "abmil"])
def test_class_weight_is_honoured_by_both_heads(head):
    from dermpath.ml.heads import HEAD_FITTERS, class_weights

    bags = _bags(_items(36, pos_every=4))
    fit = HEAD_FITTERS[head]
    a_arr, a_meta, a_sum = fit(bags, _params(class_weight="balanced"), 0, access=_mem(), **CTX)
    b_arr, b_meta, b_sum = fit(bags, _params(class_weight="none"), 0, access=_mem(), **CTX)
    assert a_meta["class_weight"] == "balanced" and b_meta["class_weight"] == "none"
    assert any(not np.array_equal(a_arr[k], b_arr[k]) for k in a_arr), "class_weight must change the fit"
    wa, wb = a_sum["class_weights"], b_sum["class_weights"]
    assert wb["weights"] == {"positive": 1.0, "negative": 1.0}
    n1, n0 = wa["counts"]["positive"], wa["counts"]["negative"]
    assert n1 < n0 and wa["weights"]["positive"] == pytest.approx((n1 + n0) / (2 * n1))
    assert wa["effective_positive_fraction"] == pytest.approx(0.5)
    assert wb["effective_positive_fraction"] == pytest.approx(n1 / (n1 + n0))
    # Weights come from the bags the head is fitted on only (ABMIL: the inner fit part).
    fitted = len(bags) if head == "meanpool_logreg" else a_sum["fit_bags"]
    assert n1 + n0 == fitted
    assert class_weights([1, 0, 0, 0], "balanced")["weights"]["positive"] == pytest.approx(2.0)


def test_dev_cv_scores_each_development_patient_exactly_once_out_of_fold():
    from dermpath.ml import training

    items = _items(30, slides_per_case=(1, 2, 3), split_of=lambda i: "val" if i % 5 == 0 else "train")
    bags = _bags(items)
    dev = list(bags)  # train ∪ val
    fits = []
    real_fit = training.fit_head

    def spy_fit(head, fit_bags, params, seed, progress, *, access, context):
        fits.append({b.patient_id for b in fit_bags})
        return real_fit(head, fit_bags, params, seed, progress, access=access, context=context)

    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(training, "fit_head", spy_fit)
        out = training.run_dev_cv(dev, head="meanpool_logreg", params=_params(cv_folds=5), seed=2, access=_mem(),
                                  context=CTX)
    assert out.dev_split == "oof" and not out.unscored
    ids = [sb.bag.bag_id for sb in out.dev]
    assert sorted(ids) == sorted(b.bag_id for b in dev) and len(ids) == len(set(ids))  # every bag exactly once
    fold_of = {}
    for sb in out.dev:
        fold_of.setdefault(sb.bag.patient_id, set()).add(sb.fold)
    assert all(len(f) == 1 for f in fold_of.values())  # a patient's bags share one fold
    assert len(fits) == 5 + 1 and fits[-1] == {b.patient_id for b in dev}  # 5 folds + refit on the whole pool
    for f in range(5):
        held = {p for p, fs in fold_of.items() if f in fs}
        assert held and not (held & fits[f])  # scored by a model that never saw the patient
    assert out.cv["k"] == 5 and set(out.cv["fold_of_patient_code"]) == {b.patient_code for b in dev}
    # Threshold, calibration and abstention are chosen on the OOF predictions.
    op = training.select_operating_point(out.dev, _params(calibration="platt", abstention_target_coverage=0.8,
                                                          min_threshold_evidence=5), selected_on="oof")
    assert op["threshold"]["selected_on"] == "oof" and op["threshold"]["evidence"]["n_items"] == len(out.dev)
    assert op["calibration"]["fitted_on"]["splits"] == ["oof"] and op["calibration"]["fitted_on"]["n"] == len(out.dev)
    assert op["abstention"]["selected_on"] == "oof" and op["abstention"]["frozen"] is True


def test_dev_cv_folds_do_not_depend_on_the_head_seed():
    from dermpath.ml.training import run_dev_cv

    bags = _bags(_items(20))
    a = run_dev_cv(bags, head="meanpool_logreg", params=_params(cv_folds=4), seed=1, access=_mem(), context=CTX)
    b = run_dev_cv(bags, head="meanpool_logreg", params=_params(cv_folds=4), seed=9, access=_mem(), context=CTX)
    assert a.cv["fold_of_patient_code"] == b.cv["fold_of_patient_code"]


def test_operating_point_is_frozen_from_development_data_only():
    from dermpath.ml.calibration import apply_calibration
    from dermpath.ml.metrics import apply_abstention
    from dermpath.ml.training import ScoredBag, apply_operating_point, select_operating_point

    bags = _bags(_items(40))
    rng = np.random.default_rng(0)
    dev = [ScoredBag(b, float(np.clip(0.5 + 0.3 * (b.label - 0.5) + rng.normal(0, 0.2), 0.001, 0.999)))
           for b in bags]
    op = select_operating_point(dev, _params(calibration="isotonic", abstention_target_coverage=0.75,
                                             min_threshold_evidence=5), selected_on="val")
    thr = op["threshold"]
    assert thr["selection_status"] == "selected" and thr["value"] in {sb.score for sb in dev}
    cal = op["calibration"]
    assert cal["method"] == "isotonic" and cal["fitted_on"]["splits"] == ["val"] and cal["fitted_on"]["n"] == len(dev)
    pol = op["abstention"]
    assert pol["selected_on"] == "val" and pol["frozen"] and pol["development"]["coverage"] >= 0.75
    # Applying to other (e.g. test) scores never refits: the same frozen maps.
    other = np.linspace(0.01, 0.99, 11)
    c, p, a = apply_operating_point(other, op)
    assert np.array_equal(c, apply_calibration(cal, other)) and np.array_equal(a, apply_abstention(other, pol))
    assert np.array_equal(p, (other >= thr["value"]).astype(int))
    # Too little evidence: the threshold is a recorded fallback and calibration is not fitted.
    few = select_operating_point(dev[:6], _params(calibration="platt"), selected_on="val")
    assert few["threshold"]["selection_status"] == "insufficient_evidence" and few["threshold"]["value"] == 0.5
    assert few["calibration"]["method"] == "none" and few["calibration_selection"]["status"] == "insufficient_evidence"


def test_learning_curve_subsets_are_nested_stratified_and_deterministic():
    from dermpath.ml.training import learning_curve_subset

    bags = _bags(_items(40, slides_per_case=(1, 2)))
    by_fraction = {}
    for f in (0.25, 0.5, 1.0):
        sub, info = learning_curve_subset(bags, _params(train_patient_fraction=f), CTX)
        by_fraction[f] = {b.patient_id for b in sub}
        assert {b.label for b in sub} == {0, 1}
        if f < 1.0:
            assert info["fraction"] == f and info["n_patients"] == len(by_fraction[f])
            # whole patients: every bag of a chosen patient is in the subset
            assert {b.bag_id for b in sub} == {b.bag_id for b in bags if b.patient_id in by_fraction[f]}
        else:
            assert info is None and len(sub) == len(bags)
    assert by_fraction[0.25] < by_fraction[0.5] < by_fraction[1.0]
    again, _ = learning_curve_subset(bags, _params(train_patient_fraction=0.5), CTX)
    assert {b.patient_id for b in again} == by_fraction[0.5]
    other, _ = learning_curve_subset(bags, _params(train_patient_fraction=0.5, subset_repeat=1), CTX)
    assert {b.patient_id for b in other} != by_fraction[0.5]  # another repeat, another subset
    r1_quarter, _ = learning_curve_subset(bags, _params(train_patient_fraction=0.25, subset_repeat=1), CTX)
    assert {b.patient_id for b in r1_quarter} < {b.patient_id for b in other}  # nested within a repeat


def test_instance_subsampling_is_seeded_and_recorded():
    from dermpath.ml.heads import fit_abmil

    bags = _bags(_items(20))
    p = _params(max_instances_per_bag=4, max_epochs=3)
    a = fit_abmil(bags, p, 5, access=_mem(), **CTX)
    b = fit_abmil(bags, p, 5, access=_mem(), **CTX)
    full = fit_abmil(bags, _params(max_epochs=3), 5, access=_mem(), **CTX)
    for k in a[0]:
        assert np.array_equal(a[0][k], b[0][k])
    assert any(not np.array_equal(a[0][k], full[0][k]) for k in a[0])
    sub = a[2]["instance_subsampling"]
    assert sub["max_instances_per_bag"] == 4 and sub["bag_epochs_subsampled"] > 0 and "seed" in sub["rule"]
    assert a[1]["max_instances_per_bag"] == 4


def test_streaming_mean_and_per_slide_parts_are_bit_identical():
    from dermpath.ml.heads import IN_MEMORY, streaming_mean

    bag = _bags(_items(3, slides_per_case=(3,)), scope="case")[0]
    parts = IN_MEMORY.parts(bag)
    assert len(parts) == 3 and sum(p.shape[0] for p in parts) == bag.n_patches
    assert np.array_equal(streaming_mean(parts), IN_MEMORY.mean(bag))
    assert np.allclose(streaming_mean(parts), bag.embeddings.astype(np.float64).mean(axis=0))


def test_mode_rules_at_creation_match_the_design_matrix():
    from dermpath.ml.encoders import HANDCRAFTED_SPEC, SYNTHETIC_SPEC
    from dermpath.ml.training import derive_synthetic, infer_execution_mode, mode_problems

    assert infer_execution_mode(SYNTHETIC_SPEC) == "synthetic_pipeline_test"
    assert infer_execution_mode(HANDCRAFTED_SPEC) == "supervised_experiment"
    assert mode_problems(SYNTHETIC_SPEC, "synthetic", "synthetic_pipeline_test") == []
    assert mode_problems(HANDCRAFTED_SPEC, "real", "supervised_experiment") == []
    for spec, data, mode in ((SYNTHETIC_SPEC, "real", "synthetic_pipeline_test"),
                             (SYNTHETIC_SPEC, "synthetic", "supervised_experiment"),
                             (HANDCRAFTED_SPEC, "synthetic", "supervised_experiment"),
                             (HANDCRAFTED_SPEC, "synthetic", "synthetic_pipeline_test"),
                             (HANDCRAFTED_SPEC, "real", "real_image_technical"),
                             (HANDCRAFTED_SPEC, "mixed", "supervised_experiment")):
        assert mode_problems(spec, data, mode), (spec.id, data, mode)
    assert derive_synthetic(SYNTHETIC_SPEC, "synthetic")[0] is True
    assert derive_synthetic(HANDCRAFTED_SPEC, "synthetic")[0] is True
    assert derive_synthetic(HANDCRAFTED_SPEC, "real") == (False, [])


def test_identity_diff_lists_every_changed_field():
    from dermpath.ml.training import identity_diff

    a = {"code_tree_sha256": "x", "deps": {"numpy": "1", "torch": "2"}, "seed": 1}
    b = {"code_tree_sha256": "y", "deps": {"numpy": "1", "torch": "3"}, "seed": 1}
    assert [d["field"] for d in identity_diff(a, b)] == ["code_tree_sha256", "deps.torch"]
    assert identity_diff(a, copy.deepcopy(a)) == []


def test_experiment_params_rules():
    from dermpath.ml.config import resolve_experiment_params, resolve_params
    from dermpath.ml.encoders import HANDCRAFTED_SPEC, SYNTHETIC_SPEC

    p = resolve_params({})
    assert p["min_tissue_fraction"] == 0.25 and p["sampling_strategy"] == "spatial" and p["sampling_seed"] == 0
    assert p["inner_val_fraction"] == 0.2 and p["cv_folds"] == 5 and p["calibration"] == "none"
    assert p["threshold_rule"] == "youden" and p["train_patient_fraction"] == 1.0 and p["subset_repeat"] == 0
    with pytest.raises(ValueError):
        resolve_params({"threshold_rule": "fixed"})  # needs threshold_value
    with pytest.raises(ValueError):
        resolve_params({"threshold_value": 0.3})  # only with rule fixed
    with pytest.raises(ValueError):
        resolve_params({"subset_repeat": 1})  # only with a fraction < 1
    assert resolve_params({"threshold_rule": "fixed", "threshold_value": 0.3})["threshold_value"] == 0.3
    real = resolve_experiment_params({}, encoder_spec=HANDCRAFTED_SPEC)
    assert real["patch_size"] == HANDCRAFTED_SPEC.input_size and not any(k.startswith("synthetic_") for k in real)
    for bad in ({"synthetic_dim": 16}, {"patch_size": HANDCRAFTED_SPEC.input_size + 32}, {"pixel_mode": "none"},
                {"sampling_strategy": "lesion_aware"}):
        with pytest.raises(ValueError):
            resolve_experiment_params(bad, encoder_spec=HANDCRAFTED_SPEC)
    syn = resolve_experiment_params({"synthetic_dim": 16, "pixel_mode": "none"}, encoder_spec=SYNTHETIC_SPEC)
    assert syn["synthetic_dim"] == 16 and syn["pixel_mode"] == "none"


# =========================================================================== Part B: database


def _service_run(ids, head="meanpool_logreg", *, params=None, seed=0, protocol="holdout", **kw):
    from dermpath.auth import Actor
    from dermpath.db import session_scope
    from dermpath.ml.service import create_experiment
    from dermpath.models import Project

    lead = Actor(LEAD, "research_lead", "Priya Navarro")
    with session_scope() as db:
        dv_id = cohort(ids)["dataset_version_id"]
        run, job = create_experiment(db, lead, db.get(Project, CID), dataset_version_id=dv_id,
                                     encoder_id=kw.pop("encoder_id", SYNTH), head=head,
                                     params=FAST if params is None else params, seed=seed, name=None,
                                     evaluation_protocol=protocol, **kw)
        return run.id, job.id


def _run_row(run_id):
    from dermpath.db import session_scope
    from dermpath.ml.models import TrainingRun

    with session_scope() as db:
        r = db.get(TrainingRun, run_id)
        db.expunge(r)
        return r


def _preds(run_id, split=None):
    from dermpath.db import session_scope
    from dermpath.ml.models import Prediction

    with session_scope() as db:
        q = select(Prediction).where(Prediction.run_id == run_id)
        if split:
            q = q.where(Prediction.split == split)
        rows = db.scalars(q).all()
        for p in rows:
            db.expunge(p)
        return rows


def _attempts(run_id):
    from dermpath.db import session_scope
    from dermpath.ml.engine_models import RunAttempt

    with session_scope() as db:
        rows = db.scalars(select(RunAttempt).where(RunAttempt.run_id == run_id)
                          .order_by(RunAttempt.attempt_number)).all()
        for a in rows:
            db.expunge(a)
        return rows


def _real_mode_copy(ids) -> str:
    """A frozen dataset version whose manifest says data_mode real (a stand-in for a real cohort)."""
    from dermpath.datasets import canonical_json
    from dermpath.db import session_scope
    from dermpath.models import DatasetVersion

    with session_scope() as db:
        src = db.get(DatasetVersion, cohort(ids)["dataset_version_id"])
        m = copy.deepcopy(src.manifest_json)
        m["data_mode"], m["synthetic_only"] = "real", False
        for it in m["items"]:
            it["provenance"], it["image_kind"] = "real_authorized", "wsi"
        dv = DatasetVersion(project_id=CID, lineage_id=uuid.uuid4().hex, name="real-mode stand-in", version=1,
                            status="frozen", config_json=dict(src.config_json), manifest_json=m,
                            manifest_sha256=hashlib.sha256(canonical_json(m)).hexdigest(), created_by=LEAD,
                            frozen_by=LEAD, frozen_at=src.frozen_at)
        db.add(dv)
        db.flush()
        return dv.id


def test_mode_mismatch_is_refused_at_creation(clients, ids):
    lead = clients(LEAD)
    dv = cohort(ids)["dataset_version_id"]
    url = f"/api/v1/projects/{CID}/experiments"
    base = {"dataset_version_id": dv, "head": "meanpool_logreg", "seed": 0}
    # A real pixel encoder on the synthetic cohort: supervised_experiment needs real data.
    r = lead.post(url, json={**base, "encoder_id": "handcrafted-stain-texture-v1"})
    assert r.status_code == 409 and r.json()["error"]["code"] == "mode_mismatch", r.text
    assert any("real dataset" in p for p in r.json()["error"]["details"]["problems"])
    # The synthetic encoder on a dataset whose data_mode is real.
    real = _real_mode_copy(ids)
    r = lead.post(url, json={**base, "dataset_version_id": real, "encoder_id": SYNTH, "params": FAST})
    assert r.status_code == 409 and r.json()["error"]["code"] == "mode_mismatch", r.text
    # Explicit modes through the service (the same rules).
    from dermpath.errors import ApiError

    for kw in ({"execution_mode": "supervised_experiment"}, {"execution_mode": "real_image_technical"},
               {"encoder_id": "handcrafted-stain-texture-v1", "execution_mode": "synthetic_pipeline_test"}):
        with pytest.raises(ApiError) as exc:
            _service_run(ids, params={"pixel_mode": "read"} if "encoder_id" in kw else FAST, **kw)
        assert exc.value.code == "mode_mismatch", kw
    # synthetic_* controls are refused for a real encoder before anything else is resolved.
    r = lead.post(url, json={**base, "dataset_version_id": real, "encoder_id": "handcrafted-stain-texture-v1",
                             "params": {"synthetic_dim": 32}})
    assert r.status_code == 422 and r.json()["error"]["code"] == "invalid_params"


def test_worker_rechecks_the_mode_and_fails_permanently(env, ids, monkeypatch):
    from dermpath.ml import training

    rid, jid = _service_run(ids, seed=51)
    monkeypatch.setattr(training, "manifest_data_mode", lambda manifest: "real")
    outcomes = run_jobs()
    assert [o.status for o in outcomes] == ["failed"]
    assert outcomes[0].error.startswith("mode_mismatch") and "synthetic encoder" in outcomes[0].error
    run = _run_row(rid)
    assert run.status == "failed" and run.checkpoint_sha256 is None and not _preds(rid)
    att = _attempts(rid)
    assert len(att) == 1 and att[0].outcome == "failed" and "mode_mismatch" in att[0].error


@pytest.mark.parametrize("what", ["code", "deps", "drift"])
def test_identity_drift_fails_with_run_identity_changed_and_no_predictions(env, ids, monkeypatch, what):
    from dermpath.db import session_scope
    from dermpath.ml import training
    from dermpath.models import Job

    rid, jid = _service_run(ids, seed=52)
    frozen = _run_row(rid)
    if what == "code":
        ident = {**training.code_identity(), "code_tree_sha256": "f" * 64}
        monkeypatch.setattr(training, "code_identity", lambda: dict(ident))
        field = "code_tree_sha256"
    elif what == "deps":
        monkeypatch.setattr(training, "training_dependencies",
                            lambda: {**frozen.identity_json["deps"], "numpy": "0.0-other"})
        field = "deps.numpy"
    else:
        monkeypatch.setattr(training, "code_tree_drift", lambda: {
            "matches": False, "changed": ["ml/heads.py"], "added": [], "removed": [],
            "code_tree_sha256_at_start": "a" * 64, "code_tree_sha256_now": "b" * 64})
        field = "code_tree_drift"
    outcomes = run_jobs()
    assert [o.status for o in outcomes] == ["failed"]
    assert outcomes[0].error.startswith("run_identity_changed") and field in outcomes[0].error
    run = _run_row(rid)
    assert run.status == "failed" and run.checkpoint_sha256 is None and run.threshold_value is None
    assert run.code_revision == frozen.code_revision and run.deps_json == frozen.deps_json  # never overwritten
    assert run.identity_json == frozen.identity_json and not _preds(rid)
    att = _attempts(rid)
    assert len(att) == 1 and att[0].outcome == "run_identity_changed" and att[0].identity_matches is False
    assert field in {d["field"] for d in att[0].identity_diff_json}
    with session_scope() as db:
        assert db.get(Job, jid).attempts == 1  # permanent: not retried


def test_every_attempt_appends_a_row_and_a_retry_reproduces_the_result(env, ids, monkeypatch):
    from dermpath.jobs.worker import Worker
    from dermpath.ml import training

    rid, _ = _service_run(ids, seed=53)
    real = training.store_development_evaluation
    calls = {"n": 0}

    def crash_once(*a, **kw):
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("simulated crash during the final commit")
        return real(*a, **kw)

    monkeypatch.setattr(training, "store_development_evaluation", crash_once)
    first = Worker("w-crash", types=["train"]).run_once()
    assert first.status == "queued"
    assert [o.status for o in run_jobs()] == ["succeeded"]
    att = _attempts(rid)
    assert [a.outcome for a in att] == ["retryable_error", "succeeded"] and [a.attempt_number for a in att] == [1, 2]
    assert all(a.identity_matches for a in att) and att[0].identity_sha256 == att[1].identity_sha256
    run = _run_row(rid)
    assert run.status == "succeeded" and run.identity_sha256 == att[1].identity_sha256
    assert run.provenance_json["attempt_id"] == att[1].id


def test_holdout_freezes_threshold_calibration_and_abstention_on_validation(env, ids):
    from dermpath.db import session_scope
    from dermpath.ml.calibration import apply_calibration
    from dermpath.ml.metrics import apply_abstention
    from dermpath.ml.models import Evaluation

    params = {**FAST, "calibration": "platt", "abstention_target_coverage": 0.8, "min_threshold_evidence": 5}
    rid, _ = _service_run(ids, "abmil", params=params, seed=54)
    assert [o.status for o in run_jobs()] == ["succeeded"]
    run = _run_row(rid)
    val = _preds(rid, "val")
    assert val and {p.split for p in _preds(rid)} == {"train", "val"}
    assert run.threshold_json["selected_on"] == "val" and run.threshold_json["selection_status"] == "selected"
    assert set(run.threshold_json["val_bag_ids"]) == {p.bag_id for p in val}
    cal = run.calibration_json
    assert cal["method"] == "platt" and cal["fitted_on"]["splits"] == ["val"] and cal["fitted_on"]["n"] == len(val)
    pol = run.abstention_json
    assert pol["selected_on"] == "val" and pol["frozen"] is True
    scores = np.array([p.score for p in val])
    assert [p.abstained for p in val] == apply_abstention(scores, pol).tolist()
    assert np.allclose([p.attributes_json["calibrated_score"] for p in val], apply_calibration(cal, scores))
    assert all(p.predicted == int(p.score >= run.threshold_value) for p in val)
    s = run.metrics_json["val_summary"]
    assert s["tuning_set"] is True and set(s["threshold_free"]) == {"auroc", "auprc", "brier"}
    assert all(s["at_operating_point"][k]["tuning_set"] is True for k in ("sensitivity", "specificity"))
    assert run.metrics_json["protocol"]["roles"]["early_stopping"].endswith("never validation")
    with session_scope() as db:
        ev = db.scalars(select(Evaluation).where(Evaluation.run_id == rid)).all()
    assert [e.split for e in ev] == ["val"] and ev[0].threshold_frozen_from == "val"
    assert ev[0].metrics_json["tuning_set"] is True and ev[0].metrics_json["protocol"] == "holdout"


def test_dev_cv_run_stores_oof_predictions_and_refits_on_the_development_pool(env, ids):
    from dermpath.db import session_scope
    from dermpath.ml.models import Evaluation
    from dermpath.models import DatasetVersion

    params = {**FAST, "cv_folds": 4, "calibration": "isotonic", "min_threshold_evidence": 5}
    rid, _ = _service_run(ids, params=params, seed=55, protocol="dev_cv")
    assert [o.status for o in run_jobs()] == ["succeeded"]
    run = _run_row(rid)
    with session_scope() as db:
        m = db.get(DatasetVersion, run.dataset_version_id).manifest_json
    split_of = {it["slide_id"]: it["split"] for it in m["items"]}
    oof = _preds(rid, "oof")
    dev_slides = {s for s, sp in split_of.items() if sp in ("train", "val")}
    assert {s for p in oof for s in p.slide_ids_json} == dev_slides  # train ∪ val, each bag once
    assert len({p.bag_id for p in oof}) == len(oof)
    assert not any(split_of[s] == "test" for p in _preds(rid) for s in p.slide_ids_json)  # test untouched
    folds = {}
    for p in oof:
        folds.setdefault(p.coded_patient_id, set()).add(p.attributes_json["fold"])
    assert all(len(f) == 1 for f in folds.values()) and {f for v in folds.values() for f in v} == {0, 1, 2, 3}
    assert {p.attributes_json["manifest_split"] for p in oof} == {"train", "val"}
    assert run.threshold_json["selected_on"] == "oof" and "oof_bag_ids" in run.threshold_json
    assert run.calibration_json["fitted_on"]["splits"] == ["oof"] and run.calibration_json["fitted_on"]["n"] == len(oof)
    assert "oof_summary" in run.metrics_json and "val_summary" not in run.metrics_json
    assert run.metrics_json["protocol"]["cv"]["k"] == 4
    assert run.metrics_json["training"]["final_model"].startswith("refitted")
    train_rows = _preds(rid, "train")  # the final model's in-sample scores on the whole development pool
    assert {s for p in train_rows for s in p.slide_ids_json} == dev_slides
    with session_scope() as db:
        ev = db.scalars(select(Evaluation).where(Evaluation.run_id == rid)).all()
    assert [e.split for e in ev] == ["oof"] and ev[0].threshold_frozen_from == "oof"


def test_learning_curve_runs_fit_nested_subsets_and_evaluate_on_validation(env, ids):
    subsets = {}
    for f in (0.25, 0.5):
        rid, _ = _service_run(ids, params={**FAST, "train_patient_fraction": f}, seed=56)
        assert [o.status for o in run_jobs()] == ["succeeded"]
        run = _run_row(rid)
        lc = run.metrics_json["protocol"]["learning_curve"]
        assert lc["fraction"] == f and lc["repeat"] == 0
        subsets[f] = set(run.provenance_json["train_bag_ids"])
        assert {p.split for p in _preds(rid)} == {"train", "val"}
        assert len(_preds(rid, "val")) == len(run.threshold_json["val_bag_ids"])  # val is never subsampled
    assert subsets[0.25] < subsets[0.5]


def test_feature_set_is_shared_across_heads_and_pinned_in_the_identity(env, ids):
    from dermpath.db import session_scope
    from dermpath.ml.engine_models import FeatureSet

    a, _ = _service_run(ids, "meanpool_logreg", seed=57)
    b, _ = _service_run(ids, "abmil", seed=57)
    c, _ = _service_run(ids, "abmil", params={**FAST, "sampling_seed": 1}, seed=57)
    ra, rb, rc = _run_row(a), _run_row(b), _run_row(c)
    assert ra.feature_set_id == rb.feature_set_id != rc.feature_set_id  # sampling changes the feature set
    with session_scope() as db:
        fs = db.get(FeatureSet, ra.feature_set_id)
        assert ra.identity_json["feature_set_spec_sha256"] == fs.spec_sha256
        assert ra.weights_sha256 == fs.weights_sha256 == ra.identity_json["weights_sha256"]
    assert ra.identity_json["params_sha256"] != rb.identity_json["params_sha256"] or ra.head != rb.head
    assert ra.execution_mode == "synthetic_pipeline_test" and ra.synthetic is True


def test_score_bags_with_checkpoint_reproduces_stored_scores_and_keeps_unscorable_bags(env, ids):
    from dermpath.ml.heads import Bag
    from dermpath.ml.training import build_bags, score_bags_with_checkpoint

    rid, _ = _service_run(ids, "abmil", seed=58)
    assert [o.status for o in run_jobs()] == ["succeeded"]
    run = _run_row(rid)
    val = {p.bag_id: p for p in _preds(rid, "val")}
    from dermpath.db import session_scope
    from dermpath.models import DatasetVersion

    with session_scope() as db:
        items = [it for it in db.get(DatasetVersion, run.dataset_version_id).manifest_json["items"]
                 if it["slide_id"] in val]
    bags = build_bags(items, "slide", run.positive_class)
    res = score_bags_with_checkpoint(run, bags, with_attention=True)
    assert len(res) == len(val)
    for bag, score, cal, pred, abst, att in res:
        p = val[bag.bag_id]
        assert score == p.score and pred == p.predicted and abst == p.abstained
        assert cal == pytest.approx(p.attributes_json["calibrated_score"]) and att is not None
    empty = Bag("none", "slide", [], None, "pt", "PT", "bcc_present", 1, [], {})
    empty.patch_counts = [0]
    out = score_bags_with_checkpoint(run, [empty], access=_EmptyAccess())
    assert out == [(empty, None, None, None, False)]


class _EmptyAccess:
    def parts(self, bag):
        return []


def test_training_labels_must_be_permitted_by_the_reference_standard(env, ids, monkeypatch):
    from dermpath import labels

    calls = []

    def refuse(source, standard):
        calls.append((source, standard))
        return False

    monkeypatch.setattr(labels, "label_source_permitted", refuse)
    rid, _ = _service_run(ids, seed=59)
    outcomes = run_jobs()
    assert [o.status for o in outcomes] == ["failed"] and "not permitted by the reference standard" in outcomes[0].error
    assert calls and all(std == "expert" for _, std in calls) and not _preds(rid)


def test_training_never_requests_test_items(env, ids, monkeypatch):
    from dermpath.ml import training

    purposes = []
    real = training.training_eligible_items

    def spy(db, dv, purpose):
        purposes.append(purpose)
        return real(db, dv, purpose)

    monkeypatch.setattr(training, "training_eligible_items", spy)
    for protocol in ("holdout", "dev_cv"):
        _service_run(ids, seed=60, protocol=protocol, params={**FAST, "cv_folds": 3})
        assert [o.status for o in run_jobs()] == ["succeeded"]
    assert sorted(set(purposes)) == ["train", "validation"]


def test_attempt_settle_hook_closes_attempts_of_a_dead_worker(env, ids):
    from datetime import timedelta

    from sqlalchemy import update

    from dermpath.db import session_scope, utcnow
    from dermpath.jobs import queue
    from dermpath.ml.engine_models import RunAttempt
    from dermpath.models import Job

    rid, jid = _service_run(ids, seed=61)
    with session_scope() as db:
        db.execute(update(Job).where(Job.id == jid).values(max_attempts=1))
    assert queue.claim_next("dying", types=["train"]).id == jid
    with session_scope() as db:
        db.add(RunAttempt(run_id=rid, project_id=CID, attempt_number=1, job_id=jid, deps_json={}))
        db.execute(update(Job).where(Job.id == jid).values(lease_until=utcnow() - timedelta(seconds=5)))
    assert queue.claim_next("rescuer", types=["train"]) is None
    att = _attempts(rid)
    assert att[0].outcome == "failed" and "settled by the queue" in att[0].error
    with session_scope() as db:
        assert db.scalar(select(func.count(RunAttempt.id)).where(RunAttempt.outcome.is_(None),
                                                                 RunAttempt.run_id == rid)) == 0


def test_an_explicit_feature_set_must_match_the_experiment(env, ids):
    from dermpath.errors import ApiError

    fs_id = _run_row(cohort(ids)["runs"]["abmil"]).feature_set_id
    seeded_params = _run_row(cohort(ids)["runs"]["abmil"]).params_json
    same = {k: seeded_params[k] for k in ("pixel_mode", "max_patches_per_slide")}
    rid, _ = _service_run(ids, "meanpool_logreg", params=same, seed=62, feature_set_id=fs_id)
    assert _run_row(rid).feature_set_id == fs_id
    for bad in ({**same, "sampling_seed": 9}, {**same, "synthetic_signal_strength": 0.5},
                {**same, "max_patches_per_slide": 8}):
        with pytest.raises(ApiError) as exc:
            _service_run(ids, params=bad, seed=63, feature_set_id=fs_id)
        assert exc.value.code == "feature_set_mismatch" and exc.value.details["problems"], bad


def test_inner_early_stopping_split_is_seeded_and_content_stable():
    from dermpath.ml.heads import inner_split

    items = _items(40)
    bags = _bags(items)
    p = _params()

    def held(seed, bs):
        _, stop, _ = inner_split(bs, p, split_salt="s", seed=seed)
        return sorted(b.patient_code for b in stop)

    assert held(1, bags) == held(1, _bags(copy.deepcopy(items)))  # same content and seed: same split
    regenerated = _bags(_items(40))  # new database ids, same content
    assert held(1, bags) == held(1, regenerated)
    assert held(1, bags) != held(2, bags)  # another training seed: another inner hold-out
