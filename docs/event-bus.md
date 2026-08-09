# Domain events

A typed, in-process `EventBus` over Node's `EventEmitter`, plus the domain
events this service publishes and the subscribers that consume them.

- `src/events/event-bus.ts` — the generic bus (`createEventBus`)
- `src/events/domain-events.ts` — the event catalogue and the process-wide bus
- `src/events/subscribers/` — the subscribers, attached in `src/app.ts`

## Why not just use `EventEmitter`

An `EventEmitter` is the right primitive and the wrong interface. Three things
it cannot do, in the order they bite in production:

**Names and payloads are unchecked.** `emit('user.delted', payload)` is valid
JavaScript and valid TypeScript. Nothing fires, nothing errors, and the bug
surfaces weeks later as a missing audit trail. Changing a payload's shape is
worse: the publisher compiles, the subscriber compiles, and a field is
`undefined` at runtime. The bus is parameterised by a map from event name to
payload type, so both are compile errors.

**Async listeners are abandoned.** `emit` ignores return values, so an `async`
listener's promise is nobody's. If it rejects, that is an unhandled rejection —
which since Node 15 terminates the process by default. The bus wraps every
handler before registering it, so there is no promise it does not own, and
`publish` resolves only once they have all settled.

**A failing listener fails the publisher.** A listener that throws
synchronously throws out of `emit`, into whoever published — so a broken audit
sink returns 500 for a write that already committed. A subscriber is by
definition something the publisher does not depend on; letting it fail the
publisher inverts that.

There is also a trap worth naming: `emit('error')` with no listener attached
*throws*. The bus rejects `error`, `newListener` and `removeListener` outright.

## The contract

```ts
const unsubscribe = bus.on('user.deleted', async (event) => {
  await revoke(event.payload.userId);
});

await bus.publish('user.deleted', { userId, actorId }, { correlationId });
```

`publish` resolves once every handler has settled and **never rejects because
of a subscriber**. Awaiting it is therefore about ordering — "the revocation
has run" — never about success. A publisher that does not need the ordering can
leave the promise unawaited without risking an unhandled rejection.

Handlers receive an envelope rather than a bare payload:

| field           | why it is there                                                     |
| --------------- | ------------------------------------------------------------------- |
| `id`            | recognise a duplicate delivery                                       |
| `name`          | one handler can serve several events                                 |
| `occurredAt`    | when the fact happened, not when a handler got to it                 |
| `correlationId` | join an audit line back to the access log entry for the request      |
| `payload`       | the event's own data                                                 |

Handlers run **concurrently**, not in registration order. If two subscribers
must run in sequence, they are one workflow, not two subscribers.

## What the bus is not

In-process, at-most-once, and not durable. An event published while a
subscriber is throwing is gone; an event published a millisecond before the
process is killed never happened. That is fine for the consequences it carries
today and not fine for consequences that must not be lost — those want the
transactional outbox (Phase 7), where the intent is written in the same
transaction as the change and a relay drains it.

Concretely: `registerSessionRevocationSubscriber` revoking a deleted user's
refresh tokens is best-effort. If the token store is down, the delete still
answers 204 and only the log records that the tokens are still live. That
window is real, and it is smaller than the one it replaces — which was
"forever".

## Writing an event

Two rules, both load-bearing:

**Publish facts, not commands.** `user.deleted`, not `revokeSessions`. Naming
the consequence just moves the coupling into the event name — the users module
would still be the thing deciding sessions must die, only at a distance and
without a type to check it. Naming the fact is what lets a subscriber appear or
disappear without the publisher changing.

**Carry identifiers, not credentials.** Payloads reach subscribers whose job is
to write them somewhere durable. A token, password hash, or magic-link secret
placed in a payload is a secret published to every current and future sink.
`auth.login.succeeded` carries a user id and a strategy name and nothing the
caller could replay.

Adding an event means adding a key to `DomainEventPayloads`. That will fail to
compile until `AUDIT_DESCRIPTORS` in `audit-log.subscriber.ts` says what the
event means for the audit trail — deliberately, because an audit log that
silently omits the event nobody remembered to wire up is worse than no audit
log, since it is trusted.

## What is published today

| event                   | published by                    |
| ----------------------- | ------------------------------- |
| `user.created`          | `POST /v1/users`                |
| `user.updated`          | `PUT /v1/users/:id`             |
| `user.deleted`          | `DELETE /v1/users/:id`          |
| `auth.login.succeeded`  | `AuthService.authenticate`      |
| `auth.session.revoked`  | `AuthService.logout`/`logoutAll`|

Deliberately absent:

- **Token rotation.** `AuthService.refresh` runs every few minutes per active
  session and would say only that a session which already announced itself is
  still going. The signal worth having from that path is a *reused* refresh
  token — a different event, and the Phase 10 reuse-detection item.
- **OAuth callbacks.** `oauth.service` upserts its own users and does not go
  through `AuthService.authenticate`, so it publishes nothing yet. Wiring it up
  means deciding whether an OAuth sign-in is the same fact as a password one.
- **Failed logins.** Worth auditing, and they live on the error path in the
  controller rather than in the service; publishing them is its own change.

## What is deliberately not an event

Cache invalidation on the users routes stays inline in the controller. The bus
isolates handler failures by design, so an invalidation that failed as a
subscriber would be logged while the write answered 200 — and this replica
would serve the row it just changed for the rest of the TTL. That is a
correctness consequence of the write and belongs on the write's own error path.

The dividing line: **events carry the consequences a publisher can afford to
lose.** Everything else stays in the caller's control flow.

## Subscribers

`registerDomainSubscribers(bus)` is called once, from `src/app.ts`. Subscribers
never attach on import — a module that subscribes to itself is impossible to
leave out of a deployment, and the composition root is the only place that
should know the full list. Each `register*` function returns an unsubscribe, so
tests can install their own and put the bus back.

**`registerAuditLogSubscriber`** writes one JSON line per event to an
`AuditSink` (stdout by default; an append-only table or a SIEM later). It is
not Morgan's format: an access log line describes an HTTP exchange and is
sampled and rotated accordingly, while this describes a security-relevant fact
and tends to be kept for years. They share `correlationId` and nothing else.

**`registerSessionRevocationSubscriber`** revokes a deleted user's refresh
tokens. This is the subscriber that justifies the bus: deleting the row does
not end the session, and without it a deleted account keeps minting credentials
until its refresh token expires. Putting it in the users module would mean
`DELETE /v1/users/:id` importing the auth module's token store, and every later
consequence of deletion accreting onto the same handler.

## Testing

Prefer a real bus with recording subscribers over a stubbed one — a hand-written
fake will happily accept a payload no subscriber could consume. Inject `now`
and `newId` to make envelopes deterministic:

```ts
const bus = createEventBus<DomainEventPayloads>({
  now: () => new Date('2024-05-01T12:00:00.000Z'),
  newId: () => 'event-1',
});
```

Pass `onHandlerError` to assert that a failure was reported rather than
swallowed — and to keep the default reporter's `console.error` out of the test
output.
