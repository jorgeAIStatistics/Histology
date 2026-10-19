import { redirect } from "next/navigation";
import { runtimeMode } from "@/server/runtime-mode";
import { PlainLink, PlainPage } from "../_auth/plain-page";
import { PlainSessionActions } from "../_auth/session-actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Not allowed" };

/**
 * 403: the signed-in role may not open the screen it asked for (for example
 * a laboratory administrator or an auditor on a bench screen). Plain page:
 * reads no laboratory data.
 */
export default function ForbiddenPage() {
  const mode = runtimeMode();
  if (mode === "locked") redirect("/locked");
  return (
    <PlainPage
      title="Not allowed"
      actions={
        <>
          <PlainLink href="/">Go to your start page</PlainLink>
          {/* Signed in (secured mode): the top bar's Lock and Sign out, since this page has no app chrome. */}
          {mode === "secured" ? <PlainSessionActions lock /> : null}
        </>
      }
    >
      <p>Your role cannot open that screen. Nothing was shown.</p>
      <p>Roles are assigned by the laboratory administrator.</p>
    </PlainPage>
  );
}
