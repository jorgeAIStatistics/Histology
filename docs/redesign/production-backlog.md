# Production backlog (not part of the redesign)

*Kept separate on purpose. The redesign changed presentation only; none of the items below is built, and none is implied by the demo. Every item needs the laboratory's own decision, data and approval before work starts.*

| # | Area | What the demo does today | What production would need |
|---|---|---|---|
| 1 | Authentication and authorization | "Acting as" is a demo role switch stored in a cookie (`hlos_actor`); it is not a sign-in. The server checks the role on every command. | Real identity (the lab's SSO), sessions, per-user audit identity, role administration, break-glass rules, automatic sign-out at shared bench workstations. |
| 2 | Integration contracts | EMA-SIM is an in-process simulator: orders, amended orders, accession issue and acknowledgements are synthetic messages. No live EMA connection and no scraping of any EMA session. | Written interface contracts with the vendor/lab IT (message types, identifiers, versioning, retries, ordering, error replies), a test environment, and a contract test suite run before any go-live. |
| 3 | Printer acknowledgments | Print outcomes (printed, failed, unknown) come from a simulator; an unknown outcome must be reconciled before a reprint. | Real printer/driver status, per-label confirmation where the hardware supports it, a defined reconciliation procedure, validated label stock and formats (the DataMatrix preview is screen-only and not validated for scanners, solvents, processors or stainers). |
| 4 | Database migrations | SQLite file recreated from `schema.sql` and synthetic seed on reset. | A managed database, versioned forward-only migrations, rollback plan, data retention rules. |
| 5 | Monitoring | None beyond the source-freshness indicator (simulated). | Uptime and error monitoring, interface queue depth and age alerts, audit-log integrity checks, on-call ownership. |
| 6 | Backup and recovery | None. | Scheduled encrypted backups, restore tests, a documented downtime procedure (paper fallback). |
| 7 | AI evaluation | The assistant (dictation-to-fields proposals, routing suggestions) is deterministic demo logic; nothing is learned and every proposal needs explicit confirmation. | A written intended use, a locally collected evaluation set, error analysis by field, monitoring after release, and a decision on whether any AI belongs in the workflow at all. No accuracy figure is claimed. |
| 8 | Command-receipt replay review | See below. | Bind replays to actor, scope and payload. |

## 8. Command-receipt replay path: what the code does today

`src/server/commands/registry.ts` (`executeCommand`) looks up `command_receipt` by idempotency key **before** it resolves the actor, validates the input or checks the permission. If a receipt exists and its `command` name matches, it returns the stored `result_json` with `replayed: true`. It does not compare:

- **the actor**: `actor_id` is stored but not checked, so a different demo role presenting the same key receives the first caller's result, including a role that could not run the command;
- **the scope**: there is no session, tenant or entity binding beyond the key itself;
- **the payload**: a request with the same key but different input returns the old result, and the caller may believe its new input was applied.

A replay never executes the handler, so it does not change state or bypass a write. The exposure is disclosure of a prior result and a misleading "success" for a changed request. In the local demo, keys are random per user intent and roles are a cookie, so the practical risk is low. For production:

1. Check the permission (and resolve the actor) before returning a replay.
2. Store and compare `actor_id`, a scope (session or tenant) and a hash of the validated input; a mismatch returns an error, never the stored result.
3. Expire receipts after a bounded window.
4. Add tests for each mismatch.

This was recorded, not changed. The redesign brief required keeping the existing server-side safeguards untouched.
