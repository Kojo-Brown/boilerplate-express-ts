import { createApp } from '@/app';
import { env } from '@/config/env';
import { appContainer } from '@/container/app-container';
import { IDEMPOTENCY_STORE } from '@/container/tokens';
import { startIdempotencyPurgeJob } from '@/idempotency';

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

app.listen(env.PORT, () => {
  console.log(`Server running on http://localhost:${env.PORT}/v1`);
});
