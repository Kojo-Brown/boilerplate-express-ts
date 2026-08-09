import express from 'express';
import request from 'supertest';
import { AppError } from '@/lib/errors';
import { errorMiddleware } from '@/middleware/error.middleware';
import { MemoryCacheStore } from '@/lib/route-decorators/cache-store';
import { toRequestHandler } from '@/lib/route-decorators/to-request-handler';
import type { RouteOperation } from '@/lib/route-decorators/types';
import { withCache } from '@/lib/route-decorators/with-cache';
import { withRetry } from '@/lib/route-decorators/with-retry';
import { withTimeout } from '@/lib/route-decorators/with-timeout';

/** Minimal app: one route, plus the real error middleware behind it. */
function appWith(
  handler: express.RequestHandler,
  method: 'get' | 'post' = 'get',
): express.Application {
  const app = express();
  app.use(express.json());
  app[method]('/thing/:id', handler);
  app.use(errorMiddleware);
  return app;
}

describe('toRequestHandler', () => {
  it('wraps the result in the { data, meta, error } envelope', async () => {
    const app = appWith(toRequestHandler(async () => ({ id: 'x' })));

    const res = await request(app).get('/thing/x');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: { id: 'x' }, meta: null, error: null });
  });

  it('honours a configured status', async () => {
    const app = appWith(toRequestHandler(async () => ({ id: 'x' }), { status: 201 }), 'post');

    const res = await request(app).post('/thing/x');

    expect(res.status).toBe(201);
    expect(res.body.data).toEqual({ id: 'x' });
  });

  it('sends no body for 204', async () => {
    const app = appWith(toRequestHandler(async () => undefined, { status: 204 }));

    const res = await request(app).get('/thing/x');

    expect(res.status).toBe(204);
    expect(res.text).toBe('');
  });

  it('honours a custom sender', async () => {
    const app = appWith(
      toRequestHandler(async () => 'plain', {
        send: (res, result) => {
          res.status(200).type('text/plain').send(result);
        },
      }),
    );

    const res = await request(app).get('/thing/x');

    expect(res.text).toBe('plain');
  });

  it('routes an AppError to the translator chain instead of a hand-rolled status', async () => {
    const app = appWith(
      toRequestHandler(async () => {
        throw new AppError(404, 'Thing not found', 'NOT_FOUND');
      }),
    );

    const res = await request(app).get('/thing/x');

    expect(res.status).toBe(404);
    expect(res.body.error).toEqual({ code: 'NOT_FOUND', message: 'Thing not found' });
  });

  it('lets an unrecognised throw reach the 500 fallback', async () => {
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const app = appWith(
      toRequestHandler(async () => {
        throw new Error('kaboom');
      }),
    );

    const res = await request(app).get('/thing/x');

    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL_ERROR');
    // The raw message is logged, never serialised.
    expect(res.body.error.message).not.toContain('kaboom');
    consoleSpy.mockRestore();
  });

  it('exposes the typed params the operation was authored against', async () => {
    const operation: RouteOperation<{ id: string }, express.Request<{ id: string }>> = async (
      req,
    ) => ({ id: req.params.id });
    const app = appWith(toRequestHandler(operation));

    const res = await request(app).get('/thing/abc');

    expect(res.body.data).toEqual({ id: 'abc' });
  });

  it('emits what the decorators recorded as the envelope meta', async () => {
    const flaky = jest
      .fn<Promise<string>, []>()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValue('ok');

    const app = appWith(
      toRequestHandler(
        withCache(withRetry(flaky, { attempts: 3, baseDelayMs: 1 }), {
          ttlMs: 10_000,
          namespace: 'thing',
        }),
      ),
    );

    const res = await request(app).get('/thing/x');

    expect(res.body).toEqual({ data: 'ok', meta: { cache: 'miss', attempts: 2 }, error: null });
  });

  it('gives the operation a signal that is not yet aborted', async () => {
    let aborted: boolean | undefined;
    const app = appWith(
      toRequestHandler(async (_req, ctx) => {
        aborted = ctx.signal.aborted;
        return 'ok';
      }),
    );

    await request(app).get('/thing/x');

    expect(aborted).toBe(false);
  });

  it('does not abort the signal on a response that completed normally', async () => {
    let signal: AbortSignal | undefined;
    const app = appWith(
      toRequestHandler(async (_req, ctx) => {
        signal = ctx.signal;
        return 'ok';
      }),
    );

    await request(app).get('/thing/x');
    await new Promise((resolve) => setImmediate(resolve));

    expect(signal?.aborted).toBe(false);
  });
});

describe('decorator composition over the wire', () => {
  it('serves a second identical request from cache without re-querying', async () => {
    const store = new MemoryCacheStore();
    const op = jest.fn(async () => ({ hits: 1 }));

    const app = appWith(
      toRequestHandler(
        withCache(withRetry(withTimeout(op, { ms: 1_000 }), { attempts: 3, baseDelayMs: 1 }), {
          ttlMs: 10_000,
          namespace: 'thing',
          store,
        }),
      ),
    );

    const first = await request(app).get('/thing/x');
    const second = await request(app).get('/thing/x');

    expect(first.body.meta).toEqual({ cache: 'miss' });
    expect(second.body.meta).toEqual({ cache: 'hit' });
    expect(op).toHaveBeenCalledTimes(1);
  });

  it('gives each retry attempt its own deadline when the timeout is innermost', async () => {
    jest.useFakeTimers();
    try {
      const op = jest.fn(
        async () =>
          new Promise<string>((resolve) => {
            setTimeout(() => resolve('slow'), 50);
          }),
      );

      const decorated = withRetry(withTimeout(op, { ms: 10 }), {
        attempts: 3,
        sleep: () => Promise.resolve(),
      });

      const settled = decorated({ method: 'GET', originalUrl: '/x' } as express.Request, {
        signal: new AbortController().signal,
        attempt: 1,
        meta: {},
      }).catch((err: unknown) => err);

      await jest.advanceTimersByTimeAsync(200);
      const err = await settled;

      // Three separate 10ms deadlines, not one shared 10ms budget.
      expect(op).toHaveBeenCalledTimes(3);
      expect(err).toMatchObject({ statusCode: 504, code: 'TIMEOUT' });
    } finally {
      jest.useRealTimers();
    }
  });

  it('spends one shared deadline across all attempts when the timeout is outermost', async () => {
    jest.useFakeTimers();
    try {
      const op = jest.fn(
        async () =>
          new Promise<string>((_resolve, reject) => {
            setTimeout(() => reject(new Error('ECONNRESET')), 20);
          }),
      );

      const decorated = withTimeout(
        withRetry(op, { attempts: 10, sleep: () => Promise.resolve() }),
        { ms: 50 },
      );

      const settled = decorated({ method: 'GET', originalUrl: '/x' } as express.Request, {
        signal: new AbortController().signal,
        attempt: 1,
        meta: {},
      }).catch((err: unknown) => err);

      await jest.advanceTimersByTimeAsync(200);
      const err = await settled;

      expect(err).toMatchObject({ statusCode: 504, code: 'TIMEOUT' });
      // 50ms of budget at 20ms per attempt: three starts, not ten.
      expect(op).toHaveBeenCalledTimes(3);
    } finally {
      jest.useRealTimers();
    }
  });
});
