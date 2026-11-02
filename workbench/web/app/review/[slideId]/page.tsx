import type { Metadata } from "next";
import { Suspense } from "react";
import { SessionGate } from "@/components/shell/SessionGate";
import { ReviewWorkspace } from "@/components/review/ReviewWorkspace";
import { Loading } from "@/components/ui/Notice";

export const metadata: Metadata = { title: "Slide Review" };

export default async function SlideReviewPage({ params }: { params: Promise<{ slideId: string }> }) {
  const { slideId } = await params;
  return (
    <SessionGate permission="hierarchy.read" what="review slides">
      <Suspense fallback={<Loading className="px-6" label="Opening the slide" />}>
        <ReviewWorkspace slideId={slideId} />
      </Suspense>
    </SessionGate>
  );
}
