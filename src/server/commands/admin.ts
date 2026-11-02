// Commands for the S6 slice: simulated source integration, demo controls,
// routing rule versions, coverage and the office contact directory.
// Each defineCommand() call registers itself.
import { z } from "zod";
import { defineCommand } from "./registry";
import type { Ctx } from "../core/context";
import { DomainError } from "../core/errors";
import { audit } from "../core/audit";
import { newId } from "../core/ids";
import { readClock, setClock } from "../core/clock";
import { getSetting, setSetting } from "../core/settings";
import { importSourceMessage, SUPPORTED_MESSAGE_TYPES } from "../domain/sourceImport";
import { addCoverage, approveRuleSet, discardDraft, draftRuleSet, retireCoverage } from "../domain/routingRules";
import { clearOffline, DEGRADED_DELAY_MINUTES, markOffline, pumpSourcesDetailed, SOURCE_ADAPTERS } from "../sim/pump";
import { fmtTime } from "@/lib/time";

const isoString = z
  .string()
  .trim()
  .min(1)
  .refine((s) => !Number.isNaN(Date.parse(s)), "Must be a date-time (ISO 8601)");
const reasonString = z.string().trim().min(3, "Give a reason (at least 3 characters)").max(500);

interface IntegrationSourceRow {
  id: string;
  name: string;
  adapter: string;
  tenant_id: string | null;
  status: string;
  last_success_at: string | null;
}

function sourceAdapterRow(ctx: Ctx, sourceId: string): IntegrationSourceRow {
  const row = ctx.db.prepare("SELECT id, name, adapter, tenant_id, status, last_success_at FROM integration_source WHERE id = ?").get(sourceId) as
    | IntegrationSourceRow
    | undefined;
  if (!row) throw new DomainError("NOT_FOUND", `Integration source ${sourceId} was not found`);
  if (!(SOURCE_ADAPTERS as readonly string[]).includes(row.adapter)) {
    throw new DomainError("VALIDATION", `${row.name} is not a source-system adapter. Use the printer or assistant controls for other connectors.`);
  }
  return row;
}

function defaultSourceId(ctx: Ctx, sourceId?: string): string {
  return sourceAdapterRow(ctx, sourceId ?? "src_ema").id;
}

// ------------------------------------------------------------------ source integration (SIMULATED)

defineCommand({
  name: "integration.setSourceStatus",
  description: "Demo control: simulate a source-system outage (offline), a slow link (degraded) or restore it (connected).",
  permission: null,
  audience: "presenter",
  input: z.object({ sourceId: z.string().min(1), status: z.enum(["connected", "offline", "degraded"]) }),
  run(ctx, input) {
    const src = sourceAdapterRow(ctx, input.sourceId);
    if (src.status === input.status) return { sourceId: src.id, status: src.status, delivered: 0, unchanged: true };
    if (input.status === "offline") {
      ctx.db.prepare("UPDATE integration_source SET status = 'offline', last_attempt_at = ?, last_error = 'Simulated outage' WHERE id = ?").run(ctx.now, src.id);
      markOffline(ctx.db, src.id, ctx.now);
    } else {
      ctx.db.prepare("UPDATE integration_source SET status = ?, last_error = NULL WHERE id = ?").run(input.status, src.id);
      clearOffline(ctx.db, src.id, ctx.now);
    }
    audit(ctx, {
      action: "integration.source_status_set",
      entityType: "integration_source",
      entityId: src.id,
      summary:
        input.status === "offline"
          ? `Demo control: ${src.name} set OFFLINE (simulated outage). Source-derived views now show last confirmed data as stale.`
          : input.status === "degraded"
            ? `Demo control: ${src.name} set DEGRADED (simulated ${DEGRADED_DELAY_MINUTES}-minute delivery delay)`
            : `Demo control: ${src.name} restored (connected). Queued messages are delivered once through the idempotent importer.`,
      before: { status: src.status },
      after: { status: input.status },
    });
    // Restoring delivers the backlog right away (same idempotent pipeline as the poll).
    const delivered = input.status === "offline" ? 0 : pumpSourcesDetailed(ctx.db, { sourceId: src.id, via: "sync" }).delivered;
    return { sourceId: src.id, status: input.status, delivered, unchanged: false };
  },
});

