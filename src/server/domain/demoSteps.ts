import type { DB } from "../db/db";
import type { Ctx } from "../core/context";
import { makeCtx } from "../core/context";
import { executeCommand, listCommands, type CommandResult } from "../commands/registry";
import { advanceClockTo, readClock } from "../core/clock";
import { getSetting } from "../core/settings";
import { audit } from "../core/audit";
import { labLocalToIso } from "@/lib/time";
import { grossFinalizeBlockers, REQUIRED_FOR_APPROVAL, type GrossFields, type GrossValue } from "@/lib/gross";

/**
 * Guided five-minute demonstration (master spec §12).
 *
 * Each of the 8 narrative steps has two kinds of events:
 *  - WORLD events: things the outside world does in the story (courier arrives,
 *    the simulated office answers, the simulated source system sends an
 *    amended order). "Run simulator events" performs only these, so the
 *    presenter does every staff action on the real screens.
 *  - STAFF actions: what lab staff would click. Performed only when
 *    `autoStaffActions` is true (rehearsal and tests), always through the other
 *    slices' commands BY NAME, as the staff member who would do them, so
 *    server-side role checks, holds, audit and idempotency all still apply.
 *
 * Nothing here writes tables directly: every change is a command. Running a
 * step twice is safe (each action checks current state first and each command
 * is idempotent where the contract requires it).
 */

export const DEMO_STEP_COUNT = 8;
export type DemoStepNumber = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

/** Fixed scenario identifiers (seed: src/server/seed/scenario.ts). */
export const DEMO_IDS = {
  delivery: "cr_1100",
  physA: "phys_quinlanA",
  physB: "phys_quinlanB",
  orderA: "ORD-77120",
  orderB: "ORD-77121",
  tenant: "ten_ema",
  transcriptKey: "quinlan-A",
  tray: "tray_m03",
  trayDisplay: "TRY-M-03",
  printJob: "pj_pj_8841",
  printJobDisplay: "PJ-8841",
  retrieval: "rr_0192",
  retrievalDisplay: "RR-0192",
  wrongBlockAccession: "D26-03909",
  expectedAccession: "D26-04817",
} as const;

/** Demo-clock time (America/New_York) each step moves the clock to before its events. */
export const DEMO_STEP_CLOCK: Record<DemoStepNumber, string> = {
  1: "11:00",
  2: "11:03",
  3: "11:06",
  4: "11:18",
  5: "11:30",
  6: "11:40",
  7: "11:45",
  8: "11:50",
};

/** Commands each step needs, by mode. Used to refuse cleanly when another slice has not shipped a command yet. */
export const STEP_COMMANDS: Record<DemoStepNumber, { world: string[]; staff: string[] }> = {
  1: { world: ["intake.receiveDelivery", "intake.receiveAll"], staff: ["routing.confirm"] },
  2: { world: [], staff: ["intake.verifyContainer", "related.review"] },
  3: {
    world: ["clarification.simulateOfficeAnswer", "integration.syncNow"],
    staff: ["intake.verifyContainer", "clarification.create", "clarification.draftMessage", "clarification.send", "clarification.review", "clarification.resolve", "hold.release"],
  },
  4: { world: [], staff: ["intake.verifyContainer", "accession.request"] },
  5: { world: [], staff: ["gross.startDraft", "gross.loadTranscript", "gross.confirmField", "gross.markReviewed", "gross.approve"] },
  6: { world: [], staff: ["tray.scan", "tray.complete", "tray.resolveScan", "print.reconcile", "print.reprint"] },
  7: { world: [], staff: ["retrieval.scan"] },
  8: { world: [], staff: [] },
};

/** Pure: which required commands are not registered (yet) for this step and mode. */
export function missingCommandsFor(step: DemoStepNumber, autoStaffActions: boolean, registered: ReadonlySet<string>): string[] {
  const req = STEP_COMMANDS[step];
  const names = autoStaffActions ? [...req.world, ...req.staff] : req.world;
  return [...new Set(names)].filter((n) => !registered.has(n));
}

export function registeredCommandNames(): Set<string> {
  return new Set(listCommands().map((c) => c.name));
}

// ---------------------------------------------------------------- result shape

export type ActionOutcome = "done" | "already_done" | "skipped" | "rejected_as_expected" | "failed" | "not_available";

export interface DemoActionLog {
  kind: "world" | "staff" | "clock";
  label: string;
  command?: string;
  actor?: string;
  outcome: ActionOutcome;
  detail?: string;
}

export interface DemoStepResult {
  step: DemoStepNumber;
  autoStaffActions: boolean;
  /** "ran": events performed (some actions may be skipped/failed — see actions). "not_available": nothing changed. "needs_presenter": nothing to do until the presenter acts on a real screen. */
  status: "ran" | "not_available" | "needs_presenter";
  message: string;
  missingCommands: string[];
  actions: DemoActionLog[];
  clockBefore: string;
  clockAfter: string;
}

// ---------------------------------------------------------------- lookups (read-only SQL)

const STAFF_NAME: Record<string, string> = {
  stf_maya: "Maya Torres (accessioner)",
  stf_kim: "Kim Nguyen (accessioning lead)",
  stf_dana: "Dana Whitfield (grosser)",
  stf_priya: "Priya Shah (histotech)",
  stf_marcus: "Marcus Lee (histotech)",
  stf_tanya: "Tanya Brooks (supervisor)",
  system: "Simulator",
};

export interface HeroIds {
  intakeA: { id: string; displayId: string; version: number } | null;
  intakeB: { id: string; displayId: string; version: number } | null;
  orderA: { id: string; partId: string | null } | null;
  orderB: { id: string; partId: string | null } | null;
  containerA: { id: string; version: number; state: string; orderPartId: string | null } | null;
  containerB: { id: string; version: number; state: string; orderPartId: string | null; observed: Record<string, unknown> } | null;
  candidate: { id: string; displayId: string; status: string; version: number } | null;
  clarification: { id: string; displayId: string; state: string; version: number; reviewedAt: string | null; resolvedAt: string | null } | null;
  hold: { id: string; displayId: string; status: string; version: number } | null;
  amendedOrderImported: boolean;
  accession: { id: string; number: string } | null;
  partA: { id: string } | null;
  partB: { id: string } | null;
}

function demoDay(db: DB): string {
  return getSetting(db, "demo_day") ?? "2026-10-14";
}

function clockIso(db: DB, hhmm: string): string {
  return labLocalToIso(demoDay(db), hhmm);
}

