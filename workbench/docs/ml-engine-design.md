# ML engine upgrade: design contract (2026-10-26)

*Research use only. This document is the contract that every implementation step of the engine upgrade follows. It records decisions, interfaces and invariants. Where code and this document disagree, fix the code or update this document in the same change, with the reason.*

Priority order: **correctness → real-image execution → reliable baselines → evaluation → targeted optimisation.** "Better model" means better performance, reliability or efficiency on a defined independent dataset. Architecture complexity and synthetic accuracy are not evidence.

The audit that motivated this design is summarised in `docs/ml-engine-report.md` (written at the end of the upgrade). It found 15 critical and 32 high findings, among them:
- the stratification defect, where 10 positive and 90 negative patients put all 10 positives in train;
- label-derived synthetic signal reaching real-image and test embeddings;
- unfrozen feature-generation inputs, where test scoring re-extracts with the current mask and weights;
- a stale in-memory encoder cache;
- the same validation split used for early stopping, threshold and report;
- no test-release discipline.

---

## 1. Execution modes

| Mode | Purpose | Encoders | Data | Labels |
|---|---|---|---|---|
| `synthetic_pipeline_test` | Exercise orchestration end to end | `synthetic-deterministic-v1` only | dataset `data_mode == "synthetic"` (every item `provenance == demo_synthetic` and `image_kind == synthetic_tiles`) | a label-derived fixture signal is allowed, **only** through `ml/fixture.py` |
| `real_image_technical` | Pixel path on real slides: extraction, coverage, determinism, throughput, memory | any encoder that reads pixels | real slides (`public_cc0`, `public_licensed` or `real_authorized`), labelled or not | **none**: no label is read anywhere in this mode |
| `supervised_experiment` | Pathology experiments on labelled cohorts | non-synthetic encoders | dataset `data_mode == "real"`, calibrated WSIs, expert labels (or imported reference labels, see below) | expert reference labels for train and val, or imported reference labels when the frozen dataset declares `reference_standard: imported_reference` (recorded in the manifest; results then measure agreement with that external reference, and every evaluation body and bundle says so); test labels only at a recorded test release |

**Invariants (each covered by tests):**
1. A dataset never mixes `demo_synthetic` items with real items. `data_mode` is computed from the included items and recorded in the manifest. Mixing is refused (`409 mixed_data_mode`) at freeze, and reported at materialise and in freeze-check.
2. A synthetic encoder is refused unless the mode is `synthetic_pipeline_test` and the manifest's `data_mode` is `synthetic`. A non-synthetic encoder is refused on a synthetic dataset in `supervised_experiment` mode. Both are checked at creation (`409 mode_mismatch`) **and again in the worker**.
3. Real encoder adapters receive an `EmbedContext` type that has **no label field**. The synthetic signal lives only in `ml/fixture.py`. Its `FixtureContext` can be constructed only by `fixture.fixture_context(...)`, which raises `SyntheticSignalForbidden` unless the slide is `demo_synthetic` + `synthetic_tiles` and the mode is `synthetic_pipeline_test`.
4. No job payload carries a label or a fixture label. Fixture labels are derived inside the worker from the frozen manifest.
5. `run.synthetic` is derived (encoder synthetic, or `data_mode == synthetic`) and re-derived in the worker. On disagreement the run fails permanently.

**Implemented differently (verification round, recorded with the reason):**
- *Legacy extraction route.* Invariant 2 has no exception: `POST /slides/{id}/features` and its `extract_features` job refuse the synthetic encoder unless the slide is `demo_synthetic` + `synthetic_tiles` (`409 mode_mismatch`), and refuse calibrated slides that would be upsampled (`422 scale_refused`), like the feature-set path.
- *Label carrier.* `EmbedContext(..., fixture_label=…)` still returns an inert `LegacySyntheticContext` (so old callers fail loudly, not silently), but every adapter, the synthetic one included, refuses it, and `legacy_synthetic_embeddings` is label-free. The legacy path applies a labelled pipeline-test signal only through `fixture_context` + `synthetic_embeddings`.
- *Invariant 4.* One shared guard (`jobs.registry.refuse_label_payload`, keys `label`, `labels`, `fixture_label`, `label_value` at any depth) runs first in every engine handler.

## 2. Patient splits (`dermpath/splits.py`, pure functions, no DB)

- **Patient key for ordering** is content-stable: `sha256(f"{salt}|{patient_code}")`, never uuids and never `random.shuffle`. `salt = f"{family_salt}|{seed}"`.
- **Patient label for stratification**, declared as `patient_label_rule`:
  - `any_positive` (default): a patient is positive if any included bag is the positive class;
  - `majority`: ties break toward positive, deterministically.

  Mixed-label patients (bags of different labels) are counted and listed in diagnostics. The rule only stratifies; every bag keeps its own label.
- **Stratified grouped allocation:**
  - Per stratum, target counts per split come from largest-remainder rounding of `ratio × n_stratum`.
  - Every split with `ratio > 0` gets at least one patient of each class whenever the class has at least as many patients as there are such splits. Units are moved from the split with the largest surplus, preferring train.
  - When that is impossible, the allocation still succeeds and `diag["class_absent"]` lists `{split, class}`. Freeze-check reports it as a warning that needs acknowledgement (the existing freeze-acknowledgement flow).
