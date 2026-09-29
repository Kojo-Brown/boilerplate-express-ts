import request from 'supertest';
import { createApp } from '@/app';
import { env } from '@/config/env';
import { signAccessToken } from '@/lib/jwt';
import { resetRateLimiters } from '@/middleware/rate-limit.middleware';
import { createDependencyClient, OutboundUrlNotAllowedError } from '@/resilience';
import { usersCache } from '@/users/users.controller';
import type { UserRow } from '@/users/users.repository';
import { signWebhookRequest, WEBHOOK_SIGNATURE_HEADER } from '@/webhooks';
import { webhookSigningSecretRing } from '@/webhooks/webhooks.router';

/**
 * The OWASP API Security Top 10 (2023), one `describe` per risk, every case
 * driven through the real application object.
 *
 * `docs/owasp-api-top-10.md` is the prose half and the two are meant to be read
 * together: the document says what this service does about each risk and, where
 * it does nothing, says that instead. This file is what keeps the document from
 * becoming a description of the past. A checklist nobody executes decays into a
 * list of claims that were true when someone wrote them down, and the specific
 * way it decays is the reason for the two changes that landed with it — a
 * password digest served in every user response, and an authorisation model
 * that checked what kind of caller you were but never which row you asked for.
 * Both were shipped by people who would have said, correctly, that this API
 * authenticates every request and hashes every password.
 *
 * Three rules for anything added here:
 *
 *   - it goes through `createApp()`. Most of these risks are compositional —
 *     the middleware that is mounted but too low, the guard that is on four
 *     routes and not the fifth — and a unit test cannot see any of it;
 *   - it asserts a *refusal*, not the presence of a mechanism. "The limiter is
 *     installed" is satisfied by a limiter with the budget set to infinity;
 *   - where the refusal is supposed to happen before some expensive or
 *     revealing thing, the test says so — that no query ran, that no mail was
 *     sent, that two different failures are indistinguishable. That ordering is
 *     usually the whole mitigation and it is invisible in a status code.
 *
 * Risks with no mitigation are absent from this file by design. There is
 * nothing to test, and a `describe` block containing an assertion about
 * something unrelated is how a checklist starts lying. The document carries
 * those rows with the word "none" in them.
 */

jest.mock('@/lib/password', () => ({
  verifyPassword: jest.fn(async (plain: string, _hash: string) => plain === 'password'),
  hashPassword: jest.fn(async (plain: string) => `argon2id-mock:${plain}`),
}));

const mockQuery = jest.fn();
const mockQueryOne = jest.fn();
const mockQueryCount = jest.fn();

jest.mock('@/db/query', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  queryOne: (...args: unknown[]) => mockQueryOne(...args),
  queryCount: (...args: unknown[]) => mockQueryCount(...args),
  poolQueryable: {
    query: (...args: unknown[]) => mockQuery(...args),
    queryOne: (...args: unknown[]) => mockQueryOne(...args),
    queryCount: (...args: unknown[]) => mockQueryCount(...args),
  },
}));

jest.mock('@/db/transaction', () => {
  const { IN_TRANSACTION } = jest.requireActual('@/db/queryable') as { IN_TRANSACTION: symbol };
  return {
    withTransaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        [IN_TRANSACTION]: true,
        query: (...args: unknown[]) => mockQuery(...args),
        queryOne: (...args: unknown[]) => mockQueryOne(...args),
        queryCount: (...args: unknown[]) => mockQueryCount(...args),
      }),
  };
});

const app = createApp();

/**
 * The seeded directory's ordinary user is subject `2`, so `2` is the only row
 * id that principal is the subject of. Everything else is somebody else's.
 */
const SELF_ID = '2';
const OTHER_ID = 'user-uuid-1';

const SELF_ROW: UserRow = {
  id: SELF_ID,
  email: 'user@example.com',
  password_hash: '$argon2id$v=19$m=65536,t=3,p=4$obviously-fake$AAAAAAAAAAAAAAAAAAAAAA',
  roles: ['user'],
  created_at: new Date('2024-01-02T00:00:00Z'),
  updated_at: new Date('2024-01-02T00:00:00Z'),
  version: 7,
};

/**
 * Tokens are minted rather than logged in for. Two reasons, and the second is
 * the one that bites: the stub directory seeds exactly one administrator and
 * one ordinary user, which is not enough principals for several of these cases;
 * and the login limiter allows five attempts per window, so a suite that logs
 * in per case eventually throttles the thing it is trying to measure.
 */
