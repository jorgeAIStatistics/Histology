# ML engine report: correctness fixes and real-image evidence on the COBRA BCC subset (2026-10-28)

*Research use only. Not a medical device. Nothing in this report is a diagnosis, a clinical performance claim, or a claim of superiority over any commercial product. The labels are COBRA's report-derived **imported reference** labels, not expert reads in this workbench, so every metric measures agreement with that reference. "BCC absent" (`bcc_absent_not_benign`) is **not** "benign". Development out-of-fold (OOF) numbers are development estimates. Threshold-dependent OOF metrics are **tuning estimates**, because the threshold was chosen on the same scores. Calibration measured on the same OOF scores it was fitted on is **in-sample**.*

## How to read the sources

Every number carries a source tag, and each section ends with a source list. The list gives the file and the JSON key path; `[i]` in a key path means the list index.

| Tag | Location | Committed? |
|---|---|---|
| `R/` | `workbench/experiments/reports/`, the driver's raw reports. Each report's sha256 is in `R/_state/status.json` → `stages.<stage>.report_sha256`; all of them were re-checked on 2026-10-28 and match | No (gitignored; local machine only) |
| `E/` | `workbench/experiments/evidence/cobra-bcc-subset-2026-10-28/`, the sanitized evidence package, regenerated on 2026-11-09 with the corrected exporter (§1.3). Its `results.json`, `dataset.json` and `identities.json` mirror the `R/` numbers for every stage marked valid | Yes |
| `F1`, `F2` | Fix-round records `next_fixes_result.json` (round 1) and `verify2_result.json` (round 2), formerly in the 2026-10-28 session scratchpad | **No longer exist** (cleared; see "Source durability"). The commit messages of `7ba0435` and `8a1a59e` and the named test files are the durable cross-checks |
| `INV` | Read-only inventory of the experiment state taken before the fixes. The scratchpad original was cleared; the package keeps `E/attachments/pre_fix_inventory.md` (byte-identical) and `E/attachments/pre_fix_inventory.json` (sanitized) | Yes (copy) |

**Run-record index.** In `R/s3.json` → `runs`, the 12 grid runs are `runs[0..11]`, at index `4·seed + k`: k = 0 handcrafted + mean-pool, 1 handcrafted + ABMIL, 2 Midnight-12k + mean-pool, 3 Midnight-12k + ABMIL. `runs[12..23]` are the learning-curve runs. The same order holds in `E/results.json` → `development_comparison.runs_oof`.

**Derived numbers.** A few numbers are computed from a cited file, for example a count over runs or a ratio. Each is marked *(derived)* and its method is stated.

**Source durability.** The temporary scratchpad records this report first cited have been cleared: `F1`, `F2`, the original inventory folder, the original Midnight parity record and the full-suite log `evidence_work/pytest_full.log`. What survives:
- The defect totals (30 in round 1, 32 in round 2) and the test counts (pytest 974 and then 1081 passed, each with 1 slow test; web `tsc` clean, vitest 47, Playwright 25) are in the commit messages of `7ba0435` and `8a1a59e`.
- The inventory and the parity record survive as package attachments (`E/attachments/pre_fix_inventory.{md,json}`, `E/attachments/midnight_parity.json`).
- **No longer independently verifiable:** the per-area defect splits (§2.1, §2.2), round 1's integration details (the 963-test baseline, the 4 repaired tests), the run durations (342.43 s, 21.69 s, 49.6 s), the 1,088-test working-tree run (270.22 s), and the byte-level synthetic-memory figures beyond the commit message's "1.23 GB to 33 MB (parity 4e-19)" (§3.11; that fixture can be re-run). They are kept as reported and marked *(cleared record)*.

---

## 0. Scope

This report covers the 2026-10-28 upgrade of the DermPath Research Workbench ML engine on branch `dermpath-ml-engine`. It reports four things:
- the confirmed defects fixed in two fix rounds, with the tests that prove them;
- one complete real-image experiment run (stages s0–s5, s7 and s8 of `scripts/run_cobra_experiments.py`). It ran on 60 public COBRA skin-biopsy whole-slide images from 50 patients, on one Apple-silicon Mac (MPS), with frozen Midnight-12k and handcrafted encoders and three pre-declared training seeds;
- a sensitivity analysis for undecided near-duplicates;
- one real-slide inference measurement.

The narrow research task is BCC present versus BCC absent at slide level, against COBRA's imported reference standard. Every performance number is a development out-of-fold estimate on 35 patients. The 15-patient test split has **never been released** in this study. Stage s6, the opt-in test release, was deliberately not run, and that decision is the owner's. The work is research-use only. It establishes engineering behaviour and development evidence on one small, single-site, report-labelled public cohort. It does **not** establish clinical accuracy, clinical readiness, or a winner for clinical use.

---

## 1. Experiment state and evidence inventory

### 1.1 Stages of the real run (post-fix, 2026-10-28)

The command line was `--device mps --seeds 0,1,2 --sampling-budget 512`, with `HF_HUB_OFFLINE=1` and the shared database `workbench/var` [1.1]. All valid stages recorded the same code: `git_head 8a1a59e`, engine `code_tree_sha256 0947a51c…`, `dirty: false`, driver sha256 `2d7715f9…` [1.2].

