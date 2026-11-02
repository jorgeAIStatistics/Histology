/**
 * Read models for /settings (S6) and the shared source-freshness helper.
 * Server-only (opens SQLite through the caller's db handle).
 */
import type { DB } from "@/server/db/db";
import { readClock } from "@/server/core/clock";
import { getSetting } from "@/server/core/settings";
import { fmtTime, fmtDateTime, labDay, labLocalToIso, minutesBetween } from "@/lib/time";

/**
 * Clarification follow-up policy shown in the contact directory. These mirror the
 * demo defaults used by the clarification slice (reminder / duplicate-suppression
 * window 30 min; first follow-up by priority). They are demo values, not clinical rules.
 */
const REMINDER_SUPPRESSION_MINUTES = 30;
const FOLLOW_UP_MINUTES: Record<string, number> = { urgent: 15, high: 30, routine: 60 };

// ------------------------------------------------------------------ freshness

/** Demo thresholds (not clinical rules): older than this is "Delayed", and stale after STALE_AFTER. */
export const DELAYED_AFTER_MINUTES = 5;
export const STALE_AFTER_MINUTES = 15;

export type FreshnessState = "current" | "delayed" | "stale" | "offline" | "unknown";

export interface SourceFreshness {
  sourceId: string;
  name: string;
  tenantId: string | null;
  tenantName: string | null;
  status: string; // connected | offline | degraded
  state: FreshnessState;
  lastSuccessAt: string | null;
  lastAttemptAt: string | null;
  lastError: string | null;
  offlineSince: string | null;
  /** Minutes since the last successful sync; null = Unknown (never synced). */
  ageMinutes: number | null;
  /** true when the source is offline OR the last successful sync is older than 15 minutes (or unknown). */
  stale: boolean;
  label: string;
  /** Messages the simulated source has ready but that have not been delivered (backlog while offline). */
  backlog: number;
}

/**
 * Per source-system adapter: is the data we show current? An outage must never
 * make an old worklist look live, so offline or old data is always `stale`.
 */
export function sourceFreshness(db: DB, nowIso?: string): SourceFreshness[] {
  const now = nowIso ?? readClock(db).now;
  const rows = db
    .prepare(
      `SELECT s.id, s.name, s.tenant_id, t.name tenant_name, s.status, s.last_success_at, s.last_attempt_at, s.last_error
         FROM integration_source s LEFT JOIN source_tenant t ON t.id = s.tenant_id
        WHERE s.adapter IN ('simulated_ema','simulated_other_ehr') ORDER BY s.id`,
    )
    .all() as {
    id: string;
    name: string;
    tenant_id: string | null;
    tenant_name: string | null;
    status: string;
    last_success_at: string | null;
    last_attempt_at: string | null;
    last_error: string | null;
  }[];
  return rows.map((r) => {
    const age = r.last_success_at ? Math.max(0, minutesBetween(r.last_success_at, now)) : null;
    const offlineSince = (getSetting(db, `s6_offline_since:${r.id}`) || null) as string | null;
    const backlog = (
      db.prepare("SELECT COUNT(*) n FROM sim_source_outbox WHERE source_id = ? AND delivered_at IS NULL AND available_at <= ?").get(r.id, now) as { n: number }
    ).n;
    const who = r.tenant_name ?? r.name;
    const last = r.last_success_at ? `${fmtTime(r.last_success_at)} ET` : "never";
    let state: FreshnessState;
    let label: string;
    if (r.status === "offline") {
      state = "offline";
      label = `${who}: unreachable since ${offlineSince ? `${fmtTime(offlineSince)} ET` : "an unknown time"} (simulated outage). Showing last confirmed data from ${last}${age !== null ? ` (${age} min old)` : ""}.`;
    } else if (age === null) {
      state = "unknown";
      label = `${who}: sync status unknown (no successful sync recorded).`;
    } else if (age > STALE_AFTER_MINUTES) {
      state = "stale";
      label = `${who}: last successful sync ${last}, ${age} min ago. Data may be out of date.`;
    } else if (age > DELAYED_AFTER_MINUTES || r.status === "degraded") {
      state = "delayed";
      label = `${who}: last sync ${last}, ${age} min ago${r.status === "degraded" ? " (simulated slow link)" : ""}.`;
    } else {
      state = "current";
      label = `${who}: synced ${last} (${age === 0 ? "just now" : `${age} min ago`}).`;
    }
    return {
      sourceId: r.id,
      name: r.name,
      tenantId: r.tenant_id,
      tenantName: r.tenant_name,
      status: r.status,
      state,
      lastSuccessAt: r.last_success_at,
      lastAttemptAt: r.last_attempt_at,
      lastError: r.last_error,
      offlineSince,
      ageMinutes: age,
      stale: r.status === "offline" || age === null || age > STALE_AFTER_MINUTES,
      label,
      backlog,
    };
  });
}

