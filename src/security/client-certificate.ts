import { createHash, X509Certificate } from 'node:crypto';
import { ClientCertificateMalformedError } from '@/security/mtls.errors';

/**
 * Where the certificate this identity was built from came from.
 *
 * Carried on the identity rather than inferred by a reader, because the two
 * sources carry different evidence and a handler that logs or audits an mTLS
 * call should be able to say which: in `direct` mode this process validated the
 * chain itself, and in `proxy` mode it is relaying an edge's verdict.
 */
export type ClientCertificateSource = 'direct' | 'proxy';

/**
 * The checked identity of a client, published on the request.
 *
 * Flat strings, deliberately: an `X509Certificate` is a live handle with a
 * `publicKey`, a `verify()` and an `issuerCertificate` chain, and handing one to
 * a route handler invites a second, ad-hoc verification somewhere downstream
 * that disagrees with this one. What a handler needs is the answer.
 */
export interface ClientCertificateIdentity {
  /** The subject DN as the certificate spells it, newline-separated RDNs. */
  readonly subject: string;
  /** The single `CN` of the subject, or `null` — see `commonNameOf`. */
  readonly commonName: string | null;
  readonly issuer: string;
  /** Uppercase hex, as the certificate carries it. */
  readonly serialNumber: string;
  /** `subjectAltName` entries, each still carrying its type prefix. */
  readonly subjectAltNames: readonly string[];
  /** SHA-256 over the SubjectPublicKeyInfo, lowercase hex, no separators. */
  readonly publicKeyFingerprintSha256: string;
  /** SHA-256 over the whole certificate, lowercase hex, no separators. */
  readonly certificateFingerprintSha256: string;
  readonly validFrom: string;
  readonly validTo: string;
  readonly source: ClientCertificateSource;
}

const PEM_BLOCK = /-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/g;
const BASE64_BODY = /^[A-Za-z0-9+/=]+$/;

function wrapPem(base64: string): string {
  const lines: string[] = [];

  for (let offset = 0; offset < base64.length; offset += 64) {
    lines.push(base64.slice(offset, offset + 64));
  }

  return `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----\n`;
}

/**
 * Turns the value of a forwarded certificate header back into a PEM.
 *
 * There is no standard for this header, so there is no standard encoding for it
 * either — and the reason this function exists rather than the value being
 * passed straight to `X509Certificate` is that a PEM cannot travel in an HTTP
 * header unaltered: a header value holds no newlines. Every terminator solves
 * that differently and all four of these are in production somewhere:
 *
 *   - **percent-encoded PEM** — nginx's `$ssl_client_escaped_cert` and AWS ALB's
 *     `X-Amzn-Mtls-Clientcert`. The common case, and the only one that is
 *     lossless by construction.
 *   - **PEM with the newlines replaced by spaces**, or folded onto continuation
 *     lines, which is what older configurations using nginx's unescaped
 *     `$ssl_client_cert` produce.
 *   - **bare base64 DER**, no armour, from terminators that forward the
 *     certificate as a blob.
 *
 * Whitespace inside the armour is unambiguously framing and never data — the
 * base64 alphabet contains no whitespace — so re-wrapping the body canonically
 * is a decoding step and not a guess. The one thing this function will not do is
 * repair a *truncated* certificate: a header cut off at a proxy's size limit
 * decodes to base64 that parses as nothing, and the refusal says so rather than
 * presenting half an identity.
 *
 * ## Exactly one certificate, or nothing
 *
 * More than one PEM block is refused, which costs the deployment that forwards
 * a whole chain and buys the one that matters. Two blocks in this header have
 * two readings and no way to tell them apart:
 *
 *   - a chain, leaf first, from a terminator configured to forward what it
 *     verified;
 *   - **two headers**, which Node presents as one comma-joined value — the shape
 *     produced when a terminator *adds* its header instead of overwriting it and
 *     the client sent one of its own. There the client's value arrives first,
 *     so "take the leaf" means "take the forgery".
 *
 * Taking the first block is correct for the first reading and a privilege
 * escalation in the second, and nothing in the string says which one this is. So
 * the rule is that the terminator forwards one certificate: nginx's
 * `$ssl_client_escaped_cert` already does, and a terminator that sends a chain
 * has a leaf-only variant or an `ssl_client_s_dn` next to it. Requiring that is a
 * line of proxy configuration; the alternative is a header whose worst case is
 * an identity the client chose. See `docs/mtls.md`.
 */
