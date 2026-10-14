import type { Ctx, Actor } from "../core/context";
import type { Role } from "@/lib/roles";
import { DomainError } from "../core/errors";
import { audit } from "../core/audit";
import { fmtTime } from "@/lib/time";
import {
  getClarification,
  parseEvidence,
  recordAck,
  recordAnswer,
  subjectContext,
  type ClarificationRow,
} from "../domain/clarification";

/**
 * SIMULATED office responder (demo control only).
 *
 * Produces a plausible, clearly labeled "Simulated office reply". It never
 * contacts anyone. The reply is recorded as an ANSWER only: it does not
 * review or resolve the clarification and it does not release any hold.
 *
 * Storyline (docs/dev/command-contract.md, decision 3): for the hero
 * clarification (ORD-77121 part B laterality) the office confirms the bottle
 * is correct (LEFT dorsal forearm) and amends the order; the amended order
 * ORD-77121 v2 is placed in the simulated source outbox, available one minute
 * later, for the integration slice to import.
 */

export const SIMULATED_REPLY_PREFIX = "Simulated office reply:";
export const HERO_ORDER = "ORD-77121";
export const HERO_PART = "B";
export const HERO_SOURCE_ID = "src_ema";

// Stored as readable text in audit_event.actor_role (not a staff role); history views print it verbatim.
const SIM_OFFICE_ROLE = "Simulated office (demo)" as unknown as Role;

function officeActor(name: string): Actor {
  return { id: "sim_office", name: `${name} (simulated office)`, role: SIM_OFFICE_ROLE };
}

function firstEvidence(clr: ClarificationRow) {
  return parseEvidence(clr.evidence)[0] ?? null;
}

