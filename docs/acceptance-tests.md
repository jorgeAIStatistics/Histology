# Acceptance Tests: The 15 Checks and the Automated Tests Behind Them

**Project:** Histology Lab OS ("Histology Redesigned"), a local, synthetic demonstration
**Owner:** Jorge Rodriguez (histology assistant). Drafted with AI assistance by reading the code (`src/`), the seed (`src/server/seed/`), the tests (`tests/domain/`) and `docs/dev/command-contract.md`.
**Source of truth:** `Histology_Lab_OS_Claude_Master_Prompt.txt`, §13 "Acceptance checks that matter"
**Last test run recorded here:** 2026-10-14 (see §2)
**Status:** Internal working document. Every name, patient, office, case number and record in the app and in these tests is fictional. Nothing here implies that any director, the employer or any vendor has reviewed, endorsed, approved, bought or partnered with this project.

---

## 1. Summary in plain English

The master spec lists 15 behaviors that matter most. For each one, this document answers:

1. **What the check means**, in plain words.
2. **How the app enforces it**: which part of the code or the database stops the wrong thing from happening (with file paths, so an engineer can verify).
3. **Which automated tests prove it**: the exact test file and test name, and what kind of test it is.
4. **What is still missing** (the gaps).

**Bottom line (as of 2026-10-14):**

- All 15 checks have automated tests, and all 247 tests passed on 2026-10-14.
- Every check is tested at the **domain level**: the tests run the app's real actions against a fresh, private copy of the synthetic demo day. Several checks are also protected by **database rules** that refuse bad changes even if some other code path tried them.
- **The critical journey is also tested in a real browser.** 17 Playwright tests (`tests/e2e/`) click through the real screens of a production build: the full 8-step director journey, the guided demo's step 3 as scripted, and guards for checks 6, 12, 13 and 15 plus the printed snapshot. All 17 passed on 2026-10-14 (see §5). The same story is also tested end to end at the domain level.
- Everything outside the computer is **simulated**: the source system (EMA-SIM), the accession-number issuer, printers, the office's replies and the notification channel. There is no scanner hardware; "scanning" means typing or pasting a label's text. The tests prove the app follows its own rules on synthetic data. They do not prove clinical performance, real integration or hardware behavior (see §7).

| # | Check (short) | Automated coverage | Main gap |
|---|---|---|---|
| 1 | Unknown office → routing exception, no guessed doctor | Covered (domain, read model, DB rule) | Some rarer exception reasons have no test of their own |
| 2 | A/B related orders keep both source IDs and need review | Covered (domain, full demo journey) | "Keep separate" outcome and "encounter unknown" branch not tested |
| 3 | Same patient, different encounters stay separate; same MRN in two practices doesn't collide | Covered (domain) | "Encounter unknown" case not tested |
| 4 | Patient/site mismatch keeps both values and blocks the affected step until authorized resolution | Covered (domain, DB rule, full demo journey) | Not every held step is tested for the hero Part B hold |
| 5 | After accessioning: no silent renumbering, merging or invalidating printed identities | Covered (domain, DB rule) | "Case moved to another patient" database rule has no test; no test re-checks printed labels after a correction |
| 6 | Uncertain decimal/unit or missing piece count cannot be finalized without review | Covered (domain, pure function, server render) | Tested only on a few synthetic dictations |
| 7 | Completing one part updates eligible work; unfinished parts stay incomplete | Covered (domain, read model, full demo journey) | Live screen refresh not tested in a browser |
| 8 | Printer timeout stays "unknown" until reconciled; no uncontrolled duplicate jobs | Covered (domain, DB rule, full demo journey) | Simulated printers only |
| 9 | Tray with 9 expected + 1 unexpected slide cannot be "verified complete" | Covered (domain, read model, full demo journey) | Simulated scans only |
| 10 | Wrong block scan = mismatch; old location shown as "last confirmed" | Covered (domain, read model, full demo journey) | No real storage tracking exists |
| 11 | Re-import is idempotent; older update never overwrites newer | Covered (domain, read model) | Simulated message format only (not HL7/FHIR) |
| 12 | Concurrent edits detect conflict; server-side role checks; role selector is not sign-in | Covered (domain) | Tests call actions directly, not through the web route; there is no sign-in at all |
| 13 | Source outage marks data stale; restored events reconcile once; no implied source writes | Covered (domain, read model) | Stale banner not tested in a browser |
| 14 | Canceled/amended stain stays traceable and triggers review of printed/prepared work | Covered (domain, read model) | "Amended" stain is handled as remove + add; no separate path |
| 15 | Assistant failure leaves manual work usable; untrusted text cannot issue instructions or change roles | Covered (domain, read model) | The "assistant" is rule-based demo code, not a live AI model |

---

## 2. Test run on record

Command (it does not change any source file or the demo database):

```
cd "/Users/jorgerodriguez/Desktop/Histology Project" && npx vitest run --reporter=verbose
```

Result on **2026-10-14** (Vitest 4.1.11, run started 02:01 local time):

```
 Test Files  8 passed (8)
      Tests  247 passed (247)
   Duration  20.78s
```

No test was skipped and none was marked "todo" in this run.

| Test file | Tests passed | Main subject |
|---|---|---|
| `tests/domain/foundation.test.ts` | 6 | Seed and database-level rules |
| `tests/domain/intake.test.ts` | 43 | Courier receipt, routing, related orders, container checks, accession, corrections (checks 1–5, 11–12) |
| `tests/domain/clarifications.test.ts` | 36 | Clarifications, holds, assistant drafting (checks 4, 12, 15) |
| `tests/domain/worklist.test.ts` | 19 | Digital worklist, case page, operations, tasks (checks 1, 7, 12–14) |
| `tests/domain/grossing.test.ts` | 25 | Gross records, approval, source-entry states (checks 6, 7, 12, 13, 15) |
| `tests/domain/materials.test.ts` | 34 | Printing, labels, trays, block retrieval, canceled stains (checks 8, 9, 10, 14) |
| `tests/domain/integration.test.ts` | 46 | Simulated source import, outages, routing rule versions (checks 3, 11, 13, 14) |
| `tests/domain/demo.test.ts` | 38 | Guided demo steps 1–8, insights statistics, scenario calculator |
| **Total** | **247** | |

**Watch for "skipped" or "todo" in future runs.** A few tests are written to switch themselves off if a feature they depend on is missing:

- In `intake.test.ts`, the group "S1 hero path with the clarifications slice (cross-slice, skipped if clarification.create is not registered)" is skipped if the clarification feature is not present.
- In `demo.test.ts`, the full demo journey tests (and some other demo tests) turn into "todo" (with a "[waiting for: ...]" note) if any action they need is missing.

A skipped or todo test means that scenario was **not** tested in that run, even if the summary line says everything passed.

---

## 3. How to read this document

### Test levels

| Level | What it means | What it can catch | What it cannot catch |
|---|---|---|---|
| **Domain** | The test runs the app's real actions ("commands", see below) against a fresh in-memory copy of the synthetic demo day, then checks the results. | Wrong business rules, missing checks, wrong records | Anything about screens, clicks, layout or the web connection |
| **DB rule** | The test tries to change the database directly, skipping the app's code, and expects the database itself to refuse. | Bad changes from any code path, including future bugs | Rules that live only in app code |
| **Pure function** | A single calculation is tested with no database (for example, reading numbers from a dictation). | Logic errors in that calculation | How it is used elsewhere |
| **Read model** | The code that builds what a screen shows (lists, counts, labels) is called directly and its output checked. | Wrong counts, wrong grouping, misleading labels in the data | Whether the screen actually displays it |
| **Server render** | Screen components are turned into HTML inside Node, with no browser. | Missing labels, wrong disabled state in the markup | Clicks, keyboard use, real layout |
| **Full demo journey** | `demo.test.ts` runs guided demo steps 1 to 8 in "rehearsal mode", which performs every staff action through the same commands the screens call. | The story working end to end at the domain level | Anything in the browser |
| **Browser** | A real browser clicks through the screens. | The whole thing as a user sees it | Nothing exists yet (see §5) |

### Terms used below

- **Command:** one named action that changes something, such as `accession.request` or `gross.approve`. Every action a person takes in the app goes through one entry point, `executeCommand()` in `src/server/commands/registry.ts`, which checks the role, validates the input and runs the change as one all-or-nothing step. (The background simulator that delivers queued source messages, `pumpSources()` in `src/server/sim/pump.ts`, called on every `/api/live` poll, writes to the database outside this entry point.)
- **Seed:** the reproducible synthetic demo day (`src/server/seed/`), with about 60 cases and more than 300 slides. Tests start from a fresh copy every time, held only in memory, so they never touch the presenter's demo data.
- **Hold:** a block placed on specific material (for example, "order part B") that stops listed steps (for example, gross approval, printing) until a person releases it.
- **Version check (optimistic concurrency):** each editable record carries a version number. A save must say which version the person was looking at. If someone else saved in between, the save is refused with **CONFLICT** instead of overwriting their work.
- **Idempotent:** doing the same thing twice has the same effect as doing it once (a double click or a retry creates nothing new).
- **Error codes in tests:** `FORBIDDEN` = this role may not do this; `BLOCKED` = not allowed yet because something is unresolved; `CONFLICT` = someone else changed it first; `INVARIANT` = never allowed; `VALIDATION` = something is missing or malformed.

### Status words

Following the master spec, each check says what is:

- **Implemented locally:** real code in this demo that does the work on the local machine.
- **Simulated:** a stand-in for something that would be outside the app in real life (EMA-SIM source system, accession issuer, printers, office replies, notifications).
- **Unsupported:** not built.
- **Unknown:** a question about the real lab or real systems that the demo cannot answer (these belong in `docs/discovery-checklist.md`).

