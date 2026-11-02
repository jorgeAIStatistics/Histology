# Screen-reader validation checklist (Stage 6)

*2026-10-19, branch `stage-6-production-foundation`. Synthetic data only: every name, MRN, office and case is fictional, and nothing here contacts a real laboratory system.*

> **No genuine screen-reader session was performed in Stage 6.**
>
> Nobody has used this application with NVDA, JAWS, VoiceOver, TalkBack or Narrator, and nobody who relies on a screen reader has tried it. What exists is automated:
> - axe-core checks against the WCAG 2.x A/AA and 2.2 AA rules (`tests/e2e/accessibility.spec.ts`);
> - keyboard-only checks;
> - accessible names and roles asserted by the browser tests (Playwright reads the accessibility tree; it does not speak it).
>
> These tools cannot tell whether an announcement is understandable, comes at the right time, is repeated or is missed. This checklist is for the person who will run the first real session. Until it has been run and recorded, **no claim of screen-reader support can be made.**

## 1. Before you start

**Combinations to test.** Run every section with each combination:

| Screen reader | Browser | Platform | Mode notes |
|---|---|---|---|
| NVDA (current release) | Firefox (current release) | Windows 10 or 11 | Browse mode (NVDA+Space toggles it) and focus mode |
| NVDA (current release) | Chrome (current release) | Windows 10 or 11 | As above |
| VoiceOver | Safari (current release) | macOS (current release) | VO keys = Control+Option. Turn on "Press Tab to highlight each item" in Safari Advanced settings. |

Record the exact versions in the results table (section 10).

**Set-up**
1. Start the synthetic demo as in [demo-runbook.md](demo-runbook.md) sections 1 and 2:
   - `npm run build`, then `npm start`;
   - open http://localhost:3100;
   - reset the demo.
2. On the presenter console:
   - Guide, step 1: press **Run simulator events for this step**. This unpacks the 11:00 courier. The browser tests start from the same state.
   - Role and clock: set **Acting as** to the role named in each section.
3. Browser zoom 100%. Window at least 1366×768 (the bench size). Turn off sound feedback in Preferences unless a step says otherwise.
4. Reset again before each section that records something, so every tester sees the same data.

**How to record a finding.** For every step, write:
- what was announced (verbatim where you can);
- whether it matched the expected result;
- for a failure, the keys you pressed.

A step passes only if the expected information is announced without hunting for it.

## 2. Global: skip links, landmarks and the scan field
Role: **Maya Torres, Accessioner**. Page: `/operations`, where the scan target is the default, "Find record".

| # | Do | Expect |
|---|---|---|
| 2.1 | Load the page. Press Tab once. | "Skip to scan field, link". Tab again: "Skip to main content, link". |
| 2.2 | List landmarks (NVDA: D or Insert+F7, landmarks. VoiceOver: rotor, Landmarks). | A banner (the top bar), a navigation for the jobs, a main region, and the "Notifications" region. No unlabeled duplicate regions. |
| 2.3 | Activate "Skip to scan field". | Focus is in an edit field named "Scan target: Find record", then its placeholder "Scan or type an ID". |
| 2.4 | From anywhere outside a text field, press `/`, then Ctrl+K (Cmd+K on macOS). | Each puts focus in the scan field and announces its name. |
| 2.5 | Type `XYZ` and press Enter. | Announced politely: "Not recognized: "XYZ". Check the label or type the full ID." Focus stays in the field. Arrowing out of the field reaches the same text in the result line under it. |
| 2.6 | Type `INT-1014-026` and press Enter. | "Opening provisional intake item INT-1014-026." Intake opens on that item, with focus in the scan field, now named "Scan target: Find intake item". |
| 2.7 | Press Esc twice with the field empty. | The first Esc hides the result line, if one shows. The second returns the target to "Find record", and the new name is announced when the field is next focused. |
| 2.8 | Press `?` outside a text field, or activate the "Keyboard shortcuts" button in the top bar. | The list of keys opens and its title is announced. Esc closes it and returns focus to where it was. |
| 2.9 | Move through the top bar with Tab. | Each job link is announced by name with its count (e.g. "Intake 12, 12 to review"). The current page is announced as current. The demo role note reads "Demo role: Maya Torres, Accessioner (demo role switch, not a sign-in)…". |

## 3. Intake: the decision and REL-0112
Role: **Kim Nguyen, Accessioning lead**. Page: `/intake?item=INT-1014-031`.

