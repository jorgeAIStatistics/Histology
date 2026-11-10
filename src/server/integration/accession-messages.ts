import type { Ctx } from "../core/context";
import type { ImportResult, ReconciliationNote } from "../domain/sourceImport";
import { DomainError } from "../core/errors";
import { audit } from "../core/audit";
import { openTask } from "../core/tasks";
import { fmtTime } from "@/lib/time";
import { checkAccessionMessage, type AccessionMessageType } from "./accession-schemas";
import { errorsSentence } from "./errors";

/**
 * accession.issued and accession.acknowledged (contract "hlos.source-message" 1.0), processed inside
 * importSourceMessage's pipeline (duplicate → failed → applied), so de-duplication, the failure queue,
 * staff retry, receipts and the audit trail are the same as for orders.
 *
 * What they map onto, honestly:
 * - The ONLY way a number is issued in this build is requestAccession → the simulated authoritative
 *   issuer (src/server/sim/authoritative.ts), in-process. An inbound message never issues, adopts,
 *   renumbers or relinks an accession (INV-6; the accession_number_immutable trigger backs it).
 * - accession.issued: the source's statement of the number it issued for a lab request, compared with
 *   the local record. Same number and namespace: recorded as a confirmation. Anything else (another
 *   number, or the request is still waiting here): recorded, NOT applied, and one source_conflict review
 *   task is opened for the accessioning lead.
 * - accession.acknowledged: the source confirms it holds the lab's request (and, once issued, which
 *   number). Recorded as a provenance event; it changes no clinical state. The reconciliation read model
 *   (src/server/integration/reconciliation.ts) derives "waiting for the source's acknowledgment" from
 *   these events. A number that differs from the local one opens the same review.
 */

interface SourceRow {
  id: string;
  name: string;
  tenant_id: string | null;
}

export interface AccessionMessageInput {
  eventId: string;
  messageId: string;
  messageType: string;
  payloadText: string;
  isRetry: boolean;
  existing?: { id: string };
  /** The source's claimed event time (envelope sent_at), when the message came through the contract. */
  sentAt?: string | null;
}

function firstActiveStaff(ctx: Ctx, role: string): string | null {
  const row = ctx.db.prepare("SELECT id FROM staff WHERE role = ? AND active = 1 ORDER BY id").get(role) as { id: string } | undefined;
  return row?.id ?? null;
}

