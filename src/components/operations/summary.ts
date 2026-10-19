import type { BlockedCategory, BlockedItem } from "@/server/queries/operations";

/** Categories that stop or hold up work now. Source-system entry is the routine documentation queue, shown on its own. */
export const EXCEPTION_CATEGORIES: BlockedCategory[] = ["holds", "clarifications", "print", "trays", "routing", "retrieval", "review"];

/** Filter labels (plural, with counts) for the "Blocked now" categories. */
export const FILTER_LABEL: Record<BlockedCategory, string> = {
  holds: "Holds",
  clarifications: "Clarifications",
  print: "Print outcomes",
  trays: "Trays",
  routing: "Routing",
  retrieval: "Block retrieval",
  review: "Reviews",
  source_entry: "Source-system entry",
};

/** What a zero means, in words, for the "Clear now" line. */
export const CLEAR_LABEL: Record<BlockedCategory, string> = {
  holds: "active holds",
  clarifications: "clarifications waiting on a person",
  print: "print jobs with unknown outcome",
  trays: "trays blocked or in exception",
  routing: "routing exceptions",
  retrieval: "open block retrieval requests",
  review: "reviews waiting",
  source_entry: "approved records awaiting source-system entry",
};

/** Waiting-time sort helper: the item that started waiting earliest (null when none has a start time). */
export function longestWaiting(items: BlockedItem[]): BlockedItem | null {
  return items.reduce<BlockedItem | null>((o, b) => (b.since && (!o?.since || Date.parse(b.since) < Date.parse(o.since)) ? b : o), null);
}

export interface BlockedSummary {
  /** Exception items (everything except routine source-system entry): patient identity first (top rung of the severity ladder), then the query's order. */
  exceptions: BlockedItem[];
  routine: BlockedItem[];
  holds: number;
  others: number;
  /** Exceptions about patient identity (name, DOB or MRN disagree). */
  identity: BlockedItem[];
  overdue: number;
  /** The exception that has waited longest (earliest start); null when none has a start time. */
  longest: BlockedItem | null;
  /** Exception categories with at least one item, in display order, with counts. */
  counts: { key: BlockedCategory; count: number }[];
  /** Exception categories with nothing waiting (zeros recede into one line). */
  clear: BlockedCategory[];
  /** Routine source-system entry with no owner (no entry task). */
  routineUnowned: BlockedItem[];
}

/** Pure summary of the blocked list for the operations view (no I/O). */
export function summarizeBlocked(blocked: BlockedItem[]): BlockedSummary {
  // Stable: identity items move to the top; everything else keeps the query's order (holds first, oldest first within a category).
  const exceptions = blocked.filter((b) => b.category !== "source_entry").sort((a, b) => Number(!!b.identity) - Number(!!a.identity));
  const routine = blocked.filter((b) => b.category === "source_entry");
  const counts = EXCEPTION_CATEGORIES.map((key) => ({ key, count: exceptions.filter((b) => b.category === key).length }));
  const longest = longestWaiting(exceptions);
  const holds = exceptions.filter((b) => b.category === "holds").length;
  return {
    exceptions,
    routine,
    holds,
    others: exceptions.length - holds,
    identity: exceptions.filter((b) => b.identity),
    overdue: exceptions.filter((b) => b.overdue).length,
    longest,
    counts: counts.filter((c) => c.count > 0),
    clear: counts.filter((c) => c.count === 0).map((c) => c.key),
    routineUnowned: routine.filter((b) => !b.ownerId),
  };
}

export interface RoutineGroup {
  key: string;
  /** Who holds the entry (the owner's name, or the unassigned role words). */
  owner: string;
  ownerId: string | null;
  /** Shared status and next step, said once for the group. */
  status: string;
  nextStep: string;
  items: BlockedItem[];
}

/**
 * Routine source-system entry grouped so each row is one line: records nobody
 * owns first, then one group per owner (by name); within a group the status,
 * owner and next step are shared and said once. Every item lands in exactly one
 * group and keeps the query's order (oldest first).
 */
export function groupRoutine(items: BlockedItem[]): RoutineGroup[] {
  const groups = new Map<string, RoutineGroup>();
  for (const b of items) {
    // Status is the first sentence of `blocks` ("Approved; not entered in the source system").
    const status = b.blocks.split(". ")[0].replace(/\.$/, "");
    const key = `${b.ownerId ? b.ownerKey : "unowned"}|${status}`;
    const g = groups.get(key);
    if (g) g.items.push(b);
    else groups.set(key, { key, owner: b.owner, ownerId: b.ownerId, status, nextStep: b.nextStep, items: [b] });
  }
  return [...groups.values()].sort((a, b) => Number(!!a.ownerId) - Number(!!b.ownerId) || a.owner.localeCompare(b.owner));
}

/** Owner filter: matches the derived owner key (or a raw staff id, as older links used). */
export function matchesOwner(b: BlockedItem, owner: string | null): boolean {
  return !owner || b.ownerKey === owner || b.ownerId === owner;
}
