import { cache } from "react";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { cn } from "@/lib/cn";
import { getDb } from "@/server/db/db";
import { currentViewer } from "@/server/auth/guard";
import { loadIntegrationCounts } from "@/components/integration/data";

/** Once per request: Operations renders the link twice (the Integration category and the source-freshness sheet). */
const countsForRequest = cache(() => loadIntegrationCounts(getDb()));

/**
 * The link from Operations to /integration, with its counts (needs review, waiting on the source, failed).
 * Rendered only for a viewer who may open that screen (view.integration); nothing otherwise. Server component.
 */
export async function IntegrationLink({ className }: { className?: string }) {
  const viewer = await currentViewer({ touch: false, view: "view.integration" });
  if (!viewer.ok) return null;
  let counts: ReturnType<typeof loadIntegrationCounts>;
  try {
    counts = countsForRequest();
  } catch {
    return null;
  }
  const parts = [`${counts.review} ${counts.review === 1 ? "needs" : "need"} review`, `${counts.waiting} waiting on the source`, `${counts.failed} failed`];
  return (
    <p className={cn("text-sm text-ink-secondary", className)}>
      <Link
        href="/integration"
        className="inline-flex min-h-[var(--hlo-target-min)] items-center gap-1 font-medium text-brand underline decoration-brand/40 underline-offset-2 hover:decoration-brand"
      >
        Integration: {parts.join(", ")}
        <ArrowRight className="size-3.5 shrink-0" aria-hidden />
      </Link>
    </p>
  );
}
