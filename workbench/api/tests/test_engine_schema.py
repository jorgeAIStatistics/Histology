"""Engine schema (design §5, §6, §7, §8, §9): tables, columns, constraints and immutability.

Most tests use a standalone SQLite database built with ``create_all`` (foreign keys not
enforced, so rows need no parents); the ORM guards are global session listeners and the
SQLite triggers are created by ``create_all``, exactly as in the application database.
"""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import create_engine, inspect, select, text, update
from sqlalchemy.exc import DatabaseError, IntegrityError
from sqlalchemy.orm import sessionmaker

from dermpath.db import SCHEMA_VERSION, Base, import_all_models
from dermpath.models import ImmutableRecordError

ENGINE_TABLES = {"feature_set", "feature_set_item", "feature_set_validation", "comparison_family",
                 "comparison_family_member", "test_release", "run_attempt", "inference_bundle",
                 "inference_prediction", "al_proposal"}


@pytest.fixture()
def db(tmp_path):
    import_all_models()
    engine = create_engine(f"sqlite:///{tmp_path / 'engine.db'}")
    Base.metadata.create_all(engine)
    maker = sessionmaker(bind=engine, expire_on_commit=False)
    session = maker()
    session.engine = engine  # raw-SQL access for trigger tests
    yield session
    session.close()
    engine.dispose()


def _raw(db, sql: str, **params) -> None:
    with db.engine.begin() as conn:
        conn.execute(text(sql), params)


def _refused(db, sql: str, match: str, **params) -> None:
    with pytest.raises(DatabaseError, match=match):
        _raw(db, sql, **params)


def _flush_refused(db, match: str = "") -> None:
    with pytest.raises(ImmutableRecordError, match=match):
        db.flush()
    db.rollback()


def _h(c: str) -> str:
    return c * 64


def feature_set(**kw):
    from dermpath.ml.engine_models import FeatureSet

    base = dict(project_id="p", name="fs", execution_mode="real_image_technical", encoder_id="handcrafted-v1",
                encoder_spec_json={"id": "handcrafted-v1"}, encoder_spec_sha256=_h("a"),
                weights_sha256="handcrafted:1:" + _h("b"), patch_policy_json={"target_mpp": 0.5},
                policy_sha256=_h("c"), stain_policy_json={"method": "none"}, extraction_env_json={"x": 1},
                extraction_env_sha256=_h("d"), input_snapshot_json={"slides": []}, input_snapshot_sha256=_h("e"),
                spec_sha256=uuid.uuid4().hex * 2, created_by="u")
    base.update(kw)
    return FeatureSet(**base)


def training_run(**kw):
    from dermpath.ml.models import TrainingRun

    base = dict(project_id="p", name="run", dataset_version_id="dv", dataset_manifest_sha256=_h("m"),
                encoder_id="enc", head="meanpool_logreg", params_json={"lr": 0.1}, seed=1, synthetic=False,
                label_scope="slide", positive_class="bcc_present", negative_class="bcc_absent_not_benign",
                created_by="u", execution_mode="supervised_experiment", identity_json={"k": "v"},
                identity_sha256=_h("i"))
    base.update(kw)
    return TrainingRun(**base)


# --------------------------------------------------------------------------- schema


