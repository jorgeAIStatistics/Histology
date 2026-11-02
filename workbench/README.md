# DermPath Research Workbench

*Working name, provisional. A **research-use-only** prototype: not a medical device, no diagnostic capability, no claim about patient outcomes, turnaround or regulatory readiness (no HIPAA or FDA claim). It runs on fictional workflow records, procedural synthetic images and one public CC0 test slide. No patient data.*

The workbench links slide intake, preparation and scan quality, expert label review, frozen patient-grouped datasets, a reproducible (synthetic) training pipeline with honest evaluation, and an adjustable economic model for a medical director. It lives in `workbench/`, separate from the Histology Lab OS app at the repository root.

| Part | Where | Stack |
|---|---|---|
| API | `workbench/api` | FastAPI, SQLAlchemy (SQLite by default), OpenSlide tile service, DB-backed job queue |
| Worker | `workbench/api` (`python -m dermpath.worker`) | Same package, separate process: ingest, QC screening, training |
| Web | `workbench/web` | Next.js 16, React 19, Tailwind 4, OpenSeadragon 6 |

## Run it locally

Three processes. Ports: API **8000**, web **3600**.

```bash
# 1. API (the first start creates workbench/var and seeds the fictional demo, including the
#    synthetic ML pipeline-test runs; this takes a few seconds)
cd workbench/api
.venv/bin/uvicorn dermpath.main:app --port 8000

# 2. Worker (in a second terminal). Without it, queued jobs (uploads' ingest, QC re-screens,
#    new experiments) stay "queued" and the UI says so.
cd workbench/api
.venv/bin/python -m dermpath.worker

# 3. Web (in a third terminal)
cd workbench/web
npm run dev            # http://localhost:3600
# or a production build:
npm run build && npm start
```

Open **http://localhost:3600**. The browser talks only to the web origin: `next.config.ts` rewrites `/api/v1/*` to `WB_API_URL` (default `http://127.0.0.1:8000`), so the HttpOnly session cookie and the signed tile URLs stay same-origin.

- **`WB_API_URL` is read when the web app is built** (Next.js bakes rewrites into the build). For a production build against another API: `WB_API_URL=http://host:port npm run build`.
- The API accepts state-changing requests only from `WB_CORS_ORIGINS` (default `http://localhost:3600,http://127.0.0.1:3600`). If you serve the web app on another port or host, add that origin when starting the API.
- The API venv (`workbench/api/.venv`) is described in `workbench/api/requirements.txt` (pinned). Reset the demo data with `.venv/bin/python -m dermpath.seed --reset`, or as the admin user from the role menu (**Reset demo data**).

### Demo users (fictional) and what each can do

The role menu at the top right is a **demo role switch, not authentication**: anyone with access to the demo can act as any of these users. The backend enforces each role's permissions; the interface explains a missing permission instead of hiding it.

| User | Role | Can |
|---|---|---|
| Sam Rivera | Histology assistant | Upload, edit the specimen hierarchy, record and resolve QC issues, route slides for review |
| Dr. Imani Castell | Pathologist | Annotate, label, review suggestions, adjudicate, approve or exclude |
| Dr. Tomas Lindqvist | Pathologist (independent review on) | Same; suggestions stay hidden until he records his own assessment |
| Priya Navarro | Research lead | Datasets (draft, splits, freeze, new version, export), experiments, the test split (audited), model registry |
| Dr. Elena Marsh | Medical director | Reads everything, comments; cannot change data |
| Jordan Pike | Admin | Membership and demo reset; no clinical permissions |

Projects: **BCC research template (demo)** (the workflow demo), **Synthetic pipeline-test cohort (no images, no histology)** (60 fictional patients, generator specs only, for metrics with enough items), and a restricted project used to show project-scoped access.

## The five-minute walkthrough in the UI

