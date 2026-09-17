import { Router } from 'express';
import { authRouter } from '@/auth/auth.router';
import { uploadRouter } from '@/upload/upload.router';
import { usersRouter } from '@/users/users.router';
import { sseRouter } from '@/sse/sse.router';
import { env } from '@/config/env';
import { appReadinessProbe, createHealthRouter } from '@/health';
import { appLifecycle } from '@/shutdown';

const v1Router: Router = Router();

v1Router.use('/auth', authRouter);
v1Router.use('/events', sseRouter);
v1Router.use('/uploads', uploadRouter);
v1Router.use('/users', usersRouter);

/**
 * `GET /v1/health` (the pre-split alias), `/v1/health/live` and
 * `/v1/health/ready`.
 *
 * The router is built here and the *checks* it runs are registered in
 * `server.ts`, which is the split that matters: a check holds a connection to a
 * real dependency, and every e2e suite in this repository calls `createApp()`.
 * Same rule as the purge job, the outbox relay and the process metrics — what
 * belongs to the process is started by the process. An app built by a test
 * therefore gets a readiness endpoint with an empty check list, which answers
 * `ok`, which is correct: a process that depends on nothing is ready as soon as
 * it is listening.
 */
v1Router.use(
  '/health',
  createHealthRouter({
    lifecycle: appLifecycle,
    probe: appReadinessProbe,
    exposeErrors: env.HEALTH_EXPOSE_ERRORS,
    retryAfterSeconds: env.HEALTH_RETRY_AFTER_SECONDS,
  }),
);

export { v1Router };
