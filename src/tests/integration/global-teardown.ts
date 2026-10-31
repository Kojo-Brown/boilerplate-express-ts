import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';

/**
 * Stops the server the run was measured against.
 *
 * Testcontainers also starts a reaper that removes the container if this never
 * runs — a crashed worker, a `SIGKILL` — so this is the ordinary path rather
 * than the only one. It is still explicit: the reaper's timeout is measured in
 * seconds after the socket closes, and leaving a Postgres container running
 * between local runs is the kind of thing that is noticed as "my laptop is
 * slow" rather than as a leaked container.
 */
export default async function globalTeardown(): Promise<void> {
  const container = (globalThis as { __PG_CONTAINER__?: StartedPostgreSqlContainer })
    .__PG_CONTAINER__;
  if (container) await container.stop();
}
