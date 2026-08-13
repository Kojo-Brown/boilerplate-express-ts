import express from 'express';
import type { Request } from 'express';
import request from 'supertest';
import type { IdempotencyOptions } from '@/idempotency/idempotency.middleware';
import {
  defaultIsReplayable,
  IDEMPOTENCY_REPLAYED_HEADER,
  idempotent,
} from '@/idempotency/idempotency.middleware';
import type { IdempotencyStore } from '@/idempotency/idempotency.types';
import { MemoryIdempotencyStore } from '@/idempotency/memory.store';
import { AppError } from '@/lib/errors';
import type { Authenticated } from '@/lib/pipeline';
import { compose } from '@/lib/pipeline';
import type { RouteOperation } from '@/lib/route-decorators';
import { errorMiddleware } from '@/middleware/error.middleware';

type AuthedRequest = Authenticated<Request>;

/** Stands in for `authenticate`, so the scope has a principal to key on. */
function authenticateAs(userId: string) {
  return <TReq extends Request>(req: TReq): Authenticated<TReq> => {
    req.auth = { userId, roles: ['admin'], type: 'access' };
    return req as Authenticated<TReq>;
  };
}

/**
 * A route wired exactly as `users.router.ts` wires the real one: the step runs
 * inside the pipeline, behind authentication, with the real error middleware
 * and a real `res` underneath. The response capture rewrites `res.json` and
 * `res.end`, so a hand-rolled response double would be testing the double.
 */
