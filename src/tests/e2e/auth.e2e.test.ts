import request from 'supertest';
import { createApp } from '@/app';
import { resetRateLimiters } from '@/middleware/rate-limit.middleware';

// env vars are set in jest.setup.ts

jest.mock('@/lib/password', () => ({
  verifyPassword: jest.fn(async (plain: string, _hash: string) => plain === 'password'),
  hashPassword: jest.fn(async (plain: string) => `argon2id-mock:${plain}`),
}));

const app = createApp();

// The login limiter allows five attempts per window per IP; this suite makes
// far more than that, so each case starts from a cleared budget.
beforeEach(async () => {
  await resetRateLimiters();
});

describe('POST /v1/auth/login', () => {
  it('returns 200 with tokens on valid credentials', async () => {
    const res = await request(app)
      .post('/v1/auth/login')
      .send({ email: 'admin@example.com', password: 'password' });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      user: { email: 'admin@example.com' },
      accessToken: expect.any(String),
      refreshToken: expect.any(String),
    });
    expect(res.body.error).toBeNull();
  });

  it('returns 401 on wrong password', async () => {
    const res = await request(app)
      .post('/v1/auth/login')
      .send({ email: 'admin@example.com', password: 'wrong' });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('AUTH_INVALID_CREDENTIALS');
    expect(res.body.data).toBeNull();
  });

  it('returns 401 on unknown email', async () => {
    const res = await request(app)
      .post('/v1/auth/login')
      .send({ email: 'ghost@example.com', password: 'password' });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('AUTH_INVALID_CREDENTIALS');
  });

  it('returns 422 when email is missing', async () => {
    const res = await request(app)
      .post('/v1/auth/login')
      .send({ password: 'password' });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 422 when body is empty', async () => {
    const res = await request(app).post('/v1/auth/login').send({});

    expect(res.status).toBe(422);
  });

  it('includes user roles in the response', async () => {
    const res = await request(app)
      .post('/v1/auth/login')
      .send({ email: 'admin@example.com', password: 'password' });

    expect(res.body.data.user.roles).toContain('admin');
  });
});

describe('POST /v1/auth/refresh', () => {
  async function loginAsUser(): Promise<{ accessToken: string; refreshToken: string }> {
    const res = await request(app)
      .post('/v1/auth/login')
      .send({ email: 'user@example.com', password: 'password' });
    return res.body.data as { accessToken: string; refreshToken: string };
  }

  it('returns a rotated token pair for a valid refresh token', async () => {
    const { refreshToken } = await loginAsUser();

    const res = await request(app)
      .post('/v1/auth/refresh')
      .send({ refreshToken });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      accessToken: expect.any(String),
      refreshToken: expect.any(String),
    });
    expect(res.body.data.refreshToken).not.toBe(refreshToken);
  });

  it('returns 401 when refresh token is already used (rotation)', async () => {
    const { refreshToken } = await loginAsUser();

    await request(app).post('/v1/auth/refresh').send({ refreshToken });

    const res = await request(app).post('/v1/auth/refresh').send({ refreshToken });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('TOKEN_REVOKED');
  });

  it('returns 401 for a garbage token', async () => {
    const res = await request(app)
      .post('/v1/auth/refresh')
      .send({ refreshToken: 'not.a.valid.jwt' });

    expect(res.status).toBe(401);
  });

  it('returns 422 when refreshToken field is missing', async () => {
    const res = await request(app).post('/v1/auth/refresh').send({});

    expect(res.status).toBe(422);
  });

  describe('reuse detection', () => {
    // Through the real app rather than the service: the rotation chain lives
    // in the process-wide token store that `createApp` wires up, and a unit
    // test that injects its own store cannot vouch for that wiring.

    it('revokes the live token too when a spent one is replayed', async () => {
      const { refreshToken: first } = await loginAsUser();

      const second = (
        await request(app).post('/v1/auth/refresh').send({ refreshToken: first })
      ).body.data.refreshToken as string;
      const third = (
        await request(app).post('/v1/auth/refresh').send({ refreshToken: second })
      ).body.data.refreshToken as string;

      // Replay the first link in the chain.
      const replay = await request(app).post('/v1/auth/refresh').send({ refreshToken: first });
      expect(replay.status).toBe(401);
      expect(replay.body.error.code).toBe('TOKEN_REVOKED');

      // The session's current token went with it. Without family revocation
      // this call still returns 200 and whoever replayed keeps the account.
      const afterwards = await request(app)
        .post('/v1/auth/refresh')
        .send({ refreshToken: third });
      expect(afterwards.status).toBe(401);
      expect(afterwards.body.error.code).toBe('TOKEN_REVOKED');
    });

    it('leaves a concurrent session on another device alone', async () => {
      const laptop = await loginAsUser();
      const phone = await loginAsUser();

      await request(app).post('/v1/auth/refresh').send({ refreshToken: phone.refreshToken });
      const replay = await request(app)
        .post('/v1/auth/refresh')
        .send({ refreshToken: phone.refreshToken });
      expect(replay.status).toBe(401);

      const other = await request(app)
        .post('/v1/auth/refresh')
        .send({ refreshToken: laptop.refreshToken });
      expect(other.status).toBe(200);
    });

    it('says no more about a replayed token than about any other dead one', async () => {
      const { refreshToken } = await loginAsUser();
      await request(app).post('/v1/auth/refresh').send({ refreshToken });

      const loggedOut = await loginAsUser();
      await request(app)
        .post('/v1/auth/logout')
        .send({ refreshToken: loggedOut.refreshToken });

      const replayed = await request(app).post('/v1/auth/refresh').send({ refreshToken });
      const revoked = await request(app)
        .post('/v1/auth/refresh')
        .send({ refreshToken: loggedOut.refreshToken });

      // Same status, same code, same message: the response is not where an
      // attacker learns that the replay was spotted.
      expect(replayed.status).toBe(revoked.status);
      expect(replayed.body.error).toEqual(revoked.body.error);
    });
  });
});