1. **Overview** ("Why this matters"): one public CC0 slide followed through five steps as you scroll (intake, tissue and quality, expert outline, patches, dataset), the augmentation commitment, the six questions, the walkthrough.
2. **Worklist** (histology assistant): case `DEMO-S26-0003` (patient `P-0003`) has parts A and B, a pending slide with a QC flag and a demo suggestion, a disputed slide and an excluded slide; open a slide with `j`/`k` and `Enter`. The exact clicks are in `docs/demo-script.md`.
3. **Slide Review**, QC tab: the experimental tissue and blur screen, the tissue mask (`M`), and a fold issue through review → suggested action → resolution → dataset eligibility.
4. **Slide Review**, Labels tab (pathologist): independent assessment, suggestion accept / correct / reject / hide, a slide-level label, a disagreement, **Approve**.
5. **Dataset** (research lead): summary (patients counted apart from slides), patient-grouped splits, **Freeze**, the manifest hash and the test-set lock.
6. **Experiments**: the PIPELINE TEST banner, provenance, threshold chosen on validation, metrics with denominators and intervals, the error gallery; UNI shown as missing weights.
7. **Impact**: lower "Pathologist minutes saved per case" until the annual result turns negative.

## What is built, screen by screen

- **Overview:** the CC0 slide on a dark stage, pinned while five steps scroll past. The overlays are computed, not drawn: the background mask comes from the QC screen and the 41 patches from feature extraction (`scripts/build_overview_assets.py`). The one illustrative element, an outline, says so. A readout under the slide gives each step's facts, so nothing covers the tissue. On first load the slide is revealed top to bottom like a scanner pass; with reduced motion it simply appears.
- **Shell:** navigation (Overview, Worklist, Slide Review, Dataset, Experiments, Impact); a persistent "Research use only" status with a system-status popover (API, worker, tile service, ML service); provenance chips (DEMO, PUBLIC CC0, REAL DATA) on cases and slides; project switcher (on a slide or run page it follows the page once, then a different choice opens that project's list instead of snapping back); demo role switch. Every unavailable action says which role or dependency it needs. Messages never cover the controls they answer: on Slide Review they sit over the slide's bottom-left corner, inside an open dialog they appear above its buttons, and they pause while hovered or focused.
- **Worklist:** slides grouped by case (patient code → case → parts → blocks → slides, with level and stain), review state, open QC issues, label status and readers, ingest status with the failed scan's readable error and a retry, identifier-risk counts. Filters (state, provenance, label status, open QC, ingest problems, search) and keyboard navigation (`/`, `j`/`k`, arrows, `Enter`). Case dialog for hierarchy edits (case, parts, blocks, slide level/stain/scanner/block, each with a reason). Route-to-review. **Upload:** chunked and resumable (server-fixed chunk size), whole-file SHA-256 in the browser (Web Crypto; a streaming SHA-256 above 256 MiB because Web Crypto has no incremental API), per-chunk SHA-256, pause and resume, resume after a reload by re-selecting the same file, duplicate detection, type and size limits from `/meta`, identifier-risk flags, then the ingest job status.
- **Slide Review:** OpenSeadragon (canvas drawer) with pan, zoom, navigator, lazy DeepZoom tiles through short-lived signed tokens that the viewer refreshes; 90° rotation; a scale bar **only** when microns per pixel is known. Rectangle and polygon tools on an SVG overlay, converted to and from **level-0 pixels** with OpenSeadragon's `TiledImage` conversions plus the DZI bounds offset; saved with `transform_meta` (rotation, zoom, container size, method). A rectangle drawn on a 90°-multiple rotation stays an axis-aligned level-0 rectangle. Versioned edits (label, comment, redraw) need a reason; delete is soft; version history is viewable; GeoJSON export. A keyboard alternative ("Outline the view centre") exists for drawing. QC panel, labels panel, comments, slide details (provenance, calibration, identifier risk, measured tile timings). Visible shortcut legend; `?` opens the full list. "SYNTHETIC — NO HISTOLOGY" and "PUBLIC CC0 — unlabeled" are shown on the image. Pending and "not labelled by you" indicators. Attention weights from an ABMIL run open on the slide labelled "not tumour segmentation and not a causal explanation".
- **Dataset:** versions by lineage; draft creation (label scope, review states, label values, provenance, split); summary (unique patients, cases, blocks, slides; label balance; site, scanner and stain cross-tabs; missing metadata; exclusions with reasons; reviewer agreement with kappa marked "insufficient evidence"; exact duplicates and near-duplicate candidates with a human decision); splits (random, temporal, external site), always grouped by coded patient, with diagnostics; freeze through a check (open QC issues a person raised or confirmed, and near-duplicates split across train/val/test without a human decision, are listed; freezing then needs them resolved, or acknowledged with a reason that the manifest records and hashes); manifest (hash verified, items with image hashes, label versions and splits, configuration); staleness check; new version from a frozen parent; test-set lock with audited access; JSON and CSV export.
- **Experiments** (against `dermpath/ml/router.py`): readiness ladder (engineering only); encoders with licence and the exact missing dependency (UNI: `WB_UNI_WEIGHTS`, `WB_UNI_LICENSE_ACCEPTED`); new experiment (frozen dataset, encoder, head, seed, threshold rule); runs with job progress, cancel and retry; run detail with provenance (seed, code revision, dependencies, manifest hash, weights hash, checkpoint), the threshold and where it was chosen, validation evaluation (confusion matrix; metrics with numerators, denominators, patient-cluster bootstrap intervals or the reason there is none; undefined values as "undefined (denominator 0…)"), calibration and coverage charts in plain SVG, subgroups with "insufficient evidence", the error gallery (false negatives first), the test split (research lead only, audited), registration as a research candidate, active-learning proposals from the training pool. If the API does not mount the ML router, the screen says "ML service not available" with the exact reason.
- **Impact:** the two contributions without outcome claims; a live ROI calculator implementing the brief's formulas exactly (`lib/roi.ts`), with every input, recurring and one-time costs broken out, scanning costed as a service by default (no scanner or digitised slides assumed), the double-counting guard for repeat labour, the realisation fraction, "capacity released is not cash", negative results shown as losses, payback only when the recurring net benefit is positive; business-model scenarios and the illustrative subscription arithmetic with its disclaimer; the valuation explanation and an optional ARR-multiple calculator that stays empty until you enter a multiple. Defaults are labelled **FICTIONAL**, and the result card carries that label too. The headline result glides to each new value (the exact figure is what screen readers and tests read), a bar shows how labour savings, avoided rework and recurring costs add up to it, and a sticky in-page menu marks the section being read.
- **Phones:** below 768 px, Slide Review shows case and status only and says why.

## Front-end design notes (2026-10-26 iteration)

This pass loaded three installed design skills and kept the brief's constraints above them: a restrained clinical tool, the tissue as the visual centre, no neon "AI dashboard" look.

- **frontend-design:** one memorable moment instead of scattered effects. The Overview opens on the real CC0 slide, and its scroll-through uses the prototype's own outputs. Numbering appears only where the content is a sequence. No new typefaces: Atkinson Hyperlegible stays, with a fluid display size for the two narrative headings.
- **premium-frontend-ui:** composited-only motion (transform and opacity), a pinned scroll narrative, fluid type, hover effects only where a pointer can hover. Not adopted, deliberately: a preloader (the page renders on the server), custom cursors and magnetic buttons (they fight precise pointing in the slide viewer), smooth-scroll hijacking (it fights the viewer's wheel zoom and reduced-motion users), glass and noise overlays (they would tint the tissue's colours).
- **gsap-framer-scroll-animation:** Motion (`motion/react`, MIT) for scroll progress (`useScroll` and `useTransform`), value tweens and in-view triggers, only on Overview and Impact, through `LazyMotion` so working screens do not load it. GSAP was not adopted (see the licence ledger). Working screens have only short CSS state transitions (dialogs, messages).
- **Reduced motion:** every animation and transition becomes an instant state change, delays included. Tested with Playwright's `reducedMotion: "reduce"`.

## Tests

```bash
cd workbench/web
npx tsc --noEmit          # type check
npm test                  # vitest: lib/roi.ts (exhaustive), streaming SHA-256, annotation geometry
npx playwright test       # browser tests against the real stack (see below)
WB_SCREENSHOTS=1 npx playwright test   # regenerates docs/screenshots/*.png at 1440×900
```

The Playwright config starts everything itself: the API (uvicorn on port **8811**) and the worker in a **fresh temporary `WB_VAR_DIR`** (seeded on start, removed afterwards), with `WB_CORS_ORIGINS` set to the test origin and 64 KiB upload chunks; then `next build` and `next start` on port **3611** with `WB_API_URL` pointing at the test API. Nothing is mocked. Ports can be changed with `E2E_API_PORT` and `E2E_WEB_PORT`.

Results on 2026-10-26 (macOS arm64, Node 24, headless Chromium 156):

| Suite | Result |
|---|---|
| `tsc --noEmit` | clean |
| vitest | 47 passed (2 files) |
| Playwright | 25 passed, 0 skipped (18 at 1440 × 900, 7 tagged journeys repeated at 1024 × 768) |

What the browser tests cover:

- **Acceptance 13:** the main journey at 1440 and 1024 (worklist → slide → a QC issue through open, reviewed, action suggested and resolved → expert label → approve → the draft dataset's slide count changes after refresh, while unique patients change only when the patient is new), and a keyboard-only run at both widths (search, `Tab` reachability, `j`/`k`, `Enter`, viewer shortcuts, the shortcut dialog, an outline and a label without a mouse, a visible focus ring).
- **Acceptance 3 (browser half):** a dragged rectangle and a clicked polygon on the CMU slide are stored at the level-0 coordinates of the mouse positions; after 90° rotation, a rectangle drawn on the rotated view, zooming, a reload, then 180° rotation and zooming out, every overlay point converted back with OpenSeadragon equals the API's stored coordinates within 0.5 level-0 pixels.
- **Acceptance 14:** `CMU-1-Small-Region.svs` opens; every tile request returns 200; the canvas is really drawn (luminance spread checked); the scale bar appears because calibration is known; synthetic slides show "SYNTHETIC — NO HISTOLOGY" and no scale bar.
- **Impact:** live update, a loss shown with "No payback", the realisation slider, the double-count guard, refused out-of-range input, the ARR arithmetic and the empty-until-entered multiple.
- **Experiments:** the PIPELINE TEST banner, metrics with denominators, false negatives first, no viewer for imageless cohort records, the test split only for the research lead, the UNI dependency state, the message for the histology assistant.
- **Upload:** pause mid-transfer, reload, resume by re-selecting the file (the server keeps the received chunks), ingest job succeeded, duplicate detection, an unsupported type refused.
- **Pages:** no console errors and no horizontal overflow at 1366, 1440 and 1024 on Overview, Worklist, Slide Review (landing, synthetic, CC0), Dataset, Experiments, a run, Impact; the phone view.
- **Frontend iteration (`iteration.spec.ts`):** the freeze dialog lists an open fold, refuses until acknowledged and given a reason (explaining itself inside the dialog), and the manifest records the reason; choosing another project on a slide page opens that project's slides at 1440 and 1024; on Slide Review a message sits over the stage and ends before the review panel; the Overview journey shows the 41 computed patches at step 4 with no console errors; with reduced motion the slide appears at once and the stage does not move.

### Measured in the browser (not targets)

Time to the first tile drawn for `CMU-1-Small-Region.svs`, production build, local API, headless Chromium at 1440 × 900 on this machine. "Viewer start" is before the signed-token request; "navigation" is from page navigation start.

| Situation | Token | Viewer open | First tile drawn (from viewer start) | First tile drawn (from navigation) |
|---|---|---|---|---|
| Fresh API process, first visit | 46 ms | 70 ms | **118 ms** | **298 ms** |
| Same process, next three visits | 18–21 ms | 37–41 ms | 70–86 ms | 160–178 ms |
| Playwright run, 1440 × 900 (slide already served earlier in the run); second visit | 14 ms; 11 ms | 44 ms; 27 ms | 78 ms; 56 ms | 173 ms; 125 ms |

The Playwright run writes its numbers to `web/test-results/viewer-metrics-*.json`. This is a 1.9 MB single-level fixture on a local loopback; a multi-gigabyte multi-level slide over a network will be slower and has not been measured in the browser.

### Whole-slide formats

Tested end to end (ingest, tiles, viewer, annotations): **Aperio SVS** only, with `CMU-1-Small-Region.svs` (single level). JPEG and PNG are imported as camera field images, never as whole slides.

Not tested, so not advertised: multi-level SVS in the browser (`CMU-1.svs` is fetched by `scripts/fetch-fixtures.sh` but not exercised by the UI tests), Hamamatsu NDPI, VMS and VMU, Leica SCN, 3DHISTECH MIRAX (MRXS), Philips TIFF, Ventana BIF, generic tiled TIFF, Sakura SVSLIDE, DICOM WSI, and formats OpenSlide does not read (for example Olympus VSI and Zeiss CZI).

## Real limitations

- **Authentication does not exist.** Demo mode only: a role switch. Secured mode (OIDC) is not implemented and the API fails closed in any other mode.
- **No real data.** Real-data uploads are refused unless `WB_ALLOW_REAL_DATA` is set, and even then no data agreement, de-identification or secured deployment exists. An attestation checkbox is not de-identification.
- **No model is trained on pathology.** Every experiment uses `synthetic-deterministic-v1` (hash-seeded embeddings with an injected class signal) and is labelled PIPELINE TEST — NOT PATHOLOGY VALIDATION. UNI needs legally obtained local weights; ResNet-18 needs `torchvision` and weights; neither is present.
- **The demo model suggestions are fixtures,** marked "DEMO FIXTURE SUGGESTION: NOT produced by a trained model".
- **Rotation is in 90° steps.** Arbitrary angles would make dragged rectangles into polygons (the API supports that); the UI does not offer free rotation.
- **Editing an outline means redrawing it** (with a reason, as a new version). There is no vertex dragging.
- **Resuming after a reload needs the same file selected again:** browsers do not let a page reopen a file by itself. The server matches it by SHA-256, size and user.
- **The keyboard can draw only a rectangle** (the view centre); polygons need a pointer.
- **Viewer:** OpenSeadragon's canvas drawer is used (not WebGL) so tests can read the drawn pixels. Signed tile tokens last 10 minutes and are refreshed by the open viewer.
- **Phones get status review only.** Tablets work; the slide review layout was checked at 1024 px.
- **The dataset draft does not update itself:** after approvals, a research lead presses **Refresh eligibility** (a recorded action).
- **Infrastructure:** SQLite and local object storage by default; PostgreSQL, S3 and `docker-compose.yml` are unverified here (no Docker daemon). The compose `web` service now builds `web/Dockerfile` with `WB_API_URL=http://api:8000` as a build argument and serves port 3600. Like the rest of the compose stack, it has **not been run** (no Docker daemon here).
- **Accessibility** was built to WCAG AA (contrast checked for every token pair, landmarks, labelled controls, visible focus, keyboard reachability, reduced motion) and tested with keyboard automation, not with a screen reader or by users with disabilities.
- **Fonts:** Atkinson Hyperlegible Next and Mono (SIL OFL 1.1), self-hosted from `web/app/fonts`; add the OFL text before any redistribution.
