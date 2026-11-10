// Print-to-PDF checks of the printed worklist snapshot (the downtime / transition paper copy).
// No physical printer and no paper: Chromium renders the print view to PDF, the PDFs are kept as evidence in
// docs/release/evidence/print/, and the DOM is checked in print media laid out at the printable width of the paper.
//  - Histotech view (Priya) and Operations view (Tanya), each from the reproducible synthetic 10:52 state.
//  - Doctor sections in the on-screen order, each with its name and colour word; PAS, holds and unknown states in words.
//  - Pagination: the column header (with the doctor heading) repeats, rows never split, a heading never ends a page alone.
//  - Nothing is wider than the printable width; identifiers stay in their columns; the header carries the generation
//    time, version and data age, the footer says the data is synthetic, and every page carries a running footer.
//  - Readability without colour: every colour-coded element also says its meaning in words; a grayscale PDF is kept.
//  - A stale source says STALE in words on the paper.
// See docs/release/print-verification.md for what this does not cover (paper, a real printer, toner).
import fs from "node:fs";
import path from "node:path";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { STAFF, actAs, loose, openConsoleTab, re, resetDemo, runSimulatorEvents, toasts, type StaffId } from "./support";

// PDFs go to the run's own test-results folder; set E2E_SAVE_PRINT_EVIDENCE=1 to refresh the committed copies in
// docs/release/evidence/print/ (so an ordinary test run never rewrites tracked files).
const EVIDENCE = process.env.E2E_SAVE_PRINT_EVIDENCE === "1"
  ? path.join(process.cwd(), "docs", "release", "evidence", "print")
  : path.join(process.cwd(), "test-results", `print-pdf${process.env.E2E_TAG ? `-${process.env.E2E_TAG}` : ""}`);

// US Letter portrait with 12 mm margins (the @page margin in globals.css). 96 CSS px per inch.
const MARGIN_MM = 12;
const PX_PER_MM = 96 / 25.4;
const PRINT_WIDTH = Math.floor(8.5 * 96 - 2 * MARGIN_MM * PX_PER_MM); // 725 px
const PRINT_HEIGHT = Math.floor(11 * 96 - 2 * MARGIN_MM * PX_PER_MM); // 965 px
const PDF_OPTIONS = {
  format: "Letter",
  printBackground: true,
  margin: { top: `${MARGIN_MM}mm`, right: `${MARGIN_MM}mm`, bottom: `${MARGIN_MM}mm`, left: `${MARGIN_MM}mm` },
  preferCSSPageSize: false,
} as const;

const COLUMNS = ["Case", "Parts and stage", "Stains (work orders)", "Holds", "Readiness", "Owner", "Last update"];
const COLOR_WORDS: readonly string[] = ["teal", "violet", "amber"];

test.beforeEach(async ({ request }) => {
  await resetDemo(request);
});

