import { handleLogin } from "@/server/auth/flow";

/**
 * GET /api/auth/login?returnTo=/same-origin/path[&reauth=1]
 * Secured mode: starts the OIDC authorization code flow (PKCE, state, nonce)
 * and redirects to the identity provider. See src/server/auth/flow.ts.
 * Demo mode: 404. Locked build: 401, no data.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  return handleLogin(req);
}
