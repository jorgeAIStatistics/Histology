import crypto from "node:crypto";
import net from "node:net";
import type { DB } from "../db/db";
import type { SimulatedOrder } from "../domain/sourceImport";
import { labLocalToIso } from "@/lib/time";
import {
  CONTRACT_VERSION,
  SIGNATURE_HEADER,
  SOURCE_HEADER,
  deriveSourceSecret,
  makeEnvelope,
  signatureHeader,
  type ContractError,
  type SourceEnvelope,
} from "./contract";

/**
 * SOURCE-SIDE SIMULATOR for contract "hlos.source-message" 1.0 (docs/release/integration-contract.md §12).
 *
 * It plays a source system: it builds deterministic, synthetic envelopes from the seed's records and from new
 * synthetic patients, signs them (HMAC-SHA256, per-source key derived from HLOS_INTEGRATION_SIM_SECRET), and
 * delivers them with a per-request timeout, exponential backoff with jitter, a maximum number of attempts, and
 * no retry after a 4xx NAK. Undeliverable messages stay in its outbox (nothing is lost) and are delivered in
 * order later.
 *
 * Safety: the HTTP transport refuses every URL whose host is not loopback (localhost, 127.0.0.1, ::1) and never
 * follows a redirect. Envelopes are synthetic only. There is no code path that sends anywhere else.
 */

// ------------------------------------------------------------------ world (from the seed's records)

export interface SimPatient {
  mrn: string;
  name: string;
  birth_date: string;
}

export interface SimWorld {
  /** The demo day (YYYY-MM-DD, lab-local); event times are fixed times on it. */
  day: string;
  ema: { sourceId: string; officeId: string; providerId: string | null };
  oth: { sourceId: string; officeId: string; providerId: string | null };
  /** An order the seed holds that no guided-demo step or other scenario uses (latest stored version). */
  amendable: SimulatedOrder;
  /** A patient on file (from `amendable`). */
  patientOnFile: SimPatient;
  /** An EMA order that is already accessioned (latest stored version): for an order id under a different MRN. */
  accessioned: SimulatedOrder;
}

function latestPayload(db: DB, tenant: string, orderId: string): SimulatedOrder | null {
  const row = db
    .prepare(
      `SELECT v.payload FROM source_order_version v JOIN source_order o ON o.id = v.source_order_id
        WHERE o.tenant_id = ? AND o.source_order_id = ? ORDER BY v.source_version DESC LIMIT 1`,
    )
    .get(tenant, orderId) as { payload: string } | undefined;
  return row ? (JSON.parse(row.payload) as SimulatedOrder) : null;
}

/** Read the simulator's world from a database holding the synthetic seed (a fresh in-memory seed, or a test database). */
export function worldFromDb(db: DB): SimWorld {
  const day = (db.prepare("SELECT value FROM app_setting WHERE key = 'demo_day'").get() as { value: string } | undefined)?.value ?? "2026-10-14";
  const src = (id: string) => db.prepare("SELECT id, tenant_id FROM integration_source WHERE id = ?").get(id) as { id: string; tenant_id: string } | undefined;
  const ema = src("src_ema");
  const oth = src("src_oth");
  if (!ema || !oth) throw new Error("The simulated sources src_ema and src_oth are not in this database: load the synthetic seed first.");
  const amendable = latestPayload(db, ema.tenant_id, "ORD-77150");
  if (!amendable) throw new Error("Seed order ORD-77150 is not in this database: load the synthetic seed first.");
  // An accessioned EMA order with nothing else pending in the demo (no queued outbox message names it).
  const acc = db
    .prepare(
      `SELECT so.source_order_id FROM source_order so
        WHERE so.tenant_id = ? AND so.source_status = 'active'
          AND EXISTS (SELECT 1 FROM specimen_part sp WHERE sp.source_order_id = so.id)
          AND NOT EXISTS (SELECT 1 FROM sim_source_outbox ob WHERE ob.payload LIKE '%"' || so.source_order_id || '"%')
          AND NOT EXISTS (SELECT 1 FROM work_order wo WHERE wo.source_order_id = so.id)
        ORDER BY so.source_order_id LIMIT 1`,
    )
    .get(ema.tenant_id) as { source_order_id: string } | undefined;
  const accessioned = acc ? latestPayload(db, ema.tenant_id, acc.source_order_id) : null;
  if (!accessioned) throw new Error("No accessioned EMA order found in this database: load the synthetic seed first.");
  const othOrder = latestPayload(db, oth.tenant_id, "LSC-5531");
  return {
    day,
    ema: { sourceId: ema.id, officeId: amendable.office_id, providerId: amendable.ordering_provider_id ?? null },
    oth: { sourceId: oth.id, officeId: othOrder?.office_id ?? "SITE-7", providerId: othOrder?.ordering_provider_id ?? null },
    amendable,
    patientOnFile: { ...amendable.patient },
    accessioned,
  };
}

