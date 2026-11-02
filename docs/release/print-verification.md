# Print verification: worklist snapshot (print-to-PDF)

*2026-10-19, branch `stage-6-production-foundation`. Synthetic data only, on this machine, against a local production build.*

> **No paper was printed and no printer was used.** Everything below was checked with Chromium's print-to-PDF (headless Chromium 156 through Playwright 1.64), in print media, on US Letter. A passing check says the PDF and the print layout are right. It says nothing about a real printer's margins, toner, driver scaling or paper handling. The lab's printer must still be checked by a person (see the checklist in section 6).

## 1. What was checked and how

`tests/e2e/print.spec.ts` (4 tests) opens the worklist as a demo role after the demo reset (synthetic 10:52 state), presses **Print snapshot** with the browser's print dialog stubbed out, then switches the page to print media (`page.emulateMedia({ media: "print" })`) and to the printable width of the paper: Letter portrait (8.5 × 11 in) minus 12 mm margins on each side, 725 × 965 CSS px. It saves the PDF with `page.pdf({ format: "Letter", printBackground: true, margin: 12 mm, preferCSSPageSize: false })`. The 12 mm margins match the `@page` margin in `globals.css`.

| Test | Role and view | What it adds |
|---|---|---|
| Histotech | Priya Shah (`stf_priya`), Histotech view | `worklist-histotech.pdf` and all checks below |
| Accessioning after the 11:00 courier | Maya Torres (`stf_maya`), Accessioning view, after guide step 1 (an item from an office with no routing rule) | The "Unassigned: routing exception (no doctor color)" section, its dashed rule, and the longest identifier the Case column holds (`INT-1014-034 (provisional)`). DOM checks only, no PDF kept. |
| Operations | Tanya Brooks (`stf_tanya`), Operations view | `worklist-operations.pdf`, then `worklist-operations-grayscale.pdf`, with all checks run again on the grayscale page |
| Stale source | Tanya, after a simulated EMA-SIM outage | The header says `STALE` in words, and so does the footer on every page |

Each check, as the test makes it:

| Requirement | Check |
|---|---|
| Doctor groupings in the on-screen order, with name and colour word | The grid's band rows are read top to bottom before switching to print. The print headings must match them one for one: `Dr. Elena Marsh (teal)`, `Dr. Samuel Okafor (violet)`, `Dr. Nadia Ferreira (amber)`. Sections without a doctor colour must say `(no doctor color)`. Each doctor has a different colour word. |
| PAS never shown by colour alone | Every row shaded pale yellow has a bordered `PAS` label. Every row with an active PAS label is shaded. |
| Holds say "hold" with scope and steps | Each hold reads `HOLD H-0089 Part B (gross approval)`: the word, the hold id, its scope and the steps it stops (one of the known step words). In the Operations view the held part's own column also says `B on hold (gross approval)`. |
| Unknown and unverified states in words | Source data age prints `Unknown` when there is none. A stale source prints `STALE …unreachable or out of date…` in the header and `STALE source data` in the footer on every page. A missing time or origin prints `Time unknown` or `origin Unknown`. A stain without a work order prints `on order`. A blocked list is never cut to `(+N more)`. |
| Table header repeats on each page | Every `thead` computes `display: table-header-group`. The column labels are the expected seven, and the doctor heading is part of the repeated header. |
| Rows never split | Every body `tr` computes `break-inside: avoid`. |
| A doctor heading never ends a page alone | The heading and its `thead` compute `break-after: avoid`. The heading sits in the repeated header group, which Chromium keeps with the first row (see section 3). |
| Nothing wider than the printable width | At 725 px wide, no element of the print view extends past the printable width or scrolls inside its own box, and no line of text extends out of its table cell. Elements that are visually hidden for screen readers are skipped. |
| Identifiers aligned in their columns | Every doctor's table starts the Case and Parts columns at the same x position. Every case identifier, and the first line of every parts (specimen) cell, starts at its column's left edge. |
| Header and footer | Header: `Worklist snapshot vN. Generated Wed 2026-10-14 10:52 AM ET by <name>. Not updated after printing.`, `Snapshot SNAP-… recorded.`, view, rows and `Source data as of …`. Last-page footer: `Demo: synthetic data. Fictional people and offices. Not a clinical record. Worklist vN.` Every page: `Worklist vN SNAP-… · <generation time> · Synthetic demo data, not a clinical record` and `Page N of M`. |
| Multi-page | The page count is read from the PDF bytes: the number of `/Type /Page` objects must equal the page tree's `/Count`, both must be greater than 1, and every `/MediaBox` must be `612 × 792` pt (Letter). |
| Readable without colour | Every element with a clearly chromatic colour (HSL saturation of at least 50%: the doctor rules and swatches, the PAS row shade) must sit in a heading that names the colour or in a row with a `PAS` label. Every printed text colour must have at least 7:1 contrast on white. Nothing is printed smaller than 11 px (8.25 pt). The checks run again with `filter: grayscale(100%)` on the print view, and the grayscale PDF is kept for a person to read. |

