# Backup and restore (Stage 6, Phase E1)

*2026-10-19, branch `stage-6-production-foundation`. Synthetic data only: every database named here is the synthetic demo day in a scratch directory. Nothing was restored over `data/histology-lab-os.db` or any live database. This is a design and test record, not a compliance claim.*

**What is proved here:** a backup taken while the application writes restores into a new path, and every check passes. The checks are the decryption tag, both checksums, `integrity_check`, `foreign_key_check`, the schema fingerprint, every table's row count, the audit chain with its anchors, and the chain head against the manifest. Damage, tampering, the wrong key, a missing tag and truncation are each detected before anything is written. **What is not proved:** anything about a real deployment's storage, schedule, key custody or recovery times. Those are open decisions (sections 2 and 3).

## 1. What the application does

Code: `src/server/ops/backup.ts`, `src/server/ops/backup-manifest.ts`, `scripts/backup.ts`, `scripts/restore.ts`. Tests: `tests/domain/backup.test.ts` (17 tests).

### 1.1 `npm run db:backup -- [--out <dir>] [--json]`
- **Consistent online snapshot.** It uses SQLite's online backup API (better-sqlite3 `db.backup()`) and copies every page in **one step**. If another connection writes after the first, page-counting step, SQLite restarts the copy inside that same step, so the copy is never a mix of two states. In WAL mode the snapshot holds only a read transaction, so writers are not blocked. The source is opened without any schema step and nothing is written to it. When the backup's connection is the last one open, closing it may checkpoint the WAL, as any SQLite connection does.
- **The snapshot** is switched to `journal_mode=DELETE`, which makes it one self-contained file. It is then checked (`integrity_check`), described and hashed.
- **Manifest** `<id>.manifest.json` (mode 0600). It holds:
  - `created_at`;
  - the app name, version and git commit (`HLOS_GIT_COMMIT` overrides);
  - the schema fingerprint: SHA-256 over every schema object;
  - per-table row counts;
  - the SHA-256 of the stored file and of the database image;
  - the audit seal head `{seq, mac, key_id}` and the audit verification run on the snapshot;
  - the encryption parameters.

  It holds no key, no secret and no record content.
- **Encryption** with `HLOS_BACKUP_KEY`: 32 bytes, as 64 hex characters or base64.
  - AES-256-GCM, a random 12-byte IV per file.
  - The 16-byte tag is stored at the end of the file **and** in the manifest.
  - The file layout is `HLOSBK01` + IV + ciphertext + tag.
  - The additional authenticated data binds the manifest's expectations: backup id, creation time, database size and SHA-256, schema fingerprint, row counts and audit head. Editing any of them in the manifest makes the tag fail.
  - The key is refused when it is the wrong length, looks weak, or is the same secret as `HLOS_AUDIT_KEY`, `HLOS_SESSION_SECRET` or `HLOS_OIDC_CLIENT_SECRET`. The refusal names the variable, never its value.
  - The manifest names the key by a key id (`bk-` + 12 hex characters of an HMAC of a fixed label under the key).
- **Plaintext handling.** For an encrypted backup, the plaintext snapshot is written only inside the live database's own directory, which already holds the same data in plain form. It is removed after encryption, so only ciphertext reaches the backup directory. The removal is ordinary, not secure erasure (`data-protection.md`, section 7).
- **Refusals** (exit 2, nothing written):
  - **no key** in secured mode;
  - **no key** in a locked build (`HLOS_MODE` not `demo`);
  - **no key** in demo mode when the database is not the synthetic demo database (no seed marker, or a linked sign-in identity);
  - an output directory inside `public/`;
  - an output directory equal to the database's own directory;
  - a missing database (none is ever created).
- **Synthetic demo exception.** In demo mode, on the synthetic database and without a key, the backup is written **unencrypted** and labelled `"synthetic, unencrypted"`.
- **Output directory.** The default is `data/backups/`, which is gitignored, or `HLOS_BACKUP_DIR`. Use `--out` for anything else. The directory is created with mode 0700 and the files with 0600.

### 1.2 `npm run db:restore -- <backup or manifest> --target <new path> [--anchors <file>] [--json]`
- **Target.** Only a path where **nothing** exists: no file, no symbolic link (including a dangling one), and no `-wal`, `-shm` or `-journal` beside it. That last rule matters because SQLite would mix a stale WAL file into the restored database. The target is never the live database (`HLOS_DB_PATH`) or one of its companion files, even if it does not exist yet. The file is written to a temporary name beside the target, then hard-linked into place, or copied with an exclusive create where links are not supported, so nothing is ever overwritten.
- **Checks before anything is written**, stopping at the first failure:
  1. the manifest;
  2. the backup file's size and SHA-256;
  3. decryption: the key id, the GCM tag present in the manifest and equal to the file's, the IV, then the tag itself;
  4. the decrypted image's SHA-256.
