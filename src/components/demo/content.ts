/**
 * Narrative content for the guided five-minute demonstration (master spec §12,
 * design-spec §6.10, docs/director-pitch.md). Pure data: no server imports.
 * Names, offices and identifiers are fictional and synthetic.
 */

export const COPY_GUARD =
  "This demonstration uses synthetic data and simulated connectors. It does not show clinical performance or a production integration.";

export interface DemoIds {
  intakeA: string | null;
  intakeB: string | null;
  candidate: string | null;
  clarification: string | null;
  hold: string | null;
  accession: string | null;
  unknownOfficeIntake: string | null;
}

export interface StepLink {
  label: string;
  href: string;
  /** Shown when the target record does not exist yet. */
  pending?: string;
}

export interface StepContent {
  step: number;
  title: string;
  short: string;
  /** Who acts on screen (demo roles). */
  cast: string;
  /** Approximate speaking time. */
  seconds: number;
  click: string[];
  notice: string[];
  working: string[];
  simulated: string[];
  /** What the world-event button does in this step. */
  worldEvents: string;
  /** What the rehearsal button does in this step. */
  staffActions: string;
  links: (ids: DemoIds) => StepLink[];
}

const fallback = (v: string | null, expected: string) => v ?? expected;

export const STEPS: StepContent[] = [
  {
    step: 1,
    title: "11:00 courier arrival: reconcile and route",
    short: "Courier arrival",
    cast: "Maya Torres, accessioner",
    seconds: 30,
    click: [
      "Press “Run simulator events” to record the 11:00 courier arrival and unpack every container (simulated).",
      "Open Intake. Read the manifest strip: expected vs received per office. Mangrove Bay Dermatology shows expected “Unknown (no manifest)”.",
      "Open the first Avery Quinlan item and press “Accept routing” in the decision column. The routing evidence names the rule: Harbor Point Dermatology to Dr. Elena Marsh, rule set v3.",
      "Open the Seagrape Skin Studio item: it is in the exception lane with no doctor assigned.",
    ],
    notice: [
      "Expected vs received is shown per office; a missing manifest is “Unknown”, never 0.",
      "The routing suggestion shows the approved, versioned rule that produced it.",
      "An office with no approved rule becomes a routing exception. No doctor is guessed.",
      "Provisional intake IDs (INT-…) look different from official accession numbers.",
    ],
    working: ["Manifest reconciliation", "Rule-based routing with rule version", "Routing exception lane", "Provisional IDs", "Audit trail"],
    simulated: ["Courier arrival and the containers' contents", "Orders from EMA-SIM (simulated source system)"],
    worldEvents: "Moves the demo clock to 11:00 ET, records the arrival of CR-1014-11 (received by Maya Torres) and unpacks every container.",
    staffActions: "Also accepts the suggested routing for both Avery Quinlan items as Maya Torres.",
    links: (ids) => [
      { label: "Intake", href: "/intake" },
      { label: `Avery Quinlan, part A ${fallback(ids.intakeA, "INT-1014-031")}`, href: `/intake?item=${fallback(ids.intakeA, "INT-1014-031")}`, pending: ids.intakeA ? undefined : "after the courier is unpacked" },
      {
        label: `Unknown office ${fallback(ids.unknownOfficeIntake, "INT-1014-034")}`,
        href: `/intake?item=${fallback(ids.unknownOfficeIntake, "INT-1014-034")}`,
        pending: ids.unknownOfficeIntake ? undefined : "after the courier is unpacked",
      },
    ],
  },
  {
    step: 2,
    title: "Parts A and B arrive as two orders",
    short: "Related orders",
    cast: "Maya Torres, then Kim Nguyen (accessioning lead)",
    seconds: 30,
    click: [
      "On the first Quinlan item, press “Record: I checked this bottle against the order” in the decision column for part A (Ctrl+Enter never records it).",
      "Open the related-order card. Read the reasons (same patient reference, encounter ENC-55031, office and collection day) and the two order IDs.",
      "Switch “Acting as” to Kim Nguyen and choose “Link as related (keeps both orders)” with a short reason.",
    ],
    notice: [
      "The system only suggests a relationship. A person decides, and the decision is recorded with a reason.",
      "Both source orders, ORD-77120 and ORD-77121, are kept. Nothing is merged.",
      "An accessioner cannot make this decision: the server checks the role, whatever the role selector says.",
    ],
    working: ["Related-order detection with reasons and conflicts", "Review decision with a server-side role check", "Audit trail"],
    simulated: ["The two orders arrived from the simulated source system"],
    worldEvents: "Nothing to simulate: detection already ran when the containers were received. Moves the clock to 11:03 ET.",
    staffActions: "Verifies container A as Maya Torres and records the lead's decision as Kim Nguyen.",
    links: (ids) => [
      { label: `Intake ${fallback(ids.intakeA, "INT-1014-031")}`, href: `/intake?item=${fallback(ids.intakeA, "INT-1014-031")}`, pending: ids.intakeA ? undefined : "after step 1" },
    ],
  },
  {
    step: 3,
    title: "Part B: the bottle says left, the order says right",
    short: "Clarification and hold",
    cast: "Maya Torres, then Kim Nguyen",
    seconds: 45,
    click: [
      "Open the second Quinlan item and verify container B. The laterality row shows “Differs”: order Right dorsal forearm, bottle Left dorsal forearm.",
      "Press “Raise clarification” on that row. Keep the hold on Part B only, then draft and send the message (simulated notification).",
      "Press “Run simulator events”: the office answers (simulated) and the amended order arrives from the simulated source about a minute later.",
      "On Clarifications, as Kim Nguyen: review the answer, resolve it, then release the hold with a reason.",
    ],
    notice: [
      "The hold names its scope: Part B only. Part A can continue.",
      "The office answer does not resolve anything by itself. A lab reviewer resolves it.",
      "The hold stays until the lead releases it, after the amended order arrives. The original order version is kept beside the amendment.",
      "The message text has no patient details; it points to a secure case view.",
    ],
    working: ["Discrepancy evidence with both values kept", "Clarification states with an owner and follow-up time", "Scoped hold", "Review, resolution and hold release as separate steps"],
    simulated: ["Notification delivery to the office", "The office's answer", "The amended order ORD-77121 v2 from the source system", "Message draft (deterministic demo text, not live AI)"],
    worldEvents:
      "If the Part B clarification has been sent and its simulated delivery did not fail: the simulated office answers at 11:12 ET, then the simulated source delivers amended order ORD-77121 v2. It never resolves the clarification or releases the hold.",
    staffActions: "Also verifies container B, raises and sends the clarification with the Part B hold, reviews and resolves it as Kim Nguyen, and releases the hold only after the amended order arrived.",
    links: (ids) => [
      { label: `Intake ${fallback(ids.intakeB, "INT-1014-032")}`, href: `/intake?item=${fallback(ids.intakeB, "INT-1014-032")}`, pending: ids.intakeB ? undefined : "after step 1" },
      {
        label: `Clarification ${fallback(ids.clarification, "CLR-0457")}`,
        href: `/clarifications?selected=${fallback(ids.clarification, "CLR-0457")}`,
        pending: ids.clarification ? undefined : "after it is raised",
      },
    ],
  },
  {
    step: 4,
    title: "The official accession is issued",
    short: "Accession",
    cast: "Maya Torres",
    seconds: 25,
    click: [
      "On Intake, request the accession for both Quinlan items together.",
      "Open the case D26-04817: Overview, Material, Source documents, Tasks and History.",
    ],
    notice: [
      "The number comes from the simulated authoritative source, labeled as such.",
      "Parts A and B keep their original orders (ORD-77120, ORD-77121); both source records are listed.",
      "History shows every step so far, with who did it and when.",
    ],
    working: ["Accession preconditions (verification, routing, related-order review)", "Idempotent request (a double click creates nothing extra)", "Case view with linked records"],
    simulated: ["Accession number issuance by EMA-SIM"],
    worldEvents: "Nothing to simulate: the accession is requested by staff. Moves the clock to 11:18 ET.",
    staffActions: "Requests the accession for both items as Maya Torres.",
    links: (ids) => [
      { label: "Intake", href: "/intake" },
      { label: `Case ${fallback(ids.accession, "D26-04817")}`, href: `/cases/${fallback(ids.accession, "D26-04817")}`, pending: ids.accession ? undefined : "after the accession is issued" },
    ],
  },
  {
    step: 5,
    title: "Part A is grossed and moves on by itself",
    short: "Gross record, Part A",
    cast: "Dana Whitfield, grosser",
    seconds: 40,
    click: [
      "Switch to Dana Whitfield and open Grossing for D26-04817 part A.",
      "Load the synthetic dictation “quinlan-A”. Confirm each proposed number, unit and count.",
      "Mark it operator reviewed, then approve it for downstream use.",
      "Open the Worklist: Dr. Elena Marsh's group shows the change.",
    ],
    notice: [
      "Proposed values are visibly different from confirmed ones; approval is blocked until every value is confirmed.",
      "A1 becomes eligible for processing and a source-entry task opens for Sam Ortiz.",
      "Part B stays “awaiting grossing”: the case is never shown as complete.",
      "“Source update pending” is not “entered in EMA”. Nothing is written to a source system.",
    ],
    working: ["Field-by-field confirmation gates", "Per-part approval", "Downstream tasks and processing eligibility", "Worklist change feed"],
    simulated: ["The dictation transcript (synthetic)", "Extraction (deterministic demo rules, not live AI)"],
    worldEvents: "Nothing to simulate: grossing is staff work. Moves the clock to 11:30 ET.",
    staffActions:
      "Starts the draft, loads the transcript, confirms each proposed value, writes the narrative from the confirmed values, marks it reviewed and approves it, all as Dana Whitfield.",
    links: (ids) => [
      { label: `Grossing ${fallback(ids.accession, "D26-04817")} part A`, href: `/grossing?part=${fallback(ids.accession, "D26-04817")}-A`, pending: ids.accession ? undefined : "after step 4" },
      { label: "Worklist", href: "/worklist" },
    ],
  },
  {
    step: 6,
    title: "A missing slide and a print job with unknown outcome",
    short: "Tray and printer",
    cast: "Priya Shah, histotech",
    seconds: 35,
    click: [
      "This step uses an earlier case, not D26-04817. Open tray TRY-M-03 (Dr. Marsh): 8 of 10 slides are already scanned.",
      "Scan the 9th slide, then a Dr. Okafor slide that does not belong. Try “Mark tray complete”: it is refused with the reason.",
      "Open print job PJ-8841: the printer did not confirm. Record “Not printed”, then reprint with a reason.",
    ],
    notice: [
      "A scan says “Scanned, matches”, not “verified”. One tray scan never verifies every slide.",
      "Completion is blocked while a slide is missing or unexpected; the options are controlled (find it, or follow separately with a supervisor).",
      "A retry is refused until the unknown outcome is reconciled. A reprint records a reason and links to the original job; it is not a new slide.",
    ],
    working: ["Slide-by-slide tray checks", "Print job states including unknown outcome", "Reconciliation before retry"],
    simulated: ["The printer and its timeout", "Label previews (not validated for scanners, solvents or stainers)"],
    worldEvents: "Nothing to simulate: the printer timeout already happened. Moves the clock to 11:40 ET.",
    staffActions:
      "As Priya Shah: scans the 9th and the unexpected slide, tries to complete the tray (refused), removes the unexpected slide; tries a reprint before reconciling (refused), reconciles PJ-8841 as not printed, then reprints with a reason.",
    links: () => [
      { label: "Tray TRY-M-03", href: "/materials?tab=trays&selected=TRY-M-03" },
      { label: "Print job PJ-8841", href: "/materials?tab=print&selected=PJ-8841" },
    ],
  },
  {
    step: 7,
    title: "Finding a block: last confirmed location, wrong block rejected",
    short: "Block retrieval",
    cast: "Marcus Lee, histotech",
    seconds: 25,
    click: [
      "Open retrieval request RR-0192 (Dr. Okafor). Read the last confirmed slot and the checkout history.",
      "Scan block D26-03909 A1: a mismatch. Then scan D26-03990 B1: it matches pick 1 of 3.",
    ],
    notice: [
      "The location reads “Last confirmed”, with who and when. It is not live tracking.",
      "D26-03912 A1 is checked out and overdue: the record says so instead of guessing.",
      "A wrong block changes nothing and is logged.",
    ],
    working: ["Scan check against the request", "Custody history", "Pick list grouped by location"],
    simulated: ["Storage history (synthetic)", "The scanner (the keyboard stands in for it)"],
    worldEvents: "Nothing to simulate. Moves the clock to 11:45 ET.",
    staffActions: "As Marcus Lee: scans the wrong block (rejected), then the requested block D26-03990 B1.",
    links: () => [{ label: "Retrieval RR-0192", href: "/materials?tab=retrieval&selected=RR-0192" }],
  },
  {
    step: 8,
    title: "Operations: what is still blocked and who owns it",
    short: "Operations view",
    cast: "Tanya Brooks, supervisor (or Director, read only)",
    seconds: 30,
    click: ["Open Operations. Pick one blocked item and follow its evidence link to the record."],
    notice: [
      "Every count opens the records behind it. Each item shows its owner, its age and why it is blocked.",
      "Part B of D26-04817 still waits for grossing; Part A waits for source-system entry by Sam Ortiz.",
      "Numbers are computed from synthetic demo data and labeled that way. There are no scores or staff rankings.",
    ],
    working: ["Blocked-work list computed from holds, tasks, clarifications, print outcomes and trays", "Source freshness per tenant"],
    simulated: ["All data is synthetic; nothing reflects observed lab performance"],
    worldEvents: "Nothing to simulate. Moves the clock to 11:50 ET so ages are easy to read.",
    staffActions: "No staff actions in this step.",
    links: () => [
      { label: "Operations", href: "/operations" },
      { label: "Insights (how a pilot would measure it)", href: "/insights" },
    ],
  },
];

