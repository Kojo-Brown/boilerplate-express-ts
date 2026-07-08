import express from 'express';
import session from 'express-session';
import passport from 'passport';
import { correlationIdMiddleware, requestLogger } from '@/middleware/logger.middleware';
import { errorMiddleware } from '@/middleware/error.middleware';
import { v1Router } from '@/routes/v1/index';
import { registerGoogleStrategy } from '@/auth/oauth/google.strategy';
import { env } from '@/config/env';

registerGoogleStrategy();

export function createApp(): express.Application {
  const app = express();

  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(
    session({
      secret: env.SESSION_SECRET,
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        secure: env.NODE_ENV === 'production',
        maxAge: 10 * 60 * 1000,
      },
    }),
  );
  app.use(passport.initialize());
  app.use(correlationIdMiddleware);
  app.use(requestLogger);

  app.use('/v1', v1Router);

  app.use((_req, res) => {
    res.status(404).json({ data: null, meta: null, error: { code: 'NOT_FOUND', message: 'Route not found' } });
  });

  app.use(errorMiddleware);

  return app;
}
