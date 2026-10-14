# Pilot Proposal: Histology Lab OS

**Histology Redesigned: a measured way to decide what to configure, what to buy, and what (if anything) to build**

| | |
|---|---|
| Prepared by | Jorge Rodriguez, histology assistant |
| For | Director of Operations and Medical Director |
| Date | 2026-10-14 |
| Status | Draft for discussion. A proposal only. |

> **Read this first.**
> - No director, physician, laboratory or vendor has endorsed, approved, funded, purchased or partnered on this work. Nothing here asks for system access or a purchase.
> - The demonstration runs on a local computer with **synthetic (made-up) data only**: a fictional lab ("Lumen Bay Dermatopathology Laboratory"), fictional offices, staff, doctors and patients. It has never been connected to EMA, used with patient data, or installed on a lab workstation.
> - Every outside connection in the demo (source system, office notifications, label printer, AI model) is **simulated** and labeled that way on screen.
> - The demo shows how a workflow *could* behave. It does **not** prove clinical performance, integration with EMA, time savings or cost savings. Those can only be measured locally, with the lab's agreement.

---

## 1. Summary

**What I have observed.** At several handoffs, information about each specimen is re-copied by hand (stickers, memory, a printed daily report, retyping), and questions to offices wait without a clear owner or follow-up. These are my observations as an employee, not measured rates.

**What I propose.** Treat each burden as a separate gap and check, in this order:

1. Can a **current EMA capability** be configured or used differently to close it?
2. Does an **existing specialist product category** already address it?
3. Only for gaps that remain: would a **targeted companion** (Histology Lab OS) help, as a coordination layer next to EMA, never instead of it?

**What I am asking for now.** Permission to (a) observe and measure a few representative workflow cycles, with staff agreement, and (b) review the five-minute synthetic demonstration with a small group of users. Section 14 lists exactly what is and is not being requested.

---

## 2. Workflow burdens I have observed

These come from about four months as a histology assistant at our lab, plus earlier work in, or observation of, Quest Diagnostics and the University of Miami UHealth pathology environment. **They are employee observations, not audited findings, baseline rates, or proof that any vendor product lacks a feature.** Each one is a hypothesis for the baseline (Sections 5 and 6) to confirm, size, or reject. Observation IDs (O1–O12) match `product-brief.md`.

| ID | What I observed (our lab unless stated) | Why it may matter | Still unknown |
|---|---|---|---|
| O2 | Three accessioners remember which submitting office routes to which of three dermatopathologists. | No written rule or effective date is visible at the bench; risk rises when someone is new or covering. | Whether an approved mapping and coverage rule exists; whether EMA can store or apply it. |
| O3 | Accessioning compares patient information, bottle, biopsy site and requisition/order. Questions arise about shave vs punch, orientation, marks, laterality and exact site. | Each question becomes a clarification and a held specimen. | How often, from which offices, in which categories. |
| O4 | Offices sometimes enter parts A and B as separate orders ("two patients"). Correction after accession assignment is difficult. | Extra reconciliation; risk of a split case. | Whether the cause is separate orders, encounters, accession records or duplicate patient records. |
| O5 | Clarification messages through EMA can get delayed responses. | Held work waits; follow-up depends on memory. | Whether notifications are unsupported, disabled, ignored or reaching the wrong person. |
| O6 | Case-number stickers go on paper requisitions for doctors; cassettes/blocks are marked by hand with case numbers. | Identifiers are copied by hand. | The exact object marked and the sequence (to confirm locally). |
| O7 | The grosser completes requisitions; I then type gross descriptions into EMA in a batch. Waiting for the batch can keep me until about 9 p.m. | Transcription time, waiting time and a late handoff. | Which constraint dominates: physical grossing, documentation, transcription, staffing or processing cutoffs. Each must be measured separately. |
| O8 | More than 300 slide labels may be printed and applied by hand each day. Extra slides or missing part labels need separate printing. PAS cases are separated by hand. | Handling time and label mix-up opportunities. | What printers and label materials exist. (A label count is not a case count.) |
| O9 | A printed daily report ("the bible") lists cases by doctor, with colored pages per doctor and a separate yellow PAS table. Technicians depend on it. | A paper snapshot goes stale as work changes, and changes are not highlighted. | Which parts are a record requirement and which are only a handoff aid. |
| O10 | Block and slide storage and retrieval involve a lot of manual number checking. | Search time; missing-material investigations. | The addressing scheme and how checkouts and send-outs are recorded. |
| O11 | *Quest (observed):* hourly report-driven additional-work orders, manual retrieval of sometimes more than 100 blocks, long block searches, repeated scanning of slides and requisitions while assembling trays. | Shows retrieval and tray assembly can become a large burden at volume. | Whether this applies here. "Crystal Reports" is a reporting tool and says nothing about the underlying LIS. |
| O12 | *UHealth (observed):* spoken grossing communication with exact dimensions and piece counts. | Hands-free capture may suit a grossing bench. | Identity linkage, verification, accuracy, integration and timing questions; whether voice is permitted here. |