defineCommand({
  name: "integration.syncNow",
  description: "Poll the simulated source adapters now and deliver anything due (same pipeline as the background poll).",
  permission: null,
  audience: "presenter",
  input: z.object({ sourceId: z.string().optional() }),
  run(ctx, input) {
    if (input.sourceId) sourceAdapterRow(ctx, input.sourceId);
    const res = pumpSourcesDetailed(ctx.db, { sourceId: input.sourceId, via: "sync" });
    audit(ctx, {
      action: "integration.sync_requested",
      entityType: "integration_source",
      entityId: input.sourceId ?? "all_sources",
      summary: `Sync requested by ${ctx.actor.name}: ${res.delivered} message${res.delivered === 1 ? "" : "s"} delivered${res.sources
        .filter((s) => s.status === "offline")
        .map((s) => `; ${s.name} offline (simulated) — nothing delivered`)
        .join("")}`,
    });
    return {
      delivered: res.delivered,
      sources: res.sources.map((s) => ({ sourceId: s.sourceId, status: s.status, delivered: s.delivered, pending: s.pending, outcomes: s.outcomes })),
    };
  },
});

defineCommand({
  name: "integration.retryEvent",
  description: "Retry a failed inbound message from the failure queue using its stored payload.",
  permission: "integration.manage",
  input: z.object({ eventId: z.string().min(1) }),
  run(ctx, input) {
    const ev = ctx.db.prepare("SELECT * FROM integration_event WHERE id = ?").get(input.eventId) as
      | { id: string; source_id: string; message_id: string; message_type: string; outcome: string; payload: string }
      | undefined;
    if (!ev) throw new DomainError("NOT_FOUND", "Integration event not found");
    if (ev.outcome !== "failed") {
      return { eventId: ev.id, outcome: ev.outcome, retried: false, detail: `Not in the failure queue (outcome: ${ev.outcome.replace(/_/g, " ")}). Nothing was retried.` };
    }
    audit(ctx, { action: "integration.retry_requested", entityType: "integration_event", entityId: ev.id, summary: `Retry of failed message ${ev.message_id} requested by ${ctx.actor.name}` });
    const importCtx: Ctx = { ...ctx, origin: "import" };
    const res = importSourceMessage(importCtx, ev.source_id, { messageId: ev.message_id, messageType: ev.message_type, payload: ev.payload }, { via: "retry" });
    return { eventId: ev.id, outcome: res.outcome, retried: true, detail: res.detail };
  },
});

defineCommand({
  name: "integration.deliverQueuedNow",
  description: "Demo control: make every pending simulated source message available now, then sync (delivers only if the source is connected).",
  permission: null,
  audience: "presenter",
  input: z.object({ sourceId: z.string().optional() }),
  run(ctx, input) {
    const ids = input.sourceId ? [sourceAdapterRow(ctx, input.sourceId).id] : null;
    const res = ctx.db
      .prepare(
        `UPDATE sim_source_outbox SET available_at = ? WHERE delivered_at IS NULL AND available_at > ? ${ids ? "AND source_id = ?" : ""}`,
      )
      .run(ctx.now, ctx.now, ...(ids ?? []));
    audit(ctx, {
      action: "integration.queue_released",
      entityType: "sim_source_outbox",
      entityId: ids?.[0] ?? "all_sources",
      summary: `Demo control: ${res.changes} queued simulated source message${res.changes === 1 ? "" : "s"} made available at ${fmtTime(ctx.now)} ET`,
    });
    const pumped = pumpSourcesDetailed(ctx.db, { sourceId: ids?.[0], via: "sync" });
    const offline = pumped.sources.filter((s) => s.status === "offline");
    const degraded = pumped.sources.filter((s) => s.status === "degraded");
    const waiting = (sourceId: string) =>
      (ctx.db.prepare("SELECT COUNT(*) n FROM sim_source_outbox WHERE source_id = ? AND delivered_at IS NULL AND available_at <= ?").get(sourceId, ctx.now) as { n: number }).n;
    const notes = [
      ...offline.map((s) => `${s.name} is offline (simulated outage): its ${waiting(s.sourceId)} message(s) stay queued and are delivered once after restore.`),
      ...degraded
        .filter((s) => waiting(s.sourceId) > 0)
        .map(
          (s) =>
            `${s.name} has a slow link (simulated): messages are delivered ${DEGRADED_DELAY_MINUTES} minutes after they become available, so ${waiting(s.sourceId)} still wait. End the slow link or advance the clock to deliver them.`,
        ),
    ];
    return {
      madeAvailable: res.changes,
      delivered: pumped.delivered,
      offline: offline.map((s) => s.sourceId),
      degraded: degraded.map((s) => s.sourceId),
      notes,
      outcomes: pumped.sources.flatMap((s) => s.outcomes),
    };
  },
});

