"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, CircleCheck, ClipboardList, FilePen, FolderOpen, Send, TriangleAlert, UserCheck } from "lucide-react";
import { cn } from "@/lib/cn";
import { ROLE_LABEL, type Role } from "@/lib/roles";
import type { FinalizeBlocker, GrossFields } from "@/lib/gross";
import { emptyGrossFields } from "@/lib/gross";
import { PROCEDURE, SOURCE_UPDATE_STATE, type GrossState } from "@/lib/domain";
import { fmtSmart } from "@/lib/time";
import { useCommand, type CommandFailure, type CommandOutcome } from "@/lib/client/command";
import { useConflict } from "@/lib/client/conflict";
import { useScanTarget } from "@/lib/client/scan";
import { useUnsavedChanges } from "@/lib/client/unsaved";
import { useActor, useCan, isReadOnlyRole } from "@/lib/client/shell-context";
import { useToast } from "@/components/ui/toast";
import { AlertBanner } from "@/components/ui/alert-banner";
import { Button, ButtonLink, DisabledReason } from "@/components/ui/button";
import { Card, FactList } from "@/components/ui/card";
import { CommandError } from "@/components/ui/command-button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Textarea } from "@/components/ui/field";
import { Kbd } from "@/components/ui/kbd";
import { PageBody } from "@/components/ui/page-header";
import { StatePill, StatusPill } from "@/components/ui/status-pill";
import { Timeline, sourceFromOrigin } from "@/components/ui/timeline";
import { IdentityBar } from "@/components/domain/identity-bar";
import { HoldBanner } from "@/components/domain/hold";
import { SimulatedLabel, UnknownValue } from "@/components/domain/honesty";
import { Timestamp } from "@/components/domain/timestamp";
import type { PartWorkspace } from "@/server/queries/grossing";
import { FieldRow, fromModel, sameModel, toModel, type EditorModel } from "./field-editors";
import { composeNarrative, FIELD_LABEL, FIELD_ORDER, fmtFieldValue, onRefreshedVersion, scanToGrossingHref, type FieldKey, type StoredField } from "./model";
import { PartsStrip } from "./parts-strip";
import { StatusStepper } from "./status-stepper";
import { TranscriptPane } from "./transcript-pane";

type Summary = { id: string; version: number; recordVersion: number; state: GrossState; sourceUpdateState: string; blockers: FinalizeBlocker[] };
type ApproveResult = {
  record: Summary;
  blocksCreated: string[];
  blocks: { id: string; label: string; identifier: string; eligibleForProcessing: boolean; heldBy: string[] }[];
  tasks: { id: string; kind: string; title: string; owner: string | null }[];
  otherParts: { designation: string; status: string }[];
  worklistSummary: string;
};

const TASK_KIND_LABEL: Record<string, string> = {
  source_entry: "Source-system entry",
  processing_eligible: "Processing eligibility",
  gross_review: "Review",
};

function versionOf(result: unknown): number | null {
  if (!result || typeof result !== "object") return null;
  const r = result as { version?: unknown; record?: { version?: unknown } };
  if (typeof r.version === "number") return r.version;
  if (r.record && typeof r.record.version === "number") return r.record.version;
  return null;
}

/** Conflict rows for a gross record: compare the fields I tried to change with the newer saved version. */
function grossConflictRows(
  details: unknown,
  input: Record<string, unknown> | null,
  procedure: string | null,
  base: { fields: GrossFields; narrative: string; state: string } | null,
) {
  const current = (details as { current?: Record<string, unknown> } | undefined)?.current;
  if (!current || !input) return undefined;
  let theirsFields: GrossFields;
  try {
    theirsFields = { ...emptyGrossFields(procedure), ...(JSON.parse(String(current.fields ?? "{}")) as Partial<GrossFields>) };
  } catch {
    return undefined;
  }
  const rows: { field: string; label: string; theirs: unknown; yours: unknown }[] = [];
  const describe = (k: FieldKey, v: StoredField | undefined) => (v ? `${fmtFieldValue(k, v.value)} (${v.status.replace("_", " ")})` : "Not entered");
  if (typeof input.field === "string") {
    const k = input.field as FieldKey;
    rows.push({ field: k, label: FIELD_LABEL[k], theirs: describe(k, theirsFields[k] as StoredField), yours: `${fmtFieldValue(k, input.value)} (confirm)` });
  }
  const patch = input.patch as Record<string, { value: unknown }> | undefined;
  if (patch) {
    for (const [k, v] of Object.entries(patch)) {
      const key = k as FieldKey;
      rows.push({ field: key, label: FIELD_LABEL[key], theirs: describe(key, theirsFields[key] as StoredField), yours: fmtFieldValue(key, v?.value) });
    }
  }
  if (typeof input.narrative === "string") rows.push({ field: "narrative", label: "Narrative", theirs: String(current.narrative ?? ""), yours: input.narrative });
  // What the other person changed since the version these edits were based on (fields I did not touch).
  if (base) {
    const mine = new Set(rows.map((r) => r.field));
    for (const k of FIELD_ORDER) {
      if (mine.has(k)) continue;
      const theirs = theirsFields[k] as StoredField | undefined;
      const was = base.fields[k] as StoredField | undefined;
      if (JSON.stringify(theirs?.value ?? null) === JSON.stringify(was?.value ?? null) && theirs?.status === was?.status) continue;
      rows.push({ field: k, label: FIELD_LABEL[k], theirs: describe(k, theirs), yours: `${describe(k, was)}, not changed by you` });
    }
    if (typeof input.narrative !== "string" && String(current.narrative ?? "") !== base.narrative) {
      rows.push({ field: "narrative", label: "Narrative", theirs: String(current.narrative ?? ""), yours: "Not changed by you" });
    }
    if (String(current.state ?? "") !== base.state) {
      rows.push({ field: "state", label: "Record state", theirs: String(current.state ?? "").replace(/_/g, " "), yours: `${base.state.replace(/_/g, " ")}, not changed by you` });
    }
  }
  return rows;
}

const BLOCKER_GROUPS: { key: string; test: RegExp; title: string }[] = [
  { key: "proposed", test: /was proposed from the transcript and has not been confirmed$/, title: "Proposed, not yet confirmed" },
  { key: "missing", test: / is missing$/, title: "Missing" },
];

/** "6 values to confirm, 1 missing, 1 needs review, narrative is empty" (counts by kind, never a score). */
function blockerSummary(blockers: FinalizeBlocker[]): string {
  const fieldItems = blockers.filter((b) => b.field !== "narrative");
  const toConfirm = fieldItems.filter((b) => BLOCKER_GROUPS[0].test.test(b.message)).length;
  const missing = fieldItems.filter((b) => BLOCKER_GROUPS[1].test.test(b.message)).length;
  const review = fieldItems.filter((b) => /needs review/.test(b.message)).length;
  const other = fieldItems.length - toConfirm - missing - review;
  const parts: string[] = [];
  if (toConfirm) parts.push(`${toConfirm} value${toConfirm === 1 ? "" : "s"} to confirm`);
  if (missing) parts.push(`${missing} missing`);
  if (review) parts.push(`${review} need${review === 1 ? "s" : ""} review`);
  if (other) {
    const names = [...new Set(fieldItems.filter((b) => !BLOCKER_GROUPS.some((g) => g.test.test(b.message)) && !/needs review/.test(b.message)).map((b) => FIELD_LABEL[b.field as FieldKey]?.toLowerCase() ?? b.field))];
    parts.push(`${names.join(" and ")} to check`);
  }
  const narr = blockers.filter((b) => b.field === "narrative");
  if (narr.some((b) => /empty/.test(b.message))) parts.push("narrative is empty");
  else if (narr.length) parts.push("narrative needs a check");
  return parts.join(", ");
}

function withoutLabel(message: string, label: string): string {
  return label && message.startsWith(label) ? message.slice(label.length).trim() : message;
}

