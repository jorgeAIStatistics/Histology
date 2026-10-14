"use client";

import { AlertBanner } from "@/components/ui/alert-banner";
import { Button } from "@/components/ui/button";
import { PageBody, PageHeader } from "@/components/ui/page-header";

/** Route error state (spec §6.0 Error): what happened, what is kept, how to retry. */
export default function IntakeError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <PageBody>
      <PageHeader title="Intake" />
      <AlertBanner
        tone="danger"
        blocking
        title="Could not load the intake bench"
        action={
          <Button variant="primary" size="sm" onClick={() => reset()}>
            Retry
          </Button>
        }
      >
        Nothing was changed. Recorded verifications, clarifications and requests are kept in the local demo database. {error.digest ? `Reference ${error.digest}.` : ""}
      </AlertBanner>
    </PageBody>
  );
}
