"use client";

import { useState } from "react";
import Link from "next/link";
import { Route } from "lucide-react";
import type { ItemDetail, BenchPermissions, RoutingView } from "@/server/queries/intake";
import { Button } from "@/components/ui/button";
import { CommandError } from "@/components/ui/command-button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Select, Textarea } from "@/components/ui/field";
import { StatusPill } from "@/components/ui/status-pill";
import { DoctorChip } from "@/components/domain/doctor-chip";
import { ProvisionalChip } from "@/components/domain/chips";
import { Timestamp } from "@/components/domain/timestamp";
import { useCommand } from "@/lib/client/command";
import { useUnsavedChanges } from "@/lib/client/unsaved";
import { fmtDate } from "@/lib/time";
import { RecordSection, useBackToScan } from "./bits";

/** A routing exception waits for a person (neutral rung, owner named); it is not a disagreement between sources. */
function routingPill(r: RoutingView, owner: string | null) {
  if (r.status === "exception") return <StatusPill tone="neutral" className="text-sm">{owner ? `Needs routing: ${owner}` : "Needs routing"}</StatusPill>;
  if (r.status === "overridden") return <StatusPill tone="info" className="text-sm">{r.suggested ? "Overridden" : "Exception resolved"}</StatusPill>;
  if (r.status === "confirmed") return <StatusPill tone="neutral" className="text-sm">Rule applied · confirmed</StatusPill>;
  return <StatusPill tone="neutral" className="text-sm">Rule applied · suggested</StatusPill>;
}

