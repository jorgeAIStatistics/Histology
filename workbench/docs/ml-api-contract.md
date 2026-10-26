# ML API contract (shared by the ML backend and the frontend)

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