All three final PDFs were also opened and read page by page, as rendered page images with their extracted text (not on paper). What that reading showed: the doctor heading and column labels open every page a section continues on. No row is split. No text overlaps another column. Each page carries its footer and "Page N of M". In grayscale the three doctor rules turn to the same grey and the PAS shade almost disappears, but the colour words and the bordered `PAS` and `HOLD` labels still carry the meaning. A section can carry over a single row to the next page (Dr. Okafor on page 3 of the Histotech PDF). The repeated heading names the doctor there, so this was left as is.

## 2. PDFs

`docs/release/evidence/print/`:

| File | View | Pages | Notes |
|---|---|---|---|
| `worklist-histotech.pdf` | Histotech (Priya), 50 rows, 3 doctors | **3** | Vector text |
| `worklist-operations.pdf` | Operations (Tanya), 67 rows, 3 doctors, 1 hold (H-0089), 1 rush case | **4** | Vector text |
| `worklist-operations-grayscale.pdf` | The same page with `filter: grayscale(100%)` | **4** | Chromium rasterises a filtered page, so the page body is images (about 2.8 MB) and only the page footer is selectable text. That is expected; the file is only for reading the page without colour. |

All pages are US Letter portrait, 612 × 792 pt. Snapshot SNAP-0001, worklist v66, generated Wed 2026-10-14 10:52 AM ET (the demo clock), synthetic data. Running the spec again overwrites these files with the same pages and text (only the PDF metadata, such as the creation date, changes).

## 3. Defects found and fixed

All fixes are in `src/components/worklist/print-snapshot.tsx`. The first PDFs (before the fixes) showed each of these.

| # | Defect seen in the PDF | Fix |
|---|---|---|
| 1 | **Continuation pages did not name the doctor.** Page 2 of the Operations PDF started with Dr. Marsh's rows under a bare column header, so a loose page could not be tied to a doctor. | The doctor heading (rule in the doctor's colour, swatch, name, colour word, counts) is now the first row of each table's `thead`, so it repeats with the column labels on every page the section runs over. With the old layout (a heading above the table), Chromium kept the heading with the table but did not repeat it. A test page placing the table near the foot of a page showed that Chromium moves the whole header group to the next page rather than leave it alone at the foot. |
| 2 | **Pages after the first did not carry a snapshot id, a time or "synthetic".** The header was on page 1 only and the footer on the last page only. There were no page numbers, so a missing page could not be noticed. | A page footer on every page through CSS page margin boxes (`@page { @bottom-left; @bottom-right }`): `Worklist v66 SNAP-0001 · Wed 2026-10-14 10:52 AM ET · Synthetic demo data, not a clinical record` and `Page N of M`. It adds `STALE source data` when the source was stale. It is a `<style>` element rendered with the print snapshot, so only the worklist page gets it. Browsers without margin-box support print no footer on the middle pages; the first-page header and last-page footer are unchanged. |
| 3 | **Text overlapped the next column.** `Change` ran into `Parts and stage` in the header. `Unassigned` and `Whitfield` ran into the Last update column. | New column widths, which add up to 100% of the 725 px printable width: Case 14.5%, Parts 14.5%, Stains 19.5%, Holds 13%, Readiness 18%, Owner 10%, Last update 10.5%. The change tags moved under the case id (as on screen), which removes the narrow Change column. The test now fails on any text that leaves its cell. |
| 4 | **Holds lacked the steps they stop, and identifiers broke across lines.** A hold printed as `HOLD H-` / `0089 D26-` / `04804 part` / `B`, with no steps. | Holds print `HOLD H-0089 Part B (gross approval)`, as on screen (`Hold: Part B (gross approval)`). `HOLD` and the hold id stay together. |
| 5 | **Identifiers split at their hyphens** in running text: `TRY-` / `M-03`, `A1-` / `3`, `WO-` / `2150`. On paper these read as two things. | Identifiers inside readiness, stain-material and hold text (`A1-3`, `TRY-M-03`, `WO-2150`, `H-0089`, `D26-04804`) are set unbreakable. The words around them still wrap. |
| 6 | **Times broke as `10:06 AM` / `ET · Source` / `(simulated)`.** A missing time would have printed `— ET`, a glyph rather than words. | The time prints on one line (`10:06 AM ET`) and the origin on the next (`Local`, `Source (simulated)`, `origin Unknown`). A missing time prints `Time unknown`. |
| 7 | **`(+2 more)` printed for blocked items** (D26-04797). Paper cannot expand it. | On paper the blocked list is written out in full: `Not ready: A1 waiting for gross record approval; B1 …; C1 …`. |
| 8 | **Rush priority was missing from paper.** The screen shows `Rush`; the print did not. | A bordered `RUSH` label under the case id (seen on D26-04755). Change tags print as bordered `NEW`, `CHANGED` and `CANCELED` labels in the same place. |
| 9 | **A task with no named owner printed as a bare `Unassigned`.** | It prints `Unassigned (<role>)`, the same as the unowned-work text. |
| 10 | **An unrecorded print's header squeezed the title.** Without "Print snapshot" (for example Ctrl+P), the right-hand note took the width and the generation line wrapped mid-name. | The note is capped at 16 rem and wraps on itself. |