- **Grouping constraints:** near-duplicate pairs a person marked `duplicate` join their patients into one unit (union-find), and the unit is allocated as a whole. `unsure` keeps blocking freeze like an unreviewed pair; only `distinct` clears the warning.
- **Temporal:**
  - a patient is assigned by their latest case date (unchanged);
  - `val_cutoff < test_cutoff` is validated;
  - unused `seed` and `ratios` are rejected, not stored;
  - the label × split report and empty or single-class warnings are added.
- **External site:**
  - `test_sites` are validated against the project's known `Case.site_id` (`422 unknown_site`);
  - site membership uses **all** of the patient's cases in the project;
  - patients with an unknown site are reported;
  - the train/val remainder uses the stratified allocator;
  - `ratios.test` is rejected for this partition.
- **Diagnostics** include per split × class patient counts and slide counts. They are persisted in the dataset config and the manifest on every path (create, refresh, new version, POST splits), not only on POST splits.

### Split families (stability across versions)

Tables are in `dermpath/models.py`:
- `split_family`: `id`, `project_id`, `lineage_id` (unique), `salt`, `partition_json`, `created_at`, `created_by`;
- `split_family_assignment`: `family_id`, `coded_patient_id`, `patient_code`, `split`, `first_version_id`, `sealed_at` (nullable), `sealed_reason`; unique on (`family_id`, `coded_patient_id`).

Rules:
- The first assignment in a lineage creates the family.
- Child versions (`new_version`) **inherit** every existing patient's split, whatever label changes happen. Only patients new to the family are allocated, deterministically by hash, toward the per-stratum targets given the existing counts.
- Changing a child's partition or seed is refused (`409 family_split_locked`) unless the caller starts a new lineage with a reason.
- Patients become **sealed** when a test release happens on any version of the lineage (all its test patients). Sealed patients can never change split, and freeze verifies it.
- Every manifest records `split_family_id`, a `split_fingerprint` (sha256 over the sorted (`patient_code`, split) pairs), and the counts inherited, new and dropped.

**Implemented differently (verification round, recorded with the reason):**
- *Sealing is project-wide.* A seal applies to the patient in every lineage of the project, not only in the releasing lineage and its descendants: otherwise a fresh root dataset, or a child of another lineage, put sealed test patients in train. New allocations pin sealed patients to test; freeze refuses `409 sealed_patient_moved` when an inherited split contradicts a seal from another lineage (start a new lineage instead), and `409 sealed_slide_moved` when a slide that was a test item of a sealed patient (what a release looked at) is outside test, for example after a lineage correction moved it to another patient. Both are also freeze-check blockers.
- *Class presence with families and units* (`dermpath.splits/3`). The deficit fill can leave a split without a class when inherited or sealed patients overshoot a target, or when grouping units are not singletons. A repair step then moves one newly allocated unit (from the split with the largest surplus, train on ties; the smallest unit; the donor keeps one) into each active split still missing the class. Allocations that were already complete are unchanged. Largest remainder is computed in exact rationals so ties follow the split order.
- *Rule exceptions are named.* Temporal and external-site diagnostics list every patient whose split contradicts the partition rule (`against_rule`; inherited ones in `inherited_against_rule`, unit members in `unit_members_against_rule`).
- *Diagnostics at freeze.* `freeze()` writes the re-plan's diagnostics into the manifest (the mapping is unchanged, else `draft_stale`), so date ranges, spanning counts and per-site tables are those of the frozen inputs.

### Freeze and dataset items

- `freeze()` re-materialises inside the same transaction and refuses with `409 draft_stale` (and the diff) if eligibility, labels, lineage or provenance changed since the draft was last materialised.
- `DatasetItem` snapshots its lineage at materialise time: `patient_code`, `accession_code`, `part`, `block`, `site_id`, `collected_on`, `scanner_id`, `stain`, `mpp_x`, `mpp_y`, `image_kind`, `provenance`, `label_source`. `item_rows` uses only the snapshot, never live lineage.
- The manifest additionally records:
  - `data_mode`;
  - `patient_label_rule`;
  - the near-duplicate decisions in force;
  - `split_family_id`, `split_fingerprint` and `split_diagnostics`;
  - per-item `qc_review_id`, `mask_sha256` and `excluded_regions_sha256`;
  - the dataset `audit` block (§9);
  - `python_version`.
- `freeze_warnings` adds:
  - `class_absent` (single-class or empty splits);
  - `mixed_label_patients` (informational);
  - near-duplicate decisions `unsure`;
  - `uncalibrated_items` (supervised use needs calibration).

  Each needs the existing acknowledgement with a reason.
- `include_provenance` keeps its default, but the included items must resolve to one `data_mode`.

## 3. Encoders (`dermpath/ml/encoders.py`, plus `ml/handcrafted.py` and `ml/fixture.py`)

