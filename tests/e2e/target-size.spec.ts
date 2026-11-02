// Stage 6 (A4): pointer target sizes on the desktop bench (1366x768 and 1440x900). Synthetic data only; nothing here
// contacts anything but the local test server. Background and numbers: docs/release/touch-targets.md.
//
// 1. WCAG 2.2 SC 2.5.8 Target Size (Minimum), level AA: every pointer target is at least 24x24 CSS px, unless an
//    exception applies. Two exceptions are measured here:
//     - spacing: a 24px circle centred on the undersized target's box intersects no other target and no other
//       undersized target's circle;
//     - inline: the target is in a sentence or its size is set by the line height of the text around it (an inline
//       link in running text);
//    plus the user-agent exception for a native checkbox or radio the page did not restyle and that has no label (a
//    label that wraps or names the control counts as part of its target). The "equivalent" and "essential"
//    exceptions need a person's judgement and are never assumed. The test fails on any target under 24px with no
//    exception, and prints every target under 24px with the exception that covers it.
// 2. The primary bench actions (scan, record and decision controls on Intake, Gross, Materials and Clarify) against the
//    bench sizes the project chose: the decision commits stay at 44px (WCAG 2.5.5 AAA size, the design spec's tablet
//    size), and the scan, record and decision buttons enlarged in Stage 6 stay at 40px or more. Every primary action
//    under 44px is printed, so the list in the document can be checked against a run.
//
// Starting state: the synthetic demo day after the 11:00 courier is unpacked (the guided demo's step 1 world event).
// This spec reads only: it records nothing.
import { expect, test, type APIRequestContext, type Browser, type Locator, type Page } from "@playwright/test";
import { STAFF, actAs, resetDemo, type StaffId } from "./support";

const SIZES = [
  { width: 1366, height: 768 },
  { width: 1440, height: 900 },
] as const;

interface Screen {
  key: string;
  actor: StaffId;
  url: string;
}

const SCREENS: Screen[] = [
  { key: "Intake, INT-1014-031 (lead, REL-0112)", actor: STAFF.kim, url: "/intake?item=INT-1014-031" },
  { key: "Intake, INT-1014-025 (routine review)", actor: STAFF.maya, url: "/intake?item=INT-1014-025" },
  { key: "Intake, empty bench", actor: STAFF.maya, url: "/intake" },
  { key: "Gross, D26-04797-C (draft)", actor: STAFF.dana, url: "/grossing?part=D26-04797-C" },
  { key: "Worklist, histotech", actor: STAFF.priya, url: "/worklist?view=histotech" },
  { key: "Worklist, operations", actor: STAFF.tanya, url: "/worklist?view=operations" },
  { key: "Materials, print (PJ-8841)", actor: STAFF.priya, url: "/materials?tab=print&selected=PJ-8841" },
  { key: "Materials, trays (TRY-M-03)", actor: STAFF.priya, url: "/materials?tab=trays&selected=TRY-M-03" },
  { key: "Materials, retrieval (RR-0192)", actor: STAFF.priya, url: "/materials?tab=retrieval&selected=RR-0192" },
  { key: "Operations", actor: STAFF.tanya, url: "/operations" },
  { key: "Clarify, CLR-0455", actor: STAFF.kim, url: "/clarifications?selected=CLR-0455" },
  { key: "Console, guide", actor: STAFF.maya, url: "/demo?tab=guide&step=1" },
  { key: "Console, role and clock", actor: STAFF.maya, url: "/demo?tab=role" },
  { key: "Console, world events", actor: STAFF.maya, url: "/demo?tab=world" },
  { key: "Console, outages and reset", actor: STAFF.maya, url: "/demo?tab=outages" },
];

async function command(request: APIRequestContext, actor: StaffId, name: string, input: unknown): Promise<void> {
  const res = await request.post(`/api/commands/${name}`, {
    headers: { Cookie: `hlos_actor=${actor}` },
    data: { input, idempotencyKey: `e2e-targets-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}` },
  });
  const body = (await res.json()) as { ok: boolean; error?: { message: string } };
  expect(body.ok, `${name} failed: ${body.error?.message}`).toBe(true);
}

test.beforeAll(async ({ playwright }, testInfo) => {
  const request = await playwright.request.newContext({ baseURL: testInfo.project.use.baseURL });
  await resetDemo(request);
  await command(request, STAFF.maya, "demo.runStep", { step: 1 });
  await request.dispose();
});

test.use({ reducedMotion: "reduce" });

/** One measured target under 24x24 CSS px. */
interface SmallTarget {
  name: string;
  tag: string;
  width: number;
  height: number;
  /** The 2.5.8 exception that covers it, or null: a failure. */
  exception: "spacing" | "inline" | "user agent" | null;
  /** For a failure: the targets its 24px circle runs into. */
  near: string[];
}

