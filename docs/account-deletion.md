# Account deletion

Players delete their own account in the app: **Account → Delete account**. Deletion is permanent
and runs only on trusted infrastructure: the `delete-account` Supabase Edge Function
(`supabase/functions/delete-account/index.ts`), which holds the service-role key. The key never
reaches a client.

## Player flow

1. Account settings → **Delete account…**
2. The screen lists what will be removed and what is kept.
3. The player enters their **current password** and types **DELETE**. The button stays disabled
   until both are present.
4. The app sends an authenticated request (`supabase.functions.invoke('delete-account')`, with the
   player's access token).
5. Only after the function confirms deletion does the app clear local state and show the welcome
   screen with "Your account has been deleted." A failure keeps the player on the screen with the
   reason and a retry; nothing is shown as deleted early.

Restricted (suspended or banned) players can also delete their account.

## What the function does

| Step | Action | Failure handling |
|---|---|---|
| 1. Identify | `GET /auth/v1/user` with the caller's token. Auth checks signature, expiry, and that the session still exists. The request body has no user id, so there is nothing to impersonate. | 401 `not_authenticated` / `session_expired` |
| 2. Confirm identity | At most 5 failed attempts per account per 15 minutes (`private.deletion_attempts`), then the password is checked with Auth's password grant. The session this creates is ended immediately. | 403 `invalid_password`, 429 `too_many_attempts` |
| 3. Prepare | `server_begin_account_deletion`: records `account_deletion_requested`, deletes session invites the player sent, rewrites other players' notifications to say "A deleted player" without the player's id or name, strips usernames from the player's audit history. | 500 `deletion_failed` (retry) |
| 4. Delete | `DELETE /auth/v1/admin/users/{id}` (hard delete). Sessions and refresh tokens are removed by Auth; every application row owned by the player cascades from `auth.users`. A 404 means it was already gone. | 500 `deletion_failed` (retry) |
| 5. Finish | `server_finish_account_deletion` verifies nothing of the account remains, then records `account_deleted` (once). | 500 `deletion_failed` (retry) |

**Retries are safe.** If the response is lost after step 4, the app's retry presents the same
token. Auth then reports `user_not_found` (it verified the token's signature first), and the
function answers `200 {status: "deleted", already_deleted: true}`, finishing step 5 if needed.
Tested in `tests/db/account-deletion.test.ts`.

## Data policy

| Data | What happens |
|---|---|
| Auth user (email, password hash, identities, sessions, refresh tokens) | deleted by Supabase Auth |
| `profiles` (username, display name, avatar, bio, visibility, friend code) | deleted (cascade); the username becomes available |
| `profile_private` (privacy settings, terms acceptance) | deleted |
| Friendships, friend requests (sent and received), the player's notifications | deleted |
| Session invites the player sent to others | deleted |
| Friend-request notifications in other players' inboxes | kept for the recipient, rewritten to "A deleted player" with no id or name |
| Cars, wallet, Marks ledger, neighborhood memberships, live-session presence | deleted |
| Account restrictions and private moderator notes | deleted (cascade) |
| `private.audit_events` for the account | **retained**: event types, timestamps, and the account's UUID. Usernames are removed. Purpose: proof that the account existed and was deleted at the player's request, and abuse investigation (e.g. repeated creation of deleted accounts). No email, name, or content is kept. Retention period: not yet automated (backlog: delete after 12 months). |
| `private.deletion_attempts` for the account | deleted at completion |
| Live game state on the game server | removed within 60 s (eligibility re-check); not persisted |
| Server logs (Edge Function, game server) | contain the account UUID and safe error codes only; governed by the hosting provider's log retention |

## Previously issued credentials

Access tokens are signed JWTs valid until they expire (1 hour). Deleting the account does not make
existing tokens fail to verify cryptographically, so Guildhood does not rely on that:

- **Refresh tokens** are deleted with the user: no new access tokens can be obtained (tested).
- **Data API:** row level security uses `auth.uid()`; the account owns no rows any more, so reads
  return nothing, and writes fail on foreign keys or "profile not found" (tested).
- **Auth API:** `getUser()` with the old token fails with `user_not_found` (tested).
- **Game server:** a new connection is refused because the player no longer exists; an existing
  connection is closed within 60 s by the eligibility re-check (tested).
- **Sign-in** with the old password fails; the same email can register again as a new account with
  a new id (tested).

## Operational notes

- Deploy: `npx supabase functions deploy delete-account --no-verify-jwt`. The function verifies
  callers itself, so the gateway's legacy JWT check is off (`[functions.delete-account] verify_jwt = false`).
- Cross-origin callers (the GitHub Pages site) must be listed:
  `npx supabase secrets set GUILDHOOD_ALLOWED_ORIGINS=https://<owner>.github.io`.
- Logs: one JSON line per request with `event_type`, `request_id`, `timestamp`, `environment`,
  `status`, `safe_error_code`, `stage` (the step that failed), `duration_ms`, and `user_id`. Never
  tokens, passwords, emails, or bodies (checked).
- Local development: after editing the function, restart its container
  (`docker restart supabase_edge_runtime_guildhood`) if changes are not picked up.
