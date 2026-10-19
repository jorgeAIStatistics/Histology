/**
 * Structured server log (Stage 6 Phase C4). One JSON line per event:
 *
 *   {"ts":"2026-10-19T12:00:00.000Z","level":"error","event":"command.unexpected_error",
 *    "correlationId":"c-abc","command":"hold.place","error":{"name":"TypeError","message":"…","at":"src/…:12"}}
 *
 * SAFE FIELDS ONLY. The logger is built so that a call site cannot dump a
 * payload by accident:
 * - Field names must be plain identifiers (letters, digits, "_"); anything else is dropped.
 * - Values are kept only when they are primitives (string, number, boolean, null). Objects and
 *   arrays are replaced by a type marker, never serialized. An Error (or the field `error`) is
 *   reduced to its name, a code, a scrubbed and shortened message and the first stack frame's
 *   location; never the stack text.
 * - Field names that carry secrets (secret, token, password, authorization, cookie, session id,
 *   nonce, verifier, *key) are replaced by "[redacted]".
 * - Field names that carry patient details (patient, name, birth date, dob, MRN, label...) are
 *   replaced by "[redacted:patient]".
 * - Field names that carry request or record content (body, payload, input, before, after,
 *   evidence, question, answer, note, reason, summary, detail, text, value, headers, query, data...)
 *   are replaced by "[redacted:payload]".
 * - Every string value is scrubbed: Bearer credentials, JWTs, cookie pairs, long hex or base64
 *   runs, dates without a time (a birth date looks like one), and runs of 6 or more digits (an
 *   MRN looks like one) are replaced; then it is cut to 200 characters.
 *
 * LIMITATION: a name inside free text cannot be recognised by pattern. Call sites pass record ids,
 * codes and counts, never payloads, and error messages are scrubbed and shortened; a person's name
 * that an error message happens to quote would still be written. docs/release/data-protection.md.
 *
 * Output: warn and error to stderr, info and debug to stdout. HLOS_LOG_LEVEL (debug | info | warn |
 * error, default info) sets the threshold. Tests can capture lines with setLogSink().
 */

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFields = Record<string, unknown>;

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_]{0,47}$/;
const EVENT_NAME = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/;
const CORRELATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;

/** Secrets and credentials. */
const SECRET_KEY = /secret|token|passw|pwd|authoriz|^auth$|cookie|^session$|sessionid|session_id|^sid$|credential|apikey|api_key|privatekey|private_key|signature|nonce|verifier|^key$|[a-z]Key$|_key$/i;
/** Patient details. */
const PATIENT_KEY = /patient|^name$|fullname|full_name|familyname|family_name|givenname|given_name|birth|^dob$|mrn|label|address|phone|email|^ssn$/i;
/** Request or record content. */
const PAYLOAD_KEY = /body|payload|^input$|before|after|evidence|question|answer|^notes?$|reason|summary|detail|description|^text$|^value$|values|^result$|request|response|headers|^query$|params|^data$|json|^raw/i;

export const REDACTED = "[redacted]";
export const REDACTED_PATIENT = "[redacted:patient]";
export const REDACTED_PAYLOAD = "[redacted:payload]";

const MAX_STRING = 200;

