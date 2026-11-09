> **HISTORICAL, PRE-FIX INVENTORY. Prepared 2026-10-28 (about 04:50 UTC) by the read-only inventory agent at HEAD 23a68f6, BEFORE the fix rounds (commits 7ba0435 and 8a1a59e) and before the post-fix real run. Its run-level figures describe stale pre-fix runs (code 782668c, tree 810e3288) and are NOT results; they are superseded by the post-fix run of 2026-10-28 (code 8a1a59e) reported in results.json. Kept for the record: cohort identities, dry-run overlap (section 7), anomalies and decisions taken.**

# DermPath ML engine: evidence and experiment inventory (brief item 1)

*Research use only. COBRA labels are report-derived imported reference labels, not expert reads in this workbench; "BCC absent" is not "benign". Nothing below is a clinical performance claim.*

Prepared 2026-10-28 (04:50 UTC) by the read-only inventory agent. Sanitized: no patient codes and no slide file names; DB row ids only. Machine-readable version: `inventory.json` next to this file.

**Method.**
- **Database.** I took a byte copy of `workbench/var/workbench.db` together with its `-wal` and `-shm` files at 04:42 UTC. The copy had `workbench.db` sha256 `64cc7ee3…` and `-wal` sha256 `2f0e1dce…`. I opened only the copy, with `mode=ro`; the shared database itself was never opened.
- **Files re-hashed (read only).** Every COBRA feature artifact, every checkpoint, the manifest object and the local Midnight weights.

## 1. Bottom line

- **Test cohort.** The real-cohort test cohort has had no test release:
  - 0 test releases and 0 sealed patients;
  - 0 predictions on test patients;
  - 0 inference bundles.
- **Exception: earlier dry runs.** Four test patients were processed in the 6-slide dry runs that took place before the real split was frozen (§7). This needs a disclosure decision.
- **Reusable after the fixes.** These items are reusable if their identity checks still match after the fixes:
  - the frozen dataset version `1868803e`;
  - the two S2 `stain=none` feature sets: handcrafted `527f9080` and Midnight `b3b75db2`, about 62 min of extraction;
  - their S3 views (`c2aa86f4`, `c74591ee`);
  - the uniform-sampling handcrafted set `2f1f57b2`.

  All 210 artifacts and 17 checkpoints match their recorded sha256. The local Midnight weights equal the pin.
- **Stale.** All 17 real-cohort training runs are stale. They are the 16 S3 runs in family `8e64b136` and 1 S4 run in family `5c326ae6`.
  - They were produced by the HEAD ML code (tree `810e3288`), which has the confirmed defects:
    - the ABMIL "refit" in fact fits 34 of 45 bags;
    - the calibration gate counts bags, not patients;
    - there is a single seed.
  - Retraining costs seconds: the 16 runs took 37.6 s.
- **Invalid.** No real-cohort results are invalid. The Macenko arm never started on the shared DB. Every Macenko `dev_cv` arm in the dry runs is invalid for CV comparison.
- **Incomplete.** The S4 uniform-sampling Midnight feature set `0ad3a2dd` is at 30/60. Its job `6481f266` is still marked `running`, but its lease expired and the process that owned it is gone. Finishing it costs about 26 min on MPS.

## 2. Code and environment identity

| | |
|---|---|
| HEAD | `23a68f6` on `dermpath-ml-engine`; the working tree was clean at inventory time |
| Code that produced every real record | `782668c` (HEAD~1). HEAD differs from it only in `.claude/launch.json` |
| `code_tree_sha256` (88 files) | `810e3288…197e1c`, recorded in every report and run attempt, and equal to HEAD's tree at inventory time |
| Driver sha256 | `2e15ff00…4bbb`, the same in the reports and at HEAD |
| Machine | macOS 14.5 arm64, 11 CPUs, 18 GB, MPS (no CUDA); Python 3.14.5, torch 2.14.1, numpy 2.4.2, scikit-learn 1.9.0, transformers 5.19.0, OpenSlide 4.0.1 |
| Midnight-12k | Spec `36d2e01f…`. Local `model.safetensors` sha256 `52c14f20…0c72ca1` equals the pin; `config.json` sha256 `0362e014…`. Mean/std 0.5; pooling is CLS concatenated with the mean patch token (dim 3072). A 2026-10-26 parity record compared the adapter with transformers `from_pretrained` (max abs diff 2e-6, cos_min 0.99999994); kaiko's own pipeline was not run |
| Handcrafted | `handcrafted-stain-texture-v1`, spec `8e4d14d0…`, weights id `handcrafted:1:234035d1…`, dim 64 |

