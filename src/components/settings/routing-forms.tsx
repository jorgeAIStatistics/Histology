"use client";

import { useState } from "react";
import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CommandError } from "@/components/ui/command-button";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Field, Select, Textarea } from "@/components/ui/field";
import { useCommand, fieldErrors } from "@/lib/client/command";
import { useCan } from "@/lib/client/shell-context";
import { fmtDateTime } from "@/lib/time";
import { EtDateTime, etParts, etToIso, ReasonCommandButton } from "./form-bits";

interface OfficeOpt {
  id: string;
  name: string;
  current: string | null;
}
interface PathOpt {
  id: string;
  name: string;
}

const NO_RULE = "__none__";

/** Draft a new routing rule version: copies the approved rules and applies these changes. */
export function DraftRuleSetForm({
  offices,
  pathologists,
  nextVersion,
  baseVersion,
  initialOfficeId,
}: {
  offices: OfficeOpt[];
  pathologists: PathOpt[];
  nextVersion: number;
  baseVersion: number | null;
  initialOfficeId?: string | null;
}) {
  const can = useCan("routing.editRules");
  const [changes, setChanges] = useState<{ officeId: string; pathologistId: string }[]>([
    { officeId: initialOfficeId && offices.some((o) => o.id === initialOfficeId) ? initialOfficeId : "", pathologistId: "" },
  ]);
  const [reason, setReason] = useState("");
  const cmd = useCommand<{ version: number; changes: string[] }, unknown>("routing.draftRuleSet", {
    successToast: (r) => `Draft v${r.version} created. It is not in effect until a permitted role approves it.`,
    errorToast: false,
  });
  const errs = fieldErrors(cmd.error);
  const used = new Set(changes.map((c) => c.officeId));
  const incomplete = changes.some((c) => !c.officeId || !c.pathologistId) || reason.trim().length < 3;

  return (
    <form
      id="draft"
      className="grid gap-3"
      onSubmit={async (e) => {
        e.preventDefault();
        const out = await cmd.run({
          reason: reason.trim(),
          changes: changes.map((c) => ({ officeId: c.officeId, pathologistId: c.pathologistId === NO_RULE ? null : c.pathologistId })),
        });
        if (out.ok) {
          setChanges([{ officeId: "", pathologistId: "" }]);
          setReason("");
        }
      }}
    >
      <p className="text-sm text-ink-secondary">
        Creates draft <span className="id-mono">v{nextVersion}</span> by copying {baseVersion ? <>approved <span className="id-mono">v{baseVersion}</span></> : "the latest approved rules"} and applying the
        changes below. Nothing changes for new items until the draft is approved.
      </p>
      <fieldset className="grid gap-2" disabled={!can.allowed}>
        <legend className="mb-1 text-sm font-medium text-ink">Changes</legend>
        {changes.map((c, i) => {
          return (
            <div key={i} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-end gap-2">
              <Field label={`Office ${i + 1}`} required>
                <Select
                  size="sm"
                  value={c.officeId}
                  onChange={(e) => setChanges((prev) => prev.map((x, j) => (j === i ? { ...x, officeId: e.target.value } : x)))}
                >
                  <option value="">Choose an office…</option>
                  {offices.map((o) => (
                    <option key={o.id} value={o.id} disabled={used.has(o.id) && o.id !== c.officeId}>
                      {o.name} — {o.current ? `now ${o.current}` : "no rule"}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Assign to" required>
                <Select
                  size="sm"
                  value={c.pathologistId}
                  onChange={(e) => setChanges((prev) => prev.map((x, j) => (j === i ? { ...x, pathologistId: e.target.value } : x)))}
                >
                  <option value="">Choose…</option>
                  {pathologists.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                  <option value={NO_RULE}>No rule: send new items to the routing exception lane</option>
                </Select>
              </Field>
              <Button
                size="sm"
                variant="quiet"
                icon={<X />}
                aria-label={`Remove change ${i + 1}`}
                disabled={changes.length === 1}
                onClick={() => setChanges((prev) => prev.filter((_, j) => j !== i))}
              >
                Remove
              </Button>
            </div>
          );
        })}
        <div>
          <Button size="sm" variant="ghost" icon={<Plus />} onClick={() => setChanges((prev) => [...prev, { officeId: "", pathologistId: "" }])}>
            Add another office
          </Button>
        </div>
      </fieldset>
      <Field label="Reason for the change" required error={errs.reason} hint="Recorded with the draft and in the audit history.">
        <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} disabled={!can.allowed} />
      </Field>
      <div className="flex flex-wrap items-start gap-3">
        <Button type="submit" variant="primary" loading={cmd.pending} loadingLabel="Creating draft..." disabled={!can.allowed || incomplete}>
          Create draft v{nextVersion}
        </Button>
        {!can.allowed ? <p className="max-w-[48ch] text-xs text-ink-secondary">{can.reason ?? "Only the operations supervisor can draft routing changes."} The server checks this role on every request.</p> : null}
      </div>
      <CommandError error={cmd.error} />
    </form>
  );
}

/** Approve (MD or supervisor) or discard (supervisor) the open draft. */
export function DraftDecision({ ruleSetId, version, currentVersion, now }: { ruleSetId: string; version: number; currentVersion: number | null; now: string }) {
  const canApprove = useCan("routing.approveRules");
  const canDiscard = useCan("routing.editRules");
  const [when, setWhen] = useState(() => etParts(now));
  const [confirming, setConfirming] = useState(false);
  const approve = useCommand<{ version: number; effectiveFrom: string; retired: number[] }, unknown>("routing.approveRuleSet", {
    successToast: (r) => `Routing rules v${r.version} approved, effective ${fmtDateTime(r.effectiveFrom)} ET. Rules are now frozen.`,
    errorToast: false,
  });
  const iso = etToIso(when.day, when.time);
  const nowParts = etParts(now);
  const isNow = when.day === nowParts.day && when.time === nowParts.time;
  return (
    <div className="grid gap-3">
      <EtDateTime
        label="Effective from"
        value={when}
        onChange={setWhen}
        required
        disabled={!canApprove.allowed}
        hint="Defaults to now on the demo clock. Work already received is not re-routed. A future time keeps the current version in effect until then."
        error={!iso ? "Enter a valid date and time." : null}
      />
      <div className="flex flex-wrap items-start gap-3">
        <div className="flex flex-col items-start gap-1">
          <Button variant="primary" disabled={!canApprove.allowed || !iso} onClick={() => setConfirming(true)}>
            Approve v{version}
          </Button>
          {!canApprove.allowed ? <p className="max-w-[40ch] text-xs text-ink-secondary">{canApprove.reason ?? "Only the medical director or the operations supervisor can approve."}</p> : null}
        </div>
        <ReasonCommandButton
          command="routing.discardDraft"
          input={{ ruleSetId }}
          label={`Discard draft v${version}`}
          title={`Discard draft routing rules v${version}?`}
          body="The draft is kept in the version history as discarded (never approved). The approved rules stay in effect."
          confirmLabel="Discard draft"
          cancelLabel="Keep draft"
          destructive
          disabledReason={canDiscard.allowed ? null : canDiscard.reason ?? "Only the operations supervisor can discard a draft."}
          successToast={`Draft v${version} discarded.`}
        />
      </div>
      <CommandError error={approve.error} />
      <ConfirmDialog
        open={confirming}
        title={`Approve routing rules v${version}?`}
        confirmLabel={`Approve v${version}`}
        cancelLabel="Keep as draft"
        pending={approve.pending}
        pendingLabel="Approving..."
        onCancel={() => setConfirming(false)}
        onConfirm={async () => {
          await approve.run({ ruleSetId, ...(isNow || !iso ? {} : { effectiveFrom: iso }) });
          setConfirming(false);
        }}
      >
        <p>
          Approved rules are frozen; any later change needs a new version.
          {currentVersion ? (
            <>
              {" "}
              Version <span className="id-mono">v{currentVersion}</span> stops applying at {isNow ? "the time of approval" : `${when.time} ET on ${when.day}`}.
            </>
          ) : null}{" "}
          Items already received keep their routing.
        </p>
      </ConfirmDialog>
    </div>
  );
}

/** Add an approved coverage exception (MD or supervisor). */
export function CoverageForm({ pathologists, now }: { pathologists: PathOpt[]; now: string }) {
  const can = useCan("routing.approveRules");
  const start = etParts(now);
  const [absent, setAbsent] = useState("");
  const [cover, setCover] = useState("");
  const [from, setFrom] = useState({ day: start.day, time: "00:00" });
  const [to, setTo] = useState({ day: start.day, time: "23:59" });
  const [reason, setReason] = useState("");
  const cmd = useCommand("routing.addCoverage", { successToast: "Coverage exception added.", errorToast: false });
  const fromIso = etToIso(from.day, from.time);
  const toIso = etToIso(to.day, to.time);
  const order = fromIso && toIso && Date.parse(toIso) <= Date.parse(fromIso) ? "Must end after it starts." : null;
  const ready = absent && cover && absent !== cover && fromIso && toIso && !order && reason.trim().length >= 3;
  return (
    <form
      className="grid gap-3"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!ready) return;
        const out = await cmd.run({ pathologistId: absent, coveringPathologistId: cover, startsAt: fromIso, endsAt: toIso, reason: reason.trim() });
        if (out.ok) setReason("");
      }}
    >
      <fieldset className="grid gap-3" disabled={!can.allowed}>
        <div className="grid grid-cols-2 items-start gap-3">
          <Field label="Absent" required>
            <Select size="sm" value={absent} onChange={(e) => setAbsent(e.target.value)}>
              <option value="">Choose a dermatopathologist…</option>
              {pathologists.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Covering" required error={absent && cover && absent === cover ? "Choose a different dermatopathologist." : undefined}>
            <Select size="sm" value={cover} onChange={(e) => setCover(e.target.value)}>
              <option value="">Choose a dermatopathologist…</option>
              {pathologists.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <EtDateTime label="From" value={from} onChange={setFrom} required />
          <EtDateTime label="Until" value={to} onChange={setTo} required error={order} />
        </div>
        <Field label="Reason" required>
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} />
        </Field>
      </fieldset>
      <div className="flex flex-wrap items-start gap-3">
        <Button type="submit" disabled={!can.allowed || !ready} loading={cmd.pending} loadingLabel="Adding...">
          Add coverage exception
        </Button>
        {!can.allowed ? <p className="max-w-[48ch] text-xs text-ink-secondary">{can.reason ?? "Only the medical director or the operations supervisor can add coverage."}</p> : null}
      </div>
      <CommandError error={cmd.error} />
    </form>
  );
}

export function RetireCoverageButton({ coverageId, label }: { coverageId: string; label: string }) {
  const can = useCan("routing.approveRules");
  // Hidden for roles that cannot retire coverage: the card footer names who can, and the server checks anyway.
  if (!can.allowed) return null;
  return (
    <ReasonCommandButton
      command="routing.retireCoverage"
      input={{ coverageId }}
      label="Retire"
      title={`Retire coverage: ${label}?`}
      body="The record is kept as retired. New items are routed by the approved rules without this coverage."
      confirmLabel="Retire coverage"
      cancelLabel="Keep coverage"
      variant="quiet"
      successToast="Coverage exception retired."
    />
  );
}
