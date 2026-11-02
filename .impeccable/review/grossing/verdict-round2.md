verdict
- (1) Labels below 1280: **resolved.** In grossing-hold-1024.jpg, grossing-entered-1024.jpg and mobile.png the back link reads "← Grossing queue" as visible text. The parts strip shows the full states, for example "Part B: On hold (H-0089)" and "Part A: Approved, entered (staff attested)". When the states don't fit, the strip moves to its own row instead of shortening words. A grep finds no remaining PART_STATE_SHORT or LEGIBLE_DISABLED.
- (2) Orphaned numeral at 1440: **resolved.** In grossing-instruction-1440.jpg, "2 instruction-like sentences in the dictation were ignored and changed nothing." stays together on one line.
- (3) Shared parts adopted: **resolved.**
  - Disabled "Mark operator reviewed" and "Approve for downstream use" use the shared style and stay readable (mobile.png, user-1366.png, grossing-zoom200-step-683.jpg).
  - "Approve for downstream use" plus the Ctrl badge fills the dock width as a block button and wraps cleanly (grossing-reviewed-1024.jpg).
  - The selected-row outline covers the sticky D26-04797 Part C cell (grossing-queue-1024.jpg).
  - The first-cell hold hatch was a fixer claim outside this item, and it was not visible in any capture checked.
- (4) IdentityBar "Open case": **resolved.** At 1024 the hold capture shows a folder icon only, and the bar stays on one row beside "Hold: Part B". At 1366 and 1440 the text label is back. workspace.tsx:1237 keeps "Open case" as an sr-only label below 1280. The tooltip itself does not appear in any capture.
- (5) Local CtrlEnterBadge: **resolved.** The local copy is kept as instructed, and the badge renders in the reviewed-1024 dock.
- (6) 200% zoom reflow: **resolved.**
  - **No horizontal scroll:** no horizontal scrollbar or cut-off content at 720 or 683 in any zoom200 capture checked. That includes the queue, where the header row Part / Site, procedure / Gross record / Next step fits once Owner is hidden (queue.tsx:241).
  - **Pinned chrome:** about 204 of 900 device px at 720 (23%) and about 204 of 768 at 683 (27%).
  - **Identity first:** the order is identity, then the band (zoom200.png, grossing-zoom200-hold-683.jpg).
  - **Next action reachable:** "Your next step" with "Go to piece count" is reachable by vertical scroll only (grossing-zoom200-step-683.jpg).
  - **Focus below the pinned bar:** the focused Piece count input sits below the pinned bar (grossing-zoom200-focus-720.jpg).
  - **Limits:** the identity bar scrolls away at this zoom. That passes the "reachable" bar but not a "visible" one. The queue's data rows sit below the fold in both zoom queue captures, so the row fit is inferred from the header row and queue.tsx, not seen.
- Regressions: none found that block shipping. At 1024 the strip wraps to two rows and the band reaches y≈470 of 768. This is the cost of full words, it scrolls with the record, and the dock stays visible.

remaining
Clear for the six scored items. Not scored and still open:
- The downstream readiness "A · B · C" meta string.
- Em dashes in server-supplied extractor notes ("— count not stated").
- The fixer's shared requests: the Timeline `relative` fix, IdText excluding *-SIM system names, a shared `stacked` variant, and promoting CtrlEnterBadge.

This ship covers only the six scored fixes, not the whole grossing surface.

disposition: ship