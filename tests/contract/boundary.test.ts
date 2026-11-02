// Contract "hlos.source-message" 1.0 at the boundary: gate, signature, envelope, payload, replies.
// docs/release/integration-contract.md. Synthetic data only.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testDb, must, one, STAFF } from "../helpers";
import { openDatabase } from "@/server/db/db";
import { seedDemo } from "@/server/seed/seed";
import { SOURCE_ADAPTERS } from "@/server/sim/pump";
import { MAX_BODY_BYTES, SIMULATED_SOURCE_ADAPTERS, SIGNATURE_TOLERANCE_SECONDS, parseSignatureHeader, verifySignature, deriveSourceSecret, signatureFor } from "@/server/integration/contract";
import { ROOT_SECRET, at, counts, enableInbound, envelope, orderPayload, post, restoreEnv } from "./support";

beforeAll(enableInbound);
afterAll(restoreEnv);

describe("a valid message is accepted (ACK) with provenance", () => {
  it("returns 200 { status: accepted, receipt_id, received_at } and stores sent_at as the source's event time, received_at as the local time", async () => {
    const db = testDb();
    const env = envelope({ messageId: "T-OK-1#v1", payload: orderPayload({ orderId: "T-90001", updatedAt: at("10:20") }), sentAt: at("10:25"), correlationId: "src-corr-00000001" });
    const r = await post(db, env);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: "accepted", message_id: "T-OK-1#v1", outcome: "applied", review_required: false, correlation_id: "src-corr-00000001" });
    expect(r.headers.get("x-correlation-id")).toBe("src-corr-00000001");
    const ev = one<{ id: string; source_updated_at: string; received_at: string; source_version: number; outcome: string }>(db, "SELECT * FROM integration_event WHERE message_id = 'T-OK-1#v1'");
    expect(r.body.receipt_id).toBe(ev.id);
    expect(ev).toMatchObject({ source_updated_at: at("10:25"), received_at: at("10:52"), source_version: 1, outcome: "applied" });
    expect(r.body.received_at).toBe(at("10:52")); // the demo clock (paused at 10:52 in tests), not the source's time
    expect(one<{ via: string }>(db, "SELECT via FROM integration_receipt WHERE message_id = 'T-OK-1#v1'").via).toBe("inbound");
  });

  it("accepts a higher MINOR version and ignores members it does not know (envelope and payload)", async () => {
    const db = testDb();
    const env = { ...envelope({ messageId: "T-MINOR#v1", payload: { ...orderPayload({ orderId: "T-90002" }), future_member: { x: 1 } }, contractVersion: "1.7" }), routing_hint: "ignored" };
    const r = await post(db, env);
    expect(r.status).toBe(200);
    expect(r.body.status).toBe("accepted");
    expect(one<{ n: number }>(db, "SELECT COUNT(*) n FROM source_order WHERE source_order_id = 'T-90002'").n).toBe(1);
  });
});

