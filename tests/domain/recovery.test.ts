// Stage 6 Phase E3: error recovery. What happens when a request, the database or a background import fails part way,
// and that nothing is ever shown as done unless the server confirmed it. Synthetic data only; temporary databases
// only (in memory, or files under the system temporary directory that are removed afterwards).
//
// Already covered elsewhere, so not repeated here:
//   - a command aborted BEFORE it reaches the server, and a 500 text/plain answer: tests/e2e/journeys.spec.ts
//     ("failed mutation" in journeys 1 to 6);
//   - stale versions (409 CONFLICT): journeys.spec.ts "stale state", guards.spec.ts check 12, grossing and intake tests;
//   - duplicate submission with one key (replay, IDEMPOTENCY_CONFLICT for another input or actor): security.test.ts,
//     receipts.test.ts, journeys.spec.ts "repeated request";
//   - a handler that fails after writing (everything rolled back, the key runs once later): security.test.ts
//     ("test.partialWrite"); two connections and one key: security.test.ts;
//   - an expired, locked or handed-over session: tests/e2e-secured/auth.spec.ts, auth.test.ts;
//   - the inbound endpoint: a busy database (503 Retry-After), a source set offline (503), the demo fault control
//     (500, applied once when re-sent), one invalid and one transiently failing message in a batch of four:
//     tests/contract/boundary.test.ts and guarantees.test.ts;
//   - a source outage, then the backlog delivered exactly once: integration.test.ts (pump), guarantees.test.ts and
//     scenarios.test.ts 10 and 11 (HTTP), guards.spec.ts check 13 and journeys.spec.ts (browser);
//   - /api/health: an unopenable database (503) and a held write lock (degraded): health.test.ts.
//
// Added here:
//   1. runCommand's mapping of answers that are not a confirmed result (200 non-JSON, 502, 504, aborted, offline,
//      malformed JSON, a cut-off body): never ok:true;
//   2. useCommand keeps one idempotency key per intent across failures, and a request that was received and applied
//      but whose answer was lost (connection dropped after the handler ran, over real HTTP) is retried with the same
//      key: replayed, nothing written twice (records, audit events, receipts);
//   3. database failures behind POST /api/commands: a write lock held longer than busy_timeout, a database that cannot
//      be written (read-only), a disk that fills up in the middle of a command, a database that cannot be opened;
//      each answers a typed error, nothing is half-written, the audit chain still verifies, /api/health/details says
//      degraded or unavailable;
//   4. the pump and the inbound endpoint failing INSIDE the second message of a batch (after it wrote rows): earlier
//      messages stay applied, the failing one is queued as retryable with nothing of it kept, later ones apply, and
//      retries duplicate nothing; a failure that even the failure queue cannot record leaves the message queued;
//   5. recovery gaps: the source drops offline in the middle of a backlog delivery; the database is busy while the
//      pump delivers.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import Database from "better-sqlite3";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { closeSharedDb, getDb, openDatabase, type DB } from "@/server/db/db";
import { seedDemo } from "@/server/seed/seed";
import { activeAuditKey, verifyAuditChain } from "@/server/core/audit-seal";
import { setLogSink } from "@/server/core/log";
import { resetHealthState, computeHealth } from "@/server/ops/health";
import { pumpSourcesDetailed } from "@/server/sim/pump";
import { runCommand, useCommand, ERROR_TITLE, type CommandOutcome, type UseCommandResult } from "@/lib/client/command";
import { POST as commandPOST } from "@/app/api/commands/[name]/route";
import { GET as detailsGET } from "@/app/api/health/details/route";
import { all, must, one, STAFF, testDb } from "../helpers";
import { at, counts, enableInbound, envelope, orderPayload, post, restoreEnv } from "../contract/support";

const PUBLIC = "http://localhost:3999";

// ---------------------------------------------------------------- shared helpers

let tmp = "";
beforeAll(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hlos-recovery-test-")));
});
afterAll(() => {
  closeSharedDb();
  fs.rmSync(tmp, { recursive: true, force: true });
});

