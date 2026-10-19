import { handleLock } from "@/server/auth/flow";

/**
 * POST /api/auth/lock (same-origin)
 * Secured mode: locks this browser's session ("Lock" button or the client idle
 * timer). A locked session reads and writes nothing until the same person, or
 * someone else (workstation hand-over), signs in again.
 * Returns { ok: true, result: { locked: true } }. Demo mode: 404. Locked build: 401.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request) {
  return handleLock(req);
}
