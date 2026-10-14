# Research Notes: Source Verification (R1–R12)

**Project:** Histology Lab OS, a companion to the existing EHR/LIS for operational coordination and specimen tracking
**Prepared by:** Jorge Rodriguez (histology assistant), with AI-assisted source checking
**Access date for every source below:** 2026-10-14
**Status:** Working notes for internal discussion. These notes are not legal, regulatory, accreditation or procurement advice. They don't claim that any director, laboratory or vendor endorses, approves or partners with this project.

---

## 1. How to read these notes (plain English)

- **What a source "establishes"** is what it actually says, paraphrased. The notes say whether it is a vendor claim, guidance, or a published study.
- **What it does NOT establish** is the gap between that source and *our* lab. For example, a product page saying a feature exists doesn't tell us whether our lab has licensed it, turned it on, or set it up to fit our workflow.
- **Brief vs. source** records whether the master specification describes the source accurately.
- Quotations are kept to a few words. Everything else is paraphrased.
- "R#" refers to the master specification's reference list. "S#" refers to supplementary ModMed API Portal pages that were found while rechecking R2 and R4 (Section 4).

### How each source was retrieved

| Method | Used for | Caveat |
|---|---|---|
| Direct page fetch | R2, R4, R6 (article page), R10, R11, R12, S1–S12 | None |
| Direct fetch returned only the page title. Content was read through a public reader-proxy rendering (r.jina.ai) of the same URL. | R1, R3 | Plain command-line requests to modmed.com returned HTTP 403, which looks like bot protection. The proxy text is a third-party rendering. **Before presenting, a person should recheck R1 and R3 in a normal browser.** |
| PDF downloaded (HTTP 200), then text extracted locally | R5 | Text extraction can lose table layout. Section names and page numbers were checked against the table of contents. |
| PubMed metadata/abstract via the PubMed API | R6, R7, R8, R9 | PubMed web pages returned an HTTP 203 interstitial to command-line requests, so the PubMed records (not the HTML pages) were used. Only abstracts were read for R7–R9; the full text of R6 was readable on the publisher page. |

---

## 2. Summary table

| Ref | Source | URL status (2026-10-14) | Date / version | Type | Brief vs. source |
|---|---|---|---|---|---|
| R1 | ModMed, Pathology Lab Reporting Software | Resolves. Bot-protected; read via reader proxy. | No date shown | Vendor marketing page | Consistent, with one wording difference: the page says label printing is handled "in most cases"; the brief says "in many cases" |
| R2 | ModMed API Portal, Getting Started | Resolves (200) | Page metadata: updated 2026-05-01 | Vendor developer docs | Consistent |
| R3 | ModMed, HL7 Connectivity ("EMA HL7 Connections") | Resolves. Bot-protected; read via reader proxy. | No date shown | Vendor integration page | Consistent. Direction is described from EMA's point of view (see notes). |
| R4 | ModMed API Portal, ServiceRequest (Orders) | Resolves (200) | Page metadata: updated 2026-06-29 | Vendor API reference | Consistent. Several documentation inconsistencies are noted below. |
| R5 | CAP/NSH, Practical Guide to Specimen Handling in Surgical Pathology | Resolves (200, 56-page PDF) | Version 12.0, revised March 2025 | Professional guidance | Consistent |
| R6 | Heher et al., *Achieving High Reliability in Histology*, Am J Clin Pathol 2016;146(5):554–560 | Publisher page loads in WebFetch (403 to plain curl). PMID 28430956. | Online 14 Nov 2016; issue Nov 2016 | Single-center improvement study | Consistent |
| R7 | Weaver et al., *Wrong Tissue in Block*, Am J Clin Pathol 2021;156(4):700–707 | PubMed record retrieved. PMID 33940603. | PubMed date 2021 Sep 8 | Single-institution before/after study | Consistent |
| R8 | Ye, Tan, Shum, *Using Timestamp Data to Assess the Impact of Voice Recognition on the Efficiency of Grossing Biopsies*, Arch Pathol Lab Med 2021;145(5):599–606 | PubMed record retrieved. PMID 32960950. | 2021 May 1 | Single-practice evaluation study | Consistent |
| R9 | Ho, Aridor, Parwani, *Use of contextual inquiry to understand anatomic pathology workflow*, J Pathol Inform 2012;3:35 | PubMed record retrieved. PMID 23243553, PMC3519008. | 2012 Sep 28 | Qualitative observational study | Broadly consistent. The study observed **pathologists**, not histology staff (see notes). |
| R10 | Leica Biosystems, CEREBRO Workflow Management System | Resolves (200) | No date shown; ©2026 footer | Vendor product page | Consistent |
| R11 | Milestone Medical, MacroPATH | Resolves, **redirects** to `https://www.milestonemedsrl.com/us/products/grossing-and-macro-digital/macropath/` | No date shown | Vendor product page | Consistent |
| R12 | Epredia, Microscope Slide Printers | Resolves (200) | No date shown; ©2026 footer | Vendor product page | Consistent |

