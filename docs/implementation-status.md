# Implementation status and handoff

*Histology Lab OS — "Histology Redesigned". Status as of 2026-10-14. Everything in the app is synthetic; every outside connection is simulated.*

This page answers four questions: what works on this laptop today, what is only simulated, what was deliberately not built, and what a real pilot would need first. It ends with how the work was checked and how to pick it up again.

---

## 1. What works locally (real logic, synthetic data)

"Works" means: the rules run for real in this app against its own local database, survive a page refresh, and are recorded in the audit log. It does **not** mean connected to EMA or validated for patient care.

| Area | What you can do | Where |
|---|---|---|
| **Arrival and reconciliation** | Record the courier arrival; unpack requisitions and containers; see expected vs received per office, with "Unknown (no source manifest)" instead of 0; missing and extra containers flagged per order part | `/intake` |
| **Container check** | Compare order vs bottle vs requisition field by field (originals kept, abbreviations normalized only for comparison); "Staff verified against physical container" records who and when — a scan never sets it | `/intake` |
| **Routing** | Suggest the assigned dermatopathologist from versioned, approved office rules (shows the rule and version); unknown office → routing exception, no guessed doctor; overrides need the lead and a reason; rule versions are drafted, approved and frozen | `/intake`, `/settings?tab=routing` |
| **Related orders** | Detect possible A/B orders from the same source-scoped patient, encounter, office and day; show reasons and conflicts; the lead decides; nothing is merged; a separate encounter is never proposed; same MRN in another practice never matches | `/intake` |
| **Clarifications** | Raise a specimen-specific question with evidence and a hold scoped to the affected part; contact chosen from a coverage directory (with backup); send (simulated), delivery outcome, acknowledgment, answer, review and resolution as separate steps; reminders with duplicate suppression; escalation; drafting help that never contains patient identifiers in the notification | `/clarifications`, `/settings?tab=contacts` |
| **Holds** | Holds stop only the listed steps for the listed material; releasing needs the lead/supervisor and a reason and is separate from resolving the question | everywhere a hold applies |
| **Accession** | Request an official accession from the (simulated) authoritative source; provisional INT ids look different from D26 numbers; parts keep their original source orders and designations; double clicks/repeats issue nothing extra; renumbering, moving a case to another patient and silently changing a part's site are refused by the database | `/intake`, `/cases/[id]` |
| **Corrections after accession** | Open a correction/cross-reference review that snapshots the original references; nothing is renumbered, merged or relabeled | `/cases/[id]` |
| **Digital worklist ("the bible")** | Shared list grouped by assigned dermatopathologist with color *and* name; PAS shown as explicit text with its work order, source and affected block/slide; holds, readiness, owners, blocks prepared vs expected; views for accessioning, grossing/source entry, histotech and operations; new/changed/canceled since your last acknowledgment; saved filters; printable snapshot and CSV with generation time and version; live updates without reload | `/worklist` |
| **Case record** | Parts with separate physical and documentation progress; material tree; every source order version with original values; tasks and clarifications; full history | `/cases/D26-04817` |
| **Grossing** | Open the exact part; synthetic dictation → proposed values with highlighted evidence; numbers, units and counts need explicit confirmation; ambiguous decimals and missing units cannot be accepted as dictated without a deliberate check; draft / needs clarification / reviewed / approved; approval of one part opens its downstream work immediately (cassette eligible for processing, source-entry task) while other parts stay incomplete; "entered by staff (attested)" is kept apart from "acknowledged by source (simulated)"; approved records are frozen and corrected by a new version | `/grossing` |
| **Printing** | Label jobs tied to official ids and authorized work; printer timeout → "unknown outcome" that must be reconciled before any reprint; reprints need a reason and link to the original; an additional slide is a new work order, not a reprint; label previews with a DataMatrix code and a decode check | `/materials?tab=print` |
| **Tray assembly** | Each slide must be scanned on its own; unexpected, duplicate, canceled and unreadable slides are flagged; a tray with anything missing or unexpected cannot be "verified complete"; a supervisor can release it only "with documented exceptions" | `/materials?tab=trays` |
| **Block retrieval** | Pick list grouped by cabinet/drawer/box while keeping the bench's order; "last confirmed" location with who and when (not live tracking); checkout holder, overdue returns, send-outs, missing-material investigation; a wrong block scan is rejected and nothing changes | `/materials?tab=retrieval` |
| **Source changes** | Re-imports are idempotent; older versions never overwrite newer ones; a canceled or amended stain order puts already printed/prepared slides into review instead of erasing them; an amended order before accession updates the working values (original kept) and asks the lead to review the hold | `/settings?tab=integration`, worklist, case |
| **Staleness** | A simulated outage turns the worklist and top bar visibly stale; messages that arrive during the outage are imported exactly once after the connection returns | top bar, `/worklist`, `/operations` |
| **Operations view** | What is blocked, who owns the next step, how long it has waited and the evidence — counts only, each linking to records; no scores or rankings | `/operations` |
| **Measurement view** | Metric definitions (numerator, denominator, start/end events, exclusions, source); median and 90th percentile with n; still-open and missing-data counts shown separately; editable scenario calculator that starts blank; all prior-day charts labeled illustrative | `/insights` |
| **Guided demo** | Eight steps with deep links, "what to notice", real-vs-simulated notes, progress read from the records, simulator buttons, a rehearsal mode, workflow map and speaker notes | `/demo` |
| **Safety rails** | Server-side role checks on every action (the role selector is a demo convenience, not a sign-in); stale saves are refused and shown in a conflict dialog; local append-only audit log (blocked from edits and deletes by the database — not proof of tamper resistance); controllable demo clock that starts paused | everywhere |

