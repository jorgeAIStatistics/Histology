"use client";

import { useState } from "react";
import { RefreshCw, UserRoundX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { startSignIn, useSessionState } from "@/lib/client/session";

/**
 * Floating notice (secured mode) while the page stays on screen but can no
 * longer record anything:
 * - ended: the session expired or was ended. Nothing was recorded; what the
 *   person typed stays on screen. "Sign in again" opens sign-in in a pop-up,
 *   then the person presses their action again (nothing is replayed).
 * - handover: someone else signed in on this browser after this page was
 *   opened. Nothing from this screen is recorded; "Reload" continues as the
 *   person signed in now.
 * It floats under the top bar (the bar itself never grows). While a modal
 * dialog is open the dialog's own inline error offers the same action.
 */
export function SessionNotice() {
  const state = useSessionState();
  const [opening, setOpening] = useState(false);
  if (state.status !== "ended" && state.status !== "handover") return null;
  const handover = state.status === "handover";
  const title = handover
    ? "This screen was opened by another user"
    : state.endedCode === "SESSION_EXPIRED"
      ? "Your session has ended"
      : "You are signed out";
  const recorded = state.commandRefused ? "Nothing was recorded." : handover ? "Nothing done on it will be recorded." : "Nothing more can be recorded.";
  const body = handover
    ? `${recorded} Reload to continue as ${state.current?.name ?? "the person signed in now"}.`
    : `${recorded} Sign in again to continue; what you entered stays on this screen.`;
  return (
    <div
      role="alert"
      aria-label={title}
      // Stays usable (Sign in again, Reload) while a modal side sheet makes the page inert.
      data-modal-exempt=""
      className="no-print fixed left-1/2 top-[calc(var(--hlo-chrome-h)+0.5rem)] z-[65] flex w-[min(44rem,calc(100vw-2rem))] -translate-x-1/2 items-start gap-3 rounded-md border border-warning-border bg-warning-bg px-3 py-2.5 shadow-2"
    >
      <UserRoundX className="mt-0.5 size-4 shrink-0 text-warning-solid" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-warning-fg">{title}</p>
        <p className="mt-0.5 text-sm text-ink">{body}</p>
      </div>
      <div className="flex shrink-0 items-center self-center">
        {handover ? (
          <Button size="sm" variant="primary" icon={<RefreshCw className="size-4" aria-hidden />} onClick={() => window.location.reload()}>
            Reload
          </Button>
        ) : (
          <Button
            size="sm"
            variant="primary"
            loading={opening}
            loadingLabel="Opening sign-in..."
            onClick={() => {
              if (startSignIn({ reauth: false }) === "popup") return;
              setOpening(true);
            }}
          >
            Sign in again
          </Button>
        )}
      </div>
    </div>
  );
}
