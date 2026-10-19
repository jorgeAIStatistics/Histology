import Link from "next/link";
import { FlaskConical } from "lucide-react";

/**
 * Demo status: always visible in the top bar, cannot be dismissed. States the
 * one fact every screen depends on (synthetic data, simulated connectors) once,
 * so individual rows do not have to repeat it.
 */
export function DemoBanner() {
  return (
    <div role="note" aria-label="Demo mode" className="flex shrink-0 items-center">
      <Link
        href="/settings?tab=integration"
        title="Synthetic data only. No real patients. Source system, notifications, printers, scanners and the assistant are simulated."
        className="inline-flex h-7 items-center gap-1.5 rounded-pill bg-shell-fg px-2.5 text-sm font-semibold text-shell hover:bg-white/90"
      >
        <FlaskConical className="size-3.5" aria-hidden />
        Synthetic<span className="max-[1535px]:sr-only"> demo</span>
        <span className="sr-only">: what is simulated?</span>
      </Link>
    </div>
  );
}
