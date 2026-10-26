# Readiness matrix (2026-10-26)

*Research use only. "Tested" means automated tests on synthetic or public CC0 data on this machine. It is not pathology validation, not clinical validation, and not a regulatory status.*

## Engineering, internal, external and clinical readiness
| Level | Where we are |
|---|---|
| **Engineering readiness** (the workflow and pipeline work end to end, honestly labelled) | **Reached for the vertical slice.** Evidence below. |
| **Internal validation** (a defined task, real authorised slides from one lab, an expert reference standard, a locked test set) | **Not started.** It needs authorised data, a protocol (`pilot-protocol.md`) and a licensed encoder. |
| **External validation** (another site or period, untouched) | **Not started.** The schema and splits support it (`external_site` and `temporal` partitions). |
| **Clinical deployment readiness** | **Not applicable to this prototype.** It would require a regulatory pathway, the laboratory's own validation and a secured deployment. |

## Matrix
| Capability | Implemented | Tested | Simulated | Dependency-blocked | Future (P1+) |
|---|---|---|---|---|---|
| Demo role switch with backend role and project guards (reads and writes) | ✓ | ✓ (acceptance 4) | Demo identities (not authentication) | Real sign-in (OIDC) | ✓ |
| Resumable chunked upload, checksums, duplicate detection, limits | ✓ | ✓ (acceptance 1, 2; browser upload test) | | | |
| OpenSlide ingestion and DeepZoom tiles behind signed short-lived tokens | ✓ | ✓ (Aperio SVS only; acceptance 14) | | Other scanner formats untested | Multi-level SVS in the browser |
| Label and macro images never served; identifier-risk flags | ✓ | ✓ | | | |
| Procedural synthetic slides (no histology) | ✓ | ✓ | ✓ (labelled DEMO SYNTHETIC) | | |
| QC: Otsu tissue segmentation, heuristic focus, manual taxonomy, issue → resolution → eligibility | ✓ | ✓ | Thresholds uncalibrated | | Calibrated detectors |
| Annotations in level-0 coordinates, versioned, GeoJSON export | ✓ | ✓ (acceptance 3, backend and browser, within 0.5 px after zoom, rotation and reload) | | | Vertex editing; free rotation; QuPath exchange |
| Labels: scopes; accept, correct, reject or hide; independent initial review; disagreement and adjudication | ✓ | ✓ | Suggestions are demo fixtures | | Multi-reader study tooling |
| Dataset versions: patient-grouped splits, freeze, immutable manifests, test-set lock, near-duplicate candidates | ✓ | ✓ (acceptance 5–8) | | | |
| Freeze gate: open person-raised QC issues and unreviewed cross-split near-duplicates block freezing until resolved or acknowledged with a reason, recorded in the manifest | ✓ | ✓ (backend test; browser test of the dialog) | | | |
| Feature extraction: tissue coordinates at a calibrated scale, embedding cache | ✓ | ✓ (real path on the CC0 slide, synthetic encoder) | Synthetic encoder | Pathology encoder weights | Second encoder comparison |
| Heads: mean-pool logistic regression; attention MIL; frozen threshold; checkpoints with provenance | ✓ | ✓ (acceptance 9) | Synthetic embeddings only | | |
| Evaluation: denominators, undefined metrics, patient-cluster bootstrap, calibration, abstention, subgroups, error gallery, attention | ✓ | ✓ (acceptance 11) | On synthetic embeddings | | External-site evaluation |
| Encoder dependency states (UNI missing weights, ResNet missing torchvision) | ✓ | ✓ (acceptance 10) | | **UNI: licensed weights and `timm`; CC-BY-NC-ND (no commercial use)** | |
| Research model registry (never deployed), active learning from the train pool only | ✓ | ✓ (acceptance 7) | | | Stronger active learning |
| Job queue: retry, cancel, idempotency, crash recovery | ✓ | ✓ (a real worker killed mid-job and recovered) | | Redis (not needed) | |
| Impact: live ROI calculator, business scenarios, optional ARR multiple | ✓ | ✓ (acceptance 12; 47 unit tests) | All defaults fictional | | |
| Main journeys at desktop and tablet widths, keyboard | ✓ | ✓ (acceptance 13) | | Screen-reader testing (human) | |
| Overview scroll-through of the CC0 slide (computed tissue mask and patch grid), restrained motion with reduced-motion fallback | ✓ | ✓ (browser tests, including reduced motion) | The outline in step 3 is illustrative and labelled so | | |
| PostgreSQL, S3/MinIO, Docker compose | Written | ✗ | | **No Docker daemon on this machine** | |
| Audit trail | ✓ (append-only) | ✓ | | | Tamper evidence (as in Histology Lab OS) |

## Measured on this machine (macOS arm64, CPU)
| Measurement | Result | Source |
|---|---|---|
| CMU fixture ingest | 134 ms; about 92 MiB added memory | backend report; `scripts/measure_ingest_and_tiles.py` |
| Tile latency (in-process) | first 3.7 ms; warm median 2.5 ms, p95 3.0 ms | same |
| Time to the first tile drawn in the browser | 118 ms (fresh process), 70–86 ms (later), from viewer start | `README.md` |
| Feature extraction (CMU fixture, 41 patches, synthetic encoder) | about 0.09 s | ML report |
| Training (synthetic cohort, 69 bags) | logistic regression about 0.3 s per job; ABMIL about 0.5–0.7 s per job | ML report |

These are a single 1.9 MB single-level fixture and a synthetic cohort. Larger slides and real cohorts have **not** been measured.

## Test results (2026-10-26)
| Suite | Result |
|---|---|
| Backend and ML (`pytest`) | 173 passed |
| Web unit tests (`vitest`) | 47 passed |
| Web type check | clean |
| Browser (`playwright`) | 25 passed, 0 skipped (18 at 1440 × 900, 7 at 1024 × 768; production build, real API and worker) |
| Dependency audit (`npm audit`) | 0 vulnerabilities after upgrading Next.js to 16.4.2 and Vitest to 4.1.12 |

Passing synthetic tests are **not** pathology validation.
