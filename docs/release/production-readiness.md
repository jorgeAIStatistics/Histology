# Production readiness (release candidate, Stage 5)

*2026-10-19. This is a **synthetic demonstration**, not a product cleared for clinical use. "Verified" below means verified by automated tests and the development team's own review on synthetic data. It is not clinical validation, not a regulatory assessment, and not an independent security assessment. Nothing here claims HIPAA, CLIA, CAP, FDA or any other compliance. Test counts and runs are in [verification.md](verification.md).*

## 1. Demonstrated and verified
Each item is covered by automated tests that pass on a clean production build.

| Capability | Evidence |
|---|---|
| One write path: input validation, server-side role check, one transaction, append-only audit with before/after and reason | `src/server/commands/registry.ts`; `tests/domain/*` |
| Scoped idempotency: owner, lab scope, command and payload fingerprint; 24-hour expiry; atomic under two connections; the stored result is never disclosed to another actor | `src/server/core/idempotency.ts`; `tests/domain/security.test.ts`; `tests/e2e/journeys.spec.ts` (repeated request in every journey) |
| Fail-closed runtime mode: a locked build refuses changes (401), the role switch (403), demo reset, design previews and the presenter console (404); the source pump is off | `src/server/runtime-mode.ts`, `src/app/demo/gate.ts`; `security.test.ts`, `presenter.test.ts` |
| Optimistic concurrency on edited records, plus state guards on event-style transitions (27 versioned lab commands, 48 state-guarded) | [mutation-audit.md](mutation-audit.md); `integrity.test.ts`; `guards.spec.ts`; journeys (stale state) |
| Human control of identity, relationships, holds, routing exceptions, gross approval and tray completion. Nothing merges orders or patients. | `integrity.test.ts`, `intake.test.ts`; `director-journey.spec.ts` steps 2–3; journeys 2–3 |
| Scoped holds that block named transitions only, with the next step and owner computed in one place (Operations, Case, Gross and Clarify agree) | `src/server/queries/hold-next.ts`; `consistency.test.ts` |
| A source amendment to an issued part opens a correction review and holds that part | `src/server/domain/sourceImport.ts`, `correction.ts`; `consistency.test.ts` |
| Chain of custody: a block's location is the last confirmed one; delivery records a hand-over, not a location | `src/server/domain/retrieval.ts`; `consistency.test.ts`; journey 5 |
| Honest unknowns: a missing manifest shows "Unknown"; no doctor is guessed for an office with no rule; "Sent on tray" records no pathologist receipt | `director-journey.spec.ts` steps 1 and 6; journeys 1 and 4 |
| A connector outage turns screens stale and queues messages; restoring imports each one exactly once | `guards.spec.ts` check 13; journeys (unavailable dependency) |
| Presenter isolation: no presenter control on any bench screen; world events, clock, role and outages only on `/demo` | `presenter-console.spec.ts`; `presenter.test.ts` |
| The Intake bench works by keyboard and scanner at 1366×768, 1440, 1024, 200% zoom and 125% text (REL-0112 included) | `tests/e2e/intake-keyboard.spec.ts` |

## 2. Implemented, not yet verified enough
| Item | What is missing |
|---|---|
| Layout resilience on screens other than Intake under browser text-size preferences | The top bar was measured at 16, 20 and 24px default text, 1024–1920px wide (126 checks, 0 overflow; development measurement in the Stage 5 log). Only Intake has automated resilience tests. |
| Print output of the worklist snapshot | The e2e test checks the generation time, version and data age in print media. Paper output on real printers has not been checked. |
| Correlation ids across a whole user flow | They are per HTTP request. A multi-request flow (for example draft then send) has no shared parent id. |
| Receipt expiry | Tested with a backdated receipt. There is no cleanup job, so receipts accumulate. |
| Source-conflict review UI | Domain tests cover it. There is no browser test, because only the importer can create the state. |
| Accessibility | Keyboard and focus are tested on Intake and in the journeys. There has been no screen-reader session or audit by assistive-technology users. |

## 3. Simulated (works only against simulators)
- **Source systems.** EMA-SIM and OTHER-EHR-SIM: orders, amendments, cancellations, accession numbers, acknowledgements (`src/server/sim/*`).
- **Courier and container contents.** These include the "unpack" scan path.
- **Label and cassette printers.** Acknowledged, completed, timeout leading to an unknown outcome, and failed.
- **Office notifications and answers.**
- **Drafting and extraction assistant.** Fixed rules, not a model.
- **Demo clock.**
- **Barcode scanners.** A keyboard-wedge emulation through the scan field.

Each simulated surface is labelled "simulated" on screen. Boundaries are in [integration-readiness.md](integration-readiness.md).

## 4. Planned (designed, not built)
- Instrument events from processors, stainers and coverslippers, through middleware.
- Real label templates validated on stock after processing.
- A retention and cleanup job for receipts and exports.
- A worklist downtime procedure built around the printed snapshot.

## 5. Production-blocking (must exist before any real patient data)
1. **Authentication and authorization.** No sign-in exists; "Acting as" is a demo cookie. Needed:
   - an identity provider;
   - sessions with bench auto sign-out;
   - administrator-managed roles;
   - re-authentication for consequential actions.
2. **Audit integrity beyond SQLite triggers.** Needed:
   - tamper evidence anchored outside the database;
   - trusted time;
   - a read-access log.
3. **Data protection.** Needed:
   - encryption at rest and in transit, with key management;
   - minimum necessary display of patient data on bench screens;
   - de-identified exports.
4. **Retention, deletion, backup and restore.** None exist; the demo reset deletes everything.
5. **Real integrations.** Each needs a contract, a test environment, error handling, monitoring and its own validation.
6. **Validation by the laboratory.** Needed:
   - a written intended use;
   - workflow validation on the laboratory's own specimens and labels;
   - the laboratory's quality-system sign-off.

   Automated tests are not a substitute.
7. **Security testing.** Needed:
   - a threat model;
   - dependency and container scanning;
   - an independent penetration test.
8. **Operations.** Needed:
   - hosting;
   - monitoring and alerting (idempotency conflicts, connector failures);
   - an incident process;
   - multi-user SQLite limits replaced or load-tested.

Details are in [security-privacy.md](security-privacy.md).
