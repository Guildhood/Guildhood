import { AVATARS } from '@guildhood/shared';
import { describe, expect, it } from 'vitest';
import { redact } from '../src/log.ts';
import { EMBLEMS } from '../src/ui/avatars.ts';
import { keyboardInset } from '../src/ui/keyboard.ts';

describe('log redaction', () => {
  it('removes secrets by key and by shape', () => {
    const out = JSON.stringify(
      redact({
        password: 'Hunter22',
        access_token: 'x',
        nested: { refresh_token: 'y', note: 'mail sam@example.com' },
        url: 'https://site.test/?type=recovery&token_hash=abcdef',
        jwt: 'Bearer eyJhbGciOiJ.eyJzdWIiOiIx.c2lnbmF0dXJl',
        safe_error_code: 'network',
      }),
    );
    for (const secret of ['Hunter22', 'sam@example.com', 'token_hash=abcdef', 'eyJhbGciOiJ.eyJzdWIiOiIx.c2lnbmF0dXJl']) expect(out).not.toContain(secret);
    expect(out).toContain('network');
  });
});

describe('keyboard avoidance', () => {
  it('reports how much of the page the on-screen keyboard covers', () => {
    expect(keyboardInset(834, 834, 0)).toBe(0);
    expect(keyboardInset(834, 500, 0)).toBe(334);
    expect(keyboardInset(834, 500, 40)).toBe(294);
    expect(keyboardInset(834, 900, 0)).toBe(0);
  });
});

describe('avatars', () => {
  it('has artwork for every preset avatar', () => {
    for (const a of AVATARS) expect(EMBLEMS[a.id], a.id).toBeDefined();
    expect(Object.keys(EMBLEMS).sort()).toEqual(AVATARS.map((a) => a.id).sort());
  });
});
