/**
 * Scenario calculator arithmetic (pilot-proposal §7–§8), kept pure so it can be
 * unit-tested and so the component cannot quietly change the method.
 *
 *   Net minutes saved per unit   = (B − P) − (V + A)
 *   Annual net hours             = net minutes × N × D ÷ 60
 *   Potential annual labor value = annual net hours × R
 *   Potential net annual value   = labor value − C
 *
 * Rules: every input starts blank and nothing is assumed for a blank input;
 * B − P may be zero or negative (a shadow comparison can show the pilot is
 * slower) and is reported as it is; labor value needs R and net value needs C;
 * waiting time is never multiplied by a labor rate (not computed here).
 */

export type ScenarioKey = "savedLow" | "savedCentral" | "savedHigh" | "added" | "units" | "days" | "rate" | "costs";
export type ScenarioInputs = Record<ScenarioKey, string>;

export const BLANK_INPUTS: ScenarioInputs = { savedLow: "", savedCentral: "", savedHigh: "", added: "", units: "", days: "", rate: "", costs: "" };

/**
 * Illustrative only: echoes the pilot proposal's worked example (B − P = 2 min,
 * V + A = 2 min) with a spread, plus the size of the synthetic demo day. The
 * labor rate and costs stay blank: no money figure appears without finance.
 */
export const ILLUSTRATIVE_EXAMPLE: ScenarioInputs = { savedLow: "2", savedCentral: "3", savedHigh: "4", added: "2", units: "60", days: "250", rate: "", costs: "" };

/** B − P may be negative: the pilot can be slower than the baseline. Everything else is zero or more. */
export const SIGNED_KEYS: ReadonlySet<ScenarioKey> = new Set<ScenarioKey>(["savedLow", "savedCentral", "savedHigh"]);
export const REQUIRED_KEYS: readonly ScenarioKey[] = ["savedLow", "savedHigh", "added", "units", "days"];

export interface ScenarioPoint {
  /** B − P (minutes per unit). */
  savedMin: number;
  /** (B − P) − (V + A) (minutes per unit). Zero or negative is reported as it is. */
  netMin: number;
  /** net × N × D ÷ 60. Negative means the companion adds time. */
  annualHours: number;
  /** annualHours × R, or null when R is blank. */
  laborValue: number | null;
  /** laborValue − C, or null when R or C is blank. */
  netValue: number | null;
}

export type ScenarioErrors = Partial<Record<ScenarioKey, string>>;

export type ScenarioResult =
  | { ready: false; errors: ScenarioErrors; missing: ScenarioKey[] }
  | {
      ready: true;
      errors: ScenarioErrors;
      missing: ScenarioKey[];
      values: Record<ScenarioKey, number | null>;
      low: ScenarioPoint;
      /** Present only when a central B − P was entered. */
      central: ScenarioPoint | null;
      high: ScenarioPoint;
      rate: number | null;
      costs: number | null;
    };

/** "" → null (blank, nothing assumed); not a number → NaN. */
export function parseInput(v: string): number | null {
  if (v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

export function computeScenario(inputs: ScenarioInputs): ScenarioResult {
  const keys = Object.keys(BLANK_INPUTS) as ScenarioKey[];
  const n = Object.fromEntries(keys.map((k) => [k, parseInput(inputs[k] ?? "")])) as Record<ScenarioKey, number | null>;
  const errors: ScenarioErrors = {};
  for (const k of keys) {
    const v = n[k];
    if (v !== null && Number.isNaN(v)) errors[k] = "Enter a number.";
    else if (v !== null && v < 0 && !SIGNED_KEYS.has(k)) errors[k] = "Enter zero or more.";
  }
  const ok = (k: ScenarioKey) => n[k] !== null && !errors[k];
  if (ok("savedLow") && ok("savedHigh") && (n.savedLow as number) > (n.savedHigh as number)) {
    errors.savedHigh = "High must be at least the low value.";
  }
  if (ok("savedCentral") && ok("savedLow") && ok("savedHigh") && !errors.savedHigh) {
    const c = n.savedCentral as number;
    if (c < (n.savedLow as number) || c > (n.savedHigh as number)) errors.savedCentral = "Central must be between the low and high values.";
  }
  if (ok("days") && (n.days as number) > 366) errors.days = "A year has at most 366 days.";

  const missing = REQUIRED_KEYS.filter((k) => n[k] === null);
  if (missing.length || Object.keys(errors).length) return { ready: false, errors, missing };

  const added = n.added as number;
  const units = n.units as number;
  const days = n.days as number;
  const rate = n.rate;
  const costs = n.costs;
  const point = (saved: number): ScenarioPoint => {
    const netMin = saved - added;
    const annualHours = (netMin * units * days) / 60;
    const laborValue = rate === null ? null : annualHours * rate;
    return { savedMin: saved, netMin, annualHours, laborValue, netValue: laborValue === null || costs === null ? null : laborValue - costs };
  };
  return {
    ready: true,
    errors,
    missing,
    values: n,
    low: point(n.savedLow as number),
    central: n.savedCentral === null ? null : point(n.savedCentral),
    high: point(n.savedHigh as number),
    rate,
    costs,
  };
}
