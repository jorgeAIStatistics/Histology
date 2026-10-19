"use client";

import { useSyncExternalStore } from "react";
import type { Role } from "@/lib/roles";

/**
 * Client side of the SECURED mode session (server: src/server/auth/*). In the
 * synthetic demo nothing here is ever initialised, so every request and every
 * screen is exactly as before (no X-HLOS-Actor header, no lock screen).
 *
 * One store per browser document (module state, browser only):
 * - PAGE ACTOR: the staff member the first server render of this document was
 *   for. It never changes for the life of the document (a background refresh
 *   after someone else signed in on this browser does not change it). It is
 *   sent as X-HLOS-Actor on every command and on the CSV export, so the server
 *   refuses (409 ACTOR_MISMATCH, nothing recorded) an action from a screen
 *   that was opened by someone other than the person signed in now.
 * - STATUS, rendered by <SessionGate> (src/components/auth/session-gate.tsx):
 *     active       the page actor is signed in and unlocked
 *     locked       idle timer, "Lock", another tab, or the server answered
 *                  SESSION_LOCKED: the whole app is replaced by the lock
 *                  screen (page content removed from the DOM)
 *     ended        the session expired (SESSION_EXPIRED): the page stays
 *                  (typed input kept), a notice says nothing was recorded and
 *                  offers sign-in
 *     revoked      the server no longer knows the session (SIGN_IN_REQUIRED:
 *                  revoked by an administrator, signed out elsewhere, gone):
 *                  content removed at once, neutral screen
 *     handover     someone else signed in on this browser after this page was
 *                  opened: the page stays, nothing from it can be recorded
 *     signing_out / signed_out / no_access: content removed, neutral screen
 *     auth_done    this window is the sign-in pop-up that just finished
 * - ACTIVITY for the idle lock: real input (keys, pointer, wheel, touch),
 *   shared with the other tabs of this browser over a BroadcastChannel so a
 *   background tab never locks the workstation while the person works in
 *   another tab; a heartbeat (POST /api/auth/activity, at most about once a
 *   minute and only after real input) keeps the server's idle lock in step.
 *   Background polling never counts as activity.
 *
 * Sign-in for "Confirm it's you" and "Sign in again" opens the identity
 * provider in a pop-up window, so what the person typed on this page stays
 * where it is; nothing is replayed automatically. The pop-up returns to this
 * page with #hlos-auth-done, tells the other tabs (BroadcastChannel) and
 * closes. If the browser blocks the pop-up, the same tab goes to sign-in.
 * Unlock is always a full navigation through sign-in back to the same URL.
 */

export interface PageActor {
  id: string;
  name: string;
  role: Role;
}

export type SessionStatus = "active" | "locked" | "ended" | "handover" | "revoked" | "signing_out" | "signed_out" | "no_access" | "auth_done";
export type EndedCode = "SESSION_EXPIRED" | "SIGN_IN_REQUIRED";
export type LockReason = "manual" | "idle" | "server" | "other_tab";

export interface SessionState {
  /** True once a secured-mode page initialised the store (never in the synthetic demo). */
  secured: boolean;
  /** The staff member this document was rendered for (fixed). */
  pageActor: PageActor | null;
  status: SessionStatus;
  endedCode: EndedCode | null;
  /** Who is signed in on this browser now, when it is someone else (hand-over). */
  current: { id: string; name: string } | null;
  lockReason: LockReason | null;
  /** A command was refused for the session's state: nothing was recorded. */
  commandRefused: boolean;
  /** Bumped each time a sign-in in the pop-up finished (for "Confirmed, press it again"). */
  reauthSeq: number;
  /** The application URL that was on screen when the lock happened (Unlock returns there). */
  lockedUrl: string | null;
}

const INITIAL: SessionState = {
  secured: false,
  pageActor: null,
  status: "active",
  endedCode: null,
  current: null,
  lockReason: null,
  commandRefused: false,
  reauthSeq: 0,
  lockedUrl: null,
};

let state: SessionState = INITIAL;
const listeners = new Set<() => void>();