/** Blockers grouped by kind; each field name moves focus to that field. */
function BlockerList({ blockers, onGo }: { blockers: FinalizeBlocker[]; onGo: (k: FieldKey) => void }) {
  const goTo = (field: string, text?: string) =>
    field === "narrative" ? (
      <span>{text ?? "Narrative"}</span>
    ) : (
      <button type="button" onClick={() => onGo(field as FieldKey)} className="rounded-sm font-medium text-brand underline underline-offset-2 hover:text-brand-hover">
        {text ?? FIELD_LABEL[field as FieldKey] ?? field}
      </button>
    );
  const grouped = BLOCKER_GROUPS.map((g) => ({ ...g, items: blockers.filter((b) => g.test.test(b.message)) })).filter((g) => g.items.length);
  const rest = blockers.filter((b) => !BLOCKER_GROUPS.some((g) => g.test.test(b.message)));
  return (
    <ul className="mt-1 flex flex-col gap-1">
      {grouped.map((g) => (
        <li key={g.key}>
          <span className="text-ink">{g.title}: </span>
          {g.items.map((b, i) => (
            <span key={b.field}>
              {i ? ", " : ""}
              {goTo(b.field)}
            </span>
          ))}
        </li>
      ))}
      {rest.map((b, i) => (
        <li key={`r${i}`}>
          {b.field === "narrative" ? (
            <span className="text-ink">
              {b.message}. {/empty/.test(b.message) ? "Compose it from the confirmed values or type it, then save." : "Use the choices in the Narrative card."}
            </span>
          ) : (
            <>
              {goTo(b.field)}
              <span className="text-ink">
                : {withoutLabel(b.message, FIELD_LABEL[b.field as FieldKey] ?? "")}
                {/^Cassette piece total/.test(b.message)
                  ? ". Cassette pieces count specimen pieces; for a bisected or trisected specimen, describe the cut pieces in Contents instead."
                  : ""}
              </span>
            </>
          )}
        </li>
      ))}
    </ul>
  );
}