/** Look up the hero case's records by their stable scenario identifiers. */
export function heroIds(db: DB): HeroIds {
  const intake = (phys: string) =>
    (db
      .prepare(
        `SELECT ii.id, ii.display_id AS displayId, ii.version FROM sim_physical_item p JOIN intake_item ii ON ii.id = p.received_intake_item_id WHERE p.id = ?`,
      )
      .get(phys) as { id: string; displayId: string; version: number } | undefined) ?? null;
  const order = (src: string) => {
    const o = db.prepare("SELECT id FROM source_order WHERE tenant_id = ? AND source_order_id = ?").get(DEMO_IDS.tenant, src) as { id: string } | undefined;
    if (!o) return null;
    const p = db.prepare("SELECT id FROM source_order_part WHERE source_order_id = ? ORDER BY designation LIMIT 1").get(o.id) as { id: string } | undefined;
    return { id: o.id, partId: p?.id ?? null };
  };
  const intakeA = intake(DEMO_IDS.physA);
  const intakeB = intake(DEMO_IDS.physB);
  const orderA = order(DEMO_IDS.orderA);
  const orderB = order(DEMO_IDS.orderB);
  const container = (intakeId: string | undefined) =>
    intakeId
      ? ((db
          .prepare("SELECT id, version, verification_state AS state, order_part_id AS orderPartId, observed_label FROM container WHERE intake_item_id = ? ORDER BY seq LIMIT 1")
          .get(intakeId) as { id: string; version: number; state: string; orderPartId: string | null; observed_label: string } | undefined) ?? null)
      : null;
  const cA = container(intakeA?.id);
  const cB = container(intakeB?.id);

  let candidate: HeroIds["candidate"] = null;
  if (orderA && orderB) {
    const [a, b] = [orderA.id, orderB.id].sort();
    candidate =
      (db
        .prepare("SELECT id, display_id AS displayId, status, version FROM related_order_candidate WHERE order_a_id = ? AND order_b_id = ?")
        .get(a, b) as HeroIds["candidate"] | undefined) ?? null;
  }

  let clarification: HeroIds["clarification"] = null;
  if (orderB) {
    clarification =
      (db
        .prepare(
          `SELECT id, display_id AS displayId, state, version, reviewed_at AS reviewedAt, resolved_at AS resolvedAt FROM clarification
            WHERE category = 'laterality' AND state <> 'canceled'
              AND (order_part_id = @part OR source_order_id = @order OR (@intake IS NOT NULL AND intake_item_id = @intake) OR (@container IS NOT NULL AND container_id = @container))
            ORDER BY created_at DESC LIMIT 1`,
        )
        .get({ part: orderB.partId, order: orderB.id, intake: intakeB?.id ?? null, container: cB?.id ?? null }) as HeroIds["clarification"] | undefined) ?? null;
  }

  let hold: HeroIds["hold"] = null;
  if (clarification || orderB?.partId) {
    hold =
      (db
        .prepare(
          `SELECT id, display_id AS displayId, status, version FROM hold
            WHERE (@clr IS NOT NULL AND clarification_id = @clr) OR (scope_type = 'order_part' AND scope_id = @part)
            ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, placed_at DESC LIMIT 1`,
        )
        .get({ clr: clarification?.id ?? null, part: orderB?.partId ?? null }) as HeroIds["hold"] | undefined) ?? null;
  }

  const amendedOrderImported = orderB
    ? !!db.prepare("SELECT 1 FROM source_order_version WHERE source_order_id = ? AND source_version >= 2").get(orderB.id)
    : false;

  const accRow = (intakeA?.id
    ? db.prepare("SELECT a.id, a.accession_number AS number FROM intake_item ii JOIN accession a ON a.id = ii.accession_id WHERE ii.id = ?").get(intakeA.id)
    : undefined) as { id: string; number: string } | undefined;
  const accession = accRow ?? null;
  const part = (orderId: string | undefined) =>
    accession && orderId
      ? ((db.prepare("SELECT id FROM specimen_part WHERE accession_id = ? AND source_order_id = ? ORDER BY designation LIMIT 1").get(accession.id, orderId) as
          | { id: string }
          | undefined) ?? null)
      : null;

  let observedB: Record<string, unknown> = {};
  try {
    observedB = cB ? (JSON.parse(cB.observed_label) as Record<string, unknown>) : {};
  } catch {
    observedB = {};
  }

  return {
    intakeA,
    intakeB,
    orderA,
    orderB,
    containerA: cA ? { id: cA.id, version: cA.version, state: cA.state, orderPartId: cA.orderPartId } : null,
    containerB: cB ? { id: cB.id, version: cB.version, state: cB.state, orderPartId: cB.orderPartId, observed: observedB } : null,
    candidate,
    clarification,
    hold,
    amendedOrderImported,
    accession,
    partA: part(orderA?.id),
    partB: part(orderB?.id),
  };
}

// ---------------------------------------------------------------- runner

class StepRunner {
  readonly actions: DemoActionLog[] = [];
  constructor(
    readonly db: DB,
    readonly correlationId: string,
  ) {}

  clock(hhmm: string, label?: string): void {
    const target = clockIso(this.db, hhmm);
    const before = readClock(this.db).now;
    const alreadyPast = Date.parse(target) <= Date.parse(before);
    if (!alreadyPast) advanceClockTo(this.db, target);
    this.actions.push({
      kind: "clock",
      label: label ?? `Demo clock to ${hhmm} ET`,
      outcome: alreadyPast ? "already_done" : "done",
      detail: alreadyPast ? "The clock was already at or past this time (the demo clock never moves backward)." : undefined,
    });
  }

  /** Advance the clock by whole minutes from its current value (never backward). */
  clockPlus(minutes: number, label: string): void {
    const now = readClock(this.db).now;
    advanceClockTo(this.db, new Date(Date.parse(now) + minutes * 60_000).toISOString());
    this.actions.push({ kind: "clock", label, outcome: "done" });
  }

  note(kind: DemoActionLog["kind"], label: string, outcome: ActionOutcome, detail?: string): void {
    this.actions.push({ kind, label, outcome, detail });
  }

  /**
   * Run another slice's command by name. World events run as the simulator
   * (or the named staff member for physical arrival); staff actions run as the
   * staff member with origin "demo" so role checks still apply.
   */
  call<R = unknown>(
    kind: "world" | "staff",
    label: string,
    actorId: string,
    name: string,
    input: unknown,
    opts: { expectRejection?: boolean } = {},
  ): CommandResult<R> {
    const origin = actorId === "system" ? "simulator" : "demo";
    const res = executeCommand<R>(this.db, actorId, name, input, { origin, correlationId: this.correlationId });
    const actor = STAFF_NAME[actorId] ?? actorId;
    if (!res.ok) {
      const notAvailable = res.error.code === "NOT_FOUND" && res.error.message.startsWith("Unknown command");
      this.actions.push({
        kind,
        label,
        command: name,
        actor,
        outcome: notAvailable ? "not_available" : opts.expectRejection ? "rejected_as_expected" : "failed",
        detail: notAvailable ? `Command "${name}" is not available yet in this build.` : `${res.error.code}: ${res.error.message}`,
      });
    } else {
      this.actions.push({
        kind,
        label,
        command: name,
        actor,
        outcome: opts.expectRejection ? "failed" : res.replayed ? "already_done" : "done",
        detail: opts.expectRejection ? "Expected this to be refused, but it was accepted." : summarizeResult(res.result),
      });
    }
    return res;
  }
}

function summarizeResult(r: unknown): string | undefined {
  if (!r || typeof r !== "object") return undefined;
  const o = r as Record<string, unknown>;
  const keys = ["displayId", "display_id", "accessionNumber", "accession_number", "result", "status", "state", "outcome", "duplicate"];
  const bits: string[] = [];
  for (const k of keys) {
    const v = o[k];
    if (v === undefined || v === null || typeof v === "object") continue;
    bits.push(`${k}: ${String(v)}`);
  }
  return bits.length ? bits.join(" · ") : undefined;
}