```python
@dataclass(frozen=True)
class EncoderSpec:
    id: str; name: str; kind: str            # synthetic | handcrafted | pathology_foundation | generic_imagenet
    adapter_version: str                      # bump on any code change that alters outputs
    architecture: dict                        # e.g. {"library":"timm","model":"vit_large_patch16_224","kwargs":{...}}
    input_size: int                           # pixels; patches arrive at exactly this size
    resize_policy: str                        # "none: patches arrive at input_size at the target mpp" (documented equivalence to the official Resize/CenterCrop)
    mean: tuple[float, float, float]; std: tuple[float, float, float]
    embedding_dim: int
    pooling: str                              # e.g. "timm_global_pool_token", "cls+mean_patch_concat"
    weights_format: str | None                # "torch_state_dict" | "safetensors" | "hf_dir" | None
    weights_env: str | None; license_env: str | None
    expected_weights_sha256_env: str | None   # optional pin, e.g. WB_UNI_WEIGHTS_SHA256
    license: dict; reads_pixels: bool; synthetic: bool; notice: str
    official_reference: dict                  # URLs and the claims verified against them
    def spec_sha256(self) -> str              # sha256 of canonical JSON of the output-affecting fields
```

- `adapter.status() -> (status, detail)` uses the existing statuses plus `weights_mismatch`.
- `adapter.load(*, expected_weights_sha256=None, device="cpu", precision="fp32") -> LoadedEncoder`:
  - it reads the weights bytes **once**, hashes those bytes and builds the model from the same buffer;
  - the in-process cache is keyed by (`encoder_id`, `weights_sha256`, `device`, `precision`), and a changed file means a new key, so a stale model is never served;
  - it raises `EncoderIdentityMismatch` when `expected_weights_sha256` is given and differs;
  - strict state-dict loading: missing or unexpected keys fail loudly.
- `LoadedEncoder` has `spec`, `weights_sha256`, `device` and `precision`, and `embed_batch(patches_uint8: np.ndarray[N,H,W,3]) -> np.ndarray[N,D] float32`. It asserts `H == W == spec.input_size`; there is **no resizing inside the encoder**. It runs under `torch.inference_mode()` with deterministic settings (fixed thread count on CPU).
- `file_sha256` memo key: (`st_dev`, `st_ino`, `st_size`, `st_mtime_ns`, `st_ctime_ns`).

Adapters to deliver:
- `synthetic-deterministic-v1`: hermetic; refuses outside `synthetic_pipeline_test` (through `fixture.py`).
- `handcrafted-stain-texture-v1`: **no weights, reads pixels, no labels**; a technical baseline and not a pathology foundation model. Deterministic numpy features (about 64-d):
  - RGB and optical-density statistics;
  - Ruifrok–Johnston H&E deconvolution channel statistics;
  - pixel tissue fraction;
  - log Laplacian variance;
  - gradient-magnitude statistics;
  - an LBP histogram.

  Its identity is a weights-free code hash (`handcrafted:<adapter_version>:<sha of its source>`).
- `uni-v1`: the timm `vit_large_patch16_224` kwargs exactly as in the official release (`img_size=224, patch_size=16, init_values=1e-5, num_classes=0, dynamic_img_size=True`), strict load of `pytorch_model.bin`, ImageNet mean/std, 1024-d. CC-BY-NC-ND and gated: needs `WB_UNI_WEIGHTS` + `WB_UNI_LICENSE_ACCEPTED=1`. Commercial use, including models trained on UNI outputs, needs prior approval.
- Second pathology encoder, on a configurable Dinov2 (transformers) adapter, offline only (`local_files_only=True`, `trust_remote_code=False`, `HF_HUB_OFFLINE=1`):
  - `midnight-12k` (kaiko-ai): MIT, ungated, native `Dinov2Model`, mean/std 0.5, 224, CLS + mean-patch concat, 3072-d, 4.55 GB;
  - `hibou-b` (histai): Apache-2.0 weights, gated click-through, ViT-B/14 with 4 registers, 768-d; preprocessing constants provisional until its config can be read. Loaded **without** remote code by mapping onto the native register-token Dinov2 architecture; parity is unverified until weights are available.
- `generic-imagenet-resnet18`: kept as it is.

**Tests use tiny random-initialised models built through the same builders** (timm ViT, transformers Dinov2). They cover:
- hash binding;
- cache invalidation after a weights change;
- `EncoderIdentityMismatch`;
- strict-load failure;
- output dimension;
- preprocessing constants;
- refusal of wrongly sized patches;
- fp32 and fp16/bf16 comparison utilities.

Pinned libraries (timm, safetensors, transformers) are installed from PyPI, choosing versions published at least 14 days before 2026-10-26, with their licences recorded in `docs/license-ledger.md`. **No model weights are downloaded.**

**Device and precision:**
- `WB_ML_DEVICE`: `auto` (cuda, then mps, then cpu) or an explicit device. It is recorded per artifact.
- The default precision is fp32. fp16/bf16 are allowed only by an explicit parameter, and `compare_precision(loaded_fp32, loaded_lowp, patches)` reports cosine similarity and the maximum absolute difference. Low precision is never the default without that evaluation.

## 4. Patching, sampling, coverage, stain (`ml/patching.py`, `ml/sampling.py`, `ml/coverage.py`, `ml/stain.py`; pure, no DB)

`PatchPolicy` (frozen dataclass, canonical JSON, `policy_sha256`):
- `target_mpp` (0.5);
- `patch_size`, which must equal the encoder's `input_size`;
- `min_tissue_fraction` (0.25);
- `stride_fraction` (1.0);
- `edge_mode="shift_inward"`: the last row and column are shifted inside the image, so tissue touching the right or bottom edge is covered and no area is lost;
- `fragment_rescue_min_area_um2`: tissue fragments with no candidate get one tissue-centred patch;
- `max_upsample_ratio` (1.05): refuse slides scanned coarser than the target beyond this, with `ScaleError` and reason `would_upsample`;
- `anisotropy_tolerance` (0.10);
- `allow_uncalibrated` (False: uncalibrated slides are refused outside the synthetic and technical modes);
- `read_filters`:
  - `background_at_read` (reject a patch whose pixel tissue fraction is below `min_tissue_fraction`);
  - `pen_marks` (hue rules for blue, green and black ink: reject above a fraction);
  - `blur_flag` (record Laplacian variance; never reject by default);