// ------------------------------------------------------------------ routing

export interface RuleRow {
  ruleId: string;
  officeId: string;
  officeName: string;
  officeCode: string;
  tenantName: string;
  pathologistId: string;
  pathologistName: string;
  pathologistColor: string | null;
}

export interface RuleSetView {
  id: string;
  version: number;
  status: "draft" | "approved" | "retired";
  discarded: boolean;
  effectiveFrom: string;
  effectiveTo: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  notes: string | null;
  inEffect: boolean;
  rules: RuleRow[];
  /** Draft only: differences against the rule set it was copied from. */
  diff?: { officeName: string; from: string | null; to: string | null }[];
  /** Draft only: the version the diff compares against (the newest approved version). */
  diffBaseVersion?: number | null;
}

export interface CoverageView {
  id: string;
  pathologistName: string;
  pathologistColor: string | null;
  coveringName: string;
  coveringColor: string | null;
  startsAt: string;
  endsAt: string;
  reason: string;
  status: string;
  approvedBy: string | null;
  activeNow: boolean;
}

export interface UnknownOfficeView {
  key: string;
  officeId: string | null;
  name: string;
  tenantName: string | null;
  officeStatus: string | null;
  reason: string;
  exceptionItems: number;
}

export interface RoutingSettings {
  now: string;
  current: RuleSetView | null;
  /** Newest approved version (may be future-dated); a new draft copies this one. */
  latestApproved: RuleSetView | null;
  draft: RuleSetView | null;
  history: RuleSetView[];
  coverage: CoverageView[];
  unknownOffices: UnknownOfficeView[];
  offices: { id: string; name: string; code: string; tenantName: string; status: string }[];
  pathologists: { id: string; name: string; color: string | null }[];
}

function rulesFor(db: DB, ruleSetId: string): RuleRow[] {
  return db
    .prepare(
      `SELECT r.id ruleId, o.id officeId, o.name officeName, o.code officeCode, t.name tenantName, s.id pathologistId, s.display_name pathologistName,
              s.color_token pathologistColor
         FROM routing_rule r JOIN office o ON o.id = r.office_id JOIN source_tenant t ON t.id = o.tenant_id JOIN staff s ON s.id = r.pathologist_id
        WHERE r.rule_set_id = ? ORDER BY o.name`,
    )
    .all(ruleSetId) as RuleRow[];
}

