# Audit trail integrity, traceability and receipt maintenance (Stage 6, Phase C)

*Design and implementation record, 2026-10-19, branch `stage-6-production-foundation`. Synthetic data only, localhost only. Nothing here is a compliance claim: no statement in this document says or implies that the application meets HIPAA, CLIA, CAP, FDA or any other regulation or accreditation requirement.*

## 1. Summary, and the limitation first

- Every audit event is sealed into an **HMAC-SHA256 chain** in the same database transaction that writes it. A verification routine recomputes the chain and reports the first place where it does not hold.
- This makes the audit trail **tamper-evident, not tamper-proof**. Anyone with write access to the database file can still change it. What changes is that a change made **without the key** is detected the next time the chain is verified.
- **A database-only chain cannot stop someone who holds both the database and the key.** That person can rewrite any event and recompute every seal after it; the chain then verifies.
- **Anchors** (copies of the chain head written to a file outside the database's directory) detect such a rewrite **only for history before the newest anchor**, and **only if the anchor file is stored somewhere that person cannot change**. A rewrite after the newest anchor is not detected.
- This is **not independence from the database administrators**. Whoever administers the database host, the key and the anchor storage together can rewrite history undetectably. Real independence needs the anchors (or the events) to go to a system run by someone else; that is deferred (stage 6 plan, section 7).

## 2. The seal (C1)

Code: `src/server/core/audit-seal.ts`, `src/server/core/audit.ts`. Schema: `src/server/db/schema.audit.sql`, applied to existing databases by `ensureAuditSchema` (`src/server/db/audit-schema.ts`, called by `openDatabase`). Additive only; no row is ever rewritten.

### 2.1 Table `audit_seal`
| Column | Meaning |
|---|---|
| `seq` | Primary key, equal to `audit_event.seq` (foreign key) |
| `event_id` | `audit_event.id` (unique) |
| `prev_mac` | The previous seal's `mac`; for the first event `"genesis:" + the lab scope` (`genesis:lab:local`) |
| `mac` | `HMAC-SHA256(key, prev_mac + "\n" + canonical(event))`, hex |
| `key_id` | The key's name, never the key |
| `sealed_at` | Wall-clock time of sealing (informational; **not covered by the MAC**) |

`canonical(event)` is a JSON array of **every** `audit_event` column in a fixed order (`AUDIT_COLUMNS`), so a change to any column, including `seq`, is detected. A test fails if a column is added to `audit_event` without being added to that list.

Triggers forbid `UPDATE` and `DELETE` on `audit_seal`, and an insert behind the current head. Like the existing `audit_event` triggers, **they only stop the application** (and any client that leaves them in place). Someone with the file drops them; the tests do exactly that.

### 2.2 When events are sealed
- **Every `audit()` call** inserts the event, then calls `sealPending(db)`, which seals every event after the last seal, in `seq` order.
  - Inside a transaction (every command: `executeCommand` runs one `IMMEDIATE` transaction), the seal joins it. The insert holds the write lock, so no other process can seal in between, and a rollback removes the event and its seal together.
  - Outside a transaction (sign-in events, the admin CLI, the verification run), `audit()` wraps the insert and the seal in their own `IMMEDIATE` transaction, so two processes cannot interleave their seals. A test runs commands and direct `audit()` calls from two processes on one file at the same time and verifies the chain afterwards.
- **The seed** (`src/server/seed/**`) inserts its audit rows directly; `seedDemo` seals them all at the end of its transaction.
- **No other code** inserts into `audit_event` directly (checked: the only direct insert is the seed's `seedAudit` builder; everything else goes through `audit()`).
- An event whose `seq` is behind the last seal and has no seal is **never sealed late**: that gap is a finding (`seal_missing`), not something to paper over.
- **A database created before Phase C** has no seals. Its existing events are sealed, in `seq` order, by the first audit write after the upgrade (or by the first keyed write after events written without a key). Those seals only show that nothing changed **after** that moment; they say nothing about what happened to those events before.

### 2.3 Keys
| Mode | Key | Notes |
|---|---|---|
| `demo` | A fixed, **public** demo key in the source code, key id **`demo-not-secret`** | Proves nothing: anyone can recompute these seals. It exists to show the mechanism. The `/audit` page, the CLI and the evidence file all say so. |
| `secured` | `HLOS_AUDIT_KEY` (at least 32 bytes), **required** | A secured build without a valid key is **locked**; the locked reason names `HLOS_AUDIT_KEY`, never its value. The key must differ from `HLOS_SESSION_SECRET` and from the public demo key. |
| `locked` | `HLOS_AUDIT_KEY` when it is set and valid | Without it, events written in locked mode (for example by the admin CLI) are **left unsealed** and reported as `unsealed_tail` until a later write with a key seals them. Until then they can be changed without detection. |

- **Key id:** `HLOS_AUDIT_KEY_ID` when set (letters, digits, `._:-`, up to 64 characters, not `demo-not-secret`); otherwise derived from the key as `k-` plus the first 12 hex characters of an HMAC of a fixed label. It identifies the key; it does not reveal it.
- **One key per database.** Verification uses one key. A database sealed under one key and then written under another (for example, the synthetic seed sealed with the demo key, then run in secured mode) fails verification at the first event sealed under the other key (`seal_forged`, with both key ids named). Key rotation is **not implemented**.
- The synthetic seed, when no key is configured at all (for example `npm run db:reset` without `HLOS_MODE`), is sealed with the public demo key and says so.
- The key lives in the process environment. There is no HSM or key-management service integration; protecting the key is a deployment responsibility.

## 3. Verification

`verifyAuditChain(db, { key, anchors? })` returns `{ ok, checked, sealedThrough, firstProblem: { seq, kind, detail } | null, events, seals, headSeq, lab, keyId, demoKey, anchorsChecked, verifiedAt }`. It is read-only, streams the events and seals in `seq` order, and **stops at the first problem**.

| `kind` | What was found | Typical cause |
|---|---|---|
| `event_modified` | The event no longer matches its seal, and a later authentic seal (or an anchor) vouches for that seal | An event row edited after sealing |
| `event_missing` | A seal exists but its event row is gone; or the autoincrement counter is ahead of the newest event | An event deleted; the newest events deleted |
| `seal_missing` | An event has no seal although a later event is sealed | A seal deleted, or a row slipped in |
| `seal_forged` | A seal does not verify under the key and nothing later vouches for it; or it names another key id | A seal made or altered without the key; a database sealed under another key |
| `chain_broken` | A seal does not link to the previous seal | Events deleted or moved together with their seals |
| `reordered` | The event at a `seq` is not the one sealed there | Rows swapped or moved |
| `unsealed_tail` | The newest events have no seal | Written without a key; added outside the application |
| `anchor_mismatch` | The chain differs from an anchor at the anchor's `seq`, or ends before it, or the anchor is another lab's | History before the anchor rewritten with the key; truncation |

- `kind` is a **best-effort description of the first inconsistency**. For example, when only the newest sealed event fails and nothing later vouches for its seal, it cannot be told whether the event or the seal changed; it is reported as `event_modified`. Detection does not depend on the classification.
- The `event_missing` check on the newest events compares with SQLite's autoincrement counter. It is a **tripwire only**: someone with the file can reset the counter too (a test does), and then only an anchor detects the truncation.
- `sealed_at` is not verified. `key_id` is compared with the verifying key's id.

## 4. Anchors

- `exportAnchor(db)` returns the chain head: `{ lab, seq, mac, key_id, at }`.
- `appendAnchor` (used by `npm run audit:anchor`) **first verifies the chain** (against the anchors already in the file) and **refuses to anchor a chain that does not verify**, then appends one JSON line to `HLOS_AUDIT_ANCHOR_PATH`.
- A path **inside the database's directory, or below it**, is refused (symbolic links are resolved), because an anchor kept next to the database can be rewritten with it. That check cannot know whether another directory is controlled by the same people; choosing storage the database's administrators cannot change (another host, write-once storage, a different administrator) is the operator's job. Nothing in this application uploads anchors anywhere.
- Reading the anchor file **fails closed**: a malformed line or an unreadable file is an error (the `/audit` page then shows "not verified"), not "no anchors".
- What anchors catch: an insider who holds the key and rewrites, deletes or truncates history **before the newest anchor**. What they do not catch: anything after the newest anchor, or anything at all if the same person can also edit the anchor file. Both are covered by tests (the second as a pinned limitation).

## 5. Running verification

| Where | Who | What it does |
|---|---|---|
| `npm run audit:verify` (`scripts/audit.ts verify`, `--json` for JSON) | Whoever runs it on the host | Verifies, with the anchors in `HLOS_AUDIT_ANCHOR_PATH` when set. Prints counts, `seq` numbers, kinds and key ids only, never event content. Exit 0 verified, 1 a problem, 2 configuration error (no key, no database, anchor path refused). It never creates a database; like every other entry point it opens the database through `openDatabase`, which adds the Phase C columns and table to an older database (additive DDL, no row changes). |
| `npm run audit:anchor` | Same | Verifies, then appends the head to the anchor file. Exit 1 when the chain does not verify (no anchor written). |
| `/audit` page | `view.audit`: laboratory administrator and auditor, through the one guard (`requireView`) | Shows chain status, events checked, sealed through, newest event, the first problem, the key id, the last anchor and anchors checked. Offers "Verify again" and "Download evidence (JSON)". Verification runs on every page load (O(number of events)). |
| `POST /api/audit/verify` | `view.audit`; secured: same origin, the session, `X-HLOS-Actor`, counts as activity | Runs verification and returns the report and the evidence. Each run is recorded as an `audit.verified` event (who ran it and the outcome). |

- In the synthetic demo **no demo role holds `view.audit`**, so the page and API answer 403 there; use the CLI with `HLOS_MODE=demo`. The shell's navigation and the role landing page do not link `/audit` (they belong to the shell, outside this phase); the page is reached by its URL.
- **The evidence file** contains: format id, generation time, lab scope, key id and whether it is the demo key, the verification result, the head `{ seq, mac }`, the verified `seq` range, the MAC at every 1000th `seq`, the anchors used, and whether an anchor file was usable. It contains **no event content** (no actor, record, summary, payload or reason). MACs reveal nothing without the key; someone **holding the key** could test a guess of an event's exact content against its MAC.

## 6. Traceability (C2)

Three additive columns on `audit_event`, all covered by the seal:

| Column | Set by | Value |
|---|---|---|
| `permission` | `executeCommand` (`ctx.permission`) | The command's permission (`null` for permission-less demo and system commands). Refusals (`command.denied`) record the permission that was lacking. Also set for `audit.verified` (`view.audit`). |
| `session_ref` | `executeCommand` in secured mode (`ctx.sessionRef`) | `HMAC-SHA256(audit key, session id hash)`, first 16 hex characters. **Never the session id or its stored hash.** Without the key it cannot be linked to a session row; with the key and the `auth_session` table it can. `null` in demo mode and for events outside commands. |
| `source_ref` | The importer (`AuditInput.sourceRef`) | `"<sourceId>:<messageId>:v<version>"`; `v?` when the version is unknown (an unreadable payload). |

- A consequential command's event therefore carries the actor and role, the permission, the session reference (secured), the case or intake reference, before and after, the reason when the command requires one, the demo-clock time and the wall-clock time, and the correlation id shared with its idempotency receipt. `tests/domain/traceability.test.ts` asserts each of these.
- An import started by a person (for example a supervisor retrying a failed message) carries that person's permission and session reference **and** the source reference.
- **Gap:** `source_ref` is set on the importer's top-level events (order imported, amended or canceled, order-level change review, new office, duplicate, stale, failed). The reconciliation events written by the importer's inner steps (part changes, stain and work-order changes, correction reviews, holds and clarifications, superseded evidence) do not have the message id in scope and record `source_ref = NULL`. They share the correlation id of the import and name the source order, so they can be traced through the top-level event. Passing the reference to those steps changes code outside the importer's `audit()` calls and was left for the integration phase.
- Sign-in, sign-out, lock and denial events (`auth.*`) are unchanged in this phase: they do not record `permission` or `session_ref`.

## 7. Idempotency receipt maintenance (C3)

Code: `src/server/core/idempotency.ts`, `scripts/maintenance.ts`.

- **Compaction** (`compactExpiredReceipts(db, nowMs, { batch })`): a receipt whose `expires_at` (24 h after use) has passed becomes a **tombstone**. `result_json` is cleared and `compacted_at` is set; the key, owner, scope, command, fingerprint, correlation id and expiry are kept. A retried old key is **still refused** with `IDEMPOTENCY_EXPIRED` and never re-run, whatever its stored expiry says. Receipts written before scoped receipts (no expiry) are left alone; they are refused anyway (no fingerprint).
- **Purge** (`purgeTombstones(db, nowMs, { retentionDays })`): deletes tombstones whose expiry is more than `HLOS_RECEIPT_TOMBSTONE_DAYS` (default 30, whole days 1 to 3650) in the past. Only tombstones are deleted, never a live receipt. An invalid setting **purges nothing** (the CLI exits 2).
- **Bounded:** both work in batches (default 500, at most 5000 rows), **each batch in its own short `IMMEDIATE` transaction**, and refuse to run inside another transaction.
- **When they run:**
  - opportunistically after a command **commits** (never inside its transaction, and never when the command itself ran inside an outer transaction), **at most once per 10 minutes per process**, one batch of 200 of each, without waiting for a busy write lock (another writer simply means "next time"; the connection's busy timeout is restored). Failures are logged and never affect the command's response;
  - through `npm run maintenance` (`-- --batch <n>`), which prints counts only.
- **Never touches audit events** (tested byte for byte, with the chain verified after).
- **Concurrency:** tested with another process compacting and purging in small batches while this process runs keyed commands and replays them: every command ran once, every replay returned the stored result, no live receipt was lost or emptied.
- **Residual risk:** after a tombstone is purged, a key older than its expiry plus the retention would be **treated as new and run again**. The client creates a fresh key per user intent and retries within seconds, so such a key is not expected; nothing enforces that. A test pins this behaviour.
- With several server processes, each runs its own opportunistic maintenance (still at most once per 10 minutes each).

## 8. Configuration
| Variable | Required | Meaning |
|---|---|---|
| `HLOS_AUDIT_KEY` | Secured mode | At least 32 bytes, e.g. `openssl rand -hex 32`. Keep it in the deployment's secret store, apart from the database backups. |
| `HLOS_AUDIT_KEY_ID` | No | A name for the key, recorded on every seal |
| `HLOS_AUDIT_ANCHOR_PATH` | No (strongly advised) | JSON-lines anchor file, outside the database's directory, on storage the database's administrators cannot change |
| `HLOS_RECEIPT_TOMBSTONE_DAYS` | No | Tombstone retention after expiry, default 30 |

Suggested schedule (not provided by this application): `npm run audit:anchor` and `npm run audit:verify` at least daily and before and after any maintenance window; `npm run maintenance` daily; keep the evidence downloads with the laboratory's records.

## 9. Everything this does NOT do (consolidated)
1. It does not prevent changes to the database file; it detects some of them afterwards, when someone verifies.
2. It cannot detect a rewrite by someone holding both the database and the key after the newest anchor, or at all if they can also change the anchor file. It is not independence from the database administrators.
3. Triggers stop only the application.
4. `sealed_at` is not covered by the MAC.
5. Events written in locked mode without a key stay unsealed (and unprotected) until the next keyed write seals them; events written before Phase C are sealed late, at the first write after the upgrade, and nothing vouches for them before that.
6. The demo key proves nothing.
7. No key rotation, no HSM, no external anchoring service; verification uses one key.
8. Verification is a full pass over the trail each time (the `/audit` page runs it on load); very large trails will make the page slow.
9. The classification of the first problem is best effort.
10. `source_ref` is missing on the importer's inner reconciliation events; `auth.*` events carry no `permission` or `session_ref`.
11. Purging tombstones re-opens an old key after the retention.
12. None of this is a compliance attestation.

## 10. Tests
| File | What it shows |
|---|---|
| `tests/domain/audit-seal.test.ts` | Sealing in seq order under the labelled demo key; seals inside the command's transaction (rolled back together); `audit()` outside a transaction; two connections and two processes writing at once, then a clean verification; every column covered; tampers made with file access (dropped triggers, foreign keys off): edited event (each column), deleted event, deleted event and seal, swapped rows, forged seal without the key (one seal, or the rest of the chain), removed seal, slipped-in row, truncated tail, insider rewrite with the key caught by an anchor and not caught after the newest anchor, wrong key; anchors (path refusal, symlinks, refusal to anchor a broken chain, malformed file); secured mode locked without a valid `HLOS_AUDIT_KEY`; the CLI's exit codes and output without event content; `POST /api/audit/verify` permissions, evidence without event content, and its own audit event. |
| `tests/domain/traceability.test.ts` | A consequential command's event (actor, role, permission, session reference, intake reference, before, after, reason, times, correlation id), a refusal, a supervisor-retried import, demo mode, and `source_ref` on new, amended, duplicate, stale and failed imports. |
| `tests/domain/receipts.test.ts` | Expiry then compaction with the key still refused; purge only after the retention and the pinned residual risk; the retention setting; bounded batches; audit events untouched; cleanup concurrent with mutations (lock held by another connection; another process cleaning while this one runs and replays commands); the opportunistic run; the CLI. |

The vitest configuration sets a fixed, synthetic `HLOS_AUDIT_KEY` (public, test only) so the existing secured-mode tests keep running now that secured mode requires a key; the secured browser suite generates a random one per run (`playwright.secured.config.ts`).

## Addendum (2026-10-24): refusals of signed-in users
In secured mode, refusals of a signed-in user are now audited:
- REAUTH_REQUIRED and refused page or API views are recorded as `auth.refused`;
- command refusals stay `command.denied`.

Both are rate-limited to at most one event per staff member, kind and target per minute. The next event records how many were skipped. No request content is recorded. Prefetches, link probes and `/api/live` polling are not audited.

The limit is kept in each server process's memory. A skipped count is written only with the next event for the same staff member, kind and target. Every request still appears in the `http.request` log lines. Demo mode records every command denial, as before (`src/server/auth/refusals.ts`; tests in `tests/domain/auth.test.ts`).
