-- Guildhood Phase 2: accounts and profiles.
--
-- Adds usernames (case-insensitive unique, central reserved-name policy), validated display
-- names, preset avatars, bio, profile visibility, server-tracked onboarding, private settings,
-- account restrictions with private moderator notes, a private audit log, and the trusted
-- functions that are now the only way players change their profile.
--
-- Access model (see docs/security.md for the full matrix):
--   * profiles rows are readable by their owner only. Other players see a public projection via
--     get_public_profile() / get_social_overview(), never whole rows.
--   * Players change profile fields only through validated SECURITY DEFINER functions; direct
--     column updates are revoked except profiles.active_vehicle_id (Phase 1, ownership enforced
--     by a composite foreign key).
--   * Restrictions, moderator notes, and audit events are not readable by clients.
--
-- Rollback: this migration is additive except for (a) the display-name constraint, which is
-- relaxed from Phase 1's, and (b) the dropped "profiles: read friends and request
-- counterparties" policy. docs/database-schema.md lists the statements to reverse it.

-- ---------------------------------------------------------------------------------------------
-- Avatar catalog (preset avatars only; artwork is drawn by the client from these ids)
-- ---------------------------------------------------------------------------------------------

create table public.avatar_catalog (
  id text primary key check (id ~ '^[a-z0-9_]{3,40}$'),
  name text not null,
  sort_order int not null default 0,
  is_active boolean not null default true
);

insert into public.avatar_catalog (id, name, sort_order) values
  ('leaf_moss', 'Moss Leaf', 1),
  ('wheel_copper', 'Copper Wheel', 2),
  ('lantern_amber', 'Amber Lantern', 3),
  ('key_brass', 'Brass Key', 4),
  ('star_sky', 'Sky Star', 5),
  ('bolt_sun', 'Sun Bolt', 6),
  ('moon_plum', 'Plum Moon', 7),
  ('house_brick', 'Brick House', 8),
  ('flag_cherry', 'Cherry Flag', 9),
  ('gear_slate', 'Slate Gear', 10),
  ('wave_mint', 'Mint Wave', 11),
  ('crown_chalk', 'Chalk Crown', 12);

-- ---------------------------------------------------------------------------------------------
-- Central policies: reserved usernames, validation, current terms version
-- ---------------------------------------------------------------------------------------------

create table private.reserved_usernames (
  term text primary key check (term ~ '^[a-z0-9_]{2,20}$'),
  -- exact: the username equals the term; contains: the term appears anywhere in the username.
  match_kind text not null check (match_kind in ('exact', 'contains'))
);

insert into private.reserved_usernames (term, match_kind) values
  ('admin', 'contains'),
  ('moderator', 'contains'),
  ('guildhood', 'contains'),
  ('official', 'contains'),
  ('administrator', 'exact'),
  ('mod', 'exact'),
  ('mods', 'exact'),
  ('support', 'exact'),
  ('system', 'exact'),
  ('staff', 'exact'),
  ('team', 'exact'),
  ('root', 'exact'),
  ('help', 'exact'),
  ('helpdesk', 'exact'),
  ('security', 'exact'),
  ('owner', 'exact'),
  ('everyone', 'exact'),
  ('here', 'exact'),
  ('null', 'exact'),
  ('undefined', 'exact'),
  ('deleted', 'exact'),
  ('deleted_player', 'exact');

create or replace function private.normalize_username(p_username text)
returns text
language sql
immutable
set search_path = ''
as $$
  select lower(btrim(coalesce(p_username, '')));
$$;

