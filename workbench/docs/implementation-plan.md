# DermPath Research Workbench: implementation plan and architecture contract

*Working name, provisional, not a cleared trademark. A research-use-only prototype. Written 2026-10-26 on branch `dermpath-workbench`, cut from `stage-6-production-foundation` (`c51a9e8`). Histology Lab OS stays intact at the repository root; the workbench lives in `workbench/`.*

## 1. Repository inspection (what exists, what is reused)
- **Histology Lab OS** (repository root) is a Next.js 16 / React 19 / TypeScript / SQLite lab-coordination app. These patterns are reused **as ideas**, not as a shared runtime, because the domain and the stack differ:
  - one write path with an audit trail;
  - scoped idempotency;
  - fail-closed runtime modes;
  - backend role enforcement;
  - honest "simulated" labelling;
  - the visual-honesty rules.
- **Environment, measured 2026-10-26:**
  - macOS arm64, 18 GB RAM;
  - Python 3.14.5, with PyTorch 2.14.1 (MPS), NumPy 2.4 and scikit-learn 1.9 installed globally;
  - OpenSlide available from pip as self-contained wheels (`openslide-bin`);
  - the Docker CLI is installed, but **the daemon is not running**;
  - **no local PostgreSQL or Redis**;
  - Node and npm are available, as for the existing app.

## 2. Stack decisions (prompt preference → what we build, and why)
| Prompt preference | Built | Why |
|---|---|---|
| Next.js/React + TypeScript frontend | `workbench/web`: Next.js 16 + React 19 + Tailwind 4 + OpenSeadragon | As preferred. A separate app, so the lab app is untouched. |
| FastAPI backend | `workbench/api`: FastAPI + SQLAlchemy 2 + Pydantic 2 | As preferred |
| PostgreSQL | SQLAlchemy with **SQLite (WAL) by default for local development**, and a PostgreSQL URL supported (`WB_DATABASE_URL`). The PostgreSQL path is in the compose file. | No local Postgres. The schema stays portable (no SQLite-only SQL in the models), and PostgreSQL is verified only when available. |
| Private S3-compatible object storage | An `ObjectStore` interface: `LocalObjectStore` (a private directory outside any web root, the default) and `S3ObjectStore` (boto3, when `WB_S3_*` is set). Access only through API routes with **signed, short-lived tokens**. | Works offline. S3 is unverified without MinIO. |
| Redis-backed job queue | A **database-backed queue** (`job` table with lease, heartbeat, attempts, idempotency key, cancel flag) plus a worker process (`python -m dermpath.worker`) | No Redis here. A DB queue gives retry, cancellation, idempotency and restart recovery with one fewer service. Redis can replace it behind the same interface later. |
| Python/PyTorch workers | Same package, separate process | As preferred |
| OpenSlide tile service | OpenSlide `DeepZoomGenerator` behind FastAPI tile routes, with an LRU slide-handle cache | As preferred |
| Containers | `workbench/docker-compose.yml` (postgres, minio, api, worker, web) | **Written, not verified** until a Docker daemon runs |

Pinned versions, each at least two weeks old at build time unless already installed: fastapi 0.143.0, uvicorn 0.54.0, sqlalchemy 2.1.4, pydantic 2.14.1, python-multipart 0.0.32, pillow 12.3.0, openslide-python 1.4.6, openslide-bin 4.0.1.2, pytest 9.1.1, httpx 0.28.1. numpy 2.4.2, scipy 1.17.0, scikit-learn 1.9.0 and torch 2.14.1 are pinned in the same isolated venv (no `--system-site-packages`, so no system-installed package such as a GPL library can be imported by accident).

