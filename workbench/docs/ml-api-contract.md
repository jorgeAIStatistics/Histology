# ML API contract (shared by the ML backend and the frontend)

## Changes (engine upgrade, 2026-10-26)
Design contract: `docs/ml-engine-design.md` §6–§9. These changes take precedence over the older sections below wherever they differ. Research use only throughout.

**Not backwards-compatible (read first):**
- `GET /experiments/{id}/evaluation?split=test` and `GET …/errors?split=test` no longer compute anything. They read the stored result of a recorded test release. They return 409 `test_release_required` when no release includes the run, 409 `test_release_pending` while its scoring job runs, and 409 `test_release_failed` when that job failed (`details`: `test_release_id`, `release_number`, `job_status`, `job_error`). Still: 409 `test_locked` before the run has finished with a frozen threshold, then 403 for anyone without `dataset.test_access` (research lead only). Reading a stored test result writes one `experiment.test_accessed` audit row; that row is its only write. A 409 writes nothing.
- `POST /projects/{pid}/active-learning` returns **202** and enqueues a job (it used to return the proposals in the response). The pool is now development-eligible slides without a reference label (see Active learning below). Read the result with `GET /active-learning/batches/{batch_id}`.
- Evaluation `subgroups` is now an object `{schema, threshold, count_unit: "patients", min_patients, rows: [...], note}`, not a list. Each row is `{key, value, status: "ok" | "insufficient_evidence" | "not_recorded", n_bags, n_patients, positive_patients, negative_patients, min_patients, metrics | null, confusion | null, reason, bootstrap?}`. `min_n` (`params.subgroup_min_n`) counts **patients**.

**Experiments.** `POST /projects/{pid}/experiments` additionally accepts `execution_mode` (`synthetic_pipeline_test` | `real_image_technical` | `supervised_experiment`), `feature_set_id`, `evaluation_protocol` (`holdout` | `dev_cv`) and `family_id` (404 when the family is not in the project). Omitted fields keep the service defaults. 409 `mode_mismatch` comes from the engine's mode checks.

