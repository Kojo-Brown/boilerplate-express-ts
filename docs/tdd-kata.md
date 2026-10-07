# TDD kata: content negotiation for `Accept`

A worked record of one feature built red→green→refactor, one commit per step.
The feature is real and shipped — proactive content negotiation (RFC 9110
§12.5.1) in `src/http/accept.ts`, wired into `GET /v1/uploads/:objectId` — so
this is an account of how the code in the repository was actually arrived at,
not a demonstration written backwards from a finished answer.

## Why this feature

A kata needs a problem with enough real structure to punish guessing, and small
enough that each cycle is one idea. `Accept` qualifies on both counts: the
grammar has four or five layers that look independent and are not, and the
service genuinely lacked it — `req.accepts` appeared in no file, so every route
answered in its one format and a client that asked for something else was told
nothing.

It also had somewhere honest to land. `GET /v1/uploads/:objectId` serves a
stored object whose media type was fixed when the bytes were written, and this
service cannot transcode, so the answer to "will you take this?" is take it or
nothing. That is the case where a 406 is a fact rather than a decision. Before
this change the route ignored the field: a client asking for `image/jpeg` was
sent a PNG under a `200`, and a client that believes status codes hands those
bytes to its decoder.

## The rules followed

1. One step per commit, and the commit message states what was run and what it
   printed.
2. A red commit fails its **test**, not the toolchain. The first one ships a
   module that throws rather than no module at all — a missing import is a
   compile error, and a commit `pnpm typecheck` rejects is not independently
   checkable by anyone bisecting later.
3. Green is the least code that passes. Anything not demanded by a case waits
   for the case that demands it.
4. Refactor changes no behaviour, and the proof is that the test count and the
   test bodies are untouched.
5. No test is weakened to reach green. One expectation did change, in step 8,
   and the reason is recorded below rather than buried.

## The cycles

| Step | Commit | What it did |
| --- | --- | --- |
| 1 | `52f42a9` | red — exact media types, 5 failing |
| 2 | `ecab23c` | green — fold case, compare whole field, absent means anything |
| 3 | `515cc37` | red — the field is a list, with wildcards, 6 failing |
| 4 | `43f50db` | green — list scan, `type/*`, the full wildcard, specificity |
| 5 | `bd1af8d` | red — weights and `q=0`, 7 failing |
| 6 | `3bffb0d` | green — `q` read off the most specific matching range |
| 7 | `eff3a8e` | red — media type parameters and quoted values, 9 failing |
| 8 | `d09db56` | green — quoted-string-aware scanner, `tchar` validation |
| 9 | `26e397d` | **refactor** — `MediaType` split out of `MediaRange` |
| 10 | `eb01865` | red — an offer is a representation, 4 failing |
| 11 | `643bd67` | green — offers must be concrete and unweighted |
| 12 | `d280bd3` | red — 406 on the download route, 7 failing |
| 13 | `18a17ee` | green — negotiate between the 404 and the read |
| 15 | `4620921` | red — the answer must not depend on the order of the field, 2 failing |
| 16 | `d47d759` | green — `moreSpecific` orders every pair of matches |

Step 14 is the commit that added this document.

47 unit cases on the parser, 10 on the controller, 9 end-to-end through
`createApp`.

## What the cycles found that planning had not

**A splitter that silently misread correct requests (step 7).** Steps 4 and 6
split the field on `,` and each member on `;`. A parameter value may be a
quoted string, a quoted string may contain either character, so
`Accept: text/plain;note="a,b"` is one well-formed member that splitting tears
into two malformed ones. Combined with the all-or-nothing parse policy from step
4, the whole field was then discarded and the client answered with the server's
first preference — a correct request misread as an absent one, with nothing
anywhere reporting it. The bug was two commits old and writing the case down is
what surfaced it.

**A second bug hiding behind the first (step 8).** The scanner did not fix the
comma case on its own. Nothing checked that an *unquoted* value is a `tchar`
run, so `text/plain;note=a,b` parsed as an offer: the splitter cut at the comma,
each half arrived looking plausible, and the parser reconstructed a value the
sender never wrote. One failing case, two independent defects, and the second
was invisible until the first was fixed.

**Three tests that passed for the wrong reason (step 5).** Six of the weight
cases were green before weights existed. Three of those were green by accident:
with no parameter parsing, `application/json;q=0` read as the subtype
`json;q=0`, matched no offer, and produced the expected `null` by a route with
nothing to do with weights. They were kept rather than rewritten, because that
is the shape of test which passes forever while asserting nothing, and after
step 6 they hold for the right reason.

**One expectation that was wrong and had to change (step 8).** Cycle 3's
Prometheus case asserted `application/openmetrics-text` for bare offers of
`text/plain` and `application/openmetrics-text`. It passed only because
parameters meant nothing yet. Once they did, a range naming `version=1.0.0`
correctly does not match an offer carrying no version at all, both offers fall
through to the catch-all at `q=0.1`, they tie, and the server's own order
decides — so `text/plain` is the right answer for that call. The case now offers
the versions the server would actually produce, **and keeps the original
assertion as a second one** with its corrected expectation. Nothing was removed:
the earlier assertion was wrong about a feature it predated, which is different
from an assertion that became inconvenient.

