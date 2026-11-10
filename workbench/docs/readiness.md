# Readiness matrix (2026-10-28)

*Research use only. This matrix uses four levels of evidence:*

| Level | Meaning |
|---|---|
| **Implemented** | The code exists and the app or the experiment driver uses it |
| **Tested with fixtures** | Automated tests pass on synthetic data, the public CC0 slide or throwaway databases (`pytest`, `vitest`, Playwright). This is engineering evidence only |
| **Measured on real data** | Run on the 60-slide public COBRA BCC subset (one site, report-derived *imported reference* labels). Every number is a technical measurement or a **development** out-of-fold estimate; the test split has never been released. Details and sources: `ml-engine-report.md` |
| **Clinically validated** | An appropriate validation study: an independent expert reference standard, a locked and untouched test cohort from the intended-use population, a pre-registered protocol. **No row has this. "Unsupported" is the honest entry everywhere** |

Passing tests are not pathology validation, not clinical validation, and not a regulatory status.

## Readiness ladder

| Level | Where we are |
|---|---|
| **Engineering readiness** (the workflow and pipeline work end to end, honestly labelled) | **Reached for the vertical slice.** The ML engine has also run end to end on real public slides: feature extraction, `dev_cv` training with three seeds, ablations, resources, failure analysis, and one real-slide inference (`ml-engine-report.md` §1, §3) |
| **Internal validation** (a defined task, real authorised slides from one lab, an expert reference standard, a locked test set) | **Not started.** The COBRA benchmark is development evidence against an imported, report-derived reference on public data. It is not internal validation. Internal validation needs authorised data, a protocol (`pilot-protocol.md`) and an expert reference |
| **External validation** (another site or period, untouched) | **Not started.** The schema and splits support it (`external_site` and `temporal` partitions). COBRA has one site and no collection dates, so it cannot provide this |
| **Clinical deployment readiness** | **Not applicable to this prototype.** It would require a regulatory pathway, the laboratory's own validation and a secured deployment |

## Matrix: workflow and data

| Capability | Implemented | Tested with fixtures | Measured on real data | Clinically validated | Notes (simulated / blocked / future) |
|---|---|---|---|---|---|
| Demo role switch with backend role and project guards (reads and writes) | ✓ | ✓ (acceptance 4) | — | Unsupported | Demo identities, not authentication. Real sign-in (OIDC) is blocked/future |
| Resumable chunked upload, checksums, duplicate detection, limits | ✓ | ✓ (acceptance 1, 2; browser upload test) | — | Unsupported | |
| OpenSlide ingestion and DeepZoom tiles behind signed short-lived tokens | ✓ | ✓ (Aperio SVS; acceptance 14) | ✓ Ingest only: 60 COBRA pyramidal TIFFs opened as `generic-tiff` at 0.4851 µm/px, with metadata equal to COBRA's (`public-datasets.md`). Not viewed in the browser tests | Unsupported | Other scanner formats untested; multi-level SVS in the browser is future |
| Label and macro images never served; identifier-risk flags | ✓ | ✓ | ✓ (COBRA: no associated images; 34 false-positive file-name flags left for review) | Unsupported | |
| Procedural synthetic slides (no histology) | ✓ | ✓ | — | Not applicable | Labelled DEMO SYNTHETIC |
| QC: Otsu tissue segmentation, heuristic focus, manual taxonomy, issue → resolution → eligibility | ✓ | ✓ | ✓ (60 COBRA screens, 0 heuristic issues raised) | Unsupported | Thresholds uncalibrated; calibrated detectors are future |
| Annotations in level-0 coordinates, versioned, GeoJSON export | ✓ | ✓ (acceptance 3, backend and browser, within 0.5 px) | — | Unsupported | Vertex editing, free rotation and QuPath exchange are future |
| Labels: scopes; accept, correct, reject or hide; independent review; disagreement and adjudication | ✓ | ✓ | Imported reference labels only (60 COBRA labels, never expert reads) | Unsupported | Demo suggestions are fixtures; multi-reader tooling is future |
| Dataset versions: patient-grouped splits, freeze, immutable manifests, test-set lock, near-duplicate candidates | ✓ | ✓ (acceptance 5–8; `test_verify_splits.py`) | ✓ Frozen COBRA version `1868803e`: 35 development / 15 test patients, manifest and split fingerprint verified; 2 near-duplicate candidate pairs, no human decision yet | Unsupported | |
| Freeze gate: open QC issues and unreviewed cross-split near-duplicates block freezing until resolved or acknowledged | ✓ | ✓ (backend; browser dialog) | — | Unsupported | |
| Job queue: retry, cancel, idempotency, crash recovery | ✓ | ✓ (a real worker killed mid-job and recovered) | ✓ A stranded real build job (lease expired, process gone) was resumed and finished by the next worker | Unsupported | Redis not needed |
| Impact: ROI calculator, business scenarios, optional ARR multiple | ✓ | ✓ (acceptance 12; 47 unit tests) | — | Not applicable | All defaults fictional |
| Main journeys at desktop and tablet widths, keyboard | ✓ | ✓ (acceptance 13) | — | Not applicable | Screen-reader testing (human) is future |
| Overview scroll-through of the CC0 slide | ✓ | ✓ (browser tests, including reduced motion) | — | Not applicable | The step-3 outline is illustrative and labelled so |
| PostgreSQL, S3/MinIO, Docker compose | Written | ✗ | — | Not applicable | **Blocked:** no Docker daemon on this machine |
| Audit trail | ✓ (append-only) | ✓ | ✓ (driver and services wrote audit rows on the real run) | Not applicable | Tamper evidence is future |

