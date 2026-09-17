import { describeFailure } from '@/lib/describe-error';
import { unrefTimer } from '@/lib/unref-timer';
import { HealthCheckTimeoutError } from '@/health/health.errors';
import type { CheckResult, DependencyCheck } from '@/health/health.types';

export interface RunCheckOptions {
  /** How long one check may take before it is recorded as failed. */
  readonly timeoutMs: number;
}

/**
 * Runs one check under a deadline and reduces whatever happens to a result.
 *
 * ## Why the deadline is enforced twice
 *
 * The signal is the cooperative half: it is how a check that is holding a
 * pooled client or an open socket learns to let go. It is not a bound on
 * anything, because a check that never reads its signal is unaffected by it —
 * and the checks most likely to hang are third-party clients whose cooperation
 * is exactly what is in question.
 *
 * So the race is the half that actually bounds the endpoint. Without it, a
 * dependency that accepts a connection and then stops responding turns the
 * readiness probe into a request that never answers, which a kubelet reports as
 * a *probe timeout* — the same 503 outcome with none of the information, and
 * with one hung handler per probe accumulating for as long as the fault lasts.
 *
 * Both are needed and neither substitutes for the other: the race stops the
 * endpoint hanging, the signal stops the abandoned work holding resources.
 *
 * ## The abandoned promise
 *
 * When the race is won by the deadline, `check.run` is still pending and
 * settles later — with a rejection, usually, because the abort it was just sent
 * is what the driver reports. Nothing is awaiting it by then, and an unhandled
 * rejection terminates the process on every supported Node version: a readiness
 * probe that kills the service because a dependency was slow, which is a worse
 * outage than the one it was reporting.
 *
 * It is already handled, and by `Promise.race` itself: the race subscribes to
 * every promise it is given and keeps that subscription after it has settled,
 * so the late rejection reaches a `reject` callback that has become a no-op.
 * An explicit `.catch(() => {})` alongside it is therefore dead code — it was
 * written here first, and removing it changed no test, which is what showed it
 * was never doing anything. What guards the property now is the assertion in
 * `run-check.test.ts` that no `unhandledRejection` fires, which holds whatever
 * this function is later restructured into.
 */
export async function runCheck(
  check: DependencyCheck,
  options: RunCheckOptions,
): Promise<CheckResult> {
  const { timeoutMs } = options;
  const startedAt = performance.now();
  const controller = new AbortController();
  const timeout = new HealthCheckTimeoutError(check.name, timeoutMs);

  const timer = unrefTimer(() => {
    controller.abort(timeout);
  }, timeoutMs);

  const deadline = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener(
      'abort',
      () => {
        reject(timeout);
      },
      { once: true },
    );
  });

  // Wrapped so that a synchronous throw inside `run` — a check whose
  // dependencies were constructed wrong — is caught here as a failed result
  // rather than propagating out of this function.
  const running = (async () => check.run(controller.signal))();

  try {
    await Promise.race([running, deadline]);
    return {
      name: check.name,
      criticality: check.criticality,
      status: 'ok',
      durationMs: elapsedSince(startedAt),
    };
  } catch (error) {
    return {
      name: check.name,
      criticality: check.criticality,
      status: 'failed',
      durationMs: elapsedSince(startedAt),
      // Always recorded, here. Whether it reaches a *client* is a separate
      // decision made once, at the edge, by `redactReport` — keeping it out of
      // this layer is what lets the transition log carry the reason on a
      // deployment whose responses do not.
      error: describeFailure(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Every check at once, in registration order.
 *
 * Concurrent and not sequential, and the reason is arithmetic rather than
 * speed: run in series, the worst case is the *sum* of the per-check budgets,
 * so four checks at 2s each can spend 8s answering a probe configured to give
 * up at 5 — at which point every check after the second one is work nobody will
 * read. Concurrently the worst case is the largest single budget, which is a
 * number an operator can compare against the probe's `timeoutSeconds`.
 *
 * `Promise.all` and not `allSettled`, because `runCheck` never rejects: a
 * failure is a result, and a rejection escaping here would mean one unreachable
 * dependency hid the state of all the others.
 */
export async function runChecks(
  checks: readonly DependencyCheck[],
  options: RunCheckOptions,
): Promise<readonly CheckResult[]> {
  return Promise.all(checks.map((check) => runCheck(check, options)));
}

function elapsedSince(startedAt: number): number {
  return Math.round(performance.now() - startedAt);
}
