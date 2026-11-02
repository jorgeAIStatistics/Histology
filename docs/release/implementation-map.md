# Stage 5 implementation map

*Written 2026-10-18 after inspecting the repository. Baseline at the start of Stage 5: `npx tsc --noEmit` clean; `npx vitest run` 283/283; `npx playwright test` 17/17 on a production build. The Stage 4 redesign is uncommitted on `main` (last commit 356cab1).*

## What exists
- **One write path.** Every state change goes through `POST /api/commands/<name>` → `executeCommand` (`src/server/commands/registry.ts`). That path:
  - validates input with zod;
  - checks the role server-side (`requirePermission`);
  - runs the handler in one SQLite transaction;
  - writes an append-only `audit_event`, with triggers that forbid UPDATE and DELETE;
  - stores a `command_receipt` for idempotency.
- **Roles.** Actors come from a demo role cookie (`hlos_actor`, `src/server/session.ts`). This is documented as "not authentication".
- **Concurrency.** Optimistic version checks (`updateVersioned`) protect the records people edit: intake items, clarifications, holds, gross records, routing rules, trays (complete), tasks. Event-style commands (scan, advance, create) rely on state preconditions in the domain modules.
- **Domain.** Holds are scoped by entity, with blocked transitions per hold. Readiness is derived (`src/server/domain/readiness.ts`). Blocks keep `current_location_id` as the last confirmed location, plus `location_confirmed_at/by` and an append-only `custody_event` log.
- **Screens.** Intake, Clarify, Gross, Worklist, Materials, Operations, Case, Insights, Demo, Settings. At baseline, presenter controls were in the top-bar presenter menu, on `/demo`, in Settings › Demo, and in collapsed "Presenter controls (demo)" disclosures on Intake and Clarify. *(Resolved in Stage 5 C5: all of them now live on the presenter console at `/demo`; see verification.md.)*

## Missing, unsafe or incomplete
| # | Finding | Evidence | Severity |
|---|---|---|---|
| S1 | Idempotency replay returns a stored result before resolving the actor, validating input or checking permission. It compares the command name only. A different actor, or a changed payload with the same key, gets the earlier result. The lookup runs outside the write transaction. | `registry.ts` `executeCommand` | Release blocker for any non-synthetic use |
| S2 | A cookie value of `system` maps to the internal `SYSTEM_ACTOR` (supervisor role) for HTTP requests. | `registry.ts` (`actorId === "system"`), `session.ts` accepts the value | High, demo-only today |
| S3 | No runtime gate separates the synthetic demo from a production-capable mode. The role switch, demo reset, simulator commands (`permission: null`) and `/concepts` are reachable in any build. | `session/route.ts`, `demo/reset/route.ts`, `commands/admin.ts`, `demo.ts`, `proxy.ts` | Release blocker for any non-synthetic use |
| S4 | No authentication or identity provider. | `session.ts` | Production blocker (not fixable in Stage 5 without inventing a false model) |
| S5 | `correlation_id` is minted per command (`c-<time>`), not per HTTP request. Receipts are not linked to audit events. | `context.ts`, `audit.ts` | Medium (audit traceability) |
| W1 | Two commands accept an optional `expectedVersion` (stale overwrite possible when omitted). Several consequential event-style commands have no version check; preconditions still to be confirmed per command. | `docs/release/mutation-audit.md` (A2) | To audit in A2 |
| W2 | Presenter-only controls sit on bench screens (Intake, Clarify). | Stage 4 README | UX/safety (C5) |
| U1 | At 1366–1535 the navigation group (549px) is wider than the scan field. | Stage 4 measurement | C2 |
| U2 | The REL-0112 centre decision fits 1366×768 with about 10px to spare; nothing falls back if it does not fit. | Stage 4 agent report | C3 |
| U3 | Toasts sit bottom-left, over the Intake queue. | `toast.tsx` | C4 |
| B1 | A production build failed twice while a `next dev` server was running, and builds rewrite `tsconfig.json`. | Stage 4 log | C6 |
| R1 | The 140 Intake keyboard/scanner checks live in a scratch script, not in the repository's test suite. | scratchpad | Add to suite (C7/D) |

