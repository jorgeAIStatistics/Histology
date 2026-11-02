"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Info, Mic } from "lucide-react";
import { cn } from "@/lib/cn";
import type { GrossFields } from "@/lib/gross";
import { Button, DisabledReason } from "@/components/ui/button";
import { AlertBanner } from "@/components/ui/alert-banner";
import { CommandError } from "@/components/ui/command-button";
import { Field, Select } from "@/components/ui/field";
import { SimulatedLabel } from "@/components/domain/honesty";
import { Timestamp } from "@/components/domain/timestamp";
import type { CommandFailure } from "@/lib/client/command";
import { FIELD_LABEL, FIELD_ORDER, type FieldKey, type StoredField } from "./model";

export interface TranscriptView {
  id: string;
  text: string;
  fixtureKey: string | null;
  title: string | null;
  capturedBy: string | null;
  capturedAt: string;
  ignored: { text: string; start: number; end: number }[];
}

interface SpanInfo {
  start: number;
  end: number;
  key: FieldKey | "ignored";
  status: string;
}

/** Highlight treatments on the severity ladder: waiting on the grosser (neutral), data may be wrong (amber), done (quiet). */
const MARK = {
  waiting: "bg-surface-sunken underline decoration-ink-muted decoration-dashed decoration-1 underline-offset-[5px]",
  amber: "bg-warning-bg underline decoration-warning-solid decoration-2 underline-offset-[5px]",
  quiet: "bg-transparent underline decoration-ink-muted decoration-1 underline-offset-[5px]",
  ignored: "border border-dashed border-sim-border bg-sim-bg line-through decoration-ink-muted",
} as const;

/**
 * Evidence sheet: the synthetic dictation, set as text to read. Each highlight
 * is the exact text a proposed value came from; selecting it moves to the
 * field. Original text and structured values stay distinguishable, and
 * instruction-like sentences are shown only as quoted data.
 */
