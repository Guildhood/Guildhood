// Phase 2: profiles, onboarding, usernames, and profile access control.
import { afterAll, describe, expect, it } from 'vitest';
import { ANON, POSTGRES, asUser, closeDb, createUser, deleteUsers, failure, one, onboard, run, type TestUser } from '../support/db.ts';

const created: TestUser[] = [];
async function user(label = 'prof', meta: Record<string, unknown> = {}) {
  const u = await createUser(label, meta);
  created.push(u);
  return u;
}
afterAll(async () => {
  await deleteUsers(created);
  await closeDb();
});

const uniq = (prefix: string) => `${prefix}_${Math.random().toString(36).slice(2, 8)}`;
const me = async (u: TestUser) =>
  one(asUser(u), 'select username, display_name, avatar_asset_id, bio, profile_visibility, onboarding_step, onboarding_completed_at from profiles where id = $1', [u.id]);
const claim = (u: TestUser, name: string) => run(asUser(u), 'select public.claim_username($1) as p', [name]);
const update = (u: TestUser, changes: Record<string, unknown>) => one(asUser(u), 'select public.update_my_profile($1) as p', [JSON.stringify(changes)]);
const card = async (viewer: TestUser, username: string) => (await one(asUser(viewer), 'select public.get_public_profile($1) as p', [username])).p;
const auditCount = async (u: TestUser, type: string) =>
  Number((await one(POSTGRES, 'select count(*) as n from private.audit_events where user_id = $1 and event_type = $2', [u.id, type])).n);

describe('profile provisioning', () => {
  it('creates a profile awaiting onboarding, private settings, and an audit record', async () => {
    const u = await user();
    expect(await me(u)).toMatchObject({ username: null, onboarding_step: 'username', onboarding_completed_at: null, profile_visibility: 'friends' });
    const priv = await one(asUser(u), 'select privacy_settings, terms_version from profile_private where user_id = $1', [u.id]);
    expect(priv).toEqual({ privacy_settings: { allow_friend_requests: true }, terms_version: null });
    expect(await auditCount(u, 'profile_created')).toBe(1);
  });

  it('records terms acceptance only for the current terms version', async () => {
    const current = await user('terms', { terms_version: '2026-11-24' });
    const stale = await user('terms', { terms_version: '1999-01-01' });
    expect((await one(POSTGRES, 'select terms_version, terms_accepted_at is not null as accepted from profile_private where user_id = $1', [current.id]))).toEqual({
      terms_version: '2026-11-24',
      accepted: true,
    });
    expect((await one(POSTGRES, 'select terms_version from profile_private where user_id = $1', [stale.id])).terms_version).toBeNull();
  });
});

describe('onboarding', () => {
  it('advances one saved step at a time, persists progress, and completes idempotently', async () => {
    const u = await user();
    expect(await failure(asUser(u), 'select public.complete_onboarding()')).toMatch(/onboarding_incomplete/);
    const name = uniq('ob');
    await claim(u, name);
    expect((await me(u)).onboarding_step).toBe('display_name'); // a relaunch resumes here
    await update(u, { display_name: 'Lantern Lou' });
    expect((await me(u)).onboarding_step).toBe('avatar');
    expect(await failure(asUser(u), 'select public.complete_onboarding()')).toMatch(/onboarding_incomplete/);
    await update(u, { avatar_asset_id: 'key_brass' });
    expect((await me(u)).onboarding_step).toBe('review');
    const first = (await one(asUser(u), 'select public.complete_onboarding() as p')).p;
    const second = (await one(asUser(u), 'select public.complete_onboarding() as p')).p;
    expect(first.onboarding_completed_at).toBeTruthy();
    expect(second.onboarding_completed_at).toBe(first.onboarding_completed_at);
    expect(await me(u)).toMatchObject({ username: name, display_name: 'Lantern Lou', avatar_asset_id: 'key_brass', onboarding_step: null });
    expect(await auditCount(u, 'onboarding_completed')).toBe(1);
  });

  it('going back to an earlier step never moves onboarding backwards', async () => {
    const u = await user();
    await claim(u, uniq('back'));
    await update(u, { display_name: 'First Try' });
    await claim(u, uniq('back2')); // player went back and picked another name
    expect((await me(u)).onboarding_step).toBe('avatar');
  });
});

