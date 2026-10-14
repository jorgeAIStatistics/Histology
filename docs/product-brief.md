# Histology Lab OS: Product Brief

**Histology Redesigned**

| | |
|---|---|
| Author | Jorge Rodriguez, histology assistant |
| Date | 2026-10-14 |
| Status | Draft for discussion. Local demonstration with synthetic (made-up) data only. |
| Intended readers | The lab's Director of Operations and medical director, to evaluate the idea |

> **Read this first.** This document describes a local demonstration and a proposal. No laboratory, director, physician or vendor has endorsed, approved, purchased, funded or partnered on it. It has not been connected to any real system, used with real patient data, installed on a lab workstation or used in patient care. Every person, office, patient and identifier in the demonstration is fictional.

---

## 1. Summary

Histology Lab OS is a **companion** to the lab's existing EHR/LIS (EMA by ModMed). It does not replace EMA. It coordinates the work that happens *between* people and systems from the moment the courier arrives until slides and blocks are handed off or retrieved:

- reconciling what arrived against what was ordered, before accessioning;
- suggesting the assigned dermatopathologist from approved, written routing rules;
- tracking each office clarification until a person reviews the answer and closes it;
- replacing the *information function* of the printed daily report ("the bible") with a live doctor/PAS worklist;
- letting a reviewed gross record for one part move downstream as soon as it is ready, instead of waiting for the whole day's batch.

Official accession numbers, clinical orders, approved gross reports and diagnostic reports **stay in EMA**.

---

## 2. Problem statement

### 2.1 What Jorge has observed

These are **employee observations** from about four months as a histology assistant at a dermatology laboratory, plus earlier work in or observation of Quest Diagnostics and the University of Miami UHealth pathology environment. They are **not** audited findings, measured baseline rates, or proof that any vendor product lacks a feature.

| # | Observation | Setting | Still unknown |
|---|---|---|---|
| O1 | Couriers usually arrive around 11 a.m. with specimens from several dermatology offices. | Current lab | Whether any list of expected containers (a manifest) exists. |
| O2 | Three accessioners remember which submitting office routes to which of three dermatopathologists. The submitting clinician and the assigned dermatopathologist are different people. | Current lab | Whether a written, approved mapping and coverage rule exists. |
| O3 | Accessioning in EMA compares patient information, specimen bottle, biopsy site and requisition/order. Questions come up about shave vs punch, orientation, marks, laterality and exact site. | Current lab | How often, from which offices, in which categories. |
| O4 | Offices sometimes enter parts A and B as separate orders, so they appear separately ("two patients"). Once an accession number is assigned, correction is difficult. | Current lab | Whether the cause is separate orders, separate encounters, separate accession records or duplicate patient records. |
| O5 | Clarification messages sent through EMA can receive delayed responses. | Current lab | Whether notifications are unsupported, turned off, ignored or sent to the wrong person. |
| O6 | Staff put case-number stickers on paper requisitions for doctors. Cassettes/blocks are marked by hand with case numbers. | Current lab | The exact object marked and the exact sequence (to be confirmed locally; nothing assumes writing on tissue). |
| O7 | The grosser completes the requisitions; Jorge then types gross descriptions into EMA. Waiting for the batch can keep him until about 9 p.m. | Current lab | Which part is the real constraint: physical grossing, documentation, transcription, staffing or processing cutoffs. |
| O8 | More than 300 slide labels may be printed and applied by hand each day. Extra slides or missing part labels need separate manual printing. PAS cases are separated by hand. | Current lab | This is a label count, not a case count. What printers and label materials exist. |
| O9 | A daily printed report, "the bible," lists cases by doctor; each doctor's pages are colored, and a separate table marks PAS cases in yellow. Technicians depend on it. | Current lab | Which parts are a record requirement and which are only a handoff aid. |
| O10 | Block and slide storage and retrieval involve a lot of manual number checking. | Current lab | The storage addressing scheme and how checkouts are recorded. |
| O11 | High-volume additional-work orders came from an hourly Crystal Reports report; sometimes more than 100 blocks were retrieved by hand; printed requests were sorted into a set order; some cases were delayed; block searches were long; slides and paper requisitions were scanned repeatedly while assembling trays. | Quest (observed) | Crystal Reports is a reporting tool; it tells us nothing about which LIS is underneath. |
| O12 | Grossing communication was spoken, including exact dimensions and piece counts. | UHealth (observed) | Hands-free capture may suit a grossing bench. The open questions are identity linkage, verification, transcription accuracy, integration and when the next worker gets the information. |