defineCommand({
  name: "integration.replayDuplicate",
  description: "Demo control: the simulated source re-sends a message it already sent (same message id). Must be ignored as a duplicate.",
  permission: null,
  audience: "presenter",
  input: z.object({ sourceId: z.string().optional(), eventId: z.string().optional() }),
  run(ctx, input) {
    const sourceId = defaultSourceId(ctx, input.sourceId);
    const src = sourceAdapterRow(ctx, sourceId);
    if (src.status === "offline") {
      throw new DomainError("SOURCE_OFFLINE", `${src.name} is offline (simulated outage). Nothing can be received until it is restored.`);
    }
    // Only order messages from the source adapter are replayed (not, e.g., accession.issued events of the accession simulator).
    const types = SUPPORTED_MESSAGE_TYPES.map(() => "?").join(",");
    const ev = (
      input.eventId
        ? ctx.db.prepare(`SELECT * FROM integration_event WHERE id = ? AND source_id = ? AND message_type IN (${types})`).get(input.eventId, sourceId, ...SUPPORTED_MESSAGE_TYPES)
        : ctx.db
            .prepare(`SELECT * FROM integration_event WHERE source_id = ? AND outcome = 'applied' AND message_type IN (${types}) ORDER BY received_at DESC, id DESC LIMIT 1`)
            .get(sourceId, ...SUPPORTED_MESSAGE_TYPES)
    ) as { id: string; message_id: string; message_type: string; payload: string; outcome: string } | undefined;
    if (!ev) throw new DomainError("NOT_FOUND", "No previously received order message to replay for this source");
    if (ev.outcome === "failed") throw new DomainError("VALIDATION", "That message failed; use Retry in the failure queue instead of a duplicate replay");
    const importCtx: Ctx = { ...ctx, origin: "import" };
    const res = importSourceMessage(importCtx, sourceId, { messageId: ev.message_id, messageType: ev.message_type, payload: ev.payload }, { via: "replay" });
    audit(ctx, {
      action: "integration.duplicate_replayed",
      entityType: "integration_event",
      entityId: ev.id,
      summary: `Demo control: duplicate of ${ev.message_id} re-sent by the simulated source → ${res.outcome.replace(/_/g, " ")}`,
    });
    return { messageId: ev.message_id, outcome: res.outcome, detail: res.detail, receiptCount: res.receiptCount ?? null };
  },
});

defineCommand({
  name: "integration.deliverOlderVersion",
  description: "Demo control: the simulated source sends an OLDER version of an order late (out of order). Must be ignored as stale.",
  permission: null,
  audience: "presenter",
  input: z.object({ sourceId: z.string().optional() }),
  run(ctx, input) {
    const sourceId = defaultSourceId(ctx, input.sourceId);
    const src = sourceAdapterRow(ctx, sourceId);
    const order = ctx.db
      .prepare(
        `SELECT so.id, so.source_order_id, so.source_version FROM source_order so
          WHERE so.tenant_id = ? AND so.source_version >= 2 ORDER BY so.imported_at DESC, so.id LIMIT 1`,
      )
      .get(src.tenant_id) as { id: string; source_order_id: string; source_version: number } | undefined;
    const fallback = order
      ? undefined
      : (ctx.db.prepare("SELECT id, source_order_id, source_version FROM source_order WHERE tenant_id = ? ORDER BY imported_at DESC, id LIMIT 1").get(src.tenant_id) as
          | { id: string; source_order_id: string; source_version: number }
          | undefined);
    const target = order ?? fallback;
    if (!target) throw new DomainError("NOT_FOUND", "No order on file for this source to replay");
    const older = ctx.db
      .prepare("SELECT source_version, payload FROM source_order_version WHERE source_order_id = ? AND source_version < ? ORDER BY source_version DESC LIMIT 1")
      .get(target.id, target.source_version) as { source_version: number; payload: string } | undefined;
    const pick = older ?? (ctx.db.prepare("SELECT source_version, payload FROM source_order_version WHERE source_order_id = ? AND source_version = ?").get(target.id, target.source_version) as { source_version: number; payload: string });
    const n = ((ctx.db.prepare("SELECT COUNT(*) n FROM sim_source_outbox WHERE source_id = ? AND message_id LIKE ?").get(sourceId, `${target.source_order_id}#v${pick.source_version}-late-%`) as { n: number }).n ?? 0) + 1;
    const messageId = `${target.source_order_id}#v${pick.source_version}-late-${n}`;
    ctx.db
      .prepare("INSERT INTO sim_source_outbox (id, source_id, message_id, message_type, available_at, payload, delivered_at) VALUES (?, ?, ?, 'order.upsert', ?, ?, NULL)")
      .run(newId(ctx.db, "ob"), sourceId, messageId, ctx.now, pick.payload);
    audit(ctx, {
      action: "integration.older_version_queued",
      entityType: "source_order",
      entityId: target.id,
      summary: `Demo control: simulated source sends ${target.source_order_id} v${pick.source_version} late (stored version is v${target.source_version})`,
    });
    const pumped = pumpSourcesDetailed(ctx.db, { sourceId, via: "sync" });
    const outcome = pumped.sources[0]?.outcomes.find((o) => o.messageId === messageId);
    return {
      messageId,
      order: target.source_order_id,
      sentVersion: pick.source_version,
      storedVersion: target.source_version,
      outcome: outcome?.outcome ?? null,
      detail: outcome?.detail ?? (src.status === "offline" ? "Source offline (simulated): the message is queued and will be delivered after restore." : "Queued."),
    };
  },
});