**Evaluation body** (`schema: "dermpath.evaluation/2"`, splits `val`, `oof` (dev_cv) and `test`). It is built from stored prediction rows at the run's frozen operating point:
- `metrics.sensitivity|specificity|ppv|npv`: `{value, numerator, denominator, ci, ci_reason, ci_valid_replicates, undefined_reason, threshold_dependent: true, tuning_set}`. `ppv` and `npv` also carry `evaluation_prevalence`.
- `metrics.auroc|auprc`: tie-correct, threshold-free. `auprc.prevalence_baseline` is given.
- `metrics.brier`.
- `threshold_free_metrics` lists the threshold-free metrics.
- `evaluation_prevalence`: `{value, numerator, denominator, unit, note}`. `prevalence_adjusted` (when `params.target_prevalence` is declared): Bayes PPV/NPV with CIs and the stated assumption; otherwise null.
- Unscorable bags count: `n_unscorable`, `unscorable_positives`, `unscorable_negatives` and `unscored` (listed). Scored-only metrics exclude them. `intention_to_evaluate.sensitivity|specificity` counts unscorable positives as missed and unscorable negatives as flagged.
- `tuning_set` (true when the threshold was chosen on these data) and `tuning_set_note` ("optimistic: the threshold was chosen on these data"). `operating_point: {threshold, comparison, tuning_set, note}`. On development bodies (`val`, `oof`) `tuning_set` is true only when the threshold was **selected** there; a prespecified or fallback threshold was not tuned on them (calibration and abstention fitted there are flagged by `frozen_calibration.in_sample` and `abstention.selected_on_this_split`).
- `calibration: {bins, brier, ece, note, raw: {equal_width, equal_mass, logistic_recalibration} | {status: "not_applicable"}, calibrated: {equal_width, equal_mass} | null, frozen_calibration: {method, params_sha256, fitted_on, applied, in_sample} | null, calibrated_note?}`. The top-level `bins/brier/ece/note` mirror the raw equal-width report.
- `risk_coverage: {rows: [{coverage, n_kept, n_abstained, selective_risk, risk_positive, risk_negative, coverage_positive, coverage_negative, min_margin_kept}], aurc, aurc_oracle, excess_aurc, full_coverage_risk, confidence, note}`. The note says that model confidence is not a validated out-of-distribution detector. `coverage_curve` (`[{coverage, error_rate, n_kept, abstained}]`) is kept for the chart.
- `abstention: {policy | null, selective | null, selected_on_this_split?, note}`. `selective` holds coverage (overall and per class), selective risk and selective sensitivity/specificity, with patient-cluster CIs, under the run's frozen policy.
- `failure_analysis`: the failure taxonomy (`dermpath.failure_taxonomy/1`). It has `counts`, `counts_by_error_type`, `not_assessable`, `errors: [{bag_id, error_type, reference, predicted, description, relative_margin, categories, details}]`, `policy`, `train_domain` and `notes`. Categories are possible factors, never causes. `small_lesion` uses expert-labelled outlines only. `possible_label_error` needs a confident error plus a reader disagreement on record.
- `classes: {positive: {value, display}, negative: {value, display, note}}`. The negative class (`bcc_absent_not_benign`) is never rendered as benign.
- Also: `bootstrap` (patient-cluster; `seed_source` is the comparison family seed when the run is in a family), `evaluation_protocol`, `n_scored_patients`, `positive_patients`, `negative_patients`, `notes`, `warnings`. Warnings include `threshold_unvalidated: …` when the threshold is a fallback.
- `reference_standard` (`expert` | `imported_reference`, from the frozen manifest). With `imported_reference`, `reference_standard_notice` and a warning state that the labels are an external dataset's own reference (for example report-derived), not expert reads, so metrics measure agreement with that reference, not clinical performance.
- **Test bodies only:** `test_release_id`, `release_number`, `prior_releases_on_manifest`, `test_release_candidate {kind, bundle_id, family_id}`, `test_release_note`, `computed_after_threshold_frozen_at`, `feature_set_id`, `scored_from: "pinned feature-set artifacts (no re-extraction)"`. From the second release on, a warning says how many releases came before.

**Errors** (`GET /experiments/{id}/errors?split=val|oof|test`): each item adds `bag_id`, `description`, `categories`, `category_details`, `relative_margin` and `abstained`. The response adds `categories {counts, counts_by_error_type, not_assessable, policy, notes}`, `classes` and `threshold`. `failure_reason` is unchanged. Test rows use the categories stored at release time.

**Attention:** a prediction without stored attention returns 409 `attention_unavailable`. This applies to test-release predictions, which are scored from pinned features without attention.

**Test releases (new).**
- `POST /experiments/{id}/test-release` (`dataset.test_access`: research lead) with `{reason, justification?, candidate?: "bundle" | "family"}` returns 202 `{test_release, job_id, status}`.
  - The candidate must be declared: the run's registered inference bundle, or a **locked** comparison family containing the run. A family candidate releases every member run.
  - `release_number` counts per manifest (dataset version). From the second release on, `justification` is required (422 `justification_required`, `details.prior_releases_on_manifest`).
  - In the same transaction the split family's test patients are sealed (`dataset.test_patients_sealed`) and job `evaluate_test_release` is enqueued. A family candidate moves to `test_released`.
  - The job scores the test bags only from the run's pinned feature-set artifacts, with `training.score_bags_with_checkpoint`. A missing or corrupt artifact, or a weights, spec or policy sha that differs from the pins, fails the job permanently. Nothing is re-extracted. Test predictions carry `failure_categories_json` and `attributes.test_release_id`.
  - Errors: 422 `reason_required`; 409 `test_locked`, `candidate_required`, `ambiguous_candidate`, `test_already_released`, `feature_set_required` (legacy run), `feature_set_not_ready` (with `missing`), `weights_mismatch`, `manifest_mismatch`, `concurrent_test_release`. Every refusal happens before anything is sealed or recorded.
  - Audit: `test_release.created` (with the reason), `experiment.test_released` per run, `dataset.test_patients_sealed`, and `experiment.test_evaluated` from the worker (with `metrics_sha256` and `predictions_sha256`).
