---
target: Intake screen (after redesign)
total_score: 31
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 1
target_identity: "file:/Users/jorgerodriguez/Desktop/Histology Project/src/app/intake/page.tsx"
target_fingerprint: "sha256:173d1db48a5b618d6ed20728969e3752b9ef982fb33b5cae59da47fc6e09a58e"
target_path: /Users/jorgerodriguez/Desktop/Histology Project/src/app/intake/page.tsx
timestamp: 2026-10-15T01-45-56Z
slug: src-app-intake-page-tsx
---
DEGRADED: single-context (independent re-score by one reviewer at the caller's request; no isolated A/B sub-agents; heuristic scores fixed from rendered captures + source before the detector ran; no live browser pass)

Evidence: docs/redesign/after/intake-{normal,routine,mismatch,identity,exception,empty,decision,decision-preview,send-notice,sent,stale,conflict,accessioned,drawer,readonly,keys-dialog,zoom200}-*.jpg at 1366 / 1440 / 1024 / 200% zoom; baseline docs/redesign/before/before-intake-hero-a-1366.jpg; source src/components/intake/** and src/components/shell/**. Previous run: 28/40, 4 P1.

## Design Health Score
| # | Heuristic | Score (prev) | Key Issue |
|---|---|---|---|
| 1 | Visibility of System Status | 4 (3) | Finding sentence, five-step rail with owners, "Waiting on" with names, "3 of 11 checked", source offline in bar + banner, paused clock, dimmed-while-loading on J/K, live-region "Now working on". Small gaps: toast sits on the decision foot; at 1366 a chosen decision's effect preview is off-screen |
| 2 | Match System / Real World | 3 (3) | Bench words throughout (bottle, requisition, container 1 of part A, official number: not issued). Codes used as nouns: "Kim Nguyen's review of REL-0112", "rule v3", "MRN in EMA-SIM Sunrise Coast" |
| 3 | User Control and Freedom | 3 (3) | Conflict dialog (keep editing / discard / load latest and re-apply), leave-with-unsaved guard, Esc everywhere, decisions changeable later, single-key toggle. No visible undo for a recorded container check |
| 4 | Consistency and Standards | 3 (3) | Severity ladder applied consistently. Drift: "Clarify" vs "Clarifications", "Find intake item" vs "Find record" (keys dialog), finding says "a lead" while Waiting on names Kim Nguyen; Record decision uses native disabled while Request accession uses aria-disabled |
| 5 | Error Prevention | 3 (3) | Ctrl+Enter shows its target and never attests; reason required; effect stated before recording; "Review notice, then send". At 1366 the required reason field and the 4th option sit below the fold of a 336px column |
| 6 | Recognition Rather Than Recall | 3 (3) | Three sources aligned, differences first, owners named. Lead decides REL-0112 while the centre shows Part B laterality, not the A/B plates; queue is a drawer at 1024; "+2 more" and "Show all 4 reasons" hide reasons |
| 7 | Flexibility and Efficiency | 3 (2) | J/K and arrows work on load, 1-5 jump to steps, G-sequences, / and Ctrl+K, visible Ctrl badge, single-key toggle. No batch path for clean routine items (check + accept routing + request = 3 commits each) |
| 8 | Aesthetic and Minimalist Design | 3 (2) | Calm, specific, one finding per item. The mismatch is still stated 5-6 times per screen; "A scan identifies the record; it does not verify the tissue" on every sheet; right column empty in most states, cramped in decision/send states |
| 9 | Error Recovery | 3 (3) | Conflict and offline recovery preserve work and name the next move ("Your verification is saved locally. Request the accession when the source is back"). Blocker reasons are plain text, not links to the step that clears them |
| 10 | Help and Documentation | 3 (3) | Per-step instructions with consequences ("Records your name and the time. Ctrl+Enter and scans never record it"), full keys dialog, "What is simulated?". No on-screen key for dashed = provisional, hatched = hold, hourglass = waiting |
| **Total** | | **31/40 (28)** | **Good** |

Cognitive load: 1 checklist failure (working memory: the lead must carry the A/B plate comparison from the centre column down to a decision in the right column). Largest decision point: 4 options (REL decision), within limit.

## Design Specificity Verdict
LLM assessment: now specific to this bench. The part is set as its specimen label (dashed provisional label with a big part letter, then solid with DataMatrix once EMA-SIM issues D26-04817); order / bottle / requisition sit in aligned columns with the differing row first and the bottle's own glyph underlined; holds are hatched pills with stated scope ("stops gross approval, processing, label printing and tray delivery. Accession is not held"); the queue groups REL-0112 parts under a "not merged" bracket; owners are named with an hourglass. The H&E palette is restrained and the severity ladder (red octagon identity, amber triangle field, hatched hold, neutral waiting) replaces the one-orange baseline. Remaining category-generic pieces: the step rail reads as a standard SaaS stepper/tab strip; the empty state's office manifest is an equal-tile grid (seven cards), the template tell the visual system itself forbids; queue / detail / action-column is a familiar master-detail frame (justified here, but not distinctive).
Deterministic scan: `impeccable detect` on src/components/intake + src/app/intake: 0 findings (previous run: 3 side-tab hits in holds-card, workspace, scan-field). src/components/shell + domain: 4 advisory off-ramp font sizes (job-nav.tsx:77 count badge 0.6875rem = 11px, below the 13px floor; specimen-label.tsx:48 1.375 / 1.75 / 1.875rem, intentional label scale). No browser overlay was run.

## Overall Impression
The four P1s from the last run are addressed on screen: the bottle in hand anchors the composition, the person's own next step is fixed at the top right with its Ctrl badge, the queue shows all five exceptions at 1366, severity reads at a glance, and the keyboard model is coherent. The biggest remaining opportunity is the one high-stakes decision that does not fit the frame: the lead's "one case or two".

## What's Working
- The decision column answers "what do I do" in every state seen: "Check container 1, Part A, against the order", "Send CLR-0457 to Harbor Point Dermatology / Drafted, not sent", "Nothing for you on this item right now / Open INT-1014-034", "Read only", each with Waiting on and the request's reason beneath.
- Honest, specific recovery: the conflict dialog compares their value with yours and offers "Load latest and re-apply my changes"; the offline state says exactly what still works locally.
- The identity band carries the identity conflict itself (red DOB pair in the header for Kettering), so the patient-identity rung is unmissable.

## Priority Issues
- **[P1] The lead's REL-0112 decision does not fit the 336px column at 1366x768.** Evidence: decision-1366 / decision-preview-1366 show 3 of 4 options, "1 more option below", and a disabled "Record decision" whose reason ("Give a reason; it is recorded with your name") points to a field that is off-screen; after choosing, the effect preview ("If recorded: ... Nothing is merged") is also off-screen (visible at 1440, decision-preview-1440, but the reason field still is not). The centre meanwhile shows Part B's laterality table; the A/B plates the decision rests on are in RelatedSection below the evidence sheet. Why it matters: it is the most consequential choice on the screen (one accession or two) and the person must scroll an inner pane and recall evidence from elsewhere; the director watches this exact moment in the demo. Fix: when the next step is a related-orders decision, lead the centre with the A/B plates and put the four options, effect sentence and reason in a wide band there; keep the column to a one-line summary plus "Record decision", or fold Waiting on / Request accession at this step to give the column its height. Suggested command: /impeccable layout (then /impeccable adapt for 1024).
- **[P2] Confirmations land on the decision foot.** The toast is fixed bottom-right at 1280 px and wider (toast.tsx:61), exactly over Request accession and its reason (sent-1366) and over the accession result / "Open case D26-04817" (accessioned-1366), breaking "the reason an action is blocked is always stated" while it shows. Fix: anchor bench toasts bottom-left of the evidence pane or at the top of the decision column, or confirm inline in the step card that already changes state. Suggested command: /impeccable polish.
- **[P2] One fact is said five or six times per screen.** mismatch-1366: identity-band chip "Order says Right, bottle says L.", finding sentence, rail "CLR-0457 · not sent", evidence row "Differs / The bottle disagrees", row footer "Question CLR-0457 drafted, not sent", queue row "Laterality differs"; plus the scan disclaimer on every sheet header and a two-line hold sentence. Fix: drop the identity-band chip when the finding band is on screen (keep it in the stacked/200% layout, where the finding is far away); say the scan disclaimer only in scan feedback; shorten the hold to its scope and what stops. Suggested command: /impeccable distill.
- **[P2] The bench's main input is not the widest element and clips itself.** At 1366 the scan field is ~300px and its hint reads "Scan order id, INT id o" (also clipped at 1440); with Offline showing, its label clips to "Find intake it..." (stale-1366). Below 1366 the job nav is icon-only with title-only tooltips and 11px count badges. Fix: shorter hint ("Order, INT or label text"), let the scan field take the free width, collapse the "Find intake item" label to icon + sr-only text when space is short, 13px badges. Suggested command: /impeccable adapt.

## Persona Red Flags
**Alex (power user):** J/K, arrows, 1-5 and Ctrl+Enter now work as documented. Still no batch for clean routine items: each of 7 "To review" items needs Record check, Accept routing and Request accession separately. At 1366x768 the queue shows the 5 exceptions and about one routine row; at 1024 the queue is behind a drawer. Long two-line button labels ("Record: I checked this bottle against the order", "Choose the dermatopathologist").
**Sam (keyboard / screen reader):** Request accession is aria-disabled and explains itself on click or Ctrl+Enter, but "Record decision" uses native disabled, so it drops out of the tab order and its reason is reachable only by reading on. Icon-only nav below 1366 has sr-only labels (good) but title-only tooltips, invisible to sighted keyboard users. Severity always pairs icon, colour and words.
**Maya (accessioner, 11:05 courier rush; project persona):** the label-led identity and fixed next step serve her well. The notice the office will receive ("Review notice, then send") is cut under "More below" directly above "Send (simulated)" at 1366, so she can send without reading the whole notice. Right after sending, the toast covers the accession request and its reason. On a routine item the Result column already shows "Same" on six rows before she has checked the bottle.
**Kim (accessioning lead; project persona):** deciding REL-0112 means scrolling a 300px inner pane for the fourth option, the reason field and the effect preview, while the evidence that matters (the A/B plates) is below the laterality table in the centre.

## Minor Observations
- Queue lane headers are sticky and clip a half-row after auto-scroll ("Dr. Okafor" fragment under "Exceptions 5" in routine/stale; "0 of 1 container checked" under "To review 7" in accessioned).
- Exception item (Owen Pratt): the next step is routing while "Check container 1, Part A" is under "Also yours now", although the rail puts the container check first and the bottle is in her hand.
- Accessioned: the Ctrl target is "Open INT-1014-022" (next item) while the filled primary is "Open case D26-04817": two competing "next" actions.
- Identity finding says "waits for a lead"; Waiting on names Kim Nguyen. Name the person in both.
- The step rail mixes two encodings (coloured top edge for severity, tint for "yours"); the tint is never explained.
- The empty state's seven equal office tiles are the equal-card pattern the visual system bans; a table (office, expected, received, missing, items) would read faster.
- Office names truncate in queue rows at 1366 ("Harbor Point Dermat..."), acceptable, but the doctor short name could yield first.
- 200% zoom: the first viewport is identity band + finding; the next step starts below the fold (the trade-off the brief accepted).
- Disabled-state contrast now passes (ink-muted on surface-subtle), up from about 2.4:1.

## Questions to Consider
- Should the lead's "one case or two" take over the centre (plates side by side, options beneath) instead of living in a 336px column?
- If the finding band states the disagreement, what does the identity-band chip add at 1366, and could it appear only in the stacked layout?
- Should a confirmation ever cover the place where the next action and its blocked reason live?
- What would a routine-lane fast path look like ("check, accept suggested routing, request") that keeps the per-bottle attestation deliberate?
- Should "Same" ticks wait until the bottle check is recorded, so the screen never looks finished before the person has looked?