### Published context (with limits)

- **[R6]** A 2016 single-center improvement series reported labeling errors falling from 1.03% to 0.28% after a barcode-enabled LIS intervention, then to 0.22% after further workflow changes; manual slide printing and microtomy were major error sources. *A historical result elsewhere, not a promised effect.*
- **[R7]** A University of Florida before/after study found fewer wrong-tissue-in-block incidents after barcode confirmation was reinforced with a workflow hard stop. *A barcode feature without an enforced process is not enough.*
- **[R8]** A biopsy grossing study found voice recognition had negligible effect on the prosector's specimen time while reducing transcription needs. *Source capture is worth exploring; it does not automatically speed grossing or prevent every error.*
- **[R9]** Observational work at UPMC documented manual work and communication burdens and stressed integration with the pathology information system. *Observe the real work before choosing screens.*
- **[R5]** The CAP/NSH practical specimen-handling guide (version 12.0, March 2025) covers identification, discrepancy handling, traceability and validation of barcode materials and equipment. *Guidance to review with lab leadership, not an exhaustive accreditation checklist.*

Figures above are as summarized in the project brief (research checked 2026-10-14). They should be re-read in the original papers before being quoted outside this discussion.

---

## 3. The specific demonstration (5 minutes, synthetic)

The guided demo lives at `/demo` in the local app. It also includes a before/proposed-after workflow map and short speaker notes. Demo day: **Wednesday 2026-10-14**, Eastern time, demo clock starting about **10:52**, courier about **11:00**. The seeded day has about 60 cases and more than 300 synthetic slides; these numbers are illustrative and do not model our case mix.

| Step | What you see | Burden addressed | What it does *not* show |
|---|---|---|---|
| 1. Courier arrival | Expected vs received containers. Known offices are routed by an approved, versioned rule (rule set v3, effective 2026-09-01). A new office with no rule (Seagrape Skin Studio) becomes a **routing exception**, never a guessed doctor. | O2, O3 | Real courier manifests; whether EMA can already do this. |
| 2. Two orders, one patient | Synthetic patient Avery Quinlan (Harbor Point Dermatology; ordering clinician Dr. Hannah Cole; assigned dermatopathologist Dr. Elena Marsh). Part A (ORD-77120, left upper back, shave) and Part B (ORD-77121, punch) arrive as separate orders from the same encounter. The system **proposes** a related-order candidate with its reasons; both source records are kept; a staff reviewer decides. Nothing is merged. | O4 | What EMA actually creates in this situation. |
| 3. Site mismatch | Part B's order says **right** dorsal forearm; the bottle label says **left** dorsal forearm. A targeted clarification (CLR-0457) is created and **only Part B** is held. A simulated office answer is reviewed by lab staff before the task is resolved. | O3, O5 | Real office behavior or real notification delivery. |
| 4. Official accession | The simulated source system issues accession D26-04817. The provisional intake ID (INT-1014-031) looks visibly different. The case view shows A and B, blocks, source documents, tasks and history. | O4, O6 | Any live EMA accession or correction. |
| 5. Incremental grossing | Grosser Dana Whitfield completes a reviewed record for Part A. Downstream tasks appear immediately (source-system entry for Sam Ortiz; cassette A1 eligible for processing) and the doctor/PAS worklist updates. Part B stays visibly incomplete. | O7, O9 | Writing to EMA; whether local policy allows incremental entry. |
| 6. Materials | Tray TRY-M-03 is missing an expected slide and cannot be marked complete. Print job PJ-8841 timed out and shows **unknown outcome**, which must be reconciled before any reprint. | O8 | Real printer status reporting; label durability or scanner validation. |
| 7. Retrieval | Request RR-0192 shows the block's **last confirmed** slot and checkout history. Scanning the wrong block is rejected. | O10, O11 | Continuous real-time location tracking. |
| 8. Operations view | What is blocked, who owns the next step, and the underlying evidence. Demo numbers are labeled separately from real-world outcomes. | All | Any measured result. |

---

## 4. Three choices, compared

The three options are not mutually exclusive. The recommended order is to **configure first, integrate second, build last**, and to decide gap by gap.

### Option 1: Configure current EMA capabilities

ModMed advertises pathology gross defaults, configurable stains, reporting/tracking, multiple accession sequences and slide/cassette label printing "in many cases" [R1]. We do not yet know what our lab licenses, has enabled, or uses.

- **Pros:** Stays inside the authoritative system; no second place to enter data; no new interface; staff already know the system; may be the lowest-risk change. Direct structured gross entry inside EMA may be a better first step than a second grossing editor.
- **Cons:** Limited to what the product supports and what our license includes; may not address cross-office coordination (clarification ownership, courier reconciliation) or physical handoffs.
- **Unknowns:** Licensed modules and version; whether worklists by doctor/PAS, routing by office, label printing and gross templates are available here; who can change configuration; change-control process; fees.
- **Cost items (require ModMed quotes or internal estimates):** additional modules or licenses, configuration/professional services, training, staff time to test changes.

