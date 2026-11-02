import { authConfig } from "./auth/config";
import { log } from "./core/log";

/**
 * Runtime mode: the explicit boundary between the synthetic demonstration and
 * anything that could ever hold real data. Fail closed.
 *
 * - "demo": synthetic data, the demo role switch (a cookie, NOT
 *   authentication), presenter controls, demo reset, test fixtures and the
 *   simulators. Selected with HLOS_MODE=demo, and by default under `next dev`
 *   (NODE_ENV=development with no HLOS_MODE) so local development works.
 * - "secured": OIDC sign-in (src/server/auth/*). Selected ONLY when
 *   HLOS_MODE=secured AND authConfig() validates. Every page, read API and
 *   command needs a signed-in, unlocked session of an active staff member of
 *   this lab (src/server/auth/guard.ts). No demo surface exists.
 * - "locked": every other case, including HLOS_MODE=secured with a missing or
 *   invalid configuration and a production build started without HLOS_MODE.
 *   Nobody reads or writes: pages redirect to /locked (no data), APIs answer
 *   401. A forgotten or mistyped environment variable must never open a path
 *   to data.
 *
 * Read on every call (not cached) so tests can switch it per case.
 */
export type RuntimeMode = "demo" | "secured" | "locked";

export type LockedReason =
  /** HLOS_MODE is not "secured" (or not set in a production build). */
  | { reason: "not_configured"; keys: [] }
  /** HLOS_MODE=secured but these environment keys are missing or invalid (names only, never values). */
  | { reason: "auth_misconfigured"; keys: string[] };

function requestedMode(): "demo" | "secured" | "other" {
  const v = process.env.HLOS_MODE?.trim().toLowerCase();
  if (v === "demo") return "demo";
  if (v === "secured") return "secured";
  if (v) return "other";
  return process.env.NODE_ENV === "development" ? "demo" : "other";
}

export function runtimeMode(): RuntimeMode {
  const requested = requestedMode();
  if (requested === "demo") return "demo";
  if (requested === "secured") {
    const cfg = authConfig();
    if (cfg.ok) return "secured";
    reportMisconfiguration(cfg.keys);
  }
  return "locked";
}

// The /locked page deliberately says nothing about the configuration (a visitor must not learn how the build is set
// up). The operator learns it from the server log instead: one line per distinct set of failing settings, naming the
// settings and never their values.
let reportedKeys = "";
function reportMisconfiguration(keys: readonly string[]): void {
  const settings = keys.join(", ");
  if (settings === reportedKeys) return;
  reportedKeys = settings;
  log("warn", "runtime.locked_misconfigured", { requested_mode: "secured", settings });
}

/** Synthetic demo mode (unchanged semantics: HLOS_MODE=demo, or `next dev` without HLOS_MODE). */
export function isDemoMode(): boolean {
  return runtimeMode() === "demo";
}

/** Secured mode: HLOS_MODE=secured and a validated OIDC configuration. */
export function isSecuredMode(): boolean {
  return runtimeMode() === "secured";
}

/** Why the build is locked, or null when it is not. Names failing keys, never their values. */
export function lockedReason(): LockedReason | null {
  const requested = requestedMode();
  if (requested === "demo") return null;
  if (requested === "secured") {
    const cfg = authConfig();
    return cfg.ok ? null : { reason: "auth_misconfigured", keys: cfg.keys };
  }
  return { reason: "not_configured", keys: [] };
}

export const LOCKED_MESSAGE =
  "This build is not running in synthetic demo mode and sign-in is not configured, so changes are refused. Set HLOS_MODE=demo only for the synthetic demonstration.";
