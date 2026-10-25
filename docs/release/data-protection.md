# Data protection: transport, storage, secrets, retention, backups and deletion (Stage 6, Phase C5)

*Design and implementation record, 2026-10-19, branch `stage-6-production-foundation`. Synthetic data only, localhost only. Nothing here is a compliance claim. No statement in this document says or implies that the application meets HIPAA, CLIA, CAP, FDA or any other regulation or accreditation requirement. Where this document says "the deployment must", that is a requirement on whoever deploys the application. The application does not check it unless the text says so.*

## 1. Summary

| Area | The application does (tested) | The deployment must | Not done |
|---|---|---|---|
| Encryption in transit | Secured mode requires an https public URL, with plain http accepted only for a local test setup (loopback app and loopback identity provider). Secure, HttpOnly, SameSite=Lax cookies with the `__Host-` prefix under https. HSTS when the build is made with an https public URL. An https identity provider, except a loopback test provider behind an explicit flag. | Terminate TLS at a reverse proxy in front of `next start`. Build with the https `HLOS_PUBLIC_URL`, or set HSTS at the proxy. Keep the proxy-to-app hop on loopback. | TLS inside the Node process; HSTS preload; mutual TLS to a provider |
| Encryption at rest | Nothing. **The SQLite file is not encrypted by this application.** | Put the database, its `-wal` and `-shm` files, the anchor file, logs and backups on an encrypted volume. Restrict file permissions to the service account. | SQLCipher or any database-level encryption (deferred) |
| Secrets | Read from the environment only. Never stored in the database, never logged, never echoed. Secured mode refuses missing, short, weak or reused secrets (locked build; names the key, never the value). | Inject them from a secret store. Keep the audit key apart from database backups. Rotate the client secret at the provider. | An HSM or KMS integration; audit-key rotation |
| Retention | Receipts expire after 24 h, then become tombstones; tombstones are purged after `HLOS_RECEIPT_TOMBSTONE_DAYS`. The audit trail is kept indefinitely; no deletion path exists. | Decide and document retention for every other table (section 5) under the laboratory's policy. | Retention or purge for sessions, integration payloads and clinical records |
| Backups | `npm run db:backup` / `db:restore` (Phase E): SQLite online backup, AES-256-GCM with `HLOS_BACKUP_KEY` (required in secured mode), verified restore to a new path only. | Restore drill and tests: `backup-restore.md`, `tests/domain/backup.test.ts`. Off-host copies, retention and key custody are deployment decisions. | |
| Secure deletion | Nothing beyond SQLite `DELETE`. | Crypto-erase (destroy the volume key) when data must be unrecoverable. | Any guarantee of erasure (section 7) |

## 2. Encryption in transit

### 2.1 What Phase B already enforced (checked again in this phase)
- **`HLOS_PUBLIC_URL`.** Must be https, or plain http on a loopback host (`localhost`, `127.0.0.1`, `::1`). It must have no user, password, query, fragment or path. It sets the OIDC redirect URI and the same-origin check for every state-changing request.
- **Cookies** (`src/server/auth/cookies.ts`, `flow.ts`). The session cookie and the sign-in binding cookie are HttpOnly, SameSite=Lax and Path=/, and never carry a Domain. With an https public URL they are **Secure** and named `__Host-hlos_session` and `__Host-hlos_auth_tx`. The browser enforces the prefix: Secure, Path=/ and no Domain, so a sibling host cannot set them. Only the SHA-256 of the session id is stored.
- **HSTS** (`next.config.ts`). It sends `Strict-Transport-Security: max-age=63072000; includeSubDomains` (two years) on every response **when the build is made with an https `HLOS_PUBLIC_URL`**. Never for plain http, where a browser ignores it, and it must never pin a local demo.
- **The identity provider.** The issuer must be https, or http on a loopback host only with `HLOS_OIDC_ALLOW_INSECURE_LOOPBACK=1`, which is for the local test provider.

