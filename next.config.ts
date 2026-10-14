import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  // better-sqlite3 is a native module; keep it out of the server bundle.
  serverExternalPackages: ["better-sqlite3"],
  // Separate build folders let several local checks run side by side.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  // Pin the workspace root (a stray lockfile exists in the home folder).
  turbopack: { root: path.resolve(".") },
  poweredByHeader: false,
  devIndicators: false,
  // Do not let `next dev` write AGENTS.md / CLAUDE.md into the project.
  agentRules: false,
};

export default nextConfig;