export function TranscriptPane({
  transcript,
  fields,
  activeField,
  reveal,
  onSelectField,
  assistantMode,
  options,
  frozen,
  attachDisabledReason,
  onAttach,
  attaching,
  attachError,
  now,
  extractedWithoutText = false,
  className,
}: {
  transcript: TranscriptView | null;
  fields: GrossFields | null;
  activeField: FieldKey | null;
  /** Bumped when the operator asks to see a field's evidence: scrolls the highlight into view. */
  reveal?: { key: FieldKey; n: number } | null;
  onSelectField: (key: FieldKey) => void;
  assistantMode: "deterministic" | "unavailable";
  options: { key: string; title: string; purpose: string }[];
  frozen: boolean;
  attachDisabledReason: string | null;
  onAttach: (key: string) => void;
  attaching: boolean;
  attachError: CommandFailure | null;
  now: string;
  /** The record has extracted proposals but no stored transcript (seeded drafts). */
  extractedWithoutText?: boolean;
  className?: string;
}) {
  const [choice, setChoice] = useState<string>(() =>
    transcript?.fixtureKey && options.some((o) => o.key === transcript.fixtureKey) ? transcript.fixtureKey : (options[0]?.key ?? ""),
  );
  const chosen = options.find((o) => o.key === choice) ?? null;

  const segments = useMemo(() => {
    if (!transcript) return [];
    const text = transcript.text;
    const spans: SpanInfo[] = [];
    if (fields) {
      for (const k of FIELD_ORDER) {
        const f = fields[k] as StoredField;
        const e = f?.evidence;
        if (!e || e.source !== "transcript" || e.end <= e.start || text.slice(e.start, e.end) !== e.text) continue;
        spans.push({ start: e.start, end: e.end, key: k, status: f.status });
      }
    }
    for (const i of transcript.ignored) spans.push({ start: i.start, end: i.end, key: "ignored", status: "ignored" });
    const cuts = [...new Set([0, text.length, ...spans.flatMap((s) => [s.start, s.end])])].sort((a, b) => a - b);
    const out: { from: number; to: number; covering: SpanInfo[] }[] = [];
    for (let i = 0; i < cuts.length - 1; i++) {
      const from = cuts[i];
      const to = cuts[i + 1];
      if (to <= from) continue;
      out.push({ from, to, covering: spans.filter((s) => s.start <= from && s.end >= to).sort((a, b) => a.end - a.start - (b.end - b.start)) });
    }
    return out;
  }, [transcript, fields]);

  const quoteRef = useRef<HTMLQuoteElement | null>(null);
  useEffect(() => {
    if (!reveal || !quoteRef.current) return;
    const mark = [...quoteRef.current.querySelectorAll<HTMLElement>("mark[data-fields]")].find((m) => (m.dataset.fields ?? "").split(" ").includes(reveal.key));
    mark?.scrollIntoView({ block: "nearest", behavior: "auto" });
  }, [reveal]);

  const reasonId = "transcript-attach-reason";
  const micReasonId = "transcript-mic-reason";

  const unavailable = assistantMode === "unavailable";
  /** Values were already confirmed without a stored dictation: attaching one is an exception, so it stays collapsed. */
  const anyConfirmed = fields ? FIELD_ORDER.some((k) => (fields[k] as StoredField | undefined)?.status === "confirmed") : false;

  const controls = (
    <div className="flex flex-col gap-2">
      <Field label={transcript ? "Replace with another synthetic dictation" : "Synthetic dictation"} hint={chosen?.purpose}>
        <Select value={choice} onChange={(e) => setChoice(e.target.value)} disabled={unavailable || options.length === 0} size="sm">
          {options.map((o) => (
            <option key={o.key} value={o.key}>
              {o.title}
            </option>
          ))}
        </Select>
      </Field>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="secondary"
          size="sm"
          loading={attaching}
          loadingLabel="Extracting..."
          disabled={unavailable || !choice || Boolean(attachDisabledReason)}
          reasonId={unavailable || attachDisabledReason ? reasonId : undefined}
          onClick={() => onAttach(choice)}
        >
          {transcript ? "Replace transcript and re-extract" : "Attach transcript and extract"}
        </Button>
        <Button variant="quiet" size="sm" icon={<Mic />} disabled reasonId={micReasonId}>
          Dictate
        </Button>
      </div>
      {unavailable || attachDisabledReason ? (
        <DisabledReason id={reasonId}>{unavailable ? "Extraction not available. Enter values manually." : attachDisabledReason}</DisabledReason>
      ) : null}
      <DisabledReason id={micReasonId}>Microphone input: not configured in this demo.</DisabledReason>
      {transcript ? <p className="text-sm text-ink-muted">Replacing proposes new values for unconfirmed fields only. Confirmed values are kept.</p> : null}
    </div>
  );

  return (
    <section aria-labelledby="gross-dictation-title" className={cn("flex min-w-0 flex-col rounded-lg border border-line bg-surface", className)}>
      <header className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1 border-b border-line px-4 py-3 max-xl:px-3">
        <div className="min-w-0">
          <h2 id="gross-dictation-title" className="text-md font-semibold tracking-[-0.01em] text-ink">
            Dictation
          </h2>
          <p className="text-sm text-ink-muted">Synthetic transcript. Extraction is a deterministic demo.</p>
        </div>
        <SimulatedLabel connector="dictation fixture" />
      </header>

      <div className="flex min-h-0 flex-col gap-3 px-4 py-3 max-xl:px-3">
        {unavailable ? (
          <AlertBanner tone="info" title="Extraction not available. Enter values manually.">
            The extraction assistant is set to Unavailable (Settings). Every field stays editable and approval works the same way.
          </AlertBanner>
        ) : null}

        {transcript ? (
          <div className="flex flex-col gap-2">
            <p className="text-sm text-ink-secondary">
              <span className="font-medium text-ink">{transcript.title ?? "Synthetic dictation"}</span>. Attached by {transcript.capturedBy ?? "Unknown"} at{" "}
              <Timestamp iso={transcript.capturedAt} now={now} />. No audio in this demo.
            </p>
            {transcript.ignored.length ? (
              <AlertBanner tone="warning" title="Instruction-like text was treated as dictation data">
                {transcript.ignored.map((i) => `"${i.text}"`).join(" ")} changed nothing: no value was confirmed, no role or approval changed. Only an operator can confirm
                and approve.
              </AlertBanner>
            ) : null}
            <blockquote ref={quoteRef} className="text-md leading-8 text-ink" aria-label="Transcript text with evidence highlights">
              {segments.map((seg) => {
                const text = transcript.text.slice(seg.from, seg.to);
                if (!seg.covering.length) return <span key={seg.from}>{text}</span>;
                const ignored = seg.covering.some((c) => c.key === "ignored");
                const fieldSpans = seg.covering.filter((c) => c.key !== "ignored");
                const target = fieldSpans[0]?.key as FieldKey | undefined;
                const active = activeField !== null && fieldSpans.some((c) => c.key === activeField);
                const tone = fieldSpans.some((c) => c.status === "needs_review" || c.status === "missing")
                  ? "amber"
                  : fieldSpans.every((c) => c.status === "confirmed")
                    ? "quiet"
                    : "waiting";
                const labels = fieldSpans.map((c) => FIELD_LABEL[c.key as FieldKey]).join(", ");
                return (
                  <mark
                    key={seg.from}
                    data-fields={fieldSpans.map((c) => c.key).join(" ")}
                    title={ignored ? "Instruction-like text: treated as dictation data and ignored" : `Evidence for: ${labels}`}
                    onClick={target ? () => onSelectField(target) : undefined}
                    className={cn(
                      "rounded-sm px-px text-ink [box-decoration-break:clone]",
                      ignored ? MARK.ignored : MARK[tone],
                      target && "cursor-pointer",
                      active && "outline outline-2 outline-offset-1 outline-focus",
                    )}
                  >
                    {text}
                  </mark>
                );
              })}
            </blockquote>
            <ul className="flex flex-wrap gap-x-4 gap-y-1.5 border-t border-line pt-2 text-sm text-ink-secondary" aria-label="Highlight legend">
              <LegendItem mark={MARK.waiting}>Proposed, waiting for you</LegendItem>
              <LegendItem mark={MARK.amber}>Needs review or missing</LegendItem>
              <LegendItem mark={MARK.quiet}>Confirmed</LegendItem>
              {transcript.ignored.length ? <LegendItem mark={MARK.ignored}>Instruction-like text, ignored</LegendItem> : null}
            </ul>
          </div>
        ) : (
          <p className="text-base text-ink-secondary">
            {extractedWithoutText ? (
              "The dictation text for this seeded draft is not stored in this demo. The values proposed from it, and their review notes, are shown in the fields."
            ) : frozen ? (
              "No dictation is stored with this version. Its values were entered and confirmed in the fields."
            ) : (
              <>No transcript attached. {unavailable ? "Type the values in the fields." : "Attach a synthetic dictation to get proposed values, or type the values in the fields."}</>
            )}
          </p>
        )}

        {!frozen && attachDisabledReason && !unavailable ? (
          <p className="flex items-start gap-1.5 border-t border-line pt-3 text-sm text-ink-secondary">
            <Info className="mt-0.5 size-4 shrink-0 text-ink-muted" aria-hidden />
            <span>{attachDisabledReason}</span>
          </p>
        ) : !frozen ? (
          transcript || anyConfirmed ? (
            <div className="flex flex-col gap-2 border-t border-line pt-3">
              <details>
                <summary className="flex min-h-[var(--hlo-target-min)] cursor-pointer items-center text-sm font-semibold text-brand">
                  {transcript ? "Replace the dictation…" : "Attach a synthetic dictation…"}
                </summary>
                <div className="mt-2">{controls}</div>
              </details>
              <CommandError error={attachError} />
            </div>
          ) : (
            <div className="flex flex-col gap-2 border-t border-line pt-3">
              {controls}
              <CommandError error={attachError} />
            </div>
          )
        ) : (
          <p className="border-t border-line pt-3 text-sm text-ink-muted">This version is frozen. Amend to attach a different dictation.</p>
        )}
      </div>
    </section>
  );
}

/** A legend entry drawn with the same mark as the transcript, on a short sample. */
function LegendItem({ mark, children }: { mark: string; children: string }) {
  return (
    <li className="flex items-center gap-1.5">
      <span aria-hidden className={cn("rounded-sm px-1 leading-5 text-ink", mark)}>
        Aa
      </span>
      {children}
    </li>
  );
}