let silence: (() => void) | null = null;
beforeEach(() => {
  // Route handlers write one log line per request; keep the test output readable (lines are asserted elsewhere).
  silence = setLogSink(() => undefined);
});
afterEach(() => {
  silence?.();
  silence = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

let fileN = 0;
/** A seeded synthetic database FILE (WAL) in its own directory under the test's temporary directory. */
function seededFile(): string {
  const dir = path.join(tmp, `db-${++fileN}`);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "recovery.db");
  const db = openDatabase(file);
  seedDemo(db, { clockRunning: false });
  db.close();
  return file;
}

/** Points the route handlers' shared connection at `file` (demo mode), runs `fn`, and restores the environment. */
async function withSharedDb(file: string, fn: () => Promise<void>): Promise<void> {
  const saved = process.env.HLOS_DB_PATH;
  closeSharedDb();
  process.env.HLOS_DB_PATH = file;
  try {
    await fn();
  } finally {
    closeSharedDb();
    if (saved === undefined) delete process.env.HLOS_DB_PATH;
    else process.env.HLOS_DB_PATH = saved;
  }
}

/** POST /api/commands/<name> as a demo role, through the real route handler. */
async function postCommand(name: string, input: unknown, idempotencyKey: string | undefined, actor: string = STAFF.priya): Promise<{ status: number; body: any; correlationId: string | null }> {
  const res = await commandPOST(
    new Request(`${PUBLIC}/api/commands/${name}`, {
      method: "POST",
      headers: { host: new URL(PUBLIC).host, origin: PUBLIC, "content-type": "application/json", cookie: `hlos_actor=${actor}` },
      body: JSON.stringify({ input, idempotencyKey }),
    }),
    { params: Promise.resolve({ name }) },
  );
  return { status: res.status, body: await res.json(), correlationId: res.headers.get("x-correlation-id") };
}

const n = (db: DB, sql: string, ...p: unknown[]) => one<{ n: number }>(db, sql, ...p).n;

/** Everything a command could have written, for "nothing was half-written" comparisons. */
function writeCounts(db: DB) {
  return {
    audit: n(db, "SELECT COUNT(*) n FROM audit_event"),
    seals: n(db, "SELECT COUNT(*) n FROM audit_seal"),
    receipts: n(db, "SELECT COUNT(*) n FROM command_receipt"),
    retrievals: n(db, "SELECT COUNT(*) n FROM retrieval_request"),
    retrievalItems: n(db, "SELECT COUNT(*) n FROM retrieval_item"),
    tasks: n(db, "SELECT COUNT(*) n FROM task"),
    holds: n(db, "SELECT COUNT(*) n FROM hold"),
    sequences: all(db, "SELECT * FROM id_sequence ORDER BY 1"),
  };
}

function expectChainVerifies(db: DB): void {
  const key = activeAuditKey();
  expect(key, "an audit key is configured for the tests").toBeTruthy();
  const v = verifyAuditChain(db, { key: key! });
  expect(v.firstProblem, JSON.stringify(v.firstProblem)).toBeNull();
  expect(v.ok).toBe(true);
}

/** Two stored blocks of the synthetic demo day (any two will do for a retrieval request). */
function twoBlocks(db: DB): string[] {
  return all<{ id: string }>(db, "SELECT id FROM block ORDER BY id LIMIT 2").map((b) => b.id);
}
const retrievalInput = (db: DB, purpose = "Deeper levels for comparison (recovery test)") => ({ blockIds: twoBlocks(db), purpose, destination: "Microtomy bench 2" });

/** A Response-like stub for the client tests. */
function reply(status: number, body: string | null, contentType = "text/html"): Response {
  return new Response(body, { status, headers: body === null ? {} : { "content-type": contentType } });
}

// =====================================================================================================================
// 1. The client never reports success without a confirmed result
// =====================================================================================================================

describe("1. runCommand maps every answer that is not a confirmed result to a failure (never ok:true)", () => {
  const call = async (impl: () => Promise<Response>): Promise<CommandOutcome<unknown>> => {
    vi.stubGlobal("fetch", vi.fn(impl));
    return runCommand("hold.place", { anything: true }, { idempotencyKey: "ui-recovery-map-0001" });
  };
  const failure = (o: CommandOutcome<unknown>) => {
    expect(o.ok, JSON.stringify(o)).toBe(false);
    if (o.ok) throw new Error("unreachable");
    return o.error;
  };

  it("200 with a body that is not JSON (an HTML page from a proxy or captive portal): UNCONFIRMED, with the status in the words", async () => {
    const e = failure(await call(async () => reply(200, "<!doctype html><title>Sign in to the network</title>")));
    expect(e.code).toBe("UNCONFIRMED");
    expect(e.message).toMatch(/HTTP 200/);
    expect(e.message).toMatch(/Reload to see what was recorded/);
    expect(ERROR_TITLE[e.code]).toBe("The server did not confirm this action");
  });

  it("502 Bad Gateway and 504 Gateway Timeout from a proxy (HTML or no body): UNCONFIRMED", async () => {
    for (const [status, body] of [
      [502, "<html><body><h1>502 Bad Gateway</h1></body></html>"],
      [504, "<html><body><h1>504 Gateway Time-out</h1></body></html>"],
      [504, null],
      [503, "Service Unavailable"],
      [500, ""],
    ] as const) {
      const e = failure(await call(async () => reply(status, body)));
      expect(e.code, `HTTP ${status}`).toBe("UNCONFIRMED");
      expect(e.message).toContain(`HTTP ${status}`);
    }
  });

  it("an aborted request and an offline browser: NETWORK, saying a retry will not create a duplicate", async () => {
    const aborted = failure(
      await call(async () => {
        throw new DOMException("The operation was aborted.", "AbortError");
      }),
    );
    const offline = failure(
      await call(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    for (const e of [aborted, offline]) {
      expect(e.code).toBe("NETWORK");
      expect(e.message).toMatch(/trying again will not create a duplicate/);
    }
    // A caller's own AbortSignal, aborted while the request is out, is the same answer.
    const ctl = new AbortController();
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, rejectFetch) => init.signal?.addEventListener("abort", () => rejectFetch(new DOMException("aborted", "AbortError"))))),
    );
    const pending = runCommand("hold.place", {}, { idempotencyKey: "ui-recovery-map-0002", signal: ctl.signal });
    ctl.abort();
    expect(failure(await pending).code).toBe("NETWORK");
  });

  it("a 200 whose body is cut off mid-JSON, or whose JSON is not { ok: true }: never success", async () => {
    // Cut off: the stream errors while the body is read.
    const cut = failure(
      await call(async () => {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"ok":true,"result":{"displayId":"RR-'));
            controller.error(new TypeError("terminated"));
          },
        });
        return new Response(stream, { status: 200, headers: { "content-type": "application/json" } });
      }),
    );
    expect(cut.code).toBe("UNCONFIRMED");
    // JSON that is not a confirmed result.
    for (const body of ["null", "{}", '"ok"', "[]", '{"ok":"true"}', '{"ok":1,"result":{}}', '{"result":{"displayId":"RR-0999"}}']) {
      const e = failure(await call(async () => reply(200, body, "application/json")));
      expect(e.code, body).toBe("UNCONFIRMED");
    }
    // ok:true on an error status is not a confirmed result either.
    expect(failure(await call(async () => reply(502, '{"ok":true,"result":{}}', "application/json"))).code).toBe("UNCONFIRMED");
  });

  it("the server's own typed errors keep their code, whatever the status (a 503 from the simulated source stays SOURCE_OFFLINE)", async () => {
    const typed = async (status: number, code: string) =>
      failure(await call(async () => reply(status, JSON.stringify({ ok: false, error: { code, message: `typed ${code}` } }), "application/json")));
    expect((await typed(503, "SOURCE_OFFLINE")).code).toBe("SOURCE_OFFLINE");
    expect((await typed(409, "CONFLICT")).code).toBe("CONFLICT");
    expect((await typed(400, "VALIDATION")).message).toBe("typed VALIDATION");
    // A JSON error body without a code: 5xx is UNCONFIRMED, 4xx is the status's code.
    expect(failure(await call(async () => reply(500, '{"ok":false}', "application/json"))).code).toBe("UNCONFIRMED");
    expect(failure(await call(async () => reply(403, '{"ok":false}', "application/json"))).code).toBe("FORBIDDEN");
  });

  it("a confirmed result is { ok: true } on a 2xx answer, and a replay says so", async () => {
    const ok = await call(async () => reply(200, JSON.stringify({ ok: true, result: { displayId: "RR-0999" } }), "application/json"));
    expect(ok).toEqual({ ok: true, result: { displayId: "RR-0999" }, replayed: false });
    const again = await call(async () => reply(200, JSON.stringify({ ok: true, result: { displayId: "RR-0999" }, replayed: true }), "application/json"));
    expect(again).toEqual({ ok: true, result: { displayId: "RR-0999" }, replayed: true });
  });
});

// =====================================================================================================================
// 2. An interrupted request: one idempotency key per intent, and no duplicate when the answer was lost
// =====================================================================================================================

