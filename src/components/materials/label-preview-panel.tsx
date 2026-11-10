"use client";

import { useId, useState } from "react";
import { CircleCheck, Minus, TriangleAlert } from "lucide-react";
import { LabelPreview } from "@/components/domain/label-preview";
import { Field, Input } from "@/components/ui/field";
import { decodeLabel, humanLabel, stainCode, type LabelIdentity } from "@/lib/identifiers";
import type { RecordCheck, RecordFieldCheck } from "@/server/domain/labels";
import { HARDWARE_NOTE, SectionTitle } from "./shared";

const KIND_WORD: Record<LabelIdentity["kind"], string> = { C: "Case", B: "Block", S: "Slide" };

/** The decoded value of one field, using the same field names as the server's record check. */
function encodedField(identity: LabelIdentity, field: string): string {
  switch (field) {
    case "Label type":
      return KIND_WORD[identity.kind];
    case "Accession":
      return identity.accession;
    case "Part":
      return identity.part ?? "—";
    case "Block":
      return identity.block === undefined ? "—" : String(identity.block);
    case "Slide":
      return identity.slide === undefined ? "—" : String(identity.slide);
    case "Stain":
      return identity.stain ? stainCode(identity.stain) : "—";
    default:
      return "—";
  }
}

/** Compare a (typed or scanned) payload with the record fields the server returned. */
function compareWithRecord(payload: string, recordFields: RecordFieldCheck[]): { ok: false; reason: string } | { ok: true; text: string; fields: RecordFieldCheck[] } {
  const d = decodeLabel(payload);
  if (!d.ok) return { ok: false, reason: d.reason };
  return {
    ok: true,
    text: humanLabel(d.identity),
    fields: recordFields.map((f) => {
      if (f.ok === null) return f;
      const encoded = encodedField(d.identity, f.field);
      return { ...f, encoded, ok: encoded.toUpperCase() === f.record.toUpperCase() };
    }),
  };
}

function FieldTable({ fields, caption }: { fields: RecordFieldCheck[]; caption: string }) {
  return (
    <table className="mt-1 w-full border-collapse text-xs">
      <caption className="sr-only">{caption}</caption>
      <thead>
        <tr className="text-left text-ink-muted">
          <th scope="col" className="py-0.5 pr-2 font-medium">Field</th>
          <th scope="col" className="py-0.5 pr-2 font-medium">In the code</th>
          <th scope="col" className="py-0.5 pr-2 font-medium">In the record</th>
          <th scope="col" className="py-0.5 font-medium">
            <span className="sr-only">Result</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {fields.map((f) => (
          <tr key={f.field} className="border-t border-line">
            <th scope="row" className="py-0.5 pr-2 text-left font-normal text-ink-secondary">{f.field}</th>
            <td className="id-mono py-0.5 pr-2 [overflow-wrap:anywhere]">{f.encoded}</td>
            <td className="id-mono py-0.5 pr-2 [overflow-wrap:anywhere]">{f.record}</td>
            <td className="py-0.5">
              {f.ok === null ? (
                <span className="inline-flex items-center gap-1 text-ink-muted">
                  <Minus className="size-3.5" aria-hidden /> Not encoded (readable text only)
                </span>
              ) : f.ok ? (
                <span className="inline-flex items-center gap-1 text-success-fg">
                  <CircleCheck className="size-3.5 text-success-solid" aria-hidden /> Same
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 font-semibold text-warning-fg">
                  <TriangleAlert className="size-3.5 text-warning-solid" aria-hidden /> Differs
                </span>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function CheckResult({ title, result, caption }: { title: string; result: ReturnType<typeof compareWithRecord>; caption: string }) {
  if (!result.ok) {
    return (
      <p className="flex items-start gap-1.5 text-sm text-warning-fg" role="status">
        <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning-solid" aria-hidden />
        <span>
          {title}: does not decode ({result.reason}).
        </span>
      </p>
    );
  }
  const compared = result.fields.filter((f) => f.ok !== null);
  const same = compared.length > 0 && compared.every((f) => f.ok);
  return (
    <div className="flex flex-col gap-0.5" role="status">
      <p className={same ? "flex items-start gap-1.5 text-sm text-success-fg" : "flex items-start gap-1.5 text-sm text-warning-fg"}>
        {same ? <CircleCheck className="mt-0.5 size-4 shrink-0 text-success-solid" aria-hidden /> : <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning-solid" aria-hidden />}
        <span>
          {title}: decodes to <span className="id-mono font-medium">{result.text}</span>
          {same ? ", and every encoded field matches the record." : ", which does NOT match the record."}
        </span>
      </p>
      <FieldTable fields={result.fields} caption={caption} />
    </div>
  );
}

/**
 * Label preview with an encode/decode check against the RECORD: the payload is
 * decoded and each field (accession, part, block, slide, stain) is compared with
 * the slide/block/case record, so a code for the wrong slide or stain shows as a
 * mismatch. A demonstration of the demo identifier format only; a screen
 * preview proves nothing about printed labels on real materials.
 */
export function LabelPreviewPanel({ payload, text, check, showPreview = true }: { payload: string; text: string; check: RecordCheck; showPreview?: boolean }) {
  const [test, setTest] = useState("");
  const headingId = useId();
  const own = compareWithRecord(payload, check.fields);
  return (
    <section aria-labelledby={headingId} className="flex min-w-0 flex-col gap-2">
      <SectionTitle id={headingId}>{showPreview ? "Label preview" : "Check the code against the record"}</SectionTitle>
      {showPreview ? (
        <div className="min-w-0 max-w-full [&_p]:[overflow-wrap:anywhere]">
          <LabelPreview payload={payload} text={text} />
        </div>
      ) : null}
      <div className="rounded-md border border-line bg-surface-subtle p-2.5">
        <p className="mb-1 text-xs font-medium text-ink-secondary">Encode/decode check against the record (demo format)</p>
        <CheckResult title="This label's code" result={own} caption="Fields encoded in this label compared with the record" />
        <Field label="Test a scanned value" hint="Paste or type a payload. A changed character, or a code for another slide, must be rejected." className="mt-2">
          <Input size="sm" mono value={test} onChange={(e) => setTest(e.target.value)} placeholder={payload} autoComplete="off" spellCheck={false} />
        </Field>
        {test.trim() ? (
          <div className="mt-1.5">
            <CheckResult title="Typed value" result={compareWithRecord(test, check.fields)} caption="Fields encoded in the typed value compared with the record" />
          </div>
        ) : null}
      </div>
      <p className="text-xs text-ink-muted">{HARDWARE_NOTE}</p>
    </section>
  );
}
