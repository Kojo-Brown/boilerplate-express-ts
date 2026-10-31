import type { Config } from 'jest';

const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  setupFiles: ['./jest.setup.ts'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
  },
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: { module: 'commonjs', paths: { '@/*': ['./src/*'] } } }],
  },
  testMatch: ['**/*.test.ts'],
  /**
   * The Postgres integration suites are excluded, not skipped.
   *
   * They are run by `pnpm test:integration` (`jest.integration.config.ts`),
   * whose `globalSetup` starts the server they talk to. Matched here they would
   * be collected by every `pnpm test` and fail on the first connection, since
   * `DATABASE_URL` under this config deliberately names a host that is not
   * there. `src/redis/redis.integration.test.ts` and
   * `src/queue/queue.integration.test.ts` are a different arrangement and stay
   * in — they skip themselves without a server, and `redis.guard.test.ts` is
   * what keeps that from applying in CI.
   */
  testPathIgnorePatterns: ['/node_modules/', '/src/tests/integration/'],
};

export default config;
