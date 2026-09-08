import { AppError } from '@/lib/errors';
import { CircuitBreaker, CircuitOpenError } from '@/resilience/circuit-breaker';
import type { CircuitBreakerOptions, CircuitStateChange } from '@/resilience/circuit-breaker';

/** A clock the test moves by hand, so no case below waits for anything. */
function testClock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let current = start;
  return {
    now: () => current,
    advance: (ms) => {
      current += ms;
    },
  };
}

function makeBreaker(
  overrides: Partial<CircuitBreakerOptions> = {},
): { breaker: CircuitBreaker; clock: ReturnType<typeof testClock>; changes: CircuitStateChange[] } {
  const clock = testClock();
  const changes: CircuitStateChange[] = [];
  const breaker = new CircuitBreaker({
    name: 'payments',
    windowMs: 10_000,
    bucketCount: 10,
    failureRateThreshold: 0.5,
    minimumThroughput: 4,
    openMs: 30_000,
    // Pinned off unless a case is about the jitter, so `openMs` is exact.
    openJitterRatio: 0,
    now: clock.now,
    random: () => 0,
    onStateChange: (change) => changes.push(change),
    ...overrides,
  });
  return { breaker, clock, changes };
}

/** Drives `count` failures through the breaker. */
function fail(breaker: CircuitBreaker, count: number): void {
  for (let i = 0; i < count; i += 1) breaker.acquire().fail();
}

function succeed(breaker: CircuitBreaker, count: number): void {
  for (let i = 0; i < count; i += 1) breaker.acquire().succeed();
}

/** The `Retry-After` an open breaker refuses with, or `undefined` if it admits. */
function retryAfterOf(breaker: CircuitBreaker): string | undefined {
  try {
    breaker.acquire().ignore();
    return undefined;
  } catch (err) {
    return err instanceof CircuitOpenError ? err.headers?.['Retry-After'] : undefined;
  }
}

