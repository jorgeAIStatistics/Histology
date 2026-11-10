# Privacy review: patient identifiers on screens, in exports, logs and the audit trail (Stage 6, Phase C4)

*Design and implementation record, 2026-10-19, branch `stage-6-production-foundation`. Synthetic data only, localhost only. Nothing here is a compliance claim. No statement in this document says or implies that the application meets HIPAA, CLIA, CAP, FDA or any other regulation or accreditation requirement. A privacy review by the laboratory's privacy officer is still required before any real data is loaded.*

"Patient identifiers" here means the three identifiers this application holds: **patient name, date of birth and MRN**. The application also holds case numbers (accession numbers), provisional intake IDs, order and encounter IDs, office names and clinical sites. Those are linked to a patient and are treated as controlled data, but this phase does not remove them: they are the references every screen uses instead of names.

## 1. The rule used for every decision

1. **Positive specimen identification** means matching material (bottle, cassette, slide) to the right patient with at least two identifiers. Where a screen is used for it (intake, the clarification of an identity question, grossing), its identifiers stay. **Nothing that serves positive identification was masked in this phase**, because masking without a validated workflow could cause a misidentification. Those cases are recorded below as decisions for the laboratory, not changed.
2. **Where identification is not the task**, the screen shows case, intake, hold and clarification references instead of names. That applies to Operations, Insights, `/audit`, and the laboratory administrator and auditor views. Each was implemented and tested in this phase.
3. **The audit trail does not duplicate identifiers** (section 3). The records keep them, and the screens that need them read them from the records.

## 2. Screens

Legend for "Needed for positive identification": **Yes** means the task compares material against the patient; **No** means the task manages flow, measures or verifies something else.

### Intake (`/intake`)
| Identifying fields shown | Needed for positive identification | Decision |
|---|---|---|
| Queue row: patient name per provisional item. Identity band: name as written on the bottle and on the order, date of birth, MRN with its source tenant. Evidence sheet: order, bottle and requisition values side by side (name, DOB, MRN). Source-conflict dialog: the details on file (name, DOB, MRN). Related orders: MRN and tenant in the reasons. | **Yes**: accessioners verify each container against the order (two identifiers), and the lead reviews identity and source conflicts. | **Kept, unchanged.** The queue's patient name is a candidate for minimisation (the INT id could lead) **only after** the laboratory validates a workflow that identifies the item by INT id plus a second identifier. Recorded, not changed. |

### Clarify (`/clarifications`)
| Identifying fields shown | Needed | Decision |
|---|---|---|
| Record header: patient name, MRN and tenant. Evidence table: order and observed values (name, DOB or MRN for identity questions). Question and office answer: free text that can quote identifiers. | **Yes** for identity questions: the lead decides which identifiers are right. **No** for other categories (laterality, site, missing container), which still show the header. | **Kept.** The notice sent to the office (simulated) is already generic: sending is refused when it quotes the linked patient's identifiers (`patientIdentifiersIn`, Stage 5). The header for non-identity questions is a minimisation candidate. Recorded, not changed. |

### Gross (`/grossing`)
| Identifying fields shown | Needed | Decision |
|---|---|---|
| Identity bar: patient name, MRN and tenant, with the case number and part. No date of birth. | **Yes**: the grosser confirms the container in hand against the case before cutting (name plus MRN, or name plus case number). | **Kept, unchanged.** |

