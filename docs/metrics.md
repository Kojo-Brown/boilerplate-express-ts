# Metrics: RED on a Prometheus endpoint

`src/metrics/` turns every request into three numbers and exposes them at
`/metrics`. The dashboard that reads them is checked in at
`grafana/dashboards/red-dashboard.json`.

```bash
pnpm dev
curl -s localhost:4000/metrics | grep http_requests_total
```

On by default — unlike tracing, which starts no SDK unless you point it at a
collector. The asymmetry is deliberate: a tracer with nowhere to send spans
patches every instrumented module and fails outward every few seconds, while a
registry nobody scrapes is three counters sitting in memory.

## RED, and why these three

**R**ate, **E**rrors, **D**uration are the questions you ask of a
request-driven service. USE — utilisation, saturation, errors — is what you ask
of the machine underneath it, which is why the process collectors are a separate
switch and a separate row on the dashboard.

| Metric | Type | Labels | What it answers |
| --- | --- | --- | --- |
| `http_requests_total` | counter | `method`, `route`, `status_code` | Rate *and* errors |
| `http_request_duration_seconds` | histogram | `method`, `route` | Duration |
| `http_requests_in_flight` | gauge | `method` | Concurrency |

Rate and errors come from one counter because an error rate is the ratio of its
`5xx` slice to the whole. A second counter for failures would be a second source
of truth for one number, and the two would disagree the first time somebody
touched one of them.

The gauge is not derivable from the other two. Rate × duration is Little's law,
which holds in the mean and says nothing about the moment the pool ran out — and
during a stall the rate *falls* and the histogram records nothing at all,
because nothing has finished. The gauge is the only line that moves. It is what
separates slow from stuck.

## Configuration

| Variable | Default | What it does |
| --- | --- | --- |
| `METRICS_ENABLED` | `true` | Whether the middleware and the endpoint are attached. |
| `METRICS_PATH` | `/metrics` | Where the exposition lives. Refused under `/v1`. |
| `METRICS_DEFAULT_METRICS` | `true` | Heap, RSS, fds, GC, event-loop lag. |
| `METRICS_MAX_ROUTE_LABELS` | `200` | Cap on distinct `route` values. |
| `METRICS_EXEMPLARS` | `false` | Attach trace ids to latency buckets. |

Two combinations are refused at boot, in `env.ts`:

- `METRICS_PATH` under `/v1`. The exposition is not part of the API, is not
  versioned with it, and should not be reachable by anything walking the
  documented surface. It is also the one path the service refuses to measure, so
  a collision would silently delete a real route's metrics.
- `METRICS_EXEMPLARS=true` with tracing off. Every exemplar would name a trace
  that was never exported, the exposition would switch to OpenMetrics for
  nothing, and the operator would have a panel whose dots never appear.

## Cardinality is the whole design

Everything difficult about this subsystem is one problem: every distinct
combination of label values is a time series, held in this process for as long
as it runs and in the scraper's index for as long as its retention. Three labels
taking five values each is 125 series and nobody notices. One label derived from
`req.url` is a series per URL anybody has ever sent, including the ones a
scanner made up — and the way that ends is the *scraper* running out of memory.

So each label is bounded by a different argument:

- **`route`** is the matched pattern, never the path, and is capped besides.
- **`method`** is folded onto seven verbs plus `OTHER`. Node's parser already
  rejects a method it has never heard of, so the set was finite anyway — just
  far larger than the seven this service answers.
- **`status_code`** is bounded by what the service returns.

Three label values are not routes and are worth recognising on a panel:

| Value | Means |
| --- | --- |
| `route="__unmatched__"` | Reached no route: scanners, stale links, typos. |
| `route="__over_limit__"` | `METRICS_MAX_ROUTE_LABELS` was hit. Something is generating route patterns — go and look. |
| `status_code="499"` | The client disconnected before the response finished. nginx's code, never sent on the wire. Usually a symptom of *this* service being slow. |

### Reconstructing the route label is harder than it looks

The obvious implementation reads `req.baseUrl + req.route.path` in a `finish`
listener. It is wrong, and it is wrong in a way that passes every test written
with a synchronous handler.