describe('CircuitBreaker', () => {
  describe('configuration', () => {
    it('refuses nonsense at construction rather than at the incident', () => {
      expect(() => makeBreaker({ failureRateThreshold: 0 })).toThrow(RangeError);
      expect(() => makeBreaker({ failureRateThreshold: 1.5 })).toThrow(RangeError);
      expect(() => makeBreaker({ minimumThroughput: 0 })).toThrow(RangeError);
      expect(() => makeBreaker({ openMs: 0 })).toThrow(RangeError);
      expect(() => makeBreaker({ bucketCount: 2.5 })).toThrow(RangeError);
      expect(() => makeBreaker({ openJitterRatio: 1 })).toThrow(RangeError);
    });

    it('refuses a window too short to hold its own buckets', () => {
      // A bucket spanning less than a millisecond cannot advance, so the window
      // would never slide and the breaker would count history forever.
      expect(() => makeBreaker({ windowMs: 5, bucketCount: 10 })).toThrow(/windowMs/);
    });
  });

  describe('closed', () => {
    it('admits everything and stays closed while the dependency answers', () => {
      const { breaker } = makeBreaker();
      succeed(breaker, 20);
      expect(breaker.state).toBe('closed');
    });

    it('does not trip below the minimum throughput, however bad the rate', () => {
      const { breaker } = makeBreaker({ minimumThroughput: 4 });

      fail(breaker, 3);

      // Three failures out of three is a 100% failure rate. A breaker that
      // opened here would convert one bad health check into 30 seconds of
      // guaranteed outage — the reason the volume gate exists at all.
      expect(breaker.stats().failureRate).toBe(1);
      expect(breaker.state).toBe('closed');
    });

    it('trips once the rate is reached with enough volume behind it', () => {
      const { breaker, changes } = makeBreaker({ minimumThroughput: 4 });

      succeed(breaker, 2);
      fail(breaker, 2);

      expect(breaker.state).toBe('open');
      expect(changes).toEqual([
        expect.objectContaining({ name: 'payments', from: 'closed', to: 'open', failureRate: 0.5 }),
      ]);
    });

    it('forgets outcomes that fall out of the window', () => {
      const { breaker, clock } = makeBreaker({ windowMs: 10_000, bucketCount: 10 });

      fail(breaker, 3);
      // Two failures short of tripping, then the window moves past them.
      clock.advance(10_000);
      fail(breaker, 3);

      // Still three failures in the window rather than six: a dependency that
      // failed hard earlier and has been quiet since is not one bad response
      // away from tripping.
      expect(breaker.stats().failures).toBe(3);
      expect(breaker.state).toBe('closed');
    });

    it('slides the window rather than resetting it', () => {
      const { breaker, clock } = makeBreaker({ windowMs: 10_000, bucketCount: 10 });

      fail(breaker, 3);
      // Half a window later the earlier failures must still count — the
      // difference between a sliding window and a counter that clears on a
      // timer, and the reason a breaker cannot be built out of `setInterval`.
      clock.advance(5_000);
      expect(breaker.stats().failures).toBe(3);

      fail(breaker, 1);
      expect(breaker.state).toBe('open');
    });
  });

  describe('open', () => {
    it('refuses without calling the dependency, and says when to come back', () => {
      const { breaker, clock } = makeBreaker({ openMs: 30_000 });
      succeed(breaker, 2);
      fail(breaker, 2);

      clock.advance(5_000);

      let thrown: unknown;
      try {
        breaker.acquire();
      } catch (err) {
        thrown = err;
      }

      expect(thrown).toBeInstanceOf(CircuitOpenError);
      expect(thrown).toBeInstanceOf(AppError);
      const err = thrown as CircuitOpenError;
      expect(err.statusCode).toBe(503);
      expect(err.code).toBe('CIRCUIT_OPEN');
      expect(err.circuitName).toBe('payments');
      // 25 of the 30 seconds are left, and the header is the actionable half of
      // the answer rather than decoration.
      expect(err.headers).toEqual({ 'Retry-After': '25' });
    });

    it('never advertises Retry-After: 0, which reads as "retry now"', () => {
      const { breaker, clock } = makeBreaker({ openMs: 30_000 });
      succeed(breaker, 2);
      fail(breaker, 2);

      clock.advance(29_600);
      // 400ms left, which rounds to a second rather than to nothing.
      expect(retryAfterOf(breaker)).toBe('1');
    });

    it('spreads the probe instant across replicas that tripped together', () => {
      // Every replica trips at the same moment for the same reason, so an
      // unjittered window sends all of them at the recovering dependency in one
      // tick. The jitter is applied to the last fifth: the floor stays a real
      // pause, and `random: () => 0` picks the earliest instant in it.
      const early = makeBreaker({ openMs: 10_000, openJitterRatio: 0.2, random: () => 0 });
      const late = makeBreaker({ openMs: 10_000, openJitterRatio: 0.2, random: () => 0.999 });

      for (const { breaker } of [early, late]) {
        succeed(breaker, 2);
        fail(breaker, 2);
      }

      early.clock.advance(8_000);
      late.clock.advance(8_000);
      expect(early.breaker.state).toBe('half-open');
      expect(late.breaker.state).toBe('open');

      late.clock.advance(2_000);
      expect(late.breaker.state).toBe('half-open');
    });

    it('is not held open by a slow attempt that started before it tripped', () => {
      const { breaker, clock } = makeBreaker({ openMs: 30_000 });
      succeed(breaker, 2);
      const straggler = breaker.acquire();
      fail(breaker, 2);
      expect(breaker.state).toBe('open');

      clock.advance(29_000);
      // The straggler lands a second before the probe was due. Recording it is
      // right; re-tripping on it would push the probe out by another full
      // window every time a slow request from before the outage lands, which is
      // how a circuit stays open long after the dependency came back.
      straggler.fail();

      clock.advance(1_000);
      expect(breaker.state).toBe('half-open');
    });
  });

  describe('half-open', () => {
    function openThenExpire(overrides: Partial<CircuitBreakerOptions> = {}): ReturnType<
      typeof makeBreaker
    > {
      const harness = makeBreaker({ openMs: 30_000, ...overrides });
      succeed(harness.breaker, 2);
      fail(harness.breaker, 2);
      harness.clock.advance(30_000);
      return harness;
    }

    it('admits one probe and refuses the rest of the traffic', () => {
      const { breaker } = openThenExpire();

      const probe = breaker.acquire();
      expect(breaker.stats().probesInFlight).toBe(1);

      // The question is "is it back". Asking it ten times in parallel is the
      // herd again, aimed at the moment the dependency can least absorb it.
      expect(() => breaker.acquire()).toThrow(CircuitOpenError);
      probe.succeed();
    });

    it('closes on a probe success and starts the window empty', () => {
      const { breaker, changes } = openThenExpire();

      breaker.acquire().succeed();

      expect(breaker.state).toBe('closed');
      // The failures that opened the circuit are gone. Carrying them over would
      // leave a recovered dependency one unrelated 500 from re-tripping, and
      // the circuit would flap for a full window after every incident.
      expect(breaker.stats()).toMatchObject({ successes: 0, failures: 0, failureRate: 0 });
      expect(changes.map((change) => change.to)).toEqual(['open', 'half-open', 'closed']);
    });

    it('waits for as many consecutive successes as it was asked for', () => {
      const { breaker } = openThenExpire({ halfOpenSuccessThreshold: 2 });

      breaker.acquire().succeed();
      expect(breaker.state).toBe('half-open');

      breaker.acquire().succeed();
      expect(breaker.state).toBe('closed');
    });

    it('reopens for a full window on a failed probe', () => {
      const { breaker, clock } = openThenExpire();

      breaker.acquire().fail();
      expect(breaker.state).toBe('open');

      clock.advance(29_999);
      expect(breaker.state).toBe('open');
      clock.advance(1);
      expect(breaker.state).toBe('half-open');
    });

    it('releases the probe slot for an attempt the caller abandoned', () => {
      const { breaker } = openThenExpire();

      breaker.acquire().ignore();

      // A cancelled request says nothing about the dependency, so the episode
      // is neither passed nor failed — but the slot must come back, or a
      // circuit stops probing and never closes again.
      expect(breaker.state).toBe('half-open');
      expect(breaker.stats()).toMatchObject({ probesInFlight: 0, successes: 0, failures: 0 });
      expect(() => breaker.acquire()).not.toThrow();
    });

    it('ignores a straggling probe from an episode that already ended', () => {
      const { breaker, clock } = openThenExpire({ halfOpenProbes: 2 });

      const straggler = breaker.acquire();
      breaker.acquire().fail();
      expect(breaker.state).toBe('open');

      clock.advance(30_000);
      expect(breaker.state).toBe('half-open');
      const current = breaker.acquire();

      // The straggler now succeeds, from the episode before last. Without the
      // generation check it would close a circuit that has since reopened, and
      // the dependency would get the full load back while it was still down.
      straggler.succeed();
      expect(breaker.state).toBe('half-open');
      // Nor may it release the slot the current probe is holding: the counter
      // was reset when this episode began, so decrementing it here would admit
      // a second probe against a dependency allowed exactly one.
      expect(breaker.stats().probesInFlight).toBe(1);

      current.fail();
      expect(breaker.state).toBe('open');
    });
  });

  describe('permits', () => {
    it('refuses to be settled twice', () => {
      // A programming error rather than a race — the permit is not shared — and
      // swallowing it would drain the half-open probe budget until the circuit
      // stopped probing at all.
      const { breaker } = makeBreaker();
      const permit = breaker.acquire();
      permit.succeed();

      expect(() => permit.fail()).toThrow(/settled twice/);
    });
  });
});