test.describe("worklist print-to-PDF (Letter, no paper)", () => {
  test("histotech view (Priya): paper copy in print media and as a multi-page Letter PDF", async ({ page, context }) => {
    const snap = await openAndRecordSnapshot(page, context, STAFF.priya, "Histotech");
    const pages = await savePdf(page, "worklist-histotech.pdf");
    expect(pages, "the histotech snapshot runs over more than one Letter page").toBeGreaterThan(1);
    await checkPrintView(page, { generatedBy: "Priya Shah", ...snap });
  });

  test("accessioning view (Maya) after the 11:00 courier: the routing exception section says so in words and its provisional id fits", async ({ page, context }) => {
    await actAs(context, STAFF.maya);
    // World event (guide step 1): the 11:00 courier is unpacked; an item from an office with no routing rule
    // (INT-1014-034) lands in "Unassigned: routing exception", with the longest identifier the Case column holds.
    await runSimulatorEvents(page, 1);
    const snap = await openAndRecordSnapshot(page, context, STAFF.maya, "Accessioning");
    const exception = page.locator("section.print-only table").filter({ has: page.locator("h2", { hasText: "Unassigned: routing exception (no doctor color)" }) });
    await expect(exception).toHaveCount(1);
    await expect(exception.locator("h2")).toHaveCSS("border-top-style", "dashed");
    await expect(exception.locator("tbody > tr").filter({ hasText: "INT-1014-034" })).toContainText(loose("INT-1014-034 (provisional)"));
    await checkPrintView(page, { generatedBy: "Maya Torres", generatedAt: "Wed 2026-10-14 11:00 AM ET", ...snap });
  });

  test("operations view (Tanya): paper copy in print media, as a multi-page Letter PDF and in grayscale", async ({ page, context }) => {
    const snap = await openAndRecordSnapshot(page, context, STAFF.tanya, "Operations");
    const pages = await savePdf(page, "worklist-operations.pdf");
    expect(pages, "the operations snapshot runs over more than one Letter page").toBeGreaterThan(1);
    await checkPrintView(page, { generatedBy: "Tanya Brooks", expectHolds: true, ...snap });

    // Readability without colour: the same paper in grayscale (what a monochrome laser makes of it). The meaning
    // must not depend on hue: the text checks run again on the grayscale page, and the PDF is kept for a person to read.
    await page.addStyleTag({ content: "@media print { section.print-only { filter: grayscale(100%); } }" });
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.querySelector("section.print-only")!).filter)).toBe("grayscale(1)");
    await checkMeaningWithoutColour(page);
    const grayPages = await savePdf(page, "worklist-operations-grayscale.pdf");
    expect(grayPages, "grayscale paper has the same pages").toBe(pages);
  });

  test("a stale source: the paper says STALE in words, in the header and on every page", async ({ page, context }) => {
    await actAs(context, STAFF.tanya);
    // Presenter console → Outages and reset → simulate an EMA-SIM outage (synthetic, simulated source).
    await openConsoleTab(page, "outages");
    const sources = page.getByRole("list").filter({ has: page.getByRole("button", { name: /^(Simulate outage|Restore connection)$/ }) });
    const ema = sources.getByRole("listitem").filter({ has: page.getByText("EMA-SIM Sunrise Coast", { exact: true }) });
    await ema.getByRole("button", { name: "Simulate outage" }).click();
    await expect(ema.getByRole("button", { name: "Restore connection" })).toBeVisible();

    const snap = await openAndRecordSnapshot(page, context, STAFF.tanya, "Operations");
    const header = page.locator("section.print-only > header");
    await expect(header).toContainText(loose("STALE a simulated source system was unreachable or out of date when this was generated."));
    await expect(header).toContainText(/Source data as of (Wed 2026-10-14 \d{1,2}:\d{2} [AP]M ET|Unknown)\. STALE/);
    expect(await runningFooter(page)).toContain("STALE source data");
    expect(await runningFooter(page)).toContain(snap.snapshotId);
  });
});

/** Open the worklist as `staff`, read the doctor order on screen, record a print snapshot (print dialog stubbed), switch to print. */
async function openAndRecordSnapshot(page: Page, context: BrowserContext, staff: StaffId, viewLabel: string) {
  await actAs(context, staff);
  // Count print requests instead of opening the browser's print dialog.
  await page.addInitScript(() => {
    (window as unknown as { __prints: number }).__prints = 0;
    window.print = () => {
      (window as unknown as { __prints: number }).__prints += 1;
    };
  });
  await page.goto("/worklist");
  await expect(page.getByText(/^Version v\d+, read at/)).toBeVisible();
  const version = (await page.getByText(/^Version v\d+, read at/).innerText()).match(/v(\d+)/)![1];

  await page.getByRole("button", { name: "Print snapshot" }).click();
  const toast = toasts(page).getByText(new RegExp(`^Snapshot \\S+ recorded \\(v${version}\\)\\.$`));
  await expect(toast).toBeVisible();
  const snapshotId = (await toast.innerText()).match(/^Snapshot (\S+) recorded/)![1];
  await expect.poll(() => page.evaluate(() => (window as unknown as { __prints: number }).__prints)).toBe(1);

  // Doctor sections as the screen shows them (the grid's band rows, top to bottom), read before switching to print.
  const bands = page.locator('main table th[scope="colgroup"] button');
  await expect(bands.first()).toBeVisible();
  const screenGroups = (await bands.allInnerTexts()).map((t) => t.replace(/\s+/g, " ").trim());
  expect(screenGroups.length, "the screen shows more than one doctor section").toBeGreaterThan(1);

  await page.emulateMedia({ media: "print" });
  // Lay the page out at the printable width of Letter paper, as the printer does.
  await page.setViewportSize({ width: PRINT_WIDTH, height: PRINT_HEIGHT });
  const printed = page.locator("section.print-only");
  await expect(printed).toBeVisible();
  await expect(printed.locator("header")).toContainText(loose(`Snapshot ${snapshotId} recorded.`));
  await expect(printed.locator("header")).toContainText(loose(`View ${viewLabel}`));

  // Doctor groupings present in print, in the on-screen order, each with its name and colour word.
  const printGroups = (await printed.locator("h2 > span:nth-of-type(2)").allInnerTexts()).map((t) => t.replace(/\s+/g, " ").trim());
  expect(printGroups.length, "one printed section per screen section").toBe(screenGroups.length);
  for (const [i, screen] of screenGroups.entries()) {
    const m = screen.match(/^(.*) \((teal|violet|amber|no color)\)$/);
    if (m) {
      expect(printGroups[i], `printed section ${i + 1}: same doctor and colour word as on screen`).toBe(`${m[1]} (${m[2]})`);
      expect(COLOR_WORDS, `${m[1]} has a colour word`).toContain(m[2]);
    } else {
      expect(printGroups[i], `printed section ${i + 1}: a section without a doctor colour says so`).toBe(`${screen} (no doctor color)`);
    }
  }
  const words = printGroups.map((g) => g.match(/\((teal|violet|amber)\)$/)?.[1]).filter(Boolean);
  expect(new Set(words).size, "each doctor has their own colour word").toBe(words.length);
  return { version, snapshotId };
}

