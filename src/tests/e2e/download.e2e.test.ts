import { createHash } from 'node:crypto';
import request from 'supertest';
import { createApp } from '@/app';
import { resetRateLimiters } from '@/middleware/rate-limit.middleware';
import { createMemoryStorageProvider } from '@/upload/storage/memory.provider';
import type { MemoryStorageProvider } from '@/upload/storage/memory.provider';

// env vars are set in jest.setup.ts

jest.mock('@/lib/password', () => ({
  verifyPassword: jest.fn(async (plain: string, _hash: string) => plain === 'password'),
  hashPassword: jest.fn(async (plain: string) => `argon2id-mock:${plain}`),
}));

/**
 * The whole route, from `Authorization` to bytes on a socket, against the
 * in-process driver.
 *
 * The driver is substituted rather than `STORAGE_DRIVER` being set, because
 * `env` is parsed and frozen at import time and this file's imports are hoisted
 * above any assignment it could make. Swapping the provider is the same seam the
 * config setting turns — `getStorageProvider` is the only way any handler
 * reaches a backend — and it lets the same store be *asserted against*
 * afterwards, which reading through the route could not do.
 */
let storage: MemoryStorageProvider;

jest.mock('@/upload/storage', () => {
  const actual = jest.requireActual<typeof import('@/upload/storage')>('@/upload/storage');
  return {
    ...actual,
    getStorageProvider: (): MemoryStorageProvider => storage,
  };
});

const app = createApp();

const PDF = Buffer.from(
  Array.from({ length: 300 * 1024 }, (_, i) => i % 251),
);
const PDF_ETAG = `"${createHash('sha256').update(PDF).digest('hex')}"`;

async function getToken(): Promise<string> {
  const res = await request(app)
    .post('/v1/auth/login')
    .send({ email: 'user@example.com', password: 'password' });
  return (res.body.data as { accessToken: string }).accessToken;
}

/** Stores an object directly and returns the id the route addresses it by. */
async function store(bytes: Buffer, name = 'report.pdf', type = 'application/pdf'): Promise<string> {
  const { key } = await storage.put(bytes, name, type);
  return key.slice('uploads/'.length);
}

let token: string;

beforeEach(async () => {
  storage = createMemoryStorageProvider();
  await resetRateLimiters();
  token = await getToken();
});

