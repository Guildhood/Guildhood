# Database schema

Supabase Postgres. All changes are versioned migrations in `supabase/migrations/`, applied in
order by `npx supabase db reset` (local) or `npx supabase db push` (hosted). No dashboard edits are
required or assumed.

| Migration | Contents |
|---|---|
| `20261123190000_phase1_accounts_vehicles_wallet.sql` | profiles (Phase 1 fields), neighborhoods, memberships, vehicle catalog and ownership, wallet + append-only ledger, starter pack, signup trigger |
| `20261123190100_phase1_social.sql` | friend requests, friendships, notifications (Realtime) |
| `20261123190200_phase1_live_sessions.sql` | live-instance registry, presence, invites, game-server functions |
| `20261124190000_phase2_accounts_profiles.sql` | usernames, profile fields, onboarding, avatar catalog, `profile_private`, restrictions, moderator notes, audit log, deletion support, updated social functions |

## Identity and profile tables (Phase 2)

### `public.profiles`

The player's identity. `id` **is** the user id: primary key and foreign key to `auth.users(id)`
(on delete cascade). The spec's `user_id` maps to this column; it was not renamed, to keep Phase 1
code and foreign keys intact.

| Column | Type | Rules |
|---|---|---|
| `id` | uuid | = `auth.users.id`; never changeable by players |
| `username` | text, null until claimed | normalized lowercase `^[a-z0-9_]{3,20}$`; unique index (case-insensitive by normalization); reserved names refused |
| `display_name` | text | 2–30 characters, trimmed, no control/invisible characters; default `Driver-XXXX` until onboarding |
| `avatar_asset_id` | text → `avatar_catalog(id)` | must be active when chosen |
| `bio` | text, nullable | ≤ 160 characters, trimmed, plain text |
| `profile_visibility` | text | `public` / `friends` (default) / `private` |
| `onboarding_step` | text, nullable | `username` → `display_name` → `avatar` → `review`; null when complete |
| `onboarding_completed_at` | timestamptz | set only by `complete_onboarding()`; requires username and avatar |
| `friend_code` | text | Phase 1; 8 characters, unique |
| `active_vehicle_id` | uuid | Phase 1; must reference a car the player owns |
| `created_at`, `updated_at` | timestamptz | server-set (`updated_at` by trigger) |

Provisioning: a single path, the `on_auth_user_created` trigger on `auth.users`, creates the
profile, `profile_private`, wallet, and starter pack in the same transaction as the account, and
writes a `profile_created` audit event. Onboarding then fills in username, display name, and avatar
through functions. Repeating any step is harmless (idempotent); concurrent username claims have one
winner.

### `public.profile_private`

| Column | Notes |
|---|---|
| `user_id` | PK, → profiles (cascade) |
| `privacy_settings` | jsonb object; currently `allow_friend_requests` (boolean, enforced by `send_friend_request`) |
| `terms_version`, `terms_accepted_at` | recorded at signup only if the accepted version is current |
| `created_at`, `updated_at` | server-set |

No email, password, or token is copied here.

### `public.avatar_catalog`

12 preset avatars (`id`, `name`, `sort_order`, `is_active`). Artwork is drawn by the client from
the id (`apps/client/src/ui/avatars.ts`). A test keeps the catalog and the client list identical.

### `public.account_restrictions`

`id`, `user_id` (→ profiles, cascade), `restriction_type` (`suspended` | `banned`), `reason_code`
(`harassment` | `cheating` | `spam` | `inappropriate_profile` | `other`), `effective_at`,
`expires_at` (bans: null), `lifted_at`, `created_at`. RLS on, **no client grants**. Players see
their status through `get_my_account_status()`.

### Private schema (not exposed through the API)

| Table | Purpose |
|---|---|
| `private.reserved_usernames` | central reserved-name policy (`term`, `match_kind` exact/contains) |
| `private.moderation_notes` | staff notes per restriction (never sent to clients) |
| `private.audit_events` | `profile_created`, `username_changed`, `onboarding_completed`, `account_deletion_requested`, `account_deleted`, `restriction_added`, `restriction_lifted`; `user_id` has no foreign key so deletion records outlive the account |
| `private.deletion_attempts` | failed password confirmations for deletion (rate limit) |

## Functions (Phase 2)

| Function | Caller | Purpose |
|---|---|---|
| `check_username(text)` | authenticated | availability: `invalid_format` / `reserved` / `taken` / available |
| `claim_username(text)` | authenticated | set or change the caller's username (audited after the first claim) |
| `update_my_profile(jsonb)` | authenticated | partial update of display name, avatar, bio, visibility; advances onboarding |
| `complete_onboarding()` | authenticated | finish onboarding (idempotent) |
| `get_public_profile(text)` | authenticated | visibility-aware public card |
| `get_my_account_status()` | authenticated | own restriction status |
| `update_my_privacy_settings(jsonb)` | authenticated | private settings (known keys only) |
| `get_social_overview()`, `send_friend_request`, `invite_friend_to_session` | authenticated | Phase 1, updated (restrictions, privacy, avatar/username in lists) |
| `server_get_player(uuid)` | service_role | loadout + eligibility for the game server |
| `server_add_restriction`, `server_lift_restriction` | service_role | moderation |
| `server_begin_account_deletion`, `server_finish_account_deletion`, `server_deletion_attempt_allowed`, `server_record_failed_deletion_attempt` | service_role | used by the delete-account function |

## Migration and rollback notes (Phase 2)

Applying: additive, except:

1. The Phase 1 display-name constraint (`profiles_display_name_format`, 3–20 ASCII) is replaced by
   `profiles_display_name_valid` (2–30, Unicode plain text). Existing names satisfy both.
2. The policy "profiles: read friends and request counterparties" is dropped (rows become owner-only).
3. `update (display_name)` on `profiles` is revoked from `authenticated` (renames go through
   `update_my_profile`).
4. Existing (Phase 1) accounts get `onboarding_step = 'username'`, so they go through onboarding on
   next sign-in, and a default `profile_private` row (no terms acceptance recorded).

Rolling back (only if no Phase 2 client has been released; data in the new columns is lost):

```sql
-- reverse 2 and 3
create policy "profiles: read friends and request counterparties" on public.profiles for select to authenticated
  using (/* body from 20261123190100_phase1_social.sql */ true);
grant update (display_name) on public.profiles to authenticated;
-- reverse 1
alter table public.profiles drop constraint profiles_display_name_valid;
alter table public.profiles add constraint profiles_display_name_format
  check (display_name ~ '^[A-Za-z0-9][A-Za-z0-9 _-]{1,18}[A-Za-z0-9]$');  -- fails if new-style names exist
-- then drop the new functions, tables, and columns, and restore the Phase 1 versions of
-- handle_new_user, send_friend_request, invite_friend_to_session, get_social_overview,
-- server_get_player from the Phase 1 migrations.
```

Prefer rolling forward with a new migration over rolling back. Hosted projects: take a backup
before `db push`.