describe('POST /v1/auth/logout', () => {
  async function loginAsAdmin(): Promise<{ accessToken: string; refreshToken: string }> {
    const res = await request(app)
      .post('/v1/auth/login')
      .send({ email: 'admin@example.com', password: 'password' });
    return res.body.data as { accessToken: string; refreshToken: string };
  }

  it('returns 204 on successful logout', async () => {
    const { refreshToken } = await loginAsAdmin();

    const res = await request(app)
      .post('/v1/auth/logout')
      .send({ refreshToken });

    expect(res.status).toBe(204);
  });

  it('returns 204 even for an already-logged-out token (idempotent)', async () => {
    const { refreshToken } = await loginAsAdmin();

    await request(app).post('/v1/auth/logout').send({ refreshToken });
    const res = await request(app).post('/v1/auth/logout').send({ refreshToken });

    expect(res.status).toBe(204);
  });

  it('returns 204 even for a garbage token (best-effort)', async () => {
    const res = await request(app)
      .post('/v1/auth/logout')
      .send({ refreshToken: 'garbage-token' });

    expect(res.status).toBe(204);
  });

  it('returns 422 when refreshToken is missing', async () => {
    const res = await request(app).post('/v1/auth/logout').send({});

    expect(res.status).toBe(422);
  });

  it('refresh returns 401 after logout (token revoked)', async () => {
    const { refreshToken } = await loginAsAdmin();

    await request(app).post('/v1/auth/logout').send({ refreshToken });

    const res = await request(app).post('/v1/auth/refresh').send({ refreshToken });

    expect(res.status).toBe(401);
  });
});

describe('Auth → protected route integration', () => {
  it('returns 401 on protected route without token', async () => {
    const res = await request(app).get('/v1/users');

    expect(res.status).toBe(401);
  });

  it('returns 401 with malformed Bearer header', async () => {
    const res = await request(app)
      .get('/v1/users')
      .set('Authorization', 'Bearer not-a-valid-jwt');

    expect(res.status).toBe(401);
  });

  it('passes auth middleware with valid access token (non-admin gets 403 on admin route)', async () => {
    const loginRes = await request(app)
      .post('/v1/auth/login')
      .send({ email: 'user@example.com', password: 'password' });

    const { accessToken } = loginRes.body.data as { accessToken: string; refreshToken: string };

    // user role hits the admin-only /v1/users — auth passes, role check fails → 403
    const res = await request(app)
      .get('/v1/users')
      .set('Authorization', `Bearer ${accessToken}`);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });
});

describe('GET /v1/health', () => {
  it('returns 200 with status ok', async () => {
    const res = await request(app).get('/v1/health');

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'ok', version: 'v1' });
  });
});

describe('404 handling', () => {
  it('returns 404 for unknown routes', async () => {
    const res = await request(app).get('/v1/does-not-exist');

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});