- `sampling: SamplingPolicy(strategy, max_patches, seed)`.

Functions:
- `plan_scale(...) -> PatchPlan`: records `effective_mpp_x/y`, `read_level`, `read_size`, `upsample_ratio`, `calibrated`.
- `candidate_grid(dims, plan, mask, mask_ds, excluded, policy) -> Candidates`: coords plus per-cell tissue fraction plus rejection counts by reason.
- `sample(candidates, policy, *, permitted_lesion_regions=None) -> (coords, stats)`. Strategies:
  - `all`: every candidate, with a hard safety cap that is recorded;
  - `uniform`: a seeded subset;
  - `spatial`: deterministic spatial stratification, the farthest-point / blocked selection on the candidate grid with a seeded tie-break;
  - `lesion_aware`: **experimental**. It accepts only regions explicitly passed as permitted, which means expert annotations on train-split slides. It refuses to run without them and is never used for val or test.

  The sampling seed is **independent of the training seed** (`sampling.seed`), so head-seed variance and sampling variance are not confounded.
- `iter_patch_batches(osr, coords, plan, *, batch_size) -> Iterator[(coords_batch, uint8[B,H,W,3], read_stats)]`: bounded memory, one batch at a time, a single resize from read size to `patch_size` with a recorded filter (BILINEAR on PIL) and the background fill recorded.
- `patch_quality(batch) -> dict of arrays`: pixel tissue fraction, pen fraction, Laplacian variance, mean RGB.
- `coverage(...) -> dict`:
  - `tissue_area_um2`;
  - `candidate_tissue_area_um2`, `sampled_tissue_area_um2` and `excluded_area_um2`;
  - `edge_uncovered_tissue_area_um2` (0 with `shift_inward`);
  - `fragments_total`, `fragments_without_candidate` and `fragments_rescued`;
  - `tissue_within_radius_of_sample_fraction` (radius in µm);
  - `rejected_at_read` by reason;
  - `mask_um_per_px`.

  Mask resolution is reported, and masks coarser than a floor are flagged.
- `stain.py`:
  - `none`;
  - `macenko-v1`: `fit_reference(train_patches)`, fitted **only** on train-split patches and stored with the feature set; `apply(batch, reference)`.

  Versioned. Never fitted on validation or test images. Any change to stain policy produces a new feature set, so ablations compare feature sets.
- **Multiscale is not added.** It is documented as the next step once a single-scale baseline exists on labelled data.

## 5. Feature sets (`ml/feature_sets.py`, `ml/features.py`)

A **feature set** is the frozen, immutable specification of how embeddings are produced for a list of slides. Experiments and test scoring use **only** its pinned artifacts.

Tables are in `ml/engine_models.py`.

`feature_set` columns:
- `id`, `project_id`, `name`;
- `execution_mode`;
- `dataset_version_id` (nullable for technical sets on explicit slides);
- `encoder_id`, `encoder_spec_json`, `encoder_spec_sha256`, `weights_sha256`;
- `patch_policy_json`, `policy_sha256`;
- `stain_policy_json`;
- `extraction_env_json`, `extraction_env_sha256`;
- `input_snapshot_json`, `input_snapshot_sha256`;
- `spec_sha256` (over everything above);
- `status` (`building|ready|failed`);
- `created_by`, `created_at`, `ready_at`, `error`.

`feature_set_item` columns: `feature_set_id`, `slide_id`, `slide_sha256`, `artifact_id`, `status`, `coverage_json`, `error`; unique on (`feature_set_id`, `slide_id`).

**Input snapshot** per slide, taken at feature-set creation:
- `slide_sha256`, `object_key`, `mpp_x/y`, `width`, `height`, `level_downsamples`;
- `qc_review_id`, `mask_object_key`, `mask_sha256`, `mask_downsample`;
- `excluded_issue_ids`, `excluded_regions_sha256`.

Extraction reads only the snapshot. It verifies the mask object's sha256, and the slide file's sha256 by streaming before the first extraction of that slide in a process. On mismatch it refuses with `FeatureError("input_changed: …")`. QC changes after the snapshot **never** change an existing feature set; they surface as staleness.

**Feature artifact** (cache entry, content-addressed): the cache key covers:
- `slide_sha256`;
- `encoder_spec_sha256` and `weights_sha256`;
- `policy_sha256` and the stain-policy sha;
- `mask_sha256` and `excluded_regions_sha256`;
- `coords_sha256`;
- `extraction_env_sha256`, which covers library versions (openslide C library, openslide-python, pillow, numpy, torch, timm, transformers, safetensors), device class and precision.

Storage format:
- embeddings stored as a `.npy` float32 object written by streaming (memmap in a temp file), so loaders can memory-map;
- `coords`, `patch_quality` and `meta` in a small `.npz`;
- both objects content-addressed and write-once (`put_if_absent`).