- `GET /experiments/{id}/test-release` (`experiment.read`, read-only) returns `{released, releases, test_evaluation_stored, candidate {kind, bundle_id, family_id, ready, reason}, families, prior_releases_on_manifest, next_release_number, justification_required, blockers, can_release, requires, note}`.
- `GET /test-releases/{id}` and `GET /projects/{pid}/test-releases` return release records: `{id, release_number, prior_releases_on_manifest, candidate_kind, bundle_id, family_id, run_ids, split_family_id, sealed_patient_count, reason, justification, released_by, released_at, job_id, job_status, job_error, evaluations, complete}`.

**Comparison families (new).**
- `POST /projects/{pid}/comparison-families` (`experiment.write`) with `{name, dataset_version_id, plan?, bootstrap_seed?}` returns 201.
- `GET /projects/{pid}/comparison-families` lists families.
- `POST /comparison-families/{id}/members` with `{run_id, role?}` adds a run on the same manifest while the family is open: 201, or 200 when already a member. 409 `family_locked`, 409 `manifest_mismatch`.
- `POST /comparison-families/{id}/lock` with `{reason}` (`experiment.write`). Every member must have finished with a frozen threshold: 422 `reason_required`, 409 `family_not_open`, `family_empty`, `family_members_not_ready`.
- `GET /comparison-families/{id}` (`experiment.read`) returns the family, its `runs`, `winner: null` and:
  - `development_comparison`: a paired patient-level bootstrap on the stored `val` (holdout) or `oof` (dev_cv) predictions, using the family's `bootstrap_seed`, `plan.n_boot` (default 1000, or `?n_boot=`) and exact McNemar. Status `ok`, `refused` (`mixed_protocols`, or different bag sets), `insufficient_members` or `not_available`.
  - `test_comparison`: `locked` until a family test release; `pending` while it is scored; `restricted` for roles without `dataset.test_access`; then `ok`.

**Registry and inference bundles.**
- `POST /experiments/{id}/register` also builds the run's immutable inference bundle. It is idempotent per run and returns 201 when the model version or the bundle is created. The response adds `bundle_id`, `bundle` and `bundle_unavailable_reason`. A legacy run without a pinned feature set gets no bundle and says so.
- `GET /projects/{pid}/models` items add `bundle_id`.
- `GET /bundles/{id}` and `GET /projects/{pid}/bundles` return `{id, run_id, bundle_sha256, object_key, verified, problems, can_infer, inference_refusal, n_predictions, research_use_only: true, content, …}`.
  - `bundle_sha256` is the sha256 of the canonical content and of the stored, write-once, content-addressed object.
  - `content` holds: encoder (`id`, `spec`, `spec_sha256`, `weights_sha256`, `config_sha256`); `patch_policy` (with sampling) and its sha; `stain_policy` = the feature set's **effective** policy (for `macenko-v1` including the reference fitted on train slides) with its `policy_sha256`, plus `declared_policy`/`declared_policy_sha256` (the set's deferred plan) and the reference key and sha; inference verifies the stain policy sha of every extracted artifact; `extraction_env`; `head` (content-addressed checkpoint key and sha); `classes` (with the statement that the negative class is not benign, and the `reference_standard` of the training labels plus `reference_standard_notice` for imported references); `threshold`, `calibration` and `abstention`, verbatim; `code` (`code_tree_sha256`, revision, deps); `dataset_manifest_sha256`; `feature_set` (id, `spec_sha256`).
