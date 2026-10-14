# Discovery Checklist

**For the Director of Operations, Medical Director, and the ModMed account/integration team**

*Prepared by Jorge Rodriguez, histology assistant · 2026-10-14 · Draft*

## How to use this

- These questions **do not block** the synthetic demonstration. The demo runs on made-up data with simulated connections, using the default assumptions listed in the last column.
- A **default assumption is what the demo pretends**, not a claim about our lab, EMA, or any vendor. Each answer may change the design.
- Items marked **\*** come directly from the project brief's discovery list. Unmarked items were added because they affect the design or the pilot.
- Ask vendors to demonstrate with **test data**. Do not share patient information during discovery.
- Record answers with the date and who answered. "We don't know" is a valid answer and is recorded as such.

### Who can answer (abbreviations)

| Code | Role |
|---|---|
| DO | Director of Operations |
| MD | Medical Director |
| MM-A | ModMed account team / pathology product specialist |
| MM-I | ModMed integration / API team |
| IT | Lab or practice IT |
| PS | Privacy / security / compliance officer |
| SUP | Operations or lab supervisor |
| AL | Accessioning lead |
| GR | Grosser |
| HT | Histotechnologist lead |
| OFF | Submitting office managers |
| HR | Human resources / payroll (legal where relevant) |

---

## 1. EMA configuration and licensing

| # | Question | Who can answer | Why it matters to the design | Demo default assumption |
|---|---|---|---|---|
| [ ] 1.1\* | What EMA product, module and version do we use, and which pathology options are licensed and enabled? | MM-A, DO, IT | Decides configure vs buy vs build. ModMed advertises gross defaults, configurable stains, reporting/tracking, multiple accession sequences and slide/cassette label printing in many cases [R1]; we don't know what we have. | Nothing assumed. A simulated source system issues accessions. The demo does not claim EMA lacks any feature. |
| [ ] 1.2\* | Can a vendor specialist demonstrate existing grossing templates, label printing, worklists and corrections using our actual workflows (with test data)? | MM-A, DO | A configuration change may close a gap more cheaply and safely than new software. | The "configure EMA" option is evaluated first in `pilot-proposal.md`. |
| [ ] 1.3 | Is there an EMA worklist or report that lists cases by assigned dermatopathologist, stage and PAS (the information in "the bible")? | MM-A, SUP | If yes, the companion's worklist may be unnecessary. | The companion builds its own worklist grouped by doctor. |
| [ ] 1.4 | Who administers EMA configuration here, how are changes requested, tested and approved, and are there fees? | DO, IT, MM-A | Sets a realistic path and timeline for Option 1. | Not modeled. |
| [ ] 1.5 | What training have staff had on the pathology features? Is refresher training available? | DO, SUP, MM-A | Some burdens may be training or access gaps, not missing software. | Not modeled. |
| [ ] 1.6 | Do bench staff have the EMA access needed for their steps (for example, gross entry)? | DO, IT | Access limits can force batching. | Demo roles come from a selector, which is **not** authentication. |

## 2. Tenants and offices

| # | Question | Who can answer | Why it matters to the design | Demo default assumption |
|---|---|---|---|---|
| [ ] 2.1\* | Are the contributing offices in one EMA tenant or different tenants? Do some use other EHRs? | MM-A, IT, DO | Defines identifier namespaces and how many data sources exist. Identical MRNs from different sources must not collide. | Two simulated tenants: "EMA-SIM Sunrise Coast" (most offices) and "OTHER-EHR-SIM Gulf" (Lighthouse Skin Center). MRNs are scoped to their tenant. |
| [ ] 2.2 | How do orders from non-EMA offices reach us (interface, fax, paper)? | DO, AL, IT | Changes the intake comparison and data sources. | The other-EHR office's orders come through the same simulated adapter, labeled with its tenant. |
| [ ] 2.3 | Which identifiers appear on bottles and requisitions from each office (name, date of birth, MRN, order number, barcode)? | AL, OFF | Defines the comparison panel and what a scan can identify. | Synthetic bottle labels; a scan identifies a record, not what tissue is in the bottle. Staff must confirm "verified against physical container." |
| [ ] 2.4 | Is there a courier manifest or expected-container list for each pickup? Who prepares it? | AL, OFF, SUP | Without one, expected quantity is unknown. | A simulated manifest; when absent, the screen says "expected quantity unknown." |
| [ ] 2.5 | Is there a current list of submitting offices, contacts and working hours, and who keeps it current? | DO, SUP | Needed for routing and clarifications. | A fictional office directory with working hours. |

## 3. A/B order creation and correction (before and after accession)

