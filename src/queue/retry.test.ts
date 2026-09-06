import { createFullJitterBackoffStrategy, retryJobOptions } from '@/queue/retry';
import type { RetryPolicy } from '@/queue/retry';

const POLICY: RetryPolicy = { attempts: 5, baseDelayMs: 500, maxDelayMs: 30_000 };

/** The jitter, pinned: `fullJitterDelay` draws from `[0, cap)`. */
const ALWAYS_MAX = (): number => 0.999_999;
const ALWAYS_MIN = (): number => 0;

describe('retryJobOptions', () => {
  it('names the same strategy the worker registers', () => {
    // The string itself is not exported, which is the point: the producer and
    // the worker both reach it through this file, so there is no second place
    // it could be typed differently. What a test can assert is that whatever it
    // is, `retryJobOptions` sets it — a job with no `backoff` is retried
    // immediately with no delay at all.
    expect(retryJobOptions(POLICY).backoff.type).toEqual(expect.any(String));
    expect(retryJobOptions(POLICY).backoff.type).not.toBe('');
  });

  it('carries the policy attempts through by default', () => {
    expect(retryJobOptions(POLICY).attempts).toBe(5);
  });

  it('lets a single job widen or narrow its own ceiling', () => {
    expect(retryJobOptions(POLICY, { attempts: 1 }).attempts).toBe(1);
    expect(retryJobOptions(POLICY, { attempts: 12 }).attempts).toBe(12);
  });

  it('does not carry a `delay`, which only the built-in strategies read', () => {
    // A `delay` here would look like it configured the custom strategy and
    // would in fact be ignored — the strategy closes over the policy instead.
    expect(retryJobOptions(POLICY).backoff).not.toHaveProperty('delay');
  });

  it.each([0, -1, 1.5, Number.NaN])('rejects an attempt override of %p', (attempts) => {
    expect(() => retryJobOptions(POLICY, { attempts })).toThrow(RangeError);
  });

  it('rejects a policy whose ceiling is below its first rung', () => {
    // The same invariant `env.ts` enforces at boot. Enforced twice on purpose:
    // a policy can also be constructed in code, and a ladder whose cap is below
    // its base never widens.
    expect(() =>
      retryJobOptions({ attempts: 3, baseDelayMs: 1_000, maxDelayMs: 500 }),
    ).toThrow(RangeError);
  });

  it.each([0, -3, 2.5])('rejects a policy attempt count of %p', (attempts) => {
    expect(() => retryJobOptions({ ...POLICY, attempts })).toThrow(RangeError);
  });
});

describe('createFullJitterBackoffStrategy', () => {
  it('doubles the window per attempt', () => {
    const backoff = createFullJitterBackoffStrategy(POLICY, ALWAYS_MAX);

    // `Math.floor(0.999999 * cap)` is `cap - 1` for these caps, so the ladder
    // reads as the window it draws from.
    expect(backoff(1)).toBe(499);
    expect(backoff(2)).toBe(999);
    expect(backoff(3)).toBe(1_999);
    expect(backoff(4)).toBe(3_999);
  });

  it('stops doubling at the ceiling', () => {
    const backoff = createFullJitterBackoffStrategy(POLICY, ALWAYS_MAX);

    // 500 * 2^6 is 32 000, past the 30 000 cap. This is the property BullMQ's
    // own `exponential` strategy does not have: without it, raising the attempt
    // count raises the worst-case delay exponentially and silently.
    expect(backoff(7)).toBe(29_999);
    expect(backoff(40)).toBe(29_999);
  });

  it('can return zero — the whole window is drawn from, not the top of it', () => {
    const backoff = createFullJitterBackoffStrategy(POLICY, ALWAYS_MIN);

    // Full jitter, not equal jitter. Two jobs that failed in the same instant
    // must be able to land anywhere in the window, including immediately;
    // anything with a floor re-synchronises the retry of everything that failed
    // together.
    expect(backoff(1)).toBe(0);
    expect(backoff(9)).toBe(0);
  });

  it('spreads draws across the window rather than clustering', () => {
    let seed = 0;
    // A deterministic sweep rather than `Math.random`: what is being asserted
    // is that the returned delay tracks the draw, which a real RNG would only
    // demonstrate probabilistically.
    const backoff = createFullJitterBackoffStrategy(POLICY, () => {
      seed += 0.25;
      return seed - Math.floor(seed);
    });

    expect([backoff(3), backoff(3), backoff(3), backoff(3)]).toEqual([500, 1_000, 1_500, 0]);
  });

  it.each([0, -1, 1.5, Number.NaN])(
    'clamps an attempt counter of %p to the first rung rather than returning NaN',
    (attemptsMade) => {
      const backoff = createFullJitterBackoffStrategy(POLICY, ALWAYS_MAX);

      // This runs inside BullMQ's failure path, where a NaN delay becomes
      // `moveToDelayed(NaN)` — a job that is neither runnable nor failed.
      expect(backoff(attemptsMade)).toBe(499);
    },
  );

  it('rejects a policy it could not honour', () => {
    expect(() => createFullJitterBackoffStrategy({ ...POLICY, baseDelayMs: 0 })).toThrow(
      RangeError,
    );
  });
});
