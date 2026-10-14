import { FreshnessWatcher } from "@/components/worklist/freshness-watcher";
import { getDb } from "@/server/db/db";
import { getActor } from "@/server/session";
import { getCase, safeDecode } from "@/server/queries/case";
import { ButtonLink, EmptyState, PageBody, PageHeader, Tabs } from "@/components/ui";
import { IdentityBar, ReadOnlyTag, StaleBanner } from "@/components/domain";
import { CaseOverview } from "@/components/case/case-overview";
import { CaseMaterial } from "@/components/case/case-material";
import { CaseSources } from "@/components/case/case-sources";
import { CaseTasks } from "@/components/case/case-tasks";
import { CaseHistory } from "@/components/case/case-history";
import { shortScope } from "@/components/worklist/cells";

export const dynamic = "force-dynamic";

/** "2026-10-14" → "Wed Oct 14" (the lab day, no time zone shift). */
function fmtDay(day: string): string {
  const d = new Date(`${day}T12:00:00Z`);
  return Number.isNaN(d.getTime()) ? day : new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" }).format(d);
}

const TABS = ["overview", "material", "source", "tasks", "history"] as const;
type CaseTab = (typeof TABS)[number];
const TAB_LABEL: Record<CaseTab, string> = {
  overview: "Overview",
  material: "Material",
  source: "Source documents",
  tasks: "Tasks and clarifications",
  history: "History",
};

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return { title: `Case ${safeDecode(id).slice(0, 40)}` };
}

export default async function CasePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const one = (k: string) => (Array.isArray(sp[k]) ? (sp[k] as string[])[0] : (sp[k] as string | undefined));
  const rawTab = one("tab");
  const tab: CaseTab = (TABS as readonly string[]).includes(rawTab ?? "") ? (rawTab as CaseTab) : "overview";
  const partParam = one("part")?.toUpperCase() ?? null;
  // Decoded exactly once, safely: an id with a stray "%" shows the not-found state instead of an error page.
  const key = safeDecode(id).trim().slice(0, 64);

  const db = getDb();
  const actor = await getActor();
  const c = getCase(db, key);

  if (!c) {
    return (
      <PageBody>
        <PageHeader title="Case not found" />
        <EmptyState
          title={`No case ${key} in this demo`}
          action={
            <ButtonLink href="/worklist" variant="secondary" size="sm">
              Open the worklist
            </ButtonLink>
          }
        >
          Check the number or scan the label again. Accession numbers look like D26-04817; provisional intake items (INT-...) are not cases yet and open in Intake.
        </EmptyState>
      </PageBody>
    );
  }

  const now = c.generatedAt;
  const part = partParam ? c.parts.find((p) => p.designation === partParam) ?? null : null;
  const activeHolds = c.holdsAll.filter((h) => h.status === "active");
  const activePas = c.parts.flatMap((p) => p.stains).find((s) => s.isPas && !s.canceled) ?? null;
  const readOnly = actor.role === "director" || actor.role === "medical_director";
  const base = `/cases/${encodeURIComponent(c.identity.accessionNumber)}`;
  const tabHref = (t: CaseTab) => `${base}?tab=${t}${part ? `&part=${part.designation}` : ""}`;
  const openWork = c.tasks.filter((t) => t.status === "open" || t.status === "in_progress").length + c.clarifications.filter((x) => x.open).length;
  const counts: Partial<Record<CaseTab, number | null>> = {
    source: c.sourceDocuments.length,
    history: c.history.length,
  };
  const tabLabel = (t: CaseTab) => (t === "tasks" ? `${TAB_LABEL.tasks} (${openWork} open)` : TAB_LABEL[t]);

  return (
    <>
      <IdentityBar
        identity={{ kind: "accession", accession: c.identity.accessionNumber, namespace: c.identity.namespace }}
        part={part ? { letter: part.designation, description: [part.site, part.procedure].filter(Boolean).join(", ") } : null}
        patient={{ name: c.identity.patientLabel, mrn: c.identity.mrn, tenant: c.identity.tenantName }}
        office={c.identity.officeName}
        doctor={c.people.assignedPathologist ? { name: c.people.assignedPathologist.name, color: c.people.assignedPathologist.colorToken } : null}
        holds={[...new Set(activeHolds.map((h) => shortScope(h.scopeLabel)))]}
        pas={activePas ? { workOrder: activePas.workOrder ?? undefined, target: activePas.target.replace(" (block not yet assigned)", "") } : false}
        actions={readOnly ? <ReadOnlyTag /> : undefined}
      />
      <FreshnessWatcher freshness={c.freshness} />
      <PageBody>
        <PageHeader
          title={`Case ${c.identity.accessionNumber}`}
          description={
            <>
              {c.parts.length} {c.parts.length === 1 ? "part" : "parts"} from {c.sourceDocuments.length} source {c.sourceDocuments.length === 1 ? "order" : "orders"}, received{" "}
              {fmtDay(c.identity.receivedDay)}. Accession issued by {c.identity.issuedBySystem.replace(/^Authoritative source simulator \((.+)\)$/, "$1")} (simulated source), source case <span className="id-mono">{c.identity.sourceCaseId}</span>.{c.identity.priority === "rush" ? " Rush." : ""}
            </>
          }
          actions={
            <ButtonLink href={`/worklist?view=operations&scope=all&selected=${encodeURIComponent(c.identity.accessionId)}`} variant="secondary" size="sm">
              Show on worklist
            </ButtonLink>
          }
        />
        {c.freshness.sources
          .filter((s) => s.stale && s.state === "offline")
          .map((s) => (
            <StaleBanner
              key={s.id}
              sourceName={s.tenantName ?? s.name}
              since={s.lastSuccessAt}
              now={now}
              detail="Source documents show the versions imported before the outage. Local work on this case still updates."
            />
          ))}
        <Tabs
          items={TABS.map((t) => ({ key: t, label: tabLabel(t), count: counts[t] ?? null, href: tabHref(t) }))}
          active={tab}
          label="Case sections"
        />
        {tab === "overview" ? <CaseOverview c={c} focusPart={part?.designation ?? null} /> : null}
        {tab === "material" ? <CaseMaterial c={c} /> : null}
        {tab === "source" ? <CaseSources c={c} /> : null}
        {tab === "tasks" ? (
          <CaseTasks c={c} actor={{ id: actor.id, role: actor.role }} />
        ) : null}
        {tab === "history" ? <CaseHistory events={c.history} filters={c.historyFilters} now={now} /> : null}
      </PageBody>
    </>
  );
}
