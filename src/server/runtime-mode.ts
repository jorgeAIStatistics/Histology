/**
 * Runtime mode: the explicit boundary between the synthetic demonstration and
 * anything that could ever hold real data.
 *
 * - "demo": synthetic data, the demo role switch, presenter controls and the
 *   simulators are available. Selected with HLOS_MODE=demo, and by default
 *   under `next dev` (NODE_ENV=development) so local development works.
 * - "locked": every other case, including a production build started without
 *   HLOS_MODE=demo. No identity provider exists in this codebase, so a locked
 *   build refuses every state change (401 AUTH_REQUIRED), refuses the role
 *   switch and hides presenter-only endpoints. It fails closed on purpose: a
 *   forgotten environment variable must never turn the demo role switch into
 *   an unauthenticated write path.
 *
 * Read on every call (not cached) so tests can switch it per case.
 */
export type RuntimeMode = "demo" | "locked";

export function runtimeMode(): RuntimeMode {
  const v = process.env.HLOS_MODE?.trim().toLowerCase();
  if (v === "demo") return "demo";
  if (v) return "locked";
  return process.env.NODE_ENV === "development" ? "demo" : "locked";
}

export function isDemoMode(): boolean {
  return runtimeMode() === "demo";
}

export const LOCKED_MESSAGE =
  "This build is not running in synthetic demo mode and no identity provider is configured, so changes are refused. Set HLOS_MODE=demo only for the synthetic demonstration.";
