import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { AppError } from '@/lib/errors';
import {
  bodyDigest,
  canonicalRequest,
  computeDigest,
  digestsMatch,
  parseSignatureHeader,
  WEBHOOK_SIGNATURE_HEADER,
  type ParsedWebhookSignature,
} from '@/webhooks/signature';
import type { ReplayGuard } from '@/webhooks/replay-guard';
import type { WebhookSigningSecretRing } from '@/webhooks/signing-secrets';
import {
  WebhookBodyMalformedError,
  WebhookReplayCacheFullError,
  WebhookReplayedError,
  WebhookSignatureInvalidError,
  WebhookSignatureMalformedError,
  WebhookSignatureRequiredError,
  WebhookTimestampOutOfWindowError,
} from '@/webhooks/webhooks.errors';

/**
 * The receiving side: refuse anything not signed by a holder of a ring secret,
 * recently, once.
 *
 * ## The order of the checks is the design
 *
 * Cheap and public first, secret-dependent next, stateful last:
 *
 *   1. **presence and shape** of the header — no secret involved, so an
 *      unauthenticated caller gets no further than a regex;
 *   2. **the freshness window** — still no secret, and it is ahead of the digest
 *      because an expired delivery is refused whether or not its digest is
 *      right, so computing the HMAC first would be work done for nothing on
 *      exactly the traffic a flood consists of;
 *   3. **the digest**, in constant time, against the one ring entry the
 *      presented key id names;
 *   4. **the nonce**, recorded only now.
 *
 * Step 4 sitting after step 3 is the one with a real attacker behind it. A guard
 * consulted before the digest is checked lets anyone at all spend nonces: capture
 * one delivery, hold it, and the moment the legitimate copy arrives it is the
 * *second* presentation and gets refused. Recording only verified deliveries means
 * nothing enters the cache that the secret holder did not put there.
 *
 * Step 2 before step 3 is the same argument with cost rather than correctness
 * behind it, and the ordering is only safe because the timestamp is *inside* the
 * signed string: refusing on an unverified field would otherwise mean acting on
 * an attacker-chosen value. A forged timestamp buys nothing here — it changes the
 * canonical string, so the digest check fails — but it is worth being explicit
 * that this is why the timestamp is signed rather than merely sent.
 *
 * ## Verify, then parse
 *
 * The body arrives as a `Buffer` and stays one until the signature is
 * established. That is not incidental. A signature is over bytes, and any parse
 * before the check both (a) lets an unauthenticated caller reach the JSON parser
 * and (b) risks verifying a re-serialisation of the body rather than the body —
 * `JSON.parse` then `JSON.stringify` is not the identity function, and key order,
 * whitespace, duplicate keys and number formatting all move. Both classes of bug
 * are closed by the same rule: hold the bytes, verify the bytes, then parse.
 *
 * The raw body reaches here because `createApp` mounts `express.raw()` on the
 * webhook subtree ahead of `express.json()`. See `WEBHOOKS_RAW_BODY_PATH`.
 */

export interface VerifyWebhookSignatureOptions {
  /** Every held secret is a candidate; the presented key id picks one. */
  readonly ring: WebhookSigningSecretRing;
  /** Where spent nonces are recorded. */
  readonly guard: ReplayGuard;
  /**
   * How far the signed timestamp may sit from this receiver's clock, in seconds,
   * in either direction.
   *
   * Symmetric because clock skew is symmetric: a sender running two minutes fast
   * is exactly as common as one running two minutes slow, and a one-sided window
   * turns the first into an outage. The trade is the obvious one — this is the
   * length of the window in which a captured delivery is replayable, which is
   * what makes the nonce cache the other half of the feature rather than an
   * optional extra.
   */
  readonly toleranceSeconds: number;
  /**
   * Whether to replace `req.body` with the parsed JSON once verification passes.
   *
   * On by default, because a handler that wanted the bytes would not be behind
   * this middleware. Off for a receiver whose payloads are not JSON, which then
   * reads the `Buffer` itself.
   */
  readonly parseJsonBody?: boolean;
  /** Injected so the window is testable without waiting or mocking the clock globally. */
  readonly now?: () => number;
}

/**
 * A verified signature, published on the request for handlers and the access log.
 *
 * Present only on a request that got past this middleware, which is what makes it
 * meaningful: a handler reading `req.webhookSignature` is reading an assertion
 * that has been checked, not a header that was sent.
 */
export interface VerifiedWebhookSignature extends ParsedWebhookSignature {
  /** `sha256` of the raw body, hex — the same value that went into the signature. */
  readonly bodyDigest: string;
  /** The bytes the signature covers, kept for a handler that needs them post-parse. */
  readonly rawBody: Buffer;
}

function readSignatureHeader(req: Request): string {
  const raw = req.headers[WEBHOOK_SIGNATURE_HEADER];

  if (raw === undefined) {
    throw new WebhookSignatureRequiredError(WEBHOOK_SIGNATURE_HEADER);
  }
  if (Array.isArray(raw)) {
    // Node collapses most repeated headers into one comma-joined string, and the
    // signature format is itself comma-delimited — so a repeat that *was*
    // collapsed arrives as a duplicated field and `parseSignatureHeader` rejects
    // it there. This branch is the one Node keeps as an array. Either way the
    // answer is refusal rather than picking one: two signatures on one request
    // is a request whose meaning depends on which hop you ask.
    throw new WebhookSignatureMalformedError(
      `the ${WEBHOOK_SIGNATURE_HEADER} header appears more than once`,
    );
  }

  return raw;
}