## 2. What is simulated (clearly labeled in the app)

| Connector | In this demo | Real-world status |
|---|---|---|
| EMA / source system | `EMA-SIM Sunrise Coast` and `OTHER-EHR-SIM Gulf` simulated tenants: orders arrive from a scripted outbox; accession numbers come from a simulator | Unknown what the lab's EMA configuration exposes or allows. See `integration-capability-matrix.md` and `discovery-checklist.md` |
| Courier contents | A scripted list of what is "in the bag" | — |
| Office notifications and replies | Simulated delivery outcomes and scripted office answers; never contacts anyone | Requires an agreed channel and office ownership |
| Printers and scanners | Simulated printers (online / offline / timeout); "scanning" means typing or pasting a label payload | Requires compatible printers, drivers, validated label materials and bench procedures |
| AI assistant | A deterministic rule-based extractor and drafter, labeled "deterministic demo"; can be switched to "unavailable" | No live model is connected |
| Source-system writeback | None. Staff attest manual entry; "acknowledged" only ever comes from the simulator | Mode D only, after a supported interface is reviewed |

## 3. Deliberately not built (or only partly)

- **Deferred modules** (see `roadmap.md`): inventory management, computer vision, predictive staffing, whole-slide imaging, billing, diagnostic AI, office-side order preparation, processing/embedding/staining batch records, special-stain lot records, outside consultation tracking beyond the retrieval send-out flag.
- **Not built from the design spec:** the docked "coach panel" on every route during the guided demo (the guide links to each screen instead); "Load scenario" presets; an automated accessibility scanner (axe) run.
- **Model gaps** (details in `data-model.md` §14): one container per part (split bottles not modeled); "not provided" and "illegible" are both shown as "Unknown"; no per-field amendment log for local edits; holds have no separate "canceled in error" state (released with a reason instead); no QC-failed or damaged slide states; no per-work-order version history; rate-limit and partial-page source failures are not simulated.
- **Intake gaps:** scanning an unmatched container does not offer to create a new provisional item; there is no "someone else has this open" presence note (stale saves are still caught).
- **Not tested:** decoding the rendered DataMatrix image itself (only the label text round-trips); real hardware; performance under load.

## 4. What a real pilot would need first

None of this is implied by the demo. Each item needs the named owners at the lab.

1. **Permission and scope** from the Director of Operations and the medical director to observe and measure (no system access is needed for that step).
2. **Discovery** — the questions in `discovery-checklist.md`: what EMA modules and options are licensed and enabled, how A/B orders are created and corrected, office-to-pathologist and coverage mapping, printers/scanners in place, who answers office questions, where PAS is authorized.
3. **Configure before building** — a ModMed specialist demonstration of existing grossing templates, label printing, worklists and corrections using the lab's real workflow (option 1 in `pilot-proposal.md`).
4. **Baseline measurement** over representative days, using the metric definitions in `pilot-proposal.md`.
5. **Deployment dependencies** if a companion is still justified: clinical, IT, privacy/security and operations owners; intended use; approved data access (supported interface or approved export — no scraping); hosting; contracts; identity management (real sign-in, not the demo role selector); auditability; backup/restore; device interfaces; local validation; training; a documented downtime and rollback method. Adding disclaimers, encryption or role buttons does not make the prototype compliant or validated.
6. **Rollout modes**: A (this local demo) → B (approved shadow evaluation) → C (small live pilot on one office/team/station) → D (selective writeback/printer control only after review). See `integration-capability-matrix.md`.

## 5. How it was checked (2026-10-14)

| Check | Result |
|---|---|
| Type check (`npm run typecheck`) | No errors |
| Domain tests (`npm test`) | **247 passed** across 8 files — every one of the 15 acceptance checks in spec §13 has tests (map: `acceptance-tests.md`) |
| Production build (`npm run build`) | Compiles; 17 routes |
| Browser tests (`npm run test:e2e`) | **17 passed** — the full 8-step director journey on the real screens plus guard tests for roles, stale saves, source outage, assistant failure, uncertain grossing values and the printed snapshot |
| Screen review | Every screen was inspected in a browser at 1366×768 and 1024×768 by four parallel reviewers (no page overflow, no console errors), then independently re-reviewed from screenshots and fixed |
| Documentation | Every doc fact-checked against the code, seed and tests |

## 6. How the work was built (for the curious)

The build lead wrote the database schema, the safety rules, the command layer and the synthetic data. Seven builder agents then built the feature areas in parallel under a written contract (`docs/dev/command-contract.md`), each followed by an independent reviewer and a fix pass. After that, four browser-review agents polished the screens; documentation agents reconciled every doc with the code; and a test agent wrote the browser tests, which an adversarial reviewer tried to break before they were hardened. Specification sources and evidence: `research-notes.md`.

## 7. Picking the work up again

- **Start:** `npm install`, `npm run db:reset`, `npm run dev` → http://localhost:3100 → `/demo`.
- **Before a presentation:** reset the demo, run through `demo-script.md` once in rehearsal mode, reset again.
- **Before changing code:** run `npm run check` (types + domain tests) and `npm run test:e2e`; read `docs/dev/command-contract.md` for where things live.
- **Next sensible milestones** (only if discovery supports them): resolve the discovery questions; adjust the synthetic scenario to the lab's real A/B and correction process; add the docked demo coach panel; add an automated accessibility scan; model split containers if the lab uses them.
