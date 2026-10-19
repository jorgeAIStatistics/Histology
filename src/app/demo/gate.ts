import { notFound } from "next/navigation";
import { isDemoMode } from "@/server/runtime-mode";

/**
 * The presenter console (/demo and every one of its tabs) exists only in synthetic
 * demo mode. Anywhere else it is a 404, not a disabled page: a locked build must
 * not even reveal that a role switch, a demo clock or simulated world events exist.
 * Call it first in every server component that renders a presenter tab.
 */
export function requirePresenterSurface(): void {
  if (!isDemoMode()) notFound();
}
