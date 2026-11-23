// Guild, never "gang": scans every player-facing source in the repo.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const roots = ['apps/client/src', 'apps/client/index.html', 'apps/client/public', 'apps/server/src', 'packages/shared/src', 'supabase'];
const exts = /\.(ts|html|css|json|webmanifest|sql|toml|md)$/;

function files(p: string): string[] {
  const full = path.join(root, p);
  if (statSync(full).isFile()) return [p];
  return readdirSync(full).flatMap((f) => {
    const rel = path.join(p, f);
    if (f === 'node_modules' || f === 'dist' || f.startsWith('.')) return [];
    return statSync(path.join(root, rel)).isDirectory() ? files(rel) : exts.test(f) ? [rel] : [];
  });
}

describe('player-facing language', () => {
  it('never uses "gang" (Guildhood uses "Guild")', () => {
    const offenders = roots.flatMap(files).filter((f) => /\bgangs?\b/i.test(readFileSync(path.join(root, f), 'utf8')));
    expect(offenders).toEqual([]);
  });
});
