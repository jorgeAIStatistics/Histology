"use client";

import { cn } from "@/lib/cn";
import { AlertBanner } from "@/components/ui/alert-banner";
import { IdText } from "@/components/domain/id-text";
import { COPY_GUARD, SPEAKER_NOTES } from "./content";
import { usePresenterLarge } from "./demo-toolbar";

/** "0:25" for 25 seconds: a presenter's running time. */
const clock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

/**
 * Speaker notes (~5 minutes): one short paragraph per step plus opening and closing, set as a script on
 * one sheet. Each part reads its running time on the left (start to end, and its length), the words on the right.
 */
export function SpeakerNotes() {
  const large = usePresenterLarge();
  const total = SPEAKER_NOTES.reduce((a, n) => a + n.seconds, 0);
  const starts = SPEAKER_NOTES.reduce<number[]>((acc, n, i) => [...acc, i === 0 ? 0 : acc[i - 1] + SPEAKER_NOTES[i - 1].seconds], []);
  return (
    <section aria-labelledby="notes-title" className="grid grid-cols-1 gap-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id="notes-title" className="text-lg font-bold tracking-[-0.01em] text-ink">
          Speaker notes
        </h2>
        <p className="text-sm text-ink-muted">
          About {Math.floor(total / 60)} min {String(total % 60).padStart(2, "0")} s spoken. Plain language; adjust to your own words.
        </p>
      </div>
      <AlertBanner tone="info" title="Say this at the start">
        No director, physician, lab or vendor has endorsed, approved or partnered on this. {COPY_GUARD}
      </AlertBanner>
      <ol className="divide-y divide-line rounded-lg border border-line bg-surface">
        {SPEAKER_NOTES.map((n, i) => {
          const start = starts[i];
          const end = start + n.seconds;
          return (
            <li key={n.heading} className="grid gap-x-6 gap-y-1 px-4 py-3 md:grid-cols-[8.5rem_minmax(0,1fr)]">
              <p className="text-sm text-ink-muted md:pt-0.5">
                <span className="num-tabular font-semibold text-ink-secondary">
                  {clock(start)} to {clock(end)}
                </span>
                <span className="block">About {n.seconds} s</span>
              </p>
              <div className="min-w-0">
                <h3 className={cn("font-semibold text-ink", large ? "text-lg" : "text-base")}>{n.heading}</h3>
                <p className={cn("mt-0.5 max-w-[80ch] text-ink", large ? "text-lg leading-8" : "text-base")}>
                  <IdText text={n.text} />
                </p>
              </div>
            </li>
          );
        })}
      </ol>
      <p className="text-sm text-ink-muted">{COPY_GUARD}</p>
    </section>
  );
}
