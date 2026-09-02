import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import jwt from 'jsonwebtoken';
import { env } from '@/config/env';
import { signAccessToken, signRefreshToken } from '@/lib/jwt';
import {
  BEARER_SUBPROTOCOL,
  authenticateHandshake,
  millisecondsUntilExpiry,
  readHandshakeToken,
  readOfferedSubprotocols,
} from '@/ws/handshake';

/** Only the headers are read, so only the headers are built. */
function upgradeRequest(headers: IncomingHttpHeaders): IncomingMessage {
  return { headers, url: '/v1/ws' } as IncomingMessage;
}

const anyOrigin = { allowedOrigins: null } as const;

describe('readOfferedSubprotocols', () => {
  it('is empty when the header is absent', () => {
    expect(readOfferedSubprotocols(upgradeRequest({}))).toEqual([]);
  });

  it('splits and trims one comma-separated value', () => {
    const req = upgradeRequest({ 'sec-websocket-protocol': `${BEARER_SUBPROTOCOL}, token-value` });
    expect(readOfferedSubprotocols(req)).toEqual([BEARER_SUBPROTOCOL, 'token-value']);
  });

  it('handles the header arriving more than once', () => {
    // Node exposes a repeated header as an array for some headers and a joined
    // string for others; the list form has to survive both.
    const req = upgradeRequest({
      'sec-websocket-protocol': [BEARER_SUBPROTOCOL, 'token-value'] as unknown as string,
    });
    expect(readOfferedSubprotocols(req)).toEqual([BEARER_SUBPROTOCOL, 'token-value']);
  });

  it('drops empty entries rather than returning blanks', () => {
    const req = upgradeRequest({ 'sec-websocket-protocol': 'a,, ,b' });
    expect(readOfferedSubprotocols(req)).toEqual(['a', 'b']);
  });
});

describe('readHandshakeToken', () => {
  it('reads an Authorization bearer header', () => {
    expect(readHandshakeToken(upgradeRequest({ authorization: 'Bearer abc.def.ghi' }))).toBe(
      'abc.def.ghi',
    );
  });

  it('ignores a non-bearer Authorization scheme', () => {
    expect(readHandshakeToken(upgradeRequest({ authorization: 'Basic dXNlcjpwYXNz' }))).toBeUndefined();
  });

  it('ignores a bearer header with an empty token', () => {
    expect(readHandshakeToken(upgradeRequest({ authorization: 'Bearer    ' }))).toBeUndefined();
  });

  it('reads the entry after the sentinel subprotocol', () => {
    const req = upgradeRequest({ 'sec-websocket-protocol': `${BEARER_SUBPROTOCOL}, abc.def.ghi` });
    expect(readHandshakeToken(req)).toBe('abc.def.ghi');
  });

  it('is undefined when the sentinel is offered with nothing after it', () => {
    const req = upgradeRequest({ 'sec-websocket-protocol': BEARER_SUBPROTOCOL });
    expect(readHandshakeToken(req)).toBeUndefined();
  });

  it('prefers the Authorization header when both are present', () => {
    const req = upgradeRequest({
      authorization: 'Bearer from-header',
      'sec-websocket-protocol': `${BEARER_SUBPROTOCOL}, from-subprotocol`,
    });
    expect(readHandshakeToken(req)).toBe('from-header');
  });

  it('does not read a token from the query string', () => {
    // Deliberate, and asserted rather than left implicit: a `?token=` parameter
    // is written to every access log and proxy log on the path. Someone adding
    // it back should have to delete this test.
    const req = { headers: {}, url: '/v1/ws?token=abc.def.ghi' } as IncomingMessage;
    expect(readHandshakeToken(req)).toBeUndefined();
  });
});

