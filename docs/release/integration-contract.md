# Source integration contract `hlos.source-message` 1.0 (Stage 6, Phase D)

*Design and implementation record, 2026-10-19, branch `stage-6-production-foundation`. Synthetic data only, loopback only. Every source system here is a **simulator**; nothing has been connected to, contracted with or tested against a real laboratory, EHR or LIS interface. Nothing here is a compliance claim.*

## 1. Summary, and the limits first

- This is a **stand-in** for a real interface. A hospital interface engine would much more likely deliver HL7 v2 over MLLP, or FHIR over HTTPS, inside a VPN or with mutual TLS. The HMAC-signed JSON POST below exists so the boundary (authentication, versioning, de-duplication, ordering, error replies, backlog after an outage) can be specified and tested end to end without a real counterpart.
- The inbound endpoint **exists only** in the synthetic demo mode with `HLOS_INTEGRATION_SIMULATOR=1` and a simulator root secret (`HLOS_INTEGRATION_SIM_SECRET`, at least 32 characters). In `secured` and `locked` builds, with the switch off or without the secret, every request gets the same `404` as an unknown path. It accepts only integration sources whose adapter is a simulated source-system adapter (`simulated_ema`, `simulated_other_ehr`). It cannot receive data from a real system, and the simulator cannot send anywhere but loopback.
- There is **one mapping and one validation path**. The HTTP endpoint and the in-process demo pump both call `handleEnvelope` (`src/server/integration/inbound.ts`), which calls the existing importer `importSourceMessage` (`src/server/domain/sourceImport.ts`). No second order or specimen model exists. The existing rules still decide: duplicates, the failure queue, stale versions, source-conflict reviews, correction reviews for issued parts, and holds.
- **A message never changes an issued identity.** It never issues, adopts or renumbers an accession, never relinks an order to another patient, and never changes an issued part's site, laterality or procedure. Differences are recorded and sent to a person (review task or correction review). The database triggers `accession_number_immutable`, `accession_patient_immutable` and `specimen_part_identity_immutable` back this up.

| Piece | Where |
|---|---|
| Contract (envelope, signature, payload schemas, replies) | `src/server/integration/contract.ts`, `accession-schemas.ts`, `errors.ts` |
| Inbound boundary and the one mapping (`handleEnvelope`) | `src/server/integration/inbound.ts`; route `src/app/api/integration/inbound/route.ts` |
| Accession messages, processed inside the importer's pipeline | `src/server/integration/accession-messages.ts` (dispatched from `importSourceMessage`) |
| In-process pump, now through `handleEnvelope` | `src/server/sim/pump.ts` |
| Source simulator and its 12 scenarios | `src/server/integration/simulator.ts`, `in-process.ts`; CLI `scripts/integration-sim.ts` |
| Reconciliation read model | `src/server/integration/reconciliation.ts`; `GET /api/integration/reconciliation` |
| Contract tests | `tests/contract/*.test.ts` (73 tests) |

## 2. Source identity

- Each source is a row in `integration_source`: `src_ema` (EMA-SIM, tenant `ten_ema`, also the **only** issuer of accession numbers) and `src_oth` (OTHER-EHR-SIM, tenant `ten_oth`).
- The sender names itself twice: the `X-HLOS-Source` header selects the key that verifies the signature, and the envelope's `source_id` must equal it (`401 source_mismatch` otherwise). A source id that is unknown, or whose adapter is not a simulated source-system adapter (a printer or notification connector, or any real adapter), is `401 unknown_source`.
- Every identifier a source sends lives in **its tenant's namespace**. `ORD-1` from `src_ema` and `ORD-1` from `src_oth` are different orders. An MRN is a key only together with its tenant. A name is never a key.

## 3. Transport

- `POST /api/integration/inbound`, `Content-Type: application/json`, one message per request, at most 256 KiB (`413` above; `415` for another media type). Other methods: `404`.
- The simulator talks plain HTTP to loopback (`localhost`, `127.0.0.1`, `::1`) and nothing else; it never follows a redirect. A real deployment would terminate TLS (or use mTLS) in front of the application.

## 4. The envelope and the message types

