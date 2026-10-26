import type { NextConfig } from "next";

// The browser talks only to this app's origin; /api/v1/* is proxied to the FastAPI backend so the
// HttpOnly session cookie and the signed tile URLs stay same-origin. WB_API_URL defaults to the local API.
const API = process.env.WB_API_URL ?? "http://127.0.0.1:8000";

const nextConfig: NextConfig = {
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