---

## 3. Per-reference notes

### R1. ModMed, Pathology Lab Reporting Software
URL: https://www.modmed.com/what-we-do/pathology/ (title as rendered: "Pathology"; on-page heading is about pathology lab reporting software for dermatology)

- **Establishes (vendor claims):**
  - ModMed markets a Pathology module that works with its EMA EHR. ModMed says it can make a practice nearly paperless and can receive requisitions, track them through the lab, and send dermatopathology results back.
  - Gross defaults, built-in diagnoses, abbreviations and stains can be customized. The page describes a built-in library (it cites more than 950 diagnoses and 100 stains) that can be tailored.
  - Each pathologist, facility and workflow can have its own accession sequence.
  - In an FAQ, ModMed says the module handles slide or cassette label printing "in most cases."
  - Cases can be located by accession number or patient name. Built-in reports cover productivity, stains and billing. Module access can be limited to designated users.
  - A customer testimonial says gross description entry became almost four times as fast. This is a vendor-published testimonial, not independent evidence.
- **Does NOT establish:** what our lab has licensed, enabled or configured; how label printing works with our printers; whether accession sequences are set up per pathologist at our lab; whether any of these functions are reachable through an interface; or anything about offices on other EHRs.
- **Brief vs. source:** The brief's list matches. One wording difference: the source says "most cases," not "many cases." We should quote the source's wording.
- **Pilot implication:** Before building anything that duplicates these functions (gross templates, stain lists, label printing, per-pathologist accession sequences), ask ModMed to demonstrate them with our lab's actual configuration. This is the "configure before build" step.

### R2. ModMed API Portal, Getting Started
URL: https://portal.api.modmed.com/docs/getting-started (page metadata: updated 2026-05-01)

- **Establishes:**
  - ModMed offers two API programs.
    - **EMA Proprietary API:** read, search, create and update for many resources. Aimed at "operational" problems. Accessed through the synapSYS Marketplace program.
    - **Certified FHIR API:** read and search only, plus Bulk FHIR export, using SMART on FHIR. Vendors register themselves, and customer endpoints are published as required by federal rules.
  - Proprietary-API vendors get a backend sandbox, agree the needed resource access lists with the synapSYS team, and must pass a technical review before reaching their first customer's production system.
  - HL7 integrations are requested separately through ModMed.
- **Does NOT establish:** which resources are available; anything specific to pathology, accessioning or histology; fees; per-practice authorization steps; or whether a small internal project would qualify for the program. The page doesn't list resources at all. They were found through the portal index (S12).
- **Brief vs. source:** Consistent.

### R3. ModMed, HL7 Connectivity
URL: https://www.modmed.com/what-we-do/integrations/synapsys/hl7/ (title as rendered: "EMA HL7 Connections"; no date)