export function GrossingWorkspace({ ws }: { ws: PartWorkspace }) {
  const router = useRouter();
  const toast = useToast();
  const conflict = useConflict();
  const actor = useActor();
  const readOnly = isReadOnlyRole(actor.role);
  const canEdit = useCan("gross.edit");
  const canReview = useCan("gross.review");
  const canApprove = useCan("gross.approve");
  const canCassettes = useCan("gross.confirmCassettes");
  const canSource = useCan("gross.recordSourceEntry");

  const id = ws.identity;
  const rec = ws.record;
  const partLabel = `${id.accessionNumber} Part ${id.designation}`;
  const partActive = id.partStatus === "active" && id.caseStatus !== "canceled";
  const frozen = !rec || rec.state === "approved_for_downstream" || rec.state === "superseded" || !partActive;
  const fields: GrossFields = rec?.fields ?? emptyGrossFields(id.procedure);
  const approvalHolds = ws.holds.filter((h) => h.blocksApproval);
  const narrativeStale = rec?.narrativeStale ?? [];

  // ---------------------------------------------------------------- local edit state (never carried to another part)
  const [drafts, setDrafts] = useState<Partial<Record<FieldKey, EditorModel>>>({});
  const [narrativeDraft, setNarrativeDraft] = useState<string | null>(null);
  const [activeField, setActiveField] = useState<FieldKey | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<FieldKey, string>>>({});
  const [pendingField, setPendingField] = useState<FieldKey | null>(null);
  const [pendingNav, setPendingNav] = useState<string | null>(null);
  const [lastApproval, setLastApproval] = useState<ApproveResult | null>(null);
  const [flagOpen, setFlagOpen] = useState(false);
  const [flagNote, setFlagNote] = useState("");
  const [amendOpen, setAmendOpen] = useState(false);
  const [amendReason, setAmendReason] = useState("");
  const [resolveOpen, setResolveOpen] = useState(false);
  const [resolution, setResolution] = useState("");
  /** A newer version saved by someone else arrived while this screen had unsaved edits. */
  const [foreignVersion, setForeignVersion] = useState<number | null>(null);
  const [actionError, setActionError] = useState<CommandFailure | null>(null);
  const [reveal, setReveal] = useState<{ key: FieldKey; n: number } | null>(null);
  const stayRef = useRef<HTMLButtonElement | null>(null);
  const approvalRef = useRef<HTMLDivElement | null>(null);
  const keepRef = useRef<HTMLButtonElement | null>(null);

  // The version every command is checked against (optimistic concurrency). It advances with my own command results
  // (so quick successive confirms do not self-conflict) and with refreshed props ONLY while I have no unsaved edits.
  // While I have unsaved edits, a newer version from someone else is not adopted: my next save or confirm is checked
  // against the version my edits were based on, so it returns CONFLICT (with the conflict dialog) instead of silently
  // overwriting a colleague's change.
  const versionRef = useRef<number>(rec?.version ?? 0);
  /** The saved content my unsaved edits are based on (the version in versionRef), to show what someone else changed. */
  const baseRef = useRef<{ fields: GrossFields; narrative: string; state: string } | null>(rec ? { fields: rec.fields, narrative: rec.narrative ?? "", state: rec.state } : null);

  const modelFor = useCallback((k: FieldKey): EditorModel => drafts[k] ?? toModel(k, fields[k].value), [drafts, fields]);
  const dirtyKeys = useMemo(
    () => FIELD_ORDER.filter((k) => drafts[k] !== undefined && !sameModel(drafts[k]!, toModel(k, fields[k].value))),
    [drafts, fields],
  );
  const narrative = narrativeDraft ?? rec?.narrative ?? "";
  const narrativeDirty = narrativeDraft !== null && narrativeDraft !== (rec?.narrative ?? "");
  const isDirty = dirtyKeys.length > 0 || narrativeDirty;
  useUnsavedChanges(isDirty, `${partLabel} gross record`);

  useEffect(() => {
    if (!rec) return;
    const d = onRefreshedVersion(versionRef.current, rec.version, isDirty);
    if (d.adopt) {
      versionRef.current = rec.version;
      setForeignVersion(null);
    } else if (d.changedUnderEdits) {
      setForeignVersion(rec.version);
    }
    if (rec.version === versionRef.current) baseRef.current = { fields: rec.fields, narrative: rec.narrative ?? "", state: rec.state };
  }, [rec, isDirty]);

  const clearLocal = useCallback(() => {
    setDrafts({});
    setNarrativeDraft(null);
    setFieldErrors({});
  }, []);

  // ---------------------------------------------------------------- commands
  const onConflict = useCallback(
    (err: CommandFailure, input: unknown) => {
      if (err.code !== "CONFLICT") return;
      const cur = (err.details as { currentVersion?: number } | undefined)?.currentVersion;
      conflict.open({
        message: err.message,
        details: err.details,
        subject: `${partLabel} gross record`,
        fields: grossConflictRows(err.details, input as Record<string, unknown>, id.procedure, baseRef.current),
        // "Load latest and re-apply my changes": my edits are kept and the next save is checked against the latest version.
        onLoadLatest: () => {
          if (typeof cur === "number") versionRef.current = cur;
          setForeignVersion(null);
        },
        onDiscard: () => {
          if (typeof cur === "number") versionRef.current = cur;
          setForeignVersion(null);
          clearLocal();
        },
      });
    },
    [conflict, partLabel, id.procedure, clearLocal],
  );
  const opts = { conflict: false as const, errorToast: false, onError: onConflict };
  const confirmCmd = useCommand<Summary, Record<string, unknown>>("gross.confirmField", opts);
  const saveCmd = useCommand<Summary, Record<string, unknown>>("gross.updateFields", opts);
  const checkCmd = useCommand<Summary, Record<string, unknown>>("gross.updateFields", opts);
  const reviewCmd = useCommand<Summary, Record<string, unknown>>("gross.markReviewed", opts);
  const approveCmd = useCommand<ApproveResult, Record<string, unknown>>("gross.approve", opts);
  const flagCmd = useCommand<Summary, Record<string, unknown>>("gross.flagNeedsClarification", opts);
  const resolveCmd = useCommand<Summary, Record<string, unknown>>("gross.resolveClarification", opts);
  const amendCmd = useCommand<{ record: Summary }, Record<string, unknown>>("gross.amend", opts);
  const startCmd = useCommand<{ record: Summary }, Record<string, unknown>>("gross.startDraft", { errorToast: false });
  const loadCmd = useCommand<{ record: Summary; counts: { proposed: number; needsReview: number; missing: number }; ignoredInstructions: string[] }, Record<string, unknown>>(
    "gross.loadTranscript",
    opts,
  );
  const entryCmd = useCommand<Summary, Record<string, unknown>>("gross.recordSourceEntry", opts);
  const ackCmd = useCommand<Summary, Record<string, unknown>>("gross.simulateSourceAck", { errorToast: false });

  const track = <R,>(out: CommandOutcome<R>): CommandOutcome<R> => {
    if (out.ok) {
      const v = versionOf(out.result);
      if (v !== null) versionRef.current = v;
      setActionError(null);
    } else if (out.error.code !== "CONFLICT") setActionError(out.error);
    return out;
  };

  const focusField = useCallback((k: FieldKey) => {
    setActiveField(k);
    const el = document.getElementById(`gf-${k}`) as HTMLElement | null;
    if (el) {
      el.focus();
      el.scrollIntoView({ block: "nearest" });
    }
  }, []);

  const nextUnconfirmed = useCallback(
    (after: FieldKey | null): FieldKey | null => {
      const start = after ? FIELD_ORDER.indexOf(after) + 1 : 0;
      for (let i = 0; i < FIELD_ORDER.length; i++) {
        const k = FIELD_ORDER[(start + i) % FIELD_ORDER.length];
        if (fields[k].status !== "confirmed" && k !== after) return k;
      }
      return null;
    },
    [fields],
  );

  const confirmField = async (k: FieldKey, how: { acknowledgeReview?: boolean } = {}) => {
    if (!rec || frozen) return;
    const stored = fields[k] as StoredField;
    if (stored.status === "needs_review" && !how.acknowledgeReview && !dirtyKeys.includes(k)) {
      // Enter / Confirm never accepts an uncertain value as shown: it needs an edit or the explicit "checked" step.
      setFieldErrors((e) => ({ ...e, [k]: "Needs review: enter the value you observed, or check the specimen and use “Checked: keep as dictated”." }));
      return;
    }
    const conv = fromModel(k, modelFor(k));
    if (!conv.ok) {
      setFieldErrors((e) => ({ ...e, [k]: conv.error }));
      return;
    }
    if (conv.value === null) {
      setFieldErrors((e) => ({ ...e, [k]: "Enter the value you observed before confirming." }));
      return;
    }
    setFieldErrors((e) => ({ ...e, [k]: undefined }));
    setPendingField(k);
    // An unedited proposal is confirmed exactly as proposed (no value sent), so nothing reads as "changed by the operator".
    const asProposed = !dirtyKeys.includes(k) && (stored.status === "proposed" || (stored.status === "needs_review" && how.acknowledgeReview));
    const out = track(
      await confirmCmd.run({
        grossRecordId: rec.id, expectedVersion: versionRef.current, field: k, ...(asProposed ? {} : { value: conv.value }), ...(how.acknowledgeReview ? { acknowledgeReview: true } : {}),
      }),
    );
    setPendingField(null);
    if (out.ok) {
      setDrafts((d) => {
        const n = { ...d };
        delete n[k];
        return n;
      });
      const next = nextUnconfirmed(k);
      if (next) window.setTimeout(() => focusField(next), 50);
    } else if (out.error.code !== "CONFLICT") {
      setFieldErrors((e) => ({ ...e, [k]: out.error.message }));
      setActionError(null);
    }
  };

  const saveDraft = async (): Promise<boolean> => {
    if (!rec || frozen) return false;
    const patch: Record<string, { value: unknown }> = {};
    const errs: Partial<Record<FieldKey, string>> = {};
    for (const k of dirtyKeys) {
      const conv = fromModel(k, drafts[k]!);
      if (!conv.ok) errs[k] = conv.error;
      else patch[k] = { value: conv.value };
    }
    if (Object.keys(errs).length) {
      setFieldErrors((e) => ({ ...e, ...errs }));
      return false;
    }
    const out = track(
      await saveCmd.run({ grossRecordId: rec.id, expectedVersion: versionRef.current, patch, ...(narrativeDirty ? { narrative: narrativeDraft } : {}) }),
    );
    if (out.ok) {
      clearLocal();
      toast.show({ tone: "success", title: Object.keys(patch).length ? "Draft saved. Typed values still need confirmation." : "Narrative saved." });
      return true;
    }
    return false;
  };

  const compose = () => setNarrativeDraft(composeNarrative(fields, { designation: id.designation, site: id.site }));
  const markNarrativeChecked = async () => {
    if (!rec || frozen) return;
    const out = track(await checkCmd.run({ grossRecordId: rec.id, expectedVersion: versionRef.current, patch: {}, narrativeChecked: true }));
    if (out.ok) toast.show({ tone: "success", title: "Narrative checked against the confirmed values" });
  };

  const resolveClarification = async () => {
    if (!rec) return;
    const out = track(await resolveCmd.run({ grossRecordId: rec.id, expectedVersion: versionRef.current, resolution: resolution.trim() }));
    if (out.ok) {
      setResolveOpen(false);
      setResolution("");
    }
  };

  const markReviewed = async () => {
    if (!rec) return;
    track(await reviewCmd.run({ grossRecordId: rec.id, expectedVersion: versionRef.current }));
  };

  const approve = async () => {
    if (!rec) return;
    const out = track(await approveCmd.run({ grossRecordId: rec.id, expectedVersion: versionRef.current }));
    if (out.ok) {
      // The inline result banner (scrolled into view and focused) is the confirmation; no toast over the downstream card.
      setLastApproval(out.result);
      setActiveField(null);
    }
  };

  const attach = async (key: string) => {
    const out = track(await loadCmd.run({ specimenPartId: id.partId, transcriptKey: key, ...(rec ? { expectedVersion: versionRef.current } : {}) }));
    if (out.ok) {
      clearLocal();
      const c = out.result.counts;
      toast.show({
        tone: "info",
        title: `Proposed values ready: ${c.proposed} proposed, ${c.needsReview} need review, ${c.missing} missing`,
        body: "Nothing is confirmed until you confirm it.",
      });
    }
  };

  // Keep focused fields clear of the sticky next-step bar at the bottom (WCAG 2.4.11 focus not obscured).
  useEffect(() => {
    const html = document.documentElement;
    const before = html.style.scrollPaddingBottom;
    html.style.scrollPaddingBottom = "6rem";
    return () => {
      html.style.scrollPaddingBottom = before;
    };
  }, []);

  // After approval, bring the outcome (downstream tasks, eligibility) into view and give it focus.
  useEffect(() => {
    if (!lastApproval || !approvalRef.current) return;
    approvalRef.current.scrollIntoView({ block: "center" });
    approvalRef.current.focus({ preventScroll: true });
  }, [lastApproval]);

  // ---------------------------------------------------------------- navigation guard (no cross-case carryover)
  const guardLink = (href: string) => (e: MouseEvent) => {
    if (!isDirty || e.metaKey || e.ctrlKey || e.shiftKey) return;
    e.preventDefault();
    setPendingNav(href);
  };

  // Any in-app link (side nav, top bar, other screens' links) asks first while there are unsaved edits.
  useEffect(() => {
    if (!isDirty) return;
    const onClick = (e: globalThis.MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target instanceof Element ? e.target.closest("a[href]") : null) as HTMLAnchorElement | null;
      if (!a || (a.target && a.target !== "_self") || a.hasAttribute("download")) return;
      const url = new URL(a.href, window.location.href);
      if (url.origin !== window.location.origin) return;
      if (url.pathname === window.location.pathname && url.search === window.location.search) return;
      e.preventDefault();
      e.stopPropagation();
      setPendingNav(`${url.pathname}${url.search}${url.hash}`);
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [isDirty]);

  useScanTarget(
    "Open part",
    (value) => {
      const r = scanToGrossingHref(value);
      if ("error" in r) return { tone: "danger", message: r.error, alert: true };
      if (r.href === `/grossing?part=${encodeURIComponent(id.ref)}`) return { tone: "info", message: `Already working on ${partLabel}.` };
      if (isDirty) {
        setPendingNav(r.href);
        return { tone: "warning", message: `Unsaved changes for ${partLabel}. Save the draft, discard the changes, or stay.` };
      }
      router.push(r.href);
      return { tone: "success", message: r.message };
    },
    { placeholder: "Scan a cassette label or type D26-04817 A" },
  );

  // ---------------------------------------------------------------- derived UI state
  const blockers = ws.blockers;
  const stateCanReview = rec && rec.state === "draft";
  const reviewReason: string | null = !rec
    ? "Start the gross record first."
    : readOnly
      ? "Read only role."
      : !canReview.allowed
        ? canReview.reason
        : rec.state === "operator_reviewed"
          ? "Already marked operator reviewed."
          : rec.state === "needs_clarification"
            ? "Flagged as needing clarification. Record how it was resolved first (returns the record to draft)."
            : !stateCanReview
            ? "This version is frozen."
            : isDirty
              ? "Save or confirm your edits first."
              : blockers.length
                ? `Cannot mark reviewed yet: ${blockers.length} item${blockers.length === 1 ? "" : "s"} need${blockers.length === 1 ? "s" : ""} attention (listed above).`
                : null;
  const approveReason: string | null = !rec
    ? "Start the gross record first."
    : rec.state === "approved_for_downstream"
      ? "Already approved for downstream use."
      : rec.state === "superseded"
        ? "Superseded by a newer version."
        : !canApprove.allowed
          ? `${canApprove.reason} Approval needs a grosser, supervisor or dermatopathologist.`
          : isDirty
            ? "Save or confirm your edits first."
            : blockers.length
              ? `Cannot approve yet: ${blockers.length} item${blockers.length === 1 ? "" : "s"} need${blockers.length === 1 ? "s" : ""} attention (listed above).`
              : approvalHolds.length
                ? `Cannot approve: ${approvalHolds.map((h) => `${h.displayId} (${h.reasonText})`).join("; ")} blocks approval for this part.`
                : rec.state === "needs_clarification"
                  ? "Flagged as needing clarification. Record how it was resolved, then mark it reviewed."
                  : rec.state !== "operator_reviewed"
                  ? "Mark the record operator reviewed first."
                  : null;
  // One sentence for the sticky next-step bar; it is also the visible reason for its disabled buttons.
  const barTone: "warning" | "ready" | "info" =
    !rec || frozen ? "info" : isDirty && foreignVersion !== null ? "warning" : readOnly || isDirty ? "info" : !reviewReason || !approveReason ? "ready" : "warning";
  const barText: string = !rec
    ? ""
    : readOnly
      ? "Read only role: you can view this record but not change it."
      : !canReview.allowed && !canApprove.allowed
        ? `${canReview.reason} Review and approval need a grosser or supervisor.`
        : isDirty && foreignVersion !== null
          ? `Someone else saved version ${foreignVersion} while you were editing. Confirming or saving shows what changed; nothing is overwritten.`
          : isDirty
          ? `Unsaved edits${dirtyKeys.length ? ` (${dirtyKeys.map((k) => FIELD_LABEL[k].toLowerCase()).join(", ")})` : ""}${narrativeDirty ? `${dirtyKeys.length ? " and" : ""} narrative` : ""}. Confirm each value or save the draft first.`
          : rec.state === "needs_clarification"
            ? "Flagged as needing clarification. Record how it was resolved to return it to draft."
            : blockers.length
              ? `Not ready for review: ${blockerSummary(blockers)}.`
              : rec.state === "draft"
                ? reviewReason
                  ? reviewReason
                  : `Ready to mark operator reviewed. Approval comes after review${approvalHolds.length ? `, and stays blocked by ${approvalHolds.map((h) => h.displayId).join(", ")} until a lead releases it` : ""}.`
                : approveReason ?? "Operator reviewed. Ready to approve for downstream use.";

  const nextAction: (() => void) | null = !rec
    ? null
    : !reviewReason && stateCanReview
      ? markReviewed
      : !approveReason
        ? approve
        : null;

  const onWorkspaceKeyDown = (e: ReactKeyboardEvent) => {
    if (e.altKey && e.key === "ArrowDown") {
      const cur = (document.activeElement?.closest("[data-field]") as HTMLElement | null)?.dataset.field as FieldKey | undefined;
      const next = nextUnconfirmed(cur ?? null);
      if (next) {
        e.preventDefault();
        focusField(next);
      }
    }
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && nextAction) {
      e.preventDefault();
      nextAction();
    }
  };

  const sourceOffline = ws.sourceSystem && ws.sourceSystem.status !== "connected";
  /** "EMA-SIM Sunrise Coast" (the "(simulated source adapter)" suffix is said once by the Simulated label). */
  const sourceName = ws.sourceSystem ? ws.sourceSystem.name.replace(/\s*\(simulated[^)]*\)\s*$/i, "") : "source system";
  const openTasks = ws.tasks.filter((t) => t.status === "open" || t.status === "in_progress");
  const doneTasks = ws.tasks.filter((t) => !(t.status === "open" || t.status === "in_progress"));
  const otherPartsText = ws.parts
    .filter((p) => p.partId !== id.partId)
    .map((p) => `Part ${p.designation}: ${p.state === "awaiting" ? "awaiting grossing" : p.state === "on_hold" ? `on hold (${p.holdIds.join(", ")})` : p.state.replace(/_/g, " ")}`)
    .join("; ");

  const holdScope = (h: { scopeType: string; scopeLabel: string }) =>
    h.scopeType === "accession" ? `Case ${id.accessionNumber}` : /\bpart\s+([A-Z])\b/i.test(h.scopeLabel) ? `Part ${/\bpart\s+([A-Z])\b/i.exec(h.scopeLabel)![1].toUpperCase()}` : h.scopeLabel;
  const holdScopes = ws.holds.map(holdScope);
  const labelField = fields.container_label_matches as StoredField;
  const partWarning =
    labelField.status === "needs_review" && /Laterality differs/.test(labelField.note ?? "")
      ? "Dictated container label laterality differs from the part site. Check the container; nothing is corrected automatically."
      : undefined;

  return (
    <div onKeyDown={onWorkspaceKeyDown}>
      <IdentityBar
        identity={{ kind: "accession", accession: id.accessionNumber, namespace: id.namespace }}
        part={{
          letter: id.designation,
          description: `${id.site.toLowerCase()}, ${id.procedure ? PROCEDURE[id.procedure as keyof typeof PROCEDURE]?.toLowerCase() ?? id.procedure : "procedure unknown"}`,
          warning: partWarning,
        }}
        patient={id.patientName ? { name: id.patientName, mrn: id.mrn, tenant: id.tenantName } : null}
        office={id.officeName}
        doctor={id.pathologist ? { name: id.pathologist.name, color: id.pathologist.color } : null}
        holds={holdScopes.length ? [...new Set(holdScopes)] : undefined}
        contextKey={`${id.accessionNumber}:${id.designation}`}
        actions={
          <>
            <ButtonLink href={`/cases/${encodeURIComponent(id.accessionNumber)}`} size="sm" variant="ghost" icon={<FolderOpen />} onClick={guardLink(`/cases/${encodeURIComponent(id.accessionNumber)}`)}>
              Open case
            </ButtonLink>
          </>
        }
      />
      <PageBody>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <Link href="/grossing" onClick={guardLink("/grossing")} className="inline-flex items-center gap-1 text-sm text-brand hover:underline">
            <ArrowLeft className="size-4" aria-hidden /> Grossing queue
          </Link>
          <h1 className="text-lg font-semibold text-ink">
            Gross record <span className="sr-only">for {partLabel}</span>
          </h1>
          {rec ? <StatePill domain="gross" state={rec.state} /> : <StatusPill tone="neutral">Not started</StatusPill>}
          <span aria-hidden className="mx-1 hidden h-6 w-px bg-line sm:block" />
          <PartsStrip parts={ws.parts} currentPartId={id.partId} onNavigate={guardLink} />
        </div>
        <StatusStepper state={rec?.state ?? null} sourceUpdateState={rec?.sourceUpdateState ?? null} recordVersion={rec?.recordVersion ?? null} />

        {readOnly ? (
          <AlertBanner tone="info" title="Read only">
            {actor.name} can view but not change records in this demo. The server checks permissions on every action.
          </AlertBanner>
        ) : null}
        {id.partStatus !== "active" || id.caseStatus === "canceled" ? (
          <AlertBanner tone="warning" title={id.partStatus !== "active" ? `${partLabel} is ${id.partStatus}` : `Case ${id.accessionNumber} is canceled`}>
            Gross documentation cannot change for a canceled part or case. The server refuses drafting, confirming, approving and amending.
          </AlertBanner>
        ) : null}
        {foreignVersion !== null && isDirty && rec && !frozen ? (
          <AlertBanner tone="warning" title="Changed by someone else while you were editing" headingLevel={2}>
            <p>
              {partLabel} was saved by someone else (now version {foreignVersion}). Your unsaved edits are kept and are based on the version you opened. Saving or confirming
              will show what changed so you can choose; nothing is overwritten silently.
            </p>
            <div className="mt-1.5">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  versionRef.current = foreignVersion;
                  setForeignVersion(null);
                  clearLocal();
                }}
              >
                Discard my edits and show the latest
              </Button>
            </div>
          </AlertBanner>
        ) : null}

        {ws.holds.map((h) => (
          <HoldBanner
            key={h.id}
            scope={holdScope(h)}
            reason={h.reasonText}
            otherScopeNote={otherPartsText && h.scopeType !== "accession" ? "Other parts of this case are not affected by this hold." : undefined}
            clarification={h.clarificationDisplayId ? { displayId: h.clarificationDisplayId, href: `/clarifications?selected=${h.clarificationDisplayId}`, state: h.clarificationState?.replace(/_/g, " ") } : undefined}
            owner={h.owner}
            nextFollowUpAt={h.nextFollowUpAt}
            now={ws.now}
          >
            <p className="mt-1 text-sm text-ink">
              {h.displayId} placed {fmtSmart(h.placedAt, ws.now)} ET by {h.placedBy ?? "Unknown"}. Blocks: {h.blocks.map((b) => b.replace(/_/g, " ")).join(", ")}.{" "}
              {h.blocksApproval ? "Drafting and confirming can continue; approval for downstream use stays blocked until the hold is released by a lead." : ""}
            </p>
          </HoldBanner>
        ))}

        {lastApproval ? (
          <div ref={approvalRef} tabIndex={-1} className="rounded-md focus:outline-none focus-visible:outline-2">
          <AlertBanner tone="success" title={`${partLabel} approved for downstream use`} headingLevel={2}>
            <p>{lastApproval.worklistSummary}.</p>
            <ul className="mt-1 list-disc pl-5">
              {lastApproval.tasks.map((t) => (
                <li key={t.id}>
                  {t.title}
                  {t.owner ? <span className="whitespace-nowrap"> · Owner: {t.owner}</span> : null}
                </li>
              ))}
              {lastApproval.blocksCreated.length ? <li>Blocks recorded: {lastApproval.blocksCreated.join(", ")} (location unknown until confirmed)</li> : null}
            </ul>
            <p className="mt-1">The case is not complete. Source-system entry is pending; nothing was written to the source system.</p>
          </AlertBanner>
          </div>
        ) : null}

        <div className="grid grid-cols-1 gap-4 min-[1200px]:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
          <div className="min-w-0 min-[1200px]:sticky min-[1200px]:top-[calc(var(--hlo-chrome-h)+var(--hlo-identity-h)+1rem)] min-[1200px]:max-h-[calc(100vh-var(--hlo-chrome-h)-var(--hlo-identity-h)-2rem)] min-[1200px]:self-start min-[1200px]:overflow-auto">
            <TranscriptPane
              transcript={ws.transcript}
              fields={rec ? fields : null}
              activeField={frozen ? null : activeField}
              reveal={reveal}
              onSelectField={focusField}
              assistantMode={ws.assistantMode}
              options={ws.transcriptOptions}
              frozen={frozen && Boolean(rec)}
              attachDisabledReason={readOnly ? "Read only role." : !canEdit.allowed ? canEdit.reason : !partActive ? "Part or case is canceled." : null}
              onAttach={attach}
              attaching={loadCmd.pending}
              attachError={loadCmd.error && loadCmd.error.code !== "CONFLICT" ? loadCmd.error : null}
              now={ws.now}
              extractedWithoutText={Boolean(rec?.extractor) && !ws.transcript}
            />
          </div>

          <div className="flex min-w-0 flex-col gap-4">
            <Card
              title="Structured fields"
              description={
                rec
                  ? `Template ${fields.template_id} (synthetic). Nothing is pre-filled; numbers, units and counts each need your confirmation.`
                  : "Start the record or attach a dictation. Template defaults are never filled in as observations."
              }
              bodyClassName="flex flex-col gap-2"
            >
              {!rec ? (
                <div className="flex flex-col items-start gap-2">
                  <Button
                    variant="primary"
                    icon={<FilePen />}
                    loading={startCmd.pending}
                    loadingLabel="Starting..."
                    disabled={readOnly || !canEdit.allowed || !partActive}
                    reasonId={readOnly || !canEdit.allowed ? "start-reason" : undefined}
                    onClick={() => void startCmd.run({ specimenPartId: id.partId })}
                  >
                    Start gross record
                  </Button>
                  {readOnly || !canEdit.allowed ? <DisabledReason id="start-reason">{canEdit.reason ?? "Read only role."}</DisabledReason> : null}
                  <CommandError error={startCmd.error} />
                </div>
              ) : (
                <>
                {!frozen && (readOnly || !canReview.allowed) ? (
                  <p id="gross-role-reason" className="rounded-sm border border-line bg-surface-subtle px-2 py-1.5 text-sm text-ink-secondary">
                    {readOnly ? "Read only role." : canReview.reason} Confirming values needs a grosser, histology assistant or supervisor. The server checks this on every action.
                  </p>
                ) : null}
                {FIELD_ORDER.map((k) => {
                  const stored = fields[k] as StoredField;
                  const model = modelFor(k);
                  const confirmBlocked = readOnly
                    ? "Read only role."
                    : !canReview.allowed
                      ? canReview.reason
                      : k === "cassettes" && !canCassettes.allowed
                        ? `${canCassettes.reason} Cassette allocation is confirmed by the grosser or a supervisor.`
                        : null;
                  return (
                    <FieldRow
                      key={k}
                      fieldKey={k}
                      stored={stored}
                      model={model}
                      dirty={dirtyKeys.includes(k)}
                      onModel={(m) => setDrafts((d) => ({ ...d, [k]: m }))}
                      onConfirm={() => void confirmField(k)}
                      onKeepAsDictated={() => void confirmField(k, { acknowledgeReview: true })}
                      onRevert={() =>
                        setDrafts((d) => {
                          const n = { ...d };
                          delete n[k];
                          return n;
                        })
                      }
                      onShowEvidence={() => {
                        setActiveField(k);
                        setReveal((r) => ({ key: k, n: (r?.n ?? 0) + 1 }));
                      }}
                      onFocusField={() => setActiveField(k)}
                      active={activeField === k}
                      frozen={frozen}
                      confirmBlockedReason={confirmBlocked}
                      sharedReasonId={readOnly || !canReview.allowed ? "gross-role-reason" : undefined}
                      editBlockedReason={readOnly ? "Read only role." : !canEdit.allowed ? canEdit.reason : null}
                      pending={pendingField === k && confirmCmd.pending}
                      error={fieldErrors[k] ?? null}
                      partDesignation={id.designation}
                      now={ws.now}
                    />
                  );
                })}
                {!frozen ? (
                  <p className="text-xs text-ink-muted">
                    Keyboard: <Kbd>Enter</Kbd> confirms the field · <Kbd>Alt</Kbd>+<Kbd>↓</Kbd> next unconfirmed field · <Kbd>Ctrl</Kbd>/<Kbd>⌘</Kbd>+<Kbd>Enter</Kbd> next step (review, then approve)
                  </p>
                ) : null}
                </>
              )}
            </Card>

            {rec ? (
              <Card
                title="Narrative"
                description="Free text for the gross description. It is entered in the source system by hand after approval."
                actions={
                  !frozen ? (
                    <Button variant="ghost" size="sm" disabled={readOnly || !canEdit.allowed} onClick={compose}>
                      Compose from confirmed values
                    </Button>
                  ) : null
                }
                bodyClassName="flex flex-col gap-2"
              >
                {narrativeStale.length && !frozen && !narrativeDirty ? (
                  <AlertBanner tone="warning" title="Check the narrative against the confirmed values">
                    <p>
                      It was written before {narrativeStale.map((k) => FIELD_LABEL[k].toLowerCase()).join(" and ")} {narrativeStale.length === 1 ? "was" : "were"} confirmed, so it
                      may still say what was dictated. Compose it again, edit it, or confirm it already matches.
                    </p>
                    {!readOnly && canEdit.allowed ? (
                      <div className="mt-1.5 flex flex-wrap gap-2">
                        <Button variant="secondary" size="sm" onClick={compose}>
                          Compose again
                        </Button>
                        <Button variant="secondary" size="sm" loading={checkCmd.pending} loadingLabel="Recording..." onClick={() => void markNarrativeChecked()}>
                          Checked: it matches
                        </Button>
                      </div>
                    ) : null}
                  </AlertBanner>
                ) : null}
                {frozen ? (
                  <div>
                    <p className="text-xs font-medium text-ink-secondary">Narrative for {partLabel} · frozen with version {rec.recordVersion}</p>
                    <p className="mt-1 whitespace-pre-wrap rounded-sm border border-line bg-surface-subtle px-3 py-2 text-sm text-ink">
                      {narrative || <UnknownValue reason="no narrative was saved" />}
                    </p>
                  </div>
                ) : (
                  <Field
                    label={`Narrative for ${partLabel}`}
                    required
                    hint="Composing uses confirmed values only; anything unconfirmed is marked, never filled in. Edit before saving."
                  >
                    <Textarea rows={5} value={narrative} readOnly={readOnly || !canEdit.allowed} onChange={(e) => setNarrativeDraft(e.target.value)} />
                  </Field>
                )}
              </Card>
            ) : null}

            {rec ? (
              <Card title="Review and approval" bodyClassName="flex flex-col gap-3">
                {blockers.length && !frozen ? (
                  <AlertBanner tone="warning" title={`Cannot approve yet: ${blockers.length} item${blockers.length === 1 ? "" : "s"} need${blockers.length === 1 ? "s" : ""} attention`}>
                    <BlockerList blockers={blockers} onGo={focusField} />
                  </AlertBanner>
                ) : null}

                {rec.state === "approved_for_downstream" ? (
                  <AlertBanner tone="success" title={`Approved for downstream use (version ${rec.recordVersion})`}>
                    Approved by {rec.approvedBy ?? "Unknown"} at <Timestamp iso={rec.approvedAt} now={ws.now} />. Content is frozen; corrections create a new version and supersede this one.
                  </AlertBanner>
                ) : null}

                {!frozen ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <Button variant="quiet" size="sm" disabled={readOnly || !canEdit.allowed} onClick={() => setFlagOpen(true)}>
                      Flag needs clarification
                    </Button>
                    <span className="text-xs text-ink-muted">Parks the draft with your note while a question is open.</span>
                  </div>
                ) : rec.state === "approved_for_downstream" && partActive ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <Button variant="secondary" disabled={readOnly || !canApprove.allowed} reasonId={!canApprove.allowed ? "amend-reason" : undefined} onClick={() => setAmendOpen(true)}>
                      Amend (creates version {rec.recordVersion + 1})
                    </Button>
                    {!canApprove.allowed ? <DisabledReason id="amend-reason">{canApprove.reason} Amendments need a grosser, supervisor or dermatopathologist.</DisabledReason> : null}
                  </div>
                ) : null}
                {rec.state === "needs_clarification" ? (
                  <AlertBanner tone="warning" title="Needs clarification">
                    {rec.unresolved.filter((u) => u.field === "clarification" && !u.resolvedAt).map((u, i) => (
                      <p key={i}>
                        {u.message}
                        {u.by ? ` (${u.by})` : ""}
                      </p>
                    ))}
                    <p className="mt-1">
                      To ask the office, raise a clarification from the <Link className="text-brand underline" href={`/cases/${encodeURIComponent(id.accessionNumber)}`}>case</Link>. When it is answered, record how it was resolved; the record returns to draft and can then be reviewed.
                    </p>
                    <div className="mt-1.5">
                      <Button variant="secondary" size="sm" disabled={readOnly || !canEdit.allowed} onClick={() => setResolveOpen(true)}>
                        Record resolution (return to draft)
                      </Button>
                    </div>
                  </AlertBanner>
                ) : null}
                {rec.state !== "needs_clarification" && rec.unresolved.some((u) => u.field === "clarification" && u.resolvedAt) ? (
                  <ul className="flex flex-col gap-0.5 text-sm text-ink-secondary" aria-label="Resolved grossing questions">
                    {rec.unresolved
                      .filter((u) => u.field === "clarification" && u.resolvedAt)
                      .map((u, i) => (
                        <li key={i}>
                          Question &quot;{u.message}&quot; resolved by {u.resolvedBy ?? "Unknown"}: {u.resolution}
                        </li>
                      ))}
                  </ul>
                ) : null}
              </Card>
            ) : null}

            {rec && !frozen && !readOnly ? (
              <section
                aria-label={`Next step for ${partLabel}`}
                className="sticky bottom-3 z-10 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-line-strong bg-surface px-3 py-2 shadow-2"
              >
                <div className="flex flex-wrap items-center gap-2">
                  {isDirty ? (
                    <Button variant="secondary" size="sm" loading={saveCmd.pending} loadingLabel="Saving..." onClick={() => void saveDraft()}>
                      Save draft
                    </Button>
                  ) : null}
                  {rec.state !== "operator_reviewed" ? (
                    <Button
                      variant={reviewReason ? "secondary" : "primary"}
                      size="sm"
                      loading={reviewCmd.pending}
                      loadingLabel="Marking..."
                      disabled={Boolean(reviewReason)}
                      reasonId={reviewReason ? "gross-bar-reason" : undefined}
                      onClick={() => void markReviewed()}
                    >
                      Mark operator reviewed
                    </Button>
                  ) : null}
                  <Button
                    variant={rec.state === "operator_reviewed" ? "primary" : "secondary"}
                    size="sm"
                    loading={approveCmd.pending}
                    loadingLabel="Approving..."
                    disabled={Boolean(approveReason)}
                    reasonId={approveReason ? "gross-bar-reason" : undefined}
                    onClick={() => void approve()}
                  >
                    Approve for downstream use
                  </Button>
                </div>
                <p id="gross-bar-reason" className="min-w-[12rem] flex-1 text-sm text-ink">
                  {barTone === "warning" ? <TriangleAlert className="mr-1 inline size-4 align-[-3px] text-warning-solid" aria-hidden /> : barTone === "ready" ? <CircleCheck className="mr-1 inline size-4 align-[-3px] text-success-solid" aria-hidden /> : null}
                  {barText}
                </p>
                {actionError ? <CommandError error={actionError} className="basis-full" /> : null}
              </section>
            ) : null}

            {rec && (rec.state === "approved_for_downstream" || ws.tasks.length > 0 || ws.blocks.length > 0) ? (
              <Card
                className={rec.state === "approved_for_downstream" ? "order-first" : undefined}
                title="Downstream work" description="Created from approved documentation. Eligibility is derived from the approval and active holds." bodyClassName="flex flex-col gap-3">
                {openTasks.length ? (
                  <ul className="flex flex-col gap-1.5" aria-label="Open downstream tasks">
                    {openTasks.map((t) => (
                      <li key={t.id} className="flex flex-wrap items-center gap-2 rounded-sm border border-line px-2 py-1.5 text-sm">
                        <ClipboardList className="size-4 text-ink-muted" aria-hidden />
                        <span className="text-xs font-medium text-ink-muted">{TASK_KIND_LABEL[t.kind] ?? t.kind}</span>
                        <span className="text-ink">{t.title}</span>
                        <span className="whitespace-nowrap text-ink-secondary">· Owner: {t.owner ?? (t.ownerRole ? `${ROLE_LABEL[t.ownerRole as Role] ?? t.ownerRole.replace(/_/g, " ")} on duty` : "Unassigned")}</span>
                        <StatusPill tone="info" size="sm">Open</StatusPill>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-ink-secondary">No open downstream tasks for this part.</p>
                )}
                {ws.blocks.length ? (
                  <FactList
                    items={ws.blocks.map((b) => ({
                      label: `Block ${b.label}`,
                      value: (
                        <span className="flex flex-wrap items-center gap-2">
                          <span className="id-mono text-xs text-ink-secondary" title={`Label code ${b.identifier}`}>
                            {id.accessionNumber} {b.label}
                          </span>
                          <span>{b.state === "cassette_loaded" ? "Cassette loaded (grossed)" : b.state.replace(/_/g, " ")}</span>
                          {b.eligibleForProcessing ? <StatusPill tone="success" size="sm">Eligible for processing</StatusPill> : null}
                          {b.heldBy.length ? <StatusPill tone="hold" size="sm">Held from processing ({b.heldBy.join(", ")})</StatusPill> : null}
                          {b.eligibleForProcessing && !b.hasEligibilityTask ? <span className="text-xs text-ink-muted">No processing task open yet</span> : null}
                          <span className="text-xs text-ink-muted">Pieces: {b.piecesSubmitted ?? "Unknown (not stated)"}</span>
                        </span>
                      ),
                    }))}
                  />
                ) : null}
                {ws.readiness ? (
                  <div className="text-sm">
                    <p className="text-ink">
                      Case: {ws.readiness.caseSummary}. {ws.readiness.caseComplete ? "All parts delivered." : "The case is not complete."}
                    </p>
                    {ws.readiness.blockedBy.length ? <p className="text-ink-secondary">Not ready: {ws.readiness.blockedBy.join("; ")}</p> : null}
                  </div>
                ) : null}

                {rec.state === "approved_for_downstream" ? (
                  <div className="flex flex-col gap-2 border-t border-line pt-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-sm font-semibold text-ink">Source-system entry</h3>
                      <SimulatedLabel connector={sourceName} />
                      <StatusPill
                        tone={rec.sourceUpdateState === "source_acknowledged" ? "success" : rec.sourceUpdateState === "failed" ? "danger" : rec.sourceUpdateState === "entered_attested" ? "info" : "warning"}
                        icon={rec.sourceUpdateState === "entered_attested" ? UserCheck : undefined}
                      >
                        {SOURCE_UPDATE_STATE[rec.sourceUpdateState]}
                        {sourceOffline && rec.sourceUpdateState === "pending_entry" ? ": source unreachable" : ""}
                      </StatusPill>
                    </div>
                    <p className="text-sm text-ink-secondary">
                      Entry is made by hand in the source system. Marking it entered is a staff attestation, not an acknowledgment. Only the simulated source can acknowledge in this demo.
                    </p>
                    {rec.sourceEntryAt ? (
                      <p className="text-sm text-ink">
                        Entered (staff attested) by {rec.sourceEntryBy ?? "Unknown"} at <Timestamp iso={rec.sourceEntryAt} now={ws.now} />.
                        {rec.sourceAckAt ? (
                          <>
                            {" "}
                            Acknowledged by the simulated source at <Timestamp iso={rec.sourceAckAt} now={ws.now} />.
                          </>
                        ) : (
                          " Not acknowledged by the source."
                        )}
                      </p>
                    ) : null}
                    {sourceOffline ? (
                      <AlertBanner tone="warning" title={`${sourceName} unreachable (simulated outage)`}>
                        {rec.sourceUpdateState === "pending_entry" || rec.sourceUpdateState === "failed"
                          ? "Attest only an entry you actually typed into the source system. Its acknowledgment waits until the source is back. Approval and downstream work are not affected."
                          : "The source cannot acknowledge the entry until it is back. Approval and downstream work are not affected."}
                      </AlertBanner>
                    ) : null}
                    {rec.sourceUpdateState === "pending_entry" || rec.sourceUpdateState === "failed" ? (
                      <div className="flex flex-wrap items-start gap-2">
                        <div className="flex flex-col gap-1">
                          <Button
                            variant="primary"
                            icon={<Send />}
                            loading={entryCmd.pending}
                            loadingLabel="Recording..."
                            disabled={readOnly || !canSource.allowed}
                            reasonId={!canSource.allowed ? "entry-reason" : undefined}
                            onClick={async () => void track(await entryCmd.run({ grossRecordId: rec.id, expectedVersion: versionRef.current }))}
                          >
                            Mark entered in source system (staff attestation)
                          </Button>
                          {!canSource.allowed ? (
                            <DisabledReason id="entry-reason">{canSource.reason} Attestation is recorded by the histology assistant or a supervisor.</DisabledReason>
                          ) : null}
                        </div>
                        <Button variant="secondary" disabled reasonId="ack-reason">
                          Simulate source acknowledgment (demo)
                        </Button>
                      </div>
                    ) : rec.sourceUpdateState === "entered_attested" && !readOnly ? (
                      <div className="flex flex-col items-start gap-1">
                        <Button
                          variant="secondary"
                          loading={ackCmd.pending}
                          loadingLabel="Simulating..."
                          disabled={Boolean(sourceOffline)}
                          reasonId={sourceOffline ? "ack-offline-reason" : undefined}
                          onClick={async () => void track(await ackCmd.run({ grossRecordId: rec.id }))}
                        >
                          Simulate source acknowledgment (demo)
                        </Button>
                        {sourceOffline ? <DisabledReason id="ack-offline-reason">{sourceName} is unreachable, so it cannot acknowledge yet.</DisabledReason> : null}
                      </div>
                    ) : null}
                    {rec.sourceUpdateState === "pending_entry" || rec.sourceUpdateState === "failed" ? (
                      <DisabledReason id="ack-reason">The simulated source can only acknowledge an entry that staff have marked as entered.</DisabledReason>
                    ) : null}
                    <CommandError error={actionError} />
                  </div>
                ) : null}
                {doneTasks.length ? (
                  <details className="text-sm">
                    <summary className="cursor-pointer text-ink-secondary">Closed tasks ({doneTasks.length})</summary>
                    <ul className="mt-1 flex flex-col gap-1">
                      {doneTasks.map((t) => (
                        <li key={t.id} className="text-ink-secondary">
                          {t.title} · {t.status === "done" ? "Done" : "Canceled"}
                          {t.completedAt ? <> at <Timestamp iso={t.completedAt} now={ws.now} /></> : null}
                        </li>
                      ))}
                    </ul>
                  </details>
                ) : null}
              </Card>
            ) : null}
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 min-[1200px]:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
          <Card title="Versions" bodyClassName="flex flex-col gap-1.5">
            {ws.versions.length ? (
              <ol className="flex flex-col gap-1.5">
                {ws.versions.map((v) => (
                  <li key={v.id} className={cn("flex flex-wrap items-center gap-2 text-sm", rec?.id === v.id && "font-medium")}>
                    <span className="id-mono">v{v.recordVersion}</span>
                    <StatePill domain="gross" state={v.state} size="sm" />
                    <span className="text-ink-secondary">
                      started <Timestamp iso={v.createdAt} now={ws.now} />
                      {v.approvedAt ? (
                        <>
                          {" "}
                          · approved <Timestamp iso={v.approvedAt} now={ws.now} /> by {v.approvedBy ?? "Unknown"}
                        </>
                      ) : null}
                    </span>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="text-sm text-ink-secondary">No versions yet. Starting the record creates version 1.</p>
            )}
            <FactList
              items={[
                { label: "Ordering clinician", value: id.orderingClinician ?? <UnknownValue reason="not in the source order" /> },
                { label: "Source order", value: id.sourceOrderRef ? <span className="id-mono">{id.sourceOrderRef}</span> : "Unknown" },
                { label: "Original designation", value: id.originalDesignation },
                { label: "Extractor", value: rec?.extractor ? `${rec.extractor} (deterministic demo output, not live AI)` : "None (manual entry)" },
              ]}
            />
          </Card>
          <Timeline
            title="History for this part"
            now={ws.now}
            events={ws.history.map((h) => ({
              id: String(h.seq),
              at: h.at,
              actorName: h.actor,
              summary: h.summary,
              source: sourceFromOrigin(h.origin),
            }))}
            emptyText={
              rec && (rec.reviewedAt || rec.approvedAt || rec.sourceEntryAt) ? (
                <>
                  <span className="block">No audit events: this record was created by the synthetic seed, which wrote no event history. Recorded on the record itself:</span>
                  <span className="mt-1 block text-ink">
                    <span className="block">· 
                      Started <Timestamp iso={rec.createdAt} now={ws.now} /> by {rec.grosser ?? "Unknown"}
                    </span>
                    {rec.reviewedAt ? (
                      <span className="block">· 
                        Marked operator reviewed <Timestamp iso={rec.reviewedAt} now={ws.now} /> by {rec.reviewedBy ?? "Unknown"}
                      </span>
                    ) : null}
                    {rec.approvedAt ? (
                      <span className="block">· 
                        Approved for downstream use <Timestamp iso={rec.approvedAt} now={ws.now} /> by {rec.approvedBy ?? "Unknown"}
                      </span>
                    ) : null}
                    {rec.sourceEntryAt ? (
                      <span className="block">· 
                        Entered in source system (staff attested) <Timestamp iso={rec.sourceEntryAt} now={ws.now} /> by {rec.sourceEntryBy ?? "Unknown"}
                      </span>
                    ) : null}
                  </span>
                  <span className="mt-1 block text-xs">Individual field confirmations were not recorded for seeded records.</span>
                </>
              ) : rec && ws.history.length === 0 ? (
                "No audit events: this draft was created by the synthetic seed, which wrote no event history. Your confirmations from here on are recorded."
              ) : (
                "No grossing events yet."
              )
            }
          />
        </div>
      </PageBody>

      <Dialog
        open={pendingNav !== null}
        onClose={() => setPendingNav(null)}
        title={`Unsaved changes for ${partLabel}`}
        initialFocusRef={stayRef}
        description="Values never carry over to another part. Choose what to do with your edits."
        role="alertdialog"
        footer={
          <>
            <Button ref={stayRef} variant="secondary" onClick={() => setPendingNav(null)}>
              Stay on Part {id.designation}
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                const href = pendingNav;
                clearLocal();
                setPendingNav(null);
                if (href) window.setTimeout(() => router.push(href), 0);
              }}
            >
              Discard changes
            </Button>
            <Button
              variant="primary"
              loading={saveCmd.pending}
              loadingLabel="Saving..."
              disabled={frozen}
              onClick={async () => {
                const href = pendingNav;
                const ok = await saveDraft();
                setPendingNav(null);
                if (ok && href) router.push(href);
              }}
            >
              Save draft
            </Button>
          </>
        }
      >
        <p className="text-sm text-ink">
          {dirtyKeys.length ? `Edited fields: ${dirtyKeys.map((k) => FIELD_LABEL[k]).join(", ")}. ` : ""}
          {narrativeDirty ? "The narrative was edited. " : ""}
          Saved typed values still need confirmation.
        </p>
      </Dialog>

      <Dialog
        open={flagOpen}
        onClose={() => setFlagOpen(false)}
        title={`Flag ${partLabel} as needing clarification`}
        description="Parks the draft with your note. A question to the office is raised separately as a clarification."
        footer={
          <>
            <Button variant="secondary" onClick={() => setFlagOpen(false)}>
              Keep as is
            </Button>
            <Button
              variant="primary"
              loading={flagCmd.pending}
              loadingLabel="Flagging..."
              disabled={flagNote.trim().length < 3 || !rec}
              onClick={async () => {
                if (!rec) return;
                const out = track(await flagCmd.run({ grossRecordId: rec.id, expectedVersion: versionRef.current, note: flagNote.trim() }));
                if (out.ok) {
                  setFlagOpen(false);
                  setFlagNote("");
                }
              }}
            >
              Flag needs clarification
            </Button>
          </>
        }
      >
        <Field label="What needs clarification" required hint="For example: suture orientation not stated on the requisition.">
          <Textarea rows={3} value={flagNote} onChange={(e) => setFlagNote(e.target.value)} />
        </Field>
        <CommandError error={flagCmd.error} className="mt-2" />
      </Dialog>

      <Dialog
        open={resolveOpen}
        onClose={() => setResolveOpen(false)}
        title={`Record how the question for ${partLabel} was resolved`}
        description="The record returns to draft with your note. It can then be marked operator reviewed."
        footer={
          <>
            <Button variant="secondary" onClick={() => setResolveOpen(false)}>
              Keep flagged
            </Button>
            <Button variant="primary" loading={resolveCmd.pending} loadingLabel="Saving..." disabled={resolution.trim().length < 3 || !rec} onClick={() => void resolveClarification()}>
              Return to draft
            </Button>
          </>
        }
      >
        <Field label="How it was resolved" required hint="For example: office confirmed the suture marks 12 o'clock (clarification C-0412).">
          <Textarea rows={3} value={resolution} onChange={(e) => setResolution(e.target.value)} />
        </Field>
        <CommandError error={resolveCmd.error} className="mt-2" />
      </Dialog>

      <Dialog
        open={amendOpen}
        onClose={() => setAmendOpen(false)}
        title={`Amend the approved gross record for ${partLabel}?`}
        initialFocusRef={keepRef}
        description={`Version ${rec?.recordVersion ?? ""} stays unchanged and is marked superseded. A new draft version is created for your correction; downstream eligibility is withdrawn until it is approved.`}
        footer={
          <>
            <Button ref={keepRef} variant="secondary" onClick={() => setAmendOpen(false)}>
              Keep version {rec?.recordVersion ?? ""}
            </Button>
            <Button
              variant="primary"
              loading={amendCmd.pending}
              loadingLabel="Creating..."
              disabled={amendReason.trim().length < 3 || !rec}
              onClick={async () => {
                if (!rec) return;
                const out = track(await amendCmd.run({ grossRecordId: rec.id, reason: amendReason.trim() }));
                if (out.ok) {
                  setAmendOpen(false);
                  setAmendReason("");
                }
              }}
            >
              Create version {(rec?.recordVersion ?? 0) + 1}
            </Button>
          </>
        }
      >
        <Field label="Reason for the amendment" required>
          <Textarea rows={3} value={amendReason} onChange={(e) => setAmendReason(e.target.value)} />
        </Field>
        <CommandError error={amendCmd.error} className="mt-2" />
      </Dialog>
    </div>
  );
}
