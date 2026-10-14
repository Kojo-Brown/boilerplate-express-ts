import fc from 'fast-check';

import { evaluateReadPreconditions, shouldApplyRange } from '@/http/conditional';
import { formatEntityTag } from '@/http/entity-tag';
import type { EntityTag } from '@/http/entity-tag';
import { entityTag, httpInstant } from '@/tests/property';

/**
 * The read-side preconditions as properties.
 *
 * Two of the rules here are the kind that decay quietly. §13.1.3 says a
 * recipient with an `If-None-Match` **must ignore** `If-Modified-Since`, and an
 * implementation that evaluates both and requires both to pass still answers
 * 304 on the common input — it only fails when the mtime moved and the bytes
 * did not, turning every re-validation of that representation into a full
 * transfer. And `If-None-Match` is weak comparison while `If-Range` is strong,
 * which is a one-character difference that no single example distinguishes from
 * a copy of the other function.
 *
 * Both are stated below as statements over every input, which is the only form
 * in which they are actually being checked.
 */

const tagField = (tag: EntityTag): string => formatEntityTag(tag);

/** A representation's validators, with an `ETag` that always parses. */
const validators = fc.record({
  etag: entityTag.map(tagField),
  lastModified: fc.option(httpInstant, { nil: undefined }),
});

/** Anything a client might put in a date field, well-formed or not. */
const dateField = fc.oneof(
  httpInstant.map((date) => date.toUTCString()),
  fc.constantFrom('', 'not a date', 'Thu, 01 Jan 1970 00:00:00 GMT', '0', 'Sun Nov  6 08:49:37 1994'),
  fc.string(),
);

describe('evaluateReadPreconditions (properties)', () => {
  it('ignores If-Modified-Since entirely whenever If-None-Match is present', () => {
    fc.assert(
      fc.property(entityTag, dateField, validators, (tag, since, current) => {
        // §13.1.3, and the reason it is not a tidiness rule: a client sends
        // both so that an origin holding only one kind of validator can still
        // answer. Requiring both to pass makes the weaker one decide.
        const withBoth = evaluateReadPreconditions(
          { ifNoneMatch: tagField(tag), ifModifiedSince: since },
          current,
        );
        expect(withBoth).toBe(evaluateReadPreconditions({ ifNoneMatch: tagField(tag) }, current));
      }),
    );
  });

  it('compares If-None-Match weakly: the values decide, the W/ prefix does not', () => {
    fc.assert(
      fc.property(entityTag, entityTag, fc.boolean(), fc.boolean(), (client, origin, clientWeak, originWeak) => {
        // §13.1.2. A cache holding `W/"v1"` is allowed to be told 304 by an
        // origin whose current tag is `"v1"` — "is my copy still good enough"
        // is exactly the question a weak validator answers.
        const result = evaluateReadPreconditions(
          { ifNoneMatch: tagField({ weak: clientWeak, value: client.value }) },
          { etag: tagField({ weak: originWeak, value: origin.value }) },
        );
        expect(result).toBe(client.value === origin.value ? 'not-modified' : 'proceed');
      }),
    );
  });

  it('answers 304 to a list in which any one member matches', () => {
    fc.assert(
      fc.property(fc.array(entityTag, { minLength: 1, maxLength: 4 }), entityTag, (tags, origin) => {
        const field = tags.map(tagField).join(', ');
        const expected = tags.some((tag) => tag.value === origin.value) ? 'not-modified' : 'proceed';
        expect(evaluateReadPreconditions({ ifNoneMatch: field }, { etag: tagField(origin) })).toBe(expected);
      }),
    );
  });

  it('reads a bare * as "any representation", which there is one of', () => {
    fc.assert(
      fc.property(validators, fc.stringMatching(/^[ \t]{0,3}$/), (current, space) => {
        expect(evaluateReadPreconditions({ ifNoneMatch: `${space}*${space}` }, current)).toBe('not-modified');
      }),
    );
  });

  it('serves the content whenever it cannot read the field, rather than refusing', () => {
    fc.assert(
      fc.property(entityTag, entityTag, fc.constantFrom('', ' x ', '"', 'W/', '*'), validators, (a, b, junk, current) => {
        // A malformed `If-None-Match` is ignored for the same reason a
        // malformed `Range` is: the conservative reading is always correct, and
        // a 400 would fail a request a plain GET would have served.
        const malformed = `${tagField(a)}${junk}${tagField(b)}`;
        expect(evaluateReadPreconditions({ ifNoneMatch: malformed }, current)).toBe('proceed');
      }),
    );
  });

  it('compares If-Modified-Since at the second granularity an HTTP-date carries', () => {
    fc.assert(
      fc.property(httpInstant, httpInstant, fc.integer({ min: 0, max: 999 }), (lastModified, since, jitter) => {
        // A millisecond-precise `lastModified` is otherwise always strictly
        // greater than the date derived from the response that carried it, and
        // the resource never validates.
        const expected = lastModified.getTime() <= since.getTime() ? 'not-modified' : 'proceed';
        for (const stored of [lastModified, new Date(lastModified.getTime() + jitter)]) {
          expect(
            evaluateReadPreconditions(
              { ifModifiedSince: since.toUTCString() },
              { etag: '"v1"', lastModified: stored },
            ),
          ).toBe(expected);
        }
      }),
    );
  });

  it('is total: every pair of fields and validators yields a decision', () => {
    fc.assert(
      fc.property(fc.option(fc.string(), { nil: undefined }), dateField, validators, (ifNoneMatch, since, current) => {
        expect(['proceed', 'not-modified']).toContain(
          evaluateReadPreconditions({ ifNoneMatch, ifModifiedSince: since }, current),
        );
      }),
    );
  });
});

describe('shouldApplyRange (properties)', () => {
  it('applies the range unconditionally when the client sent no If-Range', () => {
    fc.assert(
      fc.property(validators, (current) => {
        expect(shouldApplyRange(undefined, current)).toBe(true);
      }),
    );
  });

  it('compares If-Range strongly: a weak tag on either side never applies', () => {
    fc.assert(
      fc.property(entityTag, entityTag, (client, origin) => {
        // The client is splicing these bytes onto bytes it already holds. A
        // weak validator means "equivalent representations", and two equivalent
        // representations may still differ byte for byte.
        const applies = shouldApplyRange(tagField(client), { etag: tagField(origin) });
        expect(applies).toBe(!client.weak && !origin.weak && client.value === origin.value);
      }),
    );
  });

  it('compares an If-Range date for equality, not for "not newer"', () => {
    fc.assert(
      fc.property(httpInstant, httpInstant, fc.integer({ min: 0, max: 999 }), (sent, stored, jitter) => {
        // A representation that changed twice within the same second has the
        // same `Last-Modified`; a date that merely is not older would accept it
        // and the client would splice two different representations together.
        const current = { etag: '"v1"', lastModified: new Date(stored.getTime() + jitter) };
        expect(shouldApplyRange(sent.toUTCString(), current)).toBe(sent.getTime() === stored.getTime());
      }),
    );
  });

  it('refuses a range whenever If-Range is something it cannot evaluate', () => {
    fc.assert(
      fc.property(fc.constantFrom('', 'not a date', '"a", "b"', 'W/', '*'), validators, (field, current) => {
        // The inverse of the read preconditions: there, an unreadable field is
        // ignored and the content is served; here, an unreadable `If-Range`
        // means the range is dropped and the whole representation is sent —
        // which is the same conservative answer wearing the other hat.
        expect(shouldApplyRange(field, current)).toBe(false);
      }),
    );
  });
});
