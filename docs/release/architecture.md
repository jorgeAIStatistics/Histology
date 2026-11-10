# Architecture: how state moves (release candidate, Stage 5)

*Synthetic demo. Describes the code as it is, not a plan. Paths are under `src/`.*

## 1. One write path, many read models
```
browser ──POST /api/commands/<name> {input, idempotencyKey}──▶ app/api/commands/[name]/route.ts
   │        (demo mode only; actor = demo role cookie; X-Correlation-Id)
   ▼
server/commands/registry.ts  executeCommand
   ├─ mode gate (runtime-mode.ts) ─ actor (never "system" for users) ─ zod input
   └─ ONE immediate transaction:
        idempotency lookup (core/idempotency.ts) → permission (core/context.ts)
        → handler (server/domain/*.ts) → receipt
        handler writes records + audit_event (core/audit.ts, append-only)
                 + worklist feed (core/feed.ts) + tasks (core/tasks.ts)
   ▼
pages (server components) ── server/queries/*.ts ── derived read models
GET /api/live (polled) ── change counters → router.refresh()
```

- **Authoritative data.** The SQLite tables are authoritative (`server/db/schema.sql`). Screens never store state of their own. They read derived models in `server/queries/*`, which share helpers so one fact is computed one way:

  | Fact | Computed by |
  |---|---|
  | Readiness and stage | `server/domain/readiness.ts` (`computeReadiness`) |
  | Holds | `server/domain/holds.ts` (enforcement: `holdsBlocking`; scope chains: `scopesForPart/Block/Slide/Intake`) |
  | Next step and owner of a hold | `server/queries/hold-next.ts` (Operations, Case, Grossing, Clarify) |
  | Routing | `server/domain/routing.ts` (`currentRouting`) |
  | Source-entry backlog | `lib/domain.ts` (`awaitsSourceEntry`) |
  | Shared predicates | `server/queries/predicates.ts` |

- **Simulated systems.** The source (EMA-SIM), office, printer, courier and accession issuer are simulators in `server/sim/*`. They enter through the same domain functions with origin `simulator` or `import`. `pumpSources` (behind `GET /api/live`) runs only in demo mode.

## 2. Lifecycles the code supports
Each state name is the stored value. Optional steps are marked (opt).

| Entity | States | Notes |
|---|---|---|
| Intake item | `received` → `in_review` → `accession_requested` → `accessioned`; or `canceled` | `ready_for_accession` exists in the schema but is never written: readiness to accession is derived (`accessionBlockers`). A request can stay `submitted` while the simulated source is offline. It appears under Operations › Integration. |
| Container check | `unverified` → `verified` or `discrepancy` | Editing an observation returns it to `unverified`. A lead may accept a non-identity difference with a reason. A patient-identity difference needs an `identity_conflict` clarification resolved as "order is correct". |
| Routing decision | `suggested` or `exception` → `confirmed` or `overridden` → `superseded` | Rules only suggest. An exception needs a lead and a reason. An override requires the decision id the lead saw. |
| Related-order candidate | `pending_review` → `single_accession_approved`, `keep_separate`, `not_related` or `escalated_to_office` | Proposal only; never merged. |
| Clarification | `drafted` → `sent` → `delivered`, `delivery_unknown` or `delivery_failed` → `acknowledged` (opt) → `answered` → `reviewed` → `resolved`; or `canceled` | An answer never resolves by itself. |
| Hold | `active` → `released` | Released by its own command, with a reason. Scoped to an intake item, order part, specimen part, block, slide, work order or the whole case. Blocks named transitions only. |
| Correction review | `open` → closed outcomes | Opened when the source amends an issued part. It places a part hold (gross approval, print, tray delivery) until closed. |
| Source conflict | open task → reviewed by a lead (`details_on_file_confirmed`, with a reason) | Blocks accession while open. The patient on file is never changed. |
| Gross record | `draft` ⇄ `needs_clarification` → `operator_reviewed` → `approved_for_downstream` → `superseded` (an amendment opens a new draft) | Source update: `not_started` → `pending_entry` → `entered_attested` → `source_acknowledged` (simulated). |
| Part stage (derived) | `awaiting_gross` → `gross_in_progress` → `awaiting_processing` → `processing` → `embedding` → `sectioning` → `staining` → `qc` → `ready_for_tray` → `delivered` ("Sent on tray") | Cassettes exist only after gross approval. "Sent on tray" records no pathologist receipt. |
| Block | `cassette_loaded` → `processing` → `processed` → `embedded` → `sectioned` → `stored` | One stage per command. Custody (`in_workflow`, `stored`, `checked_out`, `missing_investigation`, `sent_out`) and `current_location_id` mean the **last confirmed** location only. |
| Slide | `planned` → `sectioned` → `stained` → `coverslipped` → `qc_reviewed` → `delivered` (tray) | Labels: `none` → `printed` → `applied` → `verified` → `retired`. A tray accepts only label-verified, active, unheld slides. |
| Tray | `open` → `assembling` ⇄ `exception` → `verified_complete` or `released_with_exceptions` → `delivered` | One scan per slide. A completion with exceptions needs a supervisor and the version they saw. |
| Retrieval item | `pending` → `picked` or `missing_investigation` → `delivered` → `returned` | Delivery records a hand-over. The confirmed location changes only on a scan or a return to a slot. |
| Print job | `submitted` → `acknowledged`, `completion_confirmed` or `unknown_outcome` → reconciled | An unknown outcome blocks any reprint until it is reconciled. |

