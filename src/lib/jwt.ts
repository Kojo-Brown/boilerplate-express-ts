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
