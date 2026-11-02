import { cn } from "@/lib/cn";

/**
 * Patient identity, the top rung of the severity ladder: a filled red octagon
 * with a white cross, so the stop-sign silhouette reads as an octagon even at
 * 16-18px (an outlined OctagonX reads as a circled x at that size). Always
 * paired with the words "patient identity"; decorative to assistive tech.
 */
export function IdentityMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" aria-hidden focusable="false" className={cn("size-[18px] shrink-0", className)}>
      <polygon points="6.1,0.6 13.9,0.6 19.4,6.1 19.4,13.9 13.9,19.4 6.1,19.4 0.6,13.9 0.6,6.1" className="fill-danger-solid" />
      <path d="M7.3 7.3 12.7 12.7M12.7 7.3 7.3 12.7" stroke="white" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  );
}
