# PII redaction in structured logs

`src/logging/` takes any value on its way to a structured log line and returns
one that is safe to keep. It is wired into `consoleAuditSink`, which is the only
structured stream this service writes today; anything else that grows a JSON
sink wraps it the same way.

```ts
import { getAppRedactor } from '@/logging';

console.log(JSON.stringify(getAppRedactor()({ type: 'audit', ...entry })));
```

```jsonc
// in
{ "userId": "u-1", "userEmail": "ada@example.com",
  "error": "401 from billing: Bearer <the token it refused>" }

// out
{ "userId": "u-1", "userEmail": "[redacted]",
  "error": "401 from billing: Bearer [redacted]" }
```

## Two passes, because one is never enough

**By key.** `userEmail`, `x-api-key`, `currentPassword` — the field was named,
and its value is replaced whole without being looked at. The key is the stronger
signal, so it wins outright: `credentials` may hold any shape at all, and the
detectors below only recognise the shapes they were taught.

**By shape.** `{ "error": "..." }` is how secrets actually reach a log — a
validation error quoting the body it rejected, an upstream's 401 echoing the
header it refused, `describeFailure` carrying whatever a driver put in
`message`. `error` is not a sensitive key and must never become one, so the
strings under names like it are scanned instead.

## Key matching splits words, and that is the whole trick

Exact matching on the normalised name misses every real field, because nobody
calls it `email` — they call it `userEmail` or `customer_email_address`.
Substring matching over-matches, and that damage is worse because it is silent:
`pass` eats `passengers`, `card` eats `discardedAt`, and an operator reading a
log where a third of the fields say `[redacted]` for no reason is an operator
about to turn redaction off.

So a key is split into words — on separators, on camelCase humps, on the
acronym boundary, on letter-to-digit — and it is sensitive when any contiguous
run of those words spells a term in the list:

| Key | Words | Verdict |
| --- | --- | --- |
| `userEmail` | `user`, `email` | redacted, on `email` |
| `x-api-key` | `x`, `api`, `key` | redacted, on the run `apikey` |
| `passengers` | `passengers` | kept |
| `emailsSentCount` | `emails`, `sent`, `count` | kept |
| `tokenizer` | `tokenizer` | kept |

Some absences from `DEFAULT_SENSITIVE_KEYS` are decisions rather than
oversights:

- **`name`** — it is a word in `eventName`, `queueName` and `strategy.name`.
  The person's name is covered by the compounds: `firstName`, `surname`.
- **`address`** — it is a word in `ipAddress` and `remoteAddress`, which is the
  field on-call actually needs. `streetAddress` and `postalCode` are listed
  instead; a deployment whose regulator treats an IP as personal data adds
  `ipAddress` through configuration.
- **`id`** — a user id is a pseudonym and the join key for every other line.
  Redacting it breaks the audit trail and protects nothing.
- **`signature`** — an HMAC over a payload is not a credential, and it is what
  you need when a webhook is being rejected.

## Shape matching validates before it redacts

Every detector is anchored to a structure that can be *checked*, not one that
merely looks plausible:

| Shape | Check | Marker |
| --- | --- | --- |
| `Bearer …`, `Basic …` | the scheme keyword | `Bearer [redacted]` |
| JWT | three base64url segments, the first starting `eyJ` | `[redacted:jwt]` |
| IBAN | ISO 13616 mod-97 | `[redacted:iban]` |
| Card number | Luhn over 13–19 digits | `[redacted:card]` |
| Email address | local part, domain, TLD | `[redacted:email]` |

The check is what makes the detector usable. Without Luhn, a sixteen-digit
order id and an epoch-millis timestamp both read as card numbers — and those
are the numbers somebody is reading the log *for*. "Looks like a phone number"
and "looks like an address" have no such check, so they are deliberately not
here: their false positives land on exactly the fields an incident needs, and
they teach people that `[redacted]` means "ignore this", which is the one thing
a redaction marker must never come to mean.

The passes run in order — scheme, JWT, IBAN, card, email — and no marker is
matched by any pattern, so redacting an already-redacted record is a no-op.

## The walk

Structure is handled as carefully as content, because the failure this module
exists to prevent is not `logger.info({ password })` — somebody catches that in
review. It is `logger.error({ err, req })`, where `req` holds headers, a
session, a socket and a reference to the whole application.

- **Only plain objects, arrays, `Error`s and `Date`s are descended into.**
  Everything else is summarised: `[opaque:Pool]`, `[opaque:Map(3)]`,
  `[opaque:Buffer(2048)]`. No deny list of key names would have saved that
  connection pool.
- **`Error` is rendered rather than emptied.** `JSON.stringify(new Error('x'))`
  is `{}`; here it is `name`, a redacted `message`, `stack`, the `cause` chain,
  and a typed error's own `code` and `statusCode`.
- **Cycles are detected against ancestors, not against everything seen.** The
  same tenant object under two keys is a tree with a shared leaf, not a cycle,
  and calling the second mention `[circular]` would delete a field that was
  perfectly renderable.
- **Strings are redacted first and truncated second.** The other order is
  cheaper and wrong: cutting at the limit can leave the local part of an
  address in the line, which is a leak wearing the shape of a redaction.
- **`NaN`, the infinities and bigints are rendered as text.** The first two
  serialise as `null`, which reads as "the field was absent"; the third makes
  `JSON.stringify` throw, which would take down the call site.
- **The whole walk fails closed.** One `try`/`catch` wraps it, and the fallback
  is `[unserialisable]` — a value containing none of the input, because the
  thing that threw may well have been holding the secret. A redactor that
  throws turns a log statement into a second failure at the exact moment the
  first one stopped being recoverable.

## Configuration

| Variable | Default | What it does |
| --- | --- | --- |
| `LOG_REDACTION_EXTRA_KEYS` | *(empty)* | Extra property names to treat as sensitive, comma-separated. |

That is the whole surface, and the direction is deliberate: configuration can
only ever redact **more**. There is no setting that redacts less and none that
turns redaction off. A switch like that is one hurried incident away from being
set, and the person who sets it at 3am to see a request body is not the person
who notices a month later that production has been logging bearer tokens ever
since.

Entries are matched by the same word rules, so `ip_address`, `ipAddress` and
`IP-ADDRESS` are one entry. The useful ones are jurisdictional or
domain-specific rather than universal — an IP address where a regulator treats
it as personal data, a `policyNumber` that identifies a person in one industry
and means nothing in any other.

## What this is not

It is not a reason to log the data in the first place. Redaction is the last
line, and it only knows the shapes it was taught: a passport number typed into
a free-text `note` field passes straight through, because nothing about it is
checkable.

It is also not where personal data should live. `consoleAuditSink` redacts
`attributes.email` because an audit line is kept for years, which is what turns
a field that was fine to write into a subject-access request. A deployment that
genuinely needs the address against the audit trail joins on `subject` into the
encrypted store (`src/users/user-pii.repository.ts`), where it is covered by
key rotation and by deletion — see `docs/field-encryption.md`.

Finally, the access log is not covered. `requestLogger` is Morgan emitting a
fixed text line of method, URL, status, length and two ids; it interpolates no
user data, so there is nothing in it to redact. A structured access log would
need to be wrapped like the audit sink.