/** The command route over real HTTP on 127.0.0.1, so a connection can really drop after the server did the work. */
interface CommandServer {
  base: string;
  /** What happens to the next answers, in order: "drop" destroys the connection after the handler ran; "504" replaces the answer with a gateway timeout page. */
  after: ("drop" | "504")[];
  /** Every request's idempotency key, in arrival order. */
  keys: string[];
  /** The demo role cookie the browser holds (switchable, as the presenter console's "Acting as" does). */
  actor: string;
  close: () => Promise<void>;
}

async function commandServer(actor: string): Promise<CommandServer> {
  const s: CommandServer = { base: "", after: [], keys: [], actor, close: async () => undefined };
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks);
    const url = new URL(req.url ?? "/", PUBLIC);
    const m = /^\/api\/commands\/([^/]+)$/.exec(url.pathname);
    if (req.method !== "POST" || !m) {
      res.writeHead(404).end();
      return;
    }
    try {
      s.keys.push((JSON.parse(body.toString("utf8")) as { idempotencyKey: string }).idempotencyKey);
    } catch {
      s.keys.push("(unreadable)");
    }
    // The browser's own headers: same origin, and the demo role cookie it holds.
    const headers = { host: new URL(PUBLIC).host, "content-type": "application/json", cookie: `hlos_actor=${s.actor}` };
    let response: Response;
    try {
      response = await commandPOST(new Request(`${PUBLIC}${url.pathname}`, { method: "POST", headers, body }), { params: Promise.resolve({ name: decodeURIComponent(m[1]) }) });
    } catch {
      // A route handler that throws: Next.js answers a bare 500 (no JSON body).
      res.writeHead(500).end();
      return;
    }
    const fate = s.after.shift();
    if (fate === "drop") {
      req.socket.destroy(); // the server did the work; the answer never leaves
      return;
    }
    if (fate === "504") {
      res.writeHead(504, { "content-type": "text/html" }).end("<html><body><h1>504 Gateway Time-out</h1></body></html>");
      return;
    }
    res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  s.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  s.close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return s;
}

/** The browser's fetch for the client code: relative /api/... URLs go to `base`. */
function browserFetchTo(base: string): void {
  const real = globalThis.fetch;
  vi.stubGlobal("fetch", (url: string | URL, init?: RequestInit) => real(new URL(String(url), base), init));
}

/** useCommand outside a browser: rendered once on the server (hooks run, state updates are ignored), its run() kept. */
interface Harness<R, I> {
  cmd: UseCommandResult<R, I>;
  /** Toast titles the screen would show (the toast fallback names them when no provider is mounted). */
  toasts: string[];
  refreshes: number;
}
function renderUseCommand<R, I>(name: string, options: Parameters<typeof useCommand<R, I>>[1] = {}): Harness<R, I> {
  const h = { toasts: [] as string[], refreshes: 0 } as Harness<R, I>;
  vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
    const [first, title] = args as [string, string];
    if (first === "[toast] ToastProvider is not mounted") h.toasts.push(title);
  });
  const router = { refresh: () => void (h.refreshes += 1), push: () => undefined, replace: () => undefined, back: () => undefined, forward: () => undefined, prefetch: () => undefined };
  function Probe() {
    h.cmd = useCommand<R, I>(name, options);
    return null;
  }
  renderToString(createElement(AppRouterContext.Provider, { value: router as never }, createElement(Probe)));
  return h;
}

