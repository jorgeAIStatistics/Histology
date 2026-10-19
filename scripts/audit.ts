// Audit trail integrity CLI (Stage 6 Phase C). Prints counts, seq numbers, key ids and kinds only: never the
// content of an audit event (no actor, patient, case, summary or payload).
//
//   npm run audit:verify              verify the HMAC chain, and the anchors in HLOS_AUDIT_ANCHOR_PATH when it is set
//   npm run audit:verify -- --json    the same, as one JSON object
//   npm run audit:anchor              verify, then append the chain head as one JSON line to HLOS_AUDIT_ANCHOR_PATH
//
// Database: HLOS_DB_PATH (default data/histology-lab-os.db); it must already exist (nothing is created).
// Key: HLOS_MODE=demo -> the PUBLIC demo key (key id "demo-not-secret": proves nothing); otherwise HLOS_AUDIT_KEY
// (at least 32 bytes), with HLOS_AUDIT_KEY_ID when the deployment names its key.
// The anchor file must be outside the database's directory (refused otherwise), on storage the database's
// administrators cannot change; see docs/release/audit-integrity.md for what this does and does not show.
//
// Exit codes: 0 verified (and anchored), 1 verification failed, 2 configuration or usage error.
import fs from "node:fs";
import { databasePath, openDatabase } from "../src/server/db/db";
import {
  activeAuditKey,
  appendAnchor,
  AuditAnchorError,
  readAnchorFile,
  resolveAnchorPath,
  verifyAuditChain,
  type AuditAnchor,
  type AuditVerification,
} from "../src/server/core/audit-seal";

const USAGE = `Usage:
  audit verify [--json]
  audit anchor`;

function fail(message: string, code = 2): never {
  console.error(message);
  process.exit(code);
}

function printSummary(v: AuditVerification, file: string, anchorNote: string): void {
  console.log(`Audit chain: ${v.ok ? "VERIFIED" : `FAILED at seq ${v.firstProblem?.seq}: ${v.firstProblem?.kind}`}`);
  if (!v.ok && v.firstProblem) console.log(`  ${v.firstProblem.detail}`);
  console.log(`  database:        ${file}`);
  console.log(`  laboratory:      ${v.lab}`);
  console.log(`  key id:          ${v.keyId}${v.demoKey ? " (the PUBLIC demo key: these seals prove nothing)" : ""}`);
  console.log(`  events:          ${v.events} (seals: ${v.seals}, newest seq: ${v.headSeq})`);
  console.log(`  checked:         ${v.checked}, sealed through seq ${v.sealedThrough}`);
  console.log(`  anchors checked: ${v.anchorsChecked} ${anchorNote}`);
}

function main(): void {
  const [command, ...rest] = process.argv.slice(2);
  if (command !== "verify" && command !== "anchor") fail(USAGE);
  const json = rest.includes("--json");
  const unknown = rest.filter((a) => a !== "--json");
  if (unknown.length || (json && command !== "verify")) fail(USAGE);

  const file = databasePath();
  if (file === ":memory:" || !fs.existsSync(file)) fail(`No database at ${file} (set HLOS_DB_PATH). Nothing was verified.`);
  const key = activeAuditKey();
  if (!key) fail("HLOS_AUDIT_KEY is missing or invalid (at least 32 bytes, not the session secret, not the demo key). Use HLOS_MODE=demo only for the synthetic demo database.");

  const db = openDatabase(file);
  try {
    if (command === "anchor") {
      try {
        const r = appendAnchor(db, { key });
        printSummary(r.verification, file, "");
        console.log(`Anchor appended: seq ${r.anchor.seq}, key id ${r.anchor.key_id}, at ${r.anchor.at}`);
        return;
      } catch (e) {
        if (e instanceof AuditAnchorError) fail(e.message, /does not verify/.test(e.message) ? 1 : 2);
        throw e;
      }
    }

    let anchors: AuditAnchor[] = [];
    let anchorNote = "(HLOS_AUDIT_ANCHOR_PATH is not set: a rewrite by someone holding the key is not detectable)";
    if (process.env.HLOS_AUDIT_ANCHOR_PATH?.trim()) {
      try {
        anchors = readAnchorFile(resolveAnchorPath(db));
        anchorNote = anchors.length ? `(of ${anchors.length} in the anchor file)` : "(the anchor file has no anchors yet)";
      } catch (e) {
        if (e instanceof AuditAnchorError) fail(e.message);
        throw e;
      }
    }
    const v = verifyAuditChain(db, { key, anchors });
    if (json) console.log(JSON.stringify(v, null, 2));
    else printSummary(v, file, anchorNote);
    if (!v.ok) process.exitCode = 1;
  } finally {
    db.close();
  }
}

main();
