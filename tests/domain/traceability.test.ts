import { afterEach, beforeEach, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase, type DB } from "@/server/db/db";
import { seedDemo } from "@/server/seed/seed";
import { executeCommand, type CommandResult } from "@/server/commands";
import { makeCtx, SYSTEM_ACTOR } from "@/server/core/context";
import { importSourceMessage } from "@/server/domain/sourceImport";
import { buildTestFixture } from "@/server/test-fixtures";
import { createSession, sessionPolicyFromEnv } from "@/server/auth/sessions";
import { linkIdentity } from "@/server/auth/admin";
import { activeAuditKey, sessionRefFor, verifyAuditChain } from "@/server/core/audit-seal";
import { runtimeMode } from "@/server/runtime-mode";
import { readClock } from "@/server/core/clock";
import type { CommandAuth } from "@/server/auth/guard";
import { all, clockAt, one, STAFF, testDb } from "../helpers";

// Stage 6 Phase C2: full traceability. A consequential command's audit event names who (actor, role), under which
// permission and session, on which record, what changed (before and after), why (reason), when (demo time and wall
// clock) and in which request (correlation id); an importer event names its source message. Synthetic data only.

interface AuditRow {
  seq: number;
  at: string;
  recorded_at: string;
  actor_id: string;
  actor_role: string;
  origin: string;
  action: string;
  entity_type: string;
  entity_id: string;
  accession_id: string | null;
  intake_item_id: string | null;
  before_json: string | null;
  after_json: string | null;
  reason: string | null;
  correlation_id: string;
  permission: string | null;
  session_ref: string | null;
  source_ref: string | null;
}
const last = (db: DB, action: string) => one<AuditRow>(db, "SELECT * FROM audit_event WHERE action = ? ORDER BY seq DESC LIMIT 1", action);
const ofRequest = (db: DB, correlationId: string) => all<AuditRow>(db, "SELECT * FROM audit_event WHERE correlation_id = ? ORDER BY seq", correlationId);

const DELIVERY = "cr_1100";
const REASON = "Dr. Marsh at capacity today (synthetic)";
const PUBLIC = "http://localhost:3999";
const IDP = "https://idp.synthetic.test";
const ENV_KEYS = [
  "HLOS_MODE", "HLOS_OIDC_ISSUER", "HLOS_OIDC_ALLOW_INSECURE_LOOPBACK", "HLOS_OIDC_CLIENT_ID", "HLOS_OIDC_CLIENT_SECRET", "HLOS_PUBLIC_URL",
  "HLOS_LAB_ID", "HLOS_SESSION_SECRET", "HLOS_AUDIT_KEY", "HLOS_AUDIT_KEY_ID", "HLOS_DB_PATH",
];
const saved: Record<string, string | undefined> = {};
let tmp = "";

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hlos-trace-"));
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

function secured(): void {
  Object.assign(process.env, {
    HLOS_MODE: "secured",
    HLOS_OIDC_ISSUER: "http://127.0.0.1:9/nothing-listens-here",
    HLOS_OIDC_ALLOW_INSECURE_LOOPBACK: "1",
    HLOS_OIDC_CLIENT_ID: "hlos-test-client",
    HLOS_OIDC_CLIENT_SECRET: crypto.randomBytes(24).toString("hex"),
    HLOS_PUBLIC_URL: PUBLIC,
    HLOS_LAB_ID: "lab:local",
    HLOS_SESSION_SECRET: crypto.randomBytes(32).toString("hex"),
    HLOS_AUDIT_KEY: crypto.randomBytes(32).toString("hex"),
  });
  expect(runtimeMode()).toBe("secured");
}

/** A linked identity and a fresh session (the post-validation half of sign-in): what executeCommand gets from the guard. */
function signIn(db: DB, staffId: string): CommandAuth & { cookie: string } {
  linkIdentity(db, { operator: "test", correlationId: "trace-link" }, { staffId, issuer: IDP, subject: `sub-${staffId}`, labId: "lab:local" });
  const now = Date.now();
  const s = createSession(db, { staffId, labId: "lab:local", issuer: IDP, subject: `sub-${staffId}`, authTimeMs: now }, sessionPolicyFromEnv()!, now);
  return { sessionIdHash: s.idHash, staffId, authTime: new Date(now).toISOString(), cookie: s.cookieValue };
}

function mustOk<R>(res: CommandResult<R>): R {
  if (!res.ok) throw new Error(`${res.error.code}: ${res.error.message}`);
  return res.result;
}

/** A new intake item routed by rule (phys_castillo -> Dr. Marsh), ready for a lead's override. */
function routedItem(db: DB, auth: CommandAuth | null): { intakeItemId: string; decisionId: string } {
  clockAt(db, "11:00");
  const opts = { auth, correlationId: "req-trace-setup" };
  mustOk(executeCommand(db, STAFF.maya, "intake.receiveDelivery", { deliveryId: DELIVERY }, opts));
  const r = mustOk(executeCommand<{ intakeItemId: string }>(db, STAFF.maya, "intake.receivePhysicalItem", { deliveryId: DELIVERY, physicalItemId: "phys_castillo" }, opts));
  const decisionId = one<{ id: string }>(db, "SELECT id FROM routing_decision WHERE intake_item_id = ? AND status <> 'superseded' ORDER BY created_at DESC LIMIT 1", r.intakeItemId).id;
  return { intakeItemId: r.intakeItemId, decisionId };
}

