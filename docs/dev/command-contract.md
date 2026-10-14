# Build contract: commands, ownership and storyline (internal, for builders)

This file coordinates the parallel build. Every state change goes through a **command** registered with
`defineCommand()` (see `src/server/commands/registry.ts`). The UI calls commands through the client helper
(`src/lib/client/`), tests call them through `tests/helpers.ts`, and slices call *each other* only through
command names (`mustRun(db, actorId, "name", input, { origin })`) or through the shared domain modules listed
below. Never import another slice's private files.

## Shared foundation (read-only for slice builders unless noted)

| Module | What it gives you |
|---|---|
| `src/server/db/schema.sql` | Core schema (owner: build lead). **Need a new table/column?** Create `src/server/db/schema.<slice>.sql` (additive only: `CREATE TABLE`, `CREATE INDEX`, `CREATE TRIGGER`; `ALTER TABLE ... ADD COLUMN` is allowed) and run `node scripts/gen-schema-module.mjs`. Never edit `schema.sql` or another slice's schema file. |
| `src/server/core/*` | `Ctx`, `requirePermission`, `audit()`, `updateVersioned()` (optimistic concurrency → CONFLICT), `openTask/closeTasks`, `recordWorklistChange`, clock (`demoNow`, `advanceClockTo`), ids (`newId`, `displayId`), settings, `DomainError` |
| `src/server/domain/holds.ts` | Scoped holds: `placeHold`, `releaseHold`, `assertNotHeld(db, transition, scopes, what)`, `scopesForPart/Block/Slide/Intake` |
| `src/server/domain/readiness.ts` | `computeReadiness(db, accessionIds)` / `caseReadiness` — derived stage, eligible work, blockers, PAS, holds per part |
| `src/lib/*` | `roles.ts` (permission matrix), `domain.ts` (state labels), `gross.ts` (gross field model + `grossFinalizeBlockers`), `identifiers.ts` (label payload encode/decode), `time.ts` (ET formatting) |
| `src/server/seed/*` | Reproducible synthetic day. Read `scenario.ts` to see the scripted demo data. Do not edit (report needed seed changes instead). |
| `src/components/**`, `src/lib/client/**` | UI library + client helpers (see `src/components/README.md`). Do not edit; compose. If something is missing, build it inside your own `src/components/<slice>/` folder. |
| `tests/helpers.ts` | `testDb()` (in-memory, seeded, clock paused 10:52 ET), `run`, `must`, `clockAt`, `tick`, `one`, `all`, `STAFF` |

Every command must: validate input with zod; rely on `permission` (server-side role check) and call
`requirePermission` for extra checks; use `updateVersioned` with the client's `expectedVersion` on any
user-edited row; write `audit()` events with plain-language summaries; call `recordWorklistChange` whenever the
digital worklist would change; use `openTask/closeTasks` for "who owns the next step"; be idempotent where the spec
requires (imports, prints, clarification sends, accession requests); throw `DomainError` with a helpful message.

## Ownership (one writer per file)

| Slice | Owns |
|---|---|
| S1 Intake & accession | `src/server/commands/intake.ts`, `src/server/domain/{intake,routing,related,accession,correction}.ts`, `src/server/sim/{courier,authoritative}.ts`, `src/server/queries/intake.ts`, `src/app/intake/**`, `src/components/intake/**`, `tests/domain/intake.test.ts` |
| S2 Clarifications | `src/server/commands/clarifications.ts`, `src/server/domain/clarification.ts`, `src/server/sim/{notifications,office}.ts`, `src/server/assist/drafter.ts`, `src/server/queries/clarifications.ts`, `src/app/clarifications/**`, `src/components/clarifications/**`, `tests/domain/clarifications.test.ts` |
| S3 Worklist, case, operations | `src/server/commands/worklist.ts`, `src/server/queries/{worklist,case,operations}.ts`, `src/app/worklist/**`, `src/app/cases/**`, `src/app/operations/**`, `src/app/api/worklist/**`, `src/components/{worklist,case,operations}/**`, `tests/domain/worklist.test.ts` |
| S4 Grossing | `src/server/commands/grossing.ts`, `src/server/domain/gross.ts`, `src/server/assist/extractor.ts`, `src/server/seed/fixtures/transcripts.ts` (new file, allowed), `src/server/queries/grossing.ts`, `src/app/grossing/**`, `src/components/grossing/**`, `tests/domain/grossing.test.ts` |
| S5 Materials | `src/server/commands/materials.ts`, `src/server/domain/{print,labels,tray,retrieval,material,workorder}.ts`, `src/server/sim/printer.ts`, `src/server/queries/materials.ts`, `src/app/materials/**`, `src/components/materials/**`, `tests/domain/materials.test.ts` |
| S6 Integration & settings | `src/server/commands/admin.ts`, `src/server/domain/{sourceImport,routingRules}.ts`, `src/server/sim/pump.ts`, `src/server/queries/settings.ts`, `src/app/settings/**`, `src/app/api/demo/**`, `src/components/settings/**`, `tests/domain/integration.test.ts` |
| S7 Insights & guided demo | `src/server/commands/demo.ts`, `src/server/domain/demoSteps.ts`, `src/server/queries/insights.ts`, `src/app/insights/**`, `src/app/demo/**`, `src/components/{insights,demo}/**`, `tests/domain/demo.test.ts` |

