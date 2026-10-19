import { defineConfig, devices } from "@playwright/test";

// Browser acceptance tests run against a production build on its own port,
// build folder and database, so they never touch the presenter's demo data.
// E2E_TAG lets two runs coexist (own port, build folder and database).
const PORT = Number(process.env.E2E_PORT || 3210);
const TAG = process.env.E2E_TAG ? `-${process.env.E2E_TAG}` : "";
const DIST = `.next-e2e${TAG}`;
const DB = `data/e2e${TAG}.db`;

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"], ["html", { open: "never", outputFolder: `playwright-report${TAG}` }]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    viewport: { width: 1366, height: 768 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1366, height: 768 } } }],
  webServer: {
    command: `rm -f ${DB} ${DB}-wal ${DB}-shm && node scripts/gen-schema-module.mjs && NEXT_DIST_DIR=${DIST} HLOS_DB_PATH=${DB} npx next build && NEXT_DIST_DIR=${DIST} HLOS_DB_PATH=${DB} npx next start -p ${PORT}`,
    url: `http://localhost:${PORT}/api/live`,
    timeout: 300_000,
    reuseExistingServer: false,
    env: { NEXT_DIST_DIR: DIST, HLOS_DB_PATH: DB },
  },
});
