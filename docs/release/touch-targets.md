# Pointer and touch targets on the desktop bench (Stage 6, A4)

*2026-10-19, branch `stage-6-production-foundation`. Synthetic data only. Measured in Chromium (Playwright 1.64) at 1366×768 and 1440×900 CSS px, device scale 1. The measurement is automated in `tests/e2e/target-size.spec.ts`; every number below is from a run of it. Nothing here was measured on the laboratory's own screens.*

## 1. Four different bars
These are four separate requirements. They are often confused.

| Bar | Size | Status | What it asks |
|---|---|---|---|
| **WCAG 2.2 SC 2.5.8 Target Size (Minimum)** | 24×24 CSS px | Level **AA**: the conformance target of this project (design spec §9) | Every pointer target is at least 24×24 CSS px, unless an exception applies. |
| **WCAG 2.2 SC 2.5.5 Target Size (Enhanced)** | 44×44 CSS px | Level **AAA**: not required, and not claimed | Every pointer target is at least 44×44 CSS px, with similar exceptions. |
| **Project design spec** | 44px on the bench tablet; 32px minimum (compact) at 1280px and wider | Project rule | See below. |
| **Site touchscreen expectation** | **Unknown** | Needs the lab's hardware | Not known. See below. |

**WCAG 2.5.8 exceptions.** A target under 24×24 CSS px still passes when one of these applies:
- **Spacing:** a 24px circle centred on it intersects no other target and no other undersized target's circle.
- **Inline:** the target is in a sentence, or its size is set by the line height of the text around it.
- **Equivalent:** the same function is available through another control that meets the size.
- **User agent:** the browser sets the size and the page does not change it.
- **Essential.**

**Project design spec.** Sources: DESIGN.md "Density"; design spec §5.2, §7 and §9; visual system.
- At 1280px and wider, the compact density applies: 36px rows, 32px minimum targets.
- Below 1280px, or on touch, the comfortable density applies: 48px rows, 44px targets. Below 1366px the top-bar job links become 44px icon targets.
- In Stage 6 this project adds a rule for the desktop bench: decision commits stay at 44px, and the scan, record and decision buttons listed in section 4 at 40px.

**Site touchscreen expectation.** Nothing in this project says whether the lab's bench workstations have touchscreens. If they do, the following are also unknown:
- their size, resolution and operating-system scaling;
- whether staff touch them with gloved hands;
- how far away the screens are mounted.

Each of these changes what size is safe. **This needs the laboratory's hardware and a session at a real bench before any number is promised.** Until then, 2.5.8 at 24px is what can be claimed, and only for the measured screens and states.

## 2. How it was measured
`tests/e2e/target-size.spec.ts`, in the page, on each screen.

**What counts as a target.**
- Included: every link, button, form control, `summary`, element with a widget role, or element in the tab order.
- Not counted: targets that are disabled, not rendered, visually hidden (an sr-only box), inert or aria-hidden.
- A checkbox or radio is measured together with the label that wraps or names it, because pressing the label operates it.

**How each target under 24×24 is classified.**
- **Inline:** laid out as text (`display: inline`) inside a block whose text goes beyond the target's own.
- **Spacing:** its 24px circle runs into no other target box and no other undersized target's circle.
- **User agent:** an unstyled, unlabeled native checkbox or radio.
- Otherwise it **fails 2.5.8**.

The equivalent and essential exceptions need human judgement and are never assumed.

**Screens.** All in the state after the 11:00 courier is unpacked (guide step 1):
- Intake: INT-1014-031 as the accessioning lead, INT-1014-025 as the accessioner, and the empty bench;
- Gross: D26-04797-C, a draft with fields to confirm;
- Worklist: the histotech and operations views;
- Materials: print with PJ-8841 open, trays with TRY-M-03, retrieval with RR-0192;
- Operations;
- Clarify, with CLR-0455;
- the four presenter console tabs.

**States after a press.** A scratch run of the same measurement also covered:
- a wrong-block scan;
- the retrieval "not found" dialog;
- a worklist side panel;
- every disclosure on a clarification opened;
- a long unrecognised scan;
- the print tab's unprinted-labels list opened.

It found **no failure** in these states either. These states are not in the committed spec.

## 3. WCAG 2.5.8 results
The numbers are the same before and after the Stage 6 changes, because no target needed to change for 2.5.8.

| Screen | Targets (1366 / 1440) | Under 24px | Exception that covers them | Fails 2.5.8 before | Fails after |
|---|---|---|---|---|---|
| Intake, INT-1014-031 (lead) | 53 / 54 | 5 | Spacing: "Show all 3 reasons" (20px tall), the linked INT-1014-032 (22px), three "Details" disclosures (18px) | 0 | 0 |
| Intake, INT-1014-025 | 45 | 3 | Spacing: "Show all 2 reasons", two "Details" | 0 | 0 |
| Intake, empty bench | 45 | 13 | Inline: 8 INT links in comma-separated lists on the courier manifest (17px line). Spacing: 5 single INT links. | 0 | 0 |
| Gross, D26-04797-C | 47 | 0 | | 0 | 0 |
| Worklist, histotech | 40 | 8 | Spacing: the column sort buttons (22px tall inside the 36px header row) | 0 | 0 |
| Worklist, operations | 43 | 9 | Spacing: the column sort buttons | 0 | 0 |
| Materials, print | 58 | 22 | Inline: PJ-8841 in the warning sentence. Spacing: 19 print-job links in the 36px table rows, "Open full record", the unprinted-labels disclosure | 0 | 0 |
| Materials, trays | 31 | 0 | | 0 | 0 |
| Materials, retrieval | 32 | 0 | | 0 | 0 |
| Operations | 98 | 1 | Inline: "2 clarification follow-ups are overdue." | 0 | 0 |
| Clarify, CLR-0455 | 49 | 0 | | 0 | 0 |
| Console: guide / role / world / outages | 37 / 31 / 31 / 45 | 0 | | 0 | 0 |