## 3. Directory layout
```
workbench/
  README.md                  launch, access, real limitations
  docker-compose.yml         unverified until Docker runs
  api/
    requirements.txt         pinned
    dermpath/
      config.py              WB_MODE=demo|secured (secured is not implemented, so it fails closed), paths, limits, secrets
      db.py  models.py       SQLAlchemy engine/session; entities (section 5)
      auth.py  audit.py      demo login → signed session cookie; role + project guards; audit events
      storage.py             ObjectStore (local | s3); signed short-lived access tokens
      uploads.py             resumable chunked uploads, checksums, duplicate detection, limits
      slides/                OpenSlide reader, DeepZoom tiles, field images, calibration, identifier-risk checks
      qc/                    tissue segmentation (Otsu on a thumbnail), heuristic focus (variance of Laplacian), manual taxonomy, actions
      annotations.py labels.py review.py
      datasets.py            versions, freeze, patient-grouped splits, test lock, duplicates
      jobs/                  queue, worker loop, handler registry
      ml/                    patching, encoders, embedding cache, heads, training, evaluation, registry, active learning
      routers/               FastAPI routers, one per area
      seed.py                fictional demo workflow + fixtures
      main.py  worker.py
    tests/                   pytest (acceptance tests 1–12)
  web/                       Next.js app (acceptance test 13: Playwright; ROI unit tests: vitest)
  fixtures/
    CMU-1-Small-Region.svs   CC0, OpenSlide test data (1.85 MB), with attribution in fixtures/README.md
    large/                   gitignored; scripts/fetch-fixtures fetches CMU-1.svs (CC0, 169 MB) with a checksum
  docs/                      this plan, architecture/data dictionary, license ledger, competitive matrix,
                             governance, pilot protocol, demo script, readiness matrix, director overview
  var/                       gitignored runtime: database, private object store, embedding cache, checkpoints
```

## 4. Roles (enforced by the backend for every project-scoped route)
| Role | Can |
|---|---|
| `histology_assistant` | Import and upload slides; edit the hierarchy; record and resolve QC issues; route work. Cannot set expert labels. |
| `pathologist` | Everything in review: inspect, annotate, label, accept/correct/reject/hide suggestions, adjudicate disagreements; approve or exclude slides for datasets |
| `research_lead` | Build and freeze datasets; run experiments; read evaluations; register research model candidates. Cannot set expert labels. |
| `medical_director` | Read everything in the project (impact, validation readiness, evaluations). No writes, except comments. |
| `admin` | Project membership, and demo reset in demo mode. Has no clinical or labelling permissions. |

- **Demo mode:** `POST /api/v1/auth/demo-login {userId}` issues an HMAC-signed, HttpOnly session cookie for a **seeded fictional user**. It is a demo role switch, **not authentication**, and the UI says so.
- **Secured mode:** an OIDC hook (dependency-blocked; the Histology Lab OS OIDC implementation is the reference). Any mode other than `demo` refuses every request (fail closed).

## 5. Entities (SQLAlchemy; project-scoped; referential integrity enforced)
- **Organisation:**
  - `User` (id, display_name, role, active);
  - `Project` (id, name, task_template_json);
  - `ProjectMember`.
- **Specimen hierarchy:**
  - `CodedPatient` (project_id, code; **never** a name, MRN or birth date);
  - `Case` (coded_patient_id, accession_code, collected_on, site_id, provenance: `demo_synthetic` | `public_cc0` | `real_authorized`);
  - `SpecimenPart` (case_id, designation A/B…, anatomic_site_text);
  - `Block` (part_id, designation);
  - `Slide` (block_id, level_index, stain, scanner_id, scanned_at, review_state, provenance, image_kind: `wsi` | `field_image` | `synthetic_tiles`, object_key, sha256, bytes, format, width, height, levels, mpp_x, mpp_y (null when unknown), objective_power, ingest_status, ingest_error, processing_version).
- **Upload** (resumable: id, project_id, filename_safe, declared_size, declared_sha256, chunk_size, received_bytes, status, error, created_by).
- **QC:**
  - `QCReview` (slide_id, kind: `automated_screen` | `manual`, metrics_json, created_by);
  - `QCIssue` (slide_id, category, region_json?, source: `heuristic` | `human`, status: open → reviewed → action_suggested → resolved, suggested_action, resolution, dataset_eligibility_effect, reason, override_of);
  - categories: `fold`, `chatter`, `stain_variation`, `contamination_concern`, `incomplete_tissue`, `scan_focus`, `low_tissue_heuristic`, `blur_heuristic`, `unreadable_region`, `missing_calibration`.
