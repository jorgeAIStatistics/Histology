# Histology Lab OS redesign: results

*2026-10-14. All data is synthetic and every name is fictional. The source system (EMA-SIM), office messages, couriers, printers, scanners and the assistant are simulated. Nothing was published or deployed, and no live system was contacted.*

## What changed
The look was a generic admin template: a side menu, equal cards, one orange for every problem. It is now one visual world taken from the stain itself, the **H&E stain workstation**:
- **Colour:** hematoxylin blue-black for structure, eosin magenta only for keyboard focus and the brand mark, a cool bench-gray background, white evidence sheets.
- **Type:** Atkinson Hyperlegible, chosen so that look-alike characters such as 0/O and 1/l/I in identifiers stay distinct.
- **Signature:** the part you are holding is shown as its **specimen label**, dashed while provisional and solid with its DataMatrix once official.

Every bench screen is now laid out for its own job:

| Screen | Before | After |
|---|---|---|
| Intake | A long stack of cards. The decision area started about 2,000px down a 3,372px page. | **One fixed workstation.** The exception queue is on the left. Across the top runs the label band, then one finding sentence with the scope of each hold and a five-step rail. The evidence sheet shows the three sources side by side, differences first. A fixed decision column on the right puts **your next step as its heading**, with a visible Ctrl+Enter target that never records a container check. For the lead's related-order decision, the centre leads with the two submissions side by side. |
| Clarify | Tabs, a generic table, a stacked panel | An urgency queue, the question as a conversation record, and a docked next step. Drafted never reads as sent. |
| Gross | A dictation card and one card per field | The transcript beside **one** structured form sheet. Six record states kept apart, from draft to source acknowledged (simulated). A docked next step that states why an action is disabled. |
| Worklist | Stacked toolbars above a generic table | The digital "bible": one band per dermatopathologist and **PAS rows in yellow, always written "PAS (WO-…)"**. One toolbar. |
| Materials | A tray shown as a table | **The tray drawn as its slots.** Retrieval shows the storage path and **last confirmed by … at …**; a wrong block is rejected and nothing changes. |
| Operations | Nine equal KPI tiles | The bench path as stages with the oldest wait at each, and one focused **"Blocked now"** area with owner, waiting time and evidence. |
| Case | A stack of cards | Each part as its label, with its physical and documentation paths drawn as two short rails. |
| Insights, Demo, Settings | Card stacks | The same world. Every "Illustrative", "Simulated" and "Synthetic" label is kept. |

The shell is now one hematoxylin top bar: job navigation, the scan field, source freshness, a keyboard-keys button, an always-visible **Synthetic demo** pill and, in demo mode, a read-only demo role and demo time with one link to the **presenter console** (`/demo`). *(Stage 5 replaced the presenter menu.)* The left side menu is gone, and the content uses the full width.

Rules: [visual-system.md](visual-system.md). The system as built: [DESIGN.md](../../DESIGN.md). Why each choice: [decision-log.md](decision-log.md).

## Before and after (same synthetic fixture, same script, same sizes)
`scripts/fixture-intake-review.ts` builds the state through commands only. `scripts/screenshots.mjs` takes every capture. Each pair is `before/before-<screen>-<size>.jpg` next to `after/after-<screen>-<size>.jpg`.

- **Screens:** `intake-hero-b` (laterality mismatch), `intake-hero-a`, `operations`, `worklist`, `grossing`, `materials-tray`, `materials-retrieval`, `case`, `clarifications`.
- **Sizes:** `1440` (1440×900), `1366` (1366×768), `1024` (bench tablet), `zoom200-720` and `zoom200-683` (200% browser zoom of the two workstation sizes).
- **State captures:** about 400 more in `after/`, named `<screen>-<state>-<size>.jpg`. They cover mismatch, hold, identity conflict, missing container, missing data, stale or offline source, read-only, conflict, success, empty and loading.

