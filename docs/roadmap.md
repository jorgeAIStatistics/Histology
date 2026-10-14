# Roadmap: Deferred Ideas

The first build covers five core flows (arrival reconciliation, routing, clarification, live doctor/PAS worklist, reviewed incremental grossing) plus small print-queue, tray and block-retrieval demonstrations. Everything below is **deliberately deferred**. Keeping these ideas here, instead of as half-working screens, keeps the demo honest.

These are **proposed discovery areas, not claims that these problems occur at the lab**. Each needs evidence from the lab before any work starts.

---

## 1. Rule for moving an idea into a build

An idea leaves this roadmap only when all of the following are true:

1. The core flow works and has been reviewed with the people who would use it.
2. The problem has been **observed and counted at the lab**, with a volume denominator (for example, "clarifications about laterality per 100 cases"), not just remembered.
3. The configure and buy/integrate options have been checked first (see `product-brief.md`, Section 5).
4. There is a named owner at the lab, and the data or interface it needs is actually available and approved.
5. There is a plan for how it would be validated and how staff fall back if it fails.

---

## 2. Summary table

| Idea | What it would do | Why deferred | Key prerequisites | Earliest sensible stage* |
|---|---|---|---|---|
| Inventory management | Track reagents, consumables, lots and expiry | Not one of the observed handoff gaps; may already exist in other systems | Inventory owner; check existing systems; agreed item list | After pilot (C) |
| Computer vision | Read labels or judge tissue/slides from images | Needs datasets, equipment and a validation project; an ordinary image cannot measure tissue | Validated cameras/scanners; labeled data; validation protocol; clinical owner | Separate project |
| Predictive staffing | Forecast workload to plan staff | Needs months of reliable event data the lab does not yet have | Baseline timestamps; authorized labor data; leadership owner | After pilot (C) |
| Whole-slide imaging (WSI) | Digital slides for review | Large equipment, storage and validation effort; not part of the observed gaps | Scanner, storage, IT and pathologist workflow decisions, validation | Separate project |
| Billing | Charges and claims | Belongs to the EHR/billing systems; not operational coordination | Billing owner; compliance review | Not planned |
| Diagnostic AI | Suggest or make diagnoses | **Excluded.** Outside scope, needs clinical validation and regulatory review | Not pursued in this project | Not planned |
| Source-office order preparation | Structured part/site capture, expected-container manifest, pre-pickup completeness check | Must not create a second order-entry form if the EHR can do this | Office EHR capabilities; office agreement; clarification-category data | Discovery during shadow (B) |
| Transport/fixation timestamps | Keep observed vs documented times; flag missing data | Clinical thresholds are a medical-director decision; times must never be invented | What is documented today; lab policy; data source | Discovery during shadow (B) |
| Processing/embedding/staining handoffs | Track expected material, batch membership, failed cycles, operator-recorded exceptions | Core flow first; instrument data access unknown | SOP review; instrument interfaces or manual capture plan | After pilot (C) |
| Special-stain batch records | Authorized orders, reagent lot/expiry, technician-reviewed controls, repeat reasons | Core PAS visibility first; record requirements must be confirmed | Stain-order source; QC policy; histotech owner | After pilot (C) |
| Office feedback | Recurring incomplete orders and clarification categories, with denominators, for joint improvement | Needs clarification data collected over time | Clarification records with categories; office agreement | After pilot (C) |
| Outside consultations and archival returns | Record material leaving the lab, recipient, expected return, reconciled receipt | Retrieval demo shows only basic send-out status | How send-outs and returns are recorded today; owner | Pilot extension (C) |

\* Stages follow the rollout modes in the master specification: **A** local demonstration, **B** approved shadow evaluation, **C** small live pilot, **D** selective supported writeback or printer control.

---

## 3. Notes on each deferred idea

### 3.1 Inventory management
- **Would do:** reagent and consumable stock, lots, expiry, reorder points.
- **Why deferred:** none of the observations (O1–O12 in `product-brief.md`) point to inventory as a main handoff gap. The lab may already track this elsewhere.
- **Prerequisites:** an inventory owner; a check of existing systems; an agreed item list. Lot/expiry capture for special stains is covered under 3.10.

### 3.2 Computer vision
- **Would do:** read bottle labels from photos, check slide labels, or assess slide quality from images.
- **Why deferred:** reliable results need controlled cameras or scanners, a labeled dataset and a validation project. A barcode or OCR read identifies a record; it does not establish what tissue is inside the bottle. The demo never claims to measure tissue from an ordinary image.
- **Prerequisites:** approved equipment, a dataset, a validation protocol and a clinical owner.

### 3.3 Predictive staffing
- **Would do:** forecast arrivals and workload to plan staffing.
- **Why deferred:** forecasts are only as good as the event history behind them, and the lab has no baseline yet. Raw counts must not become staff performance rankings.
- **Prerequisites:** a measured baseline over representative days; authorized labor data; a leadership owner; a decision on how forecasts would be used.

