---
name: Histology Lab OS
description: A bench workstation for a dermatopathology lab, drawn in the colors of its own H&E stain.
colors:
  shell: "#1B1F47"
  shell-2: "#272C5E"
  shell-line: "#3A4078"
  shell-muted: "#B9BCE0"
  brand: "#3A3F9E"
  brand-hover: "#2E3384"
  brand-50: "#EEEFFA"
  brand-100: "#DCDEF4"
  eosin: "#C2336F"
  eosin-light: "#F07AAA"
  canvas: "#ECEEF3"
  surface: "#FFFFFF"
  surface-subtle: "#F4F5F8"
  surface-sunken: "#E3E6EE"
  line: "#D8DBE5"
  line-strong: "#878DA8"
  ink: "#151A30"
  ink-secondary: "#383E5C"
  ink-muted: "#565C78"
  ink-disabled: "#8C91A8"
  info-fg: "#2C4A86"
  info-bg: "#EDF2FB"
  info-border: "#AFC2E6"
  info-solid: "#3D63B5"
  warning-fg: "#9A4304"
  warning-bg: "#FFF2E5"
  warning-border: "#F0B47F"
  warning-solid: "#D9650F"
  danger-fg: "#A3221B"
  danger-bg: "#FCEBEA"
  danger-border: "#EBA19C"
  danger-solid: "#B42318"
  hold-fg: "#2F3450"
  hold-bg: "#EEF0F5"
  hold-border: "#9EA3BC"
  pas-bg: "#FFE45C"
  pas-fg: "#1C1700"
  pas-border: "#8A7300"
  pas-row: "#FFF8D6"
  sim-fg: "#4A5070"
  sim-bg: "#F1F2F7"
  dr-teal: "#0F9485"
  dr-teal-tint: "#E3F4F1"
  dr-violet: "#9A4BD0"
  dr-violet-tint: "#F3ECFB"
  dr-amber: "#916A0B"
  dr-amber-tint: "#F1EEE9"
  age-1: "#8F94D6"
  age-2: "#5D63BC"
  age-3: "#3A3F9E"
  age-4: "#1B1F47"
typography:
  specimen-letter:
    fontFamily: "Atkinson Hyperlegible Next, ui-sans-serif, system-ui, sans-serif"
    fontSize: "2.5rem"
    fontWeight: 700
    lineHeight: 1
    letterSpacing: "-0.03em"
  headline:
    fontFamily: "Atkinson Hyperlegible Next, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.625rem"
    fontWeight: 700
    lineHeight: "2.05rem"
    letterSpacing: "-0.015em"
  title-focal:
    fontFamily: "Atkinson Hyperlegible Next, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.3125rem"
    fontWeight: 600
    lineHeight: "1.75rem"
    letterSpacing: "-0.01em"
  title:
    fontFamily: "Atkinson Hyperlegible Next, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.0625rem"
    fontWeight: 700
    lineHeight: "1.5rem"
    letterSpacing: "-0.01em"
  body:
    fontFamily: "Atkinson Hyperlegible Next, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.9375rem"
    fontWeight: 400
    lineHeight: "1.4rem"
  body-sm:
    fontFamily: "Atkinson Hyperlegible Next, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.84375rem"
    fontWeight: 400
    lineHeight: "1.25rem"
  label:
    fontFamily: "Atkinson Hyperlegible Next, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 500
    lineHeight: "1.125rem"
  identifier:
    fontFamily: "Atkinson Hyperlegible Mono, ui-monospace, SFMono-Regular, Menlo, monospace"
    fontSize: "0.84375rem"
    fontWeight: 600
    lineHeight: "1.25rem"
    letterSpacing: "0.01em"
    fontFeature: "\"tnum\", \"zero\""
rounded:
  sm: "3px"
  md: "5px"
  lg: "8px"
  pill: "999px"
spacing:
  "1": "4px"
  "1.5": "6px"
  "2": "8px"
  "3": "12px"
  "4": "16px"
  "5": "20px"
  topbar: "52px"
  identity-band: "68px"
  side-panel: "420px"
