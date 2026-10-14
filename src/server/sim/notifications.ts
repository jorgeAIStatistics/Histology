import type { DB } from "../db/db";
import type { Ctx } from "../core/context";
import { newId } from "../core/ids";
import { fmtTime } from "@/lib/time";

/**
 * SIMULATED office notification connector.
 *
 * Nothing here contacts a real office. Every outbound message is written to
 * the local `clarification_message` log, labeled "[SIMULATED — not sent]", and
 * a deterministic rule decides the delivery outcome so the demo is
 * reproducible:
 *
 *   1. notification connector offline (integration_source src_notify)  → delivery_failed
 *   2. contact out_until > now and no available backup                  → delivery_failed
 *   3. no contact on file, simulated_phone channel, or unverified contact → delivery_unknown
 *   4. simulated_ema_message / simulated_portal                          → delivered
 *
 * Bodies are GENERIC: they carry only the lab name and the clarification id and
 * point the recipient to the secure case view. No patient identifiers.
 */

export const LAB_NAME = "Lumen Bay Dermatopathology";
export const SIMULATED_TAG = "[SIMULATED — not sent]";
export const NOTIFY_SOURCE_ID = "src_notify";

export type DeliveryOutcome = "delivered" | "delivery_unknown" | "delivery_failed";
export type MessageKind = "initial" | "reminder" | "escalation";

export interface ContactRow {
  id: string;
  office_id: string;
  display_name: string;
  contact_role: string;
  channel: string;
  is_primary: number;
  is_escalation: number;
  covers_categories: string;
  out_until: string | null;
  backup_contact_id: string | null;
}

/** Generic notification text. Contains no patient information by design. */
export function genericBody(kind: MessageKind, displayId: string): string {
  switch (kind) {
    case "reminder":
      return `Reminder: ${LAB_NAME} has an open specimen question (${displayId}). Please open the secure case view to respond. ${SIMULATED_TAG}`;
    case "escalation":
      return `${LAB_NAME} has an unanswered specimen question (${displayId}) for your office. Please open the secure case view or ask the responsible staff member to respond. ${SIMULATED_TAG}`;
    default:
      return `${LAB_NAME} has a specimen question (${displayId}). Please open the secure case view to respond. ${SIMULATED_TAG}`;
  }
}

/** Ensure the visible simulation tag is present on any outbound body. */
export function withSimulatedTag(body: string): string {
  const trimmed = body.trim();
  return trimmed.includes(SIMULATED_TAG) ? trimmed : `${trimmed} ${SIMULATED_TAG}`;
}

export function channelLabel(channel: string | null | undefined): string {
  switch (channel) {
    case "simulated_ema_message":
      return "EMA message (simulated)";
    case "simulated_portal":
      return "Office portal (simulated)";
    case "simulated_phone":
      return "Phone call (simulated; no delivery receipt)";
    default:
      return channel ? `${channel} (simulated)` : "Unknown channel";
  }
}

export function isUnverifiedContact(c: Pick<ContactRow, "display_name" | "contact_role">): boolean {
  return /unverified/i.test(c.contact_role) || /not yet on file/i.test(c.display_name);
}

export function connectorStatus(db: DB): string {
  const row = db.prepare("SELECT status FROM integration_source WHERE id = ?").get(NOTIFY_SOURCE_ID) as { status: string } | undefined;
  return row?.status ?? "connected";
}

/** Deterministic simulated delivery outcome for one message to one contact. */
export function simulateDeliveryOutcome(
  db: DB,
  contact: ContactRow | null,
  now: string,
): { outcome: DeliveryOutcome; reason: string } {
  if (connectorStatus(db) === "offline") {
    return { outcome: "delivery_failed", reason: "Notification connector unavailable (simulated outage). The message was not handed off." };
  }
  if (!contact) {
    return { outcome: "delivery_unknown", reason: "No office contact on file. The simulated connector cannot confirm delivery." };
  }
  if (contact.out_until && Date.parse(contact.out_until) > Date.parse(now)) {
    const backup = contact.backup_contact_id
      ? (db.prepare("SELECT out_until FROM office_contact WHERE id = ?").get(contact.backup_contact_id) as { out_until: string | null } | undefined)
      : undefined;
    const backupAvailable = backup && !(backup.out_until && Date.parse(backup.out_until) > Date.parse(now));
    if (!backupAvailable) {
      return {
        outcome: "delivery_failed",
        reason: `${contact.display_name} is out until ${fmtTime(contact.out_until)} ET and no available backup is on file (simulated bounce).`,
      };
    }
  }
  if (contact.channel === "simulated_phone" || isUnverifiedContact(contact)) {
    return {
      outcome: "delivery_unknown",
      reason: "No delivery confirmation from the simulated notification connector (phone channel or unverified contact).",
    };
  }
  if (contact.channel === "simulated_ema_message" || contact.channel === "simulated_portal") {
    return { outcome: "delivered", reason: `Delivered via ${channelLabel(contact.channel)}.` };
  }
  return { outcome: "delivery_unknown", reason: `Channel ${contact.channel} does not report delivery (simulated).` };
}

