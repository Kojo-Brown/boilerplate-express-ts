import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { validate } from '@/middleware/validate.middleware';
import { ValidationError } from '@/lib/errors';

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
