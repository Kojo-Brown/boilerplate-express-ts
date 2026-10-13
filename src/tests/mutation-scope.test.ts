import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { z } from 'zod';

/**
 * The test that stops the mutation gate from measuring nothing.
 *
 * `pnpm test:mutation` mutates the modules listed in `mutation-scope.json` and
 * fails under `thresholds.break`. Every way that gate can quietly stop meaning
 * anything is a rename:
 *
 *   - A source file moves. Stryker's `mutate` glob matches nothing, it logs one
 *     line, and the score for the files that remain goes *up* — because the
 *     weakest-covered module just left the denominator.
 *   - A test file moves. `jest.mutation.config.ts` has no suite for that module
 *     any more, its mutants all survive, and the next person to see red reaches
 *     for the threshold.
 *   - `testMatch` is widened back to the default. Mutants start getting killed
 *     by end-to-end requests through `createApp()`, the score rises, and it no
 *     longer says anything about the unit suites.
 *   - The `break` threshold is removed. `stryker run` then exits 0 at any
 *     score at all and the CI job goes green on a suite that asserts nothing.
 *
 * None of those four is a failing test anywhere else, which is why they are
 * failing tests here. The structural checks are cheap; the two that read the
 * real resolved configs shell out, because `stryker.config.mjs` is ESM and
 * `jest.mutation.config.ts` is loaded by Jest through ts-node, and asserting on
 * either one's source text would pass on a file that no longer parses.
 */

const REPO_ROOT = resolve(__dirname, '..', '..');
const SCOPE_FILE = join(REPO_ROOT, 'mutation-scope.json');

const relativeSourcePath = z
  .string()
  .regex(/^src\/[\w./-]+\.ts$/, 'must be a repo-relative path under src/ ending in .ts')
  .refine((value) => !value.endsWith('.test.ts'), 'a test file is not a mutation target')
  .refine((value) => !value.endsWith('.fixture.ts'), 'a fixture is not a mutation target');

const scopeSchema = z.object({
  comment: z.array(z.string()).nonempty(),
  modules: z
    .array(
      z.object({
        source: relativeSourcePath,
        tests: z
          .array(z.string().regex(/^src\/[\w./-]+\.test\.ts$/, 'must be a repo-relative *.test.ts path under src/'))
          .nonempty(),
        // Not decoration. The admission rule in the file's own `comment` is
        // that every dependency arrives as an argument; an entry that cannot
        // say why it qualifies is an entry nobody checked against that rule.
        why: z.string().min(40),
      }),
    )
    .nonempty(),
});

type Scope = z.infer<typeof scopeSchema>;

const scope: Scope = scopeSchema.parse(JSON.parse(readFileSync(SCOPE_FILE, 'utf8')));

/** Every path the scope names, so a rename cannot leave a glob matching nothing. */
const declaredSources = scope.modules.map((module) => module.source);
const declaredTests = scope.modules.flatMap((module) => module.tests);

describe('mutation scope', () => {
  it('names each module once', () => {
    expect(declaredSources).toHaveLength(new Set(declaredSources).size);
    expect(declaredTests).toHaveLength(new Set(declaredTests).size);
  });

  it.each(declaredSources)('mutates a file that exists: %s', (source) => {
    expect(existsSync(join(REPO_ROOT, source))).toBe(true);
  });

  it.each(declaredTests)('runs a suite that exists: %s', (test) => {
    expect(existsSync(join(REPO_ROOT, test))).toBe(true);
  });

  it.each(scope.modules.map((module) => [module.source, module.tests] as const))(
    'pairs %s with a suite that imports it',
    (source, tests) => {
      // A `tests` entry that does not import its module measures nothing: its
      // mutants survive for want of an importer, not for want of an assertion.
      // Both import forms are accepted because both appear in this repo — the
      // `@/` alias across modules, a relative path within one.
      const moduleSpecifier = source.replace(/^src\//, '@/').replace(/\.ts$/, '');
      const bareName = source.replace(/^.*\//, '').replace(/\.ts$/, '');

      for (const test of tests) {
        const body = readFileSync(join(REPO_ROOT, test), 'utf8');
        const importsViaAlias = body.includes(`'${moduleSpecifier}'`);
        const importsRelatively = new RegExp(`from '\\.{1,2}/[\\w./-]*${bareName}'`).test(body);
        expect(importsViaAlias || importsRelatively).toBe(true);
      }
    },
  );
});

describe('mutation gate', () => {
  it('mutates exactly the declared scope, and keeps a break threshold', () => {
    // Reads the resolved config rather than the file: `mutate` is computed from
    // `mutation-scope.json` there, and the point is to catch it being replaced
    // by a hand-written list — or by a list with one path quietly removed.
    const resolved: unknown = JSON.parse(
      execFileSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          "const m = await import('./stryker.config.mjs'); process.stdout.write(JSON.stringify(m.default));",
        ],
        { cwd: REPO_ROOT, encoding: 'utf8' },
      ),
    );

    const config = z
      .object({
        mutate: z.array(z.string()),
        thresholds: z.object({ break: z.number().min(1).max(100) }),
      })
      .parse(resolved);

    expect([...config.mutate].sort()).toEqual([...declaredSources].sort());
  });

  it('measures the scope against its own unit suites and nothing else', () => {
    // `--listTests` is the resolved answer to "which suites does a mutant run
    // against", which is the mutation score's denominator. Widening it back to
    // the default `**/*.test.ts` is the one drift that makes the score go up
    // while meaning less, so it is asserted exactly rather than as a subset.
    const listed = execFileSync(
      process.execPath,
      [join(REPO_ROOT, 'node_modules', 'jest', 'bin', 'jest.js'), '--config', 'jest.mutation.config.ts', '--listTests'],
      { cwd: REPO_ROOT, encoding: 'utf8' },
    );

    const found = listed
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '')
      .map((absolute) => absolute.slice(REPO_ROOT.length + 1));

    expect(found.sort()).toEqual([...declaredTests].sort());
  });
});
