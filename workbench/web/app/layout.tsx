import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import localFont from "next/font/local";
import "./globals.css";
import { SessionProvider } from "@/lib/session";
import { Toaster } from "@/components/ui/Toaster";
import { AppShell } from "@/components/shell/AppShell";

// Self-hosted (SIL OFL 1.1): no font is fetched from the network at build or run time.
const atkinson = localFont({
  src: "./fonts/AtkinsonHyperlegibleNext-Latin-wght200-800.woff2",
  weight: "200 800",
  variable: "--font-atkinson",
  display: "swap",
});
const atkinsonMono = localFont({
  src: "./fonts/AtkinsonHyperlegibleMono-Latin-wght200-800.woff2",
  weight: "200 800",
  variable: "--font-atkinson-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: { default: "DermPath Research Workbench", template: "%s · DermPath Research Workbench" },
  description: "Research-use-only prototype: slide intake, quality review, expert labels, frozen datasets and honest evaluation. Fictional and public CC0 data only.",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#f8f7f3",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en-US" className={`${atkinson.variable} ${atkinsonMono.variable}`}>
      <body>
        <Toaster>
          <SessionProvider>
            <AppShell>{children}</AppShell>
          </SessionProvider>
        </Toaster>
      </body>
    </html>
  );
}