describe('usernames', () => {
  it('normalizes case and surrounding spaces, and claiming the same name again is a no-op', async () => {
    const u = await user();
    const name = uniq('Case');
    await claim(u, `  ${name.toUpperCase()}  `);
    expect((await me(u)).username).toBe(name.toLowerCase());
    await claim(u, name.toLowerCase());
    expect(await auditCount(u, 'username_changed')).toBe(0);
  });

  it('rejects duplicates, including case variations', async () => {
    const a = await user('a');
    const b = await user('b');
    const name = uniq('dup');
    await claim(a, name);
    expect(await failure(asUser(b), 'select public.claim_username($1)', [name])).toMatch(/username_taken/);
    expect(await failure(asUser(b), 'select public.claim_username($1)', [name.toUpperCase()])).toMatch(/username_taken/);
    expect((await one(asUser(b), 'select public.check_username($1) as r', [name.toUpperCase()])).r).toMatchObject({ available: false, reason: 'taken' });
    expect((await one(asUser(a), 'select public.check_username($1) as r', [name])).r).toMatchObject({ available: true });
  });

  it('lets exactly one of 10 concurrent claimants win a name', async () => {
    const players = await Promise.all(Array.from({ length: 10 }, () => user('race')));
    const name = uniq('race');
    const results = await Promise.allSettled(players.map((p) => claim(p, name)));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results) if (r.status === 'rejected') expect(String(r.reason)).toMatch(/username_taken/);
    expect(Number((await one(POSTGRES, 'select count(*) as n from profiles where username = $1', [name])).n)).toBe(1);
  });

  it.each([
    ['ab', 'too short'],
    ['a'.repeat(21), 'too long'],
    ['bad-name', 'hyphen'],
    ['has space', 'inner space'],
    ['émile', 'non-ASCII letter'],
    ['', 'empty'],
  ])('rejects %j (%s)', async (name) => {
    const u = await user();
    expect(await failure(asUser(u), 'select public.claim_username($1)', [name])).toMatch(/username_invalid_format/);
  });

  it.each(['admin', 'xx_admin_xx', 'Guildhood', 'guildhood_team', 'support', 'moderator9', 'system', 'official_sam'])(
    'rejects reserved name %j',
    async (name) => {
      const u = await user();
      expect(await failure(asUser(u), 'select public.claim_username($1)', [name])).toMatch(/username_reserved/);
    },
  );

  it('blocks reserved names even for privileged direct writes', async () => {
    const u = await user();
    expect(await failure(POSTGRES, `update profiles set username = 'admin' where id = $1`, [u.id])).toMatch(/username_reserved/);
  });

  it('allows names that only resemble an exact-match reserved word', async () => {
    const u = await user();
    const name = `supportive_${Math.random().toString(36).slice(2, 6)}`;
    await claim(u, name);
    expect((await me(u)).username).toBe(name);
  });

  it('audits username changes after the first claim', async () => {
    const u = await user();
    await onboard(u, uniq('old'));
    await claim(u, uniq('new'));
    expect(await auditCount(u, 'username_changed')).toBe(1);
  });
});

describe('profile fields', () => {
  it('accepts plain-text display names and trims them', async () => {
    const u = await user();
    expect((await update(u, { display_name: '  Zoë Ångström  ' })).p.display_name).toBe('Zoë Ångström');
  });

  it.each([
    ['Z', 'too short'],
    ['x'.repeat(31), 'too long'],
    ['Bell\u0007Ringer', 'control character'],
    ['‮evil', 'direction override'],
    ['zero​width', 'zero-width space'],
    ['   ', 'only spaces'],
  ])('rejects display name %j (%s)', async (name) => {
    const u = await user();
    expect(await failure(asUser(u), 'select public.update_my_profile($1)', [JSON.stringify({ display_name: name })])).toMatch(/display_name_invalid/);
  });

  it('rejects unknown and inactive avatars', async () => {
    const u = await user();
    expect(await failure(asUser(u), 'select public.update_my_profile($1)', [JSON.stringify({ avatar_asset_id: 'not_real' })])).toMatch(/avatar_invalid/);
    await run(POSTGRES, `insert into avatar_catalog (id, name, is_active) values ('retired_test', 'Retired', false) on conflict do nothing`);
    expect(await failure(asUser(u), 'select public.update_my_profile($1)', [JSON.stringify({ avatar_asset_id: 'retired_test' })])).toMatch(/avatar_invalid/);
  });

  it('validates bios: 160 characters, line breaks allowed, empty clears', async () => {
    const u = await user();
    expect((await update(u, { bio: 'Line one\nLine two' })).p.bio).toBe('Line one\nLine two');
    expect(await failure(asUser(u), 'select public.update_my_profile($1)', [JSON.stringify({ bio: 'x'.repeat(161) })])).toMatch(/bio_invalid/);
    expect((await update(u, { bio: '' })).p.bio).toBeNull();
  });

  it('partial updates leave other fields unchanged', async () => {
    const u = await user();
    await onboard(u, uniq('part'), 'Steady Name', 'moon_plum');
    await update(u, { bio: 'Hello' });
    await update(u, { profile_visibility: 'public' });
    expect(await me(u)).toMatchObject({ display_name: 'Steady Name', avatar_asset_id: 'moon_plum', bio: 'Hello', profile_visibility: 'public' });
  });

  it.each(['user_id', 'id', 'username', 'onboarding_completed_at', 'created_at', 'friend_code', 'is_admin'])(
    'refuses to change server-controlled field %j through the profile function',
    async (field) => {
      const u = await user();
      expect(await failure(asUser(u), 'select public.update_my_profile($1)', [JSON.stringify({ [field]: 'x' })])).toMatch(/field_not_editable/);
    },
  );

  it.each(['username', 'onboarding_completed_at', 'onboarding_step', 'created_at', 'id', 'bio', 'profile_visibility', 'avatar_asset_id', 'display_name'])(
    'refuses direct column updates of %j',
    async (column) => {
      const u = await user();
      expect(await failure(asUser(u), `update profiles set ${column} = ${column} where id = $1`, [u.id])).toMatch(/permission denied/);
    },
  );
});

