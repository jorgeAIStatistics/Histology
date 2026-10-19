import crypto from "node:crypto";
import { z } from "zod";
import { SimulatedOrderSchema, SpecimenSubmittedSchema } from "../domain/sourceImport";
import { ACCESSION_MESSAGE_TYPES, AccessionAcknowledgedSchema, AccessionIssuedSchema, isoDateTime } from "./accession-schemas";
import { issuesToErrors, type ContractError } from "./errors";

export type { ContractError } from "./errors";

/**
 * Contract "hlos.source-message" 1.0: the canonical, versioned envelope a source system uses to send
 * order and accession events to this laboratory. The prose contract is docs/release/integration-contract.md;
 * this file is its executable form. Pure: no database, no environment.
 *
 * Wire format (HTTPS POST, JSON body, one message per request):
 *
 *   {
 *     "contract": "hlos.source-message",
 *     "contract_version": "1.0",
 *     "source_id": "src_ema",
 *     "message_id": "ORD-77150#v2",          // stable and unique per source; the de-duplication key
 *     "message_type": "order.amend",
 *     "sent_at": "2026-10-14T14:40:00Z",     // the source's claimed event time
 *     "correlation_id": "ema-7f3a…",         // optional; carried into the local audit trail
 *     "payload": { … }                        // validated per message_type (PAYLOAD_SCHEMAS)
 *   }
 *
 *   Headers: Content-Type: application/json
 *            X-HLOS-Source: src_ema
 *            X-HLOS-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">
 *
 * Versioning: a different MAJOR version is refused (422); a higher MINOR version is accepted and its
 * unknown members are ignored (every object schema here strips unknown keys; nothing is strict).
 */

export const CONTRACT_NAME = "hlos.source-message";
export const CONTRACT_VERSION = "1.0";
export const CONTRACT_MAJOR = 1;

export const SOURCE_HEADER = "x-hlos-source";
export const SIGNATURE_HEADER = "x-hlos-signature";
/** Accepted clock difference between the signer's timestamp and this server's wall clock. */
export const SIGNATURE_TOLERANCE_SECONDS = 300;
/** Largest accepted request body (bytes). A real order is a few kilobytes. */
export const MAX_BODY_BYTES = 256 * 1024;

export const MESSAGE_TYPES = ["order.upsert", "order.amend", "order.cancel", "specimen.submitted", ...ACCESSION_MESSAGE_TYPES] as const;
export type MessageType = (typeof MESSAGE_TYPES)[number];

export function isMessageType(t: string): t is MessageType {
  return (MESSAGE_TYPES as readonly string[]).includes(t);
}

/**
 * Integration sources the inbound endpoint accepts: SIMULATED source-system adapters only (the same set the
 * in-process pump serves, src/server/sim/pump.ts SOURCE_ADAPTERS; a contract test keeps them equal). A printer,
 * notification or assistant connector is not a source of orders, and no real adapter exists in this build.
 */
export const SIMULATED_SOURCE_ADAPTERS = ["simulated_ema", "simulated_other_ehr"] as const;

/**
 * Payload schema per message type. The SAME schema objects the importer applies
 * (src/server/domain/sourceImport.ts, src/server/integration/accession-schemas.ts), so a NAK's paths and the
 * failure queue's reason always come from one validation.
 */
export const PAYLOAD_SCHEMAS: Record<MessageType, z.ZodType> = {
  "order.upsert": SimulatedOrderSchema,
  "order.amend": SimulatedOrderSchema,
  "order.cancel": SimulatedOrderSchema,
  "specimen.submitted": SpecimenSubmittedSchema,
  "accession.issued": AccessionIssuedSchema,
  "accession.acknowledged": AccessionAcknowledgedSchema,
};

const MESSAGE_ID = /^[A-Za-z0-9][A-Za-z0-9._:#/@+-]{0,127}$/;
const SOURCE_ID = /^[a-z][a-z0-9_]{1,63}$/;
const CORRELATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,99}$/;
const MESSAGE_TYPE_SHAPE = /^[a-z]+(?:\.[a-z_]+)+$/;

/**
 * The envelope after the version gate. `message_type` is checked for its SHAPE here and for support at the
 * payload stage, so an unsupported type from an authenticated source lands in the failure queue (retryable
 * after an upgrade) instead of vanishing.
 */