```json
{
  "contract": "hlos.source-message",
  "contract_version": "1.0",
  "source_id": "src_ema",
  "message_id": "ORD-77150#v2",
  "message_type": "order.amend",
  "sent_at": "2026-10-14T14:40:00Z",
  "correlation_id": "ema-tx-000000042",
  "payload": { "…": "per message_type" }
}
```

| Member | Rule |
|---|---|
| `contract` | `"hlos.source-message"`; another value is `422 unsupported_contract` |
| `contract_version` | `MAJOR.MINOR`; major must be `1` (else `422 unsupported_contract_version`) |
| `source_id` | The sending source; must equal `X-HLOS-Source` |
| `message_id` | Stable and unique **per source**, 1 to 128 characters (`A-Z a-z 0-9 . _ : # / @ + -`). The de-duplication key. A retry re-sends the same id. |
| `message_type` | One of the six types below |
| `sent_at` | The **source's claimed event time**, ISO 8601 with a zone (`Z` or `±hh:mm`) |
| `correlation_id` | Optional, 8 to 100 characters. Becomes the correlation id of every local audit event the message produces, so one source transaction can be followed across systems and across retries. |
| `payload` | A JSON object, validated per type (section 9) |

Each type maps onto an existing domain function. Nothing new decides anything.

| `message_type` | Payload schema | Maps onto | What it does here |
|---|---|---|---|
| `order.upsert` | `SimulatedOrderSchema` (full order snapshot with `version`) | `importSourceMessage` | Unknown order → created in the tenant. Newer version → stored, working values updated, local work reconciled (holds, re-check tasks, stain work orders, correction reviews). Older or equal version → stale. |
| `order.amend` | same | same | Same pipeline. The type documents intent; the version decides. |
| `order.cancel` | same | same | Order and parts canceled at source; nothing is discarded. Prepared material and held items get review tasks. |
| `specimen.submitted` | `SpecimenSubmittedSchema`: the full order snapshot plus `submitted: [{designation, containers}]` | same (an order version) | The source records a specimen line, and its container count, as sent with the order. Each named line must be on the order, and its count must equal the line's `expected_containers` when given. A new line → `part_added`; after accession → a review task, no part is created. **It never marks a container as received**: receipt is a local, staff-attested event. |
| `accession.issued` | `{request_id, accession_number, namespace, source_case_id?, issued_at}` | `importSourceMessage` → `processAccessionMessage` | Compared with the local record. Match → recorded as a confirmation. Any difference, or the request is still waiting here → recorded, **not applied**, and one `source_conflict` review task (urgent, accessioning lead). |
| `accession.acknowledged` | `{request_id, accession_number?, namespace?, source_case_id?, acknowledged_at}` | same | The source confirms it holds the laboratory's request, and, once issued, which number. Recorded only; it changes no clinical state. A number that differs from the local one → the same review. |

What could **not** be mapped honestly, and is therefore not a message type:

- **Issuing a number from a message.** In this build the only issuing path is `requestAccession` → the simulated authoritative issuer (`src/server/sim/authoritative.ts`), in-process. Adopting a number from an inbound message would be a new transition (`submitted → issued` from external data) that the domain does not have, and it would bypass INV-6 ("no screen or API lets anyone type a number in as issued"). So `accession.issued` is a **comparison**, not an issuer. A real connector would need that transition designed, reviewed and tested first.
- **Specimen received at the laboratory.** Receipt, container verification and discrepancies are local, staff-attested facts (`intake.*` commands). A source can say what it sent, never what arrived.
- **Results** (`ORU`, `DiagnosticReport`). This application does not report results, and nothing here writes back to a source.

## 5. Authentication

```
X-HLOS-Source:    src_ema
X-HLOS-Signature: t=1792000000,v1=<64 hex characters>
signed string:    "<t>.<raw request body>"
v1:               hex(HMAC-SHA256(per-source secret, signed string))
```

