import type { ReactNode } from "react";
import { getDb } from "@/server/db/db";
import { readClock } from "@/server/core/clock";
import { getActor } from "@/server/session";
import { roleCan } from "@/lib/roles";
import {
  loadContactsSettings,
  loadDemoSettings,
  loadIntegrationSettings,
  loadRoutingSettings,
  sourceFreshness,
} from "@/server/queries/settings";
import { AlertBanner } from "@/components/ui/alert-banner";
import { PageBody, PageHeader } from "@/components/ui/page-header";
import { Tabs } from "@/components/ui/tabs";
import { RoutingTab } from "@/components/settings/routing-tab";
import { DemoTab, ResetCard } from "@/components/settings/demo-tab";
import { IntegrationTab } from "@/components/settings/integration-tab";
import { ContactsTab } from "@/components/settings/contacts-tab";
import { PreferencesTab } from "@/components/settings/preferences-tab";

export const dynamic = "force-dynamic";
export const metadata = { title: "Settings" };

const TABS = ["routing", "demo", "integration", "contacts", "preferences"] as const;
type Tab = (typeof TABS)[number];

const TAB_LABEL: Record<Tab, string> = {
  routing: "Routing rules",
  demo: "Demo scenarios",
  integration: "Integration capabilities",
  contacts: "Office contacts",
  preferences: "Preferences",
};

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function SettingsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const raw = first(sp.tab);
  const tab: Tab = (TABS as readonly string[]).includes(raw ?? "") ? (raw as Tab) : "routing";
  const actor = await getActor();
  const readOnly = actor.role === "director";

  let body: ReactNode;
  let counts: Partial<Record<Tab, number | null>> = {};
  try {
    const db = getDb();
    const now = readClock(db).now;
    const fresh = sourceFreshness(db, now);
    const failed = (db.prepare("SELECT COUNT(*) n FROM integration_event WHERE outcome = 'failed'").get() as { n: number }).n;
    const pendingOutbox = fresh.reduce((n, s) => n + s.backlog, 0);
    const unrouted = (
      db
        .prepare(
          `SELECT COUNT(*) n FROM office o WHERE NOT EXISTS (
             SELECT 1 FROM routing_rule r JOIN routing_rule_set s ON s.id = r.rule_set_id
              WHERE r.office_id = o.id AND s.status = 'approved' AND s.effective_from <= ? AND (s.effective_to IS NULL OR s.effective_to > ?))`,
        )
        .get(now, now) as { n: number }
    ).n;
    counts = { routing: unrouted || null, integration: failed || null, demo: pendingOutbox || null };
    switch (tab) {
      case "routing": {
        const data = loadRoutingSettings(db);
        body = (
          <RoutingTab
            data={data}
            draftOffice={first(sp.draftOffice) ?? null}
            canEdit={roleCan(actor.role, "routing.editRules")}
            canApprove={roleCan(actor.role, "routing.approveRules")}
          />
        );
        break;
      }
      case "demo":
        body = <DemoTab data={loadDemoSettings(db)} />;
        break;
      case "integration":
        body = <IntegrationTab data={loadIntegrationSettings(db)} canRetry={roleCan(actor.role, "integration.manage")} />;
        break;
      case "contacts":
        body = <ContactsTab data={loadContactsSettings(db)} />;
        break;
      case "preferences":
        body = <PreferencesTab />;
        break;
    }
  } catch (e) {
    console.error("[settings] failed to load", e);
    // A database created before newer tables were added cannot be read by this version: offer the reset here,
    // because the Demo tab itself may not load.
    const outdated = e instanceof Error && /no such table|no such column/i.test(e.message);
    body = (
      <div className="grid gap-4">
        <AlertBanner tone="danger" title={outdated ? "The local demo database is from an older version" : "Could not load settings"} blocking>
          {outdated
            ? "It is missing tables this version needs, so these settings cannot be shown. Nothing was changed. Reset the demo data to rebuild it with the synthetic starting state."
            : "The local demo database could not be read. Nothing was changed. Reload the page to try again; if it keeps failing, reset the demo data."}
        </AlertBanner>
        <div className="max-w-xl">
          <ResetCard />
        </div>
      </div>
    );
  }

  return (
    <PageBody>
      <PageHeader
        title="Settings"
        description="Routing rule versions, demo scenarios, simulated connectors and their capabilities, the office contact directory, and your browser preferences."
        simulated="connectors"
        readOnly={readOnly}
      />
      <Tabs
        label="Settings sections"
        active={tab}
        items={TABS.map((t) => {
          const n = counts[t] ?? null;
          // Say what the number counts: a bare "(1)" next to "Routing rules" reads as one rule.
          const what = n === null ? null : t === "routing" ? `${n} office${n === 1 ? "" : "s"} without a rule` : t === "integration" ? `${n} failed` : t === "demo" ? `${n} waiting` : String(n);
          return {
            key: t,
            label: (
              <>
                {TAB_LABEL[t]}
                {what ? <span className="num-tabular ml-1 font-normal text-ink-muted">({what})</span> : null}
              </>
            ),
            href: `/settings?tab=${t}`,
            count: null,
          };
        })}
      />
      {readOnly && tab !== "preferences" ? (
        <AlertBanner tone="info" title="Read only">
          Director (demo) can view routing rules, contacts and integration status but cannot change them. Demo controls (clock, reset, simulated faults) stay available to the
          presenter. The server checks the role on every change.
        </AlertBanner>
      ) : null}
      {body}
    </PageBody>
  );
}
