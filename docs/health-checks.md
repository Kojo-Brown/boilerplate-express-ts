# Health checks: liveness vs readiness

`src/health/`

```
GET /v1/health/live    is this process alive?            never touches a dependency
GET /v1/health/ready   should it be sent traffic?        runs the dependency checks
GET /v1/health         alias for /ready, pre-split       unchanged behaviour
```

## Why two endpoints and not one

The two questions look like the same question and they are not, because the
correct answer to each is *opposite* in the two situations that matter.

**During a drain.** `SIGTERM` lands and readiness must go 503 immediately, while
the process is still serving normally — that is what buys the load balancer time
to notice and stop routing here before anything closes. Liveness must stay 200
throughout, because failing liveness is how you ask a kubelet to *restart the
container*, and restarting a container in the middle of its own graceful
shutdown kills every request the drain existed to finish.

**During a dependency outage.** Postgres goes away and readiness must go 503:
this replica cannot serve, and the balancer should try another. Liveness must
stay 200, because the database is down for *every* replica. A liveness probe
wired to dependency checks restarts the entire deployment at once — repeatedly,
since restarting changes nothing about Postgres — and the reconnect storm from
those restarts is actively in the way of recovery. It is the most damaging thing
a health endpoint can be made to do, and it is what happens by default the
moment liveness is pointed at a readiness handler.

One endpoint has to pick one answer in each case, and either choice breaks the
other. Hence two.

### What liveness is allowed to do

Almost nothing, and that is the specification rather than an unfinished
implementation. It reports that the process is running and its event loop is
turning far enough to answer a request. It does not read the lifecycle to decide
its status code, it does not call a dependency, and it does not get "improved"
by adding either — every candidate addition is a new reason to kill a process
that would have recovered on its own.

It does report `state` in the body, because "it says ok, is it going away?" is
the question an operator has when they curl it during a deploy, and answering it
costs nothing as long as the status code stays 200.

## Criticality: what a failing dependency should cost

Each check declares itself `critical` or `optional`.

| | critical | optional |
|---|---|---|
| a failure means | this replica cannot serve | something behind it is degraded |
| readiness answers | `503 NOT_READY` | `200` with `status: "degraded"` |
| the balancer | stops routing here | keeps routing here |

The test for which one a dependency is: **would routing the request to a
different, healthy replica help?**

- Postgres: yes — a replica whose pool is exhausted should hand its traffic to
  one whose pool is not. `critical`.
- Redis: no. This service uses it to carry outbound domain events, and a request
  that publishes one writes it into `outbox_messages` inside its own transaction
  and returns; the relay delivers afterwards. Every endpoint answers correctly
  with Redis unreachable. And it is the *same* Redis for every replica, so
  marking it critical fails all of their readiness probes simultaneously and
  empties the load balancer — turning "events are late" into "the API is gone".
  `optional`.

`degraded` exists because a two-valued status would have to call that case
either `ok`, hiding a real fault, or `unready`, shedding traffic for a fault
that shedding traffic cannot fix. It is 200 so the balancer keeps routing, and
it is unambiguous in the body so an alert has something to fire on.

## Registering a check

A check is a name, a criticality, and a function that resolves when the
dependency answered and throws when it did not:

```ts
registerHealthCheck({
  name: 'search',
  criticality: 'optional',
  run: async (signal) => {
    await searchClient.ping({ signal });
  },
});
```

Throwing rather than returning a status is deliberate: a driver that cannot
reach its server already throws, so a status-returning check would have two
failure channels and every implementation would have to remember to convert one
into the other.

Registration happens in **`server.ts`**, through `registerProcessHealthChecks`,
and never in `createApp()`. Same rule as the purge job, the outbox relay and the
process metrics: a check holds a connection to a real dependency, and every e2e
suite in this repository builds an app. An app built by a test therefore gets a
readiness endpoint with an empty check list, which answers `ok` — correct,
because a process that depends on nothing is ready as soon as it is listening.

