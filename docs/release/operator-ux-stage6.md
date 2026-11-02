# Operator polish, measured (Stage 6, Phase F)

*2026-10-19, branch `stage-6-production-foundation`. Synthetic data only. Measured in Chromium (Playwright 1.64) on production builds, before and after the fixes, with the same scripts. Nothing here was measured on the laboratory's own screens or with a real scanner. This was a bounded polish pass: no redesign, nine fixes, one measurement round and one verification round.*

## 1. What was measured, and how

**Builds and data.**
- **Demo mode.** `next build` into its own folder, then `next start` with `HLOS_MODE=demo` and its own scratch database.
  - The synthetic day was reset to the 10:52 starting state.
  - Then the guided demo's step 1 world event ran (the 11:00 courier bag is unpacked), as `accessibility.spec.ts` does.
- **Secured mode.** The secured suite's own three servers (`playwright.secured.config.ts`), started through a scratch config and a scratch spec:
  - the local `oidc-provider`;
  - the secured app on the synthetic seed;
  - the app with an unreachable provider.

  Sign-in went through the provider's form with the synthetic test logins.
- **Baseline.** The unchanged code was exported with `git archive HEAD` into a scratch folder and built on its own. The new regression checks were run against it to show they catch each issue.

**Scripts.** Both are in the session scratchpad, not in the repository:
- `measure.mjs` (demo);
- `measure.scratch.ts` (secured).

**Screens (11 states, demo mode).**

| Screen | Acting as |
|---|---|
| Intake: `INT-1014-031` (REL-0112) | Kim, accessioning lead |
| Intake: `INT-1014-025`, an ordinary routine item | Maya, accessioner |
| Operations | Tanya, supervisor |
| Worklist, histotech view | Priya |
| Gross, bench queue | Dana |
| Clarify, with `CLR-0455` selected | Kim |
| Materials: trays (`TRY-M-03`), retrieval (`RR-0192`), retrieval after a wrong-block scan, print (`PJ-8841`) | Priya |
| `/integration` | Tanya |

**Viewports.**
- 1440×900, 1366×768 and 1024×768;
- 200% zoom: 720×450 CSS px at device scale 2;
- browser text size 20px at 1366×768. This is set with CDP `Page.setFontSizes`, standard and fixed 20. The root font size was confirmed at 20px.

That gives 55 screen and viewport runs.

**Recorded per run.**

| What | How |
|---|---|
| Page horizontal overflow | `scrollWidth − clientWidth` of the document, plus any element sticking out past the right edge |
| Controls clipped | Every visible link, button, field, `summary` or widget is scrolled into view (`block: nearest`). The run records how much of its box survives every overflow ancestor and the viewport. It is reported when under 95%. |
| Controls obscured | `elementFromPoint` at the control's centre, after it is scrolled into view, is not the control |
| Focus order | The first 15 Tab stops from where focus is on load. Each stop records its region, its name, whether `elementFromPoint` at its centre is the stop itself, and whether it is off screen. |
| Scanner focus | Whether `#scan-field` has focus once the page is interactive |
| Truncation | Any element with `text-overflow: ellipsis` whose text is cut; identifiers are flagged |
| Errors | Console errors and uncaught page errors |
| axe | `@axe-core/playwright` with tags `wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa`, `wcag22aa`. No rule is disabled. |
| Screenshot | One per screen and viewport |

The obscured and clipped checks scroll by script, which is not what a person does. A control they flag was counted as a finding only when the keyboard check (real Tab presses) or a screenshot confirmed it.

**Secured mode.**

| Screen or check | Signed in as | Sizes |
|---|---|---|
| The top bar with the session controls | Kim | 1440, 1366, 1024, 200% zoom, 20px text |
| The lock screen | Kim | 1366, 1024, 200% zoom |
| Where `/` lands, `/forbidden` and its actions, and the top bar on `/audit` | `lab_admin`, auditor | 1366, 1024 |
| `/signin` | none | 1366, 200% zoom |
| `/no-access` | an unlinked login | 1366, 200% zoom |

