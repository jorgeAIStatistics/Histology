"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CommandError } from "@/components/ui/command-button";
import { SimulatedLabel } from "@/components/domain/honesty";
import { useCommand } from "@/lib/client/command";
import { CLARIFICATION_CATEGORY } from "@/lib/domain";
import { fmtTime } from "@/lib/time";
import { CtrlEnterBadge } from "@/components/ui/ctrl-enter-badge";
import { Segs, stackFrame, useBackToScan, type StepFrame } from "./bits";
import { segs, type NextAction } from "./plan";

type SendAction = Extract<NextAction, { kind: "send" }>;

interface DraftResult {
  notificationBody: string;
  generator: string;
}

interface SendResult {
  displayId: string;
  duplicate: boolean;
  outcome: string;
  outcomeReason: string;
}

const OUTCOME_TEXT: Record<string, string> = {
  delivered: "Delivered",
  delivery_unknown: "Delivery unknown",
  delivery_failed: "Delivery failed",
};

/**
 * Send a drafted clarification from the bench: first show the generic notice
 * the office will receive (clarification.draftMessage, the deterministic demo
 * drafter), then send it through the simulated connector (clarification.send).
 * The question itself is kept as written and stays in the secure case view.
 * The step heading ("Send CLR-0457 to Harbor Point Dermatology") belongs to the
 * decision column; this control hands it a body and an action.
 */
export function SendClarification({
  action,
  primary,
  assistantMode,
  frame = stackFrame,
}: {
  action: SendAction;
  primary: boolean;
  assistantMode: "deterministic" | "unavailable";
  frame?: StepFrame;
}) {
  const backToScan = useBackToScan();
  const [notice, setNotice] = useState<{ text: string; from: "assistant" | "standard" } | null>(null);
  const sendRef = useRef<HTMLButtonElement>(null);
  // The button that showed the notice is gone: put focus on Send so Enter (or Ctrl+Enter) continues.
  useEffect(() => {
    if (notice) sendRef.current?.focus({ preventScroll: false });
  }, [notice]);
  const draft = useCommand<DraftResult, { clarificationId: string }>("clarification.draftMessage", { refresh: false, errorToast: false });
  const send = useCommand<SendResult, { clarificationId: string; expectedVersion: number; body: string }>("clarification.send", {
    errorToast: false,
    successToast: (r) => (r.duplicate ? "Already sent. No second message was created." : `${r.displayId} sent (simulated). Connector reported: ${OUTCOME_TEXT[r.outcome] ?? r.outcome}.`),
    onSuccess: () => backToScan(),
  });
  const prepare = async () => {
    if (assistantMode === "unavailable") {
      setNotice({ text: action.notice, from: "standard" });
      return;
    }
    const out = await draft.run({ clarificationId: action.clarificationId });
    setNotice(out.ok ? { text: out.result.notificationBody.replace(/\s*\[SIMULATED — not sent\]\s*$/, ""), from: "assistant" } : { text: action.notice, from: "standard" });
  };
  const category = CLARIFICATION_CATEGORY[action.category as keyof typeof CLARIFICATION_CATEGORY] ?? action.category;

  const body = (
    <div className="space-y-2.5">
      <p className="text-sm text-ink-secondary">
        <span className="font-semibold text-ink">Drafted, not sent.</span> {category} question.
        {action.followUpAt ? ` Follow-up due ${fmtTime(action.followUpAt)} once sent.` : ""}
      </p>
      {notice ? (
        <figure key="notice" className="animate-rise-in border-t border-line pt-2">
          <figcaption className="text-sm font-medium text-ink-secondary">{action.officeName} receives only this notice</figcaption>
          <blockquote className="mt-1 text-sm text-ink">
            &ldquo;
            <Segs value={segs(notice.text)} />
            &rdquo;
          </blockquote>
          <p className="mt-1.5 text-sm text-ink-muted">
            No patient details; your question stays in the secure case view.{" "}
            {notice.from === "assistant" ? "Generic text from the deterministic demo drafter (not live AI)." : "Standard generic notice (the drafting assistant is unavailable)."}
          </p>
        </figure>
      ) : (
        <figure className="border-t border-line pt-2">
          <figcaption className="text-sm font-medium text-ink-secondary">Your question, kept as written</figcaption>
          <blockquote className="mt-1 text-sm text-ink">
            &ldquo;
            <Segs value={segs(action.question)} />
            &rdquo;
          </blockquote>
          <p className="mt-1 text-sm text-ink-muted">For the office&apos;s secure case view (simulated).</p>
        </figure>
      )}
      <p className="text-sm">
        <Link href={`/clarifications?selected=${encodeURIComponent(action.displayId)}`} className="font-medium text-brand underline-offset-2 hover:underline">
          Edit the question in Clarifications
        </Link>
      </p>
    </div>
  );

  const control = notice ? (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          ref={sendRef}
          variant={primary ? "primary" : "secondary"}
          icon={<Send />}
          loading={send.pending}
          loadingLabel="Sending..."
          aria-keyshortcuts={primary ? "Control+Enter Meta+Enter" : undefined}
          data-intake-primary={primary ? "" : undefined}
          onClick={() => void send.run({ clarificationId: action.clarificationId, expectedVersion: action.version, body: notice.text })}
        >
          Send (simulated)
          {primary ? <CtrlEnterBadge onDark /> : null}
        </Button>
        <SimulatedLabel connector="notifications" />
      </div>
      <CommandError error={send.error} />
    </div>
  ) : (
    <div className="space-y-2">
      <Button
        variant={primary ? "primary" : "secondary"}
        size={primary ? "block" : "md"}
        loading={draft.pending}
        loadingLabel="Preparing..."
        aria-keyshortcuts={primary ? "Control+Enter Meta+Enter" : undefined}
        data-intake-primary={primary ? "" : undefined}
        onClick={() => void prepare()}
      >
        Review notice, then send
        {primary ? <CtrlEnterBadge onDark /> : null}
      </Button>
      <CommandError error={send.error} />
    </div>
  );

  return frame({ body, action: control });
}
