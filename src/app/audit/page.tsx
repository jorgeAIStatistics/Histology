import { requireView } from "@/server/auth/guard";
import { getDb } from "@/server/db/db";
import { activeAuditKey, auditReport, type AuditReport } from "@/server/core/audit-seal";
import { AlertBanner } from "@/components/ui/alert-banner";
import { Card } from "@/components/ui/card";
import { PageBody, PageHeader } from "@/components/ui/page-header";
import { AuditIntegrityPanel } from "@/components/audit/audit-integrity-panel";

export const dynamic = "force-dynamic";
export const metadata = { title: "Audit trail integrity" };

/**
 * /audit: the audit trail's integrity check, for the laboratory administrator
 * and the auditor (view.audit, through the one guard, before anything is
 * read). Shows the result of a fresh verification of the HMAC chain (no audit
 * event content: counts, seq numbers, the key id and anchors only), and offers
 * "Verify again" and the evidence download (src/components/audit).
 */
export default async function AuditPage() {
  await requireView("view.audit");
  const key = activeAuditKey();
  let report: AuditReport | null = null;
  let failed = false;
  if (key) {
    try {
      report = auditReport(getDb(), key);
    } catch (e) {
      console.error("[audit] verification failed to run", e instanceof Error ? e.message : e);
      failed = true;
    }
  }

  return (
    <PageBody className="max-w-[1100px]">
      <PageHeader
        title="Audit trail integrity"
        description="Every audit event is sealed into an HMAC chain when it is written. This check recomputes the chain and compares it with the anchors exported outside the database."
      />
      {!key ? (
        <AlertBanner tone="warning" title="No audit key is configured">
          The chain cannot be verified without HLOS_AUDIT_KEY. Nothing was checked.
        </AlertBanner>
      ) : null}
      {failed ? (
        <AlertBanner tone="warning" title="Verification could not run">
          The local database could not be read. Nothing was changed. Reload the page to try again.
        </AlertBanner>
      ) : null}
      {report ? <AuditIntegrityPanel initial={report} /> : null}
      <Card title="What this check can and cannot show" variant="quiet" headingLevel={2}>
        <ul className="flex max-w-[85ch] list-disc flex-col gap-1.5 pl-5 text-sm text-ink-secondary">
          <li>It detects events edited, deleted, inserted or reordered after they were sealed, and seals made without the key.</li>
          <li>
            It cannot stop anyone from changing the database file, and it cannot catch someone who holds both the database and the audit key and
            rewrites history after the newest anchor. Anchors catch such a rewrite only before the newest anchor, and only if the anchor file is kept
            where that person cannot change it.
          </li>
          <li>It is not independence from the database administrators, and it is not a compliance attestation.</li>
          <li>Run it regularly, export anchors (npm run audit:anchor) to storage outside this server, and keep the evidence downloads.</li>
        </ul>
      </Card>
    </PageBody>
  );
}
