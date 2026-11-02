import { redirect } from "next/navigation";
import { runtimeMode } from "@/server/runtime-mode";
import { safeReturnTo } from "@/server/auth/transactions";
import { PlainLink, PlainPage, firstParam, type SP } from "../_auth/plain-page";

export const dynamic = "force-dynamic";
export const metadata = { title: "Sign in" };

const REASON: Record<string, string> = {
  expired: "Your session has ended. Nothing was recorded after it ended.",
  locked: "This workstation was locked. Sign in again to continue; the screen showed nothing while it was locked.",
};

const ERROR: Record<string, string> = {
  provider_unavailable: "The sign-in service could not be reached. Nothing was signed in. Try again in a moment; if it keeps failing, tell the laboratory administrator.",
  bad_state: "That sign-in attempt expired or was already used. Start again.",
  provider_error: "The sign-in service did not complete the sign-in. Start again.",
  token_invalid: "The sign-in could not be verified. Nothing was signed in. Start again.",
  reauth_not_fresh: "The sign-in service did not ask you to sign in again. Start again.",
};

/**
 * Sign in (secured mode). Plain page: reads no laboratory data. The button is
 * a full navigation to /api/auth/login, which redirects to the identity
 * provider; the app never handles a password. After a lock it re-authenticates
 * (prompt=login) so a different person can take over the workstation.
 */
export default async function SignInPage({ searchParams }: { searchParams: SP }) {
  const mode = runtimeMode();
  if (mode === "locked") redirect("/locked");
  const sp = await searchParams;
  const returnTo = safeReturnTo(firstParam(sp, "returnTo"));
  if (mode === "demo") {
    return (
      <PlainPage title="No sign-in in the synthetic demo" actions={<PlainLink href="/" primary>Open the demo</PlainLink>}>
        <p>This build is the synthetic demonstration. It uses a demo role switch, not a sign-in.</p>
      </PlainPage>
    );
  }
  const reason = firstParam(sp, "reason");
  const error = firstParam(sp, "error");
  const reauth = reason === "locked" ? "&reauth=1" : "";
  const login = `/api/auth/login?returnTo=${encodeURIComponent(returnTo)}${reauth}`;
  return (
    <PlainPage title={reason === "locked" ? "Workstation locked" : "Sign in"} actions={<PlainLink href={login} primary>Sign in with your organization account</PlainLink>}>
      {error && ERROR[error] ? <p role="alert">{ERROR[error]}</p> : null}
      {reason && REASON[reason] ? <p>{REASON[reason]}</p> : null}
      <p>Sign in with the account your laboratory linked to your staff record. Only linked, active staff of this laboratory can open it.</p>
    </PlainPage>
  );
}
