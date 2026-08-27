import { Readable } from 'node:stream';
import { once } from 'node:events';
import { createServer, request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { createApp } from '@/app';
import { resetRateLimiters } from '@/middleware/rate-limit.middleware';
import { usersCache } from '@/users/users.controller';
import type { IngestSummary } from '@/ingest/ingest.types';

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
  poolQueryable: {
    query: (...args: unknown[]) => mockQuery(...args),
    queryOne: (...args: unknown[]) => mockQueryOne(...args),
    queryCount: (...args: unknown[]) => mockQueryCount(...args),
  },
}));

const app = createApp();

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

/**
 * Answers every `INSERT ... RETURNING *` with one row per tuple it was sent.
 *
 * The tuple count is read from the statement rather than assumed, because
 * `writeUserImportBatch` groups rows by shape: a file whose `roles` cell is
 * blank on some rows produces one statement of two columns and another of one,
 * and a mock that divided the parameters by a fixed column count would report
 * the wrong number of writes for exactly the file that exercises the grouping.
 */
function insertsEverything(): void {
  mockQuery.mockImplementation((sql: string, values: unknown[] = []) => {
    const firstTuple = /VALUES (\([^)]*\))/.exec(sql)?.[1] ?? '($1)';
    const columns = (firstTuple.match(/\$/g) ?? ['$']).length;
    return Promise.resolve(
      Array.from({ length: values.length / columns }, (_, i) => ({ id: `id-${String(i)}` })),
    );
  });
}

function post(token: string): request.Test {
  return request(app)
    .post('/v1/users/import')
    .set('Authorization', `Bearer ${token}`)
    .set('Content-Type', 'text/csv');
}

const summaryOf = (body: { data: IngestSummary }): IngestSummary => body.data;

beforeEach(async () => {
  mockQuery.mockReset();
  mockQueryOne.mockReset();
  mockQueryCount.mockReset();
  await resetRateLimiters();
  await usersCache.clear();
});

