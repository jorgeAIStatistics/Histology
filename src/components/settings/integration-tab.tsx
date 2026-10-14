import { AlertBanner } from "@/components/ui/alert-banner";
import { Card, FactList } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { StatusPill } from "@/components/ui/status-pill";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { SimulatedLabel, UnknownValue } from "@/components/domain/honesty";
import { StaleBanner } from "@/components/domain/stale-banner";
import { Timestamp } from "@/components/domain/timestamp";
import { cn } from "@/lib/cn";
import { fmtTime } from "@/lib/time";
import {
  CAPABILITY_MATRIX_SUMMARY,
  CAPABILITY_WORDS,
  ROLLOUT_MODES,
  type CapabilityWord,
  type ConnectorCard,
  type IntegrationSettings,
} from "@/server/queries/settings";
import { CapabilityPill, FreshnessPill, OutcomePill, VIA_LABEL } from "./bits";
import { RetryEventButton } from "./retry-button";

const KIND_TITLE: Record<ConnectorCard["kind"], string> = {
  source: "Source system adapter",
  notifications: "Office notifications",
  printer: "Label printers",
  assistant: "Drafting / extraction assistant",
};

function ConnectorCardView({ c, now }: { c: ConnectorCard; now: string }) {
  const f = c.freshness;
  return (
    <Card
      title={
        <span className="flex flex-wrap items-center gap-2">
          {KIND_TITLE[c.kind]}
          {c.tenantName ? <span className="text-sm font-normal text-ink-muted">· {c.tenantName}</span> : null}
        </span>
      }
      description={c.name}
      actions={<CapabilityPill word={c.word} />}
      headingLevel={3}
    >
      <div className="grid gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <StatusPill tone={c.status === "connected" ? "success" : c.status === "degraded" ? "warning" : "danger"} size="sm">
            {c.statusLabel}
          </StatusPill>
          {f ? <FreshnessPill state={f.state} /> : null}
        </div>
        <FactList
          items={[
            { label: "Rollout mode", value: c.rolloutMode.startsWith("A") ? "A — local demonstration" : c.rolloutMode },
            ...(c.kind === "source"
              ? [
                  {
                    label: "Last successful sync",
                    value: c.lastSuccessAt ? <Timestamp iso={c.lastSuccessAt} now={now} showAge /> : <UnknownValue reason="no successful sync recorded" />,
                  },
                  {
                    label: "Data age",
                    value:
                      f?.ageMinutes === null || f?.ageMinutes === undefined ? (
                        <UnknownValue reason="never synced" />
                      ) : (
                        <span className={cn(f.stale && "font-medium text-warning-fg")}>
                          {f.ageMinutes} min{f.stale ? " (stale)" : ""}
                        </span>
                      ),
                  },
                  { label: "Backlog (ready, not delivered)", value: <span className="num-tabular">{f?.backlog ?? 0}</span> },
                ]
              : [
                  {
                    label: "Last contact",
                    value: c.lastAttemptAt ? <Timestamp iso={c.lastAttemptAt} now={now} showAge /> : <UnknownValue reason="no activity recorded" />,
                  },
                ]),
            { label: "Last error", value: c.lastError ?? "None" },
          ]}
        />
        {c.capabilities.length ? (
          <Table caption={`Capability discovery result for ${c.name}`}>
            <THead>
              <tr>
                <TH>Capability</TH>
                <TH>Discovery result</TH>
                <TH>Status</TH>
              </tr>
            </THead>
            <TBody>
              {c.capabilities.map((cap) => (
                <TR key={cap.capability}>
                  <TD className="id-mono text-xs">{cap.capability}</TD>
                  <TD wrap className="text-sm text-ink-secondary">
                    {cap.raw}
                  </TD>
                  <TD>
                    <CapabilityPill word={cap.word} />
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        ) : (
          <UnknownValue reason="the connector reported no capabilities" />
        )}
      </div>
    </Card>
  );
}

export function IntegrationTab({ data, canRetry }: { data: IntegrationSettings; canRetry: boolean }) {
  const { now, connectors, log, failures, totals } = data;
  const stale = connectors.filter((c) => c.freshness?.stale);
  return (
    <div className="grid gap-4">
      <AlertBanner tone="info" title="This demo runs in mode A: local demonstration">
        Every connector here is simulated: generated data, no credentials, and nothing leaves this computer. Local completion of a task never writes to a source system. Real access needs
        the approvals listed under rollout modes B–D.
      </AlertBanner>
      {stale.map((c) =>
        c.freshness?.status === "offline" ? (
          <StaleBanner
            key={c.id}
            sourceName={c.tenantName ?? c.name}
            since={c.freshness.offlineSince ?? c.freshness.lastSuccessAt}
            now={now}
            detail={`Last confirmed data is from ${c.freshness.lastSuccessAt ? `${fmtTime(c.freshness.lastSuccessAt)} ET` : "an unknown time"}. ${c.freshness.backlog} ready message${c.freshness.backlog === 1 ? " is" : "s are"} waiting and will be applied once, after the connection is restored. New orders and changes since then are not shown.`}
          />
        ) : (
          <AlertBanner key={c.id} tone="warning" title={c.freshness?.label ?? `${c.name}: data may be out of date`} />
        ),
      )}

      <section aria-labelledby="cap-words" className="rounded-md border border-line bg-surface px-4 py-3">
        <h2 id="cap-words" className="text-sm font-semibold text-ink">
          Capability status words
        </h2>
        <dl className="mt-2 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          {(Object.keys(CAPABILITY_WORDS) as CapabilityWord[]).map((w) => (
            <div key={w} className="flex items-start gap-2">
              <dt>
                <CapabilityPill word={w} />
              </dt>
              <dd className="text-sm text-ink-secondary">{CAPABILITY_WORDS[w]}</dd>
            </div>
          ))}
        </dl>
      </section>

      <div className="grid items-start gap-4 xl:grid-cols-2">
        {connectors.map((c) => (
          <ConnectorCardView key={c.id} c={c} now={now} />
        ))}
      </div>

      <Card
        title="Failure queue"
        description="Messages that could not be applied. They keep their payload and reason until retried; nothing is deleted."
        actions={<span className="text-sm text-ink-muted">{failures.length} waiting</span>}
        flush
      >
        {failures.length ? (
          <Table caption="Inbound messages that failed and can be retried">
            <THead>
              <tr>
                <TH>Received</TH>
                <TH>Source</TH>
                <TH>Message</TH>
                <TH>Reason</TH>
                <TH align="right">Attempts</TH>
                <TH>
                  <span className="sr-only">Retry</span>
                </TH>
              </tr>
            </THead>
            <TBody>
              {failures.map((f) => (
                <TR key={f.eventId}>
                  <TD>
                    <Timestamp iso={f.receivedAt} now={now} showAge />
                  </TD>
                  <TD className="text-ink-secondary">{f.sourceName.replace(/ \(simulated source adapter\)$/, "")}</TD>
                  <TD>
                    <span className="id-mono">{f.messageId}</span>
                    <span className="block text-xs text-ink-muted">{f.messageType}</span>
                  </TD>
                  <TD wrap className="max-w-[52ch] text-sm text-danger-fg">
                    {f.detail ?? "No reason recorded"}
                  </TD>
                  <TD numeric>{f.attempts || 1}</TD>
                  <TD>
                    <RetryEventButton eventId={f.eventId} messageId={f.messageId} canRetry={canRetry} />
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        ) : (
          <div className="p-4">
            <EmptyState compact title="No failed messages">
              A message that cannot be applied (invalid payload, unknown office, processing error) waits here with its reason until a supervisor retries it.
            </EmptyState>
          </div>
        )}
      </Card>

      <Card
        title="Integration event log"
        description={
          <>
            Latest 50 receipts. Totals: {totals.applied} applied · {totals.duplicate_ignored} duplicate ignored · {totals.stale_ignored} stale, ignored · {totals.failed} failed.
          </>
        }
        actions={<SimulatedLabel connector="source adapters" />}
        flush
      >
        {log.length ? (
          <Table caption="Inbound source messages and their outcomes, newest first" scroll="container" maxHeight="520px" wrapperClassName="rounded-none border-0">
            <THead>
              <tr>
                <TH>Received</TH>
                <TH>Message</TH>
                <TH>Order</TH>
                <TH>Outcome</TH>
                <TH>How</TH>
                <TH>Detail</TH>
              </tr>
            </THead>
            <TBody>
              {log.map((e) => (
                <TR key={e.key}>
                  <TD>
                    <Timestamp iso={e.at} now={now} />
                  </TD>
                  <TD>
                    <span className="id-mono">{e.messageId}</span>
                    <span className="block text-xs text-ink-muted">
                      {e.messageType} · {e.sourceName.replace(/ \(simulated source adapter\)$/, "")}
                    </span>
                  </TD>
                  <TD>
                    {e.entityKey ? <span className="id-mono text-sm">{e.entityKey.split(":").slice(1).join(":")}</span> : <UnknownValue />}
                    {e.version !== null ? <span className="ml-1 text-xs text-ink-muted">v{e.version}</span> : null}
                  </TD>
                  <TD>
                    <OutcomePill outcome={e.outcome} />
                  </TD>
                  <TD className="text-xs text-ink-secondary">{VIA_LABEL[e.via] ?? e.via}</TD>
                  <TD wrap className="max-w-[60ch] text-sm text-ink-secondary">
                    {e.detail ?? "None"}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        ) : (
          <div className="p-4">
            <EmptyState compact title="No messages received yet">
              Messages from the simulated sources appear here with their outcome as the demo clock moves.
            </EmptyState>
          </div>
        )}
      </Card>

      <Card
        title="Field-by-field capability summary"
        description={
          <>
            Condensed from the project document <span className="id-mono">docs/integration-capability-matrix.md</span> (documentation checked 2026-10-14). &quot;Unknown&quot; means not
            documented publicly — a question for the vendor, not proof that a feature is missing.
          </>
        }
        flush
      >
        <Table caption="Required fields and actions: documented access, unknowns, candidate interface and fallback">
          <THead>
            <tr>
              <TH>Field / action</TH>
              <TH>Documented access</TH>
              <TH>Unknowns</TH>
              <TH>Candidate interface</TH>
              <TH>Fallback</TH>
            </tr>
          </THead>
          <TBody>
            {CAPABILITY_MATRIX_SUMMARY.map((r) => (
              <TR key={r.field}>
                <TD wrap className="font-medium">
                  {r.field}
                </TD>
                <TD>
                  <CapabilityPill word={r.documented} />
                </TD>
                <TD wrap className="text-sm text-ink-secondary">
                  {r.unknowns}
                </TD>
                <TD wrap className="text-sm">
                  {r.candidate}
                </TD>
                <TD wrap className="text-sm text-ink-secondary">
                  {r.fallback}
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </Card>

      <Card title="Rollout modes" description="Each mode needs its own approvals before it starts. This demo runs in mode A." flush>
        <Table caption="Rollout modes A to D">
          <THead>
            <tr>
              <TH>Mode</TH>
              <TH>Data</TH>
              <TH>Connectors</TH>
              <TH>Gate to enter</TH>
            </tr>
          </THead>
          <TBody>
            {ROLLOUT_MODES.map((m) => (
              <TR key={m.mode} selected={m.mode === "A"}>
                <TD wrap className="font-medium">
                  {m.mode}. {m.name}
                  {m.mode === "A" ? <span className="block text-xs font-normal text-brand-ink">This demo runs in mode A</span> : null}
                </TD>
                <TD wrap className="text-sm">
                  {m.data}
                </TD>
                <TD wrap className="text-sm">
                  {m.connectors}
                </TD>
                <TD wrap className="text-sm text-ink-secondary">
                  {m.gate}
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </Card>
    </div>
  );
}