| # | Question | Who can answer | Why it matters to the design | Demo default assumption |
|---|---|---|---|---|
| [ ] 3.1\* | When parts A and B appear separately, what exactly is created: separate orders, separate encounters, separate accession records, or duplicate patient records? | MM-A, AL, OFF | Each cause needs a different fix (office order entry, EMA setup, or reconciliation). | Two separate source orders (ORD-77120, ORD-77121), same patient and encounter. The companion proposes a related-order candidate; a reviewer decides; nothing is merged. |
| [ ] 3.2\* | What is the supported correction before vs after accession assignment? | MM-A, AL, MD | Sets what the companion may suggest. An issued accession must never be silently renumbered. | Before accession: the reviewer records a decision. After accession: only a review/cross-reference record; no simulated EMA correction endpoint. |
| [ ] 3.3 | Who is authorized to perform each type of correction, and what history does EMA keep? | DO, MD, MM-A | Role checks and audit expectations. | Server-side role checks in the demo; not production authentication. |
| [ ] 3.4 | Can office order-entry be set up or taught to create one order with several parts? | MM-A, OFF, DO | Fixing at the source may beat fixing downstream. | Not modeled; listed as a later discovery area. |
| [ ] 3.5 | When a case is corrected, what happens to stickers and labels already printed and applied? | AL, HT, MD | Old physical labels must be retired by an approved process. | Original references are kept; reprints link to the original job; physical material is never relabeled in the demo. |

## 4. Routing and coverage

| # | Question | Who can answer | Why it matters to the design | Demo default assumption |
|---|---|---|---|---|
| [ ] 4.1\* | What is the approved office-to-pathologist and coverage mapping? | MD, DO | Replaces memory with a visible, versioned rule. | Rule set v3, effective 2026-09-01: Harbor Point and Palm Grove to Dr. Elena Marsh; Coral Lane and Mangrove Bay to Dr. Samuel Okafor; Cypress Key and Lighthouse to Dr. Nadia Ferreira. |
| [ ] 4.2 | Who approves mapping changes, how are vacations and coverage recorded, and from what date does a change apply? | MD, DO | Rules need an owner and effective dates. | Versioned rules with effective dates; overrides need a reason and an authorized role. |
| [ ] 4.3 | What should happen when a new office has no rule? | MD, DO, AL | Prevents guessed assignments. | Seagrape Skin Studio becomes a routing exception; no doctor is guessed. |
| [ ] 4.4 | Does EMA already store or auto-assign the dermatopathologist by office? | MM-A | If yes, the companion should read it rather than keep its own rules. | The companion suggests from its own rules; the source system stays authoritative. |
| [ ] 4.5 | Is the per-doctor color convention agreed, and does anyone have difficulty telling the colors apart? | SUP, HT | Color must always come with text. | Teal (Marsh), violet (Okafor), amber (Ferreira), always shown with the doctor's name. |

## 5. Interfaces, data exposure and write support

| # | Question | Who can answer | Why it matters to the design | Demo default assumption |
|---|---|---|---|---|
| [ ] 5.1\* | What identifiers, part relationships, gross descriptions, work orders and status changes can approved interfaces actually expose? | MM-I, IT | Decides which screens could use real data and which would stay manual. ModMed documents a proprietary API and a certified read/search FHIR API [R2]; that does not prove access to internal histology workflow data. | All supplied by a simulated adapter; real availability is treated as unconfirmed until answered. |
| [ ] 5.2\* | Are historical changes and cancellations available (versions, timestamps)? | MM-I | Needed for reconciliation and "what changed" highlights. | The simulator sends versions, corrections, cancellations and out-of-order updates. |
| [ ] 5.3\* | Which write actions, if any, are supported? | MM-I | Decides whether Rollout Mode D is possible at all. | No writes. "Source-system update pending/acknowledged" is simulated and never shown as entered unless acknowledged. |
| [ ] 5.4\* | What approvals, fees, rate limits, sandbox data and acknowledgement semantics apply? | MM-I, DO, PS | Cost and feasibility. ModMed describes sandbox development and review before production access [R2]. | None; local only. |
| [ ] 5.5 | Which interfaces already run here (for example HL7 orders out / results in [R3]), and could an approved copy be used for a shadow evaluation? | IT, MM-I | A clinical order feed is not an internal histology workflow feed; we need to know what it actually contains. | Not assumed. |
| [ ] 5.6 | Is there an approved export (report or file) for a shadow evaluation? What format and how often? | IT, MM-A, DO | Mode B may depend on it. We do not assume EMA offers any particular CSV export. | The fixture importer uses this project's own file format. |
| [ ] 5.7 | How can we tell "no new events" apart from "source unavailable"? | MM-I, IT | Prevents an old worklist from looking live. | The demo shows last successful sync and data age; an outage marks data stale. |
| [ ] 5.8 | Do source timestamps include a time zone and a last-updated time? | MM-I | Correct ordering and conflict detection. | Stored in UTC, displayed in Eastern time. |

