# Intake task map and navigation

Product/UX and information architecture for Histology Redesigned, 2026-10-14. Evidence: `scripts/fixture-intake-review.ts`, `src/server/queries/intake.ts`, `src/components/intake/*.tsx`, `docs/redesign/before/`.

## 0. Baseline evidence

- **The decision is below the fold.** At 1366 (`before-intake-hero-b-1366.jpg`), the chrome, a two-row identity bar and the courier strip leave room for about six comparison rows. Related review, routing and holds are out of view (`workspace.tsx` stacks ten cards). The only stated reason is a cut-off footer, "Cannot request yet: REL-0112…".
- **Missing context.** The hold chip names Part B but not what it blocks. Part A's screen never mentions H-0090 or REL-0112. The queue says "1 of 1 container checked" for a container with a recorded discrepancy (`arrival-queue.tsx`).
- **Mixed badges** (`server-data.ts`): Intake 12 adds two lanes together, and the Operations badge of 3 counts holds.
- **Keep:** the three-source comparison, where "Not compared" is never "Same"; Simulated tags; scoped hold wording (`clarification-dialog.tsx`).

## 1. Task map: the bench after the 11:00 courier

Roles come from `src/lib/roles.ts`. The accessioner verifies, confirms routing, raises and sends clarifications, and requests accession. Only the lead or supervisor reviews related orders, overrides routing, accepts mismatches, resolves clarifications and releases holds.

| Question | Looks at (fixture) | Decides (who) | Blocks progress | Never automatically |
|---|---|---|---|---|
| What arrived, and what still needs reconciling? | CR-1014-11 has 11 received. Expected is **Unknown** for the 2 offices with no manifest. Coral Lane is missing ORD-77140 part B (INT-1014-027). Seagrape is an unknown office (INT-1014-034). | The next item; exceptions do not stop routine items (accessioner). | Missing container or routing exception, for that item only | Turn Unknown into 0 or "complete" |
| Which case and part am I on? | Provisional INT-1014-032, Part B, punch, Avery Quinlan (Synthetic), MRN 448210 at EMA-SIM Sunrise Coast. Ordered by Dr. Hannah Cole; routed to Dr. Elena Marsh. Sibling: INT-1014-031. | Whether the bottle in hand is this record (person at the bench). | Unsaved edits when switching | Carry values to the next item; treat a matching name or DOB as the same case |
| Which source says what, and where do they disagree? | `comparison` rows across order v1, the bottle (staff entry) and the requisition. Laterality: Right, "L", Right. MRN and collection date are `not_compared`. | Whether the observation is right and the difference is real (accessioner); accept a mismatch (lead, with a reason). | `discrepancy_uncovered`, `verification_stale` | Edit one source to match another; count "not stated" as a match |
| What decision is needed, who owns it, and what is the evidence? | CLR-0457 is drafted, owner Maya Torres, follow-up 11:30. REL-0112's review task belongs to Kim Nguyen: six reasons (patient reference, ENC-55031, office, day, clinician, courier) and one conflict (two order ids). | Send CLR-0457 (Maya). Link as related, Keep separate, Not related, or Ask the office (Kim). | `related_pending` blocks accession on **both** parts | Merge on look-alike demographics; treat a sent message or a simulated reply as resolved |
| What is ready for the next stage, and what holds it? | `readiness.blockers`, `HoldView.blocks`. Part A is verified and routed. **H-0090 holds Part B only:** gross approval, processing, labels and tray delivery, not accession. | Request accession: both parts together if linked, separately if kept apart (accessioner; D26 issued by the simulated source). | Blockers; source offline | Show a part hold as a case hold; show a local "ready" as issued |
| Where was the material last recorded, and is that confirmed? | Container 1: received 11:00 by Maya from CR-1014-11, with verification state, who and when. Downstream: a block's last confirmed location, time and person. | Re-check if the order changed; open a missing-material investigation. | Stale verification; missing item; checkout | Treat a scan as proof of the tissue; call last-seen "live" |

## 2. Navigation by job (replaces Bench, Oversight and Admin in `side-nav.tsx`)

A badge counts work the viewer can act on now, for their role. It shows Unknown when it cannot be computed, never 0, and never adds unlike things together.

