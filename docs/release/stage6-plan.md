# Stage 6 implementation plan (bounded)

*2026-10-19, branch `stage-6-production-foundation`, cut from `stage-5-release-candidate` at `c48007b`. Synthetic data only. Nothing in this stage connects to a real identity provider, laboratory system, printer or scanner.*

## 1. Verified at the start (fresh runs this session, not reported claims)
| Claim | Fresh result |
|---|---|
| Type check | `npx tsc --noEmit`: clean |
| 367 unit tests | `npx vitest run`: **367/367** (14 files) |
| 77 browser tests | `E2E_TAG=s6base npx playwright test` on a fresh production build: **77/77** (2.2 min) |
| Stack | Next.js 16.3.8 App Router (Turbopack), React 19.2.8, TypeScript 5.9; SQLite through better-sqlite3 (no ORM; `schema.sql` plus additive ensure-steps); zod 4; vitest 4; Playwright 1.64 |
| Hosting | One Node process with one local SQLite file (WAL). No hosting configuration exists. |
| Write path | `POST /api/commands/<name>` → `executeCommand`: mode gate, actor, zod, scoped idempotency, permission, one immediate transaction, append-only `audit_event` |
| Identity | Demo role cookie `hlos_actor` (not authentication). `HLOS_MODE=demo` enables it; any other mode is "locked" and refuses writes. |
| Authorization | Role → permission matrix (`src/lib/roles.ts`), checked server-side on **mutations only** |
| Audit | `audit_event` with append-only triggers; correlation id per request; no hashing |
| Import | `importSourceMessage` (`src/server/domain/sourceImport.ts`): idempotent per message id, refuses older versions, keeps a failure queue. Fed in-process by the simulator pump; no transport boundary. |
| Integrations | All simulated: EMA-SIM / OTHER-EHR-SIM, printers, office notifications, courier, assistant |

## 2. Critical missing capabilities
1. **No authentication.** A locked build refuses writes but still **renders every bench page with data** to anyone, using the default demo actor. Reads are not authorized anywhere.
2. **No session model** (expiry, inactivity lock, sign-out, re-authentication, workstation hand-over).
3. **The audit trail can be silently edited** by anyone with file access (triggers stop only the application).
4. **Idempotency receipts** are never cleaned up.
5. **No transport-level integration contract**, no reconciliation view of source versus local state, and no contract tests at the boundary.
6. **No backup, restore or health reporting.**
7. **Stage 5 test gaps:**
   - source-conflict UI;
   - automated accessibility checks;
   - print output;
   - 32px desktop targets.

## 3. Vulnerabilities and unjustified assumptions
| # | Finding | Severity |
|---|---|---|
| V1 | Unauthenticated reads in locked builds: pages, `/api/live` snapshot counts | High (would expose PHI if real data were loaded) |
| V2 | The internal `system` actor has the supervisor role; any code path that builds a ctx with origin `import`/`simulator` bypasses permission checks | Medium (in-process only; keep it, but confine it to server code and test it) |
| V3 | The audit trail is not tamper-evident | Medium |
| V4 | Deleting receipts naively would reopen replay of old keys | Medium (design constraint for the cleanup) |
| V5 | No security headers (CSP, frame-ancestors, HSTS behind TLS) | Low to medium |
| V6 | Single lab assumed; no lab claim is checked | Low today; required before multi-site use |

## 4. Proposed architecture
- **Runtime modes** (`src/server/runtime-mode.ts`):
  - `demo`: unchanged.
  - `secured`: OIDC sign-in is required for every page, read API and command.
  - `locked`: fail-closed, and now shows a "not configured" page with **no data**.

  `secured` is chosen only when `HLOS_MODE=secured` **and** the OIDC configuration validates. A secured build with missing or invalid configuration falls back to `locked`.