describe('profile access control', () => {
  it('player A cannot read or change player B’s profile row', async () => {
    const a = await user('a');
    const b = await user('b');
    await onboard(b, uniq('victim'), 'Victim Name');
    expect((await run(asUser(a), 'select * from profiles where id = $1', [b.id])).rowCount).toBe(0);
    expect((await run(asUser(a), 'update profiles set active_vehicle_id = null where id = $1', [b.id])).rowCount).toBe(0);
    expect((await me(b)).display_name).toBe('Victim Name');
  });

  it('the public card has only approved fields and follows the owner’s visibility', async () => {
    const owner = await user('owner');
    const friend = await user('friend');
    const stranger = await user('stranger');
    const name = uniq('vis');
    await onboard(owner, name, 'Card Owner', 'star_sky');
    await update(owner, { bio: 'Hi!' });
    await run(POSTGRES, 'select private.make_friends($1, $2)', [owner.id, friend.id]);

    await update(owner, { profile_visibility: 'public' });
    expect(await card(stranger, name)).toEqual({ username: name, display_name: 'Card Owner', avatar_asset_id: 'star_sky', bio: 'Hi!' });

    await update(owner, { profile_visibility: 'friends' });
    expect(await card(stranger, name)).toBeNull();
    expect(await card(friend, name)).toMatchObject({ username: name });

    await update(owner, { profile_visibility: 'private' });
    expect(await card(friend, name)).toBeNull();
    expect(await card(owner, name)).toMatchObject({ username: name });
    expect(await card(stranger, 'no_such_player')).toBeNull();
  });

  it('players who have not finished onboarding have no public card', async () => {
    const owner = await user();
    const viewer = await user();
    const name = uniq('half');
    await claim(owner, name);
    await update(owner, { profile_visibility: 'public' });
    expect(await card(viewer, name)).toBeNull();
  });

  it('anonymous callers cannot use profile functions or read profiles', async () => {
    for (const call of ["public.get_public_profile('x')", "public.check_username('x')", "public.claim_username('x')", "public.update_my_profile('{}')", 'public.get_my_account_status()']) {
      expect(await failure(ANON, `select ${call}`), call).toMatch(/permission denied/);
    }
    expect(await failure(ANON, 'select * from profile_private')).toMatch(/permission denied/);
    expect((await run(ANON, 'select id from avatar_catalog')).rowCount).toBeGreaterThanOrEqual(12);
  });

  it('private settings are owner-only and changed only with known keys', async () => {
    const a = await user('a');
    const b = await user('b');
    expect((await run(asUser(a), 'select * from profile_private where user_id = $1', [b.id])).rowCount).toBe(0);
    expect(await failure(asUser(a), `update profile_private set privacy_settings = '{}' where user_id = $1`, [a.id])).toMatch(/permission denied/);
    expect(await failure(asUser(a), `select public.update_my_privacy_settings('{"is_admin": true}')`)).toMatch(/setting_invalid/);
    expect(await failure(asUser(a), `select public.update_my_privacy_settings('{"allow_friend_requests": "no"}')`)).toMatch(/setting_invalid/);
    await run(asUser(b), `select public.update_my_privacy_settings('{"allow_friend_requests": false}')`);
    const code = (await one(POSTGRES, 'select friend_code from profiles where id = $1', [b.id])).friend_code;
    expect(await failure(asUser(a), 'select public.send_friend_request($1)', [code])).toMatch(/not_accepting_friend_requests/);
  });
});
