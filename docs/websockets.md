# WebSockets

`ws://…/v1/ws` — an authenticated, rate-limited, heartbeat-managed socket
served off the same HTTP server as the REST API.

The transport is the deliverable here. The message protocol underneath it
(`src/ws/ws.protocol.ts`) is deliberately three frames long, because everything
that makes a socket safe to expose is identical whether the frames carry chat
messages or telemetry.

## Why a socket needs work a route does not

An HTTP request is bounded by construction. It arrives, it is answered, its
memory is released, and the next one re-presents its credential. A WebSocket is
the opposite on every one of those counts, so each property has to be
re-established by hand:

| Property | Free on a route because… | Re-established here by |
| --- | --- | --- |
| Inbound rate | The client waits for a response before sending again | Two token buckets per connection |
| Inbound size | `express.json({ limit })` refuses a large body | `maxPayload` at reassembly time |
| Backpressure | The response ends | A ceiling on `bufferedAmount` |
| Liveness | The request ends | Ping/pong, and terminate on silence |
| Credential lifetime | Every request re-checks the token | A close scheduled at the token's `exp` |
| Shutdown | Open requests finish in milliseconds | An explicit 1001 to every socket |

Missing any one of them produces a service that works perfectly in development
and fails in a way that is hard to attribute in production. The credential row
is the one most often missed: a fifteen-minute access token that authorises a
connection lasting a week is not a short-lived credential.

## Connecting

### From a browser

The browser `WebSocket` constructor takes a URL and a subprotocol list and
nothing else — there is no headers argument, so `Authorization: Bearer` is not
reachable. The token goes in the subprotocol list instead, after a sentinel:

```ts
const socket = new WebSocket('wss://api.example.com/v1/ws', [
  'bearer.auth.v1',
  accessToken,
]);
```

The server selects and echoes `bearer.auth.v1`, never the token.

The two things people do instead are both worse:

- **`?token=…` in the URL.** A bearer credential written into every access log,
  proxy log and APM trace on the path, and into `Referer` on any navigation.
  `readHandshakeToken` has a test asserting it does *not* read the query string,
  so adding it back means deleting that test on purpose.
- **A cookie.** A WebSocket handshake is not subject to the same-origin policy
  and CORS does not apply to it, so any page on the internet can open an
  authenticated socket to this service in a logged-in user's browser. That is
  cross-site WebSocket hijacking, and cookie auth is what enables it.

`WS_ALLOWED_ORIGINS` checks the `Origin` header as defence in depth. With bearer
auth the hijacking attack already fails — an attacker's page cannot read the
token out of your origin — so this is a second line, not the first. Requests
with no `Origin` are allowed: only browsers send it, and only browsers can be
made to mount the attack.

### From a service

```ts
import WebSocket from 'ws';

const socket = new WebSocket('wss://api.example.com/v1/ws', {
  headers: { authorization: `Bearer ${accessToken}` },
});
```

### Refusals

The handshake is refused *before* the 101, with an ordinary HTTP response
carrying the same JSON envelope as every REST route:

```
HTTP/1.1 401 Unauthorized
Content-Type: application/json; charset=utf-8

{"data":null,"meta":null,"error":{"code":"UNAUTHORIZED","message":"Missing access token. …"}}
```

| Status | Code | Cause |
| --- | --- | --- |
| 401 | `UNAUTHORIZED` | No token in either header |
| 401 | `TOKEN_INVALID` | Bad signature, expired, or a refresh token |
| 403 | `ORIGIN_NOT_ALLOWED` | Browser origin outside `WS_ALLOWED_ORIGINS` |
| 404 | `NOT_FOUND` | An upgrade to a path this server does not serve |
| 503 | `WS_CAPACITY_EXHAUSTED` | `WS_MAX_CONNECTIONS` reached |
| 503 | `SERVER_SHUTTING_DOWN` | The process is draining |

This is why `ws.server.ts` uses `noServer: true` and owns the `upgrade` event
itself. Letting `ws` own it means rejecting through `verifyClient`, which can
refuse a connection but cannot say anything a client can read — the reason `ws`
deprecated the option.

## Close codes

A client's reconnect logic should branch on the code. Treating every close the
same reconnects into the same refusal forever.

| Code | Meaning | What the client should do |
| --- | --- | --- |
| 1000 | Normal | Nothing |
| 1001 | Server going away (deploy) | Reconnect after a short backoff |
| 1008 | Policy violation (e.g. a binary frame) | Fix the client; do not retry |
| 1009 | Frame above `WS_MAX_PAYLOAD_BYTES` | Send smaller frames |
| 1011 | Server-side bug | Reconnect after a backoff |
| 4001 | Access token expired | **Refresh the token, then reconnect** |
| 4002 | No pong within the heartbeat interval | Reconnect |
| 4008 | Rate limit exceeded | Reconnect and send more slowly |
| 4009 | Slow consumer: outbound buffer exceeded | Reconnect; read faster |

4001 is the one worth handling specially: retrying with the same credential is
refused at the handshake, which is a slower loop with the same outcome.

Close reasons are truncated to 123 bytes (`truncateCloseReason`). RFC 6455 caps
a control frame payload at 125 bytes, two of which are the code, and `ws`
*throws* on an over-long reason — so a reason built by interpolating client
input would turn a policy close into an uncaught exception.

