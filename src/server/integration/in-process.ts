import type { DB } from "../db/db";
import { openDatabase } from "../db/db";
import { seedDemo } from "../seed/seed";
import { executeCommand } from "../commands";
import { handleInboundRequest, INBOUND_PATH } from "./inbound";
import type { DelayedAckParams, OutageControl, Transport } from "./simulator";

/**
 * The simulator without a server: the same handleInboundRequest the route calls (signature, envelope, payload,
 * one transaction), invoked with a Web Request built in-process. Used by the contract tests and by
 * `npm run integration:sim -- <scenario> --in-process` (a fresh in-memory synthetic seed; nothing is written to
 * disk). The inbound gate still applies: synthetic demo mode, HLOS_INTEGRATION_SIMULATOR=1 and a root secret.
 */

export function inProcessTransport(db: DB, opts: { nowMs?: () => number } = {}): Transport {
  return {
    name: "in-process",
    async post(body, headers) {
      const req = new Request(`http://localhost${INBOUND_PATH}`, { method: "POST", headers, body });
      const res = await handleInboundRequest(req, { db: () => db, nowMs: opts.nowMs });
      let parsed: unknown = null;
      try {
        parsed = await res.json();
      } catch {
        parsed = null;
      }
      const ra = res.headers.get("retry-after");
      return { status: res.status, body: parsed, ...(ra !== null && Number.isFinite(Number(ra)) ? { retryAfterSeconds: Number(ra) } : {}) };
    },
  };
}

/** A fresh in-memory synthetic demo day (clock paused at the seed's start). */
export function seededDemoDb(): DB {
  const db = openDatabase(":memory:");
  seedDemo(db, { clockRunning: false });
  return db;
}

/**
 * In-process outage: the presenter control a demo uses (integration.setSourceStatus, origin "user" as the
 * supervisor demo role). While the source is offline the endpoint answers 503 Retry-After and records nothing.
 */
export function inProcessOutage(db: DB, sourceId = "src_ema", presenterId = "stf_tanya"): OutageControl {
  const set = (status: "offline" | "connected") => {
    const r = executeCommand(db, presenterId, "integration.setSourceStatus", { sourceId, status });
    if (!r.ok) throw new Error(`Could not set ${sourceId} ${status}: ${r.error.message}`);
  };
  return {
    description: `${sourceId} set offline here with the presenter control (the endpoint answers 503 Retry-After and records nothing)`,
    async begin() {
      set("offline");
    },
    async end() {
      set("connected");
    },
  };
}

/**
 * The local half of scenario 9: the guided demo's steps 1 to 4 (rehearsal, as the supervisor demo role) request
 * and issue the hero accession through the real commands. Returns what the source would acknowledge.
 */
export function prepareDelayedAck(db: DB, presenterId = "stf_tanya"): Required<Pick<DelayedAckParams, "requestId">> & DelayedAckParams {
  for (const step of [1, 2, 3, 4]) {
    const r = executeCommand(db, presenterId, "demo.runStep", { step, autoStaffActions: true });
    if (!r.ok) throw new Error(`Guided demo step ${step} failed: ${r.error.message}`);
  }
  const req = db
    .prepare("SELECT ar.display_id, a.accession_number, a.namespace FROM accession_request ar LEFT JOIN accession a ON a.id = ar.accession_id ORDER BY ar.requested_at DESC LIMIT 1")
    .get() as { display_id: string; accession_number: string | null; namespace: string | null } | undefined;
  if (!req) throw new Error("No accession request was made by the guided demo steps.");
  return { requestId: req.display_id, accessionNumber: req.accession_number, namespace: req.namespace };
}
