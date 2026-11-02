# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Primary users are **bench staff in a dermatopathology laboratory**: accessioners who receive courier deliveries (around 11 a.m.) and reconcile dermatology-office orders, specimen bottles and paper requisitions; the grosser; the histology assistant who enters gross descriptions into the source system; and histotechnologists who section, stain, label and assemble slide trays. They work standing or seated at a bench workstation, often holding a specimen or scanner, switching between physical material and the screen.

Secondary audience: the laboratory's Director of Operations and medical director, who evaluate the product through a guided synthetic demonstration and the operations view. They are not the primary users of the bench screens.

## Product Purpose

Histology Lab OS ("Histology Redesigned") is a working local demonstration of an operational coordination and specimen-tracking companion. It reduces repeated transcription, ambiguous handoffs, missing work, label mix-ups, paper handling and time spent finding material, by making the next decision, its owner and its evidence visible at each handoff.

Success for the prototype: a director can follow one multipart case, see the discrepancy, understand the resolution, watch the right worklist update, and see what real deployment would require. Success for a later pilot must be measured locally; nothing has been measured yet.

## Positioning

A **companion coordination layer** beside the existing EHR/LIS (EMA by ModMed at the author's lab). EMA stays authoritative for official accession numbers, clinical orders, approved gross reports and diagnostic reporting. This product owns operational tasks: arrival reconciliation, office-to-pathologist routing suggestions, specimen-specific clarifications with scoped holds, related-order review (never a merge), the digital doctor/PAS worklist, reviewed grossing handoff, print queue, tray assembly, block retrieval, and an append-only local audit trail. It does not replace accessioning or reporting.

## Operating Context

- Several dermatology offices submit specimens; couriers arrive around 11 a.m.; three accessioners reconcile them.
- Each submitting office routes to one of three dermatopathologists; the ordering clinician and the assigned dermatopathologist are different people.
- Parts of one patient's submission (e.g. A and B) sometimes arrive as separate orders.
- Clarifications go to the submitting offices and replies can be delayed (reason unknown).
- Today: a printed daily worklist ("the bible") colored by doctor with PAS cases marked in yellow; gross descriptions transcribed in a late batch; hundreds of slide labels printed and applied by hand; manual block searches.
- These are the author's employee observations, not audited findings or measured rates.

## Capabilities and Constraints

- Built: Next.js 16 / React 19 / TypeScript / Tailwind v4 / SQLite (better-sqlite3); every state change goes through server commands with server-side role checks, optimistic concurrency, idempotency and an append-only audit log; 247 domain tests and 17 browser tests.
- All data is synthetic and every name in the app is fictional. Source system (EMA-SIM), accession issuer, office notifications, printers, scanners and the AI assistant are simulated and labeled as such. The demo role selector is not authentication.
- Workflow safeguards must survive any redesign: original order, observed container and requisition evidence stay separate; a missing field is not a match; similar names or demographics never authorize combining orders; provisional intake ids never look like official accession numbers; holds are scoped to the affected material; no automatic merges, renumbering or relabeling.
- Design constraints confirmed by the user: keep the active case and specimen-part identity visible during review and editing; preserve keyboard and scanner workflows, readable contrast, and clear explanations for blocked actions.
- Design freedom confirmed by the user: layouts, navigation, typography, colors and components may be substantially redesigned; existing cards, sidebars and dashboard arrangements are not requirements.
- Target devices: bench workstations at 1366–1440 px and bench tablets around 1024 px; no phone layout is promised.
- Do not publish, deploy, contact laboratories, connect live systems, or scrape the employer's EMA session.

## Brand Commitments

- Name "Histology Lab OS"; idea/slogan "Histology Redesigned" (chosen by the author).
- Fictional laboratory "Lumen Bay Dermatopathology Laboratory"; fictional offices, staff and dermatopathologists as seeded.
- The design must not copy the branding, text, graphics or layouts of the reference sites the author shared (costanera.uk, reveallabs.co); they are references for level of care only.

## Evidence on Hand

- Synthetic demo day (66 active cases, 322 slides, scripted 11:00 courier, hero case D26-04817 / Avery Quinlan) in `src/server/seed/`.
- Research notes, integration matrix, pilot proposal, director pitch, discovery checklist in `docs/`.
- No customers, testimonials, endorsements, measured savings, ROI, clinical performance or production integration exist. Never fabricate them. No director has endorsed or approved the product.

## Product Principles

1. The next decision, its owner and its evidence are always visible; the reason an action is blocked is always stated.
2. Sources disagree openly: every value keeps its origin, and the screen shows where order, bottle and requisition differ.
3. Nothing combines, renumbers or resolves itself; people decide, and the record shows who and when.
4. Honest by default: simulated is labeled, unknown is "Unknown", illustrative numbers say so.
5. Every major redesign is reviewed in rendered screenshots using realistic synthetic cases.

## Accessibility & Inclusion

WCAG 2.2 AA target: readable contrast, visible keyboard focus, full keyboard and scanner operation, color never the only cue (doctor colors always paired with names, PAS always written), reduced-motion respected.
