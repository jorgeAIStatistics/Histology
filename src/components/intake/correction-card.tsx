"use client";

import { useState } from "react";
import type { ItemDetail, BenchPermissions } from "@/server/queries/intake";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { CommandError } from "@/components/ui/command-button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Select, Textarea } from "@/components/ui/field";
import { StatusPill } from "@/components/ui/status-pill";
import { AccessionChip, IdChip } from "@/components/domain/chips";
import { Timestamp } from "@/components/domain/timestamp";
import { useCommand } from "@/lib/client/command";
import { useUnsavedChanges } from "@/lib/client/unsaved";

const KINDS = [
  { value: "site_discrepancy", label: "Site or laterality discrepancy" },
  { value: "identity_discrepancy", label: "Patient identity discrepancy" },
  { value: "possible_duplicate_case", label: "Possible duplicate case" },
  { value: "part_designation", label: "Part designation question" },
  { value: "related_case", label: "Related case (cross-reference)" },
];

const OUTCOMES = [
  { value: "referred_to_source_process", label: "Refer to the source system's correction process" },
  { value: "closed_no_change", label: "Close: no change needed" },
  { value: "closed_corrected_in_source", label: "Close: corrected in the source system" },
];

/**
 * Post-accession discrepancies: a correction review keeps every original
 * reference. The app never renumbers, merges or relabels; any correction is
 * made in the authoritative system through its own authorized process.
 */
export function CorrectionCard({ item, permissions, now }: { item: ItemDetail; permissions: BenchPermissions; now: string }) {
  const [opening, setOpening] = useState(false);
  const [closing, setClosing] = useState<ItemDetail["corrections"][number] | null>(null);
  if (!item.accession) return null;
  return (
    <Card
      id="corrections"
      headingLevel={3}
      title="Discrepancy after accessioning"
      description="Opens a correction review with a snapshot of the original references. Nothing is renumbered, merged or relabeled here."
      actions={
        permissions.openCorrection ? (
          <Button size="sm" variant="secondary" onClick={() => setOpening(true)}>
            Open correction review
          </Button>
        ) : null
      }
      bodyClassName="space-y-2"
    >
      {item.corrections.length ? (
        <ul className="space-y-2 text-sm">
          {item.corrections.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center gap-2">
              <IdChip kind="OTHER" id={c.displayId} />
              <StatusPill tone={c.status === "open" ? "warning" : c.status === "referred_to_source_process" ? "info" : "success"}>{c.statusLabel}</StatusPill>
              <span className="text-ink-secondary">{c.kindLabel}</span>
              <span className="min-w-0 flex-1 text-ink">{c.description}</span>
              <span className="text-xs text-ink-muted">
                <Timestamp iso={c.requestedAt} now={now} />
              </span>
              {permissions.closeCorrection && (c.status === "open" || c.status === "referred_to_source_process") ? (
                <Button size="sm" variant="quiet" onClick={() => setClosing(c)}>
                  Record outcome
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-ink-secondary">No correction reviews for this case.</p>
      )}
      {opening ? <OpenDialog item={item} onClose={() => setOpening(false)} /> : null}
      {closing ? <CloseDialog item={item} correction={closing} onClose={() => setClosing(null)} /> : null}
    </Card>
  );
}

function OpenDialog({ item, onClose }: { item: ItemDetail; onClose: () => void }) {
  const [kind, setKind] = useState("site_discrepancy");
  const [description, setDescription] = useState("");
  useUnsavedChanges(description.trim().length > 0, `correction review for ${item.accession?.number}`);
  const cmd = useCommand<{ displayId: string; duplicate: boolean }, unknown>("correction.open", {
    successToast: (r) => (r.duplicate ? `${r.displayId} is already open for this case. No duplicate was created.` : `Correction review ${r.displayId} opened. Identifiers unchanged.`),
    errorToast: false,
    onSuccess: () => onClose(),
  });
  return (
    <Dialog
      open
      onClose={onClose}
      title="Open correction review"
      description="Records the discrepancy and snapshots the accession number, parts, source orders and printed labels as they are now."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Keep without a review
          </Button>
          <Button
            variant="primary"
            loading={cmd.pending}
            loadingLabel="Opening..."
            disabled={!description.trim()}
            onClick={() => void cmd.run({ accessionId: item.accession!.id, kind, description: description.trim() })}
          >
            Open correction review
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="flex items-center gap-2 rounded-md border border-line bg-surface-subtle px-3 py-2 text-sm">
          <AccessionChip accession={item.accession!.number} namespace={item.accession!.namespace} href={false} />
        </div>
        <Field label="Kind of discrepancy" required>
          <Select value={kind} onChange={(e) => setKind(e.target.value)}>
            {KINDS.map((k) => (
              <option key={k.value} value={k.value}>
                {k.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="What was found" required>
          <Textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <CommandError error={cmd.error} />
      </div>
    </Dialog>
  );
}

function CloseDialog({ item, correction, onClose }: { item: ItemDetail; correction: ItemDetail["corrections"][number]; onClose: () => void }) {
  const [outcome, setOutcome] = useState("referred_to_source_process");
  const [note, setNote] = useState("");
  const cmd = useCommand<unknown, unknown>("correction.close", { successToast: "Outcome recorded. Identifiers unchanged.", errorToast: false, onSuccess: () => onClose() });
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Record outcome: ${correction.displayId}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Keep open
          </Button>
          <Button
            variant="primary"
            loading={cmd.pending}
            loadingLabel="Recording..."
            disabled={!note.trim()}
            onClick={() => void cmd.run({ correctionId: correction.id, outcome, note: note.trim(), expectedVersion: correction.version })}
          >
            Record outcome
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="flex items-center gap-2 text-sm">
          <AccessionChip accession={item.accession!.number} href={false} compact />
          <IdChip kind="OTHER" id={correction.displayId} />
        </div>
        <Field label="Outcome" required hint="This app cannot make the correction itself. Referring creates a task to use the authorized source-system process.">
          <Select value={outcome} onChange={(e) => setOutcome(e.target.value)}>
            {OUTCOMES.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Note" required>
          <Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
        <CommandError error={cmd.error} />
      </div>
    </Dialog>
  );
}