export function loadRoutingSettings(db: DB): RoutingSettings {
  const now = readClock(db).now;
  const sets = db.prepare("SELECT * FROM routing_rule_set ORDER BY version DESC").all() as {
    id: string;
    version: number;
    status: "draft" | "approved" | "retired";
    effective_from: string;
    effective_to: string | null;
    approved_by: string | null;
    approved_at: string | null;
    notes: string | null;
  }[];
  const staffName = (id: string | null) =>
    id ? ((db.prepare("SELECT display_name FROM staff WHERE id = ?").get(id) as { display_name: string } | undefined)?.display_name ?? id) : null;
  const views: RuleSetView[] = sets.map((s) => ({
    id: s.id,
    version: s.version,
    status: s.status,
    discarded: s.status === "retired" && !s.approved_at,
    effectiveFrom: s.effective_from,
    effectiveTo: s.effective_to,
    approvedBy: staffName(s.approved_by),
    approvedAt: s.approved_at,
    notes: s.notes,
    inEffect: s.status === "approved" && s.effective_from <= now && (!s.effective_to || s.effective_to > now),
    rules: rulesFor(db, s.id),
  }));
  const current = views.find((v) => v.inEffect) ?? null;
  const draft = views.find((v) => v.status === "draft") ?? null;
  // A draft is copied from the newest approved version (which may be future-dated), so it is compared with that.
  const draftBase = views.find((v) => v.status === "approved") ?? null;
  if (draft) {
    draft.diffBaseVersion = draftBase?.version ?? null;
    const base = new Map((draftBase?.rules ?? []).map((r) => [r.officeId, r]));
    const next = new Map(draft.rules.map((r) => [r.officeId, r]));
    const diff: NonNullable<RuleSetView["diff"]> = [];
    for (const id of new Set([...base.keys(), ...next.keys()])) {
      const a = base.get(id);
      const b = next.get(id);
      if (a?.pathologistId === b?.pathologistId) continue;
      diff.push({ officeName: (a ?? b)!.officeName, from: a?.pathologistName ?? null, to: b?.pathologistName ?? null });
    }
    draft.diff = diff;
  }

  const coverage = (
    db
      .prepare(
        `SELECT c.*, a.display_name absent_name, a.color_token absent_color, b.display_name cover_name, b.color_token cover_color
           FROM coverage_exception c JOIN staff a ON a.id = c.pathologist_id JOIN staff b ON b.id = c.covering_pathologist_id
          ORDER BY c.starts_at DESC`,
      )
      .all() as {
      id: string;
      absent_name: string;
      absent_color: string | null;
      cover_name: string;
      cover_color: string | null;
      starts_at: string;
      ends_at: string;
      reason: string;
      status: string;
      approved_by: string | null;
    }[]
  ).map((c) => ({
    id: c.id,
    pathologistName: c.absent_name,
    pathologistColor: c.absent_color,
    coveringName: c.cover_name,
    coveringColor: c.cover_color,
    startsAt: c.starts_at,
    endsAt: c.ends_at,
    reason: c.reason,
    status: c.status,
    approvedBy: staffName(c.approved_by),
    activeNow: c.status === "approved" && c.starts_at <= now && c.ends_at > now,
  }));

  const offices = db
    .prepare("SELECT o.id, o.name, o.code, t.name tenantName, o.status FROM office o JOIN source_tenant t ON t.id = o.tenant_id ORDER BY o.name")
    .all() as { id: string; name: string; code: string; tenantName: string; status: string }[];
  const covered = new Set((current?.rules ?? []).map((r) => r.officeId));
  const exceptionCount = (officeId: string | null, text: string | null) =>
    (
      db
        .prepare(
          `SELECT COUNT(*) n FROM routing_decision rd JOIN intake_item ii ON ii.id = rd.intake_item_id
            WHERE rd.status = 'exception' AND ${officeId ? "ii.office_id = ?" : "ii.office_id IS NULL AND ii.observed_office_text = ?"}`,
        )
        .get(officeId ?? text) as { n: number }
    ).n;
  const unknownOffices: UnknownOfficeView[] = offices
    .filter((o) => !covered.has(o.id))
    .map((o) => ({
      key: o.id,
      officeId: o.id,
      name: o.name,
      tenantName: o.tenantName,
      officeStatus: o.status,
      reason: o.status === "new_unreviewed" ? "New office, not yet reviewed. No approved rule." : "No approved rule in the current version.",
      exceptionItems: exceptionCount(o.id, null),
    }));
  const unmatched = db
    .prepare(
      `SELECT DISTINCT observed_office_text FROM intake_item WHERE office_id IS NULL AND observed_office_text IS NOT NULL
       UNION SELECT DISTINCT observed_office_text FROM manifest_line WHERE office_id IS NULL AND observed_office_text IS NOT NULL`,
    )
    .all() as { observed_office_text: string }[];
  for (const u of unmatched) {
    if (unknownOffices.some((x) => x.name.toLowerCase() === u.observed_office_text.toLowerCase())) continue;
    unknownOffices.push({
      key: `text:${u.observed_office_text}`,
      officeId: null,
      name: u.observed_office_text,
      tenantName: null,
      officeStatus: null,
      reason: "Name seen on a delivery or requisition; not in the office directory.",
      exceptionItems: exceptionCount(null, u.observed_office_text),
    });
  }

  const pathologists = db
    .prepare("SELECT id, display_name name, color_token color FROM staff WHERE role = 'pathologist' AND active = 1 ORDER BY display_name")
    .all() as { id: string; name: string; color: string | null }[];

  return { now, current, latestApproved: draftBase, draft, history: views, coverage, unknownOffices, offices, pathologists };
}

// ------------------------------------------------------------------ demo scenarios

export interface OutboxItem {
  id: string;
  sourceId: string;
  sourceName: string;
  messageId: string;
  messageType: string;
  availableAt: string;
  deliveredAt: string | null;
  due: boolean;
  orderId: string | null;
  version: number | null;
  note: string | null;
  /** What the importer will do with it, in plain words (predicted, not applied). */
  expectation: string;
}

export interface DemoSettings {
  now: string;
  running: boolean;
  sources: SourceFreshness[];
  outbox: OutboxItem[];
  printers: { id: string; name: string; kind: string; location: string; status: string; reportsCompletion: boolean; queuedJobs: number; unknownJobs: number }[];
  assistantMode: string;
  notifyStatus: string;
  failureArmed: Record<string, boolean>;
}

