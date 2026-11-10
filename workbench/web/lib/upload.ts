// Resumable chunked upload against the API protocol in dermpath/uploads.py:
//   POST /projects/{pid}/uploads  {filename,size,sha256,...} → {upload_id, chunk_size, received_bytes, next_chunk_index}
//   PUT  /uploads/{id}/chunks/{i} raw bytes + X-Chunk-SHA256   (sequential, idempotent re-send)
//   GET  /uploads/{id}            resume offset
//   POST /uploads/{id}/complete   whole-file sha256 verified server side → slide + ingest job
// The session is remembered in localStorage so a reload can resume: the user re-selects the same file
// and the server returns the existing upload (same user, sha256 and size) with its received offset.

import { api, ApiError } from "./api";
import { Sha256, toHex, WEBCRYPTO_WHOLE_FILE_LIMIT } from "./sha256";
import type { IdentifierFlag, Job } from "./types";

export type UploadPhase =
  | "hashing"
  | "initializing"
  | "uploading"
  | "paused"
  | "completing"
  | "ingesting"
  | "done"
  | "duplicate"
  | "failed"
  | "canceled";

export type UploadTarget = {
  provenance: "public_cc0" | "real_authorized";
  governance_attestation: boolean;
  block_id?: string;
  new_hierarchy?: {
    patient_code: string;
    accession_code: string;
    part_designation: string;
    block_designation: string;
    collected_on?: string;
    site_id?: string;
    anatomic_site_text?: string;
  };
  level_index?: number;
  stain?: string;
  scanner_id?: string;
};

export type UploadSnapshot = {
  phase: UploadPhase;
  fileName: string;
  size: number;
  hashBytes: number;
  hashMethod: "webcrypto" | "streaming" | null;
  sha256: string | null;
  uploadId: string | null;
  resumed: boolean;
  receivedBytes: number;
  chunkSize: number;
  totalChunks: number;
  identifierRisk: IdentifierFlag[];
  slideId: string | null;
  duplicateOf: string | null;
  job: Job | null;
  error: string | null;
  errorCode: string | null;
  bytesPerSecond: number | null;
  kind: string | null;
};

type UploadResponse = {
  upload_id: string;
  status: "receiving" | "completed" | "duplicate" | "failed" | "canceled";
  chunk_size: number;
  received_bytes: number;
  next_chunk_index: number;
  total_chunks: number;
  kind: string;
  identifier_risk: IdentifierFlag[];
  slide_id: string | null;
  duplicate_of_slide_id: string | null;
  job_id: string | null;
  error: string | null;
  resumed?: boolean;
};

export type StoredUpload = {
  uploadId: string;
  projectId: string;
  name: string;
  size: number;
  lastModified: number;
  sha256: string;
  receivedBytes: number;
  savedAt: string;
};

const STORE_KEY = "wb.uploads";

export function readStoredUploads(projectId: string): StoredUpload[] {
  try {
    const all = JSON.parse(window.localStorage.getItem(STORE_KEY) ?? "[]") as StoredUpload[];
    return all.filter((u) => u.projectId === projectId);
  } catch {
    return [];
  }
}

function writeStored(update: (all: StoredUpload[]) => StoredUpload[]) {
  try {
    const all = JSON.parse(window.localStorage.getItem(STORE_KEY) ?? "[]") as StoredUpload[];
    window.localStorage.setItem(STORE_KEY, JSON.stringify(update(all)));
  } catch {
    /* storage unavailable: resume after reload still works because the server matches sha256 + size */
  }
}

export function forgetStoredUpload(uploadId: string) {
  writeStored((all) => all.filter((u) => u.uploadId !== uploadId));
}

function hasWebCrypto(): boolean {
  return typeof crypto !== "undefined" && Boolean(crypto.subtle);
}

export async function sha256Blob(blob: Blob): Promise<string> {
  if (hasWebCrypto()) return toHex(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()));
  return new Sha256().update(new Uint8Array(await blob.arrayBuffer())).digestHex();
}

