import { randomUUID } from 'crypto';
import {
  canonicalRequest,
  computeDigest,
  formatSignatureHeader,
  WEBHOOK_SIGNATURE_HEADER,
  type ParsedWebhookSignature,
} from '@/webhooks/signature';
import type { WebhookSigningSecretRing } from '@/webhooks/signing-secrets';

/**
 * The sending side: turn a request this service is about to make into a signed
 * one.
 *
 * It exists in the same module as the verifier on purpose. A receiver is only as
 * good as somebody's ability to produce a valid request for it, and the usual
 * way a signing scheme turns out to be ambiguous is that the only implementation
 * of it lives in a test helper — which means the scheme was never actually
 * specified, only demonstrated. Here the delivery path and the test suites call
 * the same function the documentation points integrators at, and
 * `verify-signature.middleware.ts` rebuilds its input with the same
 * `canonicalRequest`.
 *
 * It returns headers rather than performing a request. What sends a webhook is a
 * matter for the delivery mechanism — the outbox relay, a queue worker, a bare
 * `fetch` — and every one of those already has opinions about timeouts, retries
 * and connection reuse that this function has no business holding. Signing is a
 * pure function of (secret, method, target, body, clock); keeping it one means it
 * can be unit-tested against a fixed clock and a fixed nonce, which is the only
 * way to assert a byte-exact header at all.
 */

export interface SignWebhookRequestOptions {
  /** The ring to sign under. Only `active()` is consulted. */
  readonly ring: WebhookSigningSecretRing;
  /** Defaults to `POST`, which is every delivery this repository sends. */
  readonly method?: string;
  /**
   * Where the request is going: an absolute URL, or an origin-form target
   * beginning with `/`.
   *
   * An absolute URL is reduced to path plus query, because that is what the
   * receiver rebuilds from `req.originalUrl` — the host is in the `Host` header
   * and is not part of the signed string. Signing the host would be strictly
   * better in theory and unusable in practice: the value a receiver sees behind a
   * load balancer, a service mesh or a tunnel is routinely not the one the sender
   * dialled.
   */
  readonly url: string;
  /** Signed as bytes. A string is encoded UTF-8, matching `JSON.stringify` output. */
  readonly body: Buffer | string;
  /** Injected for tests; unix *milliseconds*, floored to seconds in the header. */
  readonly now?: () => number;
  /** Injected for tests. Must satisfy the nonce rules in `signature.ts`. */
  readonly nonce?: () => string;
}

export interface SignedWebhookRequest {
  /** Merge into the outbound request. One entry: the signature header. */
  readonly headers: Readonly<Record<string, string>>;
  /** The parts that were signed, for logging and for assertions. */
  readonly signature: ParsedWebhookSignature;
  /** The exact string the HMAC was taken over. Invaluable in a failure report. */
  readonly canonical: string;
}

/**
 * 32 hex characters from `randomUUID()`.
 *
 * The hyphens come out because the nonce alphabet in `signature.ts` is the
 * header's parameter charset, and while `-` is in it, a value with internal
 * punctuation is one more thing for a third-party integrator's parser to get
 * wrong for no benefit. 122 bits of randomness is far past what uniqueness
 * across a five-minute window needs; the reason not to shorten it is that the
 * cost of a nonce is one cache entry either way.
 */
function defaultNonce(): string {
  return randomUUID().replace(/-/g, '');
}

/** Path plus query for an absolute URL, or the target unchanged if already one. */
function toTarget(url: string): string {
  if (url.startsWith('/')) return url;
  const parsed = new URL(url);
  return `${parsed.pathname}${parsed.search}`;
}

export function signWebhookRequest(options: SignWebhookRequestOptions): SignedWebhookRequest {
  const {
    ring,
    method = 'POST',
    url,
    body,
    now = Date.now,
    nonce = defaultNonce,
  } = options;

  const entry = ring.active();
  const bodyBytes = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
  const parts = {
    // Seconds, floored. The unit is part of the wire format, and a receiver that
    // read these as milliseconds would compute a skew of decades and refuse
    // everything — which is the good failure. The bad one is the reverse, so the
    // conversion happens here rather than being left to a caller holding a
    // `Date`.
    timestamp: Math.floor(now() / 1000),
    nonce: nonce(),
    method,
    target: toTarget(url),
    body: bodyBytes,
  };

  const canonical = canonicalRequest(parts);
  const signature: ParsedWebhookSignature = {
    timestamp: parts.timestamp,
    nonce: parts.nonce,
    keyId: entry.id,
    digest: computeDigest(entry.secret, canonical),
  };

  return {
    headers: Object.freeze({
      [WEBHOOK_SIGNATURE_HEADER]: formatSignatureHeader(signature),
    }),
    signature,
    canonical,
  };
}
