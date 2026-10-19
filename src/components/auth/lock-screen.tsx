"use client";

import { useEffect, useRef, useState } from "react";
import { LockKeyhole } from "lucide-react";
import { Button, buttonClasses } from "@/components/ui/button";
import { signOut, unlock } from "@/lib/client/session";

/**
 * "Workstation locked": replaces the whole app (top bar included) while the
 * session is locked. Neutral on purpose: no patient, case, specimen or
 * operator details, not even who locked it. Two ways out:
 * - Unlock: sign in again at the identity provider (forced re-authentication)
 *   and return to the same URL. If a different person signs in, the previous
 *   person's session ends there (workstation hand-over).
 * - Sign out / switch user: ends this session (and the provider's session when
 *   it offers an end-session page) so someone else can sign in.
 */
export function LockScreen({ commandRefused }: { commandRefused: boolean }) {
  const heading = useRef<HTMLHeadingElement>(null);
  const [leaving, setLeaving] = useState<"unlock" | "signout" | null>(null);
  useEffect(() => {
    heading.current?.focus();
  }, []);
  return (
    <main id="main" tabIndex={-1} className="flex min-h-screen items-start justify-center bg-canvas px-4 py-16 focus:outline-none">
      <section aria-labelledby="lock-title" className="w-full max-w-lg rounded-lg border border-line bg-surface p-6">
        <p className="flex items-center gap-2 text-sm font-semibold text-ink-muted">
          <LockKeyhole className="size-4" aria-hidden />
          Histology Lab OS
        </p>
        <h1 id="lock-title" ref={heading} tabIndex={-1} className="mt-1 text-xl font-bold tracking-[-0.015em] text-ink focus:outline-none">
          Workstation locked
        </h1>
        <div className="mt-3 flex flex-col gap-3 text-sm text-ink-secondary">
          {commandRefused ? (
            <p role="alert" className="font-semibold text-ink">
              Your last action was not recorded.
            </p>
          ) : null}
          <p>Nothing is shown while this workstation is locked.</p>
          <p>Unlock to continue where you were: you sign in again. If someone else will work here, sign out first.</p>
        </div>
        <div className="mt-5 flex flex-wrap gap-2">
          <Button
            variant="primary"
            loading={leaving === "unlock"}
            loadingLabel="Opening sign-in..."
            disabled={leaving === "signout"}
            onClick={() => {
              setLeaving("unlock");
              unlock();
            }}
          >
            Unlock
          </Button>
          <Button
            variant="secondary"
            loading={leaving === "signout"}
            loadingLabel="Signing out..."
            disabled={leaving === "unlock"}
            onClick={() => {
              setLeaving("signout");
              void signOut();
            }}
          >
            Sign out / switch user
          </Button>
        </div>
      </section>
    </main>
  );
}

/** A neutral full-page message with no laboratory data (signing out, signed out elsewhere, access removed, pop-up done). */
export function NeutralScreen({ title, body, action, busy }: { title: string; body: string; action?: { label: string; href: string }; busy?: boolean }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, []);
  return (
    <main id="main" tabIndex={-1} aria-busy={busy || undefined} className="flex min-h-screen items-start justify-center bg-canvas px-4 py-16 focus:outline-none">
      <section aria-labelledby="neutral-title" className="w-full max-w-lg rounded-lg border border-line bg-surface p-6">
        <p className="text-sm font-semibold text-ink-muted">Histology Lab OS</p>
        <h1 id="neutral-title" ref={heading} tabIndex={-1} className="mt-1 text-xl font-bold tracking-[-0.015em] text-ink focus:outline-none">
          {title}
        </h1>
        <p className="mt-3 text-sm text-ink-secondary">{body}</p>
        {action ? (
          <div className="mt-5 flex flex-wrap gap-2">
            {/* A full navigation (never prefetched): sign-in is an API route. */}
            <a href={action.href} className={buttonClasses({ variant: "primary" })}>
              {action.label}
            </a>
          </div>
        ) : null}
      </section>
    </main>
  );
}
