// ROI calculator for the Impact screen. Pure functions; the formulas are EXACTLY the brief's:
//
//   annual_cases = cases_per_day * operating_days
//   annual_slides = annual_cases * slides_per_case
//   pathologist_hours = annual_cases * minutes_saved_per_case / 60
//   technician_hours = annual_slides * minutes_saved_per_slide / 60
//   capacity_value = pathologist_hours * pathologist_rate + technician_hours * technician_rate
//   realized_labor_savings = capacity_value * realization_fraction
//   avoided_rework_cost = annual_slides * (baseline_repeat_rate - projected_repeat_rate) * incremental_cost_per_repeat
//   annual_net_cash_benefit = realized_labor_savings + avoided_rework_cost - recurring_incremental_costs
//   year_one_net_benefit = annual_net_cash_benefit - one_time_costs
//
// Double-counting guard: the cost of one repeat is entered in two parts, non-labour (materials, courier,
// scanner time) and labour. When the minutes-saved inputs already include the time no longer spent on
// repeats, the labour part is excluded from incremental_cost_per_repeat so the same minutes are not counted
// twice. Payback is reported only when the recurring net benefit is positive.

export type ScannerMode = "service" | "purchase" | "existing";

export type RoiInputs = {
  casesPerDay: number;
  slidesPerCase: number;
  operatingDays: number;
  minutesSavedPerCase: number; // pathologist
  minutesSavedPerSlide: number; // technician / histology staff
  pathologistRate: number; // loaded $/hour
  technicianRate: number; // loaded $/hour
  baselineRepeatRate: number; // fraction 0..1
  projectedRepeatRate: number; // fraction 0..1
  repeatNonLaborCost: number; // $ per avoidable repeat (materials, handling, courier, scan)
  repeatLaborCost: number; // $ per avoidable repeat (staff time)
  reworkLaborIncludedInTimeSaved: boolean; // the guard
  realizationFraction: number; // 0..1: share of released capacity that becomes cash
  // scanner / digitisation
  scannerMode: ScannerMode;
  scanningServicePerSlide: number; // $ per slide, recurring (scannerMode = service)
  scannerPurchase: number; // $ one-time (scannerMode = purchase)
  scannerAnnualService: number; // $ per year (scannerMode = purchase): maintenance or amortisation
  // other recurring costs, $ per year
  storage: number;
  compute: number;
  support: number;
  integrationRecurring: number;
  licensing: number;
  annotation: number;
  oversight: number;
  // other one-time costs, $
  integrationOneTime: number;
  validationAndSetup: number;
  training: number;
};

export type CostLine = { key: string; label: string; amount: number };

export type RoiResult = {
  annualCases: number;
  annualSlides: number;
  pathologistHours: number;
  technicianHours: number;
  capacityValue: number;
  realizedLaborSavings: number;
  unrealizedCapacityValue: number;
  incrementalCostPerRepeat: number;
  excludedReworkLaborPerRepeat: number;
  avoidedRepeats: number;
  avoidedReworkCost: number;
  recurringCosts: CostLine[];
  oneTimeCosts: CostLine[];
  recurringIncrementalCosts: number;
  oneTimeCostsTotal: number;
  annualNetCashBenefit: number;
  yearOneNetBenefit: number;
  /** Months to recover one-time costs; null when the recurring net benefit is not positive. */
  paybackMonths: number | null;
  paybackReason: string;
  notes: string[];
};

export type InputIssue = { field: keyof RoiInputs; message: string };

const NON_NEGATIVE: (keyof RoiInputs)[] = [
  "casesPerDay",
  "slidesPerCase",
  "operatingDays",
  "minutesSavedPerCase",
  "minutesSavedPerSlide",
  "pathologistRate",
  "technicianRate",
  "repeatNonLaborCost",
  "repeatLaborCost",
  "scanningServicePerSlide",
  "scannerPurchase",
  "scannerAnnualService",
  "storage",
  "compute",
  "support",
  "integrationRecurring",
  "licensing",
  "annotation",
  "oversight",
  "integrationOneTime",
  "validationAndSetup",
  "training",
];

const FRACTIONS: (keyof RoiInputs)[] = ["baselineRepeatRate", "projectedRepeatRate", "realizationFraction"];