describe("2. an interrupted request: the key is kept for a retry of the same intent, and nothing is recorded twice", () => {
  it("useCommand: one key per intent across NETWORK and UNCONFIRMED failures; a changed input is a new intent; success clears it; no success toast or refresh before ok:true", async () => {
    const sent: { key: string; input: unknown }[] = [];
    const answers: (() => Response)[] = [
      () => {
        throw new TypeError("Failed to fetch");
      },
      () => reply(502, "<h1>502 Bad Gateway</h1>"),
      () => reply(200, JSON.stringify({ ok: true, result: { displayId: "RR-0901" }, replayed: true }), "application/json"),
      () => reply(200, JSON.stringify({ ok: true, result: { displayId: "RR-0902" } }), "application/json"),
      () => reply(504, null),
      () => reply(504, null),
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as { input: unknown; idempotencyKey: string };
        sent.push({ key: body.idempotencyKey, input: body.input });
        return answers.shift()!();
      }),
    );
    const h = renderUseCommand<{ displayId: string }, { purpose: string }>("retrieval.create", { successToast: (r) => `${r.displayId} created` });
    const A = { purpose: "levels" };

    const first = await h.cmd.run(A);
    expect(first).toMatchObject({ ok: false, error: { code: "NETWORK" } });
    const second = await h.cmd.run(A);
    expect(second).toMatchObject({ ok: false, error: { code: "UNCONFIRMED" } });
    expect(h.toasts).toEqual([ERROR_TITLE.NETWORK, ERROR_TITLE.UNCONFIRMED]); // warnings only
    expect(h.refreshes).toBe(0);
    const third = await h.cmd.run(A);
    expect(third).toEqual({ ok: true, result: { displayId: "RR-0901" }, replayed: true });
    expect(h.toasts.at(-1)).toBe("Already recorded. No duplicate was created.");
    expect(h.refreshes).toBe(1);
    // The three tries of one intent carried ONE key.
    expect(new Set(sent.slice(0, 3).map((s) => s.key)).size).toBe(1);
    expect(sent[0].key).toMatch(/^retrieval\.create-/);

    // After a confirmed result the same input again is a new intent (a second request, by choice): a new key.
    const fourth = await h.cmd.run(A);
    expect(fourth.ok).toBe(true);
    expect(h.toasts.at(-1)).toBe("RR-0902 created");
    expect(sent[3].key).not.toBe(sent[0].key);

    // A changed input after a failure is a new intent too: a new key (the retry promise is for the same action).
    await h.cmd.run(A);
    await h.cmd.run({ purpose: "levels and a PAS" });
    expect(sent[5].key).not.toBe(sent[4].key);
    expect(sent[4].key).not.toBe(sent[3].key);
  });

  it("useCommand: a second press while the first is still out sends nothing more (one request, one answer for both)", async () => {
    let release: (r: Response) => void = () => undefined;
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => (release = resolve)));
    vi.stubGlobal("fetch", fetchMock);
    const h = renderUseCommand<{ displayId: string }, { purpose: string }>("retrieval.create");
    const p1 = h.cmd.run({ purpose: "a press while one is out" });
    const p2 = h.cmd.run({ purpose: "a press while one is out" });
    expect(p2).toBe(p1);
    release(reply(504, null));
    expect((await p1).ok).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("over real HTTP: the server records the request, the connection drops before the answer; the screen gets NETWORK, and its retry with the same key is replayed: one request, one audit event, one receipt", async () => {
    const file = seededFile();
    await withSharedDb(file, async () => {
      const db = getDb();
      const input = retrievalInput(db);
      const before = writeCounts(db);
      const seq0 = n(db, "SELECT COALESCE(MAX(seq), 0) n FROM audit_event");
      const server = await commandServer(STAFF.priya);
      try {
        browserFetchTo(server.base);
        const h = renderUseCommand<{ requestId: string; displayId: string }, typeof input>("retrieval.create", { successToast: (r) => `${r.displayId} created` });

        server.after.push("drop");
        const lost = await h.cmd.run(input);
        expect(lost).toMatchObject({ ok: false, error: { code: "NETWORK" } });
        expect(h.toasts).toEqual([ERROR_TITLE.NETWORK]);
        expect(h.toasts.some((t) => /created/.test(t))).toBe(false);
        // The server DID record it: that is exactly why the screen must not guess either way.
        const recorded = writeCounts(db);
        expect(recorded.retrievals).toBe(before.retrievals + 1);
        expect(recorded.audit).toBe(before.audit + 1);
        expect(recorded.receipts).toBe(before.receipts + 1);
        expect(all<{ action: string }>(db, "SELECT action FROM audit_event WHERE seq > ?", seq0).map((a) => a.action)).toEqual(["retrieval.created"]);

        // The person presses again: the same intent, the same key, a replay of the stored result.
        const retried = await h.cmd.run(input);
        expect(retried.ok).toBe(true);
        if (!retried.ok) return;
        expect(retried.replayed).toBe(true);
        expect(server.keys).toHaveLength(2);
        expect(server.keys[1]).toBe(server.keys[0]);
        // Confirmed now (a replay of the stored result): said as such, never as a second creation.
        expect(h.toasts).toEqual([ERROR_TITLE.NETWORK, "Already recorded. No duplicate was created."]);
        const after = writeCounts(db);
        expect(after).toEqual(recorded); // nothing at all was written by the retry
        expect(one<{ display_id: string }>(db, "SELECT display_id FROM retrieval_request WHERE id = ?", retried.result.requestId).display_id).toBe(retried.result.displayId);
        expect(n(db, "SELECT COUNT(*) n FROM command_receipt WHERE idempotency_key = ?", server.keys[0])).toBe(1);
        expectChainVerifies(db);

        // Control: a client that forgot its key (a new key for the same input) WOULD have created a duplicate.
        const forgetful = await runCommand<{ displayId: string }>("retrieval.create", input, { idempotencyKey: "ui-recovery-forgetful-0001" });
        expect(forgetful.ok).toBe(true);
        expect(writeCounts(db).retrievals).toBe(before.retrievals + 2);
      } finally {
        await server.close();
      }
    });
  });

  it("over real HTTP: the server records the request, a proxy answers 504; the screen gets UNCONFIRMED, and the retry is replayed (nothing twice)", async () => {
    const file = seededFile();
    await withSharedDb(file, async () => {
      const db = getDb();
      const input = retrievalInput(db, "Recut for a second opinion (recovery test)");
      const before = writeCounts(db);
      const server = await commandServer(STAFF.priya);
      try {
        browserFetchTo(server.base);
        const h = renderUseCommand<{ requestId: string; displayId: string }, typeof input>("retrieval.create", { successToast: (r) => `${r.displayId} created` });
        server.after.push("504");
        const unconfirmed = await h.cmd.run(input);
        expect(unconfirmed).toMatchObject({ ok: false, error: { code: "UNCONFIRMED" } });
        if (!unconfirmed.ok) expect(unconfirmed.error.message).toMatch(/HTTP 504.*Reload to see what was recorded/);
        expect(h.toasts).toEqual([ERROR_TITLE.UNCONFIRMED]);
        const recorded = writeCounts(db);
        expect(recorded.retrievals).toBe(before.retrievals + 1);
        const retried = await h.cmd.run(input);
        expect(retried).toMatchObject({ ok: true, replayed: true });
        expect(server.keys[1]).toBe(server.keys[0]);
        expect(writeCounts(db)).toEqual(recorded);
        expectChainVerifies(db);
      } finally {
        await server.close();
      }
    });
  });

  it("the form is closed and opened again (a new component) after the answer was lost: the retry still carries the same key and is replayed, nothing recorded twice", async () => {
    const file = seededFile();
    await withSharedDb(file, async () => {
      const db = getDb();
      const input = retrievalInput(db, "Levels after the dialog was reopened (recovery test)");
      const before = writeCounts(db);
      const server = await commandServer(STAFF.priya);
      try {
        browserFetchTo(server.base);
        const firstForm = renderUseCommand<{ requestId: string; displayId: string }, typeof input>("retrieval.create");
        server.after.push("drop");
        expect(await firstForm.cmd.run(input)).toMatchObject({ ok: false, error: { code: "NETWORK" } });
        const recorded = writeCounts(db);
        expect(recorded.retrievals).toBe(before.retrievals + 1);
        // The dialog is closed (its component unmounts) and opened again: a new component with no memory of its own.
        const reopened = renderUseCommand<{ requestId: string; displayId: string }, typeof input>("retrieval.create");
        const retried = await reopened.cmd.run(input);
        expect(retried).toMatchObject({ ok: true, replayed: true });
        expect(server.keys[1]).toBe(server.keys[0]);
        expect(reopened.toasts).toEqual(["Already recorded. No duplicate was created."]);
        expect(writeCounts(db)).toEqual(recorded);
        // Once confirmed, the intent is closed: the same input again is a new request (by choice), with a new key.
        const another = await renderUseCommand<{ displayId: string }, typeof input>("retrieval.create").cmd.run(input);
        expect(another).toMatchObject({ ok: true });
        expect(server.keys[2]).not.toBe(server.keys[0]);
        expect(writeCounts(db).retrievals).toBe(before.retrievals + 2);
      } finally {
        await server.close();
      }
    });
  });

  it("a remembered key that the server refuses for this requester (another demo role) is dropped: the refusal changes nothing, and the next press is a new intent", async () => {
    const file = seededFile();
    await withSharedDb(file, async () => {
      const db = getDb();
      const input = retrievalInput(db, "Levels requested before a role switch (recovery test)");
      const before = writeCounts(db);
      const server = await commandServer(STAFF.priya);
      try {
        browserFetchTo(server.base);
        server.after.push("drop");
        expect(await renderUseCommand("retrieval.create").cmd.run(input)).toMatchObject({ ok: false, error: { code: "NETWORK" } });
        server.actor = STAFF.tanya; // the presenter switches the demo role on the same page
        const form = renderUseCommand<{ displayId: string }, typeof input>("retrieval.create");
        const refused = await form.cmd.run(input);
        expect(refused).toMatchObject({ ok: false, error: { code: "IDEMPOTENCY_CONFLICT", details: { reason: "not_owner" } } });
        expect(server.keys[1]).toBe(server.keys[0]);
        expect(writeCounts(db).retrievals).toBe(before.retrievals + 1); // the refusal recorded no request
        const next = await form.cmd.run(input);
        expect(next).toMatchObject({ ok: true });
        expect(next.ok && next.replayed).toBe(false);
        expect(server.keys[2]).not.toBe(server.keys[0]);
        expect(n(db, "SELECT COUNT(*) n FROM retrieval_request WHERE requested_by = ? AND purpose = ?", STAFF.tanya, input.purpose)).toBe(1);
      } finally {
        await server.close();
      }
    });
  });
});

