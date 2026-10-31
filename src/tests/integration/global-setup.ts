import { runner } from 'node-pg-migrate';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import path from 'path';
import { PG_ADMIN_URL_VAR, PG_URL_VAR, POSTGRES_IMAGE } from './container';

/**
 * Starts one real PostgreSQL server for the integration run and migrates it.
 *
 * ## Why Testcontainers rather than a service in the workflow
 *
 * The CI workflow already knows how to attach a `postgres:16-alpine` service,
 * and for the one thing it uses it for — proving `pnpm migrate` applies against
 * a real server — that is the cheaper mechanism. It is the wrong one for a test
 * suite, for three reasons that are all about where the knowledge lives.
 *
 * A service block is a fact about the *workflow*. Nothing in the repository
 * states that these suites need a server, so `pnpm test:integration` on a
 * developer's machine either silently talks to whatever is listening on 5432 —
 * which on a working machine is a development database with data in it — or
 * fails with a connection error that names no cause. The container is declared
 * by the code that needs it, so the suite is runnable by anyone with a Docker
 * socket and runnable the same way everywhere.
 *
 * A service block also fixes the server *version* in the workflow, where a
 * behaviour the code depends on is not visible next to the assertion that
 * depends on it. Several of these suites assert PostgreSQL semantics —
 * `deadlock_timeout` interacting with `lock_timeout`, `SKIP LOCKED` on a
 * single-row read, the two advisory lock spaces being separate. `POSTGRES_IMAGE`
 * is beside them.
 *
 * And a service is shared, long-lived and mutable. These suites truncate
 * tables, create and drop databases, and take advisory locks on a namespace
 * they assume nobody else holds. Against a reused server those are destructive;
 * against a container that exists for the length of one run they are free.
 *
 * ## Why the migrations run here and not in each suite
 *
 * Because they are slow, deterministic, and identical for every file. The
 * migration suite is the exception and makes its own database — see
 * `migrations.integration.test.ts` — precisely so that migrating one *down* can
 * never leave the shared schema half-dismantled for whatever file ran next.
 *
 * `node-pg-migrate`'s `runner` is called directly rather than through
 * `@/db/migrate`, because the wrapper reads `@/config/env`, which validates the
 * whole environment at import time and exits the process when it cannot. That
 * environment does not exist yet here — `jest.setup.ts` is a `setupFiles` entry
 * and runs per test file, after this. The wrapper is not skipped as a result:
 * it is the subject of its own suite, where the environment does exist.
 */
export default async function globalSetup(): Promise<void> {
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer(POSTGRES_IMAGE)
    .withDatabase('app')
    .withUsername('app')
    // Obviously fake and local to a container that is destroyed at the end of
    // the run. It is written here rather than defaulted so that nothing in the
    // suite reads like a credential somebody might reuse.
    .withPassword('integration-test-password')
    .start();

  const appUrl = container.getConnectionUri();
  const adminUrl = new URL(appUrl);
  adminUrl.pathname = '/postgres';

  await runner({
    databaseUrl: appUrl,
    migrationsTable: 'pgmigrations',
    direction: 'up',
    dir: path.join(process.cwd(), 'migrations'),
    verbose: false,
  });

  process.env[PG_URL_VAR] = appUrl;
  process.env[PG_ADMIN_URL_VAR] = adminUrl.toString();

  // Read back by `global-teardown.ts`, which Jest runs in its own registry —
  // assigning the started container to a global is the documented way to hand
  // a handle between the two.
  (globalThis as { __PG_CONTAINER__?: StartedPostgreSqlContainer }).__PG_CONTAINER__ = container;
}
