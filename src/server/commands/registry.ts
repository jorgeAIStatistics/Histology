import { z } from "zod";
import type { DB } from "../db/db";
import type { Permission } from "@/lib/roles";
import { DomainError, type DomainErrorCode } from "../core/errors";
import { type Ctx, type Origin, loadActor, makeCtx, requirePermission, SYSTEM_ACTOR } from "../core/context";
import { audit } from "../core/audit";
import { assertValidKey, checkRepeat, ensureReceiptSchema, findReceipt, insertReceipt, labScope, requestFingerprint } from "../core/idempotency";
import { LOCKED_MESSAGE, runtimeMode } from "../runtime-mode";
import type { CommandAuth } from "../auth/guard";
import { isReauthFresh, sessionPolicyFromEnv } from "../auth/sessions";

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
    return toFailure(e);
  }
  if (securedUser) {
    // Domain operations that need a recent sign-in whatever the command (hold release) read this.
    const policy = sessionPolicyFromEnv();
    ctx.reauthFresh = Boolean(policy && opts.auth && isReauthFresh(opts.auth.authTime, policy, opts.nowMs ?? Date.now()));
  }

  if (securedUser) {
    // Presenter controls (and any command without a permission) exist only in the synthetic demo.
    if ((def.audience ?? "lab") === "presenter" || def.permission === null) {
      return deniedFailure(ctx, name, new DomainError("FORBIDDEN", "Not allowed: this is a synthetic demo control and does not exist in this build."));
    }
    // A role without the permission is refused before the input is read (no validation details leak).
    try {
      requirePermission(ctx, def.permission);
    } catch (e) {
      return deniedFailure(ctx, name, e);
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
      return toFailure(e);
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
    return outcome.replayed ? { ok: true, result: outcome.result as R, replayed: true } : { ok: true, result: outcome.result as R };
  } catch (e) {
    const failure = toFailure(e);
    if (!failure.ok && origin === "user" && (failure.error.code === "FORBIDDEN" || failure.error.code === "IDEMPOTENCY_CONFLICT")) {
      auditRefusal(ctx, name, failure.error);
    }
    return failure;
  }
}

/** A FORBIDDEN refusal before the transaction: audited like the in-transaction one, then returned. */
function deniedFailure(ctx: Ctx, name: string, e: unknown): CommandResult<never> {
  const failure = toFailure(e);
  if (!failure.ok && ctx.origin !== "system" && (failure.error.code === "FORBIDDEN" || failure.error.code === "IDEMPOTENCY_CONFLICT")) {
    auditRefusal(ctx, name, failure.error);
  }
  return failure;
}

/** Denied attempts and refused key reuse are kept in the local audit trail (no request content is stored). */
function auditRefusal(ctx: Ctx, name: string, error: { code: DomainErrorCode; message: string; details?: unknown }): void {
  try {
    const denied = error.code === "FORBIDDEN";
    audit(ctx, {
      action: denied ? "command.denied" : "command.idempotency_rejected",
      entityType: "command",
      entityId: name,
      summary: denied
        ? `Denied: ${ctx.actor.name} (${ctx.actor.role}) attempted ${name}`
        : `Refused a reused idempotency key: ${ctx.actor.name} (${ctx.actor.role}) on ${name}`,
      reason: error.message,
      after: denied ? undefined : { reason: (error.details as { reason?: string } | undefined)?.reason ?? null },
    });
  } catch {
    /* ignore */
  }
}

function toFailure(e: unknown): CommandResult<never> {
  if (e instanceof DomainError) return { ok: false, error: { code: e.code, message: e.message, details: e.details } };
  const message = e instanceof Error ? e.message : String(e);
  if (message.startsWith("INVARIANT:")) {
    return { ok: false, error: { code: "INVARIANT", message: message.replace(/^INVARIANT:\s*/, "") } };
  }
  if (/database is locked|SQLITE_BUSY/i.test(message)) {
    // Another request holds the write lock (one change at a time); nothing from this request was written.
    return { ok: false, error: { code: "CONFLICT", message: "Another change is being saved right now. Nothing was changed; try again." } };
  }
  if (/UNIQUE constraint failed: print_job/.test(message)) {
    return { ok: false, error: { code: "INVARIANT", message: "A print job for this label is already in flight or awaiting reconciliation" } };
  }
  console.error("[command] unexpected error", e);
  return { ok: false, error: { code: "VALIDATION", message } };
}

/** Run a command directly as a given actor and throw on failure (tests, simulator, seed). */
export function mustRun<R = unknown>(db: DB, actorId: string, name: string, input: unknown, opts: ExecuteOptions = {}): R {
  const res = executeCommand<R>(db, actorId, name, input, opts);
  if (!res.ok) throw new DomainError(res.error.code, `${name}: ${res.error.message}`, res.error.details);
  return res.result;
}
