import { Router } from 'express';
import { authRouter } from '@/auth/auth.router';

const v1Router = Router();

v1Router.use('/auth', authRouter);

v1Router.get('/health', (_req, res) => {
  res.json({ data: { status: 'ok', version: 'v1' }, meta: null, error: null });
});

export { v1Router };
