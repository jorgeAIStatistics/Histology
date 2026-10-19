import { Presentation } from "lucide-react";
import { cn } from "@/lib/cn";

/**
 * "Presenter (synthetic demo)": the honesty tag of the presenter console (the same
 * solid-hairline simulation chip as "Simulated" and "Demo control"). It marks a
 * surface for running the demonstration; nothing under it is a laboratory action.
 */
export function PresenterTag({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "hlo-chip inline-flex h-6 shrink-0 items-center gap-1 whitespace-nowrap rounded-sm border border-sim-border bg-sim-bg px-1.5 text-xs font-medium text-sim-fg",
        className,
      )}
    >
      <Presentation className="size-3.5 shrink-0" aria-hidden />
      Presenter (synthetic demo)
    </span>
  );
}