## Command names and inputs (the contract)

`expectedVersion` = the `version` the user saw. All ids are internal row ids unless noted.

### S1 Intake & accession
- `intake.receiveDelivery {deliveryId}` — courier arrival: `arrived_at`, `received_by`, status `reconciling`. Idempotent.
- `intake.receivePhysicalItem {deliveryId, physicalItemId? , orderRef?}` — simulated unpack/scan of one requisition + its containers from `sim_physical_item`; creates intake item (`displayId(db,"INT-1014",3)`), containers (observed labels as typed observations), links the order **within the office's tenant**, computes routing suggestion (or exception), runs related-order detection, checks expected containers per order part (missing → flagged). Idempotent: an already received item returns the existing intake item.
- `intake.receiveAll {deliveryId}` — demo convenience: receives every not-yet-received physical item.
- `intake.recordObservation {containerId, expectedVersion, observed}` — staff edits typed observations.
- `intake.verifyContainer {containerId, expectedVersion, orderPartId}` — "Staff verified against physical container" (records who/when). Compares observed vs order part; differences → `verification_state = 'discrepancy'` with evidence returned (UI then offers "Raise clarification").
- `intake.updateItem {intakeItemId, expectedVersion, patch}` — generic edit (owner, notes) used to demonstrate stale-update detection.
- `routing.confirm {intakeItemId}` · `routing.override {intakeItemId, pathologistId, reason}` (lead) · `routing.resolveException {intakeItemId, pathologistId, reason}` (lead; unknown office).
- `related.review {candidateId, expectedVersion, decision, reason}` — decisions: `single_accession_approved` | `keep_separate` | `not_related` | `escalated_to_office` (lead/supervisor). Never merges orders or patients.
- `accession.request {intakeItemIds, relatedCandidateId?}` — preconditions: every container staff-verified or its discrepancy covered by an open clarification; routing confirmed/overridden; any pending related candidate reviewed; no hold blocking `accession_request`. Calls the authoritative simulator (`src/server/sim/authoritative.ts`), which issues the next number (`nextSeq(db,"accession_number")` → `D26-0xxxx`) unless the source is offline (`SOURCE_OFFLINE`, request stays `submitted`, retry later). Creates accession + parts (original designations kept; collisions get next free letter with `original_designation` retained), links intake items, moves holds/tasks/clarifications to the accession (`accession_id`), records worklist change `new`. Idempotent per set of intake items.
- `correction.open {accessionId, kind, description, relatedAccessionId?}` — post-accession discrepancy → `correction_review` with snapshot of original references. Never renumbers/merges/relabels. `correction.close {correctionId, outcome, note}`.

### S2 Clarifications
- `clarification.create {category, refs:{intakeItemId?,sourceOrderId?,orderPartId?,containerId?,accessionId?,specimenPartId?}, subjectLabel, question, evidence[], priority, hold?:{scope:{type,id}, scopeLabel, blocks[]}}` → `{clarificationId, displayId, duplicate}`. Dedupe on open (category + subject). Picks contact from the directory with coverage (primary unless `out_until` > now → backup) and sets `next_follow_up_at` by priority within office hours.
- `clarification.draftMessage {clarificationId}` → deterministic drafter text (no patient identifiers; generic "please open the secure case view"); `ASSISTANT_UNAVAILABLE` when assistant mode is `unavailable` (manual text still works).
- `clarification.send {clarificationId, expectedVersion, body}` — SIMULATED notification; outcome from the notification simulator (`delivered` / `delivery_unknown` / `delivery_failed`). Message log idempotent.
- `clarification.recordDelivery {clarificationId, outcome}` · `clarification.recordAck {clarificationId}` · `clarification.recordAnswer {clarificationId, answerText, answeredBy, channel}`
- `clarification.simulateOfficeAnswer {clarificationId}` — demo only. For the hero (ORD-77121 laterality) the scripted answer is: bottle is correct (LEFT), office will amend the order; it ALSO inserts the amended order `ORD-77121#v2` (laterality left, site "Left dorsal forearm") into `sim_source_outbox` available 1 minute later.
- `clarification.review {clarificationId, expectedVersion, note}` — lead/supervisor; requires `answered`.
- `clarification.resolve {clarificationId, expectedVersion, resolutionCode, note, releaseHoldIds?: string[], releaseReason?}` — lead/supervisor; requires `reviewed`. Releasing holds is optional and recorded as SEPARATE audited hold releases (`releaseHold`). An answer never resolves a clarification by itself.
- `clarification.followUp {clarificationId}` (reminder; suppressed if one was sent < 30 min ago) · `clarification.escalate {clarificationId}` · `clarification.cancel {clarificationId, reason}`
- `hold.release {holdId, expectedVersion, reason}` (lead/supervisor) · `hold.place {...}` (manual hold).