The set a real process registers is one function with a test on it, because the
failure mode of forgetting to register is the one bug in a health subsystem
nobody notices: an endpoint that answers `ok` to everything, forever, with
nothing logged and nothing red.

## Deadlines

Every check runs under `HEALTH_CHECK_TIMEOUT_MS`, enforced twice.

The `signal` is the cooperative half — it is how a check that is holding a
pooled client learns to let go. It bounds nothing on its own, because a check
that never reads its signal is unaffected by it, and the checks most likely to
hang are third-party clients whose cooperation is exactly what is in question.

So `runCheck` also *races* the deadline. Without that, a dependency that accepts
a connection and then stops responding turns the readiness endpoint into a
request that never answers, which a kubelet reports as a probe timeout — the
same 503 with none of the information, and with one hung handler accumulating
per probe for as long as the fault lasts.

Checks run concurrently, so the worst case is the largest single budget rather
than the sum. Run in series, four checks at 2s each spend 8s answering a probe
configured to give up at 5, and everything after the second one is work nobody
will read.

`HEALTH_CHECK_TIMEOUT_MS` must stay comfortably below the prober's own
`timeoutSeconds`. When it does not, the prober gives up first and every
dependency incident is reported as "probe timed out" with no indication of
*which* dependency.

### Abandoning work is not cancelling it

Nothing a check talks to accepts an `AbortSignal` on the call that matters, and
a query that has reached the server cannot be withdrawn. What a check can do is
stop holding the endpoint open — and then deal with whatever it was holding when
the answer finally arrives.

`createPostgresCheck` is the worked example. `pool.connect()` abandoned
mid-flight still yields a client, and a client nobody releases is one pool slot
gone for the life of the process, per timed-out probe, during exactly the
incident in which slots are the scarce thing. So a handler attached *before* the
wait releases the late arrival, and it destroys it rather than returning it: it
was acquired for a request that no longer exists.

The same file has the other two releases. A client whose ping failed, or whose
ping outlived the deadline, is destroyed — its state on the wire is unknown, and
returning it hands the next caller a connection that may still deliver a result
it did not ask for.

## Collapsing pollers

A readiness endpoint is polled by more things than its author expects: the
kubelet, every load-balancer node, a mesh sidecar, an external uptime monitor,
and a dashboard someone left open. Each on its own interval. The naive handler
performs one `SELECT 1` per poller per interval forever — tolerable, and then
suddenly not, because during a Postgres incident every one of those probes
queues for a pool client and the health check starts consuming the capacity it
exists to report on.

Two mechanisms, covering different windows:

- **Single-flight** collapses probes that *overlap*. This is the one that
  matters during an incident, when a check takes its full budget and a dozen
  pollers arrive inside it.
- **The TTL** (`HEALTH_CACHE_TTL_MS`) collapses probes that are merely close
  together — the normal case, because a healthy `SELECT 1` returns in under a
  millisecond and therefore never overlaps anything.

The TTL is not a way to probe less often and must not be raised into one. A
cached report is stale in **both** directions: a dependency that has just failed
is still reported healthy, and one that has just recovered is still reported
down. An order of magnitude below the probe interval merges simultaneous
pollers and costs nothing; at the probe interval it silently halves the rate at
which anything is noticed. Set it to 0 to disable the cache — single-flight
still applies.

Draining is deliberately outside all of this. The lifecycle is read *before* the
cache, so the 503 is immediate: a cached `ok` from 800ms ago would keep the
instance in the pool after the signal landed, which is the one moment the answer
has to change instantly.

## What the responses look like