export function decodeForwardedCertificate(raw: string): string {
  const trimmed = raw.trim();

  if (trimmed.length === 0) {
    throw new ClientCertificateMalformedError('the header was empty');
  }

  let decoded = trimmed;

  if (trimmed.includes('%')) {
    try {
      decoded = decodeURIComponent(trimmed);
    } catch {
      // `decodeURIComponent` throws `URIError` on a stray `%`, which is what a
      // header truncated mid-escape looks like.
      throw new ClientCertificateMalformedError('the header is not valid percent-encoding');
    }
  }

  // `matchAll` and not `exec`, because the count is the check: the regex is
  // global, so a single `exec` would answer the first of several and leave the
  // ambiguity above unexamined.
  const blocks = [...decoded.matchAll(PEM_BLOCK)];

  if (blocks.length > 1) {
    throw new ClientCertificateMalformedError(
      `the header carries ${blocks.length} certificates and must carry exactly one`,
    );
  }

  const block = blocks[0];
  const body = (block?.[1] ?? decoded).replace(/\s+/g, '');

  if (!BASE64_BODY.test(body) || body.length % 4 !== 0) {
    throw new ClientCertificateMalformedError(
      block === undefined
        ? 'the header is neither a PEM certificate nor base64-encoded DER'
        : 'the PEM body is not valid base64',
    );
  }

  return wrapPem(body);
}

/**
 * Parses a PEM or DER certificate, turning every failure into one refusal.
 *
 * `X509Certificate` throws an OpenSSL error whose message is written for
 * somebody debugging OpenSSL, and letting it escape means a 500 for a request
 * whose only problem is a bad header.
 */
export function parseCertificate(input: string | Buffer): X509Certificate {
  try {
    return new X509Certificate(input);
  } catch {
    throw new ClientCertificateMalformedError('it could not be parsed as X.509');
  }
}

/**
 * The relative distinguished names of a DN as `[attribute, value]` pairs.
 *
 * Node renders a DN as newline-separated `K=V` lines, escaping any newline or
 * backslash inside a value — which is what makes line-splitting safe here and
 * what made it unsafe before Node 18, where a value containing a newline could
 * forge an extra RDN. A line without `=` is dropped rather than guessed at.
 */
function relativeDistinguishedNames(dn: string): readonly [string, string][] {
  const pairs: [string, string][] = [];

  for (const line of dn.split('\n')) {
    const separator = line.indexOf('=');

    if (separator <= 0) continue;

    pairs.push([line.slice(0, separator).trim(), line.slice(separator + 1).trim()]);
  }

  return pairs;
}

/**
 * The subject's `CN`, or `null` when there is not exactly one.
 *
 * Zero is ordinary — a certificate whose identity lives entirely in its SANs has
 * no CN at all, which is where the web PKI has been heading for a decade.
 *
 * More than one is the interesting case, and answering `null` for it is a
 * decision rather than an omission. A DN may carry repeated attributes, so
 * `CN=svc-reporting, CN=svc-admin` is a legal subject; a reader that takes the
 * first and an allowlist that takes the last then disagree about who is calling,
 * and anybody able to get a certificate issued with two CNs picks which of the
 * two a given component believes. There is no answer here that is right for both
 * readers, so this reports that there is no single common name and the caller
 * refuses — a certificate with two names is not an identity.
 */
export function commonNameOf(dn: string): string | null {
  const commonNames = relativeDistinguishedNames(dn)
    .filter(([attribute]) => attribute === 'CN')
    .map(([, value]) => value);

  return commonNames.length === 1 ? (commonNames[0] ?? null) : null;
}

/**
 * The `subjectAltName` entries, type prefixes intact.
 *
 * Kept as `DNS:svc-ingest.clients.example.test` rather than split into typed
 * buckets because this is for the audit record and for a handler that wants to
 * read them. Authorisation does not consult them: a SAN allowlist needs
 * per-type comparison rules (`checkHost` for DNS, `checkIP` for addresses) and
 * a string allowlist that compares `DNS:` entries by equality is the kind of
 * half-measure that looks like it works until somebody writes a wildcard in it.
 */