### S3 Worklist / case / operations
- `worklist.ack {view, seq}` · `worklist.snapshot {view, filters, format: "print"|"csv"}` → `{snapshotId, displayId, seq, generatedAt}` · `worklist.saveFilter {view, name, filters}` · `worklist.deleteFilter {filterId}` · `task.claim {taskId, expectedVersion}` · `task.release {taskId}`

### S4 Grossing
- `gross.startDraft {specimenPartId}` → current record (creates v1 draft with template by procedure if none). Blocked if a hold blocks `gross_approval`? No — drafting is allowed; **approval** is gated.
- `gross.loadTranscript {specimenPartId, transcriptKey}` — attaches a synthetic dictation fixture and runs the deterministic extractor: values become `proposed` / `needs_review` / `missing` with evidence spans. `ASSISTANT_UNAVAILABLE` leaves manual entry working.
- `gross.updateFields {grossRecordId, expectedVersion, patch, narrative?}` · `gross.confirmField {grossRecordId, expectedVersion, field, value}`
- `gross.markReviewed {grossRecordId, expectedVersion}` → `operator_reviewed`
- `gross.approve {grossRecordId, expectedVersion}` → `approved_for_downstream` only if `grossFinalizeBlockers` is empty and no hold blocks `gross_approval`. Creates blocks for allocated cassettes if missing (`cassette_loaded`), sets part `physical_state = 'grossed'`, `source_update_state = 'pending_entry'`, opens tasks `source_entry` (owner Sam Ortiz) and `processing_eligible`, records worklist change.
- `gross.recordSourceEntry {grossRecordId, expectedVersion}` → `entered_attested` (staff attests manual entry in the source system; NOT an acknowledgment). `gross.simulateSourceAck {grossRecordId}` → `source_acknowledged` (simulator only).
- `gross.flagNeedsClarification {grossRecordId, expectedVersion, note}` · `gross.amend {grossRecordId, reason}` (new version; old one `superseded`).

### S5 Materials
- `print.request {targetType, targetId, kind, purpose?, reprintOfJobId?, reprintReason?, printerId?}` — idempotent; a job in flight or `unknown_outcome` for the same target blocks a new one. Printer simulator: `online` → acknowledged (+ completion if the printer reports it); `offline` → stays `queued` (`PRINTER_UNAVAILABLE` message, job kept); `simulate_timeout` → `unknown_outcome` + reconcile task.
- `print.reconcile {printJobId, expectedVersion, outcome: "printed_ok"|"not_printed"|"printed_damaged"|"cant_tell", note}` · `print.reprint {printJobId, reason}` · `print.cancel {printJobId, reason}`
- `label.apply {labelId}` · `label.verify {labelId, scannedPayload}` · `label.retire {labelId, reason}`
- `block.advance {blockIds, toState}` · `slide.advance {slideIds, toState}` (bench progress for the demo; respects holds)
- `slide.orderAdditional {blockId, stain, level?, reason}` — new work order + planned slide (NOT a reprint)
- `workorder.reviewSourceChange {workOrderId, decision: "retain_prepared_material"|"void_unprepared"|"keep_active", note}`
- `tray.open {pathologistId}` · `tray.scan {trayId, payload}` · `tray.resolveScan {scanId, resolution}` · `tray.setDisposition {trayId, slideId, disposition, note}` · `tray.complete {trayId, expectedVersion}` · `tray.releaseWithExceptions {trayId, note}` (supervisor) · `tray.deliver {trayId}`
- `retrieval.create {blockIds, purpose, destination, workOrderId?}` · `retrieval.scan {requestId, payload}` (wrong block → mismatch, nothing changes, `scan_mismatch` custody event) · `retrieval.markNotFound {itemId, note}` · `retrieval.deliver {requestId}` · `retrieval.return {blockId, locationCode}`

