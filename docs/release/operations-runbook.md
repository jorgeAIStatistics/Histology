# Operations runbook (Stage 6, Phase E)

*2026-10-19, branch `stage-6-production-foundation`. Synthetic data only. This runbook describes what the application provides and what to do with it. It is not a compliance document, and nothing here says the application meets any regulation or accreditation requirement. The frequencies, retention and alerting below are suggestions; the laboratory decides them.*

Related records: `backup-restore.md` (backups and the drill), `audit-integrity.md` (the audit seal and anchors), `data-protection.md` (secrets, encryption, retention), `auth-architecture.md` (sign-in and sessions).

## 1. Reading the logs

The server writes **one JSON object per line**. `info` and `debug` lines go to stdout; `warn` and `error` lines go to stderr. `HLOS_LOG_LEVEL` (`debug`, `info`, `warn` or `error`; default `info`) sets the threshold. The application stores no logs: retention is the deployment's job, and the logs need the same encrypted storage as the database (`data-protection.md`, section 3).

**One `http.request` line per API request** on the command route, the auth routes, the integration inbound route and the health routes (`src/server/ops/request-log.ts`). These are real lines from the drill server (`backup-restore.md`, section 4). The first request was `POST /api/commands/clarification.create?patient=Kettering`: the query value is not in the line, and neither is the input.

```json
{"ts":"2026-10-19T19:14:42.891Z","level":"info","event":"http.request","correlationId":"req-0f919a5c-63d3-4a40-840f-51c774da81db","method":"POST","route":"/api/commands/[name]","status":200,"durationMs":8.6,"actorId":"stf_maya","command":"clarification.create"}
{"ts":"2026-10-19T19:15:01.624Z","level":"info","event":"http.request","correlationId":"sim-4e70ed286559f3a8bcfc97a2","method":"POST","route":"/api/integration/inbound","status":200,"durationMs":5.3,"actorId":null}
{"ts":"2026-10-19T19:16:26.985Z","level":"info","event":"http.request","correlationId":"req-6923d022-f5d0-49e3-9707-473234cb1410","method":"GET","route":"/api/health/details","status":200,"durationMs":0.9,"actorId":"stf_tanya"}
```

| Field | Meaning |
|---|---|
| `route` | The route **template**, such as `/api/commands/[name]`. It never holds the request URL or a query value, so sign-in codes, `state` and `returnTo` never reach the log. |
| `status`, `durationMs` | HTTP status, and the time spent in the handler. |
| `correlationId` | The caller's `X-Request-Id` when it is well formed, otherwise a generated `req-<uuid>`. The same value is in the command's `X-Correlation-Id` response header and in `audit_event.correlation_id`. |
| `actorId` | The acting staff id. It is never a name. It is `null` when nobody was resolved: a guard refusal, the sign-in start and callback, the integration source, or the public health check. |
| `command`, `code` | A registered command name (an unregistered name is logged as `unknown`), and the error code of a refused request (`FORBIDDEN`, `VALIDATION`, `SESSION_LOCKED`…). |
| `level` | `error` for a 5xx or a thrown handler (with `error: {name, code, message, at}`, scrubbed), otherwise `info`. |

Other events keep their own names: `command.unexpected_error`, `integration.inbound_refused`, `auth.callback_without_transaction`, `receipts.maintenance_failed`, `health.*` and so on.

Useful filters (`jq`):

```sh
jq -c 'select(.event=="http.request" and .status>=500)'              # server errors
jq -c 'select(.event=="http.request" and (.status==401 or .status==403))' # refusals
jq -c 'select(.correlationId=="req-…")'                              # everything one request did
```

To follow one request into the audit trail, look up the correlation id in `audit_event.correlation_id` (read-only), or use the `/audit` evidence.

**Never in a log line:** cookies, session ids, tokens, secrets or keys (redacted by field name and scrubbed from every string), request bodies or command input, or patient fields. Long digit runs and birth-date-like dates are scrubbed. **Limitation:** a person's name inside free text, such as an exception message, cannot be recognised by pattern (`src/server/core/log.ts`).

## 2. Health states and what to do

