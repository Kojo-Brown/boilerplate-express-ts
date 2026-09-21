import { randomUUID } from 'crypto';
import jwt from 'jsonwebtoken';
import { env } from '@/config/env';
import { AppError } from '@/lib/errors';
import type { JwtPayload, TokenPair } from '@/auth/auth.types';

type SignablePayload = Omit<JwtPayload, 'type' | 'jti' | 'iat' | 'exp'>;

// `iat` has one-second resolution, so without a `jti` two tokens minted for the
// same subject inside the same second are byte-identical. Refresh rotation
// depends on the new token differing from the one it replaces — the store keys
// on the token string, so identical strings would leave the old token valid.
export function signAccessToken(payload: SignablePayload): string {
  return jwt.sign(
    { ...payload, type: 'access' },
    env.JWT_ACCESS_SECRET,
    { expiresIn: env.JWT_ACCESS_EXPIRES_IN, jwtid: randomUUID() } as jwt.SignOptions,
  );
}

export function signRefreshToken(payload: SignablePayload): string {
  return jwt.sign(
    { ...payload, type: 'refresh' },
    env.JWT_REFRESH_SECRET,
    { expiresIn: env.JWT_REFRESH_EXPIRES_IN, jwtid: randomUUID() } as jwt.SignOptions,
  );
}

export function verifyAccessToken(token: string): JwtPayload {
  try {
    return jwt.verify(token, env.JWT_ACCESS_SECRET) as JwtPayload;
  } catch {
    throw new AppError(401, 'Invalid or expired access token', 'TOKEN_INVALID');
  }
}

export function verifyRefreshToken(token: string): JwtPayload {
  try {
    return jwt.verify(token, env.JWT_REFRESH_SECRET) as JwtPayload;
  } catch {
    throw new AppError(401, 'Invalid or expired refresh token', 'TOKEN_INVALID');
  }
}

export function createTokenPair(userId: string, roles: string[]): TokenPair {
  const base = { userId, roles };
  return {
    accessToken: signAccessToken(base),
    refreshToken: signRefreshToken(base),
  };
}

/**
 * When a refresh token stops verifying, in epoch milliseconds.
 *
 * The refresh-token store needs this to know how long to remember a token it
 * has retired, and reading it off the token is the only way the two can never
 * disagree: a separately configured retention window that came out shorter
 * than `JWT_REFRESH_EXPIRES_IN` would leave a stretch in which a reused token
 * still verifies and the record that would have recognised it is gone.
 *
 * Every token this module signs is signed with `expiresIn`, so a payload
 * without `exp` means something else minted it — which is a 500 rather than a
 * 401 because it says this process is misconfigured, not that the caller sent
 * something bad.
 */
export function refreshTokenExpiresAt(token: string): number {
  const { exp } = verifyRefreshToken(token);

  if (typeof exp !== 'number') {
    throw new AppError(500, 'Refresh token has no expiry claim', 'TOKEN_MISSING_EXP');
  }

  return exp * 1000;
}
