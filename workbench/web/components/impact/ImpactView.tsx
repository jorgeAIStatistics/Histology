"use client";

import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { RotateCcw } from "lucide-react";
import { FICTIONAL_DEFAULTS, ILLUSTRATIVE_SUBSCRIPTIONS, arr, computeRoi, validateRoiInputs, valuation, type RoiInputs, type ScannerMode } from "@/lib/roi";
import { Button } from "@/components/ui/Button";
import { cn } from "@/components/ui/cn";
import { AnimatedFigure, Composition, SectionNav } from "./ResultMotion";

const STORE = "wb.roi.v1";
const usd0 = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const num1 = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });

export function money(n: number): string {
  if (!Number.isFinite(n)) return "n/a";
  const s = usd0.format(Math.abs(Math.round(n)));
  return Math.round(n) < 0 ? `−${s}` : s;
}

type NumKey = { [K in keyof RoiInputs]: RoiInputs[K] extends number ? K : never }[keyof RoiInputs];

function NumberInput({
  k,
  label,
  unit,
  value,
  onChange,
  percent = false,
  step,
  hint,
  error,
}: {
  k: NumKey;
  label: string;
  unit?: string;
  value: number;
  onChange: (k: NumKey, v: number) => void;
  percent?: boolean;
  step?: number;
  hint?: string;
  error?: string;
}) {
  const id = useId();
  const shown = percent ? Number((value * 100).toFixed(4)) : value;
  const [text, setText] = useState(String(shown));
  useEffect(() => {
    if (Number(text) !== shown) setText(String(shown));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown]);
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-small font-semibold text-ink">
        {label}
      </label>
      <div className={cn("flex h-10 items-center rounded-[var(--radius-control)] border bg-sheet focus-within:border-teal", error ? "border-rust" : "border-line-strong")}>
        {unit === "$" ? <span className="pl-2.5 text-graphite">$</span> : null}
        <input
          id={id}
          type="number"
          inputMode="decimal"
          step={step ?? (percent ? 0.1 : 1)}
          value={text}
          data-testid={`roi-${k}`}
          aria-invalid={error ? true : undefined}
          aria-describedby={hint || error ? `${id}-h` : undefined}
          onChange={(e) => {
            setText(e.target.value);
            const v = e.target.value === "" ? Number.NaN : Number(e.target.value);
            onChange(k, percent ? v / 100 : v);
          }}
          className="tabular h-full min-w-0 flex-1 bg-transparent px-2.5 text-body text-ink focus:outline-none"
        />
        {unit && unit !== "$" ? <span className="whitespace-nowrap pr-2.5 text-small text-graphite">{unit}</span> : null}
        {percent ? <span className="pr-2.5 text-small text-graphite">%</span> : null}
      </div>
      {hint || error ? (
        <p id={`${id}-h`} className={cn("text-micro", error ? "text-rust" : "text-graphite")}>
          {error ?? hint}
        </p>
      ) : null}
    </div>
  );
}

function Group({ title, note, children }: { title: string; note?: ReactNode; children: ReactNode }) {
  return (
    <fieldset className="rounded-[var(--radius-panel)] border border-line bg-surface p-4">
      <legend className="px-1 text-small font-bold text-ink">{title}</legend>
      {note ? <p className="-mt-1 mb-3 text-micro text-graphite">{note}</p> : null}
      <div className="grid gap-3 sm:grid-cols-2">{children}</div>
    </fieldset>
  );
}

function Line({ label, value, strong = false, sign, testId }: { label: ReactNode; value: number; strong?: boolean; sign?: "+" | "−"; testId?: string }) {
  return (
    <div className={cn("flex items-baseline justify-between gap-3 py-1.5", strong && "border-t border-line-strong pt-2")}>
      <dt className={cn("text-small", strong ? "font-bold text-ink" : "text-graphite")}>
        {sign ? <span className="mr-1 inline-block w-3 text-ink">{sign}</span> : null}
        {label}
      </dt>
      <dd className={cn("tabular text-right", strong ? "text-lead font-bold" : "text-small font-semibold text-ink", strong && value < 0 && "text-rust")} data-testid={testId}>
        {money(value)}
      </dd>
    </div>
  );
}

