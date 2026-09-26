import { createHash, createHmac, timingSafeEqual } from 'crypto';
import { WebhookSignatureMalformedError } from '@/webhooks/webhooks.errors';

/**
 * The wire format, and the string that actually gets signed.
 *
 * Everything in this file is pure and synchronous: no clock, no configuration,
 * no `Request`. That is what lets the same three functions serve both
 * directions — `sign-request.ts` builds a header with them and
 * `verify-signature.middleware.ts` rebuilds the candidate with them — which is
 * the only way the two sides cannot drift. A signing scheme with one
 * implementation for signing and another for verifying has a second scheme
 * hiding in it, and the first delivery that fails is the first anyone finds out.
 */

/**
 * `X-Webhook-Signature`.
 *
 * `X-`-prefixed against RFC 6648's advice, and deliberately: every deployed
 * webhook scheme uses one (`Stripe-Signature`, `X-Hub-Signature-256`,
 * `X-Slack-Signature`), the header is namespaced to this application rather than
 * standard, and the alternative — claiming a bare name like `Signature`, which
 * RFC 9421 has since taken for a different and incompatible construction — is
 * the reading that actually causes a collision.
 */
export const WEBHOOK_SIGNATURE_HEADER = 'x-webhook-signature';

/**
 * The scheme version, which is both the `v1=` parameter name and the first line
 * of the signed string.
 *
 * Inside the signed bytes as well as outside them on purpose. A version that
 * appears only in the header is a version an attacker can rewrite: present a
 * `v1` digest as `v2` once `v2` exists and means something laxer, and the
 * receiver validates it under the wrong rules. Signed, the version is part of
 * what the secret attests to, so a `v1` signature can only ever be read as a
 * `v1` signature. This is the same reasoning that puts the algorithm inside
 * `@/crypto`'s envelope header rather than beside it.
 */
export const WEBHOOK_SIGNATURE_VERSION = 'v1';

/** Length of a hex SHA-256 digest, which is the only shape a `v1` digest has. */
const DIGEST_HEX_LENGTH = 64;

const HEX_PATTERN = /^[0-9a-f]+$/;
const UNSIGNED_INTEGER_PATTERN = /^[0-9]{1,15}$/;

/**
 * The charset and length a nonce may use.
 *
 * Restricted to the header's parameter alphabet so the parser can stay a split
 * on `,` and `=` rather than a grammar, and floored at 16 characters because a
 * nonce's whole job is to be unique across the window — `randomUUID()`'s 32 hex
 * digits are what `signWebhookRequest` actually produces. Capped because the
 * receiver stores it: an unbounded nonce is an unbounded row in the replay
 * cache, chosen by the sender.
 */
const NONCE_PATTERN = /^[A-Za-z0-9_.-]{16,64}$/;

/** The parts of a request that the signature covers. */
export interface WebhookSigningParts {
  /** Unix seconds. Signed, so the window check cannot be bypassed by editing it. */
  readonly timestamp: number;
  /** Single-use value; see `NONCE_PATTERN` and `ReplayGuard`. */
  readonly nonce: string;
  /** Uppercased by `canonicalRequest`; `POST` for every delivery this repo sends. */
  readonly method: string;
  /**
   * The request target as the *receiver* sees it — path plus query string,
   * origin-form, e.g. `/v1/webhooks/inbound?source=billing`.
   *
   * Covered by the signature so one captured delivery cannot be replayed against
   * a different endpoint that happens to share the secret. That is a real attack
   * and not a theoretical one: a receiver with a `/refunds` and a `/notes`
   * webhook under one secret, and a signature that names neither, has two
   * endpoints that accept each other's traffic.
   *
   * It is also the field with an operational cost, and it is worth being blunt
   * about it: a reverse proxy that rewrites the path — strips a prefix, adds a
   * tenant segment, normalises a trailing slash — makes the receiver rebuild a
   * different string than the sender signed, and every delivery fails
   * verification with nothing in either log to suggest the path is why. See
   * `docs/webhook-signing.md`, which says what to check first.
   */
  readonly target: string;
  /** The exact bytes of the body, before any parsing. */
  readonly body: Buffer;
}

