import { handleActivity } from "@/server/auth/flow";

/**
 * POST /api/auth/activity (same-origin)
 * Secured mode: user input on the open page (typing, pointer, scrolling) that
 * caused no request. Sent by the client at most about once a minute while the
 * person is working, so the server's idle lock follows real input. Background
 * polling never sends it. Returns { ok: true, result: { idleLocksAt } }, or
 * 401 SESSION_LOCKED / SESSION_EXPIRED / SIGN_IN_REQUIRED with no data.
 * Demo mode: 404. Locked build: 401.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request) {
  return handleActivity(req);
}
