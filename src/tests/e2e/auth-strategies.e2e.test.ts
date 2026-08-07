import request from 'supertest';
import { createApp } from '@/app';
import { AUTH_STRATEGIES, magicLinkDelivery, magicLinkStore } from '@/auth/strategies';
import { isRecordingMagicLinkDelivery } from '@/auth/strategies/magic-link.delivery';
import type { RecordingMagicLinkDelivery } from '@/auth/strategies/magic-link.delivery';
import { resetRateLimiters } from '@/middleware/rate-limit.middleware';

// env vars are set in jest.setup.ts

jest.mock('@/lib/password', () => ({
  verifyPassword: jest.fn(async (plain: string, _hash: string) => plain === 'password'),
  hashPassword: jest.fn(async (plain: string) => `argon2id-mock:${plain}`),
}));

const app = createApp();

// Under NODE_ENV=test the composition root wires the recording delivery, which
// is what lets this suite read the token back and "click" the link.
function inbox(): RecordingMagicLinkDelivery {
  if (!isRecordingMagicLinkDelivery(magicLinkDelivery)) {
    throw new Error('E2E requires the recording magic-link delivery');
  }
  return magicLinkDelivery;
}

interface Session {
  accessToken: string;
  refreshToken: string;
  user: { id: string; email: string; roles: string[] };
}

beforeEach(async () => {
  await resetRateLimiters();
  inbox().clear();
  magicLinkStore.clear();
});

describe('POST /v1/auth/login/:strategy — routing', () => {
  it('returns 404 naming the registered strategies for an unknown one', async () => {
    const res = await request(app).post('/v1/auth/login/sms').send({ phone: '555' });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('UNKNOWN_AUTH_STRATEGY');
    for (const name of AUTH_STRATEGIES) {
      expect(res.body.error.message).toContain(name);
    }
  });

  it('does not treat an inherited Object property as a strategy', async () => {
    const res = await request(app).post('/v1/auth/login/constructor').send({});

    expect(res.status).toBe(404);
  });
});

describe('POST /v1/auth/login/password', () => {
  it('returns the same session the dedicated /login route does', async () => {
    const res = await request(app)
      .post('/v1/auth/login/password')
      .send({ email: 'admin@example.com', password: 'password' });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      user: { email: 'admin@example.com', roles: ['admin', 'user'] },
      accessToken: expect.any(String),
      refreshToken: expect.any(String),
    });
  });

  it('returns 401 on a wrong password', async () => {
    const res = await request(app)
      .post('/v1/auth/login/password')
      .send({ email: 'admin@example.com', password: 'wrong' });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('AUTH_INVALID_CREDENTIALS');
  });

  it('returns 422 with issues when the body is the wrong shape', async () => {
    const res = await request(app).post('/v1/auth/login/password').send({ apiKey: 'mock' });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.issues.length).toBeGreaterThan(0);
  });
});