// =====================================================================================================================
// 3. Database failures behind POST /api/commands: typed answers, nothing half-written, health says so
// =====================================================================================================================

const DEMO_COOKIE = (who: string) => ({ cookie: `hlos_actor=${who}` });
const getReq = (url: string, headers: Record<string, string> = {}) => new Request(`${PUBLIC}${url}`, { headers: { host: new URL(PUBLIC).host, ...headers } });

/** A clarification whose evidence note is large (about 60 KB of synthetic filler): its row needs new database pages. */
const bigClarification = () => ({
  category: "laterality",
  refs: { sourceOrderId: "ord_ord_77121", orderPartId: "ord_ord_77121_b" },
  subjectLabel: "Part B · ORD-77121",
  question: "Which side is correct for part B? (recovery test)",
  evidence: [{ field: "Laterality", order_value: "right", observed_value: "left", source: "bottle label (staff entry)", note: `Synthetic filler. ${"lorem ipsum ".repeat(5000)}` }],
  priority: "high",
});

describe("3. database failures: a typed error, nothing half-written, and health reports it", () => {
  beforeEach(() => resetHealthState());
  afterEach(() => resetHealthState());

  it("a write lock held by another connection longer than busy_timeout: 409 CONFLICT after waiting, nothing written; health details degraded meanwhile; afterwards the same key runs once", async () => {
    const file = seededFile();
    await withSharedDb(file, async () => {
      const db = getDb();
      db.pragma("busy_timeout = 300"); // the server's is 5000 ms; shorter here only to keep the test quick
      const input = retrievalInput(db);
      const before = writeCounts(db);
      const other = new Database(file);
      other.exec("BEGIN IMMEDIATE"); // another writer (a CLI, a second process) mid-transaction
      try {
        const t0 = performance.now();
        const blocked = await postCommand("retrieval.create", input, "ui-recovery-locked-0001");
        expect(performance.now() - t0).toBeGreaterThanOrEqual(250); // it waited for the lock before giving up
        expect(blocked.status).toBe(409);
        expect(blocked.body).toEqual({ ok: false, error: { code: "CONFLICT", message: "Another change is being saved right now. Nothing was changed; try again." } });
        expect(blocked.correlationId).toBeTruthy();
        expect(writeCounts(db)).toEqual(before); // no request, item, task, audit event, seal, receipt or id number
        const details = await detailsGET(getReq("/api/health/details", DEMO_COOKIE(STAFF.tanya)));
        expect(details.status).toBe(200);
        const h = (await details.json()) as { status: string; checks: Record<string, { status: string; detail: string }> };
        expect(h.status).toBe("degraded");
        expect(h.checks.database.status).toBe("warn");
        expect(h.checks.database.detail).toMatch(/write lock stayed busy/);
      } finally {
        other.exec("ROLLBACK");
        other.close();
      }
      const ran = await postCommand("retrieval.create", input, "ui-recovery-locked-0001");
      expect(ran.status).toBe(200);
      expect(ran.body.replayed).toBeUndefined(); // it had never run
      const again = await postCommand("retrieval.create", input, "ui-recovery-locked-0001");
      expect(again.body).toMatchObject({ ok: true, replayed: true, result: ran.body.result });
      const after = writeCounts(db);
      expect(after.retrievals).toBe(before.retrievals + 1);
      expect(after.receipts).toBe(before.receipts + 1);
      expectChainVerifies(db);
    });
  });

  it("a database file that cannot be written (read-only): 503 STORAGE_UNAVAILABLE saying the database cannot save changes, never a validation error; nothing written; health details unavailable (503)", async () => {
    const file = seededFile();
    const db0 = new Database(file, { readonly: true });
    const before = writeCounts(db0);
    const input = retrievalInput(db0);
    db0.close();
    fs.chmodSync(file, 0o444);
    try {
      await withSharedDb(file, async () => {
        const logs: string[] = [];
        silence?.();
        silence = setLogSink((_level, line) => logs.push(line));
        const r = await postCommand("retrieval.create", input, "ui-recovery-readonly-0001");
        expect(r.status).toBe(503);
        expect(r.body.ok).toBe(false);
        expect(r.body.error.code).toBe("STORAGE_UNAVAILABLE");
        expect(r.body.error.message).toBe(
          "The laboratory database cannot save changes right now (it is read-only, full or cannot be opened). Nothing was changed. Try again later; if it keeps happening, tell the laboratory administrator.",
        );
        expect(JSON.stringify(r.body)).not.toMatch(/SQLITE|readonly database|Some fields/i);
        // The operator's log line: the command, the correlation id and the SQLite code (never the input).
        const line = logs.map((l) => JSON.parse(l) as Record<string, any>).find((l) => l.event === "command.storage_failure");
        expect(line).toMatchObject({ level: "error", command: "retrieval.create", correlationId: r.correlationId, error: { code: "SQLITE_READONLY" } });
        expect(logs.join("\n")).not.toContain(input.purpose);
        // Without a key (no receipt bookkeeping first), the command fails the same way at its first write, inside its transaction.
        const r2 = await postCommand("retrieval.create", input, undefined);
        expect([r2.status, r2.body.error?.code]).toEqual([503, "STORAGE_UNAVAILABLE"]);
        // Health: the database check fails (a write cannot be made), so the status is unavailable, HTTP 503.
        const details = await detailsGET(getReq("/api/health/details", DEMO_COOKIE(STAFF.tanya)));
        expect(details.status).toBe(503);
        const h = (await details.json()) as { status: string; checks: Record<string, { status: string; detail: string }> };
        expect(h.status).toBe("unavailable");
        expect(h.checks.database).toMatchObject({ status: "fail" });
        expect(h.checks.database.detail).toMatch(/a write could not be made \(SQLITE_READONLY\)/);
      });
    } finally {
      fs.chmodSync(file, 0o644);
    }
    const db = new Database(file, { readonly: true });
    try {
      expect(writeCounts(db)).toEqual(before);
    } finally {
      db.close();
    }
  });

  it("the disk fills up in the middle of a command (after it numbered the new record): 503 STORAGE_UNAVAILABLE, nothing half-written (not even the id number); once space is back the same key runs once", async () => {
    const file = seededFile();
    await withSharedDb(file, async () => {
      const db = getDb();
      db.exec("VACUUM"); // no free pages left to reuse
      const pages = db.pragma("page_count", { simple: true }) as number;
      db.pragma(`max_page_count = ${pages}`); // the file may not grow: a full disk, as SQLite sees it
      const before = writeCounts(db);
      const clarifications = () => n(db, "SELECT COUNT(*) n FROM clarification");
      const clr0 = clarifications();
      const full = await postCommand("clarification.create", bigClarification(), "ui-recovery-full-0001", STAFF.maya);
      expect(full.status).toBe(503);
      expect(full.body.error.code).toBe("STORAGE_UNAVAILABLE");
      expect(full.body.error.message).toMatch(/cannot save changes right now.*Nothing was changed/);
      expect(writeCounts(db)).toEqual(before);
      expect(clarifications()).toBe(clr0);
      expectChainVerifies(db);
      // Pinned limitation (src/server/ops/health.ts, not changed here): the health write probe rewrites one small row,
      // which still fits, so a database that cannot grow is reported healthy while larger writes fail.
      expect(computeHealth({ db: () => db }).checks.database.status).toBe("ok");
      db.pragma("max_page_count = 1073741823"); // space freed
      const ran = await postCommand("clarification.create", bigClarification(), "ui-recovery-full-0001", STAFF.maya);
      expect(ran.status).toBe(200);
      expect(ran.body.replayed).toBeUndefined();
      expect(clarifications()).toBe(clr0 + 1);
      const again = await postCommand("clarification.create", bigClarification(), "ui-recovery-full-0001", STAFF.maya);
      expect(again.body).toMatchObject({ ok: true, replayed: true });
      expect(clarifications()).toBe(clr0 + 1);
      expectChainVerifies(db);
    });
  });

  it("a database that cannot be opened: the route handler fails (a bare 500), the screen says UNCONFIRMED, and nothing is shown as done", async () => {
    const notADir = path.join(tmp, "not-a-directory");
    fs.writeFileSync(notADir, "a regular file where the database directory should be\n");
    await withSharedDb(path.join(notADir, "hlos.db"), async () => {
      const server = await commandServer(STAFF.priya);
      try {
        browserFetchTo(server.base);
        const h = renderUseCommand<{ displayId: string }, unknown>("retrieval.create", { successToast: (r) => `${r.displayId} created` });
        const out = await h.cmd.run({ blockIds: ["blk_x"], purpose: "levels", destination: "Microtomy bench 2" });
        expect(out).toMatchObject({ ok: false, error: { code: "UNCONFIRMED" } });
        if (!out.ok) expect(out.error.message).toMatch(/HTTP 500/);
        expect(h.toasts).toEqual([ERROR_TITLE.UNCONFIRMED]);
        expect(h.refreshes).toBe(0);
      } finally {
        await server.close();
      }
    });
    expect(fs.statSync(notADir).isFile()).toBe(true); // nothing was created in its place
  });
});

