import type { Config } from 'jest';

import base from './jest.config';

/**
 * The Postgres integration run: `pnpm test:integration`.
 *
 * A second project rather than part of `pnpm test`, and the reason is what
 * `pnpm test` is for. It is the gate a contributor runs before every commit and
 * a pre-push hook can afford to run, 2,900 tests against no external anything;
 * making it depend on a Docker socket would mean the common case — a typo in a
 * parser — is no longer checkable on a machine without one, and would add the
 * container's startup to every run of it.
 *
 * It is also not the `redis.integration.test.ts` arrangement, which lives in
 * `pnpm test` and skips itself when `REDIS_TEST_URL` is unset. That trade needs
 * a second test to stay honest — `redis.guard.test.ts`, which fails the build
 * when CI has no server — because a skipped suite is the same colour as a
 * passing one. Here there is nothing to skip and nothing to guard: these files
 * cannot run under the default config at all (`container.ts` throws a sentence
 * saying so), and the only way to run them is the command that starts the
 * server, so "the suite silently stopped running" is not a reachable state. The
 * CI job either ran or is missing from the workflow, which is visible on the
 * pull request.
 *
 * ## `maxWorkers: 1`
 *
 * One server, one database, one file at a time. These suites take row locks on
 * shared tables, provoke deadlocks, truncate between tests, and take advisory
 * locks on a namespace they assume nobody else holds — every one of which is a
 * statement about the whole database rather than about a row, and none of which
 * survives another file doing the same thing concurrently. The alternative,
 * a database per worker, buys back a few seconds on a suite that runs in well
 * under a minute, at the cost of a fixture that has to create databases from a
 * template before `setupFiles` can name one. Serial until the suite is big
 * enough for that to be the bottleneck.
 */
const config: Config = {
  ...base,
  testMatch: ['<rootDir>/src/tests/integration/**/*.integration.test.ts'],
  // `setupFiles` run in order, so `jest.setup.ts` supplies the environment
  // every suite needs and this replaces the one value it must not keep.
  setupFiles: [...(base.setupFiles ?? []), '<rootDir>/src/tests/integration/setup-env.ts'],
  setupFilesAfterEnv: ['<rootDir>/src/tests/integration/after-env.ts'],
  globalSetup: '<rootDir>/src/tests/integration/global-setup.ts',
  globalTeardown: '<rootDir>/src/tests/integration/global-teardown.ts',
  testPathIgnorePatterns: ['/node_modules/'],
  maxWorkers: 1,
  // Several tests wait a lock out on purpose. The waits are bounded in the
  // tests themselves — `lockTimeoutMs`, `deadlock_timeout` — and this is only
  // the backstop for one of those bounds not working, which is a failure worth
  // reporting as a timeout rather than as a hung run.
  testTimeout: 30_000,
};

export default config;
