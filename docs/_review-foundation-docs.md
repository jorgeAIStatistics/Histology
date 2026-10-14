# Review: Foundation Docs (Completeness Critic)

**Reviewed:** 2026-10-14, against `Histology_Lab_OS_Claude_Master_Prompt.txt` (the source of truth).
**Files read in full:** `product-brief.md`, `workflow-map.md`, `roadmap.md`, `ai-assistants.md`, `discovery-checklist.md`, `research-notes.md`, `integration-capability-matrix.md`, `pilot-proposal.md`, `director-pitch.md`, `data-model.md`, `design-spec.md`. `src/server/db/schema.sql` and `package.json` were spot-checked only where a doc makes a claim about them.
**Scope:** read-only review. No other file was changed.

**Finding types**
- **(a)** A requirement in the master spec that no doc covers
- **(b)** A contradiction between docs (names, IDs, states, routes, storyline)
- **(c)** A claim that overstates evidence, vendor capability, savings, endorsement, compliance or validation
- **(d)** An unknown presented as a fact

**Priorities**
- **P1:** Fix before building the affected screen or recording the demo. Left as is, the demo behaves inconsistently or shows something misleading.
- **P2:** Fix before any document goes to the Director of Operations or medical director: accuracy of claims and gaps against explicit spec requirements.
- **P3:** Consistency polish.

**Overall:** The set is strong. Every one of the 13 discovery questions, all 15 acceptance checks, the three-option comparison, metric definitions, rollout modes, AI boundaries and "do not" rules are covered. I found no real names (lab, employer, medical director), no endorsement claims, no prices and no savings figures. The main problems are (1) a few state models that the docs define differently, especially gross entry into EMA and hold release, (2) a hero storyline that the docs tell in incompatible ways, and (3) missing deliverables: demo script, README and test status.

---

## P1: Fix before building or recording the demo

### P1-1. "Entered in EMA" vs "acknowledged by source" is defined three different ways
- **Type:** (b)
- **Where:**
  - `data-model.md`: §4 F6, §6 SM-16 (`not_sent → pending → acknowledged`; staff attestation moves the record to `acknowledged`), INV-32, Q21.
  - `design-spec.md`: §1 principle 4, §6.4 (status stepper ends at "Source update acknowledged (simulated)"; "Mark entered in source" stays pending "until a simulated acknowledgment arrives"), §6.7 tile "Approved records awaiting source acknowledgment", §7 pill vocabulary, §10 strict words ("Acknowledged" must never be used for a local "marked as entered").
  - `product-brief.md` §4 ("never shown as entered in EMA until the source system acknowledges it").
  - `integration-capability-matrix.md` §3.3 gross-text row and §3.7: Modes A–C have only manual attestation.
  - `research-notes.md` §6 item 5 ("entered in EMA (attested by …)").
  - The actual `schema.sql` (line ~652) already uses `not_started | pending_entry | entered_attested | source_acknowledged | failed`.
- **Problem:** In data-model, staff attestation produces "acknowledged", but design-spec forbids that word for attestation. Product-brief says only the source can confirm entry, while the matrix says no source path exists before Mode D. A builder cannot satisfy all of these at once, and this is the rule the spec stresses most: "never show a pending local draft as successfully entered into EMA".
- **Fix:** Adopt the schema's states in every doc, with one display label each:
  - **Pending entry**
  - **Entered by staff (attested: who, when)**
  - **Acknowledged by source (simulated)**, possible only from a simulator event in Mode A or a supported interface in Mode D
  - **Failed**

  Then:
  - Update SM-16, the design-spec stepper, pills and the operations tile ("awaiting entry" vs "attested, awaiting source acknowledgment").
  - Change product-brief §4 to: "never shown as entered until a named person attests it or the source acknowledges it; the two are displayed differently."
  - State in the demo script whether EMA-SIM sends an acknowledgment in the demo.