// =====================================================================================================================
// 4. A background import that fails part way through a batch
// =====================================================================================================================

/** One synthetic order message per entry, queued in the simulated EMA source's outbox and due before the paused 10:52 clock. */
function queueOrders(db: DB, rows: { messageId: string; orderId: string; mrn: string; due: string }[]): void {
  const ins = db.prepare("INSERT INTO sim_source_outbox (id, source_id, message_id, message_type, available_at, payload) VALUES (?, 'src_ema', ?, 'order.upsert', ?, ?)");
  for (const r of rows) ins.run(`ob_${r.messageId.replace(/[^A-Za-z0-9]/g, "_")}`, r.messageId, at(r.due), JSON.stringify(orderPayload({ orderId: r.orderId, mrn: r.mrn, updatedAt: at(r.due) })));
}
const batch = (prefix: string, base: number) =>
  [1, 2, 3].map((i) => ({ messageId: `${prefix}-${i}#v1`, orderId: `${prefix}-${base + i}`, mrn: `99${base + i}`, due: `10:4${i}` }));

/** Test seam (a temporary trigger on this connection only): the import of `orderId` fails while it writes its parts, after it wrote the order. */
const FAIL_INSIDE = (orderId: string) => `CREATE TEMP TRIGGER recovery_fail_inside BEFORE INSERT ON main.source_order_part
  WHEN (SELECT source_order_id FROM main.source_order WHERE id = NEW.source_order_id) = '${orderId}'
  BEGIN SELECT RAISE(ABORT, 'test seam: failed while writing the parts of ${orderId}'); END`;
/** Test seam: the failure queue itself cannot record `messageId` (a failure while handling a failure). */
const QUEUE_DOWN = (messageId: string) => `CREATE TEMP TRIGGER recovery_queue_down BEFORE INSERT ON main.integration_event
  WHEN NEW.message_id = '${messageId}' AND NEW.outcome = 'failed'
  BEGIN SELECT RAISE(ABORT, 'test seam: the failure queue cannot be written'); END`;

const orders = (db: DB, ...ids: string[]) => ids.map((id) => n(db, "SELECT COUNT(*) n FROM source_order WHERE source_order_id = ?", id));
const eventOf = (db: DB, messageId: string) =>
  one<{ id: string; outcome: string; receipt_count: number; detail: string } | undefined>(db, "SELECT id, outcome, receipt_count, detail FROM integration_event WHERE message_id = ?", messageId);
const isQueued = (db: DB, messageId: string) => one<{ delivered_at: string | null }>(db, "SELECT delivered_at FROM sim_source_outbox WHERE message_id = ?", messageId).delivered_at === null;
const outcomesOf = (r: ReturnType<typeof pumpSourcesDetailed>) => r.sources.flatMap((s) => s.outcomes.map((o) => [o.messageId, o.outcome]));
/** Nothing of an order's import kept: no order, version, part or patient reference with its MRN. */
function nothingKeptOf(db: DB, orderId: string, mrn: string): void {
  expect(n(db, "SELECT COUNT(*) n FROM source_order WHERE source_order_id = ?", orderId)).toBe(0);
  expect(n(db, "SELECT COUNT(*) n FROM source_order_version v JOIN source_order o ON o.id = v.source_order_id WHERE o.source_order_id = ?", orderId)).toBe(0);
  expect(n(db, "SELECT COUNT(*) n FROM patient_ref WHERE source_mrn = ?", mrn)).toBe(0);
}