- **Per-source secret.** `HMAC-SHA256(HLOS_INTEGRATION_SIM_SECRET, "hlos.source-message/1:<source_id>")`. One environment variable configures every simulated source; each source still signs with its own key, and one source's key cannot sign for another. A real deployment would keep an **independent** secret per source in its secret store. The root secret is never logged, returned or stored.
- **Tolerance.** `t` must be within **300 seconds** of the server's wall clock, in either direction (`401 signature_expired`). This is transport time, not the event time.
- **Constant-time comparison** (`crypto.timingSafeEqual`), computed even when the timestamp is out of tolerance or the source is unknown, so the answer time does not reveal which check failed.
- **Rotation.** The header may carry several `v1=` values; one match is enough.
- **Replay** of a captured request inside the 5-minute window carries the same `message_id`, so it is a duplicate and changes nothing.
- **Nothing is recorded** for a refused signature (`401`): no event, no receipt, no audit row. A warning log line names the source id and the reason code, never the body or the header.
- **Assumption, stated.** A real interface engine would more likely authenticate with mutual TLS or a site-to-site VPN and carry HL7 v2 over MLLP or FHIR over HTTPS. This HMAC scheme is a stand-in that is easy to test locally; it does not encrypt anything.

## 6. Versioning

- **Major** (`contract_version` `2.x`): refused, `422 unsupported_contract_version`, nothing recorded. The major is checked before the rest of the envelope, because another major may have another shape.
- **Minor** (`1.1`, `1.7`, …): accepted. **Unknown members are ignored**, in the envelope and in every payload object (no schema is strict). A minor version may only add optional members.
- **New message types** need a server that knows them. Until then an authenticated message of an unknown type is `400 unsupported_message_type` and is **kept in the failure queue**, so it can be retried after an upgrade.
- **The order's own `version`** is separate from the contract version: it is the source's version of that order (section 10).

## 7. Identifiers and relationships

| Identifier | Scope | Notes |
|---|---|---|
| `message_id` | per source | De-duplication key; the same for every retry of one message |
| `order_id` | per tenant | `source_order.source_order_id`; with `version`, the order's history (`source_order_version`, immutable) |
| part `designation` (`A`, `B`…) | per order | The office's own letter; kept as `original_designation` on an issued part even when the accession gives another letter |
| `patient.mrn` | per tenant | `patient_ref` key `(tenant, MRN)`; name and birth date are compared, never used to match |
| `request_id` (`AR-0001`) | the laboratory's | The accession request the laboratory sent (placer reference); an unknown id is `400 unknown_reference` |
| `accession_number` + `namespace` | the issuer's | Unique only within its namespace (`EMA-SIM DERM`) |

Case, order and part: an **accession** (case) holds **specimen parts**; each part comes from one **order part** of one **source order**. One accession may hold parts from several orders (a related-order decision a lead approved), and one order's parts never move to another case. A message never creates, merges or splits a case: it states what the source holds, and the laboratory's records say what was received, verified and issued.

## 8. Event time and receipt time

