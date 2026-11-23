import { createRemoteJWKSet, decodeProtectedHeader, errors, jwtVerify, type JWTPayload } from 'jose';
import { isUuid } from '@guildhood/shared';

export class AuthError extends Error {
  constructor(
    readonly code: 'auth_failed' | 'token_expired',
    message: string,
  ) {
    super(message);
  }
}

export interface VerifiedToken {
  userId: string;
  /** Expiry, ms since epoch. */
  expiresAt: number;
}

export interface TokenVerifier {
  verify(token: string): Promise<VerifiedToken>;
}

export interface VerifierOptions {
  /** Expected `iss`, e.g. https://<project>.supabase.co/auth/v1 */
  issuer: string;
  /** JWKS endpoint for asymmetric signing keys (Supabase default). */
  jwksUrl: string;
  /** Optional legacy HS256 shared secret, for projects that have not migrated to signing keys. */
  hs256Secret?: string;
}

const ASYMMETRIC = ['ES256', 'RS256', 'EdDSA'];

/**
 * Verifies Supabase Auth access tokens locally (signature, issuer, audience, expiry), then checks
 * the claims the game relies on. The user id comes only from the verified `sub` claim.
 */
export function createSupabaseVerifier(opts: VerifierOptions): TokenVerifier {
  const jwks = createRemoteJWKSet(new URL(opts.jwksUrl), { cooldownDuration: 30_000, cacheMaxAge: 10 * 60_000 });
  const secret = opts.hs256Secret ? new TextEncoder().encode(opts.hs256Secret) : undefined;

  return {
    async verify(token: string): Promise<VerifiedToken> {
      let payload: JWTPayload;
      try {
        const { alg } = decodeProtectedHeader(token);
        const common = { issuer: opts.issuer, audience: 'authenticated', clockTolerance: 5 };
        if (alg === 'HS256') {
          if (!secret) throw new AuthError('auth_failed', 'HS256 tokens are not accepted by this server');
          ({ payload } = await jwtVerify(token, secret, { ...common, algorithms: ['HS256'] }));
        } else {
          ({ payload } = await jwtVerify(token, jwks, { ...common, algorithms: ASYMMETRIC }));
        }
      } catch (err) {
        if (err instanceof AuthError) throw err;
        if (err instanceof errors.JWTExpired) throw new AuthError('token_expired', 'Access token expired');
        throw new AuthError('auth_failed', `Invalid access token (${(err as Error).name})`);
      }
      if (payload.role !== 'authenticated') throw new AuthError('auth_failed', 'Token role is not authenticated');
      if (payload.is_anonymous === true) throw new AuthError('auth_failed', 'Anonymous accounts cannot join');
      if (!isUuid(payload.sub)) throw new AuthError('auth_failed', 'Token has no valid subject');
      if (typeof payload.exp !== 'number') throw new AuthError('auth_failed', 'Token has no expiry');
      return { userId: payload.sub.toLowerCase(), expiresAt: payload.exp * 1000 };
    },
  };
}