components:
  button-primary:
    backgroundColor: "{colors.brand}"
    textColor: "{colors.surface}"
    rounded: "{rounded.md}"
    padding: "0 16px"
    height: "40px"
  button-primary-hover:
    backgroundColor: "{colors.brand-hover}"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "0 16px"
    height: "40px"
  button-secondary-hover:
    backgroundColor: "{colors.surface-subtle}"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.brand}"
    rounded: "{rounded.md}"
    padding: "0 16px"
    height: "40px"
  button-ghost-hover:
    backgroundColor: "{colors.brand-50}"
  button-destructive:
    backgroundColor: "{colors.danger-solid}"
    textColor: "{colors.surface}"
    rounded: "{rounded.md}"
    padding: "0 16px"
    height: "40px"
  button-destructive-hover:
    backgroundColor: "{colors.danger-fg}"
  button-disabled:
    backgroundColor: "{colors.surface-subtle}"
    textColor: "{colors.ink-muted}"
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.sm}"
    padding: "0 10px"
    height: "40px"
  input-invalid:
    backgroundColor: "{colors.warning-bg}"
  card-sheet:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.lg}"
    padding: "16px"
  card-quiet:
    backgroundColor: "{colors.surface-subtle}"
    rounded: "{rounded.lg}"
    padding: "16px"
  status-pill:
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: "0 8px"
    height: "24px"
  pas-tag:
    backgroundColor: "{colors.pas-bg}"
    textColor: "{colors.pas-fg}"
    rounded: "{rounded.sm}"
    padding: "0 6px"
    height: "24px"
  honesty-tag:
    backgroundColor: "{colors.sim-bg}"
    textColor: "{colors.sim-fg}"
    rounded: "{rounded.sm}"
    padding: "0 6px"
    height: "24px"
  top-bar:
    backgroundColor: "{colors.shell}"
    textColor: "{colors.surface}"
    height: "52px"
  nav-link:
    backgroundColor: "transparent"
    textColor: "{colors.shell-muted}"
    rounded: "{rounded.md}"
    height: "36px"
  nav-link-hover:
    backgroundColor: "{colors.shell-2}"
    textColor: "{colors.surface}"
  nav-link-active:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.shell}"
  specimen-label:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "6px 12px 6px 10px"
---

# Design System: Histology Lab OS

## Overview

**Creative North Star: "The Stained Bench"**

The product is a histology bench seen through its own stain. Hematoxylin, the blue-black nuclear dye, is the structure: the top bar, the primary action, the ink. Eosin, the magenta counterstain, appears only where the eye must land on the keyboard's position and in the brand mark. The ground is a cool bench gray; every record sits on a white evidence sheet with a hairline edge. Nothing on screen is decorative: color is a severity signal or a material, never a mood.

Density is a working density. The default reading size is 13.5px with 13px as the floor, chosen for bench reading distance; the type family is Atkinson Hyperlegible, drawn so look-alike characters (0/O, 1/l/I, B/8) stay distinct, because comparing identifiers across a bottle, a requisition and an order is the core task. Each bench screen is one fixed composition for its job (queue, identity, evidence, decision) rather than a stack of equal cards, and collapses to one page-scrolling column under the `stacked` condition.

The signature is the specimen label: the part in hand is drawn as its own label, dashed while provisional and solid with its DataMatrix once official. The same dashed/solid grammar runs through the whole system: a dashed edge means "not yet real".

**Key Characteristics:**
- Hematoxylin shell and ink on a cool gray ground; white sheets with hairlines.
- Eosin magenta reserved for focus rings, the caret and the brand mark.
- A fixed severity ladder: red for patient identity, amber for disagreement, hatched ink for holds, neutral ink with a name for waiting, yellow for PAS only.
- Atkinson Hyperlegible Next for words, Atkinson Hyperlegible Mono for every identifier, never wrapped or truncated.
- Flat sheets; shadows only on things that float above the bench.
- Motion only for state changes a person caused or must notice.

## Colors

A stain palette: two dyes (hematoxylin and eosin), cool bench neutrals, and a strictly ranked set of signal colors. Tailwind's default palette is removed at the root, so only these tokens exist.

### Primary
- **Hematoxylin Night** (shell): the top bar, the selected job, the darkest ink and the "over 8 h" age band. Its steps **Hematoxylin Raised** (shell-2) and **Hematoxylin Rule** (shell-line) carry hover and dividers on the bar; **Pale Nuclear Lilac** (shell-muted) is unselected text on the bar.
- **Hematoxylin** (brand): primary button fill, links, the selected-row edge, the accession chip border. **Deep Hematoxylin** (brand-hover) on hover and press; **Hematoxylin Wash** (brand-50) and **Hematoxylin Tint** (brand-100) for ghost hover, active scan target and text selection.

