import { redirect } from "next/navigation";
import { runtimeMode } from "@/server/runtime-mode";
import { PlainLink, PlainPage } from "../_auth/plain-page";

export const dynamic = "force-dynamic";
export const metadata = { title: "Signed out" };

/** After sign-out (and the provider's post-logout redirect). Plain page: reads no laboratory data. */
export default function SignedOutPage() {
  const mode = runtimeMode();
  if (mode === "locked") redirect("/locked");
  if (mode === "demo") redirect("/");
  return (
    <PlainPage title="Signed out" actions={<PlainLink href="/api/auth/login?returnTo=%2F" primary>Sign in again</PlainLink>}>
      <p>You are signed out of Histology Lab OS on this browser. Close the browser if this is a shared workstation.</p>
    </PlainPage>
  );
}
