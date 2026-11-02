disposition: fix

## verdict
- **(1) Retrieval column at 1024: resolved.** In `materials-retrieval-1024.jpg`, "Still to pick (3)" shows D26-03990 A1, D26-03990 B1 and D26-03912 A1, each with Scan. The wrong block D26-03909 A1 sits under a dashed rule marked "Not on this request". All four rows are above the pinned Deliver row, and the Slot tile is on one line. In the mismatch state (`materials-retrieval-wrong-1024.jpg`) there is an explicit count cue, "4 more blocks below", and Deliver stays in view. That meets the letter of the fix. See regression R1.
- **(2) '(' and '/' split across lines: resolved.** The tray cue reads "Scan each slide as you lay it in. [/] goes to the scan field." on one line at 1024 and 1366. The retrieval tab no longer has the cue line, so nothing can split there. See regression R3.
- **(3) Tray bench scan action at 1024: resolved.** In `materials-tray-unexpected-1024.jpg`, the off-list slide is drawn on its side beside the tray and the first bench Scan sits at about y686–730. In `materials-tray-refused-1024.jpg`, "Found it" sits at about y704–748. Both are inside the first viewport. At 1366 (`materials-tray-unexpected-1366.jpg`), the off-list slide and three bench cards sit side by side with Scan in view.
- **(4) Remove local overrides and re-check with the new scan line: partial.**
  - Removed: the materials files now import the shared `IdText` from `@/components/domain/id-text`.
  - Visible: the selected-row outline on PJ-8841 and LabelPreview breaking "deeper / L1" at a space (`materials-print-unknown-1024.jpg`).
  - Not evidenced: the amber print 'Failed' StatePill appears in no capture.
  - Failed re-check: the retrieval mismatch scan line is cut to "RR-0192 needs D26-03990 B1,…" at 1024 and 1366 with no "Show all". The reason is in `src/components/shell/scan-field.tsx:142`: the button only appears when the message is over 110 characters, not when the text actually overflows. The fixer's re-check did not report this.
- **(5) Hatched held slot and scan-ping capture: partial.**
  - Held slot, resolved: slot 2 is hatched with a "Hold" marker in `materials-tray-hold-1024.jpg`.
  - Scan-ping, not shown working: in `materials-tray-scanping-1366.jpg` the ring on slot 10 is a faint pink edge that is hard to tell from the slot border, even with the animation held at 160ms. It proves the motion exists, not that it works as a cue.
- **(6) 200% zoom reflow: partial.**
  - Tray, passes (`materials-zoom200-683.jpg`, `.impeccable/review/materials/zoom200.png`): one stacked page; only the top bar is pinned (about 102/384 = 27% and 102/450 = 23%). The tray label and the next action (the scan field in the bar) are in the first view. The tray picker scrolls sideways inside its own row.
  - Retrieval, passes (`materials-retrieval-zoom200-683.jpg`): same layout, with RR-0192's identity in view.
  - Print labels, fails (`materials-print-unknown-zoom200-683.jpg`): the SidePanel header stays pinned under the top bar, about 207/384 = 54% of the height. That breaks the one-third limit, and the reconcile step only shows inside a small leftover scroll area. This needs the shared SidePanel change.
  - No horizontal page overflow is visible in any zoom capture.
- **Regressions introduced by this batch:**
  - **R1:** in the retrieval mismatch state at 1366 (`materials-retrieval-wrong-1366.jpg`), the column shows the "Still to pick (3)" heading with no rows under it, then "4 more blocks below". The cue's count disagrees with the heading because it counts the off-request block as a block to pick. At 1366 the whole pick list is hidden behind the cue, while the red banner just repeats the scan popover.
  - **R2:** the scan line on the retrieval tab is cut with no way to expand it (the shared 110-character trigger above). The full text is only reachable through the column banner or the `title` tooltip.
  - **R3:** removing the hint on the retrieval tab means it no longer tells the user that '/' jumps to the scan field, while the tray tab still does. Two tabs on the same screen now teach the shortcut differently.

## remaining
- **Print labels at 200% zoom:** the pinned SidePanel header takes 54% of the height at 683x384 and 46% at 720x450. This needs the shared SidePanel to scroll its header with the body (or render inline) below 1024 px wide or 560 px tall.
- **Scan-line clamp:** `scan-field.tsx:142` should key "Show all" on actual overflow (scrollHeight against clientHeight), not message length, so the retrieval mismatch line can be expanded. This is shared and owned by the lead.
- **Mismatch-state retrieval column (R1):** make the cue count match the heading, e.g. "3 to pick + 1 not on this request below". At 1366, shorten the banner so it doesn't repeat the popover and at least the next row stays visible.
- **Retrieval '/' hint (R3):** bring the hint back in the bound form the tray tab uses.
- **Scan-ping ring:** too faint to work as a cue (shared utility); needs more contrast or width.
- **Amber print 'Failed' StatePill:** not shown in any capture.
- **Red on this screen:** the wrong-block banner, the "N wrong scans rejected" chip and the mismatch line in the scan log are red, which contradicts the surface brief's "red is never used on this screen". The lead has to rule on it.
- **Not run:** the Playwright suite.

disposition: fix