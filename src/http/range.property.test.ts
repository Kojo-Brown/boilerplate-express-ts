import fc from 'fast-check';

import {
  formatContentRange,
  formatUnsatisfiedRange,
  parseRangeHeader,
  rangeLength,
  resolveRange,
} from '@/http/range';
import type { RangeSpec } from '@/http/range';
import { ows, sampleRate } from '@/tests/property';

/**
 * `Range` as properties: the grammar's round-trip, the spellings §14 says mean
 * the same thing, and the one invariant a 206 must never break.
 *
 * The examples in `range.test.ts` are where a specific decision is written down
 * — that `bytes=-0` is unsatisfiable, that a 16-digit position clamps. What is
 * here instead is everything that has to hold for *all* positions and sizes,
 * because the arithmetic in `resolveRange` has four branches and an off-by-one
 * in any of them produces a `Content-Range` naming a byte the representation
 * does not have. A client splices those bytes onto bytes it already holds; the
 * corruption is silent and it is in the client's file, not in a log here.
 */

/** Positions well inside the 15-digit limit, so the clamp is tested separately. */
const position = fc.integer({ min: 0, max: 1_000_000 });

const intSpec: fc.Arbitrary<RangeSpec> = fc
  .tuple(position, fc.option(fc.nat({ max: 1_000_000 }), { nil: null }))
  // `last-pos` below `first-pos` is malformed rather than unsatisfiable, so a
  // round-trip generator must not produce it: the parser would return `null`
  // and the property would be asserting the rejection, not the round-trip.
  .map(([first, offset]) => ({ kind: 'int', first, last: offset === null ? null : first + offset }));

const suffixSpec: fc.Arbitrary<RangeSpec> = fc
  .nat({ max: 1_000_000 })
  .map((length) => ({ kind: 'suffix', length }));

const rangeSpec = fc.oneof(intSpec, suffixSpec);

/** The spec as a client writes it, which is what the round-trip goes through. */
function formatSpec(spec: RangeSpec): string {
  return spec.kind === 'suffix' ? `-${spec.length}` : `${spec.first}-${spec.last ?? ''}`;
}

const specList = fc.array(rangeSpec, { minLength: 1, maxLength: 4 });

const size = fc.nat({ max: 10_000_000 });

/**
 * A field value assembled from the grammar's own shapes, valid and not.
 *
 * Structured on purpose, and the structure was forced by the coverage guard at
 * the end of this block. The first attempt concatenated random fragments —
 * `'bytes'`, `'='`, `','`, digits, short random strings — and produced a corpus
 * in which *not one* sample of 200 parsed: a field has to open with the `bytes`
 * token, then an `=`, then a list in which every member is well-formed, and
 * random concatenation satisfies all three about never. The property above
 * would have passed while asserting nothing but that `null` is returned.
 *
 * Generating a unit and a member list separately keeps the corpus mostly
 * malformed — which is the point of fuzzing a parser whose contract is to return
 * `null` rather than throw — while leaving the valid field reachable.
 */
const rangeishHeader = fc
  .tuple(
    fc.constantFrom('bytes=', 'bytes =', ' bytes\t=', 'BYTES=', 'Bytes=', 'items=', 'bytes', '=', ''),
    fc.array(
      fc.oneof(
        fc.integer({ min: 0, max: 10 ** 9 }).map((value) => `${value}`),
        fc.tuple(position, position).map(([first, last]) => `${first}-${last}`),
        fc.tuple(position, position).map(([first, last]) => `${first} - ${last}`),
        position.map((value) => `-${value}`),
        position.map((value) => `${value}-`),
        fc.constantFrom('', '-', '--', '*', '"1"', '0-1-2', '1e3-4', '-0', '0x10-20'),
        fc.string({ maxLength: 4 }),
      ),
      { maxLength: 4 },
    ),
  )
  .map(([unit, members]) => `${unit}${members.join(',')}`);

