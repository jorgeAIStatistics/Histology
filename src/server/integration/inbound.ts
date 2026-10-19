import crypto from "node:crypto";
import type { DB } from "../db/db";
import { getDb } from "../db/db";
import { makeCtx, SYSTEM_ACTOR, type Ctx } from "../core/context";
import { log } from "../core/log";
import { isDemoMode } from "../runtime-mode";
import { importSourceMessage, OPENS_REVIEW, type ImportResult, type ReceiptVia, type ReconciliationNote } from "../domain/sourceImport";
import { checkAccessionMessage, isAccessionMessageType } from "./accession-schemas";
import {
  CONTRACT_MAJOR,
  CONTRACT_VERSION,
  MAX_BODY_BYTES,
  SIGNATURE_HEADER,
  SIMULATED_SOURCE_ADAPTERS,
  SOURCE_HEADER,
  contractMajor,
  deriveSourceSecret,
  parseEnvelope,
  payloadSchemaErrors,
  verifySignature,
  type AckBody,
  type AckStatus,
  type ContractError,
  type NakBody,
} from "./contract";

/**
 * The inbound boundary of contract "hlos.source-message" 1.0 (docs/release/integration-contract.md).
 *
 * POST /api/integration/inbound (src/app/api/integration/inbound/route.ts) exists ONLY when all hold, read on
 * every request:
 *   - the synthetic demo mode (isDemoMode(); secured and locked builds answer 404, whatever else is set);
 *   - HLOS_INTEGRATION_SIMULATOR=1;
 *   - HLOS_INTEGRATION_SIM_SECRET set, at least 32 characters (the simulator root secret).
 * Otherwise every method gets the same 404 as an unknown path. Only integration sources whose adapter is a
 * simulated source-system adapter are accepted, so nothing here can receive data from a real system.
 *
 * Order of checks (each refusal records NOTHING unless it says so):
 *   1. 404 gate; 413 body too large; 415 not JSON.
 *   2. Source and signature: X-HLOS-Source names a simulated source; X-HLOS-Signature verifies (HMAC-SHA256
 *      over "<t>.<raw body>", per-source secret, 5-minute tolerance, constant-time) → else 401.
 *   3. Envelope: JSON, contract name, MAJOR version (422), members (400); envelope source_id must equal the
 *      signing source (401).
 *   4. Source state: a source set offline (simulated outage) → 503 Retry-After; nothing is recorded, the
 *      source keeps the message and retries.
 *   5. handleEnvelope, inside ONE immediate transaction with an import context (origin "import"):
 *      importSourceMessage decides duplicate → invalid (400 NAK, KEPT in the failure queue) → stale → applied.
 *      A busy database → 503 Retry-After (the transaction rolled back; nothing recorded).
 *
 * The in-process pump (src/server/sim/pump.ts) calls handleEnvelope too, so there is one mapping and one
 * validation path for every inbound message.
 */

export const INBOUND_PATH = "/api/integration/inbound";
export const SIMULATOR_SWITCH = "HLOS_INTEGRATION_SIMULATOR";
export const SIMULATOR_SECRET_ENV = "HLOS_INTEGRATION_SIM_SECRET";
export const MIN_SIMULATOR_SECRET_LENGTH = 32;
/** Retry-After for a source set offline (simulated outage) and for a busy database. */
export const RETRY_AFTER_OFFLINE_SECONDS = 30;
export const RETRY_AFTER_BUSY_SECONDS = 2;
export const RETRY_AFTER_FAILED_SECONDS = 30;

/** The simulator root secret, or null when it is missing or too short. Never logged or returned. */
export function simulatorRootSecret(): string | null {
  const v = process.env[SIMULATOR_SECRET_ENV] ?? "";
  return v.length >= MIN_SIMULATOR_SECRET_LENGTH ? v : null;
}

/** True only in synthetic demo mode, with the simulator switch on and a root secret configured. */
export function inboundEnabled(): boolean {
  return isDemoMode() && process.env[SIMULATOR_SWITCH] === "1" && simulatorRootSecret() !== null;
}

interface SourceRow {
  id: string;
  name: string;
  adapter: string;
  tenant_id: string | null;
  status: string;
}

function loadSource(db: DB, sourceId: string): SourceRow | undefined {
  return db.prepare("SELECT id, name, adapter, tenant_id, status FROM integration_source WHERE id = ?").get(sourceId) as SourceRow | undefined;
}

function isSimulatedSource(s: SourceRow | undefined): s is SourceRow {
  return !!s && (SIMULATED_SOURCE_ADAPTERS as readonly string[]).includes(s.adapter) && !!s.tenant_id;
}

