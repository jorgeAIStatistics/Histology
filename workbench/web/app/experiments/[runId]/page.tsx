import type { Metadata } from "next";
import { SessionGate } from "@/components/shell/SessionGate";
import { RunDetail } from "@/components/experiments/RunDetail";

export const metadata: Metadata = { title: "Experiment" };

export default async function RunPage({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  return (
    <SessionGate permission="experiment.read" what="open experiments" deniedMessage="Experiments are available to the research lead, pathologists and the medical director.">
      <RunDetail runId={runId} />
    </SessionGate>
  );
}
