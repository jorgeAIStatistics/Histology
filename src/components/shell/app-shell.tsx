import type { ReactNode } from "react";
import { DemoBanner } from "./demo-banner";
import { ShellProviders } from "./providers";
import { loadShellData } from "./server-data";
import { SideNav } from "./side-nav";
import { SkipLinks } from "./skip-links";
import { TopBar } from "./top-bar";

/**
 * App shell (spec §5.1). Server component: loads the demo actor (cookie), the
 * demo clock, source freshness, staff for the role selector and nav counts,
 * then renders the chrome around the page. Interactive pieces are client
 * components that receive these as props.
 *
 * Layout: sticky header (28px demo banner + 52px top bar), sticky left nav,
 * <main id="main">. Pages render their own PageBody padding and, when a case
 * is open, an IdentityBar directly under the top bar.
 */
export async function AppShell({ children }: { children: ReactNode }) {
  const data = await loadShellData();
  return (
    <ShellProviders actor={data.actor} staff={data.staff} live={data.live}>
      <SkipLinks />
      <div className="flex min-h-screen flex-col">
        <header data-shell-chrome className="sticky top-0 z-30">
          <DemoBanner />
          <TopBar actor={data.actor} staff={data.staff} />
        </header>
        <div className="flex flex-1 items-start">
          <SideNav counts={data.counts} />
          <main id="main" tabIndex={-1} className="min-w-0 flex-1 focus:outline-none">
            {children}
          </main>
        </div>
      </div>
    </ShellProviders>
  );
}
