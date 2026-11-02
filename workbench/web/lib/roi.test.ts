import { describe, expect, it } from "vitest";
import { FICTIONAL_DEFAULTS, ILLUSTRATIVE_SUBSCRIPTIONS, arr, computeRoi, payback, validateRoiInputs, valuation, type RoiInputs } from "./roi";

const ZERO_COSTS: Partial<RoiInputs> = {
  scannerMode: "existing",
  scanningServicePerSlide: 0,
  scannerPurchase: 0,
  scannerAnnualService: 0,
  storage: 0,
  compute: 0,
  support: 0,
  integrationRecurring: 0,
  licensing: 0,
  annotation: 0,
  oversight: 0,
  integrationOneTime: 0,
  validationAndSetup: 0,
  training: 0,
};

function inputs(over: Partial<RoiInputs> = {}): RoiInputs {
  return { ...FICTIONAL_DEFAULTS, ...over };
}

describe("computeRoi: the brief's formulas, step by step", () => {
  // A hand-computable case.
  const i = inputs({
    ...ZERO_COSTS,
    casesPerDay: 10,
    slidesPerCase: 3,
    operatingDays: 200,
    minutesSavedPerCase: 6,
    minutesSavedPerSlide: 2,
    pathologistRate: 300,
    technicianRate: 60,
    baselineRepeatRate: 0.05,
    projectedRepeatRate: 0.02,
    repeatNonLaborCost: 10,
    repeatLaborCost: 30,
    reworkLaborIncludedInTimeSaved: false,
    realizationFraction: 0.4,
    storage: 1000,
    licensing: 2000,
    validationAndSetup: 5000,
  });
  const r = computeRoi(i);

  it("annual_cases = cases_per_day * operating_days", () => expect(r.annualCases).toBe(2000));
  it("annual_slides = annual_cases * slides_per_case", () => expect(r.annualSlides).toBe(6000));
  it("pathologist_hours = annual_cases * minutes_saved_per_case / 60", () => expect(r.pathologistHours).toBeCloseTo(200, 10));
  it("technician_hours = annual_slides * minutes_saved_per_slide / 60", () => expect(r.technicianHours).toBeCloseTo(200, 10));
  it("capacity_value = pathologist_hours * rate + technician_hours * rate", () => expect(r.capacityValue).toBeCloseTo(200 * 300 + 200 * 60, 8));
  it("realized_labor_savings = capacity_value * realization_fraction", () => expect(r.realizedLaborSavings).toBeCloseTo(72000 * 0.4, 8));
  it("avoided_rework_cost = annual_slides * (baseline - projected) * incremental_cost_per_repeat", () => {
    expect(r.incrementalCostPerRepeat).toBe(40);
    expect(r.avoidedReworkCost).toBeCloseTo(6000 * 0.03 * 40, 8);
  });
  it("annual_net_cash_benefit = realized + avoided - recurring", () => {
    expect(r.recurringIncrementalCosts).toBe(3000);
    expect(r.annualNetCashBenefit).toBeCloseTo(28800 + 7200 - 3000, 8);
  });
  it("year_one_net_benefit = annual_net_cash_benefit - one_time_costs", () => {
    expect(r.oneTimeCostsTotal).toBe(5000);
    expect(r.yearOneNetBenefit).toBeCloseTo(33000 - 5000, 8);
  });
  it("payback = one-time costs / monthly net benefit", () => expect(r.paybackMonths).toBeCloseTo(5000 / (33000 / 12), 10));
  it("keeps capacity released separate from cash", () => expect(r.unrealizedCapacityValue).toBeCloseTo(72000 - 28800, 8));
});

describe("negative results are shown, not hidden", () => {
  it("costs above savings give a negative annual and year-one result and no payback", () => {
    const r = computeRoi(inputs({ minutesSavedPerCase: 0, minutesSavedPerSlide: 0 }));
    expect(r.realizedLaborSavings).toBe(0);
    expect(r.annualNetCashBenefit).toBeLessThan(0);
    expect(r.yearOneNetBenefit).toBeLessThan(r.annualNetCashBenefit);
    expect(r.paybackMonths).toBeNull();
    expect(r.paybackReason).toMatch(/No payback/);
  });
  it("a projected repeat rate above baseline makes avoided rework negative", () => {
    const r = computeRoi(inputs({ baselineRepeatRate: 0.02, projectedRepeatRate: 0.05 }));
    expect(r.avoidedReworkCost).toBeLessThan(0);
    expect(r.avoidedRepeats).toBeLessThan(0);
    expect(r.notes.join(" ")).toMatch(/higher than the baseline/);
  });
  it("the fictional defaults turn negative when minutes saved fall", () => {
    const base = computeRoi(FICTIONAL_DEFAULTS);
    const lower = computeRoi(inputs({ minutesSavedPerCase: 1 }));
    expect(base.annualNetCashBenefit).toBeGreaterThan(0);
    expect(lower.annualNetCashBenefit).toBeLessThan(0);
  });
});