### 2.2 The problem in plain terms

Information about each specimen is **re-copied by hand at several handoffs** (paper requisitions, stickers, memory, a printed daily report, retyping). **Replies to office clarification messages can be delayed, and we don't yet know why** (notifications may be unsupported, turned off, ignored or sent to the wrong person). Unclear follow-up ownership is one hypothesis to check, not an observation. Possible consequences, which are hypotheses and have **not** been measured, include rework at accessioning, delayed cases, label mix-up risk, an end-of-day transcription backlog, and time spent looking for material.

### 2.3 Why this is worth investigating (published evidence, with limits)

- **[R6]** A 2016 single-center histology improvement series reported labeling errors falling from 1.03% to 0.28% after a barcode-enabled LIS intervention, and to 0.22% after further workflow changes; manual slide printing and microtomy were major error sources. *A historical result at another site, not a promised effect for this product.*
- **[R7]** A University of Florida before/after study found fewer wrong-tissue-in-block incidents once barcode confirmation was reinforced with a workflow hard stop. *A barcode feature without an enforced process is not enough.*
- **[R8]** A biopsy grossing study found voice recognition had negligible effect on the prosector's time per specimen while reducing transcription needs. *Capturing information at the source is worth exploring; it does not automatically speed up grossing or prevent every error.*
- **[R9]** A 2012 UPMC contextual-inquiry study of six pathologists found anatomic pathology workflow labor-intensive and concluded that a digital slide system should integrate with the AP information system. *Its subjects were pathologists, not histology staff; the transferable lesson is to observe real work before designing screens.*
- **[R5]** The CAP/NSH practical specimen-handling guide (March 2025) covers identification, discrepancy handling, traceability and validation of barcode materials and equipment. *Guidance to review with lab leadership, not a complete current accreditation checklist.*

---

## 3. Who it is for

| Role (demo name, fictional) | Main need | Primary screen |
|---|---|---|
| Accessioners (Maya Torres, Luis Benitez) | Reconcile arrivals fast; know the right doctor; raise and track questions without stopping the bench | `/intake`, `/clarifications` |
| Accessioning lead (Kim Nguyen) | Own routing exceptions and related-order decisions; review office answers, resolve clarifications and release holds (each with a reason) | `/intake`, `/clarifications`, `/settings` |
| Grosser (Dana Whitfield) | Record each part once, clearly, at the bench | `/grossing` |
| Histology assistant (Sam Ortiz) | Receive reviewed gross records as each part is ready, enter them into EMA, see what is still pending | `/grossing`, `/worklist` |
| Histotechs (Priya Shah, Marcus Lee) | A current doctor/PAS worklist; print, tray and retrieval tasks | `/worklist`, `/materials` |
| Operations supervisor (Tanya Brooks) | See what is blocked, who owns the next step, and the evidence | `/operations`, `/insights` |
| Director of Operations, medical director (demo roles; read-only for lab records, except that the medical director demo role can approve a new routing rule version and add or retire a coverage exception) | Follow one case end to end; judge whether a pilot is worthwhile | `/demo`, `/operations`, `/cases/[id]` |
| Submitting offices (indirect) | Receive specific, answerable questions through an agreed channel | Not a screen in the first build; notifications are simulated |
| Dermatopathologists (indirect) | Correct case assignment and a reliable worklist | Not a primary user in the first build |

The demo role selector only changes what the screen allows for demonstration. **It is not a login and not production security.**

---

## 4. Product decision: a companion, not a replacement

| Stays in EMA (authoritative) | Owned by Histology Lab OS (operational) |
|---|---|
| Patient record and identifiers | Intake items (provisional receipt records, e.g. `INT-1014-031`, visibly different from accession numbers) |
| Clinical orders | Discrepancy and clarification records (e.g. `CLR-0457`) with owners and follow-ups |
| Official accession numbers (e.g. `D26-04817`) and any correction of them | Related-order *candidate* reviews (never merges) |
| Approved gross descriptions | Draft and reviewed grossing records, and the task to enter them into EMA |
| Diagnostic reports and release | Worklist views, print-job tracking, tray verification, storage locations and checkouts |
| Any official correction process | Its own append-only local audit log of operational events |

