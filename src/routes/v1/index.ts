import { Router } from 'express';
import { authRouter } from '@/auth/auth.router';
import { uploadRouter } from '@/upload/upload.router';
import { sendOk } from '@/lib/response';

const v1Router = Router();

v1Router.use('/auth', authRouter);
v1Router.use('/uploads', uploadRouter);

v1Router.get('/health', (_req, res) => {
  sendOk(res, { status: 'ok', version: 'v1' });
});

export { v1Router };
