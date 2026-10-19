"use client";

import { useEffect } from "react";

/**
 * ?part=X (a scanned part label, a link from a worklist row) brings that part
 * into view and plays the scan ping once, the same locate signal as the scan
 * field. The jump is instant; the ping is removed by reduced motion.
 */
export function PartLocator({ targetId }: { targetId: string }) {
  useEffect(() => {
    const el = document.getElementById(targetId);
    if (!el) return;
    el.scrollIntoView({ block: "start", behavior: "auto" });
    el.classList.remove("animate-scan-ping");
    // Restart the animation on the next frame so a repeat locate pings again.
    const raf = requestAnimationFrame(() => el.classList.add("animate-scan-ping"));
    return () => cancelAnimationFrame(raf);
  }, [targetId]);
  return null;
}
