# Refresh-token reuse detection

A refresh token is a bearer credential with a week-long life, held on a client,
sent over the network every few minutes. Rotation — issuing a new one on every
refresh and retiring the old — shortens the window in which any single token is
useful, and that is worth having on its own. What it does *not* do is notice
that a token was copied.

This is the part that notices.

## The signal

Rotation makes a session a chain: login mints token 1, refreshing it mints
token 2 and spends token 1, and so on. In a healthy session each link is
presented exactly once. So a token presented *after* it has already been
rotated away is an event that cannot happen to a well-behaved client with an
uninterrupted connection — and it is the only server-side signal that a refresh
token has been copied.

It does not say who copied it, and this is the part that decides the response.
When a spent token arrives, two things are simultaneously true: that link was
superseded, and somebody still holds it. The server has no way to tell whether
the presenter is the legitimate client replaying a token it failed to replace,
or an attacker working from a stolen copy. Both readings fit the evidence
exactly.

So consider who holds the *live* end of the chain in each case:

- If the replayer is the legitimate client, the live token is also theirs, and
  revoking it costs them one login.
- If the replayer is an attacker, then either they hold the live token (they
  refreshed first and the client is now replaying what the attacker spent) or
  the client does (the attacker is working from an older copy). Leaving the
  live token alone is safe in one of those and hands over the account in the
  other.

Revoking the whole chain is the only response that is safe under every reading.
That is what "family revocation" means here: the unit is the rotation chain,
not the token.

## The unit is the chain, not the user

Every token records a `familyId`. A login starts one; every rotation inherits
it. Reuse revokes that family and nothing else.

Not the token alone, because that is the response that does nothing: the
attacker's live successor is a different token, so revoking only the replayed
one leaves them logged in — detection that fires and changes nothing.

Not every session the user has, because a second device is a separate chain
started by a separate login, and there is no evidence against it. Logging
someone out of their laptop because their phone replayed a token is a blast
radius the signal does not support. (`logoutAll` still exists, and so does the
`user.deleted` subscriber — those have evidence for the wider scope.)

The `familyId` is a server-side record and deliberately **not** a JWT claim. A
family id inside the token is a value the presenter supplies, and the whole
mechanism turns on the server knowing which chain a token really came from: an
attacker free to name their own family puts a stolen token in a family of one,
and the revocation reaches nothing.

## Retention is what makes detection possible

A store that deletes a token on rotation cannot do any of this. Asked about a
spent token it says "no such token" — the same answer it gives for a string
somebody invented — and those two are the entire difference between a theft in
progress and a typo.

So `RefreshTokenStore` keeps every record and marks it instead:

| State | Meaning | On presentation |
| --- | --- | --- |
| `active` | the live end of a chain | rotate; issue a successor |
| `rotated` | spent by a normal refresh | **reuse** — revoke the family, alarm |
| `revoked` | logout, logout-all, deletion, or an earlier family revocation | 401, no alarm |
| *absent* | never issued, or expired | 401, no alarm |

`rotated` and `revoked` are kept apart on purpose. A client that logs out and
later retries a refresh with the token it still holds is doing something
ordinary and common; answering `reuse` there would fire the theft signal on
everyday behaviour until nobody read it. It also keeps an already-killed family
quiet: after a revocation every member is `revoked`, so an attacker retrying in
a loop produces one alert rather than one per attempt.

**Records are retained for exactly as long as the token itself verifies** — the
expiry is read off the JWT's own `exp` rather than configured separately. The
two must agree, and the direction they can disagree in is the dangerous one: a
retention window shorter than `JWT_REFRESH_EXPIRES_IN` leaves a stretch in
which a reused token passes `verifyRefreshToken` and has no record left to
recognise it by. That is reuse detection that has silently stopped detecting.
Past `exp` the JWT check rejects the token before the store is consulted at
all, so keeping the record buys nothing.

## Rotation has to be atomic

`consume()` is one call, not a `has()` followed by a `remove()`, and the join is
load-bearing rather than tidy.

Split in two, two concurrent refreshes carrying the same token interleave at
the `await` between the check and the write: both read `active`, both retire it,
both mint a successor. That forks a chain that is supposed to be linear — and
worse, it hands an attacker the way around this entire document, because racing
the legitimate client is then a reuse that is never reported.

Whatever backs the store has to make the read and the state change indivisible.
The in-memory `Map` gets it by running both without yielding (there is no
suspension point inside `consume`, and that is an invariant a change there must
preserve). Postgres gets it from a conditional update:

```sql
UPDATE refresh_tokens
   SET state = 'rotated', rotated_at = now()
 WHERE token_hash = $1 AND state = 'active'
RETURNING user_id, family_id;
```

The returned row count *is* the winner test: exactly one concurrent caller gets
a row back, everyone else gets zero and then reads the record to find out
whether it was `rotated` (reuse) or `revoked`.

## What is deliberately not here

**No grace window.** A common suggestion is to hand the same successor back for
a second presentation of a token within a few seconds, so that a client
retrying a refresh across a dropped connection is not punished for it. The
retry is real — but the window is equally open to whoever else holds the token,
so it converts the one signal that a credential has been copied into a
configurable number of seconds in which copying it is free. And the failure it
prevents is survivable without it: a client that loses a refresh race still
holds credentials and logs in again. Strict is the default here, and a
deployment that wants the trade can make it deliberately.

**No distinct error code.** A replayed token gets the same
`401 TOKEN_REVOKED`, with the same message, as any other dead token. Telling
the presenter that the server noticed is worth nothing to a legitimate client
— it has to log in again either way — and tells an attacker exactly when to
stop and which of their tokens is the one being watched.

**The response is the revocation, not a subscriber's reaction.** The auth
service revokes the family itself and then publishes `auth.refresh.reused` as a
statement of what it already did, carrying `userId`, `familyId` and
`revokedCount`. A subscriber that had to *perform* the revocation would make
the security response depend on a listener being attached. The event carries no
token material, because it reaches every sink the bus has, including durable
ones.

It is a separate event name rather than a third `scope` on
`auth.session.revoked` because the two mean opposite things to whoever reads
them: a revocation is a user doing something ordinary, and this is the one
signal in the auth module that a credential may be in the wrong hands. Folded
together they would share a rate, a panel and an alert, and the rare one would
live underneath the common one.

## Operational note

`auth.refresh.reused` is the thing to alert on. A low background rate is
expected — buggy clients, users restoring an app from a backup — so alert on a
*change* in rate rather than on any occurrence, and on repeats for one `userId`
rather than one event anywhere.

The in-memory store sweeps expired records on `issue`, at most once a minute,
and drops them lazily whenever a record is looked at. A DB-backed store should
do the same work as a scheduled `DELETE ... WHERE expires_at < now()`, alongside
the idempotency purge (`src/idempotency/purge-job.ts`), rather than growing the
table forever.

The honest limit: the store here is per-process. Two replicas holding separate
maps each see half the refreshes, so a reuse split across them is invisible and
a family revoked on one replica stays live on the other. That is a property of
the in-memory implementation and not of the design — the interface is the seam
the DB-backed store drops into, and until it exists this mechanism is only
correct for a single instance.
