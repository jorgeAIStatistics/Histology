# Evidence package `cobra-bcc-subset-2026-10-28`

Research use only. Not a medical device; nothing here is a diagnosis or a clinical performance claim.
Labels are imported reference labels (report-derived); metrics measure agreement with that reference.
BCC absent is not benign.

* Stages contributing numbers (valid offline): s0, s1, s2, s3, s4, s4b, s5, s7, s8
* Stages excluded or not present: s6 (missing)
* Test releases recorded: 0
* Test-release disclosures: see `test_releases.json` -> `disclosures`
* Exclusions not described by the driver's reports: see `exclusions.json` -> `supplement`
* Attachments (supplementary records, sanitized; numbers computed by the named scripts, not by this exporter): `attachments/bulky_artifacts_index.json`, `attachments/inference_measurement.json`, `attachments/midnight_parity.json`, `attachments/pre_fix_inventory.json`, `attachments/pre_fix_inventory.md`, `attachments/sensitivity_near_duplicates.json`

Files: `index.json` (hashes of every file), `provenance.json`, `dataset.json`, `identities.json`,
`results.json`, `artifacts_index.json`, `exclusions.json`, `test_releases.json`, `blockers.json`.

Identifiers are salted HMAC tokens (`pt:`, `file:`, `id:`, `path:`); the salt is not in the package.
No database, slide, weight, embedding, patient code or slide file name is included.

## Notes

Research use only; COBRA report-derived imported reference labels; 'BCC absent' is not 'benign'. Development out-of-fold (OOF) numbers are development estimates; threshold-dependent OOF metrics are tuning estimates; calibration measured on the same OOF scores is in-sample. No clinical-readiness or commercial claim is made.

**Test split.** The 15-patient test split has never been released in the real study (0 test releases; s6 not run by the owner's decision). Four of the 15 test patients were processed by throwaway dry runs before the split was frozen (two had dry-run test predictions looked at): they are unreleased in the real study and were not used for model selection. Separately, the real run's feature-set builds extracted all 15 test slides label-free (fixed encoders, no labels read); no real-run model scored them. See `test_releases.json` -> `disclosures`.

**Near-duplicate sensitivity** (`attachments/sensitivity_near_duplicates.json`). The audit screen found 2 candidate pairs (2 without a human decision), each linking two different patients with the same label, members in different CV folds. Excluding their 4 patients (4 slides) from every s3 grid run's OOF evaluation (nothing retrained):

| Encoder + head | seed | OOF AUROC, all 35 patients | OOF AUROC, 31 patients |
|---|---|---|---|
| handcrafted-stain-texture-v1 + meanpool_logreg | 0 | 0.769 [0.604, 0.897] | 0.771 [0.613, 0.904] |
| handcrafted-stain-texture-v1 + abmil | 0 | 0.834 [0.692, 0.946] | 0.860 [0.730, 0.964] |
| midnight-12k + meanpool_logreg | 0 | 0.844 [0.733, 0.941] | 0.826 [0.708, 0.931] |
| midnight-12k + abmil | 0 | 0.947 [0.863, 0.998] | 0.969 [0.904, 1.000] |
| handcrafted-stain-texture-v1 + meanpool_logreg | 1 | 0.769 [0.611, 0.898] | 0.771 [0.606, 0.903] |
| handcrafted-stain-texture-v1 + abmil | 1 | 0.791 [0.609, 0.935] | 0.774 [0.580, 0.931] |
| midnight-12k + meanpool_logreg | 1 | 0.844 [0.734, 0.936] | 0.826 [0.709, 0.928] |
| midnight-12k + abmil | 1 | 0.927 [0.831, 1.000] | 0.921 [0.815, 1.000] |
| handcrafted-stain-texture-v1 + meanpool_logreg | 2 | 0.769 [0.610, 0.891] | 0.771 [0.599, 0.904] |
| handcrafted-stain-texture-v1 + abmil | 2 | 0.830 [0.680, 0.939] | 0.831 [0.680, 0.947] |
| midnight-12k + meanpool_logreg | 2 | 0.844 [0.735, 0.940] | 0.826 [0.698, 0.931] |
| midnight-12k + abmil | 2 | 0.945 [0.855, 0.998] | 0.955 [0.854, 1.000] |

Paired AUROC deltas (a - b), mean over the 3 training seeds (seed repeats are not independent patients; per-seed CIs in the attachment):

* encoder_effects {"head": "abmil"}: handcrafted-stain-texture-v1 - midnight-12k: all -0.121, excluding -0.127; seeds whose CI excludes 0: 0 of 3 (all) and 1 of 3 (excluding)
* encoder_effects {"head": "meanpool_logreg"}: handcrafted-stain-texture-v1 - midnight-12k: all -0.075, excluding -0.055; seeds whose CI excludes 0: 0 of 3 (all) and 0 of 3 (excluding)
* head_effects {"encoder": "handcrafted-stain-texture-v1"}: abmil - meanpool_logreg: all 0.049, excluding 0.050; seeds whose CI excludes 0: 0 of 3 (all) and 0 of 3 (excluding)
* head_effects {"encoder": "midnight-12k"}: abmil - meanpool_logreg: all 0.096, excluding 0.122; seeds whose CI excludes 0: 0 of 3 (all) and 2 of 3 (excluding)

The s3 candidate rule picks the same combination after the exclusion: true (robustness check only; the pre-declared candidate is unchanged). Every full-set number reproduced s3.json and the database exactly (reproduced: true).

**Real-WSI inference** (`attachments/inference_measurement.json`). The pre-declared candidate (midnight-12k + abmil) was registered as a bundle (not a test release) and run on the largest development slide (176894082 bytes, 30208 x 25088 px) with an in-process worker: job 9.573 s, 256 patches, features from the cache: true, process peak RSS 6250971136 bytes. A cached extraction makes inference fast; even so the engine loaded the encoder before its cache lookup (9.296 s of the job; the sampling plan and cache lookup took 0.261 s). A prediction row was recorded in the database; its score is not reported (the slide is a training slide of the final model). The COLD extraction of this slide, from the s2 per-slide record, took 54.960 s (52.958 s embedding 256 patches on mps); that extraction was done by the stopped pre-fix run (code 782668c) and reused through the cache (`exclusions.json` -> `supplement.interrupted_pre_fix_run`). In this fresh process the cached job took 9.573 s, about 5.7x faster than that cold extraction; the s2 cache-hit speed-ups (median 1,216x for Midnight-12k) were measured with the encoder already loaded.

**Also attached.** `pre_fix_inventory.{md,json}` (historical, pre-fix; stale run figures, not results), `midnight_parity.json` (adapter parity, 2026-10-26), `bulky_artifacts_index.json` (sha256 re-check of the local feature artifacts, checkpoints, slides, bundle and weights; hashes only).

**Regeneration (2026-11-09).** Re-exported after a fact-check. The 2026-10-28 export's supplementary inputs were kept in a session scratchpad that has since been cleared. `sensitivity_near_duplicates.json` and `inference_measurement.json` were re-attached from their original files in `experiments/reports/` (same sha256 as recorded); `pre_fix_inventory.md`, `midnight_parity.json` and `bulky_artifacts_index.json` from the previous package's byte-identical copies; `pre_fix_inventory.json` from the previous package's sanitized copy (original source sha256 01e0fe37…, no longer available). The test-release disclosure, the exclusions supplement and this note were rebuilt from the previous package's embedded copies, with corrections: the dry-run databases are listed once each, the reuse of pre-fix extractions is disclosed, and the exporter now states the test split's actual use instead of the driver's wording.