- `POST /bundles/{id}/infer` (`experiment.write`) with `{slide_id}` returns 202 `{job_id, status, prediction | null}`. It enqueues `infer_slide`, idempotent per bundle and slide.
  - Errors: 409 `mode_mismatch` (a pipeline-test bundle, whose signal is label-derived, or a synthetic demo slide), `bundle_integrity`, `encoder_unavailable`, `slide_not_extractable`; 404 for a slide outside the project.
  - The job checks the bundle, the installed encoder spec sha and the run against the bundle. It extracts label-free through `feature_sets.extract_slide` with the bundle's policies and pinned weights, verifies the artifact identity, scores, and appends one `inference_prediction`. That prediction is never a label and is never routed to care.
- `GET /bundles/{id}/predictions` returns `{items: [{id, slide_id, slide_sha256, score, calibrated_score, threshold, predicted, predicted_class, predicted_display, abstained, unscorable_reason, feature_artifact_id, coverage, input_snapshot, research_use_only: true, is_label: false, notice}]}`. An unscorable slide (for example one refused by the patch policy) is recorded with `unscorable_reason` and a null score.

**Active learning (§9).**
- `POST /projects/{pid}/active-learning` takes `{run_id, dataset_version_id?, k (1–500), random_fraction (0.2), uncertainty_fraction (0.5), seed?}`. It returns 202 `{batch_id, job_id, status, pool_size, pool_exclusions, pool: "development_eligible", creates_labels: false, notice, synthetic, banner}`. 409 `bundle_required` until the run is registered.
- The pool contains QC-eligible slides of the run's data mode whose patient is not sealed and has no test or val assignment (split family or manifest), and that have no reference label or an open reader disagreement, and were never proposed before in the project.
- Candidates are scored out-of-sample through the bundle (they become inference predictions). The batch mixes uncertainty, patient-aware k-centre diversity (at most one slide per patient per batch) and random. A pipeline-test bundle cannot score, so its batches are random only and the batch says so.
- `GET /active-learning/batches/{batch_id}` returns `{status, items: [{slide_id, coded_patient_id, rank, strategy, uncertainty, score, components}], composition, result, …}`. `GET /projects/{pid}/active-learning?run_id=` lists batches. Proposals are append-only `al_proposal` rows and never create labels.

**Review priorities (new).** `GET /projects/{pid}/review-priorities?run_id=&limit=` (`experiment.read`, read-only) ranks two kinds of item for human review:
- open reader disagreements;
- model-vs-reference discordances on stored `val`/`oof` predictions of finished runs (never train, never test; sealed patients are left out).

Tiers: (1) disagreement plus a confident discordance, (2) disagreement, (3) confident discordance (possible label error, not proof), (4) other discordance. Each item has `target`, `reader_disagreement`, `model_discordances`, `tier`, `tier_label`, `reasons`, `rank` and `resolved: false`. Nothing is resolved automatically.

**Job types (new):** `build_feature_set`, `validate_feature_set`, `evaluate_test_release`, `infer_slide`, `active_learning`. Worker processes register them by importing `dermpath.ml.jobs` (listed in `OPTIONAL_HANDLER_MODULES`), which imports `dermpath.ml.feature_sets`, `evaluation`, `inference` and `active_learning` (`ENGINE_HANDLER_MODULES`).

**Training failures.** A train job that has to build its feature set inline fails permanently (one attempt) on deterministic build errors: `feature_set_build_failed: …` (input or extraction environment changed, integrity, per-slide failures), `mode_mismatch: …`, `encoder_unavailable: …`, `device_unavailable: …`. If the queue ends a train job while its set is still `building` and no other queued or running job can finish it, the set becomes `failed`; it is resumable through `POST /feature-sets/{id}/build`.

## Changes made by the ML backend (2026-10-26; all backwards-compatible)
Implemented in `workbench/api/dermpath/ml/`. Everything below the "Changes" section still holds; these notes add to it or make it precise.

