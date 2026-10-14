"use client";

import { RotateCw } from "lucide-react";
import { CommandButton } from "@/components/ui/command-button";

/** Retry one failed inbound message from the failure queue (supervisor; the server checks the role). */
export function RetryEventButton({ eventId, messageId, canRetry }: { eventId: string; messageId: string; canRetry: boolean }) {
  return (
    <CommandButton
      command="integration.retryEvent"
      input={{ eventId }}
      size="sm"
      icon={<RotateCw />}
      pendingLabel="Retrying..."
      aria-label={`Retry message ${messageId}`}
      disabledReason={canRetry ? undefined : "Only the operations supervisor can retry (server-checked)."}
      successToast={(r) => {
        const x = r as { outcome: string; detail: string };
        return x.outcome === "failed" ? `Retry of ${messageId} failed again: ${x.detail}` : `Retried ${messageId}: ${x.outcome.replace(/_/g, " ")}.`;
      }}
    >
      Retry
    </CommandButton>
  );
}
