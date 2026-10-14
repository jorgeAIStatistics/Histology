import type { DB } from "../db/db";
import type { Ctx } from "../core/context";
import { SYSTEM_ACTOR } from "../core/context";
import { nextSeq, newId } from "../core/ids";

/**
 * SIMULATED authoritative source (EMA-SIM). In a real deployment the official
 * accession number is assigned by the lab's EHR/LIS through its authorized
 * workflow; this app would only request it and record the result. Here a
 * simulator stands in for that system so the demo can run offline.
 *
 * - The number comes from the simulator's own sequence (`accession_number`),
 *   formatted D26-0xxxx in the namespace "EMA-SIM DERM". No screen or API lets
 *   anyone type a number in as "issued" (INV-6).
 * - While the simulated source is offline, nothing is issued; the request
 *   stays `submitted` and can be retried.
 */

export const ACCESSION_NAMESPACE = "EMA-SIM DERM";
export const ISSUING_SYSTEM = "Authoritative source simulator (EMA-SIM)";
export const ACCESSION_SOURCE_ID = "src_ema";

export interface SourceAvailability {
  available: boolean;
  status: string;
  name: string;
  lastSuccessAt: string | null;
  lastError: string | null;
}

export function accessionSourceStatus(db: DB): SourceAvailability {
  const r = db.prepare("SELECT name, status, last_success_at, last_error FROM integration_source WHERE id = ?").get(ACCESSION_SOURCE_ID) as
    | { name: string; status: string; last_success_at: string | null; last_error: string | null }
    | undefined;
  if (!r) return { available: false, status: "unknown", name: "EMA-SIM (simulated)", lastSuccessAt: null, lastError: "Source adapter not configured" };
  return { available: r.status !== "offline", status: r.status, name: r.name, lastSuccessAt: r.last_success_at, lastError: r.last_error };
}

export interface IssuedNumber {
  accessionNumber: string;
  namespace: string;
  sourceCaseId: string;
  issuedAt: string;
  issuedBy: string;
}

/** The simulator assigns the next free number in its namespace. Call only when the source is available. */
export function issueNumber(db: DB, now: string): IssuedNumber {
  for (let attempt = 0; attempt < 1000; attempt++) {
    const n = nextSeq(db, "accession_number", 4817);
    const num = `D26-${String(n).padStart(5, "0")}`;
    const taken = db.prepare("SELECT 1 FROM accession WHERE namespace = ? AND accession_number = ?").get(ACCESSION_NAMESPACE, num);
    if (!taken) return { accessionNumber: num, namespace: ACCESSION_NAMESPACE, sourceCaseId: `SIM-CASE-${String(n).padStart(5, "0")}`, issuedAt: now, issuedBy: ISSUING_SYSTEM };
  }
  throw new Error("Simulated source could not find a free accession number");
}

/** A context for writes attributed to the simulator (audit origin 'simulator'). */
export function simulatorCtx(ctx: Ctx): Ctx {
  return { ...ctx, actor: SYSTEM_ACTOR, origin: "simulator" };
}

/** Record the simulated `accession.issued` message as an integration event (idempotent per request). */
export function recordIssuedEvent(ctx: Ctx, requestDisplayId: string, issued: IssuedNumber, payload: unknown): void {
  ctx.db
    .prepare(
      `INSERT OR IGNORE INTO integration_event (id, source_id, message_id, message_type, entity_key, source_version, source_updated_at, received_at, outcome, detail, payload, receipt_count)
       VALUES (?, ?, ?, 'accession.issued', ?, 1, ?, ?, 'applied', ?, ?, 1)`,
    )
    .run(
      newId(ctx.db, "ie"),
      ACCESSION_SOURCE_ID,
      `accession.issued:${requestDisplayId}`,
      `${issued.namespace}:${issued.accessionNumber}`,
      issued.issuedAt,
      ctx.now,
      `Accession ${issued.accessionNumber} issued for request ${requestDisplayId} (simulated source)`,
      JSON.stringify(payload),
    );
  // Connector health (last_success_at / last_attempt_at) is owned by the integration pump; not touched here.
}
