// Stage 6 Phase C4: the structured server log (src/server/core/log.ts) writes JSON lines with the level, the event,
// the correlation id and safe fields only. Redaction removes patient fields, cookies, authorization headers, tokens,
// secrets and payloads; error objects are reduced to name, code, a scrubbed message and one frame location.
// Synthetic values only.
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { errorInfo, formatLogLine, log, logger, safeFields, scrubText, setLogSink, REDACTED, REDACTED_PATIENT, REDACTED_PAYLOAD, type LogLevel } from "@/server/core/log";
import { DomainError } from "@/server/core/errors";
import { defineCommand, executeCommand } from "@/server/commands/registry";
import { testDb, STAFF } from "../helpers";

const SESSION = "4f1c9b2e7a6d5c3b8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d"; // 64 hex: looks like a session id or key
const JWT = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJzdWItc3RmX2tpbSJ9.c2lnbmF0dXJlLXN5bnRoZXRpYw";

function capture(): { lines: { level: LogLevel; line: string }[]; restore: () => void } {
  const lines: { level: LogLevel; line: string }[] = [];
  const restore = setLogSink((level, line) => lines.push({ level, line }));
  return { lines, restore };
}

let restoreSink: (() => void) | null = null;
afterEach(() => {
  restoreSink?.();
  restoreSink = null;
  delete process.env.HLOS_LOG_LEVEL;
});

describe("log lines", () => {
  it("are one JSON object per line: ts, level, event, correlation id, then the safe fields", () => {
    const line = formatLogLine("warn", "auth.callback_without_transaction", { correlationId: "c-abc123", sourceId: "src_ema", count: 3, ok: false }, new Date("2026-10-19T12:00:00.000Z"));
    expect(line).not.toContain("\n");
    expect(JSON.parse(line)).toEqual({ ts: "2026-10-19T12:00:00.000Z", level: "warn", event: "auth.callback_without_transaction", correlationId: "c-abc123", sourceId: "src_ema", count: 3, ok: false });
    expect(Object.keys(JSON.parse(line)).slice(0, 4)).toEqual(["ts", "level", "event", "correlationId"]);
  });

  it("drop a malformed correlation id or field name, and replace a malformed event name", () => {
    const parsed = JSON.parse(formatLogLine("info", "bad event\nname", { correlationId: "x\ny", "bad-key": 1, "a b": 2, ok: 1 }));
    expect(parsed.event).toBe("invalid_event_name");
    expect(parsed).not.toHaveProperty("correlationId");
    expect(parsed).toMatchObject({ ok: 1, droppedFields: 2 });
  });

  it("go to stderr for warn and error, stdout for info, and respect HLOS_LOG_LEVEL; logging never throws", () => {
    const c = capture();
    restoreSink = c.restore;
    logger.debug("t.debug");
    logger.info("t.info");
    logger.warn("t.warn");
    logger.error("t.error");
    expect(c.lines.map((l) => l.level)).toEqual(["info", "warn", "error"]); // debug is below the default threshold
    process.env.HLOS_LOG_LEVEL = "error";
    log("warn", "t.quiet");
    log("error", "t.loud");
    expect(c.lines.map((l) => JSON.parse(l.line).event)).toEqual(["t.info", "t.warn", "t.error", "t.loud"]);
    // A circular object, a throwing getter, a BigInt: still one line, never an exception.
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const tricky = { get boom() { throw new Error("getter"); } };
    expect(() => log("error", "t.weird", { circular, tricky, big: BigInt(12) })).not.toThrow();
    expect(JSON.parse(c.lines.at(-1)!.line)).toMatchObject({ circular: "[object]", big: "12" });
  });
});