export function ImpactView() {
  const [inp, setInp] = useState<RoiInputs>(FICTIONAL_DEFAULTS);
  const [touched, setTouched] = useState(false);
  const [val, setVal] = useState<{ arr: string; multiple: string; cash: string; debt: string; ownership: string }>({ arr: "", multiple: "", cash: "", debt: "", ownership: "" });

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(STORE);
      if (raw) {
        setInp({ ...FICTIONAL_DEFAULTS, ...JSON.parse(raw) });
        setTouched(true);
      }
    } catch {
      /* per-viewer convenience only */
    }
  }, []);
  useEffect(() => {
    if (!touched) return;
    try {
      window.localStorage.setItem(STORE, JSON.stringify(inp));
    } catch {
      /* ignore */
    }
  }, [inp, touched]);

  const set = (k: NumKey, v: number) => {
    setTouched(true);
    setInp((p) => ({ ...p, [k]: v }));
  };
  const issues = useMemo(() => validateRoiInputs(inp), [inp]);
  const err = (k: keyof RoiInputs) => issues.find((x) => x.field === k)?.message;
  const r = useMemo(() => (issues.length ? null : computeRoi(inp)), [inp, issues]);
  const isDefault = JSON.stringify(inp) === JSON.stringify(FICTIONAL_DEFAULTS);

  const valuationOut = valuation({
    arr: val.arr === "" ? null : Number(val.arr),
    multiple: val.multiple === "" ? null : Number(val.multiple),
    cash: val.cash === "" ? null : Number(val.cash),
    debt: val.debt === "" ? null : Number(val.debt),
    ownership: val.ownership === "" ? null : Number(val.ownership) / 100,
  });

  return (
    <div className="mx-auto max-w-[1440px] px-4 pb-20 pt-6 md:px-6 xl:px-8">
      <header className="pb-5 pt-4">
        <h1 className="text-[clamp(2.1rem,1.4rem+1.6vw,2.9rem)] font-bold leading-[1.08] tracking-[-0.022em]">Impact</h1>
        <p className="mt-2 max-w-[72ch] text-lead text-graphite">
          What a pilot could change for the lab, what it would cost, and how to tell whether it is worth it. Nothing here is a measured result: patient
          outcomes, diagnostic accuracy and turnaround have not been studied, and none is claimed.
        </p>
      </header>
      <SectionNav />

      <section aria-labelledby="contrib" className="mt-6 grid gap-4 lg:grid-cols-2">
        <h2 id="contrib" className="sr-only scroll-mt-[calc(var(--wb-header-h,56px)+64px)]">
          Two connected contributions
        </h2>
        <article className="rounded-[var(--radius-panel)] border border-line bg-surface p-5">
          <p className="text-small font-semibold text-teal-deep">Histology</p>
          <h3 className="mt-1 text-title font-bold">See preparation and scan problems, and what was done about them</h3>
          <ul className="mt-3 list-disc space-y-1.5 pl-5 text-ink marker:text-line-strong">
            <li>Each fold, chatter line, stain problem or blur is recorded once, linked to the slide, the suggested action and the outcome.</li>
            <li>Fewer avoidable repeat handling steps, if issues are caught and resolved earlier: to be measured, not assumed.</li>
            <li>A traceable resolution for every issue, including whether the slide may be used for research.</li>
            <li>Any extra scanning or recording time for histology staff is counted as a cost below, not hidden.</li>
          </ul>
        </article>
        <article className="rounded-[var(--radius-panel)] border border-line bg-surface p-5">
          <p className="text-small font-semibold text-teal-deep">Pathology</p>
          <h3 className="mt-1 text-title font-bold">Efficient review, reusable cases and transparent evaluation</h3>
          <ul className="mt-3 list-disc space-y-1.5 pl-5 text-ink marker:text-line-strong">
            <li>Labelling and outlining with as little pathologist time as possible, with every judgement versioned.</li>
            <li>Approved cases become a reusable research set with patient-grouped splits.</li>
            <li>Results always show denominators, intervals and errors, never a lone headline score.</li>
            <li>A possible reduction in repetitive work, only if a reader study shows it: physician with the tool versus without it.</li>
          </ul>
        </article>
      </section>

      <section aria-labelledby="roi" className="mt-10">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 id="roi" className="scroll-mt-[calc(var(--wb-header-h,56px)+64px)] text-title font-bold">
              Live ROI calculator
            </h2>
            <p className="mt-1 max-w-[78ch] text-small text-graphite">Every input is editable. The result updates as you type, including when the pilot does not pay.</p>
          </div>
          <Button size="sm" icon={<RotateCcw size={14} aria-hidden />} onClick={() => setInp(FICTIONAL_DEFAULTS)} unavailable={isDefault ? "These are already the fictional defaults." : null} data-testid="roi-reset">
            Reset to fictional defaults
          </Button>
        </div>
        <div className="mt-3 flex items-start gap-3 rounded-[var(--radius-panel)] border-2 border-amber bg-amber-tint/70 px-4 py-3" role="note" data-testid="fictional-defaults">
          <span className="rounded-[3px] bg-amber px-1.5 py-0.5 text-micro font-bold text-ink">FICTIONAL</span>
          <p className="text-small text-ink">
            {isDefault ? "The values below are fictional defaults, " : "You have changed the fictional defaults. They were "}
            not measurements from any lab. Real inputs come from timing our own work before and during a pilot. No scanner and no digitised slides are assumed:
            scanning is costed as a service unless you change it.
          </p>
        </div>

        <div className="mt-4 grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_420px]">
          <div className="space-y-4">
            <Group title="Volume">
              <NumberInput k="casesPerDay" label="Cases per day" value={inp.casesPerDay} onChange={set} error={err("casesPerDay")} />
              <NumberInput k="slidesPerCase" label="Slides per case" value={inp.slidesPerCase} onChange={set} step={0.1} error={err("slidesPerCase")} />
              <NumberInput k="operatingDays" label="Operating days per year" value={inp.operatingDays} onChange={set} error={err("operatingDays")} />
            </Group>
            <Group title="Time released" note="Measured minutes, after any new scanning and annotation work is subtracted.">
              <NumberInput k="minutesSavedPerCase" label="Pathologist minutes saved per case" unit="min" step={0.1} value={inp.minutesSavedPerCase} onChange={set} error={err("minutesSavedPerCase")} />
              <NumberInput k="minutesSavedPerSlide" label="Technician minutes saved per slide" unit="min" step={0.1} value={inp.minutesSavedPerSlide} onChange={set} error={err("minutesSavedPerSlide")} />
              <NumberInput k="pathologistRate" label="Pathologist loaded rate" unit="$" value={inp.pathologistRate} onChange={set} hint="per hour, salary plus benefits and overhead" error={err("pathologistRate")} />
              <NumberInput k="technicianRate" label="Technician loaded rate" unit="$" value={inp.technicianRate} onChange={set} hint="per hour" error={err("technicianRate")} />
            </Group>
            <Group title="Repeat work (recuts, re-stains, rescans)">
              <NumberInput k="baselineRepeatRate" label="Baseline repeat rate" percent value={inp.baselineRepeatRate} onChange={set} hint="share of slides" error={err("baselineRepeatRate")} />
              <NumberInput k="projectedRepeatRate" label="Projected repeat rate" percent value={inp.projectedRepeatRate} onChange={set} error={err("projectedRepeatRate")} />
              <NumberInput k="repeatNonLaborCost" label="Non-labour cost per avoidable repeat" unit="$" value={inp.repeatNonLaborCost} onChange={set} hint="materials, handling, courier, scan" error={err("repeatNonLaborCost")} />
              <NumberInput k="repeatLaborCost" label="Labour cost per avoidable repeat" unit="$" value={inp.repeatLaborCost} onChange={set} error={err("repeatLaborCost")} />
              <label className="flex items-start gap-2.5 rounded-[var(--radius-control)] border border-teal/40 bg-teal-tint/40 p-3 text-small sm:col-span-2">
                <input
                  type="checkbox"
                  checked={inp.reworkLaborIncludedInTimeSaved}
                  onChange={(e) => {
                    setTouched(true);
                    setInp((p) => ({ ...p, reworkLaborIncludedInTimeSaved: e.target.checked }));
                  }}
                  className="mt-0.5 h-4 w-4 accent-[var(--color-teal)]"
                  data-testid="roi-double-count"
                />
                <span>
                  <strong>My minutes-saved figures already include time no longer spent on repeats.</strong>
                  <span className="block text-graphite">
                    Ticked, the labour part of a repeat is left out of avoided rework so the same minutes are not counted twice. Untick only if the minutes above
                    exclude repeat work.
                  </span>
                </span>
              </label>
            </Group>
            <Group title="Scanning and digitisation" note="The lab is not assumed to own a scanner or to have digitised slides.">
              <div className="space-y-1 sm:col-span-2">
                <span className="block text-small font-semibold text-ink" id="scanner-mode">
                  How slides would be digitised
                </span>
                <div role="radiogroup" aria-labelledby="scanner-mode" className="flex flex-wrap gap-1.5">
                  {(
                    [
                      ["service", "Scanning service (per slide)"],
                      ["purchase", "Buy a scanner"],
                      ["existing", "Already have scanner and digitised slides"],
                    ] as [ScannerMode, string][]
                  ).map(([m, l]) => (
                    <button
                      key={m}
                      type="button"
                      role="radio"
                      aria-checked={inp.scannerMode === m}
                      onClick={() => {
                        setTouched(true);
                        setInp((p) => ({ ...p, scannerMode: m }));
                      }}
                      className={cn("h-9 rounded-[var(--radius-control)] border px-3 text-small font-semibold", inp.scannerMode === m ? "border-teal bg-teal-tint text-teal-deep" : "border-line-strong bg-sheet")}
                    >
                      {l}
                    </button>
                  ))}
                </div>
              </div>
              {inp.scannerMode === "service" ? (
                <NumberInput k="scanningServicePerSlide" label="Scanning service cost per slide" unit="$" step={0.05} value={inp.scanningServicePerSlide} onChange={set} error={err("scanningServicePerSlide")} />
              ) : null}
              {inp.scannerMode === "purchase" ? (
                <>
                  <NumberInput k="scannerPurchase" label="Scanner acquisition (one-time)" unit="$" value={inp.scannerPurchase} onChange={set} error={err("scannerPurchase")} />
                  <NumberInput k="scannerAnnualService" label="Scanner service or amortisation per year" unit="$" value={inp.scannerAnnualService} onChange={set} error={err("scannerAnnualService")} />
                </>
              ) : null}
              {inp.scannerMode === "existing" ? <p className="text-small text-amber-ink sm:col-span-2">An assumption to verify, not a given: scanning time and storage still cost something.</p> : null}
            </Group>
            <Group title="Recurring costs per year">
              <NumberInput k="storage" label="Image storage" unit="$" value={inp.storage} onChange={set} error={err("storage")} />
              <NumberInput k="compute" label="Compute" unit="$" value={inp.compute} onChange={set} error={err("compute")} />
              <NumberInput k="support" label="Support" unit="$" value={inp.support} onChange={set} error={err("support")} />
              <NumberInput k="integrationRecurring" label="Integration upkeep" unit="$" value={inp.integrationRecurring} onChange={set} error={err("integrationRecurring")} />
              <NumberInput k="licensing" label="Software licensing" unit="$" value={inp.licensing} onChange={set} error={err("licensing")} />
              <NumberInput k="annotation" label="Annotation time" unit="$" value={inp.annotation} onChange={set} error={err("annotation")} />
              <NumberInput k="oversight" label="Physician and quality oversight" unit="$" value={inp.oversight} onChange={set} error={err("oversight")} />
            </Group>
            <Group title="One-time costs">
              <NumberInput k="integrationOneTime" label="Integration set-up" unit="$" value={inp.integrationOneTime} onChange={set} error={err("integrationOneTime")} />
              <NumberInput k="validationAndSetup" label="Validation and pilot set-up" unit="$" value={inp.validationAndSetup} onChange={set} error={err("validationAndSetup")} />
              <NumberInput k="training" label="Staff training" unit="$" value={inp.training} onChange={set} error={err("training")} />
            </Group>
          </div>

          <aside aria-label="Results" className="space-y-4 xl:sticky xl:top-[calc(var(--wb-header-h,56px)+64px)]" aria-live="polite">
            <div className="rounded-[var(--radius-panel)] border border-line-strong bg-sheet p-5" data-testid="roi-results">
              <div className="flex items-center justify-between gap-3">
                <h3 className="font-bold">Result with these inputs</h3>
                <span className="rounded-[3px] bg-amber-tint px-1.5 py-0.5 text-micro font-bold text-amber-ink" data-testid="roi-fictional-chip">
                  {isDefault ? "Fictional defaults" : "Fictional, edited"}
                </span>
              </div>
              {!r ? (
                <p className="mt-2 text-small text-rust" data-testid="roi-invalid">
                  Fix the highlighted inputs to see a result: {issues.length} problem{issues.length === 1 ? "" : "s"}.
                </p>
              ) : (
                <>
                  <div className={cn("mt-3 rounded-[var(--radius-control)] px-4 py-3", r.annualNetCashBenefit < 0 ? "bg-rust-tint" : "bg-approved-tint")}>
                    <p className="text-small font-semibold text-ink">Annual net cash benefit</p>
                    <p className={cn("tabular text-[2.1rem] font-bold leading-tight transition-colors duration-300", r.annualNetCashBenefit < 0 ? "text-rust" : "text-approved")}>
                      <span className="sr-only" data-testid="roi-annual-net">
                        {money(r.annualNetCashBenefit)}
                      </span>
                      <AnimatedFigure value={r.annualNetCashBenefit} format={money} />
                    </p>
                    <p className="text-small text-ink" data-testid="roi-verdict">
                      {r.annualNetCashBenefit < 0
                        ? "A loss every year: the recurring costs exceed the cash this releases. That is a valid result to report."
                        : r.annualNetCashBenefit === 0
                          ? "Break-even every year, before one-time costs."
                          : "Positive every year, before one-time costs."}
                    </p>
                  </div>
                  <Composition r={r} format={money} />
                  <dl className="mt-3">
                    <Line sign="+" label={`Realised labour savings (${Math.round(inp.realizationFraction * 100)}% of released capacity)`} value={r.realizedLaborSavings} testId="roi-realized" />
                    <Line sign="+" label={`Avoided rework (${num1.format(r.avoidedRepeats)} repeats × ${money(r.incrementalCostPerRepeat)})`} value={r.avoidedReworkCost} testId="roi-rework" />
                    <Line sign="−" label="Recurring incremental costs" value={r.recurringIncrementalCosts} />
                    <Line label="Annual net cash benefit" value={r.annualNetCashBenefit} strong />
                    <Line sign="−" label="One-time costs" value={r.oneTimeCostsTotal} />
                    <Line label="Year-one net benefit" value={r.yearOneNetBenefit} strong testId="roi-year-one" />
                  </dl>
                  <p className={cn("mt-3 text-small font-semibold", r.paybackMonths === null ? "text-rust" : "text-ink")} data-testid="roi-payback">
                    {r.paybackMonths === null ? r.paybackReason : r.paybackMonths === 0 ? "Payback: immediate (no one-time costs)." : `Payback: about ${r.paybackMonths.toFixed(1)} months. ${r.paybackReason}`}
                  </p>
                  {r.notes.length ? (
                    <ul className="mt-2 list-disc space-y-1 pl-4 text-micro text-graphite">
                      {r.notes.map((n) => (
                        <li key={n}>{n}</li>
                      ))}
                    </ul>
                  ) : null}
                </>
              )}
            </div>

            {r ? (
              <div className="rounded-[var(--radius-panel)] border border-line bg-surface p-5" data-testid="roi-capacity">
                <h3 className="font-bold">Capacity released is not cash</h3>
                <p className="mt-1 text-small text-graphite">
                  Freed minutes become cash only if they change staffing costs, overtime or outsourcing. Otherwise they are time for harder cases, teaching or
                  quality work. This calculator never adds extra throughput revenue on top, so the same time is never counted twice.
                </p>
                <dl className="mt-3 grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 text-small">
                  <dt className="text-graphite">Pathologist hours released per year</dt>
                  <dd className="tabular text-right font-semibold">{num1.format(r.pathologistHours)} h</dd>
                  <dt className="text-graphite">Technician hours released per year</dt>
                  <dd className="tabular text-right font-semibold">{num1.format(r.technicianHours)} h</dd>
                  <dt className="text-graphite">Value at loaded rates (capacity, not cash)</dt>
                  <dd className="tabular text-right font-semibold">{money(r.capacityValue)}</dd>
                  <dt className="text-graphite">Counted as cash</dt>
                  <dd className="tabular text-right font-semibold">{money(r.realizedLaborSavings)}</dd>
                </dl>
                <div className="mt-4">
                  <label htmlFor="realization" className="block text-small font-semibold">
                    Realisation fraction: {Number.isFinite(inp.realizationFraction) ? Math.round(inp.realizationFraction * 100) : "?"}% of released capacity becomes cash
                  </label>
                  <input
                    id="realization"
                    type="range"
                    min={0}
                    max={100}
                    step={5}
                    value={Number.isFinite(inp.realizationFraction) ? Math.round(inp.realizationFraction * 100) : 0}
                    onChange={(e) => set("realizationFraction", Number(e.target.value) / 100)}
                    className="mt-2 w-full accent-[var(--color-teal)]"
                    data-testid="roi-realization"
                  />
                  <div className="flex justify-between text-micro text-graphite">
                    <span>0%: no cash</span>
                    <span>100%: every freed minute becomes cash</span>
                  </div>
                </div>
                <h4 className="mt-4 text-small font-bold">Costs, broken out</h4>
                <table className="mt-1 w-full text-small">
                  <tbody>
                    {r.recurringCosts.map((c) => (
                      <tr key={c.key} className="border-b border-line">
                        <th scope="row" className="py-1 text-left font-normal text-graphite">
                          {c.label} <span className="text-micro">(per year)</span>
                        </th>
                        <td className="tabular py-1 text-right">{money(c.amount)}</td>
                      </tr>
                    ))}
                    {r.oneTimeCosts.map((c) => (
                      <tr key={c.key} className="border-b border-line">
                        <th scope="row" className="py-1 text-left font-normal text-graphite">
                          {c.label} <span className="text-micro">(one-time)</span>
                        </th>
                        <td className="tabular py-1 text-right">{money(c.amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </aside>
        </div>
      </section>

      <section aria-labelledby="biz" className="mt-12 border-t border-line pt-8">
        <h2 id="biz" className="scroll-mt-[calc(var(--wb-header-h,56px)+64px)] text-title font-bold">
          Business-model scenarios
        </h2>
        <ul className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          {[
            ["Annual laboratory subscription", "For the permitted research and workflow scope only."],
            ["Storage and processing", "Costed separately, because image volume drives it."],
            ["Feasibility studies and research collaborations", "Paid, and only when the data use is authorised."],
            ["Future clinically validated modules", "Only through the appropriate regulatory pathway, each validated on its own."],
          ].map(([t, b]) => (
            <li key={t} className="rounded-[var(--radius-panel)] border border-line bg-surface p-4">
              <p className="font-bold text-ink">{t}</p>
              <p className="mt-1 text-small text-graphite">{b}</p>
            </li>
          ))}
        </ul>
        <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <div>
            <h3 className="font-bold">Illustrative subscription arithmetic</h3>
            <table className="mt-2 w-full text-small" data-testid="arr-table">
              <caption className="sr-only">Illustrative annual recurring revenue arithmetic</caption>
              <thead>
                <tr className="border-b border-line-strong text-left text-micro text-graphite">
                  <th scope="col" className="py-1 font-semibold">Labs</th>
                  <th scope="col" className="py-1 font-semibold">Price per lab per year</th>
                  <th scope="col" className="py-1 text-right font-semibold">Arithmetic</th>
                </tr>
              </thead>
              <tbody>
                {ILLUSTRATIVE_SUBSCRIPTIONS.map((s) => (
                  <tr key={s.labs} className="border-b border-line">
                    <td className="tabular py-1.5">{s.labs}</td>
                    <td className="tabular py-1.5">{money(s.price)}</td>
                    <td className="tabular py-1.5 text-right font-semibold">{money(arr(s.labs, s.price))} ARR</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-2 rounded-[var(--radius-control)] border border-amber/60 bg-amber-tint/60 px-3 py-2 text-small text-ink" data-testid="arr-disclaimer">
              Illustrative arithmetic, not a forecast or market sizing. These figures do not establish willingness to pay, margins, achievable sales or company
              value.
            </p>
          </div>
          <div>
            <h3 className="font-bold">What a demo is worth</h3>
            <div className="mt-2 space-y-2 text-small text-ink">
              <p>A functioning demo establishes execution capability, not a defensible market valuation. No valuation is assigned to this prototype: it has no revenue and no validated product.</p>
              <p className="text-graphite">
                Value grows with repeatable paid adoption, retention, margins, data and IP rights, independently replicated performance, deployment reliability and
                an appropriate regulatory pathway. Competitors&rsquo; fundraising amounts are not valuation comparables.
              </p>
            </div>
          </div>
        </div>

        <div className="mt-6 rounded-[var(--radius-panel)] border border-line bg-surface p-5" data-testid="arr-multiple">
          <h3 className="font-bold">Optional: your own ARR multiple</h3>
          <p className="mt-1 max-w-[80ch] text-small text-graphite">
            There is no default multiple and no market multiple is suggested. Enter an ARR and a multiple you can justify; the result stays empty until you do.
          </p>
          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            {(
              [
                ["arr", "ARR (annual recurring revenue)", "$"],
                ["multiple", "ARR multiple (your assumption)", "×"],
                ["cash", "Cash (optional)", "$"],
                ["debt", "Debt (optional)", "$"],
                ["ownership", "Founder ownership after dilution (optional)", "%"],
              ] as const
            ).map(([k, l, u]) => (
              <div key={k} className="space-y-1">
                <label htmlFor={`val-${k}`} className="block text-small font-semibold">
                  {l}
                </label>
                <div className="flex h-10 items-center rounded-[var(--radius-control)] border border-line-strong bg-sheet focus-within:border-teal">
                  {u === "$" ? <span className="pl-2.5 text-graphite">$</span> : null}
                  <input id={`val-${k}`} type="number" min={0} value={val[k]} onChange={(e) => setVal({ ...val, [k]: e.target.value })} className="tabular h-full min-w-0 flex-1 bg-transparent px-2.5 focus:outline-none" data-testid={`val-${k}`} />
                  {u !== "$" ? <span className="pr-2.5 text-small text-graphite">{u}</span> : null}
                </div>
              </div>
            ))}
          </div>
          <dl className="mt-4 grid gap-x-6 gap-y-1 text-small sm:grid-cols-3">
            <div>
              <dt className="text-graphite">Enterprise value = ARR × multiple</dt>
              <dd className="tabular text-lead font-bold" data-testid="val-ev">
                {valuationOut.enterpriseValue === null ? "empty (enter ARR and a multiple)" : money(valuationOut.enterpriseValue)}
              </dd>
            </div>
            <div>
              <dt className="text-graphite">Equity value = EV + cash − debt</dt>
              <dd className="tabular text-lead font-bold">{valuationOut.equityValue === null ? "empty" : money(valuationOut.equityValue)}</dd>
            </div>
            <div>
              <dt className="text-graphite">Founder share before preferences</dt>
              <dd className="tabular text-lead font-bold">{valuationOut.founderShare === null ? "empty" : money(valuationOut.founderShare)}</dd>
            </div>
          </dl>
          <p className="mt-3 text-micro text-graphite">
            Equity value also depends on cash and debt. Founder proceeds depend on ownership after dilution and on investors&rsquo; liquidation preferences, which
            can reduce common proceeds to zero. None of this is financial advice.
          </p>
        </div>
      </section>
    </div>
  );
}
