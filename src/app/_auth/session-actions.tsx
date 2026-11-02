"use client";

import { useState } from "react";
import { Lock, LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { signOut } from "@/lib/client/session";

/**
 * "Lock" and "Sign out" on the plain pages a signed-in person can reach
 * (/forbidden, /no-access; secured mode only), the same two actions the top
 * bar offers, so a shared workstation is never left signed in from a page
 * without the app chrome. They read no laboratory data.
 * - Sign out: ends this browser's session (and the provider's, when it offers
 *   an end-session page), then the signed-out page.
 * - Lock: locks the session on the server (every tab), then the sign-in page
 *   in its locked wording; unlocking is a fresh sign-in.
 */
export function PlainSessionActions({ lock = false }: { lock?: boolean }) {
  const [leaving, setLeaving] = useState<"lock" | "signout" | null>(null);
  const lockNow = async () => {
    setLeaving("lock");
    try {
      await fetch("/api/auth/lock", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: "{}",
        cache: "no-store",
      });
    } catch {
      /* the sign-in page asks for a fresh sign-in either way */
    }
    window.location.replace("/signin?reason=locked&returnTo=%2F");
  };
  return (
    <>
      {lock ? (
        <Button
          variant="secondary"
          icon={<Lock className="size-4" aria-hidden />}
          loading={leaving === "lock"}
          loadingLabel="Locking..."
          disabled={leaving === "signout"}
          onClick={() => void lockNow()}
        >
          Lock
        </Button>
      ) : null}
      <Button
        variant="secondary"
        icon={<LogOut className="size-4" aria-hidden />}
        loading={leaving === "signout"}
        loadingLabel="Signing out..."
        disabled={leaving === "lock"}
        onClick={() => {
          setLeaving("signout");
          void signOut();
        }}
      >
        Sign out
      </Button>
    </>
  );
}