describe("payback edge cases", () => {
  it("zero recurring net benefit: no payback", () => {
    expect(payback(10000, 0)).toEqual({ months: null, reason: expect.stringMatching(/No payback/) });
  });
  it("negative recurring net benefit: no payback", () => {
    expect(payback(10000, -1).months).toBeNull();
  });
  it("NaN benefit: no payback", () => {
    expect(payback(10000, Number.NaN).months).toBeNull();
  });
  it("positive benefit and no one-time costs: zero months", () => {
    expect(payback(0, 12000).months).toBe(0);
  });
  it("positive benefit: months = one-time / (annual / 12)", () => {
    expect(payback(12000, 24000).months).toBe(6);
  });
  it("one-time cost only (no savings, no recurring costs): year one equals minus the one-time costs, no payback", () => {
    const r = computeRoi(
      inputs({ ...ZERO_COSTS, minutesSavedPerCase: 0, minutesSavedPerSlide: 0, baselineRepeatRate: 0.03, projectedRepeatRate: 0.03, integrationOneTime: 20000 }),
    );
    expect(r.annualNetCashBenefit).toBe(0);
    expect(r.yearOneNetBenefit).toBe(-20000);
    expect(r.paybackMonths).toBeNull();
  });
  it("savings exactly equal to recurring costs: zero benefit, no payback", () => {
    const r = computeRoi(
      inputs({
        ...ZERO_COSTS,
        casesPerDay: 1,
        slidesPerCase: 1,
        operatingDays: 60,
        minutesSavedPerCase: 60,
        minutesSavedPerSlide: 0,
        pathologistRate: 100,
        realizationFraction: 1,
        baselineRepeatRate: 0,
        projectedRepeatRate: 0,
        licensing: 6000,
      }),
    );
    expect(r.realizedLaborSavings).toBe(6000);
    expect(r.annualNetCashBenefit).toBe(0);
    expect(r.paybackMonths).toBeNull();
  });
});

describe("double-count guard for rework labour", () => {
  const base = inputs({ repeatNonLaborCost: 15, repeatLaborCost: 20, baselineRepeatRate: 0.04, projectedRepeatRate: 0.03 });
  it("when minutes saved already include repeat time, labour is excluded from the cost per repeat", () => {
    const r = computeRoi({ ...base, reworkLaborIncludedInTimeSaved: true });
    expect(r.incrementalCostPerRepeat).toBe(15);
    expect(r.excludedReworkLaborPerRepeat).toBe(20);
    expect(r.avoidedReworkCost).toBeCloseTo(r.annualSlides * 0.01 * 15, 6);
  });
  it("when they do not, labour is counted once in avoided rework, with a reminder", () => {
    const r = computeRoi({ ...base, reworkLaborIncludedInTimeSaved: false });
    expect(r.incrementalCostPerRepeat).toBe(35);
    expect(r.excludedReworkLaborPerRepeat).toBe(0);
    expect(r.notes.join(" ")).toMatch(/do not also include/);
  });
  it("the guard changes only the rework line, never the labour savings", () => {
    const a = computeRoi({ ...base, reworkLaborIncludedInTimeSaved: true });
    const b = computeRoi({ ...base, reworkLaborIncludedInTimeSaved: false });
    expect(a.realizedLaborSavings).toBe(b.realizedLaborSavings);
    expect(b.avoidedReworkCost - a.avoidedReworkCost).toBeCloseTo(a.annualSlides * 0.01 * 20, 6);
  });
});