async function checkPrintView(
  page: Page,
  options: { generatedBy: string; version: string; snapshotId: string; generatedAt?: string; expectHolds?: boolean },
) {
  const expected = { generatedAt: "Wed 2026-10-14 10:52 AM ET", expectHolds: false, ...options };
  const printed = page.locator("section.print-only");

  // Header: version, generation time and who generated it, and the age of the source data. Footer: synthetic data.
  const header = printed.locator("header");
  await expect(header).toContainText(loose(`Worklist snapshot v${expected.version}. Generated ${expected.generatedAt} by ${expected.generatedBy}. Not updated after printing.`));
  await expect(header).toContainText(/Source data as of (Wed 2026-10-14 \d{1,2}:\d{2} [AP]M ET\. Simulated source\.|Unknown)/);
  await expect(header).toContainText(/Rows \d+/);
  const footer = printed.locator("footer");
  await expect(footer).toContainText(loose(`Demo: synthetic data. Fictional people and offices. Not a clinical record. Worklist v${expected.version}.`));
  // Every page: the running footer (page margin boxes) names the snapshot, says synthetic and numbers the pages.
  const running = await runningFooter(page);
  expect(running).toContain(`@bottom-left { content: "Worklist v${expected.version} ${expected.snapshotId} · ${expected.generatedAt} · Synthetic demo data, not a clinical record";`);
  expect(running).toContain('@bottom-right { content: "Page " counter(page) " of " counter(pages)');

  const facts = await page.evaluate(() => {
    const root = document.querySelector<HTMLElement>("section.print-only")!;
    const style = (el: Element) => getComputedStyle(el);
    const text = (el: Element | null | undefined) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
    const tables = [...root.querySelectorAll("table")];
    const rows = tables.flatMap((t) => [...t.querySelectorAll("tbody > tr")]);
    return {
      tables: tables.map((t) => {
        const thead = t.querySelector("thead")!;
        return {
          display: style(thead).display,
          theadBreakAfter: style(thead).breakAfter,
          headers: [...thead.querySelectorAll("tr:last-child > th")].map((th) => text(th)),
          headingInHeader: !!thead.querySelector("h2"),
        };
      }),
      rowBreaks: [...new Set(rows.map((r) => style(r).breakInside))],
      headings: [...root.querySelectorAll("h2")].map((h) => ({ text: text(h), breakAfter: style(h).breakAfter })),
      minFontPx: Math.min(...[...root.querySelectorAll("*")].filter((e) => [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent!.trim())).map((e) => parseFloat(style(e).fontSize))),
      rows: rows.map((r) => {
        const cells = [...r.children] as HTMLElement[];
        return {
          text: text(r),
          pasShade: style(r).backgroundColor !== "rgba(0, 0, 0, 0)",
          caseCell: text(cells[0]),
          parts: text(cells[1]),
          stains: text(cells[2]),
          holds: [...cells[3].children].map((h) => text(h)),
          holdsText: text(cells[3]),
          readiness: text(cells[4]),
          owner: text(cells[5]),
          lastUpdate: [...cells[6].children].map((s) => s.textContent ?? ""),
          pasBoxes: [...cells[2].querySelectorAll("span")].filter((s) => text(s) === "PAS" && style(s).borderTopStyle === "solid").length,
        };
      }),
    };
  });

  // The column header repeats on each page a section runs over, and carries the doctor heading with it; rows never
  // split; the heading and the header group never end a page alone.
  expect(facts.tables.length).toBeGreaterThan(1);
  for (const t of facts.tables) {
    expect(t.display, "thead repeats on each page").toBe("table-header-group");
    expect(t.headers).toEqual(COLUMNS);
    expect(t.headingInHeader, "the doctor heading is part of the repeated header").toBe(true);
    expect(t.theadBreakAfter).toBe("avoid");
  }
  expect(facts.rowBreaks, "rows never split across pages").toEqual(["avoid"]);
  expect(facts.headings.length).toBe(facts.tables.length);
  for (const h of facts.headings) expect(h.breakAfter, `heading keeps with its rows: ${h.text}`).toBe("avoid");
  // Legible: nothing printed smaller than 11 px (8.25 pt); body text is 12 px (9 pt).
  expect(facts.minFontPx).toBeGreaterThanOrEqual(11);

  // Rows: PAS in words (never colour alone), holds with their scope and steps, unknown values in words.
  expect(facts.rows.length).toBeGreaterThan(10);
  const shaded = facts.rows.filter((r) => r.pasShade);
  expect(shaded.length, "the snapshot has PAS rows").toBeGreaterThan(0);
  for (const r of shaded) expect(r.pasBoxes, `a PAS-shaded row carries a bordered "PAS" label: ${r.text}`).toBeGreaterThan(0);
  for (const r of facts.rows.filter((x) => x.pasBoxes > 0 && !/CANCELED/.test(x.stains))) expect(r.pasShade, `an active PAS row is shaded too: ${r.text}`).toBe(true);
  for (const r of facts.rows) {
    expect(r.caseCell, "case identifier").toMatch(/^(D\d{2}-\d{5}|INT-\d{4}-\d{3}\s*\(provisional\))(\s*(RUSH|NEW|CHANGED|CANCELED))*$/);
    expect(r.parts, `parts and stage in words: ${r.text}`).not.toBe("");
    expect(r.readiness, `readiness in words: ${r.text}`).not.toBe("");
    expect(r.readiness, "paper cannot expand a '+N more' of blocked items").not.toMatch(/not ready: [^;]*\(\+\d+ more\)/i);
    expect(r.owner, `owner in words: ${r.text}`).not.toBe("");
    // The time on one line and where it came from on the next; an unknown time or origin says so in words.
    expect(r.lastUpdate, `last update: ${r.text}`).toHaveLength(2);
    expect(r.lastUpdate[0]).toMatch(/^(.*\d{1,2}:\d{2}\u00a0[AP]M\u00a0ET|Time unknown)$/);
    expect(r.lastUpdate[1]).toMatch(/^(Local|Source \(simulated\)|origin Unknown|\S.*)$/);
    // A stain says its work order, or "on order" when there is none yet.
    if (r.stains !== "None") expect(r.stains).toMatch(/(WO-\d+|on order)/);
    if (r.holdsText === "None") continue;
    // A held row says "HOLD", the hold, its scope and the steps it stops; its parts say "on hold" when the part is held.
    for (const h of r.holds) expect(h, `hold in words: ${r.text}`).toMatch(/^HOLD H-\d{4} \S.* \((accession request|routing|gross approval|processing|sectioning|print|tray|all steps)(, [a-z ]+)*\)$/);
  }
  const held = facts.rows.filter((r) => r.holdsText !== "None");
  if (expected.expectHolds) {
    expect(held.length, "the snapshot has held rows").toBeGreaterThan(0);
    expect(held.some((r) => /on hold \([a-z ,]+\)/.test(r.parts)), "a held part says 'on hold' with its steps").toBe(true);
  }

  await checkFitsPrintableWidth(page);
  await checkColumnsAligned(page);
  await checkMeaningWithoutColour(page);
}

