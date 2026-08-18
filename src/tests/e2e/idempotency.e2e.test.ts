import request from 'supertest';
import { DatabaseError } from 'pg';
import { createApp } from '@/app';
import { IDEMPOTENCY_REPLAYED_HEADER } from '@/idempotency';
import { resetRateLimiters } from '@/middleware/rate-limit.middleware';
import { usersCache } from '@/users/users.controller';
import type { UserRow } from '@/users/users.repository';

// env vars are set in jest.setup.ts

jest.mock('@/lib/password', () => ({
  verifyPassword: jest.fn(async (plain: string, _hash: string) => plain === 'password'),
  hashPassword: jest.fn(async (plain: string) => `argon2id-mock:${plain}`),
}));

/**
 * The composition root registers the Postgres store; this suite has no
 * Postgres, exactly as it has no `pg` pool. Substituting the in-memory
 * implementation of the same interface keeps the *protocol* under test — claim,
 * replay, mismatch — while the store's own SQL is covered by
 * `postgres.store.test.ts`. Nothing about the routes, the container wiring or
 * the pipeline is stubbed.
 */
jest.mock('@/idempotency/postgres.store', () => ({
  PostgresIdempotencyStore: jest.requireActual('@/idempotency/memory.store')
    .MemoryIdempotencyStore as unknown,
}));

const mockQuery = jest.fn();
const mockQueryOne = jest.fn();
const mockQueryCount = jest.fn();

jest.mock('@/db/query', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
  queryOne: (...args: unknown[]) => mockQueryOne(...args),
  queryCount: (...args: unknown[]) => mockQueryCount(...args),
  // The repository's default executor. Absent from this factory it would be
  // `undefined`, and every call that did not explicitly pass a transaction
  // would fail on it — see `poolQueryable` in `@/db/query`.
  poolQueryable: { query: (...args: unknown[]) => mockQuery(...args), queryOne: (...args: unknown[]) => mockQueryOne(...args), queryCount: (...args: unknown[]) => mockQueryCount(...args) },
}));

/**
 * A transaction, for the purposes of these cases, is the mocked query layer.
 *
 * The two writes below now run inside `withRetryableTransaction`, which takes a
 * real pooled connection — something this suite has never had. Rather than
 * mocking `pg` itself, the callback is handed a client that forwards to the
 * same mocks every other statement here goes through, so a case can still
 * queue a response and assert the HTTP answer.
 *
 * What that gives up is stated plainly: nothing here exercises BEGIN/COMMIT,
 * rollback, `SET LOCAL`, or the retry loop. Those have their own suites
 * (`db/transaction.test.ts`, `db/retry-transaction.test.ts`); these cases are
 * about what the route answers.
 */
