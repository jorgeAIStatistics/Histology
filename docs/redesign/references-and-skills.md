# Redesign inputs: what was actually inspected

*2026-10-14. This page separates what was seen from what is assumed.*

## 1. Reference images (opened and viewed)

Seven screenshots supplied in the chat were viewed directly. The live sites were **not** inspected: the in-app browser refused navigation to both `https://www.costanera.uk/` and `https://reveallabs.co/` ("navigation denied or failed"). No workaround was attempted. Nothing below comes from page text or source code, and nothing about their **animation** can be verified here — the user reports that both sites use several animations to feel alive; that is taken as the user's statement, not an observation.

| # | Image | Three observations (seen) | Assumptions (not verifiable from a still) |
|---|---|---|---|
| 1 | Costanera hero | (a) A full-bleed deep-green field holds a large 3D knotted tube made of fine parallel ridges with soft highlights. (b) The headline is a high-contrast serif at roughly 7× body size, two lines, the second line in pale mint; a small letter-spaced uppercase label sits above it. (c) Right column: one sans statement in two sizes (second line muted), then two pill buttons (filled light, outlined), above a hairline and a "serving clients across" row with vertical separators. | The pause button bottom-right suggests the knot animates. The serif resembles a Playfair-style didone (not confirmed). |
| 2 | Costanera map section | (a) Charcoal background; a right-aligned two-line serif headline where some words are pale gray and others white. (b) A dark-gray world map with white location dots and a labelled home marker. (c) A small serif caption bottom-left introduced by a short rule; above, numbered rows ("01 …") separated by hairlines inside a slightly lighter panel with a white pill button. | Map dots may animate on scroll. |
| 3 | Costanera "who we build for" | (a) Warm off-white textured (grain) background with a centered two-line serif headline, second line green, and a tiny diamond divider. (b) Asymmetric photo cards: one tall card left, two stacked right; dark photos with overlaid category label, serif title, sans description and "Read case study ↗". (c) Large serif numerals with tiny caps captions in card corners ("55K+ / LINES OF CODE"). | Hover may lighten cards. |
| 4 | Costanera process | (a) A sequence headline "Understand. → Centralize. → Automate." where the current step is near-black and later steps pale gray — progress shown by tone. (b) Left: step counter, serif step title, body copy, a short icon list and an outcome line. (c) Right: a dark rounded panel with five tool nodes joined by thin curved lines; one node is highlighted with a mint outline and a "PRIORITY" pill; below, segment indicators and round previous/next buttons. | The diagram likely animates between steps. |
| 5 | Costanera insights and footer | (a) Two-tone serif headline on charcoal ("Notes from" muted, "the field." white). (b) A horizontal row of light illustration cards with soft clay-like 3D objects; serif titles centered under each; the row fades at both edges. (c) A light footer with a serif wordmark and link columns. | The fade and pause button suggest an auto-scrolling carousel. |
| 6 | Reveal hero | (a) Monochrome, motion-blurred photographic background with a translucent rounded navigation bar and a green pill call-to-action. (b) A very large geometric sans headline centered in white, then an email field and button merged into one glassy capsule, then a green confirmation pill with an amount. (c) A laptop-and-phone product mock whose dashboard leads with one plain sentence stating a finding, then two exception lines with amounts right-aligned. | The background is probably a looping video. |
| 7 | Reveal "connect" | (a) Green radial gradient with a centered heading and a small step label above it. (b) A central rounded-square mark inside a ring, joined by thin lines to four white pill nodes (Bank, Point of sale, Delivery apps, Invoices & contracts). (c) A light pill with a lock icon stating read-only access, and a "Scroll ↓" hint at the bottom. | Lines probably draw in on scroll. |

The same blue pixel-art robot appears in the bottom-right of all seven images at the same screen position. **Assumption:** it is an overlay on the capturing computer, not part of either site; it was ignored.