| Endpoint | Who | Answer |
|---|---|---|
| `GET /api/health` | Anyone (load balancer, uptime monitor) | Only `{ "status": "healthy" \| "degraded" \| "unavailable", "time" }`. HTTP 200 for healthy and degraded, **503 for unavailable**. |
| `GET /api/health/details` | Secured mode: a signed-in **laboratory administrator or auditor** (`view.audit`). Demo mode: any demo role. Locked build: 401. | Every check, each `{ status, detail, measured_at }` with a few coarse numbers, plus the rules. It never contains patient data, credentials, cookies, tokens, keys or file paths. In secured mode a monitoring tool cannot read it without a signed-in session. Only the public endpoint is meant for machines. |

**Rules** (`src/server/ops/health.ts`, `HEALTH_RULES`):
- **unavailable**: the build is locked (not configured, so it serves nothing), or the database cannot be read or written.
- **degraded**: any check is `warn` or `fail`. The application still serves requests.
- **healthy**: every check is `ok` or `unknown`.

| Overall | What to do |
|---|---|
| healthy | Nothing. |
| degraded | Open `/api/health/details` as the administrator or auditor, find the `warn` or `fail` check, and act on it (table below). Do **not** take the node out of service for this alone. |
| unavailable | A **locked** build: the `/locked` page deliberately shows nothing about the configuration. Read the server log instead: the line `runtime.locked_misconfigured` names the missing or invalid settings (never their values). Fix the environment and restart. Never switch to `HLOS_MODE=demo` to get it running. A **database** failure: check the disk (full, read-only, permissions), the volume mount, and whether another process holds the write lock. Do not delete `-wal` or `-shm` files. If the file is damaged, restore the newest verified backup into a **new** path (section 5), review it, then repoint `HLOS_DB_PATH`. |

| Check | `warn` / `fail` means | Action |
|---|---|---|
| `process` | The heap is above 90% of its limit | Watch for growth. Restart in a quiet period, and report it. |
| `database` | `fail`: a read, or the rolled-back write probe, failed (the SQLite code is named). `warn`: the write lock stayed busy for more than 1 s, or a read took over 500 ms. | `fail`: as for unavailable. `warn`: look for a long-running writer (a maintenance run, an external `sqlite3` session) and for disk latency. |
| `audit_chain` | `fail`: the last background verification found a problem (kind and seq given). `warn`: no audit key, an unusable anchor file, or a result older than twice the interval. `unknown`: not verified yet by this process. | Section 3. A verification runs in the background at most every `HLOS_HEALTH_AUDIT_VERIFY_MINUTES` (default 15), **never inside the request**. On a large trail each run takes time on the server's single thread. |
| `receipt_maintenance` | Receipts that expired more than a day ago are not compacted, tombstones are more than a day past their retention, or `HLOS_RECEIPT_TOMBSTONE_DAYS` is invalid | Section 4. |
| `integration_sources` | A source is `offline` or `degraded`. Times are on the application clock, which is the demo clock in the synthetic demo. | Check the source and the network. The screens already mark offline data as stale. The failure queue and the reconciliation view show what is waiting. |
| `import_failures` | One or more messages are in the import failure queue. Nothing was applied from them. | Review and retry them from Operations (supervisor). The reconciliation view (`/integration`) shows each one. |
| `backup` | The newest manifest in `HLOS_BACKUP_DIR` (default `data/backups/`) is older than `HLOS_BACKUP_MAX_AGE_HOURS` (default 26) or unreadable. In secured or locked mode, `warn` also means no manifest was found. In demo mode no manifest is `unknown`. | Run a backup (section 5). The check sees only that directory. A backup kept elsewhere (`--out`) is invisible to it. **Age is not proof**: only a restore proves a backup. |

The health check does **not** contact the identity provider (section 6), and it does not prove that backups restore.

## 3. Verifying the audit chain

```sh
HLOS_AUDIT_KEY=… HLOS_AUDIT_ANCHOR_PATH=/elsewhere/anchors.jsonl npm run audit:verify   # exit 0 verified, 1 problem, 2 configuration
HLOS_AUDIT_KEY=… HLOS_AUDIT_ANCHOR_PATH=/elsewhere/anchors.jsonl npm run audit:anchor   # verify, then append the head
```

