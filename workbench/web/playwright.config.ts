import { defineConfig } from "@playwright/test";

// Browser tests against the REAL stack: FastAPI + worker (temporary data dir, seeded demo) and a
// production Next build that proxies /api/v1 to that API. Nothing is mocked.
const API_PORT = process.env.E2E_API_PORT ?? "8811";
const WEB_PORT = process.env.E2E_WEB_PORT ?? "3611";
const BASE = `http://127.0.0.1:${WEB_PORT}`;
const screenshots = process.env.WB_SCREENSHOTS === "1";

export default defineConfig({
  testDir: "./tests/e2e",
  // One shared seeded database: run serially so tests do not trample each other's slides.
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  retries: 0,
  reporter: [["list"], ["json", { outputFile: "test-results/e2e-results.json" }]],
  globalTeardown: "./tests/e2e/global-teardown.ts",
  outputDir: "test-results/artifacts",
  use: {
    baseURL: BASE,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    colorScheme: "light",
  },
  projects: screenshots
    ? [{ name: "screenshots", testMatch: /screenshots\.spec\.ts/, use: { viewport: { width: 1440, height: 900 } } }]
    : [
        { name: "desktop-1440", testIgnore: /screenshots\.spec\.ts/, use: { viewport: { width: 1440, height: 900 } } },
        { name: "tablet-1024", testIgnore: /screenshots\.spec\.ts/, grep: /@tablet/, use: { viewport: { width: 1024, height: 768 } } },
      ],
  webServer: [
    {
      command: "node tests/e2e/start-backend.mjs",
      url: `http://127.0.0.1:${API_PORT}/api/v1/health`,
      gracefulShutdown: { signal: "SIGTERM", timeout: 4000 },
      timeout: 240_000,
      reuseExistingServer: false,
      stdout: "pipe",
      stderr: "pipe",
      env: { E2E_API_PORT: API_PORT, E2E_WEB_PORT: WEB_PORT },
    },
    {
      command: `npx next build && npx next start -p ${WEB_PORT} -H 127.0.0.1`,
      url: BASE,
      timeout: 300_000,
      reuseExistingServer: false,
      stdout: "pipe",
      stderr: "pipe",
      env: { WB_API_URL: `http://127.0.0.1:${API_PORT}`, NEXT_TELEMETRY_DISABLED: "1" },
    },
  ],
});
