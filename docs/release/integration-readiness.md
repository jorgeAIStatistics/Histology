# Integration readiness: adapter boundaries (none are live)

*Updated in Stage 6, Phase D (2026-10-19). Every external system below is **simulated** in this demo. Nothing has been connected to, contracted with or tested against a real system. Each adapter boundary is where a real connector would plug in. A real connector would replace the simulator behind the same domain functions, keep the same audit and idempotency rules, and need its own contract tests.*

## Status at a glance

| System | Status in this build | What exists | What does not |
|---|---|---|---|
| LIS / EHR source of orders and accession numbers | **Simulated, with a versioned contract and an HTTP boundary** (demo mode only) | Contract `hlos.source-message` 1.0, a signed inbound endpoint for simulated sources, a 12-scenario simulator, a reconciliation read model, the `/integration` screen, contract and browser tests | Any real interface (HL7 v2 MLLP, FHIR, vendor API), mTLS or VPN, a per-source secret store, an interface agreement |
| Barcode / DataMatrix scanners | Keyboard-wedge emulation | Label format with a check character, scan field | Testing with real scanners and real labels after processing |
| Label printers | Simulated driver | Print jobs with unknown-outcome reconciliation | A driver or print service; validated templates |
| Histology instruments | None | Manual stage commands | Any instrument event feed |
| Office notifications | Simulated | Generic notice without patient details | A secure channel with delivery receipts |
| Enterprise identity | **OpenID Connect sign-in is implemented** (secured mode), tested against a local `oidc-provider` | Sessions, lock, re-authentication, hand-over, view and command permissions | A real provider tenant, MFA policy, production activation (blocked) |
| Drafting / extraction assistant | Deterministic demo logic | Explicit confirmation of every value | Any model, evaluation or monitoring |

## Adapter table

