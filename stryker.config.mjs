import { readFileSync } from 'node:fs';

/**
 * Mutation testing: the gate that measures whether the test suite would notice
 * if the code changed.
 *
 * Line coverage says a line ran. It cannot say an assertion depended on it, so
 * a suite can execute a comparison, an operator and a default value and still
 * pass with all three replaced. Stryker replaces them one at a time and reruns
 * the tests; a mutant that survives is a line the suite executes without
 * checking. `docs/mutation-testing.md` is the long version, including how to
 * read a survivor and what to do about one that is not worth killing.
 *
 * What is mutated is declared in `mutation-scope.json`, not here, because
 * `jest.mutation.config.ts` has to agree with it and
 * `src/tests/mutation-scope.test.ts` has to be able to fail `pnpm test` when
 * either drifts.
 */
const scope = JSON.parse(readFileSync(new URL('./mutation-scope.json', import.meta.url), 'utf8'));

export default {
  packageManager: 'pnpm',
  testRunner: 'jest',

  // pnpm links plugins as symlinks under node_modules/@stryker-mutator/, and
  // the default `['@stryker-mutator/*']` glob does not resolve through them, so
  // both plugins load as "unknown config option" warnings and nothing else.
  // Naming them is what makes `testRunner: 'jest'` and `checkers` real.
  plugins: ['@stryker-mutator/jest-runner', '@stryker-mutator/typescript-checker'],

  jest: {
    configFile: 'jest.mutation.config.ts',
    // Narrows each mutant's run to the test files that actually import the
    // mutated module, on top of the scope's own `testMatch`.
    enableFindRelatedTests: true,
  },

  // Per-test coverage from the dry run, so a mutant runs against the tests that
  // touched it rather than against the whole file. Worth roughly 10x here.
  coverageAnalysis: 'perTest',

  // Without this, a mutant that does not compile still *runs* under ts-jest —
  // ts-jest reports the type error as a failing test, Stryker reads a failing
  // test as a killed mutant, and the score counts type errors as test strength.
  // The checker takes those out of the denominator as `CompileError` instead:
  // about a third of the mutants in this scope, which is the difference between
  // a measurement and a number.
  checkers: ['typescript'],
  tsconfigFile: 'tsconfig.json',

  mutate: scope.modules.map((module) => module.source),

  // `break` is the gate: below it, `pnpm test:mutation` exits non-zero and the
  // CI job fails. 92 against a measured 94.54, which is about sixteen mutants
  // of headroom: enough that a refactor introducing a couple of equivalent
  // mutants does not block an unrelated pull request, tight enough that a
  // deleted assertion trips it. Every one of the 34 survivors behind that
  // number has been read and is equivalent — see `docs/mutation-testing.md`.
  //
  // Raise it when the score rises. The one thing never to do is lower it to
  // make a red run green: a survivor is either worth a test, or worth a
  // `// Stryker disable` with the reason written next to it.
  thresholds: { high: 95, low: 90, break: 92 },

  // `clear-text` prints every survivor with its diff, which is the only output
  // that tells you what to do next; `html` is the same data as a browsable
  // report, and CI keeps it as an artifact so a failure can be read without
  // rerunning anything.
  reporters: ['clear-text', 'progress', 'html'],
  htmlReporter: { fileName: 'reports/mutation/index.html' },
  clearTextReporter: { maxTestsToLog: 0 },

  // Default is 5s + the dry-run time, which is tight for the suites here and
  // turns a slow mutant into a timeout — scored as killed, so it hides rather
  // than fails. 10s makes a timeout mean an infinite loop again.
  timeoutMS: 10_000,

  tempDirName: '.stryker-tmp',
  // Where `pnpm test:mutation:incremental` keeps its cache. `incremental` is left off
  // here and passed by that script alone, so CI always measures the whole scope
  // from an empty cache and only a local rerun gets to remeasure just the diff.
  incrementalFile: '.stryker-tmp/incremental.json',
};
