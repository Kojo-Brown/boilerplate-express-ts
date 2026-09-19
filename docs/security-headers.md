# Security headers and the CORS allowlist

`src/security/`

```
securityHeaders(policy)   helmet, configured for an API that serves no documents
corsMiddleware(policy)    an exact-match origin allowlist, driven by CORS_ORIGIN
```

Both are mounted in `createApp()`, above everything else, and both take their
policy as an argument rather than reading `env` — `corsPolicyFromEnv()` and
`securityHeaderPolicyFromEnv()` are the only places the two are joined, and the
only places a test has to work around.

## The bug this closed

`CORS_ORIGIN` has been in `.env.example` since the first commit, documented as
the origins allowed to call this API. Nothing enforced it. The only reader was
`wsAllowedOrigins()` in the WebSocket gateway, so a deployment could set it to
its single frontend, deploy, and still be answering every origin on the
internet — with the variable in the environment saying otherwise. A setting
that appears to do something and does not is worse than its absence, because it
stops anybody from looking.

## What the CORS middleware does, and the case that is usually wrong

Three paths, and the difference between the second and third is the one worth
reading:

**No `Origin` header.** Not a cross-origin request. Nothing is added beyond
`Vary`, and the request proceeds.

**A preflight** — `OPTIONS` carrying `Access-Control-Request-Method`. Answered
here and never routed; it exists only to ask this question. An origin outside
the allowlist gets `403 CORS_ORIGIN_NOT_ALLOWED` through the normal error
envelope rather than a headerless `204`. Both fail identically in the browser,
but only one of them shows up in a log line, a metric and a developer's network
tab as a *refusal* rather than as a success that inexplicably did not work.

**An actual request.** A permitted origin gets the response headers. An origin
outside the allowlist **is still served**, with no CORS headers, and the
browser withholds the response from the page.

That last one looks like a hole and is not. A browser attaches `Origin` to
every same-origin `POST`, `PUT` and `DELETE` as well, so a server-side refusal
would break same-origin writes for any deployment where the API and the page do
not share an origin string exactly. And it would protect nothing: a client that
ignores CORS is not a browser, and a 403 does not stop `curl`. CORS is a rule
about what a *browser* hands to a *page*; the browser is the only place it can
be enforced. Authorisation is what stops a request, and it runs on every one of
these regardless.

### Vary

`Vary: Origin` goes on every response an origin-dependent policy produces,
including responses to requests that carried no `Origin` at all. Without it a
shared cache can store the headerless answer given to an unknown origin and
replay it to a permitted one. It fails in production, intermittently, for one
customer, and it is unreproducible anywhere else.

A wildcard policy answers `*` to everybody, so it sets no `Vary` and its
responses stay cacheable under one key. A wildcard policy *with credentials* is
the exception: allowing every origin is not the same as answering every origin
identically, and the header then carries the caller's own origin, so `Vary`
comes back.

Preflights additionally vary on `Access-Control-Request-Method` and
`Access-Control-Request-Headers`: a cache that keys them on the origin alone
serves the answer for one method as the answer for another.

### Exact matching

Origins are compared with `===`. An origin is a scheme, a host and a port, and
every allowlist bug worth having is a `startsWith` or `endsWith` that accepted
`https://app.example.com.attacker.test`. A deployment that needs a pattern
lists the origins it means.

### Credentials

`CORS_ALLOW_CREDENTIALS=true` together with `CORS_ORIGIN=*` is refused at boot.
The combination is invalid per the specification — a browser rejects the
response outright — so the alternatives were to silently ignore one of the two
settings, leaving an operator with a false belief and nothing saying so, or to
honour both and let every site on the internet act as a logged-in user.

### Why not the `cors` package

The allowlist decision is the security-relevant part of this feature and it is
about seventy lines. Owning it buys the three behaviours above that `cors` does
not have: a preflight refusal that is visible in logs and metrics instead of a
silent `204`, `Vary: Origin` on responses that carried no `Origin`, and a
wildcard policy that reflects the caller once credentials are on. This
repository already hand-rolls a RESP parser and a WebSocket frame codec; an
origin comparison is not where it should start taking a dependency it cannot
fully describe.

## The Content-Security-Policy

```
default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'
```