| Measured | Before | After |
|---|---|---|
| Horizontal scroll at 200% zoom | 228 to 323 px on every screen | 0 px on every screen |
| Horizontal scroll at 1024, 1366, 1440 | 0 | 0 |
| Console errors during capture | not recorded | 0 (45 captures) |
| Text contrast below WCAG AA (`scripts/contrast-check.mjs`, 14 screens) | not measured | 0 failing colour pairs at 1440, 1366 and 1024 |

## Six bench tasks, walked through the new screens
These are the questions in [task-map.md](task-map.md), answered on the after captures.

1. **What arrived, and what still needs reconciling?** The Intake queue header gives the courier as label and value: received 11, expected Unknown (two offices sent no manifest), missing 1, plus how many have been checked. Exceptions come first, and routine items do not wait for them. The manifest by office is one click away. Captures: `after-intake-hero-b-1440.jpg`, `intake-empty-1366.jpg`.
2. **Which case and part am I on?** The specimen label band shows:
   - the dashed **B · Provisional INT-1014-032 · Order ORD-77121 · Official number: not issued**;
   - the patient at display size, with DOB and MRN and the source system it comes from;
   - site, routed to, ordered by and office.

   After accession the label turns solid and carries its DataMatrix (`intake-accessioned-1440.jpg`). The same label leads Grossing, Materials and the case page.
3. **Which source says what, and where do they disagree?** The evidence sheet lines up Order v1, the bottle (staff entry) and the requisition, with the differing row first and the words "Both values are kept; nothing is corrected automatically." A patient-identity difference is the only thing shown in red, with an octagon mark (`intake-identity-1366.jpg`). A field that differs is amber.
4. **What decision is needed, who owns it, and what is the evidence?**
   - The finding sentence names the waiting decision, and the rail names each owner.
   - Maya's heading is the action itself: "Send CLR-0457 to Harbor Point Dermatology", then "Review notice, then send" (`intake-mismatch-1366.jpg`).
   - Kim's REL-0112 decision lays the two submissions side by side in the centre, with "Review, not merge" (`intake-decision-preview-1366.jpg`).
5. **What is ready for the next stage, and what holds it?** A hatched **Hold: Part B** chip states its scope: "H-0090 stops gross approval, processing, label printing and tray delivery. Accession is not held. Part A can continue." Request accession sits at the foot with its reason. Operations lists "Blocked now", and each Worklist row has its readiness.
6. **Where was the material last recorded, and is that confirmed?** Materials, Retrieve blocks shows Cabinet 2 › Drawer 4 › Box 11, Slot 14, "Last confirmed by Marcus Lee at Oct 9, 3:20 PM ET", and "Last confirmed location, not live tracking" (`after-materials-retrieval-1024.jpg`). A wrong block is rejected and nothing changes (`materials-retrieval-wrong-1366.jpg`).

## What was verified (actual results)
- **Typecheck:** `npx tsc --noEmit` reports 0 errors.
- **Domain tests:** `npx vitest run` passes 283 of 283 in 10 files (247 before the redesign).
- **Browser tests:** `npx playwright test` on a production build passes **17 of 17**. Assertions changed to follow new wording or structure, each kept at least as strong. One run failed to build because another dev server had rewritten `tsconfig.json`; with the server stopped and the file restored, it passed.
- **Keyboard and scanner (Intake):** a Playwright script passes 140 of 140 checks:
  - focus returns to the scan field after each action;
  - J/K and the arrow keys move the queue, and keys 1 to 5 jump to the steps;
  - Esc moves to the queue;
  - Ctrl+Enter runs only the step that shows the Ctrl badge and never records a container check;
  - the drawer at 1024;
  - 200% zoom.
- **Independent reviews:** each screen was built, reviewed by a separate Impeccable finish reviewer, fixed, and scored again.

  | Screen | Last verdict |
  |---|---|
  | Intake | ship |
  | Grossing | ship |
  | Operations | ship |
  | Clarify | ship |
  | Case | ship |
  | Insights, Demo, Settings | ship |
  | Worklist | Last scored "fix". After that score the readiness and owner layout and the selected-row outline were changed. Not scored again. |
  | Materials | Last scored "fix". After that score the tray exception chip, the panel focus ring and the delivery-hold note were changed. Not scored again. |

