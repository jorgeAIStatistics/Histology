// The simulator over real HTTP: a node:http server on 127.0.0.1 runs the app's actual route handlers
// (src/app/api/integration/inbound/route.ts and .../reconciliation/route.ts) against a temporary database, and the
// simulator delivers signed envelopes with real fetch. Synthetic data only; nothing leaves this machine.
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeSharedDb, getDb, openDatabase } from "@/server/db/db";
import { seedDemo } from "@/server/seed/seed";
import { SimSourceState, assertLoopbackUrl, deliver, httpTransport, outageSwitch, runScenario, worldFromDb, DEFAULT_RETRY, type ScenarioName } from "@/server/integration/simulator";
import { ROOT_SECRET, enableInbound, envelope, orderPayload, restoreEnv } from "./support";

type Handler = (req: Request) => Promise<Response>;

let dir = "";
let server: http.Server;
let base = "";
const savedDbPath = process.env.HLOS_DB_PATH;

beforeAll(async () => {
  enableInbound();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "hlos-contract-http-"));
  process.env.HLOS_DB_PATH = path.join(dir, "http.db");
  // The synthetic demo day, written to the temporary database before the route's shared connection opens it.
  const seeded = openDatabase(process.env.HLOS_DB_PATH);
  seedDemo(seeded, { clockRunning: false });
  seeded.close();
  const inbound = await import("@/app/api/integration/inbound/route");
  const recon = await import("@/app/api/integration/reconciliation/route");
  const routes: Record<string, Record<string, Handler>> = {
    "/api/integration/inbound": { POST: inbound.POST, GET: inbound.GET, PUT: inbound.PUT },
    "/api/integration/reconciliation": { GET: recon.GET },
  };
  server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const url = new URL(req.url ?? "/", `http://127.0.0.1`);
    if (url.pathname === "/redirect") {
      res.writeHead(307, { location: "http://example.invalid/api/integration/inbound" });
      res.end();
      return;
    }
    const handler = routes[url.pathname]?.[req.method ?? "GET"];
    if (!handler) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false }));
      return;
    }
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const response = await handler(new Request(`${base}${req.url}`, { method: req.method, headers, body }));
    res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  getDb(); // the route handlers' shared connection (demo mode)
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeSharedDb();
  if (savedDbPath === undefined) delete process.env.HLOS_DB_PATH;
  else process.env.HLOS_DB_PATH = savedDbPath;
  restoreEnv();
  fs.rmSync(dir, { recursive: true, force: true });
});

const noSleep = async () => {};
const run = (name: ScenarioName, extra: Partial<Parameters<typeof runScenario>[1]> = {}) => {
  const db = getDb();
  return runScenario(name, {
    transport: httpTransport(base),
    rootSecret: ROOT_SECRET,
    world: worldFromDb(db),
    outage: { description: "none", begin: async () => {}, end: async () => {} },
    sleep: noSleep,
    ...extra,
  });
};
const n = (sql: string, ...p: unknown[]) => (getDb().prepare(sql).get(...p) as { n: number }).n;

