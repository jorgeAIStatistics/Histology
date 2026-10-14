import { CircleCheck, CircleHelp, CircleMinus } from "lucide-react";
import { Table, THead, TBody, TH, TR, TD } from "@/components/ui/table";
import { SimulatedLabel } from "@/components/domain/honesty";
import { COPY_GUARD, REAL_VS_SIMULATED, type CapabilityRow } from "./content";

function Status({ s }: { s: CapabilityRow["status"] }) {
  if (s === "Simulated") return <SimulatedLabel />;
  const Icon = s === "Working in this demo" ? CircleCheck : s === "Not implemented" ? CircleMinus : CircleHelp;
  const cls = s === "Working in this demo" ? "text-success-solid" : "text-ink-muted";
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-sm text-ink">
      <Icon className={`size-4 shrink-0 ${cls}`} aria-hidden />
      {s}
    </span>
  );
}

/** What in the demo is working local logic, what is simulated, what is not built, and what is unknown. */
export function RealVsSimulated() {
  const order: CapabilityRow["status"][] = ["Working in this demo", "Simulated", "Not implemented", "Unknown: needs discovery"];
  const rows = [...REAL_VS_SIMULATED].sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status));
  return (
    <section aria-labelledby="rvs-title" className="grid gap-3">
      <div>
        <h2 id="rvs-title" className="text-md font-semibold text-ink">
          Real vs simulated
        </h2>
        <p className="max-w-[90ch] text-sm text-ink-secondary">
          “Working in this demo” means the logic runs locally on synthetic data. It does not mean it has been validated, connected to EMA or used with patients. Real use
          would need review by the organization&apos;s clinical, IT, privacy and security, and operational owners.
        </p>
      </div>
      <Table caption="Capabilities by status: working locally, simulated, not implemented, unknown" scroll="page">
        <THead>
          <TR>
            <TH>Capability</TH>
            <TH>Status in this demo</TH>
            <TH>Note</TH>
          </TR>
        </THead>
        <TBody>
          {rows.map((r) => (
            <TR key={r.capability}>
              <TD wrap>{r.capability}</TD>
              <TD>
                <Status s={r.status} />
              </TD>
              <TD wrap className="text-ink-secondary">
                {r.note}
              </TD>
            </TR>
          ))}
        </TBody>
      </Table>
      <p className="text-xs text-ink-muted">{COPY_GUARD}</p>
    </section>
  );
}
