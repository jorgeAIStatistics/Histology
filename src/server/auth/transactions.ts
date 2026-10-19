/**
 * One-time sign-in transactions (table auth_transaction) and the return path.
 *
 * - createTransaction: stores state, nonce and the PKCE verifier for 10 minutes.
 * - consumeTransaction: marks it consumed exactly once (atomic UPDATE); a
 *   replayed, unknown or expired state is refused.
 * - txBindingValue / txBindingMatches: the transaction is also bound to the
 *   browser that started it through a short-lived HttpOnly cookie holding an
 *   HMAC of the state (keyed by HLOS_SESSION_SECRET), so a callback URL
 *   started in another browser cannot sign this one in (login CSRF).
 * - safeReturnTo: only a same-origin application path is ever used as a
 *   redirect target after sign-in (no open redirect).
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { DB } from "../db/db";

export const TRANSACTION_TTL_MS = 10 * 60 * 1000;

export interface TransactionRow {
  state: string;
  nonce: string;
  code_verifier: string;
  return_to: string;
  reauth: number;
  created_at: string;
  expires_at: string;
  consumed_at: string | null;
}

const iso = (ms: number) => new Date(ms).toISOString();

export function createTransaction(
  db: DB,
  tx: { state: string; nonce: string; codeVerifier: string; returnTo: string; reauth: boolean },
  now: number = Date.now(),
): void {
  // Housekeeping: transactions past their expiry are useless; drop them (bounded by the index).
  db.prepare("DELETE FROM auth_transaction WHERE expires_at < ?").run(iso(now - 60_000));
  db.prepare(
    `INSERT INTO auth_transaction (state, nonce, code_verifier, return_to, reauth, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(tx.state, tx.nonce, tx.codeVerifier, safeReturnTo(tx.returnTo), tx.reauth ? 1 : 0, iso(now), iso(now + TRANSACTION_TTL_MS));
}

export type ConsumeResult = { ok: true; tx: TransactionRow } | { ok: false; reason: "unknown" | "consumed" | "expired" };

/** Consumes a transaction once. The UPDATE is the gate: two callbacks with one state cannot both succeed. */
export function consumeTransaction(db: DB, state: string, now: number = Date.now()): ConsumeResult {
  const row = db.prepare("SELECT * FROM auth_transaction WHERE state = ?").get(state) as TransactionRow | undefined;
  if (!row) return { ok: false, reason: "unknown" };
  if (row.consumed_at) return { ok: false, reason: "consumed" };
  if (now >= Date.parse(row.expires_at)) return { ok: false, reason: "expired" };
  const changed = db.prepare("UPDATE auth_transaction SET consumed_at = ? WHERE state = ? AND consumed_at IS NULL").run(iso(now), state).changes;
  if (changed !== 1) return { ok: false, reason: "consumed" };
  return { ok: true, tx: { ...row, consumed_at: iso(now) } };
}

/** Value of the browser-binding cookie for a state. */
export function txBindingValue(secret: string, state: string): string {
  return createHmac("sha256", secret).update(`hlos-auth-tx:${state}`).digest("base64url");
}

export function txBindingMatches(secret: string, state: string, presented: string | null | undefined): boolean {
  if (!presented) return false;
  const a = Buffer.from(txBindingValue(secret, state));
  const b = Buffer.from(presented);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Pages a sign-in must never return to (they would loop or say nothing useful). */
const NOT_A_RETURN_TARGET = /^\/(?:api(?:\/|$)|_next(?:\/|$)|signin(?:\/|$)|signed-out(?:\/|$)|locked(?:\/|$)|no-access(?:\/|$))/i;

/**
 * A same-origin application path to return to after sign-in, or `fallback`.
 * Refuses absolute URLs, scheme-relative ("//host"), backslash tricks
 * ("/\\host"), control characters, encoded slashes that normalize to another
 * origin, API and sign-in paths, and anything longer than 512 characters.
 */
export function safeReturnTo(raw: unknown, fallback = "/"): string {
  if (typeof raw !== "string") return fallback;
  const value = raw.trim();
  if (!value || value.length > 512) return fallback;
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return fallback;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) return fallback;
  let url: URL;
  try {
    url = new URL(value, "http://hlos.invalid");
  } catch {
    return fallback;
  }
  if (url.origin !== "http://hlos.invalid") return fallback;
  if (url.pathname.startsWith("//")) return fallback;
  if (NOT_A_RETURN_TARGET.test(url.pathname)) return fallback;
  return `${url.pathname}${url.search}${url.hash}`;
}
