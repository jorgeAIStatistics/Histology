/**
 * Tamper-EVIDENT audit trail (Stage 6 Phase C1). Read
 * docs/release/audit-integrity.md before relying on any of this.
 *
 * Every audit_event row gets one row in the append-only audit_seal table, in
 * seq order, written in the same transaction as the event:
 *
 *   mac(n)      = HMAC-SHA256(key, prev_mac(n) + "\n" + canonical(event n))
 *   prev_mac(n) = mac(n-1), and "genesis:" + the lab scope for the first event
 *   canonical   = JSON array of every audit_event column in AUDIT_COLUMNS order
 *
 * verifyAuditChain() recomputes the chain and reports the first place where it
 * does not hold. Anchors (exportAnchor / appendAnchor) are copies of the chain
 * head written to a file OUTSIDE the database directory; verification against
 * them catches a rewrite, made by someone who holds the key, of history before
 * the newest anchor.
 *
 * What this does NOT do: it cannot stop anyone from editing the database file,
 * and it cannot detect a rewrite by someone who holds both the database and
 * the key, after the newest anchor (or at all, without anchors kept where that
 * person cannot change them). It is not independence from the database
 * administrators.
 *
 * Keys (src/server/auth/config.ts):
 * - demo: the fixed PUBLIC demo key, key id "demo-not-secret" (proves nothing);
 * - secured: HLOS_AUDIT_KEY (required: a secured build without it is locked);
 * - locked: HLOS_AUDIT_KEY when it is set and valid, otherwise events are left
 *   unsealed (verification reports them as unsealed_tail) until a later write
 *   with a key seals them, in seq order.
 */
import { createHmac } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { DB } from "../db/db";
import { ensureAuditSchema } from "../db/audit-schema";
import { auditKeyFromEnv, demoAuditKey, DEMO_AUDIT_KEY_ID, type AuditKeyConfig } from "../auth/config";
import { runtimeMode } from "../runtime-mode";
import { labScope } from "./idempotency";

export type { AuditKeyConfig } from "../auth/config";
export { DEMO_AUDIT_KEY_ID, demoAuditKey } from "../auth/config";

/**
 * Every audit_event column, in the fixed order of the canonical form. A new
 * column must be appended here (tests/domain/audit-seal.test.ts fails until it
 * is), otherwise its content would not be covered by the seal.
 */
export const AUDIT_COLUMNS = [
  "seq",
  "id",
  "at",
  "recorded_at",
  "actor_id",
  "actor_role",
  "origin",
  "action",
  "entity_type",
  "entity_id",
  "accession_id",
  "intake_item_id",
  "summary",
  "before_json",
  "after_json",
  "reason",
  "correlation_id",
  "permission",
  "session_ref",
  "source_ref",
] as const;

export type AuditColumn = (typeof AUDIT_COLUMNS)[number];
export type AuditEventRow = Record<AuditColumn, string | number | null>;

export type AuditProblemKind =
  /** The event row no longer matches its seal (changed after sealing). */
  | "event_modified"
  /** A seal exists for a seq whose event row is gone (deleted), or the newest events were removed. */
  | "event_missing"
  /** An event has no seal although a later event is sealed (a seal was removed, or a row was slipped in). */
  | "seal_missing"
  /** A seal does not verify under the key and no later authentic seal vouches for it (made or altered without the key, or under another key). */
  | "seal_forged"
  /** A seal does not link to the one before it (rows removed or rearranged together with their seals). */
  | "chain_broken"
  /** The event at a seq is not the event that was sealed there (rows swapped or moved). */
  | "reordered"
  /** The newest events have no seal (written without a key, or added outside the application). */
  | "unsealed_tail"
  /** The chain does not match an exported anchor (history before the anchor rewritten, or truncated, or the anchor is another lab's). */
  | "anchor_mismatch";

export const AUDIT_PROBLEM_KINDS: readonly AuditProblemKind[] = [
  "event_modified",
  "event_missing",
  "seal_missing",
  "seal_forged",
  "chain_broken",
  "reordered",
  "unsealed_tail",
  "anchor_mismatch",
];

export interface AuditProblem {
  seq: number;
  kind: AuditProblemKind;
  /** Plain words, no event content (seq numbers, key ids, kinds only). */
  detail: string;
}

export interface AuditAnchor {
  lab: string;
  seq: number;
  mac: string;
  key_id: string;
  at: string;
}