The DB row records both shas. A row whose object is missing or corrupt is never served: extraction writes a new content-addressed object and a new row version.

Extraction:
- streaming batches (`WB_ML_BATCH_SIZE`, default 32);
- bounded memory (one batch of patches plus the output memmap);
- device and precision from the request;
- per-slide stats: read, preprocess and embed seconds, patches per second, peak RSS delta, cache hit;
- the loaded encoder's `weights_sha256` must equal the feature set's `weights_sha256` before anything is written.

**Implemented differently from the text above (phase 3, recorded with the reason):**
- *QC snapshot source.* Sets built from a dataset version snapshot the QC state frozen in the manifest (`qc_review_id`, mask key and sha, excluded issue ids, regions sha), verified against the stored objects (`409 input_changed` when it cannot be reproduced), so the set and the manifest agree per item. Only explicit-slide sets snapshot live QC at creation.
- *`macenko-v1`.* The reference is fitted at **build** time, on up to 32 seeded train-split slides × 8 seeded patches, stored content-addressed (`stain_reference_key/sha256`). `stain_policy_json` holds the declared, deferred plan (`deferred: true`, train slide ids, fit settings); artifacts and inference bundles carry the **effective** policy (with the reference) and its sha. Macenko on explicit slides (no dataset) is refused (`422 stain_reference_needs_dataset`).
- *Extraction parameters.* There is no column for them, so `encoder_spec_json` = the spec's output fields + `weights_config_sha256` (hf_dir config) + `encoder_config` (synthetic fixture) + `extraction {pixel_mode, batch_size, device, cpu_threads, extractor_version}`. Licence and notice text are excluded so text edits do not orphan sets.
- *Worker environment check.* A build refuses (`extraction_env_changed`) when the worker's library versions, device class, precision, machine or torch CPU thread count differ from the set's. The device is resolved once at creation and pinned; numpy encoders always record cpu/fp32.
- *Repair pass.* Building a `ready` set verifies every pinned artifact and re-extracts missing or corrupt ones as a new generation under the same cache key; items stay pinned and `load_slide_features` serves the newest valid generation.
- *Sampling seed.* The synthetic fixture embeddings use the feature set's `sampling_seed` (default 0), not the training seed, so runs with different training seeds share one set.
- *Coverage floor.* `COVERAGE_FLOOR = 0.5` on `tissue_within_radius_of_sample_fraction` is an untuned research default. Torch technical-validation tolerances (1e-4 abs, cosine 0.9999) are proposals not yet measured on real weights.
- *Inline builds.* A train job builds its run's set inline when it is not ready. Deterministic build failures (input or environment changed, integrity, mode) fail the run permanently; if the queue ends the train job while the set is still `building` and no other job can finish it, the set becomes `failed` (resumable).

**Implemented differently (verification round, recorded with the reason):**
- *Extraction code identity.* The set's pinned `extraction.extractor_version` is compared with the running `EXTRACTOR_VERSION` before every build, repair and technical validation (`extraction_code_changed`), and `load_slide_features` checks it on every artifact, so one set never mixes extractor versions. `EXTRACTOR_VERSION` is now `dermpath.feature_sets/2` (the changes below alter coordinates or coverage for some slides); sets pinned to `/1` stay readable but cannot be extended or repaired.
- *Repair reproducibility.* A newer generation replaces a pinned artifact only when it reproduces the pinned embeddings and coords/quality sha256 (deterministic encoders repair transparently); otherwise reads refuse `repair_not_reproducible` and the repair report lists the slide. An appended row with other numbers is never served.
- *Read footprint.* After choosing the level, the plan's extent is the level-0 rectangle of the actual read (`ceil(read × downsample)`), and the effective mpp is that of the footprint, so exclusion checks and coverage contain every pixel read.
- *Exclusion geometry.* Exclusions use the nonzero winding rule (a lasso drawn twice around a fold excludes its inner loop), evaluated in blocks of edges so memory does not grow with the outline's vertex count (up to `annotations.MAX_POINTS`). Excluded areas are rasterised by the same pixel-centre rule as candidate coverage.
- *Rescued fragments.* When the tissue-centred rescue patch touches an exclusion, aligned placements that still contain the anchor pixel are tried. `uniform`, `spatial` and `lesion_aware` sampling keep `fragment_rescue` candidates ahead of the strategy (up to the budget), and coverage reports `fragments_without_sampled_patch` and the sampled origins.
- *Embedding sink.* The trimmed `.npy` copy is bounded by the kept rows, so read-time rejections (pen, background) never break a build.

Build job `build_feature_set`:
- resumable: slides already `done` are skipped;
- cancellable;
- idempotent per (`feature_set_id`, `slide_id`);
- builds features for **all splits, test included**, without reading any label.

API (router `ml/router_features.py`):
- `POST /projects/{pid}/feature-sets` (`experiment.write`) with `{dataset_version_id | slide_ids, encoder_id, execution_mode, patch_policy?, stain_policy?, device?, precision?}`;
- `GET /feature-sets/{id}`, which includes aggregated coverage diagnostics:
  - per-slide table;
  - min/median/max coverage;
  - slides with zero patches;
  - slides below the coverage floor;
  - the uncalibrated count;
- `GET /projects/{pid}/feature-sets`;
- `POST /feature-sets/{id}/technical-validation`, which re-extracts a seeded subset and checks determinism (maximum absolute difference, identical coords) and records throughput and memory.

