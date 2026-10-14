"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Archive, MapPin, ScanLine, Truck, Undo2, SearchX } from "lucide-react";
import { Card, FactList } from "@/components/ui/card";
import { AlertBanner } from "@/components/ui/alert-banner";
import { Button, DisabledReason } from "@/components/ui/button";
import { CommandButton, CommandError } from "@/components/ui/command-button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input, Select } from "@/components/ui/field";
import { StatePill, StatusPill } from "@/components/ui/status-pill";
import { Tabs } from "@/components/ui/tabs";
import { EmptyState } from "@/components/ui/empty-state";
import { useToast } from "@/components/ui/toast";
import { IdChip } from "@/components/domain/chips";
import { SimulatedLabel } from "@/components/domain/honesty";
import { Timestamp } from "@/components/domain/timestamp";
import { useCommand } from "@/lib/client/command";
import { useFocusScanOnMount, useScan, useScanTarget, type ScanOutcome } from "@/lib/client/scan";
import { useCan } from "@/lib/client/shell-context";
import type { RetrievalDetail, RetrievalFilter, RetrievalItemView, RetrievalListRow, custodyExceptions } from "@/server/queries/materials";
import { ReasonDialog } from "./print-dialogs";
import { ContextBar, Divider, failureToScan, SectionTitle, useReadOnly } from "./shared";

type RetrievalScanDto = { result: string; accepted: boolean; message: string; scannedLabel: string | null };

const ITEM_TONE: Record<string, "neutral" | "info" | "success" | "warning" | "danger"> = {
  pending: "neutral",
  picked: "info",
  delivered: "success",
  returned: "success",
  not_found: "danger",
  missing_investigation: "danger",
};

const EVENT_TEXT: Record<string, string> = {
  stored: "Stored",
  location_confirmed: "Location confirmed",
  checked_out: "Checked out",
  returned: "Returned",
  sent_out: "Sent out",
  received_back: "Received back",
  missing_reported: "Reported missing",
  found: "Found",
  scan_mismatch: "Wrong block scanned (not accepted)",
};

function toScanOutcome(r: RetrievalScanDto): ScanOutcome {
  if (r.result === "picked") return { tone: "success", message: r.message };
  if (r.result === "duplicate") return { tone: "info", message: r.message, sound: null };
  return { tone: "danger", alert: true, message: r.message };
}