- **Establishes:** HL7 interface categories, with direction described from EMA's point of view.

  | Category | Direction |
  |---|---|
  | Orders (ORM) | Outbound. Includes "clinical and pathology lab orders." |
  | Results (ORU) | Inbound. Includes "clinical and pathology lab results." |
  | Demographics (ADT) and Scheduling (SIU) | Outbound for Practice Management customers; inbound for EHR-only customers |
  | Charges (DFT) | Inbound for Practice Management customers; outbound for EHR-only customers |
  | Visit notes | Outbound, as a base64-encoded PDF (ORU) |
  | Inbound documents | Inbound, as a PDF (ORU) |

  Existing customers request a connection through their account manager.
- **Does NOT establish:** HL7 version; fees; how amendments, corrections or cancellations are sent; or any internal histology fields (accession, parts, blocks, slides, gross text, stains, assignment).
- **Important nuance for our lab:** These feeds describe an EMA practice sending orders to an outside lab and receiving results back. A related ModMed page (S13) says in-house labs can use the Pathology module to connect the EHR to their own lab. If our lab and its offices work inside EMA with the Pathology module, the order may never travel over HL7 at all. The HL7 path may matter only for an office on another EHR (in the demo, Lighthouse Skin Center). This is unknown and goes on the discovery checklist.
- **Brief vs. source:** Consistent ("outbound pathology orders and inbound pathology results").

### R4. ModMed API Portal, ServiceRequest (Orders)
URL: https://portal.api.modmed.com/reference/servicerequest-orders (page metadata: updated 2026-06-29)

- **Establishes:**
  - ServiceRequest returns orders that can be placed electronically in EMA. It is based on the standard FHIR ServiceRequest profile with EMA-specific settings.
  - Documented fields:

    | Field | What the page says |
    |---|---|
    | `id`, `lastUpdated` | Identifier and last-updated time |
    | `requisition` | The EMA order number |
    | `status` | Listed values: draft, active, closed |
    | `category` | Listed values: Surgical, Therapies, Radiology |
    | `code` | CPT, LOINC or compendium code |
    | `subject` | Described as a reference to an Encounter |
    | `requester` | Reference to a Practitioner |
    | `bodySite` | Filled only if the practitioner selected a body location in EMA |
    | `reasonCode` | Usually ICD-10 |
    | `note` | Free text |
    | `supportingInfo` | Reference to the order PDF |
    | `basedOn` | Reference to a RequestGroup |
    | `insurance` | Reference to coverage |

  - Access can be limited to orders where the vendor is the selected performer, or opened to all ServiceRequests. ModMed Integration applies whichever setting is agreed.
- **Does NOT establish:** separate fields for laterality, part designation (A/B), biopsy method, specimen container or count; how a multi-part biopsy is represented (one order with several sites, several orders, or a RequestGroup); order version history; or any write operation. The proprietary search page (S5) documents only reading (GET).
- **Documentation inconsistencies to raise with ModMed:**
  - The status values differ between three pages: R4 (draft/active/closed), S5 (adds suspended, completed, entered-in-error, cancelled) and S6 (adds on-hold, revoked, unknown).
  - The category list in R4 (Surgical/Therapies/Radiology) differs from S5's example data, which shows a Pathology category.
  - `subject` is described as an Encounter reference, which is unusual for FHIR. This needs sandbox confirmation.
- **Brief vs. source:** Consistent (requisition, requester, body site, supporting order document).

### R5. CAP/NSH, Practical Guide to Specimen Handling in Surgical Pathology
URL: https://www.cap.org/wp-content/uploads/documents/Practical_Guide_to_Specimen_Handling_in_Surgical_Pathology_2025.pdf?download=true (Version 12.0, revised March 2025; written by members of the CAP/NSH Histotechnology Committee; checklist references updated to the December 26, 2024 CAP checklist edition)