describe("invalid data is rejected (NAK 400) with paths, and kept in the failure queue", () => {
  it("missing and wrong payload members are named by path and code; the message is queued and retryable; nothing else changes", async () => {
    const db = testDb();
    const before = counts(db);
    const bad = orderPayload({ orderId: "T-90010" }) as Record<string, any>;
    delete bad.patient.birth_date;
    bad.version = 0;
    bad.specimens[0].site = "";
    const r = await post(db, envelope({ messageId: "T-BAD-1#v1", payload: bad }));
    expect(r.status).toBe(400);
    expect(r.body.status).toBe("rejected");
    const byPath = Object.fromEntries((r.body.errors as { path: string; code: string }[]).map((e) => [e.path, e.code]));
    expect(byPath).toMatchObject({ "payload.patient.birth_date": "required", "payload.version": "too_small", "payload.specimens.0.site": "too_small" });
    const ev = one<{ id: string; outcome: string; detail: string }>(db, "SELECT id, outcome, detail FROM integration_event WHERE message_id = 'T-BAD-1#v1'");
    expect(ev.outcome).toBe("failed");
    expect(r.body.receipt_id).toBe(ev.id);
    expect(ev.detail).toMatch(/validation/);
    const after = counts(db);
    expect({ ...after, events: before.events, receipts: before.receipts, audit: before.audit }).toEqual(before);
    expect(after.events).toBe(before.events + 1);
    // The failure is audited with the message reference (no patient value in the NAK or the reason).
    expect(one<{ source_ref: string }>(db, "SELECT source_ref FROM audit_event WHERE action = 'integration.import_failed' ORDER BY rowid DESC LIMIT 1").source_ref).toBe("src_ema:T-BAD-1#v1:v0");
    expect(JSON.stringify(r.body)).not.toMatch(/Testwood|990901/);
  });

  it("an unsupported message type is refused with path message_type and kept in the failure queue (retryable after an upgrade)", async () => {
    const db = testDb();
    const r = await post(db, envelope({ messageId: "T-TYPE#1", type: "order.delete", payload: orderPayload({ orderId: "T-90011" }) }));
    expect(r.status).toBe(400);
    expect(r.body.errors[0]).toMatchObject({ path: "message_type", code: "unsupported_message_type" });
    expect(one<{ outcome: string }>(db, "SELECT outcome FROM integration_event WHERE message_id = 'T-TYPE#1'").outcome).toBe("failed");
  });

  it("a malformed envelope is refused with paths and records nothing (no trustworthy message id)", async () => {
    const db = testDb();
    const before = counts(db);
    const env = { ...envelope({ messageId: "x", payload: orderPayload({ orderId: "T-90012" }) }), message_id: "", sent_at: "2026-10-14 10:30", payload: [1, 2] };
    const r = await post(db, env);
    expect(r.status).toBe(400);
    const paths = (r.body.errors as { path: string }[]).map((e) => e.path).sort();
    expect(paths).toEqual(["message_id", "payload", "sent_at"]);
    const junk = await post(db, { source_id: "src_ema", message_id: "junk" }, { rawBody: "{not json" });
    expect(junk.status).toBe(400);
    expect(junk.body.errors[0].code).toBe("invalid_json");
    expect(counts(db)).toEqual(before);
  });

  it("specimen.submitted must name specimen lines on the order with their container counts", async () => {
    const db = testDb();
    const p = { ...orderPayload({ orderId: "T-90013" }), submitted: [{ designation: "B", containers: 1 }, { designation: "A", containers: 3 }] };
    const r = await post(db, envelope({ messageId: "T-SPEC-BAD#v1", type: "specimen.submitted", payload: p }));
    expect(r.status).toBe(400);
    const byPath = Object.fromEntries((r.body.errors as { path: string; code: string }[]).map((e) => [e.path, e.code]));
    expect(byPath).toEqual({ "payload.submitted.0.designation": "custom", "payload.submitted.1.containers": "custom" });
    expect(one<{ n: number }>(db, "SELECT COUNT(*) n FROM source_order WHERE source_order_id = 'T-90013'").n).toBe(0);
  });

  it("accession messages are refused as data when the request is unknown or the source does not issue numbers", async () => {
    const db = testDb();
    const unknown = await post(db, envelope({ messageId: "T-ACK-UNKNOWN", type: "accession.acknowledged", payload: { request_id: "AR-9999", acknowledged_at: at("10:40") } }));
    expect(unknown.status).toBe(400);
    expect(unknown.body.errors[0]).toMatchObject({ path: "payload.request_id", code: "unknown_reference" });
    const other = await post(db, envelope({ sourceId: "src_oth", messageId: "T-ACK-OTH", type: "accession.issued", payload: { request_id: "AR-0001", accession_number: "D26-04999", namespace: "X", issued_at: at("10:40") } }));
    expect(other.status).toBe(400);
    expect(other.body.errors[0]).toMatchObject({ path: "source_id", code: "not_authoritative" });
    expect(one<{ n: number }>(db, "SELECT COUNT(*) n FROM integration_event WHERE message_id IN ('T-ACK-UNKNOWN','T-ACK-OTH') AND outcome = 'failed'").n).toBe(2);
  });
});

