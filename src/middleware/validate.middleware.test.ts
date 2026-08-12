import type { NextFunction, Request, Response } from 'express';
import express from 'express';
import supertest from 'supertest';
import { z } from 'zod';
import {
  validate,
  validateBody,
  validateParams,
  validateQuery,
} from '@/middleware/validate.middleware';
import { ValidationError } from '@/lib/errors';
import { compose } from '@/lib/pipeline';
import { errorMiddleware } from '@/middleware/error.middleware';

function mockReq(overrides: Partial<Request> = {}): Request {
  return {
    body: {},
    query: {},
    params: {},
    ...overrides,
  } as unknown as Request;
}

function mockRes(): Response {
  return {} as Response;
}

describe('validate middleware', () => {
  describe('body validation', () => {
    const bodySchema = z.object({
      name: z.string().min(1),
      age: z.number().int().positive(),
    });

    it('parses and replaces req.body on success', () => {
      const req = mockReq({ body: { name: 'Alice', age: 30 } });
      const next = jest.fn() as unknown as NextFunction;

      validate({ body: bodySchema })(req, mockRes(), next);

      expect(next).toHaveBeenCalledWith();
      expect(req.body).toEqual({ name: 'Alice', age: 30 });
    });

    it('calls next with ValidationError when body is invalid', () => {
      const req = mockReq({ body: { name: '', age: -1 } });
      const next = jest.fn() as unknown as NextFunction;

      validate({ body: bodySchema })(req, mockRes(), next);

      expect(next).toHaveBeenCalledWith(expect.any(ValidationError));
      const err = (next as jest.Mock).mock.calls[0][0] as ValidationError;
      expect(err.statusCode).toBe(422);
      expect(err.code).toBe('VALIDATION_ERROR');
      expect(err.issues.length).toBeGreaterThan(0);
    });

    it('calls next with ValidationError when body has missing required fields', () => {
      const req = mockReq({ body: {} });
      const next = jest.fn() as unknown as NextFunction;

      validate({ body: bodySchema })(req, mockRes(), next);

      expect(next).toHaveBeenCalledWith(expect.any(ValidationError));
    });

    it('strips unknown fields', () => {
      const req = mockReq({ body: { name: 'Bob', age: 25, extra: 'ignored' } });
      const next = jest.fn() as unknown as NextFunction;

      validate({ body: bodySchema })(req, mockRes(), next);

      expect(next).toHaveBeenCalledWith();
      expect((req.body as Record<string, unknown>)['extra']).toBeUndefined();
    });
  });

  describe('query validation', () => {
    const querySchema = z.object({
      page: z.coerce.number().int().positive().default(1),
      limit: z.coerce.number().int().positive().max(100).default(20),
    });

    it('coerces and replaces req.query on success', () => {
      const req = mockReq({ query: { page: '2', limit: '50' } as Record<string, string> });
      const next = jest.fn() as unknown as NextFunction;

      validate({ query: querySchema })(req, mockRes(), next);

      expect(next).toHaveBeenCalledWith();
      expect((req.query as Record<string, unknown>)['page']).toBe(2);
      expect((req.query as Record<string, unknown>)['limit']).toBe(50);
    });

    it('applies defaults when query params are absent', () => {
      const req = mockReq({ query: {} });
      const next = jest.fn() as unknown as NextFunction;

      validate({ query: querySchema })(req, mockRes(), next);

      expect(next).toHaveBeenCalledWith();
      expect((req.query as Record<string, unknown>)['page']).toBe(1);
      expect((req.query as Record<string, unknown>)['limit']).toBe(20);
    });

    it('calls next with ValidationError when query values violate constraints', () => {
      const req = mockReq({ query: { page: '-1', limit: '200' } as Record<string, string> });
      const next = jest.fn() as unknown as NextFunction;

      validate({ query: querySchema })(req, mockRes(), next);

      expect(next).toHaveBeenCalledWith(expect.any(ValidationError));
      const err = (next as jest.Mock).mock.calls[0][0] as ValidationError;
      expect(err.issues.length).toBeGreaterThan(0);
    });
  });

  describe('params validation', () => {
    const paramsSchema = z.object({
      id: z.string().uuid(),
    });

    it('validates req.params on success', () => {
      const req = mockReq({ params: { id: '550e8400-e29b-41d4-a716-446655440000' } });
      const next = jest.fn() as unknown as NextFunction;

      validate({ params: paramsSchema })(req, mockRes(), next);

      expect(next).toHaveBeenCalledWith();
    });

    it('calls next with ValidationError when params fail uuid check', () => {
      const req = mockReq({ params: { id: 'not-a-uuid' } });
      const next = jest.fn() as unknown as NextFunction;

      validate({ params: paramsSchema })(req, mockRes(), next);

      expect(next).toHaveBeenCalledWith(expect.any(ValidationError));
      const err = (next as jest.Mock).mock.calls[0][0] as ValidationError;
      expect(err.statusCode).toBe(422);
      expect(err.issues[0]?.path).toContain('id');
    });
  });

  describe('combined validation', () => {
    it('validates body, query, and params all at once when all are valid', () => {
      const req = mockReq({
        body: { title: 'Hello' },
        query: { page: '1' } as Record<string, string>,
        params: { id: '550e8400-e29b-41d4-a716-446655440000' },
      });
      const next = jest.fn() as unknown as NextFunction;

      validate({
        body: z.object({ title: z.string() }),
        query: z.object({ page: z.coerce.number().positive() }),
        params: z.object({ id: z.string().uuid() }),
      })(req, mockRes(), next);

      expect(next).toHaveBeenCalledWith();
    });

    it('reports body errors when body is invalid even if query/params are absent', () => {
      const req = mockReq({ body: { title: 99 } });
      const next = jest.fn() as unknown as NextFunction;

      validate({
        body: z.object({ title: z.string() }),
      })(req, mockRes(), next);

      expect(next).toHaveBeenCalledWith(expect.any(ValidationError));
    });

    it('skips sections whose schemas are not provided', () => {
      const req = mockReq({ body: { anything: true } });
      const next = jest.fn() as unknown as NextFunction;

      validate({})(req, mockRes(), next);

      expect(next).toHaveBeenCalledWith();
    });
  });

  describe('non-Zod error passthrough', () => {
    it('forwards unexpected errors to next without wrapping them', () => {
      const unexpected = new Error('unexpected');
      const brokenSchema = {
        parse: () => { throw unexpected; },
      } as unknown as import('zod').ZodSchema;

      const req = mockReq({ body: {} });
      const next = jest.fn() as unknown as NextFunction;

      validate({ body: brokenSchema })(req, mockRes(), next);

      expect(next).toHaveBeenCalledWith(unexpected);
    });
  });
});

