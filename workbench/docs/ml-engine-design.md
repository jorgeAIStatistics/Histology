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
- *Duplicate groups are transitive through slides outside the dataset (verification round 2, fold safety, 2026-10-28).* `A~X` and `X~B` confirmed as duplicates make A and B one unit even when X is not an included slide (e.g. an excluded re-scan). The allocator's grouping pairs (`datasets._duplicate_groups`) are the slide-level closure over every `duplicate` decision of the project (`splits.duplicate_closure_pairs`, every patient pair inside a group); the freeze warning `duplicates_across_splits` also lists included slides joined only through such a chain (`status: confirmed_duplicate_chain`); the manifest's `near_duplicate_decisions` also record every `duplicate` decision of a chain that reaches an included slide (`X~Y` above), so the manifest alone determines the groups. Previously decisions naming a non-included slide were dropped before union-find, so A and B could be allocated to different splits with no warning. Regression: `tests/test_duplicate_closure.py`.

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

**Implemented differently (COBRA experiment driver dry run, 2026-10-27, recorded with the reason):**
- *Stain reference seeding is content-keyed.* The `macenko-v1` reference chooses its train slides (above `STAIN_REFERENCE_MAX_SLIDES`) and their reference patches with seeds keyed by the slide's sha256, never its database id; the fit plan records it as `reference_fit.selection_key: "slide_sha256"`. Reason: three imports of the same six COBRA slides (identical bytes, identical content-stable split) fitted three different references, so macenko feature sets and every run on them depended on the import. Plans created before the rule (no `selection_key`) keep their declared id-keyed selection when built; ready sets keep their pinned reference. Regression test: `tests/test_stain_reference_content_stable.py`.