/** Patterns replaced inside every string value. Order matters: credentials first. */
const SCRUB: [RegExp, string][] = [
  [/\bBearer\s+[^\s,;"']+/gi, "Bearer [redacted]"],
  [/\bBasic\s+[A-Za-z0-9+/=]{8,}/gi, "Basic [redacted]"],
  [/\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g, "[redacted:jwt]"],
  // cookie pairs and query parameters (hlos_session=…, __Host-hlos_session=…, code=…, state=…, token=…)
  [/((?:__Host-)?[A-Za-z0-9_-]*(?:session|token|secret|auth|sid|code|state|key|passw)[A-Za-z0-9_-]*=)("[^"]*"|[^\s&;,"']+)/gi, "$1[redacted]"],
  // JSON members ("clientSecret":"…")
  [/("[A-Za-z0-9_-]*(?:session|token|secret|passw|authoriz|cookie|apikey|api_key)[A-Za-z0-9_-]*"\s*:\s*)"[^"]*"/gi, '$1"[redacted]"'],
  [/\b[0-9a-f]{32,}\b/gi, "[redacted:hex]"],
  [/[A-Za-z0-9+/_-]{40,}={0,2}/g, "[redacted:long]"],
  [/\b(?:1[89]|20)\d{2}-\d{2}-\d{2}(?!T|\d)/g, "[date]"],
  [/\b\d{1,2}\/\d{1,2}\/(?:\d{4}|\d{2})\b/g, "[date]"],
  [/(?<![A-Za-z0-9])\d{6,}(?![A-Za-z0-9])/g, "[digits]"],
];

/** Scrubs credentials, birth-date-like dates and MRN-like numbers out of a string, then shortens it. */
export function scrubText(text: string, max = MAX_STRING): string {
  let out = text;
  for (const [re, by] of SCRUB) out = out.replace(re, by);
  out = out.replace(/[\u0000-\u001f\u007f]+/g, " ");
  return out.length > max ? `${out.slice(0, max - 1)}…` : out;
}

export interface LoggedError {
  name: string;
  code?: string;
  message: string;
  /** "file:line" of the first stack frame inside the project (no stack text, no message). */
  at?: string;
}

/** An error reduced to what is safe to log. */
export function errorInfo(e: unknown): LoggedError {
  if (e instanceof Error) {
    const code = (e as { code?: unknown }).code;
    // A subclass that does not set `name` (DomainError) is named by its constructor.
    const name = e.name && e.name !== "Error" ? e.name : e.constructor?.name || "Error";
    const info: LoggedError = { name: scrubText(name, 60), message: scrubText(e.message ?? "") };
    if (typeof code === "string" && /^[A-Z][A-Z0-9_]{1,47}$/.test(code)) info.code = code;
    const frame = (e.stack ?? "")
      .split("\n")
      .slice(1)
      .map((l) => {
        const t = l.trim();
        if (!t.startsWith("at ")) return null;
        const inner = t.endsWith(")") && t.includes("(") ? t.slice(t.lastIndexOf("(") + 1, -1) : t.slice(3);
        return /^(.*):(\d+):\d+$/.exec(inner);
      })
      .find((m) => m && !m[1].includes("node_modules") && !m[1].startsWith("node:"));
    if (frame) {
      const file = frame[1].replace(/^file:\/\//, "");
      const cwd = `${process.cwd()}/`;
      const rel = file.startsWith(cwd) ? file.slice(cwd.length) : file.includes("/src/") ? file.slice(file.indexOf("/src/") + 1) : file.split("/").slice(-2).join("/");
      info.at = `${scrubText(rel, 120)}:${frame[2]}`;
    }
    return info;
  }
  if (typeof e === "string") return { name: "Error", message: scrubText(e) };
  return { name: typeof e, message: "non-Error value thrown" };
}

function safeValue(key: string, value: unknown): unknown {
  if (key === "error" || value instanceof Error) return errorInfo(value);
  if (SECRET_KEY.test(key)) return REDACTED;
  if (PATIENT_KEY.test(key)) return REDACTED_PATIENT;
  if (PAYLOAD_KEY.test(key)) return REDACTED_PAYLOAD;
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return scrubText(value);
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "boolean") return value;
  if (typeof value === "bigint") return scrubText(value.toString());
  if (Array.isArray(value)) return `[array:${value.length}]`;
  return `[${typeof value}]`;
}

/** The fields a line will carry: safe names, safe values; anything else dropped or replaced. */
export function safeFields(fields: LogFields): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let dropped = 0;
  for (const [k, v] of Object.entries(fields ?? {})) {
    if (k === "correlationId" || k === "ts" || k === "level" || k === "event") continue;
    if (!FIELD_NAME.test(k)) {
      dropped += 1;
      continue;
    }
    out[k] = safeValue(k, v);
  }
  if (dropped) out.droppedFields = dropped;
  return out;
}

/** One JSON line (no trailing newline). */
export function formatLogLine(level: LogLevel, event: string, fields: LogFields = {}, now: Date = new Date()): string {
  const line: Record<string, unknown> = { ts: now.toISOString(), level, event: EVENT_NAME.test(event) ? event : "invalid_event_name" };
  const cid = fields.correlationId;
  if (typeof cid === "string" && CORRELATION_ID.test(cid)) line.correlationId = cid;
  Object.assign(line, safeFields(fields));
  return JSON.stringify(line);
}

export type LogSink = (level: LogLevel, line: string) => void;

const defaultSink: LogSink = (level, line) => {
  const stream = level === "error" || level === "warn" ? process.stderr : process.stdout;
  try {
    stream.write(`${line}\n`);
  } catch {
    /* logging never breaks a request */
  }
};

let sink: LogSink = defaultSink;

/** Replace where lines go (tests); returns a function that restores the previous sink. */
export function setLogSink(next: LogSink): () => void {
  const previous = sink;
  sink = next;
  return () => {
    sink = previous;
  };
}

function threshold(): number {
  const v = process.env.HLOS_LOG_LEVEL?.trim().toLowerCase();
  return v && v in LEVELS ? LEVELS[v as LogLevel] : LEVELS.info;
}

/** Writes one structured line. Never throws. */
export function log(level: LogLevel, event: string, fields: LogFields = {}): void {
  try {
    if (LEVELS[level] < threshold()) return;
    sink(level, formatLogLine(level, event, fields));
  } catch {
    /* logging never breaks a request */
  }
}

export const logger = {
  debug: (event: string, fields?: LogFields) => log("debug", event, fields),
  info: (event: string, fields?: LogFields) => log("info", event, fields),
  warn: (event: string, fields?: LogFields) => log("warn", event, fields),
  error: (event: string, fields?: LogFields) => log("error", event, fields),
};