function rowVersion(db: DB, table: "container" | "clarification" | "related_order_candidate" | "hold" | "gross_record" | "tray" | "print_job", id: string): number | undefined {
  const r = db.prepare(`SELECT version FROM ${table} WHERE id = ?`).get(id) as { version: number } | undefined;
  return r?.version;
}

// ---------------------------------------------------------------- the steps

/** Run one guided-demo step. Called by the `demo.runStep` command (inside its transaction). */
export function runDemoStep(ctx: Ctx, step: DemoStepNumber, autoStaffActions: boolean): DemoStepResult {
  const db = ctx.db;
  const clockBefore = readClock(db).now;
  const missing = missingCommandsFor(step, autoStaffActions, registeredCommandNames());
  if (missing.length) {
    return {
      step,
      autoStaffActions,
      status: "not_available",
      message: `Step ${step} is not available yet in this build: it needs ${missing.join(", ")}. Nothing was changed.`,
      missingCommands: missing,
      actions: [],
      clockBefore,
      clockAfter: clockBefore,
    };
  }

  const r = new StepRunner(db, ctx.correlationId);
  let status: DemoStepResult["status"] = "ran";
  let message = "";

  switch (step) {
    case 1:
      ({ status, message } = step1(r, autoStaffActions));
      break;
    case 2:
      ({ status, message } = step2(r, autoStaffActions));
      break;
    case 3:
      ({ status, message } = step3(r, autoStaffActions));
      break;
    case 4:
      ({ status, message } = step4(r, autoStaffActions));
      break;
    case 5:
      ({ status, message } = step5(r, autoStaffActions));
      break;
    case 6:
      ({ status, message } = step6(r, autoStaffActions));
      break;
    case 7:
      ({ status, message } = step7(r, autoStaffActions));
      break;
    case 8:
      ({ status, message } = step8(r));
      break;
  }

  const clockAfter = readClock(db).now;
  const failed = r.actions.filter((a) => a.outcome === "failed" || a.outcome === "not_available").length;
  const dctx = makeCtx(db, ctx.actor, "demo", ctx.correlationId);
  audit(dctx, {
    action: "demo.step_run",
    entityType: "demo_step",
    entityId: String(step),
    summary: `Demo step ${step} run${autoStaffActions ? " (simulator events and rehearsal staff actions)" : " (simulator events only)"}${failed ? `: ${failed} action(s) did not complete` : ""}`,
    after: { status, actions: r.actions.map((a) => ({ label: a.label, outcome: a.outcome })) },
  });
  db.prepare("INSERT INTO demo_step_log (step, action, ran_at, ran_by, result) VALUES (?, ?, ?, ?, ?)").run(
    step,
    autoStaffActions ? "world+staff" : "world",
    dctx.now,
    ctx.actor.id,
    JSON.stringify({ status, message, actions: r.actions }),
  );

  return { step, autoStaffActions, status, message, missingCommands: [], actions: r.actions, clockBefore, clockAfter };
}

type StepOutcome = { status: DemoStepResult["status"]; message: string };

// Step 1 — 11:00 courier arrival, reconciliation, routing by rule.
function step1(r: StepRunner, auto: boolean): StepOutcome {
  const db = r.db;
  r.clock(DEMO_STEP_CLOCK[1], "Demo clock to 11:00 ET (courier due)");
  const delivery = db.prepare("SELECT arrived_at FROM courier_delivery WHERE id = ?").get(DEMO_IDS.delivery) as { arrived_at: string | null } | undefined;
  if (!delivery) {
    r.note("world", "Find courier delivery CR-1014-11", "failed", "The scripted 11:00 delivery is not in the database. Reset the demo data.");
    return { status: "ran", message: "The scripted 11:00 delivery was not found. Reset the demo data and try again." };
  }
  r.call("world", "Courier arrives: record arrival of CR-1014-11 (received by Maya Torres)", "stf_maya", "intake.receiveDelivery", { deliveryId: DEMO_IDS.delivery });
  r.call("world", "Unpack the delivery: simulated scan of every requisition and container", "stf_maya", "intake.receiveAll", { deliveryId: DEMO_IDS.delivery });

  if (auto) {
    const h = heroIds(db);
    for (const item of [h.intakeA, h.intakeB]) {
      if (!item) continue;
      const rd = db.prepare("SELECT status FROM routing_decision WHERE intake_item_id = ? AND status <> 'superseded'").get(item.id) as { status: string } | undefined;
      if (rd && (rd.status === "confirmed" || rd.status === "overridden")) {
        r.note("staff", `Accept routing for ${item.displayId}`, "already_done");
        continue;
      }
      r.call("staff", `Accept suggested routing for ${item.displayId} (rule: Harbor Point Dermatology to Dr. Elena Marsh)`, "stf_maya", "routing.confirm", { intakeItemId: item.id });
    }
  }
  return { status: "ran", message: "The 11:00 delivery has arrived and been unpacked. Intake shows expected vs received per office and routing suggestions from the approved rule set." };
}

// Step 2 — A and B as separate orders: related-order candidate reviewed (never merged).
function step2(r: StepRunner, auto: boolean): StepOutcome {
  const db = r.db;
  r.clock(DEMO_STEP_CLOCK[2]);
  let h = heroIds(db);
  if (!h.intakeA || !h.intakeB) {
    r.note("world", "Find the Quinlan intake items", "skipped", "Run step 1 first: the 11:00 delivery has not been unpacked.");
    return { status: "needs_presenter", message: "Run step 1 first: the hero containers have not been received yet." };
  }
  if (!auto) {
    return {
      status: h.candidate && h.candidate.status !== "pending_review" ? "ran" : "needs_presenter",
      message: h.candidate
        ? `Nothing to simulate in this step. ${h.candidate.displayId} is waiting for a staff decision on the Intake screen.`
        : "Nothing to simulate in this step. Related-order detection runs when the containers are received.",
    };
  }
  if (h.containerA && h.containerA.state === "unverified") {
    r.call("staff", `Staff verified against physical container: ${h.intakeA.displayId} part A`, "stf_maya", "intake.verifyContainer", {
      containerId: h.containerA.id,
      expectedVersion: h.containerA.version,
      orderPartId: h.containerA.orderPartId ?? h.orderA?.partId,
    });
  } else if (h.containerA) {
    r.note("staff", `Verify container ${h.intakeA.displayId} part A`, "already_done", `Current state: ${h.containerA.state}`);
  }
  h = heroIds(db);
  if (!h.candidate) {
    r.note("staff", "Review related-order candidate", "failed", "No related-order candidate was proposed for ORD-77120 and ORD-77121.");
  } else if (h.candidate.status !== "pending_review") {
    r.note("staff", `Review ${h.candidate.displayId}`, "already_done", `Decision already recorded: ${h.candidate.status}`);
  } else {
    r.call("staff", `Review ${h.candidate.displayId}: one accession, parts A and B kept with their original orders`, "stf_kim", "related.review", {
      candidateId: h.candidate.id,
      expectedVersion: h.candidate.version,
      decision: "single_accession_approved",
      reason: "Same patient reference, encounter ENC-55031, office and collection day. Parts A and B stay linked to ORD-77120 and ORD-77121; nothing is merged. (Demo rehearsal)",
    });
  }
  return { status: "ran", message: "Related orders reviewed by the accessioning lead. Both source orders are kept." };
}