### Secondary
- **Eosin** (eosin): the 2px focus ring (offset 2px), the text caret and the brand mark. **Light Eosin** (eosin-light) replaces it as the focus ring on the dark bar.

### Tertiary
- **Severity ladder**, each rung with fg (text), bg (tint), border and solid (icon or marker) steps:
  - **Identity Red** (danger-*): patient identity disagreement only (name, DOB, MRN), shown with the filled octagon, plus the destructive confirmation button.
  - **Disagreement Amber** (warning-*): a field differs between sources, missing or stray material, a failed or unknown delivery, a stale source, an invalid form value. Shown with a triangle.
  - **Hold Ink** (hold-*): a hold is hatched ink on a neutral ground, never a hue.
  - **Information Blue** (info-*): sent, delivered and in-progress messaging states.
- **PAS Yellow** (pas-*): echoes the lab's paper PAS system; always carries the word "PAS" and a flask icon; **PAS Row** (pas-row) tints a PAS worklist row.
- **Doctor colors** (dr-teal, dr-violet, dr-amber with their tints): identity of the three dermatopathologists as a swatch and a 4px top band on their worklist group. Never text inside a swatch.
- **Age ramp** (age-1 to age-4): chart bands for under 1 h, 1-4 h, 4-8 h, over 8 h, light to dark in the hematoxylin hue.

### Neutral
- **Bench Gray** (canvas): page ground.
- **Evidence White** (surface): sheets, forms, tables, the specimen label.
- **Bench Subtle** (surface-subtle) and **Bench Sunken** (surface-sunken): quiet cards, table headers, disabled fields, pressed states.
- **Hairline** (line): dividers between sections inside a sheet and card edges. **Strong Hairline** (line-strong): control borders, chart axes, the scrollbar thumb.
- **Ink** (ink), **Secondary Ink** (ink-secondary), **Muted Ink** (ink-muted), **Disabled Ink** (ink-disabled): text, all pairs computed at 4.5:1 or better on white and on canvas (disabled excepted).
- **Simulation Gray** (sim-*): honesty tags (Simulated, Synthetic, Illustrative).

### Named Rules
**The Eosin Rule.** Eosin marks where the keyboard is and whose product this is. It is never a fill, a status or a highlight.

**The Ladder Rule.** Red means patient identity; amber means sources disagree or data may be wrong; hatched ink means a hold; neutral ink with a person's name means waiting. One orange for every problem is the failure this system exists to prevent. The only other red is a button that discards data.

**The Yellow Is PAS Rule.** Yellow appears only for PAS, and always with the word "PAS".

**The Never Color Alone Rule.** Every rung carries an icon and words; hold carries a hatch. Forced-colors mode draws borders on every pill, chip and banner.

## Typography

**Body Font:** Atkinson Hyperlegible Next (with ui-sans-serif, system-ui)
**Label/Mono Font:** Atkinson Hyperlegible Mono (with ui-monospace, SFMono-Regular, Menlo)

**Character:** One accessibility-first family in two voices. The sans carries every sentence; the mono is a tool for telling identifiers apart, with tabular, slashed-zero figures.

### Hierarchy
- **Specimen letter** (700, 2.5rem, line-height 1, -0.03em): the part letter on the specimen label (1.875rem at the medium size, smaller still for two letters). The one display moment.
- **Headline** (700, 26px, 2.05rem): page title in the page header.
- **Title focal** (600, 21px, 1.75rem): the one focal statement on a screen: what is blocked, the decision being asked.
- **Title** (700, 17px, 1.5rem, -0.01em): section and card headings.
- **Body** (400, 15px, 1.4rem): the document base and long-form fields.
- **Body small** (400, 13.5px, 1.25rem): the working size of the system: table cells, facts, buttons, panel text. Long prose is capped at 80-90ch.
- **Label** (500, 13px, 1.125rem): pills, hints, field errors, captions. 13px is the floor.
- **Identifier** (mono 600, 13.5px, +0.01em, tabular and slashed zero): accession, intake, block, slide, CLR/WO/PJ/TRY/RR, MRN and order ids.

Weights in use: 400, 500, 600, 700. Headings tighten tracking (-0.01em to -0.015em) and balance their wrap; table cells use tabular figures.

