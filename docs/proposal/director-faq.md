# Director FAQ: the hard questions, answered honestly

| | |
|---|---|
| Prepared for | Director of Operations, Platinum Dermatology |
| Prepared by | Jorge Rodriguez, histology assistant |
| Date | [meeting date] |
| Status | Proposal for discussion |
| The software | Histology Lab OS, the software of the Histology Redesigned project |

> No one has endorsed, approved, funded or bought this work: not the laboratory, not ModMed, not any vendor. The demo uses synthetic data for a fictional lab, "Lumen Bay Dermatopathology Laboratory (fictional)", and has never been connected to EMA, the lab network or patient information. Every effort and time figure is a **rough estimate to refine in Phase 0**. "[to confirm: …]" marks something I don't know yet. Facts about ModMed and other vendors come from their public pages, are listed at the end, and **must be confirmed with the vendor**.

**Questions**

- **Strategy:** 1. Why not just use EMA? · 2. Why not just buy an LIS or a tracking product? · 3. How long until it actually helps anyone? · 4. What if we say no, or not now?
- **Cost and effort:** 5. What does it cost? · 6. What do staff have to change?
- **Data, privacy and compliance:** 7. Does it touch patient data? · 8. Is it compliant? · 9. Has it been tested? Is it validated? · 10. Does it connect to EMA? How would it? · 11. Where would it live, and who could change it?
- **People and ownership:** 12. Who maintains this if you leave? · 13. Who owns it? · 14. Did you use work time, work equipment or work data? · 15. How did you build it?
- **Safety:** 16. What if it is wrong? · 17. What happens if the server is down? · 18. Can it make diagnoses? · 19. Is AI deciding anything? · 20. Will it be used to rate staff, or to pressure the offices?
- **More hard questions:** 21. Who is responsible if the tool contributes to an error? · 22. Do you plan to sell it? · 23. What if ModMed or the LIS vendor hasn't answered by week 4? · 24. Did employer information go to the AI service you used?

---

## Strategy

### 1. Why not just use EMA?

Maybe we should, and that's the first thing Phase 0 checks. ModMed advertises pathology features such as gross defaults, configurable stains, tracking and multiple accession sequences. Its FAQ says the module handles slide and cassette label printing "in most cases" ([R1] in `../pilot-proposal.md`). I don't know what we have licensed or switched on, or who can change the configuration.

If EMA can close a gap, we close it there and stop. That is a success, not a failure of this proposal. Some gaps may sit between offices and the bench, for example who owns a clarification and whether a courier delivery is complete. I don't know yet whether EMA covers those. Phase 0 finds out, gap by gap.

### 2. Why not just buy an LIS or a tracking product?

That could be the right answer. Third-party LIS vendors advertise ModMed integrations; LigoLab, for example, describes one on its website (a vendor claim, link at the end). Products also exist for specimen tracking, grossing documentation and slide printing ([R10]–[R12] in the pilot proposal), again described by their vendors.

Buying brings vendor support, and sometimes hardware the vendor has tested. It also brings license fees, interface work, local validation and training, and it may be a bigger change than our gaps need. In Phase 0 we would ask vendors, with test data only, what they would do for our specific gaps.

The demo still helps either way: it turns general observations into specific requirements we can hand to a vendor.

### 3. How long until it actually helps anyone?

- **The first useful result comes at week 4.** It's a measured picture of the gaps and a recommendation. If the answer is "configure EMA", the help could start soon after, on ModMed's and IT's timeline, not this plan's.
- **If we build, bench use comes later.** The earliest is a limited pilot around week 28 (about 6–7 months), starting in shadow mode on one bench.
- **The end of that pilot** comes about 7–9 months from approval in the best case, which needs a vendor specification and test environment by about week 15 (about 3 months after approval). With vendor or contract delays it is up to about 12 months.

An illustrative calendar, only to make the weeks concrete: with a kickoff about two weeks after approval, on Monday 2026-11-30, week 4 would end about 2026-12-23 (a holiday week, so Gate 0 may slip into early January). Phases 0–1 would end about 2027-02-05. The pilot would start about early June 2027, and the Phase 5 decision would fall about mid-August 2027 [to confirm: lab calendar]. A fallback meeting moves everything about one week later.

