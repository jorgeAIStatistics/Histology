"use client";

import { cn } from "@/lib/cn";
import { COPY_GUARD, SPEAKER_NOTES } from "./content";
import { usePresenterLarge } from "./demo-toolbar";

/** Speaker notes (~5 minutes): one short paragraph per step plus opening and closing. */
export function SpeakerNotes() {
  const large = usePresenterLarge();
  const total = SPEAKER_NOTES.reduce((a, n) => a + n.seconds, 0);
  const mmss = (s: number) => `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, "0")} s`;
  let elapsed = 0;
  return (
    <section aria-labelledby="notes-title" className="grid gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="notes-title" className="text-md font-semibold text-ink">
          Speaker notes
        </h2>
        <p className="text-sm text-ink-muted">About {mmss(total)} spoken. Plain language; adjust to your own words.</p>
      </div>
      <p className="rounded-md border-l-4 border-info-solid bg-info-bg px-3 py-2 text-sm text-info-fg">
        Say this at the start: no director, physician, lab or vendor has endorsed, approved or partnered on this. {COPY_GUARD}
      </p>
      <ol className="grid gap-2">
        {SPEAKER_NOTES.map((n) => {
          const start = elapsed;
          elapsed += n.seconds;
          return (
            <li key={n.heading} className="rounded-md border border-line bg-surface p-3 shadow-1">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h3 className={cn("font-semibold text-ink", large ? "text-lg" : "text-sm")}>{n.heading}</h3>
                <span className="num-tabular text-xs text-ink-muted">
                  {mmss(start)} to {mmss(elapsed)} · about {n.seconds} s
                </span>
              </div>
              <p className={cn("mt-1 max-w-[90ch] text-ink", large ? "text-lg leading-8" : "text-sm")}>{n.text}</p>
            </li>
          );
        })}
      </ol>
      <p className="text-xs text-ink-muted">{COPY_GUARD}</p>
    </section>
  );
}
