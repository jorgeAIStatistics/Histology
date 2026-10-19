"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, useTransition, type MouseEvent } from "react";
import { useRouter } from "next/navigation";
import { ListOrdered } from "lucide-react";
import type { IntakeBench, IntakeScanResolution, ItemDetail } from "@/server/queries/intake";
import type { IntakePlan, StepKey } from "./plan";
import { resolveIntakeScanAction } from "@/app/intake/actions";
import { AlertBanner } from "@/components/ui/alert-banner";
import { Button } from "@/components/ui/button";
import { CommandButton } from "@/components/ui/command-button";
import { ConfirmDialog } from "@/components/ui/dialog";
import { ProvisionalChip } from "@/components/domain/chips";
import { StaleBanner } from "@/components/domain/stale-banner";
import { useFocusScanOnMount, useScan, useScanTarget, resolveFindRecord } from "@/lib/client/scan";
import { isDialogOpen, isEditableTarget, singleKeyShortcutsOn } from "@/lib/client/keyboard";
import { hasUnsavedChanges, unsavedLabels } from "@/lib/client/unsaved";
import { cn } from "@/lib/cn";
import { openOrder, statedIds } from "./plan";
import { ArrivalQueue, itemHref } from "./queue";
import { IdentityBand } from "./identity-band";
import { FindingBand } from "./finding-band";
import { EvidenceSheet } from "./evidence-sheet";
import { RelatedDecisionWorkspace, RelatedSection, useRelatedDecision } from "./related";
import { RoutingSection } from "./routing-card";
import { HoldsSection } from "./holds-card";
import { NotesSection } from "./notes-card";
import { OrderSection } from "./order-card";
import { CorrectionSection } from "./correction-card";
import { HistorySection } from "./history-card";
import { DecisionColumn } from "./decision-column";
import { EmptyWorkspace } from "./empty-workspace";
import { RaiseClarificationDialog, type ClarificationDraft } from "./clarification-dialog";

const STEP_KEYS: StepKey[] = ["check", "differences", "related", "routing", "accession"];

/** Below 1024px wide or 560px tall (200% zoom of a bench screen) the fixed frame becomes one page-scrolling stack. */
const STACKED_QUERY = "(max-width: 63.99875rem), (max-height: 35rem)";

function subscribeStacked(onChange: () => void) {
  const m = window.matchMedia(STACKED_QUERY);
  m.addEventListener("change", onChange);
  return () => m.removeEventListener("change", onChange);
}
/**
 * The stacked, page-scrolling layout. A decision that rests on evidence in the
 * centre (the lead's "one case or two") keeps its action pinned in the decision
 * column at bench sizes; stacked, the action follows the reason in the centre
 * so the column reads evidence, choices, reason, action from top to bottom.
 */
function useStacked(): boolean {
  // The server renders the bench layout (1366-1440 wide); a stacked window switches on hydration.
  return useSyncExternalStore(subscribeStacked, () => window.matchMedia(STACKED_QUERY).matches, () => false);
}

function reducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Where a step of the path lives on screen (the evidence for it, or the request). */
function stepTarget(item: ItemDetail, key: StepKey): HTMLElement | null {
  const byId = (id: string) => document.getElementById(id);
  switch (key) {
    case "check":
      return byId("evidence");
    case "differences": {
      const row = document.querySelector<HTMLElement>("#evidence tr[id^='row-']");
      return row ?? byId("evidence-counts") ?? byId("evidence");
    }
    case "related":
      return byId("related-orders") ?? byId("evidence");
    case "routing":
      return byId("routing");
    case "accession":
      return item.accession ? byId("history") : byId("accession-request");
  }
}