- **Who can read:** `experiment.read` is held by `research_lead`, `medical_director` and `pathologist` (the matrix in `dermpath/auth.py`). A `histology_assistant` gets 403 on experiment routes.
- **Test split:** the train job never scores test items. The first `GET /experiments/{id}/evaluation?split=test` (or `/errors?split=test`) by the research lead scores the test split with the stored checkpoint and the frozen threshold. It runs synchronously in that request, then the result is stored and immutable. Every test access writes an audit event: `experiment.test_evaluated` once and `experiment.test_accessed` on each read. An attention request for a slide that has a test prediction goes through the same gate.
- **`POST /projects/{pid}/experiments`:**
  - `seed` is required (an integer from 0 to 2³¹−1).
  - `params` is validated strictly: unknown keys get 422 `invalid_params`. The allowed keys are in `ExperimentParams` in `dermpath/ml/config.py`; they cover patching, the synthetic-fixture controls, the threshold rule (`threshold_rule: "youden" | "target_sensitivity"`, `target_sensitivity`), head hyper-parameters, `n_boot`, `boot_min_patients` and `subgroup_min_n`.
  - `pixel_mode: "none"` skips pixel reads. It is accepted only with an encoder that never reads pixels (the synthetic one).
  - Additional errors:
    - 422: `invalid_head`, `unknown_encoder`, `invalid_seed`;
    - 409 `dataset_not_binary`: the dataset needs exactly two label values;
    - 404: the dataset belongs to another project.
- **Run, additional fields:** `synthetic_reasons`, `notice`, `label_scope`, `positive_class`, `negative_class`, `training_summary`, `feature_summary`, `timings_seconds`, `val_summary`, `unscored_bags`, `started_at`, `test_evaluation_requires`, `checkpoint.format`.
  - `threshold` also carries `selection_status` (`selected` | `fallback`), `reason`, `requested_rule`, `val_sensitivity_at_threshold`, `val_specificity_at_threshold` and `comparison` ("positive if score >= value").
  - When the validation split lacks a class (or is empty), `rule` is `fixed_0.5_fallback` and `reason` explains why.
  - `weights_sha256` is `"synthetic:no-weights"` for the synthetic encoder.
  - `checkpoint` and `threshold` are `null` until `status` is `succeeded`.
  - `status` follows the job: a run re-queued after a retryable failure shows `queued`, with the last error in `error`.
- **`POST /experiments/{id}/cancel`:** 409 `run_finished` if the run has already finished.
- **Evaluation, additional fields:**
  - top level: `run_id`, `label_scope`, `positive_class`, `negative_class`, `n_slides`, `unscored`, `warnings` (small-sample notes), `notice`, `computed_from: "stored prediction rows"`, `evaluation_id`, `computed_at`, `computed_by`;
  - test split only: `computed_after_threshold_frozen_at`;
  - in each metric: `ci_reason`;
  - on `auprc`: `method` (average precision, step-wise) and `prevalence_baseline`;
  - in `bootstrap`: `status`, `n_patients`, `min_patients`, `interval`;
  - in `subgroups`: `positives`, `negatives`, `reason`;
  - on calibration bins: `n` (bins with `n=0` have `mean_score` and `fraction_positive` set to null);
  - on coverage points: `abstained`.
  - Before the run succeeds, `split=val` returns 409 `evaluation_not_ready`.
- **Errors:**
  - `label` and `predicted` are class values (for example `bcc_present`).
  - Each item also has `slide_ids`, `case_id`, `bag_kind` (`slide` | `case`), `threshold` and `attributes`.
  - The response adds `order`, `failure_reason_note`, `synthetic` and `banner`.
  - `failure_reason` reads "possible contributing factor: …". It comes from a QC or calibration snapshot taken at prediction time, and it is never a causal claim.
