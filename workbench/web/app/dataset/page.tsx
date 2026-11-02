import type { Metadata } from "next";
import { Suspense } from "react";
import { SessionGate } from "@/components/shell/SessionGate";
import { DatasetView } from "@/components/dataset/DatasetView";
import { Loading } from "@/components/ui/Notice";

export const metadata: Metadata = { title: "Dataset" };

export default function DatasetPage() {
  return (
    <SessionGate permission="dataset.read" what="open datasets">
      <Suspense fallback={<Loading className="px-6" />}>
        <DatasetView />
      </Suspense>
    </SessionGate>
  );
}
