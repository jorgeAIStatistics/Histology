import type { ReactNode } from "react";
import { headers } from "next/headers";
import { ShellProviders } from "./providers";
import { loadShellData } from "./server-data";
import { SkipLinks } from "./skip-links";
import { TopBar } from "./top-bar";
import { SessionGate, type SecuredShellSession } from "@/components/auth/session-gate";
import { authConfig } from "@/server/auth/config";
import { getDb } from "@/server/db/db";

/**
 * App shell. Server component: loads the actor through the one guard (demo
 * role cookie, or the signed-in session), the demo clock, source freshness,
 * staff for the role selector and rail counts, then renders the chrome around
 * the page.
 *
 * Layout: one sticky hematoxylin top bar (job navigation, scan field, source
 * freshness, Synthetic demo, the read-only demo role and time, and the link to
 * the presenter console), then <main id="main"> at full
 * width. Pages render their own working layout; bench screens pin the current
 * case/part identity directly under the top bar.
 *
 * Secured mode (signed in): the whole chrome sits inside <SessionGate>, which
 * fixes the page's actor (X-HLOS-Actor on every command), runs the idle lock
 * and replaces everything (top bar included) with the lock screen while the
 * session is locked. The top bar shows the person's name and role, "Lock" and
 * "Sign out" instead of the demo controls. Plain sign-in pages (/signin,
 * /locked, ...) render bare and, with no actor, poll nothing.
 */
export async function AppShell({ children }: { children: ReactNode }) {
  const data = await loadShellData();
  const bare = (await headers()).get("x-hlos-bare") === "1";
  // Design previews (/concepts/*, demo only) and the plain sign-in pages (see src/proxy.ts) draw their own composition.
  if (bare) {
    // Polling keeps lab data fresh; a secured plain page shows none (and a locked build has no actor at all).
    const liveEnabled = data.signedIn && data.mode !== "secured";
    return (
      <ShellProviders actor={data.actor} staff={data.staff} live={data.live} liveEnabled={liveEnabled}>
        {children}
      </ShellProviders>
    );
  }
  const session = data.mode === "secured" && data.signedIn ? securedSession(data.actor) : null;
  return (
    <SessionGate session={session}>
      <ShellProviders actor={data.actor} staff={data.staff} live={data.live} liveEnabled={data.signedIn}>
        <SkipLinks />
        <div className="flex min-h-screen min-w-0 flex-col">
          <header data-shell-chrome className="sticky top-0 z-30">
            <TopBar actor={data.actor} counts={data.counts} mode={data.mode} session={session ? { synthetic: session.synthetic } : null} />
          </header>
          <main id="main" tabIndex={-1} className="min-w-0 flex-1 focus:outline-none">
            {children}
          </main>
        </div>
      </ShellProviders>
    </SessionGate>
  );
}

/** The signed-in secured page's session settings for the client (no secret, no session id). */
function securedSession(actor: SecuredShellSession["actor"]): SecuredShellSession {
  const cfg = authConfig();
  return { actor, idleMinutes: cfg.ok ? cfg.config.idleMinutes : 15, synthetic: syntheticSeedLoaded() };
}

/** Whether the synthetic seed is in this database (a secured TEST environment started with HLOS_SEED_SYNTHETIC=1). */
function syntheticSeedLoaded(): boolean {
  try {
    return getDb().prepare("SELECT 1 AS one FROM app_setting WHERE key = 'seeded_at'").get() !== undefined;
  } catch {
    return false;
  }
}