// Step 3 — Part B laterality mismatch: clarification, scoped hold, simulated office answer, review, resolution, amended order, hold release.
function step3(r: StepRunner, auto: boolean): StepOutcome {
  const db = r.db;
  r.clock(DEMO_STEP_CLOCK[3]);
  let h = heroIds(db);
  if (!h.intakeB || !h.containerB) {
    r.note("world", "Find Part B (ORD-77121)", "skipped", "Run step 1 first: Part B has not been received yet.");
    return { status: "needs_presenter", message: "Run step 1 first: Part B has not been received yet." };
  }
  const intakeB = h.intakeB;
  const containerB = h.containerB;

  if (auto) {
    // Staff: verify container B against the order -> records the laterality discrepancy.
    if (containerB.state === "unverified") {
      r.call("staff", `Staff verified against physical container: ${intakeB.displayId} part B (laterality differs)`, "stf_maya", "intake.verifyContainer", {
        containerId: containerB.id,
        expectedVersion: containerB.version,
        orderPartId: containerB.orderPartId ?? h.orderB?.partId,
      });
    } else {
      r.note("staff", `Verify container ${intakeB.displayId} part B`, "already_done", `Current state: ${containerB.state}`);
    }
    h = heroIds(db);
    // Staff: raise the clarification with a hold on order part B only.
    if (!h.clarification) {
      const op = h.orderB?.partId
        ? (db.prepare("SELECT site_text, laterality FROM source_order_part WHERE id = ?").get(h.orderB.partId) as { site_text: string; laterality: string | null } | undefined)
        : undefined;
      const observedSite = String(containerB.observed.site_text ?? "Unknown");
      const orderSite = op?.site_text ?? "Unknown";
      r.call("staff", "Raise clarification (laterality) with a hold on Part B only", "stf_maya", "clarification.create", {
        category: "laterality",
        refs: { intakeItemId: intakeB.id, sourceOrderId: h.orderB?.id, orderPartId: h.orderB?.partId, containerId: containerB.id },
        subjectLabel: `Part B · ${DEMO_IDS.orderB}`,
        question: `The bottle for part B says "${observedSite}" but order ${DEMO_IDS.orderB} says "${orderSite}". Which side is correct?`,
        evidence: [
          { field: "Laterality", order_value: `${op?.laterality ?? "Unknown"} (${orderSite})`, observed_value: observedSite, requisition_value: null, source: "bottle label (staff entry)" },
        ],
        priority: "high",
        hold: {
          scope: { type: "order_part", id: h.orderB?.partId },
          scopeLabel: `Part B (${DEMO_IDS.orderB} · B)`,
          blocks: ["gross_approval", "processing", "print", "tray_delivery"],
        },
      });
      h = heroIds(db);
    } else {
      r.note("staff", `Raise clarification for Part B`, "already_done", `${h.clarification.displayId} exists (${h.clarification.state}).`);
    }
    // Staff: draft (deterministic demo drafter) and send (simulated notification).
    if (h.clarification && h.clarification.state === "drafted") {
      const draft = r.call<{ body?: string; text?: string }>("staff", `Draft message for ${h.clarification.displayId} (deterministic demo drafter)`, "stf_maya", "clarification.draftMessage", {
        clarificationId: h.clarification.id,
      });
      const body =
        (draft.ok && (draft.result?.body ?? draft.result?.text)) ||
        `Lumen Bay Dermatopathology has a specimen question (${h.clarification.displayId}). Please open the secure case view to respond.`;
      r.call("staff", `Send ${h.clarification.displayId} to the office (simulated notification)`, "stf_maya", "clarification.send", {
        clarificationId: h.clarification.id,
        expectedVersion: rowVersion(db, "clarification", h.clarification.id),
        body,
      });
      h = heroIds(db);
    }
  }

  // World: the simulated office answers (only once a clarification exists).
  if (!h.clarification) {
    r.note("world", "Simulated office answer", "skipped", "No clarification for Part B yet. Raise it from the differing laterality row on the Intake screen, then run this step again.");
    return {
      status: "needs_presenter",
      message: "Raise the Part B laterality clarification on the Intake screen first (with the hold on Part B), then run this step again for the simulated office answer.",
    };
  }
  const answered = ["answered", "reviewed", "resolved"].includes(h.clarification.state);
  if (answered) {
    r.note("world", `Simulated office answer for ${h.clarification.displayId}`, "already_done");
  } else {
    r.clock("11:12", "Demo clock to 11:12 ET (office replies)");
    r.call("world", `Simulated office answer for ${h.clarification.displayId}: the bottle (left) is correct; the office will amend the order`, "system", "clarification.simulateOfficeAnswer", {
      clarificationId: h.clarification.id,
    });
  }
  h = heroIds(db);

  if (auto && h.clarification) {
    // Staff: the lead reviews the answer, then resolves. Resolving does NOT release the hold.
    if (h.clarification.state === "answered") {
      r.clock("11:13", "Demo clock to 11:13 ET");
      r.call("staff", `Review the office answer on ${h.clarification.displayId}`, "stf_kim", "clarification.review", {
        clarificationId: h.clarification.id,
        expectedVersion: rowVersion(db, "clarification", h.clarification.id),
        note: "Office states the bottle (left dorsal forearm) is correct and will amend ORD-77121. (Demo rehearsal)",
      });
      h = heroIds(db);
    }
    if (h.clarification && h.clarification.state === "reviewed") {
      r.call("staff", `Resolve ${h.clarification.displayId} as "confirmed observed" (hold stays until the amended order arrives)`, "stf_kim", "clarification.resolve", {
        clarificationId: h.clarification.id,
        expectedVersion: rowVersion(db, "clarification", h.clarification.id),
        resolutionCode: "confirmed_observed",
        note: "Observed laterality (left) confirmed by the office. Hold on Part B stays until the amended order is received from the source. (Demo rehearsal)",
      });
      h = heroIds(db);
    }
  }

  // World: the simulated source sends the amended order ~1 minute after the answer.
  if (h.amendedOrderImported) {
    r.note("world", `Amended order ${DEMO_IDS.orderB} v2 from the simulated source`, "already_done");
  } else {
    r.clockPlus(2, "Demo clock +2 min (amended order becomes available from the simulated source)");
    r.call("world", `Simulated source sync: deliver amended order ${DEMO_IDS.orderB} v2 (laterality left)`, "system", "integration.syncNow", {});
    h = heroIds(db);
    if (!h.amendedOrderImported) {
      r.note("world", `Amended order ${DEMO_IDS.orderB} v2`, "skipped", "The simulated source has not delivered the amended order yet (it may still be offline or not yet due).");
    }
  }

  if (auto) {
    // Staff: the lead releases the hold only after the amended order arrived.
    if (h.hold && h.hold.status === "active") {
      if (!h.amendedOrderImported) {
        r.note("staff", `Release ${h.hold.displayId}`, "skipped", "Hold kept: the amended order has not arrived from the simulated source.");
      } else if (!h.clarification || h.clarification.state !== "resolved") {
        r.note("staff", `Release ${h.hold.displayId}`, "skipped", "Hold kept: the clarification is not resolved yet.");
      } else {
        r.clockPlus(1, "Demo clock +1 min");
        r.call("staff", `Release ${h.hold.displayId} on Part B (amended order received)`, "stf_kim", "hold.release", {
          holdId: h.hold.id,
          expectedVersion: rowVersion(db, "hold", h.hold.id),
          reason: `Amended order ${DEMO_IDS.orderB} v2 received from the source (laterality left), matching the bottle. ${h.clarification.displayId} resolved after review. (Demo rehearsal)`,
        });
      }
    } else if (h.hold) {
      r.note("staff", `Release ${h.hold.displayId}`, "already_done");
    } else {
      r.note("staff", "Release the Part B hold", "skipped", "No hold on Part B was found.");
    }
  }
  return {
    status: "ran",
    message: auto
      ? "Clarification raised, answered (simulated), reviewed, resolved; hold released only after the amended order arrived."
      : "The simulated office answer has arrived. It does not resolve the clarification or release the hold: review it on the Clarifications screen.",
  };
}

