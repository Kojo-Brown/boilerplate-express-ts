import { env } from '@/config/env';
import { closePool } from '@/db/pool';
import { selectMagicLinkDelivery } from '@/auth/strategies';
import {
  createAppJobHandlers,
  createBullDeadLetterStore,
  createDeadLetterQueue,
  createDeadLetterSink,
  createJobQueueWorker,
  jobQueueConnection,
  redactAppJobPayload,
} from '@/queue';
import type { AppJobPayloads } from '@/queue';

/**
 * The job worker as its own process: `pnpm worker:queue`.
 *
 * A process rather than a timer inside the API, for the reasons
 * `stream-worker.ts` gives and one more that is specific to a job queue: a
 * worker holds a *blocking* Redis connection per concurrency slot, so running
 * one inside every API replica multiplies blocked connections by replica count
 * for work that a single dedicated process could have done. Splitting them also
 * lets the two scale on their own inputs — worker count follows the backlog,
 * replica count follows traffic — and keeps a slow handler off the event loop
 * that is answering requests.
 *
 * ## This file is a composition root, like `app.ts`
 *
 * It builds the handler table's dependencies itself rather than resolving
 * anything out of `appContainer`, for the reason `stream-worker.ts` sets out at
 * length: importing the container from a second entry point pulls in the
 * middleware, which pulls the container back, and the cycle only resolves when
 * `app.ts` is the entry point.
 *
 * The delivery it builds is the **real** one, never
 * `createQueuedMagicLinkDelivery` — a queued delivery handed to its own handler
 * would enqueue a copy of every job it ran.
 */

async function main(): Promise<void> {
  if (env.REDIS_URL === '') {
    throw new Error(
      'REDIS_URL is not set. The job worker has nothing to connect to — set it, or do not run this process.',
    );
  }

  const connection = jobQueueConnection(env.REDIS_URL);
  const queueName = env.JOB_QUEUE_NAME;
  const prefix = env.JOB_QUEUE_PREFIX;

  const deadLetterQueue = createDeadLetterQueue({ connection, queueName, prefix });
  const deadLetter = createDeadLetterSink({
    store: createBullDeadLetterStore(deadLetterQueue),
    maxSize: env.JOB_DEAD_LETTER_MAX_SIZE,
    // Applied here and not left to the sink's default, because the default is
    // to store the payload verbatim and one of this service's payloads is a
    // bearer token. See `redactAppJobPayload`.
    redact: redactAppJobPayload,
  });

  const worker = createJobQueueWorker<AppJobPayloads>({
    connection,
    queueName,
    // `selectMagicLinkDelivery` and not the module's `magicLinkDelivery`
    // singleton: this process may legitimately be configured differently from
    // an API replica, and a `const` evaluated on import is how that stops being
    // possible. It is the real sender either way — a queued delivery handed to
    // its own handler would enqueue a copy of every job it ran.
    handlers: createAppJobHandlers({
      magicLinkDelivery: selectMagicLinkDelivery(env.NODE_ENV),
    }),
    retry: {
      attempts: env.JOB_QUEUE_ATTEMPTS,
      baseDelayMs: env.JOB_QUEUE_BASE_DELAY_MS,
      maxDelayMs: env.JOB_QUEUE_MAX_DELAY_MS,
    },
    deadLetter,
    concurrency: env.JOB_QUEUE_CONCURRENCY,
    lockDurationMs: env.JOB_QUEUE_LOCK_DURATION_MS,
  });

  await worker.start();
  console.log(
    `[queue worker] consuming "${queueName}" at concurrency ${String(env.JOB_QUEUE_CONCURRENCY)}, ` +
      `dead-lettering to "${deadLetterQueue.name}"`,
  );

  let shuttingDown = false;

  /**
   * Draining, in the order that avoids creating duplicates.
   *
   * `worker.close()` stops the fetch and waits for the jobs in flight, which
   * takes up to one handler. Killing the connection instead would abandon a
   * handler mid-job: the job would keep its lock until it expired, be treated
   * as stalled, and run a second time — paying for a second of shutdown in
   * duplicate side effects. The dead-letter queue is closed only afterwards,
   * because the last thing a failing job does is write to it.
   */
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[queue worker] ${signal} received, draining`);

    void worker
      .close()
      .then(() => Promise.all([deadLetterQueue.close(), closePool()]))
      .then(() => {
        process.exit(0);
      })
      .catch((error: unknown) => {
        console.error('[queue worker] shutdown failed:', error);
        process.exit(1);
      });
  };

  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

main().catch((error: unknown) => {
  console.error('[queue worker] failed to start:', error);
  process.exit(1);
});