Rules the companion always follows:

- It **never** silently merges patients, combines cases, renumbers an issued accession, changes a specimen site, replaces a part designation or relabels physical material.
- A discrepancy found after accessioning keeps the original references and points to the lab's authorized correction process. The demo shows a review/cross-reference record; it does not pretend to correct EMA.
- A local draft is **never** shown as entered until a named person attests the manual entry or the source system acknowledges it, and the two are displayed differently. The source-entry states are: *Source-system entry pending* → *Entered in source system (staff attested)* → *Source system acknowledged (simulated)*, plus *Failed*. An attestation is never called an acknowledgment. In this demo the acknowledgment can only come from a labeled demo control, because no real interface exists.

Why a companion: it is the lowest-risk way to test whether the handoff gaps can be closed, it does not ask the lab to change its system of record, and it leaves room for the answer to be "configure EMA" or "buy a product" instead (Section 5).

---

## 5. Configure vs buy/integrate vs build

An inefficient local process can come from configuration, hardware, training, access or coordination between offices, not only missing software. **We do not know what the lab licenses or has turned on.** The order of the decision should be: configure first, then buy/integrate, then build only what is still missing.

| Option | What it means | Available categories (vendor descriptions only) | Questions to answer first |
|---|---|---|---|
| **Configure** | Use features of the current EMA setup more fully | ModMed describes pathology gross defaults, configurable stains, reporting/tracking and multiple accession sequences; its FAQ says the module handles slide/cassette label printing in most cases **[R1]** | Which EMA modules and pathology options are licensed and enabled? Can a ModMed specialist demonstrate them on our workflow? |
| **Buy / integrate** | Add an existing specialist product | Leica CEREBRO describes identification, on-demand printing, tracking and workflow dashboards **[R10]**. Milestone MacroPATH describes integrated grossing documentation **[R11]**. Epredia offers direct slide printers **[R12]** | Does it work with our EMA tenant and our printers? What does it cost (vendor quote required)? |
| **Build** (this companion) | A targeted coordination layer for gaps left after the two steps above | This project | Which gaps remain after configure and buy are reviewed? Can a supported interface supply the data? |

R1 and R10–R12 are cited **only as vendor descriptions of what categories of product exist**. They are not independent proof of results and do not confirm that any product works with this lab.

How each problem maps to the three options:

| Problem area | Configure candidate | Buy/integrate candidate | Build candidate (this demo) |
|---|---|---|---|
| Slide and cassette labels | EMA label printing, if enabled [R1] | Direct slide/cassette printing hardware [R12]; tracking systems [R10] | Print queue with unknown-outcome reconciliation (simulated printer) |
| Grossing documentation | EMA gross defaults/templates [R1]; **direct structured entry inside EMA may be the better first step** | Grossing documentation stations [R11] | Reviewed, per-part grossing record and entry task |
| Doctor/PAS worklist ("the bible") | EMA reporting/tracking [R1] | Workflow dashboards [R10] | Live worklist grouped by doctor with PAS as explicit text |
| Office-to-doctor routing | Unknown; to discover | Unknown | Versioned routing rules with exceptions |
| Office clarifications | EMA messaging/notification settings plus agreements with offices | Unknown | Clarification tracking with owners, follow-ups and review |
| Block retrieval | Unknown; to discover | Tracking systems [R10] | Last confirmed location, checkout history, scan check |

**Differentiation hypothesis (to be tested, not claimed):** a usable coordination layer focused on the handoff gaps across dermatology offices and the bench. This project did not invent specimen tracking, speech recognition or "AI histology," and does not claim to be the first.

Costs (vendor fees, hardware, consumables, integration, maintenance, training) require vendor quotes. **No prices are estimated in this project.**

---

## 6. First-build scope

### 6.1 Five core flows (fully working in the local demo)