| # | Do | Expect |
|---|---|---|
| 3.1 | Load the page. | Focus is in the scan field. The level-2 heading names the provisional intake item INT-1014-031. |
| 3.2 | Navigate by heading (H) through the page. | Order: the item, the current finding, the next step, then the evidence. The REL-0112 workspace comes before the bottle evidence. |
| 3.3 | Find the "Path to accession" navigation. Tab through its buttons. | Each step reads like "Step 3, Related orders, yours now: REL-0112: your decision". Exactly one is announced as the current step. |
| 3.4 | Go to the "REL-0112 side by side" region. Read the table with table navigation (NVDA: Ctrl+Alt+arrows. VoiceOver: VO+arrows in table mode). | Column headers "Part A … INT-1014-031" and "Part B … INT-1014-032". The first row is "Separate source orders" (ORD-77120 / ORD-77121), followed by the shared reasons. Each cell is read with its column header. |
| 3.5 | Tab to the choices. | A radio group named "Decision on INT-1014-032", with four options, e.g. "Link as related: one accession, parts kept with their original orders". Arrow keys move the choice. |
| 3.6 | Choose "Link as related". | The effect line ("If recorded …") is announced politely, once, without moving focus. |
| 3.7 | Tab to "Record decision" and press Enter without a reason. | Nothing is recorded. Focus moves to the Reason field, which is announced as invalid with "A reason is required: say why. It is recorded with your name." |
| 3.8 | Press Ctrl+Enter in the empty Reason field. | "Give a reason; it is recorded with your name." is said. Nothing is recorded. |
| 3.9 | Type a reason and press Ctrl+Enter, or Enter on "Record decision". | A polite notification confirms the decision. Record where focus lands. Nothing about INT-1014-032 is said to be merged. |
| 3.10 | As Maya, open `/intake?item=INT-1014-027`. Tab to "Record: I checked this bottle against the order". | Its description says it records your name and time and that Ctrl+Enter never records it. Pressing Ctrl+Enter announces that rule instead of recording. |
| 3.11 | Keys 1 to 5 (focus outside a text field). | Each moves focus to its step's section. The section's name is announced. |

## 4. Live regions and notifications
Role: **Maya Torres**. Page: `/intake?item=INT-1014-025`.

| # | Do | Expect |
|---|---|---|
| 4.1 | Accept the routing ("Accept routing to Dr. Elena Marsh"). | "Routing accepted: Dr. Elena Marsh" is announced once, politely, without interrupting. Focus is not moved into the notification. |
| 4.2 | Record the container check. | "…your check is recorded" is announced once. |
| 4.3 | List the "Notifications" region. | Warnings stay until dismissed. Each has a "Dismiss notification: …" button. Success notifications disappear after about 6 seconds, and hovering or focusing one pauses that. |
| 4.4 | Presenter console, Outages and reset: take EMA-SIM offline. Return to Intake. | The source-freshness change is announced, or reachable in the top bar. Nothing is announced as accessioned. |
| 4.5 | Note any announcement heard twice, cut off, or announced on page load without a change. | None expected. Record every occurrence. |

## 5. Dialogs
| # | Do | Expect |
|---|---|---|
| 5.1 | Kim, `/intake?item=INT-1014-034`: press Ctrl+Enter. | The dialog "Resolve routing exception" opens. Its title is announced, and the rest of the page cannot be reached with Tab or the virtual cursor. |
| 5.2 | Press Esc. | The dialog closes. Focus returns to "Choose the dermatopathologist". |
| 5.3 | Tanya, `/worklist?view=operations`: press A (or activate Acknowledge). | An alert dialog "Acknowledge changes up to v…?" opens with focus on "Keep reviewing" (the safe option). Its text says other people and views are not affected. |
| 5.4 | In that dialog, cut the network (DevTools offline) and press "Acknowledge changes". | The failure is announced from inside the dialog, as an alert. Focus stays on "Acknowledge changes", whose description includes the error. Esc closes the dialog and focus returns to Acknowledge. |
| 5.5 | Priya, `/materials?tab=retrieval&selected=RR-0192`: "Not with the recorded holder…". | The dialog is titled "D26-03912 A1 is not with Marcus Lee?". Pressing "Open investigation" with no note announces "This needs a short note." with the field marked invalid. |
| 5.6 | A stale save. Two windows; follow guards check 12 in `tests/e2e/guards.spec.ts`. | "Someone else changed this item" opens with both values readable in its table. There is no "overwrite" option. |

## 6. The worklist table
Role: **Priya Shah, Histotech**. Page: `/worklist?view=histotech`.

