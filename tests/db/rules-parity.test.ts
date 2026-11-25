// The client validates instantly with packages/shared; the database is the authority. They must agree.
import { afterAll, describe, expect, it } from 'vitest';
import { AVATARS, TERMS_VERSION, displayNameProblem, usernameFormatProblem } from '../../packages/shared/src/index.ts';
import { POSTGRES, closeDb, one, run } from '../support/db.ts';

afterAll(closeDb);

describe('shared rules match the database', () => {
  it('avatar ids', async () => {
    const r = await run(POSTGRES, 'select id from avatar_catalog where is_active order by id');
    expect(r.rows.map((x) => x.id)).toEqual(AVATARS.map((a) => a.id).sort());
  });

  it('display names', async () => {
    const samples = ['Ok', 'A', 'Zoë Ångström', 'x'.repeat(30), 'x'.repeat(31), 'Tab\tName', '​hidden', 'Normal Name 7', '日本語の名前', 'Émile-Zoë'];
    for (const s of samples) {
      const db = (await one(POSTGRES, 'select private.display_name_problem($1) as p', [s])).p;
      expect(db === null, JSON.stringify(s)).toBe(displayNameProblem(s) === null);
    }
  });

  it('username format', async () => {
    const samples = ['ab', 'abc', 'a'.repeat(20), 'a'.repeat(21), 'has-dash', 'UPPER', 'under_score', 'émile', 'x9_'];
    for (const s of samples) {
      const db = (await one(POSTGRES, 'select private.username_problem($1) as p', [s])).p;
      // The database also rejects reserved names; none of these samples are reserved.
      expect(db === null, s).toBe(usernameFormatProblem(s) === null);
    }
  });

  it('terms version', async () => {
    expect((await one(POSTGRES, 'select private.current_terms_version() as v')).v).toBe(TERMS_VERSION);
  });
});