/**
 * Runs in the page. Lists every pointer target under 24x24 CSS px and the 2.5.8 exception that covers it.
 * A target: a link, button, form control, summary, an element with a widget role, or anything in the tab order;
 * not one that is disabled, not rendered, visually hidden (an sr-only box), inert or aria-hidden. A checkbox or radio
 * is measured with the label that wraps or names it (pressing the label operates it).
 */
function measureTargets(): { total: number; small: SmallTarget[] } {
  const SELECTOR =
    "a[href], button, input:not([type=hidden]), select, textarea, summary, [role=button], [role=link], [role=tab], [role=checkbox], [role=radio], [role=switch], [role=menuitem], [role=option], [tabindex]:not([tabindex='-1'])";
  const hiddenBySrOnly = (el: Element) => {
    for (let p: Element | null = el; p; p = p.parentElement) {
      const r = p.getBoundingClientRect();
      const cs = getComputedStyle(p);
      if (r.width <= 1 && r.height <= 1 && (cs.overflow === "hidden" || cs.overflowX === "hidden" || cs.clipPath !== "none")) return true;
    }
    return false;
  };
  const rendered = (el: Element) => {
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || cs.visibility === "collapse") return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    if (el.closest("[aria-hidden='true'], [inert]")) return false;
    return !hiddenBySrOnly(el);
  };
  const labelOf = (el: Element): Element | null => {
    if (!(el instanceof HTMLInputElement) || !["checkbox", "radio"].includes(el.type)) return null;
    return el.closest("label") ?? (el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) : null);
  };
  type Box = { left: number; top: number; right: number; bottom: number; width: number; height: number };
  const boxOf = (el: Element): Box => {
    const r = (labelOf(el) ?? el).getBoundingClientRect();
    return { left: r.left + scrollX, top: r.top + scrollY, right: r.right + scrollX, bottom: r.bottom + scrollY, width: r.width, height: r.height };
  };
  const nameOf = (el: Element) =>
    (
      el.getAttribute("aria-label") ??
      (labelOf(el)?.textContent || null) ??
      (el.textContent?.trim() || null) ??
      el.getAttribute("title") ??
      el.getAttribute("placeholder") ??
      ""
    )
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 60);
  const targets = [...document.querySelectorAll(SELECTOR)].filter((el) => !(el as HTMLButtonElement).disabled && rendered(el)).map((el) => ({ el, box: boxOf(el) }));
  const isSmall = (b: Box) => b.width < 23.99 || b.height < 23.99;
  /** Inline: laid out as text (display inline) inside a block whose own text goes beyond this target's. */
  const inline = (el: Element) => {
    if (getComputedStyle(el).display !== "inline") return false;
    let block: Element | null = el.parentElement;
    while (block && getComputedStyle(block).display.startsWith("inline")) block = block.parentElement;
    if (!block) return false;
    const own = (el.textContent ?? "").replace(/\s+/g, "");
    const all = (block.textContent ?? "").replace(/\s+/g, "");
    return all.length > own.length;
  };
  const userAgent = (el: Element) => el instanceof HTMLInputElement && ["checkbox", "radio"].includes(el.type) && !labelOf(el) && getComputedStyle(el).appearance !== "none";
  const toRect = (cx: number, cy: number, b: Box) => Math.hypot(Math.max(b.left - cx, 0, cx - b.right), Math.max(b.top - cy, 0, cy - b.bottom));
  const small: SmallTarget[] = [];
  for (const t of targets) {
    if (!isSmall(t.box)) continue;
    const cx = (t.box.left + t.box.right) / 2;
    const cy = (t.box.top + t.box.bottom) / 2;
    const near: string[] = [];
    for (const o of targets) {
      if (o === t || o.el.contains(t.el) || t.el.contains(o.el) || labelOf(t.el)?.contains(o.el) || labelOf(o.el)?.contains(t.el)) continue;
      const clash = isSmall(o.box)
        ? Math.hypot(cx - (o.box.left + o.box.right) / 2, cy - (o.box.top + o.box.bottom) / 2) < 24 // two 12px-radius circles
        : toRect(cx, cy, o.box) < 12; // the circle runs into a full-size target
      if (clash) near.push(`${o.el.tagName.toLowerCase()} "${nameOf(o.el)}"`);
    }
    const exception = inline(t.el) ? "inline" : userAgent(t.el) ? "user agent" : near.length === 0 ? "spacing" : null;
    small.push({
      name: nameOf(t.el),
      tag: t.el.tagName.toLowerCase(),
      width: Math.round(t.box.width * 10) / 10,
      height: Math.round(t.box.height * 10) / 10,
      exception,
      near: exception ? [] : near.slice(0, 3),
    });
  }
  return { total: targets.length, small };
}

