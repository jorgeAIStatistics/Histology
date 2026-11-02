// Starts the FastAPI backend and the job worker for the Playwright run, in a throw-away data directory.
//
//   WB_VAR_DIR      a fresh temporary directory (removed when this process exits)
//   WB_CORS_ORIGINS the test web origins (state-changing requests carry Origin through the Next rewrite)
//   port            E2E_API_PORT (default 8811), passed to uvicorn --port (the API has no port env var)
//
// The worker starts only after /api/v1/health answers, because the first API start seeds the demo
// (and the ML pipeline-test records) in-process; a second worker during seeding could race it.
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const apiDir = path.resolve(here, "../../../api");
const py = path.join(apiDir, ".venv/bin/python");
const port = process.env.E2E_API_PORT ?? "8811";
const webPort = process.env.E2E_WEB_PORT ?? "3611";
const varDir = mkdtempSync(path.join(tmpdir(), "wb-e2e-"));

const env = {
  ...process.env,
  WB_VAR_DIR: varDir,
  WB_CORS_ORIGINS: `http://127.0.0.1:${webPort},http://localhost:${webPort}`,
  // Small chunks so the browser upload test exercises several chunks, pause and resume.
  WB_UPLOAD_CHUNK_BYTES: process.env.WB_UPLOAD_CHUNK_BYTES ?? "65536",
  WB_WORKER_POLL_SECONDS: "0.3",
  PYTHONUNBUFFERED: "1",
};

console.log(`[e2e-backend] data dir ${varDir}`);
// Recorded for global-teardown.ts, which removes it even if this process is killed outright.
const ledgerDir = path.resolve(here, "../../test-results");
mkdirSync(ledgerDir, { recursive: true });
appendFileSync(path.join(ledgerDir, ".e2e-var-dirs"), `${varDir}\n`);
const children = [];
const api = spawn(py, ["-m", "uvicorn", "dermpath.main:app", "--host", "127.0.0.1", "--port", port, "--log-level", "warning"], { cwd: apiDir, env, stdio: "inherit" });
children.push(api);

let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const c of children) {
    try {
      c.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  }
  setTimeout(() => {
    for (const c of children) {
      try {
        c.kill("SIGKILL");
      } catch {
        /* gone */
      }
    }
    try {
      rmSync(varDir, { recursive: true, force: true });
      console.log(`[e2e-backend] removed ${varDir}`);
    } catch (err) {
      console.error(`[e2e-backend] could not remove ${varDir}: ${err}`);
    }
    process.exit(code);
  }, 1500);
}
process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));
process.on("exit", () => {
  try {
    rmSync(varDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});
api.on("exit", (c) => {
  if (!stopping) {
    console.error(`[e2e-backend] API exited (${c})`);
    stop(1);
  }
});

async function waitHealthy() {
  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/v1/health`);
      if (r.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

if (await waitHealthy()) {
  const worker = spawn(py, ["-m", "dermpath.worker", "--poll", "0.3"], { cwd: apiDir, env, stdio: "inherit" });
  children.push(worker);
  worker.on("exit", (c) => !stopping && console.error(`[e2e-backend] worker exited (${c})`));
  console.log("[e2e-backend] API healthy; worker started");
} else {
  console.error("[e2e-backend] API did not become healthy");
  stop(1);
}