/** One step's progress as the records report it (shape of the server's DemoStatus step; type-only mirror). */
export interface StepRecords {
  step: number;
  state: "done" | "in_progress" | "not_started";
  checks: { label: string; done: boolean; detail?: string }[];
}

/**
 * "0 of 1 check done": how many of a step's record checks are in. The step rail and the step's own chip both use it,
 * so the rail never says "not started" while the step sheet shows a finished simulator run.
 */
export function recordsDoneText(checks: { done: boolean }[]): string {
  const done = checks.filter((c) => c.done).length;
  return `${done} of ${checks.length} check${checks.length === 1 ? "" : "s"} done`;
}

/** Step 8 has one check: steps 1 to 7 reached their outcomes (src/server/domain/demoSteps.ts). */
const REVIEW_STEP = 8;

/**
 * A step's check as the guide words it: a condition to look for in the records, never a claim that it happened.
 * Only step 8's check needs rewording; its server label is a sentence about the earlier steps.
 */
export function checkText(step: number, label: string): string {
  return step === REVIEW_STEP ? "Steps 1 to 7 reach their outcomes in the records; Operations then shows what is still blocked" : label;
}

/**
 * The record a step is still missing, named as a record (after "Missing record:"), or null when every check is in.
 * Step 8 names the outcomes of steps 1 to 7 and how many of them the records already show.
 */
