"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";
import { MessageSquareReply, PackageOpen, Printer, Send, UserPen } from "lucide-react";
import { ROLE_LABEL, rolesFor } from "@/lib/roles";
import { fmtSmart, fmtTime } from "@/lib/time";
import { useCommand } from "@/lib/client/command";
import { useActor, useCan } from "@/lib/client/shell-context";
import type { ClarificationTarget, CourierTarget, GrossAckTarget, IntakeTarget, WorldEventTargets } from "@/server/queries/presenter";
import type { PrinterView } from "@/server/queries/materials";
import { Button } from "@/components/ui/button";
import { CommandError } from "@/components/ui/command-button";
import { Field, Select } from "@/components/ui/field";
import { printerName } from "@/components/materials/shared";

const linkCls = "font-medium text-brand underline decoration-brand/40 underline-offset-2 hover:decoration-brand";

/** One world event: what it simulates on the left, its target picker, action and outcome on the right. */
function EventRow({ id, icon, title, simulates, children }: { id: string; icon: ReactNode; title: string; simulates: ReactNode; children: ReactNode }) {
  return (
    <section aria-labelledby={`${id}-title`} className="grid gap-3 px-4 py-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,29rem)] lg:gap-6">
      <div className="min-w-0">
        <h3 id={`${id}-title`} className="flex items-center gap-1.5 font-semibold text-ink [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-ink-muted">
          {icon}
          {title}
        </h3>
        <div className="mt-1 max-w-[72ch] space-y-1 text-sm text-ink-secondary">{simulates}</div>
      </div>
      <div className="flex min-w-0 flex-col items-start gap-2">{children}</div>
    </section>
  );
}

/** The outcome of the last run, announced politely; it stays after the record leaves the picker. */
function Outcome({ children }: { children: ReactNode }) {
  return (
    <div role="status" aria-live="polite" className="text-sm text-ink empty:hidden">
      {children}
    </div>
  );
}

function NothingToPick({ children }: { children: ReactNode }) {
  return <p className="rounded-md border border-line bg-surface-subtle px-3 py-2 text-sm text-ink-secondary">{children}</p>;
}

// ------------------------------------------------------------------ courier bag

interface ReceiveResult {
  displayId: string;
  duplicate: boolean;
  remaining: number;
  missingParts: string[];
  routingStatus: string;
  relatedCandidates: string[];
}