### P1-2. Hold release is tied to clarification resolution in the design, but kept separate in the data model
- **Type:** (b)
- **Where:**
  - `design-spec.md`: §7 Hold banner ("released only by resolving the clarification"), §6.2 Resolve action ("shows which hold will be released"), §10 confirmation pattern ("Release hold on Part B? This resolves CLR-0457…").
  - `data-model.md`: SM-7 (`reviewed → resolved`: "none is released automatically"), SM-8, INV-16, §11 step 3 (Kim releases the hold as its own step).
- **Problem:** The design makes resolving the clarification and releasing the hold one action. The data model forbids that. The design also leaves out SUP override release and cancelling a hold placed in error.
- **Fix:** In design-spec, make **Resolve clarification** and **Release hold** separate, audited actions. They can be offered one after the other in the same dialog, but each needs its own confirmation and reason. Change the Hold banner text to "Released only by an authorized person with a reason". Add the cancel-in-error and supervisor-override paths.

### P1-3. The hero storyline disagrees on whether Part B is still on hold when Part A is grossed
- **Type:** (b)
- **Where:**
  - `data-model.md` §11: step 3 resolves CLR-0457 and releases the Part B hold before accession (step 4). At step 5, Part B is just "received, documentation none".
  - `design-spec.md`: §5.3 identity bar ("Hold: Part B"), §6.3 worklist parts ("A ready, B hold"), §6.4 parts strip ("Part B: On hold (CLR-0457)") and "Incomplete: on hold".
  - `pilot-proposal.md` §3, `product-brief.md` §6.3 and `director-pitch.md` §3 are ambiguous.
- **Problem:** The person recording the demo will get different screens depending on which doc they follow. The master spec only requires that the answer be reviewed before resolution (step 3) and that Part B stay visibly incomplete (step 5).
- **Fix:** Choose one storyline and write it into the demo script, then align data-model §11 and design-spec §5.3, §6.3 and §6.4. Suggested version, which uses only rules both docs already have:
  - CLR-0457 is answered, reviewed and **resolved** in step 3.
  - The Part B hold stays active "until amended ORD-77121 is received" (data-model Q11 already opens this follow-up task).
  - At step 5, Part B shows "Incomplete: not grossed · Hold: awaiting amended order".

  If the team prefers to release the hold at step 3, remove every "On hold (CLR-0457)" example from design-spec §6.3 and §6.4.

### P1-4. Materials and retrieval examples use hero-case material that cannot exist yet
- **Type:** (b), and (d) because it shows invented history as fact
- **Where:**
  - `design-spec.md` §6.5:
    - Tab 3: RR-0192 requests block **D26-04817 A1**, last confirmed "Cabinet B… 2026-10-09 15:12 ET by Marcus Lee".
    - Tab 2: tray missing "D26-04817 A1-3".
    - Tab 1: label preview.
  - Also `design-spec.md` §6.0 (partial-success example with "D26-04817 A1-2 PAS"), §6.3 ("PAS canceled after slide D26-04817 A1-2 PAS was printed") and §7 scan result line.
  - Compare `data-model.md` §11 step 5: A1 has only just become eligible for processing.
- **Problem:** D26-04817 is accessioned on the demo day, 2026-10-14. Its block cannot have been filed on 2026-10-09, and its slides cannot be missing from a tray at 11:xx. A director following "one multipart case" would see this.
- **Fix:** Use a seeded **prior-day** synthetic case (any earlier D26 number) for TRY-M-03, PJ-8841, RR-0192 and the PAS-cancel and partial-success examples. Use D26-04817 only for steps 1–5. Say this in the demo script ("Steps 6–7 use an earlier case"). The label-preview example can stay because it is only a format illustration.

### P1-5. Required deliverables are missing
- **Type:** (a)
- **Where:** Master spec §12 (speaker notes, known expected outcomes) and §16 (README, local setup/reset commands, demo script, implementation/test status, progress checkpoint). `design-spec.md` §6.10 describes a Speaker notes tab but contains no notes. `product-brief.md` §6.4 points to "implementation and test status notes" that do not exist. There is no README at the repository root.
- **Problem:** These files may still be in progress by other agents. As of this review, none exists in `docs/` or at the root.
- **Fix:** Add three files.
  - **`docs/demo-script.md`** with:
    - the 8 steps, each with route, demo-clock time, role, exact clicks, what to notice, and what is simulated vs working;
    - speaker notes;
    - the seeded "known expected outcomes" (data-model J3);
    - a closing "what a real deployment would require" panel (spec §3 success criterion).
  - **`README.md`**: `npm run dev` (port 3100), `npm run db:reset`, `npm test`, `npm run test:e2e`, Node ≥ 22, and a plain-English glossary.
  - **`docs/implementation-status.md`**: working, simulated, not implemented and tested, with exact test names, plus a progress checkpoint.

