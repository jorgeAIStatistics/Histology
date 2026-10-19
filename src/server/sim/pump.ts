import type { DB } from "@/server/db/db";
import { makeCtx, SYSTEM_ACTOR, type Ctx } from "@/server/core/context";
import { demoNow } from "@/server/core/clock";
import { audit } from "@/server/core/audit";
import { setSetting, getSetting } from "@/server/core/settings";
import { importSourceMessage, type ImportOutcome, type ReceiptVia } from "@/server/domain/sourceImport";
import { retireExpiredRuleSets } from "@/server/domain/routingRules";
import { log } from "@/server/core/log";

/**
 * SIMULATED source delivery (S6). The simulated source systems keep what they
 * would send in `sim_source_outbox`. This pump hands every row that is due
 * (available_at <= demo now) to the importer — but only while that source is
 * `connected`. While it is `offline` nothing is delivered and the attempt is
 * recorded, so an outage builds a real backlog that reconciles (once, without
 * duplicates) after the source is restored. `degraded` delivers with a
 * simulated 5-minute delay.
 *
 * Called on every GET /api/live poll and by integration.syncNow. It is cheap
 * when there is nothing to do and never throws.
 */

export const DEGRADED_DELAY_MINUTES = 5;
export const SOURCE_ADAPTERS = ["simulated_ema", "simulated_other_ehr"] as const;

interface SourceRow {
  id: string;
  name: string;
  status: string;
  last_success_at: string | null;
  last_attempt_at: string | null;
  last_error: string | null;
}

interface OutboxRow {
  id: string;
  source_id: string;
  message_id: string;
  message_type: string;
  available_at: string;
  payload: string;
}

export interface PumpSourceResult {
  sourceId: string;
  name: string;
  status: string;
  delivered: number;
  pending: number;
  outcomes: { messageId: string; outcome: ImportOutcome; detail: string }[];
}

export interface PumpResult {
  delivered: number;
  now: string;
  sources: PumpSourceResult[];
}

export function pumpSources(db: DB): { delivered: number } {
  try {
    return { delivered: pumpSourcesDetailed(db).delivered };
  } catch (e) {
    log("error", "pump.failed", { error: e });
    return { delivered: 0 };
  }
}

export function pumpSourcesDetailed(db: DB, opts: { sourceId?: string; via?: ReceiptVia } = {}): PumpResult {
  const now = demoNow(db);
  const result: PumpResult = { delivered: 0, now, sources: [] };
  const sources = db
    .prepare(
      `SELECT id, name, status, last_success_at, last_attempt_at, last_error FROM integration_source
        WHERE adapter IN (${SOURCE_ADAPTERS.map(() => "?").join(",")}) ${opts.sourceId ? "AND id = ?" : ""} ORDER BY id`,
    )
    .all(...SOURCE_ADAPTERS, ...(opts.sourceId ? [opts.sourceId] : [])) as SourceRow[];

  for (const s of sources) {
    const r: PumpSourceResult = { sourceId: s.id, name: s.name, status: s.status, delivered: 0, pending: 0, outcomes: [] };
    result.sources.push(r);
    try {
      if (s.status === "offline") {
        // Nothing is delivered; record the failed attempt (only when the demo time moved).
        if (s.last_attempt_at !== now || s.last_error !== "Simulated outage") {
          db.prepare("UPDATE integration_source SET last_attempt_at = ?, last_error = 'Simulated outage' WHERE id = ?").run(now, s.id);
        }
        r.pending = countPending(db, s.id, now);
        continue;
      }
      const cutoff = s.status === "degraded" ? new Date(Date.parse(now) - DEGRADED_DELAY_MINUTES * 60_000).toISOString() : now;
      const due = db
        .prepare(
          `SELECT id, source_id, message_id, message_type, available_at, payload FROM sim_source_outbox
            WHERE source_id = ? AND delivered_at IS NULL AND available_at <= ? ORDER BY available_at, id`,
        )
        .all(s.id, cutoff) as OutboxRow[];
      for (const row of due) {
        const outcome = deliverOne(db, s, row, opts.via ?? "pump");
        if (outcome) {
          r.delivered += 1;
          r.outcomes.push(outcome);
        }
      }
      result.delivered += r.delivered;
      r.pending = countPending(db, s.id, now);
      // A successful poll (even with no events) is a successful sync.
      const lastError = s.status === "degraded" ? `Simulated degraded connection (${DEGRADED_DELAY_MINUTES} min delay)` : null;
      if (s.last_success_at !== now || s.last_attempt_at !== now || s.last_error !== lastError) {
        db.prepare("UPDATE integration_source SET last_success_at = ?, last_attempt_at = ?, last_error = ? WHERE id = ?").run(now, now, lastError, s.id);
      }
    } catch (e) {
      log("error", "pump.source_failed", { sourceId: s.id, error: e });
    }
  }

  try {
    maintenance(db);
  } catch (e) {
    log("error", "pump.maintenance_failed", { error: e });
  }
  return result;
}

