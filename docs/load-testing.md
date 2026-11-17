# Load testing with a latency budget in CI

Five read paths, driven by k6 for a minute on every pull request, with a
95th-percentile ceiling on each that fails the build when it is exceeded.

| File | What it is |
| --- | --- |
| `src/tests/load/budgets.ts` | The names and the ceilings. Imports nothing, so both halves below can read it |
| `src/tests/load/script.ts` | The profile: five tasks, each asserting its own status code |
| `src/tests/load/run.ts` | Seeds, mints the run's token, starts the server, drives k6, writes the summary |
| `src/tests/load/check-budget.ts` | The gate: the ceilings, and everything that is an error rather than a breach |
| `src/tests/load/check-budget.test.ts` | 55 cases on the gate, because a gate that cannot fail is worse than no gate |
| `.github/workflows/ci.yml` → `load` | The job, between `mutation` and `docker` |

Run the whole thing exactly as CI does:

```
pnpm test:load
pnpm check:load
```

It needs a Postgres on `DATABASE_URL` and the same secrets the config module
validates at boot — the environment `pnpm test` and `pnpm migrate` already want
— plus a Docker socket for the k6 image. It takes about eighty seconds, sixty
of which are the run.

## Why the measurement and the gate are two commands

This is the same split as `pnpm test:mutation` and `thresholds.break`, and it is
there for a sharper reason than taste. k6 *can* gate: `options.thresholds` fails
a run and exits 99. It should not be what gates this one.

**A k6 threshold cannot fail for want of data.** A tagged submetric exists only
if a threshold names it, and k6 scores one that recorded nothing as `p(95)=0` —
then reports the threshold on it as **passing**, because zero is less than
whatever the ceiling was. That is measured, not assumed:

```
http_req_duration{name:NEVER REQUESTED}
  {"values":{"avg":0,"min":0,"p(95)":0},"thresholds":{"p(95)<1":{"ok":true}}}
exit 0
```

So a task renamed, deleted, or raising before it sends leaves k6 green having
measured nothing — which is the single most likely way for a load gate to rot,
and the one failure a latency ceiling is least able to notice.

**A k6 threshold has no tests.** Every refusal in `check-budget.ts` is exercised
in `check-budget.test.ts` against summaries built by hand. There is no way to
establish the same about `options.thresholds` without a server slow enough to
breach them on demand, and a gate nobody has watched fail is a gate nobody
should trust. The gate has also been watched failing on a real run, by lowering
one ceiling to 2ms against a recorded 2.46ms:

```
FAIL  GET /v1/users/:id (uncached)       2.46ms  2.00ms  1800
  - "GET /v1/users/:id (uncached)" p95 2.46ms exceeds 2.00ms.
exit 1
```

**A threshold in the profile puts the ceiling in the file that decides what is
measured**, so one commit could move both.

What the profile's `thresholds` block does therefore hold is nothing: five
`p(95)>=0` and five `count>=0`, declared only because that is the one API k6
offers for making a tagged submetric appear in the summary at all. The run then
passes `--no-thresholds`, which turns evaluation off *and* drops a declared
submetric that recorded nothing instead of exporting it as a passing zero —
which is exactly what the gate's "absent from the summary" refusal needs.

Both halves are one command each and both run locally. That is not a
convenience: a load test is the easiest gate in the world to end up as eight
lines of `run:` that exist nowhere else in the repository, and this repository
has already paid for a gate only CI could run (see the Phase 0 note in
`SPEC.md`).

## The profile

30 iterations a second for 60 seconds against one Node process; five sequential
requests per iteration, so 1,800 per name and ~150 req/s aggregate.

| Request name | What it exercises |
| --- | --- |
| `GET /v1/health/live` | The middleware stack and nothing else. The floor the rest are read against |
| `GET /v1/health/ready` | A live `SELECT 1` through the pool on every request |
| `GET /v1/users/:id (cached)` | The real read path, warm: bearer verify, request scope, object-level authorisation, a cache hit, the entity tag, serialisation |
| `GET /v1/users/:id (uncached)` | The same route forced to miss, so every request reaches `findById` |
| `GET /v1/users/:id (If-None-Match)` | The same read answered 304 from the validator |

