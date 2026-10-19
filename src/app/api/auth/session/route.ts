import { handleSessionInfo } from "@/server/auth/flow";

/**
 * GET /api/auth/session
 * Secured mode: who is signed in, lock state, expiry and re-authentication
 * freshness, never patient data. A locked session reports { locked: true }
 * with no actor. Never counts as activity (safe to poll). 401 without a valid
 * session. Demo mode: { mode: "demo", signedIn: false }. Locked build: 401.
 * Response shape: src/server/auth/flow.ts handleSessionInfo.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  return handleSessionInfo(req);
}
