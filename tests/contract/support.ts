// Shared helpers for the contract tests (tests/contract/*.test.ts). Synthetic data only.
import type { DB } from "@/server/db/db";
import { handleInboundRequest, INBOUND_PATH } from "@/server/integration/inbound";
import { inProcessOutage, inProcessTransport } from "@/server/integration/in-process";
import { makeEnvelope, type SourceEnvelope } from "@/server/integration/contract";
import { runScenario, signedHeaders, SimSourceState, worldFromDb, type DelayedAckParams, type RunDeps, type ScenarioName, type SignOptions } from "@/server/integration/simulator";
import { labLocalToIso } from "@/lib/time";

/** A fixed, synthetic, test-only simulator root secret (public: it is in this file). */
export const ROOT_SECRET = "hlos-contract-test-synthetic-root-secret-0001";

const SAVED: Record<string, string | undefined> = {};

/** Turn the inbound endpoint on for this test file (synthetic demo mode is set by vitest.config.ts). */
export function enableInbound(): void {
  for (const k of ["HLOS_INTEGRATION_SIMULATOR", "HLOS_INTEGRATION_SIM_SECRET", "HLOS_MODE"]) SAVED[k] = process.env[k];
  process.env.HLOS_INTEGRATION_SIMULATOR = "1";
  process.env.HLOS_INTEGRATION_SIM_SECRET = ROOT_SECRET;
  process.env.HLOS_MODE = "demo";
}

export function restoreEnv(): void {
  for (const [k, v] of Object.entries(SAVED)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

export const at = (hhmm: string) => labLocalToIso("2026-10-14", hhmm);

export interface Posted {
  status: number;
  body: Record<string, any>;
  headers: Headers;
}

/** POST an envelope (or a raw body) to the inbound handler in-process, signed unless `sign === false`. */
export async function post(
  db: DB,
  envelope: SourceEnvelope | Record<string, unknown>,
  opts: { sign?: SignOptions | false; rawBody?: string; headers?: Record<string, string>; nowMs?: number; method?: string } = {},
): Promise<Posted> {
  const body = opts.rawBody ?? JSON.stringify(envelope);
  const nowMs = opts.nowMs ?? Date.now();
  const signed = opts.sign === false ? { "content-type": "application/json" } : signedHeaders(ROOT_SECRET, envelope as SourceEnvelope, body, nowMs, opts.sign ?? {});
  const req = new Request(`http://localhost${INBOUND_PATH}`, {
    method: opts.method ?? "POST",
    headers: { ...signed, ...(opts.headers ?? {}) },
    body: (opts.method ?? "POST") === "GET" ? undefined : body,
  });
  const res = await handleInboundRequest(req, { db: () => db, nowMs: () => nowMs });
  let parsed: Record<string, any> = {};
  try {
    parsed = (await res.json()) as Record<string, any>;
  } catch {
    parsed = {};
  }
  return { status: res.status, body: parsed, headers: res.headers };
}

/** A new synthetic order payload (contract 1.0 order.upsert). */
export function orderPayload(o: { orderId: string; version?: number; mrn?: string; name?: string; birthDate?: string; updatedAt?: string; officeId?: string; specimens?: Record<string, unknown>[] }) {
  return {
    resourceType: "SimulatedOrder",
    order_id: o.orderId,
    version: o.version ?? 1,
    updated_at: o.updatedAt ?? at("10:30"),
    status: "active",
    patient: { mrn: o.mrn ?? "990901", name: o.name ?? "Testwood, Ada", birth_date: o.birthDate ?? "1970-01-02" },
    encounter_id: null,
    office_id: o.officeId ?? "LOC-104",
    ordering_provider_id: "PRV-2207",
    clinical_note: null,
    amendment_note: null,
    specimens: o.specimens ?? [{ designation: "A", site: "Left forearm", laterality: "left", procedure: "shave", collected_at: null, expected_containers: 1, requested_stains: [], orientation: null }],
  };
}

export function envelope(e: { messageId: string; type?: string; payload: unknown; sourceId?: string; sentAt?: string; correlationId?: string; contractVersion?: string }): SourceEnvelope {
  return makeEnvelope({
    sourceId: e.sourceId ?? "src_ema",
    messageId: e.messageId,
    messageType: e.type ?? "order.upsert",
    sentAt: e.sentAt ?? at("10:31"),
    payload: e.payload,
    correlationId: e.correlationId,
    contractVersion: e.contractVersion,
  });
}

/** Row counts of everything an inbound message could touch. */
export function counts(db: DB) {
  const n = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
  return {
    orders: n("SELECT COUNT(*) n FROM source_order"),
    versions: n("SELECT COUNT(*) n FROM source_order_version"),
    parts: n("SELECT COUNT(*) n FROM source_order_part"),
    patients: n("SELECT COUNT(*) n FROM patient_ref"),
    events: n("SELECT COUNT(*) n FROM integration_event"),
    receipts: n("SELECT COUNT(*) n FROM integration_receipt"),
    audit: n("SELECT COUNT(*) n FROM audit_event"),
    tasks: n("SELECT COUNT(*) n FROM task"),
    accessions: n("SELECT COUNT(*) n FROM accession"),
    specimenParts: n("SELECT COUNT(*) n FROM specimen_part"),
    corrections: n("SELECT COUNT(*) n FROM correction_review"),
    offices: n("SELECT COUNT(*) n FROM office"),
  };
}

/** Everything local work depends on, for "nothing changed" comparisons. */
export function localSnapshot(db: DB) {
  const all = (sql: string) => db.prepare(sql).all();
  return {
    orders: all("SELECT id, source_version, source_status, patient_ref_id, office_id, review_state, version FROM source_order ORDER BY id"),
    parts: all("SELECT id, site_text, laterality, procedure, status, expected_containers FROM source_order_part ORDER BY id"),
    patients: all("SELECT * FROM patient_ref ORDER BY id"),
    accessions: all("SELECT id, accession_number, namespace, patient_ref_id, case_status, version FROM accession ORDER BY id"),
    specimenParts: all("SELECT id, designation, site_text, laterality, procedure, status, version FROM specimen_part ORDER BY id"),
    intake: all("SELECT id, status, version FROM intake_item ORDER BY id"),
    holds: all("SELECT id, status, version FROM hold ORDER BY id"),
    tasks: all("SELECT id, status, version FROM task ORDER BY id"),
    workOrders: all("SELECT id, status, version FROM work_order ORDER BY id"),
  };
}

export const noSleep = async () => {};

/** Run one scenario in-process against `db` (signature, envelope and payload checks included); waits are skipped. */
export function runIn(db: DB, name: ScenarioName, extra: Partial<RunDeps> & { delayedAck?: DelayedAckParams } = {}) {
  return runScenario(name, {
    transport: inProcessTransport(db),
    rootSecret: ROOT_SECRET,
    world: worldFromDb(db),
    outage: inProcessOutage(db),
    sleep: noSleep,
    state: extra.state ?? new SimSourceState(),
    ...extra,
  });
}
