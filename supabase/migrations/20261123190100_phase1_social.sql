-- Guildhood Phase 1 / migration 2 of 3
-- Friends (friend codes, requests, friendships) and per-player notifications delivered via
-- Supabase Realtime. All writes go through SECURITY DEFINER functions that derive the caller from
-- auth.uid(); clients cannot insert or modify these rows directly.

create table public.friend_requests (
  id uuid primary key default gen_random_uuid(),
  from_user uuid not null references public.profiles (id) on delete cascade,
  to_user uuid not null references public.profiles (id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'declined', 'cancelled')),
  created_at timestamptz not null default now(),
  responded_at timestamptz,
  check (from_user <> to_user)
);

-- At most one pending request per pair, in either direction.
create unique index friend_requests_one_pending_per_pair
  on public.friend_requests (least(from_user, to_user), greatest(from_user, to_user))
  where status = 'pending';
create index friend_requests_to_pending on public.friend_requests (to_user) where status = 'pending';
create index friend_requests_from_pending on public.friend_requests (from_user) where status = 'pending';

create table public.friendships (
  user_low uuid not null references public.profiles (id) on delete cascade,
  user_high uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_low, user_high),
  check (user_low < user_high)
);

create index friendships_high on public.friendships (user_high);

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  kind text not null check (kind in ('friend_request', 'friend_request_accepted', 'session_invite')),
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  read_at timestamptz
);

create index notifications_user_created on public.notifications (user_id, created_at desc);

-- ---------------------------------------------------------------------------------------------
-- Internal helpers
-- ---------------------------------------------------------------------------------------------

create or replace function private.are_friends(p_a uuid, p_b uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.friendships f
    where f.user_low = least(p_a, p_b) and f.user_high = greatest(p_a, p_b)
  );
$$;

create or replace function private.notify(p_user_id uuid, p_kind text, p_payload jsonb)
returns uuid
language sql
security definer
set search_path = ''
as $$
  insert into public.notifications (user_id, kind, payload)
  values (p_user_id, p_kind, p_payload)
  returning id;
$$;

create or replace function private.require_uid()
returns uuid
language plpgsql
stable
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  return v_uid;
end;
$$;