**Known, expected unknowns (shown as unknown, never as done):**
- the number of blocks before a gross record lists cassettes;
- the expected count when an office sends no manifest;
- the location of a block before its first confirmation.

## 3. Human control
**Never automatic:**
- patient-identity decisions;
- related-order decisions;
- accepting a discrepancy;
- routing overrides and exceptions;
- clarification resolution;
- hold release;
- gross approval;
- tray completion.

Each needs a named role and is audited, with a reason where the domain asks for one. The assistant (`server/assist`) only proposes values that need explicit confirmation. Import code never overwrites a patient, office or encounter.

## 4. Events and history
`audit_event` records, for every change:
- actor, role and origin (`user`, `demo`, `simulator`, `import`, `system`);
- action, entity, before and after;
- reason;
- correlation id.

Refused attempts (`command.denied`) and refused key reuse (`command.idempotency_rejected`) are recorded too. Receipts link to their audit rows through the correlation id. The case History tab and Operations read these.

## 5. Stage 6 additions
```
request ── proxy.ts (optimistic: locked → /locked; secured page without cookie → /signin)
   ▼
server/auth/guard.ts (authoritative, one place)
   demo:    demo role cookie → actor            secured: session cookie → auth_session (hashed id)
            view.* permission per page/API               idle lock, expiry, revocation, lab scope,
                                                         staff active, role read fresh, X-HLOS-Actor
   ▼
executeCommand (registry.ts)
   mode → actor → permission → (sensitive? fresh auth_time) → zod → scoped idempotency → transaction
   ctx.permission, ctx.sessionRef (HMAC) ─▶ audit() ─▶ audit_event + audit_seal (HMAC chain, same transaction)
   ▼
after commit: opportunistic receipt maintenance (tombstones, purge)
```

- **Integration boundary.** `POST /api/integration/inbound` (demo plus `HLOS_INTEGRATION_SIMULATOR=1` only) and the in-process pump both call `server/integration/inbound.ts handleEnvelope`:
  - the signature, envelope (`hlos.source-message` 1.0) and payload are checked;
  - orders go to `importSourceMessage`; accession messages are compared only.

  `server/integration/reconciliation.ts` is a read model behind `/integration`.
- **Operations:**
  - `server/ops/backup.ts` and `backup-manifest.ts` (backup and verified restore);
  - `server/ops/health.ts` (`/api/health`, `/api/health/details`);
  - `server/ops/request-log.ts` and `server/core/log.ts` (structured, redacted logs).
- **Audit verification:** `server/core/audit-seal.ts verifyAuditChain`, `/audit`, `npm run audit:verify`, and `npm run audit:anchor`.
