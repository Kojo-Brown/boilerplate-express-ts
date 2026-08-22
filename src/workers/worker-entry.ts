import { extname, join } from 'node:path';

/**
 * Where the worker entry point is, and what the thread needs on its command
 * line to be able to load it.
 *
 * This is the one genuinely awkward part of using `worker_threads` from a
 * TypeScript service, and it is awkward for a structural reason rather than a
 * fixable one. Every other module in this codebase is named by a *specifier*
 * that some resolver interprets — ts-jest maps `@/`, `tsx` transpiles on
 * require, `tsc` type-checks. A worker entry is named by a **path on disk**,
 * handed to a fresh V8 isolate that inherits none of that. So the file the pool
 * points at has to exist, in that exact spelling, under three different
 * runtimes:
 *
 * | Runtime                | `__filename` ext | Entry on disk    | Loader needed |
 * |------------------------|------------------|------------------|---------------|
 * | `node dist/server.js`  | `.js`            | `cpu.worker.js`  | none          |
 * | `pnpm dev` (tsx)       | `.ts`            | `cpu.worker.ts`  | inherited     |
 * | `pnpm test` (ts-jest)  | `.ts`            | `cpu.worker.ts`  | injected      |
 *
 * Deriving the extension from `__filename` rather than from `NODE_ENV` is what
 * makes that table collapse to one line of code: whatever extension *this*
 * module was loaded with is, by construction, the extension the sibling entry
 * was emitted with.
 */

export interface WorkerEntry {
  /** Absolute path passed to `new Worker(...)`. */
  readonly path: string;
  /**
   * `execArgv` for the thread, or `undefined` to inherit the parent's.
   *
   * `undefined` and `[]` are not the same thing: `[]` explicitly clears the
   * parent's flags, which under `tsx` removes the very loader that would let
   * the thread read a `.ts` file.
   */
  readonly execArgv?: readonly string[];
}

export interface ResolveWorkerEntryOptions {
  /** Directory holding the entry file — normally the pool module's `__dirname`. */
  readonly directory: string;
  /** Entry basename without extension, e.g. `'cpu.worker'`. */
  readonly name: string;
  /** The extension the *caller* was loaded with: `'.ts'` or `'.js'`. */
  readonly extension: string;
  /** The parent's `process.execArgv`. */
  readonly parentExecArgv: readonly string[];
}

/**
 * The require hook injected when nothing else will compile TypeScript.
 *
 * `transpile-only` rather than the type-checking default for two reasons: a
 * worker that type-checks its own graph on every spawn turns a ~30ms thread
 * start into a multi-second one, paid again on every crash replacement; and
 * type errors are already a gate of their own (`pnpm typecheck`), so
 * rediscovering them at thread-start time can only ever fail something that
 * was going to fail anyway, later and less legibly.
 *
 * `ts-node` is a devDependency, which is exactly right and not an oversight:
 * this branch is reachable only when the entry is a `.ts` file, and a `.ts`
 * file on disk means the service is running from source, which means dev
 * dependencies are installed. A production install has `cpu.worker.js` and
 * never looks for a loader.
 */
export const TS_LOADER_ARGV: readonly string[] = ['--require', 'ts-node/register/transpile-only'];

/**
 * True if `execArgv` already installs something that can require a `.ts` file.
 *
 * Matched on the flag *values* rather than by asking the runtime what it is,
 * because there is no such question to ask: `tsx` and `ts-node` both work by
 * putting themselves on the command line, and the command line is therefore
 * the authoritative record of whether a child thread will inherit one. Worker
 * threads inherit `process.execArgv` by default, so when this returns true the
 * correct action is to pass nothing and let that inheritance happen.
 */
export function hasTypeScriptLoader(execArgv: readonly string[]): boolean {
  return execArgv.some((arg) => /(^|[/\\])tsx($|[/\\@])|ts-node/.test(arg));
}

export function resolveWorkerEntry(options: ResolveWorkerEntryOptions): WorkerEntry {
  const { directory, name, extension, parentExecArgv } = options;

  if (extension !== '.ts' && extension !== '.js') {
    // Reached if this file is ever bundled, or loaded as `.cjs`/`.mjs`. Better
    // to say so here than to hand `new Worker` a path ending in the wrong
    // extension and read `ERR_MODULE_NOT_FOUND` out of a thread.
    throw new Error(
      `resolveWorkerEntry: cannot infer a worker entry extension from ${JSON.stringify(extension)}; expected '.ts' or '.js'`,
    );
  }

  const path = join(directory, `${name}${extension}`);

  if (extension === '.js' || hasTypeScriptLoader(parentExecArgv)) {
    return { path };
  }

  // A `.ts` entry under a runtime whose loader does not propagate — jest, whose
  // transform is a property of its own module registry and stops at the thread
  // boundary. The parent's flags are kept rather than replaced: dropping
  // something like `--max-old-space-size` because we needed to add a require
  // hook would be a surprising side effect of an unrelated decision.
  return { path, execArgv: [...parentExecArgv, ...TS_LOADER_ARGV] };
}

/** The entry for `cpu.worker`, resolved for whatever runtime is loading this. */
export function cpuWorkerEntry(): WorkerEntry {
  return resolveWorkerEntry({
    directory: __dirname,
    name: 'cpu.worker',
    extension: extname(__filename),
    parentExecArgv: process.execArgv,
  });
}