// ------------------------------------------------------------------ the one mapping

/** An envelope that passed the transport checks (HTTP), or one the in-process pump built from its outbox. */
export interface InboundMessage {
  contract_version: string;
  source_id: string;
  message_id: string;
  message_type: string;
  /** The source's claimed event time; null → the payload's own time (pump rows without one). */
  sent_at: string | null;
  correlation_id?: string | null;
  /** A JSON object (HTTP) or verbatim JSON text (the in-process outbox). */
  payload: unknown;
}

export interface EnvelopeOutcome {
  httpStatus: 200 | 400 | 401 | 422 | 500 | 503;
  body: AckBody | NakBody;
  /** The importer's result when the message reached it (null: refused before it, nothing recorded). */
  result: ImportResult | null;
  retryAfterSeconds?: number;
}

/**
 * Notes meaning part of the message was HELD BACK for a person (not applied): the source's identifiers or an
 * issued part disagree with what is on file. ACK status `conflict_review`.
 */
const HELD_BACK: ReadonlySet<ReconciliationNote["kind"]> = new Set([
  "patient_conflict",
  "order_level_review",
  "content_conflict_review",
  "correction_review_opened",
  "correction_review_updated",
  "accession_mismatch_review",
]);

export function ackStatusFor(result: ImportResult): AckStatus {
  if (result.outcome === "duplicate_ignored") return "duplicate";
  if (result.reconciliation.some((n) => HELD_BACK.has(n.kind))) return "conflict_review";
  if (result.outcome === "stale_ignored") return "stale";
  return "accepted";
}

/**
 * Structured reasons for a failed import, from the same checks the importer ran (one validation path). [] when
 * the payload is valid: the failure was a processing failure (500, retryable), not bad data.
 */
export function failureErrors(db: DB, source: { id: string; name: string }, msg: InboundMessage): ContractError[] {
  if (!String(msg.message_id ?? "").trim()) return [{ path: "message_id", code: "required", message: "Required." }];
  let payload: unknown = msg.payload;
  if (typeof payload === "string") {
    try {
      payload = JSON.parse(payload);
    } catch {
      return [{ path: "payload", code: "invalid_json", message: "The payload is not valid JSON." }];
    }
  }
  if (isAccessionMessageType(msg.message_type)) {
    const checked = checkAccessionMessage(db, source, msg.message_type, payload);
    return checked.ok ? [] : checked.errors;
  }
  return payloadSchemaErrors(msg.message_type, payload);
}

/**
 * Map ONE inbound message onto the domain: importSourceMessage (orders, specimen.submitted, and the accession
 * messages it dispatches), with the caller's import context. Runs inside the CALLER's transaction (the HTTP
 * handler's immediate transaction, or the pump's per-message transaction). Never throws for bad data.
 */
export function handleEnvelope(ctx: Ctx, msg: InboundMessage, opts: { via: ReceiptVia }): EnvelopeOutcome {
  const db = ctx.db;
  const ids = { message_id: msg.message_id, correlation_id: ctx.correlationId };
  if (contractMajor(msg.contract_version) !== CONTRACT_MAJOR) {
    return {
      httpStatus: 422,
      result: null,
      body: { status: "rejected", ...ids, errors: [{ path: "contract_version", code: "unsupported_contract_version", message: `Only contract ${CONTRACT_MAJOR}.x is accepted.` }] },
    };
  }
  const source = loadSource(db, msg.source_id);
  if (!isSimulatedSource(source)) {
    return { httpStatus: 401, result: null, body: { status: "rejected", ...ids, errors: [{ path: "source_id", code: "unknown_source", message: "Not a source this endpoint accepts." }] } };
  }
  if (source.status === "offline") {
    return {
      httpStatus: 503,
      result: null,
      retryAfterSeconds: RETRY_AFTER_OFFLINE_SECONDS,
      body: {
        status: "unavailable",
        ...ids,
        retry_after_seconds: RETRY_AFTER_OFFLINE_SECONDS,
        errors: [{ path: "source_id", code: "source_offline", message: "This source is marked unreachable here (simulated outage). Nothing was recorded; keep the message and retry." }],
      },
    };
  }

  const result = importSourceMessage(
    ctx,
    source.id,
    { messageId: msg.message_id, messageType: msg.message_type, payload: msg.payload, sentAt: msg.sent_at },
    { via: opts.via },
  );

  if (result.outcome === "failed") {
    const errors = failureErrors(db, source, msg);
    if (errors.length) {
      return { httpStatus: 400, result, body: { status: "rejected", ...ids, receipt_id: result.eventId, received_at: ctx.now, errors } };
    }
    return {
      httpStatus: 500,
      result,
      retryAfterSeconds: RETRY_AFTER_FAILED_SECONDS,
      body: {
        status: "failed",
        ...ids,
        receipt_id: result.eventId,
        received_at: ctx.now,
        retry_after_seconds: RETRY_AFTER_FAILED_SECONDS,
        errors: [
          {
            path: "(message)",
            code: "processing_failed",
            message: "Received and kept in the failure queue, but not applied. Re-send the same message later; staff can also retry it from the failure queue.",
          },
        ],
      },
    };
  }

  const body: AckBody = {
    status: ackStatusFor(result),
    receipt_id: result.eventId,
    received_at: ctx.now,
    message_id: msg.message_id,
    outcome: result.outcome,
    review_required: result.reconciliation.some((n) => OPENS_REVIEW.has(n.kind) || HELD_BACK.has(n.kind)),
    correlation_id: ctx.correlationId,
  };
  return { httpStatus: 200, result, body };
}