The scenarios in these tests (A/B orders split into two, a left/right mismatch, an unknown printer outcome, a hard-to-find block) are modeled on **employee observations** described in the master spec. They are not audited findings or measured rates.

---

## 4. The 15 checks

Test names below are copied exactly from the test files. "Group" is the `describe(...)` name and "Test" is the `it(...)` name. All test files are in `tests/domain/`.

### Check 1. An unknown office creates a routing exception, not a guessed doctor

**The check.** When specimens arrive from an office the app has no approved routing rule for, it must not guess which dermatopathologist gets the case. It should flag a routing exception and let an authorized person decide.

**How the app enforces it.**
- `src/server/domain/routing.ts`, `suggestRouting()`: returns status `exception` with **no** pathologist when the office is not in the directory, is new and not yet reviewed, is inactive, has no rule in the rule set in effect, no rule set was in effect at receipt time, or the named pathologist is inactive with no coverage. The explanation text says a lead must assign one with a reason.
- Database rule in `src/server/db/schema.sql` (table `routing_decision`): a row in `exception` status cannot carry a suggested pathologist, and an `overridden` row must have a non-empty reason.
- `src/server/domain/accession.ts`, `accessionBlockers()`: an item with a routing exception cannot be accessioned (blocker `routing_exception`).
- `routing.resolveException` and `routing.override` (commands in `src/server/commands/intake.ts`, logic in `routing.ts`): only an accessioning lead or supervisor (permission matrix in `src/lib/roles.ts`), and a reason is required. A `routing_exception` task goes to the accessioning lead.
- Orders are only looked up inside the office's own source practice ("tenant"): `findOrderInTenant()` in `src/server/domain/intake.ts`. An unknown office therefore never borrows another practice's order.
- Approved routing rule sets are frozen by database triggers (`routing_rule_frozen_update/insert/delete`); a change needs a new draft version and an authorized approval (`src/server/domain/routingRules.ts`).

**Covering tests.**

| File | Group | Test | Level |
|---|---|---|---|
| `intake.test.ts` | S1 intake: routing (acceptance check 1) | `routes a new, unreviewed office to a routing exception with no pathologist; only a lead with a reason can assign one` | Domain |
| `intake.test.ts` | S1 intake: routing (acceptance check 1) | `an office that is not in the directory is an exception and its order id is not looked up without a tenant` | Domain |
| `intake.test.ts` | S1 intake: routing (acceptance check 1) | `names the rule set version effective at receipt time and applies coverage exceptions` | Domain |
| `intake.test.ts` | S1 intake: routing (acceptance check 1) | `override needs a lead and a reason and keeps the rule's suggestion on record` | Domain |
| `intake.test.ts` | S1 intake bench read model | `puts routing exceptions, discrepancies, missing containers, identity conflicts and pending related reviews in the exceptions lane` | Read model |
| `worklist.test.ts` | worklist: routing exceptions | `puts an unknown-office intake item in its own unassigned group with no doctor color, never under a guessed doctor` | Read model |
| `worklist.test.ts` | worklist: routing exceptions | `an accessioned case without an active assigned doctor gets its own group, never labeled a routing exception` | Read model |
| `integration.test.ts` | acceptance 11: re-importing source data is idempotent; an older update never overwrites a newer one | `an office id the tenant never sent before becomes a NEW, unreviewed office in that tenant (never matched to another tenant's office) and goes to the unknown-offices queue` | Domain |
| `integration.test.ts` | settings read models are honest about routing gaps, connector capability and pending source messages | `Seagrape Skin Studio is listed as an unknown office with no approved rule, and every connector capability uses only the four honest words` | Read model |
| `integration.test.ts` | routing rules: approved versions are frozen; changes need a reasoned draft and an authorized approval | `the database refuses to edit, add or delete rules in an approved or retired set` | DB rule |

**Real vs simulated.** Routing logic, exceptions, tasks and rule versions: implemented locally. The office directory and routing rules are synthetic. Which offices really route to which doctors at the lab: unknown (staff currently remember it; see master spec §1).

**Gaps.**
- Only two exception reasons are tested directly (new unreviewed office; office not in the directory). "Inactive office", "no rule set in effect", "no rule for a reviewed office" and "covering pathologist unavailable" have no test of their own.
- The `routing_decision` database rule (no suggested doctor on an exception) is not tested with a direct database change.
- No browser test.

---

### Check 2. Candidate A/B related orders preserve both source IDs and require review

**The check.** When one patient's part A and part B arrive as two separate orders, the app may point out that they look related, but a person must decide. Both original order numbers must survive.

**How the app enforces it.**
- `src/server/domain/related.ts`, `assessPair()`: proposes a related-order candidate for the same source-scoped patient reference, same encounter (or encounter not stated on one order), same office and same collection day (or collection date missing on one order). Such a candidate always records the conflict "Separate source orders ... stay separate source records (both kept)". It also proposes a "possible duplicate patient record" (different MRNs, same name, birth date and office) for review only.
- `detectRelatedForIntake()`: stores one candidate per pair of orders (database `UNIQUE (order_a_id, order_b_id)`), status `pending_review`, and opens a `related_order_review` task for the accessioning lead.
- `reviewCandidate()`: lead or supervisor only, reason required, version checked. It refuses to approve "one accession" for two *different* patient records (possible duplicate record), refuses changes after accession, and refuses changes while an accession request for those items is waiting on the source.
- `accessionBlockers()` in `src/server/domain/accession.ts`: `related_pending` (not reviewed yet), `related_request_together` (approved as one, so request both together), `not_grouped`, `different_patients`, `routing_differs`.
- On accession, each part keeps its own `source_order_id` and `original_designation` (table `specimen_part` in `schema.sql`). Orders and patient records are never merged; no merge command exists.

**Covering tests.**

| File | Group | Test | Level |
|---|---|---|---|
| `intake.test.ts` | S1 intake: related orders and verification (acceptance checks 2, 3) | `A and B submitted as separate orders become one candidate that requires a lead's review; both source ids survive accession` | Domain |
| `intake.test.ts` | S1 grouping, related-order review and scan (review fixes) | `requesting items together is refused for different patients, for items not approved as one accession, and when routing differs` | Domain |
| `intake.test.ts` | S1 grouping, related-order review and scan (review fixes) | `a possible duplicate patient record (different MRNs, same name and birth date) is proposed for review but can never be approved as one accession` | Domain |
| `intake.test.ts` | S1 grouping, related-order review and scan (review fixes) | `a related-order decision cannot change while an accession request for its items waits for the offline source` | Domain |
| `intake.test.ts` | S1 hero path with the clarifications slice (cross-slice, skipped if clarification.create is not registered) | `part B laterality clarification with a part-scoped hold lets the A/B accession proceed and keeps the hold on part B only` | Domain |
| `demo.test.ts` | guided demo: hero journey D26-04817 (steps 1 to 8, rehearsal mode) | `reviews the related-order candidate (lead decision) without merging the two orders` | Full demo journey |
| `demo.test.ts` | guided demo: hero journey D26-04817 (steps 1 to 8, rehearsal mode) | `issues D26-04817 with part A on ORD-77120 and part B on ORD-77121 (both source ids preserved)` | Full demo journey |
| `demo.test.ts` | guided demo: simulator events alone never do staff work | `steps 1 to 8 without rehearsal change only the clock, the courier arrival and the unpacking` | Full demo journey |

**Real vs simulated.** Detection, review and grouping: implemented locally. Order data comes from the simulated source. Whether the real "two patients" problem is separate orders, encounters, accession records or duplicate patient records: unknown (master spec §1).

**Gaps.**
- The "keep separate" decision is tested only as a refused change; no test approves "keep separate" and then confirms the two items cannot be requested together (blocker `related_kept_separate`).
- The "encounter unknown" branch (proposed with an "Encounter unknown" warning) and the "clashing part designations" warning have no test.
- When two orders both use the same letter, the contract says the second part gets the next free letter with the original kept; no test covers that collision.

---

### Check 3. Same patient, two encounters stay separate; identical MRNs from different practices do not collide

**The check.** Two orders for one patient from two different visits must not be proposed as related. The same medical record number (MRN) used by two different source practices must be treated as two different people.

**How the app enforces it.**
- Database (`schema.sql`): `patient_ref` is unique on **(source practice, MRN)**, with the note "a name is never a key". Orders and offices are likewise unique per source practice.
- `src/server/domain/related.ts`, `assessPair()`: orders from different practices are never compared; same patient with two known, different encounters returns "not proposed", and `separateEncounterOrders()` lists them separately.
- `findOrderInTenant()` (`src/server/domain/intake.ts`): order lookup stays inside the office's practice.
- `src/server/domain/sourceImport.ts`: a new order whose MRN is on file with a different name or birth date is linked by MRN only and gets an urgent review task; the stored patient details are not changed. An unfamiliar office id becomes a new, unreviewed office in that practice, never matched to another practice's office.

**Covering tests.**

| File | Group | Test | Level |
|---|---|---|---|
| `foundation.test.ts` | foundation: seed, invariants enforced by the database | `same MRN in two source tenants is two different patient references` | Domain (reads the seeded records) |
| `intake.test.ts` | S1 intake: related orders and verification (acceptance checks 2, 3) | `an identical MRN in two tenants gives two patient references and never a related candidate` | Domain |
| `intake.test.ts` | S1 intake: related orders and verification (acceptance checks 2, 3) | `the same patient with a different encounter is not proposed; it is listed as a separate-encounter order` | Domain |
| `intake.test.ts` | S1 grouping, related-order review and scan (review fixes) | `a possible duplicate patient record (different MRNs, same name and birth date) is proposed for review but can never be approved as one accession` | Domain |
| `integration.test.ts` | acceptance 11: re-importing source data is idempotent; an older update never overwrites a newer one | `an unknown order for a known tenant is imported as a new order in that tenant's namespace` | Domain |
| `integration.test.ts` | acceptance 11: re-importing source data is idempotent; an older update never overwrites a newer one | `a new order whose MRN is on file with a different name or birth date is linked by MRN only and flagged for review, never merged` | Domain |
| `integration.test.ts` | acceptance 11: re-importing source data is idempotent; an older update never overwrites a newer one | `an office id the tenant never sent before becomes a NEW, unreviewed office in that tenant (never matched to another tenant's office) and goes to the unknown-offices queue` | Domain |