- **Establishes (guidance, not requirements):**
  - **Identification:** at least two patient-specific identifiers. At accessioning, compare each container with the requisition, including the number of containers and the specimen type.
  - **Discrepancies:** labs should have a written procedure for labeling discrepancies. In some cases only the originator should correct a label. The label and requisition must match (the guide names gender and site as common mistakes). Records of errors should be kept.
  - **Remote sites:** specimens from remote sites need a documented tracking system so the lab can confirm they were all received.
  - **Barcodes and RFID:**
    - A unique barcode should be used consistently on the container, requisition, cassette and slide labels.
    - Label stock and scanning equipment should be validated against processing chemicals.
    - Barcodes must not be the only identifier; human-readable text is also required.
    - If barcodes are used for chain of custody, the tracking system needs location capability.
  - **Cassette identifiers** should include accession (year and type), specimen and block designations.
  - **Accessioning practice:** avoid accessioning look-alike specimens back to back.
  - **Microtomy:** guidance covers label placement and limiting one patient's tissue to a slide.
- **Does NOT establish:** compliance by itself. The disclaimer says it is a guideline only, labs should adapt it to local requirements, and following it does not guarantee CAP accreditation compliance. The committee intends to revise it about every two years, so check for a newer version before relying on it.
- **Brief vs. source:** Consistent.

### R6. Heher et al., 2016, Achieving High Reliability in Histology
URL: https://academic.oup.com/ajcp/article/146/5/554/2529661 · DOI: [10.1093/ajcp/aqw148](https://doi.org/10.1093/ajcp/aqw148) · PMID 28430956 (retrieved from PubMed and the publisher page)

- **Establishes:**
  - A 36-month improvement series at Beth Israel Deaconess Medical Center (Boston).
  - **Error rates** (labeling errors per case):

    | Period | Rate | Errors / cases |
    |---|---|---|
    | Baseline | 1.03% | 794 / 76,958 |
    | After barcode-enabled LIS | 0.28% | 107 / 37,880 |
    | After single-piece microtomy workflow ("ice tool box") | 0.22% | 119 / 54,342 |

  - **Error sources:** in the Results section, the two biggest root causes were manual slide printing (about 44% of errors) and the microtome station (about 24%).
- **Does NOT establish:** an effect size for our lab or for a companion app. The rates are per case, from one academic center with its own LIS and Lean program. The periods have different lengths and denominators.
- **Brief vs. source:** Consistent.

### R7. Weaver et al., 2021, Wrong Tissue in Block
URL: https://pubmed.ncbi.nlm.nih.gov/33940603/ · DOI: [10.1093/ajcp/aqab011](https://doi.org/10.1093/ajcp/aqab011) (abstract via PubMed)

- **Establishes:** University of Florida, using Epic Beaker. Wrong-tissue-in-block (WTIB) rates changed as follows:

  | Period | WTIB rate | Incidents / cases |
  |---|---|---|
  | Before block confirmation | 0.043% | 17 / 38,848 |
  | Block confirmation mandated (3 months) | 0.043% | 2 / 4,646 |
  | After a custom "hard stop" that prevents unconfirmed blocks from going onto a packing list | 0.005% | 2 / 42,411 |

  The authors report an 88.4% reduction (P < .001).
- **Does NOT establish:** that any barcode feature alone reduces errors. The mandate-only period showed no change. The findings come from one institution's LIS customization.
- **Brief vs. source:** Consistent. The detail that mandating alone didn't move the rate strengthens the brief's point that process matters.

### R8. Ye, Tan, Shum, 2021, voice recognition and grossing efficiency
URL: https://pubmed.ncbi.nlm.nih.gov/32960950/ · DOI: [10.5858/arpa.2020-0115-OA](https://doi.org/10.5858/arpa.2020-0115-OA) (abstract via PubMed)