- `sent_at` (the source's claim) is stored as `integration_event.source_updated_at`.
- `received_at` is always the **local** clock (the demo clock in this build), stored as `integration_event.received_at` and returned in the ACK.
- The order's own `updated_at` stays on the order (`source_order.source_updated_at`, `source_order_version.source_updated_at`). When the two differ, both are kept.
- The signature timestamp is transport time and is not stored.
- The reconciliation view shows the source's event time and the local receipt time side by side for every row.

## 9. Replies and errors

Order of checks: gate → size and media type → source and signature → envelope (JSON, contract, major, members) → envelope `source_id` equals the signer → the source is not set offline → **one immediate transaction**: the importer's pipeline (duplicate → payload → stale → applied).

| HTTP | `status` | When | Recorded? |
|---|---|---|---|
| 200 | `accepted` | Applied (a review may still have been opened for local work: `review_required: true`) | Event, receipt, audit |
| 200 | `duplicate` | `message_id` already processed for this source | Receipt count, receipt, audit |
| 200 | `stale` | `version` not newer than the stored one | Event (`stale_ignored`), receipt, audit |
| 200 | `conflict_review` | Recorded but part of it **held back** for a person: patient or order-level details differ, an issued part differs (correction review), same version with different content, an accession notice that does not match | Event, review task or correction review, audit |
| 400 | `rejected` | Invalid data: `errors: [{path, code, message}]`, e.g. `payload.patient.birth_date` `required` | **Kept in the failure queue** (`outcome = failed`), retryable |
| 400 | `rejected` | Invalid JSON or envelope (no trustworthy `message_id`) | Nothing (log line only) |
| 401 | `rejected` | `signature_missing`, `signature_malformed`, `signature_expired`, `signature_invalid`, `unknown_source`, `source_mismatch` | Nothing |
| 404 | (not found) | Endpoint disabled, or a method other than POST | Nothing |
| 413 / 415 | `rejected` | Body too large / not JSON | Nothing |
| 422 | `rejected` | `unsupported_contract`, `unsupported_contract_version` | Nothing |
| 500 | `failed` | Received but processing failed (`processing_failed`, e.g. the demo's "fail next message" control); `Retry-After: 30` | Kept in the failure queue; a re-send applies it |
| 503 | `unavailable` | `busy` (database locked; `Retry-After: 2`) or `source_offline` (the source is set offline here; `Retry-After: 30`) | Nothing (the transaction rolled back, or never started) |

ACK body: `{ status, receipt_id, received_at, message_id, outcome, review_required, correlation_id }`. `receipt_id` is the stored message's id, the same for every re-delivery of one `message_id`. NAKs never quote a submitted value (paths and codes only), so a reply or a log line cannot echo patient details. Payload errors come from **the same zod schema objects** the importer applies, so the NAK and the failure queue always agree.

## 10. De-duplication, ordering and reconciliation

- **De-duplication** is per `(source_id, message_id)`. A second delivery is ACKed `duplicate` and changes nothing but the receipt count. It is a duplicate **even if its body differs**: the first processed version of a message id wins, and a source that needs to send different content must use a new message id. A message that **failed** is not a duplicate: re-sending it processes it again (that is how a source retries).
- **Ordering** is by the order's `version`, never by arrival. An older or equal version is ACKed `stale` and never overwrites the stored one (`v3` then `v2` keeps `v3`). The same version with different content is `stale` too, but opens a review task (`conflict_review`).
- **Order-level identifiers** (patient, office, encounter) in a newer version are never applied silently: one `source_conflict` task for the accessioning lead, and the previous values stay in effect. Accession waits while it is open.
- **Issued parts** are compared with the issued part, not the previous order version: a difference opens one correction review and a scoped hold; a later version that matches again opens nothing new.
- **Reconciliation view** (`loadReconciliation`, read only; `GET /api/integration/reconciliation`, permission `view.operations`). For every source order linked to local work it compares the source's latest assertion with the local verified state: patient on file versus incoming details; parts and containers; site, laterality and procedure (against the issued part, or against the staff check and the version it was made against); cancellation versus work in progress; accession requested versus issued versus acknowledged. It also lists failed imports, stale-ignored messages, open source conflicts and open correction reviews. Each row carries the source's event time, the local receipt time, the work it touches (intake items, parts, holds, tasks) and the open review that covers it, with a status: `in_sync`, `review_open`, `review_closed`, `attention`, `waiting`, `failed`, `ignored`. It never returns a secret, a signature or a raw payload. It is clinical data and needs a clinical view permission.

## 11. Retry, timeout and backoff (sender side)

The simulator implements what a well-behaved source must do:

- **Per-request timeout** 5 s (`AbortSignal.timeout`).
- **Retry** on no answer (network error, timeout), `5xx`, `408`, `425` and `429`. **Never** on another `4xx`: a NAK stops retries for that message (it is in the laboratory's failure queue), and the source moves on to its next message.
- **Exponential backoff with jitter**: before attempt n+1 the delay is half of `min(8 s, 0.5 s × 2^(n-1))` plus a random share of the other half, and never less than the server's `Retry-After` (capped at 8 s). The jitter is seeded from the message id, so a run is reproducible.
- **At most 5 attempts.** A message that still has no definitive answer stays in the source's outbox (nothing is lost) and is delivered later **in order**: delivery stops at the first message that still fails, so a later version never overtakes an earlier one on the sender's side.
- Retries are safe because the receiver is idempotent per `message_id`.

## 12. The simulator and its 12 scenarios

`npm run integration:sim -- <name|number|all|list> [--url http://localhost:3100] [--in-process]`

Over HTTP, start the app in synthetic demo mode with the switch, and give both sides the same root secret:

```
export HLOS_INTEGRATION_SIM_SECRET=$(openssl rand -hex 32)
HLOS_MODE=demo HLOS_INTEGRATION_SIMULATOR=1 npm run dev     # terminal 1
npm run integration:sim -- all                               # terminal 2
```

`--in-process` runs the same checks against a fresh in-memory synthetic seed, with no server and nothing written to disk. Envelopes are deterministic: they are built from the seed's records (a fresh in-memory seed, never the app's database) and from new synthetic patients (MRNs `9901xx`), with fixed event times on the demo day. Re-running a scenario against the same app gets `duplicate` answers, which the CLI reports as a re-run rather than a failure.

| # | Scenario | Expected answers |
|---|---|---|
| 1 | `new-order` | accepted |
| 2 | `specimen-submitted`: order placed without a specimen, then `specimen.submitted` names part A | accepted, accepted |
| 3 | `multiple-specimens`: one `specimen.submitted` with parts A, B, C (C in 2 containers) | accepted |
| 4 | `amended-order`: seed order `ORD-77150` v2 changes part A's site | accepted |
| 5 | `duplicate`: the same message three times | accepted, duplicate, duplicate |
| 6 | `conflicting-identifiers`: an MRN on file with another name and birth date; an issued order id under another MRN | conflict_review, conflict_review |
| 7 | `missing-data`: no birth date, no site | rejected (paths), one attempt only |
| 8 | `out-of-order`: v1, v3, then v2 | accepted, accepted, stale |
| 9 | `delayed-ack`: the source acknowledges the laboratory's accession request late (`--request AR-0201 [--accession D26-04817] [--delay-ms 5000]`); meanwhile the reconciliation view shows the request as waiting | accepted |
| 10 | `source-outage`: the link is down (HTTP: a loopback port where nothing listens; in-process: the source set offline here, so `503 Retry-After`); the source backs off, gives up after 5 attempts and keeps both messages | undelivered or unavailable, backlog kept |
| 11 | `recovery`: the backlog is delivered exactly once, then re-sent once more | accepted ×2, duplicate ×2 |
| 12 | `unexpected-version`: contract 2.0; a version lower than stored; an unknown `source_id` | unsupported_version, accepted, stale, unauthorized |

Scenario 9 needs a laboratory request id. The simulator never invents one; without `--request` it is skipped with guidance. With `--in-process`, the CLI first runs guided-demo steps 1 to 4 (rehearsal) to request and issue the hero accession through the real commands.

## 13. Comparison with HL7 v2 and FHIR

| Concept here | HL7 v2 (ORM^O01 / OML^O21, ACK, ORU^R01) | FHIR R4 (ServiceRequest, Specimen, DiagnosticReport) |
|---|---|---|
| Source identity | MSH-3/4 sending application and facility | `MessageHeader.source`, or the client's identity |
| `message_id`, de-duplication | MSH-10 message control id (receiver de-duplicates) | `MessageHeader.id` / `Bundle.identifier`; conditional create (`If-None-Exist`) |
| `sent_at` | MSH-7 date/time of message; ORC-9 transaction date/time | `Bundle.timestamp` (messaging); `ServiceRequest.authoredOn`, `meta.lastUpdated` |
| `order.upsert` / `amend` / `cancel` | ORC-1 order control `NW` / `XO` / `CA` (also `HD` hold, `RL` release) | `ServiceRequest` create / update; `status` `active` / `revoked` / `on-hold` |
| `order_id` | ORC-2 / OBR-2 placer order number | `ServiceRequest.identifier` (placer) |
| Order `version` | None (optional sequence-number protocol, MSH-13) | `meta.versionId`; `If-Match` for ordered updates |
| Patient, MRN in a tenant namespace | PID-3 identifier with assigning authority, PID-5 name, PID-7 birth date | `Patient.identifier` (`system` = namespace) |
| Specimen line: site, laterality, procedure | SPM-8 source site, SPM-9 site modifier, SPM-7 collection method (OBR-15 before v2.5) | `Specimen.collection.bodySite` (laterality as a SNOMED qualifier), `collection.method` |
| Containers sent | SAC segment, SPM-26 number of containers | `Specimen.container[]` |
| `accession_number` | ORC-3 / OBR-3 filler order number; SPM-2 specimen id | `Specimen.accessionIdentifier`; filler `ServiceRequest.identifier` |
| ACK / NAK | ACK with MSA-1 `AA` / `AE` / `AR` (original mode), `CA` / `CE` / `CR` (enhanced accept acknowledgment); ERR segment | HTTP status and `OperationOutcome`; messaging `MessageHeader.response.code` |
| Results | ORU^R01 | `DiagnosticReport`, `Observation` (out of scope here: nothing is written back) |

What neither standard gives, so this application keeps it as local workflow, never as message semantics:

- **Container verification**: a staff member's attested check of the physical bottle against a specific order **version** (and the rule that a check made against an older version must be repeated). v2 SAC and FHIR `Specimen.container` describe containers; neither carries an attested match against the requisition.
- **Related-order decisions**: whether two orders from one visit become one accession or stay separate, decided and recorded by a lead. v2 parent/child orders and FHIR `ServiceRequest.requisition` and `basedOn` express grouping intent, not the laboratory's review decision or its effect on accessioning.
- **Holds**: scoped to a part, container or item, blocking named transitions (gross approval, print, tray delivery), released only with a reason. v2 `HD`/`RL` and FHIR `status = on-hold` act on a whole order and say nothing about which bench steps stop.
- **Identity immutability after accession**, correction reviews, and source-conflict reviews that keep the record on file until a person decides.
- **Acknowledgment of an accession as its own event**: v2 accept and application acknowledgments come close, but neither defines "the source holds this number for this laboratory request" as a fact to reconcile later.

## 14. Verification

- `tests/contract/boundary.test.ts`: valid accepted with provenance; minor version ignored; invalid data rejected with paths and queued; unsupported type queued; malformed envelope rejected, nothing recorded; `specimen.submitted` consistency; accession references; every 401 case with nothing recorded (wrong key, no header, malformed, ±6 minutes, other source, unknown source, non-source connector, tampered body, non-simulated adapter); tolerance edge; 422; the `404` gate in secured, locked, switch off, no or short secret; 413, 415; `503` busy (a second connection holds the write lock) and source offline; `500` then applied on re-send.
- `tests/contract/guarantees.test.ts`: duplicate safe; reordered events; conflicting identifiers never merged (new order, and an issued order under another MRN); partial failure in a batch (invalid one queued, transient one retried, corrected re-send applied once); downtime corrupts nothing; recovery without duplicate cases; provenance (message id, version, `sent_at` versus `received_at`, `source_ref`, correlation id, receipt channel); an accessioned identity never changed (issued part, accession number); requested versus issued versus acknowledged with an outage first.
- `tests/contract/scenarios.test.ts`: each of the 12 scenarios end to end in-process, and all 12 in sequence.
- `tests/contract/pump.test.ts`: the pump calls `handleEnvelope` (module spy) and gets the same structured NAK.
- `tests/contract/reconciliation.test.ts`: read only (no writes), shape, the listed sections, cancellation with work in progress, a check made against an older version, no secrets.
- `tests/contract/http.test.ts`: the route handlers behind a real `node:http` server on 127.0.0.1, the simulator over real `fetch` with signing (six scenarios, outage over a refused connection and recovery, per-request timeout, loopback-only and no redirects); the reconciliation API's 200, 403 and 401.

## 15. Known limits and deferred work

- **Retry from the failure queue** (`integration.retryEvent`) re-runs the stored payload through the same pipeline. Invalid data stays invalid; the source must re-send corrected data under the same message id.
- **First body wins** for a repeated message id (section 10). A source that reuses ids for different content gets `duplicate` and its change is ignored. A real interface agreement must forbid id reuse.
- **No outbound path.** The laboratory's accession request reaches the simulated issuer in-process; there is no outbound message to a source. A real connector needs one, with its own contract.
- **The demo pump** still polls the simulated outbox in-process (now through `handleEnvelope`). The HTTP endpoint does not update a source's freshness heartbeat; the pump does, as before.
- **No screen yet** for the reconciliation view in this phase; the read model and its API are ready for one.
- **The demo browser suite does not enable the endpoint** (`playwright.config.ts` is unchanged), so no browser test exercises it; the HTTP behaviour is covered by `tests/contract/http.test.ts`.
- Real HL7 v2 or FHIR transport, mutual TLS, and production activation are deferred (stage 6 plan, section 7).