/** A signature header taken apart. Nothing here has been verified yet. */
export interface ParsedWebhookSignature {
  readonly timestamp: number;
  readonly nonce: string;
  readonly keyId: string;
  /** Lowercase hex, `DIGEST_HEX_LENGTH` characters. */
  readonly digest: string;
}

/**
 * `sha256(body)` as lowercase hex.
 *
 * The body is hashed rather than concatenated into the signed string, which is
 * what keeps that string a text protocol: a body may be any bytes at all,
 * including the newline the canonical form uses as its separator, and a raw
 * body spliced in directly would let a crafted payload move the field
 * boundaries. Hashing first pins the body's contribution to 64 hex characters
 * that cannot contain a separator.
 */
export function bodyDigest(body: Buffer): string {
  return createHash('sha256').update(body).digest('hex');
}

/**
 * The exact string the HMAC is taken over.
 *
 * Newline-separated and fixed-arity, and every field's alphabet excludes the
 * separator: the version and the digests are hex, the timestamp is digits, the
 * nonce is `NONCE_PATTERN`, the method is uppercased ASCII, and the target is
 * checked below. That is what makes the encoding unambiguous, which is not a
 * stylistic point — a canonicalisation where two different requests can produce
 * one signed string is a canonicalisation where a signature transfers between
 * them, and every field-splitting attack on a signing scheme is that bug.
 */
export function canonicalRequest(parts: WebhookSigningParts): string {
  const { timestamp, nonce, method, target, body } = parts;

  if (!Number.isInteger(timestamp) || timestamp < 0) {
    throw new WebhookSignatureMalformedError(
      `timestamp must be a non-negative integer number of unix seconds, got ${String(timestamp)}`,
    );
  }
  if (!NONCE_PATTERN.test(nonce)) {
    throw new WebhookSignatureMalformedError(
      'nonce must be 16-64 characters of [A-Za-z0-9_.-]',
    );
  }
  // Node's HTTP parser rejects a request target containing a newline long before
  // a handler sees it, so on the verifying side this is unreachable. It is here
  // for the signing side, where the target is a string some caller built, and
  // because "unreachable given the current parser" is the kind of premise that
  // stops being true one dependency upgrade later. Cheap, and it is the check
  // the paragraph above depends on.
  if (/[\r\n]/.test(target)) {
    throw new WebhookSignatureMalformedError('target must not contain CR or LF');
  }

  return [
    WEBHOOK_SIGNATURE_VERSION,
    String(timestamp),
    nonce,
    method.toUpperCase(),
    target,
    bodyDigest(body),
  ].join('\n');
}

/** HMAC-SHA256 of the canonical string under `secret`, as lowercase hex. */
export function computeDigest(secret: Buffer, canonical: string): string {
  return createHmac('sha256', secret).update(canonical, 'utf8').digest('hex');
}

/**
 * The header value for a set of parts signed under one ring entry.
 *
 * Parameter order is `t,n,kid,v1` and the parser does not care, but emitting it
 * consistently means a captured header diffs cleanly against a rebuilt one,
 * which is most of what debugging this feature consists of.
 */
export function formatSignatureHeader(signature: ParsedWebhookSignature): string {
  const { timestamp, nonce, keyId, digest } = signature;
  return `t=${timestamp},n=${nonce},kid=${keyId},${WEBHOOK_SIGNATURE_VERSION}=${digest}`;
}

/**
 * Take a header value apart, or throw `WebhookSignatureMalformedError`.
 *
 * Unknown parameters are ignored rather than rejected, which is the one piece of
 * laxness in here and is what makes the format extensible: a later scheme that
 * adds a parameter can be rolled out to senders before receivers understand it,
 * which is the same two-phase argument the secret ring exists for. A *repeated*
 * parameter is rejected, because "last one wins" over a signature field is how a
 * header-smuggling bug gets in — the proxy, the sender's library and this parser
 * would each be entitled to a different reading of which value counted.
 *
 * Note what is deliberately not here: a check of `keyId` against the ring, and
 * any comparison of `digest`. This function establishes only that a signature
 * was *presented*. Everything that depends on a secret happens in the middleware,
 * in one place, after the window check.
 */