describe('parseRangeHeader (properties)', () => {
  it('round-trips every spec it can parse', () => {
    fc.assert(
      fc.property(specList, (specs) => {
        expect(parseRangeHeader(`bytes=${specs.map(formatSpec).join(',')}`)).toEqual(specs);
      }),
    );
  });

  it('reads the range unit case-insensitively, as §5.6.2 requires of a token', () => {
    fc.assert(
      fc.property(specList, fc.array(fc.boolean(), { minLength: 5, maxLength: 5 }), (specs, caseBits) => {
        const unit = [...'bytes'].map((char, i) => (caseBits[i] === true ? char.toUpperCase() : char)).join('');
        expect(parseRangeHeader(`${unit}=${specs.map(formatSpec).join(',')}`)).toEqual(specs);
      }),
    );
  });

  it('ignores whitespace and empty list members wherever the # rule permits them', () => {
    fc.assert(
      fc.property(specList, ows, ows, ows, (specs, before, between, after) => {
        // Whitespace around the unit and around each member, and the empty
        // members `"1", , "2"` tolerates — all of which must leave the list
        // alone. Not inside a spec: `bytes=0 - 10` stays malformed, which is
        // asserted by example in range.test.ts.
        const members = specs.map((spec) => `${between}${formatSpec(spec)}${between}`).join(',,');
        expect(parseRangeHeader(`${before}bytes${before}=,${members},${after}`)).toEqual(specs);
      }),
    );
  });

  it('accepts arbitrary leading zeros on a position, which 1*DIGIT permits', () => {
    fc.assert(
      fc.property(specList, fc.nat({ max: 8 }), (specs, zeros) => {
        const pad = '0'.repeat(zeros);
        const padded = specs
          .map((spec) =>
            spec.kind === 'suffix'
              ? `-${pad}${spec.length}`
              : `${pad}${spec.first}-${spec.last === null ? '' : `${pad}${spec.last}`}`,
          )
          .join(',');
        expect(parseRangeHeader(`bytes=${padded}`)).toEqual(specs);
      }),
    );
  });

  it('is total: every field value is either a well-formed spec list or null', () => {
    fc.assert(
      fc.property(fc.oneof(rangeishHeader, fc.string()), (header) => {
        const parsed = parseRangeHeader(header);
        if (parsed === null) return;

        // The structural guarantee `resolveRange` is written against: a
        // non-null parse is a non-empty list of safe non-negative integers, and
        // an `int` spec with a `last` never has it below `first`.
        expect(parsed.length).toBeGreaterThan(0);
        for (const spec of parsed) {
          if (spec.kind === 'suffix') {
            expect(Number.isSafeInteger(spec.length)).toBe(true);
            expect(spec.length).toBeGreaterThanOrEqual(0);
          } else {
            expect(Number.isSafeInteger(spec.first)).toBe(true);
            expect(spec.first).toBeGreaterThanOrEqual(0);
            if (spec.last !== null) {
              expect(Number.isSafeInteger(spec.last)).toBe(true);
              expect(spec.last).toBeGreaterThanOrEqual(spec.first);
            }
          }
        }
      }),
    );
  });

  it('generates fuzz that reaches the spec parser rather than stopping at the = check', () => {
    // The anti-vacuity guard for the property above: a fuzz corpus that never
    // produces a parseable field would assert only that `null` is returned.
    // Measured at 7.0% on the pinned seed and 7.0–9.5% across five others, so
    // the floor is a corpus that has stopped reaching the parser rather than one
    // that drifted a little.
    expect(sampleRate(rangeishHeader, (header) => parseRangeHeader(header) !== null)).toBeGreaterThan(0.05);
  });
});

