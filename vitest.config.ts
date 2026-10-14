import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  test: {
    include: ["tests/domain/**/*.test.ts"],
    environment: "node",
    pool: "forks",
    testTimeout: 20000,
  },
});