/** New synthetic patients (fictional names; MRNs in the 9901xx range the seed never uses). */
export const SYNTHETIC_PATIENTS: readonly SimPatient[] = [
  { mrn: "990101", name: "Quill, Juniper", birth_date: "1981-04-22" },
  { mrn: "990102", name: "Ashdown, Perrin", birth_date: "1966-11-03" },
  { mrn: "990103", name: "Marlow, Ines", birth_date: "1990-07-15" },
  { mrn: "990104", name: "Thorne, Calla", birth_date: "1958-02-28" },
  { mrn: "990105", name: "Vance, Oriel", birth_date: "1975-09-09" },
  { mrn: "990106", name: "Brightwater, Sol", birth_date: "1969-12-01" },
  { mrn: "990107", name: "Kestrel, Avery", birth_date: "1987-03-30" },
  { mrn: "990108", name: "Linden, Mae", birth_date: "1952-06-18" },
  { mrn: "990109", name: "Okafor-Reyes, Tam", birth_date: "1979-08-08" },
] as const;

type Spec = SimulatedOrder["specimens"][number];

const spec = (designation: string, site: string, laterality: string | null, procedure: string, expected = 1, collectedAt: string | null = null): Spec => ({
  designation,
  site,
  laterality,
  procedure,
  collected_at: collectedAt,
  expected_containers: expected,
  requested_stains: [],
  orientation: null,
});

function newOrder(w: SimWorld, o: { orderId: string; version: number; at: string; patient: SimPatient; specimens: Spec[]; status?: "active" | "amended" | "canceled" }): SimulatedOrder {
  return {
    resourceType: "SimulatedOrder",
    order_id: o.orderId,
    version: o.version,
    updated_at: o.at,
    status: o.status ?? "active",
    patient: { ...o.patient },
    encounter_id: null,
    office_id: w.ema.officeId,
    ordering_provider_id: w.ema.providerId,
    clinical_note: null,
    amendment_note: null,
    specimens: o.specimens,
  };
}

// ------------------------------------------------------------------ signing and transport

export const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** The URL, or an error when it is not plain http(s) to a loopback host. The simulator never talks to anything else. */
export function assertLoopbackUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Not a URL: ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Only http(s) URLs are accepted.");
  if (url.username || url.password) throw new Error("URLs with credentials are refused.");
  if (!LOOPBACK_HOSTS.has(url.hostname.toLowerCase())) {
    throw new Error(`Refused: ${url.hostname} is not a loopback host. The integration simulator only talks to this machine (localhost, 127.0.0.1, ::1).`);
  }
  return url;
}

export interface TransportReply {
  status: number;
  body: unknown;
  retryAfterSeconds?: number;
}

export class TransportError extends Error {
  constructor(
    readonly kind: "network" | "timeout" | "redirect",
    message: string,
  ) {
    super(message);
  }
}

export interface Transport {
  readonly name: string;
  /** Send one signed body. Resolves with the HTTP reply; rejects with TransportError when nothing came back. */
  post(body: string, headers: Record<string, string>, timeoutMs: number): Promise<TransportReply>;
}

