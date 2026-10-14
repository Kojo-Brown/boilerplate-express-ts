import fc from 'fast-check';

import { ANY_VERSION } from '@/concurrency/concurrency.types';
import { formatETag, parseIfMatch } from '@/concurrency/etag';
import { formatEntityTag } from '@/http/entity-tag';
import { entityTag, ows } from '@/tests/property';

/**
 * `If-Match` as properties: the round-trip this API's optimistic concurrency
 * rests on, and the three-way split that decides what a client is owed.
 *
 * The round-trip is the load-bearing one. A conditional write is `ETag` out,
 * `If-Match` back, and if those two disagree about a single version the write
 * path answers 412 to a client holding the current row — forever, because the
 * tag it is handed next is the one it just failed with. Stating it over every
 * version in the column's range is the difference between knowing that and
 * knowing it for `"1"`, `"2"` and `"42"`.
 *
 * The split is the other half: a bad *header* is 400, a tag that cannot name a
 * row is 412, and the two must not be reachable from each other. A tag such as
 * `"007"` is well-formed and simply does not match — `If-Match` is strong
 * comparison, which is octet equality, so it is a different tag from `"7"` and
 * not a lenient spelling of it.
 */

/** Every version a Postgres `integer` column can reach. */
const version = fc.integer({ min: 1, max: 2_147_483_647 });

/**
 * Tags that parse, but that no row can ever carry.
 *
 * Every value here is made of `etagc` octets, which excludes SP: `" 1"` is a
 * *malformed header* rather than an unmatchable tag, and putting it in this
 * list is how the property below first failed. The distinction is the one the
 * module is built around, so the generator has to respect it.
 */
const unmatchableValue = fc.oneof(
  fc.constantFrom('0', '007', 'abc', '', '1.0', '-1', '2147483648', '9999999999999', '1e3'),
  version.map((value) => `0${value}`),
);

describe('formatETag / parseIfMatch (properties)', () => {
  it('round-trips every version the column can hold', () => {
    fc.assert(
      fc.property(version, (value) => {
        expect(parseIfMatch(formatETag(value))).toEqual({
          ok: true,
          precondition: { kind: 'versions', versions: [value] },
        });
      }),
    );
  });

  it('emits a strong tag, because If-Match can never be satisfied by a weak one', () => {
    fc.assert(
      fc.property(version, (value) => {
        expect(formatETag(value)).toBe(`"${value}"`);
      }),
    );
  });

  it('refuses to build a tag from something that is not a version', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.integer({ min: -1_000_000, max: 0 }),
          fc.integer({ min: 2_147_483_648, max: Number.MAX_SAFE_INTEGER }),
          fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY, 1.5, -0.5),
        ),
        (value) => {
          expect(() => formatETag(value)).toThrow(RangeError);
        },
      ),
    );
  });

  it('keeps a list of versions, in the order the client wrote them', () => {
    fc.assert(
      fc.property(fc.array(version, { minLength: 1, maxLength: 5 }), ows, (versions, space) => {
        const field = versions.map((value) => formatETag(value)).join(`${space},${space}`);
        expect(parseIfMatch(field)).toEqual({ ok: true, precondition: { kind: 'versions', versions } });
      }),
    );
  });

  it('drops a tag no row can carry instead of rejecting the request', () => {
    fc.assert(
      fc.property(fc.array(version, { maxLength: 3 }), fc.array(unmatchableValue, { maxLength: 3 }), (versions, junk) => {
        // Well-formed tags that simply do not match. That is a 412 and not a
        // 400 — and dropping every one of them leaves an empty list, which
        // matches nothing, which is exactly right.
        const field = [...versions.map((value) => `"${value}"`), ...junk.map((value) => `"${value}"`)].join(', ');
        if (field === '') return;

        expect(parseIfMatch(field)).toEqual({ ok: true, precondition: { kind: 'versions', versions } });
      }),
    );
  });

  it('fails the request outright when any tag in the list is weak', () => {
    fc.assert(
      fc.property(fc.array(version, { maxLength: 3 }), version, fc.nat(), (others, weakVersion, at) => {
        // A client retrying a `W/`-prefixed tag would loop forever against an
        // API that can never accept it, so this is a client bug to be named
        // rather than a conflict to be reported.
        const members = others.map((value) => formatETag(value));
        members.splice(at % (members.length + 1), 0, `W/"${weakVersion}"`);

        const result = parseIfMatch(members.join(', '));
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.reason).toContain('weak');
      }),
    );
  });

  it('reads a bare * as "whatever version it is at, as long as it is still there"', () => {
    fc.assert(
      fc.property(ows, ows, (before, after) => {
        expect(parseIfMatch(`${before}*${after}`)).toEqual({ ok: true, precondition: ANY_VERSION });
      }),
    );
  });

  it('never admits * as a member of a list', () => {
    fc.assert(
      fc.property(fc.array(version, { minLength: 1, maxLength: 3 }), fc.nat(), (versions, at) => {
        const members = versions.map((value) => formatETag(value));
        members.splice(at % (members.length + 1), 0, '*');

        const result = parseIfMatch(members.join(', '));
        expect(result.ok).toBe(false);
      }),
    );
  });

  it('is total: every header is a precondition or a reason, and never a throw', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string(),
          fc.array(entityTag, { maxLength: 4 }).map((tags) => tags.map(formatEntityTag).join(', ')),
          fc.array(unmatchableValue, { maxLength: 3 }).map((values) => values.map((value) => `"${value}"`).join(', ')),
        ),
        (header) => {
          const result = parseIfMatch(header);
          if (!result.ok) {
            expect(result.reason.length).toBeGreaterThan(0);
            return;
          }

          if (result.precondition.kind === 'any') return;
          for (const value of result.precondition.versions) {
            expect(Number.isSafeInteger(value)).toBe(true);
            expect(value).toBeGreaterThanOrEqual(1);
            expect(value).toBeLessThanOrEqual(2_147_483_647);
          }
        },
      ),
    );
  });
});
