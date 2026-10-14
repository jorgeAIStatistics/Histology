import { cn } from "@/lib/cn";

/** Placeholder block for first loads (no spinners over whole pages). Decorative. */
export function Skeleton({ className }: { className?: string }) {
  return <span aria-hidden className={cn("block rounded-sm bg-surface-sunken motion-safe:animate-pulse", className)} />;
}

/**
 * Skeleton rows with the same row height as the real table (spec §6.0
 * Loading). Put `aria-busy="true"` on the table or region while loading.
 */
export function SkeletonRows({ rows = 6, columns = 5, className }: { rows?: number; columns?: number; className?: string }) {
  return (
    <div aria-hidden className={cn("divide-y divide-line", className)}>
      {Array.from({ length: rows }, (_, r) => (
        <div key={r} className="flex h-[var(--hlo-row-h)] items-center gap-4 px-3">
          {Array.from({ length: columns }, (_, c) => (
            <Skeleton key={c} className={cn("h-3", c === 0 ? "w-28" : c === columns - 1 ? "w-16" : "flex-1")} />
          ))}
        </div>
      ))}
    </div>
  );
}