// Step 4 — the simulated authoritative source issues the official accession.
function step4(r: StepRunner, auto: boolean): StepOutcome {
  const db = r.db;
  r.clock(DEMO_STEP_CLOCK[4]);
  let h = heroIds(db);
  if (!h.intakeA || !h.intakeB) {
    r.note("staff", "Request accession", "skipped", "Run step 1 first.");
    return { status: "needs_presenter", message: "Run step 1 first: the hero containers have not been received yet." };
  }
  if (h.accession) {
    r.note("staff", "Request accession for both intake items", "already_done", `Issued: ${h.accession.number}`);
    return { status: "ran", message: `Accession ${h.accession.number} has been issued by the simulated source.` };
  }
  if (!auto) {
    return { status: "needs_presenter", message: "Nothing to simulate here: request the accession on the Intake screen. The simulated source issues the number immediately." };
  }
  // Re-check container B against the amended order (now left on both). Non-fatal if the intake slice keeps the discrepancy.
  if (h.containerB && h.containerB.state === "discrepancy" && h.amendedOrderImported) {
    r.call("staff", `Re-verify ${h.intakeB.displayId} part B against amended order ${DEMO_IDS.orderB} v2`, "stf_maya", "intake.verifyContainer", {
      containerId: h.containerB.id,
      expectedVersion: rowVersion(db, "container", h.containerB.id),
      orderPartId: h.containerB.orderPartId ?? h.orderB?.partId,
    });
    h = heroIds(db);
  }
  r.call("staff", `Request accession for ${h.intakeA.displayId} and ${h.intakeB.displayId} together (simulated source)`, "stf_maya", "accession.request", {
    intakeItemIds: [h.intakeA.id, h.intakeB.id],
    relatedCandidateId: h.candidate?.id,
  });
  h = heroIds(db);
  return {
    status: "ran",
    message: h.accession ? `Accession ${h.accession.number} issued by the simulated source. Parts A and B keep their original orders.` : "Accession was not issued. See the action log.",
  };
}

// Step 5 — Part A gross record: transcript proposals -> confirmed -> reviewed -> approved.
function step5(r: StepRunner, auto: boolean): StepOutcome {
  const db = r.db;
  r.clock(DEMO_STEP_CLOCK[5]);
  const h = heroIds(db);
  if (!h.partA) {
    r.note("staff", "Gross Part A", "skipped", "Run step 4 first: no accession yet.");
    return { status: "needs_presenter", message: "Run step 4 first: Part A has no accession yet." };
  }
  if (!auto) {
    return { status: "needs_presenter", message: "Nothing to simulate here: the grosser loads the synthetic transcript for Part A on the Grossing screen and confirms each value." };
  }
  const latest = () =>
    db
      .prepare("SELECT id, state, version, fields, narrative FROM gross_record WHERE specimen_part_id = ? AND state <> 'superseded' ORDER BY record_version DESC LIMIT 1")
      .get(h.partA!.id) as { id: string; state: string; version: number; fields: string; narrative: string } | undefined;

  let g = latest();
  if (g?.state === "approved_for_downstream") {
    r.note("staff", "Approve Part A gross record", "already_done");
    return { status: "ran", message: "Part A is already approved for downstream use." };
  }
  if (!g) {
    r.call("staff", `Start gross record for ${h.accession?.number ?? "the case"} part A`, "stf_dana", "gross.startDraft", { specimenPartId: h.partA.id });
    g = latest();
  }
  if (!g) {
    r.note("staff", "Gross Part A", "failed", "No gross record was created.");
    return { status: "ran", message: "Grossing did not start. See the action log." };
  }
  if (g.state === "draft" && !db.prepare("SELECT transcript_id FROM gross_record WHERE id = ? AND transcript_id IS NOT NULL").get(g.id)) {
    r.call("staff", `Load synthetic dictation "${DEMO_IDS.transcriptKey}" (deterministic demo extractor)`, "stf_dana", "gross.loadTranscript", {
      specimenPartId: h.partA.id,
      transcriptKey: DEMO_IDS.transcriptKey,
    });
    g = latest();
  }
  if (!g) return { status: "ran", message: "Gross record not found after loading the transcript." };

  if (g.state === "draft" || g.state === "needs_clarification") {
    // Confirm every proposed value (numbers, units, counts each need an explicit confirmation).
    const container = h.containerA;
    let fields = JSON.parse(g.fields) as GrossFields;
    const keys = Object.keys(fields).filter((k) => k !== "template_id") as (keyof GrossFields)[];
    for (const key of keys) {
      const v = fields[key] as GrossValue<unknown>;
      if (!v || typeof v !== "object" || v.status === "confirmed") continue;
      let value: unknown = v.value;
      if ((v.status === "missing" || value === null || value === undefined) && key === "container_label_matches" && container?.state === "verified") {
        // Derived from the recorded "staff verified against physical container" event, not invented.
        value = true;
      }
      if (value === null || value === undefined) continue;
      r.call("staff", `Confirm ${String(key).replace(/_/g, " ")}`, "stf_dana", "gross.confirmField", {
        grossRecordId: g.id,
        expectedVersion: rowVersion(db, "gross_record", g.id),
        field: key,
        value,
      });
      g = latest()!;
      fields = JSON.parse(g.fields) as GrossFields;
    }
    const blockers = grossFinalizeBlockers(fields, g.narrative ?? "");
    const requiredUnresolved = blockers.filter((b) => (REQUIRED_FOR_APPROVAL as string[]).includes(b.field) || b.field === "narrative");
    if (requiredUnresolved.length) {
      r.note("staff", "Mark operator reviewed", "skipped", `Needs operator input (not invented by the rehearsal): ${requiredUnresolved.map((b) => b.message).join("; ")}`);
      return { status: "ran", message: "Part A still has values that need the grosser's input. Open the Grossing screen." };
    }
    r.call("staff", "Mark Part A operator reviewed", "stf_dana", "gross.markReviewed", { grossRecordId: g.id, expectedVersion: rowVersion(db, "gross_record", g.id) });
    g = latest()!;
  }
  if (g.state === "operator_reviewed") {
    r.call("staff", "Approve Part A for downstream use", "stf_dana", "gross.approve", { grossRecordId: g.id, expectedVersion: rowVersion(db, "gross_record", g.id) });
  }
  return { status: "ran", message: "Part A approved for downstream use: A1 becomes eligible for processing and a source-entry task opens for Sam Ortiz. Part B stays awaiting grossing." };
}