### Worklist (`/worklist`)
| Identifying fields shown | Needed | Decision |
|---|---|---|
| Grid: case number, provisional ID, parts, stages, holds; **no patient column**. Side panel of the selected row: patient name and MRN with its tenant. The page data for every listed row includes the patient label and MRN label (in the page's data, not displayed until a row is opened). | Partly: the panel is used to pull and check material, so a second identifier helps. The grid is flow. | **Kept.** Two candidates are recorded: send the patient label only for the opened row, and decide whether the panel needs the name at all. Neither was changed: the worklist is shared by grossing, histotech and pathologist workflows that were not re-validated in this phase. |

### Materials (`/materials`: print, trays, retrieval)
| Identifying fields shown | Needed | Decision |
|---|---|---|
| Case numbers, block and slide identifiers, label payloads (`D26-04817 A1-2 PAS`), printer and tray IDs. **No patient name, DOB or MRN.** | Identification is by case and label identifier (scan against the record). | **No change needed.** |

### Operations (`/operations`)
| Identifying fields shown | Needed | Decision |
|---|---|---|
| **Before this phase:** free text could quote identifiers. Hold reasons quoted bottle and order values ("Date of birth: order 1972-06-14, observed 1972-04-16"). Source-conflict task titles quoted names, birth dates and MRNs. Scope and subject labels typed by staff could name the patient. **Now:** hold, clarification, intake, case and order references; patient identifiers replaced by `[patient name]`, `[date of birth]`, `[MRN]`. | **No**: Operations shows what is blocked, who owns it and for how long. | **Minimised (implemented).** `getOperations` passes item, subject, "blocks" and next-step text, and the handoff lines, through two redactors: (1) for each row, the linked patient's identifiers (name forms, birth-date formats, MRN, what each imported version of their orders said, what their bottles say); (2) for every row, all patients' birth dates, MRNs and full names. Single name tokens are applied per row only, because a lone given or family name can also be a staff member's or office contact's (the synthetic seed has such pairs). Staff names (owners) are never touched. Test: `tests/domain/privacy.test.ts`. |

### Case (`/cases/<accession>`)
| Identifying fields shown | Needed | Decision |
|---|---|---|
| Identity bar: patient name, MRN, tenant. The page data also carries the date of birth (not displayed). History (intake item and case): each event's summary and recorded values; since this phase, a patient reference audited as `{ id, fingerprint }` is shown **with the details from the patient record itself**, only while the record still matches the audited fingerprint. | **Yes**: the case page is where a pathologist or lead confirms they are on the right patient. | **Kept.** Candidate: drop the unused date of birth from the page data. Recorded, not changed (case screen code is outside this phase's file ownership). |