### Option 2: Integrate an existing specialist product

Vendor descriptions (not independent evidence, and not confirmed to work with our lab):

| Category | Example vendor description |
|---|---|
| Specimen identification, on-demand printing, tracking and workflow dashboards | Leica CEREBRO [R10] |
| Integrated grossing documentation | Milestone MacroPATH [R11] |
| Direct slide printing | Epredia slide printers [R12] |

- **Pros:** Mature products with vendor support; may include validated hardware and materials; other labs' experience can be checked.
- **Cons:** Requires purchase, interfaces with EMA, local validation and training; may solve more (or less) than our specific gaps; adds another vendor relationship.
- **Unknowns:** Interoperability with our EMA tenant; which features fit a dermatopathology lab of our size; hardware and consumable requirements; implementation time.
- **Cost items (require vendor quotes):** software license/subscription, hardware (printers, scanners, workstations), consumables (labels, ribbons, compatible slides/cassettes), interface work (vendor, ModMed and internal IT), validation, training, maintenance/support contracts.

### Option 3: Build a targeted companion for unresolved gaps

Histology Lab OS as a coordination layer: courier reconciliation, versioned routing rules, clarification tasks with owners and follow-up, a live doctor/PAS worklist, incremental grossing handoff, print reconciliation and retrieval history. EMA stays authoritative for accessions, orders, gross reports and diagnostic reports.

- **Pros:** Aimed at the specific cross-office and bench handoffs we observe; can sit next to whatever Options 1 and 2 provide; behavior can be shown with synthetic data before anyone commits.
- **Cons:** Someone must build, support, secure, host, validate and maintain it. The current prototype was built for demonstration and is not production software. It risks becoming a second system if the interface is weak. Real value depends on data access from EMA that is not yet confirmed.
- **Unknowns:** What EMA interfaces can actually expose and accept (see `discovery-checklist.md`, group 5); hosting and security requirements; who would own support.
- **Cost items (require quotes or internal estimates):** professional development and support, hosting, security review, interface/API access (any ModMed fees or approvals), hardware if scanning/printing is added, validation, training, ongoing maintenance.

### Gap-by-gap view (to be filled in after discovery)

| Gap | First check in EMA (Option 1) | Specialist category (Option 2) | Companion role (Option 3), only if still unresolved |
|---|---|---|---|
| Routing held in memory (O2) | Can EMA store or auto-assign the doctor by office? | Workflow management | Versioned rule table with effective dates and exceptions |
| A/B separate orders (O4) | Office order-entry setup; supported correction path | Not typical | Related-order candidate review (never merges) |
| Clarification delays (O3, O5) | Message notification settings and routing | Not typical | Owned clarification tasks with follow-up and review |
| "The bible" (O9) | Existing worklists/reports [R1] | Workflow dashboards [R10] | Live doctor/PAS worklist with change highlights |
| Gross transcription batch (O7) | Gross templates/defaults, bench entry [R1] | Grossing documentation [R11]; voice [R8] | Reviewed per-part handoff that triggers EMA entry |
| Slide labels (O8) | Label printing [R1] | On-demand/direct printing [R10, R12] | Print-job reconciliation linked to authorized work |
| Block retrieval (O10, O11) | Any storage/tracking features | Tracking [R10] | Last-confirmed location, checkout history, pick lists |

### Cost summary

**No prices are given in this proposal. Every cost below requires a vendor quote or an internal estimate.**

| Cost item | Option 1 | Option 2 | Option 3 |
|---|---|---|---|
| Software license / subscription | ModMed quote (if not already licensed) | Vendor quote | Not applicable for a license; development cost instead |
| Configuration / implementation services | ModMed quote | Vendor quote | Developer estimate |
| Interface / integration work | Possibly none | Vendor + ModMed + IT | ModMed (API/interface access and approvals) + IT |
| Hardware (printers, scanners, workstations, headsets) | Quote if needed | Vendor quote | Quote if needed |
| Consumables (labels, ribbons, compatible slides/cassettes) | Quote if changed | Vendor quote | Quote if changed |
| Local validation (staff time, materials) | Internal estimate | Internal estimate | Internal estimate |
| Training (including backfill time) | Internal + ModMed | Internal + vendor | Internal |
| Maintenance and support | Existing contract? | Vendor contract | Developer/IT support: must be owned by someone |
| Hosting and security review | Existing | Vendor/IT | IT + privacy/security |

---

## 5. Evaluation sequence (subject to lab agreement)

Each stage has a gate. Nothing moves forward without the named owners agreeing. Durations are for the lab to set.

