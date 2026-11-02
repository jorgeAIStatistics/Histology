import { redirect } from "next/navigation";
import { runtimeMode } from "@/server/runtime-mode";
import { PlainPage } from "../_auth/plain-page";

export const dynamic = "force-dynamic";
export const metadata = { title: "Not configured" };

/**
 * Locked build: HLOS_MODE is not "demo", and sign-in is not configured (or its
 * configuration is invalid). Nobody can read or change anything. Plain page:
 * reads no laboratory data and does not name configuration keys (operators
 * read them from lockedReason() / the server log).
 */
export default function LockedPage() {
  const mode = runtimeMode();
  if (mode === "demo") redirect("/");
  if (mode === "secured") redirect("/signin");
  return (
    <PlainPage title="This build is not configured">
      <p>Sign-in is not set up for this installation, so no laboratory data is shown and no change can be made.</p>
      <p>An administrator must configure the identity provider. The synthetic demonstration runs only when it is started in demo mode.</p>
    </PlainPage>
  );
}