function describeOutbox(db: DB, row: { source_id: string; message_id: string; payload: string }): { orderId: string | null; version: number | null; note: string | null; expectation: string } {
  let p: { order_id?: string; version?: number; amendment_note?: string; status?: string } = {};
  try {
    p = JSON.parse(row.payload);
  } catch {
    return { orderId: null, version: null, note: null, expectation: "Payload is not valid JSON — will be recorded as failed." };
  }
  const orderId = typeof p.order_id === "string" ? p.order_id : null;
  const version = typeof p.version === "number" ? p.version : null;
  const dup = db.prepare("SELECT outcome FROM integration_event WHERE source_id = ? AND message_id = ?").get(row.source_id, row.message_id) as { outcome: string } | undefined;
  if (dup && dup.outcome !== "failed") return { orderId, version, note: p.amendment_note ?? null, expectation: "Same message id was already received — expected: duplicate ignored." };
  const tenant = (db.prepare("SELECT tenant_id FROM integration_source WHERE id = ?").get(row.source_id) as { tenant_id: string | null } | undefined)?.tenant_id;
  const stored = orderId
    ? (db.prepare("SELECT source_version FROM source_order WHERE tenant_id = ? AND source_order_id = ?").get(tenant, orderId) as { source_version: number } | undefined)
    : undefined;
  let expectation = "New order — expected: imported.";
  if (stored && version !== null) {
    expectation =
      version <= stored.source_version
        ? `Older than stored v${stored.source_version} — expected: stale, ignored.`
        : `Newer than stored v${stored.source_version} — expected: applied, affected work reconciled.`;
  }
  return { orderId, version, note: p.amendment_note ?? (p.status === "canceled" ? "Order canceled at source" : null), expectation };
}

export function loadDemoSettings(db: DB): DemoSettings {
  const clock = readClock(db);
  const sources = sourceFreshness(db, clock.now);
  const rows = db
    .prepare(
      `SELECT o.*, s.name source_name FROM sim_source_outbox o JOIN integration_source s ON s.id = o.source_id
        ORDER BY (o.delivered_at IS NULL) DESC, o.available_at, o.id`,
    )
    .all() as { id: string; source_id: string; source_name: string; message_id: string; message_type: string; available_at: string; delivered_at: string | null; payload: string }[];
  const outbox: OutboxItem[] = rows.map((r) => ({
    id: r.id,
    sourceId: r.source_id,
    sourceName: r.source_name,
    messageId: r.message_id,
    messageType: r.message_type,
    availableAt: r.available_at,
    deliveredAt: r.delivered_at,
    due: !r.delivered_at && r.available_at <= clock.now,
    ...describeOutbox(db, r),
  }));
  const printers = (
    db.prepare("SELECT id, name, kind, location, status, reports_completion FROM printer ORDER BY id").all() as {
      id: string;
      name: string;
      kind: string;
      location: string;
      status: string;
      reports_completion: number;
    }[]
  ).map((p) => ({
    id: p.id,
    name: p.name,
    kind: p.kind,
    location: p.location,
    status: p.status,
    reportsCompletion: Boolean(p.reports_completion),
    queuedJobs: (db.prepare("SELECT COUNT(*) n FROM print_job WHERE printer_id = ? AND state IN ('planned','queued')").get(p.id) as { n: number }).n,
    unknownJobs: (db.prepare("SELECT COUNT(*) n FROM print_job WHERE printer_id = ? AND state = 'unknown_outcome'").get(p.id) as { n: number }).n,
  }));
  const notify = db.prepare("SELECT status FROM integration_source WHERE id = 'src_notify'").get() as { status: string } | undefined;
  const failureArmed: Record<string, boolean> = {};
  for (const s of sources) failureArmed[s.sourceId] = getSetting(db, `s6_fail_next_import:${s.sourceId}`) === "1";
  return {
    now: clock.now,
    running: clock.running,
    sources,
    outbox,
    printers,
    assistantMode: getSetting(db, "assistant_mode") ?? "deterministic",
    notifyStatus: notify?.status ?? "unknown",
    failureArmed,
  };
}

// ------------------------------------------------------------------ integration capabilities

/** The only words used for a capability. Never "Implemented" for a connector. */
export type CapabilityWord = "Simulated" | "Documented" | "Unknown" | "Unsupported";

export const CAPABILITY_WORDS: Record<CapabilityWord, string> = {
  Simulated: "Works in this demo with a simulated connector",
  Documented: "Vendor documentation describes it (not verified here)",
  Unknown: "Not documented — to discover",
  Unsupported: "Not available",
};

export function capabilityWord(raw: string): CapabilityWord {
  const v = raw.toLowerCase();
  if (v.startsWith("not available") || v.startsWith("not applicable") || v.startsWith("unsupported")) return "Unsupported";
  if (v.includes("unknown") && !v.startsWith("simulated")) return "Unknown";
  if (v.startsWith("documented")) return "Documented";
  if (v.startsWith("simulated") || v.startsWith("deterministic") || v.startsWith("template") || v.startsWith("computed") || v.startsWith("only ")) return "Simulated";
  return "Unknown";
}

