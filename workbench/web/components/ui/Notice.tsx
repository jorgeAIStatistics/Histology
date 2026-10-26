import type { ReactNode } from "react";
import { AlertTriangle, Info, OctagonAlert, CheckCircle2 } from "lucide-react";
import { cn } from "./cn";
import { ApiError } from "@/lib/api";

type Tone = "info" | "warning" | "error" | "success" | "neutral";

const toneStyle: Record<Tone, string> = {
  info: "border-teal/30 bg-teal-tint/60 text-ink",
  warning: "border-amber/60 bg-amber-tint/70 text-ink",
  error: "border-rust/40 bg-rust-tint text-ink",
  success: "border-approved/40 bg-approved-tint text-ink",
  neutral: "border-line bg-surface text-ink",
};

const toneIcon: Record<Tone, ReactNode> = {
  info: <Info size={16} className="text-teal-deep" aria-hidden />,
  warning: <AlertTriangle size={16} className="text-amber-ink" aria-hidden />,
  error: <OctagonAlert size={16} className="text-rust" aria-hidden />,
  success: <CheckCircle2 size={16} className="text-approved" aria-hidden />,
  neutral: <Info size={16} className="text-graphite" aria-hidden />,
};

export function Notice({ tone = "info", title, children, className, role }: { tone?: Tone; title?: ReactNode; children?: ReactNode; className?: string; role?: "status" | "alert" | "note" }) {
  return (
    <div role={role ?? (tone === "error" ? "alert" : "note")} className={cn("flex gap-2.5 rounded-[var(--radius-control)] border px-3 py-2.5 text-small", toneStyle[tone], className)}>
      <span className="mt-0.5 shrink-0">{toneIcon[tone]}</span>
      <div className="min-w-0 flex-1 space-y-1">
        {title ? <p className="font-semibold">{title}</p> : null}
        {children ? <div className="text-graphite [&_strong]:text-ink">{children}</div> : null}
      </div>
    </div>
  );
}

export function ErrorBox({ error, what, className }: { error: unknown; what?: string; className?: string }) {
  if (!error) return null;
  const e = error as ApiError | Error;
  const isApi = e instanceof ApiError;
  return (
    <Notice tone="error" title={what ? `Could not ${what}` : "Request failed"} className={className}>
      <p>{e.message}</p>
      {isApi ? (
        <p className="font-mono text-micro text-graphite">
          {e.code}
          {e.status ? ` · HTTP ${e.status}` : ""}
          {e.requestId ? ` · request ${e.requestId}` : ""}
        </p>
      ) : null}
    </Notice>
  );
}

export function Loading({ label = "Loading", className }: { label?: string; className?: string }) {
  return (
    <div role="status" className={cn("flex items-center gap-2 py-6 text-small text-graphite", className)}>
      <span aria-hidden className="h-4 w-4 animate-spin rounded-full border-2 border-teal border-r-transparent" />
      {label}…
    </div>
  );
}
