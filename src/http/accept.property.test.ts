import fc from 'fast-check';

import { isMediaType, selectMediaType } from '@/http/accept';
import { sampleRate } from '@/tests/property';

/**
 * Content negotiation as properties, and the first one is the reason this file
 * exists.
 *
 * `accept.ts` carries a comment about a version of `moreSpecific` that ranked a
 * range as `2 + parameters.size`. It was wrong in a way no example caught:
 * `text/*;charset=utf-8` and `text/*` scored the same, so which of them
 * `qualityFor` kept depended on which came first, and reversing the client's
 * field flipped the answer between a 200 and a 406. The field is a *set* of
 * statements — §12.5.1 makes nothing of their order — so "the answer does not
 * depend on the order" is a statement about every field, which is a property
 * and not an example. It is the first test below.
 *
 * The vocabulary the generators draw from is tiny by design. Negotiation is
 * interesting only where a range and an offer actually meet, and three types
 * against three subtypes is what makes them meet often; the last test in the
 * file asserts the rate so that a widened alphabet cannot turn this suite into
 * two hundred vacuous passes.
 */

const type = fc.constantFrom('text', 'application', 'image');
const subtype = fc.constantFrom('plain', 'html', 'json');
const parameter = fc.constantFrom('charset=utf-8', 'charset=iso-8859-1', 'version=1');
const weight = fc.constantFrom('0', '0.001', '0.5', '0.8', '1');

/** `type/subtype`, `type/*` or the full wildcard — every shape §12.4.2 allows. */
const mediaRangeHead = fc.oneof(
  fc.constant('*/*'),
  type.map((value) => `${value}/*`),
  fc.tuple(type, subtype).map(([head, tail]) => `${head}/${tail}`),
);

/**
 * A well-formed member: head, then parameters, then the weight.
 *
 * In that order because the order is load-bearing — §12.4.2 puts the weight
 * after the media range, and everything following it is `accept-ext` rather
 * than a parameter of the type.
 */
const mediaRangeText = fc
  .tuple(mediaRangeHead, fc.array(parameter, { maxLength: 1 }), fc.option(weight, { nil: null }))
  .map(
    ([head, parameters, quality]) =>
      `${head}${parameters.map((value) => `;${value}`).join('')}${quality === null ? '' : `;q=${quality}`}`,
  );

const offerText = fc
  .tuple(type, subtype, fc.array(parameter, { maxLength: 1 }))
  .map(([head, tail, parameters]) => `${head}/${tail}${parameters.map((value) => `;${value}`).join('')}`);

const offers = fc.array(offerText, { minLength: 1, maxLength: 4 });

const acceptField = fc.array(mediaRangeText, { minLength: 1, maxLength: 4 }).map((members) => members.join(', '));

/** Members that are not in the grammar, each for a different reason. */
const malformedMember = fc.constantFrom(
  'text/',
  '/plain',
  'text plain',
  '*/json',
  'text/plain;q=2',
  'text/plain;q=1.5',
  'text/plain;q=-0.5',
  'text/plain;q=1e-3',
  'text/plain;q=0.5;q=0.6',
  'text/plain;charset=utf-8;charset=utf-8',
  'text/plain;note="unterminated',
  'text/plain;;',
  'text/plain;charset',
);