export interface ConnectorCard {
  id: string;
  name: string;
  kind: "source" | "printer" | "notifications" | "assistant";
  adapter: string;
  tenantName: string | null;
  rolloutMode: string;
  status: string;
  statusLabel: string;
  /** Derived, read only: the name without its "(simulated …)" suffix. The Integration tab says once, in its banner, that every connector is simulated. */
  plainName: string;
  /** Derived, read only: the connection state in plain words, without "(simulated)" (said once by the tab's banner). */
  stateLabel: string;
  word: CapabilityWord;
  lastSuccessAt: string | null;
  lastAttemptAt: string | null;
  lastError: string | null;
  capabilities: { capability: string; raw: string; word: CapabilityWord }[];
  freshness?: SourceFreshness;
}

export interface EventLogRow {
  key: string;
  at: string;
  sourceName: string;
  messageId: string;
  messageType: string;
  entityKey: string | null;
  version: number | null;
  outcome: string;
  detail: string | null;
  via: string;
  eventId: string | null;
}

export interface FailureRow {
  eventId: string;
  sourceName: string;
  messageId: string;
  messageType: string;
  receivedAt: string;
  detail: string | null;
  attempts: number;
  entityKey: string;
}

export interface IntegrationSettings {
  now: string;
  connectors: ConnectorCard[];
  log: EventLogRow[];
  failures: FailureRow[];
  totals: { applied: number; duplicate_ignored: number; stale_ignored: number; failed: number };
}

export function loadIntegrationSettings(db: DB): IntegrationSettings {
  const now = readClock(db).now;
  const fresh = new Map(sourceFreshness(db, now).map((f) => [f.sourceId, f]));
  const rows = db
    .prepare(
      `SELECT s.*, t.name tenant_name FROM integration_source s LEFT JOIN source_tenant t ON t.id = s.tenant_id
        ORDER BY CASE s.adapter WHEN 'simulated_ema' THEN 0 WHEN 'simulated_other_ehr' THEN 1 WHEN 'simulated_notifications' THEN 2 WHEN 'simulated_printer' THEN 3 ELSE 4 END`,
    )
    .all() as {
    id: string;
    name: string;
    adapter: string;
    tenant_name: string | null;
    rollout_mode: string;
    status: string;
    last_success_at: string | null;
    last_attempt_at: string | null;
    last_error: string | null;
    capabilities: string;
  }[];
  const connectors: ConnectorCard[] = rows.map((r) => {
    let caps: Record<string, string> = {};
    try {
      caps = JSON.parse(r.capabilities) as Record<string, string>;
    } catch {
      caps = {};
    }
    const kind: ConnectorCard["kind"] =
      r.adapter === "simulated_printer" ? "printer" : r.adapter === "simulated_notifications" ? "notifications" : r.adapter === "deterministic_assistant" ? "assistant" : "source";
    const statusLabel =
      r.status === "connected"
        ? "Connected (simulated)"
        : r.status === "offline"
          ? kind === "assistant"
            ? "Unavailable (demo control)"
            : "Unavailable (simulated outage)"
          : r.status === "degraded"
            ? "Degraded (simulated)"
            : "Unknown";
    return {
      id: r.id,
      name: r.name,
      kind,
      adapter: r.adapter,
      tenantName: r.tenant_name,
      rolloutMode: r.rollout_mode,
      status: r.status,
      statusLabel,
      plainName: r.name.replace(/\s*\((?:simulated[^)]*|deterministic demo)\)\s*$/i, ""),
      stateLabel:
        r.status === "connected" ? "Connected" : r.status === "offline" ? (kind === "assistant" ? "Unavailable" : "Offline") : r.status === "degraded" ? "Slow link" : "Unknown",
      word: "Simulated",
      lastSuccessAt: r.last_success_at,
      lastAttemptAt: r.last_attempt_at,
      lastError: r.last_error,
      capabilities: Object.entries(caps).map(([capability, raw]) => ({ capability, raw, word: capabilityWord(raw) })),
      freshness: fresh.get(r.id),
    };
  });

  // Every receipt (including duplicates and retries), plus events written without a receipt: those from
  // the seed (received before the demo starts) and those other simulators record directly — e.g. the
  // accession simulator's `accession.issued` events during the session. Provenance comes from the
  // received time and message type, never assumed.
  const seedStart = seedClockStart(db, now);
  const log = db
    .prepare(
      `SELECT * FROM (
         SELECT 'r:' || r.id AS key, r.received_at AS at, s.name AS sourceName, r.message_id AS messageId, r.message_type AS messageType,
                e.entity_key AS entityKey, e.source_version AS version, r.outcome AS outcome, r.detail AS detail, r.via AS via, r.event_id AS eventId
           FROM integration_receipt r JOIN integration_source s ON s.id = r.source_id LEFT JOIN integration_event e ON e.id = r.event_id
         UNION ALL
         SELECT 'e:' || e.id, e.received_at, s.name, e.message_id, e.message_type, e.entity_key, e.source_version, e.outcome, e.detail,
                CASE WHEN e.received_at <= @seedStart THEN 'seed' WHEN e.message_type = 'accession.issued' THEN 'accession_sim' ELSE 'direct' END,
                e.id
           FROM integration_event e JOIN integration_source s ON s.id = e.source_id
          WHERE NOT EXISTS (SELECT 1 FROM integration_receipt r WHERE r.event_id = e.id)
       ) ORDER BY at DESC, key DESC LIMIT 50`,
    )
    .all({ seedStart }) as EventLogRow[];

  const failures = db
    .prepare(
      `SELECT e.id eventId, s.name sourceName, e.message_id messageId, e.message_type messageType, e.received_at receivedAt, e.detail, e.entity_key entityKey,
              (SELECT COUNT(*) FROM integration_receipt r WHERE r.event_id = e.id) attempts
         FROM integration_event e JOIN integration_source s ON s.id = e.source_id WHERE e.outcome = 'failed' ORDER BY e.received_at DESC`,
    )
    .all() as FailureRow[];

  // Every receipt counts once. A seeded event has no receipt for its first delivery, so it counts by its own
  // outcome until a receipt for that delivery exists; a later duplicate receipt does not replace it.
  const totalsRows = db
    .prepare(
      `SELECT outcome, COUNT(*) n FROM (
         SELECT outcome FROM integration_receipt
         UNION ALL SELECT e.outcome FROM integration_event e
           WHERE NOT EXISTS (SELECT 1 FROM integration_receipt r WHERE r.event_id = e.id AND r.outcome <> 'duplicate_ignored')
       ) GROUP BY outcome`,
    )
    .all() as { outcome: string; n: number }[];
  const totals = { applied: 0, duplicate_ignored: 0, stale_ignored: 0, failed: 0 };
  for (const t of totalsRows) if (t.outcome in totals) totals[t.outcome as keyof typeof totals] = t.n;

  return { now, connectors, log, failures, totals };
}

