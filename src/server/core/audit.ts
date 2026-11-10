import type { Ctx } from "./context";
import { newId } from "./ids";
import { sealPending } from "./audit-seal";

export interface AuditInput {
  action: string;
  entityType: string;
  entityId: string;
  summary: string;
  accessionId?: string | null;
  intakeItemId?: string | null;
  before?: unknown;
  after?: unknown;
  reason?: string | null;
  /** Importer events only: the source message, "<sourceId>:<messageId>:v<version>". */
  sourceRef?: string | null;
}

/**
 * Append-only local audit trail (enforced by SQLite triggers), sealed into a
 * tamper-EVIDENT HMAC chain (src/server/core/audit-seal.ts) in the same
 * transaction as the insert.
 *
 * - Inside a transaction (every command: executeCommand runs one IMMEDIATE
 *   transaction): the insert and the seal join it. The insert takes the write
 *   lock, so no other process can seal in between, and a rollback removes both.
 * - Outside a transaction (sign-in events, the admin CLI): the insert and the
 *   seal run in their own IMMEDIATE transaction, so two processes cannot
 *   interleave their seals.
 *
 * Every event also records the command's permission and (secured mode) a
 * session reference taken from the context (set by executeCommand), and the
 * source message reference when the importer passes one.
 */
export function audit(ctx: Ctx, input: AuditInput): void {
  const db = ctx.db;
  const write = () => {
    db.prepare(
      `INSERT INTO audit_event (id, at, recorded_at, actor_id, actor_role, origin, action, entity_type, entity_id,
        accession_id, intake_item_id, summary, before_json, after_json, reason, correlation_id, permission, session_ref, source_ref)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      newId(db, "aud"),
      ctx.now,
      new Date().toISOString(),
      ctx.actor.id,
      ctx.actor.role,
      ctx.origin,
      input.action,
      input.entityType,
      input.entityId,
      input.accessionId ?? null,
      input.intakeItemId ?? null,
      input.summary,
      input.before === undefined ? null : JSON.stringify(input.before),
      input.after === undefined ? null : JSON.stringify(input.after),
      input.reason ?? null,
      ctx.correlationId,
      ctx.permission ?? null,
      ctx.sessionRef ?? null,
      input.sourceRef ?? null,
    );
    sealPending(db);
  };
  if (db.inTransaction) write();
  else db.transaction(write).immediate();
}
