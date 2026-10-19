import { redirect } from "next/navigation";
import { requireActor } from "@/server/auth/guard";
import { landingPathFor } from "@/components/shell/landing";

/** Landing page by role (spec §5.1). */
export default async function Home() {
  const actor = await requireActor();
  redirect(landingPathFor(actor.role));
}
