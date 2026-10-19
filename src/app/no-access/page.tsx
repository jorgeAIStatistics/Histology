import { redirect } from "next/navigation";
import { runtimeMode } from "@/server/runtime-mode";
import { PlainLink, PlainPage, firstParam, type SP } from "../_auth/plain-page";
import { PlainSessionActions } from "../_auth/session-actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "No access" };

const REASON: Record<string, string> = {
  unlinked: "Your sign-in worked, but it is not linked to a staff record in this laboratory.",
  inactive: "Your staff record in this laboratory is not active.",
  wrong_lab: "Your account belongs to a different laboratory.",
  staff_inactive: "Your staff record in this laboratory is not active.",
  identity_unlinked: "Your sign-in is no longer linked to a staff record in this laboratory.",
};

/**
 * Sign-in refused for a person (not linked, inactive, other laboratory), or a
 * session ended for that reason. Plain page: reads no laboratory data and
 * never says which staff record or patient anything was about.
 */
export default async function NoAccessPage({ searchParams }: { searchParams: SP }) {
  const mode = runtimeMode();
  if (mode === "locked") redirect("/locked");
  if (mode === "demo") redirect("/");
  const reason = firstParam(await searchParams, "reason") ?? "";
  return (
    <PlainPage
      title="No access to this laboratory"
      actions={
        <>
          <PlainLink href="/api/auth/login?returnTo=%2F&reauth=1">Sign in as someone else</PlainLink>
          {/* Ends the provider's session too, so the next person at this workstation is not signed in as this account. */}
          <PlainSessionActions />
        </>
      }
    >
      <p>{REASON[reason] ?? "This account cannot open Histology Lab OS in this laboratory."}</p>
      <p>Nothing was shown or recorded. Ask the laboratory administrator to link or reactivate your staff record; job titles in your organization account never grant access on their own.</p>
    </PlainPage>
  );
}