// Step 6 — Tray with a missing slide; print job with unknown outcome (earlier case, not the hero).
function step6(r: StepRunner, auto: boolean): StepOutcome {
  const db = r.db;
  r.clock(DEMO_STEP_CLOCK[6]);
  if (!auto) {
    return { status: "needs_presenter", message: "Nothing to simulate here: scan the 9th slide and the unexpected slide on the Trays tab, then reconcile PJ-8841 on the Print jobs tab." };
  }
  const present = (() => {
    try {
      return JSON.parse(getSetting(db, "scenario_tray_present") ?? "null") as { expectedUnscanned: string; missing: string; unexpected: string } | null;
    } catch {
      return null;
    }
  })();
  const ident = (slideId: string | undefined) =>
    slideId ? ((db.prepare("SELECT identifier FROM slide WHERE id = ?").get(slideId) as { identifier: string } | undefined)?.identifier ?? null) : null;

  if (!present) {
    r.note("staff", `Tray ${DEMO_IDS.trayDisplay}`, "failed", "Scenario tray data is missing. Reset the demo data.");
  } else {
    const scanned = (slideId: string) => !!db.prepare("SELECT 1 FROM tray_scan WHERE tray_id = ? AND slide_id = ?").get(DEMO_IDS.tray, slideId);
    const ninth = ident(present.expectedUnscanned);
    if (ninth && !scanned(present.expectedUnscanned)) {
      r.call("staff", `Scan the 9th expected slide into ${DEMO_IDS.trayDisplay}`, "stf_priya", "tray.scan", { trayId: DEMO_IDS.tray, payload: ninth });
    } else {
      r.note("staff", "Scan the 9th expected slide", "already_done");
    }
    const unexpected = ident(present.unexpected);
    if (unexpected && !scanned(present.unexpected)) {
      r.call("staff", `Scan a Dr. Okafor slide that does not belong on ${DEMO_IDS.trayDisplay} (flagged unexpected)`, "stf_priya", "tray.scan", { trayId: DEMO_IDS.tray, payload: unexpected });
    } else {
      r.note("staff", "Scan the unexpected slide", "already_done");
    }
    const tray = db.prepare("SELECT status FROM tray WHERE id = ?").get(DEMO_IDS.tray) as { status: string } | undefined;
    if (tray && !["verified_complete", "released_with_exceptions", "delivered"].includes(tray.status)) {
      r.call("staff", `Try to mark ${DEMO_IDS.trayDisplay} complete (refused: 1 missing, 1 unexpected)`, "stf_priya", "tray.complete", {
        trayId: DEMO_IDS.tray,
        expectedVersion: rowVersion(db, "tray", DEMO_IDS.tray),
      }, { expectRejection: true });
      const scan = db
        .prepare("SELECT id FROM tray_scan WHERE tray_id = ? AND result = 'unexpected' AND resolution IS NULL ORDER BY scanned_at DESC LIMIT 1")
        .get(DEMO_IDS.tray) as { id: string } | undefined;
      if (scan) {
        r.call("staff", "Remove the unexpected slide from the tray (controlled resolution)", "stf_priya", "tray.resolveScan", { scanId: scan.id, resolution: "removed_from_tray" });
      }
      r.note("staff", `The 10th slide stays missing; ${DEMO_IDS.trayDisplay} is not verified complete`, "done", "Controlled options remain on screen: find and scan it, or record it as following separately with supervisor release.");
    } else {
      r.note("staff", `${DEMO_IDS.trayDisplay} status`, "already_done", tray?.status);
    }
  }

  // Print job with unknown outcome: retry refused until reconciled, then reprint with a reason.
  const pj = db.prepare("SELECT state, reconciliation FROM print_job WHERE id = ?").get(DEMO_IDS.printJob) as { state: string; reconciliation: string | null } | undefined;
  if (!pj) {
    r.note("staff", DEMO_IDS.printJobDisplay, "failed", "Scenario print job is missing. Reset the demo data.");
  } else if (pj.state === "unknown_outcome") {
    r.call("staff", `Try to reprint ${DEMO_IDS.printJobDisplay} before reconciling (refused: outcome unknown)`, "stf_priya", "print.reprint", {
      printJobId: DEMO_IDS.printJob,
      reason: "Retry attempted before reconciliation (demo rehearsal)",
    }, { expectRejection: true });
    r.call("staff", `Reconcile ${DEMO_IDS.printJobDisplay}: checked the printer, label not printed`, "stf_priya", "print.reconcile", {
      printJobId: DEMO_IDS.printJob,
      expectedVersion: rowVersion(db, "print_job", DEMO_IDS.printJob),
      outcome: "not_printed",
      note: "Checked the printer output: no label for this slide. (Demo rehearsal)",
    });
  } else {
    r.note("staff", `Reconcile ${DEMO_IDS.printJobDisplay}`, "already_done", `State: ${pj.state}`);
  }
  const reprinted = db.prepare("SELECT 1 FROM print_job WHERE reprint_of_job_id = ?").get(DEMO_IDS.printJob);
  const after = db.prepare("SELECT state, reconciliation FROM print_job WHERE id = ?").get(DEMO_IDS.printJob) as { state: string; reconciliation: string | null } | undefined;
  if (!reprinted && after && after.state !== "unknown_outcome" && after.reconciliation === "not_printed") {
    r.call("staff", `Reprint ${DEMO_IDS.printJobDisplay} with a reason (linked to the original job)`, "stf_priya", "print.reprint", {
      printJobId: DEMO_IDS.printJob,
      reason: "Not printed after simulated timeout; reprint after reconciliation. (Demo rehearsal)",
    });
  } else if (reprinted) {
    r.note("staff", `Reprint ${DEMO_IDS.printJobDisplay}`, "already_done");
  }
  return { status: "ran", message: "Tray cannot be verified complete while a slide is missing; PJ-8841 was reconciled before any reprint." };
}