On each of these the script recorded:
- for every bar control: in or out of the bar, covered or not, and any truncated text;
- axe;
- a screenshot.

**Looked at.** I viewed every screenshot cited below, and others at each viewport. Two candidates were then followed with targeted probes:
- the retrieval cover after a wrong scan, sampled at several times and scroll positions;
- the tray row at 200% zoom.

## 2. Results at a glance (demo mode, 55 runs)

| Measure | Before | After |
|---|---|---|
| axe violations | **6**: 5 × `aria-valid-attr-value` (critical) on Gross, at every size; 1 × `scrollable-region-focusable` (serious) on Intake at 20px text | **1**: the Intake one, not fixed (see N3) |
| Tab stops covered or off screen, in the first 15 | **12** | **0** |
| Controls less than 95% visible | **10**, all at 20px text: the retrieval **Scan** buttons and the tray's **Record as not on tray…** decisions were 40% visible | **0** |
| Scan targets with a truncated identifier, at 1024 | **3**: "Check block for RR-01…" on two retrieval runs, "Add to tray TRY-…" on trays | **0** |
| Pages with horizontal overflow | 0 | 0 |
| Console or page errors | 0 | 0 |
| Bench screens without the scan field focused on load (Intake, Gross, trays, retrieval) | 0 | 0 |
| Obscured by the scripted check | 31 | 22. None is reached by Tab (see §4). |

**Secured mode.**

| Measure | Before | After |
|---|---|---|
| Top bar at 200% zoom: controls outside the 102px bar | **11**. The bar wrapped to 3 rows: the job links were cut at the top, and the scan field hung over the page. | **0**: two rows |
| `lab_admin` and auditor: where `/` lands | `/forbidden` | `/audit` |
| `lab_admin` and auditor: where "Go to your start page" on `/forbidden` leads | `/forbidden` (a loop) | `/audit` |
| Actions on `/forbidden` | 1 (Go to your start page) | 3 (Go to your start page, Lock, Sign out) |
| Actions on `/no-access` | 1 (Sign in as someone else) | 2 (Sign in as someone else, Sign out) |
| Bench job links in the top bar for `lab_admin` and auditor (each one leads to the 403 page) | 7 | 0 |
| Visible width of the administrator's name at 1024 | 37px ("Ale…") | the first name, whole ("Alex") |
| axe on the lock screen, `/signin`, `/no-access` and `/forbidden` | 0 | 0 |

## 3. Findings

Fixed: F1 to F9. Not fixed: N1 to N9, each with its reason. Every fix is the smallest change I found inside the design system, and no colour, type or spacing token changed.

