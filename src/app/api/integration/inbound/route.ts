import { handleInboundRequest } from "@/server/integration/inbound";

/**
 * POST /api/integration/inbound — contract "hlos.source-message" 1.0 (docs/release/integration-contract.md).
 *
 * SIMULATED SOURCES ONLY. The route exists only in synthetic demo mode with HLOS_INTEGRATION_SIMULATOR=1 and a
 * simulator root secret (HLOS_INTEGRATION_SIM_SECRET, at least 32 characters); in every other case, and for
 * every other method, it answers the same 404 as an unknown path. It accepts only sources whose adapter is a
 * simulated source-system adapter. Signature, envelope and payload checks, the ACK / NAK replies and the single
 * mapping onto the importer are in src/server/integration/inbound.ts.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request): Promise<Response> {
  return handleInboundRequest(req);
}

// Any other method gets the same 404 (handleInboundRequest refuses everything but POST before any other check).
async function refuse(req: Request): Promise<Response> {
  return handleInboundRequest(req);
}
export { refuse as GET, refuse as PUT, refuse as PATCH, refuse as DELETE, refuse as OPTIONS };
