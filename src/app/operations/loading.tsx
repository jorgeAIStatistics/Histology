import { PageBody } from "@/components/ui/page-header";
import { Skeleton, SkeletonRows } from "@/components/ui/skeleton";

/** First load of operations: the bench path, the "Blocked now" sheet and the owner column as skeletons in their final places. */
export default function OperationsLoading() {
  return (
    <PageBody>
      <div aria-busy="true" aria-live="polite" className="flex flex-col gap-5">
        <span className="sr-only">Loading the operations view</span>
        <div className="flex flex-col gap-2">
          <Skeleton className="h-7 w-40" />
          <Skeleton className="h-4 w-[32rem] max-w-full" />
        </div>
        <div className="rounded-lg border border-line bg-surface px-5 py-3">
          <Skeleton className="h-5 w-28" />
          <div className="mt-3 grid grid-cols-5 gap-x-1 gap-y-3 xl:grid-cols-10">
            {Array.from({ length: 10 }, (_, i) => (
              <div key={i} className="flex flex-col gap-1.5 border-t-2 border-line pt-2">
                <Skeleton className="h-3.5 w-3/4" />
                <Skeleton className="h-5 w-8" />
                <Skeleton className="h-3 w-2/3" />
              </div>
            ))}
          </div>
        </div>
        <div className="grid grid-cols-1 items-start gap-5 xl:grid-cols-[minmax(0,1fr)_21rem] min-[93.75rem]:grid-cols-[minmax(0,1fr)_23rem]">
          <div className="rounded-lg border border-line bg-surface">
            <div className="flex flex-col gap-2 px-5 py-4">
              <Skeleton className="h-5 w-32" />
              <Skeleton className="h-6 w-[36rem] max-w-full" />
            </div>
            <SkeletonRows rows={7} columns={5} />
          </div>
          <div className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-4">
            <Skeleton className="h-5 w-36" />
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-5 w-full" />
            ))}
          </div>
        </div>
      </div>
    </PageBody>
  );
}