function appWith(
  operation: RouteOperation<unknown, AuthedRequest>,
  options: IdempotencyOptions,
  routeOptions: { status?: number; userId?: string } = {},
): express.Application {
  const { status = 201, userId = 'user-1' } = routeOptions;
  const app = express();
  app.use(express.json());
  app.post(
    '/things',
    compose().use(authenticateAs(userId)).use(idempotent(options)).handle(operation, { status }),
  );
  app.use(errorMiddleware);
  return app;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

let store: MemoryIdempotencyStore;

beforeEach(() => {
  store = new MemoryIdempotencyStore();
});

describe('idempotent: recording and replay', () => {
  it('runs the operation once and replays the recorded response', async () => {
    const operation = jest.fn(async () => ({ id: 'thing-1' }));
    const app = appWith(operation, { store });

    const first = await request(app)
      .post('/things')
      .set('Idempotency-Key', 'key-1')
      .send({ name: 'a' });
    const second = await request(app)
      .post('/things')
      .set('Idempotency-Key', 'key-1')
      .send({ name: 'a' });

    expect(operation).toHaveBeenCalledTimes(1);
    expect(second.status).toBe(first.status);
    expect(second.body).toEqual(first.body);
    expect(first.headers[IDEMPOTENCY_REPLAYED_HEADER.toLowerCase()]).toBeUndefined();
    expect(second.headers[IDEMPOTENCY_REPLAYED_HEADER.toLowerCase()]).toBe('true');
  });

  it('replays the response as it was serialised, not as the value behind it', async () => {
    // The reason this is recorded at the response boundary rather than as a
    // `RouteOperation` decorator: what the client received is a string, and a
    // store typed by the operation's return value would have to claim it could
    // give back a `Date`.
    const createdAt = new Date('2026-01-02T03:04:05.000Z');
    const app = appWith(async () => ({ id: 'thing-1', createdAt }), { store });

    const first = await request(app).post('/things').set('Idempotency-Key', 'key-1').send({});
    const second = await request(app).post('/things').set('Idempotency-Key', 'key-1').send({});

    expect(first.body.data.createdAt).toBe('2026-01-02T03:04:05.000Z');
    expect(second.text).toBe(first.text);
  });

  it('replays a body-less response as body-less', async () => {
    const operation = jest.fn(async () => undefined);
    const app = appWith(operation, { store }, { status: 204 });

    const first = await request(app).post('/things').set('Idempotency-Key', 'key-1').send({});
    const second = await request(app).post('/things').set('Idempotency-Key', 'key-1').send({});

    expect(first.status).toBe(204);
    expect(second.status).toBe(204);
    expect(second.text).toBe('');
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('does not let one principal replay another principal response', async () => {
    const operation = jest.fn(async () => ({ id: 'thing-1' }));
    const mine = appWith(operation, { store }, { userId: 'user-1' });
    const theirs = appWith(operation, { store }, { userId: 'user-2' });

    await request(mine).post('/things').set('Idempotency-Key', 'shared').send({});
    const other = await request(theirs).post('/things').set('Idempotency-Key', 'shared').send({});

    expect(operation).toHaveBeenCalledTimes(2);
    expect(other.headers[IDEMPOTENCY_REPLAYED_HEADER.toLowerCase()]).toBeUndefined();
  });

  it('records the response before the client is answered', async () => {
    const recorded = deferred<void>();
    const slowStore: IdempotencyStore = {
      claim: (claimRequest) => store.claim(claimRequest),
      complete: async (claim, response) => {
        await recorded.promise;
        return store.complete(claim, response);
      },
      release: (claim) => store.release(claim),
      purgeExpired: () => store.purgeExpired(),
    };
    const app = appWith(async () => ({ id: 'thing-1' }), { store: slowStore });

    let answered = false;
    const inFlight = request(app)
      .post('/things')
      .set('Idempotency-Key', 'key-1')
      .send({})
      .then((res) => {
        answered = true;
        return res;
      });

    // A client that never receives the response is the one that retries, so a
    // record written on `finish` would be written too late to help it.
    await new Promise((resolve) => setImmediate(resolve));
    try {
      expect(answered).toBe(false);
    } finally {
      recorded.resolve();
    }

    await expect(inFlight).resolves.toMatchObject({ status: 201 });
  });

  it('still answers when the store cannot record the response', async () => {
    const warn = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const brokenStore: IdempotencyStore = {
      claim: (claimRequest) => store.claim(claimRequest),
      complete: () => Promise.reject(new Error('store is down')),
      release: (claim) => store.release(claim),
      purgeExpired: () => store.purgeExpired(),
    };
    const app = appWith(async () => ({ id: 'thing-1' }), { store: brokenStore });

    // The write already happened. Reporting a 500 because the bookkeeping
    // failed would tell the caller its request failed when it did not.
    const res = await request(app).post('/things').set('Idempotency-Key', 'key-1').send({});

    expect(res.status).toBe(201);
    expect(res.body.data).toEqual({ id: 'thing-1' });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('idempotent: the key itself', () => {
  it('rejects a request with no key', async () => {
    const operation = jest.fn(async () => ({ id: 'thing-1' }));
    const app = appWith(operation, { store });

    const res = await request(app).post('/things').send({});

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    expect(operation).not.toHaveBeenCalled();
  });

  it('lets an unkeyed request through when the key is optional', async () => {
    const operation = jest.fn(async () => ({ id: 'thing-1' }));
    const app = appWith(operation, { store, required: false });

    const first = await request(app).post('/things').send({});
    const second = await request(app).post('/things').send({});

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    // No key, no guarantee — and nothing recorded that a later keyed request
    // could collide with.
    expect(operation).toHaveBeenCalledTimes(2);
    expect(store.size).toBe(0);
  });

  it.each([
    ['a key with a space', 'key with space'],
    ['a key with a tab', 'key\tvalue'],
    ['an over-long key', 'k'.repeat(256)],
  ])('rejects %s rather than normalising it', async (_name, key) => {
    const operation = jest.fn(async () => ({ id: 'thing-1' }));
    const app = appWith(operation, { store });

    const res = await request(app).post('/things').set('Idempotency-Key', key).send({});

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_INVALID');
    expect(operation).not.toHaveBeenCalled();
  });

  it('accepts a key at the length limit', async () => {
    const app = appWith(async () => ({ id: 'thing-1' }), { store });

    const res = await request(app)
      .post('/things')
      .set('Idempotency-Key', 'k'.repeat(255))
      .send({});

    expect(res.status).toBe(201);
  });

  it('rejects a reused key carrying a different body', async () => {
    const operation = jest.fn(async () => ({ id: 'thing-1' }));
    const app = appWith(operation, { store });

    await request(app).post('/things').set('Idempotency-Key', 'key-1').send({ name: 'a' });
    const res = await request(app)
      .post('/things')
      .set('Idempotency-Key', 'key-1')
      .send({ name: 'b' });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('treats a body whose keys were reordered as the same request', async () => {
    const operation = jest.fn(async () => ({ id: 'thing-1' }));
    const app = appWith(operation, { store });

    await request(app).post('/things').set('Idempotency-Key', 'key-1').send({ a: 1, b: 2 });
    const res = await request(app)
      .post('/things')
      .set('Idempotency-Key', 'key-1')
      .send({ b: 2, a: 1 });

    expect(res.status).toBe(201);
    expect(res.headers[IDEMPOTENCY_REPLAYED_HEADER.toLowerCase()]).toBe('true');
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('answers 409 with a Retry-After while the first request is still running', async () => {
    const started = deferred<void>();
    const finish = deferred<void>();
    const operation = jest.fn(async () => {
      started.resolve();
      await finish.promise;
      return { id: 'thing-1' };
    });
    const app = appWith(operation, { store });

    // `.then` is what dispatches a supertest request, and the first one has to
    // be *inside* the operation before the second arrives, or this asserts
    // nothing.
    const first = request(app)
      .post('/things')
      .set('Idempotency-Key', 'key-1')
      .send({})
      .then((res) => res);
    await started.promise;

    try {
      const second = await request(app).post('/things').set('Idempotency-Key', 'key-1').send({});

      expect(second.status).toBe(409);
      expect(second.body.error.code).toBe('IDEMPOTENCY_KEY_IN_PROGRESS');
      expect(second.headers['retry-after']).toBe('1');
    } finally {
      // Even on a failed expectation: an unresolved operation leaves the first
      // request's socket open and hangs the whole run rather than this test.
      finish.resolve();
      await first;
    }

    await expect(first).resolves.toMatchObject({ status: 201 });
    expect(operation).toHaveBeenCalledTimes(1);
  });
});

describe('idempotent: which responses are recorded', () => {
  it('records a deterministic 4xx and replays it', async () => {
    const operation = jest.fn(async () => {
      throw new AppError(409, 'That email is taken', 'UNIQUE_VIOLATION');
    });
    const app = appWith(operation, { store });

    const first = await request(app).post('/things').set('Idempotency-Key', 'key-1').send({});
    const second = await request(app).post('/things').set('Idempotency-Key', 'key-1').send({});

    expect(first.status).toBe(409);
    expect(second.status).toBe(409);
    expect(second.body).toEqual(first.body);
    expect(second.headers[IDEMPOTENCY_REPLAYED_HEADER.toLowerCase()]).toBe('true');
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('releases the key on a 5xx so the retry can take it', async () => {
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    let attempt = 0;
    const operation = jest.fn(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error('upstream fell over');
      return { id: 'thing-1' };
    });
    const app = appWith(operation, { store });

    const first = await request(app).post('/things').set('Idempotency-Key', 'key-1').send({});
    const second = await request(app).post('/things').set('Idempotency-Key', 'key-1').send({});

    expect(first.status).toBe(500);
    expect(second.status).toBe(201);
    expect(operation).toHaveBeenCalledTimes(2);
    expect(store.size).toBe(1);
    error.mockRestore();
  });

  it('does not freeze a 429 into the retention window', async () => {
    const operation = jest.fn(async () => {
      throw new AppError(429, 'Slow down', 'RATE_LIMITED');
    });
    const app = appWith(operation, { store });

    const first = await request(app).post('/things').set('Idempotency-Key', 'key-1').send({});
    const second = await request(app).post('/things').set('Idempotency-Key', 'key-1').send({});

    expect(first.status).toBe(429);
    // Replaying it would keep answering 429 long after the limiter relented.
    expect(second.headers[IDEMPOTENCY_REPLAYED_HEADER.toLowerCase()]).toBeUndefined();
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('honours a caller-supplied replayability rule', async () => {
    const operation = jest.fn(async () => {
      throw new AppError(404, 'No such thing', 'NOT_FOUND');
    });
    const app = appWith(operation, { store, isReplayable: (status) => status < 400 });

    await request(app).post('/things').set('Idempotency-Key', 'key-1').send({});
    const second = await request(app).post('/things').set('Idempotency-Key', 'key-1').send({});

    expect(second.headers[IDEMPOTENCY_REPLAYED_HEADER.toLowerCase()]).toBeUndefined();
    expect(operation).toHaveBeenCalledTimes(2);
  });
});

describe('defaultIsReplayable', () => {
  it.each([200, 201, 204, 301, 400, 404, 409, 422, 499])('records %d', (status) => {
    expect(defaultIsReplayable(status)).toBe(true);
  });

  it.each([408, 425, 429, 500, 502, 503, 504])('refuses %d', (status) => {
    expect(defaultIsReplayable(status)).toBe(false);
  });
});
