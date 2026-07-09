import type { NextFunction, Request, Response } from 'express';

type RateLimitHandler = (req: Request, res: Response, next: NextFunction) => void;
type CapturedOpts = {
  windowMs: number;
  limit: number;
  standardHeaders: string;
  legacyHeaders: boolean;
  handler: RateLimitHandler;
};

const capturedOpts: CapturedOpts[] = [];

jest.mock('express-rate-limit', () => ({
  rateLimit: jest.fn((opts: CapturedOpts) => {
    const mw = (_req: unknown, _res: unknown, next: () => void): void => next();
    capturedOpts.push(opts);
    return Object.assign(mw, { __opts: opts });
  }),
}));

// Imports are hoisted after jest.mock
import { loginRateLimiter, oauthRateLimiter, refreshRateLimiter } from '@/middleware/rate-limit.middleware';

function mockRes(): Response {
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn(),
  } as unknown as Response;
  return res;
}

function getOpts(mw: RateLimitHandler): CapturedOpts {
  return (mw as unknown as { __opts: CapturedOpts }).__opts;
}

describe('rate-limit.middleware', () => {
  it('exports loginRateLimiter, refreshRateLimiter, and oauthRateLimiter as functions', () => {
    expect(typeof loginRateLimiter).toBe('function');
    expect(typeof refreshRateLimiter).toBe('function');
    expect(typeof oauthRateLimiter).toBe('function');
  });

  describe('loginRateLimiter', () => {
    it('uses a strict limit (≤5) to prevent brute-force attacks', () => {
      expect(getOpts(loginRateLimiter).limit).toBeLessThanOrEqual(5);
    });

    it('uses a window of at least 10 minutes', () => {
      expect(getOpts(loginRateLimiter).windowMs).toBeGreaterThanOrEqual(10 * 60 * 1000);
    });

    it('uses draft-7 standard headers', () => {
      expect(getOpts(loginRateLimiter).standardHeaders).toBe('draft-7');
    });

    it('disables legacy X-RateLimit-* headers', () => {
      expect(getOpts(loginRateLimiter).legacyHeaders).toBe(false);
    });

    it('handler responds with 429 and the error envelope format', () => {
      const { handler } = getOpts(loginRateLimiter);
      const req = {} as Request;
      const res = mockRes();
      const next = jest.fn() as unknown as NextFunction;

      handler(req, res, next);

      expect(res.status).toHaveBeenCalledWith(429);
      expect(res.json).toHaveBeenCalledWith({
        data: null,
        meta: null,
        error: expect.objectContaining({ code: 'TOO_MANY_REQUESTS' }),
      });
    });
  });

  describe('refreshRateLimiter', () => {
    it('allows more requests per window than loginRateLimiter', () => {
      expect(getOpts(refreshRateLimiter).limit).toBeGreaterThan(getOpts(loginRateLimiter).limit);
    });

    it('handler responds with 429 and the error envelope format', () => {
      const { handler } = getOpts(refreshRateLimiter);
      const res = mockRes();
      const next = jest.fn() as unknown as NextFunction;

      handler({} as Request, res, next);

      expect(res.status).toHaveBeenCalledWith(429);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ data: null, meta: null, error: expect.objectContaining({ code: 'TOO_MANY_REQUESTS' }) }),
      );
    });
  });

  describe('oauthRateLimiter', () => {
    it('sits between loginRateLimiter and refreshRateLimiter in request limit', () => {
      const loginLimit = getOpts(loginRateLimiter).limit;
      const oauthLimit = getOpts(oauthRateLimiter).limit;
      const refreshLimit = getOpts(refreshRateLimiter).limit;
      expect(oauthLimit).toBeGreaterThan(loginLimit);
      expect(oauthLimit).toBeLessThanOrEqual(refreshLimit);
    });

    it('handler responds with 429 and the error envelope format', () => {
      const { handler } = getOpts(oauthRateLimiter);
      const res = mockRes();
      const next = jest.fn() as unknown as NextFunction;

      handler({} as Request, res, next);

      expect(res.status).toHaveBeenCalledWith(429);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ data: null, meta: null, error: expect.objectContaining({ code: 'TOO_MANY_REQUESTS' }) }),
      );
    });
  });
});