/**
 * The in-process pump's message for one outbox row: contract 1.0, the payload as stored (verbatim JSON text),
 * and the event time the payload itself states (updated_at, issued_at or acknowledged_at), as before.
 */
export function messageFromOutbox(sourceId: string, row: { message_id: string; message_type: string; payload: string }): InboundMessage {
  let sentAt: string | null = null;
  try {
    const p = JSON.parse(row.payload) as Record<string, unknown> | null;
    const t = p && typeof p === "object" ? (p.updated_at ?? p.issued_at ?? p.acknowledged_at) : null;
    if (typeof t === "string" && t.trim()) sentAt = t;
  } catch {
    /* invalid JSON: the importer records the failure; the event time stays unknown */
  }
  return { contract_version: CONTRACT_VERSION, source_id: sourceId, message_id: row.message_id, message_type: row.message_type, sent_at: sentAt, payload: row.payload };
}

// ------------------------------------------------------------------ HTTP

const NO_STORE = { "Cache-Control": "no-store" } as const;
const REQUEST_ID = /^[A-Za-z0-9._:-]{8,100}$/;

function notFound(): Response {
  return Response.json({ ok: false, error: { code: "NOT_FOUND", message: "Not found." } }, { status: 404, headers: NO_STORE });
}

function reply(status: number, body: AckBody | NakBody, correlationId: string, retryAfter?: number): Response {
  const headers: Record<string, string> = { ...NO_STORE, "X-Correlation-Id": correlationId };
  if (retryAfter !== undefined) headers["Retry-After"] = String(retryAfter);
  return Response.json(body, { status, headers });
}

function refuse(status: number, correlationId: string, errors: ContractError[], extra: Partial<NakBody> = {}, retryAfter?: number): Response {
  const kind: NakBody["status"] = status === 503 ? "unavailable" : status >= 500 ? "failed" : "rejected";
  return reply(status, { status: kind, errors, correlation_id: correlationId, ...extra }, correlationId, retryAfter);
}

function isBusy(e: unknown): boolean {
  const code = (e as { code?: unknown })?.code;
  return typeof code === "string" && (code.startsWith("SQLITE_BUSY") || code.startsWith("SQLITE_LOCKED"));
}

export interface InboundDeps {
  /** The database (tests); default the shared connection. Read only after the gate passes. */
  db?: () => DB;
  /** Wall clock in ms for the signature tolerance (tests). */
  nowMs?: () => number;
}