- **Attention:**
  - Additional fields: `run_id`, `slide_id`, `split`, `bag_kind`, `bag_id`, `coordinate_space: "level0_pixels"`, `weight_normalization`, `bag_weight_total`, `score`, `in_sample`, `banner`.
  - For case bags, weights are normalised over the whole case, which can span several slides.
  - Before success: 409 `evaluation_not_ready`. No prediction for that slide: 404.
- **Register:**
  - Returns 201 on creation and 200 with the existing record when the run is already registered (idempotent).
  - Optional body `{note}`.
  - 409 `run_not_succeeded` if the run has not succeeded.
  - `ModelVersion` adds `project_id`, `checkpoint_sha256`, `deployed: false`, `note` and `notice`. Statuses are `research_candidate` and `retired` only; there is no deploy route.
- **Active learning:**
  - `dataset_version_id` must be the run's own frozen version; otherwise 409 `dataset_mismatch` (404 if it belongs to another project).
  - The run must have succeeded (409 `run_not_succeeded`).
  - `k` is between 1 and 500; `random_fraction` defaults to 0.2; optional `seed`.
  - Items add `slide_ids`, `case_id`, `bag_kind`, `patient_code`, `split: "train"`, and `margin_to_threshold` or `distance_to_selected`.
  - The response adds `run_id`, `dataset_version_id`, `pool_size`, `requested`, `composition`, `creates_labels: false`, `synthetic` and `banner`.
- **Encoder, additional fields:** `reads_pixels`, `banner`. `generic-imagenet-resnet18` is listed. It needs `torchvision` plus `WB_RESNET18_WEIGHTS`, and it reports `missing_dependency` here.
- **New (additive): feature extraction for one slide.**
  - `POST /slides/{id}/features` (`experiment.write`) with `{encoder_id, params?, seed?}` returns 202 `{job_id, status, synthetic, banner}`. It enqueues `extract_features`, which uses no label and so no synthetic class signal.
  - `GET /slides/{id}/features` (`experiment.read`) returns `{items: [FeatureArtifact]}`.
  - Errors: 409 `encoder_unavailable`, 409 `slide_not_extractable`.
- **Demo data:** the seed adds a separate project, `proj-synthetic-cohort`, "Synthetic pipeline-test cohort (no images, no histology)". It holds 60 fictional patients, with one synthetic run per head. Its members are every seeded user except `user-pathologist-2`.

Prefix `/api/v1`, JSON, same error envelope as the core API (`{"error":{"code","message","details"?},"request_id"}`).

Permissions:
- `experiment.read`: every project member;
- `experiment.write`: research lead;
- `model.register`: research lead.

Every result produced from synthetic embeddings carries `synthetic: true` and `banner: "PIPELINE TEST — NOT PATHOLOGY VALIDATION"`.

## Encoders
`GET /encoders` returns `{items: [Encoder]}`.

Encoder fields:
- `id`, `name`;
- `kind`: `synthetic` | `pathology_foundation` | `generic_imagenet`;
- `license`: `{name, url, commercial_use: "no" | "yes" | "unknown", notes}`;
- `status`: `available` | `missing_weights` | `missing_dependency`, with `status_detail` (the exact missing resource, for example the env var and the expected file);
- `weights_sha256` (null unless loaded), `embedding_dim`, `preprocessing_version`;
- `synthetic`: boolean;
- `notice`.

There are at least two encoders:
- `synthetic-deterministic-v1`: always available. It derives embeddings deterministically from the slide sha256, the patch coordinates and the label used for the pipeline-test fixture, so learning is possible. **It carries no pathology information.**
- `uni-v1`: a pathology foundation model. `missing_weights` unless `WB_UNI_WEIGHTS` points to legally obtained local weights **and** `WB_UNI_LICENSE_ACCEPTED=1`. Its license is CC-BY-NC-ND 4.0 (commercial use: no; gated). It never downloads anything.

## Experiments (training runs)
- `POST /projects/{pid}/experiments` with `{dataset_version_id, encoder_id, head: "meanpool_logreg" | "abmil", params?, seed, name?}` returns 202 `{experiment: Run, job_id}`.
  - 409 `dataset_not_frozen`
  - 409 `encoder_unavailable` (`details.status_detail`)
  - 422 for invalid params
