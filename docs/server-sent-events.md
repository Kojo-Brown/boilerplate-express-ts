# Server-Sent Events

`GET /v1/events/stream` delivers the domain event bus to a client as it happens,
over one long-lived HTTP response. This document is about the three things that
decide whether such a response is still working in an hour: the heartbeat, the
`Last-Event-ID` resume, and what happens to a client that stops reading.

## The shape

```
src/sse/
  frame.ts           the text/event-stream wire format — strings in, strings out
  event-log.ts       the bounded replay history and the id scheme addressing it
  connection.ts      one open Response: headers, heartbeat, backpressure, cleanup
  hub.ts             fan-out, plus the resume handshake
  domain-feed.ts     domainEventBus → hub
  last-event-id.ts   where the client's cursor comes in
  sse.controller.ts  capacity, then take over the response
  sse.router.ts      GET /stream, behind requireAuth + requireRole('admin')
```

Only `connection.ts` holds a `Response`. That split is what lets the fan-out of
one event to two hundred sockets, the replay-window arithmetic, and every
encoding edge case be tested without a socket — and it is why `frame.test.ts`
can be exhaustive over the format rather than representative.

## Using it

```bash
curl -N -H "Authorization: Bearer $TOKEN" localhost:4000/v1/events/stream
```

`-N` matters: without it curl buffers and you learn nothing.

```
retry: 3000

event: stream.open
data: {"streamId":"9f3c…","resume":"live","replayed":0}

id: 9f3c…:1
event: user.created
data: {"id":"018f…","occurredAt":"2026-08-31T09:12:44.108Z","correlationId":"…","payload":{…}}

: heartbeat 2026-08-31T09:12:59.108Z
```