## 6. Training, heads, protocols (`ml/training.py`, `ml/heads.py`, `ml/cv.py`, `ml/service.py`, `ml/benchmark.py`)

- `create_experiment` takes:
  - `execution_mode` (inferred when absent: a synthetic encoder means `synthetic_pipeline_test`, otherwise `supervised_experiment`);
  - `feature_set_id`, optional; when absent a matching feature set is created or reused, so the old API keeps working;
  - `evaluation_protocol`: `holdout` (default) or `dev_cv` (k folds, default 5);
  - `threshold_rule`, prespecified;
  - `calibration`: `none`, `platt` or `isotonic`;
  - `abstention`: `none` or `{target_coverage}`;
  - `family_id` (comparison family, optional).

  It validates mode compatibility and freezes **run identity** into `identity_json`/`identity_sha256`:
  - `code_tree_sha256`, `code_revision` and deps;
  - `encoder_spec_sha256` and `weights_sha256`;
  - `feature_set.spec_sha256`;
  - `dataset_manifest_sha256`;
  - `params_sha256` and seed;
  - `split_fingerprint`.
- Every attempt appends a `run_attempt` row. At start it recomputes the identity and fails permanently with `run_identity_changed` (listing the differing fields) instead of overwriting.
- Checkpoints are content-addressed and write-once. The final commit is fenced by the job lease.
- Bags are ordered by content-stable keys (`patient_code`, `accession_code`, `slide_sha256`). Embeddings are loaded lazily (memory-mapped), never all at once. Mean-pool features are streamed. ABMIL subsamples instances per epoch (`max_instances_per_bag`, seeded, recorded).
- **Roles of data are separated:**
  - Early stopping for ABMIL uses an **inner patient-grouped stratified split of train** (`inner_val_fraction`, default 0.2, seeded); validation is never used for it.
  - With `holdout`, the threshold, calibration and abstention policy are selected on **val**. Threshold-dependent val metrics are labelled `tuning_set: true` ("optimistic: the threshold was chosen on these data"), and threshold-free metrics are reported separately.
  - With `dev_cv`: patient-grouped stratified K-fold over the development pool (train ∪ val); out-of-fold predictions; threshold, calibration and abstention chosen on the OOF predictions; the final model refit on the full development pool; test untouched.
- **Class imbalance:**
  - `class_weight` is respected by **both** heads (`balanced` or `none`);
  - weights are computed on the training data only, and so are the scaler and normalisation statistics;
  - the effective sampling distribution is recorded (class counts, weights, effective positive fraction).
- Bag scopes: a slide label stays on its slide, and a case label on its case bag, never copied to slides or patches (unchanged, now tested explicitly).
- **Learning curves** (`benchmark.learning_curve`):
  - nested, stratified, deterministic subsets of **train patients** (fractions such as 0.1, 0.25, 0.5 and 1.0, with several repeats);
  - evaluated on val or OOF, never test;
  - reported with patient counts and CIs.
- **Benchmark harness** (`benchmark.run_benchmark(config)`):
  - an encoder × head grid on **one** frozen manifest and identical patient splits;
  - one feature set per encoder, with the same patch and sampling policy across encoders;
  - equal optimisation budgets, documented per head;
  - results grouped in a `comparison_family`;
  - encoder effects compared with the head fixed, and head effects with the encoder fixed;
  - paired comparisons from §7.
  - Configurations are JSON files under `workbench/experiments/configs/`, and the CLI is `python -m dermpath.ml.cli`.

**Implemented differently from the text above (phase 3, recorded with the reason):**
- *Identity dependencies.* Run identity pins a training-relevant subset (numpy, scipy, scikit-learn, torch, python, implementation, machine); the full `dependency_versions()` is recorded on every `run_attempt`, and feature-extraction libraries are pinned by the feature set's `extraction_env_sha256`. Pinning every package caused spurious `run_identity_changed` between API and worker processes.
- *Code drift.* An attempt also fails `run_identity_changed: code_tree_drift` when any `dermpath/*.py` file changed since the worker process started; restart workers after deploying code.
- *Folds and seeds.* `dev_cv` folds depend only on the development pool and k (salt `<family salt>|cv|k=<k>`), not on the head seed, so every run on a manifest shares its folds and OOF set. The ABMIL inner early-stopping split depends on the seed (`<family salt>|inner|<seed>`); learning-curve subsets use `<family salt>|lc`. In `dev_cv` a learning-curve fraction restricts each fold's fitting part and the refit, so every point is evaluated on the same full OOF set.
- *ABMIL fitting.* ABMIL is fitted on the inner fit part of the training patients (default 80 %); the inner hold-out is used only for early stopping, with the same class-weighted BCE, and there is no refit on all of train.
- *Operating point.* Decisions (`predicted`, `abstained`) use the raw score against the frozen threshold; the calibration map (fitted on the same development scores) is applied for reporting as `calibrated_score`. Under `dev_cv`, calibration fitted on pooled OOF scores of the fold models is applied to the refitted final model (a standard approximation, not validated beyond the synthetic pipeline). The evidence rule is one parameter, `min_threshold_evidence` (patients per class, default 10); below it the threshold falls back to 0.5, recorded as `insufficient_evidence` with a `threshold_unvalidated` warning. `tuning_set` is true only when the threshold was selected on those data.
- *Unscorable folds.* A `dev_cv` fold whose fitting part lacks a class is not fitted; its held-out bags are recorded as unscorable (counted in intention-to-evaluate), never imputed.
- *Outputs.* Prediction rows carry `calibrated_score`, `fold` and `manifest_split` in `attributes_json`; `train` rows under `dev_cv` are the final model's in-sample scores on the whole development pool. Checkpoints are `dermpath.checkpoint/2` (`/1` still loads). Legacy runs without identity, mode or feature set fail permanently with `legacy_run`.
- *Labels.* Training labels must satisfy `labels.label_source_permitted(source, manifest.config.reference_standard)`; model suggestions never qualify.
- *Run provenance (verification round).* `code_revision` and `deps_json` are part of the immutable run identity columns from creation.

