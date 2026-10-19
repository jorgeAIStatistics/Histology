// Stage 6 Phases C4 and C5: privacy minimisation on the screens that do not identify specimens (Operations,
// Insights, the audit report), the controlled CSV export, transport security checks (https public URL, Secure
// cookies, HSTS), weak or reused secrets refused in secured mode, and server error responses that never echo the
// request or a stack trace. Synthetic data only; no network beyond a loopback discard port that fails at once.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

// next/headers outside a request (the route modules import the guard, which uses it for pages).
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, has: () => false }),
  headers: async () => new Headers(),
}));

import { closeSharedDb, getDb, openDatabase, type DB } from "@/server/db/db";
import { seedDemo } from "@/server/seed/seed";
import "@/server/commands";
import { defineCommand, executeCommand } from "@/server/commands/registry";
import { testDb, must, all, one, STAFF } from "../helpers";
import { importSourceMessage } from "@/server/domain/sourceImport";
import { makeCtx, SYSTEM_ACTOR, loadActor } from "@/server/core/context";
import { labLocalToIso } from "@/lib/time";
import { getOperations } from "@/server/queries/operations";
import { getInsights } from "@/server/queries/insights";
import { intakeBench } from "@/server/queries/intake";
import { auditReport, buildEvidence, demoAuditKey } from "@/server/core/audit-seal";
import { authConfig, sessionCookieName, transactionCookieName, weakSecret } from "@/server/auth/config";
import { serializeCookie } from "@/server/auth/cookies";
import { handleLogout } from "@/server/auth/flow";
import { lockedReason, runtimeMode } from "@/server/runtime-mode";
import { CSV_CONTROL_NOTICE, exportWorklistCsv } from "@/app/api/worklist/export/export-csv";
import { POST as exportPOST } from "@/app/api/worklist/export/route";
import { POST as commandPOST } from "@/app/api/commands/[name]/route";
import { getWorklist } from "@/server/queries/worklist";

const at = (hhmm: string) => labLocalToIso("2026-10-14", hhmm);
const ver = (db: DB, table: string, id: string) => one<{ version: number }>(db, `SELECT version FROM ${table} WHERE id = ?`, id).version;
const importCtx = (db: DB) => makeCtx(db, SYSTEM_ACTOR, "import", `privacy-${crypto.randomUUID()}`);
function orderPayload(db: DB, srcOrderId: string, version: number): Record<string, any> {
  const row = one<{ payload: string }>(
    db, "SELECT v.payload FROM source_order_version v JOIN source_order o ON o.id = v.source_order_id WHERE o.source_order_id = ? AND v.source_version = ?", srcOrderId, version,
  );
  return JSON.parse(row.payload);
}

// ------------------------------------------------------------------ C4.3 screens: Operations, Insights, the audit report

/**
 * Open work that quotes identifiers in its free text: an identity hold whose reason quotes both birth dates, a staff hold
 * whose scope label and reason name the patient, an identity clarification about to be reviewed, and two OPEN
 * source-conflict reviews whose task titles quote names, birth dates and MRNs (Theo Barnes, ORD-77118).
 */