export async function sha256File(file: File, onProgress: (bytes: number) => void, signal?: AbortSignal): Promise<{ hex: string; method: "webcrypto" | "streaming" }> {
  if (hasWebCrypto() && file.size <= WEBCRYPTO_WHOLE_FILE_LIMIT) {
    const buf = await file.arrayBuffer();
    const hex = toHex(await crypto.subtle.digest("SHA-256", buf));
    onProgress(file.size);
    return { hex, method: "webcrypto" };
  }
  const h = new Sha256();
  const step = 8 * 1024 * 1024;
  for (let off = 0; off < file.size; off += step) {
    if (signal?.aborted) throw new DOMException("aborted", "AbortError");
    h.update(new Uint8Array(await file.slice(off, Math.min(off + step, file.size)).arrayBuffer()));
    onProgress(Math.min(off + step, file.size));
  }
  return { hex: h.digestHex(), method: "streaming" };
}

export class ChunkedUpload {
  snap: UploadSnapshot;
  private ctrl: AbortController | null = null;
  private stopRequested = false;

  constructor(
    private projectId: string,
    private file: File,
    private target: UploadTarget,
    private onChange: (s: UploadSnapshot) => void,
    private knownSha256: string | null = null,
  ) {
    this.snap = {
      phase: "hashing",
      fileName: file.name,
      size: file.size,
      hashBytes: 0,
      hashMethod: null,
      sha256: null,
      uploadId: null,
      resumed: false,
      receivedBytes: 0,
      chunkSize: 0,
      totalChunks: 0,
      identifierRisk: [],
      slideId: null,
      duplicateOf: null,
      job: null,
      error: null,
      errorCode: null,
      bytesPerSecond: null,
      kind: null,
    };
  }

  private set(patch: Partial<UploadSnapshot>) {
    this.snap = { ...this.snap, ...patch };
    this.onChange(this.snap);
  }

  private fail(err: unknown) {
    const e = err as ApiError;
    this.set({ phase: "failed", error: e?.message ?? String(err), errorCode: e instanceof ApiError ? e.code : null });
  }

  async start(): Promise<void> {
    this.stopRequested = false;
    this.ctrl = new AbortController();
    try {
      let sha = this.knownSha256;
      if (!sha) {
        this.set({ phase: "hashing" });
        const r = await sha256File(this.file, (b) => this.set({ hashBytes: b }), this.ctrl.signal);
        sha = r.hex;
        this.set({ hashMethod: r.method });
      } else {
        this.set({ hashBytes: this.file.size, hashMethod: null });
      }
      this.set({ sha256: sha, phase: "initializing" });
      let res: UploadResponse;
      try {
        res = await api<UploadResponse>(`/projects/${this.projectId}/uploads`, {
          method: "POST",
          body: { filename: this.file.name, size: this.file.size, sha256: sha, ...this.target },
        });
      } catch (err) {
        if (err instanceof ApiError && err.code === "duplicate_slide") {
          this.set({ phase: "duplicate", duplicateOf: String(err.details?.existing_slide_id ?? ""), error: err.message, errorCode: err.code });
          return;
        }
        throw err;
      }
      this.set({
        uploadId: res.upload_id,
        resumed: Boolean(res.resumed),
        receivedBytes: res.received_bytes,
        chunkSize: res.chunk_size,
        totalChunks: res.total_chunks,
        identifierRisk: res.identifier_risk ?? [],
        kind: res.kind,
      });
      this.remember();
      await this.sendChunks();
    } catch (err) {
      if ((err as Error)?.name === "AbortError") {
        if (this.snap.phase !== "canceled") this.set({ phase: "paused" });
        return;
      }
      this.fail(err);
    }
  }

  private remember() {
    if (!this.snap.uploadId || !this.snap.sha256) return;
    const entry: StoredUpload = {
      uploadId: this.snap.uploadId,
      projectId: this.projectId,
      name: this.file.name,
      size: this.file.size,
      lastModified: this.file.lastModified,
      sha256: this.snap.sha256,
      receivedBytes: this.snap.receivedBytes,
      savedAt: new Date().toISOString(),
    };
    writeStored((all) => [...all.filter((u) => u.uploadId !== entry.uploadId), entry]);
  }