## 3. Cohort: documented versus actual

The documented counts (`docs/public-datasets.md`) and the actual frozen dataset version match on every structural fact:
- 60 slides from 50 patients;
- 56 cases and 56 blocks;
- slide labels 30 `bcc_present` and 30 `bcc_absent_not_benign`;
- 26 positive and 24 negative patients under `any_positive`;
- 2 mixed-label patients;
- one site and one scanner model, at 0.4851 µm/px;
- 60 `imported_reference` labels, with review state `imported`.

The split differs from the doc's illustrative one, which used seed 0 and ratios 60/20/20 and gave a test split of 10 patients.

| Frozen dataset version `1868803e54c045eba4df9c7a9fd53a7b` (v1, frozen 03:05 UTC) | Patients (+/−) | Slides (BCC / absent) | Cases |
|---|---|---|---|
| Development pool (train; val ratio 0) | 35 (18 / 17) | 45 (22 / 23) | 41 |
| Test | 15 (8 / 7) | 15 (8 / 7) | 15 |

**Identities.** Each value below was recomputed from the data and matches the stored one.

| Identity | Value |
|---|---|
| `manifest_sha256` | `a73bfa56a3532e36d48111d7e0da0de832dce57ff48432662ee5e713f74ca902`, recomputed from the DB JSON and from the object-store file |
| `split_fingerprint` | `19676e29764f1c18610553c58ba449648db47d394adc0ba68c53f8a690247df2` |
| Split family | `bc569b29…` |
| Split algorithm | `dermpath.splits/3`, seed 20261027, ratios 0.7 / 0 / 0.3, patient-grouped and stratified on `any_positive` |

**Notes for reporting.**
- Both mixed-label patients are in the development pool.
- Counted by patient label rather than slide label, 32 slides come from positive patients and 28 from negative patients. State which basis each table uses.
- The independent units are 35 development patients and 15 test patients.
- **Near-duplicate candidates.** The thumbnail dHash screen (distance ≤ 6) found 2 candidate pairs:
  - each pair links two different patients with the same label;
  - both pairs are inside the development pool;
  - each pair fell into different S3 CV folds (folds 0 and 4; folds 3 and 0);
  - no human decision has been recorded.

## 4. Feature sets (project `proj-cobra-bcc-subset`)

All feature sets below use target 0.5 µm/px, 224 px patches, at most 256 patches per slide and sampling seed 0. Stain normalisation is `none` (stain-policy sha `5975f29b…`) and the extractor is `dermpath.feature_sets/2`.

| Id | Name | Encoder / device | Sampling (policy sha) | Spec sha | Status | Items | Class |
|---|---|---|---|---|---|---|---|
| `527f9080` | S2 technical | handcrafted / cpu fp32 | spatial (`cefdf165`) | `1e5969df` | ready | 60/60 | valid, reusable |
| `b3b75db2` | S2 technical | midnight-12k / mps fp32 | spatial (`cefdf165`) | `6162aaf4` | ready | 60/60 | valid, reusable |
| `c2aa86f4` | S3 supervised | handcrafted | spatial | `7a6177a7` | ready | 60/60 (same artifacts as `527f9080`) | valid, reusable |
| `c74591ee` | S3 supervised | midnight-12k | spatial | `3928575d` | ready | 60/60 (same artifacts as `b3b75db2`) | valid, reusable |
| `2f1f57b2` | S4 a_sampling_uniform | handcrafted | uniform (`7c2475a9`) | `a3a5b981` | ready | 60/60 | valid, reusable |
| `0ad3a2dd` | S4 a_sampling_uniform | midnight-12k | uniform (`7c2475a9`) | `3c6a6f6e` | **building** | 30 done, 30 pending | incomplete |

