import { Router } from 'express';
import { authController } from '@/auth/auth.controller';
import { oauthRouter } from '@/auth/oauth/oauth.router';

const router = Router();

router.post('/login', authController.login);
router.post('/refresh', authController.refresh);
router.post('/logout', authController.logout);
router.use('/oauth', oauthRouter);

export { router as authRouter };
