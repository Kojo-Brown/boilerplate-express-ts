# Mutual TLS: termination notes and client-certificate verification

Ordinary TLS authenticates the server to the client. Mutual TLS adds the other
direction: the client presents a certificate during the handshake and the server
checks it. For a service-to-service API that is a strong credential — it is not
a bearer string that can be copied out of a log, replayed, or pasted into a
chat — and it has a property no token has, which is that possession cannot be
transferred without transferring a private key.

What it does **not** do is tell you who is calling. A validated chain says the
certificate was issued by a CA you trust, and nothing more. Where that CA is
your own, issuing to this service's clients and to nothing else, the chain is
the allowlist. Where it is an organisation-wide or public CA, "the chain is
valid" is a property shared with every certificate it has ever issued, including
the ones issued to somebody else — and a service that stops at chain validity
has authenticated everybody and authorised them too.

So this is two problems, and the split runs through the whole implementation:
**authentication** happens where TLS terminates, and **authorisation** happens
in the application.

Implemented in `src/security/client-certificate.ts`,
`src/security/client-certificate.middleware.ts` and `src/security/trusted-peers.ts`.

## Where TLS terminates decides everything

Two deployments, and they are not variations of one thing — they put the
client's identity in different places with different evidence behind it.

```
direct     client ──mTLS──▶ node (requestCert)          identity: req.socket
proxy      client ──mTLS──▶ nginx/ALB/Envoy ──http──▶ node   identity: a header
```

`MTLS_MODE` says which, and it is **configured, never sniffed**. That is the
single most important decision in this module. The sniffing version is the
obvious one to write:

```ts
// Never do this.
const cert = req.socket.getPeerCertificate?.();
const identity = cert?.subject ? fromSocket(cert) : fromHeader(req);
```

and it gives the service away. Anything that can open a plain socket to the
process — a pod in the same namespace, a misrouted health check, an SSRF
pivot — sets `X-Client-Cert` to a certificate copied out of a public CT log and
is whoever it likes. No amount of validating the header fixes this, because the
header is not the problem; the fallback is. In `direct` mode this middleware does
not read the headers at all, and in `proxy` mode it does not read the socket for
anything but the peer address.

## Proxy mode

The common deployment, and the one where the application has real work to do.

### The hop is the whole basis for believing the header

A forwarded identity is worth exactly as much as the connection that carried it.
`MTLS_TRUSTED_PROXIES` names the peers whose headers are believed, as addresses
or CIDR blocks, and it is compared against `req.socket.remoteAddress` — the
transport peer — and **never** against `req.ip`. Once `trust proxy` is on,
`req.ip` is derived from `X-Forwarded-For`, which is to say from a header the
client wrote; using it to decide whether to believe another header the client
wrote is a check that passes whenever an attacker would like it to.

It has no default. An empty list is refused at mount time rather than defaulted
to loopback, because a default that is right in development is a forgeable
identity header the first time anything else can reach the process.

In Kubernetes the value is the ingress controller's pod CIDR, not a service IP:
the peer is whichever replica proxied the request.

### The terminator must overwrite the header, not add to it

This is a line of proxy configuration and it is load bearing. If the terminator
*adds* its header while leaving one the client sent, Node presents the two as a
single comma-joined value with the client's copy first — so "take the leaf"
means "take the forgery". The decoder refuses any value carrying more than one
certificate for that reason, which also means a terminator configured to forward
a whole chain has to be pointed at its leaf-only variant.

### The verdict header is mandatory

The failure mode that catches people. nginx with `ssl_verify_client optional`
fills `$ssl_client_escaped_cert` from a certificate **it could not validate**,
recording that fact only in `$ssl_client_verify`. A receiver that reads the
certificate header and not the verdict accepts any self-signed certificate a
client cares to generate for itself — and every one of them looks completely
normal in the access log.

There is no "assume success" default, and a missing or empty verdict is a
refusal.

### nginx

```nginx
server {
    listen 443 ssl;
    ssl_certificate     /etc/nginx/tls/server.crt;
    ssl_certificate_key /etc/nginx/tls/server.key;

    # The client CA. Only certificates under this anchor can ever verify.
    ssl_client_certificate /etc/nginx/tls/clients-ca.crt;

    # `optional` and not `on`, so an unverified client reaches the app and gets
    # an HTTP refusal with a code and a correlation id instead of a TLS alert.
    # This is only safe because the app checks the verdict below.
    ssl_verify_client optional;
    ssl_verify_depth 2;

    location / {
        proxy_pass http://api:4000;

        # `proxy_set_header`, which *replaces*. Setting these is also what
        # strips anything the client sent under the same names.
        proxy_set_header X-Client-Cert   $ssl_client_escaped_cert;
        proxy_set_header X-Client-Verify $ssl_client_verify;
    }
}
```

