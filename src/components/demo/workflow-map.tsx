import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/cn";

/**
 * Before / proposed-after swimlanes (docs/workflow-map.md), drawn as HTML so
 * the text is real text: each lane is a labeled list in reading order, and
 * each diagram also has a plain-text walkthrough. O1–O12 are staff
 * observations (not measured rates); H1–H12 are hypotheses to measure.
 * They render as "Obs. 3" / "Hyp. 7" in the sans face (a mono "O1" reads as "01").
 */

type BoxKind = "step" | "ema" | "review" | "paper" | "wait";
interface Box {
  text: string;
  ref?: string;
  kind?: BoxKind;
}
interface Lane {
  name: string;
  boxes: Box[];
}

const BEFORE: Lane[] = [
  {
    name: "Offices and courier",
    boxes: [
      { text: "Specimens and requisitions from several offices; courier usually around 11 a.m.", ref: "O1" },
      { text: "Parts A and B sometimes entered as separate orders (looks like “two patients”)", ref: "O4" },
    ],
  },
  {
    name: "Accessioning",
    boxes: [
      { text: "Compare patient information, bottle, site and requisition with the order in EMA", ref: "O3", kind: "ema" },
      { text: "Question about site, laterality, shave vs punch, orientation or marks: message the office through EMA", ref: "O5", kind: "ema" },
      { text: "Wait for the reply; delays happen, cause unknown", ref: "O5", kind: "wait" },
      { text: "Accession in EMA; correcting it afterwards is difficult", ref: "O4", kind: "ema" },
      { text: "Assign the dermatopathologist from memory of office-to-doctor routing", ref: "O2" },
      { text: "Case-number stickers on paper requisitions for the doctors", ref: "O6", kind: "paper" },
    ],
  },
  {
    name: "Grossing and documentation",
    boxes: [
      { text: "Cassettes or blocks marked by hand with case numbers (exact object and step: confirm locally)", ref: "O6" },
      { text: "Grosser completes the requisition by hand", ref: "O7", kind: "paper" },
      { text: "Completed requisitions wait for the batch", ref: "O7", kind: "wait" },
      { text: "Histology assistant types gross descriptions into EMA, sometimes until about 9 p.m.", ref: "O7", kind: "ema" },
    ],
  },
  {
    name: "Histology bench",
    boxes: [
      { text: "Processing and embedding (not mapped in detail)" },
      { text: "Daily printed report “the bible”: cases by doctor, colored pages, PAS table marked in yellow", ref: "O9", kind: "paper" },
      { text: "300+ slide labels printed and applied by hand; extra slides and missing labels printed separately; PAS separated by hand", ref: "O8" },
      { text: "Section, stain and assemble slides for each doctor" },
    ],
  },
  {
    name: "Storage and retrieval",
    boxes: [
      { text: "Blocks and slides filed" },
      { text: "Later request for a block or slide" },
      { text: "Manual number checking to find the material", ref: "O10", kind: "wait" },
    ],
  },
];

const AFTER: Lane[] = [
  {
    name: "Offices and source system (EMA)",
    boxes: [
      { text: "Orders stay in EMA, the system of record", kind: "ema" },
      { text: "Office answers a specific question; needs an agreement on ownership and escalation", ref: "H4" },
      { text: "Official accession issued in EMA", kind: "ema" },
      { text: "Gross description entered in EMA; shown as entered only after EMA acknowledges", ref: "H6", kind: "ema" },
    ],
  },
  {
    name: "Intake and accessioning (companion)",
    boxes: [
      { text: "Manifest: expected vs received; “Unknown” when there is no manifest", ref: "H1" },
      { text: "Order, container and requisition side by side; staff verify against the physical container", ref: "H1" },
      { text: "Related-order candidate: a reviewer decides; both orders kept, never merged", ref: "H3", kind: "review" },
      { text: "Targeted clarification with owner and follow-up time; hold on the affected part only", ref: "H4, H5" },
      { text: "Office answer reviewed by the lab, then resolved", kind: "review" },
      { text: "Routing by an approved, versioned rule; unknown office goes to an exception lane", ref: "H2" },
    ],
  },
  {
    name: "Grossing and documentation",
    boxes: [
      { text: "Open the exact scanned part; structured fields and narrative; confirm numbers, units and counts" },
      { text: "This part reviewed and approved for downstream use", kind: "review" },
      { text: "Task to enter the description in EMA; other parts stay visibly incomplete", ref: "H6" },
    ],
  },
  {
    name: "Histology bench",
    boxes: [
      { text: "Digital worklist by doctor name and color; PAS as text with its order and block or slide", ref: "H7, H8" },
      { text: "Print queue tied to official IDs; unknown outcome reconciled before any retry", ref: "H9" },
      { text: "Tray: set tray and case once, check each slide; missing or unexpected slides flagged", ref: "H10" },
    ],
  },
  {
    name: "Storage and retrieval",
    boxes: [
      { text: "Record the location; last confirmed slot and checkout history" },
      { text: "Pick list by location; a scan must match the requested block", ref: "H11" },
    ],
  },
  {
    name: "Operations",
    boxes: [{ text: "What is blocked, who owns the next step, the evidence and data age", ref: "H12" }],
  },
];