- **AnnotationVersion** (annotation_id, version, slide_id, geometry_json in **level-0 pixel coordinates**, geometry_type `polygon` | `rectangle`, transform_meta_json, label, comment, author, created_at, reason, superseded_by, deleted).
- **LabelVersion:**
  - fields: label_id, version, scope `case` | `slide` | `region`, target_id, value, source `expert` | `model_suggestion`, author, created_at, reason, review_action `accepted` | `corrected` | `rejected` | `hidden`, supersedes;
  - values: `bcc_present`, `bcc_absent_not_benign` (displayed as "BCC absent (may include other malignancy, inflammation or mimics)"), `indeterminate`, `inadequate`, `out_of_scope`;
  - the original suggestion and the subsequent judgement are preserved separately.
- **Review:**
  - `ReviewAssessment` (independent initial review: the reviewer's assessment, recorded before suggestions are revealed);
  - `Disagreement` (slide or case, the labels in conflict, status, adjudication label version).
- **Datasets:**
  - `DatasetVersion` (project_id, name, version, status `draft` | `frozen`, config_json, manifest_sha256, created_by, frozen_at, parent_version_id);
  - `DatasetItem` (dataset_version_id, slide_id, slide_sha256, label_version_id, label_scope, coded_patient_id);
  - `SplitAssignment` (dataset_version_id, coded_patient_id, split `train` | `val` | `test`, partition `random` | `temporal` | `external_site`).
- **ML:**
  - `FeatureArtifact` (cache key: slide_sha256 + encoder_id + weights_sha256 + preprocessing_version + patch_size + mpp/level + coords_sha256; object_key);
  - `TrainingRun` (dataset_version_id, encoder_id, head `meanpool_logreg` | `abmil`, params_json, seed, code_revision, deps_json, weights_sha256, status, job_id, checkpoint_key, synthetic: bool);
  - `Prediction` (run_id, item, split, score, label, abstained);
  - `Evaluation` (run_id, split, metrics_json, threshold, threshold_frozen_from: `val`);
  - `ModelVersion` (run_id, status `research_candidate`; never deployed automatically).
- **Platform:**
  - `Job` (type, payload_json, idempotency_key unique, status `queued` | `running` | `succeeded` | `failed` | `canceled`, attempts, max_attempts, lease_until, heartbeat_at, progress, result_json, error, cancel_requested);
  - `AuditEvent` (append-only: actor, role, project, action, entity, before/after (no pixels, no credentials), reason, correlation_id, at).

## 6. API contract (prefix `/api/v1`; JSON; every project route checks membership and role)
- **Auth:** `POST /auth/demo-login`, `POST /auth/logout`, `GET /auth/me`, `GET /auth/demo-users` (demo only).
- **Health and jobs:** `GET /health`; `GET /jobs?project_id=`, `GET /jobs/{id}`, `POST /jobs/{id}/cancel`, `POST /jobs/{id}/retry`.
- **Projects and hierarchy:** `GET /projects`, `GET /projects/{pid}`, `GET /projects/{pid}/worklist`, `GET /projects/{pid}/cases`, `GET /cases/{id}` (parts → blocks → slides), and POST/PATCH for patients, cases, parts, blocks and slide metadata.
- **Uploads:**
  - `POST /projects/{pid}/uploads` with {filename, size, sha256, kind_hint, slide target or new hierarchy} returns {upload_id, chunk_size, received_bytes};
  - `PUT /uploads/{id}/chunks/{index}` (raw bytes; the chunk's sha256 in a header);
  - `GET /uploads/{id}` returns the resume offset;
  - `POST /uploads/{id}/complete` verifies the whole-file sha256 and enqueues `ingest`.
- **Slides and tiles:**
  - `GET /slides/{id}` returns metadata, provenance, QC summary, labels and review state;
  - `GET /slides/{id}/viewer-token` returns {dzi_url, expires_at} with a short-lived signed token;
  - `GET /tiles/{token}/slide.dzi` and `GET /tiles/{token}/slide_files/{level}/{col}_{row}.jpeg` (token bound to slide, user and expiry);
  - `GET /slides/{id}/thumbnail?token=`.
  - Label and macro images are **not served** (identifier risk).
- **QC:**
  - `GET /slides/{id}/qc`;
  - `POST /slides/{id}/qc/screen` (enqueue the automated screening job);
  - `POST /slides/{id}/qc/issues`;
  - `PATCH /qc/issues/{id}` (review, action, resolution, override with reason).
- **Annotations:** `GET /slides/{id}/annotations` (current versions, `?history=1` for all), `POST /slides/{id}/annotations`, `PATCH /annotations/{id}` (new version, reason required), `DELETE /annotations/{id}` (soft delete, a new version), `GET /projects/{pid}/export/annotations.geojson`.
- **Labels and review:**
  - `GET /slides/{id}/labels`;
  - `POST /slides/{id}/assessment` (independent initial review);
  - `POST /slides/{id}/labels` (expert label, with scope);
  - `POST /labels/{id}/review` (accept, correct, reject or hide a suggestion);
  - `POST /slides/{id}/review-state` (approve, dispute or exclude, with a reason);
  - `GET /projects/{pid}/disagreements`, `POST /disagreements/{id}/adjudicate`.
- **Datasets:**
  - `GET /projects/{pid}/datasets`, `POST /projects/{pid}/datasets` (draft from a config);
  - `GET /datasets/{id}/summary` (patients, slides, blocks, label balance, batches, missing metadata, exclusions, agreement, duplicates);
  - `POST /datasets/{id}/splits` (patient-grouped; random, temporal or external_site);
  - `POST /datasets/{id}/freeze`;
  - `GET /datasets/{id}/manifest`, `GET /datasets/{id}/export`.
- **ML** (built by the ML pass):
  - `GET /encoders` (each with license metadata and dependency status: `available` | `missing_weights` | `missing_dependency`);
  - `POST /projects/{pid}/experiments` with {dataset_version_id, encoder_id, head, params, seed} returns a run plus a job;
  - `GET /projects/{pid}/experiments`, `GET /experiments/{id}`;
  - `GET /experiments/{id}/evaluation?split=val|test`, `GET /experiments/{id}/errors`;
  - `POST /experiments/{id}/register` (research candidate);
  - `GET /projects/{pid}/models`;
  - `POST /projects/{pid}/active-learning` (proposes from the train pool only).
- **Audit and demo:** `GET /projects/{pid}/audit`; `POST /demo/reset` (admin, demo mode only).

## 7. Honesty rules built into behaviour
- Provenance is shown on every slide and dataset: `DEMO SYNTHETIC` (procedural tiles, not histology), `PUBLIC CC0` (OpenSlide test data, unlabeled) or `REAL DATA (authorized)` (only via upload, with a governance checkbox that is recorded but **not** treated as proof of de-identification).
- Results from synthetic embeddings are labelled **"PIPELINE TEST — NOT PATHOLOGY VALIDATION"** everywhere they appear.
- No scale bar without known microns per pixel. No automatic detection claims beyond tissue segmentation and the heuristic focus screen, both labelled experimental.
- Model suggestions never become expert truth. Independent review hides suggestions until an assessment is recorded.
- No automatic sign-out, ordering, dismissal or reprioritisation.
- Undefined metrics are shown as "undefined (denominator 0)". Small samples show "insufficient evidence".

## 8. Build order (from the prompt)
1. Intake, persistent metadata, viewer and label review (backend core, then frontend).
2. Dataset versioning and patient split guards.
3. Processing adapters, executable training smoke test, real-model dependency path.
4. Evaluation and research model registry.
5. Impact calculator, polished demo and director walkthrough.
6. Tests, screenshots, documentation and readiness report.

P1 (after the MVP, **not built now**):
- multi-reader study tooling;
- stronger active learning;
- a second encoder;
- external-site evaluation;
- QuPath exchange;
- cost monitoring;
- drift analysis.