function ItemCard({ item, total, now, requestDisplayId, readOnly, canPick }: { item: RetrievalItemView; total: number; now: string; requestDisplayId: string; readOnly: string | null; canPick: boolean }) {
  const [nfOpen, setNfOpen] = useState(false);
  const [code, setCode] = useState(item.location.code && item.location.code.startsWith("CAB-") ? item.location.code : "");
  const toast = useToast();
  const ret = useCommand<{ message: string }, { blockId: string; locationCode: string }>("retrieval.return", { errorToast: false });
  const canAct = !readOnly && canPick;
  /** Checked out or sent outside the lab: the most recent confirmed custody is the holder, not the storage slot. */
  const away = item.status === "pending" && (item.availability === "checked_out" || item.availability === "sent_out");
  return (
    <li className="rounded-md border border-line bg-surface p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="num-tabular rounded-sm bg-surface-subtle px-1.5 text-xs font-medium text-ink-secondary">
          Pick {item.benchSeq} of {total}
        </span>
        <span className="id-mono text-md font-semibold">{item.blockLabel}</span>
        <StatusPill size="sm" tone={ITEM_TONE[item.status] ?? "neutral"}>
          {item.statusLabel}
        </StatusPill>
        {item.custody.overdue ? <StatusPill size="sm" tone="danger">Overdue return</StatusPill> : null}
        {item.availability === "sent_out" ? <StatusPill size="sm" tone="warning">Outside send-out</StatusPill> : null}
      </div>

      <div className="mt-2 rounded-sm border border-line bg-surface-subtle p-2">
        {away ? (
          <>
            <p className="flex items-start gap-1.5 text-sm text-ink">
              <MapPin className="mt-0.5 size-4 shrink-0 text-ink-muted" aria-hidden />
              <span className="min-w-0">
                Last confirmed custody: <span className="font-medium">{item.custody.summary}</span>
              </span>
            </p>
            {item.location.code ? (
              <p className="mt-0.5 pl-[22px] text-xs text-ink-secondary">
                Home slot <span className="id-mono">{item.location.code}</span> (the block is not there while {item.availability === "sent_out" ? "sent out" : "checked out"})
              </p>
            ) : null}
          </>
        ) : (
        <p className="flex items-start gap-1.5 text-sm text-ink">
          <MapPin className="mt-0.5 size-4 shrink-0 text-ink-muted" aria-hidden />
          {item.location.code ? (
            <span className="min-w-0">
              Last confirmed: <span className="id-mono font-medium">{item.location.code}</span>
              <span className="text-ink-secondary">
                {" "}
                · confirmed {item.location.confirmedAt ? <Timestamp iso={item.location.confirmedAt} now={now} /> : "at an unknown time"} by {item.location.confirmedBy ?? "Unknown"}
              </span>
            </span>
          ) : (
            <span>{item.location.text}</span>
          )}
        </p>
        )}
        <p className="mt-0.5 text-xs text-ink-muted">{item.location.caption}</p>
      </div>

      <FactList
        className="mt-2"
        items={[
          ...(away ? [] : [{ label: "Custody now", value: item.custody.summary }]),
          ...(item.pickedAt ? [{ label: "Picked", value: <>{item.pickedBy ?? "Unknown"}, <Timestamp iso={item.pickedAt} now={now} /></> }] : []),
          ...(item.note ? [{ label: "Note", value: item.note }] : []),
        ]}
      />

      {item.status === "pending" && item.availability === "checked_out" && item.custody.holder ? (
        <p className="mt-2 text-xs text-ink-secondary">
          Recorded as checked out to {item.custody.holder}. {item.custody.holder} scans it for {requestDisplayId}, or a supervisor records the hand-off. A scan by anyone else is not accepted.
        </p>
      ) : null}
      {item.status === "pending" && item.availability === "sent_out" ? (
        <p className="mt-2 text-xs text-ink-secondary">Recorded as sent outside the lab. Request it back from the recipient; a scan here is treated as a conflicting record for a supervisor.</p>
      ) : null}
      {canAct && item.status === "pending" && item.availability !== "sent_out" ? (
        <div className="mt-2 flex flex-wrap gap-2">
          <Button size="sm" variant="quiet" icon={<SearchX className="size-4" aria-hidden />} onClick={() => setNfOpen(true)}>
            {item.availability === "checked_out" ? "Not with the recorded holder…" : "Not at last location…"}
          </Button>
        </div>
      ) : null}
      {canAct && (item.status === "picked" || item.status === "delivered") ? (
        <div className="mt-2 flex flex-wrap items-end gap-2">
          <Field label="Return to slot" className="w-[260px]" hint="Confirms this block's slot only, not the rest of the box.">
            <Input size="sm" mono value={code} onChange={(e) => setCode(e.target.value)} placeholder="CAB-2/DR-4/BX-11/S-14" />
          </Field>
          <Button
            size="sm"
            variant="secondary"
            icon={<Undo2 className="size-4" aria-hidden />}
            loading={ret.pending}
            onClick={async () => {
              const out = await ret.run({ blockId: item.blockId, locationCode: code });
              if (out.ok) toast.show({ tone: "success", title: "Block returned", body: out.result.message });
            }}
          >
            Record return
          </Button>
          <CommandError error={ret.error} className="basis-full" />
        </div>
      ) : null}

      <details className="mt-2">
        <summary className="cursor-pointer text-sm font-medium text-brand">Custody history ({item.history.length})</summary>
        <ol className="mt-1.5 flex flex-col gap-1 text-sm">
          {item.history.map((h) => (
            <li key={h.id} className={h.event === "scan_mismatch" ? "text-danger-fg" : "text-ink"}>
              <Timestamp iso={h.at} now={now} className="text-xs text-ink-muted" /> · {EVENT_TEXT[h.event] ?? h.event}
              {h.holder ? ` → ${h.holder}` : ""}
              {h.locationCode ? ` · ${h.locationCode}` : ""}
              {h.destination ? ` · ${h.destination}` : ""}
              {h.actor ? <span className="text-ink-muted"> (by {h.actor})</span> : null}
              {h.note ? <span className="block text-xs text-ink-muted">{h.note}</span> : null}
            </li>
          ))}
        </ol>
      </details>

      <ReasonDialog
        open={nfOpen}
        onClose={() => setNfOpen(false)}
        title={item.availability === "checked_out" ? `${item.blockLabel} is not with ${item.custody.holder ?? "the recorded holder"}?` : `${item.blockLabel} is not at its last confirmed location?`}
        description={`Opens a missing-material investigation task. ${requestDisplayId} continues with the other blocks (partial retrieval).`}
        label="What was checked"
        placeholder="Slot empty; checked neighbouring slots and the box"
        confirmLabel="Open investigation"
        cancelLabel="Keep looking"
        command="retrieval.markNotFound"
        buildInput={(note) => ({ itemId: item.id, note })}
        successTitle={() => `Investigation opened for ${item.blockLabel}`}
      />
    </li>
  );
}