/** The page margin rules (running footer on every page) the print snapshot adds for print. */
async function runningFooter(page: Page): Promise<string> {
  return page.evaluate(() => [...document.querySelectorAll("style")].map((s) => s.textContent ?? "").find((t) => t.includes("@bottom-left")) ?? "");
}

/** Nothing is wider than the printable width, and nothing spills out of its table cell. */
async function checkFitsPrintableWidth(page: Page) {
  const problems = await page.evaluate((width) => {
    const root = document.querySelector<HTMLElement>("section.print-only")!;
    const out: string[] = [];
    const label = (el: Element) => `${el.tagName.toLowerCase()} "${(el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 60)}"`;
    if (document.documentElement.scrollWidth > width + 1) out.push(`page scrolls sideways: ${document.documentElement.scrollWidth}px > ${width}px`);
    for (const el of [root, ...root.querySelectorAll("*")]) {
      // Visually hidden words for a screen reader (1 px clipped boxes) are not printed.
      if (el.closest(".sr-only")) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      if (r.left < -0.5 || r.right > width + 0.5) out.push(`${label(el)} is outside the printable width (${Math.round(r.left)}..${Math.round(r.right)} of ${width})`);
      if (el instanceof HTMLElement && getComputedStyle(el).display !== "inline" && el.scrollWidth > el.clientWidth + 1) out.push(`${label(el)} overflows its own box (${el.scrollWidth} > ${el.clientWidth})`);
    }
    // Long identifiers and text wrap inside their cell: no line box pokes into the next column.
    for (const td of root.querySelectorAll("td, th")) {
      const box = td.getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(td);
      for (const r of range.getClientRects()) {
        if (r.width === 0) continue;
        if (r.right > box.right + 0.5 || r.left < box.left - 0.5) out.push(`text spills out of its cell: ${label(td)}`);
      }
    }
    return [...new Set(out)];
  }, PRINT_WIDTH);
  expect(problems, "print layout at the printable width of Letter paper").toEqual([]);
}

