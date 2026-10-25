# Where this could go: a modern pathology lab system built around the bench

| | |
|---|---|
| Prepared for | Director of Operations, Platinum Dermatology: **optional, long-term reading**, separate from the proposal |
| Prepared by | Jorge Rodriguez, histology assistant |
| Status | **Vision only, not a proposal.** Nothing in this document is requested now. The only request is Phase 0 of the pilot plan (see the implementation guide); everything here depends on that pilot's results and would be a separate, later decision. |
| Data | Every screen and example uses synthetic data and fictional names. |
| Not endorsed | No one has endorsed, approved, funded or partnered on this: not the laboratory, ModMed or any vendor. No compliance claim is made; CAP, accreditation and SOC 2 are named only as work a full system would need. |

> This document answers one question: if the pilot works, how far could this go? The short answer: the foundation is designed to grow toward a full anatomic pathology lab system that works with EMA. That would be a multi-year effort for a funded team, so it is shown here only as a direction, with rough planning ranges. The pilot is the first and necessary proof, and it is worth doing on its own merits even if nothing in this document ever happens.

## 1. The idea
This project starts from the bench:
- **Scanner-first.** The scan field is the main input on every bench screen.
- **Every uncertainty shown.** Unknown is shown as unknown, never as zero or done.
- **Human decisions with reasons.** Every consequential decision names a person and a reason.
- **Precise holds.** A hold stops exactly the part, block or slide in question, not the whole case.
- **Honest custody.** Physical custody is recorded only from confirmed scans, never inferred.

The long-term vision is a lab system with those design rules at its core, pleasant to use eight hours a day.

## 2. How it relates to EMA
EMA is the practices' electronic health record. A lab system **works with** EMA; it does not replace it.

| | Today (EMA) | With a lab system |
|---|---|---|
| Orders | Created in EMA | Received from EMA as standard HL7 order messages (ORM). EMA already exchanges these with pathology labs ([ModMed HL7 interfaces](https://www.modmed.com/synapsys/hl7/), [ModMed Lab Connect](https://www.modmed.com/lab-connect/), to be confirmed with ModMed). |
| Lab work | [to confirm: the current lab system or process] | Intake, grossing, histology, materials, trays, holds, custody (built as a foundation) |
| Results | Viewed in EMA | Sent back to EMA as standard HL7 result messages (ORU), with a PDF (**not built**) |

The demo's order-intake boundary is a stand-in that proves the rules; a production connector is development work (implementation guide 4.5; [integration contract](../release/integration-contract.md)).

## 3. What exists today, and what a full lab system still needs
**Built and verified on synthetic data** (evidence: the [verification record](../release/verification-stage6.md)):
- **Intake:**
  - courier and manifest reconciliation;
  - container verification against the order;
  - rule-based routing to pathologists;
  - related-order review (never merged automatically);
  - clarifications with offices, and holds scoped to the exact material.
- **Grossing:** gross records with confirmed values and approval.
- **Histology materials:**
  - block and slide life cycle;
  - label printing with outcome reconciliation;
  - tray assembly with one scan per slide;
  - block retrieval with chain of custody.
- **Oversight:** worklists, an operations view of blocked work with owners, and an integration status view.
- **Platform foundation:**
  - sign-in with sessions (tested only with a test sign-in service);
  - role-based permissions for every read and write;
  - a tamper-evident audit trail;
  - a signed order-intake boundary;
  - encrypted backup with verified restore;
  - health checks.

**Still needed before it could be a lab's system of record:**

| Module | What it covers | Notes |
|---|---|---|
| Pathologist workspace and sign-out | Diagnosis entry and templates, CAP cancer protocols (synoptic reporting), electronic signature, amendments and addenda, consults | The largest clinical module; designed with pathologists |
| Result delivery | The signed report back to EMA (HL7 ORU plus PDF), distribution rules, corrected-report handling | Needs the vendor interface |
| Billing and coding support | CPT and ICD-10 capture, charge review, export to the billing system | Always reviewed by people; never automatic |
| Special stains and IHC | Orders, protocols, control slides, quality-control acceptance, reagent lots | Overlaps a separate future-architecture note |
| Instruments and digital slides | Processor and stainer events, links to whole-slide images | Vendor-specific interfaces |
| Production platform | A server database, high availability, monitoring, 24/7 support, security attestations (for example SOC 2) | A different scale from a single-lab pilot |
| Data migration | Moving history from a lab's existing system, and running alongside it | Needed for any lab that switches |
| Lab management | Turnaround and workload reports with agreed definitions | Measured honestly; never staff rankings |

## 4. A possible path (rough planning ranges: rough estimates, not quotes or commitments)
| Step | What | Rough duration | Rough team |
|---|---|---|---|
| A. Pilot (the current proposal) | Prove one workflow at one lab with real users, as a companion to existing systems | About 7–9 months from approval in the best case; up to about 12 months with vendor delays (implementation guide) | The lab and IT time in the guide, a connector developer other than Jorge (named at Gate 1) and a support owner with a second maintainer (by Gate 3); Jorge coordinates |
| B. Sign-out and result delivery | Pathologist workspace; results back to EMA | About 6–9 months | About 4–6 people |
| C. Billing support, special stains and IHC | The rest of the core lab workflow | About 6–9 months | The same team |
| D. Platform and migration | Production hosting, security attestation, migration tools (in parallel with B and C) | About 6–12 months | +1–2 people |

Steps B and C add up to about 12–18 months; the rest of the 18–24 months is validation under the lab's quality system, data migration and running alongside the existing system before go-live (rough).

- **System of record for one lab's lab work** (EMA remains the practices' record and receives the signed results): about 18–24 months after step A, with a funded team of about 5–8 people (engineering, quality and validation, security and compliance, product, a pathologist adviser).
- **A product used by many labs:** about 3–5 years after the pilot.
- **Each step is a separate decision.** It would be taken only on the evidence of the previous step, with its own validation under the lab's quality system and accreditation requirements. Who would fund, own and support such an effort is an open question, outside this proposal.

These ranges exist to show the scale honestly. They are not quotes, and they depend on funding, partners and what Phase 0 discovers.

## 5. What would never change
- **People decide:** patient identity, diagnoses, report sign-out, holds, approvals and quality-control acceptance. The software records and checks; it does not decide.
- **Assistance is evaluated before use.** Any assistance (for example "this tray may miss its pickup") is first tested in shadow mode on the lab's own history, then shown with its evidence, and always overridable (see the [future-architecture note](../release/stage7-proposal.md)).
- **No overselling.** The software never claims more than its evidence shows.

## 6. Why the pilot comes first
A pilot answers the questions a larger effort depends on:
- Does it actually help the bench?
- Do staff want to use it?
- Can it connect to EMA?
- What does validation really take?

If the answer is no, the lab has lost little and learned a lot. If the answer is yes, the lab has the evidence needed to decide what comes next, including whether a vendor product is the better route.