describe("realization fraction bounds", () => {
  it("0 means no cash from released capacity", () => {
    const r = computeRoi(inputs({ realizationFraction: 0 }));
    expect(r.realizedLaborSavings).toBe(0);
    expect(r.unrealizedCapacityValue).toBe(r.capacityValue);
  });
  it("1 means all released capacity becomes cash", () => {
    const r = computeRoi(inputs({ realizationFraction: 1 }));
    expect(r.realizedLaborSavings).toBe(r.capacityValue);
  });
  it("below 0 or above 1 is rejected, not clamped", () => {
    expect(validateRoiInputs(inputs({ realizationFraction: -0.01 }))).toEqual([{ field: "realizationFraction", message: expect.any(String) }]);
    expect(validateRoiInputs(inputs({ realizationFraction: 1.01 }))).toHaveLength(1);
    expect(() => computeRoi(inputs({ realizationFraction: 1.5 }))).toThrow(RangeError);
  });
  it("repeat rates are fractions too", () => {
    expect(validateRoiInputs(inputs({ baselineRepeatRate: 2 }))).toHaveLength(1);
    expect(validateRoiInputs(inputs({ projectedRepeatRate: -0.1 }))).toHaveLength(1);
  });
});

describe("input validation", () => {
  it("accepts the fictional defaults", () => expect(validateRoiInputs(FICTIONAL_DEFAULTS)).toEqual([]));
  it("rejects negative counts and costs", () => {
    const issues = validateRoiInputs(inputs({ casesPerDay: -1, licensing: -5 }));
    expect(issues.map((x) => x.field).sort()).toEqual(["casesPerDay", "licensing"]);
  });
  it("rejects non-numbers", () => {
    expect(validateRoiInputs(inputs({ pathologistRate: Number.NaN })).some((x) => x.field === "pathologistRate")).toBe(true);
  });
  it("rejects more than 366 operating days", () => {
    expect(validateRoiInputs(inputs({ operatingDays: 400 })).map((x) => x.field)).toEqual(["operatingDays"]);
  });
});

describe("scanner and digitisation are never assumed", () => {
  it("defaults use a scanning service: a recurring per-slide cost", () => {
    const r = computeRoi(FICTIONAL_DEFAULTS);
    const scan = r.recurringCosts.find((c) => c.key === "scanning");
    expect(FICTIONAL_DEFAULTS.scannerMode).toBe("service");
    expect(scan?.amount).toBeCloseTo(r.annualSlides * FICTIONAL_DEFAULTS.scanningServicePerSlide, 6);
  });
  it("buying a scanner moves the acquisition into one-time costs and keeps service recurring", () => {
    const r = computeRoi(inputs({ scannerMode: "purchase", scannerPurchase: 150000, scannerAnnualService: 15000 }));
    expect(r.oneTimeCosts.find((c) => c.key === "scanner")?.amount).toBe(150000);
    expect(r.recurringCosts.find((c) => c.key === "scanner_service")?.amount).toBe(15000);
    expect(r.recurringCosts.find((c) => c.key === "scanning")).toBeUndefined();
  });
  it("an existing scanner is flagged as an assumption", () => {
    const r = computeRoi(inputs({ scannerMode: "existing" }));
    expect(r.notes.join(" ")).toMatch(/assumption to verify/);
  });
  it("recurring and one-time lines add up to their totals", () => {
    const r = computeRoi(FICTIONAL_DEFAULTS);
    expect(r.recurringCosts.reduce((a, c) => a + c.amount, 0)).toBeCloseTo(r.recurringIncrementalCosts, 8);
    expect(r.oneTimeCosts.reduce((a, c) => a + c.amount, 0)).toBeCloseTo(r.oneTimeCostsTotal, 8);
  });
});

describe("illustrative subscription arithmetic (not forecasts)", () => {
  it("25 × $12k = $300k; 100 × $24k = $2.4M; 250 × $36k = $9M", () => {
    expect(ILLUSTRATIVE_SUBSCRIPTIONS.map((s) => arr(s.labs, s.price))).toEqual([300_000, 2_400_000, 9_000_000]);
  });
});

describe("optional ARR multiple: no default multiple", () => {
  it("returns nothing until a multiple is entered", () => {
    expect(valuation({ arr: 1_000_000, multiple: null, cash: null, debt: null, ownership: null })).toEqual({ enterpriseValue: null, equityValue: null, founderShare: null });
  });
  it("EV = ARR × multiple; equity adds cash and subtracts debt; founder share applies ownership", () => {
    expect(valuation({ arr: 1_000_000, multiple: 3, cash: 200_000, debt: 500_000, ownership: 0.4 })).toEqual({ enterpriseValue: 3_000_000, equityValue: 2_700_000, founderShare: 1_080_000 });
  });
  it("ignores an ownership outside 0–1", () => {
    expect(valuation({ arr: 100, multiple: 2, cash: null, debt: null, ownership: 40 }).founderShare).toBeNull();
  });
  it("rejects negative inputs", () => {
    expect(valuation({ arr: -1, multiple: 2, cash: null, debt: null, ownership: null }).enterpriseValue).toBeNull();
  });
});