/**
 * The demo's starting time (the seed sets the clock to 10:52 ET on the demo day). Events received at or
 * before it were written by the seed; later ones happened during this session.
 */
export const SEED_CLOCK_START_LOCAL = "10:52";
export function seedClockStart(db: DB, now: string): string {
  const day = getSetting(db, "demo_day") || labDay(now);
  return labLocalToIso(day, SEED_CLOCK_START_LOCAL);
}

/** Condensed from docs/integration-capability-matrix.md (static; checked 2026-10-14). */
export const CAPABILITY_MATRIX_SUMMARY: {
  field: string;
  /** One of the four capability words only. Partial documentation is "Documented" with the gaps in `unknowns`. */
  documented: CapabilityWord;
  unknowns: string;
  candidate: string;
  fallback: string;
}[] = [
  { field: "Patient reference", documented: "Documented", unknowns: "One tenant for all offices? Which identifiers are printed on bottles?", candidate: "FHIR read / proprietary API read", fallback: "Accessioner checks two identifiers on the container" },
  { field: "Encounter / collection event", documented: "Documented", unknowns: "Is the occurrence time the collection time? Do separate A/B orders share an encounter?", candidate: "FHIR / proprietary API read", fallback: "From the requisition; otherwise shown as Unknown" },
  { field: "Source order + versions", documented: "Documented", unknowns: "Version history (only last-updated is documented); status value sets differ", candidate: "Proprietary API read (order search), FHIR read, HL7 copy feed", fallback: "Accessioner records the order reference" },
  { field: "Part / site / laterality / procedure", documented: "Documented", unknowns: "Only partly documented: no separate laterality, part-letter or biopsy-method field", candidate: "Proprietary API read + bench observation", fallback: "Typed observation of bottle and requisition" },
  { field: "Accession number + namespace", documented: "Unknown", unknowns: "Can any interface expose it, its prefix and assignment time?", candidate: "To confirm with the vendor; export or manual attestation", fallback: "Manual (scan/type after EMA assigns it)" },
  { field: "Cassette / block / slide IDs", documented: "Unknown", unknowns: "Do block/slide records exist as readable data?", candidate: "Export / manual scan", fallback: "Manual" },
  { field: "Gross description text (write)", documented: "Unknown", unknowns: "Any supported write path and its acknowledgement semantics", candidate: "None in modes A–C; manual attestation", fallback: "Current manual entry in EMA" },
  { field: "Stain / work orders incl. PAS", documented: "Unknown", unknowns: "Where PAS is ordered and at which level", candidate: "Export / manual entry with originating reference", fallback: "Paper table during transition" },
  { field: "Pathologist assignment", documented: "Documented", unknowns: "Only partly documented: stored as data or implied by accession sequence?", candidate: "Local versioned rule table + manual confirmation", fallback: "Documented rule table" },
  { field: "Clarifications to offices", documented: "Documented", unknowns: "Only partly documented: can a lab task reach another office or tenant? Who is notified?", candidate: "Local record; a vendor task resource is a mode D candidate", fallback: "Phone per the contact directory" },
  { field: "Notifications", documented: "Unknown", unknowns: "Approved channels; will offices act on them?", candidate: "Simulated in mode A; later an approved generic channel", fallback: "Phone per the directory" },
  { field: "Printer control", documented: "Unknown", unknowns: "Printer models, drivers, what status they report", candidate: "Simulated in modes A–C", fallback: "Current printing method" },
  { field: "Cancellations / amendments", documented: "Documented", unknowns: "Only partly documented: which status values occur; amend in place or new id?", candidate: "Read status + last-updated on each poll", fallback: "Manual notice from the office" },
  { field: "Change events (no events vs unavailable)", documented: "Unknown", unknowns: "Push events not documented; time precision of last-updated filter", candidate: "Polling adapter with cursor + overlap window", fallback: "Data-age banner; printed snapshot with generation time" },
];

