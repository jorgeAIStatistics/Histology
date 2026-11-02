# Intake concepts A, B, C: independent comparison

Reviewer pass, 2026-10-14. I read all 15 concept screenshots and the before-B baseline, and checked the claims against the code. All three concepts read `intakeBench()` with no hardcoded fixture values, and `tsc` passes. Score key: 2 means the task can be done from the visible screen with no domain-rule risk, 1 means it works with a gap, 0 means it is not supported.

| Task | A: Precision workstation | B: Specimen atlas | C: Guided desk |
|---|---|---|---|
| 1 Select an arrival, identify the part, compare | **2.** Queue shows exceptions first, with office, doctor and the related pair bracketed. Identity is sticky. The matrix has a Result column. | **1.** The rail groups by office, so the identity conflict INT-1014-022 lands at the end of the rail. | **1.** Best identity strip. Queue rows have no office or doctor and use unlabeled ticks; about 2.5 rows show at 1366. |
| 2 Find the mismatch and the block | **2.** The finding sentence and the reason by the dock are visible at both sizes. | **2.** Sentence, open items with ids, and "Waits for REL-0112" in the band. | **2.** Two-tone sentence, hold line, and step 5 "Blocked by REL-0112", all in the top 310px. |
| 3 Review the related order without merging | **2.** Kim: one click. Every option states its result; A and B plates show the shared facts. | **2.** The REL bridge is always in the tree, and the chosen option previews "Nothing is merged". | **2.** Ladder of shared facts. Identity, finding and evidence stay on screen while deciding. |
| 4 Permitted action, owner and history kept | **2.** One button for the person who can act, and the reason is recorded with a name. The owner is not named, and history is 1.5 screens down. | **2.** "Next for Maya Torres", and the options are disabled for her role. | **2.** Owner, follow-up, "resolving does not release the hold" and History all sit at the action. |
| 5 Hold, stale check or concurrent edit can't hide | **1.** The hold scope shows only after pressing Request. Step 01 shows ✓ even when the order changed after the check (`orderChangedSinceVerification` is unused). | **1.** Stale checks are not flagged, only `containers[0]` is read, and the header scrolls away. | **2.** The hold-scope line is fixed on every step and on Part A. Stale checks are flagged, and the version shows at the action. |
| 6 Keyboard or scan, identity kept | **1.** `/` and a working scan ("identifies, does not verify"). No row or step keys. | **0.** Find record has no submit handler, the hint is hidden, and identity is not sticky. | **1.** `/`, scan, and 1–5 for steps. Like A, the scan field is not focused on load and focus does not return after an action. |
| **Total** | **10** | **8** | **10** |

None of the three draws a concurrent-edit (version conflict) state.

## Visual defects

- **A:**
  - At 1366 the vertical path is cut after step 02, so the blocking step 03 is not visible, and the matrix ends at Laterality.
  - The identity leaves out the ordering clinician, and the hold pill and the hold block say the same thing.
  - Dashed outlines are used for the INT id, the Synthetic tag and a disabled button.
  - The yellow blocked-state flash clashes with the spec's yellow for PAS.
  - Two heavy ink masses compete. The Result glyph is cryptic, office names are cut short at 1366, and "Missing 1 known" reads awkwardly.
- **B:**
  - The drawn order, bottle and requisition take about 150px, so only 2 rows show at 1366, and the bottle drawing reads like a photo of the label.
  - In the sequence, the Done and Current lines are nearly the same color, the orange line is missing from the legend, and labels wrap to three lines.
  - The decision view drops the evidence, the band cuts off the provenance line, and the raw `same_patient_reference` code shows.
  - It is the closest of the three to the reference sites' editorial look.
- **C:**
  - The rail footer covers the queue (INT-1014-031 is cut off at 1366), and "Missing 1+" is cryptic.
  - The 445px evidence column has no Result column; a ✓ beside the field reads as "verified", and the row that differs is not first.
  - The fixed header takes about 310px.
  - The ladder text runs into its rails, and "both kept" uses the triangle that means "differs".
  - Only the selected REL option shows its result.

**Clichés:** none of the three uses cream and serif, acid green, a card kit, caps eyebrows or arrow buttons. The stray middle dot ("ORD-77121 · B") and the "Not issued" monospace are minor slips. B drifts most toward hairline editorial.

## Recommendation

**Implement A.** A and C tie at 10, and the brief says to prefer A in a tie. A also has the best parts for practiced staff: the queue, the matrix, the part-by-part hold grid and the pinned request dock.

**Borrow from C:**
- One fixed band under the identity: the two-tone finding, the hold scope on both parts, and the five steps shown by tone with owner and blocker. This replaces A's vertical path and fixes 1366.
- The ordering clinician in the identity.
- The stale-check step.
- Keys 1–5.
- Owner, follow-up and History at the action.

**Borrow from B:** the effect preview before recording, "Official number: Not issued", rows that differ listed first, and "REL-0112, not merged" on the queue pair.

**Fix in all three:**
- Focus the scan field on load and return focus there.
- Design the version-conflict state.
- Use dashed outlines only for provisional ids.
- Use yellow only for PAS.