defineCommand({
  name: "integration.injectImportFailure",
  description: "Demo control: the next message from this source fails processing (appears in the failure queue, retryable).",
  permission: null,
  audience: "presenter",
  input: z.object({ sourceId: z.string().min(1), enabled: z.boolean().default(true) }),
  run(ctx, input) {
    const src = sourceAdapterRow(ctx, input.sourceId);
    setSetting(ctx.db, `s6_fail_next_import:${src.id}`, input.enabled ? "1" : "0", ctx.now);
    audit(ctx, {
      action: "integration.failure_injection_set",
      entityType: "integration_source",
      entityId: src.id,
      summary: input.enabled ? `Demo control: next message from ${src.name} will fail processing (simulated)` : `Demo control: failure injection for ${src.name} cleared`,
    });
    return { sourceId: src.id, armed: input.enabled };
  },
});

// ------------------------------------------------------------------ other simulated connectors

defineCommand({
  name: "printer.setStatus",
  description: "Demo control: set a simulated printer online, offline, or to time out after the next submission.",
  permission: null,
  audience: "presenter",
  input: z.object({ printerId: z.string().min(1), status: z.enum(["online", "offline", "simulate_timeout"]) }),
  run(ctx, input) {
    const p = ctx.db.prepare("SELECT id, name, status FROM printer WHERE id = ?").get(input.printerId) as { id: string; name: string; status: string } | undefined;
    if (!p) throw new DomainError("NOT_FOUND", "Printer not found");
    if (p.status === input.status) return { printerId: p.id, status: p.status, unchanged: true };
    ctx.db.prepare("UPDATE printer SET status = ? WHERE id = ?").run(input.status, p.id);
    const label = { online: "online", offline: "offline (jobs stay queued)", simulate_timeout: "set to time out after submission (outcome becomes unknown)" }[input.status];
    audit(ctx, {
      action: "printer.status_set",
      entityType: "printer",
      entityId: p.id,
      summary: `Demo control: ${p.name} ${label}`,
      before: { status: p.status },
      after: { status: input.status },
    });
    return { printerId: p.id, status: input.status, unchanged: false };
  },
});

defineCommand({
  name: "notifications.setStatus",
  description: "Demo control: take the simulated office-notification connector offline (sends are recorded as delivery failed) or restore it.",
  permission: null,
  audience: "presenter",
  input: z.object({ status: z.enum(["connected", "offline"]) }),
  run(ctx, input) {
    const row = ctx.db.prepare("SELECT id, name, status FROM integration_source WHERE adapter = 'simulated_notifications' LIMIT 1").get() as
      | { id: string; name: string; status: string }
      | undefined;
    if (!row) throw new DomainError("NOT_FOUND", "The simulated notification connector is not configured");
    if (row.status === input.status) return { sourceId: row.id, status: row.status, unchanged: true };
    ctx.db
      .prepare("UPDATE integration_source SET status = ?, last_attempt_at = ?, last_error = ? WHERE id = ?")
      .run(input.status, ctx.now, input.status === "offline" ? "Simulated notification outage (demo control)" : null, row.id);
    audit(ctx, {
      action: "notifications.status_set",
      entityType: "integration_source",
      entityId: row.id,
      summary:
        input.status === "offline"
          ? `Demo control: ${row.name} OFFLINE. New clarification sends are recorded as "delivery failed"; nothing contacts a real office either way.`
          : `Demo control: ${row.name} restored`,
      before: { status: row.status },
      after: { status: input.status },
    });
    return { sourceId: row.id, status: input.status, unchanged: false };
  },
});