- **Intake critique score:** 28/40 before the redesign and 31/40 after, from a single reviewer. Priority-1 issues went from 4 to 1. That remaining one, the lead's decision squeezed into the side column, was then fixed. The fix was checked with captures and keys, not re-scored. Snapshots are in `.impeccable/critique/`.
- **Impeccable detector:** no anti-patterns in the shipped app. It reports 8 advisory font sizes:
  - the specimen label's part letters, which are intentional because the label is the signature;
  - the printed worklist snapshot, which uses paper sizes for print.

## Simulated, unfinished, or a known weakness
**Simulated, as everywhere in this demo:**
- the EMA-SIM source: orders, amendments, accession numbers, acknowledgements;
- office notifications and delivery outcomes;
- courier contents;
- printers and print outcomes;
- scanners (the scan field behaves like a keyboard scanner, and demo "Scan" buttons stand in for one);
- the dictation assistant (deterministic);
- the demo clock;
- the role switch, which is not a sign-in.

**Unfinished or known weaknesses:**
- **Presenter-only controls** (a colleague's edit, unpacking a courier bag, an office answer) moved in Stage 5 to the presenter console's **World events** tab, built from the [presentation-surface proposal](presentation-surface-proposal.md). No bench screen carries them any more.
- **Top bar widths:** at 1366 to 1535px the job-navigation group is wider than the scan field. The scan field is still the widest single control. Below 1366px the navigation shows icons only, with labels kept for screen readers and as tooltips.
- **Demo clock:** read-only in the bar; its controls are on the console's Role and clock tab.
- **Tight fit at 1366×768:** Kim's decision fits with about 10px to spare. A longer finding or hold line would push its reason field below the fold.
- **Step rails:** the Intake rail, the Grossing record states and the case-page rails show the same idea drawn three ways. They are not one shared part yet.
- **Toasts:** they now appear bottom-left, away from the decision columns and side panels on the right. On the Intake bench that puts them over the bottom of the queue for a few seconds.
- **Server wording:** the recorded state is still called "Staff verified against physical container" in the audit log and history. The button reads "Record: I checked this bottle against the order".
- **Reference sites:** the in-app browser refused costanera.uk and reveallabs.co, and the Design Extract command (`memi`) is not installed. They were read by hand, for level of care only; nothing was copied ([references-and-skills.md](references-and-skills.md)).
- **Design concepts:** `/concepts/intake-a|b|c` are kept as the record of the three-concept comparison. They use their own styles on purpose and are not part of the product.
- **Not covered:**
  - No phone layout; the targets are bench workstations and a tablet at 1024.
  - No outcome has been measured: no time saved, no error rate.
  - Production work is listed separately in the [production backlog](production-backlog.md): authentication, integration contracts, printer acknowledgments, migrations, monitoring, backup, AI evaluation, and the replay-path review.

## Files
- **Rules and records:**
  - [visual-system.md](visual-system.md)
  - [decision-log.md](decision-log.md)
  - [production-backlog.md](production-backlog.md)
  - [presentation-surface-proposal.md](presentation-surface-proposal.md)
  - [references-and-skills.md](references-and-skills.md)
  - [task-map.md](task-map.md)
  - concept comparison: `concepts/comparison.md`
- **System as built:** [../../DESIGN.md](../../DESIGN.md) and `.impeccable/design.json`.
- **Product context:** `../../PRODUCT.md`, plus surface briefs in `.impeccable/surfaces/`.
- **Review records:** `.impeccable/review/<screen>/`, holding the review captures and each verdict.
- **Scripts:** `scripts/fixture-intake-review.ts`, `scripts/screenshots.mjs`, `scripts/contrast-check.mjs`.
