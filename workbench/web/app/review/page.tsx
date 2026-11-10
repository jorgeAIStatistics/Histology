import type { Metadata } from "next";
import { SessionGate } from "@/components/shell/SessionGate";
import { ReviewLanding } from "@/components/review/ReviewLanding";

export const metadata: Metadata = { title: "Slide Review" };

export default function ReviewIndexPage() {
  return (
    <SessionGate permission="hierarchy.read" what="review slides">
      <ReviewLanding />
    </SessionGate>
  );
}