export interface SimulatedSendInput {
  clarificationId: string;
  kind: MessageKind;
  contact: ContactRow | null;
  body: string;
  idempotencyKey: string;
}

export interface SimulatedSendResult {
  messageId: string;
  outcome: DeliveryOutcome;
  reason: string;
  body: string;
  duplicate: boolean;
  createdAt: string;
}

const MESSAGE_STATE: Record<DeliveryOutcome, string> = {
  delivered: "delivered",
  delivery_unknown: "delivery_unknown",
  delivery_failed: "failed",
};

export function messageStateToOutcome(state: string): DeliveryOutcome | null {
  if (state === "delivered") return "delivered";
  if (state === "delivery_unknown") return "delivery_unknown";
  if (state === "failed") return "delivery_failed";
  return null;
}

/**
 * Write one simulated outbound message. Idempotent on `idempotencyKey`: a
 * repeated send returns the original message and outcome (double clicks and
 * retries never produce a second message).
 */
export function sendSimulatedNotification(ctx: Ctx, input: SimulatedSendInput): SimulatedSendResult {
  const existing = ctx.db
    .prepare("SELECT id, body, delivery_state, created_at FROM clarification_message WHERE idempotency_key = ?")
    .get(input.idempotencyKey) as { id: string; body: string; delivery_state: string; created_at: string } | undefined;
  if (existing) {
    return {
      messageId: existing.id,
      outcome: messageStateToOutcome(existing.delivery_state) ?? "delivery_unknown",
      reason: "Already sent with this request. No second message was created.",
      body: existing.body,
      duplicate: true,
      createdAt: existing.created_at,
    };
  }
  const body = withSimulatedTag(input.body);
  const { outcome, reason } = simulateDeliveryOutcome(ctx.db, input.contact, ctx.now);
  const id = newId(ctx.db, "cmsg");
  ctx.db
    .prepare(
      `INSERT INTO clarification_message (id, clarification_id, direction, kind, channel, recipient_contact_id, body, delivery_state,
         is_simulated, idempotency_key, created_at, created_by)
       VALUES (?, ?, 'outbound', ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
    )
    .run(
      id, input.clarificationId, input.kind, input.contact?.channel ?? "simulated_unknown", input.contact?.id ?? null, body,
      MESSAGE_STATE[outcome], input.idempotencyKey, ctx.now, ctx.actor.id,
    );
  // Connector heartbeat (simulated): records the attempt, and success only when handed off.
  if (outcome === "delivery_failed" && connectorStatus(ctx.db) === "offline") {
    ctx.db.prepare("UPDATE integration_source SET last_attempt_at = ?, last_error = ? WHERE id = ?").run(ctx.now, reason, NOTIFY_SOURCE_ID);
  } else {
    ctx.db.prepare("UPDATE integration_source SET last_attempt_at = ?, last_success_at = ? WHERE id = ?").run(ctx.now, ctx.now, NOTIFY_SOURCE_ID);
  }
  return { messageId: id, outcome, reason, body, duplicate: false, createdAt: ctx.now };
}

/** Record an inbound simulated message (acknowledgement, answer, delivery receipt). */
export function recordInboundMessage(
  ctx: Ctx,
  input: { clarificationId: string; kind: "answer" | "acknowledgement" | "delivery_receipt"; channel: string; contactId: string | null; body: string; idempotencyKey: string; deliveryState?: string },
): { messageId: string; duplicate: boolean } {
  const existing = ctx.db.prepare("SELECT id FROM clarification_message WHERE idempotency_key = ?").get(input.idempotencyKey) as { id: string } | undefined;
  if (existing) return { messageId: existing.id, duplicate: true };
  const id = newId(ctx.db, "cmsg");
  ctx.db
    .prepare(
      `INSERT INTO clarification_message (id, clarification_id, direction, kind, channel, recipient_contact_id, body, delivery_state,
         is_simulated, idempotency_key, created_at, created_by)
       VALUES (?, ?, 'inbound', ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
    )
    .run(id, input.clarificationId, input.kind, input.channel, input.contactId, input.body, input.deliveryState ?? "received", input.idempotencyKey, ctx.now, ctx.actor.id);
  return { messageId: id, duplicate: false };
}
