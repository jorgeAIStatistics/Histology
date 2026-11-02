# Timeline: Histology Redesigned proposal

**After approval, phase by phase: rough estimates, for the deck and the brief**

| | |
|---|---|
| Prepared for | Director of Operations, Platinum Dermatology |
| Prepared by | Jorge Rodriguez, histology assistant |
| Date | [meeting date] |
| The software | Histology Lab OS, the software of the Histology Redesigned project |
| Full detail | `implementation-guide.md`, sections 5–7 |

> **Read this first.**
> - Every duration here is a **rough estimate to refine in Phase 0**, not a commitment.
> - Weeks are counted from approval; week 1 starts with the Phase 0 kickoff. The calendar dates are **illustrative only**: they assume a kickoff within about 2 weeks of approval, on Monday 30 November 2026, and they move with the actual dates.
> - Nothing has been approved. The demo uses synthetic data only and never connects to EMA, the lab network or patient information.

---

## 1. The meeting

**Meeting:** [meeting date]. **Proposed Phase 0 kickoff:** [to confirm].

**The ask at the meeting: approval for Phase 0 only.** That means four weeks of discovery and observation, with no patient data, no new software installed on lab systems and no purchase.

---

## 2. After approval: the phases

Phases overlap. Each one ends at a gate where the plan can stop. **Stopping, or configuring existing tools, is a successful outcome.**

| Phase | Weeks from approval | Illustrative dates | Gate at the end |
|---|---|---|---|
| **0. Discovery and governance**: discovery checklist, observation with staff consent, metric definitions, inventory, questions to ModMed and any LIS vendor | 1–4 | 30 Nov – 23 Dec 2026 | **G0:** configure, buy, build or stop |
| **1. Synthetic sandbox at the lab**: demo mode on a lab-controlled computer with no data connection; bench usability sessions with the real scanners, printers and monitors; a written intended use | 5–10 | 28 Dec 2026 – 5 Feb 2027 | **G1:** usability fixed; intended use approved by the Medical Director; support model chosen and connector developer named; go or no-go for Phase 2 |
| **2. Technical foundation and integration feasibility**: hosting, TLS, identity provider, secret store, encrypted storage, backups and restore drill, monitoring; the vendor interface, an interface engine and the connector (weeks 13–19); an independent security review (2–4 weeks, weeks 19–22) | 8–22 (vendor-dependent: 2–6 months) | 18 Jan – 30 Apr 2027 | **G2:** secured mode working in a **test** environment with real sign-in and test interface messages; no production patient data |
| **3. Validation and training**: a validation plan and protocol under the lab's quality system, approved by the Medical Director; interface checks; a downtime procedure; role-based training (1–2 h per role) | 20–28 | 12 Apr – 11 Jun 2027 | **G3:** go-live readiness review |
| **4. Limited pilot**: one workflow on one bench [to choose in Phase 0]; about 2 weeks in shadow mode, then live with a rollback plan; weekly review against the baseline | 28–36 | 7 Jun – 6 Aug 2027 | Weekly: continue or stop |
| **5. Decision**: on pre-agreed criteria | 36–38 | 2 Aug – 20 Aug 2027 | **G5:** continue, expand, change or stop |

- **Vendor scoping runs from week 1**, during Phases 0–1, with no contract and no data: questions, a draft specification, a quote and a request for a test environment. **Only signing waits for Gate 1** (week 10). Nothing is purchased or contracted before Gate 1.
- **Gate 1 also names people:** the sponsor chooses the support model and names the developer who will build the connector (internal IT or contracted). Jorge is never the only developer of code that receives test or real patient messages. The support owner and a second maintainer are in place by Gate 3.

---

## 3. Gantt chart

**Planned case, the best case** (vendor specification and test environment by about week 15). `#` = phase active, `=` = activity within a phase, `^` = gate.

```
                                           1         2         3
Week                              12345678901234567890123456789012345678
Phase 0  Discovery & governance   ####..................................
Phase 1  Synthetic sandbox        ....######............................
Phase 2  Foundation & interface   .......###############................
  Connector development           ............=======...................
  Vendor test env. (best case)    ..............=.......................
  Security review (2-4 wks)       ..................====................
Phase 3  Validation & training    ...................#########..........
Phase 4  Limited pilot            ...........................#########..
    shadow ~2 wks                 ...........................==.........
    live, one bench               .............................=======..
Phase 5  Decision                 ...................................###
Gates (^ = G0, G1, G2, G3, G5)       ^     ^           ^     ^         ^
```

