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

  it('returns 401 without a token', async () => {
    const res = await request(app).post('/v1/uploads');
    expect(res.status).toBe(401);
  });
});
