import { PageBody, Skeleton } from "@/components/ui";

/** First load of a case: skeleton in the case layout (band, then one row per part with its two rails). */
export default function CaseLoading() {
  return (
    <div aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading the case</span>
      <div className="flex flex-col gap-3 border-b border-line bg-surface px-6 pt-4 pb-3 max-xl:px-4">
        <Skeleton className="h-5 w-72 max-w-full" />
        <Skeleton className="h-8 w-[28rem] max-w-full" />
        <Skeleton className="h-4 w-96 max-w-full" />
        <Skeleton className="mt-2 h-9 w-[36rem] max-w-full" />
      </div>
      <PageBody>
        <div className="rounded-lg border border-line bg-surface">
          {[0, 1, 2].map((i) => (
            <div key={i} className="grid grid-cols-1 gap-x-6 gap-y-3 border-t border-line px-5 py-4 first:border-t-0 md:grid-cols-[13.5rem_minmax(0,1fr)] xl:grid-cols-[12.5rem_minmax(0,1fr)_18rem] max-xl:px-4">
              <Skeleton className="h-14 rounded-md" />
              <div className="flex flex-col gap-2 max-xl:md:col-span-2 max-xl:md:row-start-2">
                <Skeleton className="h-11" />
                <Skeleton className="h-11 w-2/3" />
              </div>
              <Skeleton className="h-16 rounded-md" />
            </div>
          ))}
        </div>
      </PageBody>
    </div>
  );
}
