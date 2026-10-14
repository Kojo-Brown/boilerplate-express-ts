# Mutation testing

`pnpm test` says every line in `src/http/accept.ts` runs. It does not say any
assertion depended on one. The difference is not hypothetical: before this gate
existed, `breadth()` — the function that decides which of two matching media
ranges speaks for an offer — could have `return 0` and `return 1` swapped, or
both replaced by `return 1`, and the whole suite still passed. Every branch was
covered. Nothing checked the answer.

Mutation testing closes exactly that gap. Stryker makes one small, compiling
change to the source — flips a comparison, drops a negation, empties a block,
replaces a string literal — reruns the tests, and records whether any of them
noticed. A mutant that dies is a line some assertion depends on. A mutant that
*survives* is a line the suite executes without checking, and the score is the
proportion that die.

```bash
pnpm test:mutation              # the gate, as CI runs it
pnpm test:mutation:incremental  # same, remeasuring only what the diff touched
```

The HTML report lands in `reports/mutation/index.html`, with every survivor on
its own line of source. CI keeps it as an artifact on every run, pass or fail.

## What is measured, and what is not

Mutation testing is the most expensive gate in this repository by an order of
magnitude: a full run is 953 mutants and nine minutes of four CPUs, where the
entire unit suite is 60 seconds. Scoping it is therefore not a
concession, it is the design, and the scope is declared in
[`mutation-scope.json`](../mutation-scope.json) — one entry per module, each
with the reason it is there.

Two rules decide what goes in.

**Every dependency arrives as an argument.** No clock read, no `process.env`,
no module-scope pool, nothing ambient. That property is what makes a surviving
mutant *mean* something: a unit test can put the module into any state it
likes, so there is no mutant it was unable to reach, and a survivor is a
missing assertion rather than an untestable path. `sendByteRange` qualifies
even though it writes a response, because the response and the byte source are
both parameters. A repository that opens its own connection does not, and
adding one would move the threshold instead of the tests.

**Each module is measured against its own unit suite.** `jest.mutation.config.ts`
restricts `testMatch` to the `tests` entries in the scope file — not the whole
suite. This is the difference between an eight-minute run and an eighty-five
minute one, because the end-to-end suites import `createApp()`, which imports
everything, so Jest's related-test resolution selects nearly the whole suite for
any mutant in scope. It is also the more honest denominator: a mutant killed
only by an e2e request through the full stack tells you that *some* assertion
somewhere noticed, which is not the claim this gate makes. The claim is that
the module's own suite pins the module's own behaviour down.

`src/tests/mutation-scope.test.ts` fails `pnpm test` if the scope file names a
path that has been renamed away, if a listed suite does not import the module it
is listed against, if Stryker's `mutate` stops matching the declared scope, or
if `testMatch` is widened back to the default. Each of those would otherwise
make the score go *up* while meaning less.

"Its own unit suite" is both suites where a module has two: the example suite
and the `*.property.test.ts` suite beside it. That was measured rather than
assumed — the property suites take the score from 94.35 to 94.68 and the run
from 7m11s to 7m29s, killing two mutants no example could, both of them a
wildcard media range quietly ceasing to be a wildcard. See
[property-based testing](./property-based-testing.md). End-to-end suites stay
out, for the reason above.

## Reading a survivor

The report gives you a diff. Work out which input reaches it, then decide which
of three things you are looking at.

**A missing assertion.** Most survivors, and the whole point. The test exercised
the line and never checked the result:

```
[Survived] EqualityOperator
src/lib/pagination.ts:105:23
-     const hasNextPage = rows.length > limit;
+     const hasNextPage = rows.length >= limit;
```

Every `paginate` test used a row count either comfortably above or comfortably
below the limit, so nothing pinned the boundary — and the boundary is the
contract: the caller fetches `limit + 1`, so `limit` rows back means the table
ended here. Off by one in the other direction and the last page of every list
hands out a cursor to nothing. Write the case; the mutant dies.

**A test asserting less than it looks.** A case can execute the right code and
still be unable to fail:

```
Regex | src/http/accept.ts:147:8
-   if (!/^(?:0(?:\.\d{1,3})?|1(?:\.0{1,3})?)$/.test(value)) return null;
+   if (!/^(?:0(?:\.\d{1,3})?|1(?:\.0)?)$/.test(value)) return null;
```