export interface AuditVerification {
  ok: boolean;
  /** Events whose seal verified, in order, before the first problem. */
  checked: number;
  /** The seq of the last event whose seal verified (0: none). */
  sealedThrough: number;
  firstProblem: AuditProblem | null;
  /** Rows in audit_event and audit_seal, and the highest event seq. */
  events: number;
  seals: number;
  headSeq: number;
  lab: string;
  keyId: string;
  /** True when verified with the public demo key (proves nothing). */
  demoKey: boolean;
  /** Anchors compared with the chain. */
  anchorsChecked: number;
  verifiedAt: string;
}

// ------------------------------------------------------------------ keys

/**
 * The key this process seals with: demo -> the public demo key; secured or
 * locked -> HLOS_AUDIT_KEY when valid; otherwise null (nothing is sealed).
 */
export function activeAuditKey(): AuditKeyConfig | null {
  if (runtimeMode() === "demo") return demoAuditKey();
  const k = auditKeyFromEnv();
  return k.ok ? k.key : null;
}

/**
 * Session reference for audit events (secured mode): HMAC-SHA256 of the
 * session id HASH under the audit key, first 16 hex characters. Never the
 * session id, never its stored hash; without the key it cannot be linked to a
 * session row. Null when there is no key.
 */
export function sessionRefFor(sessionIdHash: string, key: AuditKeyConfig | null = activeAuditKey()): string | null {
  if (!key || !sessionIdHash) return null;
  return createHmac("sha256", key.key).update(sessionIdHash).digest("hex").slice(0, 16);
}

// ------------------------------------------------------------------ the chain

export function genesisMac(db: DB): string {
  return `genesis:${labScope(db)}`;
}

/** JSON array of every audit_event column in AUDIT_COLUMNS order (missing -> null). */
export function canonicalEvent(row: Partial<Record<AuditColumn, unknown>>): string {
  return JSON.stringify(AUDIT_COLUMNS.map((c) => (row[c] === undefined ? null : row[c])));
}

export function computeMac(key: Buffer, prevMac: string, canonical: string): string {
  return createHmac("sha256", key).update(prevMac).update("\n").update(canonical).digest("hex");
}

interface Stmts {
  lastSeal: { get: () => unknown };
  pending: { all: (after: number) => unknown[] };
  insertSeal: { run: (...p: unknown[]) => unknown };
}
const stmtCache = new WeakMap<DB, Stmts>();

function stmts(db: DB): Stmts {
  let s = stmtCache.get(db);
  if (!s) {
    ensureAuditSchema(db);
    s = {
      lastSeal: db.prepare("SELECT seq, mac FROM audit_seal ORDER BY seq DESC LIMIT 1"),
      pending: db.prepare(`SELECT ${AUDIT_COLUMNS.join(", ")} FROM audit_event WHERE seq > ? ORDER BY seq`),
      insertSeal: db.prepare("INSERT INTO audit_seal (seq, event_id, prev_mac, mac, key_id, sealed_at) VALUES (?, ?, ?, ?, ?, ?)"),
    } as unknown as Stmts;
    stmtCache.set(db, s);
  }
  return s;
}

/**
 * Seals every event after the last seal, in seq order. Must hold the write
 * lock: inside a transaction it runs as is (the caller's transaction already
 * wrote, or will write, so no other process can interleave); outside one it
 * opens its own IMMEDIATE transaction. With no key (`null`) nothing is sealed.
 * Events behind the last seal that have no seal are never sealed late: that
 * gap is a finding (seal_missing), not something to paper over.
 */
export function sealPending(db: DB, key: AuditKeyConfig | null = activeAuditKey()): { sealed: number; through: number } {
  if (!db.inTransaction) return db.transaction(() => sealPending(db, key)).immediate();
  const s = stmts(db);
  const last = s.lastSeal.get() as { seq: number; mac: string } | undefined;
  if (!key) return { sealed: 0, through: last?.seq ?? 0 };
  let prev = last?.mac ?? genesisMac(db);
  let through = last?.seq ?? 0;
  const rows = s.pending.all(through) as AuditEventRow[];
  const at = new Date().toISOString();
  for (const row of rows) {
    const mac = computeMac(key.key, prev, canonicalEvent(row));
    s.insertSeal.run(row.seq, row.id, prev, mac, key.id, at);
    prev = mac;
    through = row.seq as number;
  }
  return { sealed: rows.length, through };
}

