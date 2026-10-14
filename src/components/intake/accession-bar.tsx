"use client";

import { ArrowRight } from "lucide-react";
import type { ItemDetail, BenchPermissions, IntakeBench } from "@/server/queries/intake";
import type { Blocker } from "@/server/domain/accession";
import { Button, ButtonLink } from "@/components/ui/button";
import { CommandButton, CommandError } from "@/components/ui/command-button";
import { AccessionChip } from "@/components/domain/chips";
import { SimulatedLabel } from "@/components/domain/honesty";
import { Timestamp } from "@/components/domain/timestamp";
import { useCommand } from "@/lib/client/command";
import { useToast } from "@/components/ui/toast";

interface PrintOutcome {
  outcome: "created" | "duplicate_prevented";
  displayId: string;
  stateLabel: string;
  message: string;
  printerUnavailable?: boolean;
}

interface AccessionResult {
  outcome: "issued" | "source_offline" | "duplicate";
  status: string;
  accessionNumber: string | null;
  requestDisplayId: string;
  message: string;
}

/**
 * Why the request is blocked, kept to one line in the sticky bar: the first
 * reason in full and the rest behind "Show all", so the bar never covers the
 * comparison it sits under.
 */
function BlockerList({ blockers, id, itemDisplay }: { blockers: Blocker[]; id: string; itemDisplay: string }) {
  if (!blockers.length) return null;
  const [first] = blockers;
  // "INT-1014-032 container 1 (ORD-77121 part B): not yet staff verified..." → the reason first; where it applies is in the full list.
  const m = first.message.startsWith(itemDisplay) ? /^[^:]+:\s+(.+)$/.exec(first.message) : null;
  const short = m ? m[1][0].toUpperCase() + m[1].slice(1) : first.message;
  if (blockers.length === 1 && !m) {
    return (
      <p id={id} className="text-xs text-ink-secondary">
        <span className="font-medium text-ink">Cannot request yet:</span> {first.message}
      </p>
    );
  }
  return (
    <details id={id} className="group/blk text-xs text-ink-secondary">
      {/* Folded: one line (the first reason, cut to fit) so the sticky bar stays low; open: every reason in full. */}
      <summary className="flex cursor-pointer list-none items-baseline gap-1 [&::-webkit-details-marker]:hidden">
        <span className="min-w-0 truncate" title={first.message}>
          <span className="font-medium text-ink">Cannot request yet:</span> {short}
        </span>
        <span className="shrink-0 whitespace-nowrap font-medium text-brand underline underline-offset-2 group-open/blk:hidden">
          {blockers.length > 1 ? `Show all ${blockers.length}` : "Details"}
        </span>
        <span className="hidden shrink-0 whitespace-nowrap font-medium text-brand underline underline-offset-2 group-open/blk:inline">Hide</span>
      </summary>
      <ul className="mt-1 ml-4 list-disc space-y-0.5">
        {blockers.map((b, i) => (
          <li key={`${b.code}-${i}`}>{b.message}</li>
        ))}
      </ul>
    </details>
  );
}

/**
 * Sticky action bar: "Request accession (simulated source)". The official
 * number comes only from the simulated authoritative source; it is shown as an
 * accession chip, distinct from the provisional intake chip.
 */