- **Establishes:**
  - Dahl-Chase Pathology Associates (Maine) measured "specimen time" from barcode scan timestamps (bottle scan to first cassette scan).
  - Specimen complexity, prosector variability, clinical-text length and daily workload drove specimen time. Adopting voice recognition had a negligible effect.
  - The authors conclude that it removed the need to hire transcriptionists. They suggest auto-filling clinical information from the electronic order interface as a future improvement.
- **Does NOT establish:** faster grossing, error prevention, or savings for our lab. The cost conclusion depends on that practice's staffing.
- **Useful idea:** existing scan timestamps can be used to measure process time, if our system records them (unknown).
- **Brief vs. source:** Consistent.

### R9. Ho, Aridor, Parwani, 2012, contextual inquiry of AP workflow
URL: https://pubmed.ncbi.nlm.nih.gov/23243553/ · DOI: [10.4103/2153-3539.101794](https://doi.org/10.4103/2153-3539.101794) (abstract via PubMed)

- **Establishes:**
  - At UPMC, researchers observed and interviewed six pathologists using contextual inquiry. They recorded 254 notes, grouped into technology, communication, synthesis/preparation, organization and workflow.
  - They found the AP workflow labor-intensive and not scalable.
  - They concluded that a digital slide system should integrate with the AP laboratory information system.
- **Does NOT establish:** anything about histology bench staff, accessioners or dermatology offices. The subjects were pathologists, the context was digital-pathology design, and the study is from 2012.
- **Brief vs. source:** Broadly consistent. The brief should say the study observed *pathologists*. The "integration" conclusion concerned digital slide systems. The method (observe real work before designing screens) is the transferable lesson.

### R10. Leica Biosystems, CEREBRO
URL: https://www.leicabiosystems.com/us/tracking-and-workflow/cerebro/ (no date; ©2026)

- **Establishes (vendor claims):**
  - CEREBRO is a modular identification, tracking and workflow system for histology and cytology.
  - **ID:** barcode printing on labels, slides and cassettes, with Leica or third-party printers. Connects to an LIS and instruments.
  - **ID+:** on-demand printing, for example at the microtome after scanning.
  - **TRACK:** workstations for accessioning, grossing, processing, embedding, sectioning and send-out, with a per-item audit trail.
  - **COMMAND:** counters, missing-work warnings, pending-work screens, KPI and turnaround reports, and integrity checks for wrong slide or cassette.
- **Does NOT establish:** outcome data (none is given); the interface standard it uses; compatibility with EMA; regulatory status; or price.
- **Brief vs. source:** Consistent.

### R11. Milestone Medical, MacroPATH
URL: https://www.milestonemedsrl.com/products/grossing-and-macro-digital/macropath/, which redirects to the `/us/` path shown in the summary table (no date)

- **Establishes (vendor claims):**
  - A macro digital imaging system for the grossing area: camera photos, 4K or HD video, audio, foot-pedal control and a built-in microphone for voice notes.
  - A barcode reader opens a per-case folder. Tools estimate sizes and areas and support annotation.
  - Connects to LIS and PACS through DICOM, HL7, TWAIN and WIA.
  - The page also references cassette-image comparison at embedding through a tracking product.
- **Does NOT establish:** speech-to-text transcription accuracy; validated measurement from images; EMA interoperability; or outcomes (none is given). Image-based size estimates are a vendor feature claim. This project does not measure tissue from ordinary images.
- **Brief vs. source:** Consistent ("integrated grossing documentation").

### R12. Epredia, Microscope Slide Printers
URL: https://www.epredia.com/products/histology-instruments/slide-printing (no date; ©2026)

- **Establishes (vendor claims):**
  - Direct, on-demand printing on slides at microtomy.
  - Models: SlideMate Laser (600 dpi), TSP and AS (thermal transfer), and Pro (brochure only).
  - Matching slide consumables.
  - The page says direct printing avoids label-adhesive problems during staining.
  - Products are available in select geographies.