describe("the simulator drives the real route handler over HTTP with signing", () => {
  it("new order, duplicate, missing data, out of order, conflicting identifiers and unexpected versions all get the contract's answers", async () => {
    for (const name of ["new-order", "duplicate", "missing-data", "out-of-order", "conflicting-identifiers", "unexpected-version"] as const) {
      const report = await run(name);
      expect(report.ok, `${name}: ${report.steps.map((s) => `${s.label}=${s.result}`).join(", ")}`).toBe(true);
    }
    expect(n("SELECT COUNT(*) n FROM source_order WHERE source_order_id IN ('SIM-90101','SIM-90501','SIM-90801','SIM-91202')")).toBe(4);
    expect(n("SELECT COUNT(*) n FROM integration_event WHERE message_id = 'sim/missing-data/SIM-90701#v1' AND outcome = 'failed'")).toBe(1);
    expect(n("SELECT COUNT(*) n FROM integration_receipt WHERE via = 'inbound'")).toBeGreaterThan(0);
  });

  it("a source outage over the network (connection refused) backs off and keeps the backlog; recovery delivers it exactly once", async () => {
    const { transport, outage } = outageSwitch(httpTransport(base));
    const state = new SimSourceState();
    const sleeps: number[] = [];
    const before = n("SELECT COUNT(*) n FROM integration_event");
    const down = await run("source-outage", { transport, outage, state, policy: { maxAttempts: 3 }, sleep: async (ms) => void sleeps.push(ms) });
    expect(down.ok).toBe(true);
    expect(down.steps.every((s) => s.result === "undelivered" && s.attempts.length === 3 && s.attempts.every((a) => a.httpStatus === null && /Unreachable/.test(a.error ?? "")))).toBe(true);
    expect(sleeps).toHaveLength(4); // two waits per message, growing (exponential backoff with jitter)
    expect(sleeps[1]).toBeGreaterThan(sleeps[0] * 0.9);
    expect(state.outbox.map((e) => e.message_id)).toEqual(["sim/outage/SIM-91001#v1", "sim/outage/SIM-91002#v1"]);
    expect(n("SELECT COUNT(*) n FROM integration_event")).toBe(before);

    const up = await run("recovery", { transport, outage, state });
    expect(up.steps.map((s) => s.result)).toEqual(["accepted", "accepted", "duplicate", "duplicate"]);
    expect(n("SELECT COUNT(*) n FROM source_order WHERE source_order_id IN ('SIM-91001','SIM-91002')")).toBe(2);
    expect(n("SELECT COUNT(*) n FROM integration_event WHERE message_id LIKE 'sim/outage/%'")).toBe(2);
  });

  it("a per-request timeout gives up on a server that does not answer, and retries", async () => {
    const silent = http.createServer(() => {
      /* never answers */
    });
    await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
    try {
      const url = `http://127.0.0.1:${(silent.address() as AddressInfo).port}/api/integration/inbound`;
      const report = await deliver(envelope({ messageId: "H-TIMEOUT#v1", payload: orderPayload({ orderId: "H-1" }) }), {
        transport: httpTransport(url),
        rootSecret: ROOT_SECRET,
        policy: { ...DEFAULT_RETRY, maxAttempts: 2, timeoutMs: 150 },
        sleep: noSleep,
        nowMs: Date.now,
      });
      expect(report).toMatchObject({ result: "undelivered", keep: true });
      expect(report.attempts.map((a) => a.error)).toEqual(["No answer within 150 ms", "No answer within 150 ms"]);
    } finally {
      silent.closeAllConnections();
      await new Promise<void>((resolve) => silent.close(() => resolve()));
    }
  });

  it("the transport talks to loopback only and never follows a redirect", async () => {
    for (const bad of ["http://example.com/api/integration/inbound", "https://10.0.0.5/x", "http://user:pw@localhost:3100/", "ftp://localhost/x", "http://localhost.example.com/"]) {
      expect(() => assertLoopbackUrl(bad), bad).toThrow();
    }
    for (const ok of ["http://localhost:3100", "http://127.0.0.1:1/x", "http://[::1]:3100/api/integration/inbound"]) expect(() => assertLoopbackUrl(ok)).not.toThrow();
    const report = await deliver(envelope({ messageId: "H-REDIRECT#v1", payload: orderPayload({ orderId: "H-2" }) }), {
      transport: httpTransport(`${base}/redirect`),
      rootSecret: ROOT_SECRET,
      policy: DEFAULT_RETRY,
      sleep: noSleep,
      nowMs: Date.now,
    });
    expect(report.result).toBe("refused_redirect");
    expect(report.attempts).toHaveLength(1);
  });

  it("GET on the inbound endpoint is the same 404 as an unknown path", async () => {
    const res = await fetch(`${base}/api/integration/inbound`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ ok: false, error: { code: "NOT_FOUND", message: "Not found." } });
  });
});

describe("GET /api/integration/reconciliation needs a clinical view", () => {
  it("a bench role reads it; a role without view.operations gets 403; a locked build gets 401", async () => {
    const ok = await fetch(`${base}/api/integration/reconciliation`, { headers: { cookie: "hlos_actor=stf_maya" } });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { ok: boolean; result: { rows: { kind: string }[]; summary: { failedImports: number } } };
    expect(body.ok).toBe(true);
    expect(body.result.summary.failedImports).toBeGreaterThanOrEqual(1);

    getDb().prepare("INSERT OR IGNORE INTO staff (id, display_name, short_name, role, initials, active) VALUES ('stf_http_auditor', 'Test Auditor (synthetic)', 'Auditor', 'auditor', 'TA', 1)").run();
    const denied = await fetch(`${base}/api/integration/reconciliation`, { headers: { cookie: "hlos_actor=stf_http_auditor" } });
    expect(denied.status).toBe(403);
    expect(JSON.stringify(await denied.json())).not.toMatch(/rows|summary/);

    const mode = process.env.HLOS_MODE;
    process.env.HLOS_MODE = "production";
    try {
      const locked = await fetch(`${base}/api/integration/reconciliation`);
      expect(locked.status).toBe(401);
    } finally {
      process.env.HLOS_MODE = mode;
    }
  });
});
