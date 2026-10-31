import { integrationDatabaseUrl } from './container';

/**
 * Points `DATABASE_URL` at the container.
 *
 * Listed in `setupFiles` *after* `jest.setup.ts`, which is what makes this the
 * narrow change rather than an edit to the shared setup. `jest.setup.ts` sets
 * `DATABASE_URL` to a host and database that do not exist, deliberately: under
 * the default config nothing may reach a real server, so a unit test that
 * forgot to mock the query layer fails instead of quietly passing against
 * whatever database the machine happens to have. Relaxing that file to defer to
 * an existing value would weaken every unit test in the repository to configure
 * these six files, and it would do it invisibly — a developer with
 * `DATABASE_URL` exported in their shell would get a different `pnpm test` from
 * CI's.
 *
 * So the override lives in the integration config, where it applies to the
 * files that want it and to nothing else.
 */
process.env['DATABASE_URL'] = integrationDatabaseUrl();