/** Every problem that makes the inputs meaningless. An empty list means the inputs are usable. */
export function validateRoiInputs(i: RoiInputs): InputIssue[] {
  const issues: InputIssue[] = [];
  for (const f of [...NON_NEGATIVE, ...FRACTIONS]) {
    const v = i[f];
    if (typeof v !== "number" || !Number.isFinite(v)) issues.push({ field: f, message: "Enter a number." });
  }
  for (const f of NON_NEGATIVE) {
    const v = i[f] as number;
    if (Number.isFinite(v) && v < 0) issues.push({ field: f, message: "Cannot be negative." });
  }
  for (const f of FRACTIONS) {
    const v = i[f] as number;
    if (Number.isFinite(v) && (v < 0 || v > 1)) issues.push({ field: f, message: "Must be between 0% and 100%." });
  }
  if (Number.isFinite(i.operatingDays) && i.operatingDays > 366) issues.push({ field: "operatingDays", message: "A year has at most 366 days." });
  return issues;
}

function money(n: number): number {
  // Keep full precision for the arithmetic; round only where displayed.
  return n;
}

export function computeRoi(i: RoiInputs): RoiResult {
  const issues = validateRoiInputs(i);
  if (issues.length) {
    throw new RangeError(`Invalid ROI inputs: ${issues.map((x) => `${String(x.field)} ${x.message}`).join("; ")}`);
  }
  const annualCases = i.casesPerDay * i.operatingDays;
  const annualSlides = annualCases * i.slidesPerCase;
  const pathologistHours = (annualCases * i.minutesSavedPerCase) / 60;
  const technicianHours = (annualSlides * i.minutesSavedPerSlide) / 60;
  const capacityValue = pathologistHours * i.pathologistRate + technicianHours * i.technicianRate;
  const realizedLaborSavings = capacityValue * i.realizationFraction;

  const excludedReworkLaborPerRepeat = i.reworkLaborIncludedInTimeSaved ? i.repeatLaborCost : 0;
  const incrementalCostPerRepeat = i.repeatNonLaborCost + (i.reworkLaborIncludedInTimeSaved ? 0 : i.repeatLaborCost);
  const avoidedRepeats = annualSlides * (i.baselineRepeatRate - i.projectedRepeatRate);
  const avoidedReworkCost = annualSlides * (i.baselineRepeatRate - i.projectedRepeatRate) * incrementalCostPerRepeat;

  const recurringCosts: CostLine[] = [];
  const oneTimeCosts: CostLine[] = [];
  if (i.scannerMode === "service") {
    recurringCosts.push({ key: "scanning", label: "Scanning service", amount: money(annualSlides * i.scanningServicePerSlide) });
  } else if (i.scannerMode === "purchase") {
    oneTimeCosts.push({ key: "scanner", label: "Scanner acquisition", amount: i.scannerPurchase });
    recurringCosts.push({ key: "scanner_service", label: "Scanner maintenance or amortisation", amount: i.scannerAnnualService });
  }
  recurringCosts.push(
    { key: "storage", label: "Image storage", amount: i.storage },
    { key: "compute", label: "Compute", amount: i.compute },
    { key: "support", label: "Support", amount: i.support },
    { key: "integration_recurring", label: "Integration upkeep", amount: i.integrationRecurring },
    { key: "licensing", label: "Software licensing", amount: i.licensing },
    { key: "annotation", label: "Annotation time", amount: i.annotation },
    { key: "oversight", label: "Physician and quality oversight", amount: i.oversight },
  );
  oneTimeCosts.push(
    { key: "integration_one_time", label: "Integration set-up", amount: i.integrationOneTime },
    { key: "validation", label: "Validation and pilot set-up", amount: i.validationAndSetup },
    { key: "training", label: "Staff training", amount: i.training },
  );
  const recurringIncrementalCosts = recurringCosts.reduce((a, c) => a + c.amount, 0);
  const oneTimeCostsTotal = oneTimeCosts.reduce((a, c) => a + c.amount, 0);
  const annualNetCashBenefit = realizedLaborSavings + avoidedReworkCost - recurringIncrementalCosts;
  const yearOneNetBenefit = annualNetCashBenefit - oneTimeCostsTotal;
  const pb = payback(oneTimeCostsTotal, annualNetCashBenefit);

  const notes: string[] = [];
  if (i.projectedRepeatRate > i.baselineRepeatRate) notes.push("The projected repeat rate is higher than the baseline, so rework adds cost instead of avoiding it.");
  if (i.scannerMode === "existing") notes.push("Assumes the lab already has a scanner and digitised slides. That is an assumption to verify, not a given.");
  if (i.reworkLaborIncludedInTimeSaved && i.repeatLaborCost > 0) notes.push("Repeat labour is excluded from avoided rework because the minutes-saved inputs already include it.");
  if (!i.reworkLaborIncludedInTimeSaved && i.repeatLaborCost > 0 && (i.minutesSavedPerCase > 0 || i.minutesSavedPerSlide > 0)) {
    notes.push("Repeat labour is counted in avoided rework. Make sure the minutes-saved inputs do not also include the time spent on repeats.");
  }

  return {
    annualCases,
    annualSlides,
    pathologistHours,
    technicianHours,
    capacityValue,
    realizedLaborSavings,
    unrealizedCapacityValue: capacityValue - realizedLaborSavings,
    incrementalCostPerRepeat,
    excludedReworkLaborPerRepeat,
    avoidedRepeats,
    avoidedReworkCost,
    recurringCosts,
    oneTimeCosts,
    recurringIncrementalCosts,
    oneTimeCostsTotal,
    annualNetCashBenefit,
    yearOneNetBenefit,
    paybackMonths: pb.months,
    paybackReason: pb.reason,
    notes,
  };
}

