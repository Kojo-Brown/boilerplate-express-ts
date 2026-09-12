import { Router } from 'express';
import { authRouter } from '@/auth/auth.router';
import { uploadRouter } from '@/upload/upload.router';
import { usersRouter } from '@/users/users.router';
import { sseRouter } from '@/sse/sse.router';
import { sendFail, sendOk } from '@/lib/response';
import { appLifecycle } from '@/shutdown';

const v1Router: Router = Router();

v1Router.use('/auth', authRouter);
v1Router.use('/events', sseRouter);
v1Router.use('/uploads', uploadRouter);
v1Router.use('/users', usersRouter);

/**
 * Whether this instance wants traffic — which is not the same question as
 * whether it is alive, and answering it with an unconditional 200 is what makes
 * a graceful shutdown ungraceful.
 *
 * It goes 503 the instant `SIGTERM` lands, before anything has actually closed,
 * and stays serving normally for the whole drain window. That gap is the point:
 * the balancer gets to observe the instance leaving the pool and stop routing to
 * it while it is still able to answer, rather than discovering it by way of a
 * refused connection.
 *
 * Splitting this into separate liveness and readiness endpoints with dependency
 * checks is its own spec item; the shutdown half is here because a drain window
 * that nothing can observe is a sleep.
 */
v1Router.get('/health', (_req, res) => {
  if (appLifecycle.isReady) {
    sendOk(res, { status: 'ok', version: 'v1' });
    return;
  }

  // Seconds, and never 0: a probe told to retry immediately reports this
  // instance flapping rather than leaving.
  res.setHeader('Retry-After', '5');
  sendFail(
    res,
    503,
    'SERVER_DRAINING',
    'This instance is shutting down and is no longer ready for traffic',
  );
});

export { v1Router };