/** POST to the app's inbound endpoint over HTTP (loopback only, no redirects, per-request timeout). */
export function httpTransport(baseOrEndpoint: string): Transport {
  const url = assertLoopbackUrl(baseOrEndpoint);
  if (!url.pathname || url.pathname === "/") url.pathname = "/api/integration/inbound";
  const target = url.toString();
  return {
    name: `http ${target}`,
    async post(body, headers, timeoutMs) {
      let res: Response;
      try {
        res = await fetch(target, { method: "POST", headers, body, redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
      } catch (e) {
        const name = (e as { name?: string })?.name;
        if (name === "TimeoutError" || name === "AbortError") throw new TransportError("timeout", `No answer within ${timeoutMs} ms`);
        const cause = (e as { cause?: { code?: string } })?.cause?.code;
        throw new TransportError("network", cause ? `Unreachable (${cause})` : "Unreachable");
      }
      if (res.status >= 300 && res.status < 400) throw new TransportError("redirect", `Redirect (${res.status}) refused: the simulator never follows redirects`);
      let parsed: unknown = null;
      try {
        parsed = await res.json();
      } catch {
        parsed = null;
      }
      const ra = Number(res.headers.get("retry-after"));
      return { status: res.status, body: parsed, ...(Number.isFinite(ra) && ra >= 0 && res.headers.has("retry-after") ? { retryAfterSeconds: ra } : {}) };
    },
  };
}

/** A loopback port with nothing listening on it (a real "connection refused"): the outage target over HTTP. */
export async function closedLoopbackPort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

/**
 * Wrap a transport so an outage can be switched on: while it is on, every request goes to a loopback port where
 * nothing listens (a real "connection refused", never a fake reply). The CLI's and the HTTP test's outage.
 */
export function outageSwitch(real: Transport): { transport: Transport; outage: OutageControl } {
  let down: Transport | null = null;
  const transport: Transport = {
    get name() {
      return down ? `${real.name} (link down)` : real.name;
    },
    post: (body, headers, timeoutMs) => (down ?? real).post(body, headers, timeoutMs),
  };
  const outage: OutageControl = {
    description: "the source's link to the laboratory is down (requests go to a loopback port where nothing listens: connection refused)",
    async begin() {
      if (!down) down = httpTransport(`http://127.0.0.1:${await closedLoopbackPort()}/api/integration/inbound`);
    },
    async end() {
      down = null;
    },
  };
  return { transport, outage };
}

export interface SignOptions {
  /** Sign as another source (the header and key), e.g. an unknown source id. */
  asSourceId?: string;
  /** Shift the signature timestamp (seconds), e.g. -600 for an old timestamp. */
  timestampOffsetSeconds?: number;
  /** Sign with a wrong key. */
  wrongKey?: boolean;
}

/** Headers for one delivery attempt: a fresh timestamp each time (the body is unchanged). */
export function signedHeaders(rootSecret: string, envelope: SourceEnvelope, body: string, nowMs: number, opts: SignOptions = {}): Record<string, string> {
  const sourceId = opts.asSourceId ?? envelope.source_id;
  const t = Math.floor(nowMs / 1000) + (opts.timestampOffsetSeconds ?? 0);
  const key = deriveSourceSecret(opts.wrongKey ? `${rootSecret}-wrong` : rootSecret, sourceId);
  return {
    "content-type": "application/json",
    [SOURCE_HEADER]: sourceId,
    [SIGNATURE_HEADER]: signatureHeader(key, t, body),
    "x-request-id": `sim-${crypto.createHash("sha256").update(`${envelope.message_id}:${t}`).digest("hex").slice(0, 24)}`,
  };
}

// ------------------------------------------------------------------ delivery: timeout, backoff with jitter, attempts

export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  timeoutMs: number;
}

export const DEFAULT_RETRY: RetryPolicy = { maxAttempts: 5, baseDelayMs: 500, maxDelayMs: 8_000, timeoutMs: 5_000 };

/** Deterministic PRNG (mulberry32) seeded from text: the same message always gets the same jitter. */
export function seededRandom(seed: string): () => number {
  let a = crypto.createHash("sha256").update(seed).digest().readUInt32LE(0);
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Delay before attempt n+1 ("equal jitter"): half of min(max, base·2^(n-1)) plus a random share of the other
 * half; never less than the server's Retry-After (capped at maxDelayMs).
 */
export function backoffDelayMs(attempt: number, policy: RetryPolicy, random: () => number, retryAfterSeconds?: number): number {
  const exp = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** Math.max(0, attempt - 1));
  const jittered = Math.round(exp / 2 + random() * (exp / 2));
  const floor = retryAfterSeconds !== undefined ? Math.min(policy.maxDelayMs, retryAfterSeconds * 1000) : 0;
  return Math.max(jittered, floor);
}

/** How a delivery ended, from the source's point of view. */
export type ReplyKind =
  | "accepted"
  | "duplicate"
  | "stale"
  | "conflict_review"
  | "rejected" // 400 / 413 / 415: invalid data (kept in the receiver's failure queue when it reached the importer)
  | "unauthorized" // 401: signature or source refused, nothing recorded
  | "unsupported_version" // 422
  | "not_found" // 404: the endpoint is not enabled
  | "failed" // 500: received, kept in the failure queue, retry later (retries exhausted)
  | "unavailable" // 503: busy or source offline, retries exhausted (kept in the outbox)
  | "undelivered" // no answer: network error or timeout, retries exhausted (kept in the outbox)
  | "refused_redirect";

export interface AttemptReport {
  attempt: number;
  httpStatus: number | null;
  error: string | null;
  /** The wait before the next attempt (ms), when there is one. */
  waitMs: number | null;
}

export interface DeliveryReport {
  messageId: string;
  messageType: string;
  result: ReplyKind;
  httpStatus: number | null;
  body: unknown;
  attempts: AttemptReport[];
  /** True when the message must stay in the outbox (no definitive answer). */
  keep: boolean;
}

export interface DeliveryDeps {
  transport: Transport;
  rootSecret: string;
  policy: RetryPolicy;
  sleep: (ms: number) => Promise<void>;
  nowMs: () => number;
}

function classify(status: number, body: unknown): ReplyKind {
  if (status === 200) {
    const s = (body as { status?: string } | null)?.status;
    return s === "duplicate" || s === "stale" || s === "conflict_review" ? s : "accepted";
  }
  if (status === 401) return "unauthorized";
  if (status === 404) return "not_found";
  if (status === 422) return "unsupported_version";
  if (status === 503) return "unavailable";
  if (status >= 500) return "failed";
  return "rejected";
}

/** 5xx, 408, 425 and 429 are worth retrying; any other 4xx is a NAK: stop. */
function retryable(status: number): boolean {
  return status >= 500 || status === 408 || status === 425 || status === 429;
}

/** Sign and deliver one envelope: per-request timeout, backoff with jitter between attempts, at most maxAttempts, no retry after a NAK. */
export async function deliver(envelope: SourceEnvelope, deps: DeliveryDeps, sign: SignOptions = {}): Promise<DeliveryReport> {
  const body = JSON.stringify(envelope);
  const random = seededRandom(`${envelope.source_id}:${envelope.message_id}`);
  const attempts: AttemptReport[] = [];
  let last: { status: number | null; body: unknown; error: string | null; kind: ReplyKind } = { status: null, body: null, error: null, kind: "undelivered" };
  for (let attempt = 1; attempt <= deps.policy.maxAttempts; attempt++) {
    const headers = signedHeaders(deps.rootSecret, envelope, body, deps.nowMs(), sign);
    let retryAfter: number | undefined;
    let again = false;
    try {
      const reply = await deps.transport.post(body, headers, deps.policy.timeoutMs);
      last = { status: reply.status, body: reply.body, error: null, kind: classify(reply.status, reply.body) };
      retryAfter = reply.retryAfterSeconds;
      again = retryable(reply.status);
    } catch (e) {
      const te = e instanceof TransportError ? e : new TransportError("network", e instanceof Error ? e.message : String(e));
      last = { status: null, body: null, error: te.message, kind: te.kind === "redirect" ? "refused_redirect" : "undelivered" };
      again = te.kind !== "redirect";
    }
    const report: AttemptReport = { attempt, httpStatus: last.status, error: last.error, waitMs: null };
    attempts.push(report);
    if (!again || attempt === deps.policy.maxAttempts) break;
    report.waitMs = backoffDelayMs(attempt, deps.policy, random, retryAfter);
    await deps.sleep(report.waitMs);
  }
  const keep = last.kind === "undelivered" || last.kind === "unavailable" || last.kind === "failed";
  return { messageId: envelope.message_id, messageType: envelope.message_type, result: last.kind, httpStatus: last.status, body: last.body, attempts, keep };
}

// ------------------------------------------------------------------ scenarios

export const SCENARIOS = [
  { n: 1, name: "new-order", title: "New order" },
  { n: 2, name: "specimen-submitted", title: "Specimen submitted with an order" },
  { n: 3, name: "multiple-specimens", title: "Multiple specimens on one order" },
  { n: 4, name: "amended-order", title: "Amended order" },
  { n: 5, name: "duplicate", title: "Duplicate message" },
  { n: 6, name: "conflicting-identifiers", title: "Conflicting identifiers" },
  { n: 7, name: "missing-data", title: "Missing required data" },
  { n: 8, name: "out-of-order", title: "Out-of-order versions (v3 then v2)" },
  { n: 9, name: "delayed-ack", title: "Delayed acknowledgment of an accession request" },
  { n: 10, name: "source-outage", title: "Source outage (backs off, nothing lost)" },
  { n: 11, name: "recovery", title: "Recovery after the outage (backlog delivered exactly once)" },
  { n: 12, name: "unexpected-version", title: "Unexpected contract or source version, unknown source" },
] as const;
export type ScenarioName = (typeof SCENARIOS)[number]["name"];

export function scenarioByName(nameOrNumber: string): (typeof SCENARIOS)[number] | undefined {
  return SCENARIOS.find((s) => s.name === nameOrNumber || String(s.n) === nameOrNumber);
}

export interface StepReport extends DeliveryReport {
  label: string;
  expected: ReplyKind[];
  ok: boolean;
  /** NAK errors, when any. */
  errors: ContractError[];
}

export interface ScenarioReport {
  scenario: ScenarioName;
  n: number;
  title: string;
  steps: StepReport[];
  notes: string[];
  /** Message ids still in the simulator's outbox at the end (kept, never dropped). */
  backlog: string[];
  skipped: boolean;
  ok: boolean;
}

/** How the scenario makes the source unreachable: over HTTP, a closed loopback port; in-process, the source set offline here. */
export interface OutageControl {
  readonly description: string;
  begin(): Promise<void>;
  end(): Promise<void>;
}

export interface DelayedAckParams {
  /** The lab's accession request id (AR-0001). */
  requestId?: string;
  /** The number the source holds for it (omit to acknowledge the request only). */
  accessionNumber?: string | null;
  namespace?: string | null;
  /** How late the acknowledgment arrives (ms). */
  delayMs?: number;
}

/** The simulated source's own memory across scenarios: its outbox (backlog) and whether its link is down. */
export class SimSourceState {
  outbox: SourceEnvelope[] = [];
  outageActive = false;
}

export interface RunDeps {
  transport: Transport;
  rootSecret: string;
  world: SimWorld;
  outage: OutageControl;
  policy?: Partial<RetryPolicy>;
  sleep?: (ms: number) => Promise<void>;
  nowMs?: () => number;
  delayedAck?: DelayedAckParams;
  /** Shared across scenarios (the CLI's `all`): 11 delivers what 10 left in the outbox. */
  state?: SimSourceState;
  log?: (line: string) => void;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

class Runner {
  readonly steps: StepReport[] = [];
  readonly notes: string[] = [];
  readonly deps: DeliveryDeps;
  readonly state: SimSourceState;

  constructor(readonly run: RunDeps) {
    this.deps = {
      transport: run.transport,
      rootSecret: run.rootSecret,
      policy: { ...DEFAULT_RETRY, ...(run.policy ?? {}) },
      sleep: run.sleep ?? realSleep,
      nowMs: run.nowMs ?? Date.now,
    };
    this.state = run.state ?? new SimSourceState();
  }

  get w(): SimWorld {
    return this.run.world;
  }

  /** A fixed time on the demo day (lab-local hh:mm). Deterministic. */
  at(hhmm: string): string {
    return labLocalToIso(this.w.day, hhmm);
  }

  env(sourceId: string, messageId: string, messageType: string, sentAt: string, payload: unknown, extra: { contractVersion?: string; correlationId?: string } = {}): SourceEnvelope {
    return makeEnvelope({ sourceId, messageId, messageType, sentAt, payload, correlationId: extra.correlationId ?? `sim-${messageId.replace(/[^A-Za-z0-9._:-]/g, "-")}`.slice(0, 100), contractVersion: extra.contractVersion });
  }

  log(line: string) {
    this.run.log?.(line);
  }

  record(label: string, report: DeliveryReport, expected: ReplyKind[]): StepReport {
    const errors = Array.isArray((report.body as { errors?: unknown } | null)?.errors) ? ((report.body as { errors: ContractError[] }).errors ?? []) : [];
    const step: StepReport = { ...report, label, expected, ok: expected.includes(report.result), errors };
    this.steps.push(step);
    const tries = report.attempts.length > 1 ? ` after ${report.attempts.length} attempts` : "";
    // A duplicate where a first delivery was expected: this message was already delivered by an earlier run.
    const rerun = !step.ok && report.result === "duplicate";
    const mark = step.ok ? "ok  " : rerun ? "dup " : "FAIL";
    const why = step.ok ? "" : rerun ? " — already delivered by an earlier run" : ` — expected ${expected.join(" or ")}`;
    this.log(`  ${mark} ${label}: ${report.messageId} → ${report.result}${report.httpStatus ? ` (HTTP ${report.httpStatus})` : ""}${tries}${why}`);
    for (const e of errors.slice(0, 4)) this.log(`         ${e.path}: ${e.code}`);
    return step;
  }

  async send(label: string, envelope: SourceEnvelope, expected: ReplyKind[], sign: SignOptions = {}): Promise<StepReport> {
    // While the source's own link is down it cannot send: the message joins the outbox, in order.
    const report = await deliver(envelope, this.deps, sign);
    if (report.keep) this.state.outbox.push(envelope);
    return this.record(label, report, expected);
  }

  /** Deliver the outbox in order; stop at the first message that still cannot be delivered (keeps the order). */
  async flush(label: string, expected: ReplyKind[]): Promise<StepReport[]> {
    const out: StepReport[] = [];
    while (this.state.outbox.length) {
      const envelope = this.state.outbox[0];
      const report = await deliver(envelope, this.deps);
      out.push(this.record(`${label} (${envelope.message_id})`, report, expected));
      if (report.keep) break;
      this.state.outbox.shift();
    }
    return out;
  }

  wait(ms: number) {
    return ms > 0 ? this.deps.sleep(ms) : Promise.resolve();
  }
}

type ScenarioFn = (r: Runner) => Promise<boolean | void>;

const ORDER = (n: number) => `SIM-${90000 + n}`;
const mid = (scenario: string, orderId: string, version: number, suffix = "") => `sim/${scenario}/${orderId}#v${version}${suffix}`;

/** The two orders the outage scenarios send (shared by 10 and 11, so 11 can rebuild the backlog on its own). */
function outageEnvelopes(r: Runner): SourceEnvelope[] {
  const p1 = SYNTHETIC_PATIENTS[6];
  const p2 = SYNTHETIC_PATIENTS[7];
  return [
    r.env(r.w.ema.sourceId, mid("outage", ORDER(1001), 1), "order.upsert", r.at("10:36"), newOrder(r.w, { orderId: ORDER(1001), version: 1, at: r.at("10:36"), patient: p1, specimens: [spec("A", "Left shoulder", "left", "shave")] })),
    r.env(r.w.ema.sourceId, mid("outage", ORDER(1002), 1), "order.upsert", r.at("10:37"), newOrder(r.w, { orderId: ORDER(1002), version: 1, at: r.at("10:37"), patient: p2, specimens: [spec("A", "Right calf", "right", "punch")] })),
  ];
}

async function outagePhase(r: Runner): Promise<void> {
  r.notes.push(`Outage: ${r.run.outage.description}.`);
  await r.run.outage.begin();
  r.state.outageActive = true;
  for (const e of outageEnvelopes(r)) {
    // Each message backs off and gives up after the maximum attempts; it stays in the outbox.
    await r.send("sent during the outage", e, ["undelivered", "unavailable"]);
  }
  r.notes.push(`Backlog kept by the source: ${r.state.outbox.map((e) => e.message_id).join(", ") || "none"}.`);
}

const SCENARIO_FNS: Record<ScenarioName, ScenarioFn> = {
  "new-order": async (r) => {
    const o = newOrder(r.w, { orderId: ORDER(101), version: 1, at: r.at("10:31"), patient: SYNTHETIC_PATIENTS[0], specimens: [spec("A", "Left upper back", "left", "shave")] });
    await r.send("new order", r.env(r.w.ema.sourceId, mid("new-order", o.order_id, 1), "order.upsert", o.updated_at, o), ["accepted"]);
  },

  "specimen-submitted": async (r) => {
    const v1 = newOrder(r.w, { orderId: ORDER(201), version: 1, at: r.at("10:32"), patient: SYNTHETIC_PATIENTS[1], specimens: [] });
    await r.send("order placed (no specimen yet)", r.env(r.w.ema.sourceId, mid("specimen-submitted", v1.order_id, 1), "order.upsert", v1.updated_at, v1), ["accepted"]);
    const v2 = { ...v1, version: 2, updated_at: r.at("10:34"), specimens: [spec("A", "Right forearm, dorsal", "right", "punch", 1, r.at("10:20"))], submitted: [{ designation: "A", containers: 1 }] };
    await r.send("specimen A recorded as sent", r.env(r.w.ema.sourceId, mid("specimen-submitted", v1.order_id, 2), "specimen.submitted", v2.updated_at, v2), ["accepted"]);
  },

  "multiple-specimens": async (r) => {
    const o = {
      ...newOrder(r.w, {
        orderId: ORDER(301),
        version: 1,
        at: r.at("10:33"),
        patient: SYNTHETIC_PATIENTS[2],
        specimens: [spec("A", "Scalp, vertex", "midline", "shave"), spec("B", "Left cheek", "left", "punch"), spec("C", "Right shin", "right", "excision", 2)],
      }),
      submitted: [
        { designation: "A", containers: 1 },
        { designation: "B", containers: 1 },
        { designation: "C", containers: 2 },
      ],
    };
    await r.send("three specimens sent with one order", r.env(r.w.ema.sourceId, mid("multiple-specimens", o.order_id, 1), "specimen.submitted", o.updated_at, o), ["accepted"]);
  },

  "amended-order": async (r) => {
    const base = r.w.amendable;
    const v = base.version + 1;
    const amended: SimulatedOrder = {
      ...base,
      version: v,
      updated_at: r.at("10:40"),
      status: "amended",
      amendment_note: "Site clarified by the office (synthetic)",
      specimens: base.specimens.map((s, i) => (i === 0 ? { ...s, site: `${s.site} (lateral aspect)` } : s)),
    };
    await r.send("amendment", r.env(r.w.ema.sourceId, mid("amended-order", base.order_id, v), "order.amend", amended.updated_at, amended), ["accepted"]);
  },

  duplicate: async (r) => {
    const o = newOrder(r.w, { orderId: ORDER(501), version: 1, at: r.at("10:35"), patient: SYNTHETIC_PATIENTS[3], specimens: [spec("A", "Left knee", "left", "shave")] });
    const e = r.env(r.w.ema.sourceId, mid("duplicate", o.order_id, 1), "order.upsert", o.updated_at, o);
    await r.send("first delivery", e, ["accepted"]);
    await r.send("same message again", e, ["duplicate"]);
    await r.send("and again", e, ["duplicate"]);
  },

  "conflicting-identifiers": async (r) => {
    const onFile = r.w.patientOnFile;
    const a = newOrder(r.w, {
      orderId: ORDER(601),
      version: 1,
      at: r.at("10:38"),
      patient: { mrn: onFile.mrn, name: "Fairbrook, Wren", birth_date: "1944-01-01" },
      specimens: [spec("A", "Right temple", "right", "shave")],
    });
    await r.send("existing MRN, different name and date of birth", r.env(r.w.ema.sourceId, mid("conflicting-identifiers", a.order_id, 1), "order.upsert", a.updated_at, a), ["conflict_review"]);
    const base = r.w.accessioned;
    const v = base.version + 1;
    const b: SimulatedOrder = { ...base, version: v, updated_at: r.at("10:39"), status: "amended", patient: { ...SYNTHETIC_PATIENTS[4] } };
    await r.send("existing order id under a different MRN", r.env(r.w.ema.sourceId, mid("conflicting-identifiers", base.order_id, v), "order.amend", b.updated_at, b), ["conflict_review"]);
  },

  "missing-data": async (r) => {
    const o = newOrder(r.w, { orderId: ORDER(701), version: 1, at: r.at("10:41"), patient: SYNTHETIC_PATIENTS[5], specimens: [spec("A", "Left ear", "left", "shave")] });
    const broken = { ...o, patient: { mrn: o.patient.mrn, name: o.patient.name }, specimens: [{ ...o.specimens[0], site: undefined }] };
    await r.send("birth date and site missing", r.env(r.w.ema.sourceId, mid("missing-data", o.order_id, 1), "order.upsert", o.updated_at, broken), ["rejected"]);
  },

  "out-of-order": async (r) => {
    const v1 = newOrder(r.w, { orderId: ORDER(801), version: 1, at: r.at("10:42"), patient: SYNTHETIC_PATIENTS[8], specimens: [spec("A", "Left wrist", "left", "shave")] });
    const v2 = { ...v1, version: 2, updated_at: r.at("10:44"), status: "amended" as const, specimens: [spec("A", "Left wrist, volar", "left", "shave")] };
    const v3 = { ...v1, version: 3, updated_at: r.at("10:46"), status: "amended" as const, specimens: [spec("A", "Left wrist, dorsal", "left", "shave")] };
    await r.send("v1", r.env(r.w.ema.sourceId, mid("out-of-order", v1.order_id, 1), "order.upsert", v1.updated_at, v1), ["accepted"]);
    await r.send("v3 (arrives before v2)", r.env(r.w.ema.sourceId, mid("out-of-order", v1.order_id, 3), "order.amend", v3.updated_at, v3), ["accepted"]);
    await r.send("v2 (late)", r.env(r.w.ema.sourceId, mid("out-of-order", v1.order_id, 2), "order.amend", v2.updated_at, v2), ["stale"]);
  },

  "delayed-ack": async (r) => {
    const p = r.run.delayedAck ?? {};
    if (!p.requestId) {
      r.notes.push(
        "Needs the laboratory's accession request id: request an accession on the Intake screen (or run guided demo step 4), then run this scenario with --request AR-0001 [--accession D26-04818]. Until the acknowledgment arrives, the reconciliation view lists the request as waiting.",
      );
      return false;
    }
    r.notes.push(`Waiting ${p.delayMs ?? 0} ms before the source acknowledges ${p.requestId} (the request shows as waiting meanwhile).`);
    await r.wait(p.delayMs ?? 0);
    const payload = {
      request_id: p.requestId,
      ...(p.accessionNumber ? { accession_number: p.accessionNumber, namespace: p.namespace ?? "EMA-SIM DERM" } : {}),
      acknowledged_at: r.at("10:50"),
    };
    await r.send("late acknowledgment", r.env(r.w.ema.sourceId, `sim/delayed-ack/${p.requestId}${p.accessionNumber ? `/${p.accessionNumber}` : ""}`, "accession.acknowledged", payload.acknowledged_at, payload), ["accepted", "duplicate"]);
  },

  "source-outage": async (r) => {
    await outagePhase(r);
    await r.run.outage.end();
    r.state.outageActive = false;
    r.notes.push("The link is back; the backlog is still in the source's outbox (run recovery to deliver it).");
  },

  recovery: async (r) => {
    if (!r.state.outbox.length) {
      await outagePhase(r);
    }
    if (r.state.outageActive || r.state.outbox.length) {
      await r.run.outage.end();
      r.state.outageActive = false;
    }
    const backlog = [...r.state.outbox];
    await r.flush("backlog delivered", ["accepted"]);
    for (const e of backlog) await r.send("re-sent once more", e, ["duplicate"]);
  },

  "unexpected-version": async (r) => {
    const o = newOrder(r.w, { orderId: ORDER(1201), version: 1, at: r.at("10:47"), patient: SYNTHETIC_PATIENTS[0], specimens: [spec("A", "Right hand, dorsal", "right", "shave")] });
    await r.send("contract 2.0", r.env(r.w.ema.sourceId, mid("unexpected-version", o.order_id, 1, "-c2"), "order.upsert", o.updated_at, o, { contractVersion: "2.0" }), ["unsupported_version"]);
    const v2 = { ...o, order_id: ORDER(1202), version: 2, updated_at: r.at("10:48") };
    const v1 = { ...v2, version: 1, updated_at: r.at("10:45") };
    await r.send("v2", r.env(r.w.ema.sourceId, mid("unexpected-version", v2.order_id, 2), "order.upsert", v2.updated_at, v2), ["accepted"]);
    await r.send("v1 (lower than stored)", r.env(r.w.ema.sourceId, mid("unexpected-version", v2.order_id, 1), "order.upsert", v1.updated_at, v1), ["stale"]);
    const unknown = r.env("src_unknown", mid("unexpected-version", ORDER(1203), 1), "order.upsert", o.updated_at, { ...o, order_id: ORDER(1203) });
    await r.send("unknown source id", unknown, ["unauthorized"]);
  },
};

/** Run one scenario. Resolves with its report; never throws for a refused or failed delivery. */
export async function runScenario(name: ScenarioName, deps: RunDeps): Promise<ScenarioReport> {
  const def = SCENARIOS.find((s) => s.name === name);
  if (!def) throw new Error(`Unknown scenario ${name}`);
  const r = new Runner(deps);
  r.log(`${def.n}. ${def.title}`);
  const result = await SCENARIO_FNS[name](r);
  const skipped = result === false;
  for (const n of r.notes) r.log(`     ${n}`);
  return {
    scenario: def.name,
    n: def.n,
    title: def.title,
    steps: r.steps,
    notes: r.notes,
    backlog: r.state.outbox.map((e) => e.message_id),
    skipped,
    ok: !skipped && r.steps.length > 0 && r.steps.every((s) => s.ok),
  };
}

export { CONTRACT_VERSION };
