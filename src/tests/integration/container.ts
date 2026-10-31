/**
 * The names the container hands to the suites, and the readers that fail loudly
 * when it did not run.
 *
 * `globalSetup` and the test files are different module registries — Jest gives
 * each test file a fresh one — so the only thing that crosses from the
 * container to a suite is `process.env`. That is a documented Jest channel
 * rather than a trick, but it is also an untyped one, which is what this module
 * exists to narrow: a suite asking for a URL that was never set should fail
 * with a sentence naming the cause, not with `connect ECONNREFUSED ::1:5432`
 * forty lines into a stack trace.
 */

/** The migrated application database. `DATABASE_URL` is pointed at this. */
export const PG_URL_VAR = 'PG_INTEGRATION_URL';

/**
 * The container's maintenance database (`postgres`).
 *
 * Separate from the one above because `CREATE DATABASE` cannot run inside a
 * transaction *or* against the database being created, and two suites need a
 * database of their own: the migration suite, which migrates one down to
 * nothing, and anything else that would rather not share a schema.
 */
export const PG_ADMIN_URL_VAR = 'PG_INTEGRATION_ADMIN_URL';

/** The image the container runs, pinned so a rerun measures the same server. */
export const POSTGRES_IMAGE = 'postgres:16-alpine';

function required(name: string): string {
  const value = process.env[name] ?? '';
  if (value === '') {
    throw new Error(
      `${name} is not set. The Postgres integration suites are run by ` +
        '`pnpm test:integration`, whose Jest config starts the container in ' +
        '`globalSetup` and exports this variable. Running one of these files ' +
        'under the default `pnpm test` config will not work, and is why they ' +
        'are excluded from it.',
    );
  }
  return value;
}

/** Connection string for the migrated application database. */
export function integrationDatabaseUrl(): string {
  return required(PG_URL_VAR);
}

/** Connection string for the maintenance database. */
export function integrationAdminUrl(): string {
  return required(PG_ADMIN_URL_VAR);
}

/**
 * The same connection string pointed at another database on the same server.
 *
 * Used by the suites that create one. Built by rewriting the path of the admin
 * URL rather than by formatting host, port and credentials back together: the
 * password is percent-encoded in the URL the container produced, and
 * reassembling it by hand is how it stops being.
 */
export function urlForDatabase(databaseName: string): string {
  const url = new URL(integrationAdminUrl());
  url.pathname = `/${databaseName}`;
  return url.toString();
}