export function AccessionBar({
  item,
  permissions,
  source,
  now,
}: {
  item: ItemDetail;
  permissions: BenchPermissions;
  source: IntakeBench["source"];
  now: string;
}) {
  const toast = useToast();
  const req = useCommand<AccessionResult, { intakeItemIds: string[]; relatedCandidateId?: string | null }>("accession.request", {
    errorToast: false,
    onSuccess: (r, meta) => {
      if (meta.replayed) return;
      if (r.outcome === "issued") toast.show({ tone: "success", title: `Accession ${r.accessionNumber} issued by EMA-SIM (simulated)`, body: r.message });
      else if (r.outcome === "source_offline") toast.show({ tone: "warning", title: "Source system unreachable (simulated outage)", body: r.message });
      else toast.show({ tone: "info", title: r.message });
    },
  });

  if (item.accession) {
    // The next step sits where "Request accession" was (left), clear of toasts at the bottom right; the issued number follows.
    return (
      <div className="sticky bottom-0 z-10 flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-t-md border border-line bg-surface px-3 py-2 shadow-2">
        <ButtonLink href={`/cases/${encodeURIComponent(item.accession.number)}`} variant="primary" size="sm" icon={<ArrowRight />}>
          Open case {item.accession.number}
        </ButtonLink>
        {permissions.print ? (
          <CommandButton
            command="print.request"
            input={{ targetType: "accession", targetId: item.accession.id, kind: "requisition_label", purpose: "initial" }}
            size="sm"
            pendingLabel="Queuing..."
            // Honest outcome: a queued job on an unavailable printer, or a prevented duplicate, is not "sent".
            successToast={(r: PrintOutcome) => (r.printerUnavailable || r.outcome === "duplicate_prevented" ? null : `${r.displayId}: ${r.stateLabel} (simulated printer). ${r.message}`)}
            onSuccess={(r: PrintOutcome) => {
              if (r.printerUnavailable) toast.show({ tone: "warning", title: `Printer unavailable: ${r.displayId} queued, not printed`, body: `${r.message} Track it in Materials > Print jobs.` });
              else if (r.outcome === "duplicate_prevented") toast.show({ tone: "info", title: "Duplicate prevented", body: r.message });
            }}
          >
            Print sticker (simulated)
          </CommandButton>
        ) : null}
        <span aria-hidden className="h-5 w-px shrink-0 bg-line max-xl:hidden" />
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <AccessionChip accession={item.accession.number} namespace={item.accession.namespace} compact />
          <SimulatedLabel connector="EMA-SIM" size="xs">
            Issued by EMA-SIM (simulated)
          </SimulatedLabel>
          <span className="text-xs text-ink-secondary">
            <Timestamp iso={item.accession.issuedAt} now={now} /> · provisional <span className="id-mono">{item.displayId}</span> stays on record
          </span>
        </div>
      </div>
    );
  }

  const group = item.readiness.group;
  const ids = group ? group.ids : [item.id];
  const blockers = group ? group.blockers : item.readiness.blockers;
  const pending = item.latestRequest?.status === "submitted";
  const label = group
    ? `${pending ? "Retry accession request" : "Request accession"} for ${group.displayIds.join(" + ")} together (simulated source)`
    : `${pending ? `Retry accession request ${item.latestRequest!.displayId}` : "Request accession"} (simulated source)`;
  const reason = !permissions.requestAccession
    ? "Your demo role cannot request an accession."
    : !source.available
      ? "Source system unreachable (simulated outage). Your verification is saved locally. Request the accession when the source is back."
      : null;
  const disabled = !!reason || blockers.length > 0;
  const reasonId = `acc-reason-${item.id}`;

  return (
    <div className="sticky bottom-0 z-10 rounded-t-md border border-line bg-surface px-3 py-2 shadow-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <div data-intake-step={disabled ? undefined : "accession"}>
          <Button
            variant="primary"
            loading={req.pending}
            loadingLabel="Requesting..."
            disabled={disabled}
            reasonId={disabled ? reasonId : undefined}
            onClick={() => void req.run({ intakeItemIds: ids, relatedCandidateId: group?.candidateId ?? null })}
          >
            {label}
          </Button>
        </div>
        <SimulatedLabel connector="EMA-SIM accession" size="xs" />
        <div className="min-w-[14rem] flex-1">
          {reason ? (
            <p id={reasonId} className="text-xs text-ink-secondary">
              {reason}
            </p>
          ) : blockers.length ? (
            <BlockerList blockers={blockers} id={reasonId} itemDisplay={item.displayId} />
          ) : (
            <p className="text-xs text-success-fg">Ready: every check passed. The number is issued by the simulated source, never typed here.</p>
          )}
          {group ? (
            <p className="text-xs text-ink-secondary">
              One accession approved in related-order review{" "}
              <span className="id-mono text-ink">{item.related.find((r) => r.id === group.candidateId)?.displayId ?? "REL"}</span>; parts keep their original
              orders and designations.
            </p>
          ) : null}
        </div>
      </div>
      {pending ? (
        <p className="mt-1 text-xs text-warning-fg">
          Request {item.latestRequest!.displayId} was submitted at <Timestamp iso={item.latestRequest!.requestedAt} now={now} /> and nothing was issued
          {item.latestRequest!.failureDetail ? ` (${item.latestRequest!.failureDetail})` : ""}. Retrying uses the same request; no duplicate is created.
        </p>
      ) : null}
      <CommandError error={req.error} className="mt-1" />
    </div>
  );
}
