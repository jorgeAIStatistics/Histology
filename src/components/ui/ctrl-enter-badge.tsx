import { CornerDownLeft } from "lucide-react";
import { cn } from "@/lib/cn";
import { Kbd } from "./kbd";

/**
 * The visible keyboard target for Ctrl/Cmd+Enter. Only the one button that
 * Ctrl+Enter runs carries it, and never an attestation (a container check or
 * a staff attestation is always a deliberate click or Enter on its own button).
 */
export function CtrlEnterBadge({ onDark = false, className }: { onDark?: boolean; className?: string }) {
  return (
    <Kbd
      aria-hidden
      title="Ctrl+Enter (Cmd+Enter on a Mac) runs this step"
      className={cn("ml-1 shrink-0 gap-0.5 font-semibold", onDark ? "border-white/40 bg-transparent text-white/90" : null, className)}
    >
      Ctrl
      <CornerDownLeft className="size-3" strokeWidth={2.25} />
    </Kbd>
  );
}