/** Text read from the database or an anchor file, shown in a problem's detail: label characters only, bounded. */
function label(v: unknown): string {
  return String(v ?? "").replace(/[^A-Za-z0-9._:-]/g, "?").slice(0, 64);
}

interface JoinedRow extends AuditEventRow {
  k: number;
  s_seq: number | null;
  s_event_id: string | null;
  s_prev: string | null;
  s_mac: string | null;
  s_key_id: string | null;
}

/**
 * Recomputes the chain with `key` and compares it with `anchors` (when
 * given). Read-only. Stops at the first problem; `kind` is a best-effort
 * description of that first inconsistency (for example, when only the newest
 * event fails and no later seal or anchor vouches for its seal, it cannot be
 * told whether the event or the seal was changed: it is reported as
 * event_modified).
 */
export function verifyAuditChain(db: DB, opts: { key: AuditKeyConfig; anchors?: readonly AuditAnchor[] }): AuditVerification {
  ensureAuditSchema(db);
  const { key } = opts;
  const lab = labScope(db);
  const anchors = [...(opts.anchors ?? [])].sort((a, b) => a.seq - b.seq);
  const anchorsAt = new Map<number, AuditAnchor[]>();
  for (const a of anchors) anchorsAt.set(a.seq, [...(anchorsAt.get(a.seq) ?? []), a]);
  const counts = db
    .prepare("SELECT (SELECT COUNT(*) FROM audit_event) AS events, (SELECT COUNT(*) FROM audit_seal) AS seals, (SELECT COALESCE(MAX(seq), 0) FROM audit_event) AS head")
    .get() as { events: number; seals: number; head: number };
  const autoinc = db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'audit_event'").get() as { seq: number } | undefined;

  let prev = genesisMac(db);
  let checked = 0;
  let sealedThrough = 0;
  let anchorsChecked = 0;
  let unsealedStart: number | null = null;
  let pending: { seq: number; sealMac: string } | null = null;
  let problem: AuditProblem | null = null;

  const result = (p: AuditProblem | null): AuditVerification => ({
    ok: p === null,
    checked,
    sealedThrough,
    firstProblem: p,
    events: counts.events,
    seals: counts.seals,
    headSeq: counts.head,
    lab,
    keyId: key.id,
    demoKey: key.demo,
    anchorsChecked,
    verifiedAt: new Date().toISOString(),
  });

  /** A seal at `seq` failed its MAC: did a later authentic seal, or an anchor, commit to it? */
  const decide = (p: { seq: number; sealMac: string }, next: JoinedRow | null): AuditProblem => {
    if (
      next &&
      next.seq !== null &&
      next.s_seq !== null &&
      next.s_event_id === next.id &&
      next.s_key_id === key.id &&
      next.s_prev === p.sealMac &&
      computeMac(key.key, next.s_prev, canonicalEvent(next)) === next.s_mac
    ) {
      return { seq: p.seq, kind: "event_modified", detail: `Event ${p.seq} does not match its seal; the next seal (${next.k}) vouches for that seal, so the event row was changed after sealing.` };
    }
    const anchored = (anchorsAt.get(p.seq) ?? []).filter((a) => a.lab === lab);
    if (anchored.some((a) => a.mac === p.sealMac)) {
      return { seq: p.seq, kind: "event_modified", detail: `Event ${p.seq} does not match its seal; an exported anchor vouches for that seal, so the event row was changed after sealing.` };
    }
    if (next || anchored.length) {
      return { seq: p.seq, kind: "seal_forged", detail: `The seal of event ${p.seq} does not verify under key ${key.id}, and no later authentic seal or anchor vouches for it: it was made or altered without the key.` };
    }
    return {
      seq: p.seq,
      kind: "event_modified",
      detail: `Event ${p.seq}, the newest sealed event, does not match its seal. With no later seal or anchor it cannot be told whether the event or its seal was changed.`,
    };
  };

  const iter = db
    .prepare(
      `SELECT COALESCE(e.seq, s.seq) AS k, ${AUDIT_COLUMNS.map((c) => `e.${c} AS ${c}`).join(", ")},
              s.seq AS s_seq, s.event_id AS s_event_id, s.prev_mac AS s_prev, s.mac AS s_mac, s.key_id AS s_key_id
         FROM audit_event e FULL OUTER JOIN audit_seal s ON s.seq = e.seq
        ORDER BY k`,
    )
    .iterate() as IterableIterator<JoinedRow>;
  try {
    for (const row of iter) {
      if (pending) {
        problem = decide(pending, row);
        break;
      }
      const hasEvent = row.seq !== null;
      const hasSeal = row.s_seq !== null;
      if (hasEvent && !hasSeal) {
        if (unsealedStart === null) unsealedStart = row.k;
        continue;
      }
      if (unsealedStart !== null) {
        problem = { seq: unsealedStart, kind: "seal_missing", detail: `Event ${unsealedStart} has no seal, but event ${row.k} after it is sealed.` };
        break;
      }
      if (!hasEvent) {
        problem = { seq: row.k, kind: "event_missing", detail: `Event ${row.k} was sealed but its row is missing (deleted).` };
        break;
      }
      if (row.s_event_id !== row.id) {
        problem = { seq: row.k, kind: "reordered", detail: `The event at seq ${row.k} is not the event that was sealed there (rows swapped or moved).` };
        break;
      }
      if (row.s_key_id !== key.id) {
        problem = {
          seq: row.k,
          kind: "seal_forged",
          detail: `The seal of event ${row.k} names key ${label(row.s_key_id)}, not ${key.id}: it was made under another key, or its key id was altered.`,
        };
        break;
      }
      if (row.s_prev !== prev) {
        problem = { seq: row.k, kind: "chain_broken", detail: `The seal of event ${row.k} does not link to the seal before it (rows removed or rearranged with their seals).` };
        break;
      }
      if (computeMac(key.key, row.s_prev, canonicalEvent(row)) !== row.s_mac) {
        pending = { seq: row.k, sealMac: row.s_mac as string };
        continue;
      }
      prev = row.s_mac as string;
      checked += 1;
      sealedThrough = row.k;
      for (const a of anchorsAt.get(row.k) ?? []) {
        anchorsChecked += 1;
        if (a.lab !== lab || a.mac !== row.s_mac) {
          problem = {
            seq: row.k,
            kind: "anchor_mismatch",
            detail:
              a.lab !== lab
                ? `The anchor at seq ${row.k} belongs to laboratory scope ${label(a.lab)}, not ${lab}.`
                : `The chain at seq ${row.k} does not match the anchor exported ${label(a.at)}: history up to that point was rewritten (with the key) after the anchor.`,
          };
          break;
        }
      }
      if (problem) break;
    }
  } finally {
    // Leaving the loop early must release the statement, or the connection stays busy.
    iter.return?.();
  }
  if (!problem && pending) problem = decide(pending, null);
  if (problem) return result(problem);

  const tail: AuditProblem[] = [];
  if (unsealedStart !== null) {
    tail.push({ seq: unsealedStart, kind: "unsealed_tail", detail: `Events from seq ${unsealedStart} to ${counts.head} have no seal (written without an audit key, or added outside the application).` });
  }
  if (autoinc && autoinc.seq > counts.head) {
    tail.push({ seq: counts.head + 1, kind: "event_missing", detail: `Events up to seq ${autoinc.seq} were written but the newest present is ${counts.head}: the newest events were deleted.` });
  }
  for (const a of anchors) {
    if (a.seq > sealedThrough) {
      anchorsChecked += 1;
      tail.push({ seq: a.seq, kind: "anchor_mismatch", detail: `An anchor exported ${label(a.at)} vouches for seq ${a.seq}, but the verified chain ends at ${sealedThrough}: history was truncated or is unsealed.` });
      break;
    }
  }
  tail.sort((a, b) => a.seq - b.seq);
  return result(tail[0] ?? null);
}