## 6. Printers, scanners and labels

| # | Question | Who can answer | Why it matters to the design | Demo default assumption |
|---|---|---|---|---|
| [ ] 6.1\* | What printers, scanners and label materials already exist? Can the current LIS drive them? | IT, HT, SUP, MM-A | Inspect existing equipment before recommending anything new. | Simulated printer; on-screen label previews only. |
| [ ] 6.2 | What barcode type and text do current slide and cassette labels carry? Are the materials validated for our processing solvents and stainers? | HT, SUP | Identity and durability; validation under local SOPs and guidance such as [R5]. | DataMatrix previews with readable text; no material, scanner or solvent validation is claimed. |
| [ ] 6.3 | Can the printers report job completion or failure back to software? | IT, device vendor | Decides which print states can be real. | Includes "unknown outcome" after a timeout, which must be reconciled before reprinting. |
| [ ] 6.4 | What is the reprint procedure, and how are spoiled or replaced labels retired? | HT, SUP | Prevents two live labels for one item. | A reprint records reason, operator and original job; it never creates a new specimen. |
| [ ] 6.5 | Exactly which objects are hand-marked today (requisitions, cassettes), by whom, and in what sequence? | AL, GR, HT | Confirms the labeling workflow before designing it. | Cassettes and slides carry printed IDs in the simulation; nothing assumes writing on tissue. |
| [ ] 6.6 | How are additional slides and missing part labels printed today? | HT | A noted manual burden. | Additional-slide work is kept separate from damaged-label reprints. |

## 7. Clarifications: channel and coverage

| # | Question | Who can answer | Why it matters to the design | Demo default assumption |
|---|---|---|---|---|
| [ ] 7.1\* | Who receives office clarification requests, through which channel, and who covers when they are absent? | OFF, DO, AL | Faster answers need agreed ownership and escalation, not just more notifications. | A fictional office contact and coverage directory; sending is simulated and labeled. |
| [ ] 7.2 | Are EMA message notifications supported, enabled, and reaching the right person? | MM-A, IT, OFF | We don't know whether delays come from unsupported, disabled, ignored or misdirected notifications. | Simulated delivery states, including "delivery unknown." |
| [ ] 7.3 | Will offices agree to an expected acknowledgement time and an escalation contact? | DO, OFF | Sets follow-up times without creating noise. | Illustrative follow-up times. |
| [ ] 7.4 | What may an ordinary notification contain under privacy policy? | PS | The default is no patient information in notification text. | A generic notification pointing to a secure case view (simulated). |
| [ ] 7.5 | Which clarification categories are most common, and from which offices? | AL | Baseline sizing and office feedback. | Categories: site, laterality, orientation/marking, biopsy method, identity conflict, missing container, possible related orders. |

## 8. PAS and work authorization

| # | Question | Who can answer | Why it matters to the design | Demo default assumption |
|---|---|---|---|---|
| [ ] 8.1\* | What source authorizes PAS and other additional work? At which material level (case, part, block, slide) is it specified? | MD, HT, MM-A | The worklist must show exactly the authorized work. PAS is never inferred from diagnosis text. | Work orders (for example WO-2213) linked to the originating order or protocol and to specific material (for example "D26-04817 A1-2 PAS"). |
| [ ] 8.2 | Who can order, change or cancel stains, and how do technicians learn about cancellations? | MD, HT | Canceled or amended orders must trigger review of work already printed or prepared. | Cancellations stay traceable and flag affected material for review. |
| [ ] 8.3 | Are any stains ordered by standing protocol (for example by specimen type or office)? | MD | Decides whether a rule, rather than a person, creates the work order. | Only a protocol reference is modeled. |
| [ ] 8.4 | What does the separate yellow PAS table provide that the doctor list does not? | HT, SUP | Any replacement must keep that function. | The digital worklist shows PAS as explicit text with its source. |

## 9. Incremental grossing entry

| # | Question | Who can answer | Why it matters to the design | Demo default assumption |
|---|---|---|---|---|
| [ ] 9.1\* | What prevents incremental grossing entry today: equipment, staffing, habit, access or system behavior? | GR, DO, SUP, Jorge (observation) | The fix depends on the real constraint. Direct structured entry inside EMA may be better than a second editor. | A reviewed grossing record per part creates a "source-system entry" task for the histology assistant (Sam Ortiz). |
| [ ] 9.2 | What processing cutoffs exist, and when must gross text be entered relative to processing? | SUP, HT, MD | Physical readiness and documentation must be tracked separately. | Readiness is derived from both physical and documentation states. |
| [ ] 9.3 | Is there a workstation or tablet at the grossing bench? Could the grosser enter directly into EMA? | DO, IT, GR | A possible Option 1 fix. | Not assumed. |
| [ ] 9.4 | Is dictation or voice capture permitted, and is any approved provider available? | MD, IT, PS | An optional capture method [R8]. | Synthetic transcript only; numbers, units and counts must be confirmed by a person. |
| [ ] 9.5 | What must a local gross description contain (template fields, units), and who reviews it? | MD, GR | Defines required fields and review. | Structured fields with explicit units; an uncertain decimal/unit or missing piece count blocks finalization. |