def test_schema_v2_has_engine_tables_columns_and_triggers(env):
    from dermpath.db import current_schema_version, get_engine, session_scope

    assert SCHEMA_VERSION == 2
    with session_scope() as s:
        assert current_schema_version(s) == 2
    insp = inspect(get_engine())
    assert ENGINE_TABLES <= set(insp.get_table_names())
    cols = lambda t: {c["name"] for c in insp.get_columns(t)}  # noqa: E731
    assert {"execution_mode", "feature_set_id", "identity_json", "identity_sha256", "evaluation_protocol",
            "family_id", "calibration_json", "abstention_json", "bundle_id"} <= cols("training_run")
    assert {"encoder_spec_sha256", "policy_sha256", "stain_policy_sha256", "mask_sha256", "excluded_regions_sha256",
            "extraction_env_sha256", "embeddings_key", "embeddings_sha256", "quality_key", "quality_sha256",
            "device", "precision", "coverage_json", "generation"} <= cols("feature_artifact")
    assert {"abstained", "failure_categories_json"} <= cols("prediction")
    assert {"spec_sha256", "input_snapshot_sha256", "extraction_env_sha256", "weights_sha256", "status",
            "ready_at"} <= cols("feature_set")
    uniques = {tuple(u["column_names"]) for u in insp.get_unique_constraints("feature_set_item")}
    assert ("feature_set_id", "slide_id") in uniques
    with get_engine().connect() as c:
        triggers = set(c.execute(text("SELECT name FROM sqlite_master WHERE type='trigger'")).scalars())
    assert {"feature_set_ready_update", "feature_set_item_ready_insert", "test_release_number_insert",
            "run_attempt_settled_update", "inference_bundle_no_update", "al_proposal_no_delete",
            "training_run_identity_update", "training_run_set_once_update", "training_run_completed_delete",
            "feature_artifact_no_update", "feature_artifact_no_delete"} <= triggers
    # The seeded legacy rows still load (new columns are nullable or defaulted).
    from dermpath.ml.models import FeatureArtifact, TrainingRun

    with session_scope() as s:
        run = s.scalars(select(TrainingRun).where(TrainingRun.status == "succeeded")).first()
        assert run is not None and run.evaluation_protocol == "holdout" and run.identity_sha256 is None
        assert s.scalars(select(FeatureArtifact)).first().generation == 0


def test_vocabulary_check_constraints(db):
    from dermpath.ml.engine_models import ALProposal

    db.add(feature_set(execution_mode="clinical"))
    with pytest.raises(IntegrityError):
        db.flush()
    db.rollback()
    db.add(ALProposal(project_id="p", batch_id="b", slide_id="s", proposal_rank=1, strategy="vibes", created_by="u"))
    with pytest.raises(IntegrityError):
        db.flush()
    db.rollback()
    db.add(training_run(execution_mode="production"))
    _flush_refused(db, "execution_mode")
    db.add(training_run(evaluation_protocol="peek_at_test"))
    _flush_refused(db, "evaluation_protocol")


# --------------------------------------------------------------------------- feature sets


def test_feature_set_spec_is_immutable_and_ready_freezes_everything(db):
    from dermpath.ml.engine_models import FeatureSet, FeatureSetItem

    fs = feature_set()
    db.add(fs)
    db.flush()
    items = [FeatureSetItem(feature_set_id=fs.id, project_id="p", slide_id=f"s{i}", slide_sha256=_h(str(i)))
             for i in range(2)]
    db.add_all(items)
    db.commit()
    for attr, value in (("patch_policy_json", {"target_mpp": 0.25}), ("weights_sha256", _h("f")),
                        ("input_snapshot_sha256", _h("0")), ("name", "renamed")):
        setattr(fs, attr, value)
        _flush_refused(db, "specification is immutable")
    # Build state is writable while building; items settle once.
    fs.job_id, fs.stain_reference_sha256 = "job1", _h("9")
    items[0].status, items[0].artifact_id = "done", "art0"
    db.commit()
    items[0].artifact_id = "art-other"
    _flush_refused(db, "done feature set item")
    items[1].slide_sha256 = _h("z")
    _flush_refused(db, "identity is immutable")
    # Ready in the same flush as an item change is refused (items first, then the set).
    items[1].status, fs.status = "done", "ready"
    _flush_refused(db, "flush item changes before")
    items[1].status = "done"
    db.commit()
    fs.status = "ready"
    db.commit()
    for mutate in (lambda: setattr(fs, "error", "x"), lambda: setattr(fs, "status", "building")):
        mutate()
        _flush_refused(db, "ready feature set is immutable")
    db.add(FeatureSetItem(feature_set_id=fs.id, project_id="p", slide_id="late", slide_sha256=_h("l")))
    _flush_refused(db, "ready feature set")
    db.delete(fs)
    _flush_refused(db, "never deleted")
    db.delete(db.get(FeatureSetItem, items[0].id))
    _flush_refused(db, "never deleted")
    assert db.get(FeatureSet, fs.id).status == "ready"


def test_feature_set_status_transitions(db):
    fs = feature_set()
    db.add(fs)
    db.commit()
    fs.status = "failed"
    db.commit()
    fs.status = "ready"  # failed -> ready skips the rebuild
    _flush_refused(db, "cannot move failed -> ready")
    fs.status = "building"  # resume
    db.commit()
    db.add(feature_set(spec_sha256=fs.spec_sha256))  # same spec in the same project: reuse, not a copy
    with pytest.raises(IntegrityError):
        db.flush()
    db.rollback()