describe("authentication: a bad signature or an old timestamp is refused (401) and NOTHING is recorded", () => {
  const cases: [string, Parameters<typeof post>[2], string][] = [
    ["wrong key", { sign: { wrongKey: true } }, "signature_invalid"],
    ["no signature header", { sign: false, headers: { "x-hlos-source": "src_ema" } }, "signature_missing"],
    ["malformed header", { headers: { "x-hlos-signature": "v1=abc" } }, "signature_malformed"],
    ["timestamp 6 minutes old", { sign: { timestampOffsetSeconds: -(SIGNATURE_TOLERANCE_SECONDS + 60) } }, "signature_expired"],
    ["timestamp 6 minutes ahead", { sign: { timestampOffsetSeconds: SIGNATURE_TOLERANCE_SECONDS + 60 } }, "signature_expired"],
    ["signed as another source", { sign: { asSourceId: "src_oth" } }, "source_mismatch"],
    ["unknown source", { sign: { asSourceId: "src_nowhere" } }, "unknown_source"],
    ["a simulated connector that is not a source system", { sign: { asSourceId: "src_print" } }, "unknown_source"],
  ];
  for (const [label, opts, code] of cases) {
    it(label, async () => {
      const db = testDb();
      const before = counts(db);
      const r = await post(db, envelope({ messageId: `T-AUTH-${code}`, payload: orderPayload({ orderId: "T-90020" }) }), opts);
      expect(r.status).toBe(401);
      expect(r.body.status).toBe("rejected");
      expect(r.body.errors[0].code).toBe(code);
      expect(counts(db)).toEqual(before);
    });
  }

  it("a body changed after signing is refused", async () => {
    const db = testDb();
    const env = envelope({ messageId: "T-TAMPER#v1", payload: orderPayload({ orderId: "T-90021" }) });
    const signedFor = JSON.stringify(env);
    const tampered = signedFor.replace("Left forearm", "Right forearm");
    const r = await post(db, env, { rawBody: tampered, headers: { "x-hlos-signature": `t=${Math.floor(Date.now() / 1000)},v1=${signatureFor(deriveSourceSecret(ROOT_SECRET, "src_ema"), Math.floor(Date.now() / 1000), signedFor)}` } });
    expect(r.status).toBe(401);
    expect(r.body.errors[0].code).toBe("signature_invalid");
  });

  it("a timestamp just inside the 5-minute tolerance is accepted", async () => {
    const db = testDb();
    const r = await post(db, envelope({ messageId: "T-SKEW#v1", payload: orderPayload({ orderId: "T-90022" }) }), { sign: { timestampOffsetSeconds: -(SIGNATURE_TOLERANCE_SECONDS - 5) } });
    expect(r.status).toBe(200);
  });

  it("a source whose adapter is not a simulated source adapter is refused even with a correct signature", async () => {
    const db = testDb();
    db.prepare("UPDATE integration_source SET adapter = 'hl7_mllp' WHERE id = 'src_ema'").run();
    const r = await post(db, envelope({ messageId: "T-REAL#v1", payload: orderPayload({ orderId: "T-90023" }) }));
    expect(r.status).toBe(401);
    expect(r.body.errors[0].code).toBe("unknown_source");
  });

  it("signature parsing and verification are strict and constant-time", () => {
    expect(parseSignatureHeader("t=123,v1=" + "a".repeat(64))).toEqual({ timestamp: 123, v1: ["a".repeat(64)] });
    expect(parseSignatureHeader("t=abc,v1=" + "a".repeat(64))).toBeNull();
    expect(parseSignatureHeader("t=1,v1=zz")).toBeNull();
    const key = deriveSourceSecret(ROOT_SECRET, "src_ema");
    const now = 1_800_000_000_000;
    const t = Math.floor(now / 1000);
    const good = signatureFor(key, t, "{}");
    // During a key rotation a header may carry two v1 values: one match is enough.
    expect(verifySignature(`t=${t},v1=${"0".repeat(64)},v1=${good}`, "{}", key, now)).toEqual({ ok: true, timestamp: t });
    expect(deriveSourceSecret(ROOT_SECRET, "src_ema").equals(deriveSourceSecret(ROOT_SECRET, "src_oth"))).toBe(false);
  });
});

describe("versioning: an unsupported contract is refused (422) and nothing is recorded", () => {
  it("contract 2.0 and another contract name are refused", async () => {
    const db = testDb();
    const before = counts(db);
    const v2 = await post(db, envelope({ messageId: "T-V2#v1", payload: orderPayload({ orderId: "T-90030" }), contractVersion: "2.0" }));
    expect(v2.status).toBe(422);
    expect(v2.body.errors[0]).toMatchObject({ path: "contract_version", code: "unsupported_contract_version" });
    const other = await post(db, { ...envelope({ messageId: "T-V3#v1", payload: orderPayload({ orderId: "T-90031" }) }), contract: "hl7.orm" });
    expect(other.status).toBe(422);
    expect(other.body.errors[0].code).toBe("unsupported_contract");
    expect(counts(db)).toEqual(before);
  });
});