export const EnvelopeSchema = z.object({
  contract: z.literal(CONTRACT_NAME),
  contract_version: z.string().regex(/^\d{1,3}\.\d{1,3}$/, "Must be MAJOR.MINOR, e.g. 1.0."),
  source_id: z.string().regex(SOURCE_ID, "Must be the source's id (lower-case letters, digits, underscore)."),
  message_id: z.string().regex(MESSAGE_ID, "Must be 1 to 128 characters: letters, digits and . _ : # / @ + -, starting with a letter or digit."),
  message_type: z.string().regex(MESSAGE_TYPE_SHAPE, "Must look like order.upsert."),
  sent_at: isoDateTime,
  correlation_id: z.string().regex(CORRELATION_ID, "Must be 8 to 100 characters: letters, digits and . _ : -.").nullable().optional(),
  payload: z.record(z.string(), z.unknown()),
});
export type SourceEnvelope = z.infer<typeof EnvelopeSchema>;

export type EnvelopeParse =
  | { ok: true; envelope: SourceEnvelope }
  | { ok: false; status: 400 | 422; errors: ContractError[] };

/** The major number of "MAJOR.MINOR", or null when it is not in that form. */
export function contractMajor(version: unknown): number | null {
  if (typeof version !== "string") return null;
  const m = /^(\d{1,3})\.(\d{1,3})$/.exec(version.trim());
  return m ? Number(m[1]) : null;
}

/**
 * Raw body → envelope. Order: JSON (400 invalid_json) → contract name and major version (422; checked before
 * the rest because another major may have another shape) → envelope members (400 with paths). The payload is
 * NOT validated here: that happens in the importer's pipeline after the duplicate check.
 */
export function parseEnvelope(raw: string): EnvelopeParse {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, status: 400, errors: [{ path: "(body)", code: "invalid_json", message: "The body is not valid JSON." }] };
  }
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    return { ok: false, status: 400, errors: [{ path: "(body)", code: "invalid_type", message: "The body must be a JSON object (the envelope)." }] };
  }
  const obj = json as Record<string, unknown>;
  if (obj.contract !== undefined && obj.contract !== CONTRACT_NAME) {
    return { ok: false, status: 422, errors: [{ path: "contract", code: "unsupported_contract", message: `Only "${CONTRACT_NAME}" is accepted here.` }] };
  }
  if (obj.contract_version !== undefined) {
    const major = contractMajor(obj.contract_version);
    if (major !== null && major !== CONTRACT_MAJOR) {
      return {
        ok: false,
        status: 422,
        errors: [{ path: "contract_version", code: "unsupported_contract_version", message: `Contract major version ${major} is not supported; this endpoint accepts ${CONTRACT_MAJOR}.x.` }],
      };
    }
  }
  const parsed = EnvelopeSchema.safeParse(obj);
  if (!parsed.success) return { ok: false, status: 400, errors: issuesToErrors(parsed.error.issues, "") };
  return { ok: true, envelope: parsed.data };
}

/**
 * Payload errors for a message type, from the same schema the importer applies. [] when the payload is valid
 * (a failure then was a processing failure, not bad data). Reference checks (accession request ids, issuing
 * authority) need the database and live in accession-schemas.ts checkAccessionMessage.
 */
export function payloadSchemaErrors(messageType: string, payload: unknown): ContractError[] {
  if (!isMessageType(messageType)) {
    return [{ path: "message_type", code: "unsupported_message_type", message: `Supported message types: ${MESSAGE_TYPES.join(", ")}.` }];
  }
  const parsed = PAYLOAD_SCHEMAS[messageType].safeParse(payload);
  return parsed.success ? [] : issuesToErrors(parsed.error.issues, "payload");
}

// ------------------------------------------------------------------ signature (HMAC-SHA256)

/**
 * A per-source shared secret, derived from one simulator root secret: HMAC-SHA256(root, "hlos.source-message/1:<source_id>").
 * A real deployment would hold an independent secret per source in its secret store (or, more likely, use mTLS
 * or a VPN; docs §6). The derivation is a simulator convenience: one environment variable configures every
 * simulated source, and each source still signs with its own key.
 */
export function deriveSourceSecret(rootSecret: string, sourceId: string): Buffer {
  return crypto.createHmac("sha256", rootSecret).update(`${CONTRACT_NAME}/${CONTRACT_MAJOR}:${sourceId}`, "utf8").digest();
}

/** hex HMAC-SHA256 over "<timestamp>.<raw body>". */
export function signatureFor(secret: Buffer | string, timestamp: number, rawBody: string): string {
  return crypto.createHmac("sha256", secret).update(`${timestamp}.${rawBody}`, "utf8").digest("hex");
}