- **OIDC relying party:**
  - `openid-client` 6, authorization code flow with PKCE, state and nonce;
  - server-side sessions in SQLite (opaque random id, stored hashed; HttpOnly, SameSite=Lax, Secure under HTTPS);
  - absolute and idle timeouts, with an inactivity lock that hides all data;
  - explicit sign-out (local, plus the provider's end-session endpoint when it advertises one);
  - re-authentication (`prompt=login`, `max_age`, `auth_time`) for commands marked `sensitive`;
  - the page's expected actor is sent with each command and must match the session, so an action is never recorded under the wrong user after a workstation changes hands.
- **Identity → staff:** a staff member is linked to an issuer and subject by a laboratory administrator; nobody is linked automatically. Roles are granted locally per lab. Provider groups are not trusted for clinical permissions in this stage.
- **Roles:** `lab_admin` (accounts and configuration, **no clinical permissions**) and `auditor` (read-only plus audit verification) are added. Read permissions (`view.*`) are enforced in every page and read API. The action-specific `identity.resolve` permission now gates identity and source-conflict decisions.
- **Lab scope:** a session carries `lab_id`, which must equal the deployment's `HLOS_LAB_ID`. A cross-lab session is refused. Multi-lab data partitioning is deferred.
- **Local provider for tests:** `oidc-provider` (development dependency only) runs a real OIDC provider in-process in tests, so the full code flow is exercised without credentials. Production activation stays **blocked** until a real provider is configured and validated.
- **Audit integrity:**
  - a separate append-only `audit_seal` table holds, for each audit event, an HMAC-SHA256 chain value (`HLOS_AUDIT_KEY`);
  - a verification routine detects edited, deleted or reordered events and broken seals;
  - checkpoint anchors are exported to a file outside the database.

  The limitation is documented: anyone holding both the database and the key can rewrite history up to the last external anchor.
- **Receipts:** an expired receipt is compacted to a tombstone (key, owner, scope, command, fingerprint, expiry, no result). Tombstones are deleted after a longer retention. A purge runs in bounded batches inside short transactions.
- **Integration boundary:**
  - a versioned canonical envelope `hlos.source-order/1` (contract document plus zod schema);
  - an HTTP inbound endpoint with an HMAC-signed body and source id, enabled only for simulator sources in demo or test;
  - ACK and NAK replies with error codes;
  - a scenario simulator covering the 12 cases;
  - a reconciliation read model and view (source assertion against local verified state, source event time against received time).

  All of it reuses `importSourceMessage`; there is no second specimen model.
- **Reliability:**
  - online backup through SQLite's backup API, with a manifest (hashes, row counts, audit head);
  - restore into an isolated path, then verification (integrity check, foreign keys, audit chain, counts);
  - `/api/health` with healthy, degraded or unavailable status and no PHI;
  - structured, redacted JSON logs with correlation ids.

## 5. Files and modules likely to change
- **Server:**
  - `src/server/runtime-mode.ts` and `src/server/session.ts`;
  - new `src/server/auth/*`: OIDC client, sessions, guards;
  - `src/server/commands/registry.ts`, `src/lib/roles.ts`, `src/server/core/context.ts`;
  - `src/server/core/audit.ts`, new `src/server/core/audit-seal.ts`;
  - `src/server/core/idempotency.ts`;
  - `src/server/db/schema.sql`, with additive migrations.
- **Routes:**
  - new `src/app/api/auth/*`, `src/app/api/health`, `src/app/api/integration/inbound`;
  - a test-only `src/app/api/test/*`;
  - every page's actor lookup, through one guard.
- **Integration:** `src/server/domain/sourceImport.ts` (provenance fields only), new `src/server/integration/*`.
- **UI:** `src/components/shell/*` (session indicator, lock screen, sign-out); a reconciliation view; targeted accessibility, touch-target and print fixes.
- **Scripts:** `scripts/` for backup, restore, verification and audit verification.
- **Tests:**
  - `tests/domain/auth*.test.ts`, `audit-seal.test.ts`, `receipts.test.ts`, `contract/*.test.ts`, `backup.test.ts`;
  - `tests/e2e/accessibility.spec.ts`, `print.spec.ts`, `source-conflict.spec.ts`, `auth.spec.ts`.

## 6. Acceptance tests (each named in the phase's verification)
| Area | Tests |
|---|---|
| **Security** | No session → 401 or a redirect, and no data rendered. Expired or idle session refused. Unauthorized role refused for reads and writes. Cross-lab session refused. A direct API call without a session refused. A forged demo cookie ignored in secured mode. A role change takes effect on the next request. Re-authentication enforced for sensitive commands. Provider unavailable → sign-in fails closed with a clear message. |
| **Audit** | Each event names the authenticated actor. Controlled edits, deletions and reordering are detected. The chain survives backup and restore. Expired receipts are compacted, and a compacted key is still refused. |
| **Integration** | The 12 simulator scenarios plus contract validation: valid accepted, invalid rejected with a reason, duplicate ignored, reordered reconciled, conflicting identifiers never merged, outage and recovery without duplicate cases, provenance kept. |
| **Operational** | The Stage 5 regression suites (367 unit + 77 browser) stay green. |
| **Accessibility** | axe checks on Intake, Worklist, Materials, Operations, Clarify and the console. Keyboard-only flows and focus after errors. Print PDF checks. |

## 7. Deferred on purpose
- A real identity provider tenant, real credentials and production activation (**blocked**: needs an institutional decision).
- Multi-lab data partitioning; provider-group role mapping.
- SQLCipher or database-level encryption (relies on volume encryption plus deployment controls; documented).
- An external, independent audit anchoring service (anchors are exported to a file; the operator stores them).
- Real HL7 v2 or FHIR transport; real printers, scanners and instruments.
- A genuine screen-reader session (requires a human; a checklist is provided).
- Paper printing on a real printer (print-to-PDF only).
- Everything in the Stage 7 proposal: twin, equipment, IHC QC, AI.

## 8. Execution
Phases run A → B → C → D → E → F. Each phase gets:
- one implementation pass with disjoint file ownership;
- one verification pass (tsc, vitest, the affected browser suites, then the full suite at the end of the phase);
- at most one corrective pass, then a commit.

A blocker is reported, not looped on.