/** Case identifiers and part (specimen) letters start at the same left edge in every row of every doctor's table. */
async function checkColumnsAligned(page: Page) {
  const edges = await page.evaluate(() => {
    const root = document.querySelector<HTMLElement>("section.print-only")!;
    const tables = [...root.querySelectorAll("table")];
    const round = (n: number) => Math.round(n * 2) / 2;
    const firstLineLeft = (el: Element) => {
      const r = document.createRange();
      r.selectNodeContents(el);
      return [...r.getClientRects()].find((x) => x.width > 0)?.left ?? el.getBoundingClientRect().left;
    };
    return {
      caseHeader: tables.map((t) => round(t.querySelector("thead tr:last-child > th:nth-child(1)")!.getBoundingClientRect().left)),
      partsHeader: tables.map((t) => round(t.querySelector("thead tr:last-child > th:nth-child(2)")!.getBoundingClientRect().left)),
      caseIds: tables.flatMap((t) => [...t.querySelectorAll("tbody > tr > td:nth-child(1) > .id-mono")].map((s) => round(s.getBoundingClientRect().left))),
      parts: tables.flatMap((t) => [...t.querySelectorAll("tbody > tr > td:nth-child(2)")].map((td) => round(firstLineLeft(td)))),
    };
  });
  expect(new Set(edges.caseHeader).size, "the Case column starts at the same place in every doctor's table").toBe(1);
  expect(new Set(edges.partsHeader).size, "the Parts column starts at the same place in every doctor's table").toBe(1);
  expect(edges.caseIds.length).toBeGreaterThan(10);
  expect([...new Set(edges.caseIds)], "every case identifier starts at the Case column's left edge").toEqual([edges.caseHeader[0]]);
  expect([...new Set(edges.parts)], "every parts cell starts at the Parts column's left edge").toEqual([edges.partsHeader[0]]);
}

/**
 * Readability without colour: every element with a hue (a doctor rule or swatch, the PAS row shade) sits in a heading
 * or row that says the same thing in words, and all text is dark enough for a grayscale laser (>= 7:1 on white).
 */