function CourierEvent({ couriers }: { couriers: CourierTarget[] }) {
  const [pick, setPick] = useState(couriers[0]?.displayId ?? "");
  const current = couriers.find((c) => c.displayId === pick) ?? couriers[0] ?? null;
  const receive = useCan("intake.receive");
  const actor = useActor();
  const [outcome, setOutcome] = useState<ReactNode>(null);
  const one = useCommand<ReceiveResult, { deliveryId: string }>("intake.receivePhysicalItem", {
    errorToast: false,
    successToast: (r) => (r.duplicate ? `${r.displayId} was already unpacked. No duplicate was created.` : `${r.displayId} received (simulated unpacking)`),
    onSuccess: (r) =>
      setOutcome(
        <>
          {r.duplicate ? `${r.displayId} was already unpacked; no duplicate was created.` : `${r.displayId} received`}
          {r.missingParts.length ? `; missing container for part ${r.missingParts.join(", ")}` : ""}
          {r.routingStatus === "exception" ? "; routing exception" : ""}
          {r.relatedCandidates.length ? `; possible related order ${r.relatedCandidates.join(", ")}` : ""}. {r.remaining} still in the bag.{" "}
          <Link className={linkCls} href={`/intake?item=${encodeURIComponent(r.displayId)}`}>
            Open <span className="id-mono">{r.displayId}</span> on Intake
          </Link>
        </>,
      ),
  });
  const all = useCommand<{ received: ReceiveResult[]; alreadyReceived: number }, { deliveryId: string }>("intake.receiveAll", {
    errorToast: false,
    successToast: (r) => `${r.received.length} requisition${r.received.length === 1 ? "" : "s"} unpacked (simulated)`,
    onSuccess: (r) =>
      setOutcome(
        <>
          {r.received.length} requisition{r.received.length === 1 ? "" : "s"} received
          {r.received.length ? (
            <>
              : <span className="id-mono">{r.received.map((x) => x.displayId).join(", ")}</span>
            </>
          ) : null}
          . The bag is empty.{" "}
          <Link className={linkCls} href="/intake">
            Open Intake
          </Link>
        </>,
      ),
  });
  const busy = one.pending || all.pending;
  const receivers = rolesFor("intake.receive").map((r) => ROLE_LABEL[r]);
  const reason = receive.allowed
    ? null
    : `Unpacking receives the items as your demo role, and ${ROLE_LABEL[actor.role]} cannot receive items. Switch the demo role to ${receivers.slice(0, -1).join(", ")} or ${receivers[receivers.length - 1]} on Role and clock.`;

  return (
    <EventRow
      id="world-courier"
      icon={<PackageOpen />}
      title="Courier bag: unpack and receive"
      simulates={
        <>
          <p>
            Simulates opening the courier bag: the demo knows which requisitions and bottles are inside, a real bench does not. Each requisition becomes a provisional intake
            item on Intake, with its containers to check.
          </p>
          <p className="text-ink-muted">Recorded as received by the demo role you act as, like a scan at the bench. The courier arrival is recorded first if it was not yet.</p>
        </>
      }
    >
      {current ? (
        <>
          <Field label="Courier delivery" className="w-full">
            <Select value={current.displayId} onChange={(e) => setPick(e.target.value)} disabled={busy}>
              {couriers.map((c) => (
                <option key={c.id} value={c.displayId}>
                  {c.displayId}
                  {c.expectedAt ? `, expected ${fmtTime(c.expectedAt)} ET` : ""}: {c.remaining} of {c.total} still in the bag{c.arrivedAt ? "" : ", arrival not recorded"}
                </option>
              ))}
            </Select>
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              icon={<PackageOpen />}
              loading={one.pending}
              loadingLabel="Unpacking..."
              disabled={!!reason || all.pending}
              reasonId={reason ? "world-courier-reason" : undefined}
              onClick={() => {
                all.reset();
                void one.run({ deliveryId: current.id });
              }}
            >
              Unpack next requisition
            </Button>
            <Button
              variant="secondary"
              loading={all.pending}
              loadingLabel="Unpacking..."
              disabled={!!reason || one.pending}
              reasonId={reason ? "world-courier-reason" : undefined}
              onClick={() => {
                one.reset();
                void all.run({ deliveryId: current.id });
              }}
            >
              Unpack all ({current.remaining})
            </Button>
          </div>
          {reason ? (
            <p id="world-courier-reason" className="text-sm text-ink-secondary">
              {reason}
            </p>
          ) : null}
        </>
      ) : (
        <NothingToPick>Every requisition in today&rsquo;s courier bags is unpacked. Reset the demo data to start the day again.</NothingToPick>
      )}
      <CommandError error={one.error ?? all.error} />
      <Outcome>{outcome}</Outcome>
    </EventRow>
  );
}

// ------------------------------------------------------------------ colleague edit

