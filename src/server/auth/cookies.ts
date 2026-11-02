/**
 * Minimal cookie helpers for route handlers that work on a plain Request /
 * Response (testable without the Next.js request context).
 */

/** Value of cookie `name` from a Cookie header, or undefined. Values are URI-decoded when well formed. */
export function readCookie(header: string | null | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const raw = part.slice(eq + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return undefined;
}

export interface CookieOptions {
  /** Seconds; omitted = a browser-session cookie (gone when the browser closes). 0 deletes it. */
  maxAge?: number;
  secure: boolean;
  httpOnly?: boolean;
  sameSite?: "Lax" | "Strict";
}

/** Set-Cookie value. Always Path=/ and never a Domain (required by the __Host- prefix). */
export function serializeCookie(name: string, value: string, opts: CookieOptions): string {
  const parts = [`${name}=${encodeURIComponent(value)}`, "Path=/", `SameSite=${opts.sameSite ?? "Lax"}`];
  if (opts.httpOnly !== false) parts.push("HttpOnly");
  if (opts.secure) parts.push("Secure");
  if (opts.maxAge !== undefined) {
    parts.push(`Max-Age=${Math.max(0, Math.floor(opts.maxAge))}`);
    if (opts.maxAge <= 0) parts.push("Expires=Thu, 01 Jan 1970 00:00:00 GMT");
  }
  return parts.join("; ");
}

/** A Set-Cookie value that deletes `name`. */
export function clearCookie(name: string, secure: boolean): string {
  return serializeCookie(name, "", { maxAge: 0, secure });
}