def test_feature_set_sqlite_triggers(db):
    from dermpath.ml.engine_models import FeatureSetItem

    fs = feature_set()
    db.add(fs)
    db.flush()
    db.add(FeatureSetItem(id="item1", feature_set_id=fs.id, project_id="p", slide_id="s1", slide_sha256=_h("1")))
    db.commit()
    _refused(db, "UPDATE feature_set SET policy_sha256 = 'x' WHERE id = :i", "specification is immutable", i=fs.id)
    _refused(db, "UPDATE feature_set SET status = 'bogus' WHERE id = :i", "transition|CHECK", i=fs.id)
    _refused(db, "UPDATE feature_set_item SET slide_sha256 = 'x' WHERE id = 'item1'", "identity is immutable")
    _raw(db, "UPDATE feature_set_item SET status = 'done', artifact_id = 'a1' WHERE id = 'item1'")
    _refused(db, "UPDATE feature_set_item SET artifact_id = 'a2' WHERE id = 'item1'", "done feature set item")
    _raw(db, "UPDATE feature_set SET status = 'ready' WHERE id = :i", i=fs.id)
    _refused(db, "UPDATE feature_set SET error = 'x' WHERE id = :i", "ready feature set is immutable", i=fs.id)
    _refused(db, "DELETE FROM feature_set WHERE id = :i", "never deleted", i=fs.id)
    _refused(db, "INSERT INTO feature_set_item (id, feature_set_id, project_id, slide_id, slide_sha256, status, "
                 "created_at) VALUES ('item2', :i, 'p', 's2', 'x', 'pending', '2026-01-01')", "feature set is ready",
             i=fs.id)
    _refused(db, "DELETE FROM feature_set_item WHERE id = 'item1'", "never deleted")


# --------------------------------------------------------------------------- comparison families


def test_comparison_family_locks_forward_only(db):
    from dermpath.ml.engine_models import ComparisonFamily, ComparisonFamilyMember

    fam = ComparisonFamily(id="fam1", project_id="p", name="baselines", dataset_version_id="dv",
                           dataset_manifest_sha256=_h("m"), plan_json={"primary_metric": "auroc"}, bootstrap_seed=7,
                           created_by="u")
    db.add(fam)
    db.add(ComparisonFamilyMember(family_id=fam.id, project_id="p", run_id="r1", role="baseline", created_by="u"))
    db.commit()  # created together in one flush: allowed while open
    fam.plan_json = {"primary_metric": "auprc"}
    _flush_refused(db, "identity is immutable")
    fam.status, fam.locked_by, fam.lock_reason = "locked", "lead", "pre-registered"
    db.commit()
    db.add(ComparisonFamilyMember(family_id=fam.id, project_id="p", run_id="r2", created_by="u"))
    _flush_refused(db, "only while it is open")
    fam.lock_reason = "edited later"
    _flush_refused(db, "may change only its status")
    fam.status = "open"
    _flush_refused(db, "cannot move locked -> open")
    member = db.scalars(select(ComparisonFamilyMember)).one()
    member.role = "candidate"
    _flush_refused(db, "append-only")
    fam.status = "test_released"
    db.commit()
    db.delete(fam)
    _flush_refused(db, "never deleted")
    _refused(db, "UPDATE comparison_family SET status = 'open' WHERE id = :i", "forward", i=fam.id)
    _refused(db, "INSERT INTO comparison_family_member (id, family_id, project_id, run_id, created_by, created_at) "
                 "VALUES ('m9', :i, 'p', 'r9', 'u', '2026-01-01')", "not open", i=fam.id)
    _refused(db, "DELETE FROM comparison_family_member", "append-only")


# --------------------------------------------------------------------------- test releases


def _release(n: int, **kw):
    from dermpath.ml.engine_models import TestRelease

    base = dict(project_id="p", dataset_version_id="dv", dataset_manifest_sha256=_h("m"), release_number=n,
                candidate_kind="bundle", bundle_id="b1", run_ids_json=["r1"], reason="final evaluation",
                released_by="lead")
    base.update(kw)
    return TestRelease(**base)