## 10. Storage, checkout and send-outs

| # | Question | Who can answer | Why it matters to the design | Demo default assumption |
|---|---|---|---|---|
| [ ] 10.1\* | How are storage locations, checkout, outside send-outs and returns recorded? | HT, SUP | A last-seen location is not real-time tracking; the real recording process must be known. | Illustrative cabinet/drawer/box/slot addresses, last confirmed location, checkout history; a wrong block scan is rejected. |
| [ ] 10.2 | What is the actual addressing scheme, and how long is material kept on site? | HT, SUP | The model must match reality. | Illustrative scheme. |
| [ ] 10.3 | How many retrieval requests happen, and for what reasons (recuts, consults, outside requests)? | HT, SUP, MD | Sizes the problem. | Seeded illustrative requests (for example RR-0192). |
| [ ] 10.4 | Would an initial inventory be feasible, and who would keep locations up to date afterward? | DO, SUP | Archive conversion needs an inventory and ongoing discipline. | Not modeled. |

## 11. Paper documents: actual purpose

| # | Question | Who can answer | Why it matters to the design | Demo default assumption |
|---|---|---|---|---|
| [ ] 11.1\* | Which paper documents serve an actual operational or record requirement, and which are duplicate handoff aids? | MD, DO, PS | Only handoff aids are candidates for replacement; record requirements stay. | A print/export fallback with generation time and version; paper is not assumed removable. |
| [ ] 11.2 | Who uses each copy of "the bible," and for what decision? | HT, SUP, GR | The replacement must keep each function. | Worklist views for accessioning, grossing, histotechs and operations. |
| [ ] 11.3 | Why are case-number stickers applied to requisitions for doctors, and is the stickered requisition kept as a record? | MD, AL | Tells us whether the sticker step can change at all. | Not modeled. |
| [ ] 11.4 | Which paper must remain available during downtime? | DO, IT | Defines the fallback. | Printed snapshot showing generation time and version. |

## 12. Pilot governance and measurement (added)

| # | Question | Who can answer | Why it matters to the design | Demo default assumption |
|---|---|---|---|---|
| [ ] 12.1 | Who would be the clinical, operational, IT and privacy/security owners for any evaluation? | DO, MD | Deployment depends on their review. | None; demo only. |
| [ ] 12.2 | May staff be observed and timed? What notice or agreement is needed, and how are results kept anonymous? | DO, HR | Baseline measurement must be fair and agreed. | No real measurements exist. |
| [ ] 12.3 | Is aggregate overtime data available, and who can authorize its use? | DO, HR | Overtime is measured only where authorized. | Not collected. |
| [ ] 12.4 | Is there an existing near-miss reporting process whose aggregate counts could be used? | MD, DO | A balancing measure for the pilot. | Not modeled. |
| [ ] 12.5 | What employer policies apply to employee-built tools, outside work, confidentiality, and presenting this concept? | HR, DO | Lets the work continue properly. | The demo uses only synthetic data and has not touched lab systems. |
| [ ] 12.6 | Which accreditation requirements and local SOPs would apply to a pilot (validation, document control)? | MD, SUP | Defines local validation. | Not validated; [R5] is listed as guidance to review. |
| [ ] 12.7 | Where could an approved evaluation be hosted, and what security review is required? | IT, PS | Hosting is a deployment dependency. | One local computer only. |

## 13. Later discovery areas (not blocking, not assumed to be problems here)

| Area | Question to ask later |
|---|---|
| Source-office order preparation | Can the offices' existing EHR capture structured parts/sites and an expected-container list before pickup, without a second order form? |
| Transport and fixation times | Are collection and fixation times recorded? (Observed and documented times are kept separate; none are invented.) |
| Processing, embedding and staining handoffs | How are batches, failed equipment cycles and operator exceptions recorded? |
| Special-stain batch records | How are orders, reagent lot/expiry and control review recorded? |
| Office feedback | Can recurring incomplete-order categories be shared with offices, with volume denominators? |
| Outside consultations and archival returns | How are material leaving the lab, its recipient, expected return and receipt recorded? |

---

**References:** [R1]–[R12] as listed in `pilot-proposal.md`.