/** Payback only when the recurring net benefit is positive. */
export function payback(oneTimeCosts: number, annualNetCashBenefit: number): { months: number | null; reason: string } {
  if (!(annualNetCashBenefit > 0)) {
    return { months: null, reason: "No payback: the recurring net cash benefit is zero or negative, so the one-time costs are never recovered." };
  }
  if (oneTimeCosts <= 0) return { months: 0, reason: "No one-time costs to recover." };
  const months = oneTimeCosts / (annualNetCashBenefit / 12);
  return { months, reason: `One-time costs are recovered after about ${months.toFixed(1)} months of the recurring net benefit.` };
}

/** Illustrative subscription arithmetic (not a forecast): labs × annual price. */
export function arr(labs: number, annualPricePerLab: number): number {
  return labs * annualPricePerLab;
}

export const ILLUSTRATIVE_SUBSCRIPTIONS = [
  { labs: 25, price: 12_000 },
  { labs: 100, price: 24_000 },
  { labs: 250, price: 36_000 },
] as const;

export type ValuationInputs = { arr: number | null; multiple: number | null; cash: number | null; debt: number | null; ownership: number | null };

/**
 * Optional, user-supplied ARR multiple. There is NO default multiple: without one the result is null.
 * enterprise value = ARR × multiple; equity value = EV + cash − debt; founder share = equity × ownership,
 * before liquidation preferences, which can reduce common proceeds to zero.
 */
export function valuation(v: ValuationInputs): { enterpriseValue: number | null; equityValue: number | null; founderShare: number | null } {
  const ok = (x: number | null): x is number => x !== null && Number.isFinite(x);
  if (!ok(v.arr) || !ok(v.multiple) || v.arr < 0 || v.multiple < 0) return { enterpriseValue: null, equityValue: null, founderShare: null };
  const enterpriseValue = v.arr * v.multiple;
  const equityValue = enterpriseValue + (ok(v.cash) ? v.cash : 0) - (ok(v.debt) ? v.debt : 0);
  const founderShare = ok(v.ownership) && v.ownership >= 0 && v.ownership <= 1 ? equityValue * v.ownership : null;
  return { enterpriseValue, equityValue, founderShare };
}

/** FICTIONAL defaults: not measurements from any lab. No scanner and no digitised slides are assumed. */
export const FICTIONAL_DEFAULTS: RoiInputs = {
  casesPerDay: 120,
  slidesPerCase: 2.5,
  operatingDays: 250,
  minutesSavedPerCase: 2,
  minutesSavedPerSlide: 0.5,
  pathologistRate: 250,
  technicianRate: 45,
  baselineRepeatRate: 0.04,
  projectedRepeatRate: 0.03,
  repeatNonLaborCost: 15,
  repeatLaborCost: 20,
  reworkLaborIncludedInTimeSaved: true,
  realizationFraction: 0.5,
  scannerMode: "service",
  scanningServicePerSlide: 0.6,
  scannerPurchase: 0,
  scannerAnnualService: 0,
  storage: 9_000,
  compute: 3_000,
  support: 12_000,
  integrationRecurring: 6_000,
  licensing: 24_000,
  annotation: 10_000,
  oversight: 12_000,
  integrationOneTime: 25_000,
  validationAndSetup: 30_000,
  training: 5_000,
};
