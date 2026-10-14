import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import fc from 'fast-check';

import { DEFAULT_PROPERTY_SEED, PROPERTY_RUNS, PROPERTY_SEED, resolveSeed } from '@/tests/property';

/**
 * The test that stops the property suites from quietly running on nothing.
 *
 * `src/tests/property.ts` configures fast-check globally as an import side
 * effect, which is the only way a configuration can cover suites spread across
 * the tree — Jest gives each test file its own module registry, so there is no
 * shared "before all" above them. That design has exactly one weakness, and it
 * is the one asserted here: a property file that does not import the module
 * runs at fast-check's defaults instead. It would still pass, still be counted,
 * and be sampling a tenth of the cases its neighbours do against an unpinned
 * seed — a suite that is green for a reason nobody chose.
 *
 * The companion failure is the configuration itself being edited down.
 * `numRuns: 1` is a one-character change that turns every property in the
 * repository into a single example and nothing anywhere goes red.
 */

const SOURCE_ROOT = resolve(__dirname, '..');

/** Every `*.property.test.ts` under `src/`, found rather than listed. */
function propertySuites(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : propertySuites(path);
    return entry.isFile() && entry.name.endsWith('.property.test.ts') ? [path] : [];
  });
}

const suites = propertySuites(SOURCE_ROOT);

describe('property testing configuration', () => {
  it('is what the suites actually run under', () => {
    expect(fc.readConfigureGlobal()).toMatchObject({ seed: PROPERTY_SEED, numRuns: PROPERTY_RUNS });
  });

  it('samples enough cases for a property to mean more than an example', () => {
    expect(PROPERTY_RUNS).toBeGreaterThanOrEqual(100);
  });

  it('pins the seed, so a red build is a diff and not a draw', () => {
    // The gate is reproducible; `FC_SEED` overrides it for a deliberate
    // exploration run. A property that only fails under some seeds is a
    // property with a counterexample nobody has written down yet, and the fix
    // for it is an example test carrying the shrunk value.
    expect(Number.isSafeInteger(PROPERTY_SEED)).toBe(true);
    expect(resolveSeed(undefined)).toBe(DEFAULT_PROPERTY_SEED);
    expect(resolveSeed('-7')).toBe(-7);
    // Not a number, so not a seed: `FC_SEED=yes` must not quietly become 0.
    expect(resolveSeed('yes')).toBe(DEFAULT_PROPERTY_SEED);
    expect(resolveSeed('1e400')).toBe(DEFAULT_PROPERTY_SEED);
  });
});

describe('property suites', () => {
  it('exist, so this file is not guarding an empty set', () => {
    expect(suites.length).toBeGreaterThan(0);
  });

  it.each(suites.map((path) => relative(SOURCE_ROOT, path)))(
    'runs under the shared configuration: %s',
    (suite) => {
      const body = readFileSync(join(SOURCE_ROOT, suite), 'utf8');
      expect(body).toMatch(/from '@\/tests\/property'/);
    },
  );
});
