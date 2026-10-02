import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { X509Certificate } from 'node:crypto';
import type { TLSSocket } from 'node:tls';
import { env } from '@/config/env';
import {
  certificateValidity,
  decodeForwardedCertificate,
  identityOf,
  isIdentityAuthorized,
  parseCertificate,
  validityWindowOf,
  type ClientCertificateAuthorizationPolicy,
  type ClientCertificateSource,
} from '@/security/client-certificate';
import {
  ClientCertificateForbiddenError,
  ClientCertificateMalformedError,
  ClientCertificateNotVerifiedError,
  ClientCertificateOutsideValidityError,
  ClientCertificatePolicyError,
  ClientCertificateRequiredError,
  ClientCertificateTransportError,
  ClientCertificateUntrustedHopError,
} from '@/security/mtls.errors';
import { TrustedPeerList } from '@/security/trusted-peers';

/**
 * Mutual TLS, from the point of view of the application rather than the
 * handshake.
 *
 * ## Two deployments, one middleware
 *
 * Where TLS terminates is a deployment fact, and it decides where this
 * middleware reads a client's identity from:
 *
 *   - **`direct`** — this process terminates TLS and asked for a client
 *     certificate, so the identity is on the socket and this process validated
 *     the chain itself.
 *   - **`proxy`** — an ingress, load balancer or mesh sidecar terminated TLS,
 *     validated the chain, and forwarded what it saw in headers. The identity is
 *     a header and the evidence is the terminator's verdict.
 *
 * The mode is **configured and never sniffed**, and that is the single most
 * important line in this file. The sniffing version is the obvious one — read
 * the socket, and if there is no certificate there, fall back to the header —
 * and it hands the service away: anything that can open a plain socket to the
 * process sets `X-Client-Cert` to a certificate it copied out of a public CT log
 * and is whoever it likes. No amount of checking the header repairs that,
 * because the header is not the problem; the fallback is. So in `direct` mode
 * the headers are not read at all, and in `proxy` mode the socket is read only
 * for its peer address.
 *
 * ## Why the refusals are HTTP and not TLS alerts
 *
 * Both shapes are deliberately configured to let an unverified handshake
 * *complete* — `requestCert: true` with `rejectUnauthorized: false` here,
 * `ssl_verify_client optional` at an edge — so that a client gets a refusal with
 * a code and a correlation id instead of a dropped socket. That is a debugging
 * decision with a security consequence, and the consequence is this middleware:
 * with a soft handshake, *nothing* is enforced until something checks the
 * verdict. See `docs/mtls.md` and `mtls.errors.ts`.
 *
 * ## The order of the checks
 *
 * Cheapest and most hostile first, same rule as `verifyWebhookSignature`:
 *
 *   1. **the hop** (proxy mode) — whether this connection's headers may be
 *      believed at all. No parsing, and it is the check with a real attacker
 *      behind it.
 *   2. **the terminator's verdict** (proxy mode) or **`socket.authorized`**
 *      (direct mode) — was the chain established.
 *   3. **presence** of a certificate.
 *   4. **decode and parse** — the first step that spends work on attacker-sized
 *      input.
 *   5. **the validity window**, against this process's clock.
 *   6. **authorisation** — is this identity one we serve.
 *
 * Step 2 ahead of step 3 reads backwards in proxy mode and is not: a terminator
 * configured for optional verification forwards the certificate *even when
 * verification failed*, so the verdict is what makes the certificate header
 * worth decoding at all. In direct mode the two are the other way round, and
 * for a reason local to Node — see `certificateFromSocket`.
 */

export interface ClientCertificatePolicy extends ClientCertificateAuthorizationPolicy {
  /** Where the identity is read from. Configured, never inferred. */
  readonly mode: ClientCertificateSource;
  /**
   * Proxy mode: the peers whose forwarded headers are believed.
   *
   * Matched against the *transport* peer — `req.socket.remoteAddress` — and
   * never against `req.ip`. They are different values and the difference is the
   * vulnerability: once `trust proxy` is set, `req.ip` is derived from
   * `X-Forwarded-For`, which is to say from a header the client wrote. Using one
   * client-written header to decide whether to believe another is a check that
   * passes whenever the attacker would like it to.
   */
  readonly trustedProxies: TrustedPeerList;
  /** Lowercased name of the header carrying the certificate. */
  readonly certificateHeader: string;
  /** Lowercased name of the header carrying the terminator's verdict. */
  readonly verifyHeader: string;
  /**
   * The verdict meaning "chain established", compared trimmed and
   * case-insensitively, or `*` for "any non-empty value".
   *
   * `*` exists for the terminators that refuse an unverified client *themselves*
   * and so never report a failure — AWS ALB in `verify` mode is the common one:
   * it drops the connection at the edge and sets its `X-Amzn-Mtls-Clientcert-*`
   * headers only on a client it validated, so the evidence is that the header is
   * there at all. Pointed at such a header, `*` is exactly as strong as an exact
   * match; pointed at anything a client can influence it is worth nothing, which
   * is why it has to be written out rather than inferred from an unset value —
   * the same treatment `CORS_ORIGIN=*` gets.
   */
  readonly verifySuccessValue: string;
}

