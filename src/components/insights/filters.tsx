import Link from "next/link";
import { Field, Select } from "@/components/ui/field";
import { buttonClasses } from "@/components/ui/button";
import type { DoctorOption, Option } from "@/server/queries/insights";

const dayFmt = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
export function fmtDay(day: string): string {
  return dayFmt.format(new Date(`${day}T12:00:00Z`));
}

/**
 * Filter row above everything (design-spec §6.8): date range among the seeded
 * illustrative days, office, dermatopathologist. A plain GET form, so the
 * filters live in the URL and work without JavaScript.
 */
export function InsightsFilters({
  days,
  offices,
  doctors,
  value,
}: {
  days: string[];
  offices: Option[];
  doctors: DoctorOption[];
  value: { from: string; to: string; office: string | null; doctor: string | null };
}) {
  return (
    // Keyed on the applied values: "Reset filters" is a client-side navigation, and uncontrolled selects would otherwise keep the old choice.
    <form
      key={`${value.from}|${value.to}|${value.office ?? ""}|${value.doctor ?? ""}`}
      method="get"
      action="/insights"
      className="rounded-lg border border-line bg-surface px-4 py-3"
      aria-label="Insight filters"
    >
      <div className="flex flex-wrap items-end gap-3">
        <Field label="From">
          <Select name="from" defaultValue={value.from} size="sm" className="w-36">
            {days.map((d) => (
              <option key={d} value={d}>
                {fmtDay(d)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="To">
          <Select name="to" defaultValue={value.to} size="sm" className="w-36">
            {days.map((d) => (
              <option key={d} value={d}>
                {fmtDay(d)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Office">
          <Select name="office" defaultValue={value.office ?? ""} size="sm" className="w-56">
            <option value="">All offices</option>
            {offices.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Assigned dermatopathologist">
          <Select name="doctor" defaultValue={value.doctor ?? ""} size="sm" className="w-52">
            <option value="">All dermatopathologists</option>
            {doctors.map((d) => (
              <option key={d.id} value={d.id}>
                {d.label}
                {d.color ? ` (${d.color})` : ""}
              </option>
            ))}
          </Select>
        </Field>
        <div className="flex gap-2">
          <button type="submit" className={buttonClasses({ variant: "primary", size: "sm" })}>
            Apply filters
          </button>
          <Link href="/insights" className={buttonClasses({ variant: "quiet", size: "sm" })}>
            Reset filters
          </Link>
        </div>
      </div>
      <p className="mt-2 text-sm text-ink-muted">
        Filters apply to the illustrative prior-day charts. Today&apos;s figures and the open-work snapshot always cover the whole synthetic lab.
      </p>
    </form>
  );
}
