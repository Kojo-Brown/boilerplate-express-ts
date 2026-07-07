import { Router } from 'express';
import { authController } from '@/auth/auth.controller';

const router = Router();

router.post('/login', authController.login);
router.post('/refresh', authController.refresh);
router.post('/logout', authController.logout);

export { router as authRouter };
