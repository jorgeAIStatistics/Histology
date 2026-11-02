# Concept B: Specimen atlas

Preview route: `/concepts/intake-b?item=INT-1014-032`. It is read-only and has no app shell. It reads `intakeBench()` for the selected item and for each item linked to it by a related-order candidate. Screenshots: `b-first-view-1440.jpg`, `b-1366.jpg`, `b-decision-1440.jpg`, `b-blocked-1440.jpg`, `b-part-a-1440.jpg`.

## Composition

```
┌ Histology Lab OS  Intake Clarifications …  (Find record: INT, order or label)   EMA-SIM (simulated)  Maya Torres ┐
├ ATLAS (rail, tinted) ──────┬ [Provisional INT-1014-032] Order ORD-77121  Courier CR-1014-11  Status  Owner ────┤
│ Courier CR-1014-11 11:00   │ Avery Quinlan, part B                 │ Date of birth   1961-03-22               │
│ Received 11  Expected Unknown│ Right or left dorsal forearm?  (pale) │ MRN / Ordering clinician / Assigned derm.│
│ [All open 12][Exceptions 5]│━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━│
│ Harbor Point  4 of 4       │▌The bottle says "L dorsal forearm".   │ ■ Laterality question …      CLR-0457    │
│  INT-1014-024 …            │▌The order and requisition say "Right…"│ ■ Hold on Part B only …      H-0090      │
│ ┌ Avery Quinlan (paper) ─┐ │                                       │ ■ Related orders, lead …     REL-0112    │
│ │ ORD-77120 [INT-…031] ┐ │ │ Three   [order record] [bottle] [requisition]   ⟩ Agreement                      │
│ │  A Left upper back   ┆ │ │ sources  ORD-77121 v1   label    REQ-SIM-…                                       │
│ │ ┊REL-0112 not merged ● │ │ ──────────────────────────────────────────────────────────────────────────────── │
│ │ ORD-77121 [INT-…032] ┘ │ │ Laterality   Right        L           Right        Differs, CLR-0457 (row first) │
│ │  B Right dorsal … Hold │ │ Patient name …            …           …            Same                          │
│ │ ┊Accession: not issued │ │ MRN …        448210       Not on label Not stated  Not compared                  │
│ └────────────────────────┘ ├ dark band: Next for Maya Torres  (Send CLR-0457 … (simulated))  Waits for REL-0112 ┤
│ Coral Lane 2 of 3, 1 missing (dashed empty slot) … Seagrape: not in directory                                  │
```

## Type and color

- Type: **Atkinson Hyperlegible Next** for text and display, and **Atkinson Hyperlegible Mono** for identifiers, both loaded with `next/font` in this route only. The family was designed to keep look-alike characters apart: 0 is slashed and 1, l and I have different shapes, which matters for staff comparing INT, ORD and MRN strings character by character. Using one family means contrast comes from weight and tone, not from a decorative second face. The headline is two-tone: a dark identity line (`Avery Quinlan, part B`) over a pale line with the open question (`Right or left dorsal forearm?`). A clean part shows its site there instead.
- Color: cool neutrals, never cream. Each surface has one role: a tinted map table for the atlas, a near-white sheet for evidence, a white "paper" card for the opened submission, and one deep slate band reserved for actions. One ink-blue accent marks selection and the related-order link (always dashed). Amber is used only for a difference and plum only for a hold. Both always come with words.

## What the user sees first, and the primary action

1. Identity (provisional INT in a dashed box, patient, part).
2. The current finding as one plain sentence, beside a short list of open items with their ids right-aligned.
3. Evidence: the order record, the bottle and the requisition, drawn from their own records and sitting above the columns they feed, with the differing token marked in each. Differing rows come first and fields stated by only one source come last as "Not compared". A missing value is never a match.
4. A bottom band holding the primary action for the current person: `Send CLR-0457 to Harbor Point Dermatology (simulated)`. Next to it is `Request accession (simulated)`, disabled, with the reason in words. Record details and history sit below the fold.

## Blocked case and decision context

- **Blocked:** the rail's `Accession` ghost node opens a per-part sequence from Received to Tray. Progress is shown by tone: dark means done, blue means current, a dashed line means waiting, plum means held, pale means later. In this view Part A and Part B are both waiting on REL-0112 at Accession, and only Part B is held at gross approval, processing, labels and tray. The view also says "Hold H-0090 does not block accession" and "Part A is not held", and the "What unblocks it" list names the owner of each block.
- **Decision (taken as Kim Nguyen, the lead):** the decision sits in the band. Above it, the identity, the finding, both order columns, the dashed REL-0112 bridge with what the orders share and what stays separate, and the whole rail all remain visible. Choosing an option shows its effect before anything is recorded ("both orders and both provisional ids are kept; nothing is merged"). A reason is required. Recording is preview-only.

## Reference qualities adapted, and what was not copied

- **Adapted:** typographic contrast as structure (the two-tone headline); one plain sentence for the finding, followed by short lines with ids aligned to the right; progress shown by tone along a short sequence; sources drawn as inputs that converge on one Agreement column; surfaces with distinct roles; hairlines and restraint.
- **Not copied:** no serif display face, no paper grain, no green or charcoal sections, no glass navigation, no hub diagram, no map, no marketing layout. The branding, text and graphics are not reused. There are no tracked all-caps eyebrows, no "→" on buttons and no middle-dot meta strings in our own copy.

## One honest disadvantage

The atlas is ordered the physical way: courier, then office, then submission. Exceptions are flagged where they sit, but they are not gathered at the top. On a heavy day with several couriers and dozens of items, the rail becomes a long scroll. The accessioner has to use the "Exceptions" filter to get the exceptions-first view that the current queue gives by default.
