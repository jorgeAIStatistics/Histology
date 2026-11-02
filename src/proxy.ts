import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { runtimeMode } from "@/server/runtime-mode";
import { SESSION_COOKIE_NAMES } from "@/server/auth/config";

/**
 * OPTIMISTIC checks only (Node runtime). The authoritative decision is made
 * on the server by src/server/auth/guard.ts in every page and API; nothing
 * here grants access, and a request that passes this proxy is still checked.
 *
 * Page routes (API routes, Next.js assets and static files are not matched):
 * - always: drops any client-sent x-hlos-bare / x-hlos-path, then sets
 *   x-hlos-path (the page's path and query, used as the sign-in returnTo);
 * - demo: design previews (/concepts/*) are marked x-hlos-bare so the root
 *   layout renders them without the app chrome. Nothing else changes;
 * - locked: every page except /locked redirects (307) to /locked, so no page
 *   of a locked build ever starts rendering;
 * - secured: /concepts/* is a 404; the plain sign-in pages are marked bare;
 *   any other GET without a session cookie redirects to /signin?returnTo=…
 *   (cookie PRESENCE only; the guard validates the session itself).
 */
const PLAIN_PAGES = new Set(["/signin", "/locked", "/signed-out", "/no-access", "/forbidden"]);

export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const mode = runtimeMode();
  const isConcept = pathname === "/concepts" || pathname.startsWith("/concepts/");
  const isPlain = PLAIN_PAGES.has(pathname);
  const isRead = request.method === "GET" || request.method === "HEAD";

  if (mode === "locked") {
    if (pathname === "/locked") return next(request, { bare: true });
    if (!isRead) return new NextResponse("Not configured", { status: 401, headers: { "Cache-Control": "no-store" } });
    return NextResponse.redirect(new URL("/locked", request.url), 307);
  }

  // Design previews exist only in synthetic demo mode.
  if (isConcept && mode !== "demo") return new NextResponse("Not found", { status: 404 });

  if (mode === "secured" && !isPlain && isRead) {
    const hasCookie = SESSION_COOKIE_NAMES.some((n) => request.cookies.has(n));
    if (!hasCookie) {
      const target = new URL("/signin", request.url);
      target.searchParams.set("returnTo", `${pathname}${search}`);
      return NextResponse.redirect(target, 307);
    }
  }

  return next(request, { bare: isConcept || (mode === "secured" && isPlain), path: `${pathname}${search}` });
}

function next(request: NextRequest, opts: { bare: boolean; path?: string }) {
  const headers = new Headers(request.headers);
  headers.delete("x-hlos-bare");
  headers.delete("x-hlos-path");
  if (opts.bare) headers.set("x-hlos-bare", "1");
  if (opts.path && opts.path.length <= 1024) headers.set("x-hlos-path", opts.path);
  return NextResponse.next({ request: { headers } });
}

export const config = {
  // Every page route; not the API, Next.js assets or static files (fonts, images, icons).
  matcher: ["/((?!api/|_next/|favicon\\.ico$|.*\\.(?:ico|png|jpg|jpeg|gif|svg|webp|woff2?|css|js|map|txt|xml|json)$).*)"],
};
