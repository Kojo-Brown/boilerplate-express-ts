# Webhook request signing (HMAC)

A webhook endpoint is an unauthenticated write. There is no session, no bearer
token and no user; there is a URL somebody else knows and a body they chose.
Everything after that is trust you either established or assumed.

Signing establishes it. The sender computes an HMAC over the request under a
shared secret and puts it in a header; the receiver recomputes it and compares.
That gives two properties and — this is the part worth being precise about —
only two: the body came from a holder of the secret, and the body has not been
altered in transit. It does not say the request is recent, and it does not say
it is the first time you have seen it.

Those two gaps are what the rest of this document is about, because they are
where real receivers get compromised.

Implemented in `src/webhooks/`, mounted at `POST /v1/webhooks/inbound`.

## The scheme

One header:

```
X-Webhook-Signature: t=1760000000,n=9f8c…,kid=k1,v1=4a2b…
```

| field | meaning |
| ----- | ------- |
| `t`   | unix seconds at signing time |
| `n`   | nonce, single-use, 16–64 chars of `[A-Za-z0-9_.-]` |
| `kid` | which secret in the ring signed this |
| `v1`  | HMAC-SHA256 of the canonical string, lowercase hex |

Unknown fields are ignored, so a later `v2` can be rolled out to senders before
receivers understand it. A *repeated* field is refused rather than resolved:
"last one wins" over a signature field is how header smuggling gets in, because
the proxy, the sender's library and the receiver's parser are each entitled to a
different answer about which value counted.

The signed string is six newline-separated lines:

```
v1
1760000000
9f8c…
POST
/v1/webhooks/inbound?source=billing
<sha256 of the raw body, hex>
```

Every field's alphabet excludes the separator, and the body is hashed rather
than embedded. That is what makes the encoding unambiguous, which is not a
stylistic preference: a canonicalisation in which two different requests can
produce one signed string is a canonicalisation where a signature transfers
between them, and every field-splitting attack on a signing scheme is that bug.
A body of `"\n<nonce>\nPOST\n/v1/webhooks/elsewhere\n"` is the attack; hashing
the body to 64 hex characters is the answer.

Three decisions inside that string are worth defending individually.

**The version is signed, not merely sent.** A version that appears only in the
header is a version an attacker can rewrite — present a `v1` digest as `v2` once
`v2` exists and means something laxer, and the receiver validates it under the
wrong rules.

**The timestamp is signed.** The receiver refuses on it *before* checking the
digest, which is only safe because forging it changes the canonical string and
therefore fails the digest check anyway. An unsigned timestamp checked first
would be acting on an attacker-chosen value.

**The method and target are signed.** Without them, a receiver with two webhook
routes under one secret has two endpoints that accept each other's traffic:
capture a delivery meant for `/notes`, present it at `/refunds`, and it verifies.
This is the field with a real operational cost, and it is the first thing to
check when every delivery suddenly fails — see *When everything fails* below.

## Freshness and replay are two mechanisms, not one

A signature says nothing about time. Without a window, one captured delivery
stays replayable until the secret is rotated, which may be never. So the
receiver refuses a timestamp more than `WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS`
from its own clock, in either direction — symmetric, because clock skew is
symmetric, and a one-sided window turns a sender running two minutes fast into
an outage.

That reduces an indefinite window to five minutes. It cannot reduce it to zero,
and those five minutes are not a rounding error: they are a window in which
someone positioned to capture one delivery can present it again as often as they
like, and every copy verifies, because every copy *is* authentic. For a webhook
that moves money or revokes access, "the same instruction, one hundred times,
inside five minutes" is the whole attack.

So the sender includes a single-use nonce and the receiver refuses one it has
already seen. The two mechanisms are exactly complementary, and the shape of the
complement is what bounds the cache: **a nonce only has to be remembered until
its timestamp leaves the window**, because after that the freshness check refuses
the delivery regardless. Retention is therefore the tolerance rather than a
number anyone has to choose, and the cache is bounded by (delivery rate ×
tolerance) rather than by history. At the defaults, 100,000 records covers a
sustained 333 deliveries per second.

Two things follow that are easy to get wrong.

**The nonce is recorded only after the digest verifies.** A guard consulted
earlier lets anybody at all spend nonces: capture a delivery, hold it, present a
*tampered* copy, and the legitimate copy arrives second and is refused as a
replay — a denial of service needing no secret.