| # | Finding (measured) | Status | Fix, or reason it was not fixed | Regression check |
|---|---|---|---|---|
| F1 | **Secured: `lab_admin` and auditor land on the 403 page from `/`**, and its only button ("Go to your start page") leads back to it. This was candidate 3.2 in the brief. | Fixed | `landingPathFor` sends both roles to `/audit`, their permitted screen (`src/components/shell/landing.ts`). | `tests/e2e-secured/auth.spec.ts`: `/` and "Go to your start page" land on `/audit` |
| F2 | **Secured: no Sign out or Lock on `/forbidden` or `/no-access`.** These plain pages have no app chrome, so a shared workstation could be left signed in (candidate 3.2). | Fixed | A small client part, `src/app/_auth/session-actions.tsx`, offers the same actions as the top bar.<br>• **`/forbidden`** (secured only): Lock and Sign out. Lock locks the server session, then shows the locked sign-in page.<br>• **`/no-access`**: Sign out. It also ends the provider's session, so the next person is not signed in as this account. | Secured spec: both buttons are present; Lock sets `locked_at`; Sign out revokes the session (`signed_out`) |
| F3 | **Secured top bar at 200% zoom: three rows in a 102px bar.** With the Synthetic label, the name block, Lock and Sign out, the right-hand group no longer fitted beside the job links. The job icons were cut at the top edge, and the scan field hung 20px over the page. At 1024 the role was cut ("Accessioning le…") (candidate 3.3). | Fixed | Below 1280px the session block folds the way the demo role indicator does:<br>• the first name;<br>• the role, capped at 5.5rem. The full sentence stays in the accessible name and tooltip.<br>Below 1024px the gap is 4px.<br>(`src/components/shell/session-controls.tsx`) | Secured spec, at 720×450, device scale 2: every bar control is inside the 102px bar, and the scan target is whole |
| F4 | **The scan target cut its identifier at 1024** ("Check block for RR-01…", "Add to tray TRY-…"; in a signed-in bar, "Find intak…"). The target says what a scan will do and which record it is for. | Fixed | The target may take a second line (`line-clamp-2`, `leading-tight`) inside the same 40px field. Hyphenated identifiers never split, and the full label is in its tooltip. Nothing changes at 1366 and 1440, where it fits on one line (`src/components/shell/scan-field.tsx`). | `polish.spec.ts`: at 1024 on retrieval and trays, the label is not cut, and the identifier is on one line inside it |
| F5 | **At 20px text, the Materials decision column hid the rows to act on.** The pinned column was fitted to what was left below its top at load, so its scrolling middle shrank to 20px:<br>• the retrieval pick list (every **Scan**) sat under "3 to pick and 1 not on this request below";<br>• the tray's "Not on the tray yet" items and their **Record as not on tray…** sat under "2 more items below".<br>Buttons were 40% visible, and Tab stopped on covered controls. | Fixed | In `useFitColumn` (`src/components/materials/shared.tsx`):<br>• the middle never shrinks below 7.5rem (about one row and its heading); the column may then reach below the fold until the page is scrolled and the column is pinned;<br>• when even the pinned column could not hold that, the column is not pinned at all and scrolls with the page, whole.<br>The decision is made the same way whether the "more below" cue shows or not, so it cannot flip back and forth.<br>The two record bands now carry `data-identity-sticky`, so the existing scroll padding keeps focused controls clear of them (`tray-tab.tsx`, `retrieval-tab.tsx`, `tray-decision.tsx`). | `polish.spec.ts`, at 20px text: the retrieval Scan buttons and both tray decisions are in view and uncovered when focused |
| F6 | **The scan result line covered the page's tabs while keyboard focus moved onto them.** After a wrong retrieval scan, "Retrieve blocks" was covered at 1440, 1366, 1024 and 20px text. At 200% zoom, all three Materials tabs were entirely covered: a WCAG 2.4.11 failure that axe does not test. | Fixed | When focus moves to a page control the line covers, the line closes, as Esc or its × would. The result was already announced, and the bench still shows it ("1 wrong scan rejected", "Wrong block: not accepted"). Focus in the scan field or on the line's own buttons leaves the line open (`scan-field.tsx`). | `polish.spec.ts`: at 200% zoom after a wrong scan, Tab onto each Materials tab finds it uncovered, and the line is closed |
| F7 | **Gross queue: axe critical `aria-valid-attr-value`** at every size. The filter tabs' `aria-controls` pointed at a panel that did not exist, and Gross is not in `accessibility.spec.ts`. | Fixed | The queue table sits in the shared `TabPanel` that the Tabs part documents (`src/components/grossing/queue.tsx`). The rest of the diff is re-indentation; `git diff -w` shows 4 lines. | `polish.spec.ts`: the selected tab controls a real tab panel, and axe is clean |
| F8 | **Secured: `lab_admin` and auditor saw 7 bench job links in their top bar**, each leading to the 403 page. At 1024 they squeezed the person's name to "Ale…". | Fixed | `JobNav` offers only the screens the role may open (`roleCan(role, view.*)`). Every bench role keeps all seven; these two roles get none (`src/components/shell/job-nav.tsx`). | Secured spec: no Main navigation on `/audit` for these roles |
| F9 | **Trays at 200% zoom: a tray chip reached with Tab stayed mostly hidden.** The sideways row did not scroll a partly visible chip into view; `TRY-F-01` was 4% visible. | Fixed | The row scrolls the focused chip fully into view (`tray-tab.tsx`, `onFocus`). | `polish.spec.ts`: each tray is fully inside the row when focused |
| N1 | **Candidate 3.1: after a wrong retrieval scan at 1366×768, the last pick row partly under the "More below" cover.** | Confirmed only as a transient; not fixed | Sampled 50 ms after the scan, the cover was stale for one measurement (`D26-03912 A1` at 603–647, cover from 628). By 150 ms it was correct, and it stayed correct at every later time and at scroll positions from 0 to the page end (0 partly covered rows), on both the button path and the typed scan path. A change to the measurement trigger is not worth the risk for a flash of under 150 ms. | none |
| N2 | **Print tab at 200% zoom:** the job panel is a non-modal sheet below 1280px (shared `SidePanel`, by design). The page controls behind it ("Assemble trays", "Today (239)") stay in the Tab order while covered. | Not fixed | Needs a design decision: a modal sheet, or an inert page behind it. That changes a shared part across the Worklist, Clarify and Materials, beyond a bounded polish pass. | none |
| N3 | **Intake at 20px text:** axe `scrollable-region-focusable` (serious) on the decision column's cut scroller. | Not fixed | The hidden text is reachable from the keyboard through the "More below" cue, which scrolls the region. Making the scroller a Tab stop would change the Intake Tab order that `intake-keyboard.spec.ts` pins, for little gain. | none |
| N4 | **Secured top bar at 20px text:** the 44px icon targets grow to 55px (2.75rem) in the 52px bar and overhang it by about 1.5px at the top and bottom. | Not fixed | Cosmetic. The fix belongs to `--hlo-topbar-h` in `src/app/globals.css`, which is outside this phase's ownership. | none |
| N5 | **`/integration`: simulated and time labels against the rest of the app** (candidate 3.4). | Checked; no change | **Time labels** match the app's `Timestamp`: "9:20 AM ET", the full date and UTC in the tooltip, and `<time datetime>`. "Source says sent" and "Received here" are always labelled apart.<br>**Simulated labels.** Every simulated element is labelled. The page header says "Simulated: source systems". The Sources section says "Simulated: source adapters", the same as the top bar and Operations. The wording varies, but nothing is unlabelled or misleading. | none |
| N6 | **Office names in the Intake queue and manifest cells are cut with an ellipsis.** At 1366 that is 3–4 per screen; at 20px text, 10–11. | Not fixed | They are not identifiers; no identifier is cut anywhere. The full name is on the item and in its manifest card. | none |
| N7 | **Keyboard: on the bench screens, four top-bar stops come before the page:**<br>• source freshness;<br>• keys;<br>• Synthetic;<br>• Presenter console.<br>There are six after a scan result. | Not changed | By design: `/` or Ctrl/Cmd+K returns to the scan field, and the skip links lead the document. | none |
| N8 | **Worklist, Clarify, Operations, Integration and Materials print do not focus the scan field on load.** | Not changed | These are not scanning screens. The scan field is one key away (`/`). | none |
| N9 | **Scripted-check artifacts:**<br>• "More below" in a pinned column, "covered" by the top bar after a scripted scroll of a sticky element. Real Tab presses over the whole tray column found nothing covered.<br>• A wrapped link on Operations at 200%, whose centre falls between its two lines. | Not issues | Not reproduced with the keyboard or in the screenshots. | none |

