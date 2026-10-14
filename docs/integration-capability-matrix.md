# Integration Capability Matrix

**Project:** Histology Lab OS, a companion to the existing EHR/LIS (EMA by ModMed at the author's lab). It handles operational coordination and specimen tracking.
**Prepared by:** Jorge Rodriguez (histology assistant)
**Documentation checked:** 2026-10-14. Sources are cited as R# (master specification references) and S# (supplementary ModMed API Portal pages). Full details are in `research-notes.md`.
**Status:** Planning document. Nothing here has been tested against a real system. This document does not request, grant or imply access to any employer system, and it does not claim endorsement by any director, laboratory or vendor.

---

## 1. Plain-English primer

| Term | Meaning here |
|---|---|
| **Authoritative system** | The official system of record. For accessions, orders, gross reports and diagnoses, that is EMA (or another office's EHR). If the companion and the authoritative system disagree, the authoritative system wins until a person reviews the difference. |
| **API** | A documented way for one program to ask another for data, or to send it data. |
| **Proprietary API** (ModMed) | ModMed's partner API. Documentation says it can read, search, create and update *some* resources. It requires the synapSYS partner process, sandbox development, a technical review, and credentials issued for each practice [R2, S2–S4]. |
| **Certified FHIR API** (ModMed) | A standards-based API that is read/search only, plus bulk export. It uses SMART on FHIR authorization [R2, S6]. |
| **HL7 interface** | An older, message-based interface. ModMed lists outbound orders (ORM) and inbound results (ORU), including pathology [R3]. |
| **Approved export** | A file or extract that the lab and vendor agree to provide. **The companion's fixture importer uses our own schema. We do not assume EMA offers any particular export.** |
| **Manual attestation** | A named staff member confirms in the companion what they saw or did in EMA or at the bench, for example "gross description for D26-04817 part A entered in EMA, attested by Sam Ortiz at 14:05." The companion records who attested, and when. An attestation is the person's statement; it is **not** an acknowledgment from the source system, and the two are displayed differently. |
| **Polling** | Asking the source "what changed since time X?" on a schedule. No push events (webhooks or subscriptions) are documented by ModMed [S12]. |
| **Idempotent** | Doing the same thing twice has the same effect as doing it once. A repeated import or a double click creates no duplicates. |
| **Namespace** | The "where it came from" part of an identifier. In the demo, MRN 100234 exists in both EMA-SIM Sunrise Coast and OTHER-EHR-SIM Gulf, and they are two different patient references. |
| **Writeback** | The companion changing data in the authoritative system. It is not used in rollout Modes A–C. |

---

## 2. Legend

**Candidate interface codes**

| Code | Meaning |
|---|---|
| PROP-API | ModMed EMA Proprietary API (FHIR-shaped resources under `/fhir/v2/`) |
| FHIR-R | ModMed Certified FHIR API, read/search only |
| HL7 | HL7 order (ORM) / result (ORU) or other message feed |
| EXPORT | An approved export, mapped into our fixture schema |
| MANUAL | Manual attestation by a named role |
| LOCAL | A companion-owned operational record. It never stands in for an official clinical record. |
| NONE | No interface. Not planned. |

**Documented-access wording**

| Wording | Meaning |
|---|---|
| Documented | A public ModMed page describes it |
| Partly documented | A related resource exists, but the field or behaviour we need is not described |
| Not documented | No public page found. **This does not mean the feature does not exist.** It is a question for ModMed. |

**Approval bundles** (shorthand used in the tables)

| Code | What it requires |
|---|---|
| AP-READ | Sign-off on intended use from the Director of Operations and the medical director. Review by the organization's IT and privacy/security owners. Data-use and contract terms as the organization's privacy and legal owners determine. ModMed provisioning and technical review [S3]. Credentials specific to each practice [S4]. Permission of the practice before using that practice's sandbox [S2]. |
| AP-CLIN | AP-READ, plus medical-director review of clinical meaning and local validation of the field mapping. |
| AP-WRITE | AP-CLIN, plus a write or device interface confirmed by the vendor, tested in a sandbox, with known acknowledgement semantics, a rollback plan and a downtime procedure. |
| AP-LOCAL | Lab leadership approval for the companion to hold this operational record, plus an SOP update, training and a paper/downtime fallback. |
| AP-OFFICE | Agreement with the submitting offices on channel, ownership, escalation and coverage. |

**Demo tenants (all fictional):**
- *EMA-SIM Sunrise Coast*: most offices.
- *OTHER-EHR-SIM Gulf*: Lighthouse Skin Center. **ModMed documentation does not apply to this tenant.** It needs its own discovery.

In Mode A (the local demo), every row below is supplied by the simulated source adapter and is labeled "Simulated."

---

## 3. The matrix

### 3.1 Identity, encounter and orders

| Required field / action | Owner / authoritative source | Documented access | Unknowns | Approval | Candidate interface | Refresh method | Fallback | Conflict policy |
|---|---|---|---|---|---|---|---|---|
| **Patient reference** (name, DOB, source patient ID) | The office's EHR tenant | **Documented** for reading: Patient read/search in FHIR-R [S6] (the S6 row in `research-notes.md` records 23 read/search scopes but does not name Patient among the examples; to verify). Patient create/update in PROP-API is **to verify**: `research-notes.md` mentions it but does not record the specific page (S12 is only the portal index). ModMed's patient ID (EMAID) is unique; **MRNs are not guaranteed unique** [S4]. ADT direction depends on the PM vs. EHR-only setup [R3]. | Do the lab and all offices share one EMA tenant? How do patients from other-EHR offices appear? Which identifiers are printed on bottles? | AP-READ | FHIR-R or PROP-API read (B, C). EXPORT (B). | Read on demand when an order references the patient. No bulk patient sync. | MANUAL: the accessioner checks two identifiers on the container against the requisition [R5]. | Key = tenant + source patient ID, **never** name or MRN alone. Never merge patients. A demographic mismatch opens an identity clarification. A source change after review creates a review task; it does not overwrite. |
| **Encounter / collection event** | Office EHR | **Documented** for Encounter read/search (FHIR-R scope [S6]). ServiceRequest search can filter by encounter [S5], and R4 describes `subject` as an Encounter reference. A ServiceRequest occurrence (collection) time field is **to verify**: it is not in the R4 field table recorded in `research-notes.md`. | Does any field carry the collection time? Do separately entered A/B orders share one encounter ID? | AP-READ | FHIR-R / PROP-API read | Re-read with each order version | MANUAL from the requisition. Otherwise the value is shown as **unknown**, never guessed. | A shared encounter is *evidence* for a related-order candidate, never a merge. Two encounters for the same patient stay separate. |
| **Source order + versions** | Office EHR (ordering clinician) | **Documented, read-only.** ServiceRequest has `id`, `lastUpdated`, `requisition`, `status`, `requester`, `code`, `note` and `supportingInfo` [R4]. Search filters include `_lastUpdated`, `status`, `authored`, `requisition`, `patient` and `encounter`, with a maximum of 50 per page [S5]. (An `authoredOn` field is not in the recorded R4 table; to verify.) HL7 ORM covers "clinical and pathology lab orders," outbound from EMA [R3]. Access can be limited to orders where the vendor is the selected performer, or opened to all orders [R4]. | Version history (only `lastUpdated` is documented). Whether in-house Pathology-module orders appear as ServiceRequests, and with which category (R4 lists Surgical/Therapies/Radiology; S5's example shows Pathology). Status value sets differ across pages [R4, S5, S6]. | AP-READ, plus ModMed configuration of the access scope | PROP-API read (ServiceRequest search) or FHIR-R read. HL7 copy feed only if the lab is a message receiver. EXPORT (B). | Poll with `_lastUpdated` (documented at date granularity) plus an overlap window. Upsert idempotently. | MANUAL: the accessioner records the order reference from the requisition or EMA screen. | Store every received version (source time + content hash). Older never overwrites newer. A change after local work starts opens a reconciliation task. The companion never edits the order. |
| **Order parts / site / laterality / procedure** (e.g., Part B site, shave vs. punch) | Office order. The physical label is observed by the lab. | **Partly documented.** `bodySite` is filled only if the clinician selected one [R4]. `code` is CPT/LOINC/compendium. `note` is free text. `basedOn` references a RequestGroup [R4]. **No separate laterality, part-letter or biopsy-method field is documented.** Certified Specimen search has only `_id`/`patient` filters, and Specimen is not in the listed scopes [S8, S6]. | How multi-part biopsies are represented (one order with several sites, one order per part, or a RequestGroup). This is central to the A/B "two patients" question. Whether laterality is inside the `bodySite` text. | AP-CLIN | PROP-API read (`bodySite`, `code`, `note`) plus MANUAL bench observation | With each order version | MANUAL typed observation of the bottle label and requisition | Source value and observed value are shown side by side. A mismatch opens a targeted clarification and a hold scoped to that part (e.g., CLR-0457 on Part B only). The source site is never changed by the companion. |
| **Requisition documents** | Office EHR / lab paper | **Documented.** `supportingInfo` points to the order PDF [R4]. DocumentReference supports read/search [S10, S6]. HL7 inbound documents arrive as PDF attachments [R3]. | Is the order PDF the same requisition the lab works from? Are paper requisitions scanned, and by whom? | AP-READ | PROP-API / FHIR-R read, view-only link | On demand | Paper requisition (current practice) | Show the document's time and version. Fields an AI extracts are *proposals* with their evidence, never accepted automatically. Document text is data, never instructions. |
| **Submitting office / ordering clinician** | Office EHR | **Documented.** `requester` → Practitioner [R4]. Practitioner, PractitionerRole, Location and Organization are readable [S6]. Providers have a ModMed ID and NPI [S4]. | What identifies "the office" in our tenant (Location, business unit, tenant)? How is the other-EHR office identified? | AP-READ | PROP-API / FHIR-R read, plus a LOCAL office directory mapping source IDs to offices | Daily reference read plus on-demand | LOCAL directory maintained by the accessioning lead | An unknown office (e.g., Seagrape Skin Studio) becomes a **routing exception**. Never guess. The ordering clinician and the assigned dermatopathologist are kept as separate fields. |

### 3.2 Accession and physical material

| Required field / action | Owner / authoritative source | Documented access | Unknowns | Approval | Candidate interface | Refresh method | Fallback | Conflict policy |
|---|---|---|---|---|---|---|---|---|
| **Accession number + namespace** (e.g., D26-04817 in "EMA-SIM DERM") | EMA Pathology module (lab tenant) | **Not documented** in the API. R1 (a product claim) says each pathologist, facility or workflow can have its own accession sequence. The DiagnosticReport identifier links to the *requisition*, not an accession [S7]. | Can any interface expose the accession number, its prefix/namespace and its assignment time? | AP-CLIN | To be confirmed with ModMed. Until then EXPORT (B) or MANUAL (scan/type after EMA assigns it). | At accession time (attested) or via export | MANUAL | The companion **never assigns, renumbers or merges** accessions. The provisional intake ID (INT-…) stays as a cross-reference. A mismatch creates a review record and uses the lab's authorized correction process. |
| **Part designations** (A, B, …) | EMA Pathology module | **Not documented** | Where the part letter is created. Whether it maps to an order, a container or both. | AP-CLIN | EXPORT / MANUAL | With the accession | MANUAL | A part letter is never replaced. Original and corrected references are both kept. |
| **Container counts** (expected vs. received) | Expected: the office (order or manifest), if it exists. Received: the lab (physical). | **Not documented** for expected counts. R5 recommends checking the number of containers at accessioning and tracking specimens from remote sites. | Does any office send a manifest? Is there a container count anywhere in EMA? | AP-LOCAL (received). AP-OFFICE (manifest). | LOCAL scan count. Expected count from an office manifest only if one exists. | Live at the bench | Paper courier log | Expected count with no source is shown as **"unknown," never zero**. Missing or extra items become discrepancies. |
| **Observed container label** (site, laterality, identifiers as written) | Physical bench observation | Not applicable (physical) | Bottle label formats in each office | AP-LOCAL | LOCAL + MANUAL ("verified against physical container" action) | Live | Paper | A barcode or OCR read identifies a *record*. It does not prove what tissue is in the bottle. Staff verification is a separate, recorded step. |
| **Cassette / block IDs** (e.g., D26-04817 A1) | EMA Pathology module / lab | **Not documented** in the API. ModMed's FAQ says the module handles slide or cassette label printing in most cases [R1]. R5 recommends minimum identifier content and human-readable text alongside barcodes. | Whether block IDs exist as data that can be read. How the lab marks cassettes today (must be confirmed locally). | AP-CLIN | EXPORT / MANUAL scan of the printed label | At grossing | MANUAL | Never relabel. Identity is preserved from cassette to processed block. |
| **Slide IDs** (e.g., D26-04749 A1-2 PAS in the demo seed) | EMA Pathology module / printer | **Not documented** in the API (as for blocks) | Whether slide records exist in EMA or only as printed labels | AP-CLIN | EXPORT / MANUAL scan | At microtomy and printing | MANUAL | A reprint is never a new slide. An additional slide is a separate authorized work item. |

### 3.3 Work, assignment and documentation

| Required field / action | Owner / authoritative source | Documented access | Unknowns | Approval | Candidate interface | Refresh method | Fallback | Conflict policy |
|---|---|---|---|---|---|---|---|---|
| **Gross description text** | EMA (the approved gross report). The grosser authors it; the histology assistant enters it. | **Not documented** for read or write. R1 (product claim) mentions customizable gross defaults. DiagnosticReport exposes result PDFs and status [S7], but whether Pathology-module reports appear there is not stated. DocumentReference upload exists [S10], but it attaches a document; it is **not** structured gross entry. | Is there any supported write path? What are its acknowledgement semantics? | AP-WRITE (for any writeback). AP-CLIN (to read). | **Modes A–C: NONE for writing.** MANUAL attestation ("entered in EMA, attested by Sam Ortiz, 14:05"). Mode D only if ModMed documents a supported path. | Attestation event | Current manual entry in EMA | A companion draft is **never** shown as entered. Separate states: *Source-system entry pending* → *Entered in source system (staff attested)* → *Source system acknowledged* (only from the source; simulated in Mode A), plus *Failed*. An attestation is never displayed as an acknowledgment. In Modes B–C only attestation exists. If EMA text later differs, EMA wins and the difference is flagged for review. |
| **Stain / work orders, including PAS** (e.g., WO-2142 in the demo seed) | The authorized requester (pathologist or protocol), recorded in EMA | **Not documented** in the API. R1 (product claim) mentions configurable stains and stain reports. | Where PAS is ordered. At which level (case, part or block). Whether it is protocol-driven. | AP-CLIN | EXPORT / MANUAL entry with the originating order or protocol reference | When ordered | The current paper "bible" table (during transition only) | PAS is shown as explicit text with its source. It is **never inferred from diagnosis text**. A cancelled or amended order stays traceable and triggers review of material already printed or prepared. |
| **Pathologist assignment** | Lab leadership's approved routing rules; the actual assignment is recorded in EMA | **Partly documented.** R1 mentions per-pathologist accession sequences. R4's "performer" setting concerns which vendor sees orders, **not** internal dermatopathologist assignment. PractitionerRole is readable [S6]. CareTeam appears as a Task assignee type [S9]; whether CareTeam itself is readable is **to verify**. | Is assignment stored as data, or implied by accession sequence? What is the coverage/absence process? | AP-LOCAL (rule table). AP-CLIN (reading EMA). | LOCAL versioned rule table (v3, effective 2026-09-01) for *suggestions*, plus MANUAL confirmation that EMA matches | When rules change; per case at intake | The accessioners' current knowledge, documented in the rule table | EMA's recorded assignment wins. A mismatch opens a review. An override requires an authorized role and a reason. An unknown office gets no suggestion. |
| **Final diagnostic report** | EMA | DiagnosticReport is readable (PDF and status, including "correction") [S7] | n/a | n/a | **NONE (out of scope).** The companion does not import diagnoses. | n/a | n/a | Out of scope. Listed here so nobody assumes the companion reads diagnoses. |

### 3.4 Communication

| Required field / action | Owner / authoritative source | Documented access | Unknowns | Approval | Candidate interface | Refresh method | Fallback | Conflict policy |
|---|---|---|---|---|---|---|---|---|
| **Clarifications / messages to offices** (e.g., CLR-0457) | The companion holds the operational task record (LOCAL). Clinical communication stays in EMA. | **Partly documented.** EMA Task: create/read/update/search, assignee is a Practitioner or CareTeam, the name prefix comes from the firm's value set, `basedOn` must point to a lab order of that firm, statuses ready/received/completed/cancelled [S9]. No Communication (messaging) resource is listed [S12]. | Are today's EMA clarification messages Tasks or something else? Can a lab task reach staff in another office or tenant? Who is notified, and how? Is the delay caused by the channel, notification settings, staffing or ownership? | AP-LOCAL + AP-OFFICE. AP-WRITE for any Task creation. | **Modes A–C:** a LOCAL record. Staff send through the existing EMA channel; sent and answered are recorded by MANUAL attestation. **Mode D candidate:** PROP-API Task create, after review. | Follow-up timers in the companion. Office answers are attested. | Phone/fax per the office contact directory | Sent ≠ delivered ≠ acknowledged ≠ answered ≠ resolved. An answer must be reviewed by an authorized lab role before resolution. AI may draft text but never invents or accepts an answer. |
| **Notifications** (reminders, escalations) | The companion (operational). The channel owner depends on the channel. | **Not documented.** No webhook, subscription or notification pages were found [S12]. | Which channels are approved. Whether offices will act on them. | AP-OFFICE + AP-WRITE | **Mode A: simulated and visibly labeled.** Later: an approved channel carrying a *generic* message that points to the secure case view, with no patient information by default. | Event-driven, with duplicate suppression | Phone per the directory | Every message has a delivery-unknown state. Duplicates are suppressed. Respect office working hours and escalation owner. |

### 3.5 Devices, storage and custody

| Required field / action | Owner / authoritative source | Documented access | Unknowns | Approval | Candidate interface | Refresh method | Fallback | Conflict policy |
|---|---|---|---|---|---|---|---|---|
| **Print jobs / printer control** (e.g., PJ-8841) | Whatever drives the printer today (ModMed's FAQ says the EMA module does in most cases [R1]), plus the printer hardware | **Not documented** for EMA. Vendor pages describe printing (R10, R12), but R12 names no LIS interface and R10 names no interface standard. | Printer models, drivers, what status they report (acknowledged? completed?), who triggers printing, and the label stock validation status [R5] | AP-WRITE (device) | **Modes A–C: simulated.** Mode D only after the printer interface and bench procedure are reviewed and tested. | Job status polling, if the printer supports it | Current printing method | A timeout after submission = **unknown outcome**, which must be reconciled before retrying. A reprint records reason, operator and original job; it never creates a new specimen. A screen preview is not scanner, solvent or stainer validation. |
| **Storage locations / custody** (slots, checkout, send-outs; e.g., RR-0192) | Unknown today. Possibly paper logs. The companion could hold it with approval. | **Not documented** for EMA. R10 describes vendor tracking. R5 says barcode chain-of-custody tracking needs location capability. | Is any location recorded in EMA? What is the addressing scheme (cabinet/drawer/box/slot)? How are outside send-outs recorded? | AP-LOCAL. An initial inventory is required. | LOCAL, with a physical scan at each move | Each scan is an event | Current paper log / manual search | "Last confirmed location" is not a guarantee the item is present. A wrong block scan is rejected. Conflicting locations open an investigation. Scanning a location does not prove every item in it is present. |
| **Tray / manifest** (e.g., TRY-M-03) | Companion (operational) | Not applicable | The bench SOP for tray assembly | AP-LOCAL | LOCAL | Live | Paper tray sheet | Each slide is verified individually. Missing, unexpected, duplicate or cancelled slides block "verified complete." |

### 3.6 Changes and freshness

| Required field / action | Owner / authoritative source | Documented access | Unknowns | Approval | Candidate interface | Refresh method | Fallback | Conflict policy |
|---|---|---|---|---|---|---|---|---|
| **Cancellations / amendments** | Source system for orders; the authorized requester for work orders | **Partly documented.** ServiceRequest status values: R4 lists draft/active/closed; S5 adds suspended/completed/entered-in-error/cancelled; S6 lists on-hold/revoked/entered-in-error/unknown. DiagnosticReport has a "correction" status [S7]. The HL7 page says nothing about cancels or corrections [R3]. | Which values actually occur in our tenant. Whether an amendment updates in place or creates a new ID. | AP-READ | PROP-API / FHIR-R read (status + `lastUpdated`). MANUAL. | Each poll | MANUAL notice from the office or a pathologist | A cancellation keeps the record visible, with the reason. Affected work orders, print jobs and prepared material go to a **review queue**. Records of physically prepared work are never erased. |
| **Change events: "no events" vs. "source unavailable"** | The adapter (companion) | **Not documented as push.** Search supports a `_lastUpdated` filter documented as a date (yyyy-mm-dd) [S5, S7]. Rate limits are 1,250/min per key [S11] vs. 1000/min in the 429 text [S5]. | Whether finer time precision is accepted. Whether deletions are visible. The source's clock. | AP-READ | Polling adapter with a cursor and an overlap window | Scheduled poll. Interval set within rate limits. | Banner showing data age. Printable snapshot with generation time. | Each poll is classified (Section 6, rule 11). Only a complete, successful poll advances "last successful sync." **An empty result is "no changes" only if the call succeeded and every page was read.** |

### 3.7 Write actions (action by action)

| Action | Documented? | Mode A | Mode B | Mode C | Mode D |
|---|---|---|---|---|---|
| Assign an accession number | Not documented | Simulator only | Never | Never | Never. EMA assigns it. |
| Correct an order's site, part or patient | Not documented (ServiceRequest is read-only [S5, S6]) | Simulated review record | Never | Never | Never. Use the lab's authorized correction process in EMA. |
| Merge patients or cases, or renumber | Not documented | Never | Never | Never | Never |
| Enter a gross description | Not documented | Staff attestation recorded locally; a labeled demo control can add "Source system acknowledged (simulated)" | MANUAL attestation | MANUAL attestation | Only if ModMed documents a supported path (AP-WRITE). Reconcile acknowledgements. |
| Create a clarification task in EMA | Documented resource (Task [S9]); suitability unknown | Simulated | No | No | Candidate, after AP-WRITE + AP-OFFICE |
| Upload a document to EMA | Documented (DocumentReference create [S10]) | No | No | No | Not planned. Would need clinical-records approval. |
| Send a notification | Not documented | Simulated, labeled | No | Approved channel only, generic text | Approved channel only |
| Drive a printer | Not documented | Simulated | No | No | Only after a device interface review (AP-WRITE) |

---

## 4. Adapter design

The companion talks to the outside world only through **adapters**: small, replaceable modules with one job each. The rest of the app never knows whether an adapter is simulated or real; it only sees each adapter's declared capabilities.

| Adapter | Purpose | Mode A implementation |
|---|---|---|
| Source system (one per tenant) | Read orders, encounters, documents and references. Report capabilities. | Simulated source with the EMA-SIM Sunrise Coast and OTHER-EHR-SIM Gulf tenants. Issues accession D26-04817 on request. |
| Import (Mode B) | Parse an approved export into **our** fixture schema | Fixture importer (our schema, documented in the repo) |
| Notification | Send generic notifications and track delivery states | Simulated outbox, visibly labeled. It never contacts anyone. |
| Printer | Submit jobs, query status, report outcome | Simulated printer that can time out with an unknown outcome |
| Model provider (optional) | Extract candidate fields, draft clarifications, summarize | Deterministic demo outputs, labeled. The core workflow works with no model. |

### 4.1 Capability discovery

Each adapter publishes a **capability manifest**: one entry per field or action in Section 3. Every capability is described with exactly one of **four words**, used the same way in every document and on screen:

| Word | Meaning |
|---|---|
| **Simulated** | Works in this demo only through a simulated connector (Mode A). Says nothing about the real system. |
| **Documented** | A public vendor page describes it (with R#/S# evidence). It has **not** been tested for this lab. Partial documentation is still "Documented", with the gaps listed under Unknowns. |
| **Unknown** | No public documentation was found. This is a question for the vendor, not proof that the feature is missing. |
| **Unsupported** | Not offered, or deliberately not used in this project (for example, writing a diagnosis). |

"Implemented" is never used for a connector: in this project no connector to a real system exists. If discovery later confirms a capability for this lab, the entry should also record the evidence (meeting notes or a test run ID), who confirmed it and when, and the lowest rollout mode allowed to use it. Nothing is upgraded automatically.

**As built (Mode A).**
- Each simulated adapter row (`integration_source` in `src/server/db/schema.sql`) stores a small JSON map from capability name to a plain-text note, for example `"orders.read": "simulated"`, `"accession.issue": "simulated — real path unknown"`, `"gross_text.write": "not available — manual entry in source system"`. The Settings → Integration capabilities tab shows each connector with its last successful sync, last attempt and these notes.
- The same tab shows a **field-by-field capability summary**, one row per required field or action, each with one of the four words, the unknowns, the candidate interface and the fallback. It is condensed from Section 3 of this document and lives in code (`CAPABILITY_MATRIX_SUMMARY` in `src/server/queries/settings.ts`). A domain test checks that only the four words are used.
- There are no `verifiedBy` / `verifiedAt` fields in the demo, because nothing has been verified.
- Where a machine-readable statement exists, a future adapter may *read* it as a hint. ModMed's portal lists a FHIR CapabilityStatement page [S12], but the page that was checked is a stub that lists no resources (see `research-notes.md` §4), and a standard statement would not cover Pathology-module internals.

### 4.2 Mock implementations

The simulated source adapter delivers messages from a seeded outbox as the demo clock passes their "available" time, and only while the source is connected. Settings → Demo scenarios offers these controls, each labeled as a demo control:

| Scenario | How it is triggered in the demo | Acceptance check |
|---|---|---|
| Normal | Default; the clock moves and due messages are delivered | — |
| Slow link | "Slow link (5 min delay)" per source | #13 |
| Outage (source unavailable) | "Simulate outage" / "Restore connection" per source; while offline nothing is delivered and the backlog is delivered once on restore | #13 |
| Duplicate delivery | Seeded at 11:04 (a re-delivery of `ORD-77118#v1`) and "Replay a duplicate message" | #11 |
| Out-of-order (older version) | Seeded at 11:25 (a stale replay of an earlier order version) and "Deliver an out-of-order older version" | #11 |
| Order amended after review | The hero amendment `ORD-77121` v2, made available about one minute after the simulated office answer | #11, #14 |
| Stain canceled after printing | Seeded at 11:20: PAS removed from order `ORD-75061` after its PAS slide label was printed (work order WO-2142) | #14 |
| Processing failure | "Fail the next message" (the message waits in the failure queue until a supervisor retries it) | failure queue |
| Deliver everything now | "Deliver queued source messages now" | #11, #13, #14 |

Not simulated in this build: **rate limiting (429)** and **partial page failure**. The simulated source has no paging, so these two are described in the contract below but not exercised; they would need tests against a vendor sandbox. Printer, notification and assistant failures have their own controls on the same tab (printer online / offline / time out after submit; notifications fail; assistant unavailable).

Simulated data is labeled on screen (a "Simulated" tag next to the source freshness indicator and connector cards, and a global demo banner). The demo clock controls the simulator's timestamps; storage is UTC and display is America/New_York.

### 4.3 Contract tests

These contracts describe how *any* source adapter must behave. In this build they are checked by domain tests against the simulator (mainly `tests/domain/integration.test.ts`, plus `materials.test.ts` for printing). They are not yet packaged as a reusable suite that could run against a vendor sandbox; that would be future work if access were ever approved. The "In this build" column says what exists; `acceptance-tests.md` is authoritative for which tests exist and their last recorded results.

| Contract | Expected behaviour | Related acceptance check | In this build |
|---|---|---|---|
| Re-delivering the same order version | No new rows, tasks or print jobs. A "duplicate received" event is logged. | #11 | Domain test against the simulator |
| An older version arrives after a newer one | Not applied. Logged as stale. | #11 | Domain test against the simulator |
| Same MRN in two tenants | Two distinct patient references | #3 | Domain test |
| Order amended after work started | A review task. Nothing erased. | #14 | Domain test against the simulator |
| Order or stain canceled after printing | Stays traceable. Review task for printed or prepared material. | #14 | Domain test against the simulator |
| Source outage, then restore | Data marked stale during the outage. On restore, catch-up with no duplicates. | #13 | Domain test against the simulator |
| 429 / timeout / partial page | Classified "source unavailable." Cursor not advanced. Retry with backoff. | #13 | **Not simulated** (no paging or rate limit in the simulator) |
| Completing local work | Never creates a source write | #13 | Domain test (approving, attesting or completing local work creates no source write) |
| Printer timeout after submit | Unknown outcome until reconciled. Retry is blocked. | #8 | Domain test |
| Capability `Unknown` | The UI asks for manual attestation and does not show a default value | (data honesty) | Partly: unknown values are shown as "Unknown"; there is no automatic UI switch driven by the capability notes |

---

## 5. Rollout modes

| | **A. Local demonstration** | **B. Approved shadow evaluation** | **C. Small live operational pilot** | **D. Selective supported writeback / printer control** |
|---|---|---|---|---|
| Data | Generated synthetic data only | Selected source data through an approved export or supported read interface (FHIR-R / PROP-API read / HL7 copy). The importer uses our schema; we don't assume an EMA export format. | Validated field mapping for one office/team or one station | As C, plus specific reviewed write or device actions |
| Connectors | Source, notifications, printer and AI all simulated and labeled | Read-only. No notifications. No printer. | Read-only source. An approved notification channel if agreed. | Only the actions reviewed under AP-WRITE |
| Credentials | None | Issued to the organization under AP-READ, never personal staff logins | Same as B | Same as B, plus write scopes |
| Authoritative | The simulator plays EMA | EMA. Staff keep working normally in EMA. | EMA for clinical data. The companion holds only the agreed operational records (e.g., clarification tracking, digital worklist). | EMA. Writes count only once the source **acknowledges** them. |
| Gate to enter | None (local repo) | AP-READ, a data agreement, a defined scope and time limit, and a mapping review | AP-LOCAL, AP-OFFICE where relevant, staff training, a documented fallback (printed snapshot / paper) | AP-WRITE for each action, sandbox testing, a rollback plan |
| Measure | User feedback on workflow assumptions only. **Not performance.** | Mapping errors, data freshness, discrepancies caught or missed, and **duplicate work the companion adds** | The pilot metrics in the proposal, including the burden the pilot itself creates | Acknowledgement latency, failed or unknown writes, reconciliation effort |
| Stop / rollback | Reset command | Stop the import. Handle stored data per the data agreement. | Revert to the paper/EMA process. Keep the audit history. | Disable the write adapter. Fall back to manual entry. |

---

## 6. Data-sync rules

1. **Namespaces.** Every external identifier is stored with its tenant or namespace and shown with it, e.g., "D26-04817 · EMA-SIM DERM." Local identifiers use visibly different patterns: INT-1014-031, REL-0112, CLR-0457, H-0090, WO-2142, PJ-8841, TRY-M-03, RR-0192. A name is never a key.
2. **Original and working values.** The raw source value, the normalized working value, the source update time, the import time, provenance and review state are all kept.
3. **Idempotency.**
   - Import key = namespace + source ID + source `lastUpdated` + content hash. Importing an identical payload again is a logged no-op.
   - Local actions carry a request ID, so double clicks and retries don't duplicate tasks or print jobs.
4. **Out-of-order updates.**
   - Apply an update only if its source time is newer than the stored one.
   - Older updates are kept in history as "late, not applied."
   - Same time but a different hash goes to conflict review.
   - Because `_lastUpdated` is documented at date granularity [S5], each poll re-reads an overlap window and relies on deduplication.
5. **Reviewed values win until reviewed again.** A source change to a value a person has already reviewed creates a "source changed after review" task. It does not silently overwrite.
6. **Corrections and amendments.** The new version is appended and the original is preserved. Dependent local work (holds, worklist rows, print jobs, prepared slides) gets a reconciliation task. Records of physically prepared work are never erased.
7. **Cancellations.** The cancelled item stays visible, with its status, reason and time. Affected work orders and print jobs go to review. Physical material stays traceable.
8. **Retries.**
   - Transient failures retry with increasing delays and some randomness.
   - On 429, slow down and stay within the lower documented limit [S11, S5].
   - After a capped number of attempts, the message goes to the failure queue.
   - In Mode D, a write is retried only after checking whether the earlier attempt landed (the same rule as a printer's unknown outcome).
9. **Failure queue.** Messages that fail validation or keep failing are held with their reason, a payload reference, timestamps and an owner (the integration owner role). An owner can replay or dismiss them with a reason. Dismissing does not delete.
10. **Last successful sync.** Tracked per feed (orders, encounters, documents, …). It advances **only** when a poll succeeded and every page was read.
11. **"No events" vs. "source unavailable."** Every poll gets one of three outcomes:

    | Poll outcome | Condition | Effect |
    |---|---|---|
    | `ok-changes` | Call succeeded and returned changes | Changes applied; last successful sync advances |
    | `ok-no-changes` | Call succeeded, every page read, and nothing new | Last successful sync advances |
    | `unavailable` | Error, timeout, 429, partial pages, or authentication failure | Last successful sync does **not** advance; the cursor does not move; the attempt time and error are recorded |

    The UI never shows "no new work" when the source is unavailable.
12. **Freshness display.** One display set is used everywhere (top bar, worklist, operations, case view, settings): **Synced / Delayed / Offline / Unknown**, always with a **Simulated** tag in this demo. The word "Live" is not used.

    | Display | Rule (demo thresholds; illustrative, not clinical) |
    |---|---|
    | **Synced** | Last successful sync 5 minutes ago or less, and the source is not reported down |
    | **Delayed** | Last successful sync more than 5 and up to 15 minutes ago, or the source is reported slow |
    | **Offline** | The source is reported down (simulated outage), or no successful sync for more than 15 minutes. Text: "unreachable since … Showing last confirmed data." |
    | **Unknown** | No successful sync has ever been recorded |

    Mapping from poll outcomes: `ok-changes` and `ok-no-changes` reset the age to zero (Synced). `unavailable` leaves the last successful sync where it was, so the display ages from Synced to Delayed to Offline as time passes. A 429, timeout or partial page therefore always counts as "source unavailable" and never as "no changes". (As built, the simulator models only "connected", "slow" and "offline"; see Section 4.2.) As built, the top-bar indicator follows this table exactly. The source freshness panels on the worklist, operations and case pages differ in one case: a connected source with no successful sync for more than 15 minutes is shown as **Delayed** with "Data may be out of date" (flagged stale), not as Offline; they show Offline only for a reported (simulated) outage.
    - Printed or exported snapshots show generation time, data as-of time and version.
    - **An outage must never make an old worklist look current.**
13. **Separation of data.** Source clinical data and local task events are stored separately. Completing a local task never implies a write to the source.
14. **Recovery.** When the source comes back, re-poll from the last successful sync minus the overlap window, deduplicate, reconcile, and report what was recovered.
15. **Time.** Store in UTC. Keep source timestamps with their original offset. Display in America/New_York with an explicit date.
16. **Audit.** Every import, decision, override and attestation is written to the local append-only audit table. This is a local implementation. It is **not** proof of production-grade tamper resistance.

**As built in the demo (Mode A), where it is simpler than the rules above:**
- Idempotency of imports uses the source message ID (unique per source) plus the order's source version number, not a content hash. A re-delivered message is logged as "duplicate ignored" and every receipt is kept in an append-only receipt log.
- Ordering uses the source version number: an older or equal version is logged as "stale, ignored". The same version number re-sent with different content is also ignored and opens a review task.
- Rules 4 (overlap window) and 8 (backoff and 429 handling) apply to a real polling adapter; the simulator has no paging, rate limit or backoff.
- The failure queue exists: a message that fails processing is kept with its reason and a supervisor can retry it.
- Last successful sync is tracked per simulated source (not per feed).

---

## 7. What we must NOT do

- **Do not** scrape, screen-read, record or automate the employer's EMA session or any other employer system. Browser automation in this project is only for testing our own local app.
- **Do not** connect to an employer database, network share, printer or interface engine. Do not use any staff member's personal credentials.
- **Do not** put real patient data, employer screenshots, internal reports (including "the bible"), signatures, credentials or real contact details in the repository or the demo.
- **Do not** send messages to real offices or people. Notifications stay simulated.
- **Do not** install the app on a lab workstation, deploy it, or publish it as part of this work.
- **Do not** apply for API access, sandboxes or HL7 connections on the lab's behalf. Do not use a practice's sandbox without that practice's permission [S2]. Those are organizational decisions.
- **Do not** invent vendor URLs, endpoints, export formats or capabilities. "Not documented" stays "unknown" until ModMed confirms it.
- **Do not** assign, renumber or merge accessions, patients or cases. Do not change a site, part letter or label in the authoritative record. Do not show a local draft as entered in EMA.
- **Do not** put patient information in ordinary notification text by default.
- **Do not** infer PAS or other work from diagnosis text, and do not let AI resolve clarifications, match specimens or approve records.
- **Do not** describe the demo as compliant, validated, endorsed, or proof of clinical performance or production integration.

---

## 8. Top unknowns blocking Mode B (for the ModMed / lab discovery conversation)

1. Which EMA product, modules and pathology options are licensed and enabled at the lab, and are the offices in one tenant?
2. How does a multi-part biopsy appear when an office enters parts A and B separately (ServiceRequest, RequestGroup, encounter, accession)?
3. Can any supported interface expose accession number and namespace, part letters, block/slide IDs, gross text, stain/PAS orders and pathologist assignment? Are historical changes and cancellations included?
4. Which ServiceRequest status and category values actually appear for pathology orders? Which documented rate limit applies?
5. Are any write actions supported for the lab's use case (e.g., Task for clarifications)? What are the review, fees, sandbox data and acknowledgement semantics?
6. What printers, scanners and label stock exist? Can EMA drive them, and what status do they report?
7. How does the other-EHR office (Lighthouse in the demo) send orders today?
