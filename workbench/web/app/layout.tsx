import type { ReactNode } from "react";
import "./globals.css";

export const metadata = { title: "DermPath Research Workbench (research use only)" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en-US">
      <body>{children}</body>
    </html>
  );
}
