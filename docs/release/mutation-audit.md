# Mutation audit (Stage 5, A2)

*Release candidate, 2026-10-19. Synthetic demo. This audit was generated from the code, then read by hand. It is a development review, not a validation.*

## Method
- **Commands.** Every command registered in `src/server/commands/*.ts` was listed with its permission, its audience and whether its input carries a version.
- **Guards.** For each command without a version, the handler in `src/server/domain/*.ts` was searched for the guards it runs before writing:
  - `DomainError` throws;
  - `assertState`, `assertNotHeld`, `assertActive`, `assertPreAccession`, `assertReleasable` and `assertPartActive`.

  The three handlers with no guard were read in full.
- **Tests.** Each change made in Stage 5 is covered by a named test.

## Totals
| Group | Commands | Protection against a stale or repeated write |
|---|---|---|
| Lab commands with a version check | 27 | `expectedVersion` (or `expectedDecisionId` for a routing override). A stale version gets 409 `CONFLICT` and the screen shows both values. Nothing is overwritten. |
| Lab commands guarded by state | 48 | The handler refuses the transition from the wrong state (`BLOCKED` 423, `INVARIANT` 422 or `VALIDATION` 400), or returns "nothing changed" when the action was already done. Holds are re-checked inside the transaction where a hold can block the step. |
| Presenter commands (`audience: "presenter"`) | 14 | Simulated world events, outages, the clock and guided steps. They are recorded with origin `demo` and refused in a locked build. |
| **All** | **89** | Every command also gets scoped idempotency, the role check and one transaction (`registry.ts`). |

## The commands with no state guard
All three were read in full, and each is safe to repeat.

| Command | Why it is safe | Where |
|---|---|---|
| `intake.receiveDelivery` | An arrival that is already recorded returns `duplicate: true` and writes nothing. | `src/server/domain/intake.ts` `receiveDelivery` |
| `intake.receiveAll` | It skips requisitions that are already received; each new one goes through the guarded `receivePhysicalItem`. | `intake.ts` `receiveAll` |
| `label.retire` | A reason is required. A label that is already retired returns "Nothing changed". The slide or block record is never altered. | `src/server/domain/labels.ts` `retireLabel` |

`worklist.ack` is monotonic: a version newer than the latest is refused, and an older or equal one is "unchanged" (`src/server/commands/worklist.ts`).

## Changes made in Stage 5
| # | Finding at baseline | Change | Test |
|---|---|---|---|
| A-1 | An identity mismatch could be covered by any resolved clarification. | Only an `identity_conflict` clarification resolved as "order is correct" covers it, and the latest decision wins (`identityCoverage`). | `tests/domain/integrity.test.ts` |
| A-2 | An open source conflict did not block accession. | New blocker `source_conflict_open`, plus the `sourceConflict.review` command (a lead, with a reason; the patient on file is never changed). | `integrity.test.ts`, `intake.test.ts` |
| A-4 | A routing override could act on a decision the lead had not seen. | It requires `expectedDecisionId` and re-checks the routing hold. | `integrity.test.ts` |
| A-5 | Staff could order an extra slide with no record of who asked. | A non-pathologist must give a request reference, stored as "Entered by staff on request". | `integrity.test.ts` |
| A-6 | Release of a queued print job trusted the earlier target. | The target is re-resolved and the hold is re-checked at release. | `integrity.test.ts` |
| A-7 | An optional `expectedVersion` on four commands allowed a stale overwrite when it was left out. | It is now required on `correction.close`, `clarification.cancel`, `office.updateContact` and `task.release`. It is nullable but required on `gross.loadTranscript`. | `integrity.test.ts` |
| A-8 | Completing a tray with exceptions could act on a tray state the supervisor had not seen. | It requires the tray version. | `integrity.test.ts` |
| A-9 | A block or slide could skip stages in one command. | One stage per command. | `integrity.test.ts` |
| A-12 | Some audit rows lacked before/after values, per-slide delivery rows, import message ids or a discrepancy-closed row. | Added. | `integrity.test.ts` |
| S1 | Idempotency replayed a stored result to any actor or payload. | The key is owned by actor and lab scope, bound to the command and a SHA-256 of the canonical input, honoured for 24 hours, and checked inside one immediate transaction. | `tests/domain/security.test.ts` |
| S2 | A cookie value of `system` acted as the internal supervisor. | User requests can never act as `system`. | `security.test.ts` |
| S3 | No gate separated the demo from a production-capable build. | `HLOS_MODE`: outside demo mode every user command gets 401, the role switch 403, demo reset and `/concepts` 404, and the `/demo` console 404. The source pump is off. | `security.test.ts`, `presenter.test.ts` |
| S5 | Correlation ids were per command. | One per HTTP request, on every audit row and receipt, and returned as `X-Correlation-Id`. | `security.test.ts` |

## Not changed (documented)
- **No authentication** (S4). This is a production blocker; see `security-privacy.md`.
- **No version on event-style lab commands** (scans, stage moves, receipts). The physical event is the source of truth, and the state guard refuses an impossible transition. A real deployment would add device and session identity to each scan event.
