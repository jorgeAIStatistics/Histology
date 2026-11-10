# Security and privacy: what exists, what is missing

*Release candidate, Stage 5, 2026-10-18; production blockers updated for Stage 6, 2026-10-19. Synthetic data only. Nothing here is a claim of HIPAA, CLIA, CAP, FDA or any other regulatory compliance; technical controls are not compliance.*

## Controls that exist and are tested
| Control | Where | Evidence |
|---|---|---|
| **One write path.** Every state change goes through `executeCommand`: zod input validation, then a server-side role check, then one transaction, then an append-only audit event. | `src/server/commands/registry.ts` | `tests/domain/*` (whole suite) |
| **Scoped idempotency.** A key belongs to one actor, lab scope, command and canonical request. The lookup, the command and the receipt run in one write-locked transaction. Any mismatch, another owner, a lost permission or an expired key is refused, and the stored result is never disclosed. A failed command leaves no receipt. | `src/server/core/idempotency.ts`, `registry.ts` | `tests/domain/security.test.ts` (including two connections racing for one key) |
| **Fail-closed mode gate.** `demo` serves synthetic data through the demo role switch; `secured` requires an OIDC session for every page, read API and command; anything else is `locked`: every page redirects to `/locked` and every API answers 401 with no data. The role switch, demo reset, design previews, presenter console, test fixtures and the simulated-source pump exist only in `demo`. | `src/server/runtime-mode.ts`, `src/server/auth/guard.ts`, API routes, `src/proxy.ts` | `security.test.ts`, `auth.test.ts`, `tests/e2e-secured/auth.spec.ts` |
| **No internal actor over HTTP.** A user request can never act as `system`. Unknown or inactive staff ids are refused. | `registry.ts` | `security.test.ts` |
| **Presenter controls.** Commands marked `audience: "presenter"` (simulated world events, clock, outages, guided steps) are recorded with origin `demo`, not `user`, so History never shows them as lab work. They still pass the normal role check of their command. A locked build refuses them like every other user command, and the presenter console (`/demo`, every tab) is a 404 there. No bench screen carries a presenter control. | `registry.ts`, `src/app/demo/gate.ts`, `src/server/queries/presenter.ts` | `security.test.ts` (presenter origin), `presenter.test.ts` (targets, 404 in locked), `tests/e2e/presenter-console.spec.ts` |
| **Correlation.** One correlation id per HTTP request, returned as `X-Correlation-Id` and written to every audit event and receipt of that request. | `src/server/session.ts`, `route.ts` | `security.test.ts` |
| **Append-only audit.** SQLite triggers forbid UPDATE and DELETE on `audit_event`. Approved gross content is frozen by a trigger. | `src/server/db/schema.sql` | `tests/domain/foundation.test.ts` |
| **Optimistic concurrency.** Version checks on edited records, or state guards on event-style transitions. A stale save shows both values and never overwrites. | `src/server/core/versioning.ts`, domain modules | domain tests, `tests/e2e/guards.spec.ts` |
| **Cross-origin refusal.** State-changing routes reject a browser `Origin` from another host. | `src/server/session.ts` | e2e |

## Stage 6 additions (see the linked documents for evidence and limits)
| Control | Document |
|---|---|
| OIDC sign-in, database sessions, idle lock, hand-over protection, re-authentication, read and write authorization, lab scope, admin CLI | [auth-architecture.md](auth-architecture.md) |
| Tamper-evident audit chain, anchors, `/audit`, traceability columns | [audit-integrity.md](audit-integrity.md) |
| PHI-free audit payloads, redacting logs, screen-by-screen minimisation | [privacy-review.md](privacy-review.md) |
| Transport and secret checks, storage encryption stance, retention configuration, secure-deletion limits | [data-protection.md](data-protection.md) |
| Encrypted backup and verified restore | [backup-restore.md](backup-restore.md) |
| Signed integration boundary (simulator only) | [integration-contract.md](integration-contract.md) |

## Production blockers (still open before any real patient data)
1. **Activate a real identity provider.**
   - Sign-in is implemented and tested only against a local OIDC provider. Activation needs:
     - the laboratory's provider tenant, app registration and agreed claims (subject stability, `auth_time`, MFA via `amr`/`acr`, lab claim);
     - identity links and role assignments reviewed by the laboratory director.
   - Until then, any non-demo build is `locked` or `secured` without users, and shows no data.
2. **Deployment controls.**
   - TLS termination with HSTS; a secret store for `HLOS_SESSION_SECRET`, `HLOS_AUDIT_KEY`, `HLOS_BACKUP_KEY` and OIDC client credentials.
   - Encrypted volumes: the application does not encrypt the SQLite file.
   - Rate limiting at the reverse proxy; monitoring of `/api/health`, the audit verification and the logs.
3. **Independent audit anchoring.** Anchors are written to a file. Its custody must be outside the database host and outside the reach of database administrators, or the chain does not resist an insider who holds the key.
4. **Retention and deletion policy** decided by the laboratory, and backup retention and off-host copies.
5. **Real integrations.** Every connector is simulated; each needs a contract, a test environment and its own validation.
6. **Independent security testing.** Stage 6 had one internal adversarial review (Phase B); its high and medium findings were fixed; the low findings on auditing refusals of signed-in users and on session id rotation were fixed on 2026-10-24 (rate-limited `auth.refused` events; a new session id on re-authentication and unlock). That is not a penetration test or a threat-model review.

## Privacy notes for the demo
- All names, MRNs, offices and cases are fictional and generated by the seed.
- `Histology_Lab_OS_Claude_Master_Prompt.txt` (tracked since the first commit) names a real employer and a real medical director. It contains no patient data. The repository is private. Consider removing the file from history before the repository is ever shared.