export function processAccessionMessage(ctx: Ctx, source: SourceRow, m: AccessionMessageInput): ImportResult {
  const db = ctx.db;
  const type = m.messageType as AccessionMessageType;
  let raw: unknown;
  try {
    raw = JSON.parse(m.payloadText);
  } catch {
    throw new DomainError("VALIDATION", "Payload is not valid JSON. Stored verbatim; nothing was applied.");
  }
  const checked = checkAccessionMessage(db, source, type, raw);
  if (!checked.ok) {
    throw new DomainError("VALIDATION", `Payload refused (${errorsSentence(checked.errors)}). Stored verbatim; nothing was applied.`);
  }
  const { request, accession, claimed } = checked;
  const tenant = source.tenant_id ?? source.id;
  const entityKey = `${tenant}:accession_request:${request.display_id}`;
  const eventTime = m.sentAt ?? checked.payloadTime;
  const sourceRef = `${source.id}:${m.messageId}:v?`;
  const label = type === "accession.issued" ? "issue notice" : "acknowledgment";

  // What the source claims against what this laboratory recorded. Never applied: compared only.
  const differences: string[] = [];
  if (claimed) {
    if (!accession) {
      differences.push(
        request.status === "submitted"
          ? `the source names ${claimed.accessionNumber} but request ${request.display_id} is still waiting here (no number was issued locally; an inbound number is never adopted)`
          : `the source names ${claimed.accessionNumber} but request ${request.display_id} has no accession here (status ${request.status})`,
      );
    } else {
      if (accession.accession_number !== claimed.accessionNumber) differences.push(`number: issued here ${accession.accession_number}, source says ${claimed.accessionNumber}`);
      if (accession.namespace !== claimed.namespace) differences.push(`namespace: issued here ${accession.namespace}, source says ${claimed.namespace}`);
      if (claimed.sourceCaseId && accession.source_case_id && accession.source_case_id !== claimed.sourceCaseId) {
        differences.push(`source case id: recorded ${accession.source_case_id}, source says ${claimed.sourceCaseId}`);
      }
    }
  }

  const notes: ReconciliationNote[] = [];
  let detail: string;
  if (differences.length) {
    const lead = firstActiveStaff(ctx, "accessioning_lead") ?? firstActiveStaff(ctx, "supervisor");
    const taskId = openTask(ctx, {
      kind: "source_conflict",
      entityType: "integration_event",
      entityId: m.eventId,
      title: `${source.name.replace(/\s*\(.*\)\s*$/, "")} ${label} for ${request.display_id} does not match this laboratory's record — review (nothing was changed)`,
      ownerId: lead,
      ownerRole: "accessioning_lead",
      priority: "urgent",
      accessionId: accession?.id ?? null,
      detail: `Message ${m.messageId}: ${differences.join("; ")}. The accession on file is never renumbered or replaced by a message. Confirm with the source which record is right; a post-accession discrepancy goes through a correction review.`,
    });
    notes.push({ kind: "accession_mismatch_review", summary: `${request.display_id}: ${differences.join("; ")}. Review task opened; nothing changed.`, ref: taskId });
    detail = `${type} for ${request.display_id} recorded but NOT applied: ${differences.join("; ")}. Review task opened; the local accession is unchanged.`;
    audit(ctx, {
      action: "integration.accession_mismatch_review",
      entityType: "accession_request",
      entityId: request.id,
      accessionId: accession?.id ?? null,
      sourceRef,
      summary: `${source.name}: ${label} for ${request.display_id} differs from the local record — sent for review, nothing changed`,
      before: { requestStatus: request.status, accessionNumber: accession?.accession_number ?? null, namespace: accession?.namespace ?? null },
      after: {
        requestStatus: request.status,
        accessionNumber: accession?.accession_number ?? null,
        claimedAccessionNumber: claimed?.accessionNumber ?? null,
        claimedNamespace: claimed?.namespace ?? null,
        reviewTaskId: taskId,
        sourceId: source.id,
        messageId: m.messageId,
        messageType: type,
        eventId: m.eventId,
      },
    });
  } else if (type === "accession.issued") {
    notes.push({ kind: "accession_confirmed", summary: `${request.display_id} → ${accession!.accession_number}: matches the accession issued here.`, ref: request.id });
    detail = `Source confirms ${request.display_id} → ${accession!.accession_number} (${accession!.namespace}); matches the local record. Nothing changed.`;
    audit(ctx, {
      action: "integration.accession_issue_confirmed",
      entityType: "accession_request",
      entityId: request.id,
      accessionId: accession!.id,
      sourceRef,
      summary: `${source.name}: issue of ${accession!.accession_number} for ${request.display_id} confirmed by the source (matches the local record)`,
      after: { accessionNumber: accession!.accession_number, namespace: accession!.namespace, sourceId: source.id, messageId: m.messageId, messageType: type, eventId: m.eventId },
    });
  } else {
    const what = claimed ? `${request.display_id} → ${claimed.accessionNumber}` : `${request.display_id} (no number yet)`;
    notes.push({ kind: "accession_acknowledged", summary: `Source acknowledged ${what}.`, ref: request.id });
    detail = `Source acknowledged ${what}${claimed ? "; matches the local record" : `; the request is ${request.status === "submitted" ? "still waiting for a number" : request.status} here`}. Nothing changed.`;
    audit(ctx, {
      action: "integration.accession_acknowledged",
      entityType: "accession_request",
      entityId: request.id,
      accessionId: accession?.id ?? null,
      sourceRef,
      summary: `${source.name}: acknowledgment of ${what} recorded (sent ${fmtTime(eventTime)} ET)`,
      after: { requestStatus: request.status, accessionNumber: claimed?.accessionNumber ?? null, sourceId: source.id, messageId: m.messageId, messageType: type, eventId: m.eventId },
    });
  }

  // The message itself: provenance (event time from the source, receipt time local). Same row shape as orders.
  if (m.existing) {
    db.prepare(`UPDATE integration_event SET outcome = 'applied', detail = ?, entity_key = ?, source_version = NULL, source_updated_at = ?, receipt_count = receipt_count + 1 WHERE id = ?`).run(
      `${detail} (processed on retry at ${fmtTime(ctx.now)} ET)`,
      entityKey,
      eventTime,
      m.eventId,
    );
  } else {
    db.prepare(
      `INSERT INTO integration_event (id, source_id, message_id, message_type, entity_key, source_version, source_updated_at, received_at, outcome, detail, payload, receipt_count)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?, 'applied', ?, ?, 1)`,
    ).run(m.eventId, source.id, m.messageId, type, entityKey, eventTime, ctx.now, detail, m.payloadText);
  }
  return { outcome: "applied", eventId: m.eventId, messageId: m.messageId, detail, reconciliation: notes };
}