- **Checks on the restored file:**
  - `PRAGMA integrity_check` and `PRAGMA foreign_key_check`;
  - the schema fingerprint, taken before anything else touches the schema;
  - every table's row count;
  - the audit chain (`verifyAuditChain`). It uses the public demo key when the backup was sealed with it; otherwise `HLOS_AUDIT_KEY`, whose key id must match or the restore is refused. Anchors from `--anchors` or `HLOS_AUDIT_ANCHOR_PATH` are compared when they are not newer than the backup. Newer anchors are reported, because they vouch for history the backup does not hold.
  - the restored head `{seq, mac, key_id}` against the manifest.
- **Exit codes:** 0 every check passed; 1 a check failed (mismatch, tampering, wrong key, truncation); 2 refused (target exists or is live, no key, no manifest).
- **On failure.** A file that fails a check after it was written is kept for investigation, and the report says **DO NOT USE**.
- **The application never switches to a restored database by itself.** An operator points `HLOS_DB_PATH` at it after review.

## 2. Strategy: deployment decisions, not made here

| Decision | What the application offers | Open: the laboratory decides |
|---|---|---|
| **Frequency** | Backups are safe to run while the application is running. A backup of the synthetic database takes well under a second (section 4). The health check warns when the newest manifest is older than `HLOS_BACKUP_MAX_AGE_HOURS` (default 26). | How often (for example nightly plus before every upgrade), and who is alerted |
| **Retention** | Nothing is deleted by the application. | How many backups and for how long, under the record-retention schedule. A backup kept longer than a record's retention keeps that record (`data-protection.md`, section 5). |
| **Off-host copies** | The files are self-contained: ciphertext plus a manifest with no secret in it. | Where copies go (another host, another site, write-once storage), who can read or delete them, and how access is recorded |
| **Key custody** | `HLOS_BACKUP_KEY` comes from the environment only. Its key id is in the manifest. | The secret store, who can read the key, rotation, escrow. The key must be kept **apart** from the backups and from `HLOS_AUDIT_KEY`. Losing it makes every backup made with it unreadable. |
| **Drill cadence** | `db:restore` is the drill. | How often (suggested: monthly and after every upgrade), and who signs it off |

## 3. RPO and RTO: unknown, and they need the laboratory's input

- **RPO (how much recent work may be lost).** This is at most the time since the last backup: a restore loses everything written after `created_at`. The application does not ship WAL archiving or continuous replication. The RPO the laboratory accepts is a clinical and operational decision. For example: how much accessioning and grossing could be re-entered from paper or from the source systems? The backup frequency must then be set to meet it. **Unknown today.**
- **RTO (how long until the laboratory works again).** It is more than the restore command. It also includes noticing the failure, getting the key from its custodian, copying the backup back onto the host, running the restore and reading its report, repointing `HLOS_DB_PATH`, restarting, and reconciling the work done after the backup with the source systems and paper records. On the synthetic database the restore command itself took about a second (section 4). A real database's size, storage and people decide the rest. **Unknown today:** it has to be measured in a drill on the real deployment.

## 4. The drill: synthetic, run through the npm scripts

Run on 2026-10-19 on a developer laptop (macOS, Node 22), against a **fresh synthetic database** in a scratch directory. In the output below, `$DRILL` stands for that directory. Output is trimmed only where `…` shows it. Both keys were generated with `openssl rand -hex 32` into files with mode 0600 and passed through the environment. They are never printed, and they appear here only as `…`.

**Setup.**
1. A fresh synthetic database.
2. A production build of the application in demo mode (`next start -p 3372`) on that database, with the integration simulator switched on.
3. An anchor file outside the database's directory.

```console
$ HLOS_DB_PATH=$DRILL/live/drill.db npm run db:reset
Seeded synthetic demo day into $DRILL/live/drill.db in 272 ms: 66 active cases, 322 synthetic slides.

$ HLOS_MODE=demo npm run audit:anchor          # HLOS_AUDIT_ANCHOR_PATH=$DRILL/anchors/anchors.jsonl
Audit chain: VERIFIED
  key id:          demo-not-secret (the PUBLIC demo key: these seals prove nothing)
  events:          122 (seals: 122, newest seq: 122)
Anchor appended: seq 122, key id demo-not-secret, at 2026-10-19T19:14:49.537Z
```

**Backup while the application writes.** The simulator (`npm run integration:sim -- all --url http://localhost:3372`) posted 22 signed source messages to the running application. The server's own `http.request` log lines show 4 of them arriving while the backup command ran and 8 after it.

