# Phase backlog

## Phases

| Phase | Scope | Status |
|---|---|---|
| 1 | Join and drive: friends by friend code, one persistent neighborhood (Copperleaf Commons), live session instances, server-authoritative driving, starter car and Marks, reconnect, invites | Done ([PHASE-1.md](PHASE-1.md)); physical-iPad test not yet performed |
| 2 | Accounts and profiles: email + password, verification, recovery, sessions, profiles and onboarding, access control, restrictions, audit, account deletion | Done (this phase); physical-iPad test not yet performed |
| 3 | Friends, invitations, and persistent neighborhoods | Next. Part of it already exists from Phase 1 (see handoff) |
| later | Races and earning, garage and shop, Guilds, territory, cloud deployment and hardening, native wrapper | Not started |

Phase 1 was built before this ordering was set, so friends, session invites, a persistent
neighborhood, cars, and the Marks wallet already exist and work. Phase 2 preserved them unchanged in
behavior, except that they now respect Phase 2 rules (restrictions, the friend-request privacy
setting, owner-only profile rows).

## Phase 3 handoff (dependency-driven)

**What Phase 3 can rely on from Phase 2:** verified accounts; unique usernames (case-insensitive,
reserved names blocked); display names, avatars, bios; a visibility-aware public card
(`get_public_profile`); private settings (`profile_private`, including `allow_friend_requests`);
restrictions enforced in the database and game server; an audit log; account deletion that cleans
up social data in other players' inboxes.

**What exists already (Phase 1):** friend codes, requests (send/accept/decline/cancel), friendships,
Realtime notifications, friends' live status, session invites, one persistent neighborhood with
memberships, live instances, and friend-only targeted joins.

**Recommended first task:** *Find players by username, see their profile card, and block players.*
Make blocking work before making strangers easier to reach.

1. Migration: `blocks(blocker, blocked)` with RLS, owner-managed. Enforce it everywhere social:
   `send_friend_request` (either direction), `get_public_profile`, `invite_friend_to_session`,
   `get_social_overview`, presence visibility, and the game server's targeted joins. Add a
   `search_players(prefix)` that returns only public cards, at most 20, excluding blocked and
   restricted accounts, rate-limited per account.
2. Client: a search panel, a profile card with "Add friend" / "Block" / "Report", a remove-friend
   button (the function exists; there is no UI), and a blocked-players list in Account settings.
3. Reporting: `reports(reporter, reported, reason_code, created_at)`, service-role review only,
   feeding the existing restriction tools.
4. Tests: block symmetry across every surface, search never returns hidden/blocked/restricted
   players, rate limits, E2E for search → card → friend → block.

**After that:** neighborhood invitations and membership (joining neighborhoods beyond the starter
one, invite-only neighborhoods), persistent neighborhood state, and only then more neighborhoods,
as the Phase 1 rule says: no world expansion until friends, driving, racing, earning, and ownership
work reliably on iPad.

## Outstanding issues

| Issue | Impact | Plan |
|---|---|---|
| **No physical-iPad test yet** (Phase 1 or 2) | Safari/WebKit behavior unverified: keyboard avoidance, safe areas, code autofill, backgrounding | Run [testing-plan.md](testing-plan.md) |
| Email **links** on the Wi-Fi test work only at the computer's `.local` address (Auth refuses IP-address redirect hosts) | Players using the IP address must use the 6-digit code | Documented; production uses one https address |
| Home Screen web app and Safari keep separate sessions | Opening an email link in Safari does not sign in the Home Screen app | The code path covers it; documented |
| Nothing deployed: no hosted Supabase project, SMTP, Edge Function deploy, game server, or Pages variables | The GitHub Pages site shows "not connected" | Cloud deployment phase (deployment.md) |
| No CAPTCHA on sign-up or reset; no leaked-password check | Automated sign-ups possible within Auth rate limits | Enable Supabase CAPTCHA (Turnstile/hCaptcha) before launch |
| No profanity filter for names and bios | Offensive names possible; moderation is reactive (restrictions) | Add a word list check in `display_name_problem`/usernames, plus reporting (Phase 3) |
| Username changes have no cooldown | Name churn could aid impersonation | Add a cooldown (e.g. 30 days) using the audit log |
| Audit retention not automated | Records kept indefinitely | Scheduled job (pg_cron) to delete after 12 months |
| Deleting a restricted account removes its restriction records | Ban evasion by delete-and-re-register | Keep a hashed-email deny list or retain restriction rows (decide with privacy review) |
| Sign-out ends only this device's session | Other devices stay signed in | Add "Sign out everywhere" (scope `global`) |
| Sessions in `localStorage` | Readable by injected script | CSP mitigates; a native wrapper could use Keychain |
| Email change not offered | Players cannot change their email | Implement with verification of both addresses (deliberately deferred) |
| Phase 1 local test accounts have no password or username | They must use "Forgot password?" and then onboard | Local-only; no deployed users |
| Privacy policy and terms are drafts | Not legal review | Legal review before any public launch |
| Edge Function hot reload unreliable in some local setups | Edits may need a container restart | Documented in account-deletion.md |
