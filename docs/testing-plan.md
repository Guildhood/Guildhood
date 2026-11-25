# Testing plan and results

All automated tests run against an isolated local Supabase stack (Postgres, Auth, Data API,
Realtime, Edge Functions, Mailpit) and the real game server. Nothing runs against production;
destructive tests (deletion, restriction, session revocation) use throwaway accounts.

```bash
npx supabase start && npm run env:local && npm run wait:supabase
npm run typecheck
npm test            # shared + client unit, database/Auth/Realtime/deletion, game server
npm run test:e2e    # emulated iPads, production build
```

CI (`.github/workflows/ci.yml`) runs the same on every push, plus a container build.

## Automated suites

| Suite | Files | What it proves |
|---|---|---|
| Shared (`packages/shared/test`) | sim, world, protocol, profile-rules | Deterministic driving, map validity, message validation, username/display-name/bio/password rules |
| Client unit (`apps/client/test`) | prediction, interpolation, wording, assets, auth-callback, log-and-ui | Netcode, "Guild not gang", asset manifest, link parsing and token stripping, log redaction, keyboard inset, avatar artwork coverage |
| Database (`tests/db`) | accounts, wallet, social, sessions, catalog, api, **profiles**, **restrictions-and-deletion**, **auth**, **account-deletion**, **rules-parity** | Access matrix with separate identities, idempotency under concurrency, username races, reserved names, restriction enforcement, audit privacy, Auth flows (registration, verification by code and link, sign-in, sign-out, restoration, expiry, recovery, expired/used/malformed links), deletion over HTTP, shared-vs-database rule parity |
| Game server (`apps/server/test`) | instance, server | Authority, reconnect, friend joins, outage handling, **eligibility (incomplete profile, restricted, deleted mid-session)**, **no tokens in logs** |
| E2E (`apps/client/e2e`) | **accounts**, single-ipad, two-ipads | Full player journeys by touch in an emulated iPad Pro 11 (landscape) |

Spec coverage (Phase 2):

| Spec item | Test |
|---|---|
| Registration, email verification | `auth.test.ts` (code, link, resend, weak passwords); E2E registration by code and link |
| Valid / invalid sign-in, sign-out | `auth.test.ts`; E2E "wrong password, offline, success" and "sign-out clears the account" |
| Session restoration, session expiry | `auth.test.ts` (relaunch with stored session; revoked session behaviors); E2E relaunch and "revoked while account settings are open" |
| Password-reset request, valid / expired / malformed callback | `auth.test.ts`; E2E recovery by code and by link, expired link, malformed and unsupported links |
| Profile initialization idempotent; onboarding persists | `profiles.test.ts`; E2E onboarding resume after relaunch |
| Duplicate, case-variant, concurrent, invalid, reserved usernames | `profiles.test.ts` (10 parallel claims); E2E taken/reserved |
| Invalid avatar ids; partial updates preserve fields | `profiles.test.ts` |
| A cannot update B; A cannot read B's private settings; anonymous blocked; server fields protected; restriction state protected; no impersonation via parameters; public card excludes private fields; privileged functions reject callers | `profiles.test.ts`, `restrictions-and-deletion.test.ts`, `accounts.test.ts`, `api.test.ts` (mutation-checked: deliberately opened holes made them fail) |
| Session survives relaunch; sign-out clears state; account switch does not leak | E2E |
| Backgrounding does not duplicate operations | Submit buttons lock while busy; the manager refuses overlapping auth operations (`guarded`); E2E foreground revalidation keeps typed input |
| Deletion removes/anonymizes data; deleted account cannot regain access; repeated requests safe | `account-deletion.test.ts`, `restrictions-and-deletion.test.ts`, `server.test.ts`; E2E deletion |
| No sensitive data in logs | `server.test.ts` (game server), E2E console capture (client), container log scan (Edge Function) |

## Results (latest full run)

Clean database, local stack, this repository's branch `claude/bold-hamilton-yuof1l`, 2026-11-24:

| Suite | Result |
|---|---|
| Typecheck | pass |
| Shared | 35 / 35 pass |
| Client unit | 17 / 17 pass |
| Database (incl. Auth, deletion) | 123 / 123 pass |
| Game server | 34 / 34 pass |
| E2E, localhost (production build) | 24 / 24 pass |
| E2E, Wi-Fi mode (`npm run lan`, non-localhost address, insecure context) | 23 pass, 1 skipped by design (see notes) |

**Total: 233 automated tests pass** (35 + 17 + 123 + 34 + 24).