export function missingRecordText(status: StepRecords, all: StepRecords[]): string | null {
  const missing = status.checks.filter((c) => !c.done);
  if (!missing.length) return null;
  if (status.step === REVIEW_STEP) {
    const earlier = all.filter((s) => s.step < REVIEW_STEP);
    const done = earlier.filter((s) => s.state === "done").length;
    return `Outcomes of steps 1 to ${REVIEW_STEP - 1} (${done} of ${earlier.length} in the records so far)`;
  }
  return `${missing[0].label}${missing.length > 1 ? `, and ${missing.length - 1} more under Progress` : ""}`;
}

export const SPEAKER_NOTES: { heading: string; seconds: number; text: string }[] = [
  {
    heading: "Opening",
    seconds: 25,
    text:
      "Thank you for the time. In my months at the bench I keep seeing the same information copied by hand at several handoffs, and questions to offices waiting without a clear owner. These are my observations, not measured numbers. What you will see runs on my laptop with made-up data. The connections to EMA, the offices, the printers and the AI are simulated. It does not show clinical performance or a working integration. I will follow one made-up patient's two specimens through the day.",
  },
  {
    heading: "1. Courier arrival",
    seconds: 30,
    text:
      "It is 11:00 and the courier arrives. Instead of remembering which office goes to which doctor, the screen shows what we expected against what came in, and suggests the dermatopathologist from a written rule, showing which rule. A new office with no rule is set aside for review. Nothing is guessed.",
  },
  {
    heading: "2. Two orders, one patient",
    seconds: 30,
    text:
      "Avery Quinlan's parts A and B came in as two separate orders, which today can look like two patients. The system only points out that they may belong together and shows why. The accessioning lead makes the decision. Both original orders stay as they are; nothing is merged.",
  },
  {
    heading: "3. Part B: left or right",
    seconds: 45,
    text:
      "The bottle for part B says left forearm; the order says right. We raise one specific question to the office, with an owner and a follow-up time, and only part B is held. Part A keeps moving. The office's reply here is simulated. Notice that the reply does not close anything: the lead reviews it and resolves it, and the hold is released only after the corrected order arrives. Faster answers would also need an agreement with the offices; more messages alone may just add noise.",
  },
  {
    heading: "4. The accession",
    seconds: 25,
    text:
      "Now the accession is requested. The number comes from the source system, which is simulated here. The case keeps both original order numbers on parts A and B, and the history shows who did what and when.",
  },
  {
    heading: "5. Part A moves on its own",
    seconds: 40,
    text:
      "Dana grosses part A. The dictation here is a synthetic transcript; the values it proposes must each be confirmed. Once part A is approved, the next steps appear right away: the cassette is eligible for processing and Sam has a task to enter the description in EMA. Part B is still waiting, and the case is not shown as finished. This may help with the evening batch, but we would have to measure that, and entering directly in EMA might turn out to be the better fix.",
  },
  {
    heading: "6. Tray and printer",
    seconds: 35,
    text:
      "This step uses an earlier case. A tray is missing one slide and has one that does not belong, so it cannot be marked complete. A label job timed out, so the screen says the outcome is unknown and asks someone to check the printer before printing again. A reprint records a reason. A web page cannot apply 300 labels; real printing depends on our printers and materials.",
  },
  {
    heading: "7. Finding a block",
    seconds: 25,
    text:
      "For a block request, the screen shows the last confirmed slot and who checked it out, not a promise that the block is there. Scanning the wrong block is rejected and nothing changes.",
  },
  {
    heading: "8. What is still blocked",
    seconds: 30,
    text:
      "Operations shows what is still blocked, who owns the next step, how long it has waited, and the evidence behind it. These numbers come from the made-up demo data. They are not results, and they are not used to rank anyone.",
  },
  {
    heading: "Closing",
    seconds: 25,
    text:
      "I am not asking for a purchase, system access or patient data. I would like permission to observe and time a few real cycles with my coworkers' agreement, thirty minutes for a small group to tell me what I got wrong, and help asking ModMed what we already have licensed and can configure. First EMA, then existing products, and only then anything new. Thank you.",
  },
];