`tests/e2e/guards.spec.ts` (the existing print snapshot test) still passes unchanged.

## 4. Not fixed (needs another owner)

- **`(+N more)` for eligible work** comes from the server's readiness text (`src/server/queries/worklist.ts`). The print can expand the blocked list from `row.blockedShort`, but the grouped eligible list is not on the row. No row in the synthetic data hits it today. A full readiness text, or the grouped eligible list on the row, would let the paper show everything.
- **The paper shows a fixed column set.** Blocks prepared/expected, source-system entry and submitting office are on screen (in some views) and in the CSV, but not on the printed snapshot. Their unknown states ("Unknown (no gross record yet)") therefore do not reach paper. Adding them is a design decision for the worklist owner. Letter portrait has little width left.
- **`globals.css` was not changed.** No global print rule had to change for these fixes.

## 5. Commands and results

| Command | Result |
|---|---|
| `npx tsc --noEmit` | Clean (exit 0) |
| `E2E_TAG=a3 E2E_PORT=3303 npx playwright test tests/e2e/print.spec.ts tests/e2e/guards.spec.ts` | **12 passed, 0 failed** (4 print, 8 guards) on a fresh production build (`.next-e2e-a3`, `data/e2e-a3.db`) |
| `npx vitest run tests/domain/consistency.test.ts` (imports `worklist/format`) | 23 passed |

## 6. Human checklist for the lab's printer (not done here)

No physical paper or printer test was performed. Before the printed snapshot is relied on in a downtime, a person at the lab should print the Operations view once from the bench browser and check:

1. **Paper size.** The print dialog says **Letter** (not A4) and **Portrait**, with Scale at **100%** or "Default", not "Fit to page" shrinking the text. The PDF here is 3 pages for Histotech and 4 for Operations at the 10:52 demo state; a real print of the same state should have the same count.
2. **Margins.** Margins set to **Default** (12 mm from the page's own rule). Nothing is cut at any edge: the doctor rule at the top, the right-hand Last update column, and the page footer line (`Worklist vN SNAP-… · … · Synthetic demo data, not a clinical record` and `Page N of M`) about 8 mm above the bottom edge. Chrome's own "Headers and footers" option can stay off; the page prints its own footer.
3. **Grayscale laser.** On the monochrome laser, compare against `worklist-operations-grayscale.pdf`. Every PAS row shows a bordered `PAS` box (the yellow shade may vanish, and that is fine). Every doctor section says its colour word in brackets. Holds show a bordered `HOLD` box. Thin row rules are visible and not broken.
4. **Legibility at arm's length.** Hold a page at arm's length (about 60–70 cm) under bench lighting. Case numbers (`D26-04741`), hold ids and work orders (`WO-2141`) read without squinting, and `0` and `O` are told apart (the identifier font slashes the zero). Body text is 9 pt and identifiers are bold mono. If staff cannot read it, record the printer and its setting rather than shrinking anything.
5. **Order and completeness.** The doctors print in the same order as on screen. Each page after the first starts with the doctor's heading and the column labels. No row is split across two pages. The last page ends with "Demo: synthetic data…". Pages are numbered 1…N with none missing.
6. **Version on paper.** The paper's `vN` and `SNAP-…` match the toast shown after **Print snapshot**. Write the date and initials on page 1 if the lab's downtime procedure asks for it.