| Stage | What happens | Who is involved | Output | Gate to next stage |
|---|---|---|---|---|
| 1. Observe | Watch representative arrival-to-handoff cycles with accessioners, grosser, technicians and (if agreed) office staff. Review current EMA configuration and equipment with the ModMed account team. | Director of Operations, staff who agree to take part, ModMed specialist | Corrected workflow map; answered discovery checklist | Leadership agrees which gaps are real and worth measuring |
| 2. Baseline | Collect the metrics in Section 6 over representative working days (different weekdays, normal courier patterns). Record actual volume, case mix and missing data. | Agreed observer(s); supervisor | Baseline report with medians, tails, open items and missing-data counts | Baseline judged representative; Option 1 changes tried or ruled out first |
| 3. Synthetic demo review | Users walk through the demo and correct its workflow assumptions. | Accessioner, grosser, histotech, supervisor, directors | List of wrong assumptions and fixes | Users judge the concept worth a shadow test for a specific gap |
| 4. Time-limited, approved shadow comparison | One office, team or station. Uses approved data access only (Rollout Mode B). EMA stays authoritative. Avoid permanent double entry; measure the burden the pilot itself creates. | Clinical, IT, privacy/security and operational owners | Comparison against baseline, including balancing measures | Data agreement, usable exception handling, practical staff feedback |
| 5. Expand only if justified | Any expansion is a new decision with its own approval and rollback plan. | Same owners | Decision record | n/a |

A documented rollback/downtime method (Section 12) applies from stage 4 onward and is rehearsed before stage 4 starts.

---

## 6. Metrics

### 6.1 Rules that apply to every metric

- **Same method before and after.** Baseline and pilot periods use the same definitions, observers and data sources.
- **Median plus a tail.** Report the median (the middle value) and the 90th percentile (the value 9 in 10 items beat). Proposed convention, for the lab to agree: report the 90th percentile only when a group has at least 30 completed observations; below that, report the count, median and range.
- **Still-open items are shown separately.** Items not finished by the end of the measurement window have no final time. They are listed separately (count and current age) so unfinished work does not disappear and make results look faster than they are.
- **Missing events are reported, never treated as fast.** If a start or end time is missing, the item is excluded from the timing statistics and counted in a "missing" line (number and percent). It is never recorded as zero.
- **No staff rankings.** Results are reported by team, role, station or office category, not as individual rankings from raw counts. Individual data is used only with that person's agreement.
- **No patient identifiers in observation notes.** Observers record times and categories, not names, MRNs or accession numbers, unless an approved data process allows it.
- **Hands-on time vs elapsed time.** *Hands-on* means minutes someone is actively working. *Elapsed* means clock time, including waiting. They are reported separately.
- **Time zone.** Times recorded in Eastern time; note any daylight-saving change in the window.
- **Context.** Each report states the window, number of working days, total volume and anything unusual (staff absence, equipment failure, holiday).

### 6.2 Metric definitions

#### M1. Hands-on accession minutes per case

| Item | Definition |
|---|---|
| Numerator | Sum of observed hands-on minutes spent accessioning the sampled cases (comparing patient information, bottle, site and requisition/order; creating the accession; stickering; labeling). |
| Denominator | Number of cases accessioned in the sample. Also reported per part/container, because multipart cases take longer. |
| Start event | Accessioner picks up the first container or requisition for the case. |
| End event | Accession saved in EMA and the case's materials passed to the next station (exact end point agreed locally). |
| Exclusions | Time the case sits untouched; clarification follow-up after the case is set aside (counted in M2/M3); training sessions. Interruptions are recorded and subtracted, and their count reported. |
| Data source | Direct timed observation on agreed days. EMA timestamps only if shown to match these events. |
| Summary | Median and 90th percentile minutes per case; split by number of parts, office, source EHR, and discrepancy found yes/no. |
| Still-open items | Cases started but not finished in the observed session, listed with elapsed-so-far time. |
| Missing events | Excluded from timing; counted and reported. |

#### M2. Clarification acknowledgement time

| Item | Definition |
|---|---|
| Numerator | For each clarification, elapsed time from sent to first acknowledgement. |
| Denominator | Clarifications sent to offices in the window. |
| Start event | Clarification sent to the office (time recorded in the channel used). |
| End event | First acknowledgement from a responsible person at the office (a reply or a logged call). A "delivered" or "read" indicator is recorded but does not count as acknowledgement unless the lab agrees it should. |
| Exclusions | Questions resolved internally without contacting the office (counted separately); messages canceled before sending; test messages. |
| Data source | Baseline: EMA message history if authorized staff can view or export it (unknown), otherwise a manual clarification log. Shadow: companion record checked against the source channel. |
| Summary | Median and 90th percentile, in clock hours and in office business hours; by office and category (site, laterality, procedure, orientation/marking, identity, missing container, related orders). Office results are for collaboration, not blame. |
| Still-open items | Unacknowledged at window end: count and current age. |
| Missing events | Unknown sent time: excluded from timing; counted. |

#### M3. Clarification resolution time

| Item | Definition |
|---|---|
| Numerator | For each clarification, elapsed time from discovery to reviewed resolution. Also reported in parts: discovered to sent, sent to answered, answered to resolved. |
| Denominator | Clarifications resolved in the window. |
| Start event | Discrepancy first recorded by the lab. |
| End event | A lab reviewer records the resolution. **An answer arriving is not a resolution.** |
| Exclusions | Duplicate tasks for the same discrepancy (merged in counting, with the duplicate count reported). |
| Data source | As M2. |
| Summary | Median and 90th percentile; by office and category; held-material count per clarification. |
| Still-open items | Unresolved at window end: count, age and current owner role. |
| Missing events | Excluded from timing; counted. |