### 2.2 What this phase added
- **The missing check.** Phase B accepted a plain-http loopback public URL whatever the identity provider was. A real deployment behind a TLS-terminating proxy could therefore be configured as `http://localhost:3100` and send its session cookie **without** the Secure attribute over the https hop the browser sees. The check is now: **a plain-http public URL is accepted only when the identity provider is on a loopback host too**, which is a local test setup such as this repository's suites. With any other provider the build is **locked** and names `HLOS_PUBLIC_URL` (`src/server/auth/config.ts`). An invalid issuer is reported on its own.
- **Tests** (`tests/domain/privacy.test.ts`):
  - the local setup is accepted;
  - a non-loopback provider with an http public URL is locked, naming `HLOS_PUBLIC_URL` only;
  - an https public URL with that provider is accepted, with Secure cookies;
  - a non-loopback http host is always refused;
  - sign-out clears `__Host-hlos_session` with `Secure` under https and without it on loopback http;
  - HSTS of at least one year with `includeSubDomains` for an https build, and none for loopback http.

### 2.3 Limitations
1. **The application never terminates TLS.** `next start` serves plain http. TLS is the reverse proxy's job, and the hop from the proxy to the app must stay on the same host (loopback) or on an encrypted network.
2. **HSTS is decided when the build is made**, because `next.config.ts` headers are fixed at build time. A build made without `HLOS_PUBLIC_URL`, then started with an https one, sends **no** HSTS. The deployment must either build with the production `HLOS_PUBLIC_URL` or set HSTS at the proxy. It must then check the header on a real response (`curl -sI https://<host>/signin | grep -i strict-transport`) as part of activation. No preload is requested.
3. The application does not redirect http to https. The proxy must refuse or redirect plain http.
4. Simulated integrations are in-process function calls (no network). Real interfaces need their own transport security (Stage 6 Phase D and later).

## 3. Encryption at rest

- **The SQLite file is NOT encrypted by this application.** The database (`HLOS_DB_PATH`, default `data/histology-lab-os.db`) and its `-wal` and `-shm` files hold everything in plain form: patient references (names, dates of birth, MRNs), raw source payloads, the audit trail and session rows.
- **The deployment must rely on volume or disk encryption.** Examples are LUKS or dm-crypt, BitLocker, FileVault, or an encrypted cloud volume with keys managed outside the host. It must restrict the database directory to the service account (no group or world access). SQLite may also write temporary files (sorting, `VACUUM`) to the system temporary directory, which should be on the same encrypted volume or in memory.
- **SQLCipher is a deferred option** (stage 6 plan, section 7). It would need a different native build of the SQLite driver, key management, and a migration of the existing file. Volume encryption protects against a lost disk or snapshot. It does **not** protect against anyone who can read files while the volume is mounted (root, the service account, a compromised process). SQLCipher would not fully protect against those either, because the key has to be in the running process.
- The audit anchor file (`HLOS_AUDIT_ANCHOR_PATH`), the logs and any exported CSV contain controlled data too. They also need encrypted storage.

## 4. Secrets

| Secret | Purpose | Checked at configuration time (secured mode) |
|---|---|---|
| `HLOS_OIDC_CLIENT_SECRET` | Client authentication at the identity provider | Present; **at least 16 characters; not weak; not equal to `HLOS_SESSION_SECRET` or `HLOS_AUDIT_KEY`** (new) |
| `HLOS_SESSION_SECRET` | HMAC binding a sign-in transaction to its browser; the user-agent HMAC on sessions | At least 32 bytes; **not weak** (new) |
| `HLOS_AUDIT_KEY` | The audit chain's HMAC, session references on audit events, audit fingerprints (C4) | At least 32 bytes; not the public demo key; not the session secret; **not weak** (new) |
| `HLOS_TEST_FIXTURE_TOKEN` | Test fixtures, synthetic demo only | At least 32 characters; the route does not exist outside demo mode |

