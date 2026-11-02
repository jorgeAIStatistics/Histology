// Laboratory administration CLI (Stage 6 Phase B). Runs against the database
// at HLOS_DB_PATH (default data/histology-lab-os.db). It never seeds data and
// never contacts the identity provider. Every command writes one audit event
// (origin "system", action admin.*) naming the local OS account that ran it.
//
//   npm run admin -- list
//   npm run admin -- link-identity <staffId> --issuer <issuer URL> --subject <sub> [--lab <labId>]
//   npm run admin -- unlink-identity --issuer <issuer URL> --subject <sub> [--lab <labId>]
//   npm run admin -- set-role <staffId> <role>
//   npm run admin -- deactivate-staff <staffId>
//   npm run admin -- revoke-sessions <staffId>
//
// --lab defaults to HLOS_LAB_ID, then "lab:local". Identity links are the ONLY
// way a person can sign in: sign-in never links anyone automatically.
import os from "node:os";
import crypto from "node:crypto";
import { databasePath, openDatabase } from "../src/server/db/db";
import { AdminError, deactivateStaff, linkIdentity, listAdmin, revokeSessions, setRole, unlinkIdentity } from "../src/server/auth/admin";

const USAGE = `Usage:
  admin list
  admin link-identity <staffId> --issuer <issuer URL> --subject <sub> [--lab <labId>]
  admin unlink-identity --issuer <issuer URL> --subject <sub> [--lab <labId>]
  admin set-role <staffId> <role>
  admin deactivate-staff <staffId>
  admin revoke-sessions <staffId>`;

function parse(argv: string[]): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) throw new AdminError(`${a} needs a value.`);
      flags[a.slice(2)] = value;
      i++;
    } else positional.push(a);
  }
  return { positional, flags };
}

function need(value: string | undefined, what: string): string {
  if (!value) throw new AdminError(`Missing ${what}.\n\n${USAGE}`);
  return value;
}

function operatorName(): string {
  try {
    return `os:${os.userInfo().username}`;
  } catch {
    return "os:unknown";
  }
}

function main(): number {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === "help" || command === "--help") {
    console.log(USAGE);
    return command ? 0 : 1;
  }
  const { positional, flags } = parse(rest);
  const labId = flags.lab ?? process.env.HLOS_LAB_ID?.trim() ?? "lab:local";
  const file = databasePath();
  const db = openDatabase(file);
  const ctx = { operator: operatorName(), correlationId: `admin-${crypto.randomUUID()}` };
  try {
    switch (command) {
      case "list": {
        const out = listAdmin(db, ctx);
        console.log(`Database: ${file}`);
        console.log("\nStaff (id, role, lab, active, linked identities, open sessions):");
        for (const s of out.staff) console.log(`  ${s.id}\t${s.role}\t${s.labId}\t${s.active ? "active" : "INACTIVE"}\t${s.identities}\t${s.openSessions}`);
        console.log("\nIdentity links (lab, issuer, subject, staff, active, linked by, at):");
        for (const i of out.identities) console.log(`  ${i.labId}\t${i.issuer}\t${i.subject}\t${i.staffId}\t${i.active ? "active" : "unlinked"}\t${i.linkedBy}\t${i.linkedAt}`);
        return 0;
      }
      case "link-identity": {
        const staffId = need(positional[0], "<staffId>");
        const r = linkIdentity(db, ctx, { staffId, issuer: need(flags.issuer, "--issuer"), subject: need(flags.subject, "--subject"), labId });
        console.log(r.relinked ? `Re-linked the identity to ${staffId} (${labId}).` : `Linked the identity to ${staffId} (${labId}).`);
        return 0;
      }
      case "unlink-identity": {
        const r = unlinkIdentity(db, ctx, { issuer: need(flags.issuer, "--issuer"), subject: need(flags.subject, "--subject"), labId });
        console.log(`Unlinked the identity from ${r.staffId}; ${r.sessionsRevoked} session(s) revoked.`);
        return 0;
      }
      case "set-role": {
        const r = setRole(db, ctx, { staffId: need(positional[0], "<staffId>"), role: need(positional[1], "<role>") });
        console.log(r.from === r.to ? `No change: already ${r.to}.` : `Role changed from ${r.from} to ${r.to}. It applies to the next request.`);
        return 0;
      }
      case "deactivate-staff": {
        const r = deactivateStaff(db, ctx, { staffId: need(positional[0], "<staffId>") });
        console.log(`Deactivated; ${r.sessionsRevoked} session(s) revoked.`);
        return 0;
      }
      case "revoke-sessions": {
        const r = revokeSessions(db, ctx, { staffId: need(positional[0], "<staffId>") });
        console.log(`${r.sessionsRevoked} session(s) revoked.`);
        return 0;
      }
      default:
        console.error(`Unknown command "${command}".\n\n${USAGE}`);
        return 1;
    }
  } catch (e) {
    if (e instanceof AdminError) {
      console.error(e.message);
      return 1;
    }
    throw e;
  } finally {
    db.close();
  }
}

process.exitCode = main();