`default-src 'none'` denies every *fetch* directive at once. The three that
follow are not redundancy: `base-uri`, `form-action` and `frame-ancestors` do
**not** fall back to `default-src`, so a policy that stops at the first line
leaves a document served from this origin framable and its `<base>` rewritable.
Every "we had a CSP and it did not help" is one of those three.

Nothing this service returns is a document today, so none of it is load-bearing
yet — which is exactly when to set it. The header is already correct on the day
someone adds an HTML error page or mounts a Swagger UI, and that is the day a
permissive default would have become a problem. Widening `cspDirectives()` is
then a diff a reviewer sees.

Deliberately absent: `upgrade-insecure-requests`, which rewrites a *document's*
subresource URLs and has nothing to act on in a response carrying no
subresources. HSTS is what moves this API onto TLS.

`CSP_ENABLED=false` exists for a deployment whose edge sets its own policy: two
CSP headers are intersected, not overridden, so the strict one here would
combine with an HTML-serving edge's and break the pages it was protecting.

`CSP_REPORT_ONLY=true` requires `CSP_REPORT_URI`. Report-only with nowhere to
report is a header that neither enforces nor records, while reading in the
environment like a policy under observation.

## HSTS

`max-age=15552000; includeSubDomains` by default; `preload` only when asked.

Preload is the one setting here that is not reversible on your own schedule:
removal is a request to the list maintainers followed by a wait for browser
releases to carry it, measured in months. Turning it on requires a max-age of
at least a year and subdomain coverage, and both are checked at boot rather
than discovered at submission.

`HSTS_MAX_AGE_SECONDS=0` omits the header entirely. That is the setting for a
deployment whose TLS terminator already sends one — two HSTS headers on a
response is undefined behaviour, not a stricter policy.

Sending it in development costs nothing. A browser ignores HSTS delivered over
plain HTTP, which is every local request.

## The rest of the headers

| Header | Value | Why |
| --- | --- | --- |
| `X-Content-Type-Options` | `nosniff` | Stops a browser from re-reading a JSON error as HTML |
| `X-Frame-Options` | `DENY` | Superseded by `frame-ancestors` where CSP2 is implemented; one line for where it is not |
| `Referrer-Policy` | `no-referrer` | API URLs carry resource ids, and there is no analytics case on an API to trade that against |
| `Cross-Origin-Resource-Policy` | `same-origin` | Bounds *no-cors* loads — an `<img src>` pointed here. Not consulted for a CORS-mode `fetch`, so it neither overlaps with nor undoes the allowlist |
| `Cross-Origin-Opener-Policy` | `same-origin` | Severs the opener relationship for anything this origin does open |
| `X-Powered-By` | removed | Names the framework and the answer is never useful to a client |

`Cross-Origin-Embedder-Policy` is deliberately left off, which is also helmet's
default. `require-corp` is a property of a *document* seeking cross-origin
isolation; asserting it on JSON constrains nothing and breaks any page that
embeds this API's responses without a CORP header of its own.

## Ordering in `createApp`

```
securityHeaders          ← first of everything
appMetrics.middleware
metrics router
corsMiddleware           ← above the body parsers and session()
express.json / session / passport / …
routers
404 handler
errorMiddleware
```

`securityHeaders` is above even the metrics timer, whose own comment insists on
being first. What it adds to that measurement is a handful of `setHeader` calls
— below the resolution of the histogram's smallest bucket. What it buys is that
no response can escape the headers: not the metrics exposition, not the 404
handler, not a refusal from the shutdown guard. A policy present only on the
responses somebody remembered is not a policy.

`corsMiddleware` sits below the timer, because a preflight is real traffic a
cross-origin frontend pays for and should appear in the latency histogram, and
above the body parsers and `session()`, because a preflight carries no body
worth parsing and belongs to no session. Answering it there means the extra
round trip per cross-origin write does not also become a lookup in the session
store.

## Configuration

Every variable, its default and what it costs to change are in `.env.example`
under **CORS** and **Security headers**. The invariants checked at boot are in
`src/config/env.ts`:

- `CORS_ALLOW_CREDENTIALS=true` with `CORS_ORIGIN=*`
- `HSTS_PRELOAD=true` with a max-age under a year, or without subdomains
- `CSP_REPORT_ONLY=true` with no `CSP_REPORT_URI`
