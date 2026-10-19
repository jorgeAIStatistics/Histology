import crypto from "node:crypto";
import { defineConfig, devices } from "@playwright/test";

// Browser acceptance tests run against a production build on its own port,
// build folder and database, so they never touch the presenter's demo data.
// E2E_TAG lets two runs coexist (own port, build folder and database).
const PORT = Number(process.env.E2E_PORT || 3210);
const TAG = process.env.E2E_TAG ? `-${process.env.E2E_TAG}` : "";
const DIST = `.next-e2e${TAG}`;
const DB = `data/e2e${TAG}.db`;

// Test-only source-message fixtures (POST /api/test/fixtures, src/server/test-fixtures.ts):
// one random token per run. This file is evaluated first by the runner process, which
// sets the variable before it starts the web server and the workers; both inherit it,
// and a worker evaluating this file again finds it set and keeps it. The token never
// leaves this machine and changes on every run.
if (!process.env.HLOS_TEST_FIXTURE_TOKEN) process.env.HLOS_TEST_FIXTURE_TOKEN = crypto.randomBytes(24).toString("hex");
const FIXTURE_TOKEN = process.env.HLOS_TEST_FIXTURE_TOKEN;
if (!/^[A-Za-z0-9_-]{32,256}$/.test(FIXTURE_TOKEN)) {
  throw new Error("HLOS_TEST_FIXTURE_TOKEN must be 32 to 256 letters, digits, '-' or '_' (leave it unset to get a random one per run).");
}

// The integration simulator's signed inbound endpoint (POST /api/integration/inbound, src/server/integration/inbound.ts)
// for tests/e2e/integration.spec.ts: switched on for this demo-mode test server only, with a random root secret per
// run (generated here like the fixture token, inherited by the web server and the workers; never a real credential).
// The endpoint accepts only simulated source adapters and is a 404 in secured and locked mode whatever is set.
if (!process.env.HLOS_INTEGRATION_SIM_SECRET) process.env.HLOS_INTEGRATION_SIM_SECRET = crypto.randomBytes(32).toString("hex");
const SIM_SECRET = process.env.HLOS_INTEGRATION_SIM_SECRET;
if (!/^[A-Za-z0-9_-]{32,256}$/.test(SIM_SECRET)) {
  throw new Error("HLOS_INTEGRATION_SIM_SECRET must be 32 to 256 letters, digits, '-' or '_' (leave it unset to get a random one per run).");
}
// What the integration spec reads (read only) to build the simulator's synthetic world: this run's database file.
process.env.E2E_DB = DB;

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"], ["html", { open: "never", outputFolder: `playwright-report${TAG}` }]],
  // Failure screenshots and traces per run tag too (inside the ignored test-results folder), so two runs never clear each other's.
  outputDir: `test-results/e2e${TAG}`,
  use: {
    baseURL: `http://localhost:${PORT}`,
    viewport: { width: 1366, height: 768 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1366, height: 768 } } }],
  webServer: {
    command: `rm -f ${DB} ${DB}-wal ${DB}-shm && node scripts/gen-schema-module.mjs && NEXT_DIST_DIR=${DIST} HLOS_DB_PATH=${DB} npx next build && HLOS_MODE=demo HLOS_TEST_FIXTURES=1 HLOS_TEST_FIXTURE_TOKEN=${FIXTURE_TOKEN} HLOS_INTEGRATION_SIMULATOR=1 HLOS_INTEGRATION_SIM_SECRET=${SIM_SECRET} NEXT_DIST_DIR=${DIST} HLOS_DB_PATH=${DB} npx next start -p ${PORT}`,
    url: `http://localhost:${PORT}/api/live`,
    timeout: 300_000,
    reuseExistingServer: false,
    env: {
      NEXT_DIST_DIR: DIST,
      HLOS_DB_PATH: DB,
      HLOS_MODE: "demo",
      HLOS_TEST_FIXTURES: "1",
      HLOS_TEST_FIXTURE_TOKEN: FIXTURE_TOKEN,
      HLOS_INTEGRATION_SIMULATOR: "1",
      HLOS_INTEGRATION_SIM_SECRET: SIM_SECRET,
    },
  },
});