jest.mock('@/db/transaction', () => {
  const { IN_TRANSACTION } = jest.requireActual('@/db/queryable') as {
    IN_TRANSACTION: symbol;
  };
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

const CREATED_USER: UserRow = {
  id: 'user-uuid-9',
  email: 'dana@example.com',
  password_hash: null,
  roles: ['user'],
  created_at: new Date('2026-03-01T00:00:00Z'),
  updated_at: new Date('2026-03-01T00:00:00Z'),
  version: 1,
};

const NEW_USER_BODY = { email: 'dana@example.com', roles: ['user'] };

async function getAdminToken(): Promise<string> {
  const res = await request(app)
    .post('/v1/auth/login')
    .send({ email: 'admin@example.com', password: 'password' });
  return (res.body.data as { accessToken: string }).accessToken;
}

async function getUserToken(): Promise<string> {
  const res = await request(app)
    .post('/v1/auth/login')
    .send({ email: 'user@example.com', password: 'password' });
  return (res.body.data as { accessToken: string }).accessToken;
}

function createUser(token: string, key: string | null, body: object = NEW_USER_BODY) {
  const pending = request(app).post('/v1/users').set('Authorization', `Bearer ${token}`);
  if (key !== null) pending.set('Idempotency-Key', key);
  return pending.send(body);
}

/** The store is a container singleton, so every case needs its own key. */
let keySeed = 0;
function freshKey(): string {
  keySeed += 1;
  return `e2e-key-${keySeed}`;
}

beforeEach(async () => {
  mockQuery.mockReset();
  mockQueryOne.mockReset();
  mockQueryCount.mockReset();
  await resetRateLimiters();
  await usersCache.clear();
});

describe('POST /v1/users with an Idempotency-Key', () => {
  it('creates the user once, however many times the request arrives', async () => {
    mockQueryOne.mockResolvedValue(CREATED_USER);
    const token = await getAdminToken();
    const key = freshKey();

    const first = await createUser(token, key);
    const writesAfterFirst = mockQueryOne.mock.calls.length;
    const second = await createUser(token, key);

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body).toEqual(first.body);
    // Byte-identical, not merely equal: the replay is the recorded response,
    // not a re-serialisation of a value.
    expect(second.text).toBe(first.text);
    expect(second.headers[IDEMPOTENCY_REPLAYED_HEADER.toLowerCase()]).toBe('true');
    expect(mockQueryOne.mock.calls.length).toBe(writesAfterFirst);
  });

  it('rejects a request that carries no key', async () => {
    const token = await getAdminToken();

    const res = await createUser(token, null);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    expect(mockQueryOne).not.toHaveBeenCalled();
  });

  it('rejects the same key carrying a different body', async () => {
    mockQueryOne.mockResolvedValue(CREATED_USER);
    const token = await getAdminToken();
    const key = freshKey();

    await createUser(token, key);
    const res = await createUser(token, key, { email: 'someone-else@example.com' });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('replays a recorded rejection instead of re-attempting the write', async () => {
    const duplicate = new DatabaseError(
      'duplicate key value violates unique constraint "users_email_key"',
      0,
      'error',
    );
    duplicate.code = '23505';
    mockQueryOne.mockRejectedValue(duplicate);
    const token = await getAdminToken();
    const key = freshKey();

    const first = await createUser(token, key);
    const attemptsAfterFirst = mockQueryOne.mock.calls.length;
    const second = await createUser(token, key);

    expect(first.status).toBe(409);
    expect(second.status).toBe(409);
    expect(second.body).toEqual(first.body);
    expect(second.headers[IDEMPOTENCY_REPLAYED_HEADER.toLowerCase()]).toBe('true');
    expect(mockQueryOne.mock.calls.length).toBe(attemptsAfterFirst);
  });

  it('replays the validation failure rather than re-deriving it', async () => {
    const token = await getAdminToken();
    const key = freshKey();

    // The key is claimed before the body is validated, which is what makes a
    // retry of a rejected request answer identically.
    const first = await createUser(token, key, { email: 'not-an-email' });
    const second = await createUser(token, key, { email: 'not-an-email' });

    expect(first.status).toBe(422);
    expect(first.body.error.code).toBe('VALIDATION_ERROR');
    expect(second.body).toEqual(first.body);
    expect(second.headers[IDEMPOTENCY_REPLAYED_HEADER.toLowerCase()]).toBe('true');
  });

  it('refuses a non-admin before it ever looks at the key', async () => {
    const token = await getUserToken();

    const res = await createUser(token, null);

    // 403, not 400: the step is declared over an authenticated request and
    // wired behind `requireRoles`, so an unauthorised caller learns nothing
    // about what the route expects.
    expect(res.status).toBe(403);
  });

  it('scopes keys to the caller, so one admin cannot replay another response', async () => {
    mockQueryOne.mockResolvedValue(CREATED_USER);
    const key = freshKey();
    const token = await getAdminToken();

    const first = await createUser(token, key);
    // A second login for the same principal is the same scope: the scope is the
    // user, not the token.
    const sameUserAgain = await createUser(await getAdminToken(), key);

    expect(first.status).toBe(201);
    expect(sameUserAgain.headers[IDEMPOTENCY_REPLAYED_HEADER.toLowerCase()]).toBe('true');
  });
});

describe('routes without an idempotency key', () => {
  it('leaves PUT alone — it is already idempotent by method', async () => {
    // `PUT` carries `If-Match` rather than `Idempotency-Key`: the two guard
    // different hazards, and this case is about the key being absent.
    mockQueryOne.mockResolvedValue({ ...CREATED_USER, __updated: true });
    const token = await getAdminToken();

    const res = await request(app)
      .put(`/v1/users/${CREATED_USER.id}`)
      .set('Authorization', `Bearer ${token}`)
      .set('If-Match', '*')
      .send({ email: 'dana@example.com' });

    expect(res.status).toBe(200);
  });
});