-- Returns null when the (already normalized) username is acceptable, else a reason code.
create or replace function private.username_problem(p_username text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when p_username is null or p_username !~ '^[a-z0-9_]{3,20}$' then 'invalid_format'
    when exists (
      select 1 from private.reserved_usernames r
      where (r.match_kind = 'exact' and r.term = p_username)
         or (r.match_kind = 'contains' and position(r.term in p_username) > 0)
    ) then 'reserved'
    else null
  end;
$$;

-- Plain-text checks shared by display names and bios: no control characters (bios may contain
-- line breaks) and no invisible or direction-changing characters used for impersonation.
create or replace function private.has_unsafe_characters(p_text text, p_allow_newlines boolean)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select case
    when p_allow_newlines then p_text ~ '[\x01-\x09\x0b-\x1f\x7f-\x9f]'
    else p_text ~ '[\x01-\x1f\x7f-\x9f]'
  end
  or p_text ~ '[​-‏‪-‮⁠-⁩﻿]';
$$;

create or replace function private.display_name_problem(p_name text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_name is null then 'required'
    when p_name <> btrim(p_name) then 'untrimmed'
    when char_length(p_name) < 2 or char_length(p_name) > 30 then 'length'
    when private.has_unsafe_characters(p_name, false) then 'characters'
    else null
  end;
$$;

-- Terms of service / privacy policy version a new account must accept (see apps/client legal pages).
create or replace function private.current_terms_version()
returns text
language sql
immutable
set search_path = ''
as $$
  select '2026-11-24';
$$;

-- ---------------------------------------------------------------------------------------------
-- Profiles: new identity fields and onboarding state
-- ---------------------------------------------------------------------------------------------

alter table public.profiles drop constraint profiles_display_name_format;

alter table public.profiles
  add column username text,
  add column avatar_asset_id text references public.avatar_catalog (id),
  add column bio text,
  add column profile_visibility text not null default 'friends',
  add column onboarding_step text default 'username',
  add column onboarding_completed_at timestamptz;

alter table public.profiles
  -- Stored normalized (lowercase), so the plain unique index is case-insensitive uniqueness.
  add constraint profiles_username_format check (username is null or username ~ '^[a-z0-9_]{3,20}$'),
  -- Checks are written inline (no function calls): constraints run with the caller's privileges,
  -- and players have no access to the private schema. Same rules as private.display_name_problem.
  add constraint profiles_display_name_valid check (
    char_length(display_name) between 2 and 30
    and display_name = btrim(display_name)
    and display_name !~ '[\x01-\x1f\x7f-\x9f]'
    and display_name !~ '[\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]'
  ),
  add constraint profiles_bio_valid check (
    bio is null or (
      char_length(bio) between 1 and 160
      and bio = btrim(bio)
      and bio !~ '[\x01-\x09\x0b-\x1f\x7f-\x9f]'
      and bio !~ '[\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]'
    )
  ),
  add constraint profiles_visibility_valid check (profile_visibility in ('public', 'friends', 'private')),
  add constraint profiles_onboarding_step_valid check (onboarding_step in ('username', 'display_name', 'avatar', 'review')),
  add constraint profiles_onboarding_consistent check (
    onboarding_completed_at is null
    or (username is not null and avatar_asset_id is not null and onboarding_step is null)
  );

create unique index profiles_username_key on public.profiles (username);

-- Defense in depth: reserved names are rejected even for writes that bypass the RPCs.
create or replace function private.enforce_username_policy()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.username is not null and (tg_op = 'INSERT' or new.username is distinct from old.username) then
    if private.username_problem(new.username) is not null then
      raise exception 'username_%', private.username_problem(new.username) using errcode = '22023';
    end if;
  end if;
  return new;
end;
$$;

create trigger profiles_username_policy
before insert or update of username on public.profiles
for each row execute function private.enforce_username_policy();

-- ---------------------------------------------------------------------------------------------
-- Private per-player settings
-- ---------------------------------------------------------------------------------------------

create table public.profile_private (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  privacy_settings jsonb not null default '{"allow_friend_requests": true}'::jsonb
    check (jsonb_typeof(privacy_settings) = 'object'),
  terms_version text,
  terms_accepted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger profile_private_touch_updated_at
before update on public.profile_private
for each row execute function private.touch_updated_at();

-- Existing (Phase 1) accounts get default settings; they never accepted the terms.
insert into public.profile_private (user_id) select id from public.profiles on conflict do nothing;

-- ---------------------------------------------------------------------------------------------
-- Account restrictions (moderation), private notes, audit log
-- ---------------------------------------------------------------------------------------------

create table public.account_restrictions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  restriction_type text not null check (restriction_type in ('suspended', 'banned')),
  -- Player-facing category only. Evidence and staff notes live in private.moderation_notes.
  reason_code text not null check (reason_code in ('harassment', 'cheating', 'spam', 'inappropriate_profile', 'other')),
  effective_at timestamptz not null default now(),
  expires_at timestamptz,
  lifted_at timestamptz,
  created_at timestamptz not null default now(),
  check (expires_at is null or expires_at > effective_at),
  check (restriction_type <> 'banned' or expires_at is null)
);

create index account_restrictions_user on public.account_restrictions (user_id);

create table private.moderation_notes (
  id bigint generated always as identity primary key,
  restriction_id uuid not null references public.account_restrictions (id) on delete cascade,
  note text not null check (char_length(note) between 1 and 4000),
  created_at timestamptz not null default now()
);

create table private.audit_events (
  id bigint generated always as identity primary key,
  event_type text not null check (event_type in (
    'profile_created', 'username_changed', 'onboarding_completed',
    'account_deletion_requested', 'account_deleted', 'restriction_added', 'restriction_lifted'
  )),
  -- Deliberately not a foreign key: the record of a deleted account's deletion must outlive it.
  user_id uuid not null,
  actor text not null check (actor in ('player', 'system', 'service')),
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index audit_events_user on private.audit_events (user_id, created_at);

create or replace function private.audit(p_user_id uuid, p_event text, p_actor text, p_details jsonb default '{}'::jsonb)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into private.audit_events (user_id, event_type, actor, details)
  values (p_user_id, p_event, p_actor, coalesce(p_details, '{}'::jsonb));
$$;

create or replace function private.active_restriction(p_user_id uuid)
returns public.account_restrictions
language sql
stable
security definer
set search_path = ''
as $$
  select r.* from public.account_restrictions r
  where r.user_id = p_user_id
    and r.lifted_at is null
    and r.effective_at <= now()
    and (r.expires_at is null or r.expires_at > now())
  order by (r.restriction_type = 'banned') desc, r.expires_at desc nulls first
  limit 1;
$$;

create or replace function private.require_unrestricted(p_user_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if (private.active_restriction(p_user_id)).id is not null then
    raise exception 'account_restricted' using errcode = '42501';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Account bootstrap (single provisioning path: the auth.users trigger)
-- ---------------------------------------------------------------------------------------------

-- Replaces the Phase 1 version: still creates the profile, wallet, and starter pack in the same
-- transaction as the account, and now also the private settings row (recording terms acceptance
-- only for the current version) and an audit event. Username, display name, and avatar are
-- chosen afterwards in onboarding.
create or replace function private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_code text;
  v_attempt int := 0;
  v_terms text := new.raw_user_meta_data ->> 'terms_version';
begin
  loop
    v_attempt := v_attempt + 1;
    v_code := private.random_friend_code();
    begin
      insert into public.profiles (id, display_name, friend_code)
      values (new.id, 'Driver-' || substr(v_code, 1, 4), v_code);
      exit;
    exception when unique_violation then
      if v_attempt >= 5 then
        raise;
      end if;
    end;
  end loop;

  insert into public.profile_private (user_id, terms_version, terms_accepted_at)
  values (
    new.id,
    case when v_terms = private.current_terms_version() then v_terms end,
    case when v_terms = private.current_terms_version() then now() end
  );

  insert into public.wallets (user_id) values (new.id);
  perform private.grant_starter_pack(new.id);
  perform private.audit(new.id, 'profile_created', 'system');
  return new;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Player functions (authenticated)
-- ---------------------------------------------------------------------------------------------

create or replace function private.own_profile_json(p_user_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'user_id', p.id,
    'username', p.username,
    'display_name', p.display_name,
    'avatar_asset_id', p.avatar_asset_id,
    'bio', p.bio,
    'profile_visibility', p.profile_visibility,
    'onboarding_step', p.onboarding_step,
    'onboarding_completed_at', p.onboarding_completed_at
  )
  from public.profiles p
  where p.id = p_user_id;
$$;

-- Availability check for the onboarding/profile UI. The database remains the authority: the
-- unique index decides races in claim_username().
create or replace function public.check_username(p_username text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_uid();
  v_name text := private.normalize_username(p_username);
  v_problem text := private.username_problem(v_name);
begin
  if v_problem is not null then
    return jsonb_build_object('username', v_name, 'available', false, 'reason', v_problem);
  end if;
  if exists (select 1 from public.profiles p where p.username = v_name and p.id <> v_uid) then
    return jsonb_build_object('username', v_name, 'available', false, 'reason', 'taken');
  end if;
  return jsonb_build_object('username', v_name, 'available', true, 'reason', null);
end;
$$;

-- Claims (onboarding) or changes the caller's username. Idempotent for the same name. Concurrent
-- claims of one name resolve through the unique index: exactly one caller wins.
create or replace function public.claim_username(p_username text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_uid();
  v_name text := private.normalize_username(p_username);
  v_problem text := private.username_problem(v_name);
  v_old text;
begin
  perform private.require_unrestricted(v_uid);
  if v_problem is not null then
    raise exception 'username_%', v_problem using errcode = '22023';
  end if;

  select p.username into v_old from public.profiles p where p.id = v_uid for update;
  if not found then
    raise exception 'profile_not_found' using errcode = 'P0002';
  end if;
  if v_old is not distinct from v_name then
    return private.own_profile_json(v_uid);
  end if;

  begin
    update public.profiles
    set username = v_name,
        onboarding_step = case when onboarding_step = 'username' then 'display_name' else onboarding_step end
    where id = v_uid;
  exception when unique_violation then
    raise exception 'username_taken' using errcode = '23505';
  end;

  if v_old is not null then
    perform private.audit(v_uid, 'username_changed', 'player', jsonb_build_object('old_username', v_old, 'new_username', v_name));
  end if;
  return private.own_profile_json(v_uid);
end;
$$;

-- Partial profile update. p_changes may contain only: display_name, avatar_asset_id, bio,
-- profile_visibility. Absent keys are left unchanged; bio null or '' clears it.
create or replace function public.update_my_profile(p_changes jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_uid();
  v_key text;
  v_profile public.profiles%rowtype;
  v_display text;
  v_avatar text;
  v_bio text;
  v_visibility text;
  v_step text;
begin
  perform private.require_unrestricted(v_uid);
  if p_changes is null or jsonb_typeof(p_changes) <> 'object' or p_changes = '{}'::jsonb then
    raise exception 'no_changes' using errcode = '22023';
  end if;
  for v_key in select jsonb_object_keys(p_changes) loop
    if v_key not in ('display_name', 'avatar_asset_id', 'bio', 'profile_visibility') then
      raise exception 'field_not_editable' using errcode = '42501', detail = v_key;
    end if;
  end loop;

  select * into v_profile from public.profiles p where p.id = v_uid for update;
  if not found then
    raise exception 'profile_not_found' using errcode = 'P0002';
  end if;

  v_display := v_profile.display_name;
  if p_changes ? 'display_name' then
    if jsonb_typeof(p_changes -> 'display_name') <> 'string' then
      raise exception 'display_name_invalid' using errcode = '22023';
    end if;
    v_display := btrim(p_changes ->> 'display_name');
    if private.display_name_problem(v_display) is not null then
      raise exception 'display_name_invalid' using errcode = '22023', detail = private.display_name_problem(v_display);
    end if;
  end if;

  v_avatar := v_profile.avatar_asset_id;
  if p_changes ? 'avatar_asset_id' then
    v_avatar := p_changes ->> 'avatar_asset_id';
    if v_avatar is null or not exists (select 1 from public.avatar_catalog a where a.id = v_avatar and a.is_active) then
      raise exception 'avatar_invalid' using errcode = '22023';
    end if;
  end if;

  v_bio := v_profile.bio;
  if p_changes ? 'bio' then
    if jsonb_typeof(p_changes -> 'bio') not in ('string', 'null') then
      raise exception 'bio_invalid' using errcode = '22023';
    end if;
    v_bio := nullif(btrim(coalesce(p_changes ->> 'bio', '')), '');
    if v_bio is not null and (char_length(v_bio) > 160 or private.has_unsafe_characters(v_bio, true)) then
      raise exception 'bio_invalid' using errcode = '22023';
    end if;
  end if;

  v_visibility := v_profile.profile_visibility;
  if p_changes ? 'profile_visibility' then
    v_visibility := p_changes ->> 'profile_visibility';
    if v_visibility is null or v_visibility not in ('public', 'friends', 'private') then
      raise exception 'visibility_invalid' using errcode = '22023';
    end if;
  end if;

  -- Onboarding advances only forward, one confirmed step at a time.
  v_step := v_profile.onboarding_step;
  if v_step = 'display_name' and p_changes ? 'display_name' then
    v_step := 'avatar';
  end if;
  if v_step = 'avatar' and p_changes ? 'avatar_asset_id' then
    v_step := 'review';
  end if;

  update public.profiles
  set display_name = v_display,
      avatar_asset_id = v_avatar,
      bio = v_bio,
      profile_visibility = v_visibility,
      onboarding_step = v_step
  where id = v_uid;

  return private.own_profile_json(v_uid);
end;
$$;

-- Marks onboarding complete once every step has been saved. Idempotent.
create or replace function public.complete_onboarding()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_uid();
  v_profile public.profiles%rowtype;
begin
  select * into v_profile from public.profiles p where p.id = v_uid for update;
  if not found then
    raise exception 'profile_not_found' using errcode = 'P0002';
  end if;
  if v_profile.onboarding_completed_at is not null then
    return private.own_profile_json(v_uid);
  end if;
  if v_profile.onboarding_step is distinct from 'review' or v_profile.username is null or v_profile.avatar_asset_id is null then
    raise exception 'onboarding_incomplete' using errcode = '22023', detail = coalesce(v_profile.onboarding_step, 'unknown');
  end if;

  update public.profiles
  set onboarding_completed_at = now(), onboarding_step = null
  where id = v_uid;
  perform private.audit(v_uid, 'onboarding_completed', 'player');
  return private.own_profile_json(v_uid);
end;
$$;

-- The public profile card: only approved fields, only when the owner's visibility allows it.
-- Hidden and nonexistent profiles look the same (null).
create or replace function public.get_public_profile(p_username text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_uid();
  v_profile public.profiles%rowtype;
begin
  select * into v_profile from public.profiles p
  where p.username = private.normalize_username(p_username) and p.onboarding_completed_at is not null;
  if not found then
    return null;
  end if;
  if not (
    v_profile.id = v_uid
    or v_profile.profile_visibility = 'public'
    or (v_profile.profile_visibility = 'friends' and private.are_friends(v_uid, v_profile.id))
  ) then
    return null;
  end if;
  return jsonb_build_object(
    'username', v_profile.username,
    'display_name', v_profile.display_name,
    'avatar_asset_id', v_profile.avatar_asset_id,
    'bio', v_profile.bio
  );
end;
$$;

-- The caller's own restriction status. Never includes moderator notes or evidence.
create or replace function public.get_my_account_status()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_uid();
  v_r public.account_restrictions;
begin
  v_r := private.active_restriction(v_uid);
  if v_r.id is null then
    return jsonb_build_object('status', 'active');
  end if;
  return jsonb_build_object(
    'status', 'restricted',
    'restriction_type', v_r.restriction_type,
    'reason_code', v_r.reason_code,
    'effective_at', v_r.effective_at,
    'expires_at', v_r.expires_at
  );
end;
$$;

-- Private settings. Only known keys with the right types are accepted.
create or replace function public.update_my_privacy_settings(p_settings jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_uid();
  v_key text;
  v_result jsonb;
begin
  if p_settings is null or jsonb_typeof(p_settings) <> 'object' or p_settings = '{}'::jsonb then
    raise exception 'no_changes' using errcode = '22023';
  end if;
  for v_key in select jsonb_object_keys(p_settings) loop
    if v_key <> 'allow_friend_requests' or jsonb_typeof(p_settings -> v_key) <> 'boolean' then
      raise exception 'setting_invalid' using errcode = '22023', detail = v_key;
    end if;
  end loop;
  update public.profile_private
  set privacy_settings = privacy_settings || p_settings
  where user_id = v_uid
  returning privacy_settings into v_result;
  if not found then
    raise exception 'profile_not_found' using errcode = 'P0002';
  end if;
  return v_result;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Phase 1 social functions, updated: restricted players cannot send requests or invites, the
-- "allow friend requests" setting is enforced, and friends lists use the public projection.
-- ---------------------------------------------------------------------------------------------

create or replace function public.send_friend_request(p_friend_code text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_uid();
  v_code text := upper(regexp_replace(coalesce(p_friend_code, ''), '[\s-]', '', 'g'));
  v_target uuid;
  v_reverse uuid;
  v_existing uuid;
  v_request uuid;
  v_my_name text;
begin
  perform private.require_unrestricted(v_uid);
  if v_code !~ '^[A-HJ-NP-Z2-9]{8}$' then
    raise exception 'invalid_friend_code' using errcode = '22023';
  end if;

  select p.id into v_target from public.profiles p where p.friend_code = v_code;
  if not found then
    raise exception 'friend_code_not_found' using errcode = 'P0002';
  end if;
  if v_target = v_uid then
    raise exception 'cannot_friend_self' using errcode = '22023';
  end if;

  perform 1 from public.profiles p where p.id in (v_uid, v_target) order by p.id for update;

  if private.are_friends(v_uid, v_target) then
    return jsonb_build_object('status', 'already_friends', 'request_id', null);
  end if;

  select p.display_name into v_my_name from public.profiles p where p.id = v_uid;

  select r.id into v_reverse from public.friend_requests r
  where r.from_user = v_target and r.to_user = v_uid and r.status = 'pending';
  if found then
    update public.friend_requests set status = 'accepted', responded_at = now() where id = v_reverse;
    perform private.make_friends(v_uid, v_target);
    perform private.notify(v_target, 'friend_request_accepted',
      jsonb_build_object('request_id', v_reverse, 'friend_id', v_uid, 'friend_name', v_my_name));
    return jsonb_build_object('status', 'accepted', 'request_id', v_reverse);
  end if;

  select r.id into v_existing from public.friend_requests r
  where r.from_user = v_uid and r.to_user = v_target and r.status = 'pending';
  if found then
    return jsonb_build_object('status', 'already_pending', 'request_id', v_existing);
  end if;

  if coalesce((select (pp.privacy_settings ->> 'allow_friend_requests')::boolean from public.profile_private pp where pp.user_id = v_target), true) is false then
    raise exception 'not_accepting_friend_requests' using errcode = 'P0001';
  end if;

  if (select count(*) from public.friend_requests r where r.from_user = v_uid and r.status = 'pending') >= 50 then
    raise exception 'too_many_pending_requests' using errcode = 'P0001';
  end if;

  insert into public.friend_requests (from_user, to_user) values (v_uid, v_target) returning id into v_request;
  perform private.notify(v_target, 'friend_request',
    jsonb_build_object('request_id', v_request, 'from_user', v_uid, 'from_name', v_my_name));
  return jsonb_build_object('status', 'sent', 'request_id', v_request);
end;
$$;

create or replace function public.invite_friend_to_session(p_friend_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_uid();
  v_instance public.session_instances%rowtype;
  v_my_name text;
  v_neighborhood_name text;
begin
  perform private.require_unrestricted(v_uid);
  if not private.are_friends(v_uid, p_friend_id) then
    raise exception 'not_friends' using errcode = '42501';
  end if;

  select si.* into v_instance
  from public.session_presence sp
  join public.session_instances si on si.id = sp.instance_id
  where sp.user_id = v_uid and private.instance_is_live(si.status, si.last_heartbeat_at);
  if not found then
    raise exception 'not_in_session' using errcode = 'P0001';
  end if;

  if exists (
    select 1 from public.notifications n
    where n.user_id = p_friend_id
      and n.kind = 'session_invite'
      and n.payload ->> 'from_user' = v_uid::text
      and n.payload ->> 'instance_id' = v_instance.id::text
      and n.created_at > now() - interval '20 seconds'
  ) then
    return jsonb_build_object('status', 'throttled');
  end if;

  select p.display_name into v_my_name from public.profiles p where p.id = v_uid;
  select n.name into v_neighborhood_name from public.neighborhoods n where n.id = v_instance.neighborhood_id;

  perform private.notify(p_friend_id, 'session_invite', jsonb_build_object(
    'instance_id', v_instance.id,
    'neighborhood_id', v_instance.neighborhood_id,
    'neighborhood_name', v_neighborhood_name,
    'from_user', v_uid,
    'from_name', v_my_name
  ));
  return jsonb_build_object('status', 'sent');
end;
$$;

create or replace function public.get_social_overview()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with me as (
    select private.require_uid() as uid
  ),
  friend_ids as (
    select case when f.user_low = me.uid then f.user_high else f.user_low end as friend_id
    from public.friendships f, me
    where me.uid in (f.user_low, f.user_high)
  ),
  friends as (
    select
      p.id,
      p.display_name,
      p.username,
      p.avatar_asset_id,
      case when private.instance_is_live(si.status, si.last_heartbeat_at) then si.id end as instance_id,
      case when private.instance_is_live(si.status, si.last_heartbeat_at) then si.neighborhood_id end as neighborhood_id,
      case when private.instance_is_live(si.status, si.last_heartbeat_at) then n.name end as neighborhood_name,
      case when private.instance_is_live(si.status, si.last_heartbeat_at) then si.player_count end as player_count,
      case when private.instance_is_live(si.status, si.last_heartbeat_at) then si.capacity end as capacity
    from friend_ids fi
    join public.profiles p on p.id = fi.friend_id
    left join public.session_presence sp on sp.user_id = p.id
    left join public.session_instances si on si.id = sp.instance_id
    left join public.neighborhoods n on n.id = si.neighborhood_id
  )
  select jsonb_build_object(
    'friends', coalesce((
      select jsonb_agg(jsonb_build_object(
        'user_id', f.id,
        'display_name', f.display_name,
        'username', f.username,
        'avatar_asset_id', f.avatar_asset_id,
        'online', f.instance_id is not null,
        'instance_id', f.instance_id,
        'neighborhood_id', f.neighborhood_id,
        'neighborhood_name', f.neighborhood_name,
        'player_count', f.player_count,
        'capacity', f.capacity
      ) order by (f.instance_id is not null) desc, lower(f.display_name))
      from friends f
    ), '[]'::jsonb),
    'incoming', coalesce((
      select jsonb_agg(jsonb_build_object(
        'request_id', r.id, 'user_id', p.id, 'display_name', p.display_name, 'username', p.username,
        'avatar_asset_id', p.avatar_asset_id, 'created_at', r.created_at
      ) order by r.created_at desc)
      from public.friend_requests r
      join public.profiles p on p.id = r.from_user
      cross join me
      where r.to_user = me.uid and r.status = 'pending'
    ), '[]'::jsonb),
    'outgoing', coalesce((
      select jsonb_agg(jsonb_build_object(
        'request_id', r.id, 'user_id', p.id, 'display_name', p.display_name, 'username', p.username,
        'avatar_asset_id', p.avatar_asset_id, 'created_at', r.created_at
      ) order by r.created_at desc)
      from public.friend_requests r
      join public.profiles p on p.id = r.to_user
      cross join me
      where r.from_user = me.uid and r.status = 'pending'
    ), '[]'::jsonb)
  );
$$;

-- ---------------------------------------------------------------------------------------------
-- Trusted backend functions (service_role only)
-- ---------------------------------------------------------------------------------------------

-- Phase 1 loadout, now with identity and eligibility for the game server's handshake.
create or replace function public.server_get_player(p_user_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'user_id', p.id,
    'display_name', p.display_name,
    'username', p.username,
    'avatar_asset_id', p.avatar_asset_id,
    'onboarding_complete', p.onboarding_completed_at is not null,
    'restriction', (
      select jsonb_build_object('restriction_type', r.restriction_type, 'expires_at', r.expires_at)
      from (select (private.active_restriction(p.id)).*) r
      where r.id is not null
    ),
    'vehicle', (
      select jsonb_build_object('id', v.id, 'model_id', v.model_id, 'color_index', v.color_index)
      from public.player_vehicles v
      where v.id = p.active_vehicle_id and v.owner_id = p.id
    ),
    'friend_ids', coalesce((
      select jsonb_agg(case when f.user_low = p.id then f.user_high else f.user_low end)
      from public.friendships f
      where p.id in (f.user_low, f.user_high)
    ), '[]'::jsonb),
    'neighborhood_ids', coalesce((
      select jsonb_agg(m.neighborhood_id)
      from public.neighborhood_memberships m
      where m.user_id = p.id
    ), '[]'::jsonb)
  )
  from public.profiles p
  where p.id = p_user_id;
$$;

create or replace function public.server_add_restriction(
  p_user_id uuid,
  p_restriction_type text,
  p_reason_code text,
  p_expires_at timestamptz,
  p_note text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  insert into public.account_restrictions (user_id, restriction_type, reason_code, expires_at)
  values (p_user_id, p_restriction_type, p_reason_code, p_expires_at)
  returning id into v_id;
  if p_note is not null and btrim(p_note) <> '' then
    insert into private.moderation_notes (restriction_id, note) values (v_id, p_note);
  end if;
  perform private.audit(p_user_id, 'restriction_added', 'service', jsonb_build_object(
    'restriction_id', v_id, 'restriction_type', p_restriction_type, 'reason_code', p_reason_code, 'expires_at', p_expires_at));
  return v_id;
end;
$$;

create or replace function public.server_lift_restriction(p_restriction_id uuid, p_note text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid;
begin
  update public.account_restrictions set lifted_at = now()
  where id = p_restriction_id and lifted_at is null
  returning user_id into v_user;
  if not found then
    raise exception 'restriction_not_found' using errcode = 'P0002';
  end if;
  if p_note is not null and btrim(p_note) <> '' then
    insert into private.moderation_notes (restriction_id, note) values (p_restriction_id, p_note);
  end if;
  perform private.audit(v_user, 'restriction_lifted', 'service', jsonb_build_object('restriction_id', p_restriction_id));
end;
$$;

-- Step 1 of account deletion (called by the delete-account Edge Function after it has verified
-- the caller and their password). Removes the player's traces from OTHER players' data that
-- would not cascade, and records the request. Safe to call more than once.
create or replace function public.server_begin_account_deletion(p_user_id uuid, p_request_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_invites int;
  v_anonymized int;
begin
  if not exists (select 1 from public.profiles p where p.id = p_user_id) then
    return jsonb_build_object('status', 'not_found');
  end if;

  perform private.audit(p_user_id, 'account_deletion_requested', 'player', jsonb_build_object('request_id', p_request_id));

  -- Session invites from this player are useless once they are gone.
  delete from public.notifications n
  where n.kind = 'session_invite' and n.payload ->> 'from_user' = p_user_id::text;
  get diagnostics v_invites = row_count;

  -- Friend-request notifications in other players' inboxes keep no name or id of this player.
  update public.notifications n
  set payload = (n.payload - 'from_user' - 'from_name' - 'friend_id' - 'friend_name')
                || jsonb_build_object(case when n.kind = 'friend_request' then 'from_name' else 'friend_name' end, 'A deleted player')
  where n.user_id <> p_user_id
    and (n.payload ->> 'from_user' = p_user_id::text or n.payload ->> 'friend_id' = p_user_id::text);
  get diagnostics v_anonymized = row_count;

  -- Username history is personal data; keep only the fact and time of each event.
  update private.audit_events a
  set details = a.details - 'old_username' - 'new_username'
  where a.user_id = p_user_id;

  return jsonb_build_object('status', 'ready', 'invites_removed', v_invites, 'notifications_anonymized', v_anonymized);
end;
$$;

-- Step 3 (after Auth has deleted the user, which cascades all of the player's own rows).
create or replace function public.server_finish_account_deletion(p_user_id uuid, p_request_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (select 1 from auth.users u where u.id = p_user_id)
     or exists (select 1 from public.profiles p where p.id = p_user_id) then
    raise exception 'deletion_incomplete' using errcode = 'P0001';
  end if;
  delete from private.deletion_attempts a where a.user_id = p_user_id;
  if not exists (
    select 1 from private.audit_events a where a.user_id = p_user_id and a.event_type = 'account_deleted'
  ) then
    perform private.audit(p_user_id, 'account_deleted', 'player', jsonb_build_object('request_id', p_request_id));
  end if;
  return jsonb_build_object('status', 'deleted');
end;
$$;

-- Per-account limit on password confirmations for deletion. The Edge Function checks the
-- password through Auth, where every request comes from the function's own address, so Auth's
-- per-address rate limit cannot protect individual accounts from guessing with a stolen session.
create table private.deletion_attempts (
  user_id uuid not null,
  attempted_at timestamptz not null default now()
);

create index deletion_attempts_user on private.deletion_attempts (user_id, attempted_at);

create or replace function public.server_deletion_attempt_allowed(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select count(*) < 5 from private.deletion_attempts a
  where a.user_id = p_user_id and a.attempted_at > now() - interval '15 minutes';
$$;

create or replace function public.server_record_failed_deletion_attempt(p_user_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into private.deletion_attempts (user_id) values (p_user_id);
$$;

-- ---------------------------------------------------------------------------------------------
-- RLS, policies, and privileges
-- ---------------------------------------------------------------------------------------------

alter table public.avatar_catalog enable row level security;
alter table public.profile_private enable row level security;
alter table public.account_restrictions enable row level security;

revoke all on table public.avatar_catalog, public.profile_private, public.account_restrictions from anon, authenticated;
grant select on public.avatar_catalog to anon, authenticated;
grant select on public.profile_private to authenticated;

create policy "avatar_catalog: anyone can read"
on public.avatar_catalog for select to anon, authenticated
using (true);

create policy "profile_private: owner reads"
on public.profile_private for select to authenticated
using (user_id = (select auth.uid()));
-- account_restrictions: no client policies at all (status via get_my_account_status()).

-- Profiles: other players now get projections, not rows; names change through update_my_profile.
drop policy "profiles: read friends and request counterparties" on public.profiles;
revoke update (display_name) on public.profiles from authenticated;

revoke all on all functions in schema private from public, anon, authenticated;
revoke all on table private.reserved_usernames, private.moderation_notes, private.audit_events, private.deletion_attempts from public, anon, authenticated;

revoke all on function
  public.check_username(text),
  public.claim_username(text),
  public.update_my_profile(jsonb),
  public.complete_onboarding(),
  public.get_public_profile(text),
  public.get_my_account_status(),
  public.update_my_privacy_settings(jsonb),
  public.send_friend_request(text),
  public.invite_friend_to_session(uuid),
  public.get_social_overview()
from public, anon;
grant execute on function
  public.check_username(text),
  public.claim_username(text),
  public.update_my_profile(jsonb),
  public.complete_onboarding(),
  public.get_public_profile(text),
  public.get_my_account_status(),
  public.update_my_privacy_settings(jsonb),
  public.send_friend_request(text),
  public.invite_friend_to_session(uuid),
  public.get_social_overview()
to authenticated;

revoke all on function
  public.server_get_player(uuid),
  public.server_add_restriction(uuid, text, text, timestamptz, text),
  public.server_lift_restriction(uuid, text),
  public.server_begin_account_deletion(uuid, text),
  public.server_finish_account_deletion(uuid, text),
  public.server_deletion_attempt_allowed(uuid),
  public.server_record_failed_deletion_attempt(uuid)
from public, anon, authenticated;
grant execute on function
  public.server_get_player(uuid),
  public.server_add_restriction(uuid, text, text, timestamptz, text),
  public.server_lift_restriction(uuid, text),
  public.server_begin_account_deletion(uuid, text),
  public.server_finish_account_deletion(uuid, text),
  public.server_deletion_attempt_allowed(uuid),
  public.server_record_failed_deletion_attempt(uuid)
to service_role;
