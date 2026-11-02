# Stage 7 architecture proposal: a connected laboratory (not implemented)

*A proposal only. Nothing below exists in the code. It builds on the Stage 6 foundation and keeps its rules: synthetic data until validated, human control of consequential decisions, and no clinical claims.*

## 1. What Stage 6 gives Stage 7
| Stage 6 model or mechanism | Reused for |
|---|---|
| `executeCommand`: one write path, scoped idempotency, sealed audit with session and source references | Every new action: equipment acknowledgments, QC acceptance, reagent lot changes |
| `custody_event` (append-only) and the last-confirmed location of blocks and slides | Material tracking: the twin's "where is it" comes from confirmed scans only, never inferred |
| Derived readiness and stage (`readiness.ts`), holds with exact scope (`holds.ts`), shared next step and owner (`hold-next.ts`) | Live operational state; the twin is a read model over these, not a second state store |
| `integration_event` (source event time vs local receipt time), the signed inbound boundary, reconciliation | Instrument and middleware messages: same envelope pattern, same provenance and reconciliation |
| `worklist_change` feed and `/api/live` polling | Live surfaces (see §3), later upgraded to server-sent events |
| Sessions, `view.*` permissions, lab scope | Who may see equipment, QC and analytics; lab-scoped data partitions when a second site exists |
| Backup, restore verification, health checks | Operating a connected system (the twin must degrade, not fail, when a feed drops) |

## 2. Events needed (new types, all through the inbound boundary or commands)
- **Processor runs:** program, rack or basket ids, start and end, errors; block membership by scanned basket.
- **Stainer and coverslipper runs:** protocol, slide ids scanned at load, completion, faults.
- **IHC:** run id, antibody, clone, lot, retrieval protocol; on-slide and batch control results; acceptance by a qualified person.
- **Reagents:** lot received, opened, expiry, in-use on instrument, lot change; quality-control linkage.
- **Equipment status:** up, down, maintenance, alarms (coarse, from middleware).
- **Turnaround markers:** event timestamps that already exist (received, accessioned, grossed, processed, embedded, sectioned, stained, QC, sent) plus the new instrument events.

## 3. Surfaces that would show live information
- **Operations:**
  - blocked work by owner (exists);
  - equipment status strip;
  - queue depth per step;
  - age of oldest item per step.
- **Worklist:** readiness that knows an instrument run finished; still no inferred location.
- **Materials:** reagent lots in use on the slides being assembled; IHC control status per run.
- **Gross and embedding:** processor run membership for each cassette.
- **No live alerts on bench screens** except those that change the operator's next action (identity, holds, failed controls).

## 4. Integrations still needed
1. The real LIS/EHR order and accession source (EMA at the author's lab). Replace the simulator behind the Stage 6 contract.
2. Instrument middleware for processors, stainers and coverslippers. Vendor-specific; often HL7 or ASTM through middleware.
3. IHC stainer and LIS QC exchange.
4. Label printers and scanners: validated templates and hardware tests.
5. Enterprise identity provider (Stage 6 blocked item).

## 5. Outcomes that could be measured
Measured only with definitions agreed with the laboratory, and never as staff rankings.
- Turnaround time per step and end to end; percentage within target.
- Holds: count, duration and cause.
- Clarifications: time to answer.
- Rework:
  - recuts;
  - reprints;
  - reconciled print outcomes;
  - tray exceptions.
- Near misses caught by scans:
  - wrong-case slides on trays;
  - wrong block for a retrieval.
- Material out of place: time from last confirmed location to found.
- IHC control failures and repeat runs; reagent lot changes linked to failures.

## 6. What stays under human control
- Patient identity, related-order decisions, accession requests and source-conflict reviews.
- Hold placement and release; gross approval; tray completion with exceptions.
- IHC control acceptance and run release; reagent lot acceptance.
- Any change to routing rules or protocols.
- Every recommendation is advisory. Accepting one is a recorded human command with a reason; ignoring one is allowed and also recorded.

## 7. How AI recommendations would be evaluated and constrained
- **Scope:** operational assistance only, for example "this tray is likely to miss its pickup", "this queue will back up by 14:00" or "this block was last scanned at embedding". Never identity, never diagnosis, never protocol selection.
- **Before use:**
  - a written intended use;
  - a frozen, de-identified evaluation set from the laboratory's own history;
  - pre-specified metrics (calibration, precision at the alert threshold, lead time) and an error analysis by step and shift.
- **Shadow mode first:** recommendations are logged but not shown. They are compared with what happened, and promoted only after the lab director reviews the results.
- **In use:**
  - shown with the evidence behind them (which events);
  - never as a confidence percentage without calibration;
  - rate-limited to avoid alert fatigue;
  - every override captured;
  - drift monitored, with automatic withdrawal when performance falls below the agreed threshold.
- **Data rules:** minimum necessary; no PHI in prompts or logs; the same audit and access controls as the rest of the system.

## 8. Order of work (proposal)
1. Real identity provider in a test tenant, with the laboratory's IT team (unblocks a pilot).
2. One instrument feed (the processor) through the inbound boundary, in a test environment, with reconciliation.
3. Live read model and an equipment status strip on Operations.
4. Turnaround measurement with definitions agreed by the lab.
5. Reagent lot and IHC control tracking (commands and screens, with no AI).
6. Only then: a shadow-mode evaluation of one operational prediction.
