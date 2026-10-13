import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Config } from 'jest';

import base from './jest.config';

/**
 * The Jest configuration Stryker runs against (`stryker.config.mjs`), and the
 * reason a mutation run costs minutes instead of hours.
 *
 * It differs from `jest.config.ts` in exactly one respect: `testMatch` is the
 * unit suites of the modules in `mutation-scope.json` and nothing else. That is
 * both the cheap and the correct choice.
 *
 * Cheap, because the default `**\/*.test.ts` drags the end-to-end suites in.
 * They import `createApp()`, which imports everything, so Jest's related-test
 * resolution selects almost the whole suite for any mutant in the scope: 1h25m
 * for one run, against 8 minutes for this. Correct, because a mutant killed
 * only by an e2e request through the full stack says that *some* assertion
 * somewhere noticed, which is not what this gate claims to measure. The gate
 * measures whether the module's own suite pins the module's own behaviour down.
 *
 * `pnpm test` keeps running everything. This config is not a second opinion
 * about which tests matter; it is the mutation run's denominator.
 */
// `__dirname`, not `import.meta.url`: Jest loads this file through ts-node with
// `module: commonjs`, where `import.meta` is a compile error.
const scope: unknown = JSON.parse(readFileSync(join(__dirname, 'mutation-scope.json'), 'utf8'));

function scopedTestPaths(value: unknown): string[] {
  if (typeof value !== 'object' || value === null || !('modules' in value)) {
    throw new Error('mutation-scope.json: expected an object with a "modules" array');
  }
  const { modules } = value as { modules: unknown };
  if (!Array.isArray(modules) || modules.length === 0) {
    throw new Error('mutation-scope.json: "modules" must be a non-empty array');
  }
  return modules.flatMap((module): string[] => {
    const tests = (module as { tests?: unknown }).tests;
    if (!Array.isArray(tests) || tests.length === 0) {
      throw new Error(`mutation-scope.json: every module needs a non-empty "tests" array, got ${JSON.stringify(module)}`);
    }
    return tests.map((test) => `<rootDir>/${String(test)}`);
  });
}

const config: Config = {
  ...base,
  testMatch: scopedTestPaths(scope),
};

export default config;
