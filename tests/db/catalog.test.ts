import { afterAll, describe, expect, it } from 'vitest';
import { VEHICLE_SPECS, WORLDS } from '../../packages/shared/src/index.ts';
import { POSTGRES, closeDb, run } from '../support/db.ts';

afterAll(closeDb);

describe('database catalog matches the shared simulation code', () => {
  it('every vehicle model in the database has handling specs, and vice versa', async () => {
    const r = await run(POSTGRES, 'select id from vehicle_models order by id');
    expect(r.rows.map((x) => x.id)).toEqual(Object.keys(VEHICLE_SPECS).sort());
  });

  it('every neighborhood references a map layout that exists', async () => {
    const r = await run(POSTGRES, 'select map_key, max_players_per_instance from neighborhoods');
    for (const n of r.rows) {
      const world = WORLDS[n.map_key];
      expect(world, n.map_key).toBeDefined();
      expect(world!.spawns.length).toBeGreaterThanOrEqual(n.max_players_per_instance);
    }
  });
});
