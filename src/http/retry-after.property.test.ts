import fc from 'fast-check';

import { parseRetryAfter } from '@/http/retry-after';
import { httpInstant } from '@/tests/property';

/**
 * `Retry-After` as properties.
 *
 * What a caller does with this value is schedule a timer, which is why the
 * invariant below — null, or a non-negative safe integer, for every input —
 * matters more than any single case: a `NaN` reaching `setTimeout` fires
 * immediately, and an origin that asked for a pause instead gets the retry
 * storm the header exists to prevent. The same reasoning is why the function's
 * two failure modes are distinct values rather than both falsy, and the
 * properties keep them distinct.
 *
 * `now` is a parameter of the function, so every property here quantifies over
 * it as well as over the field. That is the whole benefit of the module not
 * reading a clock: "the wait never goes up as the clock advances" is a sentence
 * a test can check, rather than a thing a reader has to believe.
 */

/** Seconds whose millisecond conversion is still exact. */
const safeDelta = fc.integer({ min: 0, max: Math.floor(Number.MAX_SAFE_INTEGER / 1000) });

const instant = fc.integer({ min: 0, max: 7_258_118_400_000 });

/**
 * Numbers `Number()` accepts and `delta-seconds` does not.
 *
 * The grammar admits no sign, no fraction and no exponent, and the module tries
 * the integer branch strictly *before* the date branch for a reason worth
 * pinning down: V8 reads `Date.parse('-5')` as 2001-05-01 and `Date.parse('1.5')`
 * as 2001-01-05. Both are valid instants, both are in the past, so a malformed
 * header would clamp to "retry immediately" — the fastest possible retry from
 * the most overloaded origin.
 */
const numericButNotDelta = fc
  .tuple(
    fc.constantFrom('-', '+', ''),
    fc.integer({ min: 0, max: 100_000 }).map(String),
    fc.constantFrom('.5', '.0', ''),
    fc.constantFrom('e3', 'e-3', 'E2', ''),
  )
  .filter(([sign, , fraction, exponent]) => sign !== '' || fraction !== '' || exponent !== '')
  .map((parts) => parts.join(''));

describe('parseRetryAfter (properties)', () => {
  it('is null or a non-negative safe integer, for every field and every clock', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string(),
          safeDelta.map(String),
          httpInstant.map((date) => date.toUTCString()),
          numericButNotDelta,
          fc.constantFrom('', ' ', 'now', 'Fri, 31 Dec 1999 23:59:59 GMT', '9'.repeat(30)),
        ),
        instant,
        (field, now) => {
          const wait = parseRetryAfter(field, now);
          if (wait === null) return;
          expect(Number.isSafeInteger(wait)).toBe(true);
          expect(wait).toBeGreaterThanOrEqual(0);
        },
      ),
    );
  });

  it('reads delta-seconds as milliseconds, whatever the clock says', () => {
    fc.assert(
      fc.property(safeDelta, instant, (seconds, now) => {
        expect(parseRetryAfter(String(seconds), now)).toBe(seconds * 1000);
      }),
    );
  });

  it('accepts the leading zeros 1*DIGIT permits', () => {
    fc.assert(
      fc.property(safeDelta, fc.nat({ max: 6 }), instant, (seconds, zeros, now) => {
        expect(parseRetryAfter(`${'0'.repeat(zeros)}${seconds}`, now)).toBe(seconds * 1000);
      }),
    );
  });

  it('tolerates the surrounding whitespace a field value may carry', () => {
    fc.assert(
      fc.property(safeDelta, fc.stringMatching(/^[ \t]{0,3}$/), instant, (seconds, space, now) => {
        expect(parseRetryAfter(`${space}${seconds}${space}`, now)).toBe(seconds * 1000);
      }),
    );
  });

  it('refuses a delta that cannot survive the conversion to milliseconds', () => {
    fc.assert(
      fc.property(fc.integer({ min: 16, max: 24 }), instant, (digits, now) => {
        // Not a wait anybody meant, and the alternative to `null` is an
        // `Infinity` or a lost-precision integer landing in a `setTimeout`.
        expect(parseRetryAfter(`9${'0'.repeat(digits - 1)}`, now)).toBeNull();
      }),
    );
  });

  it('never lets a number the grammar rejects reach the date parser', () => {
    fc.assert(
      fc.property(numericButNotDelta, instant, (field, now) => {
        expect(parseRetryAfter(field, now)).toBeNull();
      }),
    );
  });

  it('reads an HTTP-date as the distance from now, clamped at zero', () => {
    fc.assert(
      fc.property(httpInstant, instant, (date, now) => {
        expect(parseRetryAfter(date.toUTCString(), now)).toBe(Math.max(0, date.getTime() - now));
      }),
    );
  });

  it('never grows as the clock advances', () => {
    fc.assert(
      fc.property(httpInstant, instant, fc.nat({ max: 10_000_000 }), (date, now, elapsed) => {
        const before = parseRetryAfter(date.toUTCString(), now);
        const after = parseRetryAfter(date.toUTCString(), now + elapsed);
        expect(before).not.toBeNull();
        expect(after).not.toBeNull();
        if (before === null || after === null) return;

        expect(after).toBeLessThanOrEqual(before);
        // And the decrease is exactly the time that passed, until it hits the
        // floor: a date already past is "retry now", not a negative wait.
        expect(after).toBe(Math.max(0, before - elapsed));
      }),
    );
  });

  it('keeps "retry immediately" and "the origin said nothing usable" apart', () => {
    fc.assert(
      fc.property(instant, (now) => {
        // `0` is an instruction a caller must honour; `null` sends it to its own
        // bounded ladder. A caller that treated both as falsy would retry at
        // once on a header it could not read.
        expect(parseRetryAfter('0', now)).toBe(0);
        expect(parseRetryAfter(new Date(now).toUTCString(), now)).toBe(0);
        expect(parseRetryAfter('', now)).toBeNull();
        expect(parseRetryAfter(null, now)).toBeNull();
        expect(parseRetryAfter(undefined, now)).toBeNull();
      }),
    );
  });
});
