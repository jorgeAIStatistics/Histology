import { handleCallback } from "@/server/auth/flow";

/**
 * GET /api/auth/callback?code=…&state=…
 * Secured mode: consumes the sign-in transaction once, validates the ID token
 * and signs in the LINKED staff member (links are never created here). Every
 * denial is audited (auth.denied) and lands on a plain page. See
 * src/server/auth/flow.ts. Demo mode: 404. Locked build: 401, no data.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  return handleCallback(req);
}
