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
    env: { HLOS_MODE: "demo" },
  },
});
