# Authentication and authorization architecture (Stage 6, Phase B)

*Design and implementation record. Synthetic data only. Production activation is **blocked** until a real identity provider, a deployment environment and an institutional review exist. Nothing here is a compliance claim.*

## 1. Modes (fail closed)
| Mode | Selected when | Who can read | Who can write |
|---|---|---|---|
| `demo` | `HLOS_MODE=demo`, or `next dev` with no `HLOS_MODE` | Demo role cookie (not authentication), synthetic data | Demo role, server-side permission checks |
| `secured` | `HLOS_MODE=secured` **and** the OIDC configuration validates | A signed-in, unlocked session linked to an active staff member of this lab, with the page's `view.*` permission | The same session, with the command's permission. A fresh re-authentication for sensitive commands. |
| `locked` | Anything else, including `HLOS_MODE=secured` with missing or invalid configuration | **Nobody.** A "not configured" page with no data. | Nobody (401) |

- **Demo boundaries.** The demo role cookie, the presenter console, demo reset, the test fixtures and the simulated source pump exist **only** in `demo`.
- **Seeding.** Synthetic seed data is loaded only in `demo`, or when `HLOS_SEED_SYNTHETIC=1` is set explicitly for a secured test environment. While it is loaded, the shell shows a persistent "Synthetic data" label.

## 2. Identity provider choice
- **The standard.** Any OpenID Connect provider that supports the authorization code flow with PKCE, issuer discovery and an `auth_time` claim. Microsoft Entra ID, Okta and Auth0 all qualify.
- **Choosing one** is an institutional decision. It depends on the laboratory's existing enterprise SSO, MFA policy, account lifecycle (joiner, mover, leaver) and where the app is hosted. Entra ID is the likely fit if the institution already runs Microsoft 365; that is an observation, not a selection.
- **MFA** is enforced by the provider's policy, not by this application. The app can require it through `acr`/`amr` checks once the provider's values are known.
- **Library.** The application uses `openid-client` 6, a certified relying-party library, and never handles passwords.
- **Tests** use `oidc-provider` (a certified OpenID provider implementation), run locally as a development dependency, so the real code flow is exercised end to end without any external service.