function cleanValue(v: string | null | undefined): string {
  return (v ?? "").replace(/[[\]{}<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 60);
}

/** Generic, plausible answer by category. Always prefixed so it can never pass as a real reply. */
export function genericAnswer(clr: ClarificationRow): string {
  const ev = firstEvidence(clr);
  const ordered = cleanValue(ev?.order_value);
  const orderPhrase = ordered && !/^\(?not stated\)?$/i.test(ordered) ? ` (${ordered})` : "";
  switch (clr.category) {
    case "laterality":
      return `${SIMULATED_REPLY_PREFIX} The side on the order${orderPhrase} is correct. The container label was abbreviated.`;
    case "site":
      return `${SIMULATED_REPLY_PREFIX} The site on the order${orderPhrase} is correct. No change to the order.`;
    case "biopsy_method":
      return `${SIMULATED_REPLY_PREFIX} The biopsy method on the order${orderPhrase} is correct.`;
    case "orientation_marking":
      return `${SIMULATED_REPLY_PREFIX} The suture marks 12 o'clock. No ink was applied at the office.`;
    case "identity_conflict":
      return `${SIMULATED_REPLY_PREFIX} We checked the chart: the container and the order belong to the same patient. The container label had a transcription error.`;
    case "missing_container":
      return `${SIMULATED_REPLY_PREFIX} Only one container was collected for this part. The order quantity was entered in error.`;
    case "related_orders":
      return `${SIMULATED_REPLY_PREFIX} Both specimens were collected at the same visit. Please keep each part with its own order.`;
    default:
      return `${SIMULATED_REPLY_PREFIX} We reviewed the question and the order is correct as submitted.`;
  }
}

function isHero(ctx: Ctx, clr: ClarificationRow): boolean {
  if (clr.category !== "laterality" && clr.category !== "site") return false;
  const info = subjectContext(ctx.db, clr);
  return info.orderRef === HERO_ORDER && (info.partDesignation ?? HERO_PART) === HERO_PART;
}

export const HERO_ANSWER =
  `${SIMULATED_REPLY_PREFIX} The container is correct. Part B was taken from the LEFT dorsal forearm. ` +
  `The order was entered with the wrong side; we are amending ${HERO_ORDER} to "Left dorsal forearm" now.`;

/**
 * Put ORD-77121 v2 (laterality left, site "Left dorsal forearm") into the
 * simulated source outbox, available 1 minute after `ctx.now`. Idempotent: the
 * message id is fixed, and an already queued or already imported message is
 * not queued again. The payload is a copy of the latest stored source payload
 * (same shape as seed orderPayload()) with only the amended fields changed.
 */
export function enqueueHeroAmendment(ctx: Ctx, clr: ClarificationRow): { messageId: string; availableAt: string; queued: boolean; duplicate: boolean } {
  const { db } = ctx;
  const order = db.prepare("SELECT id, source_order_id, source_version FROM source_order WHERE id = ?").get(clr.source_order_id) as
    | { id: string; source_order_id: string; source_version: number }
    | undefined;
  if (!order) throw new DomainError("NOT_FOUND", `Source order for ${clr.display_id} was not found`);
  const latest = db
    .prepare("SELECT payload, source_version FROM source_order_version WHERE source_order_id = ? ORDER BY source_version DESC LIMIT 1")
    .get(order.id) as { payload: string; source_version: number } | undefined;
  if (!latest) throw new DomainError("NOT_FOUND", `No stored source version for ${order.source_order_id}`);

  // Only one amendment for the storyline: v2 of ORD-77121.
  const messageId = `${order.source_order_id}#v2`;
  const already = db.prepare("SELECT available_at FROM sim_source_outbox WHERE source_id = ? AND message_id = ?").get(HERO_SOURCE_ID, messageId) as
    | { available_at: string }
    | undefined;
  if (already) return { messageId, availableAt: already.available_at, queued: false, duplicate: true };
  const imported = db.prepare("SELECT received_at FROM integration_event WHERE source_id = ? AND message_id = ?").get(HERO_SOURCE_ID, messageId) as
    | { received_at: string }
    | undefined;
  if (imported || latest.source_version >= 2) return { messageId, availableAt: imported?.received_at ?? ctx.now, queued: false, duplicate: true };

  const payload = JSON.parse(latest.payload) as {
    version: number;
    updated_at: string;
    specimens: { designation: string; site: string; laterality: string | null }[];
    amendment_note?: string;
  };
  payload.version = 2;
  payload.updated_at = ctx.now;
  payload.specimens = payload.specimens.map((s) => (s.designation === HERO_PART ? { ...s, laterality: "left", site: "Left dorsal forearm" } : s));
  payload.amendment_note = `Laterality corrected by office: part ${HERO_PART} is LEFT dorsal forearm (container was correct). Amended after lab clarification ${clr.display_id}.`;
  const availableAt = new Date(Date.parse(ctx.now) + 60_000).toISOString();
  db.prepare(
    "INSERT INTO sim_source_outbox (id, source_id, message_id, message_type, available_at, payload, delivered_at) VALUES (?, ?, ?, 'order.upsert', ?, ?, NULL)",
  ).run(`ob_${order.source_order_id.toLowerCase().replace(/[^a-z0-9]+/g, "_")}_v2`, HERO_SOURCE_ID, messageId, availableAt, JSON.stringify(payload));
  audit({ ...ctx, origin: "simulator", actor: { id: "sim_source", name: "Simulated source (EMA-SIM)", role: "Simulated source" as unknown as Role } }, {
    action: "simulator.source_amendment_queued",
    entityType: "source_order",
    entityId: order.id,
    accessionId: clr.accession_id,
    intakeItemId: clr.intake_item_id,
    summary: `Simulated source will send amended ${order.source_order_id} v2 (part ${HERO_PART}: Left dorsal forearm) at about ${fmtTime(availableAt)} ET. Nothing changes in the lab until it is imported and reviewed.`,
  });
  return { messageId, availableAt, queued: true, duplicate: false };
}

export interface SimulatedAnswerResult {
  clarificationId: string;
  displayId: string;
  state: string;
  version: number;
  duplicate: boolean;
  answerText: string;
  amendedOrder: { messageId: string; availableAt: string; queued: boolean; duplicate: boolean } | null;
  message: string;
}

export function simulateOfficeAnswer(ctx: Ctx, clarificationId: string): SimulatedAnswerResult {
  const clr = getClarification(ctx.db, clarificationId);
  const hero = isHero(ctx, clr);
  if (["answered", "reviewed", "resolved"].includes(clr.state)) {
    const amended = hero ? enqueueHeroAmendment({ ...ctx, origin: "simulator" }, clr) : null;
    return {
      clarificationId: clr.id, displayId: clr.display_id, state: clr.state, version: clr.version, duplicate: true,
      answerText: clr.answer_text ?? "", amendedOrder: amended,
      message: `${clr.display_id} already has an office answer. No second simulated reply was created.`,
    };
  }
  if (clr.state === "canceled") throw new DomainError("BLOCKED", `${clr.display_id} is canceled. The simulated office does not answer canceled questions.`);
  if (clr.state === "drafted") throw new DomainError("BLOCKED", `${clr.display_id} has not been sent yet. Send it (simulated) before simulating an office answer.`);
  if (clr.state === "delivery_failed") {
    throw new DomainError("BLOCKED", `The simulated office never received ${clr.display_id} (delivery failed). Send a reminder, escalate, or record a phone answer instead.`);
  }

  const contact = clr.contact_id
    ? (ctx.db.prepare("SELECT display_name, channel FROM office_contact WHERE id = ?").get(clr.contact_id) as { display_name: string; channel: string } | undefined)
    : undefined;
  const responder = contact?.display_name ?? "Office staff";
  const simCtx: Ctx = { ...ctx, origin: "simulator", actor: officeActor(responder) };

  // Demo-control trail: who pressed the button.
  audit({ ...ctx, origin: "demo" }, {
    action: "demo.simulate_office_answer",
    entityType: "clarification",
    entityId: clr.id,
    accessionId: clr.accession_id,
    intakeItemId: clr.intake_item_id,
    summary: `${ctx.actor.name} asked the office simulator to answer ${clr.display_id} (demo control).`,
  });

  if (clr.state !== "acknowledged") recordAck(simCtx, { clarificationId: clr.id, channel: contact?.channel ?? "simulated_ema_message" });
  const answerText = hero ? HERO_ANSWER : genericAnswer(clr);
  const res = recordAnswer(simCtx, {
    clarificationId: clr.id,
    answerText,
    answeredBy: `${responder} (simulated)`,
    channel: contact?.channel === "simulated_portal" ? "simulated_portal" : "simulated_ema_message",
  });
  const amended = hero ? enqueueHeroAmendment(simCtx, getClarification(ctx.db, clr.id)) : null;
  return {
    clarificationId: res.clarificationId,
    displayId: res.displayId,
    state: res.state,
    version: res.version,
    duplicate: false,
    answerText,
    amendedOrder: amended,
    message: `Simulated office reply recorded for ${res.displayId}. It is not resolved: a lead or supervisor must review it.${amended?.queued ? ` The simulated source will send amended ${HERO_ORDER} v2 in about 1 minute.` : ""}`,
  };
}