defineCommand({
  name: "assistant.setMode",
  description: "Demo control: the drafting/extraction assistant is deterministic (demo output) or unavailable (manual work continues).",
  permission: null,
  audience: "presenter",
  input: z.object({ mode: z.enum(["deterministic", "unavailable"]) }),
  run(ctx, input) {
    const before = getSetting(ctx.db, "assistant_mode") ?? "deterministic";
    if (before === input.mode) return { mode: input.mode, unchanged: true };
    setSetting(ctx.db, "assistant_mode", input.mode, ctx.now);
    ctx.db
      .prepare("UPDATE integration_source SET status = ?, last_error = ?, last_attempt_at = ? WHERE adapter = 'deterministic_assistant'")
      .run(input.mode === "unavailable" ? "offline" : "connected", input.mode === "unavailable" ? "Assistant unavailable (demo control)" : null, ctx.now);
    audit(ctx, {
      action: "assistant.mode_set",
      entityType: "app_setting",
      entityId: "assistant_mode",
      summary:
        input.mode === "unavailable"
          ? "Demo control: assistant set UNAVAILABLE. Drafting and extraction fall back to manual entry."
          : "Demo control: assistant restored (deterministic demo output, not live AI)",
      before: { mode: before },
      after: { mode: input.mode },
    });
    return { mode: input.mode, unchanged: false };
  },
});

// ------------------------------------------------------------------ demo clock

defineCommand({
  name: "demo.setClock",
  description: "Demo control: pause/resume the demo clock, advance it, or jump forward to a time. Never moves backwards unless it is an explicit reset.",
  permission: null,
  audience: "presenter",
  input: z
    .object({
      iso: isoString.optional(),
      running: z.boolean().optional(),
      advanceMinutes: z.number().int().min(1).max(24 * 60).optional(),
      reset: z.boolean().optional(),
    })
    .refine((v) => !(v.iso && v.advanceMinutes), "Use either iso or advanceMinutes, not both"),
  run(ctx, input) {
    const before = readClock(ctx.db);
    let target = Date.parse(before.now);
    if (input.iso) target = Date.parse(input.iso);
    if (input.advanceMinutes) target = Date.parse(before.now) + input.advanceMinutes * 60_000;
    if (target < Date.parse(before.now) && !input.reset) {
      throw new DomainError(
        "INVARIANT",
        `The demo clock does not move backwards (it is ${fmtTime(before.now)} ET). Events already recorded would appear to happen in the future. Use "Reset demo data" to start again at 10:52.`,
      );
    }
    const running = input.running ?? before.running;
    const after = setClock(ctx.db, new Date(target).toISOString(), running);
    const moved = target !== Date.parse(before.now);
    audit(ctx, {
      action: "demo.clock_set",
      entityType: "demo_clock",
      entityId: "demo_clock",
      summary: `Demo clock ${moved ? `${fmtTime(before.now)} → ${fmtTime(after.now)} ET` : `at ${fmtTime(after.now)} ET`}${running !== before.running ? (running ? ", resumed" : ", paused") : ""}${input.reset && target < Date.parse(before.now) ? " (explicit rewind)" : ""}`,
      before: { now: before.now, running: before.running },
      after: { now: after.now, running: after.running },
    });
    // Let the simulated sources catch up with the new time.
    const delivered = moved && target > Date.parse(before.now) ? pumpSourcesDetailed(ctx.db, { via: "sync" }).delivered : 0;
    return { now: after.now, running: after.running, delivered };
  },
});

// ------------------------------------------------------------------ routing rules

defineCommand({
  name: "routing.draftRuleSet",
  description: "Draft a new version of the office → dermatopathologist rules (copies the current approved rules). Needs a reason and later approval.",
  permission: "routing.editRules",
  input: z.object({
    reason: reasonString,
    changes: z.array(z.object({ officeId: z.string().min(1), pathologistId: z.string().min(1).nullable() })).min(1).max(50),
  }),
  run(ctx, input) {
    return draftRuleSet(ctx, input);
  },
});

