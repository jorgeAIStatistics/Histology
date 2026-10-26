"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Menu, X } from "lucide-react";
import { cn } from "@/components/ui/cn";
import { RoleSwitcher } from "./RoleSwitcher";
import { ResearchStatus } from "./ResearchStatus";
import { ProjectSwitcher } from "./ProjectSwitcher";

const NAV = [
  { href: "/", label: "Overview", match: (p: string) => p === "/" },
  { href: "/worklist", label: "Worklist", match: (p: string) => p.startsWith("/worklist") },
  { href: "/review", label: "Slide Review", match: (p: string) => p.startsWith("/review") },
  { href: "/dataset", label: "Dataset", match: (p: string) => p.startsWith("/dataset") },
  { href: "/experiments", label: "Experiments", match: (p: string) => p.startsWith("/experiments") },
  { href: "/impact", label: "Impact", match: (p: string) => p.startsWith("/impact") },
];

function Wordmark() {
  return (
    <Link href="/" className="flex shrink-0 items-center gap-2.5 rounded-[var(--radius-control)] pr-2" aria-label="DermPath Research Workbench, overview">
      <svg width="30" height="20" viewBox="0 0 30 20" aria-hidden>
        <rect x="0.75" y="0.75" width="28.5" height="18.5" rx="2.5" fill="#f2f5f5" stroke="#1e2327" strokeWidth="1.5" />
        <rect x="3" y="3" width="7" height="14" rx="1" fill="#0b6766" />
        <path d="M13.5 10c0-3 2.6-4.6 6-4.4 3 .2 4.2-.6 5.6.8 1.4 1.5.4 3.7-.6 4.5-1.6 1.4-3.4 2.9-6.4 2.7-3-.2-4.6-1.2-4.6-3.6z" fill="#c07895" />
        <circle cx="17" cy="9" r="0.95" fill="#463c78" />
        <circle cx="20.5" cy="11" r="0.95" fill="#463c78" />
        <circle cx="23" cy="8" r="0.95" fill="#463c78" />
      </svg>
      <span className="leading-none">
        <span className="block text-[15px] font-bold tracking-tight text-ink">DermPath</span>
        <span className="block text-micro text-graphite">Research Workbench</span>
      </span>
    </Link>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? "/";
  const [menuOpen, setMenuOpen] = useState(false);
  const mainRef = useRef<HTMLElement>(null);
  useEffect(() => setMenuOpen(false), [pathname]);
  const fullBleed = pathname.startsWith("/review/");

  return (
    <div className={cn("flex flex-col", fullBleed ? "h-dvh overflow-hidden" : "min-h-dvh")}>
      <a href="#main" className="sr-only-focusable fixed left-3 top-3 z-[70] rounded bg-ink px-3 py-2 text-white">
        Skip to content
      </a>
      <header className="sticky top-0 z-40 border-b border-line bg-surface/95 backdrop-blur supports-[backdrop-filter]:bg-surface/85">
        <div className="flex h-14 items-center gap-3 px-4 xl:gap-5 xl:px-6">
          <Wordmark />
          <nav aria-label="Main" className="hidden min-w-0 flex-1 md:block">
            <ul className="flex items-center gap-0.5">
              {NAV.map((n) => {
                const active = n.match(pathname);
                return (
                  <li key={n.href}>
                    <Link
                      href={n.href}
                      aria-current={active ? "page" : undefined}
                      className={cn(
                        "relative flex h-14 items-center whitespace-nowrap px-2 text-small font-semibold lg:px-2.5 xl:px-3 xl:text-body",
                        active ? "text-ink" : "text-graphite hover:text-ink",
                      )}
                    >
                      {n.label}
                      <span aria-hidden className={cn("absolute inset-x-2 bottom-0 h-[3px] rounded-t", active ? "bg-teal" : "bg-transparent")} />
                    </Link>
                  </li>
                );
              })}
            </ul>
          </nav>
          <div className="ml-auto flex shrink-0 items-center gap-2">
            <div className="hidden xl:block">
              <ResearchStatus />
            </div>
            <div className="hidden xl:block">
              <ProjectSwitcher compact />
            </div>
            <RoleSwitcher />
            <button
              type="button"
              className="inline-flex h-9 w-9 items-center justify-center rounded-[var(--radius-control)] border border-line-strong md:hidden"
              aria-expanded={menuOpen}
              aria-controls="mobile-nav"
              aria-label={menuOpen ? "Close navigation" : "Open navigation"}
              onClick={() => setMenuOpen((v) => !v)}
            >
              {menuOpen ? <X size={18} aria-hidden /> : <Menu size={18} aria-hidden />}
            </button>
          </div>
        </div>
        {menuOpen ? (
          <nav id="mobile-nav" aria-label="Main" className="border-t border-line px-4 py-2 md:hidden">
            <ul className="grid grid-cols-2 gap-1">
              {NAV.map((n) => (
                <li key={n.href}>
                  <Link href={n.href} aria-current={n.match(pathname) ? "page" : undefined} className="block rounded px-2 py-2 font-semibold text-ink hover:bg-paraffin">
                    {n.label}
                  </Link>
                </li>
              ))}
            </ul>
            <div className="mt-2 border-t border-line pt-2">
              <ProjectSwitcher />
            </div>
          </nav>
        ) : null}
        <div className="flex items-center justify-between gap-3 border-t border-line px-4 py-1.5 xl:hidden">
          <ResearchStatus />
          <ProjectSwitcher compact />
        </div>
      </header>
      <main id="main" ref={mainRef} tabIndex={-1} className={cn("flex-1 focus:outline-none", fullBleed ? "flex min-h-0 flex-col" : "")}>
        {children}
      </main>
    </div>
  );
}
