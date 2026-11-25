import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { localEnv } from './env.ts';

let pool: pg.Pool | undefined;

export function db(): pg.Pool {
  pool ??= new pg.Pool({ connectionString: localEnv().SUPABASE_DB_URL, max: 30 });
  return pool;
}

export async function closeDb(): Promise<void> {
  await pool?.end();
  pool = undefined;
}

export interface TestUser {
  id: string;
  email: string;
}

/** Creates a real auth.users row (as Supabase Auth would), which fires the signup trigger. */
export async function createUser(label = 'player', userMetadata: Record<string, unknown> = {}): Promise<TestUser> {
  const id = randomUUID();
  const email = `${label}-${id.slice(0, 8)}@example.test`;
  await db().query(
    `insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
     values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $2, now(),
             '{"provider":"email","providers":["email"]}', $3, now(), now())`,
    [id, email, JSON.stringify(userMetadata)],
  );
  return { id, email };
}

/** Runs the real onboarding functions as the player: username, display name, avatar, complete. */
export async function onboard(u: TestUser, username: string, displayName = 'Test Driver', avatar = 'leaf_moss'): Promise<void> {
  await run(asUser(u), 'select public.claim_username($1)', [username]);
  await run(asUser(u), 'select public.update_my_profile($1)', [JSON.stringify({ display_name: displayName })]);
  await run(asUser(u), 'select public.update_my_profile($1)', [JSON.stringify({ avatar_asset_id: avatar })]);
  await run(asUser(u), 'select public.complete_onboarding()');
}

export async function deleteUsers(users: TestUser[]): Promise<void> {
  if (users.length === 0) return;
  await db().query('delete from auth.users where id = any($1::uuid[])', [users.map((u) => u.id)]);
}

export type Actor = { kind: 'user'; id: string } | { kind: 'anon' } | { kind: 'service_role' } | { kind: 'postgres' };

export const asUser = (u: TestUser | string): Actor => ({ kind: 'user', id: typeof u === 'string' ? u : u.id });
export const ANON: Actor = { kind: 'anon' };
export const SERVICE: Actor = { kind: 'service_role' };
export const POSTGRES: Actor = { kind: 'postgres' };

/**
 * Runs one statement exactly as the Data API (PostgREST) would for the given actor: inside a
 * transaction, switched to the request role, with the JWT claims Supabase's auth.uid() reads.
 * Commits on success, rolls back on error, and rethrows the Postgres error.
 */
export async function run<R extends pg.QueryResultRow = pg.QueryResultRow>(
  actor: Actor,
  sql: string,
  params: unknown[] = [],
): Promise<pg.QueryResult<R>> {
  const client = await db().connect();
  try {
    await client.query('begin');
    if (actor.kind === 'user') {
      await client.query('set local role authenticated');
      await client.query(`select set_config('request.jwt.claims', $1, true)`, [
        JSON.stringify({ sub: actor.id, role: 'authenticated', aud: 'authenticated' }),
      ]);
    } else if (actor.kind === 'anon') {
      await client.query('set local role anon');
      await client.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ role: 'anon' })]);
    } else if (actor.kind === 'service_role') {
      await client.query('set local role service_role');
      await client.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ role: 'service_role' })]);
    }
    const result = await client.query<R>(sql, params);
    await client.query('commit');
    return result;
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Expects the statement to fail; returns the Postgres error message. */
export async function failure(actor: Actor, sql: string, params: unknown[] = []): Promise<string> {
  try {
    await run(actor, sql, params);
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error(`Expected failure but statement succeeded: ${sql}`);
}

export async function one<R extends pg.QueryResultRow = pg.QueryResultRow>(
  actor: Actor,
  sql: string,
  params: unknown[] = [],
): Promise<R> {
  const r = await run<R>(actor, sql, params);
  if (r.rows.length !== 1) throw new Error(`Expected one row, got ${r.rows.length}: ${sql}`);
  return r.rows[0]!;
}

export const STARTER_NEIGHBORHOOD_ID = 'a1000000-0000-4000-8000-000000000001';
