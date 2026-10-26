import path from "node:path";
import type { NextConfig } from "next";

// The browser talks only to this app's origin; /api/v1/* is proxied to the FastAPI backend so the
// HttpOnly session cookie and the signed tile URLs stay same-origin. WB_API_URL defaults to the local API.
const API = process.env.WB_API_URL ?? "http://127.0.0.1:8000";

// This app lives inside the Histology Lab OS repository; pin the root so Turbopack never picks up the
// root app's files (for example its src/proxy.ts).
const ROOT = path.resolve(__dirname);

const nextConfig: NextConfig = {
  turbopack: { root: ROOT },
  outputFileTracingRoot: ROOT,
  // Do not write AGENTS.md / CLAUDE.md into the project on `next dev`.
  agentRules: false,
  async rewrites() {
    return [{ source: "/api/v1/:path*", destination: `${API}/api/v1/:path*` }];
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "same-origin" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
        ],
      },
    ];
  },
};

export default nextConfig;
