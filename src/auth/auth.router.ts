import { Router } from 'express';
import { authController } from '@/auth/auth.controller';
import { loginBodySchema, logoutBodySchema, refreshBodySchema } from '@/auth/auth.schemas';
import { oauthRouter } from '@/auth/oauth/oauth.router';
import { validate } from '@/middleware/validate.middleware';
import { loginRateLimiter, refreshRateLimiter } from '@/middleware/rate-limit.middleware';

const router: Router = Router();

// Rate limiters stay ahead of validation: a flood of malformed bodies should
// still be throttled rather than being the cheapest thing to send.
router.post('/login', loginRateLimiter, validate({ body: loginBodySchema }), authController.login);
router.post(
  '/refresh',
  refreshRateLimiter,
  validate({ body: refreshBodySchema }),
  authController.refresh,
);
router.post('/logout', validate({ body: logoutBodySchema }), authController.logout);
router.use('/oauth', oauthRouter);

export { router as authRouter };