```dotenv
MTLS_MODE=proxy
MTLS_TRUSTED_PROXIES=10.0.0.0/8
MTLS_CLIENT_CERT_HEADER=x-client-cert
MTLS_CLIENT_VERIFY_HEADER=x-client-verify
MTLS_CLIENT_VERIFY_SUCCESS=SUCCESS
```

`$ssl_client_escaped_cert` and not `$ssl_client_cert`: the escaped form is
percent-encoded and lossless, where the older variable folds the PEM across
continuation lines and arrives mangled often enough to be a support case.

### AWS ALB

ALB in `verify` mode refuses an unverified client itself and sets its
`X-Amzn-Mtls-Clientcert-*` headers only on one it validated, so there is no
verdict to match — the evidence is that the header exists at all. That is what
`*` is for:

```dotenv
MTLS_MODE=proxy
MTLS_TRUSTED_PROXIES=10.0.0.0/16        # the load balancer's subnets
MTLS_CLIENT_CERT_HEADER=x-amzn-mtls-clientcert-leaf
MTLS_CLIENT_VERIFY_HEADER=x-amzn-mtls-clientcert-validity
MTLS_CLIENT_VERIFY_SUCCESS=*
```

`-leaf` and not `x-amzn-mtls-clientcert`, which carries the whole chain and is
refused. Pointed at a header ALB sets only on a verified client, `*` is exactly
as strong as an exact match; pointed at anything a client can influence it is
worth nothing, which is why it has to be written out.

ALB in `passthrough` mode forwards whatever the client presented, verified or
not, and sets no verdict at all. It is not supported here and should not be: it
is the `ssl_verify_client optional` hole with no way to detect it.

### Envoy, Istio and other meshes

Not supported yet. A mesh sidecar sends `x-forwarded-client-cert` (XFCC), which
is not a certificate but a list of hops, each a `;`-separated key-value set
(`By=`, `Hash=`, `Subject=`, `URI=`, `Cert=`), appended to as a request crosses
the mesh. Reading it correctly means deciding which element is the client rather
than an intermediary, and getting that wrong is an identity confusion rather
than a parse error. An implementation belongs behind its own parser and its own
tests; `decodeForwardedCertificate` deliberately refuses it rather than pulling
a `Cert=` out of the first element it finds.

## Direct mode

Node terminates TLS and asks for a certificate itself. `clientCertificateTlsOptions`
is the server-side half:

```ts
import https from 'node:https';
import { readFileSync } from 'node:fs';
import { createApp } from '@/app';
import { clientCertificateTlsOptions } from '@/security';

https
  .createServer(
    {
      key: readFileSync('/etc/tls/server.key'),
      cert: readFileSync('/etc/tls/server.crt'),
      ...clientCertificateTlsOptions(readFileSync('/etc/tls/clients-ca.crt', 'utf8')),
    },
    createApp(),
  )
  .listen(4443);
```

```dotenv
MTLS_MODE=direct
MTLS_TRUSTED_PROXIES=
```

Three options, and all three matter:

- `requestCert: true` asks the client for a certificate. Without it nothing is
  ever presented and every request is anonymous.
- `rejectUnauthorized: false` lets the handshake complete when the client sends
  a bad certificate or none. In isolation this is the worst line in any TLS
  configuration; here it is what makes the refusals debuggable, and it is only
  safe because the middleware enforces the verdict. **The listener and the
  middleware are one decision.** A listener mounted without the middleware
  accepts every self-signed certificate in the world.
- `ca` replaces Node's bundled public roots. Left out, every certificate from
  every public issuer authenticates, which is not mutual authentication but a
  very expensive way of accepting everyone.

`server.ts` deliberately still builds a plain HTTP server: edge termination is
the recommended deployment, and a boilerplate that shipped an HTTPS listener
would ship a certificate path nobody has.

## Why refusals are HTTP responses and not TLS alerts

A handshake that fails ends in a TLS alert: no status, no body, no correlation
id, nothing in the access log but a socket that closed. The client sees
`ECONNRESET` or `SSL alert number 48` and cannot tell an expired certificate
from the wrong CA from a certificate nobody authorised. For a browser that is
the right outcome. For a machine client it is close to undebuggable.

So both deployments are arranged to let the handshake complete and to refuse in
HTTP. The cost is that **nothing is enforced until something checks the
verdict**, which is the middleware's entire reason to exist.

| code | status | meaning |
| ---- | ------ | ------- |
| `CLIENT_CERT_UNTRUSTED_HOP` | 401 | proxy mode: the headers arrived from a peer that is not a trusted terminator |
| `CLIENT_CERT_NO_TLS` | 401 | direct mode: the request did not arrive over TLS |
| `CLIENT_CERT_REQUIRED` | 401 | no certificate was presented |
| `CLIENT_CERT_NOT_VERIFIED` | 401 | a certificate was presented and the chain was not established |
| `CLIENT_CERT_MALFORMED` | 400 | the header was present and could not be read as a certificate |
| `CLIENT_CERT_OUTSIDE_VALIDITY` | 401 | the certificate is expired or not valid yet |
| `CLIENT_CERT_FORBIDDEN` | 403 | the chain is valid and this identity is not authorised |

