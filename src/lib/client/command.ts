"use client";

import { startTransition, useCallback, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import type { DomainErrorCode } from "@/server/core/errors";
import { useToast } from "@/components/ui/toast";
import { useConflict, type ConflictRequest } from "./conflict";
import { useLiveActions } from "./live";

/**
 * Client side of the command layer. Every state change goes through
 * POST /api/commands/<name> with { input, idempotencyKey }.
 *
 * Idempotency: one key per USER INTENT. useCommand generates a key when an
 * action starts and reuses it when the same input is retried (after a network
 * error the server may already have done the work; the retry replays the
 * stored result instead of creating a duplicate). A successful run clears it.
 */

export type CommandErrorCode = DomainErrorCode | "NETWORK";

export interface CommandFailure {
  code: CommandErrorCode;
  message: string;
  details?: unknown;
}

export type CommandOutcome<R> = { ok: true; result: R; replayed: boolean } | { ok: false; error: CommandFailure };

export function newIdempotencyKey(prefix = "ui"): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return `${prefix}-${crypto.randomUUID()}`;
  } catch {
    /* fall back */
  }
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

const STATUS_CODE: Record<number, CommandErrorCode> = {
  400: "VALIDATION",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  409: "CONFLICT",
  422: "INVARIANT",
  423: "BLOCKED",
  503: "SOURCE_OFFLINE",
};