function countPending(db: DB, sourceId: string, now: string): number {
  return (db.prepare("SELECT COUNT(*) n FROM sim_source_outbox WHERE source_id = ? AND delivered_at IS NULL AND available_at <= ?").get(sourceId, now) as { n: number }).n;
}

/** One message in its own transaction (or savepoint): import, then mark delivered. Never throws. */
function deliverOne(db: DB, s: SourceRow, row: OutboxRow, via: ReceiptVia): { messageId: string; outcome: ImportOutcome; detail: string } | null {
  try {
    return db.transaction(() => {
      // Re-check inside the transaction so two concurrent polls cannot deliver the same row twice.
      const fresh = db.prepare("SELECT delivered_at FROM sim_source_outbox WHERE id = ?").get(row.id) as { delivered_at: string | null } | undefined;
      if (!fresh || fresh.delivered_at) return null;
      const ctx = makeCtx(db, SYSTEM_ACTOR, "import", `pump-${row.id}`);
      const res = importSourceMessage(ctx, s.id, { messageId: row.message_id, messageType: row.message_type, payload: row.payload }, { via });
      db.prepare("UPDATE sim_source_outbox SET delivered_at = ? WHERE id = ?").run(ctx.now, row.id);
      return { messageId: row.message_id, outcome: res.outcome, detail: res.detail };
    })();
  } catch (e) {
    log("error", "pump.delivery_failed", { correlationId: `pump-${row.id}`, sourceId: s.id, messageId: row.message_id, error: e });
    return null;
  }
}

/**
 * Cheap housekeeping on each poll:
 *  - close "Amended order received — review and release H-xxxx" tasks once that hold has been released;
 *  - retire approved routing sets whose (future-dated) effective period has ended.
 */
function maintenance(db: DB): void {
  const stale = db
    .prepare(
      `SELECT t.id, t.title, h.display_id, t.accession_id, t.intake_item_id FROM task t JOIN hold h ON h.id = t.entity_id
        WHERE t.kind = 'order_change_review' AND t.entity_type = 'hold' AND t.status IN ('open','in_progress') AND h.status = 'released'`,
    )
    .all() as { id: string; title: string; display_id: string; accession_id: string | null; intake_item_id: string | null }[];
  const due = db.prepare("SELECT COUNT(*) n FROM routing_rule_set WHERE status = 'approved' AND effective_to IS NOT NULL AND effective_to <= ?").get(demoNow(db)) as { n: number };
  if (!stale.length && !due.n) return;
  db.transaction(() => {
    const ctx: Ctx = makeCtx(db, SYSTEM_ACTOR, "system", "pump-maintenance");
    for (const t of stale) {
      db.prepare("UPDATE task SET status = 'done', completed_at = ?, completed_by = 'system', version = version + 1 WHERE id = ? AND status IN ('open','in_progress')").run(ctx.now, t.id);
      audit(ctx, {
        action: "task.closed_by_system",
        entityType: "task",
        entityId: t.id,
        accessionId: t.accession_id,
        intakeItemId: t.intake_item_id,
        summary: `Task closed: hold ${t.display_id} was released by an authorized person`,
      });
    }
    if (due.n) retireExpiredRuleSets(ctx);
  })();
}

// ------------------------------------------------------------------ outage bookkeeping

export function offlineSinceKey(sourceId: string): string {
  return `s6_offline_since:${sourceId}`;
}

export function markOffline(db: DB, sourceId: string, now: string): void {
  if (!getSetting(db, offlineSinceKey(sourceId))) setSetting(db, offlineSinceKey(sourceId), now, now);
}

export function clearOffline(db: DB, sourceId: string, now: string): void {
  setSetting(db, offlineSinceKey(sourceId), "", now);
}