describe("the endpoint exists only for the synthetic demo with the simulator switch on", () => {
  const env = () => envelope({ messageId: "T-GATE#v1", payload: orderPayload({ orderId: "T-90040" }) });
  const withEnv = async (vars: Record<string, string | undefined>, fn: () => Promise<void>) => {
    const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
    for (const [k, v] of Object.entries(vars)) if (v === undefined) delete process.env[k];
    else process.env[k] = v;
    try {
      await fn();
    } finally {
      for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  const cases: [string, Record<string, string | undefined>][] = [
    ["secured mode (even with the switch on)", { HLOS_MODE: "secured" }],
    ["locked mode", { HLOS_MODE: undefined }],
    ["the switch off", { HLOS_INTEGRATION_SIMULATOR: "0" }],
    ["no root secret", { HLOS_INTEGRATION_SIM_SECRET: undefined }],
    ["a root secret shorter than 32 characters", { HLOS_INTEGRATION_SIM_SECRET: "short-secret" }],
  ];
  for (const [label, vars] of cases) {
    it(`404 like any unknown path: ${label}; nothing recorded`, async () => {
      const db = testDb();
      const before = counts(db);
      await withEnv(vars, async () => {
        const r = await post(db, env());
        expect(r.status).toBe(404);
        expect(r.body).toEqual({ ok: false, error: { code: "NOT_FOUND", message: "Not found." } });
      });
      expect(counts(db)).toEqual(before);
    });
  }

  it("every method but POST is 404", async () => {
    const db = testDb();
    expect((await post(db, env(), { method: "GET" })).status).toBe(404);
    expect((await post(db, env(), { method: "PUT" })).status).toBe(404);
  });

  it("only simulated source-system adapters are accepted (the same set the pump serves)", () => {
    expect([...SIMULATED_SOURCE_ADAPTERS].sort()).toEqual([...SOURCE_ADAPTERS].sort());
    expect(SIMULATED_SOURCE_ADAPTERS.every((a) => a.startsWith("simulated_"))).toBe(true);
  });
});

describe("transport refusals: size and media type", () => {
  it("413 for a body over the limit, 415 for a non-JSON content type; nothing recorded", async () => {
    const db = testDb();
    const before = counts(db);
    const big = envelope({ messageId: "T-BIG#v1", payload: { ...orderPayload({ orderId: "T-90050" }), clinical_note: "x".repeat(MAX_BODY_BYTES) } });
    expect((await post(db, big)).status).toBe(413);
    const r = await post(db, envelope({ messageId: "T-CT#v1", payload: orderPayload({ orderId: "T-90051" }) }), { headers: { "content-type": "text/plain" } });
    expect(r.status).toBe(415);
    expect(counts(db)).toEqual(before);
  });
});

describe("503 with Retry-After when the laboratory cannot accept right now", () => {
  it("a busy database: 503 Retry-After, nothing recorded; the same message is accepted once the lock is gone", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hlos-contract-busy-"));
    const file = path.join(dir, "busy.db");
    const db = openDatabase(file);
    try {
      seedDemo(db, { clockRunning: false });
      db.pragma("busy_timeout = 50");
      const other = new Database(file);
      other.exec("BEGIN IMMEDIATE");
      const before = counts(db);
      const env = envelope({ messageId: "T-BUSY#v1", payload: orderPayload({ orderId: "T-90060" }) });
      const busy = await post(db, env);
      expect(busy.status).toBe(503);
      expect(busy.headers.get("retry-after")).toBe("2");
      expect(busy.body).toMatchObject({ status: "unavailable", retry_after_seconds: 2 });
      expect(busy.body.errors[0].code).toBe("busy");
      other.exec("ROLLBACK");
      other.close();
      expect(counts(db)).toEqual(before);
      const ok = await post(db, env);
      expect(ok.status).toBe(200);
      expect(ok.body.status).toBe("accepted");
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a source set offline (simulated outage): 503 Retry-After, nothing recorded", async () => {
    const db = testDb();
    must(db, STAFF.tanya, "integration.setSourceStatus", { sourceId: "src_ema", status: "offline" });
    const before = counts(db);
    const r = await post(db, envelope({ messageId: "T-OFF#v1", payload: orderPayload({ orderId: "T-90061" }) }));
    expect(r.status).toBe(503);
    expect(r.headers.get("retry-after")).toBe("30");
    expect(r.body.errors[0].code).toBe("source_offline");
    expect(counts(db)).toEqual(before);
  });
});

describe("a processing failure is 500 with Retry-After: received, queued, and applied when re-sent", () => {
  it("the demo fault control fails the first delivery; the source's retry of the same message id applies it once", async () => {
    const db = testDb();
    must(db, STAFF.tanya, "integration.injectImportFailure", { sourceId: "src_ema" });
    const env = envelope({ messageId: "T-FAULT#v1", payload: orderPayload({ orderId: "T-90070" }) });
    const first = await post(db, env);
    expect(first.status).toBe(500);
    expect(first.headers.get("retry-after")).toBe("30");
    expect(first.body).toMatchObject({ status: "failed" });
    expect(first.body.errors[0].code).toBe("processing_failed");
    expect(one<{ outcome: string }>(db, "SELECT outcome FROM integration_event WHERE message_id = 'T-FAULT#v1'").outcome).toBe("failed");
    const again = await post(db, env);
    expect(again.status).toBe(200);
    expect(again.body.status).toBe("accepted");
    expect(again.body.receipt_id).toBe(first.body.receipt_id);
    expect(one<{ n: number }>(db, "SELECT COUNT(*) n FROM source_order WHERE source_order_id = 'T-90070'").n).toBe(1);
    expect(one<{ outcome: string; receipt_count: number }>(db, "SELECT outcome, receipt_count FROM integration_event WHERE message_id = 'T-FAULT#v1'")).toEqual({ outcome: "applied", receipt_count: 2 });
  });
});
