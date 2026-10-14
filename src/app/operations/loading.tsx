import { PageBody, Skeleton, SkeletonRows } from "@/components/ui";

/** First load of operations: tiles and the blocked-work table as skeletons (spec 6.0 Loading). */
export default function OperationsLoading() {
  return (
    <PageBody>
      <div aria-busy="true" aria-live="polite" className="flex flex-col gap-4">
        <span className="sr-only">Loading the operations view</span>
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-4 w-96 max-w-full" />
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {Array.from({ length: 10 }, (_, i) => (
            <Skeleton key={i} className="h-24 rounded-md" />
          ))}
        </div>
        <div className="rounded-md border border-line bg-surface">
          <SkeletonRows rows={8} columns={6} />
        </div>
      </div>
    </PageBody>
  );
}