**A design flaw the refactor exposed (steps 9–11).** Splitting `MediaType` out
of `MediaRange` was meant to be cosmetic. It made visible that one parser was
reading two different strings — a client's range, where wildcards and weights
belong, and a server's offer, where a wildcard names nothing and a weight is the
client's vocabulary in the server's mouth. Both were being parsed and silently
ignored, so `selectMediaType('*/*', ['*/*'])` answered with a media type no
route can write a body in. Fixing it inside step 9 would have been a refactor
that changed behaviour, so `parseOffer` was left as a one-line delegation — a
deliberate duplication, so the asymmetry had somewhere to be visible — and the
fix became step 10's failing test.

**A property the module claimed and did not have (step 15).** Found by probing
the finished parser rather than by a cycle, which is worth saying plainly:
thirteen steps of tests did not catch it. `qualityFor`'s own comment said that
reading the first match "would make the answer depend on the order the client
happened to list its ranges in" — and the code did depend on it, twice.
`specificity()` returned `2 + parameters.size` but counted parameters only on a
fully concrete range, so `text/*;charset=utf-8` tied with `text/*` and reversing
the field flipped the answer between a 406 and a 200; and a range written twice
with two different weights ties by construction. The fix compares breadth and
parameter count in order rather than adding them, because adding cannot be made
to work — lift the count into the wildcard branches and `text/*;a=1;b=2`
outranks `text/plain`. Every case in that block now runs forwards and reversed.

**An API the integration demanded (step 13).** `selectMediaType` returns `null`
for two unrelated reasons: the client refuses everything offered, and what the
caller offered is not a media type. On the download route those must not share
an answer, because the stored `Content-Type` is data decided at upload time: an
object labelled with a string the parser cannot read would be offered as
nothing, refused 406, and unreachable for good — while the very same response
would have carried that exact label had the client sent no `Accept`.
`isMediaType` exists because a test said so, not because the design foresaw it.

## Decisions the tests pinned down

- **Absent is not empty.** No `Accept` means anything is acceptable (§12.5.1).
  An empty `Accept` is a field listing zero ranges, and nothing satisfies it.
- **A malformed field is ignored, not refused.** §5.5 allows it, and the
  alternative answers 406 for a client's header bug — a status indistinguishable
  from "we have nothing you asked for", which sends the investigation to the
  wrong party. `parseAccept` still returns `null`, so a caller needing
  strictness has the distinction.
- **All-or-nothing parsing.** Honouring the members that parse and skipping the
  rest lets a typo change what the *other* members mean: drop a misspelled
  `text/html` and its low-weighted catch-all becomes the client's first choice.
- **Most specific wins, not highest or first.** That is §12.5.1's precedence
  rule, and it is what lets a field say "anything, except HTML". Reading the
  highest weight among matches serves the HTML the client just refused.
- **The order of the field means nothing.** It is a set of statements, so
  reversing it must not change the answer. Breadth is compared before parameter
  count, and a range repeated with two different weights is read as the
  refusal.
- **Server order breaks ties.** `offered` is the server's preference; `>` rather
  than `>=` keeps the first offer at a given weight.
- **Status ordering on the route:** 401 before 406 (nothing to negotiate with an
  unauthenticated caller), 404 before 406 (the stored type is the only offer
  there is, and a 406 for an empty key would answer differently for a key that
  exists — a probe oracle), and 406 before 304 (both empty, but a client told
  "not modified" caches the agreement that it may reuse a representation this
  request just established it cannot use).
- **Refuse before the read.** A 406 transfers nothing, so it must not cost a
  request to the object store.

## What this item did not do

Only the download route negotiates. Nothing else in the service has more than
one representation to offer, and mounting a negotiating middleware over `/v1`
would make every route answer 406 to a client whose `Accept` is narrower than
`application/json` — a gate whose only documented use is turning it off.

`Accept-Encoding`, `Accept-Language` and `Accept-Charset` are not implemented.
They share the weight grammar and almost nothing else: the first negotiates a
transfer coding rather than a representation, the second is matched by RFC 4647
language-range rules rather than by type/subtype, and the third is deprecated by
§12.5.2. `Vary` is not set by this change either — the download route's
representation cannot change for a given key, so it has no dimension to vary on,
but any future route that negotiates will need `Vary: Accept` before a cache
sees it.

The metrics endpoint still fixes its exposition format at boot
(`createMetricsRegistry`) rather than negotiating per scrape, which is what a
Prometheus scraper's `Accept` actually asks for. It is left alone deliberately:
exemplars are an OpenMetrics feature and the client refuses to construct an
exemplar-enabled metric on a Prometheus registry, so serving both formats means
two registries and a decision about which metrics exist in each. That is its own
item, not a line in this one.