const BEFORE_TEXT = [
  "The courier arrives around 11 a.m. with specimens from several offices (O1).",
  "An accessioner compares patient information, bottle, site and requisition with the order in EMA (O3).",
  "If something does not match, the accessioner messages the office through EMA and waits; replies can be delayed and the cause is unknown (O5).",
  "When parts A and B were entered as separate orders they appear as “two patients”; once accessioned, correcting this is difficult (O4).",
  "After accessioning, the dermatopathologist is assigned from memory of which office goes to which doctor (O2), and case-number stickers go on paper requisitions (O6).",
  "Cassettes or blocks are marked by hand (O6). The grosser completes the requisition by hand; completed requisitions wait for the batch; the histology assistant then types them into EMA, sometimes until about 9 p.m. (O7).",
  "Information handoff: a daily printed report (“the bible”) lists cases by doctor with colored pages and a yellow PAS table; technicians depend on it (O9).",
  "Slide labels are printed and applied by hand, extra labels printed separately, and PAS cases separated by hand (O8).",
  "Later requests for blocks or slides need manual number checking to find the material (O10).",
];

const AFTER_TEXT = [
  "Orders stay in EMA. At arrival, the intake bench shows expected vs received containers per office, or “Unknown” when no manifest exists (H1).",
  "Staff compare order, container and requisition side by side and record that they verified the physical container (H1).",
  "If two orders may belong together, a reviewer decides; both orders are kept and nothing is merged (H3, human review).",
  "A discrepancy on one part opens a targeted clarification with an owner and a follow-up time, and holds only that part (H4, H5). The office's answer is reviewed by the lab before it is resolved (human review). Faster answers depend on an agreement with the offices.",
  "Routing uses an approved, versioned rule; an unknown office goes to an exception lane instead of a guess (H2). The official accession is issued in EMA.",
  "At grossing, the exact part is opened, values are confirmed, and each part is approved on its own (human review). A task then asks for entry in EMA, shown as entered only after EMA acknowledges; unfinished parts stay visibly incomplete (H6).",
  "Information handoff: the digital worklist groups work by doctor name and color and shows PAS as text with its order and material (H7, H8).",
  "Labels print from a queue tied to official IDs; an unknown printer outcome must be reconciled before any retry (H9). Trays are checked slide by slide (H10).",
  "Storage records the last confirmed location and checkouts; a retrieval scan must match the requested block (H11).",
  "Operations shows what is blocked, who owns the next step and the evidence (H12). Review steps add time and must be counted against any time saved.",
];

/** "O3" → "Obs. 3", "H4, H5" → "Hyp. 4, Hyp. 5" (also inside sentences). */
function refText(text: string): string {
  return text.replace(/\b([OH])(\d{1,2})\b/g, (_m, letter: string, n: string) => `${letter === "O" ? "Obs." : "Hyp."}\u00a0${n}`);
}

const KIND_STYLE: Record<BoxKind, { cls: string; tag: string | null }> = {
  step: { cls: "border-line bg-surface", tag: null },
  ema: { cls: "border-brand bg-brand-50", tag: "Stays in EMA" },
  // A person decides here: a stronger hairline on the quiet ground, and the words "Human review" (dashed is kept for "not yet real").
  review: { cls: "border-line-strong bg-surface-subtle", tag: "Human review" },
  paper: { cls: "border-line bg-surface", tag: "Paper" },
  wait: { cls: "border-line bg-surface", tag: "Waiting" },
};

