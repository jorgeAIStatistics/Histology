verdict
- (1) R1, scroll body cutting mid-line at 768px height: **resolved**. intake-missing-1366.jpg: "Also yours now 2" folds to "Show all 2" and no half "Raise clarification" button remains under the request foot. intake-decision-1024.jpg: Kim's options stop at whole options under a "More below" cue, so the half "Ask the office first" is gone. mobile.png: the step card for Maya on 032 shows in full at 1024x768. intake-missing-1024.jpg: the step body ends at a whole paragraph with "More below". intake-missing-open-1024.jpg: the step folds to its heading and action, the task shows whole, and "1 more below" sits in the list heading. I found no unit cut mid-line in any recapture.
- (2) Fix 8, presenter controls on the bench: **partial**. On the case states it is a quiet text disclosure with no box and is outside the first viewport in every capture. But intake-empty-1366.jpg shows "Presenter controls (demo)" at y≈717, inside the first viewport at 1366x768. That breaks the condition the lead set for the exception. Also, the empty-workspace text at src/components/intake/empty-workspace.tsx:42 sends the accessioner to "Presenter controls below".
- (3) Lead's top bar and key legend: **partial**. Visible: the synced top bar fits at 1440, 1366 and 1024, and the keyboard-shortcuts button shows at every width, including 720 and 683 at 200%. Not visible: no recapture shows the source-offline top bar at 1024, and none shows the shortcut dialog with the Intake keys. Both are claims I can't verify here.
- (4) 200% zoom reflow: **resolved**.
  - No horizontal scroll at 720x450 (zoom200.png, intake-zoom200-720.jpg) or 683x384 (intake-zoom200-683.jpg).
  - Only the top bar is pinned: 102/450 (23%) and 102/384 (27%), both under a third.
  - The identity band leads the page. The step card carries a compact INT-1014-032 / Part B / patient label.
  - The next action can be reached by page scroll: its top edge shows at 720 (intake-zoom200-step-720.jpg). No capture shows the primary button whole at 683.
  - Nothing is clipped without a way to reach it.

Regressions from this fix batch:
- R-a: Kim's choice is cut short without saying how much. At 1024 (intake-decision-1024.jpg) it shows 2 options and at 1366 (intake-decision-1366.jpg) it shows 3, each under a plain "More below". For a pick-one choice, a cut list with no count looks complete. CutScroll already supports counts (countSelector/countNoun, cut-scroll.tsx:262), so this cue should say "N more options below".
- R-b: The whole-unit cut leaves empty strips around its cue: about 45px under the cue in intake-decision-1024.jpg, about 35px in intake-missing-1024.jpg, and about 40px above the folded list in intake-missing-1366.jpg. At these short heights, the decision column now loses room to empty space.

remaining
- Item 2: move the presenter disclosure below the first viewport in the empty state at 1366x768. Remove the "under Presenter controls below" pointer from the empty-workspace text, or make that text demo-labeled.
- Item 3: capture the source-offline top bar at 1024 and the open shortcut dialog listing the Intake keys.
- R-a: show a count on the options cue in the decision column.
- R-b: shrink or reuse the empty strips around the cut cues at 1024x768 and 1366x768.

disposition: fix