## Modules that will change
- **Phase A:**
  - `src/server/commands/registry.ts`: scoped idempotency, an atomic claim, correlation.
  - `src/server/session.ts`, `src/app/api/commands/[name]/route.ts`, `src/app/api/session/route.ts`, `src/app/api/demo/reset/route.ts`: mode gate and the actor check.
  - `src/server/db/schema.sql` plus a schema-ensure step for `command_receipt`.
  - New `src/server/runtime-mode.ts`.
  - Fixes in domain modules found by the A2 audit.
  - New tests in `tests/domain/security.test.ts`.
- **Phase B:**
  - `src/server/queries/{operations,worklist,materials,case,intake}.ts`, derived read models only.
  - `src/components/operations/**`, with small additions on screens.
  - A cross-screen consistency test.
- **Phase C:**
  - `src/components/shell/**`, `src/components/ui/toast.tsx`, `src/components/intake/**` (REL-0112 fallback).
  - A new presenter console route.
  - `src/app/fonts.ts`, `next.config.ts`.
- **Phase D:**
  - `tests/e2e/journeys.spec.ts`, `tests/e2e/keyboard-scanner.spec.ts`.
  - `docs/release/*`.

## Dependencies and regression risks
- **Client retry keys.** `src/lib/client/command.ts` already sends one key per user intent with a payload fingerprint, so the scoped replay must accept the client's own retries. Every existing caller sends the same input on retry.
- **Receipt table migration.** The existing presenter DB (`data/histology-lab-os.db`) has the old `command_receipt` columns, so the change must be additive. Demo reset rebuilds from `schema.sql`.
- **Gating defaults.** The e2e suite, the seed and the simulator run as demo mode and `system`. Gating must keep demo mode the default and keep simulator and system origins working in-process, never via HTTP.
- **Presenter move.** Moving presenter controls changes accessible paths used by e2e tests (`tests/e2e/support.ts`, guards). Tests must move with them, at the same strength.

## Out of scope for Stage 5 (explicit)
- Real authentication, SSO, sessions and user administration. Documented as a production blocker; no fake login is added.
- Real LIMS/EMA, scanner, printer or instrument integrations. Adapter boundaries are documented only.
- Any regulatory claim: HIPAA, CLIA, CAP or FDA.
- Clinical prioritization or urgency scores.
- AI in identity or relationship decisions.
- A visual redesign.
- Deployment, publishing or pushing.

## Status at the end of Stage 5 (2026-10-19)
| # | Status | Evidence |
|---|---|---|
| S1 | Fixed: owner, scope, command and payload-bound receipts in one immediate transaction; 24-hour expiry | `security.test.ts`; journeys (repeated request) |
| S2 | Fixed: user requests can never act as `system` | `security.test.ts` |
| S3 | Fixed: `HLOS_MODE` gate, fail-closed (401/403/404; the console and `/concepts` are 404) | `security.test.ts`, `presenter.test.ts`, locked-build check in [verification.md](verification.md) |
| S4 | **Open, production blocker** (no identity provider) | [security-privacy.md](security-privacy.md) |
| S5 | Fixed: one correlation id per request on every audit row and receipt | `security.test.ts` |
| W1 | Fixed: see [mutation-audit.md](mutation-audit.md) | `integrity.test.ts` |
| W2 | Fixed: presenter console at `/demo`; no presenter control on bench screens | `presenter-console.spec.ts` |
| U1 | Fixed: icon-only jobs below 1536px; the scan field is the widest item | Lead measurement; `presenter-console.spec.ts` |
| U2 | Fixed: REL-0112 is resilient at 1366×768, 125% text, 1024 and 200% zoom | `intake-keyboard.spec.ts` |
| U3 | Fixed: toasts sit bottom centre; warnings persist | `toast.tsx` |
| B1 | Fixed: self-hosted fonts; builds never rewrite `tsconfig.json` | [verification.md](verification.md) |
| R1 | Fixed: 19 keyboard and scanner browser tests in the suite | `intake-keyboard.spec.ts` |