describe('resolveRange (properties)', () => {
  it('never names a byte the representation does not have', () => {
    fc.assert(
      fc.property(rangeSpec, size, (spec, total) => {
        const resolution = resolveRange([spec], total);
        if (resolution.kind !== 'range') return;

        const { start, end } = resolution.range;
        expect(start).toBeGreaterThanOrEqual(0);
        expect(end).toBeGreaterThanOrEqual(start);
        expect(end).toBeLessThanOrEqual(total - 1);
        expect(rangeLength(resolution.range)).toBeGreaterThanOrEqual(1);
        expect(rangeLength(resolution.range)).toBeLessThanOrEqual(total);
      }),
    );
  });

  it('resolves a suffix to the last min(length, size) bytes', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1_000_000 }), fc.integer({ min: 1, max: 10_000_000 }), (length, total) => {
        const resolution = resolveRange([{ kind: 'suffix', length }], total);
        // Both guards that produce `unsatisfiable` are excluded by the
        // generators, so a suffix here always resolves.
        expect(resolution.kind).toBe('range');
        if (resolution.kind !== 'range') return;
        expect(resolution.range.end).toBe(total - 1);
        expect(rangeLength(resolution.range)).toBe(Math.min(length, total));
      }),
    );
  });

  it('starts an int range at first-pos and clamps last-pos to the final byte', () => {
    fc.assert(
      fc.property(intSpec, size, (spec, total) => {
        if (spec.kind !== 'int') return;
        const resolution = resolveRange([spec], total);

        if (spec.first >= total) {
          expect(resolution).toEqual({ kind: 'unsatisfiable' });
          return;
        }

        expect(resolution).toEqual({
          kind: 'range',
          range: { start: spec.first, end: spec.last === null ? total - 1 : Math.min(spec.last, total - 1) },
        });
      }),
    );
  });

  it('treats a last-pos past the end exactly like an open-ended range', () => {
    // `bytes=0-` and `bytes=0-999999` are the same request against a 100-byte
    // file — both are how a client asks for "the rest" — and so is the 16-digit
    // position that clamps to MAX_SAFE_INTEGER on the way in.
    fc.assert(
      fc.property(position, size, fc.integer({ min: 16, max: 24 }), (first, total, digits) => {
        const huge = `9${'0'.repeat(digits - 1)}`;
        const openEnded = parseRangeHeader(`bytes=${first}-`);
        const pastTheEnd = parseRangeHeader(`bytes=${first}-${huge}`);
        expect(openEnded).not.toBeNull();
        expect(pastTheEnd).not.toBeNull();
        if (openEnded === null || pastTheEnd === null) return;

        expect(resolveRange(pastTheEnd, total)).toEqual(resolveRange(openEnded, total));
      }),
    );
  });

  it('ignores any range-set that is not exactly one member', () => {
    // §14.2 permits ignoring `Range` at any time, and a multi-range request is
    // where this server takes that licence: answering one of the ranges asked
    // for is not permitted, and `multipart/byteranges` buys nothing for the
    // clients that actually send `Range`.
    fc.assert(
      fc.property(
        fc.oneof(fc.constant([]), fc.array(rangeSpec, { minLength: 2, maxLength: 5 })),
        size,
        (specs, total) => {
          expect(resolveRange(specs, total)).toEqual({ kind: 'ignore' });
        },
      ),
    );
  });

  it('refuses a size that is not a byte count, rather than computing on it', () => {
    fc.assert(
      fc.property(
        rangeSpec,
        fc.oneof(
          fc.integer({ min: -1_000_000, max: -1 }),
          fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 1.5, 2 ** 53),
        ),
        (spec, total) => {
          expect(() => resolveRange([spec], total)).toThrow(RangeError);
        },
      ),
    );
  });
});

describe('Content-Range (properties)', () => {
  it('describes the interval it was built from, for every resolvable range', () => {
    fc.assert(
      fc.property(rangeSpec, size, (spec, total) => {
        const resolution = resolveRange([spec], total);
        if (resolution.kind !== 'range') return;

        const field = formatContentRange(resolution.range, total);
        const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(field);
        expect(match).not.toBeNull();
        if (match === null) return;

        const [start, end, declared] = [Number(match[1]), Number(match[2]), Number(match[3])];
        expect(start).toBe(resolution.range.start);
        expect(end).toBe(resolution.range.end);
        expect(declared).toBe(total);
        expect(end - start + 1).toBe(rangeLength(resolution.range));
      }),
    );
  });

  it('tells a 416 the current length and nothing about an interval', () => {
    fc.assert(
      fc.property(size, (total) => {
        expect(formatUnsatisfiedRange(total)).toBe(`bytes */${total}`);
      }),
    );
  });
});
