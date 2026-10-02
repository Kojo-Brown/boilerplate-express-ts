import { AppError } from '@/lib/errors';

/**
 * The ways `requireClientCertificate` can refuse a request.
 *
 * All `AppError` subclasses, so the translator registry renders them and nothing
 * has to be registered — see `lib/error-translators.ts`.
 *
 * ## Why these are HTTP refusals at all
 *
 * A client certificate is checked during a TLS handshake, and a handshake that
 * fails ends in a TLS alert: no status code, no body, no correlation id, nothing
 * in the access log but a socket that closed. For a *browser* that is the right
 * outcome. For a machine client it is close to undebuggable — the integrator
 * sees `ECONNRESET` or `SSL alert number 48` and cannot tell an expired
 * certificate from the wrong CA from a certificate nobody authorised.
 *
 * So both deployment shapes are arranged to let the handshake complete and to
 * refuse in HTTP instead (`requestCert: true` with `rejectUnauthorized: false`
 * when this process terminates TLS; `ssl_verify_client optional` or its
 * equivalent when an edge does). The verdict is then an ordinary refusal that
 * carries a code, a message and the correlation id of the request it belongs to.
 * See `docs/mtls.md`.
 *
 * ## What these messages are allowed to say
 *
 * Everything below is a fact about the certificate the caller itself presented,
 * or about the connection the caller itself opened. Nothing in a refusal depends
 * on a secret this service holds, and nothing distinguishes a certificate that
 * *exists* from one that does not — the subject allowlist answers one code for
 * every certificate it does not name, so probing it reveals only that the
 * presented identity is not on it, which the holder of that identity learns from
 * the first request either way.
 *
 * The one place that is deliberately vaguer than it could be is
 * `ClientCertificateForbiddenError`, which does not echo the allowlist.
 */

/**
 * No certificate was presented.
 *
 * 401 and not 403: nothing was offered, so nothing was rejected, and
 * `WWW-Authenticate` is the header that distinguishes the two in every other
 * part of this API.
 */
export class ClientCertificateRequiredError extends AppError {
  constructor() {
    super(
      401,
      'This endpoint requires a client certificate and none was presented',
      'CLIENT_CERT_REQUIRED',
    );
    this.name = 'ClientCertificateRequiredError';
  }
}

/**
 * Direct mode, and the request did not arrive over TLS at all.
 *
 * 401 rather than the 500 a configuration error would normally earn, because
 * this middleware cannot tell the two readings apart: either the listener was
 * built without `requestCert` (a deployment mistake) or something is reaching
 * the process on a plaintext port that was never meant to serve this route (the
 * interesting one). Both answers have to be "not authenticated" — a 500 here
 * would turn a security control into an availability report, and there is no
 * third behaviour available that does not involve serving the route.
 */
export class ClientCertificateTransportError extends AppError {
  constructor() {
    super(
      401,
      'This endpoint requires a mutually authenticated TLS connection',
      'CLIENT_CERT_NO_TLS',
    );
    this.name = 'ClientCertificateTransportError';
  }
}

/**
 * Proxy mode, and the connection this request arrived on is not a hop whose
 * forwarded certificate headers are believed.
 *
 * The most important refusal in the file. In proxy mode the client's identity is
 * a *header*, and a header is worth precisely as much as the connection that
 * carried it: anything able to open a socket to this process can set
 * `X-Client-Cert` to a certificate it copied out of a public log. The only thing
 * that makes the header meaningful is that the immediate peer is the terminator
 * that performed the handshake and that overwrites the header on every request.
 *
 * Also 401, and for the same reason as `ClientCertificateTransportError`: a
 * request from an unexpected peer is either a misrouted deployment or a forgery
 * attempt, this code cannot tell which, and both are unauthenticated.
 */
export class ClientCertificateUntrustedHopError extends AppError {
  constructor() {
    super(
      401,
      'This endpoint does not accept forwarded client-certificate headers from this peer',
      'CLIENT_CERT_UNTRUSTED_HOP',
    );
    this.name = 'ClientCertificateUntrustedHopError';
  }
}

