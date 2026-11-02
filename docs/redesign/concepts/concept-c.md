# Concept C: Guided reconciliation desk

Preview route: `/concepts/intake-c?item=INT-1014-032` (optional `&step=1..5`). It reads `intakeBench()` on the real fixture and never runs a command. Screenshots: `c-first-view-1440.jpg`, `c-1366.jpg`, `c-decision-1440.jpg` (acting as Kim Nguyen, because only the lead may decide), `c-blocked-1440.jpg`, `c-part-a-1440.jpg`.

```
+- bench rail --+- identity strip (deep petrol) ------------------------------------------------+
| Find record / | [INT-1014-032]  Part B  Avery Quinlan  (synthetic)    Assigned dermpath: Marsh |
| Courier       | DOB   MRN 448210 in EMA-SIM   Order ORD-77121   Office   Ordering clinician    |
| 11 |Unknown|1+|-------------------------------------------------------------------------------|
| Exceptions 5  | Laterality: the bottle says left; the order and the requisition say right.    |
|  INT rows +   | Accession waits on Kim Nguyen's review of REL-0112.        (same size, muted) |
|  5 tone ticks | Hold H-0090 is on Part B only ... Part A (INT-1014-031) is not on hold.       |
| To review 7   |-------------------------------------------------------------------------------|
| Done today    | 1 Container  2 DIFFERENCES  3 RELATED ORDERS  4 Routing  5 Accession (pale)   |
|               |   status + owner under each step      ======= focused step underline         |
|               |------------------------------------------+------------------------------------|
| clock, source,| ONE decision in focus:                   | Evidence (persistent): Order,      |
| acting as     | its own evidence, then the action        | Bottle, Requisition as named lanes |
|               | ... metadata last (received, history)    | field rows, Differs / Not compared |
+---------------+------------------------------------------+------------------------------------+
```

**Type.** Archivo (variable, width axis) for all text: the finding sentence (27px, semi-expanded) and step names (20px) get their contrast from width and weight within one family, so there is no decorative serif. Source Code Pro for identifiers only. I rendered six monospace faces side by side: Source Code Pro's zero has a clear inner dot, and 1, l and I have distinct shapes. JetBrains Mono, my first choice, has a zero that read too much like O at bench sizes. No text is smaller than 13px (the script measured this).

**Color and surfaces.** Each surface has one role: the identity strip is deep petrol `#102F3A` (read first), the desk is white (decide), the evidence panel is `#F4F7F7` (compare, never edit) and the bench rail is `#E8EDEE`. Petrol `#12566A` is the only action color (8.2:1 against white text). Differs is orange `#8A3A0B` on `#FCEFE3` (6.9:1) and Hold is plum `#6B2463` (10.2:1). Both always come with a word and an icon. The steps show progress by tone: done is mid gray with a check (5.6:1), in motion is full ink, and not yet possible is pale `#828D96` (3.4:1, used only for the 18px+ step names). The status words under each step stay at 5.2:1 or more.

**What the user sees first.** The identity, then one plain sentence built from the comparison rows (not hard-coded). Its second tone gives the consequence, and a third line gives the hold's scope in words.

**Primary action.** The focused step is the first one the person acting can do now. If there is none, it is the first step someone else owns. For Maya on Part B that is step 2, "Send CLR-0457 to the office (simulated)". For Kim it is step 3, recording the REL-0112 decision (a reason is required). Every action is a preview: each button has a dashed "Preview: no record changes" tag, and clicking it says what the working bench would do. Keys `1`-`5` switch steps and `/` focuses Find record.

**Blocked case.** Step 5 stays pale with a lock and the words "Blocked by REL-0112 review". When opened, it lists each blocker in words, with its owner and a link to the step that clears it. A separate list, "Open, but not stopping accession", names H-0090 (it stops gross approval, processing, printing and tray delivery, all of which come after accession) and CLR-0457, which covers the laterality difference. The fixture data says H-0090 does not block accession, so the screen does not claim it does. An empty solid "Not issued" accession box sits beside the dashed provisional INT id. The disabled request button has its reason next to it.

**Context during a decision.** In `c-decision-1440` the following stay on screen: the queue and courier counts, the identity strip, the finding, the hold scope, all five steps with their owners, and the full evidence table. The panel draws REL-0112 as two rails (the orders, kept apart) joined by rungs (the six shared facts plus the conflict "both kept"). Only the metadata footer is below the fold.

**Reference qualities adapted.** From Costanera: tone along a short process line, a two-tone headline, hairlines, pill buttons and restraint. From Reveal: one plain sentence that states the finding. The idea of drawing sources as converging inputs became the three named evidence lanes (never merged into one column) and the related-order ladder. **Not copied:** serif display type, warm paper or green sections, grain, maps, glass navigation, gradients, logos, their wording, and any marketing layout. There are no all-caps eyebrows, no middle-dot meta strings and no arrows on buttons, and monospace is used only for identifiers.

**Cognitive load versus clicks.** For a newer accessioner this lowers load: the question "what is left on this item, and who has it?" is answered by five words and owners without opening anything. For an experienced accessioner it adds a click (or a key press) for each step they want to inspect, because only one panel is open at a time. The current screen shows the comparison, related orders and routing together if you scroll. The persistent evidence and the status lines reduce this but do not remove it. Batch work across items (for example, accepting routing on seven routine items) is no faster here, because the desk works one item at a time.

**Honesty fixes made during review.** Three things were caught and fixed:
- INT-1014-022 first read as "agree" because it has no recorded field mismatch. Differences are now derived from the comparison rows.
- The bottle is no longer highlighted as "the odd one". The requisition is printed from the order, so two agreeing documents do not prove the bottle wrong.
- Rail figures overlapped at 1366px.

**One honest disadvantage.** Keeping context on screen costs height. The identity strip, finding and step line take about 310px of a 900px screen, so the decision area is about 590px tall (about 520px at 1366x768). The related-order decision just fits at 1440. By the same measure it will need a short scroll at 1366; I did not capture that. Items with two containers or a long clarification thread will scroll inside the panel.