Five decisions in that table are worth their reasoning.

**`constant-arrival-rate`, not a fixed VU count.** N users with no wait time is a
saturation test: it pushes until something queues, and the latency it reports is
the depth of that queue rather than the service's response time. A declared
arrival rate makes the offered load a parameter and the response time the thing
measured, which is what a ceiling can be put on. 150 req/s against single-digit
millisecond responses is nowhere near the knee, deliberately — finding the knee
wants a ramp, not a ceiling.

**`GET /v1/health/live` earns its place because this stack is twelve
middlewares deep.** `createApp()` mounts security headers, the metrics timer,
CORS, a raw-body branch for webhooks, two body parsers, `session()`, passport,
the correlation id, the trace context, the access logger, the container scope and
the shutdown guard before any router sees a request. A middleware added to that
chain shows up in this row first and most clearly.

**Readiness is measured with its cache off.** `run.ts` starts the server with
`HEALTH_CACHE_TTL_MS=0`. The default is 1000ms and the profile probes every
~33ms, so about 149 of every 150 requests would be answered from the probe's own
cache: a budget on a database round trip with no database round trip under it,
reading as a duplicate of the row above.

**The cached and uncached rows are the same route, and the difference is
deliberate.** `usersCache` is a 200-entry LRU keyed on principal and URL
(`users.controller.ts`), with a 5s TTL. The cached row asks for one id, which
`run.ts` has already fetched once, so every request in the run is a hit
including the first. The uncached row cycles through 400 ids in
`exec.scenario.iterationInTest` order — round robin over a set twice the store's
capacity, which is the classic worst case for an LRU — so an id is always
evicted before it is asked for again.

The warm id is deliberately *not* a member of that pool — `run.ts` seeds 401
users and keeps the first aside. Taken from the pool it would be re-read by the
cached row every ~33ms and so permanently resident, and the uncached row would
score about five of its 1,800 requests as hits on the one id it is cycling past.
Five in 1,800 moves no percentile; it just makes the row mean something other
than what it says.

That the row misses is checked rather than asserted.
`pg_stat_user_tables.idx_scan` on `users`, reset beforehand:

| | index scans on `users` |
| --- | --- |
| Seeding alone (both `ON CONFLICT` statements, the admin lookup, the id read) | 403 |
| A full run | 2,217 |
| Difference | 1,814 |

1,801 of those are one per request of the uncached row — the arrival-rate
scheduler emits one extra iteration at the boundary, which is why the floors are
1,500 and not 1,800 — and the remaining ~13 are the warm key being re-read as
its 5s TTL expires across a 60s run, plus the one `run.ts` makes itself. The
latency gap corroborates it: the uncached row is consistently 1.5 to 2 times the
cached row's p95.

**Every task asserts its own status.** This is the part that is easy to leave
out and expensive to leave out: a 401 is fast and a 404 is faster, so a budget
on latency alone passes comfortably against a run in which nothing was
authorised. The conditional task requires **304** and not "2xx or 304", because
a 200 there means the tag no longer describes the resource and the row has
quietly become a second copy of the unconditional read.

### No writes, and what it would take to add them

`POST /v1/auth/login` costs an argon2 verification by design and is behind
`loginRateLimiter`, so a sustained login load would measure the rate limiter.
`PUT /v1/users/:id` would be worse: it requires `If-Match` and the row's version
is bumped by a database trigger on every success, so concurrent users would
spend the run losing preconditions to each other and the gate would be reading
the latency of 412s. `POST /v1/users` claims an idempotency key per principal,
and every virtual user here shares one.

A write profile is a worthwhile separate item. It needs an id per virtual user,
and its own ceilings — a conditional `UPDATE … WHERE version = ?` inside a
retryable transaction belongs nowhere near the numbers below.