### 4. What if we say no, or not now?

That's a fair answer, and I'll respect it. I'd ask one thing: what would need to be true to revisit it, for example a quieter season or an answer from ModMed first. My observations stay observations. I won't install anything, collect anything or contact anyone about this without approval.

---

## Cost and effort

### 5. What does it cost?

- **Phase 0 costs staff time only.** There is no purchase, no license and no installation. Rough estimate: you, about 4 h over the 4 weeks plus the Gate 0 decision; the Medical Director, IT lead and Compliance/Privacy officer [to estimate at kickoff: a 30-minute kickoff, a 30-minute Gate 0 review, plus answers to their discovery items]; me [to confirm: hours per week agreed with my manager, and who covers my bench while I observe].
- **The whole build path, in rough ranges to refine in Phase 0:**
  - Sponsor: about 1 h a week, plus gate decisions.
  - Medical Director: about 4–8 h, plus gate reviews and validation approval.
  - IT: about 40–100 h.
  - Compliance/Privacy: about 10–30 h.
  - Bench staff: usability sessions of 1–2 h each for 5–8 people, and 1–2 h of training per role.
  - Validation: about 60–150 h of testing and documentation, depending on the workflow chosen.
  - Jorge: coordination and configuration, under a time agreement [to confirm with my manager].
- **Not yet estimated, or unknown until quotes in Phase 2:** the work to build the interface connector, vendor interface fees, the external security test, hosting, any contracted developer or support agreement, and any hardware or label stock.
- **A lasting cost, not a one-off:** ongoing support and operations after go-live (updates, backups and restore drills, monitoring, re-validation after changes). Not yet estimated [to estimate at Gate 1].

There are **no dollar figures and no savings estimates** in this proposal, on purpose. If we measure a benefit later, we keep labor time, waiting time and actual cash separate, and we subtract the extra checking any new tool adds (`../pilot-proposal.md`, sections 7 and 8).

### 6. What do staff have to change?

- **Phase 0:** nothing. Being observed is voluntary and needs consent. My notes hold times and categories, never names, MRNs or accession numbers. If you agree, a small group also spends about 30 minutes reviewing the synthetic demo and telling me what I got wrong.
- **Phase 1:** 5–8 volunteers try the synthetic demo at the bench for 1–2 hours each and tell us what's wrong with it.
- **Pilot (only if we get there):** one workflow on one bench, for example courier intake reconciliation or tray assembly scan checks [to choose in Phase 0]. It runs about two weeks in shadow mode first. Training is 1–2 h per role, plus a quick reference.

The new safety steps take time. For example, someone confirms "checked against the physical container". We count that time instead of hiding it. The paper fallback stays until the lab decides otherwise.

---

## Data, privacy and compliance

### 7. Does it touch patient data?

- **Today:** no, and never has. Every patient, office, doctor and staff name in it is fictional.
- **Phase 0:** no. My observation notes hold times and categories only.
- **Phase 1:** no. The sandbox uses synthetic data that mirrors our structure, with fictional names.
- **Phase 2:** no production patient data. It uses a test environment, test sign-ins and test interface messages.
- **Validation (Phase 3):** test data in the test environment. Any check that needs production data (for example a production interface check) is a Gate 3 decision approved by Compliance and the Medical Director [to confirm].
- **The pilot (Phase 4):** patient data only from Gate 3, after the Compliance/Privacy officer, IT and the Medical Director approve the data flow, the hosting and the minimum fields needed.

