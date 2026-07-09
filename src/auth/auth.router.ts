import { Router } from 'express';
import { authController } from '@/auth/auth.controller';
import { oauthRouter } from '@/auth/oauth/oauth.router';
import { loginRateLimiter, refreshRateLimiter } from '@/middleware/rate-limit.middleware';

const router = Router();

router.post('/login', loginRateLimiter, authController.login);
router.post('/refresh', refreshRateLimiter, authController.refresh);
router.post('/logout', authController.logout);
router.use('/oauth', oauthRouter);

export { router as authRouter };
