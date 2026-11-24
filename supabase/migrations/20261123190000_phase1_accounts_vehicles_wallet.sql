-- Guildhood Phase 1 / migration 1 of 3
-- Accounts (profiles), persistent neighborhoods, vehicle ownership, and the Marks wallet ledger.
--
-- Security model:
--   * Every table has row level security (RLS) enabled and is deny-by-default.
--   * Client roles (anon, authenticated) get only the SELECT/UPDATE privileges listed explicitly
--     at the end of each migration. Money and ownership are never writable by clients.
--   * Balances and ownership change only inside SECURITY DEFINER functions in the `private`
--     schema (not exposed through the Data API), each keyed by a unique idempotency key.

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------------------------

create or replace function private.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- 8-character friend code from an unambiguous alphabet (no 0/O/1/I). 32 symbols, so a single
-- random byte modulo 32 has no bias.
create or replace function private.random_friend_code()
returns text
language plpgsql
volatile
set search_path = ''
as $$
declare
  alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  bytes bytea := extensions.gen_random_bytes(8);
  code text := '';
  i int;
begin
  for i in 0..7 loop
    code := code || substr(alphabet, 1 + (get_byte(bytes, i) % 32), 1);
  end loop;
  return code;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Persistent neighborhoods (the world). Live session instances live in migration 3.
-- ---------------------------------------------------------------------------------------------

create table public.neighborhoods (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9-]{3,40}$'),
  name text not null check (char_length(name) between 3 and 40),
  -- Which shared map layout (packages/shared/src/world) the game server and client load.
  map_key text not null check (map_key ~ '^[a-z0-9_]{3,40}$'),
  max_players_per_instance int not null default 8 check (max_players_per_instance between 2 and 32),
  is_open boolean not null default true,
  is_starter boolean not null default false,
  created_at timestamptz not null default now()
);

-- Exactly one neighborhood is the starter neighborhood every new player belongs to.
create unique index neighborhoods_single_starter on public.neighborhoods (is_starter) where is_starter;

insert into public.neighborhoods (id, slug, name, map_key, max_players_per_instance, is_starter)
values ('a1000000-0000-4000-8000-000000000001', 'copperleaf-commons', 'Copperleaf Commons', 'copperleaf_v1', 8, true);

-- ---------------------------------------------------------------------------------------------
-- Profiles
-- ---------------------------------------------------------------------------------------------

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null,
  friend_code text not null unique,
  active_vehicle_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint profiles_display_name_format
    check (display_name ~ '^[A-Za-z0-9][A-Za-z0-9 _-]{1,18}[A-Za-z0-9]$'),
  constraint profiles_friend_code_format
    check (friend_code ~ '^[A-HJ-NP-Z2-9]{8}$')
);

create trigger profiles_touch_updated_at
before update on public.profiles
for each row execute function private.touch_updated_at();

