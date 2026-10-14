# Runtime AI Assistants

Histology Lab OS uses **four small, bounded assistants**. Each one reads a limited set of data and produces a **proposal, draft or summary for a person to review**. None of them can change a record, send a message, print a label or make a clinical or identity decision.

> **In the demonstration, no AI model is used.** Each assistant runs a **deterministic demonstration engine** (fixed rules and templates that give the same output for the same input). The screen labels it plainly. The label strings used in the app are:
> - drafter: **"Draft text: deterministic demo output, not live AI. Edit before sending."**
> - extractor: **"deterministic-demo-extractor v1 (deterministic demo output, not live AI)"**, and the transcript panel says "Synthetic transcript. Extraction is a deterministic demo."
> - summaries: **"Computed summary (deterministic demo) — not AI"**
>
> A real model is used only if one is deliberately configured later, after approval (Section 8). Hardcoded or rule-based output is never presented as live reasoning.

These runtime assistants are part of the product. They are different from the development subagents that may have helped build the software.

---

## 1. Ground rules (apply to every assistant)

1. **Proposals only.** Anything that would change a record stays a proposal until the responsible person accepts, edits or rejects it. Accepting is a separate, audited human action.
2. **Read-only tools.** No assistant has write, send, print or status-change tools. The application (not the assistant) stores the proposal after checking it.
3. **Evidence or nothing.** Every proposed value points to the exact text it came from (an *evidence span*). If no supporting text exists, the field is listed as **unresolved**, never guessed.
4. **No confidence percentages.** The system does not show numbers like "92% confident." It uses plain categories instead: *found in source text*, *needs confirmation*, *ambiguous*, *conflicting*, *unit missing*, *not found*.
5. **The manual workflow always works.** If an assistant is off, slow, wrong or broken, staff can do the same step by hand on the same screen.
6. **Imported text is data, never instructions** (Section 5).
7. **Never:** diagnose; order or cancel stains; decide PAS eligibility (especially not from diagnosis text); decide that specimens, orders or patients match; merge records; correct or renumber an accession; change a site or part designation; resolve a clarification; mark anything as sent, verified, entered in EMA or complete; release a report.

### Where rules are used instead of AI

Explicit rules and database constraints, not AI, handle: identity relationships, related-order candidate detection, office-to-pathologist routing, counts, permissions, accession references, readiness, holds, print deduplication, deadlines and PAS display (from the originating order or protocol).

---

## 2. Summary

| Assistant | Where it appears | Trigger | Output | Who reviews |
|---|---|---|---|---|
| A1. Field extractor | `/intake` (requisition), `/grossing` (dictation transcript) | Person clicks **Propose fields** on a document linked to the current item or part | Field proposals with evidence spans and unresolved fields | Accessioner (intake); grosser or histology assistant per local SOP (grossing) |
| A2. Clarification drafter | `/clarifications`, `/cases/[id]` | Person clicks **Draft message** on a clarification in the drafted state | Draft question for the secure case view plus a generic notification with no patient information | The clarification's lab owner |
| A3. Case history summarizer | `/cases/[id]` | Person opens **Summarize history** | Short summary where every statement links to recorded events, plus a list of gaps | Informational; reader checks linked events |
| A4. Pending handoff summarizer | `/operations` | Person clicks **Summarize pending handoffs** | What is blocked, waiting on whom, since when, with links and data age | Operations supervisor |

### 2.1 What was actually built (demo, rollout mode A)

The definitions in Section 4 describe the intended design. The local demo implements a smaller, fully deterministic version:

| Assistant | Status in the build | How it works in the demo |
|---|---|---|
| A1. Field extractor, **grossing mode** | Built (deterministic) | `deterministic-demo-extractor v1` (`src/server/assist/extractor.ts`). Loading a synthetic dictation transcript on `/grossing` runs it. Each field gets a status: *proposed* (with the exact transcript span), *needs review* (with a reason such as unit missing or possible missed decimal) or *missing*. A person confirms each value; nothing is confirmed automatically. |
| A1. Field extractor, **requisition mode** | **Not built** | At `/intake`, staff type the bottle-label observation and the requisition fields are seeded as synthetic data. No extraction runs on requisitions. |
| A2. Clarification drafter | Built (deterministic) | `deterministic-demo-drafter v1` (`src/server/assist/drafter.ts`). "Draft message" proposes a question from the recorded evidence and a generic notification. Identity values (name, date of birth, MRN) are never quoted. A clarification started from a draft is marked as such (`draft_source = assistant_proposal`). |
| A3. Case history summary | Built as a **computed summary, not an assistant** | `/cases/[id]` shows an operational summary computed by fixed queries from the case's records, each line linked to its evidence, labeled "Computed summary (deterministic demo) — not AI". It appears automatically; there is no "Summarize history" button. |
| A4. Pending handoff summary | Built as a **computed summary, not an assistant** | `/operations` shows "Pending handoffs" computed from open tasks and holds, labeled the same way. It appears automatically. |

