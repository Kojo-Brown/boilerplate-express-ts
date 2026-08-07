import { MemoryStore, rateLimit } from 'express-rate-limit';
import type { NextFunction, Request, Response } from 'express';

const stores: MemoryStore[] = [];

function createRateLimiter(windowMs: number, limit: number, message: string) {
  // Each limiter owns an explicit store so counters can be cleared between
  // test cases — the limiters below are module singletons, so otherwise one
  // suite's requests spend the budget belonging to the next.
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

// 3 links per 15 minutes — every accepted request sends mail to an address the
// caller chose, so an unthrottled endpoint is a spam cannon pointed at third
// parties. Lower than the login ceiling because a real user needs one link, not
// five guesses.
export const magicLinkRateLimiter = createRateLimiter(
  15 * 60 * 1000,
  3,
  'Too many magic link requests. Please try again in 15 minutes.',
);

// 10 initiations per 15 minutes — throttles OAuth flow abuse without blocking real users
export const oauthRateLimiter = createRateLimiter(
  15 * 60 * 1000,
  10,
  'Too many OAuth requests. Please try again in 15 minutes.',
);

/**
 * Clears every limiter's counters. Intended for test setup, where each case
 * should start from a clean budget instead of inheriting the previous one's.
 */
export async function resetRateLimiters(): Promise<void> {
  await Promise.all(stores.map((store) => store.resetAll()));
}
