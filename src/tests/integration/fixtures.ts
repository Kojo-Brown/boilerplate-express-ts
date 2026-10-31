import { query } from '@/db/query';

/**
 * Tables a suite owns, created on the real server before it runs.
 *
 * ## Why fixture tables rather than the application's own
 *
 * Because what the DB layer suites assert is the layer, not the schema.
 * `BaseRepository` is generic over its table; pointing its suite at `users`
 * would couple every assertion about `createMany`'s conflict handling to
 * whichever unique indexes `users` happens to carry this month, and would make
 * a migration that adds a `NOT NULL` column to `users` fail a test about
 * `ON CONFLICT DO NOTHING`. A fixture table states exactly the shape each claim
 * needs and nothing else.
 *
 * The exceptions are deliberate and are the suites where the schema *is* the
 * subject: `versioned-repository.integration.test.ts` runs against `users`,
 * because the behaviour under test is the `users_bump_version` trigger that
 * migration 1786665600000 installs, and `migrations.integration.test.ts` runs
 * against a database of its own.
 *
 * ## Why they are created and dropped per file rather than migrated
 *
 * A migration is a deployed artefact. A table that exists only so a test can
 * have a `text[]` column to prove `@>` against has no business in the
 * production schema, and adding it there would mean every deployment of this
 * boilerplate carries it forever.
 *
 * ## Why nothing drops them again
 *
 * The container is the teardown. A suite dropping its own tables in `afterAll`
 * reopens the pool that `after-env.ts` has just closed — root-level `afterAll`
 * hooks run in the order they were registered, and `setupFilesAfterEnv` is
 * registered before the test file body — leaving a connection open for the
 * container shutdown to terminate, which surfaces as a `57P01` logged by the
 * pool's own error handler after the run has reported green. The `DROP ... IF
 * EXISTS` below is what makes creation idempotent instead, so a suite is
 * unaffected by whatever an earlier one left behind, and the server is
 * destroyed at the end of the run either way.
 */
export async function createTable(name: string, columns: string): Promise<void> {
  await query(`DROP TABLE IF EXISTS "${name}" CASCADE`);
  await query(`CREATE TABLE "${name}" (${columns})`);
}

/**
 * Empties a table between tests.
 *
 * `TRUNCATE` rather than `DELETE`: it is one catalogue operation instead of a
 * scan, and — the part that matters for the locking suites — it takes an
 * `ACCESS EXCLUSIVE` lock, so a test that leaked a transaction holding a row
 * lock fails here, loudly, in the `beforeEach` of the next test, rather than
 * mysteriously in whichever later test waited on it.
 */
export async function truncate(...names: readonly string[]): Promise<void> {
  if (names.length === 0) return;
  await query(`TRUNCATE ${names.map((name) => `"${name}"`).join(', ')} CASCADE`);
}

/** The timestamp columns every fixture table modelled on the app's own carries. */
export const TIMESTAMP_COLUMNS = `
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW()
`;

/** Waits, for the few assertions whose subject is a real lock wait. */
export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A promise with its settle function, for sequencing two live transactions.
 *
 * Contention is the one thing in these suites that cannot be asserted from a
 * single connection, and orchestrating two of them with sleeps alone produces a
 * suite that passes on a fast machine and flakes on a loaded CI runner. A latch
 * makes "A holds the lock" an event B waits for rather than a duration it hopes
 * is long enough. The sleeps that remain are only ever used to show that
 * something has *not* happened yet, which is the one claim a latch cannot make.
 */
export interface Latch {
  readonly promise: Promise<void>;
  open(): void;
}

export function latch(): Latch {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

/**
 * Runs `body` while something else holds a lock, and lets go even when `body`
 * throws.
 *
 * The hand-rolled version of this — open a latch, assert, then release — has a
 * failure mode that costs more than the assertion it was reporting. A holder
 * blocked on its release latch is a transaction with a pooled connection
 * checked out, so a failing `expect` between the two abandons that connection;
 * `closePool` then waits for it, and the run reports a 30-second hook timeout
 * in `after-env.ts` instead of the assertion that actually failed. Which is the
 * least useful possible output from a test whose whole job is to be read when
 * something broke.
 *
 * `start` is handed the latch it should open once it holds the lock and the
 * promise it should wait on before letting go.
 *
 * One sharp edge, because `return await body()` unwraps whatever `body`
 * resolves to: a body that *starts* an operation which is blocked on this very
 * lock must hand it back wrapped — `return { waiter }` — rather than returning
 * the promise itself. Returned bare it is awaited before the release, and the
 * two wait for each other until one of them hits a timeout.
 */
export async function holding<T>(
  start: (signals: { held: () => void; release: Promise<void> }) => Promise<unknown>,
  body: () => Promise<T>,
): Promise<T> {
  const held = latch();
  const release = latch();
  const holder = start({ held: held.open, release: release.promise });

  try {
    // Raced against the holder so that a holder which fails *before* taking the
    // lock surfaces as its own error rather than as a hang on a latch nothing
    // will ever open.
    await Promise.race([held.promise, holder]);
    return await body();
  } finally {
    release.open();
    // Awaited, so the connection is back in the pool before the next test, and
    // caught, so a holder that exists only to hold cannot mask the error from
    // the body — which is the thing under test.
    await holder.catch(() => undefined);
  }
}
