**verdict**
1. Owned routine rows: **resolved.** In `operations-routine-1440.jpg`, `-1366.jpg` and `operations-default-full-1440.jpg`, each record takes one line: record, wait, link. Status and owner are stated once in the group heading ("Sam Ortiz holds the entry task for each of these 6. Approved; not yet entered…"). The per-row "Sam Ortiz" and "D26-xxxxx tasks" text is gone.
2. Octagon identity mark: **resolved.** 8x crops of `desktop.png` show eight flat sides in both places: the Blocked item cell (about 18px) and the finding sentence (about 22px). It is a filled red shape with a white cross and no longer reads as a circled x. Source is `src/components/operations/identity-mark.tsx`.
3. REL-0112: **resolved.** In `operations-default-full-1440.jpg` the Review row sets "REL-0112" in the same bordered LabelRef style as H-, CLR-, PJ- and RR- identifiers.
4. Bench path at 1366: **resolved.** In `user-1366.png`, "D26-04798 part B" stays on one line. The Intake and Awaiting grossing hold chips share a baseline (y≈341), and the stage blocks line up. `mobile.png` (1024) shows the same in its two-row layout.
5. Trays filter tab: **resolved.** In `operations-empty-filter-1440.jpg`, "Trays (0)" appears as a tab and is underlined as active.
6. Focal sentence: **resolved.** At 1440 (`desktop.png`) and 1024 (`mobile.png`) "3 holds stop work and 7 other items wait on a person. [octagon] H-0088 concerns patient identity." fits on one line. "Waiting longest…" is on its own second line, and "(H-0088)." no longer sits alone on a line.
7. Top bar at 1024 while offline: **resolved.** `operations-offline-1024.jpg` shows the full shell in one row (nav icons, Find record, Offline, Synthetic, Tanya) with nothing clipped.
8. 200% zoom: **partial.** What the captures show:
   - `operations-zoom200-720.jpg` (1440x900) and `-683.jpg` (1366x768) show no horizontal overflow.
   - Only the top bar is pinned. It is about 204/900 device px (23%) and 204/768 (27%), well under a third of the height.
   - Both captures stop inside the Bench path. Neither shows the narrow two-column Blocked table, the identity mark, or a "Next:" step.
   - The `max-md:hidden` / `md:hidden` fold exists in `blocked-table.tsx` (around lines 27–28 and 142–170), but no capture shows it. So "identity and next action reachable, nothing clipped" is a claim with no screenshot behind it.

Regressions introduced by this batch:
- R1: The new filled red octagon with a cross now looks almost the same as the shell's red "Offline" mark (`operations-offline-1024.jpg`, top bar). The one shape reserved for patient identity now also means "source offline", in the same viewport as H-0088. The visual system puts a stale or offline source on the amber rung, and the page banner already uses an amber clock.
- R2: In the routine table at 1440 and 1366, the Waiting column stretches to about 320px. The "Entry queue/Entry task" column then starts at x≈533 and leaves the right half of the card empty. Combined with the identical link words on every row, the table reads as a sparse list of repeated words. Minor.
- R3: The two-line "Grossing documentation" label pushes every other stage label about 20px below its top rule at 1440 and 1366 (`desktop.png`, `user-1366.png`), leaving a blank band across nine columns. Consistent, but visible. Minor.

**remaining**
- 8 (partial): needs scrolled 200% captures at 720x450 and 683x384 showing the folded Blocked table with the H-0088 row: identity mark with "Patient identity", owner and waiting as label/value pairs, the "Next:" step, and the evidence link, with nothing clipped.
- R1: the shell "Offline" cue (`src/components/shell/source-freshness.tsx`) should move to the amber rung (clock or triangle) so the red octagon means patient identity only. This is routed to the lead or the shell owner.
- R2 and R3: minor layout tightening, optional before ship.

The scored round-1 items 1–7 are resolved. This covers only the scored items, not the whole surface.

disposition: fix