export function parseSignatureHeader(raw: string): ParsedWebhookSignature {
  const parameters = new Map<string, string>();

  for (const field of raw.split(',')) {
    const trimmed = field.trim();
    if (trimmed.length === 0) continue;

    const separator = trimmed.indexOf('=');
    if (separator <= 0) {
      throw new WebhookSignatureMalformedError(
        'every field must be "<name>=<value>"; expected ' +
          `t=<unix-seconds>,n=<nonce>,kid=<key-id>,${WEBHOOK_SIGNATURE_VERSION}=<hex-digest>`,
      );
    }

    const name = trimmed.slice(0, separator);
    if (parameters.has(name)) {
      throw new WebhookSignatureMalformedError(`field "${name}" appears more than once`);
    }
    parameters.set(name, trimmed.slice(separator + 1));
  }

  const rawTimestamp = parameters.get('t');
  const nonce = parameters.get('n');
  const keyId = parameters.get('kid');
  const digest = parameters.get(WEBHOOK_SIGNATURE_VERSION);

  for (const [name, value] of [
    ['t', rawTimestamp],
    ['n', nonce],
    ['kid', keyId],
    [WEBHOOK_SIGNATURE_VERSION, digest],
  ] as const) {
    if (value === undefined) {
      throw new WebhookSignatureMalformedError(`field "${name}" is missing`);
    }
  }
  // Narrowed by the loop above; TypeScript cannot see through it, and the
  // alternative is four near-identical `if` blocks saying the same sentence.
  if (
    rawTimestamp === undefined ||
    nonce === undefined ||
    keyId === undefined ||
    digest === undefined
  ) {
    throw new WebhookSignatureMalformedError('a required field is missing');
  }

  if (!UNSIGNED_INTEGER_PATTERN.test(rawTimestamp)) {
    // Rejected as a *string* before `Number` sees it, because `Number` is far
    // too accommodating for a signed field: it reads ' 42 ', '4e1', '0x2a' and
    // '+42' as numbers, all of which would then be re-serialised by
    // `canonicalRequest` as '42' and verify against a digest over a string the
    // sender never sent. One spelling per value is the only way the round trip
    // is lossless.
    throw new WebhookSignatureMalformedError(
      `field "t" must be unix seconds as plain digits, got "${rawTimestamp}"`,
    );
  }
  if (!NONCE_PATTERN.test(nonce)) {
    throw new WebhookSignatureMalformedError('field "n" must be 16-64 characters of [A-Za-z0-9_.-]');
  }
  if (digest.length !== DIGEST_HEX_LENGTH || !HEX_PATTERN.test(digest)) {
    throw new WebhookSignatureMalformedError(
      `field "${WEBHOOK_SIGNATURE_VERSION}" must be ${DIGEST_HEX_LENGTH} lowercase hex characters`,
    );
  }

  return { timestamp: Number(rawTimestamp), nonce, keyId, digest };
}

/**
 * Whether two hex digests are equal, in time that does not depend on *where*
 * they first differ.
 *
 * `a === b` on strings is the bug this function exists to avoid. It short-circuits
 * at the first differing character, so the time it takes leaks how long a common
 * prefix the attacker has found — which turns forging a 256-bit digest from
 * guessing it in one go into guessing 64 hex characters one at a time, and that
 * second problem is small enough to be worth attempting. `timingSafeEqual` reads
 * both buffers in full regardless.
 *
 * Both digests are decoded to bytes first rather than compared as ASCII, because
 * `timingSafeEqual` throws on a length mismatch and the decode is where a
 * malformed length is caught cheaply. The length comparison itself is not
 * constant-time and does not need to be: the expected length is a published
 * constant of the scheme and leaks nothing. Callers still reach here with a
 * `digest` that `parseSignatureHeader` has already pinned to 64 hex characters,
 * so the guard is defence against a future caller rather than the live path.
 */
export function digestsMatch(expected: string, presented: string): boolean {
  if (expected.length !== presented.length) return false;

  const expectedBytes = Buffer.from(expected, 'hex');
  const presentedBytes = Buffer.from(presented, 'hex');
  if (expectedBytes.length !== presentedBytes.length) return false;
  if (expectedBytes.length === 0) return false;

  return timingSafeEqual(expectedBytes, presentedBytes);
}