describe("redaction", () => {
  it("replaces secrets, credentials and cookies by key, whatever the value", () => {
    const f = safeFields({
      clientSecret: "abc", HLOS_SESSION_SECRET: "abc", password: "abc", authorization: "Bearer abc", cookie: "hlos_session=abc", setCookie: "x",
      token: "abc", idToken: "abc", accessToken: "abc", refresh_token: "abc", auditKey: "abc", key: "abc", apiKey: "abc", nonce: "abc", codeVerifier: "abc",
      sessionId: "abc", session: "abc",
    });
    for (const v of Object.values(f)) expect(v).toBe(REDACTED);
  });

  it("replaces patient details by key", () => {
    const f = safeFields({ patientName: "Barnes, Theo", family_name: "Barnes", given_name: "Theo", birth_date: "1972-06-14", dob: "1972-06-14", mrn: "447902", sourceMrn: "447902", name: "Theo Barnes", observedLabel: "x" });
    for (const v of Object.values(f)) expect(v).toBe(REDACTED_PATIENT);
  });

  it("replaces request and record content by key (bodies, payloads, before/after, evidence, questions, answers, notes, reasons, headers)", () => {
    const f = safeFields({
      body: '{"input":{}}', payload: "x", input: { a: 1 }, before: { a: 1 }, after: { a: 1 }, before_json: "x", evidence: [], question: "q", answerText: "a",
      note: "n", reason: "r", summary: "s", detail: "d", headers: {}, query: "q", requestBody: "x", data: {},
    });
    for (const v of Object.values(f)) expect(v).toBe(REDACTED_PAYLOAD);
  });

  it("never serializes objects or arrays, and keeps plain values that are safe", () => {
    expect(safeFields({ refs: { patient: "Theo Barnes" }, list: ["Theo Barnes"], command: "hold.place", sourceId: "src_ema", messageId: "ORD-77118#v2", n: 4, flag: true, nothing: null })).toEqual({
      refs: "[object]", list: "[array:1]", command: "hold.place", sourceId: "src_ema", messageId: "ORD-77118#v2", n: 4, flag: true, nothing: null,
    });
  });

  it("scrubs credentials, tokens, cookie pairs, long hex, birth-date-like dates and MRN-like numbers inside strings, and keeps timestamps", () => {
    const text = [
      `Authorization: Bearer ${JWT}`,
      "Authorization: Basic c3ludGhldGljOnRlc3Q=",
      `cookie hlos_session=${SESSION}; __Host-hlos_session=${SESSION}`,
      `callback?code=abc123&state=def456`,
      `{"clientSecret":"s3cr3t-synthetic"}`,
      `id_token ${JWT}`,
      `hash ${SESSION}`,
      "born 1972-06-14 or 6/14/1972, MRN 447902",
      "at 2026-10-19T12:00:00.000Z",
    ].join(" | ");
    const out = scrubText(text, 2000);
    for (const secret of [JWT, SESSION, "c3ludGhldGljOnRlc3Q=", "abc123", "def456", "s3cr3t-synthetic", "1972-06-14", "6/14/1972", "447902"]) expect(out).not.toContain(secret);
    expect(out).toContain("Bearer [redacted]");
    expect(out).toContain("hlos_session=[redacted]");
    expect(out).toContain("__Host-hlos_session=[redacted]");
    expect(out).toContain('"clientSecret":"[redacted]"');
    expect(out).toContain("born [date] or [date], MRN [digits]");
    expect(out).toContain("2026-10-19T12:00:00.000Z");
    expect(scrubText("x".repeat(500)).length).toBeLessThanOrEqual(200);
    expect(scrubText("a\nb\u0000c")).toBe("a b c");
  });

  it("reduces an error to name, code, a scrubbed short message and one frame location, never the stack text", () => {
    const e = new Error(`JSON parse failed near "Barnes, Theo 1972-06-14 447902" with Bearer ${JWT}`);
    const info = errorInfo(e);
    expect(info.name).toBe("Error");
    expect(info.message).not.toMatch(/1972-06-14|447902|eyJ/);
    expect(info.at).toMatch(/^tests\/domain\/log\.test\.ts:\d+$/);
    expect(JSON.stringify(info)).not.toContain("    at ");
    expect(errorInfo(new DomainError("FORBIDDEN", "Not allowed"))).toMatchObject({ name: "DomainError", code: "FORBIDDEN", message: "Not allowed" });
    const sqlite = Object.assign(new Error("UNIQUE constraint failed: hold.id"), { name: "SqliteError", code: "SQLITE_CONSTRAINT_UNIQUE" });
    expect(errorInfo(sqlite)).toMatchObject({ name: "SqliteError", code: "SQLITE_CONSTRAINT_UNIQUE" });
    expect(errorInfo("plain string 447902")).toEqual({ name: "Error", message: "plain string [digits]" });
    expect(errorInfo({ some: "object" })).toEqual({ name: "object", message: "non-Error value thrown" });
    // Through a line: the `error` field (or any Error value) is reduced the same way.
    const line = JSON.parse(formatLogLine("error", "t.err", { error: e, other: new TypeError("x") }));
    expect(line.error).toEqual(info);
    expect(line.other).toMatchObject({ name: "TypeError" });
  });
});

