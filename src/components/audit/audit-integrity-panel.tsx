"use client";

import { useState } from "react";
import { Download, RefreshCw } from "lucide-react";
import type { AuditProblemKind, AuditReport } from "@/server/core/audit-seal";
import { AlertBanner } from "@/components/ui/alert-banner";
import { Button } from "@/components/ui/button";
import { Card, FactList } from "@/components/ui/card";
import { StatusPill } from "@/components/ui/status-pill";
import { fmtFull } from "@/lib/time";
import { handleCommandAuthFailure, withActorHeader } from "@/lib/client/session";

/**
 * The audit trail's integrity check (/audit): chain status, events checked,
 * the newest anchor and the first problem, with "Verify again" (POST
 * /api/audit/verify, recorded as an audit event) and the evidence download
 * (seq ranges, MACs, key id; no audit event content). Problems use the
 * amber rung ("data may be wrong"), never identity red.
 */

const KIND: Record<AuditProblemKind, { title: string; explain: string }> = {
  event_modified: { title: "An event was changed after it was sealed", explain: "The stored event no longer matches the seal written with it." },
  event_missing: { title: "An event is missing", explain: "An event that was sealed (or counted) is no longer in the audit trail: it was deleted." },
  seal_missing: { title: "A seal is missing", explain: "An event has no seal although later events are sealed: a seal was removed, or a row was added outside the application." },
  seal_forged: { title: "A seal does not match the audit key", explain: "The seal was made or altered without this key, or under another key." },
  chain_broken: { title: "The chain is broken", explain: "A seal does not link to the one before it: events were removed or rearranged together with their seals." },
  reordered: { title: "Events are out of order", explain: "The event stored at this position is not the one that was sealed there: rows were swapped or moved." },
  unsealed_tail: { title: "The newest events are not sealed", explain: "They were written without an audit key, or added outside the application." },
  anchor_mismatch: {
    title: "The chain does not match an exported anchor",
    explain: "History up to the anchor was rewritten after the anchor was exported (by someone holding the key), was truncated, or the anchor belongs to another laboratory.",
  },
};

interface Failure {
  code?: string;
  message?: string;
}

export function AuditIntegrityPanel({ initial }: { initial: AuditReport }) {
  const [report, setReport] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [announce, setAnnounce] = useState("");
  const v = report.verification;
  const problem = v.firstProblem;

  async function verifyAgain() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/audit/verify", {
        method: "POST",
        headers: withActorHeader({ "Content-Type": "application/json", Accept: "application/json" }),
        body: "{}",
        cache: "no-store",
      });
      const body = (await res.json().catch(() => null)) as { ok?: boolean; result?: AuditReport; error?: Failure } | null;
      if (res.ok && body?.ok && body.result) {
        setReport(body.result);
        const r = body.result;
        setAnnounce(
          r.ok
            ? `Verified: ${r.verification.checked} events checked, sealed through seq ${r.verification.sealedThrough}.`
            : `Problem found${r.verification.firstProblem ? ` at seq ${r.verification.firstProblem.seq}` : ""}.`,
        );
        return;
      }
      const failure = { code: body?.error?.code ?? "UNCONFIRMED", message: body?.error?.message ?? "Verification did not complete. Nothing was changed; try again." };
      setError((await handleCommandAuthFailure(failure)).message);
    } catch {
      setError("Could not reach the server. Nothing was changed; try again.");
    } finally {
      setBusy(false);
    }
  }

  function download() {
    const stamp = report.evidence.generatedAt.replace(/[^0-9TZ]/g, "");
    const lab = report.evidence.lab.replace(/[^A-Za-z0-9_-]+/g, "-");
    const blob = new Blob([`${JSON.stringify(report.evidence, null, 2)}\n`], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `audit-evidence-${lab}-seq${v.sealedThrough}-${stamp}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const last = report.anchorFile.last;
  return (
    <div className="flex flex-col gap-3">
      <p role="status" className="sr-only">
        {announce}
      </p>
      {error ? (
        <AlertBanner tone="warning" title="Verification did not run" announce="alert">
          {error}
        </AlertBanner>
      ) : null}
      {problem ? (
        <AlertBanner tone="warning" title={`First problem at seq ${problem.seq}: ${KIND[problem.kind].title}`} headingLevel={2}>
          <p>{KIND[problem.kind].explain}</p>
          <p className="mt-1 text-ink-secondary">{problem.detail}</p>
          <p className="mt-1 text-ink-secondary">Events before seq {problem.seq} verified. Nothing after it can be vouched for until this is investigated.</p>
        </AlertBanner>
      ) : null}
      {report.anchorFile.error ? (
        <AlertBanner tone="warning" title="The anchor file could not be used" headingLevel={2}>
          {report.anchorFile.error} The chain was verified without anchors, so a rewrite by someone holding the key would not show here.
        </AlertBanner>
      ) : null}
      {v.demoKey ? (
        <AlertBanner tone="info" title="Sealed with the public demo key">
          The key id is demo-not-secret: anyone can recompute these seals, so they prove nothing. This shows the mechanism with synthetic data.
        </AlertBanner>
      ) : null}
      <Card
        title="Chain status"
        description="Recomputes the HMAC chain over every audit event and compares it with the exported anchors."
        actions={
          <>
            <Button size="sm" variant="secondary" icon={<RefreshCw />} loading={busy} loadingLabel="Verifying..." onClick={verifyAgain}>
              Verify again
            </Button>
            <Button size="sm" variant="secondary" icon={<Download />} onClick={download}>
              Download evidence (JSON)
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <div>
            {report.ok ? (
              <StatusPill tone="success">Chain verified</StatusPill>
            ) : (
              <StatusPill tone="warning">{problem ? "Problem found" : "Not verified"}</StatusPill>
            )}
          </div>
          <FactList
            items={[
              { label: "Events checked", value: <span className="num-tabular">{v.checked.toLocaleString("en-US")} of {v.events.toLocaleString("en-US")}</span> },
              { label: "Sealed through", value: <span className="num-tabular">seq {v.sealedThrough}</span> },
              { label: "Newest event", value: <span className="num-tabular">seq {v.headSeq}</span> },
              { label: "First problem", value: problem ? `seq ${problem.seq}: ${KIND[problem.kind].title}` : "None found" },
              { label: "Key id", value: <span className="id-mono">{v.keyId}</span> },
              {
                label: "Last anchor",
                value: !report.anchorFile.configured
                  ? "No anchor file is configured (HLOS_AUDIT_ANCHOR_PATH)"
                  : last
                    ? `seq ${last.seq}, exported ${fmtFull(last.at)}`
                    : report.anchorFile.error
                      ? "Unavailable"
                      : "None exported yet",
              },
              { label: "Anchors checked", value: <span className="num-tabular">{v.anchorsChecked}</span> },
              { label: "Verified at", value: fmtFull(v.verifiedAt) },
            ]}
          />
        </div>
      </Card>
    </div>
  );
}
