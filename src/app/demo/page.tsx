import { redirect } from "next/navigation";
import { getDb } from "@/server/db/db";
import { getSetting } from "@/server/core/settings";
import { getActor } from "@/server/session";
import { getOperations } from "@/server/queries/operations";
import { worldEventTargets, type WorldEventTargets } from "@/server/queries/presenter";
import { loadDemoSettings, type DemoSettings } from "@/server/queries/settings";
import { DEMO_STEP_CLOCK, REHEARSAL_ROLES, canRunRehearsal, demoStatus, type DemoStatus, type DemoStepNumber } from "@/server/domain/demoSteps";
import { labLocalToIso } from "@/lib/time";
import { ROLE_LABEL } from "@/lib/roles";
import { Settings } from "lucide-react";
import { AlertBanner } from "@/components/ui/alert-banner";
import { ButtonLink } from "@/components/ui/button";
import { Tabs } from "@/components/ui/tabs";
import { PageBody } from "@/components/ui/page-header";
import { loadStaff } from "@/components/shell/server-data";
import { GuidedDemo, type OpsBlockerView } from "@/components/demo/guided-demo";
import { DemoToolbar, PresenterSizeProvider } from "@/components/demo/demo-toolbar";
import { WorkflowMap } from "@/components/demo/workflow-map";
import { SpeakerNotes } from "@/components/demo/speaker-notes";
import { RealVsSimulated } from "@/components/demo/real-vs-simulated";
import { PresenterTag } from "@/components/demo/presenter-tag";
import { RoleClockTab } from "@/components/demo/role-clock-tab";
import { WorldEventsTab } from "@/components/demo/world-events-tab";
import { OutagesTab, ResetCard } from "@/components/demo/outages-tab";
import { COPY_GUARD, STEPS } from "@/components/demo/content";
import { requirePresenterSurface } from "./gate";

export const dynamic = "force-dynamic";
export const metadata = { title: "Presenter console" };

/**
 * The presenter console (/demo): the ONE surface for running the synthetic
 * demonstration. The guided demo keeps its URLs (/demo?tab=guide&step=N); the
 * demo role switch, the demo clock, simulated world events, outages and reset
 * live here and on no bench screen. Outside synthetic demo mode every tab is a 404.
 */
const TABS = [
  { key: "guide", label: "Guide" },
  { key: "role", label: "Role and clock" },
  { key: "world", label: "World events" },
  { key: "outages", label: "Outages and reset" },
  { key: "map", label: "Workflow map" },
  { key: "notes", label: "Speaker notes" },
  { key: "real", label: "Real vs simulated" },
] as const;
type TabKey = (typeof TABS)[number]["key"];

type SP = Promise<{ tab?: string; step?: string }>;

// ------------------------------------------------------------------ presenter tabs (each gated on its own)

async function RoleClockPanel() {
  requirePresenterSurface();
  const actor = await getActor();
  return <RoleClockTab actor={{ id: actor.id, name: actor.name, role: actor.role }} staff={loadStaff(getDb())} />;
}

function WorldEventsPanel() {
  requirePresenterSurface();
  let targets: WorldEventTargets;
  try {
    targets = worldEventTargets(getDb());
  } catch (e) {
    console.error("[demo] world event targets failed", e);
    return (
      <AlertBanner tone="warning" title="Could not list the synthetic records for world events">
        The local demo database could not be read. Nothing was changed. Reload the page; if it keeps failing, reset the demo data on Outages and reset.
      </AlertBanner>
    );
  }
  return <WorldEventsTab targets={targets} />;
}

function OutagesPanel() {
  requirePresenterSurface();
  let data: DemoSettings;
  try {
    data = loadDemoSettings(getDb());
  } catch (e) {
    console.error("[demo] outages failed to load", e);
    // A database created before newer tables were added cannot be read by this version: the reset still works.
    const outdated = e instanceof Error && /no such table|no such column/i.test(e.message);
    return (
      <div className="grid grid-cols-1 gap-4">
        <AlertBanner tone="warning" title={outdated ? "The local demo database is from an older version" : "Could not load the simulated connectors"}>
          {outdated
            ? "It is missing tables this version needs, so the connectors cannot be shown. Nothing was changed. Reset the demo data to rebuild it with the synthetic starting state."
            : "The local demo database could not be read. Nothing was changed. Reload the page to try again; if it keeps failing, reset the demo data."}
        </AlertBanner>
        <div className="max-w-xl">
          <ResetCard />
        </div>
      </div>
    );
  }
  return <OutagesTab data={data} />;
}

// ------------------------------------------------------------------ page

export default async function PresenterConsolePage({ searchParams }: { searchParams: SP }) {
  requirePresenterSurface();
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
    : `Rehearsal acts as other named staff, so it needs the ${REHEARSAL_ROLES.map((r) => ROLE_LABEL[r]).join(" or ")} demo role (you are ${/\(demo\)$/.test(actor.name) ? actor.name : `${actor.name}, ${ROLE_LABEL[actor.role]}`}). Switch the demo role on Role and clock, or do the staff actions on the real screens.`;

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
      <header className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-bold tracking-[-0.015em] text-ink">Presenter console</h1>
            <PresenterTag />
          </div>
          <p className="mt-1 max-w-[90ch] text-sm text-ink-muted">
            For running the demonstration, not for bench work: the guide, the demo role and clock, simulated world events, outages and reset.{" "}
            <span>Synthetic data, simulated connectors.</span> A real laboratory has none of these controls, so no bench screen carries them.
          </p>
        </div>
        {/* Settings (routing rules, connectors, contacts, preferences) is a lab screen; the presenter reaches it from here. */}
        <ButtonLink href="/settings" variant="quiet" size="sm" icon={<Settings />}>
          Settings
        </ButtonLink>
      </header>
      <PresenterSizeProvider>
        {status ? <DemoToolbar doneCount={status.doneCount} total={STEPS.length} /> : null}
        <Tabs
          label="Presenter console sections"
          active={tab}
          items={TABS.map((t) => ({ key: t.key, label: t.label, href: t.key === "guide" && tab === "guide" ? `/demo?tab=guide&step=${selected}` : `/demo?tab=${t.key}` }))}
        />
        {loadError ? (
          <AlertBanner tone="warning" title="Could not load the demo progress">
            {loadError} Nothing was changed. Reload the page; if it keeps failing, reset the demo data on Outages and reset.
          </AlertBanner>
        ) : null}
        {tab === "guide" ? (
          <p className="-mb-2 max-w-[90ch] text-sm text-ink-muted">
            A five-minute walk through one multipart case (Avery Quinlan, synthetic) on the real screens. Steps 6 and 7 use earlier synthetic cases.
          </p>
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
        {tab === "role" ? <RoleClockPanel /> : null}
        {tab === "world" ? <WorldEventsPanel /> : null}
        {tab === "outages" ? <OutagesPanel /> : null}
        {tab === "map" ? <WorkflowMap /> : null}
        {tab === "notes" ? <SpeakerNotes /> : null}
        {tab === "real" ? <RealVsSimulated /> : null}
        {tab === "map" ? <p className="text-sm text-ink-muted">{COPY_GUARD}</p> : null}
      </PresenterSizeProvider>
    </PageBody>
  );
}
