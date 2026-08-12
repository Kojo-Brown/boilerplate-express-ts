import type { RequestHandler } from 'express';
import express from 'express';
import request from 'supertest';
import { AppError } from '@/lib/errors';
import { errorMiddleware } from '@/middleware/error.middleware';
import { compose } from '@/lib/pipeline/compose';
import { fromRequestHandler } from '@/lib/pipeline/from-request-handler';

function appWith(handler: express.RequestHandler): express.Application {
  const app = express();
  app.use(express.json());
  app.get('/thing', handler);
  app.use(errorMiddleware);
  return app;
}

describe('fromRequestHandler', () => {
  it('continues the pipeline when the middleware calls next()', async () => {
    const middleware: RequestHandler = (_req, _res, next) => {
      next();
    };
    const handler = compose()
      .use(fromRequestHandler(middleware))
      .handle(async () => 'reached');

    const res = await request(appWith(handler)).get('/thing');

    expect(res.body.data).toBe('reached');
  });

  it('leaves what the middleware attached to the request in place', async () => {
    const middleware: RequestHandler = (req, _res, next) => {
      (req as express.Request & { tag?: string }).tag = 'attached';
      next();
    };
    const handler = compose()
      .use(fromRequestHandler(middleware))
      .handle(async (req) => (req as express.Request & { tag?: string }).tag);

    const res = await request(appWith(handler)).get('/thing');

    expect(res.body.data).toBe('attached');
  });

  it('stops the pipeline when the middleware answers without calling next()', async () => {
    const operation = jest.fn();
    // The shape of every rate limiter: respond, and never hand control on.
    const limiter: RequestHandler = (_req, res) => {
      res.status(429).json({ data: null, meta: null, error: { code: 'RATE_LIMITED' } });
    };

    const res = await request(appWith(compose().use(fromRequestHandler(limiter)).handle(operation)))
      .get('/thing');

    expect(res.status).toBe(429);
    expect(operation).not.toHaveBeenCalled();
  });

  it('routes next(err) to the translator chain', async () => {
    const middleware: RequestHandler = (_req, _res, next) => {
      next(new AppError(415, 'Unsupported', 'UNSUPPORTED_MEDIA_TYPE'));
    };

    const res = await request(
      appWith(compose().use(fromRequestHandler(middleware)).handle(async () => 'unreachable')),
    ).get('/thing');

    expect(res.status).toBe(415);
    expect(res.body.error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
  });

  it('routes a synchronous throw the same way', async () => {
    const middleware: RequestHandler = () => {
      throw new AppError(400, 'Bad', 'BAD_REQUEST');
    };

    const res = await request(
      appWith(compose().use(fromRequestHandler(middleware)).handle(async () => 'unreachable')),
    ).get('/thing');

    expect(res.status).toBe(400);
  });

  it('routes a rejected promise from an async middleware', async () => {
    // Express 5 forwards this for a handler it invoked itself. The adapter calls
    // the middleware directly, so without this the rejection would go unhandled
    // and the request would hang until the socket timed out.
    const middleware: RequestHandler = async () => {
      await Promise.resolve();
      throw new AppError(503, 'Down', 'SERVICE_UNAVAILABLE');
    };

    const res = await request(
      appWith(compose().use(fromRequestHandler(middleware)).handle(async () => 'unreachable')),
    ).get('/thing');

    expect(res.status).toBe(503);
  });

  it('ignores a second next() instead of running the rest of the chain twice', async () => {
    const operation = jest.fn().mockResolvedValue('once');
    // Express would run everything after this middleware once per call — two
    // responses, and on a real route two writes to the database.
    const twice: RequestHandler = (_req, _res, next) => {
      next();
      next();
    };

    const res = await request(
      appWith(compose().use(fromRequestHandler(twice)).handle(operation)),
    ).get('/thing');

    expect(res.status).toBe(200);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('ignores an error reported after the middleware already succeeded', async () => {
    const lateError: RequestHandler = (_req, _res, next) => {
      next();
      next(new AppError(500, 'Too late', 'TOO_LATE'));
    };

    const res = await request(
      appWith(compose().use(fromRequestHandler(lateError)).handle(async () => 'ok')),
    ).get('/thing');

    expect(res.status).toBe(200);
    expect(res.body.data).toBe('ok');
  });

  it('refuses next("route") rather than guessing what it meant', async () => {
    const skipper: RequestHandler = (_req, _res, next) => {
      next('route');
    };
    const operation = jest.fn();

    const res = await request(
      appWith(compose().use(fromRequestHandler(skipper)).handle(operation)),
    ).get('/thing');

    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('PIPELINE_NEXT_ROUTE_UNSUPPORTED');
    // The important half: it did not silently run the operation the middleware
    // asked to skip.
    expect(operation).not.toHaveBeenCalled();
  });

  it('refuses next("router") the same way', async () => {
    const skipper: RequestHandler = (_req, _res, next) => {
      next('router');
    };

    const res = await request(
      appWith(compose().use(fromRequestHandler(skipper)).handle(async () => 'unreachable')),
    ).get('/thing');

    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('PIPELINE_NEXT_ROUTE_UNSUPPORTED');
  });

  it('adapts a real third-party middleware — express.json — mid-pipeline', async () => {
    const app = express();
    app.post(
      '/thing',
      compose()
        .use(fromRequestHandler(express.json()))
        .handle(async (req) => req.body),
    );
    app.use(errorMiddleware);

    const res = await request(app).post('/thing').send({ hello: 'world' });

    expect(res.body.data).toEqual({ hello: 'world' });
  });
});