// ------------------------------------------------------------------ anchors

export class AuditAnchorError extends Error {}

/** The current chain head as an anchor: { lab, seq, mac, key_id, at }. Throws when nothing is sealed yet. */
export function exportAnchor(db: DB): AuditAnchor {
  ensureAuditSchema(db);
  const head = db.prepare("SELECT seq, mac, key_id FROM audit_seal ORDER BY seq DESC LIMIT 1").get() as { seq: number; mac: string; key_id: string } | undefined;
  if (!head) throw new AuditAnchorError("Nothing is sealed yet: there is no chain head to anchor.");
  return { lab: labScope(db), seq: head.seq, mac: head.mac, key_id: head.key_id, at: new Date().toISOString() };
}

/** The directory of `p`, with symbolic links resolved for the part that exists. */
function realDirOf(p: string): string {
  let dir = path.dirname(path.resolve(p));
  const rest: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(dir), ...rest.reverse());
    } catch {
      const parent = path.dirname(dir);
      if (parent === dir) return path.join(dir, ...rest.reverse());
      rest.push(path.basename(dir));
      dir = parent;
    }
  }
}

/**
 * The anchor file to use: `given`, else HLOS_AUDIT_ANCHOR_PATH. Refuses a path
 * inside the database's directory (or below it): an anchor kept next to the
 * database can be rewritten together with it.
 */
