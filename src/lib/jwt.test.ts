import jwt from 'jsonwebtoken';
import { env } from '@/config/env';
import { createTokenPair, refreshTokenExpiresAt, signAccessToken } from '@/lib/jwt';

// env vars are set in jest.setup.ts

describe('refreshTokenExpiresAt', () => {
  it('reports the token’s own exp claim, in milliseconds', () => {
    const { refreshToken } = createTokenPair('user-1', ['user']);
    const { exp } = jwt.verify(refreshToken, env.JWT_REFRESH_SECRET) as { exp: number };

    expect(refreshTokenExpiresAt(refreshToken)).toBe(exp * 1000);
  });

  it('lands in the future, so a token is never recorded already expired', () => {
    // The failure this guards is quiet: a record born expired reads as absent,
    // which makes every revocation and reuse assertion trivially "pass".
    const { refreshToken } = createTokenPair('user-1', ['user']);

    expect(refreshTokenExpiresAt(refreshToken)).toBeGreaterThan(Date.now());
  });

  it('rejects a token signed with the wrong secret', () => {
    const foreign = jwt.sign({ userId: 'user-1', roles: [], type: 'refresh' }, 'a-different-secret', {
      expiresIn: '7d',
    });

    expect(() => refreshTokenExpiresAt(foreign)).toThrow(/Invalid or expired refresh token/);
  });

  it('refuses an access token, which is signed with the other secret', () => {
    const accessToken = signAccessToken({ userId: 'user-1', roles: ['user'] });

    expect(() => refreshTokenExpiresAt(accessToken)).toThrow(/Invalid or expired refresh token/);
  });

  it('is a 500 rather than a 401 when a token carries no expiry', () => {
    // Nothing this module signs can reach here — `expiresIn` is always passed
    // — so a payload without `exp` means something else minted it against this
    // secret, which is a statement about the deployment and not about the
    // caller. Answering 401 would blame a client for a misconfiguration it
    // cannot do anything about.
    const noExpiry = jwt.sign(
      { userId: 'user-1', roles: [], type: 'refresh' },
      env.JWT_REFRESH_SECRET,
    );

    expect(() => refreshTokenExpiresAt(noExpiry)).toThrow(
      expect.objectContaining({ statusCode: 500, code: 'TOKEN_MISSING_EXP' }),
    );
  });
});