**Validation and integrity.**
- Determinism validation passed for both S2 sets, on 2 seeded slides each: max abs diff 0, coordinates identical.
- Integrity: 210 artifacts, all present and sha256-equal.

**Coverage at 256 patches, spatial sampling.**
- Candidates per slide: min 402, median 1,675, max 8,488.
- Sampled fraction of candidates: median 0.153, min 0.030.
- Sampled tissue fraction: median 0.15, min 0.027.
- Tissue within the sampling radius: median 0.80, min 0.19.
- 56 of 60 slides have fragments with no sampled patch (mean 19, max 90).
- 17 slides have ≤ 1,024 candidates.

## 5. Training runs, bundles, releases, jobs

**Real-cohort runs.** All 17 runs share these settings:
- protocol `dev_cv`, 5 folds;
- training seed 0;
- code `782668c` (tree `810e3288`);
- dataset manifest `a73bfa56…`;
- one attempt each, succeeded, with `identity_matches=1` and `code_dirty=0`.

| Group | Run ids | Notes |
|---|---|---|
| S3 grid, family `8e64b136` (open) | handcrafted+meanpool `87a5f075`, handcrafted+abmil `ce186228`, midnight+meanpool `1d9535e7`, midnight+abmil `79aa243e` | 45 bags / 35 patients scored OOF, 0 unscorable |
| S3 learning curve, meanpool only (same family) | handcrafted: `ad6a67b3` `00719018` `19319ee9` (0.25), `dfc27b4a` `7ae6ee9d` `11b1fffb` (0.5); midnight: `31ebcc9e` `f9fb8cdf` `486ca433` (0.25), `31ab2d97` `bf3ea93f` `a013330c` (0.5) | Repeats vary the patient subset only; fit parts of only 6–8 patients per fold at 0.25 |
| S4, family `5c326ae6` (open) | handcrafted+meanpool on uniform sampling: `6c922244` | Stage interrupted |

**Stale S3 grid figures (do not cite).** These are tuning-set OOF estimates from pre-fix code: the threshold and calibration were chosen on the same scores. They are listed only so their existence is recorded.

| Encoder + head | AUROC | 95% patient-cluster CI |
|---|---|---|
| handcrafted + meanpool | 0.769 | 0.60–0.90 |
| handcrafted + abmil | 0.844 | 0.70–0.96 |
| midnight + meanpool | 0.844 | 0.73–0.94 |
| midnight + abmil | 0.972 | 0.92–1.00 |

The s3 pre-declared test candidate was `79aa243e` (midnight + abmil). No bundle was registered, it was never released, and it is superseded.

**ABMIL fitting as executed.** Both ABMIL runs fit their final model on 34 of 45 bags (28 of 35 patients). An inner hold-out of 11 bags (7 patients) was used only for early stopping: best epoch 4 of 14 for handcrafted and 7 of 17 for Midnight. There was no refit on all development bags.

**Calibration as executed.** Platt calibration was fitted on 45 OOF bags (22/23). The gate counted bags, not the 35 patients.

**Other records.**
- 0 inference bundles, 0 test releases, 0 inference predictions, 0 AL proposals, 0 model versions.
- Predictions: 765 OOF and 421 train rows; none on test patients.

**Jobs.**
- `6481f266` (`build_feature_set` for `0ad3a2dd`) is stranded:
  - status `running`, attempts 1/3, progress 0.50;
  - lease owner `cobra-driver-84781` (process gone), lease expired at 04:40:56 UTC.
- An orphan temp file remains at `var/cache/feature-tmp/extract-_htb9pse/embeddings.capacity.npy` (3.1 MB).
- There are no other open or failed COBRA jobs. The only failed job is in the demo project: 1 ingest of an unsupported format, which is expected.

## 6. Classification

