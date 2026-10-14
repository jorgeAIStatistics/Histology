import { redirect } from "next/navigation";
import { getActor } from "@/server/session";
import { landingPathFor } from "@/components/shell/landing";

/** Landing page by role (spec §5.1). */
export default async function Home() {
  const actor = await getActor();
  redirect(landingPathFor(actor.role));
}