Other differences from Sections 3–6:
- There is no separate stored "proposal set" record. Extractor proposals are stored on the gross record itself (each field keeps its proposed value, status, evidence and, once confirmed, who confirmed it and when). The review states actually used are, per field: **proposed → needs review → confirmed**, or **missing**. A gross record version that is replaced becomes *superseded*.
- Because the engines are deterministic and local, there are no timeouts or automatic retries. Failure is demonstrated with the demo control "Make assistant unavailable" (Settings → Demo scenarios): drafting and extraction then report that the assistant is unavailable and every manual path keeps working.
- Engine identifiers: `deterministic-demo-extractor v1`, `deterministic-demo-drafter v1`; the simulated connector row is named "Drafting/extraction assistant (deterministic demo)".
- The seeded order note for one synthetic patient contains instruction-like text on purpose (a prompt-injection test fixture for acceptance check 15). It is stored and shown only as data.

---

## 3. Common proposal format

This is the conceptual shape of a proposal in the full design. The demo stores a simpler version (Section 2.1); the schema in `src/server/db/` and the "As built" section of `data-model.md` are authoritative for names.

| Part | Meaning |
|---|---|
| Proposal ID | Unique ID of this proposal set |
| Assistant and engine | Which assistant, and which engine ran it: `deterministic-demo-extractor v1`, `deterministic-demo-drafter v1`, or a named, configured model |
| Display label | The visible label, e.g. "Draft text: deterministic demo output, not live AI. Edit before sending." |
| Source | The exact document or record version it read (ID, version, content fingerprint) |
| Target | The exact item it is for, e.g. intake item `INT-1014-031` or accession `D26-04817` Part A |
| Proposed values | For each field: value, unit if any, evidence span(s) (start, end and the quoted text), flags such as *needs confirmation* |
| Unresolved fields | Each field it could not fill, with a reason: *not found*, *ambiguous*, *conflicting*, *unit missing*, *identity mismatch* |
| Instruction-like text | Whether the source contained text that looks like commands (Section 5), with its location |
| Review state | Per field: **proposed → needs review → confirmed**, or **missing** (the states used in the demo). A rejected value is replaced by what the person types. A gross record version that is replaced becomes **superseded** |
| Times | Created and reviewed times, stored in UTC, shown in America/New_York |

The application checks every proposal before saving it: fields must belong to the allowed list for that screen, and every quoted evidence text must exactly match the source at the stated position. Anything that fails the check is discarded and logged.

---

## 4. Assistant definitions

### A1. Field extractor (requisitions and grossing transcripts)