/** POST /api/integration/inbound. See the module comment for the order of checks. */
export async function handleInboundRequest(req: Request, deps: InboundDeps = {}): Promise<Response> {
  // The gate comes first: until it passes, every answer is the identical 404.
  if (!inboundEnabled() || req.method !== "POST") return notFound();
  const rootSecret = simulatorRootSecret()!;
  const given = req.headers.get("x-request-id")?.trim();
  let correlationId = given && REQUEST_ID.test(given) ? given : `req-${crypto.randomUUID()}`;

  const declared = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return refuse(413, correlationId, [{ path: "(body)", code: "too_large", message: `The body exceeds ${MAX_BODY_BYTES} bytes.` }]);
  }
  if (!/^application\/json(?:\s*;.*)?$/i.test((req.headers.get("content-type") ?? "").trim())) {
    return refuse(415, correlationId, [{ path: "headers.content-type", code: "unsupported_media_type", message: "Content-Type must be application/json." }]);
  }
  let raw: string;
  try {
    raw = await req.text();
  } catch {
    return refuse(400, correlationId, [{ path: "(body)", code: "unreadable", message: "The body could not be read." }]);
  }
  if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) {
    return refuse(413, correlationId, [{ path: "(body)", code: "too_large", message: `The body exceeds ${MAX_BODY_BYTES} bytes.` }]);
  }

  const db = (deps.db ?? getDb)();
  const nowMs = (deps.nowMs ?? Date.now)();

  // 2. Who signed it. An unknown or non-simulated source still costs one HMAC (no timing hint about which ids exist).
  const sourceId = (req.headers.get(SOURCE_HEADER) ?? "").trim();
  const source = sourceId && /^[a-z][a-z0-9_]{1,63}$/.test(sourceId) ? loadSource(db, sourceId) : undefined;
  const known = isSimulatedSource(source);
  const secret = deriveSourceSecret(rootSecret, known ? source.id : `unknown:${crypto.randomUUID()}`);
  const sig = verifySignature(req.headers.get(SIGNATURE_HEADER), raw, secret, nowMs);
  if (!known) {
    log("warn", "integration.inbound_refused", { correlationId, code: "unknown_source", httpStatus: 401 });
    return refuse(401, correlationId, [{ path: `headers.${SOURCE_HEADER}`, code: "unknown_source", message: "Not a source this endpoint accepts." }]);
  }
  if (!sig.ok) {
    log("warn", "integration.inbound_refused", { correlationId, sourceId: source.id, code: sig.code, httpStatus: 401 });
    return refuse(401, correlationId, [{ path: `headers.${SIGNATURE_HEADER}`, code: sig.code, message: sig.message }]);
  }

  // 3. The envelope.
  const env = parseEnvelope(raw);
  if (!env.ok) {
    log("warn", "integration.inbound_refused", { correlationId, sourceId: source.id, code: env.errors[0]?.code ?? "invalid_envelope", httpStatus: env.status });
    return refuse(env.status, correlationId, env.errors);
  }
  const envelope = env.envelope;
  if (envelope.source_id !== source.id) {
    log("warn", "integration.inbound_refused", { correlationId, sourceId: source.id, code: "source_mismatch", httpStatus: 401 });
    return refuse(401, correlationId, [{ path: "source_id", code: "source_mismatch", message: `The envelope's source_id must equal the signing source (${SOURCE_HEADER}).` }]);
  }
  // The source's correlation id (stable across its retries) becomes the local audit correlation id.
  if (envelope.correlation_id) correlationId = envelope.correlation_id;

  // 4 + 5. Map it, in one immediate transaction with an import context.
  const msg: InboundMessage = {
    contract_version: envelope.contract_version,
    source_id: envelope.source_id,
    message_id: envelope.message_id,
    message_type: envelope.message_type,
    sent_at: envelope.sent_at,
    correlation_id: envelope.correlation_id ?? null,
    payload: envelope.payload,
  };
  let out: EnvelopeOutcome;
  try {
    out = db.transaction(() => handleEnvelope(makeCtx(db, SYSTEM_ACTOR, "import", correlationId), msg, { via: "inbound" })).immediate();
  } catch (e) {
    if (isBusy(e)) {
      log("warn", "integration.inbound_busy", { correlationId, sourceId: source.id, httpStatus: 503 });
      return refuse(
        503,
        correlationId,
        [{ path: "(server)", code: "busy", message: "The laboratory database is busy. Nothing was recorded; retry after the indicated delay." }],
        { message_id: envelope.message_id, retry_after_seconds: RETRY_AFTER_BUSY_SECONDS },
        RETRY_AFTER_BUSY_SECONDS,
      );
    }
    log("error", "integration.inbound_failed", { correlationId, sourceId: source.id, error: e });
    return refuse(
      500,
      correlationId,
      [{ path: "(server)", code: "internal", message: "The message could not be processed. Nothing was recorded; retry later." }],
      { message_id: envelope.message_id, retry_after_seconds: RETRY_AFTER_FAILED_SECONDS },
      RETRY_AFTER_FAILED_SECONDS,
    );
  }
  log(out.httpStatus === 200 ? "info" : "warn", "integration.inbound", {
    correlationId,
    sourceId: source.id,
    messageId: envelope.message_id,
    messageType: envelope.message_type,
    httpStatus: out.httpStatus,
    status: out.body.status,
  });
  return reply(out.httpStatus, out.body, correlationId, out.retryAfterSeconds);
}
