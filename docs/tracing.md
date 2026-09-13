# Tracing: auto-instrumentation and W3C trace context

`src/observability/` is how a request becomes a trace. Almost all of it is
OpenTelemetry's auto-instrumentation, which means the interesting part of this
document is not an API — it is the three places where the automatic version is
not enough, and why.

```bash
OTEL_TRACES_EXPORTER=otlp OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 pnpm dev
```

That is the whole setup. Every inbound request, every express route, every
Postgres query, every Redis command and every outbound HTTP call is a span, and
`traceparent` is read on the way in and written on the way out. No route, service
or repository in this codebase mentions a span, and that is the point: a codebase
that starts passing a tracer around has given up what auto-instrumentation was
for.

Off by default. `OTEL_TRACES_EXPORTER=none` starts no SDK at all, because a
tracer with nowhere to send spans is not a cheap tracer — it patches every
instrumented module, builds a span per request and per query, and discards the
lot.

## Configuration

The names are OpenTelemetry's own, so a collector you have configured before
needs no new vocabulary from this service. All of them are validated by the Zod
schema in `src/config/env.ts` at boot.

| Variable | Default | What it does |
| --- | --- | --- |
| `OTEL_SDK_DISABLED` | `false` | Kill switch. Wins over `OTEL_TRACES_EXPORTER`. |
| `OTEL_SERVICE_NAME` | `boilerplate-express-ts` | `service.name`. Every backend groups and alerts on it. |
| `OTEL_SERVICE_VERSION` | *(empty)* | `service.version`. Omitted when empty rather than reported as a constant. |
| `OTEL_TRACES_EXPORTER` | `none` | `none`, `console` or `otlp`. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | *(empty)* | Collector **base** URL. Required for `otlp`. |
| `OTEL_TRACES_SAMPLER_ARG` | `1` | Fraction of traces this service *starts* that are kept. |

Two of these refuse to boot in combination, in `env.ts`: `otlp` with no endpoint.
An exporter posting to a hostless URL logs its failures and swallows them, so
tracing *appears* to be on — the SDK started, the spans exist, the config says
`otlp` — and no trace ever arrives. That is worth a failed boot.

`OTEL_EXPORTER_OTLP_ENDPOINT` accepts both the base URL the specification defines
and the full `/v1/traces` path that half the exporter documentation shows,
because the variable gets copied between config systems by people reading both.

## The three places the automatic version is not enough

### 1. The trace has to be findable from a log line

Auto-instrumentation produces a complete trace that shares no identifier with
anything in the logs, and this service's correlation id identifies a request that
appears in no trace. Both are true and neither is useful at 3am, when somebody
has one and needs the other.

`traceContextMiddleware` (in `app.ts`, between `correlationIdMiddleware` and the
request logger) closes that in three effects:

- the correlation id is recorded on the server span as `app.correlation_id`, so a
  log line finds the trace;
- the trace id goes on the access log line, so a trace finds the logs;
- the response carries `traceresponse`, so the *caller* can name the trace id to
  search for.

```
GET /v1/users 200 431 - 12.400 ms [3f9a…-corr] [4bf92f3577b34da6a3ce929d0e0e4736]
```

`traceresponse` is W3C Trace Context **Level 2**, which is still a draft. It is a
deliberate bet on a name: a response header is advisory, a client that has never
heard of it ignores it, and nothing here reads it back.

### 2. The correlation id has to reach the next service

The same middleware puts the correlation id into W3C **baggage**, which the
propagator writes onto every outbound request as the `baggage` header. Upstream
entries are merged rather than replaced — another service's baggage is its
business, and dropping it here truncates it for everything behind this one, which
is a failure that appears to originate three hops away.

Baggage reaches every downstream service and lands in their logs and spans, so
the rule is narrow: an opaque id this service generated, never a user id, an
email or a token. That is the reason the list has exactly one entry.

### 3. Store-and-forward boundaries are invisible to instrumentation

A row in `outbox_messages` read back by a different process minutes later, an
entry on a Redis stream handed to a consumer in another container, a BullMQ job —
no instrumentation can see any of those, and each one is a gap in the trace.
`src/observability/propagation.ts` is the W3C layer for them, as values rather
than headers:

```ts
import { injectTraceContext, withTraceContext } from '@/observability';

// Producer: alongside the message, in whatever the transport can already store.
const trace = injectTraceContext(); // { traceparent, tracestate?, baggage? }

// Consumer: everything the handler does lands in the producer's trace.
withTraceContext(trace, () => handle(message));
```

Nothing here invents a header name or an encoding — the strings are the same
`traceparent`, `tracestate` and `baggage` that go over the wire, which is what
lets a consumer written in another language read them.

Two behaviours are worth knowing because they look like bugs and are not:

- **An empty carrier is a correct answer.** `injectTraceContext` writes nothing
  when there is no valid span — tracing off, or a startup path. The alternative a
  naive implementation produces is a well-formed `traceparent` with a zeroed
  trace id, which backends reject without explaining why.