## Rate limiting

Two token buckets per connection, both charged for every inbound frame:

- **Messages** — `WS_RATE_LIMIT_BURST` in a burst, `WS_RATE_LIMIT_MESSAGES_PER_SECOND`
  sustained.
- **Bytes** — `WS_RATE_LIMIT_BYTES_PER_SECOND` sustained, with a burst of
  `burst × maxMessageBytes` so a full burst of maximum-size frames is admitted
  by construction.

A token bucket rather than the fixed window the REST routes use, for two
reasons. A fixed window admits twice its limit across a boundary, and on a
request/response API that burst is absorbed by the client waiting for the
responses — on a socket there is nothing to wait for, so the burst *is* the
attack. And the second dimension exists because message count does not bound
work: ten 64 KB messages a second is inside any message budget and is 640 KB/s
of parsing.

Exceeding either budget closes the connection with 4008 rather than dropping the
frame. Dropping silently would leave a client believing a message was delivered.

`WS_MAX_PAYLOAD_BYTES` is enforced by `ws` during reassembly and is the only
real bound on inbound memory — an application-level size check runs after the
whole frame has already been buffered, so it can complain about a 500 MB message
but not prevent one.

## Protocol

Every frame is JSON text; binary frames are refused with 1008. A malformed frame
gets an error frame back rather than a close: closing over one bad message throws
away every subscription on the socket and sends the client into a reconnect loop
it cannot debug. The closes in `WS_CLOSE` are for conditions that describe the
*connection*.

Replies echo the client's `id`. Nothing about a socket guarantees the next frame
you receive answers the last one you sent — that is the property request/response
gives you for free, and the one most often assumed to still hold.

```jsonc
// → {"type":"ping","id":"1"}
// ← {"type":"pong","id":"1"}

// → {"type":"echo","id":"2","payload":{"any":"json"}}
// ← {"type":"echo","id":"2","payload":{"any":"json"}}

// → {"type":"whoami","id":"3"}
// ← {"type":"whoami","id":"3","userId":"1","roles":["admin"]}

// → not json
// ← {"type":"error","code":"MALFORMED_FRAME","message":"Frame is not valid JSON"}
```

Replace `handleClientFrame` with your own protocol; keep the validation and the
correlation id.

## Operating it

**Behind a proxy.** nginx needs `proxy_http_version 1.1` plus the `Upgrade` and
`Connection` headers forwarded, and a `proxy_read_timeout` above
`WS_HEARTBEAT_INTERVAL_MS`. An ALB's idle timeout (60s by default) is the same
constraint. The heartbeat's job is to keep the connection carrying bytes so no
intermediary decides it is idle — and, on the other side, to discover a peer
that vanished without a FIN, which a socket nobody writes to never notices.

**Compression is off.** `perMessageDeflate` allocates a zlib context per
connection — hundreds of kilobytes each, far more than the socket itself — so
enabling it turns a connection flood into memory exhaustion. Worth turning on
for a small number of connections carrying large repetitive payloads, and
nothing else.

**Scaling out.** Nothing here is shared between replicas: the rate limits, the
connection ceiling and any fan-out are per-process. A client reconnecting lands
on a different instance, so anything a socket subscribes to has to be reachable
from every instance — which is what the outbox and the domain event bus are for.
Sticky sessions are not a substitute; they fail exactly when an instance
restarts.

**Shutdown.** `server.ts` closes every socket with 1001 before `server.close()`.
Without it a graceful stop waits on connections that never end, and resolves
when the orchestrator gives up and sends `SIGKILL` — taking every in-flight REST
request with it.

**Attachment owns the upgrade event.** `attachWebSocketServer` answers every
upgrade the HTTP server receives, refusing unserved paths with 404. Returning
without touching the socket would leak it: Node only destroys an unhandled
upgrade when the server has *no* listener at all. A deployment with two
WebSocket paths attaches once and branches inside.

## Configuration

| Variable | Default | Notes |
| --- | --- | --- |
| `WS_ENABLED` | `true` | `false` leaves the endpoint out entirely |
| `WS_PATH` | `/v1/ws` | |
| `WS_MAX_CONNECTIONS` | `1000` | Per process |
| `WS_MAX_PAYLOAD_BYTES` | `65536` | The only bound on inbound memory |
| `WS_RATE_LIMIT_BURST` | `20` | |
| `WS_RATE_LIMIT_MESSAGES_PER_SECOND` | `10` | |
| `WS_RATE_LIMIT_BYTES_PER_SECOND` | `131072` | |
| `WS_HEARTBEAT_INTERVAL_MS` | `30000` | Must sit below every idle timeout on the path |
| `WS_MAX_BUFFERED_BYTES` | `1048576` | Slow-consumer ceiling |
| `WS_ALLOWED_ORIGINS` | `CORS_ORIGIN` | Comma-separated, or `*` |

## Testing

`src/ws/*.test.ts` drive the rules through a fake socket, which is the only way
to stage a peer that stops reading or never answers a ping.
`src/tests/e2e/websocket.e2e.test.ts` drives a real one, because whether a
refusal is a readable HTTP response and whether a close code survives the wire
are not things a fake can answer.