| System | Simulated today by | Boundary in the code | What a real adapter must provide | Open questions for the laboratory |
|---|---|---|---|---|
| **LIS / EHR source of orders and accession numbers** (EMA at the author's lab; EMA-SIM here) | Two simulated sources, `src_ema` (EMA-SIM Sunrise Coast, also the simulated accession issuer) and `src_oth` (OTHER-EHR-SIM Gulf):<br>- the in-process outbox and pump (`src/server/sim/pump.ts`), driven by the presenter console;<br>- the scenario simulator (`src/server/integration/simulator.ts`, `npm run integration:sim`), which signs envelopes and posts them over HTTP to loopback only;<br>- the accession issuer (`src/server/sim/authoritative.ts`). | **Inbound:** `POST /api/integration/inbound` (`src/server/integration/inbound.ts`), contract `hlos.source-message` 1.0 (`docs/release/integration-contract.md`). It exists only in demo mode with `HLOS_INTEGRATION_SIMULATOR=1` and a simulator secret, accepts only `simulated_*` adapters, and is a 404 in secured and locked mode. HMAC-SHA256 signature per source, envelope and payload checks, ACK and NAK replies.<br>**Mapping:** one path, `handleEnvelope` → `importSourceMessage` (`src/server/domain/sourceImport.ts`), used by the endpoint and the pump alike. Idempotent per message id; older versions are refused; invalid messages are kept in the failure queue; patient-level and order-level conflicts open review tasks; an issued specimen is never changed by a message.<br>**Read model:** `src/server/integration/reconciliation.ts` (writes nothing).<br>**Operator view:** `/integration` (`src/app/integration`, `src/components/integration`, permission `view.integration`). | A real transport (HL7 v2 ORM/ORU over MLLP, FHIR R4 `ServiceRequest`/`Specimen`, or a vendor API), behind mTLS or a VPN, with an independent secret or certificate per source.<br>An interface agreement covering: identifiers and namespaces, message ids that are never reused, ordering and retries, error replies, and downtime with backlog replay.<br>This system stays authoritative for accession numbers and patient identity: accession messages are compared and recorded, never adopted as a new number. | Which messages exist? Who owns the interface? Is there a test environment? How are amended orders versioned? Will the source ever re-use a message id? Who reviews identity conflicts out of hours? |
| **Barcode / DataMatrix scanners** | Keyboard-wedge emulation: the scan field types the payload and then Enter (or Tab). Demo "Scan" buttons. | `src/lib/identifiers.ts` (`encodeLabel` / `decodeLabel` with a check character), `src/lib/client/scan.tsx` | Scanner configuration (suffix, symbologies), a validated label format, and decode testing on real labels after processing (solvents, heat). | Which scanners? Which symbologies does the current label stock support? |
| **Label printers** (slides, cassettes) | `src/server/sim/printer.ts`. Outcomes: acknowledged, completion confirmed, timeout leading to unknown, failed. | `src/server/domain/print.ts`. An unknown outcome must be reconciled before any reprint. Label rows exist only after confirmed completion. | Driver or print service, real status and acknowledgement semantics, per-label confirmation where the hardware supports it, and validated templates. | Which printers? Do they report completion or only acceptance? |
| **Histology worklist / instrument interfaces** (processors, stainers, coverslippers) | None. Stage changes are manual commands (`block.advance`, `slide.advance`). | `src/server/domain/material.ts` (forward-only stage moves) | Instrument events (run started or finished, rack ids), mapping racks to blocks and slides, and error states. | Which instruments export events? Through which middleware? |
| **Office notifications** (clarifications) | `src/server/sim/notifications.ts`, `office.ts`. Generic notice only, with no patient details. | `src/server/sim/notifications.ts` (`sendSimulatedNotification`), called from `src/server/domain/clarification.ts` | A secure channel (portal, secure fax, LIS messaging), delivery receipts, and replies linked back to the question. | Which channel do offices use today? Who may receive specimen questions? |
| **Enterprise identity** | A local `oidc-provider` in tests (development dependency only). Demo mode keeps the demo role cookie, which is not authentication. | `src/server/auth/*` (OpenID Connect relying party, sessions, the one guard), `src/server/runtime-mode.ts`; see `docs/release/auth-architecture.md` | A real provider tenant, registered redirect and logout URIs, the agreed claims (`auth_time`, MFA, the lab claim), and staff identity links made by a laboratory administrator. | Which identity provider? How are roles assigned and reviewed? |
| **Drafting / extraction assistant** | Deterministic demo logic (`src/server/assist`). It never writes; every value needs explicit confirmation. | `src/server/assist/*`, `gross.loadTranscript` / `gross.confirmField` | If ever used: a written intended use, a local evaluation set, field-level error analysis and monitoring. It must never decide identity or relationships. | Is any assistance wanted at all? |

## What the operator sees (`/integration`)

The screen opens for every role with `view.integration`, which is the same set of roles that has `view.operations`. The laboratory administrator and the auditor do not get it. It is read only: its one action is the existing supervisor retry of a failed message, and only for a processing failure, since invalid data would fail again.

**Each source** shows:
- its name, labelled simulated;
- its status: connected, unavailable or slow link;
- when it was last contacted, and its last successful sync;
- its last error, in plain words;
- the messages waiting at the source and not yet delivered here.

**The reconciliation rows** (`reconciliation.ts`) are grouped by what the operator must do:
- **Needs review:** an open review, or a difference that no review covers yet. Patient-identity rows come first, in identity red.
- **Waiting on the source:** an accession reply that has not come yet, or a source that is unavailable.
- **Failed and retryable:** messages in the failure queue. Invalid data is named field by field; a processing failure can be retried.
- **Informational:** older versions ignored, reviews already closed, and the latest messages. A message shows once, with its delivery count. On request the screen also lists the comparisons that agree, or every message.

**Each row** shows:
- what the source says, what is recorded here, and the difference, side by side;
- "Source says sent" (the source's claimed event time) next to "Received here" (the local clock);
- the work it touches, linked to Intake, the case or Clarify;
- whether a person must review it, and who: the named owner, or the roles that decide.

The raw message is behind a disclosure and shown as text, never interpreted.

**Signals elsewhere** (no new banners):
- The Operations "Integration" category, and the source-freshness sheet on Operations, link to `/integration` with its counts.
- The top bar's source-freshness popover links to it.
- Intake keeps showing an item's source conflict or amended-order re-check where it already did.

`/integration` is not in the top bar's job navigation. Below 1536px every job already shrinks to an icon so the scan field can lead, and an eighth target would take room from it.

## Verified, and how

- Contract and boundary: `tests/contract/*.test.ts` (signature, envelope, payload, the 404 gate, the 12 scenarios in-process and over real HTTP, the reconciliation read model writes nothing).
- The operator view: `tests/e2e/integration.spec.ts`, against the demo build with the simulator switched on (`playwright.config.ts`: `HLOS_INTEGRATION_SIMULATOR=1` and a random secret per run). It drives the real simulator through the signed endpoint and covers these cases:
  - a normal import;
  - a duplicate shown once;
  - an amendment with its difference and the work it touches;
  - missing fields rejected, with the reason;
  - an identity conflict that needs review and is never merged (Intake still shows the patient on file);
  - a late older version ignored;
  - an outage shown as unavailable, with the last successful sync and nothing applied;
  - recovery that delivers the backlog once and clears the screen;
  - both times shown, labelled apart;
  - the links from Operations and the top bar;
  - axe (WCAG 2.x A/AA and 2.2 AA) at 1366 and 1024 wide, with no horizontal overflow.
- Permission: `view.integration` is part of the bench views. The existing unit tests check that every bench role holds it and that the laboratory administrator and the auditor are refused.

**Not verified:**
- The secured browser suite does not open `/integration`; the guard it uses is the same one every page uses.
- No test covers a real source system, since none exists.

**Rule for every adapter:** the adapter's events enter through the same command and domain functions as today, with origin `import` or `simulator`. They never bypass holds, version checks, idempotency or the audit trail. A connector failure surfaces on `/integration`, in Operations under "Integration" and in the source-freshness indicator. It never turns into a silent "done".
