---
version: 1
slug: "src-app-intake-page-tsx"
primary_target: "src/app/intake/page.tsx"
related_targets: ["src/components/intake"]
---

# Intake workstation (surface brief)

Scope: `/intake`, mode **Operate**. Audience: accessioners at the 11:00 courier rush (bottle and scanner in hand), accessioning lead; directors watch it in the demo. Task: reconcile order vs bottle vs requisition, raise and send clarifications, review related orders without merging, accept routing, request the accession. Constraints: PRODUCT.md (identity always visible, keyboard/scanner, readable contrast, blocked actions explained, synthetic + simulated labels, server safeguards). Critique 2026-10-14 (28/40): composition generic, next step buried, vertical squeeze, one orange for every severity, keyboard contradictions. User answers: fix all four P1s in one rebuild; one provenance key + labels where they matter; Ctrl+Enter shows a visible target and never attests.

## Direction contract
THESIS: One fixed workstation answers what is in my hand, where the sources disagree, and what I do next. It refuses the ticket-triage stack of equal cards and the gray screen with one accent.
OWN-WORLD: H&E stain world. Hematoxylin blue-black shell and ink; eosin magenta only for focus and the brand mark; cool bench-gray ground; white evidence sheets. Atkinson Hyperlegible Next for words, Atkinson Hyperlegible Mono for identifiers. Severity ladder: patient identity red, field disagreement amber, hold as hatched ink, waiting neutral with the owner's name; yellow only for PAS. Signature move: the current part is set as its specimen label (dashed provisional label before accession, printed label with its DataMatrix after).
STORY: The accessioner reads the part label, one finding sentence, the aligned evidence with differences first, and her own next step beside who else is being waited on; the director sees the same calm structure.
FIRST VIEWPORT: Hematoxylin top bar (wordmark, job navigation, scan field as the widest element, source sync, presenter menu). Left exception queue ~288px. Identity label band. Finding band: two-tone sentence, hold scope for both parts, five-step tone rail with owners and blockers. Evidence sheet centered. Fixed decision column right: "Your next step" primary button with a Ctrl+Enter badge, waiting-on line, Request accession at the foot with its reason.
FORM: Brief-pinned: concept A "precision workstation" (1st on the brief's ordered list; independent walkthrough 10/12, preferred on tie), with concept C's finding band and step rail and concept B's effect preview. No concept-seed roll: the brief pinned the direction.
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Round 2 decisions (2026-10-14)
- Short columns never cut a line or a button in half: the next-step body and "Also yours now" end at a whole unit (line, option, field, task) under an opaque cover with an explicit "More below" / "N more below" cue that scrolls to what follows; keyboard focus is kept clear of the covers (`cut-scroll.tsx`). When "Also yours now" cannot show one whole task beside the full next step, it folds to its heading and count ("Show all 2"); opened on request, the step folds to heading + action ("Show the step details") and Ctrl+Enter unfolds instead of running.
- 200% zoom (below 1024px wide or 560px tall): one page-scrolling stack in reading and tab order: identity band, finding band, decision band (next step with a compact part label, beside waiting-on, other tasks and the request), evidence, record. Only the top bar is pinned; the queue stays a drawer (sticky column if wide but short).
- Presenter controls stay as one quiet, closed disclosure at the very foot of the record (no box, muted ink): a documented exception until the separate presenter surface (docs/redesign/presentation-surface-proposal.md) exists.
