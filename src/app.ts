import express from 'express';
import session from 'express-session';
import passport from 'passport';
import { correlationIdMiddleware, requestLogger } from '@/middleware/logger.middleware';
import { errorMiddleware } from '@/middleware/error.middleware';
import { v1Router } from '@/routes/v1/index';
import { registerGoogleStrategy } from '@/auth/oauth/google.strategy';
import { registerErrorTranslator } from '@/lib/error-translators';
import { postgresErrorTranslator } from '@/db/db.errors';
import { multerErrorTranslator } from '@/upload/upload.errors';
import { domainEventBus } from '@/events';
import { registerDomainSubscribers } from '@/events/subscribers';
import { env } from '@/config/env';
import { sendFail } from '@/lib/response';

registerGoogleStrategy();

// Composition root: each module contributes how *its* errors map to responses.
// The error middleware never learns about Postgres or Multer.
registerErrorTranslator(postgresErrorTranslator);
registerErrorTranslator(multerErrorTranslator);

// Same idea one layer up: the publishers do not know who is listening, and this
// is the only file that knows the full subscriber list. Attaching here rather
// than in each subscriber's own module is what makes a deployment able to leave
// one out — a module that subscribed on import could not be.
registerDomainSubscribers(domainEventBus);

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
    sendFail(res, 404, 'NOT_FOUND', 'Route not found');
  });

  app.use(errorMiddleware);

  return app;
}