describe("4. a background import that fails part way through a batch", () => {
  beforeAll(() => enableInbound());
  afterAll(() => restoreEnv());

  it("the pump: the 2nd of 3 messages fails after writing its order; the 1st stays applied, nothing of the 2nd is kept but its failure-queue entry, the 3rd applies; a staff retry applies it once and nothing repeats", async () => {
    const db = testDb();
    const before = counts(db);
    const [m1, m2, m3] = batch("RP", 90000);
    queueOrders(db, [m1, m2, m3]);
    db.exec(FAIL_INSIDE(m2.orderId));
    const first = pumpSourcesDetailed(db, { sourceId: "src_ema" });
    expect(outcomesOf(first)).toEqual([
      [m1.messageId, "applied"],
      [m2.messageId, "failed"],
      [m3.messageId, "applied"],
    ]);
    expect(orders(db, m1.orderId, m2.orderId, m3.orderId)).toEqual([1, 0, 1]);
    nothingKeptOf(db, m2.orderId, m2.mrn); // the order row it had written was rolled back with the rest of that message
    const failed = eventOf(db, m2.messageId)!;
    expect(failed).toMatchObject({ outcome: "failed", receipt_count: 1 });
    expect(failed.detail).toMatch(/test seam/);
    // Each row was handed over; the failed one now waits in the failure queue (retryable), not in the outbox.
    expect([m1, m2, m3].map((m) => isQueued(db, m.messageId))).toEqual([false, false, false]);
    expect(n(db, "SELECT COUNT(*) n FROM audit_event WHERE action = 'integration.import_failed' AND entity_id = ?", failed.id)).toBe(1);
    expect(computeHealth({ db: () => db }).checks.import_failures).toMatchObject({ status: "warn", count: 1 });

    // The dependency is back; a supervisor retries from the failure queue: applied once, under the same event.
    db.exec("DROP TRIGGER recovery_fail_inside");
    expect(must<{ outcome: string }>(db, STAFF.tanya, "integration.retryEvent", { eventId: failed.id }).outcome).toBe("applied");
    expect(eventOf(db, m2.messageId)).toMatchObject({ id: failed.id, outcome: "applied", receipt_count: 2 });
    expect(orders(db, m1.orderId, m2.orderId, m3.orderId)).toEqual([1, 1, 1]);

    // Nothing repeats: another poll, another retry, and the source re-sending all three.
    expect(pumpSourcesDetailed(db, { sourceId: "src_ema" }).delivered).toBe(0);
    expect(must<{ retried: boolean }>(db, STAFF.tanya, "integration.retryEvent", { eventId: failed.id }).retried).toBe(false);
    for (const m of [m1, m2, m3]) {
      const again = await post(db, envelope({ messageId: m.messageId, payload: orderPayload({ orderId: m.orderId, mrn: m.mrn, updatedAt: at(m.due) }) }));
      expect(again.body.status, m.messageId).toBe("duplicate");
    }
    const after = counts(db);
    expect(after.orders).toBe(before.orders + 3);
    expect(after.versions).toBe(before.versions + 3);
    expect(after.parts).toBe(before.parts + 3);
    expect(after.patients).toBe(before.patients + 3);
    expect(after.events).toBe(before.events + 3);
    expect(n(db, "SELECT COUNT(*) n FROM audit_event WHERE action = 'integration.order_imported' AND source_ref LIKE 'src_ema:RP-%'")).toBe(3);
    expect(computeHealth({ db: () => db }).checks.import_failures).toMatchObject({ status: "ok", count: 0 });
    expectChainVerifies(db);
  });

  it("the inbound endpoint: the 2nd of 3 messages fails after writing its order: 200, 500 (received, queued, Retry-After), 200; the source's re-send applies it once, a repeat of the 1st is a duplicate", async () => {
    const db = testDb();
    const before = counts(db);
    const [m1, m2, m3] = batch("RH", 90100);
    const env = (m: typeof m1) => envelope({ messageId: m.messageId, payload: orderPayload({ orderId: m.orderId, mrn: m.mrn }) });
    db.exec(FAIL_INSIDE(m2.orderId));
    const r1 = await post(db, env(m1));
    const r2 = await post(db, env(m2));
    const r3 = await post(db, env(m3));
    expect([r1.status, r2.status, r3.status]).toEqual([200, 500, 200]);
    expect(r2.headers.get("retry-after")).toBe("30");
    expect(r2.body).toMatchObject({ status: "failed", message_id: m2.messageId, receipt_id: expect.any(String) });
    expect(r2.body.errors[0].code).toBe("processing_failed");
    expect(JSON.stringify(r2.body)).not.toMatch(/test seam|SQLITE|990102/); // the answer never quotes the error or the payload
    expect(orders(db, m1.orderId, m2.orderId, m3.orderId)).toEqual([1, 0, 1]);
    nothingKeptOf(db, m2.orderId, m2.mrn);
    expect(eventOf(db, m2.messageId)).toMatchObject({ outcome: "failed", receipt_count: 1 });

    db.exec("DROP TRIGGER recovery_fail_inside");
    const resent = await post(db, env(m2));
    expect(resent.status).toBe(200);
    expect(resent.body).toMatchObject({ status: "accepted", receipt_id: r2.body.receipt_id });
    expect((await post(db, env(m1))).body.status).toBe("duplicate");
    expect(orders(db, m1.orderId, m2.orderId, m3.orderId)).toEqual([1, 1, 1]);
    const after = counts(db);
    expect([after.orders - before.orders, after.events - before.events, after.patients - before.patients]).toEqual([3, 3, 3]);
    expectChainVerifies(db);
  });

  it("when even the failure queue cannot record the failure: the pump leaves that message in the outbox (nothing of it recorded) and goes on; the next poll applies it once", () => {
    const db = testDb();
    const lines: Record<string, any>[] = [];
    silence?.();
    silence = setLogSink((_level, line) => lines.push(JSON.parse(line)));
    const [m1, m2, m3] = batch("RQ", 90200);
    queueOrders(db, [m1, m2, m3]);
    db.exec(FAIL_INSIDE(m2.orderId));
    db.exec(QUEUE_DOWN(m2.messageId));
    const auditBefore = n(db, "SELECT COUNT(*) n FROM audit_event");
    const first = pumpSourcesDetailed(db, { sourceId: "src_ema" });
    expect(outcomesOf(first)).toEqual([
      [m1.messageId, "applied"],
      [m3.messageId, "applied"],
    ]);
    expect(isQueued(db, m2.messageId)).toBe(true);
    expect(eventOf(db, m2.messageId)).toBeUndefined();
    nothingKeptOf(db, m2.orderId, m2.mrn);
    expect(n(db, "SELECT COUNT(*) n FROM audit_event WHERE source_ref LIKE ?", `src_ema:${m2.messageId}:%`)).toBe(0);
    expect(n(db, "SELECT COUNT(*) n FROM audit_event")).toBe(auditBefore + 2); // the two imports only
    const failure = lines.find((l) => l.event === "pump.delivery_failed");
    expect(failure).toMatchObject({ level: "error", sourceId: "src_ema", messageId: m2.messageId, error: { code: "SQLITE_CONSTRAINT_TRIGGER" } });
    expect(JSON.stringify(lines)).not.toContain(m2.mrn);

    db.exec("DROP TRIGGER recovery_queue_down");
    db.exec("DROP TRIGGER recovery_fail_inside");
    expect(outcomesOf(pumpSourcesDetailed(db, { sourceId: "src_ema" }))).toEqual([[m2.messageId, "applied"]]);
    expect(pumpSourcesDetailed(db, { sourceId: "src_ema" }).delivered).toBe(0);
    expect(orders(db, m1.orderId, m2.orderId, m3.orderId)).toEqual([1, 1, 1]);
    expect(eventOf(db, m2.messageId)).toMatchObject({ outcome: "applied", receipt_count: 1 });
    expectChainVerifies(db);
  });

  it("the same on the inbound endpoint: 500 'nothing was recorded' with Retry-After; the source's re-send applies it once", async () => {
    const db = testDb();
    const [, m2] = batch("RR", 90300);
    const env = envelope({ messageId: m2.messageId, payload: orderPayload({ orderId: m2.orderId, mrn: m2.mrn }) });
    db.exec(FAIL_INSIDE(m2.orderId));
    db.exec(QUEUE_DOWN(m2.messageId));
    const before = counts(db);
    const r = await post(db, env);
    expect(r.status).toBe(500);
    expect(r.headers.get("retry-after")).toBe("30");
    expect(r.body).toMatchObject({ status: "failed", message_id: m2.messageId });
    expect(r.body.errors[0]).toMatchObject({ code: "internal", message: "The message could not be processed. Nothing was recorded; retry later." });
    expect(counts(db)).toEqual(before);
    db.exec("DROP TRIGGER recovery_queue_down");
    db.exec("DROP TRIGGER recovery_fail_inside");
    const again = await post(db, env);
    expect(again.body.status).toBe("accepted");
    expect(orders(db, m2.orderId)).toEqual([1]);
    expect(eventOf(db, m2.messageId)).toMatchObject({ outcome: "applied", receipt_count: 1 });
  });
});

