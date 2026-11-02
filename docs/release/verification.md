# Verification evidence (release candidate, Stage 5)

*2026-10-19, branch `stage-5-release-candidate`. All runs used synthetic data on this machine. A passing test is evidence that the code does what the test says. It is not clinical validation and not a compliance claim.*

## 1. Gates
| Gate | Result | How |
|---|---|---|
| Type check | Clean | `npx tsc --noEmit` |
| Unit and integration tests | **367 passed, 0 failed** (14 files) | `npx vitest run` (HLOS_MODE=demo, in-memory synthetic seed) |
| Browser tests | **77 passed, 0 failed** (6 spec files, 1.8 min) | `npx playwright test`: a fresh production build on its own port and database |
| Clean production build | Exit 0. `tsconfig.json` is not rewritten (verified with `git diff`). | `rm -rf .next && npm run build` |
| Colour contrast | 0 failing colour pairs at 1366px, across 14 routes | `node scripts/contrast-check.mjs http://localhost:3300 1366` on the production build |
| Viewports | 10 routes at each of 1440×900, 1366×768, 1024×768 and 720×450 at 2× (200% zoom): **0 console errors, 0 page overflow, 0 top-bar overflow** | Scratch script on the production build; results in `evidence/viewport-checks.json`, captures in `evidence/` |
| Larger browser text | Top bar at 16, 20 and 24px default text, 1024–1920px wide, source online and offline: 126 checks, 0 overflow | Chromium `Page.setFontSizes` (a real text-size preference, not a CSS override) |
| Locked build | User command 401. Role switch 403. Demo reset, `/demo` and every console tab, and `/concepts` 404. Bench pages render read only with the "Locked" note and no console link. | `next start` without `HLOS_MODE` (curl) |

**Build warnings.** The build logs two warnings: Turbopack cannot find fallback-metric overrides for the self-hosted Atkinson Hyperlegible fonts. They are benign (no metric-adjusted fallback face is generated; the declared fallback stacks are used). See `src/app/fonts.ts`.

### Reading `viewport-checks.json`
Its `obscured` field lists every control whose centre point is covered by another element at load. Each entry was inspected by hand.

| Flag | What it is |
|---|---|
| Intake "More below in your next step" | The scroll cue is `invisible` with `tabIndex -1` when nothing is below. It sits behind Record decision. Not a defect. |
| Trays "Open tray" and doctor select | Contents of the closed "Open a new tray" disclosure: not shown and not focusable. Not a defect. |
| Trays "Record as not on tray…" at 1024 | The unit cut at the column foot, under the opaque cover with "1 more item below". **Fixed in Stage 5:** keyboard focus now scrolls the whole unit into view. Before the fix, after Tab only the button's corner was uncovered; after it, all three sampled points are visible (`src/components/materials/shared.tsx` `useCutBelow`). |
| Retrieval "Scan D26-03909 A1" at 1024 | Fully visible in the capture. The e2e suite clicks it. The flag comes from the button's own nested label. |

## 2. Unit and integration tests by file
| File | Tests | What it covers |
|---|---|---|
| `security.test.ts` | 20 | Scoped idempotency (owner, scope, command, payload, expiry, legacy receipt, two-connection race), the mode gate, the system actor, correlation, presenter origin, and the live pump only in demo mode |
| `integrity.test.ts` | 31 | Mutation audit A-1 … A-12: identity coverage, source conflicts, routing override, staff-entered slide requests, print release re-check, required versions, one-stage advances, before/after audits |
| `consistency.test.ts` | 23 | One derivation per fact across Operations, the worklist, Case, Grossing, Clarify and Insights. Includes the amendment hold and unowned source entry (C1-4). |
| `presenter.test.ts` | 8 | Console target lists match what each command accepts; lists change nothing; 404 in locked, production and pilot modes |
| `intake.test.ts` | 51 | Intake, routing, related orders, source-conflict review |
| `clarifications.test.ts` | 40 | The clarification lifecycle, simulated delivery and answers |
| `demo.test.ts` | 39 | Guided steps, simulator origins, insights honesty |
| `integration.test.ts` | 46 | Simulated source outages, queued delivery exactly once, out-of-order versions |
| `materials.test.ts` | 38 | Print, labels, trays (including the neutral waiting state), retrieval and custody |
| `grossing.test.ts` | 25 | Gross records, confirmations, approval, source entry |
| `worklist.test.ts` | 20 | Worklist read model, acknowledgements, snapshots |
| `case.test.ts` | 10 | Case page read model |
| `operations.test.ts` | 10 | Operations read model and owner queue |
| `foundation.test.ts` | 6 | Schema, append-only audit triggers |