function RequestWorkspace({ detail, now }: { detail: RetrievalDetail; now: string }) {
  const readOnly = useReadOnly();
  const canPick = useCan("retrieval.pick");
  const scan = useScan();
  const req = detail.request;
  const scanCmd = useCommand<RetrievalScanDto, { requestId: string; payload: string }>("retrieval.scan", { errorToast: false });
  const [last, setLast] = useState<RetrievalScanDto | null>(null);
  const active = !["delivered", "canceled"].includes(req.status);
  const scanAllowed = active && !readOnly && canPick.allowed;

  useScanTarget(scanAllowed ? `Check block for ${req.displayId}` : null, async (value) => {
    const out = await scanCmd.run({ requestId: req.id, payload: value });
    if (out.ok) setLast(out.result);
    return out.ok ? toScanOutcome(out.result) : failureToScan(out.error);
  }, { placeholder: "Scan the block (cassette) label" });
  useFocusScanOnMount(scanAllowed);

  const picked = detail.items.filter((i) => i.status === "picked").length;
  const mismatches = detail.scanLog.filter((l) => l.event === "scan_mismatch").length;
  const pending = detail.items.filter((i) => i.status === "pending");

  return (
    <div className="flex flex-col gap-3">
      <ContextBar label="Current retrieval request">
        <IdChip kind="RR" id={req.displayId} showKind />
        <StatePill domain="retrieval" state={req.status} />
        <Divider />
        <span className="text-sm">
          Requester: <span className="font-medium">{req.requestedBy}</span>
        </span>
        <Divider />
        <span className="text-sm">
          Destination: <span className="font-medium">{req.destination}</span>
        </span>
        <Divider />
        <span className="text-sm">
          <span className="num-tabular font-semibold">{req.picked}</span> of <span className="num-tabular">{req.items}</span> picked
          {req.exceptions ? <span className="text-danger-fg"> · {req.exceptions} not found</span> : null}
          {mismatches ? <span className="text-danger-fg"> · {mismatches} wrong scan{mismatches === 1 ? "" : "s"} rejected</span> : null}
        </span>
      </ContextBar>

      <p className="text-sm text-ink-secondary">
        {req.purpose}
        {req.workOrderDisplayId ? <> · Work order <span className="id-mono">{req.workOrderDisplayId}</span></> : null}
        {req.dueAt ? <> · Needed by <Timestamp iso={req.dueAt} now={now} /></> : null}
      </p>

      {last && !last.accepted && last.result !== "duplicate" ? (
        <AlertBanner
          tone="danger"
          title={
            last.result === "mismatch"
              ? "Mismatch: not accepted"
              : last.result === "held_by_other"
                ? "Recorded holder differs: not picked"
                : last.result === "conflict"
                  ? "Conflicting custody records: not picked"
                  : "Scan not accepted"
          }
        >
          {last.message.replace(/^Mismatch\.\s*/, "")}
          {last.result === "mismatch" ? " The request and the block records were not changed; the wrong scan is recorded in the custody history." : ""}
        </AlertBanner>
      ) : last && last.accepted ? (
        <AlertBanner tone="success" title="Scanned, matches">
          {last.message}
        </AlertBanner>
      ) : null}

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="flex min-w-0 flex-col gap-3">
          <section aria-labelledby="pick-title" className="flex flex-col gap-1.5">
            <SectionTitle id="pick-title" aside="Grouped by storage location for walking; the bench order is kept on each item.">
              Pick list
            </SectionTitle>
            <div className="flex flex-col gap-2">
              {detail.pickList.map((g) => (
                <div key={g.key} className="rounded-md border border-line bg-surface">
                  <p className="flex items-center gap-1.5 border-b border-line bg-surface-subtle px-3 py-1.5 text-sm font-medium text-ink">
                    <Archive className="size-4 text-ink-muted" aria-hidden />
                    {g.label}
                  </p>
                  <ul className="divide-y divide-line">
                    {g.items.map((i) => (
                      <li key={i.itemId} className="flex flex-wrap items-center gap-2 px-3 py-1.5 text-sm">
                        <span className="num-tabular w-[86px] shrink-0 text-ink-secondary">
                          Pick {i.benchSeq} of {i.total}
                        </span>
                        <span className="id-mono font-medium">{i.blockLabel}</span>
                        {i.slot ? <span className="id-mono text-ink-secondary">Slot {i.slot}</span> : null}
                        <StatusPill size="sm" tone={ITEM_TONE[i.status] ?? "neutral"}>
                          {i.statusLabel}
                        </StatusPill>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </section>

          <section aria-labelledby="items-title" className="flex flex-col gap-1.5">
            <SectionTitle id="items-title" aside="In the order the receiving bench needs them">
              Requested blocks
            </SectionTitle>
            <ul className="flex flex-col gap-2">
              {detail.items.map((i) => (
                <ItemCard key={i.id} item={i} total={detail.items.length} now={now} requestDisplayId={req.displayId} readOnly={readOnly} canPick={canPick.allowed} />
              ))}
            </ul>
            <p className="text-xs text-ink-muted">{detail.overdueRule}</p>
          </section>
        </div>

        <div className="order-first flex flex-col gap-3 xl:order-none">
          <Card
            title="Scan check"
            headingLevel={3}
            description={scanAllowed ? `The scan field is set to "Check block for ${req.displayId}". A wrong block is rejected and nothing changes.` : undefined}
            bodyClassName="flex flex-col gap-3"
          >
            {scanAllowed ? (
              <div className="flex flex-col gap-1.5">
                <p className="flex flex-wrap items-center gap-1.5 text-xs text-ink-muted">
                  <SimulatedLabel connector="scanner" size="xs" /> Blocks in your hand at the cabinet (synthetic). Click to scan, or scan or type a label.
                </p>
                <ul className="flex flex-col gap-1.5">
                  {pending.map((p) => (
                    <li key={p.id} className="flex items-center justify-between gap-2 rounded-sm border border-line px-2 py-1.5">
                      <span className="id-mono text-sm font-medium">{p.blockLabel}</span>
                      <Button size="sm" variant="secondary" icon={<ScanLine className="size-4" aria-hidden />} disabled={scan.pending} onClick={() => void scan.submit(p.identifier).then(() => scan.focus())}>
                        Scan<span className="sr-only"> {p.blockLabel}</span>
                      </Button>
                    </li>
                  ))}
                  {detail.sampleWrongBlock ? (
                    <li className="flex items-center justify-between gap-2 rounded-sm border border-dashed border-line-strong px-2 py-1.5">
                      <span className="min-w-0">
                        <span className="id-mono text-sm font-medium">{detail.sampleWrongBlock.label}</span>
                        <span className="block text-xs text-ink-muted">Similar block from a nearby drawer (wrong block)</span>
                      </span>
                      <Button size="sm" variant="secondary" icon={<ScanLine className="size-4" aria-hidden />} disabled={scan.pending} onClick={() => void scan.submit(detail.sampleWrongBlock!.payload).then(() => scan.focus())}>
                        Scan<span className="sr-only"> {detail.sampleWrongBlock.label}</span>
                      </Button>
                    </li>
                  ) : null}
                </ul>
              </div>
            ) : null}
            <div className={scanAllowed ? "flex flex-col gap-2 border-t border-line pt-3" : "flex flex-col gap-2"}>
              {active ? (
                <CommandButton
                  command="retrieval.deliver"
                  input={{ requestId: req.id }}
                  variant="primary"
                  icon={<Truck className="size-4" aria-hidden />}
                  disabledReason={readOnly ?? (!canPick.allowed ? canPick.reason : picked === 0 ? "Scan at least one requested block first." : undefined) ?? undefined}
                  successToast={(r: { message: string }) => r.message}
                  pendingLabel="Recording..."
                >
                  Deliver to {req.destination}
                </CommandButton>
              ) : (
                <p className="text-sm text-ink-secondary">This request is {req.statusLabel.toLowerCase()}.</p>
              )}
              {pending.length && active ? <p className="text-xs text-ink-muted">Still to pick: {pending.map((p) => p.blockLabel).join(", ")}.</p> : null}
            </div>
          </Card>

          {detail.scanLog.length ? (
            <Card title="Scan and custody log for this request" headingLevel={3}>
              <ol className="flex flex-col gap-1 text-sm">
                {detail.scanLog.map((l, i) => (
                  <li key={i} className={l.event === "scan_mismatch" ? "text-danger-fg" : undefined}>
                    <Timestamp iso={l.at} now={now} className="text-xs text-ink-muted" /> · {EVENT_TEXT[l.event] ?? l.event}: <span className="id-mono">{l.blockLabel}</span>
                    {l.actor ? <span className="text-ink-muted"> ({l.actor})</span> : null}
                  </li>
                ))}
              </ol>
            </Card>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function NewRequestDialog({ open, onClose, blocks }: { open: boolean; onClose: () => void; blocks: { id: string; label: string; location: string | null }[] }) {
  const router = useRouter();
  const toast = useToast();
  const [order, setOrder] = useState<string[]>([]);
  const [purpose, setPurpose] = useState("");
  const [destination, setDestination] = useState("Microtomy bench 2");
  const [blank, setBlank] = useState(false);
  const cmd = useCommand<{ displayId: string; message: string }, { blockIds: string[]; purpose: string; destination: string }>("retrieval.create", { errorToast: false });
  const toggle = (id: string) => setOrder((o) => (o.includes(id) ? o.filter((x) => x !== id) : [...o, id]));
  const submit = async () => {
    if (!order.length || !purpose.trim()) {
      setBlank(true);
      return;
    }
    const out = await cmd.run({ blockIds: order, purpose: purpose.trim(), destination });
    if (out.ok) {
      toast.show({ tone: "success", title: `${out.result.displayId} created`, body: out.result.message });
      setOrder([]);
      setPurpose("");
      onClose();
      router.push(`/materials?tab=retrieval&selected=${encodeURIComponent(out.result.displayId)}`, { scroll: false });
    }
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title="Request blocks from storage"
      description="Tick blocks in the order the receiving bench needs them. The pick list will group them by location."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Do not request
          </Button>
          <Button variant="primary" loading={cmd.pending} onClick={() => void submit()}>
            Create request
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <fieldset className="max-h-[260px] overflow-y-auto rounded-md border border-line p-2">
          <legend className="px-1 text-sm font-medium text-ink-secondary">Blocks (bench order follows the order you tick them)</legend>
          <ul className="flex flex-col gap-1">
            {blocks.map((b) => {
              const pos = order.indexOf(b.id);
              return (
                <li key={b.id}>
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={pos >= 0} onChange={() => toggle(b.id)} className="accent-[var(--hlo-brand)]" />
                    <span className="num-tabular w-6 text-right text-xs text-ink-muted">{pos >= 0 ? pos + 1 : ""}</span>
                    <span className="id-mono font-medium">{b.label}</span>
                    <span className="text-xs text-ink-muted">{b.location ?? "Location unknown"}</span>
                  </label>
                </li>
              );
            })}
          </ul>
        </fieldset>
        {blank && !order.length ? <p className="text-xs text-danger-fg">Choose at least one block.</p> : null}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Purpose" required error={blank && !purpose.trim() ? "Say why the blocks are needed." : undefined}>
            <Input value={purpose} onChange={(e) => setPurpose(e.target.value)} placeholder="Deeper levels for comparison" />
          </Field>
          <Field label="Destination" required>
            <Select value={destination} onChange={(e) => setDestination(e.target.value)}>
              <option>Microtomy bench 1</option>
              <option>Microtomy bench 2</option>
              <option>Embedding center</option>
            </Select>
          </Field>
        </div>
        <CommandError error={cmd.error} />
      </div>
    </Dialog>
  );
}

const FILTERS: { key: RetrievalFilter; label: string }[] = [
  { key: "open", label: "Open" },
  { key: "overdue", label: "Overdue returns" },
  { key: "outside", label: "Requests with a send-out" },
  { key: "all", label: "All" },
];

export function RetrievalTab({
  rows,
  counts,
  filter,
  detail,
  selectedMissing,
  exceptions,
  blocks,
  now,
}: {
  rows: RetrievalListRow[];
  counts: Record<RetrievalFilter, number>;
  filter: RetrievalFilter;
  detail: RetrievalDetail | null;
  selectedMissing: string | null;
  exceptions: ReturnType<typeof custodyExceptions>;
  blocks: { id: string; label: string; location: string | null }[];
  now: string;
}) {
  const [newOpen, setNewOpen] = useState(false);
  const readOnly = useReadOnly();
  const canRequest = useCan("retrieval.request");
  const base = `/materials?tab=retrieval&rfilter=${filter}`;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <Tabs label="Retrieval filters" active={filter} size="sm" items={FILTERS.map((f) => ({ key: f.key, label: f.label, count: counts[f.key], href: `/materials?tab=retrieval&rfilter=${f.key}` }))} />
        {readOnly ? null : (
          <span className="flex flex-col items-end gap-0.5">
            <Button size="sm" variant="secondary" disabled={!canRequest.allowed} reasonId={canRequest.allowed ? undefined : "rr-request-reason"} onClick={() => setNewOpen(true)}>
              Request blocks
            </Button>
            {canRequest.allowed ? null : <DisabledReason id="rr-request-reason">{canRequest.reason}</DisabledReason>}
          </span>
        )}
      </div>
      {selectedMissing ? (
        <AlertBanner tone="warning" title={`Retrieval request ${selectedMissing} was not found.`}>
          Check the request number, or choose one from the list.
        </AlertBanner>
      ) : null}

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-[260px_minmax(0,1fr)] xl:grid-cols-[280px_minmax(0,1fr)]">
        <nav aria-label="Retrieval requests" className="flex flex-col gap-1.5">
          {rows.length ? (
            rows.map((r) => {
              const sel = detail?.request.id === r.id;
              return (
                <Link
                  key={r.id}
                  href={`${base}&selected=${encodeURIComponent(r.displayId)}`}
                  scroll={false}
                  aria-current={sel ? "page" : undefined}
                  className={`flex flex-col gap-1 rounded-md border px-3 py-2 text-sm ${sel ? "border-brand bg-brand-50" : "border-line bg-surface hover:bg-surface-subtle"}`}
                >
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="id-mono font-semibold">{r.displayId}</span>
                    <StatePill domain="retrieval" state={r.status} size="sm" />
                  </span>
                  <span className="text-ink-secondary">
                    {r.requestedBy} → {r.destination}
                  </span>
                  <span className="text-xs text-ink-muted">
                    {r.picked} of {r.items} picked{r.hasOverdue ? " · includes an overdue checkout" : ""}
                    {r.hasOutside ? " · includes an outside send-out" : ""}
                  </span>
                </Link>
              );
            })
          ) : (
            <EmptyState compact title={filter === "open" ? "No open requests" : filter === "overdue" ? "No requests with an overdue return" : filter === "outside" ? "No requests include an outside send-out" : "No requests yet"}>
              {filter === "outside" || filter === "overdue"
                ? "Blocks themselves that are overdue or sent outside the lab are listed under Custody exceptions below."
                : "Requests appear when a pathologist or histotech asks for blocks from storage."}
            </EmptyState>
          )}

          <Card title="Custody exceptions" description="All blocks, not only this request" headingLevel={3} className="mt-2">
            <div className="flex flex-col gap-2 text-sm">
              <div>
                <p className="font-medium text-danger-fg">Overdue returns ({exceptions.overdue.length})</p>
                {exceptions.overdue.length ? exceptions.overdue.map((o) => <p key={o.label} className="text-xs text-ink-secondary"><span className="id-mono">{o.label}</span>: {o.summary}</p>) : <p className="text-xs text-ink-muted">None</p>}
              </div>
              <div>
                <p className="font-medium text-warning-fg">Outside send-outs ({exceptions.sentOut.length})</p>
                {exceptions.sentOut.length ? exceptions.sentOut.map((o) => <p key={o.label} className="text-xs text-ink-secondary"><span className="id-mono">{o.label}</span>: {o.summary}</p>) : <p className="text-xs text-ink-muted">None</p>}
              </div>
              <div>
                <p className="font-medium text-ink">Missing-material investigations ({exceptions.missing.length})</p>
                {exceptions.missing.length ? exceptions.missing.map((o) => <p key={o.label} className="text-xs text-ink-secondary"><span className="id-mono">{o.label}</span>: {o.summary}</p>) : <p className="text-xs text-ink-muted">None</p>}
              </div>
              <p className="text-xs text-ink-muted">Locations are last confirmed, not live. A slot scan confirms only the block scanned.</p>
            </div>
          </Card>
        </nav>

        <div className="min-w-0">
          {detail ? (
            <RequestWorkspace key={detail.request.id} detail={detail} now={now} />
          ) : (
            <EmptyState title="No request selected">Choose a retrieval request to see its pick list, last confirmed locations and custody history.</EmptyState>
          )}
        </div>
      </div>
      <NewRequestDialog open={newOpen} onClose={() => setNewOpen(false)} blocks={blocks} />
    </div>
  );
}