// =====================================================================================================================
// 5. Recovery after a temporary dependency failure: the gaps the existing outage tests leave
// =====================================================================================================================

describe("5. recovery: the source drops offline during a backlog delivery; the database is busy while the pump delivers", () => {
  it("the source goes offline after the first message of its backlog: that one stays applied, the rest wait; back online, the rest arrive once", () => {
    const db = testDb();
    const before = counts(db);
    must(db, STAFF.maya, "integration.setSourceStatus", { sourceId: "src_ema", status: "offline" });
    const [m1, m2, m3] = batch("RB", 90400);
    queueOrders(db, [m1, m2, m3]); // the backlog builds while the source is offline
    expect(pumpSourcesDetailed(db, { sourceId: "src_ema" }).delivered).toBe(0);
    // Test seam: the link drops again right after the first message of the backlog is applied.
    db.exec(`CREATE TEMP TRIGGER recovery_link_drops AFTER INSERT ON main.integration_event WHEN NEW.message_id = '${m1.messageId}'
      BEGIN UPDATE main.integration_source SET status = 'offline', last_error = 'Simulated outage' WHERE id = NEW.source_id; END`);
    const restored = must<{ delivered: number }>(db, STAFF.maya, "integration.setSourceStatus", { sourceId: "src_ema", status: "connected" });
    expect(restored.delivered).toBe(1);
    expect(orders(db, m1.orderId, m2.orderId, m3.orderId)).toEqual([1, 0, 0]);
    expect([m1, m2, m3].map((m) => isQueued(db, m.messageId))).toEqual([false, true, true]);
    expect([eventOf(db, m2.messageId), eventOf(db, m3.messageId)]).toEqual([undefined, undefined]); // nothing recorded for them
    expect(one<{ status: string }>(db, "SELECT status FROM integration_source WHERE id = 'src_ema'").status).toBe("offline");
    expect(pumpSourcesDetailed(db, { sourceId: "src_ema" }).delivered).toBe(0); // still offline: nothing more

    db.exec("DROP TRIGGER recovery_link_drops");
    expect(must<{ delivered: number }>(db, STAFF.maya, "integration.setSourceStatus", { sourceId: "src_ema", status: "connected" }).delivered).toBe(2);
    expect(pumpSourcesDetailed(db, { sourceId: "src_ema" }).delivered).toBe(0);
    expect(orders(db, m1.orderId, m2.orderId, m3.orderId)).toEqual([1, 1, 1]);
    expect([m1, m2, m3].map((m) => eventOf(db, m.messageId)?.receipt_count)).toEqual([1, 1, 1]);
    const after = counts(db);
    expect([after.orders - before.orders, after.events - before.events, after.patients - before.patients]).toEqual([3, 3, 3]);
    expectChainVerifies(db);
  });

  it("another connection holds the write lock for the whole poll: the pump never throws, records nothing and leaves every message queued; the next poll delivers each once", () => {
    const file = seededFile();
    const db = openDatabase(file);
    const other = new Database(file);
    try {
      const [m1, m2, m3] = batch("RL", 90500);
      queueOrders(db, [m1, m2, m3]);
      db.pragma("busy_timeout = 50");
      const before = counts(db);
      other.exec("BEGIN IMMEDIATE");
      // Each delivery reads first, so its write cannot wait for the lock (SQLite never waits to upgrade a read
      // transaction): every message fails at once, nothing of it is kept, and the outbox keeps it for the next poll.
      const busy = pumpSourcesDetailed(db, { sourceId: "src_ema" });
      expect(busy.delivered).toBe(0);
      expect(counts(db)).toEqual(before);
      expect([m1, m2, m3].map((m) => isQueued(db, m.messageId))).toEqual([true, true, true]);
      other.exec("ROLLBACK");
      expect(outcomesOf(pumpSourcesDetailed(db, { sourceId: "src_ema" })).map(([, o]) => o)).toEqual(["applied", "applied", "applied"]);
      expect(pumpSourcesDetailed(db, { sourceId: "src_ema" }).delivered).toBe(0);
      expect(orders(db, m1.orderId, m2.orderId, m3.orderId)).toEqual([1, 1, 1]);
      expect(n(db, "SELECT COUNT(*) n FROM integration_event WHERE outcome = 'failed'")).toBe(0);
    } finally {
      other.close();
      db.close();
    }
  });
});