export function RoutingSection({
  item,
  permissions,
  pathologists,
  readOnly,
  now,
}: {
  item: ItemDetail;
  permissions: BenchPermissions;
  pathologists: { id: string; name: string; shortName: string; color: string | null }[];
  readOnly: boolean;
  now: string;
}) {
  const [dialog, setDialog] = useState<"override" | null>(null);
  const r = item.routing;
  const accessioned = item.status === "accessioned" || item.status === "canceled";
  if (!r) {
    return (
      <RecordSection id="routing" title="Routing to an assigned dermatopathologist">
        <p className="text-sm text-ink-secondary">No routing decision recorded for this item.</p>
      </RecordSection>
    );
  }
  const exception = r.status === "exception";
  const assigned = r.final ?? (r.status === "suggested" ? r.suggested : null);
  return (
    <RecordSection
      id="routing"
      title={
        <span className="inline-flex flex-wrap items-center gap-2">
          <Route className="size-4 text-ink-muted" aria-hidden />
          Routing to an assigned dermatopathologist
          {routingPill(r, item.tasks.find((t) => t.kind === "routing_exception")?.ownerName ?? null)}
        </span>
      }
    >
      <div className="space-y-2">
        {exception ? (
          <p className="flex items-start gap-1.5 text-sm text-ink">
            <span className="font-semibold">Routing exception: no approved rule applies.</span> {r.explanation.replace(/^Routing exception:\s*/i, "")}
          </p>
        ) : null}
        {!item.office && !accessioned ? (
          <p className="text-sm text-ink-secondary">
            &ldquo;{item.observedOfficeText ?? "Unknown"}&rdquo; is not in the office directory, so no source tenant could be searched for the order. Assigning a dermatopathologist records routing only: accession stays blocked until the office is known and the order is linked.
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-sm">
          <div className="flex items-center gap-2">
            <span className="text-ink-muted">{r.status === "suggested" ? "Suggested dermatopathologist" : "Assigned dermatopathologist"}</span>
            {exception ? <DoctorChip name={null} /> : <DoctorChip name={assigned?.name ?? null} color={assigned?.color} />}
          </div>
          {r.ruleSetVersion ? (
            <span className="text-ink-secondary">
              Rule set v{r.ruleSetVersion}
              {r.ruleSetEffectiveFrom ? `, effective ${fmtDate(r.ruleSetEffectiveFrom)}` : ""}
            </span>
          ) : null}
          {r.coverage ? <StatusPill tone="info" className="text-sm">Coverage exception applied</StatusPill> : null}
        </div>
        {!exception ? <p className="text-sm text-ink">{r.explanation}</p> : null}
        {r.status === "overridden" && r.suggested ? (
          <p className="text-sm text-ink-secondary">
            Rule suggestion kept on record: <DoctorChip name={r.suggested.name} color={r.suggested.color} compact />
          </p>
        ) : null}
        {r.overrideReason ? <p className="text-sm text-ink-secondary">Reason: {r.overrideReason}</p> : null}
        {r.decidedAt ? (
          <p className="text-sm text-ink-muted">
            Decided by {r.decidedByName ?? "Unknown"} at <Timestamp iso={r.decidedAt} now={now} />
          </p>
        ) : null}
        {!accessioned ? (
          exception ? (
            permissions.resolveException && !readOnly ? (
              <p className="text-sm text-ink-secondary">Assigning a dermatopathologist is your next step in the decision column. It records routing for this item only; it creates no rule.</p>
            ) : (
              <p className="max-w-[70ch] text-sm text-ink-secondary">
                Only the accessioning lead or the operations supervisor can assign a dermatopathologist to a routing exception, with a reason. A new office needs an approved rule in{" "}
                <Link className="text-brand underline-offset-2 hover:underline" href="/settings">
                  Settings
                </Link>
                .
              </p>
            )
          ) : permissions.override && !readOnly ? (
            <Button size="sm" variant="secondary" onClick={() => setDialog("override")}>
              Override routing
            </Button>
          ) : (
            <p className="text-sm text-ink-secondary">
              {r.status === "suggested" ? "Accepting the suggestion is done from the decision column. " : ""}Override: accessioning lead or supervisor only, with a reason.
            </p>
          )
        ) : null}
        {item.routingHistory.length ? (
          <details className="text-sm">
            <summary className="cursor-pointer text-ink-secondary">Earlier routing decisions ({item.routingHistory.length})</summary>
            <ul className="mt-2 space-y-1.5">
              {item.routingHistory.map((h) => (
                <li key={h.id} className="rounded-sm bg-surface-subtle px-2 py-1.5">
                  <span className="text-ink-muted">
                    <Timestamp iso={h.createdAt} now={now} /> · superseded ·{" "}
                  </span>
                  {h.explanation}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </div>
      {dialog ? <RoutingDialog mode={dialog} item={item} current={assigned?.id ?? null} pathologists={pathologists} onClose={() => setDialog(null)} /> : null}
    </RecordSection>
  );
}

export function RoutingDialog({
  mode,
  item,
  current,
  pathologists,
  onClose,
}: {
  mode: "override" | "resolve";
  item: ItemDetail;
  current: string | null;
  pathologists: { id: string; name: string }[];
  onClose: () => void;
}) {
  const choices = pathologists.filter((p) => p.id !== current);
  const [pathologistId, setPathologistId] = useState(choices[0]?.id ?? "");
  const [reason, setReason] = useState("");
  useUnsavedChanges(reason.trim().length > 0, `routing ${mode} for ${item.displayId}`);
  const backToScan = useBackToScan();
  const cmd = useCommand<unknown, { intakeItemId: string; pathologistId: string; reason: string }>(mode === "override" ? "routing.override" : "routing.resolveException", {
    successToast: mode === "override" ? "Routing overridden. The rule suggestion stays on record." : "Routing exception resolved",
    errorToast: false,
    onSuccess: () => {
      onClose();
      backToScan();
    },
  });
  return (
    <Dialog
      open
      onClose={onClose}
      title={mode === "override" ? "Override routing" : "Resolve routing exception"}
      description={
        mode === "override"
          ? "Choose a different assigned dermatopathologist for this item only. The rule and its suggestion stay on record."
          : "Assign a dermatopathologist for this item only. This does not create a routing rule; a new rule set needs separate approval in Settings."
      }
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Keep current routing
          </Button>
          <Button
            variant="primary"
            loading={cmd.pending}
            loadingLabel="Saving..."
            disabled={!pathologistId || !reason.trim()}
            onClick={() => void cmd.run({ intakeItemId: item.id, pathologistId, reason: reason.trim() })}
          >
            {mode === "override" ? "Override routing" : "Assign dermatopathologist"}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="flex items-center gap-2 rounded-md border border-line bg-surface-subtle px-3 py-2 text-sm">
          <ProvisionalChip id={item.displayId} href={false} />
          <span>{item.office?.name ?? item.observedOfficeText ?? "Unknown office"}</span>
        </div>
        <Field label="Assigned dermatopathologist" required>
          <Select value={pathologistId} onChange={(e) => setPathologistId(e.target.value)}>
            {choices.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Reason" required hint="Recorded with your name in the audit trail.">
          <Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
        <CommandError error={cmd.error} />
      </div>
    </Dialog>
  );
}
