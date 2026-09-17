import { DuplicateHealthCheckError } from '@/health/health.errors';
import type { DependencyCheck } from '@/health/health.types';

/**
 * What this process's readiness probe asks about, contributed by whoever opened
 * the connection rather than listed here.
 *
 * The same composition-root shape as `registerErrorTranslator`, and for the
 * same reason: this module must not import `pg` or `ioredis`, or a deployment
 * that runs neither still pays for both. What it costs instead is the rule
 * that something has to remember to register — which is why the process's own
 * set is one function, `registerProcessHealthChecks`, with a test asserting
 * it: the failure mode of forgetting is a permanently green probe, and nobody
 * goes looking at a green probe.
 *
 * Registration lives in `server.ts` and not in `createApp()`, by the rule the
 * purge job, the outbox relay and the process metrics already follow: a check
 * holds a real connection to a real dependency, and every e2e suite in this
 * repository builds an app. An app built by a test gets an endpoint with no
 * checks registered, which answers `ok` with an empty list — correct, because a
 * process that depends on nothing is ready as soon as it is listening.
 */
const checks: DependencyCheck[] = [];

export function registerHealthCheck(check: DependencyCheck): void {
  // By name, not by identity: `createPostgresCheck` returns a fresh object each
  // call, so identity would let a second registration through and produce a
  // report naming the same dependency twice.
  if (checks.some((existing) => existing.name === check.name)) {
    throw new DuplicateHealthCheckError(check.name);
  }

  checks.push(check);
}

/**
 * Frozen, because the probe hands this list to `runChecks` on every evaluation
 * and a caller that sorted it in place would reorder a report that an operator
 * reads positionally.
 */
export function registeredHealthChecks(): readonly DependencyCheck[] {
  return Object.freeze([...checks]);
}

/**
 * Empties the registry.
 *
 * Exported for the suites that assert registration itself — a module-level list
 * survives between tests in one file, and a test that registers a fake would
 * otherwise leak it into the next. Nothing in `src/` outside a test calls this:
 * a running process registers its dependencies once, at boot, and un-checking
 * one at runtime would mean readiness quietly stopped asking about it.
 */
export function clearHealthChecks(): void {
  checks.length = 0;
}
