import { Router } from 'express';
import { oauthController } from '@/auth/oauth/oauth.controller';

const router = Router();

router.get('/google', oauthController.initiateGoogle);
router.get('/google/callback', oauthController.handleGoogleCallback);

export { router as oauthRouter };
