import { Ban, CircleCheck, CircleHelp, FileText, Plug, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { StatusPill } from "@/components/ui/status-pill";
import type { Tone } from "@/components/ui/tone";
import type { CapabilityWord, FreshnessState } from "@/server/queries/settings";

/** Capability status in words only: Simulated / Documented / Unknown / Unsupported (never "Implemented"). */
export function CapabilityPill({ word }: { word: CapabilityWord }) {
  const map: Record<CapabilityWord, { tone: Tone; icon: typeof Plug }> = {
    Simulated: { tone: "info", icon: Plug },
    Documented: { tone: "neutral", icon: FileText },
    Unknown: { tone: "warning", icon: CircleHelp },
    Unsupported: { tone: "neutral", icon: Ban },
  };
  const m = map[word];
  return (
    <StatusPill tone={m.tone} icon={m.icon} size="sm">
      {word}
    </StatusPill>
  );
}

// Severity ladder: done is a quiet check in muted ink, never green; failures are amber with a triangle; red is reserved for patient identity.
export const OUTCOME_LABEL: Record<string, { label: string; tone: Tone; icon?: LucideIcon }> = {
  applied: { label: "Applied", tone: "neutral", icon: CircleCheck },
  duplicate_ignored: { label: "Duplicate ignored", tone: "info" },
  stale_ignored: { label: "Stale, ignored", tone: "info" },
  conflict_review: { label: "Needs review", tone: "warning" },
  failed: { label: "Failed", tone: "warning" },
};

export function OutcomePill({ outcome }: { outcome: string }) {
  const o = OUTCOME_LABEL[outcome] ?? { label: outcome.replace(/_/g, " "), tone: "neutral" as Tone };
  return (
    <StatusPill tone={o.tone} icon={o.icon} size="sm">
      {o.label}
    </StatusPill>
  );
}

export const VIA_LABEL: Record<string, string> = {
  pump: "Background poll",
  sync: "Sync / demo control",
  replay: "Duplicate replay (demo)",
  retry: "Manual retry",
  seed: "Before this session (seed)",
  accession_sim: "Accession simulator (recorded directly)",
  direct: "Recorded directly (no delivery receipt)",
  inbound: "Signed inbound message (simulated source)",
};

export function FreshnessPill({ state }: { state: FreshnessState }) {
  const map: Record<FreshnessState, { label: string; tone: Tone; icon?: LucideIcon }> = {
    current: { label: "Synced", tone: "neutral", icon: CircleCheck },
    delayed: { label: "Delayed", tone: "warning" },
    stale: { label: "Stale", tone: "warning" },
    offline: { label: "Offline", tone: "warning" },
    unknown: { label: "Unknown", tone: "neutral" },
  };
  const m = map[state];
  return (
    <StatusPill tone={m.tone} icon={m.icon}>
      {m.label}
    </StatusPill>
  );
}

/** "Demo control" marker for controls that change the simulated world, not lab records (a solid-hairline honesty chip; dashed means "not yet real" only). */
export function DemoControlTag({ children = "Demo control" }: { children?: ReactNode }) {
  return (
    <span className="hlo-chip inline-flex h-5 shrink-0 items-center whitespace-nowrap rounded-sm border border-sim-border bg-sim-bg px-1.5 text-xs font-medium text-sim-fg">
      {children}
    </span>
  );
}

/** Compact working hours, e.g. "Mon–Thu 08:00–17:00; Fri 08:00–16:00; Sat–Sun closed". */
export function compactHours(hours: { day: string; hours: string }[]): string {
  const groups: { from: string; to: string; hours: string }[] = [];
  for (const h of hours) {
    const last = groups[groups.length - 1];
    if (last && last.hours === h.hours) last.to = h.day;
    else groups.push({ from: h.day, to: h.day, hours: h.hours });
  }
  return groups.map((g) => `${g.from === g.to ? g.from : `${g.from}–${g.to}`} ${g.hours === "Closed" ? "closed" : g.hours}`).join("; ");
}