export const ROLLOUT_MODES: { mode: "A" | "B" | "C" | "D"; name: string; data: string; connectors: string; gate: string }[] = [
  { mode: "A", name: "Local demonstration", data: "Generated synthetic data only", connectors: "Source, notifications, printer and AI all simulated and labeled", gate: "None (local repository)" },
  { mode: "B", name: "Approved shadow evaluation", data: "Selected source data through an approved export or supported read interface", connectors: "Read-only. No notifications. No printer.", gate: "Read approval, data agreement, defined scope and time limit, mapping review" },
  { mode: "C", name: "Small live operational pilot", data: "Validated field mapping for one office/team or one station", connectors: "Read-only source; an approved notification channel if agreed", gate: "Local approval, office agreement, training, documented fallback" },
  { mode: "D", name: "Selective supported writeback / printer control", data: "As C, plus specific reviewed write or device actions", connectors: "Only reviewed actions; writes count only once the source acknowledges them", gate: "Per-action write approval, sandbox testing, rollback plan" },
];

// ------------------------------------------------------------------ office contacts

export interface ContactView {
  id: string;
  name: string;
  role: string;
  /** Clarification categories this contact covers; empty = all categories. */
  categories: string[];
  channel: string;
  channelLabel: string;
  /** Derived, read only: the channel without "(simulated)"; the Contacts tab says once that every channel is simulated. */
  channelName: string;
  isPrimary: boolean;
  isEscalation: boolean;
  outUntil: string | null;
  isOutNow: boolean;
  backupId: string | null;
  backupName: string | null;
  version: number;
  unverified: boolean;
}

export interface OfficeContactsView {
  officeId: string;
  officeName: string;
  officeCode: string;
  tenantName: string;
  officeStatus: string;
  /** null = working hours not on file (Unknown), never shown as "closed". */
  workingHours: { day: string; hours: string }[] | null;
  contacts: ContactView[];
  /**
   * Who a new clarification (any category) would go to right now, using the same selection as the clarification
   * slice: escalation contacts are kept apart, the primary of the regular contacts (or the first regular contact
   * when none is flagged primary), and the backup while the primary is out. null = no available contact.
   */
  routesTo: string | null;
  coverageGap: string | null;
  /** Derived: true when the gap note only says a backup is covering (nothing is uncovered). */
  coverageCovered: boolean;
}

export interface ContactsSettings {
  now: string;
  reminderMinutes: number;
  suppressionMinutes: number;
  followUpMinutes: Record<string, number>;
  offices: OfficeContactsView[];
}