Even then, by design and covered by tests, audit summaries leave out patient names, birth dates and MRNs, and logs are built to leave out tokens and patient fields (one documented limit: a name typed inside free text can't be recognized automatically).

### 8. Is it compliant?

**I make no compliance claim: not HIPAA, CLIA, CAP, FDA or any other.** The software has technical controls that were tested on synthetic data:
- sign-in designed for an organization's identity provider;
- server-side permission checks;
- a tamper-evident audit trail;
- encrypted backups;
- no patient name, birth date or MRN in audit summaries.

**Technical controls are not compliance.** Whether and how any regulation or accreditation requirement applies is a determination for the Compliance/Privacy officer and the Medical Director. That's why both are in Phase 0.

For example, the CAP Laboratory General checklist has requirements for information systems: validation at installation and after changes, and interface checks. Older summaries also describe approval by the laboratory director or a designee; that is to confirm against the current edition. Requirement numbers seen in older sources (such as GEN.43022 and GEN.48500) must be checked against the current edition [to confirm: which accreditation and checklist edition apply here]. Hosting with patient data would also need an arrangement Compliance approves, for example a business associate agreement with a cloud provider [to confirm with Compliance].

### 9. Has it been tested? Is it validated?

- **Tested, yes.** The latest full run (2026-10-24, synthetic data, my machine): about 800 automated tests pass (643 unit, integration and contract tests; 139 demo browser tests, including automated accessibility checks; 26 secured sign-in tests), and the type check is clean. I re-run them on the final code before the meeting.
- **Validated, no.** A passing test shows the code does what the test says. It is not clinical validation.
- **Validation is the laboratory's job,** under its own quality system: a plan and protocol, approved by the Medical Director. The automated tests are supporting evidence only. My rough estimate is about 60–150 h of testing and documentation, depending on the workflow chosen.
- **For scale:** practitioner commentary describes full LIS validation as taking hundreds of hours. This tool is narrower, but its validation is still substantial.
- **Never checked by a person yet:** screen readers, paper printing on our printers, real scanners and printers, touchscreens, and any browser other than Chromium.

### 10. Does it connect to EMA? How would it?

**Not now, and never in the demo.** Every "source system" in it is a simulator.

**One caution first.** ModMed also describes an in-house Pathology module. If the lab works inside it [to confirm in Phase 0], orders may never travel over HL7 to a separate system. A companion would then need ModMed API access to that data, or could not get it at all, and the build path would likely stop at Gate 0.

What ModMed says publicly (to confirm with ModMed):
- EMA sends clinical and pathology lab orders out as HL7 ORM messages and receives pathology results as HL7 ORU messages. Results can carry a PDF and be matched to the patient chart.
- Labs connect through ModMed's lab connection (partner) process.
- ModMed's API portal documents a Certified FHIR R4 API (OAuth 2.0 / SMART on FHIR, mainly read and search) and a proprietary EMA API.

**Which of these fits order intake for us must be confirmed with ModMed.** The software has its own versioned, signed message contract (`hlos.source-message` 1.0, `../release/integration-contract.md`). In Phase 2, an interface engine would translate HL7 ORM orders into that contract.

Two cautions:
- **An order feed is not histology workflow data.** It may not carry parts, blocks, slides or gross text.
- **The interface contract and fees are unknown** until Phase 2.

Even with an interface, a message can never renumber an accession or change an accessioned part's site or side. Differences go to a person.

### 11. Where would it live, and who could change it?

| When | Where it runs | Data |
|---|---|---|
| Today | My own laptop, for demos only | Synthetic |
| Phase 0 | Nowhere at the lab | None |
| Phase 1 | One lab-controlled computer that IT chooses, in demo mode, not connected to EMA or the network for data | Synthetic |
| Phase 2 onward | An on-premises virtual machine or an approved cloud service, as IT and Compliance decide [to confirm]. TLS, the organization's own identity provider (for example Entra ID or Okta, whatever we already use), a secret store, an encrypted volume, scheduled backups with a restore drill, and monitoring of `/api/health` | Test data until approved |

**Who can change it:**
- **Where the code lives:** a repository the organization controls [to confirm with IT].
- **How changes are made:** through change control. A change is reviewed, passes the automated tests, is approved, and is re-validated where the quality system requires it.
- **Who approves:** the Medical Director, or a designee, for anything that touches a validated workflow.
- **What I can't do:** I would not change a live system on my own.
- **Separate roles:** in the software, every page and command is permission-checked on the server, and the administrator and auditor roles have no clinical access.

---

## People and ownership

### 12. Who maintains this if you leave?

Today, nobody but me, and that's a real risk. A lab must not depend on one employee for a tool in its workflow. The options are:
1. **Internal IT ownership,** with me as a contributor;
2. **a contracted developer or firm** under a support agreement;
3. **a vendor product instead,** if one closes the same gaps.

My proposed rule: **a named developer before any interface work; a named owner before any pilot.** At Gate 1 (week 10) you would choose the support model and name the developer who will build the connector (internal IT or contracted); I am never the only developer of code that receives test or real patient messages. By Gate 3 (week 28) the support owner is in place, together with a second person who can build, deploy, back up and restore it (`implementation-guide.md`, section 13).

The standard tools it uses (TypeScript, Next.js, SQLite), its documentation and its about 800 automated tests make a handover realistic. They don't replace a professional owner. If no owner can be found, that's a strong reason to configure or buy instead.

### 13. Who owns it?

I don't know yet, and I think it should be settled in writing early, in Phase 0, with HR or legal (`../discovery-checklist.md`, item 12.5) [to confirm: employer policy on employee-built tools]. I built it as an employee initiative. This is not a purchase request, and I'm not asking for payment. There is no lab data in it to own: everything inside is synthetic.

Facts HR or legal should have from the start:
- The code is in a private repository on my personal GitHub account [to confirm: that it is private].
- The commits carry my personal university email address and the user name clalrityai [to confirm: the account it belongs to].
- I have no commercial interest in it today [to confirm] (see question 22 on the long-term vision).

In Phase 0, HR or legal should confirm that no other institution or business has a claim, and the repository moves to one the organization controls before Phase 1.

### 14. Did you use work time, work equipment or work data?

- **No work data:** no patient data, no employer documents, screenshots, reports or contact lists.
- **No real names in the software:** every name in the app and its demo data is fictional.
- **One exception in the project folder:** one early prompt file I wrote for the AI coding assistant names the employer and one real role-holder. It holds no patient data and no employer documents. It is still in the project folder and in a private copy on my personal GitHub account. I will delete it and purge it from the history and the GitHub copy before [to confirm: date], and in any case before the code is shared (see question 24).
- **No connections:** it has never been connected to EMA or the lab network, or installed on a lab computer.
- **Time and equipment:** [to confirm: built on my own time and my own computer].

The problems it addresses come from what I've seen at work, described in my own words.

### 15. How did you build it?

With an AI coding assistant, over [to confirm: number of weeks]. I'm a histology assistant, not a professional software developer. I decided what it should do from what I see at the bench, and the assistant helped write the code, the tests and the documents [to confirm: how I reviewed and directed the assistant's work].

