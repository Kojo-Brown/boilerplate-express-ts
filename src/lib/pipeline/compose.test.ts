import type { Request } from 'express';
import express from 'express';
import request from 'supertest';
import { z } from 'zod';
import { AppError } from '@/lib/errors';
import { errorMiddleware } from '@/middleware/error.middleware';
import { compose } from '@/lib/pipeline/compose';
import type { PipelineStep } from '@/lib/pipeline/types';
import { MemoryCacheStore, withCache } from '@/lib/route-decorators';
import { validateParams } from '@/middleware/validate.middleware';
import { requireRoles } from '@/middleware/auth.middleware';

/** One route, the real error middleware behind it. */
function appWith(
  handler: express.RequestHandler,
  method: 'get' | 'post' = 'get',
  path = '/thing/:id',
): express.Application {
  const app = express();
  app.use(express.json());
  app[method](path, handler);
  app.use(errorMiddleware);
  return app;
}

/** A step that records that it ran and refines nothing. */
function tracer<TReq extends Request>(log: string[], name: string): PipelineStep<TReq, TReq> {
  return (req) => {
    log.push(name);
    return req;
  };
}

describe('compose', () => {
  it('runs steps in declaration order before the operation', async () => {
    const log: string[] = [];
    const handler = compose()
      .use(tracer(log, 'first'))
      .use(tracer(log, 'second'))
      .handle(async () => {
        log.push('operation');
        return 'done';
      });

    await request(appWith(handler)).get('/thing/x');

    expect(log).toEqual(['first', 'second', 'operation']);
  });

  it('awaits an async step before running the next one', async () => {
    const log: string[] = [];
    const slow: PipelineStep<Request, Request> = async (req) => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      log.push('slow');
      return req;
    };

    const handler = compose()
      .use(slow)
      .use(tracer(log, 'after'))
      .handle(async () => {
        log.push('operation');
        return null;
      });

    await request(appWith(handler)).get('/thing/x');

    expect(log).toEqual(['slow', 'after', 'operation']);
  });

  it('hands the operation the request a step refined', async () => {
    const handler = compose()
      .use(validateParams(z.object({ id: z.coerce.number() })))
      .handle(async (req) => ({ id: req.params.id, type: typeof req.params.id }));

    const res = await request(appWith(handler)).get('/thing/42');

    // Zod coerced it, and the operation received the coerced value rather than
    // the string Express matched.
    expect(res.body.data).toEqual({ id: 42, type: 'number' });
  });

  it('carries a request object a step replaced rather than mutated', async () => {
    const swap: PipelineStep<Request, Request> = (req) =>
      Object.create(req, { marker: { value: 'swapped', enumerable: true } }) as Request;

    const handler = compose()
      .use(swap)
      .handle(async (req) => (req as Request & { marker?: string }).marker);

    const res = await request(appWith(handler)).get('/thing/x');

    expect(res.body.data).toBe('swapped');
  });

  it('routes a step failure to the translator chain and never runs the operation', async () => {
    const operation = jest.fn();
    const handler = compose()
      .use(() => {
        throw new AppError(401, 'Nope', 'UNAUTHORIZED');
      })
      .handle(operation);

    const res = await request(appWith(handler)).get('/thing/x');

    expect(res.status).toBe(401);
    expect(res.body.error).toEqual({ code: 'UNAUTHORIZED', message: 'Nope' });
    expect(operation).not.toHaveBeenCalled();
  });

  it('routes a rejected async step the same way', async () => {
    const handler = compose()
      .use(async () => {
        await Promise.resolve();
        throw new AppError(409, 'Conflict', 'CONFLICT');
      })
      .handle(async () => 'unreachable');

    const res = await request(appWith(handler)).get('/thing/x');

    expect(res.status).toBe(409);
  });

  it('stops when a step answers the request itself', async () => {
    const operation = jest.fn();
    const log: string[] = [];

    const handler = compose()
      .use<Request>((req, res) => {
        res.status(429).json({ data: null, meta: null, error: { code: 'RATE_LIMITED' } });
        return req;
      })
      .use(tracer(log, 'never'))
      .handle(operation);

    const res = await request(appWith(handler)).get('/thing/x');

    expect(res.status).toBe(429);
    expect(log).toEqual([]);
    expect(operation).not.toHaveBeenCalled();
  });

  it('does not mutate the pipeline it was derived from', async () => {
    const log: string[] = [];
    const base = compose().use(tracer(log, 'base'));

    // Deriving a longer chain must not reach back into `base`; the whole point
    // of naming a pipeline is to branch off it per route.
    const derived = base.use(tracer(log, 'derived'));

    expect(base.size).toBe(1);
    expect(derived.size).toBe(2);

    await request(appWith(base.handle(async () => 'ok'))).get('/thing/x');
    expect(log).toEqual(['base']);

    log.length = 0;
    await request(appWith(derived.handle(async () => 'ok'))).get('/thing/x');
    expect(log).toEqual(['base', 'derived']);
  });

  it('starts empty', async () => {
    const pipeline = compose();

    expect(pipeline.size).toBe(0);

    const res = await request(appWith(pipeline.handle(async () => 'bare'))).get('/thing/x');
    expect(res.body.data).toBe('bare');
  });

  it('honours the route handler options it forwards', async () => {
    const created = compose().handle(async () => ({ id: 'x' }), { status: 201 });
    const empty = compose().handle(async () => undefined, { status: 204 });

    await expect(request(appWith(created, 'post')).post('/thing/x')).resolves.toMatchObject({
      status: 201,
    });
    await expect(request(appWith(empty)).get('/thing/x')).resolves.toMatchObject({ status: 204 });
  });

  it('builds the decorated operation once for the route, not once per request', async () => {
    const store = new MemoryCacheStore();
    const operation = jest.fn().mockResolvedValue({ id: 'cached' });

    const handler = compose()
      .use(validateParams(z.object({ id: z.string() })))
      .handle(withCache(operation, { ttlMs: 10_000, namespace: 'thing', store }));

    const app = appWith(handler);
    await request(app).get('/thing/x');
    const second = await request(app).get('/thing/x');

    // A handler rebuilt per request would still hit this store, but it would
    // lose the in-flight map that coalesces concurrent misses. The call count
    // is the observable half: the decoration survives the request that built it.
    expect(second.body.data).toEqual({ id: 'cached' });
    expect(operation).toHaveBeenCalledTimes(1);
  });

  /**
   * These are checked by `tsc`, not at run time: `@ts-expect-error` fails the
   * build if the line below it stops being an error. Each one is paired with
   * the response the misordering would actually have produced, so the test says
   * what the compile error is worth rather than only that it exists.
   */
  describe('what the types refuse', () => {
    it('will not put a role check ahead of the authentication it reads', async () => {
      const handler = compose()
        // @ts-expect-error requireRoles is declared over an authenticated request
        .use(requireRoles('admin'))
        .handle(async () => 'unreachable');

      const res = await request(appWith(handler)).get('/thing/x');

      // Uncaught, this is the bug: a route whose role check can only ever
      // answer 401, for admins and impostors alike.
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
    });

    it('will not hand an operation a body no step parsed', async () => {
      const wantsParsedBody = async (req: Request<never, unknown, { email: string }>) =>
        req.body.email;

      // @ts-expect-error the pipeline has no validateBody step, so body is still unknown
      const handler = compose().handle(wantsParsedBody);

      const res = await request(appWith(handler, 'post')).post('/thing/x').send({ email: 42 });

      // And this is that bug: no 422, no complaint, just a handler reading a
      // field off whatever arrived and answering with the result.
      expect(res.status).toBe(200);
      expect(res.body.data).toBe(42);
    });
  });
});
