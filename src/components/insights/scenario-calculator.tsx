"use client";

import { useId, useMemo, useState, type ChangeEvent } from "react";
import { Calculator, Info, RotateCcw } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Field, Input } from "@/components/ui/field";
import { Button } from "@/components/ui/button";
import { AlertBanner } from "@/components/ui/alert-banner";
import { IllustrativeTag } from "@/components/domain/honesty";
import { BLANK_INPUTS, ILLUSTRATIVE_EXAMPLE, SIGNED_KEYS, computeScenario, type ScenarioInputs, type ScenarioKey, type ScenarioPoint } from "./scenario-math";

/**
 * Editable scenario calculator (master spec §14, pilot-proposal §7–§8).
 * Starts BLANK. "Load illustrative example" fills clearly labeled example
 * minutes and volumes only (never a labor rate or a cost). Shows the formula
 * with the inputs, a low (central) high range, and keeps labor time, waiting
 * time, recovered capacity and cash savings separate. A zero or negative net
 * is reported as it is. The arithmetic lives in ./scenario-math (unit-tested).
 */

const QUOTE_COSTS = [
  "Vendor software or subscription fees (including any ModMed module, configuration or interface fees)",
  "Hardware: printers, scanners, workstations or tablets, headsets",
  "Consumables: label stock, ribbons, compatible slides and cassettes",
  "Integration work: vendor, ModMed and internal IT",
  "Maintenance and support: contracts, internal IT, development",
  "Training, including backfill time",
  "Local validation: staff time and materials",
  "Hosting and security review",
];

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const num1 = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });
const num0 = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

const signedHours = (h: number) => `${h < 0 ? "−" : ""}${num0.format(Math.abs(h))}`;
const signedUsd = (v: number) => `${v < 0 ? "−" : ""}${usd.format(Math.abs(v))}`;
const signedMin = (m: number) => `${m < 0 ? "−" : ""}${num1.format(Math.abs(m))}`;