export function resolveAnchorPath(db: DB, given?: string | null): string {
  const raw = (given ?? process.env.HLOS_AUDIT_ANCHOR_PATH ?? "").trim();
  if (!raw) throw new AuditAnchorError("HLOS_AUDIT_ANCHOR_PATH is not set: name a file outside the database's directory, on storage the database's administrators cannot change.");
  const file = path.resolve(raw);
  const dbFile = db.name;
  if (dbFile && dbFile !== ":memory:") {
    const dbDir = realDirOf(dbFile);
    const anchorDir = realDirOf(file);
    if (anchorDir === dbDir || anchorDir.startsWith(dbDir + path.sep)) {
      throw new AuditAnchorError("Refused: HLOS_AUDIT_ANCHOR_PATH is inside the database's directory. An anchor must live elsewhere, where whoever can change the database cannot change it.");
    }
  }
  return file;
}

const HEX64 = /^[0-9a-f]{64}$/;

function parseAnchor(v: unknown): AuditAnchor | null {
  if (!v || typeof v !== "object") return null;
  const a = v as Record<string, unknown>;
  if (typeof a.lab !== "string" || !a.lab) return null;
  if (typeof a.seq !== "number" || !Number.isInteger(a.seq) || a.seq < 1) return null;
  if (typeof a.mac !== "string" || !HEX64.test(a.mac)) return null;
  if (typeof a.key_id !== "string" || !a.key_id) return null;
  if (typeof a.at !== "string" || Number.isNaN(Date.parse(a.at))) return null;
  return { lab: a.lab, seq: a.seq, mac: a.mac, key_id: a.key_id, at: a.at };
}

/** Reads a JSON-lines anchor file. A missing file is no anchors; a malformed line throws (fail closed). */
export function readAnchorFile(file: string): AuditAnchor[] {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new AuditAnchorError(`The anchor file could not be read (${(e as NodeJS.ErrnoException).code ?? "error"}).`);
  }
  const out: AuditAnchor[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    if (!line.trim()) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      parsed = null;
    }
    const a = parseAnchor(parsed);
    if (!a) throw new AuditAnchorError(`The anchor file has a malformed line (${i + 1}); nothing was verified against it.`);
    out.push(a);
  });
  return out;
}

/**
 * Verifies the chain (with the anchors already in the file), then appends the
 * head as one JSON line. Refuses to anchor a chain that does not verify: an
 * anchor must never vouch for a rewritten history.
 */
export function appendAnchor(db: DB, opts: { key: AuditKeyConfig; file?: string | null }): { anchor: AuditAnchor; file: string; verification: AuditVerification } {
  const file = resolveAnchorPath(db, opts.file);
  const existing = readAnchorFile(file);
  // One read snapshot: the anchored head is exactly the head that was verified.
  const { verification, anchor } = db.transaction(() => {
    const v = verifyAuditChain(db, { key: opts.key, anchors: existing });
    if (!v.ok) {
      throw new AuditAnchorError(`Refused: the audit chain does not verify (seq ${v.firstProblem?.seq}, ${v.firstProblem?.kind}). No anchor was written.`);
    }
    const a = exportAnchor(db);
    if (a.seq !== v.sealedThrough) throw new AuditAnchorError("Refused: the chain head changed during verification. Try again.");
    return { verification: v, anchor: a };
  })();
  fs.appendFileSync(file, `${JSON.stringify(anchor)}\n`, { encoding: "utf8", mode: 0o600 });
  return { anchor, file, verification };
}

// ------------------------------------------------------------------ evidence

