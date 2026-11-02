"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { FileUp, Pause, Play, RotateCcw } from "lucide-react";
import { useSession } from "@/lib/session";
import { api, errorText } from "@/lib/api";
import { formatBytes } from "@/lib/format";
import { ChunkedUpload, forgetStoredUpload, readStoredUploads, type StoredUpload, type UploadSnapshot, type UploadTarget } from "@/lib/upload";
import type { CaseDetail, CaseSummary } from "@/lib/types";
import { Dialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { Checkbox, SelectField, TextField } from "@/components/ui/Field";
import { Notice } from "@/components/ui/Notice";
import { cn } from "@/components/ui/cn";

function ext(name: string) {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i).toLowerCase() : "";
}

function Bar({ value, label, tone = "teal" }: { value: number; label: string; tone?: "teal" | "amber" }) {
  const pctv = Math.max(0, Math.min(1, value));
  return (
    <div>
      <div className="flex justify-between text-micro text-graphite">
        <span>{label}</span>
        <span className="tabular">{Math.round(pctv * 100)}%</span>
      </div>
      <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pctv * 100)} className="mt-1 h-2 overflow-hidden rounded-full bg-paraffin">
        <div className={cn("h-full rounded-full transition-[width]", tone === "teal" ? "bg-teal" : "bg-amber")} style={{ width: `${pctv * 100}%` }} />
      </div>
    </div>
  );
}