`CLIENT_CERT_FORBIDDEN` is the only 403: authentication succeeded and
authorisation did not. The 401 on an untrusted hop or a plaintext request is
deliberate — both readings of those (a deployment mistake, or something probing
a port it should not reach) have to answer "not authenticated", and a 500 would
turn a security control into an availability report.

## Authorisation

Two lists, and an identity matching either is authorised:

```dotenv
MTLS_ALLOWED_CLIENT_CNS=svc-ingest.internal.example,svc-reporting.internal.example
MTLS_ALLOWED_CLIENT_SPKI_SHA256=0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0
```

Both empty authorises every certificate the anchor validated. That is correct
for a private CA that issues to this service's clients and to nothing else, and
wrong everywhere else; the code cannot tell which deployment it is in, so the
decision is recorded in the environment rather than guessed at — the same
treatment `CORS_ORIGIN=*` gets.

Names are compared **exactly**, and a subject carrying more than one `CN` is
refused rather than resolved. `CN=svc-reporting,CN=svc-admin` is a legal DN; a
reader taking the first and an allowlist taking the last then disagree about who
is calling, and whoever got that certificate issued chooses which component
believes what. A certificate with two names is not an identity.

Pins are on the **SubjectPublicKeyInfo**, not on the certificate:

```sh
openssl x509 -in client.crt -noout -pubkey |
  openssl pkey -pubin -outform der | openssl dgst -sha256
```

A certificate fingerprint changes on every renewal, including the routine ones
where the key never moved, so pinning on it schedules an outage for reissue day.
An SPKI pin survives renewal and breaks on the event it should break on — a
different key. It is also the only one of the two that survives an issuer going
wrong: a certificate from another CA bearing the same common name passes a name
allowlist and fails a pin.

## Mounting it

Per route subtree, not globally. A client certificate answers "which of our own
systems is calling", and mounting it over an API that also serves browsers and
bearer tokens refuses all of them.

```ts
import { Router } from 'express';
import { clientCertificatePolicyFromEnv, requireClientCertificate } from '@/security';

// Built once, at module scope, so a misconfiguration fails at boot rather than
// on the first request to reach the route.
const clientCertificates = clientCertificatePolicyFromEnv();

export const internalRouter = Router();

internalRouter.use(requireClientCertificate(clientCertificates));

internalRouter.post('/reconcile', (req, res) => {
  // Present only on a request that got past the middleware, authorisation
  // included. There is no state in which it holds an unverified identity.
  const caller = req.clientCertificate?.commonName;
  // …
});
```

Nothing in `createApp` mounts it: there is no route in this boilerplate whose
callers are known to hold certificates, and a middleware mounted speculatively
over `/v1` would refuse every request in the suite. The policy is still built
from the environment and validated at boot by the shape checks in
`config/env.ts`.

## Validity is re-checked here, and that is not redundancy

Both terminators check the window too. It is checked again, against this
process's clock, for two different reasons:

- in proxy mode the only evidence is the verdict header, which says the
  certificate was valid **at the edge**, possibly minutes ago, against a clock
  this process has no view of;
- in direct mode Node checked it during the handshake, and a keep-alive
  connection outlives the handshake — a certificate that expires mid-session
  keeps serving requests on an already-authorised socket until the client
  reconnects.

`notBefore` is as real a failure as `notAfter`, and in practice it is more
common: a freshly issued certificate rolled out across a fleet whose clocks
disagree.

## What is not covered

- **Revocation.** Neither CRL nor OCSP is consulted, in either mode. In proxy
  mode that is the terminator's job and it should be configured to do it; in
  direct mode Node does not check revocation for client certificates at all, so
  a compromised client key is live until its certificate expires or the CA is
  rotated. Short-lived certificates are the usual answer, and an SPKI pin
  removed from `MTLS_ALLOWED_CLIENT_SPKI_SHA256` is a revocation this service
  can actually enforce.
- **SAN-based authorisation.** `subjectAltNames` is published on the identity
  for audit and for handlers, and the allowlist does not consult it. Comparing
  SAN entries needs per-type rules — `checkHost` for DNS names, `checkIP` for
  addresses — and a string allowlist comparing `DNS:` entries by equality is the
  half-measure that looks like it works until somebody writes a wildcard in it.
- **XFCC**, as above.
- **Certificate-bound tokens** (RFC 8705). A bearer token tied to the client
  certificate that requested it would close the gap where a token stolen from a
  client is usable from anywhere; `req.clientCertificate.certificateFingerprintSha256`
  is the value such a binding would carry, and nothing issues or checks one yet.
- **Per-route identity rules.** The allowlist is one policy for the process. A
  deployment needing different clients on different routes builds a second
  policy with `clientCertificatePolicy()` and mounts it where it applies.