- **Does NOT establish:** LIS connectivity (not mentioned on this page); barcode symbology (DataMatrix is not named); solvent-resistance validation for our stainer; or compatibility with EMA label printing.
- **Brief vs. source:** Consistent.

---

## 4. ModMed API documentation recheck (R2, R4 and supplementary pages)

The portal publishes an index (S12) listing its reference pages. The pages below were read on 2026-10-14. URLs are given exactly as fetched; the `.md` versions are the Markdown renderings listed in that index. No endpoints were invented. Paths are mentioned only where a page documents them.

| ID | Page (URL as fetched) | Updated (page metadata) | Relevant content |
|---|---|---|---|
| S1 | EMA Proprietary API: https://portal.api.modmed.com/docs/ema-proprietary-api.md | 2026-05-01 | Lets connected apps use EMA and ModMed Practice Management functions. Request through the synapSYS Marketplace, an account manager, or synapsys@modmed.com. Doesn't list resources. |
| S2 | Getting Started (proprietary reference): https://portal.api.modmed.com/reference/getting-started-2.md | 2026-05-01 | Sandbox provisioning can take up to 2 weeks. Generic sandboxes contain sample patients, practitioners, locations and encounters. Using a **practice's own sandbox requires that practice's permission**. At the end of development the vendor must show it can read what it needs and write what it plans to write. Use is subject to ModMed API terms. |
| S3 | Development Basics: https://portal.api.modmed.com/reference/development-basics.md | 2025-01-17 | Environments: generic sandbox, practice sandbox, production. Production key only after desired resources are provisioned (up to 2 weeks) and a demo/technical review covering resources used and call frequency. |
| S4 | Basic Concepts: https://portal.api.modmed.com/reference/basic-concepts.md | 2025-01-17 | Each practice has its own URL prefix and must create practice-specific credentials. Patients have a unique ModMed ID (EMAID). **MRNs and other non-ModMed identifiers are not guaranteed unique.** Providers have a ModMed ID and NPI. |
| S5 | Proprietary ServiceRequest search: https://portal.api.modmed.com/reference/get_fhir-v2-servicerequest.md | 2026-06-29 | Read-only search (`GET /fhir/v2/ServiceRequest`). Filters: patient, encounter, status, category, authored, requester, requisition, and `_lastUpdated` (gt/eq/le with a **yyyy-mm-dd date**). Pages of at most 50. Its 429 response text mentions a 1000 calls/min default. |
| S6 | Certified ServiceRequest search: https://portal.api.modmed.com/reference/get_servicerequest.md | 2026-05-18 | FHIR R4, endpoints specific to each customer. Read/search scopes (`.rs`) for 23 resources, including ServiceRequest, DiagnosticReport, DocumentReference, Encounter, Observation, Practitioner, PractitionerRole, Location, Organization and Provenance. **No write.** |
| S7 | DiagnosticReport (Results): https://portal.api.modmed.com/reference/diagnosticreport-results.md (search page: https://portal.api.modmed.com/reference/get_fhir-v2-diagnosticreport.md) | 2026-06-29 | Used to find **results PDFs**. Status values: final/preliminary/correction/partial. Identifier links to the requisition; basedOn links to the ServiceRequest. Includes the PDF (presentedForm). Pathology is not mentioned. Search filters include `_lastUpdated`. |
| S8 | Certified Specimen search: https://portal.api.modmed.com/reference/get_specimen.md | 2026-06-24 | A search exists, filtered only by `_id` and `patient`. Fields are not described. Specimen is **not** in the listed SMART scopes. |
| S9 | Tasks/Recalls: https://portal.api.modmed.com/reference/tasksrecalls.md | 2026-08-28 | EMA Task supports create, read, update and search. Assignees are Practitioners or CareTeams. The task name prefix comes from the firm's value set. `basedOn` must resolve to a lab order of that firm. Status values: ready/received/completed/cancelled. Several fields are locked after creation. Notifications are not described. |
| S10 | Documents: https://portal.api.modmed.com/reference/documents.md | 2025-01-29 | DocumentReference supports read, search and create (upload in three steps; the temporary upload URL expires after 5 minutes). Categories are customer-defined, with examples like "Results - Pathology." Documents posted without a patient go to an unassociated queue. |
| S11 | Rate Limiting: https://portal.api.modmed.com/reference/rate-limiting.md | 2026-03-26 | 1,250 calls/min per API key (about 20 per second). This **conflicts** with the 1000/min stated in the 429 text on S5 and S7. |
| S12 | Portal index: https://portal.api.modmed.com/llms.txt | n/a | Lists all reference pages. **No pages found** for Subscriptions, webhooks, notifications, Communication (messaging), or anything pathology-specific (accession, part, block, slide, gross, stain). |
| S13 | ModMed synapSYS Lab Partners: https://www.modmed.com/what-we-do/integrations/synapsys/labs/ (read via reader proxy; linked from R3) | none shown | External pathology labs (many dermatopathology) connect through standard or enhanced interfaces: orders to the lab, results back with a PDF. In-house labs can use the Pathology module. Accessioning and tracking are not mentioned. |