| # | Flow | What it shows | Route |
|---|---|---|---|
| 1 | Arrival and pre-accession reconciliation | Courier manifest (expected vs received; "Unknown" if no manifest), side-by-side order vs container vs requisition, explicit "Staff verified against physical container," related-order candidates | `/intake` |
| 2 | Office-to-pathologist routing | Suggestion from an approved, versioned rule (rule set v3, effective 2026-09-01) with the rule shown; unknown office (Seagrape Skin Studio) becomes a routing exception, never a guessed doctor; overrides need a reason | `/intake`, `/settings` |
| 3 | Specimen-specific clarification | Task with affected part, evidence, office contact role (from a simulated office contact directory), lab owner, follow-up time, distinct states (drafted, sent, delivery unknown, delivery failed, delivered, acknowledged, answered, reviewed, resolved, canceled), hold on the affected part only. Resolving the clarification and releasing the hold are separate audited actions, each with its own reason | `/clarifications`, `/cases/[id]`, `/settings` (office contacts) |
| 4 | Live doctor/PAS worklist | Grouped by dermatopathologist (name plus a fictional demo color), PAS as text with its originating order or protocol and affected material, changes since last acknowledged, printable snapshot with time and version | `/worklist` |
| 5 | Reviewed grossing record, incremental | Structured fields plus narrative from a synthetic dictation transcript; numbers, units and counts must be confirmed; a completed part creates the next task while other parts stay incomplete | `/grossing`, `/cases/[id]` |

### 6.2 Two smaller working demonstrations

| Demo | What it shows | Route |
|---|---|---|
| Print queue and trays | Print jobs linked to official IDs; a printer timeout shows **unknown outcome** and must be reconciled before retry; reprints record a reason and never create a new slide (an additional slide is a separate work order); tray verification slide by slide flags a missing expected slide and an unexpected one | `/materials` (print jobs, trays) |
| Block retrieval | Request with last confirmed slot (not "guaranteed present"), checkout history, pick list by location; a wrong block scan is rejected | `/materials` (retrieval) |

Supporting screens: `/operations` (what is blocked, who owns it, evidence, data age), `/insights` (queue charts on illustrative data, metric definitions and a blank scenario calculator), `/settings` (routing rules, demo scenarios, integration capabilities, office contacts, preferences), `/demo` (guided five-minute walkthrough, before/after map, speaker notes, real vs simulated).

### 6.3 The hero demo case (all fictional)

Synthetic patient Avery Quinlan (MRN `448210`, tenant EMA-SIM Sunrise Coast) from Harbor Point Dermatology; ordering clinician Dr. Hannah Cole; assigned dermatopathologist Dr. Elena Marsh. Parts A (left upper back, shave, `ORD-77120`) and B (`ORD-77121`, order says **right** dorsal forearm, bottle says **left** dorsal forearm, punch) arrive at 11:00 as two separate orders from the same encounter (intake items `INT-1014-031` and `INT-1014-032`). The system proposes related-order candidate `REL-0112`; the accessioning lead decides (one accession, both orders kept). Part B gets clarification `CLR-0457` and hold `H-0090` on Part B only. The simulated office answer is reviewed, then the clarification is resolved. The hold stays until the amended order `ORD-77121` v2 arrives from the simulated source a few minutes later; the lead then releases it as a separate action with a reason. The source simulator issues accession `D26-04817`. The grosser completes a reviewed record for Part A, which creates the source-entry task for Sam Ortiz and makes block A1 eligible for processing, while Part B stays "Awaiting grossing" and the case stays incomplete.

Steps 6 and 7 of the guided demo use **earlier synthetic cases**, not D26-04817, because the hero case has no slides or stored blocks yet on its first morning: tray `TRY-M-03` (Dr. Marsh), print job `PJ-8841`, and retrieval request `RR-0192` (Dr. Okafor) for blocks of D26-03990 and D26-03912. Demo day: Wednesday 2026-10-14, clock starting at 10:52 (America/New_York).

### 6.4 What is real, simulated, unsupported or unknown

This table describes the split as built. Which behaviors are covered by automated tests, and which are not, is reported in `acceptance-tests.md` (the 15 acceptance checks, the tests behind them and the last recorded run).