There *was* a case for `q=1.000`. It offered one media type, and a malformed
`Accept` is treated as absent — so the server's first preference wins either
way, and "the weight parsed" and "the field was unreadable" were the same
answer. The fix is a second offer, not a new case.

**An equivalent mutant.** Some mutants cannot change any answer, and no test can
kill them. They are a real cost of this gate and the reason `break` is not 100:

```
ConditionalExpression | src/lib/pagination.ts:41:9
-   if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
+   if (false || parsed === null || Array.isArray(parsed)) {
```

A cursor whose payload is a number or a string reaches the missing-field check
below and earns the same `AppError(400, 'INVALID_CURSOR')` either way. Only the
`null` payload is distinguishable — `typeof null === 'object'`, so without that
disjunct the property read throws a `TypeError` and the 400 becomes a 500 — and
there is a case for it.

**Do not disable a mutant to make a run green.** `// Stryker disable next-line`
takes a mutant out of the denominator, and the two in this codebase are there
because the line is provably unobservable, with the proof next to it:

```ts
// Stryker disable next-line MethodExpression: Date.parse already skips surrounding whitespace, so no input distinguishes this from value
const parsed = Date.parse(value.trim());
```

That is a comment a reviewer can check and, if they disagree, delete. "The run
was red and I wanted it green" is not.

## The threshold

`thresholds.break` in [`stryker.config.mjs`](../stryker.config.mjs) is the gate:
below it, `stryker run` exits non-zero and the CI job fails. It is 92 against a
measured 94.35 — about fifteen mutants of headroom, so that an equivalent mutant
or two introduced by an unrelated refactor does not block a pull request, while
a real loss of assertion strength does.

All 35 mutants behind that number — 34 survivors and one the suite never
reaches — have been read, and every one of them is
equivalent: loop bounds where the index past the end reads `undefined` and the
loop exits anyway, `type === '*' || isToken(type)` where `*` is itself a `tchar`
so the first half can never decide anything, `instanceof`-style guards in front
of a property read that is already safe on a primitive. If you add a module to
the scope, expect its first measurement to be well under 94.

One blind spot the score cannot report on itself: this job runs on **one** Node
major. A line that exists for the behaviour of another one — `code ===
'ERR_STREAM_UNABLE_TO_PIPE'` in `isPrematureClose` is exactly that — has no
input on Node 22 that reaches it, so it carries a `// Stryker disable` naming
that reason. What covers it is the test matrix, not this gate.

Raise it when the score rises. The one thing never to do is lower it: a
survivor is either worth a test, or worth a disable comment with a reason.

## What it found

The gate was written against a suite that was already green, with 2,898 passing
tests. Measuring it the first time scored 82.66% and produced 104 survivors.
Seventy of them were real, and three were worth more than the tests that killed
them:

- **`isPrematureClose` could not work under test, and not only under test.** It
  asked `err instanceof Error`, and `pipeline` constructs its error in the realm
  `node:stream` was loaded in — so inside Jest's vm context the check is false
  for an error that is unmistakably Node's, and *every* cancelled download would
  have been reported as a failed transfer. The same is true of a worker thread.
  It now tests the `code`, which is the thing being asked about.
- **The whole catch block in `sendByteRange` was unasserted.** Emptying it, or
  inverting either branch, changed nothing any test could see: the three
  outcomes it distinguishes — swallow a hang-up, destroy a half-sent response,
  rethrow for the error middleware — are identical from the client's side, which
  is where every case was looking. They are now observed from inside the
  handler. Writing those cases then turned up a *runtime* difference this gate
  cannot see for itself: when a client hangs up during `open`, Node 22 reports a
  premature close and cleans both streams up, while Node 24 refuses the pipe
  with `ERR_STREAM_UNABLE_TO_PIPE` and cleans up neither — so on 24, a download
  cancelled inside that window both reached the error middleware as a failure
  and leaked the storage read it had just started. The fix is four lines, and it
  was CI's Node 24 leg that found it, on a case mutation testing had asked for.
- **`isMediaType` had no test at all.** An exported function, reported as covered
  because `selectMediaType` runs the same parser underneath it.

None of those findings was a failing test, a lint error, or a drop in line
coverage.