/**
 * A certificate was presented and the chain was not established.
 *
 * In direct mode that is `TLSSocket.authorized === false`, and `reason` is
 * Node's own `authorizationError` — `UNABLE_TO_GET_ISSUER_CERT`,
 * `CERT_HAS_EXPIRED`, `SELF_SIGNED_CERT_IN_CHAIN`. In proxy mode it is the
 * terminator's verdict header saying anything other than success, which is the
 * case that exists because `optional` verification *forwards the certificate
 * anyway*: nginx with `ssl_verify_client optional` fills
 * `$ssl_client_escaped_cert` from a certificate it could not validate and
 * records the fact only in `$ssl_client_verify`. A receiver that reads the
 * certificate header and not the verdict header accepts any self-signed
 * certificate a client cares to generate.
 */
export class ClientCertificateNotVerifiedError extends AppError {
  constructor(reason: string) {
    super(
      401,
      `The presented client certificate was not verified: ${reason}`,
      'CLIENT_CERT_NOT_VERIFIED',
    );
    this.name = 'ClientCertificateNotVerifiedError';
  }
}

/**
 * The certificate header was present but could not be read as a certificate.
 *
 * 400 rather than 401, on the same rule the webhook signature errors follow:
 * 401 is a claim that a credential was offered and rejected, and nothing here
 * was rejected, because nothing here was parseable enough to check. A terminator
 * that mangles the PEM — folding its newlines, forwarding it unescaped, trimming
 * it at a header size limit — is the usual cause, and a 400 is what points at
 * the terminator rather than at the client.
 */
export class ClientCertificateMalformedError extends AppError {
  constructor(reason: string) {
    super(400, `The client certificate could not be read: ${reason}`, 'CLIENT_CERT_MALFORMED');
    this.name = 'ClientCertificateMalformedError';
  }
}

/**
 * The certificate is outside its own validity window as this process reads the
 * clock.
 *
 * Checked in both modes even though both terminators check it too, which is not
 * redundancy for its own sake:
 *
 *   - in proxy mode the only evidence is the verdict header, which says the
 *     certificate was valid *at the edge*, possibly minutes ago and against a
 *     clock this process has no view of;
 *   - in direct mode Node checked it during the handshake, and a keep-alive
 *     connection outlives the handshake — a certificate that expires mid-session
 *     keeps serving requests on an already-authorised socket until the client
 *     reconnects.
 *
 * `notBefore` is as real a failure as `notAfter` and nearly always means a newly
 * issued certificate being rolled out by a fleet whose clocks disagree, so the
 * two are distinguished in the message and not in the code.
 */
export class ClientCertificateOutsideValidityError extends AppError {
  constructor(state: 'not-yet-valid' | 'expired', window: string) {
    super(
      401,
      state === 'expired'
        ? `The presented client certificate expired (valid ${window})`
        : `The presented client certificate is not valid yet (valid ${window})`,
      'CLIENT_CERT_OUTSIDE_VALIDITY',
    );
    this.name = 'ClientCertificateOutsideValidityError';
  }
}

/**
 * The certificate is valid and the identity it carries is not one this
 * deployment authorises.
 *
 * 403, and it is the only refusal here that is: authentication succeeded. A
 * chain that validates proves the certificate was issued by a CA this deployment
 * trusts, and nothing more — which matters most where the trust anchor is a
 * public or organisation-wide CA, because then "the chain is valid" is a
 * property shared by every certificate that CA has ever issued, including ones
 * issued to somebody else entirely.
 *
 * Deliberately does not echo the allowlist, and this is the one place in the file
 * worth being vague: the subject names of a deployment's internal service fleet
 * are a map of that fleet, handed out at an endpoint reachable by anyone holding
 * any certificate from the same CA. Which identity was presented is in this
 * service's logs, where the operator can read it against the configuration.
 */
export class ClientCertificateForbiddenError extends AppError {
  constructor(subject: string) {
    super(
      403,
      `The client certificate for "${subject}" is not authorised for this endpoint`,
      'CLIENT_CERT_FORBIDDEN',
    );
    this.name = 'ClientCertificateForbiddenError';
  }
}

/**
 * The policy itself is unusable, raised where the policy is built rather than
 * where a request is served.
 *
 * A plain `Error` and not an `AppError`, because there is no request to answer:
 * this is thrown by `clientCertificatePolicyFromEnv()` at mount time, which is
 * module evaluation, so the process fails to start exactly the way an invalid
 * `env` does. The alternative — a middleware that discovers at request time that
 * it cannot enforce anything — has two outcomes and both are bad: refuse every
 * request (an outage, discovered in production) or allow them (a control that
 * was never on).
 */
export class ClientCertificatePolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClientCertificatePolicyError';
  }
}