// Step 7 — Retrieval: last confirmed slot; a wrong block scan is rejected.
function step7(r: StepRunner, auto: boolean): StepOutcome {
  const db = r.db;
  r.clock(DEMO_STEP_CLOCK[7]);
  if (!auto) {
    return { status: "needs_presenter", message: "Nothing to simulate here: on the Retrieval tab, scan a wrong block (D26-03909 A1) and then the requested one." };
  }
  const blockIdent = (accession: string, label: string) =>
    (db
      .prepare("SELECT b.identifier FROM block b JOIN accession a ON a.id = b.accession_id WHERE a.accession_number = ? AND b.label_text = ? LIMIT 1")
      .get(accession, label) as { identifier: string } | undefined)?.identifier ?? null;
  const wrong = blockIdent(DEMO_IDS.wrongBlockAccession, "A1");
  const alreadyMismatch = db.prepare("SELECT 1 FROM custody_event WHERE event = 'scan_mismatch' AND request_id = ?").get(DEMO_IDS.retrieval);
  if (!wrong) {
    r.note("staff", "Scan a wrong block", "failed", "Block D26-03909 A1 is missing from the seed. Reset the demo data.");
  } else if (alreadyMismatch) {
    r.note("staff", `Scan wrong block D26-03909 A1 for ${DEMO_IDS.retrievalDisplay}`, "already_done");
  } else {
    const before = db.prepare("SELECT id, status FROM retrieval_item WHERE request_id = ? ORDER BY bench_seq").all(DEMO_IDS.retrieval);
    const res = r.call<{ result?: string; match?: boolean; outcome?: string }>(
      "staff",
      `Scan wrong block D26-03909 A1 against ${DEMO_IDS.retrievalDisplay}`,
      "stf_marcus",
      "retrieval.scan",
      { requestId: DEMO_IDS.retrieval, payload: wrong },
    );
    const afterItems = db.prepare("SELECT id, status FROM retrieval_item WHERE request_id = ? ORDER BY bench_seq").all(DEMO_IDS.retrieval);
    const unchanged = JSON.stringify(before) === JSON.stringify(afterItems);
    const last = r.actions[r.actions.length - 1];
    const mismatchReported =
      !res.ok || /mismatch|reject|not_accepted|wrong/i.test(JSON.stringify(res.ok ? res.result ?? {} : res.error));
    if (last && unchanged && mismatchReported) {
      last.outcome = "rejected_as_expected";
      last.detail = `Mismatch: scanned D26-03909 A1; ${DEMO_IDS.retrievalDisplay} needs D26-03990 B1, A1 and D26-03912 A1. Nothing changed.`;
    } else if (last && !unchanged) {
      last.outcome = "failed";
      last.detail = "A wrong block scan changed the request. This should not happen.";
    }
  }
  const right = blockIdent("D26-03990", "B1");
  const picked = db.prepare("SELECT status FROM retrieval_item WHERE request_id = ? AND bench_seq = 1").get(DEMO_IDS.retrieval) as { status: string } | undefined;
  if (right && picked?.status === "pending") {
    r.call("staff", `Scan the requested block D26-03990 B1 for ${DEMO_IDS.retrievalDisplay} (pick 1 of 3)`, "stf_marcus", "retrieval.scan", { requestId: DEMO_IDS.retrieval, payload: right });
  } else if (picked) {
    r.note("staff", "Scan D26-03990 B1", "already_done", `Item status: ${picked.status}`);
  }
  return { status: "ran", message: "The wrong block was rejected and nothing changed; the requested block was matched." };
}

// Step 8 — Operations: nothing to simulate; the clock moves on so ages are visible.
function step8(r: StepRunner): StepOutcome {
  r.clock(DEMO_STEP_CLOCK[8]);
  return { status: "ran", message: "Open Operations: what is still blocked, who owns the next step, and the evidence behind each item." };
}

// ---------------------------------------------------------------- status (derived from data, not from button presses)

export interface DemoCheck {
  label: string;
  done: boolean;
  detail?: string;
}

export interface DemoStepStatus {
  step: DemoStepNumber;
  state: "done" | "in_progress" | "not_started";
  checks: DemoCheck[];
}

export interface RemainingBlocker {
  item: string;
  blockedBy: string;
  owner: string;
  since: string | null;
}

export interface DemoStatus {
  clockNow: string;
  steps: DemoStepStatus[];
  doneCount: number;
  ids: {
    intakeA: string | null;
    intakeB: string | null;
    candidate: string | null;
    clarification: string | null;
    clarificationId: string | null;
    hold: string | null;
    accession: string | null;
  };
  remainingBlockers: RemainingBlocker[];
  lastRuns: { step: number; action: string; ranAt: string; ranBy: string | null }[];
}

function stepState(checks: DemoCheck[]): DemoStepStatus["state"] {
  const n = checks.filter((c) => c.done).length;
  return n === checks.length ? "done" : n === 0 ? "not_started" : "in_progress";
}

/**
 * Which steps are done, derived from the records themselves, so the guide
 * shows progress whether the presenter used the real screens or the
 * rehearsal buttons.
 */
