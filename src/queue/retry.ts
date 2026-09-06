import type { BackoffStrategy } from 'bullmq';
import { fullJitterDelay } from '@/lib/backoff';
import type { EnqueueOptions } from '@/queue/queue.types';

/**
 * The retry ladder, declared once because BullMQ splits it across two
 * processes.
 *
 * How many attempts a job gets is a **job** option, written into Redis by the
 * producer when the job is added. Which delays sit between those attempts is a
 * **worker** setting, resolved on the machine that runs the job. That split is
 * not a wart — a deployment genuinely can change its backoff without
 * re-enqueuing anything — but it means the two ends have to agree about a
 * string, and BullMQ's failure mode when they do not is unusually bad: a job
 * carrying `backoff: { type: 'full-jitter' }` that fails on a worker with no
 * such strategy registered makes `lookupStrategy` throw from inside
 * `Job#moveToFailed`, i.e. from the code path whose entire job is to handle a
 * throw. The original failure is lost and the worker reports something else.
 *
 * So neither end names the strategy: `retryJobOptions` and
 * `createFullJitterBackoffStrategy` both take one `RetryPolicy` and both use
 * the constant below, and the composition roots derive that policy from the
 * same environment variables.
 */

/**
 * The strategy name shared by the producer's job options and the worker's
 * settings. Not exported for callers to type out — it exists so that the two
 * functions in this file cannot disagree.
 */
const FULL_JITTER_STRATEGY = 'full-jitter';

export interface RetryPolicy {
  /**
   * Total runs of a job before it is dead-lettered, counting the first.
   *
   * Finite because the alternative is a job that fails forever occupying a
   * worker slot for the life of the deployment. `1` means no retries at all,
   * which is a legitimate choice for work that a later job will redo anyway.
   */
  readonly attempts: number;
  /** Ceiling on the first retry's delay; the window doubles per attempt. */
  readonly baseDelayMs: number;
  /** Ceiling on any single delay, however many attempts have passed. */
  readonly maxDelayMs: number;
}

function assertPolicy(policy: RetryPolicy, caller: string): void {
  const { attempts, baseDelayMs, maxDelayMs } = policy;

  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new RangeError(`${caller}: attempts must be an integer >= 1, received ${String(attempts)}`);
  }
  if (!Number.isInteger(baseDelayMs) || baseDelayMs < 1) {
    throw new RangeError(
      `${caller}: baseDelayMs must be an integer >= 1, received ${String(baseDelayMs)}`,
    );
  }
  if (!Number.isInteger(maxDelayMs) || maxDelayMs < baseDelayMs) {
    throw new RangeError(
      `${caller}: maxDelayMs must be an integer >= baseDelayMs (${baseDelayMs}), ` +
        `received ${String(maxDelayMs)}`,
    );
  }
}

/**
 * The job options that make a job retryable under `policy`.
 *
 * `attempts` may be overridden per job (`EnqueueOptions.attempts`); the
 * strategy name may not, which is the point of routing it through here.
 */
export function retryJobOptions(
  policy: RetryPolicy,
  overrides: Pick<EnqueueOptions, 'attempts'> = {},
): { attempts: number; backoff: { type: string } } {
  assertPolicy(policy, 'retryJobOptions');

  const attempts = overrides.attempts ?? policy.attempts;
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new RangeError(
      `retryJobOptions: attempts override must be an integer >= 1, received ${String(attempts)}`,
    );
  }

  // No `delay` field: it is only read by the two built-in strategies, and
  // passing one here would suggest the custom strategy honours it.
  return { attempts, backoff: { type: FULL_JITTER_STRATEGY } };
}

/**
 * Full jitter with a ceiling — the same ladder the outbox relay climbs.
 *
 * BullMQ 6 ships `exponential` with a `jitter` fraction, and `jitter: 1` is
 * arithmetically identical to full jitter. It is not used here because it has
 * no cap: the window is `2^(attempt-1) * delay` for as many attempts as the job
 * has, so a queue that raises `attempts` from 5 to 12 silently turns a 16-second
 * worst case into a two-hour one. `fullJitterDelay` takes `maxMs`, so the two
 * numbers stay independent — which is what lets "how many times" and "how long
 * between" be separate operational decisions.
 *
 * Reusing `@/lib/backoff` rather than reimplementing it is the other half:
 * five things in this service now back off — the outbox relay, the stream
 * worker's reconnect loop, `withRetry`, the serialisation-failure retry in
 * `retry-transaction.ts`, and this — and the reason for *full* jitter, that
 * everything which failed together would otherwise retry together and hand the
 * recovering dependency the same spike that took it down, is written down once
 * where it can be read.
 *
 * BullMQ calls the strategy with `attemptsMade + 1`, so the argument is already
 * the 1-based attempt number `fullJitterDelay` documents: `1` is the delay
 * before the second run.
 */
export function createFullJitterBackoffStrategy(
  policy: RetryPolicy,
  random: () => number = Math.random,
): BackoffStrategy {
  assertPolicy(policy, 'createFullJitterBackoffStrategy');

  return function fullJitterBackoff(attemptsMade: number): number {
    // Guard rather than trust: this is called from BullMQ's failure path, and a
    // NaN delay there becomes `moveToDelayed(NaN)` — a job that is neither
    // runnable nor failed. Clamping to the first rung is the conservative
    // reading of an attempt counter we did not compute.
    const attempt = Number.isInteger(attemptsMade) && attemptsMade >= 1 ? attemptsMade : 1;

    return fullJitterDelay(attempt, {
      baseMs: policy.baseDelayMs,
      maxMs: policy.maxDelayMs,
      random,
    });
  };
}