### Named Rules
**The Identifier Rule.** Every identifier is set in the mono and never wraps or truncates. The mono is for identifiers only, never for decoration or numbers in prose.

**The One Focal Point Rule.** One thing per screen sits at 21-26px: the identity in hand or the one thing that is blocked. Everything else stays at 13-17px.

**The Sentence Case Rule.** Sentence case everywhere. No all-caps labels, no small labels above headings.

## Layout

The app is a fixed workstation frame: one hematoxylin top bar (52px; wraps to two rows, 102px, below 1024px) and no side rail. Bench screens are column compositions on the gray ground: a left queue (about 280-352px), a centered evidence sheet, and a fixed decision column on the right (about 324-352px), all inside the viewport; a 68px identity band stays sticky above the working area so the case or part in hand is always visible. Side panels are 420px and become a 480px overlay below 1280px.

**Stacked condition.** Below 1024px wide or 560px tall (tablet portrait, 200% zoom, short windows) each fixed-frame workstation becomes one page-scrolling column in reading and tab order; only the top bar stays pinned, the queue becomes a drawer and the identity band stops being sticky on short windows.

**Density.** Compact is the default at 1280px and wider: 36px rows, 13px cells, 32px minimum targets. Comfortable applies below 1280px or on touch: 48px rows, 15px cells, 44px targets.

**Rhythm.** A 4px base. Gaps are mostly 4, 6 and 8px inside components and 12px between groups; sheets pad 16px with 16px x 10px headers; section separation inside a sheet is a hairline, not space or a nested card. Sticky chrome is accounted for in scroll padding so focused rows stay clear (WCAG 2.4.11).

**Targets:** bench 1366-1440px wide, tablet 1024px, no horizontal scroll.

## Elevation & Depth

The bench is flat. Sheets sit on the gray ground with a hairline and no shadow; depth between sheets and the ground is tonal (white on gray), and sections within a sheet are separated by hairlines. Shadows appear only on things that float above the bench: menus, popovers, dialogs, toasts, the overlay side panel. Hold is shown by a texture, not a lift.

### Shadow Vocabulary
- **Rest** (`box-shadow: 0 1px 2px rgb(21 26 48 / 0.07)`): small floating controls and dropdown triggers.
- **Raised** (`box-shadow: 0 6px 16px -4px rgb(21 26 48 / 0.16), 0 1px 3px rgb(21 26 48 / 0.08)`): the raised card variant, popovers and menus.
- **Overlay** (`box-shadow: 0 18px 40px -8px rgb(21 26 48 / 0.28), 0 2px 8px rgb(21 26 48 / 0.10)`): dialogs, toasts, the side panel as an overlay.

### Named Rules
**The Flat Bench Rule.** If it does not float over other content, it has no shadow. All shadows are tinted with hematoxylin ink, never pure black.

**The Hatch Rule.** A hold is a 135-degree hatch of ink at 13% (2px line, 7px period) on the hold ground. No other surface uses a pattern.

## Shapes

Small, size-proportional radii: 3px for chips, tags, inputs and the label reference; 5px for buttons, nav items, banners and the specimen label; 8px for sheets, dialogs and toasts; full pill for status pills and counts. Borders are 1px hairlines; the specimen label and its inline reference use a 1.5px edge.

**The Dashed Means Not Yet Real Rule.** A dashed edge marks something that does not yet exist officially: a provisional intake id, an unsent drafted question, an empty tray position, an unassigned doctor swatch, a simulated timeline event. Real things have solid edges.

Doctor groups in the worklist carry a 4px top band in the doctor's color; that is the only colored edge in the system.

## Components

### Buttons
Calm, legible and never ambiguous about why they are off.
- **Shape:** gently squared (5px), semibold label, optional 16px leading icon.
- **Sizes:** small 32px (13.5px text, 12px padding), medium 40px (13.5px, 16px padding), large 48px (15px, 20px padding), and block (full width, wraps, for docked decision columns). Minimum height rises to the density target.
- **Primary:** hematoxylin fill, white text; deep hematoxylin on hover and press.
- **Secondary:** white with a strong hairline and ink text; subtle and sunken grays on hover and press.
- **Ghost:** hematoxylin text, wash and tint on hover and press. **Quiet:** secondary ink, gray hover.
- **Destructive:** identity red fill for actions that discard data only.
- **Press / Focus:** 1px press translate over 120ms; the eosin ring on focus.
- **Disabled:** subtle gray with a hairline and muted ink (stays legible); a visible reason sits beside it and is linked by `aria-describedby`. Loading keeps the width and swaps in a spinner with a verb ("Requesting...").
- **Ctrl+Enter badge:** the one button that answers Ctrl/Cmd+Enter shows the key badge.