```console
$ HLOS_MODE=demo HLOS_BACKUP_KEY=… npm run db:backup -- --out $DRILL/backups
Backup hlos-backup-20261019T191501Z-22b6a2 (45 ms): ENCRYPTED (AES-256-GCM)
  database:        $DRILL/live/drill.db (demo mode, synthetic demo data)
  backup file:     $DRILL/backups/hlos-backup-20261019T191501Z-22b6a2.sqlite.enc
  manifest:        $DRILL/backups/hlos-backup-20261019T191501Z-22b6a2.manifest.json
  size:            2396196 bytes, SHA-256 ce813a558aaf55f54bf9a4233895a1e445784c8fd2fe64ef63a2c91cc9b6d3dd
  database image:  2396160 bytes, SHA-256 dcff2bf9f6b9287d94aa23af33f5d520c3cbb6fab9d0f5b29745fd15d0c8f295, integrity_check ok
  schema:          137 objects, fingerprint 9f2124942eec5b1f…
  rows:            6828 in 68 tables
  audit head:      seq 139, key demo-not-secret (PUBLIC demo key); verified (139 events)
  encryption:      AES-256-GCM, key id bk-63fa571219b0, random IV, tag stored
Prove it: npm run db:restore -- <manifest> --target <new path>. A restore loses everything written after the backup.
(wall time of the whole command, npm and tsx start-up included: 221 ms)

$ HLOS_MODE=demo npm run audit:anchor          # after the backup: the live chain moved on
Audit chain: VERIFIED
  events:          145 (seals: 145, newest seq: 145)
  anchors checked: 1
Anchor appended: seq 145, key id demo-not-secret, at 2026-10-19T19:15:52.194Z
```

**Restore into a new path, and verify.**

```console
$ HLOS_BACKUP_KEY=… npm run db:restore -- $DRILL/backups/hlos-backup-20261019T191501Z-22b6a2.manifest.json \
      --target $DRILL/restore/drill-restored.db --anchors $DRILL/anchors/anchors.jsonl
Restore verification: PASSED (11 passed, 0 failed, 0 skipped)
  backup:  hlos-backup-20261019T191501Z-22b6a2, created 2026-10-19T19:15:01.821Z (encrypted (AES-256-GCM))
  target:  $DRILL/restore/drill-restored.db
  [PASS] manifest           hlos-backup-20261019T191501Z-22b6a2, created 2026-10-19T19:15:01.821Z, encrypted (AES-256-GCM).
  [PASS] backup file        2396196 bytes, SHA-256 ce813a558aaf… matches the manifest.
  [PASS] decryption         AES-256-GCM tag verified with key bk-63fa571219b0; the manifest's expectations are authenticated.
  [PASS] database checksum  2396160 bytes, SHA-256 dcff2bf9f6b9… matches the manifest.
  [PASS] integrity_check    ok
  [PASS] foreign_key_check  no violations
  [PASS] schema fingerprint 137 schema objects, 9f2124942eec… matches the manifest.
  [PASS] row counts         68 tables, 6828 rows, every count equal to the manifest.
  [PASS] audit chain        139 events verified with key demo-not-secret (the PUBLIC demo key: these seals prove nothing), sealed through seq 139.
  [PASS] audit head         seq 139, MAC 64490dcfe70e…, key demo-not-secret: equal to the manifest.
  [PASS] audit anchors      1 anchor(s) at or before the backup's head match the restored chain. 1 newer anchor(s) vouch for history after this backup, which a restore loses.
The restored database matches its manifest. It is NOT in use: point HLOS_DB_PATH at it only after review. It holds nothing written after the backup.
exit 0
(wall time, npm and tsx start-up included: 352 ms)
```

**What the restore lost.** Counts read directly from the live file and the restored file, after the simulator finished:

```text
audit events           live   145  restored   139
integration events     live   109  restored   105
integration receipts   live    20  restored    14
patient references     live    97  restored    95
```

The existing audit CLI agrees. The restored chain verifies on its own. Against the anchor taken after the backup, it is reported as truncated, which is exactly the history the restore lost:

```console
$ HLOS_MODE=demo HLOS_DB_PATH=$DRILL/restore/drill-restored.db npm run audit:verify
Audit chain: VERIFIED
$ … HLOS_AUDIT_ANCHOR_PATH=$DRILL/anchors/anchors.jsonl npm run audit:verify
Audit chain: FAILED at seq 145: anchor_mismatch
  An anchor exported 2026-10-19T19:15:52.194Z vouches for seq 145, but the verified chain ends at 139: history was truncated or is unsealed.
exit 1
```

**Refusals and detections.** In every case below, nothing was written at the target (the restore directory held only `drill-restored.db` afterwards).