function set(patch: Partial<SessionState>): void {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

export function getSessionState(): SessionState {
  return state;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The session store (server render: the inert initial state). */
export function useSessionState(): SessionState {
  return useSyncExternalStore(subscribe, getSessionState, () => INITIAL);
}

const isBrowser = () => typeof window !== "undefined";

/** Statuses that removed the page content: only a full reload leaves them. */
const CONTENT_GONE: readonly SessionStatus[] = ["locked", "revoked", "signing_out", "signed_out", "no_access", "auth_done"];

export function contentRemoved(s: SessionState = state): boolean {
  return CONTENT_GONE.includes(s.status);
}

// ------------------------------------------------------------------ initialisation and the page actor

let idleMs = 15 * 60_000;

/**
 * Called once by <SessionGate> on the first client render of a secured page.
 * Fixes the page actor for the life of this document.
 */
export function initSecuredSession(actor: PageActor, opts: { idleMinutes: number }): void {
  if (!isBrowser() || state.pageActor) return;
  idleMs = Math.max(1, opts.idleMinutes) * 60_000;
  const now = Date.now();
  lastInput = now;
  lastLocalInput = 0;
  lastHeartbeat = now; // the page load itself counted as activity on the server
  // No listener exists yet (first render): assign without notifying anyone.
  state = { ...state, secured: true, pageActor: { id: actor.id, name: actor.name, role: actor.role } };
  openChannel();
  post({ type: "active", actor: { id: actor.id, name: actor.name } });
}

/** The page actor's staff id (secured mode), else null. */
export function pageActorId(): string | null {
  return state.secured ? (state.pageActor?.id ?? null) : null;
}

/** Adds X-HLOS-Actor (the page actor) in secured mode; unchanged in the synthetic demo. */
export function withActorHeader(headers: Record<string, string>): Record<string, string> {
  const id = pageActorId();
  return id ? { ...headers, "X-HLOS-Actor": id } : headers;
}

/**
 * A later server render of this document for another staff member (for
 * example a refresh that ran after a hand-over). The page actor stays; the
 * screen says who is signed in now.
 */
export function notePageRender(actor: { id: string; name: string }): void {
  if (!state.secured || !state.pageActor || actor.id === state.pageActor.id) return;
  markHandover({ id: actor.id, name: actor.name });
}

function markHandover(current: { id: string; name: string } | null, commandRefused = false): void {
  if (state.status === "active" || state.status === "ended" || state.status === "handover") {
    set({ status: "handover", current: current ?? state.current, commandRefused: state.commandRefused || commandRefused });
  }
}

// ------------------------------------------------------------------ auth failures (commands, polling)

export interface AuthFailureLike {
  code: string;
  message: string;
  details?: unknown;
}

const SESSION_CODES = new Set(["SIGN_IN_REQUIRED", "SESSION_EXPIRED", "SESSION_LOCKED", "REAUTH_REQUIRED", "ACTOR_MISMATCH"]);

/** True for the session failures this module handles (secured mode only). */
export function isSessionFailure(code: string | undefined | null): boolean {
  return state.secured && !!code && SESSION_CODES.has(code);
}

/**
 * Failures the session screens show globally (lock screen, the session notice):
 * a command does not also raise a toast for them.
 */
export function isShownBySession(code: string | undefined | null): boolean {
  return isSessionFailure(code) && code !== "REAUTH_REQUIRED";
}

/**
 * Records a session failure seen by a command (fromCommand: nothing was
 * recorded) or by background polling, and moves the screen to the matching
 * status. Ignored in the synthetic demo.
 */
export function reportAuthFailure(code: string | undefined | null, opts: { fromCommand?: boolean } = {}): void {
  if (!state.secured || !code) return;
  const fromCommand = Boolean(opts.fromCommand);
  switch (code) {
    case "SESSION_LOCKED":
      lockLocally("server", fromCommand);
      post({ type: "locked" });
      return;
    case "SESSION_EXPIRED":
      if (state.status === "active" || state.status === "handover" || state.status === "ended") {
        set({ status: "ended", endedCode: code, commandRefused: state.commandRefused || fromCommand });
      }
      return;
    case "SIGN_IN_REQUIRED":
      // The session was revoked (an administrator, a sign-out elsewhere) or is gone: nothing stays on screen.
      if (!contentRemoved()) {
        set({ status: "revoked", endedCode: code, commandRefused: state.commandRefused || fromCommand });
        scrubDocument("Session ended");
      }
      return;
    case "ACTOR_MISMATCH":
      markHandover(null, fromCommand);
      return;
    default:
      return;
  }
}

/** Who is signed in on this browser now (GET /api/auth/session never counts as activity). */
async function fetchSession(): Promise<
  | { kind: "active"; actor: { id: string; name: string } }
  | { kind: "locked" }
  | { kind: "refused"; status: number; code: string | null }
  | { kind: "unknown" }
> {
  let res: Response;
  try {
    res = await fetch("/api/auth/session", { cache: "no-store", headers: { Accept: "application/json" } });
  } catch {
    return { kind: "unknown" };
  }
  let body: { ok?: boolean; result?: { locked?: boolean; actor?: { id: string; name: string } | null }; error?: { code?: string } } | null = null;
  try {
    body = await res.json();
  } catch {
    return { kind: "unknown" };
  }
  if (res.ok && body?.ok && body.result) {
    if (body.result.locked) return { kind: "locked" };
    if (body.result.actor) return { kind: "active", actor: { id: body.result.actor.id, name: body.result.actor.name } };
    return { kind: "unknown" };
  }
  if (res.status === 401 || res.status === 403) return { kind: "refused", status: res.status, code: body?.error?.code ?? null };
  return { kind: "unknown" };
}

/**
 * Re-reads the session and updates the screen: locked -> lock screen; someone
 * else signed in -> hand-over notice; ended -> notice; access removed ->
 * content removed. Returns the actor signed in now, when there is one.
 */
export async function refreshSessionStatus(): Promise<{ id: string; name: string } | null> {
  if (!state.secured || contentRemoved()) return null;
  const s = await fetchSession();
  if (contentRemoved()) return null;
  switch (s.kind) {
    case "locked":
      lockLocally("server");
      return null;
    case "active":
      if (state.pageActor && s.actor.id !== state.pageActor.id) {
        markHandover(s.actor);
      } else if (state.status === "ended") {
        set({ status: "active", endedCode: null });
      }
      return s.actor;
    case "refused":
      if (s.status === 403) {
        // Deactivated, unlinked or moved to another lab: nothing more is shown.
        set({ status: "no_access" });
        scrubDocument("No access");
      } else {
        reportAuthFailure(s.code);
      }
      return null;
    default:
      return null;
  }
}

/** Current actor's display name for "Reload to continue as …" (null when unknown or locked). */
export async function currentActorName(): Promise<string | null> {
  const s = await fetchSession();
  if (s.kind !== "active") return null;
  if (state.pageActor && s.actor.id !== state.pageActor.id) markHandover(s.actor);
  return s.actor.name;
}

/**
 * Before a background refresh (LiveRefresh): only while this document's actor
 * is still the one signed in and unlocked. In the synthetic demo: always.
 */
export async function mayRefreshForPageActor(): Promise<boolean> {
  if (!state.secured) return true;
  if (state.status !== "active") return false;
  const actor = await refreshSessionStatus();
  return state.status === "active" && !!actor && actor.id === state.pageActor?.id;
}

const AUTH_MESSAGE: Record<string, string> = {
  SESSION_EXPIRED: "Nothing was recorded. Sign in again to continue; what you entered stays on this screen.",
  SIGN_IN_REQUIRED: "Nothing was recorded. Sign in again to continue; what you entered stays on this screen.",
  SESSION_LOCKED: "Nothing was recorded. This workstation is locked.",
  REAUTH_REQUIRED: "This decision needs a recent sign-in. Nothing was recorded. Confirm it's you, then press the button again.",
};

/** The spec's wording for a refused hand-over screen. */
export function actorMismatchMessage(name: string | null): string {
  return `This screen was opened by another user. Nothing was recorded. Reload to continue as ${name ?? "the person signed in now"}.`;
}

/**
 * A command's session failure, in the words the screen shows, after the
 * session status was updated. Other failures are returned unchanged.
 */
export async function handleCommandAuthFailure<E extends AuthFailureLike>(error: E): Promise<E> {
  if (!isSessionFailure(error.code)) return error;
  if (error.code === "ACTOR_MISMATCH") {
    reportAuthFailure(error.code, { fromCommand: true });
    // Also records who is signed in now (the hand-over notice names them).
    const name = await currentActorName();
    return { ...error, message: actorMismatchMessage(name ?? state.current?.name ?? null) };
  }
  reportAuthFailure(error.code, { fromCommand: true });
  return { ...error, message: AUTH_MESSAGE[error.code] ?? error.message };
}

// ------------------------------------------------------------------ lock, unlock, sign-in, sign-out

const PLAIN_PAGES = /^\/(?:signin|signed-out|locked|no-access|forbidden)(?:\/|$)/;

/** The application path on screen (never a plain sign-in page); the URL at lock time when there is no better one. */
function currentAppUrl(): string {
  if (!isBrowser()) return "/";
  const { pathname, search } = window.location;
  if (PLAIN_PAGES.test(pathname)) return state.lockedUrl ?? "/";
  return `${pathname}${search}`;
}

function loginUrl(returnTo: string, reauth: boolean): string {
  return `/api/auth/login?returnTo=${encodeURIComponent(returnTo)}${reauth ? "&reauth=1" : ""}`;
}

/**
 * Removes what the DOM still holds besides the rendered page once the content
 * is gone: the inline React Server Component payload scripts (they carry the
 * page data) and a title that may name a record.
 */
function scrubDocument(title: string): void {
  if (!isBrowser()) return;
  try {
    document.title = `${title} · Histology Lab OS`;
    for (const s of Array.from(document.querySelectorAll("script:not([src])"))) {
      if ((s.textContent ?? "").includes("__next_f")) s.remove();
    }
  } catch {
    /* best effort; the content itself is unmounted by <SessionGate> */
  }
}

function lockLocally(reason: LockReason, commandRefused = false): void {
  if (!state.secured || contentRemoved()) return;
  set({ status: "locked", lockReason: reason, lockedUrl: currentAppUrl(), commandRefused: state.commandRefused || commandRefused });
  scrubDocument("Workstation locked");
}

/** "Lock" or the idle timer: the screen locks first (fail closed), then the server session. */
export function lockNow(reason: "manual" | "idle"): void {
  if (!state.secured || contentRemoved()) return;
  lockLocally(reason);
  post({ type: "locked" });
  void fetch("/api/auth/lock", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: "{}",
    cache: "no-store",
    keepalive: true,
  }).catch(() => undefined);
}

/** Unlock: sign in again (forced re-authentication) and come back to the locked URL. */
export function unlock(): void {
  if (!isBrowser()) return;
  window.location.assign(loginUrl(state.lockedUrl ?? currentAppUrl(), true));
}

export const AUTH_DONE_HASH = "hlos-auth-done";

/**
 * Sign in without leaving the page: the provider opens in a pop-up and comes
 * back to this page's URL with #hlos-auth-done. reauth forces the provider to
 * ask again ("Confirm it's you"). Falls back to the same tab when pop-ups are
 * blocked (the typed input is then lost; nothing is replayed either way).
 */
export function startSignIn(opts: { reauth: boolean }): "popup" | "redirect" {
  const here = currentAppUrl();
  const popup = window.open(loginUrl(`${here}#${AUTH_DONE_HASH}`, opts.reauth), "hlos-signin", "popup=yes,width=560,height=720");
  if (popup) {
    try {
      popup.focus();
    } catch {
      /* ignore */
    }
    return "popup";
  }
  window.location.assign(loginUrl(here, opts.reauth));
  return "redirect";
}

/**
 * In the sign-in pop-up, back on this application: tell the opener (and every
 * other tab) who signed in, and close. Returns true when this window was it.
 */
export function completeAuthPopupIfAny(): boolean {
  if (!isBrowser() || !state.secured || window.location.hash !== `#${AUTH_DONE_HASH}`) return false;
  try {
    window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}`);
  } catch {
    /* ignore */
  }
  const actor = state.pageActor;
  if (actor) post({ type: "auth_done", actor: { id: actor.id, name: actor.name } });
  set({ status: "auth_done" });
  scrubDocument("Signed in");
  window.setTimeout(() => {
    try {
      window.close();
    } catch {
      /* the page says it can be closed */
    }
  }, 50);
  return true;
}

/** Sign out: the content goes first, then the session (and the provider's session when it offers an end-session URL). */
export async function signOut(): Promise<void> {
  if (!isBrowser() || state.status === "signing_out") return;
  set({ status: "signing_out" });
  scrubDocument("Signing out");
  post({ type: "signed_out" });
  let endSessionUrl: string | null = null;
  try {
    const res = await fetch("/api/auth/logout", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: "{}",
      cache: "no-store",
    });
    const body = (await res.json().catch(() => null)) as { result?: { endSessionUrl?: string | null } } | null;
    const url = body?.result?.endSessionUrl;
    if (typeof url === "string" && /^https?:\/\//i.test(url)) endSessionUrl = url;
  } catch {
    /* the local session cookie may still be cleared by the next sign-in; the screen shows nothing either way */
  }
  // replace(): the signed-out page takes this history entry, so Back does not return to it.
  window.location.replace(endSessionUrl ?? "/signed-out");
}

// ------------------------------------------------------------------ activity and the idle lock

let lastInput = 0; // last input in this tab or any other tab of this browser
let lastLocalInput = 0; // last input in this tab
let lastBroadcast = 0;
let lastHeartbeat = 0;
let heartbeatInFlight = false;

/** Real user input in this tab (trusted events only; the caller filters). */
export function noteUserInput(now: number = Date.now()): void {
  if (!state.secured) return;
  lastInput = Math.max(lastInput, now);
  lastLocalInput = now;
  if (now - lastBroadcast >= 5_000) {
    lastBroadcast = now;
    post({ type: "activity", at: now });
  }
}

/** Once a second from <SessionGate>: idle lock and the activity heartbeat. */
export function idleTick(now: number = Date.now()): void {
  if (!state.secured || contentRemoved()) return;
  if (now - lastInput >= idleMs) {
    lockNow("idle");
    return;
  }
  const every = Math.min(60_000, Math.max(10_000, Math.floor(idleMs / 4)));
  if (!heartbeatInFlight && lastLocalInput > lastHeartbeat && now - lastHeartbeat >= every && state.status !== "ended") {
    heartbeatInFlight = true;
    lastHeartbeat = now;
    void fetch("/api/auth/activity", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: "{}",
      cache: "no-store",
    })
      .then(async (res) => {
        if (res.ok) return;
        const body = (await res.json().catch(() => null)) as { error?: { code?: string } } | null;
        reportAuthFailure(body?.error?.code);
      })
      .catch(() => undefined)
      .finally(() => {
        heartbeatInFlight = false;
      });
  }
}

// ------------------------------------------------------------------ other tabs of this browser

type Message =
  | { type: "activity"; at: number }
  | { type: "locked" }
  | { type: "signed_out" }
  | { type: "active"; actor: { id: string; name: string } }
  | { type: "auth_done"; actor: { id: string; name: string } };

let channel: BroadcastChannel | null = null;

function openChannel(): void {
  if (channel || !isBrowser() || typeof BroadcastChannel === "undefined") return;
  try {
    channel = new BroadcastChannel("hlos-session");
    channel.onmessage = (e: MessageEvent) => onMessage(e.data as Message);
  } catch {
    channel = null;
  }
}

function post(m: Message): void {
  try {
    channel?.postMessage(m);
  } catch {
    /* ignore */
  }
}

function isActorMessage(a: unknown): a is { id: string; name: string } {
  return !!a && typeof (a as { id?: unknown }).id === "string" && typeof (a as { name?: unknown }).name === "string";
}

function onMessage(m: Message): void {
  if (!state.secured || !m || typeof m !== "object") return;
  switch (m.type) {
    case "activity":
      if (typeof m.at === "number" && Number.isFinite(m.at)) lastInput = Math.max(lastInput, Math.min(m.at, Date.now()));
      return;
    case "locked":
      lockLocally("other_tab");
      return;
    case "signed_out":
      if (state.status !== "signing_out" && state.status !== "signed_out") {
        set({ status: "signed_out" });
        scrubDocument("Signed out");
      }
      return;
    case "active":
    case "auth_done": {
      if (!isActorMessage(m.actor)) return;
      if (m.type === "auth_done") set({ reauthSeq: state.reauthSeq + 1 });
      // Another tab got past sign-in: a locked screen here can show the session again (after a server check).
      if (state.status === "locked") {
        window.location.reload();
        return;
      }
      if (state.pageActor && m.actor.id !== state.pageActor.id) markHandover(m.actor);
      else if (state.status === "ended") set({ status: "active", endedCode: null });
      return;
    }
    default:
      return;
  }
}

// ------------------------------------------------------------------ back/forward cache

/**
 * A page restored from the browser's back/forward cache would show its old
 * DOM without asking the server. On the way out (pagehide, persisted) the
 * secured page hides itself; when it is restored it reloads, so the server
 * guard decides what is shown (sign-in, lock, or the page). Returns a cleanup.
 */
export function installCacheGuard(): () => void {
  if (!isBrowser()) return () => undefined;
  const onHide = (e: PageTransitionEvent) => {
    if (!state.secured) return;
    if (e.persisted) document.documentElement.style.visibility = "hidden";
  };
  const onShow = (e: PageTransitionEvent) => {
    if (!state.secured || !e.persisted) return;
    document.documentElement.style.visibility = "hidden";
    window.location.reload();
  };
  window.addEventListener("pagehide", onHide);
  window.addEventListener("pageshow", onShow);
  return () => {
    window.removeEventListener("pagehide", onHide);
    window.removeEventListener("pageshow", onShow);
  };
}
