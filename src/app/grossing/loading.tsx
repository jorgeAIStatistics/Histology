import { Skeleton, SkeletonRows } from "@/components/ui/skeleton";

/** First load of the grossing queue or a part: the band and table shapes, no spinner over the page. */
export default function GrossingLoading() {
  return (
    <div aria-busy="true" aria-label="Loading grossing" className="flex flex-col">
      <div className="border-b border-line bg-surface px-6 pt-4 pb-3 max-xl:px-4">
        <Skeleton className="h-7 w-40" />
        <Skeleton className="mt-3 h-5 w-[min(36rem,80%)]" />
        <Skeleton className="mt-2 h-4 w-[min(28rem,60%)]" />
      </div>
      <div className="px-6 py-5 max-xl:px-4">
        <div className="rounded-md border border-line bg-surface">
          <SkeletonRows rows={8} columns={6} />
        </div>
      </div>
      <span className="sr-only" role="status">
        Loading grossing
      </span>
    </div>
  );
}