## 3. Browser tests by spec
| Spec | Tests | What it covers |
|---|---|---|
| `journeys.spec.ts` (Phase D, new) | 38 | Six bench journeys. Each has the normal path, missing information, a failed mutation, a repeated request (same key replayed; another payload or another role refused with 409, and the stored result never disclosed), stale state, and an unavailable dependency. |
| `intake-keyboard.spec.ts` (new) | 19 | Scanner-first keys, Ctrl+Enter never recording a container check, focus after actions, 1024 drawer, 200% zoom, visible focus, REL-0112 at 1366/1440, resilience at 125% text, 1024 and 200% |
| `director-journey.spec.ts` | 8 | The eight guided steps through the real screens |
| `guards.spec.ts` | 8 | Server-side roles, stale saves, outages, the assistant unavailable, dictation as data, print snapshot |
| `presenter-console.spec.ts` (new) | 3 | The console and its tabs; no presenter control on any bench screen; world events reach the bench |
| `demo-step3-presenter.spec.ts` | 1 | The presenter path for step 3 |

### Journeys (Phase D)
| Journey | Records | Normal path |
|---|---|---|
| 1. Normal intake | INT-1014-026/028, Mangrove Bay and Seagrape offices | Check the container, accept rule-based routing, issue the accession. "Unknown" (never 0) for a missing manifest. With EMA-SIM offline the request waits and is never shown as issued. |
| 2. Identity conflict | INT-1014-022/024, CLR-0453, H-0088 | Only an identity clarification resolved as "order is correct" covers a mismatch. `acceptDiscrepancy` is refused. Nothing is merged. Notifications down shows "Delivery failed". |
| 3. Related orders REL-0112 | INT-1014-031/032 | The decision needs a reason. ORD-77120 and ORD-77121 both remain. A replay creates one decision. An old version gets 409. |
| 4. Grossing and handoff | D26-04801, D26-04797, TRY-M-03 | Approval is blocked by unconfirmed values. A replayed approval creates blocks once. With the source offline there is no acknowledgment. "Sent" never claims a pathologist receipt. |
| 5. Material location | RR-0192, PJ-8841 | A wrong block is rejected. Delivery keeps the last confirmed location. A return needs a slot; a missing item needs "Where it was found". A printer offline keeps jobs queued and prints nothing. |
| 6. Worklist and exceptions | D26-04804 (hold on part B, gross approval), D26-04772 | PAS only; on hold with scope and owner; acknowledge per user and view; live refresh; stale banner and print snapshot when the source is offline |

**Gaps, stated in the spec:**
- Two setups are driven by commands from inside the page, not by clicks: the "Other" clarification in journey 2, and the request sent while the accession button is disabled in journey 1.
- Hatching is asserted through scope and owner text, not pixels.

