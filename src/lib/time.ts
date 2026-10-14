/** Display helpers. Storage is UTC ISO-8601; display is America/New_York. */
export const LAB_TZ = "America/New_York";

const timeFmt = new Intl.DateTimeFormat("en-US", { timeZone: LAB_TZ, hour: "numeric", minute: "2-digit" });
const dateFmt = new Intl.DateTimeFormat("en-US", { timeZone: LAB_TZ, month: "short", day: "numeric" });
const dateTimeFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: LAB_TZ, month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
});
const fullFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: LAB_TZ, weekday: "short", year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit", timeZoneName: "short",
});
const dayKeyFmt = new Intl.DateTimeFormat("en-CA", { timeZone: LAB_TZ, year: "numeric", month: "2-digit", day: "2-digit" });

export function fmtTime(iso?: string | null): string {
  return iso ? timeFmt.format(new Date(iso)) : "—";
}
export function fmtDate(iso?: string | null): string {
  return iso ? dateFmt.format(new Date(iso)) : "—";
}
export function fmtDateTime(iso?: string | null): string {
  return iso ? `${dateTimeFmt.format(new Date(iso))}` : "—";
}
/** Unambiguous timestamp with weekday, date, seconds and zone (for snapshots/audit). */
export function fmtFull(iso?: string | null): string {
  return iso ? fullFmt.format(new Date(iso)) : "—";
}
/** Local lab day key 'YYYY-MM-DD' in America/New_York. */
export function labDay(iso: string): string {
  return dayKeyFmt.format(new Date(iso));
}
/** Same lab day as `now`? Shows time only; otherwise date + time. */
export function fmtSmart(iso: string | null | undefined, now: string): string {
  if (!iso) return "—";
  return labDay(iso) === labDay(now) ? fmtTime(iso) : fmtDateTime(iso);
}
export function minutesBetween(a: string, b: string): number {
  return Math.round((Date.parse(b) - Date.parse(a)) / 60_000);
}
/** Human age like "38 min", "2 h 5 min", "3 d". */
export function fmtAge(fromIso: string | null | undefined, nowIso: string): string {
  if (!fromIso) return "unknown";
  const m = Math.max(0, minutesBetween(fromIso, nowIso));
  if (m < 1) return "just now";
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
  return `${Math.floor(h / 24)} d`;
}
/** Build a UTC ISO string from a lab-local date + time (America/New_York, handles DST). */
export function labLocalToIso(day: string, hhmm: string): string {
  const [y, mo, d] = day.split("-").map(Number);
  const [h, mi] = hhmm.split(":").map(Number);
  // Start from the UTC guess and correct by the zone offset at that instant.
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const offsetMin = tzOffsetMinutes(guess);
  let iso = new Date(guess - offsetMin * 60_000);
  const offset2 = tzOffsetMinutes(iso.getTime());
  if (offset2 !== offsetMin) iso = new Date(guess - offset2 * 60_000);
  return iso.toISOString();
}
function tzOffsetMinutes(utcMs: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: LAB_TZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  }).formatToParts(new Date(utcMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"));
  return Math.round((asUtc - utcMs) / 60_000);
}
