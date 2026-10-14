import { PageBody, Skeleton, SkeletonRows } from "@/components/ui";

/** First load of a case: skeleton in the case layout (spec 6.0 Loading). */
export default function CaseLoading() {
  return (
    <PageBody>
      <div aria-busy="true" aria-live="polite" className="flex flex-col gap-4">
        <span className="sr-only">Loading the case</span>
        <Skeleton className="h-6 w-56" />
        <Skeleton className="h-4 w-96 max-w-full" />
        <Skeleton className="h-10 w-full" />
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_24rem]">
          <Skeleton className="h-32 rounded-md" />
          <Skeleton className="h-32 rounded-md" />
        </div>
        <div className="rounded-md border border-line bg-surface">
          <SkeletonRows rows={6} columns={4} />
        </div>
      </div>
    </PageBody>
  );
}
