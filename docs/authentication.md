# Authentication

Guildhood uses **Supabase Auth with email + password**, required email verification, and
password recovery. There is no separate password store and no custom token system: the Supabase
JS SDK (`@supabase/supabase-js` 2.119) issues and refreshes sessions, and the game server and
database verify Supabase's tokens. No other sign-in providers are offered (Phase 1 used
passwordless email codes; that method was retired in Phase 2, see "Migration from Phase 1").
Guest accounts are not supported.

Code: `apps/client/src/auth/manager.ts` (state machine), `apps/client/src/auth/callback.ts`
(email links), `apps/client/src/ui/auth-screens.ts` (screens), `supabase/config.toml` (local Auth
settings), `supabase/templates/*.html` (emails).

## State machine

One `AuthManager` owns the session. Screens render from its state and never read the session
themselves. **Connectivity is a separate value** (`online` / `offline` / `unreachable`) shown in a
banner, so being offline is never mistaken for being signed out.

| State | Meaning | Screen |
|---|---|---|
| `INITIALIZING` | Reading the stored session or an incoming email link | Loading |
| `SIGNED_OUT` | No session (optional notice: signed out, account deleted, link expired/invalid) | Welcome / Sign in / Create account / Password recovery |
| `AUTHENTICATING` | A sign-in, sign-up, code, or link check is in flight | The current form shows its busy state (a link shows "Checking your link…") |
| `AWAITING_VERIFICATION` | Account created, email not yet confirmed | Verify email (code entry, resend, restart) |
| `AUTHENTICATED_NEEDS_PROFILE` | Signed in; onboarding not finished | Onboarding, at the saved step |
| `AUTHENTICATED_READY` | Signed in with a complete profile | Home, Profile, Account, Delete account, Driving |
| `RECOVERY_IN_PROGRESS` | Signed in through a password-reset code/link; must choose a new password | Choose a new password |
| `SESSION_EXPIRED` | The session ended without the player signing out (revoked, refresh token invalid, account removed) | Sign in again |
| `ACCOUNT_RESTRICTED` | Suspended or banned (from `get_my_account_status()`) | Restriction notice (sign out, delete account) |
| `ERROR` | Signed in, but the account could not be loaded (backend unreachable, unexpected error) | Can't reach Guildhood (retry, sign out) |

```
INITIALIZING ─┬─ stored session ─► load account ─┬─► AUTHENTICATED_READY
              │                                  ├─► AUTHENTICATED_NEEDS_PROFILE ─(complete onboarding)─► READY
              │                                  ├─► ACCOUNT_RESTRICTED
              │                                  └─► ERROR (network) ─(retry)─► load account
              ├─ recovery flag ─────────────────────► RECOVERY_IN_PROGRESS ─(new password)─► load account
              ├─ pending registration ──────────────► AWAITING_VERIFICATION ─(code/link)─► load account
              ├─ email link ─► AUTHENTICATING ─► (signup) load account | (recovery) RECOVERY_IN_PROGRESS
              └─ nothing ───────────────────────────► SIGNED_OUT
SIGNED_OUT ─(sign in / create)─► AUTHENTICATING ─► load account | AWAITING_VERIFICATION | SIGNED_OUT + error
any signed-in state ─(sign out)─► SIGNED_OUT;  ─(session ends underneath)─► SESSION_EXPIRED
```

Rules the manager enforces:

- **Never clears a valid session because of a network failure.** Network failures surface from the
  SDK as `AuthRetryableFetchError` (or fetch errors) and only change connectivity / show `ERROR`
  with retry. Tested in `tests/db/auth.test.ts` and E2E ("offline" sign-in).
- **Session expiry** is detected two ways (both verified against the SDK in `tests/db/auth.test.ts`):
  validating with `getUser()` on a revoked session makes the SDK clear storage and emit
  `SIGNED_OUT`; refreshing returns `refresh_token_not_found` without clearing storage. An
  un-requested `SIGNED_OUT`, or a non-retryable auth error, moves to `SESSION_EXPIRED` and clears
  local state.
- **Revalidation:** when the app returns to the foreground or comes back online, the session is
  checked with the server (`getUser`) and the account status reloaded (a restriction applied
  meanwhile takes effect). The same handles "returning after a long absence".
- **Account-scoped cleanup:** on sign-out, expiry, or a different account appearing, every
  registered cleanup runs (Realtime channels, caches), and screens are keyed by account id so
  nothing from the previous player can stay on screen.
- **Never stores passwords.** Only Supabase's session (access + refresh token) is stored, plus two
  non-secret markers: `guildhood.pendingVerification` (the email awaiting confirmation) and
  `guildhood.recoveryUser` / `guildhood.recoveryRequest` (so a relaunch returns to the right
  recovery step).

## Session storage

The client is a web app, so the SDK's supported persistence on this platform is `localStorage`
(key `guildhood-auth`). There is no Keychain on the web. Mitigations: a production
Content-Security-Policy (scripts only from the site, network only to the configured Supabase
project and game server), no third-party scripts, no tokens in logs or URLs, 1-hour access tokens
with rotating refresh tokens (reuse interval 10 s). Note: on iPad, a Home Screen web app and
Safari have **separate storage**; signing in in one does not sign in the other.

## Email links and codes on iPad

Every verification and recovery email contains **both** a 6-digit code and a link:

```
<app url>?type=signup&token_hash=<hash>     (confirmation template)
<app url>?type=recovery&token_hash=<hash>   (recovery template)
```

