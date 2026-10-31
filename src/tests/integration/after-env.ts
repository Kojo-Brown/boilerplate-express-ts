import { closePool } from '@/db/pool';

/**
 * Closes the pool each test file opened.
 *
 * `getPool()` memoises per module registry and Jest gives each test file its
 * own, so every file that touches the database opens a pool of its own and has
 * to end it: an open pool is an open socket, and Jest reports a file that
 * leaves one as a run that would not exit, after a ten-second wait, with a
 * message that does not say which file. Registered here rather than copied into
 * six `afterAll`s so that a new suite cannot forget it.
 *
 * `closePool` is idempotent — it clears its own reference — so a suite that
 * closes the pool itself is not broken by this running after it.
 */
afterAll(async () => {
  await closePool();
});
