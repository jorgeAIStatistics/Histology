import crypto from "node:crypto";
import { makeCtx, SYSTEM_ACTOR } from "@/server/core/context";
import { getDb } from "@/server/db/db";
import { importSourceMessage } from "@/server/domain/sourceImport";
import { rejectCrossOrigin } from "@/server/session";
import {
  FIXTURE_TOKEN_HEADER,
  FixtureUnavailableError,
  TEST_FIXTURE_NAMES,
  buildTestFixture,
  fixtureTokenMatches,
  isTestFixtureName,
  testFixturesEnabled,
} from "@/server/test-fixtures";

/**
 * POST /api/test/fixtures  body: { fixture: "<name>" }  header: x-hlos-fixture-token
 *
 * TEST ONLY (browser acceptance tests). Imports one named, synthetic source
 * message from the fixed catalog in src/server/test-fixtures.ts through the
 * real importer (importSourceMessage, origin "import"), in one transaction, and
 * returns its ImportResult. No payload is accepted: only a catalog name.
 *
 * Unless the synthetic demo mode, HLOS_TEST_FIXTURES=1 and a token of at least
 * 32 characters are all configured AND the request carries that token, the
 * answer is the same 404 as for any unknown path, so a locked build (or a demo
 * without the test switch) never runs a fixture and does not reveal the route.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store" } as const;

function notFound(): Response {
  return Response.json({ ok: false, error: { code: "NOT_FOUND", message: "Not found." } }, { status: 404, headers: NO_STORE });
}

export async function POST(req: Request) {
  // The gate comes first: until it passes, every answer is the identical 404.
  if (!testFixturesEnabled() || !fixtureTokenMatches(req.headers.get(FIXTURE_TOKEN_HEADER))) return notFound();
  const blocked = rejectCrossOrigin(req);
  if (blocked) return blocked;

  let body: { fixture?: unknown } = {};
  try {
    const text = await req.text();
    body = text ? (JSON.parse(text) as typeof body) : {};
  } catch {
    return Response.json({ ok: false, error: { code: "VALIDATION", message: "Request body must be JSON: { fixture: string }." } }, { status: 400, headers: NO_STORE });
  }
  const name = body && typeof body === "object" ? body.fixture : undefined;
  if (!isTestFixtureName(name)) {
    return Response.json(
      { ok: false, error: { code: "VALIDATION", message: `Unknown fixture. Known fixtures: ${TEST_FIXTURE_NAMES.join(", ")}.` } },
      { status: 400, headers: NO_STORE },
    );
  }

  const db = getDb();
  try {
    const result = db.transaction(() => {
      const fixture = buildTestFixture(db, name);
      const ctx = makeCtx(db, SYSTEM_ACTOR, "import", `test-fixture-${name}-${crypto.randomUUID()}`);
      return importSourceMessage(ctx, fixture.sourceId, fixture.message, { via: "sync" });
    })();
    return Response.json({ ok: true, fixture: name, result }, { headers: NO_STORE });
  } catch (e) {
    if (e instanceof FixtureUnavailableError) {
      return Response.json({ ok: false, error: { code: "FIXTURE_UNAVAILABLE", message: e.message } }, { status: 409, headers: NO_STORE });
    }
    console.error("[test/fixtures] failed", e);
    return Response.json({ ok: false, error: { code: "INTERNAL", message: "The fixture could not be imported." } }, { status: 500, headers: NO_STORE });
  }
}

// Any other method gets the same 404, whatever the configuration (the route never advertises itself).
async function refuse(): Promise<Response> {
  return notFound();
}
export { refuse as GET, refuse as PUT, refuse as PATCH, refuse as DELETE, refuse as OPTIONS };