The security-review weeks are a placeholder, to be scheduled with the tester. They come after the connector is built, so the review covers it. Phase 4 has weekly continue-or-stop reviews instead of a numbered gate.

**Delay case** (the vendor test environment arrives about 3 months late, about week 27). Gate 2 moves to about week 34, and Phases 3–5 move about 12 weeks later, to about week 50:

```
                                       1         2         3         4         5
Week                          1234567890123456789012345678901234567890123456789012
Phase 0                       ####................................................
Phase 1                       ....######..........................................
Phase 2 (interface ~6 months) .......###########################..................
Phase 3                       ...............................#########............
Phase 4                       .......................................#########....
Phase 5                       ...............................................###..
```

---

## 4. Totals (estimates)

| Path | Length | Illustrative end | Patient data? |
|---|---|---|---|
| **Phases 0–1 only: the cheapest decision-grade path** | About 10 weeks | About 5 Feb 2027 | **No** |
| **Best case:** approval to the end of a limited pilot, with a vendor specification and test environment by about week 15 (about 3 months after approval) | About 7–9 months | About August 2027 | Only from Gate 3 (end of Phase 3), then Phase 4 |
| The same, with vendor or contract delays | Up to about 12 months | As late as about November 2027 | Only from Gate 3, then Phase 4 |

**If the vendor test environment is not ready by about week 15, plan on the 12-month case.**

---

## 5. What drives the dates

- **The vendor interface is the longest pole.** That means the specification, a test environment, the contract and fees with ModMed's lab connection process and/or the LIS vendor, plus the connector development (weeks 13–19, effort not yet estimated). Vendor scoping starts in week 1 of Phase 0 because of this.
- **One question could remove the interface path altogether.** ModMed also describes an in-house Pathology module. If the lab works inside it [to confirm in Phase 0], orders may never travel over HL7 to a separate system, and the build path would likely stop at Gate 0.
- **Other dependencies that can slip:**
  - IT's hosting queue;
  - business associate or data agreements;
  - scheduling the security review;
  - choosing the support model and naming the connector developer (Gate 1), and having the support owner in place (Gate 3);
  - staff time for sessions and training.
- **Holidays.** Weeks 4 and 5 (21 Dec and 28 Dec 2026) are year-end holiday weeks, so Gate 0 may fall in early January [to confirm: the lab's schedule and busy periods]. If vendor answers are missing at week 4, Gate 0 decides the answered gaps and may extend Phase 0 by up to [to confirm] weeks.
- **What could shorten it:** Gate 0 chooses *configure* (no build path at all); an existing order feed can be copied to a test environment with approval; IT already has standard templates and an identity provider.

---

## 6. Rough effort per role (estimates to refine in Phase 0)

**Phase 0 only:** the sponsor about 4 h over the 4 weeks, plus Gate 0; the Medical Director, IT lead and Compliance/Privacy officer [to estimate at kickoff: a 30-minute kickoff, a 30-minute Gate 0 review, plus answers to their discovery items]; Jorge [to confirm: hours per week, agreed with his manager, and who covers his bench].

**The whole build path:**

| Role | Effort |
|---|---|
| Sponsor (Director of Operations) | About 1 h per week, plus gate decisions |
| Medical Director | About 4–8 h, plus gate reviews and validation approval |
| Bench staff | Usability sessions of 1–2 h each for 5–8 people; training of 1–2 h per role |
| IT | About 40–100 h |
| Compliance/Privacy | About 10–30 h |
| Validation | About 60–150 h of testing and documentation, depending on the workflow chosen |
| Jorge | Coordination and configuration, with a time agreement [to confirm with his manager] |
| Connector development | Not yet estimated [to estimate at Gate 1] |
| Ongoing support and operations after go-live (updates, backups and drills, monitoring, re-validation after changes) | Not yet estimated [to estimate at Gate 1] |
| Vendor interface fees; external security-test costs; hosting; any support contract; hardware and label stock | **Unknown until quotes or estimates in Phase 2** |

*No savings, prices or return on investment are estimated anywhere in this proposal.*