function openIdentityWork(): { db: DB; item: string } {
  const db = testDb();
  must(db, STAFF.tanya, "demo.runStep", { step: 1, autoStaffActions: true });
  const item = one<{ id: string }>(
    db, "SELECT ii.id FROM intake_item ii JOIN intake_order_link l ON l.intake_item_id = ii.id JOIN source_order so ON so.id = l.source_order_id WHERE so.source_order_id = 'ORD-77118'",
  ).id;
  const c = one<{ id: string; version: number; order_part_id: string }>(db, "SELECT id, version, order_part_id FROM container WHERE intake_item_id = ? ORDER BY seq LIMIT 1", item);
  must(db, STAFF.maya, "intake.recordObservation", { containerId: c.id, expectedVersion: c.version, observed: { birth_date: "1972-04-16", mrn: "447902" } });
  must(db, STAFF.maya, "intake.verifyContainer", { containerId: c.id, expectedVersion: ver(db, "container", c.id), orderPartId: c.order_part_id });
  const clr = must<{ clarificationId: string }>(db, STAFF.maya, "clarification.create", {
    category: "identity_conflict", refs: { intakeItemId: item, orderPartId: c.order_part_id, containerId: c.id }, subjectLabel: "Barnes, Theo · Part A · ORD-77118", priority: "urgent",
    question: "Please confirm the date of birth.",
    evidence: [{ field: "Date of birth", order_value: "1972-06-14", observed_value: "1972-04-16", source: "bottle label" }],
    hold: { scope: { type: "intake_item", id: item }, scopeLabel: "INT (all containers) · ORD-77118", blocks: ["accession_request"] },
  });
  must(db, STAFF.maya, "clarification.send", { clarificationId: clr.clarificationId, expectedVersion: ver(db, "clarification", clr.clarificationId) });
  must(db, STAFF.maya, "clarification.recordAnswer", { clarificationId: clr.clarificationId, answerText: "Synthetic answer.", answeredBy: "Office", channel: "phone_recorded_by_staff" });
  // A hold typed by a person, naming the patient in its scope label and reason.
  must(db, STAFF.kim, "hold.place", { scope: { type: "intake_item", id: item }, scopeLabel: "Theo Barnes bottle", blocks: ["accession_request"], reasonText: "Check MRN 447902 for Theo Barnes (DOB 06/14/1972)" });
  const v1 = orderPayload(db, "ORD-77118", 1);
  importSourceMessage(importCtx(db), "src_ema", { messageId: "ORD-77990#v1", messageType: "order.upsert", payload: { ...v1, order_id: "ORD-77990", patient: { ...v1.patient, name: "Barnes, Theodore", birth_date: "1901-01-01" } } });
  importSourceMessage(importCtx(db), "src_ema", { messageId: "ORD-77118#v2", messageType: "order.upsert", payload: { ...v1, version: 2, updated_at: at("11:59"), patient: { ...v1.patient, mrn: "999123", birth_date: "1972-06-15" } } });
  return { db, item };
}

/** Every identifier the open work above quotes somewhere. */
const BARNES = [/Barnes/i, /\bTheo\b/i, /Theodore/i, /1972-06-14/, /06\/14\/1972/, /1972-04-16/, /1972-06-15/, /1901-01-01/, /447902/, /999123/];

function patientIdentifiersIn(db: DB, text: string): string[] {
  const found = BARNES.filter((re) => re.test(text)).map(String);
  for (const p of all<{ family_name: string; given_name: string; birth_date: string; source_mrn: string }>(db, "SELECT family_name, given_name, birth_date, source_mrn FROM patient_ref")) {
    if (text.includes(`${p.family_name}, ${p.given_name}`) || text.includes(`${p.given_name} ${p.family_name}`)) found.push(`name of ${p.source_mrn}`);
    if (text.includes(p.birth_date)) found.push(`birth date of ${p.source_mrn}`);
    if (new RegExp(`(?<![0-9])${p.source_mrn}(?![0-9])`).test(text)) found.push(`MRN ${p.source_mrn}`);
  }
  return found;
}

describe("C4.3 Operations, Insights and the audit report show no patient names, birth dates or MRNs", () => {
  let s: { db: DB; item: string };
  beforeAll(() => {
    s = openIdentityWork();
  });

  it("Operations: hold reasons, scope labels, subjects and task titles are shown with case, intake, hold and clarification references instead", () => {
    const ops = getOperations(s.db);
    const text = JSON.stringify(ops);
    expect(patientIdentifiersIn(s.db, text)).toEqual([]);
    // The rows are still there, with their references and readable reasons.
    const display = one<{ display_id: string }>(s.db, "SELECT display_id FROM intake_item WHERE id = ?", s.item).display_id;
    const holds = ops.blocked.filter((b) => b.category === "holds" && b.itemHref === `/intake?item=${display}`);
    expect(holds.length).toBe(2);
    const identity = holds.find((h) => h.identity)!;
    expect(identity.blocks).toMatch(/^Date of birth: order \[date of birth\], observed \[date of birth\] \(CLR-\d{4}\)\. Blocks accession request\.$/);
    const typed = holds.find((h) => h.subject === "[patient name] bottle")!;
    expect(typed.blocks).toBe("Check MRN [MRN] for [patient name] (DOB [date of birth]). Blocks accession request.");
    expect(typed.ref).toMatch(/^H-\d{4}$/);
    const conflicts = ops.blocked.filter((b) => /ORD-77990|ORD-77118 v2/.test(b.item));
    expect(conflicts.length).toBe(2);
    for (const c of conflicts) expect(c.item).toMatch(/\[(MRN|date of birth|patient name)\]/);
    // Staff names (owners) are never touched by the redaction.
    expect(text).toContain("Kim Nguyen");
    expect(ops.handoffs.lines.map((l) => l.text).join(" ")).not.toMatch(/Barnes|1901-01-01|999123/);
  });

  it("the Intake and Clarify screens keep the identifiers needed for positive identification (nothing masked there)", () => {
    const display = one<{ display_id: string }>(s.db, "SELECT display_id FROM intake_item WHERE id = ?", s.item).display_id;
    const bench = intakeBench(s.db, loadActor(s.db, STAFF.kim), { item: display });
    const text = JSON.stringify(bench.selected);
    for (const v of ["Barnes, Theo", "1972-06-14", "447902", "1972-04-16"]) expect(text).toContain(v);
  });

  it("Insights: aggregates and record references only", () => {
    const text = JSON.stringify(getInsights(s.db));
    expect(patientIdentifiersIn(s.db, text)).toEqual([]);
  });

  it("the /audit report and the evidence download (laboratory administrator and auditor) carry no patient identifier and no event content", () => {
    const report = auditReport(s.db, demoAuditKey());
    expect(report.ok).toBe(true);
    const evidence = buildEvidence(s.db, report.verification);
    const text = JSON.stringify({ report, evidence });
    expect(patientIdentifiersIn(s.db, text)).toEqual([]);
    expect(text).not.toMatch(/before_json|after_json|ORD-77|CLR-|INT-/);
  });
});