| # | Do | Expect |
|---|---|---|
| 6.1 | Move to the table (T). | Its name starts "Worklist, Histotech view, grouped by assigned dermatopathologist. Sorted: …". Column headers are announced with their sort state. |
| 6.2 | Tab into the table. | One row is a Tab stop. Its name starts with the case number (e.g. "D26-04741, …") and includes PAS and hold facts in words. |
| 6.3 | J, K and the arrow keys. | Each moves to the next or previous row and announces it. |
| 6.4 | Space on a doctor band. | The band collapses or expands, and the expanded state is announced. |
| 6.5 | Enter on a row. | The side panel opens. Focus is on its heading, which names the case. Esc closes it and focus returns to the same row. |
| 6.6 | Activate a column sort button. | The new sort is announced in the column header (ascending/descending) and in the table name. |
| 6.7 | Activate "PAS only", then "On hold". | Each is a toggle announced as pressed or not pressed. "Showing N of M in this view" is announced politely. |
| 6.8 | Press P with the network cut. | An alert says the snapshot failed and that nothing was printed or downloaded. Focus stays on "Print snapshot", whose description includes the alert. |

## 7. Tray and retrieval scans
Role: **Priya Shah**.

| # | Do | Expect |
|---|---|---|
| 7.1 | Open `/materials?tab=trays&selected=TRY-M-03`. | Focus is in the scan field, named "Scan target: Add to tray TRY-M-03". The "Current tray" region reads "8 of 10 expected slides scanned". |
| 7.2 | On the bench, Tab to "Scan D26-04747 A1-1 H&E L1" and press Enter. | The match is announced politely. Focus returns to the scan field. The count becomes 9 of 10. |
| 7.3 | Tab to "Scan D26-04745 A1-1 H&E L1" (another case's slide) and press Enter. | Announced as an alert: the slide does not belong on this tray, and nothing is added. |
| 7.4 | Scan the smudged label. | An alert says the label could not be read, and nothing is added. |
| 7.5 | Type any slide label into the scan field with the network cut, then press Enter. | An alert says the local server could not be reached and that nothing was changed. Focus stays in the field. |
| 7.6 | Open `/materials?tab=retrieval&selected=RR-0192`. Scan "D26-03909 A1". | Announced as an alert: "Wrong block: not accepted … D26-03909 A1 is not on RR-0192. Nothing was changed." The count stays "0 of 3 picked". |
| 7.7 | Scan "D26-03990 B1". | The pick is announced politely, and the count becomes 1 of 3. The block's entry reads "Checked out to Priya Shah", and its last confirmed location is unchanged. |
| 7.8 | Navigate the "Requested blocks, in walking order" region by list items. | Each block reads "Pick N of 3", its label, its status, and "Last confirmed by … at …". Nothing implies live tracking. |

## 8. The presenter console
Role: **Maya Torres**. Page: `/demo`.

| # | Do | Expect |
|---|---|---|
| 8.1 | Find the "Presenter console sections" navigation. | Its seven links are listed. The current one is announced as current page. |
| 8.2 | Guide: "Run simulator events for this step". | The result region "Result of the last run of step 1" is announced or easy to reach. Its action list opens with its disclosure. |
| 8.3 | Role and clock: the "Acting as" combobox. | It is labeled. The chosen person is announced. After a change, the top bar's demo role note names the same person. |
| 8.4 | World events and Outages: Tab through the controls. | Every button names its effect (e.g. "Simulate outage", "Restore connection"). Printer fault buttons say which printer and that the choice is current. |
| 8.5 | Outages: Reset demo, then cancel. | The confirmation is an alert dialog with focus on the safe option ("Keep current data"). |

## 9. Known limits to look for
These are not proven defects. They are the places most likely to fail with a real screen reader:
- **Live-region timing.**
  - The scan field fills its live regions 30 ms after a result.
  - Toasts are added to a live list.
  - Some combinations may drop or repeat these announcements.
- **Hatched hold patterns and colour swatches.** They carry words as well (e.g. "Hold: Part B", "Dr. Elena Marsh (teal)"). Check that the words are read and not just the pattern.
- **Long accessible names on worklist rows and Operations tiles.** Judge whether they are too long to be useful.
- **The step rail's long button names** on Intake.

## 10. Results (fill in)
| Section | NVDA + Firefox | NVDA + Chrome | VoiceOver + Safari | Tester, date, versions |
|---|---|---|---|---|
| 2 Global and scan field | not run | not run | not run | |
| 3 Intake and REL-0112 | not run | not run | not run | |
| 4 Live regions and toasts | not run | not run | not run | |
| 5 Dialogs | not run | not run | not run | |
| 6 Worklist table | not run | not run | not run | |
| 7 Tray and retrieval scans | not run | not run | not run | |
| 8 Presenter console | not run | not run | not run | |