**Result: no genuine 2.5.8 failure was found on these screens at either size.** None needed fixing. The assertion test now fails the build if one appears.

Two controls sit exactly at 24px, the "Show how … was compared" toggles on Intake and the scan field's "Hide scan result". They pass, but they have no margin.

## 4. Primary bench actions under 44px, before and after
These are the scan, record and decision controls on Intake, Gross, Materials and Clarify. Heights are at 1366×768; widths grow by 8px where a button moved from small to medium. 1440×900 gives the same heights.

| Screen | Action | Before | After | Why |
|---|---|---|---|---|
| All | Scan field (top bar) | 40 | 40 | Already 40px by spec, inside the 52px bar. Unchanged. |
| Intake | Record decision (REL-0112), Request accession, Record: I checked this bottle | 44, 44, 56 | unchanged | Decision commits were already 44px or more. |
| Intake | Accept routing to … (and every other step listed under "Also yours now") | **34** | **40** | A decision taken next to the current step. |
| Intake | REL-0112 choices (radio rows) | 48 (first), **28** (others) | unchanged | Kept on purpose: see section 5. |
| Gross | Go to piece count, Mark operator reviewed, Approve for downstream use | 44 | 44 | Already 44px. |
| Gross | Confirm: <field>; Checked: keep as dictated… | **32** | 32 | Kept on purpose: see section 5. |
| Materials, print | Label printed / Not printed / Can't tell (escalate) / Printed but damaged | **32** | **40** | The outcome of a print with an unknown result. A wrong press records the wrong outcome. |
| Materials, trays | Scan and Found it (bench, simulated scanner) | **32** | **40** | The most-pressed controls on the bench. |
| Materials, trays | Record as not on tray… | **32** | **40** | Decision about a slide. |
| Materials, trays | Mark tray complete | 44 | 44 | |
| Materials, retrieval | Scan (bench, simulated scanner) | **32** | **40** | |
| Materials, retrieval | Record return, with its slot and "where it was found" fields | **32** | **40** | A location record. The fields grew with it. Shown only after a pick, so it was measured by a scratch run (40px at both sizes), not by the committed spec. |
| Materials, retrieval | Deliver to Microtomy bench 2 | 44 | 44 | |
| Materials, retrieval | Not with the recorded holder… / Not at last location… | 32 | 32 | Opens a dialog that asks for a note first; a mis-press records nothing. |
| Clarify | Docked step (e.g. Send reminder (simulated)) | 44 | 44 | |
| Clarify | Also possible: Send reminder, Record acknowledgment, Escalate, Record an answer given by phone, Record a delivery outcome | **32** | **40** | Record and decision buttons in the decision column. |
| Clarify | Record office answer, Record delivery outcome (forms) | 40 | 40 | |

**Side effect seen.** The retrieval decision column has four pick rows, and each is now 8px taller. At 1366×768, once a wrong scan has added the "Scans and custody for this request" list, the column's last row (D26-03909 A1) sits partly under the column's "More below" cover.
- The column was built for this. The cover moves when the row takes keyboard focus, which the accessibility spec's Tab walk checks. Deliver stays pinned below the list.
- It was not checked whether the cover also appeared before the change.

All are medium buttons. On a comfortable-density screen (below 1280px, or touch) they rise to 44px: `min-h-[max(2.5rem,var(--hlo-target-min))]`.

**Counts at 1366×768.** The spec checks 28 primary actions; 1440×900 gives the same counts.

| | Under 44 | Under 40 | Notes |
|---|---|---|---|
| Before | 18 | 17 | Of the 18 under 44px, only the scan field reached 40px. |
| After | 18 | 4 | Four are kept compact on purpose (section 5): the REL-0112 choices (28px), the two Gross per-field controls (32px) and "Not with the recorded holder…" (32px). |

The spec holds each control to its minimum, so a regression fails the build:
- the decision commits to 44px;
- the enlarged buttons to 40px.

## 5. Kept compact on purpose
- **The worklist.**
  - 36px rows and 32px toolbar controls.
  - The 22px column-sort buttons, which pass 2.5.8 through spacing.
  - The worklist is a dense reading surface for a 1366px screen. Comfortable density makes it 48px rows and 44px targets on a tablet.
- **REL-0112 choices (28px at 1280px and wider).** The evidence, the four choices, the reason and Record decision must all be in one view at 1366×768 (tests in `intake-keyboard.spec.ts`). Each row is 267px wide, and it is 44px below 1280px (`max-xl:min-h-11`). The commit, Record decision, is 44px.
- **Gross per-field Confirm (32px).** Each sits beside the 32px field it confirms, in a form of about 15 fields; a 40px button beside a 32px field would break the row. The docked commits (Mark operator reviewed, Approve) are 44px. Revisit if the grossing station turns out to be a touchscreen used with gloves (section 1).
- **Secondary and navigation controls** stay at 32px: print-label row buttons, "End tray session", "Cancel clarification", "Release H-…" and the presenter console.

## 6. Re-running
```bash
E2E_TAG=a2 E2E_PORT=3302 npx playwright test tests/e2e/target-size.spec.ts
```

The test output lists every target under 24px with the exception that covers it, and every listed primary action under 44px. The same data is attached to the report as JSON.