export function subjectAltNamesOf(certificate: X509Certificate): readonly string[] {
  const san = certificate.subjectAltName;

  if (san === undefined || san.trim().length === 0) return [];

  return san
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * SHA-256 over the SubjectPublicKeyInfo, lowercase hex.
 *
 * The public key and not the certificate, which is the whole point of pinning on
 * this rather than on `fingerprint256`: a certificate fingerprint changes on
 * every renewal, including the routine ones where the key never moved, so a
 * deployment pinned on it has an outage scheduled for the day its client's
 * certificate is reissued. An SPKI pin survives renewal and breaks on exactly
 * the event it should break on — a different key.
 */
export function publicKeyFingerprintSha256(certificate: X509Certificate): string {
  const spki = certificate.publicKey.export({ type: 'spki', format: 'der' });

  return createHash('sha256').update(spki).digest('hex');
}

function normaliseFingerprint(value: string): string {
  return value.replace(/:/g, '').trim().toLowerCase();
}

export type CertificateValidityState = 'valid' | 'not-yet-valid' | 'expired';

/**
 * Where `nowMs` sits relative to the certificate's own validity window.
 *
 * The clock is a parameter because this is the only check in the module with a
 * clock in it, and a test for "expired" that has to wait is a test nobody keeps.
 */
export function certificateValidity(
  certificate: X509Certificate,
  nowMs: number,
): CertificateValidityState {
  if (nowMs < certificate.validFromDate.getTime()) return 'not-yet-valid';
  if (nowMs > certificate.validToDate.getTime()) return 'expired';

  return 'valid';
}

/** The validity window, for a refusal message. */
export function validityWindowOf(certificate: X509Certificate): string {
  return `${certificate.validFrom} to ${certificate.validTo}`;
}

/** Flattens a verified certificate into the record handlers and audits read. */
export function identityOf(
  certificate: X509Certificate,
  source: ClientCertificateSource,
): ClientCertificateIdentity {
  return {
    subject: certificate.subject,
    commonName: commonNameOf(certificate.subject),
    issuer: certificate.issuer,
    serialNumber: certificate.serialNumber,
    subjectAltNames: subjectAltNamesOf(certificate),
    publicKeyFingerprintSha256: publicKeyFingerprintSha256(certificate),
    certificateFingerprintSha256: normaliseFingerprint(certificate.fingerprint256),
    validFrom: certificate.validFrom,
    validTo: certificate.validTo,
    source,
  };
}

/**
 * Which verified identities this deployment authorises.
 *
 * Separate from chain validity because the two answer different questions, and
 * conflating them is the standard mTLS failure: a valid chain says "issued by a
 * CA we trust", which — where that CA is an organisation-wide or public one — is
 * a property shared with every other certificate it has ever issued. Anybody
 * holding any certificate from the same issuer is then authenticated as
 * somebody, and if nothing else is checked, authorised as well.
 */
export interface ClientCertificateAuthorizationPolicy {
  /** Subject common names allowed through, compared exactly. */
  readonly allowedCommonNames: readonly string[];
  /** SPKI SHA-256 fingerprints allowed through; separators and case ignored. */
  readonly allowedPublicKeyFingerprints: readonly string[];
}

/**
 * Whether `identity` is authorised under `policy`.
 *
 * ## Both lists empty means any verified certificate
 *
 * Which is the right behaviour for the deployment whose trust anchor is a
 * private CA that issues to this service's clients and to nothing else — there
 * the chain *is* the allowlist, and a second list to maintain adds a way to
 * break a rollout and no security. It is the wrong behaviour everywhere else,
 * and the distinction is not something this code can see, so it is left where
 * the deployment states it: two empty lists in the environment, explained there,
 * exactly as `CORS_ORIGIN=*` is a decision recorded rather than a default
 * stumbled into.
 *
 * ## The lists are OR-ed
 *
 * They are two handles on the same decision — a name for the common case and a
 * key for the case where a name is not enough — so an operator who pins a key
 * does not also have to list the CN that key happens to be issued under today.
 * An identity matching either list is authorised. If a deployment needs *both*
 * to hold, that is a narrower policy than this expresses: pin the key and leave
 * the name list empty, which is the same guarantee with one fewer thing to keep
 * in step.
 */
export function isIdentityAuthorized(
  policy: ClientCertificateAuthorizationPolicy,
  identity: ClientCertificateIdentity,
): boolean {
  if (policy.allowedCommonNames.length === 0 && policy.allowedPublicKeyFingerprints.length === 0) {
    return true;
  }

  // Exact comparison, for the reason `isOriginAllowed` compares origins exactly:
  // every allowlist hole worth having is a suffix or substring match, and a
  // deployment that needs a pattern lists the identities it means.
  if (identity.commonName !== null && policy.allowedCommonNames.includes(identity.commonName)) {
    return true;
  }

  return policy.allowedPublicKeyFingerprints
    .map(normaliseFingerprint)
    .includes(identity.publicKeyFingerprintSha256);
}
