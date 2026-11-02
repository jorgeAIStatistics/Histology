import type { ReactNode } from "react";
import { buttonClasses } from "@/components/ui/button";

/**
 * Frame for the plain sign-in pages (/signin, /locked, /signed-out,
 * /no-access, /forbidden). They read NO laboratory data: no actor, no
 * counts, no patient, case or staff details. src/proxy.ts renders them
 * without the app chrome (x-hlos-bare), so the frame brings its own <main>.
 * (A private folder: "_auth" is not a route.)
 */
export function PlainPage({ title, children, actions }: { title: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <main id="main" tabIndex={-1} className="flex min-h-screen items-start justify-center bg-canvas px-4 py-16 focus:outline-none">
      <section aria-labelledby="plain-title" className="w-full max-w-lg rounded-lg border border-line bg-surface p-6">
        <p className="text-sm font-semibold text-ink-muted">Histology Lab OS</p>
        <h1 id="plain-title" className="mt-1 text-xl font-bold tracking-[-0.015em] text-ink">
          {title}
        </h1>
        <div className="mt-3 flex flex-col gap-3 text-sm text-ink-secondary">{children}</div>
        {actions ? <div className="mt-5 flex flex-wrap gap-2">{actions}</div> : null}
      </section>
    </main>
  );
}

/**
 * A plain link styled as a button. Deliberately an <a>, not next/link: the
 * sign-in endpoints are API routes and must be full navigations (never
 * prefetched or fetched as RSC).
 */
export function PlainLink({ href, children, primary }: { href: string; children: ReactNode; primary?: boolean }) {
  return (
    <a href={href} className={buttonClasses({ variant: primary ? "primary" : "secondary" })}>
      {children}
    </a>
  );
}

export type SP = Promise<Record<string, string | string[] | undefined>>;

export function firstParam(sp: Record<string, string | string[] | undefined>, key: string): string | undefined {
  const v = sp[key];
  return Array.isArray(v) ? v[0] : v;
}