### Qualities translated (not copied)
- Typographic contrast used as structure, not decoration.
- One plain sentence that states the current finding before any detail (Reveal's product mock).
- Progress expressed by tone along a short sequence (Costanera's process headline).
- Sources drawn as inputs converging on one object (both sites' node diagrams) → order, bottle and requisition converging on a part.
- Surfaces with different jobs instead of one repeated card.
- Restraint: whitespace, hairlines, few colors.

Not taken: branding, wordmarks, copy, imagery, 3D art, map, carousel, cream-plus-serif palette, green brand color, marketing layouts.

## 2. Skills and design references in this environment

| Name | Status in this session | Path | Contribution |
|---|---|---|---|
| `design:design-critique` | Loadable (plugin catalog) | remote plugin skill, no local path | Structure for the independent screenshot critique |
| `design:accessibility-review` | Loadable (plugin catalog) | remote plugin skill | WCAG checks for the redesigned screens |
| `design:design-system` | Loadable (plugin catalog) | remote plugin skill | Token and component consistency audit |
| `design:ux-copy` | Loadable (plugin catalog) | remote plugin skill | Short copy for states and blockers |
| `dataviz` | Loadable | built-in skill | Chart form and color rules (operations queue view) |
| `modern-web-guidance:modern-web-guidance` | Loadable | plugin catalog | Reference for native CSS motion (view transitions, `@starting-style`) |
| `image-to-code` (the **Taste** package: `npx skills list -g` reports source `leonxlnx/taste-skill`) | Loadable | `~/.claude/skills/image-to-code/SKILL.md` | **Not used.** Its core step is generating design images first; no image-generation tool exists here. Correction: an earlier note said "Taste" was not found; it is installed under this name. |
| `awesome-design` | **Not loadable** — installed on disk but not enabled in this session | `~/.claude/plugins/cache/awesome-design-skill/awesome-design/1.0.0/skills/awesome-design/SKILL.md` | Not used. It is a library of other brands' design tokens; copying brand tokens is out of scope here. |
| `frontend-design` | **Not loadable** — present in the official plugin marketplace cache, not installed | `~/.claude/plugins/marketplaces/claude-plugins-official/plugins/frontend-design/skills/frontend-design/SKILL.md` | Its file was **read as a reference document** (not invoked as a skill); its list of generated-design clichés is used as a check. |

**Installed later in this session** (reported by `npx skills list -g`; `npx skills check` and `npx skills update`: all up to date): `impeccable` (`~/.agents/skills/impeccable`, invoked by the user: `init`, `critique`, `bolder`, `animate`, `polish`), `ui-ux-pro-max`, `design-system`, `ui-styling`, `design`, `brand`, `banner-design`, `design-extract`, `slides`, `playwright-skill`, `vercel-react-best-practices` (all `~/.claude/skills/<name>`).

**Primary visual-design workflow (updated):** Impeccable, as invoked by the user, is the primary workflow from `init` onward; `design:design-critique` and `design:accessibility-review` complement it. Earlier note:  the plan → build → screenshot → critique loop described below, run against rendered screens, with `design:design-critique` and `design:accessibility-review` as complements. One token system (in `src/app/globals.css`) owns the result; previews keep their experimental tokens inside their own route folders.

## 3. Baseline (before) — observed in renders

Captured with `scripts/screenshots.mjs` against the fixture `scripts/fixture-intake-review.ts` at 1440×900 and 1366×768 (`docs/redesign/before/`). Observed structural causes of the "admin template" look:

1. A fixed 216 px icon-and-label sidebar grouped as Bench / Oversight / Admin, plus a top bar of equal-weight status chips: the classic admin chrome, regardless of the job.
2. Every page is the same stack: a 20 px semibold title, a gray description sentence, then identical bordered white cards on a light gray canvas.
3. Almost every value sits in its own bordered chip or pill (IDs, tags, MRNs, states), so a real disagreement has the same visual weight as routine metadata.
4. Intake: the decision area (related orders, routing, accession) starts about 2,000 px down the page (page height 3,372 px at 1440 wide). Parts A and B of the same submission are never visible together.
5. Operations opens with nine equal tiles; zeros and the 62 routine attestations weigh the same as the three holds.
6. One sans family at four close sizes; hierarchy relies on weight 600 alone.
7. Warning orange is used for routine conditions too, so the actual mismatch competes with them.
8. Materials shows a tray as a table, not as a tray with occupied positions.