### S6 Integration & settings
- `integration.setSourceStatus {sourceId, status}` · `integration.syncNow {}` · `integration.retryEvent {eventId}`
- `printer.setStatus {printerId, status}` · `assistant.setMode {mode: "deterministic"|"unavailable"}` · `demo.setClock {iso?, running?, advanceMinutes?}`
- `routing.draftRuleSet {reason, changes:[{officeId, pathologistId}]}` · `routing.approveRuleSet {ruleSetId}` · `routing.addCoverage {...}`
- Demo reset is an API route (`POST /api/demo/reset`), not a command (it replaces the database).
- `importSourceMessage(ctx, sourceId, message)` in `domain/sourceImport.ts`: duplicate message id → `duplicate_ignored` (+receipt_count); older/equal version → `stale_ignored`; newer → apply new `source_order_version`, update working values, reconcile: removed/changed stains on existing work orders → `cancel_review`/`amended_review` + affected slides `canceled_needs_review` if printed/prepared (else canceled) + `order_change_review` task + worklist change `canceled`/`changed`; site/laterality change on an **accessioned** part → `correction_review` (part site is immutable) + task; on a **not yet accessioned** order part → update the order part working values (versions keep originals) and mark related clarifications' evidence as superseded-by-amendment. `pumpSources(db)` delivers `sim_source_outbox` rows whose `available_at <= now` only while the source is `connected`, and updates `last_success_at`; while offline it records `last_attempt_at`/`last_error` and delivers nothing.

### S7 Guided demo
- `demo.runStep {step: 1..8, autoStaffActions?: boolean}` — performs the *simulator/world* events for a step (advance clock, courier arrival, office answer, ...) and, only when `autoStaffActions` is true (rehearsal/test), the staff actions too, all through the commands above.

## Storyline decisions (all builders follow these)

1. **Hero case.** Avery Quinlan (synthetic), MRN 448210 in EMA-SIM Sunrise Coast. Two orders from one encounter (ENC-55031): ORD-77120 part A (left upper back, shave) and ORD-77121 part B (order: RIGHT dorsal forearm; bottle: LEFT dorsal forearm, punch). Physical items `phys_quinlanA`, `phys_quinlanB` in the 11:00 delivery `cr_1100`.
2. **Related orders.** Detection proposes REL candidate (same tenant patient + same encounter + same office + same collection day; designations A/B on separate orders). Reviewer (Kim, lead) chooses "single accession, parts kept with original orders". Both source order IDs stay on parts A and B. Nothing is merged.
3. **Part B mismatch.** Verifying container B records a laterality discrepancy. Accessioner raises CLR (category `laterality`) with a hold on **order part B** blocking `gross_approval`, `processing`, `print`, `tray_delivery` (NOT accession). Simulated office answer → reviewed → resolved (`confirmed_observed`). The hold is **not** released by the answer: the amended order ORD-77121 v2 arrives from the simulated source ~1 minute later; the import updates the pre-accession order part (v1 kept) and opens a task for the lead: "Amended order received — review and release H-xxxx". Lead releases with reason.
4. **Accession.** Requested for both intake items together → simulator issues `D26-04817` (first number issued in the demo). Parts A and B keep `ORD-77120` / `ORD-77121`.
5. **Grossing Part A.** Synthetic transcript `quinlan-A` → proposals → operator confirms numbers/units/count → reviewed → approved. Downstream: A1 eligible for processing + source entry task for Sam. Part B stays "awaiting grossing". The case is never "complete".
6. **Materials (earlier case, not the hero).** Tray `TRY-M-03` (Dr. Marsh): 8 of 10 expected slides already scanned; the presenter scans the 9th and an unexpected Okafor slide (rejected); the 10th is missing → tray cannot be verified complete; controlled resolution (find & scan, or "follows separately" + supervisor release with exceptions). `PJ-8841` = deeper-level label with unknown outcome → reconcile → reprint with reason.
7. **Retrieval.** `RR-0192` (Dr. Okafor) for D26-03990 B1, A1 and D26-03912 A1 (checked out, overdue). Last confirmed slot CAB-2/DR-4/BX-11/S-14 (A1). Wrong block D26-03909 A1 scan → mismatch rejected.
8. **Operations.** Holds, overdue clarifications, unknown print outcomes, blocked trays, pending source entry — each with owner, age and evidence links. Demo calculations are labeled illustrative/synthetic.

Scenario helpers in the seed (`app_setting` keys): `scenario_tray_present` (JSON: expectedUnscanned, missing, unexpected slide ids), `scenario_pas_cancel_wo` (work order whose PAS is canceled by an outbox amendment at 11:20), `seed_identity_intake` (INT-1014-022 identity conflict). Outbox rows at 11:04 (duplicate of ORD-77118#v1), 11:20 (PAS cancellation), 11:25 (stale v1 replay).