#### M4. Grossing-completion-to-approved-entry delay

| Item | Definition |
|---|---|
| Numerator | For each part, elapsed minutes from gross description completed to approved entry in EMA. |
| Denominator | Parts grossed in the window. |
| Start event | Grosser finishes the gross description for the part (time noted on the worksheet during baseline, by agreement with the grosser). |
| End event | Gross description entered and saved/approved in EMA according to the local approval rule. |
| Exclusions | Canceled parts. Parts entered directly by the grosser are a separate group, not excluded. |
| Data source | Worksheet completion time plus EMA entry time (from EMA history if available to authorized staff) or observer log. |
| Summary | Median and 90th percentile; time of day entries are completed; parts still waiting for entry at agreed checkpoints (for example 17:00, 19:00, 21:00). |
| Still-open items | Parts grossed but not entered by end of day: count and age, carried into the next day. |
| Missing events | Excluded from timing; counted. |

To find the real constraint, these are measured **separately** alongside M4: hands-on grossing time, transcription time (M6), verification time, batch waiting time, and (only in Mode D) integration lag.

#### M5. Unresolved work age (snapshot)

| Item | Definition |
|---|---|
| Numerator | Age of each open work item at the snapshot time (snapshot time minus creation time). |
| Denominator | Open work items at the snapshot: clarifications, holds, gross entries pending, print jobs with unknown outcome, unverified trays, open retrieval requests, open work orders. |
| Start event | Item created (first recorded). |
| End event | The snapshot time (this is a point-in-time measure, not a completion time). |
| Exclusions | Items deliberately parked under a documented policy, listed separately with the reason. |
| Data source | Baseline: manual count from logs and paper at agreed snapshot times. Shadow: companion queues checked against the source. |
| Summary | Count, median age, 90th percentile age and oldest item; by item type and owning role. |
| Still-open items | All items here are open by definition. |
| Missing events | Unknown creation time goes in an "age unknown" group, never counted as age zero. |

#### M6. Manual transcription time

| Item | Definition |
|---|---|
| Numerator | Hands-on minutes spent re-typing information that already exists in written or electronic form (for example, gross descriptions from worksheets into EMA). |
| Denominator | Parts transcribed; also total per working day. |
| Start event | Staff member begins typing a part's text. |
| End event | Entry saved. |
| Exclusions | First-time capture of information that exists nowhere else; proofreading/verification (recorded as verification time). |
| Data source | Timed observation; self-logging only with the person's agreement. |
| Summary | Median and 90th percentile minutes per part; median and 90th percentile total minutes per day; transcription discrepancies found per 100 parts (with the denominator shown). |
| Still-open items | Parts waiting for transcription at end of day (also appear in M4 and M5). |
| Missing events | Excluded from timing; counted. |

#### M7. Correction and reprint counts

| Item | Definition |
|---|---|
| Numerator | Counts by type: (a) label reprints by reason (damaged, print failure, missing, wrong content); (b) record corrections by type (identity, site/laterality, part designation, routing, accession-related). |
| Denominator | (a) labels printed; (b) cases accessioned. Expressed per 1,000 labels and per 100 cases. |
| Start event | Event date, plus the stage where the problem was found (accessioning, grossing, embedding, sectioning, QC, sign-out). |
| End event | Correction or reprint completed. |
| Exclusions | Additional slides ordered as new work (counted separately; **not** a reprint); test prints. |
| Data source | Printer or LIS logs if available to authorized staff; a manual tally sheet; records from the lab's authorized correction process. |
| Summary | Counts and rates per week, always with denominators. No median. Small counts are shown as raw numbers with no trend claims. |
| Still-open items | Corrections started but not completed, listed. |
| Missing events | "Reason not recorded" is its own category. |

#### M8. Requisition pages

| Item | Definition |
|---|---|
| Numerator | Paper pages printed or handled for operational handoff per day (requisitions, stickered copies, "the bible", PAS table, pick lists, reprints), by document type. |
| Denominator | Working days; also cases accessioned that day (pages per case). |
| Start event | Start of the agreed working day. |
| End event | End of the agreed working day. |
| Exclusions | None excluded. Each document type is classified as record requirement, handoff aid, or unknown (from discovery item 11.1). |
| Data source | Printer page counters if available to authorized staff; otherwise a manual count by document type on sampled days. |
| Summary | Median and 90th percentile pages per day; pages per case; by document type and classification. |
| Still-open items | Not applicable. |
| Missing events | Days not counted are listed, never estimated. |

#### M9. Slide-label handling time