create or replace function private.make_friends(p_a uuid, p_b uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.friendships (user_low, user_high)
  values (least(p_a, p_b), greatest(p_a, p_b))
  on conflict do nothing;
$$;

-- ---------------------------------------------------------------------------------------------
-- Client RPCs (authenticated)
-- ---------------------------------------------------------------------------------------------

-- Send a friend request by friend code. If the other player already asked us, this accepts.
-- Returns {status: 'sent' | 'accepted' | 'already_friends' | 'already_pending', request_id}.
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

  -- Serialize concurrent requests between this pair (consistent lock order avoids deadlock).
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

  if (select count(*) from public.friend_requests r where r.from_user = v_uid and r.status = 'pending') >= 50 then
    raise exception 'too_many_pending_requests' using errcode = 'P0001';
  end if;

  insert into public.friend_requests (from_user, to_user) values (v_uid, v_target) returning id into v_request;
  perform private.notify(v_target, 'friend_request',
    jsonb_build_object('request_id', v_request, 'from_user', v_uid, 'from_name', v_my_name));
  return jsonb_build_object('status', 'sent', 'request_id', v_request);
end;
$$;

-- Accept or decline a request addressed to the caller.
create or replace function public.respond_friend_request(p_request_id uuid, p_accept boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_uid();
  v_req public.friend_requests%rowtype;
  v_my_name text;
begin
  select * into v_req from public.friend_requests r
  where r.id = p_request_id and r.to_user = v_uid
  for update;
  if not found then
    raise exception 'request_not_found' using errcode = 'P0002';
  end if;
  if v_req.status <> 'pending' then
    return jsonb_build_object('status', v_req.status);
  end if;

  if p_accept then
    update public.friend_requests set status = 'accepted', responded_at = now() where id = v_req.id;
    perform private.make_friends(v_req.from_user, v_req.to_user);
    select p.display_name into v_my_name from public.profiles p where p.id = v_uid;
    perform private.notify(v_req.from_user, 'friend_request_accepted',
      jsonb_build_object('request_id', v_req.id, 'friend_id', v_uid, 'friend_name', v_my_name));
    return jsonb_build_object('status', 'accepted');
  end if;

  update public.friend_requests set status = 'declined', responded_at = now() where id = v_req.id;
  return jsonb_build_object('status', 'declined');
end;
$$;

-- Withdraw a request the caller sent.
create or replace function public.cancel_friend_request(p_request_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_uid();
begin
  update public.friend_requests
  set status = 'cancelled', responded_at = now()
  where id = p_request_id and from_user = v_uid and status = 'pending';
  if not found then
    raise exception 'request_not_found' using errcode = 'P0002';
  end if;
  return jsonb_build_object('status', 'cancelled');
end;
$$;

create or replace function public.remove_friend(p_friend_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_uid();
begin
  delete from public.friendships
  where user_low = least(v_uid, p_friend_id) and user_high = greatest(v_uid, p_friend_id);
  if not found then
    raise exception 'not_friends' using errcode = 'P0002';
  end if;
  return jsonb_build_object('status', 'removed');
end;
$$;

create or replace function public.mark_notifications_read(p_ids uuid[])
returns int
language sql
security definer
set search_path = ''
as $$
  with updated as (
    update public.notifications n
    set read_at = now()
    where n.user_id = private.require_uid() and n.id = any (p_ids) and n.read_at is null
    returning 1
  )
  select count(*)::int from updated;
$$;

-- ---------------------------------------------------------------------------------------------
-- RLS and privileges
-- ---------------------------------------------------------------------------------------------

alter table public.friend_requests enable row level security;
alter table public.friendships enable row level security;
alter table public.notifications enable row level security;

revoke all on table public.friend_requests, public.friendships, public.notifications from anon, authenticated;
grant select on public.friend_requests, public.friendships, public.notifications to authenticated;

create policy "friend_requests: read own sent or received"
on public.friend_requests for select to authenticated
using ((select auth.uid()) in (from_user, to_user));

create policy "friendships: read own"
on public.friendships for select to authenticated
using ((select auth.uid()) in (user_low, user_high));

create policy "notifications: read own"
on public.notifications for select to authenticated
using (user_id = (select auth.uid()));

-- Friends and people with a pending request between you can see each other's profile
-- (display name and friend code). Strangers cannot.
create policy "profiles: read friends and request counterparties"
on public.profiles for select to authenticated
using (
  exists (
    select 1 from public.friendships f
    where (f.user_low = (select auth.uid()) and f.user_high = profiles.id)
       or (f.user_high = (select auth.uid()) and f.user_low = profiles.id)
  )
  or exists (
    select 1 from public.friend_requests r
    where r.status = 'pending'
      and ((r.from_user = (select auth.uid()) and r.to_user = profiles.id)
        or (r.to_user = (select auth.uid()) and r.from_user = profiles.id))
  )
);

revoke all on all functions in schema private from public, anon, authenticated;
revoke all on function
  public.send_friend_request(text),
  public.respond_friend_request(uuid, boolean),
  public.cancel_friend_request(uuid),
  public.remove_friend(uuid),
  public.mark_notifications_read(uuid[])
from public, anon;
grant execute on function
  public.send_friend_request(text),
  public.respond_friend_request(uuid, boolean),
  public.cancel_friend_request(uuid),
  public.remove_friend(uuid),
  public.mark_notifications_read(uuid[])
to authenticated;

-- require_uid() is called from RLS-free definer functions only, but authenticated callers of
-- those functions execute it as the definer, so no grant is needed.

-- Realtime: each player receives inserts into their own notifications (RLS-filtered).
alter publication supabase_realtime add table public.notifications;
