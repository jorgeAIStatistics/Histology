import { PageBody } from "@/components/ui/page-header";
import { Skeleton, SkeletonRows } from "@/components/ui/skeleton";

/** First load of the integration view: the summary, the source sheets and the first group as skeletons in their final places. */
export default function IntegrationLoading() {
  return (
    <PageBody>
      <div aria-busy="true" aria-live="polite" className="flex flex-col gap-5">
        <span className="sr-only">Loading the integration view</span>
        <div className="flex flex-col gap-2">
          <Skeleton className="h-7 w-40" />
          <Skeleton className="h-4 w-[32rem] max-w-full" />
        </div>
        <div className="rounded-lg border border-line bg-surface px-5 py-4">
          <Skeleton className="h-6 w-[30rem] max-w-full" />
        </div>
        <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
          {Array.from({ length: 2 }, (_, i) => (
            <div key={i} className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-4">
              <Skeleton className="h-5 w-48" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-2/3" />
            </div>
          ))}
        </div>
        <div className="rounded-lg border border-line bg-surface">
          <div className="px-4 py-3">
            <Skeleton className="h-5 w-36" />
          </div>
          <SkeletonRows rows={4} columns={3} />
        </div>
      </div>
    </PageBody>
  );
}