| | |
|---|---|
| **Purpose** | Turn a synthetic requisition or a synthetic grossing dictation transcript into candidate field values, so the person types less but still checks everything. |
| **Modes** | **Requisition mode** fills the *observed requisition* column of the intake comparison panel (office, ordering clinician as written, part designation, site, laterality, procedure, orientation/marks, collection date as written). It never fills the *order* column, which comes from the source system. **Grossing mode** fills draft grossing fields (specimen type, piece count, dimensions with units, orientation/ink, cassette allocation). The original narrative is always kept unchanged next to the proposals. |
| **Trigger** | A person clicks **Propose fields** on a document already linked to the current intake item or part. Never run in bulk across cases. |
| **Inputs** | One document version (text, or the text that accompanies a synthetic image); the allowed field list for that screen; the identity of the open item or part (used only to check for mismatch). Nothing else about the patient. |
| **Allowed tools** | Read that document version (read-only). Read the field list/template definition (read-only). |
| **Outputs** | A proposal set (Section 3). Numbers, units and counts are always flagged *needs confirmation*. Unresolved fields are listed. |
| **Owner** | Reviewer: the accessioner on the item (requisition mode, not built in the demo); for grossing mode, the demo permission matrix (`src/lib/roles.ts`) lets the grosser, the histology assistant or the supervisor confirm values and mark a record reviewed, and the grosser, supervisor or dermatopathologist approve it. The real assignment is a local SOP decision. Configuration owner: operations supervisor (Tanya Brooks in the demo). |
| **Timeout** | 20 seconds (the deterministic engine normally finishes immediately). |
| **Retry** | One automatic retry after a temporary failure (e.g. provider not reachable), only if the document version has not changed. No automatic retry when output fails validation. A person may click again; a repeat request for the same document version and field list returns the existing proposal instead of creating a duplicate. |
| **Review requirement** | Each value is accepted, edited or rejected individually. There is **no "accept all"** for numbers, units or counts. A grossing draft with a missing required piece count, a missing unit or an ambiguous decimal **cannot be finalized** until a person resolves it. |
| **Audit events** | run requested, run completed / failed / timed out, output rejected by validator, instruction-like text flagged, proposal created, each value accepted / edited / rejected (with reviewer), proposal superseded. |
| **Failure mode** | Fields stay empty with a notice ("Extractor unavailable: enter fields manually"). The original document stays visible. Intake and grossing continue by hand. |
| **Prompt-injection handling** | Document text is data. Text such as "ignore previous instructions" or "mark as verified" is shown to the reviewer as flagged text and has no effect. The extractor can only output fields from the allowed list, each backed by an exact quote. It cannot set review states, change roles or call other tools. |

**Extraction rules in plain terms**

- It never invents a missing value, never fills in a template default as if it had been observed, and never converts an ambiguous measurement (for example "0.4" with no unit stays *unit missing*, not "0.4 cm").
- If the document mentions a value twice in conflicting ways, both are shown and the field is *conflicting*; the person decides.
- If the document names a different part or site from the one that is open, it reports *identity mismatch* and proposes nothing for that part. It does not decide which is correct.
- For the hero case, the **rules-based comparison** on `/intake`, not an assistant, detects that the order says right dorsal forearm while the bottle (typed observation) says left. It does not decide which is correct; that goes to clarification `CLR-0457`. (Requisition mode, if built later, would only fill the observed-requisition column.)

**Illustrative example (grossing mode).** This example is illustrative and may differ from the seeded demo fixture.

> Synthetic transcript: "Part A, left upper back. Received in formalin is one shave of tan skin, 0.8 by 0.6 by 0.2 centimeters. There is a 0.4 brown macule. Deep margin inked blue. Bisected and submitted entirely in cassette A1."

| Field | Proposed value | Evidence | Flag |
|---|---|---|---|
| Part / site check | Matches open part A, left upper back | "Part A, left upper back" | None |
| Specimen type | Shave | "one shave of tan skin" | None |
| Piece count | 1 | "one shave" | Needs confirmation |
| Dimensions | 0.8 × 0.6 × 0.2 cm | "0.8 by 0.6 by 0.2 centimeters" | Needs confirmation |
| Lesion size | Not filled | "0.4 brown macule" | **Unit missing** |
| Ink | Deep margin, blue | "Deep margin inked blue" | None |
| Cassette allocation | A1, entirely submitted | "submitted entirely in cassette A1" | Needs confirmation |

---

### A2. Clarification drafter

