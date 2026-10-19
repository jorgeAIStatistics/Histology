# Stage 6 verification evidence

*2026-10-19, branch `stage-6-production-foundation`. Every run used synthetic data on this machine. A passing test shows that the code does what the test says. It is not clinical validation and not a compliance claim.*

## 1. Final gates (fresh runs after the last code change)
| Gate | Result | How |
|---|---|---|
| Stage 5 baseline (start of Stage 6) | tsc clean; vitest **367/367**; Playwright **77/77** | Fresh runs on `c48007b` before any Stage 6 change |
| Type check | Clean | `npx tsc --noEmit` |
| Unit, integration and contract tests | **638 passed, 0 failed, 0 skipped** (33 files) | `npx vitest run` |
| Demo browser suite | **136 passed, 0 failed** (13 specs, 3.8 min) | `E2E_TAG=final6 npx playwright test` on a fresh production build |
| Secured browser suite | **26 passed, 0 failed** (43.9 s) | `npm run test:e2e:secured`: a real local OIDC provider (`oidc-provider`), the app in `HLOS_MODE=secured` with synthetic data and linked test identities |
| Clean production build | Exit 0, **0 warnings**; `tsconfig.json` not rewritten; no network needed | `rm -rf .next && npm run build` |
| Colour contrast | 0 failing pairs at 1366px | `node scripts/contrast-check.mjs` on the demo build |
| Locked build (no `HLOS_MODE`) and misconfigured secured build (`HLOS_MODE=secured`, no OIDC configuration) | Every page → 307 `/locked`; `/api/live` 401; `/api/health` 503; `/api/health/details` 401; `/demo` → `/locked`; inbound 404; commands 401; **no database opened or created** | curl against `next start` on both |
| Demo build health | `/api/health` healthy; details lists process, database (rolled-back write probe), audit, receipts, sources, failure queue, backups | curl |

## 2. Unit and integration tests by file (638)
| Area | File (tests) |
|---|---|
| Stage 5 regression | `intake` (51), `integration` (46), `clarifications` (40), `demo` (39), `materials` (38), `integrity` (32, +1 multi-item source-conflict history), `grossing` (25), `consistency` (23), `security` (20), `worklist` (20), `case` (10), `operations` (10), `presenter` (8), `foundation` (6) |
| Phase A | `test-fixtures` (12): fixture gate, token, catalog determinism |
| Phase B | `auth` (38): modes, sessions, idle lock, expiry, revocation, role change, lab scope, forged demo cookie, actor mismatch, re-authentication, presenter refusal, `lab_admin`/`auditor` denial, `identity.resolve`, open redirect, concurrent updates. `oidc` (14): real code flow with PKCE against `oidc-provider`, unlinked subject, wrong lab claim, state replay, nonce mismatch, provider unavailable, forced login, anonymous audit growth. `demo-db-guard` (5). |
| Phase C | `audit-seal` (23): each tamper kind, anchors, CLI, verify API. `traceability` (5). `receipts` (10). `audit-phi` (12). `privacy` (12). `log` (11). |
| Phase D | `contract/boundary` (31), `guarantees` (12), `scenarios` (15), `reconciliation` (6), `http` (6, real HTTP), `pump` (3) |
| Phase E | `backup` (17): real cycle, tamper detection, restore refusals, no plaintext in the encrypted file. `health` (16). `recovery` (22). |

## 3. Browser tests by spec
**Demo suite (136):**

| Spec | Tests |
|---|---|
| `journeys` | 38 |
| `accessibility` (new) | 19 |
| `intake-keyboard` | 19 |
| `source-conflict` (new) | 11 |
| `integration` (new) | 11 |
| `director-journey` | 8 |
| `guards` | 8 |
| `recovery` (new) | 5 |
| `polish` (new) | 5 |
| `print` (new) | 4 |
| `target-size` (new) | 4 |
| `presenter-console` | 3 |
| `demo-step3-presenter` | 1 |

