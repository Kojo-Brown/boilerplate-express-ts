import { rateLimit, MemoryStore } from 'express-rate-limit';
import type { NextFunction, Request, Response } from 'express';

const stores: MemoryStore[] = [];

function createRateLimiter(windowMs: number, limit: number, message: string) {
  // Hold the store so counters can be cleared; see `resetRateLimiters`.
  const store = new MemoryStore();
  stores.push(store);

  return rateLimit({
    windowMs,
    limit,
    store,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (_req: Request, res: Response, _next: NextFunction) => {
      res.status(429).json({
        data: null,
        meta: null,
        error: {
          code: 'TOO_MANY_REQUESTS',
          message,
        },
      });
    },
  });
}

// 5 attempts per 15 minutes — low ceiling prevents brute-force credential stuffing
export const loginRateLimiter = createRateLimiter(
  15 * 60 * 1000,
  5,
  'Too many login attempts. Please try again in 15 minutes.',
);

// 30 requests per 15 minutes — permits legitimate sliding-window refresh cycles
export const refreshRateLimiter = createRateLimiter(
  15 * 60 * 1000,
  30,
  'Too many token refresh requests. Please try again in 15 minutes.',
);

// 10 initiations per 15 minutes — throttles OAuth flow abuse without blocking real users
export const oauthRateLimiter = createRateLimiter(
  15 * 60 * 1000,
  10,
  'Too many OAuth requests. Please try again in 15 minutes.',
);

/**
 * Clears every limiter's counters.
 *
 * The limiters are module-level singletons keyed by client IP, so a test file
 * driving more than `limit` requests through one of these routes starts
 * collecting 429s partway through the run — and which case trips it depends on
 * test order. Integration suites call this between cases to keep each one
 * independent.
 */
export function resetRateLimiters(): void {
  for (const store of stores) {
    store.resetAll();
  }
}
