// First, and it has to stay first: this import starts the tracing SDK, and every
// instrumentation it installs patches its target module as that module is
// loaded. `@/app` below pulls in express, passport and pg — an SDK started after
// them patches nothing and reports no error. See `observability/register.ts`.
import { tracing } from '@/observability/register';
import { createApp } from '@/app';
import { env } from '@/config/env';
import { appContainer } from '@/container/app-container';
import { EVENT_BUS, IDEMPOTENCY_STORE, OUTBOX } from '@/container/tokens';
import { closePool, getPool } from '@/db/pool';
import { registerProcessHealthChecks } from '@/health';
import { startIdempotencyPurgeJob } from '@/idempotency';
import { appMetrics, startProcessMetrics } from '@/metrics';
import type { OutboxDispatcher } from '@/outbox';
import { createEventBusDispatcher, startOutboxRelay } from '@/outbox';
import {
  createStreamConnections,
  createStreamOutboxDispatcher,
  createStreamPublisher,
} from '@/redis';
import {
  appLifecycle,
  createGracefulShutdown,
  trackHttpServer,
  waitTask,
} from '@/shutdown';
import type { ShutdownPhase, ShutdownTask } from '@/shutdown';
import { domainEventStreamHub } from '@/sse/events.hub';
import { attachDomainWebSocketServer } from '@/ws/ws.gateway';

const app = createApp();

// Heap, RSS, file descriptors, GC pauses and event-loop lag, registered on the
// same registry `createApp` serves — so one scrape returns both the RED metrics
// and the machine they were produced on.
//
// Here and not in `createApp`, by the same rule as the timers below: what these
// describe is the *process*, and every e2e suite builds an app. They are
// pull-based, so there is no handle to release and nothing in the shutdown
// sequence answers to them.
if (env.METRICS_ENABLED && env.METRICS_DEFAULT_METRICS) {
  startProcessMetrics(appMetrics.registry);
}

/**
 * Where a claimed outbox row is delivered, which is a deployment decision
 * rather than a code one — hence an env var and not an import.
 *
 * `bus` is the default and needs nothing: the claiming replica publishes to its
 * own in-process bus, so subscribers run on whichever API replica won the row.
 * `redis-stream` appends the row's envelope to `REDIS_STREAM_KEY` instead, and
 * the consumer group in `pnpm worker:stream` decides who runs it. The number of
 * times a subscriber runs is unchanged — a group hands each entry to exactly
 * one consumer — but the work moves off the request-serving replicas.
 *
 * The connection is opened lazily, inside the branch, so the default deployment
 * never constructs a Redis client at all. `env` has already refused the
 * combination where the target is a stream and no URL was given.
 *
 * The connection is returned alongside the dispatcher rather than closed over
 * privately, because shutdown has to be able to close it: a `QUIT` is what
 * flushes the `XADD` the last relay tick issued, and dropping the socket instead
 * loses an event that the row it came from has already been deleted for.
 */
function outboxDispatcher(): {
  dispatcher: OutboxDispatcher;
  close?: () => Promise<void>;
  /** Exposed for the readiness check — present only when a connection exists. */
  ping?: () => Promise<unknown>;
} {
  if (env.OUTBOX_DISPATCH_TARGET === 'bus') {
    return { dispatcher: createEventBusDispatcher(appContainer.resolve(EVENT_BUS)) };
  }

  const connections = createStreamConnections(env.REDIS_URL);
  console.log(`[server] outbox delivering to Redis stream "${env.REDIS_STREAM_KEY}"`);

  return {
    dispatcher: createStreamOutboxDispatcher(
      createStreamPublisher({
        commands: connections.commands,
        key: env.REDIS_STREAM_KEY,
        maxLen: env.REDIS_STREAM_MAX_LEN,
      }),
    ),
    close: () => connections.close(),
    ping: () => connections.ping(),
  };
}