describe('selectMediaType (properties)', () => {
  it('gives the same answer however the client orders its ranges', () => {
    fc.assert(
      fc.property(
        fc
          .array(mediaRangeText, { minLength: 1, maxLength: 4 })
          .chain((members) =>
            fc.tuple(
              fc.constant(members),
              fc.shuffledSubarray(members, { minLength: members.length, maxLength: members.length }),
            ),
          ),
        offers,
        ([members, shuffled], offered) => {
          expect(selectMediaType(shuffled.join(', '), offered)).toBe(selectMediaType(members.join(', '), offered));
        },
      ),
    );
  });

  it('answers with something that was offered, or with nothing', () => {
    fc.assert(
      fc.property(
        fc.oneof(acceptField, fc.string(), fc.constant('')),
        fc.array(fc.oneof(offerText, fc.string()), { maxLength: 4 }),
        (header, offered) => {
          const chosen = selectMediaType(header, offered);
          if (chosen === null) return;
          expect(offered).toContain(chosen);
        },
      ),
    );
  });

  it('serves the server its own first preference when the client states none', () => {
    fc.assert(
      fc.property(fc.array(fc.oneof(offerText, fc.string()), { maxLength: 4 }), (offered) => {
        // §12.5.1: no `Accept` accepts anything. `null` and `undefined` are the
        // same case — `req.headers['accept']` is `undefined`, a caller reading
        // from a store may hold `null`.
        expect(selectMediaType(undefined, offered)).toBe(offered[0] ?? null);
        expect(selectMediaType(null, offered)).toBe(offered[0] ?? null);
      }),
    );
  });

  it('treats a field it cannot parse as a field that was not sent', () => {
    // §5.5's licence to ignore an invalid field value, and the reason the
    // alternative is worse: a 406 meaning "your Accept is unparseable" is
    // indistinguishable from one meaning "we have nothing you asked for", and
    // the two are fixed by different parties. One malformed member poisons the
    // whole field — `parseAccept` is all-or-nothing — so this holds wherever
    // the bad member lands.
    fc.assert(
      fc.property(
        fc.array(mediaRangeText, { maxLength: 3 }),
        malformedMember,
        fc.nat(),
        offers,
        (members, bad, at, offered) => {
          const poisoned = [...members];
          poisoned.splice(at % (poisoned.length + 1), 0, bad);
          expect(selectMediaType(poisoned.join(', '), offered)).toBe(offered[0] ?? null);
        },
      ),
    );
  });

  it('serves the first offer it can name to a client that accepts anything', () => {
    fc.assert(
      fc.property(fc.array(fc.oneof(offerText, fc.string()), { maxLength: 4 }), (offered) => {
        // Not `offered[0]`: an entry that is not a media type this server can
        // name is skipped rather than chosen, which is the distinction
        // `isMediaType` exists to let a caller make for itself.
        expect(selectMediaType('*/*', offered)).toBe(offered.find((offer) => isMediaType(offer)) ?? null);
      }),
    );
  });

  it('treats q=0 as a refusal rather than as a low ranking', () => {
    fc.assert(
      fc.property(offers, (offered) => {
        expect(selectMediaType('*/*;q=0', offered)).toBeNull();
      }),
    );
  });

  it('lets a concrete range outrank a wildcard whatever the wildcard weighs', () => {
    // §12.5.1's precedence rule: the *most specific* match decides, not the
    // highest-weighted one. This is what lets a field say "anything, except
    // HTML" — and reading the highest weight instead would serve the HTML the
    // client just refused.
    fc.assert(
      fc.property(type, subtype, weight, weight, (head, tail, concrete, wildcard) => {
        const offer = `${head}/${tail}`;
        const chosen = selectMediaType(`${offer};q=${concrete}, */*;q=${wildcard}`, [offer]);
        expect(chosen).toBe(Number(concrete) > 0 ? offer : null);
      }),
    );
  });

  it('reads a range repeated with two weights as the lower of them', () => {
    // Specificity cannot order a range against itself, so the tie-break is the
    // weight, and it is the *lower* one: a field saying both "yes" and "no"
    // about one media type has expressed no preference, and the safe reading of
    // a contradiction is the refusal.
    fc.assert(
      fc.property(type, subtype, weight, weight, (head, tail, first, second) => {
        const offer = `${head}/${tail}`;
        const chosen = selectMediaType(`${offer};q=${first}, ${offer};q=${second}`, [offer]);
        expect(chosen).toBe(Math.min(Number(first), Number(second)) > 0 ? offer : null);
      }),
    );
  });

  it('is unmoved by a range that matches nothing on offer', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc
            .tuple(subtype, fc.option(weight, { nil: null }))
            .map(([tail, quality]) => `text/${tail}${quality === null ? '' : `;q=${quality}`}`),
          { minLength: 1, maxLength: 3 },
        ),
        fc.array(subtype.map((tail) => `text/${tail}`), { minLength: 1, maxLength: 3 }),
        fc.tuple(subtype, weight).map(([tail, quality]) => `image/${tail};q=${quality}`),
        fc.nat(),
        (members, offered, irrelevant, at) => {
          const extended = [...members];
          extended.splice(at % (extended.length + 1), 0, irrelevant);
          expect(selectMediaType(extended.join(', '), offered)).toBe(selectMediaType(members.join(', '), offered));
        },
      ),
    );
  });
});

describe('isMediaType (properties)', () => {
  it('answers exactly the question selectMediaType cannot', () => {
    fc.assert(
      fc.property(fc.oneof(offerText, mediaRangeText, fc.string(), malformedMember), (value) => {
        // The two reasons `selectMediaType` returns `null` — "the client
        // refuses everything offered" and "what you offered is not a media
        // type" — are a 406 and a caller's own data problem. `isMediaType` is
        // the half a caller can ask about on its own, and the two must agree
        // about which values are nameable.
        expect(isMediaType(value)).toBe(selectMediaType('*/*', [value]) === value);
      }),
    );
  });
});

describe('the generators these properties rest on', () => {
  it('produces fields and offers that actually meet', () => {
    // The anti-vacuity guard. Every property above is a statement about the
    // answer; a corpus in which no range ever matches an offer makes almost all
    // of them statements about `null`. Measured at 55% on the pinned seed and
    // 51–55% across four others — the floor is set well below that, because
    // what it is meant to catch is a widened alphabet dropping the rate to
    // single digits, not the ordinary wobble between two seeds.
    const rate = sampleRate(fc.tuple(acceptField, offers), ([header, offered]) =>
      selectMediaType(header, offered) !== null,
    );
    expect(rate).toBeGreaterThan(0.35);
  });
});