export function ScenarioCalculator() {
  const [v, setV] = useState<ScenarioInputs>(BLANK_INPUTS);
  const [example, setExample] = useState(false);
  const resultId = useId();

  const set = (k: ScenarioKey) => (e: ChangeEvent<HTMLInputElement>) => {
    setV((prev) => ({ ...prev, [k]: e.target.value }));
  };

  const p = useMemo(() => computeScenario(v), [v]);

  const field = (k: ScenarioKey, label: string, opts: { unit?: string; hint?: string; required?: boolean } = {}) => (
    <Field label={label} unit={opts.unit} hint={opts.hint} required={opts.required} error={p.errors[k]}>
      <Input
        type="number"
        inputMode="decimal"
        min={SIGNED_KEYS.has(k) ? undefined : 0}
        step="any"
        value={v[k]}
        onChange={set(k)}
        size="sm"
        className="num-tabular"
      />
    </Field>
  );
  const formulaText = p.ready
    ? [
        "Net minutes saved per case    = (B − P) − (V + A)",
        "Annual net hours              = net minutes × N × D ÷ 60",
        "Potential annual labor value  = annual net hours × R",
        "Potential net annual value    = labor value − C",
        "",
        ...([["Low", p.low], ["Central", p.central], ["High", p.high]] as const).flatMap(([name, pt]) =>
          pt
            ? [
                `${`${name}:`.padEnd(9)}(${signedMin(pt.savedMin)} − ${num1.format(p.values.added ?? 0)}) × ${num1.format(p.values.units ?? 0)} × ${num0.format(
                  p.values.days ?? 0,
                )} ÷ 60 = ${signedHours(pt.annualHours)} h`,
              ]
            : [],
        ),
      ].join("\n")
    : "";
  const ranged = (f: (pt: ScenarioPoint) => string) =>
    p.ready ? (p.central ? `${f(p.low)} (low), ${f(p.central)} (central), ${f(p.high)} (high)` : `${f(p.low)} to ${f(p.high)}`) : "";

  return (
    <Card
      id="scenario-calculator"
      title={
        <span className="flex flex-wrap items-center gap-2">
          <Calculator className="size-4 text-ink-muted" aria-hidden />
          <span>Scenario calculator</span>
          <IllustrativeTag className="font-medium tracking-normal">A worksheet, not a measurement or a forecast</IllustrativeTag>
        </span>
      }
      description="Inputs start blank. Use measured values from a baseline and a shadow comparison, and a labor cost agreed with finance. This worksheet handles one activity at a time (here: per case). Repeat it for parts, 100 labels or blocks and add the results; never count the same minutes twice."
      actions={
        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setV(ILLUSTRATIVE_EXAMPLE);
              setExample(true);
            }}
          >
            Load illustrative example
          </Button>
          <Button
            variant="quiet"
            size="sm"
            icon={<RotateCcw className="size-4" aria-hidden />}
            onClick={() => {
              setV(BLANK_INPUTS);
              setExample(false);
            }}
          >
            Clear inputs
          </Button>
        </div>
      }
    >
      {example ? (
        <AlertBanner tone="info" title="Illustrative example values are loaded">
          These minutes and volumes only show how the arithmetic works (they echo the worked example in the pilot proposal and the size of the synthetic demo day). They
          are not measurements and not a prediction. The labor cost and quoted costs stay blank: no money figure is shown until finance and vendors provide them.
        </AlertBanner>
      ) : null}

      <div className={example ? "mt-4 grid gap-6 xl:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]" : "grid gap-6 xl:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]"}>
        <fieldset className="grid content-start gap-3">
          <legend className="mb-1 text-sm font-semibold text-ink">Inputs</legend>
          <div role="group" aria-labelledby={`${resultId}-saved`} className="grid gap-1.5">
            <p id={`${resultId}-saved`} className="text-sm font-medium text-ink">
              Measured minutes saved per case (B − P, baseline minus pilot)
            </p>
            <div className="grid grid-cols-3 items-end gap-3">
              {field("savedLow", "Low", { unit: "min", required: true })}
              {field("savedCentral", "Central (optional)", { unit: "min" })}
              {field("savedHigh", "High", { unit: "min", required: true })}
            </div>
            <p className="text-xs text-ink-muted">Can be zero or negative if the shadow comparison shows the pilot is slower; enter it as measured.</p>
          </div>
          {field("added", "Added verification and admin minutes per case (V + A)", {
            unit: "min",
            required: true,
            hint: "From the balancing measures: checks and reconciliation the companion adds.",
          })}
          <div className="grid grid-cols-2 items-end gap-3">
            {field("units", "Observed cases per day (N)", { required: true })}
            {field("days", "Working days per year (D)", { required: true })}
          </div>
          {field("rate", "Loaded labor cost per hour, agreed with finance (R)", { unit: "USD", hint: "Leave blank until finance provides it." })}
          {field("costs", "Annualized costs from quotes (C)", { unit: "USD per year", hint: "Leave blank until vendor quotes and internal estimates exist." })}
        </fieldset>

        <section aria-labelledby={`${resultId}-h`} aria-live="polite" className="min-w-0 xl:border-l xl:border-line xl:pl-6">
          <h3 id={`${resultId}-h`} className="mb-2 flex items-center gap-2 text-sm font-semibold text-ink">
            Results {example ? <IllustrativeTag>Illustrative example</IllustrativeTag> : null}
          </h3>
          {!p.ready ? (
            <p className="rounded-md border border-dashed border-line-strong px-3 py-2.5 text-sm text-ink-secondary">
              {Object.keys(p.errors).length
                ? "Fix the highlighted inputs to see results."
                : `Enter the required inputs to see results (${p.missing.length} still blank). Nothing is assumed for a blank input.`}
            </p>
          ) : (
            <div className="flex animate-swap-in flex-col gap-3 text-sm">
              <figure className="m-0 rounded-md bg-surface-subtle px-3 py-2.5">
                <figcaption className="font-medium text-ink">Formula, with these inputs</figcaption>
                <pre className="mt-1 overflow-x-auto font-mono text-xs leading-5 whitespace-pre-wrap text-ink-secondary">
{formulaText}
                </pre>
              </figure>

              <dl className="divide-y divide-line border-y border-line">
                <ResultRow
                  label="Labor time saved (potential, not cash)"
                  value={`${ranged((pt) => signedHours(pt.annualHours))} hours per year`}
                  note={
                    p.high.netMin <= 0
                      ? `Across the whole range the added checks use up the saving or exceed it (net ${signedMin(p.low.netMin)} to ${signedMin(p.high.netMin)} min per case): the companion would add time. This is reported as it is.`
                      : p.low.netMin <= 0
                        ? `At the low end the added checks use up the saving (net ${signedMin(p.low.netMin)} min per case). This is reported as it is.`
                        : `Net ${signedMin(p.low.netMin)} to ${signedMin(p.high.netMin)} minutes per case after subtracting added checks.`
                  }
                />
                <ResultRow
                  label="Potential annual labor value"
                  value={p.rate === null ? null : `${ranged((pt) => signedUsd(pt.laborValue ?? 0))} per year`}
                  unknown="needs a loaded labor cost agreed with finance (R)"
                  note="Potential value of staff time. It stays potential until spending actually changes."
                />
                <ResultRow
                  label="Potential net annual value"
                  value={p.rate === null || p.costs === null ? null : `${ranged((pt) => signedUsd(pt.netValue ?? 0))} per year`}
                  unknown={p.costs === null ? "costs require vendor quotes and internal estimates (C is blank)" : "needs a labor cost (R)"}
                />
                <ResultRow
                  label="Elapsed waiting time reduced"
                  value={null}
                  unknown="not computed here"
                  note="Measured separately (clarification and source-entry delays above). Waiting time is never multiplied by a labor rate."
                />
                <ResultRow
                  label="Recovered capacity"
                  value={null}
                  unknown="not computed"
                  note="Counted only when saved minutes are documented as redirected to other work."
                />
                <ResultRow
                  label="Actual cash savings"
                  value={null}
                  unknown="requires finance confirmation"
                  note="Only a real change in spending (for example, fewer paid overtime hours in payroll records). Minutes counted here are not counted again as labor value."
                />
              </dl>
            </div>
          )}

          <div className="mt-4">
            <h4 className="text-sm font-semibold text-ink">Costs that require quotes or internal estimates</h4>
            <ul className="mt-1 grid text-sm text-ink-secondary sm:grid-cols-2 sm:gap-x-6">
              {QUOTE_COSTS.map((c) => (
                <li key={c} className="flex items-start justify-between gap-3 border-b border-line py-1.5">
                  <span>{c}</span>
                  <span className="shrink-0 text-ink-muted">Quote required</span>
                </li>
              ))}
            </ul>
          </div>
          <p className="mt-4 flex max-w-[90ch] items-start gap-2 text-sm text-ink">
            <Info className="mt-0.5 size-4 shrink-0 text-info-solid" aria-hidden />
            <span>
              A short pilot cannot establish a reduction in rare patient-harm events, such as a misidentified specimen: they are too infrequent to measure reliably in weeks
              or months. A pilot would track near misses, verification burden and unintended delays instead, and makes no claim of harm prevention.
            </span>
          </p>
        </section>
      </div>
    </Card>
  );
}

function ResultRow({ label, value, unknown, note }: { label: string; value: string | null; unknown?: string; note?: string }) {
  return (
    <div className="grid gap-x-4 gap-y-0.5 py-2 sm:grid-cols-[minmax(11rem,15rem)_minmax(0,1fr)]">
      <dt className="text-ink-secondary">{label}</dt>
      <dd>
        {value ? (
          <span className="font-semibold text-ink">{value}</span>
        ) : (
          <span className="text-ink-muted">Not shown: {unknown}</span>
        )}
        {note ? <span className="mt-0.5 block text-xs text-ink-muted">{note}</span> : null}
      </dd>
    </div>
  );
}
