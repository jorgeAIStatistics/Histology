"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { FileAudio, Mic } from "lucide-react";
import { cn } from "@/lib/cn";
import type { GrossFields } from "@/lib/gross";
import { Button, DisabledReason } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
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

/**
 * Left pane: the synthetic dictation with evidence highlights. Each highlight
 * is the exact text a proposed value came from; selecting it moves to the
 * field. Original text and structured values stay distinguishable.
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
}) {
  const [choice, setChoice] = useState<string>(() => (transcript?.fixtureKey && options.some((o) => o.key === transcript.fixtureKey) ? transcript.fixtureKey : options[0]?.key ?? ""));
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
  const micReasonIdEarly = "transcript-mic-reason";

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
        <Button variant="quiet" size="sm" icon={<Mic />} disabled reasonId={micReasonIdEarly}>
          Dictate
        </Button>
      </div>
      {unavailable || attachDisabledReason ? (
        <DisabledReason id={reasonId}>{unavailable ? "Extraction not available. Enter values manually." : attachDisabledReason}</DisabledReason>
      ) : null}
      <DisabledReason id={micReasonIdEarly}>Microphone input: not configured in this demo.</DisabledReason>
      {transcript ? <p className="text-xs text-ink-muted">Replacing proposes new values for unconfirmed fields only. Confirmed values are kept.</p> : null}
    </div>
  );

  return (
    <Card
      title="Dictation transcript"
      description="Synthetic transcript. Extraction is a deterministic demo."
      actions={<SimulatedLabel connector="dictation fixture" />}
      className="flex min-w-0 flex-col"
      bodyClassName="flex flex-col gap-3"
    >
      {unavailable ? (
        <AlertBanner tone="info" title="Extraction not available. Enter values manually.">
          The extraction assistant is set to Unavailable (Settings). Every field stays editable and approval works the same way.
        </AlertBanner>
      ) : null}

      {transcript ? (
        <div>
          <div className="mb-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-muted">
            <FileAudio className="size-3.5" aria-hidden />
            <span>{transcript.title ?? "Synthetic dictation"}</span>
            <span aria-hidden>·</span>
            <span>
              Attached by {transcript.capturedBy ?? "Unknown"} at <Timestamp iso={transcript.capturedAt} now={now} />
            </span>
            <span aria-hidden>·</span>
            <span>No audio in this demo</span>
          </div>
          <blockquote
            ref={quoteRef}
            className="rounded-md border border-line bg-surface-subtle px-3 py-2.5 text-base leading-7 text-ink"
            aria-label="Transcript text with evidence highlights"
          >
            {segments.map((seg) => {
              const text = transcript.text.slice(seg.from, seg.to);
              if (!seg.covering.length) return <span key={seg.from}>{text}</span>;
              const ignored = seg.covering.some((c) => c.key === "ignored");
              const fieldSpans = seg.covering.filter((c) => c.key !== "ignored");
              const target = fieldSpans[0]?.key as FieldKey | undefined;
              const active = activeField !== null && fieldSpans.some((c) => c.key === activeField);
              const worst = fieldSpans.some((c) => c.status === "needs_review" || c.status === "missing")
                ? "warn"
                : fieldSpans.every((c) => c.status === "confirmed")
                  ? "ok"
                  : "proposed";
              const labels = fieldSpans.map((c) => FIELD_LABEL[c.key as FieldKey]).join(", ");
              return (
                <mark
                  key={seg.from}
                  data-fields={fieldSpans.map((c) => c.key).join(" ")}
                  title={ignored ? "Instruction-like text: treated as dictation data and ignored" : `Evidence for: ${labels}`}
                  onClick={target ? () => onSelectField(target) : undefined}
                  className={cn(
                    "rounded-sm px-px text-ink",
                    ignored
                      ? "border border-dashed border-sim-border bg-sim-bg line-through decoration-ink-muted"
                      : worst === "warn"
                        ? "border-b-2 border-warning-solid bg-warning-bg"
                        : worst === "ok"
                          ? "border-b-2 border-success-solid bg-success-bg"
                          : "border-b-2 border-dashed border-info-solid bg-info-bg",
                    target && "cursor-pointer",
                    active && "outline outline-2 outline-offset-1 outline-focus",
                  )}
                >
                  {text}
                </mark>
              );
            })}
          </blockquote>
          <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-muted" aria-label="Highlight legend">
            <li className="flex items-center gap-1"><span aria-hidden className="inline-block h-3 w-4 border-b-2 border-dashed border-info-solid bg-info-bg" /> Proposed, not confirmed</li>
            <li className="flex items-center gap-1"><span aria-hidden className="inline-block h-3 w-4 border-b-2 border-warning-solid bg-warning-bg" /> Needs review or missing</li>
            <li className="flex items-center gap-1"><span aria-hidden className="inline-block h-3 w-4 border-b-2 border-success-solid bg-success-bg" /> Confirmed by operator</li>
            {transcript.ignored.length ? (
              <li className="flex items-center gap-1"><span aria-hidden className="inline-block h-3 w-4 border border-dashed border-sim-border bg-sim-bg" /> Instruction-like text, ignored</li>
            ) : null}
          </ul>
          {transcript.ignored.length ? (
            <AlertBanner tone="warning" title="Instruction-like text was treated as dictation data" className="mt-2">
              {transcript.ignored.map((i) => `"${i.text}"`).join(" ")} changed nothing: no value was confirmed, no role or approval changed. Only an operator can confirm and approve.
            </AlertBanner>
          ) : null}
        </div>
      ) : (
        <p className="text-sm text-ink-secondary">
          {extractedWithoutText
            ? "The dictation text for this seeded draft is not stored in this demo. The values proposed from it, and their review notes, are shown in the fields."
            : <>No transcript attached. {unavailable ? "Type the values in the fields." : "Attach a synthetic dictation to get proposed values, or type the values in the fields."}</>}
        </p>
      )}

      {!frozen ? (
        transcript || anyConfirmed ? (
          <div className="flex flex-col gap-2 border-t border-line pt-3">
            <details>
              <summary className="cursor-pointer text-sm font-medium text-brand">{transcript ? "Replace the dictation…" : "Attach a synthetic dictation…"}</summary>
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
        <p className="border-t border-line pt-3 text-xs text-ink-muted">This version is frozen. Amend to attach a different dictation.</p>
      )}
    </Card>
  );
}