const userToken = signAccessToken({ userId: SELF_ID, roles: ['user'] });
const adminToken = signAccessToken({ userId: 'admin-1', roles: ['admin', 'user'] });

beforeEach(async () => {
  mockQuery.mockReset();
  mockQueryOne.mockReset();
  mockQueryCount.mockReset();
  await resetRateLimiters();
  await usersCache.clear();
});

describe('API1:2023 — Broken Object Level Authorization', () => {
  it('lets a principal read its own record', async () => {
    mockQueryOne.mockResolvedValue(SELF_ROW);

    const res = await request(app)
      .get(`/v1/users/${SELF_ID}`)
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ id: SELF_ID });
  });

  it('refuses a record the principal is not the subject of', async () => {
    mockQueryOne.mockResolvedValue(SELF_ROW);

    const res = await request(app)
      .get(`/v1/users/${OTHER_ID}`)
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('refuses before the row is looked up', async () => {
    // The part a status code cannot show. A check that runs after the read has
    // already spent the query, and — through the timing difference between a
    // hit and a miss — has already answered the question it is refusing to
    // answer.
    mockQueryOne.mockResolvedValue(SELF_ROW);

    await request(app).get(`/v1/users/${OTHER_ID}`).set('Authorization', `Bearer ${userToken}`);

    expect(mockQueryOne).not.toHaveBeenCalled();
  });

  it('refuses a write to a record the principal is not the subject of', async () => {
    const res = await request(app)
      .put(`/v1/users/${OTHER_ID}`)
      .set('Authorization', `Bearer ${userToken}`)
      .set('If-Match', '"3"')
      .send({ email: 'attacker-controlled@example.test' });

    expect(res.status).toBe(403);
    expect(mockQueryOne).not.toHaveBeenCalled();
  });

  it('lets an administrator reach any record', async () => {
    mockQueryOne.mockResolvedValue(SELF_ROW);

    const res = await request(app)
      .get(`/v1/users/${OTHER_ID}`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
  });
});

describe('API2:2023 — Broken Authentication', () => {
  it('refuses a token it did not sign', async () => {
    const res = await request(app)
      .get(`/v1/users/${SELF_ID}`)
      .set('Authorization', 'Bearer eyJhbGciOiJIUzI1NiJ9.e30.not-a-real-signature');

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('TOKEN_INVALID');
  });

  it('refuses a refresh token presented as an access token', async () => {
    // The two are signed under different secrets, which is what makes this a
    // 401 rather than a session with the refresh token's lifetime.
    const login = await request(app)
      .post('/v1/auth/login')
      .send({ email: 'user@example.com', password: 'password' });
    const { refreshToken } = login.body.data as { refreshToken: string };

    const res = await request(app)
      .get(`/v1/users/${SELF_ID}`)
      .set('Authorization', `Bearer ${refreshToken}`);

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('TOKEN_INVALID');
  });

  it('answers identically for an unknown address and a wrong password', async () => {
    // Account enumeration is the failure that does not look like one: both
    // answers are correct refusals, and the difference between them is a list
    // of your users.
    const unknown = await request(app)
      .post('/v1/auth/login')
      .send({ email: 'nobody@example.test', password: 'password' });
    const wrong = await request(app)
      .post('/v1/auth/login')
      .send({ email: 'user@example.com', password: 'not-the-password' });

    expect(unknown.status).toBe(wrong.status);
    expect(unknown.body.error).toEqual(wrong.body.error);
  });

  it('throttles credential guessing', async () => {
    const attempt = () =>
      request(app).post('/v1/auth/login').send({ email: 'user@example.com', password: 'guess' });

    for (let i = 0; i < 5; i += 1) {
      expect((await attempt()).status).toBe(401);
    }

    const sixth = await attempt();

    expect(sixth.status).toBe(429);
    expect(sixth.body.error.code).toBe('TOO_MANY_REQUESTS');
  });

  it('keeps the budget on the endpoint, not on the outcome', async () => {
    // A limiter that only counted failures would be spent by five wrong
    // guesses and reset by one correct login, which an attacker with any valid
    // account can arrange indefinitely.
    for (let i = 0; i < 5; i += 1) {
      await request(app)
        .post('/v1/auth/login')
        .send({ email: 'user@example.com', password: 'password' });
    }

    const sixth = await request(app)
      .post('/v1/auth/login')
      .send({ email: 'user@example.com', password: 'password' });

    expect(sixth.status).toBe(429);
  });
});

describe('API3:2023 — Broken Object Property Level Authorization', () => {
  it('never puts the password digest in a response', async () => {
    mockQueryOne.mockResolvedValue(SELF_ROW);

    const res = await request(app)
      .get(`/v1/users/${SELF_ID}`)
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data).not.toHaveProperty('password_hash');
    // Against the serialised body as well as the parsed one: a digest reaching
    // the wire under any key at all is the thing being refused.
    expect(res.text).not.toContain(SELF_ROW.password_hash);
  });

  it('keeps the digest out of the collection response too', async () => {
    mockQuery.mockResolvedValue([SELF_ROW]);

    const res = await request(app).get('/v1/users').set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.text).not.toContain(SELF_ROW.password_hash);
  });

  it('refuses a self-update that assigns roles', async () => {
    // The escalation that object-level authorization creates if property-level
    // authorization is left out: the caller owns the row, and `roles` is in the
    // accepted body shape.
    const res = await request(app)
      .put(`/v1/users/${SELF_ID}`)
      .set('Authorization', `Bearer ${userToken}`)
      .set('If-Match', '"7"')
      .send({ roles: ['admin'] });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(mockQueryOne).not.toHaveBeenCalled();
  });

  it('allows the same caller to change a field that is theirs', async () => {
    // `__updated` is what the conditional `UPDATE` returns when it matched a
    // row; without it the repository reads the answer as a precondition miss.
    mockQueryOne.mockResolvedValue({
      ...SELF_ROW,
      email: 'new@example.com',
      version: 8,
      __updated: true,
    });

    const res = await request(app)
      .put(`/v1/users/${SELF_ID}`)
      .set('Authorization', `Bearer ${userToken}`)
      .set('If-Match', '"7"')
      .send({ email: 'new@example.com' });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ email: 'new@example.com' });
  });

  it('lets an administrator assign roles', async () => {
    const granted = ['user', 'admin'];
    mockQueryOne.mockResolvedValue({ ...SELF_ROW, roles: granted, version: 8, __updated: true });

    const res = await request(app)
      .put(`/v1/users/${SELF_ID}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('If-Match', '"7"')
      .send({ roles: granted });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ roles: granted });
  });

  it('drops a property the schema does not accept rather than storing it', async () => {
    mockQueryOne.mockResolvedValue({ ...SELF_ROW, version: 8, __updated: true });

    await request(app)
      .put(`/v1/users/${SELF_ID}`)
      .set('Authorization', `Bearer ${userToken}`)
      .set('If-Match', '"7"')
      .send({ email: 'new@example.com', password_hash: 'attacker-chosen-digest' });

    // Zod strips what the schema does not name, so the write is built from the
    // parsed body and the smuggled key never reaches a statement.
    const statements = mockQueryOne.mock.calls.map(([sql]) => String(sql)).join('\n');
    expect(statements).not.toContain('password_hash');
  });
});

describe('API4:2023 — Unrestricted Resource Consumption', () => {
  it('refuses a body over the parser limit, and says so', async () => {
    const res = await request(app)
      .post('/v1/auth/login')
      .send({ email: 'user@example.com', password: 'x'.repeat(200 * 1024) });

    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('refuses the oversized body without spending the endpoint’s budget', async () => {
    // The parsers run above the routers, so a refusal here costs the caller
    // nothing from the login limiter — which is correct, and worth pinning:
    // the reverse would let anyone lock a shared IP out of logging in by
    // sending five large bodies.
    for (let i = 0; i < 6; i += 1) {
      await request(app)
        .post('/v1/auth/login')
        .send({ email: 'user@example.com', password: 'x'.repeat(200 * 1024) });
    }

    const res = await request(app)
      .post('/v1/auth/login')
      .send({ email: 'user@example.com', password: 'password' });

    expect(res.status).toBe(200);
  });

  it('caps the webhook endpoint below the general limit', async () => {
    // The body has to be buffered in full before the signature can be checked,
    // so this cap is the only thing between an unauthenticated caller and that
    // much heap per connection.
    const body = JSON.stringify({ pad: 'x'.repeat(1_100_000) });
    const res = await request(app)
      .post('/v1/webhooks/inbound')
      .set('content-type', 'application/json')
      .send(body);

    expect(res.status).toBe(413);
  });
});

describe('API5:2023 — Broken Function Level Authorization', () => {
  it('refuses the collection to a principal without the role', async () => {
    const res = await request(app).get('/v1/users').set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('refuses a delete to a principal without the role, even of its own record', async () => {
    // Function level, not object level: `DELETE` is an administrator's
    // operation whoever the subject is, so owning the row does not open it.
    const res = await request(app)
      .delete(`/v1/users/${SELF_ID}`)
      .set('Authorization', `Bearer ${userToken}`)
      .set('If-Match', '*');

    expect(res.status).toBe(403);
    expect(mockQueryOne).not.toHaveBeenCalled();
  });

  it('refuses the bulk import to a principal without the role', async () => {
    const res = await request(app)
      .post('/v1/users/import')
      .set('Authorization', `Bearer ${userToken}`)
      .set('content-type', 'text/csv')
      .send('email\nsomebody@example.test\n');

    expect(res.status).toBe(403);
  });

  it('answers 401, not 403, when there is no principal at all', async () => {
    const res = await request(app).get('/v1/users');

    expect(res.status).toBe(401);
  });
});

describe('API6:2023 — Unrestricted Access to Sensitive Business Flows', () => {
  it('throttles the flow that sends mail to an address the caller names', async () => {
    const send = () =>
      request(app).post('/v1/auth/magic-link').send({ email: 'someone@example.test' });

    for (let i = 0; i < 3; i += 1) {
      expect((await send()).status).toBeLessThan(400);
    }

    const fourth = await send();

    expect(fourth.status).toBe(429);
    expect(fourth.body.error.code).toBe('TOO_MANY_REQUESTS');
  });

  it('gives that flow a tighter budget than login', async () => {
    // Not decoration: this endpoint spends somebody else's inbox, so its
    // ceiling is a statement about third parties rather than about this
    // service's CPU. The login suite above proves the other budget is 5.
    const send = () =>
      request(app).post('/v1/auth/magic-link').send({ email: 'someone@example.test' });

    await send();
    await send();
    await send();

    expect((await send()).status).toBe(429);
  });

  it('accepts a signed delivery once and refuses the identical replay', async () => {
    // Inside the freshness window every copy of a captured delivery verifies,
    // because every copy *is* authentic. Signature and window together still
    // permit "the same instruction one hundred times in five minutes"; the
    // single-use nonce is what does not.
    const body = JSON.stringify({ id: 'evt_owasp_1', kind: 'invoice.paid' });
    const signed = signWebhookRequest({ ring: webhookSigningSecretRing(), url: '/v1/webhooks/inbound', body });
    const header = signed.headers[WEBHOOK_SIGNATURE_HEADER] ?? '';

    const post = () =>
      request(app)
        .post('/v1/webhooks/inbound')
        .set('content-type', 'application/json')
        .set(WEBHOOK_SIGNATURE_HEADER, header)
        .send(body);

    expect((await post()).status).toBe(202);

    const replay = await post();

    expect(replay.status).toBe(409);
    expect(replay.body.error.code).toBe('WEBHOOK_REPLAYED');
  });
});

describe('API7:2023 — Server Side Request Forgery', () => {
  /**
   * There is no reachable SSRF surface in this service: no route takes a URL
   * from a caller and fetches it. What is tested here is the control that has
   * to already exist on the day one does — the outbound client's confinement to
   * the base URL it was configured with — because an SSRF control added at the
   * same commit as the feature that needs it is a control added afterwards.
   *
   * Through `createDependencyClient`, not `createHttpClient`, which is the part
   * this file adds over `http-client.test.ts`: the confinement has to survive
   * the service-defaults wrapper every real dependency is built with.
   */
  const dependency = createDependencyClient({
    name: 'payments',
    baseUrl: 'https://payments.internal/v1/',
    fetch: () => Promise.reject(new Error('the transport must not be reached')),
  });

  it.each([
    ['the cloud metadata service', 'http://169.254.169.254/latest/meta-data/'],
    ['a protocol-relative host swap', '//169.254.169.254/latest/meta-data/'],
    ['a climb out of the base path', '../../internal/admin'],
    ['a sibling subtree on the same host', '/internal/admin'],
  ])('refuses a caller-supplied target that is %s', async (_label, target) => {
    await expect(dependency.fetch(target)).rejects.toBeInstanceOf(OutboundUrlNotAllowedError);
  });
});

describe('API8:2023 — Security Misconfiguration', () => {
  it('hardens a response no route claimed', async () => {
    const res = await request(app).get('/definitely-not-a-route');

    expect(res.status).toBe(404);
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
  });

  it('never names the framework', async () => {
    const res = await request(app).get('/v1/health/live');

    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('withholds cross-origin read access from an origin nobody configured', async () => {
    const res = await request(app)
      .get('/v1/health/live')
      .set('Origin', 'https://not-configured.example.test');

    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('does not quote the request back when it cannot parse it', async () => {
    // body-parser's own message embeds the offending input. Passing it through
    // puts a fragment of whatever the caller sent into the response and the
    // log, and what a caller sent is exactly where a mistyped secret ends up.
    const res = await request(app)
      .post('/v1/auth/login')
      .set('content-type', 'application/json')
      .send('{"password": "sk-live-not-a-real-secret-0000"');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('MALFORMED_BODY');
    expect(res.text).not.toContain('sk-live-not-a-real-secret-0000');
  });

  it('answers an unhandled fault without a stack trace or an internal message', async () => {
    mockQuery.mockRejectedValue(new Error('connect ECONNREFUSED 10.0.3.14:5432'));

    const res = await request(app).get('/v1/users').set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(500);
    expect(res.body.error).toEqual({
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred',
    });
    expect(res.text).not.toContain('10.0.3.14');
  });
});

describe('API9:2023 — Improper Inventory Management', () => {
  it('serves nothing outside the versioned prefix', async () => {
    // Every route in the service is mounted under `/v1`, so the unversioned
    // spelling of a real endpoint is a 404 rather than an older, unguarded copy
    // of it still answering.
    for (const path of ['/users', '/auth/login', '/health', '/webhooks/inbound']) {
      expect((await request(app).get(path)).status).toBe(404);
    }
  });

  it('names the API version in its own health report', async () => {
    const res = await request(app).get('/v1/health/ready');

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ version: 'v1' });
  });

  it('keeps the operational surface off the versioned API', async () => {
    // The exposition carries per-route metrics and is meant for a scraper, not
    // for the API's clients. `env.ts` refuses a `METRICS_PATH` under `/v1` at
    // boot; this is the other half — that the path it is actually on is not one
    // an API client would reach through the same gateway rule.
    expect(env.METRICS_PATH.startsWith('/v1')).toBe(false);
    expect((await request(app).get('/v1/metrics')).status).toBe(404);
  });

  it('does not expose dependency failure detail by default', async () => {
    // A readiness endpoint is polled from further away than the API it guards,
    // and a failing `pg` check names a host, a port and a database.
    expect(env.HEALTH_EXPOSE_ERRORS).toBe(false);
  });
});

describe('API10:2023 — Unsafe Consumption of APIs', () => {
  const path = '/v1/webhooks/inbound';

  function sign(body: string) {
    const signed = signWebhookRequest({ ring: webhookSigningSecretRing(), url: path, body });
    return signed.headers[WEBHOOK_SIGNATURE_HEADER] ?? '';
  }

  it('refuses third-party data that is not signed at all', async () => {
    const res = await request(app)
      .post(path)
      .set('content-type', 'application/json')
      .send(JSON.stringify({ id: 'evt_owasp_2' }));

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('WEBHOOK_SIGNATURE_REQUIRED');
  });

  it('refuses a delivery whose body was altered after it was signed', async () => {
    const original = JSON.stringify({ id: 'evt_owasp_3', amount: 100 });
    const header = sign(original);
    const tampered = JSON.stringify({ id: 'evt_owasp_3', amount: 1_000_000 });

    const res = await request(app)
      .post(path)
      .set('content-type', 'application/json')
      .set(WEBHOOK_SIGNATURE_HEADER, header)
      .send(tampered);

    expect(res.status).toBe(401);
  });

  it('answers a bad digest and an unheld key id identically', async () => {
    // Told apart, the pair enumerates the ring and reports how far a rotation
    // has got. Neither refusal depends on a secret, so neither needs to say
    // which one it was.
    const body = JSON.stringify({ id: 'evt_owasp_4' });
    const valid = sign(body);
    // `t=<ts>,n=<nonce>,kid=<keyId>,v1=<digest>` — see `formatSignatureHeader`.
    const wrongDigest = valid.replace(/,v1=[^,]+$/, `,v1=${'a'.repeat(64)}`);
    const unknownKey = valid.replace(/,kid=[^,]+,/, ',kid=test-hmac-not-in-the-ring,');
    expect(wrongDigest).not.toBe(valid);
    expect(unknownKey).not.toBe(valid);

    const send = (header: string) =>
      request(app)
        .post(path)
        .set('content-type', 'application/json')
        .set(WEBHOOK_SIGNATURE_HEADER, header)
        .send(body);

    const bad = await send(wrongDigest);
    const unheld = await send(unknownKey);

    expect(bad.status).toBe(unheld.status);
    expect(bad.body.error).toEqual(unheld.body.error);
  });
});