**At the cache bound the endpoint answers 503, not 200.** A bounded cache that
is full has two options and no third: forget replay protection for this request,
or refuse it. Forgetting is silent — the endpoint keeps answering 200 and the
guarantee is simply gone — so this fails closed. The trade is real and worth
stating: an attacker who can flood the endpoint with distinct nonces can push it
into 503, which is a denial of service on a path they could already flood. What
they cannot do is flood it into *accepting replays*. Put a rate limiter in front
and size the cache from the arithmetic above.

## Replay protection is not idempotency

These get conflated, and conflating them fails in both directions.

Replay protection asks *has this credential been presented before*, keyed on the
nonce, which is unique per **attempt**. Idempotency asks *has this event been
processed before*, keyed on the sender's event id, which is stable across
**redeliveries**. Two honest attempts at delivering one event carry two nonces
and both verify — correctly, because both are genuine requests from the secret
holder.

Key replay protection on the event id and a receiver accepts a captured
credential whenever the event is new. Key deduplication on the nonce and it
rejects every honest retry. This module does the first job only; `@/idempotency`
does the second, keyed on the event id the sender puts in the body.

That is also why `POST /v1/webhooks/inbound` answers **202** and does no work
inline. A sender's retry ladder reads the status code and nothing else, so the
status has to mean "received, stop retrying" — knowable now — rather than
"processed", which is not. Record the delivery durably, hand it to the outbox or
the queue, and let the idempotency layer collapse the redeliveries.

## Verify, then parse

The body arrives as a `Buffer` and stays one until the signature is established.
This is load-bearing in two ways:

- a signature is over **bytes**, and `JSON.parse` followed by `JSON.stringify`
  is not the identity function. Key order, whitespace, duplicate keys and number
  formatting all move, so a verifier working from the parsed object computes a
  digest over a body nobody sent — and it fails only for the senders whose
  serialiser differs from V8's, which is the worst possible distribution of a
  bug;
- nothing untrusted reaches the JSON parser before it has been authenticated.

Arranging this cannot be done from inside the router. By the time a request
reaches anything mounted under `/v1`, `createApp` has already run
`express.json()` and the bytes are gone. So `express.raw()` is mounted on
`WEBHOOKS_RAW_BODY_PATH` ahead of the body parsers, and `express.json()` skips
those requests because body-parser's own `_body` marker is already set — which is
what makes this cooperative rather than a conflict. Every other route is
untouched: no global raw-body capture, and no retained copy of every JSON body
in the service for a verifier that will never look at it.

`WEBHOOK_MAX_BODY_BYTES` is 1 MB, lower than a general-purpose limit would be,
because the body must be buffered in full before anything about the caller is
known. That limit is the only thing between an unauthenticated request and that
much heap per connection.

## Rotating a secret

Three deployments, and the ring exists to express the middle one:

1. Add the new secret to `WEBHOOK_SIGNING_SECRETS` everywhere. Verification now
   accepts both; signing has not moved; nothing observable changes.
2. Point `WEBHOOK_SIGNING_ACTIVE_KEY_ID` at it. New signatures use the new
   secret; anything still arriving under the old id still verifies.
3. Remove the old secret — once no counterparty is still signing under it, which
   is a fact about *their* deployment and not yours.

Verification consults the whole ring; signing consults exactly one entry. That
asymmetry is the design. A verifier narrowed to the active key would defeat
step 1 entirely.

Secrets are 32–64 bytes. The floor is the digest size — a secret shorter than the
digest it produces is the weakest link. The ceiling is HMAC-SHA256's block size,
past which the construction hashes the key down to 32 bytes: a 128-byte secret
carries exactly the strength of its SHA-256 digest while looking to whoever
pasted it like twice the security, and two distinct over-long secrets can even
collide into one effective key. Both bounds, the base64, duplicate ids and an
active id the ring does not hold are all checked at boot by `@/config/env`, and
no message ever names secret bytes — a config error is exactly when somebody is
pasting secrets around, and error strings are where secrets escape a process.

## What this deployment cannot do yet

`MemoryReplayGuard` is per process. Behind more than one replica a captured
delivery gets one chance **per replica**: each instance refuses the copy it has
seen and accepts the copy its neighbour saw. That is a fraction of the
protection, not none, and it is not the protection the feature claims.