def test_test_releases_are_numbered_justified_and_append_only(db):
    db.add(_release(2, justification="x"))
    _flush_refused(db, "release_number must be 1")
    db.add(_release(1, reason="  "))
    _flush_refused(db, "needs a reason")
    first = _release(1)
    db.add(first)
    db.commit()
    db.add(_release(2))
    _flush_refused(db, "needs a justification")
    db.add(_release(1, dataset_version_id="other-dv"))  # numbering is per dataset version
    db.add(_release(2, justification="second look requested by the steering group (recorded)"))
    db.commit()
    first.job_id = "job-1"  # set once
    db.commit()
    first.job_id = "job-2"
    _flush_refused(db, "append-only")
    first.reason = "changed"
    _flush_refused(db, "append-only")
    db.delete(first)
    _flush_refused(db, "never deleted")
    db.add(_release(3, candidate_kind="family", bundle_id=None, family_id=None, justification="x"))
    with pytest.raises(IntegrityError):  # a family release must name the family
        db.flush()
    db.rollback()
    # Triggers: numbering, justification, reason, append-only.
    insert = ("INSERT INTO test_release (id, project_id, dataset_version_id, dataset_manifest_sha256, release_number, "
              "candidate_kind, bundle_id, run_ids_json, reason, justification, released_by, released_at) VALUES "
              "(:id, 'p', 'dv', 'm', :n, 'bundle', 'b1', '[]', :reason, :j, 'lead', '2026-01-01')")
    _refused(db, insert, "next number", id="t5", n=5, reason="r", j="j")
    _refused(db, insert, "justification", id="t3", n=3, reason="r", j=None)
    _refused(db, insert, "reason", id="t3", n=3, reason=" ", j="j")
    _refused(db, "UPDATE test_release SET reason = 'x'", "append-only")
    _refused(db, "UPDATE test_release SET job_id = 'other' WHERE id = :i", "append-only", i=first.id)
    _refused(db, "DELETE FROM test_release", "append-only")


# --------------------------------------------------------------------------- run attempts


def test_run_attempt_settles_once(db):
    from dermpath.ml.engine_models import RunAttempt

    att = RunAttempt(run_id="r1", project_id="p", attempt_number=1, job_id="j", job_attempt=1, worker_id="w",
                     code_revision="abc", code_tree_sha256=_h("t"), deps_json={"numpy": "2"}, identity_sha256=_h("i"),
                     identity_matches=True)
    db.add(att)
    db.commit()
    att.code_tree_sha256 = _h("u")
    _flush_refused(db, "identity is immutable")
    att.weights_sha256 = _h("w")
    db.commit()
    att.outcome, att.error = "run_identity_changed", "code_tree_sha256 differs"
    db.commit()
    att.error = "rewritten"
    _flush_refused(db, "settled run attempt")
    db.add(RunAttempt(run_id="r1", project_id="p", attempt_number=1))
    with pytest.raises(IntegrityError):  # attempt numbers are unique per run
        db.flush()
    db.rollback()
    db.add(RunAttempt(run_id="r1", project_id="p", attempt_number=2, outcome="it_worked_on_my_machine"))
    with pytest.raises(IntegrityError):
        db.flush()
    db.rollback()
    db.delete(att)
    _flush_refused(db, "never deleted")
    _refused(db, "UPDATE run_attempt SET error = 'x' WHERE id = :i", "settled", i=att.id)
    _refused(db, "DELETE FROM run_attempt", "never deleted")


# --------------------------------------------------------------------------- inference and AL