| Class | Items | Identity |
|---|---|---|
| **Valid, reusable** | Dataset version `1868803e`; feature sets `527f9080`, `b3b75db2`, `c2aa86f4`, `c74591ee`, `2f1f57b2`; `s2.json`; Midnight weights | See §2–§4. Reuse depends on the artifact cache-key inputs staying unchanged after the fixes |
| **Stale or superseded** | 16 S3 runs (family `8e64b136`), the S4 run `6c922244`, the s3 test candidate, and `s0.json`, `s1.json`, `s3.json` as reports | Code `782668c`, tree `810e3288`, driver `2e15ff00`. The s1 dataset itself stays the cohort of record |
| **Invalid** | Real cohort: none. Dry runs: every `b_stain_macenko` dev_cv arm, where one reference was fitted on the development slides and reused across folds | §7 |
| **Incomplete** | Feature set `0ad3a2dd` (30/60) and job `6481f266`; stage s4 (`_state/s4.json` only; `s4.json` never written) | §4–§5 |
| **Not run** | s5, s6 (real cohort), s7, s8; s4 Macenko arm; s4 fp16 precision study | — |
| **Dry run** | `scratchpad/dryrun/reports{,-attempt1,-attempt2,-extra,-prefix,-reimport}` and `scratchpad/dryrun-ack/reports` (6-slide subset, throwaway DBs) | §7 |

## 7. Dry runs

All dry runs used the same 6 COBRA slides from 6 patients, imported into throwaway DBs, with the dry-run budgets.

**Code identity.** Two code trees were used:
- `dryrun/reports` and `-reimport` used tree `810e3288`, the same tree as the real run, recorded dirty at `f4e62d3` before commit `782668c`;
- `-attempt1`, `-attempt2`, `-extra` and `-prefix`, and `dryrun-ack`, used the older tree `3df9025b`.

**Dry-run test releases.** Four were recorded in throwaway DBs, and each scored 2 patients:
- `ebaba044` (attempt1; that DB was later reset);
- `bcff4b46` (attempt2 and extra; DB `dryrun-ack/var`);
- `d3815c19` (prefix; that DB was later reset);
- `893ebc8f` (final; DB `dryrun/var-proof-run`).

**Overlap with the real split.**
- Of the 6 dry-run patients, 4 are in the real test split. That is 4 of 15 test patients, and 4 slides.
- Two of them were the dry-run test patients scored by those releases. The models were trained on about 4 slides.
- The other two were dry-run training patients: their labels were read, and their slides were used for the dry-run Macenko references.
- Every dry run finished before the real split was frozen.
- No real-cohort run, threshold or candidate used these patients.

`scratchpad/demo-dryrun` is a UI walkthrough and contains no ML results.

## 8. Anomalies and open issues

1. **Stranded build.** Job `6481f266` and the `building` feature set `0ad3a2dd` are still open. Any worker started on the shared DB will reclaim the job and resume it with whatever code is checked out at that moment.
2. **Live API on the shared DB.** A preview API (uvicorn pid 99436, config `dermpath-api-shared`, started 23:58 local) holds the shared DB open for writing and runs pre-fix code. No job handler was found in `dermpath/main.py`, so jobs it enqueues would stay queued.
3. **Dry-run overlap with the real test split.** See §7.
4. **Near-duplicate candidates split across CV folds.** The 2 undecided pairs inside the development pool were split across CV folds (§3). If either pair is a true duplicate, the OOF estimates leak across folds.
5. **ABMIL documentation mismatch.** The config comment and the main text of design §6 say "refit on the development pool". The code fits 34 of 45 bags; the design's "Implemented differently" note in §6 says there is no refit.
6. **Calibration gate.** The calibration evidence gate counts bags (45), not patients (35) or duplicate groups.
7. **s0/s1 skipped by file existence.** s0 and s1 came from a separate `--only s0,s1` invocation 15 s earlier. The full run then skipped them because the files existed (the defect in brief item 4). Here the code tree and the driver were identical, so the skip happened to be harmless, but the driver did not check this.
8. **Outdated docs.** `docs/readiness.md` is dated 2026-10-26 and reports 173 tests and no real-cohort measurements. `docs/ml-engine-report.md` does not exist, although `ml-engine-design.md` line 7 cites it.
9. **Single seed.** Every real run used training seed 0.
10. **Audit events (cause not verified).** The project has 19 `comparison_family_member` rows but only 2 `comparison_family.member_added` audit events.

