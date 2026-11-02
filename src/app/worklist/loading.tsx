import { Skeleton } from "@/components/ui/skeleton";

const BANDS = [7, 5, 4];

/** First load of the worklist: the same header line, one-line toolbar, change line and doctor bands, as quiet placeholders. */
export default function WorklistLoading() {
  return (
    <div aria-busy="true" aria-live="polite" className="flex flex-col gap-2.5 px-6 pb-3 pt-3 max-xl:px-4">
      <span className="sr-only">Loading the worklist</span>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <Skeleton className="h-7 w-28" />
        <Skeleton className="h-9 w-96 max-w-full" />
        <Skeleton className="h-9 w-28" />
        <Skeleton className="ml-auto h-9 w-80 max-w-full" />
      </div>
      <div className="rounded-lg border border-line bg-surface shadow-1">
        <div className="flex flex-wrap items-center gap-3 px-3 py-2">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-8 w-40" />
          <Skeleton className="h-8 w-96 max-w-full" />
        </div>
        <div className="flex items-center gap-5 border-t border-line bg-surface-subtle px-3 py-1.5">
          <Skeleton className="h-8 w-56" />
          <Skeleton className="h-5 w-[24rem] max-w-full" />
          <Skeleton className="ml-auto h-8 w-52" />
        </div>
        <div className="h-8 border-t border-line bg-surface-subtle" />
        {BANDS.map((rows, i) => (
          <div key={i}>
            <div className="flex h-12 items-center gap-3 border-b border-line-strong bg-surface-subtle px-3 pt-1 shadow-[inset_0_4px_0_var(--hlo-border)]">
              <Skeleton className="size-4" />
              <Skeleton className="h-5 w-56" />
              <Skeleton className="h-5 w-40" />
            </div>
            {Array.from({ length: rows }, (_, r) => (
              <div key={r} className="flex h-9 items-center gap-6 border-b border-line px-3 last:border-b-0">
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-4 w-64 max-w-full" />
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
