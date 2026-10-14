# Histology Lab OS: Interaction and Visual Design Specification

*"Histology Redesigned." A compact specification written before coding. It is the single source for design tokens, screen layouts, components, accessibility and copy. Everything shown in the app is fictional and synthetic.*

| | |
|---|---|
| Status | Draft v1 for the build team, 2026-10-14; reconciled with the built app the same day (see Section 13, "As built notes") |
| Applies to | Local demonstration (rollout mode A). Not a production or clinical design. |
| Source of truth | `Histology_Lab_OS_Claude_Master_Prompt.txt`, Section 11 (design) and Section 12 (demo) |
| Implementation home | Tokens live in `src/app/globals.css` (Tailwind v4), with chart and doctor colors mirrored in `src/lib/tokens.ts`. Components use tokens only, never raw hex values. Where the built screens differ from this pre-build spec, the code is what the demo does; Section 13 lists the known differences. |

**Plain-language terms used here**

| Term | Meaning |
|---|---|
| Design token | A named value (a color, a size, a spacing step) that every screen reuses, so the app looks and behaves consistently. |
| Contrast ratio | How different text is from its background, from 1:1 (invisible) to 21:1 (black on white). The accessibility standard WCAG AA asks for at least 4.5:1 for normal text and 3:1 for large text and for the edges of controls. |
| Focus ring | The outline that shows which control the keyboard or scanner is currently "in". |
| aria-live | A web feature that makes a screen reader say an update aloud, such as a scan result, without the user moving to it. |
| Side panel | A panel that slides in from the right to show one record's details while the list stays visible on the left. |
| Sticky | Stays on screen while the rest of the page scrolls. |

---

## 0. How this spec was produced (skills and substitutions)

| Need | Skill used | What it contributed |
|---|---|---|
| Information architecture and design system | `design:design-system` | Token categories (color, type, spacing, radius, elevation, motion), component state and variant model, pattern inventory |
| Accessibility | `design:accessibility-review` | WCAG AA checklist structure, contrast table format, keyboard and screen-reader expectations |
| UX copy | `design:ux-copy` | Error, empty-state and confirmation structures; verb-first buttons; consistent terms |
| Critique | `design:design-critique` | Self-critique pass on this plan (Section 11), focused on hierarchy, usability and consistency |
| Data visualization | `dataviz` | Chart form choices, mark rules, anti-patterns, and its palette validator script, which was run on the doctor palette and the queue-age ramp |

Also inspected and not used: `~/.claude/skills` contains only `find-skills` and `image-to-code`. `image-to-code` generates a website from generated images, which does not fit a written spec for a dense bench tool. `anthropic-skills:scientific-ui-design` targets literature-search products and was not needed.

**Not installed:** no skill named "Taste" or "Awesome Design" exists in this environment. Substitution: the practice those names describe (restrained visual judgment, a deliberate visual language, critique against the brief) was applied by hand. Sections 2 and 11 record those decisions, and the color work in Section 3 was checked by calculation rather than by eye.

---

## 1. Design principles for a bench application

1. **Identity always visible.** The current case or part identity (accession or provisional ID, part letter, synthetic patient, office, assigned dermatopathologist) stays pinned on screen during every edit and confirmation. When a scan changes the context, all form fields reset. Values never carry over from one case to the next.
2. **Scan first.** One scan field, always in the same place (top bar), always reachable with one key. Its visible prefix says what a scan will do right now ("Find record", "Add to tray TRY-M-03", "Check block for RR-0192"). After each completed action, focus returns to it.
3. **Exceptions first.** Frontline views open on pending work and problems: holds, mismatches, overdue clarifications and unknown print outcomes come before routine rows. Routine work stays visible but quieter.
4. **Honest labels.** Data that is simulated, unknown, stale, illustrative or still a draft is labeled that way in words. Unknown is never shown as zero, blank, "OK" or "verified". A local draft or approval never appears as entered in the source system. Entry shows as **"Entered in source system (staff attested)"** only after a named person attests it, and as **"Source system acknowledged (simulated)"** only after the (simulated) source confirms it. The two look different, and an attestation is never called an acknowledgment.
5. **Color always comes with text or an icon.** Doctor colors come with the doctor's name. PAS is the word "PAS" plus an icon. A hold is the word "Hold" plus an icon. Nothing depends on color alone, including the printed snapshot.
6. **Shape language carries meaning.** Identifiers are square-cornered boxes in monospace. Statuses are rounded pills with an icon. Doctors are a color swatch plus a name. PAS is a yellow highlighted tag. Alerts are full-width banners with a left stripe. A reader can tell these apart even in grayscale.
7. **Show the reason.** Any blocked action states why and what unblocks it, in visible text next to the control (not only in a tooltip).
8. **Recover, don't overwrite.** Concurrent edits, retries and double-clicks produce a visible conflict or a "duplicate prevented" message, never a silent overwrite or a second record.
9. **Quiet by default.** Light neutral surfaces, one brand hue and strong typography. Alert colors are saved for things that need action. No decorative motion.

---

## 2. Visual language at a glance

- **Surfaces:** cool light gray canvas (`#F4F6F8`) with white working surfaces. Hairline dividers are preferred over shadows.
- **Brand:** a petrol blue (`#0D5F87`), between blue and teal. It marks primary actions, links, selection and the demo banner. It is used sparingly.
- **Type:** IBM Plex Sans for interface text and IBM Plex Mono for every identifier (Section 4).
- **Alert family:** info (blue), success (green), warning (orange), danger (red), hold (deep plum). Each has a dark text color, a pale tint, a border and a solid stripe or icon color.
- **Doctor family:** teal, violet and amber. These are **fictional demo colors**, not copied from the paper "bible" pages, whose real colors are unknown. Whether to match the real page colors is a discovery question (`discovery-checklist.md` 4.5). Each was chosen to sit at least 15 OKLab units (a measure of how different two colors look) away from every alert color (Section 3.4).
- **PAS:** a highlighter yellow tag with a dark border, a flask icon and the text "PAS", echoing the yellow marks on the paper table.

---

## 3. Design tokens

### 3.1 Token table

Light theme only for v1. The app sets `color-scheme: light` so an operating-system dark mode does not invert form controls. A dark theme is out of scope (see Open issues).

**Neutrals**

| Token | Value | Use |
|---|---|---|
| `--hlo-canvas` | `#F4F6F8` | App background behind panels |
| `--hlo-surface` | `#FFFFFF` | Cards, tables, panels, inputs |
| `--hlo-surface-subtle` | `#EDF1F4` | Table headers, hovered rows, secondary panels |
| `--hlo-surface-sunken` | `#E4E9ED` | Disabled inputs, chart gridlines, track backgrounds |
| `--hlo-border` | `#D5DDE3` | Decorative dividers only (never the only edge of a control) |
| `--hlo-border-strong` | `#7A8894` | Input, checkbox and secondary-button edges (3:1 or better) |
| `--hlo-text` | `#0F1A23` | Primary text, identifiers |
| `--hlo-text-secondary` | `#3E4C59` | Supporting text, labels |
| `--hlo-text-muted` | `#56636F` | Metadata, captions, timestamps, provisional chip border |
| `--hlo-text-disabled` | `#8A95A0` | Disabled text only (exempt from contrast; always paired with a visible reason) |

**Brand and focus**

| Token | Value | Use |
|---|---|---|
| `--hlo-brand` | `#0D5F87` | Primary button, links, selected-row edge, accession chip border |
| `--hlo-brand-hover` | `#0A4D6E` | Primary button hover and pressed states |
| `--hlo-brand-ink` | `#0A4A6A` | Text on brand tints |
| `--hlo-brand-50` | `#E8F2F7` | Selected row, accession chip fill, active nav item |
| `--hlo-brand-100` | `#CFE5EF` | Pressed or hovered brand-tinted controls |
| `--hlo-brand-900` | `#0E2F42` | Demo-mode banner background |
| `--hlo-focus` | `#1F5FD1` | Focus ring (2px, 2px offset) |

**Alert colors** (each with dark text, a pale tint, a border and a solid stripe or icon)

| Tone | Text (`-fg`) | Tint (`-bg`) | Border | Solid (stripe/icon) | Icon (shape) | Meaning |
|---|---|---|---|---|---|---|
| info | `#1D4E89` | `#EAF2FB` | `#9DBBE3` | `#2A64B0` | circle "i" | Neutral news, in progress, sent |
| success | `#016807` | `#E8F5EB` | `#9CCDA8` | `#016807` | circle check | Confirmed, acknowledged, resolved |
| warning | `#8C3A06` | `#FFF5EE` | `#EFB283` | `#E36A22` | triangle "!" | Needs attention, unknown outcome, stale |
| danger | `#A1161D` | `#FDECEC` | `#EEA4A7` | `#C4232B` | octagon "x" | Failed, mismatch rejected, blocked by error |
| hold | `#6E2B66` | `#F7ECF5` | `#CFA3C6` | `#6E2B66` | circle pause | Scoped hold on specific material |

Rule: the warning solid `#E36A22` is for stripes and icons only. It never carries white text (3.31:1 fails for text). Warning pills use the dark warning text on the tint.

**Doctor colors** (identity, not status; fictional demo colors)

| Doctor (fictional) | Color name | Swatch | Group-header tint | Text on tint |
|---|---|---|---|---|
| Dr. Elena Marsh | teal | `#0F9485` | `#E3F4F1` | `--hlo-text` |
| Dr. Samuel Okafor | violet | `#9A4BD0` | `#F3ECFB` | `--hlo-text` |
| Dr. Nadia Ferreira | amber | `#916A0B` | `#FAF1DC` | `--hlo-text` |
| Unassigned / routing exception | none | no swatch; dashed outline | none | `--hlo-text-secondary` |

Rule: no text is ever placed inside a doctor swatch. The doctor's name is always written next to it. Doctor colors never appear inside a pill, banner or alert.

**PAS treatment**

| Token | Value | Use |
|---|---|---|
| `--hlo-pas-bg` | `#FFE45C` | PAS tag fill (highlighter yellow) |
| `--hlo-pas-fg` | `#1C1700` | PAS tag text and icon |
| `--hlo-pas-border` | `#8A7300` | PAS tag border (needed: yellow alone is too close to white) |
| `--hlo-pas-row` | `#FFF8D6` | Optional pale row tint for PAS rows in the worklist (never the only signal) |

**Honesty labels**

| Token | Value | Use |
|---|---|---|
| `--hlo-sim-fg` | `#46525D` | "Simulated" connector label text |
| `--hlo-sim-bg` | `#F0F2F4` | Simulated label fill |
| `--hlo-sim-border` | `#7F8B96` | Dashed 1px border of the simulated label |
| Unknown | `--hlo-text-muted` plus a "?" icon | The word "Unknown" and, when known, why |
| Stale | warning tone plus a clock icon | "Last confirmed 10:41 ET (11 min ago)" |
| Illustrative | `--hlo-sim-*` plus a chart icon | "Illustrative: synthetic prior-day data" |

**Chart palette** (checked with the `dataviz` validator, Section 3.4)

| Use | Values |
|---|---|
| Doctor series (at most 3) | `#0F9485`, `#9A4BD0`, `#916A0B` (same as the doctor swatches) |
| Queue-age ordinal ramp (4 buckets: under 1 h, 1 to 4 h, 4 to 8 h, over 8 h) | `#62AEDB`, `#3B89B4`, `#235E7F`, `#163F56` |
| Single-series default | `--hlo-brand` |
| Gridlines and axis | gridline `#E4E9ED`, axis line `#7A8894`, tick text `--hlo-text-muted` |
| Status in charts | alert solids only, always with icon and label |

**Typography** (rem values assume a 16px root, which is left at the browser default so zoom works)

| Token | Size / line height | Weight | Use |
|---|---|---|---|
| `--text-xs` | 0.75rem (12px) / 1rem | 500 | Captions, namespaces, pill text on desktop |
| `--text-sm` | 0.8125rem (13px) / 1.125rem | 400 to 500 | Dense table cells (Compact density) |
| `--text-base` | 0.9375rem (15px) / 1.375rem | 400 | Body, form fields, Comfortable table cells |
| `--text-md` | 1.0625rem (17px) / 1.5rem | 600 | Panel and section titles |
| `--text-lg` | 1.25rem (20px) / 1.75rem | 600 | Page titles; scan field input (in mono) |
| `--text-xl` | 1.5rem (24px) / 2rem | 600 | Primary identifier in the identity bar |
| `--text-2xl` | 1.875rem (30px) / 2.25rem | 600 | Stat-tile values (proportional figures) |