// Started here and not in `createApp`, because a background timer belongs to
// the *process* and not to the application object: every e2e suite builds an
// app, and none of them should acquire a lock, sweep a table, or leave a
// handle behind. `server.ts` is the only file nothing imports.
//
// It is unconditional across replicas by design — each one runs the schedule
// and the advisory lock decides which of them does the work on any given tick.
// Nominating one replica instead would need a way to nominate it, which is a
// leader election, which is the thing the lock already is.
const purgeJob =
  env.IDEMPOTENCY_PURGE_INTERVAL_SECONDS > 0
    ? startIdempotencyPurgeJob({
        store: appContainer.resolve(IDEMPOTENCY_STORE),
        intervalMs: env.IDEMPOTENCY_PURGE_INTERVAL_SECONDS * 1000,
      })
    : null;

// The other half of every `outbox.enqueue` a request performs. Here for the
// same reason the purge job is — it is a process-level timer, and an e2e suite
// that built an app should not start draining a queue — but with the opposite
// concurrency story: the purge wants exactly one replica doing the work and
// takes an advisory lock to get it, while the relay wants all of them, which is
// what `FOR UPDATE SKIP LOCKED` gives.
//
// Note what does *not* happen if this is left disabled: nothing is lost.
// Messages accumulate in `outbox_messages` and are delivered by whichever relay
// runs next, which is what makes moving it out to its own process a deployment
// decision rather than a code change.
const outbox = env.OUTBOX_RELAY_INTERVAL_SECONDS > 0 ? outboxDispatcher() : null;
const relayJob =
  outbox === null
    ? null
    : startOutboxRelay({
        store: appContainer.resolve(OUTBOX),
        dispatcher: outbox.dispatcher,
        intervalMs: env.OUTBOX_RELAY_INTERVAL_SECONDS * 1000,
        batchSize: env.OUTBOX_RELAY_BATCH_SIZE,
        maxAttempts: env.OUTBOX_RELAY_MAX_ATTEMPTS,
        dispatchTimeoutMs: env.OUTBOX_DISPATCH_TIMEOUT_MS,
      });

/**
 * What `/v1/health/ready` asks about, registered here and not in `createApp()`.
 *
 * Same rule as the two timers above: a check holds a connection to a real
 * dependency, and every e2e suite in this repository builds an app. An app
 * built by a test gets a readiness endpoint with nothing registered, which
 * answers `ok` — correct for a process that depends on nothing.
 *
 * Before `listen`, so the first probe to arrive is answered by the full set. It
 * may come later than `createApp()` because the probe reads the registry on
 * every evaluation rather than capturing it; see `ReadinessProbeOptions`.
 *
 * Postgres is `critical` by default and Redis is `optional` by default, and
 * those defaults are arguments rather than conventions — `redis.check.ts` has
 * the one that matters, which is that gating readiness on a dependency shared
 * by every replica empties the load balancer for a fault that moving traffic
 * cannot route around.
 *
 * Redis is registered only where a connection already exists. A check that
 * opened its own would be measuring a connection nothing else uses, and would
 * make a deployment with `OUTBOX_DISPATCH_TARGET=bus` — which never speaks to
 * Redis — report on a dependency it does not have.
 */
registerProcessHealthChecks({ pool: getPool, redisPing: outbox?.ping });

const server = app.listen(env.PORT, () => {
  console.log(`Server running on http://localhost:${String(env.PORT)}/v1`);
});

// Installed before the first request rather than when the signal arrives, which
// is the whole reason it is a separate call: a `request` listener attached at
// shutdown sees none of the exchanges already in flight, and those are the only
// ones a drain exists to protect. See `http-drain.ts` for what it does with them.
const httpDrain = trackHttpServer(server);

// Attached to the *server* rather than the app, and only here, because a
// WebSocket endpoint is not a route: it is a listener on the `upgrade` event of
// an `http.Server`, which `createApp` does not have and an e2e suite building an
// app should not acquire. Same rule as the timers above — this belongs to the
// process.
const wsServer = env.WS_ENABLED ? attachDomainWebSocketServer(server) : null;

if (wsServer !== null) {
  console.log(`WebSocket endpoint listening on ws://localhost:${String(env.PORT)}${env.WS_PATH}`);
}