  private async sendChunks(): Promise<void> {
    const id = this.snap.uploadId!;
    this.set({ phase: "uploading", error: null, errorCode: null });
    const started = performance.now();
    let sentThisSession = 0;
    while (this.snap.receivedBytes < this.file.size) {
      if (this.stopRequested) {
        this.set({ phase: "paused" });
        return;
      }
      const index = Math.floor(this.snap.receivedBytes / this.snap.chunkSize);
      const from = index * this.snap.chunkSize;
      const to = Math.min(from + this.snap.chunkSize, this.file.size);
      const blob = this.file.slice(from, to);
      const chunkSha = await sha256Blob(blob);
      let attempt = 0;
      for (;;) {
        try {
          const r = await api<UploadResponse>(`/uploads/${id}/chunks/${index}`, {
            method: "PUT",
            rawBody: blob,
            headers: { "Content-Type": "application/octet-stream", "X-Chunk-SHA256": chunkSha },
            signal: this.ctrl?.signal,
          });
          sentThisSession += to - from;
          const secs = (performance.now() - started) / 1000;
          this.set({ receivedBytes: r.received_bytes, bytesPerSecond: secs > 0 ? sentThisSession / secs : null });
          this.remember();
          break;
        } catch (err) {
          if ((err as Error)?.name === "AbortError") throw err;
          if (err instanceof ApiError && (err.code === "out_of_order_chunk" || err.code === "chunk_conflict")) {
            const cur = await api<UploadResponse>(`/uploads/${id}`);
            this.set({ receivedBytes: cur.received_bytes });
            break;
          }
          const transient = !(err instanceof ApiError) || err.status === 0 || err.status >= 500 || err.code === "chunk_checksum_mismatch" || err.code === "chunk_length_mismatch";
          attempt += 1;
          if (!transient || attempt > 3) throw err;
          await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
        }
      }
    }
    await this.complete();
  }

  private async complete() {
    const id = this.snap.uploadId!;
    this.set({ phase: "completing" });
    const r = await api<UploadResponse>(`/uploads/${id}/complete`, { method: "POST" });
    forgetStoredUpload(id);
    if (r.status === "duplicate") {
      this.set({ phase: "duplicate", duplicateOf: r.duplicate_of_slide_id });
      return;
    }
    this.set({ phase: "ingesting", slideId: r.slide_id });
    if (r.job_id) {
      for (let i = 0; i < 600; i++) {
        const job = await api<Job>(`/jobs/${r.job_id}`);
        this.set({ job });
        if (["succeeded", "failed", "canceled"].includes(job.status)) break;
        await new Promise((res) => setTimeout(res, 700));
      }
    }
    this.set({ phase: "done" });
  }

  /** Interrupt the transfer (the current chunk is aborted; the server keeps everything received). */
  pause() {
    this.stopRequested = true;
    this.ctrl?.abort();
    this.set({ phase: "paused" });
  }

  async resume() {
    if (!this.snap.uploadId) return this.start();
    this.stopRequested = false;
    this.ctrl = new AbortController();
    try {
      const cur = await api<UploadResponse>(`/uploads/${this.snap.uploadId}`);
      this.set({ receivedBytes: cur.received_bytes, resumed: true });
      if (cur.status !== "receiving") {
        this.set({ phase: cur.status === "duplicate" ? "duplicate" : "failed", error: cur.error ?? `Upload is ${cur.status}` });
        return;
      }
      await this.sendChunks();
    } catch (err) {
      if ((err as Error)?.name === "AbortError") {
        this.set({ phase: "paused" });
        return;
      }
      this.fail(err);
    }
  }

  async cancel() {
    this.stopRequested = true;
    this.ctrl?.abort();
    if (this.snap.uploadId) {
      try {
        await api(`/uploads/${this.snap.uploadId}`, { method: "DELETE" });
      } catch {
        /* already finished or gone */
      }
      forgetStoredUpload(this.snap.uploadId);
    }
    this.set({ phase: "canceled" });
  }
}