describe("a consequential command's audit event carries the whole story (secured mode)", () => {
  it("routing.override: actor and role, permission, session reference, intake reference, before and after, reason, times, correlation id", () => {
    secured();
    const file = path.join(tmp, "secured.db");
    const db = openDatabase(file);
    seedDemo(db, { clockRunning: false });
    try {
      const maya = signIn(db, STAFF.maya);
      const kim = signIn(db, STAFF.kim);
      const { intakeItemId, decisionId } = routedItem(db, maya);

      const wallBefore = Date.now();
      mustOk(
        executeCommand(db, STAFF.kim, "routing.override", { intakeItemId, pathologistId: STAFF.okafor, reason: REASON, expectedDecisionId: decisionId }, {
          auth: kim,
          correlationId: "req-trace-0001",
          idempotencyKey: "trace-key-0001",
        }),
      );
      const row = last(db, "routing.overridden");
      expect(row).toMatchObject({
        actor_id: STAFF.kim,
        actor_role: "accessioning_lead",
        origin: "user",
        permission: "routing.override",
        session_ref: sessionRefFor(kim.sessionIdHash),
        intake_item_id: intakeItemId,
        reason: REASON,
        correlation_id: "req-trace-0001",
        at: readClock(db).now, // the demo clock at the time of the command
        source_ref: null,
      });
      expect(JSON.parse(row.before_json!)).toEqual({ status: expect.any(String), pathologist: STAFF.marsh });
      expect(JSON.parse(row.after_json!)).toEqual({ status: "overridden", pathologist: STAFF.okafor });
      expect(Date.parse(row.recorded_at)).toBeGreaterThanOrEqual(wallBefore - 1000);
      expect(Date.parse(row.recorded_at)).toBeLessThanOrEqual(Date.now() + 1000);

      // The session reference: 16 hex characters, keyed by the audit key; never the session id or its stored hash.
      expect(row.session_ref).toMatch(/^[0-9a-f]{16}$/);
      expect(kim.sessionIdHash).not.toContain(row.session_ref!);
      expect(row.session_ref).toBe(crypto.createHmac("sha256", activeAuditKey()!.key).update(kim.sessionIdHash).digest("hex").slice(0, 16));
      const everything = JSON.stringify(all(db, "SELECT * FROM audit_event"));
      for (const secret of [kim.cookie, kim.sessionIdHash, maya.cookie, maya.sessionIdHash]) expect(everything).not.toContain(secret);

      // Every event of that request carries the same permission and session; maya's events carry hers.
      const events = ofRequest(db, "req-trace-0001");
      expect(events.length).toBeGreaterThan(0);
      for (const e of events) expect([e.permission, e.session_ref, e.actor_id]).toEqual(["routing.override", row.session_ref, STAFF.kim]);
      const setup = ofRequest(db, "req-trace-setup");
      expect(new Set(setup.map((e) => e.session_ref))).toEqual(new Set([sessionRefFor(maya.sessionIdHash)]));
      expect(sessionRefFor(maya.sessionIdHash)).not.toBe(row.session_ref);
      expect(new Set(setup.map((e) => e.permission))).toEqual(new Set(["intake.receive"]));

      // The receipt of that request and the event share the correlation id; the event is sealed and the chain holds.
      expect(one<{ correlation_id: string }>(db, "SELECT correlation_id FROM command_receipt WHERE idempotency_key = 'trace-key-0001'").correlation_id).toBe("req-trace-0001");
      expect(one<{ n: number }>(db, "SELECT COUNT(*) n FROM audit_seal WHERE seq = ? AND event_id = (SELECT id FROM audit_event WHERE seq = ?)", row.seq, row.seq).n).toBe(1);
      expect(verifyAuditChain(db, { key: activeAuditKey()! }).ok).toBe(true);
    } finally {
      db.close();
    }
  });

  it("a refused attempt is traced the same way: who tried, under which session, which permission they lacked", () => {
    secured();
    const db = openDatabase(path.join(tmp, "denied.db"));
    seedDemo(db, { clockRunning: false });
    try {
      const maya = signIn(db, STAFF.maya);
      const { intakeItemId, decisionId } = routedItem(db, maya);
      const res = executeCommand(db, STAFF.maya, "routing.override", { intakeItemId, pathologistId: STAFF.okafor, reason: REASON, expectedDecisionId: decisionId }, {
        auth: maya,
        correlationId: "req-trace-denied",
      });
      expect(!res.ok && res.error.code).toBe("FORBIDDEN");
      expect(ofRequest(db, "req-trace-denied")).toEqual([
        expect.objectContaining({ action: "command.denied", entity_id: "routing.override", actor_id: STAFF.maya, actor_role: "accessioner", permission: "routing.override", session_ref: sessionRefFor(maya.sessionIdHash) }),
      ]);
    } finally {
      db.close();
    }
  });

  it("an import retried by a supervisor carries the supervisor's permission and session AND the source message", () => {
    secured();
    const db = openDatabase(path.join(tmp, "retry.db"));
    seedDemo(db, { clockRunning: false });
    try {
      const tanya = signIn(db, STAFF.tanya);
      const failed = importSourceMessage(makeCtx(db, SYSTEM_ACTOR, "import", "trace-import-bad"), "src_ema", { messageId: "MSG-TRACE-BAD-1", messageType: "order.upsert", payload: "{not json" });
      expect(failed.outcome).toBe("failed");
      mustOk(executeCommand(db, STAFF.tanya, "integration.retryEvent", { eventId: failed.eventId }, { auth: tanya, correlationId: "req-trace-retry" }));
      const rows = ofRequest(db, "req-trace-retry");
      const retried = rows.find((r) => r.action === "integration.import_failed")!;
      expect(retried).toMatchObject({ origin: "import", actor_id: STAFF.tanya, permission: "integration.manage", session_ref: sessionRefFor(tanya.sessionIdHash), source_ref: "src_ema:MSG-TRACE-BAD-1:v?" });
    } finally {
      db.close();
    }
  });
});

