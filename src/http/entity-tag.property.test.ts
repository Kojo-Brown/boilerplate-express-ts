import fc from 'fast-check';

import {
  formatEntityTag,
  isEtagChar,
  parseEntityTag,
  parseEntityTagList,
  strongMatch,
  weakMatch,
} from '@/http/entity-tag';
import type { EntityTag } from '@/http/entity-tag';
import { entityTag, etagValue, ows, sampleRate } from '@/tests/property';

/**
 * The entity-tag grammar and its two comparison functions as properties.
 *
 * Two things here are genuinely hard to cover by example and are exactly what
 * the module's own comments warn about.
 *
 * The first is the list scanner. A comma is a legal character *inside* an
 * entity-tag, so `header.split(',')` is the obvious implementation and it is
 * wrong — and it is wrong only for values nobody writes in a test, because the
 * tags a person invents are `"v1"` and `"abc"`. The generated value draws from
 * the whole of `etagc`, so a comma, a semicolon, a `W/` and the `obs-text` range
 * all turn up in the sample, and the round-trip property is then a statement
 * about the scanner rather than about three hand-picked strings.
 *
 * The second is weakness. Strong and weak comparison differ in exactly one
 * place, and the failure mode is not "the wrong answer on this input" — it is
 * the two functions quietly becoming the same function, which every example
 * asserting a single pair still passes. Stated as algebra (strong implies weak;
 * weakening either side kills a strong match and leaves a weak one alone), that
 * collapse is a failing test.
 */

const tagList = fc.array(entityTag, { minLength: 1, maxLength: 5 });

/** The wire form of a list, with arbitrary OWS and the empty members `#` permits. */
function formatList(tags: readonly EntityTag[], separator: string): string {
  return tags.map(formatEntityTag).join(separator);
}

describe('entity-tag grammar (properties)', () => {
  it('round-trips a single tag through its wire form', () => {
    fc.assert(
      fc.property(entityTag, (tag) => {
        expect(parseEntityTag(formatEntityTag(tag))).toEqual(tag);
      }),
    );
  });

  it('round-trips a list, including values containing commas', () => {
    fc.assert(
      fc.property(tagList, (tags) => {
        expect(parseEntityTagList(formatList(tags, ', '))).toEqual(tags);
      }),
    );
  });

  it('generates values carrying the delimiters a split-on-comma parser breaks on', () => {
    // The anti-vacuity guard for the round-trip above: if the generated values
    // stopped containing commas, the list property would pass against a parser
    // implemented with `split(',')` — the one implementation this module exists
    // to avoid. Measured at 27.5% on the pinned seed, 17.5–27.5% across four
    // others.
    expect(sampleRate(etagValue, (value) => value.includes(','))).toBeGreaterThan(0.1);
  });

  it('is insensitive to the whitespace and empty members the # rule allows', () => {
    fc.assert(
      fc.property(tagList, ows, ows, (tags, before, after) => {
        const separator = `${before},${after}`;
        expect(parseEntityTagList(formatList(tags, separator))).toEqual(tags);
        // Leading, trailing and doubled separators are all tolerated; an empty
        // list is still not a list, which is asserted by example.
        expect(parseEntityTagList(`${separator}${formatList(tags, `${separator},`)}${separator}`)).toEqual(tags);
      }),
    );
  });

  it('refuses a list with junk between two tags', () => {
    fc.assert(
      fc.property(tagList, tagList, fc.constantFrom('', ' x ', '"', 'W/', ';', '*'), (left, right, junk) => {
        // `"1""2"` is two values with no list between them, and `"1", *, "2"` is
        // a wildcard where the grammar has no wildcard. Both are the whole field
        // being malformed rather than a tag being skipped — a parser that
        // resynchronised at the next comma would accept half of what the client
        // sent and act on it.
        expect(parseEntityTagList(`${formatList(left, ', ')}${junk}${formatList(right, ', ')}`)).toBeNull();
      }),
    );
  });

  it('never admits a bare * as a member', () => {
    fc.assert(
      fc.property(tagList, fc.nat(), (tags, at) => {
        const members = tags.map(formatEntityTag);
        members.splice(at % (members.length + 1), 0, '*');
        expect(parseEntityTagList(members.join(', '))).toBeNull();
      }),
    );
  });

  it('is total, and whatever it parses re-prints to something it parses identically', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string(),
          fc.array(fc.constantFrom('W/', '"', ',', ' ', '\t', '*', 'a', '1', 'ÿ'), { maxLength: 10 }).map((parts) => parts.join('')),
          tagList.map((tags) => formatList(tags, ',')),
        ),
        (header) => {
          const tags = parseEntityTagList(header);
          if (tags === null) return;

          expect(tags.length).toBeGreaterThan(0);
          for (const tag of tags) {
            for (const char of tag.value) {
              expect(isEtagChar(char.charCodeAt(0))).toBe(true);
            }
          }
          // Printer and parser agree on the parser's own output, which is what
          // makes an `ETag` this server echoes back readable by the next hop.
          expect(parseEntityTagList(formatList(tags, ', '))).toEqual(tags);
        },
      ),
    );
  });

  it('rejects a single-tag field with trailing junk, where a list would take a member', () => {
    fc.assert(
      fc.property(entityTag, entityTag, (first, second) => {
        const field = `${formatEntityTag(first)}, ${formatEntityTag(second)}`;
        expect(parseEntityTag(field)).toBeNull();
        expect(parseEntityTagList(field)).toEqual([first, second]);
      }),
    );
  });
});

describe('entity-tag comparison (properties)', () => {
  it('weak comparison is reflexive and symmetric', () => {
    fc.assert(
      fc.property(entityTag, entityTag, (a, b) => {
        expect(weakMatch(a, a)).toBe(true);
        expect(weakMatch(a, b)).toBe(weakMatch(b, a));
      }),
    );
  });

  it('strong comparison is symmetric, and strictly implies weak comparison', () => {
    fc.assert(
      fc.property(entityTag, entityTag, (a, b) => {
        expect(strongMatch(a, b)).toBe(strongMatch(b, a));
        if (strongMatch(a, b)) expect(weakMatch(a, b)).toBe(true);
        // The two must not collapse into one function. A weak tag on either
        // side can never match strongly — which is what stops a range request
        // from being stitched onto bytes from a representation that merely
        // means the same thing.
        expect(strongMatch(a, b)).toBe(!a.weak && !b.weak && weakMatch(a, b));
      }),
    );
  });

  it('weakening a tag kills a strong match and leaves a weak one alone', () => {
    fc.assert(
      fc.property(entityTag, entityTag, (a, b) => {
        const weakenedA: EntityTag = { weak: true, value: a.value };
        const weakenedB: EntityTag = { weak: true, value: b.value };

        expect(strongMatch(weakenedA, b)).toBe(false);
        expect(strongMatch(a, weakenedB)).toBe(false);
        expect(weakMatch(weakenedA, weakenedB)).toBe(weakMatch(a, b));
      }),
    );
  });

  it('compares the same two tags often enough for the implications to bind', () => {
    // Without a collision rate the implications above are vacuous: `strong
    // implies weak` says nothing about a sample in which no pair ever matches.
    // This guard is why `etagValue` has a fixed vocabulary at all — two draws
    // from the bare `etagc` alphabet collided in 1% of samples, and the
    // implications were passing on the strength of the other 99%. Now 10% on
    // the pinned seed, 10–15.5% across four others.
    expect(
      sampleRate(fc.tuple(entityTag, entityTag), ([a, b]) => a.value === b.value),
    ).toBeGreaterThan(0.05);
  });
});