Replay protection has to live where deliveries are serialised, which for a
horizontally scaled receiver means a shared store — `SET <key> 1 NX PX <ttl>`
against Redis is the entire implementation, and `ReplayGuard` is the seam it
plugs into. The Redis module here is a Streams client with no key-value port, so
that adapter is a change to `@/redis` rather than a class in this module. Until
it exists: a deployment that scales this endpoint past one replica has a gap, and
the freshness window is what bounds it.

The scheme also covers method, target and body — not other headers. Covering
headers properly means a signed header list, which is what RFC 9421 specifies and
which is a different and larger feature; covering them informally means every
proxy that adds, reorders or rewrites a header breaks every delivery.

## Sending a signed request

```ts
import { signWebhookRequest } from '@/webhooks';

const body = JSON.stringify({ id: event.id, kind: event.name });
const signed = signWebhookRequest({ ring, url: 'https://partner.example/hooks', body });

await fetch('https://partner.example/hooks', {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...signed.headers },
  body,
});
```

The sender lives in the same module as the verifier deliberately. The usual way a
signing scheme turns out to be ambiguous is that its only implementation is a
test helper — which means the scheme was demonstrated rather than specified. Here
the delivery path, the test suites and this document all point at one function,
and the verifier rebuilds its input with the same `canonicalRequest`.

`signWebhookRequest` returns headers rather than performing the request, because
what sends a webhook — the outbox relay, a queue worker, a bare `fetch` — already
holds opinions about timeouts, retries and connection reuse that signing has no
business holding. It is a pure function of (secret, method, target, body, clock),
which is also the only way a byte-exact header can be asserted in a test.

## Refusals

| status | code | meaning |
| ------ | ---- | ------- |
| 401 | `WEBHOOK_SIGNATURE_REQUIRED` | no signature header |
| 400 | `WEBHOOK_SIGNATURE_MALFORMED` | header present, unreadable |
| 400 | `WEBHOOK_TIMESTAMP_OUT_OF_WINDOW` | outside the tolerance; names the skew |
| 401 | `WEBHOOK_SIGNATURE_INVALID` | wrong digest, **or** a key id not held |
| 409 | `WEBHOOK_REPLAYED` | nonce already spent; retry with a fresh one |
| 503 | `WEBHOOK_REPLAY_CACHE_FULL` | refused rather than accepted unprotected |
| 400 | `WEBHOOK_BODY_MALFORMED` | verified, and not the JSON it claims to be |

The status codes are chosen for the sender's retry ladder rather than for
tidiness. A malformed header is 400 and not 401 because nothing was *rejected* —
nothing was parseable enough to check — and an integrator debugging their own
serialiser is helped by the difference. A stale timestamp is 400 for the same
reason plus one more: the credential may have been perfectly valid, and a 401
would send them looking at their secret instead of at their clock.

Only `WEBHOOK_SIGNATURE_INVALID` is deliberately vague, and only about one thing:
a digest mismatch and an unheld key id answer identically, so nothing probing key
ids can enumerate the ring or learn how far a rotation has got. Which one it was
is in this deployment's own logs. Everything else names the problem, because a
precise refusal here leaks nothing that depends on the secret and is the
difference between a five-minute fix and shipping your logs to someone else's
team.

## When everything fails

Deliveries failing *uniformly* with `WEBHOOK_SIGNATURE_INVALID`, on a secret
nobody touched, is almost always the target. Check, in order:

1. **A path-rewriting proxy.** If anything between the sender and this service
   strips a prefix, adds a tenant segment or normalises a trailing slash, the
   receiver rebuilds a different string than the sender signed. Compare the
   sender's target against `req.originalUrl`.
2. **The query string.** It is part of the signed target. A sender that signs
   `/hooks` and posts to `/hooks?source=billing` has signed a different request.
3. **Something re-serialising the body.** An API gateway that parses and
   re-emits JSON changes the bytes without changing the meaning, which is exactly
   what a digest notices and a human does not.

`signWebhookRequest` returns the `canonical` string it signed, and the receiver's
verified signature carries `bodyDigest`. Two canonical strings side by side say
immediately *which field* the two sides disagree about; two digests say only that
they do.
