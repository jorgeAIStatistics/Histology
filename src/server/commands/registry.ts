import { z } from "zod";
import type { DB } from "../db/db";
import type { Permission } from "@/lib/roles";
import { DomainError, type DomainErrorCode } from "../core/errors";
import { type Ctx, type Origin, loadActor, makeCtx, requirePermission, SYSTEM_ACTOR } from "../core/context";
import { audit } from "../core/audit";
import { log } from "../core/log";
import {
  assertValidKey,
  checkRepeat,
  ensureReceiptSchema,
  findReceipt,
  insertReceipt,
  labScope,
  maybeRunReceiptMaintenance,
  requestFingerprint,
} from "../core/idempotency";
import { sessionRefFor } from "../core/audit-seal";
import { LOCKED_MESSAGE, runtimeMode } from "../runtime-mode";
import type { CommandAuth } from "../auth/guard";
import { isReauthFresh, sessionPolicyFromEnv } from "../auth/sessions";
import { auditSignedInRefusal, refusalGate } from "../auth/refusals";

export interface CommandDef<S extends z.ZodType, R> {
  name: string;
  description: string;
  /** Checked on the server before the handler runs. `null` = demo/system command open to any demo role. */
  permission: Permission | null;
  /**
   * "presenter": a demo-only control (simulated world events, clock, outages,
   * guided steps). Refused outside synthetic demo mode, listed separately in
   * the presenter console, never shown as a bench action. Default "lab".
   */
  audience?: "lab" | "presenter";
  /**
   * Secured mode only: a sensitive command needs a recent authentication
   * (the session's auth_time within HLOS_REAUTH_MAX_AGE_MIN), otherwise it is
   * refused with 401 REAUTH_REQUIRED and nothing runs or is recorded. A
   * function decides per request from the validated input (read-only; it
   * runs inside the command's transaction, after the permission check).
   * Ignored in the synthetic demo (no sign-in exists there).
   */
  sensitive?: boolean | ((db: DB, input: z.infer<S>) => boolean);
  input: S;
  run: (ctx: Ctx, input: z.infer<S>) => R;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const registry = new Map<string, CommandDef<any, any>>();

export function defineCommand<S extends z.ZodType, R>(def: CommandDef<S, R>): CommandDef<S, R> {
  registry.set(def.name, def);
  return def;
}

export function listCommands(): {
  name: string;
  description: string;
  permission: Permission | null;
  audience: "lab" | "presenter";
  /** true: always sensitive; "conditional": sensitive for some inputs; false: never. */
  sensitive: boolean | "conditional";
}[] {
  return [...registry.values()].map((d) => ({
    name: d.name,
    description: d.description,
    permission: d.permission,
    audience: d.audience ?? "lab",
    sensitive: typeof d.sensitive === "function" ? "conditional" : Boolean(d.sensitive),
  }));
}

export function commandAudience(name: string): "lab" | "presenter" | null {
  const d = registry.get(name);
  return d ? (d.audience ?? "lab") : null;
}

export type CommandResult<R = unknown> =
  | { ok: true; result: R; replayed?: boolean }
  | { ok: false; error: { code: DomainErrorCode; message: string; details?: unknown } };

export interface ExecuteOptions {
  idempotencyKey?: string;
  origin?: Origin;
  correlationId?: string;
  /**
   * Secured mode, user requests (origin "user"): the session behind the
   * request, from requireApiActor(...).auth. Required: without it the request
   * is refused (SIGN_IN_REQUIRED), and `actorId` must be its staff member
   * (otherwise ACTOR_MISMATCH). Ignored in demo mode.
   */
  auth?: CommandAuth | null;
  /** Wall clock in ms for the re-authentication freshness check (tests). */
  nowMs?: number;
}

/**
 * Single entry point for every state change. In order:
 * 1. mode gate for user requests: locked -> AUTH_REQUIRED; secured -> the
 *    request must carry the session (opts.auth) and act as its staff member
 *    (ACTOR_MISMATCH otherwise); demo -> the demo role, as before,
 * 2. actor resolution (an HTTP request can never act as the internal system actor),
 * 3. secured mode only: presenter controls and permission-less commands are
 *    refused, and a role without the command's permission is refused before
 *    its input is read (audited as command.denied),
 * 4. input validation,
 * 5. in ONE immediate (write-locked) transaction: idempotency lookup, permission
 *    check, re-authentication freshness for sensitive commands (secured mode),
 *    handler, receipt. A repeated key returns the stored result only for the
 *    same actor, lab scope, command and canonical input, after the permission
 *    (and freshness) check; anything else is refused without disclosing the
 *    result.
 * A failed handler rolls back everything, including the receipt, so a retry
 * with the same key runs once when it can succeed.
 *
 * Traceability: every audit event the command writes (including a refusal)
 * records the command's permission and, in secured mode, a session reference
 * (HMAC of the session id hash under the audit key; never the id or its hash).
 * Each event is sealed in the same transaction (src/server/core/audit.ts).
 *
 * Refusals of a signed-in person (secured mode; src/server/auth/refusals.ts):
 * a role without the permission is recorded as command.denied, and a stale
 * sign-in on a sensitive command (REAUTH_REQUIRED) as auth.refused, both
 * rate-limited to one event per staff member, kind and command per minute
 * (the next event carries how many were skipped), with no request content.
 * In the synthetic demo every denial is recorded, as before.
 *
 * After the transaction COMMITS (and only when this call was not itself
 * nested in an outer transaction), expired idempotency receipts are compacted
 * opportunistically: at most once per 10 minutes per process, one bounded
 * batch, in its own short transaction (src/server/core/idempotency.ts).
 */
export function executeCommand<R = unknown>(
  db: DB,
  actorId: string,
  name: string,
  rawInput: unknown,
  opts: ExecuteOptions = {},
): CommandResult<R> {
  const def = registry.get(name);
  if (!def) return { ok: false, error: { code: "NOT_FOUND", message: `Unknown command "${name}"` } };
  const origin = opts.origin ?? "user";
  const mode = runtimeMode();
  const securedUser = origin === "user" && mode === "secured";

  if (origin === "user" && mode === "locked") {
    return { ok: false, error: { code: "AUTH_REQUIRED", message: LOCKED_MESSAGE } };
  }
  if (securedUser) {
    if (!opts.auth) {
      return { ok: false, error: { code: "SIGN_IN_REQUIRED", message: "Sign in to make changes. Nothing was recorded." } };
    }
    if (opts.auth.staffId !== actorId) {
      return {
        ok: false,
        error: { code: "ACTOR_MISMATCH", message: "The acting staff member is not the person signed in. Nothing was recorded." },
      };
    }
  }

  let ctx: Ctx;
  try {
    if (actorId === "system" && origin === "user") {
      throw new DomainError("FORBIDDEN", "The internal system actor cannot be used for a user request.");
    }
    const actor = actorId === "system" ? SYSTEM_ACTOR : loadActor(db, actorId);
    // A presenter control (simulated world event, clock, outage, guided step) is recorded with origin
    // "demo" whoever presses it, so the audit trail never reads it as a laboratory action by that role.
    const effectiveOrigin = origin === "user" && mode === "demo" && (def.audience ?? "lab") === "presenter" ? "demo" : origin;
    ctx = makeCtx(db, actor, effectiveOrigin, opts.correlationId);
  } catch (e) {
    return toFailure(e, { command: name, correlationId: opts.correlationId });
  }
  // Recorded on every audit event of this command, refusals included.
  ctx.permission = def.permission;
  if (securedUser) {
    // Domain operations that need a recent sign-in whatever the command (hold release) read this.
    const policy = sessionPolicyFromEnv();
    ctx.reauthFresh = Boolean(policy && opts.auth && isReauthFresh(opts.auth.authTime, policy, opts.nowMs ?? Date.now()));
    ctx.sessionRef = opts.auth ? sessionRefFor(opts.auth.sessionIdHash) : null;
  }

  if (securedUser) {
    // Presenter controls (and any command without a permission) exist only in the synthetic demo.
    if ((def.audience ?? "lab") === "presenter" || def.permission === null) {
      return deniedFailure(ctx, name, new DomainError("FORBIDDEN", "Not allowed: this is a synthetic demo control and does not exist in this build."), opts.nowMs ?? Date.now());
    }
    // A role without the permission is refused before the input is read (no validation details leak).
    try {
      requirePermission(ctx, def.permission);
    } catch (e) {
      return deniedFailure(ctx, name, e, opts.nowMs ?? Date.now());
    }
  }

  const parsed = def.input.safeParse(rawInput ?? {});
  if (!parsed.success) {
    return {
      ok: false,
      error: { code: "VALIDATION", message: "Some fields are missing or invalid", details: z.treeifyError(parsed.error) },
    };
  }

  const key = opts.idempotencyKey;
  let fingerprint = "";
  let scope = "";
  if (key) {
    try {
      assertValidKey(key);
      ensureReceiptSchema(db);
    } catch (e) {
      // (The first keyed command on a connection may write the receipt columns: a storage failure can surface here.)
      return toFailure(e, { command: name, correlationId: ctx.correlationId });
    }
    fingerprint = requestFingerprint(name, parsed.data);
    scope = labScope(db);
  }

  // Secured mode: a sensitive command (or a sensitive input) needs a recent sign-in. Nothing runs otherwise.
  const requireFreshAuth = () => {
    if (!securedUser) return;
    const sensitive = typeof def.sensitive === "function" ? def.sensitive(db, parsed.data) : Boolean(def.sensitive);
    if (!sensitive) return;
    const policy = sessionPolicyFromEnv();
    if (!policy || !opts.auth || !isReauthFresh(opts.auth.authTime, policy, opts.nowMs ?? Date.now())) {
      throw new DomainError(
        "REAUTH_REQUIRED",
        "This decision needs you to confirm it's you: sign in again, then repeat it. Nothing was recorded.",
        { reauthMaxAgeMinutes: policy?.reauthMaxAgeMinutes ?? null },
      );
    }
  };

  try {
    const outcome = db
      .transaction((): { result: unknown; replayed: boolean } => {
        if (key) {
          const prior = findReceipt(db, key);
          if (prior) {
            checkRepeat(prior, { command: name, actorId: ctx.actor.id, scope, fingerprint, nowMs: Date.now() });
            // The repeat is the same request from its owner: it still needs today's permission.
            if (def.permission) requirePermission(ctx, def.permission);
            requireFreshAuth();
            return { result: JSON.parse(prior.result_json), replayed: true };
          }
        }
        if (def.permission) requirePermission(ctx, def.permission);
        requireFreshAuth();
        const r = def.run(ctx, parsed.data);
        if (key) {
          insertReceipt(db, { key, command: name, actorId: ctx.actor.id, scope, fingerprint, result: r, correlationId: ctx.correlationId, at: ctx.now, nowMs: Date.now() });
        }
        return { result: r, replayed: false };
      })
      .immediate();
    // Committed. Never inside the command's transaction, and never when this call was nested in an outer one.
    if (!db.inTransaction) maybeRunReceiptMaintenance(db);
    return outcome.replayed ? { ok: true, result: outcome.result as R, replayed: true } : { ok: true, result: outcome.result as R };
  } catch (e) {
    const failure = toFailure(e, { command: name, correlationId: ctx.correlationId });
    if (!failure.ok && origin === "user" && (failure.error.code === "FORBIDDEN" || failure.error.code === "IDEMPOTENCY_CONFLICT")) {
      auditRefusal(ctx, name, failure.error, securedUser ? (opts.nowMs ?? Date.now()) : null);
    }
    if (!failure.ok && securedUser && failure.error.code === "REAUTH_REQUIRED" && opts.auth) {
      // Nothing ran (the transaction rolled back); the refusal itself is on record, rate-limited, without the input.
      auditSignedInRefusal(db, {
        staffId: ctx.actor.id,
        kind: "reauth_required",
        target: name,
        permission: def.permission,
        sessionIdHash: opts.auth.sessionIdHash,
        correlationId: ctx.correlationId,
        now: opts.nowMs,
      });
    }
    return failure;
  }
}

/** A FORBIDDEN refusal before the transaction (secured mode only): audited like the in-transaction one, then returned. */
function deniedFailure(ctx: Ctx, name: string, e: unknown, nowMs: number): CommandResult<never> {
  const failure = toFailure(e);
  if (!failure.ok && ctx.origin !== "system" && (failure.error.code === "FORBIDDEN" || failure.error.code === "IDEMPOTENCY_CONFLICT")) {
    auditRefusal(ctx, name, failure.error, nowMs);
  }
  return failure;
}

/**
 * Denied attempts and refused key reuse are kept in the local audit trail (no request content is stored).
 * `limitAt` (secured mode, the wall clock in ms): a denial of the signed-in person is rate-limited per staff
 * member and command (src/server/auth/refusals.ts); the event written carries `skipped` when earlier identical
 * denials inside the window were not recorded one by one. null (demo): every denial is recorded.
 */
function auditRefusal(ctx: Ctx, name: string, error: { code: DomainErrorCode; message: string; details?: unknown }, limitAt: number | null = null): void {
  try {
    const denied = error.code === "FORBIDDEN";
    let skipped = 0;
    if (denied && limitAt !== null) {
      const gate = refusalGate(ctx.db, ctx.actor.id, "forbidden", name, limitAt);
      if (!gate) return;
      skipped = gate.skipped;
    }
    audit(ctx, {
      action: denied ? "command.denied" : "command.idempotency_rejected",
      entityType: "command",
      entityId: name,
      summary: denied
        ? `Denied: ${ctx.actor.name} (${ctx.actor.role}) attempted ${name}`
        : `Refused a reused idempotency key: ${ctx.actor.name} (${ctx.actor.role}) on ${name}`,
      reason: error.message,
      after: denied ? (skipped ? { skipped } : undefined) : { reason: (error.details as { reason?: string } | undefined)?.reason ?? null },
    });
  } catch {
    /* ignore */
  }
}

/**
 * An unexpected error (not a DomainError) is logged as one structured line (src/server/core/log.ts: the
 * error's name, code, a scrubbed message and the first stack frame; never the stack or the request) and the
 * caller gets a generic message with the correlation id, never the raw error text: an error message can
 * quote stored data (a JSON parse error quotes the text it read) or internal details.
 */
function toFailure(e: unknown, info: { command?: string; correlationId?: string } = {}): CommandResult<never> {
  if (e instanceof DomainError) return { ok: false, error: { code: e.code, message: e.message, details: e.details } };
  const message = e instanceof Error ? e.message : String(e);
  if (message.startsWith("INVARIANT:")) {
    return { ok: false, error: { code: "INVARIANT", message: message.replace(/^INVARIANT:\s*/, "") } };
  }
  const sqlite = sqliteCodeOf(e);
  if (/database is locked|SQLITE_BUSY/i.test(message) || /^SQLITE_(BUSY|LOCKED)/.test(sqlite)) {
    // Another request holds the write lock (one change at a time); nothing from this request was written.
    return { ok: false, error: { code: "CONFLICT", message: "Another change is being saved right now. Nothing was changed; try again." } };
  }
  if (STORAGE_REFUSED.test(sqlite) || STORAGE_FAILED.test(sqlite)) {
    // The database itself cannot take writes (read-only, full, cannot be opened) or failed while saving. Never the
    // "fix your input" answer: a storage failure is the server's, and it is logged for the operator with its SQLite
    // code only. Refused writes never committed; after an I/O error during the commit the outcome is not known, so
    // that answer does not claim nothing changed (a retry with the same idempotency key still cannot run twice).
    log("error", "command.storage_failure", { correlationId: info.correlationId, command: info.command, error: e });
    const refused = STORAGE_REFUSED.test(sqlite);
    return {
      ok: false,
      error: {
        code: refused ? "STORAGE_UNAVAILABLE" : "STORAGE_FAILED",
        message: refused
          ? "The laboratory database cannot save changes right now (it is read-only, full or cannot be opened). Nothing was changed. Try again later; if it keeps happening, tell the laboratory administrator."
          : "The laboratory database reported a storage error while saving this change. Reload to see what was recorded before trying again; if it keeps happening, tell the laboratory administrator.",
      },
    };
  }
  if (/UNIQUE constraint failed: print_job/.test(message)) {
    return { ok: false, error: { code: "INVARIANT", message: "A print job for this label is already in flight or awaiting reconciliation" } };
  }
  log("error", "command.unexpected_error", { correlationId: info.correlationId, command: info.command, error: e });
  return {
    ok: false,
    error: {
      code: "SERVER_ERROR",
      message: `The request could not be completed because of an unexpected error on the server. Nothing was changed.${info.correlationId ? ` Reference: ${info.correlationId}.` : ""}`,
    },
  };
}

/** SQLite result codes (better-sqlite3 SqliteError.code) for a database that refuses every write: nothing was committed. */
const STORAGE_REFUSED = /^SQLITE_(READONLY|CANTOPEN|PERM|FULL|NOLFS)(_|$)/;
/** SQLite result codes for a storage failure while reading or writing (the outcome of a failed commit is not known). */
const STORAGE_FAILED = /^SQLITE_(IOERR|CORRUPT|NOTADB|PROTOCOL)(_|$)/;

function sqliteCodeOf(e: unknown): string {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : "";
}

/** Run a command directly as a given actor and throw on failure (tests, simulator, seed). */
export function mustRun<R = unknown>(db: DB, actorId: string, name: string, input: unknown, opts: ExecuteOptions = {}): R {
  const res = executeCommand<R>(db, actorId, name, input, opts);
  if (!res.ok) throw new DomainError(res.error.code, `${name}: ${res.error.message}`, res.error.details);
  return res.result;
}