export interface AuditEvidence {
  format: "hlos.audit-evidence/1";
  generatedAt: string;
  lab: string;
  keyId: string;
  demoKey: boolean;
  verification: Omit<AuditVerification, "verifiedAt"> & { verifiedAt: string };
  /** The newest verified seal. */
  head: { seq: number; mac: string } | null;
  /** Contiguous seq ranges of verified, sealed events. */
  ranges: { fromSeq: number; toSeq: number; events: number }[];
  /** The MAC at every 1000th seq of the verified range (and at its end), to re-check a later copy against. */
  checkpoints: { seq: number; mac: string }[];
  anchors: AuditAnchor[];
  /** Whether an anchor file was configured and usable (never its path). */
  anchorFile?: { configured: boolean; count: number; error: string | null };
  notice: string;
}

/**
 * Evidence of a verification run for download: seq ranges, MACs, the key id
 * and the anchors. No event content (no actor, entity, summary, payload or
 * reason) is included. MACs reveal nothing without the key; someone holding
 * the key could test a guess of an event's exact content against its MAC.
 */
export function buildEvidence(db: DB, v: AuditVerification, anchors: readonly AuditAnchor[] = [], every = 1000): AuditEvidence {
  const through = v.sealedThrough;
  const checkpoints = through
    ? (db.prepare("SELECT seq, mac FROM audit_seal WHERE seq <= ? AND (seq % ? = 0 OR seq = ?) ORDER BY seq").all(through, every, through) as { seq: number; mac: string }[])
    : [];
  const first = through ? (db.prepare("SELECT MIN(seq) AS s FROM audit_seal").get() as { s: number | null }).s : null;
  const head = checkpoints.length ? checkpoints[checkpoints.length - 1] : null;
  return {
    format: "hlos.audit-evidence/1",
    generatedAt: new Date().toISOString(),
    lab: v.lab,
    keyId: v.keyId,
    demoKey: v.demoKey,
    verification: v,
    head: head && head.seq === through ? head : null,
    ranges: through && first ? [{ fromSeq: first, toSeq: through, events: v.checked }] : [],
    checkpoints,
    anchors: [...anchors],
    notice:
      (v.demoKey ? "Sealed with the PUBLIC demo key (demo-not-secret): anyone can recompute these seals, so they prove nothing. " : "") +
      "Contains no audit event content. A database-only chain cannot stop someone holding both the database and the key; anchors detect a rewrite only before the newest anchor, and only if the anchor file is kept where that person cannot change it.",
  };
}

/** True for the public demo key id. */
export function isDemoKeyId(id: string | null | undefined): boolean {
  return id === DEMO_AUDIT_KEY_ID;
}

// ------------------------------------------------------------------ report (the /audit page and POST /api/audit/verify)

export interface AuditAnchorFileStatus {
  /** HLOS_AUDIT_ANCHOR_PATH is set. The path itself is never shown. */
  configured: boolean;
  count: number;
  last: AuditAnchor | null;
  /** Why the anchor file could not be used (read, parsed or accepted); verification then counts as not passed. */
  error: string | null;
}

export interface AuditReport {
  /** The chain verified AND, when an anchor file is configured, it was read and matched. */
  ok: boolean;
  verification: AuditVerification;
  anchorFile: AuditAnchorFileStatus;
  evidence: AuditEvidence;
}

/** Reads the anchors of HLOS_AUDIT_ANCHOR_PATH for verification (fail closed: an unusable file is an error, not "no anchors"). */
export function anchorFileStatus(db: DB): { status: AuditAnchorFileStatus; anchors: AuditAnchor[] } {
  if (!process.env.HLOS_AUDIT_ANCHOR_PATH?.trim()) return { status: { configured: false, count: 0, last: null, error: null }, anchors: [] };
  try {
    const anchors = readAnchorFile(resolveAnchorPath(db));
    return { status: { configured: true, count: anchors.length, last: anchors[anchors.length - 1] ?? null, error: null }, anchors };
  } catch (e) {
    const message = e instanceof AuditAnchorError ? e.message : "The anchor file could not be used.";
    return { status: { configured: true, count: 0, last: null, error: message }, anchors: [] };
  }
}

/** Verification with the configured anchors, plus the downloadable evidence. Read-only. */
export function auditReport(db: DB, key: AuditKeyConfig): AuditReport {
  const { status, anchors } = anchorFileStatus(db);
  const verification = verifyAuditChain(db, { key, anchors });
  const evidence = { ...buildEvidence(db, verification, anchors), anchorFile: { configured: status.configured, count: status.count, error: status.error } };
  return { ok: verification.ok && !status.error, verification, anchorFile: status, evidence };
}
