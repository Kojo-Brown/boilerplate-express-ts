import { createApp } from '@/app';
import { env } from '@/config/env';
import { appContainer } from '@/container/app-container';
import { EVENT_BUS, IDEMPOTENCY_STORE, OUTBOX } from '@/container/tokens';
import { startIdempotencyPurgeJob } from '@/idempotency';
import { createEventBusDispatcher, startOutboxRelay } from '@/outbox';

const app = createApp();

// Started here and not in `createApp`, because a background timer belongs to
// the *process* and not to the application object: every e2e suite builds an
// app, and none of them should acquire a lock, sweep a table, or leave a
// handle behind. `server.ts` is the only file nothing imports.
//
// It is unconditional across replicas by design — each one runs the schedule
// and the advisory lock decides which of them does the work on any given tick.
// Nominating one replica instead would need a way to nominate it, which is a
// leader election, which is the thing the lock already is.
if (env.IDEMPOTENCY_PURGE_INTERVAL_SECONDS > 0) {
  startIdempotencyPurgeJob({
    store: appContainer.resolve(IDEMPOTENCY_STORE),
    intervalMs: env.IDEMPOTENCY_PURGE_INTERVAL_SECONDS * 1000,
  });
}

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
if (env.OUTBOX_RELAY_INTERVAL_SECONDS > 0) {
  startOutboxRelay({
    store: appContainer.resolve(OUTBOX),
    dispatcher: createEventBusDispatcher(appContainer.resolve(EVENT_BUS)),
    intervalMs: env.OUTBOX_RELAY_INTERVAL_SECONDS * 1000,
    batchSize: env.OUTBOX_RELAY_BATCH_SIZE,
    maxAttempts: env.OUTBOX_RELAY_MAX_ATTEMPTS,
    dispatchTimeoutMs: env.OUTBOX_DISPATCH_TIMEOUT_MS,
  });
}

app.listen(env.PORT, () => {
  console.log(`Server running on http://localhost:${env.PORT}/v1`);
});