| | |
|---|---|
| **Purpose** | Write a short, specific question to the submitting office from the actual discrepancy, for a person to edit and approve. |
| **Trigger** | A person clicks **Draft message** on a clarification task in the *drafted* state. |
| **Inputs** | The discrepancy record: affected order and part, the field in question, the value in the order, the observed value and its evidence references. The clarification type (site, laterality, orientation/marking, biopsy method, identity conflict, missing container, possible related orders). The office's contact **role** and channel from the directory. The lab's message template. |
| **Allowed tools** | Read the discrepancy record, the template and the office directory entry (all read-only). No send tool. |
| **Outputs** | (1) A draft question for the secure case view, which may contain case identifiers. (2) A **generic notification text with no patient information**, pointing an authorized recipient to the secure case view (the demo's text: "Lumen Bay Dermatopathology has a specimen question (CLR-0457). Please open the secure case view to respond. [SIMULATED — not sent]"). (3) The list of facts it used, each linked to evidence. (4) Unresolved items, e.g. *office contact role unknown*. |
| **Owner** | Reviewer of the draft: the clarification's lab owner (an accessioner in the demo). Reviewing the office's answer and resolving the clarification: accessioning lead or supervisor. Escalation and configuration: accessioning lead (Kim Nguyen in the demo). |
| **Timeout** | 15 seconds. |
| **Retry** | One automatic retry after a temporary failure if the discrepancy record has not changed. Repeat clicks return the existing draft for the same record version. |
| **Review requirement** | A person edits and approves the text. **Sending is a separate human action** and, in the demo, is simulated and labeled "Simulated: no real message sent." A drafted message does not change the task to *sent*, and a sent message does not make the task *answered* or *resolved*. |
| **Audit events** | run requested, run completed / failed / timed out, draft created, draft edited, draft approved for sending (by whom), draft discarded. |
| **Failure mode** | The standard template is shown with fields filled by plain code from the discrepancy record, or the person writes the message. The clarification task works the same either way. |
| **Prompt-injection handling** | Text copied from an order or requisition is quoted as data. Recipients and channels come **only** from the office directory, never from document text. The drafter cannot add recipients, change priority, change the task owner or alter states. |
| **Must never** | Invent an office answer; suggest which value is correct; imply the specimen is acceptable; put patient details into the generic notification; mark the task sent, answered or resolved. |

---

### A3. Case operational history summarizer

| | |
|---|---|
| **Purpose** | Give a quick, readable account of what has happened operationally to one case, with links to the underlying events. |
| **Trigger** | A person opens **Summarize history** on `/cases/[id]`. The result is reused until new events arrive for that case. |
| **Inputs** | This case's recorded events (local task events and source-system integration events) with their IDs, times, actor roles and types; the current statuses already computed by rules; the last successful source sync time. |
| **Allowed tools** | Read events and computed statuses for **this case only** (read-only). |
| **Outputs** | An "as of" time and data age; a short list of statements, **each linked to one or more event IDs**; a list of gaps stated as unknown (for example, "No EMA acknowledgement recorded yet for Part A gross entry"). Counts and times are copied from computed values, not calculated by the assistant. |
| **Owner** | Reader: anyone allowed to view the case. Configuration owner: operations supervisor. |
| **Timeout** | 15 seconds. |
| **Retry** | One automatic retry after a temporary failure. Cached by the latest event included, so repeat views do not rerun it. |
| **Review requirement** | Informational only. It proposes no changes. Labeled "Summary: check the linked events." It is not an official record and is not clinical content. |
| **Audit events** | run requested, run completed / failed / timed out, statements dropped by validator (no valid event link). |
| **Failure mode** | The full event timeline on the case page is always available; the summary panel shows "Summary unavailable." |
| **Prompt-injection handling** | Event data can include imported text (for example a simulated office answer). It is treated as quoted data. Any statement that does not link to a real event for this case is dropped. |
| **Must never** | Restate or infer diagnoses; describe something as complete, verified or entered unless a recorded event says so; fill gaps with assumptions. |

---

### A4. Pending handoff summarizer

| | |
|---|---|
| **Purpose** | Summarize what is waiting, on whom, and since when, for a supervisor or at shift change. |
| **Trigger** | A person clicks **Summarize pending handoffs** on `/operations`. |
| **Inputs** | A snapshot produced by fixed database queries: open holds, clarifications by state and age, routing exceptions, grossing records awaiting review or EMA entry, print jobs with unknown outcome, tray discrepancies, overdue retrievals, source sync status and data age. Each item carries its record ID and current owner. Free-text fields (question and answer text) are left out by default. |
| **Allowed tools** | Read that snapshot (read-only). |
| **Outputs** | An "as of" time with a **stale-data warning** if the source is offline or old; items grouped as *blocked*, *waiting on*, *owner*, *since*, each linked to its record; "observed bottlenecks" stated only as counts taken from the snapshot (for example, "3 clarifications waiting on an office reply for more than 2 hours"). Demo data is labeled illustrative. |
| **Owner** | Operations supervisor (Tanya Brooks in the demo). |
| **Timeout** | 20 seconds. |
| **Retry** | One automatic retry after a temporary failure if the snapshot has not changed. |
| **Review requirement** | Informational only. Every number must match the snapshot and every linked record must exist; anything else is dropped. |
| **Audit events** | run requested, run completed / failed / timed out, statements dropped by validator. |
| **Failure mode** | The operations table, built by fixed queries, stays fully usable; the summary shows "Summary unavailable." |
| **Prompt-injection handling** | Only structured fields are passed in by default, which removes most imported text. Any text included is quoted as data. |
| **Must never** | Rank or blame individual staff; claim causes it cannot see in the data; present stale data as live; present demo numbers as real-world results. |

---

## 5. Untrusted text and prompt injection

*Prompt injection* means hiding instructions inside a document, hoping an AI will obey them. Requisitions, transcripts, order notes and office replies all come from outside the lab's control, so the system treats them as **data only**:

- **Permissions are fixed in code.** Each assistant's tools are set by its definition above. Nothing in a document, transcript or message can add a tool, change a role, raise permissions, change a recipient or approve anything.
- **Imported text is clearly separated** from the assistant's own instructions and is always presented as quoted material.
- **Output is checked, not trusted.** Only allowed fields are kept; every evidence quote must exactly match the source; every summary statement must link to a real event or record in scope; numbers must match computed values.
- **Suspicious text is shown, not followed.** If a document contains instruction-like text, the reviewer sees a flag pointing to it. The flag does not block the manual workflow.
- **Roles come from the application.** The demo role selector is not production authentication, and server-side role checks still apply to every human action that follows a proposal.

---

## 6. Common audit events

Every assistant run writes to the local append-only audit log (a local log, not proof of production tamper resistance). Each entry records: assistant and engine (deterministic rules version or model name), the exact input records and versions, who triggered it, the request key used to prevent duplicates, start and end times in UTC, and the outcome. The event names below are descriptive; the implementation may name them differently.

| Event | When |
|---|---|
| Run requested | A person triggers an assistant |
| Run completed | Output passed validation and was stored |
| Run failed / timed out | Provider error, timeout or unavailable engine |
| Output rejected by validator | Disallowed field, mismatched evidence quote, unlinked statement or wrong number |
| Instruction-like text flagged | Source text looked like commands |
| Proposal created | A proposal set or draft was stored |
| Value accepted / edited / rejected | A person reviewed one proposed value or draft |
| Proposal superseded | The source document or record changed after the proposal was made |

---

## 7. Failure behavior at a glance

| Situation | What the person sees | What still works |
|---|---|---|
| Assistant turned off or no model configured | Demonstration engine label, or "Not configured" | Everything; fields are typed by hand |
| Timeout or provider error | "Unavailable: continue manually"; one automatic retry has already been tried | Manual entry, template message, full event timeline, operations table |
| Output fails validation | "No usable proposal"; the reason is logged | Manual path |
| Source document changed after the proposal | Proposal marked superseded; it cannot be accepted | Run again on the new version, or enter manually |
| Source system offline | Stale-data warning with last successful sync time | Local tasks; nothing is shown as live |

---

## 8. If a real model is configured later

- It is **off by default**. Turning it on is an administrator setting shown on `/settings` (integration capabilities), together with the provider name.
- Before any non-synthetic data is used, the organization's privacy/security, IT and clinical owners must approve the provider, hosting, data handling and contracts. Adding a model does not make the system compliant or clinically validated.
- Only the minimum input listed for each assistant is sent.
- All the rules above still apply: read-only tools, proposals only, evidence spans, no confidence percentages, validation of output, human review, audit.
- Real-model output is labeled with the provider name and never presented as the deterministic demonstration, and vice versa.

---

## 9. Terms

| Term | Plain meaning |
|---|---|
| Deterministic | Same input always gives the same output; no AI model involved |
| Evidence span | The exact piece of source text (with its position) that a proposed value came from |
| Unresolved field | A field the assistant could not fill safely, with the reason |
| Proposal | A suggestion that changes nothing until a person accepts it |
| Validator | Plain code that checks the assistant's output before it is shown or stored |
| Timeout | The longest the system waits before giving up and showing the manual path |