## 3. Sign-in, sessions, sign-out
1. **Sign-in.** `GET /api/auth/login?returnTo=` creates a one-time transaction (state, nonce, PKCE verifier; it expires after 10 minutes) and redirects to the provider. **Every** sign-in sends `prompt=login&max_age=0`, and the callback refuses an `auth_time` older than the transaction (`reauth_not_fresh`). A provider single sign-on session left behind by the previous person (after a lock, a sign-out whose provider logout was declined, or an expiry) therefore never signs anyone in on a shared workstation.
2. **Callback.** `GET /api/auth/callback` consumes the transaction once, exchanges the code with PKCE and validates the ID token (issuer, audience, nonce, expiry, and its signature against the provider's JWKS). An `auth_time` more than one minute in the future is refused. It then looks up `(issuer, subject)` in `staff_identity` for this lab.
   - Not linked, staff inactive, or (when `HLOS_OIDC_LAB_CLAIM` is set) the lab missing from that claim: access is denied. No session is created and `auth.denied` is audited.
   - Denials that anyone can cause without signing in (bad or replayed state, provider unavailable) are aggregated: at most one `auth.denied` per kind per minute, carrying the count of the repeats. A callback without this browser's sign-in binding cookie is only logged. Per-client rate limiting belongs to the reverse proxy (activation checklist).
3. **Session.**
   - A 256-bit random id goes in an HttpOnly, SameSite=Lax cookie, with `Secure` and the `__Host-` prefix under HTTPS. Only the id's SHA-256 is stored.
   - Each session row holds: staff, lab, issuer, subject, `auth_time`, created, last activity, absolute expiry (default 12 h), lock time, revocation time.
   - **Role and status are read from the staff table on every request**, so a role change or deactivation applies to the next request.
4. **Inactivity.**
   - After `HLOS_SESSION_IDLE_MIN` (default 15) minutes with no user-driven request, the session is **locked**. User-driven requests are commands, the CSV export, full page loads and `POST /api/auth/activity` (sent by the client after real input). Background polling (`/api/live`), the `router.refresh()` it triggers, client-side navigations and prefetches never count as activity (a page counts only for `Sec-Fetch-Dest: document`, because Next.js hides its own RSC headers from the page).
   - The client also locks the screen on its own idle timer, and on the user's request ("Lock").
   - A locked session can read nothing and write nothing. The lock screen shows **no patient, case or operator details**.
   - Unlocking requires signing in again at the provider. If a different person signs in, the old session is revoked and a new one starts: a workstation hand-over.
5. **Sign-out.** `POST /api/auth/logout` revokes the session, clears the cookie, audits `auth.signed_out`, then offers the provider's end-session endpoint if it advertises one.
6. **Workstation hand-over safety.** Every command carries the actor the page was rendered for (`X-HLOS-Actor`). If it differs from the session's staff member, the request gets 409 `ACTOR_MISMATCH` and nothing is recorded. An action is therefore never attributed to the next operator because the screen was left open.
7. **Re-authentication.** Commands marked `sensitive` require `auth_time` within `HLOS_REAUTH_MAX_AGE_MIN` (default 5) minutes; otherwise they get 401 `REAUTH_REQUIRED`. The screen keeps the user's input and offers "Confirm it's you", which redirects to the provider and returns to the same page. Nothing is replayed automatically. The sensitive commands are:
   - identity and source-conflict decisions;
   - related-order decisions;
   - hold release, including closing a correction review that releases its holds (a hold release also refuses a stale sign-in on its own, whichever command reached it);
   - closing an identity-discrepancy correction review;
   - gross approval;
   - tray release with exceptions;
   - routing override.
8. **Expiry mid-task.** A command gets 401 `SESSION_EXPIRED` or `SESSION_LOCKED`, the screen says nothing was recorded, and the typed input stays on screen (expired) or the lock screen replaces it (locked). A session the server no longer knows (`SIGN_IN_REQUIRED`: revoked by an administrator, or signed out elsewhere) removes the page content at once.
9. **CSRF.** Requires:
   - a SameSite=Lax cookie;
   - a same-origin `Origin` check (or `Sec-Fetch-Site: same-origin`) on every state-changing route;
   - JSON bodies only.

   No state change is reachable by GET.
10. **Concurrent sessions.** One person may hold sessions on several workstations. Each is independent, and sign-out ends only that one. Administrators can revoke all of a person's sessions (CLI).

## 4. Authorization
- **Action-specific permissions** (`src/lib/roles.ts`) are checked on the server for every command (`executeCommand`) and every page and read API (`view.*`, through one guard).
- **New roles:**
  - `lab_admin`: staff and identity links, role assignment (CLI, audited), audit verification. **No clinical permission and no bench screen.**
  - `auditor`: audit verification and the audit report only.
  - Neither receives bench data through the shell or `/api/live` (no rail counts, clock or source health; `/api/live` answers 403).
- **New permission** `identity.resolve`: identity and source-conflict decisions. Accessioning lead and supervisor only. An administrator never has it.
- **No automatic links.** A job title in the provider's directory never grants a permission. Roles are assigned in this application by a laboratory administrator.
- **Lab scope:**
  - every session carries `lab_id`, and it must equal `HLOS_LAB_ID`;
  - a staff identity link is per lab;
  - a session from another lab is refused.

  Partitioning one database across several labs is **deferred**: one deployment serves one lab.

## 5. What is verified, and how
See `verification-stage6.md` for test names and results.

## 6. Production activation checklist (blocked items)
1. Choose the provider and register the application: redirect URI, client authentication method, logout URI.
2. Agree the claims: subject stability, `auth_time`, MFA (`amr`/`acr`), the lab claim.
3. Deploy behind TLS with HSTS; set the secrets in the deployment's secret store.
4. Link the staff identities; review role assignments with the lab director.
5. Penetration test and threat-model review.
6. Have the laboratory validate the workflows under its own quality system.
