import { parseRetryAfter } from '@/http/retry-after';

const NOW = Date.parse('2026-03-01T12:00:00.000Z');

describe('parseRetryAfter', () => {
  describe('delta-seconds', () => {
    it('reads a whole number of seconds as milliseconds', () => {
      expect(parseRetryAfter('120', NOW)).toBe(120_000);
    });

    it('reads zero as "retry now" rather than as nothing', () => {
      expect(parseRetryAfter('0', NOW)).toBe(0);
    });

    it('tolerates the surrounding whitespace a header may carry', () => {
      expect(parseRetryAfter('  30 ', NOW)).toBe(30_000);
    });

    it('does not read a bare number as a year', () => {
      // The reason the integer branch is tried first and matched strictly.
      // `Date.parse('2000')` is a valid instant in the distant past, so a
      // date-first parser reads `Retry-After: 2000` — half an hour — as "retry
      // immediately", which is the one answer that makes an outage worse.
      expect(Number.isNaN(Date.parse('2000'))).toBe(false);
      expect(parseRetryAfter('2000', NOW)).toBe(2_000_000);
    });

    it('refuses the forms delta-seconds does not admit', () => {
      // No sign, no fraction, no exponent, no units: each of these parses as a
      // number in JavaScript and none of them is this grammar. Two of them are
      // the reason the numeric guard exists at all — see the case below.
      expect(parseRetryAfter('-5', NOW)).toBeNull();
      expect(parseRetryAfter('1.5', NOW)).toBeNull();
      expect(parseRetryAfter('1e3', NOW)).toBeNull();
      expect(parseRetryAfter('30s', NOW)).toBeNull();
      expect(parseRetryAfter('0x20', NOW)).toBeNull();
    });

    it('does not let a malformed number fall through to the date parser', () => {
      // Found by writing this test, and fixed in the parser: V8 reads
      // `Date.parse('-5')` as 2001-05-01 and `Date.parse('1.5')` as
      // 2001-01-05. Both are valid instants in the past, so a date-first
      // fallback would clamp each to zero and turn a malformed header from an
      // overloaded origin into the fastest possible retry.
      expect(Number.isNaN(Date.parse('-5'))).toBe(false);
      expect(Number.isNaN(Date.parse('1.5'))).toBe(false);
      expect(parseRetryAfter('-5', NOW)).toBeNull();
      expect(parseRetryAfter('1.5', NOW)).toBeNull();
    });

    it('refuses a value too large to survive the multiplication', () => {
      // A `NaN` or an `Infinity` reaching a `setTimeout` fires it immediately,
      // which turns an absurd header into the busiest possible retry.
      expect(parseRetryAfter(String(Number.MAX_SAFE_INTEGER), NOW)).toBeNull();
    });
  });

  describe('HTTP-date', () => {
    it('reads an IMF-fixdate as a delay from now', () => {
      expect(parseRetryAfter('Sun, 01 Mar 2026 12:00:30 GMT', NOW)).toBe(30_000);
    });

    it('clamps a date already in the past to zero', () => {
      // The ordinary case, not a broken one: the header was written when the
      // response was generated and may have spent longer than its own delta in
      // transit or in a proxy's buffer.
      expect(parseRetryAfter('Sun, 01 Mar 2026 11:59:00 GMT', NOW)).toBe(0);
    });

    it('is read against the clock it is given, not the wall clock', () => {
      const later = NOW + 25_000;
      expect(parseRetryAfter('Sun, 01 Mar 2026 12:00:30 GMT', later)).toBe(5_000);
    });
  });

  describe('nothing usable', () => {
    it.each([
      ['absent', undefined],
      ['null', null],
      ['empty', ''],
      ['whitespace', '   '],
      ['prose', 'later'],
    ])('answers null for %s', (_label, value) => {
      expect(parseRetryAfter(value, NOW)).toBeNull();
    });

    it('is a different answer from zero', () => {
      // `0` is an instruction from the origin; `null` is silence. A caller that
      // conflated them would treat a malformed header as consent to retry at
      // once, which is the storm the header exists to prevent.
      expect(parseRetryAfter('garbage', NOW)).toBeNull();
      expect(parseRetryAfter('0', NOW)).toBe(0);
    });
  });
});
