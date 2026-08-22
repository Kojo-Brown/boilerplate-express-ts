import { existsSync } from 'node:fs';
import { extname } from 'node:path';
import {
  cpuWorkerEntry,
  hasTypeScriptLoader,
  resolveWorkerEntry,
  TS_LOADER_ARGV,
} from '@/workers/worker-entry';

describe('hasTypeScriptLoader', () => {
  it.each([
    ['tsx as a bare import', ['--import', 'tsx']],
    ['a resolved tsx path', ['--import', '/repo/node_modules/tsx/dist/loader.mjs']],
    ['ts-node/register', ['--require', 'ts-node/register']],
    ['ts-node/esm', ['--loader', 'ts-node/esm']],
  ])('detects %s', (_label, execArgv) => {
    expect(hasTypeScriptLoader(execArgv)).toBe(true);
  });

  it.each([
    ['an empty argv', []],
    ['unrelated flags', ['--max-old-space-size=4096', '--enable-source-maps']],
    // The guard against a substring match: these are not TypeScript loaders,
    // and treating them as one would leave a `.ts` entry with nothing able to
    // read it and an `ERR_UNKNOWN_FILE_EXTENSION` out of a thread.
    ['a flag merely containing "tsx"', ['--require', '/app/vendor/parsetsx.js']],
    ['a flag merely containing "ts"', ['--require', 'reports/stats.js']],
  ])('does not detect %s', (_label, execArgv) => {
    expect(hasTypeScriptLoader(execArgv)).toBe(false);
  });
});

describe('resolveWorkerEntry', () => {
  const base = { directory: '/srv/app/workers', name: 'cpu.worker' } as const;

  it('names a .js sibling and inherits execArgv when compiled', () => {
    const entry = resolveWorkerEntry({ ...base, extension: '.js', parentExecArgv: [] });

    expect(entry.path).toBe('/srv/app/workers/cpu.worker.js');
    // `undefined`, not `[]`: the two are different instructions to `new Worker`,
    // and `[]` would clear flags the parent was started with.
    expect(entry.execArgv).toBeUndefined();
  });

  it('inherits execArgv for a .ts entry when the parent already has a loader', () => {
    const entry = resolveWorkerEntry({
      ...base,
      extension: '.ts',
      parentExecArgv: ['--import', 'tsx'],
    });

    expect(entry.path).toBe('/srv/app/workers/cpu.worker.ts');
    expect(entry.execArgv).toBeUndefined();
  });

  it('injects a require hook for a .ts entry when nothing else can load it', () => {
    const entry = resolveWorkerEntry({ ...base, extension: '.ts', parentExecArgv: [] });

    expect(entry.execArgv).toEqual([...TS_LOADER_ARGV]);
  });

  it('keeps the parent flags it did not come to change', () => {
    const entry = resolveWorkerEntry({
      ...base,
      extension: '.ts',
      parentExecArgv: ['--max-old-space-size=4096'],
    });

    expect(entry.execArgv).toEqual(['--max-old-space-size=4096', ...TS_LOADER_ARGV]);
  });

  it('refuses an extension it cannot map to an emitted file', () => {
    expect(() =>
      resolveWorkerEntry({ ...base, extension: '.mjs', parentExecArgv: [] }),
    ).toThrow(/expected '\.ts' or '\.js'/);
  });
});

describe('cpuWorkerEntry', () => {
  /**
   * The assertion this whole module exists for.
   *
   * Every other test here checks the *logic* against invented inputs, which
   * cannot catch the failure that actually matters: a path that is well-formed
   * and points at nothing. That is precisely what a rename, a moved directory
   * or a change to `tsconfig.build.json`'s `rootDir` would produce, and it
   * would otherwise surface as a thread failing to start in production.
   */
  it('resolves to a file that exists in the runtime running this test', () => {
    const entry = cpuWorkerEntry();

    expect(existsSync(entry.path)).toBe(true);
    expect(extname(entry.path)).toBe(extname(__filename));
  });
});
