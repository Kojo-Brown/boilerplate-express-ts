# Strategy pattern: swappable `AuthStrategy`

Three ways to prove who you are — a password, a link mailed to your inbox, an
API key — and one way to be issued a session. This is the Strategy pattern
where it earns its keep: the thing that varies is *how identity is established*,
and everything downstream of that is identical.

## The shape

```
POST /v1/auth/login/:strategy
        │
        ├─ authStrategyRegistry.has(":strategy")  ── no ──▶ 404 UNKNOWN_AUTH_STRATEGY
        │
        ├─ strategy.authenticate(req.body)
        │     ├─ credentials.safeParse(body)      ── no ──▶ 422 VALIDATION_ERROR
        │     └─ …strategy-specific check…        ── no ──▶ 401
        │                                                    ▼
        └─ AuthService.issueSession(principal) ──────────▶ 200 { user, accessToken, refreshToken }
```

Every strategy returns an `AuthenticatedPrincipal` — `{ id, email, roles }` —
and nothing else. Token minting, refresh-token storage, rotation and revocation
all live in `AuthService`, past the point where the strategies have converged.
That is what makes them interchangeable: no code after login branches on how
the caller proved who they were, so `requireAuth` and `requireRole` keep
validating exactly one credential type no matter how many strategies exist.

| Strategy | Endpoint | Credentials | Failure |
| --- | --- | --- | --- |
| `password` | `POST /v1/auth/login`, `POST /v1/auth/login/password` | `{ email, password }` | `401 AUTH_INVALID_CREDENTIALS` |
| `magic-link` | `POST /v1/auth/login/magic-link` | `{ token }` | `401 AUTH_INVALID_MAGIC_LINK` |
| `api-key` | `POST /v1/auth/login/api-key` | `{ apiKey }` | `401 AUTH_INVALID_API_KEY` |

Magic links are requested separately, at `POST /v1/auth/magic-link` with
`{ email }`.

## Why the credential type is erased at the registry

`AuthStrategy.authenticate` takes `unknown`. That is deliberate, and it is the
one interesting type decision here.

Which strategy runs is decided at runtime, by a URL segment. A registry of
`AuthStrategy<TCredentials>` would therefore have to be heterogeneous, and its
member type would collapse to

```ts
AuthStrategy<PasswordCredentials> | AuthStrategy<MagicLinkCredentials> | AuthStrategy<ApiKeyCredentials>
```

whose `authenticate` accepts the *intersection* of three unrelated shapes —
uncallable with anything. The usual escapes are worse: a union credential type
would let an API key be posted to the password strategy and type-check, and an
`as` at the call site would put an unchecked assertion in the request path.

So the type is erased in exactly one place and re-established immediately
inside it. `defineAuthStrategy` takes a definition that is fully typed — a Zod
schema plus an `authenticate` whose parameter must match it — and returns the
erased interface. The `unknown` never travels: it is parsed on the first line of
the erased `authenticate` and everything after that is typed.

```ts
export function createApiKeyStrategy({ keys }: ApiKeyStrategyDeps): AuthStrategy {
  return defineAuthStrategy({
    name: 'api-key',
    credentials: z.object({ apiKey: z.string().min(1) }),
    async authenticate({ apiKey }) {          // typed, not unknown
      const record = await keys.findByHash(hashSecret(apiKey));
      if (!record) throw new AppError(401, 'Invalid API key', 'AUTH_INVALID_API_KEY');
      return { id: record.userId, email: record.email, roles: [...record.roles] };
    },
  });
}
```

A schema and a handler that disagree fail to compile at the definition site.

## Why validation moved off the router

