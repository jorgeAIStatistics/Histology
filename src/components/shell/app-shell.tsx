import type { ReactNode } from "react";
import { headers } from "next/headers";
import { ShellProviders } from "./providers";
import { loadShellData } from "./server-data";
import { SkipLinks } from "./skip-links";
import { TopBar } from "./top-bar";

/**
 * App shell. Server component: loads the demo actor (cookie), the demo clock,
 * source freshness, staff for the role selector and rail counts, then renders
 * the chrome around the page.
 *
 * Layout: one sticky hematoxylin top bar (job navigation, scan field, source
 * freshness, Synthetic demo, presenter menu), then <main id="main"> at full
 * width. Pages render their own working layout; bench screens pin the current
 * case/part identity directly under the top bar.
 */
export async function AppShell({ children }: { children: ReactNode }) {
  const data = await loadShellData();
  // Design previews (/concepts/*, see src/proxy.ts) draw their own composition.
  if ((await headers()).get("x-hlos-bare") === "1") {
    return (
      <ShellProviders actor={data.actor} staff={data.staff} live={data.live}>
        {children}
      </ShellProviders>
    );
  }
  return (
    <ShellProviders actor={data.actor} staff={data.staff} live={data.live}>
      <SkipLinks />
      <div className="flex min-h-screen min-w-0 flex-col">
        <header data-shell-chrome className="sticky top-0 z-30">
          <TopBar actor={data.actor} staff={data.staff} counts={data.counts} />
        </header>
        <main id="main" tabIndex={-1} className="min-w-0 flex-1 focus:outline-none">
          {children}
        </main>
      </div>
    </ShellProviders>
  );
}