def test_inference_bundle_identity_and_append_only_outputs(db):
    from dermpath.ml.engine_models import (
        ALProposal,
        FeatureSetValidation,
        InferenceBundle,
        InferencePrediction,
        bundle_sha256_of,
    )
    from dermpath.ml.artifacts import canonical_json, sha256_hex

    content = {"encoder": {"id": "uni-v1"}, "threshold": 0.4, "research_use_only": True,
               "class_mapping": {"positive_class": "bcc_present", "negative_class": "bcc_absent_not_benign",
                                 "negative_is_not_benign": True}}
    assert bundle_sha256_of(content) == sha256_hex(canonical_json(content))
    db.add(InferenceBundle(project_id="p", run_id="r1", bundle_sha256=_h("0"), content_json=content,
                           object_key="k", created_by="u"))
    _flush_refused(db, "does not match")
    unsafe = {**content, "research_use_only": False}
    db.add(InferenceBundle(project_id="p", run_id="r1", bundle_sha256=bundle_sha256_of(unsafe), content_json=unsafe,
                           object_key="k", created_by="u"))
    _flush_refused(db, "research_use_only")
    bundle = InferenceBundle(id="bundle1", project_id="p", run_id="r1", bundle_sha256=bundle_sha256_of(content),
                             content_json=content, object_key="k", created_by="u")
    pred = InferencePrediction(project_id="p", bundle_id=bundle.id, slide_id="s1", slide_sha256=_h("s"), score=0.7,
                               threshold=0.4, predicted=1, created_by="u")
    prop = ALProposal(project_id="p", batch_id="b1", slide_id="s1", proposal_rank=1, strategy="uncertainty",
                      score=0.49, created_by="u")
    val = FeatureSetValidation(feature_set_id="fs", project_id="p", seed=3, slide_ids_json=["s1"],
                               result_json={"max_abs_diff": 0.0}, passed=True, created_by="u")
    db.add_all([bundle, pred, prop, val])
    db.commit()
    assert pred.research_use_only is True and pred.abstained is False
    db.add(InferencePrediction(project_id="p", bundle_id=bundle.id, slide_id="s2", slide_sha256=_h("s"),
                               threshold=0.4, research_use_only=False, created_by="u"))
    _flush_refused(db, "research use only")
    db.add(InferenceBundle(project_id="p", run_id="r1", bundle_sha256=bundle.bundle_sha256, content_json=content,
                           object_key="k", created_by="u"))
    with pytest.raises(IntegrityError):  # one bundle per run
        db.flush()
    db.rollback()
    for obj, attr, value in ((bundle, "object_key", "k2"), (pred, "score", 0.1), (prop, "score", 0.0),
                             (val, "passed", False)):
        setattr(obj, attr, value)
        _flush_refused(db, "append-only")
        db.delete(obj)
        _flush_refused(db, "never deleted")
    for table in ("inference_bundle", "inference_prediction", "al_proposal", "feature_set_validation"):
        _refused(db, f"UPDATE {table} SET created_by = 'x'", "append-only")
        _refused(db, f"DELETE FROM {table}", "append-only")


def test_bulk_update_and_delete_are_refused_on_engine_tables(db):
    from dermpath.ml.engine_models import ENGINE_TABLES
    from dermpath.ml.models import TrainingRun

    for model in ENGINE_TABLES + (TrainingRun,):
        with pytest.raises(ImmutableRecordError, match="bulk"):
            db.execute(update(model).values(id="x"))
        db.rollback()


# --------------------------------------------------------------------------- training run identity


def test_training_run_identity_is_immutable_from_creation(db):
    run = training_run()
    db.add(run)
    db.commit()
    for attr, value in (("params_json", {"lr": 0.2}), ("seed", 2), ("encoder_id", "other"), ("head", "abmil"),
                        ("dataset_version_id", "dv2"), ("dataset_manifest_sha256", _h("n")),
                        ("positive_class", "x"), ("label_scope", "case"), ("execution_mode", "real_image_technical"),
                        ("feature_set_id", "fs2"), ("identity_json", {"k": "w"}), ("identity_sha256", _h("j")),
                        ("evaluation_protocol", "dev_cv"), ("synthetic", True)):
        setattr(run, attr, value)
        _flush_refused(db, "identity is immutable once the run is created")
    # Even when the old value was never loaded (expired attributes), the guard reads the row.
    db.expire(run)
    run.seed = 99
    _flush_refused(db, "identity is immutable")
    # Status and outputs remain the worker's to write until success.
    run = db.get(type(run), run.id)
    run.status, run.code_revision, run.deps_json = "running", "rev", {"numpy": "2"}
    run.calibration_json, run.abstention_json = {"method": "platt", "a": 1.0}, {"policy": "none"}
    db.commit()
    run.weights_sha256, run.family_id = _h("w"), "fam1"
    db.commit()
    for attr, value in (("weights_sha256", _h("v")), ("family_id", "fam2")):
        setattr(run, attr, value)
        _flush_refused(db, "may be set only once")


