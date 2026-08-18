export interface BackoffOptions {
  /** Delay ceiling for the first retry; doubles per attempt. */
  readonly baseMs: number;
  /** Ceiling for any single step, however many attempts have passed. */
  readonly maxMs: number;
  /** Injected so a test can pin the jitter. */
  readonly random?: () => number;
}

/**
 * Full jitter: a uniform draw from `[0, min(maxMs, baseMs * 2^(attempt-1)))`.
 *
 * Full rather than equal jitter or a fixed step, and the reason is what fails
 * together. Clients that failed at the same instant — because one dependency
 * went down, or one row became hot — are on the same schedule, so a fixed
 * backoff re-synchronises them and the retry arrives as a single spike that
 * fails the recovery the same way the original outage did. Equal jitter halves
 * the spike; full jitter spreads the whole window.
 *
 * `attempt` is 1-based: the delay *before* the second try is `attempt = 1`.
 */
export function fullJitterDelay(attempt: number, options: BackoffOptions): number {
  const { baseMs, maxMs, random = Math.random } = options;
  const cap = Math.min(maxMs, baseMs * 2 ** (attempt - 1));
  return Math.floor(random() * cap);
}