function Swimlanes({ lanes, label }: { lanes: Lane[]; label: string }) {
  return (
    <div role="group" aria-label={label} className="overflow-x-auto rounded-lg border border-line bg-surface">
      {lanes.map((lane, li) => (
        <section key={lane.name} aria-label={`Lane: ${lane.name}`} className={cn("grid grid-cols-[9.5rem_minmax(0,1fr)]", li > 0 && "border-t border-line")}>
          <h3 className="border-r border-line bg-surface-subtle px-3 py-2 text-sm font-semibold text-ink">{lane.name}</h3>
          <ol className="flex flex-wrap items-stretch gap-1.5 p-2">
            {lane.boxes.map((b, i) => {
              const k = KIND_STYLE[b.kind ?? "step"];
              return (
                <li key={i} className="flex items-stretch gap-1.5">
                  <div className={cn("flex w-52 flex-col justify-between rounded-sm border px-2 py-1.5 text-sm text-ink", k.cls)}>
                    <span>{b.text}</span>
                    {k.tag || b.ref ? (
                      <span className="mt-1 flex flex-wrap items-center gap-x-2 text-sm text-ink-muted">
                        {k.tag ? <span className="font-medium text-ink-secondary">{k.tag}</span> : null}
                        {b.ref ? <span className="whitespace-nowrap">{refText(b.ref)}</span> : null}
                      </span>
                    ) : null}
                  </div>
                  {i < lane.boxes.length - 1 ? <ChevronRight className="size-4 shrink-0 self-center text-ink-muted" aria-hidden /> : null}
                </li>
              );
            })}
          </ol>
        </section>
      ))}
    </div>
  );
}

/** An honesty caveat in the same solid-hairline chip as "Illustrative", "Simulated" and "Synthetic" (dashed means "not yet real" only): a caveat, not a warning. */
function HonestyChip({ children }: { children: string }) {
  return (
    <span className="hlo-chip inline-flex items-center rounded-sm border border-sim-border bg-sim-bg px-1.5 py-0.5 text-xs font-medium text-sim-fg">{children}</span>
  );
}

function Legend() {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-ink-secondary" aria-label="Map legend">
      <li className="inline-flex items-center gap-1.5">
        <span className="inline-block h-3 w-5 rounded-sm border border-brand bg-brand-50" aria-hidden /> Stays in EMA (authoritative)
      </li>
      <li className="inline-flex items-center gap-1.5">
        <span className="inline-block h-3 w-5 rounded-sm border border-line-strong bg-surface-subtle" aria-hidden /> Human review or decision (labeled in words)
      </li>
      <li className="inline-flex items-center gap-1.5">
        <span className="inline-block h-3 w-5 rounded-sm border border-line bg-surface" aria-hidden /> Step (paper and waiting steps are labeled in words)
      </li>
      <li>Obs.: staff observation (not a measured rate)</li>
      <li>Hyp.: hypothesis to measure</li>
    </ul>
  );
}

export function WorkflowMap() {
  return (
    <div className="grid gap-6">
      <section aria-labelledby="map-before" className="grid gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h2 id="map-before" className="text-lg font-bold tracking-[-0.01em] text-ink">
            Before: the current workflow, as observed
          </h2>
          <HonestyChip>Employee observations, not audited or measured</HonestyChip>
        </div>
        <p className="max-w-[90ch] text-sm text-ink-secondary">
          Steps whose exact object, order or owner has not been confirmed are marked “confirm locally”. Physical work and documentation run on separate tracks; what
          actually holds back the evening entry is unknown and must be measured.
        </p>
        <Legend />
        <Swimlanes lanes={BEFORE} label="Before map, swimlanes by team" />
        <details className="rounded-md border border-line bg-surface p-3 text-sm">
          <summary className="cursor-pointer font-medium text-ink">Text version of the “before” map</summary>
          <ol className="mt-2 list-decimal space-y-1 pl-5 text-ink">
            {BEFORE_TEXT.map((t) => (
              <li key={t}>{refText(t)}</li>
            ))}
          </ol>
        </details>
      </section>

      <section aria-labelledby="map-after" className="grid gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h2 id="map-after" className="text-lg font-bold tracking-[-0.01em] text-ink">
            Proposed after: with Histology Lab OS as a companion to EMA
          </h2>
          <HonestyChip>Proposed. Not yet validated with lab staff.</HonestyChip>
        </div>
        <p className="max-w-[90ch] text-sm text-ink-secondary">
          Every benefit shown here is a hypothesis to measure, not a demonstrated result. EMA stays the system of record; physical work stays physical; clinical decisions
          stay with authorized people. The review steps cost time and must be counted.
        </p>
        <Legend />
        <Swimlanes lanes={AFTER} label="Proposed after map, swimlanes by team" />
        <details className="rounded-md border border-line bg-surface p-3 text-sm">
          <summary className="cursor-pointer font-medium text-ink">Text version of the “proposed after” map</summary>
          <ol className="mt-2 list-decimal space-y-1 pl-5 text-ink">
            {AFTER_TEXT.map((t) => (
              <li key={t}>{refText(t)}</li>
            ))}
          </ol>
        </details>
      </section>
    </div>
  );
}
