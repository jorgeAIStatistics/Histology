// Text contrast check on the running app (WCAG 2.2 1.4.3, AA).
//   node scripts/contrast-check.mjs <baseUrl> [width]
// For every visible text node: computed color vs the first opaque background
// color found walking up the tree (background images such as the hold hatch
// are ignored, so hatched cells are checked against their base color). Large
// text (>= 24px, or >= 18.66px bold) needs 3:1, other text 4.5:1. Disabled
// controls and screen-reader-only text are exempt. Prints failures by route.
import { chromium } from "@playwright/test";

const [, , baseUrl = "http://localhost:3500", width = "1366"] = process.argv;
const ROUTES = [
  ["/intake?item=INT-1014-032", "stf_maya"],
  ["/intake?item=INT-1014-022", "stf_maya"],
  ["/clarifications?selected=CLR-0457", "stf_kim"],
  ["/grossing?part=D26-04797-C", "stf_dana"],
  ["/grossing", "stf_dana"],
  ["/worklist?view=histotech", "stf_priya"],
  ["/materials?tab=trays&selected=TRY-M-03", "stf_priya"],
  ["/materials?tab=print&selected=PJ-8841", "stf_priya"],
  ["/materials?tab=retrieval&selected=RR-0192", "stf_marcus"],
  ["/operations", "stf_tanya"],
  ["/cases/D26-04797", "stf_kim"],
  ["/insights", "stf_tanya"],
  ["/demo", "stf_maya"],
  ["/settings", "stf_tanya"],
];

const browser = await chromium.launch();
let total = 0;
for (const [path, actor] of ROUTES) {
  const context = await browser.newContext({ viewport: { width: Number(width), height: 900 }, reducedMotion: "reduce" });
  await context.addCookies([{ name: "hlos_actor", value: actor, url: baseUrl }]);
  const page = await context.newPage();
  await page.goto(baseUrl + path, { waitUntil: "networkidle" });
  const fails = await page.evaluate(() => {
    const parse = (c) => {
      const m = c.match(/rgba?\(([^)]+)\)/);
      if (!m) return null;
      const [r, g, b, a = "1"] = m[1].split(/[\s,/]+/).filter(Boolean);
      return [Number(r), Number(g), Number(b), Number(a)];
    };
    const lum = ([r, g, b]) => {
      const f = (v) => {
        v /= 255;
        return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const ratio = (a, b) => {
      const [l1, l2] = [lum(a), lum(b)].sort((x, y) => y - x);
      return (l1 + 0.05) / (l2 + 0.05);
    };
    const bgOf = (el) => {
      let layers = [];
      for (let n = el; n; n = n.parentElement) {
        const c = parse(getComputedStyle(n).backgroundColor);
        if (c && c[3] > 0) {
          layers.push(c);
          if (c[3] >= 1) break;
        }
      }
      let out = [255, 255, 255];
      for (const c of layers.reverse()) out = out.map((v, i) => c[i] * c[3] + v * (1 - c[3]));
      return out;
    };
    const seen = new Map();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let t = walker.nextNode(); t; t = walker.nextNode()) {
      const text = t.textContent.trim();
      if (!text) continue;
      const el = t.parentElement;
      if (!el || el.closest("[aria-hidden='true'], .sr-only, [disabled], [aria-disabled='true'], svg, script, style, noscript")) continue;
      const s = getComputedStyle(el);
      if (s.visibility === "hidden" || s.display === "none" || Number(s.opacity) < 0.1) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2 || rect.bottom < 0 || rect.top > innerHeight * 3) continue;
      const fg = parse(s.color);
      if (!fg) continue;
      const bg = bgOf(el);
      const fgBlended = fg.slice(0, 3).map((v, i) => v * fg[3] + bg[i] * (1 - fg[3]));
      const r = ratio(fgBlended, bg);
      const size = parseFloat(s.fontSize);
      const bold = Number(s.fontWeight) >= 700;
      const need = size >= 24 || (size >= 18.66 && bold) ? 3 : 4.5;
      if (r + 0.01 < need) {
        const key = `${s.color} on rgb(${bg.map(Math.round).join(",")})`;
        if (!seen.has(key)) seen.set(key, { ratio: r.toFixed(2), need, text: text.slice(0, 50) });
      }
    }
    return [...seen.entries()].map(([k, v]) => `${v.ratio}:1 (needs ${v.need}) ${k} — "${v.text}"`);
  });
  total += fails.length;
  console.log(`${path}: ${fails.length ? fails.length + " failing color pair(s)" : "ok"}`);
  for (const f of fails) console.log("   " + f);
  await context.close();
}
await browser.close();
console.log(`\n${total} failing color pair(s) in total at ${width}px.`);
