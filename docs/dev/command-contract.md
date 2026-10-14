# Build contract: commands, ownership and storyline (internal, for builders)

This file coordinates the parallel build. Every state change goes through a **command** registered with
`defineCommand()` (see `src/server/commands/registry.ts`). The UI calls commands through the client helper
(`src/lib/client/`), tests call them through `tests/helpers.ts`, and slices call *each other* only through
command names (`mustRun(db, actorId, "name", input, { origin })`) or through the shared domain modules listed
below. Never import another slice's private files.

> **Status, 2026-10-14, after the build.** 88 commands are registered: the 76 named in the original contract
> (every one of them exists) plus 12 added during the build. The [as-built list](#registered-commands-as-built)
> below comes from the live registry (`listCommands()` in `src/server/commands/registry.ts`, with roles from
> `src/lib/roles.ts`), and it is the reference. The original per-slice contract further down is kept for history.
> The commands added during the build appear there too, marked *(added during build)*. Where the original
> text and the code differ, **the code wins**. See [Input changes made during the build](#input-changes-made-during-the-build).
>
> To re-check the list: `grep -ho 'name: "[a-zA-Z]*\.[a-zA-Z]*"' src/server/commands/*.ts | sort`

## Registered commands (as built)

Every command runs through `executeCommand()`, which does five things: it replays a repeated `idempotencyKey`,
validates the input with zod, checks the role on the server, runs the handler in one SQLite transaction and
audits a denied attempt. "Who" is the permission key from `src/lib/roles.ts` and the demo roles that hold it.
Some handlers run extra checks (`requirePermission` or a direct role test), noted in the table.

Role shorthand:
- **bench**: accessioner, accessioning lead, grosser, histology assistant, histotech, supervisor
- **everyone**: all nine demo roles, including director (read-only) and medical director
- **lead**: accessioning lead
- **HA**: histology assistant
- **any (demo control)**: `permission: null`. Any demo role may run it. It changes the simulated world (clock,
  simulators, connectors), not lab records. Separately, `requirePermission` is skipped for actions with origin
  `simulator`, `import` or `system` (simulated source deliveries, imports, simulated office replies). Actions with
  origin `user` or `demo` are always role-checked. For example, the demo's rehearsal acts as named staff, and their
  roles apply.

The **Contract** column says whether the command was in the original contract or was added during the build.

### Intake and accession (`src/server/commands/intake.ts`, 15)

| Command | Who | What it does | Contract |
|---|---|---|---|
| `intake.receiveDelivery` | `intake.receive`: accessioner, lead, supervisor | Records a courier arrival (time, receiver). Idempotent. | original |
| `intake.receivePhysicalItem` | `intake.receive` | Unpacks one requisition and its containers from the simulated courier bag. Creates the intake item, links the order within the office's tenant, suggests routing, flags related orders and missing containers. Idempotent per physical item. | original |
| `intake.receiveAll` | `intake.receive` | Demo convenience: unpacks everything still in the simulated courier bag. | original |
| `intake.recordObservation` | `intake.edit`: accessioner, lead, supervisor | Edits the typed observation of a bottle label. Clears an earlier verification. | original |
| `intake.verifyContainer` | `intake.verifyContainer`: accessioner, lead, supervisor | "Staff verified against physical container": records who and when. Differences become discrepancies with evidence. | original |
| `intake.updateItem` | `intake.edit` | Edits an intake item's owner or note. A stale version is rejected as CONFLICT. | original |
| `intake.acceptDiscrepancy` | `clarification.resolve`: lead, supervisor | Accepts a recorded field mismatch or extra container, with a reason. Values are kept as found. Patient-identity differences are refused (they need a resolved identity clarification), and so is a discrepancy with an open clarification. | **added** |
| `intake.simulateColleagueEdit` | `intake.edit` | **Demo control.** Luis Benitez (simulated colleague) edits the item's note and bumps its version, so the presenter can show stale-update detection. The edit is audited as Luis (origin `demo`), and the presenter's request is audited too. | **added** |
| `routing.confirm` | `routing.confirm`: accessioner, lead, supervisor | Accepts the rule's suggested dermatopathologist. | original |
| `routing.override` | `routing.override`: lead, supervisor | Assigns a different dermatopathologist, with a reason. The rule's suggestion is kept. | original |
| `routing.resolveException` | `routing.resolveException`: lead, supervisor | Assigns a dermatopathologist to an item from an unknown or unreviewed office, with a reason. | original |
| `related.review` | `related.review`: lead, supervisor | Decides a related-order candidate (`single_accession_approved`, `keep_separate`, `not_related`, `escalated_to_office`), with a reason. Never merges orders or patients. | original |
| `accession.request` | `accession.request`: accessioner, lead, supervisor | Requests the official accession from the simulated authoritative source once the preconditions hold. Idempotent per set of intake items. `SOURCE_OFFLINE` leaves the request retryable. | original |
| `correction.open` | `correction.open`: bench | Opens a correction review for a discrepancy found after accessioning. Snapshots the original references. Never renumbers, merges or relabels. | original |
| `correction.close` | `correction.close`: lead, supervisor | Records the review outcome: `referred_to_source_process`, `closed_no_change` or `closed_corrected_in_source`. | original |

### Clarifications and holds (`src/server/commands/clarifications.ts`, 14)

| Command | Who | What it does | Contract |
|---|---|---|---|
| `clarification.create` | `clarification.create`: bench | Drafts a specimen-specific question (deduplicated on open category + subject), picks the office contact with coverage, sets the next follow-up within office hours, and can place a scoped hold. | original |
| `clarification.draftMessage` | `clarification.send`: bench | The deterministic demo drafter proposes the question and a generic notification body (no patient identifiers). Proposal only. Returns `ASSISTANT_UNAVAILABLE` when the assistant is switched off. | original |
| `clarification.send` | `clarification.send` | Sends through the **simulated** notification connector, as a generic notice only. Idempotent per clarification. Never moves past the delivery states. | original |
| `clarification.recordDelivery` | `clarification.record`: bench | Records delivered, delivery unknown or delivery failed. | original |
| `clarification.recordAck` | `clarification.record` | Records that the office acknowledged the question. An acknowledgement is not an answer. | original |
| `clarification.recordAnswer` | `clarification.record` | Records the office's answer verbatim, as untrusted text. Moves to `answered`. Never resolves. | original |
| `clarification.simulateOfficeAnswer` | any (demo control) | The office simulator replies (labelled as simulated). For the hero ORD-77121 question it also queues amended order ORD-77121 v2, available one minute later. Idempotent. | original |
| `clarification.review` | `clarification.review`: lead, supervisor | Reviews an answered clarification: `accepted`, or `insufficient` (back to waiting on the office). | original |
| `clarification.resolve` | `clarification.resolve`: lead, supervisor | Resolves a reviewed clarification with a resolution code and note. Optional hold releases are recorded as separate audited releases. | original |
| `clarification.followUp` | `clarification.send` | Sends a simulated reminder. Suppressed if a message went out less than 30 minutes ago. | original |
| `clarification.escalate` | `clarification.send` | Sends a simulated escalation to the office's escalation contact and gives the lab escalation owner a task. | original |
| `clarification.cancel` | `clarification.resolve`: lead, supervisor | Cancels, with a reason. Linked holds stay until they are released separately. | original |
| `hold.release` | `hold.release`: lead, supervisor | Releases a hold, with a reason. A hold tied to an open clarification needs that clarification resolved first, or a supervisor override. | original |
| `hold.place` | `hold.place`: bench | Places a manual hold on specific material for specific steps (never the whole bench). | original |

### Worklist and tasks (`src/server/commands/worklist.ts`, 6)

| Command | Who | What it does | Contract |
|---|---|---|---|
| `worklist.ack` | `worklist.ack`: everyone | Acknowledges the worklist up to a version for one view. Clears new/changed/canceled tags for that user and view only. | original |
| `worklist.snapshot` | `worklist.snapshot`: everyone | Records a printed or downloaded snapshot (version, generation time, source data age). Refused if the list has moved past `expectedSeq`. | original |
| `worklist.saveFilter` | `worklist.ack` | Saves the current filters under a name, for this user and view. | original |
| `worklist.deleteFilter` | `worklist.ack` | Deletes one of your own saved filters. | original |
| `task.claim` | `worklist.ack`, plus role-fit rules | Makes you the task owner. Your role must fit the task. Taking over someone else's task needs a lead or supervisor and a reason. Detects a stale view. | original |
| `task.release` | `worklist.ack`, plus rules | Returns a claimed task to the queue. The owner can do this, or a lead or supervisor with a reason. | original |

### Grossing (`src/server/commands/grossing.ts`, 11)

| Command | Who | What it does | Contract |
|---|---|---|---|
| `gross.startDraft` | `gross.edit`: grosser, HA, supervisor | Opens the part's gross record. Creates an empty v1 draft from the procedure's template (no values pre-filled) if none exists. | original |
| `gross.loadTranscript` | `gross.edit` | Attaches a synthetic dictation and runs the deterministic extractor. Produces proposals only. | original |
| `gross.updateFields` | `gross.edit` | Saves typed values and/or the narrative on a draft. Values still need confirmation. | original |
| `gross.confirmField` | `gross.review`: grosser, HA, supervisor. Cassette allocation also needs `gross.confirmCassettes` (grosser, supervisor) | Confirms one value with explicit numbers, units and counts. Keeping a needs-review value as dictated requires `acknowledgeReview: true`. | original |
| `gross.markReviewed` | `gross.review` | Marks the record operator reviewed. Blocked until every required value is confirmed. | original |
| `gross.approve` | `gross.approve`: grosser, supervisor, pathologist | Approves the record for downstream use: creates the allocated blocks, the source-entry task and processing eligibility. Blocked by unconfirmed values or a gross-approval hold. | original |
| `gross.recordSourceEntry` | `gross.recordSourceEntry`: HA, supervisor | Staff attest that they entered the description by hand in the source system. This is not a source acknowledgment. | original |
| `gross.simulateSourceAck` | any (demo control) | The simulated source acknowledges an attested entry. | original |
| `gross.flagNeedsClarification` | `gross.edit` | Parks a draft as needing clarification, with a note. | original |
| `gross.resolveClarification` | `gross.edit` | Records how the grossing question was resolved. The record goes from `needs_clarification` back to `draft`, and can then be reviewed. | **added** |
| `gross.amend` | `gross.approve` | Creates a new draft version from an approved one, with a reason. The approved version is superseded and never edited. | original |

### Materials: print, labels, bench progress, trays, retrieval (`src/server/commands/materials.ts`, 24)

| Command | Who | What it does | Contract |
|---|---|---|---|
| `print.request` | `print.request`: bench | Queues a slide, cassette or requisition label. A job in flight, or with an unknown outcome, for the same label blocks a second one. | original |
| `print.reconcile` | `print.reconcile`: histotech, HA, supervisor | Records what the printer actually produced for a job with an unknown outcome: `printed_ok`, `not_printed`, `printed_damaged` or `cant_tell`. | original |
| `print.reprint` | `print.request` | Reprints the same label, with a reason. Links to the original job. Never creates a new slide or block. | original |
| `print.cancel` | `print.request` | Cancels a planned or queued job, with a reason. | original |
| `print.release` | `print.request` | Releases a job that was kept queued while the simulated printer was offline, or every queued job for one printer. | **added** |
| `label.apply` | `label.apply`: bench | Records that a printed label was physically applied. | original |
| `label.verify` | `label.apply` | Scans an applied label: it must decode and match its own record. This identifies the record; it does not verify tissue. | original |
| `label.retire` | `label.retire`: histotech, supervisor | Retires a physical label, with a reason. | original |
| `block.advance` | `material.advance`: histotech, HA, supervisor | Records block bench progress (forward only). Holds and gross approval are re-checked. | original |
| `slide.advance` | `material.advance` | Records slide bench progress, up to QC reviewed. Delivery happens only through a tray. | original |
| `slide.orderAdditional` | `workorder.review`: histotech, supervisor, pathologist | Orders an additional slide (stain, level, recut): a new work order and a planned slide. Not a reprint. | original |
| `workorder.reviewSourceChange` | `workorder.review`. `keep_active` on a work order canceled at the source also needs the pathologist role (the handler refuses histotech and supervisor) | Decides on a work order canceled or amended at the source after material was printed or prepared: `retain_prepared_material`, `void_unprepared` or `keep_active`. | original |
| `tray.open` | `tray.assemble`: histotech, HA, supervisor | Opens a tray for one dermatopathologist and lists the slides ready for it. | original |
| `tray.scan` | `tray.assemble` | Scans one slide into the tray. Unexpected, duplicate, canceled or unknown material is flagged and not accepted. | original |
| `tray.resolveScan` | `tray.assemble`. `added_by_authorized_change` also needs `tray.releaseWithExceptions` (supervisor) | Resolves a flagged scan: removed from the tray, same slide scanned twice, or added to the expected list. | original |
| `tray.setDisposition` | `tray.assemble` | Records `follows_separately` or `missing_investigation` for an expected slide that is not on the tray, and opens a task. | original |
| `tray.complete` | `tray.assemble` | Marks the tray verified complete, only when every expected slide was scanned and nothing unexpected remains. | original |
| `tray.releaseWithExceptions` | `tray.releaseWithExceptions`: supervisor | Releases a tray with documented exceptions. It is never shown as verified complete. | original |
| `tray.deliver` | `tray.assemble` | Delivers a verified or supervisor-released tray. The scanned slides become delivered. | original |
| `retrieval.create` | `retrieval.request`: histotech, HA, supervisor, pathologist | Requests blocks from storage, in the order the receiving bench needs them. | original |
| `retrieval.scan` | `retrieval.pick`: histotech, HA, supervisor. A block recorded as checked out to someone else is picked only by that holder or the supervisor | Scans a block against a request. A wrong block is rejected, and only the mismatch is recorded. | original |
| `retrieval.markNotFound` | `retrieval.pick` | Records that a block is not at its last confirmed location, and opens a missing-material investigation. | original |
| `retrieval.deliver` | `retrieval.pick` | Hands the picked blocks over at the destination. | original |
| `retrieval.return` | `retrieval.pick` | Returns a block to a storage slot. This confirms that block's location only. | original |

### Integration, demo controls, routing rules, contacts (`src/server/commands/admin.ts`, 17)

| Command | Who | What it does | Contract |
|---|---|---|---|
| `integration.setSourceStatus` | any (demo control) | Sets a simulated source `offline`, `degraded` (5-minute delivery delay) or `connected`. Restoring it delivers the backlog once. | original |
| `integration.syncNow` | any (demo control) | Polls the simulated source adapters now (the same pipeline as the background poll). | original |
| `integration.retryEvent` | `integration.manage`: supervisor | Retries a failed inbound message from the failure queue, using its stored payload. | original |
| `integration.deliverQueuedNow` | any (demo control) | Makes every pending simulated source message available now, then syncs. Delivers only while the source is connected. | **added** |
| `integration.replayDuplicate` | any (demo control) | The simulated source re-sends a message it already sent (same message id). It must be ignored as a duplicate. | **added** |
| `integration.deliverOlderVersion` | any (demo control) | The simulated source sends an older version of an order late. It must be ignored as stale. | **added** |
| `integration.injectImportFailure` | any (demo control) | Arms or disarms a failure for the next message from a source. That message lands in the retryable failure queue. | **added** |
| `printer.setStatus` | any (demo control) | Sets a simulated printer `online`, `offline` or `simulate_timeout`. | original |
| `notifications.setStatus` | any (demo control) | Takes the simulated office-notification connector `offline` (sends are recorded as delivery failed) or back to `connected`. | **added** |
| `assistant.setMode` | any (demo control) | Sets the drafting/extraction assistant to `deterministic` or `unavailable` (manual work continues). | original |
| `demo.setClock` | any (demo control) | Pauses or resumes the demo clock, advances it, or jumps forward. It never moves backwards unless `reset: true`. | original |
| `routing.draftRuleSet` | `routing.editRules`: supervisor | Drafts a new routing rule version from the current approved one, with a reason. It needs approval later. | original |
| `routing.approveRuleSet` | `routing.approveRules`: medical director, supervisor | Approves a draft. The previous approved version is retired, and approved rules are frozen. | original |
| `routing.discardDraft` | `routing.editRules`: supervisor | Discards a draft rule version, with a reason. It is kept for the record. | **added** |
| `routing.addCoverage` | `routing.approveRules` | Adds an approved coverage exception: who covers a dermatopathologist's planned absence. | original |
| `routing.retireCoverage` | `routing.approveRules` | Retires a coverage exception that no longer applies, with a reason. It is kept for the record. | **added** |
| `office.updateContact` | `routing.editRules`: supervisor | Edits the fictional office contact/coverage directory: out-until, backup contact, primary and escalation flags. One primary per office. One person cannot be both primary and escalation contact. Versioned (CONFLICT on a stale version). | **added** |

### Guided demo (`src/server/commands/demo.ts`, 1)

| Command | Who | What it does | Contract |
|---|---|---|---|
| `demo.runStep` | any (demo control). With `autoStaffActions: true` the handler also requires the supervisor demo role | Runs a guided-demo step's simulator events. In rehearsal mode it also runs the step's staff actions, as the named staff, through the real commands. | original |

Not a command: `POST /api/demo/reset` (`{ "confirm": true }`) replaces the whole database with a fresh seed. That includes the audit log.

### Summary of the 12 added commands

| Added command | Why it was added |
|---|---|
| `intake.acceptDiscrepancy` | Lets a lead accept a recorded mismatch without editing it away by retyping the observation. |
| `intake.simulateColleagueEdit` | Lets one presenter demonstrate "two accessioners on the same item" (stale-update detection, spec §5). |
| `gross.resolveClarification` | Gives a draft flagged as needing clarification a way back to draft, with the resolution recorded. |
| `print.release` | Makes the "printer unavailable, job kept queued" state recoverable without a new job. |
| `integration.deliverQueuedNow`, `integration.replayDuplicate`, `integration.deliverOlderVersion`, `integration.injectImportFailure` | Demo switches for acceptance checks 11 and 13: idempotent reimport, stale/out-of-order versions, failure queue and retry. |
| `notifications.setStatus` | Demo switch for a notification outage (sends recorded as delivery failed). |
| `routing.discardDraft`, `routing.retireCoverage` | Complete the routing-rule and coverage lifecycles without deleting history. |
| `office.updateContact` | Makes the office contact/coverage directory configurable (spec §6). |

## Input changes made during the build

These original commands kept their names, but their inputs or rules differ from the original text below. The code wins.

- `clarification.create`: `question` is optional (without it, a fixed rule-based template is stored). `evidence` defaults to `[]` and `priority` to `routine`. The `hold` takes `{scope:{type,id}, scopeLabel, blocks[]}`, where blocks come from `accession_request | routing_confirm | gross_approval | processing | sectioning | print | tray_delivery | all`.
- `clarification.send {clarificationId, expectedVersion, body?, question?, draftSource?: "manual"|"assistant_proposal"|"template"}`.
- `clarification.recordDelivery` / `recordAck` / `escalate` accept an optional `note`. `recordAnswer.channel` is one of `phone_recorded_by_staff | simulated_portal | simulated_ema_message | other_recorded_by_staff`.
- `clarification.review` takes an optional `outcome: "accepted"|"insufficient"`.
- `clarification.resolve.resolutionCode` is one of `confirmed_observed | confirmed_order | source_amended | other`.
- `clarification.cancel` takes an optional `expectedVersion`.
- `hold.release` takes `overrideOpenClarification?: boolean` (honored for the supervisor only).
- `hold.place {scope, scopeLabel, blocks[], reasonCode?, reasonText, clarificationId?}`.
- `related.review` requires `reason`.
- `correction.open.kind` is one of `possible_duplicate_case | site_discrepancy | identity_discrepancy | part_designation | related_case`. `correction.close` takes an optional `expectedVersion`.
- `worklist.snapshot` takes `expectedSeq?`. A snapshot is refused if the list moved on, so paper never mixes versions.
- `task.claim {taskId, expectedVersion, reason?}` · `task.release {taskId, reason?, expectedVersion?}`.
- `gross.loadTranscript` takes an optional `expectedVersion`. `gross.confirmField` has an optional `value` and `acknowledgeReview?: boolean`. `gross.flagNeedsClarification` requires `note`.
- `print.request.targetType` is one of `slide | block | accession`, and `kind` is one of `slide_label | cassette_label | requisition_label`. `print.reconcile.note` is optional.
- `tray.resolveScan.resolution` is one of `removed_from_tray | same_slide_rescanned | added_by_authorized_change`. `tray.setDisposition.disposition` is one of `follows_separately | missing_investigation`.
- `integration.setSourceStatus.status` adds `degraded`. `integration.syncNow` takes an optional `sourceId`.
- `demo.setClock` adds `reset?: boolean`, the only way to move the clock backwards. Use either `iso` or `advanceMinutes`, not both.
- `routing.draftRuleSet.changes[].pathologistId` may be `null`. `routing.approveRuleSet` takes an optional `effectiveFrom`. `routing.addCoverage {pathologistId, coveringPathologistId, startsAt, endsAt, reason}`.
- `slide.orderAdditional` uses the `workorder.review` permission (histotech, supervisor, pathologist).

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

## Command names and inputs (the original contract, plus build additions)

`expectedVersion` = the `version` the user saw. All ids are internal row ids unless noted. This is the contract the
slices were built against. Commands added during the build are marked *(added during build)*. Input changes are listed
in [Input changes made during the build](#input-changes-made-during-the-build).

### S1 Intake & accession
- `intake.receiveDelivery {deliveryId}` — courier arrival: `arrived_at`, `received_by`, status `reconciling`. Idempotent.
- `intake.receivePhysicalItem {deliveryId, physicalItemId? , orderRef?}` — simulated unpack/scan of one requisition + its containers from `sim_physical_item`; creates intake item (`displayId(db,"INT-1014",3)`), containers (observed labels as typed observations), links the order **within the office's tenant**, computes routing suggestion (or exception), runs related-order detection, checks expected containers per order part (missing → flagged). Idempotent: an already received item returns the existing intake item.
- `intake.receiveAll {deliveryId}` — demo convenience: receives every not-yet-received physical item.
- `intake.recordObservation {containerId, expectedVersion, observed}` — staff edits typed observations.
- `intake.verifyContainer {containerId, expectedVersion, orderPartId}` — "Staff verified against physical container" (records who/when). Compares observed vs order part; differences → `verification_state = 'discrepancy'` with evidence returned (UI then offers "Raise clarification").
- `intake.updateItem {intakeItemId, expectedVersion, patch}` — generic edit (owner, notes) used to demonstrate stale-update detection.
- *(added during build)* `intake.acceptDiscrepancy {discrepancyId, expectedVersion, reason}` — lead/supervisor (`clarification.resolve`) accepts a `field_mismatch` or `extra_container` discrepancy; values stay as found. Identity-field mismatches → `INVARIANT`; a missing container needs a clarification; an open clarification on the same container/order part → `BLOCKED`.
- *(added during build)* `intake.simulateColleagueEdit {intakeItemId}` — demo control (`intake.edit`): Luis Benitez appends a note as a simulated colleague (origin `demo`), bumping the version so the presenter's next save shows CONFLICT.
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
- *(added during build)* `gross.resolveClarification {grossRecordId, expectedVersion, resolution}` — only from `needs_clarification`; records the resolution on the open clarification item and returns the record to `draft`.

### S5 Materials
- `print.request {targetType, targetId, kind, purpose?, reprintOfJobId?, reprintReason?, printerId?}` — idempotent; a job in flight or `unknown_outcome` for the same target blocks a new one. Printer simulator: `online` → acknowledged (+ completion if the printer reports it); `offline` → stays `queued` (`PRINTER_UNAVAILABLE` message, job kept); `simulate_timeout` → `unknown_outcome` + reconcile task.
- `print.reconcile {printJobId, expectedVersion, outcome: "printed_ok"|"not_printed"|"printed_damaged"|"cant_tell", note}` · `print.reprint {printJobId, reason}` · `print.cancel {printJobId, reason}`
- *(added during build)* `print.release {printJobId?} | {printerId?}` (one is required) — resubmits a job kept `queued` while its simulated printer was offline, or every queued job for one printer. Same job, no duplicate.
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
- *(added during build)* demo controls (`permission: null`) for the source-integration acceptance checks: `integration.deliverQueuedNow {sourceId?}` (make pending outbox rows available now, then sync) · `integration.replayDuplicate {sourceId?, eventId?}` (re-send an applied order message with the same message id → `duplicate_ignored`; refused while the source is offline) · `integration.deliverOlderVersion {sourceId?}` (queue an older order version late → `stale_ignored`) · `integration.injectImportFailure {sourceId, enabled}` (next message fails → failure queue → `integration.retryEvent`).
- *(added during build)* `notifications.setStatus {status: "connected"|"offline"}` — demo control for the simulated notification connector; while offline, new clarification sends are recorded as `delivery_failed`.
- *(added during build)* `routing.discardDraft {ruleSetId, reason}` (`routing.editRules`, supervisor) · `routing.retireCoverage {coverageId, reason}` (`routing.approveRules`, medical director/supervisor). Both keep the row for the record.
- *(added during build)* `office.updateContact {contactId, expectedVersion?, patch:{out_until?, backup_contact_id?, is_primary?, is_escalation?}}` (`routing.editRules`, supervisor) — fictional contact directory; backup must be another contact at the same office; one primary per office (promoting demotes the previous primary, recorded); a contact cannot be both primary and escalation; versioned via `office_contact_revision`.
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