| Stage | What it does | Status | Finished (UTC) | Wall time (s) | Fingerprint |
|---|---|---|---|---|---|
| s0 | Environment | valid | 07:24:31 | 0.123 | `03e9978b1a59` |
| s1 | Dataset version (the existing frozen version is reused) | valid | 07:24:31 | 0.042 | `63ee4f665c9e` |
| s2 | Technical validation (no labels read) | valid | 07:26:39 | 128.011 | `adde772f7a4f` |
| s3 | Supervised baselines, 24 runs | valid | 07:53:28 | 1,608.815 | `3728893358ba` |
| s4 | Ablations | valid | 08:46:14 | 3,166.585 | `5b1f7b973f7e` |
| s4b | Sampling budget 256 vs 512 (development only) | valid | 10:33:55 | 6,460.938 | `630b9674ba64` |
| s5 | Resources | valid | 10:33:56 | 0.008 | `b250655c4e73` |
| s6 | Opt-in test release | **missing** (not run; the owner's decision) | — | — | `fefbf519faaf` |
| s7 | Failure analysis | valid | 10:33:56 | 0.099 | `46b4638f9759` |
| s8 | Summary | valid | 10:33:56 | 0.012 | `49a9571d2238` |

The total elapsed time was 11,364.6 s, about 3.16 h *(derived: 11,364.621 / 3,600)* [1.3].

Most of the s3 wall time was not training. The in-process worker first resumed a stranded build job (`6481f266`, the uniform-sampling Midnight-12k feature set `0ad3a2dd`). The stopped pre-fix run had half-built it (30 of 60 slides) and left it stranded; the post-fix worker resumed it, extracted the remaining 30 slides, and finished it at 03:51:32 local time. The 24 runs' own training time sums to 91.04 s [1.4].

### 1.2 Valid, stale, invalid, dry-run and not-run items

| Class | Items | Why |
|---|---|---|
| **Valid** | The stages above; dataset version `1868803e`; 9 feature sets (§1.3; five of them, and 30 of the 60 artifacts of a sixth, were extracted by the stale pre-fix run and reused after identity checks); 29 post-fix training runs; model version `e19ffe37`; bundle `593059e2` | Fingerprint, report sha256, upstream stages and artifacts are verified by the driver [1.5] |
| **Stale / superseded** | The pre-fix run at commit `782668c` (tree `810e3288…`, driver `2e15ff00…`): reports s0–s3 (moved to `R/_superseded/`), 17 training runs, and the old candidate `79aa243e` (never registered, never released). Its feature extractions were not discarded: they were reused through the cache (§1.3). DB comparison families `8e64b136` (16 runs) and `5c326ae6` (1 S4 run + 2 S3 members) are still `open` in the database: not deleted, not cited | Pre-fix defects (the ABMIL final model was fitted on 34 of 45 bags; the calibration gate counted bags; a single seed). The legacy reports also have no input fingerprint [1.6] |
| **Invalid** | Real cohort: none. Dry runs: every `b_stain_macenko` `dev_cv` arm | One stain reference was fitted on the development slides and shared across folds [1.6] |
| **Blocked** | s4 `b_stain_macenko` for both encoders | The engine's fold-safety precheck refused it before any extraction (§3.9) [1.7] |
| **Dry run** | Throwaway 6-slide databases on 6 patients, with 4 dry-run test releases recorded | Plumbing checks only, never evidence. 4 of the 15 real test patients were among the 6 (see §7) [1.8] |
| **Not run** | s6 test release (the owner's decision); sampling budget 1024 (cost; 512 was the pre-declared higher budget) | [1.6] |

**Test-release history.** The real cohort has 0 test releases. After the bundle registration it still had 0 test-access audit rows and 0 sealed patients [1.9].

### 1.3 Identities

| Identity | Value |
|---|---|
| Code | `git_head 8a1a59eb2b4e…`, `code_tree_sha256 0947a51c8d1f…` (88 files), `dirty: false` at run time [1.2]. The evidence package records `dirty: true` because the evidence work is uncommitted (§8). The regenerated package (2026-11-09) records 8 changed and 5 untracked paths under `workbench/` (`tracked_diff_sha256 bc42b1de…`). Changed: `scripts/export_evidence.py`, two test files (`api/tests/test_evidence_export.py`, `api/tests/test_verify2_driver.py`), `README.md` and four docs (`data-dictionary.md`, `license-ledger.md`, `public-datasets.md`, `readiness.md`). Untracked: this report, the package folder, `api/tests/test_evidence_scripts.py`, `scripts/sensitivity_near_duplicates.py` and `scripts/measure_bundle_inference.py`. The first export (2026-10-28) recorded 2 changed and 3 untracked paths (`e9842b99…`), the test files among them. The engine tree itself was clean both times (`engine_now.dirty: false`) [1.10] |
| Driver | `run_cobra_experiments.py` sha256 `2d7715f911e5…` [1.2] |
| Dataset version | `1868803e54c045eba4df9c7a9fd53a7b`, v1, frozen 2026-10-28T03:05:12Z, lineage `ffe262d9…` [1.11] |
| Manifest sha256 | `a73bfa56a3532e36d48111d7e0da0de832dce57ff48432662ee5e713f74ca902` (verified) [1.11] |
| Split fingerprint | `19676e29764f1c18610553c58ba449648db47d394adc0ba68c53f8a690247df2`; split family `bc569b29…`; algorithm `dermpath.splits/3`; seed 20261027; ratios 0.7 / 0 / 0.3 [1.11] |
| Fold assignment | `579ae8c69076c9e8d90484a4a44c7ab2e0a0d9543782c72c49ecd75dcec0a032`, identical across all 24 s3 runs (1 distinct) [1.12] |
| Midnight-12k | spec `36d2e01f76b3…`; `model.safetensors` sha256 `52c14f20386ca17c2af8a7bf32c31c352668a8fbf6aefc88d86be6eaa0c72ca1` (4,546,005,432 bytes); `config.json` sha256 `0362e014a3f3…`; embedding dim 3072 [1.13] |
| Handcrafted | `handcrafted-stain-texture-v1`, spec `8e4d14d0f79e…`, weights id `handcrafted:1:234035d1…`, dim 64 [1.13] |
| COBRA files | Licence file sha256 `09ee9e203ad9…`; selection file sha256 `f9a6c3a9c874…` (60 rows); all 60 slide files (2,592,138,610 bytes) match the manifest sha256 [1.14] |

**Feature sets.** All use target 0.5 µm/px, 224 px patches, sampling seed 0 and stain `none` [1.15].

| Id | Use | Encoder | Sampling, budget, precision | Spec sha256 | Items |
|---|---|---|---|---|---|
| `527f9080` | s2 technical | handcrafted | spatial, 256, fp32 | `1e5969df…` | 60/60 |
| `b3b75db2` | s2 technical | Midnight-12k | spatial, 256, fp32 | `6162aaf4…` | 60/60 |
| `c2aa86f4` | s3 supervised (same artifacts as `527f9080`) | handcrafted | spatial, 256, fp32 | `7a6177a7…` | 60/60 |
| `c74591ee` | s3 supervised (same artifacts as `b3b75db2`) | Midnight-12k | spatial, 256, fp32 | `3928575d…` | 60/60 |
| `2f1f57b2` | s4 uniform sampling | handcrafted | uniform, 256, fp32 | `a3a5b981…` | 60/60 |
| `0ad3a2dd` | s4 uniform sampling | Midnight-12k | uniform, 256, fp32 | `3c6a6f6e…` | 60/60 |
| `6c43b5f6` | s4 fp16 downstream | Midnight-12k | spatial, 256, fp16 | `5a8a48cf…` | 60/60 |
| `9849f543` | s4b budget 512 | handcrafted | spatial, 512, fp32 | `cc587380…` | 60/60 |
| `8f57bde3` | s4b budget 512 | Midnight-12k | spatial, 512, fp32 | `61fcccf0…` | 60/60 |

Every artifact of all 9 sets was re-hashed on 2026-10-28, and every one matched its recorded sha256. All 46 checkpoints (29 post-fix, 17 pre-fix) also matched [1.16]. The feature sets cover all 60 slides, test slides included. This is label-free extraction with a fixed encoder, which reads no labels; only the comparisons are restricted to development data [1.17].

**Pre-fix extractions reused.** Not every artifact was extracted by the post-fix run [1.20]:
- `527f9080`, `b3b75db2` and `2f1f57b2` were extracted in full by the stale pre-fix run (code `782668c`). `c2aa86f4` and `c74591ee` were also created by that run and share the artifacts of `527f9080` and `b3b75db2`.
- `0ad3a2dd`: 30 of its 60 artifacts were extracted by the pre-fix run, and the other 30 by the resumed job in the post-fix run (§1.1).
- `6c43b5f6`, `9849f543` and `8f57bde3` were extracted by the post-fix run.
- The post-fix run reused the pre-fix artifacts through the content-addressed cache after identity checks (cache-key identities unchanged).
- Consequently the per-slide cold-extraction timings and peak RSS of those sets come from the pre-fix extractions: 56.66 s/slide (Midnight-12k) and 4.42 s/slide (handcrafted) in s2, 4.66 s/slide (handcrafted uniform), 50.32 s/slide (Midnight-12k uniform; 30 pre-fix and 30 post-fix slides), and the 54.960 s cold time of the inference slide (§3.11).
- Mitigation: the post-fix s2 determinism check re-extracted 2 seeded slides per encoder with the post-fix code and matched the stored artifacts exactly (max abs diff 0, identical coordinates). It covers 2 of 60 slides per encoder, not every slide.

**Run ids** (prefixes; full ids in `E/identities.json` → `runs[*].run_id`). The s3 comparison family is `82230406…`.
- **s3 grid, seed 0:** `da0e1542` (handcrafted + mean-pool), `5d2d00e3` (handcrafted + ABMIL), `b7abc046` (Midnight + mean-pool), `ba364f52` (Midnight + ABMIL, the pre-declared candidate).
- **s3 grid, seed 1:** `39aae3d4`, `e53e9582`, `71a27f33`, `3b5b5a14`.
- **s3 grid, seed 2:** `8da8058d`, `e6a98325`, `cec621ce`, `8b10d7b3`.
- **Learning curves:** handcrafted `b778cbdd` `59f21140` `12e00261` (fraction 0.25) and `9caa1120` `524c4dd6` `e0f89e60` (0.5); Midnight `fb96949a` `26838350` `2b710c8a` (0.25) and `aa0c6b43` `7a8b03c9` `30162ac9` (0.5).
- **s4 (family `85e19ccf…`):** uniform sampling `bf135d20` (handcrafted) and `8319c6fe` (Midnight); fp16 `4efbd45e`.
- **s4b (family `472e0c0a…`):** budget 512 `905e6fa3` (handcrafted) and `7350cf84` (Midnight).
- **Candidate registration:** model version `e19ffe37…` (`research_candidate`), bundle `593059e2…` (sha256 `8f1eb227…`, label scope `slide`). Registering a bundle is **not** a test release [1.18].

**Machine.** macOS 14.5 arm64, 11 CPUs, 19,327,352,832 bytes of RAM, MPS, no CUDA. Python 3.14.5, torch 2.14.1, numpy 2.4.2, scikit-learn 1.9.0, transformers 5.19.0, OpenSlide 4.0.1 [1.19].

**Sources §1.**
[1.1] `R/summary.json` → `argv`; `R/s0.json` → `environment`. [1.2] `R/s0.json` → `code_identity`, `driver.sha256`; same key in every stage report. [1.3] `R/summary.json` → `elapsed_seconds_per_stage`, `elapsed_seconds_total`; `R/_state/status.json` → `stages.*.{status,finished_at,fingerprint_sha256}`. [1.4] `R/_run2.log` lines "job 6481f266 build_feature_set: succeeded" (03:51:32) and "s3: training 24 run(s)" (03:26:39); `R/_full_run.log` (the pre-fix build of `0ad3a2dd`, started 00:14:22); `INV` §4; `R/s5.json` → `training.training_seconds.sum` = 91.04; `R/s3.json` → `costs.training_wall_seconds` = 1604.119. [1.5] `R/_state/status.json` → `meaning.valid`, `stages`. [1.6] `E/exclusions.json` → `supplement.interrupted_pre_fix_run`, `supplement.not_run`, `supplement.dry_run_reports`, `superseded_outputs`. [1.7] `R/s4.json` → `arm_status`, `skipped_work`; `E/blockers.json`. [1.8] `E/test_releases.json` → `disclosures.dry_runs`. [1.9] `E/test_releases.json` → `count`, `disclosures.real_cohort.after_bundle_registration`; `E/attachments/inference_measurement.json` → `safety_after`. [1.10] `E/index.json` → `code`; `E/provenance.json` → `code.{repository,engine_now}`; the first export's values from the 2026-10-28 package (`e9842b99…`, 2 changed / 3 untracked). [1.11] `R/s1.json` → `dataset.{dataset_version_id,frozen_at,lineage_id,manifest_sha256,manifest_verified,split_fingerprint,split_family_id}`, `split_diagnostics.{algorithm,seed}`, `split_request.ratios`. [1.12] `R/s3.json` → `protocol.fold_consistency`. [1.13] `E/identities.json` → `encoders`; `E/attachments/bulky_artifacts_index.json` → `weights`. [1.14] `R/s1.json` → `public_dataset.licence_file_sha256`, `public_dataset.selection.{file_sha256,rows}`; `E/attachments/bulky_artifacts_index.json` → `slides`. [1.15] `E/identities.json` → `feature_sets.*.{feature_set_id,spec_sha256,counts}`; the fp16 set: `R/s4.json` → `precision.downstream_fp16.feature_set.created.spec_sha256`. [1.16] `E/attachments/bulky_artifacts_index.json` → `feature_sets[*].all_files_match_recorded_sha256`, `checkpoints[*].file_matches`. [1.17] `R/s4b.json` → `encoders.*.resources.{note,test_slides_extracted_label_free}`; `R/s2.json` → `note`. [1.18] `E/identities.json` → `runs` (29 post-fix runs, the fp16 run `4efbd45e` included), `model_and_bundle`; `R/s4.json` → `precision.downstream_fp16.run.run_id`; `R/s3.json` → `family.family_id`; `E/attachments/inference_measurement.json` → `registration`. [1.19] `R/s0.json` → `machine`, `dependency_versions`. [1.20] `E/exclusions.json` → `supplement.interrupted_pre_fix_run.{reused_after_identity_checks,pre_fix_extraction_figures}`; `R/_full_run.log` (pre-fix builds of `527f9080`, `b3b75db2`, `c2aa86f4`, `c74591ee`, `2f1f57b2`; `0ad3a2dd` at slide 29/60 when the log ends); `R/_run2.log` (no rebuild in s2; `6481f266` finished at 03:51:32; post-fix builds of `6c43b5f6`, `9849f543`, `8f57bde3`); `R/s2.json` → `encoders.*.technical_validation`, `encoders.*.feature_set.per_slide[*].original_extraction`; `R/s4.json` → `arms.a_sampling_uniform.*.feature_set.build.already_ready`; `INV` §4 (`0ad3a2dd` 30 done, 30 pending).

---

## 2. Confirmed bugs fixed, and the tests that prove them

The design that this upgrade implements was motivated by an audit with 15 critical and 32 high findings (`docs/ml-engine-design.md`, line 7). Before this report, two earlier rounds had already fixed defects:
- **Verification round, commit `f4e62d3`:** 37 defects fixed. Six verifiers wrote 155 adversarial tests in `tests/test_verify_{leakage,modes,provenance,sampling,splits,statistics}.py`.
- **Driver commit `782668c`:** 1 defect fixed. The Macenko reference had been chosen and seeded by database slide ids, so a re-import changed it. Test: `tests/test_stain_reference_content_stable.py`.

Two further rounds followed for the owner's 2026-10-28 brief.

### 2.1 Round 1: the brief's confirmed defects (commit `7ba0435`)

Every defect was first reproduced by a failing test. Round 1 fixed **30 defects** (commit `7ba0435`: "30 in total"). The integration step then added **7 regression tests** in the same areas and repaired 4 tests whose expectations encoded behaviour that the fixes had deliberately changed (suite 963 → 974 passing: 4 repaired + 7 new) [2.1]. The per-area split below comes from the cleared `F1` record and is no longer independently verifiable; the commit message gives only the total.

| Area (brief item) | Confirmed defects | Main fix | Proving tests (`workbench/api/tests/`) |
|---|---|---|---|
| Inference scope and identity (2A, 2B), memory (5) | 6 (agent A); integration: 4 regression tests | Case-scoped bundles refused on the slide endpoint, the worker and the active-learning request and worker paths (`409 scope_mismatch`). One canonical input snapshot per job. Predictions versioned per bundle, scope, slide and snapshot. Image-identity failures fail closed. Concurrent requests give one row. In-place schema migration. Chunked mean. Diversity embeddings only when requested. ABMIL scoring with one bag-sized temporary | `test_inference_scope.py`, `test_inference_snapshot_identity.py`, `test_inference_memory.py` |
| Fold-safe preprocessing (3), ABMIL refit, calibration gate and labelling (7), fold stability | 8 (agent B); integration: 2 regression tests | A dataset-fitted shared Macenko reference is refused under `dev_cv` and learning curves, at creation and in the worker; contaminated historical results are marked invalid for CV comparison. ABMIL selects the epoch count on an inner hold-out, then refits on every permitted bag. Calibration gates count patient groups. In-sample calibration is labelled. Folds are independent of head, seed and scorability. Learning-curve subsets are drawn within folds. Comparisons refuse CV-invalid runs and runs with different fold assignments | `test_fold_safe_preprocessing.py`, `test_abmil_refit.py`, `test_calibration_evidence.py`, `test_cv_fold_stability.py` |
| Active-learning cohort protection (6) | 11 (agent C) | Patient-level acquisition exposure is persisted atomically. The allocator never puts exposed patients, their duplicate partners or moved linked material in val/test. Proposal/freeze races are caught. Historical conflicts are reported without being rewritten | `test_al_cohort_protection.py` |
| Experiment driver (4, plus the driver side of 3 and 7) | 5 (agent D); integration: 1 regression test | Canonical per-stage fingerprints with integrity checks and an explicit dependency graph (valid / missing / failed / stale). s6 is never automatic. s8 refuses stale inputs. Blocked Macenko arms are not evidence. Three pre-declared seeds. Development-only budget comparison. Unscorable subjects counted. The ABMIL refit fields are carried into the run record | `test_driver_fingerprints.py`, `test_evidence_export.py` |

After round 1 (commit message): backend `pytest` 974 passed, plus the slow test; web `tsc` clean, vitest 47, Playwright 25. The 49.6 s Playwright duration came from the cleared `F1` record [2.2].

### 2.2 Round 2: adversarial verification of round 1 (commit `8a1a59e`)

Five verifiers wrote `tests/test_verify2_*.py` against the round-1 fixes. **32 defects** were confirmed and fixed at the root, and no verifier test was weakened [2.3]. The per-lens split in the table comes from the cleared `F2` record; the commit message gives the total and the lenses, not the split.

| Lens | Fixed | Examples | Proving tests |
|---|---|---|---|
| Inference | 3 | A re-ingest racing an inference job is never recorded as the input's outcome; an input reverted after its queued job ran can be re-scored; an object replaced in place is refused on the reuse path | `test_verify2_inference.py`, `test_inference_request_identity.py` |
| Fold safety | 9 | Duplicate chains through excluded or unscorable slides stay whole in outer folds, inner ABMIL splits, calibration gates and holdout reference checks; holdout heads fitted on a duplicate of a validation patient are flagged; fold-unsafe benchmarks are refused before any extraction and leave no queued runs | `test_verify2_fold_safety.py`, `test_duplicate_closure.py` |
| Active-learning protection | 7 | Model-selected patients are flagged when scored OOF or in validation; a test release on a test split holding model-selected material is refused (`409 acquisition_exposed_in_evaluation`); the "representative cohort" claim is now accurate; the pool honours the dataset's reference standard | `test_verify2_al.py` |
| Driver and exporter | 4 | The exporter never counts a stage the driver holds invalid; missing or corrupted artifacts and crashed ablation arms invalidate a stage; the release history never invents releases | `test_verify2_driver.py` |
| Reporting | 9 | Paired comparisons count bags with no tissue patches as unscorable; one shared paired comparison with subject accounting; deltas at tuned thresholds are labelled tuning estimates; the imported-reference notice is on every result surface; learning-curve points state the patients that fitted the scored fold models; the prediction unit is stated | `test_verify2_reporting.py`, `test_reporting_accounting.py` |

### 2.3 Test status

Not re-run for this report; read from the records.

| Check | Result | Source |
|---|---|---|
| Backend and ML `pytest` (HEAD `8a1a59e`) | **1081 passed**, 1 deselected (the slow test); 342.43 s *(cleared record)* | [2.4] |
| Slow test (`-m slow`) | 1 passed; 21.69 s *(cleared record)* | [2.4] |
| Web `npx tsc --noEmit` | clean (exit 0) | [2.4] |
| Web `npx vitest run` | **47 passed** (2 files *(cleared record)*) | [2.4] |
| Playwright | **25 passed**, stated by both commit messages. The 49.6 s duration, and the note that the round-2 check did not re-run it, come from cleared records | [2.2], [2.4] |
| Working tree (uncommitted evidence tooling: `export_evidence.py` changes, two new scripts, 7 new tests) | 1088 passed, 1 deselected, 270.22 s *(cleared record; not independently verifiable)*. Since then the fact-check corrections added 4 exporter tests; the full suite was not re-run for this report | [2.5] |
| Lint (`ruff`) | not run: not installed in the venv (re-checked 2026-11-09) | [2.5] |

Passing tests establish engineering behaviour. They do not establish clinical accuracy.

**Open tooling defect, found but not fixed in this round.** `dermpath/ml/feature_sets.py` `extract_slide` loads the encoder **before** its cache lookup. Inference on a slide whose features are cached therefore still loads Midnight-12k: 9.296 s of a 9.573 s job, with a peak-RSS rise of 5,956,632,576 bytes. Proposed fix: load the encoder lazily on a cache miss, with a regression test (§5) [2.6].

**Sources §2.**
[2.1] Commit `7ba0435` message ("every confirmed defect was first reproduced by a failing test, then fixed (30 in total)"; "pytest 974 passed"). *(cleared record)* `F1` → `built[A-inference|B-training-protocol|C-al-cohort-protection|D-driver].result.confirmed` (6 + 8 + 11 + 5 = 30), `integration` (7 regression tests, 4 repaired tests, 963 → 974). [2.2] Commit `7ba0435` message ("pytest 974 passed (+1 slow memory test); web tsc clean, vitest 47, Playwright 25"); *(cleared record)* `F1` → `integration.tests` (49.6 s). [2.3] Commit `8a1a59e` message ("32 defects fixed"; "no verifier test weakened"); *(cleared record)* `F2` → `fixes[*].fixed` (3 + 9 + 7 + 4 + 9 = 32). [2.4] Commit `8a1a59e` message ("pytest 1081 passed (+1 slow); web tsc clean, vitest 47, Playwright 25"); *(cleared record)* `F2` → `check.{pytest,slow,web}` (durations, file count). [2.5] *(cleared record)* session scratchpad `evidence_work/pytest_full.log` (last line) and the evidence agent's result; `ruff`: `api/.venv/bin` has no `ruff`. [2.6] `E/attachments/inference_measurement.json` → `measurement.time_breakdown_seconds`, `measurement.peak_rss_bytes.delta_during_job`, `labels[2]`.

---

## 3. Real numerical results

### 3.1 Cohort, units and reconciliation

| | Documented (`docs/public-datasets.md`) | Actual frozen version `1868803e` |
|---|---|---|
| Slides | 60 | 60 |
| Patients | 50 | 50 |
| Cases / blocks | 56 / 56 | 56 / 56 |
| Slide labels (`bcc_present` / `bcc_absent_not_benign`) | 30 / 30 | 30 / 30 |
| Patients under `any_positive` (positive / negative) | 26 / 24 | 26 / 24 |
| Slides counted by **patient** label (from positive / negative patients) | not stated | 32 / 28 |
| Mixed-label patients | 2 | 2, both in the development pool |
| Site / scanner model | one / one | one (Radboudumc) / one (3DHistech Pannoramic 1000; scanner id `3d-histech-panoramic-p1000`) |
| Split | seed 0, 60/20/20 (illustrative) | **seed 20261027, train 0.7 / val 0 / test 0.3** |

The exporter's reconciliation reports `matches: true` [3.1].

| Frozen split | Patients (positive / negative) | Slides (`bcc_present` / `bcc_absent_not_benign`) | Cases |
|---|---|---|---|
| Development pool (train; val ratio 0) | **35** (18 / 17) | **45** (22 / 23) | 41 |
| Test (never released) | **15** (8 / 7) | **15** (8 / 7) | 15 |

[3.2]

**Units.**
- The prediction unit is the **slide (bag)**: each slide is one bag of up to 256 patches.
- The resampling unit for every interval is the **patient**: a patient-cluster percentile bootstrap, 2,000 replicates.
- The independent units are the **35 development patients**.
- Evaluation prevalence is 22/45 scored bags (0.489). PPV and NPV at this enriched prevalence do not transfer to a clinical population [3.3].
- Patient-group counts per class are 18 positive and 19 negative. The two mixed-label patients have bags of both classes, so these counts sum to 37, not 35 [3.3].

### 3.2 Protocol (identical for all compared models)

- `dev_cv` with 5 patient-grouped stratified folds over the development pool. Each fold holds out 7 patients and fits on 28. Folds depend only on the pool and k, and are identical across heads, encoders and seeds.
- The test split was not used by any run (`test_items_used` 0); it is unreleased in the real study and not used for model selection. 4 of its patients were in pre-freeze dry runs (§7), and its 15 slides were feature-extracted label-free.
- Threshold: Youden, chosen on OOF scores. Calibration: Platt, fitted on OOF scores. Class weights balanced. No abstention policy was requested.
- Mean-pool head: L-BFGS logistic regression, C = 1.0.
- ABMIL head: Adam; attention dim 64; hidden 128; dropout 0.1; lr 5e-4; at most 60 epochs; patience 10; at most 256 instances per bag. The epoch count is selected on an inner patient-grouped hold-out of about 20 %. A fresh model is then fitted on all 45 development bags (35 patients) for that count. For example, the candidate run selected epoch 7 of 17 on 34 fit bags / 11 hold-out bags.
- No hyperparameter search.
- Seeds 0, 1 and 2 were declared before any multi-seed result. Seed repeats measure optimisation variability on the same patients and folds; they are not extra patients.

[3.4]

### 3.3 Four-way comparison: threshold-free OOF metrics

All 12 runs scored all 45 bags of the 35 patients: 0 unscorable, 0 abstained. CIs are patient-clustered 95 % percentile intervals. Brier and ECE are on raw scores. "Calibrated ECE" is **in-sample** (the Platt map was fitted on these same scores). Every run's calibration status is `fitted`. The gate passed with 18 positive and 19 negative patient groups, against a minimum of 5 per class [3.5].

| Encoder + head | Seed | AUROC [95 % CI] | AUPRC [95 % CI] | Brier | ECE | Calibrated ECE (in-sample) |
|---|---|---|---|---|---|---|
| handcrafted + mean-pool | 0 | 0.769 [0.604, 0.897] | 0.761 [0.569, 0.909] | 0.214 | 0.177 | 0.092 |
| handcrafted + mean-pool | 1 | 0.769 [0.611, 0.898] | 0.761 [0.566, 0.907] | 0.214 | 0.177 | 0.092 |
| handcrafted + mean-pool | 2 | 0.769 [0.610, 0.891] | 0.761 [0.578, 0.908] | 0.214 | 0.177 | 0.092 |
| handcrafted + ABMIL | 0 | 0.834 [0.692, 0.946] | 0.839 [0.676, 0.953] | 0.181 | 0.126 | 0.113 |
| handcrafted + ABMIL | 1 | 0.791 [0.609, 0.935] | 0.768 [0.568, 0.939] | 0.214 | 0.149 | 0.176 |
| handcrafted + ABMIL | 2 | 0.830 [0.680, 0.939] | 0.833 [0.666, 0.945] | 0.180 | 0.122 | 0.067 |
| Midnight-12k + mean-pool | 0 | 0.844 [0.733, 0.941] | 0.833 [0.665, 0.955] | 0.204 | 0.191 | 0.146 |
| Midnight-12k + mean-pool | 1 | 0.844 [0.734, 0.936] | 0.833 [0.647, 0.952] | 0.204 | 0.191 | 0.146 |
| Midnight-12k + mean-pool | 2 | 0.844 [0.735, 0.940] | 0.833 [0.664, 0.956] | 0.204 | 0.191 | 0.146 |
| Midnight-12k + ABMIL | 0 (candidate) | 0.947 [0.863, 0.998] | 0.948 [0.864, 0.998] | 0.098 | 0.108 | 0.067 |
| Midnight-12k + ABMIL | 1 | 0.927 [0.831, 1.000] | 0.915 [0.781, 1.000] | 0.109 | 0.141 | 0.159 |
| Midnight-12k + ABMIL | 2 | 0.945 [0.855, 0.998] | 0.929 [0.812, 0.998] | 0.081 | 0.104 | 0.122 |

The pre-declared candidate rule picks the combination with the highest mean OOF AUROC over the three seeds, and then that combination's first-seed run. It was written into `s3.json` with 0 test releases in the project. The ranking was: Midnight + ABMIL 0.939, Midnight + mean-pool 0.844, handcrafted + ABMIL 0.818, handcrafted + mean-pool 0.769. The candidate is `ba364f52`. This rule selects what a test release *would* evaluate. It does not declare a winner [3.6].

### 3.4 Threshold-dependent OOF metrics (tuning estimates)

**All values in this table are tuning estimates (optimistic).** The Youden threshold was selected on these same OOF scores [3.7].
- Precision = PPV; recall = sensitivity.
- Confusion counts are derived from the numerators and denominators: TP = sensitivity numerator, FN = 22 − TP, TN = specificity numerator, FP = 23 − TN.
- Sensitivity and specificity CIs are patient-clustered.

| Encoder + head | Seed | Threshold | Sensitivity (recall) | Specificity | Precision (PPV) | NPV | TP / FN / TN / FP |
|---|---|---|---|---|---|---|---|
| handcrafted + mean-pool | 0, 1, 2 | 0.342 | 19/22 = 0.864 [0.714, 1.000]¹ | 13/23 = 0.565 [0.333, 0.773]¹ | 19/29 = 0.655 | 13/16 = 0.812 | 19 / 3 / 13 / 10 |
| handcrafted + ABMIL | 0 | 0.649 | 15/22 = 0.682 [0.474, 0.889] | 19/23 = 0.826 [0.611, 1.000] | 15/19 = 0.789 | 19/26 = 0.731 | 15 / 7 / 19 / 4 |
| handcrafted + ABMIL | 1 | 0.458 | 18/22 = 0.818 [0.667, 0.955] | 17/23 = 0.739 [0.520, 0.926] | 18/24 = 0.750 | 17/21 = 0.810 | 18 / 4 / 17 / 6 |
| handcrafted + ABMIL | 2 | 0.674 | 16/22 = 0.727 [0.474, 0.931] | 18/23 = 0.783 [0.594, 0.933] | 16/21 = 0.762 | 18/24 = 0.750 | 16 / 6 / 18 / 5 |
| Midnight-12k + mean-pool | 0, 1, 2 | 0.265 | 20/22 = 0.909 [0.765, 1.000]¹ | 15/23 = 0.652 [0.500, 0.818]¹ | 20/28 = 0.714 | 15/17 = 0.882 | 20 / 2 / 15 / 8 |
| Midnight-12k + ABMIL | 0 (candidate) | 0.843 | 20/22 = 0.909 [0.783, 1.000] | 21/23 = 0.913 [0.762, 1.000] | 20/22 = 0.909 | 21/23 = 0.913 | 20 / 2 / 21 / 2 |
| Midnight-12k + ABMIL | 1 | 0.765 | 20/22 = 0.909 [0.758, 1.000] | 22/23 = 0.957 [0.852, 1.000] | 20/21 = 0.952 | 22/24 = 0.917 | 20 / 2 / 22 / 1 |
| Midnight-12k + ABMIL | 2 | 0.696 | 20/22 = 0.909 [0.769, 1.000] | 21/23 = 0.913 [0.783, 1.000] | 20/22 = 0.909 | 21/23 = 0.913 | 20 / 2 / 21 / 2 |

¹ The mean-pool runs give identical scores for every seed, because the logistic regression is convex and deterministic. Their CIs differ slightly by seed; the seed-0 CI is shown. Seeds 1 and 2: sensitivity [0.714, 1.000] and [0.706, 1.000] (handcrafted), [0.773, 1.000] and [0.765, 1.000] (Midnight); specificity [0.333, 0.762] and [0.333, 0.767] (handcrafted), [0.500, 0.810] and [0.500, 0.812] (Midnight) [3.7].

Unscorable bags: 0 in every run. Under the intention-to-evaluate rule (unscorable positives counted as false negatives, unscorable negatives as false positives) the values are therefore unchanged. Abstentions: 0, because no abstention policy was requested [3.7].

### 3.5 Paired comparisons (same bags, same folds)

Every comparison pairs the 45 bags of the 35 patients that **every** compared model scored. Bags unscorable under any model: 0, so none was excluded from pairing. Deltas are a − b. The CIs are patient-paired bootstrap intervals with 2,000 replicates, unadjusted for the several comparisons per seed [3.8].

**Encoder effect, head fixed (handcrafted − Midnight-12k), AUROC delta [95 % CI]:**

| Head | Seed 0 | Seed 1 | Seed 2 | Mean | Same sign in all seeds |
|---|---|---|---|---|---|
| mean-pool | −0.075 [−0.222, 0.061] | −0.075 [−0.222, 0.061] | −0.075 [−0.222, 0.061] | −0.075 | yes |
| ABMIL | −0.113 [−0.255, 0.007] | −0.136 [−0.317, 0.025] | −0.115 [−0.259, 0.002] | −0.121 | yes |

AUPRC deltas: mean-pool −0.072 [−0.236, 0.076] in every seed; ABMIL −0.109 [−0.272, 0.012], −0.147 [−0.327, 0.043] and −0.097 [−0.263, 0.015] for seeds 0, 1 and 2 [3.8].

**Head effect, encoder fixed (ABMIL − mean-pool), AUROC delta [95 % CI]:**

| Encoder | Seed 0 | Seed 1 | Seed 2 | Mean | Same sign in all seeds |
|---|---|---|---|---|---|
| handcrafted | 0.065 [−0.037, 0.194] | 0.022 [−0.129, 0.166] | 0.061 [−0.005, 0.140] | 0.049 | yes |
| Midnight-12k | 0.103 [−0.016, 0.220] | 0.083 [−0.029, 0.188] | 0.101 [−0.004, 0.211] | 0.096 | yes |

AUPRC deltas:
- Handcrafted: 0.078 [−0.008, 0.198], 0.008 [−0.157, 0.198], 0.072 [0.009, 0.155].
- Midnight: 0.115 [−0.008, 0.281], 0.082 [−0.062, 0.242], 0.096 [−0.036, 0.263].

[3.8]

**Simplest baseline versus the candidate combination (handcrafted + mean-pool − Midnight-12k + ABMIL):**

| | Seed 0 | Seed 1 | Seed 2 | Mean |
|---|---|---|---|---|
| AUROC delta | −0.178 [−0.333, −0.035] | −0.158 [−0.321, −0.005] | −0.176 [−0.336, −0.034] | −0.171 |
| AUPRC delta | −0.187 [−0.377, −0.040] | −0.154 [−0.354, 0.012] | −0.168 [−0.361, −0.017] | — |

[3.9]

At seed 0, the other four-way pairs had AUROC deltas of:
- handcrafted + ABMIL − Midnight + mean-pool: −0.010 [−0.172, 0.147];
- handcrafted + ABMIL − handcrafted + mean-pool: 0.065 [−0.037, 0.194];
- Midnight + ABMIL − Midnight + mean-pool: 0.103 [−0.016, 0.220].

Six pairs are compared per seed, and no multiplicity adjustment is applied. **No winner is declared by the comparisons** [3.9].

### 3.6 Seed variability (optimisation variability, not independent patients)

| Encoder + head | AUROC by seed (0, 1, 2) | Mean | SD | Range |
|---|---|---|---|---|
| handcrafted + mean-pool | 0.769, 0.769, 0.769 | 0.769 | 0.000 | 0.000 |
| handcrafted + ABMIL | 0.834, 0.791, 0.830 | 0.818 | 0.024 | 0.043 |
| Midnight-12k + mean-pool | 0.844, 0.844, 0.844 | 0.844 | 0.000 | 0.000 |
| Midnight-12k + ABMIL | 0.947, 0.927, 0.945 | 0.939 | 0.011 | 0.020 |

[3.10]

The mean-pool head is a convex fit, so the training seed does not change it. ABMIL's selected epoch count varied with the seed (selected epoch / epochs run before early stopping):

| Encoder | Seed 0 | Seed 1 | Seed 2 |
|---|---|---|---|
| handcrafted | 4 / 14 | 10 / 20 | 16 / 26 |
| Midnight-12k | 7 / 17 | 4 / 14 | 2 / 12 |

Each count was chosen on an inner hold-out of only 7 patients (7–11 bags) [3.11].

### 3.7 Learning curves (mean-pool head only; scored on the same full OOF set)

Nested stratified subsets of the development patients restrict each fold's fitting part. "Fit patients" is the median number of patients that fitted the fold models behind the OOF scores; the per-fold counts are listed. "Final model" is the refit, which scores no OOF bag. Fractions 0.25 and 0.5 have 3 repeats each; fraction 1.0 is the seed-0 grid run [3.12].

| Fraction | Fit patients per fold (median; per fold) | Final-model patients | Handcrafted AUROC, mean (min–max) | Midnight-12k AUROC, mean (min–max) |
|---|---|---|---|---|
| 0.25 | 8 (7, 8, 7, 8, 8) | 9 | 0.641 (0.599–0.704) | 0.690 (0.642–0.715) |
| 0.5 | 14 (15, 14, 15, 14, 14) | 18 | 0.786 (0.733–0.822) | 0.777 (0.743–0.824) |
| 1.0 | 28 (28 in every fold) | 35 | 0.769 | 0.844 |

Least-squares slope of mean OOF AUROC per doubling of fit patients (descriptive only; few repeats, no interval) [3.13]:
- Handcrafted: 0.067 overall; −0.017 over the last doubling (0.5 → 1.0).
- Midnight-12k: 0.084 overall; +0.067 over the last doubling.

No ABMIL learning curve was run.

### 3.8 Near-duplicate sensitivity analysis

**Screen.** The audit's thumbnail dHash screen (Hamming distance ≤ 6) found 2 candidate pairs, neither with a human decision [3.14]. In each pair:
- the two members are different patients with the same slide label;
- both members are in the development pool;
- the members fall in different CV folds:
  - pair 1: dHash 5, `bcc_absent_not_benign`, folds 0 and 3;
  - pair 2: dHash 6, `bcc_present`, folds 0 and 4.

If a pair were a true duplicate, each member's held-out score could come from a fold model that trained on its partner.

**Analysis.** The 4 patients (4 slides: 2 `bcc_present`, 2 `bcc_absent_not_benign`) were removed from every s3 grid run's OOF evaluation. This leaves 41 bags from 31 patients, and no test patient was involved. Nothing was retrained: fold models, thresholds and calibration are unchanged. The analysis used the engine's own metric and comparison functions on a read-only database copy. Every full-set number reproduced `s3.json` and the database exactly (`reproduced: true`) [3.14].

| Encoder + head | Mean OOF AUROC over seeds, 35 patients | Same, 31 patients |
|---|---|---|
| Midnight-12k + ABMIL | 0.939 | 0.948 |
| Midnight-12k + mean-pool | 0.844 | 0.826 |
| handcrafted + ABMIL | 0.818 | 0.821 |
| handcrafted + mean-pool | 0.769 | 0.771 |

Per seed for the candidate combination: 0.947 [0.863, 0.998] → 0.969 [0.904, 1.000] (seed 0); 0.927 → 0.921 (seed 1); 0.945 → 0.955 (seed 2) [3.14].

Mean paired AUROC deltas over the three seeds, with all patients → after the exclusion [3.14]:
- encoder effect at ABMIL: −0.121 → −0.127;
- encoder effect at mean-pool: −0.075 → −0.055;
- head effect at handcrafted: 0.049 → 0.050;
- head effect at Midnight: 0.096 → 0.122.

Per-seed CIs that exclude 0: 0 of 12 with all patients, and 3 of 12 after the exclusion (encoder effect at ABMIL in seed 2; head effect at Midnight in seeds 0 and 2). These CIs are unadjusted. The two analyses use different replicate streams, so the difference between them is not a paired estimate [3.14].

No AUROC effect changes direction. One AUPRC effect does: the head effect on handcrafted features at seed 1 (ABMIL − mean-pool) goes from +0.008 to −0.023 [3.14].

**Reading.** The candidate rule picks the same combination after the exclusion. That check is for robustness only; the pre-declared candidate is unchanged. Removing the 4 patients moved the mean OOF AUROC by between −0.018 (Midnight-12k + mean-pool) and +0.009 (Midnight-12k + ABMIL). Only 4 patients were removed, nothing was retrained, and the full and restricted intervals come from unpaired replicate streams, so this check neither shows nor rules out inflation of the OOF estimates by the undecided pairs. A human decision on both pairs is still required before any final benchmark [3.14].

### 3.9 Ablations (s4; mean-pool head; seed 0; development OOF)

**Uniform versus spatial sampling** at 256 patches; deltas are uniform − spatial [3.15]:

| Encoder | AUROC uniform / spatial | AUROC delta [95 % CI] | AUPRC delta [95 % CI] | McNemar discordant (b / c), p |
|---|---|---|---|---|
| handcrafted | 0.775 / 0.769 | +0.006 [−0.041, 0.053] | −0.011 [−0.059, 0.024] | 4 / 2, p = 0.688 |
| Midnight-12k | 0.838 / 0.844 | −0.006 [−0.060, 0.054] | +0.002 [−0.041, 0.058] | 6 / 4, p = 0.754 |

McNemar uses tuned thresholds and treats bags as independent, so it is approximate.

Coverage over all 60 slides, spatial vs uniform:
- median tissue within the sampling radius: 0.797 vs 0.703;
- mean fragments without a sampled patch: 19.28 vs 19.43;
- median sampled tissue fraction: 0.152 vs 0.152.

[3.16]

**Macenko stain normalisation: BLOCKED.** Under `dev_cv`, the `macenko-v1` reference is fitted once on the train-split slides, and that split *is* the development pool. Every development patient is held out by exactly one fold, so each fold's held-out images would shape the normalisation of its own fitting data. That is label-free preprocessing leakage of unknown size. The engine's fold-safety precheck refused both arms (`fold_unsafe_preprocessing`) before any extraction, so they are not evidence. The remedy the engine names is either `holdout` at train fraction 1, or fold-specific fitting, which is not implemented [3.17].

**fp16 and bf16 precision (Midnight-12k on MPS).**
- *Acceptance rule*, declared before measurement: on at least 32 real tissue patches, the fp32 reference and the candidate (same spec and weights) must have cosine_min ≥ 0.999, rel_L2 ≤ 0.05, and all outputs finite. An accepted low-precision set is still a separate feature set.
- *Test patches:* 512 seeded patches from the 45 development slides [3.18].

| Precision | cosine_min | rel_L2 | Throughput (patches/s) | Speed-up vs fp32 | Accepted |
|---|---|---|---|---|---|
| fp32 (reference) | — | — | 5.363 | 1.000 | — |
| fp16 | 0.99957 | 0.0038 | 6.417 | 1.197 | **yes** |
| bf16 | 0.99835 | 0.0197 | 6.424 | 1.198 | **no** (cosine_min < 0.999) |

[3.18]

**Downstream effect of the accepted fp16 set** (Midnight-12k + mean-pool, run `4efbd45e` vs `b7abc046`; fp16 − fp32) [3.19]:
- AUROC 0.840 vs 0.844, delta −0.004 [−0.018, 0.000].
- AUPRC delta −0.004 [−0.019, 0.000].
- Brier delta +0.0004 [−0.0010, 0.0021].
- The refitted threshold moved from 0.265 to 0.821. Sensitivity therefore fell (0.727 vs 0.909, delta −0.182 [−0.350, −0.043]) and specificity rose (0.826 vs 0.652, delta +0.174 [0.042, 0.345]). Both are tuning estimates.
- McNemar: 4 vs 4 discordant bags, p = 1.0.
- Ranking (threshold-free) was essentially unchanged; the operating point was not, so a precision change needs its own threshold.

### 3.10 Sampling budget 256 vs 512 (development data only; s4b)

The higher budget, 512, was declared before any budget comparison. 1024 was not run, for cost. ABMIL was excluded from s4b because its instance cap per bag would confound the comparison. All values below are over the 45 development slides; the test split was not read [3.20].

| | Handcrafted | Midnight-12k |
|---|---|---|
| Patches per slide, 512 budget (mean, min) | 508.2, 402 | 508.2, 402 |
| Fragments without a sampled patch, 256 → 512 (mean; median) | 19.44 → 14.24; 10 → 5 | 19.44 → 14.24; 10 → 5 (same sampling plan) |
| Slides with fewer unsampled fragments | 39 of 45 | 39 of 45 |
| Median sampled tissue fraction, 256 → 512 | 0.147 → 0.296 | 0.147 → 0.296 |
| Median tissue within the sampling radius, 256 → 512 | 0.781 → 0.973 | 0.781 → 0.973 |
| OOF AUROC, 256 / 512 | 0.769 / 0.753 | 0.844 / 0.816 |
| AUROC delta, 256 − 512 [95 % CI] | +0.016 [−0.036, 0.068] | +0.028 [−0.007, 0.070] |
| AUPRC delta, 256 − 512 | +0.027 [−0.020, 0.092] | +0.020 [−0.006, 0.059] |
| Brier delta, 256 − 512 | −0.004 [−0.019, 0.013] | −0.024 [−0.044, −0.006] |
| Mean absolute score change per bag (max) | 0.041 (0.196) | 0.037 (0.174) |
| Decision flips at each run's own threshold (to correct / to incorrect), patients affected | 7 (4 / 3), 7 | 6 (2 / 4), 6 |
| Fresh extraction, s/slide (mean): 256 (original extraction) → 512 | 4.40 → 8.72 | 55.72 → 98.83 |
| Storage per slide (mean bytes): 256 → 512 | 85,834 → 163,577 | 3,163,387 → 6,278,274 |
| Feature-set build wall time at 512, all 60 slides | 520.1 s | 5,937.7 s |

[3.20]

Doubling the budget roughly doubled the sampled tissue fraction and the per-slide cost. It did **not** improve development discrimination for either encoder; both point estimates favour 256, with CIs that include 0. For Midnight-12k, the Brier score was better at 256 (CI excludes 0).

**Memory.** The process high-water mark had already reached 6,799,605,760 bytes before s4b, so per-budget memory could not be separated (`peak_rss_delta_bytes` 0). The coverage figures are tissue coverage, not lesion coverage [3.20].

### 3.11 Resources

**Extraction.** Per-slide times and peak RSS come from each artifact's own first, cold extraction. For the first four rows that extraction was made by the stale pre-fix run (code `782668c`) and reused after identity checks (§1.3): all 60 slides of the two s2 rows and of the handcrafted uniform row, and 30 of the 60 of the Midnight-12k uniform row (the other 30 by the post-fix run). The last three rows were extracted by the post-fix run. Peak RSS is the getrusage high-water mark of the extracting process, which is monotonic and includes everything that process had loaded before [3.21], [1.20].

| Feature set (source) | Device, precision | Patch read (patches/s) | Embedding (patches/s) | End-to-end s/slide: mean (min–max) | Peak RSS (bytes) | Storage per slide (mean bytes) |
|---|---|---|---|---|---|---|
| handcrafted, spatial 256 (s2) | cpu fp32 | 183.8 | 88.8 | 4.42 (4.02–4.95) | 934,838,272 | 85,810 |
| Midnight-12k, spatial 256 (s2) | mps fp32 | 158.7 | 4.66 | 56.66 (49.33–70.61) | 5,880,561,664 | 3,162,427 |
| handcrafted, uniform 256 (s4) | cpu fp32 | 170.8 | 84.6 | 4.66 | 5,880,561,664¹ | 85,774 |
| Midnight-12k, uniform 256 (s4) | mps fp32 | 170.5 | 5.25 | 50.32 | 5,880,561,664¹ | 3,162,391 |
| Midnight-12k, spatial 256 fp16 (s4) | mps fp16 | 162.8 | 6.37 | 41.88 | 6,799,605,760¹ | 3,162,427 |
| handcrafted, spatial 512 (s4b) | cpu fp32 | 183.5 | 88.4 | 8.65 | 6,799,605,760¹ | 163,586 |
| Midnight-12k, spatial 512 (s4b) | mps fp32 | 189.2 | 5.30 | 98.72 | 6,799,605,760¹ | 6,278,684 |

¹ Process-wide high-water mark of a process that had already loaded Midnight-12k. It is not attributable to this set.

**Cache reuse** (s2, all 60 slides were cache hits) [3.22]:
- handcrafted: 0.071 s/slide median, a median speed-up of 61.4×;
- Midnight-12k: 0.046 s/slide median, a median speed-up of 1,215.8×.

These speed-ups were measured with the encoder already loaded in the driver process (Midnight-12k `encoder_load_seconds` 0.002), so they leave out the encoder load. In a fresh process, the one cached inference job took 9.573 s against the 54.960 s cold extraction of the same slide, about 5.7× *(derived: 54.960 / 9.573)*; 9.296 s of the job was the encoder load [3.24].

A cache hit still verifies slide and object hashes. Determinism validation on 2 seeded slides per encoder, re-extracted with the post-fix code, gave a max abs diff of 0 and identical coordinates.

**Training** [3.23]:
- 24 s3 runs, 91.04 s in total.
- ABMIL: 6 runs, mean 14.58 s, max 26.90 s (Midnight-12k + ABMIL seed 0).
- Mean-pool: 18 runs, mean 0.199 s.

**Real-WSI inference measurement** [3.24]:
- *Setup.* The declared candidate was registered as bundle `593059e2`. One `infer_slide` job then ran through the public services with an in-process worker. The slide was the largest development slide (train split; the engine's test-material check returned none): 176,894,082 bytes, 30,208 × 25,088 px, 7 levels.
- *Job.* It succeeded at the first attempt in 9.573 s recorded (9.575 s worker wall time), with 256 patches and embedding dim 3072.
- *Features came from the cache.* The extraction call reported a cache hit, 0 new feature-artifact rows were created, and the artifact is the same one as in the s2 record.
- *Breakdown:* encoder load inside the extraction call 9.296 s; sampling plan and cache lookup 0.261 s; everything else (bundle, snapshot and object verification, ABMIL scoring, recording) 0.016 s.
- *Memory:* peak RSS 294,338,560 bytes after the engine import and 6,250,971,136 bytes after the job. The encoder load accounts for the rise.
- *Cold cost of the same slide,* from its extraction records: 54.960 s at 256 patches, of which 52.958 s embedding and 1.665 s read; 99.382 s at 512 patches; 4.520 s for handcrafted features. The 256-patch Midnight-12k and the handcrafted extractions were made by the stale pre-fix run and reused (§1.3); the 512-patch one by the post-fix run.
- A prediction row was recorded in the database (`inference_predictions` 0 → 1); its score is not reported here. The slide is a training slide of the final model, so any score would not be a performance estimate.

**Synthetic memory fixture (SYNTHETIC; resource behaviour only, not diagnostic quality)** [3.25]:
- *Fixture:* a 100,000 × 1,536 float32 memory-mapped array (614,400,128 bytes), chunk size 4,096, numpy 2.4.2.
- *Old whole-matrix float64 mean:* tracemalloc peak 1,228,815,349 bytes; incremental anonymous memory 1,229,737,408 bytes.
- *Chunked mean:* tracemalloc peak 50,359,733 bytes; incremental anonymous memory 33,440,000 bytes. Total RSS rose by 664,748,032 bytes, mostly clean file-backed memmap pages.
- *`score_slide` with an embedding:* tracemalloc peak 52,466,592 bytes.
- *Parity:* max abs diff 4.3e-19.
- The fixture is `tests/test_inference_memory.py::test_large_memmap_inference_peak_memory_and_parity`, a slow test.

### 3.12 Failure analysis (development OOF; s7)

The categories are possible contributing factors, never causes. With imported labels, a discordance is "discordance with the imported reference", not proof of a label error [3.26].

| Encoder + head | Errors per seed (FN / FP) | Seeds 0, 1, 2 |
|---|---|---|
| handcrafted + mean-pool | 13 (3 / 10) | identical |
| handcrafted + ABMIL | 11 (7 / 4), 10 (4 / 6), 11 (6 / 5) | |
| Midnight-12k + mean-pool | 10 (2 / 8) | identical |
| Midnight-12k + ABMIL | 4 (2 / 2), 3 (2 / 1), 4 (2 / 2) | |

Over the 12 grid runs [3.26]:
- 112 errors: 74 false positives and 38 false negatives *(derived: sum of `counts` over the 12 runs)*.
- Dominant category tags: `confident_error` 57 (0.509 of tags), `uncategorised` 34, `near_threshold` 21.
- Two categories could not be assessed:
  - `mimic_category`: the negative labels carry no category;
  - `small_lesion`: there is no expert outline of lesion area.

**Persistent errors** *(derived from `R/s7.json` by counting each bag's errors across the 12 grid runs; mixed-label membership from `R/s1.json`; no identifiers are reproduced here)* [3.27]:
- 26 distinct development bags erred in at least one grid run; 8 erred in at least 6 of the 12.
- **The most persistent error** is a `bcc_absent_not_benign` slide of the mixed-label patient whose two **specimens** carry different labels. 11 of 12 grid runs called it positive. All three Midnight-12k + ABMIL runs scored it at ≥ 0.9996.
- The other mixed-label patient has two slides of the **same specimen and block** with different labels. Both of its slides were misclassified by several models, in opposite directions: the BCC-absent slide was called positive by all 6 handcrafted runs, and the BCC-present slide was called negative by 5 runs.
- This is consistent with the documented hazard that a report-level diagnosis was copied to a slide that does not show the lesion. It cannot be confirmed without an expert read of those slides.
- The candidate combination erred on 7 distinct bags across its three seeds; 1 of them (the persistent false positive above) erred in all three.

**Sources §3.**
[3.1] `E/dataset.json` → `cohort_reconciliation`, `counts`, `audit_summary.mixed_label_patients`; `R/s1.json` → `audit_now.confounding.label_by_site.{table,slide_table}` (patients 26/24; slides by patient label 32/28), `audit_now.confounding.label_by_scanner.slide_table`; `R/s1.json` → `public_dataset.limitations[1]` (scanner model name), `audit_now.confounding.label_by_scanner.slide_table` (scanner id); `docs/public-datasets.md` (documented column); `INV` §3 (cases per split). [3.2] `R/s1.json` → `split_table`, `split_diagnostics.{patients_per_split,slides_per_split}`; `INV` §3 table (41 / 15 cases). [3.3] `R/s3.json` → `runs[0].oof.{evaluation_prevalence,bootstrap}`, `runs[0].oof.calibration.selection.evidence.{positive_units,negative_units}`, `runs[0].effective_sampling.class_counts`. [3.4] `R/s3.json` → `protocol`, `optimisation_budgets`, `runs[3].training_summary.{epoch_selection,final_fit}`, `runs[*].folds`, `runs[*].test_items_used`, `test_untouched_check`, `protocol.test`; `R/s3.json` → `seed_summary.note`; `R/s4b.json` → `encoders.*.resources.test_slides_extracted_label_free` (15); `E/test_releases.json` → `disclosures.dry_runs`. [3.5] `R/s3.json` → `runs[0..11].oof.{threshold_free,calibration,n_unscorable}`, `runs[*].operating_point.abstention.kind`, `runs[*].oof.calibration.selection.evidence`; mirror `E/results.json` → `development_comparison.runs_oof[0..11]`. [3.6] `R/s3.json` → `pre_declared_test_candidate.{rule,ranking,chosen,test_releases_in_project_at_declaration}`, `selection_note`. [3.7] `R/s3.json` → `runs[0..11].oof.{threshold,at_operating_point.{sensitivity,specificity,ppv,npv},intention_to_evaluate}`, `runs[*].operating_point.abstention`. [3.8] `R/s3.json` → `comparisons.by_seed.{0,1,2}.{encoder_effects,head_effects}[*].deltas[0].{auroc,auprc}`, `.subject_accounting`; `comparisons.across_seeds.{encoder_effects,head_effects}[*].{auroc_delta.mean,sign_consistent}`; mirror `E/results.json` → `development_comparison.comparisons_by_seed`. [3.9] `R/s3.json` → `comparisons.by_seed.{0,1,2}.four_way.deltas[*]`, `comparisons.across_seeds.four_way[3].auroc_delta.mean`; `R/s4.json` → `precision.downstream_fp16.comparison.result.multiple_comparisons.note` (the no-winner policy). [3.10] `R/s3.json` → `seed_summary.per_model[*].{auroc,auroc_by_seed}`. [3.11] `R/s3.json` → `runs[1,3,5,7,9,11].training_summary.epoch_selection.{best_epoch,epochs_run,fit,holdout}`. [3.12] `R/s3.json` → `learning_curves[0,1].points[*].{fraction,auroc_mean,auroc_min,auroc_max,train_patients,final_model_patients}`, `points[*].repeats[*].train_patients_by_fold`. [3.13] `R/s7.json` → `learning_curve_slopes[*].{auroc_per_doubling_of_patients,last_segment}`. [3.14] `E/attachments/sensitivity_near_duplicates.json` → `near_duplicates.{screen,undecided_pairs,excluded}`, `runs[*]`, `runs_across_seeds[*].{auroc_all,auroc_excluding}.mean`, `comparisons_across_seeds[*].{all,excluding}.{auroc_delta.mean,auroc_ci_excludes_zero_in_seeds}`, `candidate_rule_check`, `reproduced`, `caveats`. [3.15] `R/s4.json` → `arms.a_sampling_uniform.*.comparison.{deltas[0],result.per_model,result.pairs[0].mcnemar.all}`, `result.mcnemar_note`. [3.16] `R/s4.json` → `coverage_side_by_side.*.aggregate.{spatial,uniform}`. [3.17] `R/s4.json` → `arms.b_stain_macenko.*.{code,blocked_at,engine_fold_safety}`, `macenko_note`, `not_evidence`. [3.18] `R/s4.json` → `precision.{acceptance_rule,candidates.*.comparison,candidates.*.throughput,candidates.*.speedup_vs_fp32,fp32.throughput,patches}`. [3.19] `R/s4.json` → `precision.downstream_fp16.{run.run_id,baseline_run_id,comparison.deltas[0],comparison.result.per_model,comparison.result.pairs[0].mcnemar.all,comparison.tuning_set_note}`. [3.20] `R/s4b.json` → `budgets`, `skipped_work`, `encoders.*.{coverage,comparison.deltas[0],comparison.result.per_model,prediction_changes,resources,costs}`, `encoders.*.feature_set.build.wall_seconds`; `R/summary.json` → `key_numbers.sampling_budget.encoders.*.slides_with_fewer_unsampled_fragments`; `E/exclusions.json` → `supplement.not_run[1]`. [3.21] `R/s5.json` → `extraction[0..6]`, `definitions`. [3.22] `R/s5.json` → `extraction[0,1].{cache_hit_seconds_per_slide.median,cache_reuse_speedup.median}`; `R/s2.json` → `encoders.*.cache_reuse`, `encoders.*.technical_validation`; `R/summary.json` → `key_numbers.technical`. [3.23] `R/s5.json` → `training.{training_seconds,by_head}`. [3.24] `E/attachments/inference_measurement.json` → `slide`, `registration`, `measurement.{job_seconds_recorded,worker_wall_seconds,patch_count,embedding_dim,features_cache_hit_evidence,time_breakdown_seconds,peak_rss_bytes}`, `cold_extraction_from_records.{midnight_spatial_256_s2,midnight_spatial_512_s4b,handcrafted_spatial_256_s2}`, `measurement.{prediction_recorded,scored}`, `safety_before`, `safety_after` (`inference_predictions` 0 → 1), `labels`; `R/s2.json` → `encoders.midnight-12k.cache_reuse.encoder_load_seconds` (0.002). [3.25] Commit `7ba0435` message ("1.23 GB to 33 MB (parity 4e-19)"); the byte-level figures came from `F1` → `integration.tests` paragraph (4) *(cleared record)*. The fixture can be re-run: `pytest -m slow tests/test_inference_memory.py`. [3.26] `R/s7.json` → `oof_runs[role=grid].{counts,categories,not_assessable}`, `dominant_categories.grid_runs_oof`, `note`; mirror `E/results.json` → `failure_analysis`. [3.27] `R/s7.json` → `oof_runs[role=grid].errors[*].{bag_id,error_type,score,label,patient_code}` counted across runs; `R/s1.json` → `audit_now.mixed_label_patients.patient_codes`; specimen/block descriptions of the two mixed-label patients from `docs/public-datasets.md` §1 ("Mixed-label patients"; matched to the codes locally, codes not reproduced).

---

## 4. Did the learned encoder or head beat the simpler baseline on this cohort?

**Answer, for development out-of-fold estimates on this cohort only.** The baseline is handcrafted stain/texture features with mean-pool logistic regression.

**1. Combined effect: yes, in direction, in every seed.** Midnight-12k with ABMIL had higher OOF AUROC than the baseline in all three pre-declared seeds. The paired AUROC deltas (baseline − Midnight + ABMIL) were −0.178, −0.158 and −0.176 (mean −0.171), with patient-clustered 95 % CIs of [−0.333, −0.035], [−0.321, −0.005] and [−0.336, −0.034]. Each unadjusted per-seed CI excludes 0, seed 1 only marginally. For AUPRC, 2 of 3 seeds exclude 0 [3.9].

**2. Each factor alone: direction consistent, interval includes 0.**
- *Encoder (head fixed).* Midnight-12k had the higher point estimate in every seed. Written as Midnight-12k − handcrafted, the mean ΔAUROC was +0.075 with mean-pool (CI [−0.061, 0.222] in every seed) and +0.121 with ABMIL (CI lower bounds −0.007, −0.025 and −0.002) [3.8].
- *Head (encoder fixed).* ABMIL had the higher point estimate in every seed: mean ΔAUROC (ABMIL − mean-pool) +0.049 on handcrafted and +0.096 on Midnight-12k. All six AUROC CIs include 0 [3.8].

So the separate encoder and head effects are **not** established at the 95 % level on 35 patients. For the top-versus-bottom four-way contrast (handcrafted + mean-pool against Midnight-12k + ABMIL), the unadjusted per-seed 95 % CIs exclude 0 in all three seeds, seed 1 only marginally (upper bound −0.005 in the stored direction, handcrafted + mean-pool − Midnight-12k + ABMIL). That contrast was singled out after seeing all four combinations on the same 35 patients, among six unadjusted comparisons per seed. It is development evidence, not an established effect, and it has no held-out confirmation [3.9].

**3. Robustness to undecided near-duplicates.** Excluding the 4 patients of the undecided near-duplicate pairs does not change the ranking or the direction of any AUROC effect. One AUPRC effect changes sign: the head effect on handcrafted features at seed 1 (ABMIL − mean-pool) goes from +0.008 to −0.023 [3.14].

**4. Uncertainty and limits.**
- *Cohort.* 35 development patients (45 slides); intervals are wide, for example the candidate's AUROC CI is [0.863, 0.998].
- *Repeats.* The three seeds measure optimisation variability, not new patients. They share one set of folds and one bootstrap design.
- *Comparisons.* Six pairwise comparisons per seed, unadjusted.
- *Labels.* Imported, report-derived labels, with known slide-level label-noise risk.
- *Data source.* A single site and a single scanner model; enriched prevalence (22/45).
- *Operating point.* The candidate's 20/22 sensitivity and 21/23 specificity are tuning estimates at a threshold chosen on the same scores.
- *Test split.* Unreleased, so there is no held-out estimate at all.

**What this does not support.** Any claim that Midnight-12k + ABMIL is better *for clinical use*, any claim about other sites or scanners, and any comparison with commercial products. The pre-declared candidate exists only to fix in advance what a test release would evaluate.

---

## 5. Largest observed error and resource bottleneck

**Largest observed error: confident false positives on `bcc_absent_not_benign` slides.**
- False positives were 74 of the 112 OOF errors across the 12 grid runs *(derived)*. The mean-pool heads had a false-positive to false-negative ratio of 10 : 3 (handcrafted) and 8 : 2 (Midnight-12k) [3.26].
- `confident_error` is the dominant tag (0.509 of tags) [3.26].
- The single most persistent error is a BCC-absent slide of a mixed-label patient. It was called positive by 11 of 12 grid runs, and all three candidate-combination runs scored it at ≥ 0.9996 [3.27].
- The other mixed-label patient, whose two slides share one specimen and block, was misclassified on both slides in opposite directions [3.27].
- These errors sit exactly where the imported reference is weakest: report-level diagnoses mapped to slides. COBRA's non-BCC group also includes dysplasia (actinic keratosis, Bowen's disease) as well as benign conditions (`docs/public-datasets.md`). The workbench cannot separate model error from reference error here without an expert read: `possible_label_error` needs a reader disagreement on record, and `mimic_category` is not assessable [3.26].

**Largest resource bottleneck: the Midnight-12k forward pass, and loading the encoder on cached inference.**
- **Extraction.** Embedding runs at 4.66 patches/s, against 158.7 patches/s for reading, on MPS fp32 [3.21]. For the largest development slide, embedding took 52.958 s of the 54.960 s cold extraction (0.964 *(derived)*) [3.24]. Mean cold extraction is 56.66 s per slide at 256 patches and 98.72 s per slide at 512 [3.21]. The 256-patch figures come from pre-fix extractions reused after identity checks; the 512-patch figure from the post-fix run (§1.3).
  - fp16 passed its acceptance rule at 1.197× embedding throughput, but it moved the tuned operating point [3.18], [3.19].
- **Inference.** On a slide whose features are cached, the job still spent 9.296 s of 9.573 s loading the encoder, and peak RSS rose by 5,956,632,576 bytes. The cache lookup itself took 0.261 s. The cause is `extract_slide` loading the encoder before the cache lookup. It is an unfixed tooling defect (§2.3) [3.24].
- Training is not a bottleneck: 91.04 s for all 24 runs [3.23].

---

## 6. Recommended next experiment

**One experiment: expand the development cohort with the same deterministic selection rule, and repeat the pre-declared four-way comparison with learning curves for both heads. An evaluation cohort is reserved from the new patients before any training, and the current test split stays sealed.**

### Why this one

1. **The intervals are too wide to separate the factors.** On 35 development patients, every encoder-effect and head-effect AUROC CI includes 0, and the candidate's AUROC CI is [0.863, 0.998] [3.5], [3.8]. More patients are the direct way to narrow them.
2. **The learning curve is only weakly informative, so it needs more points.** It has 3 points, covers the mean-pool head only, and has no intervals. Midnight-12k + mean-pool OOF AUROC went 0.690 → 0.777 → 0.844 as the fit patients per fold went from 8 to 14 to 28. The handcrafted baseline went 0.641 → 0.786 → 0.769, but its 1.0 point (0.769) lies inside the 0.5 point's repeat range (0.733–0.822). So neither "Midnight-12k still improving" nor "the baseline has plateaued" is established [3.12], [3.13]. The expanded pool adds two points and an ABMIL curve.
3. **Sampling and precision are not the bottleneck.** Doubling the budget to 512 nearly doubled the cost (Midnight 55.72 → 98.83 s/slide) and did not raise AUROC (256 − 512: +0.028 [−0.007, 0.070]) [3.20]. No difference was detected between uniform and spatial sampling [3.15]. fp16 is accepted, with an AUROC delta of −0.004 [3.18], [3.19].
4. **No temporal or site split is possible within the current subset.** All 60 slides lack a collection date (`collected_on` missing for 60/60), and there is one site [3.28]. Within COBRA, the only evaluation cohort that can be kept out of all modelling is one reserved at random from new patients, frozen before any modelling.

### Design (bounded; to be pre-declared in writing before any data is touched)

1. **Data.** With the owner's approval to download (CC BY-NC-SA 4.0), add COBRA `bcc` biopsy patients by the **same deterministic selection rule**. Continue the existing `sha256("cobra-subset-v1|" + patient_id)` order with the same eligibility, so there is no cherry-picking. The package lists 4,066 patients (`docs/public-datasets.md` §2); the number eligible under the rule has not been computed. Target: two further doublings of the development pool (about 35 → 140 patients), so that the learning-curve question has two new points.
2. **Evaluation cohort.** In the new dataset version, before any training, randomly reserve a new evaluation cohort from the **new** patients only. It is excluded from all model selection, active learning and thresholds. The current 15 test patients stay sealed and unreleased; releasing them is a separate decision for the owner.
3. **Models.** Keep handcrafted + mean-pool as the baseline, plus Midnight-12k + mean-pool and Midnight-12k + ABMIL. Use 3 pre-declared seeds, 256 patches, spatial sampling and stain `none`. fp16 may be used as a separate feature set with its own threshold. Run learning curves at 25 / 50 / 100 % of the expanded pool **for both heads**. Today no ABMIL learning curve exists.
4. **Prerequisites.**
   - Record a human decision on the 2 near-duplicate pairs [3.14].
   - Fix the encoder-before-cache-lookup defect with a test (§2.3).
5. **Cost (projection *(derived)* from `R/s5.json`).** Midnight-12k extraction on this Mac costs about 56.7 s per slide at fp32, or about 41.9 s at fp16. That is roughly 1.6 h or 1.2 h per 100 new slides (100 × 56.66 s = 5,666 s; 100 × 41.88 s = 4,188 s). The fp32 figure comes from the reused pre-fix extractions and the fp16 one from the post-fix run (§1.3). Training cost is negligible [3.21], [3.23].

### Follow-ons (not part of this experiment)

1. **An independent expert reference.** The dominant errors are confident false positives [3.26]. The most persistent of them sit on slides of the mixed-label patients, where report-derived labels are least reliable: those two patients account for 3 of the 26 bags with any grid-run error, including the one bag that 11 of 12 runs got wrong *(derived)* [3.27]. Only an independent expert read can tell model errors from reference errors. One dermatopathologist, preferably two with adjudication, would read blinded to model scores and to the imported label:
   - every slide of the reserved evaluation cohort;
   - every slide of the mixed-label patients;
   - the 8 development bags that erred in at least 6 of 12 grid runs [3.27];
   - a random sample of agreeing slides as a control.

   These would be recorded as expert labels; report the imported-vs-expert agreement and evaluate each model against both references. It needs a reader, so it is planned separately, and it can use the expanded cohort.
2. **External-site evaluation** (for example AIDA BCCC biopsies: another country, site and scanner, with dual dermatopathologist labels) remains a later milestone. It needs controlled access (`docs/public-datasets.md` §2).

**Sources §6.** [3.28] `R/s1.json` → `audit_now.missing_metadata.collected_on` (count 60, fraction 1.0); `R/s1.json` → `public_dataset.limitations[1]`. Other tags as in §3.

---

## 7. Limitations and caveats

- **Imported, report-derived labels.** COBRA's labels come from rule-based extraction from free-text pathology reports, not from expert reads in this workbench. A report-level diagnosis may sit on a slide that does not show the lesion. Every metric measures agreement with this reference. "BCC absent" is not "benign": COBRA's non-BCC group includes epidermal dysplasia.
- **Single site and single scanner model** (Radboudumc; 3DHistech Pannoramic 1000). No site or scanner shift can be measured. There are no collection dates, so a temporal split is impossible.
- **Enriched prevalence.** The subset is about 50 % BCC by construction; the evaluation prevalence was 22/45. PPV and NPV do not transfer to a clinical population.
- **Small cohort.** 35 development patients. Intervals are wide, and seed repeats do not add patients.
- **Tuning estimates.** Every threshold-dependent development metric (sensitivity, specificity, PPV, NPV, confusion counts, McNemar, decision flips) uses a Youden threshold chosen on the same OOF scores, so it is optimistic.
- **In-sample calibration.** The Platt map was fitted on the pooled OOF scores and is applied to the refitted final model, which is an approximation. Calibrated Brier and ECE on those scores are in-sample. A fitted calibration map is not a validated clinical probability.
- **Non-commercial licence.** COBRA is CC BY-NC-SA 4.0. Whether weights trained on it are ShareAlike adaptations is unsettled; legal review is needed before any commercial use. Midnight-12k is MIT; its training data's own terms are a question for counsel (`docs/license-ledger.md`).
- **Dry-run overlap disclosure.** Before the real split was frozen, throwaway dry runs processed 6 COBRA slides from 6 patients.
  - 4 of those patients are among the 15 real test patients.
  - For 2 of them, dry-run test predictions were looked at (dry-run models trained on about 4 slides).
  - For the other 2, which were dry-run training patients, labels were read and slides were used for dry-run Macenko references.
  - None of this informed any real-cohort run, threshold or candidate.
  - These 4 patients are therefore **unreleased in the real study and not used for model selection**. They are not "untouched" [1.8].
  - Separately, all 15 test slides were feature-extracted label-free by the fixed encoders (allowed; no labels read) [1.17].
- **Undecided near-duplicates.** 2 candidate pairs in the development pool, split across CV folds, have no human decision. The sensitivity analysis (§3.8) removed only 4 patients and compares unpaired replicate streams, so it neither shows nor rules out inflation; no AUROC effect changed direction, and one AUPRC head effect changed sign. A decision is still required before any final benchmark.
- **Test cohort unreleased.** The 15-patient test split has never been released in the real study. s6 was deliberately not run; releasing it is the owner's decision. No result here is a test result.
- **Pre-fix extractions reused.** Five feature sets, and 30 of the 60 artifacts of a sixth, were extracted by the stale pre-fix run and reused after identity checks. Their cold-extraction timings are pre-fix figures; the post-fix determinism check on 2 slides per encoder matched exactly (§1.3) [1.20].
- **Stale database records.** The pre-fix comparison families `8e64b136` and `5c326ae6` are still `open` in the database (not marked superseded). They are documented as stale and are never cited [1.6].
- **Midnight-12k adapter parity.**
  - The 2026-10-26 parity record compared the workbench adapter with transformers `from_pretrained` on the same local weights. It used 8 CC0 tissue patches on CPU fp32 and found a max abs diff of 2.03e-6 and cos_min 0.99999994.
  - The adapter declares the model card's transform (`Resize(224) + CenterCrop(224) + Normalize(0.5, 0.5)`, the identity resize on 224 px input) and CLS + mean-patch-token pooling.
  - kaiko's own pipeline was not run. The record predates the fix rounds and does not pin the adapter's code hash.

  [3.29]
- **Coverage is tissue coverage, not lesion coverage.** There are no lesion annotations, and attention maps are not lesion localisation.

**Sources §7.** [3.29] `E/attachments/midnight_parity.json` → `banner`, `record.parity_vs_transformers_from_pretrained`, `record.patches`; `R/s0.json` → `encoders.describe_encoders[id=midnight-12k].{pooling,resize_policy}`. Other caveats: `R/summary.json` → `caveats`; `E/test_releases.json` → `disclosures`; `E/exclusions.json` → `supplement`.

---

## 8. How to reproduce

All commands run from `workbench/api` with the project venv. The run used the shared local database. `var/` is gitignored and holds the COBRA slides, the Midnight-12k weights and the database. Nothing is downloaded: COBRA must already be imported (`docs/public-datasets.md`, "Importing"), and the weights must already be local.

```bash
cd workbench/api
export WB_VAR_DIR=../var WB_MIDNIGHT_WEIGHTS=../var/models/midnight-12k HF_HUB_OFFLINE=1

# 1. Stage status for this command line (valid / missing / failed / stale; nothing runs)
.venv/bin/python ../scripts/run_cobra_experiments.py --status --device mps --seeds 0,1,2 --sampling-budget 512

# 2. The real run (s0-s5, s7, s8). Valid stages are reused after fingerprint and artifact checks;
#    --force s3 (for example) re-runs a stage and marks its dependents stale. s6 never runs here.
.venv/bin/python ../scripts/run_cobra_experiments.py --device mps --seeds 0,1,2 --sampling-budget 512

# 3. Near-duplicate sensitivity, on a BYTE COPY of the database (with its -wal/-shm), opened read-only;
#    copy while no worker or API is writing to the shared database
mkdir -p /tmp/wb-dbcopy && cp ../var/workbench.db* /tmp/wb-dbcopy/
.venv/bin/python ../scripts/sensitivity_near_duplicates.py --db /tmp/wb-dbcopy/workbench.db \
    --out ../experiments/reports/sensitivity_near_duplicates.json

# 4. Real-WSI inference measurement (registers the candidate bundle through public services; not a test release).
#    A second run stops by design, because the job and its prediction already exist.
.venv/bin/python ../scripts/measure_bundle_inference.py --out ../experiments/reports/inference_measurement.json

# 5. Evidence package (sanitized; salt stays in experiments/reports/_state/evidence_salt).
#    Re-export with --force after committing, to record a clean code SHA. This is the 2026-11-09 command
#    (E/provenance.json -> commands.export). The original supplementary inputs were cleared with the session
#    scratchpad, so $IN holds copies taken from E/ itself, outside E/ (which --force replaces):
#    attachments/pre_fix_inventory.{json,md}, midnight_parity.json and bulky_artifacts_index.json as they are;
#    the disclosure, supplement and note rebuilt from test_releases.json -> disclosures, exclusions.json ->
#    supplement and README.md "## Notes". Re-exporting a sanitized copy leaves its tokens unchanged.
.venv/bin/python ../scripts/export_evidence.py --experiment-id cobra-bcc-subset-2026-10-28 --force \
    --attach sensitivity_near_duplicates.json=../experiments/reports/sensitivity_near_duplicates.json \
    --attach inference_measurement.json=../experiments/reports/inference_measurement.json \
    --attach pre_fix_inventory.json=$IN/pre_fix_inventory.json --attach pre_fix_inventory.md=$IN/pre_fix_inventory.md \
    --attach midnight_parity.json=$IN/midnight_parity.json \
    --attach bulky_artifacts_index.json=$IN/bulky_artifacts_index.json \
    --test-release-disclosure $IN/test_release_disclosure.json \
    --exclusions-supplement $IN/exclusions_supplement.json --readme-note $IN/readme_note.md

# 6. Tests (no clinical meaning)
.venv/bin/python -m pytest -q                 # 1081 passed, 1 deselected at 8a1a59e
.venv/bin/python -m pytest -q -m slow -s      # the synthetic 100,000 x 1,536 memory fixture
cd ../web && npx tsc --noEmit && npx vitest run && npx playwright test
```

**Checks after a rerun.**
- Compare `R/s1.json` → `dataset.manifest_sha256` (`a73bfa56…`) and `split_fingerprint` (`19676e29…`).
- Compare `R/s3.json` → `protocol.fold_consistency.fold_assignment_sha256` (`579ae8c6…`).
- Compare the per-run `identity_sha256` and checkpoint sha256 in `E/identities.json`.
- A fresh database should reproduce the same split, because the split-family salt is derived from the project id (`dermpath/datasets.py` `project_salt`). This was not tested on a fresh import in this round.
- MPS floating-point results may differ slightly across torch versions. The s2 determinism check covers this machine only.
- **Test release (documentation of the explicit procedure, not a recommendation).** The procedure stays as it was. It is the owner's decision and is never part of a default run. If the owner decides on one, it is requested explicitly with the same command-line options, so that s3 stays valid:

```bash
.venv/bin/python ../scripts/run_cobra_experiments.py --device mps --seeds 0,1,2 --sampling-budget 512 \
    --only s6 --release-test ba364f52b97843c18315d8bacbaf9180 --release-reason "<the owner's written reason>"
```

**Sources §8.** `R/summary.json` → `argv`; `R/s0.json` → `environment`; `E/provenance.json` → `commands`; usage docstrings of `scripts/run_cobra_experiments.py`, `scripts/sensitivity_near_duplicates.py`, `scripts/measure_bundle_inference.py` and `scripts/export_evidence.py`; `api/pytest.ini` (`-m "not slow"` default).
