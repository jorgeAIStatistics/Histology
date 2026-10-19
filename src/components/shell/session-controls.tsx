"use client";

import { FlaskConical, Lock, LogOut } from "lucide-react";
import { cn } from "@/lib/cn";
import { ROLE_LABEL } from "@/lib/roles";
import { lockNow, signOut } from "@/lib/client/session";
import type { ShellActor } from "@/lib/client/types";
import { ROLE_SHORT } from "./acting-as";

const BAR_BUTTON = cn(
  "inline-flex h-10 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border border-shell-line px-2.5 text-sm font-medium text-shell-fg transition-colors duration-[var(--hlo-duration-fast)] hover:bg-shell-2",
  // Below 1280px a 44px icon target; the word stays the accessible name.
  "max-xl:size-11 max-xl:justify-center max-xl:px-0",
);

/**
 * Secured mode, in the top bar: who is signed in (name and role, not a
 * control), "Lock" (the workstation locks now; the content leaves the screen)
 * and "Sign out". As compact as the demo's role indicator: the bar never
 * grows. Never shown in the synthetic demo.
 */
export function SessionControls({ actor }: { actor: ShellActor }) {
  const sentence = `Signed in: ${actor.name}, ${ROLE_LABEL[actor.role]}`;
  return (
    <div role="group" aria-label="Session" className="flex min-w-0 shrink items-center gap-1.5">
      <p role="note" aria-label={sentence} title={sentence} className="flex h-10 min-w-0 shrink flex-col justify-center px-1 leading-tight text-shell-fg max-xl:px-0">
        <span aria-hidden className="min-w-0 max-w-[11rem] truncate text-sm font-semibold max-xl:max-w-[7rem]">
          {actor.name}
        </span>
        <span aria-hidden className="min-w-0 max-w-[11rem] truncate text-xs text-shell-muted max-xl:max-w-[7rem]">
          {ROLE_SHORT[actor.role]}
        </span>
      </p>
      <button type="button" className={BAR_BUTTON} title="Lock this workstation now" onClick={() => lockNow("manual")}>
        <Lock className="size-4 shrink-0" aria-hidden />
        <span className="max-xl:sr-only">Lock</span>
      </button>
      <button type="button" className={BAR_BUTTON} title="Sign out of Histology Lab OS" onClick={() => void signOut()}>
        <LogOut className="size-4 shrink-0" aria-hidden />
        <span className="max-xl:sr-only">Sign out</span>
      </button>
    </div>
  );
}

/**
 * Secured mode with the synthetic seed loaded (HLOS_SEED_SYNTHETIC=1, a test
 * environment): a persistent label, as the demo's status pill.
 */
export function SyntheticDataLabel() {
  return (
    <p
      role="note"
      aria-label="Synthetic data: no real patients"
      title="Synthetic data only. No real patients. This secured test environment was loaded with the synthetic seed."
      className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-pill bg-shell-fg px-2.5 text-sm font-semibold text-shell"
    >
      <FlaskConical className="size-3.5" aria-hidden />
      Synthetic<span className="max-[96rem]:sr-only"> data</span>
    </p>
  );
}