export function UploadDialog({ open, onClose, cases, onIngested }: { open: boolean; onClose: () => void; cases: CaseSummary[]; onIngested: () => void }) {
  const { meta, projectId } = useSession();
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [mode, setMode] = useState<"existing" | "new">("new");
  const [caseId, setCaseId] = useState("");
  const [caseDetail, setCaseDetail] = useState<CaseDetail | null>(null);
  const [blockId, setBlockId] = useState("");
  const [nh, setNh] = useState({ patient_code: "", accession_code: "", part_designation: "A", block_designation: "A1", collected_on: "", site_id: "", anatomic_site_text: "" });
  const [level, setLevel] = useState("1");
  const [stain, setStain] = useState("H&E");
  const [scanner, setScanner] = useState("");
  const [provenance, setProvenance] = useState<"public_cc0" | "real_authorized">("public_cc0");
  const [attest, setAttest] = useState(false);
  const [snap, setSnap] = useState<UploadSnapshot | null>(null);
  const [stored, setStored] = useState<StoredUpload[]>([]);
  const [resumeFor, setResumeFor] = useState<StoredUpload | null>(null);
  const job = useRef<ChunkedUpload | null>(null);
  const resumeInput = useRef<HTMLInputElement>(null);

  const allowed = meta?.upload.allowed_extensions ?? [".svs", ".jpg", ".jpeg", ".png"];
  const maxBytes = meta?.upload.max_upload_bytes ?? 4 * 1024 ** 3;

  useEffect(() => {
    if (open && projectId) setStored(readStoredUploads(projectId));
  }, [open, projectId, snap?.phase]);

  useEffect(() => {
    if (!caseId) {
      setCaseDetail(null);
      return;
    }
    let live = true;
    api<CaseDetail>(`/cases/${caseId}`)
      .then((d) => {
        if (!live) return;
        setCaseDetail(d);
        const first = d.parts.flatMap((p) => p.blocks)[0];
        setBlockId(first?.id ?? "");
      })
      .catch(() => setCaseDetail(null));
    return () => {
      live = false;
    };
  }, [caseId]);

  useEffect(() => {
    if (snap?.phase === "done") onIngested();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snap?.phase]);

  const pick = (f: File | null) => {
    setFileError(null);
    setFile(null);
    if (!f) return;
    const e = ext(f.name);
    if (!allowed.includes(e)) {
      setFileError(`${e || "Files without an extension"} cannot be uploaded. Accepted: ${allowed.join(", ")}. Only Aperio .svs is tested as a whole-slide format; JPEG and PNG are imported as field images.`);
      return;
    }
    if (f.size > maxBytes) {
      setFileError(`This file is ${formatBytes(f.size)}; the limit is ${formatBytes(maxBytes)}.`);
      return;
    }
    if (f.size === 0) {
      setFileError("The file is empty.");
      return;
    }
    setFile(f);
  };

  const begin = (f: File, target: UploadTarget, knownSha?: string) => {
    if (!projectId) return;
    const u = new ChunkedUpload(projectId, f, target, (s) => setSnap(s), knownSha ?? null);
    job.current = u;
    setSnap(u.snap);
    void u.start();
  };

  const start = () => {
    if (!file) return;
    const target: UploadTarget = {
      provenance,
      governance_attestation: attest,
      level_index: level === "" ? undefined : Number(level),
      stain: stain || undefined,
      scanner_id: scanner || undefined,
    };
    if (mode === "existing") target.block_id = blockId;
    else
      target.new_hierarchy = {
        patient_code: nh.patient_code,
        accession_code: nh.accession_code,
        part_designation: nh.part_designation,
        block_designation: nh.block_designation,
        ...(nh.collected_on ? { collected_on: nh.collected_on } : {}),
        ...(nh.site_id ? { site_id: nh.site_id } : {}),
        ...(nh.anatomic_site_text ? { anatomic_site_text: nh.anatomic_site_text } : {}),
      };
    begin(file, target);
  };

  const reset = () => {
    job.current = null;
    setSnap(null);
    setFile(null);
    setResumeFor(null);
  };

  const close = () => {
    if (snap && ["hashing", "uploading", "initializing", "completing"].includes(snap.phase)) job.current?.pause();
    reset();
    onClose();
  };

  const kind = file ? (ext(file.name) === ".svs" ? "Whole-slide image (Aperio SVS, the one tested format)" : "Field image (JPEG/PNG): imported as a camera field, never as a whole slide") : null;
  const targetValid = mode === "existing" ? Boolean(blockId) : Boolean(nh.patient_code && nh.accession_code && nh.part_designation && nh.block_designation);
  const busy = snap && ["hashing", "initializing", "uploading", "completing", "ingesting"].includes(snap.phase);

  return (
    <Dialog
      open={open}
      onClose={close}
      wide
      testId="upload-dialog"
      title="Upload a slide"
      description="Resumable, chunked upload. The checksum is computed in this browser and verified again by the server before anything is ingested."
      footer={
        snap ? (
          <>
            {snap.phase === "uploading" || snap.phase === "hashing" ? (
              <Button icon={<Pause size={15} aria-hidden />} onClick={() => job.current?.pause()} data-testid="upload-pause">
                Pause
              </Button>
            ) : null}
            {snap.phase === "paused" ? (
              <Button variant="primary" icon={<Play size={15} aria-hidden />} onClick={() => void job.current?.resume()} data-testid="upload-resume">
                Resume
              </Button>
            ) : null}
            {snap.phase === "paused" || snap.phase === "uploading" || snap.phase === "failed" ? (
              <Button variant="danger" onClick={() => void job.current?.cancel()}>
                Cancel upload
              </Button>
            ) : null}
            {["done", "duplicate", "failed", "canceled"].includes(snap.phase) ? (
              <Button icon={<RotateCcw size={15} aria-hidden />} onClick={reset}>
                Upload another file
              </Button>
            ) : null}
            <Button onClick={close}>{busy ? "Close (pauses the upload)" : "Close"}</Button>
          </>
        ) : (
          <>
            <Button onClick={close}>Cancel</Button>
            <Button variant="primary" icon={<FileUp size={16} aria-hidden />} unavailable={!file ? "Choose a file first." : !targetValid ? "Choose where the slide belongs (an existing block or a new case)." : null} onClick={start} data-testid="upload-start">
              Check and upload
            </Button>
          </>
        )
      }
    >
      {stored.length > 0 && !snap ? (
        <Notice tone="warning" title="Interrupted uploads can be resumed" className="mb-4">
          <ul className="mt-1 space-y-2">
            {stored.map((s) => (
              <li key={s.uploadId} className="flex flex-wrap items-center gap-2">
                <span className="text-ink">
                  <strong>{s.name}</strong> · {formatBytes(s.receivedBytes)} of {formatBytes(s.size)} received
                </span>
                <Button
                  size="sm"
                  variant="primary"
                  onClick={() => {
                    setResumeFor(s);
                    resumeInput.current?.click();
                  }}
                >
                  Select the same file to resume
                </Button>
                <Button
                  size="sm"
                  variant="quiet"
                  onClick={async () => {
                    try {
                      await api(`/uploads/${s.uploadId}`, { method: "DELETE" });
                    } catch {
                      /* already gone */
                    }
                    forgetStoredUpload(s.uploadId);
                    setStored((x) => x.filter((y) => y.uploadId !== s.uploadId));
                  }}
                >
                  Discard
                </Button>
              </li>
            ))}
          </ul>
          <input
            ref={resumeInput}
            type="file"
            className="sr-only"
            aria-label="Select the interrupted file again"
            accept={allowed.join(",")}
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (!f || !resumeFor) return;
              if (f.name !== resumeFor.name || f.size !== resumeFor.size) {
                setFileError(`That is not the interrupted file (${resumeFor.name}, ${formatBytes(resumeFor.size)}).`);
                return;
              }
              // Same name, size and modification time: reuse the recorded checksum. Otherwise hash again.
              const known = f.lastModified === resumeFor.lastModified ? resumeFor.sha256 : undefined;
              begin(f, { provenance: "public_cc0", governance_attestation: false }, known);
            }}
          />
        </Notice>
      ) : null}

      {!snap ? (
        <div className="grid gap-5 lg:grid-cols-2">
          <div className="space-y-4">
            <div>
              <label
                htmlFor="upload-file"
                className="flex cursor-pointer flex-col items-center justify-center gap-1 rounded-[var(--radius-panel)] border-2 border-dashed border-line-strong bg-sheet px-4 py-6 text-center hover:border-teal"
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  pick(e.dataTransfer.files?.[0] ?? null);
                }}
              >
                <FileUp size={22} aria-hidden className="text-teal-deep" />
                <span className="font-semibold text-ink">{file ? file.name : "Choose a file or drop it here"}</span>
                <span className="text-small text-graphite">{file ? formatBytes(file.size) : `${allowed.join(", ")} · up to ${formatBytes(maxBytes)}`}</span>
              </label>
              <input id="upload-file" data-testid="upload-file" type="file" accept={allowed.join(",")} className="sr-only" onChange={(e) => pick(e.target.files?.[0] ?? null)} />
              {fileError ? (
                <p role="alert" className="mt-2 text-small text-rust">
                  {fileError}
                </p>
              ) : null}
              {kind ? <p className="mt-2 text-small text-graphite">{kind}</p> : null}
            </div>
            <Notice tone="warning" title="Identifiers can hide in files">
              Filenames, embedded metadata, slide label and macro images and reports can all carry identifiers. The server flags likely risks and never
              serves label or macro images, but a flag or a checkbox is not de-identification. This demo accepts public or fictional files only.
            </Notice>
            <fieldset className="space-y-2">
              <legend className="text-small font-semibold">Provenance</legend>
              <label className="flex items-start gap-2 text-small">
                <input type="radio" name="prov" checked={provenance === "public_cc0"} onChange={() => setProvenance("public_cc0")} className="mt-1 accent-[var(--color-teal)]" />
                <span>
                  <strong>Public CC0</strong> (public test data with a known licence)
                </span>
              </label>
              <label className="flex items-start gap-2 text-small">
                <input type="radio" name="prov" checked={provenance === "real_authorized"} onChange={() => setProvenance("real_authorized")} className="mt-1 accent-[var(--color-teal)]" />
                <span>
                  <strong>Real data (authorized)</strong>: refused by this demo API unless WB_ALLOW_REAL_DATA is set, which also needs secured mode and data
                  agreements that are not implemented.
                </span>
              </label>
              {provenance === "real_authorized" ? (
                <Checkbox
                  label="I attest that the governance requirements for this file are met"
                  hint="Recorded with the upload. It is not proof of de-identification."
                  checked={attest}
                  onChange={(e) => setAttest(e.target.checked)}
                />
              ) : null}
            </fieldset>
          </div>
          <div className="space-y-4">
            <fieldset>
              <legend className="text-small font-semibold">Where does the slide belong?</legend>
              <div className="mt-2 flex gap-4 text-small">
                <label className="flex items-center gap-2">
                  <input type="radio" name="target" checked={mode === "new"} onChange={() => setMode("new")} className="accent-[var(--color-teal)]" />
                  New case
                </label>
                <label className="flex items-center gap-2">
                  <input type="radio" name="target" checked={mode === "existing"} onChange={() => setMode("existing")} className="accent-[var(--color-teal)]" />
                  Existing block
                </label>
              </div>
            </fieldset>
            {mode === "existing" ? (
              <div className="grid gap-3 sm:grid-cols-2">
                <SelectField
                  label="Case"
                  value={caseId}
                  onChange={(e) => setCaseId(e.target.value)}
                  options={[{ value: "", label: "Choose a case" }, ...cases.map((c) => ({ value: c.id, label: `${c.patient_code} › ${c.accession_code}` }))]}
                />
                <SelectField
                  label="Block"
                  value={blockId}
                  onChange={(e) => setBlockId(e.target.value)}
                  disabled={!caseDetail}
                  options={
                    caseDetail
                      ? caseDetail.parts.flatMap((p) => p.blocks.map((b) => ({ value: b.id, label: `Part ${p.designation} / Block ${b.designation}` })))
                      : [{ value: "", label: "Choose a case first" }]
                  }
                />
              </div>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2">
                <TextField label="Coded patient" required placeholder="P-0101" hint="A study code, never a name or record number" value={nh.patient_code} onChange={(e) => setNh({ ...nh, patient_code: e.target.value })} />
                <TextField label="Study accession" required placeholder="CC0-UPL-0001" hint="Not the lab accession" value={nh.accession_code} onChange={(e) => setNh({ ...nh, accession_code: e.target.value })} />
                <TextField label="Part" required value={nh.part_designation} onChange={(e) => setNh({ ...nh, part_designation: e.target.value })} />
                <TextField label="Block" required value={nh.block_designation} onChange={(e) => setNh({ ...nh, block_designation: e.target.value })} />
                <TextField label="Collected on" type="date" value={nh.collected_on} onChange={(e) => setNh({ ...nh, collected_on: e.target.value })} />
                <TextField label="Site code" placeholder="site-north" value={nh.site_id} onChange={(e) => setNh({ ...nh, site_id: e.target.value })} />
              </div>
            )}
            <div className="grid gap-3 sm:grid-cols-3">
              <TextField label="Level" type="number" min={0} max={999} value={level} onChange={(e) => setLevel(e.target.value)} />
              <TextField label="Stain" value={stain} onChange={(e) => setStain(e.target.value)} />
              <TextField label="Scanner code" placeholder="scanner-a" value={scanner} onChange={(e) => setScanner(e.target.value)} />
            </div>
          </div>
        </div>
      ) : (
        <UploadProgress snap={snap} />
      )}
    </Dialog>
  );
}

