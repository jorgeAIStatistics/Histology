import { defineConfig, devices } from "@playwright/test";

// Browser acceptance tests run against a production build on its own port,
// build folder and database, so they never touch the presenter's demo data.
const PORT = Number(process.env.E2E_PORT || 3210);

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    viewport: { width: 1366, height: 768 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1366, height: 768 } } }],
  webServer: {
    command: `rm -f data/e2e.db data/e2e.db-wal data/e2e.db-shm && node scripts/gen-schema-module.mjs && NEXT_DIST_DIR=.next-e2e HLOS_DB_PATH=data/e2e.db npx next build && NEXT_DIST_DIR=.next-e2e HLOS_DB_PATH=data/e2e.db npx next start -p ${PORT}`,
    url: `http://localhost:${PORT}/api/live`,
    timeout: 300_000,
    reuseExistingServer: false,
    env: { NEXT_DIST_DIR: ".next-e2e", HLOS_DB_PATH: "data/e2e.db" },
  },
});