function ColleagueEditEvent({ items }: { items: IntakeTarget[] }) {
  const [pick, setPick] = useState(items[0]?.displayId ?? "");
  const current = items.find((i) => i.displayId === pick) ?? items[0] ?? null;
  const [outcome, setOutcome] = useState<ReactNode>(null);
  const cmd = useCommand<{ version: number; editedBy: string }, { intakeItemId: string }>("intake.simulateColleagueEdit", {
    errorToast: false,
    successToast: (_r, input) => `Demo: Luis Benitez (simulated colleague) edited ${items.find((i) => i.id === input.intakeItemId)?.displayId ?? "the item"}`,
    onSuccess: (r, { input }) => {
      const displayId = items.find((i) => i.id === input.intakeItemId)?.displayId ?? "the item";
      setOutcome(
        <>
          {r.editedBy} (simulated colleague) saved a change to the working note of <span className="id-mono">{displayId}</span>, now version {r.version}. Anyone editing
          it from an older version gets the conflict dialog when they save.{" "}
          <Link className={linkCls} href={`/intake?item=${encodeURIComponent(displayId)}`}>
            Open <span className="id-mono">{displayId}</span> on Intake
          </Link>
        </>,
      );
    },
  });
  return (
    <EventRow
      id="world-colleague"
      icon={<UserPen />}
      title="A colleague edits an intake item"
      simulates={
        <>
          <p>
            Simulates a second accessioner, Luis Benitez (simulated colleague), saving a change to the item&rsquo;s working note while someone else has it open, so the
            stale-save protection on Intake can be shown: the open edit is never overwritten.
          </p>
          <p className="text-ink-muted">Start an edit of the owner or note on Intake (another window) first. The server still checks your demo role: a read-only role is refused.</p>
        </>
      }
    >
      {current ? (
        <>
          <Field label="Intake item" className="w-full">
            <Select value={current.displayId} onChange={(e) => setPick(e.target.value)} disabled={cmd.pending}>
              {items.map((i) => (
                <option key={i.id} value={i.displayId}>
                  {i.displayId}, {i.patientName ?? "patient not linked yet"}, {i.statusLabel.toLowerCase()}
                </option>
              ))}
            </Select>
          </Field>
          <Button variant="secondary" icon={<UserPen />} loading={cmd.pending} loadingLabel="Simulating..." onClick={() => void cmd.run({ intakeItemId: current.id })}>
            Simulate the colleague&rsquo;s edit
          </Button>
        </>
      ) : (
        <NothingToPick>No intake item is open today. Unpack a courier bag first.</NothingToPick>
      )}
      <CommandError error={cmd.error} />
      <Outcome>{outcome}</Outcome>
    </EventRow>
  );
}

// ------------------------------------------------------------------ office answer

function OfficeAnswerEvent({ clarifications }: { clarifications: ClarificationTarget[] }) {
  const [pick, setPick] = useState(clarifications[0]?.displayId ?? "");
  const current = clarifications.find((c) => c.displayId === pick) ?? clarifications[0] ?? null;
  const [outcome, setOutcome] = useState<ReactNode>(null);
  const cmd = useCommand<{ displayId: string; message: string }, { clarificationId: string }>("clarification.simulateOfficeAnswer", {
    errorToast: false,
    successToast: (r) => r.message,
    onSuccess: (r) =>
      setOutcome(
        <>
          {r.message}{" "}
          <Link className={linkCls} href={`/clarifications?selected=${encodeURIComponent(r.displayId)}`}>
            Open <span className="id-mono">{r.displayId}</span> on Clarify
          </Link>
        </>,
      ),
  });
  return (
    <EventRow
      id="world-office"
      icon={<MessageSquareReply />}
      title="The office answers a clarification"
      simulates={
        <>
          <p>
            Simulates the doctor&rsquo;s office replying to a question the lab sent. The reply is labeled &ldquo;Simulated office reply&rdquo;. It never resolves the question
            or releases a hold: a lead or supervisor still reviews it on Clarify.
          </p>
          <p className="text-ink-muted">For the laterality question on ORD-77121 the office also sends amended order ORD-77121 v2 through the simulated source, about a minute later.</p>
        </>
      }
    >
      {current ? (
        <>
          <Field label="Clarification" hint="Only questions that were sent and not answered yet. The office never received a drafted question or a failed delivery." className="w-full">
            <Select value={current.displayId} onChange={(e) => setPick(e.target.value)} disabled={cmd.pending}>
              {clarifications.map((c) => (
                <option key={c.id} value={c.displayId}>
                  {c.displayId}, {c.category.toLowerCase()}, {c.stateLabel.toLowerCase()}
                </option>
              ))}
            </Select>
          </Field>
          <p className="text-sm text-ink-secondary">
            <span className="id-mono">{current.displayId}</span> asks {current.officeName} about {current.subject}.
          </p>
          <Button variant="secondary" icon={<MessageSquareReply />} loading={cmd.pending} loadingLabel="Simulating..." onClick={() => void cmd.run({ clarificationId: current.id })}>
            Simulate office answer
          </Button>
        </>
      ) : (
        <NothingToPick>No sent question is waiting for the office. Send one on Clarify first.</NothingToPick>
      )}
      <CommandError error={cmd.error} />
      <Outcome>{outcome}</Outcome>
    </EventRow>
  );
}