describe("demo mode", () => {
  it("the same command records the permission; there is no session, so no session reference", () => {
    const db = testDb();
    const { intakeItemId, decisionId } = routedItem(db, null);
    mustOk(executeCommand(db, STAFF.kim, "routing.override", { intakeItemId, pathologistId: STAFF.okafor, reason: REASON, expectedDecisionId: decisionId }, { correlationId: "req-demo-0001" }));
    expect(last(db, "routing.overridden")).toMatchObject({ actor_id: STAFF.kim, permission: "routing.override", session_ref: null, reason: REASON, intake_item_id: intakeItemId, correlation_id: "req-demo-0001" });
    // Events written outside a command (the seed, the simulators) have no permission or session.
    expect(one<{ permission: string | null; session_ref: string | null }>(db, "SELECT permission, session_ref FROM audit_event WHERE correlation_id = 'seed' LIMIT 1")).toEqual({ permission: null, session_ref: null });
  });
});

describe("importer events carry source_ref = <sourceId>:<messageId>:v<version>", () => {
  it("a new order, an amendment (and its order-level review), a duplicate, a stale version and a failure", () => {
    const db = testDb();
    const ctx = (c: string) => makeCtx(db, SYSTEM_ACTOR, "import", c);

    const created = buildTestFixture(db, "source-conflict-patient");
    expect(importSourceMessage(ctx("trace-new"), created.sourceId, created.message).outcome).toBe("applied");
    const newRef = `${created.sourceId}:${created.message.messageId}:v${created.message.payload.version}`;
    expect(newRef).toBe("src_ema:fixture/source-conflict-patient/ORD-77990#v1:v1");
    expect(last(db, "integration.order_imported")).toMatchObject({ origin: "import", source_ref: newRef, correlation_id: "trace-new" });

    const amend = buildTestFixture(db, "source-conflict-order-amend");
    expect(importSourceMessage(ctx("trace-amend"), amend.sourceId, amend.message).outcome).toBe("applied");
    const amendRef = `${amend.sourceId}:${amend.message.messageId}:v2`;
    expect(last(db, "integration.order_amended")).toMatchObject({ source_ref: amendRef, entity_type: "source_order" });
    expect(last(db, "integration.order_level_change_review")).toMatchObject({ source_ref: amendRef });

    // The same message again: ignored as a duplicate, still traced to it (the stored version).
    expect(importSourceMessage(ctx("trace-dup"), amend.sourceId, amend.message).outcome).toBe("duplicate_ignored");
    expect(last(db, "integration.duplicate_ignored")).toMatchObject({ source_ref: amendRef, correlation_id: "trace-dup" });

    // Version 1 again under a new message id: stale, traced to that message and its version.
    const stale = { ...amend.message, messageId: "MSG-TRACE-STALE-1", payload: { ...amend.message.payload, version: 1 } };
    expect(importSourceMessage(ctx("trace-stale"), amend.sourceId, stale).outcome).toBe("stale_ignored");
    expect(last(db, "integration.stale_ignored")).toMatchObject({ source_ref: `${amend.sourceId}:MSG-TRACE-STALE-1:v1` });

    // Unreadable payload: the version is unknown, and says so.
    expect(importSourceMessage(ctx("trace-bad"), "src_ema", { messageId: "MSG-TRACE-BAD-2", messageType: "order.upsert", payload: "{not json" }).outcome).toBe("failed");
    expect(last(db, "integration.import_failed")).toMatchObject({ source_ref: "src_ema:MSG-TRACE-BAD-2:v?" });

    // Commands never set source_ref; every row stays sealed.
    expect(one<{ n: number }>(db, "SELECT COUNT(*) n FROM audit_event WHERE source_ref IS NOT NULL AND origin NOT IN ('import')").n).toBe(0);
    expect(verifyAuditChain(db, { key: activeAuditKey()! }).ok).toBe(true);
  });
});
