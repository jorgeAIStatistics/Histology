"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { FileLock2, TriangleAlert } from "lucide-react";
import { api, ApiError, errorText } from "@/lib/api";
import { useApi } from "@/lib/useApi";
import { humanize, slideTitle } from "@/lib/format";
import type { DatasetSummary, DatasetVersion, FreezeCheck } from "@/lib/types";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Checkbox, TextField } from "@/components/ui/Field";
import { Loading } from "@/components/ui/Notice";
import { useToast } from "@/components/ui/Toaster";

function SlideLink({ id, check }: { id: string; check: FreezeCheck }) {
  const s = check.slides[id];
  return (
    <Link href={`/review/${id}`} className="font-semibold text-teal-deep underline underline-offset-2">
      {s ? `${s.accession_code ?? "Unassigned"}, ${slideTitle(s)}` : id.slice(0, 8)}
    </Link>
  );
}

/**
 * Freezing is permanent. Before it, the dialog asks the API what would be locked in that a person should look at
 * first: open quality issues a person raised or confirmed, and near-duplicates split across train/val/test with no
 * human decision. Either can be resolved first, or acknowledged with a reason; the API then writes both the list and
 * the reason into the immutable manifest.
 */
export function FreezeDialog({
  open,
  onClose,
  dv,
  summary,
  onFrozen,
}: {
  open: boolean;
  onClose: () => void;
  dv: DatasetVersion | null;
  summary: DatasetSummary | null;
  onFrozen: () => Promise<void>;
}) {
  const toast = useToast();
  const check = useApi<FreezeCheck>(open && dv?.status === "draft" ? `/datasets/${dv.id}/freeze-check` : null);
  const [reason, setReason] = useState("");
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setReason("");
      setAck(false);
      setError(null);
    }
  }, [open]);

  const c = check.data;
  const needsAck = Boolean(c?.requires_acknowledgement);
  const issueCount = c ? c.open_qc_issues.reduce((n, w) => n + w.open_issues.length, 0) : 0;
  const dupCount = c ? c.unreviewed_near_duplicates.length : 0;
  const unavailable = !c
    ? "Checking for open items first."
    : needsAck && !ack
      ? "Resolve the open items first, or tick “Freeze anyway and record these items in the manifest”."
      : needsAck && !reason.trim()
        ? "Give a reason. It is written into the manifest with the open items."
        : null;

  const freeze = async () => {
    if (!dv) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/datasets/${dv.id}/freeze`, {
        method: "POST",
        body: needsAck ? { reason: reason.trim(), acknowledge_warnings: true } : { reason: reason.trim() || null },
      });
      toast.show({
        tone: "success",
        title: "Frozen",
        body: needsAck
          ? `The manifest is immutable and records ${issueCount + dupCount} acknowledged open item${issueCount + dupCount === 1 ? "" : "s"} with your reason. The test split is locked.`
          : "The manifest is immutable. The test split is locked away from training and tuning.",
      });
      onClose();
      await onFrozen();
    } catch (err) {
      if (err instanceof ApiError && err.code === "freeze_warnings_unacknowledged") {
        setAck(false);
        await check.reload();
        setError("New open items appeared since this dialog opened. They are listed below; nothing was frozen.");
      } else {
        setError(`Not frozen: ${errorText(err)}`);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={dv ? `Freeze ${dv.name} v${dv.version}?` : "Freeze"}
      testId="freeze-dialog"
      wide={needsAck}
      description="Freezing is permanent. The manifest records the exact image hashes, label versions, split assignments and configuration. If a label changes later, create a new version; this one never changes."
      footer={
        <>
          <Button onClick={onClose}>Keep as draft</Button>
          <Button variant="primary" icon={<FileLock2 size={15} aria-hidden />} busy={busy} unavailable={unavailable} data-testid="freeze-confirm" onClick={freeze}>
            Freeze permanently
          </Button>
        </>
      }
    >
      {summary ? (
        <ul className="space-y-1 text-small">
          <li>
            <strong>{summary.counts.patients}</strong> coded patients, <strong>{summary.counts.cases}</strong> cases, <strong>{summary.counts.blocks}</strong> blocks,{" "}
            <strong>{summary.counts.slides}</strong> slides
          </li>
          <li>
            Splits: {summary.splits.partition ?? "not assigned"};{" "}
            {Object.entries(summary.splits.per_split)
              .map(([k, v]) => `${k} ${v.patients} patient${v.patients === 1 ? "" : "s"}, ${v.slides} slide${v.slides === 1 ? "" : "s"}`)
              .join("; ")}
          </li>
          <li>{summary.exclusions.count} slides excluded, each with its reasons</li>
        </ul>
      ) : null}

      {error ? (
        <p role="alert" className="mt-4 rounded-[var(--radius-control)] border border-rust/50 bg-rust-tint px-3 py-2 text-small font-semibold text-rust" data-testid="freeze-error">
          {error}
        </p>
      ) : null}

      {!c && !check.error ? <Loading label="Checking for open quality issues and near-duplicates" /> : null}
      {check.error ? <p className="mt-4 text-small text-rust">Could not check for open items: {errorText(check.error)}</p> : null}

      {c && !needsAck ? (
        <p className="mt-4 text-small text-approved" data-testid="freeze-clear">
          No open quality issues on included slides, and no unreviewed near-duplicates across splits.
        </p>
      ) : null}

      {c && needsAck ? (
        <section aria-labelledby="freeze-open-items" className="mt-4 rounded-[var(--radius-panel)] border border-amber bg-amber-tint/50 p-4" data-testid="freeze-warnings">
          <h3 id="freeze-open-items" className="flex items-center gap-2 font-bold text-ink">
            <TriangleAlert size={17} aria-hidden className="shrink-0 text-amber-ink" />
            {issueCount + dupCount} open item{issueCount + dupCount === 1 ? "" : "s"} would be frozen into this version
          </h3>
          <p className="mt-1 text-small text-ink">
            Resolving them first is the better path. If they do not affect this research set, you can freeze anyway: the list below and your reason are
            written into the manifest, where anyone using this version will see them.
          </p>
          {c.open_qc_issues.length ? (
            <>
              <h4 className="mt-3 text-small font-bold text-ink">Open quality issues on included slides</h4>
              <ul className="mt-1 space-y-1 text-small">
                {c.open_qc_issues.map((w) => (
                  <li key={w.slide_id}>
                    <SlideLink id={w.slide_id} check={c} />: {w.open_issues.map((i) => `${humanize(i.category)} (${humanize(i.status)})`).join(", ")}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          {c.unreviewed_near_duplicates.length ? (
            <>
              <h4 className="mt-3 text-small font-bold text-ink">Near-duplicates in different splits, not yet reviewed</h4>
              <ul className="mt-1 space-y-1 text-small">
                {c.unreviewed_near_duplicates.map((d) => (
                  <li key={`${d.slide_a}:${d.slide_b}`}>
                    <SlideLink id={d.slide_a} check={c} /> and <SlideLink id={d.slide_b} check={c} />: Hamming distance {d.dhash_distance}, possible leakage
                    between splits
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          <Checkbox
            className="mt-4"
            label="Freeze anyway and record these items in the manifest"
            hint="Your name, the items and the reason are part of what is hashed."
            checked={ack}
            onChange={(e) => setAck(e.target.checked)}
            data-testid="freeze-acknowledge"
          />
        </section>
      ) : null}

      <TextField
        className="mt-4"
        label={needsAck ? "Reason" : "Reason (optional)"}
        required={needsAck}
        hint={needsAck ? "Written into the manifest with the open items, for example why a fold does not affect this study." : undefined}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        data-testid="freeze-reason"
      />
    </Dialog>
  );
}
