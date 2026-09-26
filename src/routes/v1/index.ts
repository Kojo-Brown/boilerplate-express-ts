import { Router } from 'express';
import { authRouter } from '@/auth/auth.router';
import { uploadRouter } from '@/upload/upload.router';
import { usersRouter } from '@/users/users.router';
import { sseRouter } from '@/sse/sse.router';
import { env } from '@/config/env';
import { appReadinessProbe, createHealthRouter } from '@/health';
import { appLifecycle } from '@/shutdown';
import { WEBHOOKS_ROUTER_PATH, webhooksRouter } from '@/webhooks';

const v1Router: Router = Router();

v1Router.use('/auth', authRouter);
v1Router.use('/events', sseRouter);
v1Router.use('/uploads', uploadRouter);
v1Router.use('/users', usersRouter);
/**
 * Mounted by path constant rather than by literal, because the raw-body parser in
 * `createApp` derives its own path from the same constant — see
 * `WEBHOOKS_RAW_BODY_PATH`. Written out twice, the day one of them is renamed is
 * the day every delivery starts failing with a 500 about a missing raw body.
 */
v1Router.use(WEBHOOKS_ROUTER_PATH, webhooksRouter);

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
