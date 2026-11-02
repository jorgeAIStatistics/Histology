# Visual system: H&E stain workstation

*Owner: the design lead. Code is the source of truth: tokens in `src/app/globals.css`, shared parts in `src/components/{ui,domain,shell}`. Screens compose these; they do not restyle them.*

## World
A histology bench seen through its own stain. **Hematoxylin** (blue-black) is structure: the top bar, primary actions, ink. **Eosin** (magenta) is only for keyboard focus and the brand mark. The ground is a **cool bench gray**; records sit on **white evidence sheets**. The signature is the **specimen label**: the part in hand is shown as its label, dashed while provisional, solid with its DataMatrix once official.

| Token | Value | Use |
|---|---|---|
| `shell` | #1B1F47 | Top bar, selected state, the darkest ink |
| `brand` (hematoxylin light) | #3A3F9E | Primary button fill, links |
| `canvas` | #ECEEF3 | Page ground |
| `surface` | #FFFFFF | Evidence sheets, forms, tables |
| `ink` / `ink-secondary` / `ink-muted` | #151A30 / #383E5C / #565C78 | Text (all AA on white and canvas) |
| `eosin` | #C2336F | Focus ring, brand mark. Nothing else. |

## Severity ladder (never one orange for everything)
| Rung | Treatment | When |
|---|---|---|
| Patient identity | danger red (`danger-*`), the filled octagon `IdentityMark` | Name, DOB or MRN disagree between sources for the same item |
| Sources disagree / data may be wrong | amber (`warning-*`), triangle icon | A field differs between order, bottle and requisition; container missing vs manifest; a scanned label that belongs to another case or is not on the list (rejected, nothing changes, the other case is named in words); a failed or unknown delivery, print or source update; a stale or offline source; an invalid form value |
| Hold | hatched ink (`HoldPill`, `hatch` utility + `hold-*`) | Work stopped on a stated scope |
| Waiting / needs a person | neutral ink with the owner's name | Someone must decide or act; nothing is wrong yet (includes a routing exception) |
| PAS | yellow (`pas-*`), always with the word "PAS" | Only PAS |
| Done | quiet check, muted text (`success` tone) | Never celebratory green |

Colour is never the only cue: every rung has an icon and words. The one other use of red is a **destructive confirmation button** (it discards data, e.g. "Reset demo data"); it is an action colour, never a status.

**Dashed outlines mean "not yet real"**: a provisional INT id, a drafted (unsent) question, an empty tray position. Honesty tags (Simulated, Synthetic, Illustrative) use a solid hairline.

## Type
Atkinson Hyperlegible Next for words, Atkinson Hyperlegible Mono **only for identifiers** (INT, ORD, D26, CLR, H-, slide and block ids): it separates look-alike characters (0/O, 1/l/I). Scale: xs 13px (floor), sm 13.5, base 15, md 17, lg 21, xl 26, 2xl 32, 3xl 44. One focal point per screen: the identity (patient or part) or the one thing that is blocked, at lg–xl; everything else at base–md. Sentence case. No all-caps labels, no eyebrow labels above headings.

## Layout rules
- Every bench screen is one composition for its job, not a stack of equal cards. No card inside a card: sections inside a sheet are separated by hairlines (`border-line`).
- The current case/part stays visible during any edit (`IdentityBar`, led by `SpecimenLabel`).
- The next action and its owner are always visible; a disabled action says why next to it.
- Targets: bench 1366–1440 wide, tablet 1024. No horizontal scroll. Touch targets ≥ 44px at 1024.
- Radii: 3 / 5 / 8px by size; no radius with a coloured 2px edge; no coloured side stripes on cards or rows (use tint + icon + words).
- Avoid template tells: equal KPI tiles, "A · B · C" meta strings where a label/value layout reads better, arrows appended to button text, decorative numbering.

## Motion
Only for state changes a person caused or must notice: a row arriving (`animate-rise-in`), content swapping (`animate-swap-in`), a scan locating a row (`animate-scan-ping`). Ease `--hlo-ease` (cubic-bezier(0.16,1,0.3,1)), 120/200/320 ms. `prefers-reduced-motion` removes movement. No ambient animation.

## Honesty
"Synthetic demo" is always visible in the top bar. Anything simulated (source system EMA-SIM, notifications, printers, scanners, AI) is labeled once where it matters. Unknown is "Unknown". No invented savings, rates or endorsements.

## Shared parts (use, do not fork)
`IdentityBar`, `SpecimenLabel` and `LabelRef`, `LabelPreview`, `IdText`, `IdentityMark`, `HoldPill` (hatched), `PasTag`, `DoctorChip`/`DoctorSwatch`, `StatusPill`/`StatePill`, `Button` (sizes sm, md, lg, block; legible disabled), `CtrlEnterBadge`, `Card` (`sheet` | `quiet` | `raised`), `Table`, `Tabs` (`bare`), `PageHeader`, `AlertBanner`, `Timeline` (`headingLevel`), `SidePanel` (`hideTitle`), `Kbd`, form `Field`/`Select`/`Checkbox`. The `stacked:` variant (below 1024px wide or 560px tall) is where fixed-frame workstations become one scrolling column. Ask the lead for a shared change instead of overriding these with one-off classes.

## Keyboard
Every bench screen keeps the scan field reachable with `/` or Ctrl/Cmd+K; Ctrl/Cmd+Enter runs only the button that shows the Ctrl badge and never records an attestation; J/K move through the current queue; Esc closes the innermost layer and returns focus to where it came from. The keyboard button in the top bar (or `?`) lists every key.