| Category | Examples |
|---|---|
| **Implemented locally** | Local SQLite database with a reproducible synthetic day, intake and verification, routing rules with exceptions, related-order review, clarifications with scoped holds, the doctor/PAS worklist with change tracking and snapshots, per-part grossing review, print/tray/retrieval demos, office contact directory, local append-only audit log, conflict (stale update) detection, reset and demo clock |
| **Simulated and labeled** | Source systems (EMA-SIM Sunrise Coast, OTHER-EHR-SIM Gulf), accession issuance, office notifications and answers, the source acknowledgment of a gross entry, printers, and the "assistant" (deterministic demonstration rules, not live AI) |
| **Not supported in this project** | Any connection to the real EMA, real messages to offices, real printer control, writing back to EMA, production login/security |
| **Unknown until discovery** | What EMA interfaces actually expose for this lab, what is licensed/enabled, existing printers, the approved routing mapping, what creates separate A/B orders |

---

## 7. Non-goals (first build)

- Replacing EMA or any LIS function, including accessioning, order entry, gross report approval and diagnostic reporting.
- Connecting to, scraping or automating the employer's EMA session or database, or sending real messages.
- Diagnosis, diagnostic AI, deciding PAS eligibility from diagnosis text, ordering stains, deciding that specimens match, correcting accessions, or releasing reports.
- Inventory management, computer vision, predictive staffing, whole-slide imaging, billing (see `roadmap.md`).
- Claiming the demo proves clinical performance, production integration, compliance, accreditation readiness, time savings or cost savings.
- Removing paper immediately. A printable fallback stays for downtime and transition.
- Production authentication, hosting, backup or validation. Those are deployment dependencies owned by the organization's clinical, IT, privacy/security and operations leaders.
- Staff performance rankings.

---

## 8. Success criteria

### 8.1 For the prototype (this demonstration)

The prototype succeeds if a director can, in about five minutes:

1. Follow one multipart case (Avery Quinlan, parts A and B) from courier arrival to downstream work.
2. See the discrepancy (Part B laterality) with both pieces of evidence side by side.
3. Understand how it was resolved: who owned it, what the (simulated) office said, who reviewed it.
4. Watch the correct worklist update when Part A is ready, while Part B visibly stays incomplete.
5. See exactly what a real deployment would require (interfaces, approvals, hardware, owners).

Supporting checks:

- The acceptance checks in the master specification (unknown office, related orders, mismatches, idempotent import, conflicts, printer unknown outcome, tray mismatch, wrong block scan, stale data, AI failure) are tested, and gaps are reported honestly.
- Every principal control works; state survives a page refresh; a reset command restores the known demo state.
- Synthetic mode and simulated connectors are visibly labeled everywhere they matter.

### 8.2 For a later pilot (must be measured locally)

A pilot can only be judged with the lab's own data, collected with approval. No targets are set before a baseline exists.

| Measure (examples) | Notes |
|---|---|
| Hands-on accession minutes per case | Per case, with case mix recorded |
| Clarification acknowledgement and resolution time | Median and 90th percentile where the sample allows; still-open items shown separately |
| Grossing-complete to approved-EMA-entry delay | Grossing, transcription, verification, batch waiting and integration lag measured separately |
| Age of unresolved work | Open items never disappear from results |
| Manual transcription time; requisition pages handled | |
| Correction and reprint counts, with reasons | |
| Slide-label handling time; block retrieval time | |
| Paid overtime | Only where authorized data exists |
| **Guardrails** | Extra verification burden, double entry created by the pilot, near misses, new delays |

Each metric needs a written numerator, denominator, start and end events, exclusions and data source. Missing event data is reported as missing, never counted as a fast completion. Labor time saved, waiting time reduced, recovered capacity and actual cash savings are kept separate and never double-counted. A short pilot cannot show a reduction in rare patient-harm events.

### 8.3 What success does not mean

A successful demo shows the idea is understandable and worth a closer look. It does not show clinical safety, regulatory compliance, interoperability with EMA, or savings.

---

## 9. Assumptions

Each assumption lets the synthetic prototype move forward without blocking on live-system questions. None is a fact about the real lab until confirmed.