/**
 * Shutdown, in four phases, and the order is the whole design.
 *
 * **1. unready.** `SIGTERM` has landed; `/v1/health/ready` has already gone
 * 503, because `createGracefulShutdown` moves the lifecycle to `draining`
 * before the first task runs — and `/v1/health/live` has not, deliberately, or
 * a kubelet would restart the container in the middle of its own drain. Nothing
 * is closed yet and every request is served exactly as before. The wait is the
 * balancer's chance to notice — see `waitTask`.
 *
 * **2. long-lived.** SSE streams and WebSockets, which is everything that never
 * ends on its own. They have to go before the listener is drained, or the drain
 * waits on connections that by design have no end and spends the entire budget
 * doing it. Clients are told to go away in the terms their own protocol
 * understands — an `EventSource` reconnects on its own, a 1001 "going away" is a
 * reconnect rather than an error — so they land on an instance that is staying.
 *
 * **3. in-flight.** The listener closes and the requests already running are
 * allowed to finish. The background jobs stop here too, in the same phase rather
 * than after it: neither needs the other's result, both need the pool, and both
 * are awaited to the end of whatever they had in flight — a relay tick killed
 * mid-batch redelivers everything it had already dispatched.
 *
 * **4. resources.** The pool last, because everything above it can still be
 * using it. `pool.end()` waits for checked-out clients to come back, which is
 * only quick because phase 3 already finished the work holding them.
 */
function shutdownPhases(): readonly ShutdownPhase[] {
  const inFlight: ShutdownTask[] = [
    {
      name: 'http-server',
      run: async (signal) => {
        // The state change is what turns the guard middleware on, and it belongs
        // here rather than at the top of the sequence: until the listener is
        // closed, refusing a request would be refusing one the balancer had
        // every reason to send.
        appLifecycle.beginClosing();
        const report = await httpDrain.drain({ signal });
        console.log(
          `[shutdown] http: ${report.outcome} after ${String(report.durationMs)}ms, ` +
            `${String(report.inFlightAtStart)} in flight at the start, ` +
            `${String(report.forcedConnections)} connection(s) cut off`,
        );
      },
    },
  ];

  if (purgeJob !== null) {
    inFlight.push({ name: 'idempotency-purge', run: () => purgeJob.stop() });
  }
  if (relayJob !== null) {
    inFlight.push({ name: 'outbox-relay', run: () => relayJob.stop() });
  }

  const resources: ShutdownTask[] = [{ name: 'postgres-pool', run: () => closePool() }];
  const closeOutboxRedis = outbox?.close;
  if (closeOutboxRedis !== undefined) {
    resources.push({ name: 'outbox-redis', run: () => closeOutboxRedis() });
  }

  // Last of everything, and unconditional — the handle is a no-op when tracing
  // is off, which is why it is a handle rather than a nullable.
  //
  // Last because every task above it can still be producing spans: the pool's
  // own teardown is instrumented, and a trace that ends at "began closing the
  // pool" is missing the part a slow shutdown is being investigated for. And
  // awaited, because a `BatchSpanProcessor` holds finished spans for up to its
  // scheduled delay — a process that exits without this loses the spans of the
  // last requests it served, which during a bad deploy are the only ones anybody
  // wants.
  resources.push({ name: 'tracing', run: () => tracing.shutdown() });

  return [
    {
      name: 'unready',
      tasks: [waitTask('load-balancer-drain', env.SHUTDOWN_DRAIN_DELAY_MS)],
    },
    {
      name: 'long-lived',
      tasks: [
        {
          name: 'sse-streams',
          run: () => {
            const count = domainEventStreamHub.connectionCount;
            domainEventStreamHub.closeAll('server-shutdown');
            console.log(`[shutdown] closed ${String(count)} event stream(s)`);
          },
        },
        // `wsServer.close()` resolves once `ws` has finished tearing every
        // socket down, and awaiting it is what keeps phase 3 from meeting
        // sockets that are still closing.
        { name: 'websockets', run: () => wsServer?.close() },
      ],
    },
    { name: 'in-flight', tasks: inFlight },
    { name: 'resources', tasks: resources },
  ];
}

createGracefulShutdown({
  lifecycle: appLifecycle,
  phases: shutdownPhases(),
  timeoutMs: env.SHUTDOWN_TIMEOUT_MS,
}).install();