### Chips
- **Status pill:** full pill, 24px (20px small), 13px medium, tone tint + tone border + tone icon + words. "Done" is a quiet check in neutral ink, never celebratory green.
- **Hold pill:** the hatch on the hold ground with the pause icon.
- **PAS tag:** PAS yellow, dark olive border, flask icon, the word "PAS", ids in mono.
- **Accession chip:** hematoxylin edge on the wash, hash icon, mono id. **Provisional chip:** dashed edge, dashed-circle icon.
- **Honesty tag:** simulation gray with a solid hairline and a plug icon.

### Cards / Containers
- **Corner Style:** 8px.
- **Variants:** sheet (white, hairline; the default working surface), quiet (bench subtle, no border; secondary details), raised (sheet plus the Raised shadow).
- **Header:** 17px bold title, optional muted description, actions at the right, a hairline below; footer above a hairline.
- **Internal Padding:** 16px; flush for edge-to-edge tables.
- **Facts:** label/value pairs as a two-column definition list (muted label, ink value) instead of dot-separated strings.

### Inputs / Fields
- **Style:** white, strong hairline, 3px corners, 40px (32px small), 10px inline padding; hover darkens the edge to secondary ink. Selects draw their own muted chevron. Identifier fields use the mono.
- **Label:** 13.5px medium secondary ink above the control; "(required)" in words.
- **Focus:** the eosin ring; the caret is eosin.
- **Invalid:** amber edge on an amber tint with a triangle and the message below; never red.
- **Disabled:** sunken gray, disabled ink.

### Navigation
The top bar is the only navigation. Job links are grouped by job (receive, gross, bench histology, oversee) with shell-rule hairlines between groups; unselected links are pale lilac, hover lifts to the raised shell, and the current page is the one light chip on the dark bar (white fill, hematoxylin text, semibold). Actionable counts are small pills. Below 1366px links become 44px icon targets with the label kept for screen readers and the tooltip. The scan field is the widest element in the bar (up to 560px): a white field with a target segment on the left and mono input.

### Specimen Label (signature)
The part in hand drawn as its label: a white tag with a 1.5px edge, the part letter at specimen-letter size, a hairline, then the mono id and up to two short lines. Provisional: dashed muted edge and the word "Provisional". Official: solid ink edge with the DataMatrix beside the letter. It leads the identity band on every screen that edits a case, and a compact inline reference repeats it in text.

### Identity Mark
A filled red octagon, used only beside a patient identity disagreement.

## Do's and Don'ts

### Do:
- **Do** draw every color from the tokens; the default Tailwind palette does not exist here.
- **Do** keep the case or part in hand visible during any edit through the identity band and its specimen label.
- **Do** keep the next action and its owner visible, and put the reason for a disabled action beside it.
- **Do** separate sections inside a sheet with hairlines.
- **Do** use dashed edges only for things not yet real, and solid edges for everything official.
- **Do** animate only state changes: a row arriving (rise 4px and fade, 200ms), content swapping (fade from 35%, 200ms), a scan locating a row (eosin ping, 700ms twice); overlays fade in over 120ms. Ease out with cubic-bezier(0.16, 1, 0.3, 1). Reduced motion removes all of it.
- **Do** label anything simulated or synthetic once, where it matters, with the honesty tag.

### Don't:
- **Don't** use eosin for anything other than focus, the caret and the brand mark.
- **Don't** use red for anything except patient identity disagreement and a destructive confirmation button.
- **Don't** use yellow for anything except PAS.
- **Don't** put a card inside a card, or build a screen as a stack of equal cards or equal KPI tiles.
- **Don't** put colored side stripes on cards, rows or banners; use tint, icon and words.
- **Don't** use all-caps labels or small labels above headings.
- **Don't** wrap or truncate an identifier, or set non-identifiers in the mono.
- **Don't** add shadows to sheets resting on the bench, or ambient animation of any kind.
- **Don't** restyle shared parts with one-off classes on a screen; change the shared part.
