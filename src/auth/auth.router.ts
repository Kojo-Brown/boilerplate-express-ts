import { Router } from 'express';
import { authController } from '@/auth/auth.controller';
import {
  loginBodySchema,
  logoutBodySchema,
  magicLinkRequestBodySchema,
  refreshBodySchema,
} from '@/auth/auth.schemas';
import { oauthRouter } from '@/auth/oauth/oauth.router';
import { validate } from '@/middleware/validate.middleware';
import {
  loginRateLimiter,
  magicLinkRateLimiter,
  refreshRateLimiter,
} from '@/middleware/rate-limit.middleware';

const router: Router = Router();

// Rate limiters stay ahead of validation: a flood of malformed bodies should
// still be throttled rather than being the cheapest thing to send.
router.post('/login', loginRateLimiter, validate({ body: loginBodySchema }), authController.login);

// Requesting a link is unauthenticated and sends mail, so it carries its own
// tighter budget rather than sharing the login limiter's.
router.post(
  '/magic-link',
  magicLinkRateLimiter,
  validate({ body: magicLinkRequestBodySchema }),
  authController.requestMagicLink,
);

router.post(
  '/refresh',
  refreshRateLimiter,
  validate({ body: refreshBodySchema }),
  authController.refresh,
);
router.post('/logout', validate({ body: logoutBodySchema }), authController.logout);
router.use('/oauth', oauthRouter);

// Registered after `/oauth` so a literal segment always wins over the
// parameterised one — `/login/:strategy` sits under `/login`, but the ordering
// rule is worth keeping visible for whatever gets added next.
//
// No `validate()` here on purpose: the credential schema belongs to the
// strategy, and the strategy is not known until the segment has been read.
router.post('/login/:strategy', loginRateLimiter, authController.loginWithStrategy);

export { router as authRouter };