**Real vs simulated.** Implemented locally. The two "practices" (EMA-SIM Sunrise Coast and OTHER-EHR-SIM Gulf) are simulated. How the real offices' systems identify patients and encounters: unknown.

**Gaps.**
- No test for the "encounter not stated on one order" case.
- No test of two practices sending the same **order** number (only the same MRN is tested).

---

### Check 4. A patient/site mismatch keeps the conflicting evidence and blocks the affected step until authorized resolution

**The check.** If the bottle and the order disagree (for example, left vs right), the app must keep both values exactly as found, stop only the affected work, and let only an authorized person resolve it. An office reply alone must not resolve it.

**How the app enforces it.**
- `src/server/domain/intake.ts`, `verifyContainer()` and `compareContainer()`: a person records "verified against the physical container"; differences become `intake_discrepancy` records holding the order value, the bottle value and the paper requisition value as originally written. A system process cannot mark a container verified (refused as `INVARIANT`).
- Database triggers in `src/server/db/schema.intake.sql`: discrepancy evidence cannot be edited ("kept as found"), a closed discrepancy is final, and discrepancy rows cannot be deleted.
- `src/server/domain/holds.ts`: holds are scoped to the affected material (for example, order part B) and block only the listed steps (`gross_approval`, `processing`, `sectioning`, `print`, `tray_delivery`, `accession_request`, `routing_confirm`). `assertNotHeld()` is called before those steps.
- `accessionBlockers()` (`src/server/domain/accession.ts`): `identity_unresolved` (a patient identity mismatch needs a resolved identity clarification; a lead cannot accept it locally), `discrepancy_uncovered` (a mismatch needs a covering clarification or a lead's reasoned acceptance), `verification_stale` (order changed since the check).
- Resolution path (`src/server/commands/clarifications.ts`, `src/server/domain/clarification.ts`): an answer must be **reviewed** by a lead or supervisor, then **resolved** with a note; releasing a hold is a separate, audited step with a reason (`releaseHoldWithChecks()` in `clarification.ts`, which calls `releaseHold()` in `holds.ts`), refused while the clarification is open unless a supervisor uses an audited override. The simulated office answer and the amended order do not release anything by themselves; the amended order opens a "review and release" task for the lead (`src/server/domain/sourceImport.ts`).

**Covering tests.**

| File | Group | Test | Level |
|---|---|---|---|
| `clarifications.test.ts` | clarifications: acceptance check 4 (mismatch keeps evidence and blocks only the affected part) | `holds Part B's gated steps while Part A continues, through answer and review, until an authorized release` | Domain |
| `clarifications.test.ts` | clarifications: acceptance check 4 (mismatch keeps evidence and blocks only the affected part) | `after accessioning, a hold on one part blocks only that part (scopesForPart) and the release is a separate audited event` | Domain |
| `clarifications.test.ts` | clarifications: loop-closing rules | `an answer never resolves: resolve is blocked until a lead reviews the answer` | Domain |
| `clarifications.test.ts` | clarifications: loop-closing rules | `resolve requires a reviewed answer and a note; review requires an answer` | Domain |
| `clarifications.test.ts` | clarifications: loop-closing rules | `canceling needs a reason and leaves linked holds active with a release-decision task` | Domain |
| `clarifications.test.ts` | clarifications: manual holds (hold.place) and releases (hold.release) | `only the supervisor can release a hold while its clarification is open, and the override is audited only when used` | Domain |
| `clarifications.test.ts` | clarifications: duplicates still protect the material | `a repeated raise that asks for a hold places it on the open clarification instead of dropping it` | Domain |
| `intake.test.ts` | S1 intake: related orders and verification (acceptance checks 2, 3) | `records the part B laterality mismatch with both original values; abbreviations are normalized only for comparison` | Domain + DB rule |
| `intake.test.ts` | S1 intake: related orders and verification (acceptance checks 2, 3) | `a scan, rule or system process can never set 'staff verified against physical container'` | Domain |
| `intake.test.ts` | S1 recorded discrepancies: identity, edits, coverage, amendments (review fixes) | `a patient identity mismatch blocks accession with no hold at all, until an identity clarification is resolved; a lead cannot accept it locally` | Domain |
| `intake.test.ts` | S1 recorded discrepancies: identity, edits, coverage, amendments (review fixes) | `retyping the bottle observation never closes a recorded mismatch; only a lead's acceptance with a reason does, and the values stay as found` | Domain + DB rule |
| `intake.test.ts` | S1 recorded discrepancies: identity, edits, coverage, amendments (review fixes) | `an uncovered discrepancy blocks accession; another category or a clarification resolved before the finding does not cover it; canceling the covering one blocks again` | Domain |
| `intake.test.ts` | S1 accession: idempotency, holds, source outage | `a scoped hold on part B does not block accession, follows the part onto the case, and gates only part B` | Domain |
| `grossing.test.ts` | S4 grossing: a reviewed gross record that becomes available part by part | `a part under the seeded orientation hold H-0089 can be drafted and reviewed but not approved` | Domain |
| `materials.test.ts` | Bench progress respects holds and never delivers slides outside a tray | `a sectioning hold blocks cutting; delivery is only through a tray; gross approval gates processing` | Domain |
| `integration.test.ts` | amended orders: issued parts are never silently changed; pre-accession parts update with a lead review | `hero ORD-77121 v2 updates the pre-accession order part's working laterality and opens the lead task to review and release the hold` | Domain |
| `demo.test.ts` | guided demo: simulator events alone never resolve work | `a simulated office answer and the amended order leave the clarification unresolved and the Part B hold active until staff act` | Full demo journey |
| `demo.test.ts` | guided demo: hero journey D26-04817 (steps 1 to 8, rehearsal mode) | `resolves the Part B laterality clarification only after review, and releases its hold only after the amended order arrived` | Full demo journey |

**Real vs simulated.** Evidence keeping, holds and the review/resolve/release rules: implemented locally. The office's answer, the notification channel and the amended order are simulated. Why real clarification replies are slow (notifications unsupported, disabled, ignored or misdirected): unknown (master spec §1).

**Gaps.**
- For the hero Part B hold, only gross approval is checked directly. Printing and sectioning holds are tested with other holds; holds on `processing` and `tray_delivery` for Part B have no direct test.
- The hero mismatch is laterality (left vs right). A site-wording mismatch at intake is tested only through the post-accession "site" clarification; procedure and birth-date mismatches are tested separately.
- No browser test of the hold banner or the "Raise clarification" flow.

---

### Check 5. A discrepancy found after accessioning cannot silently renumber or merge cases or invalidate printed identities

**The check.** Once a case number is issued, a problem found later must go to a review, not to a quiet local fix. The case number, the part letters and sites, and the identities already printed on labels must not change.

**How the app enforces it.**
- Database triggers in `src/server/db/schema.sql`: `accession_number_immutable` (no renumbering), `accession_patient_immutable` (a case cannot be moved to another patient), `specimen_part_identity_immutable` (a part's letter, case and site cannot change).
- `src/server/domain/correction.ts`, `openCorrection()`: records a correction review with a snapshot of the original references (`snapshotRefs()`), opens a task for the accessioning lead, and does not create a duplicate review for the same issue. `closeCorrection()`: lead or supervisor only; outcomes include "referred to the source system's correction process". There is no renumber or merge command anywhere in the app.
- `reviewCandidate()` (`src/server/domain/related.ts`) refuses to change a related-order decision once its items are accessioned. Intake edits after accession are refused (`recordObservation()` in `src/server/domain/intake.ts`).
- `src/server/domain/sourceImport.ts`: a site or laterality change arriving for an **already issued** part opens a correction review and leaves the issued part as it was.
- Grossing amendments keep the existing block identity (`amend()` and `approve()` in `src/server/domain/gross.ts`). Label payloads carry the case, part, block, slide and stain plus a check character (`src/lib/identifiers.ts`). The case number and part letter are protected by the database rules above. Block and slide numbers have no database rule; no command changes them.

**Covering tests.**

| File | Group | Test | Level |
|---|---|---|---|
| `foundation.test.ts` | foundation: seed, invariants enforced by the database | `refuses to renumber an issued accession or change a part's site/designation (DB trigger)` | DB rule |
| `foundation.test.ts` | foundation: seed, invariants enforced by the database | `keeps the audit log append-only` | DB rule |
| `foundation.test.ts` | foundation: seed, invariants enforced by the database | `demo label identifiers round-trip and reject a damaged scan` | Pure function |
| `intake.test.ts` | S1 post-accession correction (acceptance check 5) | `a discrepancy found after accessioning opens a correction review with original references; nothing is renumbered, merged or relabeled` | Domain + DB rule |
| `intake.test.ts` | S1 post-accession correction (acceptance check 5) | `intake edits after accessioning are refused (use a correction review instead)` | Domain |
| `integration.test.ts` | amended orders: issued parts are never silently changed; pre-accession parts update with a lead review | `a laterality change on an already-accessioned part opens a correction review and never changes the issued part` | Domain |
| `integration.test.ts` | amended orders: issued parts are never silently changed; pre-accession parts update with a lead review | `amendments are compared with the ISSUED part: v2 opens one correction review, and a v3 that matches the issued part again opens no second review` | Domain |
| `grossing.test.ts` | S4 grossing: a reviewed gross record that becomes available part by part | `approved content is frozen; an amendment creates v2 and supersedes v1 without changing it` | Domain + DB rule |
| `grossing.test.ts` | S4 grossing: a reviewed gross record that becomes available part by part | `an approval never reuses a voided block for an allocated cassette` | Domain |

**Real vs simulated.** The local review record and the database rules: implemented locally. The actual correction happens in the authoritative source system, which is simulated here; the app only records that it was referred. How corrections really work in EMA at the lab: unknown (master spec §1 says correction is difficult once a number is assigned).

**Gaps.**
- The `accession_patient_immutable` database rule (no moving a case to another patient) has no test.
- No test takes a case that already has printed labels through a correction review and then re-verifies those labels. Protection here is indirect: the values in the label cannot change.

---

### Check 6. A grossing draft with an uncertain decimal/unit or a missing piece count cannot be finalized without review

**The check.** If the dictation says something like "point six by four" (was it 0.4 or 4?), leaves out the unit, or gives a vague piece count ("a couple of fragments"), the record must not be approved until a person enters explicit values.

**How the app enforces it.**
- `src/server/assist/extractor.ts`, `extractGrossFields()`: a deterministic, rule-based reader of synthetic dictations. Values it reads are only **proposed**; ambiguous numbers and missing units become **needs review**; vague counts become **missing**; mixed units are flagged and never converted.
- `src/lib/gross.ts`, `grossFinalizeBlockers()`: every required field must be **confirmed by a person**; piece count must be a whole number of at least 1; dimensions need a stated unit (cm or mm); the narrative cannot be empty.
- `src/server/domain/gross.ts`: `confirmField()` keeps a needs-review value "as dictated" only when the person explicitly confirms "I checked the specimen; the dictated value is correct" (pressing Enter is not enough, and choosing a unit resolves only a missing unit, not a possible missed decimal); typing a different value also resolves it, `markReviewed()` and `approve()` refuse while blockers exist (`approvalBlockers()`), and an approved record's content is frozen by a database trigger (`gross_record_approved_frozen`).

**Covering tests.**

| File | Group | Test | Level |
|---|---|---|---|
| `grossing.test.ts` | S4 grossing: a reviewed gross record that becomes available part by part | `check 6: an ambiguous decimal, a missing unit and a vague piece count cannot be approved until a person confirms explicit values` | Domain |
| `grossing.test.ts` | S4 grossing: a reviewed gross record that becomes available part by part | `check 6: units are never assumed or converted (no unit stays unknown; millimeters stay millimeters)` | Domain |
| `grossing.test.ts` | S4 grossing: a reviewed gross record that becomes available part by part | `check 6: a needs-review value is never accepted as dictated by Enter or by only choosing a unit; it takes a different value or an explicit 'checked the specimen' step` | Domain |
| `grossing.test.ts` | S4 grossing: a reviewed gross record that becomes available part by part | `check 6: typed dimensions without a unit are kept as needs review; no unit is assumed` | Domain |
| `grossing.test.ts` | S4 grossing: a reviewed gross record that becomes available part by part | `a record flagged as needing clarification cannot be marked reviewed until someone records how it was resolved; it then returns to draft` | Domain |
| `grossing.test.ts` | S4 grossing: a reviewed gross record that becomes available part by part | `attaching the same transcript twice is idempotent, and a new transcript never overwrites an operator-confirmed value` | Domain |
| `grossing.test.ts` | S4 deterministic demo extractor (pure function: same text, same proposals) | `never guesses an ambiguous number (spoken 'one five' or digits '1 5'): the value stays empty and needs review` | Pure function |
| `grossing.test.ts` | S4 deterministic demo extractor (pure function: same text, same proposals) | `flags mixed units and converts neither` | Pure function |
| `grossing.test.ts` | S4 deterministic demo extractor (pure function: same text, same proposals) | `cut pieces explained by bisecting or trisecting are not a count conflict; an unexplained cassette count still is` | Pure function |
| `grossing.test.ts` | S4 deterministic demo extractor (pure function: same text, same proposals) | `reads spoken decimals, 'x' separators and cassette ranges; proposals are never confirmed` | Pure function |
| `grossing.test.ts` | S4 grossing screen (server-side smoke render of the client components) | `a draft shows honest labels, the visible list of blockers and a disabled microphone; an approved record shows attestation and simulated acknowledgment as separate actions` | Server render |

**Real vs simulated.** The review rules: implemented locally. Dictations are fixed synthetic transcripts (`src/server/seed/fixtures/transcripts.ts`); there is no live speech recognition (the microphone is shown disabled). How the lab's real grossing documentation and templates work: unknown.

**Gaps.**
- The extractor is tested only on a small set of synthetic dictations. It is not shown to handle real dictation wording, accents or recording quality.
- No browser test of the grossing screen; the server-render test checks markup only.

---

### Check 7. Completing one part updates eligible work while unfinished parts stay incomplete

**The check.** When the grosser approves part A, part A's block should become available for the next step right away, while part B (not grossed yet) stays incomplete, and the case must not be shown as complete.

**How the app enforces it.**
- `src/server/domain/gross.ts`, `approve()`: in one all-or-nothing step it creates the block for each allocated cassette (location unknown until someone confirms it), marks part A grossed, sets the source-entry state to "pending entry", opens a `source_entry` task (owner: Sam Ortiz, synthetic) and a `processing_eligible` task per block (unless a hold blocks processing; `syncProcessingEligibility()` re-derives this later), and records a worklist change that names what changed and what did not ("part B still awaiting grossing").
- `src/server/domain/readiness.ts`, `computeReadiness()`: readiness is worked out per part from the records; a case can only count as complete when every active part is delivered.
- `src/server/queries/worklist.ts`, `caseIsComplete()`: adds a second condition, no open work order on any part. The worklist rows and the case page (`src/server/queries/case.ts`) both use it. `src/server/queries/operations.ts` lists blocked work with owners.

**Covering tests.**

| File | Group | Test | Level |
|---|---|---|---|
| `grossing.test.ts` | S4 grossing: a reviewed gross record that becomes available part by part | `check 7: approving part A creates A's block and downstream tasks immediately; part B stays awaiting grossing and the case is not complete` | Domain |
| `grossing.test.ts` | S4 grossing: a reviewed gross record that becomes available part by part | `a block held from processing at approval gets no processing task; after the hold is released, eligibility is re-derived and the task opens once` | Domain |
| `worklist.test.ts` | worklist: completing one part (acceptance check 7, worklist angle) | `shows part A eligible for processing while part B stays awaiting grossing and the case is not complete` | Read model |
| `worklist.test.ts` | worklist: completing one part through the real commands (acceptance check 7, guided demo steps 1-5) | `after S4 approves Part A of the hero case, the row shows A ready and B not ready, and the case is not complete` | Demo steps 1–5 + read model |
| `worklist.test.ts` | case detail and operations read models | `case detail resolves by accession number, keeps physical and documentation tracks separate, and never calls a partial case complete` | Read model |
| `worklist.test.ts` | case detail and operations read models | `a case whose parts are all delivered but with an open work order is not complete, anywhere it is shown` | Read model |
| `foundation.test.ts` | foundation: seed, invariants enforced by the database | `derives readiness per part: one finished part never makes the case complete` | Domain |
| `demo.test.ts` | guided demo: hero journey D26-04817 (steps 1 to 8, rehearsal mode) | `approving Part A makes A1 eligible and opens a source-entry task for Sam, while Part B stays incomplete` | Full demo journey |

**Real vs simulated.** Implemented locally. The worklist is the app's digital version of the printed daily report ("the bible"); it does not feed any real system.

**Gaps.**
- "Immediately" is tested as "in the same step as the approval". Whether an already-open worklist screen refreshes on its own is not tested in a browser.

---

### Check 8. A printer timeout stays "unknown" until reconciled; retries and double clicks create no uncontrolled duplicate jobs

**The check.** If the printer does not confirm a label, the app must not assume it printed or failed. A person checks and records what came out. Pressing Print again, or double clicking, must not create a second job behind the first one's back.

**How the app enforces it.**
- `src/server/domain/print.ts`: `requestPrint()` returns "duplicate prevented" (and audits it) while a job for the same label is in flight or has an unknown outcome; `reconcileJob()` records what a person saw ("printed OK", "not printed", "printed damaged", "can't tell", which escalates to the supervisor); `reprintJob()` needs a reason, links to the original job, is refused before reconciliation, and keeps one straight chain of reprints. A printer "acknowledged" response is not treated as proof of output: a label record is created only when completion is confirmed, either by a simulated printer that reports completion or by a person who checked the output.
- `src/server/sim/printer.ts`, `simulateSubmit()`: simulated printers that can be online, offline (job stays queued) or set to time out (job becomes "unknown outcome" with a reconcile task).
- Database (`schema.sql`): unique index `print_job_one_in_flight` allows at most one in-flight job per item (slide, block or case) and label kind; a check rule requires a reason and an original job on every reprint.
- `executeCommand()` (`src/server/commands/registry.ts`): a repeated request with the same idempotency key replays the stored result instead of running again.

**Covering tests.**

| File | Group | Test | Level |
|---|---|---|---|
| `materials.test.ts` | Acceptance 8: a printer timeout stays unknown until reconciled; no uncontrolled duplicates | `a timeout after submission leaves the job in Unknown outcome with a reconcile task, and retries or double clicks create no new job` | Domain + DB rule |
| `materials.test.ts` | Acceptance 8: a printer timeout stays unknown until reconciled; no uncontrolled duplicates | `PJ-8841: after 'Not printed' reconciliation, a reprint needs a reason, links the original, records the operator and creates no new slide` | Domain |
| `materials.test.ts` | Acceptance 8: a printer timeout stays unknown until reconciled; no uncontrolled duplicates | `"Can't tell" keeps the job unknown, escalates to a supervisor, and still blocks any retry` | Domain |
| `materials.test.ts` | Acceptance 8: a printer timeout stays unknown until reconciled; no uncontrolled duplicates | `an offline printer keeps the job queued (nothing lost, no duplicate) and it prints when released` | Domain |
| `materials.test.ts` | Acceptance 8: a printer timeout stays unknown until reconciled; no uncontrolled duplicates | `printing, applying and verifying a label are separate; a damaged-label reprint retires the old label through an explicit step` | Domain |
| `materials.test.ts` | Acceptance 8: a printer timeout stays unknown until reconciled; no uncontrolled duplicates | `ordering an additional slide creates a work order and a new planned slide; it is not a reprint` | Domain |
| `materials.test.ts` | Reprint traceability | `after a 'not printed' reconciliation, a plain new print is refused so the retry stays linked to the original job` | Domain |
| `materials.test.ts` | Printer acknowledgement is not proof of output; reprints stay one linear chain | `an acknowledged job has no label until a person records the output, can be recorded as not printed, and blocks reprint until then` | Domain |
| `materials.test.ts` | Printer acknowledgement is not proof of output; reprints stay one linear chain | `on the cassette printer (reports completion), a second reprint of the same original is refused and points at the newer job` | Domain |
| `materials.test.ts` | Printer acknowledgement is not proof of output; reprints stay one linear chain | `after a failed job and a successful reprint, the failed job cannot be reprinted again` | Domain |
| `materials.test.ts` | Printer acknowledgement is not proof of output; reprints stay one linear chain | `a damaged label confirmed at the printer opens a reprint task that the reprint closes; a print hold blocks printing; cancel needs a reason` | Domain |
| `demo.test.ts` | guided demo: hero journey D26-04817 (steps 1 to 8, rehearsal mode) | `does not retry PJ-8841 before its unknown outcome is reconciled` | Full demo journey |
| `demo.test.ts` | insights on the seeded synthetic day | `snapshots unresolved work by type with ages, including the unknown-outcome print job` | Read model |

**Real vs simulated.** Job states, reconciliation and duplicate prevention: implemented locally. Printers are simulated. Which printers, drivers and label stock the lab uses, and how they report status: unknown.

**Gaps.**
- No real printer, print spooler or network timeout is involved.
- Double clicks are tested as repeated action calls (same or different idempotency key), not as two simultaneous web requests.

---

### Check 9. A tray expecting ten slides with nine expected plus one unexpected slide cannot become "verified complete"

**The check.** Tray TRY-M-03 (synthetic) should hold ten slides. If nine expected slides and one slide that belongs elsewhere are scanned, the tray must not be marked complete. The app should allow a controlled resolution instead.

**How the app enforces it.**
- `src/server/domain/tray.ts`: `scanIntoTray()` sorts each scan into expected, unexpected (not accepted, names the right pathologist), duplicate, or invalid (bad check character). `computeTrayView()` lists what blocks completion. `completeTray()` refuses while anything is missing or unexpected, and checks the version so a stale "Mark complete" is a conflict. `setTrayDisposition()` records a decision for a missing slide ("follows separately" or "missing-material investigation"), which never counts as complete. `releaseTrayWithExceptions()` is supervisor-only, needs a note and a disposition for every outstanding slide, and gives the status "released with exceptions", which is different from "verified complete". `resolveTrayScan()` refuses to add another pathologist's slide to the tray list.

**Covering tests.**

| File | Group | Test | Level |
|---|---|---|---|
| `materials.test.ts` | Acceptance 9: TRY-M-03 cannot become verified complete with a missing and an unexpected slide | `storyline step 6: 9 expected + 1 unexpected scanned → completion is BLOCKED with reasons; a histotech cannot release with exceptions` | Domain |
| `materials.test.ts` | Acceptance 9: TRY-M-03 cannot become verified complete with a missing and an unexpected slide | `finding the missing slide and scanning it (after removing the unexpected one) lets the tray be verified complete` | Domain |
| `materials.test.ts` | Acceptance 9: TRY-M-03 cannot become verified complete with a missing and an unexpected slide | `a duplicate scan is counted once and must be resolved; a label with a bad check character is rejected` | Domain + read model |
| `materials.test.ts` | Acceptance 9: TRY-M-03 cannot become verified complete with a missing and an unexpected slide | `an unexpected slide from another pathologist cannot be added to the tray's list, even by a supervisor` | Domain |
| `materials.test.ts` | Trays: canceled material, consistent eligibility | `a slide whose work is canceled after it was scanned no longer counts, blocks completion and delivery until it is taken off` | Domain + read model |
| `materials.test.ts` | Trays: canceled material, consistent eligibility | `while a scanned slide is canceled on an open tray, completion is BLOCKED with that reason and the tray is in exception` | Domain |
| `materials.test.ts` | Trays: canceled material, consistent eligibility | `a supervisor cannot add an unexpected slide whose label was never scanned after application; the tray picker counts what tray.open accepts` | Domain + read model |
| `demo.test.ts` | guided demo: hero journey D26-04817 (steps 1 to 8, rehearsal mode) | `does not verify TRY-M-03 complete while a slide is missing and an unexpected slide was scanned` | Full demo journey |

**Real vs simulated.** Tray rules: implemented locally. "Scanning" means entering the label's text payload; there is no scanner hardware. How trays are actually assembled and handed off at the lab: unknown.

**Gaps.**
- Only the seeded TRY-M-03 scenario and variations of it are tested.
- No scanner, barcode reading or label print quality is tested.

---

### Check 10. Scanning the wrong block for a retrieval request shows a mismatch; an old location is shown as "last confirmed", not guaranteed

**The check.** When someone pulls blocks for request RR-0192 (synthetic) and scans a block that is not on the request, the app must say so and change nothing. Storage locations must be presented as "last confirmed by a person at a time", because the block may have moved since.

**How the app enforces it.**
- `src/server/domain/retrieval.ts`, `scanForRequest()`: a block that is not on the request is a mismatch; nothing about the request or the block changes, and a `scan_mismatch` custody event is recorded. A block checked out to someone else is not silently taken; a block recorded as sent outside the lab opens a custody-conflict task for the supervisor. `markNotFound()` starts a missing-material investigation and makes the request a partial retrieval. `returnBlock()` confirms a full slot code only.
- `locationCard()` (`retrieval.ts`) and `getRetrievalDetail()` (`src/server/queries/materials.ts`): each location reads "Last confirmed: <slot> · confirmed <time> by <person>", with the fixed caption "Last confirmed location, not live tracking. The block may have moved since."
- Database: custody events cannot be edited or deleted (triggers `custody_event_no_update/no_delete`).

**Covering tests.**

| File | Group | Test | Level |
|---|---|---|---|
| `materials.test.ts` | Acceptance 10: RR-0192 — wrong block scan is a mismatch; locations are last confirmed, not live | `scanning D26-03909 A1 for RR-0192 shows a mismatch, changes nothing, and records a scan_mismatch custody event` | Domain |
| `materials.test.ts` | Acceptance 10: RR-0192 — wrong block scan is a mismatch; locations are last confirmed, not live | `the request view shows each location as last confirmed with time and person, with the fixed not-live caption, and the overdue checkout` | Read model |
| `materials.test.ts` | Acceptance 10: RR-0192 — wrong block scan is a mismatch; locations are last confirmed, not live | `the correct block scan picks it and checks it out to the scanner with the destination; a second scan is a duplicate` | Domain |
| `materials.test.ts` | Acceptance 10: RR-0192 — wrong block scan is a mismatch; locations are last confirmed, not live | `a block not at its last location opens a missing-material investigation; the request becomes a partial retrieval` | Domain |
| `materials.test.ts` | Acceptance 10: RR-0192 — wrong block scan is a mismatch; locations are last confirmed, not live | `a block recorded as sent outside the lab is not silently picked when scanned (conflicting records go to a supervisor)` | Domain |
| `materials.test.ts` | Retrieval: conflicting custody records are not resolved silently; retrieved blocks can be cut | `a block recorded as checked out to someone else is not picked by another person; a supervisor can record the hand-off` | Domain |
| `materials.test.ts` | Retrieval: conflicting custody records are not resolved silently; retrieved blocks can be cut | `'not found' for a checked-out block clears the recorded holder and says where it should have been; a sent-out block is not reported missing` | Domain |
| `materials.test.ts` | Retrieval: conflicting custody records are not resolved silently; retrieved blocks can be cut | `a deeper level ordered on an archived block can be sectioned only once the block is retrieved to the bench` | Domain |
| `demo.test.ts` | guided demo: hero journey D26-04817 (steps 1 to 8, rehearsal mode) | `rejects the wrong block for RR-0192 and changes nothing about it` | Full demo journey |

**Real vs simulated.** Custody records and mismatch handling: implemented locally. Storage slots and checkout history are synthetic. How blocks are really filed and found at the lab: unknown (master spec §1 notes considerable manual number checking).

**Gaps.**
- The app only knows what people recorded; it has no live tracking. This is by design and is stated on screen, but no browser test confirms the caption is visible.

---

### Check 11. Re-importing the same source data is idempotent; an older update cannot silently overwrite a newer reviewed version

**The check.** If the source system sends the same message twice, nothing should change the second time. If an older version of an order arrives after a newer one, it must be ignored, not applied over the newer data.

**How the app enforces it.**
- `src/server/domain/sourceImport.ts`, `importSourceMessage()`: a message id already seen is `duplicate_ignored` (the receipt is counted, nothing else changes); a version that is not newer than the stored one is `stale_ignored` (if the same version number arrives with different content, a review task opens); a malformed message fails with a reason and changes nothing; failures are kept in a queue that a supervisor can retry. Changes to patient, office or encounter in a newer version are sent to review, not applied.
- Database (`schema.sql`, `schema.s6.sql`): `integration_event` is unique per (source, message id); every order version is stored once (`UNIQUE (source_order_id, source_version)`) and stored versions cannot be edited or deleted (triggers on `source_order_version`); the receipt log is append-only.
- Local reviewed records are protected too: approved gross content is frozen (trigger) and issued parts cannot change (Check 5).
- Receiving the same courier item or requesting the same accession again returns the existing record (`receivePhysicalItem()` in `src/server/domain/intake.ts`, `requestAccession()` in `src/server/domain/accession.ts`, unique `idempotency_key` on `accession_request`).

**Covering tests.**

| File | Group | Test | Level |
|---|---|---|---|
| `integration.test.ts` | acceptance 11: re-importing source data is idempotent; an older update never overwrites a newer one | `the 11:04 duplicate delivery of ORD-77118 v1 is ignored and changes nothing` | Domain |
| `integration.test.ts` | acceptance 11: re-importing source data is idempotent; an older update never overwrites a newer one | `replaying the same message again and again keeps every count unchanged` | Domain |
| `integration.test.ts` | acceptance 11: re-importing source data is idempotent; an older update never overwrites a newer one | `the seeded 11:25 replay of ORD-75347 v1 is stale_ignored and the newer v2 stays` | Domain |
| `integration.test.ts` | acceptance 11: re-importing source data is idempotent; an older update never overwrites a newer one | `an older version arriving after a newer one (out of order) is ignored and does not overwrite` | Domain |
| `integration.test.ts` | acceptance 11: re-importing source data is idempotent; an older update never overwrites a newer one | `the same version number re-sent with different content is stale_ignored (contract) and opens a review task; the stored version is kept` | Domain |
| `integration.test.ts` | acceptance 11: re-importing source data is idempotent; an older update never overwrites a newer one | `an unprocessable message is kept in the failure queue (never thrown) and a supervisor can retry it` | Domain |
| `integration.test.ts` | acceptance 11: re-importing source data is idempotent; an older update never overwrites a newer one | `a malformed payload fails validation with a reason and changes nothing` | Domain |
| `integration.test.ts` | acceptance 11: re-importing source data is idempotent; an older update never overwrites a newer one | `a message that failed and turns out stale on retry says it was processed (not applied) on retry` | Domain |
| `integration.test.ts` | acceptance 11: re-importing source data is idempotent; an older update never overwrites a newer one | `if the receipt log cannot be written, the import is still applied and recorded once (logging never fails an import)` | Domain |
| `integration.test.ts` | amended orders: issued parts are never silently changed; pre-accession parts update with a lead review | `patient, office or encounter changes in a newer version are sent to review and not applied; the ordering provider is updated as a working value` | Domain |
| `integration.test.ts` | demo controls and the contact directory | `an older version delivered late through the demo control is ignored as stale` | Domain |
| `intake.test.ts` | S1 accession: idempotency, holds, source outage | `repeated receive, receive-all and double accession requests create no duplicate intake items, cases, tasks or numbers` | Domain |
| `intake.test.ts` | S1 container counts per order part and links (review fixes) | `receives a requisition by its order id within the delivery, idempotently` | Domain |
| `worklist.test.ts` | case detail and operations read models | `source documents keep the ORIGINAL order values after an amendment, next to the current source value and the value on the case` | Read model |

**Real vs simulated.** Import rules: implemented locally. Messages come from a simulated outbox in a simple JSON format the app defines (`SimulatedOrderSchema` in `sourceImport.ts`). ModMed documents HL7 interfaces and APIs [R2][R3][R4]; none of them were used. Whether the real source supplies a reliable version number per order: unknown.

**Gaps.**
- Only the simulated message format is tested; HL7 v2, FHIR or vendor API messages are not.
- Ordering relies on the version number in each message. Real feeds may not provide one; that needs discovery.

---

### Check 12. Concurrent edits detect conflict; server-side role checks prevent unauthorized resolution or approval; the demo role selector is not authentication

**The check.** If two people edit the same thing, the second save must be refused rather than overwrite the first. Who may approve or resolve must be checked by the server, not only by hiding buttons. The "Acting as" selector is a demo convenience, not a sign-in.

**How the app enforces it.**
- Version checks: `updateVersioned()` in `src/server/core/versioning.ts` refuses a save whose expected version is out of date (`CONFLICT`, with the current version). Commands that edit shared records pass the version the person saw (see `docs/dev/command-contract.md`).
- Role checks: every command goes through `executeCommand()` (`src/server/commands/registry.ts`), which calls `requirePermission()` (`src/server/core/context.ts`) against the permission matrix in `src/lib/roles.ts` before anything changes. Refusals are recorded in the audit log as `command.denied`. Exception: 14 demo and simulator controls (for example `demo.setClock`, `printer.setStatus`, `clarification.simulateOfficeAnswer`) declare no permission and are open to any demo role; a few add their own limits (rehearsal mode in `demo.runStep` is supervisor-only, and `gross.simulateSourceAck` refuses the read-only roles).
- Demo role selector: `src/server/session.ts` stores the chosen staff id in a cookie and states in its code comment that this is "NOT authentication". The selector's label (`src/components/shell/acting-as.tsx`) reads "Acting as (demo role switch, not a sign-in)" on wide screens; on narrower screens ", not a sign-in" is kept only for screen readers and the hover text, and each switch shows the message "Demo role switch. Not a sign-in." The main web entry point for actions is `src/app/api/commands/[name]/route.ts`.

**Covering tests (conflicts).**

| File | Group | Test | Level |
|---|---|---|---|
| `intake.test.ts` | S1 concurrency and role checks (acceptance check 12) | `two accessioners on one item: the stale save is rejected as a conflict and the colleague's edit is kept` | Domain |
| `grossing.test.ts` | S4 grossing: a reviewed gross record that becomes available part by part | `a stale expectedVersion is rejected with CONFLICT and a colleague's edit is not overwritten` | Domain |
| `grossing.test.ts` | S4 grossing: a reviewed gross record that becomes available part by part | `concurrent edits on the screen: while I have unsaved edits a colleague's newer version is not adopted, so my save returns CONFLICT instead of overwriting theirs` | Domain + pure function |
| `clarifications.test.ts` | clarifications: acceptance check 12 (server-side roles and stale edits) | `two reviewers acting on the same version: the second gets CONFLICT instead of overwriting` | Domain |
| `clarifications.test.ts` | clarifications: reminders, escalation and the notification connector | `sending a version someone else changed returns CONFLICT and sends nothing` | Domain |
| `worklist.test.ts` | worklist: printed / downloaded snapshots | `records the worklist version, generation time, author and source data age, and refuses a snapshot of a list that moved on` | Domain |
| `integration.test.ts` | demo controls and the contact directory | `a stale contact-directory edit is rejected instead of overwriting a colleague's change` | Domain |

**Covering tests (server-side roles).**

| File | Group | Test | Level |
|---|---|---|---|
| `intake.test.ts` | S1 concurrency and role checks (acceptance check 12) | `server-side role checks refuse unauthorized actions whatever the demo role selector shows` | Domain |
| `clarifications.test.ts` | clarifications: acceptance check 12 (server-side roles and stale edits) | `an accessioner cannot resolve, a read-only director cannot send or create, and denials are audited` | Domain |
| `grossing.test.ts` | S4 grossing: a reviewed gross record that becomes available part by part | `server-side role checks: an accessioner cannot approve, a histology assistant cannot approve or confirm cassettes, a read-only role cannot edit` | Domain |
| `worklist.test.ts` | tasks: claiming, taking over and releasing the next step | `only a role that fits the task can claim it, a stale view gets a conflict, and read-only roles are refused on the server` | Domain |
| `worklist.test.ts` | tasks: claiming, taking over and releasing the next step | `taking over or releasing someone else's task needs an accessioning lead or the supervisor and a reason; the task's role is kept` | Domain |
| `integration.test.ts` | routing rules: approved versions are frozen; changes need a reasoned draft and an authorized approval | `a supervisor drafts v4 with a reason, only a permitted role approves it, and v3 is retired with an end date` | Domain |
| `integration.test.ts` | routing rules: approved versions are frozen; changes need a reasoned draft and an authorized approval | `coverage exceptions need a permitted role, a reason and two different dermatopathologists` | Domain |
| `intake.test.ts` | S1 grouping, related-order review and scan (review fixes) | `the colleague-edit demo control is refused for the read-only role and records who pressed it` | Domain |
| `demo.test.ts` | guided demo: step runner safety | `limits rehearsal (acting as other named staff) to the supervisor demo role; world events stay open to every role` | Domain |

Role refusals also appear inside tests listed under other checks (for example, release with exceptions in Check 9, print reconciliation in Check 8, keeping a source-canceled stain in Check 14).

**Real vs simulated.** Version checks and role checks: implemented locally. Sign-in: **unsupported**. There are no accounts, passwords or sessions; anyone using the demo can pick any role. Real identity management is a deployment dependency (master spec §14).

**Gaps.**
- Tests call actions directly with a staff id. They do not go through the web route and cookie (`src/app/api/commands/[name]/route.ts`).
- "Concurrent" is tested as two saves made one after the other from the same out-of-date version, not as simultaneous requests from two computers.
- Because there is no authentication, these tests show only that the server checks the role of whichever staff member is named. They say nothing about whether that person is who they claim to be.

---

### Check 13. A source outage visibly marks data stale; restored events reconcile without duplicating work; local task completion implies no source writes

**The check.** If the source system goes offline, screens must say the data may be old. When it comes back, the backlog must be applied once. Finishing work locally must never be shown as "written to the source system".

**How the app enforces it.**
- `src/server/sim/pump.ts`, `pumpSourcesDetailed()`: while a simulated source is offline, nothing is delivered and the failed attempt is recorded ("Simulated outage"); when it is back, queued messages go through the importer, which ignores duplicates and stale versions (Check 11).
- `src/server/queries/settings.ts`, `sourceFreshness()`: a source is "stale" when it is offline, has never synced, or its last successful sync is older than 15 minutes (`STALE_AFTER_MINUTES`; the code labels this a demo threshold, not a clinical rule). `src/server/queries/worklist.ts` (`loadSourceFreshness()`) applies the same 15-minute rule through its own constant (`FRESHNESS_STALE_AFTER_MIN` in `src/components/worklist/views.ts`) to show a banner and a "data as of" time, which also goes onto printed and downloaded snapshots.
- `src/server/sim/authoritative.ts` and `requestAccession()` (`src/server/domain/accession.ts`): while the simulated accession issuer is offline, a request stays "submitted" and one number is issued on retry.
- Source-entry states for gross records (`src/server/domain/gross.ts`): approval sets **pending entry**; a staff member can attest **entered by staff** (`recordSourceEntry()`); only the simulator can set **acknowledged by source (simulated)** (`simulateSourceAck()`). No lab-side action writes to a source system. The only code that adds messages to the simulated source's outbox is simulator code: the seed, the simulated office (for example, queuing its own amended order ORD-77121 v2) and demo controls such as delivering an older version late. There is no outbound connection to any real system.

**Covering tests.**

| File | Group | Test | Level |
|---|---|---|---|
| `integration.test.ts` | acceptance 13: a source outage marks data stale; restored events reconcile once; no source writes are implied | `while offline nothing is delivered, data is stale and last success is frozen; restore delivers the backlog exactly once` | Domain + read model |
| `integration.test.ts` | acceptance 13: a source outage marks data stale; restored events reconcile once; no source writes are implied | `a connected source whose last successful sync is older than 15 minutes is shown as stale until it syncs` | Read model |
| `integration.test.ts` | acceptance 13: a source outage marks data stale; restored events reconcile once; no source writes are implied | `approving, attesting or completing local work never creates a source write` | Domain |
| `worklist.test.ts` | worklist: source freshness | `an offline source marks the worklist stale with a data-as-of time; restoring the source clears it` | Read model |
| `grossing.test.ts` | S4 grossing: a reviewed gross record that becomes available part by part | `check 13: approval stops at 'source entry pending'; staff attestation is not an acknowledgment; only the simulator acknowledges` | Domain |
| `intake.test.ts` | S1 accession: idempotency, holds, source outage | `keeps a request submitted while the simulated source is offline and issues exactly one number on retry` | Domain |
| `intake.test.ts` | S1 grouping, related-order review and scan (review fixes) | `a related-order decision cannot change while an accession request for its items waits for the offline source` | Domain |
| `worklist.test.ts` | case detail and operations read models | `operations counts come from live records, separate pending source entry from attested-awaiting-acknowledgment, and list blocked work oldest first` | Read model |
| `demo.test.ts` | insights on the seeded synthetic day | `counts a failed source entry as unresolved work, not as done` | Read model |

**Real vs simulated.** Freshness tracking and backlog handling: implemented locally. The outage is a switch on a simulator. Writing gross descriptions into EMA: **unsupported** (staff still do it by hand; the app only tracks it). How the real source behaves during outages: unknown.

**Gaps.**
- The stale banner is tested in the data that feeds it, not on screen.
- The "no source writes" test checks that the integration tables do not grow; the stronger protection is simply that no outbound connection exists.

---

### Check 14. A canceled or amended stain order stays traceable and triggers review of work already printed or prepared

**The check.** If the office cancels a PAS after the slide was already printed or stained, the app must keep that history, flag the material for review, and let a person decide what happens to it. Nothing should be deleted.

**How the app enforces it.**
- `src/server/domain/sourceImport.ts`: when a newer order version removes a stain, the matching work order becomes `cancel_review` if material was printed, prepared, or has a print outcome still unknown; those slides become `canceled_needs_review` (its other, unprepared planned slides are voided); a review task opens; and the worklist records a "canceled" change. If nothing was printed or prepared, the work order is simply canceled and planned slides are voided (kept as records). A queued, never-sent label is withdrawn with an audit record (`print.withdrawn_by_source_change`, also in `sourceImport.ts`). A stain **added** by an amendment creates a new requested work order and a task, without inventing slides. Every order version stays stored (Check 11).
- `src/server/domain/workorder.ts`, `reviewSourceChange()`: the person decides "retain prepared material", "void unprepared" or "keep active". Keeping work the source canceled needs the dermatopathologist and records a new authorization. The review deletes nothing and never releases holds as a side effect.
- `src/server/queries/worklist.ts`: a canceled PAS stops counting as an active PAS but stays visible with a "review needed" flag, including in CSV exports.

**Covering tests.**

| File | Group | Test | Level |
|---|---|---|---|
| `integration.test.ts` | acceptance 14: a canceled stain stays traceable and triggers review of prepared material | `the 11:20 PAS cancellation puts WO-2142 in cancel_review, keeps the prepared PAS slide for review, opens a task and records a worklist change` | Domain |
| `integration.test.ts` | acceptance 14: a canceled stain stays traceable and triggers review of prepared material | `a stain canceled before anything was printed or prepared is simply canceled and its planned slides are voided` | Domain |
| `integration.test.ts` | acceptance 14: a canceled stain stays traceable and triggers review of prepared material | `a stain canceled while its label's print outcome is UNKNOWN (printer timeout) is treated as possibly printed: cancel_review, slide kept for review, task says to reconcile` | Domain |
| `integration.test.ts` | acceptance 14: a canceled stain stays traceable and triggers review of prepared material | `a queued (never sent) label for a canceled stain is withdrawn with an audit record` | Domain |
| `integration.test.ts` | acceptance 14: a canceled stain stays traceable and triggers review of prepared material | `a stain added by an amendment creates a new requested work order (no slide invented) and a histotech task` | Domain |
| `integration.test.ts` | acceptance 14: a canceled stain stays traceable and triggers review of prepared material | `later versions do not repeat a cancellation: no second 'canceled' worklist entry and a closed review is not reopened` | Domain |
| `integration.test.ts` | acceptance 14: a canceled stain stays traceable and triggers review of prepared material | `an order canceled at source never erases prepared material: the case keeps its parts and a review task is opened` | Domain |
| `materials.test.ts` | Acceptance 14 (review side): a canceled stain order stays traceable and its printed/prepared work is reviewed | `the printed PAS slide stays visible, cannot be reprinted, and the review decision is recorded without deleting anything` | Domain |
| `materials.test.ts` | Acceptance 14 (review side) through the real source import; holds and authorization are never changed implicitly | `after the 11:20 amendment the printed PAS slide is kept for review; a review decision closes the importer's task and deletes nothing` | Domain |
| `materials.test.ts` | Acceptance 14 (review side) through the real source import; holds and authorization are never changed implicitly | `the review never releases holds as a side effect, even for a supervisor; it lists them instead` | Domain |
| `materials.test.ts` | Acceptance 14 (review side) through the real source import; holds and authorization are never changed implicitly | `keeping work the source canceled needs the dermatopathologist and records a new authorization` | Domain |
| `materials.test.ts` | Acceptance 14 (review side) through the real source import; holds and authorization are never changed implicitly | `void unprepared work: a planned slide with a printed label is voided (row kept) and its unused label retired with a reason` | Domain |
| `worklist.test.ts` | worklist: PAS canceled at source | `a canceled PAS with prepared material is not an active PAS: no PAS count or tint, a visible review flag, and the case stays open` | Read model |
| `worklist.test.ts` | worklist: PAS shown only from explicit work orders or order lines | `a clinical note mentioning PAS in free text adds no PAS tag; a PAS work order shows its order, material and source` | Read model |
| `materials.test.ts` | Trays: canceled material, consistent eligibility | `a slide whose work is canceled after it was scanned no longer counts, blocks completion and delivery until it is taken off` | Domain + read model |

**Real vs simulated.** Review flow and traceability: implemented locally. Stain orders arrive from the simulated source. How stain orders are really entered, changed and canceled at the lab (and how PAS cases are separated today): unknown.

**Gaps.**
- An "amended" stain (for example, PAS changed to GMS) is handled as one stain removed plus one added. There is no separate "amended stain" review path, even though the command contract mentions an `amended_review` status.

---

### Check 15. AI failure leaves the manual workflow usable; untrusted source text cannot issue tool instructions or alter roles

**The check.** If the drafting or dictation assistant is unavailable, staff must still be able to do everything by hand. Text that comes from outside (order notes, office replies, dictations) must be treated as information only. It must never be able to approve anything, change a role or trigger an action.

**Important context.** The "assistant" in this demo is **not a live AI model**. It is deterministic, rule-based code (`src/server/assist/extractor.ts` for dictations, `src/server/assist/drafter.ts` for clarification wording). Its drafts carry the label "deterministic demo output, not live AI" (checked in a test below). The server code makes no network calls to any AI service.

**How the app enforces it.**
- Assistant failure is simulated with the setting `assistant_mode = "unavailable"`. `assertAssistantAvailable()` (`drafter.ts`) and the dictation loader in `src/server/domain/gross.ts` then return `ASSISTANT_UNAVAILABLE` with a message saying to type the text manually; every other step (send, follow-up, review, resolve, gross entry, approval) does not depend on the assistant.
- `extractor.ts`: sentences that look like instructions (patterns such as "ignore", "approve", "change my role", "you are now") are set aside as `ignoredInstructions`, recorded in the audit log as `assistant.instruction_ignored`, and never used. Nothing the extractor produces is ever "confirmed"; a person must confirm every value (Check 6).
- `drafter.ts`: source text is only ever quoted as data (`quoteValue()` strips markup and caps length), and identity fields (name, date of birth, MRN) are not quoted in drafts (`isIdentityField()`).
- Structural protection: roles and state change only through commands with server-side role checks (Check 12). No code path turns stored text into a command.

**Covering tests.**

| File | Group | Test | Level |
|---|---|---|---|
| `grossing.test.ts` | S4 grossing: a reviewed gross record that becomes available part by part | `check 15: with the assistant unavailable, manual entry and approval still work` | Domain |
| `grossing.test.ts` | S4 grossing: a reviewed gross record that becomes available part by part | `check 15: instruction-like transcript text is data — it changes no state, role, hold or approval` | Domain |
| `clarifications.test.ts` | clarifications: acceptance check 15 (assistant failure and untrusted text) | `with the assistant unavailable, drafting fails clearly and the manual workflow completes end to end` | Domain |
| `clarifications.test.ts` | clarifications: acceptance check 15 (assistant failure and untrusted text) | `an order note and an office answer containing instructions are kept as data and change no role, record or state` | Domain |
| `clarifications.test.ts` | clarifications: drafting keeps patient details out and treats text as data (check 15, stronger) | `an identity-conflict draft quotes no name, date of birth or MRN, and injected evidence text stays quoted data` | Domain |
| `clarifications.test.ts` | clarifications: drafting keeps patient details out and treats text as data (check 15, stronger) | `without a question and with the assistant off, the stored template uses no evidence values and is labeled as a template` | Domain |
| `clarifications.test.ts` | clarifications: answers, delivery records and acknowledgements | `an answer without an acknowledgement does not invent one, and staff text cannot make an answer look simulated` | Domain |
| `worklist.test.ts` | worklist: PAS shown only from explicit work orders or order lines | `a clinical note mentioning PAS in free text adds no PAS tag; a PAS work order shows its order, material and source` | Read model |

**Real vs simulated.** Manual fallback and text-as-data handling: implemented locally. The assistant itself is deterministic demo code; a live AI model is **unsupported**. Any future AI use would need its own review (see `docs/ai-assistants.md`).

**Gaps.**
- "AI failure" is tested only as the assistant being switched off. Slow responses, wrong output or partial output from a real model are not tested, because there is no real model.
- Instruction detection is a short list of text patterns. The tests show the synthetic examples are caught; they do not show that every wording would be. The protection that matters is the structural one: text cannot reach any action.

---

## 5. The rest of §13: browser journey, build/type checks, data-model tests

The master spec also asks to "run the critical browser journey, build/type checks and data-model tests" and to report gaps.

| Item | Status on 2026-10-14 |
|---|---|
| **Critical browser journey** | **Covered (browser).** `tests/e2e/director-journey.spec.ts` runs the eight demo steps on the real screens of a production build (port 3210, its own database `data/e2e.db`), with staff actions done by clicking: courier arrival and routing (checks 1, 3), related orders (2), the part B clarification, scoped hold and hold release after the amended order (4), accession D26-04817 with both source orders kept and a double-click that issues nothing extra (2, 11), grossing part A with explicit confirmation and a second, never-reloaded worklist window that updates live while part B stays incomplete (6, 7), tray and printer (8, 9), retrieval mismatch with last-confirmed location (10) and the operations view. `tests/e2e/demo-step3-presenter.spec.ts` follows the demo script's step 3. `tests/e2e/guards.spec.ts` covers check 12 (Director refused inline with nothing changed; stale save → conflict dialog, colleague's edit kept; hand-made requests from an accessioner refused with 403), check 13 (outage turns an open worklist stale without reload; messages due during the outage are imported exactly once after restore), check 6 (uncertain decimal / missing unit / vague count cannot be confirmed as dictated), check 15 (assistant unavailable → manual entry and approval work; instruction-like dictation changes nothing) and the printed snapshot header (generation time, version, data age). Result on 2026-10-14: **17 passed (32.3 s)**, stable over repeated runs. |
| **Type check** (`npm run typecheck`) and **build** (`npm run build`) | Both run on 2026-10-14: `tsc --noEmit` reported no errors and `next build` compiled all 17 routes successfully. |
| **Data-model tests** | Covered by the "DB rule" tests listed above, mainly in `foundation.test.ts` (renumbering refused, part identity frozen, audit log append-only, same MRN in two practices) and inside the intake, grossing, materials and integration tests. |
| **Avoiding implementation-mirroring tests** | The hero scenario is tested end to end (§4, Checks 2, 4, 7–10), and most test names describe a behavior the spec asks for, not internal code details. |

---

## 6. How to run

You need Node.js 22 or newer, and `npm install` run once in the project folder.

| What you want | Command (run inside the project folder) | Notes |
|---|---|---|
| Run all automated tests | `npm test` | First regenerates the database-schema module (`scripts/gen-schema-module.mjs`), then runs every test in `tests/domain/`. Takes about 20 seconds. |
| See every test name with a check mark | `npx vitest run --reporter=verbose` | This is the command used for §2. It does not regenerate the schema module first. |
| Run one file | `npx vitest run tests/domain/materials.test.ts` | |
| Run tests whose name matches some words | `npx vitest run -t "Acceptance 9"` | Matches group or test names. |
| Type check | `npm run typecheck` | Checks the code for type errors. |
| Type check + all tests | `npm run check` | |
| Production build | `npm run build` | |
| Browser tests | `npm run test:e2e` | Builds a separate production copy (`.next-e2e`, port 3210, database `data/e2e.db`) and runs the 17 Playwright tests, about 30–60 s. First time only: `npx playwright install chromium`. |

**What "passed" looks like:** the last lines show `Test Files 8 passed (8)` and `Tests 247 passed (247)` (the numbers will change as tests are added). Any line with a red ✗ or the word `failed` means a check is broken. Any `skipped` or `todo` means some scenario did not run (see §2).

**Safety:** tests build their own private in-memory database from the seed every time (`tests/helpers.ts`, `openDatabase(":memory:")`). They never read or change the presenter's demo database, and they need no internet connection, accounts or API keys.

---

## 7. What these tests do not prove

Passing tests mean the app follows its own written rules on synthetic data. They do **not** mean any of the following.

- **No clinical validation.** Nothing here shows that the app improves specimen identification, reduces errors, shortens turnaround or is safe for patient care. The master spec says plainly that a demonstration does not prove clinical performance. Published studies on barcoding and voice recognition in other labs [R6][R7][R8] describe those labs' results, not this app's. Real use would need local validation approved by the lab's responsible clinical owners.
- **No real integration.** The source system (EMA-SIM), the second practice (OTHER-EHR-SIM), the accession-number issuer, the notification channel and the office's replies are simulators inside the same local database. No connection to EMA or any other system was made or tested. ModMed describes its pathology product capabilities [R1] and its APIs and HL7 interfaces [R2][R3][R4]; which of these the lab has licensed and enabled is unknown and listed for discovery (`docs/discovery-checklist.md`, `docs/integration-capability-matrix.md`).
- **No hardware, scanner or printer validation.** Printers are simulated states. "Scanning" means typing or pasting a label's text. Barcode symbology, print quality, label stock, scanner reliability and printer drivers are untested. Guidance on specimen handling addresses validating barcode materials and equipment [R5]; that is separate work.
- **No load or performance testing.** Tests use one small synthetic day (about 60 cases, more than 300 slides) in memory on one computer. Many simultaneous users, a network, long-running use, backup and restore, and downtime procedures were not tested.
- **The demo role selector is not authentication.** There is no sign-in, password, account or session security. The role tests show only that the server checks the role of whichever staff member is named. Anyone using the demo can choose any role.
- **No security, privacy or compliance review.** No claim of regulatory compliance is made. The master spec lists deployment dependencies (intended use, data access, hosting, contracts, identity management, auditability, backup/restore, device interfaces, local validation) that require review by the organization's clinical, IT, privacy/security and operational owners. A disclaimer, encryption or role buttons do not make a prototype compliant.
- **No usability or workflow validation.** No usability test with staff is recorded for these screens. The scenarios are modeled on employee observations in the master spec, not on audited findings or measured rates. Workflow assumptions still need to be checked with accessioners, the grosser, technicians and office staff.
- **No time or cost savings.** None of these tests measure minutes, overtime, error rates or money. Any such figures would need the measured pilot described in `docs/pilot-proposal.md`.
- **Same authors, same assumptions.** The tests were written alongside the code. If the code misunderstands a real workflow, the tests may share that misunderstanding.

---

## 8. References

Reference numbers follow the master specification's list; details and caveats are in `docs/research-notes.md`.

- [R1] ModMed, Pathology Lab Reporting Software (official product description).
- [R2] ModMed API Portal, Getting Started (proprietary versus certified API; sandbox and production review).
- [R3] ModMed, HL7 Connectivity (documented interface categories and directions).
- [R4] ModMed API Portal, ServiceRequest (Orders).
- [R5] CAP/NSH, Practical Guide to Specimen Handling in Surgical Pathology, version 12.0, March 2025 (guidance).
- [R6] Achieving High Reliability in Histology: An Improvement Series to Reduce Errors. American Journal of Clinical Pathology, 2016 (single-center improvement study).
- [R7] Weaver et al., Wrong Tissue in Block. American Journal of Clinical Pathology, 2021 (before/after study).
- [R8] Ye, Tan and Shum, voice recognition and grossing efficiency. Archives of Pathology & Laboratory Medicine, 2021.