Express rewrites `req.baseUrl`, `req.url` and `req.params` on the way into a
mounted router and **restores them as the router stack unwinds**. They survive
exactly one case — a handler that writes its response synchronously and never
calls `next` — and the two cases that do not survive are the interesting ones:

- **an error response**, because the error travels up through each router's
  `done` callback, restoring as it goes, before the error middleware answers.
  `GET /v1/users/:id` without a token gets labelled `/:id`.
- **any asynchronous handler**, because the stack has unwound by the time the
  `await` resumes. That is most real handlers.

`req.originalUrl` and `req.route.path` are the two things that are never
rewritten, so `mountPrefix` takes the original path and removes as many trailing
segments as the matched pattern accounts for. Case is folded, because Express's
default routing is case-insensitive and `/V1/Users/1` would otherwise be a
second series — one per casing anyone tries, multiplying per segment.

What that leaves: a router mounted on a **parameterised** path
(`v1.use('/users/:userId/posts', …)`) has no pattern recoverable from the URL,
because Express 5 keeps a mount path only as a compiled matcher and not as a
string. Its parameter values land in the prefix. Mount routers on literal paths
— every router here does — and note that `METRICS_MAX_ROUTE_LABELS` is what
keeps the consequence of getting it wrong bounded rather than an outage.

A route registered against a regular expression or an array of paths has no
single searchable label, so it counts as `__unmatched__`. A wildcard or
optional-segment pattern consumes an unknown number of segments, so it is
labelled by its own pattern alone rather than by a guessed prefix.

## What is not measured

`/metrics` and `/v1/health` — the latter as a subtree, so `/v1/health/live`
and `/v1/health/ready` are covered too, which is what a prober is actually
pointed at. The health entry is the one worth explaining.

A readiness probe outnumbers real traffic in anything but a busy API, so its
rate swamps the rate panel and its count dominates the error *denominator*. But
the reason it is excluded rather than merely noisy is what it does during a
shutdown: `/v1/health/ready` answers 503 for the whole drain window **by design** (see
`docs/graceful-shutdown.md`), so with it measured every rolling deploy paints a
5xx spike on the error panel of a service that never failed a request. An error
rate that cries wolf on every deploy is an error rate nobody reads.

The same two paths are excluded from tracing, for related but not identical
reasons. They are kept as two lists: a deployment that wanted probe latency
graphed should not have to start exporting a span per probe to get it.

## Where the middleware sits

First in `createApp` — ahead of the body parsers, the session lookup and
passport. The histogram is meant to answer "how long did the client wait", and a
middleware installed after those times the handler and reports it as the
request's latency. The gap between the two is exactly where a slow session store
hides.

The endpoint is mounted ahead of `shutdownGuard` for a related reason: the
scrape that explains a shutdown is the one taken during it.

Both events are listened for. `finish` fires when a response is written and
`close` when the socket is done with; exactly one fires for an abandoned
request. Listening for `finish` alone leaks the in-flight gauge on every client
that hangs up, and that drifts upward forever and reads as a service slowly
wedging.

## Duration buckets are an SLO, not a measurement

```ts
[0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]
```

A histogram is only exact *at* its boundaries: `histogram_quantile` interpolates
inside a bucket, so a p99 landing between 1s and 2.5s is a straight-line guess
across that gap. The reading that is exact is the one the dashboard's fourth
stat panel uses:

```promql
sum(rate(http_request_duration_seconds_bucket{le="1"}[$__rate_interval]))
  / sum(rate(http_request_duration_seconds_count[$__rate_interval]))
```

That is "the fraction of requests served inside one second" — an objective, not
an estimate. It is why the boundaries are round numbers a human would write into
one, and why there are eleven of them rather than thirty: each boundary is a
series per route per method, paid on every scrape forever.

`status_code` is deliberately **not** on the histogram. A histogram is
`buckets + 2` series per label combination, so a fourth dimension multiplies by
far the heaviest metric here, where the same dimension costs the counter one
series each. The question it would answer ("how fast are the 500s?") is
answerable from traces; the question it would cost is the one you ask first.

## Exemplars: from a latency spike to the trace

