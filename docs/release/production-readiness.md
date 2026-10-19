# Production readiness (Stage 6)

*2026-10-19, branch `stage-6-production-foundation`. Histology Lab OS is a **synthetic demonstration with a production-grade foundation**, not a system cleared for clinical use.*

- **"Verified"** means verified by automated tests and the development team's review on synthetic data in this environment.
- It is **not** clinical validation, not an independent security assessment, and not a regulatory assessment.
- **No HIPAA, CLIA, CAP, FDA or other compliance is claimed.**

Test counts and runs are in [verification-stage6.md](verification-stage6.md).

## VERIFIED
Covered by automated tests that pass on a clean production build.

| Capability | Evidence |
|---|---|
| **Fail-closed runtime modes.** `demo` (synthetic data, demo role switch) and `secured` (OIDC sign-in required for every page, read API and command). `locked` is anything else, and shows no data. | `src/server/runtime-mode.ts`, `src/server/auth/config.ts`; `tests/domain/auth.test.ts`; locked-build curl check |
| **OIDC sign-in.** Authorization code flow with PKCE, state, nonce, and a forced login at every sign-in. Session ids are stored hashed. Idle lock, absolute expiry, sign-out, workstation hand-over (`ACTOR_MISMATCH`), re-authentication for sensitive commands. Exercised end to end against a real local OIDC provider (`oidc-provider`). | `src/server/auth/*`; `tests/domain/oidc.test.ts`; `tests/e2e-secured/auth.spec.ts` |
| **Server-side authorization of reads and writes.** `view.*` permissions for every page, action permissions for every command, and lab scope. `lab_admin` and `auditor` have no clinical access. `identity.resolve` gates identity and source-conflict decisions. | `src/lib/roles.ts`, `src/server/auth/guard.ts`; `auth.test.ts`, secured suite |
| **Demo isolation.** The demo cookie, presenter commands, fixtures, reset and the source pump never work in secured mode. Demo mode refuses any database that is not the synthetic one. | `auth.test.ts`, `demo-db-guard.test.ts`, `presenter.test.ts` |
| **Scoped idempotency and receipt maintenance.** Expired receipts become tombstones that are still refused; tombstones are purged after retention, in bounded batches. | `security.test.ts`, `receipts.test.ts` |
| **Tamper-evident audit.** An HMAC chain seals every event. Verification detects edits, deletions, reordering, forged seals and unsealed events. External anchors catch an insider rewrite before the last anchor. | `src/server/core/audit-seal.ts`; `audit-seal.test.ts` |
| **Traceability.** Actor, role, permission, session reference, record references, before/after, reason, correlation id and source reference. | `traceability.test.ts` |
| **No patient name, birth date or MRN in audit summaries or before/after values.** Typed reasons are excluded. | `audit-phi.test.ts` |
| **Structured logs with redaction.** Generic server errors carry a correlation id. | `log.test.ts`, `privacy.test.ts` |
| **Integration boundary.** A versioned, signed contract. Duplicate, stale, conflicting, invalid, outage and recovery cases are all handled; accessioned identity is never changed by a message; provenance (source event time against receipt time) is kept. | `src/server/integration/*`; `tests/contract/*` (73), `tests/e2e/integration.spec.ts` |
| **Backup and restore.** An encrypted backup restores to a new path, and integrity, foreign keys, counts, schema and the audit chain are verified. Tampering is detected. | `scripts/backup.ts`, `scripts/restore.ts`; `backup.test.ts`; drill in [backup-restore.md](backup-restore.md) |
| **Health and error recovery.** Health is healthy, degraded or unavailable without secrets. The client never reports unconfirmed success. A retry keeps its key. Storage failures are typed. | `health.test.ts`, `recovery.test.ts`, `tests/e2e/recovery.spec.ts` |
| **Bench workflows (Stage 5 suites).** Holds, readiness, custody, grossing confirmations and presenter isolation. | the demo browser suite (all journeys and guards) |
| **Accessibility, automated.** axe (WCAG 2.2 AA tags), 0 violations on the listed screens; keyboard and focus after errors; no WCAG 2.5.8 target failures. | `tests/e2e/accessibility.spec.ts`, `target-size.spec.ts` |

## IMPLEMENTED BUT NOT VERIFIED (enough)
- **Behaviour with a real identity provider** (Entra ID, Okta, Auth0): claims, MFA (`amr`/`acr`), logout and clock skew. Tested only against `oidc-provider`.
- **HSTS and `Secure` cookies behind a real TLS proxy.** Unit-checked from configuration; no TLS deployment exists.
- **Per-client rate limiting of sign-in attempts.** Left to the reverse proxy.
- **Audit-chain verification on a very large trail.** Every verification is a full pass; the cost is not measured at scale.
- **Concurrency beyond a single SQLite file on one host.**

## SIMULATED
- **Order, accession and acknowledgement source.** Simulated EMA-SIM and OTHER-EHR-SIM, the HTTP simulator and the in-process pump.
- **Label and cassette printers, office notifications, courier contents, scanners** (keyboard wedge), the drafting assistant and the demo clock.
- **All patient, order and case data.**

## PLANNED (designed, not built)
- Instrument events, IHC quality control, reagent lots, live operational views and evaluated operational predictions: see [stage7-proposal.md](stage7-proposal.md).
- Provider-group role mapping, multi-lab data partitioning, SQLCipher, and an independent anchoring service.

## BLOCKED (needs an external decision, credentials or environment)
1. A real identity provider tenant, app registration and claims agreement. Production activation stays off until then.
2. A deployment environment: TLS, a secret store, encrypted volumes, off-host backups, monitoring.
3. A real LIS/EHR interface (contract, test environment, interface engine); real printers, scanners and instruments.
4. An independent penetration test and threat-model review.

## REQUIRES HUMAN VALIDATION
- **Screen-reader sessions** (NVDA and VoiceOver): the checklist in [screen-reader-checklist.md](screen-reader-checklist.md) has not been run.
- **Paper printing** of the worklist on the laboratory's printers: only print-to-PDF has been checked ([print-verification.md](print-verification.md)).
- **Touchscreen ergonomics** on the laboratory's actual hardware ([touch-targets.md](touch-targets.md)).
- **Workflow validation** by the laboratory on its own specimens, labels and staff, under its quality system.
- **Role assignments, retention periods, RPO and RTO**, decided by the laboratory director and IT.
