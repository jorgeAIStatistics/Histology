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

// Security headers on every response. HSTS only when the public URL is https: it would be
// meaningless (and is ignored by browsers) on plain http, and it must never pin a local demo.
// next.config.ts is evaluated when the build is made, so HLOS_PUBLIC_URL at BUILD time decides HSTS.
// The CSP only forbids framing; it does not restrict scripts, so `next dev` and HMR are unaffected.
const httpsPublicUrl = (() => {
  try {
    return new URL(process.env.HLOS_PUBLIC_URL ?? "").protocol === "https:";
  } catch {
    return false;
  }
})();
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "same-origin" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  { key: "X-Frame-Options", value: "DENY" },
  ...(httpsPublicUrl ? [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" }] : []),
];

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
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