### The one token, and where it goes

`run.ts` seeds an administrator and mints an access token for it with
`signAccessToken` rather than logging in: the token is stateless here —
`authenticateRequest` verifies the signature and never looks the subject up — so
a login would only add an argon2 hash and a rate limiter to the setup. The
administrator is still a real row, because the next reader of the profile should
not have to establish that for themselves.

Nothing in the seeding is a credential. The addresses are under `.invalid`
(reserved by RFC 2606, can never resolve) and the rows carry no password hash at
all, so no password exists and none of them can authenticate. The token is
minted per run, reaches k6 through one child process's environment — `docker run
-e NAME` without a value, so it is never on a command line — and is never
printed or written to a file.

## Budgets

`LOAD_BUDGETS` in `src/tests/load/budgets.ts`:

| Request name | p95 on CI | local, idle | local, busy | Budget | Request floor |
| --- | --- | --- | --- | --- | --- |
| `GET /v1/health/live` | 0.72ms | 1.47ms | 1.70ms | 25ms | 1500 |
| `GET /v1/health/ready` | 1.03ms | 2.79ms | 4.19ms | 40ms | 1500 |
| `GET /v1/users/:id (cached)` | 0.71ms | 1.68ms | 1.97ms | 30ms | 1500 |
| `GET /v1/users/:id (uncached)` | 1.38ms | 3.01ms | 4.61ms | 50ms | 1500 |
| `GET /v1/users/:id (If-None-Match)` | 0.60ms | 1.59ms | 2.00ms | 30ms | 1500 |

**CI** (`ubuntu-latest`, Postgres 16 as a service container): 9,005 requests,
0 failures, 0 dropped iterations, 1,801 per name, aggregate p95 1.00ms; the
whole job, image pull and migrations included, is 104 seconds.

**Locally**, a four-core machine with a `postgres:16-alpine` container on
loopback, 9,000 requests a run, 0 failures. The idle column is the worst of six
runs with nothing else happening — worst-of-several rather than one sample,
because a developer's machine is also doing other things and one run understates
the spread. The busy column is one run taken while `pnpm test:mutation` had the
other cores: unintentional, and then kept, because a runner shares itself with
the server it is measuring and that is the condition a budget has to survive.
The gap between the two local columns says what sharing costs — little on the
paths that only touch memory, half as much again on the two that wait for
Postgres.

**The runner is two to three times faster than the local machine**, which is
worth knowing before reading a red job as "CI is slow today": on this workload
it is the quickest of the three columns, so a p95 near a ceiling there is a
genuine regression and not the environment.

**The budgets are not tightened to the CI column, deliberately.** They are ten
to fifteen times the *worst* measurement — the busy local one — because that is
the machine the gate also has to be runnable on. Pinned to CI's numbers the
ceilings would be around 2ms, and the gate would fire on any developer with a
build running in another terminal, which is how a gate gets switched off.

**These are regression bounds, not an SLO.** The multiple is what hardware
spread costs rather
than a round number somebody liked. What they catch is the change that moves a
response time by a *multiple*: an N+1 query added to a read path, a middleware
that now hashes something per request, a dependency check made serial, the users
cache removed. What they deliberately
do not catch is a 30% drift, which on this hardware cannot be told apart from
the runner's mood — and a gate that fires on noise gets switched off, and then
catches nothing at all.

**The two 304 and 200 ceilings are equal, and that is the interesting one.** The
tempting version budgets revalidation *below* the unconditional read, because
revalidation is cheaper. At this payload it is not cheaper in time: a user is
about 230 bytes, so the saving is bytes on the wire, and the two measure within
0.2ms of each other on every run made so far, CI included, where the 304 is
0.11ms quicker. A ceiling encoding "the 304 must
be faster" would be gating on noise. Re-measure before changing that, on a
resource whose representation is large enough for the claim to be about
milliseconds.

The CI column is the job's first run. It has since passed a second time on the
same pull request, in 98 seconds, which establishes that the job is repeatable
but not what its spread is — the numbers above were not re-read from that run.
A few more will say whether 1.00ms aggregate is the runner's normal or a quiet
afternoon on it; if the runner turns out to vary by more than the local machine
does, the column to re-derive the multiples from is whichever ends up worst,
and the change belongs in a commit that says so.

### Re-measuring, and changing a budget

Run the two commands at the top of this file; the gate prints the table whether
it passes or fails. On hardware slower than the column above, pass
`--headroom 2` rather than editing `LOAD_BUDGETS` — the flag multiplies every
ceiling, refuses a value below 1 so it can only loosen, and leaves the committed
numbers as the thing CI gates on.

Lowering a budget to turn a red build green is the one move this gate exists to
prevent. If a change genuinely makes an endpoint slower and that is acceptable,
raise the ceiling in the same commit, with the measurement and the reason, and
say so in the pull request.

## What is an error rather than a breach

Six checks beyond the percentile, each closing a way for a load test to pass
having measured nothing.

- **A budgeted name absent from the summary.** The one k6 cannot do, for the
  reason at the top of this file.
- **A name that recorded zero requests.** The task raised before sending.
- **A floor on the request count per name.** A p95 over thirty samples is not a
  p95. The profile produces 1,800 per name, so the floor at 1,500 is slack for
  the ramp at either end and nothing more.
- **Requests that belong to no budgeted name.** The aggregate `http_reqs` count
  must equal the sum of the per-name counts. A task added with a tag nobody
  budgeted — or with no `name` tag at all — lands in the aggregate and in no
  submetric, so it would be driven, would cost the server capacity, and would be
  gated by nothing. k6 cannot express this at all. Adding a path is therefore a
  deliberate edit to `LOAD_BUDGETS` with a number to justify.
- **Any failed request, and any failed status check.** Zero outright. Every task
  asserts its own status, so a failure here is a 401, a 503 or a 304 that came
  back 200 — in each case the run measured something other than what it claims
  to, and usually something *faster* than the response it replaced.
- **Any dropped iteration.** k6 drops one when the arrival rate cannot be met
  from its VU pool. That is not a latency breach and not noise: it means the
  offered load stopped being the declared one partway through, so every
  percentile in the run belongs to some other, lighter test.

### `http_req_failed` counts the opposite of what it looks like

`http_req_failed` is a k6 *Rate*, and a Rate counts the observations that were
**true** as `passes`. The observation is "this request failed", so a clean run
exports:

```json
"http_req_failed": { "passes": 0, "fails": 9000, "value": 0 }
```

Nine thousand `fails` is nine thousand requests that were *fine*. The gate reads
`passes`. `checks` is a Rate too, in the same document, and its observation is
"this check passed" — so there the field to read genuinely is `fails`. Two
Rates, opposite polarity, adjacent. `check-budget.test.ts` has a case for each
direction, because reading one the other way round would fire on every healthy
run and go quiet on a run where everything broke.

## Two mechanics worth knowing before editing the profile

**The profile is TypeScript, and the import of `budgets.ts` is type-only.** k6
v0.57 and later run TypeScript directly (types are stripped, not checked), which
is why `script.ts` lives under `src/` and is covered by `pnpm typecheck` and
`pnpm lint` like everything else. But k6 resolves a relative specifier on disk
and wants the extension — `'./budgets'` fails with *couldn't be found on local
disk at /loadtest/budgets* — while TypeScript's `node` resolution refuses a
specifier ending in `.ts`. No value import satisfies both. A `import type` is
erased before k6 sees it, so it satisfies neither and does not need to: the
runtime list of names is `Object.keys(tasks)`, and `tasks` is declared
`Record<LoadRequestName, …>`, so the names the profile drives are the names
`budgets.ts` declares — checked by the compiler rather than restated.

That also means a name cannot be added without a budget: `LOAD_BUDGETS` is keyed
by the same union, so a new task fails to compile until both exist. The
equivalent arrangement in `boilerplate-python-fastapi` is an import direction —
the locustfile imports its task names from the gate — which achieves the same
thing by convention.

Each task is handed the key it was found under and tags its request with *that*,
rather than writing the string a second time. Spelled twice, a task could be
keyed `(cached)` and tagged `(uncached)`, and the run would gate one row against
the other's latency with everything green; the typecheck cannot see inside a
string.

**The server's log goes to a file, never to a pipe.** `requestLogger` writes an
access-log line per request and this profile makes 9,000 of them — around
700 KB. A pipe nobody drains holds 64 KB before the *writer* blocks, so partway
through the run the server would stop answering, stop responding to SIGTERM, and
leave no error anywhere saying the run had been truncated. `run.ts` opens
`reports/load/server.log` and hands the child that descriptor. The same bug is
recorded in `boilerplate-python-fastapi/docs/load-testing.md`; it is a property
of pipes and not of either framework. The log is kept rather than discarded — it
is the only account of what the application did during the run, and the `load`
job uploads it with the summary.

## How k6 is invoked

Through the image pinned by digest in `run.ts` (`grafana/k6` v2.4.0), over the
Docker socket, with `--network host` so it can reach the server on loopback.
Pinned for the same reason `docs/integration-testing.md` pins
`postgres:16-alpine`, plus one specific to this gate: k6's own client overhead
lands inside `http_req_duration`, so a ceiling is only comparable across runs
made with the same k6.

Two details of that command are load-bearing and both were found by the run
failing:

- `--user` is passed, because k6's image runs as uid 12345 and cannot write into
  a directory owned by whoever checked the repository out. Without it the run
  ends in one line of k6 log — *could not open …: permission denied* — followed
  by **exit 0**.
- `--summary-export <path>` rather than a `handleSummary` hook. Exporting from
  the hook *replaces* k6's own end-of-test report, so the run would print
  nothing a person could read — and a red gate sends its reader to exactly that
  output. Note that the two write different shapes: a hook receives each metric
  wrapped in `{ type, contains, values }`, while `--summary-export` writes the
  readings flat. The gate reads the flat form and reports every row as absent if
  handed the other.

Set `LOAD_K6_BIN` to a locally installed k6 to skip Docker — on macOS, where
`--network host` does not reach the host, that is the easier route. Both routes
are exercised; read the version the binary reports before comparing a number to
the table above.

## Interpreting a red `load` job

| Message | What it means |
| --- | --- |
| `p95 …ms exceeds …ms` | A real regression, or the runner was loaded. Re-run once; if it repeats, it is the change |
| `request(s) failed` | Read `reports/load/server.log`. Usually a 401 (the token or the seeding broke) or a 503 (readiness lost Postgres) |
| `status check(s) failed` | A path answered something other than the status its task requires — most likely the 304 row came back 200 |
| `below the floor of N` | The server could not keep up with 150 req/s, or the profile stopped driving that path every iteration |
| `belong to a budgeted name` | A task was added without a budget, or a request went out with no `name` tag |
| `absent from the summary` | A task was renamed or removed. Rename it in `LOAD_REQUEST_NAMES` too |
| `iteration(s) were dropped` | The run did not offer the declared load; its percentiles describe a lighter test |
| `is not a k6 end-of-test summary` | The file is truncated or was produced some other way. Re-run `pnpm test:load` |
| `the server ignored SIGTERM` | A shutdown task is hanging. `reports/load/server.log` has the last thing it did |

## Related

- `docs/integration-testing.md` — the other gate that has to run in both places, and the pinned-image argument
- `docs/mutation-testing.md` — the same measure-then-gate split
- `docs/metrics.md` — the middleware whose position `GET /v1/health/live` measures
- `docs/health-checks.md` — what `/v1/health/ready` actually probes, and the cache this run turns off
- `docs/optimistic-concurrency.md` — the entity tag the conditional row revalidates against
- `docs/graceful-shutdown.md` — the drain this run skips with `SHUTDOWN_DRAIN_DELAY_MS=0`