- **Weak** (`weakSecret` in `src/server/auth/config.ts`) means any of the following:
  - fewer than 10 distinct characters (`"x"` × 64, a short word repeated, `0000…`);
  - a placeholder word alone or repeated (`changeme`, `secret`, `password`, `example`…);
  - one character class only with fewer than 16 distinct characters (all digits, for example).

  It is a floor against obvious mistakes, **not an entropy measurement**. Generate secrets with `openssl rand -hex 32`.
- **A failing secret locks the build.** The build is **locked**: no page, read or write. The server log line `runtime.locked_misconfigured` names the key and never its value; the `/locked` page itself shows nothing about the configuration. Tests: `privacy.test.ts` covers the weak, short and reused cases; `auth.test.ts` and `audit-seal.test.ts` cover missing and short ones.
- **Environment only.** No secret is written to the database, which `audit-seal.test.ts` checks for the audit key. Sessions store only the SHA-256 of the session id. There is no configuration file with secrets.
- **Never logged.**
  - The structured logger (`src/server/core/log.ts`, `log.test.ts`) replaces any field named like a secret, token, password, authorization, cookie, session id, nonce, verifier or key.
  - It scrubs Bearer and Basic credentials, JWTs, cookie and query pairs, JSON secret members and long hex or base64 runs from every string.
  - Configuration errors name keys only.
  - The command-line scripts print counts, ids and paths, never environment values.
- **Limitations.** The process environment can be read by root and by the service account (`/proc/<pid>/environ` on Linux), and by whoever can read the deployment's unit or container definition. Where secrets live and who can read them is the deployment's decision.
  - **Rotation of the session secret** only invalidates sign-ins in progress. Existing sessions are keyed by a random id, not by the secret.
  - **Rotation of the audit key** is not implemented (`audit-integrity.md`, section 9).
  - **Rotation of the client secret** happens at the provider; then update the environment and restart.

## 5. Retention

| Data | Retention in this application | Configuration |
|---|---|---|
| Idempotency receipts (`command_receipt`) | The full result is kept 24 h after use (fixed, `RECEIPT_TTL_MS`). Then it is compacted to a tombstone: key, owner, scope, command, fingerprint, expiry; no result. | Not configurable |
| Receipt tombstones | Deleted when their expiry is older than the retention. Residual risk: an older key would run again (`audit-integrity.md`, section 7). | `HLOS_RECEIPT_TOMBSTONE_DAYS`: default 30, whole days 1 to 3650; an invalid value purges nothing |
| Audit trail (`audit_event`, `audit_seal`) | **Indefinite. No deletion path exists in the application.** Triggers refuse UPDATE and DELETE. The demo reset replaces the whole synthetic database file, demo mode only. | None. A legal-hold and retention policy, with an archive that keeps the chain verifiable, is a future decision. |
| Sign-in transactions (`auth_transaction`) | Consumed once; expired rows are deleted when the next sign-in starts (about 1 minute after their 10-minute expiry) | None |
| Sessions (`auth_session`) | **Kept indefinitely** after expiry or revocation. A row holds staff id, lab, issuer, subject, times, the session id hash and a user-agent HMAC. | None. **Gap:** a purge with a retention setting is needed. |
| Integration events and receipts (`integration_event`, `integration_receipt`) | **Indefinite.** The event keeps the raw source payload (patient identifiers). The receipt log is append-only and its detail can quote identifiers. | None. **Gap:** a retention policy is needed for raw payloads. |
| Clinical and operational records (patients, orders, cases, holds, clarifications, tasks) | Indefinite; no deletion path | None. The laboratory's record-retention schedule applies and is not implemented. |
| Server logs (stdout and stderr) | Not stored by the application | The deployment's log retention |
| Audit anchor file | Not managed by the application (append only, by `npm run audit:anchor`) | The operator's storage |

## 6. Backups (built in Phase E; see `backup-restore.md`)