export function demoStatus(db: DB): DemoStatus {
  const h = heroIds(db);
  const delivery = db.prepare("SELECT arrived_at, status FROM courier_delivery WHERE id = ?").get(DEMO_IDS.delivery) as { arrived_at: string | null; status: string } | undefined;
  const physTotal = (db.prepare("SELECT COUNT(*) n FROM sim_physical_item WHERE delivery_id = ?").get(DEMO_IDS.delivery) as { n: number }).n;
  const physReceived = (db.prepare("SELECT COUNT(*) n FROM sim_physical_item WHERE delivery_id = ? AND received_intake_item_id IS NOT NULL").get(DEMO_IDS.delivery) as { n: number }).n;
  const routed = (id: string | undefined) =>
    id ? (db.prepare("SELECT status FROM routing_decision WHERE intake_item_id = ? AND status <> 'superseded'").get(id) as { status: string } | undefined)?.status ?? null : null;
  const routingA = routed(h.intakeA?.id);

  const steps: DemoStepStatus[] = [];
  // 1
  steps.push({
    step: 1,
    state: "not_started",
    checks: [
      { label: "Courier arrival recorded (CR-1014-11)", done: !!delivery?.arrived_at },
      { label: "Containers unpacked", done: physTotal > 0 && physReceived === physTotal, detail: `${physReceived} of ${physTotal} physical items received` },
      { label: "Routing suggested from the approved rule", done: !!routingA, detail: routingA ? `Part A routing: ${routingA}` : undefined },
    ],
  });
  // 2
  steps.push({
    step: 2,
    state: "not_started",
    checks: [
      { label: "Related-order candidate proposed", done: !!h.candidate, detail: h.candidate?.displayId },
      { label: "Candidate reviewed by staff (not merged)", done: !!h.candidate && h.candidate.status !== "pending_review", detail: h.candidate?.status },
    ],
  });
  // 3
  const clr = h.clarification;
  steps.push({
    step: 3,
    state: "not_started",
    checks: [
      { label: "Laterality clarification raised for Part B", done: !!clr, detail: clr?.displayId },
      { label: "Hold placed on Part B only", done: !!h.hold, detail: h.hold ? `${h.hold.displayId} (${h.hold.status})` : undefined },
      { label: "Simulated office answer received", done: !!clr && ["answered", "reviewed", "resolved"].includes(clr.state) },
      { label: "Answer reviewed, then resolved", done: !!clr && clr.state === "resolved" },
      { label: "Hold released after the amended order arrived", done: !!h.hold && h.hold.status === "released" && h.amendedOrderImported },
    ],
  });
  // 4
  steps.push({
    step: 4,
    state: "not_started",
    checks: [{ label: "Official accession issued (simulated source)", done: !!h.accession, detail: h.accession?.number }],
  });
  // 5
  const grossA = h.partA
    ? (db.prepare("SELECT state FROM gross_record WHERE specimen_part_id = ? AND state <> 'superseded' ORDER BY record_version DESC LIMIT 1").get(h.partA.id) as { state: string } | undefined)
    : undefined;
  steps.push({
    step: 5,
    state: "not_started",
    checks: [
      { label: "Part A gross record started", done: !!grossA },
      { label: "Part A approved for downstream use", done: grossA?.state === "approved_for_downstream" },
    ],
  });
  // 6
  const present = (() => {
    try {
      return JSON.parse(getSetting(db, "scenario_tray_present") ?? "null") as { expectedUnscanned: string; unexpected: string } | null;
    } catch {
      return null;
    }
  })();
  const ninthScanned = present ? !!db.prepare("SELECT 1 FROM tray_scan WHERE tray_id = ? AND slide_id = ?").get(DEMO_IDS.tray, present.expectedUnscanned) : false;
  const unexpectedScanned = !!db.prepare("SELECT 1 FROM tray_scan WHERE tray_id = ? AND result = 'unexpected'").get(DEMO_IDS.tray);
  const pj = db.prepare("SELECT state, reconciled_at FROM print_job WHERE id = ?").get(DEMO_IDS.printJob) as { state: string; reconciled_at: string | null } | undefined;
  steps.push({
    step: 6,
    state: "not_started",
    checks: [
      { label: "9th expected slide scanned", done: ninthScanned },
      { label: "Unexpected slide flagged", done: unexpectedScanned },
      { label: "PJ-8841 outcome reconciled", done: !!pj?.reconciled_at, detail: pj?.state },
    ],
  });
  // 7
  const mismatch = !!db.prepare("SELECT 1 FROM custody_event WHERE event = 'scan_mismatch' AND (request_id = ? OR note LIKE '%RR-0192%')").get(DEMO_IDS.retrieval);
  const anyPicked = !!db.prepare("SELECT 1 FROM retrieval_item WHERE request_id = ? AND status <> 'pending'").get(DEMO_IDS.retrieval);
  steps.push({
    step: 7,
    state: "not_started",
    checks: [
      { label: "Wrong block scan rejected (mismatch logged)", done: mismatch },
      { label: "Requested block matched", done: anyPicked },
    ],
  });
  // 8
  const viewed = !!db.prepare("SELECT 1 FROM demo_step_log WHERE step = 8").get();
  steps.push({
    step: 8,
    state: "not_started",
    checks: [{ label: "Operations step reached", done: viewed, detail: "Nothing changes in this step; it is a review of the Operations screen." }],
  });
  for (const s of steps) s.state = stepState(s.checks);

  const lastRuns = (
    db.prepare("SELECT step, action, ran_at AS ranAt, ran_by AS ranBy FROM demo_step_log ORDER BY id DESC LIMIT 8").all() as DemoStatus["lastRuns"]
  ).reverse();

  return {
    clockNow: readClock(db).now,
    steps,
    doneCount: steps.filter((s) => s.state === "done").length,
    ids: {
      intakeA: h.intakeA?.displayId ?? null,
      intakeB: h.intakeB?.displayId ?? null,
      candidate: h.candidate?.displayId ?? null,
      clarification: clr?.displayId ?? null,
      clarificationId: clr?.id ?? null,
      hold: h.hold?.displayId ?? null,
      accession: h.accession?.number ?? null,
    },
    remainingBlockers: remainingBlockers(db),
    lastRuns,
  };
}

const ROLE_OWNER: Record<string, string> = {
  accessioning_lead: "Accessioning lead",
  histotech: "Histotech",
  histology_assistant: "Histology assistant",
  grosser: "Grosser",
  supervisor: "Supervisor",
  accessioner: "Accessioner",
};

/**
 * What still blocks work right now, with owner and age — a compact summary for
 * the guide's step 8 (the full view is /operations). Computed from shared
 * tables only.
 */
export function remainingBlockers(db: DB): RemainingBlocker[] {
  const out: RemainingBlocker[] = [];
  const staffName = (id: string | null) =>
    id ? (db.prepare("SELECT display_name n FROM staff WHERE id = ?").get(id) as { n: string } | undefined)?.n ?? id : null;

  const holds = db
    .prepare("SELECT display_id, scope_label, reason_text, placed_at, clarification_id FROM hold WHERE status = 'active' ORDER BY placed_at")
    .all() as { display_id: string; scope_label: string; reason_text: string; placed_at: string; clarification_id: string | null }[];
  for (const hl of holds) {
    const owner = hl.clarification_id
      ? staffName((db.prepare("SELECT lab_owner_id o FROM clarification WHERE id = ?").get(hl.clarification_id) as { o: string } | undefined)?.o ?? null)
      : null;
    out.push({ item: `${hl.display_id} on ${hl.scope_label}`, blockedBy: hl.reason_text, owner: owner ?? "Accessioning lead", since: hl.placed_at });
  }
  const tasks = db
    .prepare(
      `SELECT t.title, t.kind, t.owner_id, t.owner_role, t.created_at FROM task t
        WHERE t.status IN ('open','in_progress') AND t.kind IN ('source_entry','print_reconcile','tray_exception','order_change_review','correction_review','source_conflict','clarification_followup','retrieval')
        ORDER BY t.created_at`,
    )
    .all() as { title: string; kind: string; owner_id: string | null; owner_role: string | null; created_at: string }[];
  for (const t of tasks) {
    out.push({
      item: t.title,
      blockedBy: TASK_KIND_LABEL[t.kind] ?? t.kind.replace(/_/g, " "),
      owner: staffName(t.owner_id) ?? (t.owner_role ? ROLE_OWNER[t.owner_role] ?? t.owner_role : "Unassigned"),
      since: t.created_at,
    });
  }
  const trays = db.prepare("SELECT display_id, status, opened_at, opened_by FROM tray WHERE status IN ('open','assembling','exception')").all() as {
    display_id: string; status: string; opened_at: string; opened_by: string | null;
  }[];
  for (const t of trays) {
    const expected = (db.prepare("SELECT COUNT(*) n FROM tray_expected_slide WHERE tray_id = (SELECT id FROM tray WHERE display_id = ?)").get(t.display_id) as { n: number }).n;
    const scanned = (
      db
        .prepare(
          "SELECT COUNT(DISTINCT s.slide_id) n FROM tray_scan s JOIN tray tr ON tr.id = s.tray_id JOIN tray_expected_slide e ON e.tray_id = s.tray_id AND e.slide_id = s.slide_id WHERE tr.display_id = ? AND s.result = 'verified_expected'",
        )
        .get(t.display_id) as { n: number }
    ).n;
    if (scanned < expected) {
      out.push({ item: `Tray ${t.display_id}`, blockedBy: `${expected - scanned} of ${expected} expected slides not scanned; cannot be verified complete`, owner: staffName(t.opened_by) ?? "Histotech", since: t.opened_at });
    }
  }
  return out;
}

const TASK_KIND_LABEL: Record<string, string> = {
  source_entry: "Approved gross description waiting for source-system entry",
  print_reconcile: "Print outcome unknown; reconcile before any reprint",
  tray_exception: "Tray exception to resolve",
  order_change_review: "Source order changed; review affected work",
  correction_review: "Post-accession discrepancy under review",
  source_conflict: "Source conflict to review",
  clarification_followup: "Clarification follow-up",
  retrieval: "Blocks to retrieve",
};