### 3.4 Whole-slide imaging (WSI)
- **Would do:** scan glass slides for digital review.
- **Why deferred:** large equipment, storage, IT and validation commitments, and it changes pathologist workflow. It does not address the observed handoff gaps.
- **Prerequisites:** a separate business case, scanner and storage decisions, pathologist involvement, validation.

### 3.5 Billing
- **Why deferred:** billing belongs to the EHR and billing systems and has its own compliance requirements. Operational coordination should not touch charges.
- **Status:** not planned.

### 3.6 Diagnostic AI
- **Status:** excluded. This project has **no** autonomous diagnosis, stain ordering, specimen matching decisions, accession correction or report release, and it never decides PAS eligibility from diagnosis text. See `ai-assistants.md`.

### 3.7 Source-office order preparation
- **Would do:** help offices capture each part and site in a structured way, send an expected-container manifest, and run a completeness check before pickup.
- **Why deferred:** the right fix may be inside the offices' existing EHR (order templates, required fields). A second order-entry form would add double entry.
- **Prerequisites:** know which EHRs and tenants the offices use; clarification data by category and office; agreement with office managers.

### 3.8 Transport and fixation timestamps
- **Would do:** keep **observed** times (for example, scanned at arrival) separate from **documented** times (for example, collection time written on an order), and flag missing data.
- **Why deferred:** acceptability thresholds are clinical decisions for the medical director, not software defaults. The system must never invent collection or fixation times.
- **Prerequisites:** what the orders and requisitions document today; a lab policy; a reliable source for each time.

### 3.9 Processing, embedding and staining handoffs
- **Would do:** track expected material through each station, batch membership, failed equipment cycles and exceptions recorded by operators.
- **Why deferred:** core flow first, and instrument data access is unknown. A software event alone cannot establish tissue or stain quality.
- **Prerequisites:** SOP review with histotechs; instrument interfaces or a manual capture plan; agreement on which stages to track.

### 3.10 Special-stain batch records
- **Would do:** link authorized stain orders to batches, reagent lot and expiry, technician-reviewed controls and repeat reasons.
- **Why deferred:** the first build already makes PAS visible with its originating order. Batch records must match the lab's actual record requirements. Image-based slide QC would be a separate dataset, equipment and validation project.
- **Prerequisites:** confirmed stain-order source and material level; QC policy; histotech owner.

### 3.11 Office feedback
- **Would do:** show recurring incomplete orders and clarification categories per office, with volume denominators, so the lab and offices can improve training and templates together.
- **Why deferred:** needs months of clarification records first. It must be collaborative, not a ranking of offices or staff.
- **Prerequisites:** clarification records with consistent categories; office agreement on how results are shared.

### 3.12 Outside consultations and archival returns
- **Would do:** record material leaving the lab (recipient, date, expected return) and reconcile receipt when it comes back.
- **Why deferred:** the retrieval demo shows only basic send-out and overdue status. A full workflow needs to match how the lab records send-outs today.
- **Prerequisites:** current send-out and return records; an owner; agreement on required fields.

---

## 4. Integration and deployment items (not features, but required before real use)

These are not product ideas; they are dependencies for any real deployment, owned by the organization's clinical, IT, privacy/security and operations leaders.

| Item | Why it is not in the demo | Prerequisite |
|---|---|---|
| Reading real EMA data | No access, and no confirmed interface for internal histology data | Confirmed, approved interface; ModMed review process [R2]; data agreement |
| Writing back to EMA | Only after the actual interface and workflow are reviewed and tested (stage D). Until then staff enter gross text in EMA by hand and the companion records a staff attestation, which is never shown as a source acknowledgment | Supported write interface; acknowledgement handling; validation |
| Real printer control | Printer capabilities unknown; materials must be validated | Inventory of printers/drivers; vendor support; local validation |
| Real office notifications | Must not contact real offices; notifications should carry no patient information by default | Approved channel; office agreement on ownership and escalation |
| Microphone / voice capture at the grossing bench | Optional; needs an approved provider and identity linkage | Approved provider; privacy review; bench testing |
| Hardware-supported batch tray verification | The demo verifies slide by slide on purpose | Validated hardware and procedure |
| Production login, hosting, backup, audit | A demo role selector is not authentication; a local audit log is not proof of tamper resistance | Organization's identity management, hosting, backup/restore and security review |
| Real AI model | Demo uses a deterministic, labeled extractor and drafter, and computed (not AI) summaries | Approved provider; privacy/security review before any non-synthetic data |
| Real office notification channel and contact directory | The demo directory (Settings → Office contacts) is fictional and every send is simulated | Office agreement on contacts, coverage and escalation; approved channel |

Reference: **[R2]** ModMed API Portal, Getting Started (proprietary vs certified API, sandbox and production review). https://portal.api.modmed.com/docs/getting-started