export interface CapabilityRow {
  capability: string;
  status: "Working in this demo" | "Simulated" | "Not implemented" | "Unknown: needs discovery";
  note: string;
}

export const REAL_VS_SIMULATED: CapabilityRow[] = [
  { capability: "Expected vs received reconciliation, routing by approved rule, routing exceptions", status: "Working in this demo", note: "Local logic and data. Rules are synthetic." },
  { capability: "Related-order candidates and review (never a merge)", status: "Working in this demo", note: "Detection rules run locally on synthetic orders." },
  { capability: "Clarification states, owners, follow-up times, scoped holds, review and resolution", status: "Working in this demo", note: "Holds block only the listed steps for the named material." },
  { capability: "Digital doctor/PAS worklist with changes since your last acknowledgement", status: "Working in this demo", note: "Printable snapshot shows its generation time and version." },
  { capability: "Gross record confirmation, review and per-part approval with downstream tasks", status: "Working in this demo", note: "Approval never implies an entry in the source system." },
  { capability: "Print job states, unknown outcome and reconciliation before retry", status: "Working in this demo", note: "The printer behind it is simulated." },
  { capability: "Tray verification slide by slide; block retrieval scan check and custody history", status: "Working in this demo", note: "Scanning is typed or keyboard-wedge input." },
  { capability: "Stale-update detection, server-side role checks, local audit trail", status: "Working in this demo", note: "The role selector is a demo switch, not authentication. The audit log is not proof of tamper resistance." },
  { capability: "Source system (orders, amendments, accession numbers)", status: "Simulated", note: "EMA-SIM and OTHER-EHR-SIM are local simulators with outages you can switch on." },
  { capability: "Office notifications and office answers", status: "Simulated", note: "No real office is ever contacted. Delivery outcomes are simulated." },
  { capability: "Label and cassette printers", status: "Simulated", note: "Includes a simulated timeout. Previews are not validated for real materials." },
  { capability: "Drafting and extraction assistant", status: "Simulated", note: "Deterministic demo rules, not live AI. Manual entry works when it is switched off." },
  { capability: "Courier arrival and container contents", status: "Simulated", note: "Synthetic delivery used to drive the scenario." },
  { capability: "Demo clock", status: "Simulated", note: "Starts at 10:52 ET after a reset, paused. It moves only when the presenter advances or jumps it (a step run also jumps it forward), or after Resume, when it runs at normal speed. Only an explicit clock reset or a data reset takes it back to 10:52." },
  { capability: "Writing gross descriptions or any data back to EMA", status: "Not implemented", note: "Entry stays manual in the source system; tracked as a task." },
  { capability: "Real printer control, scanners, microphone input", status: "Not implemented", note: "Would need compatible hardware, drivers and local validation." },
  { capability: "What EMA modules are licensed and what interfaces exist for this lab", status: "Unknown: needs discovery", note: "See the discovery checklist." },
  { capability: "Real office contacts, coverage and response agreements", status: "Unknown: needs discovery", note: "Needs agreement with the offices." },
];
