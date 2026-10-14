import Link from "next/link";

/**
 * Demo-mode banner (spec §5.1): always visible, cannot be dismissed.
 * brand-900 background, white text, small yellow "DEMO" tag. role="note".
 */
export function DemoBanner() {
  return (
    <div
      role="note"
      aria-label="Demo mode"
      className="flex h-[var(--hlo-banner-h)] items-center gap-2 overflow-hidden whitespace-nowrap bg-brand-900 px-4 text-xs text-white"
    >
      <span className="inline-flex h-4 items-center rounded-sm bg-pas-bg px-1 text-xs font-semibold leading-none text-pas-fg">DEMO</span>
      <span className="min-w-0 truncate">
        <span>Demo mode. Synthetic data only. No real patients.</span>
        <span className="max-lg:hidden"> Source system, notifications, printer and AI are simulated.</span>
        <span className="lg:hidden"> All connectors simulated.</span>
      </span>
      <Link
        href="/settings?tab=integration"
        className="shrink-0 rounded-sm font-medium text-white underline underline-offset-2 hover:text-brand-100 focus-visible:outline-white"
      >
        What is simulated?
      </Link>
    </div>
  );
}