- **`extractTraceContext` ignores whatever span is currently active.** A consumer
  is always inside something — a poll loop, a relay tick, a job runner. Rooting
  the extraction means a carrier with no `traceparent` starts a new trace instead
  of quietly hanging off the poll that happened to pick the message up. If that
  edge is worth recording it is a *link*, not a parent.

**Not wired up yet.** The helpers exist and are tested; the outbox and the stream
envelope do not carry a `traceparent` field, because adding one is a schema change
to `outbox_messages` and a wire-format change to the stream envelope. That is its
own change, and this document will be wrong about it the day it lands.

## Sampling, and why it is parent-based

`ParentBasedSampler` wrapping `TraceIdRatioBasedSampler`, and the nesting is the
entire point. A ratio sampler asked at every hop **multiplies**: four services at
0.1 each keep one trace in ten thousand whole, and the survivors are chosen
independently of whether anything went wrong. Worse, the traces that do not
survive are not absent — they are present in fragments, one service at a time,
which is how a trace comes to show a 900ms gap with nothing in it.

So the `sampled` flag on an inbound `traceparent` is honoured unchanged, and the
ratio applies only to a span that *starts* here: a request that arrived with no
trace context, or work started on a timer.

## What is deliberately not instrumented

| Instrumentation | Why off |
| --- | --- |
| `fs` | Every `require` and every file read becomes a span — thousands per request, and the request's own span is buried in a trace no UI can render. |
| `dns`, `net` | Under a connection pool they describe the pool rather than the request, and the `http` and `pg` spans already carry the peer. |
| `GET /v1/health` | The highest-volume endpoint most services have, at one span apiece saying 200. Dropped at `ignoreIncomingRequestHook`, before a span is built at all — not at the sampler, which would still pay for it. |

The propagator list is pinned in code rather than left to `OTEL_PROPAGATORS`.
The composite — `tracecontext` plus `baggage` — is also the SDK's default, so the
line looks redundant; what it buys is that the wire format is no longer an
environment variable. A deployment cannot be switched to B3 by a value in a
config map, and it cannot lose `baggage` by setting `OTEL_PROPAGATORS` to
`tracecontext` without realising the variable replaces the whole list rather than
adding to it. Either change breaks correlation with every other service in the
mesh while this one keeps producing perfectly valid traces of its own.

## The ordering rule, which is the one way to break this

```ts
// src/server.ts — first, and it has to stay first
import { tracing } from '@/observability/register';
import { createApp } from '@/app';
```

Every instrumentation works by replacing exported functions on a module —
`http.request`, `express.Router`, `pg.Client.prototype.query` — when that module
is loaded, through a hook on `require`. **A module already in the cache is never
offered to the hook.** An SDK started after `import express from 'express'`
patches nothing, reports no error, and produces no spans.

That is why the bootstrap is a separate module rather than a `startTracing()` call
at the top of `server.ts`: ES import declarations are hoisted above every
statement in the file, so only an import can run before the other imports. The
same line is first in `scripts/stream-worker.ts` and `scripts/queue-worker.ts`.

`@/observability` — the barrel — deliberately does **not** re-export
`register.ts`, because that would let any import of the barrel bootstrap tracing
from wherever it happened to sit.

## Shutdown

The tracing task is last in the `resources` phase of the graceful shutdown
sequence, and unconditional — the handle is a no-op when tracing is off.

Last, because every task above it can still be producing spans; the pool's own
teardown is instrumented, and a trace that ends at "began closing the pool" is
missing the part a slow shutdown is being investigated for. Awaited, because a
`BatchSpanProcessor` holds finished spans for up to its scheduled delay, and a
process that exits without flushing loses the spans of the last requests it
served — which, during a bad deploy, are the only ones anybody wants.

## Tests

Three suites in-process and one out of it, and the split is forced rather than
chosen.

`propagation.test.ts`, `tracing.test.ts` and `trace.middleware.test.ts` cover the
decisions against real propagators and a real tracer: that a sampled parent is
honoured at ratio 0 and an unsampled one at ratio 1, that a malformed or zeroed
`traceparent` produces a new trace rather than an invalid one, that `tracestate`
survives a hop, that the middleware's three effects happen.

`tracing.integration.test.ts` covers the SDK itself, and it cannot be done in
jest: the instrumentations patch through a hook on `require`, and jest resolves
modules through its own registry, which the hook never sees. So `tracing.fixture.ts`
runs under `tsx` as its own process and the jest process plays the **upstream** —
which is the part that makes it honest. The first version of that fixture called
itself, and its own client instrumentation rewrote the `traceparent` before it
reached the server: a valid header arrived, a server span was its child, every
assertion passed, and the extraction under test had never run.

Every assertion is made on headers observed on the wire rather than on an
exporter. An exporter reports what the process believes; a `traceparent` arriving
at a second server is what it actually sent. One trace id, written by an
uninstrumented caller, reappearing in the request the handler makes after an
`await` is the only evidence that extraction, context propagation across an
asynchronous boundary, and injection all worked — three mechanisms, one
observation, none of them fakeable.

No collector, no database, a few seconds.
