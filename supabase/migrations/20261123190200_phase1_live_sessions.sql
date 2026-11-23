-- Guildhood Phase 1 / migration 3 of 3
-- Live session instances: ephemeral rooms hosted by the authoritative game server, each one a live
-- copy of a persistent neighborhood. These rows are a registry written ONLY by the game server
-- (service_role); the authoritative simulation state lives in the game server's memory.

create table public.session_instances (
  id uuid primary key,
  neighborhood_id uuid not null references public.neighborhoods (id),
  server_id text not null check (char_length(server_id) between 3 and 100),
  status text not null default 'open' check (status in ('open', 'closed')),
  player_count int not null default 0 check (player_count >= 0),
  capacity int not null check (capacity between 1 and 64),
  created_at timestamptz not null default now(),
  last_heartbeat_at timestamptz not null default now(),
  closed_at timestamptz
);

create index session_instances_open_by_neighborhood
  on public.session_instances (neighborhood_id) where status = 'open';

-- Where each player is right now. Rows are never deleted while the account exists (presence is
-- cleared by setting instance_id to null) so that Realtime UPDATE events stay RLS-filtered.
create table public.session_presence (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  instance_id uuid references public.session_instances (id) on delete set null,
  neighborhood_id uuid references public.neighborhoods (id),
  updated_at timestamptz not null default now()
);

create index session_presence_instance on public.session_presence (instance_id) where instance_id is not null;

-- A heartbeat older than this means the hosting server is gone.
create or replace function private.instance_is_live(p_status text, p_heartbeat timestamptz)
returns boolean
language sql
stable
set search_path = ''
as $$
  select p_status = 'open' and p_heartbeat > now() - interval '45 seconds';
$$;

-- ---------------------------------------------------------------------------------------------
-- Client RPCs (authenticated)
-- ---------------------------------------------------------------------------------------------

-- Friends list with live location, plus incoming/outgoing pending requests.
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
        'request_id', r.id, 'user_id', p.id, 'display_name', p.display_name, 'created_at', r.created_at
      ) order by r.created_at desc)
      from public.friend_requests r
      join public.profiles p on p.id = r.from_user
      cross join me
      where r.to_user = me.uid and r.status = 'pending'
    ), '[]'::jsonb),
    'outgoing', coalesce((
      select jsonb_agg(jsonb_build_object(
        'request_id', r.id, 'user_id', p.id, 'display_name', p.display_name, 'created_at', r.created_at
      ) order by r.created_at desc)
      from public.friend_requests r
      join public.profiles p on p.id = r.to_user
      cross join me
      where r.from_user = me.uid and r.status = 'pending'
    ), '[]'::jsonb)
  );
$$;

-- Invite a friend to the live instance the caller is in right now (as recorded by the game
-- server). The game server independently re-checks friendship when the friend joins.
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

  -- One invite per friend per instance every 20 seconds.
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

-- ---------------------------------------------------------------------------------------------
-- Game-server RPCs (service_role only)
-- ---------------------------------------------------------------------------------------------

-- Everything the server needs to admit a player, loaded from the database rather than the
-- client: display name, the car they actually own and have selected, friends, memberships.
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

create or replace function public.server_get_neighborhood(p_neighborhood_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id', n.id, 'slug', n.slug, 'name', n.name, 'map_key', n.map_key,
    'max_players_per_instance', n.max_players_per_instance, 'is_open', n.is_open
  )
  from public.neighborhoods n
  where n.id = p_neighborhood_id;
$$;

create or replace function public.server_open_instance(
  p_instance_id uuid,
  p_neighborhood_id uuid,
  p_server_id text,
  p_capacity int
)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.session_instances (id, neighborhood_id, server_id, capacity)
  values (p_instance_id, p_neighborhood_id, p_server_id, p_capacity)
  on conflict (id) do update
    set last_heartbeat_at = now()
    where public.session_instances.server_id = excluded.server_id
      and public.session_instances.status = 'open';
$$;

-- p_instances: [{"id": uuid, "player_count": int}, ...] for every instance this server hosts.
create or replace function public.server_heartbeat(p_server_id text, p_instances jsonb)
returns int
language sql
security definer
set search_path = ''
as $$
  with updated as (
    update public.session_instances si
    set last_heartbeat_at = now(),
        player_count = greatest(0, (x ->> 'player_count')::int)
    from jsonb_array_elements(coalesce(p_instances, '[]'::jsonb)) as x
    where si.id = (x ->> 'id')::uuid
      and si.server_id = p_server_id
      and si.status = 'open'
    returning 1
  )
  select count(*)::int from updated;
