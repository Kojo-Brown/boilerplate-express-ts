import { createHash } from 'node:crypto';
import request from 'supertest';
import { createApp } from '@/app';
import { resetRateLimiters } from '@/middleware/rate-limit.middleware';

// env vars are set in jest.setup.ts

jest.mock('@/lib/password', () => ({
  verifyPassword: jest.fn(async (plain: string, _hash: string) => plain === 'password'),
  hashPassword: jest.fn(async (plain: string) => `argon2id-mock:${plain}`),
}));

jest.mock('@/upload/s3.service', () => ({
  generatePresignedPutUrl: jest.fn(),
  uploadToS3: jest.fn(async () => ({ key: 'uploads/fake.png', url: 'https://example.test/fake' })),
  buildPublicUrl: jest.fn(() => 'https://example.test/fake'),
}));

const app = createApp();

async function getToken(): Promise<string> {
  const res = await request(app)
    .post('/v1/auth/login')
    .send({ email: 'user@example.com', password: 'password' });
  return (res.body.data as { accessToken: string }).accessToken;
}

beforeEach(async () => {
  await resetRateLimiters();
});

// Multer error mapping used to live in a route-local error handler on the
// upload router. These cases pin the behaviour to the registered translator so
// removing that duplicate handler cannot regress the responses.
describe('Multer errors are translated by the global handler', () => {
  it('returns 400 UNEXPECTED_FILE_FIELD when the file arrives under the wrong field', async () => {
    const token = await getToken();

    const res = await request(app)
      .post('/v1/uploads')
      .set('Authorization', `Bearer ${token}`)
      .attach('avatar', Buffer.from('fake-png-bytes'), {
        filename: 'a.png',
        contentType: 'image/png',
      });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('UNEXPECTED_FILE_FIELD');
  });

  it('returns 415 for a content type the filter rejects', async () => {
    const token = await getToken();

    const res = await request(app)
      .post('/v1/uploads')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', Buffer.from('#!/bin/sh'), {
        filename: 'script.sh',
        contentType: 'application/x-sh',
      });

    expect(res.status).toBe(415);
    expect(res.body.error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
  });

  it('returns 201 for an accepted upload', async () => {
    const token = await getToken();

    const res = await request(app)
      .post('/v1/uploads')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', Buffer.from('fake-png-bytes'), {
        filename: 'a.png',
        contentType: 'image/png',
      });

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ key: 'uploads/fake.png' });
  });

  /**
   * The digest is of the bytes that were stored, and it is computed on the
   * request path — so this asserts the wiring end to end, not just that the
   * field is present.
   *
   * This payload is well under `WORKER_POOL_OFFLOAD_MIN_BYTES`, so it is hashed
   * inline and no thread is started. That is deliberate: an e2e suite that
   * spawned OS threads per upload would be paying ~300ms a case for a code path
   * `worker-pool.integration.test.ts` already covers directly, and would leave
   * threads to be torn down by whatever ran last.
   */
  it('returns a checksum of exactly the bytes that were uploaded', async () => {
    const token = await getToken();
    const content = Buffer.from('fake-png-bytes');

    const res = await request(app)
      .post('/v1/uploads')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', content, { filename: 'a.png', contentType: 'image/png' });

    expect(res.status).toBe(201);
    expect(res.body.data.checksum).toEqual({
      algorithm: 'sha256',
      hex: createHash('sha256').update(content).digest('hex'),
    });
  });

  it('returns 401 without a token', async () => {
    const res = await request(app).post('/v1/uploads');
    expect(res.status).toBe(401);
  });
});
