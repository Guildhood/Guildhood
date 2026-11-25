# Security

## Trust boundaries

| Party | Trusted with | Never trusted with |
|---|---|---|
| iPad client | Rendering, input, its own session | Identity claims beyond its token, balances, prices, ownership, positions, results, profile fields it may not edit |
| Supabase Auth | Identity, passwords (hashed), sessions | |
| Postgres (RLS + `SECURITY DEFINER` functions) | Every persistent rule: who may read or change what | |
| Game server (service-role key) | Live simulation, eligibility checks, registry/presence writes | |
| `delete-account` Edge Function (service-role key) | Account deletion after re-verifying the player | |

Privileged keys (`SUPABASE_SECRET_KEY` / service role) exist only in the game server's and Edge
Function's environments. The client ships only the publishable key.

## Profile and account access matrix

Verified by tests with separate identities (`tests/db/profiles.test.ts`,
`tests/db/restrictions-and-deletion.test.ts`, `tests/db/accounts.test.ts`, `tests/db/api.test.ts`).

| Resource | Owner | Other signed-in player | Anonymous | Trusted backend |
|---|---|---|---|---|
| `profiles` row | Read. Change only via `claim_username`, `update_my_profile`, `complete_onboarding`, plus the `active_vehicle_id` column (ownership enforced by a composite foreign key) | **No row access.** Public card via `get_public_profile` (username, display name, avatar, bio) if visibility allows; name and avatar in friends lists via `get_social_overview` | None | Full |
| `profile_private` | Read; change via `update_my_privacy_settings` (known keys only) | None | None | Full |
| `account_restrictions` | Status only via `get_my_account_status` (type, reason category, dates) | None | None | Manage via `server_add_restriction` / `server_lift_restriction` |
| `private.moderation_notes` | None | None | None | Service role (private schema) |
| `private.audit_events` | None | None | None | Service role (private schema) |
| `avatar_catalog` | Read | Read | Read | Full |
| Auth secrets (passwords, tokens) | Never in application tables | | | Supabase Auth only |

Server-controlled fields players cannot change: `id`, `username` (except through
`claim_username`'s rules), `onboarding_step`, `onboarding_completed_at`, `created_at`,
`updated_at`, `friend_code`, restrictions, audit, and any privileged flag. There is no parameter
for "whose profile": every player function acts on `auth.uid()`.

Visibility of the public card:

| `profile_visibility` | Who sees the card |
|---|---|
| `public` | any signed-in player |
| `friends` (default) | friends |
| `private` | only the owner |

Hidden and nonexistent profiles look the same (`null`). Display names and avatars still appear to
friends and co-players, because play needs them.

## Rules implemented in the database (not only in the client)

- Username: normalized (trimmed, lowercase), `^[a-z0-9_]{3,20}$`, unique (unique index on the
  normalized value, so case variations cannot bypass it), reserved names rejected (central table
  `private.reserved_usernames`, exact and contains matches, enforced by both the functions and a
  trigger). Concurrent claims: exactly one wins (tested with 10 parallel claims).
- Display name: trimmed, 2–30 characters, no control characters, no invisible or
  direction-changing characters (impersonation).
- Bio: up to 160 characters, plain text (line breaks allowed).
- Avatar: must exist in `avatar_catalog` and be active.
- Check constraints are written inline because they run with the caller's privileges (found by
  tests: helper functions in the private schema made every profile update fail for players).

## Restriction enforcement

| Surface | Effect of an active suspension or ban |
|---|---|
| Client | `ACCOUNT_RESTRICTED` screen with type, reason category, and end date. Can sign out or delete the account. No moderator notes are ever sent. |
| Database | `claim_username`, `update_my_profile`, `send_friend_request`, `invite_friend_to_session` raise `account_restricted`. Reading one's own data still works. |
| Game server | Refused at the handshake (`account_restricted`); removed within 60 s if restricted while connected. |

Restrictions expire automatically (`expires_at`) or are lifted (`lifted_at`). Bans have no expiry.

## Functions and grants

Every `SECURITY DEFINER` function sets `search_path = ''` and fully qualifies names. Execution is
revoked from `public`/`anon` and granted only to the intended role: player functions to
`authenticated`, `server_*` functions to `service_role`. Private helpers live in the `private`
schema, which the Data API does not expose and clients cannot use. Tests call every privileged
function as a player and as anonymous to prove they are refused.

## Account deletion and credentials

See [account-deletion.md](account-deletion.md). Password re-entry is required and rate-limited per
account; existing access tokens are made useless (no data, no refresh, game server refusal) rather
than assumed revoked.

## Client hardening

- **Content-Security-Policy** in production builds (`vite.config.ts`): scripts only from the
  site; connections only to the site, the Supabase project, and the game server; no objects.
- Player text is always inserted with `textContent` (no `innerHTML`).
- Email links: only configured flows are processed; tokens are stripped from the address bar
  before any other code runs.
- No passwords are stored. Sessions are in `localStorage` (the SDK's web persistence); see
  [authentication.md](authentication.md#session-storage).

## Logging

| Component | Logged | Never logged |
|---|---|---|
| Client (`src/log.ts`) | event type, request id, timestamp, environment, safe error code, duration | passwords, tokens, emails, auth links (redacted by field name and by pattern) |
| Game server | event, connection id, user id, close code | access tokens (tested) |
| delete-account | event type, request id, timestamp, environment, status, safe error code, failing stage, duration, user id | tokens, passwords, emails, request bodies (checked in container logs) |

Account ids (UUIDs) are pseudonymous and appear in backend logs only. Player-facing messages
never include raw database errors or stack traces (`ui/messages.ts`, `profileErrorText`).

## Known gaps

See [phase-backlog.md](phase-backlog.md#outstanding-issues): no CAPTCHA on sign-up, no leaked-
password check (a paid Supabase feature), no profanity filter, audit retention not automated,
`localStorage` session storage (no Keychain on the web).
