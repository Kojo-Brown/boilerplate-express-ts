import { hostname } from 'node:os';
import { env } from '@/config/env';
import { closePool } from '@/db/pool';
import { domainEventBus } from '@/events';
import { registerDomainSubscribers } from '@/events/subscribers';
import { createEventBusStreamHandler } from '@/redis/bus-consumer';
import { createStreamConnections } from '@/redis/ioredis.adapter';
import { createParkingLot } from '@/redis/parking-lot';
import { createStreamWorker } from '@/redis/stream.worker';

/**
 * The stream consumer as its own process: `pnpm worker:stream`.
 *
 * A process and not a timer inside the API, which is the same call `server.ts`
 * makes about the relay and the purge job but with more force behind it. A
 * consumer's steady state is a *blocked* connection waiting for work, and the
 * work it does is unbounded by any request — a subscriber that takes four
 * seconds is four seconds of this process rather than four seconds of an API
 * replica's event loop and pooled connection. Separating them also lets the two
 * scale independently: consumer count is a function of the backlog, replica
 * count of the traffic, and they are rarely the same number.
 *
 * Every replica of this process joins the same group under a different consumer
 * name, so entries are divided among them rather than duplicated — and a
 * replica that dies has its unfinished entries reclaimed by the others after
 * `REDIS_STREAM_MIN_IDLE_MS`, which is the whole reason the group exists.
 *
 * ## This file is a composition root, like `app.ts`
 *
 * It attaches the subscribers itself rather than resolving anything out of
 * `appContainer`, and both halves of that are deliberate.
 *
 * Subscribers are attached in a composition root and never on import — that is
 * what lets a deployment leave one out — so a process that publishes to the bus
 * without attaching any delivers every entry to nobody, acknowledges it, and
 * reports a healthy drain. The container would not have helped: it registers
 * the bus as a *value*, so resolving `EVENT_BUS` yields the same bare object
 * `app.ts` separately decorates.
 *
 * Importing `appContainer` here does not merely fail to help, it fails: the
 * composition root pulls in the middleware, which pulls the container back, and
 * the cycle only resolves when `app.ts` is the entry point. Reaching for a DI
 * container from a second entry point is how that stays hidden until the first
 * time somebody runs the second one.
 *
 * A worker attaching a *different* subscriber set from the API is a legitimate
 * deployment — it is why `registerDomainSubscribers` takes options — and this
 * is where that choice would be made.
 */

function consumerName(): string {
  if (env.REDIS_STREAM_CONSUMER !== '') return env.REDIS_STREAM_CONSUMER;

  // The hostname, and specifically not something carrying the pid. Under an
  // orchestrator a pod's hostname is stable across restarts of the container,
  // so a restarted worker rejoins as itself and finds its own unfinished
  // entries still assigned to it. A pid would make every restart a new
  // consumer, leaving the old one in `XINFO CONSUMERS` forever with its pending
  // entries recoverable only by the reclaim path.
  return hostname();
}

async function main(): Promise<void> {
  if (env.REDIS_URL === '') {
    throw new Error(
      'REDIS_URL is not set. The stream worker has nothing to connect to — set it, or do not run this process.',
    );
  }

  // The composition root's one job, and it has to happen before anything is
  // consumed: without it every entry is published to a bus nobody is listening
  // on, acknowledged, and counted as handled.
  registerDomainSubscribers(domainEventBus);

  const connections = createStreamConnections(env.REDIS_URL);
  const consumer = consumerName();

  const worker = createStreamWorker({
    connections,
    key: env.REDIS_STREAM_KEY,
    group: env.REDIS_STREAM_GROUP,
    consumer,
    handler: createEventBusStreamHandler(domainEventBus),
    // Durable rather than the default, which logs and drops. A parked entry is
    // by definition one that failed in a way retrying did not fix, so it is
    // exactly the thing somebody will want to look at and replay.
    onPark: createParkingLot({ commands: connections.commands, key: env.REDIS_STREAM_KEY }),
    batchSize: env.REDIS_STREAM_BATCH_SIZE,
    blockMs: env.REDIS_STREAM_BLOCK_MS,
    handlerTimeoutMs: env.REDIS_STREAM_HANDLER_TIMEOUT_MS,
    minIdleMs: env.REDIS_STREAM_MIN_IDLE_MS,
    maxDeliveries: env.REDIS_STREAM_MAX_DELIVERIES,
    reclaimIntervalMs: env.REDIS_STREAM_RECLAIM_INTERVAL_MS,
  });

  await worker.start();
  console.log(
    `[stream worker] consuming "${env.REDIS_STREAM_KEY}" as "${consumer}" in group "${env.REDIS_STREAM_GROUP}"`,
  );

  let shuttingDown = false;

  /**
   * Draining, in the order that avoids creating duplicates.
   *
   * `worker.stop()` finishes the tick in flight before resolving, which takes
   * up to one block plus one handler. Killing the connection instead would
   * abandon a handler mid-entry: the entry would stay pending, be reclaimed,
   * and its work would run a second time — paying for a second of shutdown in
   * duplicate side effects. Only once that has returned is it safe to close the
   * connections, because the last thing the loop does is acknowledge.
   */
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[stream worker] ${signal} received, draining`);

    void worker
      .stop()
      .then(() => Promise.all([connections.close(), closePool()]))
      .then(() => {
        process.exit(0);
      })
      .catch((error: unknown) => {
        console.error('[stream worker] shutdown failed:', error);
        process.exit(1);
      });
  };

  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

main().catch((error: unknown) => {
  console.error('[stream worker] failed to start:', error);
  process.exit(1);
});