create table public.neighborhood_memberships (
  neighborhood_id uuid not null references public.neighborhoods (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (neighborhood_id, user_id)
);

create index neighborhood_memberships_user on public.neighborhood_memberships (user_id);

-- ---------------------------------------------------------------------------------------------
-- Vehicles
-- ---------------------------------------------------------------------------------------------

-- Catalog. Handling stats live in shared code (packages/shared/src/vehicles.ts) and are run by
-- the authoritative server; a test asserts the two lists match. Prices arrive in Phase 3.
create table public.vehicle_models (
  id text primary key check (id ~ '^[a-z0-9_]{3,40}$'),
  name text not null,
  description text not null default '',
  is_starter boolean not null default false,
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);

create unique index vehicle_models_single_starter on public.vehicle_models (is_starter) where is_starter;

insert into public.vehicle_models (id, name, description, is_starter, sort_order)
values ('sprout_hatch', 'Sprout Hatch', 'A cheerful little hatchback. Every new driver gets one.', true, 1);

create table public.player_vehicles (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles (id) on delete cascade,
  model_id text not null references public.vehicle_models (id),
  color_index smallint not null default 0 check (color_index between 0 and 7),
  acquired_via text not null check (acquired_via in ('starter_pack', 'purchase', 'reward', 'admin')),
  -- Idempotency key of the grant that created this row. A replayed grant cannot duplicate a car.
  grant_key text not null unique check (char_length(grant_key) between 8 and 200),
  acquired_at timestamptz not null default now(),
  unique (id, owner_id)
);

create index player_vehicles_owner on public.player_vehicles (owner_id);

-- The active vehicle must be one the profile owns: enforced by a composite foreign key, so even a
-- direct column update cannot point at someone else's car.
alter table public.profiles
  add constraint profiles_active_vehicle_owned
  foreign key (active_vehicle_id, id)
  references public.player_vehicles (id, owner_id)
  on delete set null (active_vehicle_id);

-- ---------------------------------------------------------------------------------------------
-- Wallet ("Marks") and append-only ledger
-- ---------------------------------------------------------------------------------------------

create table public.wallets (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  balance bigint not null default 0 check (balance >= 0),
  updated_at timestamptz not null default now()
);

create table public.wallet_ledger (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.wallets (user_id) on delete cascade,
  delta bigint not null check (delta <> 0),
  balance_after bigint not null check (balance_after >= 0),
  reason text not null check (reason in ('starter_pack', 'race_reward', 'purchase', 'admin_adjustment')),
  idempotency_key text not null unique check (char_length(idempotency_key) between 8 and 200),
  -- Competitive or neighborhood-scoped earnings record their scope here (used from Phase 2).
  scope_neighborhood_id uuid references public.neighborhoods (id),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index wallet_ledger_user_created on public.wallet_ledger (user_id, created_at desc);

create or replace function private.forbid_ledger_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'wallet_ledger is append-only' using errcode = '42501';
end;
$$;

create trigger wallet_ledger_append_only
before update on public.wallet_ledger
for each row execute function private.forbid_ledger_update();

-- The only code path that changes a balance. Atomic (wallet row lock + ledger insert in one
-- transaction) and idempotent (replaying a key returns the original entry, applied = false).
create or replace function private.apply_wallet_delta(
  p_user_id uuid,
  p_delta bigint,
  p_reason text,
  p_idempotency_key text,
  p_scope_neighborhood_id uuid default null,
  p_metadata jsonb default '{}'::jsonb
)
returns table (ledger_id bigint, balance bigint, applied boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_balance bigint;
  v_existing public.wallet_ledger%rowtype;
  v_ledger_id bigint;
begin
  if p_delta is null or p_delta = 0 then
    raise exception 'invalid_delta' using errcode = '22023';
  end if;

  -- Serialize all mutations of this wallet.
  select w.balance into v_balance
  from public.wallets w
  where w.user_id = p_user_id
  for update;

  if not found then
    raise exception 'wallet_not_found' using errcode = 'P0002';
  end if;

  select * into v_existing
  from public.wallet_ledger l
  where l.idempotency_key = p_idempotency_key;

  if found then
    if v_existing.user_id <> p_user_id or v_existing.delta <> p_delta or v_existing.reason <> p_reason then
      raise exception 'idempotency_key_conflict' using errcode = 'P0001';
    end if;
    return query select v_existing.id, v_balance, false;
    return;
  end if;

  if v_balance + p_delta < 0 then
    raise exception 'insufficient_funds' using errcode = 'P0001';
  end if;

  update public.wallets w
  set balance = w.balance + p_delta, updated_at = now()
  where w.user_id = p_user_id
  returning w.balance into v_balance;

  insert into public.wallet_ledger (user_id, delta, balance_after, reason, idempotency_key, scope_neighborhood_id, metadata)
  values (p_user_id, p_delta, v_balance, p_reason, p_idempotency_key, p_scope_neighborhood_id, coalesce(p_metadata, '{}'::jsonb))
  returning id into v_ledger_id;

  return query select v_ledger_id, v_balance, true;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Starter pack and new-account bootstrap
-- ---------------------------------------------------------------------------------------------

-- Grants the starter car, 500 Marks, and starter-neighborhood membership. Contents are decided
-- here, never by a client. Every step is keyed, so running it twice for a user is a no-op.
create or replace function private.grant_starter_pack(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_key constant text := 'starter_pack:v1:' || p_user_id::text;
  v_vehicle_id uuid;
begin
  insert into public.player_vehicles (owner_id, model_id, acquired_via, grant_key)
  select p_user_id, m.id, 'starter_pack', v_key || ':vehicle'
  from public.vehicle_models m
  where m.is_starter
  on conflict (grant_key) do nothing;

  select v.id into v_vehicle_id
  from public.player_vehicles v
  where v.grant_key = v_key || ':vehicle';

  update public.profiles p
  set active_vehicle_id = v_vehicle_id
  where p.id = p_user_id and p.active_vehicle_id is null;

  perform private.apply_wallet_delta(p_user_id, 500, 'starter_pack', v_key || ':marks');

  insert into public.neighborhood_memberships (neighborhood_id, user_id)
  select n.id, p_user_id from public.neighborhoods n where n.is_starter
  on conflict do nothing;
end;
$$;

create or replace function private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_code text;
  v_attempt int := 0;
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

  insert into public.wallets (user_id) values (new.id);
  perform private.grant_starter_pack(new.id);
  return new;
end;
$$;

create trigger on_auth_user_created
after insert on auth.users
for each row execute function private.handle_new_user();

-- ---------------------------------------------------------------------------------------------
-- Row level security and privileges
-- ---------------------------------------------------------------------------------------------

alter table public.neighborhoods enable row level security;
alter table public.profiles enable row level security;
alter table public.neighborhood_memberships enable row level security;
alter table public.vehicle_models enable row level security;
alter table public.player_vehicles enable row level security;
alter table public.wallets enable row level security;
alter table public.wallet_ledger enable row level security;

revoke all on table
  public.neighborhoods, public.profiles, public.neighborhood_memberships, public.vehicle_models,
  public.player_vehicles, public.wallets, public.wallet_ledger
from anon, authenticated;

grant select on public.neighborhoods to authenticated;
grant select on public.vehicle_models to anon, authenticated;
grant select on public.profiles to authenticated;
grant update (display_name, active_vehicle_id) on public.profiles to authenticated;
grant select on public.neighborhood_memberships to authenticated;
grant select on public.player_vehicles to authenticated;
grant update (color_index) on public.player_vehicles to authenticated;
grant select on public.wallets to authenticated;
grant select on public.wallet_ledger to authenticated;

create policy "neighborhoods: signed-in players can read"
on public.neighborhoods for select to authenticated
using (true);

create policy "vehicle_models: anyone can read the catalog"
on public.vehicle_models for select to anon, authenticated
using (true);

-- Profile visibility is widened to friends and request counterparties in migration 2.
create policy "profiles: read own"
on public.profiles for select to authenticated
using (id = (select auth.uid()));

create policy "profiles: update own"
on public.profiles for update to authenticated
using (id = (select auth.uid()))
with check (id = (select auth.uid()));

create policy "memberships: read own"
on public.neighborhood_memberships for select to authenticated
using (user_id = (select auth.uid()));

create policy "player_vehicles: read own"
on public.player_vehicles for select to authenticated
using (owner_id = (select auth.uid()));

create policy "player_vehicles: recolor own"
on public.player_vehicles for update to authenticated
using (owner_id = (select auth.uid()))
with check (owner_id = (select auth.uid()));

create policy "wallets: read own"
on public.wallets for select to authenticated
using (user_id = (select auth.uid()));

create policy "wallet_ledger: read own"
on public.wallet_ledger for select to authenticated
using (user_id = (select auth.uid()));

revoke all on all functions in schema private from public, anon, authenticated;