## 9. Resource facts measured on the real slides

These are technical measurements, not diagnostic quality.

| Feature set | Wall time | Per slide | Other |
|---|---|---|---|
| Handcrafted, spatial, 256 | 265.9 s for 60 slides | 4.4 s | Validation job 9.2 s |
| Midnight, spatial, 256 (MPS fp32) | 3,412.5 s | Median 56.5 s, about 5 patches/s | Peak RSS 5.48 GiB; validation job 111 s |
| Handcrafted, uniform, 256 | 280 s | — | Its recorded RSS is process-wide, because Midnight was loaded in the same process |
| Midnight, uniform, 256 (partial) | 1,526 s for 30 slides | — | Stopped at 30/60 |

**Training.** The 16 S3 train jobs took 37.6 s in total; the Midnight ABMIL job took about 26 s.

**Estimate, not measured.** A 1,024-patch budget would need about 2.5–3 h of Midnight extraction for the 45 development slides.

## 10. Report hash index

| File (`workbench/experiments/reports/`) | sha256 |
|---|---|
| `s0.json` | `13c80299d2127abb5c5f4c1cfc88e58cc16369601cfe41d16c556dd2478ee0d6` |
| `s1.json` | `9d49d3a7b028dda47175e1c3701e419d93ff7e2cffd828b5fb8c27289ac6219f` |
| `s2.json` | `e7aa82d723cad82db96a53712b7036a3257d254585762fa9a96656ed9d369804` |
| `s3.json` | `4329d989f1fd138d1f430f5f59efb9d0ff97fd8ff397efa2dcf60cd82cc8665d` |
| `_state/s3.json` | `5d7cc381f5a7fd6f6200bff7f76274978dd1835c13d4b98df7d96640f0e274df` |
| `_state/s4.json` | `49676ded6bda6dde3c5c6e1d3b840cc451747873c6c50c3341e5127adb601cdc` |
| `_full_run.log` | `4892404436653b2bb2f8beee9ad1a90c245a0ea8db486af4dd0b272b12d94087` |

## 11. Decisions for the lead

1. **Stranded build.** Do not start a worker on the shared DB until the fixes land. Then choose one of two options:
   - resume `0ad3a2dd` through the fixed driver: about 26 min, and the 30 intact artifacts are reused;
   - cancel job `6481f266` and record why.

   The driver fix must handle a `building` set whose job lease has expired.
2. **Preview API.** Stop the preview API (pid 99436) during the rerun, or accept that it serves pre-fix code on the real DB.
3. **Artifact cache keys.**
   - The owners of `feature_sets.py` and `inference.py` should keep the `stain=none` cache-key inputs unchanged, or declare a bump explicitly. These inputs are:
     - the extractor version `dermpath.feature_sets/2`;
     - the preprocessing-version strings;
     - the policy, stain and environment sha;
     - the mask and exclusion sha.
   - Otherwise about 62 + 26 min of extraction must be redone.
   - Before training, verify with the s3 reuse probe: expect 60 cache hits and 0 fresh extractions.
4. **Reruns after the fixes.**
   - Rerun s0, s3 and s4 on `1868803e`. With 3 seeds × 4 combinations, training takes minutes.
   - Mark families `8e64b136` and `5c326ae6` superseded; do not delete them.
   - Re-declare the test candidate from post-fix runs before any s6.
5. **Macenko arm.** Keep the Macenko `dev_cv` arm blocked on the real cohort. None exists yet.
6. **Near-duplicates.** Get a human decision on the 2 near-duplicate candidate pairs before the final benchmark. Regroup any confirmed pair, which requires a new dataset version.
7. **Dry-run overlap disclosure.** Decide how to disclose the overlap in §7. Suggested wording: "not used for real-cohort model selection", rather than "untouched".
8. **Sampling budget.** Decide whether a 1,024-patch development-only arm (an estimated 2.5–3 h of Midnight extraction) is affordable before predeclaring it.
