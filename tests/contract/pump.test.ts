// The in-process pump goes through the contract's mapping (handleEnvelope), so in-process and HTTP messages share
// ONE validation path. Synthetic data only.
import { describe, expect, it, vi } from "vitest";
import { testDb, clockAt, one } from "../helpers";
import { pumpSources } from "@/server/sim/pump";
import { handleEnvelope, type EnvelopeOutcome } from "@/server/integration/inbound";
import { prepareDelayedAck } from "@/server/integration/in-process";
import { at } from "./support";

vi.mock("@/server/integration/inbound", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/server/integration/inbound")>();
  return { ...mod, handleEnvelope: vi.fn(mod.handleEnvelope) };
});

describe("the pump maps every outbox row through handleEnvelope", () => {
  it("the seeded 11:20 deliveries reach the importer through the contract mapping (contract 1.0, the payload's own event time, via pump)", () => {
    const db = testDb();
    const spy = vi.mocked(handleEnvelope);
    spy.mockClear();
    clockAt(db, "11:20");
    expect(pumpSources(db).delivered).toBe(2);
    expect(spy).toHaveBeenCalledTimes(2);
    const calls = spy.mock.calls.map(([, msg, opts]) => ({ id: msg.message_id, version: msg.contract_version, via: opts.via, sentAt: msg.sent_at, payloadIsText: typeof msg.payload === "string" }));
    const pas = JSON.parse(one<{ payload: string }>(db, "SELECT payload FROM sim_source_outbox WHERE message_id = 'ORD-75061#v2'").payload) as { updated_at: string };
    expect(calls).toEqual([
      expect.objectContaining({ id: "ORD-77118#v1", version: "1.0", via: "pump", payloadIsText: true }),
      { id: "ORD-75061#v2", version: "1.0", via: "pump", sentAt: pas.updated_at, payloadIsText: true },
    ]);
    const outcomes = spy.mock.results.map((r) => (r.value as EnvelopeOutcome).body.status);
    expect(outcomes).toEqual(["duplicate", "accepted"]);
  });

  it("an invalid outbox payload gets the same structured NAK the HTTP endpoint gives, and lands in the failure queue", () => {
    const db = testDb();
    const spy = vi.mocked(handleEnvelope);
    spy.mockClear();
    db.prepare("INSERT INTO sim_source_outbox (id, source_id, message_id, message_type, available_at, payload) VALUES ('ob_bad', 'src_ema', 'BAD-OUTBOX#v1', 'order.upsert', ?, ?)").run(
      at("10:50"),
      JSON.stringify({ order_id: "BAD-1", version: 1, updated_at: at("10:49"), office_id: "LOC-104", specimens: [] }),
    );
    pumpSources(db);
    const out = spy.mock.results[0].value as EnvelopeOutcome;
    expect(out.httpStatus).toBe(400);
    expect(out.body).toMatchObject({ status: "rejected", errors: [{ path: "payload.patient", code: "required", message: "Required." }] });
    expect(one<{ outcome: string }>(db, "SELECT outcome FROM integration_event WHERE message_id = 'BAD-OUTBOX#v1'").outcome).toBe("failed");
    expect(one<{ delivered_at: string | null }>(db, "SELECT delivered_at FROM sim_source_outbox WHERE id = 'ob_bad'").delivered_at).not.toBeNull();
  });

  it("an accession acknowledgment queued by the simulated source is delivered through the same mapping", () => {
    const db = testDb();
    const ack = prepareDelayedAck(db);
    const spy = vi.mocked(handleEnvelope);
    spy.mockClear();
    const now = one<{ value: string }>(db, "SELECT value FROM app_setting WHERE key = 'clock_anchor_demo'").value;
    db.prepare("INSERT INTO sim_source_outbox (id, source_id, message_id, message_type, available_at, payload) VALUES ('ob_ack', 'src_ema', 'ACK-OUTBOX-1', 'accession.acknowledged', ?, ?)").run(
      now,
      JSON.stringify({ request_id: ack.requestId, accession_number: ack.accessionNumber, namespace: ack.namespace, acknowledged_at: now }),
    );
    pumpSources(db);
    const call = spy.mock.calls.find(([, msg]) => msg.message_id === "ACK-OUTBOX-1");
    expect(call?.[1].sent_at).toBe(now);
    expect(one<{ outcome: string; message_type: string }>(db, "SELECT outcome, message_type FROM integration_event WHERE message_id = 'ACK-OUTBOX-1'")).toEqual({ outcome: "applied", message_type: "accession.acknowledged" });
  });
});