**Secured suite (26):** `tests/e2e-secured/auth.spec.ts`. It covers:
- no session gives no data;
- sign-in through the provider form;
- a forged demo cookie is ignored;
- role denials, including `lab_admin` and `auditor`, who land on `/audit`;
- unlinked and other-lab users are denied;
- lock (the page content leaves the DOM; Back shows nothing) and unlock;
- hand-over gives `ACTOR_MISMATCH` with nothing recorded;
- re-authentication flow;
- an expired session during a mutation;
- sign-out (the old cookie gets 401);
- the provider being unavailable;
- the secured top bar at 200% zoom;
- Lock and Sign out on `/forbidden`.

## 4. Defects found by Stage 6 tests and reviews, and fixed
| Phase | Defect | Proof |
|---|---|---|
| A | Production build failed: archived concept previews fetched Google Fonts at build time | Build exit 0 offline |
| A | A source-conflict review recorded History on only one of the held intake items | `integrity.test.ts` |
| A | Focus fell to `<body>` when a loading button was disabled; a dialog error was hidden behind its modal; failure banners were not announced | `accessibility.spec.ts` |
| A | An HTTP 500 was titled "Some fields need attention" | `recovery`, journeys |
| A | Print: later pages had no doctor heading, columns overlapped, identifiers split, blocked lists were truncated | `print.spec.ts`; PDFs in `evidence/print/` |
| B | **High:** the provider's single sign-on bypassed lock and sign-out (a fresh sign-in did not force authentication) | `oidc.test.ts`, secured suite |
| B | **Medium:** `correction.close` released holds without re-authentication | `auth.test.ts` |
| B | Background refreshes counted as session activity | `auth.test.ts`, secured suite |
| B | Demo mode would serve any database, including a secured deployment's | `demo-db-guard.test.ts` |
| C | Patient snapshots (name, birth date) duplicated in audit payloads | `audit-phi.test.ts` |
| D | The Settings integration log showed a raw channel word | — |
| E | The client could report success for `{ok:"true"}` or for a non-2xx answer; a reopened form lost its idempotency key (double recording possible) | `recovery.test.ts`, `recovery.spec.ts` (failed on the old build) |
| E | Storage failures were shown as "Someone else changed this item"; unexpected errors as a validation problem | `recovery.test.ts`, `privacy.test.ts` |
| E | Outside demo mode a missing database was silently created empty | `demo-db-guard.test.ts`, `auth.test.ts` |
| F | Nine measured operator issues (F1–F9): see [operator-ux-stage6.md](operator-ux-stage6.md) | `polish.spec.ts` (fails 5/5 on the old build), secured suite |

## 5. Known open items (not fixed, with reasons)
- **Security review, finding 7:** refusals of signed-in users are not audited. Deferred: it needs a decision on event naming and rate limits.
- **Security review, low and suspected:** the session id is not rotated on re-authentication; the audit subject reference is unsalted.
- **Phase F:**
  - N2: a non-modal side panel covers page controls at 200% zoom. Needs a design decision.
  - N3: axe `scrollable-region-focusable` (serious) on the Intake decision column at 20px text. The content is reachable through the "More below" cue; making the scroller a tab stop would change the pinned Intake tab order.
  - N4: the top bar's fixed 52px height at 20px text (about 1.5px overhang).
- **Health:** a disk-full database can still pass the small write probe; monitoring tools can only use `/api/health` in secured mode (there is no service-account path).
- **Not run at all:** screen readers, paper printing, real hardware, other browsers (Chromium only), a real identity provider, a real LIS. See [production-readiness.md](production-readiness.md).

## 6. Stage 6 commits
- `1d54952` Phase A: Stage 5 gaps
- `dfc9b3f` Phase B: authentication and authorization
- `5ef097c` Phase C: audit integrity and privacy
- `4a98213` Phase D: integration boundary
- `3f59ed3` Phase E: backup, health, recovery
- Phase F and documents: the final commit on this branch
