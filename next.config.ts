import type { NextConfig } from "next";
import fs from "node:fs";
import path from "node:path";

// Separate build folders let several local checks run side by side (tests, captures).
const distDir = process.env.NEXT_DIST_DIR || ".next";

// Next adds "<distDir>/types/**/*.ts" to the tsconfig it type-checks with. For any
// folder other than .next that would rewrite the committed tsconfig.json, so those
// builds use a generated, gitignored tsconfig.alt.json that extends it instead.
let tsconfigPath: string | undefined;
if (distDir !== ".next") {
  tsconfigPath = "tsconfig.alt.json";
  const file = path.resolve(tsconfigPath);
  if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify({ extends: "./tsconfig.json" }, null, 2) + "\n");
}

const nextConfig: NextConfig = {
  // better-sqlite3 is a native module; keep it out of the server bundle.
  serverExternalPackages: ["better-sqlite3"],
  distDir,
  ...(tsconfigPath ? { typescript: { tsconfigPath } } : {}),
  // Pin the workspace root (a stray lockfile exists in the home folder).
  turbopack: { root: path.resolve(".") },
  poweredByHeader: false,
  devIndicators: false,
  // Do not let `next dev` write AGENTS.md / CLAUDE.md into the project.
  agentRules: false,
};

export default nextConfig;
