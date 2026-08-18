import request from 'supertest';
import { DatabaseError } from 'pg';
import { createApp } from '@/app';
import { tokenStore } from '@/auth/token-store';
import { resetRateLimiters } from '@/middleware/rate-limit.middleware';
import { usersCache } from '@/users/users.controller';
import type { UserRow } from '@/users/users.repository';

// env vars are set in jest.setup.ts

jest.mock('@/lib/password', () => ({
  verifyPassword: jest.fn(async (plain: string, _hash: string) => plain === 'password'),
  hashPassword: jest.fn(async (plain: string) => `argon2id-mock:${plain}`),
}));

/**
 * `POST /v1/users` now claims an `Idempotency-Key` before it runs, and the
 * registered store is the Postgres one — which would issue its statements
 * through the `@/db/query` mock below and read the responses this suite queues
 * for the *repository*. Substituting the in-memory implementation keeps the two
 * concerns apart, so a test that makes every query reject is still asserting
 * that the repository failed rather than that the claim did.
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

const SEED_USERS: UserRow[] = [
  {
    id: 'user-uuid-1',
    email: 'alice@example.com',
    password_hash: 'argon2id-mock:pass',
    roles: ['admin', 'user'],
    created_at: new Date('2024-01-01T00:00:00Z'),
    updated_at: new Date('2024-01-01T00:00:00Z'),
    version: 3,
  },
  {
    id: 'user-uuid-2',
    email: 'bob@example.com',
    password_hash: 'argon2id-mock:pass',
    roles: ['user'],
    created_at: new Date('2024-01-02T00:00:00Z'),
    updated_at: new Date('2024-01-02T00:00:00Z'),
    version: 7,
  },
];

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

beforeEach(async () => {
  mockQuery.mockReset();
  mockQueryOne.mockReset();
  mockQueryCount.mockReset();
  // Every case logs in to get a token, and the login limiter allows only five
  // attempts per window per IP — without a reset the suite throttles itself.
  await resetRateLimiters();
  // Reads are cached for 5s, so without this a case would assert against the
  // row the *previous* case seeded.
  await usersCache.clear();
});

describe('GET /v1/users (admin only)', () => {
  it('returns 200 with list of users for admin', async () => {
    mockQuery.mockResolvedValue(SEED_USERS);
    const token = await getAdminToken();

    const res = await request(app)
      .get('/v1/users')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data[0]).toMatchObject({ email: 'alice@example.com' });
    expect(res.body.error).toBeNull();
  });

  it('returns 403 for non-admin user', async () => {
    const token = await getUserToken();

    const res = await request(app)
      .get('/v1/users')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('returns 401 when no token is provided', async () => {
    const res = await request(app).get('/v1/users');

    expect(res.status).toBe(401);
  });
});

describe('GET /v1/users/:id', () => {
  it('returns 200 with user data for authenticated user', async () => {
    mockQueryOne.mockResolvedValue(SEED_USERS[0]!);
    const token = await getUserToken();

    const res = await request(app)
      .get('/v1/users/user-uuid-1')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      id: 'user-uuid-1',
      email: 'alice@example.com',
    });
    expect(res.body.error).toBeNull();
  });

  it('returns 404 when user does not exist', async () => {
    mockQueryOne.mockResolvedValue(null);
    const token = await getUserToken();

    const res = await request(app)
      .get('/v1/users/nonexistent-id')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('returns 401 when no token is provided', async () => {
    const res = await request(app).get('/v1/users/user-uuid-1');

    expect(res.status).toBe(401);
  });
});

describe('POST /v1/users (admin only)', () => {
  const newUser: UserRow = {
    id: 'user-uuid-3',
    email: 'charlie@example.com',
    password_hash: 'argon2id-mock:secret',
    roles: ['user'],
    created_at: new Date('2024-03-01T00:00:00Z'),
    updated_at: new Date('2024-03-01T00:00:00Z'),
    version: 1,
  };

  it('returns 201 with created user for admin', async () => {
    mockQueryOne.mockResolvedValue(newUser);
    const token = await getAdminToken();

    const res = await request(app)
      .post('/v1/users')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', 'users-e2e-create')
      .send({ email: 'charlie@example.com', roles: ['user'] });

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      id: 'user-uuid-3',
      email: 'charlie@example.com',
    });
    expect(res.body.error).toBeNull();
  });

  it('returns 422 when email is invalid', async () => {
    const token = await getAdminToken();

    const res = await request(app)
      .post('/v1/users')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', 'users-e2e-invalid-email')
      .send({ email: 'not-an-email', roles: ['user'] });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 403 for non-admin user', async () => {
    const token = await getUserToken();

    const res = await request(app)
      .post('/v1/users')
      .set('Authorization', `Bearer ${token}`)
      .send({ email: 'charlie@example.com' });

    expect(res.status).toBe(403);
  });

  it('returns 401 when no token is provided', async () => {
    const res = await request(app)
      .post('/v1/users')
      .send({ email: 'charlie@example.com' });

    expect(res.status).toBe(401);
  });
});

describe('PUT /v1/users/:id', () => {
  const updatedUser: UserRow = {
    ...SEED_USERS[1]!,
    email: 'bob-updated@example.com',
    updated_at: new Date('2024-06-01T00:00:00Z'),
    version: 8,
  };

  /** What the conditional `UPDATE` statement returns when it matched a row. */
  const updateHit = { ...updatedUser, __updated: true };

  it('returns 200 with updated user', async () => {
    mockQueryOne.mockResolvedValue(updateHit);
    const token = await getUserToken();

    const res = await request(app)
      .put('/v1/users/user-uuid-2')
      .set('Authorization', `Bearer ${token}`)
      .set('If-Match', '"7"')
      .send({ email: 'bob-updated@example.com' });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ email: 'bob-updated@example.com' });
    expect(res.body.error).toBeNull();
    // The validator for the state this write just produced, so the client's
    // next conditional write does not need a `GET` in between.
    expect(res.headers.etag).toBe('"8"');
    // The discriminator the statement carried is an implementation detail of
    // the repository and must not reach the client.
    expect(res.body.data).not.toHaveProperty('__updated');
  });

  it('returns 404 when user does not exist', async () => {
    mockQueryOne.mockResolvedValue(null);
    const token = await getUserToken();

    const res = await request(app)
      .put('/v1/users/nonexistent-id')
      .set('Authorization', `Bearer ${token}`)
      .set('If-Match', '"7"')
      .send({ email: 'new@example.com' });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('returns 422 when email is invalid', async () => {
    const token = await getUserToken();

    const res = await request(app)
      .put('/v1/users/user-uuid-2')
      .set('Authorization', `Bearer ${token}`)
      .set('If-Match', '"7"')
      .send({ email: 'bad-email' });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 401 when no token is provided', async () => {
    const res = await request(app)
      .put('/v1/users/user-uuid-2')
      .set('If-Match', '"7"')
      .send({ email: 'new@example.com' });

    expect(res.status).toBe(401);
  });
});

