"use client";

import { useState } from "react";
import { api, errorText } from "@/lib/api";
import { useSession } from "@/lib/session";
import type { DatasetVersion, LabelValue } from "@/lib/types";
import { Dialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { Checkbox, SelectField, TextField } from "@/components/ui/Field";
import { Notice } from "@/components/ui/Notice";
import { LABEL_DISPLAY_FULL, LABEL_ORDER } from "@/components/review/shared";

export function CreateDatasetDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (id: string) => void }) {
  const { projectId } = useSession();
  const [name, setName] = useState("BCC slide-level research set");
  const [scope, setScope] = useState<"slide" | "case">("slide");
  const [pending, setPending] = useState(false);
  const [values, setValues] = useState<LabelValue[]>(["bcc_present", "bcc_absent_not_benign"]);
  const [prov, setProv] = useState({ demo_synthetic: true, public_cc0: true, real_authorized: false });
  const [split, setSplit] = useState<"none" | "random">("random");
  const [seed, setSeed] = useState("7");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      wide
      testId="create-dataset"
      title="New dataset draft"
      description="The draft is materialised immediately from the current labels and review states. Nothing is frozen until you freeze it."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            busy={busy}
            data-testid="create-dataset-confirm"
            unavailable={!name.trim() ? "Name the dataset." : values.length === 0 ? "Choose at least one label value." : null}
            onClick={async () => {
              setBusy(true);
              setErr(null);
              try {
                const dv = await api<DatasetVersion>(`/projects/${projectId}/datasets`, {
                  method: "POST",
                  body: {
                    name,
                    config: {
                      label_scope: scope,
                      eligible_review_states: pending ? ["approved", "pending_review"] : ["approved"],
                      label_values: values,
                      include_provenance: (Object.keys(prov) as (keyof typeof prov)[]).filter((k) => prov[k]),
                      ...(split === "random" ? { split: { partition: "random", seed: Number(seed) || 0 } } : {}),
                    },
                  },
                });
                onCreated(dv.id);
              } catch (e) {
                setErr(errorText(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            Create draft
          </Button>
        </>
      }
    >
      <div className="grid gap-5 md:grid-cols-2">
        <div className="space-y-4">
          <TextField label="Name" required value={name} onChange={(e) => setName(e.target.value)} />
          <SelectField
            label="Label scope"
            value={scope}
            onChange={(e) => setScope(e.target.value as "slide" | "case")}
            options={[
              { value: "slide", label: "Slide labels (slide-level training needs verified slide labels)" },
              { value: "case", label: "Case labels (case bags; never copied down to slides)" },
            ]}
          />
          <fieldset className="space-y-2">
            <legend className="text-small font-semibold">Review states that may enter</legend>
            <Checkbox label="Approved" checked disabled hint="Always required for research datasets in this template." />
            <Checkbox label="Also pending review" checked={pending} onChange={(e) => setPending(e.target.checked)} hint="Not recommended: pending slides have no approved review." />
          </fieldset>
          <fieldset className="space-y-2">
            <legend className="text-small font-semibold">Provenance included</legend>
            <Checkbox label="Demo synthetic" checked={prov.demo_synthetic} onChange={(e) => setProv({ ...prov, demo_synthetic: e.target.checked })} />
            <Checkbox label="Public CC0" checked={prov.public_cc0} onChange={(e) => setProv({ ...prov, public_cc0: e.target.checked })} />
            <Checkbox label="Real data (authorized)" checked={prov.real_authorized} onChange={(e) => setProv({ ...prov, real_authorized: e.target.checked })} />
          </fieldset>
        </div>
        <div className="space-y-4">
          <fieldset className="space-y-2">
            <legend className="text-small font-semibold">Label values (task classes)</legend>
            {LABEL_ORDER.map((v) => (
              <Checkbox
                key={v}
                label={LABEL_DISPLAY_FULL[v]}
                checked={values.includes(v)}
                onChange={(e) => setValues(e.target.checked ? [...values, v] : values.filter((x) => x !== v))}
              />
            ))}
          </fieldset>
          <SelectField
            label="Initial split"
            value={split}
            onChange={(e) => setSplit(e.target.value as "none" | "random")}
            options={[
              { value: "random", label: "Random, grouped by coded patient (60 / 20 / 20)" },
              { value: "none", label: "None yet (assign later, including temporal or external-site)" },
            ]}
          />
          {split === "random" ? <TextField label="Seed" type="number" value={seed} onChange={(e) => setSeed(e.target.value)} /> : null}
          <Notice tone="info">Splits always keep every slide, level and stain of one coded patient on the same side.</Notice>
        </div>
      </div>
      {err ? (
        <p role="alert" className="mt-3 text-small text-rust">
          {err}
        </p>
      ) : null}
    </Dialog>
  );
}