## 4. Against the brief's criteria

| Criterion | What the measurement shows |
|---|---|
| Clear next action | The decision column names the next action on every bench screen at every size. At 20px text it used to hide the rows to act on; it no longer does (F5). |
| Fast specimen identification | Identifiers are never truncated after F4. The scan target now always shows which record a scan is for. |
| Consistent status | The severity ladder is unchanged. The signed-in block now folds like the demo role indicator (F3). `/integration` times match the app (N5). |
| Keyboard efficiency | Focus order is predictable: skip links, then the bar, then the page, and on bench screens from the scan field. 0 covered Tab stops after F6 and F9 (12 before). See N7. |
| Safe error recovery | A wrong scan changes nothing and stays on the bench ("Wrong block: not accepted", "N wrong scans rejected") when the transient line closes (F6). The failed-mutation checks in `accessibility.spec.ts` still pass. |
| Scanner focus | The scan field has focus on load on every scanning screen at every size (0 misses, before and after). |
| Evidence visible | At 20px text, nothing on the Materials column is now clipped: 0 controls under 95% visible, from 10. Patient and specimen evidence was never hidden to make a layout fit. The column scrolls with the page instead (F5). |
| Physical custody distinct from digital records | Unchanged. Retrieval still says "Last confirmed location, not live tracking" and "Custody now". The tray says that each slide needs its own scan. |
| Human decisions traceable | Unchanged. The signed-in person's name now stays readable at 1024 for every role (F3, F8). |
| Dense worklists legible | Worklist: no clipping, overflow or axe findings at any size, including 20px text and 200% zoom. |
| Notifications placed well | The scan result line no longer sits over a focused control (F6). Toasts were not implicated. |
| Usable at larger text | 20px text: the Materials decision column was fixed (F5); N3 and N4 remain, both minor. 200% zoom: the secured bar (F3), the tray row (F9) and the scan line (F6) were fixed; N2 remains. |

