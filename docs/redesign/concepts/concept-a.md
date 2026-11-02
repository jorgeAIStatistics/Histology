# Concept A: Precision workstation

Preview route `/concepts/intake-a?item=INT-1014-032` (default item). Reads the fixture through `intakeBench()`; runs no commands. Screenshots: `a-first-view-1440.jpg`, `a-1366.jpg`, `a-decision-1440.jpg`, `a-blocked-1440.jpg`, `a-part-a-1440.jpg` (script: `_scripts-a/shoot.mjs`).

## Composition

```
+--------------------------------------------------------------------------------------------+
| Demo  Histology Lab OS  [Bench: Intake v]  [Find record | scan or type an id  /]  EMA-SIM synced (Simulated)  Clock  Actor |
+-------------+--------------------------------------------------+---------------------------+
| Courier     | [Part B]  Provisional INT-1014-032  No accession | DECISION (ink band)       |
| 11 / Unknown| [ORD- ]   Avery Quinlan  Synthetic               | Your next step            |
| / 1 known   | [Hold ]   DOB  MRN+tenant  Office  Dermpath swatch|  one action, one button   |
|-------------+==================================================|---------------------------|
| Exceptions 5| ! Laterality differs: the bottle says left, ...  | Path to accession         |
| :INT-..031  |   Both values kept. Part B held. Accession waits.|  01 checked   (gray)      |
| :INT-..032  |--------------------------------------------------|  02 routed    (gray)      |
|  INT-..034  | Field | Order | Bottle | Requisition || Result  |  03 REL review (ink)      |
| To review 7 | quiet rows ...                                   |  04 accession (pale)      |
|  ...        | ##### Laterality  Right | L | Right || Differs |  What can move, by part   |
| Done 22     | A | shared facts (6) / kept apart (1) | B        |---------------------------|
|             | Record, history                                  | [Request accession]  why  |
+-------------+--------------------------------------------------+---------------------------+
```

Three surfaces with three roles: a gray chassis (top bar, queue), a white stage for evidence, a steel decision column behind the screen's only ink vertical rule. The identity readout is sticky; the decision column scrolls on its own with the request dock pinned.

## Type and color

- **Instrument Sans** for words: a compact grotesk; the queue uses a narrower width (wdth 90) so office names fit 284px. Structure comes from size and weight contrast: part letter 54px, patient 30px, finding 22px, step titles 19px, body 14px, nothing under 13px.
- **JetBrains Mono** only for identifiers (INT, ORD, CLR, REL, H, MRN, DOB): dotted 0, flagged 1, tailed l, serifed I. Checked at 2x.
- Color is held back for meaning: ink for structure and the primary button, orange only for a disagreement, plum only for a hold, the doctor's swatch beside the doctor's name. Routine agreement is gray; the only green is the source-sync dot.
- The provisional id is a dashed box with the word "Provisional". An issued accession is a solid ink block (see any Done item), so the two can't be confused.

## What the user sees first

The part letter and the patient, then one plain sentence: "Laterality differs: the bottle says left, while the order and the requisition say right." Under it: both values are kept, Part B is held (H-0090) while CLR-0457 is open, and accession waits for REL-0112. The matrix below repeats it with the source values: the disagreeing row is taller, tinted and ruled, the odd value is underlined, and "Not compared, one source; not a match" is never shown as a match.

## Primary action

There is one solid button: the next step the current person can take. For Maya it is "Send to office (simulated)" for CLR-0457, shown with the question text. For Kim (lead) it is "Review REL-0112". When nobody at the bench can act (Part A), the block says "Nothing for you on this item right now. It waits for Kim Nguyen (REL-0112)."

## Blocked case

"Request accession (simulated source)" is always in the same place at the foot of the decision column, with the reason beside it ("waits for the REL-0112 review by Kim Nguyen. Hold H-0090 does not block it."). Pressing it scrolls the decision column to the blocking step (03, owner named) and to "What can move, part by part". That grid shows Part A and Part B side by side: accession waits for REL-0112 on both; gross approval, processing, label printing and tray delivery are held by H-0090 on Part B only. When an item has several blockers, they are listed in full above the dock.

## Context during a decision

The REL-0112 form opens in the decision column, so nothing in the center is covered. The stage scrolls only far enough to show the A | B panel in full, outlined "Decision in progress": two plates (separate INT ids, separate orders, "as ordered" site, check state, hold), the six shared facts drawn as hairlines between them, and "Kept apart: separate source orders, both kept". The sticky readout keeps identity in view and repeats the finding in one line, and the laterality row stays visible.

## Reference qualities adapted, and what was not copied

- One sentence stating the finding before any table (Reveal's finding line). Plain lab words; no amounts, no product voice.
- Progress shown by tone along a short numbered sequence: done gray, current ink, later pale (Costanera's process line), used here as the real path to accession with owners.
- Sources drawn as converging inputs: three source columns into one result column, and the bridge of shared facts between two plates.
- Surfaces by role, hairlines, restraint. No serif display type, no cream paper, no green or gradient sections, no glass nav, no maps or node diagrams, no marketing layout, no tracked all-caps eyebrows, no arrows on buttons, no middle-dot meta strings in the concept's own copy.

## One honest disadvantage

Three fixed columns are dense. At 1366x768 the matrix is cut after the laterality row and the path to accession needs scrolling inside the decision column; the A | B panel sits below the fold until a decision opens. It suits practiced accessioners, and it will take longer to learn than a single-column guided flow.