/**
 * The suites above build `req` as an object literal, which is why the query
 * bug below survived: a literal has no prototype accessor to collide with, so
 * `req.query = parsed` looked fine there and threw on every real request. These
 * run against a real Express app for that reason.
 */
describe('validation against a real request', () => {
  function appWith(handler: express.RequestHandler, path = '/thing/:id'): express.Application {
    const app = express();
    app.use(express.json());
    app.get(path, handler);
    app.post(path, handler);
    app.use(errorMiddleware);
    return app;
  }

  describe('validate() middleware', () => {
    it('replaces req.query on a real request rather than throwing on a getter', async () => {
      const app = express();
      app.get(
        '/thing',
        validate({ query: z.object({ page: z.coerce.number().default(1) }) }),
        (req, res) => {
          res.json({ query: req.query });
        },
      );
      app.use(errorMiddleware);

      const res = await supertest(app).get('/thing?page=7');

      // Express 5 defines `query` as a getter with no setter, so the plain
      // assignment this used to be raised "Cannot set property query of
      // #<IncomingMessage> which has only a getter" — a 500 on every request
      // to any route that validated its query string.
      expect(res.status).toBe(200);
      expect(res.body.query).toEqual({ page: 7 });
    });
  });

  describe('validateParams', () => {
    it('parses and narrows the matched params', async () => {
      const handler = compose()
        .use(validateParams(z.object({ id: z.coerce.number().int() })))
        .handle(async (req) => req.params.id * 2);

      const res = await supertest(appWith(handler)).get('/thing/21');

      expect(res.body.data).toBe(42);
    });

    it('answers 422 with the offending field', async () => {
      const handler = compose()
        .use(validateParams(z.object({ id: z.string().uuid() })))
        .handle(async () => 'unreachable');

      const res = await supertest(appWith(handler)).get('/thing/not-a-uuid');

      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(JSON.stringify(res.body.error.issues)).toContain('id');
    });
  });

  describe('validateBody', () => {
    it('parses the body and strips what the schema does not name', async () => {
      const handler = compose()
        .use(validateBody(z.object({ email: z.string().email() })))
        .handle(async (req) => req.body);

      const res = await supertest(appWith(handler))
        .post('/thing/x')
        .send({ email: 'user@example.test', admin: true });

      expect(res.body.data).toEqual({ email: 'user@example.test' });
    });

    it('answers 422 for a body that does not parse', async () => {
      const handler = compose()
        .use(validateBody(z.object({ email: z.string().email() })))
        .handle(async () => 'unreachable');

      const res = await supertest(appWith(handler)).post('/thing/x').send({ email: 'nope' });

      expect(res.status).toBe(422);
    });
  });

  describe('validateQuery', () => {
    it('coerces, defaults, and hands the parsed value to the operation', async () => {
      const handler = compose()
        .use(
          validateQuery(
            z.object({
              page: z.coerce.number().int().positive().default(1),
              limit: z.coerce.number().int().max(100).default(20),
            }),
          ),
        )
        .handle(async (req) => req.query);

      const res = await supertest(appWith(handler)).get('/thing/x?page=3');

      expect(res.body.data).toEqual({ page: 3, limit: 20 });
    });

    it('answers 422 when a bound is violated', async () => {
      const handler = compose()
        .use(validateQuery(z.object({ limit: z.coerce.number().max(100) })))
        .handle(async () => 'unreachable');

      const res = await supertest(appWith(handler)).get('/thing/x?limit=500');

      expect(res.status).toBe(422);
    });
  });
});
