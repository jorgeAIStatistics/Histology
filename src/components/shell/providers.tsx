"use client";

import type { ReactNode } from "react";
import { ConflictProvider } from "@/lib/client/conflict";
import { GlobalShortcuts } from "@/lib/client/keyboard";
import { LiveRefresh } from "@/lib/client/live";
import { DensitySync } from "@/lib/client/preferences";
import { ScanProvider } from "@/lib/client/scan";
import { ShellContextProvider } from "@/lib/client/shell-context";
import type { LivePayload, ShellActor, ShellStaff } from "@/lib/client/types";
import { ToastProvider } from "@/components/ui/toast";
import { TooltipProvider } from "@/components/ui/tooltip";

/** All client-side providers, mounted once by the AppShell. */
export function ShellProviders({
  actor,
  staff,
  live,
  children,
}: {
  actor: ShellActor;
  staff: ShellStaff[];
  live: LivePayload;
  children: ReactNode;
}) {
  return (
    <ShellContextProvider actor={actor} staff={staff}>
      <LiveRefresh initial={live}>
        <TooltipProvider>
          <ToastProvider>
            <ConflictProvider>
              <ScanProvider>
                <DensitySync />
                <GlobalShortcuts />
                {children}
              </ScanProvider>
            </ConflictProvider>
          </ToastProvider>
        </TooltipProvider>
      </LiveRefresh>
    </ShellContextProvider>
  );
}