## 7. Evaluation (`ml/metrics.py`, `ml/comparison.py`, `ml/calibration.py`, `ml/failure.py`, `ml/evaluation.py`)

- Metrics at the prespecified operating point:
  - sensitivity and specificity, with numerator, denominator and CI;
  - AUROC and AUPRC (tie-correct), plus the prevalence baseline for AUPRC;
  - PPV and NPV **with the evaluation prevalence stated**, and prevalence-adjusted PPV/NPV when a target prevalence is declared;
  - Brier score, ECE and a calibration curve (raw and calibrated);
  - patient-clustered bootstrap CIs, resampling patients with all their bags.
- **Unscorable bags count.** `n_unscorable` is reported. "Scored-only" metrics and an "intention-to-evaluate" sensitivity, in which unscorable positives count as missed, are both shown.
- Paired comparison (`comparison.py`):
  - two or more runs on the identical bag and patient set (verified);
  - patient-level paired bootstrap with a shared seed per family, for ΔAUROC, ΔAUPRC, Δsensitivity, Δspecificity and ΔBrier with CIs;
  - an exact McNemar test at the operating points.

  Comparisons on val or OOF are the only basis for selection.
- **Test releases:** test metrics are produced only by `POST /experiments/{id}/test-release` (research lead, with a reason). The candidate must be declared: a registered bundle, or a locked comparison family.
  - A `test_release` row records `release_number` per manifest, the runs released, the reason and the actor.
  - It seals the test patients of the split family.
  - The computation runs as a job on **pinned feature-set artifacts**.
  - Every test evaluation body includes `test_release_id`, `release_number` and `prior_releases_on_manifest`.
  - A second release on the same manifest requires `justification`, and it is counted and shown.
  - `GET …/evaluation?split=test` only reads stored releases, with no side effects (`409 test_release_required`).
- **Abstention:**
  - risk–coverage curve, AURC and selective risk per class;
  - the policy is chosen on development data and frozen;
  - `Prediction.abstained` is set;
  - the response notes that model confidence is not a validated out-of-distribution detector.
- **Failure analysis** taxonomy and counts:
  - `near_threshold` and `confident_error`;
  - `artifact_associated` (QC issue on the slide);
  - `small_lesion` (only when expert outlines give lesion size);
  - `possible_label_error` (a confident error with reader disagreement on record);
  - `domain_shift` (scanner or site unseen in train);
  - `mimic_category` (when the negative label carries a category).

  "BCC absent" is never rendered as "benign".
- **Subgroups** by scanner, site and stain batch: min_n counts **patients**, patient-cluster CIs are reported, and the subgroup is marked `insufficient_evidence` below threshold.

