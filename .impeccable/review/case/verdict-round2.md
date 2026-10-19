## verdict
1. Rail tone (`step-rail.tsx`): **resolved.** In desktop.png, case-overview-1440 and case-hero-1440, steps not yet reached show only a muted label on the hairline, and the empty circles are gone. Done steps carry the dark shell top edge and a quiet check. The current step is filled (hero, Source-system update). The next step is a real 1px outline. Progress now reads in one sweep.
2. Next action and owner for blocked parts: **resolved.** On D26-04797, parts A and B read "Approve gross record v1 for downstream use. Waiting on Dana Whitfield… No task is open." with Open in Gross. On D26-04804 and D26-04800, unowned parts state it as a waiting fact ("Not assigned to anyone. No task is open.").
3. Block on the step it stops: **resolved.** On D26-04797 the Processed cell reads "Loaded on P1", then the lock and "Until approved". The old prose "Blocked: …" line is gone.
4. Hero truth: **resolved.**
   - "Gross record started" now shows "Record v1", and the reviewed and approved steps show "By Dana Whitfield".
   - The source-system instruction appears once. The note under it says something different.
   - The PAS tag reads "Requested on order ORD-75392 v1, part A".
5. Readiness line: **resolved.** It reads "Not ready: A1, B1 and C1 waiting for gross record approval…" and "(+N more)" no longer appears anywhere.
6. `?part=X` locate with scan ping: **partial.**
   - The source confirms it: `part-locator.tsx` scrolls the row into view and restarts `animate-scan-ping`. Rows carry `scroll-mt-40`, so they clear the sticky chrome. The global reduced-motion rule cuts the ping to 0.01ms.
   - No capture shows a `?part=` state, so the result is unseen.
7. Green "Completion confirmed" pill and OS select chevrons: **unresolved.**
   - The green pill is still visible on the PJ-8520 and PJ-8521 rows in case-material-1440.
   - The chevrons were passed on as a shared request, so they are not fixed either.
8. Director-journey e2e steps 4–5 against the real path: **unresolved.** The suite was not run; the only check was a probe against a fixture built through demo steps 1–5. The fixer's skip cites the lead's own constraint, but the promise is still unkept.
9. 200% zoom requirement: **partial.**
   - No horizontal scroll is visible: nothing is cut off at the right edge in case-zoom200-683, case-hold-zoom200-683 or zoom200.png. The fixer reports scrollWidth − innerWidth = 0.
   - Pinned chrome: the identity bar stops being sticky below 560px of height, so only the header stays pinned. It takes about 102 CSS px: roughly 23% of 450 and 27% of 384, both under a third.
   - Identity and the focal sentence are in the first viewport.
   - Not verified: every zoom capture stops at the people list. No capture shows the next step or the rails being reachable, so "the next step sits above the rails" is only the fixer's claim.

Regressions:
- **R1, blocked step outlined as next.** On D26-04797 the blocked Processed cell gets the same next outline as "Approved for downstream use / Next", which gives each part two "next" outlines. The lock is the only thing separating a step that is blocked from the one that is actually next.
- **R2, repeated policy text.** The readiness line ("…before processing (local policy setting)") is repeated in every row's status column ("A1 stays on P1, not processed until then (local policy setting)"). This brings back the same kind of duplication that item 4 removed. Also, the hero part A status heading says "Processing" above a source-system documentation action.
- **R3, false evidence.** `docs/redesign/after/case-material-zoom200-{720,683}.jpg` are byte-identical to `case-zoom200-{720,683}.jpg`. The Material tab at 200% was never captured, although captures_updated claims it was.

## remaining
- Item 6: needs a capture of a `?part=` row in view. The ping cannot be shown in a still image, so the source is the only evidence for it.
- Item 7: the shared `src/components/ui/status-pill.tsx` print/completed state and the `src/components/ui/field.tsx` Select chevron are both still open.
- Item 8: run director-journey e2e tests 4–5 against the real path.
- Item 9: needs a 200% capture scrolled to the first part row, showing the next step and the rails at 720x450 and 683x384.
- R1: give a blocked step its own treatment (lock and words, no next outline), so each track has a single outlined next step.
- R2: say the local-policy reason once, either in the readiness line or in the row.
- R3: recapture the Material tab at 200% under its real filename.

Scope note: if a later round reaches ship, it will cover only these scored items, not a fresh review of the whole case screen.

disposition: fix