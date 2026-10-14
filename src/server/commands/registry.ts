import { z } from "zod";
import type { DB } from "../db/db";
import type { Permission } from "@/lib/roles";
import { DomainError, type DomainErrorCode } from "../core/errors";
import { type Ctx, type Origin, loadActor, makeCtx, requirePermission, SYSTEM_ACTOR } from "../core/context";
import { audit } from "../core/audit";

export interface CommandDef<S extends z.ZodType, R> {
  name: string;
  description: string;
  /** Checked on the server before the handler runs. `null` = demo/system command open to any demo role. */
  permission: Permission | null;
  input: S;
  run: (ctx: Ctx, input: z.infer<S>) => R;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const registry = new Map<string, CommandDef<any, any>>();

export function defineCommand<S extends z.ZodType, R>(def: CommandDef<S, R>): CommandDef<S, R> {
  registry.set(def.name, def);
  return def;
}

export function listCommands(): { name: string; description: string; permission: Permission | null }[] {
  return [...registry.values()].map((d) => ({ name: d.name, description: d.description, permission: d.permission }));
}

export type CommandResult<R = unknown> =
  | { ok: true; result: R; replayed?: boolean }
  | { ok: false; error: { code: DomainErrorCode; message: string; details?: unknown } };

export interface ExecuteOptions {
  idempotencyKey?: string;
  origin?: Origin;
  correlationId?: string;
}

/**
 * Single entry point for every state change: resolves the actor, validates
 * input, checks the role server-side, runs the handler in one transaction,
 * and makes repeated submissions (double clicks / retries) idempotent.
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

  if (opts.idempotencyKey) {
    const prior = db.prepare("SELECT result_json, command FROM command_receipt WHERE idempotency_key = ?").get(opts.idempotencyKey) as
      | { result_json: string; command: string }
      | undefined;
    if (prior) {
      if (prior.command !== name) {
        return { ok: false, error: { code: "VALIDATION", message: "Idempotency key was already used for a different action" } };
      }
      return { ok: true, result: JSON.parse(prior.result_json) as R, replayed: true };
    }
  }

  let ctx: Ctx;
  try {
    const origin = opts.origin ?? "user";
    const actor = actorId === "system" ? SYSTEM_ACTOR : loadActor(db, actorId);
    ctx = makeCtx(db, actor, origin, opts.correlationId);
  } catch (e) {
    return toFailure(e);
  }

  const parsed = def.input.safeParse(rawInput ?? {});
  if (!parsed.success) {
    return {
      ok: false,
      error: { code: "VALIDATION", message: "Some fields are missing or invalid", details: z.treeifyError(parsed.error) },
    };
  }

  try {
    const result = db.transaction(() => {
      if (def.permission) requirePermission(ctx, def.permission);
      const r = def.run(ctx, parsed.data);
      if (opts.idempotencyKey) {
        db.prepare("INSERT INTO command_receipt (idempotency_key, command, actor_id, result_json, at) VALUES (?, ?, ?, ?, ?)").run(
          opts.idempotencyKey, name, ctx.actor.id, JSON.stringify(r ?? null), ctx.now,
        );
      }
      return r;
    })();
    return { ok: true, result: result as R };
  } catch (e) {
    const failure = toFailure(e);
    if (!failure.ok && failure.error.code === "FORBIDDEN" && ctx.origin === "user") {
      // Denied attempts are worth keeping in the local audit trail.
      try {
        audit(ctx, {
          action: "command.denied",
          entityType: "command",
          entityId: name,
          summary: `Denied: ${ctx.actor.name} (${ctx.actor.role}) attempted ${name}`,
          reason: failure.error.message,
        });
      } catch {
        /* ignore */
      }
    }
    return failure;
  }
}

function toFailure(e: unknown): CommandResult<never> {
  if (e instanceof DomainError) return { ok: false, error: { code: e.code, message: e.message, details: e.details } };
  const message = e instanceof Error ? e.message : String(e);
  if (message.startsWith("INVARIANT:")) {
    return { ok: false, error: { code: "INVARIANT", message: message.replace(/^INVARIANT:\s*/, "") } };
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
