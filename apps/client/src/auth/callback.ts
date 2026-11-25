/**
 * Email links (verification, password recovery) open Guildhood at
 *   <app url>?type=signup|recovery&token_hash=<hash>
 * Only these configured flows are processed. Every auth parameter is removed from the address bar
 * before anything else happens, so tokens never stay in history, screenshots, or logs.
 */
export type AuthLinkFlow = 'signup' | 'recovery';

export type AuthCallback =
  | { kind: 'none' }
  | { kind: 'link'; flow: AuthLinkFlow; tokenHash: string }
  | { kind: 'invalid'; flow: AuthLinkFlow | null; reason: 'malformed' | 'unsupported' | 'expired' };

const AUTH_PARAMS = ['type', 'token_hash', 'token', 'code', 'error', 'error_code', 'error_description', 'access_token', 'refresh_token', 'expires_in', 'expires_at', 'token_type', 'provider_token'];
const FLOWS: Record<string, AuthLinkFlow> = { signup: 'signup', email: 'signup', recovery: 'recovery' };

export function parseAuthCallback(href: string): AuthCallback {
  const url = new URL(href);
  const hash = new URLSearchParams(url.hash.replace(/^#/, ''));
  // Supabase's own redirects report problems in the fragment (e.g. #error_code=otp_expired).
  const hashError = hash.get('error_code') ?? hash.get('error');
  if (hashError) {
    return { kind: 'invalid', flow: FLOWS[hash.get('type') ?? ''] ?? null, reason: hashError === 'otp_expired' ? 'expired' : 'malformed' };
  }
  const q = url.searchParams;
  if (!q.has('type') && !q.has('token_hash')) return { kind: 'none' };
  const type = q.get('type') ?? '';
  const flow = FLOWS[type];
  if (!flow) return { kind: 'invalid', flow: null, reason: 'unsupported' };
  const tokenHash = q.get('token_hash') ?? '';
  if (!/^[A-Za-z0-9_-]{16,200}$/.test(tokenHash)) return { kind: 'invalid', flow, reason: 'malformed' };
  return { kind: 'link', flow, tokenHash };
}

/** The current URL without auth parameters (other parameters are kept). */
export function withoutAuthParams(href: string): string {
  const url = new URL(href);
  for (const p of AUTH_PARAMS) url.searchParams.delete(p);
  const hash = new URLSearchParams(url.hash.replace(/^#/, ''));
  if (AUTH_PARAMS.some((p) => hash.has(p))) url.hash = '';
  return url.toString();
}

/** Where email links should send the player back to: this app, without query or fragment. */
export function appReturnUrl(href: string): string {
  const url = new URL(href);
  return `${url.origin}${url.pathname}`;
}