describe('GET /v1/uploads/:objectId', () => {
  it('streams the whole object, byte for byte', async () => {
    const objectId = await store(PDF);

    const res = await request(app)
      .get(`/v1/uploads/${objectId}`)
      .set('Authorization', `Bearer ${token}`)
      .buffer()
      .parse((response, callback) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => callback(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-length']).toBe(String(PDF.length));
    expect(res.headers['etag']).toBe(PDF_ETAG);
    expect(res.headers['accept-ranges']).toBe('bytes');
    // The object is 300 KiB and the provider hands it out in 64 KiB chunks, so
    // this only passes if every chunk arrived and arrived in order.
    expect(Buffer.compare(res.body as Buffer, PDF)).toBe(0);
  });

  it('advertises an immutable, private cache policy', async () => {
    const objectId = await store(Buffer.from('x'), 'a.png', 'image/png');

    await request(app)
      .get(`/v1/uploads/${objectId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect('Cache-Control', 'private, max-age=31536000, immutable');
  });

  it('serves a range, and the bytes are the ones at that offset', async () => {
    const objectId = await store(PDF);

    const res = await request(app)
      .get(`/v1/uploads/${objectId}`)
      .set('Range', 'bytes=100000-100099')
      .set('Authorization', `Bearer ${token}`)
      .buffer()
      .parse((response, callback) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => callback(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(206);
    expect(res.headers['content-range']).toBe(`bytes 100000-100099/${PDF.length}`);
    expect(res.headers['content-length']).toBe('100');
    expect(Buffer.compare(res.body as Buffer, PDF.subarray(100000, 100100))).toBe(0);
  });

  it('reassembles a whole object from sequential ranges, which is what resuming is', async () => {
    const objectId = await store(PDF);
    const parts: Buffer[] = [];
    const CHUNK = 100 * 1024;

    for (let start = 0; start < PDF.length; start += CHUNK) {
      const end = Math.min(start + CHUNK - 1, PDF.length - 1);
      const res = await request(app)
        .get(`/v1/uploads/${objectId}`)
        .set('Range', `bytes=${start}-${end}`)
        // The resume contract: every leg is conditional on the representation
        // not having moved under it.
        .set('If-Range', PDF_ETAG)
        .set('Authorization', `Bearer ${token}`)
        .buffer()
        .parse((response, callback) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.on('end', () => callback(null, Buffer.concat(chunks)));
        });

      expect(res.status).toBe(206);
      parts.push(res.body as Buffer);
    }

    expect(Buffer.compare(Buffer.concat(parts), PDF)).toBe(0);
  });

  it('refuses a range past the end with 416 and the real length', async () => {
    const objectId = await store(PDF);

    const res = await request(app)
      .get(`/v1/uploads/${objectId}`)
      .set('Range', `bytes=${PDF.length}-`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(416);
    expect(res.headers['content-range']).toBe(`bytes */${PDF.length}`);
    expect(res.body.error.code).toBe('RANGE_NOT_SATISFIABLE');
  });

  it('answers 304 to a client that already has the current bytes', async () => {
    const objectId = await store(PDF);

    const first = await request(app)
      .get(`/v1/uploads/${objectId}`)
      .set('Authorization', `Bearer ${token}`);

    const second = await request(app)
      .get(`/v1/uploads/${objectId}`)
      .set('If-None-Match', first.headers['etag'] ?? '')
      .set('Authorization', `Bearer ${token}`);

    expect(second.status).toBe(304);
    expect(second.headers['content-length']).toBeUndefined();
  });

  it('sends the whole object when a resumed range names a representation that is gone', async () => {
    const objectId = await store(PDF);

    const res = await request(app)
      .get(`/v1/uploads/${objectId}`)
      .set('If-Range', '"a-tag-from-a-previous-upload"')
      .set('Range', 'bytes=100000-100099')
      .set('Authorization', `Bearer ${token}`);

    // 200, not 412: the client can restart, and this is how it is told to.
    expect(res.status).toBe(200);
    expect(res.headers['content-length']).toBe(String(PDF.length));
  });

  it('sizes a download without transferring it', async () => {
    const objectId = await store(PDF);

    const res = await request(app)
      .head(`/v1/uploads/${objectId}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.headers['content-length']).toBe(String(PDF.length));
    expect(res.headers['accept-ranges']).toBe('bytes');
  });

  it('returns 404 for a well-formed id with nothing stored under it', async () => {
    const res = await request(app)
      .get('/v1/uploads/3f2504e0-4f89-41d3-9a0c-0305e82c3301.pdf')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('OBJECT_NOT_FOUND');
  });

  it('rejects an id that is not one this service mints', async () => {
    const res = await request(app)
      .get('/v1/uploads/not-an-object-id')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('cannot be talked out of its own key prefix', async () => {
    // Percent-encoded so the router sees one path segment; the schema is what
    // rejects it, not the router.
    const res = await request(app)
      .get('/v1/uploads/..%2F..%2Fetc%2Fpasswd')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(422);
  });

  it('requires a token', async () => {
    const objectId = await store(PDF);

    const res = await request(app).get(`/v1/uploads/${objectId}`);

    expect(res.status).toBe(401);
  });

  it('does not shadow the presign route it shares a mount with', async () => {
    const res = await request(app)
      .post('/v1/uploads/presign')
      .set('Authorization', `Bearer ${token}`)
      .send({ fileName: 'photo.png', contentType: 'image/png', size: 2048 });

    expect(res.status).toBe(200);
    expect(res.body.data.key).toMatch(/^uploads\//);
  });
});

describe('upload then download', () => {
  it('returns exactly the bytes POST /v1/uploads stored, under the key it handed back', async () => {
    const content = Buffer.from('fake-png-bytes');

    const uploaded = await request(app)
      .post('/v1/uploads')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', content, { filename: 'a.png', contentType: 'image/png' });

    expect(uploaded.status).toBe(201);
    const objectId = (uploaded.body.data.key as string).slice('uploads/'.length);

    const res = await request(app)
      .get(`/v1/uploads/${objectId}`)
      .set('Authorization', `Bearer ${token}`)
      .buffer()
      .parse((response, callback) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => callback(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(Buffer.compare(res.body as Buffer, content)).toBe(0);
    // The upload's own checksum and the download's ETag are the same digest of
    // the same bytes, computed by two code paths that never talk to each other.
    expect(res.headers['etag']).toBe(`"${uploaded.body.data.checksum.hex as string}"`);
  });
});
