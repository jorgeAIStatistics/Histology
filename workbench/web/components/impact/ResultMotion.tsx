"use client";

import { useEffect, useRef, useState } from "react";
import { animate, LazyMotion, domAnimation, m, useReducedMotion } from "motion/react";
import type { RoiResult } from "@/lib/roi";
import { cn } from "@/components/ui/cn";

/**
 * The visible number glides to its new value when an input changes, so the eye sees which way it moved. It is
 * aria-hidden: the exact value sits in a sibling element for screen readers and tests, so neither ever reads an
 * in-between figure.
 */
export function AnimatedFigure({ value, format, className }: { value: number; format: (n: number) => string; className?: string }) {
  const reduced = useReducedMotion();
  const ref = useRef<HTMLSpanElement>(null);
  const shown = useRef(value);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const from = shown.current;
    if (reduced || from === value || !Number.isFinite(from) || !Number.isFinite(value)) {
      shown.current = value;
      el.textContent = format(value);
      return;
    }
    const controls = animate(from, value, {
      duration: 0.45,
      ease: [0.2, 0.7, 0.2, 1],
      onUpdate: (v) => {
        shown.current = v;
        el.textContent = format(v);
      },
    });
    return () => controls.stop();
  }, [value, reduced, format]);
  return (
    <span ref={ref} aria-hidden className={className}>
      {format(value)}
    </span>
  );
}

type Row = { key: string; label: string; value: number; tone: "gain" | "cost" | "net" };

/** Where the annual net comes from: the same arithmetic as the lines below, drawn to one scale. */
export function Composition({ r, format }: { r: RoiResult; format: (n: number) => string }) {
  const reduced = useReducedMotion();
  const rows: Row[] = [
    { key: "labour", label: "Labour savings counted as cash", value: r.realizedLaborSavings, tone: "gain" },
    { key: "rework", label: "Avoided rework", value: r.avoidedReworkCost, tone: "gain" },
    { key: "costs", label: "Recurring costs", value: -r.recurringIncrementalCosts, tone: "cost" },
    { key: "net", label: "Annual net", value: r.annualNetCashBenefit, tone: "net" },
  ];
  const max = Math.max(1, ...rows.map((x) => Math.abs(x.value)));
  // Bars grow once the result first scrolls into view, then follow every change.
  const [seen, setSeen] = useState(false);
  return (
    <LazyMotion features={domAnimation} strict>
      <m.div aria-hidden className="mt-4 space-y-1.5" onViewportEnter={() => setSeen(true)} viewport={{ once: true, amount: 0.6 }} data-testid="roi-composition">
        <p className="text-micro font-semibold text-graphite">Where the annual figure comes from</p>
        {rows.map((row) => {
          const frac = seen ? Math.abs(row.value) / max : 0;
          const negative = row.value < 0;
          return (
            <div key={row.key} className={cn("grid grid-cols-[minmax(0,1fr)_88px] items-center gap-x-3", row.tone === "net" && "border-t border-line pt-1.5")}>
              <div className="min-w-0">
                <p className={cn("truncate text-micro", row.tone === "net" ? "font-bold text-ink" : "text-graphite")}>{row.label}</p>
                <div className="mt-0.5 h-2 overflow-hidden rounded-full bg-paraffin">
                  <m.div
                    className={cn(
                      "h-full origin-left rounded-full",
                      row.tone === "gain" && "bg-teal",
                      row.tone === "cost" && "bg-rust/80",
                      row.tone === "net" && (negative ? "bg-rust" : "bg-approved"),
                    )}
                    initial={false}
                    animate={{ scaleX: frac }}
                    transition={reduced ? { duration: 0 } : { duration: 0.5, ease: [0.2, 0.7, 0.2, 1] }}
                  />
                </div>
              </div>
              <span className={cn("tabular text-right text-micro font-semibold", negative ? "text-rust" : "text-ink")}>{format(row.value)}</span>
            </div>
          );
        })}
      </m.div>
    </LazyMotion>
  );
}

const SECTIONS = [
  { id: "contrib", label: "What could change" },
  { id: "roi", label: "Calculator" },
  { id: "biz", label: "Business model" },
];

/** In-page sections; the one being read is marked as the page scrolls. */
export function SectionNav() {
  const [active, setActive] = useState(SECTIONS[0].id);
  useEffect(() => {
    const els = SECTIONS.map((s) => document.getElementById(s.id)?.closest("section")).filter(Boolean) as HTMLElement[];
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            const h = e.target.querySelector("h2");
            if (h?.id) setActive(h.id);
          }
        }
      },
      { rootMargin: "-30% 0px -60% 0px" },
    );
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);
  return (
    <nav aria-label="On this page" className="sticky top-[var(--wb-header-h,56px)] z-30 -mx-4 border-b border-line bg-paraffin/95 px-4 backdrop-blur-sm md:-mx-6 md:px-6 xl:-mx-8 xl:px-8">
      <ul className="flex gap-1 overflow-x-auto">
        {SECTIONS.map((s) => (
          <li key={s.id}>
            <a
              href={`#${s.id}`}
              aria-current={active === s.id ? "location" : undefined}
              className={cn(
                "relative flex h-11 items-center whitespace-nowrap px-2.5 text-small font-semibold transition-colors duration-200",
                active === s.id ? "text-ink" : "text-graphite hover:text-ink",
              )}
            >
              {s.label}
              <span
                aria-hidden
                className={cn("absolute inset-x-2.5 bottom-0 h-[2px] origin-left bg-teal transition-transform duration-300 ease-out", active === s.id ? "scale-x-100" : "scale-x-0")}
              />
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