That is honest, and it's also exactly why the plan requires two things before any real use:
- an independent security review;
- a professional owner.

The AI that helped build it is not inside the software making decisions (see question 19). What went to the AI service is in question 24.

---

## Safety

### 16. What if it is wrong?

It depends on what is wrong:
- **A suggestion is wrong** (a routing or a related-order suggestion). It only suggests; a person decides, with a reason. An office with no rule goes to an exception list, so no doctor is guessed.
- **Incoming data is wrong.** A message can never change an accessioned identity. Conflicts go to a person, and both versions are kept.
- **The software has a bug.** EMA stays the system of record, and the companion is never the only place a required fact is kept. The audit trail shows who did what and when, and it shows if anyone edits it.
- **During the pilot.** It runs in shadow mode first, with stop triggers agreed in advance (`../pilot-proposal.md`, section 12) and a rollback to the current process.
- **My observations are wrong.** Phase 0 shows it, and we stop. That's a success too.

### 17. What happens if the server is down?

Work continues in EMA and on paper, because the companion is never the only place a required fact lives.
- **Fallback:** a printed snapshot, showing when it was generated and which version it is.
- **Downtime procedure:** written and rehearsed in Phase 3, before any pilot.
- **If the EMA feed stops:** the screens mark the data as stale and show its age, instead of looking live.
- **Monitoring:** health checks report healthy, degraded or unavailable.
- **Backups:** encrypted, with a restore that is verified before use.
- **Acceptable data loss and recovery time** are decided by the laboratory director and IT [to confirm].

