import { describe, expect, it } from 'vitest';
import { appReturnUrl, parseAuthCallback, withoutAuthParams } from '../src/auth/callback.ts';

const BASE = 'https://example.github.io/Guildhood/';
const HASH = 'pkce_0123456789abcdef0123456789abcdef';

describe('auth link handling', () => {
  it('recognizes only the configured flows', () => {
    expect(parseAuthCallback(BASE)).toEqual({ kind: 'none' });
    expect(parseAuthCallback(`${BASE}?type=signup&token_hash=${HASH}`)).toEqual({ kind: 'link', flow: 'signup', tokenHash: HASH });
    expect(parseAuthCallback(`${BASE}?type=email&token_hash=${HASH}`)).toEqual({ kind: 'link', flow: 'signup', tokenHash: HASH });
    expect(parseAuthCallback(`${BASE}?type=recovery&token_hash=${HASH}`)).toEqual({ kind: 'link', flow: 'recovery', tokenHash: HASH });
    expect(parseAuthCallback(`${BASE}?type=magiclink&token_hash=${HASH}`)).toMatchObject({ kind: 'invalid', reason: 'unsupported' });
    expect(parseAuthCallback(`${BASE}?type=invite&token_hash=${HASH}`)).toMatchObject({ kind: 'invalid', reason: 'unsupported' });
  });

  it('rejects malformed tokens', () => {
    for (const bad of ['', 'short', '<script>alert(1)</script>xxxxxxxxxxxx', 'a'.repeat(300)]) {
      expect(parseAuthCallback(`${BASE}?type=signup&token_hash=${encodeURIComponent(bad)}`)).toMatchObject({ kind: 'invalid', reason: 'malformed' });
    }
  });

  it('reads expiry errors that Supabase puts in the fragment', () => {
    expect(parseAuthCallback(`${BASE}#error=access_denied&error_code=otp_expired&type=recovery`)).toEqual({ kind: 'invalid', flow: 'recovery', reason: 'expired' });
  });

  it('strips every auth parameter from the address, keeping others', () => {
    expect(withoutAuthParams(`${BASE}?type=signup&token_hash=${HASH}&utm=x`)).toBe(`${BASE}?utm=x`);
    expect(withoutAuthParams(`${BASE}#access_token=abc&refresh_token=def`)).toBe(BASE);
    expect(appReturnUrl(`${BASE}?type=signup&token_hash=${HASH}#x`)).toBe(BASE);
  });
});