def test_succeeded_run_accepts_only_its_bundle_once(db):
    run = training_run(status="succeeded", checkpoint_sha256=_h("k"), threshold_value=0.5)
    db.add(run)
    db.commit()
    run.threshold_value = 0.01
    _flush_refused(db, "completed training run is immutable")
    run.bundle_id = "bundle1"
    db.commit()
    run.bundle_id = "bundle2"
    _flush_refused(db, "set only once")
    db.delete(run)
    _flush_refused(db, "never deleted")
    _refused(db, "UPDATE training_run SET threshold_value = 0.2 WHERE id = :i", "completed", i=run.id)
    _refused(db, "UPDATE training_run SET bundle_id = 'b3' WHERE id = :i", "set only once", i=run.id)
    _refused(db, "DELETE FROM training_run WHERE id = :i", "never deleted", i=run.id)


def test_training_run_identity_triggers(db):
    run = training_run()
    db.add(run)
    db.commit()
    for col, value in (("seed", 5), ("params_json", '{"lr": 9}'), ("feature_set_id", "fs9"),
                       ("identity_sha256", "x"), ("execution_mode", "real_image_technical")):
        _refused(db, f"UPDATE training_run SET {col} = :v WHERE id = :i", "identity is immutable", v=value, i=run.id)
    _raw(db, "UPDATE training_run SET status = 'running', weights_sha256 = 'w1' WHERE id = :i", i=run.id)
    _refused(db, "UPDATE training_run SET weights_sha256 = 'w2' WHERE id = :i", "set only once", i=run.id)
    _raw(db, "UPDATE training_run SET status = 'failed', error = 'x' WHERE id = :i", i=run.id)
    _raw(db, "DELETE FROM training_run WHERE id = :i", i=run.id)  # an unfinished run may be removed


def test_feature_artifact_generations_and_triggers(db):
    from dermpath.ml.models import FeatureArtifact

    def art(gen: int, sha: str):
        return FeatureArtifact(project_id="p", slide_id="s", slide_sha256=_h("s"), encoder_id="e", weights_sha256="w",
                               preprocessing_version="v", patch_size=224, scale_key="mpp=0.5", coords_sha256=_h("c"),
                               cache_key=_h("k"), generation=gen, object_key=f"o{gen}", sha256=sha, bytes=1,
                               n_patches=1, embedding_dim=4, calibrated=True, synthetic=False,
                               embeddings_sha256=sha, device="cpu", precision="fp32")
    db.add(art(0, _h("1")))
    db.commit()
    db.add(art(0, _h("2")))
    with pytest.raises(IntegrityError):  # the legacy race resolution still sees a duplicate
        db.flush()
    db.rollback()
    db.add(art(1, _h("2")))  # a replacement after a corrupt object is a new generation
    db.commit()
    assert db.scalar(select(FeatureArtifact.generation).order_by(FeatureArtifact.generation.desc())) == 1
    _refused(db, "UPDATE feature_artifact SET sha256 = 'x'", "append-only")
    _refused(db, "DELETE FROM feature_artifact", "append-only")


def test_model_version_trigger_covers_every_column(db):
    from dermpath.ml.models import ModelVersion

    mv = ModelVersion(project_id="p", run_id="r", status="research_candidate", synthetic=False,
                      checkpoint_sha256=_h("k"), note="n", created_by="u")
    db.add(mv)
    db.commit()
    _raw(db, "UPDATE model_version SET status = 'retired'")
    for sql in ("UPDATE model_version SET note = 'edited'", "UPDATE model_version SET synthetic = 1",
                "UPDATE model_version SET status = 'deployed'"):
        _refused(db, sql, "only status may change")


def test_engine_stub_modules_import_and_feature_router_is_mounted(app, capsys):
    import importlib

    for name in ("feature_sets", "inference", "benchmark", "router_features", "cli"):
        mod = importlib.import_module(f"dermpath.ml.{name}")
        assert mod.__doc__ and "design" in mod.__doc__.lower()
    assert app.state.optional_routers["dermpath.ml.router_features"] == "mounted"
    from dermpath.ml import cli

    assert cli.main([]) == 2 and "research use only" in capsys.readouterr().err