### 18. Can it make diagnoses?

**No.** It makes no diagnoses, orders no stains and releases no reports. It makes no specimen-matching decisions and corrects no accessions. A special stain such as PAS is shown from the order that authorized it, never inferred from diagnosis text. Clinical decisions stay with authorized people.

### 19. Is AI deciding anything?

**No.** There is no live AI in the software.
- The demo's drafting and extraction "assistant" is fixed demo rules, labeled as simulated on screen.
- Every value it proposes stays "proposed" until a person confirms it.
- The manual workflow works with the assistant switched off.
- The test data even includes an order note that tries to give the assistant instructions. It is treated as plain text and changes nothing, and the tests cover that.

If anyone ever wanted to add real AI, that would be a separate decision with the Medical Director, with its own validation. It is not part of this proposal.

### 20. Will it be used to rate staff, or to pressure the offices?

**No.** Results are reported by team, role, station or office category, never as individual rankings from raw counts. Individual data is used only with that person's agreement. The demo's Operations view does name who holds each next step, because ownership is the point. It shows counts, not rates, and in a lab version whether it shows names or roles would be decided with staff in Phase 1. Office-level clarification results are for working together with the offices, not for blame. Faster replies would need an agreement with the offices, which is the Director's call, and no office is contacted in Phases 0–1 unless you decide otherwise.

---

## More hard questions

### 21. Who is responsible if the tool contributes to an error?

The lab's quality system and the written intended use govern responsibility, and EMA stays the record. The tool only suggests and blocks; every consequential decision is a named person's recorded action. Before any pilot (Phase 4), risk management or legal reviews the intended use and the pilot plan [to confirm: who reviews it]. Until then, nothing in this proposal touches patient care.

### 22. Do you plan to sell it?

I have no plan to sell it [to confirm]. The optional product vision describes where this could go, including a product other labs could use. That is a direction, not a plan: it would need a funded team, and who would fund, own and support it is an open question. Ownership is settled in writing in Phase 0 with HR or legal (question 13) before any further work.

### 23. What if ModMed or the LIS vendor hasn't answered by week 4?

Gate 0 decides the gaps that are answered (configure or stop is a fine outcome for any of them) and can extend Phase 0 by up to [to confirm] weeks for the rest. Nothing is built while we wait. If an answer decides whether orders reach the lab over an interface at all (question 10), the build path waits for it.

### 24. Did employer information go to the AI service you used?

No patient data, no employer documents and no lab data went to it. One early prompt file I wrote for the AI coding assistant named my employer and one real role-holder, so those names were given to an external AI service. That is the one exception I know of, and I'd rather say it plainly. The file is still in the project folder and in a private copy on my personal GitHub account; I will delete it and purge it from the history before [to confirm: date]. Whether the employer's policy on AI tools applies to this is a Phase 0 question for HR or legal [to confirm].

---

## Public sources used here (confirm each with the vendor)

- ModMed HL7 (orders out as HL7 ORM; pathology results in as HL7 ORU, with PDF and chart matching): https://www.modmed.com/synapsys/hl7/ and https://www.modmed.com/?p=31624
- ModMed lab connection (partner) process: https://www.modmed.com/lab-connect/
- ModMed API portal (Certified FHIR R4 API, OAuth 2.0 / SMART on FHIR, mainly read and search; proprietary EMA API): https://portal.api.modmed.com
- LigoLab, on its ModMed integration for dermatopathology (vendor claim, relevant to the "buy second" option): https://www.ligolab.com/post/seamless-diagnosis-mapping-why-ligolabs-modmed-integration-matters-for-dermatopathology
- CAP information-system requirements and validation effort (check requirement numbers against the current checklist edition): https://www.mlo-online.com/information-technology/lis/article/13009283/the-inspectionready-lab-includes-it
- [R1], [R10]–[R12]: listed with links in `../pilot-proposal.md`, References.