## 4. Defects found by the Stage 5 tests and reviews, and fixed
| Found by | Defect | Fix | Proof |
|---|---|---|---|
| Journeys (1) | A failed "Accept routing" from "Also yours now" showed no error: the list folded away and unmounted the error. | A failure opens the list (`decision-column.tsx`, `keepAlsoOpen`). | Journey 1, failed mutation (second entry point) |
| Journeys (2) | The current-tray status pill said "Delivered". | "Sent (receipt not recorded)" (`status-pill.tsx`, `TRAY_STATUS`). | Journey 4, handoff |
| Journeys (3) | The worklist stage said "A delivered" for a part sent on a tray. | "A sent on tray" on screen, print and CSV (`worklist/format.ts`). | Journey 4, handoff |
| Journeys (4) | A queued job's panel said the printer was unavailable after it was restored. | The notice follows the printer's current status (`print-job-panel.tsx`). | Journey 5, unavailable dependency |
| Journeys | Toast "1 queued job(s) released" | Correct singular and plural (`print.ts`) | — |
| C1 review | An amber "Cannot complete" for ordinary assembly progress | Neutral hourglass when only expected slides are unscanned (`onlyAwaitingScans`) | `materials.test.ts` |
| C1 review | "TRY was delivered to Dr. X" implied receipt | "was sent to Dr. X. Receipt is not recorded." | Journey 4 |
| C1 review | The worklist Readiness cell was clamped to 3 lines, cutting the action and location | Never clamped | Visual check; journeys 6 |
| C1 review | Grossing worklist owner blank for unowned source entry | "Unassigned (histology assistant)", the same words as Operations (`SOURCE_ENTRY_UNASSIGNED`) | `consistency.test.ts` C1-4 |
| C1 review | Print snapshot 11px body; whole doctor sections forced onto one page | 12px body; sections may span pages, and headings never end a page alone | Not printed on paper (see production-readiness §2) |
| C1 review | "With a send-out (0)" beside "Outside send-outs (1)" | "Requests with a send-out" | — |
| Lead measurement | Top bar overflowed at 1536px with 20 or 24px browser text (4–271px) | All breakpoints in rem (21 files) | 126 checks, 0 overflow |
| Lead measurement | Insights overflowed 2px at 1024 | Shorter provenance tag | `viewport-checks.json` |
| Lead measurement | A keyboard-focused tray action could sit under the cut cover at 1024 | The focused unit is scrolled into view | Focus test above |
| Lead review | `security-privacy.md` claimed presenter commands were refused for read-only roles | Corrected: they are recorded as origin `demo` and refused in locked builds | `security.test.ts` |

## 5. Independent reviews in Stage 5
Reviews were run as separate agents with no write access to the code under review where possible. They are development reviews, not independent security or clinical assessments.

**A2: mutation audit.** The integrity agent's review; its results are in [mutation-audit.md](mutation-audit.md).

**B: consistency review.** It produced findings B-1 … B-15, fixed with regression tests in `consistency.test.ts`.

**C1: Worklist and Materials re-review.** The disposition was "fix", with four P2 and four P3 findings, all addressed above.
- Confirmed sound:
  - the severity ladder (no red; yellow only with the PAS word);
  - honesty labels;
  - custody wording;
  - scanner-first rebinding;
  - disabled actions saying why;
  - print header and footer.
- Open: at 1366 and 1440 the main controls are 32px (44px at 1024 and under the comfortable density). The design spec requires 44px only on the bench tablet. This is recorded, not changed.

**C3/C7: Intake hardening.** REL-0112 has 0 clipped controls at 1366×768, 125% text, 1024 and 200% zoom, and 140 scratch keyboard checks were moved into the suite as 19 browser tests. The dropped checks are listed in the spec's comments.

**C5: presenter console.** No presenter control remains on any bench screen; the console is a 404 in locked builds.

## 6. Known limits of this evidence
- **Browser and data:** Chromium only, desktop and tablet viewports, synthetic data, one local SQLite database.
- **Accessibility:** no screen-reader session or user test.
- **Print:** checked in print media only, not on paper.
- **Timing:** the source-conflict UI and receipt expiry are covered by domain tests, not browser tests.
