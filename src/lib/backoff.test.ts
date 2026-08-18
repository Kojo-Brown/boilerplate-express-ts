import { fullJitterDelay } from '@/lib/backoff';

describe('fullJitterDelay', () => {
  it('doubles the window each attempt until it reaches the ceiling', () => {
    const atMax = { baseMs: 100, maxMs: 500, random: () => 0.99999 };

    expect(fullJitterDelay(1, atMax)).toBe(99);
    expect(fullJitterDelay(2, atMax)).toBe(199);
    expect(fullJitterDelay(3, atMax)).toBe(399);
    expect(fullJitterDelay(4, atMax)).toBe(499);
    expect(fullJitterDelay(9, atMax)).toBe(499);
  });

  /**
   * Full jitter, not equal jitter: the window starts at zero, so two clients
   * that failed together can be separated by the whole span rather than half
   * of it.
   */
  it('can return zero, because the window starts at zero', () => {
    expect(fullJitterDelay(3, { baseMs: 100, maxMs: 500, random: () => 0 })).toBe(0);
  });

  it('stays inside the window for every draw', () => {
    const draws = [0, 0.25, 0.5, 0.75, 0.999];

    for (const draw of draws) {
      const delay = fullJitterDelay(2, { baseMs: 100, maxMs: 500, random: () => draw });
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThan(200);
    }
  });

  it('defaults to Math.random when no source is injected', () => {
    const delay = fullJitterDelay(1, { baseMs: 50, maxMs: 500 });
    expect(Number.isInteger(delay)).toBe(true);
    expect(delay).toBeGreaterThanOrEqual(0);
    expect(delay).toBeLessThan(50);
  });
});