describe('POST /v1/users/import', () => {
  it('imports a CSV body and reports what it did', async () => {
    insertsEverything();
    const token = await getAdminToken();

    const res = await post(token).send('email,roles\na@x.test,"admin,auditor"\nb@x.test,\n');

    expect(res.status).toBe(200);
    expect(summaryOf(res.body as { data: IngestSummary })).toEqual({
      recordsRead: 2,
      accepted: 2,
      written: 2,
      rejected: 0,
      errors: [],
      errorsTruncated: false,
    });
    expect(res.body.error).toBeNull();
  });

  it('reads a quoted roles list as multiple roles', async () => {
    insertsEverything();
    const token = await getAdminToken();

    await post(token).send('email,roles\na@x.test,"admin,auditor"\n');

    const values = (mockQuery.mock.calls[0] as [string, unknown[]])[1];
    expect(values).toEqual(['a@x.test', ['admin', 'auditor']]);
  });

  it('lower-cases addresses and de-duplicates before writing', async () => {
    insertsEverything();
    const token = await getAdminToken();

    await post(token).send('email\nA@X.test\na@x.test\n');

    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect((mockQuery.mock.calls[0] as [string, unknown[]])[1]).toEqual(['a@x.test']);
  });

  it('answers 200 with the rejected rows described, not 4xx, for a partly bad file', async () => {
    // A row-level failure is data about the upload, not a failure of the
    // request: some rows were imported and the client needs to know which were
    // not.
    insertsEverything();
    const token = await getAdminToken();

    const res = await post(token).send('email\na@x.test\nnot-an-email\nc@x.test\n');

    expect(res.status).toBe(200);
    const summary = summaryOf(res.body as { data: IngestSummary });
    expect(summary.written).toBe(2);
    expect(summary.rejected).toBe(1);
    expect(summary.errors).toEqual([
      { line: 3, column: 'email', message: 'email must be a valid address' },
    ]);
  });

  it('answers 400 for a header it cannot bind', async () => {
    const token = await getAdminToken();

    const res = await post(token).send('email,nickname\na@x.test,al\n');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CSV_HEADER_INVALID');
    expect(res.body.error.message).toContain('nickname');
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('answers 400 for a malformed document, naming the line', async () => {
    const token = await getAdminToken();

    const res = await post(token).send('email\n"unterminated\n');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('CSV_UNTERMINATED_QUOTE');
    expect(res.body.error.message).toMatch(/line \d+/);
  });

  it('answers 415 for a JSON body', async () => {
    const token = await getAdminToken();

    const res = await request(app)
      .post('/v1/users/import')
      .set('Authorization', `Bearer ${token}`)
      .send({ email: 'a@x.test' });

    expect(res.status).toBe(415);
    expect(res.body.error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
  });

  it('answers 415 for a compressed body', async () => {
    const token = await getAdminToken();

    const res = await post(token).set('Content-Encoding', 'gzip').send('email\na@x.test\n');

    expect(res.status).toBe(415);
    expect(res.body.error.code).toBe('UNSUPPORTED_CONTENT_ENCODING');
  });

  it('answers 413 when the declared length is over the limit', async () => {
    const token = await getAdminToken();

    const res = await post(token)
      .set('Content-Length', String(64 * 1024 * 1024))
      .send('email\na@x.test\n');

    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('answers 403 for a non-admin token', async () => {
    const token = await getUserToken();

    const res = await post(token).send('email\na@x.test\n');

    expect(res.status).toBe(403);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('answers 401 without a token', async () => {
    const res = await request(app)
      .post('/v1/users/import')
      .set('Content-Type', 'text/csv')
      .send('email\na@x.test\n');

    expect(res.status).toBe(401);
  });

  it('is routed to the import handler and not to /:id', async () => {
    // `/import` is a perfectly good `:id`; the route order in `users.router.ts`
    // is what keeps this from reaching the wrong handler.
    insertsEverything();
    const token = await getAdminToken();

    const res = await post(token).send('email\na@x.test\n');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty('recordsRead');
  });

  it('surfaces a database failure as a 500 rather than a partial success body', async () => {
    mockQuery.mockRejectedValue(new Error('connection terminated unexpectedly'));
    const token = await getAdminToken();

    const res = await post(token).send('email\na@x.test\n');

    expect(res.status).toBe(500);
    expect(res.body.data).toBeNull();
  });

  it('reads a chunked body, which declares no Content-Length at all', async () => {
    // The shape a client streaming a large export actually produces, and the
    // one the `Content-Length` fast path cannot see — so this is the case where
    // `limitBytes` is the only thing bounding the upload. Sent through
    // `node:http` rather than supertest, because supertest buffers `.send()`
    // and sets a length.
    insertsEverything();
    const token = await getAdminToken();
    const server = createServer(app).listen(0);
    await once(server, 'listening');
    const { port } = server.address() as AddressInfo;

    try {
      const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = httpRequest(
          {
            port,
            method: 'POST',
            path: '/v1/users/import',
            headers: { 'content-type': 'text/csv', authorization: `Bearer ${token}` },
          },
          (response) => {
            let body = '';
            response.setEncoding('utf8');
            response.on('data', (chunk: string) => (body += chunk));
            response.on('end', () => {
              resolve({ status: response.statusCode ?? 0, body });
            });
          },
        );
        req.on('error', reject);
        // No `Content-Length` was set, so Node frames this as chunked.
        Readable.from(['email\n', 'a@x.test\n', 'b@x.test\n']).pipe(req);
      });

      expect(res.status).toBe(200);
      const parsed = JSON.parse(res.body) as { data: IngestSummary };
      expect(parsed.data.written).toBe(2);
      expect(parsed.data.recordsRead).toBe(2);
    } finally {
      server.close();
      await once(server, 'close');
    }
  });
});