function ItemWorkspace({
  bench,
  item,
  plan,
  busy,
  queueCount,
  queueOpen,
  onToggleQueue,
  onRaise,
  onOpenItem,
  stepRef,
}: {
  bench: IntakeBench;
  item: ItemDetail;
  plan: IntakePlan;
  busy: boolean;
  queueCount: number;
  queueOpen: boolean;
  onToggleQueue: () => void;
  onRaise: (d: ClarificationDraft) => void;
  onOpenItem: (displayId: string) => void;
  stepRef: { current: ((key: StepKey) => void) | null };
}) {
  const [active, setActive] = useState<StepKey | null>(null);
  const jump = useCallback(
    (key: StepKey) => {
      setActive(key);
      const el = stepTarget(item, key);
      if (!el) return;
      const behavior = reducedMotion() ? "auto" : "smooth";
      if (window.matchMedia(STACKED_QUERY).matches) {
        // Stacked layout: the page scrolls; land the target just under the top bar (the only pinned chrome).
        const bar = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--hlo-topbar-h")) || 52;
        window.scrollTo({ top: Math.max(0, el.getBoundingClientRect().top + window.scrollY - bar - 8), behavior });
      } else {
        el.scrollIntoView({ block: key === "differences" ? "center" : "start", behavior });
      }
      const focusable = el.matches("button, a, [tabindex]") ? el : (el.closest<HTMLElement>("[tabindex='-1']") ?? el);
      focusable.focus({ preventScroll: true });
    },
    [item],
  );
  useEffect(() => {
    stepRef.current = jump;
    return () => {
      stepRef.current = null;
    };
  }, [jump, stepRef]);

  const { permissions, now } = bench;
  // The related-order decision, when it is this person's next step: one state for its choices and "Record decision".
  const relAction = plan.next?.action?.kind === "review_related" ? plan.next.action : null;
  const relCand = relAction ? (item.related.find((r) => r.id === relAction.candidateId) ?? null) : null;
  const relState = useRelatedDecision(item, relCand, bench.siblings);
  const stacked = useStacked();
  // The two submissions side by side, then the choices, lead the centre at every size: the choices never
  // appear without the conflicting information (never folded into the decision column).
  const lead = !!relCand && !!relState;
  const stated = useMemo(() => statedIds(plan), [plan]);
  return (
    <section aria-label="Intake workspace" aria-busy={busy || undefined} className="animate-swap-in flex min-h-0 min-w-0 flex-1 flex-col">
      <h2 className="sr-only">
        {item.accession ? `Intake item ${item.displayId}, accessioned as ${item.accession.number}` : `Provisional intake item ${item.displayId}`}
      </h2>
      {/* While the next item loads, this one stays readable but is visibly on its way out (no skeleton flash on J/K). */}
      <div className={cn("flex min-h-0 min-w-0 flex-1 flex-col transition-opacity duration-[var(--hlo-duration-base)]", busy && "opacity-55 delay-150")}>
        <IdentityBand item={item} queueCount={queueCount} queueOpen={queueOpen} onToggleQueue={onToggleQueue} />
        {/* Fixed frame: finding over the evidence, the decision column beside both. The DOM (and tab) order is
            finding, decision, evidence, so the stacked layout below 1024px wide or 560px tall (200% zoom) reads
            the next step before the evidence and the page scrolls instead of the panes. */}
        {/* The centre keeps at least 12rem (it scrolls inside); when the bands above it grow past that (large text,
            banners), the whole workspace scrolls in its column rather than clipping the evidence or the controls. */}
        <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_336px] grid-rows-[auto_minmax(12rem,1fr)] min-[87.5rem]:grid-cols-[minmax(0,1fr)_352px] max-xl:grid-cols-[minmax(0,1fr)_324px] stacked:flex stacked:flex-col">
          <FindingBand plan={plan} active={active} onStep={jump} className="col-start-1 row-start-1" />
          <DecisionColumn
            bench={bench}
            item={item}
            plan={plan}
            onRaise={onRaise}
            onOpenItem={onOpenItem}
            related={relState ? { state: relState, recordHere: !stacked } : null}
            className="col-start-2 row-span-2 row-start-1"
          />
          <div className={cn("relative col-start-1 row-start-2 min-h-0 min-w-0 space-y-4 overflow-y-auto p-4 max-xl:p-3 stacked:overflow-visible", lead && "pt-2 max-xl:pt-2")}>
            {/* The lead's decision leads the centre: both submissions side by side, then the choices and the reason. The evidence follows (key 2). */}
            {lead && relCand && relState ? <RelatedDecisionWorkspace item={item} cand={relCand} s={relState} withRecord={stacked} /> : null}
            <EvidenceSheet item={item} permissions={permissions} now={now} onRaise={onRaise} stated={stated} />
            <RelatedSection item={item} siblings={bench.siblings} permissions={permissions} readOnly={bench.readOnly} now={now} onRaise={onRaise} exclude={lead ? relCand?.id : null} />
            <div className="rounded-lg border border-line bg-surface">
              <RoutingSection item={item} permissions={permissions} pathologists={bench.pathologists} readOnly={bench.readOnly} now={now} />
              <HoldsSection item={item} now={now} />
              <NotesSection item={item} permissions={permissions} now={now} />
              <OrderSection item={item} now={now} />
              <CorrectionSection item={item} permissions={permissions} now={now} />
              <HistorySection item={item} now={now} />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

/**
 * Intake workstation (/intake): one fixed frame. Left, the arrival queue with
 * the courier summary in its header. Then the identity band (the part set as
 * its specimen label), the finding band (finding, hold scope, five steps), the
 * evidence sheet, and the decision column with this person's next step and the
 * accession request. Nothing that decides the next action scrolls away.
 *
 * Keys: the scan field has focus on load and gets it back after an action.
 * ArrowUp/ArrowDown move the queue from the scan field; J/K move it when the
 * scan field is empty or not focused; Esc on an empty scan field goes to the
 * selected queue row; 1 to 5 jump to the steps; Ctrl/Cmd+Enter runs only the
 * step that carries the visible Ctrl badge and never the container check.
 */
export function IntakeWorkstation({ bench }: { bench: IntakeBench }) {
  const router = useRouter();
  const scan = useScan();
  const [isPending, startTransition] = useTransition();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [ping, setPing] = useState<{ displayId: string; n: number } | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [draft, setDraft] = useState<ClarificationDraft | null>(null);
  const [matches, setMatches] = useState<Extract<IntakeScanResolution, { kind: "items" }> | null>(null);
  const [unpack, setUnpack] = useState<Extract<IntakeScanResolution, { kind: "unpack" }> | null>(null);
  const [leaveTo, setLeaveTo] = useState<string | null>(null);
  const [announce, setAnnounce] = useState("");
  const stepRef = useRef<((key: StepKey) => void) | null>(null);
  const item = bench.selected;
  const plan = bench.plan;
  const order = useMemo(() => openOrder(bench.queue), [bench.queue]);
  const done = useMemo(() => bench.queue.filter((q) => q.lane === "done"), [bench.queue]);
  const shortNames = useMemo(() => Object.fromEntries(bench.pathologists.map((p) => [p.name, p.shortName])), [bench.pathologists]);
  const delivery = bench.deliveries.find((d) => d.id === bench.activeDeliveryId) ?? null;
  const openCount = bench.counts.exceptions + bench.counts.to_review;

  // Where the last move or scan is taking us: rapid J/K presses chain from it, not from the item still on screen.
  const targetRef = useRef<string | null>(null);
  const navigate = useCallback(
    (displayId: string) => {
      targetRef.current = displayId;
      setPendingId(displayId);
      setDrawerOpen(false);
      startTransition(() => router.push(itemHref(displayId), { scroll: false }));
    },
    [router],
  );
  const go = useCallback(
    (displayId: string) => {
      if (displayId === (targetRef.current ?? item?.displayId)) return;
      if (hasUnsavedChanges()) {
        setLeaveTo(displayId);
        return;
      }
      navigate(displayId);
    },
    [item?.displayId, navigate],
  );
  const onRowOpen = (e: MouseEvent<HTMLAnchorElement>, displayId: string) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    go(displayId);
  };

  useFocusScanOnMount();
  useScanTarget(
    "Find intake item",
    async (value, { navigate: nav }) => {
      const r = await resolveIntakeScanAction(value);
      setMatches(null);
      setUnpack(null);
      switch (r.kind) {
        case "item":
          setPing({ displayId: r.displayId, n: Date.now() });
          go(r.displayId);
          // The evidence sheet says what a scan does not do, once, while the bottle still needs its check.
          return { tone: "success", message: r.message };
        case "items":
          setMatches(r);
          return { tone: "info", message: r.message };
        case "case":
          nav(`/cases/${encodeURIComponent(r.accession)}`);
          return { tone: "info", message: r.message };
        case "unpack":
          setUnpack(r);
          return {
            tone: "info",
            message: `${r.message} Choose "Unpack this requisition (simulated)" on the page.`,
          };
        default: {
          const f = resolveFindRecord(value);
          if ("href" in f && !f.href.startsWith("/intake")) {
            nav(f.href);
            return { tone: "info", message: f.message };
          }
          return { tone: "warning", message: r.message };
        }
      }
    },
    { placeholder: "Scan order id, INT id or label text" },
  );

  // Announce the item in hand and bring its queue row into view.
  useEffect(() => {
    if (item && targetRef.current === item.displayId) targetRef.current = null;
    if (!item) return;
    const t = window.setTimeout(() => setAnnounce(`Now working on ${item.accession ? `${item.accession.number}` : `provisional intake item ${item.displayId}`}`), 60);
    document.querySelector<HTMLElement>(`[data-queue-item="${item.displayId}"]`)?.scrollIntoView({ block: "nearest" });
    return () => window.clearTimeout(t);
  }, [item?.id, item?.displayId, item?.accession]);

  // Opening the queue drawer (bench tablet) puts focus on the selected row.
  const selectedDisplay = item?.displayId ?? null;
  useEffect(() => {
    if (!drawerOpen) return;
    let tries = 0;
    let t = 0;
    // The drawer becomes visible over a frame or two; keep trying briefly until focus lands on the row.
    const attempt = () => {
      const row =
        (selectedDisplay && document.querySelector<HTMLElement>(`[data-queue-item="${selectedDisplay}"]`)) || document.querySelector<HTMLElement>("[data-queue-item]");
      row?.focus();
      if (row && document.activeElement !== row && tries++ < 8) t = window.setTimeout(attempt, 50);
    };
    t = window.setTimeout(attempt, 30);
    return () => window.clearTimeout(t);
  }, [drawerOpen, selectedDisplay]);

  // Keyboard model (one listener; the latest values come through a ref).
  const latest = useRef({ order, done, item, go, drawerOpen, plan });
  useEffect(() => {
    latest.current = { order, done, item, go, drawerOpen, plan };
  });
  const focusScan = scan.focus;
  const setResult = scan.setResult;
  useEffect(() => {
    const isScan = (t: EventTarget | null): t is HTMLInputElement => t instanceof HTMLInputElement && t.id === "scan-field";
    const focusRow = () => {
      const { item: it } = latest.current;
      const narrow = window.innerWidth < 1280;
      if (narrow) setDrawerOpen(true);
      window.setTimeout(
        () => {
          const row = (it && document.querySelector<HTMLElement>(`[data-queue-item="${it.displayId}"]`)) || document.querySelector<HTMLElement>("[data-queue-item]");
          row?.focus();
        },
        narrow ? 60 : 0,
      );
    };
    const move = (delta: number) => {
      const { order: o, done: d, item: it, go: g } = latest.current;
      const list = it && it.lane === "done" ? [...o, ...d] : o;
      if (!list.length) return;
      const from = targetRef.current ?? it?.displayId ?? null;
      const idx = from ? list.findIndex((q) => q.displayId === from) : -1;
      const next = idx < 0 ? (delta > 0 ? list[0] : list[list.length - 1]) : list[Math.max(0, Math.min(list.length - 1, idx + delta))];
      if (next && next.displayId !== from) {
        setPing({ displayId: next.displayId, n: Date.now() });
        g(next.displayId);
      }
    };
    const runPrimary = () => {
      const mark = document.querySelector<HTMLElement>("[data-intake-primary]");
      const el = mark && (mark.matches("button, a") ? mark : mark.querySelector<HTMLElement>("button, a"));
      if (el) {
        // The step's details are folded (a short column with "Also yours now" open): show them first, run nothing.
        const unfold = el.closest("[data-folded]")?.querySelector<HTMLElement>("[data-unfold]");
        if (unfold) {
          unfold.click();
          setResult({ tone: "info", message: "The step details are shown again. Check them, then press Ctrl+Enter again to run the step." });
          return;
        }
        if (el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true") {
          const why = el.getAttribute("aria-describedby");
          const text = why
            ? why
                .split(" ")
                .map((id) => document.getElementById(id)?.textContent ?? "")
                .join(" ")
                .trim()
            : "";
          setResult({
            tone: "info",
            message: text || "The current step cannot run yet.",
          });
          return;
        }
        el.focus();
        el.click();
        return;
      }
      const verify = document.querySelector<HTMLElement>("[data-intake-verify]");
      if (verify) {
        verify.focus();
        setResult({
          tone: "info",
          message: "Ctrl+Enter never records a container check. Check the bottle, then press Enter on “Record: I checked this bottle against the order”.",
        });
        return;
      }
      setResult({
        tone: "info",
        message: "Nothing for you to run on this item right now.",
      });
    };
    const onCapture = (e: KeyboardEvent) => {
      // Esc on an empty scan field goes to the queue (before the field's own Esc handling).
      if (e.key !== "Escape" || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || isDialogOpen()) return;
      if (isScan(e.target) && !e.target.value) {
        e.preventDefault();
        e.stopPropagation();
        focusRow();
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (isDialogOpen()) return;
      const t = e.target;
      const inScan = isScan(t);
      const editable = isEditableTarget(t);
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !e.altKey) {
        // The decision column, or a decision laid out in the centre (its reason field), runs the badged step.
        const inDecision = t instanceof HTMLElement && !!t.closest("[aria-label='Decision'], [data-intake-decision]");
        if (editable && !inScan && !inDecision) return;
        e.preventDefault();
        runPrimary();
        return;
      }
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.key === "Escape" && latest.current.drawerOpen) {
        setDrawerOpen(false);
        document.querySelector<HTMLElement>("[aria-controls='intake-queue']")?.focus();
        return;
      }
      const onRow = t instanceof HTMLElement && t.hasAttribute("data-queue-item");
      const onBody = t === document.body || (t instanceof HTMLElement && t.id === "main");
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        if (inScan || onRow || onBody) {
          e.preventDefault();
          move(e.key === "ArrowDown" ? 1 : -1);
          if (onRow)
            window.setTimeout(() => document.querySelector<HTMLElement>("[data-queue-item][aria-busy='true'], [data-queue-item][aria-current='true']")?.focus(), 0);
        }
        return;
      }
      if (!singleKeyShortcutsOn() || e.shiftKey) return;
      const k = e.key;
      // J/K: from the scan field only while it is empty (and only the lowercase key, so a scanned "K..." still types).
      if (k === "j" || k === "k") {
        if (inScan ? t.value === "" : !editable) {
          e.preventDefault();
          move(k === "j" ? 1 : -1);
        }
        return;
      }
      if (/^[1-5]$/.test(k) && !editable && latest.current.plan) {
        e.preventDefault();
        stepRef.current?.(STEP_KEYS[Number(k) - 1]);
      }
    };
    window.addEventListener("keydown", onCapture, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onCapture, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [setResult, focusScan]);

  return (
    <div className="relative grid h-[calc(100dvh-var(--hlo-topbar-h))] grid-cols-[280px_minmax(0,1fr)] overflow-hidden min-[87.5rem]:grid-cols-[296px_minmax(0,1fr)] max-xl:grid-cols-[minmax(0,1fr)] stacked:h-auto stacked:min-h-[calc(100dvh-var(--hlo-topbar-h))] stacked:overflow-visible">
      <h1 className="sr-only">Intake</h1>
      <ArrivalQueue
        queue={bench.queue}
        delivery={delivery}
        now={bench.now}
        selectedId={item?.id ?? null}
        pendingId={isPending ? pendingId : null}
        ping={ping}
        shortNames={shortNames}
        drawerOpen={drawerOpen}
        onCloseDrawer={() => setDrawerOpen(false)}
        onOpen={onRowOpen}
      />
      <div className="relative flex min-h-0 min-w-0 flex-col overflow-y-auto stacked:overflow-visible">
        {!bench.source.available ? (
          <StaleBanner
            className="m-3 mb-0"
            sourceName="EMA-SIM Sunrise Coast (accession source)"
            since={bench.source.lastSuccessAt}
            now={bench.now}
            detail="Request accession is unavailable. Verification, routing and related-order review still work locally."
          />
        ) : null}
        {unpack ? (
          <AlertBanner
            className="m-3 mb-0"
            tone="info"
            title={unpack.message}
            action={
              <div className="flex flex-wrap items-center gap-2">
                <CommandButton
                  command="intake.receivePhysicalItem"
                  input={{
                    deliveryId: unpack.deliveryId,
                    physicalItemId: unpack.physicalItemId,
                  }}
                  size="sm"
                  variant="primary"
                  pendingLabel="Unpacking..."
                  disabledReason={bench.permissions.receive ? undefined : "Your demo role cannot receive items."}
                  onSuccess={(r) => {
                    setUnpack(null);
                    navigate((r as { displayId: string }).displayId);
                  }}
                >
                  Unpack this requisition (simulated)
                </CommandButton>
                <Button size="sm" variant="secondary" onClick={() => setUnpack(null)}>
                  Not now
                </Button>
              </div>
            }
          >
            Unpacking logs the requisition and its containers from courier {unpack.deliveryDisplay}. It does not verify them.
          </AlertBanner>
        ) : null}
        {matches ? (
          <AlertBanner
            className="m-3 mb-0"
            tone="info"
            title={matches.message}
            action={
              <Button size="sm" variant="secondary" onClick={() => setMatches(null)}>
                Close
              </Button>
            }
          >
            <ol className="mt-1 flex flex-wrap gap-2">
              {matches.matches.map((m, i) => (
                <li key={m.displayId} className="flex items-center gap-1.5 text-sm">
                  <span className="text-ink-muted">{i + 1}.</span>
                  <ProvisionalChip id={m.displayId} compact />
                  <span className="text-ink-secondary">{m.label}</span>
                </li>
              ))}
            </ol>
          </AlertBanner>
        ) : null}
        {bench.selectedNotFound ? (
          <AlertBanner className="m-3 mb-0" tone="warning" title={`No intake item "${bench.selectedNotFound}"`}>
            Check the id, or scan the requisition order id instead.
          </AlertBanner>
        ) : null}
        {item && plan ? (
          <ItemWorkspace
            key={item.id}
            bench={bench}
            item={item}
            plan={plan}
            busy={isPending}
            queueCount={openCount}
            queueOpen={drawerOpen}
            onToggleQueue={() => setDrawerOpen((o) => !o)}
            onRaise={setDraft}
            onOpenItem={go}
            stepRef={stepRef}
          />
        ) : (
          <>
            <div className="px-4 pt-3 xl:hidden">
              <button
                type="button"
                onClick={() => setDrawerOpen((o) => !o)}
                aria-expanded={drawerOpen}
                aria-controls="intake-queue"
                className="inline-flex min-h-11 items-center gap-1.5 rounded-md border border-line-strong bg-surface px-3 text-sm font-semibold text-ink"
              >
                <ListOrdered className="size-4" aria-hidden />
                Queue <span className="font-normal text-ink-muted">({openCount})</span>
              </button>
            </div>
            <EmptyWorkspace bench={bench} onOpenItem={go} />
          </>
        )}
      </div>
      <span className="sr-only" aria-live="polite">
        {announce}
      </span>
      <RaiseClarificationDialog draft={draft} onClose={() => setDraft(null)} />
      <ConfirmDialog
        open={leaveTo !== null}
        title={`Leave without saving and open ${leaveTo ?? "the next item"}?`}
        confirmLabel="Discard and open"
        cancelLabel="Stay and keep editing"
        destructive
        onCancel={() => setLeaveTo(null)}
        onConfirm={() => {
          const to = leaveTo;
          setLeaveTo(null);
          if (to) navigate(to);
        }}
      >
        <p className="text-sm text-ink">Unsaved: {unsavedLabels().join("; ") || "a form on this item"}. Values never carry over to another item.</p>
      </ConfirmDialog>
    </div>
  );
}
