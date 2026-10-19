import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * Marks design-preview routes (/concepts/*) so the root layout renders them
 * without the app chrome: each concept draws its own full composition.
 * Nothing else is affected (matcher limits it to /concepts).
 */
export function proxy(request: NextRequest) {
  const headers = new Headers(request.headers);
  headers.set("x-hlos-bare", "1");
  return NextResponse.next({ request: { headers } });
}

export const config = { matcher: "/concepts/:path*" };