**Implemented differently (verification round, recorded with the reason):**
- *Looks are counted per test patient set.* A release needs a justification when an earlier release anywhere in the project looked at any of its test patients (a child version inherits them; a fresh dataset of the same cohort reproduces them), not only on a second release of the same manifest. `release_number` stays per manifest; bodies add `prior_releases_on_test_patients`.
- *Family test reads are audited.* Returning a family's test comparison appends `experiment.test_accessed` per member run.
- *Reference standard.* Failure analysis, paired comparisons (families and benchmark reports) and review-priority discordances state the manifest's reference standard and the imported-reference notice.
- *Tuning flags.* Subgroup, intention-to-evaluate and prevalence-adjusted threshold-dependent metrics carry `tuning_set` like the body's own.
- *Bootstrap clusters* are keyed by patient code (content-stable), never by database uuid.
- *OOF domain shift.* Each out-of-fold bag is judged against the development items of the other folds (its fold model's fitting data).
- *Platt slope.* The Platt map is constrained to slope ≥ 0; anti-informative development scores give the intercept-only map, recorded in its parameters.
- *Test rows* carry `calibrated_score` like development rows.

## 8. Inference bundle (`ml/inference.py`)

`inference_bundle` columns: `id`, `project_id`, `run_id`, `bundle_sha256`, `content_json`, `object_key`, `created_by`, `created_at`. It is immutable.

`content_json` holds:
- the encoder spec, its sha and the weights sha;
- the patch policy and its sha, and the stain policy (with a reference sha);
- the head arrays (object key and sha);
- the class mapping (`positive_class`, `negative_class`, label display text, and the statement that negative is not benign);
- calibration, threshold, abstention policy;
- `code_tree_sha256` and deps;
- `dataset_manifest_sha256`, `feature_set.spec_sha256`;
- `research_use_only: true`.

The bundle is built at registration (`POST /experiments/{id}/register`). `POST /bundles/{id}/infer` takes `{slide_id}` and runs the `infer_slide` job:
- it verifies the encoder spec and weights sha;
- it extracts features with the bundle's policies (label-free);
- it scores and applies calibration, threshold and abstention;
- it writes an `inference_prediction` row (research only; never a label, never routed to care).

**Implemented differently from §7–§8 (phase 3, recorded with the reason):**
- *Reading stored test results.* `GET …/evaluation?split=test` (and errors, attention) never computes, enqueues, seals or writes domain rows, and a `409` writes nothing; a successful read of a stored release appends one `experiment.test_accessed` audit row, because who read test results is governance information.
- *Release candidate.* When the run belongs to a **locked** comparison family, the family is the default candidate (all members released together); otherwise the run's bundle. A run already released is refused (`409 test_already_released`): `Evaluation` is unique per (run, split). Test predictions store no attention yet (`409 attention_unavailable`).
- *Bundles.* The bundle carries the feature set's **effective** stain policy (macenko with its fitted reference) and the reference standard of the training labels. Pipeline-test bundles (synthetic encoder) refuse inference with `409 mode_mismatch`: their signal is label-derived by construction. `inference_prediction` is unique per (bundle, slide), so a slide recorded as unscorable needs a new bundle to be re-scored.
- *Active learning* is asynchronous (`202` + job `active_learning`) and needs the run's registered bundle; scored candidates are stored as `inference_prediction` rows. Patients new to the split family can be proposed (recorded per proposal as `new_to_family`) and may later be allocated to val or test by the family allocator; this is reported, not prevented.
- *Test material (verification round).* Bundle inference refuses (`409 test_release_required`, again in the worker) a test item or test patient of the bundle's manifest, a patient sealed anywhere in the project or a slide a release looked at, unless a recorded release covers the run; afterwards such predictions are listed only for `dataset.test_access`, with an audit row. The worker also refuses a bundle whose pinned `extractor_version` or extraction environment is not its own (`extraction_code_changed`, `extraction_env_changed`).

## 9. Data and label quality (`dermpath/datasets.py` audit; `ml/active_learning.py`)

- `GET /datasets/{id}/audit`, also embedded in the manifest at freeze, covers:
  - patient independence (patients in more than one split must be 0; near-duplicate clusters across splits);
  - duplicates (exact sha within the dataset, across the project, and near-duplicates);
  - label scope consistency;
  - missing metadata per field (mpp, scanner, site, stain, dates);
  - class balance per split, for patients and slides;
  - confounding: label × site, scanner and stain contingency, with Cramér's V and Fisher or χ² p-values, and the split × site table;
  - mixed-label patients.
- Expert disagreement only feeds a **review priority queue** (`GET /projects/{pid}/review-priorities`); nothing is resolved automatically.
- **Active learning:**
  - the pool is development-eligible slides only: QC-eligible, the run's data mode, not in a sealed or test assignment of the split family, and without a reference label or with a reader disagreement;
  - candidates are scored out-of-sample through the bundle;
  - the mix is uncertainty, plus patient-aware diversity (k-centre on embeddings, at most one slide per patient per batch), plus random;
  - proposals are persisted (`al_proposal`), and previously proposed items are excluded;
  - it never creates labels.

## 10. Jobs and provenance (`dermpath/jobs/*`, `ml/artifacts.py`, `dermpath/storage.py`)

- `artifacts.code_identity()` is computed once at process start. It returns `code_revision` (git HEAD or `WB_CODE_REVISION`), `code_tree_sha256` (over the bytes of the imported `dermpath` `.py` files) and `dirty`.
- `dependency_versions()` adds timm, torchvision, transformers, safetensors, the openslide C library version, the torch build (CUDA/MPS), the Python version and the platform.
- Storage gains `put_if_absent(key, data|path)` (write-once, unique temp names, sha verified if the object exists) and `put_file_streaming`.
- Jobs:
  - the heartbeat thread survives transient database errors (logged, retried);
  - final domain commits call `assert_lease(ctx)` (job owner, attempt and running status); otherwise `LeaseLost`;
  - recovery settles domain rows (`TrainingRun.status`, `feature_set.status`) through a registry hook.
- `SCHEMA_VERSION` goes to 2. The demo database is reset with `python -m dermpath.seed --reset`.

## 11. Testing strategy

- **Real-image fixtures without new files:** `openslide.ImageSlide` wraps PIL images. Tests create `real_authorized` slide records whose reader is patched to return an `ImageSlide` over deterministic crops or variants of `CMU-1-Small-Region.svs`. Labels are expert test labels set by the test, not derived from pixels.
- Tiny random-initialised timm and transformers models exercise the real adapter code paths.
- Property tests for splits: prevalence of 1, 5, 10, 30 and 50 % across many seeds and sizes; stability across child versions; uuid-independence; mixed-label patients.
- The suite must stay under about 3 minutes. Heavy checks are marked and skipped by default (`-m slow`).
- `conftest.py` clears every `WB_ML_*`, `WB_UNI_*`, `WB_RESNET18_*`, `WB_HIBOU_*` and `WB_MIDNIGHT_*` variable for test isolation.

## 12. What stays human

Labels, adjudication, task definition, test releases (research lead, with a reason) and every clinical decision stay with people. Outputs are research only. Model confidence is never presented as a safety guarantee.