From a browser you need a `fetch`-based client, not `EventSource` — see
[Why not `EventSource`](#why-not-eventsource).

```ts
const response = await fetch('/v1/events/stream', {
  headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' },
  signal: controller.signal,
});

for await (const frame of parseEventStream(response.body!)) {
  if (frame.event === 'stream.open' && JSON.parse(frame.data).resume === 'reset') {
    await refetchEverything();       // the cursor could not be honoured
  }
  if (frame.id) localStorage.setItem('cursor', frame.id);
}
```

Reconnecting is the client's job here, and the cursor goes back either as the
`Last-Event-ID` header or as `?lastEventId=`.

## `stream.open`, and why a reset is not an error

Every stream opens with one control event before anything else:

| `resume`   | Meaning                                            | Client action        |
| ---------- | -------------------------------------------------- | -------------------- |
| `live`     | Nothing was missed (a first connection, or caught up) | Nothing              |
| `replayed` | The gap was sent; `replayed` says how many          | Nothing              |
| `reset`    | The cursor could not be honoured; `reason` says why | Re-read state, then trust the stream again |

Without it, "your resume worked" and "your resume was refused" are the same
observation — a connection that opens and then goes quiet — and the difference
between them is whether the client is looking at a complete view or one missing
an unknown number of events.

A `reset` is answered on an open stream rather than with a 4xx on purpose. The
request is fine; the only thing wrong is the assumption that the client's view
is still incrementally reachable. Refusing the request would take away the
stream the client needs in order to recover.

`stream.open` carries **no `id`**. A control frame names no position in the
replay log, so advancing the client's cursor onto one would make the next
reconnect resume from an id the log cannot place — a reset the client did not
need.

## The id scheme

Event ids are `<streamId>:<sequence>`, where `streamId` is 8 random bytes minted
when the process starts.

The sequence alone is the obvious design and it is unsafe across a restart. The
counter begins at 1 again, so a client reconnecting with `47` after a deploy asks
to resume from an event that exists, is not the event it saw, and sits in the
middle of the new run's history. The server would replay 48 onwards and both
sides would believe the resume had worked. With a per-run prefix that cursor
cannot match, and the reconnect is answered `reset` — which is exactly what a
client's re-sync path is for. The same reasoning covers a reconnect that lands on
a different replica behind a load balancer: the log is per-process, so a cursor
from a peer is a stranger, and saying so is better than guessing.

`reason` distinguishes three ways a cursor fails:

- `expired` — real, and too old. The events after it have been evicted from a
  buffer that is deliberately finite (`SSE_REPLAY_BUFFER_SIZE`, default 256).
- `unknown-stream` — from a different run or a different replica, as above.
- `malformed` — not a shape this server ever issued.

## Heartbeat

An idle stream is written a comment line every `SSE_HEARTBEAT_INTERVAL_MS`
(default 15s). A comment dispatches nothing at the client and needs no support
from it.

Two different things go wrong without it, and neither announces itself:

1. **Intermediaries close idle connections.** nginx's `proxy_read_timeout` and
   an ALB's idle timeout are both 60s by default. The symptom is an endless
   open/timeout/reopen cycle that looks like working software from the outside.
2. **A peer can vanish without a FIN** — a closed laptop, a NAT rebind. The
   socket stays `open` to this process indefinitely, holding its subscription
   and its slot against `SSE_MAX_CONNECTIONS`, because a socket nobody writes to
   never discovers it is dead. The heartbeat is the write that eventually fails.

The interval must sit comfortably *below* the shortest idle timeout on the path,
since the budget is consumed by the gap between heartbeats and a tick can be late
under load.

## Backpressure: why a slow client is dropped

`res.write()` to a peer that has stopped reading does not block and does not
fail. It buffers, in this process, without limit. One subscriber that has stopped
consuming therefore accumulates every event the service publishes, and the
incident lands as an allocation failure somewhere unrelated.

So the connection tracks `res.writableLength` after each write and destroys the
socket once it passes `SSE_MAX_BUFFERED_BYTES` (default 1 MiB), reporting
`slow-consumer`.

Note what is *not* the trigger: `write()` returning `false` means "above the
high-water mark", which is the ordinary state of a socket mid-burst. The signal
is the buffer staying above a much larger bound.

Dropping the reader is the right answer here in a way it would not be for a
request/response route, and the reason is `Last-Event-ID`: this connection is
resumable. A client dropped at the ceiling reconnects and is replayed exactly
what it missed — unless it was so far behind that the log evicted it, in which
case it is told to re-sync, which is the honest outcome for a client that could
not keep up.

`destroy()` and not `end()`, because a FIN would queue behind the backlog that is
the problem.

## Headers, and the ones that are not decoration

| Header                                    | Why                                                                                                                                 |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `Content-Type: text/event-stream; charset=utf-8` | The format is UTF-8 by definition.                                                                                            |
| `Cache-Control: no-cache, no-transform`   | `no-transform` is the load-bearing half: a compressing intermediary may buffer a body in order to compress it, and a buffered event stream delivers nothing until it ends — which for this response is never. |
| `X-Accel-Buffering: no`                   | nginx-specific, harmless elsewhere. nginx buffers proxied responses by default, and the resulting symptom — events in 4 KB bursts, or nothing — is invariably debugged against the application first. |

Two socket settings go with them: `setTimeout(0)`, because Node's own idle
timeout would end a response that is behaving exactly as designed, and
`setNoDelay(true)`, because Nagle would hold a 40-byte heartbeat for up to 40ms
waiting for company that is not coming.

**Do not put `compression()` in front of this route.** It is the in-process
version of the `no-transform` problem, and no header prevents it.

## The wire format has no escape

`text/event-stream` delimits a field value by the line break that ends it and by
nothing else. A newline reaching `id` or `event` does not corrupt a field — it
*ends the field and starts another*:

```
id: 1
event: admin.granted
data: {"role":"admin"}
```

is not one corrupt frame, it is a perfectly valid one the server never meant to
send. `encodeFrame` therefore rejects a line break in `id` or `event` outright,
and rejects U+0000 as well: a client *ignores* an id containing NUL, so the
effect is a frame delivered with the cursor silently not advancing.

`data` is different — a line break there is legal and expressible, as several
`data:` lines the client rejoins with `\n` — so it is normalised rather than
rejected. What the format cannot express is *which* terminator was used, and the
client's parser treats CRLF, CR and LF identically. Normalising makes the string
the encoder is given equal to the string the client observes.

Everything published through the hub is JSON, which escapes the control
characters the format cannot carry.

## Why not `EventSource`

The route is behind `requireAuth` + `requireRole('admin')`, so a browser cannot
open it with `new EventSource(url)`: the constructor takes a URL and a
`withCredentials` flag, and there is no way to set a request header.

The alternative would be accepting `?access_token=`, which would also write a
live credential into every access log, proxy log, and `Referer` on the path. The
`fetch` client above is the trade taken instead.

`Last-Event-ID` still has two entry points because of a related gap. The header
is what `EventSource` (or a client emulating it) maintains automatically across a
dropped connection. A **page reload** has no such history — the new client starts
empty — so a cursor persisted across the reload can only come back in the query
string. The header wins when both are present: it is what was actually
dispatched, where the parameter is whatever the page last got round to saving.

## Access

Admin-only, and the reason is the payloads rather than the mechanism. The stream
carries `user.created` with the address that was registered and `user.updated`
with which fields moved — the audit log delivered live. A stream anybody could
open would be a subscription to everyone else's activity.

## What this is not

The feed is a subscriber on the in-process `domainEventBus`, which is
at-most-once and single-process. Three consequences, stated plainly:

- An event published while the **process** is down is gone. The replay log does
  not survive a restart, which is why every reconnect after one is answered
  `reset`.
- An event published on **another replica** never reaches this one's log.
- The buffer is finite, so a client offline for more than
  `SSE_REPLAY_BUFFER_SIZE` events is told to re-read rather than handed a partial
  history that would look complete.

The stream is therefore a way to know *when* to read, not a substitute for
reading. A client that needs a complete history reads the REST API and uses the
stream to learn when to read it again. Anything needing delivery guarantees
across processes wants the [outbox](./outbox.md) and a broker, not a bigger
buffer.

## Shutdown

`server.close()` waits for open connections, and this is the first route whose
connections never end on their own — left alone it turns a graceful stop into a
hang that resolves when the orchestrator sends `SIGKILL`, taking every in-flight
request with it. `server.ts` therefore closes the hub *before* calling
`server.close()`, so the wait has a finite set to wait for. Clients reconnect on
their own and land on the new instance.

## Configuration

| Variable                    | Default   | What it decides                                              |
| --------------------------- | --------- | ------------------------------------------------------------ |
| `SSE_HEARTBEAT_INTERVAL_MS` | `15000`   | Comment interval on an idle stream. Below every idle timeout on the path. |
| `SSE_RETRY_MS`              | `3000`    | Reconnect delay advertised to clients — what a rolling restart's herd is spread over. |
| `SSE_REPLAY_BUFFER_SIZE`    | `256`     | Events kept resumable. A count, because what it bounds is memory. |
| `SSE_MAX_CONNECTIONS`       | `1000`    | Concurrent streams. Nothing else bounds them.                |
| `SSE_MAX_BUFFERED_BYTES`    | `1048576` | Per-stream ceiling before a slow consumer is dropped.        |
| `SSE_RETRY_AFTER_SECONDS`   | `5`       | `Retry-After` on the 503 at the connection ceiling.          |