function UploadProgress({ snap }: { snap: UploadSnapshot }) {
  const received = snap.size ? snap.receivedBytes / snap.size : 0;
  const nextChunk = snap.chunkSize ? Math.floor(snap.receivedBytes / snap.chunkSize) : 0;
  return (
    <div className="space-y-4" data-testid="upload-progress" data-phase={snap.phase}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="font-bold text-ink">{snap.fileName}</p>
        <p className="text-small text-graphite">
          {formatBytes(snap.size)}
          {snap.kind ? ` · ${snap.kind === "wsi" ? "whole-slide image" : "field image"}` : ""}
        </p>
      </div>
      <Bar value={snap.size ? snap.hashBytes / snap.size : 0} label={`1. Checksum in this browser (${snap.hashMethod === "streaming" ? "streaming SHA-256: file too large for one Web Crypto call" : snap.hashMethod === "webcrypto" ? "Web Crypto SHA-256" : "SHA-256"})`} />
      {snap.sha256 ? <p className="break-all font-mono text-micro text-graphite">sha256 {snap.sha256}</p> : null}
      <Bar value={received} label={`2. Transfer: chunk ${Math.min(nextChunk + (received < 1 ? 1 : 0), snap.totalChunks)} of ${snap.totalChunks || "?"} · ${formatBytes(snap.receivedBytes)} received${snap.bytesPerSecond ? ` · ${formatBytes(snap.bytesPerSecond)}/s` : ""}`} />
      {snap.resumed ? (
        <Notice tone="info" role="status">
          Resumed: the server already had {formatBytes(snap.receivedBytes)} of this file, so those chunks were not sent again.
        </Notice>
      ) : null}
      {snap.identifierRisk.length > 0 ? (
        <Notice tone="warning" title="Identifier-risk flags on this file" role="status">
          <ul className="list-disc pl-4">
            {snap.identifierRisk.map((f) => (
              <li key={f.code}>
                {f.detail}: {f.message}.
              </li>
            ))}
          </ul>
        </Notice>
      ) : null}
      <ol className="space-y-1 text-small" aria-label="Upload steps">
        {[
          ["hashing", "Checksum"],
          ["initializing", "Duplicate and limit checks"],
          ["uploading", "Chunked transfer"],
          ["completing", "Server verifies the whole-file checksum"],
          ["ingesting", "Ingest job (OpenSlide, metadata, thumbnail, QC screen)"],
        ].map(([p, label]) => {
          const orderP = ["hashing", "initializing", "uploading", "paused", "completing", "ingesting", "done"];
          const cur = orderP.indexOf(snap.phase === "paused" ? "uploading" : snap.phase);
          const idx = orderP.indexOf(p);
          const state = snap.phase === "done" || cur > idx ? "done" : cur === idx ? "current" : "waiting";
          return (
            <li key={p} className="flex items-center gap-2">
              <span aria-hidden className={cn("h-2.5 w-2.5 rounded-full", state === "done" ? "bg-approved" : state === "current" ? "bg-teal" : "bg-line-strong")} />
              <span className={state === "waiting" ? "text-graphite" : "text-ink"}>{label}</span>
              <span className="sr-only">{state}</span>
            </li>
          );
        })}
      </ol>
      {snap.phase === "paused" ? (
        <Notice tone="warning" title="Paused" role="status">
          {formatBytes(snap.receivedBytes)} are safely on the server. Resume now, or reload the page later and select the same file to continue from here.
        </Notice>
      ) : null}
      {snap.phase === "duplicate" ? (
        <Notice tone="warning" title="Already in this project: nothing was ingested again" role="status">
          A slide with the same SHA-256 exists.{" "}
          {snap.duplicateOf ? (
            <Link className="font-semibold text-teal-deep underline" href={`/review/${snap.duplicateOf}`}>
              Open the existing slide
            </Link>
          ) : null}
        </Notice>
      ) : null}
      {snap.phase === "failed" ? (
        <Notice tone="error" title="Upload failed" role="alert">
          {snap.error}
          {snap.errorCode ? <span className="block font-mono text-micro">{snap.errorCode}</span> : null}
        </Notice>
      ) : null}
      {snap.phase === "canceled" ? <Notice tone="neutral">Upload canceled. The partial data was discarded on the server.</Notice> : null}
      {snap.job ? (
        <div className="rounded-[var(--radius-control)] border border-line bg-sheet px-3 py-2 text-small" role="status" data-testid="upload-job">
          <p>
            <span className="font-semibold">Ingest job:</span> {snap.job.status}
            {snap.job.progress_message ? ` · ${snap.job.progress_message}` : ""}
          </p>
          {snap.job.status === "queued" ? <p className="text-graphite">Waiting for the worker (python -m dermpath.worker).</p> : null}
          {snap.job.error ? <p className="mt-1 text-rust">{snap.job.error}</p> : null}
        </div>
      ) : null}
      {snap.phase === "done" && snap.slideId ? (
        <Notice tone={snap.job?.status === "failed" ? "error" : "success"} title={snap.job?.status === "failed" ? "Stored, but the ingest failed" : "Ingested"} role="status">
          {snap.job?.status === "failed"
            ? "The file is kept but is not viewable or eligible for any dataset. The readable error is in the worklist."
            : "The slide is in the worklist as imported. Route it for review when ready."}{" "}
          <Link className="font-semibold text-teal-deep underline" href={`/review/${snap.slideId}`}>
            Open in Slide Review
          </Link>
        </Notice>
      ) : null}
    </div>
  );
}
