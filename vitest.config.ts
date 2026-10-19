import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  test: {
    include: ["tests/domain/**/*.test.ts"],
    environment: "node",
    pool: "forks",
    testTimeout: 20000,
    // Domain tests exercise the synthetic demo; tests of the locked mode set HLOS_MODE themselves.
    // HLOS_AUDIT_KEY: a secured build is locked without an audit key (Stage 6 Phase C), so the secured-mode
    // tests need one. A fixed, synthetic, test-only value (public: it is in this file); demo mode ignores it.
    env: { HLOS_MODE: "demo", HLOS_AUDIT_KEY: "hlos-vitest-synthetic-audit-key-not-secret-0001" },
  },
});