Notes on this run:

- The game-server suite first ran 33/34: the log-safety test depended on the environment's log
  level (nothing was logged at `LOG_LEVEL=error`). The logger now reads the level per call and the
  test raises it to `debug`; re-run 34/34 at both `error` and `warn`.
- In Wi-Fi mode, "a link opened in another tab signs in the tab that was waiting" failed as
  expected: at a numeric IP address, Supabase Auth sends links to the site URL (another origin),
  so they cannot sign in that tab. The test now skips itself at IP-address hosts, with the reason
  recorded; the 6-digit code path (tested) is what works there, and links work at the `.local`
  address.
- Final review found and fixed two client issues, then re-ran E2E (24/24) and unit (52/52):
  signing in again from the "session ended" screen with a wrong password replaced the screen
  (losing the message and email), and a re-sign-in after expiry reopened the screen the previous
  session was on instead of home.

Not run: anything on physical iPads or in Safari/WebKit (no device or WebKit browser was
available); hosted Supabase (not deployed).

## Manual iPad checklist (Phase 2)

**Status: not performed.** No physical iPad (and no iPad Simulator, which needs a Mac with Xcode)
was available to the developer. Every item below is either automated in emulation (noted) or
still needs a device. Record results in the table at the end.

Setup: [deployment.md](deployment.md) → "Two-iPad test" (`npm run lan`). Use two accounts on one or
two iPads; shared gameplay is not required for this phase.

| # | Check | How | Automated in emulation? |
|---|---|---|---|
| 1 | Fresh installation | Clear Safari website data for the address (or a new Home Screen install); open Guildhood | partly (fresh contexts) |
| 2 | Landscape launch | Open in landscape; rotate to portrait and back | yes |
| 3 | Safe-area layout | Nothing hidden by rounded corners, the camera, or Stage Manager | no (real insets) |
| 4 | Registration using touch only | Create an account without a hardware keyboard | yes |
| 5 | Password visibility controls | Show / Hide on each password field | yes |
| 6 | Keyboard avoidance | With the on-screen keyboard up, the active field, its error, and the button stay reachable on every form | **no: device only** |
| 7 | Verification link with the app closed | Close Guildhood; open the email link (opens Safari); confirm it reaches onboarding | yes (fresh context) |
| 8 | Verification link with the app open | Leave "Check your email" open in Safari; tap the link; return | yes (two tabs) |
| 9 | Invalid sign-in | Wrong password shows a clear message | yes |
| 10 | Successful sign-in | | yes |
| 11 | Profile onboarding | Username, display name, avatar, review | yes |
| 12 | Username collision | Try a name the other account has (any case) | yes |
| 13 | App termination during onboarding | Swipe away Safari/Home Screen app mid-onboarding; reopen at the same step | yes (reload) |
| 14 | Relaunch after completed onboarding | Lands on home | yes |
| 15 | Profile editing | Change avatar, display name, bio, visibility; reopen | yes |
| 16 | Network loss during save | Airplane mode, Save → "Not saved"; back online, Save → "Saved" | yes |
| 17 | Password recovery | Forgot password → code (and link) → new password → sign in | yes |
| 18 | Expired recovery link | Use a link older than 1 hour | yes (aged in the database) |
| 19 | Backgrounding and foregrounding | Home button / app switcher during sign-in and in settings; return | partly (visibility events) |
| 20 | Sign-out | Returns to welcome; nothing of the account remains on screen | yes |
| 21 | Sign-in as a different user | No trace of the previous account | yes |
| 22 | Account deletion | Wrong password refused; right password deletes; welcome shows "deleted" | yes |
| 23 | Rejected access after deletion | Old password fails; Drive is unavailable | yes |
| 24 | Accessible labels and readable text | VoiceOver reads every field and button; text readable at arm's length | partly (labels) |
| 25 | No sensitive information in logs | Safari Web Inspector console (Mac) shows no passwords, tokens, emails, or links | yes (console capture) |

Also check on the device: iOS offers the emailed code above the keyboard (one-time-code autofill),
and iCloud Keychain offers to save the password.

### Results

| # | iPad model / iPadOS | Safari or Home Screen | Result | Notes |
|---|---|---|---|---|
| 1–25 | | | not performed | |

## Phase 1 manual test

The two-iPad gameplay test from Phase 1 is still pending: [IPAD-TEST-PLAN.md](IPAD-TEST-PLAN.md).
It now starts with **Create account** instead of the old email-code sign-in.
