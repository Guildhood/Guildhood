// Every shipped asset file must be listed, with its origin and license, in asset-manifest.json.
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const manifest = JSON.parse(readFileSync(path.join(root, 'asset-manifest.json'), 'utf8')) as {
  files: { path: string; origin: string; license: string }[];
  thirdPartySoftware: { package: string; version: string; license: string }[];
};

function walk(dir: string): string[] {
  return readdirSync(path.join(root, dir)).flatMap((f) => {
    const rel = path.join(dir, f);
    return statSync(path.join(root, rel)).isDirectory() ? walk(rel) : [rel];
  });
}

describe('asset-license manifest', () => {
  it('lists every asset file under public/ and assets-src/, each with an origin and license', () => {
    const listed = new Set(manifest.files.map((f) => f.path));
    const onDisk = [...walk('apps/client/public'), ...walk('apps/client/assets-src'), ...walk('supabase/templates')];
    expect(onDisk.filter((f) => !listed.has(f))).toEqual([]);
    for (const f of manifest.files) {
      expect(existsSync(path.join(root, f.path)), f.path).toBe(true);
      expect(f.license.length, f.path).toBeGreaterThan(0);
      expect(['original', 'derived']).toContain(f.origin);
    }
  });

  it('records the installed version and license of each third-party package', () => {
    for (const p of manifest.thirdPartySoftware) {
      const pkg = JSON.parse(readFileSync(path.join(root, 'node_modules', p.package, 'package.json'), 'utf8'));
      expect({ name: p.package, version: pkg.version, license: pkg.license }).toEqual({ name: p.package, version: p.version, license: p.license });
    }
  });
});