| # | Assumption | Why it was assumed | How it would be confirmed |
|---|---|---|---|
| 1 | EMA stays the authoritative system for patients, orders, accessions, approved gross descriptions and reports. | Lowest-risk design; matches the master specification's product decision. | Director of Operations, medical director and ModMed account team agree. |
| 2 | Each submitting office routes to one assigned dermatopathologist, with occasional coverage exceptions. | Accessioners route by office from memory (O2). | Obtain the approved office-to-pathologist and coverage mapping from management. |
| 3 | A new office with no approved rule should create a routing exception, not a best guess. | Guessing a doctor is a silent error risk. | Confirm the lab's policy for new or unlisted offices. |
| 4 | Separate A/B submissions show up as two source orders under one encounter. | Most visible form of O4; the data model also supports separate encounters and duplicate patient records. | Ask ModMed and the lab exactly what is created, and what correction is supported before vs after accession. |
| 5 | After an accession number exists, correction must go through the lab's authorized process. | Observed that correction is difficult once assigned (O4). | Review the lab's written correction procedure. |
| 6 | Most offices share one EMA tenant; at least one office uses a different EHR. | Tests source namespaces (same MRN in two systems must not collide). | Ask whether all contributing offices are in one EMA tenant and which use other EHRs. |
| 7 | Whether real courier manifests exist is unknown (O1). The demo seeds a mix: some offices send a simulated manifest (for example Harbor Point Dermatology, expected 4 containers), others send none and are shown as "Expected Unknown (no source manifest)" (Mangrove Bay Dermatology, Seagrape Skin Studio). | Not observed either way (O1); the mix exercises both cases. | Ask offices and couriers; check whether orders list expected containers. |
| 8 | Office clarifications currently travel by EMA message. Who receives them at each office, and who covers absences, is not known to us. | Delayed replies observed, cause unknown (O5). | Ask who receives clarifications, through which channel, and who covers absences. |
| 9 | Faster clarification needs an agreement with offices on ownership and escalation. | More notifications alone may add noise. | Discuss with office managers; agree a contact and escalation path. |
| 10 | PAS and other additional work are authorized by an order or protocol at a specific block or slide level. | PAS is tracked by hand today (O8, O9); eligibility must not be guessed from diagnosis text. | Ask what source authorizes PAS and at which material level it is specified. |
| 11 | "The bible" mainly serves an information function (doctor, case list, PAS), and some paper may still be required. | Technicians depend on it (O9). | List which paper documents are record requirements vs handoff aids. |
| 12 | The grosser writes descriptions on the requisition and a separate person types them into EMA later in a batch. | O7. | Time study of grossing, documentation, transcription, verification and batch waiting. |
| 13 | The local workflow could allow a completed part to move on before the whole batch is done. | Needed to test incremental handoff (flow 5). | Confirm with the medical director and SOP owner; identify what prevents incremental entry today (equipment, staffing, habit, access, system behavior). |
| 14 | Cassettes/blocks are hand-marked with case numbers; exact object and step are unconfirmed. | O6; the specification warns not to assume. | Watch the step at the bench and confirm with the grosser and histotechs. |
| 15 | The lab has some label printers, but their models, drivers and status reporting are unknown. | 300+ labels are printed daily (O8). | Inventory existing printers, scanners and label materials; ask whether EMA drives them today. |
| 16 | A printer can report "submitted" but not always "completed," so outcomes can be unknown. | Assumed so the demo handles the worst case; what the real printers report is unknown (discovery 6.3). | Test the real printers' status reporting. |
| 17 | DataMatrix 2D barcodes are an acceptable demonstration symbology. | Small enough for slide and cassette labels. | Confirm the symbology, content and format the lab's scanners and labels use. |
| 18 | Blocks are stored by an address like cabinet / drawer / box / slot, and checkouts are recorded somewhere (possibly on paper). | O10 suggests manual number checking. | Walk the storage area; ask how locations, checkouts, send-outs and returns are recorded. |
| 19 | One main courier delivery around 11:00 is typical; late deliveries happen. | O1. | Count deliveries over representative days. |
| 20 | Times are stored in UTC and displayed in America/New_York (Eastern Time). | The specification asks for this display zone; storing UTC avoids daylight-saving mistakes. | Confirm the lab's time zone and how EMA timestamps are stored and exported. |
| 21 | Seed volume (about 60 cases, 300+ slides) is illustrative only. | Enough to exercise the screens; 300+ is a label observation, not a case count (O8). | Collect actual volume and case mix during a baseline. |
| 22 | Physical stages (grossed, processing, embedded, sectioned, stained, QC-reviewed) are tracked only as far as the demo needs. | Keeps the first build focused; local SOP decides real stages. | Review the local SOP with histotechs. |
| 23 | No AI model is available; the demo uses a deterministic, clearly labeled extractor/drafter. | Demo must work without accounts or API keys. | If a model is wanted later, select an approved provider after privacy/security review. |
| 24 | Bench users work at about 1366-pixel-wide workstations or tablets. | Common lab hardware; the specification asks for it. | Check actual workstation and tablet sizes at each bench. |
| 25 | The demo role selector stands in for real identity management. | No accounts in a local demo. | Production would need the organization's identity system, reviewed by IT and security. |