describe('optimistic concurrency on PUT /v1/users/:id', () => {
  const conflictRow = { ...SEED_USERS[1]!, __updated: false };

  it('returns 428 when the request states no expectation at all', async () => {
    const token = await getUserToken();

    const res = await request(app)
      .put('/v1/users/user-uuid-2')
      .set('Authorization', `Bearer ${token}`)
      .send({ email: 'bob-updated@example.com' });

    expect(res.status).toBe(428);
    expect(res.body.error.code).toBe('PRECONDITION_REQUIRED');
    // The write must not have been attempted.
    expect(mockQueryOne).not.toHaveBeenCalled();
  });

  it('returns 412 with the current ETag when the row moved on', async () => {
    mockQueryOne.mockResolvedValue(conflictRow);
    const token = await getUserToken();

    const res = await request(app)
      .put('/v1/users/user-uuid-2')
      .set('Authorization', `Bearer ${token}`)
      .set('If-Match', '"3"')
      .send({ email: 'bob-updated@example.com' });

    expect(res.status).toBe(412);
    expect(res.body.error.code).toBe('PRECONDITION_FAILED');
    // Recovery in one round trip: the client can rebuild its patch against
    // version 7 without re-reading the row first.
    expect(res.headers.etag).toBe('"7"');
  });

  it('sends the expected versions to the database as a matchable set', async () => {
    mockQueryOne.mockResolvedValue({ ...SEED_USERS[1]!, __updated: true });
    const token = await getUserToken();

    await request(app)
      .put('/v1/users/user-uuid-2')
      .set('Authorization', `Bearer ${token}`)
      .set('If-Match', '"6", "7"')
      .send({ email: 'bob-updated@example.com' });

    const [sql, params] = mockQueryOne.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('"version" = ANY(');
    expect(params).toContainEqual([6, 7]);
  });

  it('adds no version predicate for If-Match: *', async () => {
    mockQueryOne.mockResolvedValue({ ...SEED_USERS[1]!, __updated: true });
    const token = await getUserToken();

    const res = await request(app)
      .put('/v1/users/user-uuid-2')
      .set('Authorization', `Bearer ${token}`)
      .set('If-Match', '*')
      .send({ email: 'bob-updated@example.com' });

    expect(res.status).toBe(200);
    const [sql] = mockQueryOne.mock.calls[0] as [string, unknown[]];
    expect(sql).not.toContain('ANY(');
  });

  it('returns 400, not 412, for a weak entity-tag', async () => {
    const token = await getUserToken();

    const res = await request(app)
      .put('/v1/users/user-uuid-2')
      .set('Authorization', `Bearer ${token}`)
      .set('If-Match', 'W/"7"')
      .send({ email: 'bob-updated@example.com' });

    // A 412 here would send the client back for a fresh validator it would
    // then weaken again, forever.
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('PRECONDITION_MALFORMED');
    expect(mockQueryOne).not.toHaveBeenCalled();
  });

  it('returns 400 for a header that is not an entity-tag list', async () => {
    const token = await getUserToken();

    const res = await request(app)
      .put('/v1/users/user-uuid-2')
      .set('Authorization', `Bearer ${token}`)
      .set('If-Match', '7')
      .send({ email: 'bob-updated@example.com' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('PRECONDITION_MALFORMED');
  });

  it('drops a cached read on conflict so the client’s recovery GET is fresh', async () => {
    mockQueryOne.mockResolvedValueOnce(SEED_USERS[1]!).mockResolvedValue(conflictRow);
    const token = await getUserToken();

    const before = await request(app)
      .get('/v1/users/user-uuid-2')
      .set('Authorization', `Bearer ${token}`);
    expect(before.body.meta).toEqual({ cache: 'miss' });

    await request(app)
      .put('/v1/users/user-uuid-2')
      .set('Authorization', `Bearer ${token}`)
      .set('If-Match', '"3"')
      .send({ email: 'bob-updated@example.com' });

    const after = await request(app)
      .get('/v1/users/user-uuid-2')
      .set('Authorization', `Bearer ${token}`);

    // Left cached, this read would answer from the same entry that produced
    // the stale validator, and the client's retry would conflict again for as
    // long as the TTL lasts.
    expect(after.body.meta).toEqual({ cache: 'miss' });
  });
});

describe('DELETE /v1/users/:id (admin only)', () => {
  /** What the conditional `DELETE` statement returns when it removed the row. */
  const deleteHit = { __deleted: true, version: null };

  /**
   * Every delete now locks the administrator set before it reads the target, so
   * every case here has to answer that `SELECT ... FOR UPDATE` — what it
   * returns is what decides whether the invariant lets the delete through.
   *
   * Alice is the only seeded administrator and the cases below target Bob, so
   * the guard finds the target outside the locked set and returns.
   */
  const lockedAdmins = (admins: UserRow[] = [SEED_USERS[0]!]): void => {
    mockQuery.mockResolvedValue(admins);
  };

  it('returns 204 on successful delete', async () => {
    lockedAdmins();
    mockQueryOne.mockResolvedValue(deleteHit);
    const token = await getAdminToken();

    const res = await request(app)
      .delete('/v1/users/user-uuid-2')
      .set('Authorization', `Bearer ${token}`)
      .set('If-Match', '*');

    expect(res.status).toBe(204);
  });

  it('returns 404 when user does not exist', async () => {
    lockedAdmins();
    mockQueryOne.mockResolvedValue(null);
    const token = await getAdminToken();

    const res = await request(app)
      .delete('/v1/users/nonexistent-id')
      .set('Authorization', `Bearer ${token}`)
      .set('If-Match', '*');

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('returns 412 when the row moved on since the caller read it', async () => {
    lockedAdmins();
    mockQueryOne.mockResolvedValue({ __deleted: false, version: 9 });
    const token = await getAdminToken();

    const res = await request(app)
      .delete('/v1/users/user-uuid-2')
      .set('Authorization', `Bearer ${token}`)
      .set('If-Match', '"4"');

    expect(res.status).toBe(412);
    expect(res.body.error.code).toBe('PRECONDITION_FAILED');
    expect(res.headers.etag).toBe('"9"');
  });

  it('returns 428 without an If-Match, and deletes nothing', async () => {
    lockedAdmins();
    const token = await getAdminToken();

    const res = await request(app)
      .delete('/v1/users/user-uuid-2')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(428);
    expect(res.body.error.code).toBe('PRECONDITION_REQUIRED');
    expect(mockQueryOne).not.toHaveBeenCalled();
    // Not even the lock: `requireIfMatch` runs ahead of the operation, so a
    // caller that omitted the header never opens a transaction.
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('returns 403 for non-admin user', async () => {
    const token = await getUserToken();

    const res = await request(app)
      .delete('/v1/users/user-uuid-2')
      .set('Authorization', `Bearer ${token}`)
      .set('If-Match', '*');

    expect(res.status).toBe(403);
  });

  it('returns 401 when no token is provided', async () => {
    const res = await request(app).delete('/v1/users/user-uuid-2').set('If-Match', '*');

    expect(res.status).toBe(401);
  });
});

/**
 * The invariant that needs a lock rather than a version check, exercised
 * through the wire on both writes that can violate it.
 *
 * Optimistic concurrency cannot reach this one. Two requests demoting two
 * different administrators leave each other's rows alone, so both preconditions
 * hold and both writes are individually correct — what they produce together is
 * a system with no administrator. The rule is over a set, and the only way to
 * check a set is to hold it still.
 */
describe('the last administrator cannot be removed', () => {
  /** The locked administrator set, as `lockAdmins` returns it. */
  const onlyAlice = [SEED_USERS[0]!];
  const aliceAndCarol = [SEED_USERS[0]!, { ...SEED_USERS[0]!, id: 'user-uuid-3' }];

  it('refuses a PUT that drops the last admin role, with 409 LAST_ADMIN', async () => {
    mockQuery.mockResolvedValue(onlyAlice);
    const token = await getUserToken();

    const res = await request(app)
      .put('/v1/users/user-uuid-1')
      .set('Authorization', `Bearer ${token}`)
      .set('If-Match', '"3"')
      .send({ roles: ['user'] });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('LAST_ADMIN');
    // The write never ran: the guard threw before the conditional UPDATE.
    expect(mockQueryOne).not.toHaveBeenCalled();
  });

  it('allows the same PUT once a second administrator exists', async () => {
    mockQuery.mockResolvedValue(aliceAndCarol);
    mockQueryOne.mockResolvedValue({ ...SEED_USERS[0]!, roles: ['user'], version: 4, __updated: true });
    const token = await getUserToken();

    const res = await request(app)
      .put('/v1/users/user-uuid-1')
      .set('Authorization', `Bearer ${token}`)
      .set('If-Match', '"3"')
      .send({ roles: ['user'] });

    expect(res.status).toBe(200);
    expect(res.body.data.roles).toEqual(['user']);
  });

  /**
   * The lock is not free, so it is taken only when the patch could actually
   * shrink the set — which is what keeps an ordinary email change off this
   * path entirely.
   */
  it('takes no lock for a patch that cannot remove the role', async () => {
    mockQueryOne.mockResolvedValue({ ...SEED_USERS[0]!, email: 'a@example.com', __updated: true });
    const token = await getUserToken();

    const res = await request(app)
      .put('/v1/users/user-uuid-1')
      .set('Authorization', `Bearer ${token}`)
      .set('If-Match', '"3"')
      .send({ email: 'a@example.com' });

    expect(res.status).toBe(200);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('takes no lock for a patch that keeps the admin role', async () => {
    mockQueryOne.mockResolvedValue({ ...SEED_USERS[0]!, __updated: true });
    const token = await getUserToken();

    await request(app)
      .put('/v1/users/user-uuid-1')
      .set('Authorization', `Bearer ${token}`)
      .set('If-Match', '"3"')
      .send({ roles: ['admin', 'user'] });

    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('refuses a DELETE of the last administrator, with 409 LAST_ADMIN', async () => {
    mockQuery.mockResolvedValue(onlyAlice);
    const token = await getAdminToken();

    const res = await request(app)
      .delete('/v1/users/user-uuid-1')
      .set('Authorization', `Bearer ${token}`)
      .set('If-Match', '*');

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('LAST_ADMIN');
    expect(mockQueryOne).not.toHaveBeenCalled();
  });

  it('allows deleting an administrator while another remains', async () => {
    mockQuery.mockResolvedValue(aliceAndCarol);
    mockQueryOne.mockResolvedValue({ __deleted: true, version: null });
    const token = await getAdminToken();

    const res = await request(app)
      .delete('/v1/users/user-uuid-1')
      .set('Authorization', `Bearer ${token}`)
      .set('If-Match', '*');

    expect(res.status).toBe(204);
  });
});

describe('domain events reach their subscribers through the app', () => {
  // Unit tests cover the bus and each subscriber; these two go through the real
  // wiring in `app.ts`, which is the part no unit test can vouch for — a
  // subscriber that was written but never registered passes every one of them.

  it('revokes a deleted user’s refresh tokens', async () => {
    // `/v1/users/:id` and the auth directory are separate stores in this
    // boilerplate, so the id here is the one the login actually issued for.
    const login = await request(app)
      .post('/v1/auth/login')
      .send({ email: 'user@example.com', password: 'password' });
    const refreshToken = (login.body.data as { refreshToken: string }).refreshToken;
    await expect(tokenStore.has(refreshToken)).resolves.toBe(true);

    mockQuery.mockResolvedValue([SEED_USERS[0]!]);
    mockQueryOne.mockResolvedValue({ __deleted: true, version: null });
    const token = await getAdminToken();

    const res = await request(app)
      .delete('/v1/users/2')
      .set('Authorization', `Bearer ${token}`)
      .set('If-Match', '*');

    expect(res.status).toBe(204);
    // Without the subscriber this token stays valid for JWT_REFRESH_EXPIRES_IN
    // after the account is gone.
    await expect(tokenStore.has(refreshToken)).resolves.toBe(false);
  });

  it('writes an audit line carrying the deleting request’s correlation id', async () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      mockQuery.mockResolvedValue([SEED_USERS[0]!]);
      mockQueryOne.mockResolvedValue({ __deleted: true, version: null });
      const token = await getAdminToken();

      await request(app)
        .delete('/v1/users/user-uuid-2')
        .set('Authorization', `Bearer ${token}`)
        .set('If-Match', '*')
        .set('x-correlation-id', 'e2e-correlation-id');

      const audited = log.mock.calls
        .map(([line]) => line)
        .filter((line): line is string => typeof line === 'string' && line.includes('"audit"'))
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((entry) => entry['eventName'] === 'user.deleted');

      expect(audited).toHaveLength(1);
      expect(audited[0]).toMatchObject({
        subject: 'user-uuid-2',
        // The admin's own id from the bearer token, so the line says who did it.
        actorId: '1',
        correlationId: 'e2e-correlation-id',
      });
    } finally {
      log.mockRestore();
    }
  });
});

describe('error translation reaches the wire', () => {
  it('returns 409, not 500, when the email is already taken', async () => {
    // What Postgres raises against the unique index on users.email.
    const duplicate = new DatabaseError(
      'duplicate key value violates unique constraint "users_email_key"',
      0,
      'error',
    );
    duplicate.code = '23505';
    mockQueryOne.mockRejectedValue(duplicate);
    const token = await getAdminToken();

    const res = await request(app)
      .post('/v1/users')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', 'users-e2e-duplicate-email')
      .send({ email: 'alice@example.com' });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('UNIQUE_VIOLATION');
    // The constraint name is an internal detail and must not reach the client.
    expect(res.body.error.message).not.toContain('users_email_key');
  });

  it('still returns 500 for a genuine server-side SQL fault', async () => {
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const undefinedTable = new DatabaseError('relation "users" does not exist', 0, 'error');
    undefinedTable.code = '42P01';
    mockQueryOne.mockRejectedValue(undefinedTable);
    const token = await getAdminToken();

    const res = await request(app)
      .post('/v1/users')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', 'users-e2e-sql-fault')
      .send({ email: 'charlie@example.com' });

    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL_ERROR');
    consoleSpy.mockRestore();
  });

  it('returns the failed field in the 422 issues array', async () => {
    const token = await getAdminToken();

    const res = await request(app)
      .post('/v1/users')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', 'users-e2e-issues-array')
      .send({ email: 'not-an-email' });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    // Before validation moved to the edge the controller threw a bare
    // AppError(422) and the client got no way to tell which field was wrong.
    expect(res.body.error.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: ['email'] })]),
    );
  });
});

describe('read caching on the users routes', () => {
  it('serves a repeated read from cache instead of re-querying', async () => {
    mockQuery.mockResolvedValue(SEED_USERS);
    const token = await getAdminToken();

    const first = await request(app).get('/v1/users').set('Authorization', `Bearer ${token}`);
    const second = await request(app).get('/v1/users').set('Authorization', `Bearer ${token}`);

    expect(first.body.meta).toEqual({ cache: 'miss' });
    expect(second.body.meta).toEqual({ cache: 'hit' });
    expect(second.body.data).toHaveLength(2);
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('does not serve one principal the list computed for another', async () => {
    mockQueryOne.mockResolvedValue(SEED_USERS[0]!);
    const adminToken = await getAdminToken();
    const userToken = await getUserToken();

    await request(app).get('/v1/users/user-uuid-1').set('Authorization', `Bearer ${adminToken}`);
    const other = await request(app)
      .get('/v1/users/user-uuid-1')
      .set('Authorization', `Bearer ${userToken}`);

    // Same URL, different caller: a key that ignored the principal would hand
    // the second caller an answer that was authorised for the first.
    expect(other.body.meta).toEqual({ cache: 'miss' });
    expect(mockQueryOne).toHaveBeenCalledTimes(2);
  });

  it('keeps separate entries per resource id', async () => {
    mockQueryOne.mockResolvedValue(SEED_USERS[0]!);
    const token = await getUserToken();

    await request(app).get('/v1/users/user-uuid-1').set('Authorization', `Bearer ${token}`);
    const second = await request(app)
      .get('/v1/users/user-uuid-2')
      .set('Authorization', `Bearer ${token}`);

    expect(second.body.meta).toEqual({ cache: 'miss' });
    expect(mockQueryOne).toHaveBeenCalledTimes(2);
  });

  it('a write invalidates the cached read rather than leaving it stale', async () => {
    mockQuery.mockResolvedValue(SEED_USERS);
    mockQueryOne.mockResolvedValue({
      id: 'user-uuid-3',
      email: 'charlie@example.com',
      password_hash: null,
      roles: ['user'],
      created_at: new Date('2024-03-01T00:00:00Z'),
      updated_at: new Date('2024-03-01T00:00:00Z'),
      version: 1,
    });
    const token = await getAdminToken();

    await request(app).get('/v1/users').set('Authorization', `Bearer ${token}`);
    await request(app)
      .post('/v1/users')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', 'users-e2e-cache-invalidation')
      .send({ email: 'charlie@example.com', roles: ['user'] });

    const afterWrite = await request(app).get('/v1/users').set('Authorization', `Bearer ${token}`);

    expect(afterWrite.body.meta).toEqual({ cache: 'miss' });
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });

  it('does not cache a 404, so the row appears as soon as it exists', async () => {
    mockQueryOne.mockResolvedValueOnce(null).mockResolvedValue(SEED_USERS[0]!);
    const token = await getUserToken();

    const missing = await request(app)
      .get('/v1/users/user-uuid-1')
      .set('Authorization', `Bearer ${token}`);
    const found = await request(app)
      .get('/v1/users/user-uuid-1')
      .set('Authorization', `Bearer ${token}`);

    expect(missing.status).toBe(404);
    expect(found.status).toBe(200);
  });

  it('does not cache a write response under the read key', async () => {
    mockQueryOne.mockResolvedValue({ ...SEED_USERS[1]!, __updated: true });
    mockQuery.mockResolvedValue(SEED_USERS);
    const token = await getAdminToken();

    const write = await request(app)
      .put('/v1/users/user-uuid-2')
      .set('Authorization', `Bearer ${token}`)
      .set('If-Match', '*')
      .send({ email: 'bob-updated@example.com' });

    expect(write.body.meta).toBeNull();

    const read = await request(app).get('/v1/users').set('Authorization', `Bearer ${token}`);
    expect(read.body.meta).toEqual({ cache: 'miss' });
  });
});