## Matrix: ML engine

| Capability | Implemented | Tested with fixtures | Measured on real data (COBRA subset; `ml-engine-report.md`) | Clinically validated |
|---|---|---|---|---|
| Execution modes; label-free technical mode; no label in any encoder context | ✓ | ✓ (`test_verify_modes.py`) | ✓ s2 read no labels; all 60 slides were extracted label-free | Unsupported |
| Midnight-12k adapter (pinned weights; CLS + mean-patch pooling; mean/std 0.5) | ✓ | ✓ (tiny random models) | ✓ Weights sha256 verified; 60 slides extracted on MPS; determinism max abs diff 0 on 2 slides. One-off recorded check (2026-10-26; not an automated test, predates the fix rounds): parity vs transformers `from_pretrained` on the real local weights, 8 CC0 patches, CPU fp32, max abs diff 2.03e-6. kaiko's own pipeline was not run | Unsupported |
| Handcrafted stain/texture baseline encoder | ✓ | ✓ | ✓ 60 slides on CPU | Unsupported |
| UNI, Hibou-B, ResNet-18 encoders | ✓ (adapters) | ✓ (dependency states; tiny models) | — | Unsupported. **Blocked:** licensed weights not present (UNI CC-BY-NC-ND; Hibou gate not accepted) |
| Frozen feature sets, content-addressed cache, artifact integrity | ✓ | ✓ (`test_verify_provenance.py`) | ✓ 9 feature sets, 60/60 each; every artifact re-hashed equal. Five of the sets, and 30 of the 60 artifacts of a sixth, were extracted by the stale pre-fix run (code `782668c`) and reused through the cache after identity checks; the post-fix determinism re-check matched them (max abs diff 0). Cache-hit speed-up median 61× (handcrafted) and 1,216× (Midnight), measured with the encoder already loaded (encoder load 0.002 s); in a fresh process one cached inference job took 9.573 s against a 54.96 s cold extraction of that slide (about 5.7×), mostly loading the encoder | Unsupported |
| Patch sampling (spatial, uniform) and coverage reporting | ✓ | ✓ (`test_verify_sampling.py`) | ✓ Uniform vs spatial: no difference detected (CIs include 0). Coverage is tissue coverage, not lesion coverage | Unsupported |
| Sampling budget comparison (development only) | ✓ | ✓ (`test_driver_fingerprints.py`) | ✓ 256 vs 512: no difference detected (CIs include 0); cost about 1.7–2× per slide | Unsupported |
| Macenko stain normalisation | ✓ | ✓ (`test_fold_safe_preprocessing.py`) | **Blocked** under `dev_cv`: a dataset-fitted shared reference is fold-unsafe. Fold-specific fitting is not implemented | Unsupported |
| Low-precision extraction (fp16 / bf16) with an acceptance rule | ✓ | ✓ | ✓ fp16 accepted (1.197× throughput; downstream AUROC delta −0.004); bf16 rejected (cosine_min 0.99835 < 0.999) | Unsupported |
| `dev_cv` protocol: patient-grouped folds fixed across heads and seeds; three pre-declared seeds; patient-cluster bootstrap | ✓ | ✓ (`test_cv_fold_stability.py`, `test_verify_statistics.py`) | ✓ 24 runs on one fold assignment; 35 development patients | Unsupported |
| Heads: mean-pool logistic regression; ABMIL (epoch count on an inner hold-out, then a fresh fit on all permitted bags) | ✓ | ✓ (acceptance 9; `test_abmil_refit.py`) | ✓ Final ABMIL fits use 45 bags / 35 patients | Unsupported |
| Operating threshold (Youden, frozen) | ✓ | ✓ | ✓ Development values are **tuning estimates** (threshold chosen on the same OOF scores) | Unsupported |
| Calibration: patient-group evidence gate; in-sample labelling | ✓ | ✓ (`test_calibration_evidence.py`) | ✓ Platt fitted with 18 / 19 patient groups; calibrated metrics are **in-sample**; not a validated probability | Unsupported |
| Paired comparisons with subject accounting (unscorable subjects counted, never imputed) | ✓ | ✓ (`test_reporting_accounting.py`, `test_verify2_reporting.py`) | ✓ 45 paired bags, 0 unscorable; encoder and head effects reported per seed | Unsupported |
| Learning curves (subsets drawn within folds) | ✓ | ✓ | ✓ Mean-pool only (8 / 14 / 28 fit patients per fold) | Unsupported |
| Near-duplicate sensitivity analysis | ✓ (script) | ✓ (`test_evidence_scripts.py`, uncommitted) | ✓ Excluding 4 patients changes no ranking and no AUROC effect direction; one AUPRC head effect (handcrafted, seed 1) changes sign | Unsupported |
| Failure-analysis taxonomy | ✓ | ✓ | ✓ Development OOF errors only; `mimic` and `small_lesion` not assessable without expert input | Unsupported |
| Inference bundle: slide/case scope refusal; one input snapshot; versioned predictions; concurrency | ✓ | ✓ (`test_inference_scope.py`, `test_inference_snapshot_identity.py`, `test_inference_request_identity.py`, `test_verify2_inference.py`) | ✓ One `infer_slide` job on one cached development slide: 9.573 s, 256 patches. 9.296 s of it was the encoder load (open defect: the encoder is loaded before the cache lookup) | Unsupported |
| Bounded-memory inference (chunked mean) | ✓ | ✓ **Synthetic** 100,000 × 1,536 memmap: extra allocation about 33 MB instead of about 1.23 GB; parity 4.3e-19 (`test_inference_memory.py`, slow) | — Not measured on real data: the one real job used the ABMIL bundle (no chunked mean), and its peak RSS (6,250,971,136 bytes) was dominated by the encoder load | Unsupported |
| Active learning with evaluation-cohort protection | ✓ | ✓ (`test_al_cohort_protection.py`, `test_verify2_al.py`) | — Not exercised on the real cohort | Unsupported |
| Experiment driver: per-stage fingerprints, staleness, dependencies, no automatic test release | ✓ | ✓ (`test_driver_fingerprints.py`, `test_verify2_driver.py`) | ✓ Legacy pre-fix reports were detected as stale and superseded; s0–s5, s7 and s8 valid; s6 not run | Unsupported |
| Test-release discipline (explicit, audited, pre-declared candidate) | ✓ | ✓ (`test_verify_leakage.py`, `test_driver_fingerprints.py`) | **No test release** in the real study (owner's decision). The 15 test patients are unreleased in the real study and not used for model selection; their 15 slides were feature-extracted label-free. Before the split was frozen, throwaway dry runs processed 6 COBRA slides from 6 patients, 4 of whom are among the 15 test patients: for 2 of them dry-run test predictions were looked at (dry-run models trained on about 4 slides); the other 2 were dry-run training patients (labels read, slides used for dry-run Macenko references). None of this informed any real-cohort run, threshold or candidate | Unsupported |
| Sanitized evidence exporter | ✓ | ✓ (`test_evidence_export.py`) | ✓ Package `experiments/evidence/cobra-bcc-subset-2026-10-28/`, leak-scanned (0 identifiers) | Not applicable |
| Performance on a held-out test cohort | — | — | **Not measured** (test unreleased) | Unsupported |

## Measured on this machine

The machine is macOS 14.5 arm64, 11 CPUs, 18 GB, with Apple MPS and no CUDA.

| Measurement | Result | Source |
|---|---|---|
| CMU CC0 fixture ingest | 134 ms; about 92 MiB added memory | backend report; `scripts/measure_ingest_and_tiles.py` |
| Tile latency (in-process, CC0 fixture) | first 3.7 ms; warm median 2.5 ms, p95 3.0 ms | same |
| Time to the first tile drawn in the browser (CC0 fixture) | 118 ms (fresh process), 70–86 ms (later), from viewer start | `README.md` |
| COBRA extraction, handcrafted, 256 patches/slide (CPU) | 4.42 s/slide mean; read 183.8 and embed 88.8 patches/s (extracted by the stale pre-fix run, reused) | `experiments/reports/s5.json` → `extraction[0]` |
| COBRA extraction, Midnight-12k, 256 patches/slide (MPS fp32) | 56.66 s/slide mean (49.33–70.61); read 158.7 and embed 4.66 patches/s; process peak RSS 5,880,561,664 bytes (extracted by the stale pre-fix run, reused) | `s5.json` → `extraction[1]` |
| COBRA extraction, Midnight-12k, 512 patches/slide | 98.72 s/slide mean | `s5.json` → `extraction[6]` |
| Feature storage per slide (Midnight-12k, 256 / 512 patches) | 3,162,427 / 6,278,684 bytes mean | `s5.json` → `extraction[1,6]` |
| Training, 24 `dev_cv` runs (5 folds each) | 91.04 s total; ABMIL at most 26.90 s per run; mean-pool mean 0.199 s | `s5.json` → `training` |
| Real-slide inference (cached features, 256 patches) | 9.573 s job, of which 9.296 s encoder load; the same slide's cold extraction took 54.960 s (pre-fix) | `experiments/evidence/…/attachments/inference_measurement.json` |
| Whole real run (s0–s5, s7, s8) | 11,364.6 s | `experiments/reports/summary.json` → `elapsed_seconds_total` |

These are one machine, one small public cohort and one inference slide; they are not throughput benchmarks for other hardware.

## Test results (2026-10-28)

| Suite | Result | When / source |
|---|---|---|
| Backend and ML (`pytest`, default excludes `slow`) | **1081 passed**, 1 deselected | HEAD `8a1a59e`; commit message ("pytest 1081 passed (+1 slow)"). The 342 s duration came from the round-2 record, since cleared |
| Slow tests (`pytest -m slow`) | 1 passed (the synthetic memory fixture) | same commit message ("+1 slow") |
| Web type check (`tsc --noEmit`) | clean | same commit message |
| Web unit tests (`vitest`) | **47 passed** | same commit message (the "2 files" detail came from the cleared record) |
| Browser (`playwright`) | **25 passed** | The `7ba0435` and `8a1a59e` commit messages both state 25. The 49.6 s duration, and the note that round 2 did not re-run it, came from the cleared fix-round records and are no longer verifiable |
| Working tree with the uncommitted evidence tooling (+7 tests) | 1088 passed, 1 deselected (270 s) | Evidence step, 2026-10-28; its log was cleared, so not independently verifiable. Superseded: the working tree has gained tests since |
| Lint (`ruff`) | not run (not installed in the venv) | — |
| Dependency audit (`npm audit`) | 0 vulnerabilities (2026-10-26, after upgrading Next.js to 16.4.2 and Vitest to 4.1.12) | Not re-run on 2026-10-28 |

Passing tests are **not** pathology or clinical validation.
