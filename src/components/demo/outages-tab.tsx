"use client";

import { useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Check, CircleCheck, RotateCcw, Unplug, Plug, RefreshCw } from "lucide-react";
import { cn } from "@/lib/cn";
import { AlertBanner } from "@/components/ui/alert-banner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { CommandButton, CommandError } from "@/components/ui/command-button";
import { ConfirmDialog } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { StatusPill } from "@/components/ui/status-pill";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { Timestamp } from "@/components/domain/timestamp";
import { DemoControlTag, FreshnessPill, OUTCOME_LABEL } from "@/components/settings/bits";
import { useCommand } from "@/lib/client/command";
import { useLiveActions } from "@/lib/client/live";
import { fmtTime } from "@/lib/time";
import type { DemoSettings } from "@/server/queries/settings";

type Outcome = { messageId: string; outcome: string; detail: string };

/**
 * Presenter console, "Outages and reset" (synthetic demo only; moved here from
 * Settings, Demo scenarios): reset the demo data, take a simulated source,
 * printer, the notification connector or the assistant down, and inject
 * duplicate, out-of-order and failing source messages. Each control changes
 * the simulated world, never a lab record, and is recorded as a demo control.
 * The demo clock that makes scheduled messages fall due is on Role and clock.
 */
export function OutagesTab({ data }: { data: DemoSettings }) {
  return (
    <div className="grid grid-cols-1 gap-4">
      <AlertBanner tone="info" title="These controls change the simulated world, not lab records">
        Connector outages, printer faults and injected source messages exist only in this local demonstration. Nothing here contacts a real system. Each change is recorded in the
        local history as a demo control. Demo clock: {fmtTime(data.now)} ET, {data.running ? "running" : "paused"} (move it on Role and clock).
      </AlertBanner>
      <SourcesCard data={data} />
      <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-2">
        <PrintersCard printers={data.printers} />
        <div className="grid grid-cols-1 gap-4">
          <NotificationsCard status={data.notifyStatus} />
          <AssistantCard mode={data.assistantMode} />
          <ResetCard />
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ reset

export function ResetCard() {
  const router = useRouter();
  const toast = useToast();
  const { pollNow } = useLiveActions();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reset = async () => {
    setPending(true);
    setError(null);
    try {
      const res = await fetch("/api/demo/reset", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirm: true }) });
      const json = (await res.json().catch(() => null)) as { ok?: boolean; result?: { message?: string }; error?: { message?: string } } | null;
      if (!res.ok || !json?.ok) throw new Error(json?.error?.message ?? `Reset failed (HTTP ${res.status}).`);
      setOpen(false);
      toast.show({ tone: "info", title: "Demo data reset", body: json.result?.message ?? "Back to the 10:52 ET starting state (synthetic)." });
      router.refresh();
      pollNow();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Reset failed. The current data was kept.");
    } finally {
      setPending(false);
    }
  };
  return (
    <Card title="Reset demo data" actions={<DemoControlTag />}>
      <p className="text-sm text-ink-secondary">
        Replaces every record with the reproducible synthetic starting state (demo clock 10:52 ET, paused). Demo changes and the local audit history are discarded. The acting-as role is kept.
      </p>
      <div className="mt-3">
        <Button variant="secondary" icon={<RotateCcw />} onClick={() => setOpen(true)}>
          Reset demo data
        </Button>
      </div>
      {error ? (
        <AlertBanner tone="warning" title="Could not reset the demo data" className="mt-3">
          {error}
        </AlertBanner>
      ) : null}
      <ConfirmDialog
        open={open}
        title="Reset all demo data to the 10:52 starting state?"
        confirmLabel="Reset demo data"
        cancelLabel="Keep current data"
        destructive
        pending={pending}
        pendingLabel="Resetting..."
        onCancel={() => setOpen(false)}
        onConfirm={() => void reset()}
      >
        <p>Your demo changes will be lost. This replaces the local synthetic database; no real data is involved.</p>
      </ConfirmDialog>
    </Card>
  );
}

// ------------------------------------------------------------------ sources (acceptance checks 11, 13, 14)

function outcomeText(o: Outcome): string {
  return `${o.messageId}: ${OUTCOME_LABEL[o.outcome]?.label.toLowerCase() ?? o.outcome}`;
}

