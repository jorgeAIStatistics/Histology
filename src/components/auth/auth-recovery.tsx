"use client";

import { useState } from "react";
import { RefreshCw, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { startSignIn, useSessionState } from "@/lib/client/session";

/**
 * The way out of a session failure, inside the inline command error
 * (CommandError). Secured mode only; renders nothing in the synthetic demo and
 * for every other failure.
 * - REAUTH_REQUIRED: "Confirm it's you" signs in again in a pop-up (the form
 *   and what was typed stay); then the person presses the action again.
 *   Nothing is replayed automatically.
 * - SESSION_EXPIRED / SIGN_IN_REQUIRED: "Sign in again", the same way.
 * - ACTOR_MISMATCH: "Reload" continues as the person signed in now.
 */
export function AuthRecovery({ code }: { code: string }) {
  const state = useSessionState();
  // The sign-ins that had already finished when this error appeared.
  const [seenSeq] = useState(state.reauthSeq);
  const [opening, setOpening] = useState(false);
  if (!state.secured) return null;
  const confirmed = state.reauthSeq > seenSeq;
  const signIn = (reauth: boolean) => {
    if (startSignIn({ reauth }) === "redirect") setOpening(true);
  };
  switch (code) {
    case "REAUTH_REQUIRED":
      if (confirmed && state.status === "active") {
        return (
          <span role="status" className="ml-1 font-semibold text-ink">
            Confirmed. Press the button again to record it.
          </span>
        );
      }
      return (
        <Button
          size="sm"
          variant="secondary"
          className="ml-2 align-middle"
          icon={<ShieldCheck className="size-4" aria-hidden />}
          loading={opening}
          loadingLabel="Opening sign-in..."
          onClick={() => signIn(true)}
        >
          Confirm it&apos;s you
        </Button>
      );
    case "SESSION_EXPIRED":
    case "SIGN_IN_REQUIRED":
      if (confirmed && state.status === "active") {
        return (
          <span role="status" className="ml-1 font-semibold text-ink">
            Signed in again. Press the button again to record it.
          </span>
        );
      }
      return (
        <Button size="sm" variant="secondary" className="ml-2 align-middle" loading={opening} loadingLabel="Opening sign-in..." onClick={() => signIn(false)}>
          Sign in again
        </Button>
      );
    case "ACTOR_MISMATCH":
      return (
        <Button size="sm" variant="secondary" className="ml-2 align-middle" icon={<RefreshCw className="size-4" aria-hidden />} onClick={() => window.location.reload()}>
          Reload
        </Button>
      );
    default:
      return null;
  }
}
