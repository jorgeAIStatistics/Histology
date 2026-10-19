import { handleLogin } from "@/server/auth/flow";
import { withRequestLog } from "@/server/ops/request-log";

/**
 * GET /api/auth/login?returnTo=/same-origin/path[&reauth=1]
 * Secured mode: starts the OIDC authorization code flow (PKCE, state, nonce)
 * and redirects to the identity provider. See src/server/auth/flow.ts.
 * Demo mode: 404. Locked build: 401, no data.
 *
 * One structured `http.request` log line per request (route template only, never the query string; no actor id: the
 * person is not known until the sign-in completes, and the audit trail records it under the same correlation id).
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = withRequestLog("/api/auth/login", (req: Request) => handleLogin(req));