- `GET /projects/{pid}/experiments` returns `{items: [Run]}`. `GET /experiments/{id}` returns a Run.
- `POST /experiments/{id}/cancel` returns a Run.

Run fields:
- identity: `id`, `name`, `project_id`;
- inputs: `dataset_version_id`, `dataset_name`, `dataset_manifest_sha256`, `encoder_id`, `head`, `params`, `seed`;
- job: `status` (`queued` | `running` | `succeeded` | `failed` | `canceled`), `job_id`, `progress` (0–1), `progress_message`;
- labelling: `synthetic`, `banner`;
- provenance: `code_revision`, `deps` (package → version), `weights_sha256`;
- outputs:
  - `checkpoint`: `{object_key, sha256, bytes}`;
  - `threshold`: `{value, selected_on: "val", rule, frozen_at}`;
  - `split_counts`: `{train, val, test}`, patients and items;
- record: `created_by`, `created_at`, `finished_at`, `error`, `registered_model_id`.

## Evaluation
`GET /experiments/{id}/evaluation?split=val|test` returns:
- `split`, `n_items`, `n_patients`, `positives`, `negatives`;
- `confusion`: `{tp, fp, tn, fn}`;
- `metrics`: each of `sensitivity`, `specificity`, `ppv`, `npv` is `{value | null, numerator, denominator, ci: [lo, hi] | null, undefined_reason | null}`; `auroc` and `auprc` are `{value | null, defined: bool, undefined_reason | null, ci | null}`;
- `calibration`: `{bins: [{lo, hi, mean_score, fraction_positive, n}], brier, ece, note: "scores are not probabilities unless calibrated"}`;
- `coverage_curve`: `[{coverage, error_rate, n_kept}]` (abstention trade-off);
- `subgroups`: `[{key: "scanner_id" | "site_id" | "stain", value, n, status: "ok" | "insufficient_evidence", metrics | null}]`;
- `bootstrap`: `{method: "patient_cluster", n_boot, seed}`;
- `synthetic`, `banner`, `threshold`.

Rules:
- The test split is available only after the threshold was frozen on `val`, and only to the research lead (audited). Otherwise 409 `test_locked` or 403.
- `GET /experiments/{id}/errors?split=val|test` returns `{items: [{slide_id, patient_code, label, score, predicted, error_type: "false_negative" | "false_positive", attention_available, failure_reason | null}], counts}`.
- `GET /experiments/{id}/attention/{slide_id}` returns `{kind: "attention", notice: "Attention weights — not tumour segmentation and not a causal explanation", synthetic, patches: [{x, y, w, h, weight}]}` with patch boxes in level-0 pixels. It returns 409 `attention_unavailable` for `meanpool_logreg`.

## Model registry and active learning
- `POST /experiments/{id}/register` returns `ModelVersion {id, run_id, status: "research_candidate", created_by, created_at, synthetic, banner}`. It never deploys anything.
- `GET /projects/{pid}/models` returns `{items: [ModelVersion]}`.
- `POST /projects/{pid}/active-learning` with `{dataset_version_id, run_id, k, random_fraction}` returns `{items: [{slide_id, reason: "uncertainty" | "diversity" | "random", score | null}], pool: "train_only", notice}`. It **never** returns test items, and never creates expert labels.

## Feature extraction (real-data path)
The job type `extract_features` runs: frozen dataset item → tissue mask (from QC) → tissue coordinates at a calibrated scale (respecting excluded regions) → patches → encoder → embeddings cached by `(slide_sha256, encoder_id, weights_sha256, preprocessing_version, patch_size, target_mpp | level, coords_sha256)`.

The status is exposed on the Run (`progress_message`). With `synthetic-deterministic-v1` on a real slide this is still a **pipeline test**.