async function checkMeaningWithoutColour(page: Page) {
  const problems = await page.evaluate(() => {
    const root = document.querySelector<HTMLElement>("section.print-only")!;
    const out: string[] = [];
    const rgb = (c: string) => (c.match(/[\d.]+/g) ?? []).map(Number);
    // A colour that carries meaning: clearly chromatic (doctor teal, violet, amber; PAS yellow: HSL saturation >= 50%),
    // not the blue-black ink (#151A30, 39%), the muted ink of an empty swatch (#565C78, 17%) or the greys of rules.
    const hued = (c: string) => {
      const [r, g, b, a = 1] = rgb(c);
      if (r === undefined || a === 0) return false;
      const max = Math.max(r, g, b) / 255;
      const min = Math.min(r, g, b) / 255;
      const light = (max + min) / 2;
      const saturation = max === min ? 0 : (max - min) / (1 - Math.abs(2 * light - 1));
      return max - min > 24 / 255 && saturation >= 0.5;
    };
    const lum = (c: string) => {
      const [r, g, b] = rgb(c).map((v) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const text = (el: Element | null) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
    for (const el of [root, ...root.querySelectorAll("*")]) {
      const s = getComputedStyle(el);
      if ([...el.childNodes].some((n) => n.nodeType === 3 && n.textContent!.trim())) {
        const contrast = 1.05 / (lum(s.color) + 0.05);
        if (contrast < 7) out.push(`text "${text(el).slice(0, 40)}" is too light for grayscale paper (${contrast.toFixed(1)}:1 on white)`);
      }
      const drawn = (side: "Top" | "Bottom") => s[`border${side}Style`] !== "none" && parseFloat(s[`border${side}Width`]) > 0;
      const colours = [s.backgroundColor, drawn("Top") ? s.borderTopColor : "", drawn("Bottom") ? s.borderBottomColor : ""];
      if (!colours.some(hued)) continue;
      const heading = el.closest("h2");
      const row = el.closest("tbody > tr");
      if (heading) {
        if (!/\((teal|violet|amber)\)/.test(text(heading))) out.push(`coloured doctor heading without its colour word: "${text(heading)}"`);
      } else if (row) {
        if (![...row.querySelectorAll("span")].some((x) => text(x) === "PAS")) out.push(`shaded row without the word PAS: "${text(row).slice(0, 60)}"`);
      } else {
        out.push(`colour-coded ${el.tagName.toLowerCase()} with no words for it: "${text(el).slice(0, 60)}"`);
      }
    }
    return [...new Set(out)];
  });
  expect(problems, "every colour-coded state also says so in words").toEqual([]);
}

/** Save the PDF (print media, Letter, backgrounds on) and return its page count, read from the PDF bytes. */
async function savePdf(page: Page, name: string): Promise<number> {
  fs.mkdirSync(EVIDENCE, { recursive: true });
  const file = path.join(EVIDENCE, name);
  const buffer = await page.pdf({ path: file, ...PDF_OPTIONS });
  const bytes = buffer.toString("latin1");
  expect(bytes.startsWith("%PDF-"), `${name} is a PDF`).toBe(true);
  // Page objects ("/Type /Page", not "/Type /Pages") and the page tree's own count agree.
  const pageObjects = (bytes.match(/\/Type\s*\/Page(?![A-Za-z])/g) ?? []).length;
  const treeCounts = [...bytes.matchAll(/\/Type\s*\/Pages\b[^>]*?\/Count\s+(\d+)/g)].map((m) => Number(m[1]));
  expect(pageObjects, `${name} has pages`).toBeGreaterThan(0);
  if (treeCounts.length) expect(Math.max(...treeCounts), `${name}: page tree count`).toBe(pageObjects);
  // Every page is US Letter portrait (612 x 792 pt).
  const boxes = [...bytes.matchAll(/\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)\s*\]/g)].map((m) => [Math.round(Number(m[1])), Math.round(Number(m[2]))]);
  expect(boxes.length, `${name}: page sizes`).toBeGreaterThan(0);
  for (const b of boxes) expect(b, `${name}: Letter page size`).toEqual([612, 792]);
  test.info().annotations.push({ type: "pdf", description: `${path.relative(process.cwd(), file)}: ${pageObjects} pages` });
  return pageObjects;
}