| Item | Definition |
|---|---|
| Numerator | Hands-on minutes printing, collecting, sorting, matching, applying and checking slide labels, including separate prints for extra slides or missing part labels. |
| Denominator | Slide labels applied (reported per 100 labels); also per day. |
| Start event | Staff member starts a label batch (sends it to print or collects printed labels). |
| End event | Last label in the batch applied and checked against its block. |
| Exclusions | Sectioning and staining work itself; cassette labeling (measured separately if relevant). |
| Data source | Timed observation of sampled batches; label counts from printer logs or manual counts. |
| Summary | Median and 90th percentile minutes per 100 labels across batches; number of separate-print events per day. |
| Still-open items | Interrupted batches recorded separately. |
| Missing events | Excluded from timing; counted. |

#### M10. Block retrieval time

| Item | Definition |
|---|---|
| Numerator | For each requested block: elapsed time, and hands-on search time. |
| Denominator | Blocks requested (also number of requests). |
| Start event | Request received by the person retrieving (elapsed time is also reported from request creation). |
| End event | Block delivered to the requesting bench and its identity checked (scan or read-back). |
| Exclusions | Blocks already at an outside send-out when requested (reported separately); canceled requests. |
| Data source | Timed observation; retrieval log. |
| Summary | Median and 90th percentile minutes per block; percent found at the first recorded location; number not found by window end. |
| Still-open items | Blocks not yet found: count, age and investigation status. |
| Missing events | Excluded from timing; counted. |

#### M11. Paid overtime (only where authorized data exists)

