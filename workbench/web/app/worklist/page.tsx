import type { Metadata } from "next";
import { SessionGate } from "@/components/shell/SessionGate";
import { WorklistView } from "@/components/worklist/WorklistView";

export const metadata: Metadata = { title: "Worklist" };

export default function WorklistPage() {
  return (
    <SessionGate permission="hierarchy.read" what="open the worklist">
      <WorklistView />
    </SessionGate>
  );
}