// ------------------------------------------------------------------ source acknowledgment

function SourceAckEvent({ entries, now }: { entries: GrossAckTarget[]; now: string }) {
  const [pick, setPick] = useState(entries[0]?.ref ?? "");
  const current = entries.find((e) => e.ref === pick) ?? entries[0] ?? null;
  const [outcome, setOutcome] = useState<ReactNode>(null);
  const label = (e: GrossAckTarget) => `${e.accessionNumber} Part ${e.designation}`;
  const cmd = useCommand<unknown, { grossRecordId: string }>("gross.simulateSourceAck", {
    errorToast: false,
    successToast: "Simulated source acknowledgment recorded",
    onSuccess: (_r, { input }) => {
      const e = entries.find((x) => x.recordId === input.grossRecordId);
      setOutcome(
        e ? (
          <>
            <span className="id-mono">{e.accessionNumber}</span> Part {e.designation}: acknowledged by {e.sourceName ?? "the source system"} (simulated).{" "}
            <Link className={linkCls} href={`/grossing?part=${encodeURIComponent(e.ref)}`}>
              Open the gross record
            </Link>
          </>
        ) : (
          "Acknowledged by the simulated source."
        ),
      );
    },
  });
  const offlineReason = current?.sourceOffline
    ? `${current.sourceName ?? "The source system"} is offline (simulated outage), so it cannot acknowledge yet. Restore the connection on Outages and reset.`
    : null;
  return (
    <EventRow
      id="world-source-ack"
      icon={<Send />}
      title="The source system acknowledges a gross entry"
      simulates={
        <>
          <p>
            Simulates the source system (EMA-SIM) confirming that it received a gross description staff typed in by hand. Marking it entered is a staff attestation; only the
            source can acknowledge it. No real interface exists.
          </p>
        </>
      }
    >
      {current ? (
        <>
          <Field label="Gross entry" hint="Approved descriptions staff marked as entered, not yet acknowledged." className="w-full">
            <Select value={current.ref} onChange={(e) => setPick(e.target.value)} disabled={cmd.pending}>
              {entries.map((e) => (
                <option key={e.recordId} value={e.ref}>
                  {label(e)}, entered by {e.enteredBy ?? "Unknown"}
                  {e.enteredAt ? `, ${fmtSmart(e.enteredAt, now)} ET` : ""}
                  {e.sourceOffline ? " (source offline)" : ""}
                </option>
              ))}
            </Select>
          </Field>
          <Button
            variant="secondary"
            icon={<Send />}
            loading={cmd.pending}
            loadingLabel="Simulating..."
            disabled={!!offlineReason}
            reasonId={offlineReason ? "world-ack-reason" : undefined}
            onClick={() => void cmd.run({ grossRecordId: current.recordId })}
          >
            Simulate source acknowledgment
          </Button>
          {offlineReason ? (
            <p id="world-ack-reason" className="text-sm text-ink-secondary">
              {offlineReason}
            </p>
          ) : null}
        </>
      ) : (
        <NothingToPick>No gross entry is waiting for the source. Staff mark an approved description entered on Gross first.</NothingToPick>
      )}
      <CommandError error={cmd.error} />
      <Outcome>{outcome}</Outcome>
    </EventRow>
  );
}

// ------------------------------------------------------------------ printer behaviour

const BEHAVIOUR: { status: string; label: string; outcome: string }[] = [
  { status: "online", label: "Ready", outcome: "ready" },
  { status: "offline", label: "Unavailable (jobs stay queued)", outcome: "unavailable: new jobs stay queued until someone releases them" },
  { status: "simulate_timeout", label: "Time out after submission", outcome: "will time out after the next submission, leaving its outcome unknown" },
];

