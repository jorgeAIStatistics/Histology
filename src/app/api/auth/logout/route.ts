import { handleLogout } from "@/server/auth/flow";

/**
 * POST /api/auth/logout (same-origin)
 * Secured mode: revokes this browser's session, clears the cookie, audits
 * auth.signed_out and returns { ok: true, result: { signedOut, endSessionUrl } }
 * (endSessionUrl is the provider's RP-initiated logout URL when it advertises
 * one, else null). Demo mode: 404. Locked build: 401.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request) {
  return handleLogout(req);
}