```jsonc
// GET /v1/health/live  →  200
{ "data": { "status": "ok", "version": "v1", "state": "draining", "uptimeSeconds": 4210 },
  "meta": null, "error": null }

// GET /v1/health/ready  →  200
{ "data": { "status": "degraded", "version": "v1", "checkedAt": "2026-09-17T09:12:41.204Z",
            "checks": [ { "name": "postgres", "criticality": "critical", "status": "ok", "durationMs": 1 },
                        { "name": "redis", "criticality": "optional", "status": "failed", "durationMs": 3 } ] },
  "meta": null, "error": null }

// GET /v1/health/ready  →  503, Retry-After: 5
{ "data": null, "meta": null,
  "error": { "code": "NOT_READY", "message": "A critical dependency is unavailable",
             "issues": [ { "name": "postgres", "criticality": "critical", "status": "failed", "durationMs": 2000 } ] } }

// GET /v1/health/ready during a drain  →  503, Retry-After: 5
{ "data": null, "meta": null,
  "error": { "code": "SERVER_DRAINING", "message": "This instance is shutting down and is no longer ready for traffic" } }
```

Every response carries `Cache-Control: no-store`. A mesh sidecar or CDN holding
a readiness answer for even a few seconds is a balancer routing to an instance
that left, or refusing one that came back. `no-store` and not `no-cache`, which
permits storing it and only requires revalidation.

**Failure reasons are withheld by default.** `HEALTH_EXPOSE_ERRORS=false` keeps
the check's error text out of the response, because a readiness endpoint is
routinely reachable from further away than the API it guards, and a `pg`
connection error names the host, port and database it could not reach. Which
check failed is in the response either way; why it failed is logged here, once
per transition.

Logging is per *transition* and not per evaluation: at these probe rates a line
per evaluation is tens of thousands a day saying the same thing, which is both
the cost of the log and the reason nobody reads it. The signature covers each
check's own status, so a second dependency failing while the first is still down
is a transition — the overall status stays `unready` either way, and that is the
more interesting half of the incident.

## Not measured, not traced

`/v1/health` and everything under it is excluded from the RED metrics
(`UNMEASURED_PATHS`) and from tracing (`UNTRACED_PATHS`). Readiness is the
highest-volume endpoint most services have, its rate swamps every panel it
appears on, and — the reason it is excluded rather than merely noisy — it
answers 503 for the whole drain window by design, so with it measured every
rolling deploy paints a 5xx spike on the error panel of a service that never
failed a request.

Both lists match a path *and its subtree*, segment-aware: `/v1/health/ready` is
excluded, `/v1/healthcheck-admin` is not.

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `HEALTH_CHECK_TIMEOUT_MS` | `2000` | Per check. Keep below the prober's `timeoutSeconds`. |
| `HEALTH_CACHE_TTL_MS` | `1000` | Report reuse. `0` disables. Keep well below the probe interval. |
| `HEALTH_EXPOSE_ERRORS` | `false` | Whether a failure reason reaches the body. |
| `HEALTH_RETRY_AFTER_SECONDS` | `5` | On both 503s. Never `0` — that reads as flapping. |

## Kubernetes

```yaml
livenessProbe:
  httpGet: { path: /v1/health/live, port: 4000 }
  periodSeconds: 10
  timeoutSeconds: 3
  failureThreshold: 3

readinessProbe:
  httpGet: { path: /v1/health/ready, port: 4000 }
  periodSeconds: 5
  timeoutSeconds: 3
  failureThreshold: 2
```

Two things to keep in agreement with this service's own settings:

- `readinessProbe.timeoutSeconds` must exceed `HEALTH_CHECK_TIMEOUT_MS`, or the
  prober gives up before the check can report which dependency failed.
- `SHUTDOWN_DRAIN_DELAY_MS` must exceed `readinessProbe.periodSeconds ×
  failureThreshold`, or the drain window ends before the balancer has observed
  the instance leaving — which is the failure the window exists to prevent. See
  [graceful shutdown](./graceful-shutdown.md).

There is no `startupProbe` here because this service has no slow start: nothing
is loaded at boot that a request would wait on. Add one before shortening
`livenessProbe.failureThreshold` on a deployment that does.