**Implemented differently (owner's brief item 3, fold safety of learned preprocessing, 2026-10-28, recorded with the reason):**
- *Fold safety of learned preprocessing.* The `macenko-v1` reference is one per feature set, fitted on train-split slides and shared by every model on it, so under `dev_cv` every held-out fold's images shaped the normalisation of its own fitting data (preprocessing leakage, not test-label leakage; its numerical effect is unknown). `dev_cv`, or `train_patient_fraction < 1` (learning-curve subsets, both protocols), with such a reference is refused with `409 fold_unsafe_preprocessing` at creation and again in the worker, before any build or fit (`training.preprocessing_fold_safety`, `feature_sets.learned_preprocessing`). Historical runs show `preprocessing_fold_safety.valid_for_cv_comparison: false`, and comparison families and benchmark comparisons refuse to pair them (§6). `holdout` at fraction 1 is verified (the reference slides are training material, disjoint from val/test patients and their confirmed-duplicate groups) and recorded in `metrics.protocol.preprocessing`. `stain: none` (label-free fixed-encoder extraction, every split included) is unaffected under every protocol. Fold-specific references and an independently fixed external reference are not implemented. Regression: `tests/test_fold_safe_preprocessing.py`.

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
- *Folds and seeds (owner's brief item 7, 2026-10-28).* `dev_cv` folds depend only on the manifest development pool (every train ∪ val patient, scorable or not, grouped by confirmed duplicates), k and the declared `cv_fold_seed` (salt `<family salt>|cv|k=<k>`, plus `|fold_seed=<s>` when s ≠ 0), never on the head, the training seed or the feature set; `identity.fold_assignment` records them. Unscorable bags keep their fold and are reported unscorable. The ABMIL inner early-stopping split depends on the seed (`<family salt>|inner|<seed>`); learning-curve subsets use `<family salt>|lc`. In `dev_cv` a learning-curve fraction is drawn within each fold's fitting part, and the final model uses that fraction of the pool, so every point is evaluated on the same full OOF set. Previously unscorable bags were dropped before folds were assigned, so two feature sets on one manifest could get different folds. Regression: `tests/test_cv_fold_stability.py`.
- *ABMIL fitting (owner's brief item 7, 2026-10-28).* Every ABMIL fit (holdout model, each `dev_cv` fold model, the `dev_cv` final model) has two phases: the epoch count is selected by early stopping on an inner patient-grouped stratified hold-out of the permitted fitting patients (never validation, an outer held-out fold or test); the model is then reinitialised with the same seed and fitted on every permitted fitting bag for exactly that count, with normalisation and class weights from all of them and no early stopping. Without a usable inner hold-out it fits every bag for `max_epochs` (`epoch_selection.status: not_possible`). Summaries report `epoch_selection` and `final_fit` patient and bag counts. Previously the kept model was fitted on the inner fit part only (about 80 %) while the summary said "refitted on the development pool". Regression: `tests/test_abmil_refit.py`.
- *Operating point.* Decisions (`predicted`, `abstained`) use the raw score against the frozen threshold; the calibration map (fitted on the same development scores) is applied for reporting as `calibrated_score`. Under `dev_cv`, calibration fitted on pooled OOF scores of the fold models is applied to the refitted final model (a standard approximation, not validated beyond the synthetic pipeline). The evidence rule is one parameter, `min_threshold_evidence` (patients per class, default 10); below it the threshold falls back to 0.5, recorded as `insufficient_evidence` with a `threshold_unvalidated` warning. `tuning_set` is true only when the threshold was selected on those data. The calibration evidence gate (owner's brief item 7, 2026-10-28) counts distinct patient or confirmed-duplicate groups per class (5), never bags; below it `calibration_selection.status` is `insufficient_evidence` with the evidence counts. A fitted map is labelled in-sample (`evaluated_in_sample`, `calibrated_in_sample`) and is not a validated clinical probability (`reliability_note`). Regression: `tests/test_calibration_evidence.py`.
- *Unscorable folds.* A `dev_cv` fold whose fitting part lacks a class is not fitted; its held-out bags are recorded as unscorable (counted in intention-to-evaluate), never imputed.
- *Outputs.* Prediction rows carry `calibrated_score`, `fold` and `manifest_split` in `attributes_json`; `train` rows under `dev_cv` are the final model's in-sample scores on the whole development pool. Checkpoints are `dermpath.checkpoint/2` (`/1` still loads). Legacy runs without identity, mode or feature set fail permanently with `legacy_run`.
- *Labels.* Training labels must satisfy `labels.label_source_permitted(source, manifest.config.reference_standard)`; model suggestions never qualify.
- *Run provenance (verification round).* `code_revision` and `deps_json` are part of the immutable run identity columns from creation.
- *Comparisons refuse invalid pairings (owner's brief items 3 and 7, 2026-10-28).* A comparison family's development comparison and the benchmark's paired comparisons refuse (`status: refused`) when a member is invalid for cross-validated comparison (`code: fold_unsafe_preprocessing`) or when `dev_cv` members were cross-validated on different outer folds (`code: mixed_fold_assignment`: declared k or `cv_fold_seed` differ, or the recorded fold maps disagree on a common patient); the refused runs are listed and their stored results are kept (`training.comparison_refusal`). Regression: `tests/test_fold_safe_preprocessing.py`, `tests/test_cv_fold_stability.py`.
- *COBRA experiment driver (owner's brief item 4, 2026-10-28; `scripts/run_cobra_experiments.py`).* Every stage has a canonical input fingerprint (its config and budgets; implementation identity = driver sha256, engine `code_tree_sha256`, `EXTRACTOR_VERSION` and dependency versions; database / dry-run; dataset, manifest, split and reference identity; encoder spec, weights and config sha; preprocessing policy; feature-set identities; seeds; and the report sha256 + fingerprint of every upstream stage of the explicit `DEPENDS` / `OPTIONAL_DEPENDS` graph). Reports carry the fingerprint and `_state/<stage>.integrity.json` records the report sha; `--status` reports valid / missing / failed / stale / invalid (and `obsolete` for s6) with every changed component; database artifacts are checked before reuse. A stale or forced stage moves its old report and resumable state to `_superseded/` (with `INDEX.jsonl` reasons) and makes its dependents stale; an upstream stage that is not valid blocks its dependents, and s8 refuses to summarise stale, invalid or failed stages. s6 (test release) never runs automatically: it needs `--release-test <the pre-declared candidate of the current valid s3> --release-reason`, and `--justification` for any further look; when s3 changes, an existing s6 becomes `obsolete` (kept, with an immutable copy in `test_release_history/`), never re-run. Seeds are pre-declared (`[0, 1, 2]`) on fixed folds; the candidate rule is the highest mean OOF AUROC over seeds, and the first-seed run is the one released. A Macenko ablation arm is `blocked` (refused by the engine) or `invalid_for_cv_comparison`, never counted as evidence. New stage s4b compares the 256-patch budget with one pre-declared higher budget (default 512) on development data only. `scripts/export_evidence.py` writes the sanitised evidence package. Implemented and fixture-tested only (`tests/test_driver_fingerprints.py`, `tests/test_evidence_export.py`); not yet run on the real cohort.

**Implemented differently (verification round 2, fold safety and the training protocol, 2026-10-28, recorded with the reason):**
- *Transitive duplicate groups everywhere in training.* `training.duplicate_patient_pairs` (the `duplicate_pairs` of `split_context`) is the slide-level closure over every `duplicate` decision in the manifest, including decisions naming a slide that is not an item, and returns every patient pair inside each group; `cv.build_units` and `cv.duplicate_groups` follow a pair through a patient that is not among the bags given (an unscorable or excluded patient) instead of ignoring it (it is still listed in `duplicate_pairs_ignored`). So `dev_cv` outer folds, the ABMIL inner early-stopping split (drawn after unscorable bags are dropped), learning-curve subsets, the calibration evidence gate and the holdout reference-fit check (`_reference_overlap`) all keep `A~T~B` / `A~X~B` whole. Previously such chains were cut, so A and B could sit in different outer folds or inner parts and be counted as two independent calibration groups. Fold maps change only for manifests with such chains.
- *Cross-split confirmed duplicates are recorded, not refused.* When a confirmed-duplicate group spans splits whose roles must stay apart (holdout: train vs val; both protocols: development vs test; `dev_cv` pools train ∪ val), which happens only when a person acknowledged `duplicates_across_splits` at freeze, the run records `metrics.protocol.cross_split_duplicates` (the patient-code pairs, splits and what each affects), a `metrics.warnings` entry, and, for development overlap, `contaminated_by_cross_split_duplicates: true` with the pairs in the development summary (`val_summary`). The run is not refused because the acknowledgement is the human decision; previously nothing in the run said so. Test-release paths do not yet repeat the flag.
- *`metrics.effective_sampling.instance_subsampling.bag_epochs_subsampled`* is the final ABMIL refit's own count; the discarded epoch-selection model's count is reported as `effective_sampling.epoch_selection.bag_epochs_subsampled` (the head summary's `instance_subsampling` keeps the total of both phases). Previously the sum was reported as what the final head saw.
- *Benchmark refusals come first and are atomic.* `run_benchmark` checks every variant's declared learned preprocessing (`preprocessing_fold_safety` on the deferred stain plan, per protocol and learning-curve fraction) before any feature set, comparison family, reference fit or run is created (`BenchmarkError fold_unsafe_preprocessing`, CLI exit 2), and creates all of a family's runs in one transaction, so a refusal of any variant leaves no queued run behind. Previously the refusal came from `create_experiment` after the feature sets were built and earlier variants were committed.
Regression: `tests/test_verify2_fold_safety.py`, `tests/test_duplicate_closure.py`.

**Implemented differently (verification round 2, COBRA experiment driver and evidence exporter, 2026-10-28, recorded with the reason):**
- *One content rule for the driver and the exporter.* The database-free part of the driver's artifact check is the pure function `report_content_problems(stage, report)` in `scripts/run_cobra_experiments.py`: s3 needs a run list and every `grid` run succeeded (else "the four-way comparison is incomplete"); s4 / s4b entries must be well-formed results. `Driver.artifact_problems` and `export_evidence.Reports.status` both call it, and any problem makes the stage `invalid`. The exporter also excludes a stage when the driver's last `_state/status.json` holds the same report bytes `invalid` or `failed`. The status entries now carry `report_sha256` for this match; an older snapshot matches on the same recorded fingerprint and finish time. Previously the exporter checked only the fingerprint, integrity, dry run, implementation and upstream chain. An s3 written after a grid run failed (e.g. one MPS out-of-memory error in midnight ABMIL) was therefore published as valid evidence with its candidate, while the driver held it invalid.
- *Crashed ablation work is not a result.* An s4 / s4b entry whose status is `error`, `feature_set_failed`, a run that did not succeed, or no status makes the stage `invalid`. The same applies to a crashed s4 precision study or fp16 downstream arm. Results are `succeeded`, `blocked` (an engine refusal), `invalid_for_cv_comparison` (recorded, never counted) and `not_run` (excluded by its own valid upstream). The default run re-runs an invalid stage from its resumable state: succeeded runs and ready feature sets are reused, failed feature-set builds retry in place, and a run that failed, was canceled or is gone is replaced, as s3 already did (`Driver.retry_unfinished_run`, recorded in `replaced_runs` and `skipped_work`). A fold-safety refusal stays `blocked` and is not retried. Previously such entries left s4 `valid`; it was reused, never retried, and s5 and s8 were built on it. The run now stops before s5 (exit 1).
- *Pinned objects are verified, not only rows.* For a recorded succeeded run, the artifact check requires the checkpoint object to exist with the run's `checkpoint_sha256`. For a ready feature set, every pinned `FeatureArtifact` must have its embeddings and coords/quality objects with the recorded sha256, or a repaired newer generation that reproduces those bytes (`feature_sets._resolve_valid_artifact`). Object hashes are memoised per process per (key, size, mtime, inode, ctime). Previously a replaced checkpoint or deleted embeddings left s3 / s2 "valid, artifacts verified". Downstream steps failed closed later (`build_bundle`, feature loading), so no wrong number was produced.
- *Test-release history is labelled by release id.* `release_history_labels` is shared by the s8 summary and the exporter's `test_releases.json`. An earlier copy of the current release (a forced, audited re-read writes another write-once copy of the same release) is "earlier record of the current release … not a separate test look". "historical (superseded by a later release)" is used only when a different release with a higher release number, or written later, is on record. Rows also carry the report's `action` and a `record_kind`. Previously every non-current copy was called superseded by a later release, even when no later release existed.
Regression: `tests/test_verify2_driver.py` (two corrected expectations, explained in the test docstrings: the crashed-s4 run now stops with exit 1, and the evidence fixture's failed s3 run is a learning-curve run), `tests/test_evidence_export.py`, `tests/test_driver_fingerprints.py`.

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

**Implemented differently (verification round 2, reporting honesty, owner's brief item 7, 2026-10-28, recorded with the reason):**
- *One paired development comparison for every surface.* Comparison families (`GET /comparison-families/{id}` `development_comparison`), the benchmark harness (`comparisons.*[]`) and the COBRA driver (`Driver.compare`, s3/s4/s4b, copied by the evidence exporter) all call `evaluation.paired_runs_comparison`. Deltas use the paired evaluable subjects (bags scored by every model). Bags recorded as unscorable under a model, including bags no model could score (no tissue patches), are counted per model and as excluded from pairing in `subject_accounting` (`comparison.subject_accounting`, bags and patients); they are never imputed. Previously the family and the benchmark did not mention bags that every model failed to score, and the driver counted 0 for them under `dev_cv` (see the next item).
- *A family no longer refuses a development comparison only because scorability differs.* It pairs on the commonly scored bags and lists the excluded ones. A bag that is missing from a model's predictions without being recorded as unscorable for that model is still refused (`bag_set_mismatch`), so nothing is intersected silently. The benchmark and the driver keep intersecting as before and list such bags under `excluded_bags_unaccounted`. The family's test comparison is unchanged and still requires identical bag sets.
- *`dev_cv` unscorable rows are OOF rows.* In `metrics_json.unscored_bags` of a `dev_cv` run, every development unscorable bag now has `split: "oof"` and keeps its manifest split in `manifest_split`. Previously no-tissue bags kept `train`/`val`, so readers that filtered on `oof` dropped them, while the stored OOF body counted them. `training.development_unscored(run, split)` reads runs recorded before this rule the same way. Fold-not-fitted rows are told apart from no-tissue rows by `reason`.
- *Tuning labels on paired comparisons.* A member's threshold may have been selected on the compared split (`selection_status: selected`, `selected_on` equal to the split). In that case the paired Δsensitivity, Δspecificity and the McNemar block carry `tuning_set: true`, and the comparison carries `tuning_set`, `threshold_tuned_on_these_data` and `tuning_set_note` (`comparison.label_tuning_estimates`). Threshold-free deltas (AUROC, AUPRC, Brier) stay unflagged.
- *The driver refuses what the engine refuses.* `Driver.compare` applies `training.comparison_refusal`, so runs cross-validated on different outer folds are refused (`mixed_fold_assignment`). An s4 arm whose comparison is refused becomes `invalid_for_cv_comparison` with `counts_as_evidence: false`. An s4b entry carries `counts_as_evidence`. Previously the driver checked only fold safety and paired such runs.
- *Prediction unit.* Development and test family comparisons, family member rows, benchmark run records, comparison entries and the benchmark's dataset block state `label_scope` and `prediction_unit` (e.g. `"slide (bag)"`). Runs with different label scopes are refused (`mixed_label_scope`).
- *Reference-standard notice on experiments.* `GET /experiments/{id}` and the project experiment list include `reference_standard` and, for `imported_reference`, `reference_standard_notice`. Both appear at the top level and inside `val_summary` / `oof_summary`.
- *Learning-curve points state the patients behind the OOF metric.* Under `dev_cv` a point's `train_patients` is the low median of the fitted fold models' `fit_patients` (`training.oof_fitting_patients`; per fold in `train_patients_by_fold`). The final refit's count, which scores no OOF bag, is reported as `final_model_patients`. This applies to benchmark records and learning curves, driver run records, s3 curves and the s7 per-doubling slope, which reads `train_patients`. Previously the final refit's count overstated each point's training size by about k/(k−1).
- *Driver calibration block.* `run_record.oof.calibration` reads the development summary's nested `raw.equal_width` Brier/ECE (`calibration_block`). It also carries the calibrated values, `calibrated_in_sample`, `calibrated_note`, `calibration_status` and the operating point's calibration-selection status and evidence. Previously it always read null.
Regression: `tests/test_verify2_reporting.py`, `tests/test_reporting_accounting.py`; one corrected expectation in `tests/test_verify_statistics.py::test_dev_cv_body_counts_unscorable_train_and_val_bags_and_flags_oof` (it counted fold-not-fitted rows by `split == "oof"`, which encoded the old labelling; it now counts them by reason and asserts the new labelling).

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
- *Bundles.* The bundle carries the feature set's **effective** stain policy (macenko with its fitted reference) and the reference standard of the training labels. Pipeline-test bundles (synthetic encoder) refuse inference with `409 mode_mismatch`: their signal is label-derived by construction. (Superseded, see the 2026-10-28 note below: predictions are unique per bundle, subject scope, slide and input-snapshot identity.)
- *Active learning* is asynchronous (`202` + job `active_learning`) and needs the run's registered bundle; scored candidates are stored as `inference_prediction` rows. Patients new to the split family can be proposed (recorded per proposal as `new_to_family`); since the evaluation-cohort protection (owner's brief item 6) they can never later become val or test material, see §9.
- *Test material (verification round).* Bundle inference refuses (`409 test_release_required`, again in the worker) a test item or test patient of the bundle's manifest, a patient sealed anywhere in the project or a slide a release looked at, unless a recorded release covers the run; afterwards such predictions are listed only for `dataset.test_access`, with an audit row. The worker also refuses a bundle whose pinned `extractor_version` or extraction environment is not its own (`extraction_code_changed`, `extraction_env_changed`).

**Implemented differently (owner's brief items 2 and 5, 2026-10-28, recorded with the reason):**
- *Scope.* Only bundles whose `classes.label_scope` is `slide` score slides (`inference.scope_refusal`, fail closed on a missing or unknown scope). A case-trained bundle is refused with `409 scope_mismatch` (details `bundle_label_scope`, `endpoint_scope`) on `POST /bundles/{id}/infer`, again in the `infer_slide` worker, on `POST /projects/{pid}/active-learning` and in the active-learning worker; `GET /bundles/{id}` shows `can_infer: false` with `inference_refusal_code`. A case probability is never reported as a slide probability. Case inference would need its own endpoint (a frozen complete eligible slide set per case, training-consistent aggregation, case-level provenance); it is not implemented. Regression: `tests/test_inference_scope.py`.
- *One input snapshot.* The job takes one canonical effective input snapshot (`inference.effective_input_snapshot`: slide sha256 and object key, image kind and provenance, mpp and calibration, dimensions and level downsamples, QC mask and excluded-region geometry and their shas) at execution, passes exactly that dict to `extract_slide(input_snapshot=…)` (the returned artifact must match it, else `input_snapshot_mismatch`) and stores it with `input_snapshot_sha256` and a feature identity (row count, dim, chunked sha256 of the scored rows). Predictions are unique per (bundle, subject scope, slide, snapshot sha); a changed input is a new versioned row and older rows are kept; reuse requires the same identity and complete provenance; an embedding returned with a stored score must reproduce the recorded feature identity (else `stale_prediction_refused`); `input_changed` (image bytes or mask no longer match) fails the job and records nothing. Concurrent duplicates record one row (savepoint insert; the loser returns the winner). The API idempotency key is `infer:{bundle}:{slide}:{request-time snapshot sha}`. Regression: `tests/test_inference_snapshot_identity.py`.
- *Request chain per input identity (verify2, 2026-10-28).* The job scores the input as it is when it runs, so a job requested at identity A can score B (the input changed while it was queued). The payload now carries `expected_input_snapshot_sha256`, the result reports `requested_input_snapshot_sha256` and `input_changed_since_request`, and `POST /bundles/{id}/infer` hands back the newest job of A's chain only while it is queued or running, or when it succeeded with a result for A. When it finished on another identity, failed or was canceled, a new job is enqueued under `infer:{bundle}:{slide}:{sha}:r{n}`, and duplicate re-requests share it through the unique key. Before this change, A stayed bound to a succeeded job that held B's score and could never be scored. A re-request after a failed job is now a new attempt; `POST /jobs/{id}/retry` is no longer needed for it.
- *Only snapshot outcomes are recorded (verify2, 2026-10-28).* An "unscorable" row is permanent for its (bundle, slide, snapshot), so only refusals that are deterministic functions of the snapshot and the bundle are recorded (scale, sampling and stain refusals, no tissue patches, region geometry, ...). A slide whose ingest state moved after the job's snapshot (a re-ingest in flight; `feature_sets._prepare` now raises `slide_not_ingested: …`) is retried with backoff (`input_not_ready`) and nothing is recorded. After the attempts run out the job fails, and a re-request gets a new job. An active-learning batch that meets this state is retried as a whole in the same way; it no longer counts the slide as unscorable. `extraction_env_changed` and `extraction_code_changed` fail the job and record nothing. Feature-set builds still record `slide_not_ingested` as an item failure, which the next build retries (unchanged). Before this change, a re-ingest that landed mid-job recorded "not ingested (pending)" as the permanent outcome of an unchanged input. The API then served it, and active learning with diversity picks failed on it with `stale_prediction_refused`.
- *Image identity on the reuse path (verify2, 2026-10-28).* The snapshot identity is computed from database fields only. Before a stored prediction is served, the slide's stored image and QC mask object are therefore verified against its snapshot (`feature_sets.verify_snapshot_objects`; the image sha is memoised per key, size, mtime, inode and ctime, so the first check in a process streams the file once). This covers the worker's reuse path, with or without an embedding, and the API's `prediction`. An object replaced in place (same key, same database sha) fails closed: `input_changed` in the worker, so active learning refuses in both its uncertainty-only and diversity modes, and `409 input_changed` from `POST /bundles/{id}/infer`. A slide with no stored prediction is checked by extraction, as before. The earlier claim that this trade-off was documented in the inference module was wrong: the docstring described only the check during extraction. Regression: `tests/test_inference_request_identity.py`, `tests/test_verify2_inference.py`.
- *Migration.* Schema-v2 databases are migrated in place at startup (`engine_models.migrate_inference_prediction`, SQLite; other backends refuse with the SQL to apply): the table is rebuilt in one transaction and every existing row is copied verbatim and marked `provenance_status: legacy_unverified` (never reused). `SCHEMA_VERSION` stays 2 (additive change).
- *Bounded memory.* Inference pools embeddings in fixed 4,096-row float64 chunks (`heads.streaming_mean`, bit-identical to what `meanpool_logreg` scores), and only when an embedding is asked for (active learning asks only when its batch plan has diversity picks). ABMIL scoring normalises the bag with one bag-sized float32 temporary. On a 100,000 × 1,536 float32 memory-mapped fixture the traced peak was about 50 MB, against 1.23 GB for the old whole-matrix float64 copy (`tests/test_inference_memory.py`, slow test prints `INFERENCE_MEMORY_RECORD`). This synthetic fixture shows resource behaviour only, not diagnostic quality; no large real WSI has been measured.

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

**Implemented differently (evaluation-cohort protection, owner's brief item 6, 2026-10-28, recorded with the reason):**
1. `acquisition_exposure` (`dermpath/models.py`) is append-only (ORM guard, bulk guard, SQLite triggers) and is written in the proposal's transaction: a `selected` row (patient, all its slides and cases at commit, proposal, batch, run, bundle, dataset version, timestamp, kind `model_selected`) plus a `duplicate_partner` row per patient of its confirmed-duplicate group.
2. Effective exposure (`datasets.acquisition_exposure`) is the recorded rows plus legacy `al_proposal` rows without an exposure row (historical), the current owners of exposed slides and cases, and current confirmed-duplicate partners. It is conservative: material only joins.
3. `splits.allocate(development_only=...)` pins those units to train under every partition. Inherited and sealed splits never move and are reported in `diag.development_only.held_in_evaluation`. The algorithm id stays `dermpath.splits/3` because allocations without exposed patients are identical.
4. Freeze refuses `409 acquisition_exposed_in_evaluation` with no acknowledgement possible; each patient carries `held_by` (draft_allocation: refresh; split_family: new lineage or exclude; sealed: exclude), `historical_conflict` and `resolution`. The check runs first, and again inside the freeze's write transaction (SQLite single writer; on PostgreSQL `SELECT … FOR UPDATE` on the project row, which the AL commit also takes). The manifest object is stored only after that check. A train patient exposed mid-freeze gives `409 draft_stale`.
5. The AL commit re-checks picks for the slide's current owner after taking the write lock; ineligible picks are dropped and reported in `dropped_at_commit`.
6. The pool also excludes `evaluation_patient_other_lineage`, `duplicate_of_evaluation_patient` and `evaluation_reserved_by_rule` (temporal: latest case ≥ val cutoff, or test cutoff; external_site: a case at a test site).
7. Historical conflicts are reported in freeze-check, in the audit (`acquisition_exposure`, `frozen_version_rewritten: false`) and at `GET /projects/{pid}/acquisition-exposure`. Frozen manifests and evaluations are never rewritten.
8. The manifest adds `evaluation_cohorts` (`representative_performance_cohort` vs `model_selected_review_cohort`). Review priorities flag `acquisition_exposed` and `evaluation_patient`.
9. Limitation: random partitions stratify by label, so no label-free reservation precedes active learning. The performance cohort is the cohort minus model-selected patients (possibly easier than the full cohort, because AL favours uncertain cases), and the manifest reports the counts.

Regression: `tests/test_al_cohort_protection.py`.

**Implemented differently (verification round 2, active-learning protection, 2026-10-28, recorded with the reason):**
1. *Model-selected held-out material in runs.* `create_experiment` records the manifest's model-selected patients (`datasets.manifest_acquisition_snapshot`) in `provenance_json.acquisition_exposure_at_creation` and in the `experiment.created` audit row. The worker unites that with a fresh snapshot (exposure only grows). In `dev_cv`, where every train ∪ val patient is held out once, and in `holdout` (val), the held-out rows of those patients are stored and flagged (`attributes.model_selected`). They are excluded from the operating point, the calibration, the development summary and the stored `oof`/`val` evaluation, and summarised apart as `model_selected_summary`, which is not a performance estimate. `metrics.acquisition_exposure`, `threshold.model_selected_excluded`, `calibration_selection.model_selected_excluded` and the evaluation body report the counts, codes and both snapshots, and add a `model_selected_held_out` warning. A run whose every scored held-out bag is model-selected fails with `acquisition_exposed_in_evaluation`. The folds are unchanged: they still depend only on the manifest pool, k and `cv_fold_seed`. Exposure is not part of run identity. Without exposure, results are identical to before. Previously these patients were silently scored as held-out performance material. Not yet covered: paired comparisons (family and benchmark) still read every stored `oof`/`val` row, including flagged ones.
2. *Test releases.* `create_test_release` refuses with `409 acquisition_exposed_in_evaluation` before anything is sealed when the version's test split holds model-selected material (historical conflicts included). No justification overrides this. The remedy is a child version that excludes those slides. A test evaluation also reports `acquisition_exposure`, with a warning, when an exposure was recorded after the release. Previously such a release was sealed and presented as representative.
3. *Duplicate-group holds.* A newly exposed patient held in val/test only because its confirmed-duplicate group contains a sealed or family-held partner is reported as `held_by: duplicate_group`, with `held_with` naming the partner and how it is held. It is a historical conflict. The resolution is to exclude this patient's or the partner's slides, or to start a new lineage when no partner is sealed. Previously it was reported as `draft_allocation` with "Refresh the draft", and a refresh never resolved it.
4. *Review priorities.* `evaluation_patient` keys on the PATIENT's split: `attributes.manifest_split` for `dev_cv` `oof` rows, or a val/test assignment in any split family. It no longer keys on the prediction split. Each discordance carries `patient_split`. Previously a `dev_cv` discordance on a validation patient was not flagged.
5. *Manifest wording.* The representative cohort is no longer described as "independent of active-learning selection". Pinned units count toward train's targets, so which other patients fill val/test depends on what active learning chose. `splits.allocate` recomputes the allocation without the pin (same salt, seed, cohort, grouping and inherited splits). `diag.development_only.effect_on_other_patients` and the manifest's `representative_performance_cohort.allocation_effect_of_model_selected` name the patients moved into val/test and those displaced to train. Allocations themselves are unchanged.
6. *Reference standard in the pool.* The active-learning pool and its commit re-check judge "labelled" under the dataset's reference standard (`reference_label(..., reference_standard=...)` from the frozen manifest config). Under `imported_reference`, an imported label, or a `disputed` imported value, counts as labelled. Previously every imported-labelled slide was offered as `no_reference_label`, and proposing one pinned its patient to train.

Regression: `tests/test_verify2_al.py`.

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