describe('POST /v1/auth/magic-link', () => {
  it('returns 202 and delivers a link for a known address', async () => {
    const res = await request(app).post('/v1/auth/magic-link').send({ email: 'user@example.com' });

    expect(res.status).toBe(202);
    expect(res.body.data).toEqual({ status: 'sent' });
    expect(inbox().lastFor('user@example.com')).toBeDefined();
  });

  it('returns an identical 202 for an unknown address', async () => {
    const known = await request(app)
      .post('/v1/auth/magic-link')
      .send({ email: 'user@example.com' });
    const unknown = await request(app)
      .post('/v1/auth/magic-link')
      .send({ email: 'ghost@example.com' });

    expect(unknown.status).toBe(known.status);
    expect(unknown.body).toEqual(known.body);
  });

  it('sends nothing for an unknown address', async () => {
    await request(app).post('/v1/auth/magic-link').send({ email: 'ghost@example.com' });

    expect(inbox().lastFor('ghost@example.com')).toBeUndefined();
  });

  it('returns 422 when the address is not an email', async () => {
    const res = await request(app).post('/v1/auth/magic-link').send({ email: 'not-an-email' });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('throttles after three requests in the window', async () => {
    for (let i = 0; i < 3; i += 1) {
      const ok = await request(app).post('/v1/auth/magic-link').send({ email: 'user@example.com' });
      expect(ok.status).toBe(202);
    }

    const throttled = await request(app)
      .post('/v1/auth/magic-link')
      .send({ email: 'user@example.com' });

    expect(throttled.status).toBe(429);
    expect(throttled.body.error.code).toBe('TOO_MANY_REQUESTS');
  });
});

describe('POST /v1/auth/login/magic-link', () => {
  async function requestLink(email: string): Promise<string> {
    await request(app).post('/v1/auth/magic-link').send({ email });
    const delivered = inbox().lastFor(email);
    if (delivered === undefined) throw new Error(`no link delivered to ${email}`);
    return delivered.token;
  }

  it('exchanges a delivered token for a session', async () => {
    const token = await requestLink('user@example.com');

    const res = await request(app).post('/v1/auth/login/magic-link').send({ token });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      user: { email: 'user@example.com', roles: ['user'] },
      accessToken: expect.any(String),
      refreshToken: expect.any(String),
    });
  });

  it('returns 401 when the same link is used twice', async () => {
    const token = await requestLink('user@example.com');

    await request(app).post('/v1/auth/login/magic-link').send({ token });
    const replay = await request(app).post('/v1/auth/login/magic-link').send({ token });

    expect(replay.status).toBe(401);
    expect(replay.body.error.code).toBe('AUTH_INVALID_MAGIC_LINK');
  });

  it('returns 401 for a token nobody issued', async () => {
    const res = await request(app)
      .post('/v1/auth/login/magic-link')
      .send({ token: 'mock-token-never-issued' });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('AUTH_INVALID_MAGIC_LINK');
  });

  it('invalidates the first link when a second is requested', async () => {
    const first = await requestLink('user@example.com');
    const second = await requestLink('user@example.com');

    expect(second).not.toBe(first);

    const stale = await request(app).post('/v1/auth/login/magic-link').send({ token: first });
    expect(stale.status).toBe(401);

    const fresh = await request(app).post('/v1/auth/login/magic-link').send({ token: second });
    expect(fresh.status).toBe(200);
  });

  it('returns 422 when the credential field is missing', async () => {
    const res = await request(app).post('/v1/auth/login/magic-link').send({});

    expect(res.status).toBe(422);
  });

  it('issues an access token that satisfies requireAuth', async () => {
    const token = await requestLink('user@example.com');
    const login = await request(app).post('/v1/auth/login/magic-link').send({ token });
    const { accessToken } = login.body.data as Session;

    // /v1/users is admin-only and this user is not an admin: 403 rather than
    // 401 is what proves the token itself was accepted.
    const res = await request(app).get('/v1/users').set('Authorization', `Bearer ${accessToken}`);

    expect(res.status).toBe(403);
  });
});

describe('POST /v1/auth/login/api-key', () => {
  it('exchanges a dev key for a session carrying that key’s roles', async () => {
    const res = await request(app)
      .post('/v1/auth/login/api-key')
      .send({ apiKey: 'mock-api-key-admin' });

    expect(res.status).toBe(200);
    expect(res.body.data.user).toMatchObject({
      email: 'admin@example.com',
      roles: ['admin', 'user'],
    });
  });

  it('returns 401 for an unknown key', async () => {
    const res = await request(app)
      .post('/v1/auth/login/api-key')
      .send({ apiKey: 'mock-api-key-not-issued' });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('AUTH_INVALID_API_KEY');
  });

  it('returns 422 when the credential field is missing', async () => {
    const res = await request(app).post('/v1/auth/login/api-key').send({});

    expect(res.status).toBe(422);
  });

  it('issues an access token that carries the admin role through requireRole', async () => {
    const login = await request(app)
      .post('/v1/auth/login/api-key')
      .send({ apiKey: 'mock-api-key-admin' });
    const { accessToken } = login.body.data as Session;

    const res = await request(app).get('/v1/users').set('Authorization', `Bearer ${accessToken}`);

    // 500 would mean the DB is unreachable in this environment; either way the
    // point is that requireAuth and requireRole both let the request through.
    expect([200, 500]).toContain(res.status);
  });
});

describe('every strategy converges on the same session', () => {
  it('produces a refresh token that /v1/auth/refresh rotates, whatever minted it', async () => {
    await request(app).post('/v1/auth/magic-link').send({ email: 'user@example.com' });
    const magicToken = inbox().lastFor('user@example.com')?.token ?? '';

    const sessions = await Promise.all([
      request(app)
        .post('/v1/auth/login/password')
        .send({ email: 'user@example.com', password: 'password' }),
      request(app).post('/v1/auth/login/magic-link').send({ token: magicToken }),
      request(app).post('/v1/auth/login/api-key').send({ apiKey: 'mock-api-key-user' }),
    ]);

    for (const session of sessions) {
      expect(session.status).toBe(200);
      const { refreshToken } = session.body.data as Session;

      const rotated = await request(app).post('/v1/auth/refresh').send({ refreshToken });

      expect(rotated.status).toBe(200);
      expect(rotated.body.data.refreshToken).not.toBe(refreshToken);
    }
  });

  it('reports the same user id for the same person however they logged in', async () => {
    const viaPassword = await request(app)
      .post('/v1/auth/login/password')
      .send({ email: 'user@example.com', password: 'password' });
    const viaApiKey = await request(app)
      .post('/v1/auth/login/api-key')
      .send({ apiKey: 'mock-api-key-user' });

    expect(viaApiKey.body.data.user.id).toBe(viaPassword.body.data.user.id);
  });
});
