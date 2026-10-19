import crypto from "node:crypto";
import { defineConfig, devices } from "@playwright/test";

// SECURED-mode browser suite (npm run test:e2e:secured): the real OpenID Connect sign-in against a local
// oidc-provider, the lock screen, hand-over, re-authentication and sign-out. Synthetic data only; everything
// runs on this machine (loopback) and no credential is real.
//
// Web servers, started in this order (Playwright starts them one after another):
// 1. tests/support/oidc-provider.mjs on 127.0.0.1:<E2E_OIDC_PORT>: synthetic test accounts kim, maya, admin,
//    auditor, stranger (not linked) and otherlab (lab claim names another lab).
// 2. The app, built into its own folder, with its own database, started with HLOS_MODE=secured: the database is
//    the synthetic seed plus two synthetic test staff (tests/support/secured-db.ts, as HLOS_SEED_SYNTHETIC=1
//    would load it), and the test identities are linked with the admin CLI (scripts/admin.ts) before
//    `next start`, the only way anyone can sign in.
// 3. The same build on another port whose issuer is a closed loopback port: the identity provider is
//    unavailable there (sign-in must fail closed and show no data).
//
// Own tag, ports, build folder and database (E2E_SECURED_TAG, E2E_SECURED_PORT; the provider and the second
// instance take the next ports unless E2E_OIDC_PORT / E2E_SECURED_DOWN_PORT say otherwise), so it never touches
// the demo suite's or the presenter's data.
const TAG = process.env.E2E_SECURED_TAG || "secured";
if (!/^[A-Za-z0-9_-]{1,40}$/.test(TAG)) throw new Error("E2E_SECURED_TAG must be letters, digits, '-' or '_'.");
const PORT = Number(process.env.E2E_SECURED_PORT || 3330);
const OIDC_PORT = Number(process.env.E2E_OIDC_PORT || PORT + 1);
const DOWN_PORT = Number(process.env.E2E_SECURED_DOWN_PORT || PORT + 2);
/** Nothing listens here: the second instance's identity provider. */
const DEAD_PORT = Number(process.env.E2E_DEAD_ISSUER_PORT || PORT + 3);
const DIST = `.next-e2e-${TAG}`;
const DB = `data/e2e-${TAG}.db`;
const APP = `http://localhost:${PORT}`;
const DOWN_APP = `http://localhost:${DOWN_PORT}`;
const ISSUER = `http://127.0.0.1:${OIDC_PORT}`;
const DEAD_ISSUER = `http://127.0.0.1:${DEAD_PORT}`;
const LAB = "lab:local";
const CLIENT_ID = "hlos-e2e-secured";

// Random per run (never real credentials). This file is evaluated first by the runner, which sets them before
// it starts the web servers and the workers; both inherit them, and a worker evaluating this file again keeps them.
if (!process.env.E2E_SECURED_CLIENT_SECRET) process.env.E2E_SECURED_CLIENT_SECRET = crypto.randomBytes(32).toString("hex");
if (!process.env.E2E_SECURED_SESSION_SECRET) process.env.E2E_SECURED_SESSION_SECRET = crypto.randomBytes(32).toString("hex");
// A secured build is locked without an audit key (Stage 6 Phase C): random per run, test only.
if (!process.env.E2E_SECURED_AUDIT_KEY) process.env.E2E_SECURED_AUDIT_KEY = crypto.randomBytes(32).toString("hex");
const CLIENT_SECRET = process.env.E2E_SECURED_CLIENT_SECRET;
const SESSION_SECRET = process.env.E2E_SECURED_SESSION_SECRET;
const AUDIT_KEY = process.env.E2E_SECURED_AUDIT_KEY;

/** Synthetic login -> staff member. "stranger" is deliberately not linked; "otherlab" is linked but its lab claim is another lab's. */
const LINKS: [login: string, staffId: string][] = [
  ["kim", "stf_kim"],
  ["maya", "stf_maya"],
  ["admin", "stf_test_admin"],
  ["auditor", "stf_test_auditor"],
  ["otherlab", "stf_luis"],
];

// What the spec files need to know (they read these; never secrets other than the per-run test values).
process.env.E2E_SECURED_DB = DB;
process.env.E2E_SECURED_ISSUER = ISSUER;
process.env.E2E_SECURED_DOWN_URL = DOWN_APP;

const appEnv = (publicUrl: string, issuer: string): Record<string, string> => ({
  NEXT_DIST_DIR: DIST,
  HLOS_DB_PATH: DB,
  HLOS_MODE: "secured",
  HLOS_SEED_SYNTHETIC: "1",
  HLOS_OIDC_ISSUER: issuer,
  HLOS_OIDC_ALLOW_INSECURE_LOOPBACK: "1",
  HLOS_OIDC_CLIENT_ID: CLIENT_ID,
  HLOS_OIDC_CLIENT_SECRET: CLIENT_SECRET,
  HLOS_PUBLIC_URL: publicUrl,
  HLOS_LAB_ID: LAB,
  HLOS_OIDC_LAB_CLAIM: "hlos_labs",
  HLOS_SESSION_SECRET: SESSION_SECRET,
  HLOS_AUDIT_KEY: AUDIT_KEY,
  // Short enough to matter in a test; the client idle timer is driven with Playwright's clock.
  HLOS_SESSION_IDLE_MIN: "2",
  HLOS_REAUTH_MAX_AGE_MIN: "5",
});

// Iterating locally against servers you started yourself with the same environment: E2E_SECURED_REUSE=1.
const REUSE = process.env.E2E_SECURED_REUSE === "1";

const link = ([login, staffId]: [string, string]) => `npx tsx scripts/admin.ts link-identity ${staffId} --issuer ${ISSUER} --subject ${login} --lab ${LAB}`;

export default defineConfig({
  testDir: "tests/e2e-secured",
  timeout: 90_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"], ["html", { open: "never", outputFolder: `playwright-report-${TAG}` }]],
  outputDir: `test-results/e2e-${TAG}`,
  use: {
    baseURL: APP,
    viewport: { width: 1366, height: 768 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1366, height: 768 } } }],
  webServer: [
    {
      command: "node tests/support/oidc-provider.mjs",
      url: `${ISSUER}/.well-known/openid-configuration`,
      timeout: 30_000,
      reuseExistingServer: REUSE,
      env: { OIDC_PORT: String(OIDC_PORT), OIDC_APP_URLS: `${APP},${DOWN_APP}`, OIDC_CLIENT_ID: CLIENT_ID, OIDC_CLIENT_SECRET: CLIENT_SECRET, OIDC_LAB_ID: LAB },
    },
    {
      command: [
        `rm -f ${DB} ${DB}-wal ${DB}-shm`,
        "node scripts/gen-schema-module.mjs",
        "npx next build",
        "npx tsx tests/support/secured-db.ts",
        ...LINKS.map(link),
        `npx next start -p ${PORT}`,
      ].join(" && "),
      url: `${APP}/signin`,
      timeout: 300_000,
      reuseExistingServer: REUSE,
      env: appEnv(APP, ISSUER),
    },
    {
      command: `npx next start -p ${DOWN_PORT}`,
      url: `${DOWN_APP}/signin`,
      timeout: 60_000,
      reuseExistingServer: REUSE,
      env: appEnv(DOWN_APP, DEAD_ISSUER),
    },
  ],
});