/** A window at one bench size, acting as a demo role. */
async function openAt(browser: Browser, size: { width: number; height: number }, actor: StaffId) {
  const context = await browser.newContext({ baseURL: test.info().project.use.baseURL, viewport: size, reducedMotion: "reduce" });
  await actAs(context, actor);
  return context;
}

/** Open a screen and wait until it is interactive and its layout has settled. */
async function openScreen(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await expect(page.getByRole("heading", { level: 1 }).first()).toBeAttached();
  await expect
    .poll(() => page.evaluate(() => Object.keys(document.getElementById("scan-field") ?? {}).some((k) => k.startsWith("__reactProps"))), { message: "the page is interactive" })
    .toBe(true);
  for (let i = 0; i < 3; i++) await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
  await page.waitForTimeout(200);
}

for (const size of SIZES) {
  test(`WCAG 2.5.8 at ${size.width}x${size.height}: no target under 24x24 CSS px without the spacing or inline exception`, async ({ browser }) => {
    const report: { screen: string; total: number; small: SmallTarget[] }[] = [];
    for (const s of SCREENS) {
      const context = await openAt(browser, size, s.actor);
      try {
        const page = await context.newPage();
        await openScreen(page, s.url);
        const { total, small } = await page.evaluate(measureTargets);
        expect(total, `${s.key}: targets measured`).toBeGreaterThan(5);
        report.push({ screen: s.key, total, small });
      } finally {
        await context.close();
      }
    }
    const lines = report.flatMap((r) => [
      `${r.screen}: ${r.total} targets, ${r.small.length} under 24px, ${r.small.filter((t) => !t.exception).length} without an exception`,
      ...r.small.map((t) => `    ${t.exception ? `${t.exception} exception` : "FAILS 2.5.8"}: ${t.tag} "${t.name}" ${t.width}x${t.height}${t.near.length ? ` (runs into ${t.near.join(", ")})` : ""}`),
    ]);
    console.log(`Targets under 24x24 CSS px at ${size.width}x${size.height}\n${lines.join("\n")}`);
    await test.info().attach(`targets-under-24-${size.width}x${size.height}.json`, { body: JSON.stringify(report, null, 2), contentType: "application/json" });
    const failures = report.flatMap((r) => r.small.filter((t) => !t.exception).map((t) => `${r.screen}: ${t.tag} "${t.name}" ${t.width}x${t.height}, runs into ${t.near.join(", ")}`));
    expect(failures, `WCAG 2.5.8 failures at ${size.width}x${size.height}`).toEqual([]);
  });
}

/** A primary bench action and the minimum height (and width) it is held to on the desktop bench. */
interface PrimaryAction {
  name: string;
  locate: (page: Page) => Locator;
  /** 44: a decision commit (WCAG 2.5.5 AAA size, the design spec's tablet size). 40: a scan, record or decision button enlarged in Stage 6. null: listed only (kept compact on purpose; see the document). */
  min: 44 | 40 | null;
}