### Insights (`/insights`)
| Identifying fields shown | Needed | Decision |
|---|---|---|
| Aggregates (medians, counts, ages) and record references (CLR, PJ, TRY, RR, WO, case plus part). **No patient identifiers.** | **No.** | **No change needed; tested** (`privacy.test.ts`: none of the patients' names, birth dates or MRNs appear in its output). |

### Presenter console (`/demo`)
| Identifying fields shown | Needed | Decision |
|---|---|---|
| World events list: intake ID with the (synthetic) patient name. The Operations summary in the console now uses the minimised Operations data. | Not a laboratory screen. | **Kept.** The console exists **only in synthetic demo mode** (404 in secured and locked builds, Phase B). It never shows real data. |

### Audit report (`/audit`)
| Identifying fields shown | Needed | Decision |
|---|---|---|
| Chain status, counts, `seq` numbers, key id, anchors, first problem (kind and `seq`). The evidence download: `seq` ranges, MACs, the key id, anchors. **No event content.** | **No.** | **No change needed; tested**: the report and the evidence contain no patient identifier and no case, intake, order or clarification reference. |

### Laboratory administrator and auditor views
| Identifying fields shown | Needed | Decision |
|---|---|---|
| `/audit` only. Every bench screen answers `/forbidden` (Phase B); `/api/live` answers 403 with no data; the CSV export answers 403. | **No.** | **No change needed; tested** for the export route (403, nothing recorded) and the audit report. |

### Plain authentication pages (`/signin`, `/signed-out`, `/locked`, `/no-access`, `/forbidden`)
| Identifying fields shown | Needed | Decision |
|---|---|---|
| None: no patient, case, staff or count. They render without the application shell. | **No.** | **No change needed** (Phase B tests). |

### Lock screen (and the "Signed out" / "Session ended" screens in a tab)
| Identifying fields shown | Needed | Decision |
|---|---|---|
| None. The page content is unmounted, and the inline page-data scripts are removed from the DOM. | **No.** | **No change needed.** Covered by the secured browser suite (section 5). |

### Print (worklist paper copy)
| Identifying fields shown | Needed | Decision |
|---|---|---|
| Case numbers, provisional IDs, parts, stains, hold IDs and scopes (not hold reasons), owners. **No patient name, DOB or MRN.** | **No** (a downtime list of work). | **No change needed.** The paper copy is still a controlled document: it carries case numbers. |

### CSV export (`POST /api/worklist/export`)
| Identifying fields shown | Needed | Decision |
|---|---|---|
| Case numbers, provisional IDs, parts, stages, stains, **hold reasons** (which can quote label values, for example a date of birth), owners, offices, clinicians. No patient name column. | **No** (a downtime fallback). | **Controlled (implemented).** (1) Access: the route requires `view.worklist` (the one guard), and the command `worklist.snapshot` requires the `worklist.snapshot` permission; the administrator and the auditor get 403 and nothing is recorded. (2) Audit: every export is a `worklist.snapshot` event (who, version, row count, data age, filters). (3) **A new header line** in the file itself, the last `#` line before the column names: `# CONTROLLED DOCUMENT: contains patient identifiers (case numbers, provisional intake IDs, hold reasons that may quote label details). Store and share only as your laboratory's policy allows; delete it when the downtime ends. Recorded as snapshot SNAP-nnnn.` Tests: `privacy.test.ts`. **Limitation:** the application cannot control the file after download (the Downloads folder, e-mail, a USB stick). |

Not in the list but checked: **Settings** shows office contacts (fictional staff of offices, not patients) and the integration log. The integration log's `detail` text quotes what the source sent (for example "MRN 447902 is on file with different details (name …; date of birth …)"). It is the record of what was received, not the audit trail, and the source-conflict browser tests assert it. Recorded as a minimisation candidate: supervisors use it to diagnose imports, and it was not changed.

## 3. The audit trail (C4.1)

**Rule:** `audit_event.summary`, `before_json` and `after_json` never contain a patient's name, date of birth or MRN. They record **field names, record ids and fingerprints**. The records keep the values.

**Fingerprint:** `HMAC-SHA256(K, scope + "\n" + normalized value)`, first 16 hex characters, where `K = HMAC-SHA256(audit key, "hlos-audit-fingerprint/v1")` (`src/server/domain/privacy.ts`).
- **Scope.** The scope names the record and field (`patient_ref:<id>`, `container:<id>:birth_date`, `clarification:<id>:Date of birth:order`). The same value on two records, or in two columns, gives different fingerprints, so fingerprints cannot be joined across records.
- **Normalization:** NFKC, lower case, spaces collapsed.
- **What equal fingerprints prove.** Two fingerprints with the same scope are equal exactly when the values were equal (up to a 64-bit collision). This is how the source-conflict review still proves that the details on file did not change.
- **No audit key.** In a locked build with no `HLOS_AUDIT_KEY`, a value is recorded as `withheld` with no fingerprint.

**Changed events:**
| Event | Before | Now |
|---|---|---|
| `source_conflict.reviewed` | A full patient snapshot (tenant, MRN, family and given name, birth date) before and after. The task title, which quotes the differing details. | `patientRef: { id, fingerprint }` before and after. `patientRefUnchanged` is computed in memory from the actual rows and requires equal fingerprints. The task is recorded by id, kind, status and version, without its title. |
| `intake.observation_recorded` | The bottle's values before and after, for every changed field | Name, DOB and MRN as `withheld (fingerprint …)`. Other fields (site, laterality, procedure, part, collection date) as written. |
| `intake.container_discrepancy` (summary) | `Date of birth: order "…", bottle "…"` | `Date of birth: order and bottle differ` (other fields keep their values) |
| `intake.discrepancy_accepted` (summary) | The order and bottle values | Identity mismatches cannot be accepted (Stage 5 rule); for safety the summary would name the field only |
| `clarification.created` | The evidence values, and the question | Identity evidence values withheld with fingerprints. Other evidence values and the question pass through the redactor. |
| `clarification.sent` | The question and the notice | Both pass through the redactor |
| `clarification.answered` (summary) | The first 140 characters of the answer | The same, with the linked patient's identifiers replaced first |
| `hold.placed` (summary) | The hold's reason, which for an identity question quoted both values | An identity question's hold is summarized as `Date of birth: order and observed values differ (CLR-…)`. Every hold summary passes through the redactor. The hold record keeps its reason. |
| `integration.order_level_change_review` | The summary and `changes` quoted the MRN, name and birth-date values | Field names only (`patient MRN (order stays linked to the original patient)`, `patient name, date of birth (…)`). Office, encounter and provider changes keep their values. The task keeps both values. |
| `task.claimed`, `task.reassigned`, `task.released` (summary, in `src/server/commands/worklist.ts`) | The task title | The title with the task's patient identifiers replaced |
| Seed `clarification.created` (synthetic history, `src/server/seed/scenario.ts`) | `CLR-0453 created: <question>` (the question quoted both birth dates) | `CLR-0453 created: identity conflict question on <subject> (the question is on the clarification record)` |

**History still reads sensibly.** The intake item and case History show recorded values. An observation edit reads `birth date: withheld (fingerprint 3f…) → withheld (fingerprint 9c…)`, so the reader sees that the value changed. The values themselves are on the container record, and the Intake screen shows them. For a source-conflict review, History shows the details **from the patient record itself**, while the record still matches the audited fingerprint. Otherwise it says the details are not shown and why. The audit row is never changed.

**Redactor** (`redactIdentifiers`, `redactForRecord`). It replaces the linked patient's identifiers with `[patient name]`, `[date of birth]` and `[MRN]`:
- name forms: "Family, Given", "Given Family", and each name of two or more letters (family) or three or more (given);
- the birth date in ISO and common US formats;
- the MRN with digit boundaries;
- what each imported version of the patient's orders said about them;
- what the patient's bottles say.

**Limitations:**
1. **Free text typed by people stays in the person's words.** `audit_event.reason` is stored as typed, which is pinned by a test. So are other notes copied into summaries (for example a discrepancy closing note). A reason that quotes a birth date keeps it.
2. The redactor is **best effort**. It finds only the identifiers it knows, in the formats above. A misspelled name, a nickname, a date written "June 14, 1972", or an identifier of a patient not linked to the record is not found.
3. A fingerprint is not encryption. Anyone who holds the audit key can test guesses, and a date of birth has only about 40,000 plausible values. In the demo the key is public. Fingerprints keep identifiers away from people who read the trail **without** the key: auditors, evidence files, exports of the trail.
4. **Patient reference ids** are recorded in audit payloads. The **synthetic seed** builds them from the MRN (`pt_ema_447902`). The importer creates opaque sequence ids (`pt_000123`), which is tested. A real deployment must never derive record ids from identifiers. The scan test masks patient reference ids for this reason.
5. **Events written before this phase** keep what they recorded. The audit trail is append-only, and nothing rewrites history. A database created before Phase C4 still holds identifiers in its older events.
6. Case numbers, intake ids and order ids remain in audit payloads. They are the references.

**Test:** `tests/domain/audit-phi.test.ts`. On the seeded day it runs:
- every guided demo step in rehearsal mode (as Tanya Brooks);
- an identity flow on a bottle: typed label, verification, an identity clarification with evidence and a hold, an answer that quotes the identifiers, review, resolution and hold release;
- a patient-level and an order-level source conflict: import, claim, release and review.

It then scans every audit row's summary, `before_json` and `after_json` for every `patient_ref` family name, given plus family name, MRN and birth date, plus the other values the source and the bottle gave. It finds none. A control case shows the scan does find each kind when one is written.

How the offenders were found:
- **By a probe.** During development, a probe with the same needles on the code before these changes found identifiers in six kinds of event: `clarification.created`, `hold.placed`, `intake.container_discrepancy`, `intake.observation_recorded`, `integration.order_level_change_review` and `source_conflict.reviewed`. It also found them in the seed's `clarification.created` summary.
- **By reading the code.** The task-claim summaries, `clarification.sent` and `clarification.answered` were found this way: they copy titles and free text. The probe's flows did not exercise them with identifiers. The test now does.

## 4. Logs and error responses (C4.2)

- **Structured logger** (`src/server/core/log.ts`). Each event is one JSON line: `ts`, `level`, `event`, `correlationId`, then safe fields. Field values are kept only when they are primitives; objects and arrays are never serialized. Field names are redacted by kind:
  - secrets: secret, token, password, authorization, cookie, session id, nonce, verifier, `*Key`;
  - patient details: patient, name, birth, dob, MRN, label;
  - request or record content: body, payload, input, before, after, evidence, question, answer, note, reason, summary, detail, text, value, headers, query, data.

  Strings are scrubbed of Bearer and Basic credentials, JWTs, cookie and query pairs (`hlos_session=…`, `code=…`, `state=…`), JSON secret members, long hex and base64 runs, dates without a time (a birth date looks like one) and runs of 6 or more digits (an MRN looks like one). Then they are cut to 200 characters. An error is reduced to its name, a code, a scrubbed message and the first project stack frame's `file:line`, never the stack text.
- **Call sites replaced.** Every `console.error` and `console.warn` in `src/server/**` and `src/app/api/**` now goes through the logger: 17 call sites. A test fails if a `console.*` call comes back there.

  | File | Event |
  |---|---|
  | `src/server/commands/registry.ts` | `command.unexpected_error` |
  | `src/server/core/idempotency.ts` | `receipts.maintenance_failed` |
  | `src/server/auth/audit.ts` | `auth.audit_failed` |
  | `src/server/auth/flow.ts` | `auth.callback_without_transaction` (warn) |
  | `src/server/domain/sourceImport.ts` | `import.unexpected_error`, `import.receipt_log_failed` |
  | `src/server/sim/pump.ts` | `pump.failed`, `pump.source_failed`, `pump.maintenance_failed`, `pump.delivery_failed` |
  | `src/server/queries/operations.ts` | `operations.count_failed` |
  | `src/server/queries/insights.ts` | `insights.work_age_failed` |
  | `src/app/api/demo/reset/route.ts` | `demo_reset.remove_failed`, `demo_reset.failed` |
  | `src/app/api/audit/verify/route.ts` | `audit_verify.failed` |
  | `src/app/api/live/route.ts` | `live.pump_failed` |
  | `src/app/api/test/fixtures/route.ts` | `test_fixtures.failed` | Page components (`src/app/*/page.tsx`) still use `console.error` for load failures. They log the error object, not a request body, but they are outside this phase and recorded as a follow-up.
- **Error responses.** An unexpected error in a command used to return its raw message (for example, a JSON parse error quotes the text it read). It now returns `The request could not be completed because of an unexpected error on the server. Nothing was changed. Reference: <correlation id>.` The details go to the log line with the same correlation id.
  - The demo reset's failure no longer echoes the error either.
  - Bodies that are not JSON are refused with a fixed message.
  - Next.js production builds do not send stack traces.
  - Domain errors keep their deliberate, user-facing messages. These can name records, for example "Staff member X was not found".
- **Limitation:** a person's name inside an error message cannot be recognised by pattern. Call sites pass ids, codes and counts, never payloads.

## 5. Shared workstation (C4.4)

- **Covered before this phase** by the secured browser suite (`tests/e2e-secured/auth.spec.ts`). After Lock, the serialized DOM (scripts included) holds no patient name, birth date or MRN of the record on screen, and no operator, case or office. Back and Forward after a lock show the lock screen and no data. Pages are `Cache-Control: no-store`. After sign-out the old cookie gets 401 and Back shows no data. A server-revoked session removes the content at once.
- **The gap found and closed in this phase.** A **second tab** of the same browser was not checked on sign-out. The client broadcasts the sign-out to the other tabs, but no test showed that those tabs drop the patient. New test: after sign-out in one tab, the other tab shows "Signed out" within 3 s, with its own server checks cut off, and its DOM holds none of the patient, case or operator details.
- **History:** URLs carry only display ids (`/intake?item=INT-…`, `/clarifications?selected=CLR-…`, `/cases/D26-…`), never names, birth dates or MRNs.
- **Not covered by the application.** These are deployment controls:
  - the browser's own form history and autofill: bench fields that take bottle identifiers do not set `autocomplete="off"`, a recommended follow-up;
  - downloaded CSV files left in the Downloads folder;
  - the print spooler;
  - operating-system screenshots;
  - the browser profile itself.

  Use a managed kiosk profile that clears data on sign-out.

## 6. Files

- **Implementation:** `src/server/domain/privacy.ts` (fingerprints, redaction, History values), `src/server/core/log.ts`.
- **Audit payload changes:** `src/server/domain/{sourceConflict,intake,clarification,holds,sourceImport}.ts`, `src/server/commands/worklist.ts`, `src/server/seed/scenario.ts`.
- **History read models:** `src/server/queries/{intake,case}.ts`.
- **Operations minimisation:** `src/server/queries/operations.ts`.
- **CSV control notice:** `src/app/api/worklist/export/export-csv.ts`.
- **Tests:** `tests/domain/audit-phi.test.ts`, `tests/domain/log.test.ts`, `tests/domain/privacy.test.ts`, and one test in `tests/e2e-secured/auth.spec.ts`.