/** Low-level call. Prefer useCommand() / <CommandButton> in components. */
export async function runCommand<R = unknown>(
  name: string,
  input: unknown,
  opts: { idempotencyKey?: string; signal?: AbortSignal } = {},
): Promise<CommandOutcome<R>> {
  let res: Response;
  try {
    res = await fetch(`/api/commands/${encodeURIComponent(name)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ input: input ?? {}, idempotencyKey: opts.idempotencyKey ?? newIdempotencyKey() }),
      cache: "no-store",
      signal: opts.signal,
    });
  } catch {
    return {
      ok: false,
      error: {
        code: "NETWORK",
        message: "Could not reach the local demo server. If the action already went through, trying again will not create a duplicate.",
      },
    };
  }
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    return {
      ok: false,
      error: { code: STATUS_CODE[res.status] ?? "VALIDATION", message: `Unexpected response from the local server (HTTP ${res.status}).` },
    };
  }
  const body = json as { ok?: boolean; result?: R; replayed?: boolean; error?: CommandFailure };
  if (body.ok) return { ok: true, result: body.result as R, replayed: Boolean(body.replayed) };
  return {
    ok: false,
    error: body.error ?? { code: STATUS_CODE[res.status] ?? "VALIDATION", message: `Request failed (HTTP ${res.status}).` },
  };
}

/** Short title for each failure kind (used in toasts and inline errors). */
export const ERROR_TITLE: Record<CommandErrorCode, string> = {
  FORBIDDEN: "Not allowed",
  CONFLICT: "Someone else changed this item",
  INVARIANT: "Not allowed by a safety rule",
  BLOCKED: "Blocked",
  NOT_FOUND: "Not found",
  VALIDATION: "Some fields need attention",
  SOURCE_OFFLINE: "Source system unreachable (simulated)",
  PRINTER_UNAVAILABLE: "Printer unavailable (simulated)",
  ASSISTANT_UNAVAILABLE: "Drafting assistant unavailable",
  NETWORK: "Could not reach the local server",
};

/**
 * Field-level messages from a VALIDATION error (zod treeifyError shape):
 * `fieldErrors(error).site` -> "Required".
 */
export function fieldErrors(error: CommandFailure | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!error || error.code !== "VALIDATION") return out;
  const walk = (node: unknown, path: string[]) => {
    if (!node || typeof node !== "object") return;
    const n = node as { errors?: string[]; properties?: Record<string, unknown>; items?: unknown[] };
    if (path.length && n.errors?.length) out[path.join(".")] = n.errors[0];
    if (n.properties) for (const [k, v] of Object.entries(n.properties)) walk(v, [...path, k]);
    if (Array.isArray(n.items)) n.items.forEach((v, i) => walk(v, [...path, String(i)]));
  };
  walk(error.details, []);
  return out;
}

export interface UseCommandOptions<R, I> {
  /** Success toast text (or a function of the result). Omit/null for no toast. */
  successToast?: string | ((result: R, input: I) => string | null) | null;
  /** Shown when the server replayed an earlier identical request. */
  replayToast?: string | null;
  /** Show a warning toast on failure (besides returning the error for inline display). Default true. */
  errorToast?: boolean;
  /** router.refresh() after success. Default true. */
  refresh?: boolean;
  onSuccess?: (result: R, meta: { replayed: boolean; input: I }) => void;
  onError?: (error: CommandFailure, input: I) => void;
  /**
   * CONFLICT handling. Default: open the global ConflictDialog with fields
   * derived from details.current vs the input. Pass false to handle it yourself.
   */
  conflict?: false | Pick<ConflictRequest, "fieldLabels" | "subject" | "onLoadLatest" | "onDiscard" | "fields">;
}

export interface UseCommandResult<R, I> {
  /** Run the command. While pending, repeated calls return the same in-flight promise (no double submit). */
  run: (input: I) => Promise<CommandOutcome<R>>;
  pending: boolean;
  /** Last failure, for inline display (cleared on the next run or reset()). */
  error: CommandFailure | null;
  result: R | null;
  reset: () => void;
}

/**
 * `const { run, pending, error } = useCommand<Result, Input>("intake.verifyContainer", { successToast: "Verification recorded" })`
 */
export function useCommand<R = unknown, I = unknown>(name: string, options: UseCommandOptions<R, I> = {}): UseCommandResult<R, I> {
  const router = useRouter();
  const toast = useToast();
  const conflict = useConflict();
  const { sync: liveSync } = useLiveActions();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<CommandFailure | null>(null);
  const [result, setResult] = useState<R | null>(null);
  const intent = useRef<{ key: string; fingerprint: string } | null>(null);
  const inFlight = useRef<Promise<CommandOutcome<R>> | null>(null);
  const optsRef = useRef(options);
  optsRef.current = options;

  const run = useCallback(
    (input: I): Promise<CommandOutcome<R>> => {
      if (inFlight.current) return inFlight.current;
      let fingerprint: string;
      try {
        fingerprint = JSON.stringify(input ?? null);
      } catch {
        fingerprint = String(Date.now());
      }
      if (!intent.current || intent.current.fingerprint !== fingerprint) {
        intent.current = { key: newIdempotencyKey(name), fingerprint };
      }
      const key = intent.current.key;
      setPending(true);
      setError(null);

      const p = (async () => {
        const out = await runCommand<R>(name, input, { idempotencyKey: key });
        const o = optsRef.current;
        if (out.ok) {
          intent.current = null;
          setResult(out.result);
          if (o.refresh !== false) startTransition(() => router.refresh());
          void liveSync();
          if (out.replayed) {
            const msg = o.replayToast === undefined ? "Already recorded. No duplicate was created." : o.replayToast;
            if (msg) toast.show({ tone: "info", title: msg });
          } else if (o.successToast) {
            const msg = typeof o.successToast === "function" ? o.successToast(out.result, input) : o.successToast;
            if (msg) toast.show({ tone: "success", title: msg });
          }
          o.onSuccess?.(out.result, { replayed: out.replayed, input });
        } else {
          setError(out.error);
          if (out.error.code === "CONFLICT" && o.conflict !== false) {
            conflict.open({
              message: out.error.message,
              details: out.error.details,
              yours: input && typeof input === "object" ? (input as Record<string, unknown>) : null,
              ...(o.conflict || {}),
            });
          } else if (o.errorToast !== false) {
            toast.show({ tone: "warning", title: ERROR_TITLE[out.error.code] ?? "Action failed", body: out.error.message });
          }
          o.onError?.(out.error, input);
        }
        return out;
      })();

      inFlight.current = p;
      p.finally(() => {
        inFlight.current = null;
        setPending(false);
      });
      return p;
    },
    [name, router, toast, conflict, liveSync],
  );

  const reset = useCallback(() => {
    intent.current = null;
    setError(null);
    setResult(null);
  }, []);

  return { run, pending, error, result, reset };
}

/** Plain-text summary of a failure for inline display: "Not allowed: <message>". */
export function describeFailure(error: CommandFailure): { title: string; message: ReactNode } {
  return { title: ERROR_TITLE[error.code] ?? "Action failed", message: error.message };
}