---

## 10. Software terms used in these documents

| Term | Plain meaning |
|---|---|
| Companion | A separate tool that works alongside EMA and does not replace it |
| Source system / authoritative system | The system whose record is official (EMA) |
| Adapter / connector | The piece of code that talks to another system; in the demo all of them are simulated |
| Tenant / namespace | Which source system an identifier came from, so the same number in two systems is not confused |
| Idempotent | Doing the same import or click twice does not create duplicates |
| Audit log | A record of who did what and when; here it is local and append-only, which is **not** proof of production tamper resistance |
| Proposal | A suggested change that does nothing until a person reviews and accepts it |
| Attested | A named staff member recorded that they did something outside the app (for example, typed the gross description into EMA). It is their statement, not a confirmation from EMA |
| Acknowledged (by the source) | The source system itself confirmed it received something. In this demo that confirmation is simulated and labeled |
| Hold | A stop on specific steps for specific material (for example, Part B only). It is released only by an authorized person with a reason |

---

## 11. References

Listed as given in the master specification (research checked 2026-10-14 according to that brief). Recheck before relying on any of them; none establishes the configuration or authorization of a particular laboratory.

- **[R1]** ModMed, Pathology Lab Reporting Software. https://www.modmed.com/what-we-do/pathology/
- **[R5]** CAP/NSH, Practical Guide to Specimen Handling in Surgical Pathology, v12.0, March 2025. https://www.cap.org/wp-content/uploads/documents/Practical_Guide_to_Specimen_Handling_in_Surgical_Pathology_2025.pdf?download=true
- **[R6]** Achieving High Reliability in Histology: An Improvement Series to Reduce Errors. Am J Clin Pathol 2016;146(5):554–560. https://academic.oup.com/ajcp/article/146/5/554/2529661
- **[R7]** Weaver et al., Wrong Tissue in Block. Am J Clin Pathol 2021;156(4):700–707. https://pubmed.ncbi.nlm.nih.gov/33940603/
- **[R8]** Ye, Tan and Shum, Using Timestamp Data to Assess the Impact of Voice Recognition on the Efficiency of Grossing Biopsies. Arch Pathol Lab Med 2021;145(5):599–606. https://pubmed.ncbi.nlm.nih.gov/32960950/
- **[R9]** Ho, Aridor and Parwani, Use of contextual inquiry to understand anatomic pathology workflow. J Pathol Inform 2012;3:35. https://pubmed.ncbi.nlm.nih.gov/23243553/
- **[R10]** Leica Biosystems, CEREBRO Workflow Management System. https://www.leicabiosystems.com/us/tracking-and-workflow/cerebro/
- **[R11]** Milestone Medical, MacroPATH. https://www.milestonemedsrl.com/products/grossing-and-macro-digital/macropath/
- **[R12]** Epredia, Microscope Slide Printers. https://www.epredia.com/products/histology-instruments/slide-printing

Related documents in this folder: `workflow-map.md`, `roadmap.md`, `ai-assistants.md`, `data-model.md`, `design-spec.md`, `integration-capability-matrix.md`, `research-notes.md` (checked details for each reference), `discovery-checklist.md`, `pilot-proposal.md`, `director-pitch.md`.