defineCommand({
  name: "routing.approveRuleSet",
  description: "Approve a draft routing rule version (medical director or supervisor). The previous approved version is retired; approved rules are frozen.",
  permission: "routing.approveRules",
  input: z.object({ ruleSetId: z.string().min(1), effectiveFrom: isoString.optional() }),
  run(ctx, input) {
    return approveRuleSet(ctx, input);
  },
});

defineCommand({
  name: "routing.discardDraft",
  description: "Discard a draft routing rule version that should not be approved (kept for the record).",
  permission: "routing.editRules",
  input: z.object({ ruleSetId: z.string().min(1), reason: reasonString }),
  run(ctx, input) {
    return discardDraft(ctx, input);
  },
});

defineCommand({
  name: "routing.addCoverage",
  description: "Add an approved coverage exception: who covers a dermatopathologist's planned absence.",
  permission: "routing.approveRules",
  input: z.object({
    pathologistId: z.string().min(1),
    coveringPathologistId: z.string().min(1),
    startsAt: isoString,
    endsAt: isoString,
    reason: reasonString,
  }),
  run(ctx, input) {
    return addCoverage(ctx, input);
  },
});

defineCommand({
  name: "routing.retireCoverage",
  description: "Retire a coverage exception that no longer applies (kept for the record).",
  permission: "routing.approveRules",
  input: z.object({ coverageId: z.string().min(1), reason: reasonString }),
  run(ctx, input) {
    return retireCoverage(ctx, input);
  },
});

// ------------------------------------------------------------------ office contact directory

interface ContactRow {
  id: string;
  office_id: string;
  display_name: string;
  is_primary: number;
  is_escalation: number;
  out_until: string | null;
  backup_contact_id: string | null;
}

export function contactVersion(ctx: Pick<Ctx, "db">, contactId: string): number {
  const row = ctx.db.prepare("SELECT version FROM office_contact_revision WHERE contact_id = ?").get(contactId) as { version: number } | undefined;
  return row?.version ?? 1;
}