Also checked: the Proprietary FHIR API page (https://portal.api.modmed.com/docs/proprietary-fhir-api.md, updated 2025-01-15) is a terms-of-use notice only. The Capability Statement page (https://portal.api.modmed.com/reference/capability-statement.md, updated 2026-04-29) is a definition stub that lists no resources.

### What the recheck found

1. **FHIR vs. proprietary is not only a difference in format.** The "proprietary" API also uses FHIR-shaped resources (paths under `/fhir/v2/`). The real differences are the program (synapSYS partner review vs. self-registration), write ability (proprietary can create or update *some* resources; certified is read-only), and scopes.
2. **Orders:** ServiceRequest is the best-documented resource for incoming orders. It is **read-only** in both APIs as documented.
3. **Results:** DiagnosticReport exposes result PDFs and status, including corrections. Whether in-house Pathology-module reports appear there is not stated. The companion should not import diagnoses anyway.
4. **Pathology internals:** No public page documents accession numbers, part designations, containers, cassettes/blocks, slides, gross description text, stain or work orders (PAS), pathologist assignment, label printing or storage. **"Not documented" does not mean "does not exist."** It is a question for ModMed.
5. **No push events are documented.** Change detection would rely on polling with `_lastUpdated`, which is documented at **date** granularity, within rate limits. The companion therefore must show data age and tell "no changes" apart from "source unavailable."
6. **Writes are documented for some resources** (for example Task, DocumentReference upload, Patient). Nothing documents writing gross text, accession data or order corrections. Any writeback in rollout Mode D is speculative until ModMed confirms a supported path.
7. **Sandbox and production gate:** Production access requires provisioning of agreed resources, a technical review and practice-specific credentials. A practice's own sandbox needs that practice's permission.

---

## 5. Discrepancies and items to recheck

| # | Item | Action |
|---|---|---|
| 1 | R1 says label printing works "in most cases"; the brief says "in many cases." | Use the source wording in the pitch and proposal. **Done 2026-10-14:** all project documents now say "in most cases," attributed to ModMed's FAQ, or paraphrase without quotation marks. |
| 2 | R1 and R3 could only be read through a reader proxy. | A person should recheck both in a normal browser before presenting. |
| 3 | R4, S5 and S6 list different ServiceRequest status values. R4's category list omits Pathology, but S5's example shows it. R4 describes `subject` as an Encounter reference. | Ask ModMed. Confirm in a sandbox if access is ever approved. |
| 4 | Rate limit: 1,250/min on S11 vs. 1000/min in 429 text on S5 and S7. | Design for the lower number. Ask ModMed. |
| 5 | R9 studied pathologists for digital-pathology design. | Describe it that way in the proposal. **Done 2026-10-14** in `product-brief.md` and `pilot-proposal.md`: six pathologists; the integration conclusion concerned digital slide systems and the AP information system. |
| 6 | R11's URL redirects to a `/us/` path. | Cite the final URL. |
| 7 | R5 is revised roughly every two years. | Check cap.org for a newer version before the director meeting. |
| 8 | `integration-capability-matrix.md` had cited API details that these notes do not record: a ServiceRequest `occurrenceDateTime` field, Patient create/update in the proprietary API, and CareTeam being readable. What these notes do record: S5 lists an `authored` search filter (it does not name an `authoredOn` field); S6 lists PractitionerRole among the readable resources; S9 says Task assignees can be CareTeams; §4 item 6 mentions Patient among resources with documented writes, but no S-row records the page. | **To verify** on the specific ModMed pages before any of these is quoted. The matrix now marks them "to verify". |
| 9 | R6's author attribution ("Heher et al.") comes from the publisher page; the master specification names no author. | Recheck on the publisher page before citing externally. |

---

## 6. What this means for the pilot

1. **Configure before building.** R1 suggests EMA's Pathology module may already cover gross defaults, stain lists, per-pathologist accession sequences, stain reports and label printing. The first discovery step is a ModMed demonstration using our lab's real configuration. If a gap disappears once something is configured, the companion should not duplicate it.
2. **The companion's reliable data today is local.** Public documentation supports reading orders (ServiceRequest), encounters, practitioners, locations, documents and result PDFs. It does not cover internal histology data. Until ModMed confirms otherwise:
   - accession numbers, parts, blocks, slides, gross text, PAS and other work orders, and assignment need an approved export or **manual attestation** (a named person confirms in the companion what EMA shows);
   - clarification records, holds, routing suggestions, print-job and tray simulations, and storage and custody records are **companion-owned operational records**.
3. **The A/B "two patients" question cannot be answered from documentation.** R4 has no part-designation or laterality field. How multi-part biopsies appear (separate ServiceRequests, a RequestGroup, or separate accession records) must be observed in our tenant. The companion proposes related-order candidates and never merges.
4. **Freshness must be visible.** Without push events and with date-granularity polling, any live view needs "last successful sync," data age, and a distinct "source unavailable" state.
5. **No writeback in early modes.** Gross descriptions continue to be entered in EMA by staff. The companion records a staff attestation ("Entered in source system (staff attested)", with who and when). That is not a source acknowledgment: "Source system acknowledged" requires a confirmation from the source itself, which only a supported interface could provide (simulated in the demo). A local draft is never shown as entered.
6. **Clarifications:** EMA Tasks (S9) are a documented create/update resource that might carry lab-to-office clarifications inside EMA. Whether that works across offices, who is notified, and whether the current EMA message channel is the underlying problem are all unknown. Agreement with the offices on ownership and escalation matters more than the channel.
7. **The evidence supports process design, not promised results.**
   - R6 and R7 show that barcodes work alongside workflow changes and hard stops.
   - R8 shows that voice capture affects transcription, not grossing speed.
   - R9 supports observing work before designing screens.
   - R5 gives a checklist-style reference for identifiers, discrepancies and barcode validation, to review with lab leadership.
   - None of these sources gives an effect size for our lab.
8. **Commercial products exist** (R10–R12) for tracking, on-demand printing and grossing documentation. The pilot proposal should compare configuring EMA, buying a specialist product, and building a targeted companion. Prices require vendor quotes.
9. **Measurement idea from R8:** if EMA or the label printers record scan or print timestamps, they might give a baseline without new data entry. Whether these timestamps exist and can be accessed is unknown.

---

## 7. Limits of this check

- Only public pages were read. No ModMed account, sandbox, PDF manual or customer-only documentation was accessed.
- For R7–R9, only abstracts were read.
- Vendor pages (R1, R3, R10–R12, S13) are marketing claims and were not independently verified.
- Nothing here establishes what our laboratory licenses, configures or is authorized to access.
