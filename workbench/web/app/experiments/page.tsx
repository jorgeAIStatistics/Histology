import type { Metadata } from "next";
import { SessionGate } from "@/components/shell/SessionGate";
import { ExperimentsView } from "@/components/experiments/ExperimentsView";

export const metadata: Metadata = { title: "Experiments" };

export default function ExperimentsPage() {
  return (
    <SessionGate permission="experiment.read" what="open experiments" deniedMessage="Experiments are available to the research lead, pathologists and the medical director.">
      <ExperimentsView />
    </SessionGate>
  );
}
