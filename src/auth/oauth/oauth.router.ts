import { Router } from 'express';
import { oauthController } from '@/auth/oauth/oauth.controller';
import { oauthRateLimiter } from '@/middleware/rate-limit.middleware';

const router = Router();

router.get('/google', oauthRateLimiter, oauthController.initiateGoogle);
router.get('/google/callback', oauthController.handleGoogleCallback);

export { router as oauthRouter };
