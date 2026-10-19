## verdict
1. Severity ladder: **partial.** The run result in the step sheet is now a hairline row with a muted check (demo-step1-1440, demo-step8-run-1440). Synced, Online, Connected and Approved, in effect are neutral pills with a check (settings-demo-full-1440, settings-routing-full-1440, settings-integration-full-1440). But green toasts still fire on these screens: `useCommand` in src/lib/client/command.ts:195 still raises `tone: "success"`, and the fixer confirms it. That covers clock advance and jump, source outage and sync, printer, notifications, assistant, and routing draft and approve. The fix is deferred to a shared request, so the ladder still breaks on Settings > Demo and Routing.
2. Step 8 truth: **partial.**
   - Fixed: the chip now reads "Records: 0 of 1 check done", and the "Not started" chip is gone (demo-step8-run-1440, -zoom200-683).
   - Still wrong: the rail item "8. Operations view, 11:50 AM ET, not started" sits right next to the "Simulator events done" row. The same contradiction moved from the chip to the rail.
   - The "name the missing record" line reads as a claim. "Not yet in the records: Steps 1 to 7 reached their outcomes; Operations now shows what is still blocked" parses as a statement that steps 1 to 7 succeeded, not as a check that is still missing.
3. Say "simulated" once: **resolved.**
   - Integration: the card-header chip, "(simulated source adapter)" and "(simulated)" in the connected pill are gone. Each card shows one quiet state. The page chip, the mode-A banner and the status column remain.
   - Contacts: rows read "EMA message" or "Office portal", and "(simulated)" appears only in the banner (settings-contacts-1440).
4. Action log detail: **resolved.** It now reads "Delivery CR-1014-11 / Status Reconciling / Duplicate No" as label/value pairs with no raw camelCase keys (demo-step1-1440).
5. Integration totals: **resolved.** They render as label/value pairs: Applied 93, Duplicate ignored 0, Stale, ignored 0, Failed 0 (settings-integration-full-1440). The e2e `receiptTotals` in tests/e2e/guards.spec.ts:48-54 is as strict as before: an anchored role=group, fixed order, four numbers, and a delta assertion at :220.
6. Routing disabled reason: **resolved.** "To create the draft, choose an office, choose who it is assigned to and write a reason." now sits under the disabled "Create draft v4" (settings-routing-full-1440).
7. Run toast at 200% zoom: **resolved for the scored item.** demo-step8-run-zoom200-683 shows the title, meta, the missing-record line, the chip and the primary action with its description, and nothing covers them. The shared toast still covers content at zoom on other screens; that is a carried shared request, not scored here.
8. Routing row padding: **resolved.** The two-line office/tenant cells are padded, and each row reads as one record (settings-routing-full-1440; the contacts and integration logs match).
- 200% zoom requirement: **pass on the captures.**
  - No horizontal scroll at 720x450 or 683x384. The fixer reports scrollWidth − innerWidth = 0 (a claim), and no capture shows clipping.
  - Pinned chrome is about 102 of 450 px (23%) and 102 of 384 px (27%), under one third.
  - The actor ("Tanya") and the Synthetic chip stay visible, and the next action is reachable on demo step 8 and Insights. The jump list wraps to two lines without clipping.
  - Note: the demo clock leaves the top bar at zoom. No capture shows where it can be reached instead.
- Regression 1: the two Integration source cards are now both headed "Source system adapter". They differ only by the grey tenant subtitle, so the derived plainName removed the connector's name from the heading rather than naming it plainly (settings-integration-full-1440).
- Regression 2: the step 8 "Not yet in the records:" line asserts an outcome instead of naming the missing record (see item 2). It was introduced by this fix batch.

## remaining
- #1 is partial: `useCommand` success toasts are still green on Settings > Demo and Routing until the shared tone in src/lib/client/command.ts and src/components/ui/toast.tsx becomes the quiet check. Not shippable as a ladder pass.
- #2 is partial:
  - The step rail still says "not started" next to "Simulator events done" on step 8. Make the rail state match the chip's record wording (e.g. "0 of 1 check done").
  - Rewrite the missing-check line as a missing record, e.g. "Missing record: Operations view opened after steps 1–7".
- Regression 1: put each connector's name in its Integration card heading (e.g. "EMA-SIM Sunrise Coast"), with "Source system adapter" as the subtitle.
- Not scored, carried over: the shared toast at zoom on other screens, the TD padding in ui/table.tsx, server-side wording in summarizeResult, and the tsconfig.json include globs to restore. Ceiling items are untouched: the SpecimenLabel on guide steps, the hatched hold on step 3, and courier-time marks on the arrivals chart.

disposition: fix