// Design review screenshots of the running app (Playwright, headless Chromium).
//   node scripts/screenshots.mjs <baseUrl> <outDir> [label]
// Captures the same routes, states and viewports every time so before/after
// images are comparable. Requires a server already running at <baseUrl>.
import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const [, , baseUrl = "http://localhost:3400", outDir = "docs/redesign/shots", label = "shot"] = process.argv;
fs.mkdirSync(outDir, { recursive: true });

const ALL_VIEWPORTS = [
  { name: "1440", width: 1440, height: 900 },
  { name: "1366", width: 1366, height: 768 },
  { name: "1024", width: 1024, height: 768 },
  // 200% browser zoom of a 1440x900 and a 1366x768 window: half the CSS pixels at device scale 2.
  { name: "zoom200-720", width: 720, height: 450, scale: 2 },
  { name: "zoom200-683", width: 683, height: 384, scale: 2 },
];
// VIEWPORTS=1440,1366,1024,zoom200-720,zoom200-683 (default: the two workstation sizes).
const wanted = (process.env.VIEWPORTS ?? "1440,1366").split(",");
const VIEWPORTS = ALL_VIEWPORTS.filter((v) => wanted.includes(v.name));

const ROUTES = [
  { name: "intake-hero-b", path: "/intake?item=INT-1014-032", actor: "stf_maya" },
  { name: "intake-hero-a", path: "/intake?item=INT-1014-031", actor: "stf_maya" },
  { name: "operations", path: "/operations", actor: "stf_tanya" },
  { name: "worklist", path: "/worklist?view=histotech", actor: "stf_priya" },
  { name: "grossing", path: "/grossing?part=D26-04797-C", actor: "stf_dana" },
  { name: "materials-tray", path: "/materials?tab=trays&selected=TRY-M-03", actor: "stf_priya" },
  { name: "materials-retrieval", path: "/materials?tab=retrieval&selected=RR-0192", actor: "stf_marcus" },
  { name: "case", path: "/cases/D26-04797", actor: "stf_kim" },
  { name: "clarifications", path: "/clarifications?selected=CLR-0457", actor: "stf_kim" },
];

const only = process.env.ROUTES ? new Set(process.env.ROUTES.split(",")) : null;
const browser = await chromium.launch();
const report = [];
for (const vp of VIEWPORTS) {
  for (const r of ROUTES) {
    if (only && !only.has(r.name)) continue;
    const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: vp.scale ?? 1, reducedMotion: "reduce" });
    await context.addCookies([{ name: "hlos_actor", value: r.actor, url: baseUrl }]);
    const page = await context.newPage();
    const errors = [];
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    page.on("pageerror", (e) => errors.push(String(e)));
    const t0 = Date.now();
    await page.goto(baseUrl + r.path, { waitUntil: "networkidle" });
    const ms = Date.now() - t0;
    await page.waitForTimeout(300);
    const file = path.join(outDir, `${label}-${r.name}-${vp.name}.jpg`);
    await page.screenshot({ path: file, type: "jpeg", quality: 82 });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    const height = await page.evaluate(() => document.documentElement.scrollHeight);
    report.push({ file, ms, overflow, height, errors: errors.slice(0, 3) });
    await context.close();
  }
}
await browser.close();
console.log(JSON.stringify(report, null, 1));