function ControlRow({ title, description, children, result }: { title: string; description: ReactNode; children: ReactNode; result: ReactNode }) {
  return (
    <li className="grid gap-2 px-4 py-3 lg:grid-cols-[minmax(0,1fr)_auto]">
      <div className="min-w-0">
        <p className="font-medium text-ink">{title}</p>
        <p className="text-sm text-ink-secondary">{description}</p>
        <div role="status" aria-live="polite" className="mt-1 text-sm text-ink">
          {result}
        </div>
      </div>
      <div className="flex items-start">{children}</div>
    </li>
  );
}

function SourcesCard({ data }: { data: DemoSettings }) {
  const ema = data.sources.find((s) => s.sourceId === "src_ema") ?? data.sources[0];
  const deliver = useCommand<{ madeAvailable: number; delivered: number; offline: string[]; degraded: string[]; notes: string[]; outcomes: Outcome[] }, unknown>(
    "integration.deliverQueuedNow",
    { errorToast: false },
  );
  const dup = useCommand<{ messageId: string; outcome: string; detail: string; receiptCount: number | null }, unknown>("integration.replayDuplicate", { errorToast: false });
  const older = useCommand<{ messageId: string; outcome: string | null; detail: string; sentVersion: number; storedVersion: number }, unknown>("integration.deliverOlderVersion", {
    errorToast: false,
  });
  const fail = useCommand<{ armed: boolean }, unknown>("integration.injectImportFailure", { errorToast: false });
  const pending = data.outbox.filter((o) => !o.deliveredAt);

  return (
    <Card
      title="Source systems (simulated adapters)"
      description="Outage, duplicate, out-of-order and failure scenarios for acceptance checks 11, 13 and 14. Data comes only from the simulated source outbox below."
      flush
    >
      <ul className="divide-y divide-line">
        {data.sources.map((s) => (
          <li key={s.sourceId} className="grid gap-2 px-4 py-3 lg:grid-cols-[minmax(0,1fr)_auto]">
            <div className="min-w-0">
              <p className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-ink">{s.tenantName ?? s.name}</span>
                <FreshnessPill state={s.state} />
                {s.status === "degraded" ? <StatusPill tone="warning" size="sm">Slow link (simulated)</StatusPill> : null}
              </p>
              <p className="text-sm text-ink-secondary">{s.label}</p>
              <p className="text-xs text-ink-muted">
                Ready but not delivered: <span className="num-tabular">{s.backlog}</span>
                {s.status === "offline" && s.backlog ? " (delivered once, through the same idempotent importer, after the connection is restored)" : ""}
                {s.lastAttemptAt ? <>. Last attempt {fmtTime(s.lastAttemptAt)} ET.</> : null}
              </p>
            </div>
            <div className="flex flex-wrap items-start gap-2">
              {s.status === "offline" ? (
                <CommandButton
                  command="integration.setSourceStatus"
                  input={{ sourceId: s.sourceId, status: "connected" }}
                  variant="primary"
                  size="sm"
                  icon={<Plug />}
                  pendingLabel="Restoring..."
                  successToast={(r) => {
                    const x = r as { delivered: number };
                    return `${s.tenantName ?? s.name} restored. ${x.delivered} queued message${x.delivered === 1 ? "" : "s"} delivered once.`;
                  }}
                >
                  Restore connection
                </CommandButton>
              ) : (
                <CommandButton
                  command="integration.setSourceStatus"
                  input={{ sourceId: s.sourceId, status: "offline" }}
                  size="sm"
                  icon={<Unplug />}
                  pendingLabel="Disconnecting..."
                  successToast={`${s.tenantName ?? s.name} set offline (simulated outage). Source-derived views now show data as stale.`}
                >
                  Simulate outage
                </CommandButton>
              )}
              {s.status !== "offline" ? (
                <CommandButton
                  command="integration.setSourceStatus"
                  input={{ sourceId: s.sourceId, status: s.status === "degraded" ? "connected" : "degraded" }}
                  size="sm"
                  variant="ghost"
                  pendingLabel="Changing..."
                >
                  {s.status === "degraded" ? "End slow link" : "Slow link (5 min delay)"}
                </CommandButton>
              ) : null}
              <CommandButton
                command="integration.syncNow"
                input={{ sourceId: s.sourceId }}
                size="sm"
                variant="ghost"
                icon={<RefreshCw />}
                pendingLabel="Syncing..."
                successToast={(r) => {
                  const x = r as { delivered: number; sources: { status: string }[] };
                  return x.sources[0]?.status === "offline" ? "Source offline (simulated): nothing delivered." : `Sync complete: ${x.delivered} message${x.delivered === 1 ? "" : "s"} delivered.`;
                }}
              >
                Sync now
              </CommandButton>
            </div>
          </li>
        ))}
      </ul>

      <h3 className="flex flex-wrap items-center gap-2 border-y border-line bg-surface-subtle px-4 py-2 text-sm font-semibold text-ink">
        Scenario controls <DemoControlTag>Demo controls</DemoControlTag>
      </h3>
      <ul className="divide-y divide-line">
        <ControlRow
          title="Deliver queued source messages now"
          description="Makes every pending simulated message available now, then syncs. Delivers nothing while a source is offline; with a slow link, delivery still waits 5 minutes."
          result={
            deliver.result ? (
              <>
                {deliver.result.madeAvailable} made available, {deliver.result.delivered} delivered
                {deliver.result.outcomes.length ? `: ${deliver.result.outcomes.map(outcomeText).join("; ")}` : ""}.
                {(deliver.result.notes ?? []).map((n) => (
                  <span key={n} className="mt-0.5 block text-warning-fg">
                    {n}
                  </span>
                ))}
              </>
            ) : (
              <CommandError error={deliver.error} />
            )
          }
        >
          <div className="flex max-w-[16rem] flex-col items-end gap-1">
            <Button
              size="sm"
              loading={deliver.pending}
              loadingLabel="Delivering..."
              disabled={!pending.length}
              reasonId={pending.length ? undefined : "deliver-now-reason"}
              onClick={() => void deliver.run({})}
            >
              Deliver now ({pending.length})
            </Button>
            {pending.length ? null : (
              <p id="deliver-now-reason" className="text-right text-sm text-ink-secondary">
                Nothing is waiting in the simulated outbox.
              </p>
            )}
          </div>
        </ControlRow>
        <ControlRow
          title="Replay a duplicate message"
          description="The simulated source re-sends the last applied message with the same message id. Expected: duplicate ignored; nothing changes except the receipt count."
          result={
            dup.result ? (
              <>
                {dup.result.messageId}: {OUTCOME_LABEL[dup.result.outcome]?.label.toLowerCase() ?? dup.result.outcome}
                {dup.result.receiptCount ? ` (received ${dup.result.receiptCount} times)` : ""}.
              </>
            ) : (
              <CommandError error={dup.error} />
            )
          }
        >
          <div className="flex max-w-[16rem] flex-col items-end gap-1">
            <Button
              size="sm"
              loading={dup.pending}
              loadingLabel="Replaying..."
              disabled={ema?.status === "offline"}
              reasonId={ema?.status === "offline" ? "replay-dup-reason" : undefined}
              onClick={() => void dup.run({ sourceId: ema?.sourceId })}
            >
              Replay duplicate
            </Button>
            {ema?.status === "offline" ? (
              <p id="replay-dup-reason" className="text-right text-sm text-ink-secondary">
                {ema.tenantName ?? "The source"} is offline (simulated outage). Restore the connection first.
              </p>
            ) : null}
          </div>
        </ControlRow>
        <ControlRow
          title="Deliver an out-of-order older version"
          description="The simulated source sends an older version of an order after a newer one was stored. Expected: stale, ignored; the newer version is kept."
          result={
            older.result ? (
              <>
                {older.result.messageId} (v{older.result.sentVersion}, stored v{older.result.storedVersion}):{" "}
                {older.result.outcome ? OUTCOME_LABEL[older.result.outcome]?.label.toLowerCase() ?? older.result.outcome : older.result.detail}
              </>
            ) : (
              <CommandError error={older.error} />
            )
          }
        >
          <Button size="sm" loading={older.pending} loadingLabel="Sending..." onClick={() => void older.run({ sourceId: ema?.sourceId })}>
            Send older version
          </Button>
        </ControlRow>
        <ControlRow
          title="Fail the next message"
          description="The next message from EMA-SIM Sunrise Coast fails processing and waits in the failure queue (Integration tab) until a supervisor retries it."
          result={
            fail.error ? (
              <CommandError error={fail.error} />
            ) : ema && data.failureArmed[ema.sourceId] ? (
              <span className="text-warning-fg">Armed: the next message will fail.</span>
            ) : null
          }
        >
          <Button size="sm" loading={fail.pending} loadingLabel="Saving..." onClick={() => void fail.run({ sourceId: ema?.sourceId, enabled: !(ema && data.failureArmed[ema.sourceId]) })}>
            {ema && data.failureArmed[ema.sourceId] ? "Disarm" : "Fail next message"}
          </Button>
        </ControlRow>
      </ul>

      <h3 className="border-y border-line bg-surface-subtle px-4 py-2 text-sm font-semibold text-ink">Simulated source outbox</h3>
      {data.outbox.length ? (
        <Table caption="Messages the simulated sources will send, with their available time; pending first" scroll="container" maxHeight="360px" wrapperClassName="rounded-none border-0">
          <THead>
            <tr>
              <TH>Message</TH>
              <TH>Source</TH>
              <TH>Available</TH>
              <TH>Status</TH>
              <TH>What the importer will do</TH>
            </tr>
          </THead>
          <TBody>
            {data.outbox.map((o) => (
              <TR key={o.id}>
                <TD className="py-2">
                  <span className="id-mono">{o.messageId}</span>
                  <span className="block text-xs text-ink-muted">
                    {o.messageType}
                    {o.note ? `, ${o.note}` : ""}
                  </span>
                </TD>
                <TD className="text-ink-secondary">{data.sources.find((s) => s.sourceId === o.sourceId)?.tenantName ?? o.sourceName}</TD>
                <TD>
                  <Timestamp iso={o.availableAt} now={data.now} />
                </TD>
                <TD>
                  {o.deliveredAt ? (
                    <StatusPill tone="neutral" icon={CircleCheck} size="sm">
                      Delivered {fmtTime(o.deliveredAt)}
                    </StatusPill>
                  ) : o.due ? (
                    <StatusPill tone="warning" size="sm">
                      {data.sources.find((s) => s.sourceId === o.sourceId)?.status === "offline" ? "Waiting: source offline" : "Ready, next poll"}
                    </StatusPill>
                  ) : (
                    <StatusPill tone="neutral" size="sm">
                      Scheduled
                    </StatusPill>
                  )}
                </TD>
                <TD wrap className="text-sm text-ink-secondary">
                  {o.deliveredAt ? "See the integration event log for the outcome." : o.expectation}
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      ) : (
        <div className="p-4">
          <EmptyState compact title="Outbox empty">
            The simulated sources have nothing scheduled. Office amendments and scenario messages appear here before they are delivered.
          </EmptyState>
        </div>
      )}
    </Card>
  );
}

// ------------------------------------------------------------------ other connectors

// Severity ladder: a printer that works is a quiet check (never green); offline and timeouts are amber.
const PRINTER_STATUS: Record<string, { label: string; tone: "warning" | "neutral"; done?: boolean }> = {
  online: { label: "Online", tone: "neutral", done: true },
  offline: { label: "Offline", tone: "warning" },
  simulate_timeout: { label: "Times out after submit", tone: "warning" },
};

const PRINTER_OPTIONS = [
  // Printer names already end in "(simulated)".
  { status: "online", label: "Online", toast: (n: string) => `${n} back online.` },
  { status: "offline", label: "Offline", toast: (n: string) => `${n} offline: new jobs stay queued.` },
  { status: "simulate_timeout", label: "Time out next job", toast: (n: string) => `${n} will time out after the next submission.` },
] as const;

/** Segmented control: the current simulated state is the selected segment; the others are the choices. */
function PrinterStateControl({ printer }: { printer: DemoSettings["printers"][number] }) {
  const [target, setTarget] = useState<string | null>(null);
  const cmd = useCommand<unknown, { printerId: string; status: string }>("printer.setStatus", {
    errorToast: false,
    successToast: (_r, input) => PRINTER_OPTIONS.find((o) => o.status === input.status)?.toast(printer.name) ?? "Printer updated (simulated).",
  });
  const labelId = `printer-state-${printer.id}`;
  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-2">
        <span id={labelId} className="text-xs text-ink-muted">
          Simulate
        </span>
        <div role="group" aria-labelledby={labelId} className="inline-flex gap-0.5 rounded-md border border-line-strong bg-surface-subtle p-0.5">
          {PRINTER_OPTIONS.map((o) => {
            const selected = printer.status === o.status;
            const busy = cmd.pending && target === o.status;
            return (
              <button
                key={o.status}
                type="button"
                aria-pressed={selected}
                aria-label={`${printer.name}: ${o.label}${selected ? " (current)" : ""}`}
                disabled={cmd.pending}
                onClick={() => {
                  if (selected) return;
                  setTarget(o.status);
                  void cmd.run({ printerId: printer.id, status: o.status }).finally(() => setTarget(null));
                }}
                className={cn(
                  "inline-flex h-7 min-h-[max(1.75rem,var(--hlo-target-min))] items-center gap-1 whitespace-nowrap rounded-sm px-2.5 text-xs font-medium",
                  selected ? "bg-surface text-ink shadow-1 ring-1 ring-line-strong" : "text-ink-secondary hover:bg-surface hover:text-ink disabled:text-ink-disabled",
                )}
              >
                {selected ? <Check className="size-3.5 text-brand" aria-hidden /> : null}
                {busy ? "Saving..." : o.label}
              </button>
            );
          })}
        </div>
      </div>
      <CommandError error={cmd.error} />
    </div>
  );
}

function PrintersCard({ printers }: { printers: DemoSettings["printers"] }) {
  return (
    <Card title="Label printers" description="Offline keeps jobs queued. A timeout after submission leaves the outcome unknown until someone reconciles it." flush>
      <ul className="divide-y divide-line" aria-label="Simulated printers and their fault settings">
        {printers.map((p) => {
          const st = PRINTER_STATUS[p.status] ?? { label: p.status, tone: "neutral" as const };
          return (
            <li key={p.id} className="grid gap-2 px-4 py-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-medium text-ink">{p.name}</p>
                  <p className="text-xs text-ink-muted">
                    {p.location}, {p.reportsCompletion ? "reports completion" : "acknowledgement only"}
                  </p>
                </div>
                <StatusPill tone={st.tone} icon={st.done ? CircleCheck : undefined} size="sm">
                  {st.label}
                </StatusPill>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs text-ink-secondary">
                  Queued: <span className="num-tabular font-medium text-ink">{p.queuedJobs}</span>. Unknown outcome:{" "}
                  <span className={p.unknownJobs ? "num-tabular font-medium text-warning-fg" : "num-tabular font-medium text-ink"}>{p.unknownJobs}</span>
                </p>
                <PrinterStateControl printer={p} />
              </div>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

function NotificationsCard({ status }: { status: string }) {
  const offline = status === "offline";
  return (
    <Card title="Office notifications">
      <p className="flex flex-wrap items-center gap-2 text-sm">
        <StatusPill tone={offline ? "warning" : "neutral"} icon={offline ? undefined : CircleCheck} size="sm">
          {offline ? "Offline: sends fail" : "Connected"}
        </StatusPill>
      </p>
      <p className="mt-2 text-sm text-ink-secondary">
        Nothing contacts a real office. The simulated connector decides each delivery outcome: offline → delivery failed; contact out with no available backup → delivery failed; phone or
        unverified contact → delivery unknown. A failed or unknown delivery never counts as an answer.
      </p>
      <div className="mt-3">
        <CommandButton
          command="notifications.setStatus"
          input={{ status: offline ? "connected" : "offline" }}
          size="sm"
          variant={offline ? "primary" : "secondary"}
          pendingLabel="Saving..."
          successToast={offline ? "Notifications restored (simulated)." : "Notifications offline (simulated): new sends will be recorded as delivery failed."}
        >
          {offline ? "Restore notifications" : "Make notifications fail"}
        </CommandButton>
      </div>
    </Card>
  );
}

function AssistantCard({ mode }: { mode: string }) {
  const unavailable = mode === "unavailable";
  return (
    <Card title="Drafting and extraction assistant">
      <p className="flex flex-wrap items-center gap-2 text-sm">
        <StatusPill tone={unavailable ? "warning" : "info"} size="sm">
          {unavailable ? "Unavailable" : "Deterministic demo output (not live AI)"}
        </StatusPill>
      </p>
      <p className="mt-2 text-sm text-ink-secondary">When unavailable, clarification drafting and transcript extraction show that the assistant is unavailable; manual entry keeps working.</p>
      <div className="mt-3">
        <CommandButton
          command="assistant.setMode"
          input={{ mode: unavailable ? "deterministic" : "unavailable" }}
          size="sm"
          variant={unavailable ? "primary" : "secondary"}
          pendingLabel="Saving..."
          successToast={unavailable ? "Assistant restored (deterministic demo output)." : "Assistant unavailable: manual work continues."}
        >
          {unavailable ? "Restore assistant" : "Make assistant unavailable"}
        </CommandButton>
      </div>
    </Card>
  );
}