defineCommand({
  name: "office.updateContact",
  description: "Edit the office contact/coverage directory (supervisor): out-until coverage gap, backup contact, primary and escalation flags. Fictional, simulated channels.",
  permission: "routing.editRules",
  input: z.object({
    contactId: z.string().min(1),
    expectedVersion: z.number().int().min(1),
    patch: z
      .object({
        out_until: isoString.nullable().optional(),
        backup_contact_id: z.string().min(1).nullable().optional(),
        is_primary: z.boolean().optional(),
        is_escalation: z.boolean().optional(),
      })
      .refine((p) => Object.keys(p).length > 0, "Nothing to change"),
  }),
  run(ctx, input) {
    const db = ctx.db;
    const c = db.prepare("SELECT * FROM office_contact WHERE id = ?").get(input.contactId) as ContactRow | undefined;
    if (!c) throw new DomainError("NOT_FOUND", "Office contact not found");
    const current = contactVersion(ctx, c.id);
    if (input.expectedVersion !== current) {
      // Who saved the newer version and when (spec §7 conflict dialog: "their value (who, when)").
      const rev = db.prepare("SELECT updated_at, updated_by FROM office_contact_revision WHERE contact_id = ?").get(c.id) as
        | { updated_at: string | null; updated_by: string | null }
        | undefined;
      throw new DomainError(
        "CONFLICT",
        `This contact was changed by someone else after you opened it (you had version ${input.expectedVersion}, current is ${current}). Review the latest values before saving.`,
        {
          table: "office_contact",
          id: c.id,
          expectedVersion: input.expectedVersion,
          currentVersion: current,
          current: { ...c, version: current, updated_at: rev?.updated_at ?? null, updated_by: rev?.updated_by ?? null },
        },
      );
    }
    const p = input.patch;
    const sets: Record<string, unknown> = {};
    const changes: string[] = [];
    if (p.out_until !== undefined) {
      const v = p.out_until ? new Date(p.out_until).toISOString() : null;
      if (v !== c.out_until) {
        sets.out_until = v;
        changes.push(v ? `out until ${fmtTime(v)} ET (${new Date(v).toISOString().slice(0, 10)})` : "available (out-until cleared)");
      }
    }
    if (p.backup_contact_id !== undefined && p.backup_contact_id !== c.backup_contact_id) {
      if (p.backup_contact_id) {
        if (p.backup_contact_id === c.id) throw new DomainError("VALIDATION", "A contact cannot be their own backup");
        const b = db.prepare("SELECT id, office_id, display_name FROM office_contact WHERE id = ?").get(p.backup_contact_id) as
          | { id: string; office_id: string; display_name: string }
          | undefined;
        if (!b || b.office_id !== c.office_id) throw new DomainError("VALIDATION", "The backup must be another contact at the same office");
        changes.push(`backup → ${b.display_name}`);
      } else changes.push("backup cleared");
      sets.backup_contact_id = p.backup_contact_id;
    }
    // Clarifications go to the primary of the REGULAR contacts; the escalation contact is kept apart (it
    // receives escalations only). One person in both roles would make the directory say one thing and routing
    // do another, so the combination is refused.
    const willBePrimary = p.is_primary !== undefined ? p.is_primary : c.is_primary === 1;
    const willBeEscalation = p.is_escalation !== undefined ? p.is_escalation : c.is_escalation === 1;
    if (willBePrimary && willBeEscalation) {
      throw new DomainError(
        "VALIDATION",
        `${c.display_name} cannot be both the primary and the escalation contact. Clarifications go to the primary; escalations go to a separate escalation contact. Choose one role.`,
      );
    }
    if (p.is_primary !== undefined && (p.is_primary ? 1 : 0) !== c.is_primary) {
      sets.is_primary = p.is_primary ? 1 : 0;
      changes.push(p.is_primary ? "made primary contact" : "no longer primary");
    }
    if (p.is_escalation !== undefined && (p.is_escalation ? 1 : 0) !== c.is_escalation) {
      sets.is_escalation = p.is_escalation ? 1 : 0;
      changes.push(p.is_escalation ? "made escalation contact" : "no longer escalation contact");
    }
    if (!changes.length) return { contactId: c.id, version: current, changes: [] as string[] };

    const keys = Object.keys(sets);
    db.prepare(`UPDATE office_contact SET ${keys.map((k) => `${k} = @${k}`).join(", ")} WHERE id = @id`).run({ ...sets, id: c.id });
    // One primary per office: promoting this contact demotes the previous primary (recorded).
    if (sets.is_primary === 1) {
      const demoted = db.prepare("SELECT id, display_name FROM office_contact WHERE office_id = ? AND id <> ? AND is_primary = 1").all(c.office_id, c.id) as {
        id: string;
        display_name: string;
      }[];
      for (const d of demoted) {
        db.prepare("UPDATE office_contact SET is_primary = 0 WHERE id = ?").run(d.id);
        bumpContactVersion(ctx, d.id);
        changes.push(`${d.display_name} no longer primary`);
      }
    }
    const version = bumpContactVersion(ctx, c.id);
    audit(ctx, {
      action: "office.contact_updated",
      entityType: "office_contact",
      entityId: c.id,
      summary: `Contact directory: ${c.display_name} — ${changes.join("; ")} (fictional contact, simulated channel)`,
      before: { out_until: c.out_until, backup_contact_id: c.backup_contact_id, is_primary: c.is_primary, is_escalation: c.is_escalation },
      after: sets,
    });
    return { contactId: c.id, version, changes };
  },
});

function bumpContactVersion(ctx: Ctx, contactId: string): number {
  const next = contactVersion(ctx, contactId) + 1;
  ctx.db
    .prepare(
      `INSERT INTO office_contact_revision (contact_id, version, updated_at, updated_by) VALUES (?, ?, ?, ?)
       ON CONFLICT(contact_id) DO UPDATE SET version = excluded.version, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    )
    .run(contactId, next, ctx.now, ctx.actor.id);
  return next;
}

export const __adminCommands = [
  "integration.setSourceStatus",
  "integration.syncNow",
  "integration.retryEvent",
  "integration.deliverQueuedNow",
  "integration.replayDuplicate",
  "integration.deliverOlderVersion",
  "integration.injectImportFailure",
  "printer.setStatus",
  "notifications.setStatus",
  "assistant.setMode",
  "demo.setClock",
  "routing.draftRuleSet",
  "routing.approveRuleSet",
  "routing.discardDraft",
  "routing.addCoverage",
  "routing.retireCoverage",
  "office.updateContact",
] as const;