/** The X-HLOS-Signature header value. */
export function signatureHeader(secret: Buffer | string, timestamp: number, rawBody: string): string {
  return `t=${timestamp},v1=${signatureFor(secret, timestamp, rawBody)}`;
}

export interface ParsedSignature {
  timestamp: number;
  /** Every v1 value (more than one during a key rotation). */
  v1: string[];
}

export function parseSignatureHeader(value: string | null | undefined): ParsedSignature | null {
  if (!value || value.length > 1024) return null;
  let timestamp: number | null = null;
  const v1: string[] = [];
  for (const part of value.split(",")) {
    const [k, ...rest] = part.trim().split("=");
    const v = rest.join("=").trim();
    if (k === "t" && /^\d{1,12}$/.test(v)) timestamp = Number(v);
    else if (k === "v1" && /^[0-9a-f]{64}$/i.test(v)) v1.push(v.toLowerCase());
  }
  if (timestamp === null || !v1.length) return null;
  return { timestamp, v1 };
}

export type SignatureCheck =
  | { ok: true; timestamp: number }
  | { ok: false; code: "signature_missing" | "signature_malformed" | "signature_expired" | "signature_invalid"; message: string };

/**
 * Verify X-HLOS-Signature for a raw body: the timestamp must be within SIGNATURE_TOLERANCE_SECONDS of `nowMs`
 * (either direction), and one v1 value must equal the HMAC, compared in constant time. The comparison runs
 * even when the timestamp is out of tolerance, so the answer time does not reveal which check failed.
 */
export function verifySignature(header: string | null | undefined, rawBody: string, secret: Buffer | string, nowMs: number): SignatureCheck {
  if (!header) return { ok: false, code: "signature_missing", message: `The ${SIGNATURE_HEADER} header is required.` };
  const parsed = parseSignatureHeader(header);
  if (!parsed) return { ok: false, code: "signature_malformed", message: `The ${SIGNATURE_HEADER} header must be t=<unix seconds>,v1=<64 hex>.` };
  const expected = Buffer.from(signatureFor(secret, parsed.timestamp, rawBody), "hex");
  let match = false;
  for (const candidate of parsed.v1) {
    const given = Buffer.from(candidate, "hex");
    if (given.length === expected.length && crypto.timingSafeEqual(given, expected)) match = true;
  }
  const skew = Math.abs(Math.floor(nowMs / 1000) - parsed.timestamp);
  if (skew > SIGNATURE_TOLERANCE_SECONDS) {
    return { ok: false, code: "signature_expired", message: `The signature timestamp is more than ${SIGNATURE_TOLERANCE_SECONDS} seconds from this server's clock.` };
  }
  if (!match) return { ok: false, code: "signature_invalid", message: "The signature does not match the body." };
  return { ok: true, timestamp: parsed.timestamp };
}

// ------------------------------------------------------------------ replies

/** ACK status (HTTP 200). */
export type AckStatus = "accepted" | "duplicate" | "stale" | "conflict_review";

export interface AckBody {
  status: AckStatus;
  /** The stored message's id (integration_event.id): the same for every re-delivery of one message id. */
  receipt_id: string;
  /** Local receipt time of THIS delivery (the lab's clock). */
  received_at: string;
  message_id: string;
  /** The importer's outcome: applied | duplicate_ignored | stale_ignored. */
  outcome: string;
  /** A person has a task because of this message (a review, a re-check, a hold to release). */
  review_required: boolean;
  correlation_id: string;
}

/** NAK and every other refusal. */
export interface NakBody {
  status: "rejected" | "unavailable" | "failed";
  errors: ContractError[];
  /** Present when the message was kept in the failure queue (400 rejected, 500 failed). */
  receipt_id?: string;
  message_id?: string;
  received_at?: string;
  correlation_id?: string;
  /** 503 / 500: when to try again. */
  retry_after_seconds?: number;
}

/** Build an envelope (simulator, pump). */
export function makeEnvelope(e: {
  sourceId: string;
  messageId: string;
  messageType: string;
  sentAt: string;
  payload: unknown;
  correlationId?: string | null;
  contractVersion?: string;
}): SourceEnvelope {
  return {
    contract: CONTRACT_NAME,
    contract_version: e.contractVersion ?? CONTRACT_VERSION,
    source_id: e.sourceId,
    message_id: e.messageId,
    message_type: e.messageType,
    sent_at: e.sentAt,
    ...(e.correlationId ? { correlation_id: e.correlationId } : {}),
    payload: e.payload as Record<string, unknown>,
  };
}