$$;

-- Concurrency: close the instance FIRST (row lock), then clear presence in a later statement.
-- server_set_presence holds a FOR SHARE lock on the open instance row while it writes, so either
-- it finishes first (and its row is cleared here) or it waits and then sees the instance closed.
create or replace function public.server_close_instance(p_instance_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.session_instances
  set status = 'closed', closed_at = now(), player_count = 0
  where id = p_instance_id and status = 'open';

  update public.session_presence
  set instance_id = null, updated_at = now()
  where instance_id = p_instance_id;
end;
$$;

create or replace function public.server_set_presence(p_user_id uuid, p_instance_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_neighborhood uuid;
begin
  -- Lock the instance row against a concurrent close until this write commits.
  select si.neighborhood_id into v_neighborhood
  from public.session_instances si
  where si.id = p_instance_id and si.status = 'open'
  for share;
  if not found then
    return;
  end if;

  insert into public.session_presence (user_id, instance_id, neighborhood_id, updated_at)
  values (p_user_id, p_instance_id, v_neighborhood, now())
  on conflict (user_id) do update
    set instance_id = excluded.instance_id,
        neighborhood_id = excluded.neighborhood_id,
        updated_at = excluded.updated_at;
end;
$$;

-- Clears presence only if the player is still recorded in this instance, so a late "left"
-- from an old instance cannot erase presence in the instance they moved to.
create or replace function public.server_clear_presence(p_user_id uuid, p_instance_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.session_presence
  set instance_id = null, updated_at = now()
  where user_id = p_user_id and instance_id = p_instance_id;
$$;

-- Close instances whose server stopped heartbeating (crash, deploy) and clear their presence.
-- Same ordering as server_close_instance: close first, clear presence in a separate statement.
create or replace function public.server_reap_stale_instances(p_stale_after_seconds int default 45)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_closed uuid[];
begin
  with closed as (
    update public.session_instances si
    set status = 'closed', closed_at = now(), player_count = 0
    where si.status = 'open'
      and si.last_heartbeat_at < now() - make_interval(secs => greatest(p_stale_after_seconds, 10))
    returning si.id
  )
  select coalesce(array_agg(id), '{}') into v_closed from closed;

  update public.session_presence
  set instance_id = null, updated_at = now()
  where instance_id = any (v_closed);

  return coalesce(array_length(v_closed, 1), 0);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- RLS and privileges
-- ---------------------------------------------------------------------------------------------

alter table public.session_instances enable row level security;
alter table public.session_presence enable row level security;

revoke all on table public.session_instances, public.session_presence from anon, authenticated;
grant select on public.session_instances, public.session_presence to authenticated;

create policy "session_instances: signed-in players can see open instances"
on public.session_instances for select to authenticated
using (status = 'open');

create policy "session_presence: read own and friends'"
on public.session_presence for select to authenticated
using (
  user_id = (select auth.uid())
  or exists (
    select 1 from public.friendships f
    where (f.user_low = (select auth.uid()) and f.user_high = session_presence.user_id)
       or (f.user_high = (select auth.uid()) and f.user_low = session_presence.user_id)
  )
);

revoke all on all functions in schema private from public, anon, authenticated;

revoke all on function
  public.get_social_overview(),
  public.invite_friend_to_session(uuid)
from public, anon;
grant execute on function
  public.get_social_overview(),
  public.invite_friend_to_session(uuid)
to authenticated;

revoke all on function
  public.server_get_player(uuid),
  public.server_get_neighborhood(uuid),
  public.server_open_instance(uuid, uuid, text, int),
  public.server_heartbeat(text, jsonb),
  public.server_close_instance(uuid),
  public.server_set_presence(uuid, uuid),
  public.server_clear_presence(uuid, uuid),
  public.server_reap_stale_instances(int)
from public, anon, authenticated;
grant execute on function
  public.server_get_player(uuid),
  public.server_get_neighborhood(uuid),
  public.server_open_instance(uuid, uuid, text, int),
  public.server_heartbeat(text, jsonb),
  public.server_close_instance(uuid),
  public.server_set_presence(uuid, uuid),
  public.server_clear_presence(uuid, uuid),
  public.server_reap_stale_instances(int)
to service_role;

-- Realtime: friends' presence changes (RLS-filtered per subscriber).
alter publication supabase_realtime add table public.session_presence;
