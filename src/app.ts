import express from 'express';
import session from 'express-session';
import passport from 'passport';
import { correlationIdMiddleware, requestLogger } from '@/middleware/logger.middleware';
import { containerMiddleware } from '@/middleware/container.middleware';
import { traceContextMiddleware } from '@/observability/trace.middleware';
import { errorMiddleware } from '@/middleware/error.middleware';
import { v1Router } from '@/routes/v1/index';
import { registerGoogleStrategy } from '@/auth/oauth/google.strategy';
import { registerErrorTranslator } from '@/lib/error-translators';
import { postgresErrorTranslator } from '@/db/db.errors';
import { multerErrorTranslator } from '@/upload/upload.errors';
import { csvErrorTranslator } from '@/streams/csv.errors';
import { domainEventBus } from '@/events';
import { appMetrics, createMetricsRouter } from '@/metrics';
import { registerDomainSubscribers } from '@/events/subscribers';
import { attachDomainEventFeed } from '@/sse/domain-feed';
import { domainEventStreamHub } from '@/sse/events.hub';
import { env } from '@/config/env';
import { appLifecycle, shutdownGuard } from '@/shutdown';
import { sendFail } from '@/lib/response';

registerGoogleStrategy();

// Composition root: each module contributes how *its* errors map to responses.
// The error middleware never learns about Postgres or Multer.
registerErrorTranslator(postgresErrorTranslator);
registerErrorTranslator(multerErrorTranslator);
registerErrorTranslator(csvErrorTranslator);

// Same idea one layer up: the publishers do not know who is listening, and this
// is the only file that knows the full subscriber list. Attaching here rather
// than in each subscriber's own module is what makes a deployment able to leave
// one out — a module that subscribed on import could not be.
registerDomainSubscribers(domainEventBus);

// One more subscriber, and the same rule: the publishers do not know the event
// stream exists, and a deployment that does not want `GET /v1/events/stream`
// leaves this line out rather than editing anything that publishes. It is here
// and not in `sse.router.ts` because a router that subscribed on import could
// not be left out — the same reason the subscribers above are attached here.
attachDomainEventFeed(domainEventBus, domainEventStreamHub);

export function createApp(): express.Application {
  const app = express();

  if (env.METRICS_ENABLED) {
    // First of everything, and that position is the measurement. The histogram
    // is meant to answer "how long did the client wait", so it has to be
    // outside the body parsers, the session lookup and passport — a middleware
    // installed after those times the handler and reports it as the request's
    // latency, and the gap between the two is exactly where a slow session
    // store hides.
    app.use(appMetrics.middleware);

    // Ahead of the routers and ahead of `shutdownGuard`, which is the part that
    // matters: the scrape that explains a shutdown is the one taken during it,
    // and an exposition sitting behind the guard would start refusing at the
    // moment its numbers became interesting. It is mounted before the session
    // middleware for a smaller reason — a scraper has no session, and running
    // the store lookup for it every fifteen seconds is work for nobody. It sits
    // ahead of `requestLogger` too, which is why a scrape leaves no access log
    // line: one every fifteen seconds, forever, saying 200.
    app.use(env.METRICS_PATH, createMetricsRouter(appMetrics.registry));
  }

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
  // Between the two on purpose. After `correlationIdMiddleware`, because the id
  // it records on the span and puts into baggage does not exist until that has
  // run; before `requestLogger`, because it is what sets `req.traceId` and
  // everything downstream — the routers included — has to execute inside the
  // context it makes active for the baggage to reach an outbound request.
  app.use(traceContextMiddleware);
  app.use(requestLogger);
  // After the correlation id, so a scope can be named by the request it serves,
  // and ahead of every router, so no handler has to ask whether it has a scope.
  app.use(containerMiddleware);
  // After the logger, so a refusal is recorded under the same correlation id as
  // everything else, and ahead of the routers, so it costs nothing to reach.
  // It passes everything through until the listener has closed — see
  // `shutdownGuard`, which is narrower than its name suggests on purpose.
  app.use(shutdownGuard({ lifecycle: appLifecycle }));

  app.use('/v1', v1Router);

  app.use((_req, res) => {
    sendFail(res, 404, 'NOT_FOUND', 'Route not found');
  });

  app.use(errorMiddleware);

  return app;
}