export interface RequireClientCertificateOptions {
  /** Injected so the validity window is testable without waiting on a clock. */
  readonly now?: () => number;
}

function splitList(value: string): readonly string[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * The settings a policy is built from, as the strings an environment holds them
 * as.
 *
 * Separate from `clientCertificatePolicyFromEnv` for the reason `CorsPolicy` is
 * separate from `corsPolicyFromEnv`: nothing in the construction reads `env`, so
 * a test can state the configuration it is testing — including the two
 * configurations that are *refused* — instead of inheriting one and asserting
 * against a value it did not choose. `env` is frozen, so a test that wanted to
 * vary it could not.
 */
export interface ClientCertificatePolicyInput {
  readonly mode: ClientCertificateSource;
  readonly trustedProxies: string;
  readonly certificateHeader: string;
  readonly verifyHeader: string;
  readonly verifySuccessValue: string;
  readonly allowedCommonNames: string;
  readonly allowedPublicKeyFingerprints: string;
}

/**
 * Builds a policy, and refuses to build an unusable one.
 *
 * Both refusals below are thrown here, at mount time, rather than added to the
 * `env` invariant block where this repository's other cross-field checks live.
 * That is a deliberate exception and the reason is which deployments are
 * affected: `securityHeaders` and `corsMiddleware` are mounted by `createApp`
 * unconditionally, so a contradictory CORS setting is wrong for everyone and
 * belongs in a boot failure. Client-certificate verification is mounted per
 * route subtree by a deployment that wants it, so these two settings mean
 * nothing until someone calls this function — and failing the boot of every
 * deployment that has no mTLS at all, over the default value of a setting it
 * does not use, is how a feature gets reverted instead of configured.
 *
 * What *is* checked at boot is the shape of these values: that every trusted
 * peer parses as an address or a CIDR block, that every pinned fingerprint is
 * 64 hex characters. A malformed entry is a typo in every deployment, so it
 * fails early; an empty list is a typo only in one that mounts this.
 */
export function clientCertificatePolicy(
  input: ClientCertificatePolicyInput,
): ClientCertificatePolicy {
  const mode = input.mode;
  const trustedProxies = TrustedPeerList.parse(input.trustedProxies);

  if (mode === 'proxy' && trustedProxies.size === 0) {
    throw new ClientCertificatePolicyError(
      'MTLS_TRUSTED_PROXIES must name at least one peer when MTLS_MODE=proxy: ' +
        'a forwarded client-certificate header is evidence only if the hop that set it is known, ' +
        'and with no hops listed every request would be refused',
    );
  }

  // The inverse, and it fails just as loudly. In direct mode the headers are
  // never read, so a trusted-peer list here is an operator's belief that
  // forwarded certificates are being accepted from those addresses — and they
  // are not. A setting whose only effect is to be ignored is the one nobody
  // catches.
  if (mode === 'direct' && trustedProxies.size > 0) {
    throw new ClientCertificatePolicyError(
      'MTLS_TRUSTED_PROXIES has no effect when MTLS_MODE=direct: ' +
        'the identity is read from the TLS socket and the forwarded headers are ignored entirely',
    );
  }

  return {
    mode,
    trustedProxies,
    // Lowercased because `req.headers` is keyed by lowercase name, and a
    // deployment that writes `X-Client-Cert` in its environment — which is how
    // every document spells it — would otherwise read a header that is never
    // present and refuse every request for want of a certificate that was sent.
    certificateHeader: input.certificateHeader.trim().toLowerCase(),
    verifyHeader: input.verifyHeader.trim().toLowerCase(),
    verifySuccessValue: input.verifySuccessValue.trim(),
    allowedCommonNames: splitList(input.allowedCommonNames),
    allowedPublicKeyFingerprints: splitList(input.allowedPublicKeyFingerprints),
  };
}

/** The single place the policy and the environment that configures one are joined. */
export function clientCertificatePolicyFromEnv(): ClientCertificatePolicy {
  return clientCertificatePolicy({
    mode: env.MTLS_MODE,
    trustedProxies: env.MTLS_TRUSTED_PROXIES,
    certificateHeader: env.MTLS_CLIENT_CERT_HEADER,
    verifyHeader: env.MTLS_CLIENT_VERIFY_HEADER,
    verifySuccessValue: env.MTLS_CLIENT_VERIFY_SUCCESS,
    allowedCommonNames: env.MTLS_ALLOWED_CLIENT_CNS,
    allowedPublicKeyFingerprints: env.MTLS_ALLOWED_CLIENT_SPKI_SHA256,
  });
}

/**
 * Reads a single-valued header, refusing a repeated one rather than guessing.
 *
 * Node collapses most repeated headers into one comma-joined string, so a
 * duplicate certificate header arrives as two certificates glued together —
 * which is the shape of a terminator that appends instead of overwriting, and
 * the shape of a client that sent its own copy alongside the real one. Both
 * deserve a refusal: there is no reading of "two identities" that is one
 * identity. (The array branch is for the header names Node does keep as a list,
 * so that a future `MTLS_CLIENT_CERT_HEADER=set-cookie` style mistake is a
 * refusal rather than a cast.)
 */
function singleHeader(req: Request, name: string): string | undefined {
  const value = req.headers[name];

  if (value === undefined) return undefined;

  if (Array.isArray(value)) {
    throw new ClientCertificateMalformedError(`the ${name} header was sent more than once`);
  }

  return value;
}

function tlsSocketOf(req: Request): TLSSocket | null {
  // `TLSSocket extends net.Socket`, so this is the downcast the runtime check
  // justifies: a plaintext connection carries a `net.Socket` with no
  // `getPeerCertificate` on it.
  const socket = req.socket as TLSSocket;

  return typeof socket.getPeerCertificate === 'function' ? socket : null;
}

/**
 * Direct mode: the certificate the peer presented on this connection.
 *
 * Presence is checked before `authorized`, which is the opposite of the proxy
 * path and is a fact about Node rather than a preference. A client that
 * presented *nothing* leaves `authorized` false with an `authorizationError` of
 * `UNABLE_TO_GET_ISSUER_CERT` — a message about a chain, for a request that
 * carried no chain. Reading `authorized` first would answer every anonymous
 * request with a refusal that sends its integrator looking for a CA bundle
 * problem they do not have.
 */
function certificateFromSocket(req: Request): X509Certificate {
  const socket = tlsSocketOf(req);

  if (socket === null) {
    throw new ClientCertificateTransportError();
  }

  const peerCertificate = socket.getPeerCertificate(true);
  // `getPeerCertificate` answers `{}` when the peer presented nothing, which is
  // the one state the type does not describe: `raw` is declared non-optional and
  // is simply absent on that object. Hence a runtime check rather than a `!`.
  const der: Buffer | undefined = peerCertificate.raw;

  if (der === undefined || der.length === 0) {
    throw new ClientCertificateRequiredError();
  }

  if (!socket.authorized) {
    throw new ClientCertificateNotVerifiedError(
      socket.authorizationError?.message ?? 'the chain could not be established',
    );
  }

  return parseCertificate(der);
}

/** Proxy mode: the certificate the terminator says it verified. */
function certificateFromHeaders(policy: ClientCertificatePolicy, req: Request): X509Certificate {
  const peer = req.socket.remoteAddress;

  // No peer address means a socket already gone, or a transport that has none.
  // Either way the hop cannot be established, and the hop is the entire basis
  // for believing the headers.
  if (peer === undefined || !policy.trustedProxies.contains(peer)) {
    throw new ClientCertificateUntrustedHopError();
  }

  const verdict = singleHeader(req, policy.verifyHeader);

  // A missing verdict header is not treated as success. It is the shape of a
  // terminator that was configured to forward the certificate and not the
  // verdict, and accepting it would mean accepting any certificate a client
  // chose to generate — which is precisely what optional verification lets
  // through.
  if (verdict === undefined) {
    throw new ClientCertificateNotVerifiedError(
      `the terminator sent no ${policy.verifyHeader} header`,
    );
  }

  const reported = verdict.trim();
  const accepted =
    policy.verifySuccessValue === '*'
      ? reported.length > 0
      : reported.toLowerCase() === policy.verifySuccessValue.toLowerCase();

  if (!accepted) {
    // nginx answers `NONE` when the client presented nothing and `FAILED:<why>`
    // when it presented something that did not validate, so the verdict is
    // quoted back: those are the terminator's own words and the fastest route
    // to the cause.
    throw new ClientCertificateNotVerifiedError(
      reported.length === 0
        ? `the ${policy.verifyHeader} header was empty`
        : `the terminator reported "${reported}"`,
    );
  }

  const forwarded = singleHeader(req, policy.certificateHeader);

  if (forwarded === undefined) {
    throw new ClientCertificateRequiredError();
  }

  return parseCertificate(decodeForwardedCertificate(forwarded));
}

/**
 * Refuses any request that does not carry an authorised client certificate, and
 * publishes the identity of one that does on `req.clientCertificate`.
 *
 * Mounted on the subtree that needs it rather than globally — a service-to-service
 * route, an admin surface, a payment callback — because a client certificate
 * answers "which of our own systems is calling", and mounting it over an API
 * that also serves browsers and bearer tokens refuses all of them. See
 * `docs/mtls.md` for where to put it and what the terminator has to be doing
 * for it to mean anything.
 */
export function requireClientCertificate(
  policy: ClientCertificatePolicy,
  options: RequireClientCertificateOptions = {},
): RequestHandler {
  const now = options.now ?? Date.now;

  return (req: Request, _res: Response, next: NextFunction): void => {
    try {
      const certificate =
        policy.mode === 'direct' ? certificateFromSocket(req) : certificateFromHeaders(policy, req);

      const validity = certificateValidity(certificate, now());

      if (validity !== 'valid') {
        throw new ClientCertificateOutsideValidityError(validity, validityWindowOf(certificate));
      }

      const identity = identityOf(certificate, policy.mode);

      if (!isIdentityAuthorized(policy, identity)) {
        // The subject rather than the common name when there is no single
        // common name: a certificate carrying two CNs is refused here, and a
        // refusal naming neither of them is one nobody can act on. Newlines
        // flattened because this ends up in a JSON message.
        throw new ClientCertificateForbiddenError(
          identity.commonName ?? identity.subject.split('\n').join(', '),
        );
      }

      req.clientCertificate = identity;

      next();
    } catch (error) {
      // Every refusal above is thrown rather than written, so the response is
      // rendered by `errorMiddleware` with the correlation id and the shape every
      // other refusal in this service has. A middleware is synchronous here, so
      // `next(error)` and `throw` would behave identically — the `try` is for the
      // reader, making it explicit that nothing in this function writes a
      // response itself.
      next(error);
    }
  };
}

/**
 * The server-side half of direct mode: the TLS options that make a client
 * certificate requested, checked, and *not* a handshake failure.
 *
 * Lives next to the middleware because the two are one decision and a reader has
 * to see both halves at once. `rejectUnauthorized: false` in isolation looks
 * like the worst line in any TLS configuration — it is the line that disables
 * verification in every blog post about it — and here it does not disable
 * anything, because `requireClientCertificate` is what enforces the verdict.
 * Split across two files, somebody eventually mounts the listener without the
 * middleware, or deletes the middleware and keeps the listener, and the service
 * then accepts every self-signed certificate in the world. The pairing is the
 * contract:
 *
 * ```ts
 * https.createServer(
 *   { key, cert, ...clientCertificateTlsOptions(caBundlePem) },
 *   createApp(),
 * );
 * ```
 *
 * `requestCert: true` asks for a certificate. `rejectUnauthorized: false` lets
 * the handshake finish when the client sends a bad one or none, so the refusal
 * can be an HTTP response — see the header of this file. `ca` replaces Node's
 * bundled public roots: a client CA list that still trusts the public web means
 * any certificate from any public issuer authenticates, which is not mutual
 * authentication but a very expensive way of accepting everyone.
 */
export function clientCertificateTlsOptions(caBundlePem: string | readonly string[]): {
  requestCert: true;
  rejectUnauthorized: false;
  ca: string | string[];
} {
  return {
    requestCert: true,
    rejectUnauthorized: false,
    // Copied rather than passed through, because `tls` keeps the array it is
    // given and a frozen or later-mutated bundle is not a thing to hand a
    // listener.
    ca: typeof caBundlePem === 'string' ? caBundlePem : [...caBundlePem],
  };
}
