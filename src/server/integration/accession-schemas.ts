import { z } from "zod";
import type { DB } from "../db/db";
import { ACCESSION_SOURCE_ID } from "../sim/authoritative";
import { issuesToErrors, type ContractError } from "./errors";

/**
 * Payloads of the two accession message types of contract "hlos.source-message" 1.0
 * (docs/release/integration-contract.md §4), and the one check both the importer
 * (src/server/integration/accession-messages.ts, reached through importSourceMessage)
 * and the contract's NAK builder (src/server/integration/inbound.ts) run. One function,
 * so the failure queue and the NAK can never disagree.
 *
 * Kept free of the order importer's imports on purpose: src/server/domain/sourceImport.ts
 * dispatches to the accession processor, so this module must not import it back.
 */

export const ACCESSION_MESSAGE_TYPES = ["accession.issued", "accession.acknowledged"] as const;
export type AccessionMessageType = (typeof ACCESSION_MESSAGE_TYPES)[number];

export function isAccessionMessageType(t: string): t is AccessionMessageType {
  return (ACCESSION_MESSAGE_TYPES as readonly string[]).includes(t);
}

/** ISO 8601 date-time WITH a zone (Z or ±hh:mm). A local time without a zone is ambiguous across systems. */
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;
export const isoDateTime = z
  .string()
  .trim()
  .refine((s) => ISO_DATE_TIME.test(s) && !Number.isNaN(Date.parse(s)), "Must be an ISO 8601 date-time with a zone (Z or ±hh:mm).");

/** The lab's accession request id as the lab sent it to the source (placer reference), e.g. AR-0001. */
const requestId = z.string().trim().regex(/^AR-\d{4,8}$/, "Must be the lab's accession request id (AR- and 4 to 8 digits).");
const accessionNumber = z.string().trim().regex(/^D\d{2}-\d{5}$/, "Must be an accession number such as D26-04818.");
const namespace = z.string().trim().min(1).max(60);
const sourceCaseId = z.string().trim().min(1).max(64);

/** The source states the number it issued for a lab request. Compared with the local record; never issues or renumbers. */
export const AccessionIssuedSchema = z.object({
  request_id: requestId,
  accession_number: accessionNumber,
  namespace,
  source_case_id: sourceCaseId.nullable().optional(),
  issued_at: isoDateTime,
});
export type AccessionIssuedPayload = z.infer<typeof AccessionIssuedSchema>;

/** The source acknowledges a lab request (and, once issued, the number it holds for it). Recorded; changes no clinical state. */
export const AccessionAcknowledgedSchema = z
  .object({
    request_id: requestId,
    accession_number: accessionNumber.nullable().optional(),
    namespace: namespace.nullable().optional(),
    source_case_id: sourceCaseId.nullable().optional(),
    acknowledged_at: isoDateTime,
  })
  .superRefine((v, ctx) => {
    if (v.accession_number && !v.namespace) {
      ctx.addIssue({ code: "custom", path: ["namespace"], message: "Required when accession_number is given (a number is only unique within its namespace)." });
    }
  });
export type AccessionAcknowledgedPayload = z.infer<typeof AccessionAcknowledgedSchema>;

export const ACCESSION_PAYLOAD_SCHEMAS = {
  "accession.issued": AccessionIssuedSchema,
  "accession.acknowledged": AccessionAcknowledgedSchema,
} as const;

export interface AccessionRequestRow {
  id: string;
  display_id: string;
  status: string;
  requested_at: string;
  accession_id: string | null;
}

export interface AccessionRow {
  id: string;
  accession_number: string;
  namespace: string;
  source_case_id: string | null;
}

export type AccessionCheck =
  | {
      ok: true;
      type: AccessionMessageType;
      value: AccessionIssuedPayload | AccessionAcknowledgedPayload;
      request: AccessionRequestRow;
      accession: AccessionRow | null;
      /** The source's claim about the number, if the message carries one. */
      claimed: { accessionNumber: string; namespace: string; sourceCaseId: string | null } | null;
      /** The time the payload says the event happened (issued_at / acknowledged_at). */
      payloadTime: string;
    }
  | { ok: false; errors: ContractError[] };

/**
 * Validate an accession message against the payload schema, the issuing authority and the lab's own
 * records. Reads only. A source that does not issue accession numbers, or a request id the lab never
 * sent, is refused as data (`not_authoritative`, `unknown_reference`): the message is kept in the
 * failure queue and applies nothing.
 */
export function checkAccessionMessage(db: DB, source: { id: string; name: string }, type: AccessionMessageType, raw: unknown): AccessionCheck {
  if (source.id !== ACCESSION_SOURCE_ID) {
    return {
      ok: false,
      errors: [{ path: "source_id", code: "not_authoritative", message: "This source does not issue accession numbers, so it cannot send accession messages." }],
    };
  }
  const schema = ACCESSION_PAYLOAD_SCHEMAS[type];
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return { ok: false, errors: issuesToErrors(parsed.error.issues, "payload") };
  const value = parsed.data;
  const request = db
    .prepare("SELECT id, display_id, status, requested_at, accession_id FROM accession_request WHERE display_id = ?")
    .get(value.request_id) as AccessionRequestRow | undefined;
  if (!request) {
    return {
      ok: false,
      errors: [{ path: "payload.request_id", code: "unknown_reference", message: "No accession request with this id was sent by this laboratory." }],
    };
  }
  const accession = request.accession_id
    ? ((db.prepare("SELECT id, accession_number, namespace, source_case_id FROM accession WHERE id = ?").get(request.accession_id) as AccessionRow | undefined) ?? null)
    : null;
  const claimed = value.accession_number
    ? { accessionNumber: value.accession_number, namespace: value.namespace ?? "", sourceCaseId: value.source_case_id ?? null }
    : null;
  const payloadTime = "issued_at" in value ? value.issued_at : (value as AccessionAcknowledgedPayload).acknowledged_at;
  return { ok: true, type, value, request, accession, claimed, payloadTime };
}
