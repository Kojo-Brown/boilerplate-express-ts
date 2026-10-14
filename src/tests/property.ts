import fc from 'fast-check';

/**
 * The shared half of this repository's property-based tests: the global
 * fast-check configuration, and the arbitraries more than one suite needs.
 *
 * ## What a property suite is for here
 *
 * The example suites next to each module say what it does for the inputs
 * somebody thought of. A property says what is true of *every* input, and the
 * three shapes worth writing down are the three that keep catching real bugs in
 * HTTP field handling:
 *
 * - **Round-trip.** A printer and a parser that disagree anywhere disagree on
 *   some value, and the value is rarely the one in the example suite: it is an
 *   entity-tag containing a comma, a byte position with sixteen digits, a
 *   `Retry-After` of exactly `Number.MAX_SAFE_INTEGER / 1000`.
 * - **Metamorphic.** Two spellings the grammar says mean the same thing must
 *   produce the same answer — leading zeros on a position, `BYTES` for `bytes`,
 *   the empty list members the `#` rule tolerates, and above all the *order* of
 *   an `Accept` field, which §12.5.1 makes nothing of. `accept.ts` carries a
 *   comment about an earlier version whose answer flipped when the field was
 *   reversed; `accept.property.test.ts` is that comment as an executable
 *   statement.
 * - **Invariant.** A 206 must never name a byte the representation does not
 *   have. That is one line as a property over every (range, size) pair and an
 *   unbounded number of `it` blocks as examples.
 *
 * ## Determinism
 *
 * The seed is pinned. A merge gate that samples fresh inputs on every run is a
 * gate that can fail a pull request for a reason that has nothing to do with
 * its diff, and "rerun the job" is not a diagnosis — so the gate is
 * reproducible by construction and exploration is something a person does
 * deliberately:
 *
 * ```
 * FC_SEED=$RANDOM pnpm test:property
 * ```
 *
 * A counterexample found that way is not left to the next seed to rediscover.
 * fast-check prints the shrunk input and the seed that produced it; the fix
 * lands with the shrunk value written into the module's example suite, where it
 * is named, explained and cannot be lost to a reseed.
 *
 * `src/tests/property-config.test.ts` asserts that this configuration is what
 * the suites actually run under, and that every property suite imports this
 * module — a property file that silently fell back to the defaults would be
 * running a tenth of the cases its name implies.
 */

/**
 * Cases per property.
 *
 * 200 rather than fast-check's default 100: every module under property test
 * here is a pure function over small values, so the whole property pass is
 * seconds inside a 66-second suite, and the generators below deliberately draw
 * from small alphabets — doubling the sample is the cheapest way to make a
 * collision between two generated media types or entity-tags likely rather than
 * merely possible.
 */
export const PROPERTY_RUNS = 200;

/**
 * The seed the gate runs on.
 *
 * The constant is the date it was pinned and has no other meaning; a seed is not
 * a tuning knob, and a property that only passes under one is a property with a
 * counterexample nobody has written down yet.
 */
export const DEFAULT_PROPERTY_SEED = 20_261_014;

/**
 * `FC_SEED` if it names an integer, the pinned seed otherwise.
 *
 * Exported so that both branches are testable: the fallback is the one that
 * runs in CI and it is reached by *not* setting a variable, which is a
 * condition no assertion can observe from inside a process that has it set.
 * A malformed `FC_SEED` falls back rather than failing — the variable exists to
 * make an exploration run easy, and `FC_SEED=yes` silently becoming seed 0
 * would be worse than ignoring it.
 */
export function resolveSeed(raw: string | undefined): number {
  if (raw === undefined || !/^-?\d+$/.test(raw)) return DEFAULT_PROPERTY_SEED;
  const seed = Number(raw);
  return Number.isSafeInteger(seed) ? seed : DEFAULT_PROPERTY_SEED;
}

export const PROPERTY_SEED = resolveSeed(process.env['FC_SEED']);

fc.configureGlobal({ seed: PROPERTY_SEED, numRuns: PROPERTY_RUNS });