| Item | Definition |
|---|---|
| Numerator | Paid overtime hours for in-scope roles (accessioning, grossing support, histology). |
| Denominator | Total paid hours for the same roles (overtime percent); also per week, with case volume shown as context. |
| Start event | Start of pay period. |
| End event | End of pay period. |
| Exclusions | None silently. Known causes (absence coverage, training, volume spike, equipment failure) are recorded where management records them. |
| Data source | Aggregated payroll/timekeeping report from an authorized manager or HR, by role, not by individual (except a person's own hours with their consent). |
| Summary | Totals per pay period, compared with comparable earlier periods. Changes are not attributed to the pilot without considering staffing, volume and season. |
| Still-open items | Not applicable. |
| Missing events | If the data is not authorized, the metric is reported as "not collected," never as zero. |

### 6.3 Balancing measures (tracked alongside speed)

| Measure | What it catches |
|---|---|
| Near misses | Identification or labeling discrepancies caught before the next irreversible step, by stage and type, per 100 cases (through the lab's existing reporting process). |
| Verification burden | Minutes per case spent on checks the companion adds (for example, "verified against physical container" and reconciliation steps). |
| Pilot overhead / double entry | Minutes per day spent entering or reconciling data in both systems. |
| Unintended delays | Items handed off later than under the usual process because of the pilot (count and minutes). |
| Notification volume | Notifications per clarification, duplicates suppressed, and staff or office reports of noise. |
| Data agreement | Percent of companion records matching EMA on agreed fields; mismatches by type. |
| Staff feedback | Short structured questions at the end of each pilot week. |

---

## 7. Counting value honestly

| Bucket | What it means | Measured by | Is it cash? |
|---|---|---|---|
| Labor time saved | Hands-on staff minutes no longer needed per unit of work, after subtracting added verification and admin | M1, M6, M9, M10 (hands-on), net of balancing measures | Not by itself |
| Elapsed waiting time reduced | Clock time items spend waiting between steps | M2–M5, M10 (elapsed) | No. It improves flow and turnaround, not payroll |
| Recovered capacity | Saved labor minutes that are actually redirected to other useful work | Documented reassignment of work | Not unless spending changes |
| Actual cash savings | A real change in spending: fewer paid overtime hours, fewer consumables, an avoided contract | Finance and payroll records | Yes, by definition |

**Rules against double counting**

1. Each minute is counted in one bucket only. If saved minutes reduced paid overtime, they are counted as cash savings (overtime hours times the overtime rate) and **not** again as labor value or recovered capacity.
2. Waiting time is never multiplied by a labor rate.
3. Labor value stays "potential" until spending actually changes.
4. Added verification and admin minutes are subtracted before any value is calculated.

**Rare harm events.** A short pilot cannot show a reduction in rare patient-harm events such as a misidentified specimen; they are too infrequent to measure reliably in weeks or months. The pilot tracks near misses and process measures instead, and makes no claim of harm prevention.

---

## 8. Scenario calculator method

All inputs start **blank**. They are filled only with measured values or values the lab agrees on. This worksheet can be copied into a spreadsheet.

| Input | Symbol | Where it comes from | Value |
|---|---|---|---|
| Baseline hands-on minutes per unit (per activity: case, part, 100 labels, block) | B | Baseline (M1, M6, M9, M10) | ____ |
| Pilot hands-on minutes per unit | P | Shadow comparison | ____ |
| Added verification minutes per unit | V | Balancing measures | ____ |
| Added admin/reconciliation minutes per unit | A | Balancing measures | ____ |
| Units per working day | N | Observed volume | ____ |
| Working days per year | D | Lab calendar | ____ |
| Agreed loaded labor cost per hour | R | Finance | ____ |
| Annualized costs (all quote-required items below) | C | Quotes and internal estimates | ____ |

**Formulas**

```
Net minutes saved per unit     = B - P - V - A
Annual net hours               = (B - P - V - A) x N x D / 60
Potential annual labor value   = Annual net hours x R
Potential net annual value     = Potential annual labor value - C
```

- Calculate each activity separately, then add them up. Do not add the same minutes under two activities.
- Present a **range** (low, central, high) using the measured spread of B, P and N, and show the inputs next to every result.
- If net minutes saved is zero or negative, report that result as it is.
- "Potential labor value" is not cash savings (see Section 7).

**Illustrative arithmetic only (not data, not a prediction).** Suppose, purely to show the mechanics, B = 10, P = 8, V = 1.5 and A = 0.5 minutes. Net = 10 − 8 − 1.5 − 0.5 = **0 minutes**. A 2-minute gross improvement is fully used up by added checks and admin. This is why V and A must be measured, not assumed.

**Costs to subtract (all require vendor quotes or internal estimates; none are given here):**
vendor software or subscription fees; ModMed module, configuration or interface/API fees (if any); integration work (vendor, ModMed, internal IT); hardware (printers, scanners, workstations/tablets, headsets); consumables (label stock, ribbons, compatible slides/cassettes); local validation (staff time and materials); training (including backfill); maintenance and support (contracts, internal IT, development); hosting and security review. One-time costs are spread over an agreed number of years.

---

## 9. Deployment dependencies

Real use with patient data needs review and sign-off by the organization's responsible owners. These are dependencies, not tasks this project can complete on its own.

| Owner | Reviews |
|---|---|
| Clinical (Medical Director or designee) | Intended use; effect on specimen identification and SOPs; acceptance of local validation |
| Laboratory operations (Director of Operations, supervisors) | Workflow fit, task ownership, staffing, training, downtime procedures, agreements with submitting offices |
| IT | Hosting, identity management, interfaces, device interfaces, backup/restore, support |
| Privacy / security / compliance | Data access, contracts, auditability, risk assessment |
| Vendors (ModMed; any device vendor) | Supported interfaces, terms, sandbox, acknowledgement behavior |

| Dependency | Question to settle | State of the demo today |
|---|---|---|
| Intended use | Which decisions the tool supports; confirm it is never the record of a clinical fact | Operational coordination demo only |
| Data access | Which fields, from where, minimum necessary, who approves | Synthetic data only |
| Hosting | Where it runs, on which network, operated by whom | One local computer, local SQLite database |
| Contracts | Vendor and API terms; business associate or similar agreements where applicable | None |
| Identity management | Real accounts, single sign-on, role provisioning and removal | Demo role selector: **not authentication** |
| Auditability | Tamper-evident audit trail, retention, review | Local append-only audit table: **not proof of tamper resistance** |
| Backup / restore | How much data could be lost, and how quickly service returns | Reset command recreates demo data; no backup |
| Device interfaces | Printers, scanners, label materials, tested together | Simulated printer; on-screen DataMatrix previews only |
| Local validation | Field mapping, label scanning, workflow validation under lab SOPs and applicable guidance (for example [R5]) | Not validated |
| Downtime and rollback | Written fallback and owner (Section 12) | Print/export snapshot with generation time and version |
| Training, support, change control | Who trains, who supports, how changes are approved | Not applicable to the demo |

> **Explicit statement.** Adding a disclaimer, encryption, or role buttons does **not** make a prototype compliant, secure for clinical use, or clinically validated. Compliance and validation come only from the organization's own review, approved infrastructure, and local validation by the responsible owners.

---

## 10. Rollout modes (summary)

| Mode | What it is | Data and connectors | Prerequisites | Status |
|---|---|---|---|---|
| **A. Local demonstration** | Synthetic walkthrough | Generated data; simulated source adapter, notifications, printer and AI. No real credentials. | None beyond a local computer | **This build** |
| **B. Approved shadow evaluation** | Run alongside the normal process to compare | Selected source data through an approved export or supported interface (no assumption that EMA offers a particular CSV export). EMA remains authoritative. | Clinical, IT, privacy/security and operational approval; data agreement; hosting; rollback plan | Not started |
| **C. Small live operational pilot** | One office/team or station uses it for coordination | Validated field mapping; trained staff; clear ownership; established fallback | Successful Mode B; local validation | Not started |
| **D. Selective supported writeback or printer control** | The companion sends specific actions to EMA or printers | Only through an actual, reviewed and tested interface. Source acknowledgements are reconciled; a pending local draft is never shown as entered in EMA. | Confirmed supported write interface; testing; approvals | Not started |

---

## 11. Risks and limits of this proposal

- **Observer effect:** people may work differently while being timed. Mitigation: longer observation, same observers before and after.
- **Small samples and seasonality:** a few weeks may not represent the year. Results are reported with counts and ranges.
- **One office/team may not represent others.** Expansion is a separate decision.
- **Confounders:** staffing changes, volume swings and equipment issues can move metrics on their own.
- **Double work:** a shadow test adds burden by design; it is measured (Section 6.3) and time-limited.
- **Notification noise:** more messages can make responses slower, not faster. Faster clarification needs agreement with offices on ownership and escalation.
- **Support dependency:** a built companion needs professional engineering, security and support; it should not depend on one employee.

---

## 12. Rollback and downtime method

**Principles**

1. EMA and the lab's established procedures stay authoritative in every mode. In Modes B and C the companion is never the only place a required fact is kept.
2. The current paper fallback (including a printed worklist) is kept until the lab decides otherwise.
3. Before Mode B or C begins: a written fallback, a named owner who can stop the pilot, and a rehearsal.

**Stop triggers (agreed in advance)**

- Data mismatch with EMA above an agreed level.
- Source data stale beyond an agreed time.
- A safety concern or near miss linked to the pilot.
- Staff burden above an agreed limit.
- Loss of support, or any owner withdrawing approval.

**Stop / rollback steps**

1. The named owner announces the stop to affected staff.
2. Staff return to the established process (existing printed worklist, existing clarification channel).
3. An open-items list is exported from the companion, showing its generation time and version, and handed to the owners.
4. Each open item is confirmed in EMA or existing logs; nothing is assumed complete.
5. What happened is recorded, and the owners decide whether to resume or end.

**Downtime**

- **Source (EMA feed) outage:** the companion shows the last successful sync time and data age, and marks the worklist **stale**; it never looks "live." Staff use the printed snapshot (with generation time and version) and established procedures. After restoration, events are reconciled without duplicating tasks, and anything that changed during the outage is reviewed.
- **Companion outage:** work continues in EMA and on paper. Because the companion is not authoritative, no clinical record is lost. After restoration it re-syncs and open items are reviewed.
- **Mode D only:** rollback includes switching off writeback; any unacknowledged write is checked in EMA by a person.

---

## 13. Relationship to other documents

- `product-brief.md`: product scope and observations O1–O12.
- `director-pitch.md`: one-page spoken version of this proposal.
- `discovery-checklist.md`: questions for the Director and the ModMed account/integration team, with the demo's default assumptions.

---

## 14. Decision requested

**Requested**

1. Permission to observe and time a few representative workflow cycles, with the agreement of the staff involved and without recording patient identifiers.
2. Permission to hold a short review of the synthetic demonstration with a small group (accessioner, grosser, histotech, supervisor) and the directors.
3. Help getting answers to the discovery checklist, including a ModMed review of what is already licensed and configurable.

**Not requested**

- Any purchase, budget or procurement decision.
- Access to EMA, the lab network, patient data or payroll data.
- Installation on any lab workstation, or contact with any submitting office.
- Any endorsement or partnership.

---

## References

As listed in the project brief (research checked 2026-10-14). Re-check before citing externally. These sources do not describe our lab's configuration or authorization.

- [R1] ModMed, Pathology Lab Reporting Software. https://www.modmed.com/what-we-do/pathology/
- [R2] ModMed API Portal, Getting Started. https://portal.api.modmed.com/docs/getting-started
- [R3] ModMed, HL7 Connectivity. https://www.modmed.com/what-we-do/integrations/synapsys/hl7/
- [R4] ModMed API Portal, ServiceRequest (Orders). https://portal.api.modmed.com/reference/servicerequest-orders
- [R5] CAP/NSH, Practical Guide to Specimen Handling in Surgical Pathology, version 12.0, March 2025. https://www.cap.org/wp-content/uploads/documents/Practical_Guide_to_Specimen_Handling_in_Surgical_Pathology_2025.pdf?download=true
- [R6] Achieving High Reliability in Histology: An Improvement Series to Reduce Errors. Am J Clin Pathol, 2016, 146(5):554–560. https://academic.oup.com/ajcp/article/146/5/554/2529661
- [R7] Weaver et al., Wrong Tissue in Block. Am J Clin Pathol, 2021, 156(4):700–707. https://pubmed.ncbi.nlm.nih.gov/33940603/
- [R8] Ye, Tan and Shum, Using Timestamp Data to Assess the Impact of Voice Recognition on the Efficiency of Grossing Biopsies. Arch Pathol Lab Med, 2021, 145(5):599–606. https://pubmed.ncbi.nlm.nih.gov/32960950/
- [R9] Ho, Aridor and Parwani, Use of contextual inquiry to understand anatomic pathology workflow. J Pathol Inform, 2012, 3:35. https://pubmed.ncbi.nlm.nih.gov/23243553/
- [R10] Leica Biosystems, CEREBRO Workflow Management System. https://www.leicabiosystems.com/us/tracking-and-workflow/cerebro/
- [R11] Milestone Medical, MacroPATH. https://www.milestonemedsrl.com/products/grossing-and-macro-digital/macropath/
- [R12] Epredia, Microscope Slide Printers. https://www.epredia.com/products/histology-instruments/slide-printing
