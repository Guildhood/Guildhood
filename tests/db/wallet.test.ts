import { afterAll, describe, expect, it } from 'vitest';
import { POSTGRES, closeDb, createUser, deleteUsers, failure, one, run, type TestUser } from '../support/db.ts';

const created: TestUser[] = [];
async function user() {
  const u = await createUser('wallet');
  created.push(u);
  return u;
}

afterAll(async () => {
  await deleteUsers(created);
  await closeDb();
});

const apply = (userId: string, delta: number, key: string, reason = 'race_reward') =>
  one<{ ledger_id: string; balance: string; applied: boolean }>(
    POSTGRES,
    'select * from private.apply_wallet_delta($1, $2, $3, $4)',
    [userId, delta, reason, key],
  );

const balance = async (userId: string) =>
  Number((await one(POSTGRES, 'select balance from wallets where user_id = $1', [userId])).balance);

const entries = async (userId: string) =>
  Number((await one(POSTGRES, 'select count(*) as n from wallet_ledger where user_id = $1', [userId])).n);

describe('private.apply_wallet_delta', () => {
  it('replaying an idempotency key returns the original entry without applying twice', async () => {
    const u = await user();
    const first = await apply(u.id, 250, `test:replay:${u.id}`);
    const second = await apply(u.id, 250, `test:replay:${u.id}`);
    expect(first.applied).toBe(true);
    expect(second.applied).toBe(false);
    expect(second.ledger_id).toBe(first.ledger_id);
    expect(await balance(u.id)).toBe(750);
    expect(await entries(u.id)).toBe(2);
  });

  it('rejects reuse of a key with different contents', async () => {
    const u = await user();
    await apply(u.id, 100, `test:conflict:${u.id}`);
    expect(
      await failure(POSTGRES, `select * from private.apply_wallet_delta($1, 999, 'race_reward', $2)`, [u.id, `test:conflict:${u.id}`]),
    ).toMatch(/idempotency_key_conflict/);
    expect(await balance(u.id)).toBe(600);
  });

  it('refuses to overdraw and leaves no partial ledger entry', async () => {
    const u = await user();
    expect(await failure(POSTGRES, `select * from private.apply_wallet_delta($1, -501, 'purchase', $2)`, [u.id, `test:overdraw:${u.id}`])).toMatch(
      /insufficient_funds/,
    );
    expect(await balance(u.id)).toBe(500);
    expect(await entries(u.id)).toBe(1);
  });

  it('applies a key exactly once under 20 concurrent replays', async () => {
    const u = await user();
    const results = await Promise.all(Array.from({ length: 20 }, () => apply(u.id, 40, `test:concurrent-same:${u.id}`)));
    expect(results.filter((r) => r.applied)).toHaveLength(1);
    expect(new Set(results.map((r) => r.ledger_id)).size).toBe(1);
    expect(await balance(u.id)).toBe(540);
  });

  it('serializes concurrent distinct credits with a consistent running balance', async () => {
    const u = await user();
    await Promise.all(Array.from({ length: 20 }, (_, i) => apply(u.id, 10, `test:concurrent-distinct:${u.id}:${i}`)));
    expect(await balance(u.id)).toBe(700);
    const rows = await run(POSTGRES, 'select delta, balance_after from wallet_ledger where user_id = $1 order by id', [u.id]);
    let running = 0;
    for (const r of rows.rows) {
      running += Number(r.delta);
      expect(Number(r.balance_after)).toBe(running);
    }
  });

  it('never lets concurrent debits overdraw', async () => {
    const u = await user();
    const outcomes = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) => apply(u.id, -100, `test:debit:${u.id}:${i}`, 'purchase')),
    );
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(5);
    expect(await balance(u.id)).toBe(0);
  });

  it('keeps the ledger append-only, even for the database owner', async () => {
    const u = await user();
    expect(await failure(POSTGRES, 'update wallet_ledger set delta = 999999 where user_id = $1', [u.id])).toMatch(/append-only/);
  });
});
