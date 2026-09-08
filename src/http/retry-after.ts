/**
 * `Retry-After` (RFC 9110 §10.2.3) is two grammars sharing one field name:
 * `delta-seconds` (a non-negative integer) or an `HTTP-date`. A client that
 * handles only the first silently ignores every origin that sends the second —
 * and both are common, because the choice is per-implementation rather than
 * per-status: nginx's `limit_req` emits neither, S3 emits seconds, and a CDN
 * shedding load usually emits a date.
 *
 * Kept here with `entity-tag` and `range` rather than next to the HTTP client
 * that reads it: it takes a string and a number and returns a number, so every
 * case in the grammar is cheap to write down and nothing about it needs a
 * socket. The client's own tests are then about what it *does* with the answer.
 */

/**
 * The header's meaning in milliseconds from `now`, or `null` when the field is
 * absent, malformed, or a date this clock cannot make sense of.
 *
 * `null` and `0` are deliberately different answers. `0` is "the origin says
 * retry immediately" (a date already past, or `Retry-After: 0`), which is a
 * real instruction. `null` is "the origin said nothing usable", and a caller
 * must fall back to its own backoff rather than treating silence as consent to
 * retry at once — which is how a malformed header from an overloaded origin
 * turns into the retry storm the header exists to prevent.
 *
 * `now` is a parameter and not `Date.now()` so a suite can pin the date branch
 * to a fixed instant, which is the only way to assert it without a clock.
 */
export function parseRetryAfter(value: string | null | undefined, now: number): number | null {
  if (value === null || value === undefined) return null;

  const field = value.trim();
  if (field === '') return null;

  // The integer branch is tried first and matched strictly, because
  // `Date.parse` is permissive enough to accept some bare numbers as years:
  // `Date.parse('2000')` is a valid instant, so a `Retry-After: 2000` meaning
  // "half an hour" would otherwise be read as a date in the distant past and
  // collapse to "retry now". `delta-seconds` admits no sign, no fraction and no
  // exponent, so the pattern is the whole grammar.
  if (/^\d+$/.test(field)) {
    const seconds = Number(field);
    // A value that cannot survive the multiplication is not a wait anybody
    // meant; `null` sends the caller to its own bounded ladder instead of to a
    // `NaN` or an `Infinity` that would land in a `setTimeout`.
    if (!Number.isSafeInteger(seconds) || !Number.isSafeInteger(seconds * 1000)) return null;
    return seconds * 1000;
  }

  // A field that is numeric but failed the grammar above is malformed, and it
  // must not reach the date parser. Writing the tests found why: V8 reads
  // `Date.parse('-5')` as 2001-05-01 and `Date.parse('1.5')` as 2001-01-05 —
  // both valid instants, both in the past, so both would clamp to "retry
  // immediately". A malformed header from an overloaded origin would then
  // produce the fastest possible retry, which is exactly backwards.
  if (!Number.isNaN(Number(field))) return null;

  // `Date.parse` accepts more than the three formats RFC 9110 §5.6.7 lists,
  // which is the right trade here: being lenient about an origin's date format
  // costs nothing, while rejecting a legal-but-unusual one loses the origin's
  // own estimate of when it will be back.
  const at = Date.parse(field);
  if (Number.isNaN(at)) return null;

  // A date in the past is "retry now", not a negative wait. It is also the
  // ordinary case rather than a broken one: the header was written when the
  // response was generated and may have spent longer than its own delta in
  // transit, in a proxy's buffer, or behind our own body read.
  return Math.max(0, at - now);
}
