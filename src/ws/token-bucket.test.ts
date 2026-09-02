import { createTokenBucket } from '@/ws/token-bucket';

/** A monotonic clock the test drives by hand. */
function fakeClock(): { now: () => number; advance: (ms: number) => void; set: (ms: number) => void } {
  let ms = 0;
  return {
    now: (): number => ms,
    advance: (delta: number): void => {
      ms += delta;
    },
    set: (value: number): void => {
      ms = value;
    },
  };
}

describe('createTokenBucket', () => {
  it('rejects a non-positive or non-finite capacity', () => {
    expect(() => createTokenBucket({ capacity: 0, refillPerSecond: 1 })).toThrow(RangeError);
    expect(() => createTokenBucket({ capacity: -1, refillPerSecond: 1 })).toThrow(RangeError);
    expect(() => createTokenBucket({ capacity: Infinity, refillPerSecond: 1 })).toThrow(RangeError);
    expect(() => createTokenBucket({ capacity: NaN, refillPerSecond: 1 })).toThrow(RangeError);
  });

  it('rejects a non-positive or non-finite refill rate', () => {
    expect(() => createTokenBucket({ capacity: 1, refillPerSecond: 0 })).toThrow(RangeError);
    expect(() => createTokenBucket({ capacity: 1, refillPerSecond: -5 })).toThrow(RangeError);
    expect(() => createTokenBucket({ capacity: 1, refillPerSecond: Infinity })).toThrow(RangeError);
  });

  it('starts full and admits a burst up to capacity', () => {
    const clock = fakeClock();
    const bucket = createTokenBucket({ capacity: 5, refillPerSecond: 1, now: clock.now });

    for (let i = 0; i < 5; i += 1) {
      expect(bucket.tryRemove()).toBe(true);
    }

    expect(bucket.tryRemove()).toBe(false);
  });

  it('spends nothing when it refuses, so an over-budget cost cannot starve the bucket', () => {
    const clock = fakeClock();
    const bucket = createTokenBucket({ capacity: 10, refillPerSecond: 1, now: clock.now });

    // A repeated over-budget request under a partial-spend design would drain
    // the bucket and admit nothing ever again.
    expect(bucket.tryRemove(11)).toBe(false);
    expect(bucket.tryRemove(11)).toBe(false);
    expect(bucket.available).toBe(10);
    expect(bucket.tryRemove(10)).toBe(true);
  });

  it('refills at the configured rate', () => {
    const clock = fakeClock();
    const bucket = createTokenBucket({ capacity: 10, refillPerSecond: 4, now: clock.now });

    expect(bucket.tryRemove(10)).toBe(true);
    expect(bucket.available).toBe(0);

    clock.advance(500);
    expect(bucket.available).toBeCloseTo(2, 10);

    clock.advance(500);
    expect(bucket.available).toBeCloseTo(4, 10);
  });

  it('never refills above capacity, however long it sits idle', () => {
    const clock = fakeClock();
    const bucket = createTokenBucket({ capacity: 3, refillPerSecond: 100, now: clock.now });

    clock.advance(60 * 60 * 1000);

    expect(bucket.available).toBe(3);
    expect(bucket.tryRemove(3)).toBe(true);
    expect(bucket.tryRemove(1)).toBe(false);
  });

  it('admits at the sustained rate once the burst is spent', () => {
    const clock = fakeClock();
    const bucket = createTokenBucket({ capacity: 5, refillPerSecond: 2, now: clock.now });

    expect(bucket.tryRemove(5)).toBe(true);
    expect(bucket.tryRemove()).toBe(false);

    // Half a second at 2/s is one token: exactly one message gets through.
    clock.advance(500);
    expect(bucket.tryRemove()).toBe(true);
    expect(bucket.tryRemove()).toBe(false);
  });

  it('does not admit twice the limit across a boundary, the way a fixed window would', () => {
    const clock = fakeClock();
    // "60 per minute", expressed as a bucket rather than a window.
    const bucket = createTokenBucket({ capacity: 60, refillPerSecond: 1, now: clock.now });

    let admitted = 0;
    for (let i = 0; i < 60; i += 1) {
      if (bucket.tryRemove()) admitted += 1;
    }

    // A fixed window resets here and would admit 60 more in the same instant.
    clock.advance(60_000);
    for (let i = 0; i < 60; i += 1) {
      if (bucket.tryRemove()) admitted += 1;
    }

    expect(admitted).toBe(120);
    // …but only because a full minute of refill happened between them, which is
    // the point: nothing was admitted *at the boundary* that had not been
    // earned. Within one instant the ceiling holds.
    expect(bucket.tryRemove()).toBe(false);
  });

  it('treats a clock that moves backwards as no elapsed time rather than a debit', () => {
    const clock = fakeClock();
    clock.set(10_000);
    const bucket = createTokenBucket({ capacity: 10, refillPerSecond: 1, now: clock.now });

    expect(bucket.tryRemove(10)).toBe(true);

    // An NTP step backwards. `(elapsed / 1000) * rate` would be negative.
    clock.set(4_000);
    expect(bucket.available).toBe(0);

    // And the interval must not then be credited twice once time moves forward.
    clock.set(5_000);
    expect(bucket.available).toBeCloseTo(1, 10);
  });

  it('throws on a non-positive cost rather than silently admitting it', () => {
    const bucket = createTokenBucket({ capacity: 1, refillPerSecond: 1 });
    expect(() => bucket.tryRemove(0)).toThrow(RangeError);
    expect(() => bucket.tryRemove(-1)).toThrow(RangeError);
  });

  describe('retryAfterSeconds', () => {
    it('is 0 while the tokens are already there', () => {
      const bucket = createTokenBucket({ capacity: 5, refillPerSecond: 1 });
      expect(bucket.retryAfterSeconds(5)).toBe(0);
    });

    it('reports the wait for the requested cost, not for a full bucket', () => {
      const clock = fakeClock();
      const bucket = createTokenBucket({ capacity: 100, refillPerSecond: 10, now: clock.now });

      expect(bucket.tryRemove(100)).toBe(true);

      // One token at 10/s is 0.1s; refilling the whole bucket would be 10s.
      expect(bucket.retryAfterSeconds(1)).toBe(1);
      expect(bucket.retryAfterSeconds(50)).toBe(5);
    });

    it('rounds up, so a client told to wait does not retry into the same refusal', () => {
      const clock = fakeClock();
      const bucket = createTokenBucket({ capacity: 10, refillPerSecond: 1, now: clock.now });

      expect(bucket.tryRemove(10)).toBe(true);
      clock.advance(800);

      // 0.2 tokens short of 1: a truncating implementation would say 0.
      expect(bucket.retryAfterSeconds(1)).toBe(1);
    });
  });
});
