// Local OpenID Connect provider for the SECURED browser suite (playwright.secured.config.ts).
//
// oidc-provider (a certified OpenID provider implementation, a development
// dependency only) on 127.0.0.1, never any other interface. Synthetic test
// accounts only: the development login form ("devInteractions") accepts any
// password; the login name is the account (and the ID token's subject).
// Nothing here is a real credential, and nothing contacts any other host: the
// provider's built-in pages import a web font from a public CDN, so every HTML
// page is sent without that import and with a Content-Security-Policy that
// allows this origin only (the browser suite also aborts any non-loopback
// request).
//
// Environment (set by playwright.secured.config.ts):
//   OIDC_PORT           port on 127.0.0.1 (issuer http://127.0.0.1:<port>)
//   OIDC_APP_URLS       comma-separated application origins (redirect and post-logout URIs)
//   OIDC_CLIENT_ID      client id
//   OIDC_CLIENT_SECRET  client secret (random per run)
//   OIDC_LAB_ID         the laboratory this deployment serves (the lab claim)
import crypto from "node:crypto";
import http from "node:http";
import Provider from "oidc-provider";

const HOST = "127.0.0.1";
const PORT = Number(process.env.OIDC_PORT);
const APPS = (process.env.OIDC_APP_URLS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const CLIENT_ID = process.env.OIDC_CLIENT_ID;
const CLIENT_SECRET = process.env.OIDC_CLIENT_SECRET;
const LAB = process.env.OIDC_LAB_ID || "lab:local";

if (!Number.isInteger(PORT) || PORT <= 0 || !APPS.length || !CLIENT_ID || !CLIENT_SECRET) {
  console.error("oidc-provider.mjs: OIDC_PORT, OIDC_APP_URLS, OIDC_CLIENT_ID and OIDC_CLIENT_SECRET are required.");
  process.exit(1);
}
for (const app of APPS) {
  const u = new URL(app);
  if (u.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(u.hostname)) {
    console.error(`oidc-provider.mjs: application URL ${app} is not a loopback http URL.`);
    process.exit(1);
  }
}

/**
 * Synthetic test accounts: login name -> the lab claim (hlos_labs) in the ID token.
 * Which staff member each one is linked to is decided by the admin CLI, never here.
 */
const ACCOUNTS = {
  kim: { labs: [LAB] }, // linked to Kim Nguyen, accessioning lead
  maya: { labs: [LAB] }, // linked to Maya Torres, accessioner
  admin: { labs: [LAB] }, // linked to a laboratory administrator (no bench view)
  auditor: { labs: [LAB] }, // linked to an auditor (no bench view)
  stranger: { labs: [LAB] }, // signs in at the provider but is linked to no staff member
  otherlab: { labs: ["lab:other"] }, // linked, but the lab claim names another laboratory
};

const ISSUER = `http://${HOST}:${PORT}`;

const provider = new Provider(ISSUER, {
  clients: [
    {
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uris: APPS.map((a) => `${a}/api/auth/callback`),
      post_logout_redirect_uris: APPS.map((a) => `${a}/signed-out`),
      response_types: ["code"],
      grant_types: ["authorization_code"],
      token_endpoint_auth_method: "client_secret_basic",
    },
  ],
  // Unknown login names have no account.
  findAccount: async (_ctx, sub) =>
    Object.hasOwn(ACCOUNTS, sub) ? { accountId: sub, claims: async () => ({ sub, hlos_labs: ACCOUNTS[sub].labs }) } : undefined,
  claims: { openid: ["sub", "hlos_labs"] },
  conformIdTokenClaims: false, // the lab claim travels in the ID token
  cookies: { keys: [crypto.randomBytes(32).toString("hex")] },
  features: {
    devInteractions: { enabled: true },
    rpInitiatedLogout: { enabled: true },
  },
  pkce: { required: () => true },
  // First-party client: no consent screen (the grant covers openid and the lab claim).
  loadExistingGrant: async (ctx) => {
    const grant = new ctx.oidc.provider.Grant({ clientId: ctx.oidc.client.clientId, accountId: ctx.oidc.session.accountId });
    grant.addOIDCScope("openid");
    grant.addOIDCClaims(["sub", "hlos_labs"]);
    await grant.save();
    return grant;
  },
});

// Loopback only, no external resources: strip CSS @import of remote fonts and pin every page to this origin.
provider.use(async (ctx, next) => {
  await next();
  if (typeof ctx.body === "string" && /html/i.test(ctx.type || ctx.response.get("content-type") || "")) {
    ctx.body = ctx.body.replace(/@import\s+url\([^)]*\)\s*;?/gi, "");
    ctx.set("Content-Security-Policy", "default-src 'self' 'unsafe-inline'; form-action 'self' http://localhost:* http://127.0.0.1:*");
  }
});

const server = http.createServer(provider.callback());
server.listen(PORT, HOST, () => {
  console.log(`[oidc-provider] synthetic test provider at ${ISSUER} for ${APPS.join(", ")}`);
});
const stop = () => server.close(() => process.exit(0));
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