function readRawBody(req: Request): Buffer {
  if (Buffer.isBuffer(req.body)) return req.body;

  // Not a client error, so not one of the `Webhook*` errors: the request is
  // fine and the *wiring* is wrong — this route is mounted somewhere the raw
  // parser does not cover, or behind a body parser that consumed the stream
  // first. Failing loudly beats the alternative, which is signing over
  // `Buffer.from(JSON.stringify(req.body))` and getting a scheme that verifies
  // a re-serialisation nobody sent.
  throw new AppError(
    500,
    'Webhook signature verification requires the raw request body; ' +
      `mount express.raw() on ${WEBHOOK_SIGNATURE_HEADER} routes ahead of any body parser`,
    'WEBHOOK_RAW_BODY_MISSING',
  );
}

export function verifyWebhookSignature(
  options: VerifyWebhookSignatureOptions,
): RequestHandler {
  const { ring, guard, toleranceSeconds, parseJsonBody = true, now = Date.now } = options;

  if (!Number.isFinite(toleranceSeconds) || toleranceSeconds <= 0) {
    throw new RangeError(
      `toleranceSeconds must be a positive number, got ${String(toleranceSeconds)}`,
    );
  }

  return async function verifyWebhookSignatureHandler(
    req: Request,
    _res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const presented = parseSignatureHeader(readSignatureHeader(req));
      const rawBody = readRawBody(req);

      const skewSeconds = Math.floor(now() / 1000) - presented.timestamp;
      if (Math.abs(skewSeconds) > toleranceSeconds) {
        throw new WebhookTimestampOutOfWindowError(skewSeconds, toleranceSeconds);
      }

      const entry = ring.find(presented.keyId);
      if (entry === undefined) {
        // Answered identically to a digest mismatch — see
        // `WebhookSignatureInvalidError` for why the two are one code — but
        // distinguished here, so this deployment's own logs can tell "a
        // counterparty is signing under a key we have not deployed yet" from
        // "somebody has the wrong secret". Those have different fixes.
        throw new WebhookSignatureInvalidError('unknown-key-id');
      }

      const canonical = canonicalRequest({
        timestamp: presented.timestamp,
        nonce: presented.nonce,
        method: req.method,
        // `originalUrl`, not `url`: Express strips the mount prefix off `url`
        // inside a router, so a signature covering `/v1/webhooks/inbound` would
        // be checked against `/inbound` and never match. `originalUrl` is also
        // what the sender's `toTarget` produces — path plus query, origin-form.
        target: req.originalUrl,
        body: rawBody,
      });

      if (!digestsMatch(computeDigest(entry.secret, canonical), presented.digest)) {
        throw new WebhookSignatureInvalidError('digest-mismatch');
      }

      // Scoped by key id as well as nonce. A nonce is chosen by whoever is
      // signing, so two counterparties sharing this receiver can pick the same
      // one by chance — and without the scope, the first to arrive would burn it
      // for the other. The pair is unique per sender, which is the guarantee the
      // nonce actually offers.
      const decision = await guard.remember(
        `${presented.keyId}:${presented.nonce}`,
        // The record is held until the *signed* timestamp leaves the window,
        // which is exactly as long as the check above would still admit it.
        (presented.timestamp + toleranceSeconds) * 1000,
      );
      if (decision === 'replayed') throw new WebhookReplayedError();
      if (decision === 'cache-full') throw new WebhookReplayCacheFullError(toleranceSeconds);

      const verified: VerifiedWebhookSignature = {
        ...presented,
        // A second pass over the body, which `canonicalRequest` has already
        // hashed once. Worth it: the digest is what a failure report quotes to
        // the sender to establish whether the two sides are looking at the same
        // bytes, and threading a precomputed hash through `canonicalRequest`
        // would put an optional, ignorable parameter on the one function both
        // sides of the scheme must agree on. The body is bounded by the raw
        // parser's limit, so the cost is bounded with it.
        bodyDigest: bodyDigest(rawBody),
        rawBody,
      };
      req.webhookSignature = verified;

      if (parseJsonBody) {
        try {
          // `rawBody` is retained on `req.webhookSignature`, so replacing
          // `req.body` costs a handler nothing it cannot get back.
          req.body = JSON.parse(rawBody.toString('utf8'));
        } catch (error) {
          throw new WebhookBodyMalformedError(
            error instanceof Error ? error.message : 'could not be parsed',
          );
        }
      }

      next();
    } catch (error) {
      // Every refusal above is a throw, and they all arrive here to be handed to
      // `errorMiddleware`. Express 5 does forward a rejected promise from a
      // handler, so this is belt and braces — but it is the belt that does not
      // depend on which framework version a deployment is on, and a signature
      // check that fails open because of a version difference is the one failure
      // this file cannot have.
      next(error);
    }
  };
}