describe("call sites", () => {
  it("an unexpected error in a command: one structured line with the correlation id and command, never the input; the caller gets a generic message", () => {
    const db = testDb();
    defineCommand({
      name: "test.logBoom",
      description: "Test only: throws an unexpected error quoting its input.",
      permission: null,
      input: z.object({ patientName: z.string(), dob: z.string() }),
      run: (_ctx, input) => {
        throw new TypeError(`cannot read ${input.patientName} born ${input.dob}`);
      },
    });
    const c = capture();
    restoreSink = c.restore;
    const res = executeCommand(db, STAFF.kim, "test.logBoom", { patientName: "Theo Barnes", dob: "1972-06-14" }, { correlationId: "c-logtest-1" });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.message).toBe("The request could not be completed because of an unexpected error on the server. Nothing was changed. Reference: c-logtest-1.");
    expect(JSON.stringify(res)).not.toMatch(/Theo|Barnes|1972|TypeError|at /);
    expect(c.lines).toHaveLength(1);
    const line = JSON.parse(c.lines[0].line);
    expect(line).toMatchObject({ level: "error", event: "command.unexpected_error", correlationId: "c-logtest-1", command: "test.logBoom", error: { name: "TypeError" } });
    expect(c.lines[0].line).not.toMatch(/1972-06-14/); // the date is scrubbed from the message
  });

  it("no console.error / console.warn / console.log remains in src/server/** or src/app/api/** (everything goes through the logger)", () => {
    const roots = ["src/server", "src/app/api"].map((r) => path.resolve(r));
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, ent.name);
        if (ent.isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(ent.name)) {
          const lines = fs.readFileSync(p, "utf8").split("\n");
          lines.forEach((l, i) => {
            if (/\bconsole\.(error|warn|log|info|debug)\s*\(/.test(l)) offenders.push(`${path.relative(process.cwd(), p)}:${i + 1}`);
          });
        }
      }
    };
    for (const r of roots) walk(r);
    expect(offenders).toEqual([]);
  });
});

describe("a secured build that falls back to locked names the failing settings in the server log, never their values", () => {
  it("logs the setting names once, without the configured values", async () => {
    const { runtimeMode } = await import("@/server/runtime-mode");
    const { setLogSink } = await import("@/server/core/log");
    const saved = { ...process.env };
    const lines: string[] = [];
    const restore = setLogSink((_level, line) => lines.push(line));
    try {
      process.env.HLOS_MODE = "secured";
      process.env.HLOS_OIDC_CLIENT_SECRET = "value-that-must-never-be-logged-0123456789";
      delete process.env.HLOS_OIDC_ISSUER;
      expect(runtimeMode()).toBe("locked");
      expect(runtimeMode()).toBe("locked");
      const hits = lines.filter((l) => l.includes("runtime.locked_misconfigured"));
      expect(hits).toHaveLength(1);
      expect(hits[0]).toContain("HLOS_OIDC_ISSUER");
      expect(lines.join("\n")).not.toContain("value-that-must-never-be-logged");
    } finally {
      restore();
      process.env = saved;
    }
  });
});