- Run `audit:anchor` at least daily, and before and after any maintenance window. Keep the anchor file where the database's administrators cannot change it. The `/audit` page ("Verify again", "Download evidence") does the same for the administrator and the auditor. The health check reports the last background result.
- **On a failure** (`event_modified`, `event_missing`, `seal_missing`, `seal_forged`, `chain_broken`, `reordered`, `unsealed_tail`, `anchor_mismatch`):
  1. Do not write to or "repair" the database.
  2. Copy the database files and the anchor file as they are (a backup with `npm run db:backup` is fine: it does not change the source).
  3. Download the evidence from `/audit`.
  4. Restore the newest backup whose manifest says `verified_at_backup.ok: true` into a **new** path, and compare.
  5. Escalate under the laboratory's incident procedure.

  `unsealed_tail` after a run in locked mode without a key is expected until the next keyed write (`audit-integrity.md`, section 2.3).
- **Demo builds** seal with the public demo key, which proves nothing.

## 4. Receipt maintenance

```sh
npm run maintenance                 # compact expired receipts, purge old tombstones (prints counts)
npm run maintenance -- --batch 200
```

- Safe while the application runs: small batches, each in its own short transaction, and audit events are never touched. Run it **daily**. The server also runs one bounded batch at most every 10 minutes after a command.
- `HLOS_RECEIPT_TOMBSTONE_DAYS` (default 30) sets how long tombstones are kept. An invalid value skips the purge and exits 2. The health check then warns.
- The health check works out "has maintenance run?" from the receipts themselves (`compacted_at`), so it covers both the opportunistic run and the CLI. `last_compaction_at` is the last time something was compacted, not the last time maintenance ran.

## 5. Backup and restore drill

Full record, measured output and limitations: `backup-restore.md`.

```sh
export HLOS_BACKUP_KEY=…   # from the secret store; 32 bytes (openssl rand -hex 32); not the audit key
npm run db:backup                                     # → data/backups/<id>.sqlite.enc + <id>.manifest.json
npm run db:restore -- data/backups/<id>.manifest.json --target /isolated/restore-YYYYMMDD.db --anchors /elsewhere/anchors.jsonl
```

- `db:backup` refuses without a key except on the synthetic demo database in demo mode. It never writes into `public/` or the database's own directory. Exit codes: 0 done, 1 the snapshot failed `integrity_check` (written and flagged), 2 refused.
- `db:restore` never overwrites anything. It refuses an existing target, a stale `-wal`, `-shm` or `-journal` file beside it, and the live database or its companion files. It verifies before and after writing. Exit codes: 0 every check passed, 1 a check failed, 2 refused.
- **Drill at least monthly and after every upgrade**: restore the newest backup into an isolated path, read the report, then delete the restored copy. A restored database holds nothing written after its backup.

## 6. When sign-in fails (provider unavailable)

**Symptoms:**
- The sign-in page says "The sign-in service could not be reached" (`/signin?error=provider_unavailable`).
- `auth.denied` audit events with reason `provider_unavailable`, at most one per minute, with a count of the repeats.
- `http.request` lines for `/api/auth/login` or `/api/auth/callback` that answer a 303 redirect to that page.

People who are already signed in keep working until their session expires, locks or is signed out. Nothing is signed in without the provider, and there is no bypass.

Check, in order:
1. **Is the provider reachable from the server host?**
   ```sh
   curl -sS -m 10 "$HLOS_OIDC_ISSUER/.well-known/openid-configuration" | head -c 300
   ```
   Look at DNS, TLS (certificate chain and expiry), an outbound proxy or firewall, and the provider's status page. Discovery times out after 10 s. A failure is not cached, so the next sign-in tries again, and a success is cached for 10 minutes.
2. **Is the configuration intact?** If a key is missing or invalid, the build is **locked**, not "provider unavailable". The server log line `runtime.locked_misconfigured` names the failing settings (the `/locked` page shows none). Has the client secret been rotated at the provider and not in the environment? The callback then fails as `token_invalid`, not `provider_unavailable`.
3. **Redirect URI.** `HLOS_PUBLIC_URL` + `/api/auth/callback` must be registered at the provider exactly as written.
4. **Clocks.** Skew between the server and the provider makes ID tokens look expired or not yet valid (`token_invalid`), or the authentication look stale (`reauth_not_fresh`). Check NTP.
5. **Other denial reasons are not outages:**
   - `unlinked`, `inactive` or `wrong_lab`: an administrator links or activates the staff member (`npm run admin`), or checks `HLOS_LAB_ID` and `HLOS_OIDC_LAB_CLAIM`.
   - `bad_state`: an expired or replayed sign-in, or one started in another browser. Start again.

Never work around an outage by switching the build to demo mode or by creating sessions by hand. Demo mode refuses a database with linked identities anyway (`assertSyntheticForDemo`).