```console
--- the same target again
Refused: something already exists at the target path. A restore never overwrites anything; choose a new path.        exit 2
--- the live database as the target
Refused: the target is the live database (or one of its -wal/-shm/-journal files). Restore into a new, isolated path.  exit 2
--- no HLOS_BACKUP_KEY
Refused: this backup is encrypted; set HLOS_BACKUP_KEY to the key it was made with (key id bk-63fa571219b0). Nothing was restored.  exit 2
--- the wrong key
  [FAIL] decryption         Wrong key: HLOS_BACKUP_KEY is key bk-82f5f042957c, but this backup was encrypted with key bk-63fa571219b0.  exit 1
--- one byte flipped in a copy of the backup
  [FAIL] backup file        SHA-256 a5eb8bb44bca… does not match the manifest (ce813a558aaf…): the file was altered or damaged.  exit 1
--- a copy truncated by 4096 bytes
  [FAIL] backup file        The file is 2392100 bytes; the manifest says 2396196: it was truncated or altered.  exit 1
--- backup without a key, HLOS_MODE unset (a locked build)
Refused: HLOS_BACKUP_KEY is required outside the synthetic demo (HLOS_MODE is not demo). Nothing was backed up.  exit 2
--- backup without a key, HLOS_MODE=demo, synthetic database
Backup hlos-backup-20261019T191620Z-9be5bb (46 ms): SYNTHETIC, UNENCRYPTED                                              exit 0
```

**What the drill shows, and what the tests add.**
- **Secured mode without a key.** The drill did not set up an identity provider. A secured-mode backup without a key is refused with "secured mode requires HLOS_BACKUP_KEY". `tests/domain/backup.test.ts` covers this through the CLI, with a complete secured environment.
- **Tampering the checksum cannot catch.** A byte flipped *and* the manifest checksum forged is caught by the GCM tag. So are a forged key id with the wrong key, a missing tag, a file cut before its tag, and an edited row count or audit head in the manifest. These are covered by `tests/domain/backup.test.ts`, as is the absence of any plaintext synthetic patient name or MRN in the encrypted file.
- **Concurrent writes, in a test.** The same file also runs a backup while another **process** writes commands and audit events in a loop, and restores it. It shows that writes happened during the backup, that the restored chain is a prefix of the live chain (equal seals at the manifest's head), and that a new event written to the restored database chains from the restored head.
- **Health after the drill.** `GET /api/health` answered `{"status":"degraded"}` (HTTP 200). `GET /api/health/details` showed `backup: ok`, "The newest backup was taken 1 min ago (encrypted (AES-256-GCM))". The degradation came from `import_failures: warn`: the simulator's failure scenario left 1 message in the failure queue, which is the intended signal.

## 5. Limitations

1. **WAL timing.** The snapshot is the state at the moment its single copy step ran. Transactions committed after that are not in it, even if they committed before the command finished. Uncommitted transactions are never in it. The manifest's `created_at` is when the copy finished (wall clock), not when the last included transaction committed.
2. **A restore loses everything written after the backup.** That includes commands, audit events, receipts, session changes and imported messages.
   - Imports can be replayed from the source systems (the importer is idempotent per message id), but local bench work cannot; it has to be re-entered and reconciled.
   - The restored audit chain is a verified **prefix** of the live one, and newer anchors say so (`anchor_mismatch` if they are compared in full).
   - A client retrying a command made after the backup would run it again on the restored database, because both its receipt and its effects are gone.
   - **Sessions come back as they were at backup time**, so a session revoked or signed out after the backup is live again until it expires. After a restore in secured mode, revoke sessions (`npm run admin -- revoke-sessions <staffId>`) before reopening.
3. **Key management is the deployment's job.** There is no KMS or HSM integration and no key rotation, and there is no re-encryption tool. A lost key means the backups made with it are lost. Someone holding a backup, its key **and** the audit key can rewrite history undetectably up to the newest anchor kept elsewhere (`audit-integrity.md`, section 1). Keep the three apart.
4. **The unencrypted synthetic form proves only consistency.** Nothing authenticates the file and its manifest together, so a matching edit to both is not detected. That is why it is refused for anything but the synthetic demo database.
5. **The plaintext snapshot** sits briefly in the database's directory during an encrypted backup. A crash at that moment leaves it there, in the place that already holds the live database in plain form. Removing it is not secure erasure.
6. **The manifest is not signed.** Without encryption it can be edited. With encryption, editing the expectations it records breaks the tag. Its descriptive fields (label, app version, `verified_at_backup`) are not authenticated.
7. **Integrity at backup time.** A snapshot that fails `integrity_check` is still written, because it may be the best copy there is. Its manifest flags it, and the command exits 1.
8. **Size.** Hashing, encryption and decryption stream in 1 MiB chunks. The snapshot and the restore each need free space for one full copy, plus a temporary copy during encryption or decryption. The single-step copy holds a read transaction for its whole length, so on a very large database the WAL file grows until the copy ends.
9. **Health sees one directory.** The backup age check reads only `HLOS_BACKUP_DIR` (default `data/backups/`). Off-host copies, and their restorability, are invisible to it.