describe('authenticateHandshake', () => {
  it('accepts a valid access token from the Authorization header', () => {
    const token = signAccessToken({ userId: 'user-1', roles: ['user'] });
    const result = authenticateHandshake(upgradeRequest({ authorization: `Bearer ${token}` }), anyOrigin);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.principal.userId).toBe('user-1');
    expect(result.principal.roles).toEqual(['user']);
    // Nothing was offered, so nothing may be echoed.
    expect(result.subprotocol).toBeUndefined();
  });

  it('echoes the sentinel subprotocol, never the token', () => {
    const token = signAccessToken({ userId: 'user-1', roles: ['user'] });
    const result = authenticateHandshake(
      upgradeRequest({ 'sec-websocket-protocol': `${BEARER_SUBPROTOCOL}, ${token}` }),
      anyOrigin,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Echoing the token would put a live credential in a response header.
    expect(result.subprotocol).toBe(BEARER_SUBPROTOCOL);
    expect(result.subprotocol).not.toContain(token);
  });

  it('refuses a request with no credential and says how to send one', () => {
    const result = authenticateHandshake(upgradeRequest({}), anyOrigin);

    expect(result).toMatchObject({ ok: false, status: 401, code: 'UNAUTHORIZED' });
    if (result.ok) return;
    expect(result.message).toContain(BEARER_SUBPROTOCOL);
  });

  it('refuses a token that is not a JWT', () => {
    const result = authenticateHandshake(upgradeRequest({ authorization: 'Bearer nonsense' }), anyOrigin);
    expect(result).toMatchObject({ ok: false, status: 401, code: 'TOKEN_INVALID' });
  });

  it('refuses a token signed with the wrong secret', () => {
    const forged = jwt.sign({ userId: 'user-1', roles: ['admin'], type: 'access' }, 'not-the-signing-secret');
    const result = authenticateHandshake(upgradeRequest({ authorization: `Bearer ${forged}` }), anyOrigin);
    expect(result).toMatchObject({ ok: false, status: 401 });
  });

  it('refuses an expired token', () => {
    const expired = jwt.sign(
      { userId: 'user-1', roles: ['user'], type: 'access' },
      env.JWT_ACCESS_SECRET,
      { expiresIn: '-1s' },
    );
    const result = authenticateHandshake(upgradeRequest({ authorization: `Bearer ${expired}` }), anyOrigin);
    expect(result).toMatchObject({ ok: false, status: 401, code: 'TOKEN_INVALID' });
  });

  it('refuses a refresh token', () => {
    const refresh = signRefreshToken({ userId: 'user-1', roles: ['user'] });
    const result = authenticateHandshake(upgradeRequest({ authorization: `Bearer ${refresh}` }), anyOrigin);
    expect(result).toMatchObject({ ok: false, status: 401 });
  });

  it('refuses a token of the wrong type even when both secrets are the same', () => {
    // The configuration mistake the `type` check exists for: with one secret in
    // both variables a refresh token verifies, and a seven-day credential would
    // open a socket a fifteen-minute one was meant to.
    const sameSecretRefresh = jwt.sign(
      { userId: 'user-1', roles: ['user'], type: 'refresh' },
      env.JWT_ACCESS_SECRET,
      { expiresIn: '7d' },
    );
    const result = authenticateHandshake(
      upgradeRequest({ authorization: `Bearer ${sameSecretRefresh}` }),
      anyOrigin,
    );
    expect(result).toMatchObject({ ok: false, status: 401, code: 'TOKEN_INVALID' });
  });

  describe('origin', () => {
    const token = signAccessToken({ userId: 'user-1', roles: ['user'] });
    const allowed = { allowedOrigins: ['https://app.example.com'] } as const;

    it('accepts an allowed origin', () => {
      const result = authenticateHandshake(
        upgradeRequest({ authorization: `Bearer ${token}`, origin: 'https://app.example.com' }),
        allowed,
      );
      expect(result.ok).toBe(true);
    });

    it('refuses a disallowed origin with 403, before the token is even read', () => {
      const result = authenticateHandshake(
        upgradeRequest({ authorization: `Bearer ${token}`, origin: 'https://evil.example.com' }),
        allowed,
      );
      expect(result).toMatchObject({ ok: false, status: 403, code: 'ORIGIN_NOT_ALLOWED' });
    });

    it('refuses a disallowed origin even with no token at all', () => {
      const result = authenticateHandshake(upgradeRequest({ origin: 'https://evil.example.com' }), allowed);
      expect(result).toMatchObject({ ok: false, status: 403 });
    });

    it('allows a request with no Origin header', () => {
      // Only browsers send it, and only browsers can be made to mount the
      // attack. Refusing header-less clients would lock out every
      // server-to-server consumer for no security gain.
      const result = authenticateHandshake(upgradeRequest({ authorization: `Bearer ${token}` }), allowed);
      expect(result.ok).toBe(true);
    });

    it('does not match an origin by prefix', () => {
      const result = authenticateHandshake(
        upgradeRequest({
          authorization: `Bearer ${token}`,
          origin: 'https://app.example.com.evil.test',
        }),
        allowed,
      );
      expect(result).toMatchObject({ ok: false, status: 403 });
    });

    it('accepts any origin when configured with null', () => {
      const result = authenticateHandshake(
        upgradeRequest({ authorization: `Bearer ${token}`, origin: 'https://anywhere.example' }),
        anyOrigin,
      );
      expect(result.ok).toBe(true);
    });
  });
});

describe('millisecondsUntilExpiry', () => {
  it('converts the seconds-since-epoch exp to a millisecond delay', () => {
    const nowMs = 1_700_000_000_000;
    // `exp` is in seconds (RFC 7519 §4.1.4). Reading it as milliseconds would
    // schedule the close roughly fifty thousand years early.
    const principal = { userId: 'u', roles: [], type: 'access' as const, exp: nowMs / 1000 + 900 };
    expect(millisecondsUntilExpiry(principal, nowMs)).toBe(900_000);
  });

  it('is undefined for a token with no exp', () => {
    expect(millisecondsUntilExpiry({ userId: 'u', roles: [], type: 'access' })).toBeUndefined();
  });

  it('clamps an already-expired token to 0 rather than a negative delay', () => {
    const nowMs = 1_700_000_000_000;
    const principal = { userId: 'u', roles: [], type: 'access' as const, exp: nowMs / 1000 - 60 };
    expect(millisecondsUntilExpiry(principal, nowMs)).toBe(0);
  });
});
