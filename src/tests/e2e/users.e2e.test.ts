import request from 'supertest';
import { createApp } from '@/app';
import type { UserRow } from '@/users/users.repository';

// env vars are set in jest.setup.ts

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
}));

const app = createApp();

const SEED_USERS: UserRow[] = [
  {
    id: 'user-uuid-1',
    email: 'alice@example.com',
    password_hash: 'argon2id-mock:pass',
    roles: ['admin', 'user'],
    created_at: new Date('2024-01-01T00:00:00Z'),
    updated_at: new Date('2024-01-01T00:00:00Z'),
  },
  {
    id: 'user-uuid-2',
    email: 'bob@example.com',
    password_hash: 'argon2id-mock:pass',
    roles: ['user'],
    created_at: new Date('2024-01-02T00:00:00Z'),
    updated_at: new Date('2024-01-02T00:00:00Z'),
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

beforeEach(() => {
  mockQuery.mockReset();
  mockQueryOne.mockReset();
  mockQueryCount.mockReset();
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
  };

  it('returns 201 with created user for admin', async () => {
    mockQueryOne.mockResolvedValue(newUser);
    const token = await getAdminToken();

    const res = await request(app)
      .post('/v1/users')
      .set('Authorization', `Bearer ${token}`)
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
  };

  it('returns 200 with updated user', async () => {
    mockQueryOne.mockResolvedValue(updatedUser);
    const token = await getUserToken();

    const res = await request(app)
      .put('/v1/users/user-uuid-2')
      .set('Authorization', `Bearer ${token}`)
      .send({ email: 'bob-updated@example.com' });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ email: 'bob-updated@example.com' });
    expect(res.body.error).toBeNull();
  });

  it('returns 404 when user does not exist', async () => {
    mockQueryOne.mockResolvedValue(null);
    const token = await getUserToken();

    const res = await request(app)
      .put('/v1/users/nonexistent-id')
      .set('Authorization', `Bearer ${token}`)
      .send({ email: 'new@example.com' });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('returns 422 when email is invalid', async () => {
    const token = await getUserToken();

    const res = await request(app)
      .put('/v1/users/user-uuid-2')
      .set('Authorization', `Bearer ${token}`)
      .send({ email: 'bad-email' });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 401 when no token is provided', async () => {
    const res = await request(app)
      .put('/v1/users/user-uuid-2')
      .send({ email: 'new@example.com' });

    expect(res.status).toBe(401);
  });
});

describe('DELETE /v1/users/:id (admin only)', () => {
  it('returns 204 on successful delete', async () => {
    mockQueryOne.mockResolvedValue({ id: 'user-uuid-2' });
    const token = await getAdminToken();

    const res = await request(app)
      .delete('/v1/users/user-uuid-2')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(204);
  });

  it('returns 404 when user does not exist', async () => {
    mockQueryOne.mockResolvedValue(null);
    const token = await getAdminToken();

    const res = await request(app)
      .delete('/v1/users/nonexistent-id')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('returns 403 for non-admin user', async () => {
    const token = await getUserToken();

    const res = await request(app)
      .delete('/v1/users/user-uuid-2')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
  });

  it('returns 401 when no token is provided', async () => {
    const res = await request(app).delete('/v1/users/user-uuid-2');

    expect(res.status).toBe(401);
  });
});
