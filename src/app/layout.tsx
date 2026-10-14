import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import { plexMono, plexSans } from "./fonts";
import { AppShell } from "@/components/shell/app-shell";
import { DENSITY_BOOT_SCRIPT } from "@/lib/client/pref-keys";

export const metadata: Metadata = {
  title: { default: "Histology Lab OS", template: "%s · Histology Lab OS" },
  description:
    "Histology Redesigned. Local demonstration of an operational coordination companion for a fictional dermatopathology laboratory. Synthetic data only; all connectors simulated.",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  colorScheme: "light",
};

// Every screen reads the demo database and the role cookie: never prerender.
export const dynamic = "force-dynamic";

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en-US" className={`${plexSans.variable} ${plexMono.variable}`} suppressHydrationWarning>
      <head>
        {/* Applies the density preference before first paint (no flash). */}
        <script dangerouslySetInnerHTML={{ __html: DENSITY_BOOT_SCRIPT }} />
      </head>
      <body className="min-h-screen bg-canvas text-ink antialiased">
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