Why both: iOS Mail opens links in Safari. A player using Guildhood from the Home Screen would end
up verified in Safari but not in the Home Screen app (separate storage). The code works from any
context; the link is the convenient path in Safari.

Link handling (`callback.ts`, `manager.ts`):

- Only `type=signup` (also `email`) and `type=recovery` with a well-formed `token_hash` are
  processed. Anything else is shown as an invalid link. Supabase errors in the fragment
  (`#error_code=otp_expired`) are recognized.
- All auth parameters are **removed from the address bar before anything else runs**
  (`history.replaceState`), so tokens never stay in history, screenshots, or logs.
- Lifecycle: the app may be open, in the background, or not running when a link is opened. A link
  is a page load, so the same code path runs in every case. A tab that was waiting on "Check your
  email" picks up the new session via the SDK's cross-tab sync or on returning to the foreground.
  Tested: same tab, another tab, fresh launch.
- Expired or used links: verification → back to the verify screen (if registration is pending) or
  a notice; recovery → the recovery screen with "request a new one". Already signed in → continue
  with a notice.
- A link for a different flow than the screen expected simply runs its own flow (a recovery link
  always leads to "choose a new password"). A signup hash presented as recovery is refused by Auth
  (tested).

## Required Supabase Auth settings

Local values live in `supabase/config.toml`. For a hosted project, set the same in the dashboard
(Authentication → Sign In / Providers, URL Configuration, Emails) or with `npx supabase config push`.

| Setting | Value | Why |
|---|---|---|
| Email provider | enabled | the only provider |
| Confirm email | **on** (`enable_confirmations = true`) | verification is required before sign-in |
| Minimum password length | 8 | product rule |
| Password requirements | letters and digits | product rule (mirrored in `passwordChecks`) |
| Email OTP length / expiry | 6 digits / 3600 s | codes and links valid for 1 hour |
| Max frequency (resend) | local `1s`; **production 60s** | the client also enforces a 60 s cooldown |
| Anonymous sign-ins | off | no guest accounts |
| Secure password change | off (recovery and reset flows re-verify by email) | |
| Password changed notification | on | security notice email |
| Site URL | local `http://127.0.0.1:5173`; production `https://<owner>.github.io/Guildhood/` | fallback for links |
| Redirect allow list | see below | which app addresses links may return to |
| Rate limits | local values are high for automated tests; use Supabase defaults in production | |
| SMTP | local: Mailpit (built in); **production: custom SMTP required** (built-in sender: a few emails/hour) | |

### Redirect configuration

The client asks Auth to return links to the address it is running at (origin + path, no query).
Auth only honors addresses on the allow list; otherwise it falls back to the Site URL.

| Environment | Allow list |
|---|---|
| Local / CI | `http://127.0.0.1:5173/**`, `http://localhost:5173/**`, `http://*.local:5173/**` |
| Staging (suggested) | the exact staging `https://` URL with `/**` |
| Production | `https://<owner>.github.io/Guildhood/**` only |

Supabase Auth refuses IP-address hosts in allow-list patterns (verified: `http://*.*.*.*:5173/**`
and `http://**:5173/**` do not match `http://192.168.1.23:5173/`). On the Wi-Fi test, links
therefore work only when the iPads open Guildhood at the computer's `.local` name, which
`npm run lan` prints first. The 6-digit code works at any address.

### Email templates

`supabase/templates/verify_email.html` (confirmation), `reset_password.html` (recovery),
`password_changed.html` (notification). Both action templates must contain `{{ .Token }}` and a
link built from `{{ .RedirectTo }}` and `{{ .TokenHash }}` exactly as in the files.

### Local email testing

The local stack includes Mailpit. Every email is captured (nothing is sent); view them at
`http://127.0.0.1:54324`. `npm run dev` / `npm run lan` also print each code in the terminal
(`✉  Email confirmation code for …`). Tests read emails through Mailpit's API
(`tests/support/auth.ts`, `readEmail`).

## Environment variables

| Where | Variable | Notes |
|---|---|---|
| Client build | `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`, `VITE_GAME_SERVER_URL` | public values; GitHub repository variables for Pages |
| Client (local) | `VITE_SAME_ORIGIN_BACKEND=1` | set by `scripts/dev.mjs`; Supabase reached through the dev proxy |
| Game server | `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, optional `SUPABASE_JWKS_URL` / `SUPABASE_JWT_ISSUER` / `SUPABASE_JWT_SECRET` | see deployment.md |
| delete-account function | provided by Supabase (`SUPABASE_URL`, keys); optional `GUILDHOOD_ALLOWED_ORIGINS`, `GUILDHOOD_ENVIRONMENT` | secrets via `supabase secrets set` |

No production credential or redirect address is hard-coded in the client: all come from build
variables or the current page address.

## Server-side identity (game server)

The game server verifies the presented access token itself (signature via the project's JWKS,
issuer, audience, expiry, role), derives the player id only from the verified `sub`, then loads the
player from the database and checks **eligibility**: a profile must exist, onboarding must be
complete, and no active restriction may apply. Connected players are re-checked every 60 s and
when they present a refreshed token, so a deleted or restricted account is removed. Tokens are
never logged (tested). A token is a credential, not proof of privilege: every privileged action is
re-authorized by the database or the Edge Function.

## Migration from Phase 1

Phase 1 signed players in with emailed codes (no password). That method is removed. Nothing was
deployed, so no real players are affected; local Phase 1 test accounts can set a password with
"Forgot password?", and must then complete onboarding (they have no username yet).