With `METRICS_EXEMPLARS=true`, each duration bucket carries the trace id of a
request that landed in it, so a spike on a Grafana latency panel is one click
from the request that caused it. This is the seam between `docs/metrics.md` and
`docs/tracing.md`: without it the trace and the graph share no identifier, which
is two true things and neither of them useful at 3am.

Three consequences, all of them worth knowing before turning it on:

- **The exposition becomes OpenMetrics.** Exemplars are an OpenMetrics feature
  and the client refuses to construct an exemplar-enabled metric on a Prometheus
  registry, so the one flag picks both. Prometheus negotiates the format
  happily; a hand-rolled scraper or a `curl | grep` habit may not.
- **Only sampled traces get an exemplar.** A link to a trace that was never
  exported is a dead one — the dot appears, the click lands on "trace not
  found", and the operator learns to stop clicking. Under the default
  `OTEL_TRACES_SAMPLER_ARG=1` that is every request.
- **The scraper has to store them.** Prometheus needs
  `--enable-feature=exemplar-storage`, which the compose file below passes.
  Without it the ids are parsed and dropped, and the panels come up with no dots
  and no explanation.

`trace_id` is not a label. It is attached to a bucket, and a trace id that
became a label would be one time series per request — the single worst outcome
available here.

## Scraping it

The endpoint is unauthenticated, and that is a decision rather than an omission.
The exposition names every route this service has and how often each is called,
so it should not be reachable from the internet — but the control for that is
the network, not a credential: a scraper is configured with a target, not with a
login. The standard deployments all rely on the endpoint not being published — a
`ServiceMonitor` on a non-ingress port, a sidecar, a private subnet. Bearer auth
on a path a scraper cannot authenticate to would be a gate with a note beside it
saying how to open it.

```yaml
scrape_configs:
  - job_name: express-api
    metrics_path: /metrics
    static_configs:
      - targets: ['api:4000']
    # The fleet-wide half of the bound METRICS_MAX_ROUTE_LABELS enforces per
    # process: past this many samples in one scrape the target fails outright
    # rather than being ingested. A circuit breaker, not a budget.
    sample_limit: 5000
```

## Seeing the dashboard

The checked-in dashboard is verifiable rather than merely plausible: Prometheus
and Grafana are in `docker-compose.yml` behind a profile, so they start only
when asked for.

```bash
GRAFANA_ADMIN_PASSWORD=... docker compose --profile observability up
# Grafana on http://localhost:3001 — the dashboard is provisioned, no import
# Prometheus on http://localhost:9090
```

`grafana/provisioning/` wires the datasource and the dashboard provider;
`prometheus/prometheus.yml` is the scrape config. The provider is
`allowUiUpdates: false` on purpose — the dashboard is checked in, so a change to
it is a commit, and a provider that let the UI win would make the repository a
stale copy of whatever somebody last dragged.

The dashboard takes its datasource from a **variable** rather than a hard-coded
uid, because a uid identifies one Grafana's Prometheus and this file is checked
into a repository that several will import it from.

## Queries worth keeping

```promql
# Rate, by route. $__rate_interval and not a fixed window: a range below about
# four scrape intervals flickers as individual samples fall in and out of it.
sum by (route) (rate(http_requests_total[$__rate_interval]))

# Error ratio. 4xx is excluded — a client sending a bad request is not this
# service failing, and mixing the two makes the number useless as an alert.
  sum(rate(http_requests_total{status_code=~"5.."}[$__rate_interval]))
/ sum(rate(http_requests_total[$__rate_interval]))

# p99. Aggregate over `le` *before* taking the quantile: averaging per-instance
# quantiles is a quantile of quantiles, which is a quantile of nothing.
histogram_quantile(0.99, sum by (le) (rate(http_request_duration_seconds_bucket[$__rate_interval])))
```

## Adding a metric

Put it on `appMetrics.registry` and nowhere else. Every module in `src/metrics/`
takes what it needs as an argument, and `app-metrics.ts` is the single file that
reads configuration and holds the instance the running service uses — the same
composition-root rule `app.ts` follows for error translators.

Do not reach for the client's module-level default registry. It is shared by
every test in the process, registering a metric name on it twice throws, and the
first suite to import a module that registers something decides whether the
tenth one passes.

Before adding a label, ask what bounds it. If the answer involves anything a
caller chooses, the answer is no.