// ------------------------------------------------------------------ C4.3 CSV export; C4.2 error responses (HTTP routes, demo mode)

describe("C4.3 the CSV export and C4.2 error responses (HTTP routes)", () => {
  let dir = "";
  let template = "";
  let n = 0;
  const saved = { db: process.env.HLOS_DB_PATH, mode: process.env.HLOS_MODE };
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "hlos-privacy-"));
    template = path.join(dir, "template.db");
    const t = openDatabase(template);
    seedDemo(t, { clockRunning: false });
    const add = t.prepare("INSERT INTO staff (id, display_name, short_name, role, initials) VALUES (?, ?, ?, ?, ?)");
    add.run("stf_t_admin", "Synthetic Admin", "Admin", "lab_admin", "SA");
    add.run("stf_t_auditor", "Synthetic Auditor", "Auditor", "auditor", "SU");
    t.close();
  });
  beforeEach(() => {
    closeSharedDb();
    process.env.HLOS_MODE = "demo";
    const file = path.join(dir, `p${++n}.db`);
    fs.copyFileSync(template, file);
    process.env.HLOS_DB_PATH = file;
  });
  afterEach(() => closeSharedDb());
  afterAll(() => {
    closeSharedDb();
    if (saved.db === undefined) delete process.env.HLOS_DB_PATH;
    else process.env.HLOS_DB_PATH = saved.db;
    process.env.HLOS_MODE = saved.mode;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const exportReq = (actor: string, body: unknown) =>
    new Request("http://localhost:3999/api/worklist/export", {
      method: "POST",
      headers: { host: "localhost:3999", origin: "http://localhost:3999", "content-type": "application/json", cookie: `hlos_actor=${actor}` },
      body: JSON.stringify(body),
    });

  it("needs view.worklist (route) AND worklist.snapshot (command): the administrator and the auditor get 403 and nothing is recorded", async () => {
    const before = (getDb().prepare("SELECT COUNT(*) n FROM worklist_snapshot").get() as { n: number }).n;
    for (const actor of ["stf_t_admin", "stf_t_auditor"]) {
      const res = await exportPOST(exportReq(actor, { view: "operations", filters: {} }));
      expect(res.status, actor).toBe(403);
      expect(res.headers.get("content-type")).not.toContain("text/csv");
      expect(await res.text()).not.toMatch(/D26-|INT-/);
    }
    // The command alone refuses a role without worklist.snapshot (and records the denial, without the request).
    const denied = exportWorklistCsv(getDb(), "stf_t_admin", { view: "operations", filters: {} });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.code).toBe("FORBIDDEN");
    const d = getDb().prepare("SELECT actor_id, permission, entity_id FROM audit_event WHERE action = 'command.denied' ORDER BY seq DESC LIMIT 1").get();
    expect(d).toEqual({ actor_id: "stf_t_admin", permission: "worklist.snapshot", entity_id: "worklist.snapshot" });
    expect((getDb().prepare("SELECT COUNT(*) n FROM worklist_snapshot").get() as { n: number }).n).toBe(before);
  });

  it("is audited (worklist.snapshot: who, which version, how many rows) and the file says it is a controlled document with patient identifiers", async () => {
    const db = getDb();
    const seq = getWorklist(db, { staffId: STAFF.priya, view: "histotech" }).seq;
    const res = await exportPOST(exportReq(STAFF.priya, { view: "histotech", filters: {}, expectedSeq: seq, idempotencyKey: "privacy-csv-1" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="worklist-histotech-v\d+-SNAP-\d+\.csv"$/);
    const csv = (await res.text()).replace(/^﻿/, "");
    const lines = csv.split("\r\n");
    const firstColumns = lines.findIndex((l) => !l.startsWith("#"));
    expect(lines[firstColumns - 1]).toMatch(new RegExp(`^${CSV_CONTROL_NOTICE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} SNAP-\\d+\\.$`));
    expect(lines[firstColumns - 1]).toMatch(/^# CONTROLLED DOCUMENT: contains patient identifiers/);
    expect(lines.filter((l) => l.startsWith("# CONTROLLED DOCUMENT")).length).toBe(1);
    expect(lines[firstColumns]).toMatch(/^"Assigned dermatopathologist",/);
    const ev = db.prepare("SELECT actor_id, permission, summary, after_json FROM audit_event WHERE action = 'worklist.snapshot' ORDER BY seq DESC LIMIT 1").get() as {
      actor_id: string; permission: string; summary: string; after_json: string;
    };
    expect(ev.actor_id).toBe(STAFF.priya);
    expect(ev.permission).toBe("worklist.snapshot");
    expect(ev.summary).toMatch(/downloaded \(CSV\)/);
    expect(JSON.parse(ev.after_json)).toMatchObject({ seq, rowCount: expect.any(Number) });
  });

  it("an unexpected server error answers with a generic message and the correlation id: never the request body, the error text or a stack trace", async () => {
    defineCommand({
      name: "test.privacyBoom",
      description: "Test only: fails unexpectedly, quoting its input.",
      permission: null,
      input: z.object({ note: z.string() }),
      run: (_ctx, input) => {
        JSON.parse(`{"patient":"${input.note}"`); // a SyntaxError whose message quotes the text it read
        return null;
      },
    });
    const body = JSON.stringify({ input: { note: "Theo Barnes 1972-06-14 MRN 447902" } });
    const res = await commandPOST(
      new Request("http://localhost:3999/api/commands/test.privacyBoom", {
        method: "POST", headers: { host: "localhost:3999", origin: "http://localhost:3999", "content-type": "application/json", cookie: `hlos_actor=${STAFF.kim}` }, body,
      }),
      { params: Promise.resolve({ name: "test.privacyBoom" }) },
    );
    const text = await res.text();
    const cid = res.headers.get("x-correlation-id");
    expect(cid).toBeTruthy();
    expect(JSON.parse(text)).toEqual({
      ok: false,
      error: { code: "VALIDATION", message: `The request could not be completed because of an unexpected error on the server. Nothing was changed. Reference: ${cid}.` },
    });
    expect(text).not.toMatch(/Barnes|1972|447902|SyntaxError|JSON|\bat\s|\.ts:\d+/);
    // A body that is not JSON: refused without echoing it.
    const bad = await commandPOST(
      new Request("http://localhost:3999/api/commands/hold.place", {
        method: "POST", headers: { host: "localhost:3999", origin: "http://localhost:3999", "content-type": "application/json", cookie: `hlos_actor=${STAFF.kim}` },
        body: "{ Theo Barnes 1972-06-14",
      }),
      { params: Promise.resolve({ name: "hold.place" }) },
    );
    expect(bad.status).toBe(400);
    expect(await bad.text()).not.toMatch(/Barnes|1972/);
  });
});

// ------------------------------------------------------------------ C5 transport and secrets (secured-mode configuration)

const SECURED_KEYS = [
  "HLOS_MODE", "HLOS_OIDC_ISSUER", "HLOS_OIDC_ALLOW_INSECURE_LOOPBACK", "HLOS_OIDC_CLIENT_ID", "HLOS_OIDC_CLIENT_SECRET", "HLOS_PUBLIC_URL", "HLOS_LAB_ID",
  "HLOS_SESSION_SECRET", "HLOS_AUDIT_KEY", "HLOS_AUDIT_KEY_ID",
];

function securedEnv(over: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    HLOS_MODE: "secured",
    HLOS_OIDC_ISSUER: "http://127.0.0.1:9/nothing-listens-here", // loopback discard port: discovery fails at once
    HLOS_OIDC_ALLOW_INSECURE_LOOPBACK: "1",
    HLOS_OIDC_CLIENT_ID: "hlos-test-client",
    HLOS_OIDC_CLIENT_SECRET: crypto.randomBytes(24).toString("hex"),
    HLOS_PUBLIC_URL: "http://localhost:3999",
    HLOS_LAB_ID: "lab:local",
    HLOS_SESSION_SECRET: crypto.randomBytes(32).toString("hex"),
    HLOS_AUDIT_KEY: crypto.randomBytes(32).toString("hex"),
    ...over,
  };
}

async function withEnv<T>(env: Record<string, string | undefined>, fn: () => T | Promise<T>): Promise<T> {
  const saved = Object.fromEntries(SECURED_KEYS.map((k) => [k, process.env[k]]));
  for (const k of SECURED_KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(env)) if (v !== undefined) process.env[k] = v;
  try {
    return await fn();
  } finally {
    for (const k of SECURED_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

describe("C5 encryption in transit: https public URL, Secure cookies, HSTS", () => {
  it("a plain-http public URL is accepted only on loopback AND with a loopback identity provider (a local test setup)", async () => {
    // Local test setup (this suite, the secured browser suite): loopback app, loopback provider.
    await withEnv(securedEnv(), () => {
      expect(runtimeMode()).toBe("secured");
      const c = authConfig();
      expect(c.ok && c.config.secureCookies).toBe(false);
    });
    // A real (non-loopback) provider: the public URL must be https.
    await withEnv(securedEnv({ HLOS_OIDC_ISSUER: "https://idp.synthetic.test", HLOS_OIDC_ALLOW_INSECURE_LOOPBACK: undefined }), () => {
      expect(runtimeMode()).toBe("locked");
      expect(lockedReason()).toEqual({ reason: "auth_misconfigured", keys: ["HLOS_PUBLIC_URL"] });
    });
    await withEnv(securedEnv({ HLOS_OIDC_ISSUER: "https://idp.synthetic.test", HLOS_PUBLIC_URL: "https://lab.synthetic.test" }), () => {
      expect(runtimeMode()).toBe("secured");
      const c = authConfig();
      expect(c.ok && c.config.secureCookies).toBe(true);
    });
    // Never plain http on a non-loopback host, whatever the provider.
    for (const url of ["http://lab.synthetic.test", "http://10.0.0.5:3100", "http://localhost.synthetic.test"]) {
      await withEnv(securedEnv({ HLOS_PUBLIC_URL: url }), () => expect(lockedReason()?.keys, url).toEqual(["HLOS_PUBLIC_URL"]));
    }
  });

  it("with an https public URL every cookie is Secure, HttpOnly, SameSite=Lax, Path=/ with the __Host- prefix (sign-out clears it the same way)", async () => {
    expect(sessionCookieName(true)).toBe("__Host-hlos_session");
    expect(transactionCookieName(true)).toBe("__Host-hlos_auth_tx");
    const cookie = serializeCookie(sessionCookieName(true), "v", { secure: true });
    expect(cookie).toBe("__Host-hlos_session=v; Path=/; SameSite=Lax; HttpOnly; Secure");
    expect(cookie).not.toMatch(/Domain=/i);
    const db = testDb();
    await withEnv(securedEnv({ HLOS_OIDC_ISSUER: "https://127.0.0.1:9", HLOS_PUBLIC_URL: "https://lab.synthetic.test" }), async () => {
      expect(runtimeMode()).toBe("secured");
      const res = await handleLogout(new Request("https://lab.synthetic.test/api/auth/logout", { method: "POST", headers: { origin: "https://lab.synthetic.test" }, body: "{}" }), { db });
      expect(res.status).toBe(200);
      const set = res.headers.get("set-cookie") ?? "";
      expect(set).toMatch(/^__Host-hlos_session=; Path=\/; SameSite=Lax; HttpOnly; Secure; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT$/);
    });
    // On loopback http (tests only) the cookie cannot be Secure: the browser would drop it.
    await withEnv(securedEnv(), async () => {
      const res = await handleLogout(new Request("http://localhost:3999/api/auth/logout", { method: "POST", headers: { origin: "http://localhost:3999" }, body: "{}" }), { db });
      expect(res.headers.get("set-cookie")).toMatch(/^hlos_session=; Path=\/; SameSite=Lax; HttpOnly; Max-Age=0/);
    });
  });

  it("HSTS (two years, subdomains) is sent for an https public URL at build time, never for a loopback http one", async () => {
    const load = async () => {
      vi.resetModules();
      const mod = (await import("../../next.config")) as { default: { headers: () => Promise<{ source: string; headers: { key: string; value: string }[] }[]> } };
      return Object.fromEntries((await mod.default.headers())[0].headers.map((h) => [h.key, h.value]));
    };
    await withEnv({ HLOS_PUBLIC_URL: "https://lab.synthetic.test" }, async () => {
      const hsts = (await load())["Strict-Transport-Security"];
      expect(hsts).toMatch(/^max-age=(\d+); includeSubDomains$/);
      expect(Number(/max-age=(\d+)/.exec(hsts)![1])).toBeGreaterThanOrEqual(31_536_000);
    });
    await withEnv({ HLOS_PUBLIC_URL: "http://localhost:3999" }, async () => expect((await load())["Strict-Transport-Security"]).toBeUndefined());
  });
});

describe("C5 secrets: environment only, weak or reused secrets refused in secured mode, never echoed", () => {
  it("weakSecret flags obvious mistakes and accepts generated secrets", () => {
    for (const weak of ["", "x".repeat(64), "abcabcabcabcabcabcabcabcabcabcab", "changeme".repeat(5), "secret".repeat(6), "0123456789".repeat(4), "passwordpasswordpasswordpassword", "abcdefghijklmnopqrstuvwxyzab".slice(0, 12)]) {
      expect(weakSecret(weak), JSON.stringify(weak)).toBe(true);
    }
    for (let i = 0; i < 50; i++) {
      expect(weakSecret(crypto.randomBytes(32).toString("hex"))).toBe(false);
      expect(weakSecret(crypto.randomBytes(24).toString("base64"))).toBe(false);
    }
    expect(weakSecret("hlos-vitest-synthetic-audit-key-not-secret-0001")).toBe(false); // the suite's fixed test key (synthetic)
  });

  it("a weak, short or reused secret locks a secured build, naming the key and never the value", async () => {
    const shared = crypto.randomBytes(32).toString("hex");
    const cases: [Record<string, string>, string[]][] = [
      [{ HLOS_SESSION_SECRET: "x".repeat(40) }, ["HLOS_SESSION_SECRET"]],
      [{ HLOS_SESSION_SECRET: "changeme".repeat(5) }, ["HLOS_SESSION_SECRET"]],
      [{ HLOS_AUDIT_KEY: "0123456789".repeat(4) }, ["HLOS_AUDIT_KEY"]],
      [{ HLOS_OIDC_CLIENT_SECRET: "short-secret-1" }, ["HLOS_OIDC_CLIENT_SECRET"]],
      [{ HLOS_OIDC_CLIENT_SECRET: "secretsecretsecretsecret" }, ["HLOS_OIDC_CLIENT_SECRET"]],
      [{ HLOS_OIDC_CLIENT_SECRET: shared, HLOS_SESSION_SECRET: shared }, ["HLOS_OIDC_CLIENT_SECRET"]],
      [{ HLOS_OIDC_CLIENT_SECRET: shared, HLOS_AUDIT_KEY: shared }, ["HLOS_OIDC_CLIENT_SECRET"]],
      [{ HLOS_SESSION_SECRET: shared, HLOS_AUDIT_KEY: shared }, ["HLOS_AUDIT_KEY"]],
    ];
    for (const [over, keys] of cases) {
      await withEnv(securedEnv(over), () => {
        expect(runtimeMode(), JSON.stringify(keys)).toBe("locked");
        const reason = lockedReason();
        expect(reason?.keys).toEqual(keys);
        for (const v of Object.values(over)) expect(JSON.stringify(reason)).not.toContain(v);
      });
    }
    await withEnv(securedEnv(), () => expect(runtimeMode()).toBe("secured"));
  });
});