Minimum size anywhere is 12px. Weight 700 is not used, so 600 stays meaningful.

**Spacing, radius, elevation, motion, layers, layout**

| Group | Tokens |
|---|---|
| Spacing (4px base; matches Tailwind's default `--spacing: 0.25rem`) | 2, 4, 8, 12, 16, 20, 24, 32, 40, 48, 64 px. Inside panels use 12 to 16. Between page regions use 24. |
| Radius | `--radius-sm` 4px (ID chips, inputs, tags), `--radius-md` 6px (buttons, cards), `--radius-lg` 10px (panels, dialogs), `--radius-pill` 999px (status pills only) |
| Elevation | `--shadow-1` cards; `--shadow-2` sticky bars once scrolled, popovers; `--shadow-3` dialogs and tablet overlay panel. Borders come first; shadows only separate layers. |
| Motion | `--duration-fast` 120ms, `--duration-base` 180ms, `--ease-standard` cubic-bezier(0.2, 0, 0, 1). Opacity and short slides only. All set to zero under reduced motion. Charts never animate. |
| Layers (z-index) | table sticky header 10, identity bar 20, top bar 30, side panel 40, popover 50, dialog (native top layer) 60, toast 70 |
| Layout sizes | demo banner 28px; top bar 52px; nav 216px expanded, 72px rail; identity bar 56px (one row) or 76px (two rows on tablet); side panel 420px desktop, 480px tablet overlay |
| Focus ring | 2px solid `--hlo-focus`, 2px offset, on `:focus-visible`. On brand-filled buttons the offset gap shows the white surface, so the ring stays visible. |
| Control heights | sm 32px, md 40px, lg 48px. On tablet (Comfortable density) every touch target is at least 44px. |
| Density | Compact (default at 1280px wide and up): 36px rows, 13px text. Comfortable (default below 1280px wide or on touch): 48px rows, 15px text. Users can switch; the choice is remembered per browser. |

### 3.2 Starting CSS (`src/app/globals.css`, Tailwind v4)

This block was the starting point for the build. The live file `src/app/globals.css` is authoritative and may have grown since.

```css
@import "tailwindcss";

/* ---------- Histology Lab OS design tokens (light only, v1) ---------- */
:root {
  color-scheme: light;

  /* Neutrals */
  --hlo-canvas: #F4F6F8;
  --hlo-surface: #FFFFFF;
  --hlo-surface-subtle: #EDF1F4;
  --hlo-surface-sunken: #E4E9ED;
  --hlo-border: #D5DDE3;
  --hlo-border-strong: #7A8894;
  --hlo-text: #0F1A23;
  --hlo-text-secondary: #3E4C59;
  --hlo-text-muted: #56636F;
  --hlo-text-disabled: #8A95A0;

  /* Brand + focus */
  --hlo-brand: #0D5F87;
  --hlo-brand-hover: #0A4D6E;
  --hlo-brand-ink: #0A4A6A;
  --hlo-brand-50: #E8F2F7;
  --hlo-brand-100: #CFE5EF;
  --hlo-brand-900: #0E2F42;
  --hlo-focus: #1F5FD1;

  /* Alert tones: fg = text, bg = tint, border, solid = stripe/icon */
  --hlo-info-fg: #1D4E89;    --hlo-info-bg: #EAF2FB;    --hlo-info-border: #9DBBE3;    --hlo-info-solid: #2A64B0;
  --hlo-success-fg: #016807; --hlo-success-bg: #E8F5EB; --hlo-success-border: #9CCDA8; --hlo-success-solid: #016807;
  --hlo-warning-fg: #8C3A06; --hlo-warning-bg: #FFF5EE; --hlo-warning-border: #EFB283; --hlo-warning-solid: #E36A22; /* solid: stripes/icons only, never text */
  --hlo-danger-fg: #A1161D;  --hlo-danger-bg: #FDECEC;  --hlo-danger-border: #EEA4A7;  --hlo-danger-solid: #C4232B;
  --hlo-hold-fg: #6E2B66;    --hlo-hold-bg: #F7ECF5;    --hlo-hold-border: #CFA3C6;    --hlo-hold-solid: #6E2B66;

  /* Doctor identity colors (swatch + header tint). Never put text inside a swatch. */
  --hlo-dr-teal: #0F9485;   --hlo-dr-teal-tint: #E3F4F1;
  --hlo-dr-violet: #9A4BD0; --hlo-dr-violet-tint: #F3ECFB;
  --hlo-dr-amber: #916A0B;  --hlo-dr-amber-tint: #FAF1DC;

  /* PAS (explicit text + icon; yellow echoes the paper system) */
  --hlo-pas-bg: #FFE45C;
  --hlo-pas-fg: #1C1700;
  --hlo-pas-border: #8A7300;
  --hlo-pas-row: #FFF8D6;

  /* Honesty labels */
  --hlo-sim-fg: #46525D;
  --hlo-sim-bg: #F0F2F4;
  --hlo-sim-border: #7F8B96;

  /* Charts */
  --hlo-chart-grid: #E4E9ED;
  --hlo-chart-axis: #7A8894;
  --hlo-age-1: #62AEDB; /* under 1 h */
  --hlo-age-2: #3B89B4; /* 1 to 4 h */
  --hlo-age-3: #235E7F; /* 4 to 8 h */
  --hlo-age-4: #163F56; /* over 8 h */

  /* Layout */
  --hlo-banner-h: 28px;
  --hlo-topbar-h: 52px;
  --hlo-nav-w: 216px;
  --hlo-nav-rail-w: 72px;
  --hlo-identity-h: 56px;
  --hlo-panel-w: 420px;

  /* Motion */
  --hlo-duration-fast: 120ms;
  --hlo-duration-base: 180ms;
  --hlo-ease: cubic-bezier(0.2, 0, 0, 1);
}

/* Map tokens into Tailwind utilities, e.g. bg-surface, text-ink, text-ink-muted, border-line-strong, bg-hold-bg, rounded-pill, shadow-2 */
@theme inline {
  --color-canvas: var(--hlo-canvas);
  --color-surface: var(--hlo-surface);
  --color-surface-subtle: var(--hlo-surface-subtle);
  --color-surface-sunken: var(--hlo-surface-sunken);
  --color-line: var(--hlo-border);
  --color-line-strong: var(--hlo-border-strong);
  --color-ink: var(--hlo-text);
  --color-ink-secondary: var(--hlo-text-secondary);
  --color-ink-muted: var(--hlo-text-muted);
  --color-ink-disabled: var(--hlo-text-disabled);
  --color-brand: var(--hlo-brand);
  --color-brand-hover: var(--hlo-brand-hover);
  --color-brand-ink: var(--hlo-brand-ink);
  --color-brand-50: var(--hlo-brand-50);
  --color-brand-100: var(--hlo-brand-100);
  --color-brand-900: var(--hlo-brand-900);
  --color-focus: var(--hlo-focus);
  --color-info-fg: var(--hlo-info-fg);       --color-info-bg: var(--hlo-info-bg);       --color-info-border: var(--hlo-info-border);       --color-info-solid: var(--hlo-info-solid);
  --color-success-fg: var(--hlo-success-fg); --color-success-bg: var(--hlo-success-bg); --color-success-border: var(--hlo-success-border); --color-success-solid: var(--hlo-success-solid);
  --color-warning-fg: var(--hlo-warning-fg); --color-warning-bg: var(--hlo-warning-bg); --color-warning-border: var(--hlo-warning-border); --color-warning-solid: var(--hlo-warning-solid);
  --color-danger-fg: var(--hlo-danger-fg);   --color-danger-bg: var(--hlo-danger-bg);   --color-danger-border: var(--hlo-danger-border);   --color-danger-solid: var(--hlo-danger-solid);
  --color-hold-fg: var(--hlo-hold-fg);       --color-hold-bg: var(--hlo-hold-bg);       --color-hold-border: var(--hlo-hold-border);       --color-hold-solid: var(--hlo-hold-solid);
  --color-dr-teal: var(--hlo-dr-teal);       --color-dr-teal-tint: var(--hlo-dr-teal-tint);
  --color-dr-violet: var(--hlo-dr-violet);   --color-dr-violet-tint: var(--hlo-dr-violet-tint);
  --color-dr-amber: var(--hlo-dr-amber);     --color-dr-amber-tint: var(--hlo-dr-amber-tint);
  --color-pas-bg: var(--hlo-pas-bg); --color-pas-fg: var(--hlo-pas-fg); --color-pas-border: var(--hlo-pas-border); --color-pas-row: var(--hlo-pas-row);
  --color-sim-fg: var(--hlo-sim-fg); --color-sim-bg: var(--hlo-sim-bg); --color-sim-border: var(--hlo-sim-border);

  /* next/font exposes --font-plex-sans and --font-plex-mono on <html> */
  --font-sans: var(--font-plex-sans), ui-sans-serif, system-ui, sans-serif;
  --font-mono: var(--font-plex-mono), ui-monospace, "SFMono-Regular", Menlo, monospace;

  --text-xs: 0.75rem;    --text-xs--line-height: 1rem;
  --text-sm: 0.8125rem;  --text-sm--line-height: 1.125rem;
  --text-base: 0.9375rem; --text-base--line-height: 1.375rem;
  --text-md: 1.0625rem;  --text-md--line-height: 1.5rem;
  --text-lg: 1.25rem;    --text-lg--line-height: 1.75rem;
  --text-xl: 1.5rem;     --text-xl--line-height: 2rem;
  --text-2xl: 1.875rem;  --text-2xl--line-height: 2.25rem;

  --radius-sm: 4px;
  --radius-md: 6px;
  --radius-lg: 10px;
  --radius-pill: 999px;

  --shadow-1: 0 1px 2px rgb(15 26 35 / 0.06), 0 1px 1px rgb(15 26 35 / 0.04);
  --shadow-2: 0 4px 12px rgb(15 26 35 / 0.10), 0 1px 3px rgb(15 26 35 / 0.06);
  --shadow-3: 0 12px 32px rgb(15 26 35 / 0.18), 0 2px 6px rgb(15 26 35 / 0.08);
}

@layer base {
  html {
    font-family: var(--font-sans);
    background: var(--hlo-canvas);
    color: var(--hlo-text);
    /* keep focused rows clear of sticky bars (WCAG 2.4.11) */
    scroll-padding-top: calc(var(--hlo-banner-h) + var(--hlo-topbar-h) + var(--hlo-identity-h) + 40px);
  }
  body { background: var(--hlo-canvas); font-size: var(--text-base); line-height: var(--text-base--line-height); }
  :focus-visible { outline: 2px solid var(--hlo-focus); outline-offset: 2px; }
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after {
      animation-duration: 0.01ms !important; animation-iteration-count: 1 !important;
      transition-duration: 0.01ms !important; scroll-behavior: auto !important;
    }
  }
}

/* Identifiers: accession, intake, block, slide, CLR/WO/PJ/TRY/RR, MRN, order IDs */
@utility id-mono {
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums slashed-zero;
  letter-spacing: 0.01em;
  white-space: nowrap; /* identifiers are never truncated or wrapped */
}
@utility num-tabular { font-variant-numeric: tabular-nums; } /* table columns and axis ticks only */
```

Implementation notes:
- Optional strictness: add `--color-*: initial;` as the first line inside a plain `@theme { }` block to remove Tailwind's default palette, so raw classes such as `bg-red-500` cannot appear. If you do this, define `--color-white` and `--color-black` too.
- Recharts takes colors as props. `src/lib/tokens.ts` mirrors the chart and doctor hex values. (A test that checks it against `globals.css` was suggested; whether it exists is recorded in `acceptance-tests.md` or the README.)

### 3.3 Contrast results (computed, WCAG 2.x relative luminance)

All ratios below were calculated with a script using the WCAG formula. None were estimated by eye. Text needs 4.5:1. Control edges, focus rings, swatches and icons that carry meaning need 3:1.

**Text on backgrounds (need 4.5:1)**

| Pair | Foreground | Background | Ratio | Result |
|---|---|---|---|---|
| Body text on surface | `#0F1A23` | `#FFFFFF` | 17.61 | Pass |
| Body text on canvas | `#0F1A23` | `#F4F6F8` | 16.26 | Pass |
| Secondary text on surface | `#3E4C59` | `#FFFFFF` | 8.81 | Pass |
| Secondary text on canvas | `#3E4C59` | `#F4F6F8` | 8.13 | Pass |
| Secondary text on table header | `#3E4C59` | `#EDF1F4` | 7.76 | Pass |
| Muted text on surface | `#56636F` | `#FFFFFF` | 6.16 | Pass |
| Muted text on canvas | `#56636F` | `#F4F6F8` | 5.68 | Pass |
| Muted text on table header | `#56636F` | `#EDF1F4` | 5.42 | Pass |
| Body text on selected row | `#0F1A23` | `#E8F2F7` | 15.49 | Pass |
| Muted text on selected row | `#56636F` | `#E8F2F7` | 5.42 | Pass |
| White on primary button | `#FFFFFF` | `#0D5F87` | 6.99 | Pass |
| White on primary hover | `#FFFFFF` | `#0A4D6E` | 9.13 | Pass |
| Brand link on surface | `#0D5F87` | `#FFFFFF` | 6.99 | Pass |
| Brand link on canvas | `#0D5F87` | `#F4F6F8` | 6.45 | Pass |
| Brand ink on brand tint | `#0A4A6A` | `#E8F2F7` | 8.40 | Pass |
| White on demo banner | `#FFFFFF` | `#0E2F42` | 13.96 | Pass |
| Info text on info tint | `#1D4E89` | `#EAF2FB` | 7.43 | Pass |
| Success text on success tint | `#016807` | `#E8F5EB` | 6.26 | Pass |
| Warning text on warning tint (also the stale banner) | `#8C3A06` | `#FFF5EE` | 7.18 | Pass |
| Danger text on danger tint | `#A1161D` | `#FDECEC` | 6.94 | Pass |
| Hold text on hold tint | `#6E2B66` | `#F7ECF5` | 8.30 | Pass |
| Info / success / warning / danger / hold text on white | as above | `#FFFFFF` | 8.39 / 7.04 / 7.71 / 7.93 / 9.54 | Pass |
| Body text on hold tint / warning tint | `#0F1A23` | `#F7ECF5` / `#FFF5EE` | 15.32 / 16.39 | Pass |
| Muted text on hold tint / warning tint | `#56636F` | `#F7ECF5` / `#FFF5EE` | 5.36 / 5.73 | Pass |
| White on danger button | `#FFFFFF` | `#C4232B` | 5.80 | Pass |
| White on hold solid ("HOLD" tag) | `#FFFFFF` | `#6E2B66` | 9.54 | Pass |
| White on success solid | `#FFFFFF` | `#016807` | 7.04 | Pass |
| White on warning solid | `#FFFFFF` | `#E36A22` | 3.31 | **Fail, so this pairing is banned** (warning solid is for stripes and icons only) |
| Body text on teal / violet / amber header tint | `#0F1A23` | `#E3F4F1` / `#F3ECFB` / `#FAF1DC` | 15.50 / 15.27 / 15.67 | Pass |
| Muted text on teal / violet / amber tint | `#56636F` | same | 5.42 / 5.34 / 5.48 | Pass |
| PAS text on PAS yellow | `#1C1700` | `#FFE45C` | 14.08 | Pass |
| Body / muted text on PAS row tint | `#0F1A23` / `#56636F` | `#FFF8D6` | 16.48 / 5.76 | Pass |
| Simulated label text on its fill | `#46525D` | `#F0F2F4` | 7.13 | Pass |
| Simulated label text on white | `#46525D` | `#FFFFFF` | 8.00 | Pass |
| White on age ramp steps 3 and 4 (labels inside bars) | `#FFFFFF` | `#235E7F` / `#163F56` | 7.05 / 11.17 | Pass (steps 1 and 2 take dark labels outside the bar) |
| Disabled text | `#8A95A0` | `#FFFFFF` | 3.05 | Exempt. Always paired with a readable reason in normal text. |

**Non-text elements (need 3:1)**

| Element | Color | Against | Ratio | Result |
|---|---|---|---|---|
| Input and checkbox edge | `#7A8894` | white / canvas | 3.64 / 3.36 | Pass |
| Focus ring | `#1F5FD1` | white / canvas / selected row | 5.81 / 5.36 / 5.11 | Pass |
| Doctor swatch teal / violet / amber | as listed | white | 3.75 / 4.89 / 4.92 | Pass |
| PAS border | `#8A7300` | white / PAS yellow | 4.63 / 3.64 | Pass |
| Simulated label dashed border | `#7F8B96` | white | 3.48 | Pass |
| Provisional chip dashed border | `#56636F` | white | 6.16 | Pass |
| Accession chip border | `#0D5F87` | brand tint | 6.15 | Pass |
| Stripe: hold / warning / danger, on white | solids | white | 9.54 / 3.31 / 5.80 | Pass |
| Stripe: hold / warning / danger, on own tint | solids | tints | 8.30 / 3.08 / 5.08 | Pass |
| Icon: info / success, on white | solids | white | 5.92 / 7.04 | Pass |
| Queue-age ramp lightest step | `#62AEDB` | white | 2.44 | Passes the 2:1 ordinal-ramp floor from `dataviz`. Bars also carry a legend and a table view. |

Hairline dividers (`#D5DDE3`) and gridlines (`#E4E9ED`) are decorative and are never the only edge of a control.

### 3.4 Color separation (doctor colors vs alert colors)

Measured as OKLab distance x100 under normal vision. The `dataviz` skill treats 15 as the floor for "clearly different". Doctor colors are also always paired with a name, so color is never the only cue.

| Pair | Distance | Note |
|---|---|---|
| Doctor amber vs warning solid | 15.2 | Closest doctor/alert pair. Also separated by shape: a swatch and a name versus a pill or banner with a triangle icon. |
| Doctor amber vs danger | 16.5 | |
| Doctor amber vs success | 16.9 | |
| Doctor amber vs PAS yellow | 37.1 | Large lightness difference |
| Doctor teal vs success | 17.8 | |
| Doctor teal vs brand | 16.7 | |
| Doctor teal vs info | 17.4 | |
| Doctor violet vs hold | 19.4 | |
| Doctor violet vs info | 17.3 | |
| Doctors with each other | teal/amber 17.2, teal/violet 27.8, violet/amber 28.9 | |
| Warning vs danger (alert vs alert) | 14.8 | Just under 15. Always told apart by icon (triangle vs octagon) and word. |
| Brand vs info (same family on purpose) | 7.0 | Info is deliberately in the brand family. It always shows the "i" icon and a label. |

`dataviz` validator results:
- **Doctor palette** `#0F9485, #9A4BD0, #916A0B` on white, all pairs: **all checks pass**. Lightness band, chroma floor, color-vision-deficiency separation (worst 12.8, deuteranopia) and normal-vision floor (worst 17.2) all pass, and every mark is at least 3:1. Tritan separation for amber/teal is 6.7, so direct labels (doctor names) are required on charts. They are already part of the spec.
- **Queue-age ramp** `#62AEDB, #3B89B4, #235E7F, #163F56`, ordinal: **all checks pass**. It is a single hue, gets darker step by step, and every step is visibly different.

---

## 4. Typography

**Choice:** IBM Plex Sans (interface) and IBM Plex Mono (identifiers), loaded with `next/font/google`. Both are under the SIL Open Font License.

```ts
// src/app/fonts.ts
import { IBM_Plex_Sans, IBM_Plex_Mono } from "next/font/google";
export const plexSans = IBM_Plex_Sans({ subsets: ["latin"], weight: ["400", "500", "600"], variable: "--font-plex-sans", display: "swap" });
export const plexMono = IBM_Plex_Mono({ subsets: ["latin"], weight: ["400", "500", "600"], variable: "--font-plex-mono", display: "swap" });
// <html lang="en-US" className={`${plexSans.variable} ${plexMono.variable}`}>
```

**Why Plex over Inter:**
- Identifiers matter more than prose here. Plex Mono was designed as the sibling of Plex Sans, so an accession number set in mono sits naturally in a sans sentence without looking pasted in. Inter has no matching mono.
- Monospace identifiers keep `D26-04749 A1-2` the same width in every row, so columns of accessions line up and differences are easier to spot.
- Plex is a little narrower and more "technical" than Inter, which suits dense tables at 1366px.
- Inter is an acceptable fallback if Plex causes a build problem. Keep Plex Mono for identifiers either way.

**Rules:**
- Every identifier (accession, intake ID, part/block/slide, CLR, WO, PJ, TRY, RR, MRN, ORD) uses the `id-mono` utility. Identifiers are never truncated with "...". Truncate the surrounding text instead.
- Use `tabular-nums` only where numbers line up vertically (table columns, axis ticks). Stat-tile values use the default proportional figures, per `dataviz`.
- Sentence case everywhere. No all-caps body text. The words "DEMO" in the banner and "HOLD" in the solid hold tag are the only uppercase uses.
- During the first browser check, look at `0 O 1 l I` in both fonts at 13px and confirm they are easy to tell apart.
- `next/font/google` downloads the font files once at build time and serves them locally, so the running app makes no calls to Google. If the build machine is offline, switch to `next/font/local` with the OFL font files.

---

## 5. Layout

### 5.1 App shell

```
+----------------------------------------------------------------------------------+
| DEMO MODE  Synthetic data only. No real patients. All connectors simulated. [What is simulated?] |  28px banner
+----------------------------------------------------------------------------------+
| Histology Lab OS | [Scan target: Find record | Scan or type an ID ...    ] | Source: synced 10:51 (1 min) | Demo clock Wed Oct 14 10:52 ET | Acting as: Maya Torres, Accessioner (demo role) |  52px
+-----------+----------------------------------------------------------------------+
| BENCH     | [Sticky identity bar: current case/part, when a case is open]        |
| Intake  3 |----------------------------------------------------------------------|
| Clarif. 2 |  Page content                                     | Side panel 420px |
| Worklist  |  (list keeps its scroll and selection)            | (one record)     |
| Grossing  |                                                   |                  |
| Materials |                                                   |                  |
| OVERSIGHT |                                                   |                  |
| Operations|                                                   |                  |
| Insights  |                                                   |                  |
| ADMIN     |                                                   |                  |
| Settings  |                                                   |                  |
| Guided demo                                                   |                  |
+-----------+----------------------------------------------------------------------+
```

| Shell element | Specification |
|---|---|
| Demo-mode banner | Always visible and cannot be dismissed. `--hlo-brand-900` background, white text, with a small yellow "DEMO" tag. Text: "Demo mode. Synthetic data only. No real patients. Source system, notifications, printer and AI are simulated." The link opens `/settings` at Integration capabilities. `role="note"`. |
| Product mark | Text wordmark "Histology Lab OS" (600) with "Lumen Bay Dermatopathology Laboratory (fictional)" in muted xs below. No logo art, no imagery. |
| Scan / search field | Same place on every page, 40px tall, at least 380px wide, 20px mono input text. A prefix chip shows the current **scan target**. Keys: `/` or `Ctrl/Cmd+K` focus it; `Enter` submits; `Esc` clears, and a second `Esc` resets the target to "Find record". A result line appears directly under the field (Section 7, Scan field). |
| Source freshness indicator | Icon, text and time for each tenant, for example "EMA-SIM Sunrise Coast: synced 10:51 ET (1 min ago)". States (one display set everywhere): **Synced** (circle check), **Delayed** (clock, warning, "Last sync 10:38 ET, 14 min ago"), **Offline** (octagon, danger, "Unreachable since 10:41 ET. Showing last confirmed data."), **Unknown** ("Sync status unknown"). Always carries a Simulated label. The word "Live" is never used. A popover lists both tenants (EMA-SIM Sunrise Coast, OTHER-EHR-SIM Gulf), the last successful sync and the last attempt. Default thresholds are 5 and 15 minutes. These are demo settings, not clinical rules. |
| Demo clock | "Demo clock" label, clock icon, "Wed Oct 14, 10:52 ET". The popover has: Advance 5 min, Jump to courier arrival (11:00), Pause/Resume, Reset to 10:52. It never looks like real time: the "Demo clock" label is always shown. |
| Acting-as role selector | A native `<select>`: "Acting as: Maya Torres, Accessioner". Caption: "Demo role switch. Not a sign-in." Read-only roles (Director (demo), Medical director (demo)) add a "Read only" tag to the top bar. Switching roles with unsaved edits asks first. The server checks permissions on every action whatever the selector says. |
| Left nav | Grouped: Bench (Intake, Clarifications, Worklist, Grossing, Materials), Oversight (Operations, Insights), Admin (Settings), and Guided demo. Each item has an icon and a text label. A count shows items that need action, read aloud as, for example, "Clarifications, 2 open". The active item has a brand-50 fill and a 3px brand left edge. `/cases/[id]` is reached through scan, search and links, not the nav. |
| Landing page by role | Accessioner: `/intake`. Grosser: `/grossing`. Histology assistant (Sam Ortiz): `/worklist?view=grossing` (the "Grossing and source entry" view). Histotech: `/worklist` (Histotech view). Supervisor, Director, Medical director: `/operations`. Frontline landing views open on pending work and exceptions. |

### 5.2 Sizes at 1366px workstation and 1024px bench tablet

| | 1366 x 768 workstation (about 1366 x 650 usable after browser chrome) | 1024 x 768 bench tablet, landscape |
|---|---|---|
| Nav | 216px with labels. Users can collapse it to a 72px rail. | 72px rail with icon and short label (12px) under each |
| Content width | 1150px. With the side panel open: about 730px list plus 420px panel. | 952px. The side panel overlays the right 480px as a non-modal sheet. |
| Vertical budget | Banner 28 + top bar 52 + identity bar 56 = 136px, leaving about 514px of working area. Key intake fields (comparison rows, routing card, action bar) must fit without scrolling. | Identity bar becomes two rows (76px). The action bar is fixed at the bottom of the workspace. |
| Density default | Compact (36px rows, 13px) | Comfortable (48px rows, 15px, 44px touch targets) |
| Tables | Column priority P1/P2/P3. When the panel opens, P3 columns hide and a "Columns" menu restores them. | P1 and P2 only. The rest are shown in the panel. Horizontal scroll keeps the first (identity) column sticky. |
| Zoom 200% | Switches to the tablet layout (at 683px effective width). Data tables may scroll sideways, which WCAG allows for data tables. | |

### 5.3 Sticky identity bar (current case or part)

Shown on `/intake` (current item), `/grossing` (current case and part), `/materials` (tray or request context) and `/cases/[id]`. It sits directly under the top bar and stays visible.

```
[Provisional INT-1014-032] [Part B: dorsal forearm, punch]  Avery Quinlan (Synthetic)  MRN 448210, EMA-SIM Sunrise Coast  |  Harbor Point Dermatology  |  [swatch] Dr. Elena Marsh  |  [pause] Hold H-0090: Part B
```

- Left: the identity chip (accession or provisional), then the part chip. When no accession exists yet, the provisional chip is shown with the word "Provisional". (The example above is Part B during demo step 3, before the accession exists and while its hold is active. After step 4 the chip shows `D26-04817 Accession, EMA-SIM DERM`; by then H-0090 has been released.) A PAS tag appears here only for cases with PAS work; the hero case has none.
- The synthetic patient name always carries a small "Synthetic" tag. The MRN always shows its tenant, because an MRN is only unique within one source system.
- Holds show as "Hold: Part B" in hold colors with a pause icon. The scope is always named.
- The bar is a `<section aria-label="Current case">`. It never scrolls away and never covers focused content (handled by `scroll-padding-top`).
- **Context change:** when a scan opens a different case or part, the bar updates, shows a 2px brand outline for about 1.5 seconds (no movement), and the live region announces "Now working on D26-04817 Part A". If the user has unsaved edits, a dialog appears first: "Unsaved changes for D26-04817 Part B. Save draft / Discard changes / Stay on Part B". Field values never carry over.
- Laterality mismatch display in the part chip: "Part B: dorsal forearm. Order says Right, bottle says Left." The part chip shows a warning icon. No value is auto-corrected.

### 5.4 Detail side panel (keeps list context)

- Opens on row click or `Enter` on a focused row. Focus moves to the panel heading. The URL gains `?selected=<id>`, so Back closes the panel and links can be shared.
- The list keeps its scroll position, filters and highlighted row. `J`/`K` keep moving through rows and the panel follows along.
- `Esc` closes the panel and returns focus to the row that opened it.
- The header has the record's identity chip, its status pill and "Open full record" (to `/cases/[id]`).
- Desktop: the panel sits beside the list (push layout, `<aside>`). Tablet: it overlays the list as a non-modal sheet with `--shadow-3`, and the list underneath stays scrollable.

---

## 6. Screen specifications

States that every route handles the same way are defined once in 6.0. Each route then lists only what is specific to it.

### 6.0 Shared state patterns

| State | Pattern | Example copy |
|---|---|---|
| Empty | What this is, why it is empty, how to start. Never just "No data". | "No open clarifications. New ones appear here when a discrepancy is recorded at intake." |
| Loading (first load) | Skeleton rows with the same row height, no spinner over the whole page | (no text; `aria-busy="true"` on the table) |
| Refreshing | Keep the current rows. Show "Refreshing..." beside the table title. No flash or layout jump. | "Refreshing..." |
| Error | Inline panel in danger tone: what happened, what is kept, how to retry. Unsaved input is never lost. | "Could not load the worklist. Your filters and unsaved notes are kept. Retry" |
| Conflict (stale update) | A conflict dialog (Section 7) listing each field: their value, your value, who saved and when. There is no blind overwrite. | "Luis Benitez saved changes to INT-1014-031 at 11:04 ET after you opened it." |
| Partial success | A summary banner listing each item that failed, with a retry for each. A partial result is never reported with a "Success" toast. | "8 of 10 labels submitted. 2 failed: D26-04749 A1-2 PAS, D26-04783 A1-5 H&E. Retry failed only" (illustrative copy) |
| Printer unavailable | Printer chip turns to danger "Unavailable (simulated)". Print buttons become "Queue for later". Jobs stay Planned or Queued and are never lost. | "Slide printer 1 (simulated) is unavailable. 3 jobs are queued and will not print until you release them." |
| Source offline | A stale-data banner across the top of the content. Rows show "as of" times. Actions that need the source are disabled with a visible reason. Local tasks still work. | "EMA-SIM Sunrise Coast unreachable since 10:41 ET (11 min). Showing last confirmed data. New orders and changes since 10:41 are not shown." |
| Duplicate prevented | Info toast and an entry in History. Nothing new is created. | "Already requested at 11:18 ET by you. No second request was created." |
| Unknown value | The word "Unknown" with a "?" icon, plus the reason when known | "Expected containers: Unknown (no source manifest)" |
| Read-only role | Actions are hidden or disabled with the reason. The page notes "Read only". | "Read only: Director (demo) can view but not change records." |
| Permission denied (server) | Danger inline message. No state changes. | "Not allowed: only the accessioning lead or supervisor can override a routing rule." |

### 6.1 `/intake`: arrival, reconciliation and routing

| | |
|---|---|
| Purpose | Reconcile what arrived against what was expected, compare order, container and requisition, suggest routing from approved rules, and raise discrepancies without stopping the rest of the bench |
| Primary users | Accessioners Maya Torres and Luis Benitez. Accessioning lead Kim Nguyen for exceptions and overrides. |
| Regions | **(1) Courier manifest strip** at the top: one compact row per office, using the seeded 11:00 delivery: "Harbor Point Dermatology: expected 4, received 4"; "Coral Lane Dermatology: expected 3, received 2, missing 1" (not the hero office); Mangrove Bay Dermatology: "Expected Unknown (no source manifest)". Counts are "so far" until every requisition is unpacked. Missing and extra counts are links to the items. **(2) Arrival queue** (left, 320px): intake items with provisional IDs and tabs "To review (n)", "Exceptions (n)", "Done (n)". **(3) Workspace** (right): identity bar, comparison panel, related-order card, routing card, and a sticky action bar at the bottom. |
| Key components | Provisional ID chip; **comparison panel** with three columns (Order, source, with tenant and order ID / Observed container, staff entry with a synthetic bottle-label image / Requisition) and rows for patient name, DOB, MRN and tenant, site, laterality, procedure (shave/punch), part designation, collection date. Rows that disagree show a warning icon and "Differs", with both original values kept. **Related-order candidate card**: "Possible related order. Needs review." It lists reasons (same source-scoped patient reference, same encounter, same office and collection date) and conflicts (two order IDs: ORD-77120, ORD-77121), and states "Linking does not merge records." **Routing card**: "Suggested dermatopathologist: Dr. Elena Marsh. From rule: Harbor Point Dermatology to Dr. Elena Marsh (rule set v3, effective 2026-09-01)." Unknown office: a "Routing exception" warning card with no doctor chip. Simulated labels next to "Request accession". |
| Primary actions (in order) | 1 **Staff verified against physical container** (records who and when; a scan alone never sets this). 2 **Raise clarification** (from a differing row, pre-filled with that field). 3 Related orders (accessioning lead or supervisor, reason required): **Link as related: one accession, parts kept with their original orders** / **Keep separate (separate cases)** / **Not related** / **Ask the office first** (accession waits). "Escalate to lead" is not a state: the review task is already owned by the accessioning lead. 4 **Accept routing** / **Override routing** (accessioning lead or supervisor, reason required). 5 **Request accession (simulated source)**, which shows the issued accession `D26-04817` labeled "Issued by EMA-SIM (simulated)". |
| Keyboard | Scan field focused on load. Scanning a container label or order ID opens the matching item. An unmatched label prompts "No matching order found. Create provisional intake item?" (`Enter` creates, `Esc` cancels). `Tab` order: identity bar actions, comparison rows (each differing row has "Raise clarification for this field"), related-order card, routing card, action bar. `J`/`K` move between queue items. `Ctrl/Cmd+Enter` runs the current step's primary action. |
| Route-specific states | **Empty:** "No arrivals recorded for the 11:00 courier yet. Scan the first container." **Conflict:** on save, stale detection triggers the conflict dialog (for example Maya and Luis both editing INT-1014-031). A live presence note ("Luis Benitez also has INT-1014-031 open") was planned but is not built. **Partial success:** "Accession requested for 3 items. 2 issued, 1 failed (source timeout). Retry." **Printer unavailable:** requisition sticker jobs queue. **Source offline:** "Request accession" is disabled with "Source system unreachable (simulated outage). Your verification is saved locally. Request the accession when the source is back." **Exception lane:** items in Exceptions do not block other items. The tab shows the note "Other containers can continue under local policy." |

### 6.2 `/clarifications`: specimen-specific questions that close the loop

| | |
|---|---|
| Purpose | Track each question to the submitting office from draft to reviewed resolution, with ownership, follow-up time and a hold limited to the affected material |
| Primary users | The clarification's lab owner (for CLR-0457, accessioner Maya Torres). Accessioning lead Kim Nguyen reviews answers, resolves and releases holds. Supervisor Tanya Brooks for overdue items. |
| Regions | Saved-filter tabs (My open, Overdue, Awaiting office, Needs review, Resolved). Queue table. Side panel with the full clarification. |
| Queue columns | P1: CLR ID, affected material (for example "D26-04817 Part B"), type (Laterality), state pill, next follow-up ("Overdue 12 min" in danger text, or "11:30 ET"). P2: office, office contact role, lab owner. P3: priority, last event. |
| Side panel | Question (original text, kept unchanged). **Evidence**: "Order says: Right dorsal forearm (ORD-77121)" next to "Bottle label says: Left dorsal forearm", with the synthetic label image. **Hold scope**: "Holding Part B only. Part A can continue." **State timeline**: Drafted, Sent (simulated), Delivery unknown / Failed / Delivered, Acknowledged, Answered, Reviewed, Resolved, with times and actors. **Draft text**: labeled "Draft text: deterministic demo output, not live AI. Edit before sending." It contains no patient details by default. **Office answer**: a simulated reply is shown as "Simulated office reply received 11:12 ET", never as resolved. |
| Primary actions | Send (simulated). **Record delivery outcome** (the simulated connector sets one automatically; staff can record one they learned another way, with a "how you know" note, audited). Record acknowledgment. Record office answer. **Review answer**. **Resolve** (accessioning lead or supervisor; a resolution note is required). Resolving does **not** release any hold: the resolve dialog lists the linked holds and offers "Also release H-…" as a separate, optional step that needs its own reason and is recorded as a separate hold release; leaving it unchecked keeps the hold (for example until an amended order arrives). **Release hold** is also available on its own (lead or supervisor, reason required; while the clarification is still open, only the supervisor, with an override reason). Follow up, Escalate, Cancel (reason required; linked holds stay until released separately). |
| Keyboard | `J`/`K` move rows, `Enter` opens the panel, `Esc` closes it. Inside the panel, `Tab` follows the timeline order, and the next valid action is the first button. |
| Route-specific states | **Empty:** "No open clarifications." **Delivery unknown:** a warning pill and "No delivery confirmation from the simulated notification connector. Follow up by phone per local policy." **Duplicate suppression:** "A reminder was already sent at 11:15 ET. Next reminder allowed at 11:45 ET." **Permission:** "Resolve" and "Release hold" are disabled for roles that may not use them, with the reason shown. (A rule requiring a reviewer different from the person who recorded the answer is a possible local policy; it is not built.) |

### 6.3 `/worklist`: the digital doctor/PAS worklist (replaces the information role of "the bible")

| | |
|---|---|
| Purpose | One shared, filterable daily list grouped by assigned dermatopathologist, showing readiness, holds, owners and approved stains, so nobody has to rely on the printed copy for status |
| Primary users | Histotechs Priya Shah and Marcus Lee; grosser; histology assistant; accessioners; supervisor |
| Regions | **View tabs**: Accessioning, Grossing and source entry, Histotech, Operations (each is a saved set of columns and filters; source-system entry is part of the grossing view, so acknowledgments are stored per view). **Change strip**: "Since your last acknowledgment (10:30 ET): 3 new, 2 changed, 1 canceled. Acknowledge (records version v128)". **Filter row**: doctor, stage, PAS only, on hold, my work, plus saved filters. **Grouped table**: one group per doctor. **Side panel.** |
| Doctor group header | 40px. Doctor tint background, 4px left stripe in the doctor color, then "Dr. Elena Marsh", the color name "teal" in muted text (a fictional demo color, written out so the group can be named in grayscale print and by color-blind users), and counts: "18 cases, 4 PAS, 2 on hold". Collapsible. Routing exceptions have their own group, "Unassigned: routing exception", with a dashed outline and no color. |
| Columns | P1: accession chip; parts (for the hero case after step 5: "A approved, B awaiting grossing"); stage; **Stains** (PAS tag with the work order, for example "PAS (WO-2142) A1-2" on D26-04749); hold; readiness ("Eligible: A1 for processing" / "Not ready: Part B awaiting grossing"; a part that is still on hold reads "Not ready: Part B on hold"). P2: current task owner; last confirmed update (time and source: "Local" or "EMA-SIM (simulated)"); blocks prepared/expected ("1 of 2", or "Unknown"). P3: office; ordering clinician. |
| Row markers | Change tags as text: **New**, **Changed** (the changed field is listed in the panel), **Canceled** (the stain text is struck through and the word "Canceled" shown, and the row stays visible). Hold rows have a 3px hold stripe on the left edge plus the "Hold" pill. PAS rows may use the pale PAS row tint. Selection replaces the tint with brand-50 and a brand left edge, and the PAS tag stays. |
| Primary actions | Acknowledge changes. Open a record. **Print snapshot / Export** (downtime fallback). Claim task (set owner). |
| Print snapshot | A print stylesheet produces a compact list. The header reads "Worklist snapshot v129. Generated Wed 2026-10-14 10:52 ET by Priya Shah. Not updated after printing." It has a section per doctor titled "Dr. Elena Marsh (teal)". PAS rows show the word "PAS" in a bordered box, so the printout works in grayscale. A footer: "Demo: synthetic data." |
| Keyboard | `J`/`K` or arrow keys move rows, `Enter` opens the panel, `Space` expands or collapses a group header, `A` acknowledges changes (asks first), `P` prints the snapshot. Single-key shortcuts can be turned off in Settings (WCAG 2.1.4). |
| Route-specific states | **Empty:** "No cases for today yet. Cases appear after accessioning." **Source offline:** the stale banner shows, the change strip says "Change tracking paused: source unreachable", and the snapshot header adds "Source data as of 10:41 ET". **Source amendment:** a canceled or amended stain order on material already printed or prepared shows a warning, for example after the seeded 11:20 amendment: "Needs review: PAS canceled after slide D26-04749 A1-2 PAS was printed" (WO-2142). Nothing is removed. |

### 6.4 `/grossing`: reviewed gross record per part

| | |
|---|---|
| Purpose | Capture a structured, reviewed gross record for the exact scanned part, so a finished part can move on to the next queue without waiting for the whole day's batch |
| Primary users | Grosser Dana Whitfield. Sam Ortiz picks up the resulting source-system entry task. |
| Regions | Identity bar (case and **part**). **Parts strip**: after demo step 5, "Part A: Approved, source update pending" and "Part B: Awaiting grossing". A part that still has an active hold shows "On hold (H-0090)" with its hold ID (in the scripted demo, H-0090 is released in step 3, before grossing). **Left: transcript** (synthetic dictation). Highlighted phrases link to the fields they produced. Labeled "Synthetic transcript. Extraction is a deterministic demo." **Right: structured fields**: specimen type; piece count; dimensions as three numbers with an explicit unit selector (mm/cm, no default assumed); orientation and ink; cassette allocation (A1, ...); local template fields. **Narrative editor** below. **Status stepper**: Draft, Operator reviewed, Approved for downstream use, Source update pending, Entered (staff attested), Source acknowledged (simulated). "Needs clarification" is a side state shown on the draft. |
| Field states | Every field shows where its value came from: **Proposed from transcript** (dashed outline, link to the source phrase), **Confirmed by operator** (solid, who and when), **Missing** (warning, "Not stated in transcript"), **Ambiguous** (warning, "Transcript says '0 5 cm'. Confirm 0.5 cm or 5 cm."). Numbers, units and counts each need an explicit Confirm. Template defaults are never pre-filled as if observed. |
| Primary actions | Confirm field. Mark operator reviewed. **Approve for downstream use** (blocked until every number, unit and count is confirmed; the reason is shown, for example "2 values need confirmation: piece count, unit for length"). This creates the downstream tasks "Enter approved gross description in source system — D26-04817 part A" (owner Sam Ortiz) and "D26-04817 A1 eligible for the next processing run". Then **Mark entered (staff attestation)** by the histology assistant or supervisor, which moves the record to "Entered in source system (staff attested)", never to "acknowledged". Only after that, the labeled demo control **Simulate source acknowledgment (demo)** can move it to "Source acknowledged (simulated)". |
| Keyboard | Scanning a cassette or part label opens that exact part. Scanning a different case triggers the context-change rule (5.3). `Tab` moves through fields in body order. `Enter` on a proposed value confirms it. `Alt+Down` jumps to the next unconfirmed field. `Ctrl/Cmd+Enter` runs the next step's action. Microphone: shown as "Microphone input: not configured in this demo" (disabled with that reason). |
| Route-specific states | **Partial completion:** Part A approved while Part B remains "Awaiting grossing" (or "On hold" if a hold is still active). The case is never shown as "Grossing complete". **Conflict:** another grosser saved the same part, which opens the conflict dialog. **Source offline:** approval still works locally. The source-entry task shows "Source update pending: source unreachable". **AI unavailable:** "Extraction not available. Enter values manually." Every field stays editable. |

### 6.5 `/materials`: print jobs, trays, retrieval (tabs)

**Tab 1: Print jobs**

| | |
|---|---|
| Purpose | Queue labels tied to official IDs and authorized work, show honest printer outcomes, and reconcile unknown outcomes before any retry |
| Users | Histotechs, accessioners, histology assistant |
| Regions | Printer status chip ("Slide printer 1 (simulated): Online"). Job table: PJ ID, items, reason (first print / reprint damaged label / reprint after failure / reprint after unknown outcome; an additional slide appears as the first print of a new slide created by a work order), state pill, submitted at, operator. Side panel with a **label preview**: a bwip-js DataMatrix plus readable text (for example "D26-04783 A1-5 H&E" for PJ-8841), with the caption "Screen preview only. Not validated for scanners, solvents, processors or stainers." |
| States shown | Planned, Queued, Submitted, Acknowledged, Completion confirmed, Failed, **Unknown outcome**, Canceled |
| Unknown outcome flow | Warning banner on the job: "PJ-8841: printer did not confirm after 30 s (simulated timeout). Outcome unknown. Check the printer output before retrying." Choices (one outcome per job, because each job prints for one target): **Label printed** / **Not printed** / **Can't tell (escalate)** / **Printed but damaged**. "Can't tell" and "damaged" need a note. "Can't tell" keeps the job in Unknown outcome, opens a supervisor escalation and keeps retries blocked. A reprint is enabled after "Not printed" (or opened as a task after "damaged"). A reprint asks for a reason and links to the original job. "Order additional slide" is a separate action that creates a work order, not a reprint. Double-clicking "Print" never creates a second job ("Already queued as PJ-8841"). |

**Tab 2: Trays**

| | |
|---|---|
| Purpose | Assemble a tray by checking each required slide individually. One tray scan never verifies every slide. |
| Flow | 1 Scan tray, which sets the scan target to "Add to tray TRY-M-03". 2 Scan a case or choose one from the expected list. 3 Scan each slide. Expected list rows: **Expected** (not yet scanned), **Scanned, matches** (success; the copy says "Scanned", not "verified"), **Missing**, **Unexpected**, **Duplicate**, **Canceled**. |
| Completion | "Mark tray complete" is refused while anything is missing or unexpected. The reason is shown, for example on TRY-M-03 (an earlier Dr. Marsh tray, demo step 6): "Cannot complete: 1 not scanned (D26-04747 A1-2), 1 unexpected (D26-04745 A1-1)." Controlled resolution: **remove** the unexpected slide from the tray; record the missing slide as **follows separately** (still being prepared or found elsewhere) or **missing: open an investigation**, each with a note; then a **supervisor** may **release the tray with exceptions**, listing what is outstanding. A label reprint is offered only for a slide that is **present** but has an unreadable label; a reprint never supplies a missing slide. A new slide needs an authorized work order ("Order additional slide" on Print jobs). |
| Keyboard | The scan field stays focused for the whole tray session. Each scan result is announced. `Esc` ends the tray session (asks first if items are unresolved). |

**Tab 3: Retrieval**

| | |
|---|---|
| Purpose | Find and pull blocks: last confirmed location, checkout history, and a scan check against the request |
| Regions | Request list (RR-0192 and others; filters Open, Overdue, Outside send-outs). **Pick list grouped by location** (cabinet, drawer, box) that still shows the receiving bench's required order ("Pick order 2 of 3"). Request panel for RR-0192 (Dr. Okafor, destination Microtomy bench 2): requested blocks **D26-03990 B1**, **D26-03990 A1** and **D26-03912 A1** (earlier synthetic cases, demo step 7), with a location card and checkout history for each. |
| Location card | "Last confirmed: CAB-2/DR-4/BX-11/S-14 (Cabinet 2, Drawer 4, Box 11, Slot 14). Confirmed Fri Oct 9, 15:20 ET by Marcus Lee." (D26-03990 A1.) D26-03912 A1 shows "Checked out to Marcus Lee" and is overdue. Fixed caption: "Last confirmed location, not live tracking. The block may have moved since." |
| Scan check | The scan target is "Check block for RR-0192". A match shows a success pill: "Scanned D26-03990 B1, matches RR-0192". A **wrong block** shows a danger message, announced as an alert: "Mismatch: scanned D26-03909 A1; RR-0192 needs D26-03990 B1, A1 and D26-03912 A1. Nothing changed." Nothing changes, and an optional sound plays. |
| States | Not found at the last location, which opens a "Missing-material investigation". Partial retrieval. Overdue return. Conflicting location or custody records (for example a block recorded as sent outside the lab, or checked out to someone else, is scanned): both records are shown with times and people, the pick is not accepted, and a supervisor decides; nothing is auto-resolved. |

### 6.6 `/cases/[id]`: one case, everything linked

| | |
|---|---|
| Purpose | One place to follow a multipart case: parts, material, source documents, tasks and history |
| Users | Everyone. Read-only for directors. |
| Regions | Identity bar. Tabs: **Overview**, **Material**, **Source documents**, **Tasks and clarifications**, **History**. |
| Overview | One card per part (A, B). Each has **two separate progress tracks**: *Physical* (received, grossed, processing, embedded, sectioned, stained, QC reviewed) and *Documentation* (gross draft, reviewed, approved for downstream use, source-system entry pending, entered (staff attested), source acknowledged (simulated)). Holds are shown with their scope. Readiness is derived and explained ("A1 eligible for processing: gross record approved, cassette received"). A case-level summary never says "complete" while any part is incomplete. People are listed by role: ordering clinician Dr. Hannah Cole; assigned dermatopathologist Dr. Elena Marsh; accessioner Maya Torres; current task owner per part. |
| Material | A tree: part, then cassette/block, then slides (stain and level). Each node has its ID chip, print status and last location. Expected, received, prepared and verified counts are kept separate ("Slides: 3 expected, 2 prepared, Unknown verified"). |
| Source documents | ORD-77120 and ORD-77121 both preserved, with original values, versions, source update time and import time. The related-order record shows "REL-0112: linked as related by Kim Nguyen, 11:03 ET. Not merged." A post-accession discrepancy shows a cross-reference record, never a renumbering. |
| History | Audit timeline (Section 7). Filter by part, actor, or source (Local / Source (simulated) / Demo clock). |
| States | Unknown case ID: "No case D26-04899 in this demo. Check the number or scan again." Source offline: Source documents tab shows "as of" times. |
| Route parameter | `/cases/[id]` accepts either the internal record ID or the accession number (case-insensitive), for example `/cases/D26-04817`. The internal ID is never shown as a clinical identifier. In this demo there is one accession namespace, so the number alone is unique; with several namespaces the route would need the namespace too. |

### 6.7 `/operations`: what is blocked right now and who owns it

| | |
|---|---|
| Purpose | Current-state view for the supervisor and leadership: what is blocked, who owns the next step, how old it is, and the evidence. Every number opens the records behind it. |
| Users | Tanya Brooks (supervisor). Director (demo) and Medical director (demo), read only. |
| Regions | **Note line**: "Computed from synthetic demo data at demo clock 10:52 ET. Not observed lab performance." **Status tiles** (counts only, each a link to a filtered list), as built: Holds open; Clarifications overdue; Parts awaiting an approved gross record; **Approved records awaiting source-system entry**; **Entered (staff attested), awaiting source acknowledgment** (a separate tile, because an attestation is not an acknowledgment); Print jobs with unknown outcome; Trays blocked or in exception; Block retrieval requests open; Routing exceptions. A "Pending handoffs" panel is a computed summary (deterministic demo, not AI). **Blocked work table**: item, what blocks it, next step, owner, waiting since (age), evidence link. Sorted oldest first. **Source freshness panel** per tenant. **Queue age by stage** (horizontal stacked bars, ordinal age ramp, table view toggle). |
| Rules | No scores, grades, rankings of staff, or "health" percentages. If a count cannot be computed (for example, source offline), the tile shows "Unknown, source unreachable since 10:41 ET", not 0. |
| Keyboard | Tiles are links in reading order. The table follows standard row navigation. |

### 6.8 `/insights`: trends and measurement definitions (illustrative)

| | |
|---|---|
| Purpose | Show how a pilot would be measured, using illustrative synthetic prior-day events, with definitions visible |
| Users | Director (demo), Medical director (demo), supervisor |
| Regions | A filter row above everything (date range among seeded days, office, doctor). Every chart title carries the tag "Illustrative: synthetic prior-day data". Each metric has a "Definition" disclosure: numerator, denominator, start and end events, exclusions, data source. |
| Charts (form chosen per `dataviz`) | **Volume by hour** (single-series columns, brand color). **Queue age by stage** (stacked horizontal bars, ordinal age ramp, legend plus direct labels on the largest segment). **Clarification acknowledgment and resolution time**: stat tiles showing median and 90th percentile with n, plus **"Still open: k" shown separately** and **"Missing event data: m"**. **Gross approval to source-system entry delay** (to the staff attestation, which is what the lab can observe today; not to an acknowledgment): single hue, plus the time of day entries were made. **Cases by assigned dermatopathologist**: bars in doctor colors with doctor names as direct labels. |
| Chart rules | No dual axes. No animation (`isAnimationActive={false}`). Hover and focus tooltips. Each chart has a "Show as table" toggle. Missing data appears as a gap labeled "No data", never as zero. No savings, cost or ROI figures appear in the charts. A separate **scenario calculator** card on the same page starts blank, is labeled as potential labor value (not cash), and computes money only when the user enters an agreed rate (`pilot-proposal.md` §8). |

### 6.9 `/settings`: routing rules, demo scenarios, integration capabilities, office contacts, preferences

| Tab | Content |
|---|---|
| Routing | Versioned rule table: office, tenant, dermatopathologist (swatch and name), rule set version (v3), effective from 2026-09-01, coverage exceptions. **Unknown offices** queue (Seagrape Skin Studio: "No approved rule. New items go to the routing exception lane."). Editing creates a draft version that needs a reason and approval by a permitted role. Past versions are read only. |
| Demo scenarios | Every control is labeled as a demo control and changes the simulated world, not lab records. Reset demo data (dialog: "Reset all demo data to the 10:52 starting state?"). Demo clock (jump to 11:00, 11:04, 11:20, 11:25; never backwards except by reset). Per simulated source: **Simulate outage / Restore connection**, **Slow link (5 min delay)**, **Sync now**. Scenario controls: **Deliver queued source messages now**, **Replay a duplicate message**, **Deliver an out-of-order older version**, **Fail the next message** (these cover acceptance checks 11, 13 and 14; the seeded outbox also delivers the 11:04 duplicate, the 11:20 PAS cancellation and the 11:25 stale replay on its own). Printers: online / offline / time out after submit. Notifications: make sends fail. Assistant: make unavailable. Rate limiting (429) and partial-page failures are **not** simulated (see `integration-capability-matrix.md` §4.2). |
| Integration capabilities | One card per simulated connector (source adapters, printers, notifications, drafting and extraction assistant) with last successful sync, last attempt and its capability notes, plus a **field-by-field capability summary**: one row per required field or action, each with exactly one of four words, **Simulated**, **Documented**, **Unknown** or **Unsupported**, with unknowns, candidate interface and fallback (condensed from `integration-capability-matrix.md`). "Implemented" is never used for a connector. Also: the integration event log with each message's outcome, the failure queue with a supervisor retry, and the rollout modes A–D. Implementation details live here, not on bench screens. |
| Office contacts | The fictional office contact and coverage directory, per office: working hours (or "Unknown" when not on file), each contact's role, simulated channel, primary and escalation flags, covered clarification categories, "out until" coverage gaps and backup contact, and a preview of who new clarifications go to. Edits are by the supervisor, need no real contact details, detect stale edits and are audited. Every channel is labeled simulated. Seagrape Skin Studio shows an unverified contact. |
| Preferences (per browser) | Density (Compact/Comfortable). Sound feedback (off by default) with volume and "Play test sound". Single-key shortcuts on/off. Scanner suffix (Enter or Tab). Reduce motion (follows the system setting by default). |

### 6.10 `/demo`: guided 5-minute demonstration

| | |
|---|---|
| Purpose | Let Jorge walk a director through one multipart case (plus two earlier cases for the materials steps) in about 5 minutes on the real screens, with speaker notes and a before/after workflow map |
| Regions | Tabs: **Guided demo**, **Workflow map** (before / proposed after), **Speaker notes**, **Real vs simulated**. The guided tab has a stepper with the 8 narrative steps from the master spec: courier arrival, A/B related orders, Part B clarification and hold, accession issued, Part A gross record and worklist update, tray and printer issues, block retrieval, operations view. Steps 1–5 follow the hero case (D26-04817); steps 6 and 7 use earlier synthetic cases (TRY-M-03, PJ-8841, RR-0192), and the step text says so. Each step can run its simulator events only (the presenter does the staff actions on the real screens) or, for rehearsal by the supervisor demo role, the staff actions too. Progress is derived from the records, not from button clicks. |
| Coach panel | "Go to step" opens the real route with a docked, non-modal coach panel at the bottom (collapsible, 160px). It shows: step title, what to click, what to notice, and "Real vs simulated in this step" (for example, "Simulated: office reply, accession issuance. Working: hold scoping, worklist update."). Prev/Next buttons. The panel never covers the identity bar or primary actions. |
| Controls | Reset demo (same confirmation as Settings). Jump demo clock to the step's time. "Presenter text size" toggle (+2 steps on the type scale). |
| Workflow map | Two swimlane diagrams (HTML/SVG, not images): Before (memory-based routing, EMA messages, paper "bible", evening batch gross entry) and Proposed after. Titled "Proposed. Not yet validated with lab staff." Each lane has a text equivalent. |
| Copy guard | Footer on every step: "This demonstration uses synthetic data and simulated connectors. It does not show clinical performance or a production integration." No director endorsement is implied. Fictional names only. |

---

## 7. Component inventory

All components use tokens only. All interactive components have default, hover, active, focus-visible, disabled (with a visible reason) and loading states. All work with keyboard and touch.

| Component | Variants and sizes | Key rules | Accessibility |
|---|---|---|---|
| **Button** | Primary (brand fill, white text), Secondary (white, strong border), Ghost (brand text), Destructive (danger solid, white text), Quiet (row actions). Sizes sm 32, md 40, lg 48 (44 minimum on tablet). | Verb-first labels ("Request accession", "Record office answer"). One primary per region. Loading keeps the width and shows "Requesting..." while disabled, which also prevents double submits. Destructive buttons always open a confirm dialog naming the object. | Native `<button>`. Disabled buttons have `aria-describedby` pointing to the visible reason. |
| **Status pill** | Tones: neutral, info, success, warning, danger, hold. Height 24px (28 on tablet), pill radius, icon 14px plus text. | One status pill per row in tables. Other facts go in their own columns as plain text. The text is the status name in sentence case, from the state vocabulary below. | Icon `aria-hidden`; the text is the accessible name. |
| **Accession chip (official)** | Default / compact | Solid 1px brand border, brand-50 fill, `#` icon, mono 600 `D26-04817`, with a namespace caption "Accession, EMA-SIM DERM" (caption hidden in compact rows, shown in the tooltip and panel). | `aria-label="Accession D26-04817, namespace EMA-SIM DERM"` |
| **Provisional intake chip** | Default / compact | **Dashed** 1.5px muted border, white fill, dashed-circle icon, mono 500 `INT-1014-031` in secondary text, and the word **"Provisional"** always visible, including in compact rows. It never uses the brand fill. | `aria-label="Provisional intake item INT-1014-031, not an accession number"` |
| **Other ID chips** | Part, block, slide, CLR, WO, PJ, TRY, RR, ORD, MRN | Subtle fill, no border, mono. The slide chip includes the stain ("D26-04749 A1-2 PAS"). MRN and ORD chips carry the tenant name. Chips link to the record. | Link name = full ID plus type |
| **Doctor chip** | Full ("Dr. Elena Marsh"), compact ("Dr. Marsh"), with color name (snapshot and group header) | 12x12 rounded square swatch plus the name in body text. Never initials only, never text inside the swatch. Unassigned: dashed empty swatch plus "Unassigned: routing exception". | Swatch `aria-hidden`; the name carries meaning |
| **PAS tag** | Tag ("PAS"), detailed ("PAS (WO-2142) A1-2") | Highlighter yellow fill, dark border, flask icon and the text "PAS". Shows the originating order or protocol and the affected block or slide in detail views. PAS is never inferred from diagnosis text. | Text "PAS" read aloud; detailed variant is read in full |
| **Hold banner** | Banner (part or case), row stripe, solid "HOLD" tag | Hold tint, 4px hold stripe, pause icon. Title names the scope: "Part B on hold: laterality mismatch". Body: evidence, linked clarification, owner, next follow-up. A scope line: "Hold applies to Part B only. Part A can continue." It cannot be dismissed. It is released only by an authorized person (accessioning lead or supervisor) with a reason, as its own audited action. Resolving the linked clarification does not release it. While the clarification is still open, only a supervisor can release it, with an override reason. A hold placed in error is also released with a reason that says so. | `role="status"` on first appearance; heading inside |
| **Alert banner** | info, success, warning, danger | Left stripe, icon, title and body, optional action. Warning and danger banners are not auto-dismissed. | `role="status"` (info, success) or `role="alert"` (danger that blocks the current action) |
| **Conflict dialog** | Single field / multi field | Native `<dialog>` (modal). Title: "Someone else changed this item". A table of field, their value (who, when), your value. Actions: **Load latest and re-apply my changes** (choose per field), **Discard my changes**. There is no "Overwrite" option. | Focus goes to the title. `Esc` equals "Keep editing" (closes without saving and keeps your edits in the form, which is still marked stale). |
| **Confirm dialog** | Standard, destructive | The title names the action and object ("Reset all demo data?"). Buttons say what they do ("Reset demo data" / "Keep current data"). Never "OK" / "Cancel" alone. Initial focus goes to the safe option. | Native `<dialog>`, focus returns to the trigger |
| **Simulated-connector label** | Inline tag, card header | Plug icon, dashed border, "Simulated" plus the connector name ("Simulated: notifications"). Placed only where data leaves the app or arrives from a connector: send, print, accession request, sync indicator, AI draft. | Text is read aloud |
| **Stale-data banner** | Page-level | Warning tone, clock icon: "[Source] unreachable since 10:41 ET (11 min). Showing last confirmed data." Live-looking indicators turn gray, and "as of" times appear on rows. | `role="status"`, announced once, not on every tick |
| **Unknown value** | Inline | "?" icon plus "Unknown", plus the reason when available. Never 0, blank or a dash. | Read as "Unknown, reason" |
| **Scan field and result line** | Global | Prefix chip with the scan target, 20px mono input, and a result line below with icon and text: "Scanned D26-04817 A1. Matched request RR-0192." Errors: "Not recognized: 'D26-0481'. Check the label or type the full ID." | Result line is an `aria-live="polite"` region. Blocking mismatches use `role="alert"`. |
| **Data table** | Compact / Comfortable | See conventions below | Native `<table>`, `<th scope>`, `aria-sort`, a caption (may be visually hidden), `aria-selected` on the selected row |
| **Timeline / audit list** | Case history, clarification timeline | Newest first (toggle). Each entry: absolute time (ET), actor and role, verb, object chip, a source tag (Local / Source (simulated) / Demo clock / Simulated office reply), and expandable details with original and new values. Header note: "Local append-only audit log for this demo. Not proof of tamper resistance." | `<ol>` with `<time datetime>` (UTC) |
| **Toast** | info, success, warning | Bottom right (bottom center on tablet). Success toasts auto-dismiss after 6 s and can be paused on hover or focus. Warning toasts stay until dismissed. Errors go in inline banners, not toasts. A toast is never the only record: the event is also in History. | `aria-live="polite"` region; a toast never takes focus |
| **Stat tile** | Count, median/p90 | Label, value (proportional figures), n and "Still open" or "Missing data" lines, "Illustrative" tag where applicable. The whole tile links to the records. No sparkline unless it answers a question. | Link name includes label and value |
| **Label preview** | Slide, cassette, requisition sticker | DataMatrix (bwip-js) plus readable text. Caption: "Preview only. Not validated for scanners, solvents, processors or stainers." | `alt="DataMatrix label encoding D26-04749 A1-2 PAS"` |

**Data table conventions**
- Sticky header, offset below the top bar and identity bar. The first column (identity) is sticky when the table scrolls sideways.
- Density follows Preferences. Numbers are right-aligned with `tabular-nums`. Timestamps show "10:40 ET (12 min ago)", with the full date and UTC in the tooltip and panel.
- Sorting by clicking a header or pressing `Enter` on it. The sort arrow is a visible icon and `aria-sort` is set. Defaults are stated in the caption, for example "Sorted: holds and overdue first, then oldest".
- Saved filters appear as tabs or chips above the table, with counts. Filter state is kept in the URL. A count line reads "Showing 18 of 61 cases".
- Rows open the side panel. Row actions are Quiet buttons that appear on hover or focus and are always reachable by `Tab`.
- Empty cells: "None" when known to be empty, "Unknown" when not known. Never blank.

**State vocabulary for pills** (same wording everywhere; regenerated from the stored states in the built schema and `src/lib/domain.ts`)

| Domain | States (tone) |
|---|---|
| Clarification | Drafted (neutral), Sent (simulated) (info), Delivery unknown (warning), Delivery failed (danger), Delivered (info), Acknowledged by office (info), Answered — awaiting lab review (info), Answer reviewed (info), Resolved (success), Canceled (neutral). Labels come from `src/lib/domain.ts`, the single source for state wording. |
| Gross record | Draft (neutral), Needs clarification (warning), Operator reviewed (info), Approved for downstream use (success) |
| Source-system entry (separate from the gross record state) | Source-system entry pending (warning), Entered in source system (staff attested) (warning or info; still awaiting the source), Source system acknowledged (simulated) (success), Source update failed (danger). In compact places: "Source update pending", "Entered (staff attested)", "Source acknowledged (simulated)". Never "Acknowledged" for an attestation. As built, `src/lib/domain.ts` labels the acknowledged state "Source system acknowledged" without "(simulated)" (grossing record panel, case view, worklist side panel), and no action in the demo sets "Source update failed" (see `data-model.md` SM-16). |
| Print job | Planned, Queued (neutral), Submitted, Acknowledged (info), Completion confirmed (success), Failed (danger), Unknown outcome (warning), Canceled (neutral). Reconciliation outcomes: Label printed, Not printed, Can't tell (escalated), Printed but damaged. |
| Tray slide | Expected (neutral), Scanned, matches (success), Missing (danger), Follows separately (warning), Unexpected (warning), Duplicate (warning), Canceled (neutral), Removed from tray (neutral). Tray: Open, Assembling, Exception, Verified complete, Released with documented exceptions, Delivered. |
| Related orders | Needs review (warning), Approved: one accession, parts kept with original orders (info), Kept as separate cases (neutral), Not related (neutral), Asked the office (warning) |
| Intake item | Received, In review, Accession requested, Accessioned, Canceled |
| Routing | Suggested by rule (neutral, shows rule version), Confirmed (neutral), Routing exception — no approved rule (warning), Overridden (info, shows reason) |
| Hold | Active hold (hold tone, always with its ID and scope, e.g. "H-0090: Part B"), Released (neutral, with who, when and reason in History) |
| Source sync | Synced (success), Delayed (warning), Offline (danger), Unknown (neutral), always with a Simulated tag. Never "Live". |

**Icons:** from `lucide-react` (pinned in `package.json`), at 14/16/20px: info circle, check circle, triangle alert, octagon x, pause circle, help circle (unknown), clock (stale), plug (simulated), flask (PAS), dashed circle (provisional), hash (accession), scan, printer, tray, archive box, chevrons, close. Icons are decorative (`aria-hidden`); the text carries the meaning.

---

## 8. Keyboard model (all routes)

| Key | Action | Notes |
|---|---|---|
| `/` or `Ctrl/Cmd+K` | Focus the scan/search field | Not active while typing in a text field |
| `Enter` | Submit scan; open the focused row; confirm a proposed value | |
| `Esc` | Close the panel or dialog and return focus to where it came from; clear the scan field | Never discards unsaved data without asking |
| `J` / `K` (also Up/Down in tables) | Next / previous row or queue item | Single-key shortcuts can be turned off |
| `Ctrl/Cmd+Enter` | Primary action of the current step | Shows the same confirmation as a click |
| `Alt+Down` | Next unconfirmed or invalid field (grossing, intake) | |
| `G` then `I` / `C` / `W` / `G` / `M` / `O` | Go to Intake / Clarifications / Worklist / Grossing / Materials / Operations | Listed in the help dialog; off when single-key shortcuts are off |
| `?` | Keyboard shortcut help | |

Scanners are treated as keyboards: they type the code and then press Enter (or Tab, set in Preferences). After any completed action, focus returns to the scan field on bench routes.

---

## 9. Accessibility checklist (target WCAG 2.2 AA)

The `design:accessibility-review` skill references WCAG 2.1. This spec targets 2.2 AA, which includes everything in 2.1 plus focus-not-obscured and target-size rules that matter for sticky bars and tablets.

**Perceivable**
- [ ] All text/background pairs at or above 4.5:1, controls and meaningful graphics at or above 3:1 (Section 3.3, computed).
- [ ] Status, doctor, PAS, hold, provisional and simulated states always have text or an icon as well as color (1.4.1).
- [ ] Windows High Contrast / `forced-colors`: pills, chips and banners keep visible borders; the PAS tag and hold stripe use `forced-color-adjust: none` only where needed and keep their text.
- [ ] Synthetic label images and DataMatrix previews have alt text giving the encoded content (1.1.1).
- [ ] Charts each have a table view; tooltips are never the only way to read a value.
- [ ] Reflow: at 200% zoom the tablet layout applies with no loss of content; data tables may scroll sideways (1.4.10 exception).

**Operable**
- [ ] Every action works by keyboard (2.1.1). No keyboard traps; dialogs trap focus only while open (native `<dialog>`).
- [ ] Visible focus ring on every interactive element (2.4.7). `outline: none` is never used without the token ring.
- [ ] Focus not obscured: sticky top bar, identity bar and table headers never cover the focused element (`scroll-padding-top`) (2.4.11).
- [ ] Logical tab order: skip links ("Skip to scan field", "Skip to main content"), then the top bar, nav, identity bar, page body, side panel (2.4.3).
- [ ] Opening the panel moves focus to its heading. Closing it returns focus to the originating row.
- [ ] Single-key shortcuts can be turned off (2.1.4).
- [ ] Touch targets at least 44x44px in Comfortable density and never below 24x24px anywhere, with at least 8px between adjacent targets on tablet (2.5.8).
- [ ] No time limits. The demo clock only moves when the presenter moves it.
- [ ] Reduced motion: honor `prefers-reduced-motion`; app transitions are 180ms or less and are opacity or short slides; charts never animate; the context-change highlight is a static outline.

**Understandable**
- [ ] Every input has a visible label (not a placeholder). Units appear in the label ("Length (mm)") or as an explicit selector. Required fields say "(required)".
- [ ] Errors name the field, the problem and the fix, linked with `aria-describedby` and `aria-invalid` (3.3.1, 3.3.3).
- [ ] Nothing changes context on focus alone. Scanning changes context only after Enter and is announced (3.2.1).
- [ ] Confirmations before destructive or irreversible actions name the object (3.3.4 spirit).

**Robust and announcements**
- [ ] Landmarks: `header` (banner and top bar), `nav`, `main`, `aside` (side panel), labeled `section` for the identity bar.
- [ ] Scan results: `aria-live="polite"`. Blocking mismatches (wrong block, unexpected slide): `role="alert"`. Background refreshes are not announced. Stale and offline banners are announced once.
- [ ] Custom chips and pills have accessible names that include the type ("Provisional intake item ..."). Tables use native semantics.
- [ ] `lang="en-US"` on `<html>`; times in `<time datetime="...Z">`.

**Optional sound feedback**
- [ ] Off by default, toggled in Preferences, with a volume control and a test button.
- [ ] Two distinct tones generated with the Web Audio API (no audio files): a short higher tone for "scanned, matches" and a two-note lower tone for "mismatch / not accepted".
- [ ] Sound always accompanies on-screen text and is never the only signal. It plays only after the user's first interaction (browser rule).

**Testing plan for the build**
- [ ] Keyboard-only run of the full hero journey (intake to operations).
- [ ] Automated scan of each route. `@axe-core/playwright` is not in the agreed stack; adding it as a dev-only dependency is recommended (see Open issues).
- [ ] VoiceOver spot check on `/intake` scan results and the conflict dialog.
- [ ] Screenshots at 1366x768 and 1024x768 for overflow, truncated IDs and focus visibility.

---

## 10. Copy guidelines

**Voice:** plain lab language, short and specific. Write the way a careful lead would explain it at the bench. Describe what happened, then what to do. No marketing language and no exclamation marks.

**Name the role every time** (these are four different people):

| Say | Means | Example | Never say |
|---|---|---|---|
| Ordering clinician | Clinician at the submitting office who ordered the biopsy | Dr. Hannah Cole (Harbor Point Dermatology) | "doctor" alone |
| Assigned dermatopathologist | Lab pathologist the case routes to | Dr. Elena Marsh | "doctor" alone, "reading doc" |
| Accessioner | Staff member who received and accessioned the item | Maya Torres | "user" |
| Current task owner / Owner | Person responsible for the next step right now | Owner: Kim Nguyen | "assignee" (avoid mixing terms) |
| Office contact role | Role at the office expected to answer | Office: front desk lead (fictional directory) | Real names or numbers |

**Words with strict meanings**

| Use | Only when | Do not use for |
|---|---|---|
| Scanned / Matched record | A barcode or typed ID found a record | "Verified" (a scan identifies a record; it does not prove what tissue is in the bottle) |
| Staff verified against physical container | A person checked the container and recorded it | Any automatic result |
| Confirmed | A person confirmed a value or outcome | A system default |
| Entered in source system (staff attested) | A named person recorded that they entered it in EMA by hand | A source confirmation |
| Acknowledged (by source, simulated) | The simulated source returned an acknowledgment | A local "marked as entered" (that is an attestation) |
| Released (hold) | An authorized person released a hold with a reason | "Resolved" (a clarification can be resolved while its hold stays) |
| Resolved | A reviewer closed a clarification with a note | "Answer received" |
| Unknown | The app does not know | Zero, blank, "N/A", "OK" |
| Last confirmed | The latest recorded location, status or sync | "Current", "Live" |
| Simulated | Produced by a demo connector | "Sent", "Printed" without the qualifier |
| Illustrative | Synthetic numbers used for charts | "Results", "Performance", "Savings" |
| Draft text (deterministic demo, not live AI) | Fixed demo output. The exact strings in the app: "Draft text: deterministic demo output, not live AI. Edit before sending." (clarification drafter); "deterministic-demo-extractor v1 (deterministic demo output, not live AI)" and "Synthetic transcript. Extraction is a deterministic demo." (grossing extractor); "Computed summary (deterministic demo) — not AI" (case and handoff summaries) | "AI says", confidence percentages |
| Related (linked) | Two records were linked after review | "Merged", "Combined" |

**Patterns** (from `design:ux-copy`)
- **Buttons:** a verb plus the object. "Request accession", "Record office answer", "Mark tray complete". Not "Submit" or "OK".
- **Errors:** what happened, why (if known), what to do. "Could not request accession. The simulated source timed out after 30 s. Your verification is saved. Try again."
- **Blocked actions:** "Cannot approve yet: 2 values need confirmation (piece count, unit for length)."
- **Empty states:** what this is, why it is empty, how to start.
- **Confirmations:** resolving and releasing are two separate confirmations. Resolve: "Resolve CLR-0457?" Body: "Resolving closes the question. It does not release any hold by itself." An optional, unchecked step "Also release H-0090 (Part B)" asks for its own release reason; the button then reads "Resolve and release hold", otherwise "Resolve, keep hold". Release on its own: "Release H-0090 on Part B?" Body: "Part B's gross approval, processing, printing and tray delivery can continue. Part A is not affected." A release reason is required. Buttons: "Release hold" / "Keep hold".
- **Times:** "10:52 ET" for today, "Wed Oct 14, 10:52 ET" otherwise, "12 min ago" only next to an absolute time. Durations: "1 h 05 min". UTC only in details and audit.
- **Numbers:** label illustrative numbers ("Illustrative"). Show n with medians and 90th percentiles. Show still-open and missing-data counts separately. Never "saves X hours", "% faster", costs, ROI, quality scores or compliance claims.
- **Identifiers:** always exact and complete, with their type the first time on a screen ("Accession D26-04817", "Provisional intake item INT-1014-031").
- **People and places:** fictional names only. No real lab, employer, vendor endorsement, or director endorsement anywhere in the UI.
- **Sentence case** for headings, buttons and pills.

---

## 11. Self-critique of this plan (`design:design-critique`) and resulting changes

| Finding | Severity | Change made |
|---|---|---|
| At 1366x768 the shell could eat the working area (banner, top bar, page header, identity bar). | High | The scan field moved into the top bar (no separate page-level scan row). Banner reduced to 28px. Identity bar is one 56px row. Vertical budget stated in 5.2. |
| Three warm hues (warning orange, doctor amber, PAS yellow) next to red could blur together. | High | Colors were chosen by calculation (doctor/alert distance at least 15.2) and given separate shapes: doctors are swatch plus name, PAS is a bordered tag with icon, warning is a pill or banner with a triangle. No text on warning solid. |
| Rows with many badges become noise and hide the exception. | Medium | One status pill per row. Other facts are plain text in their own columns. Exceptions sort first. The hold stripe is the only colored row edge. |
| A single global scan field could leave users unsure what a scan will do. | Medium | A visible "scan target" prefix, a result line under the field, a live announcement, and `Esc` back to "Find record". |
| "Simulated" labels everywhere could become wallpaper and get ignored. | Medium | One global banner. Local labels only where data leaves or enters through a connector. Implementation detail kept in Settings. |
| Provisional vs official IDs might look alike in compact rows. | Medium | The word "Provisional" is always shown (even in compact rows), plus a dashed border, a different icon and no brand fill. |
| The director view could slide into a vanity dashboard. | Medium | Counts only, each linking to records. Definitions shown. Illustrative tags. Unknown shown as Unknown. No scores or savings. |
| Doctor color as the only grouping cue would fail for color-blind users and grayscale print. | Medium | Doctor name plus color name in group headers and printed snapshots. Validator checked the palette for color-vision deficiency. |

---

## 12. Do not

From the master specification, Section 11, and this spec:

- No decorative "agent constellation" or network-of-bots graphics.
- No empty AI chat box as a home screen. AI appears only as labeled drafts and proposals inside a workflow.
- No stock medical or laboratory imagery, illustrations of microscopes, or hero banners.
- No fake quality score, readiness percentage, "health" grade, or staff ranking.
- No compliance, accreditation, validation or security badges (for example "CAP-ready", "HIPAA compliant").
- No gratuitous animation: no animated charts, counters, pulsing alerts or parallax.
- No invented savings, prices, ROI, time-saved claims or vendor capability claims.
- Never say "verified" for a barcode read alone, "live" for any data freshness state, "entered in EMA" for a local draft, or "acknowledged" for a staff attestation.
- Never show unknown as zero or blank, or one finished part as a finished case.
- Never auto-merge, renumber, relabel or silently correct. Show proposals and require review.
- Never put patient details in notification text by default.
- No real people, offices, employers, credentials or contact details. No implied endorsement by any director.
- No raw hex colors or Tailwind palette classes in components. Use tokens.

---

## Open issues

1. **Icon library: resolved.** The build uses `lucide-react` (pinned in `package.json`) instead of a hand-made inline-SVG set.
2. **Accessibility test tooling: still open.** `@axe-core/playwright` was recommended as a dev-only dependency for automated checks. It has **not** been added, so there is no automated accessibility scan; keyboard and screen-reader checks are manual.
3. **Component library: resolved.** No shadcn/ui. The build uses native elements where they fit (`<dialog>` for modal dialogs, `<select>` for the role selector, `<details>`), and the `radix-ui` package (pinned) only for popovers (demo clock, source freshness) and tooltips. The rest of the stack: `@tanstack/react-table` for dense tables, `recharts` for charts, `bwip-js` for DataMatrix previews, `clsx` and `tailwind-merge` for class names. Versions are pinned in `package.json`; which versions were checked against official documentation, and when, belongs in the README or implementation status document.
4. **Dark theme** is out of scope for v1 (light-only, bench lighting). Charts were validated against white only.
5. **Font rendering.** Confirm in the browser that Plex Mono distinguishes 0/O and 1/l/I clearly at 13px. `next/font/google` needs network access at build time; use `next/font/local` if building offline.
6. **Thresholds** for "Delayed" and "Offline" sync (5 and 15 minutes), the printer timeout (30 s) and follow-up times are demo defaults. Local values must come from discovery.
7. **Hold color.** Plum was chosen for hold to keep it distinct from danger red and the violet doctor. Real labs may already have a color convention for holds. Confirm during discovery.

---

## 13. As built notes (reconciled 2026-10-14)

This spec was written before coding. These are the differences found when it was checked against the built screens and code. Identifiers, state names and routes elsewhere in this document were corrected to match the build.

| Area | Pre-build spec | As built |
|---|---|---|
| File locations | `app/globals.css`, `app/fonts.ts`, `lib/tokens.ts`, `components/icons.tsx` | `src/app/globals.css`, `src/app/fonts.ts`, `src/lib/tokens.ts`; icons from `lucide-react` (no `icons.tsx`) |
| Popovers and tooltips | HTML `popover` attribute | `radix-ui` popover and tooltip; native `<dialog>` for modal dialogs |
| Worklist views | Accessioning, Grossing, Source entry, Histotech, Operations | Accessioning, **Grossing and source entry**, Histotech, Operations (source entry is part of the grossing view; the histology assistant lands on `/worklist?view=grossing`) |
| Source entry states | "Source update pending / acknowledged" | Four labels: Source-system entry pending, Entered in source system (staff attested), Source system acknowledged (simulated), Source update failed |
| Hold release | Released by resolving the clarification | Separate audited action with its own reason; the resolve dialog can offer it as an optional second step |
| Hero storyline | Part B shown "On hold (CLR-0457)" during grossing | H-0090 is released in step 3 after the amended order ORD-77121 v2 arrives; at step 5 Part B is "Awaiting grossing". Steps 6–7 use earlier cases (TRY-M-03, PJ-8841, RR-0192) |
| Related-order actions | Link / Keep separate / Escalate to lead | Link as related (one accession, parts kept with their orders) / Keep separate / Not related / Ask the office first; lead or supervisor only |
| Routing override | Lead only | Accessioning lead or supervisor, reason required |
| Clarification delivery | "Mark delivered or failed" | "Record delivery outcome" with a "how you know" note; the simulated connector also sets outcomes |
| Tray resolution | Remove, to follow, or reprint | Remove; follows separately; missing (open investigation); supervisor release with exceptions. Reprint only for a present slide with an unreadable label |
| Print reconciliation | Printed / Not printed / Can't tell | Label printed / Not printed / Can't tell (escalate) / Printed but damaged |
| Settings tabs | Routing, Demo scenarios, Integration capabilities, Preferences | Routing rules, Demo scenarios, Integration capabilities, **Office contacts**, Preferences |
| Capability words | Implemented (demo) / Simulated / Unsupported / Unknown | Simulated / Documented / Unknown / Unsupported |
| Freshness | Current/Synced, Delayed, Offline, Unknown | Synced, Delayed, Offline, Unknown, plus a Simulated tag |
| Demo page tabs | Guided demo, Workflow map, Speaker notes | Guided demo, Workflow map, Speaker notes, **Real vs simulated** |
| Presence note on intake | "Luis Benitez also has INT-1014-031 open" | Not built; stale edits are caught by the conflict dialog on save |
| Assistant summaries | AI summarizers with buttons | Computed summaries (deterministic, not AI) shown automatically on `/cases/[id]` and `/operations` |
| Doctor colors | Carried over from the paper pages | Fictional demo colors; matching the real pages is discovery question 4.5 |
| Automated accessibility scan | Recommended (`@axe-core/playwright`) | Not added |

Screen details not listed here (layout sizes, keyboard shortcuts, exact copy) were not re-verified line by line; where they differ, the running app is what the demo does.