`npm run db:backup` and `npm run db:restore` implement the requirements below: an online backup, AES-256-GCM encryption (required in secured mode), a manifest bound to the encryption, and a restore that only writes a new path and then verifies integrity, foreign keys, row counts, schema and the audit chain. A real drill and its output are in `backup-restore.md`. What remains for the deployment: off-host copies, backup retention, access control and auditing of backup reads, and custody of `HLOS_BACKUP_KEY` and the audit key away from the backups. **Requirements:**
1. **Encrypted.** A backup holds everything the database holds, in plain form: patient identifiers, raw payloads and the audit trail. Encrypt it with a key that is not stored with the backup, and not on the database host when that can be avoided.
2. **Consistent.** Take it with SQLite's online backup API (or `VACUUM INTO`), not by copying the file while the server writes. Copying the main file without its `-wal` file loses committed transactions.
3. **The audit key and the anchors are stored apart from the database backups.** A backup plus the key is enough to rewrite history undetectably (`audit-integrity.md`, section 1).
4. **Access-controlled and audited.** Record who reads, restores or deletes a backup.
5. **Restore-tested.** A restore into an isolated path, then:
   - `PRAGMA integrity_check`;
   - the foreign-key check;
   - `npm run audit:verify` against the anchors;
   - row counts.
6. **Retention for backups** follows section 5. A backup kept longer than a record's retention keeps that record.

## 7. Secure deletion: what SQLite and the filesystem do not guarantee

Deleting a row, or the purge of tombstones and the compaction that empties a receipt's result, does **not** erase its content from disk:
- **Free pages.** SQLite marks deleted content as free. It stays in the file until the page is reused. The application does not set `PRAGMA secure_delete`, which would overwrite deleted content with zeros at a write cost. Even with it, copies elsewhere remain (below).
- **WAL.** In WAL mode (`journal_mode = WAL`, `src/server/db/db.ts`), changed pages are written to the `-wal` file first. Old page images stay there until a checkpoint copies them back and the log is reset or truncated. A `-wal` file can hold content that was deleted from the main file.
- **VACUUM does not guarantee erasure.** It writes a new copy of the database and replaces the old one. The old file's blocks are released to the filesystem but **not overwritten**. A temporary copy is written during the operation.
- **Filesystem and storage.** Released blocks stay on disk until reused.
  - Copy-on-write filesystems (APFS, ZFS, Btrfs) keep older versions.
  - Volume and cloud **snapshots** and **backups** keep everything that existed when they were taken.
  - SSD wear levelling keeps old copies outside the operating system's reach.
  - Swap and the page cache can hold pages in memory or on disk.
- **The demo reset** (`POST /api/demo/reset`, demo only) deletes the database files with an ordinary file removal. That is not secure erasure, which is acceptable only because the data is synthetic.
- **Consequence.** The application cannot promise that deleted data is unrecoverable. When it must be, the deployment should use **crypto-erase**: keep the data on an encrypted volume and destroy that volume's key, after accounting for every snapshot and backup made with it.

## 8. Related controls (Phase C4) and where they are documented
- **Patient identifiers** in the audit trail, on screens, in the CSV export, in logs and in error responses: `privacy-review.md`.
- **The audit trail's integrity** (seal, anchors, keys): `audit-integrity.md`.
- **Sessions, sign-in, lock and re-authentication:** `auth-architecture.md`. That document was written before Phases C4 and C5. Secured mode now also requires a valid `HLOS_AUDIT_KEY` (Phase C1), non-weak secrets, and an https public URL whenever the identity provider is not on loopback.

## 9. Tests
| File | What it shows |
|---|---|
| `tests/domain/privacy.test.ts` | The https rule with the loopback test exception; Secure and `__Host-` cookies under https (sign-out); HSTS for an https build and not for loopback http; `weakSecret`; weak, short and reused secrets lock a secured build, naming the key and never the value |
| `tests/domain/log.test.ts` | Secrets, cookies, authorization headers and tokens redacted by field name and inside strings; payloads and patient fields never logged; errors without stack text; no `console.*` left in server code |
| `tests/domain/auth.test.ts`, `audit-seal.test.ts` (Phase B and C1, unchanged) | Missing or short secrets lock the build; the audit key is never stored or echoed |
