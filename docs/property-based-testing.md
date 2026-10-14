# Property-based testing

An example test says what a function does for the input somebody thought of. A
property says what is true of *every* input, and fast-check then tries two
hundred of them — including the ones nobody thought of, which in HTTP field
handling is most of the interesting ones: the entity-tag containing a comma,
the byte position with sixteen digits, the `Accept` field whose members arrive
in the other order.

```bash
pnpm test                       # properties run with everything else
pnpm test:property              # just the property suites
FC_SEED=$RANDOM pnpm test:property   # a deliberate exploration run
```

Seven suites, 76 tests — 72 properties and four generator-coverage guards. They
sit next to the example suites they extend (`src/http/range.property.test.ts`
beside `src/http/range.test.ts`) and share one configuration module,
[`src/tests/property.ts`](../src/tests/property.ts), whose own guard suite is
`src/tests/property-config.test.ts`.

## The three shapes worth writing

**Round-trip.** A printer and a parser that disagree anywhere disagree on some
value, and it is rarely the value in the example suite. `formatEntityTag` →
`parseEntityTagList` over generated `etagc` strings is the whole of the list
grammar in one statement, and it is the statement that fails against the
`header.split(',')` implementation this repository warns about twice and that
every hand-written example — `"v1"`, `"abc"`, `W/"2"` — passes.

**Metamorphic.** Two spellings the grammar calls equal must produce one answer:
leading zeros on a byte position, `BYTES` for `bytes`, the empty list members
the `#` rule tolerates, a `Retry-After` date read against a clock that has
advanced. The sharpest one in this repository is order. §12.5.1 makes nothing
of the order of an `Accept` field, and `accept.ts` carries a comment about a
version of `moreSpecific` that ranked a range as `2 + parameters.size`: it
scored `text/*;charset=utf-8` and `text/*` the same, so reversing the field
flipped the answer between a 200 and a 406. That comment is now the first test
in `accept.property.test.ts`, as a statement over every field rather than a
paragraph about one.

**Invariant.** A 206 must never name a byte the representation does not have.
`parseRetryAfter` must never hand a caller a `NaN` to put in a `setTimeout`. A
cursor must never skip a row. Each is one property and an unbounded number of
examples.

## What is covered

| Suite | The properties that carry it |
|---|---|
| `http/range` | Round-trip over the `byte-ranges-specifier` grammar; case, whitespace, empty members and leading zeros all inert; **every resolved range lies inside `[0, size-1]`**; a `last-pos` past the end behaves exactly like an open-ended range, 16-digit clamp included; a range-set that is not exactly one member is always ignored |
| `http/entity-tag` | Round-trip of single tags and of lists, over values that contain commas; junk between two tags poisons the whole field; the comparison algebra — strong implies weak, weakening kills a strong match and leaves a weak one alone — which is what stops the two functions collapsing into one |
| `http/accept` | **The answer does not depend on the order of the field**; the answer is always something that was offered; a field that cannot be parsed is treated as absent wherever the bad member lands; a concrete range outranks a wildcard whatever the wildcard weighs; a range repeated with two weights reads as the lower |
| `http/conditional` | `If-None-Match` suppresses `If-Modified-Since` entirely (§13.1.3); `If-None-Match` is weak comparison and `If-Range` is strong, asserted as different functions over the same pairs; dates compare at second granularity under arbitrary sub-second jitter |
| `http/retry-after` | Null or a non-negative safe integer, for every field and every clock; delta round-trip; the wait never grows as the clock advances and decreases by exactly the elapsed time until it hits zero; a number the grammar rejects never reaches `Date.parse` |
| `concurrency/etag` | `formatETag` → `parseIfMatch` round-trips every version a Postgres `integer` can hold; a well-formed tag that cannot name a row is dropped (412) while a weak tag fails the header (400), and the two outcomes are never reachable from each other |
| `lib/pagination` | Cursor round-trip over every JSON scalar; cursors are URL-safe and carry only the sort column and the id; placeholders and parameters always agree in number; **paging a generated dataset to exhaustion returns every row exactly once, in order** |

## Writing one

Import from `@/tests/property` — that module's import side effect is what pins
the seed and the run count, and `src/tests/property-config.test.ts` fails the
build if a `*.property.test.ts` file does not. Then:

**Make the generators meet.** The failure mode a property suite has and an
example suite does not is passing for free. A generator drawing media types
from a wide alphabet produces fields that match nothing, and every property
about the answer becomes a property about `null` — two hundred green ticks
asserting nothing. Three of the suites here therefore end with a measured
coverage assertion:

```ts
it('produces fields and offers that actually meet', () => {
  const rate = sampleRate(fc.tuple(acceptField, offers), ([header, offered]) =>
    selectMediaType(header, offered) !== null,
  );
  expect(rate).toBeGreaterThan(0.35);
});
```

Each of those guards caught something while this was being written. The range
fuzz corpus parsed in **0 of 200** samples on the first attempt — concatenated
fragments essentially never produce `bytes` + `=` + a well-formed list — and
two independently generated entity-tags had equal values in **1%** of samples,
which left "strong comparison implies weak comparison" true of almost nothing.
`etagValue` draws from a small fixed vocabulary for that reason, with a
generated tail for grammar coverage; the rates are now 51–55% and 10–15%, and
they are asserted so that widening an alphabet fails loudly instead of quietly.

**Quantify over the dependencies too.** Every module under property test here
takes its world as arguments — `resolveRange` takes the size, `parseRetryAfter`
takes `now`, `shouldApplyRange` takes the validators. That is what lets a
property say "the wait never grows as the clock advances", which is a sentence
about the clock and not about one instant.

**A counterexample becomes an example.** fast-check prints the shrunk input and
the seed. The fix lands with that shrunk value written into the module's
example suite, where it is named and explained. Properties do not replace the
example suites; the examples are where a specific decision is recorded, and a
counterexample is a decision that was missing.

## The seed is pinned

`DEFAULT_PROPERTY_SEED` is a constant, and `PROPERTY_RUNS` is 200. A merge gate
that samples fresh inputs on every run can fail a pull request for a reason
that has nothing to do with its diff, and "rerun the job" is not a diagnosis.

The cost of pinning is real and worth naming: a pinned seed is a large fixed
set of examples, not a search. Exploration is therefore something a person does
on purpose — `FC_SEED=$RANDOM pnpm test:property` — rather than something CI
does to an unrelated pull request. `resolveSeed` falls back to the pinned value
for anything that is not an integer, so `FC_SEED=yes` cannot silently become
seed 0.

## In the mutation scope, because it was measured

`pnpm test:mutation` measures nine modules against their own unit suites,
listed in [`mutation-scope.json`](../mutation-scope.json). The property suites
are in those `tests` entries, and they are there because the run was done twice
rather than because it sounded right:

| | Score | Survivors | Run |
|---|---|---|---|
| Example suites only | 94.35 | 34 | 7m11s |
| With the property suites | **94.68** | **32** | 7m29s |

Two mutants that the example suites leave alive, for 18 seconds on a
seven-minute job. Both are the same shape:

```
[Survived] StringLiteral
src/http/accept.ts:255:18
-     if (!(type === '*' || isToken(type))) return null;
+     if (!(type === "" || isToken(type))) return null;
```

That mutant stops a wildcard being a wildcard: `*` is not a token, so with it
applied, every field containing star-slash-star fails to parse. Nothing in the
example suite can see that, and the reason is worth keeping in mind when
writing one — a field that parses as star-slash-star and a field discarded as
malformed *both* end up serving the server's first offer, so every assertion
of the form "a client that accepts anything gets our first choice" passes
either way. What separates them is a refusal: `selectMediaType('*/*;q=0',
offered)` must be `null`, and under the mutant the field is malformed, is
therefore ignored, and the first offer comes back instead.

The `break` threshold stays at 92. The score rose by a third of a point, which
is three mutants, and a few tenths of the total are machine-dependent anyway —
a mutant that times out is scored as killed, so a busier runner scores
fractionally higher. The floor exists to catch a deleted assertion, and
spending those tenths on a tighter one would buy noise.

Two practical notes for anyone revisiting this. `coverageAnalysis: 'perTest'`
treats one `it` block running 200 cases as a single test, so a property is
all-or-nothing for mutant selection and costs its whole run against every
mutant it covers — which is where the 18 seconds went. And
`src/tests/mutation-scope.test.ts` asserts that `jest.mutation.config.ts`
resolves to exactly the declared `tests`, so a property suite leaving or
joining the scope is a deliberate edit to one file rather than something that
happens by accident.
