"use client";

import { useEffect, useState, type ReactNode } from "react";
import type { ShellActor } from "@/lib/client/types";
import {
  completeAuthPopupIfAny,
  idleTick,
  initSecuredSession,
  installCacheGuard,
  noteUserInput,
  notePageRender,
  refreshSessionStatus,
  useSessionState,
} from "@/lib/client/session";
import { LockScreen, NeutralScreen } from "./lock-screen";
import { SessionNotice } from "./session-notice";

/** What the server shell passes for a signed-in secured page (never in the synthetic demo). */
export interface SecuredShellSession {
  /** The signed-in staff member this page is rendered for. */
  actor: ShellActor;
  /** HLOS_SESSION_IDLE_MIN: the client idle lock. */
  idleMinutes: number;
  /** The synthetic seed is loaded (HLOS_SEED_SYNTHETIC=1): the shell says "Synthetic data". */
  synthetic: boolean;
}

/** How often the session itself is re-read (GET /api/auth/session never counts as activity). */
const SESSION_POLL_MS = 15_000;
/** Real input that keeps a workstation awake. Trusted events only. */
const INPUT_EVENTS = ["keydown", "pointerdown", "pointermove", "wheel", "touchstart", "input"] as const;

/**
 * Wraps the whole app chrome in SECURED mode. With `session={null}` (the
 * synthetic demo, plain pages) it renders its children and nothing else.
 *
 * - Fixes the page actor (X-HLOS-Actor) at the first render of the document.
 * - Idle lock: after HLOS_SESSION_IDLE_MIN of no input in any tab of this
 *   browser the screen locks, then the server session (POST /api/auth/lock).
 * - Locked (here, in another tab, or the server answered SESSION_LOCKED), or
 *   signing out: the children are NOT rendered (removed from the DOM, not
 *   covered); the lock screen shows no patient, case, specimen or operator
 *   details.
 * - Expired or handed over: the page stays, with a notice (nothing recorded,
 *   sign in again / reload).
 * - Revoked (the server no longer knows the session): the children are
 *   removed at once and a neutral "Session ended" screen offers sign-in.
 * - Back/forward cache: a restored page reloads so the server decides.
 */
export function SessionGate({ session, children }: { session: SecuredShellSession | null; children: ReactNode }) {
  if (!session) return <>{children}</>;
  return <SecuredGate session={session}>{children}</SecuredGate>;
}

function SecuredGate({ session, children }: { session: SecuredShellSession; children: ReactNode }) {
  // First render of this document: fix the page actor before anything can send a command.
  useState(() => {
    initSecuredSession(session.actor, { idleMinutes: session.idleMinutes });
    return 0;
  });
  const state = useSessionState();

  // A later server render for someone else (a refresh after a hand-over) never changes the page actor.
  useEffect(() => {
    notePageRender(session.actor);
  }, [session.actor]);

  // This window is the sign-in pop-up that just came back: report and close.
  useEffect(() => {
    completeAuthPopupIfAny();
  }, []);

  // Input, idle lock and the activity heartbeat.
  useEffect(() => {
    const onInput = (e: Event) => {
      if (e.isTrusted) noteUserInput();
    };
    const opts: AddEventListenerOptions = { capture: true, passive: true };
    for (const t of INPUT_EVENTS) window.addEventListener(t, onInput, opts);
    const timer = window.setInterval(() => idleTick(), 1000);
    return () => {
      for (const t of INPUT_EVENTS) window.removeEventListener(t, onInput, opts);
      window.clearInterval(timer);
    };
  }, []);

  // The session itself: locked elsewhere, ended, or someone else signed in on this browser.
  useEffect(() => {
    const check = () => {
      if (!document.hidden) void refreshSessionStatus();
    };
    const timer = window.setInterval(check, SESSION_POLL_MS);
    document.addEventListener("visibilitychange", check);
    window.addEventListener("focus", check);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", check);
      window.removeEventListener("focus", check);
    };
  }, []);

  useEffect(() => installCacheGuard(), []);

  switch (state.status) {
    case "locked":
      return <LockScreen commandRefused={state.commandRefused} />;
    case "signing_out":
      return <NeutralScreen title="Signing out" body="Nothing is shown while you are signed out." busy />;
    case "signed_out":
      return (
        <NeutralScreen
          title="Signed out"
          body="You signed out of Histology Lab OS in another tab of this browser. Nothing is shown here any more."
          action={{ label: "Sign in again", href: "/api/auth/login?returnTo=%2F&reauth=1" }}
        />
      );
    case "revoked":
      return (
        <NeutralScreen
          title="Session ended"
          body={`${state.commandRefused ? "Your last action was not recorded. " : ""}This session was ended (for example by the laboratory administrator, or by signing out elsewhere). Nothing is shown here any more.`}
          action={{ label: "Sign in again", href: "/api/auth/login?returnTo=%2F&reauth=1" }}
        />
      );
    case "no_access":
      return (
        <NeutralScreen
          title="No access"
          body="This account can no longer open Histology Lab OS in this laboratory. Nothing is shown any more. Ask the laboratory administrator."
          action={{ label: "Sign in as someone else", href: "/api/auth/login?returnTo=%2F&reauth=1" }}
        />
      );
    case "auth_done":
      return (
        <NeutralScreen
          title="Signed in"
          body="You can close this window and go back to your work. Nothing was done for you: press the button you used again."
        />
      );
    default:
      return (
        <>
          {children}
          {state.status === "ended" || state.status === "handover" ? <SessionNotice /> : null}
        </>
      );
  }
}