### P1-6. data-model.md has not been reconciled with the real schema, and the UI wording depends on it
- **Type:** (b)
- **Where:** `data-model.md` header (it says it "did not use the SQL schema") and §10 checklist; `design-spec.md` §7 "State vocabulary for pills"; `src/server/db/schema.sql`.
- **Problem:** Spot-check of `schema.sql` vs `data-model.md`:

  | Area | data-model.md | schema.sql |
  |---|---|---|
  | Intake states | `verified`, `voided` | `ready_for_accession`, `canceled` |
  | Related-order states | `proposed`, `confirmed_same_case`, `needs_clarification`, … | `pending_review`, `single_accession_approved`, `escalated_to_office`, … |
  | Tray states | `in_progress`, `closed_incomplete` | `assembling`, `released_with_exceptions` |
  | Hold states | includes `canceled` and `superseded` | only `active` and `released` |
  | Print purposes | includes `additional_work` | only reprint variants, no `additional_work` |

  The spec requires distinguishing "reprinting a damaged label from ordering an additional slide" (§8, acceptance check 8).
- **Fix:** Run data-model §10 against `schema.sql` and record each difference as "adopt schema" or "fix schema". Then regenerate the design-spec §7 pill vocabulary from the final value lists so the UI wording matches stored states. Specifically: add an additional-work purpose (or equivalent) to `print_job`, and decide whether holds can be canceled or superseded. (The schema is outside this review's scope. It is listed here because the docs depend on it.)

---

## P2: Fix before the documents go to the directors

### P2-1. Three different vocabularies for integration capabilities, and no data model for them
- **Type:** (b), (a)
- **Where:**
  - `integration-capability-matrix.md` §4.1: per-capability statuses `simulated · documented-unverified · verified · unsupported · unknown`, each with evidence, verifiedBy, verifiedAt and mode.
  - `design-spec.md` §6.9: per-connector cards with "Implemented (demo) · Simulated · Unsupported · Unknown".
  - `data-model.md` §4 I1: `connector.mode` is `simulated · disabled · configured`, and there is no capability entity. The schema stores a JSON `capabilities` field.
- **Problem:** The spec asks for "capability discovery" and a precise split between implemented, simulated, unsupported and unknown. "Implemented (demo)" on a connector card could be read as a working integration.
- **Fix:** Use the matrix's five statuses everywhere. Show **one row per capability** (from matrix §3) on Settings → Integration capabilities. Drop "Implemented (demo)" for connectors. Document the JSON shape, or add a `connector_capability` entity, in data-model.

### P2-2. ModMed is misquoted ("in many cases" in quotation marks)
- **Type:** (c)
- **Where:** `pilot-proposal.md` §4 Option 1 (quoted), `product-brief.md` §5 Configure row, `discovery-checklist.md` 1.1, and `director-pitch.md` §4 item 1 (qualifier dropped). `research-notes.md` (R1 notes and §5 item 1) says the source reads "in most cases" and asks for the source wording. `integration-capability-matrix.md` already uses "most".
- **Fix:** Use "in most cases" and attribute it as ModMed's own FAQ claim, or paraphrase without quotation marks. Make all five docs match.

### P2-3. The UPMC study (R9) is described more broadly than it was
- **Type:** (c)
- **Where:** `product-brief.md` §2.3 and `pilot-proposal.md` §2 "Published context". Compare `research-notes.md` R9 notes and §5 item 5.
- **Problem:** The docs say it "documented manual work, communication and organizational burdens and stressed integration with the pathology information system". The study observed **six pathologists** in a digital-pathology design context. Its integration conclusion concerned **digital slide systems** integrating with the AP LIS.
- **Fix:** "A 2012 UPMC contextual-inquiry study of six pathologists found anatomic pathology workflow labor-intensive and concluded that a digital slide system should integrate with the AP information system. Its subjects were pathologists, not histology staff; the transferable lesson is to observe real work before designing screens."

### P2-4. "No clear owner" is presented as observed
- **Type:** (d)
- **Where:** `product-brief.md` §2.2, `pilot-proposal.md` §1 ("What I have observed… questions to offices wait without a clear owner or follow-up"), `director-pitch.md` §1 bullet 3.
- **Problem:** The spec records only that replies can be delayed, for an unknown reason (unsupported, disabled, ignored or misdirected notifications). Missing ownership is a hypothesis.
- **Fix:** "Replies to office clarification messages can be delayed; we don't yet know why. Unclear follow-up ownership is one hypothesis to check."

### P2-5. Doctor colors are said to copy the real "bible"
- **Type:** (d)
- **Where:** `design-spec.md` §2 ("teal, violet and amber, carried over from the paper 'bible' page colors") and §6.3 group header ("helps staff move from colored paper pages").
- **Problem:** The spec says only that pages are colored per doctor. The real colors are unknown, and `discovery-checklist.md` 4.5 treats them as a question.
- **Fix:** "Fictional demo colors. Whether to match the real page colors is a discovery question (4.5)."

### P2-6. Unsupported statements in the pilot proposal's observation table and options
- **Type:** (d), (c)
- **Where:** `pilot-proposal.md` §2 table and §4 Option 2 Pros.
  - **O2:** "No written rule or effective date is visible at the bench." This observation is not in the spec.
  - **O3:** "Each question becomes a clarification and a held specimen." How often this happens is unknown.
  - **Option 2:** "Mature products" is an unverified vendor-quality claim. research-notes says the vendor pages give no outcome data.
- **Fix:**
  - O2: "I have not seen a written rule at the bench; whether one exists is unknown". Have Jorge confirm the wording.
  - O3: "A question may require a clarification and may hold the specimen; frequency unknown."
  - Option 2: "Commercially available products with vendor support (per vendor descriptions); maturity, validation status and other labs' experience must be checked through references."

### P2-7. Integration matrix cites API fields that research-notes does not record
- **Type:** (c)
- **Where:**
  - `integration-capability-matrix.md` §3.1: `occurrenceDateTime` [R4, S5]; `authoredOn` [R4]; "Patient… read/search/create/update in PROP-API [S12]", where S12 is only the portal index.
  - §3.3: "PractitionerRole and CareTeam are readable [S6]".
  - None of these appears in the `research-notes.md` R4 field table or the S5/S6 summaries.
- **Fix:** Check each field against the cited page and add it to research-notes, or mark it "to verify". Cite the specific Patient page instead of the index. Vendor capability claims must trace to a recorded source.

### P2-8. No editable scenario calculator
- **Type:** (a)
- **Where:** Spec §14. `pilot-proposal.md` §8 gives a Markdown worksheet. `design-spec.md` §6.8 says the calculator "is separate".
- **Fix:** Provide an actual editable calculator: a CSV/XLSX template, or a small page with blank inputs B, P, V, A, N, D, R and C. It should:
  - compute each activity separately and give a low/central/high range;
  - show the inputs next to each result;
  - label results "Potential labor value, not cash";
  - never prefill numbers except clearly labeled illustrative ones.

### P2-9. DataMatrix encode/decode validation is not specified
- **Type:** (a)
- **Where:** Spec §8 ("Validate demonstration encoding/decoding"); `data-model.md` §2.8 (payload format) and §9 (no test row); `design-spec.md` §6.5 and §7 (bwip-js renders only and cannot decode).
- **Fix:** Add a test row:
  - The payload round-trips: build → parse → same identity, including namespace and `DEMO` marker.
  - A malformed or non-DEMO payload is rejected.
  - The rendered DataMatrix is either decoded with a dev-only decoder, or the test status says plainly that image-level decoding is not tested.

  Never claim scanner validation.

### P2-10. No screen for the office contact and coverage directory
- **Type:** (a)
- **Where:** Spec §6 ("configurable office contact/coverage directory, working hours, escalation owner, reminders and duplicate suppression"). `data-model.md` A5 models it. `design-spec.md` §6.9 Settings has no such tab.
- **Fix:** Add Settings → **Office contacts**: contact role, channel (simulated), working hours, backup, escalation owner, reminder interval and duplicate-suppression window. Use fictional entries labeled simulated, with changes audited.

### P2-11. Demo-scenario switches don't cover acceptance checks 11, 13 and 14
- **Type:** (a), (b)
- **Where:** `integration-capability-matrix.md` §4.2 lists 9 switches: normal, slow, outage, 429, duplicate delivery, out-of-order, amended after review, cancelled after printing, partial page failure. `design-spec.md` §6.9 offers only 4 fault injections. Compare `data-model.md` §9 rows 11, 13, 14.
- **Fix:** Add the missing switches to Settings → Demo scenarios, each labeled "demo control". Otherwise, state in both docs that they are test-only fixtures and will not be shown live.

### P2-12. Data-freshness wording differs, and the matrix uses "Live"
- **Type:** (b)
- **Where:**
  - `integration-capability-matrix.md` §6 rule 11 (`ok-changes · ok-no-changes · unavailable`) and rule 12 (display "Live / Delayed / Stale / Source unavailable since … / Simulated").
  - `data-model.md` I1 (`healthy · degraded · offline · unknown`) and I2 (`ok_with_events · ok_no_events · failed · timeout`).
  - `design-spec.md` §5.1 ("Current/Synced, Delayed, Offline, Unknown"), §7 pills, §10 (avoid "Live").
- **Fix:** Use one display set everywhere: Synced / Delayed / Offline / Unknown, plus a Simulated tag. Remove "Live" from matrix rule 12. Write down the mapping from poll results to display states. 429, timeout and partial pages all mean "source unavailable", and the cursor does not advance.

### P2-13. Courier manifest: the assumption contradicts the seeded examples
- **Type:** (b), (d)
- **Where:**
  - `product-brief.md` §9 assumption 7 ("No courier manifest… exists").
  - `discovery-checklist.md` 2.4 (simulated manifest, unknown when absent).
  - `data-model.md` Q6 ("Mixed") and §11 step 1 ("Harbor Point manifest expects 2 containers").
  - `design-spec.md` §6.1 ("Harbor Point Dermatology: expected 6, received 5, missing 1").
- **Fix:**
  - Product-brief: "The demo seeds a mix (some offices send a simulated manifest, others none, shown as 'expected: unknown'). Whether real manifests exist is unknown (O1)."
  - Use one Harbor Point count in all examples. If the hero office shows "missing 1", make sure it is not the hero case unless intended.

### P2-14. Hero timeline and cast: times before the courier, and different people for the same step
- **Type:** (b)
- **Where:**
  - `design-spec.md` §6.6 ("Linked as related by Kim Nguyen, 10:56 ET"), §6.0 ("Kim Nguyen saved changes to INT-1014-031 at 10:58 ET", "Already requested at 10:57 ET").
  - `data-model.md` §11: arrival about 11:00 creates INT-1014-031; **Maya Torres** confirms the candidate. §9 row 12: concurrent edit is Maya vs **Luis**.
  - `design-spec.md` §6.1: presence note shows Luis.
- **Fix:** In the demo script, fix one cast and time per step. For example: Maya reviews and links after 11:00; Luis is the concurrent editor; Kim reviews the CLR-0457 answer and decides on the hold; Dana grosses; Sam enters into EMA. Re-time the design-spec examples to after 11:00.

### P2-15. The tray screen offers "reprint" as a fix for a missing slide
- **Type:** (b)
- **Where:** `design-spec.md` §6.5 Tab 2 "Completion" ("…or reprint (linked to Print jobs)"). Compare spec §8 and `data-model.md` SM-17 and SM-19.
- **Problem:** A label reprint does not supply a missing slide. The spec requires keeping reprints and additional slides distinct.
- **Fix:** Offer these options instead:
  - remove the unexpected slide;
  - mark the missing slide "to follow" (data-model `deferred`) with an owner and reason;
  - reprint the label only for a slide that is **present** but unreadable;
  - close as incomplete with reasons (`closed_incomplete`).

  A new slide is created only through an authorized work order.

### P2-16. Printer unknown-outcome reconciliation choices don't match the states
- **Type:** (b)
- **Where:** `design-spec.md` §6.5 Tab 1 ("Label printed / Not printed / Can't tell (escalate)"; the state list has no partial outcome). `data-model.md` SM-17 (`partially_completed`, per-label outcomes). The schema's reconciliation values are `printed_ok | not_printed | printed_damaged`.
- **Fix:** Use per-label outcomes: Printed OK / Printed damaged / Not printed / Can't tell. "Can't tell" keeps the job in unknown outcome and opens an escalation task. Include a partially-completed job state in both docs, or drop it from both.

### P2-17. Design-spec stack and file paths don't match the repository
- **Type:** (b)
- **Where:**
  - `design-spec.md` header ("Tokens go in `app/globals.css`").
  - Paths `app/fonts.ts` (§4), `lib/tokens.ts` (§3.2), `components/icons.tsx` (§7).
  - Open issues 1 and 3 ("no icon library", "shadcn/ui and Radix are not in the stack").
  - The repo uses a `src/` prefix, and `package.json` already includes `lucide-react` 0.577.0, `radix-ui` 1.8.1, `clsx` and `tailwind-merge`.
- **Fix:** Change the paths to `src/…`. Update Open issues 1 and 3 to the actual dependencies, or remove the dependencies. Make the shared stack list match.

---

## P3: Consistency polish

| # | Type | Where | Problem | Suggested fix |
|---|---|---|---|---|
| P3-1 | (b) | `design-spec.md` §6.3 view tabs vs `data-model.md` I8 | Design has a "Source entry" view; the data-model view list has only accessioning, grossing, histotech and operations, so acknowledgments can't be stored for it. | Add `source_entry` to the I8 list, or fold it into the Grossing view. |
| P3-2 | (b) | `design-spec.md` §6.2 actions vs `data-model.md` SM-7 | Design lets staff "Mark delivered or failed"; data-model lets only the adapter (SYS) set delivery outcomes. | Label it a demo control ("Demo: simulate connector outcome"), or add staff-recorded outcomes with their own provenance. |
| P3-3 | (b) | `ai-assistants.md` §3 and intro; `data-model.md` I6 and SM-24; `design-spec.md` §6.2 and §10 | AI proposal states differ (`partly reviewed`/`superseded` vs `edited_accepted`/`expired`). Provider IDs differ (`demo-deterministic` vs `deterministic_demo`). Three different "not live AI" label strings. | Pick one state set and one label string per assistant; list them in design-spec §10. |
| P3-4 | (b) | `ai-assistants.md` A1 Owner and Review vs `data-model.md` §3; `design-spec.md` §6.1 | AI doc says the histology assistant may review grossing field proposals; data-model gives HA narrative edits only. Design says routing override is "lead only"; data-model allows LEAD and SUP. | Align with the data-model permission matrix, or update the matrix. |
| P3-5 | (b) | `data-model.md` §2.1 vs `design-spec.md` §6.6 | `id` is opaque and "never shown", but the design copy ("No case D26-04899") implies the URL uses the accession number. | State what `/cases/[id]` takes, e.g. the accession number resolved within its namespace. |
| P3-6 | (b) | `data-model.md` R-10 and Q15; `design-spec.md` §6.3 and §7; `discovery-checklist.md` 8.1 | WO-2213's target level (block vs slide A1-2) and origin (order line vs protocol) are not consistent. | Fix one: e.g. WO-2213 targets block A1, plans slide A1-2 PAS, and comes from ORD-77120 line 1. Use it everywhere. |
| P3-7 | (a) | Spec §8; `data-model.md` H1 and SM-20 | Conflicting location records appear in the design (§6.5) but data-model has no rule for them (it just takes the latest observation). | Add a rule: disagreeing location or custody events open an investigation, both are shown, and nothing is auto-resolved. |
| P3-8 | (b) | `workflow-map.md` §2 after-map | Routing (RT1) is drawn after clarification resolution, which suggests the whole item waits; data-model computes routing at receipt. | Draw routing in parallel, right after intake. |
| P3-9 | (b) | `design-spec.md` §6.1 action 3 vs `data-model.md` SM-5 | "Escalate to lead" has no matching state. The office-question path (`needs_clarification`) has no button. "Confirmed same case" reads like an identity decision. | Buttons: "Link as related (both orders kept)", "Keep separate", "Ask office (creates clarification)". Escalation is a reassignment, not a state. |
| P3-10 | (b) | `product-brief.md` §6.1 flow 3 | The clarification state list omits delivered, delivery failed and acknowledged. | List the full set as in data-model SM-7. |
| P3-11 | (d), (c) | `product-brief.md` §9 #16; `integration-capability-matrix.md` §3.2 cassette row; `director-pitch.md` §1 and §4 | "Common behavior of networked printers" is unsupported. "R5 requires" overstates a guidance document. The pitch drops the R1 qualifier and says "end-of-day batch" (the observation is "waiting for the batch"). | #16: "assumed so the demo handles the worst case; real reporting unknown (discovery 6.3)". Matrix: "R5 recommends". Pitch: "in most cases, per ModMed's page" and "waiting for the batch". |
| P3-12 | (b) | `pilot-proposal.md` §2 and §13 | O1 is missing from the table (IDs are said to match product-brief). Figures are cited "as summarized in the project brief", although research-notes now has checked details. §13 omits the matrix, research notes, workflow map, roadmap and AI docs. | Add an O1 row, cite `research-notes.md` for figures, and complete the cross-links. |
| P3-13 | (a) | Spec §11 (verify docs and versions before adding dependencies) | No doc records which versions were checked, when, against which official sources, or why the extra UI dependencies were added. | Add a short "Stack and dependency check" section to the README or implementation status. |

---

## Coverage check (spec sections with no gap beyond those listed above)

| Spec section | Covered by |
|---|---|
| §1 observations as employee observations; fictional names; no endorsement | product-brief §2.1, pilot-proposal header, director-pitch header (no real lab, employer or director names found) |
| §2 configure, then buy, then build; vendor categories; no "first" claims | product-brief §5, pilot-proposal §4, research-notes |
| §4 entities, original vs working values, unknown ≠ zero, never merge | data-model §2–§8 |
| §5 intake, routing, related orders, concurrency, idempotency | data-model SM-1 to SM-6, design-spec §6.1 |
| §6 clarification states, generic notifications, office agreement | data-model SM-7, ai-assistants A2, workflow-map H4 (directory UI gap: P2-10) |
| §7 worklist and grossing handoff | data-model R-10, SM-15; design-spec §6.3, §6.4 |
| §8 print, tray, retrieval | data-model SM-17 to SM-20; design-spec §6.5 (see P2-9, P2-15, P2-16) |
| §9 AI boundaries | ai-assistants |
| §10 matrix, rollout modes, sync rules, "do not" list | integration-capability-matrix, research-notes |
| §11 design rules, routes, states, skill disclosure | design-spec |
| §12 seed, demo clock, 8-step narrative, before/after map | design-spec §6.10, workflow-map (script, notes and expected outcomes: P1-5) |
| §13 acceptance checks | data-model §9 |
| §14 metrics, value buckets, deployment dependencies | pilot-proposal §6–§9 (calculator: P2-8) |
| §15 secondary opportunities; discovery questions | roadmap, discovery-checklist (all 13 spec questions present) |

---

## Limits of this review

- Web sources were **not** re-fetched. The figures in `research-notes.md` were not independently re-verified: R6 per-period counts and the 44%/24% root causes, R7 counts, S2–S11 details such as rate limits and sandbox timing, and the R6 author attribution "Heher et al." (the master spec names no author). A person should recheck them before external use, as research-notes itself says for R1 and R3.
- `schema.sql` was only spot-checked for state names (P1-1, P1-6). The full data-model §10 comparison still needs to be done.
- Other agents may still be writing files in `docs/`. P1-5 reflects the folder as it stood during this review.