`/v1/auth/login/:strategy` carries no `validate()` middleware, which is a
departure from the convention in CLAUDE.md ("validation is Zod middleware at the
edge"). The router cannot know which schema applies until the segment has been
read and the strategy resolved, and a union schema at the edge would accept an
API key posted to the password strategy — precisely the check that is worth
having.

The convention's *guarantee* is preserved rather than dropped: handlers still
never see unparsed input, the parse still happens before any strategy logic
runs, and it still raises the same `ValidationError`, so the 422 envelope —
`issues` array included — is byte-identical whether the body was rejected at the
router or inside a strategy. What changed is which layer owns the schema, and it
is now owned by the only layer that knows which one to apply.

The dedicated `POST /v1/auth/login` route keeps its `validate()` middleware and
reuses `passwordCredentialsSchema`, so there is still exactly one definition of
a valid password credential.

## Adding a strategy

1. Add the name to `AUTH_STRATEGIES` in `auth-strategy.types.ts`.
2. The build breaks in `strategies/index.ts` — `Record<AuthStrategyName, …>` is
   no longer satisfied. That is the point: the failure lands at the registration
   site, not at the first request that asks for the new name.
3. Write `createXStrategy(deps): AuthStrategy` with `defineAuthStrategy`.
4. Register it. Factories are lazy, so a deployment that never uses the new
   strategy never constructs it or the stores behind it.

Nothing else changes. No controller, no router, no `AuthService`.

## Registry reuse, and one deliberate difference

The registry is the `ProviderRegistry` from the previous spec item (see
[provider-registry.md](./provider-registry.md)), pinned to `AuthStrategyName` so
the registration table is checked in both directions.

The controller narrows the URL segment with `registry.has()` rather than calling
`resolveUnknown()`. `UnknownProviderError` is a 500 by design — right for a
misconfigured `STORAGE_DRIVER`, which the caller cannot fix, and wrong for a
path a client typed. `has()` yields a 404 naming the registered strategies,
which is both accurate and the more useful thing to read.

Registry keys are looked up in a `Map`, so `POST /v1/auth/login/constructor`
is a 404 rather than a resolution against `Object.prototype`.

## Secret handling

Magic-link tokens and API keys are 256-bit CSPRNG values. Both are stored as a
**SHA-256 digest**, never in plaintext, so a dump of either store yields no
usable credential.

SHA-256 and not argon2, which would be the wrong instinct here. A password KDF
is slow so that guessing a low-entropy, human-chosen string is expensive; these
secrets have no guessing attack to slow down, and a KDF would only add tens of
milliseconds of CPU to every request that presents one. Passwords keep argon2 —
see `lib/password.ts`.

Two other properties worth stating:

- **Magic links are single-use and expiring.** `consume()` deletes the record
  before returning, so a replay — a browser prefetch, a mail scanner following
  the URL, an attacker with an inbox archive — authenticates nobody. TTL is
  `MAGIC_LINK_TTL_SECONDS`, 15 minutes by default. Requesting a link
  invalidates any link already outstanding for that address.
- **Neither endpoint enumerates accounts.** `POST /v1/auth/magic-link` returns
  the same 202 body whether or not the address exists, and every 401 above uses
  one message for "no such subject" and "wrong secret".

## Production wiring

Two defaults in `strategies/index.ts` are environment-dependent, and both fail
closed:

- **Magic-link delivery.** Outside production, links are recorded in memory —
  that is what lets a clean clone log in without an SMTP account, and what lets
  the E2E suite click the link. The token is written to the log only under
  `development`. In production the default `send()` rejects with
  `MAGIC_LINK_DELIVERY_UNCONFIGURED` until a real transport is wired. Falling
  back to the recording delivery would put live credentials in the log stream;
  silently succeeding would return 202 forever while no mail ever arrives.
- **API keys.** `DEV_API_KEYS` — `mock-api-key-admin` and `mock-api-key-user` —
  are seeded only outside production. They are published in this repository and
  are not secrets. A deployment that forgets to hand
  `createAuthStrategyRegistry` a real `ApiKeyDirectory` therefore gets an empty
  one that authenticates nobody, rather than a public admin key.

Both decisions are pure functions of `NODE_ENV` (`selectMagicLinkDelivery`,
`selectApiKeySeeds`) so the production branch is covered by tests rather than
only by reading.

## What this does not do

- **API keys are exchanged for a token pair, not accepted per request.** That
  keeps the key off every subsequent request — out of proxy logs, browser
  history and replayed captures — and keeps `requireAuth` validating one
  credential type. The cost is that revoking a key does not invalidate tokens
  already minted from it; `authService.logoutAll(userId)` closes that window.
  Header-based API key auth on arbitrary routes would be its own item.
- **Stores are in-memory.** `MagicLinkStore` and `ApiKeyDirectory` are ports
  with in-process implementations, replaced by DB-backed ones in Phase 3 by
  passing different objects to `createAuthStrategyRegistry`. Nothing that
  consumes them changes.
- **There is no key-issuance endpoint.** Minting and revoking API keys is an
  admin surface, not part of the authentication path.
- **The password strategy does not equalise timing between an unknown email and
  a wrong password.** The messages are identical, but an unknown email skips the
  argon2 verification and returns measurably sooner. Closing that means
  verifying against a dummy hash, which is a change to `lib/password` rather
  than to the strategies.