const PRIMARY: { screen: Screen; actions: PrimaryAction[] }[] = [
  {
    screen: SCREENS[0],
    actions: [
      { name: "Scan field (top bar)", locate: (p) => p.locator("#scan-field").locator("xpath=.."), min: 40 },
      { name: "Record decision (REL-0112)", locate: (p) => p.getByRole("button", { name: /^Record decision/ }), min: 44 },
      { name: "Request accession", locate: (p) => p.getByRole("button", { name: /^Request accession/ }), min: 44 },
      { name: "REL-0112 choice: Link as related", locate: (p) => p.getByRole("region", { name: "REL-0112 side by side" }).getByRole("radio", { name: /^Link as related/ }).locator("xpath=ancestor::label[1]"), min: null },
      { name: "REL-0112 choice: Keep separate", locate: (p) => p.getByRole("region", { name: "REL-0112 side by side" }).getByRole("radio", { name: /^Keep separate/ }).locator("xpath=ancestor::label[1]"), min: null },
    ],
  },
  {
    screen: SCREENS[1],
    actions: [
      { name: "Record: I checked this bottle against the order", locate: (p) => p.getByRole("button", { name: "Record: I checked this bottle against the order" }), min: 44 },
      { name: "Accept routing (also yours now)", locate: (p) => p.getByRole("button", { name: /^Accept routing to / }), min: 40 },
    ],
  },
  {
    screen: SCREENS[3],
    actions: [
      { name: "Go to piece count (docked step)", locate: (p) => p.getByRole("button", { name: "Go to piece count" }), min: 44 },
      { name: "Mark operator reviewed", locate: (p) => p.getByRole("button", { name: "Mark operator reviewed" }), min: 44 },
      { name: "Approve for downstream use", locate: (p) => p.getByRole("button", { name: /^Approve for downstream use/ }), min: 44 },
      { name: "Confirm: Piece count (per field)", locate: (p) => p.getByRole("button", { name: "Confirm: Piece count" }), min: null },
      { name: "Checked: keep as dictated… (per field)", locate: (p) => p.getByRole("button", { name: "Checked: keep as dictated…" }), min: null },
    ],
  },
  {
    screen: SCREENS[6],
    actions: [
      { name: "Label printed", locate: (p) => p.getByRole("button", { name: "Label printed" }), min: 40 },
      { name: "Not printed", locate: (p) => p.getByRole("button", { name: "Not printed" }), min: 40 },
      { name: "Can't tell (escalate)", locate: (p) => p.getByRole("button", { name: "Can't tell (escalate)" }), min: 40 },
      { name: "Printed but damaged", locate: (p) => p.getByRole("button", { name: "Printed but damaged" }), min: 40 },
    ],
  },
  {
    screen: SCREENS[7],
    actions: [
      { name: "Scan (bench, simulated scanner)", locate: (p) => p.getByRole("button", { name: "Scan D26-04747 A1-1 H&E L1", exact: true }), min: 40 },
      { name: "Found it (bench)", locate: (p) => p.getByRole("button", { name: /^Found it / }), min: 40 },
      { name: "Record as not on tray…", locate: (p) => p.getByRole("button", { name: /^Record as not on tray/ }).first(), min: 40 },
      { name: "Mark tray complete", locate: (p) => p.getByRole("button", { name: "Mark tray complete" }), min: 44 },
    ],
  },
  {
    screen: SCREENS[8],
    actions: [
      { name: "Scan (bench, simulated scanner)", locate: (p) => p.getByRole("button", { name: "Scan D26-03990 B1" }), min: 40 },
      { name: "Deliver to Microtomy bench 2", locate: (p) => p.getByRole("button", { name: "Deliver to Microtomy bench 2" }), min: 44 },
      { name: "Not with the recorded holder…", locate: (p) => p.getByRole("button", { name: "Not with the recorded holder…" }), min: null },
    ],
  },
  {
    screen: SCREENS[10],
    actions: [
      { name: "Send reminder (docked step)", locate: (p) => p.getByRole("button", { name: /^Send reminder \(simulated\)/ }).first(), min: 44 },
      { name: "Record acknowledgment (also possible)", locate: (p) => p.getByRole("button", { name: "Record acknowledgment" }), min: 40 },
      { name: "Escalate (also possible)", locate: (p) => p.getByRole("button", { name: "Escalate" }), min: 40 },
      { name: "Record an answer given by phone (also possible)", locate: (p) => p.getByRole("button", { name: "Record an answer given by phone" }), min: 40 },
      { name: "Record a delivery outcome (also possible)", locate: (p) => p.getByRole("button", { name: "Record a delivery outcome" }), min: 40 },
    ],
  },
];

for (const size of SIZES) {
  test(`primary bench actions at ${size.width}x${size.height}: decision commits 44px, enlarged scan, record and decision buttons 40px or more`, async ({ browser }) => {
    const rows: { screen: string; action: string; width: number; height: number; min: number | null }[] = [];
    for (const { screen, actions } of PRIMARY) {
      const context = await openAt(browser, size, screen.actor);
      try {
        const page = await context.newPage();
        await openScreen(page, screen.url);
        for (const a of actions) {
          const target = a.locate(page);
          await expect(target, `${screen.key}: ${a.name}`).toHaveCount(1);
          await target.scrollIntoViewIfNeeded();
          const box = await target.boundingBox();
          expect(box, `${screen.key}: ${a.name} is rendered`).not.toBeNull();
          rows.push({ screen: screen.key, action: a.name, width: Math.round(box!.width), height: Math.round(box!.height), min: a.min });
        }
      } finally {
        await context.close();
      }
    }
    console.log(
      `Primary bench actions at ${size.width}x${size.height} (under 44px marked)\n${rows
        .map((r) => `  ${r.height < 44 ? "UNDER 44" : "        "} ${r.screen}: ${r.action} ${r.width}x${r.height}${r.min ? ` (held to ${r.min})` : " (kept compact)"}`)
        .join("\n")}`,
    );
    await test.info().attach(`primary-actions-${size.width}x${size.height}.json`, { body: JSON.stringify(rows, null, 2), contentType: "application/json" });
    const short = rows.filter((r) => r.min !== null && (r.height < r.min - 0.5 || r.width < r.min - 0.5)).map((r) => `${r.screen}: ${r.action} ${r.width}x${r.height}, needs ${r.min}`);
    expect(short, "primary bench actions below their minimum").toEqual([]);
  });
}