## 5. Before and after screenshots (`docs/release/evidence/stage6/`)

| Issue | Before | After |
|---|---|---|
| F3, the secured top bar at 200% zoom (top of the view) | `secured-bar-zoom200-before.png` | `secured-bar-zoom200-after.png` |
| F5, the retrieval decision column at 20px text (right half of 1366×768) | `retrieval-text20-before.png` | `retrieval-text20-after.png` |
| F4, the scan target at 1024 (retrieval, the top of the view) | `scan-target-1024-before.png` | `scan-target-1024-after.png` |
| F1 and F2, `/forbidden` for the laboratory administrator (1366) | `forbidden-admin-before.png` | `forbidden-admin-after.png` |

## 6. Behaviour changes to know about

- **Materials, short windows at the default text size (F5).** Probed at 1366 wide, before and after.
  - At 680 and 768px tall, the column is identical.
  - At 580–640px tall, the middle used to shrink to 48–126px. It now keeps 128px. At the top of the page the column reaches up to about 80px below the fold, until the page is scrolled and the column is pinned.
  - At 560px and below the page was already one stacked column; that is unchanged.
- **Signed-in bar below 1280px (F3).** It shows the first name, and the role capped at 5.5rem ("Accessioning …"). The full name and role stay in the tooltip and the accessible name.
- **Scan result line (F6).** It closes when keyboard focus moves onto a control it covers. Otherwise, warnings still stay until Esc or ×.
- **Gross queue (F7).** It gains one Tab stop: the tab panel, which the shared pattern makes focusable.
- **Materials trays and retrieval (F5).** Focused controls now keep clear of the sticky record band. The page's scroll padding grows by the identity band height (68px), as on screens with the case identity bar.

## 7. Verification (one round, after the fixes)

| Check | Result |
|---|---|
| `npx tsc --noEmit` | Clean |
| `npx vitest run` | **638 passed**, 0 failed (33 files) |
| Demo browser suite: `E2E_TAG=f2 E2E_PORT=3392 npx playwright test` | **136 passed**, 0 failed (3.3 min). This includes the 5 new checks in `tests/e2e/polish.spec.ts`. |
| Secured suite: `E2E_SECURED_TAG=f2s E2E_SECURED_PORT=3393 npm run test:e2e:secured` | **26 passed**, 0 failed (43.7 s). This includes 2 new tests and the extended administrator and auditor test. |
| The 5 new demo checks against the unchanged code (baseline build) | **5 of 5 fail**, one per issue, as expected |

## 8. Outside this phase

- **`tests/e2e-secured/auth.spec.ts` was edited.**
  - F1 deliberately changes what it asserted (`/` gave `/forbidden` for these two roles), so the bench-page loop now skips `/`.
  - The new assertions were added to the same test.
  - There are two new tests: the 403 page's Lock and Sign out, and the 200% zoom top bar.
- **For later, needing a decision or files outside this phase's ownership:**
  - N2: modal or inert behaviour for the overlay side panel;
  - N4: the top-bar height in `globals.css` at larger text;
  - N3: making the Intake cut scroller focusable.
