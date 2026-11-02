# Histology Redesigned: executive brief

**Closing handoff gaps in the histology workflow: measure first, configure first**

**Prepared for:** Director of Operations, Platinum Dermatology  
**Prepared by:** Jorge Rodriguez, histology assistant  
**Date:** [meeting date] · **Status:** proposal for discussion

> **Read this first.** No one has endorsed, approved, funded or bought this work: not the laboratory, ModMed or any vendor. The demo runs on my own laptop with synthetic data for a fictional lab, "Lumen Bay Dermatopathology Laboratory (fictional)", and has never been connected to EMA, the lab network or patient information. All time and effort figures are **rough estimates to refine in Phase 0**. No compliance claim is made.

## 1. Why I'm raising this

At the bench I keep seeing **the same specimen information copied by hand at several handoffs** (about four months here [to confirm: time at the bench as of the meeting date], plus earlier lab work elsewhere):

- Accessioners remember which office goes to which dermatopathologist.
- Parts A and B sometimes arrive as separate orders, which are hard to fix after accessioning.
- Replies to our clarification messages to offices can be delayed. We don't yet know why.
- Gross descriptions are typed into EMA after the batch, some nights until about 9 p.m.
- Many slide labels may be applied by hand on a busy day, and "the bible" is printed and color-coded by hand.

**These are my observations, not measured rates.** I'd like to measure them properly.

## 2. The idea in one sentence

**A companion to EMA, not a replacement:** it coordinates the handoffs between people and systems, while EMA keeps accessions, orders, gross reports and diagnoses. (The demo software is called Histology Lab OS.)

## 3. What the five-minute demo shows

One fictional two-part case from courier to Operations, plus two earlier fictional cases:

- A courier delivery is checked against what was expected. Offices are routed by a written, versioned rule; an unknown office is flagged, never guessed.
- Two orders for one patient: the system **suggests** they are related, a person decides, nothing is merged.
- A bottle says *left*, the order says *right*: one clarification, and **only Part B** is held until the corrected order arrives. Part A's gross record moves on.
- A tray missing a slide can't be marked complete; a printer timeout shows "unknown", not "printed"; a wrong block scan is rejected.
- Operations shows what is blocked, who owns the next step and how long it has waited.

## 4. Real versus simulated

- **Works today, on synthetic data, with automated tests:** the workflow rules above; the server checks each person's role on every action; a later edit to the activity record shows up when it is checked; backups are encrypted and a restore is checked before use; health checks; automated accessibility checks; and a build that is not set up shows no data. Sign-in works with a test sign-in service only. Simulated EMA messages are checked for duplicates and conflicts.
- **Simulated:** EMA and every outside connection: orders, accession numbers, office replies, printers, scanners, and the drafting "assistant".
- **Blocked:** real sign-in and production use, until the organization provides a sign-in service and hosting.
- **Needs a person to check:** screen readers, paper printing, real scanners and printers, touchscreens, and clinical validation.

Evidence (latest full run, 2026-10-24): about 800 automated tests pass (643 unit, integration and contract; 139 demo browser; 26 secured sign-in), plus a clean type check, on synthetic data. They are re-run on the final code before the meeting. **Passing tests show the code does what the tests say. They are not clinical validation.**

## 5. What it is not

Not validated, and not compliant because of its technical controls. Not connected to anything. Not a diagnostic tool; no AI decides anything. Not a purchase request, and not a claim that EMA or any product lacks a feature.

## 6. The ask: Phase 0 only

**Four weeks of discovery and governance. No patient data, no software installed on lab systems, no purchase.**

- **Who:** you as sponsor, the Medical Director, the IT lead, the Compliance/Privacy officer, and me.
- **Phase 0 effort (rough):** you, about 4 h over the 4 weeks plus Gate 0; the other three roles [to estimate at kickoff: a 30-minute kickoff, a 30-minute Gate 0 review, plus their discovery items]; me [to confirm: hours per week agreed with my manager, and who covers my bench].
- **What:** answer the discovery checklist; observe and time the current workflow (staff consent, no patient identifiers in notes); agree metric definitions; inventory EMA, any separate LIS [to confirm], label printers and scanners; a 30-minute small-group review of the synthetic demo; questions to ModMed and any LIS vendor about what is already licensed and configurable, sent through [to confirm: the EMA administrator or IT lead]. No contract, no data.
- **Output at week 4:** a written recommendation to **configure, buy, build, or stop**.

## 7. Timeline at a glance (rough estimates, weeks from approval)

| Phase | Weeks | Gate |
|---|---|---|
| 0. Discovery and governance | 1–4 | Configure, buy, build, or stop |
| 1. Synthetic sandbox at the lab, no patient data | 5–10 | Usability; intended use approved; support model and connector developer named |
| 2. Technical foundation and interface feasibility, test data only | 8–22 (2–6 months, vendor-dependent) | Secured mode works in a **test** environment, with real sign-in and test messages |
| 3. Validation and training (lab's quality system) | 20–28 | Validation approved; go-live readiness review |
| 4. Limited pilot: one workflow, one bench, shadow first | 28–36 | Weekly review against the baseline |
| 5. Decision | 36–38 | Continue, expand, change or stop |

**Best case: about 7–9 months** from approval to the end of a limited pilot, if a vendor specification and test environment are available by about week 15 (about 3 months after approval); **up to about 12 months** with vendor or contract delays. **The cheapest decision-grade path is Phases 0–1 only: about 10 weeks, no patient data.** One caution: if the lab works inside EMA's own Pathology module [to confirm in Phase 0], orders may never travel to a separate system, and the build path would likely stop at Gate 0. If Phase 0 chooses configure or buy, the plan is redrawn with ModMed or the vendor.

## 8. What success looks like

- **The problem gets solved, even if this software is not what solves it.** Solving it with EMA configuration or an existing product is a success, and so is stopping at a gate for a written reason.
- Decisions rest on measured baselines, not my impressions. Any pilot is one workflow on one bench, measured against the baseline, including the extra checking it adds.

## 9. Next step

If you agree: a 30-minute Phase 0 kickoff with the Medical Director, IT lead and Compliance/Privacy officer [to confirm: date] to confirm the participants and the consent approach for observation. I'll bring the discovery checklist and a draft observation plan. *More detail: the Director FAQ and the timeline (handed out with this brief); the pilot proposal and discovery checklist, available on request.*

## Beyond the pilot (vision only, not part of this ask)

If the pilot proves its value, the foundation is designed to grow, for example into sign-out and result delivery to EMA. That would be a separate, later decision needing a funded team (rough ranges in the optional `product-vision.md`).
