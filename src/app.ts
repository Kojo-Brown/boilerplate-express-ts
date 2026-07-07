import express from 'express';
import { correlationIdMiddleware, requestLogger } from '@/middleware/logger.middleware';
import { errorMiddleware } from '@/middleware/error.middleware';
import { v1Router } from '@/routes/v1/index';

export function createApp(): express.Application {
  const app = express();

  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(correlationIdMiddleware);
  app.use(requestLogger);

  app.use('/v1', v1Router);

  app.use((_req, res) => {
    res.status(404).json({ data: null, meta: null, error: { code: 'NOT_FOUND', message: 'Route not found' } });
  });

  app.use(errorMiddleware);

  return app;
}