/**
 * `OWS` (RFC 9110 §5.6.3): the optional whitespace a recipient must tolerate
 * where the grammar permits it. Bounded at three characters because a parser
 * that handles three handles thirty — the branch is a loop either way.
 */
export const ows = fc.stringMatching(/^[ \t]{0,3}$/);

/**
 * `etagc` (RFC 9110 §8.8.3): `%x21 / %x23-7E / obs-text`.
 *
 * Everything but the double quote, controls and DEL. Weighted toward the
 * delimiters rather than uniform over the 221 legal characters, because uniform
 * is what makes a comma rare — and a comma inside an entity-tag is the single
 * input that separates this module's scanner from the `split(',')` it exists to
 * avoid. `obs-text` keeps its share as the half of the range a test author never
 * types.
 */
export const etagChar = fc.oneof(
  { arbitrary: fc.constantFrom(',', ';', '=', '/', 'W', '!', '*'), weight: 3 },
  { arbitrary: fc.integer({ min: 0x23, max: 0x7e }).map((code) => String.fromCharCode(code)), weight: 2 },
  { arbitrary: fc.integer({ min: 0x80, max: 0xff }).map((code) => String.fromCharCode(code)), weight: 1 },
);

/**
 * An entity-tag's opaque value, without the quotes. Empty is legal.
 *
 * A small fixed vocabulary most of the time, a generated string the rest. The
 * vocabulary is not a convenience: comparison is octet equality, so a property
 * about *matching* says nothing unless two generated tags are sometimes equal,
 * and two independent draws from a 221-character alphabet essentially never are
 * — measured at 1% collisions, which left `strong implies weak` asserting almost
 * nothing. The generated tail is what keeps the grammar covered; the vocabulary
 * is what makes the comparison properties bind. Both rates are asserted in
 * `entity-tag.property.test.ts`.
 */
export const etagValue = fc.oneof(
  { arbitrary: fc.constantFrom('1', '2', 'v1', 'a,b', ''), weight: 3 },
  { arbitrary: fc.array(etagChar, { maxLength: 12 }).map((chars) => chars.join('')), weight: 1 },
);

/** A parsed entity-tag, weak or strong. */
export const entityTag = fc.record({ weak: fc.boolean(), value: etagValue });

/**
 * An instant on a whole second, in the range an `HTTP-date` can carry.
 *
 * Whole seconds because that is all the three date formats in §5.6.7 carry: a
 * millisecond generated here would be a millisecond no round-trip through a
 * header could preserve, and the property would be asserting the test's own
 * rounding rather than the module's.
 */
export const httpInstant = fc
  .date({ min: new Date('1970-01-01T00:00:00Z'), max: new Date('2200-01-01T00:00:00Z'), noInvalidDate: true })
  .map((date) => new Date(Math.floor(date.getTime() / 1000) * 1000));

/**
 * A scalar that survives `JSON.parse(JSON.stringify(x))` unchanged.
 *
 * What a pagination cursor may carry, and bounded to exactly that: a cursor is
 * JSON in base64url, so a `Date` or an `undefined` in a sort column is a value
 * the round-trip property would be wrong to claim preservation of.
 */
export const jsonScalar = fc.oneof(
  fc.string({ maxLength: 24 }),
  fc.integer({ min: -1_000_000, max: 1_000_000 }),
  fc.boolean(),
  fc.constant(null),
);

/**
 * The share of a sample that satisfies `predicate`, for the anti-vacuity guards.
 *
 * The failure mode a property suite has that an example suite does not is
 * passing for free: a generator whose `Accept` fields never match any offer, or
 * whose entity-tags never collide, proves nothing and reports it as a pass. Each
 * suite that depends on its generators hitting an interesting case asserts the
 * rate here, against the same pinned seed the properties run under, so the day a
 * generator stops producing matches is the day a test fails rather than the day
 * the suite quietly stops measuring.
 */
export function sampleRate<T>(arbitrary: fc.Arbitrary<T>, predicate: (value: T) => boolean): number {
  const sample = fc.sample(arbitrary, { numRuns: PROPERTY_RUNS, seed: PROPERTY_SEED });
  return sample.filter(predicate).length / sample.length;
}