| Group | Contains | Counts that matter |
|---|---|---|
| **Receive & reconcile** | Intake (queue and item), courier manifest by office | To reconcile 7 and Exceptions 5, shown separately; missing containers |
| **Clarify** | Clarifications; Holds with their scope (today visible only in Operations) | My drafts to send; overdue follow-ups (2); answers to review (lead only). Not "7 open". |
| **Gross & enter** | Grossing by part; source entry (today `/worklist?view=grossing`) | Awaiting an approved record; approved, not yet entered; attested, not yet acknowledged (kept separate) |
| **Bench histology** | Worklist, Print, Trays and Retrieval as separate entries (now tabs under Materials; each has its own scan target) | Changes since my acknowledgment; unknown print outcomes; trays that cannot complete; retrievals open or overdue |
| **Oversee** | Operations, Insights (illustrative), routing rules and office contacts (out of Settings) | No badge; show the "as of" time |
| **Presenter-only** | Guided demo, demo clock, acting-as switch, simulated courier unpacking, printer behavior, scanner tiles, simulated acknowledgment, demo scenarios | None |

Presenter controls live in a separate drawer with its own surface and never appear in a bench action row. Bench screens keep the Simulated label on each connector result.

## 3. Intake: always visible, on demand, history

**Always visible** (at 1366 × about 650 px usable):

1. **Identity line, one row.** The provisional INT id goes in a dashed monospace chip, never shaped like the solid D26 chip. Then the part, site and procedure; the patient with a Synthetic tag; the MRN with its tenant; the office. The doctors carry their roles: "Ordered by Dr. Hannah Cole", "Routed to Dr. Elena Marsh".
2. **One finding sentence**, derived from blockers, clarifications and related reviews.
   - B: "Order says right dorsal forearm; the bottle says left. CLR-0457 is drafted for Maya Torres. Accession also waits for Kim Nguyen's review of REL-0112."
   - A: "Part A agrees on every field that could be compared and is staff verified. It waits only for REL-0112."
3. **Step sequence shown by tone.** Received, Verified, Routed, Related reviewed, Accession requested. The current step is dark and later steps are pale. A blocked step names its blocker underneath.
4. **Hold line, shown on both parts.** "H-0090 holds Part B only: gross approval, processing, label printing, tray delivery. Accession is not held. Part A can continue."
5. **Related strip.** INT-1014-031 / ORD-77120 and INT-1014-032 / ORD-77121, REL-0112, its owner, and "Review, not merge. Both orders and both provisional ids are kept."
6. **Comparison, every row.** The three sources are columns that converge on a result. Rows that differ are dark and rows that agree are quiet. "Not compared" gives its reason and never shows a check. Each differing row has "Raise clarification".
7. **The current step's action**, with the reason in words when blocked and a Simulated label when the source is involved.

The queue lists exceptions first and keeps the members of one related review together. Its rows say "Verified 0 of 1, discrepancy recorded".

**On demand** (opens in place): the per-office manifest; the bottle-label card (open until verified); REL-0112 reasons and conflicts, with the decision form for the lead or supervisor only; the routing rule (v3, effective date, coverage) and override with a reason; the CLR draft and follow-up in a side panel; source order versions and the encounter; the full blocker list; notes and corrections.

**History** has its own tab: the audit timeline, superseded routing, earlier verifications against older order versions, accepted mismatches, request attempts and released holds.

**Keyboard and scan:**

1. The scan field has focus on load, with the prefix "Find intake item".
2. Scanning an ORD id, an INT id or label text opens the item. The result line says "A scan identifies the record; it does not verify the tissue." Two tenant matches give numbered choices; no match offers to create a provisional item.
3. The finding sentence is announced. Tab moves through the differing rows, verify, related, routing and the action.
4. `Alt+Down` jumps to the next row that differs or was not compared. `R` raises a clarification for that field, scoped to the part.
5. **Verify** always opens a confirmation that names the container and the person; a scan never sets it.
6. `Ctrl/Cmd+Enter` runs the step's action with the same confirmation, or announces the blocker. Focus then returns to the scan field.
7. `J`/`K` move through the lane. Switching items with unsaved edits asks first, and values never carry over.

## 4. Other screens: the primary surface

- **Operations:** the blocked-work list (item, blocker, next step, owner, age, evidence). One sentence opens it, for example "3 holds open; the oldest, H-0089, has waited 1 h 24 min for the office." The nine equal tiles in `before-operations-1440.jpg` become one line of filters.
- **Worklist:** the table grouped by dermatopathologist, with the "changes since my acknowledgment" strip on top. Tabs and filters fit on one line (about 300 px today). Readiness, PAS and holds are in words.
- **Grossing:** the current part's structured fields, unconfirmed first, with the transcript beside them as the source. The parts strip (A, B, C) is pinned with the identity line, and the approval blocker is in words.
- **Materials:**
  - Print opens on unknown outcomes to reconcile.
  - Trays shows the open tray's expected slides, each scanned individually.
  - Retrieval shows the pick list grouped by location in bench order, with the last confirmed location, time and person, labeled "not live".
  - The scanner tiles move to the presenter drawer.