function PrinterEvent({ printers }: { printers: PrinterView[] }) {
  const [pick, setPick] = useState(printers[0]?.id ?? "");
  const current = printers.find((p) => p.id === pick) ?? printers[0] ?? null;
  const [choice, setChoice] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<ReactNode>(null);
  const cmd = useCommand<unknown, { printerId: string; status: string }>("printer.setStatus", {
    errorToast: false,
    successToast: (_r, input) => `${printerName(printers.find((p) => p.id === input.printerId)?.name ?? "Printer")}: ${BEHAVIOUR.find((b) => b.status === input.status)?.label.toLowerCase() ?? input.status} (simulated)`,
    onSuccess: (_r, { input }) => {
      const p = printers.find((x) => x.id === input.printerId);
      setChoice(null);
      setOutcome(
        <>
          {printerName(p?.name ?? "The printer")} {BEHAVIOUR.find((b) => b.status === input.status)?.outcome ?? input.status} (simulated).{" "}
          <Link className={linkCls} href="/materials?tab=print">
            Open the print queue
          </Link>
        </>,
      );
    },
  });
  const value = choice ?? current?.status ?? "online";
  const same = !!current && value === current.status;
  return (
    <EventRow
      id="world-printer"
      icon={<Printer />}
      title="Printer behaviour"
      simulates={
        <p>
          Simulates a label printer that is ready, unavailable, or accepts a job and then never confirms it, so the print queue can show a queued job and an unknown outcome
          that must be reconciled before any reprint. No real printer is contacted.
        </p>
      }
    >
      {current ? (
        <>
          <div className="grid w-full gap-2">
            <Field label="Printer">
              <Select
                value={current.id}
                onChange={(e) => {
                  setPick(e.target.value);
                  setChoice(null);
                }}
                disabled={cmd.pending}
              >
                {printers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {printerName(p.name)} (now {p.statusLabel.replace(/ \(simulated\)$/, "").toLowerCase()})
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Behaviour">
              <Select value={value} onChange={(e) => setChoice(e.target.value)} disabled={cmd.pending}>
                {BEHAVIOUR.map((b) => (
                  <option key={b.status} value={b.status}>
                    {b.label}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Button
            variant="secondary"
            icon={<Printer />}
            loading={cmd.pending}
            loadingLabel="Saving..."
            disabled={same}
            reasonId={same ? "world-printer-reason" : undefined}
            onClick={() => void cmd.run({ printerId: current.id, status: value })}
          >
            Set printer behaviour
          </Button>
          {same ? (
            <p id="world-printer-reason" className="text-sm text-ink-secondary">
              {printerName(current.name)} already behaves this way. Choose another behaviour.
            </p>
          ) : null}
        </>
      ) : (
        <NothingToPick>No simulated printer is configured.</NothingToPick>
      )}
      <CommandError error={cmd.error} />
      <Outcome>{outcome}</Outcome>
    </EventRow>
  );
}

// ------------------------------------------------------------------ tab

/**
 * Presenter console, "World events" (synthetic demo only): the simulated events
 * that used to sit in disclosures on the bench screens. Each lists only the
 * synthetic records it can act on now and says in words what it simulates.
 * Every command still checks everything on the server.
 */
export function WorldEventsTab({ targets }: { targets: WorldEventTargets }) {
  return (
    <section aria-labelledby="world-title" className="rounded-lg border border-line bg-surface">
      <header className="border-b border-line px-4 py-2.5">
        <h2 id="world-title" className="text-md font-bold tracking-[-0.01em] text-ink">
          Simulated world events
        </h2>
        <p className="mt-0.5 max-w-[90ch] text-sm text-ink-muted">
          What the outside world does to the lab: a courier bag, a colleague, the office, the source system, a printer. Pick the synthetic record, then run the event. Every
          run is recorded in the local history and checked by the server like any other request; apart from unpacking, each is recorded as a demo control, not as work by
          your demo role.
        </p>
      </header>
      <div className="divide-y divide-line">
        <CourierEvent couriers={targets.couriers} />
        <ColleagueEditEvent items={targets.intakeItems} />
        <OfficeAnswerEvent clarifications={targets.clarifications} />
        <SourceAckEvent entries={targets.grossAcks} now={targets.now} />
        <PrinterEvent printers={targets.printers} />
      </div>
    </section>
  );
}