const CHANNEL_LABEL: Record<string, string> = {
  simulated_ema_message: "EMA message (simulated)",
  simulated_portal: "Office portal (simulated)",
  simulated_phone: "Phone (simulated)",
};
const CHANNEL_NAME: Record<string, string> = {
  simulated_ema_message: "EMA message",
  simulated_portal: "Office portal",
  simulated_phone: "Phone",
};
function parseCategories(json: string | null): string[] {
  try {
    const v = JSON.parse(json ?? "[]") as unknown;
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

const DAYS: [string, string][] = [["mon", "Mon"], ["tue", "Tue"], ["wed", "Wed"], ["thu", "Thu"], ["fri", "Fri"], ["sat", "Sat"], ["sun", "Sun"]];

export function loadContactsSettings(db: DB): ContactsSettings {
  const now = readClock(db).now;
  const offices = db
    .prepare("SELECT o.id, o.name, o.code, o.status, o.working_hours, t.name tenant_name FROM office o JOIN source_tenant t ON t.id = o.tenant_id ORDER BY o.name")
    .all() as { id: string; name: string; code: string; status: string; working_hours: string; tenant_name: string }[];
  const contacts = db
    .prepare(
      `SELECT c.*, b.display_name backup_name, COALESCE(r.version, 1) rev
         FROM office_contact c LEFT JOIN office_contact b ON b.id = c.backup_contact_id LEFT JOIN office_contact_revision r ON r.contact_id = c.id
        ORDER BY c.is_primary DESC, c.is_escalation, c.display_name`,
    )
    .all() as {
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
    backup_name: string | null;
    rev: number;
  }[];
  return {
    now,
    reminderMinutes: REMINDER_SUPPRESSION_MINUTES,
    suppressionMinutes: REMINDER_SUPPRESSION_MINUTES,
    followUpMinutes: { ...FOLLOW_UP_MINUTES },
    offices: offices.map((o) => {
      let hours: Record<string, [string, string][]> | null = null;
      try {
        const parsed = JSON.parse(o.working_hours) as unknown;
        hours = parsed && typeof parsed === "object" && !Array.isArray(parsed) && Object.keys(parsed).length ? (parsed as Record<string, [string, string][]>) : null;
      } catch {
        hours = null;
      }
      const list: ContactView[] = contacts
        .filter((c) => c.office_id === o.id)
        .map((c) => ({
          id: c.id,
          name: c.display_name,
          role: c.contact_role,
          categories: parseCategories(c.covers_categories),
          channel: c.channel,
          channelLabel: CHANNEL_LABEL[c.channel] ?? `${c.channel} (simulated)`,
          channelName: CHANNEL_NAME[c.channel] ?? c.channel.replace(/^simulated_/, "").replace(/_/g, " "),
          isPrimary: Boolean(c.is_primary),
          isEscalation: Boolean(c.is_escalation),
          outUntil: c.out_until,
          isOutNow: Boolean(c.out_until && c.out_until > now),
          backupId: c.backup_contact_id,
          backupName: c.backup_name,
          version: c.rev,
          unverified: /unverified|not yet on file/i.test(`${c.display_name} ${c.contact_role}`),
        }));
      // Same order and rules as the clarification slice's contact selection (primary first, then id).
      const ordered = [...list].sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      const regular = ordered.filter((c) => !c.isEscalation && c.categories.length === 0);
      const primary = regular.find((c) => c.isPrimary) ?? regular[0] ?? null;
      const limited = ordered.filter((c) => !c.isEscalation && c.categories.length > 0);
      let routesTo: string | null = null;
      let coverageGap: string | null = null;
      let coverageCovered = false;
      if (!primary) {
        coverageGap = limited.length
          ? `No contact covers every category; only ${limited.map((c) => `${c.name} (${c.categories.join(", ")})`).join(", ")}.`
          : "No office contact on file.";
      } else if (!primary.isOutNow) {
        routesTo = primary.name;
        if (!primary.isPrimary) coverageGap = `No contact is flagged primary; ${primary.name} receives clarifications.`;
      } else {
        const backup = list.find((c) => c.id === primary.backupId);
        if (backup && !backup.isOutNow) {
          routesTo = backup.name;
          coverageGap = `${primary.name} is out until ${fmtDateTime(primary.outUntil)} ET; backup ${backup.name} covers.`;
          coverageCovered = true;
        } else coverageGap = `${primary.name} is out until ${fmtDateTime(primary.outUntil)} ET and no available backup is on file.`;
      }
      const h = hours;
      return {
        officeId: o.id,
        officeName: o.name,
        officeCode: o.code,
        tenantName: o.tenant_name,
        officeStatus: o.status,
        workingHours: h ? DAYS.map(([k, label]) => ({ day: label, hours: (h[k] ?? []).map(([a, b]) => `${a}–${b}`).join(", ") || "Closed" })) : null,
        contacts: list,
        routesTo,
        coverageGap,
        coverageCovered,
      };
    }),
  };
}
