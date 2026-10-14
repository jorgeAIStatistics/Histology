import { PageBody, Skeleton, SkeletonRows } from "@/components/ui";

/** First load of the worklist: same layout, skeleton rows (spec 6.0 Loading). */
export default function WorklistLoading() {
  return (
    <PageBody>
      <div aria-busy="true" aria-live="polite" className="flex flex-col gap-4">
        <span className="sr-only">Loading the worklist</span>
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-4 w-96 max-w-full" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
        <div className="rounded-md border border-line bg-surface">
          <SkeletonRows rows={10} columns={6} />
        </div>
      </div>
    </PageBody>
  );
}
