import { redirect } from "next/navigation";
import { getDb } from "@/server/db/db";
import { getSetting } from "@/server/core/settings";
import { getActor } from "@/server/session";
import { getOperations } from "@/server/queries/operations";
import { DEMO_STEP_CLOCK, REHEARSAL_ROLES, canRunRehearsal, demoStatus, type DemoStatus, type DemoStepNumber } from "@/server/domain/demoSteps";
import { labLocalToIso } from "@/lib/time";
import { ROLE_LABEL } from "@/lib/roles";
import { AlertBanner } from "@/components/ui/alert-banner";
import { Tabs } from "@/components/ui/tabs";
import { PageBody, PageHeader } from "@/components/ui/page-header";
import { SimulatedLabel } from "@/components/domain/honesty";
import { GuidedDemo, type OpsBlockerView } from "@/components/demo/guided-demo";
import { DemoToolbar, PresenterSizeProvider } from "@/components/demo/demo-toolbar";
import { WorkflowMap } from "@/components/demo/workflow-map";
import { SpeakerNotes } from "@/components/demo/speaker-notes";
import { RealVsSimulated } from "@/components/demo/real-vs-simulated";
import { COPY_GUARD, STEPS } from "@/components/demo/content";

export const dynamic = "force-dynamic";
export const metadata = { title: "Guided demo" };

const TABS = [
  { key: "guide", label: "Guided demo" },
  { key: "map", label: "Workflow map" },
  { key: "notes", label: "Speaker notes" },
  { key: "real", label: "Real vs simulated" },
] as const;
type TabKey = (typeof TABS)[number]["key"];

type SP = Promise<{ tab?: string; step?: string }>;

export default async function DemoPage({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const tab: TabKey = (TABS.find((t) => t.key === sp.tab)?.key ?? "guide") as TabKey;

  const db = getDb();
  let status: DemoStatus | null = null;
  let loadError: string | null = null;
  try {
    status = demoStatus(db);
  } catch (e) {
    console.error("[demo] status failed", e);
    loadError = "The demo progress could not be read from the local database.";
  }

  // The selected step always lives in the URL. Without it, the guide would follow "first step not
  // done" and jump ahead (hiding the action log) as soon as a run completes that step.
  const requested = Number(sp.step);
  const validStep = Number.isInteger(requested) && requested >= 1 && requested <= STEPS.length;
  if (tab === "guide" && !validStep) {
    const firstOpen = status?.steps.find((s) => s.state !== "done")?.step ?? 1;
    redirect(`/demo?tab=guide&step=${firstOpen}`);
  }
  const selected = validStep ? requested : 1;

  const actor = await getActor();
  const canRehearse = canRunRehearsal(actor.role);
  const rehearsalNote = canRehearse
    ? null
    : `Rehearsal acts as other named staff, so it needs the ${REHEARSAL_ROLES.map((r) => ROLE_LABEL[r]).join(" or ")} demo role (you are ${/\(demo\)$/.test(actor.name) ? actor.name : `${actor.name}, ${ROLE_LABEL[actor.role]}`}). Switch role in the top bar, or do the staff actions on the real screens.`;

  const demoDay = getSetting(db, "demo_day") ?? "2026-10-14";
  // Changes on every reset (the database is reseeded), so the guide's local state starts fresh.
  const seededAt = getSetting(db, "seeded_at") ?? "unknown";
  const stepClockIso = Object.fromEntries(
    (Object.keys(DEMO_STEP_CLOCK) as unknown as DemoStepNumber[]).map((k) => [Number(k), labLocalToIso(demoDay, DEMO_STEP_CLOCK[k])]),
  ) as Record<number, string>;

  // Step 8 summarizes the real Operations read model (S3) rather than a second copy of it.
  let blockers: OpsBlockerView[] | null = null;
  if (tab === "guide" && selected === 8) {
    try {
      blockers = getOperations(db).blocked.map((b) => ({ key: b.key, item: b.item, href: b.itemHref, blocks: b.blocks, owner: b.owner, age: b.age }));
    } catch (e) {
      console.error("[demo] operations summary failed", e);
      blockers = null;
    }
  }

  return (
    <PageBody>
      <PageHeader
        title="Guided demo"
        description="A five-minute walk through one multipart case (Avery Quinlan, synthetic) on the real screens. Steps 6 and 7 use earlier synthetic cases."
        actions={<SimulatedLabel>Synthetic data, simulated connectors</SimulatedLabel>}
      />
      <PresenterSizeProvider>
        {status ? <DemoToolbar doneCount={status.doneCount} total={STEPS.length} /> : null}
        <Tabs
          label="Demo sections"
          active={tab}
          items={TABS.map((t) => ({ key: t.key, label: t.label, href: t.key === "guide" && tab === "guide" ? `/demo?tab=guide&step=${selected}` : `/demo?tab=${t.key}` }))}
        />
        {loadError ? (
          <AlertBanner tone="danger" title="Could not load the demo progress" blocking>
            {loadError} Nothing was changed. Reload the page; if it keeps failing, reset the demo data.
          </AlertBanner>
        ) : null}
        {tab === "guide" && status ? (
          <GuidedDemo
            key={seededAt}
            steps={status.steps}
            selected={selected}
            ids={status.ids}
            stepClockIso={stepClockIso}
            clockNow={status.clockNow}
            lastResults={status.lastResults}
            canRehearse={canRehearse}
            rehearsalNote={rehearsalNote}
            blockers={blockers}
          />
        ) : null}
        {tab === "map" ? <WorkflowMap /> : null}
        {tab === "notes" ? <SpeakerNotes /> : null}
        {tab === "real" ? <RealVsSimulated /> : null}
        {tab === "map" ? <p className="text-xs text-ink-muted">{COPY_GUARD}</p> : null}
      </PresenterSizeProvider>
    </PageBody>
  );
}
